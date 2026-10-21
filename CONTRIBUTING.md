# Contributing to AMS

From a fresh clone to a PR-ready branch in a few minutes. AMS is a pnpm
monorepo (Node.js >= 22, TypeScript, Vitest, Biome) — the commands below are
all you need for the normal workflow.

## Quick path

1. `pnpm install` — install dependencies (respects the lockfile).
2. Create your branch from an up-to-date `main`: `git switch -c feat/<desc>`.
3. Make your change, then verify locally:

   ```bash
   pnpm typecheck && pnpm test && pnpm check
   ```

4. Commit with a Conventional Commit message and open a PR referencing the
   issue (`Closes #N`).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | >= 22 | `engines` field in [package.json](package.json) |
| pnpm | 11.x | Pinned via `packageManager`; `corepack enable` or `npm i -g pnpm` |
| QMD | >= 2.5.3 | Only for the e2e suite: `npm i -g @tobilu/qmd` |

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies (workspace-aware) |
| `pnpm build` | Compile all packages to `dist/` (`tsc --build`) |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm test` | Run the unit test suite (Vitest) |
| `pnpm e2e` | End-to-end suite — boots a temp vault + real QMD daemon |
| `pnpm lint` | Biome lint |
| `pnpm format` | Biome format (writes) |
| `pnpm check` | Biome lint + format — run before committing |

Run `pnpm typecheck && pnpm test && pnpm check` before every commit; the e2e
suite (`pnpm e2e`) when you touch the API, the MCP server, or anything the
write → index → search loop depends on.

## Branches

- Branch from an up-to-date `main` (the default branch).
- Naming: `feat/<desc>`, `fix/<desc>`, `chore/<desc>`, `docs/<desc>`, …
- Do not force-push.

## Commits

- [Conventional Commits](https://www.conventionalcommits.org/) — enforced by
  commitlint + husky (`feat:`, `fix:`, `docs:`, `chore:`, …).
- Reference the issue in the commit body with `Closes #N`.

## Pull requests

- **One issue per PR.** Keep the diff scoped to that issue.
- Reference the issue with `Closes #N` in the PR description too.
- Open an issue first before starting non-trivial work — see
  [README.md](README.md#contributing) for what a good issue includes.

## Language policy

All code, comments, identifiers, documentation, commit messages and PR
descriptions are written in **English** (see [AGENTS.md](AGENTS.md)). Chat and
issues can be in any language.

## Gotchas

- ESM + NodeNext: relative imports use `.js` extensions even in `.ts` files.
- `@ams/shared` resolves to source in tests via a Vitest alias — no build
  needed for `pnpm test`.
- The first e2e run downloads a ~300MB embedding model (one time only, then
  cached). See [docs/quickstart.md](docs/quickstart.md).
