# Agents Memory System (AMS)

## Goal

AMS is a shared memory system for multiple agents (for example OpenClaw and Hermes) with:

- a server-hosted Markdown vault as the source of truth
- human consumption through Obsidian
- search and retrieval through QMD
- controlled agent writes through a dedicated write service exposed as MCP

## Core Architecture

```text
/brain vault on server
  -> Obsidian over SMB (human read/review)
  -> QMD index + MCP HTTP (agent read/search)
  -> Memory Write API (server-side write path)
       -> custom MCP write tools for agents
```

## Main Decisions

- The source of truth is a Markdown vault hosted on the server.
- Obsidian is a human client, not the backend and not the write API.
- QMD is the retrieval layer, not the write layer.
- Agents should use a dedicated write MCP that wraps a server-side HTTP API.
- Agent writes should be Obsidian-aware and create meaningful `[[wikilinks]]`.
- Most writes should be append-only; canonical notes should be updated through controlled upsert operations.

## Proposed Vault Structure

```text
/brain
  /00-inbox
  /01-entities
    /agents
    /services
    /people
    /infrastructure
  /02-concepts
    /architecture
    /workflows
    /memory
  /03-decisions
    /architecture
    /operations
  /04-sessions
    /2026
      /2026-05
  /05-projects
    /home-server
    /agent-memory-system
  /06-sources
    /external-tools
  /07-maps
  /99-templates
```

## Folder Semantics

- `00-inbox`: quick captures and unconsolidated notes
- `01-entities`: canonical notes for agents, services, people, infrastructure, and tools
- `02-concepts`: reusable knowledge and stable concepts
- `03-decisions`: explicit architectural and operational decisions
- `04-sessions`: temporal notes from work sessions and agent activity
- `05-projects`: project-centric notes connecting entities, concepts, and decisions
- `06-sources`: external references and imported documentation notes
- `07-maps`: maps of content (MOCs) and hub notes for Obsidian navigation
- `99-templates`: note templates and generation helpers

## Obsidian-Aware Writing Rules

Agents should not just write Markdown files. They should write a vault that works well in Obsidian.

### Principles

- Organize by knowledge type, not by agent name.
- Reuse canonical notes instead of duplicating concepts or entities.
- Add links only when the relationship is meaningful.
- Prefer readable note titles; keep stable IDs in frontmatter if needed.
- Use map notes in `07-maps` to create navigable hubs.

### Minimum Linking Rules

Each new durable note should link to:

- its main project note
- the main entities involved
- one or two relevant concepts when applicable

### Promotion Rules

- Recurring people, services, tools, agents, or servers should become notes in `01-entities`.
- Reusable ideas should become notes in `02-concepts`.
- Stable choices with rationale should become notes in `03-decisions`.
- Temporal work logs should go to `04-sessions`.

## Example Note Pattern

```md
---
type: decision
status: active
created: 2026-05-17
id: decision-use-qmd-retrieval
tags: [memory, agents, obsidian]
---

# Use QMD for Retrieval

We use [[QMD]] as the retrieval layer for the shared vault stored in [[Agent Memory System]].

## Related

- [[Obsidian]]
- [[Shared Agent Memory]]
- [[Hermes]]
- [[OpenClaw]]
```

## QMD Role in AMS

QMD indexes the Markdown vault, builds lexical/vector search, and exposes retrieval to agents via CLI or MCP.

### QMD Responsibilities

- scan and index Markdown notes
- store search index and embeddings in SQLite
- provide keyword, semantic, and hybrid search
- expose retrieval as MCP over HTTP

### QMD Non-Responsibilities

- it does not manage multi-agent writes
- it should not be treated as the persistence API
- it does not define the vault structure or link policy

## QMD Setup Commands

Install:

```bash
npm install -g @tobilu/qmd
```

Create the main collection:

```bash
qmd collection add "<storage-path>/nas/leandro/brain" --name brain --mask "**/*.md"
```

Add top-level contexts:

```bash
qmd context add qmd://brain "Shared Obsidian vault for human and agent memory"
qmd context add qmd://brain/01-entities "Canonical entity notes"
qmd context add qmd://brain/02-concepts "Reusable knowledge and concepts"
qmd context add qmd://brain/03-decisions "Architectural and operational decisions"
qmd context add qmd://brain/04-sessions "Temporal notes from agent work sessions"
qmd context add qmd://brain/05-projects "Project-specific notes"
qmd context add qmd://brain/07-maps "Maps of content for Obsidian navigation"
```

Build/update the index:

```bash
qmd update
```

Generate embeddings:

```bash
qmd embed
```

Recommended multilingual embedding model if the corpus is mostly Spanish:

```bash
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
qmd embed -f
```

Useful retrieval commands:

