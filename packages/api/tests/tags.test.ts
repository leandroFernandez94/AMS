import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createLogger, DirtyStore, Vault, WriteLock } from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), "ams-api-tags-"));
});

afterEach(async () => {
  await rm(vaultDir, { recursive: true, force: true });
});

function makeApp(vault: Vault): ReturnType<typeof createApp> {
  return createApp({
    vault,
    lock: new WriteLock(5000),
    dirty: new DirtyStore(join(vaultDir, ".ams", "dirty.json")),
    // Silent logger: keeps test output clean. Level "error" still allows
    // failure paths to surface if we ever assert on logs.
    logger: createLogger(() => undefined, "error"),
  });
}

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/notes", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// GET /tags
// ---------------------------------------------------------------------------

describe("GET /tags", () => {
  it("returns the aggregated vocabulary sorted by count desc then name asc", async () => {
    const app = makeApp(new Vault(vaultDir));

    const payloads = [
      {
        title: "Budget tracking",
        type: "note",
        body: "b",
        date: "2026-07-01",
        tags: ["finanzas", "2026"],
      },
      { title: "Monthly review", type: "note", body: "b", date: "2026-07-01", tags: ["finanzas"] },
      {
        title: "Retrieval engine",
        type: "decision",
        body: "b",
        date: "2026-07-01",
        tags: ["finanzas", "qmd"],
      },
      // Duplicate tag within one note must count once (notes carrying it, not occurrences).
      {
        title: "Search notes",
        type: "learning",
        body: "b",
        date: "2026-07-01",
        tags: ["qmd", "qmd"],
      },
      // Ties with 2026 at count 1: name asc puts the digit-led tag first.
      { title: "Zettelkasten", type: "pattern", body: "b", date: "2026-07-01", tags: ["zzz"] },
    ];
    for (const payload of payloads) {
      expect((await post(app, payload)).status).toBe(201);
    }

    const res = await app.request("/tags");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tags: [
        { name: "finanzas", count: 3 },
        { name: "qmd", count: 2 },
        { name: "2026", count: 1 },
        { name: "zzz", count: 1 },
      ],
    });
  });

  it("skips non-conforming hand-written files without failing the scan", async () => {
    const app = makeApp(new Vault(vaultDir));
    expect(
      (
        await post(app, {
          title: "Conforming note",
          type: "note",
          body: "b",
          date: "2026-07-01",
          tags: ["salud"],
        })
      ).status,
    ).toBe(201);

    // Conforming except the uppercase tag — rejected by the shared schema,
    // so the tolerant scan must skip it, not 500.
    await mkdir(join(vaultDir, "notes"), { recursive: true });
    await writeFile(
      join(vaultDir, "notes", "hand-written.md"),
      "---\nid: hand-written\ntitle: Hand written\ndate: 2026-07-01\ntype: note\ntags:\n  - Salud\n---\n\nHand-written body.\n",
      "utf8",
    );
    // No frontmatter at all — also skipped.
    await writeFile(join(vaultDir, "plain.md"), "just markdown, no frontmatter\n", "utf8");

    const res = await app.request("/tags");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tags: [{ name: "salud", count: 1 }] });
  });

  it("returns an empty list on an empty vault, not an error", async () => {
    const app = makeApp(new Vault(vaultDir));

    const res = await app.request("/tags");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tags: [] });
  });

  it("rejects a malformed tag on write via the shared schema", async () => {
    const app = makeApp(new Vault(vaultDir));

    const res = await post(app, {
      title: "Bad tag",
      type: "note",
      body: "b",
      date: "2026-07-01",
      tags: ["Salud"],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      issues: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("validation_error");
    expect(body.issues).toContainEqual({
      field: "tags.0",
      message: "tags must be lowercase kebab-case (letters, digits, hyphens)",
    });
  });
});
