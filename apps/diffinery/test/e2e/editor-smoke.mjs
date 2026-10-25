// On-demand check of the editor extension (apps/vscode) in a real VS Code or Cursor, against a real `wrangler dev`
// Worker: "Clone from Diffinery" in the clone picker, the browser sign-in through Diffinery's OAuth consent page,
// the repository list and search, and a clone of a private repository with Git asking the extension for the
// password. Not part of `pnpm e2e` (it needs a desktop editor and a display):
//
//   node apps/vscode/scripts/package.mjs --out /tmp/vsix
//   EDITOR_BIN=/path/to/VSCode-linux-x64/code EDITOR_CLI=/path/to/VSCode-linux-x64/bin/code \
//     VSIX=/tmp/vsix/diffinery-0.1.0.vsix xvfb-run -a pnpm --filter @diffinery/app exec node test/e2e/editor-smoke.mjs
//
// EDITOR_BIN is the editor's Electron binary, EDITOR_CLI its command-line tool (Cursor: usr/share/cursor/cursor and
// usr/share/cursor/bin/cursor in the extracted AppImage; Cursor also needs --skip-onboarding, which this passes last: VS Code would read the next argument as its value). SHOTS=dir
// saves screenshots of each step, plus the clone picker on its own (*-box.png, for the docs); THEME sets the color
// theme, such as "Default Light Modern", and SCALE the device scale factor.
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium, _electron } from "playwright";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EDITOR = process.env.EDITOR_BIN;
const CLI = process.env.EDITOR_CLI;
const VSIX = process.env.VSIX;
const SHOTS = process.env.SHOTS;
if (!EDITOR || !CLI || !VSIX) throw new Error("set EDITOR_BIN, EDITOR_CLI and VSIX");
const work = mkdtempSync(join(tmpdir(), "diffinery-editor-"));
const hash = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADA_SESSION = "ada-editor-session-0123456789abcdef";
const ADA_TOKEN = `dfy_${randomBytes(24).toString("hex")}`;
const CHARLES_TOKEN = `dfy_${randomBytes(24).toString("hex")}`;
let devLog = "";

