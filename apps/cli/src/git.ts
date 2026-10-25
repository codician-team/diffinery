import { spawn } from "node:child_process";
import { CliError, type Io } from "./io.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git and captures its output. */
export function gitCapture(io: Io, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", args, { cwd: o.cwd ?? io.cwd, env: o.env ?? io.env, stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: 127, stdout: "", stderr: String((e as Error).message) });
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (child.stdin) {
      child.stdin.on("error", () => {}); // git may exit before reading its input
      child.stdin.end(o.input);
    }
  });
}

/** Runs git with output going to the user's terminal (clone/push progress). */
export function gitInteractive(io: Io, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: o.cwd ?? io.cwd, env: o.env ?? io.env, stdio: ["inherit", "pipe", "pipe"] });
    child.stdout.on("data", (d: Buffer) => io.stdout.write(d.toString()));
    child.stderr.on("data", (d: Buffer) => io.stderr.write(d.toString()));
    child.on("error", (e) => reject(new CliError(`could not run git: ${e.message}`)));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function git(io: Io, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const r = await gitCapture(io, args, o);
  if (r.code !== 0) throw new CliError(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

/**
 * Environment that adds one-off git config for a single git invocation
 * (GIT_CONFIG_COUNT/KEY/VALUE, git 2.31+). Unlike `-c`, values do not show up
 * in the process list, and like `-c` they are never written to .git/config.
 */
export function withGitConfig(env: NodeJS.ProcessEnv, entries: Array<[string, string]>): NodeJS.ProcessEnv {
  const out = { ...env };
  let n = Number(out.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isInteger(n) || n < 0) n = 0;
  for (const [k, v] of entries) {
    out[`GIT_CONFIG_KEY_${n}`] = k;
    out[`GIT_CONFIG_VALUE_${n}`] = v;
    n++;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

/** `http.<url>.extraHeader` entry that authenticates git HTTP requests to `baseUrl` only. */
export function basicAuthHeader(baseUrl: string, user: string, password: string): [string, string] {
  return [`http.${baseUrl.replace(/\/$/, "")}/.extraHeader`, `Authorization: Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`];
}

/** Parses owner/name out of a remote URL that points at `host` (https, ssh or scp-like). */
export function parseRemote(remote: string, host: string): { owner: string; name: string } | null {
  const r = remote.trim();
  let h: string;
  let p: string;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(r);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(r)) {
    try {
      const u = new URL(r);
      h = u.host;
      p = decodeURIComponent(u.pathname);
      if (u.protocol === "ssh:" && u.port) h = u.hostname; // ssh port differs from the web port
    } catch {
      return null;
    }
  } else if (scp) {
    h = scp[1]!;
    p = scp[2]!;
  } else return null;
  const want = host.toLowerCase();
  if (h.toLowerCase() !== want && h.toLowerCase() !== want.replace(/:\d+$/, "")) return null;
  const parts = p.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const name = parts[1].replace(/\.git$/, "");
  return name ? { owner: parts[0], name } : null;
}

export async function currentBranch(io: Io): Promise<string> {
  const r = await gitCapture(io, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (r.code !== 0 || !r.stdout.trim()) throw new CliError("could not determine the current branch (detached HEAD or not a git repository); pass --head");
  return r.stdout.trim();
}
