import { devAuth } from "../auth/dev.js";
import type { Env } from "../env.js";
import { hmacSha256, matchesAnyKey, signingSecrets } from "../lib/crypto.js";
import { b64url, fromB64url } from "../lib/util.js";
import type { Category } from "./types.js";

/**
 * Unsubscribe links work without signing in, so each one carries a signed
 * capability: whose settings to change and what to turn off. The key is
 * derived from MASTER_KEY, so links stay valid across deploys (and across a
 * rotation, while the old key is MASTER_KEY_PREV), and each one expires about
 * a year after it was sent.
 */
export type UnsubScope =
  /** Stop email for a settings group. */
  | { t: "category"; category: Exclude<Category, "security" | "account"> }
  /** Mute one issue or pull request. */
  | { t: "thread"; repoId: string; number: number; repo: string }
  /** Stop watching a repository. */
  | { t: "repo"; repoId: string; repo: string };

export interface UnsubToken {
  accountId: string;
  scope: UnsubScope;
}

function secrets(env: Env): string[] {
  // Local development has no MASTER_KEY unless one is passed; production always does.
  return signingSecrets(env, devAuth(env) ? "diffinery-dev-unsubscribe" : null, "MASTER_KEY is not set, so unsubscribe links can't be signed");
}

const signWith = async (secret: string, payload: string): Promise<string> => b64url(await hmacSha256(`diffinery-unsubscribe-v1:${secret}`, payload));

/** How long an unsubscribe link works: about a year, so old emails in someone's inbox stop being a capability. */
export const UNSUB_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/** Links signed before they carried an expiry keep working until this date (a year after expiries were added). */
export const UNSUB_LEGACY_CUTOFF_MS = Date.UTC(2027, 9, 16);

export async function unsubToken(env: Env, t: UnsubToken, now = Date.now()): Promise<string> {
  // `e` is the expiry in seconds since the epoch.
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ a: t.accountId, s: t.scope, e: Math.floor((now + UNSUB_TTL_MS) / 1000) })));
  return `${payload}.${await signWith(secrets(env)[0]!, payload)}`;
}

export async function readUnsubToken(env: Env, token: string, now = Date.now()): Promise<UnsubToken | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig || token.length > 2000) return null;
  if (!(await matchesAnyKey(secrets(env), sig, (s) => signWith(s, payload)))) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { a?: unknown; s?: UnsubScope; e?: unknown };
    if (typeof v.a !== "string" || !v.s || typeof v.s !== "object") return null;
    // A link without an expiry was sent before links had one; those are honoured only until the cutoff.
    const expires = v.e === undefined ? UNSUB_LEGACY_CUTOFF_MS : typeof v.e === "number" ? v.e * 1000 : 0;
    if (now >= expires) return null;
    return { accountId: v.a, scope: v.s };
  } catch {
    return null;
  }
}

export async function unsubUrl(env: Env, t: UnsubToken): Promise<string> {
  return `${env.PUBLIC_URL}/-/unsubscribe/${await unsubToken(env, t)}`;
}
