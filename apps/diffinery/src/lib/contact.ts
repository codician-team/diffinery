import type { Env } from "../env.js";
import type { Account } from "./directory.js";
import { normalEmail } from "../auth/signup.js";
import { enqueueMail } from "../mail/send.js";
import type { MailJob } from "../mail/types.js";
import { HttpError, newId, now, randomToken, sha256 } from "./util.js";

/**
 * Contact messages: anyone can write to an instance's site administrators at /contact
 * (web/contact.tsx), signed in or not. Someone who isn't signed in passes Cloudflare Turnstile, a
 * hidden honeypot field and a signed timing stamp (the early access form's protections), and their
 * message stays unconfirmed until its address follows the emailed link: so nobody can put words in
 * someone else's name, and replies only ever go to an inbox that asked for them. A signed-in person's
 * message arrives confirmed, from their account's address.
 *
 * A confirmed message is new until a site administrator marks it handled or spam, on Site
 * administration → Contact messages. Each one emails the site administrators (from the sender's
 * address as Reply-To, so they can answer from their mailbox) and raises one in-app notification.
 *
 * The confirmation email never repeats anything typed into the form, so the form can't be used to
 * send someone else a message through Diffinery. An address with a message marked spam gets nothing
 * through until that message is put back or deleted.
 */

export type MessageState = "unconfirmed" | "new" | "handled" | "spam";
export const MESSAGE_STATES: readonly MessageState[] = ["new", "handled", "spam", "unconfirmed"];

/** Longest name, message and note, in characters, and the shortest message. Longer is refused, never cut. */
export const MAX_NAME = 100;
export const MAX_MESSAGE = 5_000;
export const MIN_MESSAGE = 10;
export const MAX_NOTE = 2_000;
/** Links in one message: spam carries many, people rarely need more. */
export const MAX_LINKS = 5;

/** What a message is about: the only values the topic takes. */
export const TOPICS = [
  { value: "question", label: "A question about Diffinery" },
  { value: "account", label: "My account or invitation" },
  { value: "self-hosting", label: "Running my own Diffinery" },
  { value: "feedback", label: "Feedback or an idea" },
  { value: "partnership", label: "Partnerships and integrations" },
  { value: "press", label: "Press and media" },
  { value: "privacy", label: "Privacy and my data" },
  { value: "other", label: "Something else" },
] as const;
export type Topic = (typeof TOPICS)[number]["value"];
export const topicLabel = (v: string): string => TOPICS.find((t) => t.value === v)?.label ?? v;
export const isTopic = (v: string): v is Topic => TOPICS.some((t) => t.value === v);

/** How long a confirmation link works, and how long unconfirmed, spam and handled messages are kept. */
export const CONFIRM_HOURS = 48;
export const UNCONFIRMED_DAYS = 7;
export const SPAM_DAYS = 30;
export const HANDLED_DAYS = 365;

/** In 24 hours: submissions from one IP address, emails to one address, and emails from the form in total (people not signed in). */
export const SUBMISSIONS_PER_IP_PER_DAY = 10;
export const EMAILS_PER_ADDRESS_PER_DAY = 3;
export const EMAILS_PER_DAY = 300;
/** In 24 hours: messages from one signed-in person. */
export const MESSAGES_PER_ACCOUNT_PER_DAY = 20;

export interface ContactMessage {
  id: string;
  email: string;
  name: string;
  topic: string;
  message: string;
  account_id: string | null;
  sender_login: string | null;
  state: MessageState;
  confirm_hash: string | null;
  confirm_expires_at: string | null;
  confirmed_at: string | null;
  note: string | null;
  updated_by: string | null;
  handled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageInput {
  /** Null for a signed-in sender, whose account's address is used. */
  email: string | null;
  name: string;
  topic: Topic;
  message: string;
}

/** Control characters (except tab and newline) and bidirectional overrides, which could disguise text on the admin page. */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F‎‏‪-‮⁦-⁩]/g;

const LINK = /\bhttps?:\/\/|\bwww\./gi;

