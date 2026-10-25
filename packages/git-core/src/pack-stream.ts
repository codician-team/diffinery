import pako from "pako";
import { equalBytes, fromHex, toHex } from "./bytes.js";
import { applyDelta, deltaResultSize } from "./delta.js";
import { CODE_TYPES, TYPE_CODES, hashObject, objectHeader, type GitObject, type ObjectType } from "./objects.js";
import { MAX_HELD_BYTES, MAX_UNPACKED_BYTES, tooBigUnpacked, tooMuchMemory, type ExternalLookup } from "./pack.js";
import { deflateChunks } from "./zlib.js";
import { Sha1 } from "./sha1.js";

/**
 * Unpacking a pack that is never held whole: it is read in ranges (from R2, where a large push is
 * staged), indexed in one pass, and each object is inflated again, and its deltas applied again,
 * whenever it is needed, with a bounded cache of resolved objects.
 *
 * The same limits as `parsePack` apply: each object stops inflating at its declared size, and the
 * pack may unpack to at most `maxBytes` counted the same way (every entry's declared size, then
 * every delta's result, and a large base once for all its deltas), and deltas are resolved in one
 * pass from their bases, whatever order the pack lists them in. Inflating objects again is counted
 * separately, against `maxWork`.
 *
 * Everything it holds is charged against `maxHeldBytes` before it is allocated: the caches, about
 * ENTRY_OVERHEAD bytes for each object, the zlib data it keeps to inflate again, SCRATCH_BYTES for
 * hashing and storing an object, and every object while it is in use (a delta's instructions, its
 * base and its result, a base from the repository). Requests are counted and capped too: each R2
 * read, each base read from the repository and each object storing writes to R2 on its own is a
 * subrequest, and an invocation has a limited number.
 */

export interface PackSource {
  /** The pack's length, its 20-byte checksum included. */
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface StreamedObject {
  oid: string;
  type: ObjectType;
  size: number;
}

export interface UnpackOptions {
  external?: ExternalLookup;
  maxBytes?: number;
  /** Bytes inflated or rebuilt from deltas in all, re-reads included (default 4 × maxBytes). */
  maxWork?: number;
  /** Blobs at least this large are hashed and handed over as they inflate, never whole (like `parsePack`'s). */
  largeObjectBytes?: number;
  /** Objects a pack may hold. */
  maxObjects?: number;
  /** The pack is read in blocks of this size for its one sequential pass (and for storing it). */
  blockBytes?: number;
  maxBlocks?: number;
  /** Resolved objects kept for reuse as delta bases, in bytes. */
  cacheBytes?: number;
  /** Zlib data of deltas kept from the first pass, so they are inflated again without reading the source (default 16 MiB). */
  keepBytes?: number;
  /** Bytes read at once when an entry not kept is read again, so entries near each other take one read. */
  windowBytes?: number;
  /** What it may hold in all (default MAX_HELD_BYTES, as parsePack). */
  maxHeldBytes?: number;
  /**
   * Requests in all (default 500, well within an invocation's 1,000 subrequests): reads of the
   * source, storing's included, bases read from the repository, and objects stored on their own.
   */
  maxReads?: number;
  /** Bytes read from the source in all, storing included (default 6 × the pack's size + 64 MiB). */
  maxReadBytes?: number;
  /**
   * Storing writes an object whose zlib data is larger than this with a request of its own (to R2):
   * each one is counted with the reads. Default: none is.
   */
  writesOver?: number;
  /** Bytes of inflating between yields to the event loop (default 4 MiB), so a long unpack doesn't hold up everything else in the isolate. */
  yieldEvery?: number;
}

/** Hands a large blob's content to `onChunk` slice by slice. */
export type ChunkFeed = (onChunk: (chunk: Uint8Array) => void) => Promise<void>;

const OFS_DELTA = 6;
const REF_DELTA = 7;
export const MAX_STREAMED_OBJECTS = 1_000_000;

/**
 * What one object costs to hold beyond its content: its slots in the index's typed arrays and its
 * oid, and, for a delta, its place in the lists of deltas waiting on a base and in the replay plan.
 * Measured at about 100 bytes in Node at the end of indexing 200,000 small objects, half of them
 * OFS_DELTAs.
 */
export const ENTRY_OVERHEAD = 128;

/**
 * What a REF_DELTA costs besides: its base's oid, kept by entry and as the key it waits on. Measured
 * at about 510 bytes more than an OFS_DELTA.
 */
export const REF_DELTA_OVERHEAD = 640;

/** What keeping one object in a cache costs beyond its bytes: a map entry, its key, and the Uint8Array. */
const CACHED_OVERHEAD = 192;

/** Zlib data longer than this isn't kept from the first pass: it is read again when needed. */
const KEEP_ENTRY_MAX = 1024 * 1024;

/** Kept zlib data is packed into buffers of this size; an entry over a quarter of it gets its own. */
const KEEP_CHUNK = 1024 * 1024;

/**
 * Held throughout for the one object being hashed or stored: hashing copies one of up to
 * HASH_COPY_MAX bytes after its header (a larger one is hashed in pieces), and storing compresses
 * one, whole up to 1 MiB (its zlib chunks and their join), larger ones a chunk at a time.
 */
export const SCRATCH_BYTES = 3 * 1024 * 1024;

const DEFAULTS = { blockBytes: 2 * 1024 * 1024, maxBlocks: 4, cacheBytes: 12 * 1024 * 1024, keepBytes: 16 * 1024 * 1024, windowBytes: 1024 * 1024, maxReads: 500 };

/** The most zlib data `n` bytes compress to (zlib's deflateBound, with its 6 bytes of header and trailer). */
function deflateBound(n: number): number {
  return n + Math.floor(n / 4096) + Math.floor(n / 16384) + Math.floor(n / 33554432) + 13 + 6;
}

/** Fixed-size blocks of the source, the most recently used kept: for reading it in order. */
class Blocks {
  private cache = new Map<number, Uint8Array>();
  constructor(
    private src: PackSource,
    private blockBytes: number,
    private maxBlocks: number,
    private onRead: (bytes: number) => void,
  ) {}

