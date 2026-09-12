```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:928b9b35eac8a137d8ecb73bb0301618a4a3cd5dd5a268f0c9ab2a5b106e2150
verdict: pass
blockers: 0
critical_findings: 0
requirements: 6/6
scenarios: 13/13
test_command: pnpm test
test_exit_code: 0
test_output_hash: sha256:1196a37509dd69b4821ff7847ca6116ba33ba7a6c3f3ff50555f5ff904de864e
build_command: pnpm typecheck
build_exit_code: 0
build_output_hash: sha256:1a9d0ae645dd7a140cca346d6aff986ea7da3ce5c5da91377facf5cc18c34127
```

# Verify Report: spec-7-e2e-tracer-test (FINAL — round 3)

**Change**: spec-7-e2e-tracer-test
**Mode**: Standard (Strict TDD off — `openspec/config.yaml` `tdd: false`)
**Implementation**: branch `feat/spec-7-e2e-tracer-test`, HEAD `989c407` (round-2 remediation commits `0beca07` N-1, `3f666a0` N-2, `989c407` stray-`.qmd` gitignore, on top of round-1 remediation `f0ed83a`/`86997e2`), clean working tree (this report is the only change, committed by this verification)
**Evidence revision**: 3 — `evidence_revision` is the sha256 of the concatenated raw logs of `pnpm check`, `pnpm typecheck`, `pnpm test`, and `pnpm tracer` captured during this final verification

## Summary

