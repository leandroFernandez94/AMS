/**
 * Runtime configuration for the Write API.
 *
 * Everything is driven by environment variables so the service never
 * hard-codes host-specific paths. This keeps the same artifact portable
 * across machines and CI, and matches the Spec 3 contract.
 *
 * Variables:
 *  - AMS_VAULT_PATH   (required) absolute or relative path to the vault root.
 *  - AMS_API_PORT     (optional, default 3000) TCP port the HTTP server binds.
 *  - AMS_LOCK_TTL_MS  (optional, default 5000) write-lock timeout in millis.
 */

/** Resolved, validated configuration consumed by the rest of the package. */
export interface ApiConfig {
  /** Absolute path to the vault root directory. */
  vaultPath: string;
  /** TCP port the HTTP server listens on. */
  port: number;
  /** Write-lock time-to-live in milliseconds. */
  lockTtlMs: number;
}

export const DEFAULT_PORT = 3000;
export const DEFAULT_LOCK_TTL_MS = 5000;

/** Thrown when a required environment variable is missing or malformed. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function resolveNumber(raw: string | undefined, field: string, defaultValue: number): number {
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ConfigError(`${field} must be a non-negative number, got: ${raw}`);
  }
  return parsed;
}

/**
 * Loads and validates configuration from an environment map.
 *
 * Defaults to `process.env` but accepts an explicit map so tests can supply
 * deterministic values without mutating global state.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const vaultPath = env.AMS_VAULT_PATH?.trim();
  if (!vaultPath) {
    throw new ConfigError("AMS_VAULT_PATH is required (path to the vault root)");
  }
  return {
    vaultPath,
    port: resolveNumber(env.AMS_API_PORT, "AMS_API_PORT", DEFAULT_PORT),
    lockTtlMs: resolveNumber(env.AMS_LOCK_TTL_MS, "AMS_LOCK_TTL_MS", DEFAULT_LOCK_TTL_MS),
  };
}
