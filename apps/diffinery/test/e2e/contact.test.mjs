// End-to-end contact form (lib/contact.ts, web/contact.tsx) on a real `wrangler dev` Worker: the
// footer, sitemap, robots.txt and llms.txt lead to /contact; a visitor's message is confirmed with the
// link from its email and only then reaches the site administrators, by email (Reply-To the sender) and
// in Diffinery; a signed-in person's message arrives at once with a copy for them; bots, bursts,
// oversized and hostile input get nowhere; only site administrators see messages, on the web and
// through the API; marking handled, spam, reopening, noting and deleting work and are audited without
// the message's content, and an address with a message marked spam gets nothing more through.
//
// The Worker keeps env.dev's DEV_AUTH so it keeps whole copies of the emails it sends (for reading the
// links). Visitors who aren't signed in are requests with another Host header: local development's fixed
// identity only applies to requests addressed to this machine.
//
//   pnpm --filter @diffinery/app exec node --test test/e2e/contact.test.mjs
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
const work = mkdtempSync(join(tmpdir(), "diffinery-contact-e2e-"));
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
  const ready = async (path = "/contact", who) => {
    const f = await formOf(path, who);
    await sleep(3200);
    return f;
  };
  w = { base, page, api, formOf, post, emails, email, linkIn, ready, log: () => log };
  return w;
}

const message = (email, over = {}) => ({ email, name: "Ada", topic: "question", message: "Does Diffinery run my workflows as they are?", website: "", ...over });
const byEmail = async (api, address) => (await api("GET", `/diffinery/admin/contact?q=${encodeURIComponent(address)}`, undefined, T.root)).json;
let nextIp = 1;
/** A fresh address for the Worker to see each request from, so the daily limit per network doesn't mix tests. */
const ip = () => `198.51.100.${nextIp++}`;

