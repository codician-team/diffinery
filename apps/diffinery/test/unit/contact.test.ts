import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import type { Account } from "../../src/lib/directory.js";
import {
  ContactMessages,
  EMAILS_PER_ADDRESS_PER_DAY,
  EMAILS_PER_DAY,
  HANDLED_DAYS,
  MAX_LINKS,
  MAX_MESSAGE,
  MAX_NAME,
  MAX_NOTE,
  MESSAGES_PER_ACCOUNT_PER_DAY,
  SPAM_DAYS,
  SUBMISSIONS_PER_IP_PER_DAY,
  UNCONFIRMED_DAYS,
  changeMessage,
  confirmMessage,
  deleteMessage,
  messageJson,
  submitMessage,
  validateMessage,
  type MessageInput,
} from "../../src/lib/contact.js";
import { pruneExpired } from "../../src/lib/retention.js";
import { HttpError } from "../../src/lib/util.js";
import type { MailJob } from "../../src/mail/types.js";
import { testD1 } from "./stubs/d1.js";

const at = "2026-10-01T00:00:00.000Z";
const PUB = "https://diffinery.example";

/** A D1 with two site administrators (one disabled), a person, and a mail queue that records what it gets. */
function setup() {
  const DB = testD1();
  const add = DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, name, email, status, site_admin, created_at) VALUES (?, ?, 'user', ?, ?, ?, ?, ?)");
  add.run("u-root", "root", "Root", "root@example.com", "active", 1, at);
  add.run("u-old", "old", "Old", "old@example.com", "disabled", 1, at);
  add.run("u-ann", "ann", "Ann", "ann@example.com", "active", 0, at);
  const queued: MailJob[] = [];
  const MAIL = { sendBatch: async (b: Array<{ body: MailJob }>) => void queued.push(...b.map((m) => m.body)) };
  const env = { DB, MAIL, PUBLIC_URL: PUB } as unknown as Env;
  const audits: Array<{ action: string; target?: string; actorLogin?: string; detail?: unknown }> = [];
  const audit = async (e: (typeof audits)[number]) => void audits.push(e);
  const account = (id: string) => DB.sqlite.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as unknown as Account;
  return { env, DB, queued, audits, audit, root: account("u-root"), ann: account("u-ann") };
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

const input = (email: string | null, over: Partial<MessageInput> = {}): MessageInput => ({ email, name: "Ada", topic: "question", message: "Does Diffinery run my workflows as they are?", ...over });
const tokenOf = (job: MailJob | undefined) => /#([A-Za-z0-9_-]+)$/.exec((job as { data: { url: string } }).data.url)![1]!;
const rows = (DB: ReturnType<typeof testD1>) => DB.sqlite.prepare("SELECT * FROM contact_messages ORDER BY created_at, id").all() as Array<Record<string, unknown>>;

describe("message validation", () => {
  it("needs a name, a valid address, a topic from the list and a message, and tidies them", () => {
    expect(validateMessage({ email: " Ada@Example.COM ", name: "  Ada \n Lovelace ", topic: "press", message: "\r\nLine one\r\n\r\n\r\n\r\nLine two  " }, false)).toEqual({ email: "ada@example.com", name: "Ada Lovelace", topic: "press", message: "Line one\n\nLine two" });
  });

  it("takes no address from a signed-in person: their account's is used", () => {
    expect(validateMessage({ email: "someone-else@example.com", name: "Ann", topic: "other", message: "Hello there, team!" }, true)).toEqual({ email: null, name: "Ann", topic: "other", message: "Hello there, team!" });
  });

  it("strips control and text-direction characters that could disguise text", () => {
    expect(validateMessage({ email: "a@b.co", name: "Ad‮a\u0000⁦x", topic: "question", message: "okay then\u0007‏, thanks" }, false)).toMatchObject({ name: "Adax", message: "okay then, thanks" });
  });

  it("refuses what's missing, too short, too long (never cut), off the list or full of links", () => {
    const ok = { email: "a@b.co", name: "Ada", topic: "question", message: "A real question here." };
    refused(() => validateMessage({ ...ok, email: "  " }, false), 422, /Enter your email address/);
    refused(() => validateMessage({ ...ok, email: "<script>@x.y" }, false), 422, /valid email address/);
    refused(() => validateMessage({ ...ok, name: " " }, false), 422, /Enter your name/);
    refused(() => validateMessage({ ...ok, name: "x".repeat(MAX_NAME + 1) }, false), 422, /100 characters/);
    refused(() => validateMessage({ ...ok, topic: "" }, false), 422, /Choose what your message is about/);
    refused(() => validateMessage({ ...ok, topic: "sales" }, false), 422, /from the list/);
    refused(() => validateMessage({ ...ok, message: "" }, false), 422, /Write your message/);
    refused(() => validateMessage({ ...ok, message: "hi" }, false), 422, /at least 10 characters/);
    refused(() => validateMessage({ ...ok, message: "x".repeat(MAX_MESSAGE + 1) }, false), 422, /5,000 characters/);
    expect(validateMessage({ ...ok, message: "x".repeat(MAX_MESSAGE) }, false).message).toHaveLength(MAX_MESSAGE);
    const links = (n: number) => Array.from({ length: n }, (_, i) => `https://spam${i}.example`).join(" ");
    expect(validateMessage({ ...ok, message: links(MAX_LINKS) }, false).message).toContain("spam4");
    refused(() => validateMessage({ ...ok, message: `${links(MAX_LINKS)} www.more.example` }, false), 422, /5 links or fewer/);
    refused(() => validateMessage({ ...ok, message: ["a list, not text"] }, false), 422, /Write your message/);
  });
});

