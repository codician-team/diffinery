// End-to-end checks of moderation (lib/moderation.ts) against a real `wrangler dev` Worker with
// seeded accounts, tokens and sessions:
//
//   flock /home/claude/e2e.lock timeout 1500 node --test --test-concurrency=1 --test-timeout=900000 test/e2e/moderation.test.mjs
//
// Covers: reports (REST and the web form) land in the site administrators' queue and are resolved;
// a blocked person can't open issues, comment, react or be added as a collaborator in the blocker's
// (or the blocking organization's) repositories but still can everywhere else; a suspended person's
// token and session stop at once, their repositories, profile and comments disappear for everyone
// but site administrators, and unsuspending restores it all; a minimized comment shows collapsed.
import "./fresh-connections.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "diffinery-moderation-"));
let base;
let dev;
let devLog = "";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const tok = (name) => `dfy_${name}_${randomBytes(12).toString("hex")}`;
const T = { olive: tok("olive"), sully: tok("sully"), rita: tok("rita"), mal: tok("mal"), sid: tok("sid"), sam: tok("sam") };
const S = { olive: `olive-${randomBytes(12).toString("hex")}`, sully: `sully-${randomBytes(12).toString("hex")}`, rita: `rita-${randomBytes(12).toString("hex")}`, sid: `sid-${randomBytes(12).toString("hex")}` };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Call the REST API as a token, a session cookie (`{ cookie }`) or anonymously (null). */
async function api(method, path, body, as = T.olive) {
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

/** A web page, signed in with `session` (or anonymously). */
async function page(path, session) {
  const r = await fetch(`${base}${path}`, { headers: session ? { cookie: `__Host-dfy_session=${session}` } : {}, redirect: "manual" });
  return { status: r.status, html: await r.text() };
}

/** A web form post signed in with `session`, with the CSRF pair taken from `from`. */
async function submit(session, from, action, fields) {
  const cookie = `__Host-dfy_session=${session}`;
  const res = await fetch(`${base}${from}`, { headers: { cookie } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await res.text())?.[1];
  const pair = /dfy_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(csrf && pair, `no CSRF pair on ${from} (${res.status})`);
  const r = await fetch(`${base}${action}`, { method: "POST", body: new URLSearchParams({ _csrf: csrf, ...fields }), redirect: "manual", headers: { cookie: `${cookie}; dfy_csrf=${pair}`, "sec-fetch-site": "same-origin" } });
  return { status: r.status, location: r.headers.get("location"), flash: decodeURIComponent(decodeURIComponent(r.headers.get("set-cookie") ?? "")) };
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const persist = join(work, "state");
  const wrangler = (...args) => execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });
  migratedState(APP, persist);
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 30 * 86400_000).toISOString();
  const account = (id, login, kind) => `INSERT INTO accounts (id, login, kind, name, status, created_at) VALUES ('${id}', '${login}', '${kind}', '${login}', 'active', '${at}')`;
  const token = (id, account, t) => `INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('${id}', '${account}', 'e2e', '${hash(t)}', '${t.slice(0, 10)}', '["admin"]', '${later}', '${at}')`;
  const session = (account, cookie) => `INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(cookie)}', '${account}', 'passkey', '${at}', '${at}', '${later}')`;
  wrangler(
    "d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--command",
    [
      ...["olive", "sully", "rita", "mal", "sid", "sam"].map((l) => account(`u-${l}`, l, "user")),
      "UPDATE accounts SET site_admin = 1 WHERE id = 'u-sully'",
      ...Object.entries(T).map(([l, t]) => token(`t-${l}`, `u-${l}`, t)),
      ...Object.entries(S).map(([l, s]) => session(`u-${l}`, s)),
      account("o-guild", "guild", "org"),
      `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('o-guild', 'u-olive', 'owner', '${at}')`,
    ].join("; "),
  );
  dev = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${base}`, "--var", "DEV_AUTH:", "--var", `MASTER_KEY:${randomBytes(32).toString("base64")}`, "--var", `OIDC_PRIVATE_KEY:${JSON.stringify(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }))}`, "--show-interactive-dev-session=false"],
    { cwd: APP, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  dev.stdout.on("data", (d) => (devLog += d));
  dev.stderr.on("data", (d) => (devLog += d));
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await sleep(300);
  }
  assert.fail(`wrangler dev didn't start\n${devLog.slice(-4000)}`);
});

