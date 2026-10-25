import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { WebSocketServer } from "ws";
import { basicAuthHeader } from "./builtins/checkout.js";
import { Masker } from "./mask.js";
import { SHARED_ENV } from "./jail.js";
import { ProcTable } from "./procs.js";
import { Terminal } from "./terminal.js";
import { exec } from "./util.js";

export interface SandboxOptions {
  port: number;
  host?: string;
  secret: string;
  workRoot: string;
  cloneUrl?: string;
  ref?: string;
  token?: string;
  /** Extra values to mask in /exec output. */
  maskValues?: string[];
  maxOutputBytes?: number;
  baseEnv?: NodeJS.ProcessEnv;
  /** The runner's own script, for `--jail` (default: the one running). */
  agentPath?: string;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export interface SandboxHandle {
  server: Server;
  port: number;
  repoDir: string;
  ready: Promise<void>;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024 * 1024;
const SENSITIVE = ["DIFFINERY_JOB_TOKEN", "DIFFINERY_SANDBOX_SECRET"];

class HttpErr extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpErr(413, "request body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpErr(400, "invalid JSON body");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function authorized(req: IncomingMessage, secret: string): boolean {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || !secret) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return { text: s, truncated: false };
  return { text: buf.subarray(0, max).toString("utf8"), truncated: true };
}

async function cloneRepo(o: SandboxOptions, repoDir: string, masker: Masker, log: (l: string) => void): Promise<void> {
  if (!o.cloneUrl) {
    await mkdir(repoDir, { recursive: true });
    return;
  }
  if (existsSync(path.join(repoDir, ".git"))) return;
  await mkdir(path.dirname(repoDir), { recursive: true });
  const auth = o.token && /^https?:/i.test(o.cloneUrl) ? ["-c", `http.extraheader=${basicAuthHeader(o.token)}`] : [];
  const env: NodeJS.ProcessEnv = { ...(o.baseEnv ?? process.env), GIT_TERMINAL_PROMPT: "0" };
  for (const k of SENSITIVE) delete env[k];
  const onLine = (l: string) => log(masker.mask(l));
  const r = await exec("git", [...auth, "clone", "--no-tags", o.cloneUrl, repoDir], { env, onLine, capture: true });
  if (r.exitCode !== 0) throw new Error(`git clone failed (exit ${r.exitCode}): ${masker.mask(r.stderr.trim().split("\n").slice(-3).join(" "))}`);
  if (auth.length) {
    await exec("git", ["config", "--local", `http.${new URL(o.cloneUrl).origin}/.extraheader`, basicAuthHeader(o.token!)], { cwd: repoDir, env });
  }
  if (o.ref) {
    const ref = o.ref;
    const short = ref.replace(/^refs\/heads\//, "");
    let c = await exec("git", ["checkout", "-q", short], { cwd: repoDir, env, capture: true });
    if (c.exitCode !== 0) {
      const f = await exec("git", [...auth, "fetch", "-q", "origin", ref], { cwd: repoDir, env, capture: true });
      if (f.exitCode === 0) c = await exec("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: repoDir, env, capture: true });
      if (c.exitCode !== 0) throw new Error(`could not check out ${ref}: ${masker.mask(c.stderr.trim())}`);
    }
  }
}

/** Starts the AI-agent task sandbox HTTP server. */
export async function startSandbox(o: SandboxOptions): Promise<SandboxHandle> {
  const masker = new Masker();
  masker.add(o.secret);
  if (o.token) masker.add(o.token);
  if (o.token) masker.add(basicAuthHeader(o.token).slice("AUTHORIZATION: basic ".length));
  for (const v of o.maskValues ?? []) masker.add(v);
  const repoDir = path.join(o.workRoot, "repo");
  const maxOut = o.maxOutputBytes ?? 1024 * 1024;
  let cloneError: string | null = null;
  let isReady = false;
  const ready = cloneRepo(o, repoDir, masker, (l) => process.stdout.write(`[sandbox] ${l}\n`))
    .then(() => {
      isReady = true;
    })
    .catch((e: unknown) => {
      cloneError = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[sandbox] ${cloneError}\n`);
    });

  const procs = new ProcTable(path.join(o.workRoot, ".procs"), masker);
  // A terminal task's jail (jail.ts), as one command: "$DIFFINERY_JAIL" agent --dir ... -- claude -p ...
  const jailBin = path.join(o.workRoot, ".jail");
  await mkdir(o.workRoot, { recursive: true });
  await writeFile(jailBin, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(o.agentPath ?? process.argv[1]!)} --jail --root ${shellQuote(o.workRoot)} "$@"\n`, { mode: 0o755 });
  const baseEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...(o.baseEnv ?? process.env), CI: "true", DIFFINERY: "true", DIFFINERY_SANDBOX: "true", DIFFINERY_JAIL: jailBin };
    for (const k of SENSITIVE) delete env[k];
    return env;
  };
  const strings = (v: unknown, field: string): Record<string, string> => {
    if (v === undefined || v === null) return {};
    if (typeof v !== "object" || Array.isArray(v)) throw new HttpErr(400, `\`${field}\` must be an object of strings`);
    // Only the pool's own environment shares directories with jails (end-to-end tests), never a request.
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== SHARED_ENV).map(([k, x]) => [k, String(x)]));
  };

  // The web terminal's shell: interactive, so not CI, and without the sandbox's own credentials.
  const terminal = new Terminal(o.workRoot, () => (existsSync(repoDir) ? repoDir : o.workRoot), () => {
    const env = baseEnv();
    delete env.CI;
    return { ...env, IS_SANDBOX: "1" };
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const resolvePath = (p: unknown): string => {
    if (typeof p !== "string" || !p) throw new HttpErr(400, "`path` is required");
    return path.isAbsolute(p) ? p : path.join(repoDir, p);
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://sandbox");
      try {
        if (req.method === "GET" && url.pathname === "/health") {
          send(res, 200, { ok: true, ready: isReady, ...(cloneError ? { error: cloneError } : {}) });
          return;
        }
        if (!authorized(req, o.secret)) throw new HttpErr(401, "unauthorized");
        if (req.method !== "POST") throw new HttpErr(405, "method not allowed");
        const body = (await readBody(req)) as Record<string, unknown>;
        await ready;
        switch (url.pathname) {
          case "/exec": {
            const cmd = body.cmd;
            if (typeof cmd !== "string" || !cmd) throw new HttpErr(400, "`cmd` is required");
            const cwd = body.cwd ? resolvePath(body.cwd) : repoDir;
            if (!existsSync(cwd)) throw new HttpErr(400, `cwd does not exist: ${cwd}`);
            const env = baseEnv();
            if (body.env && typeof body.env === "object") for (const [k, v] of Object.entries(body.env)) if (k !== SHARED_ENV) env[k] = String(v);
            const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : 10 * 60_000;
            const started = Date.now();
            const r = await exec("bash", ["-c", cmd], { cwd, env, timeoutMs, capture: true, maxCapture: maxOut + 1 });
            const so = truncate(masker.mask(r.stdout), maxOut);
            const se = truncate(masker.mask(r.stderr), maxOut);
            send(res, 200, {
              exitCode: r.timedOut ? 124 : r.exitCode,
              stdout: so.text,
              stderr: se.text,
              timedOut: r.timedOut,
              truncated: so.truncated || se.truncated || r.stdoutTruncated || r.stderrTruncated,
              durationMs: Date.now() - started,
            });
            return;
          }
          case "/files/read": {
            const p = resolvePath(body.path);
            let st;
            try {
              st = await stat(p);
            } catch {
              throw new HttpErr(404, `not found: ${body.path}`);
            }
            if (st.isDirectory()) throw new HttpErr(400, "path is a directory");
            if (st.size > MAX_BODY) throw new HttpErr(413, "file too large");
            const data = await readFile(p);
            send(res, 200, { path: p, size: st.size, content: data.toString("base64") });
            return;
          }
          case "/files/write": {
            const p = resolvePath(body.path);
            if (typeof body.content !== "string") throw new HttpErr(400, "`content` (base64) is required");
            const data = Buffer.from(body.content, "base64");
            await mkdir(path.dirname(p), { recursive: true });
            await writeFile(p, data, typeof body.mode === "number" ? { mode: body.mode } : undefined);
            send(res, 200, { ok: true, path: p, size: data.length });
            return;
          }
          // Background processes (procs.ts): long agent runs that outlive one request.
          case "/proc/start": {
            if (typeof body.id !== "string" || typeof body.cmd !== "string" || !body.cmd) throw new HttpErr(400, "`id` and `cmd` are required");
            const cwd = body.cwd ? resolvePath(body.cwd) : repoDir;
            if (!existsSync(cwd)) throw new HttpErr(400, `cwd does not exist: ${cwd}`);
            const env = { ...baseEnv(), ...strings(body.env, "env") };
            const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : undefined;
            try {
              send(res, 200, await procs.start({ id: body.id, cmd: body.cmd, cwd, env, secretEnv: strings(body.secretEnv, "secretEnv"), timeoutMs }));
            } catch (e) {
              throw new HttpErr(409, masker.mask(e instanceof Error ? e.message : String(e)));
            }
            return;
          }
          case "/proc/read": {
            if (typeof body.id !== "string") throw new HttpErr(400, "`id` is required");
            const off = (v: unknown) => (typeof v === "number" && v >= 0 ? v : 0);
            try {
              send(res, 200, await procs.read(body.id, off(body.stdoutOffset), off(body.stderrOffset)));
            } catch (e) {
              throw new HttpErr(404, e instanceof Error ? e.message : String(e));
            }
            return;
          }
          case "/pty/status": {
            send(res, 200, terminal.status());
            return;
          }
          case "/pty/kill": {
            terminal.kill();
            send(res, 200, { ok: true });
            return;
          }
          case "/proc/kill": {
            if (typeof body.id !== "string") throw new HttpErr(400, "`id` is required");
            const sig = body.signal === "SIGKILL" || body.signal === "SIGINT" ? body.signal : "SIGTERM";
            send(res, 200, { killed: procs.kill(body.id, sig) });
            return;
          }
          default:
            throw new HttpErr(404, "not found");
        }
      } catch (e) {
        if (e instanceof HttpErr) send(res, e.status, { error: e.message });
        else send(res, 500, { error: masker.mask(e instanceof Error ? e.message : String(e)) });
      }
    })();
  });

  // GET /pty with Upgrade: websocket attaches to the terminal (?cols=&rows= for its first size).
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://sandbox");
    if (url.pathname !== "/pty" || !authorized(req, o.secret)) {
      socket.end(`HTTP/1.1 ${url.pathname !== "/pty" ? "404 Not Found" : "401 Unauthorized"}\r\nConnection: close\r\n\r\n`);
      return;
    }
    // Open only once the checkout is there, so nothing typed arrives before the shell listens.
    void ready.then(() => sockets.handleUpgrade(req, socket, head, (ws) => terminal.attach(ws, { cols: Number(url.searchParams.get("cols")), rows: Number(url.searchParams.get("rows")) })));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "0.0.0.0", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    repoDir,
    ready,
    close: () => {
      procs.killAll();
      terminal.kill();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