describe("sending without signing in", () => {
  it("stores the message unconfirmed and emails only a confirmation link, with nothing typed in it", async () => {
    const { env, DB, queued, audits, audit } = setup();
    expect(await submitMessage(env, audit, input("new@example.net", { name: "<b>Buy now</b>", message: "Visit https://spam.example for deals!" }), null, "203.0.113.9")).toBe("confirm");
    const [m] = rows(DB);
    expect(m).toMatchObject({ email: "new@example.net", name: "<b>Buy now</b>", state: "unconfirmed", account_id: null, confirmed_at: null });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "contact_confirm", to: { email: "new@example.net" }, reason: "contact", data: { topic: "A question about Diffinery" } });
    expect(JSON.stringify(queued[0])).not.toMatch(/Buy now|spam\.example/);
    // Only a hash of the link's code is kept.
    expect(m!.confirm_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows(DB))).not.toContain(tokenOf(queued[0]));
    expect(audits).toEqual([{ action: "contact.create", target: m!.id, detail: { signed_in: false } }]);
    // The site administrators hear nothing until it is confirmed.
    expect(DB.sqlite.prepare("SELECT count(*) AS n FROM notifications").get()).toEqual({ n: 0 });
  });

  it("confirms with the link once: the message becomes new and every active site administrator hears about it", async () => {
    const { env, DB, queued, audits, audit } = setup();
    await submitMessage(env, audit, input("new@example.net"), null, "203.0.113.9");
    const token = tokenOf(queued[0]);
    const m = (await confirmMessage(env, audit, token))!;
    expect(m).toMatchObject({ state: "new", confirm_hash: null });
    expect(rows(DB)[0]).toMatchObject({ state: "new", confirm_hash: null, confirm_expires_at: null });
    expect(audits.at(-1)).toEqual({ action: "contact.confirm", target: m.id });
    const mails = queued.slice(1);
    expect(mails).toEqual([{ kind: "contact_message", data: { id: m.id, name: "Ada", email: "new@example.net", login: null, topic: "A question about Diffinery", message: "Does Diffinery run my workflows as they are?" }, to: { accountId: "u-root" }, reason: "admin", at: m.created_at }]);
    expect(DB.sqlite.prepare("SELECT account_id, kind, url FROM notifications").all()).toEqual([{ account_id: "u-root", kind: "contact", url: "/settings/admin/contact" }]);
    // The link works once.
    expect(await confirmMessage(env, audit, token)).toBeNull();
    // A second message adds no second unread notification, but does email again.
    await submitMessage(env, audit, input("other@example.net"), null, "203.0.113.10");
    await confirmMessage(env, audit, tokenOf(queued.at(-1)));
    expect(DB.sqlite.prepare("SELECT count(*) AS n FROM notifications").get()).toEqual({ n: 1 });
    expect(queued.filter((j) => j.kind === "contact_message")).toHaveLength(2);
  });

  it("refuses unknown, malformed and expired links", async () => {
    const { env, DB, queued, audit } = setup();
    expect(await confirmMessage(env, audit, "nope")).toBeNull();
    expect(await confirmMessage(env, audit, "a".repeat(32))).toBeNull();
    await submitMessage(env, audit, input("late@example.net"), null, "203.0.113.9");
    DB.sqlite.prepare("UPDATE contact_messages SET confirm_expires_at = ?").run(at);
    expect(await confirmMessage(env, audit, tokenOf(queued[0]))).toBeNull();
    expect(rows(DB)[0]).toMatchObject({ state: "unconfirmed" });
  });

  it("keeps each message separate, so a second one from the same address needs its own confirmation", async () => {
    const { env, DB, queued, audit } = setup();
    await submitMessage(env, audit, input("ada@example.net", { message: "First message, about one thing." }), null, "203.0.113.9");
    await submitMessage(env, audit, input("ada@example.net", { message: "Second message, about another." }), null, "203.0.113.9");
    expect(rows(DB)).toHaveLength(2);
    await confirmMessage(env, audit, tokenOf(queued[1]));
    // Both can have the same created_at millisecond, and then the random id orders them.
    expect(Object.fromEntries(rows(DB).map((r) => [r.message, r.state]))).toEqual({
      "First message, about one thing.": "unconfirmed",
      "Second message, about another.": "new",
    });
  });

  it("limits one network, one address and the whole form per day, quietly past the last two", async () => {
    const { env, DB, queued, audit } = setup();
    for (let i = 0; i < EMAILS_PER_ADDRESS_PER_DAY; i++) expect(await submitMessage(env, audit, input("same@example.net"), null, `198.51.100.${i}`)).toBe("confirm");
    expect(await submitMessage(env, audit, input("same@example.net"), null, "198.51.100.99")).toBe("limited");
    expect(queued).toHaveLength(EMAILS_PER_ADDRESS_PER_DAY);
    expect(rows(DB)).toHaveLength(EMAILS_PER_ADDRESS_PER_DAY);

    for (let i = 0; i < SUBMISSIONS_PER_IP_PER_DAY; i++) await submitMessage(env, audit, input(`n${i}@example.net`), null, "192.0.2.1");
    await rejects(submitMessage(env, audit, input("one-more@example.net"), null, "192.0.2.1"), 429, /Too many messages from your network today/);

    DB.sqlite.prepare("DELETE FROM contact_attempts").run();
    const many = DB.sqlite.prepare("INSERT INTO contact_attempts (id, ip_hash, email_hash, emailed, created_at) VALUES (?, 'x', ?, 1, ?)");
    for (let i = 0; i < EMAILS_PER_DAY; i++) many.run(`a${i}`, `e${i}`, new Date().toISOString());
    const before = queued.length;
    expect(await submitMessage(env, audit, input("fresh@example.net"), null, "203.0.113.50")).toBe("limited");
    expect(queued).toHaveLength(before);
  });

  it("keeps only hashes of the IP address and the address typed for the limits", async () => {
    const { env, DB, audit } = setup();
    await submitMessage(env, audit, input("hash@example.net"), null, "203.0.113.77");
    const dump = JSON.stringify(DB.sqlite.prepare("SELECT * FROM contact_attempts").all());
    expect(dump).not.toContain("203.0.113.77");
    expect(dump).not.toContain("hash@example.net");
  });

  it("drops messages from an address while one from it is marked spam, until it is reopened", async () => {
    const { env, DB, queued, audit, root } = setup();
    await submitMessage(env, audit, input("spammer@example.net"), null, "203.0.113.9");
    const [first] = rows(DB);
    await changeMessage(env.DB, audit, root, first!.id as string, { state: "spam" }, "web");
    const sent = queued.length;
    expect(await submitMessage(env, audit, input("SPAMMER@example.net"), null, "203.0.113.10")).toBe("blocked");
    expect(queued).toHaveLength(sent);
    expect(rows(DB)).toHaveLength(1);
    await changeMessage(env.DB, audit, root, first!.id as string, { state: "new" }, "web");
    expect(await submitMessage(env, audit, input("spammer@example.net"), null, "203.0.113.10")).toBe("confirm");
  });
});