after(() => {
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  }
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
});

/** A public repository with one commit, created by `as` (under `owner`, a person or an organization). */
async function publicRepo(owner, name, as) {
  await ok("POST", owner === "user" ? "/user/repos" : `/orgs/${owner}/repos`, { name, visibility: "public" }, as);
  const login = owner === "user" ? (await ok("GET", "/user", undefined, as)).login : owner;
  await ok("PUT", `/repos/${login}/${name}/contents/README.md`, { message: "init", content: b64(`# ${name}\n`) }, as);
  return `/repos/${login}/${name}`;
}

/** olive's public repository town with issue #1, guild's hall, sam's park and sid's pub, made once. */
let made;
const setup = () =>
  (made ??= (async () => {
    const town = await publicRepo("user", "town", T.olive);
    const hall = await publicRepo("guild", "hall", T.olive);
    const park = await publicRepo("user", "park", T.sam);
    const pub = await publicRepo("user", "pub", T.sid);
    const welcome = await ok("POST", `${town}/issues`, { title: "Welcome" });
    return { town, hall, park, pub, welcome };
  })());

test("moderation: reports land in the site administrators' queue", async () => {
  const { welcome } = await setup();
  const filed = await status(201, "POST", "/diffinery/reports", { kind: "issue", repository: "olive/town", number: welcome.number, reason: "spam", body: "looks like an ad" }, T.rita);
  assert.equal(filed.target, `olive/town#${welcome.number}`);
  assert.equal(filed.state, "open");
  assert.match(filed.html_url, /\/olive\/town\/issues\/1$/);
  // A reason from the list, a bounded note, one open report per thing.
  await status(422, "POST", "/diffinery/reports", { kind: "issue", repository: "olive/town", number: welcome.number, reason: "boring" }, T.rita);
  await status(422, "POST", "/diffinery/reports", { kind: "user", login: "mal", reason: "spam", body: "x".repeat(2001) }, T.rita);
  await status(422, "POST", "/diffinery/reports", { kind: "issue", repository: "olive/town", number: welcome.number, reason: "spam" }, T.rita);
  await status(401, "POST", "/diffinery/reports", { kind: "user", login: "mal", reason: "spam" }, null);
  // The web form files one too.
  const form = await submit(S.rita, "/-/report?kind=user&login=mal", "/-/report?kind=user&login=mal", { reason: "harassment", body: "keeps pinging me" });
  assert.ok([302, 303].includes(form.status), String(form.status));
  assert.match(form.flash, /Thanks for reporting it/);

  await status(403, "GET", "/admin/reports", undefined, T.rita);
  const queue = await ok("GET", "/admin/reports", undefined, T.sully);
  assert.deepEqual(queue.map((r) => [r.kind, r.target, r.reason, r.reporter]).sort(), [
    ["issue", "olive/town#1", "spam", "rita"],
    ["user", "mal", "harassment", "rita"],
  ]);
  const adminPage = await page("/settings/admin/reports", S.sully);
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.html, /olive\/town#1/);
  assert.match(adminPage.html, /keeps pinging me|harassment|Harassment/);
  assert.notEqual((await page("/settings/admin/reports", S.rita)).status, 200);
  const done = await ok("PATCH", `/admin/reports/${filed.id}`, { state: "resolved", resolution: "spoke to olive" }, T.sully);
  assert.equal(done.state, "resolved");
  assert.equal(done.resolution, "spoke to olive");
  assert.deepEqual((await ok("GET", "/admin/reports", undefined, T.sully)).map((r) => r.target), ["mal"]);

});

