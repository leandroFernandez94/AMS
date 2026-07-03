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
export { type ReleaseFunction, WriteLock } from "./lock.js";
export { createLogger, type LogEntry, type Logger, type LogLevel } from "./logger.js";
export { type UpsertResult, Vault } from "./vault.js";
