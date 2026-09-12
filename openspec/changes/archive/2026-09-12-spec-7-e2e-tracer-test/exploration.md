# Exploration: Spec 7 — E2E tracer test (full write → read loop)

## Context

Specs 1–6 are implemented and merged. GitHub issue #6 asks for the final piece of
the Tracer Bullet milestone: one Vitest E2E test that drives the real loop
`record_note` (MCP) → Write API → file on disk → reindex → `search_memory`
(MCP) → assert the just-written note is returned. Deliverables: a reusable
temp-vault fixture builder, a `tracer` npm script at the repo root, and a short
manual-reproduction runbook. The issue explicitly permits stubbing the QMD
boundary if a real daemon is too heavy, with a separate `slow` integration test
for the real daemon.

This exploration mapped every seam, verified QMD availability on this machine,
and **proved the full real-daemon loop live** (see Environment findings).

## Current architecture map (entry points & seams)

### Write API boot (question 1)

- `packages/api/src/app.ts:55` — `createApp(deps: AppDeps): Hono`. The app
  factory with fully injectable collaborators (`AppDeps` at
  `packages/api/src/app.ts:29-40`: `vault`, `lock`, `dirty`, `logger`,
  optional `scheduler`).
- `packages/api/src/server.ts:20` — `buildProductionDeps(config)` wires real
  collaborators from env config; `server.ts:73-79` binds via
  `serve({ fetch: app.fetch, port }, (info) => info.port)` from
  `@hono/node-server`. `serve()` on `port: 0` yields an ephemeral port in the
  `info` callback — the E2E boot mechanism.
- **Existing tests do NOT boot a real server**: `packages/api/tests/notes.test.ts:31-37`
  uses Hono's `app.request()` in-process dispatch. The E2E needs real HTTP
  (MCP `record_note` does a real `fetch` to `apiUrl`), so it must call `serve()`
  itself. `@hono/node-server` is already a dependency
  (`packages/api/package.json:25`).
- Routes: `GET /health` (`app.ts:58`), `POST /notes` (`app.ts:60`, handler
  `app.ts:86-168`), `POST /admin/reindex` (`app.ts:62-76`).

### QMD seam for `search_memory` (question 2)

- `packages/api/src/qmd/client.ts:81` — `class QmdClient` with
  `QmdClientOptions` (`client.ts:60-67`): `url` (base URL, default
  `AMS_QMD_URL` / `http://localhost:8181`), injectable `transport`
  (`JsonRpcTransport`), `timeoutMs`.
- The fake seam is the `JsonRpcTransport` **function type**
  (`packages/api/src/qmd/http.ts:45`) — exactly what
  `packages/mcp/tests/mcp-server.test.ts:38-48` (`fakeQmdClient`) already
  replaces. But for a REAL daemon the E2E simply constructs
  `new QmdClient({ url: "http://localhost:<port>" })` — no stub needed.
- Wire protocol (`http.ts`): MCP Streamable HTTP over `POST /mcp`, lazy
  `initialize` handshake caching `mcp-session-id` (`http.ts:107-144`),
  30 s default timeout (`http.ts:77`).
- `QmdClient.isReachable()` (`client.ts:135-143`) — cheap `status` probe that
  resolves `false` on `QmdUnavailableError`; ideal for daemon-readiness polling.
- Output mapping (`packages/api/src/qmd/mapping.ts:97-111`): QMD
  `<collection>/<relpath>` is stripped to vault-relative `MemoryHit.path`
  (`stripQmdUri`, `mapping.ts:60-66`); docid `#abc123` kept as the `get` handle.

### Scheduler / dirty flags (question 3)

- `packages/api/src/indexing/scheduler.ts:106` — **`tick()` is the manual
  trigger**: one full indexing cycle, returns `TickResult`
  `{ status: "idle"|"ok"|"failed"|"busy", indexed, pending, error? }`
  (`scheduler.ts:27-36`). Exposed over HTTP as `POST /admin/reindex`
  (`app.ts:62-76`, 200 on ok/idle, 503 on scheduler-missing or failed).
- `enabled: false` option (`scheduler.ts:46-55`) makes `start()` a no-op while
  `tick()` keeps working — the E2E should disable cron and use the manual
  trigger. Default cron `*/2 * * * *` (`indexing/config.ts:22`).
