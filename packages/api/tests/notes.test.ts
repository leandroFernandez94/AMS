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
      id: "use-qmd-for-retrieval",
      path: "decisions/use-qmd-for-retrieval.md",
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

  it("derives the id from the title deterministically", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));
    const res = await post(app, basePayload);
    const { id, path } = await res.json();
    expect(id).toBe("use-qmd-for-retrieval");
    expect(path).toBe(notePath(id, "decision"));
  });

  it("yields the same id for the same title on a different date", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));

    const first = await post(app, basePayload);
    expect(first.status).toBe(201);

    // Same title + different date derives the same canonical path, so without
    // overwrite the second write is a conflict on that same path.
    const second = await post(app, { ...basePayload, date: "2026-09-13", body: "Later take." });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error).toBe("note_exists");
    expect(body.existing.id).toBe("use-qmd-for-retrieval");
    expect(body.existing.path).toBe("decisions/use-qmd-for-retrieval.md");
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
// Title collision (no topic_key)
// ---------------------------------------------------------------------------

describe("POST /notes — title collision", () => {
  it("returns 409 note_exists with the existing note's full raw body and writes nothing", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));

    await post(app, basePayload);
    const abs = join(vaultDir, "decisions/use-qmd-for-retrieval.md");
    const before = await readFile(abs, "utf8");

    const res = await post(app, { ...basePayload, body: "Clobber attempt." });
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBe("note_exists");
    expect(body.existing.id).toBe("use-qmd-for-retrieval");
    expect(body.existing.path).toBe("decisions/use-qmd-for-retrieval.md");
    // FULL raw markdown source of the file on disk — frontmatter included,
    // not a re-serialization.
    expect(body.existing.body).toBe(before);
    expect(body.existing.body).toContain("id: use-qmd-for-retrieval");
    expect(body.existing.body).toContain("[[qmd]]");

    // Nothing was written: the file is byte-identical.
    expect(await readFile(abs, "utf8")).toBe(before);
  });

  it("completes the upsert when overwrite is true", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));

    await post(app, basePayload);
    const res = await post(app, {
      ...basePayload,
      body: "Replacement reasoning.",
      overwrite: true,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      id: "use-qmd-for-retrieval",
      path: "decisions/use-qmd-for-retrieval.md",
      created: false,
    });

    const abs = join(vaultDir, "decisions/use-qmd-for-retrieval.md");
    const parsed = parseNote(await readFile(abs, "utf8"));
    expect(parsed.body).toBe("Replacement reasoning.");
  });

  it("conflicts even for a byte-identical repeated payload (no silent overwrite)", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));

    const first = await post(app, basePayload);
    expect(first.status).toBe(201);
    expect((await first.json()).created).toBe(true);

    const second = await post(app, basePayload);
    expect(second.status).toBe(409);

    // The escape hatch restores the old upsert outcome.
    const third = await post(app, { ...basePayload, overwrite: true });
    expect(third.status).toBe(200);
    const body = await third.json();
    expect(body.created).toBe(false);
    expect(body.id).toBe("use-qmd-for-retrieval");
  });

  it("is byte-stable when the same payload is rewritten via overwrite", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));
    await post(app, basePayload);
    const abs = join(vaultDir, "decisions/use-qmd-for-retrieval.md");
    const before = await readFile(abs, "utf8");
    await post(app, { ...basePayload, overwrite: true });
    const after = await readFile(abs, "utf8");
    expect(after).toBe(before);
  });

  it("conflicts when a topic_key payload creates onto an occupied path", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));

    await post(app, basePayload);
    // Nobody owns this key yet, so the payload is a create — but its title
    // resolves to the occupied canonical path.
    const res = await post(app, { ...basePayload, topic_key: "arch/retrieval" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("note_exists");
    expect(body.existing.id).toBe("use-qmd-for-retrieval");
  });
});

// ---------------------------------------------------------------------------
// topic_key routing
// ---------------------------------------------------------------------------

