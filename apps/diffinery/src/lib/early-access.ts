import type { Env } from "../env.js";
import type { Account, Directory } from "./directory.js";
import { loopback } from "../auth/dev.js";
import { normalEmail } from "../auth/signup.js";
import { hmacSha256, matchesAnyKey, signingSecrets } from "./crypto.js";
import { enqueueMail } from "../mail/send.js";
import type { MailJob } from "../mail/types.js";
import { HttpError, b64url, newId, now, randomToken, sha256 } from "./util.js";

/**
 * Early access requests: while an instance is invite-only, anyone can ask for an invitation at
 * /early-access (web/early-access.tsx). A request is stored unconfirmed and its address gets a link;
 * following it confirms the request (double opt-in), and only then do site administrators see it as
 * waiting, on Site administration → Early access. A request never grants access by itself: a site
 * administrator invites it, with the instance's usual invitation email, or declines it.
 *
 * The form answers the same whatever the address: new, already asked, already invited or already an
 * account. Only the address's inbox learns which (a confirmation link, or a short note), so the form
 * can't be used to find out who has an account or asked before. People who aren't signed in pass
 * Cloudflare Turnstile, a hidden honeypot field and a signed timing stamp, and the daily limits below
 * bound what one network, one address, and everyone together can send.
 */

export type RequestState = "unconfirmed" | "confirmed" | "invited" | "declined";
export const REQUEST_STATES: readonly RequestState[] = ["confirmed", "unconfirmed", "invited", "declined"];

/** Longest name, company or team, and use, in characters. Longer is refused, never cut. */
export const MAX_NAME = 100;
export const MAX_COMPANY = 120;
export const MAX_USE_CASE = 1_000;

/** Where someone hosts their code today: the only values the optional "hosting" field takes. */
export const HOSTING = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "bitbucket", label: "Bitbucket" },
  { value: "azure", label: "Azure DevOps" },
  { value: "self-hosted", label: "Self-hosted (Gitea, Forgejo, GitLab and others)" },
  { value: "other", label: "Somewhere else" },
  { value: "none", label: "Nowhere yet" },
] as const;
export type Hosting = (typeof HOSTING)[number]["value"];
export const hostingLabel = (v: string | null): string | null => HOSTING.find((h) => h.value === v)?.label ?? null;

/** How long a confirmation link works, how long a removal link works, and how long an unconfirmed request is kept. */
export const CONFIRM_HOURS = 48;
export const REMOVE_HOURS = 24;
export const UNCONFIRMED_DAYS = 7;

/** In 24 hours: form submissions from one IP address, emails to one address, and emails from the form in total. */
export const SUBMISSIONS_PER_IP_PER_DAY = 10;
export const EMAILS_PER_ADDRESS_PER_DAY = 3;
export const EMAILS_PER_DAY = 500;

/** A form sent sooner than this after it was shown is a script's; one older than the maximum is shown again. */
export const MIN_FILL_MS = 3_000;
export const MAX_FORM_AGE_MS = 24 * 3600_000;

export interface EarlyAccessRequest {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  use_case: string | null;
  hosting: string | null;
  state: RequestState;
  confirm_hash: string | null;
  confirm_expires_at: string | null;
  confirmed_at: string | null;
  remove_hash: string | null;
  remove_expires_at: string | null;
  invite_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RequestInput {
  email: string;
  name: string | null;
  company: string | null;
  useCase: string | null;
  hosting: Hosting | null;
}

/** Control characters (except tab and newline) and bidirectional overrides, which could disguise text on the admin page. */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F‎‏‪-‮⁦-⁩]/g;

/**
 * Check what someone typed: an email address (required), and optionally a name, a company or team,
 * what they would use Diffinery for, and where they host code today. One-line fields lose extra
 * spaces; the use keeps its lines. Too long is refused with the limit, never cut.
 */
