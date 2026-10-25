// Shared by security.test.mjs and security-limits.test.mjs: a real `wrangler dev` Worker per test
// file, seeded with the same accounts, tokens and sessions, and the helpers both files use.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

export const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const work = mkdtempSync(join(tmpdir(), "diffinery-security-"));
export let base;
export let dev;
export let devLog = "";

export const hash = (s) => createHash("sha256").update(s).digest("hex");
export const tok = (name) => `dfy_${name}_${randomBytes(12).toString("hex")}`;
export const T = { sully: tok("sully"), olive: tok("olive"), bot: tok("bot"), rita: tok("rita"), dora: tok("dora"), orphan: tok("orphan"), reader: tok("reader"), ritaAdmin: tok("ritaAdmin"), milo: tok("milo"), sam: tok("sam"), helper: tok("helper") };
export const S = { penny: `penny-session-${randomBytes(12).toString("hex")}`, dora: `dora-session-${randomBytes(12).toString("hex")}`, olive: `olive-session-${randomBytes(12).toString("hex")}`, sam: `sam-session-${randomBytes(12).toString("hex")}`, oliveOld: `olive-old-${randomBytes(12).toString("hex")}`, oliveStale: `olive-stale-${randomBytes(12).toString("hex")}`, oliveSpare: `olive-spare-${randomBytes(12).toString("hex")}` };
export const OWNER = "olive";
/** One minute of an environment's wait timer, in this Worker (WAIT_TIMER_MINUTE_MS). */
export const TIMER_MINUTE_MS = 10_000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(what, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  assert.fail(`timed out waiting for ${what}\n--- wrangler log tail ---\n${devLog.slice(-4000)}`);
}

/** Call the REST API as a token (`as`), a session cookie (`{ cookie }`) or anonymously (null). */
export async function api(method, path, body, as = T.olive) {
  const headers = { "content-type": "application/json" };
  if (typeof as === "string") headers.authorization = `Bearer ${as}`;
  else if (as?.cookie) headers.cookie = `__Host-dfy_session=${as.cookie}`;
  const send = () => fetch(`${base}/api/v3${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  // wrangler dev closes idle keep-alive connections (the audit checks pause for seconds), so a reused one can be gone.
  const res = await send().catch((e) => (e.cause?.code === "UND_ERR_SOCKET" ? send() : Promise.reject(e)));
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
export const e2eRunners = new Map();
export async function runnerClaim(repoPath, labels = ["linux"]) {
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
export async function ok(method, path, body, as) {
  const r = await api(method, path, body, as);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
export async function status(expected, method, path, body, as) {
  const r = await api(method, path, body, as);
  assert.equal(r.status, expected, `${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
export const b64 = (s) => Buffer.from(s).toString("base64");

/**
 * Give someone access to a repository as GitHub does: someone new gets an invitation (201), which
 * they accept with their own token; an existing collaborator's role changes at once (204).
 */
export async function collaborator(repo, login, permission, invitee, as = T.olive) {
  const r = await api("PUT", `${repo}/collaborators/${login}`, { permission }, as);
  if (r.status === 204) return;
  assert.equal(r.status, 201, `PUT ${repo}/collaborators/${login} -> ${r.status} ${JSON.stringify(r.json)}`);
  await status(204, "PATCH", `/user/repository_invitations/${r.json.id}`, undefined, invitee);
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const persist = join(work, "state");
  const wrangler = (...args) => execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });
  migratedState(APP, persist);
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 30 * 86400_000).toISOString();
  const account = (id, login, kind, status, owner = null) => `INSERT INTO accounts (id, login, kind, name, status, owner_id, created_at) VALUES ('${id}', '${login}', '${kind}', '${login}', '${status}', ${owner ? `'${owner}'` : "NULL"}, '${at}')`;
  const token = (id, account, t, scopes) => `INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('${id}', '${account}', 'e2e', '${hash(t)}', '${t.slice(0, 10)}', '${JSON.stringify(scopes)}', '${later}', '${at}')`;
  const session = (id, account, cookie) => `INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(cookie)}', '${account}', 'passkey', '${at}', '${at}', '${later}')`;
  wrangler(
    "d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--command",
    [
      account("u-olive", "olive", "user", "active"),
      account("u-sully", "sully", "user", "active"),
      "UPDATE accounts SET site_admin = 1 WHERE id = 'u-sully'",
      token("t-sully", "u-sully", T.sully, ["admin"]),
      account("a-bot", "olive-bot", "agent", "active", "u-olive"),
      account("u-rita", "rita", "user", "active"),
      account("u-penny", "penny", "user", "pending"),
      account("u-dora", "dora", "user", "disabled"),
      account("u-gone", "gone", "user", "disabled"),
      account("a-orphan", "gone-bot", "agent", "active", "u-gone"),
      token("t1", "u-olive", T.olive, ["admin"]),
      token("t2", "a-bot", T.bot, ["admin"]),
      token("t3", "u-rita", T.rita, ["write"]),
      token("t4", "u-dora", T.dora, ["write"]),
      token("t5", "a-orphan", T.orphan, ["write"]),
      account("o-guild", "guild", "org", "active"),
      `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('o-guild', 'u-olive', 'owner', '${at}'), ('o-guild', 'u-rita', 'admin', '${at}')`,
      token("t6", "u-olive", T.reader, ["read"]),
      token("t7", "u-rita", T.ritaAdmin, ["admin"]),
      account("u-milo", "milo", "user", "active"),
      token("t8", "u-milo", T.milo, ["admin"]),
      `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('o-guild', 'u-milo', 'member', '${at}')`,
      session("s1", "u-penny", S.penny),
      session("s2", "u-dora", S.dora),
      session("s3", "u-olive", S.olive),
      account("o-shop", "shop", "org", "active"),
      account("u-sam", "sam", "user", "active"),
      token("t9", "u-sam", T.sam, ["admin"]),
      account("a-helper", "olive-helper", "agent", "active", "u-olive"),
      token("t10", "a-helper", T.helper, ["write"]),
      `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('o-shop', 'u-olive', 'owner', '${at}'), ('o-shop', 'u-sam', 'member', '${at}')`,
      session("s4", "u-sam", S.sam),
      "UPDATE accounts SET email = 'sam@example.com' WHERE id = 'u-sam'",
      // olive's other browsers: one signed in 3 hours ago, one 100 days ago (used every day since), one spare.
      session("s5", "u-olive", S.oliveOld).replace(`'${at}', '${at}'`, `'${new Date(Date.now() - 3 * 3600_000).toISOString()}', '${at}'`),
      session("s6", "u-olive", S.oliveStale).replace(`'${at}', '${at}'`, `'${new Date(Date.now() - 100 * 86400_000).toISOString()}', '${at}'`),
      session("s7", "u-olive", S.oliveSpare),
    ].join("; "),
  );
  dev = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${base}`, "--var", "DEV_AUTH:", "--var", `WAIT_TIMER_MINUTE_MS:${TIMER_MINUTE_MS}`, "--var", `MASTER_KEY:${randomBytes(32).toString("base64")}`, "--var", `OIDC_PRIVATE_KEY:${JSON.stringify(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }))}`, "--show-interactive-dev-session=false"],
    { cwd: APP, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
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
});

after(() => {
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  }
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
});

/** A private repository owned by olive with one commit on main. */
export async function repoWithReadme(name, extra = {}) {
  await ok("POST", "/user/repos", { name, ...extra });
  const put = await ok("PUT", `/repos/${OWNER}/${name}/contents/README.md`, { message: "init", content: b64(`# ${name}\n`) });
  return put.commit.sha;
}