  /** Forget the blocks kept, so what follows reads exactly as it would from the start. */
  clear(): void {
    this.cache.clear();
  }

  async block(i: number): Promise<Uint8Array> {
    const hit = this.cache.get(i);
    if (hit) {
      this.cache.delete(i);
      this.cache.set(i, hit);
      return hit;
    }
    const start = i * this.blockBytes;
    const len = Math.min(this.blockBytes, this.src.size - start);
    if (len <= 0) throw new Error("read past the end of the pack");
    this.onRead(len);
    const data = await this.src.read(start, len);
    if (data.length !== len) throw new Error(`short read of the pack at ${start}: ${data.length} of ${len} bytes`);
    this.cache.set(i, data);
    while (this.cache.size > this.maxBlocks) this.cache.delete(this.cache.keys().next().value as number);
    return data;
  }

  /** Views of the source from `offset` on, block by block, up to `end`. */
  async *views(offset: number, end = this.src.size): AsyncGenerator<Uint8Array> {
    let at = offset;
    while (at < end) {
      const i = Math.floor(at / this.blockBytes);
      const b = await this.block(i);
      const from = at - i * this.blockBytes;
      const to = Math.min(b.length, end - i * this.blockBytes);
      yield b.subarray(from, to);
      at += to - from;
    }
  }

