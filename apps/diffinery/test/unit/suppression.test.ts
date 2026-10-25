import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import { contactUris, securityTxt } from "../../src/http/security-txt.js";
import { deliver, RetryableMailError } from "../../src/mail/send.js";
import { checkSignature, readVerifyToken, recordMailEvents, sendSuppression, signEvents, suppressionFor, Suppressions, verifyToken } from "../../src/mail/suppression.js";
import type { MailJob } from "../../src/mail/types.js";
import { testD1 } from "./stubs/d1.js";

const at = "2026-10-01T00:00:00.000Z";
const PUB = "https://diffinery.example";

/** A D1 with one person (ann, Ann@Example.com) and an EMAIL binding that records what it sends. */
function setup() {
  const DB = testD1();
  DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, email, status, created_at) VALUES ('ann', 'ann', 'user', 'Ann@Example.com', 'active', ?)").run(at);
  const sent: Array<{ to: unknown; subject: string }> = [];
  const EMAIL = { send: async (m: { to: unknown; subject: string }) => (sent.push(m), { messageId: `m${sent.length}` }) };
  const env = { DB, EMAIL, PUBLIC_URL: PUB, MASTER_KEY: "test-master-key", MAIL_FROM: "notifications@diffinery.example" } as unknown as Env;
  const log = () => DB.sqlite.prepare("SELECT to_addr, kind, status, detail FROM email_log ORDER BY rowid").all() as Array<{ to_addr: string; kind: string; status: string; detail: string | null }>;
  return { env, DB, sent, log };
}

const job = (over: Partial<MailJob> = {}): MailJob => ({ kind: "test", data: { by: "ann" }, to: { accountId: "ann" }, reason: "account", at, ...over }) as MailJob;
const signinLink = (email: string): MailJob => ({ kind: "signin_link", data: { url: `${PUB}/signin/x`, admin: "root", expiresAt: at }, to: { email }, reason: "account", at });

