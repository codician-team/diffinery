// End-to-end GitHub-compatible apps (src/apps/, src/http/apps.ts): a real `wrangler dev` Worker, an
// app registered by a person, installed on some of their repositories, and then driven the way a
// GitHub App integration (a deploy service, a CI or review bot) drives GitHub: an RS256 JWT signed
// with its private key, installation access tokens, the unmodified @octokit/rest client, Git over
// HTTPS with x-access-token, and signed webhooks.
//
//   pnpm --filter @diffinery/app exec node --test test/e2e/apps.test.mjs
//
// Covers: registering (people in a browser only), the app's JWT (and expired, wrong-key and unknown
// ones), installing on all or selected repositories (only by admins of the account, private apps only
// on their owner), installation tokens narrowed by repository and permission, per-endpoint permissions,
// workflow files refused, Git clone and push, webhooks (installation, installation_repositories, push)
// with their signatures, suspending, new permissions waiting for an admin, revoking, uninstalling and
// deleting the app.
import "./fresh-connections.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createHash, createHmac, createPrivateKey, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Octokit } from "@octokit/rest";
import { chromium } from "playwright";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "diffinery-apps-"));
let base;
let dev;
let devLog = "";
let persist;
let hooks;
let browser;
/** Webhook deliveries the app's server received: { event, delivery, signature, body, json }. */
const received = [];

const ADA = "ada-browser-session-0123456789abcdef";
const BOB = "bob-browser-session-0123456789abcdef";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  assert.fail(`timed out waiting for ${what}\n--- wrangler log tail ---\n${devLog.slice(-4000)}`);
}
const wrangler = (...args) => execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });
const sql = (command) => wrangler("d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--command", command);

