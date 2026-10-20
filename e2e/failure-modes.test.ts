import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { QmdClient } from "@ams/api";
import { createServer } from "@ams/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createE2eFixture, freePort } from "./fixtures/vault.js";

describe("lock contention", () => {
  let fx: Awaited<ReturnType<typeof createE2eFixture>>;

  beforeAll(async () => {
    fx = await createE2eFixture();
  }, 60_000);

  afterAll(async () => {
    await fx.teardown();
  }, 30_000);

  it("serializes two concurrent record_note calls for the same note", async () => {
    const [a, b] = await Promise.all([
      fx.mcp.callTool({
        name: "record_note",
        arguments: {
          title: "Concurrent Note",
          type: "note",
          body: "Two agents try to write the same note at once.",
        },
      }),
      fx.mcp.callTool({
        name: "record_note",
        arguments: {
          title: "Concurrent Note",
          type: "note",
          body: "Two agents try to write the same note at once.",
        },
      }),
    ]);

    const texts = [a.content[0]?.text as string, b.content[0]?.text as string];
    const recorded = texts.filter((t) => /Note recorded:/.test(t));
    // The serialized loser sees the conflict as a protocol outcome, not an
    // error, and never clobbers the winner's write.
    const conflicted = texts.filter((t) => /already exists/.test(t));

    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    expect(recorded).toHaveLength(1);
    expect(conflicted).toHaveLength(1);

    const files = await readdir(join(fx.vaultPath, "notes"));
    expect(files).toHaveLength(1);
  });
});

describe("qmd down", () => {
  let fx: Awaited<ReturnType<typeof createE2eFixture>>;

  beforeAll(async () => {
    fx = await createE2eFixture();
  }, 60_000);

  afterAll(async () => {
    await fx.teardown();
  }, 30_000);

  it("maps search_memory to a structured error and keeps the server alive", async () => {
    const deadPort = await freePort();
    const deadQmdClient = new QmdClient({ url: `http://localhost:${deadPort}` });
    const server = createServer({ apiUrl: fx.apiUrl, qmdClient: deadQmdClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ams-e2e-dead", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const searchResult = await client.callTool({
      name: "search_memory",
      arguments: { query: "anything" },
    });

    expect(searchResult.isError).toBe(true);
    expect(searchResult.content[0]?.text).toContain("QMD retrieval unavailable");

    const recordResult = await client.callTool({
      name: "record_note",
      arguments: {
        title: "Server Still Alive",
        type: "note",
        body: "The MCP server must survive a dead QMD endpoint.",
      },
    });

    expect(recordResult.isError).toBeFalsy();
    expect(recordResult.content[0]?.text).toMatch(/Note recorded: .+ at .+/);

    const match = /at (?<path>.+)$/.exec(recordResult.content[0]?.text as string);
    expect(existsSync(join(fx.vaultPath, match?.groups?.path as string))).toBe(true);

    await client.close();
  });
});
