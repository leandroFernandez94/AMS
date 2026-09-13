import { type QmdError, QmdProtocolError, QmdToolError, QmdUnavailableError } from "@ams/api";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Builds a plain text MCP result. */
export function toMcpText(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

/** Builds a structured MCP error result from a human-readable message. */
export function toMcpError(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

/** Body shape returned by the Write API on a validation failure. */
interface WriteApiValidationBody {
  error?: string;
  issues?: Array<{ message?: string; path?: string[] | string }>;
}

/** Body shape returned by the Write API on a note_exists conflict (409). */
interface NoteExistsBody {
  error?: string;
  existing?: { id?: string; path?: string; body?: string };
}

/** How the calling agent resolves a note_exists conflict. */
const NOTE_EXISTS_GUIDANCE =
  "A note already exists at this title. Review the existing content above; " +
  "either retitle your note, or call record_note again with overwrite: true to replace it.";

/**
 * Maps a 409 `note_exists` conflict into a NORMAL (non-error) result.
 *
 * The conflict is a protocol outcome the calling agent must resolve — not a
 * failure of the tool — so it is surfaced with the existing note's id, path
 * and full raw markdown body plus explicit guidance on how to proceed.
 */
export function mapNoteExists(body: NoteExistsBody): CallToolResult {
  const existing = body.existing ?? {};
  const id = typeof existing.id === "string" ? existing.id : "(unknown id)";
  const path = typeof existing.path === "string" ? existing.path : "(unknown path)";
  const raw = typeof existing.body === "string" ? existing.body : "";
  const text = [
    `Note already exists: ${id} at ${path}`,
    "",
    "--- existing note (raw markdown) ---",
    raw,
    "--- end of existing note ---",
    "",
    NOTE_EXISTS_GUIDANCE,
  ].join("\n");
  return { content: [{ type: "text", text }] };
}

/** Maps a Write API 400 response into a validation error result. */
export function mapWriteApiValidation(body: WriteApiValidationBody): CallToolResult {
  const issues = Array.isArray(body.issues)
    ? body.issues
        .map((issue) => {
          const path = Array.isArray(issue.path) ? issue.path.join(".") : issue.path;
          return path ? `${path}: ${issue.message ?? ""}` : (issue.message ?? "");
        })
        .filter(Boolean)
        .join("; ")
    : (body.error ?? "invalid request");
  return toMcpError(`Validation error: ${issues}`);
}

/**
 * Maps a non-2xx Write API response into a tool result.
 *
 * A 409 `note_exists` takes the dedicated non-error path (`mapNoteExists`) —
 * it is a resolvable protocol outcome. Every other failure is an error.
 */
export function mapWriteApiError(
  status: number,
  body: WriteApiValidationBody & NoteExistsBody,
): CallToolResult {
  if (status === 400) return mapWriteApiValidation(body);
  if (status === 409 && body.error === "note_exists") return mapNoteExists(body);
  return toMcpError(`Write API unavailable: ${status}`);
}

/** Maps a `QmdError` subclass into a structured retrieval error result. */
export function mapQmdError(err: QmdError): CallToolResult {
  if (err instanceof QmdUnavailableError) {
    return toMcpError(`QMD retrieval unavailable: ${err.message}`);
  }
  if (err instanceof QmdProtocolError || err instanceof QmdToolError) {
    return toMcpError(`QMD error: ${err.message}`);
  }
  return toMcpError(`QMD error: ${err.message}`);
}

/** Maps an unexpected failure into a generic internal error result. */
export function mapUnknownError(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[mcp] internal error: ${message}\n`);
  return toMcpError("Internal error");
}
