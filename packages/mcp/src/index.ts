/**
 * AMS MCP server package — domain tools exposed to agents.
 *
 * Exports the transport-agnostic server factory so callers can wire stdio in
 * production (`bin.ts`) or `InMemoryTransport` in tests.
 */
export { createServer } from "./server.js";
export type { ServerDeps } from "./types.js";
