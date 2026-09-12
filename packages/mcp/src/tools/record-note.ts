import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mapUnknownError, mapWriteApiError, toMcpError, toMcpText } from "../errors.js";

/** Collaborators needed by the `record_note` tool. */
export interface RecordNoteDeps {
  apiUrl: string;
  fetch: typeof fetch;
}

const inputSchema = {
  title: z.string().min(1).describe("Short, searchable title"),
  type: z.string().min(1).describe("Note type: decision, learning, pattern, note, task, ..."),
  body: z.string().describe("Free-form markdown body"),
  topic_key: z
    .string()
    .min(1)
    .optional()
    .describe("Stable key for topic upserts (same key updates the same note)"),
  tags: z.array(z.string().min(1)).optional().describe("Tags for categorization"),
  date: z.string().optional().describe("ISO date YYYY-MM-DD; defaults to today UTC"),
};

/** Registers `record_note`, which persists a note via the Write API. */
export function registerRecordNote(server: McpServer, deps: RecordNoteDeps): void {
  server.registerTool(
    "record_note",
    {
      description:
        "Record a note in the AMS memory vault. Accepts any type " +
        "(decision, learning, pattern, note, task, ...). The body is free-form markdown.",
      inputSchema,
    },
    async (args): Promise<CallToolResult> => {
      const apiUrl = deps.apiUrl.trim();
      if (!apiUrl) {
        return {
          content: [{ type: "text", text: "AMS_API_URL is not configured" }],
          isError: true,
        };
      }

      let response: Response;
      try {
        response = await deps.fetch(`${apiUrl}/notes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args),
        });
      } catch {
        return toMcpError("Write API unavailable");
      }

      try {
        if (!response.ok) {
          const body = await parseJson(response);
          return mapWriteApiError(response.status, body);
        }

        const body = await parseJson(response);
        if (!isUpsertResult(body)) {
          return {
            content: [{ type: "text", text: "Write API returned an unexpected payload" }],
            isError: true,
          };
        }

        const action = body.created === false ? "updated" : "recorded";
        return toMcpText(`Note ${action}: ${body.id} at ${body.path}`);
      } catch (err) {
        return mapUnknownError(err);
      }
    },
  );
}

/** Parses the response body as JSON when possible, falling back to an empty object. */
async function parseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Write API upsert response shape. */
interface UpsertResult {
  id: string;
  path: string;
  created?: boolean;
}

function isUpsertResult(value: unknown): value is UpsertResult {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).id === "string" &&
    typeof (value as Record<string, unknown>).path === "string"
  );
}
