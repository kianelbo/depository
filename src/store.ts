import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AppError, GitHubApiError, isNotFound } from "./errors.js";
import { GitHubClient } from "./github.js";
import type { GitHubAsset, GitHubRelease, LinkManifest, ObjectManifest, ObjectSummary } from "./types.js";

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
      typeof value.targetUrl !== "string" || typeof value.createdAt !== "string"
    ) {
      throw new Error("Invalid link manifest");
    }
    const parsedUrl = new URL(value.targetUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("Invalid link protocol");
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
        createdAt: previous ? parseObjectManifest(previous).createdAt : now,
        updatedAt: now,
        metadata: options.metadata,
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
        const oldAsset = previous.assets.find((asset) => asset.name === parseObjectManifest(previous).assetName);
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

  async createLink(input: { targetUrl: string; code?: string }): Promise<LinkManifest> {
    const target = validateTargetUrl(input.targetUrl);
    const requestedCode = input.code;
    if (requestedCode !== undefined && !/^[A-Za-z0-9_-]{3,64}$/.test(requestedCode)) {
      throw new AppError("Short code must be 3-64 characters: letters, numbers, '_' or '-'", 400, "invalid_code");
    }

    const attempts = requestedCode ? 1 : 5;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const code = requestedCode ?? randomBytes(6).toString("base64url");
      const tag = linkTag(code);
      const now = new Date().toISOString();
      const manifest: LinkManifest = { schema: 1, kind: "link", code, targetUrl: target, createdAt: now };

      try {
        await this.github.createRelease({
          tag_name: tag,
          name: `depository link ${code}`,
          body: JSON.stringify(manifest),
          draft: false,
          prerelease: true,
        });
        return manifest;
      } catch (error) {
        // 422 means the deterministic tag already exists (or another validation failed).
        if (error instanceof GitHubApiError && error.status === 422) {
          if (requestedCode) throw new AppError("That short code is already in use", 409, "code_conflict");
          continue;
        }
        throw error;
      }
    }

    throw new AppError("Could not allocate a unique short code", 503, "code_allocation_failed");
  }

  async getLink(code: string): Promise<LinkManifest> {
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(code)) {
      throw new AppError("Invalid short code", 404, "not_found");
    }
    const release = await this.github.getReleaseByTag(linkTag(code));
    const manifest = parseLinkManifest(release);
    if (manifest.code !== code) throw new AppError("Short-link manifest code does not match its release tag", 502, "corrupt_manifest");
    return manifest;
  }

  async deleteLink(code: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(code)) {
      throw new AppError("Invalid short code", 400, "invalid_code");
    }
    const tag = linkTag(code);
    const release = await this.github.getReleaseByTag(tag);
    const manifest = parseLinkManifest(release);
    if (manifest.code !== code) throw new AppError("Short-link manifest code does not match its release tag", 502, "corrupt_manifest");
    await this.github.deleteRelease(release.id);
    await this.github.deleteTag(tag).catch(() => undefined);
  }

  private async getObjectRelease(key: string): Promise<GitHubRelease> {
    return this.github.getReleaseByTag(objectTag(key));
  }
}

function validateTargetUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("targetUrl must be a valid absolute URL", 400, "invalid_target_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("Only http and https short-link targets are allowed", 400, "invalid_target_url");
  }
  if (url.username || url.password || Buffer.byteLength(value, "utf8") > 8_192) {
    throw new AppError("Short-link targets cannot contain credentials and must be at most 8 KiB", 400, "invalid_target_url");
  }
  return url.toString();
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
