# Remote MCP Deployment — Investigation (#27)

Status: DECIDED — revised 2026-10-03 after review: topology 1 is the target
(phased). See [Recommendation](#recommendation).
Date: 2026-10-03

## Context

The MCP server (`packages/mcp`) is stdio-only: `bin.ts` wires `createServer()`
into a `StdioServerTransport` and the process runs wherever the MCP client
runs. Tools reach the Write API and the QMD daemon over plain HTTP via
`globalThis.fetch`, using `AMS_API_URL` (required, no default) and
`AMS_QMD_URL` (defaults to `http://localhost:8181`). Configuration is resolved
lazily so the server starts even when an upstream is down; tools degrade
per-call.

Hard constraint (from #27): the vault, Write API and QMD daemon stay on the
current self-hosted server. A remote MCP deployment would reach those
upstreams over the tailnet.

### Verified current deployment

The primary client (OpenCode on the dev server) already runs the topology
labelled "topology 2" below:

```json
"ams": {
  "command": ["node", "/path/to/ams/packages/mcp/dist/bin.js"],
  "environment": {
    "AMS_API_URL": "http://<tailnet-ip>:3050",
    "AMS_QMD_URL": "http://<tailnet-ip>:8182"
  }
}
```

`100.64.x.x` is Tailscale's CGNAT range — both upstreams are reached over the
tailnet today, and the MCP process runs on the agent host. This is not a
hypothetical topology; it is the running baseline.

Architectural fact that shapes everything below: `createServer()` is
transport-agnostic (transport wiring lives entirely in the 15-line `bin.ts`),
and the MCP server holds no session state — every tool call is a stateless
HTTP round-trip to an upstream. Adding a second transport is additive, not
structural.

## Evidence

### SDK support (official TypeScript SDK)

- **Streamable HTTP** is the current standard network transport. The SDK ships
  `StreamableHTTPServerTransport` with two modes:
  - *Stateless*: `sessionIdGenerator: undefined` — each POST is handled
    independently, no session map, trivially horizontal. Fits AMS perfectly
    because tools are already stateless.
  - *Stateful*: `sessionIdGenerator: () => randomUUID()` — session map keyed
    by the `Mcp-Session-Id` header, idle eviction, GET stream for server
    notifications. AMS gains nothing from this today (no server-initiated
    messages, no subscriptions).
- **HTTP+SSE is deprecated** (remains as a client-side fallback only). Any new
  server-side work should target Streamable HTTP.
- **Auth**: the SDK's `requireBearerAuth` middleware gates a route behind a
  bearer token (401 `invalid_token` / 403 `insufficient_scope` with proper
  `WWW-Authenticate` challenges). Full OAuth 2.1 resource-server behaviour
  (RFC 9728 metadata routes, discovery) is available but only pays off with
  real authorization servers and multiple users.

### Client support

- **OpenCode** (primary client): first-class remote MCP — `"type": "remote"`
  with `url`, custom `headers` (e.g. `Authorization: Bearer {env:TOKEN}`) and
  optional OAuth blocks. It constructs a StreamableHTTP client transport with
  an SSE legacy fallback automatically.
- **Claude Code / Codex / mainstream clients**: support streamable HTTP MCP
  endpoints (`claude mcp add --transport http`, `url`-based server entries).
  Support is broad but not literally universal; long-tail and older clients
  still assume stdio.
- **stdio**: supported by every MCP client without exception. It remains the
  compatibility baseline.

### Deployment surface

- The ghcr.io image (#18) already builds `packages/mcp` (Dockerfile compiles
  shared + api + mcp), so a remote host can pull one image and run either an
  upstream or (with a small entrypoint addition) an MCP process.

## Topologies evaluated

All three topologies are answers to one question: **where does the MCP
process run, and what stands between the agent and the vault?** The vault
box (Write API, QMD daemon, vault) is identical and never moves — only the
left side changes.

Legend: `─▶` network hop (needs the tailnet up) · `◁▷` local pipe/process
boundary (no network) · 🔒 point where a token/auth is required.

### Topology 1 — Network-facing MCP (Streamable HTTP) on a remote host

The MCP server becomes a long-lived HTTP service on the tailnet; agents
connect with a URL (+ token) instead of spawning a local process.

```mermaid
flowchart LR
    subgraph agents["Agent host(s) — any tailnet machine"]
        client["MCP client (OpenCode, Claude Code, …)"]
    end
    subgraph mcphost["NEW remote MCP host"]
        mcp["MCP server<br/>(long-lived HTTP service)"]
    end
    subgraph vaultbox["Self-hosted server (unchanged)"]
        api["Write API"]
        qmd["QMD daemon"]
        vault[("Vault")]
    end

    client -- "Streamable HTTP · 🔒 token" --> mcp
    mcp -- "HTTP · tailnet" --> api
    mcp -- "HTTP · tailnet" --> qmd
    api --> vault
```

Two network legs per call (agent → MCP host, MCP host → upstreams). The MCP
process is shared by every agent, so it must authenticate callers and stay
up for everyone.

- **Pros**: one MCP deployment shared by all agent hosts; no Node/runtime
  requirement on agent hosts; client config shrinks to a URL; server-side
  observability (logs, health endpoint) in one place.
- **Cons**: requires auth on the MCP service itself (new secret, new
  rotation); session/lifecycle management even in stateless mode (health
  checks, restarts, idle behavior); adds a network hop between agent and
  upstreams (agent → MCP host → tailnet → API/QMD) which increases failure
  modes exactly where the issue worries about tailnet outages; every client
  must support HTTP transports (nearly true, not universally true).

### Topology 2 — stdio MCP on the agent host, upstreams over the tailnet (CURRENT)

The MCP process runs wherever the agent runs; `AMS_API_URL`/`AMS_QMD_URL`
point at tailnet addresses of the self-hosted server.

```mermaid
flowchart LR
    subgraph agent["Agent host — where the agent already runs"]
        client["MCP client (OpenCode)"]
        mcp["MCP server<br/>(local child process, stdio)"]
        client <-. "stdio pipe (no network)" .-> mcp
    end
    subgraph vaultbox["Self-hosted server (unchanged)"]
        api["Write API"]
        qmd["QMD daemon"]
        vault[("Vault")]
    end

    mcp -- "HTTP · tailnet · no auth" --> api
    mcp -- "HTTP · tailnet · no auth" --> qmd
    api --> vault
```

One network leg per call. The MCP process is not network-facing at all — it
is spawned by the agent and talks to its client over a local pipe — so the
tailnet is the only boundary and no token exists to leak or rotate.

- **Pros**: zero code changes (this is today's `bin.ts`); zero auth surface on
  the MCP side (the tailnet is the boundary — traffic never leaves the
  private network); one fewer network hop; stdio compatibility everywhere;
  per-agent isolation (one hung MCP process cannot affect other agents).
- **Cons**: every agent host needs the MCP artifact (checkout build or image
  pull) plus per-host env config; one process per agent session; upgrading the
  MCP means touching every agent host.

### Topology 3 — MCP gateway/proxy in front of stdio servers

A gateway accepts network MCP connections and fans out to N stdio server
processes.

```mermaid
flowchart LR
    subgraph agents["Agent host(s)"]
        client["MCP client"]
    end
    subgraph gwhost["NEW gateway host"]
        gateway["MCP gateway"]
        mcp1["stdio MCP server"]
        mcpN["stdio MCP server N"]
        gateway <-. "spawns / manages" .-> mcp1
        gateway <-. "spawns / manages" .-> mcpN
    end
    subgraph vaultbox["Self-hosted server (unchanged)"]
        api["Write API"]
        qmd["QMD daemon"]
        vault[("Vault")]
    end

    client -- "HTTP · 🔒 token" --> gateway
    mcp1 -- "HTTP · tailnet" --> api
    mcpN -- "HTTP · tailnet" --> qmd
```

Same two network legs as topology 1 plus a translation layer: the gateway
converts network MCP into local stdio processes. It exists to serve *many*
servers behind one endpoint — with exactly one server, it is a second
component to operate with nothing to fan out to.

- **Pros**: centralizes transport, auth and versioning for many servers;
  stdio servers stay untouched.
- **Cons**: a whole new component to operate for a fleet of exactly one
  server and one user; the gateway becomes a single point of failure that
  topology 2 does not have. Rejected as over-engineering at current scale.

## Comparison

| Dimension             | 1: Streamable HTTP | 2: stdio + tailnet (current) | 3: Gateway |
| --------------------- | ------------------ | ---------------------------- | ---------- |
| Code changes          | Add transport+auth | None                         | New service |
| Auth surface          | Token required     | Tailnet boundary only        | Token required |
| Network hops          | +1 (via MCP host)  | Direct                       | +1 |
| Client compatibility  | Broad, not total   | Universal                    | Broad, not total |
| Ops burden            | Service to run     | Artifact per agent host      | Service + fleet |
| Failure isolation     | Shared service     | Per agent process            | Shared gateway |

## Security model

For a single-user deployment, phased:

- **Phase 1 (tailnet-only service)**: tailnet reachability is the primary
  boundary; the static bearer token is defense in depth (a compromised
  tailnet peer or a misconfigured funnel must not get free write access to
  the memory vault). The MCP listens on the tailnet interface only.
- **Phase 2 (public exposure)**: the bar rises. The token alone is NOT an
  acceptable boundary between the public internet and vault writes — it must
  be OAuth 2.1 (the SDK's resource-server machinery with RFC 9728 metadata)
  or tunnel-fronted Cloudflare Access in front of the route, plus HTTPS via
  the existing cloudflared tunnel.
- Upstream traffic (MCP → API/QMD) stays plain HTTP *inside* the tailnet;
  WireGuard encryption covers the transport. No TLS work needed for upstream
  legs even in phase 2 — only the public MCP edge needs HTTPS.

## Operational concerns (apply to any remote variant)

- **Image**: remote host pulls from ghcr.io (#18); image already contains the
  compiled `packages/mcp`.
- **Config**: env-based as today (`AMS_API_URL`, `AMS_QMD_URL`); resolved
  lazily, so an unreachable upstream degrades per tool call — the server must
  keep starting and answer with tool-level errors, never crash at boot.
- **Failure modes**: tailnet link down → fetch timeouts per call; API down →
  write tools fail, read tools (QMD) may still work; QMD down → inverse.
  Health checks should probe the upstreams, not just the process.
- **Upgrades**: topology 2 upgrades are per-agent-host (pull + restart agent);
  topology 1 upgrades are one service restart shared by everyone.

## Recommendation

> **Revised after review.** The original recommendation kept stdio as the
> baseline. Two review considerations outweigh the minimal-surface argument:

### Why topology 1 wins on review

1. **Deployment centralization.** With stdio, every MCP change means pulling
   and deploying the artifact on every agent host (N hosts). With a
   network-facing MCP, one image update reaches every client on its next
   `initialize` — clients never need to be touched.
2. **Clients on hosts we do not control.** Mobile/web apps (Claude app
   custom connectors, ChatGPT connectors) speak remote MCP over HTTPS; they
   cannot spawn local stdio processes at all. Topology 2 makes these clients
   unreachable by construction; topology 1 unlocks them.

The trade is explicit: we accept one more network leg and a token to manage
in exchange for centralized deploys and client portability.

### Phased plan

**The MCP service does not need new hardware — it deploys on the existing
self-hosted server** (one more service in the compose stack, image from
ghcr.io). This is strictly better than a separate MCP host: MCP → upstream
calls become localhost/container-network round-trips (the tailnet-link
failure mode between MCP and upstreams disappears), and there is one box to
operate. The original "separate host" framing in #27 is satisfied by a
separate *service*, not a separate machine.

- **Phase 1 — tailnet service (#37)**: MCP as a long-lived HTTP service on
  the existing server, reachable at its tailnet address. Stateless Streamable
  HTTP behind a static bearer token (`requireBearerAuth`), upstreams at
  localhost. Own agents (OpenCode on any tailnet host) switch from local
  stdio to the remote URL. Deployment becomes one image update; no public
  exposure.
- **Phase 2 — public reachability for external apps (#39)**: Claude app /
  ChatGPT clients run on vendor clouds and cannot reach a tailnet-only
  service. The existing cloudflared tunnel on the same server fronts the MCP
  with public HTTPS (origin at localhost) AND a real auth upgrade (OAuth 2.1
  resource server, or tunnel-fronted Cloudflare Access) — a static token
  alone is not an acceptable boundary between the public internet and write
  access to the vault.

Topology 2 remains the running baseline until phase 1 ships. Topology 3
stays rejected (one server, one user — nothing to fan out).

### Decision summary

| Question     | Answer                                                  |
| ------------ | ------------------------------------------------------- |
| Transport    | Stateless Streamable HTTP (target); stdio stays as migration fallback |
| Auth         | Phase 1: static bearer token, tailnet-only. Phase 2: OAuth 2.1 / tunnel-fronted access for public |
| Network      | MCP runs on the existing self-hosted server: own agents reach it via tailnet (phase 1), external apps via cloudflared public HTTPS (phase 2). Upstreams stay localhost. Vault/API/QMD never move |

## References

- `packages/mcp/src/bin.ts`, `config.ts`, `server.ts` — current architecture
- Model Context Protocol TypeScript SDK docs — Streamable HTTP transport,
  session management, `requireBearerAuth` (retrieved 2026-10-03 via context7)
- OpenCode docs — remote MCP configuration (retrieved 2026-10-03 via context7)
