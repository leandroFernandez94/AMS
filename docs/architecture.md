# AMS — Architecture

AMS is a Markdown-first shared memory system for AI agents. This document
describes the system as built: components, the write path, the read path, the
note contract, the authentication model, configuration, and operational
caveats. Deployment specifics live in [Example deployment](#example-deployment)
(placeholder values only) and in
[remote-mcp-deployment.md](remote-mcp-deployment.md).

Related runbooks: [e2e-runbook.md](e2e-runbook.md) (end-to-end loop),
[retrieval-runbook.md](retrieval-runbook.md) (QMD daemon ops),
[quickstart.md](quickstart.md) (first run).

## Topology

AMS ships two deployment shapes. The components are the same; what changes is
where the MCP server runs and how it is authenticated.

### Local stdio deployment

![Local stdio deployment](assets/deployment-stdio.png)

The MCP server runs as a child process on the agent's host — no
authentication, because it is local — and points `AMS_API_URL` /
`AMS_QMD_URL` at the vault host.

### Remote HTTP deployment

![Remote HTTP deployment](assets/deployment-http.png)

The MCP server runs on the vault host as a stateless Streamable HTTP service
(`POST /mcp`) gated by a static bearer token and, optionally, an OAuth 2.1
resource-server mode (RS256/JWKS).

## Write path (note → index)

```
agent → record_note ──► Write API :3000
                          1. Zod validates NoteInput (packages/shared)
                          2. id = slug(title) → <type>s/<id>.md
                          3. in-memory lock (path-scoped, TTL 5s, FIFO;
                             old+new paths in sorted order for topic_key renames)
                          4. serializeNote (frontmatter + body) → writes the vault
                          5. marks <vault>/.ams/dirty.json  (delete → immediate tick)
IndexScheduler (cron */2 * * * *, IN the API process — no separate daemon)
                          6. drains dirty → execFile: qmd update + qmd embed
                             (collection-scoped via AMS_QMD_COLLECTION when set)
                          7. on success → clears dirty.json
```

## Read path (search)

```
agent → search_memory ──► QMD daemon :8181 (JSON-RPC, initialize handshake + session-id)
                           hybrid lexical+vector, RRF fusion → hits with docid #abc123
agent → get_memory(#abc123) ──► QMD get → full note body
```

Asymmetry to remember: `get_memory` needs the **docid** returned by
`search_memory`; a vault-relative path does not resolve.

## Note contract (three axes)

| Axis | Question | Mechanic |
|---|---|---|
| `type` | **WHERE** it lives | folder `<type>s/<id>.md` in the vault |
| `topic_key` | **WHO** it is | upsert in place: same key → same note, rename leaves no orphans |
| `tags` | **WHAT** it is about | semantic relations; discover vocabulary via `GET /tags` / `list_tags` |

## Write API routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness (`{status:"ok"}`); Docker HEALTHCHECK target |
| GET | `/types` | note types = first-level vault dirs (dot-dirs skipped) |
| GET | `/tags` | tag vocabulary + per-tag note counts |
| POST | `/notes` | create/upsert note (Zod `NoteInputSchema`; `topic_key` routing; `overwrite`; 409 returns existing body) |
| DELETE | `/notes/:path{.+}` | delete note at vault-relative path (blocks `..`, backslashes, absolute, dot-dirs) |
| POST | `/admin/reindex` | force one indexing cycle (`scheduler.tick()`) |

## Authentication (three client paths)

1. **Host local / stdio**: the MCP server is spawned as a child process by the
   client (`packages/mcp/dist/bin.js`) and points `AMS_API_URL` /
   `AMS_QMD_URL` at the host. No auth — the process is local, and the
   upstreams sit on loopback or a private network.
2. **Private network**: `POST http://<private-host>:3111/mcp` with a static
   bearer token (`AMS_MCP_TOKEN`).
3. **Public**: `https://mcp.example.com/mcp` → TLS edge → OAuth 2.1 RS256 JWT
   (issuer `https://<tenant>.auth0.com/`, audience
   `https://mcp.example.com/mcp`, remote JWKS validation). The static token
   remains valid too (dual credential: static token first, then JWT).

Rate limit: 120 req/min per client (`CF-Connecting-IP` → socket remote addr →
`unknown`), mounted **before** auth. `GET /health` and the RFC 9728 metadata
endpoint (`/.well-known/oauth-protected-resource/mcp`) are unauthenticated.

## Configuration

| Variable | Component | Default | Purpose |
|---|---|---|---|
| `AMS_VAULT_PATH` | Write API | **required** | path to the vault root |
| `AMS_API_PORT` | Write API | `3000` | HTTP port |
| `AMS_LOCK_TTL_MS` | Write API | `5000` | write-lock TTL (ms) |
| `AMS_INDEX_CRON` | Write API | `*/2 * * * *` | reindex schedule (node-cron) |
| `AMS_INDEX_ENABLED` | Write API | `true` | indexing kill-switch |
| `AMS_QMD_COLLECTION` | Write API | — | scope `qmd update`/`qmd embed` to one collection |
| `AMS_QMD_BIN` | Write API | `qmd` | path to the QMD CLI binary |
| `AMS_API_URL` | MCP (both transports) | **required** | Write API base URL |
| `AMS_QMD_URL` | MCP (both transports) | `http://localhost:8181` | QMD daemon base URL |
| `AMS_MCP_TOKEN` | MCP HTTP | **required** | static bearer token for `POST /mcp` |
| `AMS_MCP_PORT` | MCP HTTP | `3111` | HTTP listener port |
| `AMS_MCP_HOST` | MCP HTTP | `127.0.0.1` | bind address |
| `AMS_MCP_RATE_LIMIT` | MCP HTTP | `120` | max requests/min per client (`0` disables) |
| `AMS_MCP_OAUTH_ISSUER` / `AMS_MCP_OAUTH_AUDIENCE` / `AMS_MCP_PUBLIC_URL` | MCP HTTP | unset | OAuth 2.1 resource-server triple — all-or-none |

## Example deployment

A concrete but fully generic single-host deployment. Every identifier below is
a placeholder — substitute your own values. The full HTTP + OAuth deployment
runbooks live in
[remote-mcp-deployment.md](remote-mcp-deployment.md).

- Two containers from one image, `ghcr.io/<owner>/ams:latest`, on a shared
  Docker network:
  - `ams` — runs the Write API as its entrypoint with the QMD daemon beside
    it (API `:3000`, QMD `:8181`).
  - `ams-mcp` — runs the MCP HTTP entrypoint (`node packages/mcp/dist/http.js`).
- The vault is bind-mounted at `/vault`; QMD data (`.qmd` registry, embedding
  model, index cache) at `/qmd-data`.
- `ams-mcp` reaches the upstreams over Docker DNS (`http://ams:3000`,
  `http://ams:8181`) — that traffic never leaves the Docker network.

| Port | Serves | Example exposure |
|---|---|---|
| 3000 | Write API (Hono) | `<tailnet-ip>:3050` → 3000 (private network only) |
| 8181 | QMD daemon (search) | `<tailnet-ip>:8182` → 8181 (private network) |
| 3111 | MCP Streamable HTTP | `<tailnet-ip>:3111` (private) + `https://mcp.example.com` (public, via tunnel) |

## Operational caveats

- **Single replica by design**: write locks, rate limiter and dirty store are
  in-process memory. A second API replica breaks lock correctness.
- **qmd 2.5.3** binds `::1` only even with `--host 0.0.0.0` — hence a `socat`
  TCP4→TCP6 bridge inside the container when the daemon must be reachable
  from other containers.
- `qmd update` cannot be scoped to one collection (only `embed -c`): update
  re-scans every registered collection.
- First `qmd embed` downloads a ~300MB embedding model (cached in
  `~/.cache/qmd/models/`).
- Healthchecks: the API container probes `GET :3000/health`; the MCP container
  probes `GET :3111/health`, which checks upstream API + QMD health (2s
  timeout each) and degrades to `503`.
- The QMD daemon enforces the MCP session contract (`initialize` handshake +
  `mcp-session-id` echo) despite what its README suggests; `packages/shared`
  `qmd/http.ts` handles it (protocol `2025-06-18`).
