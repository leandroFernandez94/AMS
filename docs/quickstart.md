# AMS Quick Start

From a fresh clone to a working record → search → read loop in about ten
minutes. You will install QMD (the external search engine), start two
processes (QMD daemon + Write API), connect an MCP client, and verify with
the e2e suite.

> First run downloads a ~300MB embedding model (cached in
> `~/.cache/qmd/models/`, reused afterwards). Expect the first indexing to
> take a few minutes; later runs are fast.

## Quick path

1. [Install prerequisites](#1-install-prerequisites)
2. [Clone and build](#2-clone-and-build)
3. [Create a vault and register it with QMD](#3-create-a-vault-and-register-it-with-qmd)
4. [Start the QMD daemon](#4-start-the-qmd-daemon)
5. [Start the Write API](#5-start-the-write-api)
6. [Smoke-test the loop](#6-smoke-test-the-loop)
7. [Connect an MCP client](#7-connect-an-mcp-client)
8. [Run the e2e suite](#8-run-the-e2e-suite)

## 1. Install prerequisites

- Node.js >= 22
- pnpm (the repo pins `pnpm@11.5.2` via `packageManager`)
- QMD >= 2.5.3, installed globally:

  ```bash
  npm i -g @tobilu/qmd
  qmd --version   # must report >= 2.5.3
  ```

## 2. Clone and build

```bash
git clone <repo-url> /path/to/ams
cd /path/to/ams
pnpm install
pnpm build      # tsc --build, compiles all packages to dist/
```

## 3. Create a vault and register it with QMD

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

## 4. Start the QMD daemon

In one terminal:

```bash
cd ~/ams-workspace
qmd mcp --http            # binds the loopback on :8181 by default
```

## 5. Start the Write API

In another terminal, from the same workspace directory:

```bash
cd ~/ams-workspace
AMS_VAULT_PATH="$HOME/ams-workspace/vault" node /path/to/ams/packages/api/dist/server.js
```

The API listens on `:3000`. Sanity check: `curl -s http://localhost:3000/health`
returns `{"status":"ok"}`.

## 6. Smoke-test the loop

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

## 7. Connect an MCP client

### stdio (runs wherever the client runs)

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

### Streamable HTTP (shared service)

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

For private-network and public OAuth deployments, see
[remote-mcp-deployment.md](remote-mcp-deployment.md).

## 8. Run the e2e suite

```bash
cd /path/to/ams
pnpm e2e       # boots a temp vault + real QMD daemon, drives the full loop
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `search_memory` returns no hits | Note not indexed yet — `POST /admin/reindex` or wait for the cron tick |
| First run is very slow | Embedding model download (~300MB) — wait; cached in `~/.cache/qmd/models/` |
| QMD daemon unreachable | Check it is running and that `AMS_QMD_URL` matches its bound host/port |
| `qmd` not on PATH | `npm i -g @tobilu/qmd` |

More: [e2e-runbook.md](e2e-runbook.md) (loop reproduction and
troubleshooting), [retrieval-runbook.md](retrieval-runbook.md) (daemon
operations), [architecture.md](architecture.md) (how the pieces fit).
