import { AppError } from "./errors.js";

export interface Config {
  github: {
    owner: string;
    repo: string;
    token: string;
    apiUrl: string;
  };
  apiToken: string;
  host: string;
  port: number;
  maxUploadBytes: number;
  maxKeyBytes: number;
  publicBaseUrl: string;
  logLevel: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new AppError(`Missing required environment variable: ${key}`, 500, "configuration_error");
  }
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, key: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError(`${key} must be a positive integer`, 500, "configuration_error");
  }
  return parsed;
}

export function parseRepositoryUrl(value: string): { owner: string; repo: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("GITHUB_REPOSITORY_URL must be a valid HTTPS GitHub repository URL", 500, "configuration_error");
  }

  if (url.protocol !== "https:") {
    throw new AppError("GITHUB_REPOSITORY_URL must use HTTPS", 500, "configuration_error");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new AppError("GITHUB_REPOSITORY_URL must look like https://github.com/owner/repository", 500, "configuration_error");
  }

  const owner = parts[0];
  let repo = parts[1];
  if (!owner || !repo) {
    throw new AppError("GITHUB_REPOSITORY_URL must include an owner and repository", 500, "configuration_error");
  }
  repo = repo.replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new AppError("Repository owner/name contains unsupported characters", 500, "configuration_error");
  }

  return { owner, repo };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const repository = parseRepositoryUrl(required(env, "GITHUB_REPOSITORY_URL"));
  const apiUrl = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT ?? "3000"}`).replace(/\/+$/, "");

  let base: URL;
  try {
    base = new URL(apiUrl);
  } catch {
    throw new AppError("GITHUB_API_URL must be a valid URL", 500, "configuration_error");
  }
  if (base.protocol !== "https:") {
    throw new AppError("GITHUB_API_URL must use HTTPS", 500, "configuration_error");
  }

  let publicUrl: URL;
  try {
    publicUrl = new URL(publicBaseUrl);
  } catch {
    throw new AppError("PUBLIC_BASE_URL must be a valid URL", 500, "configuration_error");
  }
  if (publicUrl.protocol !== "https:" && publicUrl.hostname !== "localhost") {
    throw new AppError("PUBLIC_BASE_URL must use HTTPS outside localhost", 500, "configuration_error");
  }

  const apiToken = required(env, "DEPOSITORY_API_TOKEN");
  if (apiToken.length < 32) {
    throw new AppError("DEPOSITORY_API_TOKEN must be at least 32 characters", 500, "configuration_error");
  }
  const maxUploadBytes = positiveInteger(env.MAX_UPLOAD_BYTES, 100 * 1024 * 1024, "MAX_UPLOAD_BYTES");
  if (maxUploadBytes >= 2 * 1024 * 1024 * 1024) {
    throw new AppError("MAX_UPLOAD_BYTES must be smaller than GitHub's 2 GiB per-asset limit", 500, "configuration_error");
  }

  return {
    github: {
      ...repository,
      token: required(env, "GITHUB_TOKEN"),
      apiUrl,
    },
    apiToken,
    host: env.HOST ?? "0.0.0.0",
    port: positiveInteger(env.PORT, 3000, "PORT"),
    maxUploadBytes,
    maxKeyBytes: positiveInteger(env.MAX_KEY_BYTES, 1024, "MAX_KEY_BYTES"),
    publicBaseUrl,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
