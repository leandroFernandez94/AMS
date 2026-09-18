import { createLogger, type Logger } from "@ams/api";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "./config.js";
import { registerGetMemory } from "./tools/get-memory.js";
import { registerListTags } from "./tools/list-tags.js";
import { registerListTypes } from "./tools/list-types.js";
import { registerRecordNote } from "./tools/record-note.js";
import { registerSearchMemory } from "./tools/search-memory.js";
import type { ServerDeps } from "./types.js";

/** Implementation metadata advertised to MCP clients. */
const SERVER_INFO = {
  name: "ams-mcp",
  version: "0.0.0",
};

/**
 * Builds a configured `McpServer` with the five AMS domain tools registered.
 *
 * Does NOT connect a transport — callers own transport wiring (stdio in
 * production, `InMemoryTransport` in tests).
 */
export function createServer(deps?: ServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  const config = getConfig();
  // Built here, not at module scope, so merely importing the package writes
  // nothing. The default sink is STDERR: stdout carries JSON-RPC frames only.
  const logger: Logger = deps?.logger ?? createLogger((line) => process.stderr.write(`${line}\n`));

  registerRecordNote(server, {
    apiUrl: deps?.apiUrl ?? config.apiUrl,
    fetch: deps?.fetch ?? globalThis.fetch,
    logger,
  });
  registerListTypes(server, {
    apiUrl: deps?.apiUrl ?? config.apiUrl,
    fetch: deps?.fetch ?? globalThis.fetch,
    logger,
  });
  registerListTags(server, {
    apiUrl: deps?.apiUrl ?? config.apiUrl,
    fetch: deps?.fetch ?? globalThis.fetch,
  });
  registerSearchMemory(server, {
    qmdClient: deps?.qmdClient,
    qmdUrl: config.qmdUrl,
    logger,
  });
  registerGetMemory(server, {
    qmdClient: deps?.qmdClient,
    qmdUrl: config.qmdUrl,
    logger,
  });

  return server;
}
