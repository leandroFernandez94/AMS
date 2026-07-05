/**
 * Low-level JSON-RPC 2.0 transport for the QMD MCP daemon.
 *
 * QMD's MCP-over-HTTP surface is a single endpoint: `POST /mcp`. Despite the
 * README advertising it as "stateless", the real daemon enforces the MCP
 * Streamable HTTP **session** contract: the first request must be
 * `initialize`, the response carries an `mcp-session-id` header, and every
 * subsequent request must echo it back (or the daemon answers
 * `-32000 Missing session ID`). This transport owns that handshake and the
 * wire concerns — request framing, timeout, network-failure classification —
 * and nothing else.
 *
 * The session is established lazily on the first call and cached for the
 * transport's lifetime; if a server genuinely returns no session id, the
 * transport degrades to stateless mode so it stays forward-compatible.
 *
 * The transport is an injectable function so the client and its tests never
 * depend on a real socket: unit tests pass a fake `JsonRpcTransport`, while
 * production wires `createFetchTransport` backed by the global `fetch`
 * (available on Node >= 22, which is the project baseline).
 *
 * Daemon-down is the headline failure mode of Spec 4: a refused connection or
 * a timeout is surfaced as `QmdUnavailableError` so callers can degrade
 * gracefully instead of crashing.
 */
import { QmdProtocolError, QmdUnavailableError } from "./errors.js";

/** JSON-RPC 2.0 request envelope. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 response envelope. Either `result` or `error` is present. */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Sends a JSON-RPC request and resolves with the parsed response. */
export type JsonRpcTransport = (request: JsonRpcRequest) => Promise<JsonRpcResponse>;

/** Path of the MCP Streamable HTTP endpoint on the daemon. */
const MCP_PATH = "/mcp";

/** MCP protocol version QMD 2.x negotiates during `initialize`. */
const MCP_PROTOCOL_VERSION = "2025-06-18";

/** HTTP headers every request to the daemon must carry. */
const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
} as const;

/** Options for the fetch-backed transport. */
export interface FetchTransportOptions {
  /** Daemon base URL, e.g. `http://localhost:8181`. */
  baseUrl: string;
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
}

/**
 * Builds a transport backed by the global `fetch`.
 *
 * The first call transparently performs the MCP `initialize` handshake and
 * caches the returned `mcp-session-id`; later calls reuse it. Network errors
 * and timeouts become `QmdUnavailableError`; non-JSON or non-conforming bodies
 * become `QmdProtocolError`.
 */
export function createFetchTransport(opts: FetchTransportOptions): JsonRpcTransport {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}${MCP_PATH}`;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  let sessionId: string | undefined;
  let initPromise: Promise<void> | undefined;

  /** Performs one POST with a timeout, classifying failures. */
  async function post(body: unknown, withSession: boolean): Promise<Response> {
    const headers: Record<string, string> = { ...JSON_HEADERS };
    if (withSession && sessionId) headers["mcp-session-id"] = sessionId;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      // AbortController abort (timeout) and a genuine connection failure are
      // both recoverable "daemon not usable" states from the caller's view.
      throw new QmdUnavailableError(`QMD daemon unreachable at ${url}`, { cause: e });
    }
  }

  /** Lazily runs `initialize` once and stores the session id. */
  function ensureSession(): Promise<void> {
    if (initPromise) return initPromise;
    const initId = `init-${Date.now()}`;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ams", version: "0.0.0" },
      },
    };
    initPromise = (async () => {
      const response = await post(request, false);
      if (!response.ok) {
        throw new QmdUnavailableError(
          `QMD initialize failed: HTTP ${response.status} ${response.statusText}`,
        );
      }
      // The session id is what makes later calls accepted. Truly stateless
      // servers omit it; in that case we simply keep operating without one.
      sessionId = response.headers.get("mcp-session-id") ?? undefined;
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (e) {
        throw new QmdProtocolError(`QMD initialize response was not JSON: ${(e as Error).message}`);
      }
      assertResponse(payload, initId);
    })();
    // A failed init must not poison the transport forever: clear the cache so
    // the next call can retry once the daemon is back.
    initPromise.catch(() => {
      initPromise = undefined;
    });
    return initPromise;
  }

  return async (request) => {
    await ensureSession();
    const response = await post(request, true);
    if (!response.ok) {
      throw new QmdUnavailableError(
        `QMD daemon returned HTTP ${response.status} ${response.statusText}`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (e) {
      throw new QmdProtocolError(`QMD response was not valid JSON: ${(e as Error).message}`);
    }
    return assertResponse(payload, request.id);
  };
}

/** Validates that a parsed payload is a JSON-RPC response matching the id. */
function assertResponse(payload: unknown, expectedId: number | string): JsonRpcResponse {
  if (!payload || typeof payload !== "object") {
    throw new QmdProtocolError("QMD response is not a JSON-RPC object");
  }
  const obj = payload as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0") {
    throw new QmdProtocolError(`QMD response has wrong jsonrpc field: ${String(obj.jsonrpc)}`);
  }
  if (obj.id !== expectedId) {
    throw new QmdProtocolError(
      `QMD response id mismatch: expected ${String(expectedId)}, got ${String(obj.id)}`,
    );
  }
  if (obj.result === undefined && obj.error === undefined) {
    throw new QmdProtocolError("QMD response has neither result nor error");
  }
  return payload as JsonRpcResponse;
}
