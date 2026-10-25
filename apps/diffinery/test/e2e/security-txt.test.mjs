// End-to-end security reporting: /.well-known/security.txt (RFC 9116) and the private report form it
// names first, /security/report, on real `wrangler dev` Workers. One has no SECURITY_CONTACT (the file
// still serves, with the report form as its only contact) and no fixed dev identity, so it also covers
// anonymous and signed-in reports, admin-only visibility, the email to site administrators and
// audited triage; the other has SECURITY_CONTACT set (every field, the form first).
//
//   pnpm --filter @diffinery/app exec node --test test/e2e/security-txt.test.mjs
import "./fresh-connections.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "diffinery-securitytxt-e2e-"));
const running = [];

/** Start a Worker with extra `--var`s and seed SQL; resolves to its base URL once /healthz answers. */
async function worker(name, vars, seed = []) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const persist = join(work, name);
  const wrangler = (...args) => execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });
  migratedState(APP, persist);
  if (seed.length) wrangler("d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--command", seed.join("; "));
  const args = ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${base}`, "--show-interactive-dev-session=false"];
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  const dev = spawn("pnpm", args, { cwd: APP, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  dev.stdout.on("data", (d) => (log += d));
  dev.stderr.on("data", (d) => (log += d));
  running.push(dev);
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { base, stop: () => stopWorker(dev), log: () => log };
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.fail(`wrangler dev did not start\n${log.slice(-4000)}`);
}

function stopWorker(dev) {
  try {
    process.kill(-dev.pid, "SIGTERM");
  } catch {}
}

after(() => {
  for (const dev of running) stopWorker(dev);
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
});

test("security.txt: every RFC 9116 field with SECURITY_CONTACT set", async () => {
  const w = await worker("set", { SECURITY_CONTACT: "security@diffinery.test, https://diffinery.test/report" });
  try {
    const r = await fetch(`${w.base}/.well-known/security.txt`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /^text\/plain; charset=utf-8/);
    const lines = (await r.text()).trim().split("\n");
    const fields = (k) => lines.filter((l) => l.startsWith(`${k}: `)).map((l) => l.slice(k.length + 2));
    // The instance's own report form first, then SECURITY_CONTACT.
    assert.deepEqual(fields("Contact"), [`${w.base}/security/report`, "mailto:security@diffinery.test", "https://diffinery.test/report"]);
    assert.deepEqual(fields("Policy"), [`${w.base}/docs/security/disclosure`]);
    assert.deepEqual(fields("Preferred-Languages"), ["en"]);
    assert.deepEqual(fields("Canonical"), [`${w.base}/.well-known/security.txt`]);
    // Expires: one RFC 3339 time, less than a year ahead and more than eleven months.
    const [expires] = fields("Expires");
    assert.match(expires, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const days = (Date.parse(expires) - Date.now()) / 86400_000;
    assert.ok(days > 330 && days <= 365, `Expires is ${days} days ahead`);
    // Every line is a known field.
    for (const l of lines) assert.match(l, /^(Contact|Expires|Policy|Preferred-Languages|Canonical): \S/);
    // The policy it points to is served.
    const policy = await fetch(fields("Policy")[0]);
    assert.equal(policy.status, 200);
    assert.match(await policy.text(), /Safe harbour/);
  } finally {
    w.stop();
  }
});

// ---------------------------------------------------------------- private security reports

const hash = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, w, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  assert.fail(`timed out waiting for ${what}\n--- wrangler log tail ---\n${w.log().slice(-4000)}`);
}

/** The Worker for the report tests, with a site administrator (root) and a person (ann); started once. */
let reportsWorker;
const T = { root: `dfy_root_${randomBytes(12).toString("hex")}`, ann: `dfy_ann_${randomBytes(12).toString("hex")}` };
const S = { root: `root-session-${randomBytes(12).toString("hex")}`, ann: `ann-session-${randomBytes(12).toString("hex")}` };
const ids = {};

async function reports() {
  if (reportsWorker) return reportsWorker;
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 30 * 86400_000).toISOString();
  const person = (id, login, email, admin) => `INSERT INTO accounts (id, login, kind, name, email, status, site_admin, created_at) VALUES ('${id}', '${login}', 'user', '${login}', '${email}', 'active', ${admin}, '${at}')`;
  const token = (id, account, t) => `INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('${id}', '${account}', 'e2e', '${hash(t)}', '${t.slice(0, 10)}', '["admin"]', '${later}', '${at}')`;
  const session = (account, cookie) => `INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(cookie)}', '${account}', 'passkey', '${at}', '${at}', '${later}')`;
  // No SECURITY_CONTACT, no fixed dev identity (so callers can be anonymous) and no Turnstile keys,
  // which a Worker on this machine skips like sign-up does.
  const w = await worker("reports", { DEV_AUTH: "" }, [
    person("u-root", "root", "root@example.com", 1),
    person("u-ann", "ann", "ann@example.com", 0),
    token("t-root", "u-root", T.root),
    token("t-ann", "u-ann", T.ann),
    session("u-root", S.root),
    session("u-ann", S.ann),
  ]);
  const cookieOf = (who) => (who ? `__Host-dfy_session=${S[who]}` : "");
  const api = async (method, path, body, tok) => {
    const r = await fetch(`${w.base}/api/v3${path}`, { method, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: r.status, json };
  };
  const page = (path, who) => fetch(`${w.base}${path}`, { headers: { cookie: cookieOf(who) }, redirect: "manual" });
  /** Submit a form on `pagePath` to `action` the way a browser does: the page's CSRF pair, same-origin. */
  const submit = async (pagePath, action, fields, who) => {
    const res = await page(pagePath, who);
    assert.equal(res.status, 200, `GET ${pagePath} -> ${res.status}`);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await res.text())?.[1];
    const pair = /dfy_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(csrf && pair, `no CSRF pair on ${pagePath}`);
    const r = await fetch(`${w.base}${action}`, { method: "POST", body: new URLSearchParams({ _csrf: csrf, ...fields }), redirect: "manual", headers: { cookie: [cookieOf(who), `dfy_csrf=${pair}`].filter(Boolean).join("; "), "sec-fetch-site": "same-origin" } });
    return { status: r.status, location: r.headers.get("location"), html: await r.text() };
  };
  reportsWorker = { ...w, api, page, submit };
  return reportsWorker;
}
const reference = (html) => /Your reference is <span class="mono">([0-9a-f]{32})</.exec(html)?.[1];
const anonSummary = `Stored XSS <script>alert(1)</script> ${randomBytes(4).toString("hex")}`;
const anonDetails = "Steps:\n1. Create a release\n2. <img src=x onerror=alert(1)>";

