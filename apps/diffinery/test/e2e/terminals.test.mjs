// End-to-end web terminals, kill switches on them, and tasks run in them (phase 4b), on the same setup as tasks.test.mjs
// (agents-harness.mjs). In a file of their own so each file stays well under the test runner's per-file limit.
//
//   pnpm --filter @diffinery/app e2e
import "./fresh-connections.mjs";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as netServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP,
  AGENT,
  work,
  poolRoot,
  poolHome,
  WS,
  RIVAL_SESSION,
  ANTHROPIC_KEY,
  OPENROUTER_KEY,
  base,
  dev,
  pool,
  upstream,
  devLog,
  poolLog,
  token,
  modelRequests,
  api,
  ok,
  asPerson,
  sleep,
  until,
  git,
  mcp,
  poolSandboxes,
} from "./agents-harness.mjs";
import { freePort } from "./ports.mjs";

/** Opens a terminal's WebSocket; resolves with the HTTP status when the upgrade is refused. */
function termSocket(url, headers) {
  return new Promise((resolve) => {
    const ws = new WS(url, { headers });
    let out = "";
    ws.on("message", (d, binary) => {
      if (binary) out += String(d);
    });
    let closedWith = null;
    const closed = new Promise((r) => ws.on("close", (code, reason) => r((closedWith = { code, reason: String(reason) }))));
    ws.once("unexpected-response", (_req, res) => resolve({ status: res.statusCode }));
    ws.once("error", (e) => resolve({ status: 0, error: e.message }));
    ws.once("open", () =>
      resolve({
        status: 101,
        ws,
        closed,
        out: () => out,
        type: (text) => ws.send(Buffer.from(text)),
        until: (re, ms = 30_000) => until(`${re} in the terminal (got ${JSON.stringify(out.slice(-300))}, closed ${JSON.stringify(closedWith)})`, async () => re.test(out), ms),
      }),
    );
  });
}

