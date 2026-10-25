import { describe, expect, it } from "vitest";
import { MemoryStore, isAncestor, mergeBase, serializeCommit, type Signature } from "../src/index.js";

const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A random history: each commit has one or two earlier parents (a few roots), and committer dates that may run backwards. */
async function history(seed: number, n: number, skew: boolean, label = "c") {
  let x = seed;
  const rand = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const store = new MemoryStore();
  const oids: string[] = [];
  const parents: number[][] = [];
  for (let i = 0; i < n; i++) {
    const ps = i === 0 || rand() < 0.03 ? [] : [Math.floor(rand() * i)];
    if (ps.length && i > 2 && rand() < 0.3) ps.push(Math.floor(rand() * i));
    const uniq = [...new Set(ps)];
    parents.push(uniq);
    const time = 1_700_000_000 + i * 60 + (skew ? Math.floor((rand() - 0.5) * 3600) : 0);
    const sig: Signature = { name: "t", email: "t@example.com", timestamp: time, timezone: "+0000" };
    oids.push(await store.write("commit", serializeCommit({ tree: TREE, parents: uniq.map((p) => oids[p]!), author: sig, committer: sig, message: `${label}${i}\n` })));
  }
  const reach: Set<number>[] = [];
  for (let i = 0; i < n; i++) reach.push(new Set([i, ...parents[i]!.flatMap((p) => [...reach[p]!])]));
  return { store, oids, reach };
}

describe("merge base", () => {
  it("is a best common ancestor, the only one when there is one, on random histories with and without clock skew", async () => {
    let checked = 0;
    for (const skew of [false, true]) {
      for (let seed = 1; seed <= 12; seed++) {
        const { store, oids, reach } = await history(seed, 120, skew);
        for (let k = 0; k < 40; k++) {
          const a = (seed * 31 + k * 17) % oids.length;
          const b = (seed * 7 + k * 53 + 11) % oids.length;
          const common = [...reach[a]!].filter((c) => reach[b]!.has(c));
          const best = common.filter((c) => !common.some((o) => o !== c && reach[o]!.has(c)));
          const got = await mergeBase(store, oids[a]!, oids[b]!);
          if (!best.length) expect(got).toBeNull();
          else if (best.length === 1) expect(got).toBe(oids[best[0]!]);
          else expect(best.map((c) => oids[c])).toContain(got);
          expect(await isAncestor(store, oids[a]!, oids[b]!)).toBe(reach[b]!.has(a));
          expect(await isAncestor(store, oids[b]!, oids[a]!)).toBe(reach[a]!.has(b));
          checked++;
        }
      }
    }
    expect(checked).toBe(960);
  });

  it("handles the same commit, missing commits and unrelated histories", async () => {
    const { store, oids } = await history(5, 10, false);
    expect(await mergeBase(store, oids[3]!, oids[3]!)).toBe(oids[3]);
    expect(await isAncestor(store, oids[3]!, oids[3]!)).toBe(true);
    const missing = "0".repeat(39) + "1";
    expect(await mergeBase(store, missing, oids[3]!)).toBeNull();
    expect(await mergeBase(store, missing, missing)).toBeNull();
    expect(await isAncestor(store, missing, oids[3]!)).toBe(false);
    const other = await history(9, 5, false, "other");
    for (const [oid, o] of other.store.objects) store.objects.set(oid, o);
    expect(await mergeBase(store, oids[9]!, other.oids[4]!)).toBeNull();
  });

  it("reads only the commits since the merge base, not the whole history", async () => {
    const { store, oids } = await history(3, 400, false);
    let reads = 0;
    const counted = { read: (oid: string) => (reads++, store.read(oid)) };
    // Two branches a few commits off the newest one.
    const tip = oids[399]!;
    const sig: Signature = { name: "t", email: "t@example.com", timestamp: 1_800_000_000, timezone: "+0000" };
    const a = await store.write("commit", serializeCommit({ tree: TREE, parents: [tip], author: sig, committer: sig, message: "a\n" }));
    const b = await store.write("commit", serializeCommit({ tree: TREE, parents: [tip], author: sig, committer: sig, message: "b\n" }));
    expect(await mergeBase(counted, a, b)).toBe(tip);
    expect(reads).toBeLessThan(20);
  });
});
