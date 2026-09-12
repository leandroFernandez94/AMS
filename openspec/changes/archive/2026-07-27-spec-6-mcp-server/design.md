# Design: spec-6-mcp-server

## Overview

`packages/mcp` is the last tracer-bullet piece — a thin stdio MCP server that
exposes three semantic tools (`record_note`, `search_memory`, `get_memory`) as
the single abstraction layer above the Write API and QMD. Agents never touch
the filesystem or the QMD daemon directly: writes flow over HTTP to the Write
API (`POST /notes`), reads delegate to an injected `QmdClient` from `@ams/api`.

The server is deliberately thin — it validates input, forwards, formats
results, and maps upstream failures into structured MCP errors. All business
logic (lock-protected upsert, dirty flagging, QMD session handshake, error
classification) already lives in `@ams/api` and is reused, not reimplemented.

## Architecture Decision Records

### ADR-1: HTTP `fetch` for writes, direct `QmdClient` import for reads

**Choice.** `record_note` uses the global `fetch` to `POST` to the Write API
over HTTP. `search_memory` / `get_memory` import and call `QmdClient` from
`@ams/api` directly.

**Alternatives considered.**
- HTTP for both (reimplement QMD's JSON-RPC transport in the MCP package).
- In-process Hono for writes (import `createApp`, skip HTTP).

**Rationale.** The Write API is a long-running HTTP service with its own
lifecycle, background scheduler (Spec 5), and lock state — HTTP is the correct
process boundary and matches the issue text. `QmdClient` (Spec 4) is already an
injectable, tested adapter that owns QMD's session handshake, result mapping,
and error hierarchy (`QmdUnavailableError` / `QmdProtocolError` /
`QmdToolError`). Reimplementing it would violate DRY and the project's
"simplicity over speculation" rule.

**Consequences.** `@ams/mcp` gains a workspace runtime dependency on `@ams/api`
(for `QmdClient` and its error classes); the Write API must be reachable for
`record_note` to work. The `tsconfig.json` needs a project reference to
`../api` and `vitest.config.ts` needs an `@ams/api` alias (currently only
`@ams/shared` is aliased).

### ADR-2: `createServer(deps?)` factory separate from stdio entry

**Choice.** Export a `createServer(deps?)` factory that registers tools and
returns a configured `McpServer` **without** connecting any transport. A
separate `bin.ts` entry reads env, calls `createServer()`, and connects a
`StdioServerTransport`.

**Alternatives considered.** Single `start()` that builds + connects stdio
inline; tests would need to spawn a process.

**Rationale.** Tests must drive the same factory over `InMemoryTransport` with
injected fakes (no real stdio, no real I/O). Decoupling construction from
transport connection makes that possible and keeps production entry trivial.

**Consequences.** Two export surfaces — the factory (public, testable) and the
executable entry (private, thin).

### ADR-3: All logging to stderr

**Choice.** Every log/diagnostic line goes to `process.stderr` (or a
stderr-backed logger). `console.log` / any stdout write is a defect.

**Rationale.** The stdio transport encodes JSON-RPC on stdout; any stray byte
stream corrupts the protocol and breaks the agent connection. This is a
hard MCP protocol requirement, captured as a scenario in the spec.

**Consequences.** Tool handlers and `bin.ts` must use a stderr-only logger. A
lint rule or review check should guard against `console.log`.

### ADR-4: Structured error mapping — never crash the process

**Choice.** Every tool handler wraps its upstream call in `try/catch` and maps
failures to `{ content: [{ type: "text", text }], isError: true }`. The server
process must survive any upstream failure.

**Error map:**

| Source | Detection | Agent-facing message |
|--------|-----------|----------------------|
| Write API 400 | `response.status === 400` | `Validation error: {issues}` (include `issues[]`) |
| Write API 5xx / network | `!response.ok` / `fetch` throws | `Write API unavailable: {status}` |
| `QmdUnavailableError` | `instanceof` | `QMD retrieval unavailable: {message}` |
| `QmdProtocolError` / `QmdToolError` | `instanceof` | `QMD error: {message}` |
| Unknown | catch-all | `Internal error` (full detail logged to stderr) |

**Rationale.** Agents need deterministic, readable failure signals; an MCP
server that crashes the host process on a transient outage is unusable.

## Sequence Diagrams

### record_note

```
Agent            MCP Server              Write API
  │  tools/call   │                        │
  │  record_note  │                        │
  │──────────────▶│                        │
  │               │  POST /notes           │
  │               │  {title,type,body,...} │
  │               │───────────────────────▶│
  │               │                        │ acquire lock, validate,
  │               │                        │ upsert .md, mark dirty
  │               │  201 {id,path,created} │
  │               │◀───────────────────────│
  │  result       │                        │
  │  "Note        │                        │
  │   recorded:   │                        │
  │   {id} @path" │                        │
  │◀──────────────│                        │
```

### search_memory

```
Agent            MCP Server              QmdClient              QMD daemon
  │  tools/call   │                        │                       │
  │  search_memory│                        │                       │
  │  {query,...}  │                        │                       │
  │──────────────▶│                        │                       │
  │               │ searchMemory({query,   │                       │
  │               │  rerank,limit,...})    │                       │
  │               │───────────────────────▶│                       │
  │               │                        │ tools/call "query"    │
  │               │                        │──────────────────────▶│
  │               │                        │  structuredContent    │
  │               │                        │◀──────────────────────│
  │               │  MemoryHit[]           │                       │
  │               │◀───────────────────────│                       │
  │  result       │                        │                       │
  │  "[.9] title  │                        │                       │
  │   (path)" x N │                        │                       │
  │◀──────────────│                        │                       │
```

### get_memory

```
Agent            MCP Server              QmdClient              QMD daemon
  │  tools/call   │                        │                       │
  │  get_memory   │                        │                       │
  │  {file}       │                        │                       │
  │──────────────▶│                        │                       │
  │               │ getMemory({file})      │                       │
  │               │───────────────────────▶│                       │
  │               │                        │ tools/call "get"      │
  │               │                        │──────────────────────▶│
  │               │                        │  resource{text}       │
  │               │                        │◀──────────────────────│
  │               │  MemoryDoc | null      │                       │
  │               │◀───────────────────────│                       │
  │  result:      │                        │                       │
  │   body md     │  (or isError: true     │                       │
  │               │   if null)             │                       │
  │◀──────────────│                        │                       │
```

## Tool Definitions

### registerTool Zod Shape

**CRITICAL:** `inputSchema` takes a **raw Zod shape** — individual `{ key: z.type() }`
properties — NOT a `z.object({...})`. The SDK wraps the shape itself. Passing
`z.object(...)` produces a malformed schema.

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

server.registerTool(
  "record_note",
  {
    description:
      "Record a note in the AMS memory vault. Accepts any type " +
      "(decision, learning, pattern, note, ...). The body is free-form markdown.",
    inputSchema: {
      title: z.string().min(1).describe("Short, searchable title"),
      type: z
        .string()
        .min(1)
        .describe("Note type: decision, learning, pattern, note, ..."),
      body: z.string().describe("Free-form markdown body"),
      topic_key: z
        .string()
        .min(1)
        .optional()
        .describe("Stable key for topic upserts (same key updates the same note)"),
      tags: z.array(z.string().min(1)).optional().describe("Tags for categorization"),
      date: z
        .string()
        .optional()
        .describe("ISO date YYYY-MM-DD; defaults to today UTC"),
    },
  },
  async ({ parsedInput }) => {
    // handler returns { content, isError? }
  },
);
```

The handler receives `{ parsedInput, rawInput }`. `parsedInput` is already typed
by the Zod shape. Return `{ content: [{ type: "text", text }], isError?: true }`.

### record_note

- **Purpose:** persist a note via the Write API.
- **Handler logic:**
  1. Read `apiUrl` from deps/env (lazy — error if unset at call time).
  2. `fetch(`${apiUrl}/notes`, { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(parsedInput) })`.
  3. Parse JSON. On `!ok`, map per ADR-4 (400 → validation issues; else unavailable).
  4. On success return `"Note recorded: {id} at {path}"` (or `"Updated"` when `created === false`).

### search_memory

- **Purpose:** delegate to `QmdClient.searchMemory()`, forwarding `rerank`, `limit`, `minScore`.
- **Handler logic:**
  1. Resolve `qmdClient` from deps (injected) or construct lazily from `AMS_QMD_URL`.
  2. `const hits = await qmdClient.searchMemory({ query, rerank, limit, minScore })`.
  3. Catch `QmdError` subclasses → structured MCP error (ADR-4).
  4. Format hits: one line each `[{score}] {title} ({path}) — {snippet} [{id}]`. Empty → `"No results found for: {query}"` (not an error).

### get_memory

- **Purpose:** delegate to `QmdClient.getMemory({ file })`.
- **Handler logic:**
  1. Resolve `qmdClient` (same as search).
  2. `const doc = await qmdClient.getMemory({ file })`.
  3. Catch `QmdError` → structured MCP error.
  4. `doc` present → return `doc.body` as text. `null` → return `{ content: [{type:"text", text: "Not found: {file}"}], isError: true }`.

## File Structure

```
packages/mcp/src/
├── index.ts              # re-exports public API (createServer, types)
├── server.ts             # createServer(deps?) — registers all tools, returns McpServer
├── config.ts             # env-based config (AMS_API_URL, AMS_QMD_URL), lazy validation
├── errors.ts             # error → MCP result mapping helpers (toMcpError)
├── tools/
│   ├── record-note.ts    # record_note registration + handler
│   ├── search-memory.ts  # search_memory registration + handler
│   └── get-memory.ts     # get_memory registration + handler
└── bin.ts                # stdio entry — reads env, createServer(), connect StdioServerTransport
```

**Rationale — one file per tool.** The tool's `description` is its core semantic
value (what an LLM reads to decide whether to call it). Co-locating description,
schema, and handler in one file keeps each tool independently readable and
reviewable. `server.ts` imports each tool module and registers it; `errors.ts`
centralizes the ADR-4 map so handlers stay short.

## createServer Injection Contract

```typescript
import type { QmdClient } from "@ams/api";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Injectable collaborators. All optional — production resolves from env. */
export interface ServerDeps {
  /** Write API base URL. Defaults to env AMS_API_URL. Required for record_note. */
  apiUrl?: string;
  /** QMD client. When omitted, built lazily from AMS_QMD_URL on first read. */
  qmdClient?: QmdClient;
}

/**
 * Builds a configured McpServer with all three tools registered.
 * Does NOT connect a transport — callers (bin.ts or tests) own that.
 */
export function createServer(deps?: ServerDeps): McpServer;
```

**Production (`bin.ts`):** `createServer()` with no args → reads env at call
time. **Tests:** inject `{ qmdClient: new QmdClient({ transport: fakeTransport }) }`
and a mock `apiUrl` (or `fetch` mock) — no real I/O.

## Configuration

| Env var | Purpose | Default | Validation |
|---------|---------|---------|------------|
| `AMS_API_URL` | Write API base URL (e.g. `http://localhost:3000`) | none | Lazy: `record_note` errors at call time if unset/empty |
| `AMS_QMD_URL` | QMD daemon URL (e.g. `http://localhost:8181`) | `http://localhost:8181` | Read in `config.ts`; used to build `QmdClient` when not injected |

**Lazy validation rationale.** Env is resolved at tool-call time, not at server
startup. The server must start even if one upstream is down — agents can still
use the other tools (e.g. search while write is down). A missing `AMS_API_URL`
only fails when `record_note` is actually invoked.

## Result Formatting

| Tool | Success text | Empty / not-found |
|------|-------------|-------------------|
| `record_note` | `Note recorded: {id} at {path}` (new) / `Note updated: {id} at {path}` (`created:false`) | — |
| `search_memory` | One line per hit: `[{score}] {title} ({path}) — {snippet} [{id}]` | `No results found for: {query}` (non-error) |
| `get_memory` | Full markdown body | `Not found: {file}` with `isError: true` |

All results are `{ content: [{ type: "text", text }] }`. Errors add `isError: true`.

## Testing Strategy

| Layer | What | How |
|-------|------|-----|
| Unit | Error mapping (`errors.ts`) | Direct calls with fake errors → assert MCP result shape |
| Integration | Tool end-to-end over MCP | `InMemoryTransport.createLinkedPair()` + SDK `Client`; call `client.callTool({name, arguments})` |
| `record_note` | HTTP flow | Inject mock `apiUrl` + `fetch` mock (or tiny Hono fake); assert request body + status mapping |
| `search_memory` / `get_memory` | QMD flow | Inject `new QmdClient({ transport: fakeJsonRpc })` (same pattern as `qmd-client.test.ts` in `@ams/api`) |
| Error paths | ADR-4 coverage | Force 400, 5xx, `QmdUnavailableError`, `QmdToolError`; assert `isError: true` + message; assert server keeps running |
| Stdout cleanliness | ADR-3 | Spy on `process.stdout.write` during a tool call; assert zero non-JSON-RPC writes |

Tests assert on `result.content[0].text` (agent-readable) and `isError`.

## Risks

Carried forward from the proposal, with current status:

| Risk | Likelihood | Mitigation (this design) |
|------|-----------|--------------------------|
| `registerTool` takes raw Zod shape, not `z.object()` | Medium → **Resolved** | ADR + code example pin the exact `{ key: z.type() }` shape |
| stdout logging corrupts JSON-RPC | Medium | ADR-3 + stderr-only logger + test that spies on stdout |
| `@ams/api` workspace dep breaks vitest alias | Low | Add `@ams/api` alias to `vitest.config.ts`; add tsconfig project ref |
| `AMS_API_URL` unset at startup | Low | Lazy validation (config section) — server starts, fails only at `record_note` call |
| SDK version drift (`@modelcontextprotocol/sdk` minor bumps) | Low | Pin `1.29.0` in `package.json`; handler return shape is stable |

## Open Questions

None. All decisions are resolved; the design is ready for task breakdown.
