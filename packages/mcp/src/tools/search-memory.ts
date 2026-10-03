import { type Logger, newRequestId, QmdClient, QmdError } from "@ams/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mapQmdError, mapUnknownError, toMcpText } from "../errors.js";

/** Collaborators needed by the `search_memory` tool. */
export interface SearchMemoryDeps {
  qmdClient?: QmdClient;
  qmdUrl: string;
  logger: Logger;
}

const inputSchema = {
  query: z.string().min(1).describe("Natural-language or keyword query"),
  rerank: z.boolean().optional().describe("Run LLM reranking (slower, may improve precision)"),
  limit: z.number().int().positive().optional().describe("Maximum number of hits"),
  minScore: z.number().min(0).max(1).optional().describe("Minimum relevance score in [0, 1]"),
};

/** Registers `search_memory`, which delegates to the QMD retrieval adapter. */
export function registerSearchMemory(server: McpServer, deps: SearchMemoryDeps): void {
  server.registerTool(
    "search_memory",
    {
      description:
        "Search the AMS memory index. Returns ranked hits with docids. " +
        "Pass a docid (`#abc123`) from a hit to `get_memory` to read the full note.",
      inputSchema,
    },
    async (args): Promise<CallToolResult> => {
      const tool = "search_memory";
      const requestId = newRequestId();
      const startedAt = Date.now();
      // Keys only — argument VALUES must never reach the logs.
      deps.logger.info("tool:invoke:start", { tool, requestId, argsKeys: Object.keys(args) });
      const run = async (): Promise<CallToolResult> => {
        try {
          const client = resolveQmdClient(deps);
          const hits = await client.searchMemory({
            query: args.query,
            rerank: args.rerank,
            limit: args.limit,
            minScore: args.minScore,
          });

          if (hits.length === 0) {
            return toMcpText(`No results found for: ${args.query}`);
          }

          const lines = hits.map(
            (hit) =>
              `[${formatScore(hit.score)}] ${hit.title} (${hit.path}) — ${hit.snippet} [${hit.id}]`,
          );
          return toMcpText(lines.join("\n"));
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
function resolveQmdClient(deps: SearchMemoryDeps): QmdClient {
  return deps.qmdClient ?? new QmdClient({ url: deps.qmdUrl });
}

/** Formats a score as a fixed three-digit value for stable display. */
function formatScore(score: number): string {
  return score.toFixed(3);
}
