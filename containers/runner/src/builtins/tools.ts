import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { failure } from "../job.js";
import { hashFiles, inputList } from "../util.js";
import { isExactKeyMatch, restoreCache, saveCache } from "./cache.js";
import type { BuiltinContext } from "./index.js";

/** Downloads a public URL to a file with a few retries. */
export async function fetchToFile(url: string, file: string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    try {
      const res = await fetch(url, { headers: { "user-agent": "diffinery-runner" }, redirect: "follow" });
      if (res.status === 404) throw failure(`Not found: ${url}`);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(file));
      return;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Not found:")) throw e;
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function fetchJson<T>(url: string): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    try {
      const res = await fetch(url, { headers: { "user-agent": "diffinery-runner", accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export function toolArch(kind: "node" | "go" | "python"): string {
  const a = process.arch;
  if (kind === "go") return a === "arm64" ? "arm64" : a === "arm" ? "armv6l" : "amd64";
  return a === "arm64" ? "arm64" : a === "arm" ? "armv7l" : "x64";
}

export function toolDir(c: BuiltinContext, tool: string, version: string, arch: string): string {
  return path.join(c.job.toolCache, tool, version, arch);
}

export function isCached(dir: string): boolean {
  return existsSync(`${dir}.complete`) && existsSync(dir);
}

/** Downloads a tarball and extracts it into `dir` (stripping the top-level folder). */
export async function installTarball(c: BuiltinContext, url: string, dir: string, strip = 1, sha256?: string): Promise<void> {
  c.log(`Downloading and extracting ${url} to ${dir}`);
  await extractUrl(url, dir, { strip, sha256, signal: c.job.signal });
}

/**
 * Downloads a .tar.gz or .tar.xz and extracts it into `dir` as it arrives, stripping `strip` leading
 * folders and checking its SHA-256 when given, with a few retries. The tool appears at `dir` whole or
 * not at all: it is extracted next to it, renamed into place, then marked with `${dir}.complete`.
 */
export async function extractUrl(url: string, dir: string, o: { strip?: number; sha256?: string; signal?: AbortSignal } = {}): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    if (o.signal?.aborted) break;
    const part = `${dir}.part-${randomUUID().slice(0, 8)}`;
    let tar: ChildProcess | undefined;
    try {
      await mkdir(part, { recursive: true });
      const res = await fetch(url, { headers: { "user-agent": "diffinery-runner" }, redirect: "follow", signal: o.signal });
      if (res.status === 404) throw failure(`Not found: ${url}`);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
      const t = spawn("tar", [/\.(tar\.)?xz$/.test(new URL(url).pathname) ? "-xJf" : "-xzf", "-", "-C", part, `--strip-components=${o.strip ?? 1}`], { stdio: ["pipe", "ignore", "pipe"] });
      tar = t;
      let stderr = "";
      t.stderr!.on("data", (d: Buffer) => {
        if (stderr.length < 4000) stderr += d.toString();
      });
      const exited = new Promise<number>((resolve, reject) => {
        t.once("error", reject);
        t.once("close", (code) => resolve(code ?? -1));
      });
      const hash = createHash("sha256");
      const hashing = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      const [piped, exit] = await Promise.allSettled([pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), hashing, t.stdin!), exited]);
      if (exit.status === "rejected") throw exit.reason;
      if (exit.value !== 0) throw new Error(`tar failed with exit code ${exit.value}: ${stderr.trim().split("\n").slice(-3).join(" ")}`);
      if (piped.status === "rejected") throw piped.reason;
      if (o.sha256 && hash.digest("hex") !== o.sha256.toLowerCase()) throw new Error(`${url} does not match its published SHA-256`);
      await rm(dir, { recursive: true, force: true });
      await rename(part, dir);
      await writeFile(`${dir}.complete`, "");
      return;
    } catch (e) {
      if (tar && tar.exitCode === null) {
        const gone = new Promise((r) => tar!.once("close", r));
        tar.kill("SIGKILL");
        await gone;
      }
      await rm(part, { recursive: true, force: true });
      if (e instanceof Error && e.message.startsWith("Not found:")) throw e;
      last = e;
    }
  }
  if (o.signal?.aborted) throw failure("cancelled");
  throw last instanceof Error ? last : new Error(String(last));
}

/** Runs `cmd args` and returns trimmed stdout, or null if it fails. */
export async function probe(c: BuiltinContext, cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await c.exec(cmd, args, { capture: true, silent: true, env });
  if (r.exitCode !== 0) return null;
  return (r.stdout || r.stderr).trim();
}

export async function readVersionFile(c: BuiltinContext, file: string, kind: "node" | "python" | "go"): Promise<string> {
  const p = path.resolve(c.job.workspace, file);
  if (!existsSync(p)) throw failure(`The specified ${kind} version file at: ${p} does not exist`);
  const content = await readFile(p, "utf8");
  const base = path.basename(p);
  if (base === "package.json") {
    try {
      const j = JSON.parse(content) as { volta?: { node?: string }; engines?: { node?: string }; devEngines?: { runtime?: { name?: string; version?: string } } };
      const v = j.volta?.node ?? j.devEngines?.runtime?.version ?? j.engines?.node;
      if (v) return v;
    } catch {
      /* fallthrough */
    }
    throw failure(`No node version found in ${p}`);
  }
  if (base === "go.mod" || base === "go.work") {
    const tc = /^toolchain\s+go(\S+)/m.exec(content);
    const g = /^go\s+(\d+(?:\.\d+){0,2})/m.exec(content);
    const v = tc?.[1] ?? g?.[1];
    if (!v) throw failure(`No go version found in ${p}`);
    return v;
  }
  if (base === ".tool-versions") {
    const names = kind === "node" ? ["nodejs", "node"] : kind === "python" ? ["python"] : ["golang", "go"];
    for (const line of content.split("\n")) {
      const [n, v] = line.trim().split(/\s+/);
      if (n && v && names.includes(n)) return v;
    }
    throw failure(`No ${kind} version found in ${p}`);
  }
  if (base === "pyproject.toml") {
    const m = /requires-python\s*=\s*["']([^"']+)["']/.exec(content);
    if (m) return m[1]!.replace(/,/g, " ");
    throw failure(`No python version found in ${p}`);
  }
  const first = content.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!first) throw failure(`The ${kind} version file at ${p} is empty`);
  return first.replace(/^v(?=\d)/, "");
}

