import { describe, expect, it } from "vitest";
import { QmdClient } from "../src/qmd/client.js";
import { QmdError, QmdToolError, QmdUnavailableError } from "../src/qmd/errors.js";
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcTransport } from "../src/qmd/http.js";

/** Builds an MCP tool result wrapping `payload` as JSON text content. */
function toolOk(req: JsonRpcRequest, payload: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: req.id,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  };
}

/** Builds a `get` tool result carrying a resource content item (real QMD shape). */
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

/** Builds an MCP tool result flagged as an error. */
function toolErr(req: JsonRpcRequest, text: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: req.id,
    result: { content: [{ type: "text", text }], isError: true },
  };
}

/** Builds a JSON-RPC level error. */
function rpcError(req: JsonRpcRequest, message: string, code = -32603): JsonRpcResponse {
  return { jsonrpc: "2.0", id: req.id, error: { code, message } };
}

/**
 * Transport that records the last request and answers via a handler. The
 * handler may throw to simulate daemon failures.
 */
function recordingTransport(handler: (req: JsonRpcRequest) => JsonRpcResponse): {
  transport: JsonRpcTransport;
  lastRequest: () => JsonRpcRequest;
} {
  let last: JsonRpcRequest | undefined;
  const transport: JsonRpcTransport = async (req) => {
    last = req;
    return handler(req);
  };
  return { transport, lastRequest: () => last as JsonRpcRequest };
}

function clientWith(handler: (req: JsonRpcRequest) => JsonRpcResponse): {
  client: QmdClient;
  lastRequest: () => JsonRpcRequest;
} {
  const { transport, lastRequest } = recordingTransport(handler);
  return { client: new QmdClient({ transport }), lastRequest };
}

// ---------------------------------------------------------------------------
// searchMemory
// ---------------------------------------------------------------------------

