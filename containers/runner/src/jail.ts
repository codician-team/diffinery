import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * The jail an agent task runs in when it runs in someone's web terminal (phase 4b; Security's design).
 *
 * The terminal's sandbox holds the person's own Claude or ChatGPT sign-in, so the agent, which content in the
 * repository can steer, runs under bubblewrap: no network of its own (a new network namespace with only
 * loopback), a new PID namespace, no capabilities, an empty $HOME except the CLI's own sign-in, and nothing of
 * the sandbox's work directory but the task's own clone. The person's checkout, its .git (with the sandbox's
 * git credential) and the runner's state are not there; the checkout's objects are, read-only, because the
 * task's clone borrows them (`git clone --shared`).
 *
 * The jail's only way out is a CONNECT proxy, outside it, that opens tunnels to the hosts in JAIL_HOSTS and
 * nothing else. It never terminates TLS and handles no tokens: the CLI signs itself in, as in the terminal.
 * Several of those hosts sit behind CDNs that serve every site they host on the same addresses, so a tunnel
 * opens only once the client's TLS ClientHello names the same host (see `clientHelloServerName`).
 * Inside, a relay on 127.0.0.1 forwards to the proxy's Unix socket and HTTPS_PROXY points at it.
 *
 * `finish` jails have no way out at all: they commit what the agent left and write a git bundle, which the
 * runner, outside, pushes with the sandbox's credential.
 *
 * Headless runs (phase 5d: tasks, plans, reviews and coordinators in a sandbox of their own) use `--egress model`.
 * They have no sign-in and reach no vendor: their CONNECT proxy opens tunnels to the package registries only, and
 * their model requests go, as plain HTTP on 127.0.0.1, to a second proxy outside the jail. That one forwards only
 * Diffinery's model endpoints (`/-/model/...`) to PUBLIC_URL over TLS, with the run's model token, which it holds
 * and the jail never sees: whatever authorization the agent sends is dropped.
 *
 *   agent.mjs --jail --root /workspace agent --dir /workspace/task-1-1 --out /workspace/task-1-1.out --cli claude-code -- claude -p ...
 *   agent.mjs --jail --root /workspace agent --dir /workspace/task-1-1 --out /workspace/task-1-1.out --egress model -- claude -p ...
 */

/** The CLI vendors' hosts a terminal task reaches with the person's sign-in (port 443). */
const CLI_HOSTS = [
  // Claude Code: the API, and its sign-in's token refresh.
  "api.anthropic.com",
  "console.anthropic.com",
  "platform.claude.com",
  // Codex on a ChatGPT plan: its backend and token refresh.
  "chatgpt.com",
  "auth.openai.com",
];

/** Package registries, download hosts where they have their own (uploads go to other hosts). */
export const REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "index.crates.io",
  "static.crates.io",
  "rubygems.org",
  "index.rubygems.org",
  "repo1.maven.org",
  "repo.maven.apache.org",
  "deb.debian.org",
  "security.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
];

/** Where a terminal task may connect, by name (port 443, or 80 for package mirrors' plain HTTP). */
export const JAIL_HOSTS = [...CLI_HOSTS, ...REGISTRY_HOSTS];

/** How a jail reaches out: `cli`, a terminal task's (its CLI's vendor and the registries); `model`, a headless run's. */
export type JailEgress = "cli" | "model";

/** Hosts the plain-HTTP side of the proxy serves (apt's default sources), for GET and HEAD only. */
const PLAIN_HTTP_HOSTS = new Set(["deb.debian.org", "security.debian.org", "archive.ubuntu.com", "security.ubuntu.com"]);

export function jailAllows(host: string, port: number, egress: JailEgress = "cli"): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return (port === 443 && (egress === "model" ? REGISTRY_HOSTS : JAIL_HOSTS).includes(h)) || (port === 80 && PLAIN_HTTP_HOSTS.has(h));
}

/** Exit code when the jail itself can't start: nothing ran. */
export const JAIL_FAILED = 125;

