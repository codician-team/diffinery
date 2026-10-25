// End-to-end OAuth sign-in for MCP clients (src/auth/oauth.ts): a real `wrangler dev` Worker and a real
// Chromium, doing what claude.ai, Claude Code and Codex do when they connect to /mcp.
//
//   pnpm --filter @diffinery/app exec node --test test/e2e/oauth.test.mjs
//
// Covers: discovery from /mcp's 401, dynamic registration (and the redirect URIs it refuses), a
// client metadata document as the client_id, the consent page (signed out, unknown app, wrong redirect,
// cancel, acting as yourself or an agent, admin never preselected), PKCE, codes working once, MCP calls
// with the token, refresh rotation and reuse, confidential clients, revocation, and Connected apps.
import "./fresh-connections.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "diffinery-oauth-"));
let base;
let dev;
let devLog = "";
let browser;
let docs;
let persist;

/** ada is signed in on one browser, recently enough to connect apps, and runs the agent ada-bot. */
const ADA_SESSION = "ada-browser-session-0123456789abcdef";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const b64url = (b) => Buffer.from(b).toString("base64url");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
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
      `INSERT INTO accounts (id, login, kind, name, status, owner_id, created_at) VALUES ('bot1', 'ada-bot', 'agent', 'Ada bot', 'active', 'ada1', '${at}')`,
      `INSERT INTO accounts (id, login, kind, name, email, status, created_at) VALUES ('bob1', 'bob', 'user', 'Bob', 'bob@example.com', 'active', '${at}')`,
      `INSERT INTO accounts (id, login, kind, name, status, owner_id, created_at) VALUES ('bot2', 'bob-bot', 'agent', 'Bob bot', 'active', 'bob1', '${at}')`,
      `INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(ADA_SESSION)}', 'ada1', 'passkey', '${at}', '${at}', '${later}')`,
    ].join("; "),
  );
  // A client metadata document server, as https://claude.ai/oauth/claude-code-client-metadata is for Claude Code.
  docs = createHttpServer((req, res) => {
    const id = `http://127.0.0.1:${docs.address().port}${req.url}`;
    const doc = req.url === "/client.json" ? { client_id: id, client_name: "Doc App", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none" } : req.url === "/liar.json" ? { client_id: "https://elsewhere.example/client.json", client_name: "Liar", redirect_uris: ["http://127.0.0.1/callback"] } : null;
    res.writeHead(doc ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(doc ?? {}));
  });
  await new Promise((r) => docs.listen(0, "127.0.0.1", r));
  dev = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${base}`, "--var", "DEV_AUTH:", "--show-interactive-dev-session=false"],
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
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  docs?.close();
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  }
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
});

const form = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });
const register = (body, headers = {}) => fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const mcp = (token, method, params = {}) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
const whoami = async (token) => (await (await mcp(token, "tools/call", { name: "whoami", arguments: {} })).json()).result?.structuredContent;

function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/**
 * A signed-in browser for ada. Requests to an app's callback are recorded here, as the app's own listener would
 * see them (nothing listens, so the navigation itself fails; route() can't catch the target of a redirect).
 */
async function adaBrowser() {
  const context = await browser.newContext();
  const callbacks = [];
  context.on("request", (r) => {
    const u = new URL(r.url());
    if (u.origin !== new URL(base).origin && (u.pathname === "/callback" || u.host === "app.example")) callbacks.push(u);
  });
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.evaluate((v) => (document.cookie = `__Host-dfy_session=${v}; path=/; secure; samesite=lax`), ADA_SESSION);
  return { context, page, callbacks };
}
const text = async (page) => ((await page.textContent("main")) ?? "").replace(/\s+/g, " ");

/** Opens the consent page, picks the account and access, and presses a button. Returns the app's callback URL. */
async function consent(ada, url, { actAs, scope, decision = "approve" } = {}) {
  await ada.page.goto(url);
  for (const [name, v] of [["act_as", actAs], ["access", scope]]) {
    if (v) await ada.page.evaluate(([n, val]) => document.querySelectorAll(`input[name="${n}"]`).forEach((i) => (i.value = val)), [name, v]);
  }
  const before = ada.callbacks.length;
  await ada.page.click(`button[value="${decision}"]`, { noWaitAfter: true });
  const cb = await until("the app's callback", async () => ada.callbacks[before]);
  await settled(ada.page);
  return cb;
}

/** Nothing listens at the app's callback, so the browser lands on an error page: wait for it, so the next goto isn't interrupted. */
const settled = (page) => until("the failed callback navigation", async () => page.url().startsWith("chrome-error:"));

/** Opens a URL that sends the browser straight back to the app. */
async function bounce(page, url) {
  await page.goto("about:blank");
  await page.goto(url).catch(() => {});
  await settled(page);
}

test("OAuth for MCP clients: discovery, registration, consent, tokens, refresh and revocation", async () => {
  // ------------------------------------------------------------ discovery, as an MCP client starts it
  const anon = await mcp(null, "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get("www-authenticate"), `Bearer realm="Diffinery", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  const bad = await mcp("dfy_not_a_real_token", "initialize");
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate"), /error="invalid_token"/);
  // git and the REST API still get Basic.
  assert.match((await fetch(`${base}/api/v3/user`)).headers.get("www-authenticate") ?? "", /^Basic/);
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual(prm.authorization_servers, [base]);
  assert.equal(prm.resource, `${base}/mcp`);
  const meta = await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: { origin: "https://app.example" } });
  assert.equal(meta.headers.get("access-control-allow-origin"), "*");
  const as = await meta.json();
  assert.equal(as.issuer, base);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.client_id_metadata_document_supported, true);

  // ------------------------------------------------------------ dynamic registration
  for (const uri of ["http://evil.example/callback", "javascript:alert(1)", "https://app.example/cb#frag", "data:text/html,hi"]) {
    const r = await register({ redirect_uris: [uri], client_name: "Bad" });
    assert.equal(r.status, 400, uri);
    assert.equal((await r.json()).error, "invalid_redirect_uri");
  }
  // From a browser on another site, as the MCP Inspector registers: no cookies, so allowed.
  const reg = await register({ redirect_uris: ["http://127.0.0.1/callback", "https://app.example/oauth/cb"], client_name: "E2E <b>App</b>", token_endpoint_auth_method: "none" }, { origin: "https://inspector.example", "sec-fetch-site": "cross-site" });
  assert.equal(reg.status, 201, await reg.clone().text());
  const app = await reg.json();
  assert.match(app.client_id, /^dfc_/);
  assert.equal(app.client_secret, undefined);
  assert.equal(app.client_name, "E2E bApp/b");

  const ada = await adaBrowser();
  const { verifier, challenge } = pkce();
  const authorize = (q) => `${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: app.client_id, redirect_uri: "http://127.0.0.1:41999/callback", code_challenge: challenge, code_challenge_method: "S256", state: "st-1", scope: "read write admin", resource: `${base}/mcp`, ...q })}`;

  // ------------------------------------------------------------ the consent page refuses what it can't trust
  const signedOut = await (await browser.newContext()).newPage();
  await signedOut.goto(authorize());
  assert.equal(new URL(signedOut.url()).pathname, "/login");
  assert.match(new URL(signedOut.url()).searchParams.get("next"), /^\/oauth\/authorize\?/);
  await ada.page.goto(authorize({ client_id: "dfc_unknown" }));
  assert.match(await text(ada.page), /isn't registered with Diffinery/);
  await ada.page.goto(authorize({ redirect_uri: "https://evil.example/callback" }));
  assert.match(await text(ada.page), /didn't register\. Nothing was shared/);
  assert.equal(ada.callbacks.length, 0);
  // A request without PKCE goes back to the app with an error.
  await bounce(ada.page, authorize({ code_challenge: "" }));
  await until("the PKCE error", async () => ada.callbacks[0]);
  assert.equal(ada.callbacks[0].searchParams.get("error"), "invalid_request");
  assert.equal(ada.callbacks[0].searchParams.get("state"), "st-1");
  await bounce(ada.page, authorize({ resource: "https://elsewhere.example/mcp" }));
  await until("the resource error", async () => ada.callbacks[1]);
  assert.equal(ada.callbacks[1].searchParams.get("error"), "invalid_target");

  // ------------------------------------------------------------ the page, then Cancel
  await ada.page.goto(authorize());
  const page = await text(ada.page);
  assert.match(page, /Connect E2E bApp\/b to Diffinery/);
  assert.match(page, /a name it chose, not checked by Diffinery/);
  assert.match(page, /Sends you back to\s*an app on this computer/);
  assert.match(page, /ada \(you\)/);
  assert.match(page, /ada-bot \(agent\)/);
  assert.doesNotMatch(page, /bob-bot/);
  // The app asked for admin; admin is never preselected.
  assert.equal(await ada.page.locator('input[name="access"]').first().inputValue(), "write");
  if (process.env.E2E_SCREENSHOTS) await ada.page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, "oauth-consent.png"), fullPage: true });
  const cancelled = await consent(ada, authorize(), { decision: "deny" });
  assert.equal(cancelled.searchParams.get("error"), "access_denied");
  assert.equal(cancelled.searchParams.get("iss"), base);

  // Someone else's agent can't be picked, even by editing the form.
  await ada.page.goto(authorize());
  await ada.page.evaluate(() => document.querySelectorAll('input[name="act_as"]').forEach((i) => (i.value = "bob-bot")));
  await ada.page.click('button[value="approve"]');
  assert.match(await text(ada.page), /only as yourself or as an agent you run/);

  // ------------------------------------------------------------ approve as the agent, with read access
  const cb = await consent(ada, authorize(), { actAs: "ada-bot", scope: "read" });
  assert.equal(cb.port, "41999");
  assert.equal(cb.searchParams.get("state"), "st-1");
  const code = cb.searchParams.get("code");
  assert.match(code, /^dfa_/);
  const exchange = (extra) => form(`${base}/oauth/token`, { grant_type: "authorization_code", code, client_id: app.client_id, redirect_uri: "http://127.0.0.1:41999/callback", code_verifier: verifier, ...extra });
  // A wrong verifier burns the code.
  const wrong = await exchange({ code_verifier: pkce().verifier });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, "invalid_grant");
  assert.equal((await (await exchange()).json()).error, "invalid_grant");

  const cb2 = await consent(ada, authorize(), { actAs: "ada-bot", scope: "read" });
  const tokRes = await form(`${base}/oauth/token`, { grant_type: "authorization_code", code: cb2.searchParams.get("code"), client_id: app.client_id, redirect_uri: "http://127.0.0.1:41999/callback", code_verifier: verifier, resource: `${base}/mcp` }, { origin: "https://inspector.example" });
  assert.equal(tokRes.status, 200, await tokRes.clone().text());
  assert.equal(tokRes.headers.get("cache-control"), "no-store");
  const tok = await tokRes.json();
  assert.equal(tok.token_type, "Bearer");
  assert.equal(tok.expires_in, 8 * 3600);
  assert.equal(tok.scope, "read");
  assert.match(tok.access_token, /^dfy_/);
  assert.match(tok.refresh_token, /^dfr_/);
  assert.deepEqual(await whoami(tok.access_token), { login: "ada-bot", kind: "agent", on_behalf_of: "ada" });
  // Read access: a tool that changes things is refused.
  const write = await (await mcp(tok.access_token, "tools/call", { name: "create_issue", arguments: { owner: "ada", repo: "nope", title: "x" } })).json();
  assert.equal(write.result.isError, true);
  assert.match(write.result.content[0].text, /write scope/);
  // The code works once.
  const again = await form(`${base}/oauth/token`, { grant_type: "authorization_code", code: cb2.searchParams.get("code"), client_id: app.client_id, code_verifier: verifier });
  assert.equal((await again.json()).error, "invalid_grant");

  // ------------------------------------------------------------ refresh: rotation, and a replaced token used again
  const refresh = (rt, client_id = app.client_id) => form(`${base}/oauth/token`, { grant_type: "refresh_token", refresh_token: rt, client_id });
  const r1 = await (await refresh(tok.refresh_token)).json();
  assert.match(r1.access_token, /^dfy_/);
  assert.notEqual(r1.refresh_token, tok.refresh_token);
  assert.equal((await whoami(r1.access_token)).login, "ada-bot");
  // Another app can't use it.
  const other = await (await register({ redirect_uris: ["http://127.0.0.1/callback"], client_name: "Other" })).json();
  assert.equal((await (await refresh(r1.refresh_token, other.client_id)).json()).error, "invalid_grant");
  // ...and trying ended the connection, since the token was presented by the wrong app.
  assert.equal((await (await refresh(r1.refresh_token)).json()).error, "invalid_grant");
  assert.equal((await mcp(r1.access_token, "ping")).status, 401);

  // A fresh connection: a replaced refresh token used again soon after is refused, but the connection stays.
  const cb3 = await consent(ada, authorize(), { scope: "write" });
  const t3 = await (await form(`${base}/oauth/token`, { grant_type: "authorization_code", code: cb3.searchParams.get("code"), client_id: app.client_id, code_verifier: verifier })).json();
  assert.deepEqual(await whoami(t3.access_token), { login: "ada", kind: "user", on_behalf_of: null });
  const t4 = await (await refresh(t3.refresh_token)).json();
  assert.equal((await (await refresh(t3.refresh_token)).json()).error, "invalid_grant");
  const t5 = await (await refresh(t4.refresh_token)).json();
  assert.match(t5.access_token, /^dfy_/);
  // Long after it was replaced, the old one ends the connection (someone else has it).
  sql(`UPDATE oauth_grants SET refreshed_at = '${new Date(Date.now() - 3600_000).toISOString()}' WHERE refresh_hash = '${hash(t5.refresh_token)}'`);
  assert.equal((await (await refresh(t4.refresh_token)).json()).error, "invalid_grant");
  assert.equal((await (await refresh(t5.refresh_token)).json()).error, "invalid_grant");
  assert.equal((await mcp(t5.access_token, "ping")).status, 401);

  // ------------------------------------------------------------ Connected apps, and disconnecting
  const cb4 = await consent(ada, authorize(), { scope: "write" });
  const t6 = await (await form(`${base}/oauth/token`, { grant_type: "authorization_code", code: cb4.searchParams.get("code"), client_id: app.client_id, code_verifier: verifier })).json();
  // The same app approved again (say, Claude Code on a second computer) is a second connection: the first keeps working.
  const cb4b = await consent(ada, authorize(), { scope: "read" });
  const t6b = await (await form(`${base}/oauth/token`, { grant_type: "authorization_code", code: cb4b.searchParams.get("code"), client_id: app.client_id, code_verifier: verifier })).json();
  assert.equal((await whoami(t6.access_token)).login, "ada");
  assert.equal((await whoami(t6b.access_token)).login, "ada");
  await ada.page.goto(`${base}/settings/tokens`);
  const settings = await text(ada.page);
  assert.match(settings, /Connected apps.*E2E bApp\/b.*an app on this computer.*ada.*write/);
  // Its rotating tokens aren't listed one by one with the personal tokens.
  assert.doesNotMatch(settings, /connected app\)/);
  ada.page.on("dialog", (d) => d.accept());
  for (let i = 0; i < 2; i++) await Promise.all([ada.page.waitForURL(/\/settings\/tokens/), ada.page.locator("button:has-text('Disconnect')").first().click()]);
  assert.match(await text(ada.page), /No apps connected/);
  assert.equal((await mcp(t6.access_token, "ping")).status, 401);
  assert.equal((await (await refresh(t6.refresh_token)).json()).error, "invalid_grant");

  // ------------------------------------------------------------ revocation endpoint (RFC 7009)
  const cb5 = await consent(ada, authorize(), { scope: "write" });
  const t7 = await (await form(`${base}/oauth/token`, { grant_type: "authorization_code", code: cb5.searchParams.get("code"), client_id: app.client_id, code_verifier: verifier })).json();
  assert.equal((await form(`${base}/oauth/revoke`, { token: t7.refresh_token, client_id: app.client_id })).status, 200);
  assert.equal((await mcp(t7.access_token, "ping")).status, 401);
  assert.equal((await form(`${base}/oauth/revoke`, { token: "dfr_unknown", client_id: app.client_id })).status, 200);

  // ------------------------------------------------------------ a confidential client proves itself
  const conf = await (await register({ redirect_uris: ["https://app.example/oauth/cb"], client_name: "Server App", token_endpoint_auth_method: "client_secret_basic" })).json();
  assert.match(conf.client_secret, /^dfs_/);
  const confAuth = (q) => `${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: conf.client_id, redirect_uri: "https://app.example/oauth/cb", code_challenge: challenge, code_challenge_method: "S256", ...q })}`;
  await ada.page.goto(confAuth());
  assert.match(await text(ada.page), /Sends you back to\s*app\.example/);
  const cb6 = await consent(ada, confAuth(), { scope: "read" });
  const c6 = cb6.searchParams.get("code");
  const noSecret = await form(`${base}/oauth/token`, { grant_type: "authorization_code", code: c6, client_id: conf.client_id, code_verifier: verifier });
  assert.equal(noSecret.status, 401);
  assert.equal((await noSecret.json()).error, "invalid_client");
  const basic = `Basic ${Buffer.from(`${conf.client_id}:${conf.client_secret}`).toString("base64")}`;
  const cb7 = await consent(ada, confAuth(), { scope: "read" });
  const t8 = await form(`${base}/oauth/token`, { grant_type: "authorization_code", code: cb7.searchParams.get("code"), code_verifier: verifier }, { authorization: basic });
  assert.equal(t8.status, 200, await t8.clone().text());
  assert.equal((await whoami((await t8.json()).access_token)).login, "ada");
  await ada.context.close();
});

