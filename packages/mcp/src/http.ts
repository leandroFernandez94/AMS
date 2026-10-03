#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { getConfig, MCP_TOKEN_ENV } from "./config.js";
import { createHttpApp } from "./http-app.js";

async function main(): Promise<void> {
  const config = getConfig();

  // The token may legitimately be absent for stdio, but this entrypoint only
  // exists to serve HTTP — refuse to run unauthenticated.
  if (!config.token) {
    throw new Error(`${MCP_TOKEN_ENV} is required for the HTTP transport (bearer token)`);
  }

  const app = createHttpApp({
    token: config.token,
    apiUrl: config.apiUrl,
    qmdUrl: config.qmdUrl,
  });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    // STDERR only: stdout stays clean for protocol use in other entrypoints.
    process.stderr.write(`[ams-mcp-http] listening on http://${info.address}:${info.port}\n`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[ams-mcp-http] fatal: ${message}\n`);
  process.exit(1);
});