before(async () => {
  const port = await freePort();
  base = `http://localhost:${port}`;
  persist = join(work, "state");
  migratedState(APP, persist);
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 86400_000).toISOString();
  sql(
    [
      `INSERT INTO accounts (id, login, kind, name, email, status, created_at) VALUES ('ada1', 'ada', 'user', 'Ada', 'ada@example.com', 'active', '${at}')`,
      `INSERT INTO accounts (id, login, kind, name, email, status, created_at) VALUES ('bob1', 'bob', 'user', 'Bob', 'bob@example.com', 'active', '${at}')`,
      `INSERT INTO accounts (id, login, kind, name, status, created_at) VALUES ('acme1', 'acme', 'org', 'Acme', 'active', '${at}')`,
      `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('acme1', 'ada1', 'owner', '${at}'), ('acme1', 'bob1', 'member', '${at}')`,
      `INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(ADA)}', 'ada1', 'passkey', '${at}', '${at}', '${later}'), ('${hash(BOB)}', 'bob1', 'passkey', '${at}', '${at}', '${later}')`,
    ].join("; "),
  );
  // The app's own server: it receives the webhooks.
  hooks = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push({ event: req.headers["x-github-event"], delivery: req.headers["x-github-delivery"], signature: req.headers["x-hub-signature-256"], body, json: JSON.parse(body) });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise((r) => hooks.listen(0, "127.0.0.1", r));
  dev = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${base}`, "--var", "DEV_AUTH:", "--var", `MASTER_KEY:${randomBytes(32).toString("base64")}`, "--show-interactive-dev-session=false"],
    { cwd: APP, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  dev.stdout.on("data", (d) => (devLog += d));
  dev.stderr.on("data", (d) => (devLog += d));
  await until(
    "wrangler dev",
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
      } catch {
        return false;
      }
    },
    120_000,
  );
});

after(async () => {
  await browser?.close();
  hooks?.close();
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  }
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
});

/** The REST API as a person's browser session (`{ cookie }`), a bearer credential, or anonymously. */
async function api(method, path, body, as) {
  const headers = { "content-type": "application/json" };
  if (typeof as === "string") headers.authorization = `Bearer ${as}`;
  else if (as?.cookie) headers.cookie = `__Host-dfy_session=${as.cookie}`;
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
const ada = { cookie: ADA };
const bob = { cookie: BOB };
async function ok(method, path, body, as, status) {
  const r = await api(method, path, body, as);
  assert.ok(status ? r.status === status : r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

/** An app's JWT, as @octokit/auth-app and every GitHub App library make it. */
function appJwt(pem, iss, o = {}) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const head = enc({ alg: "RS256", typ: "JWT" });
  const claims = enc({ iat: o.iat ?? now - 60, exp: o.exp ?? now + 540, iss });
  const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(pem).toString("base64url");
  return `${head}.${claims}.${sig}`;
}

const octokit = (auth) => new Octokit({ auth, baseUrl: `${base}/api/v3`, request: { retries: 0 }, log: { debug() {}, info() {}, warn() {}, error() {} } });
/** The status an Octokit call failed with (it throws for 4xx), and its message. */
async function fails(p) {
  try {
    await p;
  } catch (e) {
    return { status: e.status, message: e.response?.data?.message ?? e.message };
  }
  assert.fail("expected the request to fail");
}

const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: work } }).toString();
const gitFails = (args, cwd) => {
  try {
    git(args, cwd);
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.fail(`expected git ${args.join(" ")} to fail`);
};

const deliveries = (event, f = () => true) => received.filter((d) => d.event === event && f(d.json));
const signed = (d, secret) => d.signature === `sha256=${createHmac("sha256", secret).update(d.body).digest("hex")}`;

test("an app is registered, installed and used as a GitHub App would be", async () => {
  // ada's repositories: site and docs are hers, web is her organization's.
  for (const [owner, name] of [["ada", "site"], ["ada", "docs"], ["acme", "web"]]) {
    await ok("POST", owner === "ada" ? "/user/repos" : `/orgs/${owner}/repos`, { name, private: true }, ada);
    await ok("PUT", `/repos/${owner}/${name}/contents/README.md`, { message: "Start", content: Buffer.from(`# ${name}\n`).toString("base64") }, ada);
  }
  await ok("PUT", "/repos/ada/site/contents/.github/workflows/ci.yml", { message: "CI", content: Buffer.from("on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n").toString("base64") }, ada);

  // ---------------------------------------------------------------- registering
  const secret = "the-app-webhook-secret";
  const spec = {
    name: "Cloud Builds",
    description: "Builds and deploys on every push",
    homepage_url: "https://builds.example.com",
    setup_url: "https://builds.example.com/setup",
    webhook_url: `http://127.0.0.1:${hooks.address().port}/webhooks`,
    webhook_secret: secret,
    default_permissions: { contents: "write", checks: "write", statuses: "write", pull_requests: "read" },
    default_events: ["push", "pull_request"],
  };
  // Only a person in a browser registers apps: not bob for ada's organization, and no token.
  assert.equal((await api("POST", "/diffinery/apps", { ...spec, owner: "acme" }, bob)).status, 422);
  assert.equal((await api("POST", "/diffinery/apps", spec)).status, 401);
  // An event the permissions don't cover, and a permission apps can't have.
  assert.match((await api("POST", "/diffinery/apps", { ...spec, default_events: ["issues"] }, ada)).json.message, /issues permission/);
  assert.match((await api("POST", "/diffinery/apps", { ...spec, default_permissions: { administration: "write" } }, ada)).json.message, /unsupported permission 'administration'/);
  const app = await ok("POST", "/diffinery/apps", spec, ada, 201);
  assert.equal(app.slug, "cloud-builds");
  assert.equal(typeof app.id, "number");
  assert.match(app.client_id, /^Iv23/);
  // A PKCS#1 PEM file, as GitHub hands out: exactly what Node exports for the key in that format.
  const key = createPrivateKey(app.pem);
  assert.equal(key.asymmetricKeyDetails.modulusLength, 2048);
  assert.equal(key.export({ type: "pkcs1", format: "pem" }), app.pem);
  assert.deepEqual(app.permissions, { metadata: "read", contents: "write", pull_requests: "read", checks: "write", statuses: "write" });
  assert.equal(app.webhook_secret, null, "a chosen secret isn't echoed");
  assert.equal((await api("POST", "/diffinery/apps", { ...spec, name: "cloud builds" }, ada)).status, 422, "names are unique");

  // ---------------------------------------------------------------- the app's JWT
  const jwt = () => appJwt(app.pem, app.id);
  const me = await octokit(jwt()).apps.getAuthenticated();
  assert.equal(me.data.slug, "cloud-builds");
  assert.equal(me.data.owner.login, "ada");
  // By client id too, as newer libraries do.
  assert.equal((await api("GET", "/app", undefined, appJwt(app.pem, app.client_id))).json.id, app.id);
  const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  assert.equal((await api("GET", "/app", undefined, appJwt(stranger, app.id))).status, 401, "a key that isn't the app's");
  const now = Math.floor(Date.now() / 1000);
  assert.match((await api("GET", "/app", undefined, appJwt(app.pem, app.id, { iat: now - 1200, exp: now - 600 }))).json.message, /Expiration time/);
  assert.match((await api("GET", "/app", undefined, appJwt(app.pem, app.id, { iat: now, exp: now + 3600 }))).json.message, /too far in the future/);
  assert.equal((await api("GET", "/app", undefined, appJwt(app.pem, 999999))).status, 401);
  // A JWT is for app endpoints only: repositories don't open to it.
  assert.equal((await api("GET", "/repos/ada/site", undefined, jwt())).status, 404);
  assert.equal((await api("GET", "/user", undefined, jwt())).status, 403);
  assert.deepEqual((await octokit(jwt()).apps.listInstallations()).data, []);

  // ---------------------------------------------------------------- installing
  // A private app installs only on its owner's account; bob can't install it, or install on acme.
  assert.equal((await api("POST", `/diffinery/apps/${app.slug}/installations`, { account: "bob" }, bob)).status, 404);
  assert.equal((await api("POST", `/diffinery/apps/${app.slug}/installations`, { account: "acme" }, ada)).status, 403, "only on its owner's account while private");
  // Not someone else's repository, and not by a token.
  assert.equal((await api("POST", `/diffinery/apps/${app.slug}/installations`, { repository_selection: "selected", repositories: ["acme/web"] }, ada)).status, 422);
  const inst = await ok("POST", `/diffinery/apps/${app.slug}/installations`, { repository_selection: "selected", repositories: ["site"] }, ada, 201);
  assert.equal(inst.account.login, "ada");
  assert.equal(inst.app_slug, "cloud-builds");
  assert.equal(inst.repository_selection, "selected");
  assert.equal((await api("POST", `/diffinery/apps/${app.slug}/installations`, {}, ada)).status, 422, "installed once per account");
  const created = await until("the installation webhook", () => deliveries("installation", (j) => j.action === "created")[0]);
  assert.ok(signed(created, secret), "signed with the app's webhook secret");
  assert.equal(created.json.installation.id, inst.id);
  assert.deepEqual(created.json.repositories.map((r) => r.full_name), ["ada/site"]);
  assert.equal(created.json.sender.login, "ada");

  const asApp = octokit(jwt());
  assert.equal((await asApp.apps.getRepoInstallation({ owner: "ada", repo: "site" })).data.id, inst.id);
  assert.equal((await asApp.apps.getUserInstallation({ username: "ada" })).data.id, inst.id);
  assert.equal((await fails(asApp.apps.getRepoInstallation({ owner: "ada", repo: "docs" }))).status, 404, "not selected");
  assert.equal((await fails(asApp.apps.getOrgInstallation({ org: "acme" }))).status, 404);

  // ---------------------------------------------------------------- installation tokens
  assert.equal((await fails(asApp.apps.createInstallationAccessToken({ installation_id: inst.id, repositories: ["docs"] }))).status, 422, "a repository the installation doesn't cover");
  assert.match((await fails(asApp.apps.createInstallationAccessToken({ installation_id: inst.id, permissions: { issues: "write" } }))).message, /not granted to this installation/);
  const t = (await asApp.apps.createInstallationAccessToken({ installation_id: inst.id })).data;
  assert.match(t.token, /^dia_/);
  assert.ok(Date.parse(t.expires_at) > Date.now() + 50 * 60_000);
  assert.deepEqual(t.permissions, { metadata: "read", contents: "write", pull_requests: "read", checks: "write", statuses: "write" });
  const bot = octokit(t.token);
  const repos = (await bot.apps.listReposAccessibleToInstallation()).data;
  assert.deepEqual(
    repos.repositories.map((r) => r.full_name),
    ["ada/site"],
  );
  const site = (await bot.repos.get({ owner: "ada", repo: "site" })).data;
  assert.equal(site.full_name, "ada/site");
  assert.equal((await fails(bot.repos.get({ owner: "ada", repo: "docs" }))).status, 404, "a repository it wasn't given");
  assert.equal((await fails(bot.repos.get({ owner: "acme", repo: "web" }))).status, 404);
  assert.equal((await api("GET", "/user", undefined, t.token)).status, 403, "an installation token isn't a person");
  assert.equal((await api("POST", "/diffinery/apps", spec, t.token)).status, 403, "nor can it register apps");

  // What its permissions allow, endpoint by endpoint.
  const head = (await bot.repos.getBranch({ owner: "ada", repo: "site", branch: "main" })).data.commit.sha;
  const check = (await bot.checks.create({ owner: "ada", repo: "site", name: "Cloud Builds", head_sha: head, status: "completed", conclusion: "success", details_url: "https://builds.example.com/1" })).data;
  assert.equal(check.app.slug, "cloud-builds");
  const status = (await bot.repos.createCommitStatus({ owner: "ada", repo: "site", sha: head, state: "success", context: "builds/deploy", target_url: "https://site.example.workers.dev" })).data;
  assert.equal(status.creator.login, "cloud-builds[bot]");
  assert.equal(status.creator.type, "Bot");
  const issue = await fails(bot.issues.create({ owner: "ada", repo: "site", title: "no issues permission" }));
  assert.equal(issue.status, 403);
  assert.match(issue.message, /Resource not accessible by integration \(the app needs the issues permission: write\)/);
  assert.equal((await fails(bot.repos.createWebhook({ owner: "ada", repo: "site", config: { url: "https://x.example.com" } }))).status, 403, "settings are never an app's");
  assert.equal((await fails(bot.actions.createOrUpdateRepoSecret({ owner: "ada", repo: "site", secret_name: "X", encrypted_value: "eA==" }))).status, 403);
  const readme = (await bot.repos.getContent({ owner: "ada", repo: "site", path: "README.md" })).data;
  await bot.repos.createOrUpdateFileContents({ owner: "ada", repo: "site", path: "README.md", sha: readme.sha, message: "Deployed", content: Buffer.from("# site\n\nDeployed.\n").toString("base64") });
  const wf = await fails(bot.repos.createOrUpdateFileContents({ owner: "ada", repo: "site", path: ".github/workflows/evil.yml", message: "sneak", content: Buffer.from("on: push\n").toString("base64") }));
  assert.ok(wf.status === 403 || wf.status === 422, JSON.stringify(wf));
  assert.match(wf.message, /workflow/);

  // Narrowed to read: writes stop.
  const ro = (await asApp.apps.createInstallationAccessToken({ installation_id: inst.id, permissions: { contents: "read" } })).data;
  assert.deepEqual(ro.permissions, { metadata: "read", contents: "read" });
  assert.equal((await fails(octokit(ro.token).checks.create({ owner: "ada", repo: "site", name: "x", head_sha: head }))).status, 403);

  // ---------------------------------------------------------------- Git over HTTPS
  const remote = (token, name = "site") => `${base.replace("://", `://x-access-token:${token}@`)}/ada/${name}.git`;
  const clone = join(work, "site");
  git(["clone", "-q", remote(t.token), clone]);
  git(["-c", "user.name=Cloud Builds", "-c", "user.email=builds@example.com", "commit", "-q", "--allow-empty", "-m", "From the app"], clone);
  git(["push", "-q", "origin", "HEAD:main"], clone);
  writeFileSync(join(clone, ".github/workflows/ci.yml"), "on: push\njobs: {}\n");
  git(["-c", "user.name=Cloud Builds", "-c", "user.email=builds@example.com", "commit", "-q", "-am", "Change CI"], clone);
  assert.match(gitFails(["push", "-q", "origin", "HEAD:refs/heads/ci-change"], clone), /workflow/);
  assert.match(gitFails(["ls-remote", remote(t.token, "docs")], work), /not found|404|Authentication|could not read/i);
  assert.match(gitFails(["push", "-q", remote(ro.token), "HEAD~1:refs/heads/ro"], clone), /403|denied|not accessible|permission/i);

  // The push came back to the app as a webhook, through its installation.
  const push = await until("the push webhook", () => deliveries("push", (j) => j.repository?.full_name === "ada/site")[0]);
  assert.ok(signed(push, secret));
  assert.equal(push.json.installation.id, inst.id);
  assert.equal(deliveries("push", (j) => j.repository?.full_name === "ada/docs").length, 0, "nothing from repositories it wasn't given");

  // ---------------------------------------------------------------- changing repositories
  await ok("PATCH", `/diffinery/installations/${inst.id}`, { repository_selection: "selected", repositories: ["site", "docs"] }, ada);
  const added = await until("installation_repositories", () => deliveries("installation_repositories", (j) => j.action === "added")[0]);
  assert.deepEqual(added.json.repositories_added.map((r) => r.full_name), ["ada/docs"]);
  assert.equal((await bot.repos.get({ owner: "ada", repo: "docs" })).data.name, "docs", "a token for everything reaches the new repository");
  const docsId = (await bot.repos.get({ owner: "ada", repo: "docs" })).data.id;
  const onlySite = (await asApp.apps.createInstallationAccessToken({ installation_id: inst.id, repositories: ["site"] })).data;
  assert.deepEqual(onlySite.repositories.map((r) => r.name), ["site"]);
  assert.equal((await fails(octokit(onlySite.token).repos.get({ owner: "ada", repo: "docs" }))).status, 404, "a token narrowed to site");
  assert.equal((await asApp.apps.createInstallationAccessToken({ installation_id: inst.id, repository_ids: [docsId] })).data.repositories[0].name, "docs", "by numeric id");
  // GitHub's per-repository endpoints for people.
  assert.equal((await api("DELETE", `/user/installations/${inst.id}/repositories/${docsId}`, undefined, ada)).status, 204);
  assert.equal((await fails(bot.repos.get({ owner: "ada", repo: "docs" }))).status, 404);
  assert.equal((await api("PUT", `/user/installations/${inst.id}/repositories/${docsId}`, undefined, t.token)).status, 403, "an app can't widen its own access");
  const mine = await ok("GET", "/user/installations", undefined, ada);
  assert.deepEqual(mine.installations.map((i) => i.app_slug), ["cloud-builds"]);
  assert.equal((await ok("GET", "/user/installations", undefined, bob)).total_count, 0);

  // ---------------------------------------------------------------- new permissions wait for an admin
  await ok("PATCH", `/diffinery/apps/${app.slug}`, { default_permissions: { ...spec.default_permissions, issues: "write" }, default_events: ["push", "pull_request", "issues"] }, ada);
  const waiting = await ok("GET", `/diffinery/installations/${inst.id}`, undefined, ada);
  assert.equal(waiting.pending_permissions.issues, "write");
  assert.equal(waiting.permissions.issues, undefined, "not until an admin accepts");
  assert.equal((await fails(octokit((await asApp.apps.createInstallationAccessToken({ installation_id: inst.id })).data.token).issues.create({ owner: "ada", repo: "site", title: "x" }))).status, 403);
  await ok("POST", `/diffinery/installations/${inst.id}/accept_permissions`, undefined, ada);
  await until("new_permissions_accepted", () => deliveries("installation", (j) => j.action === "new_permissions_accepted")[0]);
  const withIssues = octokit((await asApp.apps.createInstallationAccessToken({ installation_id: inst.id })).data.token);
  assert.equal((await withIssues.issues.create({ owner: "ada", repo: "site", title: "Deploy failed" })).data.user.login, "cloud-builds[bot]");
  // Less takes effect at once, even for tokens already made.
  await ok("PATCH", `/diffinery/apps/${app.slug}`, { default_permissions: spec.default_permissions }, ada);
  assert.equal((await fails(withIssues.issues.create({ owner: "ada", repo: "site", title: "x" }))).status, 403);

  // ---------------------------------------------------------------- suspending, revoking, uninstalling
  await ok("PUT", `/diffinery/installations/${inst.id}/suspended`, undefined, ada, 204);
  assert.equal((await api("GET", "/repos/ada/site", undefined, t.token)).status, 401, "a suspended installation's tokens stop");
  assert.equal((await fails(asApp.apps.createInstallationAccessToken({ installation_id: inst.id }))).status, 403);
  assert.equal((await fails(asApp.apps.unsuspendInstallation({ installation_id: inst.id }))).status, 403, "the app can't lift an admin's suspension");
  await ok("DELETE", `/diffinery/installations/${inst.id}/suspended`, undefined, ada, 204);
  await until("suspend and unsuspend webhooks", () => deliveries("installation", (j) => j.action === "unsuspend")[0] && deliveries("installation", (j) => j.action === "suspend")[0]);
  const fresh = (await asApp.apps.createInstallationAccessToken({ installation_id: inst.id })).data.token;
  assert.equal((await api("GET", "/repos/ada/site", undefined, fresh)).status, 200);
  assert.equal((await api("DELETE", "/installation/token", undefined, fresh)).status, 204);
  assert.equal((await api("GET", "/repos/ada/site", undefined, fresh)).status, 401, "revoked");

  // Keys: a second one works, the last one can't go.
  const key2 = await ok("POST", `/diffinery/apps/${app.slug}/keys`, undefined, ada, 201);
  assert.equal((await api("GET", "/app", undefined, appJwt(key2.pem, app.id))).status, 200);
  const keys = await ok("GET", `/diffinery/apps/${app.slug}/keys`, undefined, ada);
  assert.equal(keys.length, 2);
  await ok("DELETE", `/diffinery/apps/${app.slug}/keys/${keys[0].id}`, undefined, ada, 204);
  assert.equal((await api("GET", "/app", undefined, jwt())).status, 401, "the deleted key's JWTs stop");
  assert.equal((await api("DELETE", `/diffinery/apps/${app.slug}/keys/${keys[1].id}`, undefined, ada)).status, 422);

  // The app uninstalls itself; then its owner deletes it.
  const asApp2 = octokit(appJwt(key2.pem, app.id));
  await asApp2.apps.deleteInstallation({ installation_id: inst.id });
  await until("the deleted webhook", () => deliveries("installation", (j) => j.action === "deleted")[0]);
  assert.equal((await api("GET", "/repos/ada/site", undefined, t.token)).status, 401, "an uninstalled app's tokens stop");
  assert.deepEqual((await asApp2.apps.listInstallations()).data, []);
  assert.equal((await api("DELETE", `/diffinery/apps/${app.slug}`, undefined, bob)).status, 404);
  await ok("DELETE", `/diffinery/apps/${app.slug}`, undefined, ada, 204);
  assert.equal((await api("GET", "/app", undefined, appJwt(key2.pem, app.id))).status, 401);
});