describe("the suppression check", () => {
  it("sends when the address isn't suppressed", async () => {
    const { env, sent, log } = setup();
    expect((await deliver(env, job())).status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(log()[0]).toMatchObject({ to_addr: "Ann@Example.com", status: "sent" });
  });

  it("sends nothing to a suppressed address, security and sign-in email included, whatever its case", async () => {
    const { env, sent, log } = setup();
    await new Suppressions(env.DB).add({ email: "ann@example.COM", reason: "hard-bounce", detail: "550 5.1.1 User unknown", source: "cloudflare" });
    const notification = job({ kind: "repo_created", data: { repo: "acme/x", creator: "kim", visibility: "private", defaultBranch: "main", description: "" }, reason: "admin" } as Partial<MailJob>);
    const security = job({ kind: "passkey_added", data: { name: "laptop" }, reason: "security_alert" } as Partial<MailJob>);
    for (const j of [job(), notification, security, signinLink(" ANN@example.com "), { ...job(), force: true }]) {
      const r = await deliver(env, j);
      expect(r).toEqual({ status: "skipped", detail: "address is suppressed: email to it bounced permanently" });
    }
    expect(sent).toEqual([]);
    expect(log().every((r) => r.status === "skipped" && r.detail?.startsWith("address is suppressed"))).toBe(true);
    // Another address is not affected.
    expect((await deliver(env, signinLink("bob@example.com"))).status).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("lets only the owner's verification email through, and sends again once removed", async () => {
    const { env, sent } = setup();
    const list = new Suppressions(env.DB);
    await list.add({ email: "ann@example.com", reason: "complaint", source: "webhook" });
    const verify = job({ kind: "email_verify", data: { email: "ann@example.com", url: `${PUB}/settings/email/verify/x`, expiresAt: at } } as Partial<MailJob>);
    expect((await deliver(env, verify)).status).toBe("skipped");
    expect((await deliver(env, verify, { ignoreSuppression: true })).status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect((await list.remove("ANN@example.com"))?.reason).toBe("complaint");
    expect((await deliver(env, job())).status).toBe("sent");
  });
});

describe("bounce and complaint events", () => {
  const ev = (type: string, payload: Record<string, unknown>) => ({ type: `cf.email.sending.${type}`, source: { type: "email.sending" }, payload });

  it("suppresses permanent bounces and complaints only", () => {
    expect(suppressionFor(ev("message.bounced", { recipient: "User@Example.net", bounce: { type: "hard", classification: "permanent_failure", reason: "550 5.1.1 User unknown" } }))).toEqual({ email: "user@example.net", reason: "hard-bounce", detail: "550 5.1.1 User unknown" });
    expect(suppressionFor(ev("message.complained", { recipient: "user@example.net", complaint: { type: "abuse" } }))).toEqual({ email: "user@example.net", reason: "complaint", detail: "Spam complaint (abuse)" });
    expect(suppressionFor(ev("message.bounced", { recipient: "user@example.net", bounce: { type: "soft" } }))).toBeNull();
    expect(suppressionFor(ev("message.deferred", { recipient: "user@example.net", bounce: { type: "soft" } }))).toBeNull();
    expect(suppressionFor(ev("message.delivered", { recipient: "user@example.net" }))).toBeNull();
    expect(suppressionFor(ev("message.bounced", { recipient: "not an address" }))).toBeNull();
    expect(suppressionFor("junk")).toBeNull();
    expect(suppressionFor(null)).toBeNull();
  });

  it("records each suppression and audits it", async () => {
    const { env } = setup();
    const audits: unknown[] = [];
    const r = await recordMailEvents(env.DB, async (e) => void audits.push(e), [ev("message.bounced", { recipient: "a@example.net", bounce: { type: "hard" } }), ev("message.delivered", { recipient: "b@example.net" }), ev("message.complained", { recipient: "a@example.net" })], "cloudflare");
    expect(r).toEqual({ suppressed: ["a@example.net", "a@example.net"], ignored: 1 });
    // The newer event replaces the older one.
    expect(await new Suppressions(env.DB).get("a@example.net")).toMatchObject({ reason: "complaint", source: "cloudflare" });
    expect(await new Suppressions(env.DB).get("b@example.net")).toBeNull();
    expect(audits[0]).toEqual({ action: "email.suppression.add", target: "a@example.net", detail: { reason: "hard-bounce", source: "cloudflare", detail: null } });
  });
});

describe("Email Sending's answer to a send", () => {
  const err = (code: string, message = "nope") => Object.assign(new Error(message), { code });

  it("suppresses a recipient refused for good, and nothing for a temporary failure", () => {
    expect(sendSuppression("Ann@Example.com", { error: err("E_RECIPIENT_SUPPRESSED", "recipient is suppressed") })).toEqual({ email: "ann@example.com", reason: "hard-bounce", detail: "Email Sending refused it: E_RECIPIENT_SUPPRESSED: recipient is suppressed" });
    // The REST API's shape lists permanent bounces per recipient.
    expect(sendSuppression("ann@example.com", { result: { delivered: [], permanent_bounces: ["ANN@example.com"], queued: [] } })).toEqual({ email: "ann@example.com", reason: "hard-bounce", detail: "Email Sending reported a permanent bounce when sending" });
    for (const code of ["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_DELIVERY_FAILED", "E_INTERNAL_SERVER_ERROR", "E_SENDER_NOT_VERIFIED", "E_RECIPIENT_NOT_ALLOWED", "E_VALIDATION_ERROR", ""]) {
      expect(sendSuppression("ann@example.com", { error: err(code) }), code).toBeNull();
    }
    expect(sendSuppression("ann@example.com", { error: new Error("socket hang up") })).toBeNull();
    expect(sendSuppression("ann@example.com", { result: { messageId: "m1" } })).toBeNull();
    expect(sendSuppression("ann@example.com", { result: { delivered: [], permanent_bounces: ["bob@example.com"], queued: ["ann@example.com"] } })).toBeNull();
  });

  it("puts a refused recipient on the list (source send) and audits it; temporary failures change nothing", async () => {
    const { env, log } = setup();
    let fail: Error | null = err("E_RECIPIENT_SUPPRESSED", "recipient is suppressed");
    (env as unknown as { EMAIL: unknown }).EMAIL = {
      send: async () => {
        if (fail) throw fail;
        return { messageId: "m1" };
      },
    };
    const r = await deliver(env, job());
    expect(r).toEqual({ status: "failed", detail: "E_RECIPIENT_SUPPRESSED: recipient is suppressed" });
    expect(await new Suppressions(env.DB).get("ann@example.com")).toMatchObject({ reason: "hard-bounce", source: "send", detail: "Email Sending refused it: E_RECIPIENT_SUPPRESSED: recipient is suppressed" });
    const audit = env.DB.sqlite.prepare("SELECT action, target, detail FROM audit_log").all() as Array<{ action: string; target: string; detail: string }>;
    expect(audit).toEqual([{ action: "email.suppression.add", target: "ann@example.com", detail: JSON.stringify({ reason: "hard-bounce", source: "send", detail: "Email Sending refused it: E_RECIPIENT_SUPPRESSED: recipient is suppressed" }) }]);
    expect(log().at(-1)).toMatchObject({ status: "failed" });
    // The next email to it is skipped by our own list.
    expect((await deliver(env, job())).status).toBe("skipped");

    // Temporary failures (retried, or failed for this send only) leave another address alone.
    const bob = { kind: "test", data: { by: "ann" }, to: { email: "bob@example.com" }, reason: "account", at } as MailJob;
    fail = err("E_RATE_LIMIT_EXCEEDED");
    await expect(deliver(env, bob)).rejects.toBeInstanceOf(RetryableMailError);
    fail = err("E_DAILY_LIMIT_EXCEEDED");
    expect((await deliver(env, bob)).status).toBe("failed");
    expect(await new Suppressions(env.DB).get("bob@example.com")).toBeNull();
    fail = null;
    expect((await deliver(env, bob)).status).toBe("sent");
  });
});

describe("the signed intake", () => {
  const body = JSON.stringify({ type: "message.bounced", payload: { recipient: "a@example.net" } });

  it("accepts a good, recent signature and nothing else", async () => {
    const t = Math.floor(Date.now() / 1000);
    const header = await signEvents("s3cret", body, t);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(await checkSignature("s3cret", header, body)).toBe(true);
    expect(await checkSignature("other", header, body)).toBe(false);
    expect(await checkSignature("s3cret", header, body.replace("a@", "b@"))).toBe(false);
    expect(await checkSignature("s3cret", null, body)).toBe(false);
    expect(await checkSignature("s3cret", "", body)).toBe(false);
    expect(await checkSignature("", header, body)).toBe(false);
    expect(await checkSignature("s3cret", await signEvents("s3cret", body, t - 600), body)).toBe(false);
    expect(await checkSignature("s3cret", header, body, (t + 301) * 1000)).toBe(false);
  });
});

describe("verification links", () => {
  const env = { PUBLIC_URL: PUB, MASTER_KEY: "test-master-key" } as unknown as Env;

  it("round-trip, expire and refuse tampering", async () => {
    const t = await verifyToken(env, { accountId: "ann", email: "Ann@Example.com", expiresAt: Date.now() + 60_000 });
    expect(await readVerifyToken(env, t)).toMatchObject({ accountId: "ann", email: "ann@example.com" });
    expect(await readVerifyToken(env, t, Date.now() + 120_000)).toBeNull();
    const [, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ a: "bob", e: "bob@example.com", x: Date.now() + 60_000 })).toString("base64url");
    expect(await readVerifyToken(env, `${forged}.${sig}`)).toBeNull();
    expect(await readVerifyToken({ ...env, MASTER_KEY: "another" } as Env, t)).toBeNull();
  });
});

describe("security.txt", () => {
  it("is always served, with the instance's own report form as the only contact when nothing else is set", () => {
    const now = Date.parse("2026-10-14T15:30:00Z");
    for (const SECURITY_CONTACT of [undefined, " ", "not a contact", `${PUB}/security/report`]) {
      expect(securityTxt({ PUBLIC_URL: PUB, SECURITY_CONTACT }, now).split("\n")).toEqual([
        `Contact: ${PUB}/security/report`,
        "Expires: 2027-10-09T00:00:00Z",
        `Policy: ${PUB}/docs/security/disclosure`,
        "Preferred-Languages: en",
        `Canonical: ${PUB}/.well-known/security.txt`,
        "",
      ]);
    }
  });

  it("has every RFC 9116 field, the report form first and SECURITY_CONTACT after it, with Expires about a year ahead", () => {
    const now = Date.parse("2026-10-14T15:30:00Z");
    const txt = securityTxt({ PUBLIC_URL: `${PUB}/`, SECURITY_CONTACT: "security@diffinery.example, https://diffinery.example/report" }, now);
    expect(txt.split("\n")).toEqual([
      `Contact: ${PUB}/security/report`,
      "Contact: mailto:security@diffinery.example",
      "Contact: https://diffinery.example/report",
      "Expires: 2027-10-09T00:00:00Z",
      `Policy: ${PUB}/docs/security/disclosure`,
      "Preferred-Languages: en",
      `Canonical: ${PUB}/.well-known/security.txt`,
      "",
    ]);
    expect(contactUris("mailto:a@b.example,tel:+1-555-0100,http://insecure.example,javascript:alert(1)")).toEqual(["mailto:a@b.example", "tel:+1-555-0100"]);
  });
});
