import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createLogger, DirtyStore, Vault } from "../src/index.js";
import type { Reindexer, ReindexResult, TickResult } from "../src/indexing/index.js";
import { IndexScheduler } from "../src/indexing/scheduler.js";

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), "ams-admin-"));
});
afterEach(async () => {
  await rm(vaultDir, { recursive: true, force: true });
});

/** Fake reindexer behind the scheduler; configurable per-test. */
class FakeReindexer implements Reindexer {
  constructor(private readonly outcome: "ok" | "fail") {}
  async reindex(): Promise<ReindexResult> {
    if (this.outcome === "fail") throw new Error("daemon down");
    return { pending: 1 };
  }
}

function makeApp(outcome: "ok" | "fail" | "none") {
  const dirty = new DirtyStore(join(vaultDir, ".ams", "dirty.json"));
  const logger = createLogger(() => undefined, "error");
  const scheduler =
    outcome === "none"
      ? undefined
      : new IndexScheduler({
          dirty,
          reindexer: new FakeReindexer(outcome),
          logger,
          cronExpression: "*/2 * * * *",
        });
  const app = createApp({ vault: new Vault(vaultDir), dirty, logger, scheduler });
  return { app, dirty };
}

const trigger = (app: ReturnType<typeof createApp>) =>
  app.request("/admin/reindex", { method: "POST" });

describe("POST /admin/reindex", () => {
  it("returns 503 scheduler_unavailable when no scheduler is wired", async () => {
    const { app } = makeApp("none");
    const res = await trigger(app);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("scheduler_unavailable");
  });

  it("forces an immediate successful cycle and reports ok", async () => {
    const { app, dirty } = makeApp("ok");
    await dirty.mark("decisions/a.md");

    const res = await trigger(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TickResult;
    expect(body.status).toBe("ok");
    expect(body.indexed).toBe(1);
    // The manual trigger cleared the flags, same as a cron tick would.
    expect(dirty.snapshot()).toEqual([]);
  });

  it("returns 503 with the failure details when reindexing fails", async () => {
    const { app, dirty } = makeApp("fail");
    await dirty.mark("decisions/a.md");

    const res = await trigger(app);
    expect(res.status).toBe(503);
    const body = (await res.json()) as TickResult;
    expect(body.status).toBe("failed");
    expect(body.pending).toBe(1);
    expect(body.error).toBe("daemon down");
    // Flags preserved for the next tick.
    expect(dirty.has("decisions/a.md")).toBe(true);
  });

  it("reports idle when there is nothing to index", async () => {
    const { app } = makeApp("ok");
    const res = await trigger(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TickResult;
    expect(body.status).toBe("idle");
    expect(body.indexed).toBe(0);
  });
});
