// End-to-end Agent setup (lib/agent-setup.ts, web/agent-setup.tsx) against a real `wrangler dev` Worker: a
// person generates a token on Settings → Agent setup, and a fresh machine (its own HOME, nothing installed)
// runs the hosted setup script with only the page's environment variables, as a Claude Code cloud
// environment does.
//
//   pnpm --filter @diffinery/app exec node --test test/e2e/agent-setup.test.mjs
//
// Covers: the page (people with write access in a browser only), the script (no secret in it, a 404 for a
// name that can't be a repository), the CLI install, git and gh wired to the environment with no token on
// disk, the clone, the self-test and the Check turning green, a second run skipping the download, failure
// lines that say what to change, the token reaching only its repository (not even a public one), merging
// only what a person approved and never a workflow change, turning merging off, and revoke, regenerate
// and renew. gh only talks HTTPS, so a stand-in gh (below) does what gh does with GH_ENTERPRISE_TOKEN and
// GH_HOST; the real gh runs against diffinery.com in the live check.
import "./fresh-connections.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "diffinery-agent-setup-"));
let base;
let host;
let dev;
let devLog = "";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const tok = (name) => `dfy_${name}${randomBytes(12).toString("hex")}`;
const T = { ada: tok("ada"), bob: tok("bob"), wes: tok("wes") };
const S = { ada: `ada-session-${randomBytes(12).toString("hex")}`, bob: `bob-session-${randomBytes(12).toString("hex")}`, wes: `wes-session-${randomBytes(12).toString("hex")}` };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  assert.fail(`timed out waiting for ${what}\n--- wrangler log tail ---\n${devLog.slice(-4000)}`);
}

async function api(method, path, body, as) {
  const headers = { "content-type": "application/json" };
  if (as) headers.authorization = `Bearer ${as}`;
  const res = await fetch(`${base}/api/v3${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
async function ok(method, path, body, as) {
  const r = await api(method, path, body, as);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
const b64 = (s) => Buffer.from(s).toString("base64");

async function page(session, path) {
  const res = await fetch(`${base}${path}`, { headers: session ? { cookie: `__Host-dfy_session=${session}` } : {}, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), text: await res.text() };
}
/** A form post as `session`, with the CSRF pair from the page at `from`. */
async function submit(session, from, action, fields = {}) {
  const cookie = `__Host-dfy_session=${session}`;
  const res = await fetch(`${base}${from}`, { headers: { cookie } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await res.text())?.[1];
  const pair = /dfy_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(csrf && pair, `no CSRF pair on ${from} (${res.status})`);
  const r = await fetch(`${base}${action}`, { method: "POST", body: new URLSearchParams({ _csrf: csrf, ...fields }), redirect: "manual", headers: { cookie: `${cookie}; dfy_csrf=${pair}`, "sec-fetch-site": "same-origin" } });
  return { status: r.status, location: r.headers.get("location"), text: await r.text(), flash: decodeURIComponent(decodeURIComponent(r.headers.get("set-cookie") ?? "")) };
}
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The Environment variables box's text. */
const envBox = (html) => unescape(/<pre[^>]*id="agent-env"[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? "").trim();

/**
 * A stand-in for the GitHub CLI: what gh does with GH_ENTERPRISE_TOKEN and GH_HOST (it needs HTTPS, and this
 * server is plain HTTP). `gh auth login` refuses while the token is in the environment, as gh does.
 */
function fakeGh(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const [cmd, sub, ...rest] = process.argv.slice(2);
if (cmd === "--version") { console.log("gh version 2.0.0 (stand-in)"); process.exit(0); }
const token = process.env.GH_ENTERPRISE_TOKEN;
if (cmd === "auth") { if (token) { console.error("The value of the GH_ENTERPRISE_TOKEN environment variable is being used for authentication."); process.exit(1); } process.exit(0); }
const arg = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
let host = arg("--hostname") ?? process.env.GH_HOST;
let path;
if (cmd === "api" && sub === "user") path = "/api/v3/user";
else if (cmd === "pr" && sub === "list") {
  // In a clone gh finds the repository from its remote, on a host it has a token for (GH_HOST with an environment token).
  const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const u = new URL(remote);
  if (u.host !== process.env.GH_HOST) { console.error("none of the git remotes configured for this repository point to a known GitHub host"); process.exit(1); }
  path = "/api/v3/repos" + u.pathname.replace(/\\.git$/, "") + "/pulls?state=all";
} else { console.error("stand-in gh: unsupported " + cmd + " " + sub); process.exit(2); }
if (!token || !host) { console.error("To get started with GitHub CLI, please run:  gh auth login"); process.exit(4); }
fetch("http://" + host + path, { headers: { authorization: "token " + token } }).then(async (r) => {
  const j = await r.json();
  if (!r.ok) { console.error("HTTP " + r.status + ": " + j.message); process.exit(1); }
  console.log(cmd === "api" ? j.login : JSON.stringify(j.map((p) => ({ number: p.number }))));
});
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
}

/** A fresh machine: its own HOME, git with no global config, a bin directory on PATH to link diffinery from, and the stand-in gh. */
function machine(name) {
  const root = join(work, name);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const ghDir = join(root, "gh");
  const where = join(root, "work");
  for (const d of [home, bin, where]) mkdirSync(d, { recursive: true });
  fakeGh(ghDir);
  const env = {
    HOME: home,
    PATH: `${bin}:${ghDir}:${process.env.PATH}`,
    DIFFINERY_LINK_DIR: bin,
    DIFFINERY_CLONE_DIR: where,
    GIT_CONFIG_NOSYSTEM: "1",
    NO_COLOR: "1",
    LANG: "C.UTF-8",
  };
  return { root, home, bin, where, env };
}

/**
 * Runs a command without blocking the event loop (a blocked loop leaves fetch a keep-alive connection the
 * server already closed). Resolves with its exit code and output; `check` rejects on a non-zero exit.
 */
function sh(cmd, args, opts = {}, check = false) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 180_000);
    p.on("error", rej);
    p.on("close", (code) => {
      clearTimeout(timer);
      if (check && code !== 0) rej(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr}`));
      else res({ code, stdout, stderr, out: `${stdout}${stderr}` });
    });
  });
}