async function until(what, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}\n--- wrangler log tail ---\n${devLog.slice(-3000)}`);
}
const shot = async (page, name) => SHOTS && (mkdirSync(SHOTS, { recursive: true }), await page.screenshot({ path: join(SHOTS, `${name}.png`) }));
const shotPicker = async (page, name) => SHOTS && (await page.locator(".quick-input-widget:not([style*='display: none'])").screenshot({ path: join(SHOTS, `${name}-box.png`) }));
const wrangler = (...args) => execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });

// ---------------------------------------------------------------- a local Diffinery with ada and two repositories
const port = await freePort();
const base = `http://localhost:${port}`;
const persist = join(work, "state");
const sql = (command) => wrangler("d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--command", command);
wrangler("d1", "migrations", "apply", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist);
const at = new Date().toISOString();
const later = new Date(Date.now() + 86400_000).toISOString();
sql(
  [
    `INSERT INTO accounts (id, login, kind, name, email, status, created_at) VALUES ('ada1', 'ada', 'user', 'Ada', 'ada@example.com', 'active', '${at}')`,
    `INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(ADA_SESSION)}', 'ada1', 'passkey', '${at}', '${at}', '${later}')`,
    `INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('t1', 'ada1', 'e2e', '${hash(ADA_TOKEN)}', '${ADA_TOKEN.slice(0, 10)}', '["admin"]', '${later}', '${at}')`,
    // Charles signs in with an access token he pastes, in step 0.
    `INSERT INTO accounts (id, login, kind, name, email, status, created_at) VALUES ('cb1', 'charles', 'user', 'Charles', 'charles@example.com', 'active', '${at}')`,
    `INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('t2', 'cb1', 'e2e', '${hash(CHARLES_TOKEN)}', '${CHARLES_TOKEN.slice(0, 10)}', '["write"]', '${later}', '${at}')`,
  ].join("; "),
);
const dev = spawn(
  "pnpm",
  ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${base}`, "--var", "DEV_AUTH:", "--show-interactive-dev-session=false"],
  { cwd: APP, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], detached: true },
);
dev.stdout.on("data", (d) => (devLog += d));
dev.stderr.on("data", (d) => (devLog += d));
const cleanup = () => {
  try {
    process.kill(-dev.pid, "SIGTERM");
  } catch {}
};
process.on("exit", cleanup);
await until("wrangler dev", async () => (await fetch(`${base}/healthz`).catch(() => null))?.ok, 120_000);
console.log("worker up at", base);

const api = (method, path, body) => fetch(`${base}/api/v3${path}`, { method, headers: { authorization: `Bearer ${ADA_TOKEN}`, "content-type": "application/json" }, body: body && JSON.stringify(body) }).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`${method} ${path}: ${r.status} ${await r.text()}`))));
await api("POST", "/user/repos", { name: "hello-editor", private: true, description: "The analytical engine, in TypeScript" });
await api("POST", "/user/repos", { name: "notes", private: false, description: "Notes on the engine, and drafts of the next paper" });
await fetch(`${base}/api/v3/user/repos`, { method: "POST", headers: { authorization: `Bearer ${CHARLES_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ name: "engine-drawings", private: true }) }).then((r) => assert.ok(r.ok, `charles's repository: ${r.status}`));
const seed = join(work, "seed");
mkdirSync(seed);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).toString();
git(seed, "init", "-q", "-b", "main");
writeFileSync(join(seed, "README.md"), "# hello-editor\n\nCloned from Diffinery in an editor.\n");
git(seed, "add", ".");
git(seed, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-qm", "First commit");
git(seed, "push", "-q", `http://x:${ADA_TOKEN}@localhost:${port}/ada/hello-editor.git`, "main");

// ---------------------------------------------------------------- the editor
const home = join(work, "home");
const clones = join(home, "src");
const userData = join(work, "user-data");
const exts = join(work, "extensions");
mkdirSync(clones, { recursive: true });
// Opened on a folder: Cursor shows its agent window instead of the editor until you log in to Cursor, unless a folder is open.
// The folder the editor opens: a local repository with a commit and no remote, for "Publish to Diffinery".
const workspace = join(home, "difference-engine");
mkdirSync(workspace, { recursive: true });
git(workspace, "init", "-q", "-b", "main");
writeFileSync(join(workspace, "engine.ts"), "export const add = (a: number, b: number) => a + b;\n");
git(workspace, "add", ".");
git(workspace, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-qm", "Start the engine");
mkdirSync(join(userData, "User"), { recursive: true });
// Git saves the password the editor gave it, as a keychain would; the extension keeps that copy current.
writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = store\n[user]\n\tname = Ada\n\temail = ada@example.com\n`);
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({
    "diffinery.serverUrl": base,
    "diffinery.checkForUpdates": false,
    "files.simpleDialog.enable": true,
    "git.openAfterClone": "alwaysNewWindow",
    "git.defaultCloneDirectory": clones,
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "window.dialogStyle": "custom",
    "window.titleBarStyle": "custom",
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.autoCheckUpdates": false,
    ...(process.env.THEME ? { "workbench.colorTheme": process.env.THEME } : {}),
  }),
);
// The browser the editor opens: record the URL, as a person's browser would receive it.
const opened = join(work, "opened.txt");
// Electron opens links with xdg-open on Linux, which hands them to $BROWSER when there's no desktop session.
const bin = join(work, "bin");
mkdirSync(bin);
const browserScript = join(bin, "xdg-open");
writeFileSync(browserScript, `#!/bin/sh\necho "$1" >> ${opened}\n`);
chmodSync(browserScript, 0o755);
const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, BROWSER: browserScript, XDG_CURRENT_DESKTOP: "", DONT_PROMPT_WSL_INSTALL: "1" };
// No OS keyring in a test container: the editor keeps secrets with its own weaker encryption instead.
const common = ["--user-data-dir", userData, "--extensions-dir", exts, "--no-sandbox", "--disable-gpu", "--password-store=basic", ...(process.env.SCALE ? [`--force-device-scale-factor=${process.env.SCALE}`] : [])];
execFileSync(CLI, [...common, "--install-extension", VSIX, "--force"], { env, stdio: "pipe", timeout: 120_000 });
console.log("extension installed");

const app = await _electron.launch({ executablePath: EDITOR, args: [workspace, ...common, "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--skip-onboarding"], env, timeout: 120_000 });
const win = await app.firstWindow();
// On a failure, a screenshot of the editor as it was.
async function fail(e) {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, "failed.png") }).catch(() => {});
  console.error(e);
  cleanup();
  process.exit(1);
}
process.on("unhandledRejection", fail);
process.on("uncaughtException", fail);
await win.waitForSelector(".monaco-workbench", { timeout: 120_000 });
console.log("editor window open");
await sleep(4000);
const palette = async (cmd) => {
  await win.keyboard.press("Control+Shift+P");
  await win.waitForSelector(".quick-input-widget:not([style*='display: none']) .quick-input-box input");
  await win.keyboard.type(cmd);
  // The palette filters as it's typed: run the command only once it's the one highlighted.
  await until(`"${cmd}" highlighted in the Command Palette`, async () => (await win.textContent(".quick-input-list .monaco-list-row.focused").catch(() => ""))?.includes(cmd), 10_000);
  await win.keyboard.press("Enter");
};
const quickItems = async () => (await win.$$eval(".quick-input-list .monaco-list-row", (rows) => rows.map((r) => r.textContent?.trim() ?? ""))).filter(Boolean);

