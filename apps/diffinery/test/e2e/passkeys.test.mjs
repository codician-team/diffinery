// End-to-end passkey sign-in: a real `wrangler dev` Worker and a real Chromium
// with a virtual WebAuthn authenticator (Chrome DevTools Protocol).
//
//   pnpm --filter @diffinery/app e2e
//
// Covers: signed-out redirects, joining from an invite link with a new passkey
// (only from the emailed copy, which proves the address; the invite also applies
// its org membership), adding and removing
// passkeys, signing out and back in, admin-issued one-time sign-in links (which sign out the account's
// other browsers but leave its tokens),
// single-use invites and links, and refusing cross-site and token-driven calls.
// Open sign-up (SIGNUP=open) runs on a second Worker: an emailed code, then a
// passkey, and the sign-up pages answering 404 while it is off.
import "./fresh-connections.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "diffinery-passkeys-"));
let base;
let dev;
let devLog = "";
let browser;

const INVITE = "invite-token-for-pal-0123456789abcdef";
const ADMIN_LINK = "signin-link-for-boss-0123456789abcdef";
/** boss is also signed in on another browser (say, a lost laptop), and has an access token. */
const BOSS_OTHER = "boss-other-browser-0123456789abcdef";
const BOSS_TOKEN = "dfy_boss_token_0123456789abcdef";
/** clio is signed in on one browser, recently enough to approve CLI sign-ins. */
const CLIO_SESSION = "clio-browser-session-0123456789abcdef";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const MASTER_KEY = randomBytes(32).toString("base64");
/** The proof only the invitation email carries (src/auth/invite-proof.ts). */
const proofFor = (token) => createHmac("sha256", `diffinery-invite-proof-v1:${MASTER_KEY}`).update(hash(token)).digest("base64url");

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

/** A fresh browser profile with its own virtual platform authenticator (Touch ID-like, user-verifying). */
async function person() {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const addAuthenticator = async () =>
    (
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
      })
    ).authenticatorId;
  let authenticatorId = await addAuthenticator();
  return {
    context,
    page,
    /** Swap in a new, empty authenticator (another device). */
    async newDevice() {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
      authenticatorId = await addAuthenticator();
    },
    async credentials() {
      return (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
    },
  };
}

const text = async (page) => (await page.textContent("main")) ?? "";

