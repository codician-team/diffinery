// Shared setup for the agent e2e files (tasks.test.mjs, terminals.test.mjs): a real `wrangler dev`
// Worker, sandboxes in an `agent.mjs --sandbox-pool` process, a fake model provider, and helpers.
// Importing it registers the before/after hooks that start and stop them.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as httpServer } from "node:http";
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

export const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const AGENT = resolve(APP, "../../containers/runner/dist/agent.mjs");
// The test's files (scripts, fake CLIs, what commands write) are in `work`, which jails share; the pool's work root
// and home are beside it, since a jail refuses to share a directory that holds what it hides.
const top = mkdtempSync(join(tmpdir(), "diffinery-tasks-e2e-"));
export const work = join(top, "work");
mkdirSync(work);
export const poolRoot = join(top, "pool");
export const poolHome = join(top, "home");
// The terminal test speaks WebSocket with headers (Origin, cookies), which Node's built-in client can't set.
export const { WebSocket: WS } = createRequire(resolve(APP, "../../containers/runner/package.json"))("ws");
export const RIVAL_SESSION = `rival-${randomBytes(12).toString("hex")}`;
export const ANTHROPIC_KEY = `sk-ant-api03-${randomBytes(30).toString("hex")}`;
export const OPENROUTER_KEY = `sk-or-v1-${randomBytes(32).toString("hex")}`;
export let base;
export let dev;
export let pool;
export let upstream;
export let devLog = "";
export let poolLog = "";
export let token;
export const modelRequests = [];