  async bytes(offset: number, n: number): Promise<Uint8Array> {
    const end = Math.min(offset + n, this.src.size);
    const out = new Uint8Array(end - offset);
    let at = 0;
    for await (const v of this.views(offset, end)) {
      out.set(v, at);
      at += v.length;
    }
    return out;
  }
}

/**
 * An inflater for one zlib stream (zlib only: pako also takes gzip unless told not to, the zlib data
 * is stored as sent, and git can't read gzip) that stops at `expectedSize` and writes into one
 * buffer of that size, or hands its output to `onChunk`.
 */
function inflater(offset: number, expectedSize: number, onChunk?: (chunk: Uint8Array) => void) {
  const inflator = new pako.Inflate(onChunk ? { chunkSize: 256 * 1024, windowBits: 15 } : { windowBits: 15 }) as pako.Inflate & { ended: boolean };
  const out = onChunk ? null : new Uint8Array(expectedSize);
  let produced = 0;
  inflator.onData = (chunk) => {
    const c = chunk as Uint8Array;
    // A small zlib stream can't be made to inflate past the size the pack declared.
    if (produced + c.length > expectedSize) throw new Error(`object at ${offset} is larger than its declared size (${expectedSize} bytes)`);
    if (onChunk) onChunk(c);
    else out!.set(c, produced);
    produced += c.length;
  };
  return {
    push(v: Uint8Array) {
      inflator.push(v, false);
      if (inflator.err) throw new Error(`zlib error at ${offset}: ${inflator.msg}`);
      return inflator.ended;
    },
    /** Input pushed but not used: what follows the stream. */
    unused() {
      return (inflator as unknown as { strm: { avail_in: number } }).strm.avail_in;
    },
    finish(pushed: number) {
      if (!inflator.ended) throw new Error(`truncated zlib stream at offset ${offset}`);
      if (produced !== expectedSize) throw new Error(`size mismatch at ${offset}: ${produced} != ${expectedSize}`);
      return { consumed: pushed - this.unused(), out };
    },
  };
}

/**
 * One zlib stream starting at `offset` in the source: its input length, and its output (whole, or
 * to `onChunk`). `onInput` gets exactly the stream's bytes, as they are read.
 */
async function inflateFrom(blocks: Blocks, offset: number, expectedSize: number, onChunk?: (chunk: Uint8Array) => void, onInput?: (bytes: Uint8Array) => void): Promise<{ consumed: number; out: Uint8Array | null }> {
  const z = inflater(offset, expectedSize, onChunk);
  let pushed = 0;
  for await (const v of blocks.views(offset)) {
    pushed += v.length;
    const ended = z.push(v);
    onInput?.(ended ? v.subarray(0, v.length - z.unused()) : v);
    if (ended) break;
  }
  return z.finish(pushed);
}

/** LRU by entry (or by oid, for a base from outside the pack), bounded in bytes, each entry counted with what holding it costs. */
class Lru {
  private map = new Map<number | string, Uint8Array>();
  private bytes = 0;
  constructor(private max: number) {}
  get(i: number | string): Uint8Array | undefined {
    const hit = this.map.get(i);
    if (hit) {
      this.map.delete(i);
      this.map.set(i, hit);
    }
    return hit;
  }
  set(i: number | string, content: Uint8Array): void {
    if (content.length > this.max / 4 || this.map.has(i)) return;
    this.map.set(i, content);
    this.bytes += content.length + CACHED_OVERHEAD;
    while (this.bytes > this.max) {
      const [k, v] = this.map.entries().next().value as [number | string, Uint8Array];
      this.map.delete(k);
      this.bytes -= v.length + CACHED_OVERHEAD;
    }
  }
}

export class StreamedPack {
  private blocks: Blocks;
  private cache: Lru;
  // The index, one slot per entry in pack order, in typed arrays: the pack says how many entries it has.
  private offsets = new Float64Array(0);
  /** Bytes from the entry's start to its zlib data. */
  private headLen = new Uint8Array(0);
  private zlen = new Float64Array(0);
  private codes = new Uint8Array(0);
  /** The size each entry's header declares: an object's, or a delta's instructions'. */
  private declared = new Float64Array(0);
  /** Each object's size (a delta's once it is resolved). */
  private sizes = new Float64Array(0);
  /** Each object's type code, once known. */
  private typeCodes = new Uint8Array(0);
  /** Each delta's base: an entry, or EXTERNAL for one from outside the pack. */
  private baseOf = new Int32Array(0);
  /** Each object's oid, 20 bytes apiece, once known. */
  private oidBytes = new Uint8Array(0);
  /**
   * Zlib data kept from the first pass: deltas', packed into a few large buffers (no per-entry
   * object). An entry's is at `keptOff` in buffer `keptChunk` (-1: not kept).
   */
  private keptChunks: Uint8Array[] = [];
  private keptChunk = new Int32Array(0);
  private keptOff = new Uint32Array(0);
  /** Where the next small entry goes in the last shared buffer. */
  private keptFill = { chunk: -1, at: 0 };
  /** The source last read again, from `start`. */
  private window: { start: number; data: Uint8Array } | null = null;
  private keptBytes = 0;
  /** A REF_DELTA's base oid, until its base is found in the pack (kept for one outside it). */
  private refBase = new Map<number, string>();
  /** Deltas waiting on a base in the pack, by its entry, or by oid (a REF_DELTA's). */
  private waitingOnEntry = new Map<number, number[]>();
  private waitingOnOid = new Map<string, number[]>();
  /** The zlib data's size of each delta result large enough that storing may write it on its own. */
  private zlibSizes = new Map<number, number>();
  /** Bases from outside the pack (a thin pack's), by oid: their type. */
  private externals = new Map<string, ObjectType>();
  /**
   * What resolving the deltas did, in order, for `replayDeltas` to do again exactly: a base (its
   * entry, or -1 - k for the k-th base from outside the pack), the number of deltas against it, then
   * those deltas.
   */
  private plan: number[] = [];
  private externalOids: string[] = [];
  private entries = 0;
  private unpacked = 0;
  private work = 0;
  /** What is held, as charged against `maxHeldBytes`, and the most it has been. */
  private held = 0;
  private peak = 0;
  private reads = 0;
  private readBytes = 0;
  /** What a read counts for: twice while resolving (replaying reads it again), and nothing while replaying. */
  private readWeight = 1;
  /** Storing's reads of the objects that aren't deltas, counted in advance. */
  private inSlices = false;
  /** Work, what is held, and reads once the pack was indexed, where resolving the deltas starts. */
  private afterIndex = { work: 0, held: 0 };
  private yieldedAt = 0;
  private readonly maxBytes: number;
  private readonly maxWork: number;
  private readonly maxHeld: number;
  private readonly maxReads: number;
  private readonly maxReadBytes: number;
  private readonly large: number;
  private readonly cacheBytes: number;

  private constructor(
    private src: PackSource,
    private o: UnpackOptions,
  ) {
    this.blocks = new Blocks(src, o.blockBytes ?? DEFAULTS.blockBytes, o.maxBlocks ?? DEFAULTS.maxBlocks, (n) => {
      if (!this.inSlices) this.read_(n, this.readWeight);
    });
    this.cacheBytes = o.cacheBytes ?? DEFAULTS.cacheBytes;
    this.cache = new Lru(this.cacheBytes);
    this.maxBytes = o.maxBytes ?? MAX_UNPACKED_BYTES;
    this.maxWork = o.maxWork ?? 4 * this.maxBytes;
    this.maxHeld = o.maxHeldBytes ?? MAX_HELD_BYTES;
    this.maxReads = o.maxReads ?? DEFAULTS.maxReads;
    this.maxReadBytes = o.maxReadBytes ?? 6 * src.size + 64 * 1024 * 1024;
    this.large = o.largeObjectBytes ?? 4 * 1024 * 1024;
  }

  /** The index, once it is known to fit. */
  private allocate(count: number) {
    this.offsets = new Float64Array(count);
    this.headLen = new Uint8Array(count);
    this.zlen = new Float64Array(count);
    this.codes = new Uint8Array(count);
    this.declared = new Float64Array(count);
    this.sizes = new Float64Array(count);
    this.typeCodes = new Uint8Array(count);
    this.baseOf = new Int32Array(count).fill(NONE);
    this.oidBytes = new Uint8Array(count * 20);
    this.keptChunk = new Int32Array(count).fill(-1);
    this.keptOff = new Uint32Array(count);
  }

