import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import type { Account, Directory } from "../../src/lib/directory.js";
import {
  EMAILS_PER_ADDRESS_PER_DAY,
  EMAILS_PER_DAY,
  EarlyAccess,
  MAX_COMPANY,
  MAX_NAME,
  MAX_USE_CASE,
  MIN_FILL_MS,
  MAX_FORM_AGE_MS,
  SUBMISSIONS_PER_IP_PER_DAY,
  checkStamp,
  confirmRequest,
  declineRequest,
  deleteRequest,
  formStamp,
  inviteRequest,
  removeByToken,
  requestJson,
  requestRemoval,
  submitRequest,
  validateRequest,
  type RequestInput,
} from "../../src/lib/early-access.js";
import { pruneExpired } from "../../src/lib/retention.js";
import { HttpError } from "../../src/lib/util.js";
import type { MailJob } from "../../src/mail/types.js";
import { testD1 } from "./stubs/d1.js";

const at = "2026-10-01T00:00:00.000Z";
const PUB = "https://diffinery.example";
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

/** A D1 with two site administrators (one disabled), a person, a disabled person, and a mail queue that records what it gets. */
function setup() {
  const DB = testD1();
  const add = DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, email, status, site_admin, created_at) VALUES (?, ?, 'user', ?, ?, ?, ?)");
  add.run("u-root", "root", "root@example.com", "active", 1, at);
  add.run("u-old", "old", "old@example.com", "disabled", 1, at);
  add.run("u-ann", "ann", "ann@example.com", "active", 0, at);
  add.run("u-gone", "gone", "gone@example.com", "disabled", 0, at);
  const queued: MailJob[] = [];
  const MAIL = { sendBatch: async (b: Array<{ body: MailJob }>) => void queued.push(...b.map((m) => m.body)) };
  const env = { DB, MAIL, PUBLIC_URL: PUB, MASTER_KEY } as unknown as Env;
  const audits: Array<{ action: string; target?: string; actorLogin?: string; detail?: unknown }> = [];
  const audit = async (e: (typeof audits)[number]) => void audits.push(e);
  const root = DB.sqlite.prepare("SELECT * FROM accounts WHERE id = 'u-root'").get() as unknown as Account;
  const invites: Array<{ email: string; role: string }> = [];
  const dir = {
    accountByEmail: async (email: string) => (DB.sqlite.prepare("SELECT * FROM accounts WHERE email = ? AND kind = 'user'").get(email) as unknown as Account) ?? null,
    createInvite: async (_inviter: Account, input: { email: string; role: string }) => {
      invites.push(input);
      const id = `inv-${invites.length}`;
      DB.sqlite.prepare("INSERT INTO invites (id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.email, input.role, `h-${id}`, "u-root", at, "2999-01-01T00:00:00.000Z");
      return { id, url: `${PUB}/invite/x`, token: "x" };
    },
  } as unknown as Directory;
  return { env, DB, queued, audits, audit, root, dir, invites };
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

const rejects = async (p: Promise<unknown>, status: number, msg: RegExp) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(HttpError);
  expect((e as HttpError).status).toBe(status);
  expect((e as HttpError).detail).toMatch(msg);
};

const input = (email: string, over: Partial<RequestInput> = {}): RequestInput => ({ email, name: "Ada", company: "Acme", useCase: "Move our CI", hosting: "github", ...over });
const tokenOf = (job: MailJob | undefined) => /#([A-Za-z0-9_-]+)$/.exec((job as { data: { url: string } }).data.url)![1]!;

