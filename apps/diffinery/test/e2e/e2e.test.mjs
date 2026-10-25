// End-to-end: a real `wrangler dev` Worker, the real git CLI and the real runner agent.
//
//   pnpm --filter @diffinery/runner build && pnpm --filter @diffinery/app e2e
//
// Covers: token auth, repo creation, git push/clone/fetch (protocol v2), push
// protection, workflows triggered by push and pull_request and executed by a
// self-hosted runner (the same agent that runs in Cloudflare Containers),
// check runs, branch protection with required checks and human review for
// agent-authored PRs, merging, the REST contents API, the MCP server and
// profile pictures (WASM image processing in the Worker).
import "./fresh-connections.mjs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { fakeGitHub, lfsObject } from "./fake-github.mjs";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AGENT = resolve(APP, "../../containers/runner/dist/agent.mjs");
const work = mkdtempSync(join(tmpdir(), "diffinery-e2e-"));
let base;
/** The shared server's Worker itself, behind wrangler dev's proxy (see startServer). */
let direct;
// The dev server writes to a file, not a pipe: a long synchronous git command keeps this process
// from reading a pipe, and a full one (retried webhooks log a stack each) stalls the server mid-push.
const devLogFile = join(work, "wrangler.log");
const devLog = () => (existsSync(devLogFile) ? readFileSync(devLogFile, "utf8") : "");
let token;
let agentToken;

async function api(method, path, body, tok = token) {
  const send = () =>
    fetch(`${base}/api/v3${path}`, {
      method,
      headers: { ...(tok === null ? {} : { authorization: `Bearer ${tok}` }), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // After minutes of git traffic alone, the kept-alive connection from the last API call may have
  // been closed by the dev server just as it is reused ("other side closed"): a GET is sent again.
  let res;
  for (let i = 0; ; i++) {
    try {
      res = await send();
      break;
    } catch (e) {
      if (method !== "GET" || i >= 2) throw new Error(`${method} ${path}: ${e.message} (${e.cause?.code ?? e.cause})\n--- wrangler log tail ---\n${devLog().slice(-3000)}`);
      await sleep(1000);
    }
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/**
 * Claim a waiting self-hosted job as a registered runner offering `labels`, the way `diffinery runner`
 * does (personal tokens can't claim jobs): one runner per repository and set of labels.
 */
const e2eRunners = new Map();
async function runnerClaim(repoPath, labels = ["linux"]) {
  const key = `${repoPath} ${labels.join(",")}`;
  if (!e2eRunners.has(key)) {
    const reg = await api("POST", `${repoPath}/actions/runners/registration-token`);
    assert.equal(reg.status, 201, JSON.stringify(reg.json));
    const runner = await api("POST", `${repoPath}/actions/runners/register`, { registration_token: reg.json.token, name: `e2e-runner-${e2eRunners.size + 1}`, labels });
    assert.equal(runner.status, 201, JSON.stringify(runner.json));
    e2eRunners.set(key, runner.json.token);
  }
  const r = await api("POST", `${repoPath}/actions/runners/claim`, {}, e2eRunners.get(key));
  // A repository deleted and created again under the same name needs a new runner.
  if (r.status !== 401) return r;
  e2eRunners.delete(key);
  return runnerClaim(repoPath, labels);
}
async function ok(method, path, body, tok) {
  const r = await api(method, path, body, tok);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

function git(cwd, args, tok = token, opts = {}) {
  const auth = Buffer.from(`x-token:${tok}`).toString("base64");
  try {
    return execFileSync("git", ["-c", `http.extraHeader=Authorization: Basic ${auth}`, "-c", "protocol.version=2", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "E2E", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "E2E", GIT_COMMITTER_EMAIL: "e2e@example.com" },
      ...opts,
    });
  } catch (e) {
    // What the server said, for a git command that wasn't meant to fail (gitFails reads stderr, not this).
    if (/HTTP 5\d\d/.test(e.stderr ?? "")) e.message += `\n--- wrangler log tail ---\n${devLog().slice(-4000)}`;
    throw e;
  }
}
function gitFails(cwd, args, tok) {
  try {
    git(cwd, args, tok);
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.fail(`expected git ${args.join(" ")} to fail`);
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
  assert.fail(`timed out waiting for ${what}\n--- wrangler log tail ---\n${devLog().slice(-4000)}`);
}

function spawnAsync(cmd, args, env, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (status) => {
      clearTimeout(t);
      done({ status, stdout, stderr });
    });
  });
}

/**
 * Claim one waiting self-hosted job and run it with the real agent.
 * `envFor(claim)` adds environment for the agent (e.g. HOME, DIFFINERY_DISABLE_BUILTINS).
 */
async function runOneJob(owner, repo, { allowFailure = false, envFor = () => ({}), timeoutMs = 180_000, labels = ["linux"] } = {}) {
  const claim = await until("a job to claim", async () => {
    const r = await runnerClaim(`/repos/${owner}/${repo}`, labels);
    return r.status === 200 ? r.json : null;
  });
  const jobEnv = { ...envFor(claim), DIFFINERY_API_URL: claim.api_url, DIFFINERY_JOB_ID: claim.job_id, DIFFINERY_JOB_TOKEN: claim.token };
  // E2E_RUNNER_IMAGE runs the job inside the real runner image instead of the local agent bundle.
  const image = process.env.E2E_RUNNER_IMAGE;
  // Spawned asynchronously: a blocked event loop leaves undici holding keep-alive sockets the server already closed.
  const r = image
    ? await spawnAsync("docker", ["run", "--rm", "--network", "host", ...Object.entries(jobEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]), image], {}, timeoutMs + 120_000)
    : await spawnAsync(process.execPath, [AGENT], { ...process.env, ...jobEnv, DIFFINERY_WORK_ROOT: join(work, `job-${claim.job_id}`) }, timeoutMs);
  const out = `${r.stdout}${r.stderr}`;
  if (r.status !== 0 && !allowFailure) {
    const log = await fetch(`${base}/api/v3/repos/${owner}/${repo}/actions/jobs/${claim.job_id}/logs`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.text(), (e) => String(e));
    const job = await api("GET", `/repos/${owner}/${repo}/actions/jobs/${claim.job_id}`).catch((e) => ({ json: String(e) }));
    assert.fail(`runner agent exited ${r.status}:\n${out}\n--- job ---\n${JSON.stringify(job.json, null, 2)}\n--- job log ---\n${log}\n--- wrangler log tail ---\n${devLog().slice(-3000)}`);
  }
  return { claim, out };
}

/**
 * A `wrangler dev` server of its own with an admin token. Most tests share the one before() starts;
 * the real histories each push to their own, so they run side by side on separate processes.
 */
const servers = [];
/** `restart`: start again on the state a stopped server of the same name left. */
async function startServer(name = "", { restart = false } = {}) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const persist = join(work, name ? `state-${name}` : "state");
  const logFile = name ? join(work, `wrangler-${name}.log`) : devLogFile;
  const debugLogFile = join(work, name ? `wrangler-debug-${name}.log` : "wrangler-debug.log");
  const log = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");
  if (!restart) migratedState(APP, persist);
  // Until the web UI exists, run the same app through the API-only entry.
  const entry = existsSync(join(APP, "src/web/routes.tsx")) ? [] : ["test/e2e/entry.ts"];
  const out = openSync(logFile, "a");
  const child = spawn("pnpm", ["exec", "wrangler", "dev", ...entry, "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${url}`, "--var", `MASTER_KEY:${randomBytes(32).toString("base64")}`, "--var", "SCHEDULE_TICK_MINUTES:1", "--show-interactive-dev-session=false"], {
    cwd: APP,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: debugLogFile },
    stdio: ["ignore", out, out],
    detached: true,
  });
  servers.push(child);
  const end = Date.now() + 120_000;
  while (!(await fetch(`${url}/healthz`).then((r) => r.ok, () => false))) {
    if (Date.now() > end) assert.fail(`timed out waiting for wrangler dev${name ? ` (${name})` : ""}\n--- wrangler log tail ---\n${log().slice(-4000)}`);
    await sleep(500);
  }
  // DEV_AUTH signs requests without credentials in as dev@diffinery.local; mint a real token for everything else.
  const res = await fetch(`${url}/api/v3/diffinery/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "e2e", scopes: ["admin"] }) });
  assert.equal(res.status, 201, await res.clone().text());
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  };
  return { base: url, direct: workerUrl(debugLogFile), workerUrl: () => workerUrl(debugLogFile), token: (await res.json()).token, log, stop };
}

/**
 * wrangler dev answers on `base` through a proxy Worker of its own, which drops one of several large
 * pushes streaming through it at once ("Error inside ProxyWorker ... Network connection lost": the
 * push never reaches our Worker; 3 of 5 runs of three pushes, none of 5 sent to the Worker itself).
 * Its debug log names the Worker's own address; null if it doesn't.
 */
function workerUrl(debugLogFile) {
  const log = existsSync(debugLogFile) ? readFileSync(debugLogFile, "utf8") : "";
  const at = [...log.matchAll(/"userWorkerUrl":\{"protocol":"(https?:)","hostname":"([^"]+)","port":"(\d+)"/g)].pop();
  return at ? `${at[1]}//${at[2]}:${at[3]}` : null;
}

before(async () => {
  assert.ok(existsSync(AGENT), `build the runner first: pnpm --filter @diffinery/runner build (missing ${AGENT})`);
  ({ base, direct, token } = await startServer());
});

after(() => {
  for (const dev of servers) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  }
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
});

// Scheduled workflows: the dev environment has no cron trigger, like a deploy whose cron trigger
// hasn't been applied yet, so schedules must fire from the scheduler's own alarm. The schedule is
// registered first and checked by the last test, so its ticks (1 minute here) come while the rest runs.
let tickRepo;
test("scheduled workflows: a push to the default branch registers the schedule", async () => {
  const me = await ok("GET", "/user");
  tickRepo = `${me.login}/schedules`;
  await ok("POST", "/user/repos", { name: "schedules" });
  const src = join(work, "schedules");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  writeFileSync(join(src, ".github/workflows/tick.yml"), `on:\n  schedule:\n    - cron: "* * * * *"\njobs:\n  tick:\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: echo tick\n`);
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "schedule"]);
  git(src, ["push", "-q", `${base}/${tickRepo}.git`, "main"]);
});

test("git hosting, Actions, protected PR flow and MCP", async () => {
  const me = await ok("GET", "/user");
  const owner = me.login;
  assert.ok(me.site_admin, "dev user is a bootstrap admin");

  // ------------------------------------------------------------ repo + first push
  const repo = await ok("POST", "/user/repos", { name: "demo", description: "e2e" });
  assert.equal(repo.full_name, `${owner}/demo`);
  const src = join(work, "src");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  writeFileSync(join(src, "README.md"), "# demo\n");
  writeFileSync(join(src, "app.txt"), "one\ntwo\nthree\n");
  writeFileSync(
    join(src, ".github/workflows/ci.yml"),
    `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  build:
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@v4
      - name: Check files
        run: |
          test -f README.md
          echo "event=\${{ github.event_name }} sha=\${{ github.sha }}"
          grep -q bad app.txt && { echo "found bad line"; exit 1; } || true
      - id: out
        run: echo "lines=$(wc -l < app.txt | tr -d ' ')" >> "$GITHUB_OUTPUT"
      - run: echo "app.txt has \${{ steps.out.outputs.lines }} lines"
`,
  );
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "initial"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/demo.git`]);
  git(src, ["push", "-q", "origin", "main"]);
  const mainSha = git(src, ["rev-parse", "HEAD"]).trim();

  const branch = await ok("GET", `/repos/${owner}/demo/branches/main`);
  assert.equal(branch.commit.sha, mainSha);

  // ------------------------------------------------------------ the push ran CI on a self-hosted runner
  const pushRun = await until("push run", async () => (await ok("GET", `/repos/${owner}/demo/actions/runs?event=push`)).workflow_runs[0]);
  assert.equal(pushRun.head_sha, mainSha);
  const job1 = await runOneJob(owner, "demo");
  const finished = await until("push run to complete", async () => {
    const r = await ok("GET", `/repos/${owner}/demo/actions/runs/${pushRun.id}`);
    return r.status === "completed" ? r : null;
  });
  assert.equal(finished.conclusion, "success", job1.out);
  const logs = await (await fetch(`${base}/api/v3/repos/${owner}/demo/actions/jobs/${job1.claim.job_id}/logs`, { headers: { authorization: `Bearer ${token}` } })).text();
  assert.match(logs, /event=push/);
  assert.match(logs, /app\.txt has 3 lines/);
  const checks = await ok("GET", `/repos/${owner}/demo/commits/${mainSha}/check-runs`);
  assert.equal(checks.check_runs.find((c) => c.name === "CI / build")?.conclusion, "success");

  // ------------------------------------------------------------ clone over protocol v2
  const clone = join(work, "clone");
  git(work, ["clone", "-q", `${base}/${owner}/demo.git`, clone]);
  assert.equal(readFileSync(join(clone, "app.txt"), "utf8"), "one\ntwo\nthree\n");

  // ------------------------------------------------------------ secrets are blocked on push
  // The key below is a fake that push protection must block in the pushed file; this
  // marker exempts only the test source itself: diffinery:allow-secret
  writeFileSync(join(clone, "config.env"), "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPL3\n");
  git(clone, ["add", "-A"]);
  git(clone, ["commit", "-q", "-m", "oops"]);
  assert.match(gitFails(clone, ["push", "origin", "main"]), /secret|AWS/i);
  // Objects from a blocked push are not kept, so retrying (even with push negotiation) is blocked too.
  assert.match(gitFails(clone, ["-c", "push.negotiate=true", "push", "origin", "HEAD:refs/heads/fixture"]), /secret|AWS/i);
  // A repository admin can push anyway by giving a reason; the bypass is audited.
  assert.match(gitFails(clone, ["push", "-o", "allow-secrets=", "origin", "HEAD:refs/heads/fixture"]), /secret|AWS/i);
  git(clone, ["push", "-q", "-o", "allow-secrets=fake key used by this test", "origin", "HEAD:refs/heads/fixture"]);
  assert.ok((await ok("GET", `/repos/${owner}/demo/branches`)).some((b) => b.name === "fixture"));
  git(clone, ["push", "-q", "origin", ":refs/heads/fixture"]);
  git(clone, ["reset", "-q", "--hard", "origin/main"]);

  // ------------------------------------------------------------ protect main: PR + green CI + review
  await ok("PUT", `/repos/${owner}/demo/branches/main/protection`, {
    requirePullRequest: true,
    requiredApprovals: 0,
    dismissStaleReviews: true,
    requiredChecks: ["CI / build"],
    allowForcePush: false,
    allowDeletion: false,
    requireLinearHistory: false,
    enforceAdmins: true,
    agentsMayPush: false,
    agentsMayMerge: false,
  });
  writeFileSync(join(clone, "app.txt"), "one\ntwo\nthree\nfour\n");
  git(clone, ["commit", "-q", "-am", "direct push"]);
  assert.match(gitFails(clone, ["push", "origin", "main"]), /pull request|protected/i);
  git(clone, ["reset", "-q", "--hard", "origin/main"]);

  // ------------------------------------------------------------ an AI agent opens a PR
  const created = await ok("POST", "/diffinery/agents", { login: "e2e-bot", name: "E2E Bot" }, null);
  agentToken = created.token.token;
  const agentClone = join(work, "agent");
  git(work, ["clone", "-q", `${base}/${owner}/demo.git`, agentClone], agentToken);
  git(agentClone, ["checkout", "-q", "-b", "feature"], agentToken);
  writeFileSync(join(agentClone, "app.txt"), "one\ntwo\nthree\nfour\n");
  git(agentClone, ["commit", "-q", "-am", "Add a fourth line"], agentToken);
  assert.match(gitFails(agentClone, ["push", "origin", "HEAD:main"], agentToken), /agent|protected|pull request/i);
  // push.negotiate=true makes git run a protocol v2 fetch with wait-for-done before pushing.
  const negotiated = spawnSync("git", ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-token:${agentToken}`).toString("base64")}`, "-c", "protocol.version=2", "-c", "push.negotiate=true", "push", "-q", "origin", "feature"], { cwd: agentClone, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  assert.equal(negotiated.status, 0, negotiated.stderr);
  assert.doesNotMatch(negotiated.stderr, /negotiation failed|unexpected/i);
  const pr = await ok("POST", `/repos/${owner}/demo/pulls`, { title: "Add a fourth line", head: "feature", base: "main", intent: "Extend app.txt for the e2e test" }, agentToken);
  assert.equal(pr.number, 1);

  // An agent may start an empty repository's default branch (as auto_init would), and then only through pull requests.
  await ok("POST", "/user/repos", { name: "agent-seeded", private: true });
  const seed = join(work, "agent-seeded");
  git(work, ["init", "-q", "-b", "main", seed]);
  mkdirSync(join(seed, ".github/workflows"), { recursive: true });
  writeFileSync(join(seed, ".github/workflows/ci.yml"), "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n");
  writeFileSync(join(seed, "README.md"), "# seeded by an agent\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "Initial commit"]);
  // Not with workflow files: those reach the default branch only through a pull request a person merges.
  assert.match(gitFails(seed, ["push", `${base}/${owner}/agent-seeded.git`, "main"], agentToken), /can't add workflow file `\.github\/workflows\/ci\.yml`/);
  git(seed, ["rm", "-q", "-r", ".github"]);
  git(seed, ["commit", "-q", "--amend", "-m", "Initial commit"]);
  git(seed, ["push", "-q", `${base}/${owner}/agent-seeded.git`, "main"], agentToken);
  writeFileSync(join(seed, "README.md"), "# changed\n");
  git(seed, ["commit", "-q", "-am", "Second commit"]);
  assert.match(gitFails(seed, ["push", `${base}/${owner}/agent-seeded.git`, "main"], agentToken), /agents may not push to protected or default branches/);

  // The pull_request run executes; until then the PR is blocked on the required check.
  let m = await ok("GET", `/repos/${owner}/demo/pulls/1/merge`);
  assert.equal(m.mergeable, false);
  await runOneJob(owner, "demo");
  await until("PR check to pass", async () => {
    const r = await ok("GET", `/repos/${owner}/demo/pulls/1/merge`);
    return r.checks?.length > 0 && r.checks.every((c) => c.state === "success") ? r : null;
  });
  m = await ok("GET", `/repos/${owner}/demo/pulls/1/merge`);
  assert.equal(m.mergeable, false, "agent-authored PRs need a human approval");
  assert.ok(JSON.stringify(m.blockers).match(/approv|human/i), JSON.stringify(m.blockers));

  // The agent cannot approve or merge its own work.
  const agentMerge = await api("PUT", `/repos/${owner}/demo/pulls/1/merge`, { merge_method: "squash" }, agentToken);
  assert.ok([403, 405, 409].includes(agentMerge.status), JSON.stringify(agentMerge));

  // Another agent's approval is advisory and does not unblock the merge.
  const reviewer = (await ok("POST", "/diffinery/agents", { login: "e2e-reviewer" }, null)).token.token;
  await ok("POST", `/repos/${owner}/demo/pulls/1/reviews`, { event: "APPROVE", body: "bot says ok" }, reviewer);
  assert.equal((await ok("GET", `/repos/${owner}/demo/pulls/1/merge`)).mergeable, false);

  // A human reviews (line comment + approval) and merges.
  await ok("POST", `/repos/${owner}/demo/pulls/1/reviews`, { event: "APPROVE", body: "LGTM", comments: [{ path: "app.txt", line: 4, body: "nice line" }] });
  m = await ok("GET", `/repos/${owner}/demo/pulls/1/merge`);
  assert.equal(m.mergeable, true, JSON.stringify(m));
  const merged = await ok("PUT", `/repos/${owner}/demo/pulls/1/merge`, { merge_method: "squash", delete_branch: true });
  assert.ok(merged.sha);
  const prAfter = await ok("GET", `/repos/${owner}/demo/pulls/1`);
  assert.equal(prAfter.merged, true);

  // ------------------------------------------------------------ fetch the merge, read through REST
  git(clone, ["pull", "-q", "--ff-only", "origin", "main"]);
  assert.equal(readFileSync(join(clone, "app.txt"), "utf8"), "one\ntwo\nthree\nfour\n");
  const content = await ok("GET", `/repos/${owner}/demo/contents/app.txt`);
  assert.equal(Buffer.from(content.content, "base64").toString(), "one\ntwo\nthree\nfour\n");
  const branches = await ok("GET", `/repos/${owner}/demo/branches`);
  assert.ok(!branches.some((b) => b.name === "feature"), "head branch deleted after merge");

  // ------------------------------------------------------------ shallow clone, then deepen
  const shallow = join(work, "shallow");
  git(work, ["clone", "-q", "--depth", "1", `${base}/${owner}/demo.git`, shallow]);
  assert.equal(git(shallow, ["rev-list", "--count", "HEAD"]).trim(), "1");
  assert.equal(readFileSync(join(shallow, "app.txt"), "utf8"), "one\ntwo\nthree\nfour\n");
  git(shallow, ["fetch", "-q", "--unshallow"]);
  assert.equal(git(shallow, ["rev-list", "--count", "HEAD"]).trim(), "2");
  git(shallow, ["fsck", "--no-progress"]);

  // ------------------------------------------------------------ MCP: the agent works without git
  const rpc = async (method, params, id = 1) => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    assert.equal(r.status, 200);
    return (await r.json()).result;
  };
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  assert.equal(init.serverInfo.name, "diffinery");
  const tools = await rpc("tools/list", {});
  assert.ok(tools.tools.some((t) => t.name === "commit_files"));
  const file = await rpc("tools/call", { name: "get_file", arguments: { owner, repo: "demo", path: "README.md" } });
  assert.equal(file.isError, false);
  assert.equal(file.structuredContent.content, "# demo\n");
  const commit = await rpc("tools/call", { name: "commit_files", arguments: { owner, repo: "demo", branch: "mcp-change", create_branch_from: "main", message: "Edit via MCP", files: [{ path: "docs/notes.md", content: "hello\n" }] } });
  assert.equal(commit.isError, false, JSON.stringify(commit));
  const blocked = await rpc("tools/call", { name: "commit_files", arguments: { owner, repo: "demo", branch: "main", message: "sneaky", files: [{ path: "x", content: "y" }] } });
  assert.equal(blocked.isError, true);
  const opened = await rpc("tools/call", { name: "create_pull_request", arguments: { owner, repo: "demo", title: "Notes", head: "mcp-change", intent: "Add notes" } });
  assert.equal(opened.isError, false, JSON.stringify(opened));
  assert.equal(opened.structuredContent.number, 2);

  // ------------------------------------------------------------ web UI renders the same data (signed in via DEV_AUTH)
  for (const path of ["/", `/${owner}`, `/${owner}/demo`, `/${owner}/demo/blob/main/app.txt`, `/${owner}/demo/commits/main`, `/${owner}/demo/pulls`, `/${owner}/demo/pull/1`, `/${owner}/demo/pull/1/files`, `/${owner}/demo/actions`, `/${owner}/demo/actions/runs/${pushRun.id}`, `/${owner}/demo/actions/runs/${pushRun.id}/job/${job1.claim.job_id}`, `/${owner}/demo/settings/branches`, "/settings/tokens"]) {
    const res = await fetch(`${base}${path}`);
    const html = await res.text();
    assert.equal(res.status, 200, `${path} -> ${res.status}\n${html.slice(0, 500)}`);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/, path);
  }
  assert.match(await (await fetch(`${base}/${owner}/demo/pull/1`)).text(), /Add a fourth line/);
  const forged = await fetch(`${base}/${owner}/demo/issues/1/comment`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", "sec-fetch-site": "cross-site" }, body: "body=hi" });
  assert.equal(forged.status, 403);

  // ------------------------------------------------------------ the CLI against the same server
  const CLI = resolve(APP, "../cli/dist/diffinery.mjs");
  if (existsSync(CLI)) {
    const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: clone, env: { ...process.env, DIFFINERY_URL: base, DIFFINERY_TOKEN: token, NO_COLOR: "1", XDG_CONFIG_HOME: join(work, "cfg") } });
    assert.match(cli("whoami"), new RegExp(owner));
    const prs = JSON.parse(cli("pr", "list", "--state", "all", "--json"));
    assert.ok(prs.some((p) => p.number === 1));
    assert.match(cli("workflow", "validate"), /ci\.yml/);
  }

  // The commit made through MCP carries the agent's identity.
  const agentCommit = await ok("GET", `/repos/${owner}/demo/commits/mcp-change`);
  assert.match(JSON.stringify(agentCommit), /e2e-bot/);
});

// 2026-10-24: objects of 64 KB to 1 MB failed to inflate in workerd (not in Node, so unit tests passed):
// pushes were refused, and reading those files and diffs answered 500. Sizes around each limit, read
// back through REST, a compare and a push that deltas against them.
test("objects of every size: read back, compared and used as delta bases", async () => {
  const owner = (await ok("GET", "/user")).login;
  await ok("POST", "/user/repos", { name: "sizes" });
  const src = join(work, "sizes");
  mkdirSync(src, { recursive: true });
  const sizes = [100, 16_385, 65_535, 65_537, 101_330, 600_000];
  const text = (size, seed) => {
    const lines = [];
    for (let n = 0, i = 0; n < size; i++) {
      const line = `${seed} line ${i}: ${(i * 7919) % 10007} ${"abcdefghij".repeat(4)}\n`;
      lines.push(line);
      n += line.length;
    }
    return lines.join("").slice(0, size);
  };
  for (const size of sizes) writeFileSync(join(src, `f${size}.txt`), text(size, "v1"));
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "sizes"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/sizes.git`]);
  git(src, ["push", "-q", "origin", "main"]);
  const first = git(src, ["rev-parse", "HEAD"]).trim();
  for (const size of sizes) {
    const c = await ok("GET", `/repos/${owner}/sizes/contents/f${size}.txt`);
    assert.equal(Buffer.from(c.content, "base64").toString(), text(size, "v1"), `f${size}.txt reads back`);
  }
  // One changed line each: git sends deltas against the stored objects, which the server inflates.
  for (const size of sizes) writeFileSync(join(src, `f${size}.txt`), "changed\n" + text(size, "v1").slice(8));
  git(src, ["commit", "-q", "-am", "change"]);
  git(src, ["push", "-q", "origin", "main"]);
  const cmp = await ok("GET", `/repos/${owner}/sizes/compare/${first}...main`);
  assert.equal(cmp.files.length, sizes.length);
  await ok("GET", `/repos/${owner}/sizes/commits/main`);
  const clone = join(work, "sizes-clone");
  git(work, ["clone", "-q", `${base}/${owner}/sizes.git`, clone]);
  git(clone, ["fsck", "--no-progress"]);
  for (const size of sizes) assert.equal(readFileSync(join(clone, `f${size}.txt`), "utf8"), readFileSync(join(src, `f${size}.txt`), "utf8"));
});

