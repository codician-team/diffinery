import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { applyDelta, parsePack, sha1 } from "../src/index.js";

/** A pack from raw entries: [type code, declared size, body (already deflated, with any delta base prefix)]. */
async function pack(entries: Array<[number, number, Uint8Array]>): Promise<Uint8Array> {
  const parts: number[] = [..."PACK"].map((c) => c.charCodeAt(0));
  const u32 = (n: number) => parts.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  u32(2);
  u32(entries.length);
  for (const [type, size, body] of entries) {
    let s = size;
    let c = (type << 4) | (s & 15);
    s = Math.floor(s / 16);
    while (s > 0) {
      parts.push(c | 0x80);
      c = s & 0x7f;
      s = Math.floor(s / 128);
    }
    parts.push(c);
    parts.push(...body);
  }
  const body = new Uint8Array(parts);
  const out = new Uint8Array(body.length + 20);
  out.set(body);
  out.set(await sha1(body), body.length);
  return out;
}
const varint = (n: number) => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};

describe("untrusted packs can't make the server inflate or allocate without bound", () => {
  it("stops inflating an object at its declared size", async () => {
    // Declares 10 bytes, inflates to 64 MiB.
    const bomb = deflateSync(Buffer.alloc(64 * 1024 * 1024));
    await expect(parsePack(await pack([[3, 10, bomb]]))).rejects.toThrow(/larger than its declared size/);
  });

  it("refuses a pack whose objects unpack past the budget", async () => {
    const blob = Buffer.alloc(600 * 1024, 120);
    const p = await pack([
      [3, blob.length, deflateSync(blob)],
      [3, blob.length, deflateSync(Buffer.concat([blob.subarray(1), Buffer.from("y")]))],
    ]);
    await expect(parsePack(p, undefined, { maxBytes: 1024 * 1024 })).rejects.toThrow(/unpacks to more than/);
    expect((await parsePack(p, undefined, { maxBytes: 2 * 1024 * 1024 })).length).toBe(2);
  });

  it("inflates a large blob that tiny deltas use as their base once for all of them, within the memory budget", async () => {
    // One 2 MiB blob, kept compressed, then 20 one-byte deltas against it by offset.
    const blob = Buffer.alloc(2 * 1024 * 1024);
    const header = (type: number, size: number) => {
      const out: number[] = [];
      let c = (type << 4) | (size & 15);
      size = Math.floor(size / 16);
      while (size > 0) {
        out.push(c | 0x80);
        c = size & 0x7f;
        size = Math.floor(size / 128);
      }
      out.push(c);
      return out;
    };
    const ofs = (n: number) => {
      const out = [n & 127];
      while ((n = Math.floor(n / 128))) out.unshift(0x80 | (--n & 127));
      return out;
    };
    const parts: number[] = [..."PACK"].map((c) => c.charCodeAt(0)), u32 = (n: number) => parts.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    u32(2);
    u32(21);
    const base = parts.length;
    parts.push(...header(3, blob.length), ...deflateSync(blob));
    const delta = Uint8Array.from([...varint(blob.length), ...varint(1), 0x91, 0, 1]);
    for (let i = 0; i < 20; i++) parts.push(...header(6, delta.length), ...ofs(parts.length - base), ...deflateSync(delta));
    const body = new Uint8Array(parts);
    const p = new Uint8Array(body.length + 20);
    p.set(body);
    p.set(await sha1(body), body.length);
    // Kept compressed, the blob is inflated once to hash it and once, held, for all 20 deltas: not once for each.
    const opts = { maxBytes: 5 * 1024 * 1024, largeObjectBytes: 1024 * 1024 };
    expect((await parsePack(p, undefined, opts)).length).toBe(21);
    await expect(parsePack(p, undefined, { ...opts, maxHeldBytes: 1024 * 1024 })).rejects.toThrow(/memory/);
  });

  it("checks a delta's result size before allocating it", () => {
    const delta = Uint8Array.from([...varint(3), ...varint(2 ** 40), 0x91, 0, 3]);
    expect(() => applyDelta(Uint8Array.from([1, 2, 3]), delta, 1024 * 1024)).toThrow(/larger than/);
  });
});