// 0. Signing in with a pasted token, in a fresh editor, goes through the editor's own sign-in: the editor asks once,
// up front, and the clone picker then lists the account's repositories without asking again. Then sign out again.
await palette("Diffinery: Sign In with an Access Token");
const allowToken = await until("the sign-in prompt", async () => win.$(".monaco-dialog-box .monaco-button:has-text('Allow')"), 30_000);
await shot(win, "0-allow-token");
await allowToken.click();
await win.waitForSelector(".quick-input-widget:not([style*='display: none']) .quick-input-box input");
await sleep(300);
await win.fill(".quick-input-widget:not([style*='display: none']) .quick-input-box input", CHARLES_TOKEN);
await win.keyboard.press("Enter");
await until("the signed-in notice", async () => (await win.textContent(".notifications-toasts").catch(() => ""))?.includes("Signed in to Diffinery as charles"), 30_000);
await palette("Git: Clone");
await until("Clone from Diffinery in the picker", async () => (await quickItems()).some((t) => t.includes("Clone from Diffinery")), 30_000);
await win.keyboard.type("Clone from Diffinery");
await sleep(300);
await win.keyboard.press("Enter");
await until("charles's repositories", async () => {
  if (await win.$(".monaco-dialog-box")) throw new Error("the editor asked again to allow the sign-in");
  return (await quickItems()).some((t) => t.startsWith("charles/engine-drawings"));
}, 30_000);
await win.keyboard.press("Escape");
console.log("token sign-in: charles's repositories listed, no second prompt");
await sleep(500);
await palette("Diffinery: Sign Out");
await until("the signed-out notice", async () => (await win.textContent(".notifications-toasts").catch(() => ""))?.includes("Signed out of Diffinery"), 20_000);
await win.keyboard.press("Escape");

// 1. The clone picker lists Diffinery as a remote source.
await palette("Git: Clone");
await until("Clone from Diffinery in the picker", async () => (await quickItems()).some((t) => t.includes("Clone from Diffinery")), 30_000);
console.log("clone picker:", await quickItems());
if (process.env.DEBUG_ICON)
  console.log(
    await win.evaluate(async () => {
      const el = document.querySelector(".codicon-diffinery-logo");
      const st = el && getComputedStyle(el, "::before");
      return { content: st?.content, font: st?.fontFamily, fonts: [...document.fonts].map((f) => `${f.family} ${f.status}`).filter((f) => !/codicon|Segoe/.test(f)) };
    }),
  );
await shot(win, "1-clone-picker");
await shotPicker(win, "1-clone-picker");
await win.keyboard.type("Clone from Diffinery");
await sleep(300);
await win.keyboard.press("Enter");

