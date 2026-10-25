import { StreamedPack, fromUtf8, inflateSized, type ExternalLookup, type ObjectType, type PackSource, type PackedObject } from "@diffinery/git-core";
import { INLINE_LIMIT, type RepoObjectStore } from "../repo/objects.js";
import { fsckGitmodules, fsckObjects, fsckSize, fsckTree } from "./fsck.js";
import { parseReceivePackHead, type ReceiveRequest } from "./protocol.js";
import { scanFeed, scanForSecrets, type SecretHit } from "./secret-scan.js";

/**
 * What a push brings, as receive-pack checks and stores it: `fsck`, then the secret scan, then
 * `write` once every check passed (nothing is stored before, like git's quarantine).
 */
export interface PushContents {
  /** The pack's size, for the storage quota. */
  bytes: number;
  fsck(): string | null;
  /** Credentials found; opted-out ones go to `marked`. */
  scan(marked: SecretHit[]): SecretHit[];
  /** Whether the push stores anything the repository doesn't have. */
  anyNew(): boolean;
  write(): Promise<void>;
}

const scanned = (type: string) => type === "blob" || type === "commit" || type === "tag";

/**
 * Storing order. A push can be cut off while it is stored (a deploy, a limit), and git then pushes
 * again asking which commits the server has (push.negotiate): it won't send what such a commit
 * reaches. So files and trees are stored first, and commits after them, each after its parents,
 * then tags: a commit that is stored never lacks its files or history.
 */
const last = (type: string) => type === "commit" || type === "tag";

