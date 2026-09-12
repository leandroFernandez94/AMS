import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "./config.js";
import { registerGetMemory } from "./tools/get-memory.js";
import { registerRecordNote } from "./tools/record-note.js";
import { registerSearchMemory } from "./tools/search-memory.js";
import type { ServerDeps } from "./types.js";

/** Implementation metadata advertised to MCP clients. */
const SERVER_INFO = {
  name: "ams-mcp",
  version: "0.0.0",
};

/**
 * Builds a configured `McpServer` with the three AMS domain tools registered.
 *
 * Does NOT connect a transport — callers own transport wiring (stdio in
 * production, `InMemoryTransport` in tests).
 */
export function createServer(deps?: ServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  const config = getConfig();

  registerRecordNote(server, {
    apiUrl: deps?.apiUrl ?? config.apiUrl,
    fetch: deps?.fetch ?? globalThis.fetch,
  });
  registerSearchMemory(server, {
    qmdClient: deps?.qmdClient,
    qmdUrl: config.qmdUrl,
  });
  registerGetMemory(server, {
    qmdClient: deps?.qmdClient,
    qmdUrl: config.qmdUrl,
  });

  return server;
}