test("security reports: security.txt names the form, and an anonymous report needs a reply-to address", async () => {
  const { base, page, submit, api } = await reports();
  // security.txt is served without SECURITY_CONTACT, and its only contact is the report form.
  const txt = await fetch(`${base}/.well-known/security.txt`);
  assert.equal(txt.status, 200);
  const contacts = (await txt.text()).split("\n").filter((l) => l.startsWith("Contact: "));
  assert.deepEqual(contacts, [`Contact: ${base}/security/report`]);

  const form = await page("/security/report");
  assert.equal(form.status, 200);
  const formHtml = await form.text();
  assert.match(formHtml, /Report a security problem/);
  assert.match(formHtml, /name="reply_to"[^>]*required/);
  assert.doesNotMatch(formHtml, /cf-turnstile/, "no widget without Turnstile keys on this machine");
  const noReply = await submit("/security/report", "/security/report", { summary: "No address", details: "Details.", area: "", reply_to: "" });
  assert.equal(noReply.status, 422);
  assert.match(noReply.html, /Enter an email address we can reply to, or sign in/);
  const tooLong = await submit("/security/report", "/security/report", { summary: "Too long", details: "x".repeat(20_001), area: "", reply_to: "r@example.net" });
  assert.equal(tooLong.status, 422);
  assert.match(tooLong.html, /20,000 characters/);

  const anon = await submit("/security/report", "/security/report", { summary: anonSummary, details: anonDetails, area: "/acme/app/releases", reply_to: "Researcher@Example.net" });
  assert.equal(anon.status, 201, anon.html.slice(0, 500));
  assert.match(anon.html, /your report was sent/);
  assert.match(anon.html, /researcher@example\.net/);
  ids.anon = reference(anon.html);
  assert.ok(ids.anon, "the reference is shown");
  const stored = await api("GET", `/diffinery/admin/security-reports/${ids.anon}`, undefined, T.root);
  assert.deepEqual(
    { ...stored.json, created_at: undefined },
    { id: ids.anon, state: "new", summary: anonSummary, details: anonDetails, area: "/acme/app/releases", reply_to: "researcher@example.net", reporter: null, note: null, updated_by: null, updated_at: null, created_at: undefined, html_url: `${base}/settings/admin/security-reports/${ids.anon}` },
  );
});

test("security reports: a signed-in report replies to the account's address", async () => {
  const { page, submit, api } = await reports();
  const annForm = await (await page("/security/report", "ann")).text();
  assert.match(annForm, /Reply-to email \(optional\)/);
  assert.match(annForm, /ann@example\.com/);
  const signed = await submit("/security/report", "/security/report", { summary: "Token shows up in job logs", details: "A masked secret leaks when split across lines.", area: "", reply_to: "" }, "ann");
  assert.equal(signed.status, 201, signed.html.slice(0, 500));
  ids.ann = reference(signed.html);
  assert.ok(ids.ann);
  const r = await api("GET", `/diffinery/admin/security-reports/${ids.ann}`, undefined, T.root);
  assert.equal(r.json.reporter, "ann");
  assert.equal(r.json.reply_to, "ann@example.com");
});

