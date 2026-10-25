// Takes the screenshots in docs/images/ from a real local Worker (`wrangler dev`) with sample data, so the
// pictures in the docs show the real pages. PUBLIC_URL is https://diffinery.com, so the pages show the
// addresses people see.
//
//   pnpm --filter @diffinery/app build && node scripts/docs-screenshots.mjs
//
// Writes docs/images/consent-claude-code.webp, consent-codex.webp, editor-consent.webp, jetbrains-consent.webp and
// connected-apps.webp; name some of them as arguments to write only those. The editor extension's and the JetBrains
// plugin's own pictures come from test/e2e/editor-smoke.mjs and test/e2e/jetbrains-smoke.mjs.
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { freePort } from "../test/e2e/ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(APP, "docs/images");
const PUBLIC = "https://diffinery.com";
const port = await freePort();
// The browser talks to the Worker here; the pages themselves say diffinery.com.
const ORIGIN = `http://localhost:${port}`;
const only = process.argv.slice(2);
const work = mkdtempSync(join(tmpdir(), "diffinery-shots-"));
const persist = join(work, "state");
const SESSION = "docs-screenshots-session-0123456789abcdef";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const b64url = (b) => Buffer.from(b).toString("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrangler = (...args) => execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });
const sql = (command) => wrangler("d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--command", command);

// Sample data: Ada, signed in with a passkey, and her agent ada-bot.
wrangler("d1", "migrations", "apply", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist);
const at = new Date(Date.now() - 3 * 86400_000).toISOString();
const later = new Date(Date.now() + 86400_000).toISOString();
sql(
  [
    `INSERT INTO accounts (id, login, kind, name, email, status, created_at) VALUES ('ada1', 'ada', 'user', 'Ada Lovelace', 'ada@example.com', 'active', '${at}')`,
    `INSERT INTO accounts (id, login, kind, name, status, owner_id, created_at) VALUES ('bot1', 'ada-bot', 'agent', 'Ada bot', 'active', 'ada1', '${at}')`,
    `INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(SESSION)}', 'ada1', 'passkey', '${new Date().toISOString()}', '${new Date().toISOString()}', '${later}')`,
  ].join("; "),
);

let log = "";
const dev = spawn(
  "pnpm",
  ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persist, "--var", `PUBLIC_URL:${PUBLIC}`, "--var", "DEV_AUTH:", "--show-interactive-dev-session=false"],
  { cwd: APP, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], detached: true },
);
dev.stdout.on("data", (d) => (log += d));
dev.stderr.on("data", (d) => (log += d));

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
  const page = await context.newPage();
  for (let i = 0; ; i++) {
    try {
      if ((await page.goto(`${ORIGIN}/healthz`)).ok()) break;
    } catch {}
    if (i > 240) throw new Error(`wrangler dev didn't start\n${log.slice(-3000)}`);
    await sleep(500);
  }
  await page.goto(`${ORIGIN}/login`);
  await page.evaluate((v) => (document.cookie = `__Host-dfy_session=${v}; path=/; secure; samesite=lax`), SESSION);

  // The app's callback: nothing listens there, so record where the browser was sent.
  const callbacks = [];
  context.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/callback" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) callbacks.push(u);
  });

  /** Encodes the screenshot as WebP in the browser itself (no image library needed). */
  async function save(name, png) {
    if (only.length && !only.includes(name)) return;
    const data = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      c.getContext("2d").drawImage(img, 0, 0);
      return c.toDataURL("image/webp", 0.86).split(",")[1];
    }, png.toString("base64"));
    writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
    console.log(`docs/images/${name}: ${Math.round((data.length * 3) / 4 / 1024)} KiB`);
  }

  // Connects an app identified by its client metadata document, as Claude Code and Codex do.
  async function connect(clientId, redirect, file, { actAs = "ada-bot", scope = "read write", resource = `${PUBLIC}/mcp` } = {}) {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, state: b64url(randomBytes(8)), code_challenge: challenge, code_challenge_method: "S256", scope, ...(resource ? { resource } : {}) });
    await page.goto(`${ORIGIN}/oauth/authorize?${q}`);
    await page.waitForLoadState("networkidle");
    if (actAs) await page.getByText(actAs, { exact: false }).first().click();
    await sleep(300);
    const card = page.locator("main .box").first();
    await save(file, await card.screenshot());
    const before = callbacks.length;
    await page.click('button[value="approve"]', { noWaitAfter: true });
    for (let i = 0; callbacks.length === before; i++) {
      if (i > 60) throw new Error("no callback");
      await sleep(250);
    }
    const code = callbacks[before].searchParams.get("code");
    const tok = await (
      await fetch(`${ORIGIN}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier }),
      })
    ).json();
    if (!tok.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tok)}`);
    // One MCP call, so Connected apps shows it as used.
    await fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
    });
    await page.goto("about:blank");
  }

  await connect("https://claude.ai/oauth/claude-code-client-metadata", "http://localhost:53682/callback", "consent-claude-code.webp");
  await connect("https://chatgpt.com/oauth/codex/client.json", "http://127.0.0.1:1455/callback", "consent-codex.webp");
  // The editor extension, as it signs in from VS Code or Cursor: as the person, for Git, without the MCP resource.
  await connect(`${PUBLIC}/oauth/clients/editor.json`, "http://127.0.0.1:52817/callback", "editor-consent.webp", { actAs: null, scope: "write", resource: null });
  // The JetBrains plugin, the same way from IntelliJ IDEA, PyCharm or another JetBrains IDE.
  await connect(`${PUBLIC}/oauth/clients/jetbrains.json`, "http://127.0.0.1:52817/callback", "jetbrains-consent.webp", { actAs: null, scope: "write", resource: null });

  await page.goto(`${ORIGIN}/settings/tokens`);
  await page.waitForLoadState("networkidle");
  await save("connected-apps.webp", await page.locator("#connected-apps").screenshot());
} finally {
  await browser.close();
  try {
    process.kill(-dev.pid, "SIGTERM");
  } catch {}
  rmSync(work, { recursive: true, force: true });
}
