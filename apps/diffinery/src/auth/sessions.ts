import type { Env } from "../env.js";
import type { Account } from "../lib/directory.js";
import { newId, now, randomToken, sha256 } from "../lib/util.js";
import { enqueueMail } from "../mail/send.js";

/** Browser session cookie. `__Host-` pins it to this origin: Secure, Path=/, no Domain. */
export const SESSION_COOKIE = "__Host-dfy_session";
/** Binds an in-flight WebAuthn ceremony to the browser that started it. */
export const CHALLENGE_COOKIE = "__Host-dfy_webauthn";
export const SESSION_DAYS = 30;
/** However often it is used, a session ends this long after its sign-in. */
export const SESSION_MAX_DAYS = 90;
const CHALLENGE_MINUTES = 5;
const LINK_HOURS = 24;

export type PasskeyRow = {
  id: string;
  account_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_type: string;
  backed_up: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
};

export type SessionRow = {
  id: string;
  account_id: string;
  method: string;
  passkey_id: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
};

export type InviteRow = { id: string; email: string | null; org_id: string | null; repo_id: string | null; role: string };

/** Who a passkey being registered will belong to. */
export type Subject =
  | { kind: "account"; accountId: string }
  | { kind: "invite"; inviteHash: string; email: string; login: string; name: string; accountId: string }
  | { kind: "link"; linkHash: string; accountId: string }
  | { kind: "signup"; ticketHash: string; email: string; login: string; name: string; accountId: string }
  | { kind: "login" };

const days = (n: number): string => new Date(Date.now() + n * 86400_000).toISOString();

/** When a session signed in at `createdAt` ends at the latest. */
const lastDay = (createdAt: string): string => new Date(Date.parse(createdAt) + SESSION_MAX_DAYS * 86400_000).toISOString();

/** Sessions, passkeys, WebAuthn challenges and sign-in links in D1. */
export class Auth {
  constructor(private env: Env) {}

  private get db() {
    return this.env.DB;
  }

  /** Relying party: passkeys are bound to the hostname of PUBLIC_URL. */
  rp(): { id: string; origin: string; name: string } {
    const u = new URL(this.env.PUBLIC_URL);
    return { id: u.hostname, origin: u.origin, name: "Diffinery" };
  }

  // ---------------------------------------------------------------- sessions

  async createSession(accountId: string, method: "passkey" | "access" | "link", passkeyId: string | null, userAgent: string | null): Promise<string> {
    const token = randomToken(32);
    const at = now();
    await this.db
      .prepare("INSERT INTO sessions (id, account_id, method, passkey_id, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(await sha256(token), accountId, method, passkeyId, userAgent?.slice(0, 300) ?? null, at, at, days(SESSION_DAYS))
      .run();
    return token;
  }

  /** Resolve a session cookie. Sessions slide: each day of use extends them by another 30 days, up to 90 days after the sign-in. */
  async session(token: string): Promise<{ session: SessionRow; account: Account } | null> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const id = await sha256(token);
    // Both at once, the account through the session's own row: every signed-in page waits for this.
    const [row, account] = await Promise.all([
      this.db.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>(),
      this.db.prepare("SELECT * FROM accounts WHERE id = (SELECT account_id FROM sessions WHERE id = ?)").bind(id).first<Account>(),
    ]);
    if (!row || row.expires_at < now() || lastDay(row.created_at) < now()) return null;
    if (!account || account.id !== row.account_id || account.kind !== "user" || account.status === "disabled") return null;
    if (Date.now() - Date.parse(row.last_seen_at) > 86400_000) {
      const until = days(SESSION_DAYS);
      const last = lastDay(row.created_at);
      await this.db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").bind(now(), until < last ? until : last, row.id).run();
    }
    return { session: row, account };
  }

