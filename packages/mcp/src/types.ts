import type { QmdClient } from "@ams/api";

/** Injectable collaborators for `createServer`. All optional — production resolves from env. */
export interface ServerDeps {
  /** Write API base URL. Defaults to env `AMS_API_URL`. Required for `record_note`. */
  apiUrl?: string;
  /** QMD client. When omitted, built lazily from `AMS_QMD_URL` on first read. */
  qmdClient?: QmdClient;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}
