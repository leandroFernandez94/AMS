/**
 * Indexing scheduler (Spec 5).
 *
 * Bridges writes (Spec 3) and retrieval (Spec 4): a cron-driven scheduler
 * drains the dirty-flag store and reindexes the QMD collection asynchronously,
 * with a manual `POST /admin/reindex` escape hatch. Everything is injectable
 * so the full suite runs without a daemon, models, or the `qmd` CLI.
 */

export {
  CliReindexer,
  type CliReindexerOptions,
  type CommandResult,
  type CommandRunner,
  createExecRunner,
} from "./cli-reindexer.js";
export {
  DEFAULT_INDEX_CRON,
  INDEX_CRON_ENV,
  INDEX_ENABLED_ENV,
  type IndexConfig,
  IndexConfigError,
  loadIndexConfig,
  QMD_BIN_ENV,
  QMD_COLLECTION_ENV,
} from "./config.js";
export type { Reindexer, ReindexResult } from "./reindexer.js";
export {
  IndexScheduler,
  type IndexSchedulerOptions,
  type SchedulerDeps,
  type TickResult,
} from "./scheduler.js";
