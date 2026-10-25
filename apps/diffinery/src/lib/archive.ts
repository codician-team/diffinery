/**
 * Minimal tar and zip writers for source archives (zipball/tarball) and run
 * log bundles. Entries are buffered, which is fine for the size limits used.
 */

export type ArchiveEntry = { path: string; mode: string; content: Uint8Array } | { path: string; dir: true };

const enc = new TextEncoder();

// ---------------------------------------------------------------- tar (ustar + pax for long names)

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, "0")}\0`;
}

function tarHeader(name: string, size: number, mode: number, type: string, mtime: number, linkname = ""): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number, len: number) => h.set(enc.encode(s).subarray(0, len), off);
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(mtime, 12), 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put(linkname, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

function pad512(n: number): Uint8Array {
  return new Uint8Array((512 - (n % 512)) % 512);
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bytes = enc.encode(body).length;
  let len = bytes + 1;
  while (len !== bytes + String(len).length) len = bytes + String(len).length;
  return `${len}${body}`;
}

/** A pax global header carrying `comment` (git archive puts the commit id there). */
export function tarStart(mtime: number, comment?: string): Uint8Array[] {
  if (!comment) return [];
  const pax = enc.encode(paxRecord("comment", comment));
  return [tarHeader("pax_global_header", pax.length, 0o666, "g", mtime), pax, pad512(pax.length)];
}

/** The records for one entry: an optional pax header for long names, the header, the content and padding. */
export function tarEntry(e: ArchiveEntry, mtime: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  const isDir = "dir" in e;
  const isLink = !isDir && e.mode === "120000";
  const name = isDir && !e.path.endsWith("/") ? `${e.path}/` : e.path;
  const link = isLink ? new TextDecoder().decode(e.content) : "";
  if (enc.encode(name).length > 100 || enc.encode(link).length > 100) {
    const pax = enc.encode(paxRecord("path", name) + (link ? paxRecord("linkpath", link) : ""));
    parts.push(tarHeader("PaxHeader", pax.length, 0o644, "x", mtime), pax, pad512(pax.length));
  }
  if (isDir) parts.push(tarHeader(name, 0, 0o775, "5", mtime));
  else if (isLink) parts.push(tarHeader(name, 0, 0o777, "2", mtime, link));
  else parts.push(tarHeader(name, e.content.length, e.mode === "100755" ? 0o775 : 0o664, "0", mtime), e.content, pad512(e.content.length));
  return parts;
}

/**
 * The records before a regular file's `size` bytes, for writing its content as a stream (account exports):
 * the content follows, then {@link tarPadding}.
 */
export function tarFileHeader(path: string, size: number, mtime: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  if (enc.encode(path).length > 100) {
    const pax = enc.encode(paxRecord("path", path));
    parts.push(tarHeader("PaxHeader", pax.length, 0o644, "x", mtime), pax, pad512(pax.length));
  }
  parts.push(tarHeader(path, size, 0o644, "0", mtime));
  return parts;
}

/** The zeros that fill a file's last 512-byte block. */
export const tarPadding = (size: number): Uint8Array => pad512(size);

/** The two zero blocks that end a tar archive. */
export const tarEnd = (): Uint8Array => new Uint8Array(1024);

/** An uncompressed tar archive; gzip it with CompressionStream("gzip"). */
export function tar(entries: ArchiveEntry[], mtime: number, comment?: string): Uint8Array {
  return concat([...tarStart(mtime, comment), ...entries.flatMap((e) => tarEntry(e, mtime)), tarEnd()]);
}

// ---------------------------------------------------------------- zip

let CRC_TABLE: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function dosTime(seconds: number): { time: number; date: number } {
  const d = new Date(seconds * 1000);
  const year = Math.max(1980, d.getUTCFullYear());
  return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2), date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
}

/** Classic zip (no ZIP64) holds at most this many entries and 4 GiB. */
export const ZIP_MAX_ENTRIES = 0xffff;

/**
 * Writes a zip one entry at a time (deflate, UTF-8 names, unix modes), keeping
 * only the central directory in memory. Refuses what classic zip can't hold
 * rather than writing a corrupt archive.
 */
export class ZipWriter {
  private central: Uint8Array[] = [];
  private offset = 0;
  private count = 0;
  private readonly time: number;
  private readonly date: number;

  constructor(mtime: number) {
    ({ time: this.time, date: this.date } = dosTime(mtime));
  }

  async entry(e: ArchiveEntry): Promise<Uint8Array[]> {
    if (this.count >= ZIP_MAX_ENTRIES) throw new RangeError(`zip archives hold at most ${ZIP_MAX_ENTRIES} entries`);
    const isDir = "dir" in e;
    const name = enc.encode(isDir && !e.path.endsWith("/") ? `${e.path}/` : e.path);
    const raw = isDir ? new Uint8Array(0) : e.content;
    const deflated = raw.length ? await deflateRaw(raw) : raw;
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    if (this.offset + 30 + name.length + data.length > 0xffffffff) throw new RangeError("zip archives are limited to 4 GiB");
    const crc = crc32(raw);
    const unixMode = isDir ? 0o40775 : e.mode === "120000" ? 0o120777 : e.mode === "100755" ? 0o100775 : 0o100664;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, useDeflate ? 8 : 0, true);
    lh.setUint16(10, this.time, true);
    lh.setUint16(12, this.date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, raw.length, true);
    lh.setUint16(26, name.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, (3 << 8) | 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, useDeflate ? 8 : 0, true);
    ch.setUint16(12, this.time, true);
    ch.setUint16(14, this.date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, raw.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(38, ((unixMode << 16) | (isDir ? 0x10 : 0)) >>> 0, true);
    ch.setUint32(42, this.offset, true);
    this.central.push(new Uint8Array(ch.buffer), name);
    this.offset += 30 + name.length + data.length;
    this.count++;
    return [new Uint8Array(lh.buffer), name, data];
  }

  /** The central directory and end record; `comment` becomes the archive comment. */
  end(comment = ""): Uint8Array[] {
    const cd = concat(this.central);
    const note = enc.encode(comment).subarray(0, 0xffff);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.count, true);
    end.setUint16(10, this.count, true);
    end.setUint32(12, cd.length, true);
    end.setUint32(16, this.offset, true);
    end.setUint16(20, note.length, true);
    return [cd, new Uint8Array(end.buffer), note];
  }
}

/** A zip archive (deflate, UTF-8 names, unix modes); `comment` is stored as the archive comment. */
export async function zip(entries: ArchiveEntry[], mtime: number, comment = ""): Promise<Uint8Array> {
  const w = new ZipWriter(mtime);
  const parts: Uint8Array[] = [];
  for (const e of entries) parts.push(...(await w.entry(e)));
  parts.push(...w.end(comment));
  return concat(parts);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
