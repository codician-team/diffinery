import { describe, expect, it } from "vitest";
import { ZIP_MAX_ENTRIES, ZipWriter, concat, tar, tarEnd, tarEntry, tarStart, zip, type ArchiveEntry } from "../../src/lib/archive.js";

const enc = new TextEncoder();
const MTIME = Date.UTC(2024, 0, 2, 3, 4, 6) / 1000;
const entries: ArchiveEntry[] = [
  { path: "r-abc/", dir: true },
  { path: "r-abc/a.txt", mode: "100644", content: enc.encode("hello\n".repeat(100)) },
  { path: `r-abc/${"long/".repeat(30)}b`, mode: "100755", content: enc.encode("#!/bin/sh\n") },
  { path: "r-abc/l", mode: "120000", content: enc.encode("a.txt") },
];

describe("streaming archive writers", () => {
  it("write the same tar piece by piece as in one go", () => {
    const pieces = [...tarStart(MTIME, "abc"), ...entries.flatMap((e) => tarEntry(e, MTIME)), tarEnd()];
    expect(concat(pieces)).toEqual(tar(entries, MTIME, "abc"));
  });

  it("write the same zip piece by piece as in one go", async () => {
    const w = new ZipWriter(MTIME);
    const parts: Uint8Array[] = [];
    for (const e of entries) parts.push(...(await w.entry(e)));
    parts.push(...w.end("abc"));
    expect(concat(parts)).toEqual(await zip(entries, MTIME, "abc"));
  });

  it("refuse more entries than classic zip can hold instead of writing a broken archive", async () => {
    const w = new ZipWriter(MTIME);
    const dir: ArchiveEntry = { path: "d/", dir: true };
    for (let i = 0; i < ZIP_MAX_ENTRIES; i++) await w.entry(dir);
    await expect(w.entry(dir)).rejects.toBeInstanceOf(RangeError);
  });
});
