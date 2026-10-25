import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync, gzipSync, inflateSync } from "node:zlib";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ENTRY_OVERHEAD, HASH_COPY_MAX, REF_DELTA_OVERHEAD, SCRATCH_BYTES, StreamedPack, TooMuchMemory, deflate, deflateChunks, hashObject, parsePack, writePack, type ChunkFeed, type GitObject, type PackSource, type StreamedObject } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "pack-stream-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (args: string[], input?: string) => execFileSync("git", args, { cwd: dir, input, maxBuffer: 1 << 28, env: { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@x" } });

// A history whose files change a little each commit, so the pack has delta chains, plus a large blob.
git(["init", "-q", "-b", "main"]);
let text = Array.from({ length: 400 }, (_, i) => `line ${i} of a file that keeps changing\n`).join("");
// Random bytes, so the pack itself is several blocks long.
const large = new Uint8Array(randomBytes(5 * 1024 * 1024));
for (let c = 0; c < 12; c++) {
  text = text.replace(`line ${c * 3}`, `changed ${c}`) + `appended ${c}\n`;
  writeFileSync(join(dir, "a.txt"), text);
  writeFileSync(join(dir, "b.txt"), text.split("").reverse().join(""));
  if (c === 5) writeFileSync(join(dir, "big.bin"), large);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", `c${c}`]);
}
const pack = (args: string[], revs: string) => new Uint8Array(git(["pack-objects", "--stdout", "-q", ...args], revs));
const full = pack(["--revs"], "main\n");
const thin = pack(["--revs", "--thin"], "main\n^main~4\n");

/** Reads count how many bytes were fetched, to show the pack is read in ranges. */
function source(data: Uint8Array, reads: { bytes: number; calls: number } = { bytes: 0, calls: 0 }): PackSource {
  return {
    size: data.length,
    read: async (offset, length) => {
      reads.calls++;
      reads.bytes += length;
      return data.slice(offset, offset + length);
    },
  };
}

/** A pack of deltas, each against the base with this oid (from outside the pack): `deltas[i]` is its instructions. */
function refDeltaPack(baseOid: string, deltas: Uint8Array[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from("PACK"), Buffer.from([0, 0, 0, 2]), Buffer.alloc(4)];
  parts[2]!.writeUInt32BE(deltas.length);
  for (const d of deltas) {
    const head: number[] = [];
    let size = d.length;
    let c = (7 << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size > 0) {
      head.push(c | 0x80);
      c = size & 0x7f;
      size = Math.floor(size / 128);
    }
    head.push(c);
    parts.push(Buffer.from(head), Buffer.from(baseOid, "hex"), deflateSync(d));
  }
  const body = Buffer.concat(parts);
  return new Uint8Array(Buffer.concat([body, createHash("sha1").update(body).digest()]));
}

/** REF_DELTAs, each against the oid given, then one blob (or the blob first). */
function refDeltaChain(deltas: { base: string; delta: Uint8Array }[], blob: Uint8Array, blobFirst = false): Uint8Array {
  const parts: Buffer[] = [Buffer.from("PACK"), Buffer.from([0, 0, 0, 2]), Buffer.alloc(4)];
  parts[2]!.writeUInt32BE(deltas.length + 1);
  const header = (code: number, size: number) => {
    const head: number[] = [];
    let c = (code << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size > 0) {
      head.push(c | 0x80);
      c = size & 0x7f;
      size = Math.floor(size / 128);
    }
    head.push(c);
    return Buffer.from(head);
  };
  const blobPart = [header(3, blob.length), deflateSync(blob)];
  if (blobFirst) parts.push(...blobPart);
  for (const d of deltas) parts.push(header(7, d.delta.length), Buffer.from(d.base, "hex"), deflateSync(d.delta));
  if (!blobFirst) parts.push(...blobPart);
  const body = Buffer.concat(parts);
  return new Uint8Array(Buffer.concat([body, createHash("sha1").update(body).digest()]));
}

const varint = (n: number) => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};

/** A delta that copies one byte of the base at `at`, then inserts `tag`. */
function tinyDelta(baseSize: number, at: number, tag: number): Uint8Array {
  return new Uint8Array([...varint(baseSize), ...varint(2), 0x80 | 0x0f | 0x10, at & 0xff, (at >> 8) & 0xff, (at >> 16) & 0xff, (at >> 24) & 0xff, 1, 1, tag]);
}