test("a web terminal: only its opener attaches, the sandbox API can't reach it, and End takes it away", async () => {
  const me = await ok("GET", "/user");
  const owner = me.login;
  await ok("POST", "/user/repos", { name: "term-demo" });
  await ok("PUT", `/repos/${owner}/term-demo/contents/README.md`, { message: "init", content: Buffer.from("# term\n").toString("base64") });
  assert.equal((await asPerson("POST", "/diffinery/agents", { login: "term-bot", name: "Term Bot" })).status, 201);
  const page = (path) => fetch(`${base}/${owner}/term-demo/${path}`).then(async (r) => ({ status: r.status, text: await r.text(), headers: r.headers }));
  async function form(path, fields, headers = {}) {
    const res = await fetch(`${base}/${owner}/term-demo/terminals`, { headers });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await res.text())?.[1];
    const cookie = /dfy_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    return fetch(`${base}/${owner}/term-demo/${path}`, { method: "POST", redirect: "manual", headers: { ...headers, cookie: [headers.cookie, `dfy_csrf=${cookie}`].filter(Boolean).join("; "), "sec-fetch-site": "same-origin" }, body: new URLSearchParams({ _csrf: csrf ?? "", ...fields }) });
  }

  // The notice comes first, and it is a Kumo checkbox, not a native one.
  const list = await page("terminals");
  assert.equal(list.status, 200);
  assert.match(list.text, /Open a terminal/);
  assert.match(list.text, /my own Anthropic or OpenAI account/);
  assert.ok(!/<input[^>]+type="checkbox"/.test(list.text.replace(/<input[^>]+data-k[^>]*>/g, "")), "no native checkbox");
  const refused = await form("terminals", { agent: "term-bot", ref: "main" });
  assert.equal(refused.status, 422);
  assert.match(await refused.text(), /accept the notice first/);
  const opened = await form("terminals", { agent: "term-bot", ref: "main", accept: "1" });
  assert.equal(opened.status, 303, await opened.text());
  const path = new URL(opened.headers.get("location"), base).pathname;
  const id = path.split("/").pop();
  const running = await until("the terminal to start", async () => {
    const p = await page(`terminals/${id}`);
    return p.text.includes("data-socket") ? p : null;
  });
  assert.match(running.text, /Start Claude Code/);
  assert.match(running.text, /Start Codex/, "a private repository offers Codex");
  assert.match(running.text, /\/-\/terminal\/[a-z0-9]+\.js/);
  const sandboxId = poolSandboxes()[0];

  // The socket: this site's Origin, a browser session, and only the opener.
  const url = `${base.replace("http", "ws")}/${owner}/term-demo/terminals/${id}/socket?cols=100&rows=30`;
  const origin = new URL(base).origin;
  assert.equal((await termSocket(url, {})).status, 403, "no Origin");
  assert.equal((await termSocket(url, { origin: "https://evil.example" })).status, 403, "another Origin");
  assert.equal((await termSocket(url, { origin, authorization: `Bearer ${token}` })).status, 403, "a token, even the opener's own admin token");
  assert.equal((await termSocket(url, { origin, cookie: `__Host-dfy_session=${RIVAL_SESSION}` })).status, 404, "another person");
  const t = await termSocket(url, { origin });
  assert.equal(t.status, 101, JSON.stringify(t));
  t.type("stty size; echo \"s=[$DIFFINERY_SANDBOX_SECRET] t=[$DIFFINERY_JOB_TOKEN]\"; git rev-parse --abbrev-ref HEAD; echo hi-$((6*7))\n");
  await t.until(/hi-42/);
  assert.match(t.out(), /30 100/);
  assert.match(t.out(), /s=\[\] t=\[\]/);
  assert.match(t.out(), /\bmain\b/);

  // Another person, even one the owner made an admin of the repository, sees nothing of it.
  const invite = await ok("PUT", `/repos/${owner}/term-demo/collaborators/rival`, { permission: "admin" });
  if (invite?.id) await fetch(`${base}/api/v3/user/repository_invitations/${invite.id}`, { method: "PATCH", headers: { cookie: `__Host-dfy_session=${RIVAL_SESSION}`, "sec-fetch-site": "same-origin" } });
  const rival = { cookie: `__Host-dfy_session=${RIVAL_SESSION}` };
  assert.equal((await fetch(`${base}/${owner}/term-demo/terminals/${id}`, { headers: rival })).status, 404);
  assert.ok(!(await (await fetch(`${base}/${owner}/term-demo/terminals`, { headers: rival })).text()).includes(id));
  assert.equal((await form(`terminals/${id}/end`, {}, rival)).status, 404);
  assert.equal((await termSocket(url, { origin, ...rival })).status, 404);

  // The sandbox API and MCP never reach a terminal's sandbox, not even for a site admin's admin token.
  assert.equal((await api("POST", `/repos/${owner}/term-demo/diffinery/sandboxes/${sandboxId}/exec`, { cmd: "cat ~/.claude/.credentials.json" })).status, 404);
  assert.equal((await api("POST", `/repos/${owner}/term-demo/diffinery/sandboxes/${sandboxId}/read`, { path: "/root/.codex/auth.json" })).status, 404);
  assert.equal((await api("POST", `/repos/${owner}/term-demo/diffinery/sandboxes/${sandboxId}/close`)).status, 404);
  const viaMcp = await mcp("sandbox_exec", { owner, repo: "term-demo", sandbox_id: sandboxId, command: "id" });
  assert.ok(viaMcp?.isError, JSON.stringify(viaMcp));

  // Limits: two open per repository.
  const second = await form("terminals", { agent: "term-bot", ref: "main" });
  assert.equal(second.status, 303);
  const third = await form("terminals", { agent: "term-bot", ref: "main" });
  assert.equal(third.status, 422);
  assert.match(await third.text(), /2 terminals open in this repository/);
  const secondId = new URL(second.headers.get("location"), base).pathname.split("/").pop();

  // End: the socket closes, the sandbox and its git credential go, and it can't be attached again.
  assert.equal((await form(`terminals/${id}/end`, {})).status, 303);
  const closed = await t.closed;
  assert.ok([1000, 1006, 1011].includes(closed.code), JSON.stringify(closed));
  assert.equal((await termSocket(url, { origin })).status, 409);
  assert.match((await page(`terminals/${id}`)).text, /You ended it/);
  await until("the pool to stop the sandbox", async () => !poolSandboxes().includes(sandboxId) || (await fetch(`${base}/${owner}/term-demo/terminals/${id}`)).ok);

  // Losing access ends a terminal too: the agent's write access goes, and the next check ends it.
  await until("the second terminal to start", async () => (await page(`terminals/${secondId}`)).text.includes("data-socket"));
  assert.equal((await api("DELETE", "/diffinery/agents/term-bot")).status, 204);
  await until("the second terminal to end", async () => /no longer have write access|ended/i.test((await page(`terminals/${secondId}`)).text) && !(await page(`terminals/${secondId}`)).text.includes("data-socket"), 150_000);
});

