import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import { Sha256 } from "../../src/lib/sha256.js";
import { tailKey, type UploadRow } from "../../src/registry/store.js";
import { ingest, PART_SIZE } from "../../src/registry/upload.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const filled = (n: number, seed: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 131 + seed * 7 + (i >> 8)) & 255;
  return b;
};

describe("SHA-256 with saved progress", () => {
  it("matches node's SHA-256 however the input is split and resumed", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const data = filled(n, n);
      let h = new Sha256();
      for (let o = 0, step = 1; o < n; o += step, step = (step * 7 + 3) % 97 || 1) h = Sha256.restore(h.update(data.subarray(o, o + step)).save());
      expect(h.hex(), `${n} bytes`).toBe(sha(data));
    }
    expect(() => Sha256.restore(JSON.stringify({ h: [1], n: 0, b: "" }))).toThrow();
  });
});

describe("chunked blob uploads", () => {
  it("hash each chunk as it arrives, so the final request doesn't read the blob back", async () => {
    const objects = new Map<string, Uint8Array>();
    const parts = new Map<string, Map<number, Uint8Array>>();
    const reads: string[] = [];
    const bytes = async (v: ReadableStream | ArrayBuffer | ArrayBufferView) => (v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice() : new Uint8Array(await new Response(v).arrayBuffer()));
    const handle = (key: string, uploadId: string) => ({
      uploadId,
      async uploadPart(n: number, v: ArrayBufferView) {
        parts.get(uploadId)!.set(n, await bytes(v));
        return { partNumber: n, etag: `p${n}` };
      },
      async complete(list: Array<{ partNumber: number }>) {
        const all = list.map((p) => parts.get(uploadId)!.get(p.partNumber)!);
        const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
        let at = 0;
        for (const p of all) out.set(p, (at += p.length) - p.length);
        objects.set(key, out);
      },
    });
    const bucket = {
      async get(key: string) {
        reads.push(key);
        const o = objects.get(key);
        return o ? { arrayBuffer: async () => o.slice().buffer, body: new Response(o).body, size: o.length } : null;
      },
      async put(key: string, v: ArrayBufferView) {
        objects.set(key, await bytes(v));
      },
      async delete(keys: string | string[]) {
        for (const k of [keys].flat()) objects.delete(k);
      },
      async createMultipartUpload(key: string) {
        parts.set("mp1", new Map());
        return handle(key, "mp1");
      },
      resumeMultipartUpload: (key: string, id: string) => handle(key, id),
    };
    const env = { BUCKET: bucket } as unknown as Env;
    const blob = filled(2 * PART_SIZE + 3 * 1024 * 1024 + 17, 1);
    // Chunks as the registry relay sends them: PATCHes, then the rest with the final PUT.
    const cuts = [PART_SIZE + 12345, 2 * PART_SIZE - 1, blob.length];
    let u: UploadRow = { id: "up1", package_id: "p", r2_key: "registry/blobs/up1", multipart_id: null, parts: "[]", size: 0, tail: 0, digest: null, hash_state: null, created_at: "", updated_at: "" };
    let from = 0;
    for (const [i, to] of cuts.entries()) {
      u = await ingest(env, u, new Response(blob.subarray(from, to)).body, i === cuts.length - 1);
      // Each request starts from the row as stored, so only saved state carries over.
      u = JSON.parse(JSON.stringify(u)) as UploadRow;
      from = to;
    }
    expect(u.digest).toBe(`sha256:${sha(blob)}`);
    expect(u.size).toBe(blob.length);
    expect(sha(objects.get(u.r2_key)!)).toBe(sha(blob));
    // Only the unfinished part's bytes were read back between requests, never the blob.
    expect(reads.every((k) => k === tailKey("up1"))).toBe(true);
  });
});