/** Audit entries recorded so far, read straight from the local D1 database. The running dev server can hold its lock, so a busy database is retried. */
export function auditLog(action) {
  for (let attempt = 1; ; attempt++) {
    try {
      return readAuditLog(action);
    } catch (e) {
      if (attempt >= 10 || !/SQLITE_BUSY|database is locked/.test(String(e.stderr ?? e.message))) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * attempt);
    }
  }
}

export function readAuditLog(action) {
  const out = execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", join(work, "state"), "--json", "--command", `SELECT actor_login, action, target, detail FROM audit_log WHERE action = '${action}'`], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });
  return JSON.parse(out.toString())[0].results;
}

export const oliveSubmits = (page, action, fields) => submitsAs(S.olive, page, action, fields);

/** A web form post signed in with `session`, with the CSRF pair taken from `page`. */
export async function submitsAs(session, page, action, fields) {
  const cookie = `__Host-dfy_session=${session}`;
  const res = await fetch(`${base}${page}`, { headers: { cookie } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await res.text())?.[1];
  const pair = /dfy_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(csrf && pair, `no CSRF pair on ${page} (${res.status})`);
  const r = await fetch(`${base}${action}`, { method: "POST", body: new URLSearchParams({ _csrf: csrf, ...fields }), redirect: "manual", headers: { cookie: `${cookie}; dfy_csrf=${pair}`, "sec-fetch-site": "same-origin" } });
  return { status: r.status, location: r.headers.get("location"), flash: decodeURIComponent(decodeURIComponent(r.headers.get("set-cookie") ?? "")), text: await r.text() };
}

/** Runs git, returning its stderr; fails the test when git fails. */
export function gitRun(args, cwd) {
  const r = spawnSync("git", ["-c", "protocol.version=2", "-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stderr;
}
