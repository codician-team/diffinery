import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflate, hashObject, inflate, parsePack, utf8 } from "@diffinery/git-core";
import { commitParents, historyOrder, memorySource, packedContents, repositoryBases, streamedContents } from "../../src/git/push-contents.js";
import { RepoObjectStore } from "../../src/repo/objects.js";
import { REPO_SCHEMA, migrateRepoSchema } from "../../src/repo/schema.js";

/** A minimal SqlStorage over node:sqlite with the repository schema (RETURNING gives rows back too). */
function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  db.exec(REPO_SCHEMA);
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      const rows = /^\s*select|returning/i.test(query) ? stmt.all(...(bindings as never[])) : (stmt.run(...(bindings as never[])), []);
      return { toArray: () => rows, one: () => rows[0] } as unknown as SqlStorageCursor<Record<string, SqlStorageValue>>;
    },
  } as unknown as SqlStorage;
  migrateRepoSchema(sql);
  return sql;
}

function setup() {
  const sql = sqlStorage();
  const r2 = new Map<string, Uint8Array>();
  const bucket = {
    put: async (key: string, body: Uint8Array | ReadableStream) => void r2.set(key, body instanceof ReadableStream ? new Uint8Array(await new Response(body).arrayBuffer()) : body),
    get: async (key: string) => {
      const v = r2.get(key);
      return v ? { arrayBuffer: async () => v.slice().buffer } : null;
    },
  } as unknown as R2Bucket;
  let added = 0;
  const store = new RepoObjectStore(sql, bucket, "r1", () => added++);
  return { sql, r2, store, added: () => added };
}

describe("reading objects for a clone", () => {
  it("reads them in batches, in the order asked, from SQLite and R2", async () => {
    const { sql, store } = setup();
    const oids: string[] = [];
    for (let i = 0; i < 250; i++) oids.push(await store.write("blob", utf8(`object ${i}\n`)));
    // Two large ones in R2 among them, and one asked for twice.
    oids.splice(40, 0, await store.write("blob", new Uint8Array(randomBytes(700 * 1024))));
    oids.splice(180, 0, await store.write("blob", new Uint8Array(randomBytes(600 * 1024))));
    oids.push(oids[3]!);
    const want = await Promise.all(oids.map((o) => store.readRaw(o)));
    let queries = 0;
    const exec = sql.exec.bind(sql);
    sql.exec = ((q: string, ...b: unknown[]) => (queries++, exec(q, ...(b as never[])))) as typeof sql.exec;
    const got = [];
    for await (const raw of store.readRawAll(oids)) got.push(raw);
    expect(got.length).toBe(oids.length);
    got.forEach((raw, i) => {
      expect(raw.type).toBe(want[i]!.type);
      expect(raw.size).toBe(want[i]!.size);
      expect(Buffer.from(raw.deflated).equals(Buffer.from(want[i]!.deflated)), `object ${i}`).toBe(true);
    });
    // Two queries per hundred objects, not one per object.
    expect(queries).toBeLessThanOrEqual(6);
  });

  it("keeps a batch's inline data under its cap, and stops at an object that isn't stored", async () => {
    const { sql, store } = setup();
    // 400 KB objects (incompressible, kept inline): ten of them pass the 4 MiB cap.
    const oids: string[] = [];
    for (let i = 0; i < 12; i++) oids.push(await store.write("blob", new Uint8Array(randomBytes(400 * 1024))));
    const sizes: number[] = [];
    const exec = sql.exec.bind(sql);
    sql.exec = ((q: string, ...b: unknown[]) => (/SELECT oid, data/.test(q) && sizes.push(b.length), exec(q, ...(b as never[])))) as typeof sql.exec;
    let n = 0;
    for await (const raw of store.readRawAll(oids)) n += raw.size > 0 ? 1 : 0;
    expect(n).toBe(12);
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(10);
    const missing = "0".repeat(40);
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const raw of store.readRawAll([oids[0]!, missing, oids[1]!])) seen.push(raw.size);
      })(),
    ).rejects.toThrow(`missing object ${missing}`);
    expect(seen.length).toBe(1);
  });
});

