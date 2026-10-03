import { type TagCount, WriteApiError } from "@ams/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mapUnknownError, mapWriteApiClientError, toMcpText } from "../errors.js";
import { resolveWriteApiClient, type WriteApiDeps } from "../write-api.js";

/**
 * Collaborators needed by the `list_tags` tool.
 *
 * Deliberately logger-less (and request-id-less on the wire): this read-only
 * vocabulary listing carries no per-invocation logging, an asymmetry the
 * wire contract preserves verbatim.
 */
export type ListTagsDeps = WriteApiDeps;

/**
 * Registers `list_tags`, which lists the tags that currently exist in the
 * vault (with per-tag note counts) via the Write API `GET /tags` endpoint.
 */
export function registerListTags(server: McpServer, deps: ListTagsDeps): void {
  server.registerTool(
    "list_tags",
    {
      description:
        "List the tags that currently exist in the AMS memory vault, with " +
        "per-tag note counts. Call this before record_note and prefer an " +
        "existing tag for the tags argument instead of minting a near-synonym " +
        "(finanzas vs finanzas-personales) — synonym tags fragment retrieval. " +
        "Only introduce a new tag when none of the existing ones fits.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      try {
        const client = resolveWriteApiClient(deps);
        const response = await client.listTags();
        return toMcpText(formatTags(response.tags));
      } catch (err) {
        if (err instanceof WriteApiError) return mapWriteApiClientError(err);
        return mapUnknownError(err);
      }
    },
  );
}

/** Formats the tag vocabulary, nudging the agent away from minting synonyms. */
function formatTags(tags: TagCount[]): string {
  if (tags.length === 0) {
    return "No tags exist in the vault yet";
  }
  const entries = tags.map((tag) => `${tag.name} (${tag.count})`).join(", ");
  return (
    `Tags in the vault: ${entries}\n` +
    "Prefer one of these when recording a note; only mint a new tag when none fits"
  );
}
