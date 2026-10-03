# Feature: Optional Streamable HTTP transport for packages/mcp (issue #37)

## Objective

`packages/mcp` can serve MCP over Streamable HTTP (stateless) behind a bearer
token, as a second entrypoint alongside the unchanged stdio binary. Phase 1 of
the remote-MCP decision (#27, topology 1): tailnet-only service on the existing
self-hosted compose stack. Phase 2 (public exposure, OAuth) is #39.

## Problem / Why

Centralized deploys (one image update vs pull+deploy on N agent hosts) and
unlocking clients on hosts we do not control. `createServer()` is
transport-agnostic since #40/#41 (wiring isolated in `bin.ts`); tools are
stateless HTTP round-trips, so the change is additive.

## Scope

- IN: HTTP entrypoint (`http.ts` + bin `ams-mcp-http`), Hono app with
  `WebStandardStreamableHTTPServerTransport` (stateless), bearer-token auth,
  upstream-probing health endpoint, config additions, tests for both transports,
  deployment/config docs.
- OUT: OAuth (#39), public exposure (#39), session management (stateless by
  design), compose changes on the self-hosted server (operational, post-merge),
  Dockerfile changes (image already ships `packages/mcp/dist`).

## Decisions (verified against installed sources, 2026-10-03)

1. **Hono + `hono/bearer-auth` instead of Express + SDK `requireBearerAuth`.**
   User-approved deviation from the issue letter. Evidence: `requireBearerAuth`
   is Express-typed (`RequestHandler` from `express`; Express not a workspace
   dep) and hard-rejects tokens without a numeric future `expiresAt`
   (`bearerAuth.js:30-35`) — designed for OAuth, awkward for static tokens.
   Hono 4.12.27 already in the graph (packages/api); its `bearerAuth`
   middleware uses `timingSafeEqual` internally and emits proper
   `WWW-Authenticate` challenges. SDK's own docs show the Hono integration
   (`transport.handleRequest(c.req.raw)`). Doc #27 must be updated to record
   this.
2. **Stateless = fresh transport per request** (not a singleton). The SDK
   throws `Stateless transport cannot be reused across requests` 
   (`webStandardStreamableHttp.js:137-140`). Each `POST /mcp` creates a fresh
   `createServer(deps)` + fresh transport, handles one request, closes.
3. **`enableJsonResponse: true`** for phase 1: tools are request/response
   round-trips; JSON responses avoid SSE-stream lifecycle complexity in
   per-request transports. Spec-compliant; SDK ships a JSON-response example.
4. **Separate `http.ts` entry** (not env-switch in `bin.ts`): guarantees the
   stdio path stays byte-for-byte unchanged (migration fallback per issue).
5. **`GET /health` unauthenticated** (consistent with API/QMD health
   endpoints, needed for Docker HEALTHCHECK); reports per-upstream status,
   never note content.

## Constraints

- `bin.ts` and the stdio path remain byte-for-byte unchanged.
- Static token from env (`AMS_MCP_TOKEN`); startup fails fast if missing/empty
  in HTTP mode. Timing-safe comparison (via Hono's middleware).
- Server must start with upstreams down (lazy clients survive) — health
  reports DOWN, process stays up.
- Bind default `127.0.0.1`; tailnet/container exposure is a deployment concern
  (docs), not a code default.
- English only in all artifacts (repo policy). Conventional Commits. `Closes #37`.

## Task list

- [x] T1 — Config + HTTP app + entrypoint + tests. DONE 9ebd598 + hardening
  da6fddf: `http-app.ts` (bearerAuth before routing → 401 precedes 405; fresh
  server+transport per POST inside try/finally; explicit 405 `Allow: POST` for
  GET/DELETE/PUT/PATCH/OPTIONS; /health parallel probes 2s timeout, up|down|
  unconfigured → 200 ok / 503 degraded; `assertHttpConfig` guard), `http.ts`
  (fail-fast on missing token, stderr-only, `server.on("error")` fatal,
  closeIdleConnections + graceful exit 0 on SIGTERM/SIGINT), config additions
  (AMS_MCP_PORT 3111 numeric-validated, AMS_MCP_HOST 127.0.0.1, AMS_MCP_TOKEN),
  deps hono ^4.12.27 + @hono/node-server ^2.0.6 (api-aligned), bin
  `ams-mcp-http`. Tests: 13 integration (real serve() ephemeral + real SDK
  Client via StreamableHTTPClientTransport: initialize→listTools→callTool;
  401+WWW-Authenticate; 405 loop; health 200/503/close-stub; guard unit) +1
  fixer test. Checks: typecheck/test/check green (257 passed | 4 skipped);
  assess=high (process_boundary) → independent verifier verdict **verified**
  (0 blockers, 0 majors; 4 minor fixes applied in da6fddf); parent spot check
  (suite rerun, http-app.ts/http.ts readback, bin.ts + mcp-server.test.ts
  0-line diff vs origin/main — byte-for-byte proof). Route: delegated writer
  (+ delegated fixer + delegated verifier).
- [x] T2 — Docs + verification sweep. DONE 56c4819: `docs/remote-mcp-deployment.md`
  (+170/−5) — status header (implemented on branch, not yet merged), auth
  revision callout (requireBearerAuth → hono/bearer-auth with evidence,
  phase-2 OAuth untouched), deployment surface update, phase-1 runbook
  (Quick path, Configuration table with token charset, Endpoints + failure
  modes, Process behavior, Compose service example with own healthcheck +
  tailnet-only warning), references. Biome does not cover .md — verified via
  full manual readback against source. Route: delegated writer.

## TDD mode

Off (no strict TDD configured; source: repo config + engram). Runner:
`pnpm test` (Vitest). Ordinary functional checks per task.

## Delivery

Delivery (decided 2026-10-03): SINGLE PR with maintainer-approved
`size:exception` (user chose it over chained PRs; precedent #41). Forecast
~650 authored lines (~half tests). No chain strategy needed.

## Acceptance criteria (from issue #37) — ALL VERIFIED

- [x] `packages/mcp` serves Streamable HTTP behind a bearer token with stdio
  default unchanged (bin.ts + mcp-server.test.ts: 0-line diff vs origin/main;
  existing suite green).
- [x] Token auth enforced on the HTTP route (401 without/with bad token,
  WWW-Authenticate asserted; auth precedes method routing — GET unauthenticated
  is 401, not 405).
- [x] Health check covers upstream reachability (API + QMD, parallel 2s
  probes, 503 degraded with per-upstream up|down|unconfigured).
- [x] Config documented (env vars, tailnet-only exposure) — Phase 1 runbook in
  docs/remote-mcp-deployment.md with compose service example.
- [x] Tests cover both transports (13+1 new HTTP integration tests incl. real
  SDK Client lifecycle; stdio suite unchanged and green).

## Known risks

- Per-request `createServer()` resolves config each call — env is stable at
  runtime; acceptable (cheap object, 6 tool registrations).
- `enableJsonResponse` limits server-initiated streams — acceptable phase 1;
  revisit if subscriptions land (#39 or later).
- Hono `bearerAuth` compares timing-safe via its own util — do NOT hand-roll
  comparison in the app layer.
- Docker HEALTHCHECK in image targets the API service; the MCP compose service
  needs its own healthcheck stanza in docs example.

## Progress log

- 2026-10-03: exploration complete (SDK 1.29.0 verified: stateless
  fresh-transport requirement, bearerAuth middleware path, WebStandard
  transport export). Decisions 1-5 settled with user approval (Hono + bearer
  propio; single PR + size:exception). Branch `feat/mcp-streamable-http` from
  `origin/main` @333ca3c. RDD off.
- 2026-10-03: T1 DONE (9ebd598 + da6fddf). Writer → assess high → independent
  verifier `verified` → 4 minor fixes applied → 257 passed | 4 skipped;
  verifier notes for docs: token charset `[A-Za-z0-9._~+/-]+=*`, own compose
  HEALTHCHECK stanza, `realm` identification, bind 0.0.0.0 in container.
  Engram mirror saved as #375 (MCP mem_save hit session ambiguity; CLI route).
- 2026-10-03: T2 DONE (56c4819). Final sweep: typecheck ✓, 257 passed |
  4 skipped ✓, biome check ✓ (78 files). Branch total: 641 insertions / 7
  deletions across 7 files in 3 work-unit commits. Docs discoveries: Hono
  bearer-auth has 3 failure branches (401 no-header, 401 invalid-token,
  400 charset-invalid); wget healthcheck treats 503-degraded as unhealthy by
  design (investigate, don't restart); image CMD boots QMD+API so the MCP
  compose service overrides command entirely; Biome silently ignores .md.
  Acceptance criteria: ALL VERIFIED.

## Next step

- Push branch + open PR (single PR, size:exception approved) with `Closes #37`
  in the description. Post-merge operational step (outside this repo):
  add the compose service on the self-hosted stack per the runbook.
