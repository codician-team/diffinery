import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { errMsg, failure, type JobRunner } from "../job.js";
import { RuntimeError } from "../runtime.js";
import { globPaths, inputList, truthyInput } from "../util.js";
import type { Builtin, BuiltinContext } from "./index.js";

/**
 * actions/cache (and the `cache:` of setup-*), speaking the same cache service
 * and archive format as the official toolkit: a `tar --posix` archive of
 * workspace-relative paths, zstd-compressed when zstd is installed, keyed by
 * key + version (a hash of the path list and compression). Entries saved here
 * restore with the real action and vice versa.
 */

type Compression = "zstd-without-long" | "gzip";

const compressionOf = new WeakMap<JobRunner, Promise<Compression>>();

/** Same rule as @actions/cache: zstd when `zstd` runs, else gzip. */
export function cacheCompression(c: BuiltinContext): Promise<Compression> {
  let p = compressionOf.get(c.job);
  if (!p) {
    p = c.exec("zstd", ["--quiet", "--version"], { capture: true, silent: true }).then(
      (r) => (r.exitCode === 0 && (r.stdout + r.stderr).trim() ? "zstd-without-long" : "gzip"),
      () => "gzip" as const,
    );
    compressionOf.set(c.job, p);
  }
  return p;
}

/** @actions/cache's version: the path patterns as given, the compression, and its salt. */
export function cacheVersion(paths: string[], compression: Compression): string {
  return createHash("sha256").update([...paths, compression, "1.0"].join("|")).digest("hex");
}

const archiveName = (m: Compression) => (m === "gzip" ? "cache.tgz" : "cache.tzst");
const compressArgs = (m: Compression, mode: "create" | "extract") => (m === "gzip" ? ["-z"] : ["--use-compress-program", mode === "create" ? "zstdmt" : "unzstd"]);

/** Case-insensitive like actions/cache's isExactKeyMatch. */
export const isExactKeyMatch = (key: string, matched?: string) => !!matched && key.localeCompare(matched, undefined, { sensitivity: "accent" }) === 0;

export interface RestoreResult {
  matchedKey?: string;
  exact: boolean;
}

function runtimeOf(c: BuiltinContext) {
  const rt = c.job.runtime;
  if (!rt) c.warn("The cache service is not available to this job; skipping.");
  return rt;
}