describe("POST /notes — topic_key routing", () => {
  it("creates normally (201) when no note carries the key", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));

    const res = await post(app, {
      ...basePayload,
      title: "Fresh topic",
      topic_key: "arch/retrieval",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.path).toBe("decisions/fresh-topic.md");
    expect(body).not.toHaveProperty("moved_from");
  });

  it("updates the same note when the title changes — file moved, no orphan", async () => {
    const deps = makeDeps(new Vault(vaultDir));
    const app = createApp(deps);

    const first = await post(app, {
      ...basePayload,
      title: "Use QMD for retrieval",
      topic_key: "arch/retrieval",
    });
    expect(first.status).toBe(201);

    const res = await post(app, {
      ...basePayload,
      title: "Retrieval stays local first",
      body: "Renamed take with a new body.",
      topic_key: "arch/retrieval",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "retrieval-stays-local-first",
      path: "decisions/retrieval-stays-local-first.md",
      created: false,
      moved_from: "decisions/use-qmd-for-retrieval.md",
    });

    // The old file is gone; the new file carries the payload.
    expect(existsSync(join(vaultDir, "decisions/use-qmd-for-retrieval.md"))).toBe(false);
    const abs = join(vaultDir, "decisions/retrieval-stays-local-first.md");
    expect(existsSync(abs)).toBe(true);
    const parsed = parseNote(await readFile(abs, "utf8"));
    expect(parsed.frontmatter.title).toBe("Retrieval stays local first");
    expect(parsed.frontmatter.topic_key).toBe("arch/retrieval");
    expect(parsed.body).toBe("Renamed take with a new body.");

    // Both sides of the move are flagged for reindexing.
    expect(deps.dirty.has("decisions/retrieval-stays-local-first.md")).toBe(true);
    expect(deps.dirty.has("decisions/use-qmd-for-retrieval.md")).toBe(true);
  });

  it("plain-updates in place when the id does not change (no moved_from)", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));

    await post(app, { ...basePayload, topic_key: "arch/retrieval" });
    const res = await post(app, {
      ...basePayload,
      body: "Same title, refined body.",
      topic_key: "arch/retrieval",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "use-qmd-for-retrieval",
      path: "decisions/use-qmd-for-retrieval.md",
      created: false,
    });

    const parsed = parseNote(
      await readFile(join(vaultDir, "decisions/use-qmd-for-retrieval.md"), "utf8"),
    );
    expect(parsed.body).toBe("Same title, refined body.");
  });

  it("moves the note across type directories when the type changes", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));

    await post(app, {
      title: "Locking lesson",
      type: "decision",
      body: "Starts as a decision.",
      date: "2026-07-01",
      topic_key: "concurrency/locks",
    });
    const res = await post(app, {
      title: "Locking lesson learned",
      type: "learning",
      body: "Reclassified as a learning.",
      date: "2026-07-01",
      topic_key: "concurrency/locks",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe("learnings/locking-lesson-learned.md");
    expect(body.moved_from).toBe("decisions/locking-lesson.md");

    expect(existsSync(join(vaultDir, "decisions/locking-lesson.md"))).toBe(false);
    expect(existsSync(join(vaultDir, "learnings/locking-lesson-learned.md"))).toBe(true);
  });

  it("returns 409 when the rename destination is occupied by a different note", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));

    // Occupant: a note with no topic_key at the path the rename targets.
    const occupant = await post(app, {
      ...basePayload,
      title: "Occupied destination",
      body: "Occupant body.",
    });
    expect(occupant.status).toBe(201);

    // The routed note currently lives elsewhere.
    await post(app, {
      ...basePayload,
      title: "Routed note",
      body: "Original routed body.",
      topic_key: "arch/retrieval",
    });

    // Rename the routed note onto the occupant's path.
    const res = await post(app, {
      ...basePayload,
      title: "Occupied destination",
      body: "Incoming body.",
      topic_key: "arch/retrieval",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("note_exists");
    expect(body.existing.id).toBe("occupied-destination");
    expect(body.existing.body).toContain("Occupant body.");

    // Nothing moved: both files keep their content.
    expect(
      parseNote(await readFile(join(vaultDir, "decisions/occupied-destination.md"), "utf8")).body,
    ).toBe("Occupant body.");
    expect(parseNote(await readFile(join(vaultDir, "decisions/routed-note.md"), "utf8")).body).toBe(
      "Original routed body.",
    );
  });

  it("clobbers the destination on rename when overwrite is true", async () => {
    const app = createApp(makeDeps(new Vault(vaultDir)));

    await post(app, { ...basePayload, title: "Occupied destination", body: "Occupant body." });
    await post(app, {
      ...basePayload,
      title: "Routed note",
      body: "Original routed body.",
      topic_key: "arch/retrieval",
    });

    const res = await post(app, {
      ...basePayload,
      title: "Occupied destination",
      body: "Incoming body.",
      topic_key: "arch/retrieval",
      overwrite: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.moved_from).toBe("decisions/routed-note.md");

    // The move completed: destination replaced, source removed.
    const dest = parseNote(
      await readFile(join(vaultDir, "decisions/occupied-destination.md"), "utf8"),
    );
    expect(dest.body).toBe("Incoming body.");
    expect(dest.frontmatter.topic_key).toBe("arch/retrieval");
    expect(existsSync(join(vaultDir, "decisions/routed-note.md"))).toBe(false);
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
    expect(deps.dirty.has("decisions/use-qmd-for-retrieval.md")).toBe(true);

    // And the dirty.json file is materialized on disk.
    const raw = await readFile(join(vaultDir, ".ams", "dirty.json"), "utf8");
    expect(JSON.parse(raw)).toHaveProperty("decisions/use-qmd-for-retrieval.md");
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

    // They never overlapped: one created the file, the loser found it
    // already there and answered the conflict instead of clobbering it.
    expect(vault.maxInflight).toBe(1);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
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
    const { id, path } = await res.json();
    expect(id).toBe("undated-note");

    // The stamped date lands in the frontmatter — it never joins the id.
    const parsed = parseNote(await readFile(join(vaultDir, path), "utf8"));
    expect(parsed.frontmatter.date).toBe(today);
  });
});
