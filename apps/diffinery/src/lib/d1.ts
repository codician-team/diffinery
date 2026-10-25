import type { Env } from "../env.js";

/**
 * D1 read replication through the Sessions API.
 *
 * Every request runs its D1 queries in one session, so reads can come from a nearby
 * replica while still seeing everything the same client wrote before:
 *
 * - Browsers carry the latest bookmark in a cookie. A request continues from it, so a
 *   page loaded after a form post sees that post's writes (sign-in, new repositories…).
 * - Token clients (git, CLI, MCP, runners) don't keep cookies, so they read from the
 *   primary unless they send back the `x-d1-bookmark` header from an earlier response.
 * - Anonymous first visits take the nearest copy ("first-unconstrained").
 *
 * Durable Objects, queue consumers and cron use the binding directly, which always
 * goes to the primary.
 */
export const BOOKMARK_COOKIE = "__Host-dfy_d1";
export const BOOKMARK_HEADER = "x-d1-bookmark";

/** Bookmarks look like `00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683`. */
export const isBookmark = (s: string | null | undefined): s is string => !!s && s.length <= 128 && /^[0-9a-f]+(-[0-9a-f]+){1,7}$/i.test(s);

export type D1Session = { env: Env; bookmark(): string | null };

/** An env whose DB runs every query in one session that starts at `constraint`. */
export function d1Session(env: Env, constraint: string): D1Session {
  // Test doubles and old runtimes without sessions keep using the binding as is.
  if (typeof env.DB.withSession !== "function") return { env, bookmark: () => null };
  const session = env.DB.withSession(constraint);
  return { env: { ...env, DB: session as unknown as D1Database }, bookmark: () => session.getBookmark() };
}

/** Where a request's session starts. */
export function sessionConstraint(o: { header?: string | null; cookie?: string | null; token: boolean }): string {
  if (isBookmark(o.header)) return o.header;
  if (!o.token && isBookmark(o.cookie)) return o.cookie;
  return o.token ? "first-primary" : "first-unconstrained";
}