test("contact: the footer, sitemap, robots.txt and llms.txt lead to the form", async () => {
  const { page } = await worker();
  assert.match(await (await page("/")).text(), /href="\/contact">Contact</, "the footer links it");
  assert.match(await (await page("/about")).text(), /href="https:\/\/diffinery\.com\/contact"/, "the About page links it");
  const form = await page("/contact");
  assert.equal(form.status, 200);
  const html = await form.text();
  assert.match(html, /<h1>Contact us<\/h1>/);
  for (const name of ["name", "email", "message", "website", "stamp"]) assert.match(html, new RegExp(`name="${name}"`), name);
  assert.match(html, /data-k="select" data-p="[^"]*&quot;name&quot;:&quot;topic&quot;/, "the topic is a Kumo select");
  assert.doesNotMatch(html, /<select|type="checkbox"/, "Kumo controls only");
  assert.match(html, /"@type":"ContactPage"/, "structured data for search engines");
  assert.match(html, /href="\/security\/report"/, "security problems go to the private form");
  assert.match(await (await page("/contact?topic=press")).text(), /name="topic" value="press"/, "a link can choose the topic");
  assert.doesNotMatch(html, /name="topic" value=/, "no topic until one is chosen");
  // Signed in: no email field, the account's address is used.
  const ann = (await (await page("/contact", "ann")).text()).replace(/&#39;/g, "'");
  assert.doesNotMatch(ann, /name="email"/);
  assert.match(ann, /Signed in as ann\. We'll reply to ann@example\.com\./);
  assert.match(ann, /href="\/contact">Contact</, "the signed-in footer links it too");
  // Search engines find the form but not the confirmation page.
  const robots = await (await page("/robots.txt")).text();
  assert.match(robots, /Disallow: \/contact\/confirm/);
  assert.doesNotMatch(robots, /Disallow: \/contact\n/);
  assert.match(await (await page("/sitemap.xml")).text(), /:\d+\/contact<\/loc>/);
  assert.match(await (await page("/llms.txt")).text(), /Contact the Diffinery team: http:\/\/[^ ]+\/contact/);
  assert.match(await (await page("/contact/confirm")).text(), /name="robots" content="noindex/);
});

test("contact: a visitor's message is confirmed with the emailed link, then reaches the site administrators", async () => {
  const { page, api, post, email, linkIn, ready } = await worker();
  const f = await ready();
  const hostile = { name: "Ada <script>alert(1)</script>", topic: "partnership", message: "Hello team,\n<img src=x onerror=alert(1)>\nLet's talk." };
  const sent = await post("/contact", f, message("Ada@Example.net", hostile), undefined, ip());
  assert.equal(sent.status, 200, sent.html.slice(0, 600));
  assert.match(sent.html, /Check your inbox/);
  assert.match(sent.html, /ada@example\.net/);
  const m = await email("the confirmation", (e) => e.kind === "contact_confirm" && e.to_addr === "ada@example.net");
  assert.equal(m.subject, "[Diffinery] Confirm your message to the Diffinery team");
  assert.match(m.dev_copy.text, /Partnerships and integrations/);
  assert.doesNotMatch(JSON.stringify(m.dev_copy), /Ada|onerror|Let's talk/, "nothing typed in the form goes into the email");
  const token = linkIn(m, "/contact/confirm");

  // Unconfirmed: nobody is told yet.
  const [before] = await byEmail(api, "ada@example.net");
  assert.equal(before.state, "unconfirmed");
  assert.doesNotMatch(await (await page("/settings/admin/contact", "root")).text(), /ada@example\.net/);

  const cf = { ...(await w.formOf("/contact/confirm")), stamp: "" };
  const wrong = await post("/contact/confirm", cf, { token: "x".repeat(40) });
  assert.equal(wrong.status, 410);
  assert.match(wrong.html, /This link doesn't work any more/);
  const ok = await post("/contact/confirm", cf, { token });
  assert.equal(ok.status, 200, ok.html.slice(0, 600));
  assert.match(ok.html, /Your message is with the team/);
  assert.ok(ok.html.includes("Ada &lt;script&gt;alert(1)&lt;/script&gt;"), "the name is escaped");
  assert.equal((await post("/contact/confirm", cf, { token })).status, 410, "a link works once");

  const [after] = await byEmail(api, "ada@example.net");
  assert.equal(after.state, "new");
  assert.deepEqual({ name: after.name, topic: after.topic, message: after.message, sender: after.sender }, { name: hostile.name, topic: "partnership", message: hostile.message, sender: null });
  assert.ok(!("confirm_hash" in after));
  // The site administrators get an email to answer from their mailbox, and a notification.
  const note = await email("the site administrators' email", (e) => e.kind === "contact_message" && e.to_addr === "root@example.com");
  assert.equal(note.subject, "[Diffinery] Contact: Partnerships and integrations from Ada <script>alert(1)</script>");
  assert.deepEqual(note.dev_copy.replyTo, { name: hostile.name, email: "ada@example.net" });
  assert.match(note.dev_copy.text, /> Hello team,\n> <img src=x onerror=alert\(1\)>\n> Let's talk\./);
  assert.ok(!note.dev_copy.html.includes("<img src=x"), "the message is escaped in the HTML email");
  assert.match(await (await page("/notifications", "root")).text(), /New contact messages are waiting for you/);
  const admin = await (await page("/settings/admin/contact", "root")).text();
  assert.match(admin, /ada@example\.net/);
  assert.ok(!admin.includes("<script>alert(1)") && !admin.includes("<img src=x"), "everything is escaped");
  assert.match(admin, /Contact messages\s*<span class="badge blue"[^>]*>\s*1\s*</, "the sidebar counts what waits");
  const detail = (await (await page(`/settings/admin/contact/${after.id}`, "root")).text()).replace(/&#39;/g, "'");
  assert.ok(detail.includes("Hello team,\n&lt;img src=x onerror=alert(1)&gt;\nLet's talk."), "the message is plain text");
  assert.match(detail, /href="mailto:ada@example\.net\?subject=Re%3A%20Partnerships%20and%20integrations"/);
});

test("contact: a signed-in person's message arrives at once, with a copy for them", async () => {
  const { api, post, email, formOf } = await worker();
  const f = await formOf("/contact", "ann");
  assert.equal(f.stamp, "", "no timing stamp for a signed-in person");
  const sent = await post("/contact", f, { name: "Ann", topic: "account", message: "My invitation link expired, can you resend?", email: "someone-else@example.net" }, "ann");
  assert.equal(sent.status, 200, sent.html.slice(0, 600));
  assert.match(sent.html, /Message sent/);
  const [m] = await byEmail(api, "ann@example.com");
  assert.equal(m.state, "new");
  assert.equal(m.sender, "ann");
  assert.ok(m.confirmed_at);
  assert.deepEqual(await byEmail(api, "someone-else@example.net"), [], "the address typed is ignored");
  const copy = await email("the copy", (e) => e.kind === "contact_received" && e.to_addr === "ann@example.com");
  assert.equal(copy.subject, "[Diffinery] We got your message");
  assert.match(copy.dev_copy.text, /My invitation link expired/);
  const note = await email("the site administrators' email", (e) => e.kind === "contact_message" && e.dev_copy?.replyTo?.email === "ann@example.com");
  assert.match(note.dev_copy.text, /From: Ann \(@ann\)/);
});

test("contact: bots, bad input and big bodies get nowhere", async () => {
  const { api, post, emails, formOf, ready } = await worker();
  const fresh = await formOf("/contact");
  // Too fast after the page was shown, a filled honeypot, or a forged or missing stamp: the usual page, nothing kept or sent.
  const fast = await post("/contact", fresh, message("bot1@example.net"), undefined, ip());
  assert.equal(fast.status, 200);
  assert.match(fast.html, /Check your inbox/);
  const f = await ready();
  const honey = await post("/contact", f, message("bot2@example.net", { website: "https://spam.example" }), undefined, ip());
  assert.match(honey.html, /Check your inbox/);
  const forged = await post("/contact", { ...f, stamp: `${Date.now() - 10_000}.${"A".repeat(43)}` }, message("bot3@example.net"), undefined, ip());
  assert.match(forged.html, /Check your inbox/);
  const missing = await post("/contact", { ...f, stamp: "" }, message("bot4@example.net"), undefined, ip());
  assert.match(missing.html, /Check your inbox/);
  for (const a of ["bot1", "bot2", "bot3", "bot4"]) assert.deepEqual(await byEmail(api, `${a}@example.net`), [], a);

  // Bad input is refused with the reason, keeping what was typed.
  const long = await post("/contact", f, message("long@example.net", { message: "x".repeat(5001), name: "Keep me" }), undefined, ip());
  assert.equal(long.status, 422);
  assert.match(long.html, /Keep your message to 5,000 characters/);
  assert.match(long.html, /value="Keep me"/);
  const links = await post("/contact", f, message("links@example.net", { message: Array.from({ length: 6 }, (_, i) => `https://s${i}.example`).join(" ") }), undefined, ip());
  assert.equal(links.status, 422);
  assert.match(links.html, /5 links or fewer/);
  const bad = await post("/contact", f, message("not-an-address"), undefined, ip());
  assert.equal(bad.status, 422);
  assert.match(bad.html, /Enter a valid email address/);
  const topic = await post("/contact", f, message("t@example.net", { topic: "<script>" }), undefined, ip());
  assert.equal(topic.status, 422);
  assert.ok(!topic.html.includes('value="<script>"'));
  const huge = await post("/contact", f, message("huge@example.net", { message: "y".repeat(80_000) }), undefined, ip());
  assert.equal(huge.status, 413);
  await sleep(1500);
  const tried = new Set(["bot1", "bot2", "bot3", "bot4", "long", "links", "t", "huge"].map((n) => `${n}@example.net`));
  assert.deepEqual((await emails()).filter((e) => tried.has(e.to_addr)), [], "nothing was emailed");
});

test("contact: only site administrators see messages (404 for anyone else)", async () => {
  const { page, api, post, formOf } = await worker();
  const [ada] = await byEmail(api, "ada@example.net");
  assert.ok(ada, "the message from the tests above");
  for (const path of ["/settings/admin/contact", `/settings/admin/contact/${ada.id}`]) {
    assert.equal((await page(path, "ann")).status, 404, `${path} for a person who isn't a site administrator`);
    const anon = await page(path);
    assert.equal(anon.status, 302, `${path} sends a visitor to sign in`);
    assert.match(anon.headers.get("location") ?? "", /^\/login\?next=/);
  }
  const annForm = await formOf("/settings", "ann");
  for (const action of ["state", "note", "delete"]) assert.equal((await post(`/settings/admin/contact/${ada.id}/${action}`, annForm, { state: "spam", note: "x" }, "ann")).status, 404, action);
  assert.equal((await api("GET", "/diffinery/admin/contact", undefined, T.ann)).status, 404);
  assert.equal((await api("GET", `/diffinery/admin/contact/${ada.id}`, undefined, T.ann)).status, 404);
  assert.equal((await api("PATCH", `/diffinery/admin/contact/${ada.id}`, { state: "spam" }, T.ann)).status, 404);
  assert.equal((await api("DELETE", `/diffinery/admin/contact/${ada.id}`, undefined, T.ann)).status, 404);
  assert.equal((await api("GET", "/diffinery/admin/contact")).status, 401);
  assert.doesNotMatch(await (await page("/settings", "ann")).text(), /href="\/settings\/admin\/contact"/);
  assert.equal((await byEmail(api, "ada@example.net"))[0].state, "new", "nothing changed");
});

test("contact: handle, note, spam, reopen and delete, on the web and through the API, audited", async () => {
  const { page, api, post, formOf, email, emails, linkIn, ready } = await worker();
  const [ada] = await byEmail(api, "ada@example.net");
  // Mark handled from the web, with a note.
  const handled = await post(`/settings/admin/contact/${ada.id}/state`, await formOf("/settings/admin/contact", "root"), { state: "handled", back: "/settings/admin/contact" }, "root");
  assert.equal(handled.status, 303);
  assert.equal(handled.location, "/settings/admin/contact");
  const noted = await post(`/settings/admin/contact/${ada.id}/note`, await formOf(`/settings/admin/contact/${ada.id}`, "root"), { note: "Replied with the partner guide." }, "root");
  assert.equal(noted.status, 303);
  const [now] = await byEmail(api, "ada@example.net");
  assert.deepEqual({ state: now.state, note: now.note, updated_by: now.updated_by }, { state: "handled", note: "Replied with the partner guide.", updated_by: "root" });
  assert.match(await (await page("/settings/admin/contact?state=handled", "root")).text(), /handled by root/);
  assert.match(await (await page(`/settings/admin/contact/${ada.id}`, "root")).text(), />Replied with the partner guide\.</);

  // A second message: spam through the API, after which its address gets nothing through; reopen; then delete on the web.
  const f = await ready();
  await post("/contact", f, message("bob@example.net", { message: "Buy cheap watches, secret plans." }), undefined, ip());
  const token = linkIn(await email("bob's confirmation", (e) => e.kind === "contact_confirm" && e.to_addr === "bob@example.net"), "/contact/confirm");
  await post("/contact/confirm", { ...(await formOf("/contact/confirm")), stamp: "" }, { token });
  const [bob] = await byEmail(api, "bob@example.net");
  assert.equal(bob.state, "new");
  const spam = await api("PATCH", `/diffinery/admin/contact/${bob.id}`, { state: "spam" }, T.root);
  assert.equal(spam.status, 200, JSON.stringify(spam.json));
  assert.equal(spam.json.state, "spam");
  assert.equal((await api("PATCH", `/diffinery/admin/contact/${bob.id}`, { state: "deleted" }, T.root)).status, 422);
  const toBob = async () => (await emails()).filter((e) => e.to_addr === "bob@example.net").length;
  const sent = await toBob();
  const again = await post("/contact", f, message("bob@example.net"), undefined, ip());
  assert.match(again.html, /Check your inbox/, "the same page");
  await sleep(1500);
  assert.equal(await toBob(), sent, "nothing is emailed to an address marked spam");
  assert.equal((await byEmail(api, "bob@example.net")).length, 1, "and nothing is stored");
  assert.equal((await api("PATCH", `/diffinery/admin/contact/${bob.id}`, { state: "new", note: "Not spam after all" }, T.root)).json.state, "new");
  const del = await post(`/settings/admin/contact/${bob.id}/delete`, await formOf(`/settings/admin/contact/${bob.id}`, "root"), {}, "root");
  assert.equal(del.status, 303);
  assert.equal(del.location, "/settings/admin/contact");
  assert.equal((await api("GET", `/diffinery/admin/contact/${bob.id}`, undefined, T.root)).status, 404);

  const audit = await (await page("/settings/audit", "root")).text();
  for (const action of ["contact.create", "contact.confirm", "contact.handle", "contact.note", "contact.spam", "contact.reopen", "contact.delete"]) assert.ok(audit.includes(action), `${action} is audited`);
  assert.ok(!audit.includes("secret plans") && !audit.includes("partner guide") && !audit.includes("onerror"), "the audit log holds no message content");
});

test("contact: daily limits per network and per address", async () => {
  const { api, post, emails, ready } = await worker();
  const f = await ready();
  // One address: three emails a day, then the page stays the same and nothing more is sent.
  const flood = "flood@example.net";
  for (let i = 0; i < 4; i++) assert.equal((await post("/contact", f, message(flood), undefined, ip())).status, 200);
  await sleep(1500);
  assert.equal((await emails()).filter((e) => e.to_addr === flood).length, 3);
  assert.equal((await byEmail(api, flood)).length, 3);
  // One network: ten submissions a day, then a visible refusal.
  const net = "203.0.113.77";
  for (let i = 0; i < 10; i++) assert.equal((await post("/contact", f, message(`n${i}@example.net`), undefined, net)).status, 200, `submission ${i + 1}`);
  const over = await post("/contact", f, message("n10@example.net"), undefined, net);
  assert.equal(over.status, 429);
  assert.match(over.html, /Too many messages from your network today/);
  assert.deepEqual(await byEmail(api, "n10@example.net"), []);
  // Another network still gets through.
  assert.equal((await post("/contact", f, message("other@example.net"), undefined, ip())).status, 200);
});