export function validateRequest(raw: { email?: unknown; name?: unknown; company?: unknown; useCase?: unknown; hosting?: unknown }): RequestInput {
  const str = (v: unknown) => (typeof v === "string" ? v.replace(INVISIBLE, "") : "");
  const line = (v: unknown) => str(v).replace(/\s+/g, " ").trim();
  const typed = line(raw.email);
  const name = line(raw.name);
  const company = line(raw.company);
  const useCase = str(raw.useCase)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const hosting = line(raw.hosting);
  if (!typed) throw new HttpError(422, "Enter your email address.");
  const email = normalEmail(typed);
  if (!email) throw new HttpError(422, "Enter a valid email address, like you@example.com.");
  if (name.length > MAX_NAME) throw new HttpError(422, `Keep your name to ${MAX_NAME} characters.`);
  if (company.length > MAX_COMPANY) throw new HttpError(422, `Keep the company or team to ${MAX_COMPANY} characters.`);
  if (useCase.length > MAX_USE_CASE) throw new HttpError(422, `Keep what you'd use Diffinery for to ${MAX_USE_CASE.toLocaleString("en")} characters.`);
  if (hosting && !HOSTING.some((h) => h.value === hosting)) throw new HttpError(422, "Pick where you host your code today from the list, or leave it empty.");
  return { email, name: name || null, company: company || null, useCase: useCase || null, hosting: (hosting || null) as Hosting | null };
}

// ---------------------------------------------------------------- the form's timing stamp

type KeyEnv = Pick<Env, "MASTER_KEY" | "MASTER_KEY_PREV" | "PUBLIC_URL">;

function stampSecrets(env: KeyEnv): string[] {
  return signingSecrets(env, loopback(env.PUBLIC_URL) ? "diffinery-dev-early-access" : null, "MASTER_KEY is not set, so the early access form can't be signed");
}

const stampMac = async (secret: string, issued: number): Promise<string> => b64url(await hmacSha256(`diffinery-early-access-form-v1:${secret}`, String(issued)));

/** A stamp for a form shown now: when it was shown, signed, so a script can't backdate it. */
export async function formStamp(env: KeyEnv, at = Date.now()): Promise<string> {
  return `${at}.${await stampMac(stampSecrets(env)[0]!, at)}`;
}

/** Whether a form came back like a person's: "ok", too "fast" after it was shown, "stale" (shown too long ago), or "bad" (missing or forged). */
export async function checkStamp(env: KeyEnv, stamp: string, at = Date.now()): Promise<"ok" | "fast" | "stale" | "bad"> {
  const m = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(stamp);
  if (!m) return "bad";
  const issued = Number(m[1]);
  if (!(await matchesAnyKey(stampSecrets(env), m[2]!, (s) => stampMac(s, issued)))) return "bad";
  if (issued > at + 60_000) return "bad";
  if (at - issued < MIN_FILL_MS) return "fast";
  if (at - issued > MAX_FORM_AGE_MS) return "stale";
  return "ok";
}

// ---------------------------------------------------------------- storage

/** Only hashes of the sender's IP address and of the typed address are kept for the daily limits. */
export const ipHash = (ip: string | null | undefined): Promise<string> => sha256(`diffinery-early-access-ip:${ip || "unknown"}`);
export const emailHash = (email: string): Promise<string> => sha256(`diffinery-early-access-email:${email.toLowerCase()}`);

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Early access requests in D1. */
export class EarlyAccess {
  constructor(private db: D1Database) {}

  async get(id: string): Promise<EarlyAccessRequest | null> {
    if (!/^[0-9a-f]{32}$/.test(id)) return null;
    return this.db.prepare("SELECT * FROM early_access WHERE id = ?").bind(id).first<EarlyAccessRequest>();
  }

  async byEmail(email: string): Promise<EarlyAccessRequest | null> {
    return this.db.prepare("SELECT * FROM early_access WHERE email = ?").bind(email).first<EarlyAccessRequest>();
  }

