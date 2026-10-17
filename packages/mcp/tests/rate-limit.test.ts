import { type ServerType, serve } from "@hono/node-server";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_MCP_RATE_LIMIT,
  getConfig,
  MCP_RATE_LIMIT_ENV,
  type McpOAuthConfig,
} from "../src/config.js";
import { createHttpApp } from "../src/http-app.js";

const TOKEN = "test-token";
/** Small injected limit: fast to exhaust, far from the 120 default. */
const LIMIT = 5;

/** Serves a Hono app on an ephemeral port; resolves once it is listening. */
function serveEphemeral(app: Hono): Promise<{ server: ServerType; url: string }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({ server, url: `http://127.0.0.1:${info.port}` });
    });
    server.on("error", reject);
  });
}

/** Best-effort close that tolerates an already-closed server. */
function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** One unauthenticated POST against `/mcp`, optionally as a client key. */
async function postMcp(base: string, clientIp?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (clientIp) headers["CF-Connecting-IP"] = clientIp;
  return fetch(`${base}/mcp`, { method: "POST", headers, cache: "no-store" });
}

/**
 * Exhausts `limit` requests for `clientIp` without asserting their statuses,
 * so the very next request from that key is over the limit.
 */
async function exhaustLimit(base: string, clientIp: string, limit: number): Promise<void> {
  for (let i = 0; i < limit; i++) {
    await postMcp(base, clientIp);
  }
}

// Shared fixture state: populated in beforeAll, torn down in afterAll.
let limitedUrl = "";
let disabledUrl = "";
let oauthLimitedUrl = "";
let limitedEntry: ServerType | undefined;
let disabledEntry: ServerType | undefined;
let oauthLimitedEntry: ServerType | undefined;

beforeAll(async () => {
  // Plain (no OAuth) app with a small injected limit.
  const limited = await serveEphemeral(
    createHttpApp({ token: TOKEN, apiUrl: "", qmdUrl: "", rateLimitPerMinute: LIMIT }),
  );
  limitedEntry = limited.server;
  limitedUrl = limited.url;

  // Limiter disabled: `0` must mount no middleware at all.
  const disabled = await serveEphemeral(
    createHttpApp({ token: TOKEN, apiUrl: "", qmdUrl: "", rateLimitPerMinute: 0 }),
  );
  disabledEntry = disabled.server;
  disabledUrl = disabled.url;

  // OAuth-mode app with the same small limit: the limiter must protect both
  // credential modes. The issuer is never fetched — no request below both
  // passes auth, and a missing Authorization header never reaches
  // `verifyToken`/JWKS (bearerAuth short-circuits to the 401 challenge).
  const oauthConfig: McpOAuthConfig = {
    issuer: "https://tenant.example.com/",
    audience: "https://ams.example.com/api",
    publicUrl: "https://ams.example.com",
  };
  const oauthLimited = await serveEphemeral(
    createHttpApp({
      token: TOKEN,
      oauth: oauthConfig,
      apiUrl: "",
      qmdUrl: "",
      rateLimitPerMinute: LIMIT,
    }),
  );
  oauthLimitedEntry = oauthLimited.server;
  oauthLimitedUrl = oauthLimited.url;
});

afterAll(async () => {
  if (limitedEntry) await closeServer(limitedEntry);
  if (disabledEntry) await closeServer(disabledEntry);
  if (oauthLimitedEntry) await closeServer(oauthLimitedEntry);
});

// -----------------------------------------------------------------------------
// Rate limit config (unit)
// -----------------------------------------------------------------------------

describe("rate limit config", () => {
  it("defaults the per-minute limit to 120", () => {
    const config = getConfig({});
    expect(config.rateLimitPerMinute).toBe(DEFAULT_MCP_RATE_LIMIT);
    expect(config.rateLimitPerMinute).toBe(120);
  });

  it("accepts an explicit value, including 0 to disable", () => {
    expect(getConfig({ [MCP_RATE_LIMIT_ENV]: "42" }).rateLimitPerMinute).toBe(42);
    expect(getConfig({ [MCP_RATE_LIMIT_ENV]: "0" }).rateLimitPerMinute).toBe(0);
  });

  it("throws ConfigError on negative, non-numeric or fractional values", () => {
    for (const raw of ["-1", "many", "1.5"]) {
      expect(() => getConfig({ [MCP_RATE_LIMIT_ENV]: raw }), raw).toThrow(ConfigError);
      expect(() => getConfig({ [MCP_RATE_LIMIT_ENV]: raw }), raw).toThrow(/AMS_MCP_RATE_LIMIT/);
    }
  });
});