/**
 * Check what someone typed: their name, an email address (only when not signed in), a topic from the
 * list, and the message. One-line fields lose extra spaces; the message keeps its lines. Too long is
 * refused with the limit, never cut.
 */
export function validateMessage(raw: { email?: unknown; name?: unknown; topic?: unknown; message?: unknown }, signedIn: boolean): MessageInput {
  const str = (v: unknown) => (typeof v === "string" ? v.replace(INVISIBLE, "") : "");
  const line = (v: unknown) => str(v).replace(/\s+/g, " ").trim();
  const name = line(raw.name);
  const topic = line(raw.topic);
  const message = str(raw.message)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  let email: string | null = null;
  if (!signedIn) {
    const typed = line(raw.email);
    if (!typed) throw new HttpError(422, "Enter your email address, so we can reply.");
    email = normalEmail(typed);
    if (!email) throw new HttpError(422, "Enter a valid email address, like you@example.com.");
  }
  if (!name) throw new HttpError(422, "Enter your name.");
  if (name.length > MAX_NAME) throw new HttpError(422, `Keep your name to ${MAX_NAME} characters.`);
  if (!topic) throw new HttpError(422, "Choose what your message is about.");
  if (!isTopic(topic)) throw new HttpError(422, "Choose what your message is about from the list.");
  if (!message) throw new HttpError(422, "Write your message.");
  if (message.length < MIN_MESSAGE) throw new HttpError(422, `Write a little more: at least ${MIN_MESSAGE} characters.`);
  if (message.length > MAX_MESSAGE) throw new HttpError(422, `Keep your message to ${MAX_MESSAGE.toLocaleString("en")} characters. Offer to send more once we reply.`);
  if ((message.match(LINK) ?? []).length > MAX_LINKS) throw new HttpError(422, `Keep your message to ${MAX_LINKS} links or fewer.`);
  return { email, name, topic, message };
}

// ---------------------------------------------------------------- storage

/** Only hashes of the sender's IP address and of the typed address are kept for the daily limits. */
export const ipHash = (ip: string | null | undefined): Promise<string> => sha256(`diffinery-contact-ip:${ip || "unknown"}`);
export const emailHash = (email: string): Promise<string> => sha256(`diffinery-contact-email:${email.toLowerCase()}`);

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Contact messages in D1. */
export class ContactMessages {
  constructor(private db: D1Database) {}

  async get(id: string): Promise<ContactMessage | null> {
    if (!/^[0-9a-f]{32}$/.test(id)) return null;
    return this.db.prepare("SELECT * FROM contact_messages WHERE id = ?").bind(id).first<ContactMessage>();
  }

