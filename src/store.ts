import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AppError, isNotFound } from "./errors.js";
import { GitHubClient } from "./github.js";
import type { GitHubAsset, GitHubRelease, LinkManifest, ObjectManifest, ObjectSummary, ShortLink, ShortLinkEntry } from "./types.js";

const OBJECT_TAG_PREFIX = "depository-object-";
const LINK_TAG_PREFIX = "depository-link-";
const OBJECT_ASSET_PREFIX = "depository-object-";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function objectTag(key: string): string {
  return `${OBJECT_TAG_PREFIX}${sha256(key)}`;
}

function linkTag(code: string): string {
  return `${LINK_TAG_PREFIX}${sha256(code)}`;
}

function parseObjectManifest(release: GitHubRelease): ObjectManifest {
  try {
    const value = JSON.parse(release.body ?? "") as Partial<ObjectManifest>;
    if (
      value.schema !== 1 || value.kind !== "object" || typeof value.key !== "string" ||
      typeof value.assetName !== "string" || typeof value.contentType !== "string" ||
      typeof value.size !== "number" || typeof value.sha256 !== "string" ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" ||
      typeof value.metadata !== "object" || value.metadata === null || Array.isArray(value.metadata)
    ) {
      throw new Error("Invalid object manifest");
    }
    if (value.shortLinks !== undefined) {
      if (!Array.isArray(value.shortLinks)) throw new Error("Invalid shortLinks");
      const seen = new Set<string>();
      for (const entry of value.shortLinks) {
        if (!entry || typeof entry !== "object" ||
          typeof entry.code !== "string" || !/^[A-Za-z0-9_-]{3,64}$/.test(entry.code) ||
          typeof entry.createdAt !== "string" || seen.has(entry.code)) {
          throw new Error("Invalid short link entry");
        }
        seen.add(entry.code);
      }
    }
    return value as ObjectManifest;
  } catch {
    throw new AppError("The GitHub release contains an invalid depository object manifest", 502, "corrupt_manifest");
  }
}

function parseLinkManifest(release: GitHubRelease): LinkManifest {
  try {
    const value = JSON.parse(release.body ?? "") as Partial<LinkManifest>;
    if (
      value.schema !== 1 || value.kind !== "link" || typeof value.code !== "string" ||
      typeof value.objectKey !== "string" || typeof value.createdAt !== "string"
    ) {
      throw new Error("Invalid link manifest");
    }
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(value.code)) throw new Error("Invalid short code");
    return value as LinkManifest;
  } catch {
    throw new AppError("The GitHub release contains an invalid depository link manifest", 502, "corrupt_manifest");
  }
}

function validateKey(key: string, maxBytes: number): void {
  if (!key || key.trim() === "" || key.startsWith("/")) {
    throw new AppError("Object key must be a non-empty relative path", 400, "invalid_key");
  }
  if (Buffer.byteLength(key, "utf8") > maxBytes) {
    throw new AppError(`Object key exceeds ${maxBytes} bytes`, 400, "invalid_key");
  }
  if (key.includes("\0") || key.split("/").some((part) => part === ".." || part === ".")) {
    throw new AppError("Object key cannot contain NUL, '.' or '..' path segments", 400, "invalid_key");
  }
}

function safeHeaderValue(value: string, headerName: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new AppError(`${headerName} contains invalid characters`, 400, "invalid_header");
  }
  return value;
}

function assetName(): string {
  return `${OBJECT_ASSET_PREFIX}${randomUUID()}.bin`;
}

function publicObject(manifest: ObjectManifest): ObjectSummary {
  return {
    key: manifest.key,
    size: manifest.size,
    contentType: manifest.contentType,
    etag: `"${manifest.sha256}"`,
    lastModified: manifest.updatedAt,
    metadata: manifest.metadata,
  };
}

interface Cursor {
  page: number;
  index: number;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(value?: string): Cursor {
  if (!value) return { page: 1, index: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      !Number.isSafeInteger(parsed.page) || (parsed.page ?? 0) < 1 ||
      !Number.isSafeInteger(parsed.index) || (parsed.index ?? -1) < 0 || (parsed.index ?? 0) >= 100
    ) {
      throw new Error("Invalid cursor");
    }
    return { page: parsed.page as number, index: parsed.index as number };
  } catch {
    throw new AppError("Invalid pagination cursor", 400, "invalid_cursor");
  }
}

