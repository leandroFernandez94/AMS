# Tasks: spec-6-mcp-server

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~520 (8 new src files ~280, 1 test file ~220, 3 config edits, index.ts rewrite) |
| New files | 8 |
| Modified files | 4 (packages/mcp/package.json, tsconfig.json, vitest.config.ts, src/index.ts) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Delivery strategy | size:exception (maintainer-approved single PR) |
| Chain strategy | N/A — single PR |

Decision needed before apply: Yes — resolved as `size:exception` by orchestrator.
Single PR approved; all phases implemented in one batch.

## Phase 1: Package Setup

- [x] 1.1 `packages/mcp/package.json`: add deps `@modelcontextprotocol/sdk@1.29.0`, `@ams/api@workspace:*`, `zod`; add `"bin": { "ams-mcp": "./dist/bin.js" }`
- [x] 1.2 `packages/mcp/tsconfig.json`: add reference `{ "path": "../api" }`, add `"types": ["node"]`
- [x] 1.3 `vitest.config.ts`: add `"@ams/api"` alias → `packages/api/src/index.ts`; run `pnpm install`

## Phase 2: Configuration, Errors & Factory

- [x] 2.1 `src/config.ts`: `getConfig()` reads `AMS_API_URL` (no default) and `AMS_QMD_URL` (default `http://localhost:8181`); lazy validation (errors only at call time)
- [x] 2.2 `src/errors.ts`: `toMcpError(text)`, `mapWriteApiError(res, body)`, `mapQmdError(err)`, `mapUnknownError(err)` per ADR-4 table; detail logged to `process.stderr` only
- [x] 2.3 `src/server.ts`: `createServer(deps?: ServerDeps)` — builds `McpServer`, constructs `QmdClient` from `AMS_QMD_URL` when not injected, registers the three tools; connects NO transport — Req: Server Factory and Transport

## Phase 3: Tool Handlers

- [x] 3.1 `src/tools/record-note.ts`: register `record_note` (LLM-picking description + raw Zod shape `title`/`type`/`body`, optional `topic_key`/`tags`/`date`); handler POSTs `${apiUrl}/notes` via `fetch`, maps 400 → validation / `!ok` → unavailable (ADR-4), returns `Note recorded: {id} at {path}` (or `Note updated` when `created:false`) — Req: record_note Persistence, Typed Input Schemas
- [x] 3.2 `src/tools/search-memory.ts`: register `search_memory` (raw Zod shape `query`, optional `rerank`/`limit`/`minScore`); handler calls `qmdClient.searchMemory` forwarding options, formats `[{score}] {title} ({path}) — {snippet} [{id}]`, empty → non-error `No results found: {query}` — Req: search_memory Retrieval
- [x] 3.3 `src/tools/get-memory.ts`: register `get_memory` (raw Zod shape `file`); description steers to QMD docid `#abc123`; handler calls `qmdClient.getMemory`, returns body or `Not found: {file}` with `isError: true` — Req: get_memory Retrieval

> NOTE: `registerTool` `inputSchema` takes a **raw Zod shape** (`{ key: z.type() }`),
> NOT `z.object({...})`. The SDK wraps the shape.

## Phase 4: Entry Point & Exports

- [x] 4.1 `src/bin.ts`: read env, call `createServer()`, connect `StdioServerTransport`; every diagnostic to stderr (ADR-3) — no `console.log`
- [x] 4.2 `src/index.ts`: replace placeholder; re-export `createServer` and `ServerDeps` type (drop `PACKAGE_NAME` re-export)

## Phase 5: Tests

- [x] 5.1 Delete `tests/smoke.test.ts`; create `tests/mcp-server.test.ts` with `InMemoryTransport.createLinkedPair()` + SDK `Client` harness; mock `QmdClient` (fake JSON-RPC transport) and `fetch` factories
- [x] 5.2 Catalog: `tools/list` returns exactly three tools, each non-empty description + typed schema — Scenario: Client lists the catalog
- [x] 5.3 `record_note`: happy path (mock `fetch`, assert POST body + 201 → success text); Write API 400 → validation `isError`; fetch rejects → `Write API unavailable`; missing field rejected pre-upstream — Scenarios: New note round-trip, Write API 500, Missing required field
- [x] 5.4 `search_memory`: happy path (injected `QmdClient`); `rerank: true` forwarded to `searchMemory`; empty `[]` → non-error; `QmdUnavailableError` → `isError` naming retrieval — Scenarios: Forwarded rerank flag, Empty result is not an error, QMD unavailable
- [x] 5.5 `get_memory`: found → body; `null` → `isError` not-found; `QmdUnavailableError` → `isError` — Scenarios: Document found, Document not found, QMD unavailable
- [x] 5.6 Stdout cleanliness: spy `process.stdout.write` during a tool call, assert only JSON-RPC frames (ADR-3); confirm server keeps running after any upstream failure — Req: Structured Error Mapping

## Phase 6: Verification

- [x] 6.1 Run `pnpm typecheck && pnpm test && pnpm check`; confirm all 12 spec scenarios green
- [x] 6.2 Verify issue #7 acceptance: three tools listed; `record_note` creates any `type`; `search_memory` readable; `rerank` forwarded; upstream down → structured MCP errors; process never crashes

## Phase 7: Post-Verify Remediation

- [x] 7.1 W-1: Map `fetch` network errors to `"Write API unavailable"` per ADR-4; update matching test expectation
- [x] 7.2 W-2: Add malformed Write API payload guard test
- [x] 7.3 S-1: Align `@ams/mcp` zod version with workspace (`^4.4.3`) and verify SDK types still pass
- [x] 7.4 S-2: Add `test-vault/` to `.gitignore`
