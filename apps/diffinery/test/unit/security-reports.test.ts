import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import type { Account } from "../../src/lib/directory.js";
import { HttpError } from "../../src/lib/util.js";
import { ANONYMOUS_REPORTS_PER_DAY, MAX_DETAILS, MAX_SUMMARY, REPORTS_PER_ACCOUNT_PER_DAY, REPORTS_PER_IP_PER_DAY, SecurityReports, changeReport, reportJson, submitReport, validateReport } from "../../src/lib/security-reports.js";
import type { MailJob } from "../../src/mail/types.js";
import { testD1 } from "./stubs/d1.js";

const at = "2026-10-01T00:00:00.000Z";
const PUB = "https://diffinery.example";

/** A D1 with two site administrators (one disabled), one person, and a mail queue that records what it gets. */
function setup() {
  const DB = testD1();
  const add = DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, email, status, site_admin, created_at) VALUES (?, ?, 'user', ?, ?, ?, ?)");
  add.run("u-root", "root", "root@example.com", "active", 1, at);
  add.run("u-old", "old", "old@example.com", "disabled", 1, at);
  add.run("u-ann", "ann", "ann@example.com", "active", 0, at);
  const queued: MailJob[] = [];
  const MAIL = { sendBatch: async (b: Array<{ body: MailJob }>) => void queued.push(...b.map((m) => m.body)) };
  const env = { DB, MAIL, PUBLIC_URL: PUB } as unknown as Env;
  const audits: Array<{ action: string; target?: string; actorLogin?: string; detail?: unknown }> = [];
  const audit = async (e: (typeof audits)[number]) => void audits.push(e);
  const ann = DB.sqlite.prepare("SELECT * FROM accounts WHERE id = 'u-ann'").get() as unknown as Account;
  const root = DB.sqlite.prepare("SELECT * FROM accounts WHERE id = 'u-root'").get() as unknown as Account;
  return { env, DB, queued, audits, audit, ann, root };
}

const refused = (f: () => unknown, status: number, msg: RegExp) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    expect((e as HttpError).detail).toMatch(msg);
    return;
  }
  throw new Error("expected it to be refused");
};

describe("report validation", () => {
  const good = { summary: "  Stored XSS\n in release notes ", details: "\n\nSteps:\r\n1. Create a release\r\n2. Open it\n\n  ", area: "  /acme/app/releases  ", replyTo: " Researcher@Example.net " };

  it("keeps a one-line summary, the details' lines, the area and a lower-cased reply-to", () => {
    expect(validateReport(good, false)).toEqual({ summary: "Stored XSS in release notes", details: "Steps:\n1. Create a release\n2. Open it", area: "/acme/app/releases", replyTo: "researcher@example.net" });
    expect(validateReport({ ...good, area: " ", replyTo: "" }, true)).toMatchObject({ area: null, replyTo: null });
  });

  it("needs a summary and details, refuses too much rather than cutting it, and checks the address", () => {
    refused(() => validateReport({ ...good, summary: " \n " }, true), 422, /summary/);
    refused(() => validateReport({ ...good, details: "\n  \n" }, true), 422, /Describe the problem/);
    refused(() => validateReport({ ...good, summary: "x".repeat(MAX_SUMMARY + 1) }, true), 422, /200 characters/);
    expect(validateReport({ ...good, summary: "x".repeat(MAX_SUMMARY) }, true).summary).toHaveLength(MAX_SUMMARY);
    refused(() => validateReport({ ...good, details: "x".repeat(MAX_DETAILS + 1) }, true), 422, /20,000 characters/);
    expect(validateReport({ ...good, details: "x".repeat(MAX_DETAILS) }, true).details).toHaveLength(MAX_DETAILS);
    refused(() => validateReport({ ...good, area: "x".repeat(501) }, true), 422, /500 characters/);
    refused(() => validateReport({ ...good, replyTo: "not an address" }, true), 422, /valid email address/);
    refused(() => validateReport({ ...good, summary: 42, details: ["x"] }, true), 422, /summary/);
  });

  it("asks for a reply-to address only from someone who isn't signed in", () => {
    refused(() => validateReport({ ...good, replyTo: "" }, false), 422, /reply to, or sign in/);
    expect(validateReport({ ...good, replyTo: "" }, true).replyTo).toBeNull();
  });
});

