// End-to-end account lifecycle against a real `wrangler dev` Worker with seeded accounts, tokens and sessions.
//
//   pnpm --filter @diffinery/app e2e
//
// Covers: deleting your own account (refused while you are an organization's only owner, which it names;
// then your repositories, tokens, sessions and agents go, your comments elsewhere show as ghost, and your
// username waits 90 days), a site administrator deleting someone's account, exporting an account (a tar
// archive with a clonable Git bundle and the issues you wrote), and granting and revoking site
// administration (signed in recently, audited, never the last site administrator).
import "./fresh-connections.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "diffinery-accounts-"));
let base;
let dev;
let devLog = "";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const tok = (name) => `dfy_${name}_${randomBytes(12).toString("hex")}`;
const sess = (name) => `${name}-session-${randomBytes(12).toString("hex")}`;
const T = { sully: tok("sully"), alice: tok("alice"), alicebot: tok("alicebot"), bob: tok("bob"), carl: tok("carl"), erin: tok("erin"), dan: tok("dan") };
const S = { sully: sess("sully"), sullyOld: sess("sullyold"), alice: sess("alice"), aliceOther: sess("aliceother"), bob: sess("bob"), carl: sess("carl"), erin: sess("erin"), dan: sess("dan") };

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

/** Call the REST API as a token, a session cookie (`{ cookie }`) or anonymously (null). */
async function api(method, path, body, as) {
  const headers = { "content-type": "application/json" };
  if (typeof as === "string") headers.authorization = `Bearer ${as}`;
  else if (as?.cookie) headers.cookie = `__Host-dfy_session=${as.cookie}`;
  const send = () => fetch(`${base}/api/v3${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
async function ok(method, path, body, as) {
  const r = await api(method, path, body, as);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
async function status(expected, method, path, body, as) {
  const r = await api(method, path, body, as);
  assert.equal(r.status, expected, `${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
const b64 = (s) => Buffer.from(s).toString("base64");

/** A web page as someone signed in with `session`. */
async function page(session, path) {
  const res = await fetch(`${base}${path}`, { headers: { cookie: `__Host-dfy_session=${session}` }, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), text: await res.text(), headers: res.headers };
}

/** A web form post signed in with `session`, with the CSRF pair taken from `from`. The flash message comes back decoded. */
async function submit(session, from, action, fields) {
  const cookie = `__Host-dfy_session=${session}`;
  const res = await fetch(`${base}${from}`, { headers: { cookie } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await res.text())?.[1];
  const pair = /dfy_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(csrf && pair, `no CSRF pair on ${from} (${res.status})`);
  const r = await fetch(`${base}${action}`, { method: "POST", body: new URLSearchParams({ _csrf: csrf, ...fields }), redirect: "manual", headers: { cookie: `${cookie}; dfy_csrf=${pair}`, "sec-fetch-site": "same-origin" } });
  return { status: r.status, location: r.headers.get("location"), flash: decodeURIComponent(decodeURIComponent(r.headers.get("set-cookie") ?? "")) };
}

/** The audit log's rows (site administrators' page), as text. */
async function auditRows() {
  const html = (await page(S.sully, "/settings/audit")).text;
  return [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " "));
}

/** Files in an uncompressed tar archive (ustar, with pax headers for long names). */
function untar(buf) {
  const files = new Map();
  let i = 0;
  let longName = null;
  while (i + 512 <= buf.length) {
    const h = buf.subarray(i, i + 512);
    if (h.every((b) => b === 0)) break;
    const field = (from, len) => h.subarray(from, from + len).toString("utf8").replace(/\0[\s\S]*$/, "");
    const size = parseInt(field(124, 12).trim(), 8);
    const type = String.fromCharCode(h[156]);
    const body = buf.subarray(i + 512, i + 512 + size);
    i += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      longName = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1] ?? null;
      continue;
    }
    files.set(longName ?? field(0, 100), Buffer.from(body));
    longName = null;
  }
  return files;
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const persist = join(work, "state");
  const wrangler = (...args) => execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });
  migratedState(APP, persist);
  const at = new Date().toISOString();
  const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  const later = new Date(Date.now() + 30 * 86400_000).toISOString();
  const account = (id, login, kind, owner = null) => `INSERT INTO accounts (id, login, kind, name, email, status, owner_id, created_at) VALUES ('${id}', '${login}', '${kind}', '${login}', ${kind === "user" ? `'${login}@example.com'` : "NULL"}, 'active', ${owner ? `'${owner}'` : "NULL"}, '${at}')`;
  const token = (id, account, t) => `INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('${id}', '${account}', 'e2e', '${hash(t)}', '${t.slice(0, 10)}', '["admin"]', '${later}', '${at}')`;
  const session = (account, cookie, signedIn = at) => `INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(cookie)}', '${account}', 'passkey', '${signedIn}', '${at}', '${later}')`;
  wrangler(
    "d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--command",
    [
      account("u-sully", "sully", "user"),
      "UPDATE accounts SET site_admin = 1 WHERE id = 'u-sully'",
      account("u-alice", "alice", "user"),
      account("a-alicebot", "alice-bot", "agent", "u-alice"),
      account("u-bob", "bob", "user"),
      account("u-carl", "carl", "user"),
      account("u-erin", "erin", "user"),
      account("u-dan", "dan", "user"),
      account("o-solo", "solo", "org"),
      account("o-team", "team", "org"),
      `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('o-solo', 'u-alice', 'owner', '${at}'), ('o-team', 'u-alice', 'owner', '${at}'), ('o-team', 'u-bob', 'owner', '${at}')`,
      `INSERT INTO passkeys (id, account_id, public_key, device_type, name, created_at) VALUES ('pk-alice', 'u-alice', 'AAAA', 'singleDevice', 'Laptop', '${at}')`,
      ...Object.entries(T).map(([who, t]) => token(`t-${who}`, who === "alicebot" ? "a-alicebot" : `u-${who}`, t)),
      session("u-sully", S.sully),
      // sully signed in on another browser 3 hours ago: too long ago for sensitive actions.
      session("u-sully", S.sullyOld, hoursAgo(3)),
      session("u-alice", S.alice),
      session("u-alice", S.aliceOther),
      session("u-bob", S.bob),
      session("u-carl", S.carl),
      session("u-erin", S.erin),
      session("u-dan", S.dan),
    ].join("; "),
  );
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

