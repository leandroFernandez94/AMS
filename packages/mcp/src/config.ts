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
 * HTTP-mode variables (`AMS_MCP_PORT`, `AMS_MCP_HOST`, `AMS_MCP_TOKEN`, the
 * optional OAuth triple, `AMS_MCP_RATE_LIMIT`) are read by the same resolver
 * because the config is shared with the stdio binary; only the HTTP
 * entrypoint enforces them.
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

/** Environment variable name for the OAuth authorization-server issuer URL. */
export const MCP_OAUTH_ISSUER_ENV = "AMS_MCP_OAUTH_ISSUER";

/** Environment variable name for the OAuth audience (Auth0 API identifier). */
export const MCP_OAUTH_AUDIENCE_ENV = "AMS_MCP_OAUTH_AUDIENCE";

/** Environment variable name for the public HTTPS base URL of this service. */
export const MCP_PUBLIC_URL_ENV = "AMS_MCP_PUBLIC_URL";

/** Environment variable name for the per-client rate limit on the MCP route. */
export const MCP_RATE_LIMIT_ENV = "AMS_MCP_RATE_LIMIT";

/** Default TCP port for the optional Streamable HTTP transport. */
export const DEFAULT_MCP_PORT = 3111;

/** Default bind address: loopback only; broader exposure is a deployment concern. */
export const DEFAULT_MCP_HOST = "127.0.0.1";

/** Default in-app rate limit on the MCP route: requests/minute per client key. */
export const DEFAULT_MCP_RATE_LIMIT = 120;

/** Thrown when an environment variable is malformed. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Raw OAuth environment values as read (trimmed); the empty string means
 * "unset". Kept unvalidated on the shared config so the stdio binary never
 * breaks on HTTP-only variables — `resolveOAuthConfig` enforces the contract.
 */
export interface McpOAuthEnv {
  issuer: string;
  audience: string;
  publicUrl: string;
}

/** Validated OAuth resource-server configuration (all three values present). */
export interface McpOAuthConfig {
  /**
   * Auth0 issuer URL exactly as tokens will carry it in `iss` (jose compares
   * the claim literally, so no normalization is applied). Trailing slash
   * allowed — Auth0 issuers conventionally have one.
   */
  issuer: string;
  /** Auth0 API identifier matched against the `aud` claim; not a URL. */
  audience: string;
  /** Public HTTPS base URL of this service, no trailing slash. */
  publicUrl: string;
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
  /** Raw OAuth env values, empty string = unset. Validated for HTTP only. */
  oauth: McpOAuthEnv;
  /**
   * Max requests per minute per client key on the MCP route. `0` disables
   * the in-app limiter entirely.
   */
  rateLimitPerMinute: number;
}

/** Removes a trailing slash so callers can append paths safely. */
function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Parses `raw` as an HTTPS URL without query or fragment.
 *
 * `raw` (not the parsed pathname) drives the trailing-slash check: `new URL`
 * normalizes "https://host" to pathname "/", so only the raw string can
 * distinguish an explicit trailing slash.
 */
function requireHttpsUrl(
  raw: string,
  envName: string,
  options: { rejectTrailingSlash: boolean },
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${envName} must be a valid https URL, got: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new ConfigError(`${envName} must use https, got: ${raw}`);
  }
  if (url.search || url.hash) {
    throw new ConfigError(`${envName} must not include a query or fragment, got: ${raw}`);
  }
  if (options.rejectTrailingSlash && raw.endsWith("/")) {
    throw new ConfigError(`${envName} must not have a trailing slash, got: ${raw}`);
  }
  return url;
}

/**
 * Validates the all-or-nothing OAuth triple.
 *
 * Returns `null` when nothing is set (phase 1: static-token-only auth).
 * Throws `ConfigError` when only some of the three variables are set — a
 * half-configured resource server would silently reject every JWT.
 */
export function resolveOAuthConfig(raw: McpOAuthEnv): McpOAuthConfig | null {
  const setCount = [raw.issuer, raw.audience, raw.publicUrl].filter((value) => value !== "").length;
  if (setCount === 0) return null;
  if (setCount < 3) {
    throw new ConfigError(
      `${MCP_OAUTH_ISSUER_ENV}, ${MCP_OAUTH_AUDIENCE_ENV} and ${MCP_PUBLIC_URL_ENV} ` +
        `must be set together (found ${setCount} of 3)`,
    );
  }
  requireHttpsUrl(raw.issuer, MCP_OAUTH_ISSUER_ENV, { rejectTrailingSlash: false });
  if (!raw.audience) {
    throw new ConfigError(`${MCP_OAUTH_AUDIENCE_ENV} must not be empty`);
  }
  requireHttpsUrl(raw.publicUrl, MCP_PUBLIC_URL_ENV, { rejectTrailingSlash: true });
  return { issuer: raw.issuer, audience: raw.audience, publicUrl: raw.publicUrl };
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
 * Validates the rate limit. Unlike the port, a fractional request count is
 * meaningless, so non-integers are rejected next to negatives.
 */
function resolveRateLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_MCP_RATE_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigError(`${MCP_RATE_LIMIT_ENV} must be a non-negative integer, got: ${raw}`);
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
    oauth: {
      issuer: env[MCP_OAUTH_ISSUER_ENV]?.trim() ?? "",
      audience: env[MCP_OAUTH_AUDIENCE_ENV]?.trim() ?? "",
      publicUrl: env[MCP_PUBLIC_URL_ENV]?.trim() ?? "",
    },
    rateLimitPerMinute: resolveRateLimit(env[MCP_RATE_LIMIT_ENV]?.trim()),
  };
}