  /**
   * Newest first, optionally in one state and matching `q` (in the address, name or message).
   * One more than `limit` is read, so callers know whether there is a next page.
   */
  async list(o: { state?: MessageState; q?: string; limit?: number; offset?: number } = {}): Promise<{ items: ContactMessage[]; more: boolean }> {
    const limit = Math.min(Math.max(o.limit ?? 50, 1), 500);
    const offset = Math.min(Math.max(o.offset ?? 0, 0), 100_000);
    const where: string[] = [];
    const binds: unknown[] = [];
    if (o.state) {
      where.push("state = ?");
      binds.push(o.state);
    }
    const q = (o.q ?? "").trim().slice(0, 100);
    if (q) {
      const like = `%${likeEscape(q)}%`;
      where.push("(email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\')");
      binds.push(like, like, like);
    }
    const rows = (
      await this.db
        .prepare(`SELECT * FROM contact_messages${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
        .bind(...binds, limit + 1, offset)
        .all<ContactMessage>()
    ).results;
    return { items: rows.slice(0, limit), more: rows.length > limit };
  }

  async counts(): Promise<Record<MessageState, number>> {
    const rows = (await this.db.prepare("SELECT state, count(*) AS n FROM contact_messages GROUP BY state").all<{ state: MessageState; n: number }>()).results;
    const out: Record<MessageState, number> = { unconfirmed: 0, new: 0, handled: 0, spam: 0 };
    for (const r of rows) out[r.state] = r.n;
    return out;
  }

  /** New messages waiting for a site administrator: the count on the Site administration menu. */
  async waiting(): Promise<number> {
    return (await this.db.prepare("SELECT count(*) AS n FROM contact_messages WHERE state = 'new'").first<{ n: number }>())?.n ?? 0;
  }

  /** Whether a site administrator marked a message from this address as spam (and it's still kept). */
  async spammer(email: string): Promise<boolean> {
    return !!(await this.db.prepare("SELECT 1 AS x FROM contact_messages WHERE email = ? AND state = 'spam' LIMIT 1").bind(email).first());
  }

  /** Submissions from this IP address, emails to this address, and emails in total, in the last 24 hours. */
  async sentToday(ip: string, email: string): Promise<{ ip: number; email: number; all: number }> {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const r = await this.db
      .prepare(
        "SELECT (SELECT count(*) FROM contact_attempts WHERE ip_hash = ? AND created_at > ?) AS ip, (SELECT count(*) FROM contact_attempts WHERE email_hash = ? AND emailed = 1 AND created_at > ?) AS email, (SELECT count(*) FROM contact_attempts WHERE emailed = 1 AND created_at > ?) AS a",
      )
      .bind(ip, since, email, since, since)
      .first<{ ip: number; email: number; a: number }>();
    return { ip: r?.ip ?? 0, email: r?.email ?? 0, all: r?.a ?? 0 };
  }

  /** Messages from this signed-in person in the last 24 hours. */
  async fromAccountToday(accountId: string): Promise<number> {
    const since = new Date(Date.now() - 86400_000).toISOString();
    return (await this.db.prepare("SELECT count(*) AS n FROM contact_messages WHERE account_id = ? AND created_at > ?").bind(accountId, since).first<{ n: number }>())?.n ?? 0;
  }

  async attempt(ip: string, email: string, emailed: boolean): Promise<void> {
    await this.db.prepare("INSERT INTO contact_attempts (id, ip_hash, email_hash, emailed, created_at) VALUES (?, ?, ?, ?, ?)").bind(newId(), ip, email, emailed ? 1 : 0, now()).run();
  }
}

// ---------------------------------------------------------------- sending and confirming

type Audit = (e: { actorId?: string; actorLogin?: string; action: string; target?: string; detail?: unknown }) => Promise<void>;

/** What a submission did, for tests and logs; the visitor sees the same page whatever it is. */
export type Outcome = "confirm" | "sent" | "blocked" | "limited";

/**
 * Take a validated message. `sender` is the signed-in person (their message arrives new, they get a
 * receipt and the site administrators hear about it now), or null: then the message is stored
 * unconfirmed and the typed address gets a link to confirm it.
 *
 * Refuses (429) when this network or this person sent too many today. Otherwise the visitor sees the
 * same page whatever happens; no email is sent and nothing is stored once the address had
 * EMAILS_PER_ADDRESS_PER_DAY today or the form EMAILS_PER_DAY in total, or when a message from the
 * address is marked spam.
 */
export async function submitMessage(env: Env, audit: Audit, input: MessageInput, sender: Account | null, ip: string | null): Promise<Outcome> {
  const store = new ContactMessages(env.DB);
  const at = now();
  if (sender) {
    if ((await store.fromAccountToday(sender.id)) >= MESSAGES_PER_ACCOUNT_PER_DAY) throw new HttpError(429, `You have sent ${MESSAGES_PER_ACCOUNT_PER_DAY} messages today. We'll reply to those first; try again tomorrow.`);
    const email = sender.email ?? "";
    if (!email) throw new HttpError(422, "Your account has no email address to reply to. Add one in Settings → Email first.");
    if (await store.spammer(email)) return "blocked";
    const id = newId();
    await env.DB.prepare("INSERT INTO contact_messages (id, email, name, topic, message, account_id, sender_login, state, confirmed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)")
      .bind(id, email, input.name, input.topic, input.message, sender.id, sender.login, at, at, at)
      .run();
    await audit({ actorId: sender.id, actorLogin: sender.login, action: "contact.create", target: id, detail: { signed_in: true } });
    await enqueueMail(env, [{ kind: "contact_received", data: { id, topic: topicLabel(input.topic), message: input.message }, to: { accountId: sender.id }, reason: "account", at }]);
    await notifyAdmins(env, { id, email, name: input.name, topic: input.topic, message: input.message, sender_login: sender.login, created_at: at });
    return "sent";
  }

  const email = input.email!;
  const [ipH, emailH] = await Promise.all([ipHash(ip), emailHash(email)]);
  const sent = await store.sentToday(ipH, emailH);
  if (sent.ip >= SUBMISSIONS_PER_IP_PER_DAY) throw new HttpError(429, "Too many messages from your network today. Please try again tomorrow.");
  if (sent.email >= EMAILS_PER_ADDRESS_PER_DAY || sent.all >= EMAILS_PER_DAY) {
    await store.attempt(ipH, emailH, false);
    return "limited";
  }
  if (await store.spammer(email)) {
    await store.attempt(ipH, emailH, false);
    return "blocked";
  }
  const id = newId();
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + CONFIRM_HOURS * 3600_000).toISOString();
  await env.DB.prepare("INSERT INTO contact_messages (id, email, name, topic, message, state, confirm_hash, confirm_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'unconfirmed', ?, ?, ?, ?)")
    .bind(id, email, input.name, input.topic, input.message, await sha256(token), expiresAt, at, at)
    .run();
  await store.attempt(ipH, emailH, true);
  await audit({ action: "contact.create", target: id, detail: { signed_in: false } });
  // The token rides in the fragment, which browsers never send, so request logs never hold it.
  await enqueueMail(env, [{ kind: "contact_confirm", data: { url: `${env.PUBLIC_URL}/contact/confirm#${token}`, expiresAt, topic: topicLabel(input.topic) }, to: { email }, reason: "contact", at }]);
  return "confirm";
}

/**
 * Confirm the message a link's token belongs to: it becomes new, and the site administrators hear
 * about it. Null when the token is unknown, already used or expired.
 */
export async function confirmMessage(env: Env, audit: Audit, token: string): Promise<ContactMessage | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const hash = await sha256(token);
  const at = now();
  const row = await env.DB.prepare("SELECT * FROM contact_messages WHERE confirm_hash = ? AND state = 'unconfirmed' AND confirm_expires_at > ?").bind(hash, at).first<ContactMessage>();
  if (!row) return null;
  const done = await env.DB.prepare("UPDATE contact_messages SET state = 'new', confirmed_at = ?, confirm_hash = NULL, confirm_expires_at = NULL, updated_at = ? WHERE id = ? AND confirm_hash = ? AND state = 'unconfirmed'").bind(at, at, row.id, hash).run();
  if (!done.meta.changes) return null;
  await audit({ action: "contact.confirm", target: row.id });
  await notifyAdmins(env, row);
  return { ...row, state: "new", confirmed_at: at, confirm_hash: null, confirm_expires_at: null, updated_at: at };
}