  get count(): number {
    return this.entries;
  }

  /** Bytes inflated or rebuilt so far, as counted against `maxWork`. */
  get workDone(): number {
    return this.work;
  }

  /** What is held now, as charged against `maxHeldBytes`. */
  get heldBytes(): number {
    return this.held;
  }

  /** The most it has held at once, as charged against `maxHeldBytes`. */
  get peakHeldBytes(): number {
    return this.peak;
  }

  /** Reads of the source so far, those storing will make counted in advance. */
  get readsDone(): number {
    return this.reads;
  }

  /**
   * At most what storing the push adds: the zlib data of each object that isn't a delta, stored as
   * sent, and each delta's content, stored compressed on its own (counted uncompressed).
   */
  get storedBytes(): number {
    let n = 0;
    for (let i = 0; i < this.entries; i++) n += this.codes[i] === OFS_DELTA || this.codes[i] === REF_DELTA ? (this.zlibSizes.get(i) ?? this.sizes[i]!) : this.zlen[i]!;
    return n;
  }

  /** A rebuilt delta's size compressed, when it was large enough to be measured (for storing it). */
  zlibSizeOf(entry: number): number | undefined {
    return this.zlibSizes.get(entry);
  }

  /**
   * Index the pack and resolve every object, handing each one to `visit` once: with its content,
   * or, for a large blob, with a feed of its content in slices.
   */
  static async open(src: PackSource, o: UnpackOptions, visit: Visit): Promise<StreamedPack> {
    if (src.size < 32) throw new Error("not a packfile");
    const p = new StreamedPack(src, o);
    p.read_(12, 1);
    const head = await src.read(0, 12);
    if (head.length !== 12 || head[0] !== 0x50 || head[1] !== 0x41 || head[2] !== 0x43 || head[3] !== 0x4b) throw new Error("not a packfile");
    const view = new DataView(head.buffer, head.byteOffset, 12);
    const version = view.getUint32(4);
    if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
    const count = view.getUint32(8);
    if (count > (o.maxObjects ?? MAX_STREAMED_OBJECTS)) throw new Error(`the pack has ${count} objects, more than one push may hold; split it into smaller pushes`);
    // An entry is at least a byte of header and a zlib stream (8 bytes): no more can fit.
    if (count > (src.size - 32) / 9) throw new Error(`truncated pack: ${src.size} bytes can't hold ${count} objects`);
    // Its caches, scratch and index are held throughout: refused up front if they can't fit.
    p.hold((o.blockBytes ?? DEFAULTS.blockBytes) * (o.maxBlocks ?? DEFAULTS.maxBlocks) + p.cacheBytes + (o.windowBytes ?? DEFAULTS.windowBytes) + SCRATCH_BYTES + count * ENTRY_OVERHEAD);
    p.allocate(count);
    // Storing reads the pack once more in order, for the objects that aren't deltas: counted now.
    p.reads += Math.ceil(src.size / (o.blockBytes ?? DEFAULTS.blockBytes));
    p.readBytes += src.size;
    p.checkReads();
    await p.index(count, visit);
    p.afterIndex = { work: p.work, held: p.held };
    p.readWeight = 2;
    await p.resolveDeltas(visit);
    p.readWeight = 1;
    return p;
  }

  private tooBig() {
    return tooBigUnpacked(this.maxBytes);
  }

  /** Let other work in the isolate run now and then: an unpack can take most of a minute of CPU. */
  async breathe(): Promise<void> {
    if (this.work - this.yieldedAt < (this.o.yieldEvery ?? 4 * 1024 * 1024)) return;
    this.yieldedAt = this.work;
    await new Promise((r) => setTimeout(r, 0));
  }

  private count_(n: number) {
    this.work += n;
    if (this.work > this.maxWork) throw new Error(`pack takes more than ${this.maxWork} bytes of inflating to unpack; split it into smaller pushes`);
  }

  private unpack_(n: number) {
    if (this.unpacked + n > this.maxBytes) throw this.tooBig();
    this.unpacked += n;
  }

  private hold(n: number) {
    if (this.held + n > this.maxHeld) throw tooMuchMemory(this.maxHeld);
    this.held += n;
    if (this.held > this.peak) this.peak = this.held;
  }

  private release(n: number) {
    this.held -= n;
  }

  /** What is left to hold an object with now. */
  private room(): number {
    return this.maxHeld - this.held;
  }

  private read_(bytes: number, weight: number) {
    this.reads += weight;
    this.readBytes += bytes * weight;
    this.checkReads();
  }

  /** Storing will write an object of `zlibBytes` (at most) with a request of its own: counted now. */
  private willWrite(zlibBytes: number) {
    if (zlibBytes > (this.o.writesOver ?? Infinity)) this.read_(0, 1);
  }

  private checkReads() {
    if (this.reads > this.maxReads || this.readBytes > this.maxReadBytes) throw new Error(`pack takes more than ${this.maxReads} reads (or ${this.maxReadBytes} bytes) of storage to unpack; split it into smaller pushes`);
  }

  private setOid(i: number, oid: string) {
    this.oidBytes.set(fromHex(oid), i * 20);
  }