class KeyedMutex {
  private readonly locks = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

export class DepositoryStore {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly github: GitHubClient, private readonly maxKeyBytes: number) {}

  async putObject(
    key: string,
    content: Buffer,
    options: { contentType: string; cacheControl?: string; metadata: Record<string, string> },
  ): Promise<ObjectSummary> {
    validateKey(key, this.maxKeyBytes);
    if (content.byteLength === 0) {
      // Empty objects are valid; this branch is intentionally not an error.
    }

    const contentType = safeHeaderValue(options.contentType || "application/octet-stream", "Content-Type");
    const cacheControl = options.cacheControl === undefined
      ? undefined
      : safeHeaderValue(options.cacheControl, "Cache-Control");
    const digest = sha256(content);
    const tag = objectTag(key);

    return this.mutex.run(tag, async () => {
      let previous: GitHubRelease | undefined;
      try {
        previous = await this.github.getReleaseByTag(tag);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }

      const previousManifest = previous ? parseObjectManifest(previous) : undefined;
      const now = new Date().toISOString();
      const nextAssetName = assetName();
      const manifest: ObjectManifest = {
        schema: 1,
        kind: "object",
        key,
        assetName: nextAssetName,
        contentType,
        ...(cacheControl === undefined ? {} : { cacheControl }),
        size: content.byteLength,
        sha256: digest,
        createdAt: previousManifest?.createdAt ?? now,
        updatedAt: now,
        metadata: options.metadata,
        ...(previousManifest?.shortLinks?.length ? { shortLinks: previousManifest.shortLinks } : {}),
      };

      let release = previous;
      let createdHere = false;
      if (!release) {
        release = await this.github.createRelease({
          tag_name: tag,
          name: `depository object ${digest.slice(0, 12)}`,
          body: JSON.stringify(manifest),
          draft: true,
          prerelease: true,
        });
        createdHere = true;
      }

      let uploaded: GitHubAsset | undefined;
      try {
        uploaded = await this.github.uploadAsset(release, nextAssetName, content, contentType);
        await this.github.updateRelease(release.id, {
          body: JSON.stringify(manifest),
          draft: false,
        });
      } catch (error) {
        if (uploaded) {
          await this.github.deleteAsset(uploaded.id).catch(() => undefined);
        } else if (!createdHere) {
          // A 502 during upload can leave a GitHub asset in the "starter" state.
          const afterFailure = await this.github.getReleaseByTag(tag).catch(() => undefined);
          const partial = afterFailure?.assets.find((asset) => asset.name === nextAssetName);
          if (partial) await this.github.deleteAsset(partial.id).catch(() => undefined);
        }
        if (createdHere) {
          await this.github.deleteRelease(release.id).catch(() => undefined);
          await this.github.deleteTag(tag).catch(() => undefined);
        }
        throw error;
      }

      if (previous) {
        const oldAsset = previous.assets.find((asset) => asset.name === previousManifest?.assetName);
        if (oldAsset) await this.github.deleteAsset(oldAsset.id).catch(() => undefined);
      }

      return publicObject(manifest);
    });
  }

  async getObject(key: string): Promise<{ manifest: ObjectManifest; asset: GitHubAsset }> {
    validateKey(key, this.maxKeyBytes);
    const release = await this.getObjectRelease(key);
    const manifest = parseObjectManifest(release);
    if (manifest.key !== key) throw new AppError("Object manifest key does not match its release tag", 502, "corrupt_manifest");
    const asset = release.assets.find((candidate) => candidate.name === manifest.assetName);
    if (!asset) throw new AppError("Object asset is missing from its GitHub release", 502, "missing_asset");
    return { manifest, asset };
  }

  async headObject(key: string): Promise<ObjectSummary> {
    const { manifest } = await this.getObject(key);
    return publicObject(manifest);
  }

  async deleteObject(key: string): Promise<void> {
    validateKey(key, this.maxKeyBytes);
    const tag = objectTag(key);
    await this.mutex.run(tag, async () => {
      const release = await this.github.getReleaseByTag(tag);
      const manifest = parseObjectManifest(release);
      if (manifest.key !== key) throw new AppError("Object manifest key does not match its release tag", 502, "corrupt_manifest");
      await this.github.deleteRelease(release.id);
      await this.github.deleteTag(tag).catch(() => undefined);
    });
  }