test("security reports: only site administrators can see them (404 for anyone else)", async () => {
  const { page, api } = await reports();
  assert.ok(ids.anon && ids.ann, "the reports from the tests above");
  for (const path of ["/settings/admin/security-reports", `/settings/admin/security-reports/${ids.anon}`]) {
    assert.equal((await page(path, "ann")).status, 404, `${path} is 404 for a non-admin`);
    const anonPage = await page(path);
    assert.equal(anonPage.status, 302, `${path} sends a signed-out visitor to sign in`);
    assert.match(anonPage.headers.get("location") ?? "", /^\/login\?next=/);
  }
  assert.equal((await api("GET", "/diffinery/admin/security-reports", undefined, T.ann)).status, 404);
  assert.equal((await api("GET", `/diffinery/admin/security-reports/${ids.anon}`, undefined, T.ann)).status, 404);
  assert.equal((await api("PATCH", `/diffinery/admin/security-reports/${ids.anon}`, { state: "resolved" }, T.ann)).status, 404);
  assert.equal((await api("GET", "/diffinery/admin/security-reports")).status, 401);
  assert.doesNotMatch(await (await page("/settings", "ann")).text(), /Security reports/);

  const list = await api("GET", "/diffinery/admin/security-reports", undefined, T.root);
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.deepEqual(new Set(list.json.map((r) => r.id)), new Set([ids.anon, ids.ann]));
  const adminList = await page("/settings/admin/security-reports", "root");
  assert.equal(adminList.status, 200);
  const adminListHtml = await adminList.text();
  assert.match(adminListHtml, /Token shows up in job logs/);
  assert.ok(!adminListHtml.includes("<script>alert(1)</script>"), "the summary is escaped");
  const detail = await (await page(`/settings/admin/security-reports/${ids.anon}`, "root")).text();
  assert.match(detail, /Steps:\n1\. Create a release/);
  assert.ok(detail.includes("&lt;img src=x onerror=alert(1)&gt;"), "the details are plain text");
  assert.match(detail, /mailto:researcher@example\.net/);
});

test("security reports: each new report emails the site administrators, and only them", async () => {
  const w = await reports();
  assert.ok(ids.anon && ids.ann, "the reports from the tests above");
  const mails = await until(
    "the security report emails",
    async () => {
      const r = await w.api("GET", "/diffinery/emails?all=1&kind=security_report&per_page=50", undefined, T.root);
      return r.status === 200 && r.json.length >= 2 ? r.json : null;
    },
    w,
  );
  assert.equal(mails.length, 2, JSON.stringify(mails));
  for (const m of mails) {
    assert.equal(m.to_addr, "root@example.com", "only the site administrator is emailed");
    assert.equal(m.subject, "[Diffinery] New security report");
  }
});

test("security reports: triage and resolve, on the web and through the API, audited", async () => {
  const { submit, api, page } = await reports();
  assert.ok(ids.anon, "the report from the tests above");
  const path = `/settings/admin/security-reports/${ids.anon}`;
  const triaged = await submit(path, path, { state: "triaged", note: "Reproduced; fixing." }, "root");
  assert.equal(triaged.status, 303);
  assert.equal(triaged.location, path);
  const after1 = await api("GET", `/diffinery/admin/security-reports/${ids.anon}`, undefined, T.root);
  assert.equal(after1.json.state, "triaged");
  assert.equal(after1.json.note, "Reproduced; fixing.");
  assert.equal(after1.json.updated_by, "root");
  const resolved = await api("PATCH", `/diffinery/admin/security-reports/${ids.anon}`, { state: "resolved", note: "Fixed in 2026.10.15." }, T.root);
  assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
  assert.equal(resolved.json.state, "resolved");
  assert.equal((await api("PATCH", `/diffinery/admin/security-reports/${ids.anon}`, { state: "closed" }, T.root)).status, 422);
  assert.equal((await api("GET", "/diffinery/admin/security-reports?state=resolved", undefined, T.root)).json.length, 1);

  const audit = await (await page("/settings/audit", "root")).text();
  for (const action of ["security_report.create", "security_report.triage", "security_report.resolve"]) assert.ok(audit.includes(action), `${action} is audited`);
  assert.ok(audit.includes(ids.anon), "the audit log names the report");
  assert.ok(!audit.includes("onerror"), "the audit log holds no report content");
});
