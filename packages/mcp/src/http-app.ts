/**
 * Hono app exposing the MCP server over stateless Streamable HTTP.
 *
 * Phase 1 (issue #37): bearer-token auth, no sessions, no server-initiated
 * SSE. The SDK throws when a stateless transport handles two requests, so
 * every POST builds a fresh `McpServer` + fresh transport and tears them down
 * once the JSON response is complete (`enableJsonResponse` materializes the
 * full response before `handleRequest` resolves).
 *
 * Phase 2 (issue #39): optional OAuth 2.1 resource-server mode. When the
 * OAuth triple is configured, `POST /mcp` also accepts Auth0-issued RS256
 * JWTs alongside the static token, and RFC 9728 protected-resource metadata
 * is served for OAuth-capable clients to discover.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { timingSafeEqual } from "hono/utils/buffer";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  ConfigError,
  MCP_TOKEN_ENV,
  type McpConfig,
  type McpOAuthConfig,
  resolveOAuthConfig,
} from "./config.js";
import { createServer } from "./server.js";
import type { ServerDeps } from "./types.js";

/** Timeout applied to each upstream health probe. */
const HEALTH_PROBE_TIMEOUT_MS = 2000;

/** Path of the RFC 9728 protected-resource metadata document. */
const PRM_PATH = "/.well-known/oauth-protected-resource/mcp";

/** Allowed clock skew (seconds) for JWT exp/nbf checks (Auth0 drift). */
const JWT_CLOCK_TOLERANCE_SECONDS = 30;

/** Options accepted by `createHttpApp`. */
export interface HttpAppOptions {
  /** Static bearer token required on the MCP route (timing-safe check). */
  token: string;
  /**
   * OAuth resource-server configuration. When set (non-null), Auth0 JWTs are
   * accepted next to the static token and the RFC 9728 metadata route is
   * mounted. Null/undefined keeps phase-1 behavior exactly.
   */
  oauth?: McpOAuthConfig | null;
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
 * Fails fast when the config cannot serve HTTP securely.
 *
 * The token may legitimately be absent for stdio (the config is shared), but
 * the HTTP entrypoint exists to serve HTTP — refuse to run unauthenticated.
 * Kept here (not in `config.ts`) so the shared stdio config stays permissive
 * and the guard itself is unit-testable without spawning the entrypoint.
 *
 * Returns the validated OAuth triple, or null when OAuth is unset (the caller
 * passes it straight to `createHttpApp`).
 */
export function assertHttpConfig(config: McpConfig): McpOAuthConfig | null {
  if (!config.token) {
    throw new ConfigError(`${MCP_TOKEN_ENV} is required for the HTTP transport (bearer token)`);
  }
  return resolveOAuthConfig(config.oauth);
}

/**
 * Builds the `/mcp` auth middleware: static token only (phase 1) when OAuth
 * is unset, dual credentials otherwise.
 *
 * `bearerAuth` is kept in both modes — it owns the header charset validation
 * (400 `invalid_request`) and the 401 challenge shapes. In OAuth mode the
 * 401 challenges additionally carry the RFC 9728 `resource_metadata` hint so
 * connector clients can discover the authorization server.
 */
function createMcpAuth(options: HttpAppOptions): ReturnType<typeof bearerAuth> {
  const { token, oauth } = options;

  if (!oauth) {
    return bearerAuth({ token });
  }

  const resourceMetadata = `${oauth.publicUrl}${PRM_PATH}`;
  // Built once per app: jose caches the fetched JWKS (10 min) and refreshes
  // on key rotation, so requests normally verify without network I/O.
  const jwks = createRemoteJWKSet(
    new URL(`${oauth.issuer.replace(/\/+$/, "")}/.well-known/jwks.json`),
  );

  return bearerAuth({
    verifyToken: async (presented) => {
      // Static token first: local timing-safe comparison, no network.
      if (await timingSafeEqual(token, presented)) return true;
      // Anything else is treated as an Auth0-issued JWT. Every failure mode
      // (unknown key, bad signature, expired, wrong iss/aud, JWKS fetch
      // error/timeout) collapses to the same 401 invalid_token challenge.
      try {
        await jwtVerify(presented, jwks, {
          issuer: oauth.issuer,
          audience: oauth.audience,
          algorithms: ["RS256"],
          clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
        });
        return true;
      } catch {
        return false;
      }
    },
    invalidToken: {
      wwwAuthenticateHeader: { error: "invalid_token", resource_metadata: resourceMetadata },
    },
    noAuthenticationHeader: {
      wwwAuthenticateHeader: { realm: "", resource_metadata: resourceMetadata },
    },
  });
}

/**
 * Builds the Streamable HTTP application.
 *
 * Routes:
 *  - `POST /mcp`   — MCP endpoint behind dual-credential auth, fresh
 *    transport per request.
 *  - other methods on `/mcp` — explicit 405 `Allow: POST` (stateless phase 1;
 *    the SDK client treats 405 as "no server-initiated SSE", per spec).
 *  - `GET /.well-known/oauth-protected-resource/mcp` — unauthenticated
 *    RFC 9728 metadata; only mounted when OAuth is configured.
 *  - `GET /health` — unauthenticated upstream probe (200 ok / 503 degraded).
 */
export function createHttpApp(options: HttpAppOptions): Hono {
  const app = new Hono();

  // Registered before the route handlers so auth runs before method routing:
  // an unauthenticated GET yields 401, not 405.
  app.use("/mcp", createMcpAuth(options));

  app.on(["GET", "DELETE", "PUT", "PATCH", "OPTIONS"], "/mcp", (c) =>
    c.text("Method Not Allowed", 405, { Allow: "POST" }),
  );

  app.post("/mcp", async (c) => {
    const server = createServer(options.serverDeps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      // connect() lives inside the try: a rejected handshake must still
      // close the server instead of leaking the per-request pair.
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      // server.close() closes the transport; both are per-request only.
      await server.close();
    }
  });

  if (options.oauth) {
    const { oauth } = options;
    // Public by design: discovery must work before any token exists.
    // `scopes_supported` is null — no scope enforcement in v1 (see #39).
    app.get(PRM_PATH, (c) =>
      c.json({
        resource: `${oauth.publicUrl}/mcp`,
        authorization_servers: [oauth.issuer],
        scopes_supported: null,
      }),
    );
  }

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
