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
  createIsolationCanary,
  createTracerFixture,
  freePort,
  killProcessTree,
  startQmdDaemon,
} from "./fixtures/vault.js";

describe("happy-path loop", () => {
  let fx: Awaited<ReturnType<typeof createTracerFixture>>;

  beforeAll(async () => {
    fx = await createTracerFixture();
  }, 60_000);

  afterAll(async () => {
    await fx.teardown();
  }, 30_000);

  it("records a note via MCP and returns id, path, and created status", async () => {
    const result = await fx.mcp.callTool({
      name: "record_note",
      arguments: {
        title: "Tracer Bullet Verification",
        type: "note",
        body: "Tracer bullet end-to-end verification against a live QMD daemon.",
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toMatch(/Note recorded: .+ at .+/);
  });

  it("persists the note on disk and round-trips title and body", async () => {
    const result = await fx.mcp.callTool({
      name: "record_note",
      arguments: {
        title: "Tracer Bullet Verification",
        type: "note",
        body: "Tracer bullet end-to-end verification against a live QMD daemon.",
      },
    });

    const text = result.content[0]?.text as string;
    const match = /at (?<path>.+)$/.exec(text);
    const relPath = match?.groups?.path;
    expect(relPath).toBeTruthy();

    const absPath = join(fx.vaultPath, relPath as string);
    expect(existsSync(absPath)).toBe(true);

    const note = parseNote(await readFile(absPath, "utf8"));
    expect(note.frontmatter.title).toBe("Tracer Bullet Verification");
    expect(note.body).toContain("Tracer bullet end-to-end verification");
  });

  it("reindexes and finds the note via search_memory", async () => {
    const recordResult = await fx.mcp.callTool({
      name: "record_note",
      arguments: {
        title: "Tracer Bullet Verification",
        type: "note",
        body: "Tracer bullet end-to-end verification against a live QMD daemon.",
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
      arguments: { query: "tracer bullet verification" },
    });

    expect(searchResult.isError).toBeFalsy();
    expect(searchResult.content[0]?.text).toContain(relPath);
    expect(searchResult.content[0]?.text).toContain("[#");
  });
});

describe("lifecycle and readiness", () => {
  let fx: Awaited<ReturnType<typeof createTracerFixture>>;

  beforeAll(async () => {
    fx = await createTracerFixture();
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
    const root = await mkdtemp(join(tmpdir(), "ams-tracer-port-"));
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
  let fx: Awaited<ReturnType<typeof createTracerFixture>>;
  let canary: ReturnType<typeof createIsolationCanary>;

  beforeAll(async () => {
    canary = createIsolationCanary();
    fx = await createTracerFixture();
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
