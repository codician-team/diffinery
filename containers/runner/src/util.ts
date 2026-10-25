import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync, accessSync, readdirSync, readFileSync, constants as fsc } from "node:fs";
import path from "node:path";
import { constants } from "node:os";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function nowIso(): string {
  return new Date().toISOString();
}

/** Splits a command line into words, honouring single and double quotes. */
export function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === q) q = null;
      else if (ch === "\\" && q === '"' && (s[i + 1] === '"' || s[i + 1] === "\\")) cur += s[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Locates an executable in a PATH string. */
export function which(cmd: string, pathEnv: string | undefined = process.env.PATH): string | null {
  if (cmd.includes("/")) return existsSync(cmd) ? cmd : null;
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      accessSync(p, fsc.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  /** Written to the process's stdin: a string, or a stream piped in (destroying the stream ends stdin). */
  input?: string | Readable;
  timeoutMs?: number;
  /** Called with the child so callers can kill it on cancellation. */
  onSpawn?: (child: ChildProcess) => void;
  /** Collect stdout/stderr (bounded). */
  capture?: boolean;
  maxCapture?: number;
}

export interface ExecResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** Kills a detached child's whole process group. */
export function killTree(child: ChildProcess, graceMs = 5000): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const k = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* gone */
      }
    }
  };
  k("SIGTERM");
  const t = setTimeout(() => k("SIGKILL"), graceMs);
  t.unref();
  child.once("exit", () => clearTimeout(t));
}

/** Splits a stream into lines, invoking `cb` per line (partial last line flushed at end). */
export class LineSplitter {
  private buf = "";
  constructor(private cb: (line: string) => void) {}
  write(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      this.cb(line);
    }
  }
  end(): void {
    if (this.buf.length) {
      const l = this.buf.replace(/\r$/, "");
      this.buf = "";
      this.cb(l);
    }
  }
}

/** Spawns a process in its own process group and streams its output by line. */
export function exec(cmd: string, args: string[], o: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const max = o.maxCapture ?? 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: o.cwd,
        env: o.env,
        detached: true,
        stdio: [o.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ exitCode: 127, signal: null, stdout: "", stderr: String(e), timedOut: false, stdoutTruncated, stderrTruncated });
      return;
    }
    o.onSpawn?.(child);
    const so = new LineSplitter((l) => o.onLine?.(l, "stdout"));
    const se = new LineSplitter((l) => o.onLine?.(l, "stderr"));
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      if (o.capture) {
        if (stdout.length < max) stdout += d;
        else stdoutTruncated = true;
      }
      so.write(d);
    });
    child.stderr!.on("data", (d: string) => {
      if (o.capture) {
        if (stderr.length < max) stderr += d;
        else stderrTruncated = true;
      }
      se.write(d);
    });
    if (typeof o.input === "string") {
      child.stdin!.on("error", () => {});
      child.stdin!.end(o.input);
    } else if (o.input) {
      // Either side failing stops the other: a failed source ends stdin, an exited process stops the source.
      pipeline(o.input, child.stdin!).catch(() => {});
    }
    let timer: NodeJS.Timeout | undefined;
    if (o.timeoutMs && o.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, o.timeoutMs);
    }
    let spawnError: Error | null = null;
    child.on("error", (e) => {
      spawnError = e;
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      so.end();
      se.end();
      if (stdout.length > max) {
        stdout = stdout.slice(0, max);
        stdoutTruncated = true;
      }
      if (stderr.length > max) {
        stderr = stderr.slice(0, max);
        stderrTruncated = true;
      }
      if (spawnError && code === null) {
        const msg = (spawnError as NodeJS.ErrnoException).code === "ENOENT" ? `${cmd}: command not found` : String(spawnError);
        o.onLine?.(msg, "stderr");
        resolve({ exitCode: 127, signal: null, stdout, stderr: stderr + msg, timedOut, stdoutTruncated, stderrTruncated });
        return;
      }
      resolve({ exitCode: code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1), signal, stdout, stderr, timedOut, stdoutTruncated, stderrTruncated });
    });
  });
}

