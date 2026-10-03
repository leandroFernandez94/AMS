import {
  createLogger,
  type DeleteResponse,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcTransport,
  type LogEntry,
  NoteExistsError,
  QmdClient,
  QmdUnavailableError,
  type RecordNoteInput,
  type TagsResponse,
  type TypesResponse,
  type UpsertResponse,
  type WriteApiClient,
  WriteApiNotFoundError,
  type WriteApiRequestOptions,
  WriteApiUnavailableError,
  WriteApiUnexpectedPayloadError,
  WriteApiValidationError,
} from "@ams/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_URL_ENV } from "../src/config.js";
import { createServer } from "../src/server.js";

/** Connects an SDK `Client` to the provided `McpServer` over a linked in-memory transport pair. */
async function createTestClient(server: ReturnType<typeof createServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/** A write-tool call as observed at the `WriteApiClient` seam. */
type WriteApiCall =
  | { method: "recordNote"; input: RecordNoteInput; requestId?: string }
  | { method: "deleteNote"; file: string; requestId?: string }
  | { method: "listTags" }
  | { method: "listTypes"; requestId?: string };

/**
 * Creates a fake `WriteApiClient` that records every call and answers from
 * `handler`: return a typed result for the success path, or throw one of the
 * typed client errors to drive an error branch. `WriteApiClient` holds
 * private state, so the structural fake is cast onto the class.
 */
function fakeWriteApiClient(handler: (call: WriteApiCall) => unknown): {
  client: WriteApiClient;
  calls: WriteApiCall[];
} {
  const calls: WriteApiCall[] = [];
  const answer = (call: WriteApiCall): unknown => {
    calls.push(call);
    return handler(call);
  };
  const fake = {
    recordNote: async (input: RecordNoteInput, opts?: WriteApiRequestOptions) =>
      answer({ method: "recordNote", input, requestId: opts?.requestId }) as UpsertResponse,
    deleteNote: async (file: string, opts?: WriteApiRequestOptions) =>
      answer({ method: "deleteNote", file, requestId: opts?.requestId }) as DeleteResponse,
    listTags: async () => answer({ method: "listTags" }) as TagsResponse,
    listTypes: async (opts?: WriteApiRequestOptions) =>
      answer({ method: "listTypes", requestId: opts?.requestId }) as TypesResponse,
  };
  return { client: fake as unknown as WriteApiClient, calls };
}

/** Extracts the request id a tool forwarded to the client, if any. */
function requestIdOf(call: WriteApiCall | undefined): string | undefined {
  return call && "requestId" in call ? call.requestId : undefined;
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
  vi.unstubAllEnvs();
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
    const { client: writeApi, calls } = fakeWriteApiClient(() => ({
      id: "abc123",
      path: "notes/2026-07-27-hello.md",
      created: true,
    }));
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body text" },
    });

    expect(calls[0]).toEqual({
      method: "recordNote",
      input: { title: "Hello", type: "note", body: "body text" },
      requestId: expect.any(String),
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("Note recorded: abc123 at notes/2026-07-27-hello.md");
  });

  it("reports an update when the Write API returns created:false", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => ({
      id: "abc123",
      path: "notes/2026-07-27-hello.md",
      created: false,
    }));
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "updated body" },
    });

    expect(result.content[0]?.text).toBe("Note updated: abc123 at notes/2026-07-27-hello.md");
  });

  it("reports a rename with moved_from in the success text", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => ({
      id: "abc123",
      path: "notes/renamed.md",
      created: false,
      moved_from: "notes/original.md",
    }));
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
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
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new NoteExistsError("Note already exists: hello at notes/hello.md", {
        id: "hello",
        path: "notes/hello.md",
        body: "---\nid: hello\n---\n\noriginal body",
      });
    });
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
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
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiUnavailableError("Write API unavailable: 409", {
        status: 409,
        body: { error: "something_else" },
      });
    });
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable: 409");
  });

  it("passes overwrite through to the Write API payload", async () => {
    const { client: writeApi, calls } = fakeWriteApiClient(() => ({
      id: "abc123",
      path: "notes/hello.md",
      created: false,
    }));
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body", overwrite: true },
    });

    expect(result.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({
      method: "recordNote",
      input: { title: "Hello", overwrite: true },
    });
  });

  it("documents the conflict flow and topic_key format in the tool and field descriptions", async () => {
    const server = createServer({ logger: silentLogger });
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
    const { client: writeApi } = fakeWriteApiClient(() => {
      // Real-API issue shape is {field, message}; the client renders the
      // messages alone, without a field prefix.
      throw new WriteApiValidationError("Validation error: title is required", [
        { field: "title", message: "title is required" },
      ]);
    });
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Validation error");
    expect(result.content[0]?.text).toContain("title is required");
  });

  it("surfaces the kebab-case validation error for a malformed tag", async () => {
    const { client: writeApi, calls } = fakeWriteApiClient(() => {
      throw new WriteApiValidationError(
        "Validation error: tags must be lowercase kebab-case (letters, digits, hyphens)",
        [
          {
            field: "tags",
            message: "tags must be lowercase kebab-case (letters, digits, hyphens)",
          },
        ],
      );
    });
    const server = createServer({ writeApiClient: writeApi });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body", tags: ["Salud"] },
    });

    // The malformed tag passes the tool's shape-only input schema and is
    // rejected by the shared frontmatter schema in the Write API.
    expect(calls[0]).toMatchObject({ method: "recordNote", input: { tags: ["Salud"] } });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Validation error");
    expect(result.content[0]?.text).toContain(
      "tags must be lowercase kebab-case (letters, digits, hyphens)",
    );
  });

  it("returns an unavailable error on Write API 500", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiUnavailableError("Write API unavailable: 500", {
        status: 500,
        body: { error: "boom" },
      });
    });
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable: 500");
  });

  it("returns an unavailable error when the client cannot reach the Write API", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiUnavailableError("Write API unavailable", {
        cause: new Error("connection refused"),
      });
    });
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable");
  });

  it("returns an error when the Write API returns a malformed payload", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiUnexpectedPayloadError("Write API returned an unexpected payload", {
        foo: "bar",
      });
    });
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { title: "Hello", type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API returned an unexpected payload");
  });

  it("rejects a missing required field before calling upstream", async () => {
    const { client: writeApi, calls } = fakeWriteApiClient(() => ({
      id: "x",
      path: "y.md",
      created: true,
    }));
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "record_note",
      arguments: { type: "note", body: "body" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Input validation error");
    expect(calls).toHaveLength(0);
  });

  it("fails when AMS_API_URL is not configured", async () => {
    // No client injected: the default client is built from the empty URL and
    // refuses to send — the guard now lives in the client layer.
    const server = createServer({ apiUrl: "", logger: silentLogger });
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
  it("passes the vault-relative path to the Write API client", async () => {
    const { client: writeApi, calls } = fakeWriteApiClient(() => ({
      deleted: true,
      path: "decisions/my note.md",
      note: null,
      raw: "x",
    }));
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/my note.md" },
    });

    expect(result.isError).toBeFalsy();
    // The tool forwards the raw vault path; per-segment URL encoding is the
    // client's concern (covered by the shared client's own tests).
    expect(calls[0]).toEqual({
      method: "deleteNote",
      file: "decisions/my note.md",
      requestId: expect.any(String),
    });
  });

  it("renders the deleted path on success", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => ({
      deleted: true,
      path: "decisions/use-qmd.md",
      note: null,
    }));
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/use-qmd.md" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("Note deleted: decisions/use-qmd.md");
  });

  it("maps a 404 to a clear not-found error instead of the generic mapping", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => {
      // Distinct from the expected output: the tool renders the miss from
      // its own argument, not from the API's message.
      throw new WriteApiNotFoundError("No note at decisions/missing.md");
    });
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/missing.md" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Note not found: decisions/missing.md");
  });

  it("maps a 400 to a validation error via the shared client mapping", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiValidationError(
        "Validation error: path must end in .md; type must not be empty",
        [
          { field: "path", message: "path must end in .md" },
          { field: "type", message: "type must not be empty" },
        ],
      );
    });
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/foo.txt" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Validation error");
    expect(result.content[0]?.text).toContain("path must end in .md");
    expect(result.content[0]?.text).toContain("type must not be empty");
  });

  it("returns an unavailable error on Write API 500", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiUnavailableError("Write API unavailable: 500", {
        status: 500,
        body: { error: "boom" },
      });
    });
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/x.md" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable: 500");
  });

  it("returns an unavailable error when the client cannot reach the Write API", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiUnavailableError("Write API unavailable", {
        cause: new Error("connection refused"),
      });
    });
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/x.md" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable");
  });

  it("returns an error when the Write API returns a malformed payload", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiUnexpectedPayloadError("Write API returned an unexpected payload", {
        foo: "bar",
      });
    });
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/x.md" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API returned an unexpected payload");
  });

  it("fails when AMS_API_URL is not configured", async () => {
    // No client injected: the default client guards the empty URL.
    const server = createServer({ apiUrl: "", logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "decisions/x.md" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("AMS_API_URL is not configured");
  });

  it("rejects an empty file argument before calling upstream", async () => {
    const { client: writeApi, calls } = fakeWriteApiClient(() => ({
      deleted: true,
      path: "x.md",
      note: null,
    }));
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({
      name: "delete_note",
      arguments: { file: "" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Input validation error");
    expect(calls).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// list_types
// -----------------------------------------------------------------------------

describe("list_types", () => {
  it("calls GET /types on the Write API and returns the type list", async () => {
    const { client: writeApi, calls } = fakeWriteApiClient(() => ({
      types: ["decision", "learning", "pattern"],
    }));
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_types", arguments: {} });

    expect(calls[0]).toEqual({ method: "listTypes", requestId: expect.any(String) });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text as string;
    expect(text).toContain("decision");
    expect(text).toContain("learning");
    expect(text).toContain("pattern");
  });

  it("instructs agents to prefer existing types in the description", async () => {
    const server = createServer({ logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "list_types");
    expect(tool).toBeTruthy();
    expect(tool?.description).toContain("prefer an existing type");
  });

  it("returns a non-error message for an empty type list", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => ({ types: [] }));
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_types", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("No note types exist in the vault yet");
  });

  it("returns an unavailable error on Write API 500", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiUnavailableError("Write API unavailable: 500", {
        status: 500,
        body: { error: "boom" },
      });
    });
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_types", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable: 500");
  });

  it("returns an unavailable error when the client cannot reach the Write API", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiUnavailableError("Write API unavailable", {
        cause: new Error("connection refused"),
      });
    });
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_types", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable");
  });

  it("returns an error when the Write API returns a malformed payload", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiUnexpectedPayloadError("Write API returned an unexpected payload", {
        foo: "bar",
      });
    });
    const server = createServer({ writeApiClient: writeApi, logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_types", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API returned an unexpected payload");
  });

  it("fails when AMS_API_URL is not configured", async () => {
    // No client injected: the default client guards the empty URL.
    const server = createServer({ apiUrl: "", logger: silentLogger });
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
    const { client: writeApi, calls } = fakeWriteApiClient(() => ({
      tags: [
        { name: "finanzas", count: 3 },
        { name: "2026", count: 1 },
      ],
    }));
    const server = createServer({ writeApiClient: writeApi });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_tags", arguments: {} });

    // Exact match pins the asymmetry: list_tags forwards NO request id.
    expect(calls[0]).toEqual({ method: "listTags" });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text as string;
    expect(text).toContain("finanzas (3)");
    expect(text).toContain("2026 (1)");
  });

  it("instructs agents to prefer existing tags in the description", async () => {
    const server = createServer();
    const client = await createTestClient(server);

    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "list_tags");
    expect(tool).toBeTruthy();
    expect(tool?.description).toContain("prefer an existing tag");
  });

  it("returns a non-error message for an empty vocabulary", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => ({ tags: [] }));
    const server = createServer({ writeApiClient: writeApi });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_tags", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("No tags exist in the vault yet");
  });

  it("returns an unavailable error on Write API 500", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiUnavailableError("Write API unavailable: 500", {
        status: 500,
        body: { error: "boom" },
      });
    });
    const server = createServer({ writeApiClient: writeApi });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_tags", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable: 500");
  });

  it("returns an unavailable error when the client cannot reach the Write API", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiUnavailableError("Write API unavailable", {
        cause: new Error("connection refused"),
      });
    });
    const server = createServer({ writeApiClient: writeApi });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_tags", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API unavailable");
  });

  it("returns an error when the Write API returns a malformed payload", async () => {
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiUnexpectedPayloadError("Write API returned an unexpected payload", {
        foo: "bar",
      });
    });
    const server = createServer({ writeApiClient: writeApi });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_tags", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Write API returned an unexpected payload");
  });

  it("fails when AMS_API_URL is not configured", async () => {
    // No client injected: the default client guards the empty URL.
    const server = createServer({ apiUrl: "" });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_tags", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("AMS_API_URL is not configured");
  });
});