describe("request validation", () => {
  it("needs only a valid email address, lower-cases it and tidies the other fields", () => {
    expect(validateRequest({ email: " Ada@Example.COM " })).toEqual({ email: "ada@example.com", name: null, company: null, useCase: null, hosting: null });
    expect(validateRequest({ email: "a@b.co", name: "  Ada \n Lovelace ", company: " Acme\tLabs ", useCase: "\r\nLine one\r\n\r\n\r\n\r\nLine two  ", hosting: "gitlab" })).toEqual({ email: "a@b.co", name: "Ada Lovelace", company: "Acme Labs", useCase: "Line one\n\nLine two", hosting: "gitlab" });
  });

  it("strips control and text-direction characters that could disguise text", () => {
    expect(validateRequest({ email: "a@b.co", name: "Ad‮a\u0000⁦x", useCase: "ok\u0007‏" })).toMatchObject({ name: "Adax", useCase: "ok" });
  });

  it("refuses a missing or bad address, too much text (never cut) and an unknown hosting answer", () => {
    refused(() => validateRequest({ email: "  " }), 422, /Enter your email address/);
    refused(() => validateRequest({ email: "not-an-address" }), 422, /valid email address/);
    refused(() => validateRequest({ email: "<script>@x.y" }), 422, /valid email address/);
    refused(() => validateRequest({ email: `${"a".repeat(250)}@b.co` }), 422, /valid email address/);
    refused(() => validateRequest({ email: "a@b.co", name: "x".repeat(MAX_NAME + 1) }), 422, /100 characters/);
    refused(() => validateRequest({ email: "a@b.co", company: "x".repeat(MAX_COMPANY + 1) }), 422, /120 characters/);
    refused(() => validateRequest({ email: "a@b.co", useCase: "x".repeat(MAX_USE_CASE + 1) }), 422, /1,000 characters/);
    expect(validateRequest({ email: "a@b.co", useCase: "x".repeat(MAX_USE_CASE) }).useCase).toHaveLength(MAX_USE_CASE);
    refused(() => validateRequest({ email: "a@b.co", hosting: "sourceforge" }), 422, /from the list/);
    refused(() => validateRequest({ email: ["a@b.co"] }), 422, /Enter your email address/);
  });
});

describe("the form's timing stamp", () => {
  const env = { MASTER_KEY, PUBLIC_URL: PUB } as unknown as Env;

  it("takes a genuine stamp between 3 seconds and 24 hours old", async () => {
    const t = Date.now();
    const stamp = await formStamp(env, t);
    expect(await checkStamp(env, stamp, t + MIN_FILL_MS + 1)).toBe("ok");
    expect(await checkStamp(env, stamp, t + 500)).toBe("fast");
    expect(await checkStamp(env, stamp, t + MAX_FORM_AGE_MS + 1)).toBe("stale");
  });

  it("refuses a missing, forged or future stamp, and one signed with another key", async () => {
    const t = Date.now();
    const stamp = await formStamp(env, t);
    expect(await checkStamp(env, "", t)).toBe("bad");
    expect(await checkStamp(env, `${t - 60_000}.${stamp.split(".")[1]}`, t)).toBe("bad");
    expect(await checkStamp(env, await formStamp(env, t + 3600_000), t)).toBe("bad");
    const other = { MASTER_KEY: btoa("x".repeat(32)), PUBLIC_URL: PUB } as unknown as Env;
    expect(await checkStamp(other, stamp, t + 5000)).toBe("bad");
    // A key rotation still takes stamps made with the previous key.
    expect(await checkStamp({ ...other, MASTER_KEY_PREV: MASTER_KEY } as Env, stamp, t + 5000)).toBe("ok");
  });
});

