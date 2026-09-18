# AGENTS.md — AMS (Agents Memory System)

Conventions and constraints for any agent working in this repository.
Read this before writing code.

## Project

AMS is an Agents Memory System: a shared-memory architecture for AI agents,
Markdown-first. It is a **general-purpose note-taking system**, not an
ADR-specific tool — the note contract is type-generic (see below). The current
milestone is the **Tracer Bullet** — a minimal end-to-end loop
(agent → MCP → Write API → Vault → QMD → agent reads back), tracked as GitHub
issues `Spec 1`..`Spec 7`.

## Language Policy (IMPORTANT)

**All code, comments, identifiers, UI strings, documentation, commit messages
and PR descriptions MUST be written in English.**

This overrides the global server `AGENTS.md` rule that favors Spanish comments.
Rationale: the repository is public and consumed by tooling (parsers, linters,
search indexes) that work best with English. Spanish (or any other language)
may appear only in:
- Conversational replies to the user (chat), matching the user's language.
- Quoted/translated content when explicitly required.

## Stack

| Aspect | Value |
|--------|-------|
| Runtime | Node.js >= 22 |
| Package manager | pnpm (workspace) |
| Language | TypeScript (`strict`, composite project references) |
| Module system | ESM (`NodeNext`) — imports use `.js` extensions |
| Lint + format | Biome (single tool: double quotes, semicolons, 2-space, lineWidth 100) |
| Tests | Vitest (root config, alias resolves `@ams/shared` to source) |
| Commits | Conventional Commits (enforced by commitlint + husky) |

## Monorepo layout

```
packages/
  shared/   # cross-package types & schemas (the generic note contract lives here)
  api/      # Write API (Spec 3)
  mcp/      # MCP server with domain tools (Spec 6)
```

## Commands

```bash
pnpm install              # install deps (respects lockfile)
pnpm typecheck            # tsc --build (all packages)
pnpm test                 # vitest run
pnpm test:watch           # vitest watch mode
pnpm lint                 # biome lint .
pnpm format               # biome format --write .
pnpm check                # biome check . (lint + format, use before commit)
```

Always run `pnpm typecheck && pnpm test && pnpm check` before committing.

## Conventions

- **Imports**: use `.js` extensions in relative imports (NodeNext). Group and
  sort as Biome's `organizeImports` dictates.
- **Types first**: prefer `import type` for type-only imports.
- **No comments without purpose**: when you do comment, write WHY, not WHAT.
  Keep comments in English (see Language Policy).
- **Simplicity over speculation**: do not add abstractions the tracer bullet
  does not yet justify (see the bootstrap notes in Spec 1).
- **Notes are type-generic**: the base `Note` in `packages/shared` carries a
  `type` field (decision, learning, pattern, note, ...) and a free-form
  markdown body. The parser does NOT enforce any H2 sections. Per-type
  structure (e.g. Context/Decision/Consequences for decisions) is a documented
  convention, not a parser constraint. Do not duplicate note state elsewhere.

## Architecture constraints (from prior decisions)

- **Write locks with TTL** for the Write API (avoid deadlocks, see Spec 3).
- **Do not duplicate note state** in a private SQLite if QMD can be queried.

## Branches & PRs

- Branch from an up-to-date `main` (the default branch; there is no `master`).
- Branch naming: `feat/<desc>`, `fix/<desc>`, `chore/<desc>`, etc.
- One issue per PR. Reference it with `Closes #N` in the commit body and PR.
- Do not force-push unless explicitly asked.
