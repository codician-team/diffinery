import { ByteWriter, equalBytes, fromUtf8, toHex } from "./bytes.js";
import { applyDelta, deltaResultSize } from "./delta.js";
import { CODE_TYPES, TYPE_CODES, hashObject, objectHeader, type GitObject, type ObjectType } from "./objects.js";
import { Sha1, sha1 } from "./sha1.js";
import { inflate, inflateAt, inflateEach } from "./zlib.js";

const OFS_DELTA = 6;
const REF_DELTA = 7;

export interface PackedObject extends GitObject {
  oid: string;
  /**
   * Set on a large blob parsed with `largeObjectBytes`: its zlib data as it sits in the pack (a view,
   * not a copy) and its size. Its `content` is then inflated afresh on every read, so callers that
   * can work from `deflated` should.
   */
  deflated?: Uint8Array;
  size?: number;
  /**
   * Set on an object that isn't a delta (and not a large blob, which has `deflated`): its zlib data as
   * it sits in the pack (a view, not a copy), which a store that keeps objects zlib-compressed can
   * keep as is instead of compressing `content` again.
   */
  zlib?: Uint8Array;
}

/** A large blob kept compressed: `content` inflates it when something needs the bytes. */
function largeBlob(oid: string, size: number, deflated: Uint8Array): PackedObject {
  const obj = { oid, type: "blob" as const, size, deflated } as PackedObject;
  Object.defineProperty(obj, "content", { enumerable: true, get: () => inflate(deflated) });
  return obj;
}

/** Packs bigger than this get their checksum computed in slices, so the pack is never copied for hashing. */
const SLICED_CHECKSUM_BYTES = 16 * 1024 * 1024;

/** A delta entry waiting for its base: its instructions (inflated), freed once applied. */
interface DeltaEntry {
  offset: number;
  data: Uint8Array;
}

/**
 * A REF_DELTA base from the repository (a thin pack's), or null when it has no such object. Given
 * what the unpack may still hold, it checks what reading the object would take before reading it,
 * and returns that number of bytes instead when it is more, so a small delta against a huge stored
 * object is refused before the object is inflated.
 */
export type ExternalLookup = (oid: string, maxBytes: number) => Promise<GitObject | number | null>;

/** What unpacking refuses when the pack inflates to more than `maxBytes` in all. */
export function tooBigUnpacked(maxBytes: number): Error {
  const mib = maxBytes / (1024 * 1024);
  return new Error(`pack unpacks to more than ${Number.isInteger(mib) ? `${mib} MiB` : `${maxBytes} bytes`}; split it into smaller pushes`);
}

/** Unpacking would hold more than it may. */
export class TooMuchMemory extends Error {}

/** What unpacking refuses when it would hold more than `maxHeld` bytes. */
export function tooMuchMemory(maxHeld: number): TooMuchMemory {
  return new TooMuchMemory(`pack needs more than ${Math.floor(maxHeld / (1024 * 1024))} MiB of memory to unpack; split it into smaller pushes`);
}

/** What a pack may unpack to by default (object contents and delta instructions together). */
export const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

/**
 * What unpacking a pack may hold in memory by default: the contents it returns (large blobs kept
 * compressed aside), delta instructions until they are applied, a base while its deltas are applied,
 * and OBJECT_OVERHEAD for each object. A repository's Durable Object has 128 MB, the pack included.
 */
export const MAX_HELD_BYTES = 80 * 1024 * 1024;

/**
 * Roughly what one object costs to hold beyond its content: the object and its oid, the Uint8Array
 * and its buffer, and its entries in the indexes below. Measured at about 740 bytes in Node for
 * 100,000 three-byte blobs.
 */
const OBJECT_OVERHEAD = 768;

const EMPTY = new Uint8Array(0);

/**
 * Parse a packfile and fully resolve every object (including deltas).
 * `external` resolves REF_DELTA bases that are not inside the pack (thin packs).
 * Packs come from clients, so unpacking is bounded: each object stops inflating at its
 * declared size, the whole pack may unpack to at most `maxBytes`, and what it holds in memory
 * may come to at most `maxHeldBytes`. Deltas are resolved in one pass from their bases.
 */