**PASS — 13/13 scenarios compliant, 6/6 requirements.** Both round-2 findings are resolved
and were re-proven independently by this verification, not trusted from receipts. N-1: from
a verified zero-daemon baseline, a clean `pnpm tracer` run (9/9 tests, exit 0) left **zero
qmd processes** (0 before → 0 after), **zero** `/tmp/ams-tracer-*` directories, and **zero**
processes with a cwd inside leftover or deleted fixture dirs — checked with three independent
methods (bracket-pattern `pgrep -af "qmd[.]js mcp"`, a broadest-net `ps -eo args` scan for
any `qmd` text, and a `/proc/*/cwd` walk). This is the exact sweep that round 2 failed (it
found 6 live leaked workers after a clean run). The teardown mechanism was additionally
proven live: a manually spawned daemon pair (supervisor + forked socket-holding worker) died
completely under a single group SIGTERM, with the port released. N-2: the runbook hint
patterns were verified against real daemon cmdlines on qmd 2.5.3 — supervisor
`node …/bin/qmd mcp --http --port P`, worker `node …/@tobilu/qmd/dist/cli/qmd.js mcp …` —
`pgrep -af qmd` lists both, `qmd.js mcp` matches the leak-critical worker (the old
`qmd mcp` pattern never matched leaked workers, confirming round 2's diagnosis), and the
self-match caution is present and was live-demonstrated during this verification's own
probing. All gates pass. The change is archive-ready.

## Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 34 (26 original + 5 remediation round 1 + 3 remediation round 2) |
| Tasks complete | 34 |
| Tasks incomplete | 0 |

## Runtime Verification — Commands & Results

| Command | Observed result |
|---|---|
| `pnpm check` | ✅ exit 0 — `biome check .` — "Checked 64 files in 26ms. No fixes applied." (includes `e2e/`) |
| `pnpm typecheck` | ✅ exit 0 — `tsc --build`, silent (`e2e/` outside the tsc graph by design, documented in tasks.md; output hash byte-identical to round 2 — silent as expected) |
| `pnpm test` | ✅ exit 0 — 149 passed / 0 failed / 4 skipped; `vitest list` under the default config collects **0** files under `e2e/` |
| `pnpm tracer` | ✅ exit 0 — precheck + `vitest run --config vitest.tracer.config.ts` — 2 test files, **9/9 tests passed**, 14.98 s |
| `env PATH=/usr/bin:/bin node e2e/precheck.mjs` | ✅ exact message `Missing prerequisite: 'qmd' is not on PATH — install with npm i -g @tobilu/qmd, see docs/tracer-runbook.md`, exit 1, before any vitest startup |
| `git diff main..HEAD -- vitest.config.ts` | ✅ empty (0 lines) — default config untouched |
| `git diff main..HEAD -- package.json` | ✅ scripts: only `+ "tracer": …`; devDeps: `+ @hono/node-server ^2.0.6`, `+ @modelcontextprotocol/sdk 1.29.0` (S-1 record matches) |
| Repo stray state | ✅ no `.qmd/` in repo root; `.gitignore` carries `.qmd/` (989c407) |

Build/typecheck: ✅ Passed. Tests: ✅ 149 default + 9 E2E passed. Coverage: ➖ Not available
(no coverage command configured; threshold 0 per `rules.verify`).

### N-1 independent proof (executed by this verification)

Process accounting around a clean `pnpm tracer` run, using self-match-safe enumeration
(bracket pattern in a dedicated probe script so no wrapper cmdline could self-match):

| Check | Before run | After run |
|---|---|---|
| `pgrep -af "qmd[.]js mcp"` daemon count | **0** | **0** |
| Broadest net: any `qmd` text in any cmdline (`ps -eo pid,args`) | none | none |
| `/tmp/ams-tracer-*` directories | 0 | **0** |
| `/proc/*/cwd` inside leftover/deleted `ams-tracer-*` dirs | 0 | **0** |

Mechanism was additionally proven in isolation and by code reading:

1. **Live group-kill experiment**: this verification spawned its own daemon via `setsid qmd
   mcp --http --port 18331` in a scratch dir. `pgrep -af qmd` showed the two-process
   structure — supervisor `node …/bin/qmd mcp …` and its forked socket-holding worker
   `node …/@tobilu/qmd/dist/cli/qmd.js mcp …` (worker ppid = supervisor pid). A single
   `kill -TERM -<pgid>` ended **both** processes; port 18331 released; cwd scan clean;
   scratch dir removed. The round-2 leak mode (worker surviving a parent-only kill) is
   structurally closed by group signaling.
2. **Teardown code path is live, not dead**: `e2e/fixtures/vault.ts` spawns the daemon
   `detached: true` (line 83) so it leads its own process group; `killProcessTree`
   (lines 251–278) sends SIGTERM to `-pgid`, races a 5 s exit, escalates to SIGKILL, then
   polls `/proc` until the group is empty; `assertNoSurvivors` (lines 286–313) scans
   `/proc/*/cmdline` for `qmd.js` + `mcp` AND `/proc/*/cwd` (stripping the `(deleted)`
   suffix) for cwds inside the fixture root, and **throws** on any survivor. It executes
   in the fixture `teardown()` after `rm(root)` (line 404) and in the port-taken test
   (`e2e/tracer.test.ts:140`); all four fixture-consuming describes invoke `fx.teardown()`
   in `afterAll`. The Teardown scenario is now guarded by a runtime assertion inside the
   suite itself — the gap round 2 flagged (no automated covering check) is closed.

### N-2 verification (executed by this verification)

`docs/tracer-runbook.md` (lines 141–144) now prescribes `pgrep -af qmd` to list and
`pkill -f "qmd.js mcp"` to stop leaked daemons, plus the caution to run `pkill` directly in
the shell rather than nested in another command string. Verified against reality:

- `pgrep -af qmd` listed both live daemon processes in the experiment above. ✅
- The `qmd.js mcp` substring matches the worker cmdline — the process that actually leaks
  (round 2 showed leaked cohorts are always workers). The old broken pattern `qmd mcp`
  matches only the supervisor invocation form and never the leaked-worker form, which is
  exactly why round 2 observed zero matches against 58 live daemons. ✅
- The self-match caution is accurate and was live-demonstrated: this verification's own
  sweep wrappers matched themselves whenever the literal pattern text was nested inside a
  command string, and stopped matching once the probe moved to a script file. ✅

## Spec Compliance Matrix

| # | Requirement | Scenario | Test / Evidence | Result |
|---|-------------|----------|-----------------|--------|
| 1 | Tracer Loop Proof | Happy-path loop | `e2e/tracer.test.ts > happy-path loop > reindexes and finds the note via search_memory` (runtime: 9/9 passed this verification) | ✅ COMPLIANT |
| 2 | Tracer Loop Proof | Note content and path on disk | `e2e/tracer.test.ts > happy-path loop > persists the note on disk and round-trips title and body` | ✅ COMPLIANT |
| 3 | Fixture Isolation | Isolation canary | `e2e/tracer.test.ts > isolation > does not leak .qmd artifacts outside the fixture` + `keeps the fixture-local qmd index`; canary snapshotted in `beforeAll` (0beca07); global-index isolation independently re-proven in round 2's manual recipe (byte-identical global index) | ✅ COMPLIANT |
| 4 | Fixture Isolation | Teardown | **Re-proven this round**: in-suite `assertNoSurvivors` in every teardown path + external sweep 0→0 daemons, 0 `/tmp/ams-tracer-*`, 0 orphan cwds around a clean run (was N-1 FAILING) | ✅ COMPLIANT |
| 5 | Lifecycle and Readiness | Successful boot | `e2e/tracer.test.ts > lifecycle and readiness > knows both bound ports and has a connected MCP client` | ✅ COMPLIANT |
| 6 | Lifecycle and Readiness | Chosen daemon port is taken | `e2e/tracer.test.ts > lifecycle and readiness > retries daemon boot when the probed port is already taken` (now cleans up via `killProcessTree` + `assertNoSurvivors`) | ✅ COMPLIANT |
| 7 | Failure Mode Assertions | Concurrent same-note writes serialize | `e2e/failure-modes.test.ts > lock contention > serializes two concurrent record_note calls for the same note` | ✅ COMPLIANT |
| 8 | Failure Mode Assertions | QMD down | `e2e/failure-modes.test.ts > qmd down > maps search_memory to a structured error and keeps the server alive` | ✅ COMPLIANT |
| 9 | Tracer Entrypoint | Tracer run on a prepared machine | This verification: `pnpm tracer` → 9/9 passed, exit 0 | ✅ COMPLIANT |
| 10 | Tracer Entrypoint | Missing qmd binary | Re-proven this round: restricted-PATH `e2e/precheck.mjs` → exact message, exit 1 before vitest startup | ✅ COMPLIANT |
| 11 | Tracer Entrypoint | Default suite untouched | `git diff main..HEAD -- vitest.config.ts` empty; `vitest list` → 0 e2e files; 149 passed | ✅ COMPLIANT |
| 12 | Tracer Runbook | Manual reproduction | Runbook spot-proof this round: cwd-scoped API start (`cd "$V"` before `node …/dist/server.js`, lines 59–67) and the initialize → `mcp-session-id` → `tools/call` handshake (lines 90–107) are intact; full recipe empirically re-proved end-to-end in round 2 with zero global-index mutation (cited, not redone — no doubts) | ✅ COMPLIANT |
| 13 | Tracer Runbook | First-run model download is documented | `docs/tracer-runbook.md` §First-run cost: ~300 MB model, ~2 GB full set, `~/.cache/qmd/models/`, "first run can take several minutes" | ✅ COMPLIANT |

**Compliance summary**: 13/13 scenarios compliant, 6/6 requirements compliant.

## Correctness (Static Evidence)

| Aspect | Status | Notes |
|--------|--------|-------|
| Tree-kill teardown (N-1 fix) | ✅ Implemented | `detached: true` spawn → own process group; `killProcessTree` SIGTERM→SIGKILL to `-pgid` with `/proc` group-empty poll; ESRCH tolerated for idempotency; retry path of `startQmdDaemon` also uses `killProcessTree` (no orphans on EADDRINUSE retries) |
| Zero-survivor assertion (N-1 fix) | ✅ Implemented and live | `/proc/*/cmdline` (`qmd.js` + `mcp`) + `/proc/*/cwd` inside fixture root (with `(deleted)` suffix stripped — the exact round-2 leak signature); throws, not logs; runs in both teardown call sites |
| `processesInPgid` field note | ✅ Correct in practice | It reads the post-`comm` stat slot at index 3, which is the *session* id rather than pgrp (index 2); for a `detached` (setsid) child and its fork descendants session == pgrp, so the poll is equivalent here — and in the only hypothetical divergence (a descendant calling `setsid`) both indices and the group signal miss together, leaving the cwd-based `assertNoSurvivors` as the backstop. Empirically moot: 0 survivors under all three external checks |
| Isolation spawn trace | ✅ Implemented | Every qmd-spawning path pinned to fixture cwd (`vault.ts` spawn/runQmd/createFixtureRunner); args as arrays, no shell; `precheck.mjs` version-print unpinned per ADR-2 |
| Canary coverage incl. W-1 fix | ✅ Implemented | Null branch throws `Global QMD index was created`; snapshot moved to `beforeAll` (0beca07) to avoid same-file ordering flakiness |
| Runbook correctness (incl. N-2 fix) | ✅ Verified | Env names, routes, dist paths, cwd-scoped API start, two-step MCP handshake, working daemon-cleanup patterns + self-match caution — all confirmed against live cmdlines this round |
| Lock contention power | ✅ Implemented | `Promise.all` concurrency; 409 regression → `isError` failure; lost-update → recorded count ≠ 1 |
| QMD-down dead port | ✅ Implemented | `freePort()` releases socket, nothing rebinds |
| Default suite separation | ✅ Implemented | Standalone tracer config; root include `packages/**` only |

## Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| ADR-1: root devDep `@hono/node-server`, fixture calls `serve()` | ✅ Yes | Both root devDeps recorded (`^2.0.6`, SDK `1.29.0`) |
| ADR-2: self-contained tracer config + precheck script chain | ✅ Yes | Three aliases redeclared; own include; 180 s/60 s timeouts; precheck exact message before vitest |
| ADR-3: probe + bind-failure retry + `isReachable()` backoff | ✅ Yes | Retry path now tree-kills failed attempts (0beca07) |
| ADR-4: single-module fixture builder | ✅ Yes | Interface, builders, boot order and teardown order match design; teardown now implements group-kill + survivor assertion within the same structure |
| ADR-5: pass `qmdClient` instance, not `qmdUrl` | ✅ Yes | `createMcpServer({ apiUrl, qmdClient })`; QMD-down uses dead-port instance |
| Test file layout / threat matrix | ✅ Yes | Layout matches design §Test File Layout; all spawns array-argv |

## Findings — all RESOLVED

### Round 2 (verified resolved this round)

- **N-1 (CRITICAL, resolved by `0beca07`)**: Teardown leaked live qmd daemon workers on
  every clean run. Fixed by detached spawn + process-group tree-kill + in-suite
  `assertNoSurvivors`. Independently re-proven this round: 0 → 0 daemons around a clean
  `pnpm tracer`, zero temp dirs, zero orphan cwds; live group-kill experiment confirmed the
  forked worker dies with the group; the scenario now has an automated covering assertion
  (round 2's "no covering test" gap closed).
- **N-2 (WARNING, resolved by `3f666a0`)**: Runbook cleanup hint matched zero real
  daemons. Fixed to `pgrep -af qmd` / `pkill -f "qmd.js mcp"` + self-match caution.
  Verified against observed live cmdlines; the caution's mechanism was live-demonstrated
  during this verification's own probing.

### Round 1 (resolved earlier; spot-checked this round)

- **C-1 (CRITICAL, resolved by `f0ed83a`)**: Runbook manual reproduction works verbatim —
  cwd-scoped API start and initialize/`mcp-session-id` handshake confirmed intact in the
  runbook this round; full empirical re-proof cited from round 2 (loop observed by hand,
  global index byte-identical throughout).
- **W-1 (WARNING, resolved by `86997e2`)**: isolation canary null-branch guard present and
  suite passes with it.
- **S-1 (SUGGESTION, resolved by `f0ed83a`)**: second root devDep recorded in tasks.md.
- **S-2 (SUGGESTION, resolved by `f0ed83a`, superseded fix in `3f666a0`)**: troubleshooting
  hints present; the delivered commands now actually work (N-2 verification above).

### Open findings

None. One non-blocking observation (`processesInPgid` reads session id where the name says
pgrp — equivalent under `detached`/setsid semantics, backstopped by the cwd-based
assertion) is recorded in the Correctness table; it affects no scenario.

## Verdict

**PASS** — 13/13 scenarios compliant, 6/6 requirements, 34/34 tasks complete. All gates
green (`pnpm check` / `pnpm typecheck` / `pnpm test` 149 / `pnpm tracer` 9/9, all exit 0).
Both round-2 findings independently re-proven fixed: zero process/dir/cwd survivors around
a clean tracer run (0 before → 0 after, three independent detection methods), and runbook
cleanup patterns verified against real daemon cmdlines. Round-1 findings remain resolved
(intact this round; C-1's full empirical re-proof cited from round 2). The change is
**archive-ready**.