  async listObjects(prefix: string, limit: number, cursorValue?: string): Promise<{ objects: ObjectSummary[]; nextCursor?: string }> {
    const cursor = decodeCursor(cursorValue);
    const objects: ObjectSummary[] = [];
    let page = cursor.page;
    let index = cursor.index;

    while (objects.length < limit) {
      const releases = await this.github.listReleases(page);
      if (releases.length === 0) break;

      for (let i = index; i < releases.length; i += 1) {
        const release = releases[i];
        if (!release || !release.tag_name.startsWith(OBJECT_TAG_PREFIX)) continue;
        try {
          const manifest = parseObjectManifest(release);
          if (manifest.key.startsWith(prefix)) objects.push(publicObject(manifest));
        } catch (error) {
          // Corrupt depository-tagged releases are ignored in listings, but direct reads surface the error.
          if (!(error instanceof AppError)) throw error;
        }

        if (objects.length >= limit) {
          const next = i + 1 < releases.length
            ? encodeCursor({ page, index: i + 1 })
            : releases.length === 100
              ? encodeCursor({ page: page + 1, index: 0 })
              : undefined;
          return { objects, ...(next ? { nextCursor: next } : {}) };
        }
      }

      if (releases.length < 100) break;
      page += 1;
      index = 0;
    }

    return { objects };
  }

  async createLink(input: { objectKey: string; code?: string }): Promise<ShortLink> {
    validateKey(input.objectKey, this.maxKeyBytes);
    const requestedCode = input.code;
    if (requestedCode !== undefined && !/^[A-Za-z0-9_-]{3,64}$/.test(requestedCode)) {
      throw new AppError("Short code must be 3-64 characters: letters, numbers, '_' or '-'", 400, "invalid_code");
    }

    const attempts = requestedCode ? 1 : 5;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const code = requestedCode ?? randomBytes(6).toString("base64url");
      try {
        return await this.mutex.run(`short-link:${code}`, async () => this.mutex.run(objectTag(input.objectKey), async () => {
          const release = await this.getObjectRelease(input.objectKey);
          const manifest = parseObjectManifest(release);
          if (manifest.key !== input.objectKey) {
            throw new AppError("Object manifest key does not match its release tag", 502, "corrupt_manifest");
          }
          if (!release.assets.some((asset) => asset.name === manifest.assetName)) {
            throw new AppError("Object asset is missing from its GitHub release", 502, "missing_asset");
          }

          const existing = await this.findShortLink(code);
          if (existing || await this.getLegacyLink(code)) {
            throw new AppError("That short code is already in use", 409, "code_conflict");
          }

          const entry: ShortLinkEntry = { code, createdAt: new Date().toISOString() };
          const nextManifest: ObjectManifest = {
            ...manifest,
            shortLinks: [...(manifest.shortLinks ?? []), entry],
          };
          await this.github.updateRelease(release.id, { body: JSON.stringify(nextManifest) });
          return { code, objectKey: input.objectKey, createdAt: entry.createdAt };
        }));
      } catch (error) {
        if (error instanceof AppError && error.code === "code_conflict") {
          if (requestedCode) throw error;
          continue;
        }
        throw error;
      }
    }

