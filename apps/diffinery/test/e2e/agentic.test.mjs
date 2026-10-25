// End-to-end agentic features: a real `wrangler dev` Worker and the real git CLI.
//
//   pnpm --filter @diffinery/app e2e
//
// Covers the Today view (the morning view of agent work): an agent's pull
// request waiting for a person, an agent's failing pull request, approvals and
// merges moving items between sections, the REST API, the MCP tool, an agent's
// own view and the dashboard page.
import "./fresh-connections.mjs";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "diffinery-agentic-e2e-"));
let base;
let dev;
let devLog = "";
let token;

async function api(method, path, body, tok = token) {
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
async function ok(method, path, body, tok) {
  const r = await api(method, path, body, tok);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(500);
  }
  assert.fail(`timed out waiting for ${what}\n--- wrangler log tail ---\n${devLog.slice(-4000)}`);
}

function git(cwd, args, tok = token) {
  const auth = Buffer.from(`x-token:${tok}`).toString("base64");
  return execFileSync("git", ["-c", `http.extraHeader=Authorization: Basic ${auth}`, "-c", "protocol.version=2", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "E2E", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "E2E", GIT_COMMITTER_EMAIL: "e2e@example.com" },
  });
}

async function mcp(name, args, tok = token) {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const { result } = await r.json();
  assert.equal(result.isError, false, result.content[0].text);
  return result.structuredContent;
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const persist = join(work, "state");
  migratedState(APP, persist);
  dev = spawn("pnpm", ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${base}`, "--var", `MASTER_KEY:${randomBytes(32).toString("base64")}`, "--show-interactive-dev-session=false"], {
    cwd: APP,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  dev.stdout.on("data", (d) => (devLog += d));
  dev.stderr.on("data", (d) => (devLog += d));
  await until("wrangler dev", async () => {
    try {
      return (await fetch(`${base}/healthz`)).ok;
    } catch {
      return false;
    }
  }, 120_000);
  const res = await fetch(`${base}/api/v3/diffinery/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "e2e", scopes: ["admin"] }) });
  assert.equal(res.status, 201, await res.clone().text());
  token = (await res.json()).token;
});

after(() => {
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  }
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
});