test("deleting your account: refused while you are an organization's only owner; then everything goes and your comments show as ghost", async () => {
  // ------------------------------------------------------------ alice's own repository, and her work in bob's
  await ok("POST", "/user/repos", { name: "notes" }, T.alice);
  await ok("PUT", "/repos/alice/notes/contents/README.md", { message: "init", content: b64("# notes\n") }, T.alice);
  await ok("POST", "/user/repos", { name: "app", visibility: "public" }, T.bob);
  await ok("PUT", "/repos/bob/app/contents/README.md", { message: "init", content: b64("# app\n") }, T.bob);
  const issue = await ok("POST", "/repos/bob/app/issues", { title: "Crash on start", body: "It crashes." }, T.alice);
  assert.equal(issue.user.login, "alice");
  await ok("POST", `/repos/bob/app/issues/${issue.number}/comments`, { body: "Here is the stack trace." }, T.alice);
  await ok("POST", `/repos/bob/app/issues/${issue.number}/comments`, { body: "Thanks, looking." }, T.bob);
  await ok("GET", "/user", undefined, T.alicebot);
  assert.equal((await api("GET", "/user", undefined, { cookie: S.aliceOther })).status, 200);

  // ------------------------------------------------------------ refused while she is the only owner of solo (team has bob too)
  const settings = await page(S.alice, "/settings/account");
  assert.equal(settings.status, 200);
  assert.match(settings.text, /Delete your account/);
  assert.match(settings.text, /You are the only owner of the organization solo/);
  assert.doesNotMatch(settings.text, /\bteam\b/);
  let r = await submit(S.alice, "/settings/account", "/settings/account/delete", { confirm: "alice" });
  assert.equal(r.status, 303);
  assert.equal(r.location, "/settings/account");
  assert.match(r.flash, /You are the only owner of the organization solo: make someone else an owner of it, or delete it, first/);
  await ok("GET", "/user", undefined, T.alice);

  // She deletes solo; a wrong confirmation still deletes nothing.
  await status(202, "DELETE", "/orgs/solo", undefined, T.alice);
  r = await submit(S.alice, "/settings/account", "/settings/account/delete", { confirm: "alicе" });
  assert.match(r.flash, /type your username, alice, to confirm/);
  await ok("GET", "/repos/alice/notes", undefined, T.alice);

  // ------------------------------------------------------------ deleted
  r = await submit(S.alice, "/settings/account", "/settings/account/delete", { confirm: "alice" });
  assert.equal(r.status, 303);
  assert.equal(r.location, "/login");
  assert.match(r.flash, /Your account alice was deleted/);

  // Tokens (hers and her agent's) and every browser session are dead.
  await status(401, "GET", "/user", undefined, T.alice);
  await status(401, "GET", "/user", undefined, T.alicebot);
  await status(401, "GET", "/user", undefined, { cookie: S.aliceOther });
  await status(401, "GET", "/user", undefined, { cookie: S.alice });
  // Her repository is gone, for everyone and by every name.
  await status(404, "GET", "/repos/alice/notes", undefined, T.sully);
  await status(404, "GET", "/repos/deleted-u-alice/notes", undefined, T.sully);
  assert.equal((await fetch(`${base}/alice/notes.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${T.sully}` } })).status, 404);
  // Her profile and memberships are gone.
  await status(404, "GET", "/users/alice", undefined, T.bob);
  assert.equal((await page(S.bob, "/alice")).status, 404);
  assert.deepEqual((await ok("GET", "/orgs/team/members", undefined, T.bob)).map((m) => m.login), ["bob"]);

  // What she wrote in bob's repository stays, as ghost's; bob's own comment is untouched.
  const ghosted = await until("alice's issue attributed to ghost", async () => {
    const i = await ok("GET", `/repos/bob/app/issues/${issue.number}`, undefined, T.bob);
    return i.user.login === "ghost" ? i : null;
  });
  assert.equal(ghosted.title, "Crash on start");
  const comments = await ok("GET", `/repos/bob/app/issues/${issue.number}/comments`, undefined, T.bob);
  assert.deepEqual(comments.map((c) => [c.user.login, c.body]), [["ghost", "Here is the stack trace."], ["bob", "Thanks, looking."]]);
  const ghostPage = await page(S.bob, "/ghost");
  assert.equal(ghostPage.status, 200);
  assert.match(ghostPage.text, /placeholder for people who deleted their accounts/);

  // Her username waits 90 days before anyone can take it.
  const taken = await status(422, "POST", "/user/orgs", { login: "alice" }, T.bob);
  assert.match(taken.message, /belonged to an account that was deleted recently; it can be used again from \d{4}-\d{2}-\d{2}/);
  r = await submit(S.bob, "/settings", "/settings/profile", { login: "Alice", name: "Bob" });
  assert.match(r.flash, /belonged to an account that was deleted recently/);
  assert.equal((await ok("GET", "/user", undefined, T.bob)).login, "bob");

  // Audited, with what went.
  const row = (await auditRows()).find((t) => / account\.delete /.test(t) && / alice /.test(t));
  assert.ok(row, "account.delete is in the audit log");
  assert.match(row, /"via":"settings","repositories":1,"packages":0,"agents":\["alice-bot"\]/);
});

