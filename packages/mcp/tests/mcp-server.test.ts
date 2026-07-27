import type { JsonRpcRequest, JsonRpcResponse, JsonRpcTransport } from "@ams/api";
import { QmdClient, QmdUnavailableError } from "@ams/api";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";

/** Connects an SDK `Client` to the provided `McpServer` over a linked in-memory transport pair. */
async function createTestClient(server: ReturnType<typeof createServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/** Builds a `fetch` mock that records the request and returns a configured response. */
function mockFetch(response: { ok: boolean; status: number; json: unknown }): {
  fetch: typeof globalThis.fetch;
  lastRequest: () => { url?: string; body?: unknown } | undefined;
} {
  let last: { url?: string; body?: unknown } | undefined;
  const fetch = vi.fn(async (url, init) => {
    last = {
      url: typeof url === "string" ? url : undefined,
      body: init && typeof init === "object" && "body" in init ? init.body : undefined,
    };
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json,
    } as Response;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, lastRequest: () => last };
}

/** Creates a `QmdClient` driven by a fake JSON-RPC transport that records requests. */
function fakeQmdClient(handler: (req: JsonRpcRequest) => JsonRpcResponse): {
  client: QmdClient;
  lastRequest: () => JsonRpcRequest | undefined;
} {
  let last: JsonRpcRequest | undefined;
  const transport: JsonRpcTransport = async (req) => {
    last = req;
    return handler(req);
  };
  return { client: new QmdClient({ transport }), lastRequest: () => last };
}

/** Builds a successful MCP tool result carrying JSON text content. */
function toolOk(req: JsonRpcRequest, payload: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: req.id,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  };
}

/** Builds a `get` tool result carrying a resource content item. */
function toolResource(
  req: JsonRpcRequest,
  resource: { uri: string; text: string },
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: req.id,
    result: { content: [{ type: "resource", resource }] },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// Tool catalog
// -----------------------------------------------------------------------------

describe("tool catalog", () => {
  it("lists exactly three tools with descriptions and typed schemas", async () => {
    const server = createServer();
    const client = await createTestClient(server);

    const result = await client.listTools();

    const names = result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["get_memory", "record_note", "search_memory"]);
    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toHaveLength(0);
    }
  });
});

// -----------------------------------------------------------------------------
// record_note
// -----------------------------------------------------------------------------

describe("record_note", () => {
  it("creates a new note and returns id, path, and created status", async () => {
    const { fetch, lastRequest } = mockFetch({
      ok: true,
      status: 201,
      json: { id: "abc123", path: "notes/2026-07-27-hello.md", created: true },
    });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body text" },
    });

    expect(lastRequest()?.url).toBe("http://localhost:3000/notes");
    expect(JSON.parse((lastRequest()?.body as string | undefined) ?? "{}")).toEqual({
      title: "Hello",
      type: "note",
      body: "body text",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("Note recorded: abc123 at notes/2026-07-27-hello.md");
  });

  it("reports an update when the Write API returns created:false", async () => {
    const { fetch } = mockFetch({
      ok: true,
      status: 200,
      json: { id: "abc123", path: "notes/2026-07-27-hello.md", created: false },
    });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "updated body" },
    });

    expect(result.content[0]?.text).toBe("Note updated: abc123 at notes/2026-07-27-hello.md");
  });

  it("returns a validation error on Write API 400", async () => {
    const { fetch } = mockFetch({
      ok: false,
      status: 400,
      json: {
        error: "Validation failed",
        issues: [{ message: "title is required", path: ["title"] }],
      },
    });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Validation error");
    expect(result.content[0]?.text).toContain("title: title is required");
  });

  it("returns an unavailable error on Write API 500", async () => {
    const { fetch } = mockFetch({ ok: false, status: 500, json: { error: "boom" } });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable: 500");
  });

  it("returns an unavailable error when fetch throws", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;
    const server = createServer({ apiUrl: "http://localhost:3000", fetch });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Internal error");
  });

  it("rejects a missing required field before calling upstream", async () => {
    const fetch = vi.fn(async () => new Response());
    const server = createServer({ apiUrl: "http://localhost:3000", fetch });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Input validation error");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails when AMS_API_URL is not configured", async () => {
    const { fetch } = mockFetch({ ok: true, status: 201, json: {} });
    const server = createServer({ apiUrl: "", fetch });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("AMS_API_URL is not configured");
  });
});

