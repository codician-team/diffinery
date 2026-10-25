import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Sha1, concat, deflate, packStream, parsePack, utf8, writePack, type PackEntryInput } from "../src/index.js";

describe("streamed packs", () => {
  it("incremental SHA-1 matches Node's for any split of the input", () => {
    const data = new Uint8Array(1000).map((_, i) => (i * 31 + 7) & 0xff);
    for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const want = createHash("sha1").update(data.subarray(0, len)).digest();
      for (const step of [1, 7, 64, 1000]) {
        const h = new Sha1();
        for (let i = 0; i < len; i += step) h.update(data.subarray(i, Math.min(len, i + step)));
        expect(Buffer.from(h.digest()).equals(want)).toBe(true);
      }
    }
  });

  it("is byte for byte the pack writePack builds, and reads one entry at a time", async () => {
    const entries: PackEntryInput[] = Array.from({ length: 50 }, (_, i) => {
      const content = utf8(`blob ${i}\n`.repeat(i * 100 + 1));
      return { type: "blob", size: content.length, deflated: deflate(content) };
    });
    let pulled = 0;
    async function* source() {
      for (const e of entries) {
        pulled++;
        yield e;
      }
    }
    const parts: Uint8Array[] = [];
    let mostAhead = 0;
    for await (const part of packStream(entries.length, source())) {
      parts.push(part);
      // Each entry is two parts (its header, then its data): the stream never runs ahead of its reader.
      mostAhead = Math.max(mostAhead, pulled - Math.floor(parts.length / 2));
    }
    expect(mostAhead).toBeLessThanOrEqual(1);
    const streamed = concat(parts);
    expect(streamed).toEqual(await writePack(entries));
    expect(await parsePack(streamed)).toHaveLength(50);
  });

  it("refuses a source that doesn't match the announced count", async () => {
    const one: PackEntryInput = { type: "blob", size: 1, deflated: deflate(utf8("x")) };
    const run = async (n: number, items: PackEntryInput[]) => {
      for await (const _ of packStream(n, (async function* () { yield* items; })())) void _;
    };
    await expect(run(2, [one])).rejects.toThrow(/announced 2 objects but has 1/);
    await expect(run(1, [one, one])).rejects.toThrow(/more than the 1 objects/);
  });
});
