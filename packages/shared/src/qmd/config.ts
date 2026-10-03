/**
 * Configuration for the QMD retrieval adapter.
 *
 * QMD is an independent HTTP daemon (`qmd mcp --http`), so the only piece of
 * configuration the adapter needs is the daemon base URL. It is kept separate
 * from the Write API config (`config.ts`) on purpose: a read-only consumer
 * (e.g. the MCP layer reading memory) should not be forced to provide the
 * Write API's required `AMS_VAULT_PATH`.
 */

/** Default daemon address. Matches `qmd mcp --http`'s `localhost:8181`. */
export const DEFAULT_QMD_URL = "http://localhost:8181";

/** Environment variable name overriding the daemon URL. */
export const QMD_URL_ENV = "AMS_QMD_URL";

/** Resolved QMD adapter configuration. */
export interface QmdConfig {
  /** Base URL of the QMD daemon, with no trailing slash. */
  url: string;
}

/** Trims a trailing slash so callers can concatenate `/mcp` safely. */
function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Loads QMD configuration from an environment map.
 *
 * Defaults to `process.env` but accepts an explicit map so tests can supply
 * deterministic values without mutating global state.
 */
export function loadQmdConfig(env: Record<string, string | undefined> = process.env): QmdConfig {
  const raw = env[QMD_URL_ENV];
  const url = normalizeUrl(raw?.trim() ? raw : DEFAULT_QMD_URL);
  return { url };
}