// -----------------------------------------------------------------------------
// search_memory
// -----------------------------------------------------------------------------

describe("search_memory", () => {
  it("returns formatted hits from QmdClient", async () => {
    const { client: qmdClient, lastRequest } = fakeQmdClient((req) =>
      toolOk(req, [
        {
          docid: "#1",
          file: "qmd://vault/decisions/auth.md",
          title: "Auth decision",
          snippet: "use JWT",
          score: 0.9123,
        },
      ]),
    );
    const server = createServer({ qmdClient });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "auth" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("[0.912] Auth decision (decisions/auth.md)");
    expect(result.content[0]?.text).toContain("[#1]");
    expect(
      (lastRequest()?.params as { arguments: { searches: unknown[] } }).arguments.searches,
    ).toHaveLength(2);
  });

  it("forwards rerank: true to QmdClient.searchMemory", async () => {
    const { client: qmdClient, lastRequest } = fakeQmdClient((req) => toolOk(req, []));
    const server = createServer({ qmdClient });
    const client = await createTestClient(server);

    await client.callTool({
      name: "search_memory",
      arguments: { query: "auth", rerank: true },
    });

    const args = (lastRequest()?.params as { arguments: { rerank: boolean } }).arguments;
    expect(args.rerank).toBe(true);
  });

  it("returns a non-error message for empty results", async () => {
    const { client: qmdClient } = fakeQmdClient((req) => toolOk(req, []));
    const server = createServer({ qmdClient });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "nothing" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("No results found for: nothing");
  });

  it("returns a structured error when QMD is unavailable", async () => {
    const transport: JsonRpcTransport = async () => {
      throw new QmdUnavailableError("daemon down");
    };
    const qmdClient = new QmdClient({ transport });
    const server = createServer({ qmdClient });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "auth" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("QMD retrieval unavailable");
    expect(result.content[0]?.text).toContain("daemon down");
  });
});

// -----------------------------------------------------------------------------
// get_memory
// -----------------------------------------------------------------------------

describe("get_memory", () => {
  it("returns the document body when found", async () => {
    const { client: qmdClient, lastRequest } = fakeQmdClient((req) =>
      toolResource(req, {
        uri: "qmd://vault/decisions/auth.md",
        text: "<!-- Context: x -->\n\nbody content",
      }),
    );
    const server = createServer({ qmdClient });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "get_memory",
      arguments: { file: "#abc123" },
    });

    expect(lastRequest()?.params).toEqual({
      name: "get",
      arguments: { file: "#abc123", lineNumbers: false },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("body content");
  });

  it("returns a structured not-found error when the document is absent", async () => {
    const { client: qmdClient } = fakeQmdClient((req) => toolOk(req, {}));
    const server = createServer({ qmdClient });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "get_memory",
      arguments: { file: "#missing" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Not found: #missing");
  });

  it("returns a structured error when QMD is unavailable", async () => {
    const transport: JsonRpcTransport = async () => {
      throw new QmdUnavailableError("daemon down");
    };
    const qmdClient = new QmdClient({ transport });
    const server = createServer({ qmdClient });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "get_memory",
      arguments: { file: "#abc123" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("QMD retrieval unavailable");
  });
});

// -----------------------------------------------------------------------------
// stdout cleanliness
// -----------------------------------------------------------------------------

describe("stdout cleanliness", () => {
  let stdoutWrites: string[] = [];
  const originalWrite = process.stdout.write;

  beforeEach(() => {
    stdoutWrites = [];
    process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
      stdoutWrites.push(String(chunk));
      return originalWrite.apply(process.stdout, [chunk, ...args] as Parameters<
        typeof originalWrite
      >);
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it("writes only JSON-RPC frames to stdout during tool calls", async () => {
    const { fetch } = mockFetch({
      ok: true,
      status: 201,
      json: { id: "x", path: "y.md", created: true },
    });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch });
    const client = await createTestClient(server);

    await client.callTool({
      name: "record_note",
      arguments: { title: "T", type: "note", body: "b" },
    });

    const nonJsonRpc = stdoutWrites.filter((write) => {
      const trimmed = write.trim();
      return trimmed && !trimmed.startsWith('{"jsonrpc":') && !/^\d+$/.test(trimmed);
    });
    expect(nonJsonRpc).toEqual([]);
  });
});
