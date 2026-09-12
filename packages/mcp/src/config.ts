/**
 * Environment-based configuration for the AMS MCP server.
 *
 * Configuration is resolved lazily at call time so the server can start even
 * when one upstream is temporarily unavailable. `AMS_API_URL` has no default
 * because the Write API address is deployment-specific; `AMS_QMD_URL` defaults
 * to the local QMD daemon.
 */

/** Environment variable names consumed by this package. */
export const API_URL_ENV = "AMS_API_URL";
export const QMD_URL_ENV = "AMS_QMD_URL";

/** Default QMD daemon address. */
export const DEFAULT_QMD_URL = "http://localhost:8181";

/** Resolved MCP server configuration. */
export interface McpConfig {
  /** Base URL of the Write API, without trailing slash. */
  apiUrl: string;
  /** Base URL of the QMD daemon, without trailing slash. */
  qmdUrl: string;
}

/** Removes a trailing slash so callers can append paths safely. */
function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Reads configuration from the environment map.
 *
 * Accepts an explicit env map so tests can inject values without mutating
 * global `process.env`.
 */
export function getConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const apiUrl = env[API_URL_ENV]?.trim();
  const qmdUrl = env[QMD_URL_ENV]?.trim();

  return {
    apiUrl: apiUrl ? normalizeUrl(apiUrl) : "",
    qmdUrl: qmdUrl ? normalizeUrl(qmdUrl) : DEFAULT_QMD_URL,
  };
}