    throw new AppError("Could not allocate a unique short code", 503, "code_allocation_failed");
  }

  async getLink(code: string): Promise<ShortLink> {
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(code)) {
      throw new AppError("Invalid short code", 404, "not_found");
    }
    const match = await this.findShortLink(code);
    if (match) {
      return {
        code,
        objectKey: match.manifest.key,
        createdAt: match.entry.createdAt,
      };
    }
    const legacy = await this.getLegacyLink(code);
    if (!legacy) throw new AppError("Short link does not exist", 404, "not_found");
    return { code, objectKey: legacy.objectKey, createdAt: legacy.createdAt };
  }

  async getLinkedObject(code: string): Promise<{ manifest: ObjectManifest; asset: GitHubAsset }> {
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(code)) {
      throw new AppError("Invalid short code", 404, "not_found");
    }
    const match = await this.findShortLink(code);
    if (match) {
      const asset = match.release.assets.find((candidate) => candidate.name === match.manifest.assetName);
      if (!asset) throw new AppError("Object asset is missing from its GitHub release", 502, "missing_asset");
      return { manifest: match.manifest, asset };
    }

    // Continue serving links created by older versions, which used a dedicated release per link.
    const legacy = await this.getLegacyLink(code);
    if (!legacy) throw new AppError("Short link does not exist", 404, "not_found");
    return this.getObject(legacy.objectKey);
  }

  async deleteLink(code: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(code)) {
      throw new AppError("Invalid short code", 400, "invalid_code");
    }

    const match = await this.findShortLink(code);
    if (match) {
      await this.mutex.run(`short-link:${code}`, async () => this.mutex.run(objectTag(match.manifest.key), async () => {
        const release = await this.getObjectRelease(match.manifest.key);
        const manifest = parseObjectManifest(release);
        if (manifest.key !== match.manifest.key) {
          throw new AppError("Object manifest key does not match its release tag", 502, "corrupt_manifest");
        }
        const nextLinks = (manifest.shortLinks ?? []).filter((entry) => entry.code !== code);
        if (nextLinks.length === (manifest.shortLinks ?? []).length) {
          throw new AppError("Short link does not exist", 404, "not_found");
        }
        const nextManifest: ObjectManifest = { ...manifest, shortLinks: nextLinks };
        await this.github.updateRelease(release.id, { body: JSON.stringify(nextManifest) });
      }));
      return;
    }

    // Remove a legacy dedicated-link release when an old short code is deleted.
    const legacyRelease = await this.getLegacyLinkRelease(code);
    if (!legacyRelease) throw new AppError("Short link does not exist", 404, "not_found");
    await this.github.deleteRelease(legacyRelease.id);
    await this.github.deleteTag(linkTag(code)).catch(() => undefined);
  }

  private async findShortLink(code: string): Promise<{
    release: GitHubRelease;
    manifest: ObjectManifest;
    entry: ShortLinkEntry;
  } | undefined> {
    for (let page = 1; ; page += 1) {
      const releases = await this.github.listReleases(page);
      for (const release of releases) {
        if (!release.tag_name.startsWith(OBJECT_TAG_PREFIX)) continue;
        try {
          const manifest = parseObjectManifest(release);
          if (manifest.key !== undefined && objectTag(manifest.key) === release.tag_name) {
            const entry = manifest.shortLinks?.find((candidate) => candidate.code === code);
            if (entry) return { release, manifest, entry };
          }
        } catch (error) {
          // Ignore unrelated or corrupt object releases while scanning for an alias.
          if (!(error instanceof AppError)) throw error;
        }
      }
      if (releases.length < 100) return undefined;
    }
  }

  private async getLegacyLink(code: string): Promise<LinkManifest | undefined> {
    const release = await this.getLegacyLinkRelease(code);
    if (!release) return undefined;
    const manifest = parseLinkManifest(release);
    if (manifest.code !== code) {
      throw new AppError("Short-link manifest code does not match its release tag", 502, "corrupt_manifest");
    }
    return manifest;
  }

  private async getLegacyLinkRelease(code: string): Promise<GitHubRelease | undefined> {
    try {
      return await this.github.getReleaseByTag(linkTag(code));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private async getObjectRelease(key: string): Promise<GitHubRelease> {
    return this.github.getReleaseByTag(objectTag(key));
  }
}

export function collectObjectMetadata(headers: Record<string, unknown>): Record<string, string> {
  const metadata: Record<string, string> = {};
  let totalBytes = 0;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!name.startsWith("x-depository-meta-")) continue;
    if (typeof rawValue !== "string") {
      throw new AppError(`Metadata header ${rawName} must have a single value`, 400, "invalid_metadata");
    }
    const key = name.slice("x-depository-meta-".length);
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(key)) {
      throw new AppError(`Invalid metadata key in header ${rawName}`, 400, "invalid_metadata");
    }
    safeHeaderValue(rawValue, rawName);
    totalBytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(rawValue, "utf8");
    metadata[key] = rawValue;
  }
  if (Object.keys(metadata).length > 32 || totalBytes > 2_048) {
    throw new AppError("Object metadata is limited to 32 entries and 2 KiB total", 400, "metadata_too_large");
  }
  return metadata;
}
