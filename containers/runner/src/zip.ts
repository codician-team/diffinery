import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

/**
 * Minimal ZIP writer and reader (deflate or store, ZIP64 when needed), for
 * artifacts in the format upload-artifact and download-artifact use.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array, prev = 0): number {
  const native = (zlib as unknown as { crc32?: (d: Uint8Array, v?: number) => number }).crc32;
  if (native) return native(buf, prev);
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const MAX32 = 0xffffffff;
/** Files at least this large get ZIP64 sizes up front (deflate can grow incompressible data a little). */
const ZIP64_THRESHOLD = 0xf0000000;

function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

export interface ZipEntry {
  /** File to read. */
  source: string;
  /** Path inside the archive, with `/` separators and no leading slash. */
  name: string;
}

/** Writes `entries` to `out`. Returns the archive's size and SHA-256 (hex). */
export async function writeZip(out: string, entries: ZipEntry[], level = 6): Promise<{ size: number; sha256: string }> {
  const fh = await open(out, "w");
  let pos = 0;
  const write = async (buf: Buffer) => {
    await fh.write(buf, 0, buf.length, pos);
    pos += buf.length;
  };
  const central: Buffer[] = [];
  try {
    for (const e of entries) {
      const st = await stat(e.source);
      const name = Buffer.from(e.name.replace(/^\/+/, ""), "utf8");
      const { date, time } = dosDateTime(st.mtime);
      const method = level === 0 ? 0 : 8;
      const big = st.size >= ZIP64_THRESHOLD;
      const offset = pos;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(big ? 45 : 20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(big ? 20 : 0, 28);
      await write(local);
      await write(name);
      const extraAt = pos;
      if (big) await write(Buffer.alloc(20));
      let crc = 0;
      let compressed = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          crc = crc32(chunk, crc);
          cb(null, chunk);
        },
      });
      const sink = async (source: AsyncIterable<Buffer>) => {
        for await (const chunk of source) {
          await write(chunk);
          compressed += chunk.length;
        }
      };
      if (method === 8) await pipeline(createReadStream(e.source), counter, zlib.createDeflateRaw({ level }), sink);
      else await pipeline(createReadStream(e.source), counter, sink);
      // Patch sizes and CRC into the local header.
      const fix = Buffer.alloc(12);
      fix.writeUInt32LE(crc >>> 0, 0);
      fix.writeUInt32LE(big ? MAX32 : compressed, 4);
      fix.writeUInt32LE(big ? MAX32 : st.size, 8);
      await fh.write(fix, 0, 12, offset + 14);
      if (big) {
        const z = Buffer.alloc(20);
        z.writeUInt16LE(0x0001, 0);
        z.writeUInt16LE(16, 2);
        z.writeBigUInt64LE(BigInt(st.size), 4);
        z.writeBigUInt64LE(BigInt(compressed), 12);
        await fh.write(z, 0, 20, extraAt);
      } else if (compressed > MAX32) {
        throw new Error(`${e.name} does not fit in a 32-bit zip entry`);
      }
      // Central directory record, with ZIP64 fields for whatever overflows.
      const z64: bigint[] = [];
      if (big) z64.push(BigInt(st.size), BigInt(compressed));
      if (offset >= MAX32) z64.push(BigInt(offset));
      const extra = Buffer.alloc(z64.length ? 4 + 8 * z64.length : 0);
      if (z64.length) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8 * z64.length, 2);
        z64.forEach((v, i) => extra.writeBigUInt64LE(v, 4 + 8 * i));
      }
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE((3 << 8) | (z64.length ? 45 : 20), 4); // made by Unix
      cd.writeUInt16LE(z64.length ? 45 : 20, 6);
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(method, 10);
      cd.writeUInt16LE(time, 12);
      cd.writeUInt16LE(date, 14);
      cd.writeUInt32LE(crc >>> 0, 16);
      cd.writeUInt32LE(big ? MAX32 : compressed, 20);
      cd.writeUInt32LE(big ? MAX32 : st.size, 24);
      cd.writeUInt16LE(name.length, 28);
      cd.writeUInt16LE(extra.length, 30);
      cd.writeUInt32LE((((0o100000 | (st.mode & 0o777)) << 16) >>> 0) as number, 38);
      cd.writeUInt32LE(offset >= MAX32 ? MAX32 : offset, 42);
      central.push(cd, name, extra);
    }
    const cdStart = pos;
    for (const b of central) await write(b);
    const cdSize = pos - cdStart;
    const zip64 = entries.length >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
    if (zip64) {
      const eocd64At = pos;
      const r = Buffer.alloc(56);
      r.writeUInt32LE(0x06064b50, 0);
      r.writeBigUInt64LE(44n, 4);
      r.writeUInt16LE((3 << 8) | 45, 12);
      r.writeUInt16LE(45, 14);
      r.writeBigUInt64LE(BigInt(entries.length), 24);
      r.writeBigUInt64LE(BigInt(entries.length), 32);
      r.writeBigUInt64LE(BigInt(cdSize), 40);
      r.writeBigUInt64LE(BigInt(cdStart), 48);
      await write(r);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeBigUInt64LE(BigInt(eocd64At), 8);
      loc.writeUInt32LE(1, 16);
      await write(loc);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(entries.length, 0xffff), 8);
    end.writeUInt16LE(Math.min(entries.length, 0xffff), 10);
    end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
    end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
    await write(end);
  } finally {
    await fh.close();
  }
  return { size: pos, sha256: await sha256File(out) };
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