const RELAY_PORT = 3128;
/** Where a headless run's model requests go inside its jail: `*_BASE_URL` points here (MODEL_URL). */
const MODEL_PORT = 3129;
export const MODEL_URL = `http://127.0.0.1:${MODEL_PORT}`;

/**
 * Runs inside the jail: listens on 127.0.0.1, a port per proxy outside (`port=socket`, before the command),
 * forwarding each connection to that proxy's Unix socket, then runs the command and exits with it.
 */
const RELAY = String.raw`
import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const sep = args.indexOf("--");
const pairs = args.slice(0, sep).map((a) => [Number(a.slice(0, a.indexOf("="))), a.slice(a.indexOf("=") + 1)]);
const cmd = args.slice(sep + 1);
let listening = 0;
for (const [port, sock] of pairs) {
  const server = net.createServer((c) => {
    const u = net.connect(sock);
    c.pipe(u);
    u.pipe(c);
    // Either side hanging up closes the other, so a request the agent gave up on is cancelled outside too.
    c.on("close", () => u.destroy());
    u.on("close", () => c.destroy());
    c.on("error", () => u.destroy());
    u.on("error", () => c.destroy());
  });
  server.on("error", (e) => {
    process.stderr.write("diffinery: the jail's proxy relay failed: " + e.message + "\n");
    process.exit(${JAIL_FAILED});
  });
  server.listen(port, "127.0.0.1", () => {
    if (++listening < pairs.length) return;
    const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
    child.on("error", (e) => {
      process.stderr.write("diffinery: " + cmd[0] + ": " + e.message + "\n");
      process.exit(127);
    });
    child.on("exit", (code, signal) => process.exit(code ?? 128 + (os.constants.signals[signal] ?? 1)));
  });
}
`;

export interface JailArgs {
  mode: "agent" | "finish";
  root: string;
  dir: string;
  out: string;
  cli?: "claude-code" | "codex";
  egress: JailEgress;
  cmd: string[];
}

export function parseJailArgs(argv: string[], cwd = process.cwd()): JailArgs {
  const sep = argv.indexOf("--");
  if (sep < 0 || sep === argv.length - 1) throw new Error("usage: --jail --root <dir> agent|finish --dir <dir> --out <dir> [--cli claude-code|codex | --egress model] -- <command...>");
  const opts = argv.slice(0, sep);
  const cmd = argv.slice(sep + 1);
  const get = (name: string) => {
    const i = opts.indexOf(name);
    return i >= 0 ? opts[i + 1] : undefined;
  };
  const mode = opts.find((o) => o === "agent" || o === "finish") as JailArgs["mode"] | undefined;
  const root = get("--root");
  const dir = get("--dir");
  const out = get("--out");
  const cli = get("--cli");
  const egress = get("--egress") ?? "cli";
  if (!mode || !root || !dir || !out) throw new Error("--jail needs agent or finish, --root, --dir and --out");
  if (cli !== undefined && cli !== "claude-code" && cli !== "codex") throw new Error(`unknown --cli ${cli}`);
  if (egress !== "cli" && egress !== "model") throw new Error(`unknown --egress ${egress}`);
  // A headless run has no sign-in to bring.
  if (egress === "model" && (cli || mode !== "agent")) throw new Error("--egress model is for agent jails, without --cli");
  const abs = (p: string) => path.resolve(cwd, p);
  const a: JailArgs = { mode, root: abs(root), dir: abs(dir), out: abs(out), cli, egress, cmd };
  // The task's own directories: inside the work root, beside the person's checkout and never in it.
  const repo = path.join(a.root, "repo");
  for (const p of [a.dir, a.out]) {
    if (path.dirname(p) !== a.root || p === repo || path.basename(p).startsWith(".")) throw new Error(`${p} isn't a task directory of ${a.root}`);
  }
  if (a.dir === a.out) throw new Error("--dir and --out must differ");
  return a;
}

const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

