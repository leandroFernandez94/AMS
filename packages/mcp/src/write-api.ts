/**
 * Default Write API client resolution for the write tools.
 *
 * Mirrors the read tools' `resolveQmdClient` laziness: a client is built per
 * invocation only when none was injected, so a misconfigured URL never
 * breaks server startup. The empty-URL guard itself lives inside
 * `WriteApiClient` — the single choke point issue #40 asked for.
 */
import { type Logger, WriteApiClient } from "@ams/shared";

/** Collaborators a write tool needs to reach the Write API. */
export interface WriteApiDeps {
  /** Pre-built client. When omitted, one is built from `apiUrl` per invocation. */
  writeApiClient?: WriteApiClient;
  /** Write API base URL; the empty value fails fast inside the client. */
  apiUrl: string;
  /** Structured logger forwarded to the default client. `list_tags` omits it. */
  logger?: Logger;
}

/** Returns the injected client or constructs one from the configured API URL. */
export function resolveWriteApiClient(deps: WriteApiDeps): WriteApiClient {
  return deps.writeApiClient ?? new WriteApiClient({ url: deps.apiUrl, logger: deps.logger });
}
