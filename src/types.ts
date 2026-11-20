export interface GitHubAsset {
  id: number;
  name: string;
  size: number;
  content_type: string;
  state: string;
  url: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  upload_url: string;
  assets: GitHubAsset[];
}

export interface ObjectManifest {
  schema: 1;
  kind: "object";
  key: string;
  assetName: string;
  contentType: string;
  cacheControl?: string;
  size: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, string>;
  /** Short aliases are stored alongside the object, not in separate releases. */
  shortLinks?: ShortLinkEntry[];
}

export interface ShortLinkEntry {
  code: string;
  createdAt: string;
}

export interface ShortLink {
  code: string;
  objectKey: string;
  createdAt: string;
}

/** Legacy manifest type retained to read and delete links created by older versions. */
export interface LinkManifest {
  schema: 1;
  kind: "link";
  code: string;
  objectKey: string;
  createdAt: string;
}

export interface ObjectSummary {
  key: string;
  size: number;
  contentType: string;
  etag: string;
  lastModified: string;
  metadata: Record<string, string>;
}
