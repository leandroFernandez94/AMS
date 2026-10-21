/**
 * Fixed-window in-app rate limiter for the public MCP route (#39).
 *
 * State is process-local on purpose: the deployment runs a single MCP
 * replica, so an in-memory Map is the whole truth — a shared store only
 * matters with more replicas (out of scope, decision 7 in the feature doc).
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

/** Cloudflare-injected header carrying the originating client IP. */
const CF_CONNECTING_IP_HEADER = "CF-Connecting-IP";

/** Key shared by all requests that expose neither header nor socket address. */
const UNKNOWN_KEY = "unknown";

/** Window length the per-minute limit is counted over. */
const WINDOW_MS = 60_000;

/**
 * Map size that triggers a sweep of expired windows. Keeps memory bounded
 * under spoofed-header floods while leaving the per-request cost O(1) below.
 */
const PRUNE_THRESHOLD = 10_000;

/** Counter state for one client key within one window. */
interface WindowState {
  window: number;
  count: number;
}

/** Options for `createRateLimiter`. */
export interface RateLimiterOptions {
  /** Requests allowed per client key per minute. */
  limitPerMinute: number;
}

/**
 * Resolves the client key for one request.
 *
 * `CF-Connecting-IP` wins because behind the cloudflared tunnel the socket
 * address is Cloudflare's edge, not the client's; only the tunnel sets that
 * header, so trusting it there is safe (decision 7). Direct
 * private-network clients fall back to the socket address exposed by the
 * node-server adapter; when no adapter supplied bindings (e.g.
 * `app.request()` in tests) all callers share the `unknown` key.
 */
function resolveClientKey(c: Context): string {
  const header = c.req.header(CF_CONNECTING_IP_HEADER);
  if (header) return header;
  try {
    return getConnInfo(c).remote.address ?? UNKNOWN_KEY;
  } catch {
    return UNKNOWN_KEY;
  }
}

/**
 * Builds the rate-limit middleware for `/mcp`.
 *
 * Mounted before auth on purpose: counting precedes credential checks so a
 * flood is rejected before any JWT/JWKS verification work runs, and
 * unauthenticated requests count too — no token is needed to be throttled.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const windows = new Map<string, WindowState>();

  return createMiddleware(async (c, next) => {
    const key = resolveClientKey(c);
    const now = Date.now();
    // Windows tick on absolute minute boundaries, independent per key.
    const window = Math.floor(now / WINDOW_MS);

    const existing = windows.get(key);
    const state: WindowState = existing?.window === window ? existing : { window, count: 0 };
    if (state !== existing) {
      windows.set(key, state);
      // Lazy pruning: only sweep once the map outgrows the threshold.
      if (windows.size > PRUNE_THRESHOLD) {
        for (const [mapKey, entry] of windows) {
          if (entry.window !== window) windows.delete(mapKey);
        }
      }
    }
    state.count += 1;

    if (state.count > options.limitPerMinute) {
      // Whole seconds until the window resets; `now` is strictly inside the
      // window, so this is always in [1, 60].
      const retryAfterSeconds = Math.ceil(((window + 1) * WINDOW_MS - now) / 1000);
      // Plain text, no auth detail: the response must not leak why or who.
      return c.text("Too Many Requests", 429, { "Retry-After": String(retryAfterSeconds) });
    }

    await next();
  });
}