  /**
   * Newest first, optionally in one state and matching `q` (in the address, name, company or use).
   * One more than `limit` is read, so callers know whether there is a next page.
   */
  async list(o: { state?: RequestState; q?: string; limit?: number; offset?: number } = {}): Promise<{ items: EarlyAccessRequest[]; more: boolean }> {
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
      where.push("(email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\' OR use_case LIKE ? ESCAPE '\\')");
      binds.push(like, like, like, like);
    }
    const rows = (
      await this.db
        .prepare(`SELECT * FROM early_access${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
        .bind(...binds, limit + 1, offset)
        .all<EarlyAccessRequest>()
    ).results;
    return { items: rows.slice(0, limit), more: rows.length > limit };
  }

  async counts(): Promise<Record<RequestState, number>> {
    const rows = (await this.db.prepare("SELECT state, count(*) AS n FROM early_access GROUP BY state").all<{ state: RequestState; n: number }>()).results;
    const out: Record<RequestState, number> = { unconfirmed: 0, confirmed: 0, invited: 0, declined: 0 };
    for (const r of rows) out[r.state] = r.n;
    return out;
  }

  /** Confirmed requests waiting for a decision: the count on the Site administration menu. */
  async waiting(): Promise<number> {
    return (await this.db.prepare("SELECT count(*) AS n FROM early_access WHERE state = 'confirmed'").first<{ n: number }>())?.n ?? 0;
  }

  /** Submissions from this IP address, emails to this address, and emails in total, in the last 24 hours. */
  async sentToday(ip: string, email: string): Promise<{ ip: number; email: number; all: number }> {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const r = await this.db
      .prepare(
        "SELECT (SELECT count(*) FROM early_access_attempts WHERE ip_hash = ? AND created_at > ?) AS ip, (SELECT count(*) FROM early_access_attempts WHERE email_hash = ? AND emailed = 1 AND created_at > ?) AS email, (SELECT count(*) FROM early_access_attempts WHERE emailed = 1 AND created_at > ?) AS a",
      )
      .bind(ip, since, email, since, since)
      .first<{ ip: number; email: number; a: number }>();
    return { ip: r?.ip ?? 0, email: r?.email ?? 0, all: r?.a ?? 0 };
  }

  async attempt(ip: string, email: string, emailed: boolean): Promise<void> {
    await this.db.prepare("INSERT INTO early_access_attempts (id, ip_hash, email_hash, emailed, created_at) VALUES (?, ?, ?, ?, ?)").bind(newId(), ip, email, emailed ? 1 : 0, now()).run();
  }
}

// ---------------------------------------------------------------- requesting and confirming

type Audit = (e: { actorId?: string; actorLogin?: string; action: string; target?: string; detail?: unknown }) => Promise<void>;

/** What a submission did, for tests and logs; the visitor sees the same page whatever it is. */
export type Outcome = "confirm" | "known" | "invited" | "account" | "quiet" | "limited";

/**
 * Take a validated request from `ip`. Refuses (429) only when this network sent too many today;
 * everything else answers the same to the visitor, and the address's inbox gets:
 *
 * - a new or still unconfirmed request: a confirmation link (the request's details are replaced);
 * - a confirmed or declined request: a note that we already have it;
 * - an invited request: a note pointing to the invitation;
 * - an address with an active account: a note to sign in instead;
 * - a disabled or suspended account's address: nothing.
 *
 * No email at all once the address had EMAILS_PER_ADDRESS_PER_DAY today, or the form EMAILS_PER_DAY
 * in total; nothing is stored then either.
 */
export async function submitRequest(env: Env, input: RequestInput, ip: string | null): Promise<Outcome> {
  const store = new EarlyAccess(env.DB);
  const [ipH, emailH] = await Promise.all([ipHash(ip), emailHash(input.email)]);
  const sent = await store.sentToday(ipH, emailH);
  if (sent.ip >= SUBMISSIONS_PER_IP_PER_DAY) throw new HttpError(429, "Too many requests from your network today. Please try again tomorrow.");
  if (sent.email >= EMAILS_PER_ADDRESS_PER_DAY || sent.all >= EMAILS_PER_DAY) {
    await store.attempt(ipH, emailH, false);
    return "limited";
  }
  const at = now();
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE kind = 'user' AND email = ? LIMIT 1").bind(input.email).first<Account>();
  let outcome: Outcome;
  let mail: MailJob | null = null;
  if (account && (account.status === "disabled" || account.suspended_at)) outcome = "quiet";
  else if (account && account.status === "active") {
    outcome = "account";
    mail = { kind: "early_access_known", data: { variant: "account", since: account.created_at }, to: { accountId: account.id }, reason: "early_access", at };
  } else {
    const existing = await store.byEmail(input.email);
    if (existing && existing.state !== "unconfirmed") {
      outcome = existing.state === "invited" ? "invited" : "known";
      mail = { kind: "early_access_known", data: { variant: existing.state === "invited" ? "invited" : "waiting", since: existing.decided_at && existing.state === "invited" ? existing.decided_at : (existing.confirmed_at ?? existing.created_at) }, to: { email: input.email }, reason: "early_access", at };
    } else {
      outcome = "confirm";
      const token = randomToken(24);
      const expiresAt = new Date(Date.now() + CONFIRM_HOURS * 3600_000).toISOString();
      const hash = await sha256(token);
      if (existing) {
        await env.DB.prepare("UPDATE early_access SET name = ?, company = ?, use_case = ?, hosting = ?, confirm_hash = ?, confirm_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'unconfirmed'")
          .bind(input.name, input.company, input.useCase, input.hosting, hash, expiresAt, at, existing.id)
          .run();
      } else {
        // Two submissions racing for one new address: the second updates the first's row instead.
        await env.DB.prepare(
          "INSERT INTO early_access (id, email, name, company, use_case, hosting, state, confirm_hash, confirm_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'unconfirmed', ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = excluded.name, company = excluded.company, use_case = excluded.use_case, hosting = excluded.hosting, confirm_hash = excluded.confirm_hash, confirm_expires_at = excluded.confirm_expires_at, updated_at = excluded.updated_at WHERE early_access.state = 'unconfirmed'",
        )
          .bind(newId(), input.email, input.name, input.company, input.useCase, input.hosting, hash, expiresAt, at, at)
          .run();
      }
      // The token rides in the fragment, which browsers never send, so request logs never hold it.
      mail = { kind: "early_access_confirm", data: { url: `${env.PUBLIC_URL}/early-access/confirm#${token}`, expiresAt }, to: { email: input.email }, reason: "early_access", at };
    }
  }
  await store.attempt(ipH, emailH, !!mail);
  if (mail) await enqueueMail(env, [mail]);
  return outcome;
}

