# E2E Suite Specification

## Purpose

An isolated end-to-end harness proving the end-to-end loop — MCP `record_note` → Write API → note file in the vault → reindex → MCP `search_memory` against a live QMD daemon — plus its failure modes, without touching global QMD state or the default test suites.

## Requirements

### Requirement: End-to-End Loop Proof

The suite MUST prove the full chain: MCP `record_note` → Write API → note file on disk in the vault → `POST /admin/reindex` returns ok → `search_memory` returns the just-written note. The MCP server SHALL be driven in-process; retrieval SHALL hit a live QMD daemon.

#### Scenario: Happy-path loop

- GIVEN a booted Write API, a ready QMD daemon, and an in-process MCP client
- WHEN `record_note` records a new note and the suite calls `POST /admin/reindex`
- THEN reindex reports ok and `search_memory` over the note's content returns a hit naming the note's vault-relative path

#### Scenario: Note content and path on disk

- GIVEN `record_note` returned `{ id, path }`
- WHEN the vault directory is inspected
- THEN a note file exists at the returned path and its parsed title and body round-trip the recorded input

### Requirement: Fixture Isolation

The fixture builder MUST create a clean temp vault per run (`mkdtemp`), MUST run every spawned qmd process with the fixture cwd so index state lives only in the project-local `.qmd`, MUST inject a cwd-scoped `CommandRunner` into the `CliReindexer`, and MUST NOT touch any index outside the fixture.

#### Scenario: Isolation canary

- GIVEN the full loop has run in the fixture
- WHEN global and parent locations (`~/.cache/qmd`, repo root, temp parent) are inspected
- THEN no new `.qmd` artifacts appear outside the fixture and the fixture-local `.qmd` index exists

#### Scenario: Teardown

- GIVEN a suite run has ended, passed or failed
- WHEN fixture teardown runs
- THEN every spawned qmd process is killed and the temp directory is removed

### Requirement: Lifecycle and Readiness

The harness MUST boot the Write API in-process on an ephemeral port, boot the QMD daemon on a dynamically chosen free port, and poll daemon readiness with backoff before any assertion.

#### Scenario: Successful boot

- GIVEN the harness starts without port conflicts
- WHEN the Write API and daemon boot
- THEN readiness polling succeeds within its timeout and the test knows both bound ports

#### Scenario: Chosen daemon port is taken

- GIVEN the probed daemon port is occupied by another process
- WHEN the harness boots the daemon
- THEN a different free port is selected and the suite proceeds to readiness

### Requirement: Failure Mode Assertions

The suite MUST assert each failure mode at least once:

| Mode | Assertion |
|------|-----------|
| Lock contention — two concurrent `record_note` for the same note | Serialized FIFO writes: exactly one created and one updated; there is no conflict response |
| QMD down — `search_memory` against a dead endpoint | Mapped `QMD retrieval unavailable` error |

#### Scenario: Concurrent same-note writes serialize

- GIVEN two `record_note` calls for the same logical note issued concurrently
- WHEN both calls complete
- THEN exactly one reports created and exactly one reports updated, reflecting serialized FIFO writes

#### Scenario: QMD down

- GIVEN the QMD client targets a dead port
- WHEN `search_memory` is called
- THEN the result is an error containing `QMD retrieval unavailable` and the MCP server keeps running

### Requirement: E2E Entrypoint

The root `pnpm e2e` script MUST run the suite via a dedicated vitest config and MUST fail fast with a clear message when `qmd` is not on PATH. The default `pnpm test`/CI run MUST NOT collect the suite — separate config/include, not skip logic. The suite MUST resolve workspace imports; the alias strategy is a design decision.

#### Scenario: E2E run on a prepared machine

- GIVEN a clean clone with Node ≥ 22 and QMD on PATH
- WHEN `pnpm e2e` runs
- THEN the E2E suite executes and passes

#### Scenario: Missing qmd binary

- GIVEN `qmd` is not on PATH
- WHEN `pnpm e2e` runs
- THEN it exits before running tests with a message naming the missing prerequisite

#### Scenario: Default suite untouched

- GIVEN CI runs plain `pnpm test` without QMD
- WHEN the default suite runs
- THEN no e2e file is collected and the run passes as before

### Requirement: E2E Runbook

`docs/e2e-runbook.md` MUST let a human reproduce the loop manually with curl against the Write API and an MCP client for the tools, and MUST document the first-run embedding-model download.

#### Scenario: Manual reproduction

- GIVEN the runbook on a machine with QMD installed
- WHEN a human follows its steps
- THEN they observe the same write → disk → reindex → retrieve loop the suite proves

#### Scenario: First-run model download is documented

- GIVEN a machine that never ran QMD embeddings
- WHEN the reader checks the runbook before first run
- THEN the embedding-model download and its expected cost are called out
