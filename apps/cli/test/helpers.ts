import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { Io } from "../src/io.js";
import { main } from "../src/main.js";

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Handler = (req: Recorded) => Reply | Promise<Reply>;

export interface FakeServer {
  url: string;
  host: string;
  requests: Recorded[];
  on(method: string, path: string | RegExp, h: Handler | Reply): void;
  find(method: string, path: string | RegExp): Recorded[];
  close(): Promise<void>;
}

/**
 * A tiny programmable HTTP server: unmatched routes return 404 { message }.
 * With `gitRoot`, paths containing `.git/` are served by `git http-backend` from that directory.
 */
export async function fakeServer(o: { gitRoot?: string; gitAuth?: string } = {}): Promise<FakeServer> {
  const routes: Array<{ method: string; path: string | RegExp; h: Handler }> = [];
  const requests: Recorded[] = [];
  const matches = (p: string | RegExp, path: string) => (typeof p === "string" ? p === path : p.test(path));
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (o.gitRoot && /\.git\//.test(req.url ?? "")) return gitBackend(o.gitRoot, o.gitAuth, req, res, requests);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown = text || undefined;
    try {
      if (text) body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    const u = new URL(req.url ?? "/", "http://x");
    const rec: Recorded = { method: req.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body };
    requests.push(rec);
    const route = [...routes].reverse().find((r) => r.method === rec.method && matches(r.path, rec.path));
    const reply: Reply = route ? await route.h(rec) : { status: 404, body: { message: "not found" } };
    const status = reply.status ?? 200;
    const headers: Record<string, string> = { ...reply.headers };
    let out = "";
    if (reply.body !== undefined && status !== 204) {
      if (typeof reply.body === "string") {
        out = reply.body;
        headers["content-type"] ??= "text/plain";
      } else {
        out = JSON.stringify(reply.body);
        headers["content-type"] ??= "application/json";
      }
    }
    res.writeHead(status, headers);
    res.end(out);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    requests,
    on(method, path, h) {
      routes.push({ method, path, h: typeof h === "function" ? h : () => h });
    },
    find(method, path) {
      return requests.filter((r) => r.method === method && matches(path, r.path));
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function tempDir(prefix = "diffinery-cli-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdin?: string;
  stdinTTY?: boolean;
  /** Makes stdout look like a terminal (set NO_COLOR in env to keep the output plain). */
  stdoutTTY?: boolean;
  /** Stands in for the browser when the CLI opens one. */
  openUrl?: (url: string) => Promise<boolean>;
  selfPath?: string;
}

/** An isolated environment: HOME/XDG in a temp dir, git with no global config. */
export function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = tempDir("diffinery-home-");
  const gitconfig = path.join(home, ".gitconfig");
  writeFileSync(gitconfig, "");
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    // This machine's Claude Code stays out of it; the tests that want it turn it back on.
    DIFFINERY_NO_CLAUDE_PLUGINS: "1",
    ...extra,
  };
}

export async function run(argv: string[], o: RunOptions = {}): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const stdin = Readable.from(o.stdin !== undefined ? [Buffer.from(o.stdin)] : []) as Io["stdin"];
  stdin.isTTY = o.stdinTTY ?? false;
  const io: Io = {
    env: o.env ?? isolatedEnv(),
    cwd: o.cwd ?? tempDir(),
    stdin,
    stdout: { write: (s: string) => ((stdout += s), true), isTTY: o.stdoutTTY },
    stderr: { write: (s: string) => ((stderr += s), true) },
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    openUrl: o.openUrl,
    selfPath: o.selfPath,
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
}

/** Creates a git repository whose origin points at `remote`, on branch `branch`. */
export function gitRepo(env: NodeJS.ProcessEnv, remote: string, branch = "feature/x"): string {
  const dir = tempDir("diffinery-repo-");
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("remote", "add", "origin", remote);
  g("commit", "-q", "--allow-empty", "-m", "init");
  g("checkout", "-q", "-b", branch);
  return dir;
}

/** Serves git smart HTTP via `git http-backend` (CGI), requiring `auth` as the Authorization header when set. */
async function gitBackend(root: string, auth: string | undefined, req: IncomingMessage, res: ServerResponse, requests: Recorded[]): Promise<void> {
  const u = new URL(req.url ?? "/", "http://x");
  requests.push({ method: req.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body: undefined });
  if (auth && req.headers.authorization !== auth) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="test"' });
    return void res.end();
  }
  const child = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      REQUEST_METHOD: req.method ?? "GET",
      PATH_INFO: decodeURIComponent(u.pathname),
      QUERY_STRING: u.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
      GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
      REMOTE_USER: "tester",
      REMOTE_ADDR: "127.0.0.1",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  req.pipe(child.stdin);
  const chunks: Buffer[] = [];
  for await (const c of child.stdout) chunks.push(c as Buffer);
  const out = Buffer.concat(chunks);
  const sep = out.indexOf("\r\n\r\n");
  const head = out.subarray(0, sep).toString();
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of head.split("\r\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]);
    else headers[k] = v;
  }
  res.writeHead(status, headers);
  res.end(out.subarray(sep + 4));
}
