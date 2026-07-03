/**
 * Path-scoped write lock with a time-to-live safety net.
 *
 * Why this exists (Spec 3 architecture constraint): agents can fire parallel
 * writes to the same logical note. Without serialization those writes would
 * interleave and corrupt the canonical file. A plain mutex is not enough — a
 * crashed or hung holder would deadlock the path forever. The TTL guarantees
 * forward progress: if the holder never calls `release()`, the lock
 * auto-expires and the next waiter proceeds.
 *
 * Design:
 *  - Single-instance, in-memory `Map`. Distributed locking is explicitly out
 *    of scope until there is more than one API replica.
 *  - FIFO fairness: waiters are queued in arrival order so no request can
 *    starve under sustained load.
 *  - Each acquisition arms a fresh TTL timer. Releasing clears it. The TTL
 *    is a last-resort escape hatch, not the normal release path.
 */

/** Function returned by `acquire()`; calling it releases the held lock. */
export type ReleaseFunction = () => void;

interface Waiter {
  resolve: () => void;
}

export class WriteLock {
  private readonly locked = new Set<string>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`WriteLock ttlMs must be a positive number, got: ${ttlMs}`);
    }
    this.ttlMs = ttlMs;
  }

  /**
   * Acquires the lock for `key`, resolving once exclusive ownership is held.
   * Resolves with a `release()` function that MUST be called (but the TTL
   * protects against a forgotten call).
   */
  async acquire(key: string): Promise<ReleaseFunction> {
    if (!this.locked.has(key)) {
      this.takeOwnership(key);
      return () => this.release(key);
    }
    // Already held — queue behind current waiters for FIFO fairness.
    await new Promise<void>((resolve) => {
      const queue = this.waiters.get(key) ?? [];
      queue.push({ resolve });
      this.waiters.set(key, queue);
    });
    // When the promise above resolves the key is OURS to take.
    this.takeOwnership(key);
    return () => this.release(key);
  }

  /** Whether `key` is currently held. Mainly for tests and diagnostics. */
  isLocked(key: string): boolean {
    return this.locked.has(key);
  }

  private takeOwnership(key: string): void {
    this.locked.add(key);
    const timer = setTimeout(() => this.forceRelease(key, "ttl"), this.ttlMs);
    // Don't keep the event loop alive solely for the lock timer.
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private release(key: string): void {
    if (!this.locked.delete(key)) return;
    this.clearTimer(key);
    this.wakeNext(key);
  }

  /** TTL expiry or forced release: ownership drops without clearing a timer. */
  private forceRelease(key: string, reason: string): void {
    if (!this.locked.delete(key)) return;
    this.timers.delete(key);
    void reason;
    this.wakeNext(key);
  }

  private wakeNext(key: string): void {
    const queue = this.waiters.get(key);
    if (!queue || queue.length === 0) return;
    const next = queue.shift();
    if (next) next.resolve();
    if (queue.length === 0) this.waiters.delete(key);
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
}
