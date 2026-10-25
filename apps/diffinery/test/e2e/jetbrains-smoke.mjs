// On-demand check of the JetBrains plugin (apps/jetbrains) in a real IntelliJ IDEA, against a real `wrangler dev`
// Worker: "Diffinery" in Get from Version Control, the browser sign-in through Diffinery's OAuth consent page, the
// repository list and search, a clone of a private repository with Git asking the plugin for the password, Share
// Project on Diffinery, signing in with a pasted token, and signing out. Not part of `pnpm e2e` (it needs an IDE and
// a display). The IDE installs the plugin the way people do, from the Worker's plugin repository
// (/-/jetbrains/updatePlugins.xml, serving apps/jetbrains/dist), and is driven through JetBrains' Remote Robot server
// plugin, whose scripts run inside the IDE:
//
//   (cd apps/jetbrains && ./gradlew dist) && node scripts/build-docs.mjs
//   IDE_HOME=/path/to/idea-IU-262.x ROBOT=/path/to/robot-server-plugin-0.11.23.zip \
//     pnpm --filter @diffinery/app exec node test/e2e/jetbrains-smoke.mjs
//
// It starts its own Xvfb display. SHOTS=dir saves screenshots of each step, and SCALE=2 renders the IDE at 2x. DOCS=1
// takes them for the docs: the home folder is /home/ada (it must not exist) and the pictures name diffinery.com, not
// the local Worker's address.
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const IDE = process.env.IDE_HOME;
const ROBOT = process.env.ROBOT && resolve(process.env.ROBOT);
const SHOTS = process.env.SHOTS;
const DOCS = process.env.DOCS === "1";
const SCALE = Number(process.env.SCALE || (DOCS ? 2 : 1));
if (!IDE || !ROBOT) throw new Error("set IDE_HOME and ROBOT");
const work = mkdtempSync(join(tmpdir(), "diffinery-jetbrains-"));
const hash = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADA_SESSION = "ada-jetbrains-session-0123456789abcdef";
const ADA_TOKEN = `dfy_${randomBytes(24).toString("hex")}`;
const CHARLES_TOKEN = `dfy_${randomBytes(24).toString("hex")}`;
let devLog = "";

async function until(what, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ""}`);
}
const wrangler = (...args) => execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });
const children = [];
const cleanup = () => {
  for (const c of children.reverse())
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {}
};
process.on("exit", cleanup);

// ---------------------------------------------------------------- a local Diffinery with ada, charles and repositories
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
    `INSERT INTO accounts (id, login, kind, name, email, status, created_at) VALUES ('cb1', 'charles', 'user', 'Charles', 'charles@example.com', 'active', '${at}')`,
    `INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('t2', 'cb1', 'e2e', '${hash(CHARLES_TOKEN)}', '${CHARLES_TOKEN.slice(0, 10)}', '["write"]', '${later}', '${at}')`,
  ].join("; "),
);
const dev = spawn(
  "pnpm",
  ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${base}`, "--var", "DEV_AUTH:", "--show-interactive-dev-session=false"],
  { cwd: APP, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], detached: true },
);
children.push(dev);
dev.stdout.on("data", (d) => (devLog += d));
dev.stderr.on("data", (d) => (devLog += d));
await until("wrangler dev", async () => (await fetch(`${base}/healthz`).catch(() => null))?.ok, 120_000).catch((e) => {
  throw new Error(`${e.message}\n${devLog.slice(-3000)}`);
});
console.log("worker up at", base);