  private dataAt(i: number): number {
    return this.offsets[i]! + this.headLen[i]!;
  }

  /** Keep entry `i`'s zlib data from the first pass, if it is small and there is room. */
  private async keep(i: number): Promise<void> {
    const len = this.zlen[i]!;
    if (len > KEEP_ENTRY_MAX) return;
    const f = this.keptFill;
    if (len > KEEP_CHUNK / 4 || f.chunk < 0 || f.at + len > KEEP_CHUNK) {
      // A new buffer: of its own for a large entry, else shared by the small ones that follow.
      const size = len > KEEP_CHUNK / 4 ? len : KEEP_CHUNK;
      if (this.keptBytes + size > (this.o.keepBytes ?? DEFAULTS.keepBytes) || size + CACHED_OVERHEAD > this.room()) return;
      this.hold(size + CACHED_OVERHEAD);
      this.keptBytes += size + CACHED_OVERHEAD;
      this.keptChunks.push(new Uint8Array(size));
      if (size === KEEP_CHUNK) this.keptFill = { chunk: this.keptChunks.length - 1, at: 0 };
    }
    const own = len > KEEP_CHUNK / 4;
    const c = own ? this.keptChunks.length - 1 : this.keptFill.chunk;
    const at = own ? 0 : this.keptFill.at;
    let w = at;
    for await (const v of this.blocks.views(this.dataAt(i), this.dataAt(i) + len)) {
      this.keptChunks[c]!.set(v, w);
      w += v.length;
    }
    if (!own) this.keptFill.at += len;
    this.keptChunk[i] = c;
    this.keptOff[i] = at;
  }

  /** Entry `i`'s zlib data as the first pass kept it, or null. */
  private keptData(i: number): Uint8Array | null {
    const c = this.keptChunk[i]!;
    return c < 0 ? null : this.keptChunks[c]!.subarray(this.keptOff[i]!, this.keptOff[i]! + this.zlen[i]!);
  }

  private async index(count: number, visit: Visit): Promise<void> {
    const size = this.src.size;
    // Hashed as it is read, so nothing is read twice.
    const checksum = new Sha1().update(await this.blocks.bytes(0, 12));
    const hash = (bytes: Uint8Array) => void checksum.update(bytes);
    let pos = 12;
    for (let n = 0; n < count; n++) {
      const offset = pos;
      // An entry's header is at most 10 bytes of size, then 20 of base oid (or 10 of base offset).
      const h = await this.blocks.bytes(pos, 32);
      let k = 0;
      let c = h[k++]!;
      const code = (c >> 4) & 7;
      let objSize = c & 15;
      let shift = 4;
      while (c & 0x80) {
        if (k >= 11) throw new Error(`bad object header at ${offset}`);
        c = h[k++]!;
        objSize += (c & 0x7f) * 2 ** shift;
        shift += 7;
      }
      let baseEntry = NONE;
      let baseOid: string | undefined;
      if (code === OFS_DELTA) {
        c = h[k++]!;
        let ofs = c & 0x7f;
        while (c & 0x80) {
          if (k >= 22) throw new Error(`bad delta base offset at ${offset}`);
          c = h[k++]!;
          ofs = (ofs + 1) * 128 + (c & 0x7f);
        }
        const base = offset - ofs;
        if (base < 12 || base >= offset) throw new Error(`bad delta base offset at ${offset}`);
        baseEntry = this.entryAt(base, n);
      } else if (code === REF_DELTA) {
        if (k + 20 > h.length) throw new Error(`truncated pack at ${offset}`);
        baseOid = toHex(h.subarray(k, k + 20));
        k += 20;
      } else if (!CODE_TYPES[code]) {
        throw new Error(`bad object type ${code} at ${offset}`);
      }
      checksum.update(h.subarray(0, k));
      pos += k;
      this.unpack_(objSize);
      const type = CODE_TYPES[code];
      let consumed: number;
      if (type === "blob" && objSize >= this.large) {
        // Hashed as it inflates, never held whole.
        const sha = new Sha1().update(objectHeader("blob", objSize));
        const r = await inflateFrom(this.blocks, pos, objSize, (chunk) => sha.update(chunk), hash);
        this.count_(objSize);
        consumed = r.consumed;
        const oid = toHex(sha.digest());
        this.setOid(n, oid);
        this.willWrite(consumed);
        const at = pos;
        await visit({ oid, type, size: objSize }, null, (onChunk) => this.feed(at, objSize, onChunk));
      } else if (type) {
        // Held from before it is inflated (at its declared size) until it has been visited.
        this.hold(objSize);
        const r = await inflateFrom(this.blocks, pos, objSize, undefined, hash);
        this.count_(objSize);
        consumed = r.consumed;
        const oid = await hashObject(type, r.out!);
        this.setOid(n, oid);
        this.willWrite(consumed);
        await visit({ oid, type, size: objSize }, r.out!, null);
        this.release(objSize);
      } else {
        // A delta: read through to find where it ends; it is inflated again when resolved.
        const r = await inflateFrom(this.blocks, pos, objSize, () => {}, hash);
        this.count_(objSize);
        consumed = r.consumed;
        if (baseOid !== undefined) {
          this.hold(REF_DELTA_OVERHEAD);
          this.refBase.set(n, baseOid);
          waitOn(this.waitingOnOid, baseOid, n);
        } else waitOn(this.waitingOnEntry, baseEntry, n);
      }
      this.offsets[n] = offset;
      this.headLen[n] = k;
      this.zlen[n] = consumed;
      this.codes[n] = code;
      this.declared[n] = objSize;
      this.sizes[n] = type ? objSize : 0;
      this.typeCodes[n] = type ? code : 0;
      this.baseOf[n] = baseEntry;
      this.entries = n + 1;
      // A delta is inflated again: kept while it is at hand, if there is room.
      if (!type) await this.keep(n);
      pos += consumed;
      if (pos > size - 20) throw new Error(`truncated pack at ${offset}`);
      await this.breathe();
    }
    if (pos !== size - 20) throw new Error("trailing garbage in pack");
    const trailer = await this.blocks.bytes(size - 20, 20);
    if (!equalBytes(trailer, checksum.digest())) throw new Error("pack checksum mismatch");
  }

