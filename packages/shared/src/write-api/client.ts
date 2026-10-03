/**
 * HTTP client for the Write API (issue #40, task T2).
 *
 * Replicates the exact wire behavior of the four MCP write tools
 * (record-note, delete-note, list-tags, list-types) so task T3 can move
 * them onto this client without changing a single output byte: same URLs,
 * same per-method headers (including the deliberate listTags asymmetry),
 * same per-segment path encoding, same status-to-error mapping. The only
 * addition is a request timeout — the single choke point issue #40 asks
 * for — applied uniformly to every request.
 */
import type { z } from "zod";
import {
  type DeleteResponse,
  DeleteResponseSchema,
  type TagsResponse,
  TagsResponseSchema,
  type TypesResponse,
  TypesResponseSchema,
  type UpsertResponse,
  UpsertResponseSchema,
  type ValidationErrorIssue,
  ValidationErrorIssueSchema,
} from "../api-contracts.js";
import { REQUEST_ID_HEADER } from "../util.js";
import {
  type ExistingNoteSummary,
  NoteExistsError,
  WriteApiConfigError,
  WriteApiNotFoundError,
  WriteApiUnavailableError,
  WriteApiUnexpectedPayloadError,
  WriteApiValidationError,
} from "./errors.js";

/**
 * Minimal structural logger the client needs. Deliberately a method-signature
 * subset of the Write API's `Logger` (packages/api/src/logger.ts, moved into
 * shared by task T4): any Logger satisfies this interface structurally, so T4
 * can swap the import without touching call sites.
 */
export interface WriteApiLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
}

/** Constructor options for {@link WriteApiClient}. */
export interface WriteApiClientOptions {
  /** Base URL of the Write API (e.g. `http://localhost:8787`). */
  url: string;
  /** Fetch implementation; defaults to the global fetch. Injected in tests. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout budget. Defaults to 30000 ms. */
  timeoutMs?: number;
  /** Optional structured logger for one entry per request. */
  logger?: WriteApiLogger;
}

/** Per-call options: the correlation id forwarded as `x-request-id`. */
export interface WriteApiRequestOptions {
  requestId?: string;
}

/**
 * Payload of `POST /notes`, exactly the field set the record_note tool
 * forwards today (its parsed tool args, stringified verbatim).
 */
export interface RecordNoteInput {
  title: string;
  type: string;
  body: string;
  topic_key?: string;
  tags?: string[];
  date?: string;
  overwrite?: boolean;
}

/** Default per-request timeout. Generous enough for lock-protected writes. */
const DEFAULT_TIMEOUT_MS = 30000;

export class WriteApiClient {
  private readonly url: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly logger?: WriteApiLogger;

  constructor(options: WriteApiClientOptions) {
    this.url = options.url;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger;
  }

