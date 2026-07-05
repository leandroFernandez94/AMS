/**
 * Indexing scheduler (Spec 5) — the asynchronous bridge between writes and
 * searchability.
 *
 * Writes (Spec 3) mark notes dirty; this scheduler periodically drains the
 * dirty-flag store and asks a `Reindexer` to rebuild the QMD index, so the
 * write path never pays the (heavy, model-bound) cost of indexing inline. The
 * schedule is driven by node-cron; `POST /admin/reindex` (Spec 5) reuses the
 * exact same `tick()` for a manual, immediate cycle.
 *
 * Failure contract (the whole point of the dirty flags):
 *   - empty store  -> no-op tick, nothing logged as indexed
 *   - reindex ok   -> clear exactly the drained paths, log success
 *   - reindex fail -> keep every flag, log the error, retry next tick
 *
 * Overlap guard: cron's own `noOverlap` covers the periodic task, and a
 * boolean guard additionally protects manual `tick()` calls from racing the
 * cron tick (two ticks would be harmless — clearing is idempotent and the
 * second would just find an empty store — but a guard keeps logs clean).
 */
import cron, { type ScheduledTask } from "node-cron";
import type { DirtyStore } from "../dirty.js";
import type { Logger } from "../logger.js";
import type { Reindexer } from "./reindexer.js";

/** Outcome of a single tick. Returned by `tick()` and surfaced by `/admin/reindex`. */
export interface TickResult {
  /** "idle" | "ok" | "failed" | "busy". */
  status: "idle" | "ok" | "failed" | "busy";
  /** Number of dirty paths that were reindexed this tick (0 unless status === "ok"). */
  indexed: number;
  /** Number of dirty paths still pending (set on idle/failed/busy). */
  pending: number;
  /** Present on failure. */
  error?: string;
}

/** Collaborators the scheduler needs. All injected for testability. */
export interface SchedulerDeps {
  dirty: DirtyStore;
  reindexer: Reindexer;
  logger: Logger;
}

/** Options for constructing an `IndexScheduler`. */
export interface IndexSchedulerOptions extends SchedulerDeps {
  /** Validated node-cron expression. */
  cronExpression: string;
  /**
   * When false, `start()` is a no-op (the manual `tick()` and admin endpoint
   * still work). Defaults to true. Lets tests / read-only replicas opt out of
   * background work without conditional construction at the call site.
   */
  enabled?: boolean;
}

export class IndexScheduler {
  private readonly deps: SchedulerDeps;
  private readonly cronExpression: string;
  private readonly enabled: boolean;
  private task?: ScheduledTask;
  private running = false;

  constructor(opts: IndexSchedulerOptions) {
    this.deps = { dirty: opts.dirty, reindexer: opts.reindexer, logger: opts.logger };
    this.cronExpression = opts.cronExpression;
    this.enabled = opts.enabled ?? true;
  }

  /** Whether the periodic task is currently registered. */
  isRunning(): boolean {
    return this.task !== undefined;
  }

  /** Registers the periodic cron task. Safe to call once; idempotent. */
  start(): void {
    if (!this.enabled || this.task) return;
    this.task = cron.schedule(
      this.cronExpression,
      () => {
        // Fire-and-forget: node-cron has no async awareness, and `tick()`
        // owns its own error handling so nothing reaches the scheduler loop.
        void this.tick().catch(() => {
          /* already logged inside tick */
        });
      },
      { noOverlap: true },
    );
    this.deps.logger.info("indexer:scheduler:started", { cron: this.cronExpression });
  }

  /** Stops and deregisters the periodic task. Safe to call when not running. */
  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = undefined;
      this.deps.logger.info("indexer:scheduler:stopped", {});
    }
  }

  /**
   * Runs one indexing cycle. Called by the cron task and the admin endpoint.
   * Never throws — failures land in `status: "failed"` with an `error` field
   * so the HTTP handler can return a structured 503 instead of crashing.
   */
  async tick(): Promise<TickResult> {
    if (this.running) {
      return { status: "busy", indexed: 0, pending: this.deps.dirty.snapshot().length };
    }
    this.running = true;
    try {
      return await this.runOnce();
    } finally {
      this.running = false;
    }
  }

  private async runOnce(): Promise<TickResult> {
    const entries = this.deps.dirty.snapshot();
    if (entries.length === 0) {
      return { status: "idle", indexed: 0, pending: 0 };
    }

    const paths = entries.map((e) => e.path);
    this.deps.logger.info("indexer:tick:start", { pending: entries.length });

    try {
      const result = await this.deps.reindexer.reindex(entries);
      // Clear ONLY after a successful reindex — this is the contract that
      // keeps flags alive across daemon downtime.
      await this.deps.dirty.clear(paths);
      this.deps.logger.info("indexer:tick:done", {
        indexed: entries.length,
        updateSummary: result.updateSummary,
        embedSummary: result.embedSummary,
      });
      return { status: "ok", indexed: entries.length, pending: 0 };
    } catch (e) {
      this.deps.logger.error("indexer:tick:failed", {
        pending: entries.length,
        error: String(e),
      });
      return {
        status: "failed",
        indexed: 0,
        pending: entries.length,
        error: (e as Error).message ?? String(e),
      };
    }
  }
}
