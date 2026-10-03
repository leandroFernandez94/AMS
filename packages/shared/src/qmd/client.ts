/**
 * QMD retrieval adapter — the AMS read path over the QMD daemon.
 *
 * This is the Spec 4 surface: two operations that translate AMS-level intent
 * into QMD MCP tool calls and map the answers back into AMS domain shapes.
 *
 *   searchMemory({ query, rerank?, limit?, minScore? }) -> MemoryHit[]
 *   getMemory({ file })                                  -> MemoryDoc | null
 *
 * Rerank policy (Spec 4 decision): the daemon's `query` tool defaults to
 * LLM reranking, but the AMS server has no GPU and reranking adds tens of
 * seconds per query on CPU with no measurable precision gain on the QMD
 * fixture. So `rerank` defaults to `false` here (RRF-only); callers opt in
 * per query. The value is always forwarded explicitly — never inherited from
 * the daemon — so behavior is deterministic regardless of daemon config.
 *
 * A plain `query` string is expanded into a `[lex, vec]` pair to get hybrid
 * BM25 + vector fusion via RRF without loading the query-expansion LLM. That
 * is the documented "hybrid without rerank" profile that already reaches full
 * precision on QMD's own benchmark.
 *
 * Wire format (validated against QMD 2.5): `query` answers with
 * `structuredContent.results`; `get` answers with a `resource` content item
 * whose `text` is the body and whose `uri` is the document path.
 */
import { isNonEmpty } from "../util.js";
import { DEFAULT_QMD_URL, loadQmdConfig } from "./config.js";
import { QmdError, QmdToolError, QmdUnavailableError } from "./errors.js";
import {
  createFetchTransport,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcTransport,
} from "./http.js";
import { mapDocument, mapSearchResults, type QmdResource } from "./mapping.js";

/** Input accepted by `searchMemory`. */
export interface SearchMemoryInput {
  /** Natural-language or keyword query. */
  query: string;
  /** Run LLM reranking (default `false` — RRF-only). */
  rerank?: boolean;
  /** Maximum number of hits returned. */
  limit?: number;
  /** Minimum relevance score in [0, 1]. */
  minScore?: number;
}

/** Input accepted by `getMemory`. */
export interface GetMemoryInput {
  /**
   * Retrieval handle. Prefer a QMD docid (`#abc123`) from a prior
   * `searchMemory` hit — a vault-relative path does NOT resolve in QMD's
   * `get`; the docid always does.
   */
  file: string;
}

/** Options for constructing a `QmdClient`. */
export interface QmdClientOptions {
  /** Daemon base URL. Defaults to `AMS_QMD_URL` / `http://localhost:8181`. */
  url?: string;
  /** Injectable transport; overrides `url` for unit tests. */
  transport?: JsonRpcTransport;
  /** Per-request timeout for the default fetch transport. */
  timeoutMs?: number;
}

/** Parsed MCP tool result envelope returned by `callTool`. */
interface McpToolResult {
  content: unknown[];
  structuredContent?: unknown;
}

/**
 * Client for the QMD retrieval daemon.
 *
 * Construct with a `transport` for fully deterministic tests, or with a
 * `url` (the default) to use the global `fetch`.
 */
export class QmdClient {
  private readonly transport: JsonRpcTransport;
  private seq = 0;

  constructor(opts: QmdClientOptions = {}) {
    const url = opts.url ?? loadQmdConfig().url;
    this.transport =
      opts.transport ?? createFetchTransport({ baseUrl: url, timeoutMs: opts.timeoutMs });
  }

  /** Searches the memory index, returning normalized AMS hits. */
  async searchMemory(input: SearchMemoryInput): Promise<ReturnType<typeof mapSearchResults>> {
    if (!isNonEmpty(input.query)) {
      throw new QmdError("searchMemory requires a non-empty query");
    }
    // Hybrid profile: lexical + vector sub-queries fused by RRF. The first
    // entry receives QMD's 2x weight bonus, so the user's verbatim query wins
    // ties against its semantic sibling.
    const args: Record<string, unknown> = {
      searches: [
        { type: "lex", query: input.query },
        { type: "vec", query: input.query },
      ],
      rerank: input.rerank ?? false,
    };
    if (input.limit !== undefined) args.limit = input.limit;
    if (input.minScore !== undefined) args.minScore = input.minScore;

    const result = await this.callTool("query", args);
    // `query` populates structuredContent with { results: [...] }; fall back to
    // parsing the text content for tools/servers that only emit text.
    const payload = result.structuredContent ?? parseContentJson(result.content);
    return mapSearchResults(payload);
  }

  /** Fetches a single document by docid (or full collection path). `null` if absent. */
  async getMemory(input: GetMemoryInput): Promise<ReturnType<typeof mapDocument>> {
    if (!isNonEmpty(input.file)) {
      throw new QmdError("getMemory requires a non-empty file");
    }
    // Line numbers are an agent-display concern; AMS wants clean body text so
    // the caller can re-parse it as markdown if needed.
    const result = await this.callTool("get", { file: input.file, lineNumbers: false });
    const resource = readResource(result.content);
    // `get` does not echo the docid; reuse the caller's handle when it is one.
    const id = input.file.startsWith("#") ? input.file : "";
    return mapDocument(resource, id);
  }

  /**
   * Whether the daemon is reachable. Calls the cheap `status` MCP tool; a
   * `QmdUnavailableError` resolves to `false` so callers can probe without a
   * try/catch. Any other error propagates.
   */
  async isReachable(): Promise<boolean> {
    try {
      await this.callTool("status", {});
      return true;
    } catch (e) {
      if (e instanceof QmdUnavailableError) return false;
      throw e;
    }
  }

  /** Sends a `tools/call` request and returns the parsed MCP result envelope. */
  private async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const id = ++this.seq;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    };
    const response: JsonRpcResponse = await this.transport(request);
    if (response.error) {
      throw new QmdToolError(
        `QMD '${name}' call failed (${response.error.code}): ${response.error.message}`,
      );
    }
    return toToolResult(response.result, name);
  }
}

/** Normalizes a JSON-RPC result into an MCP tool result envelope. */
function toToolResult(result: unknown, toolName: string): McpToolResult {
  if (!result || typeof result !== "object") return { content: [] };
  const obj = result as Record<string, unknown>;
  if (obj.isError === true) {
    throw new QmdToolError(
      `QMD '${toolName}' reported an error${readContentText(obj.content) ? `: ${readContentText(obj.content)}` : ""}`,
    );
  }
  return {
    content: Array.isArray(obj.content) ? obj.content : [],
    structuredContent: obj.structuredContent,
  };
}

/** The first `{ type: "resource" }` item's `{ uri, text }`, or `null`. */
function readResource(content: unknown): QmdResource | null {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (item && typeof item === "object" && (item as { type?: string }).type === "resource") {
      const resource = (item as { resource?: QmdResource }).resource;
      if (resource && typeof resource === "object") return resource;
    }
  }
  return null;
}

/** Joins every `{ type: "text" }` fragment of an MCP content array. */
function readContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: string; text: string } =>
        !!item && typeof item === "object" && (item as { type?: string }).type === "text",
    )
    .map((item) => item.text ?? "")
    .join("");
}

/** Parses the joined text content as JSON, or returns `null` when not JSON. */
function parseContentJson(content: unknown): unknown {
  const text = readContentText(content);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export { DEFAULT_QMD_URL };
