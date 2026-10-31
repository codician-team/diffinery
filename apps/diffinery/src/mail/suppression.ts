import { devAuth } from "../auth/dev.js";
import type { Env } from "../env.js";
import { b64url, fromB64url, hmacSha256Hex, now, safeEqual } from "../lib/util.js";
import { hmacSha256, matchesAnyKey, signingSecrets } from "../lib/crypto.js";

/**
 * The suppression list: addresses Diffinery sends no email to at all, because mail to them
 * bounced for good (`hard-bounce`), their owner reported an email as spam (`complaint`), or a
 * site administrator added them (`manual`). deliver() in send.ts checks it before every send,
 * sign-in links and account recovery included. The one exception is the verification email the
 * address's owner asks for on Settings → Email: following its link lifts a bounce or complaint.
 *
 * Bounces and complaints come from Cloudflare Email Sending's Event Subscriptions (a queue,
 * mail/events.ts), from a signed POST to /-/email/events for anything else, and from Email
 * Sending's or the SMTP server's own answer to a send it refuses for good (sendSuppression, used by deliver()).
 */

export type SuppressionReason = "hard-bounce" | "complaint" | "manual";
export const SUPPRESSION_REASONS: readonly SuppressionReason[] = ["hard-bounce", "complaint", "manual"];
export type SuppressionSource = "cloudflare" | "webhook" | "send" | "admin";

export interface Suppression {
  email: string;
  reason: SuppressionReason;
  detail: string | null;
  source: SuppressionSource;
  created_by: string | null;
  created_at: string;
}

/** Why an address is suppressed, in words that follow "Diffinery stopped sending to it because". */
export const REASON_TEXT: Record<SuppressionReason, string> = {
  "hard-bounce": "email to it bounced permanently",
  complaint: "an email from Diffinery to it was reported as spam",
  manual: "a site administrator suppressed it",
};

/** Longest detail kept, in characters. */
export const MAX_DETAIL = 500;

/** Addresses compare without case. */
export const normalAddress = (email: string): string => email.trim().toLowerCase();

/** Whether the address's owner may lift a suppression by verifying the address again (a manual one needs an administrator). */
export const ownerCanLift = (s: Pick<Suppression, "reason">): boolean => s.reason !== "manual";

const clip = (s: string | null | undefined): string | null => (s ? s.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL) || null : null);

/** The suppression list in D1. */
export class Suppressions {
  constructor(private db: D1Database) {}

  async get(email: string): Promise<Suppression | null> {
    return this.db.prepare("SELECT * FROM email_suppressions WHERE email = ?").bind(normalAddress(email)).first<Suppression>();
  }

  /** Suppress an address; a newer event replaces an older one. */
  async add(s: { email: string; reason: SuppressionReason; detail?: string | null; source: SuppressionSource; by?: string | null }): Promise<Suppression> {
    const row: Suppression = { email: normalAddress(s.email), reason: s.reason, detail: clip(s.detail), source: s.source, created_by: s.by ?? null, created_at: now() };
    await this.db
      .prepare(
        "INSERT INTO email_suppressions (email, reason, detail, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, source = excluded.source, created_by = excluded.created_by, created_at = excluded.created_at",
      )
      .bind(row.email, row.reason, row.detail, row.source, row.created_by, row.created_at)
      .run();
    return row;
  }

  /** Remove an address from the list; the row that was there, or null. */
  async remove(email: string): Promise<Suppression | null> {
    return this.db.prepare("DELETE FROM email_suppressions WHERE email = ? RETURNING *").bind(normalAddress(email)).first<Suppression>();
  }

  async list(limit = 500): Promise<Suppression[]> {
    return (await this.db.prepare("SELECT * FROM email_suppressions ORDER BY created_at DESC LIMIT ?").bind(Math.min(Math.max(limit, 1), 1000)).all<Suppression>()).results;
  }
}

// ---------------------------------------------------------------- provider events

/**
 * What a provider event means for the list: a permanent (hard) bounce or a spam complaint
 * suppresses the recipient; everything else (deliveries, soft bounces, deferrals) changes nothing.
 *
 * The shape is Cloudflare Email Sending's Event Subscriptions event: `type` ends in
 * `message.bounced` or `message.complained`, and `payload` holds `recipient`, `bounce`
 * (`type` hard or soft, `reason`) and `complaint`. The signed intake takes the same shape.
 */
export function suppressionFor(ev: unknown): { email: string; reason: Exclude<SuppressionReason, "manual">; detail: string | null } | null {
  if (!ev || typeof ev !== "object") return null;
  const e = ev as { type?: unknown; payload?: { recipient?: unknown; bounce?: { type?: unknown; reason?: unknown }; complaint?: { type?: unknown }; delivery?: { smtpResponse?: unknown } } };
  const type = typeof e.type === "string" ? e.type : "";
  const p = e.payload && typeof e.payload === "object" ? e.payload : null;
  const to = typeof p?.recipient === "string" ? normalAddress(p.recipient) : "";
  if (!p || !/^[^\s@]+@[^\s@]+$/.test(to) || to.length > 254) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  if (type.endsWith("message.complained")) return { email: to, reason: "complaint", detail: clip(`Spam complaint${str(p.complaint?.type) ? ` (${str(p.complaint?.type)})` : ""}`) };
  // A bounced event is permanent by definition; only an explicit soft one is left alone.
  if (type.endsWith("message.bounced") && str(p.bounce?.type) !== "soft") return { email: to, reason: "hard-bounce", detail: clip(str(p.bounce?.reason) ?? str(p.delivery?.smtpResponse)) };
  return null;
}

