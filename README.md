# depository

A mini HTTP object store backed by **GitHub Releases**.

Depository does not keep an application database. Each object is represented by a GitHub Release whose tag is a deterministic SHA-256 hash of the object key. The release body contains the object's metadata and any short-link codes assigned to it; the release has one binary asset. Short links are therefore part of the object manifest, not separate releases. GitHub is the source of truth.

> This is an S3-like REST interface, not an implementation of the AWS S3 protocol. It does not implement AWS Signature V4, buckets, multipart uploads, range requests, versioning, or S3 ACLs yet.

## How it works

- `PUT /objects/:key` creates or replaces an object.
- `GET` and `HEAD /objects/:key` read object data and metadata.
- `DELETE /objects/:key` removes the object.
- `GET /objects?prefix=...&limit=...&cursor=...` enumerates objects by scanning paginated GitHub releases. Results are in GitHub release order; lexicographic S3 ordering is not guaranteed.
- `POST /links` creates a short link for an existing object.
- `GET /s/:code` serves that object directly.
- `DELETE /links/:code` removes a short link.

Object and link-management endpoints require the configured API bearer token. Short-link redirects and `/healthz` are public. The GitHub token is only used by Depository and is never returned to clients.

### Why one release per object?

GitHub allows at most 1,000 assets per release. One release per object avoids that per-release ceiling and gives direct object lookup by deterministic tag. A short link is stored in that object's release manifest, so creating or deleting an alias does not create or delete a release. The trade-off is that resolving a short code must scan paginated object releases because there is no reverse index or database; alias lookup therefore becomes slower as the repository grows. Listing objects has the same scanning cost. This is currently suitable only for a personal or low-volume store, not a high-QPS, high-cardinality production object-storage service.

## How to run

```bash
docker pull ghcr.io/kianelbo/depository:latest
docker run -d --name depository --env-file .env -p 3000:3000 ghcr.io/kianelbo/depository:latest
```

## Run locally

### Requirements

- Node.js 20.11 or newer
- A dedicated GitHub repository used for Depository data (note that the repository must contain at least one file to enable releases)
- A GitHub fine-grained personal access token with **Contents: read and write** on that repository