test("a kill switch ends web terminals and refuses new ones until it's lifted", async () => {
  const owner = (await ok("GET", "/user")).login;
  assert.equal((await asPerson("POST", "/diffinery/agents", { login: "term-bot-2", name: "Term Bot 2" })).status, 201);
  const page = (path) => fetch(`${base}/${owner}/term-demo/${path}`).then(async (r) => ({ status: r.status, text: await r.text() }));
  async function form(path, fields) {
    const res = await fetch(`${base}/${owner}/term-demo/terminals`);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await res.text())?.[1];
    const cookie = /dfy_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    return fetch(`${base}/${owner}/term-demo/${path}`, { method: "POST", redirect: "manual", headers: { cookie: `dfy_csrf=${cookie}`, "sec-fetch-site": "same-origin" }, body: new URLSearchParams({ _csrf: csrf ?? "", ...fields }) });
  }
  const opened = await form("terminals", { agent: "term-bot-2", ref: "main" });
  assert.equal(opened.status, 303, await opened.text());
  const id = new URL(opened.headers.get("location"), base).pathname.split("/").pop();
  await until("the terminal to start", async () => (await page(`terminals/${id}`)).text.includes("data-socket"));
  const url = `${base.replace("http", "ws")}/${owner}/term-demo/terminals/${id}/socket`;
  const origin = new URL(base).origin;

  // Suspending the repository's Actions ends the terminal, refuses attaching and opening another.
  const S = `/admin/repos/${owner}/term-demo/actions-suspension`;
  assert.equal((await api("PUT", S, { reason: "abuse report" })).status, 200);
  // Nor does it start a task in the terminal (phase 4b).
  const before = (await ok("GET", `/repos/${owner}/term-demo/diffinery/tasks`)).length;
  assert.equal((await form(`terminals/${id}/task`, { goal: "Do it while suspended", runtime: "claude-code" })).status, 303);
  assert.equal((await ok("GET", `/repos/${owner}/term-demo/diffinery/tasks`)).length, before, "a suspended repository's terminal starts no task");
  const refused = await termSocket(url, { origin });
  assert.ok([403, 409].includes(refused.status), JSON.stringify(refused));
  const again = await form("terminals", { agent: "term-bot-2", ref: "main" });
  assert.equal(again.status, 422);
  assert.match(await again.text(), /Actions are suspended for this repository by a site administrator: abuse report/);
  await until("the terminal to end", async () => /suspended Actions and sandboxes here|Its sandbox stopped/.test((await page(`terminals/${id}`)).text), 150_000);

  // Lifted, a terminal opens again.
  assert.equal((await api("DELETE", S)).status, 200);
  const after = await form("terminals", { agent: "term-bot-2", ref: "main" });
  assert.equal(after.status, 303, await after.text());
  assert.equal((await form(`${new URL(after.headers.get("location"), base).pathname.split("/").slice(3).join("/")}/end`, {})).status, 303);
});