describe("sending signed in", () => {
  it("arrives new from the account's address, with a copy to the sender and a notice to the site administrators", async () => {
    const { env, DB, queued, audits, audit, ann } = setup();
    expect(await submitMessage(env, audit, input(null, { name: "Ann A." }), ann, "203.0.113.9")).toBe("sent");
    const [m] = rows(DB);
    expect(m).toMatchObject({ email: "ann@example.com", name: "Ann A.", account_id: "u-ann", sender_login: "ann", state: "new", confirm_hash: null });
    expect(m!.confirmed_at).toBe(m!.created_at);
    expect(queued.map((j) => [j.kind, j.to])).toEqual([
      ["contact_received", { accountId: "u-ann" }],
      ["contact_message", { accountId: "u-root" }],
    ]);
    expect(queued[1]).toMatchObject({ data: { login: "ann", email: "ann@example.com" } });
    expect(audits).toEqual([{ actorId: "u-ann", actorLogin: "ann", action: "contact.create", target: m!.id, detail: { signed_in: true } }]);
    // No daily-limit rows: a signed-in person is counted by account.
    expect(DB.sqlite.prepare("SELECT count(*) AS n FROM contact_attempts").get()).toEqual({ n: 0 });
  });

  it("limits one person per day", async () => {
    const { env, DB, audit, ann } = setup();
    const add = DB.sqlite.prepare("INSERT INTO contact_messages (id, email, name, topic, message, account_id, state, created_at, updated_at) VALUES (?, 'ann@example.com', 'Ann', 'other', 'm', 'u-ann', 'new', ?, ?)");
    for (let i = 0; i < MESSAGES_PER_ACCOUNT_PER_DAY; i++) add.run(`m${i}`, new Date().toISOString(), new Date().toISOString());
    await rejects(submitMessage(env, audit, input(null), ann, null), 429, /20 messages today/);
  });
});