/**
 * Confirm the request a link's token belongs to: it then waits for a site administrator, who hear
 * about it in Diffinery (one unread notification at a time, however many arrive). Null when the
 * token is unknown, already used or expired.
 */
export async function confirmRequest(env: Env, audit: Audit, token: string): Promise<EarlyAccessRequest | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const hash = await sha256(token);
  const at = now();
  const row = await env.DB.prepare("SELECT * FROM early_access WHERE confirm_hash = ? AND state = 'unconfirmed' AND confirm_expires_at > ?").bind(hash, at).first<EarlyAccessRequest>();
  if (!row) return null;
  const done = await env.DB.prepare("UPDATE early_access SET state = 'confirmed', confirmed_at = ?, confirm_hash = NULL, confirm_expires_at = NULL, updated_at = ? WHERE id = ? AND confirm_hash = ? AND state = 'unconfirmed'").bind(at, at, row.id, hash).run();
  if (!done.meta.changes) return null;
  await audit({ action: "early_access.confirm", target: row.id });
  await notifyAdmins(env.DB);
  return { ...row, state: "confirmed", confirmed_at: at, confirm_hash: null, confirm_expires_at: null, updated_at: at };
}

/**
 * Someone asks to remove their own request: the address gets a one-time link that deletes it, when
 * there is a request for it (nothing otherwise, and the visitor sees the same page either way). The
 * same daily limits as requests apply, and count together with them.
 */