  async endSession(token: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256(token)).run();
  }

  async sessions(accountId: string): Promise<SessionRow[]> {
    const r = await this.db.prepare("SELECT * FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY last_seen_at DESC LIMIT 100").bind(accountId, now()).all<SessionRow>();
    return r.results;
  }

  /** End one of the account's own sessions; false when it has none by that id. */
  async endSessionById(accountId: string, id: string): Promise<boolean> {
    const r = await this.db.prepare("DELETE FROM sessions WHERE id = ? AND account_id = ?").bind(id, accountId).run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** Sign out every other browser of the account; returns how many were signed out. */
  async endOtherSessions(accountId: string, keepId: string | null): Promise<number> {
    const r = await this.db.prepare("DELETE FROM sessions WHERE account_id = ? AND id != ?").bind(accountId, keepId ?? "").run();
    return r.meta.changes ?? 0;
  }

  async endAllSessions(accountId: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE account_id = ?").bind(accountId).run();
  }

  // ---------------------------------------------------------------- passkeys

  async passkeys(accountId: string): Promise<PasskeyRow[]> {
    const r = await this.db.prepare("SELECT * FROM passkeys WHERE account_id = ? ORDER BY created_at").bind(accountId).all<PasskeyRow>();
    return r.results;
  }

  async passkey(id: string): Promise<PasskeyRow | null> {
    return this.db.prepare("SELECT * FROM passkeys WHERE id = ?").bind(id).first<PasskeyRow>();
  }

  async addPasskey(p: Omit<PasskeyRow, "created_at" | "last_used_at">): Promise<void> {
    await this.db
      .prepare("INSERT INTO passkeys (id, account_id, public_key, counter, transports, device_type, backed_up, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(p.id, p.account_id, p.public_key, p.counter, p.transports, p.device_type, p.backed_up, p.name.slice(0, 100), now())
      .run();
  }

  async passkeyUsed(id: string, counter: number, backedUp: boolean): Promise<void> {
    await this.db.prepare("UPDATE passkeys SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ?").bind(counter, backedUp ? 1 : 0, now(), id).run();
  }

  async renamePasskey(accountId: string, id: string, name: string): Promise<void> {
    await this.db.prepare("UPDATE passkeys SET name = ? WHERE id = ? AND account_id = ?").bind(name.slice(0, 100), id, accountId).run();
  }

  /** Remove a passkey and every other session it signed in (a lost device's browsers). */
  async deletePasskey(accountId: string, id: string, keepSessionId: string | null): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM sessions WHERE account_id = ? AND passkey_id = ? AND id != ?").bind(accountId, id, keepSessionId ?? ""),
      this.db.prepare("DELETE FROM passkeys WHERE id = ? AND account_id = ?").bind(id, accountId),
    ]);
  }

  // ---------------------------------------------------------------- WebAuthn challenges

  /** Store a challenge; returns the value for the browser's challenge cookie. */
  async saveChallenge(purpose: "login" | "register", challenge: string, subject: Subject): Promise<string> {
    const token = randomToken(24);
    const expires = new Date(Date.now() + CHALLENGE_MINUTES * 60_000).toISOString();
    await this.db.batch([
      this.db.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?").bind(now()),
      this.db.prepare("INSERT INTO webauthn_challenges (id, purpose, challenge, subject, expires_at) VALUES (?, ?, ?, ?, ?)").bind(await sha256(token), purpose, challenge, JSON.stringify(subject), expires),
    ]);
    return token;
  }

  /** Consume a challenge exactly once. */
  async takeChallenge(token: string | undefined, purpose: "login" | "register"): Promise<{ challenge: string; subject: Subject } | null> {
    if (!token) return null;
    const row = await this.db
      .prepare("DELETE FROM webauthn_challenges WHERE id = ? RETURNING purpose, challenge, subject, expires_at")
      .bind(await sha256(token))
      .first<{ purpose: string; challenge: string; subject: string; expires_at: string }>();
    if (!row || row.purpose !== purpose || row.expires_at < now()) return null;
    return { challenge: row.challenge, subject: JSON.parse(row.subject) as Subject };
  }

  // ---------------------------------------------------------------- invites and sign-in links

  /** An open invite by its secret token (null when used, expired or unknown). */
  async invite(token: string): Promise<(InviteRow & { hash: string }) | null> {
    const hash = await sha256(token);
    const row = await this.db.prepare("SELECT id, email, org_id, repo_id, role FROM invites WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?").bind(hash, now()).first<InviteRow>();
    return row ? { ...row, hash } : null;
  }

  async inviteByHash(hash: string): Promise<InviteRow | null> {
    return this.db.prepare("SELECT id, email, org_id, repo_id, role FROM invites WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?").bind(hash, now()).first<InviteRow>();
  }

  /** A single-use link that lets the holder add a passkey to `account` (account recovery, new devices). */
  async createSigninLink(by: Account, account: Account): Promise<{ url: string; expiresAt: string }> {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + LINK_HOURS * 3600_000).toISOString();
    await this.db
      .prepare("INSERT INTO signin_links (id, token_hash, account_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId(), await sha256(token), account.id, by.id, now(), expiresAt)
      .run();
    // The token rides in the fragment, which browsers never send to the server, so request logs never hold
    // it (web/auth.tsx /signin). Links sent before this used /signin/<token>, still accepted until they expire.
    const url = `${this.env.PUBLIC_URL}/signin#${token}`;
    await enqueueMail(this.env, [{ kind: "signin_link", data: { url, admin: by.login, expiresAt }, to: { accountId: account.id }, reason: "account", at: now() }]);
    return { url, expiresAt };
  }

  async signinLink(token: string): Promise<{ hash: string; account: Account } | null> {
    const hash = await sha256(token);
    const row = await this.db.prepare("SELECT account_id FROM signin_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").bind(hash, now()).first<{ account_id: string }>();
    if (!row) return null;
    const account = await this.db.prepare("SELECT * FROM accounts WHERE id = ?").bind(row.account_id).first<Account>();
    return account && account.kind === "user" ? { hash, account } : null;
  }

  /** Mark a link used; false when someone else used it first. */
  async useSigninLink(hash: string): Promise<boolean> {
    const r = await this.db.prepare("UPDATE signin_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").bind(now(), hash, now()).run();
    return (r.meta.changes ?? 0) > 0;
  }
}

/** Read one cookie from a raw request. */
export function cookieFrom(req: Request, name: string): string | undefined {
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
