import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MemoryStore,
  applyChanges,
  deflate,
  diffTrees,
  fileDiff,
  mergeBase,
  mergeText,
  mergeTrees,
  objectsForFetch,
  parseCommit,
  parsePack,
  readCommit,
  serializeCommit,
  utf8,
  writePack,
  fromUtf8,
  listFiles,
  hashObject,
  inflate,
} from "../src/index.js";
import { randomBytes } from "node:crypto";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x" } });

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gc-"));
  git(dir, "init", "-q", "-b", "main");
  const big = Array.from({ length: 400 }, (_, i) => `line ${i} of a fairly long file to encourage deltas`).join("\n");
  writeFileSync(join(dir, "a.txt"), big);
  mkdirSync(join(dir, "src/deep"), { recursive: true });
  writeFileSync(join(dir, "src/deep/x.js"), "console.log(1)\n");
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  writeFileSync(join(dir, "a.txt"), big.replace("line 200", "LINE 200"));
  git(dir, "commit", "-qam", "second");
  git(dir, "tag", "-a", "v1", "-m", "release");
  return dir;
}

async function loadAll(dir: string): Promise<{ store: MemoryStore; expected: string[] }> {
  const expected = git(dir, "rev-list", "--objects", "--all").toString().trim().split("\n").map((l) => l.split(" ")[0]!);
  expected.push(git(dir, "rev-parse", "v1").toString().trim());
  const pack = execFileSync("git", ["pack-objects", "--stdout", "--delta-base-offset"], { cwd: dir, input: expected.join("\n") + "\n" });
  const objs = await parsePack(new Uint8Array(pack));
  const store = new MemoryStore();
  for (const o of objs) await store.write(o.type, o.content);
  return { store, expected };
}

describe("packfiles", () => {
  it("parses a real git pack with ofs deltas and verifies all oids", async () => {
    const dir = makeRepo();
    const { store, expected } = await loadAll(dir);
    for (const oid of expected) expect(store.objects.has(oid), oid).toBe(true);
  });

  it("hands over the zlib data of every object that isn't a delta, which inflates to its content", async () => {
    const dir = makeRepo();
    const expected = git(dir, "rev-list", "--objects", "--all").toString().trim().split("\n").map((l) => l.split(" ")[0]!);
    const pack = execFileSync("git", ["pack-objects", "--stdout", "--delta-base-offset"], { cwd: dir, input: expected.join("\n") + "\n" });
    const objs = await parsePack(new Uint8Array(pack));
    const whole = objs.filter((o) => o.zlib);
    expect(whole.length).toBeGreaterThan(0);
    // The second commit's a.txt is a delta against the first: rebuilt, so it has no zlib data of its own.
    expect(objs.some((o) => !o.zlib)).toBe(true);
    for (const o of whole) {
      expect(inflate(o.zlib!)).toEqual(o.content);
      expect(await hashObject(o.type, inflate(o.zlib!))).toBe(o.oid);
    }
  });

  it("keeps large blobs compressed, with the same oids, and still resolves deltas against them", async () => {
    const dir = makeRepo();
    const expected = git(dir, "rev-list", "--objects", "--all").toString().trim().split("\n").map((l) => l.split(" ")[0]!);
    const pack = new Uint8Array(execFileSync("git", ["pack-objects", "--stdout", "--delta-base-offset"], { cwd: dir, input: expected.join("\n") + "\n" }));
    const plain = await parsePack(pack);
    const lean = await parsePack(pack, undefined, { largeObjectBytes: 1000 });
    expect(lean.map((o) => o.oid).sort()).toEqual(plain.map((o) => o.oid).sort());
    const large = lean.filter((o) => o.deflated);
    // a.txt in both commits: one is stored whole, the other is a delta against it.
    expect(large.length).toBeGreaterThanOrEqual(1);
    for (const o of large) {
      const want = plain.find((p) => p.oid === o.oid)!;
      expect(o.size).toBe(want.content.length);
      expect(inflate(o.deflated!)).toEqual(want.content);
      expect(o.content).toEqual(want.content);
    }
    for (const o of lean) expect(await hashObject(o.type, o.content)).toBe(o.oid);
  });

  it("parses a pack over 16 MB holding one large blob", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-"));
    git(dir, "init", "-q", "-b", "main");
    const data = randomBytes(17 * 1024 * 1024);
    writeFileSync(join(dir, "big.bin"), data);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "big");
    const expected = git(dir, "rev-list", "--objects", "--all").toString().trim().split("\n").map((l) => l.split(" ")[0]!);
    const pack = new Uint8Array(execFileSync("git", ["pack-objects", "--stdout"], { cwd: dir, input: expected.join("\n") + "\n", maxBuffer: 64 * 1024 * 1024 }));
    expect(pack.length).toBeGreaterThan(16 * 1024 * 1024);
    const objs = await parsePack(pack, undefined, { largeObjectBytes: 4 * 1024 * 1024 });
    const blob = objs.find((o) => o.type === "blob")!;
    expect(blob.oid).toBe(git(dir, "rev-parse", "HEAD:big.bin").toString().trim());
    expect(blob.size).toBe(data.length);
    expect(Buffer.from(inflate(blob.deflated!)).equals(data)).toBe(true);
    // A damaged pack still fails its checksum.
    pack[pack.length - 30]! ^= 1;
    await expect(parsePack(pack, undefined, { largeObjectBytes: 4 * 1024 * 1024 })).rejects.toThrow(/checksum/);
  });

  it("writes packs that git accepts", async () => {
    const dir = makeRepo();
    const { store } = await loadAll(dir);
    const head = git(dir, "rev-parse", "HEAD").toString().trim();
    const oids = await objectsForFetch(store, [head], []);
    const pack = await writePack(
      await Promise.all(oids.map(async (oid) => {
        const o = (await store.read(oid))!;
        return { type: o.type, size: o.content.length, deflated: deflate(o.content) };
      })),
    );
    const out = mkdtempSync(join(tmpdir(), "gc-out-"));
    git(out, "init", "-q", "--bare");
    const p = join(out, "objects/pack/pack-x.pack");
    writeFileSync(p, pack);
    git(out, "index-pack", p);
    git(out, "update-ref", "refs/heads/main", head);
    git(out, "fsck", "--strict", "main");
  });

  it("sends only new objects on incremental fetch", async () => {
    const dir = makeRepo();
    const { store } = await loadAll(dir);
    const head = git(dir, "rev-parse", "HEAD").toString().trim();
    const first = git(dir, "rev-parse", "HEAD~1").toString().trim();
    const oids = await objectsForFetch(store, [head], [first]);
    // new commit + new root tree + new a.txt blob
    expect(oids.length).toBe(3);
  });
});

