/**
 * Typed errors for the Write API HTTP client.
 *
 * Every failure mode the client can hit is expressed as a distinct error
 * class so callers (the MCP write tools, once task T3 moves them onto the
 * client) can format their user-facing strings from structured data instead
 * of re-parsing HTTP responses. Each class carries ALL the data the current
 * MCP mappers need, and its `message` is pre-rendered to match today's tool
 * output byte-for-byte, so T3 can use either verbatim.
 *
 * Hierarchy:
 *   WriteApiError                    — base for everything client-related
 *     WriteApiConfigError            — empty/unconfigured API URL (the guard
 *                                      the tools each carry today, centralized)
 *     WriteApiUnavailableError       — network failure, timeout, or an
 *                                      unexpected HTTP status (5xx, ...)
 *     NoteExistsError                — 409 `note_exists` conflict, carrying
 *                                      the occupying note for agent resolution
 *     WriteApiValidationError        — 400 with per-field validation issues
 *     WriteApiNotFoundError          — DELETE 404 (the expected delete miss)
 *     WriteApiUnexpectedPayloadError — 2xx whose body failed schema parsing
 */
import type { ValidationErrorIssue } from "../api-contracts.js";

/** Base class for all Write API client failures. Distinct type for catch blocks. */
export class WriteApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteApiError";
  }
}

/**
 * The API URL is empty or whitespace-only — the request was never sent.
 * Today every tool guards this itself ("AMS_API_URL is not configured");
 * the client centralizes the guard and T3 maps this type back to that string.
 */
export class WriteApiConfigError extends WriteApiError {
  constructor(message: string) {
    super(message);
    this.name = "WriteApiConfigError";
  }
}

/**
 * Occupying note of a 409 `note_exists` conflict: identity plus the FULL raw
 * markdown source, so the calling agent can review exactly what it collides
 * with. The field fallbacks applied by the client ("(unknown id)", ...) mirror
 * the current MCP conflict mapping, keeping T3's output byte-identical.
 */
export interface ExistingNoteSummary {
  id: string;
  path: string;
  body: string;
}

export class NoteExistsError extends WriteApiError {
  readonly existing: ExistingNoteSummary;

  constructor(message: string, existing: ExistingNoteSummary) {
    super(message);
    this.name = "NoteExistsError";
    this.existing = existing;
  }
}

export class WriteApiValidationError extends WriteApiError {
  readonly issues: ValidationErrorIssue[];

  constructor(message: string, issues: ValidationErrorIssue[]) {
    super(message);
    this.name = "WriteApiValidationError";
    this.issues = issues;
  }
}

/**
 * The target note does not exist (DELETE 404). The carried message is the
 * API's `message` field; today's tool actually renders its own string from
 * the caller-supplied path, which T3 still has in scope.
 */
export class WriteApiNotFoundError extends WriteApiError {
  constructor(message: string) {
    super(message);
    this.name = "WriteApiNotFoundError";
  }
}

/**
 * The Write API could not be reached, timed out, or answered with an
 * unexpected status. Carries the HTTP status (absent for network failures)
 * and the parsed error body (e.g. a 503 `write_conflict` envelope) so the
 * mapper can reproduce `Write API unavailable[: <status>]` exactly.
 */
export class WriteApiUnavailableError extends WriteApiError {
  readonly status?: number;
  readonly body?: Record<string, unknown>;

  constructor(
    message: string,
    options?: { cause?: unknown; status?: number; body?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "WriteApiUnavailableError";
    if (options?.status !== undefined) {
      this.status = options.status;
    }
    if (options?.body !== undefined) {
      this.body = options.body;
    }
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * A 2xx response whose body did not satisfy the shared response contract.
 * The raw parsed payload travels along so contract drift is debuggable.
 */
export class WriteApiUnexpectedPayloadError extends WriteApiError {
  readonly payload: unknown;

  constructor(message: string, payload: unknown) {
    super(message);
    this.name = "WriteApiUnexpectedPayloadError";
    this.payload = payload;
  }
}
