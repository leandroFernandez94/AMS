import { describe, expect, it } from "vitest";
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
