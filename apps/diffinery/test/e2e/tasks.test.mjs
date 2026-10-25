// End-to-end agent tasks: a real `wrangler dev` Worker, sandboxes in an
// `agent.mjs --sandbox-pool` process (containers don't run under wrangler dev),
// a fake model provider behind the model proxy, and the real git CLI.
//
//   pnpm --filter @diffinery/app e2e
//
// Covers model keys (write-only, browser session only, opt-in), a task run end
// to end (sandbox as the agent, the model proxy adding the person's key, the
// push and the pull request as the agent), follow-ups, stopping, and the
// security rules: no token, agent or sandbox can start or steer a task, task
// sandboxes are closed to the sandbox API, and a run's model token stops
// working when the run ends.
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
  jailToken,
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

test("model keys: write-only, browser session only, with an opt-in", async () => {
  assert.deepEqual(await ok("GET", "/diffinery/model-keys"), []);
  // No token can set one, however wide.
  const viaToken = await api("PUT", "/diffinery/model-keys/anthropic", { key: ANTHROPIC_KEY, accept_terms: true });
  assert.equal(viaToken.status, 403, JSON.stringify(viaToken.json));
  assert.match(viaToken.json.message, /browser session/);
  // The opt-in is required, and the key's shape is checked.
  assert.equal((await asPerson("PUT", "/diffinery/model-keys/anthropic", { key: ANTHROPIC_KEY })).status, 422);
  assert.equal((await asPerson("PUT", "/diffinery/model-keys/anthropic", { key: "sk-proj-not-anthropic-1234567890abcdef", accept_terms: true })).status, 422);
  assert.equal((await asPerson("PUT", "/diffinery/model-keys/gemini", { key: ANTHROPIC_KEY, accept_terms: true })).status, 404);
  const saved = await asPerson("PUT", "/diffinery/model-keys/anthropic", { key: ANTHROPIC_KEY, accept_terms: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.hint, ANTHROPIC_KEY.slice(-4));
  assert.ok(saved.json.opted_in_at);
  // Never returned: not by the API, not on the page.
  const listed = await ok("GET", "/diffinery/model-keys");
  assert.deepEqual(listed.map((k) => k.provider), ["anthropic"]);
  assert.ok(!JSON.stringify(listed).includes(ANTHROPIC_KEY));
  const page = await (await fetch(`${base}/settings/model-access`)).text();
  assert.match(page, /Model access/);
  assert.match(page, /Commercial Terms/);
  assert.ok(page.includes(`…${ANTHROPIC_KEY.slice(-4)}`));
  assert.ok(!page.includes(ANTHROPIC_KEY));
  assert.equal((await api("DELETE", "/diffinery/model-keys/anthropic")).status, 403);
});

test("an agent task runs in a sandbox as the agent, through the model proxy, and opens a pull request", async () => {
  const me = await ok("GET", "/user");
  const owner = me.login;
  await ok("POST", "/user/repos", { name: "tasks-demo" });
  const src = join(work, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "README.md"), "# tasks\n");
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "initial"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/tasks-demo.git`]);
  git(src, ["push", "-q", "origin", "main"]);
  const R = `/repos/${owner}/tasks-demo/diffinery/tasks`;
  const bot = (await asPerson("POST", "/diffinery/agents", { login: "task-bot", name: "Task Bot" })).json.token.token;

  const tokFile = join(work, "model-token");
  // The custom runtime: call the model through the proxy, show the key variable, save it for later, change a file.
  // It runs in a jail (phase 5d): what it can see and reach is shown too.
  const command = [
    `curl -sS -X POST "$ANTHROPIC_BASE_URL/v1/messages" -H "x-api-key: $ANTHROPIC_API_KEY" -H "content-type: application/json" -d '{"model":"m","messages":[]}'`,
    "echo",
    'echo "key is $ANTHROPIC_API_KEY"',
    `printf %s "$ANTHROPIC_API_KEY" > ${tokFile}`,
    'echo "goal: $DIFFINERY_TASK_PROMPT" | tail -1',
    'echo "jail: credential=$(cat ../repo/.git/config 2>/dev/null || echo hidden)"',
    'echo "jail: token=$(env | grep -c dmt_)"',
    // Only the model endpoints through the jail's model proxy, however the path is spelled; Diffinery itself is out of reach.
    `echo "jail: api=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$ANTHROPIC_BASE_URL/../../api/v3/user")"`,
    // (The test's Diffinery is on 127.0.0.1, which NO_PROXY sends direct; --noproxy '' sends it through the proxy.)
    `echo "jail: via-proxy=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '' ${base}/api/v3/user)"`,
    `echo "jail: direct=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 5 ${base}/api/v3/user)"`,
    "echo hello > hello.txt",
  ].join("; ");
  const goal = "Add a hello file";

  // Nobody but a person in a browser starts a task: not their token, not the agent's.
  for (const tok of [token, bot]) {
    const r = await api("POST", R, { goal, runtime: "custom", command, agent: "task-bot" }, tok);
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.match(r.json.message, /browser session/);
  }
  // Codex needs an OpenAI key the person doesn't have.
  const codex = await asPerson("POST", R, { goal, runtime: "codex", agent: "task-bot" });
  assert.equal(codex.status, 422);
  assert.match(codex.json.message, /OpenAI API key/);
  assert.equal((await asPerson("POST", R, { goal, runtime: "custom", command, agent: owner })).status, 422, "a person isn't an agent");

  const started = await asPerson("POST", R, { goal, runtime: "custom", command, agent: "task-bot" });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  const n = started.json.number;
  assert.equal(started.json.state, "running");
  assert.equal(started.json.branch, "agent/1-add-a-hello-file");
  assert.equal(started.json.agent.login, "task-bot");
  assert.equal(started.json.started_by.login, owner);

  const done = await until("the task to finish", async () => {
    const t = await ok("GET", `${R}/${n}`);
    return t.state !== "running" ? t : null;
  });
  const lines = await ok("GET", `${R}/${n}/transcript`);
  const text = lines.map((l) => `[${l.stream}] ${l.text}`).join("\n");
  assert.equal(done.state, "ready", text);
  assert.ok(done.pull_request, text);

  // The provider got the person's key, never the run's token; the sandbox never saw the key.
  assert.equal(modelRequests.length, 1, text);
  assert.equal(modelRequests[0].headers["x-api-key"], ANTHROPIC_KEY);
  assert.equal(modelRequests[0].url, "/v1/messages");
  assert.ok(!JSON.stringify(modelRequests[0].headers).includes("dmt_"));
  assert.match(text, /fake model says hi/);
  // The agent had a stand-in for a key: the run's token stayed outside its jail, with the jail's model proxy.
  assert.match(text, /key is diffinery-jail/);
  assert.equal(readFileSync(tokFile, "utf8"), "diffinery-jail");
  assert.match(text, /\[out\] Add a hello file/, "the prompt reaches the runtime");
  assert.ok(!text.includes(ANTHROPIC_KEY));
  assert.ok(!text.includes("dmt_"));
  // Its jail (phase 5d): no sandbox credential, no token, Diffinery reachable only at its model endpoints, no network of its own.
  assert.match(text, /jail: credential=hidden/);
  assert.match(text, /jail: token=0/);
  assert.match(text, /jail: api=403/);
  assert.match(text, /jail: via-proxy=403/);
  assert.match(text, /jail: direct=000/);
  assert.equal(modelRequests.length, 1);
  // The proxy doesn't take an account token, or anything outside /v1/.
  assert.equal((await fetch(`${base}/-/model/anthropic/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await fetch(`${base}/-/model/anthropic/admin`, { headers: { "x-api-key": `dmt_${"x".repeat(12)}_y` } })).status, 403);

  // The pull request is the agent's, from the task's branch, with the work.
  const pr = await ok("GET", `/repos/${owner}/tasks-demo/pulls/${done.pull_request.number}`);
  assert.equal(pr.user.login, "task-bot");
  assert.equal(pr.head.ref, "agent/1-add-a-hello-file");
  assert.equal(pr.intent, goal);
  const files = await ok("GET", `/repos/${owner}/tasks-demo/pulls/${pr.number}/files`);
  assert.deepEqual(files.map((f) => f.filename), ["hello.txt"]);
  const commit = await ok("GET", `/repos/${owner}/tasks-demo/commits/${pr.head.sha}`);
  assert.equal(commit.commit.author.name, "task-bot");

  // Read over MCP and on Today; steering is not on MCP.
  const viaMcp = await mcp("agent_task", { owner, repo: "tasks-demo", number: n });
  assert.equal(viaMcp.isError, false, viaMcp.content[0].text);
  assert.equal(viaMcp.structuredContent.state, "ready");
  assert.ok(viaMcp.structuredContent.transcript.length > 0);
  const mine = await mcp("agent_tasks", {});
  assert.deepEqual(mine.structuredContent.result.map((t) => t.number), [n]);
  const today = await ok("GET", "/diffinery/today");
  assert.equal(today.tasks[0].number, n);
  assert.equal(today.tasks[0].state, "ready");

  // Pages.
  for (const path of ["tasks", `tasks/${n}`, "tasks/new"]) {
    const res = await fetch(`${base}/${owner}/tasks-demo/${path}`);
    assert.equal(res.status, 200, path);
  }
  const taskPage = await (await fetch(`${base}/${owner}/tasks-demo/tasks/${n}`)).text();
  assert.match(taskPage, /Add a hello file/);
  assert.match(taskPage, /fake model says hi/);

  // Usage (phase 5a): counted by the model proxy from the provider's answer, on the task, its page and the person's 30 days.
  const counted = await until("the run's usage", async () => {
    const t = await ok("GET", `${R}/${n}`);
    return t.runs[0].usage?.input_tokens === 21 ? t : null;
  });
  assert.deepEqual(counted.runs[0].usage, { source: "proxy", requests: 1, input_tokens: 21, output_tokens: 4, cache_read_tokens: 300, cache_write_tokens: 0, cost_usd: null });
  assert.deepEqual(counted.usage, { requests: 1, input_tokens: 21, output_tokens: 4, cache_read_tokens: 300, cache_write_tokens: 0, cost_usd: null });
  assert.equal((await mcp("agent_task", { owner, repo: "tasks-demo", number: n })).structuredContent.usage.input_tokens, 21);
  const usagePage = await (await fetch(`${base}/${owner}/tasks-demo/tasks/${n}`)).text();
  assert.match(usagePage, /<h2>Usage<\/h2>/);
  assert.match(usagePage, /Diffinery<\/td>/);
  const report = await until("the usage report", async () => {
    const r = await ok("GET", "/diffinery/model-usage");
    return r.repositories.find((x) => x.repository === `${owner}/tasks-demo` && x.kind === "task" && x.input_tokens >= 21) ? r : null;
  });
  assert.equal(report.days, 30);
  assert.deepEqual(report.repositories[0], { repository: `${owner}/tasks-demo`, kind: "task", runs: 1, reported_by_cli_runs: 0, requests: 1, input_tokens: 21, output_tokens: 4, cache_read_tokens: 300, cache_write_tokens: 0, cost_usd: null });
  assert.equal((await ok("GET", "/diffinery/model-usage?days=500")).days, 90);
  // A repository is named as it was when the run ended, not by a later name (Security, 5a).
  await ok("PATCH", `/repos/${owner}/tasks-demo`, { name: "tasks-demo-renamed" });
  assert.deepEqual((await ok("GET", "/diffinery/model-usage")).repositories.map((x) => x.repository), [`${owner}/tasks-demo`]);
  await ok("PATCH", `/repos/${owner}/tasks-demo-renamed`, { name: "tasks-demo" });
  const settingsPage = await (await fetch(`${base}/settings/model-access`)).text();
  assert.match(settingsPage, /Usage in the last 30 days/);
  assert.ok(settingsPage.includes(`>${owner}/tasks-demo</a>`));
  // Someone else's report is their own: the rival pays for nothing here.
  const rivalUsage = await (await fetch(`${base}/api/v3/diffinery/model-usage`, { headers: { cookie: `__Host-dfy_session=${RIVAL_SESSION}` } })).json();
  assert.deepEqual(rivalUsage.repositories, []);

  // Follow-ups and retries: the person, in a browser; never a token.
  assert.equal((await api("POST", `${R}/${n}/messages`, { body: "again" })).status, 403);
  assert.equal((await api("POST", `${R}/${n}/retry`, {})).status, 403);
  assert.equal((await api("POST", `${R}/${n}/messages`, { body: "again" }, bot)).status, 403);
  const followUp = await asPerson("POST", `${R}/${n}/messages`, { body: "Say hello again" });
  assert.equal(followUp.status, 201, JSON.stringify(followUp.json));
  const second = await until("the follow-up run", async () => {
    const t = await ok("GET", `${R}/${n}`);
    return t.state !== "running" ? t : null;
  });
  assert.equal(second.state, "ready");
  assert.deepEqual(second.runs.map((r) => [r.kind, r.state]), [
    ["start", "done"],
    ["message", "done"],
  ]);
  const text2 = (await ok("GET", `${R}/${n}/transcript?after=${lines.at(-1).seq}`)).map((l) => l.text).join("\n");
  assert.match(text2, /Say hello again/);
  assert.match(text2, /No changes to push/);
  assert.match(text2, /Starting a sandbox on agent\/1-add-a-hello-file/);
});

test("task sandboxes are closed to the sandbox API, and stopping ends the run's access", async () => {
  const me = await ok("GET", "/user");
  const owner = me.login;
  const R = `/repos/${owner}/tasks-demo/diffinery/tasks`;
  const bot = (await asPerson("POST", "/diffinery/agents/task-bot/tokens", { name: "second" })).json.token;
  const tokFile = join(work, "model-token-2");
  // An OpenRouter key too: its own shape, its own opt-in.
  assert.equal((await asPerson("PUT", "/diffinery/model-keys/openrouter", { key: ANTHROPIC_KEY, accept_terms: true })).status, 422);
  assert.equal((await asPerson("PUT", "/diffinery/model-keys/openrouter", { key: OPENROUTER_KEY })).status, 422);
  assert.equal((await asPerson("PUT", "/diffinery/model-keys/openrouter", { key: OPENROUTER_KEY, accept_terms: true })).status, 200);
  const before_ = new Set(poolSandboxes());
  const started = await asPerson("POST", R, { goal: "Wait a while", runtime: "custom", command: `printf %s "$ANTHROPIC_API_KEY" > ${tokFile}; sleep 120`, agent: "task-bot" });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  const n = started.json.number;
  const id = await until("the task's sandbox", async () => poolSandboxes().find((x) => !before_.has(x)) ?? null);
  const runToken = await jailToken(tokFile);

  // While it runs, its token works through the proxy.
  const live = await fetch(`${base}/-/model/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": runToken, "content-type": "application/json" }, body: "{}" });
  assert.equal(live.status, 200);

  // Only the model endpoints: not the rest of the person's provider account.
  for (const [method, path] of [
    ["GET", "/v1/files"],
    ["POST", "/v1/messages/batches"],
    ["DELETE", "/v1/files/file_1"],
  ]) {
    const seen = modelRequests.length;
    const r = await fetch(`${base}/-/model/anthropic${path}`, { method, headers: { "x-api-key": runToken, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.match((await r.json()).error.message, new RegExp(path.replace(/\//g, "\\/")));
    assert.equal(modelRequests.length, seen, `${method} ${path} must not reach the provider`);
  }

  // OpenRouter: the run's token works there too (the custom runtime gets every provider the person has a key for),
  // with the person's OpenRouter key and Diffinery's attribution added, and only its model endpoints.
  const seenOr = modelRequests.length;
  const orLive = await fetch(`${base}/-/model/openrouter/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${runToken}`, "content-type": "application/json", "x-title": "spoofed", "http-referer": "https://spoofed.example", referer: "https://spoofed.example", "x-openrouter-categories": "spoofed" }, body: '{"model":"anthropic/claude-sonnet-4.5","messages":[]}' });
  assert.equal(orLive.status, 200);
  const orReq = modelRequests[seenOr];
  assert.equal(orReq.url, "/v1/chat/completions");
  assert.equal(orReq.headers.authorization, `Bearer ${OPENROUTER_KEY}`);
  assert.equal(orReq.headers["x-api-key"], undefined);
  assert.equal(orReq.headers["x-title"], "Diffinery");
  assert.equal(orReq.headers["http-referer"], base);
  // Only Diffinery names itself to OpenRouter: the sandbox's attribution headers never reach it.
  assert.equal(orReq.headers.referer, undefined);
  assert.equal(orReq.headers["x-openrouter-categories"], undefined);
  // Claude Code's way in: the Messages endpoint, with the token as a bearer token.
  assert.equal((await fetch(`${base}/-/model/openrouter/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${runToken}`, "content-type": "application/json" }, body: "{}" })).status, 200);
  for (const [method, path] of [
    ["GET", "/v1/key"],
    ["GET", "/v1/credits"],
    ["GET", "/v1/keys"],
    ["POST", "/v1/keys"],
    ["GET", "/v1/generation"],
    ["GET", "/v1/activity"],
    ["GET", "/v1/models/user"],
  ]) {
    const seen = modelRequests.length;
    const r = await fetch(`${base}/-/model/openrouter${path}`, { method, headers: { authorization: `Bearer ${runToken}`, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    assert.equal(r.status, 403, `openrouter ${method} ${path}`);
    assert.equal(modelRequests.length, seen, `openrouter ${method} ${path} must not reach the provider`);
  }

  // No public sandbox call reaches it: the person (a repository admin here), their token, the agent.
  for (const [who, tok] of [
    ["the person in a browser", null],
    ["the person's admin token", token],
    ["the agent's token", bot],
  ]) {
    for (const action of ["exec", "read", "write", "close"]) {
      const r = await api("POST", `/repos/${owner}/tasks-demo/diffinery/sandboxes/${id}/${action}`, { cmd: "env", path: "README.md", content: "" }, tok);
      assert.equal(r.status, 404, `${who} ${action}: ${JSON.stringify(r.json)}`);
    }
  }
  for (const tool of ["sandbox_exec", "sandbox_read_file", "sandbox_write_file", "sandbox_close"]) {
    const r = await mcp(tool, { owner, repo: "tasks-demo", sandbox_id: id, command: "env", path: "README.md", content: "" }, bot);
    assert.equal(r.isError, true, tool);
    assert.match(r.content[0].text, /sandbox not found/, tool);
  }

  // A plain sandbox's own credential can't start or steer a task either.
  const plain = await ok("POST", `/repos/${owner}/tasks-demo/diffinery/sandboxes`, {}, bot);
  const cfgPath = join(poolRoot, plain.id, "repo", ".git", "config");
  const config = await until("the plain sandbox's git credential", async () => (existsSync(cfgPath) && /extraheader/i.test(readFileSync(cfgPath, "utf8")) ? readFileSync(cfgPath, "utf8") : null));
  const basic = /extraheader = Authorization: Basic (\S+)/i.exec(config);
  assert.ok(basic, config);
  const dst = Buffer.from(basic[1], "base64").toString().split(":").pop();
  assert.match(dst, /^dst_/);
  assert.equal((await api("POST", R, { goal: "x", runtime: "custom", command: "true", agent: "task-bot" }, dst)).status, 403);
  assert.equal((await api("POST", `${R}/${n}/messages`, { body: "x" }, dst)).status, 403);
  await ok("POST", `/repos/${owner}/tasks-demo/diffinery/sandboxes/${plain.id}/close`, {}, bot);

  // One account keeps at most 5 sandboxes open in a repository; closing one makes room.
  const open = [];
  for (let i = 0; i < 5; i++) open.push((await ok("POST", `/repos/${owner}/tasks-demo/diffinery/sandboxes`, {}, bot)).id);
  const sixth = await api("POST", `/repos/${owner}/tasks-demo/diffinery/sandboxes`, {}, bot);
  assert.equal(sixth.status, 429);
  assert.match(sixth.json.message, /5 open sandboxes in this repository/);
  await ok("POST", `/repos/${owner}/tasks-demo/diffinery/sandboxes/${open.pop()}/close`, {}, bot);
  open.push((await ok("POST", `/repos/${owner}/tasks-demo/diffinery/sandboxes`, {}, bot)).id);
  for (const id of open) await ok("POST", `/repos/${owner}/tasks-demo/diffinery/sandboxes/${id}/close`, {}, bot);

  // The agent can stop its own task; the run's token stops working.
  const stopped = await ok("POST", `${R}/${n}/stop`, {}, bot);
  assert.equal(stopped.state, "stopped");
  const after_ = await fetch(`${base}/-/model/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": runToken, "content-type": "application/json" }, body: "{}" });
  assert.equal(after_.status, 401);
  const t = await ok("GET", `${R}/${n}`);
  assert.equal(t.runs[0].state, "stopped");
  assert.match((await ok("GET", `${R}/${n}/transcript`)).map((l) => l.text).join("\n"), /Stopped by task-bot/);

  // Claude Code and Codex can run through OpenRouter with a model of the person's choice; only combinations that work.
  const form = await (await fetch(`${base}/${owner}/tasks-demo/tasks/new`)).text();
  assert.match(form, /claude-code\+openrouter&quot;,&quot;label&quot;:&quot;Claude Code via OpenRouter/);
  assert.match(form, /codex\+openrouter&quot;,&quot;label&quot;:&quot;Codex via OpenRouter/);
  for (const bad of [
    { runtime: "codex", provider: "anthropic" },
    { runtime: "custom", command: "true", provider: "openrouter" },
    { runtime: "claude-code", provider: "openrouter", model: "not a model" },
    { runtime: "claude-code", model: "anthropic/claude-sonnet-4.5" },
  ]) assert.equal((await asPerson("POST", R, { goal: "x", agent: "task-bot", ...bad })).status, 422, JSON.stringify(bad));
  const viaOr = await asPerson("POST", R, { goal: "Say hi", agent: "task-bot", runtime: "claude-code", provider: "openrouter", model: "anthropic/claude-sonnet-4.5" });
  assert.equal(viaOr.status, 201, JSON.stringify(viaOr.json));
  assert.equal(viaOr.json.runtime, "claude-code");
  assert.equal(viaOr.json.provider, "openrouter");
  assert.equal(viaOr.json.model, "anthropic/claude-sonnet-4.5");
  assert.equal((await ok("GET", `${R}/${viaOr.json.number}`)).provider, "openrouter");
  await ok("POST", `${R}/${viaOr.json.number}/stop`, {}, bot);
});

test("a repository is a project: settings, memory, conversation, and a queue of tasks", async () => {
  const me = await ok("GET", "/user");
  const owner = me.login;
  const P = `/repos/${owner}/tasks-demo/diffinery/project`;
  const R = `/repos/${owner}/tasks-demo/diffinery/tasks`;

  // Settings: an admin in a browser; never a token.
  assert.equal((await api("PUT", `${P}/settings`, { max_running: 1 })).status, 403);
  for (const bad of [0, 11, 1.5, "x"]) assert.equal((await asPerson("PUT", `${P}/settings`, { max_running: bad })).status, 422, String(bad));
  assert.deepEqual((await asPerson("PUT", `${P}/settings`, { max_running: 1, instructions: "Always say PROJECT-RULE-7." })).json, { max_running: 1, instructions: "Always say PROJECT-RULE-7.", plan_first: "off" });

  // Memory: every save is a version, and a restore is one more.
  assert.equal((await api("PUT", `${P}/memory`, { body: "x" })).status, 403);
  assert.equal((await asPerson("PUT", `${P}/memory`, { body: "MEMORY-NOTE-1: docs live in docs/." })).json.version, 1);
  assert.equal((await asPerson("PUT", `${P}/memory`, { body: "MEMORY-NOTE-2: something wrong." })).json.version, 2);
  assert.equal((await asPerson("PUT", `${P}/memory`, { restore: 99 })).status, 404);
  const restored = await asPerson("PUT", `${P}/memory`, { restore: 1 });
  assert.equal(restored.json.version, 3);
  assert.equal(restored.json.body, "MEMORY-NOTE-1: docs live in docs/.");
  const memory = await ok("GET", `${P}/memory`);
  assert.deepEqual(memory.versions.map((v) => v.version), [3, 2, 1]);
  assert.equal(memory.updated_by.login, owner);

  // The conversation: people post in a browser.
  assert.equal((await api("POST", `${P}/posts`, { body: "hi" })).status, 403);
  assert.equal((await asPerson("POST", `${P}/posts`, { body: " " })).status, 422);
  const idea = await asPerson("POST", `${P}/posts`, { body: "Idea: write a queued file" });
  assert.equal(idea.status, 201, JSON.stringify(idea.json));

  // One at a time: the second task waits, then starts when the first ends. Both get the instructions and memory.
  const command = (file, wait) => `printf '%s\\n' "$DIFFINERY_TASK_PROMPT" | grep -E 'PROJECT-RULE-7|MEMORY-NOTE|--- (instructions|memory) ---'; sleep ${wait}; echo ${file} > ${file}.txt`;
  const a = await asPerson("POST", R, { goal: "Write the first file", runtime: "custom", command: command("first", 8), agent: "task-bot" });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  const b = await asPerson("POST", R, { goal: "Write the queued file", runtime: "custom", command: command("queued", 0), agent: "task-bot" });
  assert.equal(b.status, 201, JSON.stringify(b.json));
  assert.equal(a.json.state, "running");
  assert.equal(b.json.state, "queued");
  const board = await ok("GET", P);
  assert.deepEqual(board.board.working.map((t) => t.number), [a.json.number]);
  assert.deepEqual(board.board.queued.map((t) => t.number), [b.json.number]);
  assert.equal(board.settings.max_running, 1);
  assert.equal(board.memory.version, 3);
  const queuedLines = (await ok("GET", `${R}/${b.json.number}/transcript`)).map((l) => l.text).join("\n");
  assert.match(queuedLines, /Queued: 1 task is already running/);
  const listed = (await ok("GET", `${R}?state=queued`)).map((t) => t.number);
  assert.deepEqual(listed, [b.json.number]);

  const first = await until("the first task", async () => {
    const t = await ok("GET", `${R}/${a.json.number}`);
    return t.state !== "running" ? t : null;
  });
  assert.equal(first.state, "ready");
  const second = await until("the queued task", async () => {
    const t = await ok("GET", `${R}/${b.json.number}`);
    return t.state === "ready" || t.state === "failed" ? t : null;
  });
  const text = (await ok("GET", `${R}/${b.json.number}/transcript`)).map((l) => l.text).join("\n");
  assert.equal(second.state, "ready", text);
  assert.ok(second.pull_request, text);
  // The queued run started only after the first one ended.
  assert.ok(Date.parse(second.runs[0].started_at) >= Date.parse(first.runs[0].ended_at), JSON.stringify([first.runs[0], second.runs[0]]));
  for (const want of ["--- instructions ---", "PROJECT-RULE-7", "--- memory ---", "MEMORY-NOTE-1"]) assert.ok(text.includes(want), `${want}\n${text}`);
  assert.ok(!text.includes("MEMORY-NOTE-2"), "the restored memory, not the replaced one");

  // Tasks report to the conversation.
  const posts = await ok("GET", `${P}/posts`);
  const bodies = posts.map((p) => p.body);
  assert.ok(bodies.includes("Idea: write a queued file"));
  assert.ok(bodies.includes(`${owner} started task #${b.json.number}: Write the queued file`), bodies.join("\n"));
  assert.ok(bodies.includes(`Task #${b.json.number} opened pull request #${second.pull_request.number}.`), bodies.join("\n"));
  const later = await ok("GET", `${P}/posts?after=${idea.json.id}`);
  assert.ok(later.every((p) => p.id > idea.json.id && p.kind === "event"));

  // Over MCP.
  const viaMcp = await mcp("project", { owner, repo: "tasks-demo" });
  assert.equal(viaMcp.isError, false, viaMcp.content[0].text);
  assert.equal(viaMcp.structuredContent.settings.max_running, 1);
  const postsMcp = await mcp("project_posts", { owner, repo: "tasks-demo" });
  assert.equal(postsMcp.isError, false, postsMcp.content[0].text);
  assert.ok(JSON.stringify(postsMcp.structuredContent).includes("Idea: write a queued file"));

  // Pages.
  const projectPage = await (await fetch(`${base}/${owner}/tasks-demo/project`)).text();
  assert.match(projectPage, /Ready for review/);
  assert.match(projectPage, /Write the queued file/);
  assert.match(projectPage, /Idea: write a queued file/);
  assert.match(projectPage, /MEMORY-NOTE-1/);
  assert.match(projectPage, /href="\/[^"]+\/tasks-demo\/project" class="on"/);
  const fromPost = await (await fetch(`${base}/${owner}/tasks-demo/tasks/new?post=${idea.json.id}`)).text();
  assert.match(fromPost, /Idea: write a queued file<\/textarea>/);
  const memoryPage = await (await fetch(`${base}/${owner}/tasks-demo/project/memory?version=2`)).text();
  assert.match(memoryPage, /Restore this version/);
  assert.match(memoryPage, /<tr class="del"><td class="ln">-<\/td><td class="code">MEMORY-NOTE-1/);
  assert.match(memoryPage, /<tr class="add"><td class="ln">\+<\/td><td class="code">MEMORY-NOTE-2/);
  const settingsPage = await (await fetch(`${base}/${owner}/tasks-demo/settings/project`)).text();
  assert.match(settingsPage, /name="max_running"[^>]*value="1"/);
  assert.match(settingsPage, /Always say PROJECT-RULE-7\./);

  // The web forms work too, and raising the limit is what later tests need.
  const form = async (path, fields) => {
    const res = await fetch(`${base}/${owner}/tasks-demo/settings/project`);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await res.text())?.[1];
    const cookie = /dfy_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    return fetch(`${base}/${owner}/tasks-demo/${path}`, { method: "POST", redirect: "manual", headers: { cookie: `dfy_csrf=${cookie}`, "sec-fetch-site": "same-origin" }, body: new URLSearchParams({ _csrf: csrf ?? "", ...fields }) });
  };
  assert.equal((await form("settings/project", { max_running: "0", instructions: "" })).status, 422);
  assert.equal((await form("settings/project", { max_running: "3", instructions: "", plan_first: "sometimes" })).status, 422);
  assert.equal((await form("settings/project", { max_running: "3", instructions: "", plan_first: "default" })).status, 303);
  assert.deepEqual((await ok("GET", P)).settings, { max_running: 3, instructions: "", plan_first: "default" });
  assert.equal((await form("settings/project", { max_running: "3", instructions: "", plan_first: "off" })).status, 303);
  assert.equal((await form("project/posts", { body: "Posted from the page" })).status, 303);
  assert.ok((await ok("GET", `${P}/posts`)).some((p) => p.body === "Posted from the page"));
  assert.equal((await form("project/memory/2/restore", {})).status, 303);
  assert.equal((await ok("GET", `${P}/memory`)).body, "MEMORY-NOTE-2: something wrong.");
});

test("a coordinator turns posts into tasks, within its caps, and acts only through a validated block", async () => {
  const me = await ok("GET", "/user");
  const owner = me.login;
  const P = `/repos/${owner}/tasks-demo/diffinery/project`;
  const R = `/repos/${owner}/tasks-demo/diffinery/tasks`;
  // The coordinator and the tasks it starts run this script (the custom runtime), from the default branch.
  const src = join(work, "src");
  writeFileSync(
    join(src, "coord.sh"),
    `p="$DIFFINERY_TASK_PROMPT"
case "$p" in
  *"You are the project coordinator"*)
    printf '%s\\n' "$p" | grep -E '^--- (post #|memory ---|instructions ---)' || true
    post=$(printf '%s\\n' "$p" | sed -n '/^--- post #/,/^--- end of post ---/p')
    case "$post" in
      *BAD-BATCH*) printf '%s\\n' 'Checking.' '\`\`\`json' '{"reply": "Stopping it.", "stop": [999]}' '\`\`\`' ;;
      *MSG-HAND*) printf '%s\\n' '\`\`\`json' '{"reply": "Nudging it.", "messages": [{"task": 1, "text": "Spend more."}]}' '\`\`\`' ;;
      *MSG-OWN*)
        n=$(printf '%s\\n' "$p" | sed -n 's/^- #\\([0-9]*\\) \\[[a-z]*\\] Small part .*started by you: you may message.*/\\1/p' | head -1)
        printf '%s\\n' '\`\`\`json' "{\\"reply\\": \\"Following up on #$n.\\", \\"messages\\": [{\\"task\\": $n, \\"text\\": \\"Check it again.\\"}]}" '\`\`\`' ;;
      *PLAN-THREE*) printf '%s\\n' '\`\`\`json' '{"reply": "Splitting it in three.", "tasks": [{"title": "Small part", "goal": "COORD-SMALL: write the small part."}, {"title": "Big part", "goal": "COORD-BIG: write the big part.", "after": [0]}, {"title": "Never part", "goal": "COORD-NEVER: never runs.", "after": [1]}], "memory": "MEMORY-BY-COORD: parts are split in three."}' '\`\`\`' ;;
      *) printf '%s\\n' '\`\`\`json' '{"reply": "Noted, nothing to do."}' '\`\`\`' ;;
    esac ;;
  *COORD-SMALL*)
    curl -s -o /dev/null -w "model %{http_code}\\n" -X POST "$ANTHROPIC_BASE_URL/v1/messages" -H "x-api-key: $ANTHROPIC_API_KEY" -H "content-type: application/json" -d '{"model":"m","max_tokens":5,"messages":[]}'
    echo small > small.txt ;;
  *COORD-BIG*)
    curl -s -o /dev/null -w "model %{http_code}\\n" -X POST "$ANTHROPIC_BASE_URL/v1/messages" -H "x-api-key: $ANTHROPIC_API_KEY" -H "content-type: application/json" -d '{"model":"m","max_tokens":200000,"messages":[]}'
    echo big > big.txt ;;
  *) echo other > other.txt ;;
esac
`,
  );
  git(src, ["pull", "-q", "--rebase", "origin", "main"]);
  git(src, ["add", "coord.sh"]);
  git(src, ["commit", "-q", "-m", "coordinator script"]);
  git(src, ["push", "-q", "origin", "main"]);

  // Your coordinator: yours alone, set in a browser, with an opt-in to your key.
  assert.deepEqual(await ok("GET", `${P}/coordinator`), { enabled: false });
  const settings = { agent: "task-bot", runtime: "custom", command: "sh coord.sh", tokens_per_task: 150000, accept: true };
  assert.equal((await api("PUT", `${P}/coordinator`, settings)).status, 403);
  assert.equal((await asPerson("PUT", `${P}/coordinator`, { ...settings, accept: false })).status, 422);
  assert.equal((await asPerson("PUT", `${P}/coordinator`, { ...settings, tokens_per_task: 5 })).status, 422);
  assert.equal((await asPerson("PUT", `${P}/coordinator`, { ...settings, agent: owner })).status, 422);
  const saved = await asPerson("PUT", `${P}/coordinator`, settings);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.agent.login, "task-bot");
  assert.equal(saved.json.tokens_per_task, 150000);
  assert.equal(saved.json.tokens_per_run, 1000000);
  // Everyone with write access sees whose coordinators are on, and with which agent and model; never their budgets or command.
  const viewer = (await asPerson("POST", "/diffinery/agents/task-bot/tokens", { name: "coordinators" })).json.token;
  const listed = await api("GET", `${P}/coordinators`, undefined, viewer);
  assert.equal(listed.status, 200, JSON.stringify(listed.json));
  assert.equal(listed.json.length, 1, JSON.stringify(listed.json));
  assert.deepEqual(listed.json[0], { person: { login: owner }, agent: { login: "task-bot" }, runtime: "custom", provider: null, model: null, opted_in_at: listed.json[0].opted_in_at });
  // Without write access (the rival, signed in in a browser), the list doesn't exist.
  const rivalList = await fetch(`${base}/api/v3${P}/coordinators`, { headers: { cookie: `__Host-dfy_session=${RIVAL_SESSION}` } });
  assert.equal(rivalList.status, 404, "people without write access see nothing");

  const coordinatorRun = async (post) =>
    until(`the coordinator to handle post #${post}`, async () => {
      const t = await ok("GET", `${R}/${post.task}`);
      return t.runs.length >= post.run && t.runs[post.run - 1].state !== "boot" && !["queued", "boot", "install", "agent", "finish"].includes(t.runs[post.run - 1].state) ? t : null;
    });

  // A post goes to the poster's coordinator, which plans three tasks: the second after the first, the third after the second.
  const plan = await asPerson("POST", `${P}/posts`, { body: "PLAN-THREE: split the work." });
  assert.equal(plan.status, 201, JSON.stringify(plan.json));
  assert.equal(plan.json.coordinator.status, "started");
  const coord = plan.json.coordinator.task;
  const done = await coordinatorRun({ task: coord, run: 1 });
  const coordText = (await ok("GET", `${R}/${coord}/transcript`)).map((l) => l.text).join("\n");
  assert.equal(done.kind, "coordinator");
  assert.equal(done.runs[0].state, "done", coordText);
  assert.match(coordText, new RegExp(`^--- post #${plan.json.id} by ${owner} ---$`, "m"));
  assert.match(coordText, /^--- memory ---$/m, "the coordinator reads the memory");
  assert.match(coordText, /read-only sandbox/);
  assert.match(coordText, /Applied: a reply, started #\d+, #\d+, #\d+, memory\./);

  const posts = await ok("GET", `${P}/posts?after=${plan.json.id - 1}`);
  const reply = posts.find((p) => p.kind === "coordinator");
  assert.equal(reply.body, "Splitting it in three.");
  assert.equal(reply.author.login, "task-bot");
  assert.equal(posts.find((p) => p.id === plan.json.id).handled_by.number, coord);
  const started = posts.filter((p) => p.kind === "event" && p.body.startsWith(`${owner}'s coordinator started task`));
  assert.equal(started.length, 3, JSON.stringify(posts));
  const [a, b, c] = started.map((p) => p.task.number);
  const memEvent = posts.find((p) => p.memory_version);
  assert.match(memEvent.body, /changed the project memory to version \d+: 1 line added, 1 removed\./);
  assert.equal((await ok("GET", `${P}/memory`)).body, "MEMORY-BY-COORD: parts are split in three.");

  const ta = await ok("GET", `${R}/${a}`);
  assert.deepEqual(ta.started_via, { type: "coordinator", post: plan.json.id });
  assert.equal(ta.token_budget, 150000);
  assert.equal(ta.title, "Small part");
  assert.equal(ta.goal, "COORD-SMALL: write the small part.");
  assert.deepEqual((await ok("GET", `${R}/${b}`)).waits_for, [a]);

  // The first runs; the second starts only when the first is ready, and its budget stops it; the third never starts.
  const ra = await until("the first part", async () => {
    const t = await ok("GET", `${R}/${a}`);
    return ["ready", "failed", "stopped"].includes(t.state) ? t : null;
  });
  const textA = (await ok("GET", `${R}/${a}/transcript`)).map((l) => l.text).join("\n");
  assert.equal(ra.state, "ready", textA);
  assert.match(textA, /model 200/);
  assert.match(textA, new RegExp(`${owner}'s coordinator started the task`));
  const rb = await until("the second part", async () => {
    const t = await ok("GET", `${R}/${b}`);
    return ["ready", "failed", "stopped"].includes(t.state) ? t : null;
  });
  const textB = (await ok("GET", `${R}/${b}/transcript`)).map((l) => l.text).join("\n");
  assert.equal(rb.state, "failed", textB);
  assert.match(textB, /Queued: it starts when task #\d+ is ready\./);
  assert.match(rb.error, /The run's next model request could take it past its budget of 150k tokens/);
  assert.ok(Date.parse(rb.runs[0].started_at) >= Date.parse(ra.runs[0].ended_at));
  const rc = await until("the third part to be stopped", async () => {
    const t = await ok("GET", `${R}/${c}`);
    return t.state === "stopped" ? t : null;
  });
  assert.equal(rc.error, `Task #${b}, which this task waits for, failed.`);
  assert.deepEqual(rc.runs.map((r) => r.state), ["stopped"]);

  // An invalid batch is rejected whole: nothing is applied.
  const memoryBefore = (await ok("GET", `${P}/memory`)).version;
  const bad = await asPerson("POST", `${P}/posts`, { body: "BAD-BATCH: stop someone else's task." });
  assert.equal(bad.json.coordinator.task, coord);
  const badRun = await coordinatorRun({ task: coord, run: 2 });
  assert.equal(badRun.runs[1].state, "failed");
  assert.match(badRun.runs[1].error, /Its actions were rejected: stop\[0\] must be one of the tasks you may stop\. Nothing was applied\./);
  const afterBad = await ok("GET", `${P}/posts?after=${bad.json.id}`);
  assert.ok(!afterBad.some((p) => p.kind === "coordinator"), "no reply was posted");
  assert.ok(afterBad.some((p) => p.body === `${owner}'s coordinator didn't finish handling post #${bad.json.id}: ${badRun.runs[1].error}`), JSON.stringify(afterBad));
  assert.equal((await ok("GET", `${P}/memory`)).version, memoryBefore);
  // It may only message tasks it started (their runs have a budget), never the person's own hand-started ones.
  const hand = await asPerson("POST", `${P}/posts`, { body: "MSG-HAND: nudge task one." });
  const handRun = await coordinatorRun({ task: coord, run: 3 });
  assert.match(handRun.runs[2].error, /messages\[0\]\.task must be one of the tasks you may message/);
  assert.equal((await ok("GET", `${R}/1`)).runs.length, 2, "task #1 got no new run");
  void hand;
  const own = await asPerson("POST", `${P}/posts`, { body: "MSG-OWN: follow up on your own task." });
  const ownRun = await coordinatorRun({ task: coord, run: 4 });
  assert.equal(ownRun.runs[3].state, "done", JSON.stringify(ownRun.runs[3]));
  void own;
  const followed = await until("the follow-up on the first part", async () => {
    const t = await ok("GET", `${R}/${a}`);
    return t.runs.length === 2 && !["queued", "boot", "install", "agent", "finish"].includes(t.runs[1].state) ? t : null;
  });
  assert.equal(followed.runs[1].kind, "message");
  assert.match(followed.runs[1].message, new RegExp(`^\\(From ${owner}'s coordinator, handling post #\\d+\\.\\)\\nCheck it again\\.$`));

  // A post can skip the coordinator, and be handed to it later, once.
  const quiet = await asPerson("POST", `${P}/posts`, { body: "Just a note.", coordinator: false });
  assert.equal(quiet.json.coordinator, null);
  assert.equal((await api("POST", `${P}/posts/${quiet.json.id}/handle`)).status, 403);
  const handled = await asPerson("POST", `${P}/posts/${quiet.json.id}/handle`);
  assert.equal(handled.status, 202, JSON.stringify(handled.json));
  assert.equal((await asPerson("POST", `${P}/posts/${quiet.json.id}/handle`)).status, 409);
  const third = await coordinatorRun({ task: coord, run: 5 });
  assert.equal(third.runs[4].state, "done");
  assert.ok((await ok("GET", `${P}/posts?after=${quiet.json.id}`)).some((p) => p.kind === "coordinator" && p.body === "Noted, nothing to do."));
  // A coordinator takes no messages and isn't retried.
  assert.equal((await asPerson("POST", `${R}/${coord}/messages`, { body: "hi" })).status, 409);

  // The board leaves the coordinator out; the pages show its work.
  const board = await ok("GET", P);
  assert.ok(!Object.values(board.board).flat().some((t) => t.number === coord));
  const page = await (await fetch(`${base}/${owner}/tasks-demo/project`)).text();
  assert.match(page, /Splitting it in three\./);
  assert.match(page, /badge purple">Coordinator/);
  assert.match(page, /The change to the memory/);
  assert.match(page, /<tr class="add"><td class="ln">\+<\/td><td class="code">MEMORY-BY-COORD/);
  assert.match(page, /Hand this to my coordinator/);
  assert.doesNotMatch(page, /Other coordinators here/, "your own coordinator isn't listed again");
  assert.equal((await fetch(`${base}/${owner}/tasks-demo/project/coordinator`)).status, 200);
  const taskPage = await (await fetch(`${base}/${owner}/tasks-demo/tasks/${a}`)).text();
  assert.match(taskPage, /coordinator started this task while handling/);

  // Turning it off: posts stay posts.
  assert.equal((await asPerson("DELETE", `${P}/coordinator`)).status, 204);
  assert.deepEqual(await ok("GET", `${P}/coordinator`), { enabled: false });
  const after = await asPerson("POST", `${P}/posts`, { body: "PLAN-THREE again" });
  assert.equal(after.json.coordinator, null);
  assert.equal((await asPerson("POST", `${P}/posts/${after.json.id}/handle`)).status, 422);
});

test("plan first: a read-only plan run, then approve, change or split the plan", async () => {
  const me = await ok("GET", "/user");
  const owner = me.login;
  const P = `/repos/${owner}/tasks-demo/diffinery/project`;
  const R = `/repos/${owner}/tasks-demo/diffinery/tasks`;
  const src = join(work, "src");
  writeFileSync(
    join(src, "plan.sh"),
    `p="$DIFFINERY_TASK_PROMPT"
case "$p" in
  *"You are the project coordinator"*)
    post=$(printf '%s\\n' "$p" | sed -n '/^--- post #/,/^--- end of post ---/p')
    case "$post" in
      *"Split the plan of task #"*"PLAN-V1-STEP"*) printf '%s\\n' '\`\`\`json' '{"reply": "Split it.", "tasks": [{"title": "Plan part one", "goal": "PLAN-PART-ONE: build step one."}]}' '\`\`\`' ;;
      *) printf '%s\\n' '\`\`\`json' '{"reply": "Noted."}' '\`\`\`' ;;
    esac ;;
  *"You are planning task"*)
    echo planned > should-not-land.txt
    git add -A && git commit -qm "plan run commit" && git push -q origin HEAD:refs/heads/plan-run-push 2>/dev/null && echo "PUSHED" >&2
    case "$p" in
      *"Your previous plan:"*"Use the KV store"*) printf '%s\\n' '## Plan' '1. PLAN-V2-STEP: write planned.txt, with the KV store.' ;;
      *) printf '%s\\n' '## Plan' '1. PLAN-V1-STEP: write planned.txt.' ;;
    esac ;;
  *"approved. Follow it:"*)
    printf '%s\\n' "$p" | sed -n '/^--- plan ---$/,/^--- end of plan ---$/p'
    echo built > planned.txt ;;
  *PLAN-PART-ONE*) echo part > part.txt ;;
  *) echo other > other.txt ;;
esac
`,
  );
  git(src, ["pull", "-q", "--rebase", "origin", "main"]);
  git(src, ["add", "plan.sh"]);
  git(src, ["commit", "-q", "-m", "plan script"]);
  git(src, ["push", "-q", "origin", "main"]);
  const settled = (n, what, fn = () => true) =>
    until(what, async () => {
      const t = await ok("GET", `${R}/${n}`);
      const last = t.runs.at(-1);
      return last && !["queued", "boot", "install", "agent", "finish"].includes(last.state) && fn(t) ? t : null;
    });
  const transcript = async (n) => (await ok("GET", `${R}/${n}/transcript`)).map((l) => l.text).join("\n");

  // A plan-first task's first run plans in a read-only sandbox: nothing it changes is pushed.
  assert.equal((await asPerson("POST", R, { goal: "x", runtime: "custom", command: "sh plan.sh", agent: "task-bot", plan_first: "yes" })).status, 422);
  const started = await asPerson("POST", R, { goal: "PLANNED-GOAL: write planned.txt", runtime: "custom", command: "sh plan.sh", agent: "task-bot", plan_first: true });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  const n = started.json.number;
  assert.equal(started.json.plan_first, true);
  assert.equal(started.json.plan_state, "planning");
  const planned = await settled(n, "the plan");
  const text1 = await transcript(n);
  assert.equal(planned.runs[0].kind, "plan");
  assert.equal(planned.runs[0].state, "done", text1);
  assert.equal(planned.state, "ready");
  assert.equal(planned.plan_state, "waiting");
  assert.match(planned.plan, /^## Plan\n1\. PLAN-V1-STEP: write planned\.txt\.$/);
  assert.equal(planned.pull_request, null);
  assert.match(text1, /Starting a read-only sandbox to plan on main as task-bot\./);
  assert.match(text1, /It plans first\./);
  assert.ok(!text1.includes("PUSHED"), "the plan run's push was refused");
  assert.equal(git(src, ["ls-remote", "origin", "refs/heads/plan-run-push", `refs/heads/${planned.branch}`]).trim(), "", "nothing was pushed");
  const board = await ok("GET", P);
  assert.ok(board.board.waiting.some((t) => t.number === n), "a plan waiting for approval waits on you");
  assert.ok((await ok("GET", `${P}/posts`)).some((p) => p.body === `Task #${n}'s plan needs approval.`));
  const page = await (await fetch(`${base}/${owner}/tasks-demo/tasks/${n}`)).text();
  assert.match(page, /PLAN-V1-STEP/);
  assert.match(page, /Approve plan/);

  // Asking for changes plans again, with the plan it replaces.
  assert.equal((await asPerson("POST", `${R}/${n}/messages`, { body: "Use the KV store" })).status, 201);
  const replanned = await settled(n, "the second plan", (t) => t.runs.length === 2);
  assert.equal(replanned.runs[1].kind, "plan");
  assert.equal(replanned.plan_state, "waiting");
  assert.match(replanned.plan, /PLAN-V2-STEP/);
  assert.match(await transcript(n), /Planning again with the changes asked for\./);

  // Approving starts the build run, which carries the approved plan; only a person in a browser may approve.
  assert.equal((await api("POST", `${R}/${n}/plan/approve`)).status, 403);
  const approved = await asPerson("POST", `${R}/${n}/plan/approve`);
  assert.equal(approved.status, 202, JSON.stringify(approved.json));
  assert.equal(approved.json.plan_state, "approved");
  assert.equal((await asPerson("POST", `${R}/${n}/plan/approve`)).status, 409);
  const built = await settled(n, "the build", (t) => t.runs.length === 3);
  const text3 = await transcript(n);
  assert.equal(built.runs[2].kind, "build");
  assert.equal(built.runs[2].state, "done", text3);
  assert.match(text3, /The plan is approved: building it\./);
  assert.match(text3, /^--- plan ---\n## Plan\n1\. PLAN-V2-STEP: write planned\.txt, with the KV store\.\n--- end of plan ---$/m);
  assert.ok(built.pull_request, "the build opened a pull request");
  assert.ok((await ok("GET", `${P}/posts`)).some((p) => p.body === `${owner} approved the plan of task #${n}.`));
  // A follow-up after approval is an ordinary run, still with the plan.
  assert.equal((await asPerson("POST", `${R}/${n}/messages`, { body: "One more thing" })).status, 201);
  const after = await settled(n, "the follow-up", (t) => t.runs.length === 4);
  assert.equal(after.runs[3].kind, "message");

  // A project can require plans: every task plans first, ticked or not, including ones coordinators start.
  assert.equal((await asPerson("PUT", `${P}/settings`, { plan_first: "always" })).status, 422);
  assert.equal((await asPerson("PUT", `${P}/settings`, { plan_first: "required" })).json.plan_first, "required");
  const forced = await asPerson("POST", R, { goal: "SPLIT-GOAL: a goal to split", runtime: "custom", command: "sh plan.sh", agent: "task-bot", plan_first: false });
  assert.equal(forced.status, 201, JSON.stringify(forced.json));
  const m = forced.json.number;
  assert.equal(forced.json.plan_first, true);
  await settled(m, "the plan to split", (t) => t.plan_state === "waiting");

  // Splitting hands the plan to the person's coordinator; the tasks it starts link back, and the task is done with.
  assert.equal((await asPerson("POST", `${R}/${m}/plan/split`)).status, 422, "no coordinator yet");
  const coord = await asPerson("PUT", `${P}/coordinator`, { agent: "task-bot", runtime: "custom", command: "sh plan.sh", accept: true });
  assert.equal(coord.status, 200, JSON.stringify(coord.json));
  assert.equal((await asPerson("POST", `${R}/${n}/plan/split`)).status, 409, "an approved plan can't be split");
  assert.equal((await api("POST", `${R}/${m}/plan/split`)).status, 403);
  const split = await asPerson("POST", `${R}/${m}/plan/split`);
  assert.equal(split.status, 202, JSON.stringify(split.json));
  assert.equal((await asPerson("POST", `${R}/${m}/plan/split`)).status, 409);
  const splitPost = (await ok("GET", `${P}/posts?after=${split.json.post - 1}`)).find((p) => p.id === split.json.post);
  assert.match(splitPost.body, new RegExp(`^Split the plan of task #${m} \\(SPLIT-GOAL: a goal to split\\) into tasks\\.`));
  assert.equal(splitPost.author.login, owner);
  const child = await until("the coordinator to split the plan", async () => {
    const posts = await ok("GET", `${P}/posts?after=${split.json.post}`);
    const ev = posts.find((p) => p.kind === "event" && p.body.startsWith(`${owner}'s coordinator started task`));
    return ev ? ev.task.number : null;
  });
  const c = await ok("GET", `${R}/${child}`);
  assert.equal(c.parent_task, m);
  assert.equal(c.title, "Plan part one");
  assert.equal(c.plan_first, true, "a coordinator's task plans first when the project requires it");
  const parent = await ok("GET", `${R}/${m}`);
  assert.equal(parent.plan_state, "split");
  assert.ok((await ok("GET", P)).board.idle.some((t) => t.number === m));
  const childPage = await (await fetch(`${base}/${owner}/tasks-demo/tasks/${child}`)).text();
  assert.match(childPage, new RegExp(`Split from the plan of <a href="[^"]*/tasks/${m}">task #${m}</a>`));
  await settled(child, "the child's plan", (t) => t.plan_state === "waiting");

  assert.equal((await asPerson("PUT", `${P}/settings`, { plan_first: "off" })).json.plan_first, "off");
  assert.equal((await asPerson("DELETE", `${P}/coordinator`)).status, 204);
});

test("best of N: attempts run side by side on their own branches, then one is picked", async () => {
  const me = await ok("GET", "/user");
  const owner = me.login;
  const P = `/repos/${owner}/tasks-demo/diffinery/project`;
  const R = `/repos/${owner}/tasks-demo/diffinery/tasks`;
  const src = join(work, "src");
  // Attempts get the same prompt; each claims a slot (in the test's work directory, which the jails share) and does
  // different work.
  const slots = join(work, "best-slots");
  mkdirSync(slots, { recursive: true });
  writeFileSync(
    join(src, "best.sh"),
    `p="$DIFFINERY_TASK_PROMPT"
case "$p" in
  *"New instructions from"*) echo follow > follow.txt; echo FOLLOWED-UP; exit 0 ;;
esac
tag=$(printf '%s\\n' "$p" | grep -o 'BEST-[a-z0-9]*' | head -1)
slot=0
for i in 1 2 3 4; do if mkdir "${slots}/$tag-$i" 2>/dev/null; then slot=$i; break; fi; done
case $slot in
  1) echo one > one.txt; echo SUMMARY-ONE-FILE ;;
  2) echo a > a.txt; echo b > b.txt; echo c > c.txt; echo SUMMARY-THREE-FILES ;;
  *) echo SLOT-FAIL; exit 3 ;;
esac
`,
  );
  git(src, ["pull", "-q", "--rebase", "origin", "main"]);
  git(src, ["add", "best.sh"]);
  git(src, ["commit", "-q", "-m", "best of N script"]);
  git(src, ["push", "-q", "origin", "main"]);
  const tag = `BEST-${randomBytes(6).toString("hex")}`;
  const start = { goal: `${tag}: try it three ways`, runtime: "custom", command: "sh best.sh", agent: "task-bot" };

  for (const bad of [0, 5, 1.5, "x"]) assert.equal((await asPerson("POST", R, { ...start, attempts: bad })).status, 422, String(bad));
  const started = await asPerson("POST", R, { ...start, attempts: 3 });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  const n = started.json.number;
  assert.equal(started.json.attempts, 3);
  assert.equal(started.json.pick_state, "running");
  assert.deepEqual(started.json.runs.map((r) => r.attempt), [1, 2, 3]);

  // They run together, each on its own branch; the task waits on you when the last one ends.
  const done = await until("the attempts", async () => {
    const t = await ok("GET", `${R}/${n}`);
    return !["running", "queued"].includes(t.state) ? t : null;
  });
  const text = (await ok("GET", `${R}/${n}/transcript`)).map((l) => l.text).join("\n");
  assert.equal(done.state, "ready", text);
  assert.equal(done.pick_state, "waiting");
  assert.equal(done.pull_request, null, "no pull request until a pick");
  assert.match(text, new RegExp(`Attempt 2 of 3, on ${done.branch}-a2\\.`));
  assert.ok((await ok("GET", P)).board.waiting.some((t) => t.number === n), "attempts to pick from wait on you");
  assert.ok((await ok("GET", `${P}/posts`)).some((p) => p.body === `Task #${n}'s 3 attempts are done: 2 of them pushed work to compare. Pick one.`));

  const attempts = await ok("GET", `${R}/${n}/attempts`);
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map((a) => a.branch), [done.branch, `${done.branch}-a2`, `${done.branch}-a3`]);
  const failed = attempts.find((a) => a.state === "failed");
  const one = attempts.find((a) => a.changes.files === 1);
  const three = attempts.find((a) => a.changes.files === 3);
  assert.ok(failed && one && three, JSON.stringify(attempts));
  assert.equal(failed.head_sha, null);
  assert.match(one.summary, /SUMMARY-ONE-FILE/);
  assert.match(three.summary, /SUMMARY-THREE-FILES/);
  assert.deepEqual(three.changes, { files: 3, additions: 3, deletions: 0 });
  for (const a of [one, three]) assert.equal(git(src, ["ls-remote", "origin", `refs/heads/${a.branch}`]).trim().split(/\s/)[0], a.head_sha);
  const page = await (await fetch(`${base}/${owner}/tasks-demo/tasks/${n}`)).text();
  assert.match(page, /<h2>Attempts<\/h2>/);
  assert.match(page, new RegExp(`/tasks/${n}/attempts/${three.attempt}/pick`));

  // Follow-ups wait for a pick; only the person who started it may pick, and only an attempt with work.
  assert.equal((await asPerson("POST", `${R}/${n}/messages`, { body: "go on" })).status, 409);
  assert.equal((await api("POST", `${R}/${n}/attempts/${three.attempt}/pick`)).status, 403);
  assert.equal((await asPerson("POST", `${R}/${n}/attempts/${failed.attempt}/pick`)).status, 422);
  assert.equal((await asPerson("POST", `${R}/${n}/attempts/9/pick`)).status, 404);
  const picked = await asPerson("POST", `${R}/${n}/attempts/${three.attempt}/pick`);
  assert.equal(picked.status, 202, JSON.stringify(picked.json));
  assert.equal(picked.json.picked_attempt, three.attempt);
  assert.equal(picked.json.pick_state, "picked");
  assert.equal(picked.json.branch, three.branch);
  assert.ok(picked.json.pull_request, "picking opens the pull request");
  const pr = await ok("GET", `/repos/${owner}/tasks-demo/pulls/${picked.json.pull_request.number}`);
  assert.equal(pr.head.ref, three.branch);
  assert.equal(git(src, ["ls-remote", "origin", `refs/heads/${one.branch}`]).trim(), "", "the other attempt's branch is deleted");
  assert.equal((await asPerson("POST", `${R}/${n}/attempts/${one.attempt}/pick`)).status, 409);
  assert.ok((await ok("GET", `${P}/posts`)).some((p) => p.body === `${owner} picked attempt ${three.attempt} of task #${n}.`));

  // Later runs build on the picked attempt.
  assert.equal((await asPerson("POST", `${R}/${n}/messages`, { body: "Add a follow file" })).status, 201);
  const next = await until("the follow-up", async () => {
    const t = await ok("GET", `${R}/${n}`);
    return t.runs.length === 4 && !["queued", "boot", "install", "agent", "finish"].includes(t.runs[3].state) ? t : null;
  });
  assert.equal(next.runs[3].state, "done");
  assert.equal(next.runs[3].attempt, undefined);
  assert.match((await ok("GET", `${R}/${n}/transcript`)).map((l) => l.text).join("\n"), new RegExp(`Starting a sandbox on ${three.branch} as task-bot\\.`));
  const files = (await ok("GET", `/repos/${owner}/tasks-demo/pulls/${pr.number}/files`)).map((f) => f.filename).sort();
  assert.deepEqual(files, ["a.txt", "b.txt", "c.txt", "follow.txt"]);
  for (let i = 1; i <= 4; i++) rmSync(`/tmp/${tag}-${i}`, { recursive: true, force: true });
});

test("verify and land: failing checks start a fix run, and an approved pull request lands", async () => {
  const me = await ok("GET", "/user");
  const owner = me.login;
  const P = `/repos/${owner}/tasks-demo/diffinery/project`;
  const R = `/repos/${owner}/tasks-demo/diffinery/tasks`;
  const REPO = `/repos/${owner}/tasks-demo`;
  const src = join(work, "src");
  writeFileSync(
    join(src, "verify.sh"),
    `p="$DIFFINERY_TASK_PROMPT"
case "$p" in
  *"Checks failed on pull request"*) printf '%s\\n' "$p" | grep -E '^(--- |New instructions from|CI-SAYS)' ; echo fixed > fixed.txt ;;
  *) echo work > verify.txt ;;
esac
`,
  );
  git(src, ["pull", "-q", "--rebase", "origin", "main"]);
  git(src, ["add", "verify.sh"]);
  git(src, ["commit", "-q", "-m", "verify script"]);
  git(src, ["push", "-q", "origin", "main"]);
  // An unprotected branch to land on: agents may have pull requests merged into it automatically, once a person approves.
  git(src, ["push", "-q", "origin", "main:refs/heads/release"]);

  const start = { goal: "VERIFY-GOAL: write verify.txt", runtime: "custom", command: "sh verify.sh", agent: "task-bot", base: "release" };
  assert.equal((await asPerson("POST", R, { ...start, land: "yes" })).status, 422);
  const started = await asPerson("POST", R, { ...start, land: true });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  const n = started.json.number;
  assert.equal(started.json.fix_checks, true, "on by default");
  assert.equal(started.json.land, true);
  const ready = await until("the task's pull request", async () => {
    const t = await ok("GET", `${R}/${n}`);
    return t.state !== "running" && t.state !== "queued" ? t : null;
  });
  assert.equal(ready.state, "ready", JSON.stringify(ready));
  const pr = ready.pull_request.number;
  assert.match((await ok("GET", `${R}/${n}/transcript`)).map((l) => l.text).join("\n"), new RegExp(`Auto-merge is on for #${pr}: it lands once a person approves it and its checks pass\\.`));
  const pull = await ok("GET", `${REPO}/pulls/${pr}`);
  assert.ok(pull.auto_merge, "auto-merge is on");
  assert.equal(pull.merged, false, "not without a person's approval");

  // A failing check on the head starts one fix run, with what the check said.
  const head = pull.head.sha;
  await ok("POST", `${REPO}/statuses/${head}`, { state: "failure", context: "ci/verify", description: "CI-SAYS: verify.txt is wrong" });
  const fixing = await until("the fix run", async () => {
    const t = await ok("GET", `${R}/${n}`);
    return t.runs.length === 2 && !["queued", "boot", "install", "agent", "finish"].includes(t.runs[1].state) ? t : null;
  });
  const text = (await ok("GET", `${R}/${n}/transcript`)).map((l) => l.text).join("\n");
  assert.equal(fixing.runs[1].kind, "fix");
  assert.equal(fixing.runs[1].state, "done", text);
  assert.equal(fixing.check_fixes, 1);
  assert.match(text, /^--- ci\/verify: failure ---$/m);
  assert.match(text, /^CI-SAYS: verify\.txt is wrong$/m);
  assert.match(text, /^New instructions from Diffinery \(the pull request's checks failed\):$/m);
  assert.ok((await ok("GET", `${P}/posts`)).some((p) => p.body === `Task #${n}'s pull request #${pr} failed checks; starting fix run 1 of 3.`));
  const fixedHead = (await ok("GET", `${REPO}/pulls/${pr}`)).head.sha;
  assert.notEqual(fixedHead, head);
  // The same failure reported again on the old head starts nothing more.
  await ok("POST", `${REPO}/statuses/${head}`, { state: "failure", context: "ci/other" });
  await ok("POST", `${REPO}/statuses/${fixedHead}`, { state: "success", context: "ci/verify" });
  await sleep(3000);
  assert.equal((await ok("GET", `${R}/${n}`)).runs.length, 2);

  // Options: only the person who started it, in a browser.
  assert.equal((await api("PATCH", `${R}/${n}`, { land: false })).status, 403);
  assert.equal((await asPerson("PATCH", `${R}/${n}`, { fix_checks: "no" })).status, 422);
  const off = await asPerson("PATCH", `${R}/${n}`, { fix_checks: false });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.equal(off.json.fix_checks, false);
  assert.match(await (await fetch(`${base}/${owner}/tasks-demo/tasks/${n}`)).text(), /<h2>Verify and land<\/h2>/);

  // A person approves: it lands by itself.
  const review = await api("POST", `${REPO}/pulls/${pr}/reviews`, { event: "APPROVE", commit_id: fixedHead });
  assert.ok(review.status < 300, JSON.stringify(review.json));
  const merged = await until("the pull request to land", async () => {
    const p = await ok("GET", `${REPO}/pulls/${pr}`);
    return p.merged ? p : null;
  });
  assert.equal(merged.merged, true);
  assert.ok((await ok("GET", P)).board.done.some((t) => t.number === n), "a landed task is done");
});

test("organizations: an agent policy, model keys only owners hold, and whose key pays (phase 5b)", async () => {
  const me = await ok("GET", "/user");
  const owner = me.login;
  const ORG = "acme-agents";
  const O = `/orgs/${ORG}/diffinery`;
  const ORG_KEY = `sk-ant-api03-${randomBytes(30).toString("hex")}`;
  const RIVAL_KEY = `sk-ant-api03-${randomBytes(30).toString("hex")}`;
  const rivalCookie = `__Host-dfy_session=${RIVAL_SESSION}`;
  const asRival = async (method, path, body) => {
    const res = await fetch(`${base}/api/v3${path}`, { method, headers: { cookie: rivalCookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };
  // A run's request through the model proxy, with its token, as the agent's CLI would send it.
  const proxyBody = (tok, body) => fetch(`${base}/-/model/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": tok, "content-type": "application/json" }, body });
  const proxy = (tok, max = 100) => proxyBody(tok, JSON.stringify({ model: "m", max_tokens: max, messages: [] }));
  // A web form, as the owner in their browser.
  const form = async (page, action, fields) => {
    const res = await fetch(`${base}${page}`);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await res.text())?.[1];
    const cookie = /dfy_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    return fetch(`${base}${action}`, { method: "POST", redirect: "manual", headers: { cookie: `dfy_csrf=${cookie}`, "sec-fetch-site": "same-origin" }, body: new URLSearchParams([["_csrf", csrf ?? ""], ...fields]) });
  };
  const runToken = (file) => jailToken(join(work, file));
  const stopped = (R, n) =>
    until(`task #${n} to stop`, async () => {
      const t = await ok("GET", `${R}/${n}`);
      return t.state !== "running" && t.state !== "queued" ? t : null;
    });

  await ok("POST", "/user/orgs", { login: ORG });
  await ok("POST", `/orgs/${ORG}/repos`, { name: "org-tasks" });
  const src = join(work, "org-src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "README.md"), "# org tasks\n");
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "initial"]);
  git(src, ["remote", "add", "origin", `${base}/${ORG}/org-tasks.git`]);
  git(src, ["push", "-q", "origin", "main"]);
  assert.equal((await asPerson("PUT", "/diffinery/model-keys/anthropic", { key: ANTHROPIC_KEY, accept_terms: true })).status, 200);
  assert.equal((await asPerson("POST", "/diffinery/agents", { login: "org-bot" })).status, 201);

  // Nothing changes until an owner sets something; only owners see it, and never with a repository-limited token.
  assert.deepEqual(await ok("GET", `${O}/agent-policy`), { keys: "personal", runtimes: ["claude-code", "codex", "custom"], providers: ["anthropic", "openai", "openrouter"], max_running: 10, terminals: true, terminal_tasks: true, review: true, member_monthly_tokens: null, updated_by: null, updated_at: null });
  assert.equal((await asRival("GET", `${O}/agent-policy`)).status, 404, "not a member");
  const limited = (await asPerson("POST", "/diffinery/tokens", { name: "org-limited", scopes: ["admin"], repositories: [`${ORG}/org-tasks`] })).json.token;
  for (const path of ["agent-policy", "model-keys", "model-usage"]) assert.equal((await api("GET", `${O}/${path}`, undefined, limited)).status, 403, path);

  // The organization's key: an owner in a browser, accepting the terms for it; never shown again.
  const viaToken = await api("PUT", `${O}/model-keys/anthropic`, { key: ORG_KEY, accept_terms: true });
  assert.equal(viaToken.status, 403, JSON.stringify(viaToken.json));
  assert.equal((await asPerson("PUT", `${O}/model-keys/anthropic`, { key: ORG_KEY })).status, 422);
  const saved = await asPerson("PUT", `${O}/model-keys/anthropic`, { key: ORG_KEY, accept_terms: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.hint, ORG_KEY.slice(-4));
  assert.equal(saved.json.opted_in_by, owner);
  const keys = await ok("GET", `${O}/model-keys`);
  assert.deepEqual(keys.map((k) => k.provider), ["anthropic"]);
  assert.ok(!JSON.stringify(keys).includes(ORG_KEY));
  assert.ok(!(await ok("GET", "/diffinery/model-keys")).some((k) => k.hint === ORG_KEY.slice(-4)), "a person's keys are their own");

  // The policy: owners in a browser.
  assert.equal((await api("PUT", `${O}/agent-policy`, { keys: "organization" })).status, 403, "a token can't change it");
  assert.equal((await asPerson("PUT", `${O}/agent-policy`, { max_running: 11 })).status, 422);
  const policy = await asPerson("PUT", `${O}/agent-policy`, { keys: "organization", runtimes: ["claude-code", "custom"], max_running: 2, member_monthly_tokens: 10000 });
  assert.equal(policy.status, 200, JSON.stringify(policy.json));
  assert.equal(policy.json.updated_by, owner);
  // Its repositories' "tasks at once" is held to it.
  await until("the organization's limit to reach the project", async () => (await ok("GET", `/repos/${ORG}/org-tasks/diffinery/project`)).settings.org_max_running === 2);

  const R = `/repos/${ORG}/org-tasks/diffinery/tasks`;
  const codex = await asPerson("POST", R, { goal: "Not allowed", runtime: "codex", agent: "org-bot" });
  assert.equal(codex.status, 403, JSON.stringify(codex.json));
  assert.match(codex.json.message, /acme-agents's agent policy doesn't allow Codex/);

  // An owner's task runs on the organization's key, which the provider gets and the sandbox never sees.
  const started = await asPerson("POST", R, { goal: "On the organization's key", runtime: "custom", command: `printf %s "$ANTHROPIC_API_KEY" > ${join(work, "org-token")}; echo "key is $ANTHROPIC_API_KEY"; sleep 120`, agent: "org-bot" });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  assert.equal(started.json.paid_by, "organization");
  const n1 = started.json.number;
  const t1 = await runToken("org-token");
  assert.match(t1, /^dmt_/);
  const sent = modelRequests.length;
  const first = await proxy(t1);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(modelRequests.length, sent + 1);
  assert.equal(modelRequests.at(-1).headers["x-api-key"], ORG_KEY);
  // The month's count settles to what the answer used: 21 + 4 + 300 cache reads at a tenth.
  const month = await until("the month's count", async () => {
    const u = await ok("GET", `${O}/model-usage`);
    return u.month.people.find((p) => p.person === owner && p.tokens === 55) ? u : null;
  });
  assert.equal(month.month.member_monthly_tokens, 10000);
  // A request that could take the person past the allowance never reaches the provider, and the task stops.
  const over = await proxy(t1, 20000);
  assert.equal(over.status, 403);
  assert.match((await over.json()).error.message, /allowance of 10,000 tokens per person on acme-agents's keys is used up/);
  assert.equal(modelRequests.length, sent + 1);
  assert.equal((await stopped(R, n1)).state, "stopped");
  const lines = (await ok("GET", `${R}/${n1}/transcript`)).map((l) => l.text).join("\n");
  assert.match(lines, /Stopped: this month's allowance/);
  assert.ok(!lines.includes(ORG_KEY));
  // The run is the organization's to see, not in the owner's own 30 days.
  const orgReport = await until("the organization's report", async () => {
    const u = await ok("GET", `${O}/model-usage`);
    return u.repositories.find((x) => x.repository === `${ORG}/org-tasks`) ? u : null;
  });
  assert.deepEqual(orgReport.repositories[0], { repository: `${ORG}/org-tasks`, kind: "task", runs: 1, reported_by_cli_runs: 0, requests: 1, input_tokens: 21, output_tokens: 4, cache_read_tokens: 300, cache_write_tokens: 0, cost_usd: null, person: owner });
  assert.ok(!(await ok("GET", "/diffinery/model-usage")).repositories.some((x) => x.repository === `${ORG}/org-tasks`));

  // Someone outside the organization, with write access, their own agent and their own key.
  await ok("PUT", `/repos/${ORG}/org-tasks/collaborators/rival`, { permission: "push" });
  const inv = (await asRival("GET", "/user/repository_invitations")).json.find((i) => i.repository.full_name === `${ORG}/org-tasks`);
  assert.equal((await asRival("PATCH", `/user/repository_invitations/${inv.id}`)).status, 204);
  assert.equal((await asRival("PUT", "/diffinery/model-keys/anthropic", { key: RIVAL_KEY, accept_terms: true })).status, 200);
  assert.equal((await asRival("POST", "/diffinery/agents", { login: "rival-bot" })).status, 201);
  const outside = await asRival("POST", R, { goal: "Outside", runtime: "custom", command: "true", agent: "rival-bot" });
  assert.equal(outside.status, 403, JSON.stringify(outside.json));
  assert.match(outside.json.message, /only its members can use/);
  // Under `either`, they pay with their own key.
  assert.equal((await asPerson("PUT", `${O}/agent-policy`, { keys: "either", member_monthly_tokens: null })).status, 200);
  const own = await asRival("POST", R, { goal: "Own key", runtime: "custom", command: `printf %s "$ANTHROPIC_API_KEY" > ${join(work, "rival-token")}; sleep 120`, agent: "rival-bot" });
  assert.equal(own.status, 201, JSON.stringify(own.json));
  assert.equal(own.json.paid_by, "person");
  const t2 = await runToken("rival-token");
  assert.equal((await proxy(t2)).status, 200);
  assert.equal(modelRequests.at(-1).headers["x-api-key"], RIVAL_KEY);
  // On their own key, a request goes as they sent it.
  assert.equal((await proxyBody(t2, '{"model":"m","background":true,"messages":[]}')).status, 200);
  assert.deepEqual(JSON.parse(modelRequests.at(-1).body), { model: "m", background: true, messages: [] });
  assert.equal((await asRival("POST", `${R}/${own.json.number}/stop`)).status, 200);

  // Once a member, their task runs on the organization's key, until they're removed: the next request is refused.
  const invited = await form(`/${ORG}?tab=people`, `/${ORG}/-/org/people`, [["who", "rival"], ["role", "member"]]);
  assert.equal(invited.status, 303);
  assert.equal((await asRival("PATCH", `/user/memberships/orgs/${ORG}`, { state: "active" })).status, 200);
  const member = await asRival("POST", R, { goal: "As a member", runtime: "custom", command: `printf %s "$ANTHROPIC_API_KEY" > ${join(work, "member-token")}; sleep 120`, agent: "rival-bot" });
  assert.equal(member.status, 201, JSON.stringify(member.json));
  assert.equal(member.json.paid_by, "organization");
  const t3 = await runToken("member-token");
  assert.equal((await proxy(t3)).status, 200);
  assert.equal(modelRequests.at(-1).headers["x-api-key"], ORG_KEY);
  // On the organization's key, a run sends only what its booking bounds (Security M1): no background responses,
  // stored context or several answers, and its output capped as booked.
  const sentBefore = modelRequests.length;
  const background = await proxyBody(t3, '{"model":"m","max_tokens":100,"background":true,"messages":[]}');
  assert.equal(background.status, 403);
  assert.match((await background.json()).error.message, /background responses aren't available to agent reviews, runs with a token budget and runs on an organization's key/);
  assert.equal((await proxyBody(t3, '{"model":"m","max_tokens":100,"n":3,"messages":[]}')).status, 403);
  // Nor input the request doesn't carry (Security's re-check): a PDF by URL, a stored item, a body that isn't JSON.
  const byUrl = await proxyBody(t3, JSON.stringify({ model: "m", max_tokens: 16, messages: [{ role: "user", content: [{ type: "document", source: { type: "url", url: "https://example.com/big.pdf" } }] }] }));
  assert.equal(byUrl.status, 403);
  assert.match((await byUrl.json()).error.message, /^inputs given by URL aren't available to agent reviews, runs with a token budget and runs on an organization's key/);
  assert.equal((await proxyBody(t3, '{"model":"m","max_tokens":16,"background":"true","messages":[]}')).status, 403);
  assert.equal((await proxyBody(t3, '{"model":"m","max_tokens":16,"temperature":NaN,"messages":[]}')).status, 403);
  assert.equal(modelRequests.length, sentBefore);
  // Its tools that run on the provider are stripped; those the agent runs stay.
  assert.equal((await proxyBody(t3, JSON.stringify({ model: "m", messages: [], tools: [{ name: "Read", input_schema: {} }, { type: "web_fetch_20250910", name: "web_fetch" }] }))).status, 200);
  assert.deepEqual(JSON.parse(modelRequests.at(-1).body), { model: "m", messages: [], tools: [{ name: "Read", input_schema: {} }], max_tokens: 32000 });
  // An absurd cap books a bounded estimate (Security S2): the month's count stays exact, here 3 answers of 55.
  assert.equal((await proxyBody(t3, '{"model":"m","max_tokens":1e300,"messages":[]}')).status, 200);
  assert.equal(JSON.parse(modelRequests.at(-1).body).max_tokens, 1000000);
  await until("the member's exact count", async () => (await ok("GET", `${O}/model-usage`)).month.people.find((p) => p.person === "rival" && p.tokens === 165));
  // Under an allowance, a person has at most 4 requests on the organization's keys on their way at once (Security's third
  // look: images and PDFs bill past their booking, so this bounds the overshoot); a fifth is told to try again.
  assert.equal((await asPerson("PUT", `${O}/agent-policy`, { member_monthly_tokens: 1_000_000 })).status, 200);
  const slow = await Promise.all([1, 2, 3, 4, 5].map((i) => proxyBody(t3, JSON.stringify({ model: "m", max_tokens: 10, metadata: { user_id: "slow" }, messages: [{ role: "user", content: `slow ${i}` }] }))));
  assert.deepEqual(slow.map((r) => r.status).sort(), [200, 200, 200, 200, 429]);
  const fifth = slow.find((r) => r.status === 429);
  assert.equal(fifth.headers.get("retry-after"), "5");
  assert.match((await fifth.json()).error.message, /4 of your model requests on acme-agents's keys are already on their way/);
  // Once they are answered, the slots are free again.
  await until("the slots to free up", async () => (await proxy(t3)).status === 200);
  // A request whose sandbox hangs up while the provider is still answering is settled anyway, and frees its slot
  // (Security's fourth look): the next 4 at once all go through.
  const hangUp = new AbortController();
  const dropped = fetch(`${base}/-/model/anthropic/v1/messages`, { method: "POST", signal: hangUp.signal, headers: { "x-api-key": t3, "content-type": "application/json" }, body: JSON.stringify({ model: "m", max_tokens: 10, metadata: { user_id: "slow" }, messages: [] }) }).catch(() => null);
  await sleep(1000);
  hangUp.abort();
  await dropped;
  await sleep(4000);
  const after4 = await Promise.all([1, 2, 3, 4].map(() => proxyBody(t3, JSON.stringify({ model: "m", max_tokens: 10, metadata: { user_id: "slow" }, messages: [] }))));
  assert.deepEqual(after4.map((r) => r.status), [200, 200, 200, 200]);
  assert.equal((await asPerson("PUT", `${O}/agent-policy`, { member_monthly_tokens: null })).status, 200);
  const removed = await form(`/${ORG}?tab=people`, `/${ORG}/-/org/members`, [["login", "rival"], ["role", "remove"]]);
  assert.equal(removed.status, 303);
  // Removal also takes away their grants on its repositories; with write access given back as an outside
  // collaborator, they can still run the task, but not on the organization's key.
  await ok("PUT", `/repos/${ORG}/org-tasks/collaborators/rival`, { permission: "push" });
  const again = (await asRival("GET", "/user/repository_invitations")).json.find((i) => i.repository.full_name === `${ORG}/org-tasks`);
  if (again) assert.equal((await asRival("PATCH", `/user/repository_invitations/${again.id}`)).status, 204);
  const before = modelRequests.length;
  const refused = await proxy(t3);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error.message, /rival is no longer a member of acme-agents, whose key this task uses/);
  assert.equal(modelRequests.length, before);
  assert.equal((await stopped(R, member.json.number)).state, "stopped");
  // Retrying it isn't theirs to pay with the organization's key any more.
  const retry = await asRival("POST", `${R}/${member.json.number}/retry`);
  assert.equal(retry.status, 403, JSON.stringify(retry.json));
  assert.match(retry.json.message, /only members of acme-agents can run agents on its keys/);

  // The Settings tab: owners see the policy, the key's last four characters and the usage; nobody sees the key.
  const page = await (await fetch(`${base}/${ORG}?tab=settings`)).text();
  assert.match(page, /Agent policy/);
  assert.ok(page.includes(`…${ORG_KEY.slice(-4)}`));
  assert.ok(!page.includes(ORG_KEY));
  assert.match(page, /Paid with the organization/);
  assert.equal((await fetch(`${base}/${ORG}?tab=settings`, { headers: { cookie: rivalCookie } })).status, 403);
  // Its form saves the policy (Kumo checkboxes send only what's ticked).
  const savedForm = await form(`/${ORG}?tab=settings`, `/${ORG}/-/org/agent-policy`, [
    ["keys", "personal"],
    ["runtimes", "claude-code"],
    ["runtimes", "custom"],
    ["providers", "anthropic"],
    ["max_running", "3"],
    ["terminal_tasks", "1"],
    ["review", "1"],
    ["member_monthly_tokens", ""],
  ]);
  assert.equal(savedForm.status, 303);
  assert.deepEqual(await ok("GET", `${O}/agent-policy`), { ...(await ok("GET", `${O}/agent-policy`)), keys: "personal", runtimes: ["claude-code", "custom"], providers: ["anthropic"], max_running: 3, terminals: false, terminal_tasks: true, review: true, member_monthly_tokens: null });
  // Deleting the key.
  assert.equal((await asPerson("DELETE", `${O}/model-keys/anthropic`)).status, 204);
  assert.deepEqual(await ok("GET", `${O}/model-keys`), []);
});

test("losing access to the agent stops the task", async () => {
  const me = await ok("GET", "/user");
  const owner = me.login;
  const R = `/repos/${owner}/tasks-demo/diffinery/tasks`;
  const tokFile = join(work, "model-token-3");
  const started = await asPerson("POST", R, { goal: "Lose access", runtime: "custom", command: `printf %s "$ANTHROPIC_API_KEY" > ${tokFile}; sleep 120`, agent: "task-bot" });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  const n = started.json.number;
  const runToken = await jailToken(tokFile);
  // Disabling the agent ends its access, and with it the task's.
  assert.equal((await api("DELETE", "/diffinery/agents/task-bot")).status, 204);
  const refused = await fetch(`${base}/-/model/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": runToken, "content-type": "application/json" }, body: "{}" });
  assert.equal(refused.status, 403);
  const t = await until("the task to stop", async () => {
    const x = await ok("GET", `${R}/${n}`);
    return x.state !== "running" ? x : null;
  });
  assert.equal(t.state, "stopped");
  assert.equal((await fetch(`${base}/-/model/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": runToken }, body: "{}" })).status, 401);
});
