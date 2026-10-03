import { type Logger, newRequestId, WriteApiError } from "@ams/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mapUnknownError, mapWriteApiClientError, toMcpText } from "../errors.js";
import { resolveWriteApiClient, type WriteApiDeps } from "../write-api.js";

/** Collaborators needed by the `list_types` tool. */
export interface ListTypesDeps extends WriteApiDeps {
  logger: Logger;
}

/**
 * Registers `list_types`, which lists the note types that currently exist
 * in the vault via the Write API `GET /types` endpoint.
 */
export function registerListTypes(server: McpServer, deps: ListTypesDeps): void {
  server.registerTool(
    "list_types",
    {
      description:
        "List the note types that currently exist in the AMS memory vault. " +
        "Call this before record_note and prefer an existing type for the type " +
        "argument instead of inventing a new one — inventing type names on save " +
        "causes vault folder sprawl. Only introduce a new type when none of the " +
        "existing ones fits.",
      inputSchema: {},
    },
    async (args: Record<string, never>): Promise<CallToolResult> => {
      const tool = "list_types";
      const requestId = newRequestId();
      const startedAt = Date.now();
      deps.logger.info("tool:invoke:start", { tool, requestId, argsKeys: Object.keys(args ?? {}) });
      const run = async (): Promise<CallToolResult> => {
        try {
          const client = resolveWriteApiClient(deps);
          const response = await client.listTypes({ requestId });
          return toMcpText(formatTypes(response.types));
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

/** Formats the type list, nudging the agent away from inventing new types. */
function formatTypes(types: string[]): string {
  if (types.length === 0) {
    return "No note types exist in the vault yet";
  }
  return (
    `Available note types: ${types.join(", ")}\n` +
    "Prefer one of these when recording a note; only invent a new type when none fits"
  );
}
