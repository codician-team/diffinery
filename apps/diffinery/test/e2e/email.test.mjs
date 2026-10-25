// End-to-end email: a real `wrangler dev` Worker whose Cloudflare Email Sending
// binding is simulated by Miniflare (it accepts the message and returns a
// message id), the real `diffinery-mail` queue and the real runner agent.
//
//   pnpm --filter @diffinery/runner build && pnpm --filter @diffinery/app e2e
//
// Covers: security emails (tokens, agents), notification settings, the test
// email, every template, watching repositories you create, @mentions, your
// own activity staying quiet, one-click unsubscribe (RFC 8058) turning that
// kind of email off, the footer link muting a thread while mentions still get
// through, failed workflow run emails, and the suppression list: signed bounce
// and complaint intake, no email to a suppressed address, lifting it again; the
// morning digest on its schedule (phase 5c) and Today at phone width.
import "./fresh-connections.mjs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHmac, randomBytes } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AGENT = resolve(APP, "../../containers/runner/dist/agent.mjs");
const work = mkdtempSync(join(tmpdir(), "diffinery-email-e2e-"));
let base;
let dev;
let devLog = "";
let token;
let me;
const eventsSecret = randomBytes(24).toString("hex");

async function api(method, path, body, tok = token) {
  const res = await fetch(`${base}/api/v3${path}`, {
    method,
    headers: { ...(tok === null ? {} : { authorization: `Bearer ${tok}` }), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/**
 * Claim a waiting self-hosted job as a registered runner offering `labels`, the way `diffinery runner`
 * does (personal tokens can't claim jobs): one runner per repository and set of labels.
 */
const e2eRunners = new Map();
async function runnerClaim(repoPath, labels = ["linux"]) {
  const key = `${repoPath} ${labels.join(",")}`;
  if (!e2eRunners.has(key)) {
    const reg = await api("POST", `${repoPath}/actions/runners/registration-token`);
    assert.equal(reg.status, 201, JSON.stringify(reg.json));
    const runner = await api("POST", `${repoPath}/actions/runners/register`, { registration_token: reg.json.token, name: `e2e-runner-${e2eRunners.size + 1}`, labels });
    assert.equal(runner.status, 201, JSON.stringify(runner.json));
    e2eRunners.set(key, runner.json.token);
  }
  const r = await api("POST", `${repoPath}/actions/runners/claim`, {}, e2eRunners.get(key));
  // A repository deleted and created again under the same name needs a new runner.
  if (r.status !== 401) return r;
  e2eRunners.delete(key);
  return runnerClaim(repoPath, labels);
}
async function ok(method, path, body, tok) {
  const r = await api(method, path, body, tok);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** `explain`, if given, says on a timeout where things stood (the polling's own log lines are left out of the tail). */
async function until(what, fn, timeoutMs = 60_000, explain = async () => "") {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(500);
  }
  const tail = devLog
    .split("\n")
    .filter((l) => !/runners\/claim 204/.test(l))
    .join("\n")
    .slice(-4000);
  assert.fail(`timed out waiting for ${what}\n${await explain().catch((e) => `(couldn't say where things stood: ${e.message})`)}\n--- wrangler log tail ---\n${tail}`);
}

/**
 * Waits for a self-hosted job of the repository to claim; on a timeout, says what the push printed and
 * where the repository's runs and their jobs stood, so a job that never became claimable can be told apart.
 */
async function claimJob(repoPath, pushed = "") {
  return until(
    "a job to claim",
    async () => {
      const r = await runnerClaim(repoPath, ["linux"]);
      return r.status === 200 ? r.json : null;
    },
    60_000,
    async () => {
      const runs = (await ok("GET", `${repoPath}/actions/runs?per_page=10`)).workflow_runs;
      const lines = [`push output: ${pushed.trim() || "(none)"}`, `runs: ${runs.length}`];
      for (const r of runs) {
        const jobs = (await ok("GET", `${repoPath}/actions/runs/${r.id}/jobs?filter=all`)).jobs;
        lines.push(`- run ${r.run_number} ${r.head_sha.slice(0, 7)} ${r.status}/${r.conclusion}: ${jobs.map((j) => `${j.name} ${j.status}/${j.conclusion}`).join(", ") || "no jobs"}`);
      }
      return lines.join("\n");
    },
  );
}

/** My emails, newest first, with the full message (kept in local development only). */
const emails = async (q = "") => ok("GET", `/diffinery/emails?per_page=200${q}`);
/** Wait for an email matching `pred` and return it. */
const email = (what, pred) => until(`email: ${what}`, async () => (await emails()).find(pred));

function git(cwd, args, tok = token) {
  const auth = Buffer.from(`x-token:${tok}`).toString("base64");
  return execFileSync("git", ["-c", `http.extraHeader=Authorization: Basic ${auth}`, "-c", "protocol.version=2", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "E2E", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "E2E", GIT_COMMITTER_EMAIL: "e2e@example.com" },
  });
}

/** Pushes main and returns what the server said (a workflow that failed to start says so here). */
function gitPush(cwd) {
  const auth = Buffer.from(`x-token:${token}`).toString("base64");
  const r = spawnSync("git", ["-c", `http.extraHeader=Authorization: Basic ${auth}`, "-c", "protocol.version=2", "push", "origin", "main"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  assert.equal(r.status, 0, `git push failed: ${r.stderr}`);
  return r.stderr.split("\n").filter((l) => l.startsWith("remote:")).join("\n");
}

function spawnAsync(cmd, args, env, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (status) => {
      clearTimeout(t);
      done({ status, out });
    });
  });
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const persist = join(work, "state");
  migratedState(APP, persist);
  dev = spawn("pnpm", ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${base}`, "--var", `MASTER_KEY:${randomBytes(32).toString("base64")}`, "--var", `MAIL_EVENTS_SECRET:${eventsSecret}`, "--show-interactive-dev-session=false"], {
    cwd: APP,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  dev.stdout.on("data", (d) => (devLog += d));
  dev.stderr.on("data", (d) => (devLog += d));
  await until("wrangler dev", async () => {
    try {
      return (await fetch(`${base}/healthz`)).ok;
    } catch {
      return false;
    }
  }, 120_000);
  const res = await fetch(`${base}/api/v3/diffinery/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "email-e2e", scopes: ["admin"] }) });
  assert.equal(res.status, 201, await res.clone().text());
  token = (await res.json()).token;
  me = await ok("GET", "/user");
});

after(() => {
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  }
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
});

