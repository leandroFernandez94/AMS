/**
 * AMS Write API package — controlled persistence service.
 *
 * Exposes the testable surface (app factory, collaborators and types) so the
 * MCP layer and integration tests can compose them without starting a real
 * HTTP server. The runnable entry lives in `./server.ts`.
 */
export { type AppDeps, createApp, type NoteInput } from "./app.js";
export {
  type ApiConfig,
  ConfigError,
  DEFAULT_LOCK_TTL_MS,
  DEFAULT_PORT,
  loadConfig,
} from "./config.js";
export { type DirtyEntry, type DirtyMap, DirtyStore } from "./dirty.js";
export {
  CliReindexer,
  type CliReindexerOptions,
  type CommandResult,
  type CommandRunner,
  createExecRunner,
  DEFAULT_INDEX_CRON,
  INDEX_CRON_ENV,
  INDEX_ENABLED_ENV,
  type IndexConfig,
  IndexConfigError,
  IndexScheduler,
  type IndexSchedulerOptions,
  loadIndexConfig,
  QMD_BIN_ENV,
  QMD_COLLECTION_ENV,
  type Reindexer,
  type ReindexResult,
  type SchedulerDeps,
  type TickResult,
} from "./indexing/index.js";
export { type ReleaseFunction, WriteLock } from "./lock.js";
export { createLogger, type LogEntry, type Logger, type LogLevel } from "./logger.js";
export {
  type GetMemoryInput,
  loadQmdConfig,
  type MemoryDoc,
  type MemoryHit,
  QmdClient,
  type QmdClientOptions,
  type QmdConfig,
  QmdError,
  QmdProtocolError,
  QmdToolError,
  QmdUnavailableError,
  type SearchMemoryInput,
} from "./qmd/index.js";
export { type TopicKeyMatch, type UpsertResult, Vault } from "./vault.js";