export async function parsePack(
  pack: Uint8Array,
  external?: ExternalLookup,
  opts: { maxBytes?: number; largeObjectBytes?: number; maxHeldBytes?: number } = {},
): Promise<PackedObject[]> {
  if (pack.length < 32 || fromUtf8(pack.subarray(0, 4)) !== "PACK") throw new Error("not a packfile");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = view.getUint32(8);

  const trailer = pack.subarray(pack.length - 20);
  let digest: Uint8Array;
  if (pack.length > SLICED_CHECKSUM_BYTES) {
    const h = new Sha1();
    for (let i = 0; i < pack.length - 20; i += 1024 * 1024) h.update(pack.subarray(i, Math.min(i + 1024 * 1024, pack.length - 20)));
    digest = h.digest();
  } else digest = await sha1(pack.subarray(0, pack.length - 20));
  if (!equalBytes(trailer, digest)) throw new Error("pack checksum mismatch");

  const maxBytes = opts.maxBytes ?? MAX_UNPACKED_BYTES;
  const maxHeld = opts.maxHeldBytes ?? MAX_HELD_BYTES;
  const large = opts.largeObjectBytes ?? Infinity;
  let unpacked = 0;
  let held = 0;
  const work = (n: number) => {
    if (unpacked + n > maxBytes) throw tooBigUnpacked(maxBytes);
    unpacked += n;
  };
  const hold = (n: number) => {
    if (held + n > maxHeld) throw tooMuchMemory(maxHeld);
    held += n;
  };

  const results: PackedObject[] = [];
  /** Each result's offset in the pack, to find the OFS_DELTAs against it. */
  const offsets: number[] = [];
  const childrenByOffset = new Map<number, DeltaEntry[]>();
  const childrenByOid = new Map<string, DeltaEntry[]>();
  const waitFor = <K>(m: Map<K, DeltaEntry[]>, k: K, d: DeltaEntry) => {
    const list = m.get(k);
    if (list) list.push(d);
    else m.set(k, [d]);
  };
  const add = (offset: number, obj: PackedObject) => {
    results.push(obj);
    offsets.push(offset);
  };

  let pos = 12;
  for (let n = 0; n < count; n++) {
    const offset = pos;
    let c = pack[pos++]!;
    const typeCode = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) {
      c = pack[pos++]!;
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === OFS_DELTA) {
      c = pack[pos++]!;
      let ofs = c & 0x7f;
      while (c & 0x80) {
        c = pack[pos++]!;
        ofs = (ofs + 1) * 128 + (c & 0x7f);
      }
      baseOffset = offset - ofs;
    } else if (typeCode === REF_DELTA) {
      baseOid = toHex(pack.subarray(pos, pos + 20));
      pos += 20;
    } else if (!CODE_TYPES[typeCode]) {
      throw new Error(`bad object type ${typeCode} at ${offset}`);
    }
    if (typeCode === TYPE_CODES.blob && size >= large) {
      // Hash it as it inflates and keep only the compressed bytes, so memory never holds it whole.
      work(size);
      hold(OBJECT_OVERHEAD);
      const h = new Sha1().update(objectHeader("blob", size));
      const { consumed, produced } = inflateEach(pack, pos, (chunk) => h.update(chunk), size);
      if (produced !== size) throw new Error(`size mismatch at ${offset}: ${produced} != ${size}`);
      add(offset, largeBlob(toHex(h.digest()), size, pack.subarray(pos, pos + consumed)));
      pos += consumed;
      continue;
    }
    // Reserved at the declared size before inflating, so a declared size the budget can't hold is refused up front.
    work(size);
    hold(size + OBJECT_OVERHEAD);
    const { out, consumed } = inflateAt(pack, pos, size);
    if (out.length !== size) throw new Error(`size mismatch at ${offset}: ${out.length} != ${size}`);
    const zlib = pack.subarray(pos, pos + consumed);
    pos += consumed;
    if (baseOffset !== undefined) waitFor(childrenByOffset, baseOffset, { offset, data: out });
    else if (baseOid !== undefined) waitFor(childrenByOid, baseOid, { offset, data: out });
    else {
      const type = CODE_TYPES[typeCode]!;
      add(offset, { oid: await hashObject(type, out), type, content: out, zlib });
    }
  }
  if (pos !== pack.length - 20) throw new Error("trailing garbage in pack");

  /** Applies every delta waiting for `base` (in the pack at `offset`, or -1 when it came from the repository). */
  const resolveDeltasOf = async (base: GitObject & { oid: string; deflated?: Uint8Array; size?: number }, offset: number) => {
    const byOffset = offset >= 0 ? childrenByOffset.get(offset) : undefined;
    const byOid = childrenByOid.get(base.oid);
    if (!byOffset && !byOid) return;
    if (byOffset) childrenByOffset.delete(offset);
    if (byOid) childrenByOid.delete(base.oid);
    // A large blob kept compressed is inflated once for all its deltas, and held while they are applied.
    const inflated = base.deflated ? (base.size ?? 0) : 0;
    if (inflated) {
      work(inflated);
      hold(inflated);
    }
    const content = base.content;
    for (const d of [...(byOffset ?? []), ...(byOid ?? [])]) {
      // A result the pack's limit allows but memory can't hold is refused as memory, before it is allocated.
      const size = deltaResultSize(d.data);
      if (size > maxBytes - unpacked) throw tooBigUnpacked(maxBytes);
      if (size > maxHeld - held + d.data.length) throw tooMuchMemory(maxHeld);
      const result = applyDelta(content, d.data, Math.min(maxBytes - unpacked, maxHeld - held + d.data.length));
      work(result.length);
      held -= d.data.length;
      hold(result.length);
      d.data = EMPTY;
      add(d.offset, { oid: await hashObject(base.type, result), type: base.type, content: result });
    }
    held -= inflated;
  };
  // Each object, as it is added, has its deltas applied: one pass, whatever order the pack lists them in.
  let next = 0;
  const drain = async () => {
    for (; next < results.length; next++) await resolveDeltasOf(results[next]!, offsets[next]!);
  };
  await drain();
  // REF_DELTA bases that aren't in the pack (thin packs) come from the repository, each read once.
  if (external) {
    for (const oid of [...childrenByOid.keys()]) {
      if (!childrenByOid.has(oid)) continue;
      const base = await external(oid, maxHeld - held);
      if (base === null) continue;
      if (typeof base === "number") throw tooMuchMemory(maxHeld);
      work(base.content.length);
      hold(base.content.length);
      await resolveDeltasOf({ oid, ...base }, -1);
      held -= base.content.length;
      await drain();
    }
  }
  const unresolved = [...childrenByOid.keys(), ...[...childrenByOffset.keys()].map((o) => `@${o}`)];
  if (unresolved.length) throw new Error(`unresolvable delta base(s): ${unresolved.join(", ")}`);
  return results;
}