test("reusable workflows: inputs, secrets, outputs, nesting and skipped calls", async () => {
  const owner = (await ok("GET", "/user")).login;
  await ok("POST", "/user/repos", { name: "reuse" });
  await api("PUT", `/repos/${owner}/reuse/actions/secrets/TOPSECRET`, { value: "s3cret" });
  const src = join(work, "reuse");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(src, ".github/workflows/lib.yml"),
    `on:
  workflow_call:
    inputs:
      greeting: { type: string, required: true }
      loud: { type: boolean, default: false }
    secrets:
      TOPSECRET: { required: true }
    outputs:
      word:
        value: \${{ jobs.shout.outputs.word }}
jobs:
  say:
    runs-on: [self-hosted, linux]
    outputs:
      word: \${{ steps.s.outputs.word }}
    steps:
      - id: s
        run: echo "word=\${{ inputs.greeting }}-there" >> "$GITHUB_OUTPUT"
      - run: echo "secret ok=\${{ secrets.TOPSECRET == 's3cret' }} loud=\${{ inputs.loud }} job=\${{ github.job }}"
  shout:
    needs: say
    runs-on: [self-hosted, linux]
    outputs:
      word: \${{ steps.s.outputs.word }}
    steps:
      - id: s
        run: echo "word=\${{ needs.say.outputs.word }}!" >> "$GITHUB_OUTPUT"
`,
  );
  writeFileSync(
    join(src, ".github/workflows/main.yml"),
    `name: Main
on: push
jobs:
  call:
    name: Greeter
    uses: ./.github/workflows/lib.yml
    with:
      greeting: \${{ github.event_name == 'push' && 'hi' || 'no' }}
      loud: true
    secrets: inherit
  nope:
    if: \${{ false }}
    uses: ./.github/workflows/lib.yml
    with:
      greeting: never
    secrets:
      TOPSECRET: \${{ secrets.TOPSECRET }}
  after:
    needs: [call, nope]
    if: \${{ always() }}
    runs-on: [self-hosted, linux]
    steps:
      - run: echo "got=\${{ needs.call.outputs.word }} call=\${{ needs.call.result }} nope=\${{ needs.nope.result }}"
`,
  );
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "."]);
  git(src, ["commit", "-q", "-m", "reusable"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/reuse.git`]);
  git(src, ["push", "-q", "origin", "main"]);

  const run = await until("reuse run", async () => (await ok("GET", `/repos/${owner}/reuse/actions/runs`)).workflow_runs[0]);
  const logOf = async (id) => (await fetch(`${base}/api/v3/repos/${owner}/reuse/actions/jobs/${id}/logs`, { headers: { authorization: `Bearer ${token}` } })).text();
  const say = await runOneJob(owner, "reuse");
  assert.equal(say.claim.name, "Greeter / say");
  const sayLog = await logOf(say.claim.job_id);
  assert.match(sayLog, /secret ok=true loud=true job=say/);
  assert.doesNotMatch(sayLog, /s3cret/);
  const shout = await runOneJob(owner, "reuse");
  assert.equal(shout.claim.name, "Greeter / shout");
  const after = await runOneJob(owner, "reuse");
  assert.equal(after.claim.name, "after");
  assert.match(await logOf(after.claim.job_id), /got=hi-there! call=success nope=skipped/);
  const done = await until("reuse run to complete", async () => {
    const r = await ok("GET", `/repos/${owner}/reuse/actions/runs/${run.id}`);
    return r.status === "completed" ? r : null;
  });
  assert.equal(done.conclusion, "success");
  const jobs = (await ok("GET", `/repos/${owner}/reuse/actions/runs/${run.id}/jobs`)).jobs;
  assert.deepEqual(jobs.filter((j) => j.conclusion === "skipped").map((j) => j.name).sort(), ["nope / say", "nope / shout"]);
});

test("job graph: needs-only scheduling, skip cascades, per-leg runs-on, continue-on-error, job concurrency and public payloads", async () => {
  const owner = (await ok("GET", "/user")).login;
  await ok("POST", "/user/repos", { name: "graph", private: false });
  const src = join(work, "graph");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(src, ".github/workflows/graph.yml"),
    `name: Graph
on: push
jobs:
  slow:
    runs-on: [self-hosted, e2e-slow]
    steps:
      - run: echo slow
  fast:
    runs-on: [self-hosted, linux]
    steps:
      - run: echo "private=\${{ github.event.repository.private }} visibility=\${{ github.event.repository.visibility }}"
  after-fast:
    needs: fast
    runs-on: [self-hosted, linux]
    steps:
      - run: echo after-fast
  gate:
    if: \${{ github.event_name == 'nope' }}
    runs-on: [self-hosted, linux]
    steps:
      - run: echo never
  middle:
    needs: gate
    if: \${{ always() }}
    runs-on: [self-hosted, linux]
    steps:
      - run: echo "gate=\${{ needs.gate.result }}"
  leaf:
    needs: middle
    runs-on: [self-hosted, linux]
    steps:
      - run: echo leaf
  rescued:
    needs: middle
    if: \${{ !cancelled() && !failure() }}
    runs-on: [self-hosted, linux]
    steps:
      - run: echo "middle=\${{ needs.middle.result }}"
  lanes:
    name: lane \${{ matrix.lane }}
    strategy:
      matrix:
        include:
          - lane: red
            runner: [self-hosted, e2e-red]
          - lane: blue
            runner: [self-hosted, e2e-blue]
    runs-on: \${{ matrix.runner }}
    continue-on-error: \${{ matrix.lane == 'red' }}
    environment: e2e-\${{ matrix.lane }}-\${{ strategy.job-total }}
    steps:
      - run: echo "lane=\${{ matrix.lane }}" && test "\${{ matrix.lane }}" = blue
  after-lanes:
    needs: lanes
    runs-on: [self-hosted, linux]
    steps:
      - run: echo "lanes=\${{ needs.lanes.result }}"
  deploy:
    strategy:
      matrix:
        target: [prod, staging]
    concurrency: e2e-\${{ matrix.target }}
    runs-on: [self-hosted, e2e-deploy]
    steps:
      - run: echo "deploy \${{ matrix.target }}"
  hotfix:
    strategy:
      matrix:
        target: [prod]
    concurrency: e2e-\${{ matrix.target }}
    runs-on: [self-hosted, e2e-deploy]
    steps:
      - run: echo "hotfix \${{ matrix.target }}"
`,
  );
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "."]);
  git(src, ["commit", "-q", "-m", "graph"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/graph.git`]);
  git(src, ["push", "-q", "origin", "main"]);

  const run = await until("graph run", async () => (await ok("GET", `/repos/${owner}/graph/actions/runs`)).workflow_runs[0]);
  const logOf = async (id) => (await fetch(`${base}/api/v3/repos/${owner}/graph/actions/jobs/${id}/logs`, { headers: { authorization: `Bearer ${token}` } })).text();
  const jobs = async () => (await ok("GET", `/repos/${owner}/graph/actions/runs/${run.id}/jobs`)).jobs;

  // Jobs start when their own needs finish: after-fast and rescued run while slow (no runner offers e2e-slow) still waits.
  const linux = {};
  for (let i = 0; i < 4; i++) {
    const j = await runOneJob(owner, "graph");
    linux[j.claim.name] = j.claim.job_id;
  }
  assert.deepEqual(Object.keys(linux).sort(), ["after-fast", "fast", "middle", "rescued"]);
  assert.equal((await jobs()).find((j) => j.name === "slow").status, "waiting");
  assert.match(await logOf(linux.fast), /private=false visibility=public/);
  assert.match(await logOf(linux.middle), /gate=skipped/);
  assert.match(await logOf(linux.rescued), /middle=success/);

  // runs-on per matrix leg; the red leg fails but continues on error, so fail-fast spares the blue one.
  const red = await runOneJob(owner, "graph", { labels: ["e2e-red"], allowFailure: true });
  assert.equal(red.claim.name, "lane red");
  const blue = await runOneJob(owner, "graph", { labels: ["e2e-blue"] });
  assert.equal(blue.claim.name, "lane blue");
  const afterLanes = await runOneJob(owner, "graph");
  assert.equal(afterLanes.claim.name, "after-lanes");
  assert.match(await logOf(afterLanes.claim.job_id), /lanes=success/);
  const envs = (await ok("GET", `/repos/${owner}/graph/environments`)).environments.map((e) => e.name);
  assert.ok(envs.includes("e2e-red-2") && envs.includes("e2e-blue-2"), `per-leg environments: ${envs}`);

  // Job-level concurrency, evaluated per leg: one of the two prod jobs waits as pending until the other finishes.
  const pending = await until("a pending prod job", async () => (await jobs()).find((j) => j.status === "pending"));
  assert.ok(["deploy (prod)", "hotfix (prod)"].includes(pending.name), pending.name);
  const first = await runOneJob(owner, "graph", { labels: ["e2e-deploy"] });
  const second = await runOneJob(owner, "graph", { labels: ["e2e-deploy"] });
  assert.deepEqual([first.claim.name, second.claim.name].sort(), ["deploy (prod)", "deploy (staging)", "hotfix (prod)"].filter((n) => n !== pending.name).sort());
  const third = await runOneJob(owner, "graph", { labels: ["e2e-deploy"] });
  assert.equal(third.claim.name, pending.name);

  const slow = await runOneJob(owner, "graph", { labels: ["e2e-slow"] });
  assert.equal(slow.claim.name, "slow");
  const done = await until("graph run to complete", async () => {
    const r = await ok("GET", `/repos/${owner}/graph/actions/runs/${run.id}`);
    return r.status === "completed" ? r : null;
  });
  assert.equal(done.conclusion, "success", "a failed leg with continue-on-error does not fail the run");
  const byName = Object.fromEntries((await jobs()).map((j) => [j.name, j]));
  assert.equal(byName.gate.conclusion, "skipped");
  assert.equal(byName.leaf.conclusion, "skipped", "a skipped ancestor skips the jobs below it");
  assert.equal(byName["lane red"].conclusion, "failure");
  assert.equal(byName["lane blue"].conclusion, "success");
});

test("re-runs: failed jobs only keep what passed, and one job re-runs with what depends on it", async () => {
  const owner = (await ok("GET", "/user")).login;
  await ok("POST", "/user/repos", { name: "rerun", private: true });
  const src = join(work, "rerun");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(src, ".github/workflows/rerun.yml"),
    `name: Rerun
on: push
jobs:
  build:
    runs-on: [self-hosted, linux]
    steps:
      - run: echo "built in attempt \${{ github.run_attempt }}"
  test:
    needs: build
    strategy:
      matrix:
        n: [1, 2]
    runs-on: [self-hosted, linux]
    steps:
      - run: echo "leg \${{ matrix.n }}" && { test "\${{ matrix.n }}" = 1 || test "\${{ github.run_attempt }}" != 1; }
  report:
    needs: test
    runs-on: [self-hosted, linux]
    steps:
      - run: echo "report in attempt \${{ github.run_attempt }}"
`,
  );
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "."]);
  git(src, ["commit", "-q", "-m", "rerun"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/rerun.git`]);
  git(src, ["push", "-q", "origin", "main"]);
  const R = `/repos/${owner}/rerun`;
  const finished = (id) =>
    until(`run ${id} to complete`, async () => {
      const r = await ok("GET", `${R}/actions/runs/${id}`);
      return r.status === "completed" ? r : null;
    });
  const jobsOf = async (id) => Object.fromEntries((await ok("GET", `${R}/actions/runs/${id}/jobs`)).jobs.map((j) => [j.name, j]));
  const logOf = async (id) => (await fetch(`${base}/api/v3${R}/actions/jobs/${id}/logs`, { headers: { authorization: `Bearer ${token}` } })).text();

  // Attempt 1: leg 2 fails, so report is skipped.
  const first = await until("the first run", async () => (await ok("GET", `${R}/actions/runs`)).workflow_runs[0]);
  const claimed = [];
  for (let i = 0; i < 3; i++) claimed.push((await runOneJob(owner, "rerun", { allowFailure: true })).claim.name);
  assert.deepEqual(claimed, ["build", "test (1)", "test (2)"]);
  assert.equal((await finished(first.id)).conclusion, "failure");
  assert.equal((await jobsOf(first.id)).report.conclusion, "skipped");

  // Re-run failed jobs: build and leg 1 are kept as they were; leg 2 and report run again.
  const second = (await api("POST", `${R}/actions/runs/${first.id}/rerun-failed-jobs`, { enable_debug_logging: false })).json.run_id;
  assert.ok(second);
  const again = [];
  for (let i = 0; i < 2; i++) again.push((await runOneJob(owner, "rerun")).claim.name);
  assert.deepEqual(again, ["test (2)", "report"]);
  const done = await finished(second);
  assert.deepEqual([done.conclusion, done.run_attempt, done.run_number], ["success", 2, first.run_number]);
  const kept = await jobsOf(second);
  const before = await jobsOf(first.id);
  assert.equal(kept.build.carriedFrom, before.build.id);
  assert.equal(kept["test (1)"].carriedFrom, before["test (1)"].id);
  assert.equal(kept["test (2)"].carriedFrom, null);
  assert.match(await logOf(kept.build.id), /built in attempt 1/);
  assert.match(await logOf(kept.report.id), /report in attempt 2/);
  assert.equal((await runnerClaim(R, ["linux"])).status, 204, "nothing else waits for a runner");

  // Nothing failed any more; re-running one job runs it and what depends on it (nothing here), keeping the rest.
  const none = await api("POST", `${R}/actions/runs/${second}/rerun-failed-jobs`);
  assert.deepEqual([none.status, none.json.message], [409, "this run has no failed jobs to re-run"]);
  const third = (await ok("POST", `${R}/actions/jobs/${kept.report.id}/rerun`)).run_id;
  assert.equal((await runOneJob(owner, "rerun")).claim.name, "report");
  assert.equal((await finished(third)).conclusion, "success");
  const last = await jobsOf(third);
  assert.equal(last.build.carriedFrom, before.build.id, "a job kept twice points at the job that ran");
  assert.equal(last["test (2)"].carriedFrom, kept["test (2)"].id);
  assert.equal(last.report.carriedFrom, null);
});

test("workflow_run: a workflow follows another one on the default branch", async () => {
  const owner = (await ok("GET", "/user")).login;
  await ok("POST", "/user/repos", { name: "chain" });
  const src = join(work, "chain");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  writeFileSync(join(src, ".github/workflows/ci.yml"), `name: CI\non: push\njobs:\n  build:\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: echo built\n`);
  writeFileSync(
    join(src, ".github/workflows/after.yml"),
    `name: After CI
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]
jobs:
  report:
    if: \${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: [self-hosted, linux]
    steps:
      - run: echo "followed \${{ github.event.workflow_run.name }} on \${{ github.event.workflow_run.head_branch }} (\${{ github.event.action }}) ref=\${{ github.ref }}"
`,
  );
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "."]);
  git(src, ["commit", "-q", "-m", "chain"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/chain.git`]);
  git(src, ["push", "-q", "origin", "main"]);

  const runs = async () => (await ok("GET", `/repos/${owner}/chain/actions/runs`)).workflow_runs;
  await until("CI run", async () => (await runs()).find((r) => r.name === "CI"));
  assert.equal((await runs()).length, 1, "only CI runs before it completes");
  const build = await runOneJob(owner, "chain");
  assert.equal(build.claim.name, "build");
  const follower = await until("follower run", async () => (await runs()).find((r) => r.event === "workflow_run"));
  assert.equal(follower.name, "After CI");
  assert.equal(follower.head_branch, "main");
  const report = await runOneJob(owner, "chain");
  assert.equal(report.claim.name, "report");
  const log = await (await fetch(`${base}/api/v3/repos/${owner}/chain/actions/jobs/${report.claim.job_id}/logs`, { headers: { authorization: `Bearer ${token}` } })).text();
  assert.match(log, /followed CI on main \(completed\) ref=refs\/heads\/main/);
  const done = await until("follower to complete", async () => {
    const r = await ok("GET", `/repos/${owner}/chain/actions/runs/${follower.id}`);
    return r.status === "completed" ? r : null;
  });
  assert.equal(done.conclusion, "success");
  assert.equal((await runs()).length, 2, "the follower does not trigger itself");

  // A run whose jobs were all skipped is skipped, as on GitHub, so a follower that waits for success doesn't run.
  writeFileSync(join(src, ".github/workflows/ci.yml"), `name: CI\non: push\njobs:\n  build:\n    if: \${{ false }}\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: echo built\n`);
  git(src, ["commit", "-q", "-am", "skip the build"]);
  git(src, ["push", "-q", "origin", "main"]);
  const settled = await until("skipped CI and its follower", async () => {
    const all = await runs();
    return all.length === 4 && all.every((r) => r.status === "completed") ? all : null;
  });
  const sha = git(src, ["rev-parse", "HEAD"]).trim();
  const skippedCi = settled.find((r) => r.name === "CI" && r.head_sha === sha);
  assert.equal(skippedCi?.conclusion, "skipped");
  assert.equal(settled.find((r) => r.event === "workflow_run" && r.id !== follower.id)?.conclusion, "skipped");
});