export async function requestRemoval(env: Env, email: string, ip: string | null): Promise<Outcome> {
  const store = new EarlyAccess(env.DB);
  const [ipH, emailH] = await Promise.all([ipHash(ip), emailHash(email)]);
  const sent = await store.sentToday(ipH, emailH);
  if (sent.ip >= SUBMISSIONS_PER_IP_PER_DAY) throw new HttpError(429, "Too many requests from your network today. Please try again tomorrow.");
  if (sent.email >= EMAILS_PER_ADDRESS_PER_DAY || sent.all >= EMAILS_PER_DAY) {
    await store.attempt(ipH, emailH, false);
    return "limited";
  }
  const row = await store.byEmail(email);
  if (!row) {
    await store.attempt(ipH, emailH, false);
    return "quiet";
  }
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + REMOVE_HOURS * 3600_000).toISOString();
  await env.DB.prepare("UPDATE early_access SET remove_hash = ?, remove_expires_at = ? WHERE id = ?").bind(await sha256(token), expiresAt, row.id).run();
  await store.attempt(ipH, emailH, true);
  await enqueueMail(env, [{ kind: "early_access_remove", data: { url: `${env.PUBLIC_URL}/early-access/remove/confirm#${token}`, expiresAt }, to: { email: row.email }, reason: "early_access", at: now() }]);
  return "confirm";
}

/**
 * Delete the request a removal link's token belongs to. False when the token is unknown, used or expired.
 * The daily-limit rows stay until they are a day old: they are hashes, and deleting them would let
 * whoever keeps asking for this address start over.
 */
export async function removeByToken(env: Env, audit: Audit, token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return false;
  const hash = await sha256(token);
  const row = await env.DB.prepare("SELECT * FROM early_access WHERE remove_hash = ? AND remove_expires_at > ?").bind(hash, now()).first<EarlyAccessRequest>();
  if (!row) return false;
  const done = await env.DB.prepare("DELETE FROM early_access WHERE id = ? AND remove_hash = ?").bind(row.id, hash).run();
  if (!done.meta.changes) return false;
  await audit({ action: "early_access.delete", target: row.id, detail: { state: row.state, via: "self" } });
  return true;
}

/** One "new early access requests" notification per active site administrator, unless an unread one is already waiting. */
export async function notifyAdmins(db: D1Database): Promise<void> {
  const admins = (await db.prepare("SELECT id FROM accounts WHERE kind = 'user' AND site_admin = 1 AND status = 'active' AND suspended_at IS NULL LIMIT 50").all<{ id: string }>()).results;
  if (!admins.length) return;
  const at = now();
  await db.batch(
    admins.map((a) =>
      db
        .prepare("INSERT INTO notifications (id, account_id, repo_id, kind, title, url, created_at) SELECT ?, ?, NULL, 'early_access', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE account_id = ? AND kind = 'early_access' AND read_at IS NULL)")
        .bind(newId(), a.id, "New early access requests are waiting for you", "/settings/admin/early-access", at, a.id),
    ),
  );
}

// ---------------------------------------------------------------- site administrators' decisions

/** A request that exists, or 404. */
async function existing(db: D1Database, id: string): Promise<EarlyAccessRequest> {
  const r = await new EarlyAccess(db).get(id);
  if (!r) throw new HttpError(404, "no early access request with that id");
  return r;
}

/**
 * Invite a request's address to the instance with the usual invitation email (Directory.createInvite).
 * An address that already has a pending site invitation keeps it, and one that already belongs to an
 * active account is refused: there is nothing to invite it to.
 */