async function unpack(data: Uint8Array, opts: Parameters<typeof StreamedPack.open>[1] = {}) {
  const seen = new Map<string, { type: string; content: Uint8Array }>();
  const visit = async (o: StreamedObject, content: Uint8Array | null, feed: ChunkFeed | null) => {
    let bytes = content;
    if (!bytes) {
      const parts: Uint8Array[] = [];
      await feed!((c) => parts.push(c.slice()));
      bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) bytes.set(p, (at += p.length) - p.length);
    }
    expect(bytes.length).toBe(o.size);
    seen.set(o.oid, { type: o.type, content: bytes });
  };
  const p = await StreamedPack.open(source(data), { largeObjectBytes: 4 * 1024 * 1024, blockBytes: 64 * 1024, maxBlocks: 4, cacheBytes: 256 * 1024, ...opts }, visit);
  return { p, seen };
}

describe("StreamedPack", () => {
  it("finds the same objects, with the same contents, as parsePack", async () => {
    const want = await parsePack(full);
    const { p, seen } = await unpack(full);
    expect(p.count).toBe(want.length);
    expect(seen.size).toBe(new Set(want.map((o) => o.oid)).size);
    for (const o of want) {
      expect(seen.get(o.oid)?.type).toBe(o.type);
      expect(Buffer.from(seen.get(o.oid)!.content).equals(Buffer.from(o.content))).toBe(true);
    }
    // Every object comes back again for storing: a delta's content rebuilt, any other as its zlib data's place in the pack.
    const listed = [...p.objects()];
    expect(listed.map((o) => o.oid).sort()).toEqual(want.map((o) => o.oid).sort());
    const big = listed.find((o) => o.size === large.length)!;
    expect(big.deflated).toBeDefined();
    const deltas = listed.filter((x) => !x.deflated);
    expect(deltas.length).toBeGreaterThan(0);
    for (const o of [...deltas.slice(0, 25), ...listed.filter((x) => x.deflated && x !== big).slice(0, 25)]) {
      expect(Buffer.from(await p.content(o.entry)).equals(Buffer.from(seen.get(o.oid)!.content))).toBe(true);
    }
    for (const o of listed.filter((x) => x.deflated && x !== big).slice(0, 25)) {
      const parts: Uint8Array[] = [];
      for await (const s of p.slices(o.deflated!.at, o.deflated!.length)) parts.push(s.slice());
      expect(Buffer.from(inflateSync(Buffer.concat(parts))).equals(Buffer.from(seen.get(o.oid)!.content))).toBe(true);
    }
    let zlib = 0;
    for await (const s of p.slices(big.deflated!.at, big.deflated!.length)) zlib += s.length;
    expect(zlib).toBe(big.deflated!.length);
  });

  it("resolves a thin pack's bases from outside the pack", async () => {
    const stored = new Map<string, GitObject>();
    for (const o of await parsePack(full)) stored.set(o.oid, { type: o.type, content: o.content });
    const external = async (oid: string) => stored.get(oid) ?? null;
    const want = await parsePack(thin, external);
    const { seen } = await unpack(thin, { external });
    expect(seen.size).toBe(want.length);
    for (const o of want) expect(Buffer.from(seen.get(o.oid)!.content).equals(Buffer.from(o.content))).toBe(true);
    await expect(unpack(thin)).rejects.toThrow(/unresolvable delta base/);
  });

  it("reads the pack in ranges and keeps the #125 budget", async () => {
    const reads = { bytes: 0, calls: 0 };
    await StreamedPack.open(source(full, reads), { blockBytes: 64 * 1024, maxBlocks: 2 }, () => {});
    expect(reads.calls).toBeGreaterThan(1);
    // The same limit parsePack applies, counted the same way (deltas are resolved in another order,
    // so the one that goes over can differ).
    const over = /delta result of \d+ bytes is larger than the [\d.]+ bytes allowed|pack unpacks to more than/;
    await expect(parsePack(full, undefined, { maxBytes: 5.2 * 1024 * 1024, largeObjectBytes: 4 * 1024 * 1024 })).rejects.toThrow(over);
    await expect(unpack(full, { maxBytes: 5.2 * 1024 * 1024 })).rejects.toThrow(over);
    await expect(unpack(full, { maxWork: 1024 * 1024 })).rejects.toThrow(/split it into smaller pushes/);
    await expect(unpack(full, { maxObjects: 3 })).rejects.toThrow(/split it into smaller pushes/);
  });

  it("refuses a corrupt pack", async () => {
    const bad = full.slice();
    bad[bad.length - 1]! ^= 1;
    await expect(unpack(bad)).rejects.toThrow(/checksum mismatch/);
    const longer = new Uint8Array(full.length + 5);
    longer.set(full.subarray(0, full.length - 20));
    longer.set(full.subarray(full.length - 20), full.length + 5 - 20);
    await expect(unpack(longer)).rejects.toThrow(/trailing garbage|zlib|bad object|size mismatch|truncated/);
    await expect(unpack(new TextEncoder().encode("NOPE".padEnd(40, "x")))).rejects.toThrow(/not a packfile/);
  });

  it("refuses an object compressed with gzip instead of zlib", async () => {
    // git can't read gzip, and the object would be stored as sent. pako takes gzip unless told not
    // to, and only stumbles on what follows the stream; so these end exactly where a read does.
    const content = new TextEncoder().encode("hello\n".repeat(100));
    const gzipped = new Uint8Array(gzipSync(content));
    const gz = await writePack([{ type: "blob", size: content.length, deflated: gzipped }]);
    const blockBytes = 14 + gzipped.length;
    await expect(unpack(gz, { blockBytes })).rejects.toThrow(/zlib error/);
    await expect(unpack(gz, { blockBytes, largeObjectBytes: 16 })).rejects.toThrow(/zlib error/);
    // In memory, a large blob is inflated a MiB at a time.
    let n = 1024 * 1024 - 200;
    while (gzipSync(new Uint8Array(n), { level: 0 }).length < 1024 * 1024) n++;
    const big = new Uint8Array(randomBytes(n));
    const bigGz = new Uint8Array(gzipSync(big, { level: 0 }));
    expect(bigGz.length).toBe(1024 * 1024);
    const bigPack = await writePack([{ type: "blob", size: big.length, deflated: bigGz }]);
    await expect(parsePack(bigPack, undefined, { largeObjectBytes: 16 })).rejects.toThrow(/zlib error/);
    await expect(parsePack(gz)).rejects.toThrow(/zlib error/);
    // The same objects in zlib come in.
    const zl = await writePack([{ type: "blob", size: content.length, deflated: new Uint8Array(deflateSync(content)) }]);
    expect((await unpack(zl)).seen.size).toBe(1);
    expect((await unpack(zl, { largeObjectBytes: 16 })).seen.size).toBe(1);
    expect(await parsePack(await writePack([{ type: "blob", size: big.length, deflated: new Uint8Array(deflateSync(big)) }]), undefined, { largeObjectBytes: 16 })).toHaveLength(1);
  });

  it("reads a base from outside the pack once for all its deltas, and counts it", async () => {
    const base = new Uint8Array(randomBytes(1024 * 1024));
    const oid = await hashObject("blob", base);
    let reads = 0;
    const external = async (o: string) => (o === oid ? (reads++, { type: "blob" as const, content: base }) : null);
    const many = refDeltaPack(oid, Array.from({ length: 200 }, (_, i) => tinyDelta(base.length, i * 4099, i)));
    // However small the cache, tiny deltas can't make the server read it again and again.
    for (const cacheBytes of [8 * 1024 * 1024, 64 * 1024]) {
      reads = 0;
      const { p, seen } = await unpack(many, { external, cacheBytes });
      expect(seen.size).toBe(200);
      expect(reads).toBe(1);
      expect(p.workDone).toBeLessThan(base.length + 64 * 1024);
    }
    // It counts toward what the pack unpacks to, as in parsePack.
    await expect(unpack(many, { external, maxBytes: base.length })).rejects.toThrow(/unpacks to more than/);
    await expect(parsePack(many, external, { maxBytes: base.length })).rejects.toThrow(/unpacks to more than/);
  });

  it("resolves a long delta chain in one pass", { timeout: 120_000 }, async () => {
    // Each delta's base is listed after it: resolving round by round took a round, and a pass over
    // every delta left, per link.
    const n = 20_000;
    const blob = new TextEncoder().encode("x".repeat(64));
    const contents = [blob];
    for (let i = 1; i <= n; i++) contents.push(new Uint8Array([...blob, i & 0xff, i >> 8]));
    const oids = await Promise.all(contents.map((c) => hashObject("blob", c)));
    // Copy the 64 bytes the chain shares, then insert the two that number it.
    const deltas = contents.slice(1).map((c, i) => ({ base: oids[i]!, delta: new Uint8Array([...varint(contents[i]!.length), ...varint(c.length), 0x90, 64, 2, c[64]!, c[65]!]) }));
    const timed = async (pack: Uint8Array) => {
      const seen = new Map<string, Uint8Array>();
      const t = performance.now();
      await StreamedPack.open(source(pack), {}, (o, content) => void seen.set(o.oid, content!));
      return { ms: performance.now() - t, seen };
    };
    // Listed base first, every delta is resolvable when it is read: the time one pass takes on this machine.
    const onePass = await timed(refDeltaChain(deltas, blob, true));
    const { ms, seen } = await timed(refDeltaChain(deltas.reverse(), blob));
    // Compared on the same machine, so a slower CI host doesn't change the verdict. Round by round, this took most of a minute.
    expect(ms).toBeLessThan(4 * onePass.ms + 500);
    expect(seen.size).toBe(n + 1);
    expect(Buffer.from(seen.get(oids[n]!)!).equals(Buffer.from(contents[n]!))).toBe(true);
  });

  it("refuses a pack whose index alone wouldn't fit in memory", async () => {
    // The caches unpack() uses (4 blocks of 64 KiB and 256 KiB), then ENTRY_OVERHEAD for each object.
    const caches = 4 * 64 * 1024 + 256 * 1024;
    const count = new DataView(full.buffer, full.byteOffset).getUint32(8);
    await expect(unpack(full, { maxHeldBytes: caches + (count - 1) * ENTRY_OVERHEAD })).rejects.toThrow(/pack needs more than 0 MiB of memory to unpack; split it into smaller pushes/);
    // A REF_DELTA costs more (git pack-objects writes them unless asked for OFS_DELTAs): charged as it is read.
    await expect(unpack(full, { maxHeldBytes: caches + count * ENTRY_OVERHEAD })).rejects.toThrow(/split it into smaller pushes/);
    // Then the objects themselves while they are in use, and the zlib data kept to inflate again.
    expect((await unpack(full, { maxHeldBytes: caches + count * (ENTRY_OVERHEAD + REF_DELTA_OVERHEAD) + 16 * 1024 * 1024 })).seen.size).toBeGreaterThan(0);
  });

  it("charges every object it holds, so one huge object is refused rather than run the isolate out of memory", async () => {
    const base = new Uint8Array(randomBytes(64 * 1024));
    const oid = await hashObject("blob", base);
    // One delta that copies the 64 KiB base 6,000 times over: a 375 MiB blob from a 50 KB pack.
    const ops: number[] = [];
    for (let k = 0; k < 6000; k++) ops.push(0x80 | 0x20, 0x00); // copy 0x0000 -> 64 KiB (size 0 means 0x10000)
    const result = 6000 * 64 * 1024;
    const bomb = refDeltaChain([{ base: oid, delta: new Uint8Array([...varint(base.length), ...varint(result), ...ops]) }], base);
    // A tree of zeros: 120 MiB from about 120 KB.
    const zeros = await writePack([{ type: "tree", size: 120 * 1024 * 1024, deflated: new Uint8Array(deflateSync(new Uint8Array(120 * 1024 * 1024))) }]);
    for (const pack of [bomb, zeros]) {
      const before = process.memoryUsage().arrayBuffers;
      let peak = before;
      const t = setInterval(() => (peak = Math.max(peak, process.memoryUsage().arrayBuffers)), 1);
      await expect(StreamedPack.open(source(pack), {}, () => {})).rejects.toThrow(/pack needs more than 80 MiB of memory to unpack; split it into smaller pushes/);
      clearInterval(t);
      expect(peak - before).toBeLessThan(64 * 1024 * 1024);
      await expect(parsePack(pack)).rejects.toThrow(/split it into smaller pushes|larger than/);
    }
  });

  it("reads each entry's own range again, keeps small ones from the first pass, and counts its reads", async () => {
    const reads = { bytes: 0, calls: 0 };
    const kept = await StreamedPack.open(source(full, reads), { blockBytes: 64 * 1024 }, () => {});
    const keptCalls = reads.calls;
    // Without keeping anything, every delta is read again, twice counted (storing replays it), each its own range.
    const bare = { bytes: 0, calls: 0 };
    const p = await StreamedPack.open(source(full, bare), { blockBytes: 64 * 1024, keepBytes: 0 }, () => {});
    expect(bare.calls).toBeGreaterThan(keptCalls);
    expect(bare.bytes).toBeLessThan(2 * full.length);
    expect(p.readsDone).toBeGreaterThan(kept.readsDone);
    await expect(StreamedPack.open(source(full), { blockBytes: 64 * 1024, keepBytes: 0, maxReads: p.readsDone - 1 }, () => {})).rejects.toThrow(/reads .* of storage to unpack; split it into smaller pushes/);
    // Replaying reads only what was counted.
    const counted = p.readsDone;
    await p.replayDeltas(async () => {});
    expect(p.readsDone).toBe(counted);
  });

  it("says what storing it adds: each delta's content, not its few bytes in the pack", async () => {
    const base = new Uint8Array(randomBytes(64 * 1024));
    const oid = await hashObject("blob", base);
    // Each copies the base and adds one byte: 200 different 64 KiB blobs from a pack of a few KB.
    const deltas = Array.from({ length: 200 }, (_, k) => ({ base: oid, delta: new Uint8Array([...varint(base.length), ...varint(base.length + 1), 0x80 | 0x20, 0x00, 1, k]) }));
    const pack = refDeltaChain(deltas, base);
    const p = await StreamedPack.open(source(pack), {}, () => {});
    expect(pack.length).toBeLessThan(200 * 1024);
    expect(p.storedBytes).toBeGreaterThanOrEqual(200 * (64 * 1024 + 1));
  });

  it("rebuilds the deltas for storing with exactly the work that already passed", async () => {
    const stored = new Map<string, GitObject>();
    for (const o of await parsePack(full)) stored.set(o.oid, { type: o.type, content: o.content });
    const external = async (oid: string) => stored.get(oid) ?? null;
    for (const [data, opts] of [
      [full, {}],
      [thin, { external }],
    ] as const) {
      const unlimited = await unpack(data, opts);
      // At the tightest limit that lets the pack in, storing it can't go over: nothing is refused halfway through.
      const { p, seen } = await unpack(data, { ...opts, maxWork: unlimited.p.workDone, yieldEvery: 4096 });
      const done = p.workDone;
      const rebuilt: string[] = [];
      await p.replayDeltas(async (entry, content) => {
        expect(Buffer.from(content).equals(Buffer.from(seen.get(p.oidOf(entry))!.content))).toBe(true);
        rebuilt.push(p.oidOf(entry));
      });
      expect(p.workDone).toBe(done);
      // It lets other work in the isolate run as it goes, as open does.
      const timers = vi.spyOn(globalThis, "setTimeout");
      await p.replayDeltas(async () => {});
      expect(timers.mock.calls.length).toBeGreaterThan(1);
      timers.mockRestore();
      const deltas = [...p.objects()].filter((x) => !x.deflated);
      expect(rebuilt.length).toBe(deltas.length);
      expect(new Set(rebuilt)).toEqual(new Set(deltas.map((x) => x.oid)));
    }
  });

  it("hashes and compresses a large object without a second copy of it", async () => {
    const content = new Uint8Array(randomBytes(8 * 1024 * 1024));
    const want = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    const digest = vi.spyOn(crypto.subtle, "digest");
    expect(await hashObject("blob", content)).toBe(want);
    // WebCrypto only hashes one whole buffer, so the header and content would be joined first.
    for (const [, data] of digest.mock.calls) expect((data as Uint8Array).byteLength).toBeLessThanOrEqual(HASH_COPY_MAX + 64);
    digest.mockRestore();
    expect(await hashObject("blob", content.subarray(0, 1000))).toBe(createHash("sha1").update("blob 1000\0").update(content.subarray(0, 1000)).digest("hex"));
    // The same zlib data as deflate, in chunks that are each far smaller than the object.
    const chunks = [...deflateChunks(content)];
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.concat(chunks).equals(Buffer.from(deflate(content)))).toBe(true);
    // A 50 MiB tree from a 51 KB pack is hashed where it lies: what it holds stays under the cap with the tree in it.
    const tree = await writePack([{ type: "tree", size: 50 * 1024 * 1024, deflated: new Uint8Array(deflateSync(new Uint8Array(50 * 1024 * 1024))) }]);
    const p = await StreamedPack.open(source(tree), {}, () => {});
    expect(p.peakHeldBytes).toBeLessThan(80 * 1024 * 1024);
    expect(p.peakHeldBytes).toBeGreaterThan(50 * 1024 * 1024 + SCRATCH_BYTES);
  });

  it("checks what a base from the repository takes before reading it", async () => {
    // A 400 MiB blob of zeros is about 400 KB stored; a thin pack's tiny delta against it would inflate it whole.
    const oid = "1".repeat(40);
    const asked: number[] = [];
    let read = false;
    const external = async (o: string, maxBytes: number) => {
      if (o !== oid) return null;
      asked.push(maxBytes);
      if (400 * 1024 * 1024 > maxBytes) return 400 * 1024 * 1024;
      read = true;
      return { type: "blob" as const, content: new Uint8Array(0) };
    };
    const thinPack = refDeltaPack(oid, [tinyDelta(400 * 1024 * 1024, 0, 1)]);
    await expect(StreamedPack.open(source(thinPack), { external }, () => {})).rejects.toThrow(TooMuchMemory);
    await expect(parsePack(thinPack, external)).rejects.toThrow(/pack needs more than 80 MiB of memory to unpack; split it into smaller pushes/);
    expect(read).toBe(false);
    expect(asked).toHaveLength(2);
    for (const n of asked) expect(n).toBeLessThan(80 * 1024 * 1024);
  });

  it("rebuilds a long history of one large file holding two versions at a time", { timeout: 60_000 }, async () => {
    // A 2.6 MiB lockfile over 60 commits, each version a delta against the one before, as git packs it.
    let version = new Uint8Array(Buffer.from(Array.from({ length: 110_000 }, (_, i) => `"pkg-${i}": "1.0.${i % 97}",\n`).join("").slice(0, 2_600_000)));
    const blob = version;
    const deltas: { base: string; delta: Uint8Array }[] = [];
    for (let k = 0; k < 60; k++) {
      const n = version.length;
      const half = n >> 1;
      const copy = (off: number, len: number) => [0x80 | 0x0f | 0x70, off & 0xff, (off >> 8) & 0xff, (off >> 16) & 0xff, (off >>> 24) & 0xff, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff];
      const delta = new Uint8Array([...varint(n), ...varint(n + 1), ...copy(0, half), 1, k, ...copy(half, n - half)]);
      const next = new Uint8Array(n + 1);
      next.set(version.subarray(0, half));
      next[half] = k;
      next.set(version.subarray(half), half + 1);
      deltas.push({ base: await hashObject("blob", version), delta });
      version = next;
    }
    const chain = refDeltaChain(deltas.reverse(), blob);
    const last = await hashObject("blob", version);
    let seen = false;
    const p = await StreamedPack.open(source(chain), {}, (o, content) => {
      if (o.oid === last) seen = Buffer.from(content!).equals(Buffer.from(version));
    });
    expect(seen).toBe(true);
    // Its caches and scratch, then the version being rebuilt from and the one being rebuilt.
    expect(p.peakHeldBytes).toBeLessThan(24 * 1024 * 1024 + 3 * version.length + 1024 * 1024);
    let stored = 0;
    await p.replayDeltas(async () => void stored++);
    expect(stored).toBe(60);
    // Parsed whole it holds every version: refused as memory, which a push takes as its cue to unpack it in pieces.
    await expect(parsePack(chain)).rejects.toThrow(TooMuchMemory);
  });

  it("frees a chain's first version once the next is rebuilt from it", { timeout: 60_000 }, async () => {
    setFlagsFromString("--expose-gc");
    // V8 frees ArrayBuffer memory on a background thread after a collection, so a reading right after
    // gc() can still count buffers it just freed: a tenth of readings on a busy host (81.9 MB here on
    // CI, one 26 MiB version too many). Swept on this thread, gc() returns with them uncounted.
    setFlagsFromString("--no-concurrent-array-buffer-sweeping");
    const gc = runInNewContext("gc") as () => void;
    // A 26 MiB text file, then three versions of it, each a small delta against the one before.
    const n = 26 * 1024 * 1024;
    let version = new Uint8Array(Buffer.from("a line of a large text file\n".repeat(Math.ceil(n / 28)).slice(0, n)));
    const blob = version;
    const deltas: { base: string; delta: Uint8Array }[] = [];
    for (let k = 0; k < 3; k++) {
      const len = version.length;
      // Copies of at most 8 MiB (a copy's size has three bytes), then the byte that's new.
      const ops: number[] = [];
      for (let off = 0; off < len; off += 8 << 20) {
        const m = Math.min(8 << 20, len - off);
        ops.push(0x80 | 0x0f | 0x70, off & 0xff, (off >> 8) & 0xff, (off >> 16) & 0xff, (off >>> 24) & 0xff, m & 0xff, (m >> 8) & 0xff, (m >> 16) & 0xff);
      }
      const delta = new Uint8Array([...varint(len), ...varint(len + 1), ...ops, 1, k]);
      const next = new Uint8Array(len + 1);
      next.set(version);
      next[len] = k;
      deltas.push({ base: await hashObject("blob", version), delta });
      version = next;
    }
    const chain = new Uint8Array(refDeltaChain(deltas.reverse(), blob));
    const last = await hashObject("blob", version);
    version = new Uint8Array(0);
    let atLast = 0;
    await StreamedPack.open(source(chain), {}, (o) => {
      if (o.oid !== last) return;
      gc();
      atLast = process.memoryUsage().arrayBuffers;
    });
    // Measured against what is left once the unpack is gone.
    gc();
    const live = atLast - process.memoryUsage().arrayBuffers;
    // At most the version it was rebuilt from and itself, and what the caches hold: not the first
    // version as well. (Only an upper bound: when the collector frees what is no longer used varies.)
    expect(live).toBeLessThan(2 * n + 8 * 1024 * 1024);
  });

  it("measures what a large rebuilt delta compresses to, for counting and storing it", async () => {
    // 40 versions of a 600 KB file that compresses well: each one stored inline, so no write of its own is counted.
    let version = new Uint8Array(Buffer.from(Array.from({ length: 30_000 }, (_, i) => `"pkg-${i}": "1.0.${i % 7}",\n`).join("").slice(0, 600_000)));
    const blob = version;
    const deltas: { base: string; delta: Uint8Array }[] = [];
    const versions: Uint8Array[] = [];
    for (let k = 0; k < 40; k++) {
      const len = version.length;
      const delta = new Uint8Array([...varint(len), ...varint(len + 1), 0x80 | 0x70, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, 1, k]);
      const next = new Uint8Array(len + 1);
      next.set(version);
      next[len] = k;
      deltas.push({ base: await hashObject("blob", version), delta });
      versions.push(next);
      version = next;
    }
    const chain = refDeltaChain(deltas.reverse(), blob);
    const counted = await StreamedPack.open(source(chain), {}, () => {});
    const p = await StreamedPack.open(source(chain), { writesOver: 512 * 1024 }, () => {});
    expect(p.readsDone).toBe(counted.readsDone);
    const byOid = new Map(await Promise.all(versions.map(async (v) => [await hashObject("blob", v), v] as const)));
    let measured = 0;
    for (const x of p.objects()) {
      if (x.deflated) continue;
      expect(p.zlibSizeOf(x.entry)).toBe(deflate(byOid.get(x.oid)!).length);
      measured++;
    }
    expect(measured).toBe(40);
    // A pack that unpacks to more than it may says so for the whole push, not for one object.
    await expect(StreamedPack.open(source(chain), { maxBytes: 4 * 1024 * 1024 }, () => {})).rejects.toThrow("pack unpacks to more than 4 MiB; split it into smaller pushes");
    await expect(parsePack(chain, undefined, { maxBytes: 4 * 1024 * 1024 })).rejects.toThrow("pack unpacks to more than 4 MiB; split it into smaller pushes");
  });
});
