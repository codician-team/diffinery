import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import pako from "pako";
import { deflate, inflate, inflateSized } from "../src/index.js";

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
const text = (n: number) => new TextEncoder().encode("tree and commit text ".repeat(Math.ceil(n / 21)).slice(0, n));

describe("zlib", () => {
  it("reads what it writes, small objects natively and large ones with pako", () => {
    for (const n of [0, 1, 100, 70_000, 1024 * 1024, 1024 * 1024 + 1, 3 * 1024 * 1024]) {
      const raw = text(n);
      expect(same(inflateSized(deflate(raw), n), raw), `${n}`).toBe(true);
      expect(same(inflateSized(new Uint8Array(deflateSync(raw, { level: 9 })), n), raw), `${n}`).toBe(true);
      expect(same(inflate(deflate(raw)), raw), `${n}`).toBe(true);
    }
  });

  it("refuses data that inflates to more or less than the recorded size, small or large", () => {
    for (const n of [500, 2 * 1024 * 1024]) {
      const z = deflate(text(n));
      expect(() => inflateSized(z, n - 1)).toThrow(/larger than its recorded size/);
      expect(() => inflateSized(z, n + 1)).toThrow(/not its recorded/);
      expect(() => inflateSized(z.subarray(0, z.length - 4), n)).toThrow(/zlib error|not its recorded/);
      expect(() => inflateSized(pako.gzip(text(n)), n)).toThrow();
    }
  });

  it("stops a small object that would inflate to far more than its recorded size", () => {
    const bomb = deflate(new Uint8Array(50 * 1024 * 1024));
    expect(() => inflateSized(bomb, 1000)).toThrow(/larger than its recorded size/);
  });

  it("hands back a plain Uint8Array", () => {
    expect(inflateSized(deflate(text(10)), 10).constructor).toBe(Uint8Array);
  });
});
