import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import { mentions } from "../../src/mail/notify.js";
import { DEFAULT_PREFS, mergePrefs, wantsEmail } from "../../src/mail/prefs.js";
import { sampleJobs } from "../../src/mail/samples.js";
import { buildMessage, senderAddress } from "../../src/mail/send.js";
import { compose, toHtml, toText } from "../../src/mail/templates.js";
import { categoryOf, isMandatory, type MailJob } from "../../src/mail/types.js";
import { UNSUB_LEGACY_CUTOFF_MS, UNSUB_TTL_MS, readUnsubToken, unsubToken } from "../../src/mail/unsubscribe.js";

const PUB = "https://diffinery.example";
const env = { PUBLIC_URL: PUB, MASTER_KEY: "test-master-key", MAIL_FROM: "notifications@diffinery.example" } as unknown as Env;
const samples = sampleJobs(PUB, { accountId: "acc1" }, "diffy");

describe("email templates", () => {
  it("has a sample for every kind of email", () => {
    const kinds = new Set(samples.map((s) => s.job.kind));
    for (const k of ["email_verify", "signin_new", "passkey_added", "passkey_removed", "token_created", "token_expiring", "agent_created", "model_key_added", "review_limit_reached", "push_bypassed", "push_blocked", "account_status", "invite", "invite_accepted", "welcome", "signin_link", "signup_code", "signup_attempt", "access_request", "org_membership", "repo_access", "repo_created", "repo_deleted", "repo_transferred", "thread", "run", "test"]) {
      expect(kinds.has(k as MailJob["kind"]), k).toBe(true);
    }
  });

  it.each(samples.map((s) => [s.id, s.job] as const))("renders %s as HTML and plain text", async (_id, job) => {
    const msg = await buildMessage(env, job, { email: "diffy@example.com", name: "Diffy", login: "diffy", accountId: "acc1" });
    expect(msg.subject.length).toBeGreaterThan(5);
    expect(msg.subject).not.toMatch(/[\r\n]/);
    expect(msg.html).toMatch(/^<!doctype html>/i);
    expect(msg.html).toContain(`${PUB}/icon-512.png`);
    expect(msg.text.length).toBeGreaterThan(40);
    expect(msg.text).not.toMatch(/<\/?(p|div|table|a)\b/);
    expect(msg.from.email).toBe("notifications@diffinery.example");
    expect(msg.headers["X-Diffinery-Reason"]).toBe(job.reason);
    expect(msg.headers["Auto-Submitted"]).toBe("auto-generated");
    const mandatory = isMandatory(categoryOf(job));
    // Security and account emails can't be turned off, so they carry no unsubscribe link.
    expect(!!msg.headers["List-Unsubscribe"]).toBe(!mandatory);
    if (!mandatory) {
      expect(msg.headers["List-Unsubscribe"]).toMatch(new RegExp(`^<${PUB}/-/unsubscribe/[^>]+>$`));
      expect(msg.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      expect(msg.headers.Precedence).toBe("list");
    }
  });

  it("puts a sign-up code in the message but not the subject (the email log keeps subjects)", async () => {
    const job = samples.find((s) => s.id === "signup-code")!.job;
    const msg = await buildMessage(env, job, { email: "new@example.com" });
    expect(msg.subject).not.toContain("042917");
    expect(msg.text).toMatch(/^ {4}042917$/m);
    expect(msg.html).toContain("042917");
    expect(categoryOf(job)).toBe("account");
    const attempt = await buildMessage(env, samples.find((s) => s.id === "signup-attempt")!.job, { email: "diffy@example.com", login: "diffy", accountId: "acc1" });
    expect(attempt.text).toMatch(/already belongs to your account @diffy/);
    expect(attempt.text).not.toMatch(/\b\d{6}\b/);
  });

  it("threads issue and pull request emails like GitHub", async () => {
    const opened = samples.find((s) => s.id === "pr-opened")!.job;
    const comment = samples.find((s) => s.id === "comment")!.job;
    const a = await buildMessage(env, opened, { email: "a@example.com", accountId: "acc1", login: "diffy" });
    const b = await buildMessage(env, comment, { email: "a@example.com", accountId: "acc1", login: "diffy" });
    expect(a.subject).toBe("[acme/website] Cache build artifacts between workflow runs (PR #42)");
    expect(b.subject).toBe("Re: [acme/website] Cache build artifacts between workflow runs (PR #42)");
    expect(a.headers.References).toBe(b.headers.References);
    expect(a.headers["In-Reply-To"]).toBeUndefined();
    expect(b.headers["In-Reply-To"]).toBe(b.headers.References);
    expect(a.headers["List-Id"]).toBe("acme/website <website.acme.diffinery.example>");
  });

  it("escapes what people write", () => {
    const job = { ...samples.find((s) => s.id === "issue-opened")!.job } as Extract<MailJob, { kind: "thread" }>;
    job.data = { ...job.data, title: `<img src=x onerror=alert(1)>`, body: `<script>alert(1)</script> **bold**` };
    const e = compose(job, PUB, "diffy");
    const html = toHtml(e, { publicUrl: PUB, reason: job.reason, unsubscribe: [] });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("<strong>bold</strong>");
    expect(toText(e, { publicUrl: PUB, reason: job.reason, unsubscribe: [] })).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("sender address", () => {
  it("uses MAIL_FROM, or notifications@ the public host", () => {
    expect(senderAddress(env)).toBe("notifications@diffinery.example");
    expect(senderAddress({ PUBLIC_URL: "https://git.example.com", MAIL_FROM: "" } as Env)).toBe("notifications@git.example.com");
    expect(senderAddress({ PUBLIC_URL: "https://git.example.com" } as Env)).toBe("notifications@git.example.com");
  });
});

describe("images in emails", () => {
  it("links images from other hosts instead of loading them, and keeps Diffinery's own", async () => {
    const issue = samples.find((x) => x.id === "issue-opened")!.job as Extract<MailJob, { kind: "thread" }>;
    const job = { ...issue, data: { ...issue.data, body: `Look: ![pixel](https://tracker.example/p.gif?u=1) and ![logo](${PUB}/icon-512.png)` } } as MailJob;
    const msg = await buildMessage(env, job, { email: "diffy@example.com", name: "Diffy", login: "diffy", accountId: "acc1" });
    expect(msg.html).not.toMatch(/<img[^>]+tracker\.example/);
    expect(msg.html).toContain('<a href="https://tracker.example/p.gif?u=1">[pixel]</a>');
    expect(msg.html).toMatch(new RegExp(`<img[^>]+src="${PUB}/icon-512.png"[^>]*alt="logo"|<img[^>]+alt="logo"[^>]*src="${PUB}/icon-512.png"`));
  });
});

describe("mentions", () => {
  it("finds @logins outside code", () => {
    expect(mentions("Hey @Diffy and @rivera-2, see `@notme` and\n```\n@alsonot\n```\nmail me@example.com")).toEqual(["diffy", "rivera-2"]);
    expect(mentions(null)).toEqual([]);
  });
});

describe("notification settings", () => {
  it("fills in defaults and ignores junk", () => {
    expect(mergePrefs(null)).toEqual(DEFAULT_PREFS);
    const p = mergePrefs({ watching: { email: false, web: "yes" }, ownActivity: true, bogus: 1 });
    expect(p.watching).toEqual({ web: true, email: false });
    expect(p.ownActivity).toBe(true);
    expect(p).not.toHaveProperty("bogus");
  });

  it("never turns off security and account email", () => {
    const off = mergePrefs({ participating: { email: false }, watching: { email: false }, actions: { email: false }, repos: { email: false }, orgs: { email: false } });
    expect(wantsEmail(off, "security")).toBe(true);
    expect(wantsEmail(off, "account")).toBe(true);
    expect(wantsEmail(off, "participating")).toBe(false);
    expect(categoryOf({ kind: "thread", reason: "subscribed" })).toBe("watching");
    expect(categoryOf({ kind: "thread", reason: "mention" })).toBe("participating");
  });
});

describe("one-click unsubscribe", () => {
  it.each(samples.filter((s) => !isMandatory(categoryOf(s.job))).map((s) => [s.id, s.job] as const))("%s: List-Unsubscribe turns that kind of email off", async (_id, job) => {
    const msg = await buildMessage(env, job, { email: "diffy@example.com", login: "diffy", accountId: "acc1" });
    const link = /^<(.+)>$/.exec(msg.headers["List-Unsubscribe"]!)![1]!;
    const token = link.slice(`${PUB}/-/unsubscribe/`.length);
    expect(await readUnsubToken(env, token)).toEqual({ accountId: "acc1", scope: { t: "category", category: categoryOf(job) } });
    expect(msg.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // Muting one thread stays a footer link.
    if (job.kind === "thread") expect(msg.text).toContain("Mute this thread");
  });

  it("is left out without an account to change", async () => {
    const msg = await buildMessage(env, samples.find((s) => s.id === "comment")!.job, { email: "someone@example.com" });
    expect(msg.headers["List-Unsubscribe"]).toBeUndefined();
  });
});

describe("unsubscribe links", () => {
  it("round-trips and rejects tampering", async () => {
    const t = await unsubToken(env, { accountId: "acc1", scope: { t: "thread", repoId: "r1", number: 7, repo: "acme/website" } });
    expect(await readUnsubToken(env, t)).toEqual({ accountId: "acc1", scope: { t: "thread", repoId: "r1", number: 7, repo: "acme/website" } });
    const [payload, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ a: "someone-else", s: { t: "category", category: "watching" } })).toString("base64url");
    expect(await readUnsubToken(env, `${forged}.${sig}`)).toBeNull();
    expect(await readUnsubToken(env, `${payload}.${sig!.slice(0, -2)}xx`)).toBeNull();
    expect(await readUnsubToken({ ...env, MASTER_KEY: "another-key" } as Env, t)).toBeNull();
  });

  it("expire about a year after they're sent", async () => {
    const sent = Date.UTC(2027, 0, 1);
    const t = await unsubToken(env, { accountId: "acc1", scope: { t: "category", category: "watching" } }, sent);
    expect(await readUnsubToken(env, t, sent + UNSUB_TTL_MS - 1000)).toEqual({ accountId: "acc1", scope: { t: "category", category: "watching" } });
    expect(await readUnsubToken(env, t, sent + UNSUB_TTL_MS)).toBeNull();
  });

  it("keep links sent before expiries working only until the cutoff", async () => {
    // A link as they were signed before: no `e`, signed with the same key.
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`diffinery-unsubscribe-v1:${env.MASTER_KEY}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const payload = Buffer.from(JSON.stringify({ a: "acc1", s: { t: "category", category: "watching" } })).toString("base64url");
    const old = `${payload}.${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))).toString("base64url")}`;
    expect(await readUnsubToken(env, old, UNSUB_LEGACY_CUTOFF_MS - 1000)).toEqual({ accountId: "acc1", scope: { t: "category", category: "watching" } });
    expect(await readUnsubToken(env, old, UNSUB_LEGACY_CUTOFF_MS)).toBeNull();
    // An expiry that isn't a number never passes.
    const odd = Buffer.from(JSON.stringify({ a: "acc1", s: { t: "category", category: "watching" }, e: "9999999999" })).toString("base64url");
    const oddToken = `${odd}.${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(odd))).toString("base64url")}`;
    expect(await readUnsubToken(env, oddToken, UNSUB_LEGACY_CUTOFF_MS - 1000)).toBeNull();
  });
});

describe("Markdown in email", () => {
  it("hides HTML comments in the HTML and plain-text parts", async () => {
    const thread = samples.find((s) => s.id === "comment")!.job;
    if (thread.kind !== "thread") throw new Error("expected a thread sample");
    const job = { ...thread, data: { ...thread.data, body: '<!-- claude-projects-attribution: {"github_login":"diffy"} -->\n_Requested by Diffy_\n\nLooks good.' } } as MailJob;
    const msg = await buildMessage(env, job, { email: "diffy@example.com", name: "Diffy", login: "diffy", accountId: "acc1" });
    for (const part of [msg.html, msg.text]) {
      expect(part).not.toContain("claude-projects-attribution");
      expect(part).toContain("Looks good.");
    }
  });
});
