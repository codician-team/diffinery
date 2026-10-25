import { deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { hashObject, parsePack, sha1 } from "../src/index.js";

// Packs from clients must not run a repository's Durable Object out of memory (128 MB) or tie it up
// for minutes, however small the pack is.

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
const hex = (oid: string) => Buffer.from(oid, "hex");

/** A pack from entries already encoded (header, any base, zlib data). */
async function pack(entries: Uint8Array[]): Promise<Uint8Array> {
  const head = Buffer.alloc(12);
  head.write("PACK");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([head, ...entries]);
  return new Uint8Array(Buffer.concat([body, await sha1(body)]));
}
const blob = (content: Uint8Array, z = deflateSync) => Buffer.concat([Buffer.from(header(3, content.length)), z(content)]);
const refDelta = (base: string, delta: Uint8Array) => Buffer.concat([Buffer.from(header(7, delta.length)), hex(base), deflateSync(delta)]);
/** A delta that replaces a base of `from` bytes with `to`. */
const replace = (from: number, to: Uint8Array) => Uint8Array.from([...varint(from), ...varint(to.length), to.length, ...to]);

describe("pack limits", () => {
  it("resolves a long delta chain in one pass, whatever order the pack lists it in", async () => {
    // 20,000 REF_DELTAs, each against the one before it, listed newest first: resolving them by
    // repeated passes over the unresolved ones took minutes.
    const n = 20_000;
    const content = (i: number) => Buffer.from(String(i).padStart(8, "0"));
    const oids = [await hashObject("blob", content(0))];
    for (let i = 1; i <= n; i++) oids.push(await hashObject("blob", content(i)));
    const deltas: Uint8Array[] = [];
    for (let i = 1; i <= n; i++) deltas.push(refDelta(oids[i - 1]!, replace(8, content(i))));
    const timed = async (entries: Uint8Array[]) => {
      const p = await pack(entries);
      const started = performance.now();
      const objects = await parsePack(p);
      return { ms: performance.now() - started, objects };
    };
    // Listed base first, every delta is resolvable when it is read: the time one pass takes on this machine.
    const onePass = await timed([blob(content(0)), ...deltas]);
    const newestFirst = await timed([...deltas.reverse(), blob(content(0))]);
    // Compared on the same machine, so a slower CI host doesn't change the verdict. Pass by pass, this took minutes.
    expect(newestFirst.ms).toBeLessThan(4 * onePass.ms + 500);
    expect(newestFirst.objects).toHaveLength(n + 1);
    expect(new Set(newestFirst.objects.map((o) => o.oid))).toEqual(new Set(oids));
  }, 120_000);

  it("counts what each object costs in memory, not only its content", async () => {
    // 20,000 one-byte blobs are a 240 KB pack but cost far more than 240 KB to hold.
    const entries: Uint8Array[] = [];
    for (let i = 0; i < 20_000; i++) entries.push(blob(Buffer.from([i & 255, i >> 8])));
    const p = await pack(entries);
    await expect(parsePack(p, undefined, { maxHeldBytes: 1024 * 1024 })).rejects.toThrow(/memory/);
    expect(await parsePack(p, undefined, { maxHeldBytes: 64 * 1024 * 1024 })).toHaveLength(20_000);
  });

  it("refuses a small pack whose objects inflate past the memory budget", async () => {
    // 25 blobs just under the 4 MiB that is kept compressed: under 200 KB of pack, about 100 MB held.
    const size = 4 * 1024 * 1024 - 1024;
    const entries: Uint8Array[] = [];
    for (let i = 0; i < 25; i++) {
      const b = Buffer.alloc(size);
      b[0] = i;
      entries.push(blob(b));
    }
    const p = await pack(entries);
    expect(p.length).toBeLessThan(250 * 1024);
    await expect(parsePack(p, undefined, { largeObjectBytes: 4 * 1024 * 1024 })).rejects.toThrow(/memory/);
  });

  it("refuses a delta whose declared result can't be held, before allocating it", async () => {
    const base = Buffer.from("base");
    const delta = Uint8Array.from([...varint(base.length), ...varint(300 * 1024 * 1024), 4, ...base]);
    const p = await pack([blob(base), refDelta(await hashObject("blob", base), delta)]);
    await expect(parsePack(p)).rejects.toThrow(/pack needs more than 80 MiB of memory/);
  });

  it("counts a thin pack's bases from the repository, once each", async () => {
    const base = Buffer.alloc(2 * 1024 * 1024, 7);
    const oid = await hashObject("blob", base);
    let reads = 0;
    const external = async (o: string) => (o === oid ? (reads++, { type: "blob" as const, content: base }) : null);
    const deltas: Uint8Array[] = [];
    for (let i = 0; i < 3; i++) deltas.push(refDelta(oid, replace(base.length, Buffer.from(`v${i}`))));
    const p = await pack(deltas);
    await expect(parsePack(p, external, { maxBytes: 1024 * 1024 })).rejects.toThrow(/unpacks to more than/);
    reads = 0;
    expect(await parsePack(p, external, { maxBytes: 4 * 1024 * 1024 })).toHaveLength(3);
    expect(reads).toBe(1);
  });

  it("refuses gzip data where git has zlib", async () => {
    const content = Buffer.from("hello\n");
    await expect(parsePack(await pack([blob(content, gzipSync)]))).rejects.toThrow(/zlib|header/);
    const large = Buffer.alloc(64 * 1024, 1);
    await expect(parsePack(await pack([blob(large, gzipSync)]), undefined, { largeObjectBytes: 1024 })).rejects.toThrow(/zlib|header/);
  });
});