test("triggers from workflows: a job's repository_dispatch starts runs, a follower of agent code stays an agent's", { timeout: 600_000 }, async () => {
  const owner = (await ok("GET", "/user")).login;
  await ok("POST", "/user/repos", { name: "relay" });
  const bot = (await ok("POST", "/diffinery/agents", { login: "relay-bot" }, null)).token.token;
  const src = join(work, "relay");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(src, ".github/workflows/send.yml"),
    `name: Send
on: workflow_dispatch
jobs:
  send:
    runs-on: [self-hosted, linux]
    permissions: { contents: write }
    steps:
      - env: { GH_TOKEN: "\${{ github.token }}" }
        run: |
          code=$(curl -s -o out.txt -w '%{http_code}' -X POST -H "authorization: Bearer $GH_TOKEN" -H 'content-type: application/json' -d '{"event_type":"ping","client_payload":{"from":"a job"}}' "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/dispatches")
          echo "dispatch: $code $(cat out.txt)"
`,
  );
  writeFileSync(
    join(src, ".github/workflows/pinged.yml"),
    `name: Pinged
on:
  repository_dispatch:
    types: [ping]
jobs:
  pinged:
    runs-on: [self-hosted, linux]
    steps:
      - run: echo "pinged from \${{ github.event.client_payload.from }}"
`,
  );
  writeFileSync(join(src, ".github/workflows/ci.yml"), `name: CI\non: pull_request\njobs:\n  build:\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: echo built\n`);
  writeFileSync(
    join(src, ".github/workflows/after.yml"),
    `name: After CI
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
jobs:
  follow:
    runs-on: [self-hosted, linux]
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
        with: { ref: main }
      - env:
          GIT_AUTHOR_NAME: bot
          GIT_AUTHOR_EMAIL: bot@example.com
          GIT_COMMITTER_NAME: bot
          GIT_COMMITTER_EMAIL: bot@example.com
        run: |
          echo "after \${{ github.event.workflow_run.head_branch }}" >> followed.txt
          git add followed.txt && git commit -qm followed
          if git push -q origin HEAD:main 2>err.txt; then echo "main push: ok"; else echo "main push: refused $(tr '\\n' ' ' < err.txt)"; fi
`,
  );
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "."]);
  git(src, ["commit", "-q", "-m", "relay"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/relay.git`]);
  git(src, ["push", "-q", "origin", "main"]);

  const runs = async () => (await ok("GET", `/repos/${owner}/relay/actions/runs`)).workflow_runs;
  const logOf = async (claim) => (await (await fetch(`${base}/api/v3/repos/${owner}/relay/actions/jobs/${claim.job_id}/logs`, { headers: { authorization: `Bearer ${token}` } })).text()).replace(/^\S+Z /gm, "");

  // Like GitHub, a job's GITHUB_TOKEN may send repository_dispatch, and that starts runs.
  await ok("POST", `/repos/${owner}/relay/actions/workflows/send.yml/dispatches`, { ref: "main" });
  const send = await runOneJob(owner, "relay");
  assert.equal(send.claim.name, "send");
  assert.match(await logOf(send.claim), /dispatch: 204/);
  const pingedRun = await until("repository_dispatch run", async () => (await runs()).find((r) => r.event === "repository_dispatch"));
  assert.equal(pingedRun.name, "Pinged");
  const pinged = await runOneJob(owner, "relay");
  assert.equal(pinged.claim.name, "pinged");
  assert.match(await logOf(pinged.claim), /pinged from a job/);

  /** Opens a pull request from `branch` as a person, runs its CI, then the follower; returns the follower's log. */
  const follow = async (branch) => {
    const seen = new Set((await runs()).map((r) => r.id));
    await ok("POST", `/repos/${owner}/relay/pulls`, { title: branch, head: branch, base: "main" });
    await until("CI run", async () => (await runs()).find((r) => !seen.has(r.id) && r.name === "CI"));
    const build = await runOneJob(owner, "relay");
    assert.equal(build.claim.name, "build");
    await until("follower run", async () => (await runs()).find((r) => !seen.has(r.id) && r.event === "workflow_run"));
    const f = await runOneJob(owner, "relay");
    assert.equal(f.claim.name, "follow");
    return logOf(f.claim);
  };

  // A person's pull request: the follower writes to main with the token it was granted.
  git(src, ["checkout", "-q", "-b", "person-work"]);
  writeFileSync(join(src, "person.txt"), "from a person\n");
  git(src, ["add", "person.txt"]);
  git(src, ["commit", "-q", "-m", "person change"]);
  git(src, ["push", "-q", "origin", "person-work"]);
  assert.match(await follow("person-work"), /main push: ok/);

  // A person opens a pull request from a branch an agent pushed. CI runs the agent's code, so
  // the follower, which acts on what CI produced, is an agent's too and may not push to main.
  const agentClone = join(work, "relay-agent");
  git(work, ["clone", "-q", `${base}/${owner}/relay.git`, agentClone], bot);
  git(agentClone, ["checkout", "-q", "-b", "agent-work"], bot);
  writeFileSync(join(agentClone, "agent.txt"), "from the agent\n");
  git(agentClone, ["add", "agent.txt"], bot);
  git(agentClone, ["commit", "-q", "-m", "agent change"], bot);
  git(agentClone, ["push", "-q", "origin", "agent-work"], bot);
  assert.match(await follow("agent-work"), /main push: refused .*agents may not push to protected or default branches/);
});

test("pull requests: test merge commits, pull_request_target and the merge queue", async () => {
  const owner = (await ok("GET", "/user")).login;
  await ok("POST", "/user/repos", { name: "queue" });
  await api("PUT", `/repos/${owner}/queue/actions/secrets/TOPSECRET`, { value: "s3cret" });
  const src = join(work, "queue");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  writeFileSync(join(src, "app.txt"), "a\nb\nc\n");
  writeFileSync(
    join(src, ".github/workflows/ci.yml"),
    `name: CI
on:
  pull_request:
  merge_group:
jobs:
  test:
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@v4
      - run: |
          echo "event=\${{ github.event_name }} ref=\${{ github.ref }} sha=\${{ github.sha }} head=$(git rev-parse HEAD)"
          echo "parents=$(git rev-list --parents -n1 HEAD)"
          echo "app=$(tr '\\n' ' ' < app.txt)"
          if [ "\${{ github.event_name }}" = merge_group ] && grep -qs fail notes.txt; then echo "merge group failed"; exit 1; fi
`,
  );
  writeFileSync(
    join(src, ".github/workflows/target.yml"),
    `name: Target
on: pull_request_target
jobs:
  t:
    runs-on: [self-hosted, linux]
    steps:
      - run: echo "target from base secret=\${{ secrets.TOPSECRET == 's3cret' }} ref=\${{ github.ref }} head=\${{ github.event.pull_request.head.sha }}"
`,
  );
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "."]);
  git(src, ["commit", "-q", "-m", "queue"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/queue.git`]);
  git(src, ["push", "-q", "origin", "main"]);
  const root = git(src, ["rev-parse", "HEAD"]).trim();

  // f1 changes the first line and tries to rewrite the pull_request_target workflow.
  git(src, ["checkout", "-q", "-b", "f1"]);
  writeFileSync(join(src, "app.txt"), "A\nb\nc\n");
  writeFileSync(join(src, ".github/workflows/target.yml"), `name: Target\non: pull_request_target\njobs:\n  t:\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: echo "PWNED \${{ secrets.TOPSECRET }}"\n`);
  git(src, ["commit", "-q", "-am", "f1"]);
  git(src, ["push", "-q", "origin", "f1"]);
  const f1 = git(src, ["rev-parse", "HEAD"]).trim();
  // main moves on, so the test merge commit differs from both sides.
  git(src, ["checkout", "-q", "main"]);
  writeFileSync(join(src, "app.txt"), "a\nb\nC\n");
  git(src, ["commit", "-q", "-am", "main moves"]);
  git(src, ["push", "-q", "origin", "main"]);
  const main1 = git(src, ["rev-parse", "HEAD"]).trim();

  const pr1 = await ok("POST", `/repos/${owner}/queue/pulls`, { title: "Capitalise a", head: "f1", base: "main" });
  const runs = async (q = "") => (await ok("GET", `/repos/${owner}/queue/actions/runs${q}`)).workflow_runs;
  const prRun = await until("pull_request run", async () => (await runs("?event=pull_request"))[0]);
  assert.equal(prRun.ref, "refs/pull/1/merge");
  assert.equal(prRun.head_sha, f1, "pull_request runs report on the PR head");
  assert.notEqual(prRun.sha, f1, "pull_request runs check out the test merge commit");
  assert.equal(prRun.head_branch, "f1");
  const targetRun = (await runs("?event=pull_request_target"))[0];
  assert.equal(targetRun.ref, "refs/heads/main");
  assert.equal(targetRun.sha, main1, "pull_request_target runs on the base commit");
  assert.equal(targetRun.head_sha, f1);
  // The merge ref is fetchable and its parents are [base, head]; refs/pull is read-only.
  git(src, ["fetch", "-q", "origin", "+refs/pull/1/merge:refs/remotes/pr/1"]);
  assert.equal(git(src, ["rev-parse", "refs/remotes/pr/1"]).trim(), prRun.sha);
  assert.equal(git(src, ["rev-list", "--parents", "-n1", "refs/remotes/pr/1"]).trim(), `${prRun.sha} ${main1} ${f1}`);
  assert.match(gitFails(src, ["push", "origin", `${root}:refs/pull/1/head`]), /refs\/pull|managed/);

  const logOf = async (id) => (await fetch(`${base}/api/v3/repos/${owner}/queue/actions/jobs/${id}/logs`, { headers: { authorization: `Bearer ${token}` } })).text();
  const ran = {};
  for (let i = 0; i < 2; i++) {
    const j = await runOneJob(owner, "queue");
    ran[j.claim.name] = await logOf(j.claim.job_id);
  }
  assert.match(ran.test, new RegExp(`event=pull_request ref=refs/pull/1/merge sha=${prRun.sha} head=${prRun.sha}`));
  assert.match(ran.test, /app=A b C/);
  assert.match(ran.t, /target from base secret=true ref=refs\/heads\/main/);
  assert.match(ran.t, new RegExp(`head=${f1}`));
  assert.doesNotMatch(ran.t, /PWNED/);
  await until("PR #1 checks", async () => {
    const c = (await ok("GET", `/repos/${owner}/queue/commits/${f1}/check-runs`)).check_runs;
    return c.length === 2 && c.every((x) => x.conclusion === "success") ? c : null;
  });

  // ------------------------------------------------------------ merge queue
  await ok("PUT", `/repos/${owner}/queue/branches/main/protection`, { requirePullRequest: true, requiredChecks: ["CI / test"], mergeQueue: { method: "merge", buildConcurrency: 5, checkTimeoutMinutes: 30 } });
  const direct = await api("PUT", `/repos/${owner}/queue/pulls/1/merge`, {});
  assert.equal(direct.status, 405);
  assert.match(JSON.stringify(direct.json), /merge queue/);
  assert.equal((await ok("GET", `/repos/${owner}/queue/pulls/1/merge`)).mergeQueue.method, "merge");

  // Two more pull requests: one that merges cleanly and one that fails only in its merge group.
  const branch = async (name, file, content) => {
    git(src, ["checkout", "-q", "-b", name, main1]);
    writeFileSync(join(src, file), content);
    git(src, ["add", "."]);
    git(src, ["commit", "-q", "-m", name]);
    git(src, ["push", "-q", "origin", name]);
    const sha = git(src, ["rev-parse", "HEAD"]).trim();
    const pr = await ok("POST", `/repos/${owner}/queue/pulls`, { title: name, head: name, base: "main" });
    for (let i = 0; i < 2; i++) await runOneJob(owner, "queue");
    await until(`${name} checks`, async () => (await ok("GET", `/repos/${owner}/queue/commits/${sha}/check-runs`)).check_runs.filter((x) => x.conclusion === "success").length === 2);
    return { pr, sha };
  };
  const f2 = await branch("f2", "two.txt", "two\n");
  const f3 = await branch("f3", "notes.txt", "fail\n");

  const q1 = await ok("PUT", `/repos/${owner}/queue/pulls/1/merge-queue`, { delete_branch: true });
  assert.equal(q1.state, "queued");
  assert.equal(q1.entry.position, 1);
  assert.equal(q1.entry.state, "checking");
  const q2 = await ok("PUT", `/repos/${owner}/queue/pulls/${f2.pr.number}/merge-queue`, {});
  const q3 = await ok("PUT", `/repos/${owner}/queue/pulls/${f3.pr.number}/merge-queue`, {});
  assert.equal(q2.entry.merge_group.base_sha, q1.entry.merge_group.head_sha, "each group builds on the one ahead");
  assert.equal(q3.entry.merge_group.base_sha, q2.entry.merge_group.head_sha);
  assert.equal(q1.entry.merge_group.head_ref, `refs/heads/gh-readonly-queue/main/pr-1-${f1}`);
  const queue = await ok("GET", `/repos/${owner}/queue/merge-queue/main`);
  assert.deepEqual(queue.entries.map((e) => e.number), [1, f2.pr.number, f3.pr.number]);
  assert.match(gitFails(src, ["push", "origin", `${root}:refs/heads/gh-readonly-queue/main/x`]), /read-only/);

  // Merge groups run merge_group workflows, oldest first.
  const groupLogs = [];
  for (let i = 0; i < 3; i++) {
    const j = await runOneJob(owner, "queue", { allowFailure: i === 2 });
    groupLogs.push(await logOf(j.claim.job_id));
  }
  assert.match(groupLogs[0], new RegExp(`event=merge_group ref=refs/heads/gh-readonly-queue/main/pr-1-${f1} sha=${q1.entry.merge_group.head_sha}`));
  assert.match(groupLogs[2], /merge group failed/);
  const mainNow = await until("the queue to merge #1 and #2", async () => {
    const b = await ok("GET", `/repos/${owner}/queue/branches/main`);
    return b.commit.sha === q2.entry.merge_group.head_sha ? b : null;
  });
  assert.ok(mainNow);
  assert.equal((await ok("GET", `/repos/${owner}/queue/pulls/1`)).merged, true);
  assert.equal((await ok("GET", `/repos/${owner}/queue/pulls/${f2.pr.number}`)).merged, true);
  assert.equal((await ok("GET", `/repos/${owner}/queue/pulls/1`)).merge_commit_sha, q1.entry.merge_group.head_sha, "the tested commit is what merged");
  const f3After = await until("#3 to leave the queue", async () => {
    const q = await ok("GET", `/repos/${owner}/queue/merge-queue/main`);
    return q.entries.length === 0 ? q : null;
  });
  assert.ok(f3After);
  assert.equal((await ok("GET", `/repos/${owner}/queue/pulls/${f3.pr.number}`)).merged, false);
  const comments = await ok("GET", `/repos/${owner}/queue/issues/${f3.pr.number}/comments`);
  assert.match(JSON.stringify(comments), /removed from the merge queue: the required check 'CI \/ test' failed on its merge group/);
  git(src, ["fetch", "-q", "origin"]);
  assert.equal(git(src, ["show", "origin/main:app.txt"]), "A\nb\nC\n");
  assert.equal(git(src, ["show", "origin/main:two.txt"]), "two\n");
  assert.ok(!(await ok("GET", `/repos/${owner}/queue/branches`)).some((b) => b.name.startsWith("gh-readonly-queue/") || b.name === "f1"), "group branches and f1 are gone");

  // A pull request that conflicts with its base runs no pull_request workflows (like GitHub), only pull_request_target.
  git(src, ["checkout", "-q", "-b", "f4", root]);
  writeFileSync(join(src, "app.txt"), "x\nb\nc\n");
  git(src, ["commit", "-q", "-am", "f4"]);
  git(src, ["push", "-q", "origin", "f4"]);
  const pr4 = await ok("POST", `/repos/${owner}/queue/pulls`, { title: "conflicts", head: "f4", base: "main" });
  const t4 = await until("pull_request_target run for #4", async () => (await runs("?event=pull_request_target")).find((r) => r.pull_request_number === pr4.number));
  assert.ok(t4);
  assert.equal((await runs("?event=pull_request")).filter((r) => r.pull_request_number === pr4.number).length, 0);
  await runOneJob(owner, "queue");

  // The web UI shows the queue.
  const page = async (path) => {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, path);
    return res.text();
  };
  assert.match(await page(`/${owner}/queue/queue/main`), /The queue is empty/);
  assert.match(await page(`/${owner}/queue/pull/${pr4.number}`), /Merge when ready/);
  assert.match(await page(`/${owner}/queue/pull/${f3.pr.number}`), /removed from the merge queue/);
  assert.match(await page(`/${owner}/queue/settings/branches`), /merge queue/);
});

const POLICY_WORKFLOW = `name: Policy
on:
  push:
    branches: [main, agent-work]
  pull_request:
jobs:
  probe:
    runs-on: [self-hosted, linux]
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
        with: { ref: main }
      - name: Push to main, push a workflow change, approve the pull request
        env:
          GH_TOKEN: \${{ github.token }}
          PR: \${{ github.event.pull_request.number }}
          GIT_AUTHOR_NAME: bot
          GIT_AUTHOR_EMAIL: bot@example.com
          GIT_COMMITTER_NAME: bot
          GIT_COMMITTER_EMAIL: bot@example.com
        run: |
          echo "run \${{ github.run_id }}" > note.txt
          git add note.txt && git commit -qm note
          if git push -q origin HEAD:main 2>err.txt; then echo "main push: ok"; else echo "main push: refused $(tr '\\n' ' ' < err.txt)"; fi
          git reset -q --hard HEAD~1
          echo "# edited" >> .github/workflows/policy.yml
          git commit -qam "edit the workflow"
          if git push -q origin "HEAD:refs/heads/wf-\${{ github.run_id }}" 2>err.txt; then echo "workflow push: ok"; else echo "workflow push: refused $(tr '\\n' ' ' < err.txt)"; fi
          if [ -n "$PR" ]; then
            code=$(curl -s -o out.json -w '%{http_code}' -X POST -H "authorization: Bearer $GH_TOKEN" -H 'content-type: application/json' -d '{"event":"APPROVE","body":"from a workflow"}' "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/pulls/$PR/reviews")
            echo "approve: $code $(cat out.json)"
          fi
  defaults:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: [self-hosted, linux]
    steps:
      - env: { GH_TOKEN: "\${{ github.token }}" }
        run: |
          code=$(curl -s -o out.json -w '%{http_code}' -X POST -H "authorization: Bearer $GH_TOKEN" -H 'content-type: application/json' -d '{"title":"from the default token"}' "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/issues")
          echo "default token issue write: $code $(cat out.json)"
          code=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $GH_TOKEN" "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/contents/README.md")
          echo "default token contents read: $code"
`;

test("workflow tokens: read-only default, no approvals or workflow edits, agent code stays an agent", { timeout: 600_000 }, async () => {
  const owner = (await ok("GET", "/user")).login;
  await ok("POST", "/user/repos", { name: "policy" });
  const settingsPath = `/repos/${owner}/policy/actions/permissions/workflow`;
  // New repositories start like GitHub's: read-only token, no pull request approvals.
  assert.deepEqual(await ok("GET", settingsPath), { default_workflow_permissions: "read", can_approve_pull_request_reviews: false, agent_runs_use_secrets: false });
  const bot = (await ok("POST", "/diffinery/agents", { login: "policy-bot" }, null)).token.token;
  assert.equal((await api("PUT", settingsPath, { can_approve_pull_request_reviews: true }, bot)).status, 403, "agents cannot change what workflows may do");
  assert.equal((await api("PUT", settingsPath, { default_workflow_permissions: "admin" })).status, 422);
  // The same settings on the repository's Settings → Actions page.
  const actionsPage = `/${owner}/policy/settings/actions`;
  const form = async (fields) => {
    const res = await fetch(`${base}${actionsPage}`);
    const html = await res.text();
    assert.match(html, /Allow GitHub Actions to create and approve pull requests/);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
    const cookie = /dfy_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    const r = await fetch(`${base}${actionsPage}`, { method: "POST", body: new URLSearchParams({ _csrf: csrf, ...fields }), redirect: "manual", headers: { cookie: `dfy_csrf=${cookie}`, "sec-fetch-site": "same-origin" } });
    assert.equal(r.status, 303);
  };
  await form({ default_permissions: "write", can_approve: "1" });
  assert.deepEqual(await ok("GET", settingsPath), { default_workflow_permissions: "write", can_approve_pull_request_reviews: true, agent_runs_use_secrets: false });
  await form({ default_permissions: "read" });
  assert.deepEqual(await ok("GET", settingsPath), { default_workflow_permissions: "read", can_approve_pull_request_reviews: false, agent_runs_use_secrets: false });

  const src = join(work, "policy");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  writeFileSync(join(src, "README.md"), "# policy\n");
  writeFileSync(join(src, ".github/workflows/policy.yml"), POLICY_WORKFLOW);
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "policy"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/policy.git`]);
  git(src, ["push", "-q", "origin", "main"]);

  /** Runs `count` jobs; returns their logs by job name. */
  const runJobs = async (count) => {
    const logs = {};
    for (let i = 0; i < count; i++) {
      const { claim } = await runOneJob(owner, "policy");
      const raw = await (await fetch(`${base}/api/v3/repos/${owner}/policy/actions/jobs/${claim.job_id}/logs`, { headers: { authorization: `Bearer ${token}` } })).text();
      logs[claim.name] = raw.replace(/^\S+Z /gm, "");
    }
    return logs;
  };
  const refused = (path) => new RegExp(`workflow push: refused .*refusing to allow a GitHub App to create or update workflow \`${path.replace(/\./g, "\\.")}\` without \`workflows\` permission`);

  // A person's push: the job token writes what it was granted, but never workflow files;
  // the default token (no permissions:) only reads.
  let logs = await runJobs(2);
  assert.match(logs.probe, /main push: ok/);
  assert.match(logs.probe, refused(".github/workflows/policy.yml"));
  assert.match(logs.defaults, /default token issue write: 403 .*issues: write/);
  assert.match(logs.defaults, /default token contents read: 200/);
  const branches = (await ok("GET", `/repos/${owner}/policy/branches`)).map((b) => b.name);
  assert.ok(!branches.some((b) => b.startsWith("wf-")), JSON.stringify(branches));
  git(src, ["pull", "-q", "--ff-only", "origin", "main"]);
  assert.match(readFileSync(join(src, "note.txt"), "utf8"), /^run \d+/);

  // An agent's push: the run executes the agent's code, so its token is an agent's and may not push to the default branch.
  const agentClone = join(work, "policy-agent");
  git(work, ["clone", "-q", `${base}/${owner}/policy.git`, agentClone], bot);
  git(agentClone, ["checkout", "-q", "-b", "agent-work"], bot);
  writeFileSync(join(agentClone, "agent.txt"), "from the agent\n");
  git(agentClone, ["add", "agent.txt"], bot);
  git(agentClone, ["commit", "-q", "-m", "agent change"], bot);
  git(agentClone, ["push", "-q", "origin", "agent-work"], bot);
  logs = await runJobs(1);
  assert.match(logs.probe, /main push: refused .*agents may not push to protected or default branches/);
  assert.match(logs.probe, refused(".github/workflows/policy.yml"));

  // A person opens a pull request from the branch the agent pushed: still the agent's code.
  // Workflows may not approve pull requests unless the repository allows it.
  const pr1 = await ok("POST", `/repos/${owner}/policy/pulls`, { title: "Agent work", head: "agent-work", base: "main" });
  logs = await runJobs(1);
  assert.match(logs.probe, /main push: refused .*agents may not push/);
  assert.match(logs.probe, /approve: 403 .*GitHub Actions is not permitted to approve pull requests/);
  assert.equal((await ok("GET", `/repos/${owner}/policy/pulls/${pr1.number}/reviews`)).length, 0);

  // Allowed: the approval is recorded, but only people's approvals count toward the required ones.
  await ok("PUT", settingsPath, { can_approve_pull_request_reviews: true });
  assert.deepEqual(await ok("GET", settingsPath), { default_workflow_permissions: "read", can_approve_pull_request_reviews: true, agent_runs_use_secrets: false });
  await ok("PUT", `/repos/${owner}/policy/branches/main/protection`, {
    requirePullRequest: true,
    requiredApprovals: 1,
    dismissStaleReviews: false,
    requiredChecks: [],
    allowForcePush: false,
    allowDeletion: false,
    requireLinearHistory: false,
    enforceAdmins: true,
    agentsMayPush: false,
    agentsMayMerge: false,
  });
  git(src, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(src, "feature.txt"), "a person's change\n");
  git(src, ["add", "feature.txt"]);
  git(src, ["commit", "-q", "-m", "feature"]);
  git(src, ["push", "-q", "origin", "feature"]);
  const pr2 = await ok("POST", `/repos/${owner}/policy/pulls`, { title: "Feature", head: "feature", base: "main" });
  logs = await runJobs(1);
  assert.match(logs.probe, /main push: refused .*pull request/);
  assert.match(logs.probe, /approve: 20[01] /);
  const reviews = await ok("GET", `/repos/${owner}/policy/pulls/${pr2.number}/reviews`);
  assert.deepEqual(reviews.map((r) => r.state), ["APPROVED"]);
  const m = await ok("GET", `/repos/${owner}/policy/pulls/${pr2.number}/merge`);
  assert.equal(m.mergeable, false, JSON.stringify(m));
  assert.equal(m.approvals, 0, JSON.stringify(m));
  assert.match(JSON.stringify(m.blockers), /needs 1 more approving review/);
});

const SCOPES_WORKFLOW = `name: Scopes
on:
  push:
    branches: [main, a, b]
  pull_request:
jobs:
  c:
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/cache@v4
        with: { path: built, key: "b-\${{ github.run_id }}", restore-keys: "b-" }
      - uses: actions/cache@v4
        env: { DIFFINERY_BUILTINS: "false" }
        with: { path: real, key: "r-\${{ github.run_id }}", restore-keys: "r-" }
      - run: |
          echo "restored built=[$(cat built/from 2>/dev/null)] real=[$(cat real/from 2>/dev/null)]"
          mkdir -p built real && echo "$GITHUB_REF" > built/from && echo "$GITHUB_REF" > real/from
      - if: github.ref == 'refs/heads/main'
        uses: actions/upload-artifact@v4
        with: { name: "builtin-\${{ github.run_id }}", path: built/from, retention-days: 1 }
      - if: github.ref == 'refs/heads/main'
        uses: actions/upload-artifact@v4
        env: { DIFFINERY_BUILTINS: "false" }
        with: { name: "real-\${{ github.run_id }}", path: built/from, retention-days: 3 }
      - if: github.ref == 'refs/heads/main'
        uses: actions/upload-artifact@v4
        with: { name: "capped-\${{ github.run_id }}", path: built/from, retention-days: 400 }
`;

test("caches are scoped to branches and pull requests; artifacts keep their retention-days", { timeout: 900_000 }, async () => {
  const owner = (await ok("GET", "/user")).login;
  await ok("POST", "/user/repos", { name: "scopes" });
  const src = join(work, "scopes");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  writeFileSync(join(src, ".github/workflows/scopes.yml"), SCOPES_WORKFLOW);
  writeFileSync(join(src, "README.md"), "# scopes\n");
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "scopes"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/scopes.git`]);
  /** Runs the job a push or pull request started; returns what its caches restored. */
  const restored = async () => {
    const { claim } = await runOneJob(owner, "scopes", { timeoutMs: 300_000 });
    const log = await (await fetch(`${base}/api/v3/repos/${owner}/scopes/actions/jobs/${claim.job_id}/logs`, { headers: { authorization: `Bearer ${token}` } })).text();
    const m = /^\S+ restored built=\[(.*?)\] real=\[(.*?)\]$/m.exec(log);
    assert.ok(m, log);
    return { builtin: m[1], real: m[2] };
  };
  const branch = (name, from, file) => {
    git(src, ["checkout", "-q", "-b", name, from]);
    if (file) {
      writeFileSync(join(src, file), `${name}\n`);
      git(src, ["add", file]);
      git(src, ["commit", "-q", "-m", name]);
    }
    git(src, ["push", "-q", "origin", name]);
  };

  // The default branch starts empty and saves its own entries.
  git(src, ["push", "-q", "origin", "main"]);
  assert.deepEqual(await restored(), { builtin: "", real: "" });
  // A branch falls back to the default branch's caches...
  branch("a", "main", "a.txt");
  assert.deepEqual(await restored(), { builtin: "refs/heads/main", real: "refs/heads/main" });
  // ...but never sees another branch's, though a's are newer and match the restore key.
  branch("b", "main", "b.txt");
  assert.deepEqual(await restored(), { builtin: "refs/heads/main", real: "refs/heads/main" });
  // A pull request reads its base branch's caches.
  branch("c", "a", "c.txt");
  await ok("POST", `/repos/${owner}/scopes/pulls`, { title: "c into a", head: "c", base: "a" });
  assert.deepEqual(await restored(), { builtin: "refs/heads/a", real: "refs/heads/a" });
  // Another pull request doesn't see the first one's (saved under refs/pull/<n>/merge).
  branch("d", "main", "d.txt");
  await ok("POST", `/repos/${owner}/scopes/pulls`, { title: "d into main", head: "d", base: "main" });
  assert.deepEqual(await restored(), { builtin: "refs/heads/main", real: "refs/heads/main" });
  const caches = await ok("GET", `/repos/${owner}/scopes/actions/caches?per_page=100`);
  assert.deepEqual([...new Set(caches.actions_caches.map((c) => c.ref))].sort(), ["refs/heads/a", "refs/heads/b", "refs/heads/main", "refs/pull/1/merge", "refs/pull/2/merge"]);
  // A page at a time, with GitHub's Link header.
  const page = await fetch(`${base}/api/v3/repos/${owner}/scopes/actions/caches?per_page=2`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await page.json()).actions_caches.length, 2);
  assert.match(page.headers.get("link") ?? "", /[?&]page=2>; rel="next".*rel="last"/);

  // retention-days (the built-in and the real upload-artifact), capped at 90 days.
  const days = (iso) => Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
  const artifacts = (await ok("GET", `/repos/${owner}/scopes/actions/runs/1/artifacts`)).artifacts;
  const byName = Object.fromEntries(artifacts.map((a) => [a.name.replace(/-\d+$/, ""), a]));
  assert.equal(days(byName.builtin.expires_at), 1, JSON.stringify(byName.builtin));
  assert.equal(days(byName.real.expires_at), 3, JSON.stringify(byName.real));
  assert.equal(days(byName.capped.expires_at), 90, JSON.stringify(byName.capped));
  assert.ok(artifacts.every((a) => a.expired === false));
});

test("an older runner's cache API is scoped the same way", async () => {
  const owner = (await ok("GET", "/user")).login;
  await ok("POST", "/user/repos", { name: "legacy-cache" });
  const src = join(work, "legacy-cache");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  writeFileSync(join(src, ".github/workflows/w.yml"), "on:\n  push:\n    branches: [main, a, b]\njobs:\n  j:\n    runs-on: [self-hosted, linux]\n    steps: [{ run: echo }]\n");
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "legacy"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/legacy-cache.git`]);

  /** Claims the job a push started and starts it, as an older runner would, without running steps. */
  const startJob = async () => {
    const claim = await until("a job to claim", async () => {
      const r = await runnerClaim(`/repos/${owner}/legacy-cache`, ["linux"]);
      return r.status === 200 ? r.json : null;
    });
    const h = { authorization: `Bearer ${claim.token}` };
    const at = `${base}/runner/jobs/${claim.job_id}`;
    assert.equal((await fetch(at, { headers: h })).status, 200);
    return {
      put: async (key, body) => (await fetch(`${at}/cache/${encodeURIComponent(key)}`, { method: "PUT", headers: { ...h, "content-length": String(body.length) }, body })).status,
      lookup: async (key, restore = "") => {
        const r = await fetch(`${at}/cache?key=${encodeURIComponent(key)}&restore=${encodeURIComponent(restore)}`, { headers: h });
        if (r.status !== 200) return { status: r.status };
        const hit = await r.json();
        const blob = await fetch(hit.url, { headers: h });
        return { key: hit.key, content: blob.status === 200 ? await blob.text() : blob.status };
      },
      blob: async (stored) => (await fetch(`${at}/cache/blob/${encodeURIComponent(stored)}`, { headers: h })).status,
      done: async () => assert.equal((await fetch(`${at}/complete`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ conclusion: "success", outputs: {} }) })).status, 200),
    };
  };

  const branch = (name) => {
    git(src, ["checkout", "-q", "-b", name, "main"]);
    writeFileSync(join(src, `${name}.txt`), `${name}\n`);
    git(src, ["add", "-A"]);
    git(src, ["commit", "-q", "-m", name]);
    git(src, ["push", "-q", "origin", name]);
  };

  git(src, ["push", "-q", "origin", "main"]);
  let job = await startJob();
  assert.equal(await job.put("lk-main", "from main"), 200);
  await job.done();

  branch("a");
  job = await startJob();
  assert.deepEqual(await job.lookup("lk-a", "lk-"), { key: "lk-main", content: "from main" });
  assert.equal(await job.put("lk-a", "from a"), 200);
  assert.deepEqual(await job.lookup("lk-a"), { key: "lk-a", content: "from a" });
  await job.done();

  branch("b");
  job = await startJob();
  assert.deepEqual(await job.lookup("lk-a"), { status: 404 });
  assert.deepEqual(await job.lookup("lk-x", "lk-"), { key: "lk-main", content: "from main" });
  // a's entry can't be fetched directly either
  assert.equal(await job.blob("refs/heads/a\nlk-a"), 404);
  assert.equal(await job.blob("lk-a"), 404);
  await job.done();
});