- Dirty mechanism: `POST /notes` marks the note path in `DirtyStore`
  (`<vault>/.ams/dirty.json`, `packages/api/src/dirty.ts:27`); `tick()` drains
  the snapshot, calls `reindexer.reindex(entries)`, and **clears flags only
  after success** (`scheduler.ts:127-137`) — failures retry next tick.
- `CliReindexer` (`packages/api/src/indexing/cli-reindexer.ts:92`) shells out
  `qmd update` then `qmd embed [-c <collection>]`. **Critical**: it accepts an
  injectable `run: CommandRunner` (`cli-reindexer.ts:38-50`); the default
  `execFile` runner inherits the **process cwd** — which decides which QMD
  index (global vs project-local) gets written (see Environment findings).

### MCP server driving (question 6)

- `packages/mcp/src/server.ts:20` — `createServer(deps?: ServerDeps)` returns
  an unconnected `McpServer`; **callers own transport wiring** (stdio in
  production, `InMemoryTransport` in tests — comment at `server.ts:16-19`).
- `ServerDeps` (`packages/mcp/src/types.ts:4-10`): `apiUrl` (Write API base
  URL), `qmdClient` (a `QmdClient`), `fetch`. Falls back to env
  (`AMS_API_URL`, `AMS_QMD_URL`) via `getConfig()`
  (`packages/mcp/src/config.ts:36-43`). Both real URLs are injectable —
  **confirmed**: the E2E can pass `apiUrl: "http://localhost:<apiPort>"` and
  `qmdClient: new QmdClient({ url: "http://localhost:<qmdPort>" })`.
- Harness precedent: `packages/mcp/tests/mcp-server.test.ts:9-15`
  (`createTestClient`: `InMemoryTransport.createLinkedPair()` + SDK `Client`
  + `server.connect`). Production stdio entry is `packages/mcp/src/bin.ts`
  (15 lines; `StdioServerTransport`).
- Tool output shapes useful as assertions: `record_note` → text
  `"Note recorded: <id> at <path>"` (test at `mcp-server.test.ts:122`);
  `search_memory` → text containing `[<score>] <title> (<path>)` and
  `[<#docid>]` (`mcp-server.test.ts:264-265`).

### Failure modes already modeled (question 7)

- **Write-lock contention** (`packages/api/src/lock.ts:45-59`): there is **no
  409/423** — contention **queues FIFO** (TTL auto-release as deadlock
  escape). Natural assertion (precedent `notes.test.ts:211-221`): two
  concurrent `record_note` for the same logical note yield exactly one
  "created" and one "updated" result, serialized (never overlapping).
- **QMD down**: network failure/timeout → `QmdUnavailableError`
  (`qmd/errors.ts:32-40`, classified in `http.ts:99-103`); `search_memory`
  maps it to a structured MCP error `"QMD retrieval unavailable: ..."`
  (`mcp-server.test.ts:299-315`). Natural E2E assertion: point a
  `QmdClient` at a dead port (or kill the daemon) → `isError === true` and
  the text contains `QMD retrieval unavailable`; `isReachable() === false`.
- **Reindex failure**: `POST /admin/reindex` → 503 with
  `{ status: "failed", pending, error }` and dirty flags preserved
  (`admin-reindex.test.ts:67-79`). Reproducible with a `qmdBin` that does not
  exist.
- **Write API down**: MCP `record_note` fetch throws → structured
  `"Write API unavailable"` error (`mcp-server.test.ts:178-192`).

### Root scripts & test separation (question 8)

- Root `package.json:11-19`: scripts `test`, `test:watch`, `typecheck`,
  `lint`, `check` — no `tracer`, no workspace test tagging.
- `vitest.config.ts:16` — single include glob `packages/**/*.{test,spec}.ts`;
  aliases only for `@ams/api` and `@ams/shared` (**no `@ams/mcp` alias**,
  `vitest.config.ts:10-13`). No projects, no tags, no slow-suite mechanism.
- Existing opt-in precedent: `packages/api/tests/qmd-integration.test.ts:19-20`
  gates on `AMS_QMD_INTEGRATION=1` (`it.skip` otherwise), with the local
  runbook in the file header (lines 8–15).
