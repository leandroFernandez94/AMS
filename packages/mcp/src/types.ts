import type { Logger, QmdClient } from "@ams/api";
import type { WriteApiClient } from "@ams/shared";

/** Injectable collaborators for `createServer`. All optional — production resolves from env. */
export interface ServerDeps {
  /** Write API base URL. Defaults to env `AMS_API_URL`. Required for write-side tools. */
  apiUrl?: string;
  /** QMD client. When omitted, built lazily from `AMS_QMD_URL` on first read. */
  qmdClient?: QmdClient;
  /**
   * Write API client for the write-side tools. When omitted, each write tool
   * builds one lazily per invocation from `apiUrl`; the client itself guards
   * the empty-URL case.
   */
  writeApiClient?: WriteApiClient;
  /**
   * Structured logger for tool invocation lines. Defaults to JSON lines on
   * STDERR inside `createServer` — stdout is reserved for JSON-RPC frames.
   */
  logger?: Logger;
}
