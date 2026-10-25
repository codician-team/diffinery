import type { Env } from "../env.js";
import { Directory, type Account, type TokenScope } from "../lib/directory.js";
import { HttpError, b64url, newId, now, randomToken, sha256 } from "../lib/util.js";
import { TOKEN_SCOPES } from "./principal.js";

/**
 * Signing the CLI in through the browser, so nobody copies tokens by hand. Two flows, both ending
 * in a token minted for the CLI and listed in Settings → Access tokens:
 *
 * - Browser (`diffinery login`): the CLI listens on 127.0.0.1, opens /login/cli with a PKCE
 *   challenge, and the person approves. Diffinery sends the browser to the CLI's local callback
 *   with a one-time code that only works together with the verifier the CLI kept (RFC 8252).
 *   A link someone else crafted leads nowhere: the code goes to the clicking person's own machine.
 * - Device (`diffinery login --device`, for machines without a browser): the CLI gets a device
 *   code it keeps and a short user code it shows; the person types the user code on
 *   /login/device in any browser and approves, while the CLI polls (RFC 8628). The code is never
 *   put in a link, so a phishing link can't carry one.
 *
 * Approving needs a passkey sign-in from the last 2 hours, like creating any token. Only hashes
 * of the codes are stored, codes expire within minutes and work once, and the token itself is
 * minted when the CLI trades its secret, so it is never stored or shown anywhere but the CLI.
 */

/** How long a device code waits for the person, and how often the CLI may ask. */
export const DEVICE_TTL_S = 600;
export const DEVICE_INTERVAL_S = 5;
/** How long the browser flow's one-time code waits for the CLI to trade it. */
export const CODE_TTL_S = 120;
/** CLI tokens last this long; the expiry reminder email says to run `diffinery login` again. */
export const CLI_TOKEN_DAYS = 90;

/** RFC 8628's suggestion: consonants only (no vowels, so no words), without easily confused letters. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;

export interface CliClient {
  host: string;
  os: string;
  version: string;
}

export interface CliLoginRow {
  id: string;
  flow: "browser" | "device";
  user_code: string | null;
  client: string;
  requested_scope: string;
  ip: string | null;
  location: string | null;
  status: "pending" | "approved" | "denied" | "used";
  account_id: string | null;
  scope: string | null;
  created_at: string;
  expires_at: string;
  code_challenge: string | null;
}

/** What the CLI reported about itself, trimmed to something safe to show and to name a token after. */
export function cleanClient(input: { host?: unknown; os?: unknown; version?: unknown }): CliClient {
  const clean = (v: unknown, max: number) =>
    (typeof v === "string" ? v : "")
      .replace(/[^\w .,:@()+/-]/g, "")
      .trim()
      .slice(0, max);
  return { host: clean(input.host, 64) || "unknown host", os: clean(input.os, 40), version: clean(input.version, 20) };
}

export function parseClient(json: string): CliClient {
  try {
    return cleanClient(JSON.parse(json) as Record<string, unknown>);
  } catch {
    return cleanClient({});
  }
}

export function scopeOf(v: unknown, fallback: TokenScope = "write"): TokenScope {
  return TOKEN_SCOPES.includes(v as TokenScope) ? (v as TokenScope) : fallback;
}

/** The name the token gets, e.g. "Diffinery CLI on alices-mbp". */
export const tokenName = (c: CliClient) => `Diffinery CLI on ${c.host}`.slice(0, 80);

/** A user code as typed: any case, with or without the dash or spaces. Null when it can't be one. */
export function normalizeUserCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== USER_CODE_LENGTH) return null;
  for (const ch of s) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return s;
}

export const formatUserCode = (s: string) => `${s.slice(0, 4)}-${s.slice(4)}`;

function newUserCode(): string {
  // 256 is not a multiple of 20: reject the top values so every letter is equally likely.
  let out = "";
  while (out.length < USER_CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 240 && out.length < USER_CODE_LENGTH) out += USER_CODE_ALPHABET[b % 20];
    }
  }
  return out;
}

