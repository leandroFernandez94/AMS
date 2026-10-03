import { type Logger, newRequestId, WriteApiError } from "@ams/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mapUnknownError, mapWriteApiClientError, toMcpText } from "../errors.js";
import { resolveWriteApiClient, type WriteApiDeps } from "../write-api.js";

/** Collaborators needed by the `delete_note` tool. */
export interface DeleteNoteDeps extends WriteApiDeps {
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
        try {
          const client = resolveWriteApiClient(deps);
          // Per-segment path encoding is the client's concern; the not-found
          // miss is rendered from this tool's own argument in the mapper.
          const result = await client.deleteNote(args.file, { requestId });
          return toMcpText(`Note deleted: ${result.path}`);
        } catch (err) {
          if (err instanceof WriteApiError) {
            return mapWriteApiClientError(err, { file: args.file });
          }
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