  async recordNote(input: RecordNoteInput, opts?: WriteApiRequestOptions): Promise<UpsertResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts?.requestId !== undefined) {
      headers[REQUEST_ID_HEADER] = opts.requestId;
    }
    const response = await this.send(
      "/notes",
      { method: "POST", headers, body: JSON.stringify(input) },
      opts?.requestId,
    );
    if (!response.ok) {
      throw await this.failure(response);
    }
    return this.parseSuccess(UpsertResponseSchema, await this.readBody(response));
  }

  async deleteNote(file: string, opts?: WriteApiRequestOptions): Promise<DeleteResponse> {
    // Encode each segment separately: the slashes that structure the
    // path stay literal while special characters in names are escaped.
    const encoded = file.split("/").map(encodeURIComponent).join("/");
    const headers: Record<string, string> = {};
    if (opts?.requestId !== undefined) {
      headers[REQUEST_ID_HEADER] = opts.requestId;
    }
    const response = await this.send(
      `/notes/${encoded}`,
      { method: "DELETE", headers },
      opts?.requestId,
    );
    // Not-found is the expected delete failure and is special-cased before
    // the shared status mapping, exactly like the delete_note tool.
    if (!response.ok) {
      throw await this.failure(response, { file });
    }
    return this.parseSuccess(DeleteResponseSchema, await this.readBody(response));
  }

  async listTags(): Promise<TagsResponse> {
    // No request-id header, mirroring the list_tags tool — an asymmetry the
    // wire contract preserves verbatim.
    const response = await this.send("/tags", { method: "GET" });
    if (!response.ok) {
      throw await this.failure(response);
    }
    return this.parseSuccess(TagsResponseSchema, await this.readBody(response));
  }

  async listTypes(opts?: WriteApiRequestOptions): Promise<TypesResponse> {
    const headers: Record<string, string> = {};
    if (opts?.requestId !== undefined) {
      headers[REQUEST_ID_HEADER] = opts.requestId;
    }
    const response = await this.send("/types", { method: "GET", headers }, opts?.requestId);
    if (!response.ok) {
      throw await this.failure(response);
    }
    return this.parseSuccess(TypesResponseSchema, await this.readBody(response));
  }

  /**
   * Single transport choke point for every request.
   *
   * WHY the timeout lives here and nowhere else: the tools currently pass no
   * `signal` at all, so a hung Write API would block the calling MCP tool
   * forever. Bounding every request in one place (issue #40) keeps the budget
   * uniform and auditable; a timeout abort surfaces as a fetch rejection and
   * is wrapped like any other network failure.
   */
  private async send(path: string, init: RequestInit, requestId?: string): Promise<Response> {
    const base = this.url.trim();
    if (!base) {
      // Centralizes the empty-URL guard the four tools each carry today
      // ("AMS_API_URL is not configured"); T3 maps this type to that string.
      throw new WriteApiConfigError("Write API URL is not configured");
    }
    const method = init.method ?? "GET";
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      this.logRequest(method, path, requestId, startedAt, undefined, cause);
      throw new WriteApiUnavailableError("Write API unavailable", { cause });
    }
    this.logRequest(method, path, requestId, startedAt, response.status);
    return response;
  }

  /**
   * Maps a non-OK response onto the typed error whose data (and pre-rendered
   * message) reproduces today's MCP output byte-for-byte.
   */
  private async failure(response: Response, context?: { file?: string }): Promise<never> {
    const body = asRecord(await this.readBody(response));
    const { status } = response;

    if (status === 400) {
      throw this.validationFailure(body);
    }
    if (status === 409 && body.error === "note_exists") {
      throw this.noteExistsFailure(body);
    }
    // Delete-only special case: 404 is the expected miss; the carried message
    // is the API's own, with the caller-supplied path as fallback.
    if (status === 404 && context?.file !== undefined) {
      const message =
        typeof body.message === "string" && body.message !== ""
          ? body.message
          : `No note at ${context.file}`;
      throw new WriteApiNotFoundError(message);
    }
    throw new WriteApiUnavailableError(`Write API unavailable: ${status}`, { status, body });
  }

  /** Builds the 400 error, replicating the current validation rendering. */
  private validationFailure(body: Record<string, unknown>): WriteApiValidationError {
    // Carried data: well-formed {field, message} pairs per the shared contract.
    const parsed = ValidationErrorIssueSchema.array().safeParse(body.issues);
    const issues: ValidationErrorIssue[] = parsed.success ? parsed.data : [];
    // Rendered message: the legacy MCP mapper reads `issue.path`, which the
    // wire items never carry (the API sends `field`), so each item
    // contributes its message alone — preserved here for byte-identity.
    let detail: string;
    if (Array.isArray(body.issues)) {
      detail = body.issues
        .map((issue) => {
          const message = (issue as { message?: unknown } | null)?.message;
          return typeof message === "string" ? message : "";
        })
        .filter(Boolean)
        .join("; ");
    } else {
      detail = typeof body.error === "string" ? body.error : "invalid request";
    }
    return new WriteApiValidationError(`Validation error: ${detail}`, issues);
  }

  /** Builds the 409 conflict error with the mapper's exact field fallbacks. */
  private noteExistsFailure(body: Record<string, unknown>): NoteExistsError {
    const existing = asRecord(body.existing);
    const summary: ExistingNoteSummary = {
      id: typeof existing.id === "string" ? existing.id : "(unknown id)",
      path: typeof existing.path === "string" ? existing.path : "(unknown path)",
      body: typeof existing.body === "string" ? existing.body : "",
    };
    return new NoteExistsError(`Note already exists: ${summary.id} at ${summary.path}`, summary);
  }

  /** Parses the body as JSON, falling back to `{}` exactly like the tools. */
  private async readBody(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  /** Validates a success body against a shared response contract schema. */
  private parseSuccess<S extends z.ZodType>(schema: S, payload: unknown): z.output<S> {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new WriteApiUnexpectedPayloadError("Write API returned an unexpected payload", payload);
    }
    return parsed.data;
  }

  /**
   * Emits exactly one structured entry per request attempt, keeping the
   * `x-request-id` ↔ log correlation the MCP tests assert.
   */
  private logRequest(
    method: string,
    path: string,
    requestId: string | undefined,
    startedAt: number,
    status?: number,
    cause?: unknown,
  ): void {
    if (!this.logger) {
      return;
    }
    const fields: Record<string, unknown> = {
      method,
      path,
      durationMs: Date.now() - startedAt,
      ...(status !== undefined ? { status } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(cause !== undefined ? { error: String(cause) } : {}),
    };
    const msg = status !== undefined ? "write-api:request:done" : "write-api:request:failed";
    this.logger.info(msg, fields);
  }
}

/** Narrows an unknown JSON value to a record; non-objects read as empty. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