test("an older runner's artifact API needs the job's own token", async () => {
  const owner = (await ok("GET", "/user")).login;
  await ok("POST", "/user/repos", { name: "legacy-artifacts" });
  const src = join(work, "legacy-artifacts");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  writeFileSync(join(src, ".github/workflows/w.yml"), "on: push\njobs:\n  j:\n    runs-on: [self-hosted, linux]\n    steps: [{ run: echo }]\n");
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "legacy"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/legacy-artifacts.git`]);
  git(src, ["push", "-q", "origin", "main"]);
  const claim = await until("a job to claim", async () => {
    const r = await runnerClaim(`/repos/${owner}/legacy-artifacts`, ["linux"]);
    return r.status === 200 ? r.json : null;
  });
  const at = `${base}/runner/jobs/${claim.job_id}/artifacts/out`;
  const real = { authorization: `Bearer ${claim.token}` };
  // Same shape (djt_<repo>_<job>_...) as the real token, but not it.
  const forged = { authorization: `Bearer ${claim.token.split("_").slice(0, 3).join("_")}_${"0".repeat(48)}` };
  assert.equal((await fetch(`${base}/runner/jobs/${claim.job_id}`, { headers: real })).status, 200);
  const put = async (h, body) => (await fetch(at, { method: "PUT", headers: { ...h, "content-length": String(body.length) }, body })).status;
  const get = async (h) => {
    const r = await fetch(at, { headers: h });
    return r.status === 200 ? await r.text() : r.status;
  };
  assert.equal(await put(real, "real bytes"), 200);
  assert.equal(await put(forged, "forged bytes"), 401);
  assert.equal(await get(forged), 401);
  assert.equal(await get({}), 401);
  // The forged upload never reached storage.
  assert.equal(await get(real), "real bytes");
  assert.equal((await fetch(`${base}/runner/jobs/${claim.job_id}/complete`, { method: "POST", headers: { ...real, "content-type": "application/json" }, body: JSON.stringify({ conclusion: "success", outputs: {} }) })).status, 200);
  // A finished job's token no longer reads or writes.
  assert.equal(await get(real), 401);
});

test("an older runner's artifacts are listed, downloaded and deleted through the REST API", async () => {
  const owner = (await ok("GET", "/user")).login;
  await ok("POST", "/user/repos", { name: "legacy-rest" });
  const src = join(work, "legacy-rest");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  writeFileSync(join(src, ".github/workflows/w.yml"), "on: push\njobs:\n  j:\n    runs-on: [self-hosted, linux]\n    steps: [{ run: echo }]\n");
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "legacy"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/legacy-rest.git`]);
  git(src, ["push", "-q", "origin", "main"]);
  const claim = await until("a job to claim", async () => {
    const r = await runnerClaim(`/repos/${owner}/legacy-rest`, ["linux"]);
    return r.status === 200 ? r.json : null;
  });
  const h = { authorization: `Bearer ${claim.token}` };
  const at = `${base}/runner/jobs/${claim.job_id}`;
  assert.equal((await fetch(at, { headers: h })).status, 200);
  for (const name of ["one", "two", "three"]) {
    assert.equal((await fetch(`${at}/artifacts/${name}`, { method: "PUT", headers: { ...h, "content-length": String(name.length) }, body: name })).status, 200);
  }
  const rest = (path, init = {}) => fetch(`${base}/api/v3/repos/${owner}/legacy-rest${path}`, { ...init, headers: { authorization: `Bearer ${token}` } });

  // Listed with numeric ids, across the repository and for the run, a page at a time.
  let r = await rest("/actions/artifacts?per_page=2");
  let body = await r.json();
  assert.equal(body.total_count, 3, JSON.stringify(body));
  assert.equal(body.artifacts.length, 2);
  assert.ok(body.artifacts.every((a) => Number.isSafeInteger(a.id) && a.expired === false), JSON.stringify(body));
  assert.match(r.headers.get("link") ?? "", /[?&]page=2>; rel="next"/);
  const runId = body.artifacts[0].workflow_run.id;
  r = await rest(`/actions/runs/${runId}/artifacts?per_page=2&page=2`);
  body = await r.json();
  assert.equal(body.total_count, 3);
  assert.equal(body.artifacts.length, 1);
  assert.match(r.headers.get("link") ?? "", /rel="prev"/);
  assert.doesNotMatch(r.headers.get("link") ?? "", /rel="next"/);
  const two = (await (await rest(`/actions/runs/${runId}/artifacts?name=two`)).json()).artifacts[0];
  assert.equal((await (await rest(`/actions/artifacts/${two.id}`)).json()).name, "two");

  // The download is the tarball the runner uploaded.
  const zip = await rest(`/actions/artifacts/${two.id}/zip`, { redirect: "manual" });
  assert.equal(zip.status, 302);
  const blob = await fetch(zip.headers.get("location"));
  assert.equal(blob.status, 200);
  assert.equal(blob.headers.get("content-type"), "application/gzip");
  assert.match(blob.headers.get("content-disposition") ?? "", /two\.tar\.gz/);
  assert.equal(await blob.text(), "two");

  // Deleting it removes it for the runner too.
  assert.equal((await rest(`/actions/artifacts/${two.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await rest(`/actions/artifacts/${two.id}`)).status, 404);
  assert.equal((await fetch(`${at}/artifacts/two`, { headers: h })).status, 404);
  assert.equal(await (await fetch(`${at}/artifacts/one`, { headers: h })).text(), "one");
  assert.equal((await (await rest("/actions/artifacts")).json()).total_count, 2);
  assert.equal((await fetch(`${at}/complete`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ conclusion: "success", outputs: {} }) })).status, 200);
});

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status === 0;

test("containers: a job container and service containers on a self-hosted runner", { skip: !hasDocker && "Docker is not available" }, async () => {
  const owner = (await ok("GET", "/user")).login;
  await ok("POST", "/user/repos", { name: "boxes" });
  const src = join(work, "boxes");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  // Docker Hub rate-limits anonymous pulls; mirror.gcr.io serves the same official images.
  writeFileSync(
    join(src, ".github/workflows/ci.yml"),
    `on: push
jobs:
  boxed:
    runs-on: [self-hosted, linux]
    container:
      image: mirror.gcr.io/library/debian:\${{ github.event_name == 'push' && 'bookworm-slim' || 'nope' }}
    services:
      cache:
        image: mirror.gcr.io/library/redis:7-alpine
        options: --health-cmd "redis-cli ping" --health-interval 1s --health-retries 30
    steps:
      - run: |
          grep -q bookworm /etc/os-release && echo "inside debian"
          exec 3<>/dev/tcp/cache/6379
          printf 'PING\\r\\n' >&3
          read -r line <&3
          echo "cache answered \${line%$'\\r'}"
`,
  );
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "."]);
  git(src, ["commit", "-q", "-m", "containers"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/boxes.git`]);
  git(src, ["push", "-q", "origin", "main"]);

  const run = await until("boxes run", async () => (await ok("GET", `/repos/${owner}/boxes/actions/runs`)).workflow_runs[0]);
  const boxed = await runOneJob(owner, "boxes");
  assert.equal(boxed.claim.name, "boxed");
  const log = await (await fetch(`${base}/api/v3/repos/${owner}/boxes/actions/jobs/${boxed.claim.job_id}/logs`, { headers: { authorization: `Bearer ${token}` } })).text();
  assert.match(log, /inside debian/);
  assert.match(log, /cache answered \+PONG/);
  const done = await until("boxes run to complete", async () => {
    const r = await ok("GET", `/repos/${owner}/boxes/actions/runs/${run.id}`);
    return r.status === "completed" ? r : null;
  });
  assert.equal(done.conclusion, "success");
});

// ---------------------------------------------------------------- the official actions, unmodified

// No workflow-level permissions: jobs get the repository default (write), like GitHub's permissive default.
const TOOLKIT_WORKFLOW = `name: Toolkit
on: push
jobs:
  produce:
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@v4
        with: { lfs: true, submodules: true, persist-credentials: false }
      - name: LFS, submodules, no persisted credentials
        run: |
          cat big.bin lib/lib.txt
          git config --get-regexp 'extraheader' || echo "no persisted credentials"
      - uses: actions/checkout@v4
        with: { path: sparse, sparse-checkout: docs }
      - run: echo "sparse=$(ls sparse | tr '\\n' ' ')"
      - id: real-cache
        uses: actions/cache@v4
        env: { DIFFINERY_BUILTINS: "false" }
        with: { path: deps, key: "deps-\${{ hashFiles('lock.txt') }}" }
      - if: steps.real-cache.outputs.cache-hit != 'true'
        run: mkdir -p deps && echo "saved by run \${{ github.run_id }}" > deps/marker
      - run: echo "real-hit=\${{ steps.real-cache.outputs.cache-hit }} $(cat deps/marker)"
      - id: builtin-cache
        uses: actions/cache/restore@v4
        with: { path: deps, key: "deps-\${{ hashFiles('lock.txt') }}", lookup-only: true }
      - id: v3-cache
        uses: actions/cache/restore@v3
        env: { DIFFINERY_BUILTINS: "false" }
        with: { path: deps, key: "deps-\${{ hashFiles('lock.txt') }}", lookup-only: true }
      - run: echo "builtin-hit=\${{ steps.builtin-cache.outputs.cache-hit }} v3-hit=\${{ steps.v3-cache.outputs.cache-hit }}"
      - run: mkdir -p dist/sub && echo one > dist/one.txt && echo two > dist/sub/two.txt && echo hidden > dist/.hidden
      - id: up-real
        uses: actions/upload-artifact@v4
        env: { DIFFINERY_BUILTINS: "false" }
        with: { name: dist-real, path: dist/, include-hidden-files: true, retention-days: 3 }
      - id: up-builtin
        uses: actions/upload-artifact@v4
        with: { name: dist-builtin, path: dist/, compression-level: 0 }
      - run: echo "ids=\${{ steps.up-real.outputs.artifact-id }},\${{ steps.up-builtin.outputs.artifact-id }} url=\${{ steps.up-real.outputs.artifact-url }}"
  consume:
    needs: produce
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/download-artifact@v4
        env: { DIFFINERY_BUILTINS: "false" }
        with: { path: all }
      - uses: actions/download-artifact@v4
        with: { pattern: dist-*, path: merged, merge-multiple: true }
      - uses: actions/download-artifact@v4
        env: { DIFFINERY_BUILTINS: "false" }
        with: { name: dist-builtin, path: one }
      - run: find all merged one -type f | LC_ALL=C sort | tr '\\n' ' '
      - uses: actions/checkout@v4
        with: { path: src }
      - id: prev
        run: echo "id=$(cat src/prev-run.txt 2>/dev/null)" >> "$GITHUB_OUTPUT"
      - if: steps.prev.outputs.id != ''
        uses: actions/download-artifact@v4
        env: { DIFFINERY_BUILTINS: "false" }
        with: { name: dist-real, path: prev-real, run-id: "\${{ steps.prev.outputs.id }}", github-token: "\${{ github.token }}", repository: "\${{ github.repository }}" }
      - if: steps.prev.outputs.id != ''
        uses: actions/download-artifact@v4
        with: { pattern: "dist-*", path: prev-builtin, run-id: "\${{ steps.prev.outputs.id }}", github-token: "\${{ github.token }}" }
      - if: steps.prev.outputs.id != ''
        run: echo "previous run $(cat prev-real/sub/two.txt) $(find prev-builtin -type f | LC_ALL=C sort | tr '\\n' ' ')"
  script:
    runs-on: [self-hosted, linux]
    steps:
      - id: gs
        uses: actions/github-script@v7
        with:
          result-encoding: string
          script: |
            const { owner, repo } = context.repo;
            const label = \`from-run-\${context.runId}\`;
            await github.rest.issues.createLabel({ owner, repo, name: label, color: "ff0000" });
            const { data: issue } = await github.rest.issues.create({ owner, repo, title: \`Opened by run \${context.runId}\`, body: "hello", labels: [label] });
            await github.rest.issues.createComment({ owner, repo, issue_number: issue.number, body: "commented by github-script" });
            const { data: comments } = await github.rest.issues.listComments({ owner, repo, issue_number: issue.number });
            const { data: got } = await github.rest.issues.get({ owner, repo, issue_number: issue.number });
            const { data: pulls } = await github.rest.pulls.list({ owner, repo, state: "all" });
            await github.rest.repos.createCommitStatus({ owner, repo, sha: context.sha, state: "success", context: "github-script", description: "set with the default GITHUB_TOKEN" });
            return \`issue=\${issue.number} labels=\${got.labels.map((l) => l.name)} comments=\${comments.length} pulls=\${pulls.length} event=\${context.eventName} repo=\${context.payload.repository.full_name} sender=\${context.payload.sender.login}\`;
      - run: echo "script says $RESULT"
        env: { RESULT: "\${{ steps.gs.outputs.result }}" }
  restricted:
    runs-on: [self-hosted, linux]
    permissions: { contents: read }
    steps:
      - id: gs
        uses: actions/github-script@v7
        with:
          result-encoding: string
          script: |
            const { owner, repo } = context.repo;
            const { data: meta } = await github.rest.repos.get({ owner, repo });
            try {
              await github.rest.issues.create({ owner, repo, title: "must not be created" });
              return "issue write allowed";
            } catch (e) {
              return \`repo=\${meta.name} issue write -> \${e.status}: \${e.message}\`;
            }
      - run: echo "restricted says $RESULT"
        env: { RESULT: "\${{ steps.gs.outputs.result }}" }
  node:
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@v4
      - id: node
        uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci --no-audit --no-fund && echo "node=$(node --version) npm-cache-hit=\${{ steps.node.outputs.cache-hit }}"
  java:
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@v4
      - id: java
        uses: actions/setup-java@v4
        with: { distribution: oracle, java-version: "21", cache: maven }
      - run: |
          mkdir -p ~/.m2/repository/e2e && echo "run \${{ github.run_id }}" > ~/.m2/repository/e2e/marker
          echo "java=$(java -version 2>&1 | grep version) maven-cache-hit=\${{ steps.java.outputs.cache-hit }} $(cat ~/.m2/repository/e2e/marker)"
`;

/** Runs every job of `run` with the real agent; returns their logs by job name. */
async function runToolkit(owner, run) {
  const home = join(work, "toolkit-home");
  const logs = {};
  for (let i = 0; i < 6; i++) {
    const job = await runOneJob(owner, "toolkit", {
      timeoutMs: 420_000,
      envFor: (claim) => {
        // A fresh HOME per job (at the same path, as on hosted runners): caches must come from the cache service.
        rmSync(home, { recursive: true, force: true });
        mkdirSync(home, { recursive: true });
        return {
          ...(process.env.E2E_RUNNER_IMAGE ? {} : { HOME: home, RUNNER_TOOL_CACHE: join(work, "toolcache") }),
          // The node job runs every action for real, checkout and setup-node included.
          ...(claim.name === "node" ? { DIFFINERY_DISABLE_BUILTINS: "1" } : {}),
        };
      },
    });
    // Without the timestamps, so assertions can span lines.
    const raw = await (await fetch(`${base}/api/v3/repos/${owner}/toolkit/actions/jobs/${job.claim.job_id}/logs`, { headers: { authorization: `Bearer ${token}` } })).text();
    logs[job.claim.name] = raw.replace(/^\S+Z /gm, "");
    // Kept with E2E_KEEP=1 for debugging.
    mkdirSync(join(work, "toolkit-logs"), { recursive: true });
    writeFileSync(join(work, "toolkit-logs", `run${run.run_number}-${job.claim.name}.log`), `${logs[job.claim.name]}\n--- agent ---\n${job.out}`);
  }
  const done = await until("toolkit run to complete", async () => {
    const r = await ok("GET", `/repos/${owner}/toolkit/actions/runs/${run.id}`);
    return r.status === "completed" ? r : null;
  });
  assert.equal(done.conclusion, "success", JSON.stringify(logs, null, 2).slice(-8000));
  return logs;
}

const toolkit = {};

