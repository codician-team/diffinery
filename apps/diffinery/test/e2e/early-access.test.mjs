// End-to-end early access (lib/early-access.ts, web/early-access.tsx) on a real `wrangler dev` Worker:
// the sign-in page and closed sign-up lead to /early-access; a request is confirmed with
// the link from its email (double opt-in); the form answers the same for known addresses and accounts;
// bots, bursts, oversized and hostile input get nowhere; only site administrators see requests, on the
// web and through the API; inviting sends the instance invitation; declining, putting back, deleting and
// removing your own request work and are audited without the request's content.
//
// The Worker keeps env.dev's DEV_AUTH so it keeps whole copies of the emails it sends (for reading the
// links). Visitors who aren't signed in are requests with another Host header: local development's fixed
// identity only applies to requests addressed to this machine.
//
//   pnpm --filter @diffinery/app exec node --test test/e2e/early-access.test.mjs
import "./fresh-connections.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "diffinery-early-access-e2e-"));
const running = [];

const hash = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fetch-like request over node:http, which (unlike fetch) sends the Host header it is given: the
 * Worker sees a visitor's requests addressed to VISITOR. Redirects are never followed.
 */
function send(url, { method = "GET", headers = {}, body } = {}) {
  const data = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : body.toString());
  return new Promise((res, rej) => {
    const r = httpRequest(url, { method, headers: { ...headers, ...(data ? { "content-length": String(data.length) } : {}) } }, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const h = resp.headers;
        res({
          status: resp.statusCode,
          headers: { get: (k) => (Array.isArray(h[k.toLowerCase()]) ? h[k.toLowerCase()].join(", ") : (h[k.toLowerCase()] ?? null)) },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    r.on("error", rej);
    if (data) r.write(data);
    r.end();
  });
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

const T = { root: `dfy_root_${randomBytes(12).toString("hex")}`, ann: `dfy_ann_${randomBytes(12).toString("hex")}` };
const S = { root: `root-session-${randomBytes(12).toString("hex")}`, ann: `ann-session-${randomBytes(12).toString("hex")}` };
/** The Host a visitor who isn't signed in uses (see the header comment). */
const VISITOR = "visitor.example";

let w;
async function worker() {
  if (w) return w;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const persist = join(work, "state");
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 30 * 86400_000).toISOString();
  const person = (id, login, email, admin) => `INSERT INTO accounts (id, login, kind, name, email, status, site_admin, created_at) VALUES ('${id}', '${login}', 'user', '${login}', '${email}', 'active', ${admin}, '${at}')`;
  const token = (id, account, t) => `INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('${id}', '${account}', 'e2e', '${hash(t)}', '${t.slice(0, 10)}', '["admin"]', '${later}', '${at}')`;
  const session = (account, cookie) => `INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(cookie)}', '${account}', 'passkey', '${at}', '${at}', '${later}')`;
  const seed = [person("u-root", "root", "root@example.com", 1), person("u-ann", "ann", "ann@example.com", 0), token("t-root", "u-root", T.root), token("t-ann", "u-ann", T.ann), session("u-root", S.root), session("u-ann", S.ann)];
  const wrangler = (...args) => execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });
  migratedState(APP, persist);
  wrangler("d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--command", seed.join("; "));
  const args = ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${base}`, "--show-interactive-dev-session=false"];
  const dev = spawn("pnpm", args, { cwd: APP, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  dev.stdout.on("data", (d) => (log += d));
  dev.stderr.on("data", (d) => (log += d));
  running.push(dev);
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    await sleep(500);
  }
  assert.ok((await fetch(`${base}/healthz`).catch(() => ({ ok: false }))).ok, `wrangler dev did not start\n${log.slice(-4000)}`);

  /** Headers for a visitor (no `who`), or a signed-in person's browser. */
  const headers = (who, extra = {}) => ({ ...(who ? { cookie: `__Host-dfy_session=${S[who]}` } : { host: VISITOR }), ...extra });
  const page = (path, who) => send(`${base}${path}`, { headers: headers(who) });
  const api = async (method, path, body, tok) => {
    const r = await send(`${base}/api/v3${path}`, { method, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : { host: VISITOR }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: r.status, json };
  };
  /** A form's CSRF pair and timing stamp, read from `path` the way a browser does. */
  const formOf = async (path, who) => {
    const res = await page(path, who);
    assert.equal(res.status, 200, `GET ${path} -> ${res.status}`);
    const html = await res.text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
    const pair = /dfy_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(csrf && pair, `no CSRF pair on ${path}`);
    return { csrf, pair, stamp: /name="stamp" value="([^"]*)"/.exec(html)?.[1] ?? "", html };
  };
  /** POST a form; `form` is from formOf. `ip` sets the address the Worker sees. */
  const post = async (action, form, fields, who, ip) => {
    const body = new URLSearchParams({ _csrf: form.csrf, ...(form.stamp ? { stamp: form.stamp } : {}), ...fields });
    const cookie = [who ? `__Host-dfy_session=${S[who]}` : "", `dfy_csrf=${form.pair}`].filter(Boolean).join("; ");
    const r = await send(`${base}${action}`, { method: "POST", body, headers: { ...headers(who), cookie, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...(ip ? { "cf-connecting-ip": ip } : {}) } });
    // Apostrophes come back as &#39;; nothing else is unescaped, so the escaping checks still hold.
    return { status: r.status, location: r.headers.get("location"), html: (await r.text()).replace(/&#39;/g, "'") };
  };
  /** Every email the Worker sent, newest first, with the whole message (DEV_AUTH keeps it). */
  const emails = async () => {
    const r = await api("GET", "/diffinery/emails?all=1&per_page=200", undefined, T.root);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  const email = async (what, pred) => {
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      const m = (await emails()).find(pred);
      if (m) return m;
      await sleep(500);
    }
    assert.fail(`timed out waiting for the email: ${what}\n${log.slice(-3000)}`);
  };
  const linkIn = (m, path) => {
    const text = m.dev_copy?.text ?? "";
    const found = new RegExp(`${base.replace(/[.]/g, "\\.")}${path}#([A-Za-z0-9_-]{20,100})`).exec(text);
    assert.ok(found, `no ${path} link in:\n${text}`);
    return found[1];
  };
  /** A form whose stamp is old enough to count as a person's (3 seconds). */
  const ready = async (path = "/early-access", who) => {
    const f = await formOf(path, who);
    await sleep(3200);
    return f;
  };
  w = { base, page, api, formOf, post, emails, email, linkIn, ready, log: () => log };
  return w;
}