```bash
qmd search "hermes shared memory"
qmd vsearch "como comparten memoria los agentes"
qmd query "como estamos organizando la memoria compartida de agentes"
qmd query "obsidian linking strategy" --json -n 10
qmd query "agent memory" --all --files --min-score 0.35
qmd get "03-decisions/Use QMD for Retrieval.md" --full
qmd multi-get "03-decisions/*.md" --json
qmd status
```

Expose QMD as MCP over HTTP:

```bash
qmd mcp --http
qmd mcp --http --port 8080
qmd mcp --http --daemon
qmd mcp stop
```

Default MCP endpoint:

```text
http://localhost:8181/mcp
```

## Write Path Architecture

Agents should not write raw files directly. They should use a dedicated MCP write layer that wraps a server-side HTTP API.

```text
Agent
  -> memory-write MCP
  -> server HTTP API
  -> persistence engine
  -> /brain vault
  -> qmd update/embed
```

## Why an MCP Write Layer

- hides filesystem details from agents
- forces semantic operations instead of raw file writes
- centralizes naming, metadata, and linking rules
- provides one place to enforce conflict resolution
- keeps the vault consistent for Obsidian use

## Proposed MCP Write Tools

- `create_note`
- `append_to_note`
- `upsert_entity`
- `upsert_concept`
- `record_decision`
- `record_session_note`
- `link_notes`
- `search_candidates_for_linking`
- `get_note_metadata`

These are intentionally high-level tools. Agents should think in terms of knowledge operations, not filesystem paths.

## Proposed HTTP API

- `POST /notes`
- `POST /notes/{id}/append`
- `PUT /entities/{slug}`
- `PUT /concepts/{slug}`
- `POST /decisions`
- `POST /links/suggest`
- `POST /reindex`

The MCP layer should encapsulate this API so agents do not work against the HTTP contract directly.

## Persistence Strategy

### Write Types

#### Append-only writes

Use for:

- session logs
- observations
- event memories
- quick captures
- new decision notes
- imported source notes

Benefits:

- low conflict risk
- simpler auditing
- simpler recovery

#### Controlled upserts

Use for canonical notes such as:

- entities
- concepts
- projects
- maps of content

These should not be rewritten freely. They should be updated through structured operations against specific sections.

## Canonical Note Strategy

Canonical notes should use fixed sections so the write service can patch them safely.

Example:

```md
---
type: entity
id: entity-hermes
version: 7
updated: 2026-05-17T14:00:00Z
---

# Hermes

## Summary

## Aliases

## Related Concepts

## Related Decisions

## Related Projects

## Session Mentions

## Review Needed
```

The write service should update sections, not replace the entire note body.

## Conflict Resolution Strategy

### Default Rule

Prefer append-only writes whenever possible.

### For Canonical Notes

Use:

- per-note lock on the server
- structured section updates
- frontmatter versioning (`version`, `updated`)

### Recommended Approach

Start with:

- append-only for most writes
- lock per canonical note for upserts
- optional optimistic version checks for API clients

Avoid complex CRDT/OT approaches unless scale later proves they are necessary.

## Graceful Conflict Handling

If two agents produce incompatible updates for the same canonical note, do not overwrite silently.

Instead, place unresolved items in a section like:

```md
## Review Needed

- 2026-05-17: Hermes reported capability X, but OpenClaw linked it to concept Y. Needs human review.
```

This preserves information and avoids destructive merges.

## Link Resolution Strategy

The write service should maintain an internal note registry, for example in SQLite, with fields like:

- `note_id`
- `title`
- `aliases`
- `path`
- `type`

This registry allows the service to:

- resolve canonical `[[wikilinks]]`
- reuse existing notes instead of duplicating them
- create stubs or pending links when a target does not exist yet

## Reindex Strategy

Do not run full embedding generation after every single write.

Recommended approach:

- run `qmd update` after changes or in short batches
- debounce `qmd embed` and run it every few minutes when changes exist

This keeps retrieval fresh without making writes too heavy.

## Suggested Implementation Phases

### Phase 1

- define final vault structure
- define note types and frontmatter schema
- create initial hub notes and canonical entity notes

### Phase 2

- install/configure QMD
- create the `brain` collection
- add path contexts
- validate retrieval quality

### Phase 3

- implement the write HTTP API
- implement the write MCP wrapper
- add note locking and structured upsert behavior

### Phase 4

- add automatic reindex/debounced embedding
- refine link resolution rules
- add review workflow for unresolved conflicts

## Open Questions

- final frontmatter schema per note type
- exact slug/title/path strategy
- whether to create stub notes automatically for missing links
- whether review items should live inside notes or in a separate review queue
- authentication and network exposure model for the write API and MCP endpoints