/** Runs the setup line from the page, as a setup script field would. */
const runSetup = (m, extra) => sh("bash", ["-c", `curl -fsSL ${base}/ada/zutrix/agent-setup.sh | bash`], { cwd: m.root, env: { ...m.env, ...extra } });

const auth = (token) => ["-c", `http.extraHeader=Authorization: Basic ${b64(`x-token:${token}`)}`];
const git = async (cwd, args, token, env = {}) => (await sh("git", [...auth(token), ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } }, true)).stdout;
const gitFails = async (cwd, args, token) => {
  const r = await sh("git", [...auth(token), ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  assert.notEqual(r.code, 0, `git ${args.join(" ")} should fail`);
  return r.stderr;
};

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  host = `127.0.0.1:${port}`;
  const persist = join(work, "state");
  const wrangler = (...args) => execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });
  migratedState(APP, persist);
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 30 * 86400_000).toISOString();
  const account = (id, login) => `INSERT INTO accounts (id, login, kind, name, email, status, created_at) VALUES ('${id}', '${login}', 'user', '${login}', '${login}@example.com', 'active', '${at}')`;
  const token = (id, acct, t) => `INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('${id}', '${acct}', 'e2e', '${hash(t)}', '${t.slice(0, 10)}', '["admin"]', '${later}', '${at}')`;
  const session = (acct, cookie) => `INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(cookie)}', '${acct}', 'passkey', '${at}', '${at}', '${later}')`;
  wrangler(
    "d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--command",
    [account("u-ada", "ada"), account("u-bob", "bob"), account("u-wes", "wes"), token("t-ada", "u-ada", T.ada), token("t-bob", "u-bob", T.bob), token("t-wes", "u-wes", T.wes), session("u-ada", S.ada), session("u-bob", S.bob), session("u-wes", S.wes)].join("; "),
  );
  dev = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${base}`, "--var", "DEV_AUTH:", "--var", `MASTER_KEY:${randomBytes(32).toString("base64")}`, "--show-interactive-dev-session=false"],
    { cwd: APP, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  dev.stdout.on("data", (d) => (devLog += d));
  dev.stderr.on("data", (d) => (devLog += d));
  await until("wrangler dev", async () => {
    try {
      return (await fetch(`${base}/healthz`)).ok;
    } catch {
      return false;
    }
  });
  // ada's private repository zutrix (bob writes to it, wes reads it), another of hers, and bob's public one.
  for (const [name, t, visibility] of [["zutrix", T.ada, "private"], ["other", T.ada, "private"], ["pub", T.bob, "public"]]) {
    await ok("POST", "/user/repos", { name, visibility }, t);
    await ok("PUT", `/repos/${t === T.ada ? "ada" : "bob"}/${name}/contents/README.md`, { message: "init", content: b64(`# ${name}\n`) }, t);
  }
  await ok("PUT", "/repos/ada/zutrix/collaborators/bob", { permission: "write" }, T.ada);
  await ok("PUT", "/repos/ada/zutrix/collaborators/wes", { permission: "read" }, T.ada);
  // Being added makes an invitation: bob and wes accept theirs.
  for (const t of [T.bob, T.wes]) for (const inv of await ok("GET", "/user/repository_invitations", undefined, t)) await ok("PATCH", `/user/repository_invitations/${inv.id}`, undefined, t);
});