describe("site administrators", () => {
  async function confirmed() {
    const s = setup();
    await submitMessage(s.env, s.audit, input("ada@example.net"), null, "203.0.113.9");
    await confirmMessage(s.env, s.audit, tokenOf(s.queued[0]));
    return { ...s, id: rows(s.DB)[0]!.id as string };
  }

  it("mark handled and spam, reopen, and keep a note, auditing each change without the message", async () => {
    const { env, audits, audit, root, id } = await confirmed();
    const handled = await changeMessage(env.DB, audit, root, id, { state: "handled", note: "  Replied with the guide.  " }, "api");
    expect(handled).toMatchObject({ state: "handled", note: "Replied with the guide.", updated_by: "root" });
    expect(handled.handled_at).toBeTruthy();
    expect(audits.slice(-2)).toEqual([
      { actorId: "u-root", actorLogin: "root", action: "contact.handle", target: id, detail: { from: "new", to: "handled", via: "api" } },
      { actorId: "u-root", actorLogin: "root", action: "contact.note", target: id, detail: { via: "api" } },
    ]);
    expect(JSON.stringify(audits)).not.toContain("Replied with");
    // A note alone keeps the state; an empty note clears it.
    expect(await changeMessage(env.DB, audit, root, id, { note: "" }, "web")).toMatchObject({ state: "handled", note: null });
    expect(await changeMessage(env.DB, audit, root, id, { state: "spam" }, "web")).toMatchObject({ state: "spam" });
    const reopened = await changeMessage(env.DB, audit, root, id, { state: "new" }, "web");
    expect(reopened).toMatchObject({ state: "new", handled_at: null });
    expect(audits.at(-1)).toMatchObject({ action: "contact.reopen", detail: { from: "spam", to: "new" } });
    await rejects(changeMessage(env.DB, audit, root, id, { state: "deleted" }, "api"), 422, /state must be one of/);
    await rejects(changeMessage(env.DB, audit, root, id, {}, "api"), 422, /a state, a note, or both/);
    await rejects(changeMessage(env.DB, audit, root, id, { note: "x".repeat(MAX_NOTE + 1) }, "api"), 422, /2,000 characters/);
    await rejects(changeMessage(env.DB, audit, root, "0".repeat(32), { state: "handled" }, "api"), 404, /no contact message/);
  });

  it("reopen an unconfirmed message as unconfirmed", async () => {
    const { env, DB, audit, root } = setup();
    await submitMessage(env, audit, input("ada@example.net"), null, "203.0.113.9");
    const id = rows(DB)[0]!.id as string;
    await changeMessage(env.DB, audit, root, id, { state: "spam" }, "web");
    expect(await changeMessage(env.DB, audit, root, id, { state: "new" }, "web")).toMatchObject({ state: "unconfirmed" });
  });

  it("delete a message, auditing that it happened but not what it said or who sent it", async () => {
    const { env, DB, audits, audit, root, id } = await confirmed();
    await deleteMessage(env.DB, audit, root, id, "web");
    expect(rows(DB)).toHaveLength(0);
    expect(audits.at(-1)).toEqual({ actorId: "u-root", actorLogin: "root", action: "contact.delete", target: id, detail: { state: "new", via: "web" } });
    expect(JSON.stringify(audits)).not.toContain("ada@example.net");
    await rejects(deleteMessage(env.DB, audit, root, id, "web"), 404, /no contact message/);
  });

  it("list, filter, search, count and show messages as the API does", async () => {
    const { env, audit, root, id } = await confirmed();
    await submitMessage(env, audit, input("bob@example.net", { name: "Bob", message: "Partnership idea with 100% more agents" }), null, "203.0.113.20");
    const store = new ContactMessages(env.DB);
    expect(await store.counts()).toEqual({ new: 1, handled: 0, spam: 0, unconfirmed: 1 });
    expect(await store.waiting()).toBe(1);
    expect((await store.list({ state: "new" })).items.map((m) => m.id)).toEqual([id]);
    expect((await store.list({ q: "100%" })).items.map((m) => m.name)).toEqual(["Bob"]);
    expect((await store.list({ q: "%" })).items.map((m) => m.name)).toEqual(["Bob"]);
    expect((await store.list({ limit: 1 })).more).toBe(true);
    expect(await store.get("not-an-id")).toBeNull();
    const json = messageJson(env, (await changeMessage(env.DB, audit, root, id, { state: "handled" }, "api")) as never);
    expect(Object.keys(json)).toEqual(["id", "state", "email", "name", "topic", "message", "sender", "confirmed_at", "note", "updated_by", "handled_at", "created_at", "updated_at", "html_url"]);
    expect(json).toMatchObject({ state: "handled", topic: "question", html_url: `${PUB}/settings/admin/contact/${id}` });
    expect(JSON.stringify(json)).not.toContain("confirm_hash");
  });
});