describe("requesting and confirming", () => {
  it("stores a new request unconfirmed and emails only a confirmation link, with nothing typed in it", async () => {
    const { env, queued } = setup();
    expect(await submitRequest(env, input("new@example.net", { name: "<b>Ada</b>" }), "203.0.113.9")).toBe("confirm");
    const r = (await new EarlyAccess(env.DB).byEmail("new@example.net"))!;
    expect(r).toMatchObject({ state: "unconfirmed", name: "<b>Ada</b>", company: "Acme", use_case: "Move our CI", hosting: "github", confirmed_at: null });
    expect(r.confirm_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "early_access_confirm", to: { email: "new@example.net" }, reason: "early_access" });
    expect((queued[0] as { data: { url: string } }).data.url).toMatch(new RegExp(`^${PUB}/early-access/confirm#[A-Za-z0-9_-]{32}$`));
    expect(JSON.stringify(queued)).not.toMatch(/Ada|Acme|Move our CI/);
    // Only hashes of the IP address and the address are kept for the limits.
    const attempts = env.DB.sqlite.prepare("SELECT * FROM early_access_attempts").all() as Array<Record<string, string>>;
    expect(JSON.stringify(attempts)).not.toMatch(/203\.0\.113\.9|new@example/);
  });

  it("confirms once with the newest link, and tells every active site administrator once", async () => {
    const { env, queued, audits, audit, DB } = setup();
    await submitRequest(env, input("new@example.net"), "203.0.113.9");
    const first = tokenOf(queued[0]);
    await submitRequest(env, input("new@example.net", { name: "Ada L." }), "203.0.113.9");
    const second = tokenOf(queued[1]);
    expect(await confirmRequest(env, audit, first)).toBeNull();
    const r = await confirmRequest(env, audit, second);
    expect(r).toMatchObject({ state: "confirmed", name: "Ada L.", confirm_hash: null });
    expect(await confirmRequest(env, audit, second)).toBeNull();
    expect(audits).toEqual([{ action: "early_access.confirm", target: r!.id }]);
    const notes = () => DB.sqlite.prepare("SELECT account_id, kind, url FROM notifications").all();
    expect(notes()).toEqual([{ account_id: "u-root", kind: "early_access", url: "/settings/admin/early-access" }]);
    // Another confirmation while that one is unread adds nothing.
    await submitRequest(env, input("two@example.net"), "203.0.113.10");
    await confirmRequest(env, audit, tokenOf(queued[2]));
    expect(notes()).toHaveLength(1);
    expect(await new EarlyAccess(env.DB).waiting()).toBe(2);
  });

  it("refuses an expired, malformed or unknown token", async () => {
    const { env, queued, audit, DB } = setup();
    await submitRequest(env, input("new@example.net"), "203.0.113.9");
    DB.sqlite.prepare("UPDATE early_access SET confirm_expires_at = ?").run(at);
    expect(await confirmRequest(env, audit, tokenOf(queued[0]))).toBeNull();
    expect(await confirmRequest(env, audit, "short")).toBeNull();
    expect(await confirmRequest(env, audit, "x".repeat(40))).toBeNull();
  });

  it("answers an address that already asked, was invited or has an account only in its own inbox, and changes nothing", async () => {
    const { env, queued, audit } = setup();
    await submitRequest(env, input("new@example.net"), "203.0.113.9");
    await confirmRequest(env, audit, tokenOf(queued[0]));
    expect(await submitRequest(env, input("new@example.net", { name: "Mallory" }), "198.51.100.1")).toBe("known");
    expect(queued[1]).toMatchObject({ kind: "early_access_known", data: { variant: "waiting" }, to: { email: "new@example.net" } });
    expect((await new EarlyAccess(env.DB).byEmail("new@example.net"))!.name).toBe("Ada");
    expect(await submitRequest(env, input("ANN@example.com"), "198.51.100.1")).toBe("account");
    expect(queued[2]).toMatchObject({ kind: "early_access_known", data: { variant: "account" }, to: { accountId: "u-ann" } });
    expect(await new EarlyAccess(env.DB).byEmail("ann@example.com")).toBeNull();
    expect(await submitRequest(env, input("gone@example.com"), "198.51.100.1")).toBe("quiet");
    expect(queued).toHaveLength(3);
  });

  it("limits submissions per IP address (a visible 429) and emails per address and in total (silently)", async () => {
    const { env, queued, DB } = setup();
    for (let i = 0; i < EMAILS_PER_ADDRESS_PER_DAY; i++) expect(await submitRequest(env, input("flood@example.net"), `10.0.0.${i}`)).toBe("confirm");
    expect(await submitRequest(env, input("flood@example.net"), "10.0.1.1")).toBe("limited");
    expect(queued).toHaveLength(EMAILS_PER_ADDRESS_PER_DAY);
    for (let i = 0; i < SUBMISSIONS_PER_IP_PER_DAY; i++) await submitRequest(env, input(`p${i}@example.net`), "192.0.2.1");
    await rejects(submitRequest(env, input("one-more@example.net"), "192.0.2.1"), 429, /Too many requests from your network today/);
    // Everyone together: the form stops emailing at EMAILS_PER_DAY.
    const add = DB.sqlite.prepare("INSERT INTO early_access_attempts (id, ip_hash, email_hash, emailed, created_at) VALUES (?, 'x', 'y', 1, ?)");
    for (let i = 0; i < EMAILS_PER_DAY; i++) add.run(`a${i}`, new Date().toISOString());
    const before = queued.length;
    expect(await submitRequest(env, input("late@example.net"), "192.0.2.200")).toBe("limited");
    expect(queued).toHaveLength(before);
    expect(await new EarlyAccess(env.DB).byEmail("late@example.net")).toBeNull();
  });
});