const api = (method, path, body, token = ADA_TOKEN) =>
  fetch(`${base}/api/v3${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) }).then(async (r) =>
    r.ok ? r.json() : Promise.reject(new Error(`${method} ${path}: ${r.status} ${await r.text()}`)),
  );
await api("POST", "/user/repos", { name: "hello-editor", private: true, description: "The analytical engine, in TypeScript" });
await api("POST", "/user/repos", { name: "notes", private: false, description: "Notes on the engine, and drafts of the next paper" });
await api("POST", "/user/repos", { name: "engine-drawings", private: true }, CHARLES_TOKEN);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).toString();
const seed = join(work, "seed");
mkdirSync(seed);
git(seed, "init", "-q", "-b", "main");
writeFileSync(join(seed, "README.md"), "# hello-editor\n\nCloned from Diffinery in a JetBrains IDE.\n");
git(seed, "add", ".");
git(seed, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-qm", "First commit");
git(seed, "push", "-q", `http://x:${ADA_TOKEN}@localhost:${port}/ada/hello-editor.git`, "main");

// ---------------------------------------------------------------- the IDE
const home = DOCS ? "/home/ada" : join(work, "home");
if (DOCS && existsSync(home)) throw new Error(`${home} exists already`);
const ide = join(work, "ide");
for (const d of ["config/options", "system", "plugins", "log"]) mkdirSync(join(ide, d), { recursive: true });
mkdirSync(home, { recursive: true });
execFileSync("unzip", ["-q", ROBOT, "-d", join(ide, "plugins")]);
// Git saves nothing itself here: every password must come from the plugin.
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Ada\n\temail = ada@example.com\n[credential]\n\thelper =\n");
// The server, as someone would set it under Settings → Version Control → Diffinery for a self-hosted Diffinery.
// No desktop keyring under Xvfb: keep passwords in the IDE's own KeePass file, as people without one do.
writeFileSync(join(ide, "config/options/security.xml"), `<application>\n  <component name="PasswordSafe">\n    <option name="PROVIDER" value="KEEPASS" />\n  </component>\n</application>\n`);
writeFileSync(join(ide, "config/options/diffinery.xml"), `<application>\n  <component name="Diffinery">\n    <option name="server" value="${base}" />\n  </component>\n</application>\n`);
// A local repository with a commit and no remote, for Share Project on Diffinery.
const engine = join(home, "difference-engine");
mkdirSync(engine, { recursive: true });
git(engine, "init", "-q", "-b", "main");
writeFileSync(join(engine, "engine.ts"), "export const add = (a: number, b: number) => a + b;\n");
git(engine, "add", ".");
git(engine, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-qm", "Start the engine");
// An IDE project already (so opening it skips the New Project wizard), with .idea kept out of Git.
mkdirSync(join(engine, ".idea"));
writeFileSync(join(engine, ".git", "info", "exclude"), ".idea/\n");
// The browser the IDE opens: record the URL, as a person's browser would receive it.
const bin = join(work, "bin");
mkdirSync(bin);
const opened = join(work, "opened.txt");
writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\necho "$1" >> ${opened}\n`);
chmodSync(join(bin, "xdg-open"), 0o755);
const robotPort = await freePort();
writeFileSync(join(ide, "idea.properties"), ["config", "system", "plugins", "log"].map((d) => `idea.${d}.path=${join(ide, d)}`).join("\n") + "\n");
writeFileSync(
  join(ide, "idea.vmoptions"),
  readFileSync(join(IDE, "bin", "idea64.vmoptions"), "utf8") +
    [
      `-Drobot-server.port=${robotPort}`,
      "-Djb.consents.confirmation.enabled=false",
      "-Djb.privacy.policy.text=<!--999.999-->",
      "-Didea.trust.all.projects=true",
      "-Dide.show.tips.on.startup.default.value=false",
      "-Didea.initially.ask.config=never",
      "-Dide.newUsersOnboarding=false",
      `-Dsun.java2d.uiScale=${SCALE}`,
      `-Duser.home=${home}`,
    ].join("\n") +
    "\n",
);
const display = `:${100 + Math.floor(Math.random() * 400)}`;
console.log(`IDE on display ${display}, robot server on port ${robotPort}`);
const xvfb = spawn("Xvfb", [display, "-screen", "0", `${1600 * SCALE}x${1000 * SCALE}x24`, "-nolisten", "tcp"], { stdio: "ignore", detached: true });
children.push(xvfb);
await sleep(1000);
const env = { ...process.env, HOME: home, DISPLAY: display, PATH: `${bin}:${process.env.PATH}`, BROWSER: join(bin, "xdg-open"), IDEA_PROPERTIES: join(ide, "idea.properties"), IDEA_VM_OPTIONS: join(ide, "idea.vmoptions"), JAVA_TOOL_OPTIONS: "", GIT_TERMINAL_PROMPT: "0" };
// The plugin comes from this Worker's plugin repository (/-/jetbrains/updatePlugins.xml), as for people: through
// Settings → Plugins (the default), or INSTALL=cli for the `idea installPlugins` command.
const FEED = `${base}/-/jetbrains/updatePlugins.xml`;
const CLI_INSTALL = process.env.INSTALL === "cli";
if (CLI_INSTALL) {
  const installed = execFileSync(join(IDE, "bin", "idea.sh"), ["installPlugins", "com.diffinery", FEED], { env, stdio: "pipe", timeout: 300_000 }).toString();
  assert.ok(existsSync(join(ide, "plugins", "diffinery-jetbrains")), `installPlugins didn't install the plugin:\n${installed.slice(-2000)}`);
}
let ideLog = "";
const ideLogText = () => (existsSync(join(ide, "log/idea.log")) ? readFileSync(join(ide, "log/idea.log"), "utf8") : "");
const launched = ideLogText().length; // installPlugins logged before this
const idea = spawn(join(IDE, "bin", "idea.sh"), [], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
children.push(idea);
idea.stdout.on("data", (d) => (ideLog += d));
idea.stderr.on("data", (d) => (ideLog += d));

/** A screenshot of the whole display, or of the window titled `title`. */
async function shot(name, title) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const file = join(SHOTS, `${name}.png`);
  // Tips the IDE shows over the window aren't part of the picture.
  await js(`var b = button("Got It"); if (b) b.doClick(); "ok"`);
  if (DOCS) await js(`var a = showing(); for (var i = 0; i < a.length; i++) if (a[i] instanceof javax.swing.JLabel && text(a[i]).indexOf(${JSON.stringify(new URL(base).host)}) >= 0) a[i].setText(text(a[i]).replace(${JSON.stringify(new URL(base).host)}, "diffinery.com")); "ok"`);
  await sleep(300);
  execFileSync("import", ["-display", display, "-window", "root", file]);
  if (title) {
    const b = JSON.parse(await js(`var w = windowTitled(${JSON.stringify(title)}); var p = w.getLocationOnScreen(); var s = w.getSize(); JSON.stringify([p.x, p.y, s.width, s.height])`));
    const sx = SCALE;
    execFileSync("convert", [file, "-crop", `${b[2] * sx}x${b[3] * sx}+${b[0] * sx}+${b[1] * sx}`, "+repage", file]);
  }
}

// Scripts run inside the IDE (Rhino, with the IDE's classes). The prelude finds components in showing windows.
const PRELUDE = `
var App = com.intellij.openapi.application.ApplicationManager.getApplication();
function walk(c, out) { out.push(c); if (c instanceof java.awt.Container) { var k = c.getComponents(); for (var i = 0; i < k.length; i++) walk(k[i], out); } return out; }
function showing() { var out = []; var ws = java.awt.Window.getWindows(); for (var i = 0; i < ws.length; i++) if (ws[i].isShowing()) walk(ws[i], out); return out; }
function find(pred) { var a = showing(); for (var i = 0; i < a.length; i++) if (a[i].isShowing() && pred(a[i])) return a[i]; return null; }
function cls(c) { return String(c.getClass().getName()); }
function text(c) { try { return String(c.getText()); } catch (e) { return ""; } }
function button(t) { return find(function (c) { return c instanceof javax.swing.AbstractButton && text(c).replace(/<[^>]+>/g, "") === t; }); }
function windowTitled(t) { var ws = java.awt.Window.getWindows(); for (var i = 0; i < ws.length; i++) { var w = ws[i]; if (w.isShowing() && w instanceof java.awt.Dialog && String(w.getTitle()) === t) return w; } return null; }
function later(f) { App.invokeLater(new java.lang.Runnable({ run: f }), com.intellij.openapi.application.ModalityState.any()); }
function click(t) { var b = button(t); if (!b) throw new Error("no button " + t); later(function () { b.doClick(); }); return "ok"; }
function pluginClass(name) { return com.intellij.ide.plugins.PluginManagerCore.getPlugin(com.intellij.openapi.extensions.PluginId.getId("com.diffinery")).getPluginClassLoader().loadClass(name); }
function accounts() { return pluginClass("com.diffinery.jetbrains.Accounts").getMethod("get").invoke(null); }
function runAction(id, component) { var am = com.intellij.openapi.actionSystem.ActionManager.getInstance(); later(function () { am.tryToExecute(am.getAction(id), null, component || null, "DiffinerySmoke", true); }); return "ok"; }
function repoList() { return find(function (c) { return c instanceof javax.swing.JList && String(c.getName()) === "diffinery.repositories"; }); }
function repoNames() { var l = repoList(); if (!l) return "[]"; var out = []; for (var i = 0; i < l.getModel().getSize(); i++) out.push(String(l.getModel().getElementAt(i)).match(/fullName=([^,]+)/)[1]); return JSON.stringify(out); }
`;
/** Runs a script in the IDE (on the UI thread unless `edt` is false) and returns its result as a string. */
async function js(script, edt = true) {
  const r = await fetch(`http://127.0.0.1:${robotPort}/js/retrieveAny`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: `${PRELUDE}\nString(eval(${JSON.stringify(script)}))`, runInEdt: edt }) });
  const j = await r.json();
  if (j.status !== "SUCCESS") throw new Error(`IDE script failed: ${j.message ?? ""} ${String(j.exception ?? "").slice(0, 800)}`);
  // A Java-serialized String: 0xACED0005, then TC_STRING (0x74) with a 2-byte length, or TC_LONGSTRING (0x7C) with 8.
  const b = Buffer.from(j.bytes.map((x) => x & 255));
  if (b[4] === 0x74) return b.subarray(7, 7 + b.readUInt16BE(5)).toString("utf8");
  if (b[4] === 0x7c) return b.subarray(13, 13 + Number(b.readBigUInt64BE(5))).toString("utf8");
  throw new Error("IDE script didn't return a string");
}