describe("retention", () => {
  it("deletes unconfirmed messages after a week, spam after a month, handled after a year, and limit rows after a day", async () => {
    const { DB } = setup();
    const now = new Date("2026-10-20T00:00:00.000Z");
    const ago = (d: number) => new Date(now.getTime() - d * 86400_000).toISOString();
    const add = DB.sqlite.prepare("INSERT INTO contact_messages (id, email, name, topic, message, state, handled_at, created_at, updated_at) VALUES (?, 'a@b.co', 'A', 'other', 'm', ?, ?, ?, ?)");
    add.run("old-unconfirmed", "unconfirmed", null, ago(UNCONFIRMED_DAYS + 1), ago(UNCONFIRMED_DAYS + 1));
    add.run("new-unconfirmed", "unconfirmed", null, ago(1), ago(1));
    add.run("old-spam", "spam", ago(SPAM_DAYS + 1), ago(400), ago(SPAM_DAYS + 1));
    add.run("new-spam", "spam", ago(SPAM_DAYS - 1), ago(400), ago(SPAM_DAYS - 1));
    add.run("old-handled", "handled", ago(HANDLED_DAYS + 1), ago(400), ago(HANDLED_DAYS + 1));
    add.run("new-handled", "handled", ago(HANDLED_DAYS - 1), ago(400), ago(HANDLED_DAYS - 1));
    add.run("waiting", "new", null, ago(800), ago(800));
    const attempt = DB.sqlite.prepare("INSERT INTO contact_attempts (id, ip_hash, email_hash, emailed, created_at) VALUES (?, 'i', 'e', 1, ?)");
    attempt.run("old", ago(2));
    attempt.run("new", ago(0.5));
    const r = await pruneExpired(DB, now);
    expect(r).toMatchObject({ contact_messages: 3, contact_attempts: 1 });
    expect((DB.sqlite.prepare("SELECT id FROM contact_messages ORDER BY id").all() as Array<{ id: string }>).map((x) => x.id)).toEqual(["new-handled", "new-spam", "new-unconfirmed", "waiting"]);
  });
});