before(async () => {
  const port = await freePort();
  // WebAuthn needs a secure context and a domain RP ID: localhost qualifies, 127.0.0.1 does not.
  base = `http://localhost:${port}`;
  const persist = join(work, "state");
  const wrangler = (...args) => execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });
  migratedState(APP, persist);
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 86400_000).toISOString();
  wrangler(
    "d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--command",
    [
      `INSERT INTO accounts (id, login, kind, name, email, status, site_admin, created_at) VALUES ('boss1', 'boss', 'user', 'The Boss', 'boss@example.com', 'active', 1, '${at}')`,
      `INSERT INTO accounts (id, login, kind, name, status, created_at) VALUES ('crew1', 'crew', 'org', 'Crew', 'active', '${at}')`,
      `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('crew1', 'boss1', 'owner', '${at}')`,
      `INSERT INTO invites (id, org_id, email, role, token_hash, invited_by, created_at, expires_at) VALUES ('inv1', 'crew1', 'pal@example.com', 'member', '${hash(INVITE)}', 'boss1', '${at}', '${later}')`,
      `INSERT INTO signin_links (id, token_hash, account_id, created_by, created_at, expires_at) VALUES ('link1', '${hash(ADMIN_LINK)}', 'boss1', 'boss1', '${at}', '${later}')`,
      `INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(BOSS_OTHER)}', 'boss1', 'passkey', '${at}', '${at}', '${later}')`,
      `INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('tboss', 'boss1', 'e2e', '${hash(BOSS_TOKEN)}', '${BOSS_TOKEN.slice(0, 10)}', '["admin"]', '${later}', '${at}')`,
      `INSERT INTO accounts (id, login, kind, name, email, status, created_at) VALUES ('clio1', 'clio', 'user', 'Clio', 'clio@example.com', 'active', '${at}')`,
      `INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(CLIO_SESSION)}', 'clio1', 'passkey', '${at}', '${at}', '${later}')`,
    ].join("; "),
  );
  dev = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${base}`, "--var", "DEV_AUTH:", "--var", `MASTER_KEY:${MASTER_KEY}`, "--var", "BOOTSTRAP_ADMINS:pal", "--show-interactive-dev-session=false"],
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
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  }
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
});

test("passkey sign-in, invites and sign-in links", async () => {
  // ------------------------------------------------------------ signed out
  const pal = await person();
  const { page } = pal;
  await page.goto(`${base}/settings`);
  assert.equal(new URL(page.url()).pathname, "/login");
  assert.equal(new URL(page.url()).searchParams.get("next"), "/settings");
  assert.match(await text(page), /Sign in with a passkey/);

  // A passkey nobody registered is refused.
  await page.click("text=Sign in with a passkey");
  await page.waitForSelector("[data-passkey-msg]:not([hidden])");
  assert.match(await page.textContent("[data-passkey-msg]"), /passkey|cancelled|closed/i);

  // ------------------------------------------------------------ join from an invite link
  // The bare link (what the inviter sees) creates nothing: it offers to email the address.
  await page.goto(`${base}/invite/${INVITE}`);
  assert.match(await text(page), /Confirm your email/);
  assert.equal(await page.locator("#login").count(), 0);
  const options = (body) => fetch(`${base}/auth/passkey/register/options`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const proof of [undefined, "", "forged", proofFor("another-invite")]) {
    const r = await options({ invite: INVITE, login: "pal", proof });
    assert.equal(r.status, 403, `proof ${proof}`);
    assert.match((await r.json()).message, /invitation email sent to pal@example\.com/);
  }
  await Promise.all([page.waitForLoadState("load"), page.click("text=Email me the link")]);
  assert.match(await text(page), /We emailed the link to pal@example\.com/);
  // The emailed link carries the proof in its fragment, which the page posts (so it never reaches a request log).
  await Promise.all([page.waitForURL(`${base}/invite/${INVITE}/proof`), page.goto(`${base}/invite/${INVITE}#proof=${proofFor(INVITE)}`)]);
  await page.waitForSelector("text=invited as pal@example.com");
  assert.match(await text(page), /invited as pal@example\.com/);
  await page.fill("#login", "pal");
  await page.fill("#name", "Pal Friend");
  // New people land in the organization they were invited to.
  await Promise.all([page.waitForURL(`${base}/crew`), page.click("text=Create a passkey and join")]);
  assert.match(await text(page), /Welcome to Diffinery, pal/);
  assert.equal((await pal.credentials()).length, 1);
  const cookies = await pal.context.cookies(base);
  const session = cookies.find((c) => c.name === "__Host-dfy_session");
  assert.ok(session, `session cookie missing: ${JSON.stringify(cookies.map((c) => c.name))}`);
  assert.equal(session.httpOnly, true);
  assert.equal(session.sameSite, "Lax");
  // The invite's org membership was applied.
  await page.goto(`${base}/settings/orgs`);
  assert.match(await text(page), /crew/);
  // Picking a login that is on BOOTSTRAP_ADMINS doesn't make anyone a site administrator: only a verified email does.
  await page.goto(`${base}/api/v3/user`);
  assert.equal(JSON.parse(await page.textContent("body")).site_admin, false);

  // Invites work once.
  const stranger = await person();
  const reused = await stranger.page.goto(`${base}/invite/${INVITE}`);
  assert.equal(reused.status(), 404);

  // ------------------------------------------------------------ manage passkeys
  await page.goto(`${base}/settings/security`);
  let body = await text(page);
  assert.match(body, /Passkeys and sessions/);
  assert.match(body, /this browser/);
  assert.match(body, /Only passkey/);
  await pal.newDevice();
  await page.fill("#pklabel", "Laptop");
  await Promise.all([page.waitForLoadState("load"), page.click("button:has-text('Add a passkey')")]);
  await page.waitForSelector("text=Passkey \"Laptop\" added.");
  body = await text(page);
  assert.match(body, /Laptop/);
  assert.equal(await page.locator("button:has-text('Remove')").count(), 2);
  // Remove the first device's passkey (the one this browser no longer holds). This browser stays signed in.
  await Promise.all([page.waitForURL(`${base}/settings/security`), page.locator("li:not(:has-text('Laptop')) button:has-text('Remove')").first().click()]);
  await page.waitForSelector("text=Passkey removed.");
  body = await text(page);
  assert.match(body, /Only passkey/);
  assert.match(body, /Laptop/);

  // ------------------------------------------------------------ sign out, then in with the remaining passkey
  await Promise.all([page.waitForURL(/\/login$/), page.click("header button:has-text('Sign out')")]);
  await page.goto(`${base}/settings`);
  assert.equal(new URL(page.url()).pathname, "/login");
  await page.goto(`${base}/login?next=/settings/security`);
  await Promise.all([page.waitForURL(`${base}/settings/security`), page.click("text=Sign in with a passkey")]);
  assert.match(await text(page), /Laptop/);

  // ------------------------------------------------------------ admin sign-in links
  const boss = await person();
  const whoAmI = (headers) => fetch(`${base}/api/v3/user`, { headers });
  assert.equal((await whoAmI({ cookie: `__Host-dfy_session=${BOSS_OTHER}` })).status, 200);
  await boss.page.goto(`${base}/signin/${ADMIN_LINK}`);
  assert.match(await text(boss.page), /add a passkey to boss/);
  assert.match(await text(boss.page), /signs out every other browser signed in to this account/);
  await Promise.all([boss.page.waitForURL(`${base}/settings/security`), boss.page.click("button:has-text('Create a passkey')")]);
  assert.match(await text(boss.page), /Use it to sign in from now on/);
  // A sign-in link is account recovery: boss's other browser is signed out, the access token keeps working.
  assert.match(await text(boss.page), /Every other browser signed in to your account was signed out; your access tokens keep working/);
  assert.equal((await whoAmI({ cookie: `__Host-dfy_session=${BOSS_OTHER}` })).status, 401);
  assert.equal((await whoAmI({ authorization: `Bearer ${BOSS_TOKEN}` })).status, 200);
  await boss.page.goto(`${base}/settings/security`);
  assert.equal(await boss.page.locator("text=this browser").count(), 1);
  assert.equal(await boss.page.locator("button:has-text('Sign out everywhere else')").count(), 0);
  const usedLink = await stranger.page.goto(`${base}/signin/${ADMIN_LINK}`);
  assert.equal(usedLink.status(), 404);

  // The admin issues a link for pal (say pal lost the laptop), and pal uses it on a new device.
  await boss.page.goto(`${base}/settings/admin`);
  await Promise.all([boss.page.waitForLoadState("load"), boss.page.locator("tr:has-text('pal@example.com') button:has-text('Sign-in link')").click()]);
  await boss.page.waitForSelector("text=Sign-in link for pal");
  const link = (await boss.page.textContent(".secret")).trim();
  // The token is in the fragment: browsers never send it, so no request log holds it.
  assert.match(link, new RegExp(`^${base}/signin#[A-Za-z0-9_-]{20,}$`));
  await pal.newDevice();
  await page.goto(link);
  await page.waitForSelector("text=add a passkey to pal");
  assert.equal(page.url(), `${base}/signin`, "the page takes the token out of the address bar");
  await Promise.all([page.waitForURL(`${base}/settings/security`), page.click("button:has-text('Create a passkey')")]);
  assert.equal(await page.locator("button:has-text('Remove')").count(), 2);

  // ------------------------------------------------------------ refused requests
  const cross = await fetch(`${base}/auth/passkey/register/options`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" }, body: "{}" });
  assert.equal(cross.status, 403);
  const form = await fetch(`${base}/auth/passkey/login/verify`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=b" });
  assert.equal(form.status, 415);
  const noChallenge = await fetch(`${base}/auth/passkey/login/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response: { id: "x" } }) });
  assert.equal(noChallenge.status, 400);
  const anonymous = await fetch(`${base}/auth/passkey/register/options`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(anonymous.status, 401);

  // ------------------------------------------------------------ Kumo form controls
  // Every select, checkbox and radio is a Kumo component; the forms still post plain fields.
  const nativeControls = (p) => p.locator("select:not([aria-hidden]), input[type=checkbox]:not([aria-hidden]), input[type=radio]:not([aria-hidden])").count();
  await page.goto(`${base}/new`);
  await page.waitForSelector(".dfy-k[data-mounted]");
  assert.equal(await nativeControls(page), 0);
  await page.fill("#name", "kumo");
  await page.getByRole("radio", { name: /Public/ }).click();
  await Promise.all([page.waitForURL(`${base}/pal/kumo`), page.click("button:has-text('Create repository')")]);
  await page.goto(`${base}/pal/kumo/settings`);
  await page.waitForSelector(".dfy-k[data-mounted]");
  assert.equal(await page.locator("input[type=hidden][name=visibility]").getAttribute("value"), "public");
  assert.equal(await page.getByRole("radio", { name: "Public" }).getAttribute("aria-checked"), "true");
  await page.goto(`${base}/settings/tokens`);
  await page.fill("#tname", "kumo");
  await page.click("#repos");
  await page.getByRole("option", { name: "pal/kumo" }).click();
  await page.keyboard.press("Escape");
  await Promise.all([page.waitForLoadState("load"), page.click("button:has-text('Create token')")]);
  await page.waitForSelector("text=pal/kumo");
  assert.equal(await nativeControls(page), 0);
  await boss.page.goto(`${base}/settings/admin`);
  await boss.page.waitForSelector(".dfy-k[data-mounted]");
  assert.equal(await nativeControls(boss.page), 0);
  const kumo = await fetch(`${base}${await page.locator("script[src^='/-/kumo/']").getAttribute("src")}`);
  assert.equal(kumo.status, 200);
  assert.match(kumo.headers.get("cache-control") ?? "", /immutable/);

  // ------------------------------------------------------------ Add people: one form for usernames and emails
  await boss.page.goto(`${base}/crew?tab=people`);
  await boss.page.fill("#who", "pal");
  await Promise.all([boss.page.waitForLoadState("load"), boss.page.click("form:has(#who) button:has-text('Add')")]);
  assert.match(await text(boss.page), /pal is already a member of crew/);
  await boss.page.fill("#who", "newbie@example.com");
  await Promise.all([boss.page.waitForLoadState("load"), boss.page.click("form:has(#who) button:has-text('Add')")]);
  assert.match(await text(boss.page), /Invitation sent to newbie@example\.com/);
  assert.match(await boss.page.textContent(".secret"), new RegExp(`^${base}/invite/`));
  await boss.page.goto(`${base}/crew?tab=people`);
  assert.match(await text(boss.page), /Pending invitations/);
  await Promise.all([boss.page.waitForLoadState("load"), boss.page.click("tr:has-text('newbie@example.com') button:has-text('Revoke')")]);
  assert.match(await text(boss.page), /Invitation revoked/);
  assert.doesNotMatch(await text(boss.page), /newbie@example\.com/);
  // An existing account is invited by username, hears about it on Diffinery, and joins once they accept.
  await page.goto(`${base}/settings/orgs`);
  await Promise.all([page.waitForLoadState("load"), page.fill("#olog", "palorg")]);
  await Promise.all([page.waitForURL(/\/palorg/), page.click("button:has-text('Create organization')")]);
  await page.fill("#who", "boss");
  await Promise.all([page.waitForLoadState("load"), page.click("form:has(#who) button:has-text('Add')")]);
  assert.match(await text(page), /Invited boss to palorg as member\. They join once they accept/);
  assert.match(await text(page), /@boss/);
  await boss.page.goto(`${base}/notifications`);
  assert.match(await text(boss.page), /pal invited you to palorg as member/);
  await boss.page.goto(`${base}/settings/invitations`);
  assert.match(await text(boss.page), /palorg/);
  await Promise.all([boss.page.waitForURL(/\/palorg$/), boss.page.click("li:has-text('palorg') button:has-text('Accept')")]);
  await page.goto(`${base}/palorg?tab=people`);
  assert.match(await page.textContent("tr:has-text('boss')"), /Member/);
  // The last owner can't step down: the organization would have nobody to manage it.
  await page.goto(`${base}/palorg?tab=people`);
  await Promise.all([
    page.waitForLoadState("load"),
    page.evaluate(() => {
      const csrf = document.querySelector("form input[type=hidden]");
      const f = document.createElement("form");
      f.method = "post";
      f.action = "/palorg/-/org/members";
      for (const [k, v] of [[csrf.name, csrf.value], ["login", "pal"], ["role", "member"]]) f.append(Object.assign(document.createElement("input"), { type: "hidden", name: k, value: v }));
      document.body.append(f);
      f.submit();
    }),
  ]);
  assert.match(await text(page), /needs at least one owner/);
  await page.goto(`${base}/palorg?tab=people`);
  assert.match(await page.textContent("tr:has-text('pal')"), /Owner/);

  // ------------------------------------------------------------ Appearance
  await page.goto(`${base}/settings/appearance`);
  await page.waitForSelector(".dfy-k[data-mounted]");
  await page.getByRole("radio", { name: /Dark/ }).click();
  await Promise.all([page.waitForLoadState("load"), page.click("button:has-text('Save appearance')")]);
  assert.equal(await page.getAttribute("html", "data-theme"), "dark");
  assert.equal(await page.getAttribute("html", "data-mode"), "dark");
  await page.goto(`${base}/`);
  assert.equal(await page.getAttribute("html", "data-theme"), "dark");
  await page.goto(`${base}/settings/appearance`);
  await page.waitForSelector(".dfy-k[data-mounted]");
  await page.getByRole("radio", { name: /Sync with system/ }).click();
  await Promise.all([page.waitForLoadState("load"), page.click("button:has-text('Save appearance')")]);
  assert.equal(await page.getAttribute("html", "data-theme"), null);

  // Screenshots for review (kept with E2E_KEEP=1).
  if (process.env.E2E_SCREENSHOTS) {
    const out = process.env.E2E_SCREENSHOTS;
    await stranger.page.goto(`${base}/login`);
    await stranger.page.screenshot({ path: join(out, "login.png"), fullPage: true });
    await page.goto(`${base}/settings/security`);
    await page.screenshot({ path: join(out, "security.png"), fullPage: true });
    await boss.page.goto(`${base}/settings/admin`);
    await boss.page.screenshot({ path: join(out, "admin.png"), fullPage: true });
  }
});

/** Runs the installed CLI; `lines` sees its stderr as it arrives (the sign-in link or code). */
function cli(bin, args, env, lines = () => {}) {
  const child = spawn(bin, args, { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => {
    err += d;
    lines(err);
  });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out, err })));
}

test("CLI: one-line install, then sign-in in the browser and with a device code", async () => {
  // ------------------------------------------------------------ install from this server
  const home = join(work, "cli-home");
  execFileSync("mkdir", ["-p", home]);
  const installed = execFileSync("bash", ["-c", `curl -fsSL ${base}/install | bash`], { env: { PATH: process.env.PATH, HOME: home, SHELL: "/bin/bash" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(installed, "");
  const bin = join(home, ".diffinery/bin/diffinery");
  assert.match(execFileSync(bin, ["--version"], { encoding: "utf8" }), /^diffinery \d+\.\d+\.\d+/);
  assert.match(readFileSync(join(home, ".bashrc"), "utf8"), /\.diffinery\/bin/);
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), BROWSER: "none" };

  const clio = await person();
  // Signed in already (the seeded session): Chrome treats localhost as secure, so a __Host- cookie works over http here.
  await clio.page.goto(`${base}/login`);
  await clio.page.evaluate((v) => (document.cookie = `__Host-dfy_session=${v}; path=/; secure; samesite=lax`), CLIO_SESSION);

  // ------------------------------------------------------------ browser sign-in: the person clicks Authorize
  let link;
  const login = cli(bin, ["login", "--url", base, "--web"], env, (err) => (link ??= /(http:\/\/localhost:\d+\/login\/cli\?\S+)/.exec(err)?.[1]));
  await until("the sign-in link", async () => link);
  await clio.page.goto(link);
  assert.match(await text(clio.page), /Authorize the Diffinery CLI/);
  assert.match(await text(clio.page), /client wants to sign in as clio/);
  if (process.env.E2E_SCREENSHOTS) await clio.page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, "cli-authorize.png"), fullPage: true });
  await Promise.all([clio.page.waitForURL(`${base}/login/cli/done?result=ok`), clio.page.click("button:has-text('Authorize')")]);
  assert.match(await text(clio.page), /You're signed in/);
  const done = await login;
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /Logged in to .* as clio with write access/);
  assert.doesNotMatch(done.out + done.err, /dfy_/);
  assert.match((await cli(bin, ["whoami"], env)).out, /^clio/);
  await clio.page.goto(`${base}/settings/tokens`);
  assert.match(await text(clio.page), /Diffinery CLI on .*CLI sign-in/);

  // ------------------------------------------------------------ device sign-in: the person types the code
  const env2 = { ...env, XDG_CONFIG_HOME: join(home, ".config2") };
  let code;
  const device = cli(bin, ["login", "--url", base, "--device", "--scope", "read"], env2, (err) => (code ??= /code: ([A-Z]{4}-[A-Z]{4})/.exec(err)?.[1]));
  await until("the device code", async () => code);
  await clio.page.goto(`${base}/login/device`);
  await clio.page.fill("#code", code.toLowerCase());
  await Promise.all([clio.page.waitForLoadState("load"), clio.page.click("button:has-text('Continue')")]);
  assert.match(await text(clio.page), new RegExp(`your terminal shows this code: ${code}`));
  if (process.env.E2E_SCREENSHOTS) await clio.page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, "cli-device.png"), fullPage: true });
  await Promise.all([clio.page.waitForLoadState("load"), clio.page.click("button:has-text('Authorize')")]);
  const viaDevice = await device;
  assert.equal(viaDevice.code, 0, viaDevice.err);
  assert.match(viaDevice.out, /as clio with read access/);

  // ------------------------------------------------------------ logout revokes the CLI's token
  const token = JSON.parse(readFileSync(join(home, ".config2/diffinery/config.json"), "utf8")).token;
  const out = await cli(bin, ["logout"], env2);
  assert.match(out.out, /revoked the CLI's token/);
  assert.equal((await fetch(`${base}/api/v3/user`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
});

test("open sign-up: off by default; on, an emailed code, then a passkey", async () => {
  // ------------------------------------------------------------ off (this file's Worker has no SIGNUP)
  // The sign-up page leads to the early access request instead; everything else under /signup is 404.
  const toEarly = await fetch(`${base}/signup`, { redirect: "manual" });
  assert.equal(toEarly.status, 302);
  assert.equal(toEarly.headers.get("location"), "/early-access");
  assert.equal((await fetch(`${base}/signup/verify`)).status, 404);
  for (const path of ["/signup", "/signup/verify"]) {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=a%40example.com&code=123456" });
    assert.equal(r.status, 404, path);
  }
  const closed = await (await fetch(`${base}/login`)).text();
  assert.match(closed, /Diffinery is invite-only/);
  assert.doesNotMatch(closed, /href="\/signup"/);

  // ------------------------------------------------------------ on: a second Worker with SIGNUP=open
  // It keeps env.dev's DEV_AUTH, so emails are kept whole (for reading the code) and its dev account
  // (dev@diffinery.local, a site admin) can list them. Without Turnstile keys, localhost skips the check.
  const port = await freePort();
  const site = `http://localhost:${port}`;
  const persist = join(work, "signup-state");
  migratedState(APP, persist);
  const open = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${site}`, "--var", `MASTER_KEY:${MASTER_KEY}`, "--var", "SIGNUP:open", "--show-interactive-dev-session=false"],
    { cwd: APP, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  open.stdout.on("data", (d) => (devLog += d));
  open.stderr.on("data", (d) => (devLog += d));
  try {
    await until("wrangler dev with SIGNUP=open", async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
      } catch {
        return false;
      }
    }, 120_000);
    const minted = await fetch(`${site}/api/v3/diffinery/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "signup-e2e", scopes: ["admin"] }) });
    assert.equal(minted.status, 201, await minted.clone().text());
    const adminToken = (await minted.json()).token;
    /** Every email the Worker sent, newest first, with the whole message. */
    const emails = async () => {
      const r = await fetch(`${site}/api/v3/diffinery/emails?all=1&per_page=200`, { headers: { authorization: `Bearer ${adminToken}` } });
      assert.equal(r.status, 200);
      return r.json();
    };
    const email = (what, pred) => until(`email: ${what}`, async () => (await emails()).find(pred));

    const newbie = await person();
    const { page } = newbie;
    await page.goto(`${site}/login`);
    assert.match(await text(page), /New here\? Create an account/);
    await Promise.all([page.waitForURL(`${site}/signup`), page.click("text=Create an account")]);
    assert.match(await text(page), /We'll send you a code/);
    assert.equal(await page.locator("select, input[type=checkbox]").count(), 0);
    await page.fill("#email", "Newbie@Example.com");
    await Promise.all([page.waitForLoadState("load"), page.click("button:has-text('Email me a code')")]);
    assert.match(await text(page), /We sent a code to newbie@example\.com/);
    const sent = await email("sign-up code", (e) => e.kind === "signup_code" && e.to_addr === "newbie@example.com");
    assert.doesNotMatch(sent.subject, /\d{6}/);
    const code = /^ {4}(\d{6})$/m.exec(sent.dev_copy.text)?.[1];
    assert.ok(code, sent.dev_copy.text);

    // A wrong code is refused and counted.
    const other = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    await page.fill("#code", other);
    const [refused] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/signup/verify")), page.click("button:has-text('Continue')")]);
    assert.equal(refused.status(), 400);
    assert.match(await text(page), /That code is wrong\. You can try 4 more times\./);

    // The right one leads to the passkey step, bound to a single-use ticket.
    await page.fill("#code", code);
    await Promise.all([page.waitForLoadState("load"), page.click("button:has-text('Continue')")]);
    assert.match(await text(page), /newbie@example\.com is confirmed/);
    const ticket = await page.inputValue("input[name=signup]");
    assert.equal(await page.inputValue("#login"), "newbie");
    await page.fill("#login", "newbie");
    await page.fill("#name", "New Person");
    await Promise.all([page.waitForURL(`${site}/`), page.click("text=Create a passkey and join")]);
    assert.match(await text(page), /Welcome to Diffinery, newbie/);
    assert.doesNotMatch(await text(page), /Waiting for an invite/);
    assert.equal((await newbie.credentials()).length, 1);
    await page.goto(`${site}/api/v3/user`);
    const me = JSON.parse(await page.textContent("body"));
    assert.equal(me.login, "newbie");
    assert.equal(me.site_admin, false);
    await page.goto(`${site}/new`);
    assert.match(await text(page), /Create a new repository|Repository name/);
    await email("welcome", (e) => e.kind === "welcome" && e.to_addr === "newbie@example.com");
    // The ticket and the code worked once.
    const again = await fetch(`${site}/auth/passkey/register/options`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signup: ticket, login: "newbie2" }) });
    assert.equal(again.status, 404);

    // The audit log records the sign-up (this browser is the dev site admin).
    const stranger = await person();
    await stranger.page.goto(`${site}/settings/audit`);
    assert.ok(await stranger.page.locator("tr:has-text('newbie') .badge:text-is('signup')").count());

    // ------------------------------------------------------------ an address with an account
    // Same page as for a new address; its owner gets a note instead of a code.
    await stranger.page.goto(`${site}/signup`);
    await stranger.page.fill("#email", "dev@diffinery.local");
    await Promise.all([stranger.page.waitForLoadState("load"), stranger.page.click("button:has-text('Email me a code')")]);
    assert.match(await text(stranger.page), /We sent a code to dev@diffinery\.local/);
    const note = await email("someone tried to sign up", (e) => e.kind === "signup_attempt");
    assert.equal(note.to_addr, "dev@diffinery.local");
    assert.match(note.dev_copy.text, /already belongs to your account/);
    assert.doesNotMatch(note.dev_copy.text, /^ {4}\d{6}$/m);
    assert.equal((await emails()).filter((e) => e.kind === "signup_code" && e.to_addr === "dev@diffinery.local").length, 0);
    // A guess there answers like any wrong code.
    await stranger.page.fill("#code", "000000");
    const [guess] = await Promise.all([stranger.page.waitForResponse((r) => r.url().endsWith("/signup/verify")), stranger.page.click("button:has-text('Continue')")]);
    assert.equal(guess.status(), 400);

    // ------------------------------------------------------------ at most 5 codes a day for an address
    await stranger.page.goto(`${site}/signup`);
    const csrf = await stranger.page.inputValue("input[name=_csrf]");
    const ask = () => stranger.page.request.post(`${site}/signup`, { form: { _csrf: csrf, email: "limit@example.com" }, maxRedirects: 0 });
    for (let i = 0; i < 5; i++) {
      const r = await ask();
      assert.equal(r.status(), 200, `request ${i + 1}`);
      assert.match(await r.text(), /We sent a code to <b>limit@example\.com<\/b>/);
    }
    const limited = await ask();
    assert.equal(limited.status(), 429);
    assert.match(await limited.text(), /We have sent several codes to limit@example\.com today/);
  } finally {
    try {
      process.kill(-open.pid, "SIGTERM");
    } catch {}
  }
});