after(() => {
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  }
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
});

const PAGE = "/ada/zutrix/settings/agent-setup";
let token;

test("the page: for people with write access, in a browser", async () => {
  const anon = await page(null, PAGE);
  assert.equal(anon.status, 302, "signed out: off to sign in");
  assert.match(anon.location ?? "", /\/login/);
  assert.equal((await page(S.wes, PAGE)).status, 403, "read access isn't enough");
  const res = await fetch(`${base}${PAGE}`, { headers: { authorization: `Bearer ${T.ada}` } });
  assert.equal(res.status, 403, "a token never sees the page");
  const p = await page(S.ada, PAGE);
  assert.equal(p.status, 200);
  for (const s of ["Agent setup", "Generate agent token", "Not connected yet", `curl -fsSL ${base}/ada/zutrix/agent-setup.sh | bash`, `GH_HOST=${host}`, "DIFFINERY_REPO=ada/zutrix", "Network secrets"]) assert.ok(unescape(p.text).includes(s), s);
  // bob has write access but isn't an admin: Settings opens Agent setup, and it's the only tab.
  const b = await page(S.bob, PAGE);
  assert.equal(b.status, 200);
  assert.ok(b.text.includes('href="/ada/zutrix/settings/agent-setup"'));
  assert.ok(!b.text.includes('href="/ada/zutrix/settings/branches"'));
  assert.equal((await page(S.bob, "/ada/zutrix/settings")).status, 403);
});

test("generating a token makes ada's agent for this repository, and fills it in once", async () => {
  const r = await submit(S.ada, PAGE, `${PAGE}/generate`, { name: "Claude Code cloud · e2e" });
  assert.equal(r.status, 200, r.text.slice(0, 500));
  const env = envBox(r.text);
  token = /^DIFFINERY_TOKEN=(dfy_[A-Za-z0-9]+)$/m.exec(env)?.[1];
  assert.ok(token, env);
  assert.equal(env, [`DIFFINERY_TOKEN=${token}`, `GH_ENTERPRISE_TOKEN=${token}`, `GH_HOST=${host}`, "DIFFINERY_REPO=ada/zutrix", `DIFFINERY_URL=${base}`].join("\n"));
  const me = await ok("GET", "/user", undefined, token);
  assert.equal(me.login, "zutrix-agent");
  assert.equal(me.type, "Bot");
  // Shown once: the page masks it afterwards.
  const again = await page(S.ada, PAGE);
  assert.ok(!again.text.includes(token));
  assert.match(envBox(again.text), new RegExp(`^DIFFINERY_TOKEN=${token.slice(0, 10)}…$`, "m"));
  assert.ok(again.text.includes("Claude Code cloud · e2e"));
});

test("the hosted script holds no secret, and only answers for names a repository can have", async () => {
  const res = await fetch(`${base}/ada/zutrix/agent-setup.sh`);
  assert.equal(res.status, 200);
  const s = await res.text();
  assert.match(s, new RegExp(`^server=${base.replace(/[.]/g, "\\.")}$`, "m"));
  assert.match(s, /^repo=ada\/zutrix$/m);
  assert.match(s, /^cli_sha256=[0-9a-f]{64}$/m);
  assert.doesNotMatch(s, /dfy_[A-Za-z0-9]{10}/);
  assert.equal((await fetch(`${base}/no-such-owner/whatever/agent-setup.sh`)).status, 200, "says nothing about whether the repository exists");
  assert.equal((await fetch(`${base}/ada/${encodeURIComponent("$(id)")}/agent-setup.sh`)).status, 404);
});

