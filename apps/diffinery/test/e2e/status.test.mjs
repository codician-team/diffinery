// End-to-end status page: /status and GET /api/v3/diffinery/status for anyone, and incidents that a
// site administrator opens, updates and resolves on Settings → Status and through the admin API, on
// a real `wrangler dev` Worker with no fixed dev identity (so callers can be anonymous). Also covers
// 404 for everyone else, the audit log, and the hosted compute pause showing as maintenance.
//
//   pnpm --filter @diffinery/app exec node --test test/e2e/status.test.mjs
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
const work = mkdtempSync(join(tmpdir(), "diffinery-status-e2e-"));
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

const hash = (s) => createHash("sha256").update(s).digest("hex");

/** The Worker, with a site administrator (root) and a person (ann); started once. */
let statusWorker;
const T = { root: `dfy_root_${randomBytes(12).toString("hex")}`, ann: `dfy_ann_${randomBytes(12).toString("hex")}` };
const S = { root: `root-session-${randomBytes(12).toString("hex")}`, ann: `ann-session-${randomBytes(12).toString("hex")}` };
const ids = {};

async function status() {
  if (statusWorker) return statusWorker;
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 30 * 86400_000).toISOString();
  const person = (id, login, email, admin) => `INSERT INTO accounts (id, login, kind, name, email, status, site_admin, created_at) VALUES ('${id}', '${login}', 'user', '${login}', '${email}', 'active', ${admin}, '${at}')`;
  const token = (id, account, t) => `INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('${id}', '${account}', 'e2e', '${hash(t)}', '${t.slice(0, 10)}', '["admin"]', '${later}', '${at}')`;
  const session = (account, cookie) => `INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(cookie)}', '${account}', 'passkey', '${at}', '${at}', '${later}')`;
  const w = await worker("status", { DEV_AUTH: "" }, [
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
    return { status: r.status, json, headers: r.headers };
  };
  const page = (path, who) => fetch(`${w.base}${path}`, { headers: { cookie: cookieOf(who) }, redirect: "manual" });
  /** Submit a form on `pagePath` to `action` the way a browser does: the page's CSRF pair, same-origin. `fields` is a list of [name, value]. */
  const submit = async (pagePath, action, fields, who) => {
    const res = await page(pagePath, who);
    assert.equal(res.status, 200, `GET ${pagePath} -> ${res.status}`);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await res.text())?.[1];
    const pair = /dfy_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(csrf && pair, `no CSRF pair on ${pagePath}`);
    const r = await fetch(`${w.base}${action}`, { method: "POST", body: new URLSearchParams([["_csrf", csrf], ...fields]), redirect: "manual", headers: { cookie: [cookieOf(who), `dfy_csrf=${pair}`].filter(Boolean).join("; "), "sec-fetch-site": "same-origin" } });
    return { status: r.status, location: r.headers.get("location"), setCookie: r.headers.get("set-cookie") ?? "", html: await r.text() };
  };
  const summary = async () => {
    const r = await api("GET", "/diffinery/status");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  statusWorker = { ...w, api, page, submit, summary };
  return statusWorker;
}

/** The flash message a redirect sets, decoded. */
function flashOf(setCookie) {
  let v = /dfy_flash=([^;]+)/.exec(setCookie)?.[1] ?? "";
  for (let i = 0; i < 3 && /%[0-9A-F]{2}/i.test(v); i++) v = decodeURIComponent(v);
  return v;
}
const componentOf = (s, id) => s.components.find((c) => c.id === id);
/** The part of the public page from its "Past incidents" heading on. */
const pastPart = (html) => html.slice(html.indexOf("<h2>Past incidents</h2>"));
const activePart = (html) => html.slice(0, html.indexOf("<h2>Components</h2>"));

const apiTitle = `Pushes are failing <b>${randomBytes(4).toString("hex")}</b>`;
const webTitle = `Emails are delayed ${randomBytes(4).toString("hex")}`;

test("status page: anyone can read it, and everything is operational at first", async () => {
  const { page, summary, api } = await status();
  const res = await page("/status");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<h1>Status<\/h1>/);
  assert.match(html, /All systems operational/);
  for (const name of ["Website and API", "Git operations", "Actions", "Agents and sandboxes", "Packages", "Email"]) assert.ok(html.includes(name), `${name} is listed`);
  assert.match(html, /No incidents in the last 14 days/);
  // Every page links it from the footer.
  assert.match(await (await page("/")).text(), /<footer class="site-foot">[\s\S]*href="\/status"/);

  const s = await summary();
  assert.deepEqual(s.status, { indicator: "none", description: "All systems operational" });
  assert.deepEqual(
    s.components.map((c) => [c.id, c.status]),
    ["web", "git", "actions", "agents", "packages", "email"].map((id) => [id, "operational"]),
  );
  assert.deepEqual(s.incidents, []);
  assert.ok(!Number.isNaN(Date.parse(s.updated_at)));
  const r = await api("GET", "/diffinery/status");
  assert.equal(r.headers.get("cache-control"), "public, max-age=30");
});