describe("site administrators' decisions", () => {
  async function confirmed(s: ReturnType<typeof setup>, email: string) {
    await submitRequest(s.env, input(email), "203.0.113.9");
    return (await confirmRequest(s.env, s.audit, tokenOf(s.queued.at(-1))))!;
  }

  it("invites with the instance invitation, audited, and won't invite twice or invite an account", async () => {
    const s = setup();
    const r = await confirmed(s, "new@example.net");
    const done = await inviteRequest(s.env, s.dir, s.audit, s.root, r.id, "web");
    expect(done).toMatchObject({ state: "invited", invite_id: "inv-1", decided_by: "root" });
    expect(s.invites).toEqual([{ email: "new@example.net", role: "read" }]);
    expect(s.audits.slice(-2)).toEqual([
      { actorId: "u-root", actorLogin: "root", action: "invite.create", target: "new@example.net" },
      { actorId: "u-root", actorLogin: "root", action: "early_access.invite", target: r.id, detail: { invite: "inv-1", from: "confirmed", via: "web" } },
    ]);
    await rejects(inviteRequest(s.env, s.dir, s.audit, s.root, r.id, "web"), 422, /already invited/);
    // A request whose address then got an account.
    s.DB.sqlite.prepare("INSERT INTO early_access (id, email, state, created_at, updated_at) VALUES ('0123456789abcdef0123456789abcdef', 'ann@example.com', 'confirmed', ?, ?)").run(at, at);
    await rejects(inviteRequest(s.env, s.dir, s.audit, s.root, "0123456789abcdef0123456789abcdef", "api"), 422, /already has an account \(ann\)/);
    await rejects(inviteRequest(s.env, s.dir, s.audit, s.root, "ffffffffffffffffffffffffffffffff", "api"), 404, /no early access request/);
  });

  it("keeps a pending instance invitation instead of sending another", async () => {
    const s = setup();
    const r = await confirmed(s, "pending@example.net");
    s.DB.sqlite.prepare("INSERT INTO invites (id, email, role, token_hash, invited_by, created_at, expires_at) VALUES ('inv-old', 'pending@example.net', 'read', 'h', 'u-root', ?, '2999-01-01T00:00:00.000Z')").run(at);
    expect(await inviteRequest(s.env, s.dir, s.audit, s.root, r.id, "api")).toMatchObject({ state: "invited", invite_id: "inv-old" });
    expect(s.invites).toEqual([]);
    expect(s.audits.at(-1)).toMatchObject({ action: "early_access.invite", detail: { invite: "inv-old", existing_invitation: true } });
  });

  it("declines without email, puts back where it was, and deletes without keeping the content", async () => {
    const s = setup();
    const r = await confirmed(s, "new@example.net");
    const mails = s.queued.length;
    expect(await declineRequest(s.env.DB, s.audit, s.root, r.id, false, "web")).toMatchObject({ state: "declined", decided_by: "root" });
    await rejects(declineRequest(s.env.DB, s.audit, s.root, r.id, false, "web"), 422, /already declined/);
    expect(await declineRequest(s.env.DB, s.audit, s.root, r.id, true, "api")).toMatchObject({ state: "confirmed", decided_by: null });
    await rejects(declineRequest(s.env.DB, s.audit, s.root, r.id, true, "api"), 422, /Only a declined request/);
    expect(s.queued).toHaveLength(mails);
    await deleteRequest(s.env.DB, s.audit, s.root, r.id, "web");
    expect(await new EarlyAccess(s.env.DB).get(r.id)).toBeNull();
    expect(s.audits.at(-1)).toEqual({ actorId: "u-root", actorLogin: "root", action: "early_access.delete", target: r.id, detail: { state: "confirmed", via: "web" } });
    expect(JSON.stringify(s.audits)).not.toMatch(/new@example\.net/);
    // An unconfirmed request that is declined then put back is unconfirmed again.
    await submitRequest(s.env, input("u@example.net"), "203.0.113.9");
    const u = (await new EarlyAccess(s.env.DB).byEmail("u@example.net"))!;
    await declineRequest(s.env.DB, s.audit, s.root, u.id, false, "web");
    expect((await declineRequest(s.env.DB, s.audit, s.root, u.id, true, "web")).state).toBe("unconfirmed");
  });

  it("lists newest first with filters, search (LIKE characters taken literally), pages and counts", async () => {
    const s = setup();
    const ins = s.DB.sqlite.prepare("INSERT INTO early_access (id, email, name, company, use_case, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    ins.run("a".repeat(32), "a@x.io", "Ann", "Acme", "CI for 100% of repos", "confirmed", "2026-10-01T00:00:00Z", at);
    ins.run("b".repeat(32), "b@x.io", "Bob", "Beta_Co", null, "invited", "2026-10-02T00:00:00Z", at);
    ins.run("c".repeat(32), "c@x.io", null, null, null, "confirmed", "2026-10-03T00:00:00Z", at);
    const store = new EarlyAccess(s.env.DB);
    expect((await store.list()).items.map((r) => r.email)).toEqual(["c@x.io", "b@x.io", "a@x.io"]);
    expect((await store.list({ state: "confirmed" })).items.map((r) => r.email)).toEqual(["c@x.io", "a@x.io"]);
    expect((await store.list({ q: "beta_" })).items.map((r) => r.email)).toEqual(["b@x.io"]);
    expect((await store.list({ q: "100%" })).items.map((r) => r.email)).toEqual(["a@x.io"]);
    expect((await store.list({ q: "%" })).items.map((r) => r.email)).toEqual(["a@x.io"]);
    expect((await store.list({ q: "_" })).items.map((r) => r.email)).toEqual(["b@x.io"]);
    expect(await store.list({ limit: 2 })).toMatchObject({ more: true });
    expect((await store.list({ limit: 2, offset: 2 })).items.map((r) => r.email)).toEqual(["a@x.io"]);
    expect(await store.counts()).toEqual({ confirmed: 2, unconfirmed: 0, invited: 1, declined: 0 });
    expect(requestJson(s.env, (await store.get("a".repeat(32)))!)).toMatchObject({ id: "a".repeat(32), state: "confirmed", email: "a@x.io", html_url: `${PUB}/settings/admin/early-access/${"a".repeat(32)}` });
    expect(requestJson(s.env, (await store.get("a".repeat(32)))!)).not.toHaveProperty("confirm_hash");
  });
});

describe("removing your own request", () => {
  it("emails a one-time removal link only when there is a request, and deletes it with the link", async () => {
    const s = setup();
    expect(await requestRemoval(s.env, "nobody@example.net", "203.0.113.9")).toBe("quiet");
    expect(s.queued).toHaveLength(0);
    await submitRequest(s.env, input("new@example.net"), "203.0.113.9");
    const r = (await new EarlyAccess(s.env.DB).byEmail("new@example.net"))!;
    expect(await requestRemoval(s.env, "new@example.net", "203.0.113.9")).toBe("confirm");
    const job = s.queued.at(-1)!;
    expect(job).toMatchObject({ kind: "early_access_remove", to: { email: "new@example.net" } });
    expect((job as { data: { url: string } }).data.url).toMatch(/\/early-access\/remove\/confirm#/);
    // The removal token can't confirm the request.
    expect(await confirmRequest(s.env, s.audit, tokenOf(job))).toBeNull();
    expect(await removeByToken(s.env, s.audit, tokenOf(job))).toBe(true);
    expect(await new EarlyAccess(s.env.DB).get(r.id)).toBeNull();
    expect(await removeByToken(s.env, s.audit, tokenOf(job))).toBe(false);
    expect(s.audits.at(-1)).toEqual({ action: "early_access.delete", target: r.id, detail: { state: "unconfirmed", via: "self" } });
  });

  it("counts towards the same daily limits", async () => {
    const s = setup();
    await submitRequest(s.env, input("new@example.net"), "203.0.113.9");
    for (let i = 1; i < EMAILS_PER_ADDRESS_PER_DAY; i++) await requestRemoval(s.env, "new@example.net", "203.0.113.9");
    expect(await requestRemoval(s.env, "new@example.net", "203.0.113.9")).toBe("limited");
    expect(s.queued).toHaveLength(EMAILS_PER_ADDRESS_PER_DAY);
  });
});

describe("retention", () => {
  it("deletes unconfirmed requests a week after their last submission, and limit rows after a day", async () => {
    const s = setup();
    const old = "2026-09-01T00:00:00.000Z";
    const ins = s.DB.sqlite.prepare("INSERT INTO early_access (id, email, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    ins.run("a".repeat(32), "old@x.io", "unconfirmed", old, old);
    ins.run("b".repeat(32), "kept@x.io", "confirmed", old, old);
    ins.run("c".repeat(32), "fresh@x.io", "unconfirmed", old, "2026-09-28T00:00:00.000Z");
    s.DB.sqlite.prepare("INSERT INTO early_access_attempts (id, ip_hash, email_hash, created_at) VALUES ('t1', 'i', 'e', ?), ('t2', 'i', 'e', '2026-09-30T12:00:00.000Z')").run(old);
    const r = await pruneExpired(s.env.DB, new Date("2026-10-01T00:00:00.000Z"));
    expect(r).toMatchObject({ early_access: 1, early_access_attempts: 1 });
    expect((s.DB.sqlite.prepare("SELECT email FROM early_access ORDER BY email").all() as Array<{ email: string }>).map((x) => x.email)).toEqual(["fresh@x.io", "kept@x.io"]);
  });
});