export async function inviteRequest(env: Env, dir: Directory, audit: Audit, me: Account, id: string, via: "web" | "api"): Promise<EarlyAccessRequest> {
  const r = await existing(env.DB, id);
  if (r.state === "invited") throw new HttpError(422, `${r.email} is already invited.`);
  const account = await dir.accountByEmail(r.email);
  if (account && account.status === "active") throw new HttpError(422, `${r.email} already has an account (${account.login}), so there is nothing to invite.`);
  const pending = await env.DB.prepare("SELECT id FROM invites WHERE email = ? AND account_id IS NULL AND org_id IS NULL AND repo_id IS NULL AND accepted_at IS NULL AND expires_at > ?").bind(r.email, now()).first<{ id: string }>();
  const inviteId = pending ? pending.id : (await dir.createInvite(me, { email: r.email, role: "read" })).id;
  if (!pending) await audit({ actorId: me.id, actorLogin: me.login, action: "invite.create", target: r.email });
  const at = now();
  await env.DB.prepare("UPDATE early_access SET state = 'invited', invite_id = ?, decided_by = ?, decided_at = ?, confirm_hash = NULL, confirm_expires_at = NULL, updated_at = ? WHERE id = ?").bind(inviteId, me.login, at, at, r.id).run();
  await audit({ actorId: me.id, actorLogin: me.login, action: "early_access.invite", target: r.id, detail: { invite: inviteId, from: r.state, ...(pending ? { existing_invitation: true } : {}), via } });
  return { ...r, state: "invited", invite_id: inviteId, decided_by: me.login, decided_at: at, confirm_hash: null, confirm_expires_at: null, updated_at: at };
}

/**
 * Decline a request, or put a declined one back (`restore`) where it was: confirmed, or unconfirmed
 * if its address never confirmed it. Nobody is emailed either way.
 */
export async function declineRequest(db: D1Database, audit: Audit, me: Account, id: string, restore: boolean, via: "web" | "api"): Promise<EarlyAccessRequest> {
  const r = await existing(db, id);
  if (r.state === "invited") throw new HttpError(422, "This request was already invited. Revoke the invitation in People and invitations instead.");
  const at = now();
  if (restore) {
    if (r.state !== "declined") throw new HttpError(422, "Only a declined request can be put back.");
    const state: RequestState = r.confirmed_at ? "confirmed" : "unconfirmed";
    await db.prepare("UPDATE early_access SET state = ?, decided_by = NULL, decided_at = NULL, updated_at = ? WHERE id = ?").bind(state, at, r.id).run();
    await audit({ actorId: me.id, actorLogin: me.login, action: "early_access.restore", target: r.id, detail: { to: state, via } });
    return { ...r, state, decided_by: null, decided_at: null, updated_at: at };
  }
  if (r.state === "declined") throw new HttpError(422, "This request is already declined.");
  await db.prepare("UPDATE early_access SET state = 'declined', decided_by = ?, decided_at = ?, confirm_hash = NULL, confirm_expires_at = NULL, updated_at = ? WHERE id = ?").bind(me.login, at, at, r.id).run();
  await audit({ actorId: me.id, actorLogin: me.login, action: "early_access.decline", target: r.id, detail: { from: r.state, via } });
  return { ...r, state: "declined", decided_by: me.login, decided_at: at, confirm_hash: null, confirm_expires_at: null, updated_at: at };
}

/**
 * Delete a request, for someone who asks for their data to be removed. The audit log records that it
 * happened, never what the request said or its address. An invitation already sent from it stays;
 * revoke it separately. The daily-limit rows (hashes) stay until they are a day old, as in removeByToken.
 */
export async function deleteRequest(db: D1Database, audit: Audit, me: Account, id: string, via: "web" | "api"): Promise<void> {
  const r = await existing(db, id);
  await db.prepare("DELETE FROM early_access WHERE id = ?").bind(r.id).run();
  await audit({ actorId: me.id, actorLogin: me.login, action: "early_access.delete", target: r.id, detail: { state: r.state, via } });
}

/** The API's view of a request. */
export const requestJson = (env: Pick<Env, "PUBLIC_URL">, r: EarlyAccessRequest) => ({
  id: r.id,
  state: r.state,
  email: r.email,
  name: r.name,
  company: r.company,
  use_case: r.use_case,
  hosting: r.hosting,
  confirmed_at: r.confirmed_at,
  invite_id: r.invite_id,
  decided_by: r.decided_by,
  decided_at: r.decided_at,
  created_at: r.created_at,
  updated_at: r.updated_at,
  html_url: `${env.PUBLIC_URL}/settings/admin/early-access/${r.id}`,
});

/** Whether the form takes requests here: only while sign-up is closed (open sign-up needs no request). */
export const earlyAccessOpen = (env: Pick<Env, "SIGNUP">): boolean => env.SIGNUP !== "open";