test("a task in my terminal: only on my click, with the CLI signed in there, in a checkout of its own", async () => {
  const owner = (await ok("GET", "/user")).login;
  await ok("POST", "/user/repos", { name: "term-tasks" });
  await ok("PUT", `/repos/${owner}/term-tasks/contents/README.md`, { message: "init", content: Buffer.from("# term tasks\n").toString("base64") });
  assert.equal((await asPerson("POST", "/diffinery/agents", { login: "term-hand", name: "Term Hand" })).status, 201);
  const R = `/repos/${owner}/term-tasks/diffinery/tasks`;
  const page = (path, headers = {}) => fetch(`${base}/${owner}/term-tasks/${path}`, { headers }).then(async (r) => ({ status: r.status, text: await r.text() }));
  async function form(path, fields, headers = {}) {
    const res = await fetch(`${base}/${owner}/term-tasks/terminals`, { headers });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await res.text())?.[1];
    const cookie = /dfy_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    return fetch(`${base}/${owner}/term-tasks/${path}`, { method: "POST", redirect: "manual", headers: { ...headers, cookie: [headers.cookie, `dfy_csrf=${cookie}`].filter(Boolean).join("; "), "sec-fetch-site": "same-origin" }, body: new URLSearchParams({ _csrf: csrf ?? "", ...fields }) });
  }
  // The terminal opens on a branch whose name would run a command wherever it reached a shell unquoted.
  const EVIL = "t$(touch${IFS}injected)";
  const mainSha = (await ok("GET", `/repos/${owner}/term-tasks/git/ref/heads/main`)).object.sha;
  await ok("POST", `/repos/${owner}/term-tasks/git/refs`, { ref: `refs/heads/${EVIL}`, sha: mainSha });
  const opened = await form("terminals", { agent: "term-hand", ref: EVIL, accept: "1", tasks: "1" });
  assert.equal(opened.status, 303, await opened.text());
  const id = new URL(opened.headers.get("location"), base).pathname.split("/").pop();
  const running = await until("the terminal to start", async () => {
    const p = await page(`terminals/${id}`);
    return p.text.includes("data-socket") ? p : null;
  });
  assert.match(running.text, /Give it a task/);
  assert.match(running.text, /Run with my subscription/);
  assert.match(running.text, /on your own subscription/);

  // Someone else, even an admin of the repository, can't send a task to it; nor can a token (there is no API for it).
  const invite = await ok("PUT", `/repos/${owner}/term-tasks/collaborators/rival`, { permission: "admin" });
  if (invite?.id) await fetch(`${base}/api/v3/user/repository_invitations/${invite.id}`, { method: "PATCH", headers: { cookie: `__Host-dfy_session=${RIVAL_SESSION}`, "sec-fetch-site": "same-origin" } });
  const rival = { cookie: `__Host-dfy_session=${RIVAL_SESSION}` };
  assert.equal((await form(`terminals/${id}/task`, { goal: "Do it", runtime: "claude-code" }, rival)).status, 303);
  assert.deepEqual(await ok("GET", R), [], "someone else's click starts nothing");
  const viaToken = await api("POST", R, { goal: "Do it", runtime: "claude-code", agent: "term-hand", terminal: id });
  assert.equal(viaToken.status, 403, "a token starts no task, in a terminal or not");
  // A terminal opened without "Will run agent tasks" never runs one.
  const plainOpened = await form("terminals", { agent: "term-hand", ref: "main" });
  assert.equal(plainOpened.status, 303, await plainOpened.text());
  const plainId = new URL(plainOpened.headers.get("location"), base).pathname.split("/").pop();
  const plain = await until("the plain terminal to start", async () => {
    const p = await page(`terminals/${plainId}`);
    return p.text.includes("data-socket") ? p : null;
  });
  assert.match(plain.text, /opened without agent tasks/);
  assert.doesNotMatch(plain.text, /Run with my subscription/);
  assert.equal((await form(`terminals/${plainId}/task`, { goal: "Do it", runtime: "claude-code" })).status, 303);
  assert.deepEqual(await ok("GET", R), [], "a terminal opened without tasks runs none");
  assert.equal((await form(`terminals/${plainId}/end`, {})).status, 303);
  // Only Claude Code or Codex, as signed in there.
  const custom = await form(`terminals/${id}/task`, { goal: "Do it", runtime: "custom" });
  assert.equal(custom.status, 303);
  assert.deepEqual(await ok("GET", R), [], "a custom command doesn't run in a terminal");

  // My click: the task runs in my terminal with the CLI there, with no model key or proxy, in its own checkout.
  const started = await form(`terminals/${id}/task`, { goal: "Add a terminal file", runtime: "claude-code" });
  assert.equal(started.status, 303);
  const n = Number(new URL(started.headers.get("location"), base).pathname.split("/").pop());
  assert.ok(n > 0, started.headers.get("location"));
  const done = await until("the terminal task to finish", async () => {
    const t = await ok("GET", `${R}/${n}`);
    return t.state !== "running" && t.state !== "queued" ? t : null;
  });
  const text = (await ok("GET", `${R}/${n}/transcript`)).map((l) => `[${l.stream}] ${l.text}`).join("\n");
  assert.equal(done.state, "ready", text);
  assert.ok(done.pull_request, text);
  assert.match(text, /Running in .*'s terminal/);
  assert.match(text, /signed-in claude: key=none/, "no model key or token reaches it");
  assert.ok(!/base=[^ ]*\/-\/model\//.test(text), "nor the model proxy");
  assert.match(text, new RegExp(`dir=task-${n}-1`), "in a checkout of its own");
  assert.match(text, /\[out\] Add a terminal file/, "the goal reaches it");
  assert.match(text, /--permission-mode bypassPermissions --disallowedTools WebSearch,WebFetch --settings \{/, "no web tools");
  assert.match(text, /"Read\(~\/\.claude\/\*\*\)"/, "and deny rules on the sign-ins");
  // Its jail: the CLI's own sign-in, the proxy as its only way out, and nothing else of the terminal's.
  assert.match(text, /jail: proxy=http:\/\/127\.0\.0\.1:\d+/);
  assert.match(text, /jail: signin=\{"fake":"signin"\}/, "the CLI signs itself in");
  assert.match(text, /jail: history=hidden/, "the rest of the home directory isn't there");
  assert.match(text, /jail: credential=hidden/, "nor the checkout's git config, with the sandbox's credential");
  assert.match(text, /jail: direct=(ENETUNREACH|EHOSTUNREACH|ECONNREFUSED)/, "and there is no route out but the proxy");
  const file = await ok("GET", `/repos/${owner}/term-tasks/contents/terminal.txt?ref=${encodeURIComponent(done.branch)}`);
  assert.equal(Buffer.from(file.content, "base64").toString(), "made in the terminal\n");
  assert.equal(done.runs[0].in_terminal, true);
  assert.equal(done.base, EVIL, "checked out from the terminal's branch, its name passed as data");

  // The terminal's own checkout is untouched, and the terminal is still mine to use.
  const t = await termSocket(`${base.replace("http", "ws")}/${owner}/term-tasks/terminals/${id}/socket?cols=100&rows=30`, { origin: new URL(base).origin });
  assert.equal(t.status, 101);
  t.type("cat ~/.claude/.credentials.json; echo; ls terminal.txt 2>&1 | head -1; ls injected ../injected ../pwned-fsmonitor 2>&1 | grep -c 'No such file'; git status --short | wc -l; ls .. | grep -c task- ; echo check-$((6*7))\n");
  await t.until(/check-42/);
  assert.match(t.out(), /No such file/);
  assert.match(t.out(), /\{"fake":"signin"\}/, "the terminal's own sign-in is untouched by what the task wrote");
  assert.doesNotMatch(t.out(), /attacker/);
  assert.equal(readFileSync(join(poolHome, ".claude", ".credentials.json"), "utf8"), '{"fake":"signin"}', "byte for byte");
  assert.match(t.out(), /\n3\r?\n0\r?\n0\r?\n/, "the branch name ran nothing, nor the clone's config outside its jail");
  assert.match(t.out(), /\n0\r?\n0\r?\n/, "a clean checkout, and the task's checkout removed");

  // Its page offers to run it again there; doing so is another run in the terminal.
  const taskPage = await page(`tasks/${n}`);
  assert.match(taskPage.text, /Run in my terminal/);
  assert.match(taskPage.text, /in [a-z0-9-]+(&#39;|')s terminal/);
  assert.doesNotMatch((await page(`tasks/${n}`, rival)).text, /Run in my terminal/, "not for anyone else");
  assert.equal((await form(`tasks/${n}/terminal`, { terminal: id }, rival)).status, 303);
  assert.equal((await ok("GET", `${R}/${n}`)).runs.length, 1, "someone else's click starts nothing");
  const again = await form(`tasks/${n}/terminal`, { terminal: id, body: "Say it again" });
  assert.equal(again.status, 303);
  const twice = await until("the second terminal run", async () => {
    const x = await ok("GET", `${R}/${n}`);
    return x.runs.length === 2 && x.state === "ready" ? x : null;
  });
  assert.equal(twice.runs[1].state, "done");
  assert.equal(twice.runs[1].in_terminal, true);
  assert.equal(twice.runs[1].kind, "message");
  // Usage (phase 5a): no request passed Diffinery, so each run shows what the signed-in CLI reported, with its cost.
  assert.deepEqual(twice.runs[0].usage, { source: "runtime", requests: 0, input_tokens: 40, output_tokens: 7, cache_read_tokens: 1200, cache_write_tokens: 90, cost_usd: 0.0312 });
  assert.deepEqual(twice.usage, { requests: 0, input_tokens: 80, output_tokens: 14, cache_read_tokens: 2400, cache_write_tokens: 180, cost_usd: 0.0624 });
  assert.match((await page(`tasks/${n}`)).text, /Claude Code in the terminal/);
  const usage = await until("the terminal runs in the usage report", async () => {
    const r = await ok("GET", "/diffinery/model-usage");
    return r.repositories.find((x) => x.repository === `${owner}/term-tasks` && x.runs === 2) ?? null;
  });
  assert.equal(usage.reported_by_cli_runs, 2);
  assert.equal(usage.cost_usd, 0.0624);

  // Ending the terminal ends what it can run: the page no longer offers it, and a click is refused.
  assert.equal((await form(`terminals/${id}/end`, {})).status, 303);
  assert.doesNotMatch((await page(`tasks/${n}`)).text, /Run in my terminal/);
  assert.equal((await form(`tasks/${n}/terminal`, { terminal: id })).status, 303);
  assert.equal((await ok("GET", `${R}/${n}`)).runs.length, 2);
  t.close?.();
});