test("email: security emails, settings, the test email and every template", async () => {
  // Creating a token is a security email, and it was delivered through the EMAIL binding.
  const tokenMail = await email("token created", (e) => e.kind === "token_created");
  assert.equal(tokenMail.status, "sent", JSON.stringify(tokenMail));
  assert.ok(tokenMail.message_id, "Email Sending returned a message id");
  assert.equal(tokenMail.to_addr, me.email);
  assert.match(tokenMail.subject, /token/i);
  const msg = tokenMail.dev_copy;
  assert.equal(msg.from.email, "notifications@diffinery.com");
  assert.match(msg.html, /email-e2e/);
  assert.match(msg.text, /email-e2e/);
  assert.equal(msg.headers["X-Diffinery-Reason"], "security_alert");
  assert.equal(msg.headers["List-Unsubscribe"], undefined, "security emails can't be turned off");

  // Settings: partial updates, defaults kept, junk refused.
  const defaults = await ok("GET", "/diffinery/notification-settings");
  assert.deepEqual(defaults.participating, { web: true, email: true });
  assert.equal(defaults.actions.failuresOnly, true);
  const changed = await ok("PUT", "/diffinery/notification-settings", { watching: { email: false } });
  assert.deepEqual(changed.watching, { web: true, email: false });
  assert.deepEqual(changed.participating, defaults.participating);
  assert.equal((await api("PUT", "/diffinery/notification-settings", { bogus: true })).status, 422);
  await ok("PUT", "/diffinery/notification-settings", { watching: { email: true } });

  // The test email goes out right away and reports Cloudflare's answer.
  const sent = await ok("POST", "/diffinery/emails/test");
  assert.equal(sent.status, "sent", JSON.stringify(sent));
  assert.ok(sent.messageId);

  // Site admins: delivery status and every template, sent for real.
  const status = await ok("GET", "/diffinery/admin/email");
  assert.equal(status.sending, true);
  assert.equal(status.queue, true);
  const all = await ok("POST", "/diffinery/admin/emails/samples");
  assert.ok(all.total >= 30, `only ${all.total} templates`);
  assert.equal(all.sent, all.total, JSON.stringify(all.results.filter((r) => r.status !== "sent")));

  // The template gallery and the settings page render.
  const gallery = await fetch(`${base}/settings/admin/email`);
  assert.equal(gallery.status, 200);
  assert.match(await gallery.text(), /Send every template to me/);
  const preview = await fetch(`${base}/settings/admin/email/preview/run-failed`);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(await preview.text(), /Run failed/);
  const settings = await fetch(`${base}/settings/notifications`);
  assert.equal(settings.status, 200);
  assert.match(await settings.text(), /Watched repositories/);
});

