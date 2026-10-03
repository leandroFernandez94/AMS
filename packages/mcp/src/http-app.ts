/**
 * Hono app exposing the MCP server over stateless Streamable HTTP.
 *
 * Phase 1 (issue #37): bearer-token auth, no sessions, no server-initiated
 * SSE. The SDK throws when a stateless transport handles two requests, so
 * every POST builds a fresh `McpServer` + fresh transport and tears them down
 * once the JSON response is complete (`enableJsonResponse` materializes the
 * full response before `handleRequest` resolves).
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { createServer } from "./server.js";
import type { ServerDeps } from "./types.js";

/** Timeout applied to each upstream health probe. */
const HEALTH_PROBE_TIMEOUT_MS = 2000;

/** Options accepted by `createHttpApp`. */
export interface HttpAppOptions {
  /** Static bearer token required on the MCP route (timing-safe check inside Hono). */
  token: string;
  /** Write API base URL used by the /health probe. Empty means unconfigured. */
  apiUrl: string;
  /** QMD base URL used by the /health probe. Empty means unconfigured. */
  qmdUrl: string;
  /** Collaborators forwarded to `createServer` for each request. */
  serverDeps?: ServerDeps;
}

/** Per-upstream outcome reported by GET /health. */
type UpstreamStatus = "up" | "down" | "unconfigured";

/** Probes `{base}/health` once; any failure or timeout counts as down. */
async function probeUpstream(baseUrl: string): Promise<UpstreamStatus> {
  if (!baseUrl) return "unconfigured";
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    return response.ok ? "up" : "down";
  } catch {
    return "down";
  }
}

/**
 * Builds the Streamable HTTP application.
 *
 * Routes:
 *  - `POST /mcp`   — MCP endpoint behind `bearerAuth`, fresh transport per request.
 *  - other methods on `/mcp` — explicit 405 `Allow: POST` (stateless phase 1;
 *    the SDK client treats 405 as "no server-initiated SSE", per spec).
 *  - `GET /health` — unauthenticated upstream probe (200 ok / 503 degraded).
 */
export function createHttpApp(options: HttpAppOptions): Hono {
  const app = new Hono();

  // Registered before the route handlers so auth runs before method routing:
  // an unauthenticated GET yields 401, not 405.
  app.use("/mcp", bearerAuth({ token: options.token }));

  app.on(["GET", "DELETE", "PUT", "PATCH"], "/mcp", (c) =>
    c.text("Method Not Allowed", 405, { Allow: "POST" }),
  );

  app.post("/mcp", async (c) => {
    const server = createServer(options.serverDeps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      // server.close() closes the transport; both are per-request only.
      await server.close();
    }
  });

  app.get("/health", async (c) => {
    const [api, qmd] = await Promise.all([
      probeUpstream(options.apiUrl),
      probeUpstream(options.qmdUrl),
    ]);
    // "unconfigured" and "down" are both not-ok: honesty over guesswork.
    const ok = api === "up" && qmd === "up";
    return c.json({ status: ok ? "ok" : "degraded", upstreams: { api, qmd } }, ok ? 200 : 503);
  });

  return app;
}
