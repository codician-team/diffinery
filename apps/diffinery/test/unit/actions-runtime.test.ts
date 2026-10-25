import { describe, expect, it } from "vitest";
import { BodyTooLarge, STEP_OPS, batchParts, blockKey, chunkKey, compose, finalKey, listStaged, parseBlockList, parseRange, planCompose, putStream, runComposeStep, stagingPrefix, type BlobBucket, type ComposeLimits, type ComposeStep } from "../../src/lib/blob-store.js";
import { DatabaseSync } from "node:sqlite";
import { Actions, CANCEL_STOP_MS, JOB_DEADLINE_GRACE_MS, MAX_ACTIVE_RUNS, MAX_PLACEMENT_TRIES, MAX_RUNNER_RESTARTS, parseRunnerInfo, placementDelay, QUICK_RETRY_SECONDS, STALE_IMAGE_RETRY_SECONDS, STALE_IMAGE_TRIES } from "../../src/repo/actions.js";
import { fleetLimits } from "../../src/lib/quotas.js";
import { testD1 } from "./stubs/d1.js";
import { DEFAULT_ARTIFACT_QUOTA, Runtime, artifactFileName, artifactObjectKeys } from "../../src/repo/runtime.js";
import { REPO_SCHEMA, migrateRepoSchema } from "../../src/repo/schema.js";
import type { RepoDO } from "../../src/repo/RepoDO.js";
import type { Env } from "../../src/env.js";
import { archiveKey, deletePrefixes, legacyArtifactKeys, legacyCacheKeys, logKeys, transientPrefixes } from "../../src/lib/storage-keys.js";
import { signBlobUrl, signRuntimeToken, verifyBlobUrl, verifyRuntimeToken } from "../../src/lib/runtime-auth.js";
import { b64, fromB64url, sha256 } from "../../src/lib/util.js";
import { completePayload, issuePayload, releasePayload } from "../../src/repo/event-payloads.js";
import { TokenPolicy } from "../../src/repo/token-policy.js";
import type { Caller, RepoMeta } from "../../src/repo/types.js";
import { numericId } from "../../src/http/gh.js";

/** Hosted jobs one account (and so one repository) runs at once by default. */
const SHARE = fleetLimits({} as Env).share;

const MASTER = { MASTER_KEY: b64(new Uint8Array(32).fill(7)) };
const OTHER = { MASTER_KEY: b64(new Uint8Array(32).fill(9)) };
const soon = () => Math.floor(Date.now() / 1000) + 600;

describe("runtime tokens", () => {
  it("carries what the toolkit and buildkit read, and verifies only under the right key", async () => {
    const token = await signRuntimeToken(MASTER, "https://d.example", { repo: "r1", run: "run1", job: "job1", exp: soon() }, ["refs/heads/feat", "refs/heads/main"]);
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(token.split(".")[1]!)));
    // @actions/artifact takes the run and job backend ids from scp.
    expect(claims.scp).toContain("Actions.Results:run1:job1");
    // go-actions-cache needs ac (a JSON string), exp and nbf.
    expect(JSON.parse(claims.ac)).toEqual([
      { Scope: "refs/heads/feat", Permission: 3 },
      { Scope: "refs/heads/main", Permission: 1 },
    ]);
    expect(claims.nbf).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(await verifyRuntimeToken(MASTER, token)).toMatchObject({ repo: "r1", run: "run1", job: "job1" });
    expect(await verifyRuntimeToken(OTHER, token)).toBeNull();
    expect(await verifyRuntimeToken(MASTER, token.slice(0, -2) + "xx")).toBeNull();
    expect(await verifyRuntimeToken(MASTER, "not.a.token")).toBeNull();
  });

  it("rejects expired tokens and tampered claims", async () => {
    const expired = await signRuntimeToken(MASTER, "x", { repo: "r", run: "a", job: "b", exp: Math.floor(Date.now() / 1000) - 5 }, ["refs/heads/main"]);
    expect(await verifyRuntimeToken(MASTER, expired)).toBeNull();
    const token = await signRuntimeToken(MASTER, "x", { repo: "r", run: "a", job: "b", exp: soon() }, ["refs/heads/main"]);
    const [h, p, s] = token.split(".");
    const forged = JSON.parse(new TextDecoder().decode(fromB64url(p!)));
    forged.repo = "victim";
    const p2 = Buffer.from(JSON.stringify(forged)).toString("base64url");
    expect(await verifyRuntimeToken(MASTER, `${h}.${p2}.${s}`)).toBeNull();
  });
});

describe("signed blob URLs", () => {
  it("grant one permission on one blob until they expire", async () => {
    const ref = { repo: "r1", kind: "artifact" as const, id: 42 };
    const url = new URL(await signBlobUrl(MASTER, "https://d.example", ref, "r", soon(), "my artifact.zip"));
    expect(url.pathname).toBe("/_runtime/blob/r1/artifact/42/my%20artifact.zip");
    expect(await verifyBlobUrl(MASTER, ref, "r", url.searchParams)).toBe(true);
    expect(await verifyBlobUrl(MASTER, ref, "w", url.searchParams)).toBe(false);
    expect(await verifyBlobUrl(MASTER, { ...ref, id: 43 }, "r", url.searchParams)).toBe(false);
    expect(await verifyBlobUrl(MASTER, { ...ref, kind: "cache" }, "r", url.searchParams)).toBe(false);
    expect(await verifyBlobUrl(OTHER, ref, "r", url.searchParams)).toBe(false);
    const stale = new URL(await signBlobUrl(MASTER, "https://d.example", ref, "r", Math.floor(Date.now() / 1000) - 1));
    expect(await verifyBlobUrl(MASTER, ref, "r", stale.searchParams)).toBe(false);
    url.searchParams.set("se", String(soon() + 100));
    expect(await verifyBlobUrl(MASTER, ref, "r", url.searchParams)).toBe(false);
  });
});