test("people register, install and manage apps in the browser", async () => {
  browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: base });
  const page = await context.newPage();
  await page.goto("/healthz");
  await page.evaluate((v) => (document.cookie = `__Host-dfy_session=${v}; path=/; secure; samesite=lax`), ADA);
  const shot = (name) => (process.env.E2E_SCREENSHOTS ? page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}.png`), fullPage: true }) : null);

  await page.goto("/settings/apps");
  await page.getByRole("link", { name: "New app" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Preview Bot");
  await page.getByLabel("Homepage URL").fill("https://preview.example.com");
  await page.getByLabel("Description").fill("Posts a preview link on every pull request");
  // Permissions are Kumo selects: pick Read and write for Checks.
  await page.getByRole("combobox", { name: "Checks" }).click();
  await page.getByRole("option", { name: "Read and write" }).click();
  await shot("apps-new");
  await page.getByRole("button", { name: "Register app" }).click();
  await page.getByText("Preview Bot is registered: its private key").waitFor();
  const pem = await page.locator("pre.secret").first().textContent();
  assert.equal(createPrivateKey(pem).asymmetricKeyDetails.modulusLength, 2048, "the key shown once is the app's private key");
  await shot("apps-created");
  const appId = Number(await page.locator(".field", { hasText: "App ID" }).locator(".mono").textContent());
  assert.equal((await api("GET", "/app", undefined, appJwt(pem, appId))).json.permissions.checks, "write");
  // Reloading never shows the key again.
  await page.goto("/settings/apps/preview-bot");
  assert.equal(await page.locator("pre.secret").count(), 0);

  // Install it on ada's site repository only, from its public page.
  await page.goto("/apps/preview-bot");
  await page.getByRole("link", { name: "Install" }).first().click();
  await page.getByRole("link", { name: "Install" }).first().click();
  await page.getByRole("radio", { name: /Only select repositories/ }).click();
  await page.getByRole("checkbox", { name: "site" }).click();
  await shot("apps-install");
  await page.getByRole("button", { name: "Install" }).click();
  await page.waitForURL(/\/settings\/installations\/\d+$/);
  await page.getByText("Installed Preview Bot on ada.").waitFor();
  await shot("apps-installation");
  const inst = await ok("GET", "/user/installations", undefined, ada);
  const mine = inst.installations.find((i) => i.app_slug === "preview-bot");
  assert.equal(mine.repository_selection, "selected");
  const token = (await octokit(appJwt(pem, appId)).apps.createInstallationAccessToken({ installation_id: mine.id })).data.token;
  assert.deepEqual((await octokit(token).apps.listReposAccessibleToInstallation()).data.repositories.map((r) => r.name), ["site"]);

  // Suspend, unsuspend and uninstall from Installed apps.
  await page.goto("/settings/installations");
  await page.getByRole("link", { name: "Preview Bot" }).click();
  await page.getByRole("button", { name: "Suspend" }).click();
  await page.getByText("Suspended Preview Bot.").waitFor();
  assert.equal((await api("GET", "/repos/ada/site", undefined, token)).status, 401);
  await page.getByRole("button", { name: "Unsuspend" }).click();
  await page.getByText("Unsuspended Preview Bot.").waitFor();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Uninstall" }).click();
  await page.getByText("Uninstalled Preview Bot from ada.").waitFor();
  assert.equal((await ok("GET", "/user/installations", undefined, ada)).installations.filter((i) => i.app_slug === "preview-bot").length, 0);

  // Delete the app, typing its slug.
  await page.goto("/settings/apps/preview-bot");
  await page.getByLabel("Confirm the app's slug").fill("preview-bot");
  await page.getByRole("button", { name: "Delete app" }).click();
  await page.getByText("Deleted Preview Bot.").waitFor();
  assert.equal((await api("GET", "/app", undefined, appJwt(pem, appId))).status, 401);
  await context.close();
});
