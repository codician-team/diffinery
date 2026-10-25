import { inflateSync } from "node:zlib";
import pako from "pako";

// Reading an object up to NATIVE_MAX inflates it with the runtime's own zlib (node:zlib, native in
// Workers with nodejs_compat): about four times faster than pako on the small trees and commits that
// every page, diff and clone reads. Larger objects, pack entries (whose length is only known once
// inflated) and all compression stay on pako: compressed sizes are measured ahead of storing
// (pack-stream.ts), so what deflate and deflateChunks write must stay the same bytes.
const NATIVE_MAX = 1024 * 1024;

/** zlib-deflate (RFC 1950), the format git uses for loose objects and pack entries. Byte for byte what deflateChunks writes. */
export function deflate(data: Uint8Array): Uint8Array {
  return pako.deflate(data);
}

/**
 * The same zlib data as `deflate`, piece by piece as it is produced, so compressing a large object
 * holds it and a few small chunks, not a second copy of it compressed. Each chunk is new.
 */
export function* deflateChunks(data: Uint8Array): Generator<Uint8Array> {
  const d = new pako.Deflate();
  let out: Uint8Array[] = [];
  d.onData = (chunk) => void out.push(chunk as Uint8Array);
  const step = 256 * 1024;
  for (let at = 0; ; at += step) {
    const last = at + step >= data.length;
    d.push(data.subarray(at, Math.min(data.length, at + step)), last);
    if (d.err) throw new Error(`zlib error: ${d.msg}`);
    yield* out;
    out = [];
    if (last) return;
  }
}

// zlib only: pako also takes gzip unless `windowBits` is given, and git can't read gzip.
const ZLIB = { windowBits: 15 };

export function inflate(data: Uint8Array): Uint8Array {
  return pako.inflate(data, ZLIB);
}

/**
 * Inflate zlib data known to hold exactly `size` bytes. Past NATIVE_MAX it inflates into one buffer of
 * that size, no chunks joined at the end, so a large object never needs twice its memory.
 */
export function inflateSized(data: Uint8Array, size: number): Uint8Array {
  if (size > NATIVE_MAX) return inflateSizedPako(data, size);
  let out: Uint8Array;
  try {
    out = inflateSync(data, { maxOutputLength: nativeLimit(size) });
  } catch (e) {
    // Past the cap: pako, which stops at exactly `size`, tells an object that is too large apart from the runtime's rounding.
    if (e instanceof RangeError) return inflateSizedPako(data, size);
    throw new Error(`zlib error: ${(e as Error).message}`);
  }
  if (out.length > size) throw new Error(`object is larger than its recorded size (${size} bytes)`);
  if (out.length !== size) throw new Error(`object inflated to ${out.length} bytes, not its recorded ${size}`);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * The output cap for inflating `size` bytes natively. In Workers, node:zlib checks maxOutputLength
 * against the buffer it grows while inflating, not the bytes it wrote, so a cap of `size + 1` refused
 * many objects between 32 KiB and 200 KiB that fit exactly (Node's own zlib doesn't). Twice the size
 * plus 64 KiB leaves room for that growth and still bounds what a corrupt object can take.
 */
export function nativeLimit(size: number): number {
  return 2 * size + 64 * 1024;
}

function inflateSizedPako(data: Uint8Array, size: number): Uint8Array {
  const inflator = new pako.Inflate(ZLIB) as pako.Inflate & { ended: boolean };
  const out = new Uint8Array(size);
  let produced = 0;
  inflator.onData = (chunk) => {
    const c = chunk as Uint8Array;
    if (produced + c.length > size) throw new Error(`object is larger than its recorded size (${size} bytes)`);
    out.set(c, produced);
    produced += c.length;
  };
  inflator.push(data, true);
  if (inflator.err) throw new Error(`zlib error: ${inflator.msg}`);
  if (!inflator.ended || produced !== size) throw new Error(`object inflated to ${produced} bytes, not its recorded ${size}`);
  return out;
}

/**
 * Inflate one zlib stream that starts at `offset` inside `data`, and report how
 * many input bytes it consumed. Pack files concatenate zlib streams without
 * lengths, so the consumed count is how we find the next entry.
 */
export function inflateAt(data: Uint8Array, offset: number, expectedSize?: number): { out: Uint8Array; consumed: number } {
  const inflator = new pako.Inflate(ZLIB) as pako.Inflate & { ended: boolean };
  if (expectedSize !== undefined) {
    // Stop as soon as the output passes the size the pack declared, so a small zlib stream
    // can't be made to inflate to gigabytes.
    const keep = inflator.onData.bind(inflator);
    let produced = 0;
    inflator.onData = (chunk) => {
      produced += (chunk as Uint8Array).length;
      if (produced > expectedSize) throw new Error(`object at ${offset} is larger than its declared size (${expectedSize} bytes)`);
      keep(chunk);
    };
  }
  // Feed in bounded windows so a huge trailing buffer is not copied repeatedly.
  const window = Math.max(64 * 1024, expectedSize ? expectedSize + 1024 : 0);
  let pos = offset;
  while (!inflator.ended && pos < data.length) {
    const end = Math.min(data.length, pos + window);
    inflator.push(data.subarray(pos, end), false);
    if (inflator.err) throw new Error(`zlib error at ${offset}: ${inflator.msg}`);
    pos = end;
  }
  if (!inflator.ended) throw new Error(`truncated zlib stream at offset ${offset}`);
  const strm = (inflator as unknown as { strm: { avail_in: number } }).strm;
  const consumed = pos - offset - strm.avail_in;
  const out = inflator.result as Uint8Array;
  return { out: out ?? new Uint8Array(0), consumed };
}

/**
 * Like `inflateAt`, but hands each inflated chunk to `onChunk` instead of keeping it, so an object
 * much larger than memory allows can be hashed or scanned. Returns the input bytes consumed and the
 * bytes produced.
 */
export function inflateEach(data: Uint8Array, offset: number, onChunk: (chunk: Uint8Array) => void, expectedSize?: number): { consumed: number; produced: number } {
  const inflator = new pako.Inflate({ ...ZLIB, chunkSize: 256 * 1024 }) as pako.Inflate & { ended: boolean };
  let produced = 0;
  inflator.onData = (chunk) => {
    const c = chunk as Uint8Array;
    produced += c.length;
    if (expectedSize !== undefined && produced > expectedSize) throw new Error(`object at ${offset} is larger than its declared size (${expectedSize} bytes)`);
    onChunk(c);
  };
  const window = 1024 * 1024;
  let pos = offset;
  while (!inflator.ended && pos < data.length) {
    const end = Math.min(data.length, pos + window);
    inflator.push(data.subarray(pos, end), false);
    if (inflator.err) throw new Error(`zlib error at ${offset}: ${inflator.msg}`);
    pos = end;
  }
  if (!inflator.ended) throw new Error(`truncated zlib stream at offset ${offset}`);
  const strm = (inflator as unknown as { strm: { avail_in: number } }).strm;
  return { consumed: pos - offset - strm.avail_in, produced };
}
