import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirtyStore } from "../src/dirty.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ams-dirty-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("DirtyStore", () => {
  it("marks a path and exposes it via has()", async () => {
    const store = new DirtyStore(join(dir, ".ams", "dirty.json"));
    await store.mark("decisions/use-qmd.md");
    expect(store.has("decisions/use-qmd.md")).toBe(true);
    expect(store.has("decisions/nope.md")).toBe(false);
  });

  it("persists marks to the JSON file atomically", async () => {
    const file = join(dir, ".ams", "dirty.json");
    const store = new DirtyStore(file);
    await store.mark("learnings/a.md");

    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed["learnings/a.md"]).toHaveProperty("markedAt");
    expect(typeof parsed["learnings/a.md"].markedAt).toBe("number");
    // No requestId supplied — the key stays absent, not null/undefined.
    expect(parsed["learnings/a.md"]).not.toHaveProperty("requestId");
  });

  it("persists the requestId alongside markedAt when supplied", async () => {
    const file = join(dir, ".ams", "dirty.json");
    const store = new DirtyStore(file);
    await store.mark("learnings/a.md", "req_x");

    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(parsed["learnings/a.md"]).toEqual({ markedAt: expect.any(Number), requestId: "req_x" });
    const entry = store.snapshot()[0];
    expect(entry.requestId).toBe("req_x");
  });

  it("keeps all marks when several are written concurrently", async () => {
    const store = new DirtyStore(join(dir, ".ams", "dirty.json"));
    const paths = Array.from({ length: 10 }, (_, i) => `notes/n${i}.md`);
    await Promise.all(paths.map((p) => store.mark(p)));

    const snap = store.snapshot().map((e) => e.path);
    expect(snap.sort()).toEqual([...paths].sort());
  });

  it("snapshot includes path and timestamp", async () => {
    const store = new DirtyStore(join(dir, ".ams", "dirty.json"));
    await store.mark("patterns/singleton.md");
    const entry = store.snapshot()[0];
    expect(entry.path).toBe("patterns/singleton.md");
    expect(entry.markedAt).toBeLessThanOrEqual(Date.now());
  });

  it("clears specific paths and persists the change", async () => {
    const file = join(dir, ".ams", "dirty.json");
    const store = new DirtyStore(file);
    await store.mark("notes/a.md");
    await store.mark("notes/b.md");
    await store.mark("notes/c.md");

    await store.clear(["notes/a.md", "notes/c.md"]);

    expect(store.has("notes/a.md")).toBe(false);
    expect(store.has("notes/c.md")).toBe(false);
    expect(store.has("notes/b.md")).toBe(true);

    const persisted = JSON.parse(await readFile(file, "utf8"));
    expect(persisted).not.toHaveProperty("notes/a.md");
    expect(persisted).toHaveProperty("notes/b.md");
  });

  it("clears every flag when no paths are given", async () => {
    const file = join(dir, ".ams", "dirty.json");
    const store = new DirtyStore(file);
    await Promise.all([store.mark("a.md"), store.mark("b.md")]);

    await store.clear();

    expect(store.snapshot()).toEqual([]);
    const persisted = JSON.parse(await readFile(file, "utf8"));
    expect(persisted).toEqual({});
  });

  it("is a no-op when clearing an empty store", async () => {
    const store = new DirtyStore(join(dir, ".ams", "dirty.json"));
    await expect(store.clear()).resolves.toBeUndefined();
    await expect(store.clear(["nothing.md"])).resolves.toBeUndefined();
  });

  it("serializes concurrent marks and clears without losing updates", async () => {
    const store = new DirtyStore(join(dir, ".ams", "dirty.json"));
    await Promise.all([
      store.mark("a.md"),
      store.mark("b.md"),
      store.clear(["a.md"]),
      store.mark("c.md"),
    ]);

    const paths = store
      .snapshot()
      .map((e) => e.path)
      .sort();
    expect(paths).toEqual(["b.md", "c.md"]);
  });
});