/** A page with the address typed and the per-page nonce taken out, to compare two answers. */
const same = (html, address) => html.replace(address, "ADDRESS").replace(/nonce="[^"]*"/g, "");
const request = (email, over = {}) => ({ email, name: "", company: "", use_case: "", hosting: "", website: "", ...over });
const byEmail = async (api, address) => (await api("GET", `/diffinery/admin/early-access?q=${encodeURIComponent(address)}`, undefined, T.root)).json.find((r) => r.email === address);
let nextIp = 1;
/** A fresh address for the Worker to see each request from, so the daily limit per network doesn't mix tests. */
const ip = () => `198.51.100.${nextIp++}`;

test("early access: the sign-in page and closed sign-up lead to the form", async () => {
  const { page } = await worker();
  const home = await (await page("/")).text();
  // The home page is about running Diffinery yourself, not about asking for access to this instance.
  assert.doesNotMatch(home, /href="\/early-access"/);
  assert.match(await (await page("/login")).text(), /href="\/early-access">request early access</);
  const signup = await page("/signup");
  assert.equal(signup.status, 302);
  assert.equal(signup.headers.get("location"), "/early-access");
  const form = await page("/early-access");
  assert.equal(form.status, 200);
  const html = await form.text();
  assert.match(html, /Request early access to Diffinery/);
  for (const name of ["email", "name", "company", "use_case", "hosting", "website", "stamp"]) assert.match(html, new RegExp(`name="${name}"`), name);
  assert.doesNotMatch(html, /<select|type="checkbox"/, "Kumo controls only");
  assert.match(html, /href="\/early-access\/remove"/);
  // Signed in, the form isn't needed.
  const annForm = await page("/early-access", "ann");
  assert.equal(annForm.status, 302);
  assert.equal(annForm.headers.get("location"), "/");
  // Search engines are kept away from the confirmation pages, and the form isn't in the sitemap.
  const robots = await (await page("/robots.txt")).text();
  assert.match(robots, /Disallow: \/early-access\/confirm/);
  assert.match(robots, /Disallow: \/early-access\/remove/);
  assert.doesNotMatch(await (await page("/sitemap.xml")).text(), /:\d+\/early-access<\/loc>/);
});

