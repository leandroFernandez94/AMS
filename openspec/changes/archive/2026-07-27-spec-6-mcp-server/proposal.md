# Proposal: Spec 6 — MCP Server (Domain Tools)

## Intent

Agents must not write files or call QMD directly. This change implements
`packages/mcp` — the final tracer-bullet piece — exposing three semantic tools
over stdio as the single abstraction layer above the Write API and QMD.

## Scope

### In Scope

- `createServer(deps?)` factory using `@modelcontextprotocol/sdk` v1.29.0
- Three tools: typed Zod schemas + LLM-picking descriptions
- `record_note` → HTTP `POST` to Write API `/notes` (global `fetch`)
- `search_memory` / `get_memory` → direct `QmdClient` import from `@ams/api`
- Upstream failures → structured `isError: true` results
- stdio entry point separate from factory; env: `AMS_API_URL`, `AMS_QMD_URL`
- In-memory transport tests

### Out of Scope

- HTTP/SSE MCP transport; auth; tool-level caching; in-process Write API calls

## Capabilities

> `openspec/specs/` is empty — no existing capabilities to modify.

### New Capabilities

- `mcp-domain-tools`: Semantic MCP tools exposing AMS write/retrieval surfaces
  to AI agents over stdio, with typed schemas, agent-readable formatting, and
  structured error mapping.

### Modified Capabilities

None.

## Approach

**Approach 1 from exploration** — HTTP `fetch` for writes, direct `QmdClient`
import for reads. Write API is a standalone HTTP service; MCP server is a stdio
process — HTTP is the correct boundary. `QmdClient` (Spec 4) is injectable and
tested; importing it avoids reimplementing QMD's session handshake and error
hierarchy. `createServer(deps?)` registers tools and returns a server; the
stdio entry connects `StdioServerTransport`. Separation lets tests wire
`InMemoryTransport` without spawning a process.

## Affected Areas

| Area | Impact |
|------|--------|
| `packages/mcp/src/{index,server,config}.ts` | Modified / New |
| `packages/mcp/src/tools/{record-note,search-memory,get-memory}.ts` | New |
| `packages/mcp/{package.json,tsconfig.json}` | Modified (deps + api ref) |
| `vitest.config.ts` | Modified (`@ams/api` alias) |
| `packages/mcp/tests/*.ts` | Modified (in-memory transport tests) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| SDK `registerTool` takes raw Zod shape, not `z.object()` | Medium | Design pins exact shape |
| stdout logging corrupts JSON-RPC stream | Medium | All logging to stderr |
| `@ams/api` workspace dep breaks vitest alias | Low | Add alias + tsconfig ref |
| Forecast exceeds 400-line budget | Low-Med | `ask-always` pauses if exceeded |

## Rollback Plan

`packages/mcp` is a non-functional placeholder. `git checkout main --
packages/mcp vitest.config.ts`. No data migration — server is stateless;
flows through existing APIs that remain unchanged.

## Dependencies

- `@modelcontextprotocol/sdk@1.29.0` (Zod-compatible with `zod@^4.4.3`)
- `@ams/api` workspace (`QmdClient`, error hierarchy)
- Write API (Spec 3), QMD daemon (Spec 4), Node >= 22 — all done

## Success Criteria

- [ ] MCP client lists the three tools over stdio
- [ ] `record_note` creates a note end-to-end, any `type`
- [ ] `search_memory` returns agent-readable QMD results
- [ ] `rerank` forwarded when caller sets it
- [ ] Descriptions explicit enough for LLM to pick without examples
- [ ] Upstream down → structured MCP errors
- [ ] `pnpm typecheck && pnpm test && pnpm check` pass
