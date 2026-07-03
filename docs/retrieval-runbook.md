# Retrieval Runbook — QMD Daemon

AMS does not ship its own retrieval engine. The read path integrates
[QMD](https://github.com/tobi/qmd) (`@tobilu/qmd`), a local hybrid search
engine (BM25 + vector + optional LLM rerank) running as an **independent HTTP
daemon**. This document is the operational runbook for indexing the vault and
running the daemon that the `@ams/api` retrieval adapter talks to.

> The daemon lifecycle is deliberately **out of process** from AMS: keeping
> QMD long-lived means the GGUF models stay warm in memory, and a crash or
> restart of one component never takes down the other.

## 1. Prerequisites

- Node.js >= 22 (or Bun >= 1.0)
- QMD installed globally:

  ```sh
  npm install -g @tobilu/qmd
  # or
  bun install -g @tobilu/qmd
  ```

- No GPU required. AMS targets CPU-only deployments; reranking is off by
  default (see the [Rerank policy](#3-rerank-policy) section). QMD's models
  (~2 GB total) live in `~/.cache/qmd/models/` after first use.

## 2. Index the vault

Point QMD at the AMS vault and generate embeddings. `<vault>` is the same
directory the Write API persists notes into (configured via `AMS_VAULT_PATH`).

```sh
# Register the vault as a QMD collection named "ams"
qmd collection add <vault> --name ams

# (Optional) describe the collection — improves search relevance
qmd context add qmd://ams "AMS memory notes: decisions, learnings, patterns"

# Build the full-text + vector index
qmd update      # scan files into the FTS5 index
qmd embed       # generate vector embeddings (~300 MB model, first run)
```

Re-run `qmd update && qmd embed` whenever notes change (the Spec 5 indexer
will automate this from the dirty-flag store; for the tracer bullet run it by
hand).

## 3. Rerank policy

QMD's `query` tool reranks by default using a cross-encoder (~640 MB). On a
CPU-only host that adds tens of seconds per query with no measurable precision
gain on QMD's own benchmark (hybrid-without-rerank already reaches ~1.00
precision). AMS therefore **defaults to `rerank: false`** (RRF-only) and lets
callers opt in per query via `searchMemory({ rerank: true })`. The adapter
always forwards the flag explicitly, so daemon-side defaults are never
inherited.

## 4. Run the daemon

Start QMD's MCP-over-HTTP server. AMS connects to it over a stateless
`POST /mcp` JSON-RPC endpoint.

```sh
# Foreground (Ctrl-C to stop) — binds localhost:8181 by default
qmd mcp --http

# Custom port / bind all interfaces (e.g. inside a container)
qmd mcp --http --host 0.0.0.0 --port 8181

# Background daemon (writes a PID file to ~/.cache/qmd/mcp.pid)
qmd mcp --http --daemon
qmd mcp stop     # stop via PID file
qmd status       # shows "MCP: running (PID ...)" when active
```

Verify liveness:

```sh
curl -s http://localhost:8181/health
```

## 5. Point AMS at the daemon

The adapter reads its target from a single environment variable:

| Variable     | Default                  | Description                          |
| ------------ | ------------------------ | ------------------------------------ |
| `AMS_QMD_URL` | `http://localhost:8181` | Base URL of the QMD HTTP daemon.     |

```sh
export AMS_QMD_URL=http://localhost:8181
```

## 6. Graceful degradation

If the daemon is down or unreachable, the adapter throws a typed
`QmdUnavailableError` (it never crashes the host process). Callers can probe
availability with `QmdClient#isReachable()`, which resolves to `false` instead
of throwing on a connection failure.

## 7. Verify the integration (optional, slow)

With the daemon running over an indexed vault, exercise the adapter end-to-end:

```sh
AMS_QMD_INTEGRATION=1 pnpm test qmd-integration
```

This runs the otherwise-skipped integration suite (`packages/api/tests/qmd-integration.test.ts`).
