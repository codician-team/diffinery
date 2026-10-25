import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBuiltin } from "../src/builtins/index.js";
import { backendIds, findFilesToUpload, mimeTypeOf, nameMatches } from "../src/builtins/artifacts.js";
import { cacheVersion, isExactKeyMatch } from "../src/builtins/cache.js";
import { RuntimeClient, RuntimeError } from "../src/runtime.js";
import { crc32, extractZip, safeEntryPath, writeZip } from "../src/zip.js";
import { tmp } from "./helpers.js";

const dirs: string[] = [];
const scratch = (prefix: string) => {
  const d = tmp(prefix);
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const write = (root: string, rel: string, body: string | Buffer = rel) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), body);
};

describe("zip", () => {
  it("computes CRC-32", () => {
    expect(crc32(Buffer.from("123456789")).toString(16)).toBe("cbf43926");
    expect(crc32(Buffer.from("6789"), crc32(Buffer.from("12345")))).toBe(crc32(Buffer.from("123456789")));
  });

  it("writes archives unzip reads, and reads archives zip writes", async () => {
    const d = scratch("zip-");
    write(d, "src/a.txt", "alpha\n".repeat(1000));
    write(d, "src/sub/b.bin", Buffer.alloc(70_000, 7));
    write(d, "src/empty", "");
    write(d, "src/run.sh", "#!/bin/sh\necho hi\n");
    chmodSync(path.join(d, "src/run.sh"), 0o755);
    const entries = ["a.txt", "sub/b.bin", "empty", "run.sh"].map((name) => ({ source: path.join(d, "src", name), name }));
    for (const level of [0, 6]) {
      const out = path.join(d, `l${level}.zip`);
      const { size, sha256 } = await writeZip(out, entries, level);
      expect(size).toBe(statSync(out).size);
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(execFileSync("unzip", ["-t", out]).toString()).toContain("No errors detected");
      const dest = path.join(d, `x${level}`);
      expect(await extractZip(out, dest)).toBe(4);
      expect(readFileSync(path.join(dest, "a.txt"), "utf8")).toBe("alpha\n".repeat(1000));
      expect(readFileSync(path.join(dest, "sub/b.bin")).equals(Buffer.alloc(70_000, 7))).toBe(true);
      expect(readFileSync(path.join(dest, "empty")).length).toBe(0);
      expect(statSync(path.join(dest, "run.sh")).mode & 0o111).not.toBe(0);
    }
    execFileSync("zip", ["-qr", path.join(d, "cli.zip"), "."], { cwd: path.join(d, "src") });
    const dest = path.join(d, "cli");
    await extractZip(path.join(d, "cli.zip"), dest);
    expect(readFileSync(path.join(dest, "sub/b.bin")).length).toBe(70_000);
  });

  it("refuses entries that escape the destination", () => {
    expect(() => safeEntryPath("/tmp/x", "../evil")).toThrow();
    expect(() => safeEntryPath("/tmp/x", "/etc/passwd")).toThrow();
    expect(safeEntryPath("/tmp/x", "a/b.txt")).toBe("/tmp/x/a/b.txt");
  });
});

describe("built-in actions", () => {
  it("mirror only the refs and inputs they understand", () => {
    expect(getBuiltin("actions/checkout", "v4")).not.toBeNull();
    expect(getBuiltin("Actions/Checkout", "v4.2.1", { "fetch-depth": "0", LFS: "true" })).not.toBeNull();
    expect(getBuiltin("actions/checkout", "main")).toBeNull();
    expect(getBuiltin("actions/checkout", "11bd71901bbe5b1630ceea73d27597364c9af683")).toBeNull();
    expect(getBuiltin("actions/checkout", "v99")).toBeNull();
    expect(getBuiltin("actions/checkout", "v4", { "ssh-key": "k" })).toBeNull();
    expect(getBuiltin("actions/cache", "v4", { path: "x", key: "k", "new-input": "1" })).toBeNull();
    expect(getBuiltin("actions/setup-node", "v4", { cache: "bun" })).toBeNull();
    expect(getBuiltin("actions/setup-python", "v5", { "python-version": "pypy3.10" })).toBeNull();
    expect(getBuiltin("actions/setup-python", "v5", { cache: "poetry" })).toBeNull();
    expect(getBuiltin("actions/github-script", "v7")).toBeNull();
  });

  it("step aside when the workflow or runner asks for the real action", () => {
    expect(getBuiltin("actions/cache", "v4", {}, { DIFFINERY_BUILTINS: "false" })).toBeNull();
    expect(getBuiltin("actions/cache", "v4", {}, { DIFFINERY_BUILTINS: "true" })).not.toBeNull();
    process.env.DIFFINERY_DISABLE_BUILTINS = "1";
    try {
      expect(getBuiltin("actions/cache", "v4")).toBeNull();
    } finally {
      delete process.env.DIFFINERY_DISABLE_BUILTINS;
    }
  });
});