test("status page: only site administrators can manage incidents (404 for anyone else)", async () => {
  const { api, page } = await status();
  const open = { title: "Nope", impact: "major", components: ["git"], state: "investigating", body: "x" };
  assert.equal((await api("GET", "/diffinery/admin/status/incidents", undefined, T.ann)).status, 404);
  assert.equal((await api("POST", "/diffinery/admin/status/incidents", open, T.ann)).status, 404);
  assert.equal((await api("POST", `/diffinery/admin/status/incidents/${"0".repeat(32)}/updates`, { state: "resolved", body: "x" }, T.ann)).status, 404);
  assert.equal((await api("GET", "/diffinery/admin/status/incidents")).status, 401);
  assert.equal((await api("POST", "/diffinery/admin/status/incidents", open)).status, 401);
  assert.equal((await page("/settings/admin/status", "ann")).status, 404);
  const anon = await page("/settings/admin/status");
  assert.equal(anon.status, 302, "a signed-out visitor is sent to sign in");
  assert.match(anon.headers.get("location") ?? "", /^\/login\?next=/);
  assert.doesNotMatch(await (await page("/settings", "ann")).text(), /href="\/settings\/admin\/status"/);
  // Nothing was opened.
  assert.deepEqual((await api("GET", "/diffinery/admin/status/incidents", undefined, T.root)).json, []);
});

test("status page: a site administrator opens an incident through the API, and the page shows it", async () => {
  const { api, page, summary } = await status();
  // Refused with sentences that say what to fix.
  const bad = await api("POST", "/diffinery/admin/status/incidents", { title: "x", impact: "major", components: [], state: "investigating", body: "x" }, T.root);
  assert.equal(bad.status, 422);
  assert.equal(bad.json.message, "Choose at least one affected component.");
  const unknown = await api("POST", "/diffinery/admin/status/incidents", { title: "x", impact: "major", components: ["database"], state: "investigating", body: "x" }, T.root);
  assert.equal(unknown.status, 422);
  assert.match(unknown.json.message, /There is no component called "database"/);
  assert.equal((await api("POST", "/diffinery/admin/status/incidents", { title: "x", impact: "huge", components: ["git"], state: "investigating", body: "x" }, T.root)).status, 422);

  const r = await api("POST", "/diffinery/admin/status/incidents", { title: apiTitle, impact: "major", components: ["git"], state: "investigating", body: "We are investigating failed pushes.\n<script>alert(1)</script>" }, T.root);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  ids.api = r.json.id;
  assert.match(ids.api, /^[0-9a-f]{32}$/);
  assert.equal(r.json.created_by, "root");
  assert.equal(r.json.updates.length, 1);
  assert.equal(r.json.updates[0].author, "root");

  const s = await summary();
  assert.deepEqual(s.status, { indicator: "major", description: "Partial outage" });
  assert.equal(componentOf(s, "git").status, "partial_outage");
  assert.equal(componentOf(s, "web").status, "operational");
  assert.deepEqual(
    s.incidents.map((i) => [i.id, i.title, i.state, i.components]),
    [[ids.api, apiTitle, "investigating", ["git"]]],
  );
  assert.equal(s.incidents[0].created_by, undefined, "the public JSON doesn't name administrators");
  assert.equal(s.incidents[0].updates[0].author, undefined);

  const html = await (await page("/status")).text();
  assert.match(html, /Partial outage/);
  assert.match(html, /<li data-component="git" data-status="partial_outage">/);
  assert.ok(activePart(html).includes(apiTitle.replace("<b>", "&lt;b&gt;").replace("</b>", "&lt;/b&gt;")), "the title is escaped, under active incidents");
  assert.ok(!html.includes("<script>alert(1)</script>"), "the update is plain text");
  assert.match(html, /We are investigating failed pushes\./);
});

