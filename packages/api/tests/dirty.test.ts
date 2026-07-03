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
    await store.mark("decisions/2026-07-01-x.md");
    expect(store.has("decisions/2026-07-01-x.md")).toBe(true);
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
});