  /** Entry number of the entry starting at `offset`, among the first `n` (offsets ascend). */
  private entryAt(offset: number, n: number): number {
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.offsets[mid]!;
      if (v === offset) return mid;
      if (v < offset) lo = mid + 1;
      else hi = mid - 1;
    }
    throw new Error(`no object starts at delta base offset ${offset}`);
  }

  /**
   * One pass: each object, once known, has the deltas waiting on it applied, depth first, as git's
   * index-pack does: a delta's own deltas are rebuilt from it while it is at hand. The objects that
   * aren't deltas start it in pack order, so those read again are read in order. What is left
   * waits on bases from outside the pack, each read once.
   */
  private async resolveDeltas(visit: Visit): Promise<void> {
    this.window = null;
    this.blocks.clear();
    const onKid = (kid: number, content: Uint8Array) => this.visitResolved(kid, content, visit);
    const takeKids = (kid: number) => this.takeWaiting(kid);
    for (let i = 0; i < this.entries; i++) {
      if (this.codes[i] === OFS_DELTA || this.codes[i] === REF_DELTA) continue;
      const kids = this.takeWaiting(i);
      if (!kids) continue;
      // A large blob is inflated once for all its deltas: counted once, as parsePack does.
      if (this.codes[i] === TYPE_CODES.blob && this.sizes[i]! >= this.large) this.unpack_(this.sizes[i]!);
      await this.descend({ base: await this.content_(i) }, i, this.typeCodes[i]!, kids, onKid, takeKids);
    }
    for (const oid of [...this.waitingOnOid.keys()]) {
      if (!this.waitingOnOid.has(oid) || !this.o.external) continue;
      const start = await this.externalStart(oid);
      if (!start) continue;
      const kids = this.waitingOnOid.get(oid)!;
      this.waitingOnOid.delete(oid);
      this.planGroup(-1 - this.externalOids.length, kids);
      this.externalOids.push(oid);
      this.unpack_(start.first.base!.length);
      await this.descend(start.first, EXTERNAL, start.typeCode, kids, onKid, takeKids);
    }
    const unresolved = [...this.waitingOnOid.keys(), ...[...this.waitingOnEntry.keys()].map((e) => `@${this.offsets[e]}`)];
    if (unresolved.length) throw new Error(`unresolvable delta base(s): ${unresolved.join(", ")}`);
  }

  /** The deltas waiting on entry `b`, now known, taken (and recorded for the replay); null if none. */
  private takeWaiting(b: number): number[] | null {
    const byEntry = this.waitingOnEntry.get(b);
    const oid = this.oidOf(b);
    const byOid = this.waitingOnOid.get(oid);
    if (!byEntry && !byOid) return null;
    this.waitingOnEntry.delete(b);
    this.waitingOnOid.delete(oid);
    const kids = byEntry && byOid ? [...byEntry, ...byOid] : (byEntry ?? byOid)!;
    this.planGroup(b, kids);
    return kids;
  }

  private planGroup(b: number, kids: number[]) {
    this.plan.push(b, kids.length);
    for (const k of kids) this.plan.push(k);
  }

  private async visitResolved(kid: number, content: Uint8Array, visit: Visit): Promise<void> {
    const type = CODE_TYPES[this.typeCodes[kid]!]!;
    const oid = await hashObject(type, content);
    this.setOid(kid, oid);
    // One that may be stored on its own is compressed now to learn its size, which storing reuses.
    let zlib = deflateBound(content.length);
    if (zlib > (this.o.writesOver ?? Infinity)) {
      zlib = 0;
      for (const c of deflateChunks(content)) zlib += c.length;
      this.zlibSizes.set(kid, zlib);
    }
    this.willWrite(zlib);
    await visit({ oid, type, size: content.length }, content, null);
  }

