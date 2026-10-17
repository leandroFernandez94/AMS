#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { getConfig } from "./config.js";
import { assertHttpConfig, createHttpApp } from "./http-app.js";

async function main(): Promise<void> {
  const config = getConfig();
  const oauth = assertHttpConfig(config);

  const app = createHttpApp({
    token: config.token,
    oauth,
    apiUrl: config.apiUrl,
    qmdUrl: config.qmdUrl,
  });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    // STDERR only: stdout stays clean for protocol use in other entrypoints.
    process.stderr.write(`[ams-mcp-http] listening on http://${info.address}:${info.port}\n`);
  });

  // Listener-level failures (e.g. EADDRINUSE) surface as an "error" event,
  // not in main()'s catch — keep the same fatal shape instead of an
  // uncaught-exception crash.
  server.on("error", (err: Error) => {
    process.stderr.write(`[ams-mcp-http] fatal: ${err.message}\n`);
    process.exit(1);
  });

  const shutdown = () => {
    // Drain idle keep-alive sockets so close() is not held open by pooled
    // connections. Declared on http.Server since Node 18.2; ServerType also
    // admits http2 servers, hence the runtime feature check.
    if ("closeIdleConnections" in server) {
      server.closeIdleConnections();
    }
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
