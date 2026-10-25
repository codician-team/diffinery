import { gunzipSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, gzip, tar, zip, type ArchiveEntry } from "../../src/lib/archive.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const MTIME = Date.UTC(2024, 4, 6, 7, 8, 10) / 1000;

const entries: ArchiveEntry[] = [
  { path: "repo-abc1234/", dir: true },
  { path: "repo-abc1234/README.md", mode: "100644", content: enc.encode("# hello\n".repeat(50)) },
  { path: "repo-abc1234/bin/run", mode: "100755", content: enc.encode("#!/bin/sh\necho hi\n") },
  { path: `repo-abc1234/${"deep/".repeat(30)}file.txt`, mode: "100644", content: enc.encode("long path") },
  { path: "repo-abc1234/link", mode: "120000", content: enc.encode("README.md") },
];

/** Read a tar archive's entries (ustar plus pax `path` records). */
function untar(data: Uint8Array): Array<{ name: string; type: string; mode: number; body: string; link: string }> {
  const out: Array<{ name: string; type: string; mode: number; body: string; link: string }> = [];
  let off = 0;
  let paxPath: string | null = null;
  while (off + 512 <= data.length) {
    const h = data.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, n: number) => dec.decode(h.subarray(a, a + n)).replace(/\0.*$/s, "");
    const size = parseInt(str(124, 12), 8);
    const type = str(156, 1);
    const body = data.subarray(off + 512, off + 512 + size);
    // Header checksum: the sum of all header bytes with the checksum field as spaces.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    expect(parseInt(str(148, 8), 8)).toBe(sum);
    if (type === "x") {
      paxPath = /\d+ path=(.*)\n/.exec(dec.decode(body))?.[1] ?? null;
    } else if (type !== "g") {
      out.push({ name: paxPath ?? str(0, 100), type, mode: parseInt(str(100, 8), 8), body: dec.decode(body), link: str(157, 100) });
      paxPath = null;
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Read a zip archive's central directory and inflate each entry. */
function unzip(data: Uint8Array): Array<{ name: string; body: string; unixMode: number }> {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = data.length - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: Array<{ name: string; body: string; unixMode: number }> = [];
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const attrs = v.getUint32(p + 38, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(data.subarray(p + 46, p + 46 + nlen));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = data.subarray(start, start + csize);
    const body = method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw;
    expect(crc32(body)).toBe(crc);
    out.push({ name, body: dec.decode(body), unixMode: attrs >>> 16 });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

describe("archives", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("writes a tar with modes, symlinks, long names and a commit comment", async () => {
    const t = tar(entries, MTIME, "abc1234");
    expect(t.length % 512).toBe(0);
    const files = untar(t);
    expect(files.map((f) => f.name)).toEqual(entries.map((e) => ("dir" in e && !e.path.endsWith("/") ? `${e.path}/` : e.path)));
    expect(files[1]!.body).toBe("# hello\n".repeat(50));
    // Like `git archive` (tar.umask 0002), which GitHub tarballs come from.
    expect(files[2]!.mode).toBe(0o775);
    expect(files[1]!.mode).toBe(0o664);
    expect(files[3]!.body).toBe("long path");
    expect(files[4]!.type).toBe("2");
    expect(files[4]!.link).toBe("README.md");
    // gzip round trip
    expect(new Uint8Array(gunzipSync(await gzip(t)))).toEqual(t);
  });

  it("writes a zip that inflates back to the same files", async () => {
    const z = await zip(entries, MTIME, "abc1234");
    const files = unzip(z);
    expect(files.map((f) => f.name)).toEqual(entries.map((e) => e.path));
    expect(files[1]!.body).toBe("# hello\n".repeat(50));
    expect(files[2]!.unixMode & 0o777).toBe(0o775);
    expect(files[4]!.unixMode & 0o170000).toBe(0o120000);
    expect(dec.decode(z.subarray(z.length - "abc1234".length))).toBe("abc1234");
  });
});
