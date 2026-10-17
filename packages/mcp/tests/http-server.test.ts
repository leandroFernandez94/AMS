import {
  createLogger,
  type TypesResponse,
  type WriteApiClient,
  type WriteApiRequestOptions,
} from "@ams/shared";
import { type ServerType, serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_MCP_HOST,
  DEFAULT_MCP_PORT,
  getConfig,
  MCP_HOST_ENV,
  MCP_PORT_ENV,
  MCP_TOKEN_ENV,
} from "../src/config.js";
import { assertHttpConfig, createHttpApp } from "../src/http-app.js";

const TOKEN = "test-token";

/** Discards log lines — keeps the test output clean. */
const silentLogger = createLogger(() => undefined, "error");

/** A write-tool call as observed at the `WriteApiClient` seam. */
type WriteApiCall = { method: "listTypes"; requestId?: string };

/**
 * Creates a structural `WriteApiClient` fake for `list_types` that records
 * every call and answers from `handler`. `WriteApiClient` holds private
 * state, so the fake is cast onto the class (same pattern as
 * mcp-server.test.ts).
 */
function fakeWriteApiClient(handler: (call: WriteApiCall) => unknown): {
  client: WriteApiClient;
  calls: WriteApiCall[];
} {
  const calls: WriteApiCall[] = [];
  const fake = {
    listTypes: async (opts?: WriteApiRequestOptions) => {
      const call: WriteApiCall = { method: "listTypes", requestId: opts?.requestId };
      calls.push(call);
      return handler(call) as TypesResponse;
    },
  };
  return { client: fake as unknown as WriteApiClient, calls };
}

/** Minimal upstream stub: `GET /health` → 200, like the API and QMD daemons. */
function healthStubApp(): Hono {
  return new Hono().get("/health", (c) => c.json({ status: "ok" }));
}

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

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

describe("http config", () => {
  it("throws ConfigError on a malformed AMS_MCP_PORT", () => {
    expect(() => getConfig({ [MCP_PORT_ENV]: "not-a-number" })).toThrow(ConfigError);
    expect(() => getConfig({ [MCP_PORT_ENV]: "-1" })).toThrow(/AMS_MCP_PORT/);
  });

  it("applies the default host and port", () => {
    const config = getConfig({});
    expect(config.port).toBe(DEFAULT_MCP_PORT);
    expect(config.port).toBe(3111);
    expect(config.host).toBe(DEFAULT_MCP_HOST);
    expect(config.host).toBe("127.0.0.1");
  });

  it("accepts an explicit host and port", () => {
    const config = getConfig({ [MCP_PORT_ENV]: "4242", [MCP_HOST_ENV]: "0.0.0.0" });
    expect(config.port).toBe(4242);
    expect(config.host).toBe("0.0.0.0");
  });

  it("leaves the token empty when missing or blank (stdio shares this config)", () => {
    expect(getConfig({}).token).toBe("");
    expect(getConfig({ [MCP_TOKEN_ENV]: "   " }).token).toBe("");
  });

  it("trims a provided token", () => {
    expect(getConfig({ [MCP_TOKEN_ENV]: "  secret  " }).token).toBe("secret");
  });

  it("assertHttpConfig throws ConfigError naming AMS_MCP_TOKEN when the token is empty", () => {
    expect(() => assertHttpConfig(getConfig({}))).toThrow(ConfigError);
    expect(() => assertHttpConfig(getConfig({ [MCP_TOKEN_ENV]: "   " }))).toThrow(/AMS_MCP_TOKEN/);
    expect(() => assertHttpConfig(getConfig({ [MCP_TOKEN_ENV]: "secret" }))).not.toThrow();
  });
});

// -----------------------------------------------------------------------------
// Streamable HTTP transport (real HTTP end to end)
// -----------------------------------------------------------------------------

describe("streamable http server", () => {
  let mcpUrl: string;
  let apiStub: ServerType;
  let qmdStub: ServerType;
  let mcpEntry: ServerType;
  let mcpClient: Client | undefined;
  let writeCalls: WriteApiCall[];

  beforeAll(async () => {
    // Two upstream stubs the /health probe will target.
    const api = await serveEphemeral(healthStubApp());
    apiStub = api.server;
    const qmd = await serveEphemeral(healthStubApp());
    qmdStub = qmd.server;

    const { client: writeApiClient, calls } = fakeWriteApiClient(() => ({
      types: ["decision", "learning", "pattern"],
    }));
    writeCalls = calls;

    const app = createHttpApp({
      token: TOKEN,
      apiUrl: api.url,
      qmdUrl: qmd.url,
      serverDeps: { writeApiClient, logger: silentLogger },
    });
    const served = await serveEphemeral(app);
    mcpEntry = served.server;
    mcpUrl = served.url;
  });

  afterAll(async () => {
    try {
      await mcpClient?.close();
    } catch {
      /* best effort */
    }
    await closeServer(mcpEntry);
    await closeServer(apiStub);
    await closeServer(qmdStub);
  });

  it("serves initialize, listTools and callTool as sequential fresh-transport POSTs", async () => {
    mcpClient = new Client({ name: "http-test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });

    // initialize + notifications/initialized already cross the wire here.
    // Each POST hits a brand-new server+transport pair; if tearing them down
    // after handleRequest broke the JSON lifecycle, a later call would hang
    // and fail the test timeout instead of returning.
    await mcpClient.connect(transport);

    const tools = await mcpClient.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "delete_note",
      "get_memory",
      "list_tags",
      "list_types",
      "record_note",
      "search_memory",
    ]);

    const result = await mcpClient.callTool({ name: "list_types", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(writeCalls).toEqual([{ method: "listTypes", requestId: expect.any(String) }]);
    const text = result.content[0]?.text as string;
    expect(text).toContain("decision");
    expect(text).toContain("learning");
    expect(text).toContain("pattern");
  });

  it("rejects POST /mcp without a token (401 with WWW-Authenticate)", async () => {
    const response = await fetch(`${mcpUrl}/mcp`, { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeTruthy();
  });

  it("rejects POST /mcp with a wrong token (401)", async () => {
    const response = await fetch(`${mcpUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(response.status).toBe(401);
  });

  it("answers 405 with Allow: POST for non-POST methods with a valid token", async () => {
    for (const method of ["GET", "DELETE", "PUT", "PATCH", "OPTIONS"] as const) {
      const response = await fetch(`${mcpUrl}/mcp`, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}` },
        cache: "no-store",
      });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("POST");
    }
  });

  it("answers 401 for GET /mcp without a token (auth runs before method routing)", async () => {
    const response = await fetch(`${mcpUrl}/mcp`, { cache: "no-store" });
    expect(response.status).toBe(401);
  });

  it("reports ok when both upstreams answer", async () => {
    const response = await fetch(`${mcpUrl}/health`, { cache: "no-store" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", upstreams: { api: "up", qmd: "up" } });
  });

  it("marks an unconfigured api URL as unconfigured and reports 503", async () => {
    const { server, url } = await serveEphemeral(healthStubApp());
    try {
      const app = createHttpApp({ token: TOKEN, apiUrl: "", qmdUrl: url });
      const response = await app.request("/health");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        status: "degraded",
        upstreams: { api: "unconfigured", qmd: "up" },
      });
    } finally {
      await closeServer(server);
    }
  });

  it("reports degraded with the failed upstream down", async () => {
    await closeServer(qmdStub);
    const response = await fetch(`${mcpUrl}/health`, { cache: "no-store" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "degraded",
      upstreams: { api: "up", qmd: "down" },
    });
  });
});