/**
 * Error codes with which Email Sending's send() refuses a recipient for good: it is on Cloudflare's
 * own suppression list (after a bounce or complaint there), so every later send fails the same way.
 * Over SMTP (smtp.ts), E_SMTP_RECIPIENT_REJECTED: the server answered RCPT TO with a permanent
 * "no such mailbox or domain". Everything else (rate limits, the daily limit, delivery and internal
 * errors, a bad message or sender, a wrong SMTP password) is about the send, not the address, and
 * changes nothing.
 * https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */
export const PERMANENT_SEND_CODES: ReadonlySet<string> = new Set(["E_RECIPIENT_SUPPRESSED", "E_SMTP_RECIPIENT_REJECTED"]);

/**
 * What Email Sending's answer to one send means for the list: a permanent failure for the
 * recipient suppresses it as a hard bounce; anything else (sent, queued, temporary errors) is null.
 * The answer is the error send() threw (`code`, `message`), or its result: the Workers binding
 * returns only `messageId`, while the REST API also lists `permanent_bounces`, which counts too.
 */
export function sendSuppression(to: string, answer: { error?: unknown; result?: unknown }): { email: string; reason: "hard-bounce"; detail: string | null } | null {
  const email = normalAddress(to);
  if (!email) return null;
  if (answer.error && typeof answer.error === "object") {
    const e = answer.error as { code?: unknown; message?: unknown };
    const code = typeof e.code === "string" ? e.code : "";
    if (!PERMANENT_SEND_CODES.has(code)) return null;
    return { email, reason: "hard-bounce", detail: clip(`${code.startsWith("E_SMTP_") ? "The SMTP server" : "Email Sending"} refused it: ${code}${typeof e.message === "string" && e.message ? `: ${e.message}` : ""}`) };
  }
  const r = answer.result && typeof answer.result === "object" ? (answer.result as { permanent_bounces?: unknown }) : null;
  const bounced = Array.isArray(r?.permanent_bounces) ? r.permanent_bounces : [];
  if (bounced.some((b) => typeof b === "string" && normalAddress(b) === email)) return { email, reason: "hard-bounce", detail: "Email Sending reported a permanent bounce when sending" };
  return null;
}

type Audit = (e: { action: string; target?: string; detail?: unknown }) => Promise<void>;

/** Apply provider events to the list, auditing each address suppressed. */
export async function recordMailEvents(db: D1Database, audit: Audit, events: unknown[], source: Exclude<SuppressionSource, "admin">): Promise<{ suppressed: string[]; ignored: number }> {
  const list = new Suppressions(db);
  const suppressed: string[] = [];
  for (const ev of events) {
    const s = suppressionFor(ev);
    if (!s) continue;
    await list.add({ ...s, source });
    await audit({ action: "email.suppression.add", target: s.email, detail: { reason: s.reason, source, detail: s.detail } });
    suppressed.push(s.email);
  }
  return { suppressed, ignored: events.length - suppressed.length };
}

// ---------------------------------------------------------------- the signed intake

/** How old a signed intake request may be, in seconds (either way, for clock skew). */
export const SIGNATURE_TOLERANCE_S = 300;
export const SIGNATURE_HEADER = "x-diffinery-signature";

/** The signature header for a body: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export async function signEvents(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`;
}

/** Whether a signature header is good for this body, and recent. */
export async function checkSignature(secret: string, header: string | null | undefined, body: string, nowMs = Date.now()): Promise<boolean> {
  if (!secret || !header || header.length > 1000) return false;
  const parts = new Map(header.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1") ?? "";
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(nowMs / 1000 - t) > SIGNATURE_TOLERANCE_S) return false;
  return safeEqual(v1, await hmacSha256Hex(secret, `${t}.${body}`));
}

// ---------------------------------------------------------------- verifying an address again

/** How long a verification link works. */
export const VERIFY_HOURS = 24;
/** Verification emails one account may ask for in an hour. */
export const MAX_VERIFY_EMAILS_PER_HOUR = 3;

export interface VerifyToken {
  accountId: string;
  email: string;
  expiresAt: number;
}

function verifySecrets(env: Pick<Env, "MASTER_KEY" | "MASTER_KEY_PREV" | "DEV_AUTH" | "ACCESS_AUD" | "PUBLIC_URL">): string[] {
  // Local development has no MASTER_KEY unless one is passed; production always does.
  return signingSecrets(env, devAuth(env) ? "diffinery-dev-verify-email" : null, "MASTER_KEY is not set, so verification links can't be signed");
}

const signVerify = async (secret: string, payload: string): Promise<string> => b64url(await hmacSha256(`diffinery-verify-email-v1:${secret}`, payload));

/** A signed link token: this account may lift the suppression on this address until it expires. */
export async function verifyToken(env: Env, t: VerifyToken): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ a: t.accountId, e: normalAddress(t.email), x: t.expiresAt })));
  return `${payload}.${await signVerify(verifySecrets(env)[0]!, payload)}`;
}

/** The token's contents when its signature is good and it hasn't expired; null otherwise. */
export async function readVerifyToken(env: Env, token: string, nowMs = Date.now()): Promise<VerifyToken | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig || token.length > 1000) return null;
  if (!(await matchesAnyKey(verifySecrets(env), sig, (s) => signVerify(s, payload)))) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { a?: unknown; e?: unknown; x?: unknown };
    if (typeof v.a !== "string" || typeof v.e !== "string" || typeof v.x !== "number" || v.x < nowMs) return null;
    return { accountId: v.a, email: v.e, expiresAt: v.x };
  } catch {
    return null;
  }
}
