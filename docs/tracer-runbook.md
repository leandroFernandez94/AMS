# Tracer Runbook

End-to-end reproduction guide for the AMS Tracer Bullet loop:
`record_note` (MCP) → Write API → note file on disk → reindex →
`search_memory` (MCP) against a live QMD daemon.

## Quick path

1. Install QMD: `npm i -g @tobilu/qmd` and confirm `qmd --version` ≥ 2.5.3.
2. Run the automated suite: `pnpm tracer`.
3. Or follow the manual curl/MCP recipes below to drive the same loop by hand.

## Prerequisites

- **Node.js** ≥ 22 (enforced by `engines` in `package.json`).
- **QMD CLI** installed globally: `npm i -g @tobilu/qmd`.
- Verify the version: `qmd --version` should report ≥ `2.5.3`.
- The suite expects `qmd` on `PATH`; if it is missing, `pnpm tracer` exits with:
  `Missing prerequisite: 'qmd' is not on PATH — install with npm i -g @tobilu/qmd, see docs/tracer-runbook.md`.

## First-run cost

The first time QMD embeds a note it downloads a local embedding model:

- Embedding model: ~300 MB.
- Full model set (embedding + query expansion + reranker): ~2 GB.
- Models are cached in `~/.cache/qmd/models/` and reused across runs.

Because of this download, the first `pnpm tracer` run can take several minutes.
Subsequent runs are much faster (seconds per note on CPU).

## Automated suite

```bash
pnpm tracer
```

What it proves:

- Boots a temporary vault and a real QMD daemon on a free port.
- Drives the loop through an in-process MCP client.
- Asserts the note is written to disk, reindexed, and retrievable.
- Asserts failure modes (lock contention, QMD down) and isolation (no global index pollution).

The temporary vault lives under `os.tmpdir()` (`/tmp/ams-tracer-XXXXXX` on Linux) and is removed by the fixture teardown, whether the tests pass or fail.

## Manual loop reproduction with curl

Set up a fresh vault and QMD daemon:

```bash
V=$(mktemp -d)
mkdir "$V/vault"
cd "$V"
qmd init
qmd collection add "$V/vault" --name ams
```

Build and start the Write API:

```bash
cd /path/to/ams
pnpm build
AMS_VAULT_PATH="$V/vault" AMS_API_PORT=3000 node packages/api/dist/server.js
```

In another terminal, from the vault directory, start the QMD daemon:

```bash
cd "$V"
qmd mcp --http --port 8184
```

Record a note:

```bash
curl -s -X POST http://localhost:3000/notes \
  -H "content-type: application/json" \
  -d '{"title":"Manual Tracer","type":"note","body":"Proving the loop by hand."}'
```

Reindex so the note becomes searchable:

```bash
curl -s -X POST http://localhost:3000/admin/reindex
```

Search via the QMD MCP HTTP endpoint. See `docs/retrieval-runbook.md` for the
full JSON-RPC `tools/call query` recipe; the summary is:

```bash
curl -s -X POST http://localhost:8184/mcp \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"query","arguments":{"searches":[{"type":"lex","query":"manual tracer"},{"type":"vec","query":"manual tracer"}],"rerank":false}}
  }'
```

The result should list the note under the vault-relative path
`notes/<id>.md`.

## MCP client reproduction

Build the MCP package and run the stdio binary with the real URLs:

```bash
pnpm build
AMS_API_URL=http://localhost:3000 AMS_QMD_URL=http://localhost:8184 \
  node packages/mcp/dist/bin.js
```

Then connect any MCP client (e.g., the MCP inspector) and call:

- `record_note` with `{ title, type, body }` to write a note.
- `search_memory` with `{ query }` to retrieve it after reindexing.
- `get_memory` with `{ file: "#<docid>" }` to fetch a document by docid.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing prerequisite: 'qmd' is not on PATH` | QMD not installed or not on PATH | `npm i -g @tobilu/qmd` |
| Daemon fails to start with `EADDRINUSE` | Probed port was taken | The fixture auto-retries up to 3 times with a fresh port; in the manual recipe, pick a different `--port` |
| `search_memory` returns no hits | Note not reindexed yet | Call `POST /admin/reindex` or wait for the cron tick |
| `QMD retrieval unavailable` | QMD daemon is down or unreachable | Check daemon logs; ensure the URL matches the daemon's bound host/port |
| First run is very slow | Model download | Wait; subsequent runs reuse `~/.cache/qmd/models/` |

To see daemon logs, run `qmd mcp --http --port <port>` in the foreground and watch stderr.
