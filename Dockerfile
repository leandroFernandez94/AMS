# AMS server image — Write API + QMD retrieval daemon in one container.
#
# Runs the two server-side processes of the tracer bullet:
#   1. QMD daemon  (hybrid search, MCP-over-HTTP on $QMD_PORT)
#   2. Write API   (Hono HTTP server on $AMS_API_PORT)
# The MCP stdio server is NOT run here — clients launch it on their own host
# and point AMS_API_URL / AMS_QMD_URL at this container.
#
# All mutable state lives under /data (single volume):
#   /data/vault       note vault (AMS_VAULT_PATH)
#   /data/qmd/.qmd    QMD project registry (cwd for the API + daemon)
#   /data/.cache/qmd  QMD models + index (via HOME=/data)
# Note: qmd refuses `qmd init` when cwd == $HOME, so the project registry
# gets its own directory distinct from HOME.

# ---------------------------------------------------------------------------
# Builder: install ALL deps (TypeScript included) and compile the workspace.
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder

# pnpm pinned to the version declared in package.json ("packageManager").
RUN npm install -g pnpm@11.5.2

WORKDIR /app

# Layer 1: manifests only, so dependency install stays cached across source edits.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/mcp/package.json packages/mcp/package.json

# --ignore-scripts: skips husky's prepare (no .git inside the image) and
# esbuild's postinstall (only needed by vitest, which this image never runs).
RUN pnpm install --frozen-lockfile --ignore-scripts

# Layer 2: TypeScript configs + sources, then compile every workspace package.
# tests/ are excluded: package tsconfigs only include src/.
COPY tsconfig.json tsconfig.base.json ./
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/shared/src packages/shared/src
COPY packages/api/tsconfig.json packages/api/tsconfig.json
COPY packages/api/src packages/api/src
COPY packages/mcp/tsconfig.json packages/mcp/tsconfig.json
COPY packages/mcp/src packages/mcp/src

RUN pnpm build

# ---------------------------------------------------------------------------
# Runtime: production dependencies only — TypeScript, Vitest, Biome, husky
# and commitlint stay behind in the builder (pnpm prune is unsupported in
# workspaces, so the runtime stage re-installs with --prod instead).
# ---------------------------------------------------------------------------
FROM node:22-slim

# Toolchain:
# - pnpm pinned to the version declared in package.json ("packageManager")
# - qmd pinned to the release proven by the Spec 7 tracer suite (>= 2.5.3)
# - socat bridges IPv4 -> IPv6 loopback for the QMD daemon: qmd 2.5.3
#   accepts --host 0.0.0.0 but silently binds ::1 only (verified empirically),
#   so it is unreachable over IPv4 (docker port publishing, 127.0.0.1 probes).
# - wget for HTTP probes and in-container debugging (node:22-slim ships
#   neither curl nor wget).
RUN apt-get update \
    && apt-get install -y --no-install-recommends socat wget \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11.5.2 @tobilu/qmd@2.5.3

WORKDIR /app

# Same manifests as the builder; --prod resolves only runtime dependencies
# (every workspace package declares its runtime deps in "dependencies").
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/mcp/package.json packages/mcp/package.json

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Compiled output from the builder (workspace symlinks already point here).
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/api/dist packages/api/dist
COPY --from=builder /app/packages/mcp/dist packages/mcp/dist

# Runtime defaults. HOME=/data keeps the QMD cache (~/.cache/qmd) on the
# volume so embedding models survive container recreation.
ENV HOME=/data \
    QMD_PROJECT_DIR=/data/qmd \
    AMS_VAULT_PATH=/data/vault \
    AMS_API_PORT=3000 \
    AMS_QMD_URL=http://localhost:8181 \
    AMS_QMD_COLLECTION=ams \
    QMD_PORT=8181

VOLUME /data
EXPOSE 3000 8181

# wget-based probe against the Write API health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -T 4 -t 1 -O /dev/null http://localhost:${AMS_API_PORT:-3000}/health || exit 1

# Boot sequence (mirrors docs/tracer-runbook.md manual recipe):
#   1. ensure the vault exists
#   2. first boot only: qmd init + collection add in $QMD_PROJECT_DIR so
#      `qmd update` spawned by the reindexer resolves the local .qmd registry
#   3. start the QMD daemon (binds ::1 only — qmd 2.5.3 ignores --host) and
#      socat, which exposes the same port on IPv4 0.0.0.0 for docker port
#      publishing; wait for /health (bounded to ~30s)
#   4. exec the Write API as PID 1 (graceful SIGINT/SIGTERM shutdown)
# The daemon runs as a background child: if the container stops, both die
# together; the QMD index is rebuilt idempotently by `qmd update` on boot.
CMD ["sh", "-c", "set -e; mkdir -p \"$AMS_VAULT_PATH\" \"$QMD_PROJECT_DIR\"; cd \"$QMD_PROJECT_DIR\"; if [ ! -d .qmd ]; then echo '[ams] first boot: initializing QMD registry'; qmd init; qmd collection add \"$AMS_VAULT_PATH\" --name \"$AMS_QMD_COLLECTION\"; fi; qmd mcp --http --port \"$QMD_PORT\" & socat TCP4-LISTEN:\"$QMD_PORT\",bind=0.0.0.0,fork,reuseaddr TCP6:[::1]:\"$QMD_PORT\" & ok=0; i=0; until [ \"$ok\" = 1 ] || [ \"$i\" -ge 30 ]; do if wget -q -T 2 -t 1 -O /dev/null http://127.0.0.1:${QMD_PORT:-8181}/health; then ok=1; else i=$((i+1)); sleep 1; fi; done; if [ \"$ok\" = 1 ]; then echo '[ams] QMD daemon healthy'; else echo '[ams] WARNING: QMD daemon not healthy after 30s — starting API anyway (retrieval degrades)'; fi; exec node /app/packages/api/dist/server.js"]
