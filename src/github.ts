import { GitHubApiError } from "./errors.js";
import type { GitHubAsset, GitHubRelease } from "./types.js";

interface GitHubClientOptions {
  apiUrl: string;
  owner: string;
  repo: string;
  token: string;
}

export class GitHubClient {
  private readonly basePath: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly options: GitHubClientOptions) {
    this.basePath = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
    this.headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "depository/0.1.0",
    };
  }

  private url(path: string): string {
    return `${this.options.apiUrl}${path}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(this.url(path), {
      ...init,
      headers: {
        ...this.headers,
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new GitHubApiError(
        `GitHub API request failed (${response.status})`,
        response.status,
        responseBody.slice(0, 2_000),
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async getReleaseByTag(tag: string): Promise<GitHubRelease> {
    return this.request<GitHubRelease>(`${this.basePath}/releases/tags/${encodeURIComponent(tag)}`);
  }

  async createRelease(input: {
    tag_name: string;
    name: string;
    body: string;
    draft: boolean;
    prerelease: boolean;
  }): Promise<GitHubRelease> {
    return this.request<GitHubRelease>(`${this.basePath}/releases`, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
    });
  }

  async updateRelease(id: number, input: { body: string; draft?: boolean }): Promise<GitHubRelease> {
    return this.request<GitHubRelease>(`${this.basePath}/releases/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
    });
  }

  async deleteRelease(id: number): Promise<void> {
    await this.request<void>(`${this.basePath}/releases/${id}`, { method: "DELETE" });
  }

  async deleteTag(tag: string): Promise<void> {
    await this.request<void>(`${this.basePath}/git/refs/tags/${encodeURIComponent(tag)}`, { method: "DELETE" });
  }

  async uploadAsset(release: GitHubRelease, name: string, content: Buffer, contentType: string): Promise<GitHubAsset> {
    const uploadUrl = release.upload_url.replace(/\{\?.*\}$/, "");
    const url = new URL(uploadUrl);
    url.searchParams.set("name", name);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...this.headers,
        Accept: "application/vnd.github+json",
        "Content-Type": contentType,
      },
      body: new Uint8Array(content),
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new GitHubApiError(
        `GitHub release asset upload failed (${response.status})`,
        response.status,
        responseBody.slice(0, 2_000),
      );
    }

    return (await response.json()) as GitHubAsset;
  }

  async deleteAsset(assetId: number): Promise<void> {
    await this.request<void>(`${this.basePath}/releases/assets/${assetId}`, { method: "DELETE" });
  }

  async downloadAsset(asset: GitHubAsset): Promise<Response> {
    const response = await fetch(asset.url, {
      headers: {
        ...this.headers,
        Accept: "application/octet-stream",
      },
      redirect: "follow",
    });
    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new GitHubApiError(
        `GitHub release asset download failed (${response.status})`,
        response.status,
        responseBody.slice(0, 2_000),
      );
    }
    if (!response.body) {
      throw new GitHubApiError("GitHub returned an empty asset response", 502, "");
    }
    return response;
  }

  async listReleases(page: number): Promise<GitHubRelease[]> {
    return this.request<GitHubRelease[]>(`${this.basePath}/releases?per_page=100&page=${page}`);
  }
}