test("a fresh machine with only the page's three boxes: everything works and the Check turns green", async () => {
  const m = machine("fresh");
  const env = Object.fromEntries(envBox((await page(S.ada, PAGE)).text).split("\n").map((l) => l.split("=")));
  Object.assign(env, { DIFFINERY_TOKEN: token, GH_ENTERPRISE_TOKEN: token });
  const first = await runSetup(m, env);
  assert.equal(first.code, 0, first.out);
  assert.ok(!first.out.includes(token), "never prints the token");
  assert.match(first.out, /✓ diffinery CLI: installed diffinery \d/);
  assert.ok(!first.out.includes("sign in through your browser"), "no advice meant for people");
  for (const s of ["✓ server:", "✓ diffinery on PATH:", "✓ DIFFINERY_TOKEN: acts as zutrix-agent (agent)", "✓ repository: ada/zutrix with write access", "✓ git:", "✓ clone: cloned into", "✓ gh: gh api acts as zutrix-agent", "✓ gh in the clone:", "Ready:"]) assert.ok(first.out.includes(s), `${s}\n${first.out}`);
  const all = { ...m.env, ...env };
  // The acceptance checks, as the session would run them: no path prefix, no prompt.
  assert.match((await sh("bash", ["-c", "diffinery --version"], { env: all }, true)).stdout, /0\.\d/);
  assert.match((await sh("bash", ["-c", "diffinery whoami"], { env: all }, true)).stdout, /zutrix-agent/);
  const fresh = join(m.root, "second-clone");
  await sh("git", ["clone", "-q", `${base}/ada/zutrix.git`, fresh], { env: { ...all, GIT_TERMINAL_PROMPT: "0" } }, true);
  assert.ok(existsSync(join(fresh, "README.md")));
  assert.equal((await sh("gh", ["api", "user", "--hostname", host, "--jq", ".login"], { env: all }, true)).stdout.trim(), "zutrix-agent");
  await sh("gh", ["pr", "list", "--state", "all"], { cwd: join(m.where, "zutrix"), env: all }, true);
  // No token anywhere on disk: git and gh read it from the environment.
  const files = (dir) => readdirSync(dir, { recursive: true }).map((f) => join(dir, String(f))).filter((f) => statSync(f).isFile() && statSync(f).size < 5_000_000);
  for (const f of files(m.home)) assert.ok(!readFileSync(f, "utf8").includes(token), `${f} holds the token`);
  // The Check, on the page and in the API.
  const check = await ok("GET", "/repos/ada/zutrix/diffinery/agent-setup", undefined, T.ada);
  assert.equal(check.check.ok, true, JSON.stringify(check));
  assert.equal(check.check.account, "zutrix-agent");
  assert.equal(check.check.token.name, "Claude Code cloud · e2e");
  const fragment = await page(S.ada, `${PAGE}/check`);
  assert.match(fragment.text, /Connected\./);

  // Every session start: the CLI isn't downloaded again, and the clone is brought up to date.
  await ok("PUT", "/repos/ada/zutrix/contents/NEWS.md", { message: "news", content: b64("news\n") }, T.ada);
  const started = Date.now();
  const second = await runSetup(m, env);
  assert.equal(second.code, 0, second.out);
  assert.ok(second.out.includes("diffinery CLI: already the current build"), second.out);
  assert.ok(second.out.includes("(up to date)"), second.out);
  assert.ok(existsSync(join(m.where, "zutrix", "NEWS.md")));
  assert.ok(Date.now() - started < 30_000, `second run took ${Date.now() - started} ms`);
});

test("failures say what to change, and a missing token doesn't fail the session", async () => {
  const m = machine("broken");
  const missing = await runSetup(m, {});
  assert.equal(missing.code, 0, missing.out);
  assert.match(missing.out, /DIFFINERY_TOKEN is not set: generate a token on .*\/ada\/zutrix\/settings\/agent-setup/);
  const noHost = await runSetup(m, { DIFFINERY_TOKEN: token, GH_ENTERPRISE_TOKEN: token, DIFFINERY_NO_CLONE: "1" });
  assert.equal(noHost.code, 1, noHost.out);
  assert.ok(noHost.out.includes(`✗ GH_HOST: not set: add GH_HOST=${host} to the environment variables`), noHost.out);
  const mismatch = await runSetup(m, { DIFFINERY_TOKEN: token, GH_ENTERPRISE_TOKEN: T.bob, GH_HOST: host, DIFFINERY_NO_CLONE: "1" });
  assert.equal(mismatch.code, 1);
  assert.ok(mismatch.out.includes("GH_ENTERPRISE_TOKEN isn't the same token as DIFFINERY_TOKEN"), mismatch.out);
  assert.ok(!mismatch.out.includes(T.bob) && !mismatch.out.includes(token));
  const refused = await runSetup(m, { DIFFINERY_TOKEN: "dfy_notarealtoken0000", DIFFINERY_NO_CLONE: "1" });
  assert.equal(refused.code, 1);
  assert.ok(refused.out.includes("refused (revoked or expired)"), refused.out);
  // A failed run is the Check now, saying what failed.
  const check = await ok("GET", "/repos/ada/zutrix/diffinery/agent-setup", undefined, T.ada);
  assert.equal(check.check.ok, false);
  assert.ok(check.check.checks.some((l) => l.name === "gh" && !l.ok));
});

