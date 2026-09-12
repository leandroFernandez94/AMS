```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:9adf65daf2906d2d7189da2f208c82c42903b84726f895e68633cfc17c24814e
verdict: fail
blockers: 0
critical_findings: 1
requirements: 5/6
scenarios: 12/13
test_command: pnpm test
test_exit_code: 0
test_output_hash: sha256:aea844e1149700f990b31ddd0475d0226f577d3af271ae5b5a627e9cd4ed5685
build_command: pnpm typecheck
build_exit_code: 0
build_output_hash: sha256:1a9d0ae645dd7a140cca346d6aff986ea7da3ce5c5da91377facf5cc18c34127
```

# Verify Report: spec-7-e2e-tracer-test (re-verification)

**Change**: spec-7-e2e-tracer-test
**Mode**: Standard (Strict TDD off — `openspec/config.yaml` `tdd: false`)
**Implementation**: branch `feat/spec-7-e2e-tracer-test`, HEAD `86997e2` (remediation commits `f0ed83a`, `86997e2` on top of the originally verified `f66c859`), clean working tree (this report previously untracked; committed by this verification)
**Evidence revision**: 2 — `evidence_revision` is the sha256 of the concatenated raw logs of `pnpm check`, `pnpm typecheck`, `pnpm test`, and `pnpm tracer` captured during this re-verification

## Summary