test("a site administrator deletes someone's account, signed in recently; their own is refused while they are the only one", async () => {
  // Not for other people.
  assert.equal((await page(S.bob, "/settings/admin/users/u-carl/delete")).status, 403);
  const confirm = await page(S.sully, "/settings/admin/users/u-carl/delete");
  assert.equal(confirm.status, 200);
  assert.match(confirm.text, /Delete the account carl/);
  assert.match((await page(S.sully, "/settings/admin")).text, /href="\/settings\/admin\/users\/u-carl\/delete"/);

  // A sign-in from 3 hours ago must confirm it's them first; nothing is deleted.
  let r = await submit(S.sullyOld, "/settings/admin/users/u-carl/delete", "/settings/admin/users/u-carl/delete", { confirm: "carl" });
  assert.equal(r.status, 303);
  assert.match(r.location, /^\/login\?confirm=1&next=/);
  await ok("GET", "/user", undefined, T.carl);

  r = await submit(S.sully, "/settings/admin/users/u-carl/delete", "/settings/admin/users/u-carl/delete", { confirm: "carl" });
  assert.equal(r.status, 303);
  assert.equal(r.location, "/settings/admin");
  assert.match(r.flash, /Deleted the account carl/);
  await status(401, "GET", "/user", undefined, T.carl);
  await status(401, "GET", "/user", undefined, { cookie: S.carl });
  assert.doesNotMatch((await page(S.sully, "/settings/admin")).text, /carl@example\.com/);
  const row = (await auditRows()).find((t) => / account\.delete /.test(t) && / carl /.test(t));
  assert.ok(row, "the admin deletion is audited");
  assert.match(row, /sully/);
  assert.match(row, /"via":"admin"/);

  // sully is the only site administrator: deleting that account is refused, and says why.
  const own = await page(S.sully, "/settings/admin/users/u-sully/delete");
  assert.match(own.text, /You are the only site administrator: make someone else a site administrator first/);
  r = await submit(S.sully, "/settings/account", "/settings/account/delete", { confirm: "sully" });
  assert.match(r.flash, /only site administrator/);
  await ok("GET", "/user", undefined, T.sully);
});

