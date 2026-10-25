import { describe, expect, it } from "vitest";
import { PART_SIZE, R2Sink } from "../../src/lib/r2-sink.js";
import { importHostAllowed, withoutCredentials } from "../../src/lib/import-hosts.js";

/** An in-memory stand-in for the bits of R2Bucket the sink uses; it enforces R2's part-size rules. */
function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  const log: string[] = [];
  const bucket = {
    async put(key: string, value: Uint8Array) {
      log.push(`put ${value.length}`);
      objects.set(key, value);
      return {};
    },
    async createMultipartUpload(key: string) {
      const parts = new Map<number, Uint8Array>();
      log.push("create");
      return {
        async uploadPart(n: number, data: Uint8Array) {
          log.push(`part ${n} ${data.length}`);
          parts.set(n, data.slice());
          return { partNumber: n, etag: `e${n}` };
        },
        async complete(list: Array<{ partNumber: number }>) {
          const sizes = list.map((p) => parts.get(p.partNumber)!.length);
          // R2: every part but the last has the same size, at least 5 MiB.
          for (const s of sizes.slice(0, -1)) {
            if (s !== sizes[0] || s < 5 * 1024 * 1024) throw new Error("bad part sizes");
          }
          const all = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
          let o = 0;
          for (const p of list) {
            all.set(parts.get(p.partNumber)!, o);
            o += parts.get(p.partNumber)!.length;
          }
          objects.set(key, all);
          log.push("complete");
          return {};
        },
        async abort() {
          log.push("abort");
        },
      };
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects, log };
}

const chunk = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe("R2Sink", () => {
  it("uses a single put for small objects", async () => {
    const { bucket, objects, log } = fakeBucket();
    const sink = new R2Sink(bucket, "k", "text/plain", 1024);
    await sink.write(chunk(10, 1));
    await sink.write(chunk(20, 2));
    expect(await sink.close()).toBe(30);
    expect(log).toEqual(["put 30"]);
    expect(objects.get("k")!.length).toBe(30);
  });

  it("uploads big objects as equal parts, whatever the chunk sizes", async () => {
    const { bucket, objects, log } = fakeBucket();
    const sink = new R2Sink(bucket, "k", "application/gzip", 64 * 1024 * 1024);
    const sizes = [3_000_000, 7_777_777, 1, 5_000_000, 2_500_000];
    let i = 0;
    for (const s of sizes) await sink.write(chunk(s, i++));
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(await sink.close()).toBe(total);
    expect(log.filter((l) => l.startsWith("part")).slice(0, -1).every((l) => l.endsWith(` ${PART_SIZE}`))).toBe(true);
    expect(log.at(-1)).toBe("complete");
    // The bytes come out in order.
    const out = objects.get("k")!;
    expect(out.length).toBe(total);
    expect(out[0]).toBe(0);
    expect(out[3_000_000]).toBe(1);
    expect(out[total - 1]).toBe(4);
  });

  it("stops with a 413 past the limit and aborts the upload", async () => {
    const { bucket, log } = fakeBucket();
    const sink = new R2Sink(bucket, "k", "application/zip", PART_SIZE + 10, "too big");
    await sink.write(chunk(PART_SIZE, 0));
    await expect(sink.write(chunk(11, 0))).rejects.toMatchObject({ status: 413 });
    await sink.abort();
    expect(log).toContain("abort");
  });
});

describe("importer hosts", () => {
  it("allows GitHub's hosts and the configured enterprise host only", () => {
    for (const h of ["github.com", "api.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "GitHub.com"]) expect(importHostAllowed(h)).toBe(true);
    for (const h of ["example.com", "evil.github.com.example", "githubusercontent.com", "raw.githubusercontent.com", "localhost"]) expect(importHostAllowed(h)).toBe(false);
    expect(importHostAllowed("ghe.example.com", "GHE.example.com")).toBe(true);
    expect(importHostAllowed("ghe.example.com")).toBe(false);
  });

  it("drops every credential header on a cross-host redirect", () => {
    const h = withoutCredentials({ Authorization: "token x", Cookie: "a=b", "X-GitHub-Token": "y", "Proxy-Authorization": "z", Accept: "application/octet-stream", "User-Agent": "diffinery" });
    expect(h).toEqual({ Accept: "application/octet-stream", "User-Agent": "diffinery" });
  });
});
