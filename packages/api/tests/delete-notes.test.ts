import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AppDeps,
  createApp,
  createLogger,
  DirtyStore,
  Vault,
  WriteLock,
} from "../src/index.js";
import { IndexScheduler, type Reindexer, type ReindexResult } from "../src/indexing/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), "ams-delete-"));
});

afterEach(async () => {
  await rm(vaultDir, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const deps: AppDeps = {
    vault: new Vault(vaultDir),
    lock: new WriteLock(5000),
    dirty: new DirtyStore(join(vaultDir, ".ams", "dirty.json")),
    // Silent logger: keeps test output clean. Level "error" still allows
    // failure paths to surface if we ever assert on logs.
    logger: createLogger(() => undefined, "error"),
  };
  return { ...deps, ...overrides };
}

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/notes", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function del(app: ReturnType<typeof createApp>, url: string) {
  return app.request(url, { method: "DELETE" });
}

/** Lock whose acquisition always fails, to exercise the 503 conflict path. */
class ThrowingLock extends WriteLock {
  override async acquire(): Promise<() => void> {
    throw new Error("lock acquisition failed");
  }
}

/**
 * Vault that simulates the note vanishing between the pre-lock fast-fail read
 * and the under-lock re-read (e.g. a concurrent writer deleted it first).
 */
class VanishingVault extends Vault {
  private reads = 0;

  override async readRaw(relPath: string): Promise<string | null> {
    this.reads++;
    if (this.reads >= 2) return null;
    return super.readRaw(relPath);
  }
}

/** No-op reindexer — the delete tests never rely on a real reindex. */
class FakeReindexer implements Reindexer {
  async reindex(): Promise<ReindexResult> {
    return { pending: 0 };
  }
}

const basePayload = {
  title: "Use QMD for retrieval",
  type: "decision",
  body: "We will use [[qmd]] as the local hybrid retrieval engine.",
  date: "2026-07-01",
};

const canonicalPath = "decisions/use-qmd-for-retrieval.md";

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("DELETE /notes/:path — happy path", () => {
  it("deletes the file, marks the path dirty and returns the parsed note", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    await post(app, basePayload);

    const res = await del(app, `/notes/${canonicalPath}`);
    expect(res.status).toBe(200);

    expect(await res.json()).toEqual({
      deleted: true,
      path: canonicalPath,
      note: {
        frontmatter: {
          id: "use-qmd-for-retrieval",
          title: "Use QMD for retrieval",
          date: "2026-07-01",
          type: "decision",
          tags: [],
        },
        body: "We will use [[qmd]] as the local hybrid retrieval engine.",
      },
    });

    expect(existsSync(join(vaultDir, canonicalPath))).toBe(false);
    expect(deps.dirty.has(canonicalPath)).toBe(true);
  });

  it("deletes an unparseable file anyway and returns note:null with the raw content", async () => {
    await mkdir(join(vaultDir, "handwritten"), { recursive: true });
    const raw = "# Just markdown\n\nNo frontmatter here.\n";
    await writeFile(join(vaultDir, "handwritten/rough.md"), raw, "utf8");

    const deps = makeDeps();
    const res = await del(createApp(deps), "/notes/handwritten/rough.md");
    expect(res.status).toBe(200);

    // Raw content travels back so an accidental delete stays recoverable.
    expect(await res.json()).toEqual({
      deleted: true,
      path: "handwritten/rough.md",
      note: null,
      raw,
    });

    expect(existsSync(join(vaultDir, "handwritten/rough.md"))).toBe(false);
    expect(deps.dirty.has("handwritten/rough.md")).toBe(true);
  });

  it("decodes URL-encoded segments in the path", async () => {
    await mkdir(join(vaultDir, "handwritten"), { recursive: true });
    await writeFile(join(vaultDir, "handwritten/note with spaces.md"), "body", "utf8");

    const res = await del(createApp(makeDeps()), "/notes/handwritten/note%20with%20spaces.md");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.path).toBe("handwritten/note with spaces.md");
    expect(existsSync(join(vaultDir, "handwritten/note with spaces.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Not found
// ---------------------------------------------------------------------------

describe("DELETE /notes/:path — not found", () => {
  it("returns 404 not_found when the note does not exist", async () => {
    const res = await del(createApp(makeDeps()), `/notes/${canonicalPath}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
    expect(body.message).toContain(canonicalPath);
  });

  it("returns 404 when the file vanishes while waiting for the lock", async () => {
    const app = createApp(makeDeps({ vault: new VanishingVault(vaultDir) }));
    await post(app, basePayload);

    const res = await del(app, `/notes/${canonicalPath}`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("DELETE /notes/:path — validation", () => {
  const cases: Array<{ name: string; url: string }> = [
    { name: "leading slash (absolute path)", url: "/notes//decisions/foo.md" },
    { name: "empty segment", url: "/notes/decisions//foo.md" },
    { name: "dot-prefixed segment (system directory)", url: "/notes/.ams/dirty.json.md" },
    { name: "suffix without .md", url: "/notes/decisions/foo.txt" },
    { name: "backslash separator", url: "/notes/decisions%5Cfoo.md" },
  ];

  for (const { name, url } of cases) {
    it(`rejects ${name} with 400 validation_error`, async () => {
      const res = await del(createApp(makeDeps()), url);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
      expect(body.issues.some((i: { field: string }) => i.field === "path")).toBe(true);
    });
  }

  // A literal `..` segment cannot be exercised through `app.request`: the
  // WHATWG URL parser resolves dot-segments (raw and %2e-encoded) before
  // Hono routes, so such requests never reach the handler with `..` intact.
  // The validator's `..` rule remains as defense-in-depth for non-HTTP
  // callers; the classes above cover every reachable rejection branch.
});

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

describe("DELETE /notes/:path — locking", () => {
  it("releases the lock after a successful delete", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    await post(app, basePayload);
    expect((await del(app, `/notes/${canonicalPath}`)).status).toBe(200);

    expect(deps.lock.isLocked(canonicalPath)).toBe(false);
    // Immediate re-acquisition proves the release actually happened (a held
    // lock would queue this promise until the test times out).
    const release = await deps.lock.acquire(canonicalPath);
    release();
  });

  it("returns 503 write_conflict when lock acquisition fails", async () => {
    // Seed with a healthy lock — only the delete runs against the failing one.
    const seed = makeDeps();
    await post(createApp(seed), basePayload);

    const lock: WriteLock = new ThrowingLock(5000);
    const deps = makeDeps({ lock });
    const res = await del(createApp(deps), `/notes/${canonicalPath}`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("write_conflict");

    // Nothing was deleted: the fast-fail read passed, the lock failed first.
    expect(existsSync(join(vaultDir, canonicalPath))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

describe("DELETE /notes/:path — scheduler", () => {
  it("fires one best-effort tick when a scheduler is wired", async () => {
    const base = makeDeps();
    const scheduler = new IndexScheduler({
      dirty: base.dirty,
      reindexer: new FakeReindexer(),
      logger: base.logger,
      cronExpression: "*/2 * * * *",
    });
    // The handler's contract is only "tick() was invoked" — its outcome must
    // not affect the delete, so a canned idle result keeps the test focused.
    const tick = vi.spyOn(scheduler, "tick").mockResolvedValue({
      status: "idle",
      indexed: 0,
      pending: 0,
    });
    const app = createApp({ ...base, scheduler });
    await post(app, basePayload);

    const res = await del(app, `/notes/${canonicalPath}`);
    expect(res.status).toBe(200);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("succeeds without a scheduler wired (no tick dependency)", async () => {
    // makeDeps omits the scheduler by default — this is that exact shape.
    const deps = makeDeps();
    const app = createApp(deps);
    await post(app, basePayload);

    const res = await del(app, `/notes/${canonicalPath}`);
    expect(res.status).toBe(200);
    expect(deps.dirty.has(canonicalPath)).toBe(true);
  });
});