/** Restores a cache entry; never throws for service errors (warns instead). */
export async function restoreCache(c: BuiltinContext, paths: string[], key: string, restoreKeys: string[], lookupOnly = false): Promise<RestoreResult> {
  if (!key) throw failure("Input required and not supplied: key");
  if (paths.length === 0) throw failure("Input required and not supplied: path");
  for (const k of [key, ...restoreKeys]) {
    if (k.length > 512) throw failure(`Key Validation Error: ${k} cannot be larger than 512 characters.`);
    if (k.includes(",")) throw failure(`Key Validation Error: ${k} cannot contain commas.`);
  }
  const rt = runtimeOf(c);
  if (!rt) return { exact: false };
  const compression = await cacheCompression(c);
  let hit: { ok: boolean; signed_download_url?: string; matched_key?: string };
  try {
    hit = await rt.twirp("CacheService", "GetCacheEntryDownloadURL", { key, restore_keys: restoreKeys, version: cacheVersion(paths, compression) });
  } catch (e) {
    c.warn(`Failed to restore: ${errMsg(e)}`);
    return { exact: false };
  }
  if (!hit.ok || !hit.matched_key || !hit.signed_download_url) return { exact: false };
  const exact = isExactKeyMatch(key, hit.matched_key);
  if (lookupOnly) return { matchedKey: hit.matched_key, exact };
  const dir = path.join(c.job.tempDir, `cache-${randomUUID()}`);
  const ws = c.job.workspace;
  const indexes = [path.join(dir, "extracted-1"), path.join(dir, "extracted-2")];
  const since = Date.now();
  const extract = (from: string, index: string, input?: Readable) =>
    c.exec("tar", ["-xvf", from, "--index-file", index, "-P", "-C", ws, ...compressArgs(compression, "extract")], { silent: true, capture: true, input });
  const tarFailed = (r: { exitCode: number; stderr: string }) => new Error(`tar failed with exit code ${r.exitCode}: ${r.stderr.trim().split("\n").slice(-3).join(" ")}`);
  try {
    await mkdir(dir, { recursive: true });
    await mkdir(ws, { recursive: true });
    // Downloaded in ranges, several at once, straight into tar: the archive extracts while it arrives.
    let streamError: unknown;
    try {
      const dl = rt.downloadStream(hit.signed_download_url, { onSize: (size) => c.log(`Cache Size: ~${Math.round(size / 1024 / 1024)} MB (${size} B)`) });
      dl.once("error", (e) => (streamError = e));
      const r = await extract("-", indexes[0]!, dl);
      if (streamError) throw streamError;
      if (r.exitCode !== 0) throw tarFailed(r);
      return { matchedKey: hit.matched_key, exact };
    } catch (e) {
      if (c.job.isStopping) throw e;
      c.log(`Streaming the cache entry failed (${errMsg(streamError ?? e)}); downloading it in full and extracting it again.`);
    }
    // Once more from a file, like @actions/cache: extracting the whole archive again replaces anything the stream left half done.
    const file = path.join(dir, archiveName(compression));
    await rt.download(hit.signed_download_url, file);
    const r = await extract(file, indexes[1]!);
    if (r.exitCode !== 0) throw tarFailed(r);
    return { matchedKey: hit.matched_key, exact };
  } catch (e) {
    // Nothing half restored stays behind: a job that misses the cache installs from scratch, one with half a cache may not notice.
    await undoExtraction(ws, indexes, since).catch((u: unknown) => c.warn(`Could not remove a partly restored cache: ${errMsg(u)}`));
    c.warn(`Failed to restore: ${errMsg(e)}`);
    return { exact: false };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Removes what a failed restore extracted: the entries tar listed (its --index-file) that were
 * created or replaced since the restore began (their ctime, which tar can't set). Directories go
 * only when empty, deepest first; the workspace itself stays.
 */
export async function undoExtraction(ws: string, indexes: string[], since: number): Promise<void> {
  const dirs = new Set<string>();
  for (const index of indexes) {
    let text: string;
    try {
      text = await readFile(index, "utf8");
    } catch {
      continue;
    }
    for (const name of text.split("\n")) {
      if (!name) continue;
      const p = path.resolve(ws, name);
      if (p === ws || p === path.parse(p).root) continue;
      const st = await lstat(p).catch(() => null);
      if (!st || st.ctimeMs < since - 1) continue;
      if (st.isDirectory()) dirs.add(p);
      else await rm(p, { force: true });
    }
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) await rmdir(d).catch(() => {});
}

/** Archives `paths` and saves it under `key`. Never throws for service errors. */
export async function saveCache(c: BuiltinContext, paths: string[], key: string): Promise<boolean> {
  const rt = runtimeOf(c);
  if (!rt) return false;
  const ws = c.job.workspace;
  const resolved = globPaths(ws, paths).map((f) => path.relative(ws, f) || ".");
  if (resolved.length === 0) {
    c.warn("Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.");
    return false;
  }
  const compression = await cacheCompression(c);
  const dir = path.join(c.job.tempDir, `cache-${randomUUID()}`);
  const name = archiveName(compression);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "manifest.txt"), resolved.join("\n"));
    await c.run("tar", ["--posix", "-cf", name, "--exclude", name, "-P", "-C", ws, "--files-from", "manifest.txt", ...compressArgs(compression, "create")], { cwd: dir, silent: true });
    const file = path.join(dir, name);
    const size = (await stat(file)).size;
    c.log(`Cache Size: ~${Math.round(size / 1024 / 1024)} MB (${size} B)`);
    if (size > 10 * 1024 ** 3) {
      c.warn(`Cache size of ~${Math.round(size / 1024 / 1024)} MB (${size} B) is over the 10GB limit, not saving cache.`);
      return false;
    }
    const version = cacheVersion(paths, compression);
    let created: { ok: boolean; signed_upload_url?: string; message?: string };
    try {
      created = await rt.twirp("CacheService", "CreateCacheEntry", { key, version });
    } catch (e) {
      if (e instanceof RuntimeError && e.status === 409) {
        c.warn(`Failed to save: Unable to reserve cache with key ${key}, another job may be creating this cache.`);
        return false;
      }
      throw e;
    }
    if (!created.ok || !created.signed_upload_url) throw new Error(created.message || `Unable to reserve cache with key ${key}`);
    await rt.upload(created.signed_upload_url, file);
    const done = await rt.twirp<{ ok: boolean; message?: string }>("CacheService", "FinalizeCacheEntryUpload", { key, version, size_bytes: String(size) });
    if (!done.ok) throw new Error(done.message || `Unable to finalize cache with key ${key}`);
    c.log(`Cache saved with key: ${key}`);
    return true;
  } catch (e) {
    c.warn(`Failed to save: ${errMsg(e)}`);
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** actions/cache's path list: one per line, `! pattern` normalised to `!pattern`. */
const pathInput = (c: BuiltinContext) => inputList(c.input("path")).map((p) => p.replace(/^!\s+/, "!"));

function restoreInputs(c: BuiltinContext) {
  const key = c.input("key");
  if (!key) throw failure("Input required and not supplied: key");
  const paths = pathInput(c);
  if (!paths.length) throw failure("Input required and not supplied: path");
  return { key, paths, restoreKeys: inputList(c.input("restore-keys")), lookupOnly: truthyInput(c.input("lookup-only"), false), failOnMiss: truthyInput(c.input("fail-on-cache-miss"), false) };
}

async function restoreStep(c: BuiltinContext, o: ReturnType<typeof restoreInputs>): Promise<RestoreResult> {
  const r = await restoreCache(c, o.paths, o.key, o.restoreKeys, o.lookupOnly);
  if (!r.matchedKey) {
    if (o.failOnMiss) throw failure(`Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: ${o.key}`);
    c.log(`Cache not found for input keys: ${[o.key, ...o.restoreKeys].join(", ")}`);
    return r;
  }
  c.setOutput("cache-hit", r.exact ? "true" : "false");
  c.log(o.lookupOnly ? `Cache found and can be restored from key: ${r.matchedKey}` : `Cache restored from key: ${r.matchedKey}`);
  return r;
}

export const cacheAction: Builtin = async (c) => {
  const o = restoreInputs(c);
  const r = await restoreStep(c, o);
  const saveAlways = truthyInput(c.input("save-always"), false);
  c.registerPost(`Post ${c.name}`, saveAlways ? "always()" : "success()", async (pc) => {
    if (isExactKeyMatch(o.key, r.matchedKey)) {
      pc.log(`Cache hit occurred on the primary key ${o.key}, not saving cache.`);
      return;
    }
    await saveCache(pc, o.paths, o.key);
  });
};

export const cacheRestoreAction: Builtin = async (c) => {
  const o = restoreInputs(c);
  c.setOutput("cache-primary-key", o.key);
  const r = await restoreStep(c, o);
  if (r.matchedKey) c.setOutput("cache-matched-key", r.matchedKey);
};

export const cacheSaveAction: Builtin = async (c) => {
  const key = c.input("key");
  if (!key) throw failure("Input required and not supplied: key");
  const paths = pathInput(c);
  if (!paths.length) throw failure("Input required and not supplied: path");
  await saveCache(c, paths, key);
};
