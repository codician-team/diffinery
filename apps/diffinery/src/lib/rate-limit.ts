import type { Context } from "hono";
import type { Env } from "../env.js";
import type { Principal } from "../auth/principal.js";

/**
 * Request rate limits (Workers rate limiting bindings, configured in wrangler.jsonc). Each
 * binding counts per key over 60 seconds in the Cloudflare location that serves the request, so
 * the limits stop floods and scripted abuse rather than meter use exactly. A binding that isn't
 * configured (local development) or that fails lets the request through, unless RATE_LIMITS=durable:
 * then the RATE_LIMITER Durable Object counts that bucket instead (rate-limiter.ts), for deployments
 * without the bindings, such as celld. It fails open too.
 *
 * - RL_AUTH: sign-in, passkey registration, invitation and sign-in links, open sign-up, private
 *   security reports (/security/report), early access requests and their confirmations
 *   (/early-access and its confirm and remove pages), contact messages and their confirmations
 *   (/contact and /contact/confirm), CLI sign-ins (starting one, typing or approving a
 *   code), and MCP apps registering themselves for OAuth (/oauth/register), per IP address.
 * - RL_ANON: everything else from someone who isn't signed in, per IP address.
 * - RL_ACCOUNT: everything from a signed-in person, agent or personal token, per account; from an
 *   app's JWT, per app; from an app's installation token, per installation.
 * - RL_CREATE: creating things other people see or that cost storage (repositories,
 *   organizations, issues, pull requests, comments, reviews, releases), and reports to the site
 *   administrators, per account.
 *
 * Job, sandbox, runner and import credentials aren't counted here: their work is bounded by
 * the job, sandbox and import limits.
 */

export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

export type Bucket = "RL_AUTH" | "RL_ANON" | "RL_ACCOUNT" | "RL_CREATE";

/** The limits each binding is configured with in production (wrangler.jsonc), for messages and docs. */
export const RATE_LIMITS: Record<Bucket, number> = { RL_AUTH: 20, RL_ANON: 300, RL_ACCOUNT: 2000, RL_CREATE: 60 };
export const RATE_PERIOD_S = 60;

/**
 * Paths that never count: health checks, avatars, the Actions runtime and runners (their own credentials), and
 * the GitHub App's signed webhook, which GitHub sends from a few addresses for every job of every installation.
 */
const EXEMPT = /^\/(?:healthz$|api\/avatars\/|twirp\/|_runtime\/|_apis\/|runner\/|-\/model\/|-\/github\/webhook$)/;
const AUTH = /^\/(?:auth\/passkey\/|invite\/|signin\/|login(?:$|\/)|signup(?:$|\/)|security\/report$|early-access(?:\/confirm|\/remove(?:\/confirm)?)?$|contact(?:\/confirm)?$|-\/cli\/device$|oauth\/register$)/;
const CREATE: Array<[method: string, path: RegExp]> = [
  ["POST", /^\/api\/v3\/(?:user|orgs\/[^/]+)\/repos$/],
  ["POST", /^\/api\/v3\/(?:user\/orgs|admin\/organizations)$/],
  ["POST", /^\/api\/v3\/repos\/[^/]+\/[^/]+\/(?:issues|pulls|releases|forks)$/],
  ["POST", /^\/api\/v3\/repos\/[^/]+\/[^/]+\/(?:issues|pulls)\/\d+\/(?:comments|reviews)$/],
  ["POST", /^\/api\/v3\/repos\/[^/]+\/[^/]+\/(?:commits\/[^/]+\/comments|pulls\/\d+\/comments\/\d+\/replies)$/],
  ["POST", /^\/new(?:\/import)?$/],
  ["POST", /^\/settings\/orgs$/],
  ["POST", /^\/[^/]+\/[^/]+\/(?:issues|pulls|releases)$/],
  ["POST", /^\/[^/]+\/[^/]+\/(?:issues\/\d+\/comment|pull\/\d+\/(?:review|line-comment))$/],
  // Reports to the site administrators (lib/moderation.ts also caps them per day).
  ["POST", /^\/api\/v3\/diffinery\/reports$/],
  ["POST", /^\/-\/report$/],
];

/** Which buckets a request counts against, with their keys. */
export function bucketsFor(method: string, path: string, p: Principal, ip: string): Array<[Bucket, string]> {
  if (EXEMPT.test(path)) return [];
  if (AUTH.test(path) && method !== "GET") return [["RL_AUTH", `ip:${ip}`]];
  if (p.type === "anonymous") return [["RL_ANON", `ip:${ip}`]];
  if (p.type !== "account" && p.type !== "app" && p.type !== "installation") return [];
  const key = p.type === "account" ? `acct:${p.account.id}` : p.type === "app" ? `app:${p.app.id}` : `inst:${p.auth.installation.id}`;
  const out: Array<[Bucket, string]> = [["RL_ACCOUNT", key]];
  // MCP tool calls that change things count in mcp/server.ts, where the tool is known.
  if (CREATE.some(([m, re]) => m === method && re.test(path))) out.push(["RL_CREATE", key]);
  return out;
}

