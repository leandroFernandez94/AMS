# AMS Quick Start

From zero to a working record → search → read loop: start AMS, connect an MCP
client, record a note, let the index pick it up, and read it back. The path
you take to that loop depends on how you want to test AMS — pick one below.

> First run downloads a ~300MB embedding model (one time only, then cached —
> from source in `~/.cache/qmd/models/`, under Docker at `/data/.cache/qmd`
> inside the `ams-data` volume). Expect the first indexing to take a few
> minutes; later runs are fast.

## Choosing your installation path

| You want to… | Path | Needs |
|---|---|---|
| Try AMS right now against a local vault, no toolchain | [A. Docker only](#a-run-ams-with-docker-only) | Docker |
| Keep the server in Docker but run your own agent locally over stdio | [B. Docker backend + local stdio MCP](#b-docker-backend--local-stdio-mcp) | Docker + a checkout |
| Develop on AMS, or run everything from source | [C. From source](#c-from-source) | Node 22, pnpm, qmd ≥ 2.5.3 |

Path A is the fastest first contact — one compose file, nothing installed on
your machine. Path B fits agents running on your own machine that talk to a
Docker backend over stdio (mind the same-host security caveat). Path C is for
developing on AMS, or when you do not want Docker at all.

## A. Run AMS with Docker only

Two containers from one compose file: `ams` runs the Write API (`:3000`) and
the QMD search daemon (`:8181`); `ams-mcp` runs the MCP HTTP server (`:3111`).
Your notes live in a Docker volume.

### 1. Save the compose file and start it

Save this as `compose.yaml` and run `docker compose up -d`:

```yaml
services:
  ams:
    image: ghcr.io/leandrofernandez94/ams:latest
    ports:
      - "3000:3000"   # Write API
      - "8181:8181"   # QMD search daemon
    volumes:
      - ams-data:/data
    restart: unless-stopped

  ams-mcp:
    image: ghcr.io/leandrofernandez94/ams:latest
    command: node packages/mcp/dist/http.js
    environment:
      AMS_MCP_TOKEN: "change-me"   # openssl rand -base64 32
      AMS_MCP_HOST: "0.0.0.0"
      AMS_API_URL: "http://ams:3000"
      AMS_QMD_URL: "http://ams:8181"
    ports:
      - "3111:3111"   # MCP Streamable HTTP
    restart: unless-stopped

volumes:
  ams-data:
```

Replace the `AMS_MCP_TOKEN` placeholder (`change-me`) with a token of your
own — `openssl rand -base64 32` qualifies. The image is published for
`linux/amd64`.

### 2. Let the first boot settle

On first boot the `ams` container creates the vault, initializes the QMD
registry and registers the vault as a collection — no manual setup, safe to
repeat. The first indexing cycle downloads a ~300MB embedding model (one time
only; it stays cached at `/data/.cache/qmd` inside the `ams-data` volume).
Later boots reuse that cache and start fast.

### 3. Verify both services

```bash
curl http://localhost:3000/health   # {"status":"ok"} — Write API
curl http://localhost:3111/health   # MCP HTTP service, unauthenticated probe
```

### 4. Connect an MCP client and run the loop

Point any MCP-capable client at `http://localhost:3111/mcp` with the header
`Authorization: Bearer <token>` (your `AMS_MCP_TOKEN`; only `GET /health` is
unauthenticated — `POST /mcp` requires the token). Then run the loop:

1. `record_note({ title: "First note", type: "note", body: "Hello AMS — the loop works." })`
2. Force a reindex — `curl -X POST http://localhost:3000/admin/reindex` — or
   wait ~2 minutes for the scheduler.
3. `search_memory({ query: "hello AMS" })` → grab the `#docid` from a hit →
   `get_memory({ file: "#<docid>" })` returns the full note.

### 5. Know where your notes live

Every note is a plain `.md` file in `/data/vault` inside the `ams-data`
volume. Peek inside the container:

```bash
docker compose exec ams ls /data/vault
```

The volume is an ordinary Docker volume — mount it in another container or
back it up whenever you want the files at hand.

## B. Docker backend + local stdio MCP

The `ams` container does not run the stdio MCP server — each local agent
launches it next to itself. In this path Docker runs only the backend (Write
API + QMD daemon); your agent's MCP client starts the stdio server from a
checkout on the same machine.

### 1. Start only the backend

Save the compose file from [path A](#1-save-the-compose-file-and-start-it)
(trim it to just the `ams` service and the `volumes:` block if you prefer)
and bring up only that service:

```bash
docker compose up -d ams
curl http://localhost:3000/health   # {"status":"ok"}
```

### 2. Clone and build the MCP server

The stdio server runs from a checkout on your machine:

```bash
git clone <repo-url> /path/to/ams
cd /path/to/ams
pnpm install
pnpm build      # tsc --build, compiles all packages to dist/
```

### 3. Point an MCP client at the stdio server

```json
{
  "ams": {
    "command": "node",
    "args": ["/path/to/ams/packages/mcp/dist/bin.js"],
    "environment": {
      "AMS_API_URL": "http://<docker-host>:3000",
      "AMS_QMD_URL": "http://<docker-host>:8181"
    }
  }
}
```

`<docker-host>` is `localhost` when the client runs on the machine hosting
Docker.

> **Security note:** stdio has no authentication of any kind — the agent and
> everything it talks to run under your own responsibility. Use it only for
> agents and upstreams on the same host you control; the full note lives in
> the [README](../README.md).

### 4. Smoke-test the loop

From the client: `record_note` → force a reindex with
`curl -X POST http://localhost:3000/admin/reindex` (or wait ~2 minutes) →
`search_memory` → `get_memory` on the `#docid` of a hit.

## C. From source

From a fresh clone to a working record → search → read loop in about ten
minutes. You will install QMD (the external search engine), start two
processes (QMD daemon + Write API), connect an MCP client, and verify with
the e2e suite.

1. [Install prerequisites](#1-install-prerequisites)
2. [Clone and build](#2-clone-and-build)
3. [Create a vault and register it with QMD](#3-create-a-vault-and-register-it-with-qmd)
4. [Start the QMD daemon](#4-start-the-qmd-daemon)
5. [Start the Write API](#5-start-the-write-api)
6. [Smoke-test the loop](#6-smoke-test-the-loop)
7. [Connect an MCP client](#7-connect-an-mcp-client)
8. [Run the e2e suite](#8-run-the-e2e-suite)

### 1. Install prerequisites

- Node.js >= 22
- pnpm (the repo pins `pnpm@11.5.2` via `packageManager`)
- QMD >= 2.5.3, installed globally:

  ```bash
  npm i -g @tobilu/qmd
  qmd --version   # must report >= 2.5.3
  ```

### 2. Clone and build

```bash
git clone <repo-url> /path/to/ams
cd /path/to/ams
pnpm install
pnpm build      # tsc --build, compiles all packages to dist/
```

### 3. Create a vault and register it with QMD

AMS stores notes as plain Markdown in a vault directory you own. QMD needs a
local registry (created by `qmd init`) plus a collection pointing at the
vault:

```bash
mkdir -p ~/ams-workspace/vault
cd ~/ams-workspace        # the .qmd registry lives here
qmd init
qmd collection add "$HOME/ams-workspace/vault" --name ams
```

> Keep the workspace directory (`~/ams-workspace`) as your working directory
> for steps 4 and 5: the Write API shells out to `qmd update`, which resolves
> the `.qmd` registry relative to the process working directory.

### 4. Start the QMD daemon

In one terminal:

```bash
cd ~/ams-workspace
qmd mcp --http            # binds the loopback on :8181 by default
```

### 5. Start the Write API

In another terminal, from the same workspace directory:

```bash
cd ~/ams-workspace
AMS_VAULT_PATH="$HOME/ams-workspace/vault" node /path/to/ams/packages/api/dist/server.js
```

The API listens on `:3000`. Sanity check: `curl -s http://localhost:3000/health`
returns `{"status":"ok"}`.

### 6. Smoke-test the loop

Record a note through the Write API:

```bash
curl -s -X POST http://localhost:3000/notes \
  -H "content-type: application/json" \
  -d '{"title":"First note","type":"note","body":"Hello AMS — the loop works."}'
```

Force one indexing cycle (otherwise the embedded scheduler runs every 2
minutes):

```bash
curl -s -X POST http://localhost:3000/admin/reindex
```

Then search from your connected MCP client (next step):
`search_memory({ query: "hello AMS" })` → grab the `#docid` from a hit →
`get_memory({ file: "#<docid>" })` returns the full note.

### 7. Connect an MCP client

#### stdio (runs wherever the client runs)

```json
{
  "ams": {
    "command": "node",
    "args": ["/path/to/ams/packages/mcp/dist/bin.js"],
    "environment": {
      "AMS_API_URL": "http://localhost:3000",
      "AMS_QMD_URL": "http://localhost:8181"
    }
  }
}
```

*stdio has no authentication — use it only when everything runs on the same
host you control; see the security note in the [README](../README.md).*

#### Streamable HTTP (shared service)

Start the HTTP entrypoint (token must match the
`[A-Za-z0-9._~+/-]+=*` charset — `openssl rand -base64 32` qualifies):

```bash
AMS_MCP_TOKEN="<token>" AMS_API_URL=http://localhost:3000 \
  node /path/to/ams/packages/mcp/dist/http.js
  # or: pnpm exec ams-mcp-http
```

Point a remote-capable client at `http://127.0.0.1:3111/mcp` with an
`Authorization: Bearer <token>` header. Unauthenticated health probe:
`curl -s http://127.0.0.1:3111/health`.

### 8. Run the e2e suite

```bash
cd /path/to/ams
pnpm e2e       # boots a temp vault + real QMD daemon, drives the full loop
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `search_memory` returns no hits | Note not indexed yet — `POST /admin/reindex` or wait for the cron tick |
| First run is very slow | Embedding model download (~300MB) — wait; cached afterwards (`~/.cache/qmd/models/` from source, `/data/.cache/qmd` in the `ams-data` volume under Docker) |
| QMD daemon unreachable | Check it is running and that `AMS_QMD_URL` matches its bound host/port |
| `qmd` not on PATH | `npm i -g @tobilu/qmd` |
| A container misbehaves | Read its logs: `docker compose logs ams` (or `docker compose logs ams-mcp`) |
| MCP container up, tools fail | Check the upstreams: is the `ams` service healthy (`curl http://localhost:3000/health`)? Do `AMS_API_URL` / `AMS_QMD_URL` point at it? |

More: [architecture.md](architecture.md) (how the pieces fit),
[notes-processing.md](notes-processing.md) (note anatomy and the
write/update/delete lifecycle), [e2e-runbook.md](e2e-runbook.md) (loop
reproduction and troubleshooting), [retrieval-runbook.md](retrieval-runbook.md)
(QMD daemon operations).