Creating a release requires Contents write; listing releases and reading assets require Contents read. See [GitHub's release API](https://docs.github.com/en/rest/releases/releases) and [release asset API](https://docs.github.com/en/rest/releases/assets).

```bash
cp .env.example .env
# Edit .env and provide the repository URL and GitHub token.
npm install
npm run dev
```

The service listens on `http://localhost:3000` by default. Set `PUBLIC_BASE_URL` to the externally reachable origin when generating short URLs behind a reverse proxy.

### Configuration

| Variable | Required | Default | Description |
|----------|---------:|---------|-------------|
| `GITHUB_REPOSITORY_URL` | yes | — | Repository URL, e.g. `https://github.com/acme/depository-data` |
| `GITHUB_TOKEN` | yes | — | GitHub fine-grained PAT with Contents read/write |
| `DEPOSITORY_API_TOKEN` | yes | — | Shared bearer token used by callers of the API |
| `GITHUB_API_URL` | no | `https://api.github.com` | GitHub REST API base; for GHES, use its `/api/v3` endpoint |
| `HOST` | no | `0.0.0.0` | Bind address |
| `PORT` | no | `3000` | Listen port |
| `MAX_UPLOAD_BYTES` | no | `104857600` | Maximum request body size (100 MiB by default) |
| `MAX_KEY_BYTES` | no | `1024` | Maximum UTF-8 object-key length |
| `PUBLIC_BASE_URL` | no | `http://localhost:3000` | Base URL returned for short links |
| `LOG_LEVEL` | no | `info` | Fastify log level |

Keep the backing repository private when storing private data. The service proxies downloads through the GitHub API instead of exposing `browser_download_url`, so the repository's GitHub token is not leaked. Deploy behind HTTPS and do not expose the management API without authentication.

## API

All examples use:

```bash
export DEPOSITORY_URL=http://localhost:3000
export DEPOSITORY_TOKEN='replace-with-a-long-random-secret'
```

### Upload an object

```bash
curl -X PUT "$DEPOSITORY_URL/objects/images/cover.png" \
  -H "Authorization: Bearer $DEPOSITORY_TOKEN" \
  -H 'Content-Type: image/png' \
  -H 'Cache-Control: public, max-age=3600' \
  --data-binary @cover.png
```

The response includes the object key, byte size, content type, SHA-256 ETag, last-modified timestamp, and custom metadata. Object uploads must include a `Content-Type` header. Object keys may contain nested `/` paths. `.` and `..` path segments are rejected.

### Download / inspect / delete

```bash
curl "$DEPOSITORY_URL/objects/images/cover.png" \
  -H "Authorization: Bearer $DEPOSITORY_TOKEN" \
  -o downloaded-cover.png

curl -I "$DEPOSITORY_URL/objects/images/cover.png" \
  -H "Authorization: Bearer $DEPOSITORY_TOKEN"

curl -X DELETE "$DEPOSITORY_URL/objects/images/cover.png" \
  -H "Authorization: Bearer $DEPOSITORY_TOKEN"
```

`GET` streams the asset from GitHub through Depository. `HEAD` returns the stored metadata without downloading the file.

### List objects

```bash
curl "$DEPOSITORY_URL/objects?prefix=images/&limit=50" \
  -H "Authorization: Bearer $DEPOSITORY_TOKEN"
```

The response has an `objects` array and, when more results exist, a `nextCursor`. Pass that value back as `cursor` to continue. `limit` is from 1 to 100. Listing uses GitHub's releases pagination and may take multiple GitHub API calls.

### Create a short link to an uploaded object

```bash
curl -X POST "$DEPOSITORY_URL/links" \
  -H "Authorization: Bearer $DEPOSITORY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"objectKey":"images/cover.png","code":"jolly"}'
```

`objectKey` must identify an object that has already been uploaded. Depository rejects links to missing objects. The code is added to that object's release manifest; no additional release is created. Omit `code` to generate a random one. Custom codes must be 3–64 characters containing letters, numbers, `_` or `-`.

The response includes a `shortUrl`, for example `http://localhost:3000/s/jolly`. Visiting it serves the referenced file directly, including its content type and cache metadata. Short links cannot point to arbitrary external URLs. Because no separate lookup index is stored, resolving a code scans paginated releases until it finds the object manifest containing that code.

### Delete a short link

```bash
curl -X DELETE "$DEPOSITORY_URL/links/docs" \
  -H "Authorization: Bearer $DEPOSITORY_TOKEN"
```

## Operational notes and limitations

- **No database, no local persistence.** The service can be restarted without losing its index; release metadata is fetched from GitHub.
- **GitHub API limits apply.** Direct object reads require a release lookup; listing and short-link resolution scan paginated releases. Avoid using this as a high-QPS object store.
- **One GitHub release per object.** Large numbers of objects create a large release list and many Git tags. Release creation can also trigger repository notifications and secondary rate limits.
- **Asset size.** GitHub documents a per-release-asset limit below 2 GiB. Depository defaults to 100 MiB per upload and buffers uploads in memory; tune this conservatively.
- **Updates are not fully transactional.** Depository uploads the replacement asset, updates the release manifest, then removes the old asset. A failed cleanup may leave an orphaned asset, but the manifest continues to point at the active one.
- **Single instance recommended.** A per-key in-memory mutex prevents concurrent writes within one process. It is not a distributed lock; run one instance unless you add external coordination. The backing repository must allow release updates/deletions; immutable releases are not supported for object replacement.
- **Private repository recommended for private objects.** Keep the GitHub token scoped to the single backing repository. The static Depository API token is a shared secret, not per-user authentication or an authorization system.
- **GitHub Releases are not a general-purpose object-storage service.** Check GitHub's current terms, limits, and acceptable-use rules before relying on this for important data.
