import { type QmdError, QmdProtocolError, QmdToolError, QmdUnavailableError } from "@ams/api";
import {
  type ExistingNoteSummary,
  NoteExistsError,
  WriteApiConfigError,
  type WriteApiError,
  WriteApiNotFoundError,
  WriteApiValidationError,
} from "@ams/shared";
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

/** How the calling agent resolves a note_exists conflict. */
const NOTE_EXISTS_GUIDANCE =
  "A note already exists at this title. Review the existing content above; " +
  "either retitle your note, or call record_note again with overwrite: true to replace it.";

/**
 * Renders a 409 `note_exists` conflict into a NORMAL (non-error) result.
 *
 * The conflict is a protocol outcome the calling agent must resolve — not a
 * failure of the tool — so it is surfaced with the existing note's id, path
 * and full raw markdown body plus explicit guidance on how to proceed. The
 * client has already applied the field fallbacks ("(unknown id)", ...).
 */
function renderNoteExists(existing: ExistingNoteSummary): CallToolResult {
  const text = [
    `Note already exists: ${existing.id} at ${existing.path}`,
    "",
    "--- existing note (raw markdown) ---",
    existing.body,
    "--- end of existing note ---",
    "",
    NOTE_EXISTS_GUIDANCE,
  ].join("\n");
  return { content: [{ type: "text", text }] };
}

/**
 * Maps a typed `WriteApiClient` failure onto the tool result the pre-client
 * tools produced for the same HTTP outcome — byte-identical strings.
 *
 * `note_exists` stays the only non-error path (a resolvable protocol
 * outcome); every other failure is an error result.
 */
export function mapWriteApiClientError(
  error: WriteApiError,
  context?: { file?: string },
): CallToolResult {
  if (error instanceof WriteApiConfigError) {
    // The client's guard fires on an empty/unconfigured URL; keep the
    // operator-facing string the tools carried before the migration.
    return toMcpError("AMS_API_URL is not configured");
  }
  if (error instanceof NoteExistsError) {
    return renderNoteExists(error.existing);
  }
  if (error instanceof WriteApiValidationError) {
    // The client pre-renders the legacy "Validation error: <messages>"
    // message from the real-API issue shape ({field, message}).
    return toMcpError(error.message);
  }
  if (error instanceof WriteApiNotFoundError && context?.file !== undefined) {
    // The tool renders the delete miss from ITS argument, not the API message.
    return toMcpError(`Note not found: ${context.file}`);
  }
  // WriteApiUnavailableError and WriteApiUnexpectedPayloadError carry
  // messages pre-rendered to match today's branch outputs byte-for-byte.
  return toMcpError(error.message);
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
