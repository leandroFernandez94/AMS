import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QmdClient } from "@ams/api";
import { parseNote } from "@ams/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoSurvivors,
  createE2eFixture,
  createIsolationCanary,
  freePort,
  killProcessTree,
  startQmdDaemon,
} from "./fixtures/vault.js";

describe("happy-path loop", () => {
  let fx: Awaited<ReturnType<typeof createE2eFixture>>;

  beforeAll(async () => {
    fx = await createE2eFixture();
  }, 60_000);

  afterAll(async () => {
    await fx.teardown();
  }, 30_000);

  it("records a note via MCP and returns id, path, and created status", async () => {
    const result = await fx.mcp.callTool({
      name: "record_note",
      arguments: {
        title: "End-to-End Verification",
        type: "note",
        body: "End-to-end verification against a live QMD daemon.",
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toMatch(/Note recorded: .+ at .+/);
  });

  it("persists the note on disk and round-trips title and body", async () => {
    const result = await fx.mcp.callTool({
      name: "record_note",
      arguments: {
        title: "End-to-End Persistence",
        type: "note",
        body: "End-to-end persistence verification against a live QMD daemon.",
      },
    });

    const text = result.content[0]?.text as string;
    const match = /at (?<path>.+)$/.exec(text);
    const relPath = match?.groups?.path;
    expect(relPath).toBeTruthy();

    const absPath = join(fx.vaultPath, relPath as string);
    expect(existsSync(absPath)).toBe(true);

    const note = parseNote(await readFile(absPath, "utf8"));
    expect(note.frontmatter.title).toBe("End-to-End Persistence");
    expect(note.body).toContain("End-to-end persistence verification");
  });

  it("reindexes and finds the note via search_memory", async () => {
    const recordResult = await fx.mcp.callTool({
      name: "record_note",
      arguments: {
        title: "End-to-End Retrieval",
        type: "note",
        body: "End-to-end retrieval verification against a live QMD daemon.",
      },
    });
    const relPath = (
      /at (?<path>.+)$/.exec(recordResult.content[0]?.text as string) as RegExpExecArray
    ).groups?.path as string;

    const reindexResult = await fx.reindex();
    expect(reindexResult.status).toBe("ok");
    expect(reindexResult.indexed).toBeGreaterThanOrEqual(1);

    const searchResult = await fx.mcp.callTool({
      name: "search_memory",
      arguments: { query: "end-to-end retrieval" },
    });

    expect(searchResult.isError).toBeFalsy();
    expect(searchResult.content[0]?.text).toContain(relPath);
    expect(searchResult.content[0]?.text).toContain("[#");
  });
});

describe("conflict and resolution", () => {
  let fx: Awaited<ReturnType<typeof createE2eFixture>>;

  beforeAll(async () => {
    fx = await createE2eFixture();
  }, 60_000);

  afterAll(async () => {
    await fx.teardown();
  }, 30_000);

  it("surfaces a title collision as a protocol outcome with the old content", async () => {
    const first = await fx.mcp.callTool({
      name: "record_note",
      arguments: {
        title: "E2E Collision Note",
        type: "note",
        body: "Original collision body.",
      },
    });
    expect(first.isError).toBeFalsy();
    const relPath = /at (?<path>\S+\.md)/.exec(first.content[0]?.text as string)?.groups
      ?.path as string;

    const second = await fx.mcp.callTool({
      name: "record_note",
      arguments: {
        title: "E2E Collision Note",
        type: "note",
        body: "Replacement body.",
      },
    });

    // The conflict is a normal tool outcome the agent resolves, not an error.
    expect(second.isError).toBeFalsy();
    const text = second.content[0]?.text as string;
    expect(text).toContain("already exists");
    expect(text).toContain("Original collision body.");
    expect(text).toContain("retitle your note");
    expect(text).toContain("overwrite: true");

    // Nothing was written: the note on disk keeps the original body.
    const note = parseNote(await readFile(join(fx.vaultPath, relPath), "utf8"));
    expect(note.body).toBe("Original collision body.");
  });

  it("resolves a collision via overwrite: true", async () => {
    await fx.mcp.callTool({
      name: "record_note",
      arguments: {
        title: "E2E Resolution Note",
        type: "note",
        body: "First body.",
      },
    });

    const result = await fx.mcp.callTool({
      name: "record_note",
      arguments: {
        title: "E2E Resolution Note",
        type: "note",
        body: "Second body.",
        overwrite: true,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toMatch(/Note updated: .+ at .+/);

    const relPath = /at (?<path>\S+\.md)/.exec(result.content[0]?.text as string)?.groups
      ?.path as string;
    const note = parseNote(await readFile(join(fx.vaultPath, relPath), "utf8"));
    expect(note.body).toBe("Second body.");
  });

  it("renames the note in place via topic_key and drops the stale index entry", async () => {
    const first = await fx.mcp.callTool({
      name: "record_note",
      arguments: {
        title: "E2E Topic Flow",
        type: "note",
        body: "Topic flow original.",
        topic_key: "e2e/topic-flow",
      },
    });
    expect(first.isError).toBeFalsy();

    const second = await fx.mcp.callTool({
      name: "record_note",
      arguments: {
        title: "E2E Topic Flow Renamed",
        type: "note",
        body: "Topic flow renamed.",
        topic_key: "e2e/topic-flow",
      },
    });

    expect(second.isError).toBeFalsy();
    expect(second.content[0]?.text).toContain(
      "Note updated: e2e-topic-flow-renamed at notes/e2e-topic-flow-renamed.md " +
        "(moved from notes/e2e-topic-flow.md)",
    );

    // File moved: old path gone, new path present and carrying the key.
    expect(existsSync(join(fx.vaultPath, "notes/e2e-topic-flow.md"))).toBe(false);
    const note = parseNote(
      await readFile(join(fx.vaultPath, "notes/e2e-topic-flow-renamed.md"), "utf8"),
    );
    expect(note.frontmatter.topic_key).toBe("e2e/topic-flow");
    expect(note.body).toBe("Topic flow renamed.");

    // After reindexing, search finds the renamed note and the stale entry
    // for the deleted path is gone from the index.
    const reindexResult = await fx.reindex();
    expect(reindexResult.status).toBe("ok");

    const searchResult = await fx.mcp.callTool({
      name: "search_memory",
      arguments: { query: "e2e topic flow renamed" },
    });
    expect(searchResult.isError).toBeFalsy();
    expect(searchResult.content[0]?.text).toContain("notes/e2e-topic-flow-renamed.md");

    const staleResult = await fx.mcp.callTool({
      name: "search_memory",
      arguments: { query: "topic flow original" },
    });
    expect(staleResult.isError).toBeFalsy();
    expect(staleResult.content[0]?.text).not.toContain("notes/e2e-topic-flow.md");
  });

  it("deletes a note via delete_note and drops the stale index entry", async () => {
    const record = await fx.mcp.callTool({
      name: "record_note",
      arguments: {
        title: "E2E Delete Flow",
        type: "note",
        body: "Delete flow body.",
      },
    });
    expect(record.isError).toBeFalsy();
    const relPath = /at (?<path>\S+\.md)/.exec(record.content[0]?.text as string)?.groups
      ?.path as string;

    await fx.reindex();
    const before = await fx.mcp.callTool({
      name: "search_memory",
      arguments: { query: "e2e delete flow" },
    });
    expect(before.isError).toBeFalsy();
    expect(before.content[0]?.text).toContain(relPath);

    const del = await fx.mcp.callTool({
      name: "delete_note",
      arguments: { file: relPath },
    });
    expect(del.isError).toBeFalsy();
    expect(del.content[0]?.text).toBe(`Note deleted: ${relPath}`);
    expect(existsSync(join(fx.vaultPath, relPath))).toBe(false);

    // The delete fires a best-effort background tick, so the drain may land
    // on that tick or on the explicit reindex — poll (bounded) until the
    // index stops serving the deleted path.
    let stale = true;
    for (let attempt = 0; attempt < 10 && stale; attempt++) {
      await fx.reindex();
      const after = await fx.mcp.callTool({
        name: "search_memory",
        arguments: { query: "e2e delete flow" },
      });
      expect(after.isError).toBeFalsy();
      stale = (after.content[0]?.text as string).includes(relPath);
    }
    expect(stale).toBe(false);
  });
});

describe("lifecycle and readiness", () => {
  let fx: Awaited<ReturnType<typeof createE2eFixture>>;

  beforeAll(async () => {
    fx = await createE2eFixture();
  }, 60_000);

  afterAll(async () => {
    await fx.teardown();
  }, 30_000);

  it("knows both bound ports and has a connected MCP client", () => {
    expect(typeof fx.apiUrl).toBe("string");
    expect(fx.apiUrl.length).toBeGreaterThan(0);
    expect(typeof fx.qmdUrl).toBe("string");
    expect(fx.qmdUrl.length).toBeGreaterThan(0);
    expect(fx.mcp).toBeTruthy();
  });

  it("retries daemon boot when the probed port is already taken", async () => {
    const root = await mkdtemp(join(tmpdir(), "ams-e2e-port-"));
    const occupied = await freePort();
    const occupant = createServer();
    await new Promise<void>((resolve, reject) => {
      occupant.listen(occupied, "localhost", () => resolve());
      occupant.on("error", reject);
    });

    let first = true;
    const nextPort = async () => {
      if (first) {
        first = false;
        return occupied;
      }
      return freePort();
    };

    const { child, port, url } = await startQmdDaemon(root, nextPort);
    expect(port).not.toBe(occupied);

    const client = new QmdClient({ url });
    await expect(client.isReachable()).resolves.toBe(true);

    await killProcessTree(child);
    occupant.close();
    await rm(root, { recursive: true, force: true });
    assertNoSurvivors(root);
  });
});

describe("isolation", () => {
  let fx: Awaited<ReturnType<typeof createE2eFixture>>;
  let canary: ReturnType<typeof createIsolationCanary>;

  beforeAll(async () => {
    canary = createIsolationCanary();
    fx = await createE2eFixture();
  }, 60_000);

  afterAll(async () => {
    await fx.teardown();
  }, 30_000);

  it("does not leak .qmd artifacts outside the fixture", async () => {
    await fx.mcp.callTool({
      name: "record_note",
      arguments: {
        title: "Isolation Canary",
        type: "note",
        body: "This note should not touch global QMD state.",
      },
    });
    await fx.reindex();

    expect(() => canary.assertUnchanged()).not.toThrow();
  });

  it("keeps the fixture-local qmd index", () => {
    expect(existsSync(join(fx.root, ".qmd", "index.sqlite"))).toBe(true);
  });
});
