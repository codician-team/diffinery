// Takes the screenshots of Diffinery's agent features (Today, an agent task, an agent review, a pull request that
// merges on green) from a real local Worker with sample data, for the README and the docs:
//
//   pnpm --filter @diffinery/app build && pnpm --filter @diffinery/runner build
//   node scripts/agent-screenshots.mjs
//
// It runs the real thing end to end: a sandbox pool (`agent.mjs --sandbox-pool`), an agent task with the Claude Code
// runtime, the automatic agent review of the pull request it opens, and merge on green. The one stand-in is Claude Code
// itself: a script with its name prints what Claude Code prints (`stream-json`) and changes the files, so no model or
// subscription is needed. Then the Worker restarts as https://diffinery.com, so the pages show the addresses people see.
//
// Writes docs/images/{today,agent-task,agent-pull-request,merge-on-green}.webp here and the same pictures as PNG in the
// repository's docs/images/ (the README's).
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { migratedState } from "../test/e2e/d1-state.mjs";
import { freePort } from "../test/e2e/ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = resolve(APP, "../../containers/runner/dist/agent.mjs");
const OUT = join(APP, "docs/images");
const README_OUT = resolve(APP, "../../docs/images");
const top = mkdtempSync(join(tmpdir(), "diffinery-agent-shots-"));
const work = join(top, "work");
const poolRoot = join(top, "pool");
const poolHome = join(top, "home");
const persist = join(work, "state");
const bin = join(work, "bin");
for (const d of [work, poolHome, bin]) mkdirSync(d, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => createHash("sha256").update(s).digest("hex");
const SESSION = `agent-shots-${randomBytes(12).toString("hex")}`;
const procs = [];
let log = "";

function start(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: APP, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  // LOG=<file> keeps everything the Worker and the pool print, for when a step times out.
  const keep = (d) => {
    log += d;
    if (process.env.LOG) appendFileSync(process.env.LOG, d);
  };
  p.stdout.on("data", keep);
  p.stderr.on("data", keep);
  procs.push(p);
  return p;
}
const stop = (p) => {
  try {
    process.kill(-p.pid, "SIGTERM");
  } catch {}
};
async function until(what, fn, ms = 120_000) {
  let v;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    v = await fn();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}\n${log.slice(-4000)}`);
}
const sql = (command) => execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--command", command], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });

// ---------------------------------------------------------------- the stand-in for Claude Code

// `npm install --global @anthropic-ai/claude-code@…` (the runtime's install step) and `claude`, as the jail runs them.
writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n");
writeFileSync(
  join(bin, "claude"),
  `#!/usr/bin/env node
const fs = require("fs");
if (process.argv.includes("--version")) return console.log("2.1.296 (Claude Code)");
const prompt = process.env.DIFFINERY_TASK_PROMPT || "";
const say = (o) => console.log(JSON.stringify(o));
const text = (t) => say({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const tool = (name, input, out) => {
  say({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
  if (out) say({ type: "user", message: { content: [{ type: "tool_result", content: out }] } });
};
say({ type: "system", subtype: "init", model: "claude-sonnet" });
if (prompt.startsWith("You are reviewing")) {
  text("I'll read the changes and the tests around them.");
  tool("Read", { file_path: "src/discounts.js" });
  tool("Read", { file_path: "src/checkout.js" });
  tool("Bash", { command: "npm test" }, "✔ 9 tests passed");
  const findings = {
    summary: "Adds discount codes at checkout. One case worth covering: codes are matched case-sensitively.",
    findings: [{ path: "src/discounts.js", line: 8, side: "RIGHT", severity: "not_blocking", title: "Codes typed in lower case are rejected", body: "Customers often type codes as they read them in an email, such as \`welcome10\`. \`CODES[code]\` only finds \`WELCOME10\`, so the code is refused with no hint why.", suggestion: "  const rule = CODES[code.trim().toUpperCase()];" }],
  };
  say({ type: "result", subtype: "success", num_turns: 4, result: "Reviewed the changes.\\n\`\`\`json\\n" + JSON.stringify(findings) + "\\n\`\`\`" });
  return;
}
text("I'll add discount codes to checkout: a table of codes, applying one to the cart total, and tests.");
tool("Read", { file_path: "src/checkout.js" });
tool("Bash", { command: "npm test" }, "✔ 6 tests passed");
fs.writeFileSync("src/discounts.js", \`// Discount codes customers can enter at checkout.
const CODES = {
  WELCOME10: { percent: 10 },
  FREESHIP: { freeShipping: true },
};

export function applyDiscount(cart, code) {
  const rule = CODES[code];
  if (!rule) throw new Error(\\\`Unknown discount code: \\\${code}\\\`);
  const subtotal = rule.percent ? Math.round(cart.subtotal * (100 - rule.percent)) / 100 : cart.subtotal;
  return { ...cart, subtotal, shipping: rule.freeShipping ? 0 : cart.shipping, code };
}
\`);
tool("Write", { file_path: "src/discounts.js" });
const checkout = fs.readFileSync("src/checkout.js", "utf8");
if (!checkout.includes("totalWithCode")) fs.writeFileSync("src/checkout.js", checkout.replace("export function total(cart) {", 'import { applyDiscount } from "./discounts.js";\\n\\nexport function totalWithCode(cart, code) {\\n  return total(code ? applyDiscount(cart, code) : cart);\\n}\\n\\nexport function total(cart) {'));
tool("Edit", { file_path: "src/checkout.js" });
fs.writeFileSync("test/discounts.test.js", \`import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDiscount } from "../src/discounts.js";

test("WELCOME10 takes 10% off the subtotal", () => {
  assert.equal(applyDiscount({ subtotal: 50, shipping: 5 }, "WELCOME10").subtotal, 45);
});

test("FREESHIP removes shipping", () => {
  assert.equal(applyDiscount({ subtotal: 50, shipping: 5 }, "FREESHIP").shipping, 0);
});

test("an unknown code is refused", () => {
  assert.throws(() => applyDiscount({ subtotal: 50, shipping: 5 }, "NOPE"), /Unknown discount code/);
});
\`);
tool("Write", { file_path: "test/discounts.test.js" });
tool("Bash", { command: "npm test" }, "✔ 9 tests passed");
say({ type: "result", subtype: "success", num_turns: 9, result: "Added discount codes at checkout: src/discounts.js with WELCOME10 and FREESHIP, totalWithCode() in src/checkout.js, and three tests. All 9 tests pass." });
`,
);
chmodSync(join(bin, "npm"), 0o755);
chmodSync(join(bin, "claude"), 0o755);

// ---------------------------------------------------------------- a Worker with a sandbox pool

const poolPort = await freePort();
const poolSecret = randomBytes(16).toString("hex");
const pool = start("node", [AGENT, "--sandbox-pool", "--work-root", poolRoot], { HOME: poolHome, PATH: `${bin}:${process.env.PATH}`, DIFFINERY_SANDBOX_POOL_SECRET: poolSecret, DIFFINERY_SANDBOX_PORT: String(poolPort), DIFFINERY_JAIL_SHARED_FOR_TESTS: work });
await until("the sandbox pool", async () => log.includes("listening"), 30_000);

migratedState(APP, persist);
const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600_000).toISOString();
sql(`INSERT INTO accounts (id, login, kind, name, email, status, site_admin, created_at) VALUES ('ada1', 'ada', 'user', 'Ada Lovelace', 'ada@example.com', 'active', 1, '${at(24 * 30)}')`);

const MASTER_KEY = randomBytes(32).toString("base64");
async function worker(varsFor) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const vars = varsFor(base);
  const p = start("pnpm", ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, ...Object.entries({ MASTER_KEY, ...vars }).flatMap(([k, v]) => ["--var", `${k}:${v}`]), "--show-interactive-dev-session=false"]);
  await until("wrangler dev", async () => {
    try {
      return (await fetch(`${base}/healthz`)).ok;
    } catch {
      return false;
    }
  });
  return { p, base };
}

// Phase 1: the Worker at its own address, which the sandboxes clone from, signed in as Ada (DEV_AUTH).
let { p: dev, base } = await worker((b) => ({ PUBLIC_URL: b, DEV_AUTH: "ada@example.com", SANDBOX_POOL_URL: `http://127.0.0.1:${poolPort}`, SANDBOX_POOL_SECRET: poolSecret, AGENT_POLL_MS: "500" }));
let token;
async function api(method, path, body, tok = token) {
  const res = await fetch(`${base}/api/v3${path}`, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const asAda = (method, path, body) => api(method, path, body, null);
function git(cwd, args, tok = token) {
  const auth = Buffer.from(`x-token:${tok}`).toString("base64");
  return execFileSync("git", ["-c", `http.extraHeader=Authorization: Basic ${auth}`, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Ada Lovelace", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada Lovelace", GIT_COMMITTER_EMAIL: "ada@example.com" } });
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  token = (await asAda("POST", "/diffinery/tokens", { name: "screenshots", scopes: ["admin"] })).token;
  await asAda("POST", "/user/orgs", { login: "acme", name: "Acme" });
  await api("POST", "/orgs/acme/repos", { name: "storefront", description: "The Acme web shop", private: true });
  const R = "/repos/acme/storefront";

  // A small shop, with CI.
  const src = join(work, "storefront");
  const files = {
    "README.md": "# storefront\n\nThe Acme web shop: cart, checkout and payments.\n",
    "package.json": JSON.stringify({ name: "storefront", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
    "src/checkout.js": "export function total(cart) {\n  return Math.round((cart.subtotal + cart.shipping) * 100) / 100;\n}\n",
    "src/cart.js": "export function addItem(cart, item) {\n  const subtotal = cart.subtotal + item.price * item.quantity;\n  return { ...cart, items: [...cart.items, item], subtotal };\n}\n",
    "test/checkout.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { total } from "../src/checkout.js";\n\ntest("adds shipping", () => assert.equal(total({ subtotal: 10, shipping: 5 }), 15));\n',
    "REVIEW.md": "Prices are in dollars with two decimals. Customer-facing errors must say what to do next.\n",
    // A self-hosted runner here (this script runs its jobs with the real runner agent); on diffinery.com it would be ubuntu-latest.
    ".github/workflows/ci.yml": "name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/checkout@v4\n      - run: node --test\n",
  };
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(src, f)), { recursive: true });
    writeFileSync(join(src, f), c);
  }
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "Cart and checkout"]);
  git(src, ["push", "-q", `${base}/acme/storefront.git`, "main"]);

  // Ada's model key (a stand-in: the stand-in Claude Code never calls a model), and two agents of Acme's.
  await asAda("PUT", "/diffinery/model-keys/anthropic", { key: `sk-ant-api03-${randomBytes(30).toString("hex")}`, accept_terms: true });
  const coder = (await asAda("POST", "/diffinery/agents", { login: "acme-coder", name: "Acme coder", org: "acme", auto_merge: true })).token.token;
  await asAda("POST", "/diffinery/agents", { login: "acme-reviewer", name: "Acme reviewer", org: "acme" });

  // CI: a self-hosted runner that runs every job the repository queues with the real runner agent, as `diffinery runner` does.
  const reg = await api("POST", `${R}/actions/runners/registration-token`);
  const runner = (await api("POST", `${R}/actions/runners/register`, { registration_token: reg.token, name: "ci-1", labels: ["linux"] })).token;
  let running = true;
  const jobs = (async () => {
    while (running) {
      const r = await fetch(`${base}/api/v3${R}/actions/runners/claim`, { method: "POST", headers: { authorization: `Bearer ${runner}`, "content-type": "application/json" }, body: "{}" }).catch(() => null);
      if (r?.status !== 200) {
        await sleep(1000);
        continue;
      }
      const claim = await r.json();
      await new Promise((done) => {
        const job = spawn(process.execPath, [AGENT], { env: { ...process.env, DIFFINERY_API_URL: claim.api_url, DIFFINERY_JOB_ID: claim.job_id, DIFFINERY_JOB_TOKEN: claim.token, DIFFINERY_WORK_ROOT: join(work, `job-${claim.job_id}`) }, stdio: "ignore" });
        job.on("close", done);
      });
    }
  })();
  const green = (sha) =>
    until(`CI on ${sha.slice(0, 7)}`, async () => {
      const runs = ((await api("GET", `${R}/commits/${sha}/check-runs`)).check_runs ?? []).filter((c) => c.name.startsWith("CI"));
      if (runs.some((c) => c.conclusion && c.conclusion !== "success")) throw new Error(`CI failed on ${sha}: ${JSON.stringify(runs)}`);
      return runs.length && runs.every((c) => c.conclusion === "success");
    }, 300_000);

  // An agent pull request from earlier today, approved by Ada and merged.
  git(src, ["checkout", "-q", "-b", "fix-rounding"]);
  writeFileSync(join(src, "src/cart.js"), files["src/cart.js"].replace("cart.subtotal + item.price * item.quantity", "Math.round((cart.subtotal + item.price * item.quantity) * 100) / 100"));
  git(src, ["commit", "-qam", "Round the cart subtotal to cents"]);
  git(src, ["push", "-q", `${base}/acme/storefront.git`, "fix-rounding"], coder);
  const early = await api("POST", `${R}/pulls`, { title: "Round the cart subtotal to cents", head: "fix-rounding", base: "main", body: "Adding 0.1 + 0.2 showed $0.30000000000000004 in the cart.", intent: "Cart totals always show whole cents." }, coder);
  await green(early.head.sha);
  await api("POST", `${R}/pulls/${early.number}/reviews`, { event: "APPROVE", body: "Thanks!" });
  await until("the first pull request to merge", async () => (await api("GET", `${R}/pulls/${early.number}`)).merged || (await api("PUT", `${R}/pulls/${early.number}/merge`, { merge_method: "squash" }).catch(() => null)));
  git(src, ["checkout", "-q", "main"]);

  // Merge on green: the CI checks must pass, and acme-coder's pull requests land once a person approves.
  const page = await browser.newPage();
  await asAda("PUT", `${R}/diffinery/agent-review`, { agent: "acme-reviewer", runtime: "claude-code", trigger: "push", autofix: false, accept_terms: true });
  await page.goto(`${base}/acme/storefront/settings/merge-on-green`);
  await page.waitForLoadState("networkidle");
  await page.locator('textarea[name="otherChecks"]').fill("CI / test");
  const others = page.locator('input[name="otherAgents"]');
  if (await others.count()) await others.fill("acme-coder");
  // Agents' pull requests still wait for a person's approval (the page's default lands them as soon as the checks pass).
  await page.getByText("Once the checks pass and a person approved").click();
  await page.waitForFunction(() => document.querySelector('input[name="approval"]')?.value === "approval");
  await page.getByRole("button", { name: /Turn on merge on green|Save/ }).click();
  await page.waitForLoadState("networkidle");

  // The task: Ada asks acme-coder for a feature, Claude Code writes it in a sandbox and opens a pull request.
  const task = await asAda("POST", `${R}/diffinery/tasks`, { goal: "Add discount codes at checkout\n\nLet customers enter a code in the cart. Support WELCOME10 (10% off) and FREESHIP, with tests.", runtime: "claude-code", agent: "acme-coder" });
  const done = await until("the task", async () => {
    const t = await api("GET", `${R}/diffinery/tasks/${task.number}`);
    if (t.state === "failed") throw new Error(`the task failed: ${JSON.stringify(await api("GET", `${R}/diffinery/tasks/${task.number}/transcript`))}`);
    return t.state !== "running" && t.pull_request ? t : null;
  }, 300_000);
  const pr = await api("GET", `${R}/pulls/${done.pull_request.number}`);
  await green(pr.head.sha);
  await until("the agent review", async () => {
    const r = await api("GET", `${R}/pulls/${pr.number}/diffinery/agent-review`);
    if (process.env.DEBUG && r.task) console.error("review", JSON.stringify((await api("GET", `${R}/diffinery/tasks/${r.task.number}`)).runs));
    return r.findings?.length && r.reviewed_sha === pr.head.sha ? r : null;
  }, 300_000);

  // Another agent pull request, still being worked on.
  git(src, ["checkout", "-q", "-b", "agent/order-emails"]);
  writeFileSync(join(src, "src/emails.js"), "export const orderConfirmation = (order) => `Thanks for your order #${order.id}!`;\n");
  git(src, ["add", "-A"]);
  git(src, ["commit", "-qm", "Order confirmation email"]);
  git(src, ["push", "-q", `${base}/acme/storefront.git`, "agent/order-emails"], coder);
  const draft = await api("POST", `${R}/pulls`, { title: "Send an order confirmation email", head: "agent/order-emails", base: "main", draft: true, intent: "Customers get an email with their order number right after paying." }, coder);
  await green(draft.head.sha);
  running = false;
  await jobs;

  // Phase 2: the same data, served as https://diffinery.com to Ada's signed-in browser.
  stop(dev);
  await sleep(2000);
  sql(`INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(SESSION)}', 'ada1', 'passkey', '${at(0)}', '${at(0)}', '${new Date(Date.now() + 86400_000).toISOString()}')`);
  ({ p: dev, base } = await worker(() => ({ PUBLIC_URL: "https://diffinery.com", DEV_AUTH: "" })));

  const shots = [];
  for (const scheme of ["light"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
    // localhost is a secure context, so the browser keeps the __Host- cookie over plain HTTP.
    const site = base.replace("127.0.0.1", "localhost");
    await context.addCookies([{ name: "__Host-dfy_session", value: SESSION, domain: "localhost", path: "/", secure: true, sameSite: "Lax" }]);
    const p = await context.newPage();
    const shot = async (name, path, { clip, locator, height = 900 } = {}) => {
      await p.setViewportSize({ width: 1280, height });
      await p.goto(`${site}${path}`);
      await p.waitForLoadState("networkidle");
      await sleep(500);
      const png = locator ? await p.locator(locator).first().screenshot() : await p.screenshot({ clip });
      shots.push({ name, png, page: p });
    };
    await shot("today", "/", { height: 1000 });
    await shot("agent-task", `/acme/storefront/tasks/${task.number}`, { height: 1100 });
    await shot("agent-pull-request", `/acme/storefront/pull/${pr.number}`, { height: 1200 });
    await shot("merge-on-green", `/acme/storefront/pull/${pr.number}`, { locator: ".mergebox" });
  }

  for (const { name, png, page: p } of shots) {
    writeFileSync(join(README_OUT, `${name}.png`), png);
    const webp = await p.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      c.getContext("2d").drawImage(img, 0, 0);
      return c.toDataURL("image/webp", 0.86).split(",")[1];
    }, png.toString("base64"));
    writeFileSync(join(OUT, `${name}.webp`), Buffer.from(webp, "base64"));
    console.log(`${name}: png ${Math.round(png.length / 1024)} KiB, webp ${Math.round((webp.length * 3) / 4 / 1024)} KiB`);
  }
} finally {
  await browser.close();
  for (const p of procs) stop(p);
  if (process.env.KEEP !== "1") rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  else console.log(`kept ${top}`);
}
