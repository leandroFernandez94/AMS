/**
 * Environment-based configuration for the AMS MCP server.
 *
 * Configuration is resolved lazily at call time so the server can start even
 * when one upstream is temporarily unavailable. `AMS_API_URL` has no default
 * because the Write API address is deployment-specific; `AMS_QMD_URL` defaults
 * to the local QMD daemon. The QMD default/env handling is delegated to the
 * shared adapter config so the retrieval client and this server can never
 * drift apart.
 *
 * HTTP-mode variables (`AMS_MCP_PORT`, `AMS_MCP_HOST`, `AMS_MCP_TOKEN`) are
 * read by the same resolver because the config is shared with the stdio
 * binary; only the HTTP entrypoint enforces the token.
 */
import { DEFAULT_QMD_URL, loadQmdConfig, QMD_URL_ENV } from "@ams/shared";

/** Environment variable name for the Write API URL. */
export const API_URL_ENV = "AMS_API_URL";

// Canonical QMD constants live in @ams/shared; re-exported here so existing
// imports of this module keep resolving.
export { DEFAULT_QMD_URL, QMD_URL_ENV };

/** Environment variable name for the HTTP listener port. */
export const MCP_PORT_ENV = "AMS_MCP_PORT";

/** Environment variable name for the HTTP listener bind address. */
export const MCP_HOST_ENV = "AMS_MCP_HOST";

/** Environment variable name for the HTTP bearer token. */
export const MCP_TOKEN_ENV = "AMS_MCP_TOKEN";

/** Default TCP port for the optional Streamable HTTP transport. */
export const DEFAULT_MCP_PORT = 3111;

/** Default bind address: loopback only; broader exposure is a deployment concern. */
export const DEFAULT_MCP_HOST = "127.0.0.1";

/** Thrown when an environment variable is malformed. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Resolved MCP server configuration. */
export interface McpConfig {
  /** Base URL of the Write API, without trailing slash. Empty when unconfigured. */
  apiUrl: string;
  /** Base URL of the QMD daemon, without trailing slash. */
  qmdUrl: string;
  /** TCP port the Streamable HTTP entrypoint binds. */
  port: number;
  /** Bind address the Streamable HTTP entrypoint listens on. */
  host: string;
  /**
   * Bearer token for the HTTP transport, trimmed. Empty when unset — allowed
   * for stdio (config is shared); the HTTP entrypoint fails fast instead.
   */
  token: string;
}

/** Removes a trailing slash so callers can append paths safely. */
function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** Validates a numeric env override, falling back to a default (api/config style). */
function resolveNumber(raw: string | undefined, field: string, defaultValue: number): number {
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ConfigError(`${field} must be a non-negative number, got: ${raw}`);
  }
  return parsed;
}

/**
 * Reads configuration from the environment map.
 *
 * Accepts an explicit env map so tests can inject values without mutating
 * global `process.env`.
 */
export function getConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const apiUrl = env[API_URL_ENV]?.trim();
  const host = env[MCP_HOST_ENV]?.trim();
  const token = env[MCP_TOKEN_ENV]?.trim();

  return {
    apiUrl: apiUrl ? normalizeUrl(apiUrl) : "",
    qmdUrl: loadQmdConfig(env).url,
    port: resolveNumber(env[MCP_PORT_ENV], MCP_PORT_ENV, DEFAULT_MCP_PORT),
    host: host || DEFAULT_MCP_HOST,
    token: token ?? "",
  };
}