/** The PKCE S256 challenge of a verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** A loopback port the browser may be sent to: unprivileged, so not a system service's. */
export function loopbackPort(v: unknown): number | null {
  const n = typeof v === "string" && /^\d{4,5}$/.test(v) ? Number(v) : NaN;
  return n >= 1024 && n <= 65535 ? n : null;
}

/** A PKCE S256 challenge or an OAuth state: base64url, 43 characters for 32 bytes, at most 128. */
export const isB64urlParam = (v: unknown, min = 16): v is string => typeof v === "string" && v.length >= min && v.length <= 128 && /^[A-Za-z0-9_-]+$/.test(v);

/** Errors the token endpoint answers with, as in RFC 8628 and RFC 6749. */
export type TokenError = "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_grant" | "invalid_request";

export class CliLoginError extends Error {
  constructor(
    readonly error: TokenError,
    readonly description: string,
  ) {
    super(description);
  }
}

export class CliLogins {
  constructor(
    private env: Env,
    private dir = new Directory(env),
  ) {}

  private get db(): D1Database {
    return this.env.DB;
  }

  /** The CLI starts a device sign-in. Returns the device code (only the CLI ever sees it) and the user code. */
  async startDevice(client: CliClient, scope: TokenScope, from: { ip?: string; location?: string }): Promise<{ deviceCode: string; userCode: string; expiresIn: number; interval: number }> {
    const deviceCode = randomToken(32);
    for (let attempt = 0; ; attempt++) {
      const userCode = newUserCode();
      try {
        await this.db
          .prepare("INSERT INTO cli_logins (id, flow, secret_hash, user_code, client, requested_scope, ip, location, status, created_at, expires_at) VALUES (?, 'device', ?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
          .bind(newId(), await sha256(deviceCode), userCode, JSON.stringify(client), scope, from.ip ?? null, from.location ?? null, now(), new Date(Date.now() + DEVICE_TTL_S * 1000).toISOString())
          .run();
        return { deviceCode, userCode, expiresIn: DEVICE_TTL_S, interval: DEVICE_INTERVAL_S };
      } catch (e) {
        // A user code still in the table (they're kept a day): pick another.
        if (attempt < 3 && /UNIQUE/i.test(String(e))) continue;
        throw e;
      }
    }
  }

  /** The pending device sign-in a typed code names, or null (unknown, expired or already decided). */
  async pendingDevice(userCode: string): Promise<CliLoginRow | null> {
    const code = normalizeUserCode(userCode);
    if (!code) return null;
    return this.db.prepare("SELECT * FROM cli_logins WHERE user_code = ? AND flow = 'device' AND status = 'pending' AND expires_at > ?").bind(code, now()).first<CliLoginRow>();
  }

  /** The person approves or denies a device sign-in. False when it's no longer pending. */
  async decideDevice(id: string, person: Account, approve: boolean, scope: TokenScope): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE cli_logins SET status = ?, account_id = ?, scope = ?, decided_at = ? WHERE id = ? AND flow = 'device' AND status = 'pending' AND expires_at > ?")
      .bind(approve ? "approved" : "denied", person.id, approve ? scope : null, now(), id, now())
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** The person approved a browser sign-in: a one-time code for the CLI's callback, bound to its PKCE challenge. */
  async approveBrowser(person: Account, client: CliClient, scope: TokenScope, challenge: string): Promise<string> {
    const code = randomToken(32);
    await this.db
      .prepare("INSERT INTO cli_logins (id, flow, secret_hash, code_challenge, client, requested_scope, status, account_id, scope, created_at, expires_at, decided_at) VALUES (?, 'browser', ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)")
      .bind(newId(), await sha256(code), challenge, JSON.stringify(client), scope, person.id, scope, now(), new Date(Date.now() + CODE_TTL_S * 1000).toISOString(), now())
      .run();
    return code;
  }

  /**
   * The CLI trades its secret for a token: the browser flow's code with the PKCE verifier, or the
   * device code. Each works once; the claim is a single conditional write, so two requests racing
   * with the same secret can't both get a token.
   */
  async exchange(grant: { type: "code"; code: string; verifier: string } | { type: "device"; deviceCode: string }): Promise<{ token: string; scope: TokenScope; expiresAt: string; login: string; tokenId: string }> {
    const hash = await sha256(grant.type === "code" ? grant.code : grant.deviceCode);
    const flow = grant.type === "code" ? "browser" : "device";
    const at = now();
    const claimed = await this.db
      .prepare("UPDATE cli_logins SET status = 'used', used_at = ? WHERE secret_hash = ? AND flow = ? AND status = 'approved' AND expires_at > ? RETURNING *")
      .bind(at, hash, flow, at)
      .first<CliLoginRow>();
    if (!claimed) {
      const row = await this.db.prepare("SELECT status, expires_at FROM cli_logins WHERE secret_hash = ? AND flow = ?").bind(hash, flow).first<{ status: string; expires_at: string }>();
      if (!row) throw new CliLoginError("invalid_grant", "unknown or already used code");
      if (row.status === "denied") throw new CliLoginError("access_denied", "the sign-in was denied in the browser");
      if (row.status === "used") throw new CliLoginError("invalid_grant", "this code was already used");
      if (row.expires_at <= at) throw new CliLoginError("expired_token", "the code expired; run `diffinery login` again");
      throw new CliLoginError("authorization_pending", "waiting for you to approve the sign-in in the browser");
    }
    // The verifier is checked after the claim so a wrong guess burns the code rather than allowing retries.
    if (grant.type === "code" && (!claimed.code_challenge || (await pkceChallenge(grant.verifier)) !== claimed.code_challenge)) {
      throw new CliLoginError("invalid_grant", "the code verifier doesn't match");
    }
    const person = claimed.account_id ? await this.dir.account(claimed.account_id) : null;
    if (!person || person.status !== "active" || person.kind !== "user") throw new CliLoginError("access_denied", "the account that approved this sign-in can't sign in");
    const scope = scopeOf(claimed.scope);
    const client = parseClient(claimed.client);
    const t = await this.dir.createToken(person, { name: tokenName(client), scopes: [scope], expiresInDays: CLI_TOKEN_DAYS, client: "cli" });
    await this.db.prepare("UPDATE cli_logins SET token_id = ? WHERE id = ?").bind(t.id, claimed.id).run();
    await this.dir.audit({ actorId: person.id, actorLogin: person.login, action: "token.create", target: person.login, detail: { name: tokenName(client), scope, via: `cli ${flow} sign-in` } });
    return { token: t.token, scope, expiresAt: t.expiresAt, login: person.login, tokenId: t.id };
  }

  /** `diffinery logout`: a CLI token revokes itself. Other tokens are left alone (they may be used elsewhere). */
  async revokeCliToken(accountId: string, tokenId: string): Promise<boolean> {
    const r = await this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND account_id = ? AND client = 'cli' AND revoked_at IS NULL").bind(now(), tokenId, accountId).run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** Housekeeping: rows a day past their expiry. */
  async prune(): Promise<void> {
    await this.db.prepare("DELETE FROM cli_logins WHERE expires_at < ?").bind(new Date(Date.now() - 86400_000).toISOString()).run();
  }
}

/** Throws a 422 for a scope that isn't one of read, write and admin. */
export function requireScopeName(v: unknown): TokenScope {
  if (v === undefined || v === null || v === "") return "write";
  if (!TOKEN_SCOPES.includes(v as TokenScope)) throw new HttpError(422, `scope must be one of: ${TOKEN_SCOPES.join(", ")}`);
  return v as TokenScope;
}