test("status page: the web form opens an incident with several components and posts updates", async () => {
  const { submit, summary, api, page } = await status();
  const base = "/settings/admin/status";
  const missing = await submit(base, base, [["title", webTitle], ["impact", "minor"], ["state", "investigating"], ["body", "Looking."]], "root");
  assert.equal(missing.status, 303);
  assert.match(flashOf(missing.setCookie), /Choose at least one affected component\./);
  const opened = await submit(
    base,
    base,
    [
      ["title", webTitle],
      ["impact", "minor"],
      ["components", "email"],
      ["components", "web"],
      ["state", "investigating"],
      ["body", "Some emails are delayed by a few minutes."],
    ],
    "root",
  );
  assert.equal(opened.status, 303);
  assert.equal(opened.location, base);
  let s = await summary();
  const web = s.incidents.find((i) => i.title === webTitle);
  assert.ok(web, "the incident from the form is listed");
  ids.web = web.id;
  assert.deepEqual(web.components, ["web", "email"]);
  assert.equal(componentOf(s, "email").status, "degraded_performance");
  // Worst wins: git's partial outage outranks the email incident.
  assert.deepEqual(s.status, { indicator: "major", description: "Partial outage" });

  const adminHtml = await (await page(base, "root")).text();
  assert.ok(adminHtml.includes(webTitle));
  assert.ok(adminHtml.includes(`action="${base}/${ids.web}"`), "each open incident has an update form");
  assert.doesNotMatch(adminHtml, /<select|type="checkbox"/, "Kumo controls only");

  const identified = await submit(base, `${base}/${ids.web}`, [["state", "identified"], ["body", "A mail queue was stuck; draining it."]], "root");
  assert.equal(identified.status, 303);
  const resolved = await submit(base, `${base}/${ids.web}`, [["state", "resolved"], ["body", "Emails are on time again."]], "root");
  assert.equal(resolved.status, 303);
  assert.match(flashOf(resolved.setCookie), /Incident resolved/);
  const listed = (await api("GET", "/diffinery/admin/status/incidents", undefined, T.root)).json.find((i) => i.id === ids.web);
  assert.equal(listed.state, "resolved");
  assert.ok(listed.resolved_at);
  assert.deepEqual(
    listed.updates.map((u) => u.state),
    ["resolved", "identified", "investigating"],
  );
  s = await summary();
  assert.equal(componentOf(s, "email").status, "operational");
  assert.ok(!s.incidents.some((i) => i.id === ids.web));
});

test("status page: resolving through the API returns the component to operational and moves the incident to past incidents", async () => {
  const { api, page, summary } = await status();
  assert.ok(ids.api, "the incident from the test above");
  const bad = await api("POST", `/diffinery/admin/status/incidents/${ids.api}/updates`, { state: "fixed", body: "x" }, T.root);
  assert.equal(bad.status, 422);
  assert.equal((await api("POST", `/diffinery/admin/status/incidents/${"0".repeat(32)}/updates`, { state: "resolved", body: "x" }, T.root)).status, 404);
  const r = await api("POST", `/diffinery/admin/status/incidents/${ids.api}/updates`, { state: "resolved", body: "Pushes work again." }, T.root);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.state, "resolved");

  const s = await summary();
  assert.deepEqual(s.status, { indicator: "none", description: "All systems operational" });
  assert.equal(componentOf(s, "git").status, "operational");
  assert.deepEqual(s.incidents, []);

  const html = await (await page("/status")).text();
  assert.match(html, /All systems operational/);
  assert.doesNotMatch(html, /Active incidents/);
  const past = pastPart(html);
  assert.ok(past.includes("Pushes are failing"), "the API incident is under past incidents");
  assert.ok(past.includes(webTitle), "so is the one from the form");
  assert.match(past, /Pushes work again\./);
});

test("status page: changes are audited without the updates' text", async () => {
  const { page } = await status();
  assert.ok(ids.api && ids.web, "the incidents from the tests above");
  const audit = await (await page("/settings/audit", "root")).text();
  for (const action of ["status_incident.create", "status_incident.update", "status_incident.resolve"]) assert.ok(audit.includes(action), `${action} is audited`);
  assert.ok(audit.includes(ids.api) && audit.includes(ids.web), "the audit log names the incidents");
  assert.ok(!audit.includes("Pushes work again"), "the audit log holds no update text");
});

test("status page: pausing hosted compute shows Actions and agent sandboxes under maintenance", async () => {
  const { api, summary, page } = await status();
  const paused = await api("PUT", "/admin/hosted-compute-pause", { reason: "internal runner image problem" }, T.root);
  assert.equal(paused.status, 200, JSON.stringify(paused.json));
  try {
    const s = await summary();
    assert.deepEqual(s.status, { indicator: "maintenance", description: "Service under maintenance" });
    assert.deepEqual(componentOf(s, "actions"), { id: "actions", name: "Actions", status: "under_maintenance", note: "Hosted jobs are paused by the site administrators. Jobs on self-hosted runners still run." });
    assert.equal(componentOf(s, "agents").status, "under_maintenance");
    assert.equal(componentOf(s, "git").status, "operational");
    const html = await (await page("/status")).text();
    assert.match(html, /Hosted jobs are paused by the site administrators\./);
    assert.ok(!html.includes("internal runner image problem"), "the pause's reason isn't public");
  } finally {
    assert.equal((await api("DELETE", "/admin/hosted-compute-pause", undefined, T.root)).status, 200);
  }
  assert.equal((await summary()).status.indicator, "none");
});
