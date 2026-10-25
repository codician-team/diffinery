import { describe, expect, it } from "vitest";
import { DELIM, FLUSH, MemoryStore, pkt, deflate, parsePack, readPkts, serializeCommit, serializeTree, utf8, concat, type ObjectType } from "@diffinery/git-core";
import { handleUploadPackV2 } from "../../src/git/protocol.js";

const BLOB = 200 * 1024;

/** A repository with one commit of `n` incompressible blobs, whose raw reads are counted. */
async function repo(n: number) {
  const mem = new MemoryStore();
  const blobs: string[] = [];
  for (let i = 0; i < n; i++) {
    const content = new Uint8Array(BLOB);
    for (let j = 0; j < BLOB; j += 65536) crypto.getRandomValues(content.subarray(j, j + 65536));
    blobs.push(await mem.write("blob", content));
  }
  const tree = await mem.write("tree", serializeTree(blobs.map((oid, i) => ({ name: `f${i}`, mode: "100644", oid }))));
  const sig = { name: "T", email: "t@example.com", timestamp: 1, tz: "+0000" };
  const commit = await mem.write("commit", serializeCommit({ tree, parents: [], author: sig, committer: sig, message: "m\n" }));
  let reads = 0;
  const store = Object.assign(mem, {
    has: (oid: string) => mem.objects.has(oid),
    async readRaw(oid: string) {
      const o = mem.objects.get(oid);
      if (!o) return null;
      reads++;
      return { type: o.type as ObjectType, size: o.content.length, deflated: deflate(o.content) };
    },
  });
  return { store, commit, reads: () => reads };
}

const fetchRequest = (want: string) => concat([pkt("command=fetch\n"), DELIM, pkt(`want ${want}\n`), pkt("done\n"), FLUSH]);

describe("upload-pack streams the pack", () => {
  it("sends each object as it is read, in side-band packets, never the whole pack at once", async () => {
    const { store, commit, reads } = await repo(40);
    const chunks: Uint8Array[] = [];
    let sent = 0;
    let mostAhead = 0;
    await handleUploadPackV2(fetchRequest(commit), { store, refs: [{ name: "refs/heads/main", oid: commit }], headTarget: "refs/heads/main" }, async (b) => {
      expect(b.length).toBeLessThanOrEqual(65520 + 1024);
      chunks.push(b);
      sent += b.length;
      // Objects read but not yet handed to the client: one, plus the side-band packet being filled.
      mostAhead = Math.max(mostAhead, (reads() - 2) * BLOB - sent);
    });
    expect(mostAhead).toBeLessThan(2 * BLOB);
    // What the client got is a complete, valid pack of all 42 objects.
    const pack: Uint8Array[] = [];
    let inPack = false;
    for (const p of readPkts(concat(chunks)).pkts) {
      if (p.type !== "data") continue;
      if (!inPack) inPack = new TextDecoder().decode(p.data) === "packfile\n";
      else if (p.data[0] === 1) pack.push(p.data.subarray(1));
    }
    expect(await parsePack(concat(pack))).toHaveLength(42);
  });
});
