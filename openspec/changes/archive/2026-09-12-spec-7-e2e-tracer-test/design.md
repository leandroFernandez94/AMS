# Design: spec-7-e2e-tracer-test

## Overview

A dedicated E2E suite under `e2e/` proving the Tracer Bullet loop end-to-end:
MCP `record_note` → Write API (real HTTP) → note file in a temp vault →
`POST /admin/reindex` (scheduler `tick()` → cwd-scoped `CliReindexer` →
`qmd update`/`qmd embed`) → MCP `search_memory` → hit naming the note's
vault-relative path — against a **live QMD daemon** on a dynamic port, plus the
two failure modes. Production code is untouched (one optional root devDep
excepted); default `pnpm test`/CI never collect these files.

Everything follows the exploration's confirmed seams: `createApp` with manual
`AppDeps` (exploration D4), the injectable `CommandRunner` for cwd-scoped
reindex (D2), `createServer(deps)` + `InMemoryTransport` (D3), and the
real-daemon loop that was proven live with qmd 2.5.3.

## Goals / Non-Goals

**Goals:** the five spec requirements — loop proof, fixture isolation,
lifecycle/readiness, failure modes, tracer entrypoint — plus the runbook.

**Non-Goals:** stdio transport coverage (unit-tested in `mcp-server.test.ts`);
reindex-failure E2E (unit-covered in `admin-reindex.test.ts`); a general
slow-suite mechanism (vitest tags/projects); any production behavior change;
typecheck integration of `e2e/` into `tsc --build` (repo convention excludes
test trees from the TS build — packages' tsconfigs `include: ["src"]` only).

## Architecture Decision Records

### ADR-1: Write API boot — root devDep on `@hono/node-server`, `serve()` called by the fixture (Option A)

**Choice.** Add `@hono/node-server@^2.0.6` as a **root devDependency** (same
range as `packages/api`, so pnpm resolves one copy). The fixture imports
`serve` from `@hono/node-server` and `createApp` + collaborators from
`@ams/api`, and learns the bound port from the `serve()` info callback.

**Alternatives considered.**
- **B: export a boot helper from `@ams/api`** (e.g. `startServer(app, port)`).
- In-process dispatch via `app.request()` (existing unit-test pattern).

**Rationale.** `packages/api/src/server.ts` is an **entry point, not a
library**: it executes `main()` at module load (line 80), reads env via
`loadConfig()`, wires a default-cwd `CliReindexer`, and registers signal
handlers. Option B would require restructuring it and widening the public
export surface (`index.ts` deliberately documents "the runnable entry lives in
`./server.ts`") purely for tests — while the fixture composes `AppDeps`
differently anyway (temp vault, `enabled: false` cron, cwd-scoped runner,
silent logger). Reusing `server.ts` is forced, not natural; the only thing
worth reusing is `serve()` itself, a 3-call API. `app.request()` is rejected
because MCP `record_note` does a real `fetch` to `apiUrl` — the spec requires
the HTTP boundary to be real. Cost of A: one root devDep line, zero production
surface.

**Port learning:** `serve({ fetch: app.fetch, port: 0 }, (info) => …)` — the
info callback delivers the OS-assigned ephemeral port (pattern proven at
`server.ts:73-79`); the fixture wraps it in a Promise.

### ADR-2: Self-contained `vitest.tracer.config.ts`; precheck as an npm script chain

**Choice.** A standalone config that **redeclares** all three aliases and its
own include — no import/spread of the root config:

```ts
// vitest.tracer.config.ts
export default defineConfig({
  resolve: {
    alias: {
      "@ams/api": new URL("./packages/api/src/index.ts", import.meta.url).pathname,
      "@ams/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@ams/mcp": new URL("./packages/mcp/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,  // first-run embed model download (~300 MB)
    hookTimeout: 60_000,   // fixture boot: qmd init + collection add + daemon readiness
  },
});
```

Root script: `"tracer": "node e2e/precheck.mjs && vitest run --config vitest.tracer.config.ts"`.

**Alternatives considered.**
- Import/extend the root config (spread + override `include`, add `@ams/mcp`).
- Precheck inside vitest `globalSetup`.

**Rationale.** Extending buys nothing: `include` must be fully replaced anyway
and nested-`test` spread-merge is fragile; a self-contained config keeps the
tracer's failure domain separate from `pnpm test` (a tracer config bug can
never break CI) at the cost of three stable alias lines. `@ams/mcp` has no
alias anywhere today — the tracer config adds it because the suite imports
`createServer` from `@ams/mcp`. The precheck lives in the **script chain**, not
`globalSetup`: it runs strictly *before* vitest starts (matching the spec
scenario "exits before running tests"), prints an unambiguous message to
stderr (`Missing prerequisite: 'qmd' is not on PATH — install with npm i -g
@tobilu/qmd, see docs/tracer-runbook.md`), and stays decoupled from vitest
internals. `precheck.mjs` does a presence check via `execFile("qmd",
["--version"])`; a semver gate was rejected as brittle (version strings carry
build suffixes, e.g. `2.5.3 (bab86d5)`) — the runbook states the ≥ 2.5.3
requirement. Per repo convention, `e2e/**` is linted by `pnpm check` (Biome)
but not part of `tsc --build`.

### ADR-3: Ports — listen-0 probe with bind-failure retry for the daemon; `port: 0` for the API; readiness via `QmdClient#isReachable()`

**Choice.**
- **Write API:** `serve({ …, port: 0 })`; the OS assigns the port at bind time
  (no race — we keep the socket) and the info callback reports it.
- **QMD daemon:** a `freePort()` helper (net server `listen(0, "127.0.0.1")` →
  read `address().port` → `close()`), then spawn `qmd mcp --http --port <p>`
  with `cwd: fixtureRoot`. **Live-verified gotcha:** `qmd mcp --http --port 0`
  silently falls back to the default 8181 — the daemon cannot pick its own
  ephemeral port, so the probe is mandatory. The probe-then-bind window is
  tiny but real (spec scenario "chosen daemon port is taken"): boot detects a
  premature child exit (EADDRINUSE) and **retries with a fresh probed port**,
  max 3 attempts, then fails with the daemon's collected stderr.
- **Readiness:** poll the fixture's `QmdClient#isReachable()` — interval 250 ms
  with ×1.5 backoff (cap 2 s), overall timeout 15 s per attempt.

**Alternatives considered.** Bind-error retry *without* probe (rely solely on
child-exit detection — works but wastes a spawn and muddies logs); fixed high
port (8181 is occupied on this machine — non-starter); HTTP `GET /health` ping
for readiness (proves the socket, not the MCP endpoint — `isReachable()`
exercises the exact JSON-RPC `initialize` + `tools/call status` path the suite
depends on, and already maps connection refusal to `false`).

### ADR-4: Fixture builder — one module, `e2e/fixtures/vault.ts`

**Choice.** A single cohesive module owning the whole lifecycle:

```ts
export interface TracerFixture {
  /** Temp fixture root — cwd for every spawned qmd process. */
  root: string;
  /** Vault directory served by the Write API (<root>/vault). */
  vaultPath: string;
  /** Write API base URL on its ephemeral port. */
  apiUrl: string;
  /** Live daemon base URL on its dynamically probed port. */
  qmdUrl: string;
  /** QmdClient aimed at the live daemon (same instance the MCP server uses). */
  qmdClient: QmdClient;
  /** Connected in-process MCP client (SDK Client over InMemoryTransport). */
  mcp: Client;
  /** Convenience: POST /admin/reindex, returns the parsed TickResult JSON. */
  reindex(): Promise<{ status: string; indexed: number; pending: number }>;
  /** Idempotent, best-effort teardown (see Teardown Strategy). */
  teardown(): Promise<void>;
}

export function createTracerFixture(): Promise<TracerFixture>;
/** Snapshot now; assertUnchanged() proves no `.qmd` leakage (see Canary). */
export function createIsolationCanary(): { assertUnchanged(): void };
/** Daemon boot seam used by the fixture and the port-taken scenario test. */
export function startQmdDaemon(
  cwd: string,
  nextPort?: () => Promise<number>,
): Promise<{ child: ChildProcess; port: number; url: string }>;
```

`createTracerFixture()` boot order: `mkdtemp(join(tmpdir(), "ams-tracer-"))` →
`mkdir <root>/vault` → `qmd init` (cwd root; creates project-local `.qmd`) →
`qmd collection add <root>/vault --name ams` → compose `AppDeps` manually
(`Vault`, `WriteLock`, `DirtyStore` at `<vault>/.ams/dirty.json`, silent
`createLogger(() => undefined, "error")`, `IndexScheduler` with
`cronExpression: "*/2 * * * *"`, `enabled: false`, and a `CliReindexer` whose
injected `run` wraps `execFile` with `cwd: root` — modeled on
`createExecRunner` but cwd-scoped) → `serve(port: 0)` → `startQmdDaemon(root)`
+ readiness poll → `new QmdClient({ url })` → `createServer({ apiUrl,
qmdClient })` + `InMemoryTransport.createLinkedPair()` + SDK `Client`.

**Alternatives considered.** Splitting into `fixtures/daemon.ts`, `fixtures/http.ts`, etc.
(premature — one lifecycle, ~200 lines); reusing `buildProductionDeps` (reads
env, default-cwd reindexer — exactly what isolation forbids).

**Rationale.** The builder is the single owner of every spawned qmd process —
the D2 isolation invariant. `startQmdDaemon` is exported because the
"chosen daemon port is taken" spec scenario needs a deterministic seam: the
test binds a listener on port P, supplies `nextPort` returning P first, and
asserts the retry lands on a different port.

### ADR-5: MCP in-process driving — `createServer({ apiUrl, qmdClient })` + `InMemoryTransport`; pass `qmdClient`, not `qmdUrl`

**Choice.** The proven `mcp-server.test.ts:9-15` pattern:
`InMemoryTransport.createLinkedPair()` + SDK `Client` +
`server.connect(serverTransport)`. The fixture passes the **same `QmdClient`
instance** used for readiness polling into `createServer` deps
(`resolveQmdClient` prefers `deps.qmdClient` over the env-derived `qmdUrl`,
`search-memory.ts:58-60`), plus the real `apiUrl`.

**Alternatives considered.** Passing `qmdUrl` only (relies on env/config
fallback and constructs a hidden second client — the readiness probe and the
tool would not be provably the same port); spawning `bin.ts` over
`StdioClientTransport` (needs TS execution or a build; `bin.ts` is 15 lines of
glue; exploration D3 rejected).

**Rationale.** An injected instance is explicit, env-leak-proof
(`AMS_QMD_URL` pointing at the occupied 8181 can never hijack the suite), and
matches the established harness. For the **QMD-down** failure mode the same
pattern builds a second, throwaway server: `createServer({ apiUrl, qmdClient:
new QmdClient({ url: "http://127.0.0.1:<closedPort>" }) })` — a port obtained
from `freePort()` and simply never bound. Deterministic, no ordering coupling
with the live daemon, exactly the spec's "client targets a dead port" GIVEN.

## Sequence Diagram — happy-path tracer loop

```mermaid
sequenceDiagram
    participant T as tracer.test.ts
    participant F as createTracerFixture()
    participant M as McpServer (in-process)
    participant A as Write API (serve, port 0)
    participant V as Vault (temp dir)
    participant R as IndexScheduler.tick()
    participant C as CliReindexer (cwd-scoped runner)
    participant Q as qmd daemon (child, dynamic port)

    T->>F: createTracerFixture()
    F->>F: mkdtemp → qmd init → collection add (cwd=root)
    F->>A: serve(app, port: 0) → apiPort
    F->>Q: spawn qmd mcp --http --port <probed> (cwd=root)
    F->>Q: poll isReachable() (250ms, backoff, 15s cap)
    F->>M: createServer({apiUrl, qmdClient}) + InMemoryTransport
    T->>M: record_note {title,type,body}
    M->>A: POST /notes (real fetch)
    A->>V: lock → upsert .md → dirty.mark
    A-->>M: 201 {id, path, created}
    M-->>T: "Note recorded: <id> at <path>"
    T->>V: assert file exists, parseNote round-trips
    T->>A: POST /admin/reindex
    A->>R: tick()
    R->>C: reindex(dirtyEntries)
    C->>Q: qmd update; qmd embed -c ams (cwd=root → local .qmd)
    R-->>A: {status:"ok", indexed:1}
    A-->>T: 200
    T->>M: search_memory {query}
    M->>Q: tools/call "query" ([lex,vec], rerank:false)
    Q-->>M: results (collection-stripped paths)
    M-->>T: "[score] title (vault/rel/path) [#docid]"
```

## Test File Layout

Two files, one fixture boot each (`beforeAll`), teardown in `afterAll`:

```
e2e/
├── precheck.mjs            # qmd-on-PATH check (ADR-2)
├── fixtures/vault.ts       # ADR-4 (also exports createIsolationCanary, startQmdDaemon)
├── tracer.test.ts          # Tracer Loop Proof + Lifecycle/Readiness + Isolation canary
└── failure-modes.test.ts   # Lock contention + QMD down (+ port-taken, see below)
```

`tracer.test.ts` describes map 1:1 to spec requirements:

- `describe("happy-path loop")` — record → file-on-disk round-trip
  (`parseNote` title/body) → `reindex()` asserts `status: "ok", indexed ≥ 1` →
  `search_memory` text contains the vault-relative path and a `[#docid]`.
- `describe("lifecycle and readiness")` — fixture boot itself proves
  "successful boot" (both ports known, readiness within timeout); a dedicated
  test proves "chosen daemon port is taken": bind a net server on P,
  `startQmdDaemon(root, nextPort → [P, then freePort()])`, assert the returned
  port ≠ P and the daemon becomes reachable.
- `describe("isolation")` — canary `assertUnchanged()` after the loop plus the
  positive control: `<root>/.qmd/index.sqlite` exists.

`failure-modes.test.ts`:

- **Lock contention** — `Promise.all` of two `record_note` calls (same
  title+date+type) via `fx.mcp`: exactly one `/Note recorded:/` and one
  `/Note updated:/` text, neither `isError`, exactly one file on disk
  (E2E view of the `notes.test.ts:211-221` serialization contract).
- **QMD down** — throwaway server with dead-port `QmdClient`
  (ADR-5): `search_memory` → `isError === true`, text contains
  `QMD retrieval unavailable`; then a follow-up `record_note` on the **same**
  server succeeds — proving "the MCP server keeps running".

## Teardown Strategy (spec Teardown scenario)

`fx.teardown()` is idempotent, best-effort, and runs in `afterAll` (which
vitest executes whether tests passed or failed). The fixture tracks every
resource at creation time so a partially-failed boot still tears down:

1. `mcp.close()` — closes the Client; the linked `InMemoryTransport` pair
   shuts down with it (no sockets involved).
2. `httpServer.close()` — the node server returned by `serve()`; waits for
   open connections to drain (the cron scheduler is never `start()`ed —
   `enabled: false` — so no timer keeps the loop alive).
3. Daemon: `child.kill("SIGTERM")`, await the `'exit'` event with a 5 s
   timeout, escalating to `SIGKILL` (live-verified: qmd handles SIGTERM
   cleanly — "Shutting down (SIGTERM)...").
4. `rm(root, { recursive: true, force: true })` — removes vault, `.ams`,
   `.qmd`, everything the fixture created.

## Isolation Canary (spec Isolation canary scenario)

`createIsolationCanary()` snapshots synchronously **before**
`createTracerFixture()` (i.e. before `mkdtemp`), capturing:

- `stat` of `~/.cache/qmd/index.sqlite` (`mtimeMs` + `size`; `null` if absent);
- existence of `<repoRoot>/.qmd`;
- the set of `.qmd` entries under `os.tmpdir()`.

`assertUnchanged()` re-inspects: global index stat identical, no `.qmd` in the
repo root, no new `.qmd` anywhere in tmpdir. The shared model cache
(`~/.cache/qmd/models/`) is deliberately excluded — it is a read-mostly
*model* cache, not index state, and is shared by design. Pure `fs` snapshots,
no CI coupling; the positive control (fixture-local index exists) lives in the
isolation test.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `e2e/fixtures/vault.ts` | Create | Fixture builder, canary, `startQmdDaemon`, cwd-scoped runner, `freePort` (ADR-3/4) |
| `e2e/tracer.test.ts` | Create | Happy path, lifecycle/readiness incl. port-taken, isolation canary |
| `e2e/failure-modes.test.ts` | Create | Lock contention, QMD down |
| `e2e/precheck.mjs` | Create | `qmd --version` fail-fast with readable message |
| `vitest.tracer.config.ts` | Create | Standalone config: 3 aliases, `e2e/**` include, generous timeouts |
| `docs/tracer-runbook.md` | Create | Manual reproduction runbook (outline below) |
| `package.json` (root) | Modify | Add `tracer` script + `@hono/node-server@^2.0.6` devDep |

`packages/**` unchanged.

## Runbook Outline (`docs/tracer-runbook.md`)

1. **Prerequisites** — Node ≥ 22; `npm i -g @tobilu/qmd`; `qmd --version` (≥ 2.5.3).
2. **First-run cost** — embedding model ~300 MB download on first `qmd embed`
   (~2 GB total with the reranker; cached in `~/.cache/qmd/models/`); `pnpm
   tracer` may take minutes on first execution.
3. **Automated suite** — `pnpm tracer` (what it proves; where the temp vault lives).
4. **Manual loop** (mirrors the suite):
   `V=$(mktemp -d)` → `mkdir $V/vault` → `cd $V && qmd init && qmd collection add $V/vault --name ams` →
   `pnpm build` → `AMS_VAULT_PATH=$V/vault AMS_API_PORT=3000 node packages/api/dist/server.js` →
   `qmd mcp --http --port 8184` (from `$V`) →
   `curl POST :3000/notes` → `curl POST :3000/admin/reindex` →
   verify search via JSON-RPC `tools/call query` on `:8184/mcp` (recipe in
   `docs/retrieval-runbook.md`).
5. **MCP client reproduction** — run `packages/mcp/dist/bin.js` with
   `AMS_API_URL`/`AMS_QMD_URL` env; drive with any MCP client (e.g. inspector).
6. **Troubleshooting** — port-taken behavior, precheck failure text, daemon logs.

## Threat Matrix

| Boundary | Adversarial cases | Applicability | Design response | Planned RED tests |
|---|---|---|---|---|
| Documentation-like paths | `requirements.txt`, executable MDX | N/A — harness never classifies/reads doc-like files | — | — |
| Git repository selection | `git -C`, relative/absolute | N/A — no git automation | — | — |
| Commit state / Push state / PR commands | staged, refspec, `--head` | N/A — no VCS/PR automation | — | — |
| Shell command execution (test harness) | `qmd` argv built from mkdtemp paths (spaces/unicode in tmpdir); missing binary; port from untrusted probe | **Applicable** — fixture spawns `qmd` (daemon + CLI runner) and `precheck.mjs` runs `qmd --version` | Args always passed as `execFile`/`spawn` arrays (no shell interpolation); every spawn pinned to `cwd: fixtureRoot`; ENOENT surfaces as readable readiness/precheck failure, never silent fallback | Missing-qmd precheck scenario; boot-failure path fails the suite with collected stderr |

## Risks (from exploration/proposal — resolved or owned)

| Risk | Status | Resolution in this design |
|------|--------|---------------------------|
| Global-index pollution via inherited cwd | Owned | Fixture is sole spawn owner; cwd-scoped `CommandRunner`; canary asserts global index untouched |
| Port 8181 occupied / port races | Owned | ADR-3: probe + retry + `--port 0` fallback gotcha documented; API uses OS-assigned port |
| Daemon readiness race | Owned | `isReachable()` backoff poll, 15 s cap |
| First-run model download | Owned | `testTimeout: 180_000`; runbook section |
| Unclosed sockets hang vitest | Owned | Teardown order closes client → HTTP server → daemon (SIGTERM→SIGKILL) → rm |
| QMD missing | Owned | `precheck.mjs` script chain fails before vitest starts |
| Root-config drift breaks CI | Owned | Standalone tracer config; default suite never collects `e2e/**` |

## Open Questions

None — all conditional seams are decided; ready for task breakdown.