test("Today: what needs you, your agents' work and what landed", async () => {
  const me = await ok("GET", "/user");
  const owner = me.login;
  const empty = await ok("GET", "/diffinery/today");
  assert.deepEqual([empty.needs_you, empty.agents_at_work, empty.landed], [[], [], []]);

  await ok("POST", "/user/repos", { name: "today-demo" });
  const src = join(work, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "README.md"), "# today\n");
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "initial"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/today-demo.git`]);
  git(src, ["push", "-q", "origin", "main"]);

  // An agent the dev user owns opens two pull requests; one of them fails its checks.
  const bot = (await ok("POST", "/diffinery/agents", { login: "today-bot", name: "Today Bot" }, null)).token.token;
  for (const [branch, file] of [
    ["fix-link", "link.txt"],
    ["add-test", "test.txt"],
  ]) {
    git(src, ["checkout", "-q", "-b", branch, "main"]);
    writeFileSync(join(src, file), `${branch}\n`);
    git(src, ["add", "-A"]);
    git(src, ["commit", "-q", "-m", branch]);
    git(src, ["push", "-q", "origin", branch], bot);
  }
  const fix = await ok("POST", `/repos/${owner}/today-demo/pulls`, { title: "Fix the Contact sales link", head: "fix-link", base: "main", intent: "Point the link at /contact" }, bot);
  const add = await ok("POST", `/repos/${owner}/today-demo/pulls`, { title: "Add a test", head: "add-test", base: "main" }, bot);
  await ok("POST", `/repos/${owner}/today-demo/statuses/${add.head.sha}`, { state: "failure", context: "ci/test", description: "1 failing" }, bot);

  let t = await ok("GET", "/diffinery/today");
  assert.ok(t.repositories >= 1);
  assert.equal(t.incomplete_results, false);
  const waiting = t.needs_you.find((x) => x.number === fix.number);
  assert.ok(waiting, JSON.stringify(t.needs_you));
  assert.equal(waiting.reason, "agent_approval");
  assert.equal(waiting.repository, `${owner}/today-demo`);
  assert.equal(waiting.user.login, "today-bot");
  assert.equal(waiting.user.type, "Bot");
  assert.equal(waiting.intent, "Point the link at /contact");
  assert.equal(waiting.html_url, `${base}/${owner}/today-demo/pull/${fix.number}`);
  assert.ok(!t.needs_you.some((x) => x.number === add.number), "a failing agent pull request waits on the agent, not on a person");
  const states = Object.fromEntries(t.agents_at_work.map((x) => [x.number, x]));
  assert.equal(states[fix.number].state, "waiting_for_approval");
  assert.equal(states[add.number].state, "checks_failing");
  assert.deepEqual(states[add.number].failing_checks, ["ci/test"]);

  // The agent's own view: its pull requests, and no approvals to give.
  const botView = await ok("GET", "/diffinery/today", undefined, bot);
  assert.deepEqual(botView.agents_at_work.map((x) => x.number).sort(), [fix.number, add.number].sort());
  assert.ok(!botView.needs_you.some((x) => x.reason === "agent_approval"));

  // The MCP tool returns the same view.
  const viaMcp = await mcp("today", {});
  assert.deepEqual(viaMcp.needs_you.map((x) => x.number), t.needs_you.map((x) => x.number));

  // The dashboard shows it.
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /<h1[^>]*>Today<\/h1>/);
  assert.match(page, /Needs you/);
  assert.match(page, /Agent PR needs a person&#39;s approval|Agent PR needs a person's approval/);
  assert.match(page, /Fix the Contact sales link/);
  assert.match(page, /Checks failing/);
  // Each section folds away from its header, and the page renders the ones the viewer folded as folded.
  assert.match(page, /<details[^>]*id="needs-you"[^>]*open/);
  const folded = await (await fetch(`${base}/`, { headers: { cookie: "today_collapsed=needs-you.landed" } })).text();
  assert.match(folded, /<details(?![^>]*open)[^>]*id="needs-you"/);
  assert.match(folded, /<details(?![^>]*open)[^>]*id="landed"/);
  assert.match(folded, /<details[^>]*id="agents"[^>]*open/);

  // A person approves: it leaves "needs you" and shows as approved, then merges into "since yesterday".
  await ok("POST", `/repos/${owner}/today-demo/pulls/${fix.number}/reviews`, { event: "APPROVE", body: "LGTM" });
  t = await ok("GET", "/diffinery/today");
  assert.ok(!t.needs_you.some((x) => x.number === fix.number));
  assert.equal(t.agents_at_work.find((x) => x.number === fix.number).state, "approved");
  assert.deepEqual(t.agents_at_work.find((x) => x.number === fix.number).approved_by, [owner]);
  await ok("PUT", `/repos/${owner}/today-demo/pulls/${fix.number}/merge`, { merge_method: "squash" });
  t = await ok("GET", "/diffinery/today");
  assert.ok(!t.agents_at_work.some((x) => x.number === fix.number));
  const landed = t.landed.find((x) => x.number === fix.number);
  assert.ok(landed, JSON.stringify(t.landed));
  assert.equal(landed.merged_by, owner);
  assert.equal(landed.user.login, "today-bot");

  // Once its checks pass, the agent's other pull request waits for a person too.
  await ok("POST", `/repos/${owner}/today-demo/statuses/${add.head.sha}`, { state: "success", context: "ci/test" }, bot);
  t = await ok("GET", "/diffinery/today");
  assert.equal(t.needs_you.find((x) => x.number === add.number)?.reason, "agent_approval");

  // An agent pull request that conflicts with its base waits for its agent, not a person: Today checks it
  // after answering, and the next Today leaves it out of "needs you".
  git(src, ["checkout", "-q", "-b", "readme", "main"]);
  writeFileSync(join(src, "README.md"), "# today, by the agent\n");
  git(src, ["commit", "-q", "-am", "agent readme"]);
  git(src, ["push", "-q", "origin", "readme"], bot);
  const clash = await ok("POST", `/repos/${owner}/today-demo/pulls`, { title: "Reword the README", head: "readme", base: "main" }, bot);
  git(src, ["checkout", "-q", "main"]);
  git(src, ["pull", "-q", "--no-rebase", "origin", "main"]);
  writeFileSync(join(src, "README.md"), "# today, by a person\n");
  git(src, ["commit", "-q", "-am", "person readme"]);
  git(src, ["push", "-q", "origin", "main"]);
  t = await ok("GET", "/diffinery/today");
  for (let i = 0; i < 20 && t.agents_at_work.find((x) => x.number === clash.number)?.state !== "conflicting"; i++) {
    await new Promise((r) => setTimeout(r, 250));
    t = await ok("GET", "/diffinery/today");
  }
  const clashing = t.agents_at_work.find((x) => x.number === clash.number);
  assert.equal(clashing?.state, "conflicting", JSON.stringify(clashing));
  assert.equal(clashing.merge_state, "conflicting");
  assert.ok(!t.needs_you.some((x) => x.number === clash.number), "a conflicting agent pull request waits on the agent");
  assert.equal(t.needs_you.find((x) => x.number === add.number)?.reason, "agent_approval", "a clean one still waits for a person");

  // A token limited to other repositories sees none of it.
  await ok("POST", "/user/repos", { name: "elsewhere" });
  const other = await ok("GET", `/repos/${owner}/elsewhere`);
  const limited = await fetch(`${base}/api/v3/diffinery/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "limited", scopes: ["read"], repositories: [other.full_name] }) });
  assert.equal(limited.status, 201, await limited.clone().text());
  const view = await ok("GET", "/diffinery/today", undefined, (await limited.json()).token);
  assert.deepEqual([view.needs_you, view.landed], [[], []]);
});
