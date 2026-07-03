import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Note, notePath, parseNote } from "@ams/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AppDeps,
  createApp,
  createLogger,
  DirtyStore,
  type UpsertResult,
  Vault,
  WriteLock,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), "ams-api-"));
});

afterEach(async () => {
  await rm(vaultDir, { recursive: true, force: true });
});

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/notes", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function makeDeps(vault: Vault, lockTtl = 5000): AppDeps {
  return {
    vault,
    lock: new WriteLock(lockTtl),
    dirty: new DirtyStore(join(vaultDir, ".ams", "dirty.json")),
    // Silent logger: keeps test output clean. Level "error" still allows
    // failure paths to surface if we ever assert on logs.
    logger: createLogger(() => undefined, "error"),
  };
}

/** Vault that measures how many upserts run concurrently and adds a delay. */
class ProbeVault extends Vault {
  inflight = 0;
  maxInflight = 0;
  private readonly delayMs: number;

  constructor(root: string, delayMs = 25) {
    super(root);
    this.delayMs = delayMs;
  }

  override async upsertNote(note: Note): Promise<UpsertResult> {
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    await new Promise<void>((r) => setTimeout(r, this.delayMs));
    try {
      return await super.upsertNote(note);
    } finally {
      this.inflight--;
    }
  }
}

const basePayload = {
  title: "Use QMD for retrieval",
  type: "decision",
  body: "We will use [[qmd]] as the local hybrid retrieval engine.",
  date: "2026-07-01",
};

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("returns 200 ok", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

// ---------------------------------------------------------------------------
// POST /notes — creation
// ---------------------------------------------------------------------------

describe("POST /notes — creation", () => {
  it("creates a note at <type>s/<id>.md and returns 201", async () => {
    const deps = makeDeps(new Vault(vaultDir));
    const app = createApp(deps);

    const res = await post(app, basePayload);
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body).toEqual({
      id: "2026-07-01-use-qmd-for-retrieval",
      path: "decisions/2026-07-01-use-qmd-for-retrieval.md",
      created: true,
    });

    // File exists on disk at the canonical path and round-trips.
    const abs = join(vaultDir, body.path);
    expect(existsSync(abs)).toBe(true);

    const parsed = parseNote(await readFile(abs, "utf8"));
    expect(parsed.frontmatter.id).toBe(body.id);
    expect(parsed.frontmatter.type).toBe("decision");
    expect(parsed.body).toContain("[[qmd]]");
  });

  it("derives the id from title + date deterministically", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));
    const res = await post(app, basePayload);
    const { id, path } = await res.json();
    expect(id).toBe("2026-07-01-use-qmd-for-retrieval");
    expect(path).toBe(notePath(id, "decision"));
  });

  it("works for any type (generic note contract)", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));
    const res = await post(app, {
      title: "Async locks beat spinlocks",
      type: "learning",
      body: "TTL + FIFO queue avoids both deadlock and starvation.",
      date: "2026-07-01",
      topic_key: "concurrency/locks",
      tags: ["async", "locking"],
    });
    expect(res.status).toBe(201);
    const { path } = await res.json();
    expect(path.startsWith("learnings/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Idempotent upsert
// ---------------------------------------------------------------------------

describe("POST /notes — idempotent upsert", () => {
  it("returns 200 + created:false for the same logical id", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));

    const first = await post(app, basePayload);
    expect(first.status).toBe(201);
    expect((await first.json()).created).toBe(true);

    const second = await post(app, basePayload);
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.created).toBe(false);
    expect(body.id).toBe("2026-07-01-use-qmd-for-retrieval");
  });

  it("overwrites the existing file when the body changes", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));

    await post(app, basePayload);
    const updated = await post(app, { ...basePayload, body: "Updated reasoning." });
    expect(updated.status).toBe(200);

    const abs = join(vaultDir, "decisions/2026-07-01-use-qmd-for-retrieval.md");
    const parsed = parseNote(await readFile(abs, "utf8"));
    expect(parsed.body).toBe("Updated reasoning.");
  });

  it("is byte-stable for an identical repeated payload", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));
    await post(app, basePayload);
    const abs = join(vaultDir, "decisions/2026-07-01-use-qmd-for-retrieval.md");
    const before = await readFile(abs, "utf8");
    await post(app, basePayload);
    const after = await readFile(abs, "utf8");
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Dirty flag
// ---------------------------------------------------------------------------

describe("POST /notes — dirty flag", () => {
  it("marks the note path as dirty on every successful write", async () => {
    const deps = makeDeps(new Vault(vaultDir));
    const app = createApp(deps);

    await post(app, basePayload);
    expect(deps.dirty.has("decisions/2026-07-01-use-qmd-for-retrieval.md")).toBe(true);

    // And the dirty.json file is materialized on disk.
    const raw = await readFile(join(vaultDir, ".ams", "dirty.json"), "utf8");
    expect(JSON.parse(raw)).toHaveProperty("decisions/2026-07-01-use-qmd-for-retrieval.md");
  });
});

// ---------------------------------------------------------------------------
// Concurrency (TTL lock serialization)
// ---------------------------------------------------------------------------

describe("POST /notes — concurrency", () => {
  it("serializes concurrent writes to the same id", async () => {
    const vault = new ProbeVault(vaultDir);
    const app = createApp(makeDeps(vault));

    const [a, b] = await Promise.all([post(app, basePayload), post(app, basePayload)]);

    // Exactly one created, one updated — they never overlapped.
    expect(vault.maxInflight).toBe(1);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 201]);
  });

  it("lets independent ids proceed concurrently", async () => {
    const vault = new ProbeVault(vaultDir);
    const app = createApp(makeDeps(vault));

    await Promise.all([
      post(app, { ...basePayload, title: "Alpha decision" }),
      post(app, { ...basePayload, title: "Beta decision" }),
    ]);

    // Different canonical paths -> different lock keys -> overlap allowed.
    expect(vault.maxInflight).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("POST /notes — validation", () => {
  it("rejects invalid JSON with 400 invalid_body", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));
    const res = await app.request("/notes", {
      method: "POST",
      body: "not json{",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });

  it("rejects a missing title with 400 validation_error", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));
    const res = await post(app, { type: "decision", body: "x", date: "2026-07-01" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_error");
    expect(body.issues.some((i: { field: string }) => i.field === "title")).toBe(true);
  });

  it("rejects a malformed date with 400", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));
    const res = await post(app, { ...basePayload, date: "01/07/2026" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("validation_error");
  });

  it("rejects an invalid type format with 400", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));
    const res = await post(app, { ...basePayload, type: "Bad Type" });
    expect(res.status).toBe(400);
  });

  it("rejects a title that produces an empty slug", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));
    const res = await post(app, { ...basePayload, title: "🚀✨" });
    expect(res.status).toBe(400);
  });

  it("defaults the date to today (UTC) when omitted", async () => {
    const deps = makeDeps(new Vault(vaultDir));
    const app = createApp(deps);
    const today = new Date().toISOString().slice(0, 10);

    const res = await post(app, { title: "Undated note", type: "note", body: "b" });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(id.startsWith(`${today}-`)).toBe(true);
  });
});
