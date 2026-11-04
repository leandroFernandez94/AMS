import { afterEach, describe, expect, it, vi } from "vitest";
import { WriteLock } from "../src/lock.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("WriteLock", () => {
  it("grants exclusive ownership then frees on release", async () => {
    const lock = new WriteLock(1000);
    expect(lock.isLocked("k")).toBe(false);

    const release = await lock.acquire("k");
    expect(lock.isLocked("k")).toBe(true);

    release();
    expect(lock.isLocked("k")).toBe(false);
  });

  it("serializes concurrent acquires for the same key (FIFO)", async () => {
    const lock = new WriteLock(5000);
    const order: string[] = [];

    const r1 = await lock.acquire("k");
    // Queue two more while the key is held; they must not resolve yet.
    const p2 = lock.acquire("k").then((r) => {
      order.push("2");
      return r;
    });
    const p3 = lock.acquire("k").then((r) => {
      order.push("3");
      return r;
    });
    await Promise.resolve();
    expect(order).toEqual([]);

    // Free the holder; the first waiter (p2) wakes, then hands off to p3.
    r1();
    const r2 = await p2;
    expect(order).toEqual(["2"]);
    r2();
    const r3 = await p3;
    expect(order).toEqual(["2", "3"]);
    r3();
    expect(lock.isLocked("k")).toBe(false);
  });

  it("auto-releases after the TTL when release() is never called", async () => {
    const lock = new WriteLock(30);
    await lock.acquire("k"); // intentionally leaked — no release()
    expect(lock.isLocked("k")).toBe(true);

    // A fresh acquire resolves only once the TTL frees the key.
    const release = await lock.acquire("k");
    expect(lock.isLocked("k")).toBe(true);
    release();
    expect(lock.isLocked("k")).toBe(false);
  });

  it("lets different keys be held simultaneously", async () => {
    const lock = new WriteLock(1000);
    const ra = await lock.acquire("a");
    const rb = await lock.acquire("b");
    expect(lock.isLocked("a")).toBe(true);
    expect(lock.isLocked("b")).toBe(true);
    ra();
    rb();
  });

  it("clears the TTL timer on release so a stale key is not held", async () => {
    const lock = new WriteLock(40);
    const release = await lock.acquire("k");
    release();
    // Wait beyond the TTL; the key must remain free (timer was cleared).
    await delay(60);
    expect(lock.isLocked("k")).toBe(false);
  });

  it("rejects a non-positive TTL", () => {
    expect(() => new WriteLock(0)).toThrow(/positive number/);
    expect(() => new WriteLock(Number.NaN)).toThrow(/positive number/);
  });
});

describe("WriteLock stale-release protection (issue #57)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets queued-promise continuations run without advancing virtual time. */
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
  };

  it("a stale release after TTL expiry does not free the next holder", async () => {
    vi.useFakeTimers();
    const ttl = 100;
    const lock = new WriteLock(ttl);

    const releaseA = await lock.acquire("k");
    expect(lock.isLocked("k")).toBe(true);

    // A never calls release(); the TTL escape hatch frees the key.
    await vi.advanceTimersByTimeAsync(ttl);
    expect(lock.isLocked("k")).toBe(false);

    // B legitimately takes over the expired key.
    const releaseB = await lock.acquire("k");
    expect(lock.isLocked("k")).toBe(true);

    // A's late release() must be a no-op: B still owns the key.
    releaseA();
    expect(lock.isLocked("k")).toBe(true);

    // A fresh acquire must queue behind B, not take the fast path over the
    // key A wrongly freed.
    let acquired = false;
    const pendingC = lock.acquire("k").then((release) => {
      acquired = true;
      return release;
    });
    await flush();
    expect(acquired).toBe(false);

    releaseB();
    const releaseC = await pendingC;
    expect(acquired).toBe(true);
    releaseC();
  });

  it("a stale release does not wake the next waiter", async () => {
    vi.useFakeTimers();
    const ttl = 100;
    const lock = new WriteLock(ttl);

    const releaseA = await lock.acquire("k");
    // B queues while A holds the key.
    const pendingB = lock.acquire("k");
    await flush();

    // TTL fires: the handoff wakes B, which takes ownership.
    await vi.advanceTimersByTimeAsync(ttl);
    const releaseB = await pendingB;
    expect(lock.isLocked("k")).toBe(true);

    // C queues behind B.
    let cAcquired = false;
    const pendingC = lock.acquire("k").then((release) => {
      cAcquired = true;
      return release;
    });
    await flush();
    expect(cAcquired).toBe(false);

    // A's stale release must not resolve C early.
    releaseA();
    await flush();
    expect(cAcquired).toBe(false);
    expect(lock.isLocked("k")).toBe(true);

    // B's genuine release is what wakes C.
    releaseB();
    const releaseC = await pendingC;
    expect(cAcquired).toBe(true);
    releaseC();
  });

  it("a repeated release from the same holder does not free the next holder", async () => {
    vi.useFakeTimers();
    const lock = new WriteLock(1000);

    const releaseA = await lock.acquire("k");
    releaseA();
    releaseA(); // immediate double release — the second call must be inert
    expect(lock.isLocked("k")).toBe(false);

    const releaseB = await lock.acquire("k");
    expect(lock.isLocked("k")).toBe(true);

    // A's release function was already consumed; reusing it must not free
    // B's lock.
    releaseA();
    expect(lock.isLocked("k")).toBe(true);

    let acquired = false;
    const pendingC = lock.acquire("k").then((release) => {
      acquired = true;
      return release;
    });
    await flush();
    expect(acquired).toBe(false);

    releaseB();
    await pendingC;
    expect(acquired).toBe(true);
  });

  it("re-arms the TTL per acquisition through a forced handoff", async () => {
    vi.useFakeTimers();
    const ttl = 100;
    const lock = new WriteLock(ttl);

    // A is intentionally leaked: only its TTL frees the key for B.
    await lock.acquire("k");
    const pendingB = lock.acquire("k");
    await flush();

    // TTL expiry hands the key to the queued waiter B.
    await vi.advanceTimersByTimeAsync(ttl);
    // B is leaked too — its own TTL must free the key below.
    await pendingB;
    expect(lock.isLocked("k")).toBe(true);

    // B's acquisition armed a fresh TTL; A's already-fired timer must not
    // free B's key early, and B's own expiry eventually does.
    await vi.advanceTimersByTimeAsync(ttl - 1);
    expect(lock.isLocked("k")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(lock.isLocked("k")).toBe(false);

    // The key is fully free again: a new acquire resolves immediately.
    const releaseC = await lock.acquire("k");
    expect(lock.isLocked("k")).toBe(true);
    releaseC();
  });
});