test("the token reaches only its repository", async () => {
  assert.equal((await api("GET", "/repos/ada/other", undefined, token)).status, 404);
  assert.equal((await api("GET", "/repos/bob/pub", undefined, token)).status, 404, "not even a public one");
  assert.deepEqual((await ok("GET", "/user/repos", undefined, token)).map((r) => r.full_name), ["ada/zutrix"]);
  const dir = mkdtempSync(join(work, "iso-"));
  assert.match(await gitFails(dir, ["clone", "-q", `${base}/ada/other.git`, join(dir, "o")], token), /not found|401|403|404|Authentication/i);
  await git(dir, ["clone", "-q", `${base}/ada/zutrix.git`, join(dir, "z")], token);
  await git(join(dir, "z"), ["checkout", "-q", "-b", "feature"], token);
  writeFileSync(join(dir, "z", "x.txt"), "x\n");
  await git(join(dir, "z"), ["add", "."], token, { GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@x" });
  await git(join(dir, "z"), ["commit", "-qm", "x"], token, { GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@x" });
  assert.match(await gitFails(join(dir, "z"), ["push", "-q", `${base}/ada/other.git`, "feature"], token), /not found|denied|403|404/i);
  assert.match(await gitFails(join(dir, "z"), ["push", "-q", "origin", "HEAD:main"], token), /agents may not push/);
  await git(join(dir, "z"), ["push", "-q", "origin", "feature"], token);
  // Nor can it mint anything, or change account settings.
  assert.equal((await api("POST", "/diffinery/tokens", { name: "x" }, token)).status, 403);
  assert.equal((await api("PUT", "/repos/ada/zutrix/actions/secrets/X", { encrypted_value: "x" }, token)).status, 403);
});

test("merging: only what a person approved, never a workflow change, and off when ada says so", async () => {
  const pr = await ok("POST", "/repos/ada/zutrix/pulls", { title: "Add x", head: "feature", base: "main" }, token);
  const merge = () => api("PUT", `/repos/ada/zutrix/pulls/${pr.number}/merge`, { merge_method: "squash" }, token);
  const before = await merge();
  assert.equal(before.status, 405, JSON.stringify(before.json));
  assert.match(before.json.message, /needs 1 more approving review\(s\) of its latest commit/);
  await ok("POST", `/repos/ada/zutrix/pulls/${pr.number}/reviews`, { event: "APPROVE" }, T.ada);
  const merged = await merge();
  assert.equal(merged.status, 200, JSON.stringify(merged.json));

  // A change to a workflow file needs a person, approved or not.
  const wf = await ok("POST", "/repos/ada/zutrix/git/refs", { ref: "refs/heads/wf", sha: (await ok("GET", "/repos/ada/zutrix/git/ref/heads/main", undefined, T.ada)).object.sha }, T.ada);
  assert.ok(wf);
  await ok("PUT", "/repos/ada/zutrix/contents/.github/workflows/ci.yml", { message: "ci", content: b64("on: push\njobs: {}\n"), branch: "wf" }, T.ada);
  const wfPr = await ok("POST", "/repos/ada/zutrix/pulls", { title: "CI", head: "wf", base: "main" }, T.ada);
  await ok("POST", `/repos/ada/zutrix/pulls/${wfPr.number}/reviews`, { event: "APPROVE" }, T.bob);
  const wfMerge = await api("PUT", `/repos/ada/zutrix/pulls/${wfPr.number}/merge`, {}, token);
  assert.equal(wfMerge.status, 405);
  assert.match(wfMerge.json.message, /changes workflow file `\.github\/workflows\/ci\.yml`; a person must merge it/);
  const wfAuto = await api("PUT", `/repos/ada/zutrix/pulls/${wfPr.number}/auto-merge`, {}, token);
  assert.equal(wfAuto.status, 422, JSON.stringify(wfAuto.json));

  // Merging off: the agent rule is back.
  await ok("PUT", "/repos/ada/zutrix/contents/y.txt", { message: "y", content: b64("y\n"), branch: "wf" }, T.ada);
  const off = await submit(S.ada, PAGE, `${PAGE}/merge`, {});
  assert.equal(off.status, 303);
  assert.match(off.flash, /can no longer merge/);
  const plain = await ok("POST", "/repos/ada/zutrix/git/refs", { ref: "refs/heads/plain", sha: (await ok("GET", "/repos/ada/zutrix/git/ref/heads/main", undefined, T.ada)).object.sha }, T.ada);
  assert.ok(plain);
  await ok("PUT", "/repos/ada/zutrix/contents/z.txt", { message: "z", content: b64("z\n"), branch: "plain" }, T.ada);
  const plainPr = await ok("POST", "/repos/ada/zutrix/pulls", { title: "z", head: "plain", base: "main" }, T.ada);
  await ok("POST", `/repos/ada/zutrix/pulls/${plainPr.number}/reviews`, { event: "APPROVE" }, T.bob);
  const refused = await api("PUT", `/repos/ada/zutrix/pulls/${plainPr.number}/merge`, {}, token);
  assert.equal(refused.status, 405);
  assert.match(refused.json.message, /agents may not merge into this branch/);
  const on = await submit(S.ada, PAGE, `${PAGE}/merge`, { mayMerge: "1" });
  assert.match(on.flash, /can merge pull requests a person approved/);
  assert.equal((await api("PUT", `/repos/ada/zutrix/pulls/${plainPr.number}/merge`, {}, token)).status, 200);
});

test("renew, revoke and regenerate; an admin turns off someone else's agent", async () => {
  const html = (await page(S.ada, PAGE)).text;
  const id = /\/settings\/agent-setup\/tokens\/([^/]+)\/renew/.exec(html)?.[1];
  assert.ok(id);
  const renewed = await submit(S.ada, PAGE, `${PAGE}/tokens/${id}/renew`);
  assert.match(renewed.flash, /Renewed: the token works until/);
  const regen = await submit(S.ada, PAGE, `${PAGE}/tokens/${id}/regenerate`);
  assert.equal(regen.status, 200);
  const next = /^DIFFINERY_TOKEN=(dfy_[A-Za-z0-9]+)$/m.exec(envBox(regen.text))?.[1];
  assert.ok(next && next !== token);
  assert.equal((await api("GET", "/user", undefined, token)).status, 401, "the old token stops at once");
  assert.equal((await ok("GET", "/user", undefined, next)).login, "zutrix-agent", "the same agent");

  // bob's own agent here; ada, an admin, turns it off.
  const b = await submit(S.bob, PAGE, `${PAGE}/generate`, { name: "bob's" });
  const bobToken = /^DIFFINERY_TOKEN=(dfy_[A-Za-z0-9]+)$/m.exec(envBox(b.text))?.[1];
  const bobAgent = (await ok("GET", "/user", undefined, bobToken)).login;
  assert.equal(bobAgent, "bob-zutrix-agent");
  const adaView = (await page(S.ada, PAGE)).text;
  const agentId = /\/settings\/agent-setup\/agents\/([^/]+)\/disable/.exec(adaView)?.[1];
  assert.ok(agentId, "ada sees bob's agent");
  const off = await submit(S.ada, PAGE, `${PAGE}/agents/${agentId}/disable`);
  assert.equal(off.status, 303);
  assert.equal((await api("GET", "/user", undefined, bobToken)).status, 401);
  // bob still has write access, so he can generate again: the agent comes back, its old tokens don't.
  const back = await submit(S.bob, PAGE, `${PAGE}/generate`, { name: "bob's again" });
  const newer = /^DIFFINERY_TOKEN=(dfy_[A-Za-z0-9]+)$/m.exec(envBox(back.text))?.[1];
  assert.equal((await ok("GET", "/user", undefined, newer)).login, "bob-zutrix-agent");
  assert.equal((await api("GET", "/user", undefined, bobToken)).status, 401, "turned off for good");
  // bob, not an admin, can't do the same to ada's.
  assert.equal((await submit(S.bob, PAGE, `${PAGE}/agents/whatever/disable`)).status, 403);
});