/**
 * Tell every active site administrator about a new message: an email each (the "Organizations" group
 * of their notification settings, with the sender as Reply-To), and one in-app notification, which
 * stays one however many messages arrive until it is read.
 */
export async function notifyAdmins(env: Env, m: Pick<ContactMessage, "id" | "email" | "name" | "topic" | "message" | "sender_login" | "created_at">): Promise<void> {
  const db = env.DB;
  const admins = (await db.prepare("SELECT id FROM accounts WHERE kind = 'user' AND site_admin = 1 AND status = 'active' AND suspended_at IS NULL LIMIT 50").all<{ id: string }>()).results;
  if (!admins.length) return;
  const at = now();
  await db.batch(
    admins.map((a) =>
      db
        .prepare("INSERT INTO notifications (id, account_id, repo_id, kind, title, url, created_at) SELECT ?, ?, NULL, 'contact', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE account_id = ? AND kind = 'contact' AND read_at IS NULL)")
        .bind(newId(), a.id, "New contact messages are waiting for you", "/settings/admin/contact", at, a.id),
    ),
  );
  await enqueueMail(
    env,
    admins.map((a): MailJob => ({ kind: "contact_message", data: { id: m.id, name: m.name, email: m.email, login: m.sender_login, topic: topicLabel(m.topic), message: m.message }, to: { accountId: a.id }, reason: "admin", at: m.created_at })),
  );
}