describe("sending and triaging reports", () => {
  const input = validateReport({ summary: "Token leak in logs", details: "Tokens show up in job logs.", area: "", replyTo: "" }, true);

  it("stores a report, audits it without its content and emails each active site administrator only the summary", async () => {
    const { env, queued, audits, audit, ann } = setup();
    const r = await submitReport(env, audit, input, ann, "203.0.113.9");
    expect(r).toMatchObject({ summary: "Token leak in logs", reply_to: "ann@example.com", account_id: "u-ann", reporter_login: "ann", state: "new" });
    expect(r.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await new SecurityReports(env.DB).get(r.id)).toMatchObject({ id: r.id, details: "Tokens show up in job logs." });
    expect(audits).toEqual([{ actorId: "u-ann", actorLogin: "ann", action: "security_report.create", target: r.id, detail: { signed_in: true } }]);
    expect(queued).toEqual([{ kind: "security_report", data: { id: r.id, summary: "Token leak in logs" }, to: { accountId: "u-root" }, reason: "admin", at: r.created_at }]);
    expect(JSON.stringify(queued)).not.toContain("job logs");
    expect(reportJson(env, r).html_url).toBe(`${PUB}/settings/admin/security-reports/${r.id}`);
  });

  it("limits reports per day: per IP address for anyone not signed in, per account, and for everyone not signed in together", async () => {
    const { env, audit, ann } = setup();
    const anon = { ...input, replyTo: "x@example.net" };
    for (let i = 0; i < REPORTS_PER_IP_PER_DAY; i++) await submitReport(env, audit, anon, null, "203.0.113.9");
    await expect(submitReport(env, audit, anon, null, "203.0.113.9")).rejects.toMatchObject({ status: 429 });
    // Another network, or signed in from the same one, still works.
    await submitReport(env, audit, anon, null, "198.51.100.7");
    for (let i = 0; i < REPORTS_PER_ACCOUNT_PER_DAY; i++) await submitReport(env, audit, input, ann, "203.0.113.9");
    await expect(submitReport(env, audit, input, ann, "198.51.100.8")).rejects.toMatchObject({ status: 429 });
    // Everyone not signed in, together.
    const fill = env.DB.sqlite.prepare("INSERT INTO security_reports (id, summary, details, ip_hash, created_at) VALUES (lower(hex(randomblob(16))), 's', 'd', ?, ?)");
    for (let i = 0; i < ANONYMOUS_REPORTS_PER_DAY; i++) fill.run(`h${i}`, new Date().toISOString());
    await expect(submitReport(env, audit, anon, null, "192.0.2.1")).rejects.toMatchObject({ status: 429 });
  });

  it("marks a report triaged or resolved with a note, audited; refuses junk", async () => {
    const { env, audits, audit, ann, root } = setup();
    const r = await submitReport(env, audit, input, ann, null);
    audits.length = 0;
    const t = await changeReport(env.DB, audit, root, r.id, "triaged", "  Reproduced.\r\nFix next week. ", "web");
    expect(t).toMatchObject({ state: "triaged", note: "Reproduced.\nFix next week.", updated_by: "root" });
    const done = await changeReport(env.DB, audit, root, r.id, "resolved", undefined, "api");
    expect(done).toMatchObject({ state: "resolved", note: null });
    expect(audits).toEqual([
      { actorId: "u-root", actorLogin: "root", action: "security_report.triage", target: r.id, detail: { from: "new", to: "triaged", note: "Reproduced.\nFix next week.", via: "web" } },
      { actorId: "u-root", actorLogin: "root", action: "security_report.resolve", target: r.id, detail: { from: "triaged", to: "resolved", note: null, via: "api" } },
    ]);
    await expect(changeReport(env.DB, audit, root, r.id, "closed", "", "api")).rejects.toMatchObject({ status: 422 });
    await expect(changeReport(env.DB, audit, root, r.id, "triaged", 7, "api")).rejects.toMatchObject({ status: 422 });
    await expect(changeReport(env.DB, audit, root, "0".repeat(32), "triaged", "", "api")).rejects.toMatchObject({ status: 404 });
    expect(await new SecurityReports(env.DB).counts()).toEqual({ new: 0, triaged: 0, resolved: 1 });
  });
});