test("official actions: checkout, cache, artifacts, github-script and setup-* run unmodified", { timeout: 1_200_000 }, async () => {
  const owner = (await ok("GET", "/user")).login;
  toolkit.owner = owner;
  // A submodule repository, then the main one (LFS object, submodule, sparse-checkout target).
  // Public: like GITHUB_TOKEN, the job token reads only its own repository and public ones.
  await ok("POST", "/user/repos", { name: "toolkit-lib", visibility: "public" });
  const lib = join(work, "toolkit-lib");
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, "lib.txt"), "from the submodule\n");
  git(lib, ["init", "-q", "-b", "main"]);
  git(lib, ["add", "."]);
  git(lib, ["commit", "-q", "-m", "lib"]);
  git(lib, ["remote", "add", "origin", `${base}/${owner}/toolkit-lib.git`]);
  git(lib, ["push", "-q", "origin", "main"]);
  const libSha = git(lib, ["rev-parse", "HEAD"]).trim();

  await ok("POST", "/user/repos", { name: "toolkit" });
  // Jobs without permissions: write with the default token (the setting older repositories keep).
  await ok("PUT", `/repos/${owner}/toolkit/actions/permissions/workflow`, { default_workflow_permissions: "write" });
  const src = join(work, "toolkit");
  toolkit.src = src;
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  mkdirSync(join(src, "docs"));
  writeFileSync(join(src, ".github/workflows/toolkit.yml"), TOOLKIT_WORKFLOW);
  writeFileSync(join(src, "docs/guide.md"), "# guide\n");
  writeFileSync(join(src, "README.md"), "# toolkit\n");
  writeFileSync(join(src, "lock.txt"), "v1\n");
  writeFileSync(join(src, "package.json"), JSON.stringify({ name: "toolkit", version: "1.0.0", private: true }, null, 2) + "\n");
  writeFileSync(join(src, "package-lock.json"), JSON.stringify({ name: "toolkit", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "toolkit", version: "1.0.0" } } }, null, 2) + "\n");
  writeFileSync(join(src, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion><groupId>e2e</groupId><artifactId>toolkit</artifactId><version>1</version></project>\n");
  writeFileSync(join(src, ".gitmodules"), '[submodule "lib"]\n\tpath = lib\n\turl = ../toolkit-lib.git\n');
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["lfs", "install", "--local"]);
  git(src, ["lfs", "track", "*.bin"]);
  writeFileSync(join(src, "big.bin"), "the real LFS content\n");
  git(src, ["add", "-A"]);
  git(src, ["update-index", "--add", "--cacheinfo", `160000,${libSha},lib`]);
  git(src, ["commit", "-q", "-m", "toolkit"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/toolkit.git`]);
  git(src, ["push", "-q", "origin", "main"]);
  assert.match(git(src, ["show", "HEAD:big.bin"]), /git-lfs/, "big.bin is stored as an LFS pointer");

  const run = await until("toolkit run", async () => (await ok("GET", `/repos/${owner}/toolkit/actions/runs`)).workflow_runs[0]);
  toolkit.firstRun = run;
  const logs = await runToolkit(owner, run);

  // checkout: LFS content, submodule over HTTP with the job token, credentials not persisted, sparse
  assert.match(logs.produce, /the real LFS content\nfrom the submodule/);
  assert.match(logs.produce, /no persisted credentials/);
  assert.match(logs.produce, /sparse=README\.md big\.bin docs lib lock\.txt package-lock\.json package\.json pom\.xml /);
  // cache: a miss on the first run, for the real action and the built-in alike
  assert.match(logs.produce, /real-hit= saved by run 1\b/);
  assert.match(logs.produce, /builtin-hit= v3-hit=/);
  assert.match(logs.produce, /Cache saved with (the )?key: deps-[0-9a-f]{64}/);
  // artifacts: ids from both uploads, the URL points back at this server
  assert.match(logs.produce, new RegExp(`ids=\\d+,\\d+ url=${base}/${owner}/toolkit/actions/runs/1/artifacts/\\d+`));
  assert.match(
    logs.consume,
    /all\/dist-builtin\/one\.txt all\/dist-builtin\/sub\/two\.txt all\/dist-real\/\.hidden all\/dist-real\/one\.txt all\/dist-real\/sub\/two\.txt merged\/\.hidden merged\/one\.txt merged\/sub\/two\.txt one\/one\.txt one\/sub\/two\.txt/,
  );
  // github-script: REST calls with the job token
  assert.match(logs.script, /script says issue=1 labels=from-run-1 comments=1 pulls=0 event=push repo=[^/]+\/toolkit sender=\S+/);
  const issue = await ok("GET", `/repos/${owner}/toolkit/issues/1`);
  assert.equal(issue.title, "Opened by run 1");
  assert.deepEqual(issue.labels.map((l) => l.name), ["from-run-1"]);
  assert.equal((await ok("GET", `/repos/${owner}/toolkit/issues/1/comments`))[0].body, "commented by github-script");
  const statuses = await ok("GET", `/repos/${owner}/toolkit/commits/${run.head_sha}/statuses`);
  assert.equal(statuses.find((s) => s.context === "github-script")?.state, "success", JSON.stringify(statuses));
  // `permissions: { contents: read }`: reading works, issue writes are refused
  assert.match(logs.restricted, /restricted says repo=toolkit issue write -> 403: .*issues/);
  assert.equal((await ok("GET", `/repos/${owner}/toolkit/issues?state=all`)).filter((i) => i.title === "must not be created").length, 0);
  // setup-node (the real action, DIFFINERY_DISABLE_BUILTINS=1) and setup-java: installed, caches saved
  assert.match(logs.node, /node=v20\.\d+\.\d+ npm-cache-hit=false/);
  assert.match(logs.node, /Cache saved with (the )?key: node-cache-Linux-x64-npm-[0-9a-f]{64}/);
  assert.match(logs.java, /java=java version "21[^\n]* maven-cache-hit=false run 1/);
  assert.match(logs.java, /Cache saved with (the )?key: setup-java-Linux-x64-maven-[0-9a-f]{64}/);

  // the REST API lists the run's artifacts and caches
  const artifacts = await ok("GET", `/repos/${owner}/toolkit/actions/runs/1/artifacts`);
  assert.deepEqual(artifacts.artifacts.map((a) => a.name).sort(), ["dist-builtin", "dist-real"]);
  const caches = await ok("GET", `/repos/${owner}/toolkit/actions/caches`);
  assert.equal(caches.total_count, 3, JSON.stringify(caches));
  const zip = await fetch(`${base}/api/v3/repos/${owner}/toolkit/actions/artifacts/${artifacts.artifacts[0].id}/zip`, { headers: { authorization: `Bearer ${token}` }, redirect: "manual" });
  assert.equal(zip.status, 302);
  assert.equal((await fetch(zip.headers.get("location"))).headers.get("content-type"), "application/zip");
});

test("official actions: the second run hits every cache and reads the first run's artifacts", { timeout: 1_200_000 }, async () => {
  const { owner, src, firstRun } = toolkit;
  assert.ok(firstRun, "the first toolkit run must have completed");
  writeFileSync(join(src, "prev-run.txt"), `${firstRun.run_number}\n`);
  git(src, ["add", "prev-run.txt"]);
  git(src, ["commit", "-q", "-m", "second run"]);
  git(src, ["push", "-q", "origin", "main"]);
  const run = await until("second toolkit run", async () => (await ok("GET", `/repos/${owner}/toolkit/actions/runs`)).workflow_runs.find((r) => r.run_number === 2));
  const logs = await runToolkit(owner, run);

  // The entry the real action saved restores with the real action (v4 and v3) and the built-in.
  assert.match(logs.produce, /real-hit=true saved by run 1\b/);
  assert.match(logs.produce, /builtin-hit=true v3-hit=true/);
  assert.match(logs.produce, /Cache hit occurred on the primary key deps-[0-9a-f]{64}, not saving cache\./);
  assert.match(logs.node, /npm-cache-hit=true/);
  assert.match(logs.java, /maven-cache-hit=true run 2/);
  // Artifacts of another run, through the REST API with github-token (real action and built-in).
  assert.match(logs.consume, /previous run two prev-builtin\/dist-builtin\/one\.txt prev-builtin\/dist-builtin\/sub\/two\.txt prev-builtin\/dist-real\/\.hidden prev-builtin\/dist-real\/one\.txt prev-builtin\/dist-real\/sub\/two\.txt/);
  assert.match(logs.script, /script says issue=2 labels=from-run-2 comments=1/);
});

test("objects of every size: files from 0 bytes to 1.2 MB, read cold after a restart, come back intact from contents, diffs, pushes and clones", async () => {
  // A server of its own, restarted after the first push so nothing is in memory: reads then inflate
  // every object from storage, as in production.
  let server = await startServer("cold-sizes");
  try {
    let c = client(server);
    const me = await c.ok("GET", "/user");
    await c.ok("POST", "/user/repos", { name: "cold-sizes" });
    const src = join(work, "cold-sizes");
    mkdirSync(src, { recursive: true });
    await c.git(src, ["init", "-q", "-b", "main"]);
    // Around zlib's and the runtime's buffer steps, as text and as random base64. Workers' own zlib once
    // refused 41,271, 65,536 and 101,330 bytes when told the exact size (#277), which Node's zlib, and so
    // the unit tests, never do.
    const sizes = [0, 1, 1000, 16_384, 16_385, 32_769, 41_271, 49_153, 65_535, 65_536, 65_537, 98_304, 101_330, 131_073, 200_000, 524_289, 1_048_576, 1_048_577, 1_200_000];
    const words = "the quick brown fox jumps over a lazy dog while git packs objects into zlib streams".split(" ");
    const text = (n) => {
      let t = "";
      for (let i = 0; t.length < n; i++) t += words[(i * 7 + (i >> 3)) % words.length] + (i % 11 === 10 ? "\n" : " ");
      return Buffer.from(t.slice(0, n));
    };
    const random = (n) => Buffer.from(randomBytes(Math.ceil(n * 0.75) + 3).toString("base64").slice(0, n));
    const files = new Map(sizes.flatMap((n) => [[`text${n}.txt`, text(n)], [`b64-${n}.txt`, random(n)]]));
    for (const [name, data] of files) writeFileSync(join(src, name), data);
    await c.git(src, ["add", "-A"]);
    await c.git(src, ["commit", "-q", "-m", "every size"]);
    const first = (await c.git(src, ["rev-parse", "HEAD"])).trim();
    await c.git(src, ["-c", "http.postBuffer=1048576", "push", "-q", `${c.gitBase}/${me.login}/cold-sizes.git`, "main"]);

    server.stop();
    while (await fetch(`${server.base}/healthz`).then(() => true, () => false)) await sleep(500);
    await sleep(1000);
    server = await startServer("cold-sizes", { restart: true });
    c = client(server);

    // A second push changes each file by a line: git sends deltas against the objects the server has,
    // so taking it in reads each base cold.
    for (const [name, data] of files) writeFileSync(join(src, name), Buffer.concat([data, Buffer.from("\nchanged\n")]));
    await c.git(src, ["add", "-A"]);
    await c.git(src, ["commit", "-q", "-m", "every size, changed"]);
    await c.git(src, ["-c", "http.postBuffer=1048576", "push", "-q", `${c.gitBase}/${me.login}/cold-sizes.git`, "main"]);
    // The commit's diff reads both versions of each file.
    const commit = await c.ok("GET", `/repos/${me.login}/cold-sizes/commits/main`);
    assert.equal(commit.files.length, files.size);
    const read = async (path, accept) => {
      const res = await fetch(`${server.base}/api/v3${path}`, { headers: { authorization: `Bearer ${server.token}`, accept } });
      assert.equal(res.status, 200, `${path}: ${res.status} ${(await res.clone().text()).slice(0, 300)}`);
      return res;
    };
    for (const [name, data] of files) {
      const res = await read(`/repos/${me.login}/cold-sizes/contents/${name}?ref=${first}`, "application/vnd.github.raw");
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(data), `${name} reads back as first pushed`);
      if (data.length <= 1024 * 1024) {
        const json = await (await read(`/repos/${me.login}/cold-sizes/contents/${name}?ref=${first}`, "application/json")).json();
        assert.ok(Buffer.from(json.content, "base64").equals(data), `${name} in JSON reads back as first pushed`);
      }
    }
    const out = join(work, "cold-sizes-clone");
    await c.git(work, ["clone", "-q", `${c.gitBase}/${me.login}/cold-sizes.git`, out]);
    await c.git(out, ["fsck", "--full", "--strict"]);
    assert.equal((await c.git(out, ["rev-parse", "HEAD"])).trim(), (await c.git(src, ["rev-parse", "HEAD"])).trim());
  } finally {
    server.stop();
  }
});

test("D1 sessions: bookmarks for token clients and browsers", async () => {
  // Token clients get the bookmark in a header and can send it back to read their own writes.
  const r = await fetch(`${base}/api/v3/user`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  const bookmark = r.headers.get("x-d1-bookmark");
  assert.match(bookmark ?? "", /^[0-9a-f]+(-[0-9a-f]+)+$/i);
  assert.equal(r.headers.get("set-cookie"), null);
  const again = await fetch(`${base}/api/v3/user`, { headers: { authorization: `Bearer ${token}`, "x-d1-bookmark": bookmark } });
  assert.equal(again.status, 200);
  // A junk bookmark is ignored rather than breaking the request.
  assert.equal((await fetch(`${base}/api/v3/user`, { headers: { authorization: `Bearer ${token}`, "x-d1-bookmark": "nope" } })).status, 200);
  // Anonymous page views don't get a cookie; a browser that writes (any non-GET) does.
  assert.equal((await fetch(`${base}/`)).headers.get("set-cookie")?.includes("__Host-dfy_d1") ?? false, false);
  const post = await fetch(`${base}/auth/logout`, { method: "POST", redirect: "manual", headers: { "sec-fetch-site": "same-origin" } });
  assert.match(post.headers.get("set-cookie") ?? "", /__Host-dfy_d1=[0-9a-f-]+; Max-Age=86400; Path=\/; HttpOnly; Secure; SameSite=Lax/);
});

test("GitHub REST compatibility: Octokit against releases, statuses, git data, issues, deployments and search", async () => {
  const { Octokit } = await import("@octokit/rest");
  const gh = new Octokit({ auth: token, baseUrl: `${base}/api/v3`, userAgent: "diffinery-e2e", request: { retries: 0 } });
  const owner = (await gh.rest.users.getAuthenticated()).data.login;
  const repo = "compat";
  const R = { owner, repo };

  // ------------------------------------------------------------ repository, pushed with git
  const created = await gh.rest.repos.createForAuthenticatedUser({ name: repo, description: "Octokit compatibility" });
  assert.equal(created.status, 201);
  assert.equal(created.data.full_name, `${owner}/${repo}`);
  assert.match(created.data.node_id, /\S/);
  assert.equal(created.data.owner.login, owner);
  const src = join(work, "compat");
  mkdirSync(join(src, "src"), { recursive: true });
  writeFileSync(join(src, "README.md"), "# compat\n");
  writeFileSync(join(src, "src/main.ts"), "export const x = 1;\n");
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "initial"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/${repo}.git`]);
  git(src, ["push", "-q", "origin", "main"]);
  const mainSha = git(src, ["rev-parse", "HEAD"]).trim();

  const r = await gh.rest.repos.get(R);
  assert.equal(r.data.default_branch, "main");
  assert.equal(r.data.permissions.admin, true);
  assert.equal(r.headers["x-github-media-type"], "github.v3; format=json");
  const rate = await gh.rest.rateLimit.get();
  assert.ok(rate.data.resources.core.remaining > 0);

  // GitHub error bodies: message and documentation_url, surfaced by Octokit's RequestError.
  await assert.rejects(gh.rest.repos.getContent({ ...R, path: "missing.txt" }), (e) => e.status === 404 && typeof e.response.data.message === "string" && typeof e.response.data.documentation_url === "string");

  // ------------------------------------------------------------ contents
  const readme = await gh.rest.repos.getContent({ ...R, path: "README.md" });
  assert.equal(readme.data.type, "file");
  assert.equal(Buffer.from(readme.data.content, "base64").toString(), "# compat\n");
  const rawReadme = await gh.rest.repos.getContent({ ...R, path: "README.md", mediaType: { format: "raw" } });
  assert.equal(rawReadme.data, "# compat\n");
  const dir = await gh.rest.repos.getContent({ ...R, path: "src" });
  assert.deepEqual(dir.data.map((e) => e.name), ["main.ts"]);
  await assert.rejects(gh.rest.repos.createOrUpdateFileContents({ ...R, path: "README.md", message: "stale", content: Buffer.from("x").toString("base64"), sha: "0".repeat(40) }), (e) => e.status === 409);
  const put = await gh.rest.repos.createOrUpdateFileContents({ ...R, path: "README.md", message: "Update README", content: Buffer.from("# compat\n\nUpdated.\n").toString("base64"), sha: readme.data.sha, committer: { name: "Release Bot", email: "bot@example.com" } });
  assert.equal(put.status, 200);
  assert.equal(put.data.commit.committer.name, "Release Bot");
  const added = await gh.rest.repos.createOrUpdateFileContents({ ...R, path: "docs/guide.md", message: "Add guide", content: Buffer.from("guide\n").toString("base64") });
  assert.equal(added.status, 201);
  const readmeApi = await gh.rest.repos.getReadme(R);
  assert.equal(readmeApi.data.path, "README.md");

  // ------------------------------------------------------------ git data: blob -> tree -> commit -> ref, then git sees it
  const headSha = (await gh.rest.git.getRef({ ...R, ref: "heads/main" })).data.object.sha;
  assert.equal(headSha, added.data.commit.sha);
  const blob = await gh.rest.git.createBlob({ ...R, content: Buffer.from("made with the git data API\n").toString("base64"), encoding: "base64" });
  assert.equal(blob.status, 201);
  assert.equal(Buffer.from((await gh.rest.git.getBlob({ ...R, file_sha: blob.data.sha })).data.content, "base64").toString(), "made with the git data API\n");
  const headCommit = await gh.rest.git.getCommit({ ...R, commit_sha: headSha });
  const tree = await gh.rest.git.createTree({ ...R, base_tree: headCommit.data.tree.sha, tree: [{ path: "gitdata/hello.txt", mode: "100644", type: "blob", sha: blob.data.sha }, { path: "inline.txt", mode: "100644", type: "blob", content: "inline\n" }] });
  const full = await gh.rest.git.getTree({ ...R, tree_sha: tree.data.sha, recursive: "true" });
  assert.ok(full.data.tree.some((e) => e.path === "gitdata/hello.txt" && e.type === "blob"));
  assert.ok(full.data.tree.some((e) => e.path === "src/main.ts"));
  const commit = await gh.rest.git.createCommit({ ...R, message: "Commit from the git data API", tree: tree.data.sha, parents: [headSha], author: { name: "Diffy", email: "diffy@example.com", date: "2024-05-06T07:08:09Z" } });
  assert.equal(commit.data.author.name, "Diffy");
  assert.deepEqual(commit.data.parents.map((p) => p.sha), [headSha]);
  const ref = await gh.rest.git.createRef({ ...R, ref: "refs/heads/feature", sha: commit.data.sha });
  assert.equal(ref.data.ref, "refs/heads/feature");
  assert.equal(ref.data.object.type, "commit");
  await assert.rejects(gh.rest.git.createRef({ ...R, ref: "refs/heads/feature", sha: commit.data.sha }), (e) => e.status === 422);
  const matching = await gh.rest.git.listMatchingRefs({ ...R, ref: "heads/f" });
  assert.deepEqual(matching.data.map((x) => x.ref), ["refs/heads/feature"]);
  const tag = await gh.rest.git.createTag({ ...R, tag: "v0.1.0", message: "Annotated tag", object: commit.data.sha, type: "commit", tagger: { name: "Diffy", email: "diffy@example.com", date: "2024-05-06T07:08:09Z" } });
  await gh.rest.git.createRef({ ...R, ref: "refs/tags/v0.1.0", sha: tag.data.sha });
  assert.equal((await gh.rest.git.getTag({ ...R, tag_sha: tag.data.sha })).data.object.sha, commit.data.sha);
  assert.equal((await gh.rest.git.getRef({ ...R, ref: "tags/v0.1.0" })).data.object.type, "tag");
  git(src, ["fetch", "-q", "origin", "feature", "--tags"]);
  assert.equal(git(src, ["show", "FETCH_HEAD:gitdata/hello.txt"]), "made with the git data API\n");
  assert.equal(git(src, ["cat-file", "-t", "v0.1.0"]).trim(), "tag");

  // ------------------------------------------------------------ commit statuses count as checks, also for required checks
  await ok("PUT", `/repos/${owner}/${repo}/branches/main/protection`, { requirePullRequest: true, requiredChecks: ["ci/external"] });
  const pr = await gh.rest.pulls.create({ ...R, title: "Feature", head: "feature", base: "main", body: "Adds files" });
  assert.equal(pr.status, 201);
  const pending = await until("mergeability", async () => {
    const p = (await gh.rest.pulls.get({ ...R, pull_number: pr.data.number })).data;
    return typeof p.mergeable === "boolean" ? p : null;
  });
  assert.equal(pending.mergeable, true);
  assert.equal(pending.mergeable_state, "blocked");
  assert.equal(pending.head.sha, commit.data.sha);
  const st = await gh.rest.repos.createCommitStatus({ ...R, sha: commit.data.sha, state: "success", context: "ci/external", description: "External CI passed", target_url: "https://ci.example.com/build/1" });
  assert.equal(st.status, 201);
  assert.equal(st.data.creator.login, owner);
  await assert.rejects(gh.rest.repos.createCommitStatus({ ...R, sha: commit.data.sha, state: "great" }), (e) => e.status === 422);
  const combined = await gh.rest.repos.getCombinedStatusForRef({ ...R, ref: "feature" });
  assert.equal(combined.data.state, "success");
  assert.equal(combined.data.total_count, 1);
  assert.equal(combined.data.statuses[0].context, "ci/external");
  assert.equal((await gh.rest.repos.listCommitStatusesForRef({ ...R, ref: commit.data.sha })).data.length, 1);
  const clean = (await gh.rest.pulls.get({ ...R, pull_number: pr.data.number })).data;
  assert.equal(clean.mergeable_state, "clean");
  const prPage = await (await fetch(`${base}/${owner}/${repo}/pull/${pr.data.number}/checks`)).text();
  assert.match(prPage, /ci\/external/);
  assert.match(prPage, /https:\/\/ci\.example\.com\/build\/1/);

  // ------------------------------------------------------------ pull request sub-resources
  const byHead = await gh.rest.pulls.list({ ...R, head: `${owner}:feature`, state: "open" });
  assert.deepEqual(byHead.data.map((p) => p.number), [pr.data.number]);
  assert.equal((await gh.rest.pulls.list({ ...R, base: "other" })).data.length, 0);
  const assoc = await gh.rest.repos.listPullRequestsAssociatedWithCommit({ ...R, commit_sha: commit.data.sha });
  assert.deepEqual(assoc.data.map((p) => p.number), [pr.data.number]);
  const rc = await gh.rest.pulls.createReviewComment({ ...R, pull_number: pr.data.number, body: "Why this file?", commit_id: commit.data.sha, path: "inline.txt", line: 1, side: "RIGHT" });
  assert.equal(rc.status, 201);
  assert.equal(rc.data.path, "inline.txt");
  const reply = await gh.rest.pulls.createReplyForReviewComment({ ...R, pull_number: pr.data.number, comment_id: rc.data.id, body: "For the test." });
  assert.equal(reply.data.in_reply_to_id, rc.data.id);
  // Numeric ids, like GitHub's: actions parse them with Number() and pass them back.
  assert.equal(typeof rc.data.id, "number");
  assert.equal(typeof rc.data.pull_request_review_id, "number");
  assert.equal((await gh.rest.pulls.listReviewComments({ ...R, pull_number: pr.data.number })).data.length, 2);
  await gh.rest.reactions.createForPullRequestReviewComment({ ...R, comment_id: rc.data.id, content: "eyes" });
  const merged = await gh.rest.pulls.merge({ ...R, pull_number: pr.data.number, merge_method: "squash" });
  assert.equal(merged.data.merged, true);
  const merges = await gh.rest.issues.listEventsForTimeline({ ...R, issue_number: pr.data.number });
  assert.ok(merges.data.some((e) => e.event === "merged"));

  // ------------------------------------------------------------ releases and assets
  const rel = await gh.rest.repos.createRelease({ ...R, tag_name: "v1.0.0", target_commitish: "main", name: "First", generate_release_notes: true });
  assert.equal(rel.status, 201);
  assert.match(rel.data.body, /Full Changelog/);
  assert.match(rel.data.body, /Feature by @/);
  assert.equal(rel.data.author.login, owner);
  assert.match(rel.data.upload_url, /\/api\/uploads\/repos\/.+\/releases\/\d+\/assets\{\?name,label\}$/);
  assert.match(git(src, ["ls-remote", "--tags", "origin"]), /refs\/tags\/v1\.0\.0/);
  const bytes = Buffer.from("hello from a release asset\n");
  const up = await gh.rest.repos.uploadReleaseAsset({ ...R, release_id: rel.data.id, name: "hello.txt", label: "Greeting", data: bytes, url: rel.data.upload_url, headers: { "content-type": "text/plain", "content-length": bytes.length } });
  assert.equal(up.status, 201);
  assert.equal(up.data.name, "hello.txt");
  assert.equal(up.data.size, bytes.length);
  assert.equal(up.data.state, "uploaded");
  const bin = Buffer.from(randomBytes(70_000));
  const up2 = await gh.rest.repos.uploadReleaseAsset({ ...R, release_id: rel.data.id, name: "tool linux.bin", data: bin, baseUrl: `${base}/api/uploads`, headers: { "content-type": "application/octet-stream", "content-length": bin.length } });
  assert.equal(up2.data.name, "tool.linux.bin");
  await assert.rejects(gh.rest.repos.uploadReleaseAsset({ ...R, release_id: rel.data.id, name: "hello.txt", data: bytes, url: rel.data.upload_url, headers: { "content-type": "text/plain", "content-length": bytes.length } }), (e) => e.status === 422);
  const viaApi = await gh.rest.repos.getReleaseAsset({ ...R, asset_id: up2.data.id, headers: { accept: "application/octet-stream" } });
  assert.deepEqual(Buffer.from(viaApi.data), bin);
  const browser = await fetch(up.data.browser_download_url);
  assert.equal(browser.status, 200);
  assert.equal(await browser.text(), bytes.toString());
  assert.match(browser.headers.get("content-disposition") ?? "", /attachment/);
  assert.equal((await gh.rest.repos.getReleaseAsset({ ...R, asset_id: up.data.id })).data.download_count, 1);
  assert.deepEqual((await gh.rest.repos.listReleaseAssets({ ...R, release_id: rel.data.id })).data.map((a) => a.name), ["hello.txt", "tool.linux.bin"]);
  assert.equal((await gh.rest.repos.updateReleaseAsset({ ...R, asset_id: up.data.id, label: "Hello" })).data.label, "Hello");
  assert.equal((await gh.rest.repos.getLatestRelease(R)).data.id, rel.data.id);
  assert.equal((await gh.rest.repos.getReleaseByTag({ ...R, tag: "v1.0.0" })).data.assets.length, 2);
  const notes = await gh.rest.repos.generateReleaseNotes({ ...R, tag_name: "v1.1.0", previous_tag_name: "v1.0.0" });
  assert.match(notes.data.body, /compare\/v1\.0\.0\.\.\.v1\.1\.0/);
  await gh.rest.reactions.createForRelease({ ...R, release_id: rel.data.id, content: "rocket" });
  assert.equal((await gh.rest.repos.getRelease({ ...R, release_id: rel.data.id })).data.reactions.rocket, 1);

  // Drafts are for writers only; a read-only token sees neither the draft nor its tag lookup.
  const draft = await gh.rest.repos.createRelease({ ...R, tag_name: "v2.0.0-rc.1", name: "Next", draft: true, prerelease: true });
  assert.equal(draft.data.draft, true);
  const reader = await ok("POST", "/diffinery/tokens", { name: "reader", scopes: ["read"] }, null);
  const ro = new Octokit({ auth: reader.token, baseUrl: `${base}/api/v3`, request: { retries: 0 } });
  assert.deepEqual((await ro.rest.repos.listReleases(R)).data.map((x) => x.tag_name), ["v1.0.0"]);
  await assert.rejects(ro.rest.repos.getRelease({ ...R, release_id: draft.data.id }), (e) => e.status === 404);
  await assert.rejects(ro.rest.repos.createRelease({ ...R, tag_name: "v9" }), (e) => e.status === 403 || e.status === 404);
  const published = await gh.rest.repos.updateRelease({ ...R, release_id: draft.data.id, draft: false, make_latest: "false" });
  assert.equal(published.data.draft, false);
  assert.equal((await gh.rest.repos.getLatestRelease(R)).data.tag_name, "v1.0.0");
  await gh.rest.repos.deleteReleaseAsset({ ...R, asset_id: up2.data.id });
  assert.equal((await fetch(`${base}/${owner}/${repo}/releases/download/v1.0.0/tool.linux.bin`)).status, 404);
  await gh.rest.repos.deleteRelease({ ...R, release_id: published.data.id });
  await assert.rejects(gh.rest.repos.getReleaseByTag({ ...R, tag: "v2.0.0-rc.1" }), (e) => e.status === 404);

  // Archives
  const zipball = await gh.rest.repos.downloadZipballArchive({ ...R, ref: "v1.0.0" });
  assert.equal(Buffer.from(zipball.data).subarray(0, 2).toString(), "PK");
  const tarball = await gh.rest.repos.downloadTarballArchive({ ...R, ref: "main" });
  assert.deepEqual([...Buffer.from(tarball.data).subarray(0, 2)], [0x1f, 0x8b]);
  const tgz = join(work, "compat.tar.gz");
  writeFileSync(tgz, Buffer.from(tarball.data));
  assert.match(execFileSync("tar", ["tzf", tgz], { encoding: "utf8" }), /\/gitdata\/hello\.txt/);

  // The web UI: releases list, the release page and the form (CSRF, Kumo controls, multipart upload).
  const list = await (await fetch(`${base}/${owner}/${repo}/releases`)).text();
  assert.match(list, /First/);
  assert.match(list, /hello\.txt/);
  const form = await fetch(`${base}/${owner}/${repo}/releases/new`);
  const html = await form.text();
  assert.doesNotMatch(html, /<select|type="checkbox"|type="radio"/);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  const cookie = /dfy_csrf=([^;]+)/.exec(form.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(csrf && cookie);
  const fd = new FormData();
  for (const [k, v] of Object.entries({ _csrf: csrf, tag: "", new_tag: "v3.0.0", target: "main", name: "From the web", body: "Notes from the form.", latest: "1", action: "publish" })) fd.append(k, v);
  fd.append("assets", new Blob(["web upload\n"], { type: "text/plain" }), "web.txt");
  const submit = await fetch(`${base}/${owner}/${repo}/releases`, { method: "POST", body: fd, redirect: "manual", headers: { cookie: `dfy_csrf=${cookie}` } });
  assert.equal(submit.status, 303, await submit.text());
  assert.equal(submit.headers.get("location"), `/${owner}/${repo}/releases/tag/v3.0.0`);
  assert.equal(await (await fetch(`${base}/${owner}/${repo}/releases/download/v3.0.0/web.txt`)).text(), "web upload\n");
  assert.equal((await gh.rest.repos.getLatestRelease(R)).data.tag_name, "v3.0.0");
  assert.match(await (await fetch(`${base}/${owner}/${repo}`)).text(), /From the web/);

  // ------------------------------------------------------------ General settings: website and topics, and what search engines see
  const before = (await gh.rest.repos.get(R)).data;
  const settingsPage = await fetch(`${base}/${owner}/${repo}/settings`);
  const settingsHtml = await settingsPage.text();
  assert.match(settingsHtml, /id="repo-homepage"/);
  assert.match(settingsHtml, /id="repo-topics"/);
  const saveGeneral = async (fields) => {
    const r = await fetch(`${base}/${owner}/${repo}/settings/general`, {
      method: "POST",
      body: new URLSearchParams({ _csrf: /name="_csrf" value="([^"]+)"/.exec(settingsHtml)[1], name: repo, description: before.description ?? "", default_branch: before.default_branch, ...fields }),
      redirect: "manual",
      headers: { cookie: `dfy_csrf=${/dfy_csrf=([^;]+)/.exec(settingsPage.headers.get("set-cookie") ?? "")[1]}`, "sec-fetch-site": "same-origin" },
    });
    assert.equal(r.status, 303, await r.text());
    return (await gh.rest.repos.get(R)).data;
  };
  let saved = await saveGeneral({ visibility: "public", homepage: "https://example.com/project", topics: "Cloudflare ci, git ci" });
  assert.equal(saved.homepage, "https://example.com/project");
  assert.deepEqual(saved.topics, ["cloudflare", "ci", "git"]);
  const homePage = await (await fetch(`${base}/${owner}/${repo}`)).text();
  assert.match(homePage, /<a href="https:\/\/example.com\/project" rel="noopener nofollow ugc">example.com\/project<\/a>/);
  const ld = JSON.stringify(JSON.parse(/<script type="application\/ld\+json"[^>]*>([^<]+)<\/script>/.exec(homePage)[1]));
  assert.match(ld, /"@type":"SoftwareSourceCode"/);
  assert.match(ld, /"keywords":"cloudflare, ci, git"/);
  // A form without the fields leaves them alone; bad values are refused.
  saved = await saveGeneral({ visibility: before.visibility });
  assert.deepEqual([saved.homepage, saved.topics, saved.visibility], ["https://example.com/project", ["cloudflare", "ci", "git"], before.visibility]);
  assert.doesNotMatch(await (await fetch(`${base}/${owner}/${repo}`)).text(), /SoftwareSourceCode/);
  await assert.rejects(gh.rest.repos.update({ ...R, homepage: "javascript:alert(1)" }), (e) => e.status === 422);
  assert.equal((await gh.rest.repos.update({ ...R, homepage: "" })).data.homepage, null);
  assert.equal((await gh.rest.repos.replaceAllTopics({ ...R, names: [] })).data.names.length, 0);

  // ------------------------------------------------------------ issues: labels, assignees, lock, reactions, events, pagination
  await gh.rest.issues.createLabel({ ...R, name: "bug", color: "d73a4a", description: "Something is broken" });
  await assert.rejects(gh.rest.issues.createLabel({ ...R, name: "bug", color: "d73a4a" }), (e) => e.status === 422);
  const issue = await gh.rest.issues.create({ ...R, title: "Crash on start", body: "It crashes.", labels: ["bug"], assignees: [owner] });
  assert.deepEqual(issue.data.labels.map((l) => [l.name, l.color]), [["bug", "d73a4a"]]);
  assert.equal(issue.data.assignees[0].login, owner);
  assert.equal(issue.data.user.login, owner);
  assert.match(issue.data.html_url, new RegExp(`/${owner}/${repo}/issues/${issue.data.number}$`));
  const n = issue.data.number;
  await gh.rest.issues.addLabels({ ...R, issue_number: n, labels: ["triage"] });
  assert.deepEqual((await gh.rest.issues.listLabelsOnIssue({ ...R, issue_number: n })).data.map((l) => l.name).sort(), ["bug", "triage"]);
  await gh.rest.issues.removeLabel({ ...R, issue_number: n, name: "triage" });
  await gh.rest.issues.removeAssignees({ ...R, issue_number: n, assignees: [owner] });
  await gh.rest.issues.addAssignees({ ...R, issue_number: n, assignees: [owner] });
  assert.equal((await gh.rest.issues.checkUserCanBeAssigned({ ...R, assignee: owner })).status, 204);
  const comment = await gh.rest.issues.createComment({ ...R, issue_number: n, body: "Same here." });
  assert.equal(typeof comment.data.id, "number");
  assert.equal((await gh.rest.issues.getComment({ ...R, comment_id: comment.data.id })).data.body, "Same here.");
  await gh.rest.issues.updateComment({ ...R, comment_id: comment.data.id, body: "Same here!" });
  assert.equal((await gh.rest.issues.getComment({ ...R, comment_id: String(comment.data.id) })).data.body, "Same here!");
  await gh.rest.reactions.createForIssue({ ...R, issue_number: n, content: "+1" });
  const heart = await gh.rest.reactions.createForIssueComment({ ...R, comment_id: comment.data.id, content: "heart" });
  assert.equal(heart.status, 201);
  assert.equal((await gh.rest.reactions.createForIssueComment({ ...R, comment_id: comment.data.id, content: "heart" })).status, 200);
  assert.deepEqual((await gh.rest.reactions.listForIssue({ ...R, issue_number: n })).data.map((x) => x.content), ["+1"]);
  assert.equal((await gh.rest.issues.get({ ...R, issue_number: n })).data.reactions["+1"], 1);
  await gh.rest.issues.lock({ ...R, issue_number: n, lock_reason: "resolved" });
  const locked = await gh.rest.issues.get({ ...R, issue_number: n });
  assert.equal(locked.data.locked, true);
  assert.equal(locked.data.active_lock_reason, "resolved");
  await gh.rest.issues.unlock({ ...R, issue_number: n });
  await gh.rest.issues.update({ ...R, issue_number: n, title: "Crash on startup", state: "closed", state_reason: "completed" });
  const events = (await gh.rest.issues.listEvents({ ...R, issue_number: n })).data.map((e) => e.event);
  for (const e of ["labeled", "unlabeled", "unassigned", "assigned", "locked", "unlocked", "renamed", "closed"]) assert.ok(events.includes(e), `${e} in ${events}`);
  const timeline = (await gh.rest.issues.listEventsForTimeline({ ...R, issue_number: n })).data;
  assert.ok(timeline.some((e) => e.event === "commented" && e.body === "Same here!" && e.id === comment.data.id));
  assert.ok((await gh.rest.issues.listCommentsForRepo(R)).data.some((x) => x.id === comment.data.id));
  await gh.rest.issues.deleteComment({ ...R, comment_id: comment.data.id });
  await assert.rejects(gh.rest.issues.getComment({ ...R, comment_id: comment.data.id }), (e) => e.status === 404);

  for (let i = 0; i < 3; i++) await gh.rest.issues.create({ ...R, title: `Paged ${i}` });
  const page1 = await gh.rest.issues.listForRepo({ ...R, state: "all", per_page: 2 });
  assert.equal(page1.data.length, 2);
  assert.match(page1.headers.link ?? "", /rel="next"/);
  const all = await gh.paginate(gh.rest.issues.listForRepo, { ...R, state: "all", per_page: 2 });
  assert.equal(new Set(all.map((x) => x.number)).size, all.length);
  assert.ok(all.length >= 5, `paginated ${all.length} issues and pull requests`);

  // ------------------------------------------------------------ search, over readable repositories only
  const found = await until("issue search", async () => {
    const s = await gh.rest.search.issuesAndPullRequests({ q: `repo:${owner}/${repo} is:issue label:bug crash` });
    return s.data.total_count ? s.data : null;
  });
  assert.deepEqual(found.items.map((x) => x.number), [n]);
  assert.equal((await gh.rest.search.issuesAndPullRequests({ q: `repo:${owner}/${repo} is:pr is:merged` })).data.items[0].number, pr.data.number);
  assert.equal((await gh.rest.search.issuesAndPullRequests({ q: `repo:${owner}/${repo} is:issue -label:bug Paged`, sort: "created", order: "asc" })).data.items.map((x) => x.title).join(","), "Paged 0,Paged 1,Paged 2");
  await gh.rest.repos.replaceAllTopics({ ...R, names: ["octokit", "e2e"] });
  assert.deepEqual((await gh.rest.repos.getAllTopics(R)).data.names, ["octokit", "e2e"]);
  const repos = await gh.rest.search.repos({ q: `topic:octokit user:${owner}` });
  assert.deepEqual(repos.data.items.map((x) => x.full_name), [`${owner}/${repo}`]);
  assert.ok("TypeScript" in (await gh.rest.repos.listLanguages(R)).data);

  // ------------------------------------------------------------ deployments and environments
  const env = await gh.rest.repos.createOrUpdateEnvironment({ ...R, environment_name: "staging" });
  assert.equal(env.data.name, "staging");
  const dep = await gh.rest.repos.createDeployment({ ...R, ref: "main", environment: "staging", auto_merge: false, required_contexts: [], payload: { region: "eu" }, description: "Deploy to staging" });
  assert.equal(dep.status, 201);
  assert.equal(dep.data.sha, (await gh.rest.git.getRef({ ...R, ref: "heads/main" })).data.object.sha);
  assert.deepEqual(dep.data.payload, { region: "eu" });
  await gh.rest.repos.createDeploymentStatus({ ...R, deployment_id: dep.data.id, state: "in_progress" });
  const ds = await gh.rest.repos.createDeploymentStatus({ ...R, deployment_id: dep.data.id, state: "success", environment_url: "https://staging.example.com", log_url: "https://ci.example.com/deploy/1" });
  assert.equal(ds.data.state, "success");
  assert.deepEqual((await gh.rest.repos.listDeploymentStatuses({ ...R, deployment_id: dep.data.id })).data.map((x) => x.state), ["success", "in_progress"]);
  assert.equal((await gh.rest.repos.listDeployments({ ...R, environment: "staging" })).data.length, 1);
  assert.ok((await gh.rest.repos.getAllEnvironments(R)).data.environments.some((e) => e.name === "staging"));
  await gh.rest.actions.createEnvironmentVariable({ ...R, environment_name: "staging", name: "REGION", value: "eu" });
  assert.equal((await gh.rest.actions.getEnvironmentVariable({ ...R, environment_name: "staging", name: "REGION" })).data.value, "eu");
  // The environment page sets deployment branches, their patterns and the environment's secrets.
  const envUrl = `${base}/${owner}/${repo}/settings/environments/staging`;
  const envForm = async (path, fields) => {
    const pageRes = await fetch(envUrl);
    const html = await pageRes.text();
    const r = await fetch(`${envUrl}${path}`, {
      method: "POST",
      body: new URLSearchParams({ _csrf: /name="_csrf" value="([^"]+)"/.exec(html)[1], ...fields }),
      redirect: "manual",
      headers: { cookie: `dfy_csrf=${/dfy_csrf=([^;]+)/.exec(pageRes.headers.get("set-cookie") ?? "")[1]}`, "sec-fetch-site": "same-origin" },
    });
    assert.equal(r.status, 303, await r.text());
    return html;
  };
  const envState = async () => (await gh.request("GET /repos/{owner}/{repo}/environments/{environment_name}", { ...R, environment_name: "staging" })).data.deployment_branch_policy;
  const envSecrets = async () => (await gh.request("GET /repos/{owner}/{repo}/environments/{environment_name}/secrets", { ...R, environment_name: "staging" })).data.secrets.map((x) => x.name);
  assert.match(await envForm("/secrets", { name: "deploy_key", value: "env-s3cret" }), /<input type="hidden" name="branch_policy" value="all"\/>/);
  assert.deepEqual(await envSecrets(), ["DEPLOY_KEY"]);
  assert.deepEqual(await envState(), { protected_branches: true, custom_branch_policies: false }, "the first secret limits the environment to protected branches");
  await envForm("", { reviewers: "", wait_timer: "0", branch_policy: "selected" });
  assert.deepEqual(await envState(), { protected_branches: false, custom_branch_policies: true });
  await envForm("/branch-policies", { name: "release/*", type: "tag" });
  const patterns = (await gh.request("GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies", { ...R, environment_name: "staging" })).data.branch_policies;
  assert.deepEqual(patterns.map((x) => [x.name, x.type]), [["release/*", "tag"]]);
  const envHtml = await envForm("/branch-policies/delete", { id: String(patterns[0].id) });
  assert.match(envHtml, /release\/\*/);
  assert.match(envHtml, /DEPLOY_KEY/);
  assert.doesNotMatch(envHtml, /env-s3cret/);
  assert.equal((await gh.request("GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies", { ...R, environment_name: "staging" })).data.total_count, 0);
  await envForm("", { reviewers: "", wait_timer: "0", branch_policy: "all" });
  assert.equal(await envState(), null);
  await envForm("/secrets/delete", { name: "DEPLOY_KEY" });
  assert.deepEqual(await envSecrets(), []);
  await gh.rest.repos.deleteAnEnvironment({ ...R, environment_name: "staging" });

  // ------------------------------------------------------------ repository_dispatch and repository variables
  assert.equal((await gh.rest.repos.createDispatchEvent({ ...R, event_type: "deploy", client_payload: { env: "prod" } })).status, 204);
  await gh.rest.actions.createRepoVariable({ ...R, name: "COLOR", value: "blue" });
  await gh.rest.actions.updateRepoVariable({ ...R, name: "COLOR", value: "green" });
  assert.equal((await gh.rest.actions.getRepoVariable({ ...R, name: "COLOR" })).data.value, "green");
});