// ---------------------------------------------------------------- site administrators

/** A message that exists, or 404. */
async function existing(db: D1Database, id: string): Promise<ContactMessage> {
  const m = await new ContactMessages(db).get(id);
  if (!m) throw new HttpError(404, "no contact message with that id");
  return m;
}

const ACTION: Record<"new" | "handled" | "spam", string> = { new: "contact.reopen", handled: "contact.handle", spam: "contact.spam" };

/**
 * Mark a message handled or spam, or put it back (`new`: new again, or unconfirmed if its address
 * never confirmed it), and keep a note for the other site administrators when one is given (an empty
 * note clears it; leaving it out keeps it). Nobody is emailed. Audited, without the message.
 */
export async function changeMessage(db: D1Database, audit: Audit, me: Account, id: string, change: { state?: unknown; note?: unknown }, via: "web" | "api"): Promise<ContactMessage> {
  const { state, note } = change;
  if (state !== undefined && state !== "new" && state !== "handled" && state !== "spam") throw new HttpError(422, "state must be one of new, handled, spam");
  if (note !== undefined && note !== null && typeof note !== "string") throw new HttpError(422, "note must be a string");
  if (state === undefined && note === undefined) throw new HttpError(422, "send a state, a note, or both");
  const text = typeof note === "string" ? note.replace(/\r\n?/g, "\n").trim() : "";
  if (text.length > MAX_NOTE) throw new HttpError(422, `Keep the note to ${MAX_NOTE.toLocaleString("en")} characters.`);
  const m = await existing(db, id);
  const at = now();
  const next: MessageState = state === undefined ? m.state : state === "new" ? (m.confirmed_at ? "new" : "unconfirmed") : state;
  const newNote = note === undefined ? m.note : text || null;
  const handledAt = next === "handled" || next === "spam" ? (next === m.state ? m.handled_at : at) : null;
  await db.prepare("UPDATE contact_messages SET state = ?, note = ?, updated_by = ?, handled_at = ?, updated_at = ? WHERE id = ?").bind(next, newNote, me.login, handledAt, at, m.id).run();
  if (next !== m.state) await audit({ actorId: me.id, actorLogin: me.login, action: ACTION[state as "new" | "handled" | "spam"], target: m.id, detail: { from: m.state, to: next, via } });
  if (newNote !== m.note) await audit({ actorId: me.id, actorLogin: me.login, action: "contact.note", target: m.id, detail: { via } });
  return { ...m, state: next, note: newNote, updated_by: me.login, handled_at: handledAt, updated_at: at };
}

/** Delete a message, for someone who asks for their data to be removed. The audit log records that it happened, never what it said or its address. */
export async function deleteMessage(db: D1Database, audit: Audit, me: Account, id: string, via: "web" | "api"): Promise<void> {
  const m = await existing(db, id);
  await db.prepare("DELETE FROM contact_messages WHERE id = ?").bind(m.id).run();
  await audit({ actorId: me.id, actorLogin: me.login, action: "contact.delete", target: m.id, detail: { state: m.state, via } });
}

/** The API's view of a message. */
export const messageJson = (env: Pick<Env, "PUBLIC_URL">, m: ContactMessage) => ({
  id: m.id,
  state: m.state,
  email: m.email,
  name: m.name,
  topic: m.topic,
  message: m.message,
  sender: m.sender_login,
  confirmed_at: m.confirmed_at,
  note: m.note,
  updated_by: m.updated_by,
  handled_at: m.handled_at,
  created_at: m.created_at,
  updated_at: m.updated_at,
  html_url: `${env.PUBLIC_URL}/settings/admin/contact/${m.id}`,
});