interface CentralEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  mode: number;
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

async function centralDirectory(fh: FileHandle, fileSize: number): Promise<CentralEntry[]> {
  const tailLen = Math.min(fileSize, 22 + 0xffff);
  const tail = await readAt(fh, fileSize - tailLen, tailLen);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error("not a zip file (no end of central directory)");
  let count = tail.readUInt16LE(at + 10);
  let cdSize = tail.readUInt32LE(at + 12);
  let cdStart = tail.readUInt32LE(at + 16);
  const eocdPos = fileSize - tailLen + at;
  if (eocdPos >= 20) {
    const loc = await readAt(fh, eocdPos - 20, 20);
    if (loc.readUInt32LE(0) === 0x07064b50) {
      const r = await readAt(fh, Number(loc.readBigUInt64LE(8)), 56);
      if (r.readUInt32LE(0) !== 0x06064b50) throw new Error("corrupt zip64 end of central directory");
      count = Number(r.readBigUInt64LE(32));
      cdSize = Number(r.readBigUInt64LE(40));
      cdStart = Number(r.readBigUInt64LE(48));
    }
  }
  const cd = await readAt(fh, cdStart, cdSize);
  const out: CentralEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const e: CentralEntry = {
      name: cd.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
      method: cd.readUInt16LE(p + 10),
      crc: cd.readUInt32LE(p + 16),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      offset: cd.readUInt32LE(p + 42),
      mode: cd.readUInt8(p + 5) === 3 ? (cd.readUInt32LE(p + 38) >>> 16) & 0o777 : 0,
    };
    // ZIP64 extra: the fields that are 0xffffffff, in order.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.readUInt16LE(x);
      const len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (e.size === MAX32) (e.size = Number(cd.readBigUInt64LE(q))), (q += 8);
        if (e.compressedSize === MAX32) (e.compressedSize = Number(cd.readBigUInt64LE(q))), (q += 8);
        if (e.offset === MAX32) e.offset = Number(cd.readBigUInt64LE(q));
      }
      x += 4 + len;
    }
    out.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Entry names that would escape the destination are refused. */
export function safeEntryPath(dest: string, name: string): string {
  const clean = name.replace(/\\/g, "/");
  if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean) || clean.split("/").includes("..")) throw new Error(`refusing unsafe path in archive: ${name}`);
  const target = path.resolve(dest, clean);
  if (target !== path.resolve(dest) && !target.startsWith(path.resolve(dest) + path.sep)) throw new Error(`refusing unsafe path in archive: ${name}`);
  return target;
}

/** Extracts every entry of `zipFile` under `dest` (overwriting). Returns the number of files written. */
export async function extractZip(zipFile: string, dest: string): Promise<number> {
  const fh = await open(zipFile, "r");
  let files = 0;
  try {
    const entries = await centralDirectory(fh, (await fh.stat()).size);
    await mkdir(dest, { recursive: true });
    for (const e of entries) {
      const target = safeEntryPath(dest, e.name);
      if (e.name.endsWith("/")) {
        await mkdir(target, { recursive: true });
        continue;
      }
      if (e.method !== 0 && e.method !== 8) throw new Error(`unsupported compression method ${e.method} for ${e.name}`);
      const local = await readAt(fh, e.offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`corrupt local header for ${e.name}`);
      const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      await mkdir(path.dirname(target), { recursive: true });
      let crc = 0;
      const check = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          crc = crc32(chunk, crc);
          cb(null, chunk);
        },
      });
      const raw = e.compressedSize ? createReadStream(zipFile, { start, end: start + e.compressedSize - 1 }) : null;
      const out = createWriteStream(target);
      if (!raw) out.end();
      else if (e.method === 8) await pipeline(raw, zlib.createInflateRaw(), check, out);
      else await pipeline(raw, check, out);
      if (raw && crc >>> 0 !== e.crc >>> 0) throw new Error(`CRC mismatch for ${e.name}`);
      if (!raw) await new Promise<void>((r) => out.once("close", () => r()));
      if (e.mode & 0o111) await chmod(target, e.mode).catch(() => {});
      files++;
    }
  } finally {
    await fh.close();
  }
  return files;
}