/** A small opaque RGBA PNG (a gradient), built by hand so the test needs no image tools. */
function pngGradient(width, height) {
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set([(x * 255) / width, (y * 255) / height, 128, 255], y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Width and height of a lossy or extended WebP, or null when it is not one. */
function webpSize(b) {
  if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}

test("people and profiles: visibility, repository invitations, blank names and usernames", async () => {
  const me = await ok("GET", "/user");
  // A form post as the signed-in dev user, with the CSRF double-submit pair taken from `page`.
  const submit = async (page, action, fields) => {
    const res = await fetch(`${base}${page}`);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await res.text())?.[1];
    const cookie = /dfy_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(csrf && cookie, `no CSRF pair on ${page}`);
    return fetch(`${base}${action}`, { method: "POST", body: new URLSearchParams({ _csrf: csrf, ...fields }), redirect: "manual", headers: { cookie: `dfy_csrf=${cookie}`, "sec-fetch-site": "same-origin" } });
  };
  const flashOf = (res) => decodeURIComponent(decodeURIComponent(res.headers.get("set-cookie") ?? ""));

  // "internal" is gone: creating and updating refuse it the same way.
  const created = await api("POST", "/user/repos", { name: "people-rules", visibility: "internal" });
  assert.equal(created.status, 422);
  await ok("POST", "/user/repos", { name: "people-rules" });
  const patched = await api("PATCH", `/repos/${me.login}/people-rules`, { visibility: "internal" });
  assert.equal(patched.status, 422);
  assert.equal(created.json.message, patched.json.message);
  assert.deepEqual(created.json.errors, patched.json.errors);

  // Inviting the same email to a repository twice (any letter case) is refused.
  const access = `/${me.login}/people-rules/settings/access`;
  const first = await submit(access, `${access}/people`, { who: "newcomer@example.com", role: "read" });
  assert.equal(first.status, 200, flashOf(first));
  assert.match(await first.text(), /newcomer@example\.com/);
  const second = await submit(access, `${access}/people`, { who: "NewComer@Example.com", role: "write" });
  assert.equal(second.status, 303);
  assert.match(flashOf(second), /already has a pending invitation/);

  // ...and it can be revoked: on the access page, in the API and over MCP. Then the address can be invited again.
  const mcp = async (name, args) => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const { result } = await r.json();
    assert.equal(result.isError, false, result.content[0].text);
    return result.structuredContent;
  };
  const repoInvites = async () => ok("GET", `/repos/${me.login}/people-rules/invitations`);
  const [pending] = await repoInvites();
  assert.equal(pending.email, "newcomer@example.com");
  assert.match(await (await fetch(`${base}${access}`)).text(), new RegExp(`action="${access}/invites/${pending.id}/revoke"`));
  const revoked = await submit(access, `${access}/invites/${pending.id}/revoke`, {});
  assert.match(flashOf(revoked), /Invitation revoked/);
  assert.deepEqual(await repoInvites(), []);
  assert.equal((await submit(access, `${access}/people`, { who: "newcomer@example.com", role: "read" })).status, 200);
  const [again] = await repoInvites();
  assert.equal((await api("DELETE", `/repos/${me.login}/people-rules/invitations/${again.id}`)).status, 204);
  assert.equal((await api("DELETE", `/repos/${me.login}/people-rules/invitations/${again.id}`)).status, 404);
  await submit(access, `${access}/people`, { who: "newcomer@example.com", role: "read" });
  const listed = (await mcp("list_invitations", { owner: me.login, repo: "people-rules" })).result;
  assert.deepEqual(listed.map((i) => i.email), ["newcomer@example.com"]);
  assert.equal((await mcp("revoke_invitation", { owner: me.login, repo: "people-rules", invitation_id: listed[0].id })).revoked, true);
  assert.deepEqual(await repoInvites(), []);

  // Organization and site invitations too; each revoke only reaches its own kind.
  await ok("POST", "/user/orgs", { login: "revokers" });
  const orgInvite = await ok("POST", "/orgs/revokers/invitations", { email: "joiner@example.com" });
  const siteInvite = await ok("POST", "/invitations", { email: "visitor@example.com" });
  assert.deepEqual((await ok("GET", "/orgs/revokers/invitations")).map((i) => i.id), [orgInvite.id]);
  const site = await ok("GET", "/invitations");
  assert.ok(site.some((i) => i.id === siteInvite.id) && !site.some((i) => i.id === orgInvite.id));
  assert.equal((await api("DELETE", `/invitations/${orgInvite.id}`)).status, 404);
  assert.equal((await api("DELETE", `/orgs/revokers/invitations/${siteInvite.id}`)).status, 404);
  assert.equal((await api("DELETE", `/orgs/revokers/invitations/${orgInvite.id}`)).status, 204);
  await ok("POST", "/orgs/revokers/invitations", { email: "joiner@example.com" });
  const [orgAgain] = (await mcp("list_invitations", { org: "revokers" })).result;
  assert.equal((await mcp("revoke_invitation", { org: "revokers", invitation_id: orgAgain.id })).revoked, true);
  assert.match(await (await fetch(`${base}/settings/admin`)).text(), new RegExp(`/settings/admin/invites/${siteInvite.id}/revoke`));
  assert.match(flashOf(await submit("/settings/admin", `/settings/admin/invites/${siteInvite.id}/revoke`, {})), /Invitation revoked/);
  assert.ok(!(await ok("GET", "/invitations")).some((i) => i.id === siteInvite.id));

  // A blank display name falls back to the username.
  const saved = await submit("/settings", "/settings/profile", { login: me.login, name: "   " });
  assert.match(flashOf(saved), /Profile saved\./);
  assert.equal((await ok("GET", `/users/${me.login}`)).name, null);
  assert.match(await (await fetch(`${base}/${me.login}`)).text(), new RegExp(`<h1[^>]*>${me.login}</h1>`));

  // Usernames: the browser's pattern and the server agree that dots aren't allowed.
  const settings = await (await fetch(`${base}/settings`)).text();
  const pattern = /name="login"[^>]*pattern="([^"]+)"/.exec(settings)?.[1];
  assert.ok(pattern, "the username field has a pattern");
  assert.equal(new RegExp(`^(?:${pattern.replaceAll("&amp;", "&")})$`, "v").test("dot.name"), false);
  assert.equal((await api("POST", "/user/orgs", { login: "dot.name" })).status, 422);
});

