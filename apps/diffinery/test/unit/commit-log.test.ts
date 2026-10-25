import { describe, expect, it } from "vitest";
import { MemoryStore, serializeCommit, serializeTree } from "@diffinery/git-core";
import { RepoDO } from "../../src/repo/RepoDO.js";
import { MAX_LOG_DEPTH } from "../../src/repo/types.js";

/** A linear history of `n` commits, newest last; returns the store and the tip. */
async function history(n: number) {
  const store = new MemoryStore();
  const tree = await store.write("tree", serializeTree([]));
  let tip: string | null = null;
  for (let i = 0; i < n; i++) {
    const sig = { name: "a", email: "a@x.test", timestamp: 1_700_000_000 + i, timezone: "+0000" };
    tip = await store.write("commit", serializeCommit({ tree, parents: tip ? [tip] : [], author: sig, committer: sig, message: `c${i}\n` }));
  }
  return { store, tip: tip! };
}

/** RepoDO.log run against a bare object store, with `resolve` answering the tip for any revision. */
function logOf(store: MemoryStore, tip: string, counter?: { reads: number }) {
  const counted = counter ? { read: (oid: string) => (counter.reads++, store.read(oid)) } : store;
  const self = { store: counted, resolve: async () => tip };
  return (opts: { limit?: number; skip?: number }) => RepoDO.prototype.log.call(self as unknown as RepoDO, "HEAD", opts);
}

describe("commit listing depth", () => {
  it("pages through history as usual", async () => {
    const { store, tip } = await history(12);
    const log = logOf(store, tip);
    expect((await log({ limit: 5 })).map((c) => c.message.trim())).toEqual(["c11", "c10", "c9", "c8", "c7"]);
    expect((await log({ limit: 5, skip: 10 })).map((c) => c.message.trim())).toEqual(["c1", "c0"]);
    expect(await log({ limit: 5, skip: 20 })).toEqual([]);
  });

  it("lists nothing past MAX_LOG_DEPTH and never walks further than it", async () => {
    const { store, tip } = await history(MAX_LOG_DEPTH + 50);
    const counter = { reads: 0 };
    const log = logOf(store, tip, counter);
    expect(await log({ limit: 100, skip: MAX_LOG_DEPTH })).toEqual([]);
    expect(await log({ limit: 100, skip: 10_000_000 })).toEqual([]);
    expect(counter.reads).toBe(0);
    // The last page inside the window is cut at the window's end, so it shows no further page.
    const last = await log({ limit: 101, skip: MAX_LOG_DEPTH - 100 });
    expect(last).toHaveLength(100);
    expect(counter.reads).toBeLessThanOrEqual(MAX_LOG_DEPTH + 1);
  });
});