test("exporting your account: a tar archive with a clonable Git bundle and the issues you wrote, for you only", async () => {
  await ok("POST", "/user/repos", { name: "diary" }, T.erin);
  await ok("PUT", "/repos/erin/diary/contents/README.md", { message: "first entry", content: b64("# Dear diary\n") }, T.erin);
  const mine = await ok("POST", "/repos/erin/diary/issues", { title: "Export me", body: "An issue in my own repository." }, T.erin);
  const theirs = await ok("POST", "/repos/bob/app/issues", { title: "Erin was here", body: "An issue in someone else's repository." }, T.erin);

  const settings = await page(S.erin, "/settings/account");
  assert.match(settings.text, /Export your data/);
  let r = await submit(S.erin, "/settings/account", "/settings/account/export", {});
  assert.equal(r.status, 303);
  assert.match(r.flash, /We're preparing your export|Your export is ready/);

  const href = await until("the export", async () => {
    const p = (await page(S.erin, "/settings/account")).text;
    assert.doesNotMatch(p, /data-export="failed"/, "the export failed");
    return /href="(\/settings\/account\/exports\/[^"]+\/download)"/.exec(p)?.[1] ?? null;
  });
  // Nobody else can download it.
  assert.equal((await page(S.bob, href)).status, 404);
  // Not with a token, even erin's own: the archive is the whole account.
  const viaToken = await fetch(`${base}${href}`, { headers: { authorization: `Bearer ${T.erin}` } });
  assert.equal(viaToken.status, 403);
  await viaToken.arrayBuffer();
  const res = await fetch(`${base}${href}`, { headers: { cookie: `__Host-dfy_session=${S.erin}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/x-tar");
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="diffinery-export-erin-\d{4}-\d{2}-\d{2}\.tar"/);
  const archive = Buffer.from(await res.arrayBuffer());
  const file = join(work, "export.tar");
  writeFileSync(file, archive);
  // A real tar archive.
  const listed = execFileSync("tar", ["-tf", file], { encoding: "utf8" }).trim().split("\n");
  const top = "diffinery-export-erin";
  for (const p of ["manifest.json", "account.json", "repositories/diary.json", "repositories/diary.bundle", "issues/erin/diary.json", "issues/bob/app.json"]) assert.ok(listed.includes(`${top}/${p}`), `${p} in ${listed.join(", ")}`);
  const files = untar(archive);
  const manifest = JSON.parse(files.get(`${top}/manifest.json`));
  assert.equal(manifest.format, 1);
  assert.equal(manifest.account, "erin");
  const acct = JSON.parse(files.get(`${top}/account.json`));
  assert.equal(acct.login, "erin");
  assert.equal(acct.email, "erin@example.com");
  assert.deepEqual(acct.tokens.map((t) => t.name), ["e2e"]);
  assert.doesNotMatch(files.get(`${top}/account.json`).toString(), new RegExp(T.erin));
  const meta = JSON.parse(files.get(`${top}/repositories/diary.json`));
  assert.equal(meta.bundle, "diary.bundle");
  assert.equal(meta.clone_url, `${base}/erin/diary.git`);
  // The bundle clones.
  writeFileSync(join(work, "diary.bundle"), files.get(`${top}/repositories/diary.bundle`));
  execFileSync("git", ["bundle", "verify", join(work, "diary.bundle")], { stdio: "pipe" });
  execFileSync("git", ["clone", "-q", join(work, "diary.bundle"), join(work, "diary")], { stdio: "pipe" });
  assert.equal(readFileSync(join(work, "diary", "README.md"), "utf8"), "# Dear diary\n");
  // The issues erin opened, in her repository and in bob's.
  const own = JSON.parse(files.get(`${top}/issues/erin/diary.json`));
  assert.deepEqual(own.issues.map((i) => [i.number, i.title]), [[mine.number, "Export me"]]);
  const elsewhere = JSON.parse(files.get(`${top}/issues/bob/app.json`));
  assert.deepEqual(elsewhere.issues.map((i) => [i.number, i.title]), [[theirs.number, "Erin was here"]]);
  assert.ok(manifest.files.some((f) => f.path === "repositories/diary.bundle" && f.size === files.get(`${top}/repositories/diary.bundle`).length));

  // Asking again replaces it; the request and the download are audited.
  const rows = await auditRows();
  assert.ok(rows.some((t) => / account\.export /.test(t) && / erin /.test(t)));
  assert.ok(rows.some((t) => / account\.export_download /.test(t) && / erin /.test(t)));
});

test("site administration: granting and revoking needs a recent sign-in, is audited, and never removes the last site administrator", async () => {
  const user = async (t) => (await ok("GET", "/user", undefined, t)).site_admin;
  // sully is the only site administrator: removing that is refused.
  let r = await submit(S.sully, "/settings/admin", "/settings/admin/users/u-sully/site-admin", { grant: "0" });
  assert.equal(r.status, 303);
  assert.match(r.flash, /Diffinery needs at least one site administrator: make someone else a site administrator first/);
  assert.equal(await user(T.sully), true);

  // People who aren't site administrators can't grant it.
  r = await submit(S.dan, "/settings/account", "/settings/admin/users/u-dan/site-admin", { grant: "1" });
  assert.notEqual(r.status, 303);
  assert.equal(await user(T.dan), false);

  // A sign-in from 3 hours ago must confirm it's them first.
  r = await submit(S.sullyOld, "/settings/admin", "/settings/admin/users/u-dan/site-admin", { grant: "1" });
  assert.match(r.location, /^\/login\?confirm=1&next=%2Fsettings%2Fadmin$/);
  assert.equal(await user(T.dan), false);

  // Granted from the users table.
  assert.match((await page(S.sully, "/settings/admin")).text, /action="\/settings\/admin\/users\/u-dan\/site-admin"/);
  r = await submit(S.sully, "/settings/admin", "/settings/admin/users/u-dan/site-admin", { grant: "1" });
  assert.equal(r.location, "/settings/admin");
  assert.match(r.flash, /dan is now a site administrator/);
  assert.equal(await user(T.dan), true);
  assert.equal((await page(S.dan, "/settings/admin")).status, 200);

  // dan removes sully; then dan is the last one and can't step down.
  r = await submit(S.dan, "/settings/admin", "/settings/admin/users/u-sully/site-admin", { grant: "0" });
  assert.match(r.flash, /sully is no longer a site administrator/);
  assert.equal(await user(T.sully), false);
  assert.equal((await page(S.sully, "/settings/admin")).status, 403);
  r = await submit(S.dan, "/settings/admin", "/settings/admin/users/u-dan/site-admin", { grant: "0" });
  assert.match(r.flash, /needs at least one site administrator/);
  assert.equal(await user(T.dan), true);

  // Both changes are in the audit log, with who did them.
  const html = (await page(S.dan, "/settings/audit")).text;
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  assert.ok(rows.some((t) => / sully /.test(t) && / site_admin\.grant /.test(t) && / dan /.test(t)), "the grant is audited");
  assert.ok(rows.some((t) => / dan /.test(t) && / site_admin\.revoke /.test(t) && / sully /.test(t)), "the revocation is audited");
});
