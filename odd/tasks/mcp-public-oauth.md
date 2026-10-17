# Feature: Public MCP exposure with OAuth 2.1 (issue #39)

## Objective

External app clients (Claude app custom connectors, ChatGPT connectors) can
reach the AMS MCP server over public HTTPS via the existing cloudflared
tunnel, authenticated by OAuth 2.1 (Auth0 as authorization server, AMS as
resource server). Phase 2 of the remote-MCP decision (#27, topology 1).

## Problem / Why

Phase 1 (#37) made the MCP service a long-lived HTTP service, but it is
tailnet-only behind a static bearer token. Claude app and ChatGPT connectors
run on vendor clouds and cannot reach a tailnet service, and a static token is
NOT an acceptable boundary between the public internet and write access to the
memory vault (hard constraint from #27/#39).

## Decisions (2026-10-17, user-approved unless noted)

1. **Cloudflare Access rejected on evidence.** Verified against both vendors'
   docs (2026-10-17): the OpenAI Responses API MCP tool supports an OAuth
   access token in `authorization` only
   (platform.openai.com/docs/guides/tools-remote-mcp); Anthropic's MCP
   connector supports `authorization_token` (OAuth) only
   (platform.claude.com/docs/en/agents-and-tools/mcp-connector). Vendor-cloud
   connector requests cannot complete a Cloudflare Access interactive login
   nor attach Access service-token headers. CF Access would break both target
   clients; it is not a viable option for this issue's stated targets.
2. **OAuth 2.1 resource server + Auth0 as the authorization server**
   (user choice over an in-repo AS). AMS validates tokens; Auth0 issues them.
   Tradeoff accepted: external account + availability dependency in exchange
   for not owning token-issuance code (~150-200 lines saved). The resource
   server half (metadata + validation) is written either way.
3. **SDK auth routers NOT used.** `mcpAuthMetadataRouter` is Express-typed
   (`import express from 'express'`, SDK 1.29.0 `server/auth/router.js`) and
   Express is not a workspace dependency — same finding as #37's
   `requireBearerAuth` revision. The RFC 9728 protected-resource metadata we
   need is one static JSON route served from Hono; the AS metadata (RFC 8414)
   is served by Auth0 itself, not by us.
4. **Dual credentials on `POST /mcp`.** Static token (phase 1, tailnet agents
   like OpenCode) OR Auth0 JWT (public connectors). Static token check stays
   first (timing-safe, fail-fast at startup unchanged); JWT verification runs
   when the static token doesn't match and OAuth env is configured.
5. **JWT validation via `jose`** (`createRemoteJWKSet` + `jwtVerify`):
   RS256, issuer + audience + expiry claims. No scope enforcement in v1
   (single user; scope config adds connector-UI friction; can be added
   later). Audience-only authorization, documented.
6. **OAuth layer optional via env** (`AMS_MCP_OAUTH_ISSUER`,
   `AMS_MCP_OAUTH_AUDIENCE`): unset = phase 1 behavior only (tailnet
   deployments unaffected); set = JWTs also accepted.
7. **In-app rate limiting on the public path** keyed on `CF-Connecting-IP`
   (fallback: socket address), configurable, default conservative; plus a
   documented Cloudflare edge WAF rate-limiting rule (ops step). Defense in
   depth: edge rule is primary, in-app limiter bounds what a tunnel bypass
   (direct tailnet hit) can do.
8. **Cloudflared/DNS/Auth0/dashboard changes are documented runbook steps**,
   not repo changes: the tunnel and CF account live outside this repository.
   Connector E2E verification needs the deployed endpoint + user accounts
   (user-assisted step at the end).

## Scope

- IN: OAuth config + JWT middleware + RFC 9728 metadata route + rate limiting
  in `packages/mcp` (with tests), phase 2 runbook in
  `docs/remote-mcp-deployment.md` (cloudflared ingress + DNS, Auth0 setup for
  both connectors, credential rotation, edge rate limiting, compatibility
  matrix), feature doc + engram mirror.
- OUT: replacing the static token path (phase 1 keeps working), Cloudflare
  Access (rejected), an in-repo authorization server (rejected), Auth0
  tenant/dashboard mutations (runbook only — needs the user's CF/Auth0
  accounts), actual deployment on the self-hosted server (post-merge ops).

## Constraints

- stdio path and phase 1 HTTP behavior remain unchanged when OAuth env unset.
- English only in all artifacts (repo policy). Conventional Commits.
  `Closes #39`.
- `pnpm typecheck && pnpm test && pnpm check` green before each work-unit
  commit.
- 401 responses must keep proper `WWW-Authenticate` challenges; when OAuth is
  enabled, include RFC 9728 `resource_metadata` hint where feasible.

## Task list

- [x] T1 — OAuth core. DONE 23d8681 + hardening f0fa055: config triple
  (`AMS_MCP_OAUTH_ISSUER`/`_AUDIENCE`/`_PUBLIC_URL`, all-or-none ConfigError,
  https/no-query/no-trailing-slash validation, issuer kept verbatim for jose
  literal iss compare), dual-credential auth on /mcp (hono `bearerAuth`
  `verifyToken`: static token timing-safe first, then jose `jwtVerify` with
  RS256 pin + iss/aud + `requiredClaims: ["exp"]`; all JWT failures collapse
  to 401 invalid_token; JWKS built once per app), RFC 9728 PRM route mounted
  only when OAuth configured, `jose ^6.2.12` dep, 18 integration tests (real
  serve() + real SDK client + local JWKS stub: valid round-trip, static-token
  paths both modes, expired/wrong-aud/wrong-iss/rogue-key-kid-spoof/missing-
  exp/alg:none/HS256-with-public-JWK all 401, 400 charset branch with
  resource_metadata, PRM served/absent, config unit tests). Checks: typecheck
  ✓, 275 passed | 4 skipped ✓, biome check ✓ (79 files). Verification:
  assess=high (process_boundary, same as #37) → independent verifier verdict
  **verified-with-minors** (0 blockers, 0 majors) → 2 minors fixed in f0fa055
  (requiredClaims exp; 400-branch RFC 9728 hint) + 4 verifier-recommended
  regression tests. Phase-1 suite unchanged (http-server.test.ts untouched).
  Route: delegated writer + delegated independent verifier + inline fixer
  (mechanical, fully-specified minors).
- [x] T2 — Rate limiting. DONE defdc01 + fix 72800c3: `packages/mcp/src/rate-limit.ts`
  (hand-rolled fixed-window Map, absolute minute boundaries, lazy pruning >10k
  keys — hono 4.12.27 ships no rate-limiter middleware, verified), key =
  CF-Connecting-IP → socket remote address via `getConnInfo`
  (@hono/node-server/conninfo, try/catch → "unknown"), mounted BEFORE auth on
  /mcp only (/health + PRM unlimited), 429 + Retry-After [1,60], config
  `AMS_MCP_RATE_LIMIT` (default 120, 0 disables, integer-validated),
  injectable via HttpAppOptions for tests. 11 new tests. Checks: typecheck ✓,
  286 passed | 4 skipped ✓, biome ✓. Verification: assess=high
  (process_boundary) → independent verifier verdict **verified-with-minors**
  (0 blockers, 0 majors) → minor fixed in 72800c3 (whitespace-only env value
  failed open to disabled; now trims → fails safe to default). Verifier
  analyses to carry into T3: CF-Connecting-IP trust assumption must be
  documented verbatim (edge owns the header on the public path; direct
  tailnet hits are inside the trusted perimeter — evasion there is
  by-design-out-of-scope). Route: delegated writer + delegated verifier +
  inline fixer.
- [x] T3 — Docs. DONE c302cb8: `docs/remote-mcp-deployment.md` +456/−12 —
  status header refresh, public-path mermaid + population table, env table
  matching config.ts, worked compose example, Auth0 setup (API +
  Applications per connector, verified callbacks, PKCE, lifetimes, DCR
  correction: exists but disabled-by-default — manual registration
  recommended), Claude + ChatGPT connector steps, compatibility matrix with
  decision-1 evidence (sources + retrieval dates), cloudflared both forms
  (dashboard + config.yml) + DNS CNAME, CF edge rate-limiting rule
  (edge-primary framing), CF-Connecting-IP trust assumption verbatim, 3
  rotation procedures, references. 2 facts marked UNVERIFIED in-doc (Auth0
  RFC 8414 at tenant root; ChatGPT builder UI labels). pnpm check clean; git
  status: only docs file in commit. assess=passive (non_executable_only) →
  structural readback + parent spot check. Route: delegated writer (skills:
  cognitive-doc-design + work-unit-commits).
- [ ] T4 — Post-deploy connector verification (user-assisted, outside repo):
  Claude app + ChatGPT connector smoke test against the deployed endpoint;
  record outcomes in the issue; close remaining gaps if any.

## TDD mode

Off (no strict TDD configured; source: repo config + #37 doc). Runner:
`pnpm test` (Vitest). Ordinary functional checks per task.

## Delivery

Forecast ~450-550 authored lines; actual ~1470 (9 files, +1449/−21).
DECIDED 2026-10-17 (user): SINGLE PR with maintainer-approved
`size:exception` (precedent #37/#42) — cohesive single-issue feature,
docs describe the exact code. RDD: off (verified 2026-10-17, default).

## Acceptance criteria (from issue #39)

- HTTPS route for the MCP endpoint via the existing cloudflared tunnel —
  runbook documents DNS/funnel config (ops applied by user post-merge).
- Auth upgrade: OAuth 2.1 resource server with Auth0 — code + runbook.
- Token/credential rotation documented.
- Rate limiting / abuse protection at the public edge — in-app limiter +
  documented CF edge rule.
- Connector compatibility verified against both target apps (research
  recorded; live E2E in T4 post-deploy).

## Progress log

- 2026-10-17 (deploy): T4 operational phase. ams-mcp deployed on the
  self-hosted stack (compose + /opt/.env with backups; replica PR
  leandroFernandez94/home-server#9). Public endpoint
  https://ams.losfernandez.net live: health/PRM/401-with-hint verified from
  the internet; tunnel ingress rule order fixed (wildcard shadowed). Auth0
  tenant dev-jz3zfzqovpyonc7i.eu.auth0.com; RFC 8414 tenant-root discovery
  VERIFIED live (issuer exact with trailing slash, S256).

- 2026-10-17: exploration complete. Issue + dependency #37 (merged) read;
  phase 1 code reviewed (`http-app.ts`, SDK 1.29.0 auth sources). Vendor
  docs verified: OAuth-only for both target connectors → CF Access rejected
  (decision 1). User chose Auth0 over in-repo AS (decision 2). Branch
  `feat/mcp-public-oauth` from origin/main @7f4d61e. Skills resolved from
  `.atl/skill-registry.md`. RDD off.
- 2026-10-17: T1 DONE (23d8681 + f0fa055, 627 branch lines so far). Writer
  kept hono bearerAuth (installed 4.12.27 supports async verifyToken +
  object-form wwwAuthenticateHeader → RFC 9728 hints ride standard
  challenges); jose ^6.2.12 (no exportJWKSPublic in v6 — exportJWK).
  Independent verifier: verified-with-minors; fixed both minors + added
  alg:none / HS256-public-key / missing-exp / 400-hint regression tests.
  Engram: MCP mem_save hits session ambiguity → CLI route `engram save
  ... --project ams` works (#395-#397).
- 2026-10-17: T2 DONE (defdc01 + 72800c3). Writer: hono has no rate-limiter
  middleware in 4.12.27 (verified node_modules) → hand-rolled fixed window;
  getConnInfo throws without adapter bindings (try/catch); bearerAuth's
  missing-header path skips verifyToken → no JWKS I/O without a presented
  token. Verifier probes: pruning safe, Retry-After edges correct, key
  rotation on direct tailnet hits evades per-client limiting (accepted:
  trusted perimeter, edge rule is primary — MUST document in T3). Engram
  #398-#400 (CLI route for session-ambiguity fallback).
- 2026-10-17: T3 DONE (c302cb8). Facts verified 2026-10-17: Claude redirect
  https://claude.ai/api/mcp/auth_callback; ChatGPT two redirect forms
  (connector_platform_oauth_redirect + callback-ID form); Auth0 DCR exists
  but disabled-by-default (corrects the "no RFC 7591" assumption from the
  Auth0 decision — manual registration still recommended). Branch total:
  9 files, +1449/−21 (~1470 authored lines) → delivery decision due
  (budget ~400 exceeded; ask-on-risk). Engram #402.

## Next step

- T4 (in progress, 2026-10-17): **Claude app connector E2E VERIFIED** against
  the deployed endpoint — full OAuth flow (discovery → authorize → PKCE →
  JWT) succeeded. Field findings recorded in the runbook troubleshooting
  section: Auth0 new tenants map RFC 8707 `resource` → audience (API
  identifier MUST be the public server URL; free-form identifier failed with
  `Service not found`), new APIs require the Application Access toggle per
  connector app, tunnel ingress is first-match-wins (wildcard shadowed the
  specific rule; reordered), dashboard user-creation bug worked around via
  Management API (M2M + create:users).
- Remaining T4: ChatGPT connector E2E (same pattern; redirect URI from its
  management page into the `AMS MCP — ChatGPT` callbacks), Cloudflare edge
  rate-limiting rule, record final outcomes on issue #39.