test("email: watching, mentions, own activity, one-click unsubscribe and failed runs", async () => {
  const owner = me.login;
  // Repositories you create are watched (All activity).
  await ok("POST", "/user/repos", { name: "mailbox" });
  const sub = await ok("GET", `/repos/${owner}/mailbox/subscription`);
  assert.equal(sub.subscribed, true);

  // Adding an agent is a security email.
  const bot = await ok("POST", "/diffinery/agents", { login: "mail-bot" }, null);
  const botToken = bot.token.token;
  await email("agent added", (e) => e.kind === "agent_created");

  // The agent opens an issue that @mentions me.
  const issue = await ok("POST", `/repos/${owner}/mailbox/issues`, { title: "Flaky deploy step", body: `@${owner} can you take a look?` }, botToken);
  const opened = await email("issue opened", (e) => e.kind === "thread" && e.subject.includes(`(Issue #${issue.number})`));
  assert.equal(opened.status, "sent");
  assert.equal(opened.subject, `[${owner}/mailbox] Flaky deploy step (Issue #${issue.number})`);
  assert.equal(opened.dev_copy.headers["X-Diffinery-Reason"], "mention");
  assert.equal(opened.dev_copy.from.name, "mail-bot (Diffinery)");
  assert.match(opened.dev_copy.text, /can you take a look/);

  // My own comment doesn't email me; the agent's reply does (I commented, like GitHub's "comment" reason).
  await ok("POST", `/repos/${owner}/mailbox/issues/${issue.number}/comments`, { body: "On it." });
  await ok("POST", `/repos/${owner}/mailbox/issues/${issue.number}/comments`, { body: "Thanks, the logs are attached." }, botToken);
  const reply = await email("reply", (e) => e.kind === "thread" && e.subject.startsWith("Re: ") && e.dev_copy?.text.includes("logs are attached"));
  assert.equal(reply.dev_copy.headers["X-Diffinery-Reason"], "comment");
  assert.equal(reply.dev_copy.headers["In-Reply-To"], opened.dev_copy.headers.References);

  // One-click unsubscribe from the mail app (RFC 8058) turns that kind of email off: here, Participating.
  const link = /^<(.+)>$/.exec(reply.dev_copy.headers["List-Unsubscribe"])[1];
  assert.ok(link.startsWith(`${base}/-/unsubscribe/`));
  assert.equal(reply.dev_copy.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  const confirm = await fetch(link);
  const confirmPage = await confirm.text();
  assert.match(confirmPage, /Turn off email about issues and pull requests you take part in/);
  // Whoever holds the link doesn't learn the account's email address from it.
  assert.ok(reply.to_addr && !confirmPage.includes(reply.to_addr), "the unsubscribe page doesn't show the email address");
  const unsub = await fetch(link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(unsub.status, 200, await unsub.clone().text());
  assert.equal((await ok("GET", "/diffinery/notification-settings")).participating.email, false);
  assert.equal((await fetch(`${link.slice(0, -4)}AAAA`)).status, 404, "a tampered link is refused");
  // Turned off: the next reply is skipped, not sent.
  await ok("POST", `/repos/${owner}/mailbox/issues/${issue.number}/comments`, { body: "Nobody hears this one." }, botToken);
  const quiet = await email("a skipped reply", (e) => e.kind === "thread" && e.status === "skipped" && e.detail === "turned off participating emails");
  assert.equal(quiet.dev_copy, undefined);
  await ok("PUT", "/diffinery/notification-settings", { participating: { email: true } });

  // The footer's Mute this thread link mutes just the thread (one-click works there too).
  const mute = /Mute this thread: (\S+)/.exec(reply.dev_copy.text)[1];
  assert.match(await (await fetch(mute)).text(), new RegExp(`Mute ${owner}/mailbox#${issue.number}`));
  const muted = await fetch(mute, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(muted.status, 200, await muted.clone().text());
  const page = await (await fetch(`${base}/${owner}/mailbox/issues/${issue.number}`)).text();
  assert.match(page, /You muted this issue/);

  // Muted: a plain comment stays quiet, a mention still gets through.
  await ok("POST", `/repos/${owner}/mailbox/issues/${issue.number}/comments`, { body: "Another update nobody needs." }, botToken);
  await ok("POST", `/repos/${owner}/mailbox/issues/${issue.number}/comments`, { body: `@${owner} this one needs you.` }, botToken);
  await email("mention on a muted thread", (e) => e.kind === "thread" && e.dev_copy?.text.includes("this one needs you"));
  const threadMails = (await emails("&kind=thread")).filter((e) => e.status === "sent" && e.subject.includes(`(Issue #${issue.number})`));
  assert.deepEqual(
    threadMails.map((e) => e.dev_copy.headers["X-Diffinery-Reason"]).reverse(),
    ["mention", "comment", "mention"],
    "opened, the reply and the last mention; not my comment or the muted one",
  );

  // A failed workflow run emails the person who pushed.
  if (!existsSync(AGENT)) return assert.fail(`build the runner first: pnpm --filter @diffinery/runner build (missing ${AGENT})`);
  const src = join(work, "mailbox");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  writeFileSync(join(src, ".github/workflows/ci.yml"), "name: CI\non: push\njobs:\n  test:\n    runs-on: [self-hosted, linux]\n    steps:\n      - name: Unit tests\n        run: echo boom && exit 3\n");
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "Add CI that fails"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/mailbox.git`]);
  const claim = await claimJob(`/repos/${owner}/mailbox`, gitPush(src));
  await spawnAsync(process.execPath, [AGENT], { DIFFINERY_API_URL: claim.api_url, DIFFINERY_JOB_ID: claim.job_id, DIFFINERY_JOB_TOKEN: claim.token, DIFFINERY_WORK_ROOT: join(work, `job-${claim.job_id}`) }, 180_000);
  const failed = await email("run failed", (e) => e.kind === "run" && e.subject.includes(`${owner}/mailbox`));
  assert.equal(failed.status, "sent");
  assert.match(failed.subject, new RegExp(`^\\[${owner}/mailbox\\] Run failed: CI - main \\([0-9a-f]{7}\\)$`));
  assert.equal(failed.dev_copy.headers["X-Diffinery-Reason"], "ci_activity");
  assert.match(failed.dev_copy.text, /test/);

  // Ignoring the repository silences its runs too, even the ones you pushed.
  const runOnce = async (file) => {
    writeFileSync(join(src, file), `${file}\n`);
    git(src, ["add", "-A"]);
    git(src, ["commit", "-q", "-m", `Add ${file}`]);
    const c = await claimJob(`/repos/${owner}/mailbox`, gitPush(src));
    await spawnAsync(process.execPath, [AGENT], { DIFFINERY_API_URL: c.api_url, DIFFINERY_JOB_ID: c.job_id, DIFFINERY_JOB_TOKEN: c.token, DIFFINERY_WORK_ROOT: join(work, `job-${c.job_id}`) }, 180_000);
  };
  await ok("PUT", `/repos/${owner}/mailbox/subscription`, { ignored: true });
  await runOnce("ignored.txt");
  const ignoredSha = git(src, ["rev-parse", "--short=7", "HEAD"]).trim();
  await until("the ignored run to finish", async () => {
    const r = await ok("GET", `/repos/${owner}/mailbox/actions/runs?head_sha=${git(src, ["rev-parse", "HEAD"]).trim()}`);
    return r.workflow_runs[0]?.status === "completed" ? r : null;
  });
  // The run's event goes through two queues (1 s batches here); give them a few rounds.
  await new Promise((r) => setTimeout(r, 8000));
  const ignoredMails = (await emails("&kind=run")).filter((e) => e.subject.includes(`(${ignoredSha})`));
  assert.deepEqual(ignoredMails, [], "no email for a run in an ignored repository");
  // Back to the default, and run emails come again.
  await ok("DELETE", `/repos/${owner}/mailbox/subscription`);
  await runOnce("watched.txt");
  const watchedSha = git(src, ["rev-parse", "--short=7", "HEAD"]).trim();
  await email("run failed after un-ignoring", (e) => e.kind === "run" && e.subject.includes(`(${watchedSha})`));
});

test("email: a commit blocked by push protection, made without git, is emailed like a blocked push", async () => {
  await ok("POST", "/user/repos", { name: "leak-mail", auto_init: true });
  // Built at run time so this file holds no credential-shaped string.
  const leak = `AWS_ACCESS_KEY_ID=${"AKIA"}IOSFODNN7EXAMPL3\n`;
  const r = await api("PUT", `/repos/${me.login}/leak-mail/contents/config.env`, { message: "leak", content: Buffer.from(leak).toString("base64") });
  assert.equal(r.status, 422, JSON.stringify(r.json));
  const blocked = await email("blocked commit", (e) => e.kind === "push_blocked" && /leak-mail/.test(e.subject));
  assert.equal(blocked.to_addr, me.email);
  assert.match(blocked.dev_copy.text, /config\.env/);
  assert.match(blocked.dev_copy.text, /AWS access key/);
});

/** POST bounce or complaint events to the signed intake; `sign` false sends no signature, a string signs with that secret. */
function postEvents(events, sign = eventsSecret, t = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(events);
  const headers = { "content-type": "application/json" };
  if (sign) headers["x-diffinery-signature"] = `t=${t},v1=${createHmac("sha256", sign).update(`${t}.${body}`).digest("hex")}`;
  return fetch(`${base}/-/email/events`, { method: "POST", headers, body });
}

test("email: bounces and complaints suppress an address; its owner lifts it by verifying, an admin removes it", async () => {
  const bounce = (recipient) => ({ type: "cf.email.sending.message.bounced", source: { type: "email.sending" }, payload: { recipient, bounce: { type: "hard", classification: "permanent_failure", reason: "550 5.1.1 User unknown" } } });

  // The intake refuses anything without a good, recent signature, and changes nothing.
  for (const r of [await postEvents([bounce(me.email)], false), await postEvents([bounce(me.email)], "not-the-secret"), await postEvents([bounce(me.email)], eventsSecret, Math.floor(Date.now() / 1000) - 3600)]) {
    assert.equal(r.status, 401, await r.text());
  }
  assert.equal((await ok("GET", "/diffinery/email")).suppressed, null);
  assert.equal((await ok("POST", "/diffinery/emails/test")).status, "sent");

  // An authenticated permanent bounce suppresses my address; a soft one and a delivery change nothing.
  const soft = { type: "cf.email.sending.message.deferred", payload: { recipient: "soft@example.com", bounce: { type: "soft" } } };
  const r = await postEvents({ events: [bounce(me.email.toUpperCase()), soft, { type: "cf.email.sending.message.delivered", payload: { recipient: "x@example.com" } }] });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { suppressed: 1, ignored: 2 });
  const mine = await ok("GET", "/diffinery/email");
  assert.equal(mine.suppressed.reason, "hard-bounce");
  assert.equal(mine.suppressed.detail, "550 5.1.1 User unknown");
  assert.equal(mine.suppressed.owner_can_lift, true);

  // Then nothing is sent to it: not the test email, not a security email.
  const test = await ok("POST", "/diffinery/emails/test");
  assert.deepEqual(test, { status: "skipped", detail: "address is suppressed: email to it bounced permanently" });
  await ok("POST", "/diffinery/tokens", { name: "after-bounce", scopes: ["read"] }, null);
  const skipped = await email("token email skipped", (e) => e.kind === "token_created" && e.status === "skipped");
  assert.match(skipped.detail, /address is suppressed/);
  assert.equal((await emails("&kind=token_created")).filter((e) => e.status === "sent" && e.created_at >= skipped.created_at).length, 0);

  // The settings pages say so; admins see it in the list and the audit log.
  assert.match(await (await fetch(`${base}/settings/email`)).text(), /email to it bounced permanently[\s\S]*Send a verification email/);
  assert.match(await (await fetch(`${base}/settings/notifications`)).text(), /Settings → Email/);
  const list = await ok("GET", "/diffinery/admin/email/suppressions");
  assert.ok(list.some((x) => x.email === me.email.toLowerCase() && x.source === "webhook"));
  assert.match(await (await fetch(`${base}/settings/admin/email`)).text(), /Suppressed addresses/);

  // Re-verifying lifts it: the verification email is the one that goes through.
  const v = await ok("POST", "/diffinery/email/verification");
  assert.equal(v.status, "sent", JSON.stringify(v));
  const vmail = await email("verification email", (e) => e.kind === "email_verify" && e.status === "sent");
  const verifyUrl = /(http\S+\/settings\/email\/verify\/\S+)/.exec(vmail.dev_copy.text)[1];
  const form = await fetch(verifyUrl);
  const html = await form.text();
  assert.equal(form.status, 200, html);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  const cookie = /dfy_csrf=([^;]+)/.exec(form.headers.get("set-cookie") ?? "")?.[1];
  const lift = await fetch(verifyUrl, { method: "POST", body: new URLSearchParams({ _csrf: csrf }), redirect: "manual", headers: { cookie: `dfy_csrf=${cookie}`, "sec-fetch-site": "same-origin" } });
  assert.equal(lift.status, 303);
  assert.equal((await ok("GET", "/diffinery/email")).suppressed, null);
  assert.equal((await ok("POST", "/diffinery/emails/test")).status, "sent");
  assert.equal((await fetch(`${verifyUrl.slice(0, -4)}AAAA`)).status, 404, "a tampered link is refused");

  // A complaint about an address without an account; an admin removes it, audited.
  const complaint = await postEvents({ type: "cf.email.sending.message.complained", payload: { recipient: "friend@example.com", complaint: { type: "abuse" } } });
  assert.deepEqual(await complaint.json(), { suppressed: 1, ignored: 0 });
  const invite = await ok("POST", "/invitations", { email: "friend@example.com" });
  assert.ok(invite);
  const inviteMail = await until("invite email skipped", async () => (await ok("GET", "/diffinery/emails?all=1&kind=invite&per_page=50")).find((e) => e.to_addr === "friend@example.com"));
  assert.equal(inviteMail.status, "skipped");
  assert.match(inviteMail.detail, /reported as spam/);
  assert.equal((await api("DELETE", "/diffinery/admin/email/suppressions/friend@example.com")).status, 204);
  assert.equal((await api("DELETE", "/diffinery/admin/email/suppressions/friend@example.com")).status, 404);
  assert.ok(!(await ok("GET", "/diffinery/admin/email/suppressions")).some((x) => x.email === "friend@example.com"));
  const audit = await (await fetch(`${base}/settings/audit`)).text();
  for (const action of ["email.suppression.add", "email.suppression.lift", "email.suppression.remove"]) assert.match(audit, new RegExp(action.replaceAll(".", "\\.")));
});

test("email: the morning digest on its schedule, one-click unsubscribe, and Today on a phone (phase 5c)", async () => {
  const S = "/diffinery/notification-settings";
  // The template gallery in the first test already sent a sample digest; count from here.
  const sample = (await emails()).filter((e) => e.kind === "digest").map((e) => e.id ?? `${e.created_at} ${e.subject}`);
  const digests = async () => (await emails()).filter((e) => e.kind === "digest" && !sample.includes(e.id ?? `${e.created_at} ${e.subject}`));
  assert.deepEqual((await ok("GET", S)).digest, { email: false, hour: 8, timeZone: "UTC", weekends: false });
  assert.equal((await api("PUT", S, { digest: { hour: 24 } })).status, 422);
  assert.equal((await api("PUT", S, { digest: { timeZone: "Mars/Olympus" } })).status, 422);

  // On, for the next hour in Tokyo, every day.
  const hour = (Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hourCycle: "h23" }).format(new Date())) + 1) % 24;
  const saved = await ok("PUT", S, { digest: { email: true, hour, timeZone: "Asia/Tokyo", weekends: true } });
  assert.deepEqual(saved.digest, { email: true, hour, timeZone: "Asia/Tokyo", weekends: true });
  const next = /The next one goes out <time datetime="([^"]+)"/.exec(await (await fetch(`${base}/settings/notifications`)).text())?.[1];
  assert.ok(next && Date.parse(next) > Date.now() && Date.parse(next) <= Date.now() + 3600_000, `next digest at ${next}`);
  assert.equal(new Date(next).getUTCMinutes(), 0);

  // The five-minute cron sends nothing before the hour, then queues it once; it goes out like any email.
  const cron = (t) => fetch(`${base}/cdn-cgi/local/scheduled?cron=${encodeURIComponent("*/5 * * * *")}&time=${t}`);
  assert.equal((await cron(Date.parse(next) - 10 * 60_000)).status, 200);
  await sleep(2000);
  assert.equal((await digests()).length, 0);
  assert.equal((await cron(Date.parse(next) + 2 * 60_000)).status, 200);
  const d = await until("the morning digest", async () => (await digests())[0]);
  assert.equal(d.status, "sent", d.detail);
  assert.match(d.subject, /^\[Diffinery\] Today: /);
  assert.equal(d.dev_copy.headers["X-Diffinery-Kind"], "digest");
  assert.equal(d.dev_copy.headers["X-Diffinery-Reason"], "digest");
  assert.match(d.dev_copy.text, /Failed runs · \d+/);
  assert.ok(d.dev_copy.text.includes(`Open Today: ${base}/`));
  assert.match(d.dev_copy.text, /you turned on the morning digest/);
  assert.equal((await cron(Date.parse(next) + 7 * 60_000)).status, 200);
  await sleep(3000);
  assert.equal((await digests()).length, 1, "the next run doesn't send it again");
  assert.match(await (await fetch(`${base}/settings/notifications`)).text(), /The next one goes out/);

  // The mail app's one-click unsubscribe turns off only the digest.
  const link = /^<(.+)>$/.exec(d.dev_copy.headers["List-Unsubscribe"])[1];
  const unsub = await fetch(link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(unsub.status, 200);
  const off = await ok("GET", S);
  assert.equal(off.digest.email, false);
  assert.equal(off.participating.email, true);
  assert.doesNotMatch(await (await fetch(`${base}/settings/notifications`)).text(), /The next one goes out/);

  // Asked for, it is sent now even while off.
  const now = await ok("POST", "/diffinery/emails/digest");
  assert.equal(now.status, "sent", JSON.stringify(now));
  assert.equal((await digests()).length, 2);

  // The settings form: the browser's time zone, filled in by the page.
  const formPage = await fetch(`${base}/settings/notifications`);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await formPage.text())?.[1];
  const cookie = /dfy_csrf=([^;]+)/.exec(formPage.headers.get("set-cookie") ?? "")?.[1];
  const fields = [["_csrf", csrf], ...["participating.web", "participating.email", "watching.web", "watching.email", "actions.web", "actions.email", "actions.failuresOnly", "repos.email", "orgs.email", "autoWatch"].map((k) => [k, "1"]), ["digest.email", "1"], ["digest.hour", "7"], ["digest.timeZone", "browser"], ["digest.browserTimeZone", "Europe/Istanbul"]];
  const posted = await fetch(`${base}/settings/notifications`, { method: "POST", redirect: "manual", headers: { cookie: `dfy_csrf=${cookie}`, "sec-fetch-site": "same-origin" }, body: new URLSearchParams(fields) });
  assert.equal(posted.status, 303);
  assert.deepEqual((await ok("GET", S)).digest, { email: true, hour: 7, timeZone: "Europe/Istanbul", weekends: false });

  // On a phone: the page fills in the browser's zone, nothing scrolls sideways, and Today comes before the repository list.
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "America/Sao_Paulo", isMobile: true, hasTouch: true })).newPage();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.goto(`${base}/settings/notifications`);
    assert.equal(await page.locator("input[data-browser-tz]").inputValue(), "America/Sao_Paulo");
    assert.equal(await overflow(), 0, "the settings page scrolls sideways");
    if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "notifications-390.png"), fullPage: true });
    await page.goto(`${base}/`);
    assert.equal(await overflow(), 0, "Today scrolls sideways");
    const today = await page.locator("h1", { hasText: "Today" }).boundingBox();
    const side = await page.locator("h3", { hasText: /repositories/i }).first().boundingBox();
    assert.ok(today && side && today.y < side.y, "Today comes first");
    if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "today-390.png"), fullPage: true });
  } finally {
    await browser.close();
  }
});