/** A commit's parents, from its header. */
export function commitParents(content: Uint8Array): string[] {
  const end = headerEnd(content);
  const out: string[] = [];
  for (const line of fromUtf8(content.subarray(0, end)).split("\n")) {
    const m = /^parent ([0-9a-f]{40})$/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Where a commit's header ends (the first empty line). */
function headerEnd(content: Uint8Array): number {
  for (let i = 0; i + 1 < content.length; i++) if (content[i] === 10 && content[i + 1] === 10) return i;
  return content.length;
}

/** `items` reordered so each commit comes after those of its parents that are among them; tags last. */
export function historyOrder<T extends { oid: string; type: string }>(items: T[], parents: (t: T) => string[]): T[] {
  const commits = new Map(items.filter((t) => t.type === "commit").map((t) => [t.oid, t]));
  const out: T[] = [];
  const entered = new Set<string>();
  for (const start of commits.values()) {
    if (entered.has(start.oid)) continue;
    entered.add(start.oid);
    // Depth first without recursion (a history can be thousands of commits deep).
    const stack: Array<{ item: T; ps: string[]; i: number }> = [{ item: start, ps: parents(start), i: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      if (top.i < top.ps.length) {
        const p = commits.get(top.ps[top.i++]!);
        if (p && !entered.has(p.oid)) {
          entered.add(p.oid);
          stack.push({ item: p, ps: parents(p), i: 0 });
        }
        continue;
      }
      out.push(top.item);
      stack.pop();
    }
  }
  for (const t of items) if (t.type !== "commit") out.push(t);
  return out;
}

/** A pack parsed whole in memory (pushes up to 16 MB). */
export function packedContents(store: RepoObjectStore, objects: PackedObject[], bytes: number): PushContents {
  return {
    bytes,
    fsck: () => fsckObjects(objects),
    // The objects themselves, not copies: a large blob is scanned from its compressed bytes.
    scan: (marked) => scanForSecrets(objects.filter((o) => scanned(o.type)), marked),
    anyNew: () => objects.some((o) => !store.has(o.oid)),
    write: async () => {
      const put = async (o: PackedObject) => {
        if (o.deflated) await store.writeDeflated(o.oid, o.type, o.size!, o.deflated);
        // An object that isn't a delta keeps the zlib data it came with: compressing it again cost
        // CPU on every push for the same bytes.
        else if (o.zlib) await store.writeDeflated(o.oid, o.type, o.content.length, o.zlib, o.content);
        else await store.writeKnown(o.oid, o.type, o.content);
      };
      for (const o of objects) if (!last(o.type)) await put(o);
      for (const o of historyOrder(objects.filter((o) => last(o.type)), (o) => commitParents(o.content))) await put(o);
    },
  };
}

/**
 * Bases a thin pack's deltas name, from the repository: what reading one takes is checked first,
 * so a small delta against a huge stored object is refused before it is inflated.
 */
export function repositoryBases(store: RepoObjectStore): ExternalLookup {
  return async (oid, maxBytes) => {
    const cost = store.readCost(oid);
    if (cost === null) return null;
    return cost > maxBytes ? cost : store.read(oid);
  };
}

/** A pack already in memory, as a source to unpack in pieces. */
export function memorySource(pack: Uint8Array): PackSource {
  return { size: pack.length, read: async (offset, length) => pack.subarray(offset, offset + length) };
}

/** Bytes of an R2 object from `start` on, read in ranges. */
function r2Source(bucket: R2Bucket, key: string, start: number, size: number): PackSource {
  return {
    size,
    read: async (offset, length) => {
      const o = await bucket.get(key, { range: { offset: start + offset, length } });
      if (!o) throw new Error("the push's data is missing; push again");
      return new Uint8Array(await o.arrayBuffer());
    },
  };
}

/** Where a push staged in R2 has its commands, push options and pack. */
export async function readStagedHead(bucket: R2Bucket, key: string, size: number): Promise<{ req: ReceiveRequest; packOffset: number }> {
  // Commands for many refs can run long; read more until they end.
  for (let n = 64 * 1024; ; n *= 4) {
    const o = await bucket.get(key, { range: { offset: 0, length: Math.min(n, size) } });
    if (!o) throw new Error("the push's data is missing; push again");
    const head = parseReceivePackHead(new Uint8Array(await o.arrayBuffer()));
    if (head) return head;
    if (n >= size) throw new Error("truncated push: its commands never end");
    if (n >= 16 * 1024 * 1024) throw new Error("the push names too many refs; split it into smaller pushes");
  }
}

class FsckRefusal extends Error {}

/**
 * A pack staged in R2, unpacked without holding it whole (see StreamedPack): every object is
 * checked as it is resolved, and read again from R2 to be stored.
 */
export function stagedContents(store: RepoObjectStore, bucket: R2Bucket, key: string, packOffset: number, packBytes: number, o: { largeObjectBytes: number; maxHeldBytes?: number }): Promise<PushContents> {
  return streamedContents(store, r2Source(bucket, key, packOffset, packBytes), o);
}

/** A pack unpacked from `src` in pieces, one object at a time (see StreamedPack). */
export async function streamedContents(store: RepoObjectStore, src: PackSource, o: { largeObjectBytes: number; maxHeldBytes?: number }): Promise<PushContents> {
  const packBytes = src.size;
  const hits: SecretHit[] = [];
  const opted: SecretHit[] = [];
  const gitmodules = new Set<string>();
  let refusal: string | null = null;
  let pack: StreamedPack | null = null;
  try {
    const p = (pack = await StreamedPack.open(src, { external: repositoryBases(store), largeObjectBytes: o.largeObjectBytes, maxHeldBytes: o.maxHeldBytes, writesOver: INLINE_LIMIT }, async (obj, content, feed) => {
      const why = obj.type === "tree" ? fsckTree(obj.oid, content!, gitmodules) : content ? fsckSize(obj.oid, obj.type, content.length) : null;
      if (why) throw new FsckRefusal(why);
      if (scanned(obj.type)) {
        if (content) scanForSecrets([{ oid: obj.oid, content }], opted).forEach((h) => hits.push(h));
        else await scanFeed(obj.oid, feed!, hits, opted);
      }
    }));
    // Like fsckObjects: a `.gitmodules` blob in this push that a pushed tree names is checked too.
    for (const [oid, entry] of p.entriesOf(gitmodules)) {
      const why = fsckGitmodules(oid, await p.content(entry));
      if (why) throw new FsckRefusal(why);
    }
  } catch (e) {
    if (!(e instanceof FsckRefusal)) throw e;
    refusal = e.message;
  }
  const refused = refusal;
  const objects = () => (pack ? pack.objects() : []);
  return {
    // What storing adds, at most: a delta is stored compressed on its own, not as in the pack.
    bytes: pack ? (pack as StreamedPack).storedBytes : packBytes,
    fsck: () => refused,
    scan: (marked) => {
      marked.push(...opted);
      return hits;
    },
    anyNew: () => {
      for (const x of objects()) if (!store.has(x.oid)) return true;
      return false;
    },
    write: async () => {
      const p = pack!;
      // Commits and tags wait (see `last`): their parents are noted, and a rebuilt one kept.
      const later: Array<{ oid: string; type: string; parents: string[]; slice?: { at: number; length: number; size: number }; content?: Uint8Array }> = [];
      const readSlices = async (at: number, length: number) => {
        const out = new Uint8Array(length);
        let n = 0;
        for await (const s of p.slices(at, length)) {
          out.set(s, n);
          n += s.length;
        }
        return out;
      };
      // An object that isn't a delta is stored from its zlib data in the pack, as it is.
      for (const x of p.objects()) {
        if (!x.deflated || store.has(x.oid)) continue;
        if (last(x.type)) {
          const content = x.type === "commit" ? inflateSized(await readSlices(x.deflated.at, x.deflated.length), x.size) : null;
          later.push({ oid: x.oid, type: x.type, parents: content ? commitParents(content) : [], slice: { ...x.deflated, size: x.size } });
          continue;
        }
        await store.writeDeflatedSlices(x.oid, x.type as ObjectType, x.size, x.deflated.length, () => p.slices(x.deflated!.at, x.deflated!.length));
      }
      // Deltas are rebuilt exactly as the checks rebuilt them, so no limit can stop the push
      // halfway through being stored. Not kept in the store's memory cache: the push would fill
      // it for nothing.
      await p.replayDeltas(async (entry, content) => {
        const oid = p.oidOf(entry);
        if (store.has(oid)) return;
        const type = p.typeOf(entry);
        if (last(type)) later.push({ oid, type, parents: type === "commit" ? commitParents(content) : [], content });
        else await store.writeKnown(oid, type, content, false, p.zlibSizeOf(entry));
      });
      for (const c of historyOrder(later, (c) => c.parents)) {
        if (c.content) await store.writeKnown(c.oid, c.type as ObjectType, c.content, false);
        else await store.writeDeflatedSlices(c.oid, c.type as ObjectType, c.slice!.size, c.slice!.length, () => p.slices(c.slice!.at, c.slice!.length));
      }
    },
  };
}