describe("blob protocol helpers", () => {
  it("parses Azure block lists in order", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><BlockList><Latest>AAA=</Latest><Uncommitted>Qg==</Uncommitted><Committed>a&amp;b</Committed></BlockList>`;
    expect(parseBlockList(xml)).toEqual(["AAA=", "Qg==", "a&b"]);
  });

  it("parses byte ranges like Azure and HTTP", () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange("bytes=0-", 10)).toEqual({ offset: 0, length: 10 });
    expect(parseRange("bytes=2-4", 10)).toEqual({ offset: 2, length: 3 });
    expect(parseRange("bytes=5-100", 10)).toEqual({ offset: 5, length: 5 });
    expect(parseRange("bytes=-3", 10)).toEqual({ offset: 7, length: 3 });
    expect(parseRange("bytes=10-", 10)).toBe("invalid");
    expect(parseRange("bytes=4-2", 10)).toBe("invalid");
    expect(parseRange("items=0-1", 10)).toBe("invalid");
  });

  it("keeps staged objects per blob, and transient data outside repos/", () => {
    const a = { repo: "r", kind: "cache" as const, id: 1 };
    expect(finalKey(a)).toBe("actions-cache/r/1");
    expect(finalKey({ ...a, kind: "artifact" })).toBe("artifacts/r/1");
    expect(blockKey(a, "x/y")).toMatch(/^actions-staging\/r\/cache-1\/b-[A-Za-z0-9_-]+$/);
    expect(chunkKey(a, 1024)).toBe("actions-staging/r/cache-1/o-0000000000001024");
    // Old keys are still read, after the new ones.
    expect(logKeys("r", "j")).toEqual(["logs/r/j.json", "repos/r/logs/j.json"]);
    expect(legacyCacheKeys("r", "a b")).toEqual(["actions-cache/r/legacy/a%20b", "repos/r/cache/a%20b"]);
    expect(legacyArtifactKeys("r", "run", "n")).toEqual(["artifacts/r/legacy/run/n", "repos/r/artifacts/run/n"]);
    // Nothing transient is written under repos/, which has no age rule (git objects, LFS).
    for (const k of [finalKey(a), finalKey({ ...a, kind: "artifact" }), blockKey(a, "b"), logKeys("r", "j")[0], legacyCacheKeys("r", "k")[0], legacyArtifactKeys("r", "x", "y")[0]]) expect(k.startsWith("repos/")).toBe(false);
  });
});

/** An in-memory stand-in for the R2 bucket, enforcing R2's multipart rules and counting calls. */
function memoryBucket() {
  const objects = new Map<string, { data: Uint8Array; etag: string }>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  const stats = { multipart: 0, parts: [] as number[], ops: 0 };
  let n = 0;
  let listing: { prefix: string; all: Array<{ key: string; size: number }> } | undefined;
  const bytes = async (v: ReadableStream | ArrayBuffer | ArrayBufferView) =>
    v instanceof ReadableStream ? new Uint8Array(await new Response(v).arrayBuffer()) : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
  const store = (key: string, data: Uint8Array) => {
    const etag = `e${++n}`;
    objects.set(key, { data, etag });
    return { size: data.length, etag };
  };
  const handle = (uploadId: string) => {
    const u = uploads.get(uploadId)!;
    return {
      uploadId,
      async uploadPart(p: number, value: ReadableStream | ArrayBuffer | ArrayBufferView) {
        stats.ops++;
        u.parts.set(p, await bytes(value));
        return { partNumber: p, etag: `p${p}` };
      },
      async complete(list: Array<{ partNumber: number; etag: string }>) {
        stats.ops++;
        const sizes = list.map((p) => u.parts.get(p.partNumber)!.length);
        sizes.slice(0, -1).forEach((s) => expect(s).toBeGreaterThanOrEqual(5 * 1024 * 1024));
        sizes.slice(0, -1).forEach((s) => expect(s).toBe(sizes[0]));
        expect(list.map((p) => p.partNumber)).toEqual(list.map((_, i) => i + 1));
        stats.parts = sizes;
        const out = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
        let at = 0;
        for (const p of list) {
          out.set(u.parts.get(p.partNumber)!, at);
          at += u.parts.get(p.partNumber)!.length;
        }
        store(u.key, out);
        return {};
      },
      async abort() {
        stats.ops++;
        uploads.delete(uploadId);
      },
    };
  };
  const bucket: BlobBucket = {
    async get(key, o) {
      stats.ops++;
      const obj = objects.get(key);
      if (!obj) return null;
      const data = o?.range ? obj.data.subarray(o.range.offset, o.range.offset + o.range.length) : obj.data;
      return { body: new Response(data).body!, size: data.length };
    },
    async head(key) {
      stats.ops++;
      const o = objects.get(key);
      return o ? { size: o.data.length, etag: o.etag } : null;
    },
    async put(key, value) {
      stats.ops++;
      return store(key, await bytes(value));
    },
    async list({ prefix, cursor, limit }) {
      stats.ops++;
      // A listing pages through one snapshot (the cursor is an index into it), so 50k objects aren't filtered again for every page.
      const start = Number(cursor ?? 0);
      if (!start || listing?.prefix !== prefix) listing = { prefix, all: [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.data.length })) };
      const all = listing.all;
      const page = all.slice(start, start + (limit ?? 1000));
      const truncated = start + page.length < all.length;
      return { objects: page, truncated, cursor: truncated ? String(start + page.length) : undefined };
    },
    async delete(keys) {
      stats.ops++;
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async createMultipartUpload(key) {
      stats.ops++;
      stats.multipart++;
      const id = `u${++n}`;
      uploads.set(id, { key, parts: new Map() });
      return handle(id);
    },
    resumeMultipartUpload(_key, uploadId) {
      return handle(uploadId);
    },
  };
  return { bucket, objects, stats };
}

const filled = (n: number, seed: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255;
  return b;
};

describe("compose", () => {
  const ref = { repo: "r", kind: "artifact" as const, id: 9 };
  const MiB = 1024 * 1024;

  /**
   * Composes blocks of `sizes`, running every step as production does (an invocation
   * of its own), and checks the bytes. Returns the calls the Worker made and the most
   * any single step made.
   */
  async function run(sizes: number[], limits?: ComposeLimits) {
    const m = memoryBucket();
    const segs = [];
    for (const [i, n] of sizes.entries()) {
      const key = blockKey(ref, `block-${i}`);
      await m.bucket.put(key, filled(n, i));
      segs.push({ key, size: n });
    }
    const staged = await listStaged(m.bucket, ref);
    expect(staged.size).toBe(sizes.length);
    m.stats.ops = 0;
    let steps = 0;
    let maxStepOps = 0;
    const runStep = async (step: ComposeStep) => {
      steps++;
      const before = m.stats.ops;
      const out = await runComposeStep(m.bucket, step);
      const used = m.stats.ops - before;
      maxStepOps = Math.max(maxStepOps, used);
      // the Worker's own calls exclude the steps'
      m.stats.ops = before;
      return out;
    };
    const total = await compose(m.bucket, finalKey(ref), segs, "application/zip", { scratch: stagingPrefix(ref), run: runStep, concurrency: 1, limits });
    const out = m.objects.get(finalKey(ref))!.data;
    const expected = new Uint8Array(total);
    let at = 0;
    for (const [i, n] of sizes.entries()) {
      expected.set(filled(n, i), at);
      at += n;
    }
    expect(out.length).toBe(expected.length);
    expect(Buffer.from(out).equals(Buffer.from(expected))).toBe(true);
    // intermediates are removed; only the blocks (deleted by the caller) and the result remain
    expect([...m.objects.keys()].filter((k) => !staged.has(k) && k !== finalKey(ref))).toEqual([]);
    return { ...m.stats, workerOps: m.stats.ops, steps, maxStepOps };
  }

  it("handles empty and single uploads", async () => {
    expect((await run([])).multipart).toBe(0);
    expect((await run([123])).multipart).toBe(0);
  });

  it("streams a few blocks into one object", async () => {
    const r = await run([1000, 7, 1 << 20, 8 * MiB]);
    expect(r.multipart).toBe(0);
    expect(r.steps).toBe(1);
  });

  it("writes large uploads as equal multipart parts, cutting across blocks", async () => {
    const small = { stepOps: 400, maxMergeBytes: 4 * MiB };
    expect((await run([8 * MiB, 8 * MiB, 3 * MiB], small)).parts).toEqual([8 * MiB, 8 * MiB, 3 * MiB]);
    // Go SDK style 1 MiB blocks are re-cut into 8 MiB parts (ranged reads across block boundaries)
    expect((await run(Array.from({ length: 19 }, (_, i) => (i === 18 ? 12345 : MiB)), small)).parts).toEqual([8 * MiB, 8 * MiB, 2 * MiB + 12345]);
    expect((await run([3 * MiB, 7 * MiB, 5 * MiB, 1], small)).parts).toEqual([8 * MiB, 7 * MiB + 1]);
  });

  it("copies a large upload as multipart parts spread over many steps, not one long put", async () => {
    // The runner's 32 MiB blocks: one put would copy 101 MiB in a single step (about 15 s); parts of
    // 8 MiB, two per step, let eight steps copy at once.
    const r = await run([32 * MiB, 32 * MiB, 32 * MiB, 5 * MiB]);
    expect(r.multipart).toBe(1);
    expect(r.parts).toEqual([...Array.from({ length: 12 }, () => 8 * MiB), 5 * MiB]);
    expect(r.steps).toBe(7);
    // Up to 16 MiB still goes in one put.
    expect((await run([16 * MiB])).multipart).toBe(0);
    expect((await run([16 * MiB, 1])).multipart).toBe(1);
  });

  it("fails a step whose staged block went missing, instead of writing a short part", async () => {
    const m = memoryBucket();
    await m.bucket.put("s/a", filled(1000, 1));
    const step: ComposeStep = { kind: "merge", target: "s/out", slices: [{ key: "s/a", offset: 0, length: 1000, whole: true }, { key: "s/gone", offset: 0, length: 10, whole: true }], length: 1010 };
    await expect(runComposeStep(m.bucket, step)).rejects.toThrow(/s\/gone is missing/);
    expect(m.objects.has("s/out")).toBe(false);
  });

  it("merges many small blocks in rounds so that no step exceeds its calls", async () => {
    // 10 calls per step: 300 blocks need two rounds of merging before the parts
    const r = await run(Array.from({ length: 300 }, (_, i) => 40 * 1024 + i), { stepOps: 10, maxMergeBytes: 1 * MiB });
    expect(r.maxStepOps).toBeLessThanOrEqual(10);
    expect(r.multipart).toBe(1);
  });

  it("keeps a 50,000-block list (Azure's maximum) within the Workers subrequest limit", async () => {
    // Real data: 50k tiny blocks, as buildkit's gha cache can send.
    const r = await run(Array.from({ length: 50_000 }, (_, i) => 16 + (i % 7)));
    expect(r.maxStepOps).toBeLessThanOrEqual(STEP_OPS);
    expect(r.steps + r.workerOps).toBeLessThan(1000);
    // Planned only (no bytes): 50k blocks of 200 KiB (10 GB), and of 1 MiB with 4 MiB blocks mixed in.
    for (const sizes of [Array.from({ length: 50_000 }, () => 200 * 1024), Array.from({ length: 50_000 }, (_, i) => (i % 10 ? MiB : 4 * MiB))]) {
      const plan = planCompose(sizes.map((size, i) => ({ key: `k${i}`, size })), "s/");
      const steps = [...plan.rounds.flat(), ...batchParts(plan.parts)];
      for (const s of steps) {
        const ops = "kind" in s ? s.slices.length + 1 : s.reduce((n, p) => n + p.slices.length + 1, 0);
        expect(ops).toBeLessThanOrEqual(STEP_OPS);
      }
      // list pages and deletes of 50k staged blocks (50 each), the steps, create and complete
      expect(50 + 50 + steps.length + 2).toBeLessThan(1000);
      expect(plan.parts.length).toBeLessThanOrEqual(10_000);
      expect(plan.parts.slice(0, -1).every((p) => p.reduce((n, s) => n + s.length, 0) === plan.partSize)).toBe(true);
    }
    // Writes and composes 50k objects: about 1.5s alone, and several times that on a busy CI runner.
  }, 20_000);
});

describe("deleting a repository's transient objects", () => {
  it("removes every object under its prefixes, a page at a time, and nothing else", async () => {
    const m = memoryBucket();
    const keys = [...Array.from({ length: 2500 }, (_, i) => `actions-cache/r1/${i}`), "artifacts/r1/1", "logs/r1/j.json", "actions-staging/r1/cache-1/b-x", archiveKey("r1", "abc", "zip")];
    for (const k of keys) await m.bucket.put(k, new Uint8Array(1));
    for (const k of ["actions-cache/r10/1", "repos/r1/objects/ab/cd", "artifacts/r2/1"]) await m.bucket.put(k, new Uint8Array(1));
    m.stats.ops = 0;
    expect(transientPrefixes("r1").some((p) => p.startsWith("repos/"))).toBe(false);
    expect(await deletePrefixes(m.bucket, transientPrefixes("r1"))).toBe(true);
    expect([...m.objects.keys()].sort()).toEqual(["actions-cache/r10/1", "artifacts/r2/1", "repos/r1/objects/ab/cd"]);
    // 3 pages of caches (list + delete each), then a page for each other prefix
    expect(m.stats.ops).toBe(6 + 4 * 2);
    // stops within its budget and says so
    for (let i = 0; i < 3000; i++) await m.bucket.put(`logs/r3/${i}`, new Uint8Array(1));
    expect(await deletePrefixes(m.bucket, transientPrefixes("r3"), 4)).toBe(false);
  });
});

describe("streaming bodies of unknown length", () => {
  const stream = (chunks: number[]) =>
    new ReadableStream<Uint8Array>({
      start(ctl) {
        chunks.forEach((n, i) => ctl.enqueue(filled(n, i)));
        ctl.close();
      },
    });

  it("stores small bodies in one put and large ones as parts, a part in memory at a time", async () => {
    const m = memoryBucket();
    expect(await putStream(m.bucket, "a", stream([10, 20]), 100)).toBe(30);
    expect(m.stats.multipart).toBe(0);
    const MiB = 1024 * 1024;
    expect(await putStream(m.bucket, "b", stream([3 * MiB, 3 * MiB, 3 * MiB, 3 * MiB, 1]), 64 * MiB, undefined, 5 * MiB)).toBe(12 * MiB + 1);
    expect(m.stats.parts).toEqual([5 * MiB, 5 * MiB, 2 * MiB + 1]);
    expect(m.objects.get("b")!.data.length).toBe(12 * MiB + 1);
  });

  it("refuses more than the limit and stores nothing", async () => {
    const m = memoryBucket();
    await expect(putStream(m.bucket, "c", stream([60, 60]), 100)).rejects.toBeInstanceOf(BodyTooLarge);
    await expect(putStream(m.bucket, "d", stream([6 * 1024 * 1024, 6 * 1024 * 1024]), 10 * 1024 * 1024, undefined, 5 * 1024 * 1024)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(m.objects.has("c")).toBe(false);
    expect(m.objects.has("d")).toBe(false);
  });
});

describe("event payloads", () => {
  const meta: RepoMeta = { repoId: "r1", ownerId: "o1", owner: "acme", name: "app", defaultBranch: "main", ownerKind: "org" };
  const site = { publicUrl: "https://d.example", meta };

  it("adds repository, sender and organization like GitHub", () => {
    const p = completePayload(site, { ref: "refs/heads/main", sender: { login: "ada" } }, { id: "u1", login: "ada", kind: "user" });
    const repo = p.repository as Record<string, unknown>;
    expect(repo).toMatchObject({ name: "app", full_name: "acme/app", default_branch: "main", clone_url: "https://d.example/acme/app.git", url: "https://d.example/api/v3/repos/acme/app" });
    expect(repo.owner).toMatchObject({ login: "acme", type: "Organization" });
    expect(p.sender).toMatchObject({ login: "ada", id: numericId("u1"), type: "User" });
    expect(p.organization).toMatchObject({ login: "acme" });
    expect(p.ref).toBe("refs/heads/main");
  });

  it("completes pull_request with head.repo and keeps trigger fields", () => {
    const p = completePayload(site, { action: "opened", number: 3, pull_request: { number: 3, title: "T", head: { ref: "feat", sha: "abc" }, base: { ref: "main", sha: "def" }, user: { login: "bob" } } }, { login: "bob", kind: "agent", id: "a1" });
    const pr = p.pull_request as Record<string, any>;
    expect(pr.head).toMatchObject({ ref: "feat", sha: "abc", label: "acme:feat" });
    expect(pr.head.repo.full_name).toBe("acme/app");
    expect(pr.base.repo.full_name).toBe("acme/app");
    // Numeric ids, as on GitHub and in the REST API.
    expect(pr.head.repo.id).toBe(numericId("r1"));
    expect(pr.base.repo.id).toBe(numericId("r1"));
    expect(typeof pr.user.id).toBe("number");
    expect((p.organization as Record<string, unknown>).id).toBe(numericId("o1"));
    expect(pr).toMatchObject({ number: 3, title: "T", state: "open", html_url: "https://d.example/acme/app/pull/3" });
    expect(pr.user.login).toBe("bob");
    expect((p.sender as Record<string, unknown>).type).toBe("Bot");
  });

  it("builds issue and release objects", () => {
    const issue = issuePayload(site, { number: 5, kind: "issue", title: "Bug", body: "b", state: "open", stateReason: null, author: { id: "u", login: "ada", kind: "user" }, assignees: ["bob"], labels: ["bug"], createdAt: "t", updatedAt: "t", closedAt: null, comments: 2 });
    expect(issue).toMatchObject({ number: 5, title: "Bug", labels: [{ name: "bug" }], comments: 2, html_url: "https://d.example/acme/app/issues/5" });
    expect(issue.pull_request).toBeUndefined();
    const rel = releasePayload(site, { id: 1, tagName: "v1.0.0", targetCommitish: "main", name: "v1", body: null, draft: false, prerelease: false, createdAt: "t", publishedAt: "t", author: { login: "ada" } });
    expect(rel).toMatchObject({ tag_name: "v1.0.0", html_url: "https://d.example/acme/app/releases/tag/v1.0.0", upload_url: "https://d.example/api/v3/repos/acme/app/releases/1/assets{?name,label}" });
  });
});

/** The Durable Object's SqlStorage over node:sqlite: exec(query, ...bindings) with toArray() and one(). */
function sqlStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...args: unknown[]) {
      const params = args.map((a) => (a === undefined ? null : a)) as Array<string | number | null>;
      let rows: unknown[] = [];
      if (!params.length && query.trim().replace(/;\s*$/, "").includes(";")) db.exec(query);
      else rows = db.prepare(query).all(...params);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0];
        },
      };
    },
  };
}

/** A Runtime over a fresh repository schema, an in-memory bucket, and jobs running on given refs. */
function runtimeFixture() {
  const sql = sqlStorage();
  sql.exec(REPO_SCHEMA);
  migrateRepoSchema(sql as unknown as SqlStorage);
  const m = memoryBucket();
  const repo = { sql, meta: { repoId: "r", defaultBranch: "main" } } as unknown as RepoDO & { runtime: Runtime };
  const env = { BUCKET: m.bucket } as unknown as Env;
  const rt = new Runtime(repo, env);
  repo.runtime = rt;
  // The runner API's side of older runners' caches and artifacts, with every job token taken as valid.
  const actions = new Actions(repo, env);
  Object.defineProperty(actions, "authJob", { value: async (id: string) => sql.exec("SELECT * FROM jobs WHERE id = ?", id).one() });
  let n = 0;
  /** A running job of a run on `ref`; `payload` is the run's event payload. */
  const job = (ref: string, payload: Record<string, unknown> = {}) => {
    n++;
    const t = new Date().toISOString();
    sql.exec(
      "INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, event_payload) VALUES (?, ?, 'w.yml', 'w', 'push', ?, 'abc', '{}', 'in_progress', ?, ?, ?)",
      `run${n}`,
      n,
      ref,
      t,
      t,
      JSON.stringify(payload),
    );
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES (?, ?, 'j', 'j', 'in_progress')", `job${n}`, `run${n}`);
    return `job${n}`;
  };
  const version = "ab".repeat(32);
  /** Saves `key` from `jobId` (reserve, then commit). */
  const save = async (jobId: string, key: string) => {
    const r = await rt.cacheReserve(jobId, key, version);
    expect(r).not.toBeNull();
    await rt.cacheCommit(jobId, r!.id, 10, "etag");
  };
  const restore = (jobId: string, ...keys: string[]) => rt.cacheLookup(jobId, keys, version);
  return { sql, rt, actions, m, job, save, restore };
}

describe("cache scopes (as on GitHub)", () => {
  it("restores from the job's own ref, then the default branch; never another branch's", async () => {
    const f = runtimeFixture();
    const main = f.job("refs/heads/main");
    await f.save(main, "deps-main");
    const a = f.job("refs/heads/a");
    await f.save(a, "deps-a");
    // a restores its own entry first, else main's
    expect(f.restore(a, "deps-a")?.scope).toBe("refs/heads/a");
    expect(f.restore(a, "nothing", "deps-")?.key).toBe("deps-a");
    expect(f.restore(a, "deps-main")?.scope).toBe("refs/heads/main");
    // b sees main's, not a's newer one, even by prefix
    const b = f.job("refs/heads/b");
    expect(f.restore(b, "deps-a")).toBeNull();
    expect(f.restore(b, "deps-")?.key).toBe("deps-main");
    // the default branch never sees a branch's caches
    const main2 = f.job("refs/heads/main");
    expect(f.restore(main2, "deps-a")).toBeNull();
    expect(f.restore(main2, "deps-")?.key).toBe("deps-main");
    // saves go to the job's own ref: b may save a key that a already has
    await f.save(b, "deps-a");
    expect(f.restore(b, "deps-a")?.scope).toBe("refs/heads/b");
  });

  it("gives pull requests their base branch's caches but not other pull requests'", async () => {
    const f = runtimeFixture();
    await f.save(f.job("refs/heads/main"), "k-main");
    await f.save(f.job("refs/heads/release"), "k-release");
    const pr1 = f.job("refs/pull/1/merge", { pull_request: { number: 1, base: { ref: "release" } } });
    expect(f.restore(pr1, "k-")?.key).toBe("k-release");
    await f.save(pr1, "k-pr1");
    expect(f.restore(pr1, "k-")?.key).toBe("k-pr1");
    const pr2 = f.job("refs/pull/2/merge", { pull_request: { number: 2, base: { ref: "main" } } });
    expect(f.restore(pr2, "k-pr1")).toBeNull();
    expect(f.restore(pr2, "k-release")).toBeNull();
    expect(f.restore(pr2, "k-")?.key).toBe("k-main");
    // nor the base branch or the default branch theirs
    expect(f.restore(f.job("refs/heads/release"), "k-pr1")).toBeNull();
    expect(f.restore(f.job("refs/heads/main"), "k-pr")).toBeNull();
    // a merge group reads its target branch's caches
    const group = f.job("refs/heads/gh-readonly-queue/release/pr-1-abc", { merge_group: { base_ref: "refs/heads/release" } });
    expect(f.restore(group, "k-")?.key).toBe("k-release");
  });
});

describe("artifact retention", () => {
  const DAY = 86400_000;
  async function upload(f: ReturnType<typeof runtimeFixture>, jobId: string, name: string, expiresAt?: string) {
    const { id } = await f.rt.artifactCreate(jobId, name, undefined, expiresAt);
    await f.m.bucket.put(finalKey({ repo: "r", kind: "artifact", id }), new Uint8Array(100));
    await f.rt.stage("artifact", id, 100);
    return f.rt.artifactFinalize(jobId, name, 100, undefined, "etag");
  }
  const days = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / DAY);

  it("honours retention-days, clamped to 1..90 days", async () => {
    const f = runtimeFixture();
    const j = f.job("refs/heads/main");
    expect(days((await upload(f, j, "five", new Date(Date.now() + 5 * DAY).toISOString())).expiresAt)).toBe(5);
    expect(days((await upload(f, j, "default")).expiresAt)).toBe(90);
    expect(days((await upload(f, j, "too-long", new Date(Date.now() + 400 * DAY).toISOString())).expiresAt)).toBe(90);
    expect(days((await upload(f, j, "too-short", new Date(Date.now() - DAY).toISOString())).expiresAt)).toBe(1);
    expect(days((await upload(f, j, "garbage", "next tuesday")).expiresAt)).toBe(90);
  });

  it("deletes an expired artifact's content and lists it as expired", async () => {
    const f = runtimeFixture();
    const j = f.job("refs/heads/main");
    const a = await upload(f, j, "old", new Date(Date.now() + 2 * DAY).toISOString());
    const keep = await upload(f, j, "new", new Date(Date.now() + 3 * DAY).toISOString());
    expect(a.expired).toBe(false);
    f.sql.exec("UPDATE rt_artifacts SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), a.id);
    // Already shown as expired (and not handed to the toolkit) before the sweep runs.
    expect(f.rt.artifactGet(a.id)).toBeNull();
    expect(f.rt.artifactGet(a.id, { includeExpired: true })?.expired).toBe(true);
    // A job ending sweeps: the content goes, the listing stays.
    await f.rt.sweepJob(j);
    expect(f.m.objects.has(finalKey({ repo: "r", kind: "artifact", id: a.id }))).toBe(false);
    expect(f.m.objects.has(finalKey({ repo: "r", kind: "artifact", id: keep.id }))).toBe(true);
    expect(f.rt.runArtifacts("run1").map((x) => x.name)).toEqual(["new"]);
    expect(f.rt.runArtifacts("run1", { includeExpired: true }).map((x) => [x.name, x.expired])).toEqual([
      ["new", false],
      ["old", true],
    ]);
    const listed = f.rt.repoArtifacts({});
    expect(listed.artifacts.find((x) => x.id === a.id)?.expired).toBe(true);
    // Expired artifacts no longer count against the quota.
    expect(f.sql.exec("SELECT status, staged FROM rt_artifacts WHERE id = ?", a.id).one()).toEqual({ status: "expired", staged: 0 });
    // The name can be used again, and 90 days on the listing goes too.
    const again = f.job("refs/heads/main");
    f.sql.exec("UPDATE jobs SET run_id = 'run1' WHERE id = ?", again);
    expect((await upload(f, again, "old")).expired).toBe(false);
    f.sql.exec("UPDATE rt_artifacts SET expires_at = ? WHERE id = ?", new Date(Date.now() - 91 * DAY).toISOString(), keep.id);
    await f.rt.expireArtifacts();
    await f.rt.expireArtifacts();
    expect(f.rt.artifactGet(keep.id, { includeExpired: true })).toBeNull();
  });

  it("a job starting again from the beginning drops what its stopped attempt uploaded, and nothing else", async () => {
    const f = runtimeFixture();
    const j = f.job("refs/heads/main");
    const other = f.job("refs/heads/main");
    const mine = await upload(f, j, "report");
    const theirs = await upload(f, other, "report");
    await f.save(j, "deps-1");
    await f.save(other, "deps-2");
    // A job's end keeps what it finished uploading.
    await f.rt.sweepJob(j);
    expect(f.rt.artifactGet(mine.id)).not.toBeNull();
    // Its restart doesn't: the new attempt uploads its own, under the same names.
    await f.rt.sweepJob(j, { restart: true });
    expect(f.rt.artifactGet(mine.id, { includeExpired: true })).toBeNull();
    expect(f.m.objects.has(finalKey({ repo: "r", kind: "artifact", id: mine.id }))).toBe(false);
    expect(f.restore(j, "deps-1")).toBeNull();
    expect(f.rt.artifactGet(theirs.id)).not.toBeNull();
    expect(f.restore(other, "deps-2")).not.toBeNull();
    expect((await upload(f, j, "report")).expired).toBe(false);
  });
});

describe("artifacts from older runners", () => {
  const DAY = 86400_000;
  /** What the runner API does with an older runner's upload: check the name, store the tarball, record it. */
  async function legacyUpload(f: ReturnType<typeof runtimeFixture>, jobId: string, name: string, size: number) {
    const { r2Keys } = await f.actions.artifactUploadKeys(jobId, "djt_tok", name);
    await f.m.bucket.put(r2Keys[0]!, new Uint8Array(size));
    await f.actions.artifactSaved(jobId, "djt_tok", name, size);
    return r2Keys;
  }

  it("are listed with numeric ids, and can be read and deleted like the others", async () => {
    const f = runtimeFixture();
    const j = f.job("refs/heads/main");
    const keys = await legacyUpload(f, j, "logs", 40);
    expect(keys).toEqual(legacyArtifactKeys("r", "run1", "logs"));
    const listed = f.rt.repoArtifacts({});
    expect(listed.total).toBe(1);
    const a = listed.artifacts[0]!;
    expect(a).toMatchObject({ name: "logs", size: 40, expired: false, runId: "run1", runNumber: 1, mimeType: "application/gzip" });
    expect(Number.isSafeInteger(a.id) && a.id > 0).toBe(true);
    expect(f.rt.runArtifacts("run1", { includeExpired: true }).map((x) => x.id)).toEqual([a.id]);
    expect(f.rt.runArtifacts("1", { includeExpired: true }).map((x) => x.id)).toEqual([a.id]);
    expect(f.rt.artifactGet(a.id, { includeExpired: true })?.name).toBe("logs");
    // Its content stays where the runner put it, and downloads as a tarball.
    expect(artifactObjectKeys("r", a)).toEqual(keys);
    expect(artifactFileName(a)).toBe("logs.tar.gz");
    expect(f.actions.artifacts("run1")).toMatchObject([{ id: a.id, name: "logs", r2Keys: keys, fileName: "logs.tar.gz", contentType: "application/gzip" }]);
    // It counts against the quota, and is kept 90 days (upload-artifact's default).
    expect(await f.rt.artifactRoom()).toBe(DEFAULT_ARTIFACT_QUOTA - 40);
    expect(Math.round((Date.parse(a.expiresAt) - Date.now()) / DAY)).toBe(90);
    // Uploading the name again replaces it.
    await legacyUpload(f, j, "logs", 50);
    const again = f.rt.repoArtifacts({}).artifacts;
    expect(again.map((x) => [x.name, x.size])).toEqual([["logs", 50]]);
    // Deleting it deletes its content.
    expect((await f.rt.artifactDelete(again[0]!.id))?.name).toBe("logs");
    expect(f.m.objects.has(keys[0]!)).toBe(false);
    expect(f.rt.repoArtifacts({}).total).toBe(0);
    expect(await f.rt.artifactRoom()).toBe(DEFAULT_ARTIFACT_QUOTA);
  });

  it("expire like the others", async () => {
    const f = runtimeFixture();
    const j = f.job("refs/heads/main");
    const [key] = await legacyUpload(f, j, "old", 10);
    const a = f.rt.repoArtifacts({}).artifacts[0]!;
    f.sql.exec("UPDATE rt_artifacts SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), a.id);
    await f.rt.expireArtifacts();
    expect(f.m.objects.has(key!)).toBe(false);
    expect(f.rt.artifactGet(a.id, { includeExpired: true })?.expired).toBe(true);
    expect(await f.rt.artifactRoom()).toBe(DEFAULT_ARTIFACT_QUOTA);
  });

  it("share names with the artifact service's uploads, which don't list them", async () => {
    const f = runtimeFixture();
    const j = f.job("refs/heads/main");
    await legacyUpload(f, j, "tarball", 10);
    // The toolkit talks to GitHub's v4 service, which doesn't list v3 artifacts either.
    expect(f.rt.jobArtifacts(j)).toEqual([]);
    await expect(f.rt.artifactCreate(j, "tarball", undefined, undefined)).rejects.toThrow(/already exists/);
    const { id } = await f.rt.artifactCreate(j, "zip", undefined, undefined);
    await f.m.bucket.put(finalKey({ repo: "r", kind: "artifact", id }), new Uint8Array(5));
    await f.rt.artifactFinalize(j, "zip", 5, undefined, "etag");
    await expect(f.actions.artifactUploadKeys(j, "djt_tok", "zip")).rejects.toThrow(/already exists/);
  });

  it("recorded before they were listed are moved over, keeping their age", () => {
    const f = runtimeFixture();
    f.job("refs/heads/main");
    const created = new Date(Date.now() - 10 * DAY).toISOString();
    f.sql.exec("INSERT INTO artifacts (id, run_id, name, size, created_at) VALUES ('x', 'run1', 'old', 7, ?)", created);
    migrateRepoSchema(f.sql as unknown as SqlStorage);
    const [a] = f.rt.repoArtifacts({}).artifacts;
    expect(a).toMatchObject({ name: "old", size: 7, createdAt: created, legacy: true, expired: false });
    expect(Math.round((Date.parse(a!.expiresAt) - Date.now()) / DAY)).toBe(80);
    expect(f.sql.exec("SELECT count(*) AS n FROM artifacts").one()).toEqual({ n: 0 });
  });
});

describe("workflow permission settings", () => {
  it("audit each change, marking those made through the API", () => {
    const sql = sqlStorage();
    sql.exec(REPO_SCHEMA);
    const events: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const repo = { sql, meta: { owner: "acme", name: "app" }, emit: (e: { action: string; detail: Record<string, unknown> }) => events.push(e) };
    const policy = new TokenPolicy(repo as unknown as RepoDO);
    const admin = { id: "u1", login: "ada", kind: "user", role: "admin" } as Caller;
    policy.setSettings({ defaultPermissions: "read" }, admin, { via: "api" });
    // The web settings page calls it without `via`.
    policy.setSettings({ canApprovePullRequests: true }, admin);
    expect(events.map((e) => [e.action, e.detail])).toEqual([
      ["repo.actions_workflow_settings", { defaultPermissions: "read", canApprovePullRequests: false, agentRunSecrets: false, via: "api" }],
      ["repo.actions_workflow_settings", { defaultPermissions: "read", canApprovePullRequests: true, agentRunSecrets: false }],
    ]);
  });
});

describe("an older runner's cache", () => {
  const DAY = 86400_000;
  it("drops entries unused for a week, with their objects", async () => {
    const f = runtimeFixture();
    const j = f.job("refs/heads/main");
    expect(await f.actions.cacheSaved(j, "djt_tok", "old", 10)).toEqual([]);
    expect(await f.actions.cacheSaved(j, "djt_tok", "recent", 10)).toEqual([]);
    f.sql.exec("UPDATE caches SET last_used = ? WHERE key = ?", new Date(Date.now() - 8 * DAY).toISOString(), "refs/heads/main\nold");
    f.sql.exec("UPDATE caches SET last_used = ? WHERE key = ?", new Date(Date.now() - 6 * DAY).toISOString(), "refs/heads/main\nrecent");
    expect(await f.actions.cacheSaved(j, "djt_tok", "new", 10)).toEqual(legacyCacheKeys("r", "refs/heads/main\nold"));
    expect(f.sql.exec("SELECT key FROM caches ORDER BY key").toArray()).toEqual([{ key: "refs/heads/main\nnew" }, { key: "refs/heads/main\nrecent" }]);
  });
});

describe("hosted runner slots", () => {
  it("a repository runs at most SHARE hosted jobs at once; the rest wait their turn", async () => {
    const sql = sqlStorage();
    sql.exec(REPO_SCHEMA);
    migrateRepoSchema(sql as unknown as SqlStorage);
    const started: string[] = [];
    const repo = {
      sql,
      meta: { repoId: "r", owner: "acme", name: "app", defaultBranch: "main" },
      upsertCheck: () => {},
      broadcast: () => {},
      deploys: { jobCompleted: () => {} },
      runtime: { sweepJob: async () => {} },
      alarmBy: () => {},
    } as unknown as RepoDO;
    const env = {
      PUBLIC_URL: "https://d.test",
      BUCKET: memoryBucket().bucket,
      RUNNER: { idFromName: (n: string) => n, get: (n: string) => ({ startJob: async () => void started.push(n), stopJob: async () => {} }) },
      RUN_WORKFLOW: { get: async () => ({ sendEvent: async () => {} }) },
    } as unknown as Env;
    const actions = new Actions(repo, env);
    const t = new Date().toISOString();
    sql.exec("INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, event_payload) VALUES ('run1', 1, 'w.yml', 'w', 'push', 'refs/heads/main', 'abc', '{}', 'in_progress', ?, ?, '{}')", t, t);
    for (let i = 0; i < SHARE + 2; i++) sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES (?, 'run1', ?, ?, 'queued')", `j${i}`, `k${i}`, `k${i}`);
    const launch = (id: string) => (actions as unknown as { launch(id: string): Promise<void> }).launch(id);
    for (let i = 0; i < SHARE + 2; i++) await launch(`j${i}`);
    expect(started).toHaveLength(SHARE);
    const held = () => sql.exec("SELECT id FROM jobs WHERE fleet_held = 1 AND status = 'queued' ORDER BY rowid").toArray().map((r) => r.id);
    expect(held()).toEqual([`j${SHARE}`, `j${SHARE + 1}`]);
    // A finished job hands its slot to the oldest one waiting.
    await (actions as unknown as { completeJob(id: string, c: unknown): Promise<void> }).completeJob("j0", { conclusion: "success", outputs: {} });
    expect(started).toHaveLength(SHARE + 1);
    expect(started.at(-1)).toBe(`job-j${SHARE}`);
    expect(held()).toEqual([`j${SHARE + 1}`]);
  });

  it("a job whose container gets no machine waits and starts again, and fails only after MAX_PLACEMENT_TRIES", async () => {
    const sql = sqlStorage();
    sql.exec(REPO_SCHEMA);
    migrateRepoSchema(sql as unknown as SqlStorage);
    let full = true;
    let startError = "there is no container instance that can be provided to this durable object";
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const repo = {
      sql,
      meta: { repoId: "r", owner: "acme", ownerId: "acme", name: "app", defaultBranch: "main" },
      upsertCheck: () => {},
      broadcast: () => {},
      deploys: { jobCompleted: () => {} },
      runtime: { sweepJob: async () => {} },
      alarmBy: () => {},
    } as unknown as RepoDO;
    const DB = testD1();
    DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, created_at) VALUES ('acme', 'acme', 'org', 'active', ?)").run(new Date().toISOString());
    const running = () => DB.sqlite.prepare("SELECT id FROM compute_usage WHERE ended_at IS NULL").all();
    const env = {
      DB,
      PUBLIC_URL: "https://d.test",
      BUCKET: memoryBucket().bucket,
      RUNNER: {
        idFromName: (n: string) => n,
        get: () => ({
          startJob: async () => {
            if (full) throw new Error(startError);
          },
          stopJob: async () => {},
        }),
      },
      RUN_WORKFLOW: { get: async () => ({ sendEvent: async (e: { type: string; payload: Record<string, unknown> }) => void events.push(e) }) },
    } as unknown as Env;
    const actions = new Actions(repo, env);
    const t = new Date().toISOString();
    sql.exec("INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, event_payload) VALUES ('run1', 1, 'w.yml', 'w', 'push', 'refs/heads/main', 'abc', '{}', 'in_progress', ?, ?, '{}')", t, t);
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('j1', 'run1', 'k', 'k', 'queued'), ('j2', 'run1', 'k2', 'k2', 'queued')");
    const launch = (id: string) => (actions as unknown as { launch(id: string): Promise<void> }).launch(id);
    const job = (id: string) => sql.exec("SELECT status, conclusion, container, placement_tries FROM jobs WHERE id = ?", id).toArray()[0];

    // No machine: the job goes back in line and the run's workflow is asked to start it again after a pause.
    await launch("j1");
    expect(job("j1")).toMatchObject({ status: "queued", conclusion: null, container: null, placement_tries: 1 });
    expect(events).toEqual([{ type: "job-j1", payload: { retryInSeconds: placementDelay(1) } }]);
    // Its log says why it waits.
    const log = (id: string) => sql.exec<{ text: string }>("SELECT text FROM logs WHERE job_id = ? ORDER BY seq", id).toArray().map((l) => l.text);
    expect(log("j1")).toEqual([`##[warning]No hosted runner could start the job yet: ${startError}. Diffinery tries again in ${placementDelay(1)} s (wait 1 of ${MAX_PLACEMENT_TRIES}).`]);
    // While it waits it isn't running, so it holds none of the account's hosted jobs (lib/quotas.ts).
    expect(running()).toEqual([]);

    // Its container stopping before the runner reported in counts the same way; a started job's loss doesn't.
    full = false;
    await actions.relaunchJob("j1");
    // Each placement after a runner that never started is in a new container object.
    expect(job("j1")).toMatchObject({ status: "waiting", container: "job-j1-p1" });
    expect(running()).toEqual([{ id: "j1" }]);
    // The first such stop starts it again after QUICK_RETRY_SECONDS, uncounted; another one waits as usual.
    await actions.containerStopped("j1", null);
    expect(job("j1")).toMatchObject({ status: "queued", placement_tries: 1 });
    expect(events.at(-1)).toEqual({ type: "job-j1", payload: { retryInSeconds: QUICK_RETRY_SECONDS } });
    expect(log("j1").at(-1)).toBe(`##[warning]No hosted runner could start the job yet: the container stopped before the runner started. Diffinery tries again in ${QUICK_RETRY_SECONDS} s (not counted: the first failure like this is retried at once).`);
    expect(running()).toEqual([]);
    await actions.relaunchJob("j1");
    expect(job("j1")).toMatchObject({ status: "waiting", container: "job-j1-p2" });
    await actions.containerStopped("j1", 0);
    expect(job("j1")).toMatchObject({ status: "queued", placement_tries: 2 });
    expect(events.at(-1)).toEqual({ type: "job-j1", payload: { retryInSeconds: placementDelay(2) } });
    expect(log("j1").at(-1)).toMatch(/: the container stopped before the runner started\. Diffinery tries again in 60 s \(wait 2 of \d+\)\.$/);
    expect(running()).toEqual([]);
    // The same when the runner exits with a code before it fetched the job; and a container that
    // exits after the job went back in line (its token revoked) leaves the job in line.
    await actions.relaunchJob("j1");
    await actions.containerStopped("j1", 2);
    expect(job("j1")).toMatchObject({ status: "queued", conclusion: null, placement_tries: 3 });
    await actions.containerStopped("j1", 2);
    expect(job("j1")).toMatchObject({ status: "queued", conclusion: null, placement_tries: 3 });
    await launch("j2");
    sql.exec("UPDATE jobs SET status = 'in_progress' WHERE id = 'j2'");
    await actions.containerStopped("j2", 1);
    expect(job("j2")).toMatchObject({ status: "completed", conclusion: "failure", placement_tries: 0 });

    // A container sidecar restarting under the start counts the same way; an error that won't go away fails the job.
    full = true;
    startError = "Container sidecar is shutting down";
    await actions.relaunchJob("j1");
    expect(job("j1")).toMatchObject({ status: "queued", conclusion: null, placement_tries: 4 });
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('j3', 'run1', 'k3', 'k3', 'queued')");
    startError = "image not found";
    await launch("j3");
    expect(job("j3")).toMatchObject({ status: "completed", conclusion: "failure", placement_tries: 0 });
    expect(sql.exec("SELECT failure FROM jobs WHERE id = 'j3'").one().failure).toMatch(/Could not start a runner: image not found/);

    // Past the limit it fails, and says why.
    startError = "there is no container instance that can be provided to this durable object";
    for (let i = 4; i < MAX_PLACEMENT_TRIES; i++) await actions.relaunchJob("j1");
    expect(job("j1")).toMatchObject({ status: "queued", placement_tries: MAX_PLACEMENT_TRIES });
    await actions.relaunchJob("j1");
    expect(job("j1")).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(sql.exec("SELECT failure FROM jobs WHERE id = 'j1'").one().failure).toMatch(/No hosted runner could be started/);
    expect([1, 2, 3, 4, 5, 6].map(placementDelay)).toEqual([30, 60, 120, 240, 300, 300]);
  });

  it("a start the runtime fails for a passing reason is retried, and never once the job's runner fetched it", async () => {
    const sql = sqlStorage();
    sql.exec(REPO_SCHEMA);
    migrateRepoSchema(sql as unknown as SqlStorage);
    let fail: (() => Error) | null = null;
    let token = "";
    let workflowDown = false;
    const alarms: number[] = [];
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const repo = {
      sql,
      meta: { repoId: "r", owner: "acme", ownerId: "acme", name: "app", defaultBranch: "main" },
      upsertCheck: () => {},
      broadcast: () => {},
      deploys: { jobCompleted: () => {} },
      runtime: { sweepJob: async () => {}, grantFor: () => ({ role: "write", permissions: {} }) },
      alarmBy: (at: number) => void alarms.push(at),
    } as unknown as RepoDO;
    const DB = testD1();
    DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, created_at) VALUES ('acme', 'acme', 'org', 'active', ?)").run(new Date().toISOString());
    const env = {
      DB,
      PUBLIC_URL: "https://d.test",
      BUCKET: memoryBucket().bucket,
      RUNNER: {
        idFromName: (n: string) => n,
        get: () => ({
          startJob: async (input: { token: string }) => {
            token = input.token;
            if (fail) throw fail();
          },
          stopJob: async () => {},
        }),
      },
      RUN_WORKFLOW: {
        get: async () => ({
          sendEvent: async (e: { type: string; payload: Record<string, unknown> }) => {
            if (workflowDown) throw new Error("internal error; reference = w");
            events.push(e);
          },
        }),
      },
    } as unknown as Env;
    const actions = new Actions(repo, env);
    const t = new Date().toISOString();
    sql.exec("INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, event_payload) VALUES ('run1', 1, 'w.yml', 'w', 'push', 'refs/heads/main', 'abc', '{}', 'in_progress', ?, ?, '{}')", t, t);
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('j1', 'run1', 'k', 'k', 'queued'), ('j2', 'run1', 'k2', 'k2', 'queued'), ('j3', 'run1', 'k3', 'k3', 'queued')");
    const launch = (id: string) => (actions as unknown as { launch(id: string): Promise<void> }).launch(id);
    const job = (id: string) => sql.exec("SELECT status, conclusion, container, placement_tries, early_stops FROM jobs WHERE id = ?", id).toArray()[0];
    const log = (id: string) => sql.exec<{ text: string }>("SELECT text FROM logs WHERE job_id = ? ORDER BY seq", id).toArray().map((l) => l.text);

    // The runtime's own internal error (seen on a real job, which a re-run then started at once): the first
    // one starts the job again after QUICK_RETRY_SECONDS, not counted; the next waits like a full platform.
    fail = () => new Error("internal error; reference = p80sjrfoqg66qdlk07p2qlco");
    await launch("j1");
    expect(job("j1")).toMatchObject({ status: "queued", conclusion: null, container: null, placement_tries: 0, early_stops: 1 });
    expect(events.at(-1)).toEqual({ type: "job-j1", payload: { retryInSeconds: QUICK_RETRY_SECONDS } });
    expect(log("j1").at(-1)).toBe(`##[warning]No hosted runner could start the job yet: internal error; reference = p80sjrfoqg66qdlk07p2qlco. Diffinery tries again in ${QUICK_RETRY_SECONDS} s (not counted: the first failure like this is retried at once).`);
    await actions.relaunchJob("j1");
    expect(job("j1")).toMatchObject({ status: "queued", placement_tries: 1 });
    expect(events.at(-1)).toEqual({ type: "job-j1", payload: { retryInSeconds: placementDelay(1) } });
    // A Durable Object the runtime replaced under the start, and any error the runtime marks retryable, go back in line too.
    fail = () => new Error("Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.");
    await actions.relaunchJob("j1");
    expect(job("j1")).toMatchObject({ status: "queued", conclusion: null, placement_tries: 2 });
    fail = () => new Error("out of memory: SQLITE_NOMEM");
    await actions.relaunchJob("j1");
    expect(job("j1")).toMatchObject({ status: "queued", conclusion: null, placement_tries: 3 });
    fail = () => Object.assign(new Error("something the runtime hasn't said before"), { retryable: true });
    await actions.relaunchJob("j1");
    expect(job("j1")).toMatchObject({ status: "queued", conclusion: null, placement_tries: 4 });
    // The retries stay bounded.
    for (let i = 4; i < MAX_PLACEMENT_TRIES; i++) await actions.relaunchJob("j1");
    expect(job("j1")).toMatchObject({ status: "queued", placement_tries: MAX_PLACEMENT_TRIES });
    await actions.relaunchJob("j1");
    expect(job("j1")).toMatchObject({ status: "completed", conclusion: "failure" });

    // A start that reports a failure after the job's runner fetched it leaves the job running: it isn't
    // started again, nor failed under the runner.
    fail = () => {
      sql.exec("UPDATE jobs SET status = 'in_progress' WHERE id = 'j2'");
      return new Error("internal error; reference = x");
    };
    await launch("j2");
    expect(job("j2")).toMatchObject({ status: "in_progress", conclusion: null, container: "job-j2", placement_tries: 0, early_stops: 0 });
    fail = () => {
      sql.exec("UPDATE jobs SET status = 'in_progress' WHERE id = 'j3'");
      return new Error("image not found");
    };
    await launch("j3");
    expect(job("j3")).toMatchObject({ status: "in_progress", conclusion: null });

    // When the run's workflow can't be told to start the job again, this object does, from its alarm.
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('j5', 'run1', 'k5', 'k5', 'queued')");
    workflowDown = true;
    fail = () => new Error("internal error; reference = z");
    const before = Date.now();
    await launch("j5");
    expect(job("j5")).toMatchObject({ status: "queued", conclusion: null, early_stops: 1 });
    const at = actions.nextImageRetry()!;
    expect(at).toBeGreaterThanOrEqual(before + QUICK_RETRY_SECONDS * 1000);
    expect(alarms.at(-1)).toBe(at);
    workflowDown = false;
    fail = null;
    await actions.relaunchImageHeld(at);
    expect(job("j5")).toMatchObject({ status: "waiting", container: "job-j5-p1" });
    // The workflow's own start, if its event got through after all, finds it started and does nothing.
    await actions.relaunchJob("j5");
    expect(job("j5")).toMatchObject({ status: "waiting", container: "job-j5-p1" });
    // The object the failed start was in is a different one: a container that comes up there after all,
    // and stops when its revoked token is refused, leaves the new placement alone.
    await actions.containerStopped("j5", 1, "job-j5");
    expect(job("j5")).toMatchObject({ status: "waiting", container: "job-j5-p1" });

    // And the other way round: a runner whose job went back in line while it fetched the job (its start
    // was reported failed) is turned away before the job is marked started, so only the next runner runs it.
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('j4', 'run1', 'k4', 'k4', 'queued')");
    fail = null;
    await launch("j4");
    const a = actions as unknown as { expanded: unknown; callContext: unknown; placementFailed(id: string, why: string): Promise<void> };
    a.expanded = async () => ({ workflow: { jobs: { k4: { steps: [] } } }, workflowOf: new Map([["k4", { env: {} }]]), parentOf: new Map(), needs: new Map() });
    a.callContext = async () => {
      await a.placementFailed("j4", "internal error; reference = y");
      return { inputs: {}, secrets: {} };
    };
    await expect(actions.runnerSpec("j4", token)).rejects.toMatchObject({ status: 409 });
    expect(job("j4")).toMatchObject({ status: "queued", conclusion: null, placement_tries: 1 });
  });

  it("a matrix leg back in line after getting no machine waits out its pause when a sibling finishes", async () => {
    const sql = sqlStorage();
    sql.exec(REPO_SCHEMA);
    migrateRepoSchema(sql as unknown as SqlStorage);
    let full = true;
    const started: string[] = [];
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const repo = {
      sql,
      meta: { repoId: "r", owner: "acme", ownerId: "acme", name: "app", defaultBranch: "main" },
      upsertCheck: () => {},
      broadcast: () => {},
      deploys: { jobCompleted: () => {} },
      runtime: { sweepJob: async () => {} },
      alarmBy: () => {},
    } as unknown as RepoDO;
    const DB = testD1();
    DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, created_at) VALUES ('acme', 'acme', 'org', 'active', ?)").run(new Date().toISOString());
    const env = {
      DB,
      PUBLIC_URL: "https://d.test",
      BUCKET: memoryBucket().bucket,
      RUNNER: {
        idFromName: (n: string) => n,
        get: (n: string) => ({
          startJob: async () => {
            started.push(n);
            if (full) throw new Error("there is no container instance that can be provided to this durable object");
          },
          stopJob: async () => {},
        }),
      },
      RUN_WORKFLOW: { get: async () => ({ sendEvent: async (e: { type: string; payload: Record<string, unknown> }) => void events.push(e) }) },
    } as unknown as Env;
    const actions = new Actions(repo, env);
    const a = actions as unknown as { launch(id: string): Promise<void>; completeJob(id: string, c: unknown): Promise<void> };
    const t = new Date().toISOString();
    sql.exec("INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, event_payload) VALUES ('run1', 1, 'w.yml', 'w', 'push', 'refs/heads/main', 'abc', '{}', 'in_progress', ?, ?, '{}')", t, t);
    // Legs of one matrix: m1 and m2 started, m3 not yet (max-parallel).
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('m1', 'run1', 'm', 'm (1)', 'queued'), ('m2', 'run1', 'm', 'm (2)', 'queued'), ('m4', 'run1', 'm', 'm (4)', 'queued'), ('m3', 'run1', 'm', 'm (3)', 'queued')");
    // m4 is back in line after a safe restart (its runner was replaced before its steps ran).
    sql.exec("UPDATE jobs SET restarts = 1 WHERE id = 'm4'");
    const job = (id: string) => sql.exec("SELECT status, placement_tries FROM jobs WHERE id = ?", id).toArray()[0];
    await a.launch("m1");
    expect(job("m1")).toMatchObject({ status: "queued", placement_tries: 1 });
    full = false;
    await a.launch("m2");
    expect(job("m2")).toMatchObject({ status: "waiting" });
    started.length = 0;

    // m2 finishing starts the leg that never started, not the ones back in line: those are started
    // again by the run's workflow, so each try still waits its turn (placementDelay).
    await a.completeJob("m2", { conclusion: "success", outputs: {} });
    expect(started).toEqual(["job-m3"]);
    expect(job("m1")).toMatchObject({ status: "queued", placement_tries: 1 });
    expect(job("m4")).toMatchObject({ status: "queued" });
    expect(events.filter((e) => e.type === "job-m1")).toHaveLength(1);
  });

  it("a hosted runner on an image other than the deployed one is turned away and the job starts again every STALE_IMAGE_RETRY_SECONDS, up to STALE_IMAGE_TRIES", async () => {
    const sql = sqlStorage();
    sql.exec(REPO_SCHEMA);
    migrateRepoSchema(sql as unknown as SqlStorage);
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const repo = {
      sql,
      meta: { repoId: "r", owner: "acme", ownerId: "acme", name: "app", defaultBranch: "main" },
      upsertCheck: () => {},
      broadcast: () => {},
      deploys: { jobCompleted: () => {} },
      runtime: { sweepJob: async () => {} },
      alarmBy: (at: number) => void alarms.push(at),
    } as unknown as RepoDO;
    const alarms: number[] = [];
    const DB = testD1();
    DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, created_at) VALUES ('acme', 'acme', 'org', 'active', ?)").run(new Date().toISOString());
    const env = {
      DB,
      PUBLIC_URL: "https://d.test",
      RUNNER_IMAGE: "diffinery-runner:new",
      RUNNER: { idFromName: (n: string) => n, get: () => ({ startJob: async () => {}, stopJob: async () => {} }) },
      RUN_WORKFLOW: { get: async () => ({ sendEvent: async (e: { type: string; payload: Record<string, unknown> }) => void events.push(e) }) },
    } as unknown as Env;
    const actions = new Actions(repo, env);
    const t = new Date().toISOString();
    sql.exec("INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, event_payload) VALUES ('run1', 1, 'w.yml', 'w', 'push', 'refs/heads/main', 'abc', '{}', 'in_progress', ?, ?, '{}')", t, t);
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('j1', 'run1', 'k', 'k', 'queued'), ('s1', 'run1', 's', 's', 'waiting'), ('j2', 'run1', 'k2', 'k2', 'queued')");
    sql.exec("UPDATE jobs SET labels = '[\"self-hosted\"]' WHERE id = 's1'");
    const a = actions as unknown as { launch(id: string): Promise<void>; refuseStaleRunner(job: unknown, runner: unknown, deployed?: string): Promise<void>; jobRow(id: string): unknown };
    const refuse = (id: string, image?: string, deployed?: string) => a.refuseStaleRunner(a.jobRow(id), image ? { image } : null, deployed);
    const job = (id = "j1") => sql.exec("SELECT status, placement_tries, stale_tries FROM jobs WHERE id = ?", id).toArray()[0];
    const logs = () => sql.exec<{ text: string }>("SELECT text FROM logs WHERE job_id = 'j1' ORDER BY seq").toArray().map((l) => l.text);

    await a.launch("j1");
    // The deployed image runs the job.
    await expect(refuse("j1", "diffinery-runner:new")).resolves.toBeUndefined();
    expect(job()).toMatchObject({ status: "waiting", placement_tries: 0 });
    // The previous image (or one that doesn't say) is turned away. The job starts again after a short fixed
    // wait, from this object's alarm rather than the run's workflow, and the waits don't count as placement tries.
    for (let i = 0; i < STALE_IMAGE_TRIES; i++) {
      const before = Date.now();
      await expect(refuse("j1", i === 1 ? undefined : "diffinery-runner:old")).rejects.toMatchObject({ status: 409 });
      expect(job()).toMatchObject({ status: "queued", placement_tries: 0, stale_tries: i + 1 });
      const at = actions.nextImageRetry()!;
      expect(at).toBeGreaterThanOrEqual(before + STALE_IMAGE_RETRY_SECONDS * 1000);
      expect(alarms.at(-1)).toBe(at);
      // Not before its time.
      await actions.relaunchImageHeld(at - 1);
      expect(job()).toMatchObject({ status: "queued" });
      await actions.relaunchImageHeld(at);
      expect(job()).toMatchObject({ status: "waiting" });
      expect(actions.nextImageRetry()).toBeNull();
    }
    expect(events).toEqual([]);
    expect(logs()[0]).toBe(`##[warning]No hosted runner could start the job yet: a runner started on diffinery-runner:old while the deploy of diffinery-runner:new was rolling out. Diffinery tries again in ${STALE_IMAGE_RETRY_SECONDS} s (rollout wait 1 of ${STALE_IMAGE_TRIES}, not counted).`);
    // A rollout that doesn't finish doesn't hold the job up past STALE_IMAGE_TRIES.
    await expect(refuse("j1", "diffinery-runner:old")).resolves.toBeUndefined();
    // A job cancelled while it waits isn't started again.
    sql.exec("UPDATE jobs SET status = 'queued', image_retry_at = 1 WHERE id = 'j1'");
    sql.exec("UPDATE jobs SET status = 'completed' WHERE id = 'j1'");
    await actions.relaunchImageHeld();
    expect(job()).toMatchObject({ status: "completed" });
    // Self-hosted runners run any image.
    await expect(refuse("s1", "my-image")).resolves.toBeUndefined();

    // Right after a deploy this object can still run the previous version (its RUNNER_IMAGE is the
    // old one) while the Worker that took the runner's request has the new one: the Worker's wins.
    await a.launch("j2");
    await expect(refuse("j2", "diffinery-runner:next", "diffinery-runner:next")).resolves.toBeUndefined();
    expect(job("j2")).toMatchObject({ status: "waiting", placement_tries: 0 });
    await expect(refuse("j2", "diffinery-runner:new", "diffinery-runner:next")).rejects.toMatchObject({ status: 409 });
    expect(job("j2")).toMatchObject({ status: "queued", stale_tries: 1 });
  });

  it("a running job whose runner froze is ended at its timeout plus JOB_DEADLINE_GRACE_MS, and a healthy one is left alone", async () => {
    const sql = sqlStorage();
    sql.exec(REPO_SCHEMA);
    migrateRepoSchema(sql as unknown as SqlStorage);
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const stopped: string[] = [];
    const repo = {
      sql,
      meta: { repoId: "r", owner: "acme", ownerId: "acme", name: "app", defaultBranch: "main" },
      upsertCheck: () => {},
      broadcast: () => {},
      deploys: { jobCompleted: () => {} },
      runtime: { sweepJob: async () => {} },
      alarmBy: () => {},
    } as unknown as RepoDO;
    const env = {
      PUBLIC_URL: "https://d.test",
      BUCKET: memoryBucket().bucket,
      RUNNER: { idFromName: (n: string) => n, get: (n: string) => ({ startJob: async () => {}, stopJob: async () => void stopped.push(n) }) },
      RUN_WORKFLOW: { get: async () => ({ sendEvent: async (e: { type: string; payload: Record<string, unknown> }) => void events.push(e) }) },
    } as unknown as Env;
    const actions = new Actions(repo, env);
    const t0 = Date.parse("2026-10-16T12:00:00Z");
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    sql.exec("INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, event_payload) VALUES ('run1', 1, 'w.yml', 'w', 'push', 'refs/heads/main', 'abc', '{}', 'in_progress', ?, ?, '{}')", at(0), at(0));
    // Each runner fetched its job at t0 (started_at). f: frozen, timeout 10 min; h: healthy, timeout 30;
    // d: no timeout of its own (6 hours); s: on a self-hosted runner, frozen too; q: still in line; c: finished.
    const add = (id: string, minutes: number | null, o: { status?: string; container?: string | null; started?: string | null } = {}) =>
      sql.exec(
        "INSERT INTO jobs (id, run_id, job_key, name, status, timeout_minutes, container, started_at, strategy) VALUES (?, 'run1', ?, ?, ?, ?, ?, ?, '{\"fail-fast\":false}')",
        id, id, id, o.status ?? "in_progress", minutes, o.container === undefined ? `job-${id}` : o.container, o.started === undefined ? at(0) : o.started,
      );
    add("f", 10);
    add("h", 30);
    add("d", 0);
    add("s", 10, { container: "self-hosted:box" });
    add("q", 10, { status: "queued", container: null, started: null });
    add("c", 10, { status: "completed" });
    const job = (id: string) => sql.exec<{ status: string; conclusion: string | null; failure: string | null }>("SELECT status, conclusion, failure FROM jobs WHERE id = ?", id).one();
    const min = 60_000;
    expect(actions.nextJobDeadline()).toBe(t0 + 10 * min + JOB_DEADLINE_GRACE_MS);

    // Past f's timeout but within the grace its runner has to stop the steps and report: nothing happens.
    await actions.enforceJobDeadlines(t0 + 10 * min + JOB_DEADLINE_GRACE_MS - 1);
    expect(["f", "h", "d", "s"].map((id) => job(id).status)).toEqual(["in_progress", "in_progress", "in_progress", "in_progress"]);
    expect(stopped).toEqual([]);

    // At the deadline the frozen ones end: the hosted container is stopped, both fail as timed out.
    await actions.enforceJobDeadlines(t0 + 10 * min + JOB_DEADLINE_GRACE_MS);
    for (const id of ["f", "s"]) {
      expect(job(id)).toMatchObject({ status: "completed", conclusion: "timed_out" });
      expect(JSON.parse(job(id).failure!).message).toBe(`The job exceeded its timeout of 10 minutes, and its runner stopped responding: Diffinery ended it ${JOB_DEADLINE_GRACE_MS / min} minutes later.`);
    }
    expect(stopped).toEqual(["job-f"]);
    expect(events.filter((e) => e.type === "job-f")).toEqual([{ type: "job-f", payload: { conclusion: "timed_out" } }]);
    // The others are untouched, and the next wake-up is h's deadline.
    expect([job("h").status, job("d").status, job("q").status, job("c").status]).toEqual(["in_progress", "in_progress", "queued", "completed"]);
    expect(actions.nextJobDeadline()).toBe(t0 + 30 * min + JOB_DEADLINE_GRACE_MS);
    // A job without timeout-minutes gets GitHub's 6 hours.
    await actions.enforceJobDeadlines(t0 + 360 * min + JOB_DEADLINE_GRACE_MS - 1);
    expect(job("d").status).toBe("in_progress");
    await actions.enforceJobDeadlines(t0 + 360 * min + JOB_DEADLINE_GRACE_MS);
    expect(job("d")).toMatchObject({ status: "completed", conclusion: "timed_out" });
    expect(actions.nextJobDeadline()).toBeNull();
  });

  it("cancelling a run lets running hosted jobs run their steps that run after a cancel, and ends them after CANCEL_STOP_MS", async () => {
    const sql = sqlStorage();
    sql.exec(REPO_SCHEMA);
    migrateRepoSchema(sql as unknown as SqlStorage);
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const stopped: [string, boolean][] = [];
    const alarms: number[] = [];
    const repo = {
      sql,
      meta: { repoId: "r", owner: "acme", ownerId: "acme", name: "app", defaultBranch: "main" },
      upsertCheck: () => {},
      broadcast: () => {},
      deploys: { jobCompleted: () => {} },
      runtime: { sweepJob: async () => {}, grantFor: () => ({ role: "read", permissions: {} }) },
      alarmBy: (at: number) => void alarms.push(at),
    } as unknown as RepoDO;
    const env = {
      PUBLIC_URL: "https://d.test",
      BUCKET: memoryBucket().bucket,
      RUNNER: { idFromName: (n: string) => n, get: (n: string) => ({ startJob: async () => {}, stopJob: async (graceful = false) => void stopped.push([n, graceful]) }) },
      RUN_WORKFLOW: { get: async () => ({ sendEvent: async (e: { type: string; payload: Record<string, unknown> }) => void events.push(e) }) },
    } as unknown as Env;
    const actions = new Actions(repo, env);
    const t = new Date().toISOString();
    sql.exec("INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, event_payload) VALUES ('run1', 1, 'w.yml', 'w', 'push', 'refs/heads/main', 'abc', '{}', 'in_progress', ?, ?, '{}')", t, t);
    // a and b run on hosted runners (a reports after its cleanup steps, b's runner never does); s runs
    // on a self-hosted runner; w's container hasn't fetched the job yet; q waits in line.
    const token = (id: string) => `djt_r_${id}_secret`;
    const add = async (id: string, status: string, container: string | null) =>
      sql.exec(
        "INSERT INTO jobs (id, run_id, job_key, name, status, timeout_minutes, container, started_at, token_hash, token_at, strategy) VALUES (?, 'run1', ?, ?, ?, 60, ?, ?, ?, ?, '{\"fail-fast\":false}')",
        id, id, id, status, container, status === "in_progress" ? t : null, await sha256(token(id)), t,
      );
    await add("a", "in_progress", "job-a");
    await add("b", "in_progress", "job-b");
    await add("s", "in_progress", "self-hosted:box");
    await add("w", "waiting", "job-w");
    await add("q", "queued", null);
    const job = (id: string) => sql.exec<{ status: string; conclusion: string | null; failure: string | null }>("SELECT status, conclusion, failure FROM jobs WHERE id = ?", id).one();
    const before = Date.now();
    await actions.cancel("run1", { kind: "user", login: "octo", role: "write" } as unknown as Caller);
    // a and b get SIGINT and keep running; the rest end at once, w's container stopped outright.
    expect(stopped).toEqual([["job-a", true], ["job-b", true], ["job-w", false]]);
    expect([job("a").status, job("b").status]).toEqual(["in_progress", "in_progress"]);
    for (const id of ["s", "w", "q"]) expect(job(id)).toMatchObject({ status: "completed", conclusion: "cancelled", failure: JSON.stringify({ message: "Cancelled by octo" }) });
    expect(alarms.at(-1)).toBeGreaterThanOrEqual(before + CANCEL_STOP_MS);
    const deadline = actions.nextJobDeadline()!;
    expect(deadline - before).toBeGreaterThanOrEqual(CANCEL_STOP_MS);
    expect(deadline - Date.now()).toBeLessThanOrEqual(CANCEL_STOP_MS);
    // a's runner reports once its cleanup steps ran: cancelled, saying who cancelled it, never started again.
    await actions.runnerComplete("a", token("a"), { conclusion: "cancelled", outputs: {}, failure: { message: "The job was cancelled." }, replaced: true });
    expect(job("a")).toMatchObject({ status: "completed", conclusion: "cancelled", failure: JSON.stringify({ message: "Cancelled by octo" }) });

    // b's runner never reports: at CANCEL_STOP_MS its container is stopped and the job ends.
    await actions.enforceJobDeadlines(deadline - 1);
    expect(job("b").status).toBe("in_progress");
    await actions.enforceJobDeadlines(deadline);
    expect(stopped.at(-1)).toEqual(["job-b", false]);
    expect(job("b").conclusion).toBe("cancelled");
    expect(JSON.parse(job("b").failure!).message).toBe(`Cancelled by octo. Its runner didn't report within ${CANCEL_STOP_MS / 60_000} minutes of the cancel, so Diffinery stopped it.`);
    expect(actions.nextJobDeadline()).toBeNull();
  });

  it("cancelling a cancelled run again stops its jobs at once, and a cancelled job whose container stops before its runner reports ends as cancelled", async () => {
    const sql = sqlStorage();
    sql.exec(REPO_SCHEMA);
    migrateRepoSchema(sql as unknown as SqlStorage);
    const repo = {
      sql,
      meta: { repoId: "r", owner: "acme", ownerId: "acme", name: "app", defaultBranch: "main" },
      upsertCheck: () => {},
      broadcast: () => {},
      deploys: { jobCompleted: () => {} },
      runtime: { sweepJob: async () => {} },
      alarmBy: () => {},
    } as unknown as RepoDO;
    const env = {
      PUBLIC_URL: "https://d.test",
      BUCKET: memoryBucket().bucket,
      RUNNER_IMAGE: "diffinery-runner:new",
      RUNNER: { idFromName: (n: string) => n, get: (n: string) => ({ startJob: async () => {}, stopJob: async (graceful = false) => void stopped.push([n, graceful]) }) },
      RUN_WORKFLOW: { get: async () => ({ sendEvent: async () => {} }) },
    } as unknown as Env;
    const stopped: [string, boolean][] = [];
    const actions = new Actions(repo, env);
    const t = new Date().toISOString();
    const job = (id: string) => sql.exec("SELECT status, conclusion, failure FROM jobs WHERE id = ?", id).one();
    for (const run of ["run1", "run2"]) sql.exec("INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, event_payload) VALUES (?, 1, 'w.yml', 'w', 'push', 'refs/heads/main', 'abc', '{}', 'in_progress', ?, ?, '{}')", run, t, t);
    // On an older runner image than the deployed one, which would otherwise read as a rollout and start the job again.
    for (const [id, run] of [["j1", "run1"], ["j2", "run2"]]) sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status, container, started_at, runner_info, strategy) VALUES (?, ?, ?, ?, 'in_progress', ?, ?, '{\"image\":\"diffinery-runner:old\"}', '{}')", id, run, id, id, `job-${id}`, t);
    const octo = { kind: "user", login: "octo", role: "write" } as unknown as Caller;
    await actions.cancel("run1", octo);
    await actions.cancel("run1", { kind: "user", login: "hubot", role: "write" } as unknown as Caller);
    expect(stopped).toEqual([["job-j1", true], ["job-j1", false]]);
    expect(job("j1")).toMatchObject({ status: "completed", conclusion: "cancelled", failure: JSON.stringify({ message: "Cancelled by octo" }) });
    await actions.cancel("run2", octo);
    await actions.containerStopped("j2", null, "job-j2", true);
    expect(job("j2")).toMatchObject({ status: "completed", conclusion: "cancelled", failure: JSON.stringify({ message: "Cancelled by octo" }) });
  });

  it("a job whose runner a rollout replaced starts again on a new runner before its steps ran or when it can only read, and fails otherwise", async () => {
    const sql = sqlStorage();
    sql.exec(REPO_SCHEMA);
    migrateRepoSchema(sql as unknown as SqlStorage);
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const swept: [string, boolean][] = [];
    const repo = {
      sql,
      meta: { repoId: "r", owner: "acme", ownerId: "acme", name: "app", defaultBranch: "main" },
      upsertCheck: () => {},
      broadcast: () => {},
      deploys: { jobCompleted: () => {} },
      runtime: { sweepJob: async (id: string, o?: { restart?: boolean }) => void swept.push([id, !!o?.restart]), grantFor: () => ({ role: "read", permissions: {} }) },
      policy: { settings: () => ({ defaultPermissions: "write" }), isForkPull: () => false },
      alarmBy: () => {},
    } as unknown as RepoDO;
    const DB = testD1();
    DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, created_at) VALUES ('acme', 'acme', 'org', 'active', ?)").run(new Date().toISOString());
    const started: { container: string; token: string }[] = [];
    const env = {
      DB,
      PUBLIC_URL: "https://d.test",
      BUCKET: memoryBucket().bucket,
      RUNNER_IMAGE: "diffinery-runner:new",
      RUNNER: { idFromName: (n: string) => n, get: () => ({ startJob: async (i: { container: string; token: string }) => void started.push(i), stopJob: async () => {} }) },
      RUN_WORKFLOW: { get: async () => ({ sendEvent: async (e: { type: string; payload: Record<string, unknown> }) => void events.push(e) }) },
    } as unknown as Env;
    const actions = new Actions(repo, env);
    // The job's steps: checkout, then one whose effects running it twice would repeat.
    // k to k4 get the repository's default token (read and write); the others only read (r1 hands its read-only token to `gh`), unless they name a secret, deploy to an environment or ask for an OIDC token.
    (actions as unknown as { expanded: () => Promise<unknown> }).expanded = async () => {
      const steps = [{ uses: "actions/checkout@v4" }, { run: "make deploy" }];
      const read = { contents: "read" };
      const install = [{ uses: "actions/checkout@v4" }, { run: "pnpm install" }, { run: "pnpm test" }];
      const jobs: Record<string, unknown> = {
        k: { steps },
        k2: { steps },
        k3: { steps },
        k4: { steps },
        r1: { steps: install, permissions: read, env: { GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" } },
        r2: { steps: [...install, { run: "npm publish", env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" } }], permissions: read },
        r3: { steps: install, permissions: read, environment: { name: "production" } },
        r4: { steps: install, permissions: { contents: "read", "id-token": "write" } },
        r5: { steps: [...install, { run: "echo ${{ toJSON(secrets) }}" }], permissions: read },
      };
      const workflow = { env: {}, jobs };
      return { workflow, calls: new Map(), parentOf: new Map(), needs: new Map(), workflowOf: new Map(Object.keys(jobs).map((key) => [key, workflow])) };
    };
    const t = new Date().toISOString();
    sql.exec("INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, event_payload) VALUES ('run1', 1, 'w.yml', 'w', 'push', 'refs/heads/main', 'abc', '{}', 'in_progress', ?, ?, '{}')", t, t);
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('j1', 'run1', 'k', 'k', 'queued'), ('j2', 'run1', 'k2', 'k2', 'queued')");
    const launch = (id: string) => (actions as unknown as { launch(id: string): Promise<void> }).launch(id);
    const job = (id: string) => sql.exec("SELECT status, conclusion, container, token_hash, steps, restarts, failure FROM jobs WHERE id = ?", id).toArray()[0];
    const logs = (id: string) => sql.exec("SELECT seq, step, text FROM logs WHERE job_id = ? ORDER BY seq", id).toArray();
    // The runner fetched the job on `image` and reported these steps as started.
    const running = (id: string, image: string, steps: number[], names = ["Run actions/checkout@v4", "Deploy"]) => {
      const reports = steps.map((index) => ({ index, name: names[index] ?? `Step ${index}`, status: "in_progress", startedAt: t }));
      sql.exec("UPDATE jobs SET status = 'in_progress', started_at = ?, runner_info = ?, steps = ? WHERE id = ?", t, JSON.stringify({ image }), JSON.stringify(reports), id);
      sql.exec("INSERT INTO logs (job_id, seq, t, step, text) VALUES (?, 0, ?, -1, 'set up'), (?, 1, ?, 0, 'checking out')", id, t, id, t);
    };
    const replaced = { conclusion: "cancelled" as const, outputs: {}, replaced: true };

    // The runner reports the replacement during checkout: the job goes back in line, its log starts over with a line that says why.
    await launch("j1");
    const first = started.at(-1)!;
    expect(first.container).toBe("job-j1");
    running("j1", "diffinery-runner:old", [0]);
    await actions.runnerComplete("j1", first.token, replaced);
    expect(job("j1")).toMatchObject({ status: "queued", conclusion: null, container: null, token_hash: null, steps: "[]", restarts: 1 });
    expect(events.at(-1)).toEqual({ type: "job-j1", payload: { retryInSeconds: 10 } });
    expect(logs("j1")).toEqual([{ seq: 2, step: -1, text: expect.stringMatching(/replaced this job's runner.*started the job again from the beginning on a new runner \(restart 1 of 2\)/) }]);
    // The replaced runner can't report any more, and its container stopping changes nothing.
    await expect(actions.runnerComplete("j1", first.token, replaced)).rejects.toMatchObject({ status: 401 });
    await actions.containerStopped("j1", 143, "job-j1");
    expect(job("j1")).toMatchObject({ status: "queued", restarts: 1 });

    // It starts in a new container; the old one stopping late doesn't touch it.
    await actions.relaunchJob("j1");
    expect(started.at(-1)!.container).toBe("job-j1-r1");
    await actions.containerStopped("j1", 143, "job-j1");
    expect(job("j1")).toMatchObject({ status: "waiting", container: "job-j1-r1" });

    // A container on a replaced image that stops without reporting counts the same.
    running("j1", "diffinery-runner:old", []);
    await actions.containerStopped("j1", 143, "job-j1-r1");
    expect(job("j1")).toMatchObject({ status: "queued", restarts: 2 });

    // Past MAX_RUNNER_RESTARTS the job fails, and says why.
    await actions.relaunchJob("j1");
    expect(started.at(-1)!.container).toBe("job-j1-r2");
    running("j1", "diffinery-runner:old", []);
    await actions.runnerComplete("j1", started.at(-1)!.token, replaced);
    expect(job("j1")).toMatchObject({ status: "completed", conclusion: "failure", restarts: MAX_RUNNER_RESTARTS });
    expect(JSON.parse(job("j1")!.failure as string).message).toMatch(/replaced this job's runner with a new version before the job's steps ran, 3 times\. Re-run the job\./);

    // Once a step other than checkout ran, the job isn't started again: it fails and names the step.
    await launch("j2");
    running("j2", "diffinery-runner:old", [0, 1]);
    await actions.runnerComplete("j2", started.at(-1)!.token, replaced);
    expect(job("j2")).toMatchObject({ status: "completed", conclusion: "failure", restarts: 0 });
    expect(JSON.parse(job("j2")!.failure as string).message).toMatch(/while step "Deploy" ran\. Diffinery doesn't start a job again by itself once its steps have run if it could change something outside the run/);

    // A job that can only read starts again even after its steps ran (here the platform stopped
    // `pnpm install`), and what its stopped attempt uploaded goes. Each restart is counted.
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('r1', 'run1', 'r1', 'r1', 'queued'), ('r2', 'run1', 'r2', 'r2', 'queued'), ('r3', 'run1', 'r3', 'r3', 'queued'), ('r4', 'run1', 'r4', 'r4', 'queued'), ('r5', 'run1', 'r5', 'r5', 'queued')");
    const install = ["Run actions/checkout@v4", "Run pnpm install", "Run pnpm test"];
    await launch("r1");
    running("r1", "diffinery-runner:new", [0, 1], install);
    await actions.runnerComplete("r1", started.at(-1)!.token, replaced);
    expect(job("r1")).toMatchObject({ status: "queued", conclusion: null, steps: "[]", restarts: 1 });
    expect(swept.at(-1)).toEqual(["r1", true]);
    expect(logs("r1")).toEqual([{ seq: 2, step: -1, text: expect.stringMatching(/while step "Run pnpm install" ran\. The job can only read .* Diffinery started the job again from the beginning on a new runner \(restart 1 of 2\)/) }]);
    // It still stops after MAX_RUNNER_RESTARTS, wherever the platform stopped it.
    for (let i = 1; i <= MAX_RUNNER_RESTARTS; i++) {
      await actions.relaunchJob("r1");
      running("r1", "diffinery-runner:new", [0, 1, 2], install);
      await actions.runnerComplete("r1", started.at(-1)!.token, replaced);
    }
    expect(job("r1")).toMatchObject({ status: "completed", conclusion: "failure", restarts: MAX_RUNNER_RESTARTS });
    // (On the deployed image no deploy replaced it, so the message says the platform stopped it.)
    expect(JSON.parse(job("r1")!.failure as string).message).toBe("The platform stopped this job's container after its steps had started, 3 times. Re-run the job.");
    // One that names a secret, deploys to an environment, can get an OIDC token, or reads every secret fails as before, naming the step that was stopped.
    for (const id of ["r2", "r3", "r4", "r5"]) {
      await launch(id);
      running(id, "diffinery-runner:new", [0, 1, 2], install);
      await actions.runnerComplete(id, started.at(-1)!.token, replaced);
      expect(job(id)).toMatchObject({ status: "completed", conclusion: "failure", restarts: 0 });
      expect(JSON.parse(job(id)!.failure as string).message).toMatch(/while step "Run pnpm test" ran\. Diffinery doesn't start a job again by itself/);
    }
    // Right after a deploy this object can still have the previous RUNNER_IMAGE: the image of the
    // Worker that took the report decides whether a deploy replaced the runner.
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('r6', 'run1', 'r1', 'r6', 'queued'), ('r7', 'run1', 'r1', 'r7', 'queued')");
    for (const [id, deployed, says] of [["r6", "diffinery-runner:next", "The platform stopped this job's container"], ["r7", undefined, "The platform replaced this job's runner with a new version"]] as const) {
      await launch(id);
      running(id, "diffinery-runner:next", [0, 1], install);
      await actions.runnerComplete(id, started.at(-1)!.token, replaced, deployed);
      expect(job(id)).toMatchObject({ status: "queued", restarts: 1 });
      expect(logs(id)[0]!.text).toMatch(new RegExp(`^##\\[warning\\]${says} while step "Run pnpm install" ran`));
    }

    // A job that finished despite the replacement, or a runner on the deployed image that stops, completes as before.
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('j3', 'run1', 'k3', 'k3', 'queued'), ('j4', 'run1', 'k4', 'k4', 'queued')");
    await launch("j3");
    running("j3", "diffinery-runner:old", [0, 1]);
    await actions.runnerComplete("j3", started.at(-1)!.token, { conclusion: "success", outputs: {}, replaced: true });
    expect(job("j3")).toMatchObject({ status: "completed", conclusion: "success" });
    await launch("j4");
    running("j4", "diffinery-runner:new", []);
    await actions.containerStopped("j4", 137, "job-j4");
    expect(job("j4")).toMatchObject({ status: "completed", conclusion: "failure", restarts: 0 });
    expect(JSON.parse(job("j4")!.failure as string).message).toBe("The runner stopped unexpectedly (exit code 137).");

    // A container on the deployed image that the platform stops or loses mid-job (no exit code, not
    // stopped by Diffinery) counts as a replacement too: a job that can only read starts again...
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('s1', 'run1', 'r1', 's1', 'queued'), ('s2', 'run1', 'k3', 's2', 'queued')");
    await launch("s1");
    running("s1", "diffinery-runner:new", [0, 1], install);
    await actions.containerStopped("s1", 0, "job-s1");
    expect(job("s1")).toMatchObject({ status: "queued", conclusion: null, restarts: 1 });
    expect(swept.at(-1)).toEqual(["s1", true]);
    expect(logs("s1")).toEqual([{ seq: 2, step: -1, text: expect.stringMatching(/^##\[warning\]The platform stopped this job's container while step "Run pnpm install" ran\. The job can only read .* \(restart 1 of 2\)\.$/) }]);
    // ...a late stop of that container changes nothing, and the restarts stop at MAX_RUNNER_RESTARTS.
    await actions.containerStopped("s1", null, "job-s1");
    expect(job("s1")).toMatchObject({ status: "queued", restarts: 1 });
    for (let i = 1; i <= MAX_RUNNER_RESTARTS; i++) {
      await actions.relaunchJob("s1");
      running("s1", "diffinery-runner:new", [0, 1], install);
      await actions.containerStopped("s1", null, started.at(-1)!.container);
    }
    expect(job("s1")).toMatchObject({ status: "completed", conclusion: "failure", restarts: MAX_RUNNER_RESTARTS });
    expect(JSON.parse(job("s1")!.failure as string).message).toBe("The platform stopped this job's container after its steps had started, 3 times. Re-run the job.");
    // One that could change something outside the run fails, naming the step.
    await launch("s2");
    running("s2", "diffinery-runner:new", [0, 1]);
    await actions.containerStopped("s2", 0, "job-s2");
    expect(job("s2")).toMatchObject({ status: "completed", conclusion: "failure", restarts: 0 });
    expect(JSON.parse(job("s2")!.failure as string).message).toMatch(/^The platform stopped this job's container while step "Deploy" ran\. Diffinery doesn't start a job again by itself/);
    // Diffinery's own stop (a cancel, a timeout, fail-fast) never starts a job again, and a runner that crashes isn't retried.
    // (Each added after the one before failed, so fail-fast doesn't cancel it.)
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('s3', 'run1', 'r1', 's3', 'queued')");
    await launch("s3");
    running("s3", "diffinery-runner:new", [0, 1], install);
    await actions.containerStopped("s3", 0, "job-s3", true);
    expect(job("s3")).toMatchObject({ status: "completed", conclusion: "failure", restarts: 0 });
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('s4', 'run1', 'r1', 's4', 'queued')");
    await launch("s4");
    running("s4", "diffinery-runner:new", [0, 1], install);
    await actions.containerStopped("s4", 1, "job-s4");
    expect(job("s4")).toMatchObject({ status: "completed", conclusion: "failure", restarts: 0 });
  });
});

describe("runner info", () => {
  it("keeps only the runner's short image, location and instance strings", () => {
    expect(parseRunnerInfo(JSON.stringify({ image: "diffinery-runner:abc", location: "fra06, EEUR", instance: "d0", cpu: "AMD EPYC (family 25, model 17), 4 vCPUs, 2550 MHz", token: "x", n: 1 }))).toEqual({ image: "diffinery-runner:abc", location: "fra06, EEUR", instance: "d0", cpu: "AMD EPYC (family 25, model 17), 4 vCPUs, 2550 MHz" });
    expect(parseRunnerInfo(JSON.stringify({ image: "x".repeat(300) }))?.image).toHaveLength(200);
    for (const bad of [null, "", "not json", "{}", JSON.stringify({ image: 5 }), "x".repeat(2000)]) expect(parseRunnerInfo(bad)).toBeNull();
  });
});

describe("unfinished runs", () => {
  it("past MAX_ACTIVE_RUNS a dispatch is refused and other events start nothing", async () => {
    const sql = sqlStorage();
    sql.exec(REPO_SCHEMA);
    migrateRepoSchema(sql as unknown as SqlStorage);
    const actions = new Actions({ sql, meta: { repoId: "r", owner: "acme", name: "app", defaultBranch: "main" } } as unknown as RepoDO, { PUBLIC_URL: "https://d.test" } as unknown as Env);
    const t = new Date().toISOString();
    for (let i = 0; i < MAX_ACTIVE_RUNS; i++) sql.exec("INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, event_payload) VALUES (?, ?, 'w.yml', 'w', 'push', 'refs/heads/main', 'abc', '{}', 'queued', ?, ?, '{}')", `run${i}`, i + 1, t, t);
    const wf = { path: ".github/workflows/w.yml", on: {}, jobs: {} } as never;
    const caller = { id: "u1", login: "ada", kind: "user" as const };
    await expect(actions.createRun(wf, { event: "workflow_dispatch", ref: "refs/heads/main", sha: "abc", payload: {}, caller, title: "w" })).rejects.toThrow(/500 unfinished workflow runs/);
    expect(await actions.createRun(wf, { event: "push", ref: "refs/heads/main", sha: "abc", payload: {}, caller, title: "w" })).toBeNull();
  });
});
