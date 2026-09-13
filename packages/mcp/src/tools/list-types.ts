import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mapUnknownError, mapWriteApiError, toMcpError, toMcpText } from "../errors.js";

/** Collaborators needed by the `list_types` tool. */
export interface ListTypesDeps {
  apiUrl: string;
  fetch: typeof fetch;
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
        response = await deps.fetch(`${apiUrl}/types`);
      } catch {
        return toMcpError("Write API unavailable");
      }

      try {
        if (!response.ok) {
          const body = await parseJson(response);
          return mapWriteApiError(response.status, body);
        }

        const body = await parseJson(response);
        if (!isTypesPayload(body)) {
          return {
            content: [{ type: "text", text: "Write API returned an unexpected payload" }],
            isError: true,
          };
        }

        return toMcpText(formatTypes(body.types));
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

/** Write API GET /types response shape. */
interface TypesPayload {
  types: string[];
}

function isTypesPayload(value: unknown): value is TypesPayload {
  const types = (value as Record<string, unknown> | null)?.types;
  return Array.isArray(types) && types.every((entry) => typeof entry === "string");
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
