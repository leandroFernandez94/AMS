import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirtyStore } from "../src/dirty.js";
import type { Reindexer, ReindexResult } from "../src/indexing/index.js";
import { IndexScheduler } from "../src/indexing/scheduler.js";
import { createLogger, type LogEntry, type Logger } from "../src/logger.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ams-scheduler-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A reindexer that records calls and can be programmed to succeed or fail. */
class FakeReindexer implements Reindexer {
  calls = 0;
  throwNext = false;
  result: ReindexResult = { pending: 0, updateSummary: "u", embedSummary: "e" };

  async reindex(): Promise<ReindexResult> {
    this.calls++;
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error("boom");
    }
    return this.result;
  }
}

/** Logger that buffers entries so tests can assert on the structured output. */
function bufferLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger = createLogger((line) => entries.push(JSON.parse(line)), "debug");
  return Object.assign(logger, { entries });
}

function makeScheduler(dirty: DirtyStore, reindexer: Reindexer, logger: Logger) {
  return new IndexScheduler({
    dirty,
    reindexer,
    logger,
    cronExpression: "*/2 * * * *",
  });
}

describe("IndexScheduler.tick", () => {
  it("is a no-op (idle) when no flags are pending", async () => {
    const dirty = new DirtyStore(join(dir, ".ams", "dirty.json"));
    const reindexer = new FakeReindexer();
    const scheduler = makeScheduler(dirty, reindexer, bufferLogger());

    const result = await scheduler.tick();

    expect(result).toEqual({ status: "idle", indexed: 0, pending: 0 });
    expect(reindexer.calls).toBe(0);
  });

  it("reindexes pending flags and clears them on success", async () => {
    const dirty = new DirtyStore(join(dir, ".ams", "dirty.json"));
    await dirty.mark("decisions/a.md");
    await dirty.mark("learnings/b.md");
    const reindexer = new FakeReindexer();
    const scheduler = makeScheduler(dirty, reindexer, bufferLogger());

    const result = await scheduler.tick();

    expect(result.status).toBe("ok");
    expect(result.indexed).toBe(2);
    expect(result.pending).toBe(0);
    expect(reindexer.calls).toBe(1);
    // Flags cleared only after success.
    expect(dirty.snapshot()).toEqual([]);
  });

  it("preserves every flag when reindexing fails", async () => {
    const dirty = new DirtyStore(join(dir, ".ams", "dirty.json"));
    await dirty.mark("notes/x.md");
    const reindexer = new FakeReindexer();
    reindexer.throwNext = true;
    const scheduler = makeScheduler(dirty, reindexer, bufferLogger());

    const result = await scheduler.tick();

    expect(result.status).toBe("failed");
    expect(result.indexed).toBe(0);
    expect(result.pending).toBe(1);
    expect(result.error).toBe("boom");
    // Nothing cleared — retried on the next tick.
    expect(dirty.has("notes/x.md")).toBe(true);
  });

  it("retries on the next tick after a failure (flags survive)", async () => {
    const dirty = new DirtyStore(join(dir, ".ams", "dirty.json"));
    await dirty.mark("notes/x.md");
    const reindexer = new FakeReindexer();
    reindexer.throwNext = true;
    const scheduler = makeScheduler(dirty, reindexer, bufferLogger());

    const failed = await scheduler.tick();
    expect(failed.status).toBe("failed");
    expect(dirty.has("notes/x.md")).toBe(true);

    const ok = await scheduler.tick();
    expect(ok.status).toBe("ok");
    expect(ok.indexed).toBe(1);
    expect(dirty.snapshot()).toEqual([]);
  });

  it("reports busy and skips the tick when one is already running", async () => {
    const dirty = new DirtyStore(join(dir, ".ams", "dirty.json"));
    await dirty.mark("notes/slow.md");

    let releaseTick = () => {};
    const gate = new Promise<void>((r) => (releaseTick = r));
    const blocking: Reindexer = {
      async reindex() {
        await gate;
        return { pending: 1 };
      },
    };
    const scheduler = makeScheduler(dirty, blocking, bufferLogger());

    const inFlight = scheduler.tick();
    const concurrent = await scheduler.tick();
    expect(concurrent.status).toBe("busy");
    expect(concurrent.pending).toBe(1);

    releaseTick();
    const first = await inFlight;
    expect(first.status).toBe("ok");
    expect(first.indexed).toBe(1);
  });

  it("logs structured start/done entries on a successful tick", async () => {
    const dirty = new DirtyStore(join(dir, ".ams", "dirty.json"));
    await dirty.mark("a.md");
    const reindexer = new FakeReindexer();
    const logger = bufferLogger();
    const scheduler = makeScheduler(dirty, reindexer, logger);

    await scheduler.tick();

    const msgs = logger.entries.map((e) => e.msg);
    expect(msgs).toContain("indexer:tick:start");
    expect(msgs).toContain("indexer:tick:done");
  });
});

describe("IndexScheduler lifecycle", () => {
  it("start() registers a task only when enabled", () => {
    const off = new IndexScheduler({
      dirty: new DirtyStore(join(dir, ".ams", "dirty.json")),
      reindexer: new FakeReindexer(),
      logger: bufferLogger(),
      cronExpression: "*/2 * * * *",
      enabled: false,
    });
    off.start();
    expect(off.isRunning()).toBe(false);

    const on = new IndexScheduler({
      dirty: new DirtyStore(join(dir, ".ams", "dirty.json")),
      reindexer: new FakeReindexer(),
      logger: bufferLogger(),
      cronExpression: "*/2 * * * *",
      enabled: true,
    });
    on.start();
    expect(on.isRunning()).toBe(true);
    on.stop();
    expect(on.isRunning()).toBe(false);
  });

  it("start() is idempotent and stop() is safe when not running", () => {
    const scheduler = makeScheduler(
      new DirtyStore(join(dir, ".ams", "dirty.json")),
      new FakeReindexer(),
      bufferLogger(),
    );
    expect(() => scheduler.stop()).not.toThrow();
    scheduler.start();
    scheduler.start(); // no double registration
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });
});