test("profile pictures: upload, resize, serve, cache headers and removal", async () => {
  const me = await ok("GET", "/user");
  const avatar = async (login, query = "") => {
    const r = await fetch(`${base}/api/avatars/${login}${query}`);
    assert.equal(r.status, 200);
    return { type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), csp: r.headers.get("content-security-policy"), body: Buffer.from(await r.arrayBuffer()) };
  };
  const put = (path, body, tok = token) => fetch(`${base}/api/v3${path}`, { method: "PUT", headers: { authorization: `Bearer ${tok}`, "content-type": "image/png" }, body });

  // Before any upload: generated initials, also for logins that don't exist.
  const initials = await avatar(me.login, "?s=64");
  assert.match(initials.type, /^image\/svg\+xml/);
  assert.equal(initials.csp, "default-src 'none'; style-src 'unsafe-inline'");
  assert.match((await avatar("no-such-user-here")).type, /^image\/svg\+xml/);

  // REST upload: a 600×400 PNG becomes centred square WebPs.
  const up = await put("/user/avatar", pngGradient(600, 400));
  assert.equal(up.status, 200, await up.clone().text());
  const { avatar_url } = await up.json();
  const version = new URL(avatar_url).searchParams.get("v");
  assert.match(version ?? "", /^\d+$/);
  for (const s of [64, 128, 256]) {
    const a = await avatar(me.login, `?s=${s}&v=${version}`);
    assert.equal(a.type, "image/webp");
    assert.deepEqual(webpSize(a.body), { width: s, height: s });
    assert.ok(a.body.length < 10_000, `${s}px WebP is ${a.body.length} bytes`);
    assert.match(a.cache, /immutable/);
  }
  const current = await avatar(me.login, "?s=64");
  assert.equal(current.type, "image/webp");
  assert.match(current.cache, /max-age=600/);

  // Only JPEG, PNG and WebP, sniffed from the bytes.
  const gif = await put("/user/avatar", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"));
  assert.equal(gif.status, 422);
  assert.equal((await gif.json()).message, "Use a JPEG, PNG or WebP image.");
  // Read-only tokens can't change a profile.
  const ro = (await ok("POST", "/diffinery/tokens", { name: "ro", scopes: ["read"] }, null)).token;
  assert.equal((await put("/user/avatar", pngGradient(8, 8), ro)).status, 403);

  // The web form (multipart, CSRF double-submit) takes the original file and the server resizes it.
  const page = await fetch(`${base}/settings`);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await page.text())?.[1];
  const cookie = /dfy_csrf=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(csrf && cookie);
  const form = new FormData();
  form.set("_csrf", csrf);
  form.set("avatar", new Blob([pngGradient(300, 500)], { type: "image/png" }), "me.png");
  const posted = await fetch(`${base}/settings/avatar`, { method: "POST", body: form, redirect: "manual", headers: { cookie: `dfy_csrf=${cookie}`, "sec-fetch-site": "same-origin" } });
  assert.equal(posted.status, 303);
  assert.match(decodeURIComponent(decodeURIComponent(posted.headers.get("set-cookie") ?? "")), /"kind":"notice","message":"Profile picture updated\."/);
  const settings = await (await fetch(`${base}/settings`)).text();
  const newVersion = /\/api\/avatars\/[^"?]+\?s=256&amp;v=(\d+)/.exec(settings)?.[1];
  assert.ok(newVersion && newVersion !== version, "the settings page links the new version");
  // An old version's URL gets the current picture, but not as an immutable response.
  assert.match((await avatar(me.login, `?s=64&v=${version}`)).cache, /max-age=600/);

  // Organizations: owners (admins get a 403; see the security tests).
  await ok("POST", "/user/orgs", { login: "picture-org" });
  const org = await put("/orgs/picture-org/avatar", pngGradient(64, 64));
  assert.equal(org.status, 200, await org.clone().text());
  assert.equal((await avatar("picture-org", "?s=128")).type, "image/webp");
  assert.equal((await fetch(`${base}/api/v3/orgs/picture-org/avatar`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.match((await avatar("picture-org", "?s=128")).type, /^image\/svg\+xml/);

  // Removal falls back to initials straight away (the cached copies are purged).
  const del = await fetch(`${base}/api/v3/user/avatar`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(await del.json(), { avatar_url: `${base}/api/avatars/${me.login}` });
  assert.match((await avatar(me.login, "?s=64")).type, /^image\/svg\+xml/);
});

// ---------------------------------------------------------------- GitHub imports

/** Build the fake GitHub's repositories with real git: history with a merged pull request, a draft, a fork head, tags, LFS and an old secret. */
function githubFixture(root) {
  const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Octo", GIT_AUTHOR_EMAIL: "octo@example.com", GIT_COMMITTER_NAME: "Octo", GIT_COMMITTER_EMAIL: "octo@example.com" } }).trim();
  const src = join(root, "work-app");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  g(root, "init", "-q", "-b", "main", src);
  const asset = lfsObject(`binary asset ${randomBytes(8).toString("hex")}\n`);
  writeFileSync(join(src, "README.md"), "# app\n");
  writeFileSync(join(src, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  writeFileSync(join(src, "asset.bin"), asset.pointer);
  // Would start a run on every push if imports fired workflows.
  writeFileSync(join(src, ".github/workflows/ci.yml"), "name: CI\non: [push, pull_request]\njobs:\n  build:\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: echo hi\n");
  // A credential committed long ago (built here so this file has none).
  writeFileSync(join(src, "settings.env"), `AWS_ACCESS_KEY_ID=${"AKIA"}${"Q3EGRK5V7XJZ2MWN"}\n`);
  g(src, "add", "-A");
  g(src, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "initial");
  g(src, "tag", "v0.1");
  g(src, "rm", "-q", "settings.env");
  g(src, "commit", "-q", "-m", "remove credentials");
  // Enough data that a small push budget needs several chunks.
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(src, `data${i}.bin.txt`), randomBytes(90 * 1024).toString("base64"));
    g(src, "add", "-A");
    g(src, "commit", "-q", "-m", `data ${i}`);
  }
  g(src, "checkout", "-q", "-b", "feature");
  writeFileSync(join(src, "feature.txt"), "feature\n");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "feature");
  const featureSha = g(src, "rev-parse", "HEAD");
  g(src, "checkout", "-q", "main");
  g(src, "merge", "-q", "--no-ff", "-m", "Merge pull request #2 from octo/feature", "feature");
  const mergeSha = g(src, "rev-parse", "HEAD");
  g(src, "tag", "-a", "v1.0", "-m", "Version 1.0");
  g(src, "checkout", "-q", "-b", "draft-work");
  writeFileSync(join(src, "draft.txt"), "wip\n");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "draft");
  const draftSha = g(src, "rev-parse", "HEAD");
  // A fork's commit: only GitHub's refs/pull/6/head points at it.
  g(src, "checkout", "-q", "--detach", "main");
  writeFileSync(join(src, "fork.txt"), "from a fork\n");
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "fork change");
  const forkSha = g(src, "rev-parse", "HEAD");
  g(src, "checkout", "-q", "main");
  const bare = join(root, "octo", "app.git");
  mkdirSync(join(root, "octo"), { recursive: true });
  g(root, "clone", "-q", "--bare", src, bare);
  g(bare, "update-ref", "refs/pull/2/head", featureSha);
  g(bare, "update-ref", "refs/pull/2/merge", mergeSha);
  g(bare, "update-ref", "refs/pull/5/head", draftSha);
  g(bare, "update-ref", "refs/pull/6/head", forkSha);
  g(bare, "update-ref", "refs/heads/gh-readonly-queue/main/pr-9-0123456789abcdef", mergeSha);
  // A second repository for the organization import.
  const lib = join(root, "work-lib");
  g(root, "init", "-q", "-b", "trunk", lib);
  writeFileSync(join(lib, "lib.txt"), "lib\n");
  g(lib, "add", "-A");
  g(lib, "commit", "-q", "-m", "lib");
  g(root, "clone", "-q", "--bare", lib, join(root, "octo", "lib.git"));
  return { asset, featureSha, mergeSha, draftSha, forkSha, mainSha: mergeSha };
}

test("import from GitHub: git data, issues and pull requests with their numbers, no side effects", async () => {
  const me = await ok("GET", "/user");
  const owner = me.login;
  const ghRoot = join(work, "github");
  const fx = githubFixture(ghRoot);
  const GH_TOKEN = `ghfake${randomBytes(12).toString("hex")}`;
  const t = "2024-01-02T03:04:05Z";
  const u = (login, id) => ({ login, id, type: "User" });
  const octoDev = u("octo-dev", 1001);
  const alice = u("alice", 2001);
  const bob = u("bob", 3001);
  let ghBase;
  let linkNonce = ""; // set from the link challenge, then served back in octo-dev's public gist
  let listHuge = false; // the organization lists an oversized repository once set
  const pr = (number, extra) => ({ number, title: `PR ${number}`, body: `Body of #${number}`, state: "open", user: alice, labels: [], assignees: [], milestone: null, locked: false, created_at: t, updated_at: t, closed_at: null, draft: false, merged_at: null, merge_commit_sha: null, requested_reviewers: [], head: { ref: "x", sha: fx.mainSha, label: "octo:x", repo: { full_name: "octo/app" } }, base: { ref: "main", repo: { full_name: "octo/app" } }, ...extra });
  const issue = (number, extra) => ({ number, title: `Issue ${number}`, body: `Body of #${number}`, state: "open", state_reason: null, user: octoDev, labels: [], assignees: [], milestone: null, locked: false, created_at: t, updated_at: t, closed_at: null, ...extra });
  const pulls = [
    pr(2, { title: "Add feature", state: "closed", closed_at: "2024-02-01T00:00:00Z", merged_at: "2024-02-01T00:00:00Z", merge_commit_sha: fx.mergeSha, labels: [{ name: "docs" }], head: { ref: "feature", sha: fx.featureSha, label: "octo:feature", repo: { full_name: "octo/app" } } }),
    pr(5, { title: "Work in progress", draft: true, requested_reviewers: [bob], head: { ref: "draft-work", sha: fx.draftSha, label: "octo:draft-work", repo: { full_name: "octo/app" } } }),
    pr(6, { title: "From a fork", state: "closed", closed_at: "2024-03-01T00:00:00Z", head: { ref: "patch", sha: fx.forkSha, label: "forker:patch", repo: { full_name: "forker/app" } } }),
  ];
  const issues = [
    issue(1, { title: "First bug", labels: [{ name: "bug", color: "d73a4a" }], assignees: [octoDev], milestone: { number: 1 } }),
    ...pulls.map((p) => ({ ...p, pull_request: { url: "x" } })),
    issue(3, { title: "Won't fix", user: alice, state: "closed", state_reason: "not_planned", closed_at: "2024-01-05T00:00:00Z", locked: true }),
    // #4 was deleted on GitHub: the number stays unused.
    issue(7, { title: "Latest", user: { login: "ghost-user", id: 9999 } }),
  ];
  const repoJson = (name, extra) => ({ name, full_name: `octo/${name}`, owner: { login: "octo" }, private: true, visibility: "private", fork: false, archived: false, description: `The ${name}`, homepage: "https://app.example.com", topics: ["demo", "import"], default_branch: "main", ...extra });
  const empty = [];
  const routes = {
    "GET /user": octoDev,
    // Gist-proof account linking: octo-dev's public profile, their gists, and the gist body with the nonce.
    "GET /users/octo-dev": octoDev,
    "GET /users/octo-dev/gists": () => [{ id: "proofgist", public: true, description: "", files: { "proof.md": { raw_url: `${ghBase}/raw/proofgist` } } }],
    "GET /gists/proofgist": () => ({ files: { "proof.md": { content: `linking to diffinery: ${linkNonce}` } } }),
    "GET /users/octo": { login: "octo", type: "Organization" },
    "GET /orgs/octo/repos": () => [repoJson("app"), repoJson("lib", { default_branch: "trunk", topics: [] }), ...(listHuge ? [repoJson("huge", { size: 99_999_999 })] : [])].map((r) => ({ ...r, clone_url: `${ghBase}/${r.full_name}.git` })),
    "GET /repos/octo/huge": () => ({ ...repoJson("huge", { size: 99_999_999 }), clone_url: `${ghBase}/octo/huge.git` }),
    // Only ORG_REGION reaches every repository on GitHub; Diffinery's organization variables always do.
    "GET /orgs/octo/actions/variables": { variables: [{ name: "ORG_REGION", value: "eu-west", visibility: "all" }, { name: "ORG_PRIVATE_HOST", value: "internal.example", visibility: "private" }, { name: "ORG_SELECTED_KEY", value: "few", visibility: "selected" }] },
    "GET /orgs/octo/actions/secrets": { secrets: [{ name: "ORG_DEPLOY_KEY" }] },
    "GET /repos/octo/app": () => ({ ...repoJson("app"), clone_url: `${ghBase}/octo/app.git`, html_url: `${ghBase}/octo/app` }),
    "GET /repos/octo/app/labels": [{ name: "bug", color: "d73a4a", description: "Something isn't working" }, { name: "docs", color: "0075ca", description: "Documentation" }, { name: "wontfix", color: "ffffff", description: "" }],
    "GET /repos/octo/app/milestones": [{ number: 1, title: "v1", description: "First release", state: "open", due_on: "2030-01-01T00:00:00Z", created_at: t, updated_at: t, closed_at: null, creator: octoDev }],
    "GET /repos/octo/app/pulls": pulls,
    "GET /repos/octo/app/issues": issues,
    "GET /repos/octo/app/issues/comments": () => [
      { id: 11, body: "I can reproduce this", user: alice, created_at: "2024-01-03T00:00:00Z", updated_at: "2024-01-03T00:00:00Z", issue_url: `${ghBase}/api/v3/repos/octo/app/issues/1` },
      { id: 12, body: "Thanks!", user: octoDev, created_at: "2024-01-04T00:00:00Z", updated_at: "2024-01-04T00:00:00Z", issue_url: `${ghBase}/api/v3/repos/octo/app/issues/1` },
      { id: 13, body: "Merging this", user: octoDev, created_at: "2024-01-31T00:00:00Z", updated_at: "2024-01-31T00:00:00Z", issue_url: `${ghBase}/api/v3/repos/octo/app/issues/2` },
    ],
    "GET /repos/octo/app/pulls/2/reviews": [{ id: 501, user: bob, state: "APPROVED", body: "Looks good", commit_id: fx.featureSha, submitted_at: "2024-01-30T00:00:00Z" }],
    "GET /repos/octo/app/pulls/5/reviews": [{ id: 505, user: octoDev, state: "APPROVED", body: "looks fine", commit_id: fx.draftSha, submitted_at: "2024-01-20T00:00:00Z" }],
    "GET /repos/octo/app/pulls/6/reviews": [{ id: 502, user: alice, state: "PENDING", body: "", commit_id: fx.forkSha, submitted_at: null }],
    "GET /repos/octo/app/pulls/2": { ...pulls[0], merged_by: octoDev },
    "GET /repos/octo/app/pulls/comments": () => [
      { id: 601, pull_request_review_id: 501, pull_request_url: `${ghBase}/api/v3/repos/octo/app/pulls/2`, user: bob, body: "Nice file", path: "feature.txt", line: 1, side: "RIGHT", commit_id: fx.featureSha, created_at: "2024-01-30T00:00:00Z", updated_at: "2024-01-30T00:00:00Z" },
      { id: 602, pull_request_review_id: 503, pull_request_url: `${ghBase}/api/v3/repos/octo/app/pulls/2`, in_reply_to_id: 601, user: alice, body: "Agreed", path: "feature.txt", line: 1, side: "RIGHT", commit_id: fx.featureSha, created_at: "2024-01-30T01:00:00Z", updated_at: "2024-01-30T01:00:00Z" },
    ],
    "GET /repos/octo/app/branches": [{ name: "main" }],
    "GET /repos/octo/app/branches/main/protection": { required_status_checks: { contexts: ["build"] }, required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true }, enforce_admins: { enabled: false }, allow_force_pushes: { enabled: false } },
    "GET /repos/octo/app/actions/variables": { variables: [{ name: "DEPLOY_ENV", value: "staging" }, { name: "REGION", value: "us" }] },
    "GET /repos/octo/app/actions/secrets": { secrets: [{ name: "NPM_TOKEN" }, { name: "SLACK_WEBHOOK" }] },
    "GET /repos/octo/app/releases": [{ id: 1, tag_name: "v1.0.0", name: "1.0.0", body: "first release", draft: false, prerelease: false, created_at: "2024-01-01T00:00:00Z", published_at: "2024-01-01T00:00:00Z", author: { login: "octocat", id: 1 }, assets: [] }],
    "GET /repos/octo/lib": () => ({ ...repoJson("lib", { default_branch: "trunk", topics: [] }), clone_url: `${ghBase}/octo/lib.git` }),
    "GET /repos/octo/lib/labels": empty,
    "GET /repos/octo/lib/milestones": empty,
    "GET /repos/octo/lib/pulls": empty,
    "GET /repos/octo/lib/issues": [issue(1, { title: "Lib issue" })],
    "GET /repos/octo/lib/issues/comments": empty,
    "GET /repos/octo/lib/pulls/comments": empty,
    "GET /repos/octo/lib/branches": empty,
    "GET /repos/octo/lib/actions/variables": { variables: [] },
    "GET /repos/octo/lib/actions/secrets": { secrets: [] },
    "GET /repos/octo/lib/releases": empty,
  };
  const gh = fakeGitHub({ root: ghRoot, token: GH_TOKEN, routes, lfs: new Map([[fx.asset.oid, fx.asset.data]]), anonymous: ["octo/lib"] });
  ghBase = await gh.listen();
  const apiUrl = `${ghBase}/api/v3`;

  /** Run the import agent (the runner image's import mode) for an import waiting for one, like the container would. */
  const transfer = async (id) => {
    await until(`import ${id} to wait for an agent`, async () => (await ok("GET", `/diffinery/imports/${id}`)).git?.phase === "waiting", 120_000);
    const { token: pushToken } = await ok("POST", `/diffinery/imports/${id}/claim`);
    const r = await spawnAsync(process.execPath, [AGENT], { DIFFINERY_API_URL: base, DIFFINERY_IMPORT_ID: id, DIFFINERY_IMPORT_TOKEN: pushToken, DIFFINERY_IMPORT_CHUNK_BYTES: String(160 * 1024), DIFFINERY_IMPORT_LARGE_BLOB_BYTES: String(100 * 1024), DIFFINERY_WORK_ROOT: join(work, `import-${id}`) }, 240_000);
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(!out.includes(GH_TOKEN) && !out.includes(pushToken), "the agent never prints tokens");
    return { ...r, out, pushToken };
  };
  const finished = (id, timeout = 180_000) =>
    until(`import ${id} to finish`, async () => {
      const r = await ok("GET", `/diffinery/imports/${id}`);
      return ["succeeded", "failed", "cancelled"].includes(r.status) ? r : null;
    }, timeout);

  // ------------------------------------------------------------ people: link a GitHub account by gist proof (no token)
  const challenge = await ok("POST", "/diffinery/user/linked-accounts/github/challenge", { api_url: apiUrl });
  assert.match(challenge.nonce, /^diffinery-link-[0-9a-f]+$/);
  // Before the gist carries the nonce, linking is refused.
  assert.equal((await api("POST", "/diffinery/user/linked-accounts/github", { login: "octo-dev", api_url: apiUrl })).status, 422);
  linkNonce = challenge.nonce; // now octo-dev's public gist contains it
  const link = await ok("POST", "/diffinery/user/linked-accounts/github", { login: "octo-dev", api_url: apiUrl });
  assert.equal(link.login, "octo-dev");

  // ------------------------------------------------------------ input validation and permissions
  assert.equal((await api("POST", "/diffinery/imports", { source: "octo/app", owner, options: { nope: true }, github_api_url: apiUrl })).status, 422);
  assert.equal((await api("POST", "/diffinery/imports", { source: "octo/app", owner: "nobody-here", github_api_url: apiUrl })).status, 422);
  assert.equal((await api("POST", "/diffinery/imports", { source: "octo/app", owner, github_token: "wrong", github_api_url: apiUrl })).status, 422);
  const bot = (await ok("POST", "/diffinery/agents", { login: "import-bot" }, null)).token.token;
  // An agent may import where its owner may, its owner's own account included: this one gets past
  // the permission check and stops only because the GitHub repository does not exist.
  const botTry = await api("POST", "/diffinery/imports", { source: "octo/missing", owner, github_token: GH_TOKEN, github_api_url: apiUrl }, bot);
  assert.equal(botTry.status, 422, JSON.stringify(botTry.json));
  assert.match(botTry.json.message, /octo\/missing was not found/);

  // ------------------------------------------------------------ one repository
  const started = await ok("POST", "/diffinery/imports", { source: "octo/app", owner, name: "imported-app", github_token: GH_TOKEN, github_api_url: apiUrl });
  assert.equal(started.status, "queued");
  assert.ok(!JSON.stringify(started).includes(GH_TOKEN), "the token is never returned");
  // While the import holds the repository it created, nothing else writes to it but settings such as
  // secrets: the REST API, the web UI and MCP get 423 Locked (reads still work). The import's own
  // writes go through below.
  await until(`import ${started.id} to wait for an agent`, async () => (await ok("GET", `/diffinery/imports/${started.id}`)).git?.phase === "waiting", 120_000);
  const L = `/repos/${owner}/imported-app`;
  for (const [method, path, body] of [
    ["POST", `${L}/hooks`, { config: { url: "https://hooks.invalid/import-sink" }, events: ["*"] }],
    ["POST", `${L}/issues`, { title: "too early" }],
    ["PUT", `${L}/contents/early.txt`, { message: "too early", content: Buffer.from("early\n").toString("base64") }],
    ["POST", `${L}/labels`, { name: "early", color: "ffffff" }],
    ["PATCH", L, { description: "changed during the import" }],
  ]) {
    const r = await api(method, path, body);
    assert.equal(r.status, 423, `${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
    assert.match(r.json.message, /locked by an import/);
  }
  assert.equal((await api("GET", `${L}/issues`)).status, 200, "reads are not locked");
  // Settings that don't touch Git data, issues or pull requests can be set up while it imports.
  assert.equal((await api("PUT", `${L}/actions/secrets/EARLY_SECRET`, { value: "set during the import" })).status, 204);
  assert.ok((await ok("GET", `${L}/actions/secrets`)).secrets.some((x) => x.name === "EARLY_SECRET"));
  assert.equal((await api("DELETE", `${L}/actions/secrets/EARLY_SECRET`)).status, 204);
  const csrf = randomBytes(16).toString("hex");
  const webWrite = await fetch(`${base}/${owner}/imported-app/issues`, { method: "POST", headers: { cookie: `dfy_csrf=${csrf}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ _csrf: csrf, title: "too early" }), redirect: "manual" });
  assert.equal(webWrite.status, 423, await webWrite.text());
  const mcpWrite = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_issue", arguments: { owner, repo: "imported-app", title: "too early" } } }) }).then((r) => r.json());
  assert.equal(mcpWrite.result.isError, true, JSON.stringify(mcpWrite));
  assert.match(mcpWrite.result.content[0].text, /locked by an import/);
  const agent = await transfer(started.id);
  assert.equal(agent.status, 0, agent.out);
  const done = await finished(started.id);
  assert.equal(done.status, "succeeded", JSON.stringify(done, null, 2));
  // No side effects: no workflow runs (ci.yml runs on push and pull_request), no webhook deliveries.
  // The lock is released: a webhook can be added now, and nothing the import queued reaches it.
  const hook = await ok("POST", `/repos/${owner}/imported-app/hooks`, { config: { url: "https://hooks.invalid/import-sink" }, events: ["*"] });
  await sleep(2000);
  assert.equal((await ok("GET", `/repos/${owner}/imported-app/actions/runs`)).total_count, 0);
  const sink = (await ok("GET", `/repos/${owner}/imported-app/hooks`)).find((h) => h.id === hook.id);
  assert.equal(sink.last_response.code, null, "no webhook was delivered");
  assert.equal(sink.last_response.status, "unused");
  assert.ok(done.steps.every((s) => s.status === "done" || s.status === "skipped"), JSON.stringify(done.steps));
  assert.ok(done.summary.git.chunks >= 3, `history went in chunks: ${JSON.stringify(done.summary.git)}`);
  // The data files count as large here (DIFFINERY_IMPORT_LARGE_BLOB_BYTES): they went first, whole,
  // under temporary refs naming trees, which the server takes and the import removes at the end.
  assert.match(agent.out, /4 version\(s\) of large files/);
  assert.equal(done.summary.git.branches, 3);
  assert.equal(done.summary.git.tags, 2);
  assert.equal(done.summary.git.lfsObjects, 1);
  assert.deepEqual(done.summary.secretNames, ["NPM_TOKEN", "SLACK_WEBHOOK"]);
  assert.ok(done.summary.findings.some((f) => f.kind === "AWS access key"), "bypassed findings are listed");
  assert.ok(done.summary.people.imported.includes("alice") && done.summary.people.linked.includes("octo-dev"));
  // Releases are imported over the REST API (not just their tags).
  assert.equal(done.summary.releases?.imported, 1, JSON.stringify(done.summary.releases));
  const releases = await ok("GET", `/repos/${owner}/imported-app/releases`);
  assert.deepEqual(releases.map((r) => r.tag_name), ["v1.0.0"]);

  // Repository settings
  const repo = await ok("GET", `/repos/${owner}/imported-app`);
  assert.equal(repo.visibility, "private");
  assert.equal(repo.default_branch, "main");
  assert.equal(repo.description, "The app");
  assert.equal(repo.homepage, "https://app.example.com");
  assert.deepEqual(repo.topics, ["demo", "import"]);

  // Git: branches, tags and pull request heads; no merge queue branches, merge refs or import refs.
  const refs = Object.fromEntries(
    git(work, ["ls-remote", `${base}/${owner}/imported-app.git`])
      .trim()
      .split("\n")
      .map((l) => l.split("\t").reverse()),
  );
  assert.equal(refs["refs/heads/main"], fx.mainSha);
  assert.equal(refs["refs/heads/feature"], fx.featureSha);
  assert.equal(refs["refs/heads/draft-work"], fx.draftSha);
  assert.ok(refs["refs/tags/v1.0"] && refs["refs/tags/v0.1"]);
  assert.equal(refs["refs/pull/2/head"], fx.featureSha);
  assert.equal(refs["refs/pull/5/head"], fx.draftSha);
  assert.equal(refs["refs/pull/6/head"], fx.forkSha);
  assert.ok(!Object.keys(refs).some((r) => r.startsWith("refs/heads/gh-readonly-queue/") || r.startsWith("refs/diffinery-import/") || r === "refs/pull/2/merge"), Object.keys(refs).join("\n"));
  const copy = join(work, "imported-app");
  git(work, ["clone", "-q", "--mirror", `${base}/${owner}/imported-app.git`, copy], token, { env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" } });
  git(copy, ["fsck", "--no-progress"]);
  git(copy, ["cat-file", "-e", fx.forkSha]);
  // The LFS object is stored in Diffinery.
  const lfsRes = await fetch(`${base}/${owner}/imported-app.git/info/lfs/objects/batch`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/vnd.git-lfs+json" }, body: JSON.stringify({ operation: "download", objects: [{ oid: fx.asset.oid, size: fx.asset.data.length }] }) });
  const lfsBody = await lfsRes.json();
  assert.ok(lfsBody.objects[0].actions?.download, `${JSON.stringify(lfsBody)}\n${JSON.stringify(done.warnings)}\n${agent.out}\n${devLog().split("\n").filter((l) => /lfs|rror/i.test(l)).slice(-40).join("\n")}`);
  const blob = await fetch(lfsBody.objects[0].actions.download.href, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), fx.asset.data.toString());
  // The push token is revoked.
  assert.equal((await api("GET", "/user", undefined, agent.pushToken)).status, 401);

  // Issues keep their numbers, people, state and dates.
  const i1 = await ok("GET", `/repos/${owner}/imported-app/issues/1`);
  assert.equal(i1.title, "First bug");
  assert.equal(i1.user.login, owner, "a linked GitHub account maps to its Diffinery account");
  assert.deepEqual(i1.assignees.map((a) => a.login), [owner]);
  assert.deepEqual(i1.labels.map((l) => l.name), ["bug"]);
  assert.equal(i1.milestone.title, "v1");
  assert.equal(i1.created_at, t);
  const i3 = await ok("GET", `/repos/${owner}/imported-app/issues/3`);
  assert.equal(i3.state, "closed");
  assert.equal(i3.state_reason, "not_planned");
  assert.equal(i3.user.login, "github:alice");
  assert.equal((await api("GET", `/repos/${owner}/imported-app/issues/4`)).status, 404, "a deleted GitHub issue leaves its number unused");
  const c1 = await ok("GET", `/repos/${owner}/imported-app/issues/1/comments`);
  assert.deepEqual(c1.map((c) => [c.user.login, c.body, c.created_at]), [["github:alice", "I can reproduce this", "2024-01-03T00:00:00Z"], [owner, "Thanks!", "2024-01-04T00:00:00Z"]]);
  // Pull requests: merged state, who merged, reviews and line comments with replies.
  const p2 = await ok("GET", `/repos/${owner}/imported-app/pulls/2`);
  assert.equal(p2.merged, true);
  assert.equal(p2.merged_by.login, owner);
  assert.equal(p2.merge_commit_sha, fx.mergeSha);
  assert.equal(p2.head.ref, "feature");
  assert.equal(p2.head.sha, fx.featureSha);
  const reviews = await ok("GET", `/repos/${owner}/imported-app/pulls/2/reviews`);
  assert.deepEqual(reviews.map((r) => [r.user.login, r.state, r.body]), [["github:bob", "APPROVED", "Looks good"]]);
  const lineComments = await ok("GET", `/repos/${owner}/imported-app/pulls/2/comments`);
  assert.equal(lineComments.length, 2);
  assert.equal(lineComments[0].path, "feature.txt");
  assert.equal(lineComments[1].in_reply_to_id, lineComments[0].id);
  const p5 = await ok("GET", `/repos/${owner}/imported-app/pulls/5`);
  assert.equal(p5.draft, true);
  assert.equal(p5.state, "open");
  assert.deepEqual(p5.requested_reviewers.map((r) => r.login), ["github:bob"]);
  // M1: an imported review is history, not a vote — even when its author is a linked Diffinery account.
  const r5 = await ok("GET", `/repos/${owner}/imported-app/pulls/5/reviews`);
  assert.deepEqual(r5.map((r) => [r.user.login, r.state]), [[owner, "APPROVED"]], "the imported approval is kept as history");
  assert.equal(p5.approvals, 0, "an imported approval does not count toward the required approvals");
  assert.equal(p5.required_approvals, 1);
  const p6 = await ok("GET", `/repos/${owner}/imported-app/pulls/6`);
  assert.equal(p6.head.ref, "forker:patch");
  assert.equal(p6.head.sha, fx.forkSha);
  assert.equal(p6.merged, false);
  // A pull request from a fork runs the fork's code, so its jobs get what GitHub gives them:
  // a read-only token and no secrets.
  assert.equal((await api("PUT", `/repos/${owner}/imported-app/actions/secrets/DEPLOY_KEY`, { value: "never-for-forks" })).status, 204);
  await ok("PATCH", `/repos/${owner}/imported-app/pulls/6`, { state: "open" });
  const forkJob = await until("the fork pull request's job", async () => {
    const r = await runnerClaim(`/repos/${owner}/imported-app`, ["linux"]);
    return r.status === 200 ? r.json : null;
  });
  const forkSpec = await (await fetch(`${base}/runner/jobs/${forkJob.job_id}`, { headers: { authorization: `Bearer ${forkJob.token}` } })).json();
  assert.equal(forkSpec.github.event_name, "pull_request");
  assert.deepEqual(Object.keys(forkSpec.secrets).sort(), ["DIFFINERY_TOKEN", "GITHUB_TOKEN"]);
  assert.equal((await api("POST", `/repos/${owner}/imported-app/issues`, { title: "from a fork's job" }, forkJob.token)).status, 403);
  await fetch(`${base}/runner/jobs/${forkJob.job_id}/complete`, { method: "POST", headers: { authorization: `Bearer ${forkJob.token}`, "content-type": "application/json" }, body: JSON.stringify({ conclusion: "success", outputs: {} }) });
  await ok("PATCH", `/repos/${owner}/imported-app/pulls/6`, { state: "closed" });
  // New issues continue after the highest imported number.
  assert.equal((await ok("POST", `/repos/${owner}/imported-app/issues`, { title: "After import" })).number, 8);
  // Labels, milestones, protection, variables.
  const labels = await ok("GET", `/repos/${owner}/imported-app/labels`);
  {
    const bug = labels.find((l) => l.name === "bug");
    assert.deepEqual([bug.name, bug.color, bug.description], ["bug", "d73a4a", "Something isn't working"]);
  }
  const milestones = await ok("GET", `/repos/${owner}/imported-app/milestones?state=all`);
  assert.equal(milestones.length, 1);
  assert.equal(milestones[0].due_on, "2030-01-01T00:00:00Z");
  assert.equal(milestones[0].open_issues, 1);
  const protection = await ok("GET", `/repos/${owner}/imported-app/branches/main/protection`);
  assert.match(JSON.stringify(protection), /CI \/ build/);
  const vars = await ok("GET", `/repos/${owner}/imported-app/actions/variables`);
  assert.deepEqual(vars.variables.map((v) => [v.name, v.value]).sort(), [["DEPLOY_ENV", "staging"], ["REGION", "us"]]);
  assert.ok((await ok("GET", "/diffinery/imports")).some((x) => x.id === started.id));

  // ------------------------------------------------------------ secrets policy "stop" fails with a clear message
  const strict = await ok("POST", "/diffinery/imports", { source: "octo/app", owner, name: "strict-app", github_token: GH_TOKEN, github_api_url: apiUrl, options: { secrets: "stop", issues: false } });
  const strictAgent = await transfer(strict.id);
  assert.equal(strictAgent.status, 1, strictAgent.out);
  assert.match(strictAgent.out, /secret/i);
  const strictDone = await finished(strict.id);
  assert.equal(strictDone.status, "failed");
  assert.match(strictDone.error, /secrets/);

  // ------------------------------------------------------------ a whole organization, into an organization
  await ok("POST", "/user/orgs", { login: "acme-imports" });
  const bulk = await ok("POST", "/diffinery/imports", { source_owner: "octo", owner: "acme-imports", github_token: GH_TOKEN, github_api_url: apiUrl, concurrency: 2, options: { lfs: false } });
  assert.equal(bulk.kind, "organization");
  assert.deepEqual(bulk.children.map((ch) => ch.source).sort(), ["octo/app", "octo/lib"]);
  for (const ch of bulk.children) assert.equal((await transfer(ch.id)).status, 0);
  const bulkDone = await finished(bulk.id, 300_000);
  assert.equal(bulkDone.status, "succeeded", JSON.stringify(bulkDone, null, 2));
  assert.deepEqual(bulkDone.summary.orgSecretNames, ["ORG_DEPLOY_KEY"]);
  const orgVars = await ok("GET", "/orgs/acme-imports/actions/variables");
  assert.deepEqual(orgVars.variables.map((v) => [v.name, v.value]), [["ORG_REGION", "eu-west"]]);
  assert.ok(bulkDone.warnings.some((w) => /ORG_PRIVATE_HOST/.test(w)) && bulkDone.warnings.some((w) => /ORG_SELECTED_KEY/.test(w)), JSON.stringify(bulkDone.warnings));
  assert.equal((await ok("GET", "/repos/acme-imports/lib")).default_branch, "trunk");
  assert.equal((await ok("GET", "/repos/acme-imports/lib/issues/1")).title, "Lib issue");
  assert.equal((await ok("GET", "/repos/acme-imports/app/pulls/2")).merged, true);

  // ------------------------------------------------------------ without a token: everything public comes across, variables are skipped
  // GitHub answers Actions variables, secrets and environments only with a token (401 otherwise).
  const anon = await ok("POST", "/diffinery/imports", { source: "octo/lib", owner, name: "anon-lib", github_api_url: apiUrl, options: { lfs: false } });
  assert.equal((await transfer(anon.id)).status, 0);
  const anonDone = await finished(anon.id);
  assert.equal(anonDone.status, "succeeded", JSON.stringify(anonDone, null, 2));
  const anonVars = anonDone.steps.find((st) => st.name === "variables");
  assert.equal(anonVars.status, "skipped", JSON.stringify(anonDone.steps));
  assert.match(anonVars.message, /needs a GitHub token/);
  assert.ok(anonDone.warnings.some((w) => /variables, secret names and environments were not imported/.test(w)), JSON.stringify(anonDone.warnings));
  assert.equal((await ok("GET", `/repos/${owner}/anon-lib/issues/1`)).title, "Lib issue");
  assert.equal((await ok("GET", `/repos/${owner}/anon-lib`)).default_branch, "trunk");

  // ------------------------------------------------------------ an agent's organization import cannot touch variables (H1)
  const agentBulk = await api("POST", "/diffinery/imports", { source_owner: "octo", owner: "acme-imports", github_token: GH_TOKEN, github_api_url: apiUrl, concurrency: 1, options: { lfs: false } }, bot);
  assert.equal(agentBulk.status, 201, JSON.stringify(agentBulk.json));
  const agentBulkDone = await finished(agentBulk.json.id, 180_000);
  const orgStep = agentBulkDone.steps.find((s) => s.name === "organization");
  assert.equal(orgStep.status, "skipped", JSON.stringify(agentBulkDone.steps));
  assert.match(orgStep.message, /agents cannot manage variables/);
  // The organization's variable is untouched by the agent import.
  assert.deepEqual((await ok("GET", "/orgs/acme-imports/actions/variables")).variables.map((v) => v.name), ["ORG_REGION"]);

  // ------------------------------------------------------------ a retry onto a repository adopted since is refused (H2)
  await ok("POST", `/repos/${owner}/strict-app/issues`, { title: "adopted after the failed import" });
  await ok("POST", `/diffinery/imports/${strict.id}/retry`, { github_token: GH_TOKEN });
  const reDone = await finished(strict.id);
  assert.equal(reDone.status, "failed");
  assert.match(reDone.error, /holds content|start a new import/);

  // ------------------------------------------------------------ a stale (revoked) import push token cannot push in import mode (M4)
  const stalePush = gitFails(copy, ["push", `${base}/${owner}/imported-app.git`, "--push-option=diffinery-import", "refs/heads/main:refs/heads/stale-attempt"], agent.pushToken);
  assert.match(stalePush, /401|403|denied|forbidden|authentication|fatal/i, stalePush);

  // ------------------------------------------------------------ an organization import holds each repository to the size limit
  listHuge = true;
  const hugeBulk = await ok("POST", "/diffinery/imports", { source_owner: "octo", repositories: ["huge"], owner: "acme-imports", github_token: GH_TOKEN, github_api_url: apiUrl, concurrency: 1, options: { lfs: false } });
  const hugeChild = await until("the oversized repository to be refused", async () => {
    const ch = (await ok("GET", `/diffinery/imports/${hugeBulk.id}`)).children?.find((c) => c.source === "octo/huge");
    return ch?.status === "failed" ? ch : ch?.git?.phase === "waiting" ? Promise.reject(new Error("the oversized repository was queued for transfer")) : null;
  }, 120_000);
  assert.match(hugeChild.error ?? (await ok("GET", `/diffinery/imports/${hugeChild.id}`)).error, /import limit/);
  assert.equal((await api("GET", "/repos/acme-imports/huge")).status, 404);
  await finished(hugeBulk.id);

  // ------------------------------------------------------------ the web UI (signed in via DEV_AUTH)
  for (const path of ["/new/import", "/imports", `/imports/${started.id}`, `/imports/${started.id}/secrets`, `/imports/${bulk.id}`, "/settings/linked-accounts", `/${owner}/imported-app/issues/1`, `/${owner}/imported-app/pull/2`]) {
    const res = await fetch(`${base}${path}`);
    const html = await res.text();
    assert.equal(res.status, 200, `${path} -> ${res.status}\n${html.slice(0, 500)}`);
    assert.ok(!/<select|type="checkbox"|type="radio"/.test(html.replace(/<template[\s\S]*?<\/template>/g, "")) || path.startsWith(`/${owner}`), `${path} renders Kumo controls, not native ones`);
  }
  assert.match(await (await fetch(`${base}/imports/${started.id}`)).text(), /NPM_TOKEN/);
  assert.match(await (await fetch(`${base}/${owner}/imported-app/issues/1`)).text(), /v1/);
  assert.match(await (await fetch(`${base}/${owner}/imported-app/issues/3`)).text(), /alice/);
  await gh.close();
});