describe("cache", () => {
  it("versions entries like @actions/cache", () => {
    // sha256("node_modules|zstd-without-long|1.0"), computed independently
    const expected = execFileSync("sh", ["-c", "printf '%s' 'node_modules|zstd-without-long|1.0' | sha256sum"]).toString().split(" ")[0];
    expect(cacheVersion(["node_modules"], "zstd-without-long")).toBe(expected);
    expect(cacheVersion(["a", "b"], "gzip")).not.toBe(cacheVersion(["b", "a"], "gzip"));
    // gzip is part of the version too: @actions/cache's getCacheVersion pushes the compression
    // method whatever it is (only enableCrossOsArchive adds anything else)
    const gzip = execFileSync("sh", ["-c", "printf '%s' 'node_modules|gzip|1.0' | sha256sum"]).toString().split(" ")[0];
    expect(cacheVersion(["node_modules"], "gzip")).toBe(gzip);
  });

  it("matches keys case-insensitively, like actions/cache", () => {
    expect(isExactKeyMatch("Linux-deps", "linux-DEPS")).toBe(true);
    expect(isExactKeyMatch("linux-deps", "linux-deps-2")).toBe(false);
    expect(isExactKeyMatch("linux-deps", undefined)).toBe(false);
  });
});

describe("artifacts", () => {
  it("finds files and their root like upload-artifact", () => {
    const ws = scratch("upload-");
    for (const f of ["dist/a.js", "dist/sub/b.js", "dist/.env", "dist/.cache/x", "logs/one.log", "logs/two.log", "README.md"]) write(ws, f);
    const rel = (r: { files: string[]; root: string }) => ({ files: r.files.map((f) => path.relative(ws, f)).sort(), root: path.relative(ws, r.root) });
    expect(rel(findFilesToUpload(ws, "dist/", false))).toEqual({ files: ["dist/a.js", "dist/sub/b.js"], root: "dist" });
    expect(rel(findFilesToUpload(ws, "dist", true)).files).toEqual(["dist/.cache/x", "dist/.env", "dist/a.js", "dist/sub/b.js"]);
    expect(rel(findFilesToUpload(ws, "README.md", false))).toEqual({ files: ["README.md"], root: "" });
    expect(rel(findFilesToUpload(ws, "dist/sub/b.js\nlogs/*.log\n!logs/two.log", false))).toEqual({ files: ["dist/sub/b.js", "logs/one.log"], root: "" });
    expect(rel(findFilesToUpload(ws, "dist/**/*.js", false))).toEqual({ files: ["dist/a.js", "dist/sub/b.js"], root: "dist" });
    expect(findFilesToUpload(ws, "missing/", false).files).toEqual([]);
  });

  it("matches artifact names like minimatch", () => {
    expect(nameMatches("build-*", "build-linux")).toBe(true);
    expect(nameMatches("build-*", "test-linux")).toBe(false);
    expect(nameMatches("{a,b}-?", "b-1")).toBe(true);
    expect(nameMatches("cov[0-9]", "cov7")).toBe(true);
  });

  it("knows the run and job from the runtime token, and guesses mime types", () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    expect(backendIds(`${b64({})}.${b64({ scp: "Actions.GenericRead:12 Actions.Results:12:job-9" })}.sig`)).toEqual({ run: "12", job: "job-9" });
    expect(() => backendIds(`${b64({})}.${b64({ scp: "Actions.GenericRead:12" })}.sig`)).toThrow();
    expect(mimeTypeOf("report.HTML")).toBe("text/html");
    expect(mimeTypeOf("blob.weird")).toBe("application/octet-stream");
  });
});