- CI (`.github/workflows/ci.yml:22`) runs plain `pnpm test` on
  `ubuntu-latest` **without QMD installed** — whatever the E2E does, the
  default `pnpm test` must keep passing in CI.

## Environment findings (QMD availability — question 4)

- **QMD is installed**: `qmd 2.5.3 (bab86d5)` at
  `/home/leandro/.nvm/versions/node/v24.13.0/bin/qmd`
  (global npm package `@tobilu/qmd`, resolved via
  `.../node_modules/@tobilu/qmd/bin/qmd`).
- **Port 8181 (the default `AMS_QMD_URL`) is OCCUPIED by a non-QMD service**
  on this machine: listeners on `127.0.0.1:8181`, `100.64.20.67:8181` and a
  Tailscale IPv6; `POST /mcp` returns 404 and `/` redirects to
  `/web/client/login`. The E2E **must not** rely on the default port.
- `~/.cache/qmd/` exists with `index.sqlite` **and `models/`**
  (`embeddinggemma-300M-Q8_0.gguf` used during the probe) — embeddings work
  on CPU with no first-run download on this machine.
- The **global** index currently holds one collection `ams-test-vault`
  (pointed at the repo's gitignored `test-vault/`, 3 files) — global state an
  E2E must not touch.
- **Project-local index isolation works**: `qmd init` in a directory creates
  `.qmd/index.sqlite`, and `qmd status`, `qmd collection add`, `qmd update`,
  `qmd embed`, and `qmd mcp --http --port <n>` run from that cwd all use the
  local index. Daemon flags confirmed by live probe: `--http`, `--port`,
  `--host`, `--daemon` (`docs/retrieval-runbook.md:64-75`).
- **The full loop was proven live** (in `/tmp/opencode/qmd-probe`, since
  cleaned up; no daemons left running): `qmd init` → `qmd collection add
  <vault> --name tracer` → `qmd update` (1 indexed) → `qmd embed -c tracer`
  (CPU, seconds for one file) → `qmd mcp --http --port 8184` → JSON-RPC
  `initialize` (session id header) → `tools/call query` with
  `searches: [{type:"lex"},{type:"vec"}]`, `rerank: false` → returned the
  just-written fixture note (`docid #6a44b3`, `file
  "tracer/decisions/tracer-probe.md"`, score 1). This is byte-for-byte the
  shape `QmdClient` sends and `mapping.ts` expects.

## Fixture/harness inventory (question 5)

| Asset | Location | What to reuse |
|---|---|---|
| Temp vault pattern | `packages/api/tests/notes.test.ts:23-29` | `mkdtemp(join(tmpdir(), "ams-"))` + `rm(recursive, force)` in `afterEach` |
| App deps composition | `notes.test.ts:39-48` | Manual `AppDeps` wiring with silent logger (`createLogger(() => undefined, "error")`) |
| Fake/real reindexer injection | `packages/api/tests/admin-reindex.test.ts:19-41` | `IndexScheduler` with `enabled` unset + `POST /admin/reindex` as the manual trigger (`admin-reindex.test.ts:43-44`) |
| Concurrency probe | `notes.test.ts:51-71, 211-221` | Same-id concurrent writes assertion for the lock-contention failure mode |
| InMemoryTransport client | `packages/mcp/tests/mcp-server.test.ts:9-15` | The E2E MCP driver |
| Fake QMD transport | `mcp-server.test.ts:38-48` | Only if a stubbed-QMD variant is wanted |
| Env-gated integration suite | `packages/api/tests/qmd-integration.test.ts:19-26` | Skip pattern + `{ timeout: 60_000 }` on the describe |
| Note fixture data | `@ams/shared` (`buildNote`, `notePath`, `parseNote`) via `packages/shared/src/index.ts` | Asserting the file on disk round-trips (pattern at `notes.test.ts:112-119`) |
| Manual runbook precedent | `docs/retrieval-runbook.md` | Daemon lifecycle, env vars, curl recipes; a `docs/tracer-runbook.md` sibling fits the convention |

## Key decisions to make

### D1. QMD boundary: real daemon vs stubbed transport

| Option | Pros | Cons | Complexity |
|---|---|---|---|
| **A. Real daemon in fixture** (spawn `qmd mcp --http --port <free>` with cwd = fixture root) | Proves the true loop incl. session handshake, FTS5 + embeddings; probe shows it is fast (~seconds); satisfies "QMD installed" acceptance clause directly | Needs daemon lifecycle + readiness polling in the harness; depends on qmd on PATH | Medium |
| B. Stub `JsonRpcTransport` (fake QmdClient) | Zero external deps; CI-friendly | Proves nothing about real QMD; would re-test what `mcp-server.test.ts` already covers; still needs the `slow` real-daemon test later | Low |

**Recommendation: A.** The environment findings remove the issue's stated
hesitation ("if starting a real QMD daemon is too heavy…"): it is not heavy
here. Keep option B's fakes where they already exist (unit suites).

### D2. Index isolation: project-local `.qmd` vs global index

| Option | Pros | Cons | Complexity |
|---|---|---|---|
| **A. `qmd init` inside the temp fixture; run every qmd child process with `cwd: fixtureRoot`** | Complete isolation from `~/.cache/qmd`; parallel-safe; no teardown of global state; proven in probe | `CliReindexer`'s default runner inherits the vitest process cwd — the E2E must inject a `run` CommandRunner that passes `cwd` (seam exists: `cli-reindexer.ts:49`) | Medium |
| B. Register the temp vault as a uniquely-named collection in the global index; `qmd collection remove` on teardown | No cwd plumbing | Mutates real user state; broken teardown leaks; collides with the existing `ams-test-vault`; hostile to parallel runs | High (risk) |
| C. Env var for index location | Cleanest if it existed | No documented `QMD_*` index-path env var found in `qmd --help` output | Unknown |

**Recommendation: A** — the fixture builder owns: `mkdtemp` → `qmd init` →
`collection add` → a `CommandRunner` bound to the fixture cwd → daemon spawn
with the same cwd → `rm -rf` + daemon kill on teardown.

### D3. MCP driving: in-process InMemoryTransport vs stdio subprocess

| Option | Pros | Cons | Complexity |
|---|---|---|---|
| **A. `createServer(deps)` + `InMemoryTransport` + SDK `Client`** | Established harness (test precedent); no build step; real HTTP + real daemon still exercised on both upstreams | Skips stdio framing (covered separately by the stdout-cleanliness test, `mcp-server.test.ts:382-419`) |
| B. Spawn `bin.ts` over `StdioClientTransport` | Exercises the production binary path | Needs TS execution (`node --import tsx`) or a prior build; brittle in CI; adds little — `bin.ts` is 15 lines of glue | High |

**Recommendation: A.** "In-process (stdio)" in the issue reads as
"in-process, not a separate always-on service"; InMemoryTransport is the
repo's canonical in-process driver.

### D4. Write API + scheduler wiring in the E2E

Compose `AppDeps` manually (not `buildProductionDeps`, which reads env and
wires a default-cwd `CliReindexer`): `Vault`, `WriteLock`, `DirtyStore` over
the temp vault, silent logger, and an `IndexScheduler` with `enabled: false`
cron plus the **cwd-scoped** `CliReindexer`. Boot with
`serve({ fetch: app.fetch, port: 0 })` and read the bound port from the info
callback (pattern: `server.ts:73-79`). Trigger indexing via
`POST /admin/reindex` and assert the `TickResult` (`status: "ok"`,
`indexed ≥ 1`) — this also proves the scheduler path, satisfying the issue's
"uses its manual trigger" clause.

### D5. Suite separation & the `tracer` script

| Option | Pros | Cons |
|---|---|---|
| **A. Root `e2e/` dir + dedicated `vitest.tracer.config.ts` + `"tracer": "vitest run --config vitest.tracer.config.ts"`** | Physically outside the default include glob (`packages/**`) — CI's `pnpm test` untouched without skip logic; own timeouts; fixture builder lives beside the test as a reusable helper | Adds one small config file; must redeclare aliases (`@ams/api`, `@ams/shared`) or use relative imports (note: no `@ams/mcp` alias exists today) |
| B. Env-gated test inside `packages/mcp/tests/` (`AMS_TRACER=1`, `it.skip` otherwise) | Zero config drift; direct `qmd-integration` precedent | `pnpm test` still collects the file; script must set env inline; suite identity is mcp-local though the loop spans all packages |
| C. Vitest tags/projects (`--tag slow`) | First-class slow-suite concept going forward | Not used anywhere in the repo yet; needs doc verification for Vitest 4.1.9 behavior before committing to it |

**Recommendation: A**, with C worth a design-phase look only if the team wants
a general slow-suite mechanism beyond the tracer. Either way the script should
precheck `qmd --version` and fail fast with a readable message when QMD is
missing (acceptance: "given Node 22 + QMD installed").

### D6. Scope of failure-mode assertions

Acceptance requires each named failure mode at least once. Natural set,
all drivable through the same harness: (1) lock contention — two concurrent
`record_note` with the same title+date → one created + one updated,
serialized; (2) QMD down — `QmdClient` at a dead port (or daemon killed
post-search) → `search_memory` returns `isError` with
`QMD retrieval unavailable`; (3) cheap bonus: `POST /admin/reindex` with a
bogus `qmdBin` → 503 `failed` with flags preserved (already unit-tested;
E2E can skip it to stay lean).

## Risks

- **Global-index pollution** if any qmd child process runs without the fixture
  cwd (the default `execFile` inherits the vitest cwd). Mitigation: the fixture
  builder is the single owner of every spawned qmd command; add a canary
  assertion that `<fixture>/.qmd/index.sqlite` exists before the loop.
- **Port collisions** — 8181 is already taken on this machine by an unrelated
  service; a fixed tracer port can collide elsewhere. Mitigation: pick a free
  port via a listen-0-close probe (small race, acceptable) and retry.
- **Daemon readiness race** — `qmd mcp --http` needs ~1–2 s. Mitigation: poll
  `QmdClient#isReachable()` with backoff before the loop.
- **First-run model download** on machines that never used qmd
  (~300 MB embedding model; `docs/retrieval-runbook.md:24-26` says ~2 GB
  total with reranker). `pnpm tracer` may take minutes on first execution —
  must be called out in the runbook.
- **CPU embed time scales with fixture size** — keep the fixture to 1–3 tiny
  notes; embed of one file took seconds in the probe.
- **`serve()` port-0 / `close()` details** — the info-callback pattern is
  proven in `server.ts`; design should confirm idle-socket teardown so vitest
  doesn't hang (unref or explicit `server.close()` in `afterAll`).
- **CI divergence** — CI has no QMD; if option D5-B were chosen the file must
  skip cleanly. With D5-A the default suite never sees the file at all.

## Recommended approach

Real-daemon E2E, fully isolated:

1. `e2e/fixtures/vault.ts` (fixture builder): `mkdtemp` temp dir → `qmd init`
   (project-local `.qmd`) → `qmd collection add <vault> --name ams` → returns
   `{ root, vaultPath, runInFixture: CommandRunner, cleanup }`.
2. `e2e/tracer.test.ts`: boot Write API via `serve(..., port: 0)` with manual
   `AppDeps` (scheduler `enabled: false`, `CliReindexer` with the
   fixture-cwd runner); spawn `qmd mcp --http --port <free>` with
   `cwd: fixtureRoot`; poll `isReachable()`; drive
   `createServer({ apiUrl, qmdClient })` over `InMemoryTransport`:
   `record_note` → assert file on disk (`parseNote` round-trip) →
   `POST /admin/reindex` → assert `TickResult.ok` → `search_memory` → assert
   the note's vault-relative path appears; then the two failure-mode cases.
3. `vitest.tracer.config.ts` + root script `"tracer"` with a `qmd --version`
   precheck.
4. `docs/tracer-runbook.md`: curl (`POST /notes`, `POST /admin/reindex`) +
   MCP client snippet reproducing the loop manually, linking to
   `docs/retrieval-runbook.md` for daemon setup.

This satisfies every acceptance criterion without stubbing and with zero
impact on the default `pnpm test` / CI.

## Ready for Proposal

**Yes.** All seams are mapped with line evidence, the environment supports the
real-daemon path (proven live), and the only open item is the D5 suite
separation choice, which has a clear recommendation. The orchestrator should
tell the user: QMD 2.5.3 is installed and the real-daemon loop is feasible and
fast; the default port 8181 is occupied by another service on this machine, so
the E2E will use a dynamic port.