// ---------------------------------------------------------------- glob

function globToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more directories
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i++;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const j = pattern.indexOf("]", i);
      if (j > i) {
        re += pattern.slice(i, j + 1).replace(/^\[!/, "[^");
        i = j;
      } else re += "\\[";
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function walk(root: string, rel: string, out: string[], skip: (rel: string) => boolean, includeDirs: boolean): void {
  let entries;
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (skip(r)) continue;
    if (e.isDirectory()) {
      if (includeDirs) out.push(r + "/");
      walk(root, r, out, skip, includeDirs);
    } else out.push(r);
  }
}

/**
 * Expands glob patterns (relative to `root`, or absolute) into absolute file
 * paths. Supports `*`, `**`, `?`, `[...]` and `!negation`. Literal paths
 * (no glob chars) are returned as-is when they exist (files or directories).
 */
export function globPaths(root: string, patterns: string[], opts: { filesOnly?: boolean } = {}): string[] {
  const include: Array<{ base: string; re: RegExp | null; literal: string | null }> = [];
  const exclude: RegExp[] = [];
  const results = new Set<string>();
  for (let p of patterns) {
    p = p.trim();
    if (!p || p.startsWith("#")) continue;
    const neg = p.startsWith("!");
    if (neg) p = p.slice(1);
    if (p.startsWith("~/")) p = path.join(process.env.HOME ?? "/root", p.slice(2));
    const abs = path.isAbsolute(p) ? p : path.join(root, p);
    if (neg) {
      exclude.push(globToRegex(path.normalize(abs).replace(/\/$/, "")));
      exclude.push(globToRegex(path.normalize(abs).replace(/\/$/, "") + "/**"));
      continue;
    }
    if (!/[*?[]/.test(abs)) {
      include.push({ base: abs, re: null, literal: path.normalize(abs) });
      continue;
    }
    // base dir = longest prefix without glob chars
    const parts = path.normalize(abs).split("/");
    const baseParts: string[] = [];
    for (const part of parts) {
      if (/[*?[]/.test(part)) break;
      baseParts.push(part);
    }
    include.push({ base: baseParts.join("/") || "/", re: globToRegex(path.normalize(abs)), literal: null });
  }
  for (const inc of include) {
    if (inc.literal) {
      if (existsSync(inc.literal)) {
        if (opts.filesOnly && statSync(inc.literal).isDirectory()) {
          const files: string[] = [];
          walk(inc.literal, "", files, () => false, false);
          for (const f of files) results.add(path.join(inc.literal, f));
        } else results.add(inc.literal);
      }
      continue;
    }
    const files: string[] = [];
    walk(inc.base, "", files, (r) => r === ".git" || r.endsWith("/.git"), !opts.filesOnly);
    for (const f of files) {
      const full = path.join(inc.base, f.replace(/\/$/, ""));
      if (inc.re!.test(full)) results.add(full);
    }
  }
  let list = [...results];
  if (exclude.length) list = list.filter((f) => !exclude.some((re) => re.test(f)));
  // drop entries that are inside another included directory (avoid duplicates in tarballs)
  if (!opts.filesOnly) {
    const set = new Set(list);
    list = list.filter((f) => {
      let d = path.dirname(f);
      while (d !== "/" && d !== ".") {
        if (set.has(d)) return false;
        d = path.dirname(d);
      }
      return true;
    });
  }
  return list.sort();
}

/** `hashFiles()` as on GitHub: sha256 over the sha256 of each matched file (workspace-relative). */
export function hashFiles(workspace: string, patterns: string[]): string {
  const files = globPaths(workspace, patterns, { filesOnly: true }).filter((f) => f.startsWith(workspace + "/"));
  if (files.length === 0) return "";
  const outer = createHash("sha256");
  for (const f of files) {
    try {
      outer.update(createHash("sha256").update(readFileSync(f)).digest());
    } catch {
      /* unreadable: skip */
    }
  }
  return outer.digest("hex");
}

// ---------------------------------------------------------------- semver-ish

export type Ver = [number, number, number];

export function parseVer(v: string): Ver | null {
  const m = /^\s*[vV]?(?:go)?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function cmpVer(a: Ver, b: Ver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Matches a version against a range like `22`, `22.x`, `^20.1`, `>=18 <21`, `20 || 22`, `*`. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVer(version);
  if (!v) return false;
  const r = range.trim();
  if (r === "" || r === "*" || r === "x" || /^(latest|current|node|stable)$/i.test(r)) return true;
  return r.split("||").some((alt) => {
    const comps = alt.trim().replace(/([<>=~^]+)\s+/g, "$1").split(/\s+/).filter(Boolean);
    // hyphen range "a - b"
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(alt.trim());
    if (hy) {
      const lo = parseVer(hy[1]!);
      const hi = parseVer(hy[2]!);
      return !!lo && !!hi && cmpVer(v, lo) >= 0 && cmpVer(v, hi) <= 0;
    }
    return comps.every((c) => matchComparator(v, c));
  });
}

function matchComparator(v: Ver, c: string): boolean {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*[vV]?(.*)$/.exec(c)!;
  const op = m[1] ?? "";
  const body = m[2]!;
  const parts = body.split(".");
  const nums: Array<number | null> = [0, 1, 2].map((i) => {
    const p = parts[i];
    if (p === undefined || p === "x" || p === "X" || p === "*" || p === "") return null;
    const n = parseInt(p, 10);
    return Number.isNaN(n) ? null : n;
  });
  if (nums[0] === null) return true;
  const full: Ver = [nums[0]!, nums[1] ?? 0, nums[2] ?? 0];
  const specified = nums[1] === null ? 1 : nums[2] === null ? 2 : 3;
  const cmp = cmpVer(v, full);
  switch (op) {
    case ">=": return cmp >= 0;
    case "<=": return specified === 3 ? cmp <= 0 : cmpVer(v, bump(full, specified)) < 0;
    case ">": return specified === 3 ? cmp > 0 : cmpVer(v, bump(full, specified)) >= 0;
    case "<": return cmp < 0;
    case "^": {
      const hi: Ver = full[0] > 0 || specified === 1 ? [full[0] + 1, 0, 0] : full[1] > 0 || specified === 2 ? [0, full[1] + 1, 0] : [0, 0, full[2] + 1];
      return cmp >= 0 && cmpVer(v, hi) < 0;
    }
    case "~": {
      const hi: Ver = specified === 1 ? [full[0] + 1, 0, 0] : [full[0], full[1] + 1, 0];
      return cmp >= 0 && cmpVer(v, hi) < 0;
    }
    default:
      return cmp >= 0 && cmpVer(v, bump(full, specified)) < 0;
  }
}

function bump(v: Ver, specified: number): Ver {
  if (specified === 1) return [v[0] + 1, 0, 0];
  if (specified === 2) return [v[0], v[1] + 1, 0];
  return [v[0], v[1], v[2] + 1];
}

/** Picks the highest version from `versions` that satisfies `range`. */
export function maxSatisfying(versions: string[], range: string): string | null {
  let best: string | null = null;
  let bestV: Ver | null = null;
  for (const s of versions) {
    if (!satisfies(s, range)) continue;
    const v = parseVer(s)!;
    if (!bestV || cmpVer(v, bestV) > 0) {
      best = s;
      bestV = v;
    }
  }
  return best;
}

export function runnerArch(): "X64" | "ARM64" | "ARM" | "X86" {
  switch (process.arch) {
    case "arm64": return "ARM64";
    case "arm": return "ARM";
    case "ia32": return "X86";
    default: return "X64";
  }
}

/** Splits a multi-line / comma-ish input into entries. */
export function inputList(v: string | undefined, splitComma = false): string[] {
  if (!v) return [];
  return v
    .split(splitComma ? /[\n,]/ : /\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function truthyInput(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  return /^(true|yes|1|on)$/i.test(v.trim());
}