function which(name: string, PATH: string): string | null {
  if (name.includes("/")) return existsSync(name) ? name : null;
  for (const d of PATH.split(":").filter(Boolean)) {
    const p = path.join(d, name);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

function findBwrap(): string | null {
  return which("bwrap", process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin");
}

/** The files of its home directory each CLI gets in the jail, as copies (paths relative to $HOME). */
export const CLI_FILES: Record<"claude-code" | "codex", string[]> = {
  "claude-code": [".claude/.credentials.json", ".claude.json"],
  codex: [".codex/auth.json", ".codex/config.toml"],
};

/** Variables the jail keeps from the sandbox's environment; everything else is cleared. */
const KEEP_ENV = ["LANG", "LC_ALL", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "PIP_BREAK_SYSTEM_PACKAGES", "COREPACK_ENABLE_DOWNLOAD_PROMPT", "DIFFINERY_TASK_MESSAGE", "DIFFINERY_TASK_START", "DIFFINERY_TASK_PROMPT"];

/**
 * What a headless run keeps besides (Diffinery's agentEnv): where each provider's model endpoints are, all on
 * MODEL_URL, a stand-in for each API key (the real token stays outside), and the model a route pins.
 */
export const MODEL_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_API_KEY",
  "DIFFINERY_MODEL",
];

/** The run's model token and where Diffinery is: read by the jail's model proxy, outside, never kept inside. */
export const MODEL_TOKEN_ENV = "DIFFINERY_MODEL_TOKEN";
export const MODEL_ORIGIN_ENV = "DIFFINERY_MODEL_ORIGIN";

/**
 * Directories a test pool shares with every jail, read-write (colon-separated). Only the runner's own environment
 * sets it, and only in end-to-end tests, whose commands keep their scripts and results in a temporary directory.
 */
export const SHARED_ENV = "DIFFINERY_JAIL_SHARED_FOR_TESTS";

/**
 * A test pool's shared directories, refused (so the jail doesn't start) when one is `/`, holds a hidden path (the
 * work root, the home directory, /tmp, /root), or is inside the work root (the checkout and its git credential) or
 * the home directory. Shared that way, it would undo the jail's filesystem isolation.
 */
export function sharedDirs(value: string | undefined, hidden: string[], private_: string[]): string[] {
  const dirs = (value ?? "").split(":").filter(Boolean);
  for (const d of dirs) {
    const real = path.isAbsolute(d) && existsSync(d) ? realpathSync(d) : null;
    if (!real) throw new Error(`${SHARED_ENV}: ${d} isn't an existing absolute directory`);
    const holds = hidden.some((h) => under(h, real) || under(h, d));
    const inside = private_.some((p) => under(real, p) || under(d, p) || (existsSync(p) && under(real, realpathSync(p))));
    if (real === "/" || holds || inside) throw new Error(`${SHARED_ENV}: ${d} is, holds or is inside a directory the jail hides`);
  }
  return dirs;
}

/** The bubblewrap command line for a jail (exported for tests). */
export function bwrapArgs(a: JailArgs, o: { home: string; tools: string; env: NodeJS.ProcessEnv; cliPath?: string | null; nodePath: string }): string[] {
  // The home directory (shell history, other sign-ins, other checkouts), the work root (the person's checkout and
  // the runner's state) and /tmp are empty in the jail; /root too, where it isn't the home directory. So is /run
  // (and /var/run where it isn't a link to it): it holds the Docker daemon's and BuildKit's sockets, and a socket
  // file can be reached from the jail's separate network namespace, through a read-only bind, as root.
  const varRun = existsSync("/var/run") && realpathSync("/var/run") !== "/run" ? ["/var/run"] : [];
  const hidden = [...new Set(["/tmp", "/run", ...varRun, o.home, a.root, ...(existsSync("/root") ? ["/root"] : [])])].sort((x, y) => x.length - y.length);
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const h of hidden) args.push("--tmpfs", h);
  const isHidden = (p: string) => hidden.some((h) => under(p, h));
  // A test pool's shared directories, with anything hidden inside them hidden again.
  const shared = sharedDirs(o.env[SHARED_ENV], hidden, hidden.filter((h) => h !== "/tmp"));
  for (const d of shared) args.push("--bind", d, d);
  // What the jail does see: the task's clone and its output directory, the checkout's objects read-only.
  args.push("--bind", a.dir, a.dir, "--bind", a.out, a.out, "--ro-bind", path.join(a.root, "repo", ".git", "objects"), path.join(a.root, "repo", ".git", "objects"));
  // The relay, the proxy's socket and the CLI's link: read-only (connecting to a socket needs no write).
  args.push("--ro-bind", o.tools, o.tools);
  const reveal = (p: string) => {
    if (isHidden(p)) args.push("--ro-bind", p, p);
  };
  // Node (for the relay) and the CLI, wherever they are installed.
  reveal(path.dirname(path.dirname(o.nodePath)));
  if (o.cliPath) reveal(path.dirname(o.cliPath));
  // CA bundles the sandbox trusts (the egress CA under web-only egress), wherever they are.
  for (const k of ["NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE"]) {
    const f = o.env[k];
    if (f && path.isAbsolute(f) && existsSync(f)) reveal(f);
  }
  // The CLI's own sign-in and settings, at their usual paths so it signs itself in: private copies, never
  // written back, so nothing the agent writes there (another account's credentials) reaches the terminal.
  if (a.mode === "agent" && a.cli) {
    for (const f of CLI_FILES[a.cli]) {
      const copy = path.join(o.tools, "home", f.replace(/\//g, "_"));
      if (!existsSync(copy)) continue;
      args.push("--dir", path.dirname(path.join(o.home, f)), "--bind", copy, path.join(o.home, f));
    }
  }
  const PATH = [path.join(o.tools, "bin"), ...(o.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter((d) => d && !isHidden(d))].join(":");
  args.push("--chdir", a.dir, "--clearenv", "--setenv", "PATH", PATH, "--setenv", "HOME", o.home, "--setenv", "TMPDIR", "/tmp", "--setenv", "DIFFINERY_TASK_OUT", a.out);
  for (const k of [...KEEP_ENV, ...(a.egress === "model" ? MODEL_ENV : [])]) if (o.env[k] !== undefined) args.push("--setenv", k, o.env[k]!);
  if (a.mode === "agent") {
    // Claude Code skips its permission prompts when told it's in a sandbox (it runs as root here).
    args.push("--setenv", "IS_SANDBOX", "1", "--setenv", "DISABLE_AUTOUPDATER", "1", "--setenv", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    const proxy = `http://127.0.0.1:${RELAY_PORT}`;
    for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) args.push("--setenv", k, proxy);
    // Model requests go straight to the relay's MODEL_URL, not through the CONNECT proxy.
    if (a.egress === "model") for (const k of ["NO_PROXY", "no_proxy"]) args.push("--setenv", k, "127.0.0.1,localhost");
  }
  return args;
}

const MODEL_IDLE_MS = 10 * 60_000;

/** Request headers the model proxy never forwards: hop-by-hop, the agent's own credentials and cookies, proxy headers. */
const MODEL_DROP = new Set(["host", "connection", "keep-alive", "proxy-connection", "proxy-authorization", "transfer-encoding", "te", "trailer", "upgrade", "authorization", "x-api-key", "cookie", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]);

/**
 * The model proxy outside a headless run's jail: plain HTTP on a Unix socket in, Diffinery's model endpoints out.
 * It forwards only paths under `/-/model/` (as sent: one that a URL parser would rewrite, with `..` or encoded
 * dots, is refused), to `origin`, with the run's token as its only credential.
 */
export function startModelProxy(listen: string | number, origin: string, token: string, log: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Promise<Server> {
  const base = new URL(origin);
  if ((base.protocol !== "https:" && base.protocol !== "http:") || base.username || base.password) throw new Error(`${MODEL_ORIGIN_ENV} must be an http(s) origin`);
  const server = createServer((req, res) => {
    const raw = req.url ?? "";
    let target: URL | null = null;
    try {
      target = raw.startsWith("/") && !raw.startsWith("//") ? new URL(raw, base.origin) : null;
    } catch {
      target = null;
    }
    const asSent = raw.split("?")[0]!;
    if (!target || target.origin !== base.origin || target.pathname !== asSent || !target.pathname.startsWith("/-/model/") || /%2e|%2f|%5c|\\/i.test(asSent)) {
      log(`diffinery: refused ${req.method} ${raw.slice(0, 200)} from the run (only Diffinery's model endpoints, /-/model/...)`);
      res.writeHead(403, { "content-type": "text/plain" }).end("Only Diffinery's model endpoints (/-/model/...) are reachable here.\n");
      req.resume();
      return;
    }
    const headers: IncomingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!MODEL_DROP.has(k) && v !== undefined) headers[k] = v;
    headers.authorization = `Bearer ${token}`;
    const send = base.protocol === "https:" ? httpsRequest : httpRequest;
    const up = send(target, { method: req.method, headers }, (r) => {
      const out = { ...r.headers };
      delete out["set-cookie"];
      res.writeHead(r.statusCode ?? 502, out);
      r.pipe(res);
    });
    // The agent hung up: cancel the request to Diffinery, which stops the provider's answer (and what it costs).
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    // Nor does an answer that has stalled for 10 minutes hold on (Diffinery frees its slot after 15).
    up.setTimeout(MODEL_IDLE_MS, () => up.destroy(new Error("no data for 10 minutes")));
    up.on("error", (e) => {
      if (res.destroyed) return;
      log(`diffinery: the model proxy couldn't reach ${base.host}: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }).end("Diffinery's model proxy couldn't be reached.\n");
      else res.destroy();
    });
    req.pipe(up);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen, () => resolve(server));
  });
}

const CLIENT_HELLO_TIMEOUT_MS = 10_000;
/** A ClientHello spread over more than this is refused. */
const MAX_CLIENT_HELLO_BYTES = 64 * 1024;

/**
 * The server name a TLS client's first bytes ask for (SNI): the name, lower case; `null` when they aren't a
 * ClientHello, name no single host name, or carry Encrypted Client Hello (whose real name is hidden); or
 * `undefined` while more bytes are needed. Handles a ClientHello split over several records.
 */
export function clientHelloServerName(data: Uint8Array): string | null | undefined {
  const fragments: Uint8Array[] = [];
  let have = 0;
  let pos = 0;
  for (;;) {
    if (data.length < pos + 5) return data.length > MAX_CLIENT_HELLO_BYTES ? null : undefined;
    if (data[pos] !== 0x16) return null; // not a handshake record
    const len = (data[pos + 3]! << 8) | data[pos + 4]!;
    if (len === 0 || len > 16384) return null;
    if (data.length < pos + 5 + len) return pos + 5 + len > MAX_CLIENT_HELLO_BYTES ? null : undefined;
    fragments.push(data.subarray(pos + 5, pos + 5 + len));
    have += len;
    pos += 5 + len;
    const hs = Buffer.concat(fragments, have);
    if (hs[0] !== 0x01) return null; // not a ClientHello
    if (hs.length < 4) continue;
    const size = (hs[1]! << 16) | (hs[2]! << 8) | hs[3]!;
    if (size + 4 > MAX_CLIENT_HELLO_BYTES) return null;
    if (hs.length < size + 4) continue;
    try {
      return serverNameOf(hs.subarray(4, 4 + size));
    } catch {
      return null;
    }
  }
}

function serverNameOf(b: Buffer): string | null {
  const at = (n: number) => {
    if (n >= b.length) throw new RangeError("short ClientHello");
    return b[n]!;
  };
  const u16 = (n: number) => (at(n) << 8) | at(n + 1);
  let p = 2 + 32; // version, random
  p += 1 + at(p); // session id
  p += 2 + u16(p); // cipher suites
  p += 1 + at(p); // compression methods
  if (p + 2 > b.length) return null; // no extensions, so no server name
  const end = p + 2 + u16(p);
  if (end > b.length) return null;
  p += 2;
  const names: string[] = [];
  while (p < end) {
    const type = u16(p);
    const len = u16(p + 2);
    const body = p + 4;
    if (body + len > end) return null;
    if (type === 0xfe0d) return null; // encrypted_client_hello
    if (type === 0x0000) {
      const listEnd = body + 2 + u16(body);
      if (listEnd > body + len) return null;
      for (let q = body + 2; q < listEnd; ) {
        const nameType = at(q);
        const nameLen = u16(q + 1);
        if (q + 3 + nameLen > listEnd) return null;
        if (nameType === 0) names.push(b.subarray(q + 3, q + 3 + nameLen).toString("latin1"));
        q += 3 + nameLen;
      }
    }
    p = body + len;
  }
  if (names.length !== 1 || !/^[A-Za-z0-9.-]+$/.test(names[0]!)) return null;
  return names[0]!.toLowerCase().replace(/\.$/, "");
}

/** The CONNECT proxy outside the jail: tunnels to JAIL_HOSTS by name, plain-HTTP downloads from package mirrors. */
export function startJailProxy(
  listen: string | number,
  log: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
  connectUpstream: (port: number, host: string, onConnect: () => void) => net.Socket = (port, host, onConnect) => net.connect(port, host, onConnect),
  egress: JailEgress = "cli",
): Promise<Server> {
  const hostsDoc = egress === "model" ? "/docs/agents/tasks#what-a-run-can-reach" : "/docs/agents/terminal#what-a-task-can-reach";
  const who = egress === "model" ? "an agent run" : "a terminal task";
  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = Number(url.port || 80);
    if (url.protocol !== "http:" || !jailAllows(url.hostname, port, egress) || (req.method !== "GET" && req.method !== "HEAD")) {
      log(`diffinery: refused ${req.method} ${url.protocol}//${url.host} from the task (only the hosts in ${hostsDoc})`);
      res.writeHead(403, { "content-type": "text/plain" }).end(`${url.host} isn't reachable from ${who}.\n`);
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    // The host the proxy allowed, never another one the tool names in Host.
    headers.host = url.host;
    const up = httpRequest({ host: url.hostname, port, path: `${url.pathname}${url.search}`, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    up.end();
  });
  server.on("connect", (req, socket, head) => {
    const m = /^\[?([A-Za-z0-9.:-]+?)\]?:(\d+)$/.exec(req.url ?? "");
    const host = m?.[1] ?? "";
    const port = Number(m?.[2] ?? 0);
    socket.on("error", () => socket.destroy());
    if (!m || port !== 443 || !jailAllows(host, port, egress) || net.isIP(host)) {
      log(`diffinery: refused a connection to ${req.url} from the task (only the hosts in ${hostsDoc})`);
      socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nnot reachable from ${who}\n`);
      return;
    }
    // The tunnel opens only once the client's ClientHello asks for this same host: CONNECT to an allowed
    // host behind a CDN, then TLS naming another site on that CDN, would otherwise reach that site.
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const want = host.toLowerCase().replace(/\.$/, "");
    let buf = Buffer.from(head);
    const refuse = (why: string) => {
      log(`diffinery: refused a connection to ${req.url} from the task: ${why}`);
      socket.destroy();
    };
    const timer = setTimeout(() => refuse("no TLS ClientHello"), CLIENT_HELLO_TIMEOUT_MS);
    const check = () => {
      const name = clientHelloServerName(buf);
      if (name === undefined) return;
      socket.off("data", onData);
      socket.pause();
      clearTimeout(timer);
      if (name !== want) return refuse(name === null ? "its TLS ClientHello names no single server, or hides it (Encrypted Client Hello)" : `its TLS ClientHello asks for ${name}`);
      const up = connectUpstream(port, host, () => {
        up.write(buf);
        up.pipe(socket);
        socket.pipe(up);
        socket.resume();
      });
      up.on("error", () => socket.destroy());
    };
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      check();
    };
    socket.on("data", onData);
    socket.on("close", () => clearTimeout(timer));
    if (buf.length) check();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen, () => resolve(server));
  });
}

/** `agent.mjs --jail ...`: runs the command in the jail and exits with its code (JAIL_FAILED if it couldn't). */
export async function runJail(argv: string[]): Promise<number> {
  const fail = (m: string) => {
    process.stderr.write(`diffinery: the task's jail couldn't start: ${m}\n`);
    return JAIL_FAILED;
  };
  let a: JailArgs;
  try {
    a = parseJailArgs(argv);
  } catch (e) {
    return fail((e as Error).message);
  }
  const bwrap = findBwrap();
  if (!bwrap) return fail("bubblewrap (bwrap) isn't installed in this sandbox");
  for (const p of [a.dir, a.out]) if (!existsSync(p)) return fail(`${p} doesn't exist`);
  // bwrap's own setup errors exit 1 like any command would: try the namespaces first, so a jail that can't
  // exist is never mistaken for an agent that failed.
  const probe = spawnSync(bwrap, ["--unshare-all", "--die-with-parent", "--cap-drop", "ALL", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--", "true"], { encoding: "utf8" });
  if (probe.status !== 0) return fail(`bubblewrap can't create its namespaces here: ${(probe.stderr || probe.error?.message || `exit ${probe.status}`).trim()}`);
  // A headless run's model token stays out here, with its model proxy: nothing kept in the jail may carry it.
  const token = process.env[MODEL_TOKEN_ENV] ?? "";
  const origin = process.env[MODEL_ORIGIN_ENV] ?? "";
  if (a.egress === "model") {
    if (!token || !origin) return fail(`--egress model needs ${MODEL_TOKEN_ENV} and ${MODEL_ORIGIN_ENV}`);
    if (!/^https?:\/\/[^/@]+$/.test(origin.replace(/\/$/, ""))) return fail(`${MODEL_ORIGIN_ENV} must be an http(s) origin`);
    const leak = [...KEEP_ENV, ...MODEL_ENV].find((k) => process.env[k]?.includes(token));
    if (leak) return fail(`${leak} holds the run's model token, which must stay outside the jail`);
  }
  const home = os.homedir();
  let tools: string;
  try {
    tools = mkdtempSync(path.join(a.root, ".jail-"));
  } catch (e) {
    return fail((e as Error).message);
  }
  const servers: Server[] = [];
  try {
    // The CLI, found as the terminal finds it, linked into the jail's PATH.
    const cliPath = which(a.cmd[0]!, process.env.PATH ?? "");
    const real = cliPath ? realpathSync(cliPath) : null;
    const bin = path.join(tools, "bin");
    mkdirSync(bin);
    if (real) symlinkSync(real, path.join(bin, path.basename(a.cmd[0]!)));
    mkdirSync(path.join(tools, "home"));
    if (a.mode === "agent" && a.cli) for (const f of CLI_FILES[a.cli]) if (existsSync(path.join(home, f))) copyFileSync(path.join(home, f), path.join(tools, "home", f.replace(/\//g, "_")));
    let cmd = a.cmd;
    if (a.mode === "agent") {
      const sock = path.join(tools, "proxy.sock");
      servers.push(await startJailProxy(sock, undefined, undefined, a.egress));
      const relays = [`${RELAY_PORT}=${sock}`];
      if (a.egress === "model") {
        const modelSock = path.join(tools, "model.sock");
        servers.push(await startModelProxy(modelSock, origin, token));
        relays.push(`${MODEL_PORT}=${modelSock}`);
      }
      writeFileSync(path.join(tools, "relay.mjs"), RELAY);
      cmd = [process.execPath, path.join(tools, "relay.mjs"), ...relays, "--", ...a.cmd];
    }
    const args = [...bwrapArgs(a, { home, tools, env: process.env, cliPath: real, nodePath: process.execPath }), "--", ...cmd];
    const code = await new Promise<number>((resolve) => {
      const child = spawn(bwrap, args, { stdio: "inherit" });
      const stop = (sig: NodeJS.Signals) => child.kill(sig);
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      child.on("error", (e) => resolve(fail(e.message)));
      child.on("exit", (c, sig) => resolve(c ?? 128 + (os.constants.signals[sig as NodeJS.Signals] ?? 1)));
    });
    return code;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    for (const s of servers) s.close();
    rmSync(tools, { recursive: true, force: true });
  }
}