  /**
   * Rebuild each of `kids` from `base` (held, released here), handing each on, and each one's own
   * deltas from it while it is held. The same steps when resolving and when replaying, so both do
   * the same work, hold the same and read the same.
   */
  private async descend(
    first: { base: Uint8Array | null },
    b: number,
    typeCode: number,
    kids: number[],
    onKid: (kid: number, content: Uint8Array) => Promise<void>,
    takeKids: (kid: number) => number[] | null,
  ): Promise<void> {
    // The stack is the only reference to the first base (the caller's is dropped), so letting go of it frees it.
    const stack = [{ base: first.base!, b, kids, k: 0 }];
    first.base = null;
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const kid = top.kids[top.k++]!;
      const content = await this.applyOne(kid, top.base, this.maxBytes - this.unpacked);
      if (top.b !== EXTERNAL) this.refBase.delete(kid);
      this.baseOf[kid] = top.b;
      this.typeCodes[kid] = typeCode;
      this.sizes[kid] = content.length;
      this.unpack_(content.length);
      this.cache.set(kid, content);
      await onKid(kid, content);
      await this.breathe();
      // A base is let go once its last delta is rebuilt, before that delta's own deltas: a long
      // chain of versions of one file holds two of them at a time, not all of them.
      if (top.k === top.kids.length) {
        this.release(top.base.length);
        top.base = EMPTY;
        stack.pop();
      }
      const next = takeKids(kid);
      if (next) stack.push({ base: content, b: kid, kids: next, k: 0 });
      else this.release(content.length);
    }
  }

  /** Delta `i`'s instructions, inflated again and applied to `base`: its result, held. */
  private async applyOne(i: number, base: Uint8Array, limit: number): Promise<Uint8Array> {
    const delta = await this.inflateAgain(i);
    const size = deltaResultSize(delta);
    // The pack's limit first, with parsePack's message; then memory, before the result is allocated.
    if (size > limit) throw this.tooBig();
    this.hold(size);
    const content = applyDelta(base, delta, size);
    this.release(delta.length);
    this.count_(content.length);
    return content;
  }

  /**
   * Entry `i`'s zlib data inflated again, held. An object that isn't a delta is read through the
   * blocks: resolving starts from those in pack order, so they are read in order. A delta's comes
   * from what the first pass kept, or is read again.
   */
  private async inflateAgain(i: number): Promise<Uint8Array> {
    const declared = this.declared[i]!;
    const len = this.zlen[i]!;
    this.hold(declared);
    if (this.codes[i] !== OFS_DELTA && this.codes[i] !== REF_DELTA) {
      const { out } = await inflateFrom(this.blocks, this.dataAt(i), declared);
      this.count_(declared);
      return out!;
    }
    const z = this.keptData(i) ?? (await this.reread(i));
    const data = z instanceof Uint8Array ? z : z.data;
    const inf = inflater(this.offsets[i]!, declared);
    inf.push(data);
    const { out } = inf.finish(len);
    if (!(z instanceof Uint8Array)) this.release(z.held);
    this.count_(declared);
    return out!;
  }

  /**
   * Entry `i`'s zlib data read again: from the window of the source last read, or a new window
   * from it on (exactly its range, held while in use, if larger than a window).
   */
  private async reread(i: number): Promise<Uint8Array | { data: Uint8Array; held: number }> {
    const at = this.dataAt(i);
    const len = this.zlen[i]!;
    const w = this.window;
    if (w && at >= w.start && at + len <= w.start + w.data.length) return w.data.subarray(at - w.start, at - w.start + len);
    const windowBytes = this.o.windowBytes ?? DEFAULTS.windowBytes;
    const n = len > windowBytes ? len : Math.max(len, Math.min(windowBytes, this.src.size - 20 - at));
    if (len > windowBytes) this.hold(len);
    this.read_(n, this.readWeight);
    const data = await this.src.read(at, n);
    if (data.length !== n) throw new Error(`short read of the pack at ${at}: ${data.length} of ${n} bytes`);
    if (len > windowBytes) return { data, held: len };
    this.window = { start: at, data };
    return data.subarray(0, len);
  }

  private async feed(at: number, size: number, onChunk: (chunk: Uint8Array) => void): Promise<void> {
    this.count_(size);
    await inflateFrom(this.blocks, at, size, onChunk);
  }

  /** Entry `i`'s content, held by the caller until it releases it (a cache spares most of the work). */
  private async content_(i: number, depth = 0): Promise<Uint8Array> {
    const hit = this.cache.get(i);
    if (hit) {
      this.hold(hit.length);
      return hit;
    }
    if (depth > 10_000) throw new Error("delta chain too deep");
    const code = this.codes[i]!;
    let content: Uint8Array;
    if (code === OFS_DELTA || code === REF_DELTA) {
      const b = this.baseOf[i]!;
      let base: Uint8Array;
      if (b >= 0) base = await this.content_(b, depth + 1);
      else {
        const oid = this.refBase.get(i);
        const ext = oid === undefined ? null : await this.externalBase(oid);
        if (!ext) throw new Error(`delta base of the object at ${this.offsets[i]} is missing`);
        base = ext.content;
      }
      content = await this.applyOne(i, base, this.maxBytes);
      this.release(base.length);
    } else content = await this.inflateAgain(i);
    this.cache.set(i, content);
    return content;
  }

  /** Entry `i`'s content: inflated, and rebuilt from its delta chain, again (a cache spares most of it). */
  async content(i: number): Promise<Uint8Array> {
    const c = await this.content_(i);
    this.release(c.length);
    return c;
  }

  /**
   * A base from outside the pack, read (and inflated) by `external`, held by the caller until it
   * releases it: kept in the cache like a resolved object, and each read counted against
   * `maxWork`, so many tiny deltas against one large stored object can't make the server read it
   * again without bound.
   */
  private async externalBase(oid: string): Promise<GitObject | null> {
    const type = this.externals.get(oid);
    const hit = type && this.cache.get(oid);
    if (hit) {
      this.hold(hit.length);
      return { type, content: hit };
    }
    // Its size is checked before it is read: a small delta can name a huge stored object.
    const base = (await this.o.external?.(oid, this.room())) ?? null;
    if (base === null) return null;
    if (typeof base === "number") throw tooMuchMemory(this.maxHeld);
    this.read_(0, this.readWeight);
    this.hold(base.content.length);
    this.count_(base.content.length);
    this.externals.set(oid, base.type);
    this.cache.set(oid, base.content);
    return base;
  }

  /** A base from outside the pack, to descend from: its content in a holder `descend` empties, and its type. */
  private async externalStart(oid: string): Promise<{ first: { base: Uint8Array | null }; typeCode: number } | null> {
    const ext = await this.externalBase(oid);
    return ext && { first: { base: ext.content }, typeCode: TYPE_CODES[ext.type] };
  }

  /**
   * Every delta's content again, for storing: rebuilt in the order resolving them took and from
   * the same empty caches, so it does exactly the work, holds exactly as much, reads exactly the
   * same and reaches exactly the chain depth that already passed in `open`. Nothing in it can go
   * over a limit `open` didn't, so a push can't be refused partway through being stored.
   */
  async replayDeltas(each: (entry: number, content: Uint8Array) => Promise<void>): Promise<void> {
    this.cache = new Lru(this.cacheBytes);
    this.window = null;
    this.blocks.clear();
    const after = { work: this.work, held: this.held, unpacked: this.unpacked };
    this.work = this.afterIndex.work;
    this.held = this.afterIndex.held;
    // Counted from here again, or it wouldn't yield until the work passed where `open` left off.
    this.yieldedAt = this.work;
    // Its reads were counted in `open`, and the limit on what the pack unpacks to checked there.
    this.readWeight = 0;
    this.unpacked = 0;
    const plan = this.plan;
    let at = 0;
    const next = () => {
      const b = plan[at]!;
      const kids = plan.slice(at + 2, at + 2 + plan[at + 1]!);
      at += 2 + kids.length;
      return { b, kids };
    };
    // A delta's own group comes right after it in the plan, as `open` took it.
    const takeKids = (kid: number) => (at < plan.length && plan[at] === kid ? next().kids : null);
    while (at < plan.length) {
      const { b, kids } = next();
      if (b >= 0) await this.descend({ base: await this.content_(b) }, b, this.typeCodes[b]!, kids, each, takeKids);
      else {
        const oid = this.externalOids[-1 - b]!;
        const start = await this.externalStart(oid);
        if (!start) throw new Error(`delta base ${oid} is missing`);
        await this.descend(start.first, EXTERNAL, start.typeCode, kids, each, takeKids);
      }
    }
    this.readWeight = 1;
    this.work = after.work;
    this.held = after.held;
    this.unpacked = after.unpacked;
  }

  /**
   * Every object in pack order, for storing. One that isn't a delta comes with its zlib data's place
   * in the pack (checked to inflate to exactly its content), to be stored as it is: neither inflated
   * nor compressed again.
   */
  *objects(): Generator<StreamedObject & { entry: number; deflated?: { at: number; length: number } }> {
    for (let i = 0; i < this.entries; i++) {
      const o = { oid: this.oidOf(i), type: this.typeOf(i), size: this.sizes[i]!, entry: i };
      if (this.codes[i] !== OFS_DELTA && this.codes[i] !== REF_DELTA) yield { ...o, deflated: { at: this.dataAt(i), length: this.zlen[i]! } };
      else yield o;
    }
  }

  /** `length` bytes of the pack from `at`, slice by slice (in order: these reads were counted in `open`). */
  async *slices(at: number, length: number): AsyncGenerator<Uint8Array> {
    for (const views = this.blocks.views(at, at + length); ; ) {
      this.inSlices = true;
      let next: IteratorResult<Uint8Array>;
      try {
        next = await views.next();
      } finally {
        this.inSlices = false;
      }
      if (next.done) return;
      yield next.value;
    }
  }

  oidOf(i: number): string {
    return toHex(this.oidBytes.subarray(i * 20, i * 20 + 20));
  }

  typeOf(i: number): ObjectType {
    return CODE_TYPES[this.typeCodes[i]!]!;
  }

  /** The pushed objects with these oids, as entry numbers (one pass over the index). */
  entriesOf(oids: ReadonlySet<string>): Map<string, number> {
    const found = new Map<string, number>();
    if (!oids.size) return found;
    for (let i = 0; i < this.entries; i++) {
      const oid = this.oidOf(i);
      if (oids.has(oid) && !found.has(oid)) found.set(oid, i);
    }
    return found;
  }
}

type Visit = (obj: StreamedObject, content: Uint8Array | null, feed: ChunkFeed | null) => void | Promise<void>;

const NONE = -1;
const EMPTY = new Uint8Array(0);
/** A delta's base from outside the pack. */
const EXTERNAL = -2;

function waitOn<K>(m: Map<K, number[]>, k: K, i: number) {
  const list = m.get(k);
  if (list) list.push(i);
  else m.set(k, [i]);
}
