# Archive Report: spec-7-e2e-tracer-test

## Change Summary

Implemented the E2E tracer suite proving the Tracer Bullet loop end to end
against a live QMD daemon: MCP `record_note` → Write API (real HTTP) → note
file in an isolated temp vault → `POST /admin/reindex` → MCP `search_memory`
returning the note's vault-relative path — plus both failure modes:

- `e2e/fixtures/vault.ts` — fixture builder: `mkdtemp` root, project-local
  `qmd init` + `collection add`, manually composed `AppDeps` (cwd-scoped
  `CliReindexer`, disabled scheduler, silent logger), `serve()` on an
  ephemeral port, daemon spawn with readiness polling, detached process-group
  spawn + tree-kill teardown + zero-survivor assertion, isolation canary
- `e2e/tracer.test.ts` — happy-path loop, lifecycle/readiness (incl. port-taken
  retry), isolation canary
- `e2e/failure-modes.test.ts` — concurrent same-note writes serialize (FIFO);
  QMD-down maps to `QMD retrieval unavailable` while the MCP server keeps
  running
- `vitest.tracer.config.ts` + `e2e/precheck.mjs` + root `pnpm tracer` script —
  dedicated suite outside the default `pnpm test`/CI collection, fail-fast when
  `qmd` is missing from PATH
- `docs/tracer-runbook.md` — prerequisites, first-run model cost, automated
  suite, manual curl + MCP-client reproduction, troubleshooting

Production packages (`packages/**`) are untouched; root `package.json` gained
the `tracer` script and two devDeps (`@hono/node-server@^2.0.6`,
`@modelcontextprotocol/sdk@1.29.0`).

## Final State (at close)

- **All 34 tasks complete**: 26 original (Phases 1–6) + 5 remediation round-1
  (C-1a, C-1b, W-1, S-1, S-2) + 3 remediation round-2 (N-1a, N-1b, N-2).
- **Final verification: PASS** — 13/13 scenarios, 6/6 requirements
  (`verify-report.md`, committed `19f7e65`, `sdd-verify-validate` verdict:
  pass).
- **Final receipts**: `pnpm check` clean (64 files); `pnpm typecheck` clean;
  `pnpm test` 149 passed / 4 skipped with 0 e2e files collected under the
  default config; `pnpm tracer` 9/9 in ~15 s; zero leaked daemons (verified by
  three independent detection methods: bracket-pattern `pgrep`, broadest `ps`
  scan, `/proc/*/cwd` walk); zero stale `/tmp/ams-tracer-*` dirs; repo root
  clean of `.qmd`.
- **Empirical proofs on record**: the runbook manual recipe was executed
  end-to-end by hand (note found via an initialized MCP session query; global
  `~/.cache/qmd/index.sqlite` byte-identical across 4 checkpoints); the
  teardown group-kill was proven live on a manually spawned
  supervisor+worker pair (single group SIGTERM ended both, port released).

## Final Verification Verdict

**PASS** — 13/13 scenarios compliant, 6/6 requirements compliant, 0 blockers,
0 critical findings, 0 open findings (round-3 report at
`verify-report.md`, HEAD `19f7e65`).

## Remediation History

Two remediation rounds occurred; both were verified fixed by a later
re-verification (not trusted from receipts).

### Round 1 (commits `f0ed83a`, `86997e2`)

- **C-1 (CRITICAL)**: runbook manual loop was broken — fixed by starting the
  API with cwd inside `$V` (so `qmd update` resolves the project-local `.qmd`)
  and replacing the one-shot query with the MCP initialize →
  `mcp-session-id` → `tools/call` handshake.
- **W-1 (WARNING)**: isolation canary null-branch blind spot — the canary now
  asserts the global index stays absent when it was absent at snapshot.
- **S-1 (SUGGESTION)**: recorded the second root devDep
  (`@modelcontextprotocol/sdk@1.29.0`) in `tasks.md`.
- **S-2 (SUGGESTION)**: added runbook troubleshooting hints for leaked daemons
  and stale global collections.

### Round 2 (commits `0beca07`, `3f666a0`)