describe("git object storage accounting", () => {
  it("keeps a running total of the compressed bytes stored, counting each object once", async () => {
    const { store, r2, added } = setup();
    expect(store.sizeBytes()).toBe(0);
    const text = utf8("hello\n".repeat(1000));
    await store.write("blob", text);
    await store.write("blob", text);
    expect(store.sizeBytes()).toBe(deflate(text).length);
    expect(added()).toBe(1);
    // Large objects go to R2 and count what R2 keeps.
    const big = new Uint8Array(randomBytes(700 * 1024));
    await store.write("blob", big);
    expect(r2.size).toBe(1);
    expect(store.sizeBytes()).toBe(deflate(text).length + deflate(big).length);
    // A pushed object stored from its zlib data counts that.
    const small = utf8("pushed\n");
    await store.writeDeflated(await hashObject("blob", small), "blob", small.length, deflate(small));
    expect(store.sizeBytes()).toBe(deflate(text).length + deflate(big).length + deflate(small).length);
    expect(added()).toBe(3);
  });

  it("adds up a repository from before the total was kept, and again after objects were deleted", async () => {
    const { sql, store } = setup();
    // Rows as older code wrote them: no stored size; an R2 object counts its inflated size.
    sql.exec("INSERT INTO objects (oid, type, size, data, r2) VALUES ('a', 3, 10, ?, 0)", new Uint8Array(4));
    sql.exec("INSERT INTO objects (oid, type, size, data, r2) VALUES ('b', 3, 900000, NULL, 1)");
    expect(store.sizeBytes()).toBe(4 + 900000);
    await store.write("blob", utf8("new\n"));
    expect(store.sizeBytes()).toBe(4 + 900000 + deflate(utf8("new\n")).length);
    // A purge deletes objects, then has the total added up again.
    sql.exec("DELETE FROM objects WHERE oid = 'b'");
    store.recount();
    expect(store.sizeBytes()).toBe(4 + deflate(utf8("new\n")).length);
  });

  it("compresses a large object a chunk at a time to store it, to the same zlib data", async () => {
    const { store, r2 } = setup();
    // Random: its zlib data goes to R2. Text: small enough compressed to stay in SQLite.
    const random = new Uint8Array(randomBytes(3 * 1024 * 1024));
    const text = utf8("a line of a large text file\n".repeat(120_000));
    for (const content of [random, text]) {
      const oid = await hashObject("blob", content);
      await store.writeKnown(oid, "blob", content, false);
      const raw = (await store.readRaw(oid))!;
      expect(Buffer.from(raw.deflated).equals(Buffer.from(deflate(content)))).toBe(true);
      expect(Buffer.from(inflate(raw.deflated)).equals(Buffer.from(content))).toBe(true);
      expect(store.readCost(oid)).toBe(content.length + raw.deflated.length);
      expect(Buffer.from((await store.read(oid))!.content).equals(Buffer.from(content))).toBe(true);
    }
    expect(r2.size).toBe(1);
  });

  it("gives a thin pack's bases only when reading them fits, saying what they would take otherwise", async () => {
    const { store } = setup();
    const zeros = new Uint8Array(8 * 1024 * 1024);
    const oid = await store.write("blob", zeros);
    const lookup = repositoryBases(store);
    const cost = store.readCost(oid)!;
    expect(cost).toBeGreaterThan(zeros.length);
    expect(await lookup(oid, cost - 1)).toBe(cost);
    expect(((await lookup(oid, cost)) as { content: Uint8Array }).content.length).toBe(zeros.length);
    expect(await lookup("0".repeat(40), cost)).toBeNull();
  });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x" } });

/** A history with a merge and a tag, packed as git sends it: newest commits first, files last. */
function historyPack(): { pack: Uint8Array; commits: Map<string, string[]>; tag: string } {
  const dir = mkdtempSync(join(tmpdir(), "order-"));
  git(dir, "init", "-q", "-b", "main");
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} of a file long enough for deltas`).join("\n");
  writeFileSync(join(dir, "a.txt"), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  git(dir, "checkout", "-q", "-b", "side");
  writeFileSync(join(dir, "b.txt"), "side\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "side");
  git(dir, "checkout", "-q", "main");
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(dir, "a.txt"), text.replace(`line ${i * 50}`, `LINE ${i * 50}`));
    git(dir, "commit", "-qam", `main ${i}`);
  }
  git(dir, "merge", "-q", "--no-edit", "side");
  git(dir, "tag", "-a", "v1", "-m", "release");
  const commits = new Map<string, string[]>();
  for (const line of git(dir, "rev-list", "--parents", "--all").toString().trim().split("\n")) {
    const [oid, ...parents] = line.split(" ");
    commits.set(oid!, parents);
  }
  const tag = git(dir, "rev-parse", "v1").toString().trim();
  const pack = execFileSync("git", ["pack-objects", "--stdout", "--revs", "--all", "--delta-base-offset"], { cwd: dir, input: "" });
  return { pack: new Uint8Array(pack), commits, tag };
}

/** The oids `store` is asked to store, in order. */
function recordWrites(store: RepoObjectStore): string[] {
  const order: string[] = [];
  for (const m of ["writeKnown", "writeDeflated", "writeDeflatedSlices"] as const) {
    const real = (store[m] as (...a: unknown[]) => Promise<void>).bind(store);
    (store as unknown as Record<string, unknown>)[m] = (oid: string, ...rest: unknown[]) => (order.push(oid), real(oid, ...rest));
  }
  return order;
}

/** Every commit is stored after every file and tree, and after its parents; the tag last. */
function expectHistoryOrder(order: string[], commits: Map<string, string[]>, tag: string) {
  const at = new Map(order.map((oid, i) => [oid, i]));
  expect(new Set(order).size).toBe(order.length);
  const firstCommit = Math.min(...[...commits.keys()].map((c) => at.get(c)!));
  expect(order.slice(firstCommit).every((oid) => commits.has(oid) || oid === tag)).toBe(true);
  for (const [c, parents] of commits) for (const p of parents) expect(at.get(p)!).toBeLessThan(at.get(c)!);
  expect(at.get(tag)).toBe(order.length - 1);
}

describe("the order a push is stored in", () => {
  it("reads a commit's parents from its header only", () => {
    const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40);
    expect(commitParents(utf8(`tree ${c}\nparent ${a}\nparent ${b}\nauthor T <t@x> 1 +0000\n\nparent ${c}\n`))).toEqual([a, b]);
    expect(commitParents(utf8(`tree ${c}\nauthor T <t@x> 1 +0000\n\nroot\n`))).toEqual([]);
  });

  it("puts each commit after its parents however deep the history, and everything else after", () => {
    const n = 50_000;
    const oid = (i: number) => i.toString(16).padStart(40, "0");
    // Newest first, as a pack lists them, with a tree in between and a parent outside the push.
    const items = [{ oid: "t".repeat(40), type: "tag" }, ...Array.from({ length: n }, (_, k) => ({ oid: oid(n - k), type: "commit" }))];
    const parents = (t: { oid: string }) => { const i = parseInt(t.oid, 16); return [oid(i - 1)]; };
    const out = historyOrder(items, parents);
    expect(out.length).toBe(n + 1);
    expect(out.slice(0, n).map((t) => t.oid)).toEqual(Array.from({ length: n }, (_, k) => oid(k + 1)));
    expect(out[n]!.type).toBe("tag");
  });

  it("stores a pack parsed in memory files and trees first, then commits after their parents, then tags", async () => {
    const { pack, commits, tag } = historyPack();
    const { store } = setup();
    const order = recordWrites(store);
    const objects = await parsePack(pack);
    // git sends the newest commits first: stored as they come, a cut-off push would leave commits without their files.
    expect(objects.findIndex((o) => o.type === "commit")).toBeLessThan(objects.findIndex((o) => o.type === "blob"));
    await packedContents(store, objects, pack.length).write();
    expect(order.length).toBe(objects.length);
    expectHistoryOrder(order, commits, tag);
  });

  it("stores a pack unpacked in pieces in the same order", async () => {
    const { pack, commits, tag } = historyPack();
    const { store } = setup();
    const contents = await streamedContents(store, memorySource(pack), { largeObjectBytes: 4 * 1024 * 1024 });
    expect(contents.fsck()).toBeNull();
    const order = recordWrites(store);
    await contents.write();
    expectHistoryOrder(order, commits, tag);
    for (const c of commits.keys()) expect(store.has(c)).toBe(true);
  });
});