test("moderation: a blocked person can't take part in the blocker's repositories, and can elsewhere", async () => {
  const { town, hall, park, welcome } = await setup();
  await collaborator(town, "mal", T.mal);
  const before = await ok("POST", `${town}/issues/${welcome.number}/comments`, { body: "hi from mal" }, T.mal);
  await status(204, "PUT", "/user/blocks/mal");
  await status(204, "GET", "/user/blocks/mal");
  assert.deepEqual((await ok("GET", "/user/blocks")).map((u) => u.login), ["mal"]);
  await status(404, "GET", "/user/blocks/rita");
  await status(422, "PUT", "/user/blocks/olive");
  // Blocking removed mal as a collaborator, and they can't be added back.
  assert.ok(!(await ok("GET", `${town}/collaborators`)).some((u) => u.login === "mal"));
  await status(422, "PUT", `${town}/collaborators/mal`, { permission: "write" });

  const refused = await status(403, "POST", `${town}/issues`, { title: "let me in" }, T.mal);
  assert.match(refused.message, /olive blocked you/);
  await status(403, "POST", `${town}/issues/${welcome.number}/comments`, { body: "again" }, T.mal);
  await status(403, "POST", `${town}/issues/${welcome.number}/reactions`, { content: "+1" }, T.mal);
  await status(403, "POST", `${town}/pulls`, { title: "x", head: "main", base: "main" }, T.mal);
  // Reading stays public, and what they wrote before stays.
  await ok("GET", `${town}/issues/${welcome.number}`, undefined, T.mal);
  assert.ok((await ok("GET", `${town}/issues/${welcome.number}/comments`)).some((c) => c.id === before.id));
  // Everywhere else mal takes part as before: sam's repository, and a pull request where mal can write.
  const elsewhere = await status(201, "POST", `${park}/issues`, { title: "mal's issue" }, T.mal);
  await status(201, "POST", `${park}/issues/${elsewhere.number}/comments`, { body: "and a comment" }, T.mal);
  await collaborator(park, "mal", T.mal, T.sam);
  await ok("POST", `${park}/git/refs`, { ref: "refs/heads/mal-change", sha: (await ok("GET", `${park}/git/ref/heads/main`, undefined, T.sam)).object.sha }, T.mal);
  await ok("PUT", `${park}/contents/NOTES.md`, { message: "notes", content: b64("notes\n"), branch: "mal-change" }, T.mal);
  await status(201, "POST", `${park}/pulls`, { title: "mal's change", head: "mal-change", base: "main" }, T.mal);

  // An organization blocks through its owners, with the same effect in its repositories.
  await status(201, "POST", `${hall}/issues`, { title: "before the block" }, T.mal);
  await status(404, "PUT", "/orgs/guild/blocks/mal", undefined, T.rita);
  await status(204, "PUT", "/orgs/guild/blocks/mal");
  await status(204, "GET", "/orgs/guild/blocks/mal");
  assert.match((await status(403, "POST", `${hall}/issues`, { title: "after the block" }, T.mal)).message, /guild blocked you/);
  // Unblocking lets them back in.
  await status(204, "DELETE", "/user/blocks/mal");
  await status(204, "DELETE", "/orgs/guild/blocks/mal");
  await status(201, "POST", `${town}/issues`, { title: "thanks" }, T.mal);
  await status(201, "POST", `${hall}/issues`, { title: "thanks" }, T.mal);

});