test("favicons, robots.txt, sitemap and search metadata", async () => {
  const get = (p) => fetch(`${base}${p}`, { redirect: "manual" });
  const ico = await get("/favicon.ico");
  assert.equal(ico.status, 200);
  assert.equal(ico.headers.get("content-type"), "image/x-icon");
  assert.deepEqual([...new Uint8Array(await ico.arrayBuffer()).slice(0, 4)], [0, 0, 1, 0]);
  for (const p of ["/favicon-48.png", "/favicon-96.png", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/og-image.png"]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get("content-type"), "image/png", p);
  }
  assert.match(await (await get("/favicon.svg")).text(), /^<svg/);
  assert.equal((await (await get("/site.webmanifest")).json()).icons.length, 3);
  const robots = await (await get("/robots.txt")).text();
  assert.match(robots, /^User-agent: \*\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: \//);
  assert.match(robots, new RegExp(`Sitemap: ${base}/sitemap.xml`));
  assert.match(await (await get("/sitemap.xml")).text(), new RegExp(`<loc>${base}/</loc>`));

  const home = await (await get("/")).text();
  assert.match(home, /<title>Diffinery: open-source GitHub alternative with fast CI, built for AI agents<\/title>/);
  assert.match(home, /<link rel="icon" href="\/favicon.ico"/);
  assert.match(home, /<meta property="og:image" content="[^"]+\/og-image.png"/);
  assert.match(home, /<link rel="canonical" href="[^"]+\/"/);
  assert.match(home, /application\/ld\+json/);
  assert.doesNotMatch(home, /noindex/);
  // The product and comparison pages, as HTML and as Markdown, and in the sitemap.
  const compare = await get("/compare/github");
  assert.equal(compare.status, 200);
  assert.match(await compare.text(), /<h1>Diffinery vs GitHub<\/h1>/);
  assert.match(await (await get("/compare/github.md")).text(), /^# Diffinery vs GitHub\n/);
  assert.match(await (await get("/index.md")).text(), /^# Diffinery\n/);
  assert.match(await (await get("/sitemap.xml")).text(), new RegExp(`<loc>${base}/performance</loc>`));
  const login = await (await get("/login")).text();
  assert.match(login, /<meta name="robots" content="noindex, nofollow"/);
  assert.match(login, /<link rel="icon" href="\/favicon.ico"/);
});
