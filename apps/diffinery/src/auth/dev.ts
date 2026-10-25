import type { Env } from "../env.js";

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;
/** Whether `url` is on this machine (localhost, 127.x or [::1]). */
export const loopback = (url: string | undefined): boolean => {
  try {
    return !!url && LOOPBACK.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

/**
 * Local development's fixed sign-in (DEV_AUTH) makes every visitor that person, so it works only
 * where nobody else can reach: PUBLIC_URL and the request itself must both be on this machine
 * (localhost, 127.x or [::1]), and Cloudflare Access must be off. A DEV_AUTH left in a deployed
 * configuration does nothing. Without a request, only PUBLIC_URL is checked.
 */
export function devAuth(env: Pick<Env, "DEV_AUTH" | "ACCESS_AUD" | "PUBLIC_URL">, requestUrl?: string): boolean {
  if (!env.DEV_AUTH || env.ACCESS_AUD || !loopback(env.PUBLIC_URL)) return false;
  return requestUrl === undefined || loopback(requestUrl);
}

/**
 * Whether this Worker runs on this machine only (wrangler dev, the end-to-end tests): PUBLIC_URL on a loopback
 * address and Cloudflare Access off. Test-only settings that loosen a control count only then.
 */
export function localOnly(env: Pick<Env, "ACCESS_AUD" | "PUBLIC_URL">): boolean {
  return !env.ACCESS_AUD && loopback(env.PUBLIC_URL);
}

/**
 * A timer an end-to-end test may shorten: `value` (ms, from a test-only variable) counts only on a Worker on this
 * machine (`localOnly`), and only between `min` and `fallback`. Anything else gets `fallback`.
 */
export function localTimer(env: Pick<Env, "ACCESS_AUD" | "PUBLIC_URL">, value: string | undefined, fallback: number, min: number): number {
  if (!value || !localOnly(env)) return fallback;
  const ms = Number(value);
  return Number.isInteger(ms) && ms >= min && ms <= fallback ? ms : fallback;
}