- **N-1 (CRITICAL)**: teardown leaked live qmd daemon workers on every clean
  run — fixed by spawning the daemon detached (own process group), tree-killing
  the group in `teardown()` (SIGTERM → SIGKILL escalation, `/proc` group-empty
  poll), and adding a zero-survivor assertion scanning `/proc/*/cmdline` +
  `/proc/*/cwd`.
- **N-2 (WARNING)**: runbook cleanup hints used broken `pgrep/pkill` patterns
  that never matched leaked workers — replaced with `pgrep -af qmd` /
  `pkill -f "qmd.js mcp"` plus a shell self-match caution.

Plus `989c407`: `.gitignore` stray `.qmd/` (dev debris cleanup, no behavioral
effect).

## Commits

| Commit | Content |
|--------|---------|
| `03b449a` | Plan: openspec artifacts (proposal, exploration, spec, design, tasks) |
| `2d32451` | Scaffold: tracer vitest config, precheck, root script + devDeps |
| `1c6c0d2` | Fixture builder: qmd lifecycle, isolation canary, boot/teardown |
| `195df00` | Happy-path loop test against live qmd daemon |
| `4642669` | Failure-mode tests: lock contention, qmd down |
| `0717fec` | Tracer runbook |
| `1dfb0df` | Mark spec-7 tasks complete |
| `f66c859` | Lock root devDeps for tracer suite |
| `f0ed83a` | Remediation R1: cwd-scoped API start + session handshake (C-1, S-1, S-2) |
| `86997e2` | Remediation R1: canary null-branch guard (W-1) |
| `9f0cc69` | Record round-1 remediation + refreshed verify report |
| `0beca07` | Remediation R2: tree-kill process group + zero-survivor assertion (N-1) |
| `3f666a0` | Remediation R2: correct daemon cleanup hint patterns (N-2) |
| `989c407` | Ignore stray qmd project state in repo root |
| `19f7e65` | Final verify report (Spec 7 PASS) |

## Spec Compliance

- 6/6 requirements compliant
- 13/13 scenarios covered with runtime evidence
- 34/34 tasks complete (26 original + 5 remediation round 1 + 3 remediation round 2)

## Ledger

The SDD ledger records 5 attempts across the cycle: phases-1-6 apply passed
(maintainer `size:exception`); verify round 1 failed (C-1/W-1/S-1/S-2);
remediation-1 apply passed; verify round 2 failed (N-1/N-2); remediation-2
apply passed (maintainer overage acceptance); verify round 3 passed.

## Artifacts Inventory

Archived (moved verbatim to
`openspec/changes/archive/2026-09-12-spec-7-e2e-tracer-test/`):

- `proposal.md` — intent, scope, risks, rollback
- `exploration.md` — option analysis (real daemon, project-local index, in-process MCP)
- `design.md` — ADR-1..ADR-5, test file layout, threat matrix
- `specs/e2e-tracer-suite/spec.md` — delta spec (full spec; new capability)
- `tasks.md` — 34/34 complete incl. both remediation rounds
- `verify-report.md` — final round-3 PASS report
- `archive-report.md`, `state.yaml` — written at archive time (additive)

Synced to main specs (source of truth):

- `openspec/specs/e2e-tracer-suite/spec.md` — **created** (new capability,
  pure addition; 6 requirements, 13 scenarios; verified byte-identical to the
  delta via empty `diff` readback)

## Relations

- Closes #6 — GitHub issue "Spec 7: E2E tracer test" (via `Closes #6` in the
  delivery PR)
- Milestone: **Tracer Bullet** — with Spec 7 archived, all milestone specs
  (Spec 1–7) are merged; the tracer bullet loop is proven end to end
- New capability added: `e2e-tracer-suite`

## Delivery State

- Branch: `feat/spec-7-e2e-tracer-test` (delivery follows ordinary repo policy
  after archive — one issue per PR, `Closes #6`)

## Follow-ups

None blocking. The SDD cycle is complete; the Tracer Bullet milestone is
closed. Any future work (e.g. CI integration of `pnpm tracer`, stdio E2E
coverage) is new-change material, explicitly out of scope per the proposal.
