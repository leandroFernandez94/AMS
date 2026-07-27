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

/** Maps a non-2xx Write API response into an unavailable error result. */
export function mapWriteApiError(status: number, body: WriteApiValidationBody): CallToolResult {
  if (status === 400) return mapWriteApiValidation(body);
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
