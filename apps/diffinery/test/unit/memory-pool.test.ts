import { describe, expect, it } from "vitest";
import { MemoryPool } from "../../src/lib/memory-pool.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("MemoryPool", () => {
  it("gives shares that fit at once, and makes the rest wait, oldest first", async () => {
    const pool = new MemoryPool(100);
    const a = await pool.take(60);
    const b = await pool.take(30);
    expect(pool.fits(10)).toBe(true);
    const order: string[] = [];
    const c = pool.take(50).then((l) => (order.push("c"), l));
    // A small one that would fit still waits behind the large one, so the large one isn't starved.
    expect(pool.fits(10)).toBe(false);
    const d = pool.take(10).then((l) => (order.push("d"), l));
    await tick();
    expect(order).toEqual([]);
    a.release();
    a.release(); // a second release gives nothing back twice
    await tick();
    expect(order).toEqual(["c", "d"]);
    (await c).release();
    (await d).release();
    b.release();
    expect(pool.fits(100)).toBe(true);
  });

  it("a share larger than the pool gets all of it, alone", async () => {
    const pool = new MemoryPool(100);
    const small = await pool.take(1);
    let got = false;
    const big = pool.take(500).then((l) => ((got = true), l));
    await tick();
    expect(got).toBe(false);
    small.release();
    const lease = await big;
    expect(lease.bytes).toBe(100);
    expect(pool.fits(1)).toBe(false);
    lease.release();
    expect(pool.fits(100)).toBe(true);
  });

  it("grows a share by giving it back and waiting its turn for the larger one", async () => {
    const pool = new MemoryPool(100);
    const a = await pool.take(10);
    const b = await pool.take(50);
    let grown = false;
    const growing = a.grow(80).then(() => (grown = true));
    await tick();
    expect(grown).toBe(false);
    b.release();
    await growing;
    expect(a.bytes).toBe(80);
    await a.grow(20); // already large enough
    expect(a.bytes).toBe(80);
    a.release();
    expect(pool.fits(100)).toBe(true);
  });
});
