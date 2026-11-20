import Fastify, { type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { Config } from "./config.js";
import { AppError, GitHubApiError, isNotFound } from "./errors.js";
import { GitHubClient } from "./github.js";
import { collectObjectMetadata, DepositoryStore } from "./store.js";

function parseJsonBody<T>(body: unknown): T {
  if (!Buffer.isBuffer(body)) throw new AppError("Expected a JSON request body", 400, "invalid_body");
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    throw new AppError("Malformed JSON request body", 400, "invalid_json");
  }
}

function isAuthorized(request: FastifyRequest, expected: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expectedBuffer = Buffer.from(expected);
  return supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
}

function getObjectKey(request: FastifyRequest): string {
  const wildcard = (request.params as { "*"?: string })["*"];
  if (!wildcard) throw new AppError("Object key is required", 400, "invalid_key");
  return wildcard;
}

function safeContentType(value: string | undefined): string {
  const contentType = value?.trim() || "application/octet-stream";
  if (/[\r\n\0]/.test(contentType)) throw new AppError("Invalid Content-Type header", 400, "invalid_header");
  return contentType;
}

function safeCacheControl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/[\r\n\0]/.test(value)) throw new AppError("Invalid Cache-Control header", 400, "invalid_header");
  return value;
}

export function buildServer(config: Config) {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.maxUploadBytes,
    exposeHeadRoutes: false,
    trustProxy: false,
  });

  // Store all bodies as Buffers. JSON endpoints explicitly decode their payloads.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  const github = new GitHubClient(config.github);
  const store = new DepositoryStore(github, config.maxKeyBytes);

  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    const isPublic = path === "/healthz" || path.startsWith("/s/");
    if (isPublic) return;
    if (!isAuthorized(request, config.apiToken)) {
      return reply.code(401).send({ error: "unauthorized", message: "A valid Bearer token is required" });
    }
  });

  app.get("/healthz", async () => ({ status: "ok", service: "depository" }));

  app.get<{ Querystring: { prefix?: string; limit?: string; cursor?: string } }>("/objects", async (request) => {
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AppError("limit must be an integer between 1 and 100", 400, "invalid_limit");
    }
    return store.listObjects(request.query.prefix ?? "", limit, request.query.cursor);
  });

  app.put("/objects/*", async (request, reply) => {
    const key = getObjectKey(request);
    if (!request.headers["content-type"]) {
      throw new AppError("Content-Type is required for object uploads", 415, "missing_content_type");
    }
    const content = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const cacheControl = safeCacheControl(request.headers["cache-control"]);
    const summary = await store.putObject(key, content, {
      contentType: safeContentType(request.headers["content-type"]),
      ...(cacheControl === undefined ? {} : { cacheControl }),
      metadata: collectObjectMetadata(request.headers as Record<string, unknown>),
    });
    return reply.header("ETag", summary.etag).code(200).send(summary);
  });

  app.head("/objects/*", async (request, reply) => {
    const { manifest } = await store.getObject(getObjectKey(request));
    reply
      .header("Content-Type", manifest.contentType)
      .header("Content-Length", String(manifest.size))
      .header("ETag", `"${manifest.sha256}"`)
      .header("Last-Modified", new Date(manifest.updatedAt).toUTCString());
    if (manifest.cacheControl) reply.header("Cache-Control", manifest.cacheControl);
    for (const [key, value] of Object.entries(manifest.metadata)) reply.header(`x-depository-meta-${key}`, value);
    return reply.code(200).send();
  });

  app.get("/objects/*", async (request, reply) => {
    const { manifest, asset } = await store.getObject(getObjectKey(request));
    const upstream = await github.downloadAsset(asset);
    reply
      .header("Content-Type", manifest.contentType)
      .header("Content-Length", String(manifest.size))
      .header("ETag", `"${manifest.sha256}"`)
      .header("Last-Modified", new Date(manifest.updatedAt).toUTCString());
    if (manifest.cacheControl) reply.header("Cache-Control", manifest.cacheControl);
    for (const [key, value] of Object.entries(manifest.metadata)) reply.header(`x-depository-meta-${key}`, value);
    return reply.send(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream));
  });

  app.delete("/objects/*", async (request, reply) => {
    await store.deleteObject(getObjectKey(request));
    return reply.code(204).send();
  });

  app.post("/links", async (request, reply) => {
    const body = parseJsonBody<{ targetUrl?: unknown; code?: unknown }>(request.body);
    if (typeof body.targetUrl !== "string") throw new AppError("targetUrl is required", 400, "invalid_body");
    if (body.code !== undefined && typeof body.code !== "string") throw new AppError("code must be a string", 400, "invalid_body");
    const link = await store.createLink({ targetUrl: body.targetUrl, ...(typeof body.code === "string" ? { code: body.code } : {}) });
    const shortUrl = `${config.publicBaseUrl}/s/${link.code}`;
    return reply.code(201).send({ ...link, shortUrl });
  });

  app.get<{ Params: { code: string } }>("/s/:code", async (request, reply) => {
    const link = await store.getLink(request.params.code);
    return reply.redirect(link.targetUrl, 302);
  });

  app.delete<{ Params: { code: string } }>("/links/:code", async (request, reply) => {
    await store.deleteLink(request.params.code);
    return reply.code(204).send();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (isNotFound(error)) {
      return reply.code(404).send({ error: "not_found", message: "The requested resource does not exist" });
    }
    if (error instanceof GitHubApiError) {
      const statusCode = error.status === 403 || error.status === 429 ? 503 : 502;
      app.log.error({ status: error.status, response: error.responseBody }, "GitHub API request failed");
      return reply.code(statusCode).send({ error: "storage_backend_error", message: "GitHub storage backend request failed" });
    }
    if ((error as { statusCode?: number }).statusCode === 413) {
      return reply.code(413).send({ error: "upload_too_large", message: `Request body exceeds ${config.maxUploadBytes} bytes` });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "internal_error", message: "An unexpected error occurred" });
  });

  return app;
}
