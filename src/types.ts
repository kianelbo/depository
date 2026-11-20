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
}

export interface LinkManifest {
  schema: 1;
  kind: "link";
  code: string;
  targetUrl: string;
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
