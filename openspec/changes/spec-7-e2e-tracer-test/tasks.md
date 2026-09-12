# Tasks: spec-7-e2e-tracer-test

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~380 (5 new files ~340, 1 new config ~15, 1 root edit ~5, 1 runbook ~60) |
| New files | 7 (`e2e/precheck.mjs`, `e2e/fixtures/vault.ts`, `e2e/tracer.test.ts`, `e2e/failure-modes.test.ts`, `vitest.tracer.config.ts`, `docs/tracer-runbook.md`, vitest.tracer.config.ts) |
| Modified files | 1 (`package.json`) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Delivery strategy | single-pr |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Low

**Typecheck note:** Root `tsconfig.json` references only `packages/*`. The `e2e/` directory is outside the tsc build graph by design (repo convention: test trees excluded from `tsc --build`). Therefore `pnpm typecheck` does NOT cover `e2e/` files. Biome (`pnpm check`) lints the entire repo including `e2e/`. The gate for `e2e/` type safety is `pnpm tracer` which runs the suite under vitest with its own config (vitest performs type-aware resolution via the alias config). Verification command per phase: `pnpm check && pnpm tracer`.

## Phase 1: Scaffold (infrastructure — no code depends on this yet, but everything else depends on it)

- [x] 1.1 Create `vitest.tracer.config.ts` with `defineConfig`: `resolve.alias` redeclaring all three workspace aliases (`@ams/api`, `@ams/shared`, `@ams/mcp`) pointing to source; `test.include: ["e2e/**/*.test.ts"]`, `environment: "node"`, `testTimeout: 180_000`, `hookTimeout: 60_000`. Covers Scenario: Default suite untouched (separate config means `pnpm test` never collects `e2e/`).
- [x] 1.2 Create `e2e/precheck.mjs`: import `execFile` from `node:child_process`; run `qmd --version`; on error print to stderr `"Missing prerequisite: 'qmd' is not on PATH — install with npm i -g @tobilu/qmd, see docs/tracer-runbook.md"` and `process.exit(1)`. Covers Scenario: Missing qmd binary.
- [x] 1.3 Modify root `package.json`: add `"tracer": "node e2e/precheck.mjs && vitest run --config vitest.tracer.config.ts"` to scripts; add `"@hono/node-server": "^2.0.6"` to devDependencies. Run `pnpm install`.
- [x] 1.4 Verify: `node e2e/precheck.mjs` succeeds when qmd is on PATH (exits 0); `pnpm test` still passes unchanged (e2e/ not collected). Covers Scenario: Tracer run on a prepared machine, Scenario: Default suite untouched.

## Phase 2: Fixture Builder (the heart of isolation — every test depends on this)

- [x] 2.1 Create `e2e/fixtures/vault.ts` — `freePort()` helper: `net.createServer().listen(0, "127.0.0.1")` → read `address().port` → `close()` → return port. Used by daemon boot and port-taken test.
- [x] 2.2 `e2e/fixtures/vault.ts` — `startQmdDaemon(cwd, nextPort?)`: call `nextPort()` (default `freePort()`), spawn `qmd mcp --http --port <p>` with `cwd`, collect stderr, detect premature exit (EADDRINUSE) and retry with fresh port (max 3 attempts). Return `{ child, port, url }`. Covers Scenario: Chosen daemon port is taken (ADR-3 retry logic).
- [x] 2.3 `e2e/fixtures/vault.ts` — `createIsolationCanary()`: snapshot `stat` of `~/.cache/qmd/index.sqlite` (mtimeMs + size, null if absent), existence of `<repoRoot>/.qmd`, set of `.qmd` entries under `os.tmpdir()`. Return `{ assertUnchanged() }` that re-inspects and throws on any delta. Covers Scenario: Isolation canary.
- [x] 2.4 `e2e/fixtures/vault.ts` — `createTracerFixture()`: `mkdtemp` → `mkdir vault` → `execFile("qmd", ["init"], { cwd })` → `execFile("qmd", ["collection", "add", vaultPath, "--name", "ams"], { cwd })` → compose `AppDeps` manually (Vault, WriteLock, DirtyStore at `<vault>/.ams/dirty.json`, silent logger, IndexScheduler with `enabled: false`, CliReindexer with cwd-scoped `execFile` runner) → `serve({ fetch: app.fetch, port: 0 })` → `startQmdDaemon(root)` + readiness poll (`QmdClient#isReachable()`, 250ms interval, 1.5x backoff, 15s cap) → `new QmdClient({ url })` → `createServer({ apiUrl, qmdClient })` + `InMemoryTransport.createLinkedPair()` + SDK `Client`. Return `TracerFixture` interface.
- [x] 2.5 `e2e/fixtures/vault.ts` — `teardown()`: `mcp.close()` → `httpServer.close()` → `child.kill("SIGTERM")` + await exit (5s timeout, escalate SIGKILL) → `rm(root, { recursive: true, force: true })`. Idempotent. Covers Scenario: Teardown.
- [x] 2.6 Verify: `pnpm check` passes (biome lint/format on `e2e/fixtures/vault.ts`); manual smoke — import `createTracerFixture` in a throwaway script, confirm it boots and tears down cleanly.

## Phase 3: Happy-Path Test (loop proof + lifecycle + isolation)

