import type { JsonRpcRequest, JsonRpcResponse, JsonRpcTransport, LogEntry } from "@ams/api";
import { createLogger, QmdClient, QmdUnavailableError } from "@ams/api";
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
  lastRequest: () =>
    | {
        url?: string;
        method?: string;
        body?: unknown;
        headers?: Record<string, string>;
      }
    | undefined;
} {
  let last: { url?: string; method?: string; body?: unknown; headers?: Record<string, string> };
  const fetch = vi.fn(async (url, init) => {
    last = {
      url: typeof url === "string" ? url : undefined,
      method: init && typeof init === "object" && "method" in init ? init.method : undefined,
      body: init && typeof init === "object" && "body" in init ? init.body : undefined,
      headers:
        init && typeof init === "object" && "headers" in init
          ? (init.headers as Record<string, string>)
          : undefined,
    };
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json,
    } as Response;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, lastRequest: () => last };
}

/** Logger that buffers parsed entries so tests can assert on structured output. */
function bufferLogger() {
  const entries: LogEntry[] = [];
  const logger = createLogger((line) => entries.push(JSON.parse(line)), "debug");
  return Object.assign(logger, { entries });
}

/** Discards log lines — keeps the output of pre-existing tests clean. */
const silentLogger = createLogger(() => undefined, "error");

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
  it("lists exactly six tools with descriptions and typed schemas", async () => {
    const server = createServer();
    const client = await createTestClient(server);

    const result = await client.listTools();

    const names = result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "delete_note",
      "get_memory",
      "list_tags",
      "list_types",
      "record_note",
      "search_memory",
    ]);
    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }
    // Argument-bearing tools must describe their inputs; list_types and
    // list_tags legitimately take no arguments.
    for (const name of ["delete_note", "get_memory", "record_note", "search_memory"]) {
      const tool = result.tools.find((t) => t.name === name);
      expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toHaveLength(0);
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
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
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
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "updated body" },
    });

    expect(result.content[0]?.text).toBe("Note updated: abc123 at notes/2026-07-27-hello.md");
  });

  it("reports a rename with moved_from in the success text", async () => {
    const { fetch } = mockFetch({
      ok: true,
      status: 200,
      json: {
        id: "abc123",
        path: "notes/renamed.md",
        created: false,
        moved_from: "notes/original.md",
      },
    });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: {
        title: "Renamed",
        type: "note",
        body: "b",
        topic_key: "topic/flow",
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe(
      "Note updated: abc123 at notes/renamed.md (moved from notes/original.md)",
    );
  });

  it("surfaces a 409 note_exists conflict as a non-error result with the old content and guidance", async () => {
    const { fetch } = mockFetch({
      ok: false,
      status: 409,
      json: {
        error: "note_exists",
        existing: {
          id: "hello",
          path: "notes/hello.md",
          body: "---\nid: hello\n---\n\noriginal body",
        },
      },
    });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "replacement body" },
    });

    // The conflict is a protocol outcome, NOT an error.
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text as string;
    expect(text).toContain("already exists");
    expect(text).toContain("hello");
    expect(text).toContain("notes/hello.md");
    expect(text).toContain("original body");
    expect(text).toContain("retitle your note");
    expect(text).toContain("overwrite: true");
  });

  it("keeps other 4xx/5xx statuses on the error path", async () => {
    const { fetch } = mockFetch({ ok: false, status: 409, json: { error: "something_else" } });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable: 409");
  });

  it("passes overwrite through to the Write API payload", async () => {
    const { fetch, lastRequest } = mockFetch({
      ok: true,
      status: 200,
      json: { id: "abc123", path: "notes/hello.md", created: false },
    });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body", overwrite: true },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse((lastRequest()?.body as string | undefined) ?? "{}")).toMatchObject({
      title: "Hello",
      overwrite: true,
    });
  });

  it("documents the conflict flow and topic_key format in the tool and field descriptions", async () => {
    const server = createServer({
      apiUrl: "http://localhost:3000",
      fetch: vi.fn(),
      logger: silentLogger,
    });
    const client = await createTestClient(server);

    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "record_note");
    expect(tool).toBeTruthy();

    expect(tool?.description).toContain("topic_key");
    expect(tool?.description).toContain("overwrite");

    const props = (tool?.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    expect(props.overwrite?.description).toBeTruthy();
    expect(props.overwrite?.description).toContain("collision");
    expect(props.topic_key?.description).toContain("in place");

    // Issue #35: agents must see the topic_key charset rules up front.
    expect(props.topic_key?.description).toContain("regex");
    expect(props.topic_key?.description).toContain("energia/banos");
    expect(props.topic_key?.description).toContain("energia/baños");

    // Issue #35: the conflict and validation rescue patterns must be explicit.
    expect(tool?.description).toContain("not an error");
    expect(tool?.description).toContain("omit topic_key");
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
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Validation error");
    expect(result.content[0]?.text).toContain("title: title is required");
  });

  it("surfaces the kebab-case validation error for a malformed tag", async () => {
    const { fetch, lastRequest } = mockFetch({
      ok: false,
      status: 400,
      json: {
        error: "validation_error",
        issues: [
          {
            message: "tags must be lowercase kebab-case (letters, digits, hyphens)",
            path: ["tags", "0"],
          },
        ],
      },
    });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body", tags: ["Salud"] },
    });

    // The malformed tag passes the tool's shape-only input schema and is
    // rejected by the shared frontmatter schema in the Write API.
    expect(JSON.parse((lastRequest()?.body as string | undefined) ?? "{}")).toMatchObject({
      tags: ["Salud"],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Validation error");
    expect(result.content[0]?.text).toContain(
      "tags.0: tags must be lowercase kebab-case (letters, digits, hyphens)",
    );
  });

  it("returns an unavailable error on Write API 500", async () => {
    const { fetch } = mockFetch({ ok: false, status: 500, json: { error: "boom" } });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
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
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable");
  });

  it("returns an error when the Write API returns a malformed payload", async () => {
    const { fetch } = mockFetch({ ok: true, status: 200, json: { foo: "bar" } });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API returned an unexpected payload");
  });

  it("rejects a missing required field before calling upstream", async () => {
    const fetch = vi.fn(async () => new Response());
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
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
    const server = createServer({ apiUrl: "", fetch, logger: silentLogger });
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
// delete_note
// -----------------------------------------------------------------------------

describe("delete_note", () => {
  it("sends DELETE with a per-segment encoded URL", async () => {
    const { fetch, lastRequest } = mockFetch({
      ok: true,
      status: 200,
      json: { deleted: true, path: "decisions/my note.md", note: null, raw: "x" },
    });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/my note.md" },
    });

    expect(result.isError).toBeFalsy();
    expect(lastRequest()?.method).toBe("DELETE");
    // Slashes structure the path; only the special characters are escaped.
    expect(lastRequest()?.url).toBe("http://localhost:3000/notes/decisions/my%20note.md");
  });

  it("renders the deleted path on success", async () => {
    const { fetch } = mockFetch({
      ok: true,
      status: 200,
      json: {
        deleted: true,
        path: "decisions/use-qmd.md",
        note: { frontmatter: { id: "use-qmd" }, body: "b" },
      },
    });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/use-qmd.md" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("Note deleted: decisions/use-qmd.md");
  });

  it("maps a 404 to a clear not-found error instead of the generic mapping", async () => {
    const { fetch } = mockFetch({
      ok: false,
      status: 404,
      json: { error: "not_found", message: "No note at decisions/missing.md" },
    });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/missing.md" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Note not found: decisions/missing.md");
  });

  it("maps a 400 to a validation error via the shared Write API mapping", async () => {
    const { fetch } = mockFetch({
      ok: false,
      status: 400,
      json: {
        error: "validation_error",
        issues: [{ message: "path must end in .md", path: ["path"] }],
      },
    });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/foo.txt" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Validation error");
    expect(result.content[0]?.text).toContain("path: path must end in .md");
  });

  it("returns an unavailable error on Write API 500", async () => {
    const { fetch } = mockFetch({ ok: false, status: 500, json: { error: "boom" } });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/x.md" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable: 500");
  });

  it("returns an unavailable error when fetch throws", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/x.md" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable");
  });

  it("returns an error when the Write API returns a malformed payload", async () => {
    const { fetch } = mockFetch({ ok: true, status: 200, json: { foo: "bar" } });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/x.md" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API returned an unexpected payload");
  });

  it("fails when AMS_API_URL is not configured", async () => {
    const { fetch } = mockFetch({ ok: true, status: 200, json: {} });
    const server = createServer({ apiUrl: "", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/x.md" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("AMS_API_URL is not configured");
  });

  it("rejects an empty file argument before calling upstream", async () => {
    const fetch = vi.fn(async () => new Response());
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Input validation error");
    expect(fetch).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// list_types
// -----------------------------------------------------------------------------

describe("list_types", () => {
  it("calls GET /types on the Write API and returns the type list", async () => {
    const { fetch, lastRequest } = mockFetch({
      ok: true,
      status: 200,
      json: { types: ["decision", "learning", "pattern"] },
    });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_types", arguments: {} });

    expect(lastRequest()?.url).toBe("http://localhost:3000/types");
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text as string;
    expect(text).toContain("decision");
    expect(text).toContain("learning");
    expect(text).toContain("pattern");
  });

  it("instructs agents to prefer existing types in the description", async () => {
    const server = createServer({
      apiUrl: "http://localhost:3000",
      fetch: vi.fn(),
      logger: silentLogger,
    });
    const client = await createTestClient(server);

    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "list_types");
    expect(tool).toBeTruthy();
    expect(tool?.description).toContain("prefer an existing type");
  });

  it("returns a non-error message for an empty type list", async () => {
    const { fetch } = mockFetch({ ok: true, status: 200, json: { types: [] } });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_types", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("No note types exist in the vault yet");
  });

  it("returns an unavailable error on Write API 500", async () => {
    const { fetch } = mockFetch({ ok: false, status: 500, json: { error: "boom" } });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_types", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable: 500");
  });

  it("returns an unavailable error when fetch throws", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_types", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable");
  });

  it("returns an error when the Write API returns a malformed payload", async () => {
    const { fetch } = mockFetch({ ok: true, status: 200, json: { foo: "bar" } });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_types", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API returned an unexpected payload");
  });

  it("fails when AMS_API_URL is not configured", async () => {
    const { fetch } = mockFetch({ ok: true, status: 200, json: { types: [] } });
    const server = createServer({ apiUrl: "", fetch, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_types", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("AMS_API_URL is not configured");
  });
});

// -----------------------------------------------------------------------------
// list_tags
// -----------------------------------------------------------------------------

describe("list_tags", () => {
  it("calls GET /tags on the Write API and returns the vocabulary", async () => {
    const { fetch, lastRequest } = mockFetch({
      ok: true,
      status: 200,
      json: {
        tags: [
          { name: "finanzas", count: 3 },
          { name: "2026", count: 1 },
        ],
      },
    });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_tags", arguments: {} });

    expect(lastRequest()?.url).toBe("http://localhost:3000/tags");
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text as string;
    expect(text).toContain("finanzas (3)");
    expect(text).toContain("2026 (1)");
  });

  it("instructs agents to prefer existing tags in the description", async () => {
    const server = createServer({ apiUrl: "http://localhost:3000", fetch: vi.fn() });
    const client = await createTestClient(server);

    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "list_tags");
    expect(tool).toBeTruthy();
    expect(tool?.description).toContain("prefer an existing tag");
  });

  it("returns a non-error message for an empty vocabulary", async () => {
    const { fetch } = mockFetch({ ok: true, status: 200, json: { tags: [] } });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_tags", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("No tags exist in the vault yet");
  });

  it("returns an unavailable error on Write API 500", async () => {
    const { fetch } = mockFetch({ ok: false, status: 500, json: { error: "boom" } });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_tags", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable: 500");
  });

  it("returns an unavailable error when fetch throws", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;
    const server = createServer({ apiUrl: "http://localhost:3000", fetch });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_tags", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable");
  });

  it("returns an error when the Write API returns a malformed payload", async () => {
    const { fetch } = mockFetch({ ok: true, status: 200, json: { foo: "bar" } });
    const server = createServer({ apiUrl: "http://localhost:3000", fetch });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_tags", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API returned an unexpected payload");
  });

  it("fails when AMS_API_URL is not configured", async () => {
    const { fetch } = mockFetch({ ok: true, status: 200, json: { tags: [] } });
    const server = createServer({ apiUrl: "", fetch });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_tags", arguments: {} });

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
    const server = createServer({ qmdClient, logger: silentLogger });
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
    const server = createServer({ qmdClient, logger: silentLogger });
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
    const server = createServer({ qmdClient, logger: silentLogger });
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
    const server = createServer({ qmdClient, logger: silentLogger });
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
    const server = createServer({ qmdClient, logger: silentLogger });
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
    const server = createServer({ qmdClient, logger: silentLogger });
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
    const server = createServer({ qmdClient, logger: silentLogger });
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
// Request-scoped logging
// -----------------------------------------------------------------------------

describe("request-scoped logging", () => {
  it("record_note forwards the logged requestId as x-request-id and never logs argument values", async () => {
    const { fetch, lastRequest } = mockFetch({
      ok: true,
      status: 201,
      json: { id: "abc123", path: "notes/x.md", created: true },
    });
    const logger = bufferLogger();
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "SECRET BODY VALUE" },
    });

    expect(result.isError).toBeFalsy();
    const start = logger.entries.find((e) => e.msg === "tool:invoke:start");
    const done = logger.entries.find((e) => e.msg === "tool:invoke:done");
    expect(start?.tool).toBe("record_note");
    expect(start?.requestId).toMatch(/^req_/);
    expect((start?.argsKeys as string[]).slice().sort()).toEqual(["body", "title", "type"]);
    expect(done?.requestId).toBe(start?.requestId);
    expect(done?.ok).toBe(true);
    expect(typeof done?.durationMs).toBe("number");

    // The outgoing Write API call carries the same correlation id.
    expect(lastRequest()?.headers?.["x-request-id"]).toBe(start?.requestId);

    // Keys only — argument VALUES must never reach the logs.
    const all = JSON.stringify(logger.entries);
    expect(all).not.toContain("SECRET BODY VALUE");
    expect(all).not.toContain("Hello");
  });

  it("list_types sends x-request-id matching its tool log line", async () => {
    const { fetch, lastRequest } = mockFetch({
      ok: true,
      status: 200,
      json: { types: ["decision"] },
    });
    const logger = bufferLogger();
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger });
    const client = await createTestClient(server);

    await client.callTool({ name: "list_types", arguments: {} });

    const start = logger.entries.find((e) => e.msg === "tool:invoke:start");
    expect(start?.tool).toBe("list_types");
    expect(start?.requestId).toMatch(/^req_/);
    expect(start?.argsKeys).toEqual([]);
    expect(lastRequest()?.headers?.["x-request-id"]).toBe(start?.requestId);
    expect(lastRequest()?.headers?.["content-type"]).toBeUndefined();
  });

  it("search_memory logs start/done with a fresh requestId per invocation", async () => {
    const { client: qmdClient } = fakeQmdClient((req) => toolOk(req, []));
    const logger = bufferLogger();
    const server = createServer({ qmdClient, logger });
    const client = await createTestClient(server);

    await client.callTool({ name: "search_memory", arguments: { query: "auth" } });
    await client.callTool({ name: "search_memory", arguments: { query: "auth" } });

    const starts = logger.entries.filter((e) => e.msg === "tool:invoke:start");
    const dones = logger.entries.filter((e) => e.msg === "tool:invoke:done");
    expect(starts).toHaveLength(2);
    expect(dones).toHaveLength(2);
    for (const entry of [...starts, ...dones]) {
      expect(entry.tool).toBe("search_memory");
    }
    expect(starts[0].requestId).not.toBe(starts[1].requestId);
  });

  it("logs tool:invoke:failed when the tool returns an error result", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;
    const logger = bufferLogger();
    const server = createServer({ apiUrl: "http://localhost:3000", fetch, logger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    const start = logger.entries.find((e) => e.msg === "tool:invoke:start");
    const failed = logger.entries.find((e) => e.msg === "tool:invoke:failed");
    expect(failed?.requestId).toBe(start?.requestId);
    expect(failed?.ok).toBe(false);
    expect(typeof failed?.durationMs).toBe("number");
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
    // No injected logger: this test proves the DEFAULT logger stays off stdout.
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