test("scheduled workflows: the schedule fires without a cron trigger", async () => {
  assert.ok(tickRepo, "the schedule was registered");
  const runs = await until("a scheduled run", async () => {
    const r = await ok("GET", `/repos/${tickRepo}/actions/runs?event=schedule`);
    return r.total_count > 0 && r.workflow_runs;
  }, 150_000);
  assert.equal(runs[0].event, "schedule");
  assert.equal(runs[0].path, ".github/workflows/tick.yml");
  assert.equal(runs[0].actor.login, "diffinery-scheduler");
  // One run per tick, never two for the same minute.
  const minutes = runs.map((r) => r.created_at.slice(0, 16));
  assert.equal(new Set(minutes).size, minutes.length, `two runs in one tick: ${minutes.join(", ")}`);
  // Site admins can see the scheduler's state (the live test reports it when no run comes).
  const state = await ok("GET", "/diffinery/admin/scheduler");
  assert.equal(state.tick_minutes, 1);
  assert.ok(state.last_tick_at && state.covered_until, JSON.stringify(state));
  assert.ok(Date.parse(state.next_tick_at) > Date.parse(state.last_tick_at), JSON.stringify(state));
  // And the newest unexpected server errors; a request id that isn't kept is a 404.
  const errors = await ok("GET", "/diffinery/admin/errors?per_page=5");
  assert.ok(Array.isArray(errors) && errors.length <= 5, JSON.stringify(errors));
  assert.equal((await api("GET", "/diffinery/admin/errors/not-a-request-id")).status, 404);
  // IndexNow is off on a local origin; its page and API still answer for site admins.
  const indexnow = await ok("GET", "/diffinery/admin/indexnow");
  assert.equal(indexnow.enabled, false, JSON.stringify(indexnow));
  assert.match(indexnow.off_reason, /public https/);
  assert.match(await (await fetch(`${base}/settings/admin/search-engines`)).text(), /Search engines[\s\S]*PUBLIC_URL isn/);
  assert.equal((await ok("GET", "/meta")).indexnow.enabled, false);
  // A push without the schedule removes it.
  const src = join(work, "schedules");
  rmSync(join(src, ".github/workflows/tick.yml"));
  git(src, ["commit", "-q", "-am", "no schedule"]);
  git(src, ["push", "-q", `${base}/${tickRepo}.git`, "main"]);
});

/**
 * `git` without blocking this process, so the tests below run side by side; it rejects with git's
 * output and, on a server error or after 10 minutes without finishing (the command is killed, so a
 * stuck push fails the test instead of the whole job), the tail of `log` and what `more` says.
 * A `tok` of null sends no credentials (for GitHub).
 */
function gitAsync(cwd, args, tok = token, log = devLog, more = () => "") {
  const auth = tok === null ? [] : ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-token:${tok}`).toString("base64")}`];
  return new Promise((done, fail) => {
    const child = spawn("git", [...auth, "-c", "protocol.version=2", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "E2E", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "E2E", GIT_COMMITTER_EMAIL: "e2e@example.com" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 600_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", fail);
    child.on("close", (status) => {
      clearTimeout(timer);
      if (status === 0) return done(stdout);
      let message = `git ${args.join(" ")} ${timedOut ? "didn't finish in 10 minutes" : `exited ${status}`}\n${stderr}`;
      if (timedOut || /HTTP 5\d\d|Failed to connect/.test(stderr)) message += `\n${more()}\n--- wrangler log tail ---\n${log().slice(-4000)}`;
      fail(Object.assign(new Error(message), { stdout, stderr }));
    });
  });
}

/**
 * `ok`, `git` and `gitFails` against `server` (startServer's, or the shared one), with git that doesn't
 * block this process: for the tests below that run side by side.
 */
function client(server) {
  const ok = async (method, path, body) => {
    const send = () => fetch(`${server.base}/api/v3${path}`, { method, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    // A GET goes again on a kept-alive connection the server closed meanwhile, as in api().
    const r = await send().catch((e) => (method === "GET" ? sleep(1000).then(send) : Promise.reject(e)));
    const text = await r.text();
    assert.ok(r.ok, `${method} ${path} -> ${r.status} ${text}`);
    return JSON.parse(text);
  };
  const git = (cwd, args) => gitAsync(cwd, args, server.token, server.log, () => `the Worker was at ${server.direct}; wrangler dev now names ${server.workerUrl?.() ?? "(the shared server)"}`);
  const gitFails = async (cwd, args) => {
    try {
      await git(cwd, args);
    } catch (e) {
      return `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    assert.fail(`expected git ${args.join(" ")} to fail`);
  };
  // Git goes straight to the Worker: wrangler dev's own proxy drops large pushes and clones streaming
  // through it (see workerUrl), which isn't Diffinery and doesn't exist in production.
  assert.ok(server.direct, `the Worker's own address wasn't found in wrangler dev's debug log`);
  return { ...server, gitBase: server.direct, ok, git, gitFails };
}
const shared = () => client({ base, direct, token, log: devLog });

/** Runs `fn` with a client of a server of its own, stopped afterwards. */
async function onOwnServer(name, fn, ready = Promise.resolve()) {
  const [server] = await Promise.all([startServer(name), ready]);
  try {
    assert.ok(server.direct && (await fetch(`${server.direct}/healthz`)).ok, `the Worker's own address (${server.direct}) doesn't answer`);
    return await fn(client(server));
  } finally {
    server.stop();
  }
}

/**
 * A real project's history, pushed whole to a new repository on `server` and cloned back. Pinned
 * commits, so the packs are the same each run; cloned from GitHub without the Diffinery token.
 */
async function pushHistory({ gitBase, ok, git }, name, upstream) {
  const me = await ok("GET", "/user");
  await ok("POST", "/user/repos", { name });
  const remote = `${gitBase}/${me.login}/${name}.git`;
  // Test fixtures in these histories look like credentials (tornado has a test private key): pushed as an admin's bypass.
  await git(upstream, ["-c", "http.postBuffer=1048576", "push", "-q", "-o", "allow-secrets=e2e of a public history", remote, "main"]);
  const out = join(work, `${name}-clone`);
  await git(work, ["clone", "-q", "--bare", remote, out]);
  assert.equal((await git(out, ["rev-parse", "main"])).trim(), (await git(upstream, ["rev-parse", "main"])).trim());
  assert.equal((await git(out, ["rev-list", "--count", "main"])).trim(), (await git(upstream, ["rev-list", "--count", "main"])).trim());
  await git(out, ["fsck", "--full"]);
}

// Two at a time, each on a server of its own (the lockfile's on the shared one): one big push keeps
// one server process busy, so on separate processes they use the runner's other cores; jquery's push
// takes about as long as the other three's together. Not all four: a local server's memory grows to
// 2 to 4 GB during such a push, and four at once ran a runner out of memory (the Workers runtime
// crashed mid-push); two at a time peak about 1 GB above one at a time. Git goes past wrangler dev's
// proxy (see client).
describe("real histories: whole projects, side by side", { concurrency: 2 }, () => {
  for (const [name, url, sha] of [
    // 37 MB: staged in R2 and unpacked in pieces.
    ["jquery", "https://github.com/jquery/jquery", "c2f27864e4ffc2d1409c289fcb9a42b6165dfeaf"],
    // About 12 MB each: too many objects for parsing whole in memory, so unpacked in pieces too.
    ["tornado", "https://github.com/tornadoweb/tornado", "056cacaefc7de31bda28363378c4ffc86b97d7e4"],
    ["flask", "https://github.com/pallets/flask", "d086db856be187255b8ec61ef409357393020f32"],
  ]) {
    test(`real histories: ${name}'s whole history goes in one push and clones back intact`, async () => {
      const upstream = join(work, `${name}-upstream.git`);
      const download = gitAsync(work, ["clone", "-q", "--bare", "--no-tags", url, upstream], null).then(() => gitAsync(upstream, ["update-ref", "refs/heads/main", sha], null));
      await onOwnServer(name, (c) => pushHistory(c, name, upstream), download);
    });
  }

  test("real histories: a 2.6 MB lockfile's 60 versions, a chain of deltas, go in one small push", async () => {
    const upstream = join(work, "lockfile-upstream");
    mkdirSync(upstream, { recursive: true });
    git(upstream, ["init", "-q", "-b", "main"]);
    const versions = new Map();
    const pkgs = Array.from({ length: 11_000 }, (_, i) => `pkg-${String(i).padStart(5, "0")}`);
    pkgs.forEach((p, i) => versions.set(p, `1.${i % 51}.${i % 97}`));
    for (let c = 0; c < 60; c++) {
      for (let k = 0; k < 40; k++) versions.set(pkgs[(c * 7919 + k * 104729) % pkgs.length], `2.${c}.${k}`);
      const body = pkgs.map((p) => {
        const v = versions.get(p);
        return `    "node_modules/${p}": {\n      "version": "${v}",\n      "resolved": "https://registry.npmjs.org/${p}/-/${p}-${v}.tgz",\n      "integrity": "sha512-${createHash("sha512").update(p + v).digest("hex").slice(0, 64)}"\n    },\n`;
      });
      writeFileSync(join(upstream, "package-lock.json"), `{\n  "lockfileVersion": 3,\n  "packages": {\n${body.join("")}  }\n}\n`);
      git(upstream, ["add", "-A"]);
      git(upstream, ["commit", "-q", "-m", `lockfile ${c}`]);
    }
    assert.ok(readFileSync(join(upstream, "package-lock.json")).length > 2_500_000);
    const packBytes = Number(execFileSync("bash", ["-c", "git pack-objects --revs --stdout -q <<<main | wc -c"], { cwd: upstream, encoding: "utf8" }).trim());
    assert.ok(packBytes < 16 * 1024 * 1024, `the pack is ${packBytes} bytes`);
    await pushHistory(shared(), "lockfile", upstream);
  });
});

// Side by side, each on a server of its own, as the real histories above: about as long as the 40 MB
// history's pushes alone instead of the sum.
describe("large pushes: side by side, each on a server of its own", { concurrency: true }, () => {
  test("large files: a 40 MB file is pushed and cloned intact, and push protection still reads big text files", () =>
    onOwnServer("bigfile", async ({ gitBase, ok, git, gitFails }) => {
      const me = await ok("GET", "/user");
      await ok("POST", "/user/repos", { name: "bigfile" });
      const src = join(work, "bigfile");
      mkdirSync(src, { recursive: true });
      await git(src, ["init", "-q", "-b", "main"]);
      // Random bytes don't compress: the push is over 16 MB, so it goes through R2 on its way in.
      const data = randomBytes(40 * 1024 * 1024);
      writeFileSync(join(src, "big.bin"), data);
      await git(src, ["add", "-A"]);
      await git(src, ["commit", "-q", "-m", "a large file"]);
      await git(src, ["-c", "http.postBuffer=1048576", "push", "-q", `${gitBase}/${me.login}/bigfile.git`, "main"]);
      const out = join(work, "bigfile-clone");
      await git(work, ["clone", "-q", `${gitBase}/${me.login}/bigfile.git`, out]);
      assert.ok(readFileSync(join(out, "big.bin")).equals(data), "the cloned file is the pushed file");
      const wantBlob = (await git(src, ["rev-parse", "HEAD:big.bin"])).trim();
      assert.equal((await git(out, ["rev-parse", "HEAD:big.bin"])).trim(), wantBlob);
      // A large text file (scanned slice by slice) with a key near its end is still refused.
      // diffinery:allow-secret (a fake key)
      writeFileSync(join(src, "dump.sql"), `${"-- row\n".repeat(1024 * 1024)}aws_key = AKIAIOSFODNN7EXAMPL3\n`);
      await git(src, ["add", "-A"]);
      await git(src, ["commit", "-q", "-m", "a large dump"]);
      assert.match(await gitFails(src, ["push", "-q", `${gitBase}/${me.login}/bigfile.git`, "main"]), /possible secrets detected/);
    }));

  test("large pushes: three large pushes into one repository at once all go in, and a fetch meanwhile works", () =>
    onOwnServer("pushes-at-once", async ({ gitBase, ok, git }) => {
      const me = await ok("GET", "/user");
      await ok("POST", "/user/repos", { name: "pushes-at-once" });
      const remote = `${gitBase}/${me.login}/pushes-at-once.git`;
      const src = join(work, "pushes-at-once");
      mkdirSync(src, { recursive: true });
      await git(src, ["init", "-q", "-b", "main"]);
      writeFileSync(join(src, "README.md"), "base\n");
      await git(src, ["add", "-A"]);
      await git(src, ["commit", "-q", "-m", "base"]);
      await git(src, ["push", "-q", remote, "main"]);
      // Each branch: many medium files over a few commits, so unpacking holds a lot. Two packs stay under
      // 16 MB (handed over in memory), one goes over (staged in R2), as when several agents push at once.
      const sizes = { a: 180, b: 180, c: 420 };
      const tips = {};
      for (const [branch, count] of Object.entries(sizes)) {
        await git(src, ["checkout", "-q", "-b", branch, "main"]);
        const files = Array.from({ length: count }, () => randomBytes(48 * 1024).toString("base64"));
        mkdirSync(join(src, branch), { recursive: true });
        for (let c = 0; c < 3; c++) {
          files.forEach((f, i) => writeFileSync(join(src, branch, `f${i}.txt`), `${f}\nrevision ${c}\n${randomBytes(1024).toString("hex")}\n`));
          await git(src, ["add", "-A"]);
          await git(src, ["commit", "-q", "-m", `${branch} ${c}`]);
        }
        tips[branch] = (await git(src, ["rev-parse", "HEAD"])).trim();
      }
      await git(src, ["checkout", "-q", "main"]);
      const push = (branch) => git(src, ["-c", "http.postBuffer=1048576", "push", "-q", remote, branch]);
      const fetchWhile = git(work, ["clone", "-q", remote, join(work, "pushes-at-once-early")]);
      await Promise.all([push("a"), push("b"), push("c"), fetchWhile]);
      const branches = (await ok("GET", `/repos/${me.login}/pushes-at-once/branches`)).map((b) => b.name).sort();
      assert.deepEqual(branches, ["a", "b", "c", "main"]);
      const out = join(work, "pushes-at-once-clone");
      await git(work, ["clone", "-q", "--mirror", remote, out]);
      for (const [branch, tip] of Object.entries(tips)) assert.equal((await git(out, ["rev-parse", `refs/heads/${branch}`])).trim(), tip);
      await git(out, ["fsck", "--full", "--strict"]);
    }));

  test("large pushes: a 40 MB history of many files goes in one push, read from R2 in ranges, and is still checked", () =>
    onOwnServer("bighistory", async ({ gitBase, ok, git, gitFails }) => {
      const me = await ok("GET", "/user");
      await ok("POST", "/user/repos", { name: "bighistory" });
      const remote = `${gitBase}/${me.login}/bighistory.git`;
      const src = join(work, "bighistory");
      mkdirSync(join(src, "files"), { recursive: true });
      await git(src, ["init", "-q", "-b", "main"]);
      // Hundreds of medium files, each changed a little in later commits: a pack of deltas over 16 MB,
      // as a fork's pull request heads made one in jekyll/minima's import.
      const files = Array.from({ length: 400 }, () => randomBytes(96 * 1024).toString("base64"));
      for (let c = 0; c < 6; c++) {
        files.forEach((f, i) => writeFileSync(join(src, "files", `f${i}.txt`), `${f}\nrevision ${c} of file ${i}\n${randomBytes(2048).toString("hex")}\n`));
        await git(src, ["add", "-A"]);
        await git(src, ["commit", "-q", "-m", `revision ${c}`]);
      }
      const packBytes = Number(execFileSync("bash", ["-c", "git pack-objects --revs --stdout -q <<<main | wc -c"], { cwd: src, encoding: "utf8" }).trim());
      assert.ok(packBytes > 30 * 1024 * 1024, `the pack is ${packBytes} bytes`);
      await git(src, ["-c", "http.postBuffer=1048576", "push", "-q", remote, "main"]);
      const out = join(work, "bighistory-clone");
      await git(work, ["clone", "-q", remote, out]);
      assert.equal((await git(out, ["rev-parse", "HEAD"])).trim(), (await git(src, ["rev-parse", "HEAD"])).trim());
      await git(out, ["fsck", "--full", "--strict"]);

      // A second large push builds on objects the repository has (a thin pack, its bases read from storage).
      files.forEach((f, i) => writeFileSync(join(src, "files", `f${i}.txt`), `${f}\nrevision 6 of file ${i}\n${randomBytes(2048).toString("hex")}\n`));
      writeFileSync(join(src, "new.bin"), randomBytes(20 * 1024 * 1024));
      await git(src, ["add", "-A"]);
      await git(src, ["commit", "-q", "-m", "revision 6"]);
      await git(src, ["-c", "http.postBuffer=1048576", "push", "-q", remote, "main"]);
      await git(out, ["pull", "-q", "--ff-only"]);
      assert.equal((await git(out, ["rev-parse", "HEAD"])).trim(), (await git(src, ["rev-parse", "HEAD"])).trim());
      await git(out, ["fsck", "--full", "--strict"]);

      // A large push is checked like a small one: a key in one small file, or an unsafe .gitmodules, refuses all of it.
      await git(src, ["checkout", "-q", "-b", "leak"]);
      writeFileSync(join(src, "more.bin"), randomBytes(20 * 1024 * 1024));
      writeFileSync(join(src, "config.txt"), "aws_key = AKIAIOSFODNN7EXAMPL3\n"); // diffinery:allow-secret (a fake key; the pushed file doesn't carry the marker)
      await git(src, ["add", "-A"]);
      await git(src, ["commit", "-q", "-m", "a key"]);
      assert.match(await gitFails(src, ["-c", "http.postBuffer=1048576", "push", "-q", remote, "leak"]), /possible secrets detected/);
      await git(src, ["checkout", "-q", "main"]);
      await git(src, ["checkout", "-q", "-b", "modules"]);
      writeFileSync(join(src, "more.bin"), randomBytes(20 * 1024 * 1024));
      writeFileSync(join(src, ".gitmodules"), '[submodule "x"]\n\tpath = x\n\turl = --upload-pack=touch /tmp/pwned\n');
      await git(src, ["add", "-A"]);
      await git(src, ["commit", "-q", "-m", "an unsafe submodule"]);
      assert.match(await gitFails(src, ["-c", "http.postBuffer=1048576", "push", "-q", remote, "modules"]), /fsck error: \.gitmodules .*starts with '-'/);
      const branches = (await ok("GET", `/repos/${me.login}/bighistory/branches`)).map((b) => b.name);
      assert.deepEqual(branches, ["main"]);
    }));
});