/** The bucket that's over its limit for this request, or null. */
export async function overLimit(env: Env, buckets: Array<[Bucket, string]>): Promise<Bucket | null> {
  const unbound: Array<[Bucket, string]> = [];
  for (const [b, key] of buckets) {
    const rl = (env as unknown as Record<string, RateLimiter | undefined>)[b];
    if (!rl) {
      unbound.push([b, key]);
      continue;
    }
    try {
      if (!(await rl.limit({ key })).success) return b;
    } catch (e) {
      console.error("rate limiter failed", b, e);
    }
  }
  return durableOverLimit(env, unbound);
}

/**
 * Model requests through the proxy (/-/model/*), per paying person across all their runs (phase 5a): above the
 * per-run limits and budgets, it caps how fast a leaked run token or a runaway task can spend a person's key. Kept
 * out of `bucketsFor` because only the run's ProjectDO knows who pays. Must match RL_MODEL in wrangler.jsonc.
 */
export const MODEL_RATE_LIMIT = 600;

/** Whether this person is over their model request rate. A missing (local) or failing binding lets it through. */
export async function modelRateLimited(env: Env, personId: string): Promise<boolean> {
  if (!env.RL_MODEL) return (await durableOverLimit(env, [["RL_MODEL", `model:${personId}`]])) !== null;
  try {
    return !(await env.RL_MODEL.limit({ key: `model:${personId}` })).success;
  } catch (e) {
    console.error("model rate limiter failed", e);
    return false;
  }
}

/** Limits per window for the Durable Object fallback: the same as the bindings'. */
const DURABLE_LIMITS: Record<Bucket | "RL_MODEL", number> = { ...RATE_LIMITS, RL_MODEL: MODEL_RATE_LIMIT };

/**
 * Objects the fallback spreads keys over. A key always lands on the same one; the requests of one
 * key (one address, one account) can't be spread anyway, and a fixed set keeps the objects few and
 * warm instead of one per address.
 */
export const RATE_LIMITER_SHARDS = 32;

/** The RATE_LIMITER object that counts `key`: FNV-1a of the key, modulo the shards. */
export function rateLimiterShard(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return `shard-${(h >>> 0) % RATE_LIMITER_SHARDS}`;
}

/**
 * Counts buckets that have no binding in the RATE_LIMITER Durable Object, when RATE_LIMITS=durable.
 * One call per key, so a request costs one call: its buckets share a key (an account's requests
 * and its new content). A failing object lets the request through, as a failing binding does.
 */
async function durableOverLimit<B extends Bucket | "RL_MODEL">(env: Env, buckets: Array<[B, string]>): Promise<B | null> {
  const ns = env.RATE_LIMITS === "durable" ? env.RATE_LIMITER : undefined;
  if (!ns || !buckets.length) return null;
  const byKey = new Map<string, Array<[B, number]>>();
  for (const [b, key] of buckets) byKey.set(key, [...(byKey.get(key) ?? []), [b, DURABLE_LIMITS[b]]]);
  for (const [key, limits] of byKey) {
    try {
      const over = await ns.get(ns.idFromName(rateLimiterShard(key))).hit(key, limits);
      if (over) return over as B;
    } catch (e) {
      console.error("rate limiter object failed", e);
    }
  }
  return null;
}

const WHAT: Record<Bucket, string> = {
  RL_AUTH: "sign-in attempts, security reports, early access requests and contact messages from your network",
  RL_ANON: "requests from your network without signing in",
  RL_ACCOUNT: "requests from your account",
  RL_CREATE: "new repositories, issues, pull requests and comments from your account",
};

/** A 429 that GitHub clients understand (`retry-after`, `x-ratelimit-remaining: 0`). */
export function tooMany(c: Context, b: Bucket): Response {
  const message = `Too many ${WHAT[b]}: at most ${RATE_LIMITS[b]} a minute. Try again in a minute.`;
  const headers = { "retry-after": String(RATE_PERIOD_S), "x-ratelimit-limit": String(RATE_LIMITS[b]), "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + RATE_PERIOD_S) };
  const html = (c.req.header("accept") ?? "").includes("text/html");
  return html ? new Response(message, { status: 429, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } }) : Response.json({ message }, { status: 429, headers });
}
