import test from "node:test";
import assert from "node:assert/strict";
import { decodeCursor, encodeCursor, collectObjectMetadata } from "../src/store.js";
import { parseRepositoryUrl } from "../src/config.js";
import { AppError } from "../src/errors.js";

test("repository URL parser accepts .git suffix and strips it", () => {
  assert.deepEqual(parseRepositoryUrl("https://github.com/example/data.git"), {
    owner: "example",
    repo: "data",
  });
});

test("repository URL parser rejects non-HTTPS URLs", () => {
  assert.throws(() => parseRepositoryUrl("http://github.com/example/data"), AppError);
});

test("pagination cursor round-trips", () => {
  const cursor = { page: 7, index: 32 };
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
});

test("pagination cursor rejects malformed values", () => {
  assert.throws(() => decodeCursor("not-a-cursor"), AppError);
});

test("metadata headers are normalized and bounded", () => {
  assert.deepEqual(collectObjectMetadata({ "x-depository-meta-color": "blue" }), { color: "blue" });
  assert.throws(() => collectObjectMetadata({ "x-depository-meta-Color": "blue\r\nX-Evil: yes" }), AppError);
});

import { DepositoryStore } from "../src/store.js";
import { GitHubApiError } from "../src/errors.js";
import type { GitHubAsset, GitHubRelease } from "../src/types.js";

class FakeGitHub {
  private nextId = 1;
  private readonly releases = new Map<string, GitHubRelease>();

  async getReleaseByTag(tag: string): Promise<GitHubRelease> {
    const release = this.releases.get(tag);
    if (!release) throw new GitHubApiError("not found", 404, "");
    return structuredClone(release);
  }

  async createRelease(input: {
    tag_name: string;
    name: string;
    body: string;
    draft: boolean;
    prerelease: boolean;
  }): Promise<GitHubRelease> {
    if (this.releases.has(input.tag_name)) throw new GitHubApiError("already exists", 422, "");
    const release: GitHubRelease = {
      id: this.nextId++,
      tag_name: input.tag_name,
      name: input.name,
      body: input.body,
      draft: input.draft,
      prerelease: input.prerelease,
      upload_url: "https://uploads.github.com/fake/assets{?name,label}",
      assets: [],
    };
    this.releases.set(input.tag_name, release);
    return structuredClone(release);
  }

  async updateRelease(id: number, input: { body: string; draft?: boolean }): Promise<GitHubRelease> {
    const release = [...this.releases.values()].find((candidate) => candidate.id === id);
    if (!release) throw new GitHubApiError("not found", 404, "");
    release.body = input.body;
    if (input.draft !== undefined) release.draft = input.draft;
    return structuredClone(release);
  }

  async uploadAsset(release: GitHubRelease, name: string, content: Buffer, contentType: string): Promise<GitHubAsset> {
    const stored = [...this.releases.values()].find((candidate) => candidate.id === release.id);
    if (!stored) throw new GitHubApiError("not found", 404, "");
    const asset: GitHubAsset = {
      id: this.nextId++,
      name,
      size: content.byteLength,
      content_type: contentType,
      state: "uploaded",
      url: `https://api.github.com/fake/assets/${this.nextId}`,
      browser_download_url: `https://github.com/fake/${name}`,
    };
    stored.assets.push(asset);
    return structuredClone(asset);
  }

  async deleteAsset(assetId: number): Promise<void> {
    for (const release of this.releases.values()) {
      release.assets = release.assets.filter((asset) => asset.id !== assetId);
    }
  }

  async deleteRelease(id: number): Promise<void> {
    for (const [tag, release] of this.releases.entries()) {
      if (release.id === id) this.releases.delete(tag);
    }
  }

  async deleteTag(_tag: string): Promise<void> {}

  async listReleases(page: number): Promise<GitHubRelease[]> {
    const sorted = [...this.releases.values()].reverse();
    return structuredClone(sorted.slice((page - 1) * 100, page * 100));
  }
}

test("objects are created, replaced, listed and deleted through release records", async () => {
  const fake = new FakeGitHub();
  const store = new DepositoryStore(fake as unknown as import("../src/github.js").GitHubClient, 1024);
  const options = { contentType: "text/plain", metadata: { source: "test" } };

  await store.putObject("docs/hello.txt", Buffer.from("first"), options);
  const first = await store.getObject("docs/hello.txt");
  assert.equal(first.manifest.contentType, "text/plain");
  assert.equal(first.asset.size, 5);

  await store.putObject("docs/hello.txt", Buffer.from("updated"), options);
  const second = await store.getObject("docs/hello.txt");
  assert.equal(second.asset.size, 7);
  assert.equal(second.manifest.createdAt, first.manifest.createdAt);
  assert.notEqual(second.manifest.assetName, first.manifest.assetName);

  const listed = await store.listObjects("docs/", 10);
  assert.equal(listed.objects.length, 1);
  assert.equal(listed.objects[0]?.key, "docs/hello.txt");

  await store.deleteObject("docs/hello.txt");
  await assert.rejects(() => store.getObject("docs/hello.txt"), (error: unknown) =>
    error instanceof GitHubApiError && error.status === 404,
  );
});

test("short links are stored in their object release and survive object replacement", async () => {
  const fake = new FakeGitHub();
  const store = new DepositoryStore(fake as unknown as import("../src/github.js").GitHubClient, 1024);
  await assert.rejects(() => store.createLink({ code: "docs", objectKey: "docs/missing.txt" }));
  await store.putObject("docs/readme.txt", Buffer.from("hello"), { contentType: "text/plain", metadata: {} });
  const created = await store.createLink({ code: "docs", objectKey: "docs/readme.txt" });
  assert.equal(created.code, "docs");
  assert.equal((await store.getLink("docs")).objectKey, "docs/readme.txt");
  assert.equal((await fake.listReleases(1)).length, 1, "creating a link must not create another release");
  const storedManifest = JSON.parse((await fake.listReleases(1))[0]!.body!) as { shortLinks: { code: string }[] };
  assert.deepEqual(storedManifest.shortLinks.map((entry) => entry.code), ["docs"]);

  await assert.rejects(
    () => store.createLink({ code: "docs", objectKey: "docs/readme.txt" }),
    (error: unknown) => error instanceof AppError && error.statusCode === 409,
  );

  await store.putObject("docs/readme.txt", Buffer.from("replaced"), { contentType: "text/plain", metadata: {} });
  const linked = await store.getLinkedObject("docs");
  assert.equal(linked.asset.size, 8);

  await store.deleteLink("docs");
  await assert.rejects(() => store.getLinkedObject("docs"), AppError);
  assert.equal((await fake.listReleases(1)).length, 1, "deleting a link must not delete the object release");
});
