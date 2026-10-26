import { describe, expect, it } from "vitest";
import { isStale, mirrorKey, parseActionRef, refreshMirror, REFRESH_MS, type MirrorBucket } from "../../src/lib/action-mirror.js";

/** An in-memory bucket that remembers when each object was stored. */
function memoryBucket(now: () => number) {
  const objects = new Map<string, { data: Uint8Array; uploaded: Date }>();
  const bytes = async (v: ReadableStream | ArrayBuffer | ArrayBufferView) => new Uint8Array(await new Response(v as BodyInit).arrayBuffer());
  const bucket: MirrorBucket = {
    async get(key) {
      const o = objects.get(key);
      return o ? { body: new Response(o.data).body!, size: o.data.length } : null;
    },
    async head(key) {
      const o = objects.get(key);
      return o ? { size: o.data.length, etag: "e", uploaded: o.uploaded } : null;
    },
    async put(key, value) {
      const data = await bytes(value);
      objects.set(key, { data, uploaded: new Date(now()) });
      return { size: data.length, etag: "e" };
    },
    async list() {
      return { objects: [], truncated: false };
    },
    async delete() {},
    async createMultipartUpload(key) {
      const parts = new Map<number, Uint8Array>();
      return {
        uploadId: "u",
        async uploadPart(n, v) {
          parts.set(n, await bytes(v));
          return { partNumber: n, etag: String(n) };
        },
        async complete(list) {
          const data = new Uint8Array(await new Blob(list.map((p) => parts.get(p.partNumber)! as BlobPart)).arrayBuffer());
          objects.set(key, { data, uploaded: new Date(now()) });
        },
        async abort() {},
      };
    },
    resumeMultipartUpload() {
      throw new Error("unused");
    },
  };
  return { bucket, objects };
}

const T0 = Date.parse("2026-10-26T12:00:00Z");

describe("action mirror", () => {
  it("accepts GitHub action names and refs, and nothing that could escape the key or the URL", () => {
    expect(parseActionRef({ owner: "actions", repo: "setup-java", ref: "v4" })).toEqual({ owner: "actions", repo: "setup-java", ref: "v4" });
    expect(parseActionRef({ owner: "a", repo: "b", ref: "releases/v1.2" })).not.toBeNull();
    for (const bad of [
      { owner: "../x", repo: "b", ref: "v1" },
      { owner: "a", repo: "..", ref: "v1" },
      { owner: "a/b", repo: "c", ref: "v1" },
      { owner: "a", repo: "b", ref: "../../etc" },
      { owner: "a", repo: "b", ref: "-x" },
      { owner: "a", repo: "b", ref: "v1 v2" },
      { owner: "a", repo: "b", ref: "" },
      { owner: "a", repo: "b" },
      { owner: 1, repo: "b", ref: "v1" },
    ]) {
      expect(parseActionRef(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("keys copies by lower-case owner and repository, and keeps refs apart", () => {
    expect(mirrorKey({ owner: "Actions", repo: "Checkout", ref: "v4" })).toBe("action-mirror/actions/checkout/v4.tar.gz");
    expect(mirrorKey({ owner: "a", repo: "b", ref: "releases/v1" })).toBe("action-mirror/a/b/releases%2Fv1.tar.gz");
    const sha = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    expect(mirrorKey({ owner: "a", repo: "b", ref: sha })).toBe(`action-mirror/a/b/${sha.toLowerCase()}.tar.gz`);
  });

  it("refreshes a tag after a day and a commit after a week", () => {
    const tag = { owner: "a", repo: "b", ref: "v1" };
    const sha = { owner: "a", repo: "b", ref: "0123456789abcdef0123456789abcdef01234567" };
    expect(isStale(tag, undefined, T0)).toBe(true);
    expect(isStale(tag, new Date(T0 - REFRESH_MS.ref + 1000), T0)).toBe(false);
    expect(isStale(tag, new Date(T0 - REFRESH_MS.ref), T0)).toBe(true);
    expect(isStale(sha, new Date(T0 - REFRESH_MS.ref), T0)).toBe(false);
    expect(isStale(sha, new Date(T0 - REFRESH_MS.sha), T0)).toBe(true);
  });

  it("fetches from GitHub only when its copy is missing or stale, and keeps the old copy when GitHub fails", async () => {
    let now = T0;
    const { bucket, objects } = memoryBucket(() => now);
    const calls: string[] = [];
    let answer: () => Response = () => new Response("tarball-1");
    const fetchStub = (async (url: string) => {
      calls.push(url);
      return answer();
    }) as unknown as typeof fetch;
    const a = { owner: "acme", repo: "tools", ref: "v1" };
    const o = { fetch: fetchStub, codeload: "https://codeload.test" };

    expect(await refreshMirror(bucket, a, { ...o, now })).toBe("stored");
    expect(calls).toEqual(["https://codeload.test/acme/tools/tar.gz/v1"]);
    expect(new TextDecoder().decode(objects.get(mirrorKey(a))!.data)).toBe("tarball-1");

    now += 3600_000;
    expect(await refreshMirror(bucket, a, { ...o, now })).toBe("fresh");
    expect(calls).toHaveLength(1);

    now += REFRESH_MS.ref;
    answer = () => new Response("down", { status: 503 });
    expect(await refreshMirror(bucket, a, { ...o, now })).toBe("failed");
    expect(new TextDecoder().decode(objects.get(mirrorKey(a))!.data)).toBe("tarball-1");

    answer = () => new Response("tarball-2");
    expect(await refreshMirror(bucket, a, { ...o, now })).toBe("stored");
    expect(new TextDecoder().decode(objects.get(mirrorKey(a))!.data)).toBe("tarball-2");

    answer = () => new Response("nope", { status: 404 });
    expect(await refreshMirror(bucket, { ...a, ref: "v9" }, { ...o, now })).toBe("not-found");
    expect(objects.has(mirrorKey({ ...a, ref: "v9" }))).toBe(false);

    answer = () => {
      throw new TypeError("network down");
    };
    expect(await refreshMirror(bucket, { ...a, ref: "v8" }, { ...o, now })).toBe("failed");
  });

  it("stores nothing for an archive over the size limit", async () => {
    const { bucket, objects } = memoryBucket(() => T0);
    const big = (() => new Response("x", { headers: { "content-length": String(1024 * 1024 * 1024) } })) as unknown as typeof fetch;
    expect(await refreshMirror(bucket, { owner: "a", repo: "huge", ref: "v1" }, { fetch: big })).toBe("too-large");
    expect(objects.size).toBe(0);
  });
});