export interface PackEntryInput {
  type: ObjectType;
  /** Uncompressed size of the object content. */
  size: number;
  /** zlib-deflated object content. */
  deflated: Uint8Array;
}

function writeEntryHeader(w: ByteWriter, typeCode: number, size: number) {
  w.write(entryHeader(typeCode, size));
}

/** A pack entry's type and size header, as its own few bytes. */
function entryHeader(typeCode: number, size: number): Uint8Array {
  const out: number[] = [];
  let c = (typeCode << 4) | (size & 15);
  size = Math.floor(size / 16);
  while (size > 0) {
    out.push(c | 0x80);
    c = size & 0x7f;
    size = Math.floor(size / 128);
  }
  out.push(c);
  return Uint8Array.from(out);
}

/**
 * The same packfile as `writePack`, produced piece by piece as `entries` yields them, so a clone of a
 * large repository never holds the whole pack: only the entry being written.
 */
export async function* packStream(count: number, entries: AsyncIterable<PackEntryInput>): AsyncGenerator<Uint8Array> {
  const hash = new Sha1();
  const head = new ByteWriter();
  head.write(new TextEncoder().encode("PACK"));
  head.uint32(2);
  head.uint32(count);
  let written = 0;
  const out = (b: Uint8Array) => (hash.update(b), b);
  yield out(head.bytes());
  for await (const e of entries) {
    if (++written > count) throw new Error(`pack has more than the ${count} objects it announced`);
    yield out(entryHeader(TYPE_CODES[e.type], e.size));
    yield out(e.deflated);
  }
  if (written !== count) throw new Error(`pack announced ${count} objects but has ${written}`);
  yield hash.digest();
}

/** Build a version 2 packfile of undeltified objects from pre-deflated content. */
export async function writePack(entries: readonly PackEntryInput[]): Promise<Uint8Array> {
  const w = new ByteWriter();
  w.write(new TextEncoder().encode("PACK"));
  w.uint32(2);
  w.uint32(entries.length);
  for (const e of entries) {
    writeEntryHeader(w, TYPE_CODES[e.type], e.size);
    w.write(e.deflated);
  }
  const body = w.bytes();
  w.write(await sha1(body));
  return w.bytes();
}
