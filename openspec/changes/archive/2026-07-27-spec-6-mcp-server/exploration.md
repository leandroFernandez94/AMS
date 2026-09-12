# Exploration: Spec 6 — MCP Server (Domain Tools)

## Current State

The AMS monorepo has three packages. `packages/shared` holds the generic Note
contract (Zod schemas, `buildNote`, `parseNote`, `serializeNote`). `packages/api`
contains the Write API (Hono `POST /notes` with lock-protected upsert + dirty
flagging) and the QMD retrieval adapter (`QmdClient` with `searchMemory` /
`getMemory` over MCP Streamable HTTP). `packages/mcp` is a **placeholder** — it
only re-exports `PACKAGE_NAME` from `@ams/shared` to validate workspace wiring.

Specs 1–5 are all done. The MCP server is the last piece of the tracer bullet:
it exposes three semantic tools (`record_note`, `search_memory`, `get_memory`)
that route agents to the Write API and QMD respectively, over stdio transport.

### Key surfaces the MCP server will consume

**Write API (`POST /notes`):**
- Request body (`NoteInputSchema`): `{ title, type, body, topic_key?, tags?, date? }`
- `date` defaults to today UTC when omitted.
- Success response: `{ id, path, created }` — HTTP 201 (new) or 200 (update).
- Error responses: `{ error: "invalid_body" | "validation_error" | "incoherent_note" | "internal_error", message?, issues? }` — HTTP 400 or 500.
- The Write API is a Hono app; `app.request(path, { method, body, headers })` works in tests.

**QMD adapter (`QmdClient` from `@ams/api`):**
- `searchMemory({ query, rerank?, limit?, minScore? })` → `MemoryHit[]` where `MemoryHit = { id, path, title, snippet, score }`.
- `getMemory({ file })` → `MemoryDoc | null` where `MemoryDoc = { id, path, body }`.
- `rerank` defaults to `false` (RRF-only); opt-in per query. Always forwarded explicitly.
- Constructor accepts `{ url?, transport?, timeoutMs? }` — fully injectable for tests.
- Error hierarchy: `QmdError` → `QmdUnavailableError` (daemon down), `QmdProtocolError` (malformed response), `QmdToolError` (tool-level error).
- Config: `AMS_QMD_URL` env var, default `http://localhost:8181`. `loadQmdConfig()` reads from env.

### MCP SDK (`@modelcontextprotocol/sdk` v1.29.0)

Latest stable. Zod dependency: `"zod": "^3.25 || ^4.0"` — compatible with the
project's `zod@^4.4.3`, no version conflict.

Key API patterns (v1.29.0):
- **Server + transport:**
  ```ts
  import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
  import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
  const server = new McpServer({ name: "ams", version: "0.0.0" });
  server.registerTool(name, { description, inputSchema: { ...zod... } }, handler);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  ```
- **Tool handler return shape:**
  ```ts
  { content: [{ type: "text", text: "..." }], isError?: boolean, structuredContent?: unknown }
  ```
- **Error handling:** return `{ content: [...], isError: true }` for tool-level
  errors (validation failures, upstream down). The SDK catches thrown errors and
  converts them to `isError: true` results automatically, but explicit handling
  gives better messages.
- **Testing:** `InMemoryTransport.createLinkedPair()` + `Client` from
  `@modelcontextprotocol/sdk/client/index.js`. Connect server to one end, client
  to the other. Then call `client.callTool({ name, arguments })` and assert on
  the result. No real stdio or network needed.

## Affected Areas

- `packages/mcp/src/index.ts` — replace placeholder with real server factory + tool registration + entry point.
- `packages/mcp/package.json` — add dependencies: `@modelcontextprotocol/sdk`, `@ams/api` (for `QmdClient`), `zod` (peer or direct); add `start` script.
- `packages/mcp/tsconfig.json` — add project reference to `../api` (for `QmdClient` import); add `"types": ["node"]`.
- `packages/mcp/tests/smoke.test.ts` — replace with real tool tests using `InMemoryTransport` + `Client`.
- `vitest.config.ts` — add alias for `@ams/api` → source (currently only `@ams/shared` is aliased).
- `packages/mcp/src/config.ts` (new) — env loading for `AMS_API_URL`, `AMS_QMD_URL`.