// -----------------------------------------------------------------------------
// Write API client wiring
// -----------------------------------------------------------------------------

describe("write API client wiring", () => {
  it("builds a default client from AMS_API_URL when none is injected", async () => {
    // No writeApiClient injected: the server must construct the default
    // client lazily. With an empty configured URL the REAL client refuses
    // to send, so reaching its guard proves the call went through the
    // client layer rather than a stub.
    vi.stubEnv(API_URL_ENV, "");
    const server = createServer({ logger: silentLogger });
    const client = await createTestClient(server);

    const result = await client.callTool({ name: "list_types", arguments: {} });

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
  it("record_note forwards the logged requestId to the client and never logs argument values", async () => {
    const { client: writeApi, calls } = fakeWriteApiClient(() => ({
      id: "abc123",
      path: "notes/x.md",
      created: true,
    }));
    const logger = bufferLogger();
    const server = createServer({ writeApiClient: writeApi, logger });
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

    // The Write API call carries the same correlation id.
    expect(requestIdOf(calls[0])).toBe(start?.requestId);

    // Keys only — argument VALUES must never reach the logs.
    const all = JSON.stringify(logger.entries);
    expect(all).not.toContain("SECRET BODY VALUE");
    expect(all).not.toContain("Hello");
  });

  it("list_types sends its logged requestId with the client call", async () => {
    const { client: writeApi, calls } = fakeWriteApiClient(() => ({ types: ["decision"] }));
    const logger = bufferLogger();
    const server = createServer({ writeApiClient: writeApi, logger });
    const client = await createTestClient(server);

    await client.callTool({ name: "list_types", arguments: {} });

    const start = logger.entries.find((e) => e.msg === "tool:invoke:start");
    expect(start?.tool).toBe("list_types");
    expect(start?.requestId).toMatch(/^req_/);
    expect(start?.argsKeys).toEqual([]);
    expect(requestIdOf(calls[0])).toBe(start?.requestId);
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
    const { client: writeApi } = fakeWriteApiClient(() => {
      throw new WriteApiUnavailableError("Write API unavailable", {
        cause: new Error("connection refused"),
      });
    });
    const logger = bufferLogger();
    const server = createServer({ writeApiClient: writeApi, logger });
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
    const { client: writeApi } = fakeWriteApiClient(() => ({
      id: "x",
      path: "y.md",
      created: true,
    }));
    // No injected logger: this test proves the DEFAULT logger stays off stdout.
    const server = createServer({ writeApiClient: writeApi });
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