describe("runtime client", () => {
  it("uploads large files as blocks, small ones in one request, and downloads them back", async () => {
    const store = new Map<string, Buffer>();
    const calls: string[] = [];
    let blocks = new Map<string, Buffer>();
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const u = new URL(req.url!, "http://x");
      const comp = u.searchParams.get("comp");
      calls.push(`${req.method} ${comp ?? "-"}`);
      if (req.method === "PUT" && comp === "block") blocks.set(u.searchParams.get("blockid")!, body);
      else if (req.method === "PUT" && comp === "blocklist") {
        const ids = [...body.toString().matchAll(/<Latest>([^<]+)<\/Latest>/g)].map((m) => m[1]!);
        store.set(u.pathname, Buffer.concat(ids.map((id) => blocks.get(id)!)));
        blocks = new Map();
      } else if (req.method === "PUT") store.set(u.pathname, body);
      else {
        const b = store.get(u.pathname);
        res.writeHead(b ? 200 : 404, { "content-type": "application/zip", "content-disposition": "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.zip" });
        return res.end(b);
      }
      res.writeHead(201);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const d = scratch("blocks-");
    try {
      const rt = new RuntimeClient("t", `${base}/`, { retries: 0 });
      const big = Buffer.alloc(33 * 1024 * 1024 + 5);
      for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
      writeFileSync(path.join(d, "big"), big);
      writeFileSync(path.join(d, "small"), "hello");
      expect(await rt.upload(`${base}/big?sig=1`, path.join(d, "big"))).toBe(big.length);
      expect(calls).toEqual(["PUT block", "PUT block", "PUT block", "PUT blocklist"]); // 16 MiB blocks
      expect(await rt.upload(`${base}/small?sig=1`, path.join(d, "small"))).toBe(5);
      expect(calls.at(-1)).toBe("PUT -");
      const meta = await rt.download(`${base}/big?sig=1`, path.join(d, "back"));
      expect(meta).toEqual({ contentType: "application/zip", fileName: "résumé.zip" });
      expect(readFileSync(path.join(d, "back")).equals(big)).toBe(true);
      await expect(rt.download(`${base}/nothing`, path.join(d, "none"))).rejects.toBeInstanceOf(RuntimeError);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("downloads in ranges, several at once, retrying a range on its own", async () => {
    const blob = Buffer.alloc(8 * 1024 * 1024 * 3 + 12345);
    for (let i = 0; i < blob.length; i += 997) blob[i] = (i / 997) % 256;
    const seen: string[] = [];
    let flaky = 1;
    let inFlight = 0;
    let most = 0;
    // The ranges after the first are held until three of them are in flight at once (or 5 s pass), so the test
    // doesn't depend on a busy host sending them within a few milliseconds of each other.
    const held: Array<() => void> = [];
    let released = false;
    const server = createServer(async (req, res) => {
      const b = req.url!.startsWith("/empty") ? Buffer.alloc(0) : blob;
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
      seen.push(req.headers.range ?? "");
      inFlight++;
      most = Math.max(most, inFlight);
      if (range && Number(range[1]) > 0 && !released) {
        await new Promise<void>((r) => {
          held.push(r);
          if (held.length >= 3) {
            released = true;
            for (const go of held.splice(0)) go();
          } else setTimeout(r, 5000);
        });
      }
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      if (!range) return res.writeHead(200, { "content-length": b.length }).end(b);
      if (!b.length) return res.writeHead(416).end();
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), b.length - 1);
      if (start > 0 && flaky-- > 0) return res.writeHead(503).end("busy");
      res.writeHead(206, { etag: '"x"', "content-range": `bytes ${start}-${end}/${b.length}` }).end(b.subarray(start, end + 1));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const d = scratch("ranges-");
    try {
      const rt = new RuntimeClient("t", `${base}/`, { retries: 2, minBackoffMs: 1 });
      await rt.download(`${base}/blob?sig=1`, path.join(d, "back"));
      expect(readFileSync(path.join(d, "back")).equals(blob)).toBe(true);
      // The first range, three more at once, and the one that failed again.
      expect(seen[0]).toBe(`bytes=0-${8 * 1024 * 1024 - 1}`);
      expect(seen).toHaveLength(5);
      expect(most).toBeGreaterThanOrEqual(3);
      // An empty blob: the range is refused (416), so it is fetched whole.
      seen.length = 0;
      await rt.download(`${base}/empty?sig=1`, path.join(d, "empty"));
      expect(readFileSync(path.join(d, "empty")).length).toBe(0);
      expect(seen).toEqual([`bytes=0-${8 * 1024 * 1024 - 1}`, ""]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