- [x] 3.1 Create `e2e/tracer.test.ts` — `describe("happy-path loop")`: `beforeAll` calls `createTracerFixture()`, `afterAll` calls `fx.teardown()`. Test: `record_note` via `fx.mcp` with `{ title, type: "note", body }` → assert response text matches `/Note recorded: .+ at .+/` and `isError` is false. Covers Scenario: Happy-path loop (write path).
- [x] 3.2 `describe("happy-path loop")` continued: assert the returned path exists on disk (`fs.existsSync`), read the file, use `parseNote` to verify title and body round-trip the recorded input. Covers Scenario: Note content and path on disk.
- [x] 3.3 `describe("happy-path loop")` continued: call `fx.reindex()` → assert `status === "ok"` and `indexed >= 1`. Then `search_memory` with a query matching the note body → assert response text contains the vault-relative path and a `[#docid]` marker. Covers Scenario: Happy-path loop (reindex + retrieval).
- [x] 3.4 `describe("lifecycle and readiness")`: the fixture boot itself proves Scenario: Successful boot (both ports known, readiness polling succeeded within timeout). Add a test that asserts `fx.apiUrl` and `fx.qmdUrl` are non-empty strings and the MCP client is connected.
- [x] 3.5 `describe("lifecycle and readiness")` — port-taken scenario: bind a `net.createServer().listen(P)`, call `startQmdDaemon(root, async () => occupiedPort)` where `occupiedPort` is P, assert the returned `port !== P` and `QmdClient#isReachable()` succeeds on the returned URL. Tear down the occupying server and the daemon. Covers Scenario: Chosen daemon port is taken.
- [x] 3.6 `describe("isolation")`: `createIsolationCanary()` before fixture, run the full loop, call `canary.assertUnchanged()` → no `.qmd` artifacts outside the fixture. Positive control: `fs.existsSync(path.join(fx.root, ".qmd", "index.sqlite"))` is true. Covers Scenario: Isolation canary.
- [x] 3.7 Verify: `pnpm tracer` runs and all tests in `e2e/tracer.test.ts` pass (requires qmd on PATH).

## Phase 4: Failure Modes (adversarial assertions)

- [x] 4.1 Create `e2e/failure-modes.test.ts` — `describe("lock contention")`: `beforeAll` boots a fixture, `afterAll` tears down. Test: `Promise.all` of two `fx.mcp.callTool("record_note", { title: "same", type: "note", body: "same" })` → assert exactly one response matches `/Note recorded:/` and exactly one matches `/Note updated:/`, neither has `isError: true`, exactly one file on disk for that note. Covers Scenario: Concurrent same-note writes serialize (FIFO).
- [x] 4.2 `describe("qmd down")`: build a throwaway MCP server with `new QmdClient({ url: "http://127.0.0.1:<deadPort>" })` (port from `freePort()`, never bound) + same `apiUrl`. Call `search_memory` → assert `isError === true` and text contains `QMD retrieval unavailable`. Follow-up: `record_note` on the same throwaway server succeeds → proves "MCP server keeps running". Covers Scenario: QMD down.
- [x] 4.3 Verify: `pnpm tracer` runs and all tests in `e2e/failure-modes.test.ts` pass.

## Phase 5: Runbook (documentation)

- [x] 5.1 Create `docs/tracer-runbook.md`: section 1 — Prerequisites (Node ≥ 22, `npm i -g @tobilu/qmd`, `qmd --version` ≥ 2.5.3). Section 2 — First-run cost (embedding model ~300 MB download, ~2 GB with reranker, cached in `~/.cache/qmd/models/`, `pnpm tracer` may take minutes first time). Covers Scenario: First-run model download is documented.
- [x] 5.2 `docs/tracer-runbook.md` continued: section 3 — Automated suite (`pnpm tracer`, what it proves, temp vault location). Section 4 — Manual loop reproduction with curl: `V=$(mktemp -d)` → `mkdir $V/vault` → `cd $V && qmd init && qmd collection add $V/vault --name ams` → `pnpm build` → `AMS_VAULT_PATH=$V/vault node packages/api/dist/server.js` → `qmd mcp --http --port 8184` from `$V` → `curl POST :3000/notes` → `curl POST :3000/admin/reindex` → verify search via JSON-RPC on `:8184/mcp`. Covers Scenario: Manual reproduction.
- [x] 5.3 `docs/tracer-runbook.md` continued: section 5 — MCP client reproduction (`packages/mcp/dist/bin.js` with env vars, drive with any MCP client). Section 6 — Troubleshooting (port-taken behavior, precheck failure text, daemon logs, port conflicts).
- [x] 5.4 Verify: `pnpm check` passes (biome lint on the runbook); read through the runbook and confirm all steps are complete and ordered.

## Phase 6: Final Gate

- [ ] 6.1 Run `pnpm check && pnpm tracer` — confirm biome passes on all files (including `e2e/`) and the full E2E suite (tracer.test.ts + failure-modes.test.ts) passes with qmd on PATH. Note: `pnpm typecheck` does NOT cover `e2e/` (root tsconfig references only `packages/*`); the vitest config resolves workspace aliases to source, so type errors surface at test runtime.
- [ ] 6.2 Confirm `pnpm test` is unchanged — the default suite does not collect any `e2e/` files (root vitest.config.ts `include: ["packages/**/*.{test,spec}.ts"]`). Covers Scenario: Default suite untouched.