## Approaches

### 1. HTTP client for Write API + direct `QmdClient` import for retrieval

The MCP server calls the Write API over HTTP (`fetch POST /notes`) and imports
`QmdClient` directly from `@ams/api` for retrieval.

- Pros:
  - Matches the issue text exactly ("POST to Write API `/notes`", "Spec 4 adapter").
  - Write API and MCP server are separate processes with independent lifecycles — HTTP is the natural boundary.
  - `QmdClient` is already injectable, handles QMD session management, error classification, and result mapping — no reason to duplicate.
  - The MCP server stays thin: it validates input, forwards, and formats results.
- Cons:
  - `@ams/mcp` gains a runtime dependency on `@ams/api` (for `QmdClient`). This is a workspace dep, not a structural coupling — the QMD client is a standalone class.
  - Two communication patterns in one package (HTTP fetch for writes, direct class for reads). Justified by the architecture: the Write API is a long-running HTTP service; QMD retrieval is a client library.
- Effort: Low-Medium

### 2. HTTP client for both Write API and QMD

The MCP server calls the Write API over HTTP and the QMD daemon over HTTP
directly (bypassing `QmdClient`, reimplementing the JSON-RPC transport).

- Pros:
  - Single communication pattern (HTTP) — no workspace dep on `@ams/api`.
  - MCP package is fully decoupled from `@ams/api`.
- Cons:
  - Duplicates the QMD transport, session handshake, error classification, and result mapping that `QmdClient` already provides and tests.
  - Violates DRY and the "simplicity over speculation" principle — the adapter exists precisely so callers don't reimplement QMD's wire protocol.
  - The issue explicitly says "Spec 4 adapter" — reimplementing it contradicts the spec.
- Effort: Medium-High (reimplementation)

### 3. Direct import for both Write API and QMD

The MCP server imports `createApp` + collaborators from `@ams/api` and calls the
Hono app in-process, plus imports `QmdClient` directly.

- Pros:
  - No HTTP overhead for writes — in-process Hono `app.request()`.
  - Single process, no port management.
- Cons:
  - Contradicts the issue text ("POST to Write API `/notes`").
  - Couples the MCP server to the Write API's internal collaborators (`Vault`, `WriteLock`, `DirtyStore`, `Logger`) — the MCP server would need to construct all of them.
  - The Write API's background scheduler (Spec 5) would need to be managed by the MCP server process — wrong responsibility boundary.
  - Loses the deployment flexibility (Write API and MCP server as separate processes).
- Effort: Medium

## Recommendation

**Approach 1** — HTTP client for Write API + direct `QmdClient` import.

This matches the issue's intent precisely. The Write API is a standalone HTTP
service (Spec 3); the MCP server is a stdio process spawned by the agent host.
HTTP is the correct boundary between them. For retrieval, `QmdClient` is already
a clean, injectable, well-tested adapter (Spec 4) — importing it directly avoids
reimplementing QMD's session handshake and error classification.

### Concrete shape

**New files in `packages/mcp/src/`:**
- `config.ts` — loads `AMS_API_URL` (default `http://localhost:3000`) and `AMS_QMD_URL` (default `http://localhost:8181`) from env.
- `server.ts` — `createServer(deps?)` factory: creates `McpServer`, registers the three tools, returns it. Dependencies (Write API URL, `QmdClient` instance) are injected for testability.
- `tools/record-note.ts` — handler that `fetch` POSTs to `${AMS_API_URL}/notes` and maps the response to an MCP tool result.
- `tools/search-memory.ts` — handler that calls `qmdClient.searchMemory(...)` and maps hits to an MCP tool result.
- `tools/get-memory.ts` — handler that calls `qmdClient.getMemory(...)` and maps the doc to an MCP tool result.
- `index.ts` — re-exports `createServer`; thin entry point that loads config, builds deps, connects `StdioServerTransport`.