// 2. Signing in: the editor asks to allow the sign-in, then opens Diffinery's consent page in the browser.
const allow = await until("the sign-in prompt", async () => (await win.$("dialog, .monaco-dialog-box")) && win.$(".monaco-dialog-box .monaco-button:has-text('Allow')"), 30_000);
await shot(win, "2-allow-sign-in");
await allow.click();
const authorize = await until("the editor to open the browser", async () => existsSync(opened) && readFileSync(opened, "utf8").trim().split("\n").pop(), 30_000);
const au = new URL(authorize);
assert.equal(au.origin + au.pathname, `${base}/oauth/authorize`);
assert.equal(au.searchParams.get("client_id"), `${base}/oauth/clients/editor.json`);
const redirect = new URL(au.searchParams.get("redirect_uri"));
// The extension listens on 127.0.0.1 for the browser's answer (no prompts on the way back to the editor).
assert.equal(redirect.origin, `http://127.0.0.1:${redirect.port}`);
assert.equal(redirect.pathname, "/callback");
console.log("authorize:", authorize);

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${base}/login`);
await page.evaluate((v) => (document.cookie = `__Host-dfy_session=${v}; path=/; secure; samesite=lax`), ADA_SESSION);
await page.goto(authorize);
const consent = ((await page.textContent("main")) ?? "").replace(/\s+/g, " ");
assert.match(consent, /Connect Diffinery extension for VS Code and Cursor to Diffinery/);
assert.match(consent, /published by localhost/);
assert.match(consent, /Sends you back to\s*an app on this computer/);
if (SHOTS) await page.screenshot({ path: join(SHOTS, "3-consent.png"), fullPage: true });
await page.click('button[value="approve"]');
await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/callback/);
assert.match(await page.textContent("body"), /You're signed in to Diffinery/);
if (SHOTS) await page.screenshot({ path: join(SHOTS, "3b-signed-in.png") });
console.log("browser: signed in page shown");
// The repository page offers the editors' own clone links.
await page.goto(`${base}/ada/hello-editor`);
const cloneUrl = encodeURIComponent(`${base}/ada/hello-editor.git`);
for (const scheme of ["vscode", "cursor", "windsurf"]) assert.ok(await page.$(`a[href="${scheme}://vscode.git/clone?url=${cloneUrl}"]`), `Open in ${scheme} link`);
assert.ok(await page.$(`a[href^="jetbrains://idea/checkout/git?"]`), "Open in IntelliJ IDEA link");
if (SHOTS) await page.screenshot({ path: join(SHOTS, "3c-repo-page.png"), fullPage: true });
console.log("repository page: Open in VS Code, Cursor, Windsurf and IntelliJ IDEA links");
await browser.close();

// 3. Signed in: the picker lists ada's repositories; search narrows it.
await until("ada's repositories in the picker", async () => (await quickItems()).some((t) => t.includes("ada/hello-editor")), 60_000);
console.log("repositories:", await quickItems());
await shot(win, "4-repositories");
await shotPicker(win, "4-repositories");
await win.keyboard.type("hello");
await until("the search result", async () => {
  const items = await quickItems();
  return items.length === 1 && items[0].includes("ada/hello-editor");
}, 20_000);
await shot(win, "5-search");
await win.keyboard.press("Enter");

// 4. Choosing where to clone (the editor's own folder dialog), then Git clones with the extension's password.
const destination = win.getByText("Select as Repository Destination", { exact: true });
await destination.waitFor({ timeout: 30_000 });
await sleep(500);
await shot(win, "6-folder");
await destination.click();
const clonedReadme = join(clones, "hello-editor", "README.md");
await until("the clone on disk", async () => existsSync(clonedReadme), 90_000).catch(async (e) => {
  await shot(win, "6b-folder-stuck");
  throw e;
});
assert.match(readFileSync(clonedReadme, "utf8"), /Cloned from Diffinery/);
console.log("cloned:", clonedReadme);
const stored = readFileSync(join(home, ".git-credentials"), "utf8");
assert.match(stored, new RegExp(`^http://ada:dfy_[^@]+@localhost%3a${port}$|^http://ada:dfy_[^@]+@localhost:${port}$`, "m"));
assert.ok(!stored.includes(ADA_TOKEN), "the saved credential is the editor's own token");
console.log("git credential saved for ada");
await sleep(4000);
const cloneWin = app.windows().at(-1);
await cloneWin.waitForSelector(".monaco-workbench", { timeout: 60_000 });
await sleep(3000);
await shot(cloneWin, "7-opened");

// 5. Publishing the open folder: Git's "Publish Branch" offers Diffinery, which creates the repository and pushes.
await palette("Git: Publish Branch");
await until("Publish to Diffinery in the picker", async () => (await quickItems()).some((t) => t.includes("Publish to Diffinery")), 30_000);
console.log("publish picker:", await quickItems());
await win.keyboard.type("Diffinery");
await sleep(300);
await win.keyboard.press("Enter");
await until("the repository name box", async () => (await win.inputValue(".quick-input-widget:not([style*='display: none']) .quick-input-box input").catch(() => "")) === "difference-engine", 30_000);
await shot(win, "8-publish-name");
await win.keyboard.press("Enter");
await until("the visibility choice", async () => (await quickItems()).some((t) => t.includes("Private")), 20_000);
await win.keyboard.press("Enter");
const published = await until("the pushed branch on Diffinery", async () => (await api("GET", "/repos/ada/difference-engine/branches").catch(() => null))?.find((b) => b.name === "main"), 60_000);
assert.equal(published.commit.sha, git(workspace, "rev-parse", "HEAD").trim());
assert.equal((await api("GET", "/repos/ada/difference-engine")).private, true);
assert.match(git(workspace, "remote", "get-url", "origin"), /\/ada\/difference-engine\.git/);
await shot(win, "9-published");
console.log("published: ada/difference-engine, private, main pushed");

// 6. Signing out removes Git's saved copy and disconnects the editor on the server.
await palette("Diffinery: Sign Out");
await until("the saved credential to go", async () => !readFileSync(join(home, ".git-credentials"), "utf8").includes("ada:"), 20_000);
const grants = JSON.parse(wrangler("d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--json", "--command", "SELECT revoked_at FROM oauth_grants").toString())[0].results;
assert.ok(grants.length === 1 && grants[0].revoked_at, "the connection is revoked");
console.log("signed out: credential removed, connection revoked");

await app.close();
cleanup();
if (process.env.KEEP !== "1") rmSync(work, { recursive: true, force: true });
console.log("editor smoke test passed");
process.exit(0);
