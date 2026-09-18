import type { Logger, QmdClient } from "@ams/api";

/** Injectable collaborators for `createServer`. All optional — production resolves from env. */
export interface ServerDeps {
  /** Write API base URL. Defaults to env `AMS_API_URL`. Required for write-side tools. */
  apiUrl?: string;
  /** QMD client. When omitted, built lazily from `AMS_QMD_URL` on first read. */
  qmdClient?: QmdClient;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /**
   * Structured logger for tool invocation lines. Defaults to JSON lines on
   * STDERR inside `createServer` — stdout is reserved for JSON-RPC frames.
   */
  logger?: Logger;
}