**FAIL (one NEW CRITICAL finding).** The remediation itself is good — all four prior
findings are resolved, and this verification independently re-proved C-1 by executing the
current runbook recipe end-to-end with the repo's own `dist` (record → disk → cwd-scoped
reindex → initialize handshake → query → note found, with the global
`~/.cache/qmd/index.sqlite` byte-identical from baseline to post-cleanup). However, the
regression sweep surfaced a defect the previous verification missed: **fixture teardown
kills only the spawned `qmd` supervisor, not the socket-holding worker process qmd forks
internally** — every *clean* `pnpm tracer` run leaves ~6 orphaned live daemons listening
on ports with deleted fixture cwds (pids 1934454/1934467/1934597/1934769/1934805/1934900
from this verification's own 14:07:45 run, still alive 8+ minutes later; identical cohorts
from the 13:37, 14:02 and 14:04 clean runs). The "Teardown" scenario ("every spawned qmd
process is killed") is empirically false; the prior report's "zero qmd processes left by
the run" observation was a faulty sweep (it did not match worker cmdlines). A second, minor
defect: the newly added S-2 troubleshooting command `pgrep -af "qmd mcp"` matches zero
daemons on qmd 2.5.3 (actual cmdline is `…/qmd.js mcp …`).

## Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 31 (26 original + 5 remediation) |
| Tasks complete | 31 |
| Tasks incomplete | 0 |

## Runtime Verification — Commands & Results

| Command | Observed result |
|---|---|
| `pnpm check` | ✅ exit 0 — `biome check .` — "Checked 64 files in 30ms. No fixes applied." (includes `e2e/`) |
| `pnpm typecheck` | ✅ exit 0 — `tsc --build`, silent (`e2e/` outside the tsc graph by design, documented in tasks.md and design.md Non-Goals) |
| `pnpm test` | ✅ exit 0 — 149 passed / 0 failed / 4 skipped; cross-check `vitest list` → **0** files under `e2e/` collected |
| `pnpm tracer` | ✅ exit 0 — precheck + `vitest run --config vitest.tracer.config.ts` — 2 test files, **9/9 tests passed**, 9.41 s |
| `env PATH=/usr/bin:/bin <node> e2e/precheck.mjs` (missing-qmd simulation) | ✅ exact message `Missing prerequisite: 'qmd' is not on PATH — install with npm i -g @tobilu/qmd, see docs/tracer-runbook.md`, exit 1, before any vitest startup |
| `git diff main..HEAD -- vitest.config.ts` | ✅ empty (0 lines) — default config untouched |
| `git diff main..HEAD -- package.json` | scripts: only `+ "tracer": …`; devDeps: `+ @hono/node-server ^2.0.6`, `+ @modelcontextprotocol/sdk 1.29.0` (S-1 record matches) |
| Manual runbook recipe (see C-1 re-proof) | ✅ full loop observed: 201 + file on disk + `{"status":"ok","indexed":1}` + note found via handshake query; global index stat identical throughout |
| Post-run process sweep | ❌ 6 live qmd daemons leaked by this verification's own clean `pnpm tracer` run (N-1) |

Build/typecheck: ✅ Passed. Tests: ✅ 149 default + 9 E2E passed. Coverage: ➖ Not available
(no coverage command configured; threshold 0 per `rules.verify`).

### C-1 independent empirical re-proof (executed by this verification, not trusted from receipts)

Recipe executed from `docs/tracer-runbook.md` §"Manual loop reproduction with curl" in a
fresh `mktemp -d`, with two environmental deviations, both covered by the runbook's own
Troubleshooting section: API port 3717 instead of 3000 (3000 is held by a foreign
service on this machine), and the recipe's daemon port 8184 used verbatim after killing
the leaked orphaned daemon that held it — exactly the `pgrep`/`kill` procedure the runbook
prescribes.

```text
1. V=$(mktemp -d); mkdir $V/vault; cd $V && qmd init && qmd collection add $V/vault --name ams
   → "ready to go with new local index"; collection 'ams' created; local $V/.qmd registry exists
2. cd /path/to/ams && pnpm build → exit 0 (dist/server.js, dist/bin.js present)
3. Baseline global index stat: ~/.cache/qmd/index.sqlite → mtime_ns 1789212374.989912103, size 3289088
4. cd $V && AMS_VAULT_PATH=$V/vault AMS_API_PORT=3717 node /path/to/ams/packages/api/dist/server.js
   → "ams-write-api:listening" port 3717, vault $V/vault   (cwd-scoped start per fixed runbook)
5. cd $V && qmd mcp --http --port 8184 → daemon up
6. curl POST /notes {"title":"Manual Tracer",...} → 201 {"id":"2026-09-12-manual-tracer",
   "path":"notes/2026-09-12-manual-tracer.md","created":true}
7. File on disk: frontmatter round-trips title "Manual Tracer" + body "Proving the loop by hand."
8. Global index stat before reindex: IDENTICAL to baseline
9. curl POST /admin/reindex → {"status":"idle","indexed":0,"pending":0}
   (the scheduler's */2 cron tick had already drained note #1 — anticipated by the runbook's
   troubleshooting "or wait for the cron tick"; not a defect)
10. Second note + immediate reindex → {"status":"ok","indexed":1,"pending":0}
    (proves the manual reindex path genuinely indexes — the exact C-1a failure mode)
11. Global index stat after both reindexes AND after full cleanup: IDENTICAL to baseline
    (mtime_ns 1789212374.989912103, size 3289088 — zero global mutation; local $V/.qmd
    index.sqlite + 3.7 MB WAL grew instead)
12. SESSION=$(curl initialize …) → mcp-session-id 446ff8c6-c4cc-41f2-b7b9-44e514444c8a
13. curl tools/call query {"searches":[lex+vec "manual tracer"],rerank:false} with the session →
    "Found 2 results": ams/notes/2026-09-12-manual-tracer.md (score 1, snippet shows
    "title: Manual Tracer") + ams/notes/2026-09-12-second-manual-tracer.md (score 0.5)
14. Cleanup: API + daemon killed (including the socket-holding worker child), ports released,
    temp dir removed
```

**C-1a and C-1b are both empirically disproven as defects: the loop is now observable
verbatim by a human, and the recipe never touches the global index.**

## Spec Compliance Matrix

| Requirement | Scenario | Test / Evidence | Result |
|-------------|----------|-----------------|--------|
| Tracer Loop Proof | Happy-path loop | `e2e/tracer.test.ts > happy-path loop > reindexes and finds the note via search_memory` (runtime: 9/9 passed this verification) | ✅ COMPLIANT |
| Tracer Loop Proof | Note content and path on disk | `e2e/tracer.test.ts > happy-path loop > persists the note on disk and round-trips title and body` + manual recipe step 7 | ✅ COMPLIANT |
| Fixture Isolation | Isolation canary | `e2e/tracer.test.ts > isolation > does not leak .qmd artifacts outside the fixture` + `keeps the fixture-local qmd index`; W-1-hardened canary active and passing; manual recipe independently confirmed global index byte-identical | ✅ COMPLIANT |
| Fixture Isolation | Teardown | afterAll → `fx.teardown()` in all 4 describes + port-taken self-cleanup: temp dir removed ✅, spawned supervisor killed ✅ — **but qmd's socket-holding worker survives every clean run** (6 live leaked daemons from this verification's own run; N-1) | ❌ FAILING (N-1) |
| Lifecycle and Readiness | Successful boot | `e2e/tracer.test.ts > lifecycle and readiness > knows both bound ports and has a connected MCP client` (fixture boot readiness within 15 s) | ✅ COMPLIANT |
| Lifecycle and Readiness | Chosen daemon port is taken | `e2e/tracer.test.ts > lifecycle and readiness > retries daemon boot when the probed port is already taken` (first-attempt → occupied port, retry → free port; verified in source lines 111–139) | ✅ COMPLIANT |
| Failure Mode Assertions | Concurrent same-note writes serialize | `e2e/failure-modes.test.ts > lock contention > serializes two concurrent record_note calls for the same note` (`Promise.all`, one recorded + one updated, no `isError`) | ✅ COMPLIANT |
| Failure Mode Assertions | QMD down | `e2e/failure-modes.test.ts > qmd down > maps search_memory to a structured error and keeps the server alive` (`isError` + `QMD retrieval unavailable`, follow-up write succeeds) | ✅ COMPLIANT |
| Tracer Entrypoint | Tracer run on a prepared machine | This verification: `pnpm tracer` → 9/9 passed, exit 0 | ✅ COMPLIANT |
| Tracer Entrypoint | Missing qmd binary | `e2e/precheck.mjs` under PATH without qmd → exact message, exit 1, script chain prevents vitest startup | ✅ COMPLIANT |
| Tracer Entrypoint | Default suite untouched | `git diff main..HEAD -- vitest.config.ts` empty; `vitest list` shows 0 e2e files; 149 passed | ✅ COMPLIANT |
| Tracer Runbook | Manual reproduction | **Empirically re-proved by this verification** (recipe transcript above): write → disk → cwd-scoped reindex → initialize handshake → query → note found | ✅ COMPLIANT (C-1 resolved, f0ed83a) |
| Tracer Runbook | First-run model download is documented | `docs/tracer-runbook.md` §First-run cost: ~300 MB model, ~2 GB full set, `~/.cache/qmd/models/`, "first run can take several minutes" | ✅ COMPLIANT |