// -----------------------------------------------------------------------------
// Rate limiter on /mcp (real HTTP end to end)
// -----------------------------------------------------------------------------

describe("rate limiter", () => {
  it("answers the request past the limit with 429 + Retry-After, no auth detail", async () => {
    const key = "203.0.113.10";
    for (let i = 0; i < LIMIT; i++) {
      const response = await postMcp(limitedUrl, key);
      // Under the limit the request still reaches auth: 401, not 429.
      expect(response.status, `request ${i}`).toBe(401);
    }

    const blocked = await postMcp(limitedUrl, key);
    expect(blocked.status).toBe(429);
    // Whole seconds until the minute boundary: always in [1, 60].
    const retryAfter = Number(blocked.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // Plain text body, and no auth challenge leaking into the throttle.
    expect(blocked.headers.get("content-type")).toContain("text/plain");
    expect(blocked.headers.get("www-authenticate")).toBeNull();
  });

  it("isolates client keys: another CF-Connecting-IP passes while one is throttled", async () => {
    const throttled = "203.0.113.11";
    const other = "198.51.100.7";
    await exhaustLimit(limitedUrl, throttled, LIMIT);
    expect((await postMcp(limitedUrl, throttled)).status).toBe(429);
    // The other key passes the limiter; auth still answers with 401.
    expect((await postMcp(limitedUrl, other)).status).toBe(401);
  });

  it("counts unauthenticated requests: the limiter runs before auth", async () => {
    const key = "203.0.113.12";
    await exhaustLimit(limitedUrl, key, LIMIT);
    // No token at all → 429 (never the 401 auth would answer with).
    expect((await postMcp(limitedUrl, key)).status).toBe(429);
    // A wrong-token request is throttled too: it must not reach `verifyToken`.
    const wrongToken = await fetch(`${limitedUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer wrong-${TOKEN}`, "CF-Connecting-IP": key },
      cache: "no-store",
    });
    expect(wrongToken.status).toBe(429);
  });

  it("limits OAuth mode too (works in both credential modes)", async () => {
    const key = "203.0.113.13";
    for (let i = 0; i < LIMIT; i++) {
      const response = await postMcp(oauthLimitedUrl, key);
      // Under the limit, the OAuth challenge proves the app runs OAuth mode.
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
    }
    expect((await postMcp(oauthLimitedUrl, key)).status).toBe(429);
  });

  it("does not limit the RFC 9728 metadata route", async () => {
    const key = "203.0.113.14";
    await exhaustLimit(oauthLimitedUrl, key, LIMIT);
    expect((await postMcp(oauthLimitedUrl, key)).status).toBe(429);
    const response = await fetch(`${oauthLimitedUrl}/.well-known/oauth-protected-resource/mcp`, {
      headers: { "CF-Connecting-IP": key },
      cache: "no-store",
    });
    expect(response.status).toBe(200);
  });

  it("0 disables the limiter (requests past the would-be limit all pass it)", async () => {
    const key = "203.0.113.15";
    for (let i = 0; i < LIMIT + 10; i++) {
      const response = await postMcp(disabledUrl, key);
      // 401 = auth answered: the limiter never mounted.
      expect(response.status, `request ${i}`).toBe(401);
    }
  });

  it("does not limit /health (Docker checks must stay reliable)", async () => {
    const key = "203.0.113.16";
    // Exhaust the key against /mcp first: if health shared the counter it
    // would immediately 429.
    await exhaustLimit(limitedUrl, key, LIMIT);
    expect((await postMcp(limitedUrl, key)).status).toBe(429);
    for (let i = 0; i < LIMIT + 5; i++) {
      const response = await fetch(`${limitedUrl}/health`, {
        headers: { "CF-Connecting-IP": key },
        cache: "no-store",
      });
      // 503 here: both upstreams are unconfigured. The point is never 429.
      expect(response.status, `health probe ${i}`).not.toBe(429);
      expect([200, 503]).toContain(response.status);
    }
  });
});
