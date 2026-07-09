/**
 * Configuration for the indexing scheduler (Spec 5).
 *
 * Kept separate from the Write API config (`config.ts`) and the QMD read
 * adapter config (`qmd/config.ts`) on the same principle: a consumer that
 * does not schedule reindexes should not be forced to provide the Write API's
 * required `AMS_VAULT_PATH`. The scheduler is the only thing that reads this.
 *
 * Variables:
 *  - AMS_INDEX_CRON      (optional, default every 2 minutes) node-cron expression.
 *  - AMS_INDEX_ENABLED   (optional, default true) master kill-switch; when
 *                         false the scheduler starts but never schedules a
 *                         task (handy for tests / read-only replicas).
 *  - AMS_QMD_COLLECTION  (optional) scope `qmd update`/`qmd embed` to a single
 *                         registered collection name. Omit to reindex every
 *                         registered collection (QMD's default).
 *  - AMS_QMD_BIN         (optional, default "qmd") path to the QMD CLI binary.
 */
import cron from "node-cron";

/** Default schedule: one tick every two minutes. */
export const DEFAULT_INDEX_CRON = "*/2 * * * *";

export const INDEX_CRON_ENV = "AMS_INDEX_CRON";
export const INDEX_ENABLED_ENV = "AMS_INDEX_ENABLED";
export const QMD_COLLECTION_ENV = "AMS_QMD_COLLECTION";
export const QMD_BIN_ENV = "AMS_QMD_BIN";

/** Resolved scheduler configuration. */
export interface IndexConfig {
  /** Validated node-cron expression. */
  cron: string;
  /** Whether the scheduler should register the periodic task. */
  enabled: boolean;
  /** Collection name forwarded to `qmd update -c` / `qmd embed -c`, or undefined. */
  collection?: string;
  /** QMD CLI binary invoked by the reindexer. */
  qmdBin: string;
}

/** Thrown when `AMS_INDEX_CRON` is present but not a valid cron expression. */
export class IndexConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexConfigError";
  }
}

function resolveFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Loads scheduler configuration from an environment map.
 *
 * Defaults to `process.env` but accepts an explicit map so tests can supply
 * deterministic values without mutating global state.
 */
export function loadIndexConfig(
  env: Record<string, string | undefined> = process.env,
): IndexConfig {
  const cronExpr = env[INDEX_CRON_ENV]?.trim() || DEFAULT_INDEX_CRON;
  // node-cron's parser rejects 6-field seconds expressions that look fine at a
  // glance; validate early so a typo fails fast at boot instead of silently
  // never firing.
  if (!cron.validate(cronExpr)) {
    throw new IndexConfigError(`${INDEX_CRON_ENV} is not a valid cron expression: "${cronExpr}"`);
  }

  const collection = env[QMD_COLLECTION_ENV]?.trim() || undefined;

  return {
    cron: cronExpr,
    enabled: resolveFlag(env[INDEX_ENABLED_ENV], true),
    collection,
    qmdBin: env[QMD_BIN_ENV]?.trim() || "qmd",
  };
}
