# Agents Memory System (AMS)

AMS is a public, vendor-neutral project to build a shared memory architecture for AI agents using Markdown as the long-term source of truth.

## Security and Portability First

This repository is public. All examples and code must follow these constraints:

- no secrets or credentials in git history
- no host-specific absolute paths (for example `/home/<user>/...`)
- no assumptions about a single machine layout
- all runtime configuration via environment variables

See [SECURITY.md](./SECURITY.md) for disclosure and contributor rules.

## Vision

AMS separates memory concerns into two clear layers:

- **Retrieval layer**: optimized for search and read access
- **Write layer**: optimized for controlled, semantically-safe updates

This keeps knowledge durable for humans (plain Markdown) while enabling structured agent workflows.

## High-Level Architecture

```text
Markdown Vault (source of truth)
  <- Human client(s) for reading/review
  <- Retrieval engine (index + search APIs)
  <- Write service (controlled semantic operations)
       <- MCP tools used by agents
```

## Core Design Principles

- **Markdown-first durability**: data remains usable without a proprietary backend.
- **Read/Write separation**: retrieval and persistence are independent concerns.
- **Semantic writes**: agents should call domain tools (e.g. record decision), not raw file writes.
- **Obsidian-compatible linking**: preserve meaningful `[[wikilinks]]` and navigability.
- **Conflict safety**: prefer append-only operations; use structured upserts for canonical notes.

## Scope

This repository contains planning and implementation for two packages:

- `packages/mcp`: MCP server exposing high-level memory tools for agents
- `packages/api`: HTTP service responsible for controlled persistence operations

## What This README Intentionally Does Not Include

To keep the public surface secure and implementation-agnostic, this README omits:

- environment-specific infrastructure details
- internal deployment topology
- machine-specific paths and network assumptions
- step-by-step operational rollout plans

Detailed technical specs will be maintained as versioned artifacts in the repository (issues, ADRs, and spec docs).

## Current Status

Project is in early planning and specification phase.

If you want to contribute early, open an issue with:

- use case
- expected memory behavior
- constraints (scale, latency, security)