describe("trees, diffs and merges", () => {
  it("builds commits from file changes and diffs them", async () => {
    const store = new MemoryStore();
    const t1 = await applyChanges(store, null, [
      { path: "README.md", content: utf8("hello\n") },
      { path: "src/a.ts", content: utf8("a\n") },
    ]);
    const t2 = await applyChanges(store, t1, [
      { path: "src/a.ts", content: utf8("a\nb\n") },
      { path: "README.md", delete: true },
      { path: "src/new/b.ts", content: utf8("x") },
    ]);
    const changes = await diffTrees(store, t1, t2);
    expect(changes.map((c) => `${c.status}:${c.path}`)).toEqual(["deleted:README.md", "modified:src/a.ts", "added:src/new/b.ts"]);
    const d = await fileDiff(store, changes[1]!);
    expect(d.additions).toBe(1);
    expect((await listFiles(store, t2)).map((f) => f.path)).toEqual(["src/a.ts", "src/new/b.ts"]);
  });

  it("merges non-overlapping line edits and detects conflicts", () => {
    const base = "a\nb\nc\nd\ne\n";
    expect(mergeText(base, "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n")).toBe("A\nb\nc\nd\nE\n");
    expect(mergeText(base, "a\nX\nc\nd\ne\n", "a\nY\nc\nd\ne\n")).toBeNull();
    expect(mergeText(base, "a\nb\nc\nd\ne\nf\n", "z\na\nb\nc\nd\ne\n")).toBe("z\na\nb\nc\nd\ne\nf\n");
  });

  it("three-way merges trees and finds the merge base", async () => {
    const store = new MemoryStore();
    const sig = { name: "T", email: "t@x", timestamp: 1, timezone: "+0000" };
    const commit = async (tree: string, parents: string[], ts: number) =>
      store.write("commit", serializeCommit({ tree, parents, author: { ...sig, timestamp: ts }, committer: { ...sig, timestamp: ts }, message: "m\n" }));
    const tb = await applyChanges(store, null, [{ path: "f.txt", content: utf8("1\n2\n3\n4\n5\n") }, { path: "g.txt", content: utf8("g") }]);
    const base = await commit(tb, [], 1);
    const to = await applyChanges(store, tb, [{ path: "f.txt", content: utf8("one\n2\n3\n4\n5\n") }, { path: "new.txt", content: utf8("n") }]);
    const ours = await commit(to, [base], 2);
    const tt = await applyChanges(store, tb, [{ path: "f.txt", content: utf8("1\n2\n3\n4\nfive\n") }, { path: "g.txt", delete: true }]);
    const theirs = await commit(tt, [base], 3);
    expect(await mergeBase(store, ours, theirs)).toBe(base);
    const res = await mergeTrees(store, tb, to, tt);
    expect(res.conflicts).toEqual([]);
    const files = await listFiles(store, res.tree!);
    expect(files.map((f) => f.path)).toEqual(["f.txt", "new.txt"]);
    expect(fromUtf8((await store.read(files[0]!.oid))!.content)).toBe("one\n2\n3\n4\nfive\n");
    expect(parseCommit((await store.read(ours))!.content).parents).toEqual([base]);
    expect((await readCommit(store, theirs)).tree).toBe(tt);
  });
});