async function fail(e) {
  await shot("failed").catch(() => {});
  console.error(e);
  // KEEP=1 leaves the IDE running to look around in (its robot server's port is printed at the start).
  if (process.env.KEEP) return;
  console.error("--- IDE log tail ---\n" + (existsSync(join(ide, "log/idea.log")) ? readFileSync(join(ide, "log/idea.log"), "utf8").split("\n").filter((l) => /diffinery|ERROR|SEVERE/i.test(l)).slice(-40).join("\n") : ideLog.slice(-3000)));
  cleanup();
  process.exit(1);
}
process.on("unhandledRejection", fail);
process.on("uncaughtException", fail);

// On its first start after installPlugins the IDE asks whether to trust the plugin, since it isn't JetBrains': a
// person clicks Accept, here Enter (its default button) through java.awt.Robot, until the IDE loads the plugin.
writeFileSync(join(work, "PressEnter.java"), "public class PressEnter { public static void main(String[] a) throws Exception { var r = new java.awt.Robot(); r.keyPress(10); r.keyRelease(10); r.delay(200); } }\n");
if (CLI_INSTALL) await until("the IDE to load the plugin", async () => {
  const log = ideLogText().slice(launched);
  if (/Loaded custom plugins: .*Diffinery \(/.test(log)) return true;
  if (/Disabled plugins|Marking plugins 'disabled': \[[^\]]*com\.diffinery/.test(log)) throw new Error("the IDE disabled the plugin");
  if (/Computed user scale factor/.test(log)) execFileSync(join(IDE, "jbr/bin/java"), [join(work, "PressEnter.java")], { env: { ...env, JAVA_TOOL_OPTIONS: "" }, stdio: "ignore" });
  await sleep(2000);
}, 180_000);
await until("the IDE's robot server", async () => (await fetch(`http://127.0.0.1:${robotPort}/hello`).catch(() => null))?.ok, 180_000);
await until("the welcome screen", async () => (await js(`com.intellij.openapi.wm.impl.welcomeScreen.WelcomeFrame.getInstance() != null`)) === "true", 120_000);
const diffineryPlugin = `com.intellij.ide.plugins.PluginManagerCore.getPlugin(com.intellij.openapi.extensions.PluginId.getId("com.diffinery"))`;
if (!CLI_INSTALL) {
  // 0. Settings → Plugins → ⚙ → Manage Plugin Repositories → the feed; then Marketplace → "Diffinery" → Install.
  assert.equal(await js(`${diffineryPlugin} == null`), "true");
  await js(`com.intellij.openapi.updateSettings.impl.UpdateSettings.getInstance().getStoredPluginHosts().add(${JSON.stringify(FEED)}); "ok"`);
  await js(`later(function () { com.intellij.openapi.options.ShowSettingsUtil.getInstance().showSettingsDialog(null, com.intellij.ide.plugins.PluginManagerConfigurable); }); "ok"`);
  const tabs = `find(function (c) { return c instanceof javax.swing.JTabbedPane && cls(c).indexOf("TabbedPaneHeaderComponent") >= 0; })`;
  await until("the Plugins page", async () => (await js(`${tabs} != null`)) === "true", 30_000);
  assert.equal(await js(`${tabs}.getTitleAt(0)`), "Marketplace");
  await js(`${tabs}.setSelectedIndex(0); "ok"`);
  const search = `find(function (c) { return c instanceof com.intellij.ui.SearchTextField && cls(c).indexOf("PluginsTab") >= 0; })`;
  await until("the Marketplace search", async () => (await js(`${search} != null`)) === "true", 30_000);
  await js(`${search}.setText("Diffinery"); "ok"`);
  await until("Diffinery in the Marketplace results", async () => (await js(`button("Install") != null`)) === "true", 60_000);
  await sleep(1500);
  await shot("0-plugins", "Settings");
  await js(`click("Install")`);
  // The IDE warns that the plugin isn't JetBrains'; a person accepts.
  await until("the third-party plugin notice", async () => (await js(`windowTitled("Third-Party Plugins Notice") != null`)) === "true", 30_000);
  await js(`click("Accept")`);
  await until("the plugin installed", async () => (await js(`button("Installed") != null`)) === "true", 60_000);
  await js(`click("OK")`);
  // It loads without restarting the IDE.
  await until("the plugin loaded", async () => (await js(`var p = ${diffineryPlugin}; p != null && com.intellij.ide.plugins.PluginManagerCore.isLoaded(p.getPluginId())`)) === "true", 60_000);
}
console.log("IDE up, plugin", await js(`${diffineryPlugin}.getVersion()`));
await sleep(3000);

// 1. Get from Version Control lists Diffinery next to GitHub and GitLab.
await js(`runAction("Vcs.VcsClone")`);
// "Get from Version Control" until 2025.x, "Clone Repository" since.
const CLONE = await until("Get from Version Control", async () => await js(`var w = windowTitled("Get from Version Control") || windowTitled("Clone Repository"); w ? w.getTitle() : ""`), 30_000);
const sources = JSON.parse(
  await js(`var l = find(function (c) { return cls(c).indexOf("VcsCloneDialogExtensionList") >= 0; }); var out = []; var m = l.getModel(); for (var i = 0; i < m.getSize(); i++) { var e = m.getElementAt(i); out.push(String(e.getName ? e.getName() : e)); } JSON.stringify(out)`),
);
console.log("Get from Version Control:", sources);
assert.ok(sources.includes("Diffinery"), "Diffinery is a source");
await js(`var l = find(function (c) { return cls(c).indexOf("VcsCloneDialogExtensionList") >= 0; }); var m = l.getModel(); for (var i = 0; i < m.getSize(); i++) if (String(m.getElementAt(i).getName()) === "Diffinery") l.setSelectedIndex(i); "ok"`);
await until("the sign-in page", async () => (await js(`button("Sign In with Browser…") != null`)) === "true", 20_000);
await sleep(500);
await shot("1-get-from-vcs", CLONE);

// 2. Signing in: the IDE opens Diffinery's consent page in the browser and listens on 127.0.0.1 for the answer.
await js(`click("Sign In with Browser…")`);
const authorize = await until("the IDE to open the browser", async () => existsSync(opened) && readFileSync(opened, "utf8").trim().split("\n").pop(), 30_000);
const au = new URL(authorize);
assert.equal(au.origin + au.pathname, `${base}/oauth/authorize`);
assert.equal(au.searchParams.get("client_id"), `${base}/oauth/clients/jetbrains.json`);
assert.match(au.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.context().addCookies([{ name: "__Host-dfy_session", value: ADA_SESSION, url: base }]).catch(async () => {
  await page.goto(`${base}/login`);
  await page.evaluate((v) => (document.cookie = `__Host-dfy_session=${v}; path=/; secure; samesite=lax`), ADA_SESSION);
});
await page.goto(authorize);
const consent = await page.textContent("main");
assert.match(consent, /Connect Diffinery plugin for JetBrains IDEs/);
assert.match(consent, /Sends you back to\s*an app on this computer/);
if (SHOTS) await page.screenshot({ path: join(SHOTS, "2-consent.png"), fullPage: true });
await page.click('button[value="approve"]');
await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/callback/);
assert.match(await page.textContent("body"), /You're signed in to Diffinery/);
if (SHOTS) await page.screenshot({ path: join(SHOTS, "2b-signed-in.png") });
await browser.close();
console.log("browser: consent approved, signed-in page shown");

// 3. Signed in: the page lists ada's repositories; search narrows them.
await until("ada's repositories", async () => JSON.parse(await js(`repoNames()`)).length >= 2, 30_000);
const repos = JSON.parse(await js(`repoNames()`));
console.log("repositories:", repos);
assert.deepEqual([...repos].sort(), ["ada/hello-editor", "ada/notes"]);
await sleep(500);
await shot("3-repositories", CLONE);
await js(`var f = find(function (c) { return c instanceof com.intellij.ui.SearchTextField; }); f.setText("hello"); "ok"`);
await until("the search result", async () => JSON.stringify(JSON.parse(await js(`repoNames()`))) === JSON.stringify(["ada/hello-editor"]), 20_000);
const directory = await until("the directory", async () => {
  const d = await js(`var l = repoList(); l.setSelectedIndex(0); var f = find(function (c) { return c instanceof com.intellij.openapi.ui.TextFieldWithBrowseButton; }); f ? f.getText() : ""`);
  return d.endsWith("hello-editor") && d;
});
assert.equal(directory, join(home, "IdeaProjects", "hello-editor"));
await sleep(300);
await shot("4-search", CLONE);

// 4. Clone: Git asks the plugin for the password (no prompt), and the IDE opens the project.
await until("the Clone button enabled", async () => (await js(`var b = button("Clone"); b != null && b.isEnabled()`)) === "true", 10_000);
await js(`click("Clone")`);
const readme = join(directory, "README.md");
await until("the clone on disk", async () => existsSync(readme), 120_000);
assert.match(readFileSync(readme, "utf8"), /Cloned from Diffinery/);
assert.match(git(directory, "remote", "get-url", "origin"), new RegExp(`^${base}/ada/hello-editor\\.git`));
console.log("cloned:", directory);
await until("the project window", async () => (await js(`var ps = com.intellij.openapi.project.ProjectManager.getInstance().getOpenProjects(); var n = []; for (var i = 0; i < ps.length; i++) n.push(String(ps[i].getName())); n.join(",")`)).includes("hello-editor"), 120_000);
await sleep(4000);
await shot("5-opened");

// 5. Share Project on Diffinery: a local repository with no remote becomes ada/difference-engine, pushed.
await js(`later(function () { com.intellij.ide.impl.ProjectUtil.openOrImport(java.nio.file.Paths.get(${JSON.stringify(engine)}), null, true); }); "ok"`);
await until("the difference-engine project", async () => (await js(`var ps = com.intellij.openapi.project.ProjectManager.getInstance().getOpenProjects(); var n = []; for (var i = 0; i < ps.length; i++) n.push(String(ps[i].getName())); n.join(",")`)).includes("difference-engine"), 120_000);
await until("Git in the project", async () => (await js(`var ps = com.intellij.openapi.project.ProjectManager.getInstance().getOpenProjects(); var p = null; for (var i = 0; i < ps.length; i++) if (String(ps[i].getName()) === "difference-engine") p = ps[i]; String(pluginClass("git4idea.repo.GitRepositoryManager").getMethod("getInstance", com.intellij.openapi.project.Project).invoke(null, p).getRepositories().size())`, false)) === "1", 60_000);
await js(`var ps = com.intellij.openapi.project.ProjectManager.getInstance().getOpenProjects(); var p = null; for (var i = 0; i < ps.length; i++) if (String(ps[i].getName()) === "difference-engine") p = ps[i]; runAction("Diffinery.Share", com.intellij.openapi.wm.WindowManager.getInstance().getFrame(p).getRootPane())`);
await until("the Share dialog", async () => (await js(`windowTitled("Share Project on Diffinery") != null`)) === "true", 30_000);
assert.equal(await js(`var f = find(function (c) { return c instanceof com.intellij.ui.components.JBTextField && c.isShowing() && javax.swing.SwingUtilities.getWindowAncestor(c) === windowTitled("Share Project on Diffinery"); }); f.getText()`), "difference-engine");
await shot("6-share", "Share Project on Diffinery");
await js(`click("Share")`);
const pushed = await until("the pushed branch on Diffinery", async () => (await api("GET", "/repos/ada/difference-engine/branches").catch(() => null))?.find((b) => b.name === "main"), 60_000);
assert.equal(pushed.commit.sha, git(engine, "rev-parse", "HEAD").trim());
assert.equal((await api("GET", "/repos/ada/difference-engine")).private, true);
assert.match(git(engine, "remote", "get-url", "origin").trim(), /\/ada\/difference-engine\.git$/);
console.log("shared: ada/difference-engine, private, main pushed");
await sleep(1500);
await shot("7-shared");

// 6. Signing out disconnects the IDE on Diffinery too.
await js(`accounts().signOut(); "ok"`, false);
const grants = JSON.parse(wrangler("d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--json", "--command", "SELECT revoked_at FROM oauth_grants").toString())[0].results;
assert.ok(grants.length === 1 && grants[0].revoked_at, "the connection is revoked");
assert.equal(await js(`String(accounts().account())`, false), "null");
console.log("signed out: connection revoked");

// 7. Signing in with a pasted token (Clone from Diffinery opens Get from Version Control on the Diffinery page).
await js(`runAction("Diffinery.Clone")`);
await until("the sign-in page", async () => (await js(`button("Sign In with Browser…") != null`)) === "true", 30_000);
await js(`var l = find(function (c) { return c instanceof com.intellij.ui.components.ActionLink && text(c) === "Use an access token…"; }); later(function () { l.doClick(); }); "ok"`);
await until("the token dialog", async () => (await js(`windowTitled("Sign In to Diffinery with a Token") != null`)) === "true", 20_000);
await js(`var f = find(function (c) { return c instanceof javax.swing.JPasswordField; }); f.setText(${JSON.stringify(CHARLES_TOKEN)}); "ok"`);
await js(`var w = windowTitled("Sign In to Diffinery with a Token"); var ok = null; var a = walk(w, []); for (var i = 0; i < a.length; i++) if (a[i] instanceof javax.swing.JButton && text(a[i]) === "OK") ok = a[i]; later(function () { ok.doClick(); }); "ok"`);
await until("charles's repositories", async () => JSON.parse(await js(`repoNames()`)).includes("charles/engine-drawings"), 30_000);
assert.equal(await js(`accounts().account().login()`, false), "charles");
console.log("token sign-in: charles's repositories listed");
await js(`click("Cancel")`);

await js(`App.exit(true, true, false); "ok"`).catch(() => {});
await sleep(2000);
cleanup();
if (process.env.KEEP !== "1") rmSync(work, { recursive: true, force: true });
if (DOCS) rmSync(home, { recursive: true, force: true });
console.log("jetbrains smoke test passed");
process.exit(0);
