import type { Logger } from "@ams/api";
import { newRequestId, type UpsertResponse, WriteApiError } from "@ams/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mapUnknownError, mapWriteApiClientError, toMcpText } from "../errors.js";
import { resolveWriteApiClient, type WriteApiDeps } from "../write-api.js";

/** Collaborators needed by the `record_note` tool. */
export interface RecordNoteDeps extends WriteApiDeps {
  logger: Logger;
}

const inputSchema = {
  title: z.string().min(1).describe("Short, searchable title"),
  type: z
    .string()
    .min(1)
    .describe(
      "Note type: decision, learning, pattern, note, task, ... " +
        "Prefer a type returned by list_types; only invent a new one when none fits",
    ),
  body: z.string().describe("Free-form markdown body"),
  topic_key: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Stable key for topic upserts: a note already carrying this key is updated " +
        "in place, even when the title or type changes (the file moves to the new " +
        "canonical path and the old file is removed — no orphans). " +
        "Format: lowercase ASCII path segments ([a-z0-9-]) joined by / (regex: " +
        "^[a-z0-9][a-z0-9-]*(/[a-z0-9][a-z0-9-]*)*$). No uppercase, underscores, " +
        "spaces or accents — transliterate first: energia/banos is valid; " +
        "energia/baños, GTD/Inbox and note_key are not.",
    ),
  tags: z.array(z.string().min(1)).optional().describe("Tags for categorization"),
  date: z.string().optional().describe("ISO date YYYY-MM-DD; defaults to today UTC"),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      "Force replacement on title collision: when a note already exists at the " +
        "derived path, replace it instead of returning the conflict",
    ),
};

/** Registers `record_note`, which persists a note via the Write API. */
export function registerRecordNote(server: McpServer, deps: RecordNoteDeps): void {
  server.registerTool(
    "record_note",
    {
      description:
        "Record a note in the AMS memory vault. Accepts any type " +
        "(decision, learning, pattern, note, task, ...). The body is free-form markdown. " +
        "Routing: a payload with topic_key updates the note already carrying that key " +
        "in place, even if the title changed (the file is renamed, no orphan left behind). " +
        "Without topic_key, a title that resolves to an occupied path returns the " +
        "existing note's full content as a conflict — this is not an error: retitle " +
        "the note, or retry the same call with overwrite: true to replace the existing " +
        "one. If topic_key keeps failing validation, omit topic_key and retry with " +
        "overwrite: true.",
      inputSchema,
    },
    async (args): Promise<CallToolResult> => {
      const tool = "record_note";
      const requestId = newRequestId();
      const startedAt = Date.now();
      // Keys only — argument VALUES must never reach the logs.
      deps.logger.info("tool:invoke:start", { tool, requestId, argsKeys: Object.keys(args) });
      const run = async (): Promise<CallToolResult> => {
        try {
          const client = resolveWriteApiClient(deps);
          const result = await client.recordNote(args, { requestId });
          return toMcpText(formatUpsert(result));
        } catch (err) {
          if (err instanceof WriteApiError) return mapWriteApiClientError(err);
          return mapUnknownError(err);
        }
      };
      try {
        const result = await run();
        const durationMs = Date.now() - startedAt;
        if (result.isError) {
          deps.logger.error("tool:invoke:failed", { tool, requestId, ok: false, durationMs });
        } else {
          deps.logger.info("tool:invoke:done", { tool, requestId, ok: true, durationMs });
        }
        return result;
      } catch (error) {
        deps.logger.error("tool:invoke:failed", {
          tool,
          requestId,
          ok: false,
          durationMs: Date.now() - startedAt,
          error: String(error),
        });
        throw error;
      }
    },
  );
}

/** Renders the upsert outcome line, including the rename suffix when moved. */
function formatUpsert(result: UpsertResponse): string {
  const action = result.created === false ? "updated" : "recorded";
  const moved = typeof result.moved_from === "string" ? ` (moved from ${result.moved_from})` : "";
  return `Note ${action}: ${result.id} at ${result.path}${moved}`;
}
