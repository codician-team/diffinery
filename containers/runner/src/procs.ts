import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import type { Masker } from "./mask.js";
import { killTree } from "./util.js";

/**
 * Background processes in a sandbox: a coding agent's run can last hours, far
 * longer than one /exec request. Each process writes stdout and stderr to its
 * own files; callers read them from an offset while it runs, and after.
 *
 * Values passed in `secretEnv` (a person's model API key) reach only that
 * process's environment, and are added to the sandbox's masker so no output
 * the sandbox returns ever contains them.
 */

export interface ProcStart {
  id: string;
  cmd: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  secretEnv?: Record<string, string>;
  timeoutMs?: number;
}

export interface ProcRead {
  id: string;
  running: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Offsets to pass to the next read. */
  stdoutOffset: number;
  stderrOffset: number;
}

interface Proc {
  child: ChildProcess;
  out: string;
  err: string;
  files: WriteStream[];
  exitCode: number | null;
  running: boolean;
  timedOut: boolean;
  timer?: NodeJS.Timeout;
  done: Promise<void>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Each read returns at most this much of each stream. */
export const MAX_READ = 512 * 1024;

export class ProcTable {
  private procs = new Map<string, Proc>();

  constructor(
    private dir: string,
    private masker: Masker,
  ) {}

  async start(o: ProcStart): Promise<{ id: string; pid: number | null }> {
    if (!ID.test(o.id)) throw new Error("`id` must be 1-64 letters, digits, - or _");
    const prev = this.procs.get(o.id);
    if (prev?.running) throw new Error(`process ${o.id} is already running`);
    await mkdir(this.dir, { recursive: true });
    for (const v of Object.values(o.secretEnv ?? {})) this.masker.add(v);
    const out = path.join(this.dir, `${o.id}.out`);
    const err = path.join(this.dir, `${o.id}.err`);
    const files = [createWriteStream(out, { flags: "w" }), createWriteStream(err, { flags: "w" })];
    const child = spawn("bash", ["-c", o.cmd], { cwd: o.cwd, env: { ...o.env, ...o.secretEnv }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.pipe(files[0]!);
    child.stderr!.pipe(files[1]!);
    let finish!: () => void;
    const p: Proc = { child, out, err, files, exitCode: null, running: true, timedOut: false, done: new Promise((r) => (finish = r)) };
    const end = (code: number) => {
      if (!p.running) return;
      p.running = false;
      p.exitCode = p.timedOut ? 124 : code;
      if (p.timer) clearTimeout(p.timer);
      // Let the pipes drain into the files before readers see the exit.
      let open = files.length;
      for (const f of files) f.end(() => --open === 0 && finish());
    };
    child.on("error", (e) => {
      files[1]!.write(`${e.message}\n`);
      end(127);
    });
    child.on("close", (code, signal) => end(code ?? (signal ? 128 + 15 : 1)));
    if (o.timeoutMs && o.timeoutMs > 0) {
      p.timer = setTimeout(() => {
        p.timedOut = true;
        killTree(child);
      }, o.timeoutMs);
    }
    this.procs.set(o.id, p);
    return { id: o.id, pid: child.pid ?? null };
  }

  async read(id: string, stdoutOffset = 0, stderrOffset = 0): Promise<ProcRead> {
    const p = this.procs.get(id);
    if (!p) throw new Error(`no process ${id}`);
    // Once it has exited, wait for the last output to reach the files.
    if (!p.running) await p.done;
    const [so, se] = await Promise.all([this.chunk(p.out, stdoutOffset, p.running), this.chunk(p.err, stderrOffset, p.running)]);
    return { id, running: p.running, exitCode: p.exitCode, timedOut: p.timedOut, stdout: this.masker.mask(so.text), stderr: this.masker.mask(se.text), stdoutOffset: so.next, stderrOffset: se.next };
  }

  kill(id: string, signal: "SIGTERM" | "SIGKILL" | "SIGINT" = "SIGTERM"): boolean {
    const p = this.procs.get(id);
    if (!p?.running) return false;
    if (signal === "SIGTERM") killTree(p.child);
    else {
      try {
        process.kill(-p.child.pid!, signal);
      } catch {
        p.child.kill(signal);
      }
    }
    return true;
  }

  killAll(): void {
    for (const id of this.procs.keys()) this.kill(id);
  }

  /**
   * Bytes from `offset`, ending at a line break while the process runs so a
   * masked value is never split between two reads (a single line longer than
   * MAX_READ is the exception).
   */
  private async chunk(file: string, offset: number, running: boolean): Promise<{ text: string; next: number }> {
    if (!existsSync(file)) return { text: "", next: offset };
    const size = (await stat(file)).size;
    if (offset >= size) return { text: "", next: offset };
    const len = Math.min(size - offset, MAX_READ);
    const fh = await open(file, "r");
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      let end = len;
      const partial = running || offset + len < size;
      if (partial) {
        const nl = buf.lastIndexOf(0x0a);
        if (nl >= 0) end = nl + 1;
        else if (len < MAX_READ) end = 0;
      }
      return { text: buf.subarray(0, end).toString("utf8"), next: offset + end };
    } finally {
      await fh.close();
    }
  }
}
