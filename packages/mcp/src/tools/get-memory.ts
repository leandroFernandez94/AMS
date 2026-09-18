import { type Logger, QmdClient, QmdError } from "@ams/api";
import { newRequestId } from "@ams/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mapQmdError, mapUnknownError, toMcpError, toMcpText } from "../errors.js";

/** Collaborators needed by the `get_memory` tool. */
export interface GetMemoryDeps {
  qmdClient?: QmdClient;
  qmdUrl: string;
  logger: Logger;
}

const inputSchema = {
  file: z.string().min(1).describe("QMD docid (`#abc123`) from a previous search_memory hit"),
};

/** Registers `get_memory`, which fetches a single note body from QMD. */
export function registerGetMemory(server: McpServer, deps: GetMemoryDeps): void {
  server.registerTool(
    "get_memory",
    {
      description:
        "Read the full body of a note from the AMS memory index. " +
        "Use the docid (`#abc123`) returned by `search_memory` as the `file` argument.",
      inputSchema,
    },
    async (args): Promise<CallToolResult> => {
      const tool = "get_memory";
      const requestId = newRequestId();
      const startedAt = Date.now();
      // Keys only — argument VALUES must never reach the logs.
      deps.logger.info("tool:invoke:start", { tool, requestId, argsKeys: Object.keys(args) });
      const run = async (): Promise<CallToolResult> => {
        try {
          const client = resolveQmdClient(deps);
          const doc = await client.getMemory({ file: args.file });

          if (!doc) {
            return toMcpError(`Not found: ${args.file}`);
          }

          return toMcpText(doc.body);
        } catch (err) {
          if (err instanceof QmdError) return mapQmdError(err);
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

/** Returns the injected client or constructs one from the configured QMD URL. */
function resolveQmdClient(deps: GetMemoryDeps): QmdClient {
  return deps.qmdClient ?? new QmdClient({ url: deps.qmdUrl });
}