test("moderation: a suspended person is stopped and hidden at once, and unsuspending restores them", async () => {
  const { town, park, pub, welcome } = await setup();
  const sidIssue = await status(201, "POST", `${town}/issues`, { title: "sid was here" }, T.sid);
  const sidComment = await status(201, "POST", `${town}/issues/${welcome.number}/comments`, { body: "sid's comment" }, T.sid);
  await ok("PATCH", `${town}/issues/${sidIssue.number}`, { state: "closed" });
  const closedSid = (await ok("GET", `${town}/issues/events`)).find((e) => e.issue?.number === sidIssue.number);
  assert.ok(closedSid, "closing sid's issue is an event");
  await ok("GET", "/user", undefined, T.sid);
  await ok("GET", pub, undefined, T.olive);
  assert.equal((await page("/sid", S.olive)).status, 200);

  await status(403, "PUT", "/users/sid/suspended", { reason: "spam" }, T.olive);
  await status(422, "PUT", "/users/sid/suspended", {}, T.sully);
  await status(204, "PUT", "/users/sid/suspended", { reason: "spam campaign" }, T.sully);
  await status(401, "GET", "/user", undefined, T.sid);
  await status(401, "GET", "/user", undefined, { cookie: S.sid });
  await status(401, "POST", `${park}/issues`, { title: "still here?" }, T.sid);
  // Their repository, profile, issues and comments are gone for everyone else...
  await status(404, "GET", pub, undefined, T.olive);
  await status(404, "GET", pub, undefined, null);
  assert.equal((await page("/sid/pub", S.olive)).status, 404);
  assert.equal((await page("/sid", S.olive)).status, 404);
  await status(404, "GET", "/users/sid", undefined, T.olive);
  await status(404, "GET", `${town}/issues/${sidIssue.number}`, undefined, T.olive);
  assert.ok(!(await ok("GET", `${town}/issues?state=all`)).some((i) => i.number === sidIssue.number));
  // The events endpoints embed the issue, so its events are hidden too.
  assert.ok(!(await ok("GET", `${town}/issues/events`)).some((e) => e.issue?.number === sidIssue.number));
  await status(404, "GET", `${town}/issues/events/${closedSid.id}`);
  await status(404, "GET", `${town}/issues/${sidIssue.number}/events`);
  assert.ok(!(await ok("GET", `${town}/issues/${welcome.number}/comments`)).some((c) => c.id === sidComment.id));
  assert.doesNotMatch((await page(`/olive/town/issues/${welcome.number}`, S.olive)).html, /sid&#39;s comment|sid's comment/);
  // ...but not for site administrators, who see why.
  await ok("GET", pub, undefined, T.sully);
  const shown = await ok("GET", "/users/sid", undefined, T.sully);
  assert.equal(shown.suspension_reason, "spam campaign");
  assert.ok(shown.suspended_at);
  assert.ok((await ok("GET", `${town}/issues/${welcome.number}/comments`, undefined, T.sully)).some((c) => c.id === sidComment.id));

  // Unsuspending restores everything, tokens included.
  await status(204, "DELETE", "/users/sid/suspended", undefined, T.sully);
  assert.equal((await ok("GET", "/user", undefined, T.sid)).login, "sid");
  await ok("GET", pub, undefined, null);
  assert.equal((await page("/sid", S.olive)).status, 200);
  await ok("GET", `${town}/issues/${sidIssue.number}`);
  assert.ok((await ok("GET", `${town}/issues/${welcome.number}/comments`)).some((c) => c.id === sidComment.id));
  assert.equal((await ok("GET", "/users/sid", undefined, T.sully)).suspended_at, null);

});

test("moderation: a minimized comment shows collapsed", async () => {
  const { town, welcome } = await setup();
  const spam = await status(201, "POST", `${town}/issues/${welcome.number}/comments`, { body: "BUY CHEAP WATCHES" }, T.rita);
  // Only people who can write to the repository hide comments.
  await status(403, "PUT", `/repos/olive/town/diffinery/comments/${spam.id}/minimized`, { reason: "spam" }, T.rita);
  await status(422, "PUT", `/repos/olive/town/diffinery/comments/${spam.id}/minimized`, { reason: "rude" });
  assert.deepEqual(await ok("PUT", `/repos/olive/town/diffinery/comments/${spam.id}/minimized`, { classifier: "SPAM" }), { is_minimized: true, minimized_reason: "spam" });
  const issuePage = await page(`/olive/town/issues/${welcome.number}`, S.rita);
  assert.match(issuePage.html, /<details class="minimized" data-minimized="spam">/);
  assert.match(issuePage.html, /This comment was marked as spam\./);
  // Collapsed, not deleted: the body is still there behind "Show comment".
  assert.match(issuePage.html, /BUY CHEAP WATCHES/);
  // From the web too: unhide, then hide as off-topic.
  const issuePath = `/olive/town/issues/${welcome.number}`;
  assert.ok([302, 303].includes((await submit(S.olive, issuePath, `/olive/town/comments/${spam.id}/unminimize`, {})).status));
  assert.doesNotMatch((await page(issuePath, S.rita)).html, /data-minimized=/);
  assert.ok([302, 303].includes((await submit(S.olive, issuePath, `/olive/town/comments/${spam.id}/minimize`, { reason: "off_topic" })).status));
  assert.match((await page(issuePath, S.rita)).html, /This comment was marked as off-topic\./);
});

/** Make `login` a collaborator on `repo` with write access, accepting the invitation as them. */
async function collaborator(repo, login, invitee, as = T.olive) {
  const r = await api("PUT", `${repo}/collaborators/${login}`, { permission: "write" }, as);
  if (r.status === 204) return;
  assert.equal(r.status, 201, `PUT ${repo}/collaborators/${login} -> ${r.status} ${JSON.stringify(r.json)}`);
  await status(204, "PATCH", `/user/repository_invitations/${r.json.id}`, undefined, invitee);
}
