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
  vaultDir = await mkdtemp(join(tmpdir(), "ams-api-types-"));
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
// GET /types
// ---------------------------------------------------------------------------

describe("GET /types", () => {
  it("returns the singulars of the <type>s directories after writes", async () => {
    const app = makeApp(new Vault(vaultDir));

    const payloads = [
      { title: "Use QMD for retrieval", type: "decision", body: "b", date: "2026-07-01" },
      { title: "TTL locks avoid deadlock", type: "learning", body: "b", date: "2026-07-01" },
      { title: "Vault layout convention", type: "pattern", body: "b", date: "2026-07-01" },
    ];
    for (const payload of payloads) {
      expect((await post(app, payload)).status).toBe(201);
    }

    const res = await app.request("/types");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ types: ["decision", "learning", "pattern"] });
  });

  it("returns an empty list on an empty vault, not an error", async () => {
    const app = makeApp(new Vault(vaultDir));

    const res = await app.request("/types");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ types: [] });
  });

  it("reports a first-level directory not ending in s as-is", async () => {
    await mkdir(join(vaultDir, "misc"));
    const app = makeApp(new Vault(vaultDir));

    const res = await app.request("/types");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ types: ["misc"] });
  });

  it("does not mangle a directory named exactly s", async () => {
    await mkdir(join(vaultDir, "s"));
    const app = makeApp(new Vault(vaultDir));

    const res = await app.request("/types");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ types: ["s"] });
  });

  it("skips dot-directories and plain files at the vault root", async () => {
    const app = makeApp(new Vault(vaultDir));
    expect(
      (await post(app, { title: "Use QMD", type: "decision", body: "b", date: "2026-07-01" }))
        .status,
    ).toBe(201);

    // The dirty store already materialized .ams; add another dot-dir plus a
    // stray root-level file — none of them is a note type.
    await mkdir(join(vaultDir, ".qmd"));
    await writeFile(join(vaultDir, "README.md"), "not a type", "utf8");

    const res = await app.request("/types");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ types: ["decision"] });
  });
});
