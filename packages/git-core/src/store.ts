import {
  isTreeMode,
  parseCommit,
  parseTag,
  parseTree,
  serializeTree,
  type Commit,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from "./objects.js";

export interface ObjectReader {
  read(oid: string): Promise<GitObject | null>;
}

export interface ObjectWriter {
  /** Store an object and return its oid. Must be idempotent. */
  write(type: ObjectType, content: Uint8Array): Promise<string>;
}

export type ObjectStore = ObjectReader & ObjectWriter;

export class MissingObjectError extends Error {
  constructor(public oid: string) {
    super(`missing object ${oid}`);
  }
}

export async function mustRead(store: ObjectReader, oid: string, type?: ObjectType): Promise<GitObject> {
  const o = await store.read(oid);
  if (!o) throw new MissingObjectError(oid);
  if (type && o.type !== type) throw new Error(`object ${oid} is a ${o.type}, expected ${type}`);
  return o;
}

export async function readCommit(store: ObjectReader, oid: string): Promise<Commit> {
  return parseCommit((await mustRead(store, oid, "commit")).content);
}

export async function readTree(store: ObjectReader, oid: string): Promise<TreeEntry[]> {
  return parseTree((await mustRead(store, oid, "tree")).content);
}

/** Peel tags until a commit oid is reached. */
export async function peelToCommit(store: ObjectReader, oid: string): Promise<string> {
  for (let i = 0; i < 16; i++) {
    const o = await mustRead(store, oid);
    if (o.type === "commit") return oid;
    if (o.type !== "tag") throw new Error(`${oid} does not point to a commit`);
    oid = parseTag(o.content).object;
  }
  throw new Error("tag chain too deep");
}

/** Resolve a path inside a tree. Returns null when it does not exist. */
export async function resolvePath(store: ObjectReader, treeOid: string, path: string): Promise<TreeEntry | null> {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return { mode: "40000", name: "", oid: treeOid };
  let current = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const entries = await readTree(store, current);
    const entry = entries.find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return entry;
    if (!isTreeMode(entry.mode)) return null;
    current = entry.oid;
  }
  return null;
}

/** Walk all files of a tree recursively. */
export async function listFiles(store: ObjectReader, treeOid: string, prefix = ""): Promise<Array<TreeEntry & { path: string }>> {
  const out: Array<TreeEntry & { path: string }> = [];
  for (const e of await readTree(store, treeOid)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (isTreeMode(e.mode)) out.push(...(await listFiles(store, e.oid, path)));
    else out.push({ ...e, path });
  }
  return out;
}

// ---------------------------------------------------------------- history

/** Commits reachable from `tips`, newest first by committer date, stopping at `stop`. */
export async function walkCommits(
  store: ObjectReader,
  tips: readonly string[],
  opts: { stop?: Set<string>; limit?: number; firstParent?: boolean } = {},
): Promise<Array<{ oid: string; commit: Commit }>> {
  const seen = new Set<string>(opts.stop ?? []);
  const queue: Array<{ oid: string; commit: Commit }> = [];
  const out: Array<{ oid: string; commit: Commit }> = [];
  const push = async (oid: string) => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const o = await store.read(oid);
    if (!o || o.type !== "commit") return; // shallow / missing parents are tolerated
    queue.push({ oid, commit: parseCommit(o.content) });
  };
  for (const t of tips) await push(t);
  while (queue.length && (opts.limit === undefined || out.length < opts.limit)) {
    queue.sort((a, b) => b.commit.committer.timestamp - a.commit.committer.timestamp);
    const next = queue.shift()!;
    out.push(next);
    const parents = opts.firstParent ? next.commit.parents.slice(0, 1) : next.commit.parents;
    for (const p of parents) await push(p);
  }
  return out;
}

export async function isAncestor(store: ObjectReader, ancestor: string, descendant: string): Promise<boolean> {
  if (ancestor === descendant) return true;
  return (await commonAncestors(store, ancestor, descendant, ancestor)).includes(ancestor);
}

