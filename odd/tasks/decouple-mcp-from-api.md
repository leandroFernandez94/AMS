# Feature: Decouple packages/mcp from packages/api (issue #40)

## Objective

`@ams/mcp` depends only on `@ams/shared`. Clients (`QmdClient`, `WriteApiClient`),
error classes and the `Logger` contract live in `@ams/shared`. Response contracts
are parsed by API and MCP from the same zod schemas. Lands BEFORE #37 (HTTP transport).

## Problem / Why

Write tools do raw `fetch` with per-tool parsing and hand-rolled guards;
`UpsertResult` is re-declared in `record-note.ts`; `packages/mcp` imports the
server package (`@ams/api`). #37 turns MCP into a long-lived service — we need
one choke point for timeout/retry policy before the second transport lands.

## Scope

- IN: P1 (`WriteApiClient`), P2 (response contracts to shared), P3 (dependency inversion).
- OUT: transport changes (#37), auth (#39), behavior changes (except the documented
  validation-issue drift fix below).

## Constraints

- Tool output strings and error messages stay byte-identical where possible.
- `list_tags` keeps its current asymmetry (no request-id header, no logger).
- Lazy client construction must survive (server starts with QMD down).
- English only in all artifacts (repo policy). Conventional Commits. `Closes #40`.

## Task list

- [x] T1 — Shared response contracts (P2). DONE 720e2d9: `api-contracts.ts` created
  (DeleteResponse.note typed precisely via composed FrontmatterSchema, `z.literal(true)`
  for deleted); TagCount moved to shared as canonical; api barrel re-exports shared
  types; vault UpsertResult untouched (notes.test.ts uses it as vault shape — no
  collision). Checks: typecheck/test/check green (224 passed), assess=medium,
  writer self-verified + parent spot check. Route: delegated writer.
- [x] T2 — `WriteApiClient` (P1). DONE 9635fda: `shared/src/write-api/{client,errors}.ts`
  + 18 unit tests (fake fetch). RecordNoteInput = exact 7-field tool payload;
  WriteApiLogger structurally = real Logger subset (T4 swap trivial); guard at
  request time (WriteApiConfigError); timeout choke point send() 30s default;
  legacy validation rendering preserved byte-identical (message-only, since real
  API never sent `path`); shared gained @types/node devDep + tsconfig types:["node"];
  vitest include already covered shared/tests. Checks: typecheck/test/check green
  (242 passed), assess=medium, writer self-verified + parent spot check (tests rerun,
  content-type/header + Logger signature claims verified against source).
  Route: delegated writer.
- [x] T3 — Migrate the four write tools to the client (P1). DONE 1f4999c:
  tools call lazy `resolveWriteApiClient` (new src/write-api.ts); errors.ts swaps
  the three write mappers for `mapWriteApiClientError`; ServerDeps: fetch→writeApiClient;
  tests inject client interface, correlation asserted at client seam, list_tags
  no-request-id pinned. Empty-URL/unexpected-payload branches keep isError:true
  (code reality — brief premise was wrong, verified vs source). Documented correction:
  validation mocks now use real {field, message} shape. mcp/src has ZERO raw
  fetch/parseJson/guards (grep-verified). Checks: typecheck/test/check green
  (243 passed), assess=medium, writer self-verified + parent spot check (tests rerun,
  record-note.ts read, grep clean). e2e not run (tracer scope, T5). Route: delegated writer.
- [x] T4 — Dependency inversion (P3). DONE 69e8381: qmd/{client,config,errors,
  http,mapping}.ts + logger.ts moved to shared via git mv (100% renames — real diff
  ~190 lines); api barrel re-exports moved surface name-identically (e2e/fixtures
  unchanged); qmd tests moved to shared/tests; api/src/qmd/index.ts sub-barrel
  deleted; mcp: all imports → @ams/shared, dep + tsconfig reference dropped,
  config sources QMD defaults from shared. Valid writer deviation: moved client.ts
  imports isNonEmpty relatively (../util.js) — self-package import resolves through
  stale symlink dist on clean builds. Checks: typecheck/test/check green (243),
  assess=medium, parent spot check (grep @ams/api empty in mcp, tests rerun,
  config.ts readback). Route: delegated writer.
- [x] T5 — Full verification + PR. DONE: typecheck/test/check green; e2e tracer
  13/13 PASSED (qmd 2.5.3) — log shows tool:invoke → write-api:request:done with
  matching requestId → 201 (correlation survives the real stack). Single PR with
  maintainer-approved size:exception. Route: inline + delegated per-action.

## TDD mode

Off (no strict TDD configured for this project; source: engram search + repo config).
Runner: `pnpm test` (Vitest). Ordinary functional checks per task.

## Delivery

Delivery (decided 2026-10-03): SINGLE PR with maintainer-approved `size:exception`
(user chose it over chained PRs; forecast ~1600 lines, ~half is mechanical moves).
No chain strategy needed.

## Acceptance criteria (from issue #40) — ALL VERIFIED

1. [x] `packages/mcp` has no import from `@ams/api` (grep empty, dependency on
   `@ams/shared` only, tsconfig reference dropped).
2. [x] Write tools use `WriteApiClient`; no raw `fetch` outside the client (grep
   for fetch/parseJson/guards in mcp/src: empty).
3. [x] Response contracts live in `@ams/shared` with zod schemas, consumed by
   both API (typing) and MCP (client parsing).
4. [x] `pnpm typecheck && pnpm test && pnpm check` green (243 passed | 4 skipped);
   tool tests inject the client interface; e2e tracer 13/13.

## Known risks

- Two `UpsertResult` concepts share a name (api vault internal vs wire shape) —
  shared type is the WIRE shape, named `UpsertResponse` to avoid the collision.
- Byte-identical strings asserted in `mcp-server.test.ts` and e2e regexes
  (`Note recorded: ...`, `Write API unavailable`, `AMS_API_URL is not configured`,
  note_exists guidance block, `Note not found: ...` 404 special case).
- `x-request-id` ↔ logged requestId correlation is asserted; client must thread it.
- Root vitest config must pick up `packages/shared/tests/` — verify in T2.

## Progress log

- 2026-10-03: exploration complete (coupling map in session context). Branch
  `refactor/decouple-mcp-from-api` from `origin/main`. RDD off, no strict TDD.
- 2026-10-03: T1 720e2d9 → T2 9635fda → T3 1f4999c → T4 69e8381. Delivery decided:
  single PR + size:exception. All acceptance criteria verified; e2e tracer 13/13.
  Engram mirror pending (session-ambiguity error on mem_save — retried at close).

## Next step

- Create PR (`Closes #40`), then unblock #37 (HTTP transport) on the decoupled base.