test("OAuth: a client metadata document as the client_id", async () => {
  const ada = await adaBrowser();
  const { verifier, challenge } = pkce();
  const docUrl = `http://127.0.0.1:${docs.address().port}/client.json`;
  const authorize = (client_id) => `${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://127.0.0.1:42111/callback", code_challenge: challenge, code_challenge_method: "S256", state: "s" })}`;
  // A document that doesn't name itself is refused.
  await ada.page.goto(authorize(`http://127.0.0.1:${docs.address().port}/liar.json`));
  assert.match(await text(ada.page), /isn't registered with Diffinery/);
  await ada.page.goto(authorize(docUrl));
  assert.match(await text(ada.page), /Connect Doc App to Diffinery/);
  assert.match(await text(ada.page), /An app published by 127\.0\.0\.1/);
  const cb = await consent(ada, authorize(docUrl), { scope: "read" });
  const t = await (await form(`${base}/oauth/token`, { grant_type: "authorization_code", code: cb.searchParams.get("code"), client_id: docUrl, code_verifier: verifier })).json();
  assert.equal((await whoami(t.access_token)).login, "ada");
  await ada.context.close();
});

test("OAuth: Diffinery's own editor extension (apps/vscode)", async () => {
  const ada = await adaBrowser();
  const { verifier, challenge } = pkce();
  const client_id = `${base}/oauth/clients/editor.json`;
  // The server publishes the extension's metadata document at its client_id.
  const doc = await (await fetch(client_id)).json();
  assert.equal(doc.client_id, client_id);
  assert.ok(doc.redirect_uris.includes("cursor://codician.diffinery/oauth") && doc.redirect_uris.includes("vscode://codician.diffinery/oauth"));
  const authorize = (redirect_uri) => `${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri, code_challenge: challenge, code_challenge_method: "S256", state: "ed", scope: "write" })}`;
  // An editor's own scheme: the consent page names the publisher and where it sends you, and approving redirects there.
  await ada.page.goto(authorize("cursor://codician.diffinery/oauth"));
  assert.match(await text(ada.page), /Connect Diffinery extension for VS Code and Cursor to Diffinery/);
  assert.match(await text(ada.page), /An app published by localhost/);
  assert.match(await text(ada.page), /Sends you back to\s*cursor:\/\/codician\.diffinery/);
  let location;
  const onResponse = (r) => (r.headers().location?.startsWith("cursor://") ? (location = r.headers().location) : null);
  ada.context.on("response", onResponse);
  await ada.page.click('button[value="approve"]', { noWaitAfter: true }).catch(() => {});
  const cursorCb = new URL(await until("the redirect to Cursor", async () => location));
  ada.context.off("response", onResponse);
  assert.equal(cursorCb.searchParams.get("state"), "ed");
  const t1 = await form(`${base}/oauth/token`, { grant_type: "authorization_code", code: cursorCb.searchParams.get("code"), client_id, code_verifier: verifier, redirect_uri: "cursor://codician.diffinery/oauth" });
  assert.equal(t1.status, 200, await t1.clone().text());
  const tok = await t1.json();
  assert.equal((await whoami(tok.access_token)).login, "ada");
  // The token works for the REST API the extension lists repositories with.
  assert.equal((await (await fetch(`${base}/api/v3/user`, { headers: { authorization: `Bearer ${tok.access_token}` } })).json()).login, "ada");
  // It renews with the refresh token, as the extension does before the access token expires.
  const r = await (await form(`${base}/oauth/token`, { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id })).json();
  assert.match(r.access_token, /^dfy_/);
  // An editor the server has no scheme for uses a loopback address, any port.
  const cb = await consent(ada, authorize("http://127.0.0.1:45123/callback"), { scope: "write" });
  assert.equal(cb.port, "45123");
  // Other schemes and hosts aren't the extension's.
  await ada.page.goto(authorize("evil://codician.diffinery/oauth"));
  assert.match(await text(ada.page), /didn't register\. Nothing was shared/);
  await ada.context.close();
});

test("OAuth: Diffinery's own plugin for JetBrains IDEs (apps/jetbrains)", async () => {
  const ada = await adaBrowser();
  const { verifier, challenge } = pkce();
  const client_id = `${base}/oauth/clients/jetbrains.json`;
  const doc = await (await fetch(client_id)).json();
  assert.equal(doc.client_id, client_id);
  assert.equal(doc.client_name, "Diffinery plugin for JetBrains IDEs");
  assert.deepEqual(doc.redirect_uris, ["http://127.0.0.1/callback"]);
  const authorize = (redirect_uri) => `${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri, code_challenge: challenge, code_challenge_method: "S256", state: "jb", scope: "write" })}`;
  // The IDE listens on a loopback port of its choosing.
  await ada.page.goto(authorize("http://127.0.0.1:51234/callback"));
  assert.match(await text(ada.page), /Connect Diffinery plugin for JetBrains IDEs to Diffinery/);
  assert.match(await text(ada.page), /Sends you back to\s*an app on this computer/);
  const cb = await consent(ada, authorize("http://127.0.0.1:51234/callback"), { scope: "write" });
  assert.equal(cb.port, "51234");
  assert.equal(cb.searchParams.get("state"), "jb");
  const t = await form(`${base}/oauth/token`, { grant_type: "authorization_code", code: cb.searchParams.get("code"), client_id, code_verifier: verifier, redirect_uri: "http://127.0.0.1:51234/callback" });
  assert.equal(t.status, 200, await t.clone().text());
  assert.equal((await whoami((await t.json()).access_token)).login, "ada");
  // Only loopback: no editor schemes, no other hosts.
  for (const bad of ["vscode://codician.diffinery/oauth", "http://example.com/callback"]) {
    await ada.page.goto(authorize(bad));
    assert.match(await text(ada.page), /didn't register\. Nothing was shared/, bad);
  }
  await ada.context.close();
});
