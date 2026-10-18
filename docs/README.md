# AMS Documentation

Index of guides in this directory. Start with the quick start; everything
else is reference for a specific job.

| Guide | What it covers | For whom |
|---|---|---|
| [quickstart.md](quickstart.md) | Clone → install → running record/search/read loop, MCP client config (stdio + HTTP) | Newcomers, first run |
| [architecture.md](architecture.md) | Components, write and read paths, note contract, authentication, configuration, operational caveats | Contributors and operators |
| [tracer-runbook.md](tracer-runbook.md) | End-to-end loop reproduction (`pnpm tracer` and by hand), troubleshooting | Maintainers verifying the loop |
| [retrieval-runbook.md](retrieval-runbook.md) | QMD daemon operations: indexing the vault, daemon lifecycle, rerank policy, graceful degradation | Operators of the read path |
| [remote-mcp-deployment.md](remote-mcp-deployment.md) | Remote MCP topologies, Streamable HTTP deployment, public OAuth 2.1 exposure (edge, tunnel, authorization server) | Operators exposing MCP over a network |

## Capability specs

Requirements and scenarios per capability live under
[`openspec/specs/`](../openspec/specs/):

- [mcp-domain-tools](../openspec/specs/mcp-domain-tools/spec.md) — the six
  MCP domain tools, input schemas, error mapping, server factory and
  transports
- [e2e-tracer-suite](../openspec/specs/e2e-tracer-suite/spec.md) — the
  end-to-end tracer suite: loop proof, failure modes, isolation