/**
 * Restores a package-manager cache and registers a post-step save, the way
 * setup-node/setup-python/setup-go `cache:` do (same keys and paths, so their
 * caches are shared with the official actions).
 */
export async function packageCache(c: BuiltinContext, o: { key: string; paths: string[]; restoreKeys?: string[]; what: string }): Promise<void> {
  const paths = o.paths.filter(Boolean);
  if (!paths.length) {
    c.warn(`Could not determine the ${o.what} cache directory; skipping cache.`);
    return;
  }
  const r = await restoreCache(c, paths, o.key, o.restoreKeys ?? []);
  c.setOutput("cache-hit", isExactKeyMatch(o.key, r.matchedKey) ? "true" : "false");
  c.log(r.matchedKey ? `Cache restored from key: ${r.matchedKey}` : `${o.what} cache is not found`);
  c.registerPost(`Post ${c.name}`, "success()", async (pc) => {
    if (isExactKeyMatch(o.key, r.matchedKey)) {
      pc.log(`Cache hit occurred on the primary key ${o.key}, not saving cache.`);
      return;
    }
    if (!paths.some((p) => existsSync(p))) {
      pc.log(`The ${o.what} cache directories do not exist; not saving cache.`);
      return;
    }
    await saveCache(pc, paths, o.key);
  });
}

/** The hash of the first lock file that exists in the workspace root (setup-node/setup-go's default). */
export function rootLockHash(c: BuiltinContext, input: string, rootFiles: string[]): string {
  if (input) return hashFiles(c.job.workspace, inputList(input));
  const found = rootFiles.find((f) => existsSync(path.join(c.job.workspace, f)));
  if (!found) throw failure(`Dependencies lock file is not found in ${c.job.workspace}. Supported file patterns: ${rootFiles.join(",")}`);
  return hashFiles(c.job.workspace, [found]);
}