export async function api(method, path, body, tok = token) {
  const res = await fetch(`${base}/api/v3${path}`, {
    method,
    headers: { ...(tok === null ? {} : { authorization: `Bearer ${tok}` }), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
export async function ok(method, path, body, tok) {
  const r = await api(method, path, body, tok);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
/** As the signed-in person in a browser (the dev sign-in: no credentials). */
export const asPerson = (method, path, body) => api(method, path, body, null);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(what, fn, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(500);
  }
  assert.fail(`timed out waiting for ${what}\n--- wrangler log tail ---\n${devLog.slice(-4000)}\n--- pool log tail ---\n${poolLog.slice(-3000)}`);
}

export function git(cwd, args, tok = token) {
  const auth = Buffer.from(`x-token:${tok}`).toString("base64");
  return execFileSync("git", ["-c", `http.extraHeader=Authorization: Basic ${auth}`, "-c", "protocol.version=2", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "E2E", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "E2E", GIT_COMMITTER_EMAIL: "e2e@example.com" },
  });
}

export async function mcp(name, args, tok = token) {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const { result } = await r.json();
  return result;
}

/**
 * A headless run's model token (phase 5d). The agent in its jail has only a stand-in, so the test reads the token
 * where only the runner has it: the environment of the jail's own process outside, found by a path in its command.
 * `file` is one the run's command writes $ANTHROPIC_API_KEY to, once it has started.
 */
export async function jailToken(file) {
  await until(`the agent to write ${file}`, async () => existsSync(file));
  assert.equal(readFileSync(file, "utf8"), "diffinery-jail", "the agent holds a stand-in, never the run's token");
  return until(`the jail of the run writing ${file}`, async () => {
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        if (!argv.includes("--jail") || !argv.some((a) => a.includes(file))) continue;
        const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        const tok = env.find((e) => e.startsWith("DIFFINERY_MODEL_TOKEN="));
        if (tok) return tok.slice("DIFFINERY_MODEL_TOKEN=".length);
      } catch {
        // gone, or not ours
      }
    }
    return null;
  });
}

/** The sandboxes the pool has started, newest first. */
export const poolSandboxes = () =>
  existsSync(poolRoot)
    ? readdirSync(poolRoot)
        .map((id) => ({ id, at: statSync(join(poolRoot, id)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
        .map((x) => x.id)
    : [];

before(async () => {
  if (!existsSync(AGENT)) execFileSync("pnpm", ["--filter", "@diffinery/runner", "build"], { cwd: APP, stdio: "pipe" });
  // A stand-in for the provider: records what reaches it and answers like the Messages API.
  upstream = httpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      modelRequests.push({ method: req.method, url: req.url, headers: req.headers, body });
      // A request that asks for it is answered after a while, so several can be on their way at once.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream=1" });
        res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "fake model says hi" }], usage: { input_tokens: 21, output_tokens: 4, cache_read_input_tokens: 300 } }));
      }, body.includes('"slow"') ? 3000 : 0);
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  // A stand-in for a Claude Code someone signed in to in their terminal (phase 4b): it reports what it was given and
  // where it ran, and changes a file, without any model.
  const fakeBin = join(work, "bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "claude"),
    [
      "#!/bin/sh",
      'd=$(basename "$PWD")',
      'echo "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"signed-in claude: key=${ANTHROPIC_API_KEY:-none} base=${ANTHROPIC_BASE_URL:-none} dir=$d\\"}]}}"',
      'printf "%s\\n" "$DIFFINERY_TASK_PROMPT"',
      'printf "args: %s\\n" "$*"',
      // What its jail lets it see and reach (containers/runner/src/jail.ts).
      'printf "jail: proxy=%s\\n" "$HTTPS_PROXY"',
      'printf "jail: signin=%s\\n" "$(cat "$HOME/.claude/.credentials.json" 2>/dev/null || echo none)"',
      // Writing another account's credentials over the sign-in changes only the jail's copy.
      'echo \'{"attacker":"signin"}\' > "$HOME/.claude/.credentials.json"',
      'printf "jail: history=%s\\n" "$(cat "$HOME/.bash_history" 2>/dev/null || echo hidden)"',
      'printf "jail: credential=%s\\n" "$(cat ../repo/.git/config 2>/dev/null || echo hidden)"',
      'printf "jail: direct=%s\\n" "$(node -e "require(\\"net\\").connect(80, \\"1.1.1.1\\").on(\\"connect\\", () => (console.log(\\"open\\"), process.exit())).on(\\"error\\", (e) => (console.log(e.code), process.exit()))")"',
      // A repository can set config that runs commands; in the task's clone it only ever runs in a jail.
      "git config core.fsmonitor 'touch ../pwned-fsmonitor; false'",
      'echo "made in the terminal" > terminal.txt',
      // What it reports about its own usage: a subscription's requests never pass Diffinery (phase 5a).
      'echo \'{"type":"result","subtype":"success","result":"Done in the terminal.","total_cost_usd":0.0312,"usage":{"input_tokens":40,"output_tokens":7,"cache_read_input_tokens":1200,"cache_creation_input_tokens":90}}\'',
    ].join("\n"),
    { mode: 0o755 },
  );
  // The pool's home is the terminal's: a provider sign-in, and shell history that a task's jail must not show.
  mkdirSync(join(poolHome, ".claude"), { recursive: true });
  writeFileSync(join(poolHome, ".claude", ".credentials.json"), '{"fake":"signin"}');
  writeFileSync(join(poolHome, ".bash_history"), "HISTORY-SECRET\n");
  const poolPort = await freePort();
  const poolSecret = randomBytes(16).toString("hex");
  // Commands share the test's directory with their jails: their scripts are there, and what they write for the test to read.
  pool = spawn("node", [AGENT, "--sandbox-pool", "--work-root", poolRoot], { env: { ...process.env, HOME: poolHome, PATH: `${fakeBin}:${process.env.PATH}`, DIFFINERY_SANDBOX_POOL_SECRET: poolSecret, DIFFINERY_SANDBOX_PORT: String(poolPort), DIFFINERY_JAIL_SHARED_FOR_TESTS: work }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  pool.stdout.on("data", (d) => (poolLog += d));
  pool.stderr.on("data", (d) => (poolLog += d));
  await until("sandbox pool", async () => poolLog.includes("listening"), 30_000);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const persist = join(work, "state");
  migratedState(APP, persist);
  // A second person, signed in with a session: not the terminal's opener, whatever their role.
  {
    const at = new Date().toISOString();
    const later = new Date(Date.now() + 30 * 86400_000).toISOString();
    const hash = createHash("sha256").update(RIVAL_SESSION).digest("hex");
    execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--command", `INSERT INTO accounts (id, login, kind, name, status, created_at) VALUES ('u-rival', 'rival', 'user', 'Rival', 'active', '${at}'); INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash}', 'u-rival', 'passkey', '${at}', '${at}', '${later}')`], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });
  }
  const vars = { PUBLIC_URL: base, MASTER_KEY: randomBytes(32).toString("base64"), SANDBOX_POOL_URL: `http://127.0.0.1:${poolPort}`, SANDBOX_POOL_SECRET: poolSecret, MODEL_UPSTREAM_ANTHROPIC: upstreamUrl, MODEL_UPSTREAM_OPENAI: upstreamUrl, MODEL_UPSTREAM_OPENROUTER: upstreamUrl, AGENT_POLL_MS: "500", TERMINAL_POLL_MS: "3000" };
  dev = spawn("pnpm", ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]), "--show-interactive-dev-session=false"], {
    cwd: APP,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  dev.stdout.on("data", (d) => (devLog += d));
  dev.stderr.on("data", (d) => (devLog += d));
  await until(
    "wrangler dev",
    async () => {
      try {
        return (await fetch(`${base}/healthz`)).ok;
      } catch {
        return false;
      }
    },
    120_000,
  );
  const res = await fetch(`${base}/api/v3/diffinery/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "e2e", scopes: ["admin"] }) });
  assert.equal(res.status, 201, await res.clone().text());
  token = (await res.json()).token;
});

after(() => {
  for (const p of [dev, pool]) {
    if (p?.pid) {
      try {
        process.kill(-p.pid, "SIGTERM");
      } catch {}
    }
  }
  upstream?.close();
  if (process.env.E2E_KEEP !== "1") rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