test("early access: a request is confirmed with the link from its email, then waits for site administrators", async () => {
  const { page, api, post, email, linkIn, ready } = await worker();
  const f = await ready();
  const hostile = { name: `Ada <script>alert(1)</script>`, company: "Acme & Co", use_case: "Move 40 repos.\n<img src=x onerror=alert(1)>", hosting: "github" };
  const sent = await post("/early-access", f, request("Ada@Example.net", hostile), undefined, ip());
  assert.equal(sent.status, 200, sent.html.slice(0, 600));
  assert.match(sent.html, /Check your inbox/);
  assert.match(sent.html, /ada@example\.net/);
  const m = await email("the confirmation", (e) => e.kind === "early_access_confirm" && e.to_addr === "ada@example.net");
  assert.equal(m.subject, "[Diffinery] Confirm your early access request");
  assert.doesNotMatch(JSON.stringify(m.dev_copy), /Ada|Acme|onerror|Move 40/, "nothing typed in the form goes into the email");
  const token = linkIn(m, "/early-access/confirm");

  // Unconfirmed: not waiting yet.
  const before = await byEmail(api, "ada@example.net");
  assert.equal(before.state, "unconfirmed");
  assert.doesNotMatch(await (await page("/settings/admin/early-access", "root")).text(), /ada@example\.net/);

  const confirmPage = await page("/early-access/confirm");
  assert.equal(confirmPage.status, 200);
  const cf = { ...(await w.formOf("/early-access/confirm")), stamp: "" };
  const wrong = await post("/early-access/confirm", cf, { token: "x".repeat(40) });
  assert.equal(wrong.status, 410);
  assert.match(wrong.html, /This link doesn't work any more/);
  const ok = await post("/early-access/confirm", cf, { token });
  assert.equal(ok.status, 200, ok.html.slice(0, 600));
  assert.match(ok.html, /You're on the list/);
  assert.ok(ok.html.includes("Ada &lt;script&gt;alert(1)&lt;/script&gt;"), "the name is escaped");
  assert.equal((await post("/early-access/confirm", cf, { token })).status, 410, "a link works once");

  const after = await byEmail(api, "ada@example.net");
  assert.equal(after.state, "confirmed");
  assert.deepEqual({ name: after.name, company: after.company, use_case: after.use_case, hosting: after.hosting }, { name: hostile.name, company: hostile.company, use_case: hostile.use_case, hosting: "github" });
  assert.ok(!("confirm_hash" in after));
  const admin = await (await page("/settings/admin/early-access", "root")).text();
  assert.match(admin, /ada@example\.net/);
  assert.ok(!admin.includes("<script>alert(1)") && !admin.includes("<img src=x"), "everything is escaped");
  assert.match(admin, /Early access\s*<span class="badge blue"[^>]*>\s*1\s*</, "the sidebar counts what waits");
  const detail = await (await page(`/settings/admin/early-access/${after.id}`, "root")).text();
  assert.ok(detail.includes("Move 40 repos.\n&lt;img src=x onerror=alert(1)&gt;"), "the use is plain text");
  assert.match(await (await page("/notifications", "root")).text(), /New early access requests are waiting for you/);
  assert.match(await (await page("/settings/admin", "root")).text(), /1 confirmed early access request is waiting/);
});

test("early access: the same answer for an address that already asked or has an account; only its inbox learns which", async () => {
  const { api, post, email, emails, ready } = await worker();
  const f = await ready();
  const again = await post("/early-access", f, request("ada@example.net", { name: "Mallory" }), undefined, ip());
  assert.equal(again.status, 200);
  assert.match(again.html, /Check your inbox/);
  const known = await email("already asked", (e) => e.kind === "early_access_known" && e.to_addr === "ada@example.net");
  assert.equal(known.subject, "[Diffinery] We already have your early access request");
  assert.equal((await byEmail(api, "ada@example.net")).name, "Ada <script>alert(1)</script>", "a confirmed request isn't changed");
  const account = await post("/early-access", f, request("ANN@example.com"), undefined, ip());
  assert.equal(account.status, 200);
  assert.equal(same(account.html, /ann@example\.com/gi), same(again.html, /ada@example\.net/g), "the page is the same either way");
  const note = await email("already an account", (e) => e.kind === "early_access_known" && e.to_addr === "ann@example.com");
  assert.equal(note.subject, "[Diffinery] You already have a Diffinery account");
  assert.equal(await byEmail(api, "ann@example.com"), undefined);
  assert.ok((await emails()).every((e) => e.kind !== "early_access_confirm" || e.to_addr !== "ann@example.com"));
});

test("early access: bots, bad input and big bodies get nowhere", async () => {
  const { api, post, emails, formOf, ready } = await worker();
  const fresh = await formOf("/early-access");
  // Too fast after the page was shown, a filled honeypot, or a forged stamp: the usual page, nothing kept or sent.
  const fast = await post("/early-access", fresh, request("bot1@example.net"), undefined, ip());
  assert.equal(fast.status, 200);
  assert.match(fast.html, /Check your inbox/);
  const f = await ready();
  const honey = await post("/early-access", f, request("bot2@example.net", { website: "https://spam.example" }), undefined, ip());
  assert.match(honey.html, /Check your inbox/);
  const forged = await post("/early-access", { ...f, stamp: `${Date.now() - 10_000}.${"A".repeat(43)}` }, request("bot3@example.net"), undefined, ip());
  assert.match(forged.html, /Check your inbox/);
  const missing = await post("/early-access", { ...f, stamp: "" }, request("bot4@example.net"), undefined, ip());
  assert.match(missing.html, /Check your inbox/);
  for (const a of ["bot1@example.net", "bot2@example.net", "bot3@example.net", "bot4@example.net"]) assert.equal(await byEmail(api, a), undefined, a);

  // Bad input is refused with the reason, keeping what was typed.
  const long = await post("/early-access", f, request("long@example.net", { use_case: "x".repeat(1001), name: "Keep me" }), undefined, ip());
  assert.equal(long.status, 422);
  assert.match(long.html, /Keep what you'd use Diffinery for to 1,000 characters/);
  assert.match(long.html, /value="Keep me"/);
  const bad = await post("/early-access", f, request("not-an-address"), undefined, ip());
  assert.equal(bad.status, 422);
  assert.match(bad.html, /Enter a valid email address/);
  const hosting = await post("/early-access", f, request("h@example.net", { hosting: "<script>" }), undefined, ip());
  assert.equal(hosting.status, 422);
  assert.ok(!hosting.html.includes('value="<script>"'));
  const huge = await post("/early-access", f, request("huge@example.net", { use_case: "y".repeat(40_000) }), undefined, ip());
  assert.equal(huge.status, 413);
  await sleep(1500);
  const tried = new Set(["bot1", "bot2", "bot3", "bot4", "long", "h", "huge"].map((n) => `${n}@example.net`));
  assert.deepEqual((await emails()).filter((e) => tried.has(e.to_addr)), [], "nothing was emailed");
});

test("early access: only site administrators see requests (404 for anyone else)", async () => {
  const { page, api, post, formOf } = await worker();
  const ada = await byEmail(api, "ada@example.net");
  assert.ok(ada, "the request from the tests above");
  for (const path of ["/settings/admin/early-access", `/settings/admin/early-access/${ada.id}`]) {
    assert.equal((await page(path, "ann")).status, 404, `${path} for a person who isn't a site administrator`);
    const anon = await page(path);
    assert.equal(anon.status, 302, `${path} sends a visitor to sign in`);
    assert.match(anon.headers.get("location") ?? "", /^\/login\?next=/);
  }
  const annForm = await formOf("/settings", "ann");
  for (const action of ["invite", "decline", "delete"]) assert.equal((await post(`/settings/admin/early-access/${ada.id}/${action}`, annForm, {}, "ann")).status, 404, action);
  assert.equal((await api("GET", "/diffinery/admin/early-access", undefined, T.ann)).status, 404);
  assert.equal((await api("GET", `/diffinery/admin/early-access/${ada.id}`, undefined, T.ann)).status, 404);
  assert.equal((await api("POST", `/diffinery/admin/early-access/${ada.id}/invite`, undefined, T.ann)).status, 404);
  assert.equal((await api("PATCH", `/diffinery/admin/early-access/${ada.id}`, { state: "declined" }, T.ann)).status, 404);
  assert.equal((await api("DELETE", `/diffinery/admin/early-access/${ada.id}`, undefined, T.ann)).status, 404);
  assert.equal((await api("GET", "/diffinery/admin/early-access")).status, 401);
  assert.doesNotMatch(await (await page("/settings", "ann")).text(), /href="\/settings\/admin\/early-access"/);
  assert.equal((await byEmail(api, "ada@example.net")).state, "confirmed", "nothing changed");
});

test("early access: invite, decline, put back and delete, on the web and through the API, audited", async () => {
  const { page, api, post, formOf, email, emails, linkIn, ready } = await worker();
  const ada = await byEmail(api, "ada@example.net");
  // Invite from the web: the instance invitation goes to the address.
  const adminForm = await formOf("/settings/admin/early-access", "root");
  const invited = await post(`/settings/admin/early-access/${ada.id}/invite`, adminForm, { back: "/settings/admin/early-access" }, "root");
  assert.equal(invited.status, 303);
  assert.equal(invited.location, "/settings/admin/early-access");
  const now = await byEmail(api, "ada@example.net");
  assert.equal(now.state, "invited");
  assert.equal(now.decided_by, "root");
  assert.ok(now.invite_id);
  const inv = await email("the invitation", (e) => e.kind === "invite" && e.to_addr === "ada@example.net");
  assert.match(inv.subject, /invited you to Diffinery/);
  assert.equal((await api("POST", `/diffinery/admin/early-access/${ada.id}/invite`, undefined, T.root)).status, 422, "not twice");
  assert.match(await (await page("/settings/admin/early-access?state=invited", "root")).text(), /invited by root/);
  // Asking again now says so.
  const f = await ready();
  await post("/early-access", f, request("ada@example.net"), undefined, ip());
  const already = await email("already invited", (e) => e.kind === "early_access_known" && e.to_addr === "ada@example.net" && /already invited/.test(e.subject));
  assert.equal(already.subject, "[Diffinery] You're already invited");

  // A second request: decline and put back through the API (no email), then delete on the web.
  await post("/early-access", f, request("bob@example.net", { use_case: "secret plans" }), undefined, ip());
  const token = linkIn(await email("bob's confirmation", (e) => e.kind === "early_access_confirm" && e.to_addr === "bob@example.net"), "/early-access/confirm");
  await post("/early-access/confirm", { ...(await formOf("/early-access/confirm")), stamp: "" }, { token });
  const bob = await byEmail(api, "bob@example.net");
  assert.equal(bob.state, "confirmed");
  const sent = (await emails()).length;
  const declined = await api("PATCH", `/diffinery/admin/early-access/${bob.id}`, { state: "declined" }, T.root);
  assert.equal(declined.status, 200, JSON.stringify(declined.json));
  assert.equal(declined.json.state, "declined");
  assert.equal((await api("PATCH", `/diffinery/admin/early-access/${bob.id}`, { state: "invited" }, T.root)).status, 422);
  assert.equal((await api("PATCH", `/diffinery/admin/early-access/${bob.id}`, { state: "confirmed" }, T.root)).json.state, "confirmed");
  await sleep(1500);
  assert.equal((await emails()).length, sent, "declining emails nobody");
  const del = await post(`/settings/admin/early-access/${bob.id}/delete`, await formOf(`/settings/admin/early-access/${bob.id}`, "root"), {}, "root");
  assert.equal(del.status, 303);
  assert.equal(del.location, "/settings/admin/early-access");
  assert.equal((await api("GET", `/diffinery/admin/early-access/${bob.id}`, undefined, T.root)).status, 404);

  const audit = await (await page("/settings/audit", "root")).text();
  for (const action of ["early_access.confirm", "early_access.invite", "early_access.decline", "early_access.restore", "early_access.delete", "invite.create"]) assert.ok(audit.includes(action), `${action} is audited`);
  assert.ok(!audit.includes("secret plans") && !audit.includes("onerror"), "the audit log holds no request content");
});

test("early access: people remove their own request with an emailed link", async () => {
  const { api, post, formOf, email, emails, linkIn, ready } = await worker();
  const f = await ready();
  await post("/early-access", f, request("carol@example.net"), undefined, ip());
  await email("carol's confirmation", (e) => e.kind === "early_access_confirm" && e.to_addr === "carol@example.net");
  assert.ok(await byEmail(api, "carol@example.net"));
  const rf = await ready("/early-access/remove");
  const none = await post("/early-access/remove", rf, { email: "nobody@example.net", website: "" }, undefined, ip());
  assert.equal(none.status, 200);
  assert.match(none.html, /If there's an early access request for <b>nobody@example\.net<\/b>/);
  const asked = await post("/early-access/remove", rf, { email: "Carol@Example.net", website: "" }, undefined, ip());
  assert.equal(same(asked.html, /carol@example\.net/gi), same(none.html, /nobody@example\.net/g), "the same page either way");
  const m = await email("the removal link", (e) => e.kind === "early_access_remove" && e.to_addr === "carol@example.net");
  assert.equal(m.subject, "[Diffinery] Remove your early access request");
  assert.ok((await emails()).every((e) => e.to_addr !== "nobody@example.net"), "no request, no email");
  const token = linkIn(m, "/early-access/remove/confirm");
  const cf = { ...(await formOf("/early-access/remove/confirm")), stamp: "" };
  const gone = await post("/early-access/remove/confirm", cf, { token });
  assert.equal(gone.status, 200);
  assert.match(gone.html, /Your request is removed/);
  assert.equal(await byEmail(api, "carol@example.net"), undefined);
  assert.equal((await post("/early-access/remove/confirm", cf, { token })).status, 410);
});

test("early access: daily limits per network and per address", async () => {
  const { api, post, emails, ready } = await worker();
  const f = await ready();
  // One address: three emails a day, then the page stays the same and nothing more is sent.
  const flood = "flood@example.net";
  for (let i = 0; i < 4; i++) assert.equal((await post("/early-access", f, request(flood), undefined, ip())).status, 200);
  await sleep(1500);
  assert.equal((await emails()).filter((e) => e.to_addr === flood).length, 3);
  // One network: ten submissions a day, then a visible refusal.
  const net = "203.0.113.77";
  for (let i = 0; i < 10; i++) assert.equal((await post("/early-access", f, request(`n${i}@example.net`), undefined, net)).status, 200, `submission ${i + 1}`);
  const over = await post("/early-access", f, request("n10@example.net"), undefined, net);
  assert.equal(over.status, 429);
  assert.match(over.html, /Too many requests from your network today/);
  assert.equal(await byEmail(api, "n10@example.net"), undefined);
  // Another network still gets through.
  assert.equal((await post("/early-access", f, request("other@example.net"), undefined, ip())).status, 200);
});