**Tool input schemas (Zod):**
- `record_note`: `{ title: z.string().min(1), type: z.string().min(1), body: z.string(), topic_key: z.string().optional(), tags: z.array(z.string()).optional() }`
- `search_memory`: `{ query: z.string().min(1), rerank: z.boolean().optional(), limit: z.number().int().positive().optional() }`
- `get_memory`: `{ file: z.string().min(1) }`

**Tool result formatting:**
- `record_note` → text: `"Created note: {path} (id: {id})"` or `"Updated note: {path}"`; `structuredContent: { id, path, created }`.
- `search_memory` → text: one line per hit (`[{score}] {title} ({path}) — {snippet}` with `id: {id}`); `structuredContent: MemoryHit[]`.
- `get_memory` → text: the document body (markdown); `structuredContent: MemoryDoc`.

**Error mapping:**
- Write API HTTP 4xx → `{ content: [{ type: "text", text: "Validation error: {issues}" }], isError: true }`.
- Write API HTTP 5xx or `fetch` failure → `{ content: [{ type: "text", text: "Write API unavailable: {message}" }], isError: true }`.
- `QmdUnavailableError` → `{ content: [{ type: "text", text: "QMD daemon unavailable: {message}" }], isError: true }`.
- `QmdToolError` / `QmdProtocolError` → `{ content: [{ type: "text", text: "QMD error: {message}" }], isError: true }`.
- Zod input validation is handled by the SDK (returns a protocol-level error to the client).

**Testing approach:**
- Use `InMemoryTransport.createLinkedPair()` + `Client` from the SDK.
- `createServer` accepts injectable deps: `{ apiUrl: string, qmdClient: QmdClient }` (or a `fetch` mock + `QmdClient` with fake transport).
- For `record_note` tests: point `apiUrl` at a fake Hono app or mock `fetch`.
- For `search_memory`/`get_memory` tests: inject a `QmdClient` with a fake `JsonRpcTransport` (same pattern as `qmd-client.test.ts` in `@ams/api`).
- Assert on both `content[0].text` (agent-readable) and `structuredContent` (programmatic).
- Assert `isError: true` on error paths.

## Risks

- **Zod version compatibility**: the project uses `zod@^4.4.3` and the SDK accepts `^3.25 || ^4.0`. Both resolve to zod 4.x — no conflict. But the SDK's `registerTool` inputSchema shape in v1.x accepts a raw Zod shape object (`{ key: z.string() }`), not `z.object(...)`. This is a minor API detail to get right during implementation.
- **`@ams/api` as workspace dependency**: adding it to `packages/mcp` means the MCP package's `tsconfig.json` needs a project reference to `../api`, and `vitest.config.ts` needs an `@ams/api` alias (currently only `@ams/shared` is aliased). Low risk but must not be forgotten.
- **Stdio logging**: the MCP server communicates over stdin/stdout. Any `console.log` or logger output to stdout would corrupt the JSON-RPC stream. Logging must go to stderr only (the SDK's `StdioServerTransport` handles this, but custom logging in tool handlers must be careful).
- **`fetch` availability**: Node 22 has global `fetch`. The project baseline is Node >= 22. No polyfill needed, but tool handlers should use `fetch` directly (not a framework).
- **Entry point vs factory**: the `start` script in `package.json` will run `node dist/server.js` (or similar). The factory (`createServer`) must be separate from the stdio connection so tests can use `InMemoryTransport` without spawning a process.

## Ready for Proposal

Yes. The exploration is complete — all dependencies are done, the SDK is stable
and compatible, and the architecture is clear. The orchestrator should tell the
user that Spec 6 is ready to proceed to proposal. The key decision to confirm:
**Approach 1** (HTTP for writes, direct `QmdClient` import for reads) — this
matches the issue text and avoids reimplementation.
