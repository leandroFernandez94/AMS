# Proposal: Spec 7 — E2E Tracer Test (Full Write → Read Loop)

## Intent

The Tracer Bullet needs its proof of done: one E2E test driving the real
loop from MCP `record_note` through the Write API and the vault to
`search_memory` retrieval against a live QMD daemon. Specs 1–6 are merged;
this closes the milestone.

## Scope

### In Scope

- `e2e/tracer.test.ts` — boot the Write API on an ephemeral port; spawn
  `qmd mcp --http` on a dynamic port in the fixture; drive MCP over
  `InMemoryTransport`; assert `record_note` → file on disk →
  `POST /admin/reindex` (`ok`) → `search_memory` returns the note's
  vault-relative path
- `e2e/fixtures/vault.ts` — fixture builder: `mkdtemp` root, `qmd init`
  (project-local `.qmd`), `qmd collection add`, cwd-scoped `CommandRunner`
  for `CliReindexer`; owns daemon lifecycle and teardown
- Failure modes ≥ once: lock contention (concurrent same-note
  `record_note` → one "created" + one "updated", serialized); QMD down
  (dead port → `search_memory` returns `QMD retrieval unavailable`)
- `vitest.tracer.config.ts` + root `tracer` script (`qmd --version`
  fail-fast precheck)
- `docs/tracer-runbook.md` — manual reproduction (curl + MCP client),
  first-run model download

### Out of Scope

Production behavior; default `pnpm test`/CI; stdio coverage; slow-suite
mechanism; reindex-failure E2E (unit-covered).

## Capabilities

### New Capabilities

- `e2e-tracer-suite`: isolated real-daemon E2E harness proving the tracer
  loop and failure modes.

### Modified Capabilities

None — test-only; `mcp-domain-tools` unchanged.

## Approach

Exploration option A (D1–D5): real daemon, project-local index, in-process
MCP, manual reindex trigger, dedicated `e2e/` suite outside the default
glob — no skip logic, CI untouched; dynamic ports (8181 occupied here).

Conditional seams (design decides): `serve()` from `e2e/` needs
`@hono/node-server` at root vs a boot helper from `@ams/api`; tracer config
redeclares aliases, adds `@ams/mcp`.

## Affected Areas

| Area | Impact |
|------|--------|
| `e2e/**`, `vitest.tracer.config.ts`, `docs/tracer-runbook.md` | New (paths in Scope) |
| `package.json` (root) | Modified — `tracer` script, possible devDep |
| `packages/**` | Unchanged (unless conditional export) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Global-index pollution (runner inherits vitest cwd) | Medium | Fixture owns all spawns; canary `.qmd` assert |
| Daemon readiness / port races | Medium | Poll `isReachable()`; listen-0 probe |
| First-run model download (~300 MB) | Medium | Runbook documents; tiny fixtures |
| Unclosed sockets hang Vitest | Low | `server.close()` + daemon kill |
| QMD missing | Low | Precheck fails fast |

## Rollback Plan

Additive, test-only: delete `e2e/`, `vitest.tracer.config.ts`,
`docs/tracer-runbook.md`; revert root `package.json`.

## Dependencies

- Closes #6; needs merged implementation PRs of #3, #4, #5, #7; QMD ≥ 2.5.3
  on PATH; Node ≥ 22

## Success Criteria

- [ ] `pnpm tracer` passes from clean clone (Node 22 + QMD installed)
- [ ] Proves write → disk → reindex → searchable → retrieved (real daemon)
- [ ] Temp vault isolated; global index untouched
- [ ] Both failure modes asserted ≥ once
- [ ] Default `pnpm test`/CI untouched
- [ ] Runbook enables manual reproduction (curl + MCP client)
