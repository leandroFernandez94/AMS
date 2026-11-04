# Deploying AMS with Docker

Run the full AMS stack (Write API + QMD search daemon + MCP HTTP server) from
the CI-published image. This page is the complete reference: a runnable
compose file, what the image does at boot, and every environment variable the
stack reads.

## Quick path

1. Copy the env template and adjust it:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and, for the compose file below, change exactly four values:

   ```dotenv
   AMS_MCP_TOKEN=<your token>          # openssl rand -base64 32
   AMS_MCP_HOST=0.0.0.0                # bind-all inside the container
   AMS_API_URL=http://ams:3000         # docker-network service name
   AMS_QMD_URL=http://ams:8181         # docker-network service name
   ```

2. Save the compose file from the next section as `compose.yaml` and start it:

   ```bash
   docker compose up -d
   ```

3. Verify:

   ```bash
   curl http://localhost:3000/health   # {"status":"ok"} — Write API
   curl http://localhost:3111/health   # MCP HTTP service, unauthenticated probe
   ```

Point MCP clients at `http://localhost:3111/mcp` with header
`Authorization: Bearer <your token>`. To expose that endpoint beyond your
private network, continue to [mcp-remote.md](mcp-remote.md).

## The image

One image — [`ghcr.io/leandrofernandez94/ams`](https://github.com/leandroFernandez94/AMS/pkgs/container/ams)
— runs everything. It is built from the repo [Dockerfile](../../Dockerfile)
on every push to `main` and published with these tags:

| Tag | Meaning |
|---|---|
| `latest` | Last build of `main` |
| `sha-<short>` | Immutable per-commit build (pin deployments to this) |
| `<version>`, `<major>.<minor>` | Cut on `v*.*.*` git tags |

Platforms: `linux/amd64`.

### What one container runs

The `ams` service runs the two server-side processes in a single container:

| Process | Port | Role |
|---|---|---|
| Write API (Hono) | `3000` | Validated note writes, locks, reindex scheduler |
| QMD daemon (`qmd mcp --http`) | `8181` | Hybrid (lexical + semantic) search over the vault |

The MCP HTTP server is **not** run by this container — it gets its own
service (`ams-mcp`) from the same image, overriding the command. All mutable
state lives under the `/data` volume:

| Path | Content |
|---|---|
| `/data/vault` | The note vault (plain Markdown files) |
| `/data/qmd/.qmd` | QMD project registry |
| `/data/.cache/qmd` | Embedding models + search index (survives container recreation via `HOME=/data`) |

The image ships a `HEALTHCHECK` probing the Write API `GET /health` every 30s
(`docker ps` shows it; the `ams-mcp` service adds its own probe on `:3111`).

### First boot: expect a ~300MB download

The first indexing cycle downloads a ~300MB embedding model before indexing
anything — one time only. It is cached at `/data/.cache/qmd` inside the
volume, so later boots (and container recreations) skip the download and start
fast. A slow first boot is normal, not a failure; watch progress with
`docker compose logs -f ams`.

### Single replica only

Run exactly **one** replica of the `ams` service. The monolith is not
horizontally scalable today:

- Write locks are an in-memory, single-instance registry
  (`packages/api/src/lock.ts` — distributed locking is explicitly out of
  scope). Two replicas accept concurrent writes to the same note.
- The reindexer's dirty-note tracking is likewise in-memory, and two
  schedulers would race over the same `.qmd` registry on the volume.

Scale reads, not replicas: `ams-mcp` is stateless (each request is an
independent HTTP round-trip), so you may run several of those against one
`ams` backend.

## Compose file

Two services, one image, one env file:

```yaml
services:
  ams:
    image: ghcr.io/leandrofernandez94/ams:latest
    env_file: .env
    ports:
      - "3000:3000"   # Write API
      - "8181:8181"   # QMD search daemon
    volumes:
      - ams-data:/data
    restart: unless-stopped

  ams-mcp:
    image: ghcr.io/leandrofernandez94/ams:latest
    command: node packages/mcp/dist/http.js
    env_file: .env
    ports:
      - "3111:3111"   # MCP Streamable HTTP
    restart: unless-stopped

volumes:
  ams-data:
```

Notes:

- `env_file: .env` loads the template values into both containers; each
  process reads only its own variables, so the overlap is harmless. The four
  values you set in the quick path are what the `ams-mcp` service needs.
- `ams-mcp` reaches the upstreams over the docker network
  (`http://ams:3000`, `http://ams:8181`) — no ports needed beyond what you
  want to publish.
- Overriding `command` replaces the image's boot sequence, so `ams-mcp` runs
  only the MCP service.
- To build locally instead of pulling, replace `image:` with
  `build: .` on both services.

## Environment variable reference

Every variable the stack reads, with its default as resolved in code (or by
the image boot script). "Consumer" says which process reads it.

### Vault & Write API

| Variable | Default | Consumer | Purpose |
|---|---|---|---|
| `AMS_VAULT_PATH` | **required** (`/data/vault` in the image) | Write API | Path to the vault root |
| `AMS_API_PORT` | `3000` | Write API | HTTP port |
| `AMS_LOCK_TTL_MS` | `5000` | Write API | Write-lock TTL in ms (crashed writers cannot deadlock a note) |

### Indexing & QMD retrieval

| Variable | Default | Consumer | Purpose |
|---|---|---|---|
| `AMS_INDEX_CRON` | `*/2 * * * *` | Write API | Reindex schedule (node-cron expression) |
| `AMS_INDEX_ENABLED` | `true` | Write API | Indexing kill-switch (`false` = schedule nothing) |
| `AMS_QMD_COLLECTION` | unset | Write API | Scope `qmd update`/`qmd embed` to one collection; unset = all |
| `AMS_QMD_BIN` | `qmd` | Write API | Path to the QMD CLI binary |
| `AMS_QMD_URL` | `http://localhost:8181` | Write API, MCP | QMD daemon base URL (`http://ams:8181` in compose) |

### MCP server

| Variable | Default | Consumer | Purpose |
|---|---|---|---|
| `AMS_API_URL` | **required** (no default) | MCP (both transports) | Write API base URL (`http://ams:3000` in compose) |
| `AMS_MCP_PORT` | `3111` | MCP HTTP | Streamable HTTP listener port |
| `AMS_MCP_HOST` | `127.0.0.1` | MCP HTTP | Bind address (`0.0.0.0` inside containers) |
| `AMS_MCP_TOKEN` | **required** (HTTP mode) | MCP HTTP | Static bearer token for `POST /mcp`; charset `[A-Za-z0-9._~+/-]+=*` |
| `AMS_MCP_OAUTH_ISSUER` | unset | MCP HTTP | OAuth 2.1 triple — all three set together or none |
| `AMS_MCP_OAUTH_AUDIENCE` | unset | MCP HTTP | OAuth audience matched against the JWT `aud` claim |
| `AMS_MCP_PUBLIC_URL` | unset | MCP HTTP | Public HTTPS base URL of this service (no trailing slash) |
| `AMS_MCP_RATE_LIMIT` | `120` | MCP HTTP | Max requests/min per client key on `POST /mcp` (`0` disables) |

### Docker image internals

Read by the container boot script (not by TypeScript code); override only
when restructuring the volume layout.

| Variable | Default | Purpose |
|---|---|---|
| `QMD_PORT` | `8181` | Port the QMD daemon and its IPv4 socat bridge bind inside the container |
| `QMD_PROJECT_DIR` | `/data/qmd` | Directory holding the `.qmd` project registry on the volume |

## Where to go next

- [mcp-remote.md](mcp-remote.md) — exposing the MCP endpoint remotely: token
  mode end to end, OAuth 2.1 + Auth0, cloudflared tunnel, rate limiting.
- [../quickstart.md](../quickstart.md) — first-run walkthrough and the
  record → index → search loop.
- [../e2e-runbook.md](../e2e-runbook.md) — reproducing the full loop
  manually, with troubleshooting.