**Compliance summary**: 12/13 scenarios compliant, 1 failing (Teardown — N-1)

## Correctness (Static Evidence)

| Aspect | Status | Notes |
|--------|--------|-------|
| Isolation spawn trace | ✅ Implemented | Every qmd-spawning path pinned to fixture cwd (`vault.ts:79-83,184-188,198-218`); args as arrays, no shell; `precheck.mjs` version-print unpinned per ADR-2 |
| Canary coverage incl. W-1 fix | ✅ Implemented | `vault.ts:146-153`: non-null branch compares mtime+size; null branch now throws `Global QMD index was created` if the index appears — still-absent is asserted, not skipped. (Null branch not runtime-exercisable on this machine — global index pre-exists — verified by code reading + suite pass) |
| Production reindex cwd | ✅ As designed | `createExecRunner` passes no cwd (`cli-reindexer.ts:59-80`) → inherits API process cwd; the fixed runbook starts the API inside `$V`, which this verification proved makes `qmd update`/`qmd embed` resolve `$V/.qmd` |
| Runbook correctness | ✅ Fixed (f0ed83a) | Env names, routes, dist paths, cwd-scoped API start, two-step MCP handshake all verified empirically this run |
| Daemon teardown | ❌ Defective | `teardown()` SIGTERM→(SIGKILL)→rm targets only the spawned supervisor pid (`vault.ts:307-315`); qmd forks a socket-holding worker ("MainThread") that survives both signals to the parent — see N-1 |
| Lock contention power | ✅ Implemented | `Promise.all` concurrency; 409 regression → `isError` failure; lost-update → recorded count ≠ 1 |
| QMD-down dead port | ✅ Implemented | `freePort()` releases socket, nothing rebinds |
| Default suite separation | ✅ Implemented | Standalone tracer config; root include `packages/**` only |

## Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| ADR-1: root devDep `@hono/node-server`, fixture calls `serve()` | ✅ Yes | `^2.0.6` present; second root devDep `@modelcontextprotocol/sdk@1.29.0` now recorded (S-1 resolved in tasks.md Remediation) |
| ADR-2: self-contained tracer config + precheck script chain | ✅ Yes | Three aliases redeclared; own include; 180 s/60 s timeouts; precheck exact message before vitest |
| ADR-3: probe + bind-failure retry + `isReachable()` backoff | ✅ Yes | `vault.ts:72-127` (3 attempts), readiness poll 250 ms ×1.5 cap 2 s / 15 s |
| ADR-4: single-module fixture builder | ✅ Yes | Interface, builders, boot order and teardown order match design (teardown order itself is where N-1 lives — the design did not anticipate qmd's internal fork) |
| ADR-5: pass `qmdClient` instance, not `qmdUrl` | ✅ Yes | `createMcpServer({ apiUrl, qmdClient })`; QMD-down uses dead-port instance |
| Test file layout / threat matrix | ✅ Yes | Layout matches design §Test File Layout; all spawns array-argv |

## Findings

### Previous findings — all RESOLVED

- **C-1 (CRITICAL, resolved by `f0ed83a`)**: Runbook manual reproduction now works verbatim.
  C-1a (reindex no-op for `$V`) — fixed by starting the API with cwd inside `$V`; this
  verification observed `{"status":"ok","indexed":1}` into `$V/.qmd` with the global index
  byte-identical (stat identical at baseline, pre-reindex, post-reindex ×2, post-cleanup).
  C-1b (session-less query rejected) — fixed by the initialize → `mcp-session-id` →
  `tools/call` two-step curl; executed exactly as written, query returned the note at
  score 1. Independently re-proved; see transcript above.
- **W-1 (WARNING, resolved by `86997e2`)**: `e2e/fixtures/vault.ts:151-153` — the null
  global-index branch now asserts still-absent (`Global QMD index was created` guard).
  Suite passes with the hardened canary.
- **S-1 (SUGGESTION, resolved by `f0ed83a`)**: `tasks.md` §Remediation records the
  `@modelcontextprotocol/sdk@1.29.0` second root devDep and why it is needed.
- **S-2 (SUGGESTION, resolved by `f0ed83a`)**: runbook §Troubleshooting now documents
  leaked-daemon and stale-collection hygiene — but the delivered command is itself
  defective; see N-2.

### CRITICAL (new)

**N-1 — Teardown leaks live qmd daemon workers on every clean run (scenario FAILING).**
`qmd mcp --http` (2.5.3) forks an internal worker process (the `MainThread` process that
actually holds the listening socket). The fixture's `teardown()` and the port-taken test
kill only the pid they spawned (`vault.ts:307-315`, `tracer.test.ts:135-136`); the worker
survives SIGTERM/SIGKILL to its parent, is reparented to init, keeps LISTENing on its
port, and keeps its (deleted) fixture cwd. Empirical evidence from THIS verification:
`pnpm tracer` (clean, exit 0, 14:07:45–14:07:54) left 6 live daemons — pids
1934454 (:46427), 1934467 (:38071), 1934597 (:36979), 1934769 (:44315), 1934805 (:42445),
1934900 (:46647), cwds `/tmp/ams-tracer-*`/`ams-tracer-port-*` (deleted) — still alive
8+ minutes after the run ended; identical 6-daemon cohorts from the clean runs at 13:37,
14:02 and 14:04 confirm this is every clean run, not a one-off (≈58 orphaned qmd daemons
now accumulated on this machine). This verification's manual recipe independently
reproduced the mechanism: killing the daemon's parent pid left the worker holding 8184.
The previous verification's "zero qmd processes left by the run" Teardown evidence was a
faulty sweep — its pattern did not match worker cmdlines — and the scenario has no
automated covering test, so nothing in the suite catches it. *Remediation direction (not
applied)*: kill the whole process tree — spawn the daemon `detached: true` so it gets its
own process group and teardown kills `-pgid` (SIGTERM then SIGKILL), and/or add a covering
assertion that no live process has a cwd under the fixture root after teardown (scan
`/proc/*/cwd`), which would also have caught this at test time.

### WARNING (new)

**N-2 — Runbook cleanup hint matches zero daemons on qmd 2.5.3.** The S-2 remediation
(`docs/tracer-runbook.md:141-143`) says `pgrep -af "qmd mcp"`, but real daemon cmdlines
are `node …/qmd.js mcp --http --port N` — the substring `qmd mcp` never occurs, so the
command run interactively lists nothing while 58 daemons run (verified empirically this
session). Additionally, even with a working listing, killing only the listed parent pid
leaves the socket-holding worker alive (observed on 8184 during this verification's
cleanup). Use `pgrep -af qmd` to list and `pkill -f "qmd.js mcp"` to stop them.

### SUGGESTION

- The suite should own the Teardown guarantee as a test (see N-1 direction) rather than
  relying on verifier observation — the observation failed once already.
- This machine needs one-time manual hygiene: ~58 orphaned qmd daemons and 5 stale
  `/tmp/ams-tracer-*` dirs (13:17–13:26 apply-era interruptions). Environmental; not
  caused by committed code, but every future `pnpm tracer` run adds ~6 more until N-1
  is fixed.

## Verdict

**FAIL** — 12/13 scenarios compliant. All four previously reported findings (C-1, W-1,
S-1, S-2) are independently confirmed resolved — C-1 by fresh empirical execution of the
fixed runbook recipe with zero global-index mutation — and all gates pass (`pnpm check` /
`pnpm typecheck` / `pnpm test` 149 / `pnpm tracer` 9/9, all exit 0). The change is **not
archive-ready**: new N-1 shows the Teardown scenario is empirically false (≈6 live
daemon leaks per clean run), which the prior verification's faulty process sweep missed.
Remediate N-1 (tree-kill teardown + covering assertion) and N-2 (working cleanup
command), then re-verify.