describe("QmdClient.searchMemory", () => {
  it("issues a tools/call to the query tool with the hybrid profile and rerank off", async () => {
    const { client, lastRequest } = clientWith((req) =>
      toolOk(req, [{ docid: "#1", file: "qmd://vault/decisions/a.md", score: 0.9, snippet: "s" }]),
    );

    const hits = await client.searchMemory({ query: "auth flow" });

    const req = lastRequest();
    expect(req.method).toBe("tools/call");
    expect(req.params).toEqual({
      name: "query",
      arguments: {
        searches: [
          { type: "lex", query: "auth flow" },
          { type: "vec", query: "auth flow" },
        ],
        rerank: false,
      },
    });
    expect(hits).toEqual([
      { id: "#1", path: "decisions/a.md", title: "", snippet: "s", score: 0.9 },
    ]);
  });

  it("forwards rerank: true when the caller opts in", async () => {
    const { client, lastRequest } = clientWith((req) => toolOk(req, []));
    await client.searchMemory({ query: "x", rerank: true });
    expect((lastRequest().params as { arguments: { rerank: boolean } }).arguments.rerank).toBe(
      true,
    );
  });

  it("forwards limit and minScore when provided", async () => {
    const { client, lastRequest } = clientWith((req) => toolOk(req, []));
    await client.searchMemory({ query: "x", limit: 3, minScore: 0.4 });
    const args = (lastRequest().params as { arguments: Record<string, unknown> }).arguments;
    expect(args.limit).toBe(3);
    expect(args.minScore).toBe(0.4);
  });

  it("omits limit/minScore when not provided", async () => {
    const { client, lastRequest } = clientWith((req) => toolOk(req, []));
    await client.searchMemory({ query: "x" });
    const args = (lastRequest().params as { arguments: Record<string, unknown> }).arguments;
    expect(args).not.toHaveProperty("limit");
    expect(args).not.toHaveProperty("minScore");
  });

  it("rejects an empty query with a QmdError", async () => {
    const { client } = clientWith((req) => toolOk(req, []));
    await expect(client.searchMemory({ query: "   " })).rejects.toBeInstanceOf(QmdError);
  });

  it("throws QmdToolError on a JSON-RPC level error", async () => {
    const { client } = clientWith((req) => rpcError(req, "boom"));
    await expect(client.searchMemory({ query: "x" })).rejects.toBeInstanceOf(QmdToolError);
  });

  it("throws QmdToolError on an MCP tool-level isError", async () => {
    const { client } = clientWith((req) => toolErr(req, "bad searches"));
    await expect(client.searchMemory({ query: "x" })).rejects.toBeInstanceOf(QmdToolError);
  });

  it("propagates a daemon-down (QmdUnavailableError) without catching", async () => {
    const transport: JsonRpcTransport = async () => {
      throw new QmdUnavailableError("down");
    };
    const client = new QmdClient({ transport });
    await expect(client.searchMemory({ query: "x" })).rejects.toBeInstanceOf(QmdUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// getMemory
// ---------------------------------------------------------------------------

describe("QmdClient.getMemory", () => {
  it("calls the get tool with lineNumbers disabled and maps the resource", async () => {
    const { client, lastRequest } = clientWith((req) =>
      toolResource(req, {
        uri: "qmd://ams-test-vault/decisions/a.md",
        text: "<!-- Context: AMS memory notes -->\n\nbody text",
      }),
    );

    const doc = await client.getMemory({ file: "decisions/a.md" });

    expect(lastRequest().params).toEqual({
      name: "get",
      arguments: { file: "decisions/a.md", lineNumbers: false },
    });
    expect(doc).toEqual({ id: "", path: "decisions/a.md", body: "body text" });
  });

  it("accepts a docid as the file handle and echoes it as the id", async () => {
    const { client } = clientWith((req) => toolResource(req, { uri: "qmd://c/d.md", text: "b" }));
    const doc = await client.getMemory({ file: "#abc123" });
    expect(doc?.id).toBe("#abc123");
  });

  it("returns null when the document is not found (no resource content)", async () => {
    const { client } = clientWith((req) => toolOk(req, { error: "not found" }));
    expect(await client.getMemory({ file: "missing.md" })).toBeNull();
  });

  it("rejects an empty file with a QmdError", async () => {
    const { client } = clientWith((req) => toolOk(req, {}));
    await expect(client.getMemory({ file: "" })).rejects.toBeInstanceOf(QmdError);
  });
});

// ---------------------------------------------------------------------------
// isReachable
// ---------------------------------------------------------------------------

describe("QmdClient.isReachable", () => {
  it("returns true when the status tool answers", async () => {
    const { client } = clientWith((req) => toolOk(req, { collections: [] }));
    expect(await client.isReachable()).toBe(true);
  });

  it("returns false when the daemon is unreachable", async () => {
    const transport: JsonRpcTransport = async () => {
      throw new QmdUnavailableError("down");
    };
    expect(await new QmdClient({ transport }).isReachable()).toBe(false);
  });

  it("re-throws non-availability errors", async () => {
    const transport: JsonRpcTransport = async () => {
      throw new QmdToolError("tool failed");
    };
    await expect(new QmdClient({ transport }).isReachable()).rejects.toBeInstanceOf(QmdToolError);
  });
});

// ---------------------------------------------------------------------------
// request envelope
// ---------------------------------------------------------------------------

describe("QmdClient request envelope", () => {
  it("emits JSON-RPC 2.0 with sequential numeric ids", async () => {
    const seen: number[] = [];
    const { client } = clientWith((req) => {
      seen.push(req.id as number);
      return toolOk(req, []);
    });
    await client.searchMemory({ query: "a" });
    await client.searchMemory({ query: "b" });
    expect(seen).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// structuredContent preference (real QMD shape)
// ---------------------------------------------------------------------------

describe("QmdClient structuredContent", () => {
  it("prefers structuredContent over the human-readable text", async () => {
    const transport: JsonRpcTransport = async (req) => ({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        content: [{ type: "text", text: 'No results found for "memory"' }],
        structuredContent: { results: [{ docid: "#1", file: "qmd://c/a.md", score: 0.9 }] },
      },
    });
    const client = new QmdClient({ transport });
    const hits = await client.searchMemory({ query: "memory" });
    // structuredContent drove the mapping; the non-JSON text was ignored.
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("#1");
  });

  it("falls back to parsing text content when structuredContent is absent", async () => {
    const transport: JsonRpcTransport = async (req) => ({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        content: [
          { type: "text", text: JSON.stringify([{ docid: "#2", file: "a.md", score: 0.5 }]) },
        ],
      },
    });
    const client = new QmdClient({ transport });
    const hits = await client.searchMemory({ query: "memory" });
    expect(hits[0]?.id).toBe("#2");
  });
});