/** Best common ancestor of two commits (null if unrelated). */
export async function mergeBase(store: ObjectReader, a: string, b: string): Promise<string | null> {
  const found = await commonAncestors(store, a, b);
  if (found.length < 2) return found[0] ?? null;
  // More than one (criss-cross merges, or clock skew left one unmarked): drop those below another.
  for (const c of found) {
    let below = false;
    for (const other of found) if (other !== c && (await isAncestor(store, c, other))) below = true;
    if (!below) return c;
  }
  return found[0]!;
}

const FROM_A = 1;
const FROM_B = 2;
const STALE = 4;
const FOUND = 8;

/**
 * The common ancestors of `a` and `b` that no other found one descends from, newest first (git's
 * paint_down_to_common). Walks both histories newest first, marking which side reaches each commit, and
 * stops once every commit left to visit lies below a common one: the work is the commits since the
 * merge base, not the whole history. Dates only order the walk, so clock skew can leave an extra
 * (lower) common ancestor in the list but never misses the best one. Commits that can't be read
 * (shallow history) are left out. `stop`: return as soon as that commit is found common.
 */
async function commonAncestors(store: ObjectReader, a: string, b: string, stop?: string): Promise<string[]> {
  const commits = new Map<string, { time: number; parents: string[] } | null>();
  const load = async (oid: string) => {
    if (commits.has(oid)) return commits.get(oid)!;
    const o = await store.read(oid);
    const c = o && o.type === "commit" ? parseCommit(o.content) : null;
    const node = c ? { time: c.committer.timestamp, parents: c.parents } : null;
    commits.set(oid, node);
    return node;
  };
  const flags = new Map<string, number>();
  const queue = new CommitQueue();
  const paint = async (oid: string, f: number) => {
    const node = await load(oid);
    if (!node || ((flags.get(oid) ?? 0) & f) === f) return;
    flags.set(oid, (flags.get(oid) ?? 0) | f);
    queue.push(oid, node.time);
  };
  await paint(a, FROM_A);
  await paint(b, FROM_B);
  const found: string[] = [];
  while (queue.some((oid) => !((flags.get(oid) ?? 0) & STALE))) {
    const oid = queue.pop()!;
    let f = flags.get(oid)! & (FROM_A | FROM_B | STALE);
    if (f === (FROM_A | FROM_B)) {
      if (!(flags.get(oid)! & FOUND)) {
        flags.set(oid, flags.get(oid)! | FOUND);
        found.push(oid);
        if (oid === stop) return [oid];
      }
      f |= STALE;
    }
    for (const p of commits.get(oid)!.parents) await paint(p, f);
  }
  // One found later below another found one was marked stale on the way down.
  return found.filter((oid) => !(flags.get(oid)! & STALE)).sort((x, y) => commits.get(y)!.time - commits.get(x)!.time);
}

/** Commits to visit, newest first by committer date; equal dates in the order they were added. */
class CommitQueue {
  private heap: Array<{ oid: string; time: number; seq: number }> = [];
  private seq = 0;

