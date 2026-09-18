import type { Logger } from "@ams/api";
import { newRequestId, REQUEST_ID_HEADER } from "@ams/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mapUnknownError, mapWriteApiError, toMcpError, toMcpText } from "../errors.js";

/** Collaborators needed by the `delete_note` tool. */
export interface DeleteNoteDeps {
  apiUrl: string;
  fetch: typeof fetch;
  logger: Logger;
}

const inputSchema = {
  file: z
    .string()
    .min(1)
    .describe(
      "Vault-relative note path (e.g. decisions/use-qmd.md) as shown in search_memory results",
    ),
};

/** Registers `delete_note`, which removes a note via the Write API. */
export function registerDeleteNote(server: McpServer, deps: DeleteNoteDeps): void {
  server.registerTool(
    "delete_note",
    {
      description:
        "Delete a note from the AMS memory vault by its vault-relative path — " +
        "the path shown in parentheses in search_memory results.",
      inputSchema,
    },
    async (args): Promise<CallToolResult> => {
      const tool = "delete_note";
      const requestId = newRequestId();
      const startedAt = Date.now();
      // Keys only — argument VALUES must never reach the logs.
      deps.logger.info("tool:invoke:start", { tool, requestId, argsKeys: Object.keys(args) });
      const run = async (): Promise<CallToolResult> => {
        const apiUrl = deps.apiUrl.trim();
        if (!apiUrl) {
          return {
            content: [{ type: "text", text: "AMS_API_URL is not configured" }],
            isError: true,
          };
        }

        // Encode each segment separately: the slashes that structure the
        // path stay literal while special characters in names are escaped.
        const encoded = args.file.split("/").map(encodeURIComponent).join("/");
        let response: Response;
        try {
          response = await deps.fetch(`${apiUrl}/notes/${encoded}`, {
            method: "DELETE",
            headers: { [REQUEST_ID_HEADER]: requestId },
          });
        } catch {
          return toMcpError("Write API unavailable");
        }

        try {
          if (!response.ok) {
            const body = await parseJson(response);
            if (response.status === 404) {
              // Not-found is the expected delete failure and deserves a
              // clearer message than the generic 404 mapping.
              return toMcpError(`Note not found: ${args.file}`);
            }
            return mapWriteApiError(response.status, body);
          }

          const body = await parseJson(response);
          if (!isDeleteResult(body)) {
            return {
              content: [{ type: "text", text: "Write API returned an unexpected payload" }],
              isError: true,
            };
          }

          return toMcpText(`Note deleted: ${body.path}`);
        } catch (err) {
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

/** Parses the response body as JSON when possible, falling back to an empty object. */
async function parseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Write API delete response shape. */
interface DeleteResult {
  deleted: boolean;
  path: string;
}

function isDeleteResult(value: unknown): value is DeleteResult {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).deleted === true &&
    typeof (value as Record<string, unknown>).path === "string"
  );
}
