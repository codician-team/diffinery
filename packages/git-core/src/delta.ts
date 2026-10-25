/** The size a delta says its result has (after its base's size), read from its header. */
export function deltaResultSize(delta: Uint8Array): number {
  let i = 0;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    let c: number;
    do {
      if (i >= delta.length) throw new Error("truncated delta header");
      c = delta[i++]!;
      result += (c & 0x7f) * 2 ** shift;
      shift += 7;
    } while (c & 0x80);
    return result;
  };
  varint();
  return varint();
}

/** Apply a git delta (as found in OFS_DELTA / REF_DELTA pack entries) to a base. */
export function applyDelta(base: Uint8Array, delta: Uint8Array, maxSize = Infinity): Uint8Array {
  let i = 0;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    let c: number;
    do {
      c = delta[i++]!;
      result += (c & 0x7f) * 2 ** shift;
      shift += 7;
    } while (c & 0x80);
    return result;
  };
  const srcSize = varint();
  if (srcSize !== base.length) throw new Error(`delta base size mismatch: ${srcSize} != ${base.length}`);
  const dstSize = varint();
  if (dstSize > maxSize) throw new Error(`delta result of ${dstSize} bytes is larger than the ${maxSize} bytes allowed`);
  const out = new Uint8Array(dstSize);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++]!;
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      if (op & 0x01) off |= delta[i++]!;
      if (op & 0x02) off |= delta[i++]! << 8;
      if (op & 0x04) off |= delta[i++]! << 16;
      if (op & 0x08) off = (off | (delta[i++]! << 24)) >>> 0;
      if (op & 0x10) size |= delta[i++]!;
      if (op & 0x20) size |= delta[i++]! << 8;
      if (op & 0x40) size |= delta[i++]! << 16;
      if (size === 0) size = 0x10000;
      if (off + size > base.length || o + size > dstSize) throw new Error("delta copy out of range");
      out.set(base.subarray(off, off + size), o);
      o += size;
    } else if (op > 0) {
      if (o + op > dstSize || i + op > delta.length) throw new Error("delta insert out of range");
      out.set(delta.subarray(i, i + op), o);
      i += op;
      o += op;
    } else {
      throw new Error("invalid delta opcode 0");
    }
  }
  if (o !== dstSize) throw new Error(`delta produced ${o} bytes, expected ${dstSize}`);
  return out;
}