  push(oid: string, time: number): void {
    const h = this.heap;
    h.push({ oid, time, seq: this.seq++ });
    let i = h.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!this.before(h[i]!, h[up]!)) break;
      [h[i], h[up]] = [h[up]!, h[i]!];
      i = up;
    }
  }

  pop(): string | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (top && last && h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.before(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.before(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top?.oid;
  }

  some(test: (oid: string) => boolean): boolean {
    return this.heap.some((e) => test(e.oid));
  }

  private before(x: { time: number; seq: number }, y: { time: number; seq: number }): boolean {
    return x.time !== y.time ? x.time > y.time : x.seq < y.seq;
  }
}

// ---------------------------------------------------------------- pack selection

async function markTree(store: ObjectReader, treeOid: string, into: Set<string>): Promise<void> {
  if (into.has(treeOid)) return;
  into.add(treeOid);
  for (const e of await readTree(store, treeOid)) {
    if (e.mode === "160000") continue; // submodule commit, not stored here
    if (isTreeMode(e.mode)) await markTree(store, e.oid, into);
    else into.add(e.oid);
  }
}

/**
 * Objects a client needs given what it wants and what it already has, in an
 * order suitable for a pack (commits, then trees and blobs, then tags).
 */
export interface FetchOptions {
  /** `deepen <n>`: keep at most n commits of history from each want. */
  depth?: number;
  /** `deepen-since <unix time>`: keep commits committed at or after this time. */
  since?: number;
  /** Commits the client reported as its shallow boundary (`shallow <oid>`). */
  clientShallow?: ReadonlySet<string>;
}

export interface FetchPlan {
  oids: string[];
  /** Commits that become the client's new shallow boundary. */
  shallow: string[];
  /** Client shallow commits whose parents are now being sent. */
  unshallow: string[];
}

/** Objects to send for a fetch: everything reachable from wants and not from haves. */
export async function objectsForFetch(store: ObjectReader, wants: readonly string[], haves: readonly string[]): Promise<string[]> {
  return (await planFetch(store, wants, haves)).oids;
}

export async function planFetch(store: ObjectReader, wants: readonly string[], haves: readonly string[], opts: FetchOptions = {}): Promise<FetchPlan> {
  const clientShallow = opts.clientShallow ?? new Set<string>();
  // History the client has, cut at its shallow boundary (it lacks those commits' parents).
  const haveCommits = new Set<string>();
  const haveTips: string[] = [];
  for (const h of haves) {
    const o = await store.read(h);
    if (o?.type !== "commit") continue;
    haveTips.push(h);
    const stack = [h];
    while (stack.length) {
      const cur = stack.pop()!;
      if (haveCommits.has(cur)) continue;
      const c = await store.read(cur);
      if (!c || c.type !== "commit") continue;
      haveCommits.add(cur);
      if (!clientShallow.has(cur)) stack.push(...parseCommit(c.content).parents);
    }
  }
  const tags: string[] = [];
  const commitTips: string[] = [];
  const extra: string[] = [];
  for (const w of wants) {
    let oid = w;
    for (let i = 0; i < 16; i++) {
      const o = await mustRead(store, oid);
      if (o.type === "tag") {
        tags.push(oid);
        oid = parseTag(o.content).object;
        continue;
      }
      if (o.type === "commit") commitTips.push(oid);
      else extra.push(oid);
      break;
    }
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  let commits: Array<{ oid: string; commit: Commit }>;
  if (opts.depth !== undefined || opts.since !== undefined) {
    // Breadth-first by depth so each commit gets its shortest distance from a want.
    const depthLimit = opts.depth ?? Number.POSITIVE_INFINITY;
    const since = opts.since ?? Number.NEGATIVE_INFINITY;
    const best = new Map<string, number>();
    const parsed = new Map<string, Commit>();
    let frontier = commitTips.map((oid) => ({ oid, depth: 1 }));
    const order: string[] = [];
    while (frontier.length) {
      const next: Array<{ oid: string; depth: number }> = [];
      for (const { oid, depth } of frontier) {
        if ((best.get(oid) ?? Number.POSITIVE_INFINITY) <= depth) continue;
        const o = await store.read(oid);
        if (!o || o.type !== "commit") continue;
        const commit = parsed.get(oid) ?? parseCommit(o.content);
        if (commit.committer.timestamp < since && depth > 1) continue;
        if (!best.has(oid)) order.push(oid);
        best.set(oid, depth);
        parsed.set(oid, commit);
        if (depth < depthLimit) for (const p of commit.parents) next.push({ oid: p, depth: depth + 1 });
      }
      frontier = next;
    }
    commits = [];
    for (const oid of order) {
      const commit = parsed.get(oid)!;
      const depth = best.get(oid)!;
      let cut = false;
      for (const p of commit.parents) {
        if (!best.has(p)) cut = true;
      }
      if (cut && commit.parents.length) shallow.push(oid);
      else if (clientShallow.has(oid) && commit.parents.length && depth < depthLimit) unshallow.push(oid);
      if (!haveCommits.has(oid) || unshallow.includes(oid)) commits.push({ oid, commit });
    }
  } else {
    commits = await walkCommits(store, commitTips, { stop: haveCommits });
  }

  // Trees and blobs the client already has: everything under the trees of commits it has at the edge.
  const uninteresting = new Set<string>();
  const boundary = new Set<string>(haveTips);
  for (const { commit } of commits) for (const p of commit.parents) if (haveCommits.has(p)) boundary.add(p);
  for (const b of boundary) await markTree(store, (await readCommit(store, b)).tree, uninteresting);

  const out: string[] = [];
  const added = new Set<string>();
  const add = (oid: string) => {
    if (!added.has(oid) && !uninteresting.has(oid)) {
      added.add(oid);
      out.push(oid);
    }
  };
  for (const { oid } of commits) if (!haveCommits.has(oid)) add(oid);
  const walkTree = async (treeOid: string) => {
    if (added.has(treeOid) || uninteresting.has(treeOid)) return;
    add(treeOid);
    for (const e of await readTree(store, treeOid)) {
      if (e.mode === "160000") continue;
      if (isTreeMode(e.mode)) await walkTree(e.oid);
      else add(e.oid);
    }
  };
  for (const { oid, commit } of commits) if (!haveCommits.has(oid)) await walkTree(commit.tree);
  for (const oid of extra) {
    const o = await mustRead(store, oid);
    if (o.type === "tree") await walkTree(oid);
    else add(oid);
  }
  for (const t of tags) add(t);
  return { oids: out, shallow, unshallow };
}

// ---------------------------------------------------------------- writing trees

export interface FileChange {
  path: string;
  /** New content; omit together with `delete: true` to remove the path. */
  content?: Uint8Array;
  /** Use an existing blob instead of content. */
  oid?: string;
  mode?: "100644" | "100755" | "120000";
  delete?: boolean;
}

/** Apply file changes to a tree (or an empty tree) and return the new tree oid. */
export async function applyChanges(store: ObjectStore, baseTree: string | null, changes: readonly FileChange[]): Promise<string> {
  type Node = { entries: Map<string, TreeEntry>; children: Map<string, Node>; base: string | null };
  const load = async (oid: string | null): Promise<Node> => ({
    entries: new Map(oid ? (await readTree(store, oid)).map((e) => [e.name, e]) : []),
    children: new Map(),
    base: oid,
  });
  const root = await load(baseTree);
  const dirFor = async (parts: string[]): Promise<Node> => {
    let node = root;
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) {
        const existing = node.entries.get(part);
        child = await load(existing && isTreeMode(existing.mode) ? existing.oid : null);
        node.children.set(part, child);
      }
      node = child;
    }
    return node;
  };
  for (const ch of changes) {
    const parts = ch.path.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error(`invalid path: ${ch.path}`);
    const dir = await dirFor(parts);
    if (ch.delete) {
      dir.entries.delete(name);
      dir.children.delete(name);
      continue;
    }
    const oid = ch.oid ?? (await store.write("blob", ch.content ?? new Uint8Array(0)));
    dir.children.delete(name);
    dir.entries.set(name, { mode: ch.mode ?? dir.entries.get(name)?.mode ?? "100644", name, oid });
  }
  const finish = async (node: Node): Promise<string | null> => {
    for (const [name, child] of node.children) {
      const oid = await finish(child);
      if (oid) node.entries.set(name, { mode: "40000", name, oid });
      else node.entries.delete(name);
    }
    if (node.entries.size === 0) return null;
    return store.write("tree", serializeTree([...node.entries.values()]));
  };
  return (await finish(root)) ?? (await store.write("tree", new Uint8Array(0)));
}
