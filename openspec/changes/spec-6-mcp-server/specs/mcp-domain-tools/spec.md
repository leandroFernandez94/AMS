# MCP Domain Tools Specification

## Purpose

Semantic MCP tools that expose AMS write and retrieval surfaces to AI agents over stdio. Agents never touch the filesystem or QMD daemon directly: mutations flow through the Write API (Spec 3), reads through the QMD adapter (Spec 4).

## Requirements

### Requirement: Tool Catalog

The server SHALL expose exactly three tools — `record_note`, `search_memory`, `get_memory` — each with a stable name, a typed input schema, and a description explicit enough for an LLM to pick the right tool without examples.

#### Scenario: Client lists the catalog

- GIVEN a connected MCP client
- WHEN it calls `tools/list`
- THEN the response contains exactly those three tools, each with a non-empty description and typed input schema

### Requirement: Typed Input Schemas

Each tool MUST reject malformed input before any upstream call.

| Tool | Required | Optional |
|------|----------|----------|
| `record_note` | `title`, `type`, `body` (strings) | `topic_key`, `tags: string[]`, `date` |
| `search_memory` | `query: string` | `rerank: boolean`, `limit: number`, `minScore: number` |
| `get_memory` | `file: string` | — |

#### Scenario: Missing required field

- GIVEN a client call to any tool with a missing required field
- WHEN the server validates input
- THEN it returns a structured MCP error without invoking the upstream

### Requirement: record_note Persistence

`record_note` MUST persist through the Write API `POST /notes` over HTTP, SHALL accept any non-empty `type`, and on success MUST return `{ id, path, created }` in agent-readable form.

#### Scenario: New note round-trip

- GIVEN the Write API is reachable
- WHEN `record_note` is called with valid `{ title, type, body }`
- THEN the server POSTs to `/notes` and returns `{ id, path, created }`

### Requirement: search_memory Retrieval

`search_memory` MUST delegate to an injected `QmdClient.searchMemory()`, forwarding `rerank`, `limit`, and `minScore` when set, and MUST return hits including each `id`, `path`, `title`, `snippet`, and `score`.

#### Scenario: Forwarded rerank flag

- GIVEN a wired `QmdClient`
- WHEN `search_memory` is called with `{ query, rerank: true }`
- THEN `QmdClient.searchMemory` is invoked with `rerank: true`

#### Scenario: Empty result is not an error

- GIVEN `QmdClient.searchMemory()` returns `[]`
- WHEN `search_memory` is called
- THEN the server returns a non-error result with an empty hit list

### Requirement: get_memory Retrieval

`get_memory` MUST delegate to an injected `QmdClient.getMemory({ file })`, returning the body when found and an explicit not-found result when absent. Its description SHOULD steer agents to pass a QMD docid (`#abc123`) from a prior `search_memory` hit.

#### Scenario: Document found

- GIVEN `QmdClient.getMemory()` returns a document
- WHEN `get_memory` is called with that `file`
- THEN the server returns the body in agent-readable form

#### Scenario: Document not found

- GIVEN `QmdClient.getMemory()` returns `null`
- WHEN `get_memory` is called
- THEN the server returns a non-error result indicating not-found

### Requirement: Structured Error Mapping

Upstream failures MUST surface as MCP results with `isError: true` and a human-readable message; the process MUST NOT crash. This SHALL cover Write API non-2xx responses, malformed Write API payloads, and every `QmdError` subclass (`QmdUnavailableError`, `QmdProtocolError`, `QmdToolError`).

#### Scenario: Write API 500

- GIVEN the Write API responds `500`
- WHEN `record_note` is called
- THEN the server returns `{ isError: true }` naming the write failure

#### Scenario: QMD unavailable

- GIVEN `QmdClient` throws `QmdUnavailableError`
- WHEN `search_memory` is called
- THEN the server returns `{ isError: true }` naming the retrieval failure and keeps running

### Requirement: Server Factory and Transport

`createServer(deps?)` MUST register tools and return a server WITHOUT connecting a transport, so a stdio entry can connect `StdioServerTransport` and tests can drive the same factory via `InMemoryTransport`. Configuration MUST be resolvable from `AMS_API_URL` and `AMS_QMD_URL`. Deps (Write API base URL, `QmdClient`, `fetch`) SHALL be injectable. All logging MUST go to stderr; writing logs to stdout SHALL be a defect because it corrupts the JSON-RPC stream.

#### Scenario: Factory is transport-agnostic

- GIVEN `createServer()` is called with injected deps
- WHEN the returned server is inspected
- THEN no transport has been connected

#### Scenario: Stdout stays clean

- GIVEN the server is running over stdio
- WHEN any tool is invoked
- THEN only JSON-RPC frames are written to stdout

#### Scenario: In-memory tool call

- GIVEN a server wired to an `InMemoryTransport` with fakes
- WHEN the in-memory client calls `record_note`
- THEN the call flows through the injected `fetch` without real I/O
