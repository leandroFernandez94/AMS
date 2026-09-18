import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mapUnknownError, mapWriteApiError, toMcpError, toMcpText } from "../errors.js";

/** Collaborators needed by the `list_tags` tool. */
export interface ListTagsDeps {
  apiUrl: string;
  fetch: typeof fetch;
}

/** A tag entry as returned by the Write API `GET /tags` endpoint. */
interface TagCount {
  name: string;
  count: number;
}

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
      const apiUrl = deps.apiUrl.trim();
      if (!apiUrl) {
        return {
          content: [{ type: "text", text: "AMS_API_URL is not configured" }],
          isError: true,
        };
      }

      let response: Response;
      try {
        response = await deps.fetch(`${apiUrl}/tags`);
      } catch {
        return toMcpError("Write API unavailable");
      }

      try {
        if (!response.ok) {
          const body = await parseJson(response);
          return mapWriteApiError(response.status, body);
        }

        const body = await parseJson(response);
        if (!isTagsPayload(body)) {
          return {
            content: [{ type: "text", text: "Write API returned an unexpected payload" }],
            isError: true,
          };
        }

        return toMcpText(formatTags(body.tags));
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

/** Write API GET /tags response shape. */
interface TagsPayload {
  tags: TagCount[];
}

function isTagsPayload(value: unknown): value is TagsPayload {
  const tags = (value as Record<string, unknown> | null)?.tags;
  return (
    Array.isArray(tags) &&
    tags.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).name === "string" &&
        typeof (entry as Record<string, unknown>).count === "number",
    )
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
