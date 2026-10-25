import type { Env } from "../env.js";
import { localOnly } from "../auth/dev.js";
import { checkPublicUrl } from "../imports/options.js";
import { masterKeys } from "./crypto.js";
import { Sha256 } from "./sha256.js";
import { b64url, fromB64url, safeEqual } from "./util.js";

/**
 * Diffinery's image proxy for Markdown, like GitHub's camo. An image in an issue, comment,
 * README or release from another site would otherwise tell that site the IP address, browser
 * and viewing time of everyone who reads it, private repositories included. The renderer
 * rewrites such images to
 *
 *   /-/camo/<signature>/<url, base64url>
 *
 * and the Worker fetches them (http/camo.ts), so viewers' browsers only talk to Diffinery.
 * Only URLs Diffinery signed are fetched, so the route isn't an open proxy.
 */

type KeyEnv = Pick<Env, "MASTER_KEY" | "MASTER_KEY_PREV" | "ACCESS_AUD" | "PUBLIC_URL">;

/**
 * The keys proxy URLs are checked with, from the master keys under their own label: the current
 * one first (the one new URLs are signed with), then MASTER_KEY_PREV while MASTER_KEY rotates, so
 * pages rendered and cached before a rotation keep their images (lib/crypto.ts masterKeys).
 */
export function camoKeys(env: KeyEnv): Uint8Array[] {
  // Local development has no MASTER_KEY unless one is passed; production always does.
  const secrets = masterKeys(env);
  if (!secrets.length && localOnly(env)) secrets.push("diffinery-dev-camo");
  return secrets.map((s) => new TextEncoder().encode(`diffinery-camo-v1:${s}`));
}

/** The key new proxy URLs are signed with. */
export function camoKey(env: KeyEnv): Uint8Array | null {
  return camoKeys(env)[0] ?? null;
}

const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));

/**
 * HMAC-SHA256, synchronous so the (synchronous) Markdown renderer can sign while it renders.
 * Gives the same result as WebCrypto's HMAC with the same key (checked in the unit tests).
 */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const k = key.length > 64 ? hexBytes(new Sha256().update(key).hex()) : key;
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  ipad.set(k);
  opad.set(k);
  for (let i = 0; i < 64; i++) {
    ipad[i]! ^= 0x36;
    opad[i]! ^= 0x5c;
  }
  const inner = hexBytes(new Sha256().update(ipad).update(message).hex());
  return hexBytes(new Sha256().update(opad).update(inner).hex());
}

const sign = (key: Uint8Array, url: string): string => b64url(hmacSha256(key, new TextEncoder().encode(url)));

/** Longest image URL the proxy takes; longer ones are shown as their alt text. */
export const MAX_CAMO_URL = 2048;
export const CAMO_PREFIX = "/-/camo/";

/** The proxy path for `url` (absolute, already checked by the caller). */
export function camoPath(key: Uint8Array, url: string): string {
  return `${CAMO_PREFIX}${sign(key, url)}/${b64url(new TextEncoder().encode(url))}`;
}

/** The URL a proxy path's two segments stand for, or null when the signature matches none of `keys`. */
export function verifyCamo(keys: Uint8Array | readonly Uint8Array[], sig: string, encoded: string): string | null {
  if (sig.length > 64 || encoded.length > Math.ceil((MAX_CAMO_URL * 4) / 3) + 4) return null;
  if (!/^[\w-]+$/.test(sig) || !/^[\w-]+$/.test(encoded)) return null;
  let url: string;
  try {
    url = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromB64url(encoded));
  } catch {
    return null;
  }
  return (keys instanceof Uint8Array ? [keys] : keys).some((key) => safeEqual(sig, sign(key, url))) ? url : null;
}

/**
 * Where a Markdown image's src should point, for the renderer's `image` option: same-origin and
 * root-relative URLs (repository files, avatars, Diffinery's own assets) stay as written; images
 * from anywhere else go through the proxy. Null means "show the alt text instead": no key to
 * sign with, or a URL the proxy wouldn't fetch anyway.
 *
 * http:// images are signed as https://, as browsers already upgrade them on an https page.
 */
export function imageProxy(env: KeyEnv | undefined): (url: string) => string | null {
  // Without a configuration (no request in progress) relative URLs still resolve to "here", a
  // host that can never exist (RFC 2606), so a URL written for it can't load anything either.
  const own = ownOrigin(env) ?? "https://diffinery.invalid";
  const key = env ? camoKey(env) : null;
  const dev = !!env && localOnly(env);
  return (src) => {
    let u: URL;
    try {
      // The browser's own parser, so stray tabs or backslashes resolve here as they would there.
      u = new URL(src, own);
    } catch {
      return null;
    }
    if (u.origin === own) return src;
    if (!key || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
    if (u.protocol === "http:" && !dev) u.protocol = "https:";
    const href = u.href;
    if (href.length > MAX_CAMO_URL || !checkImageUrl(href, env!)) return null;
    return camoPath(key, href);
  };
}

function ownOrigin(env: KeyEnv | undefined): string | null {
  try {
    return env?.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : null;
  } catch {
    return null;
  }
}

/**
 * Whether the proxy may fetch `raw`: https on a public host that isn't Diffinery's own. Local
 * development (PUBLIC_URL on loopback) also allows http and loopback, for the end-to-end tests,
 * but still not this Worker itself.
 */
export function checkImageUrl(raw: string, env: KeyEnv): URL | null {
  const dev = localOnly(env);
  try {
    const own = new URL(env.PUBLIC_URL);
    const u = checkPublicUrl(raw, dev, "image URL", dev ? undefined : own.hostname);
    if (u.host === own.host) return null;
    return u;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- fetching

/** Content types the proxy serves; anything else is refused. */
export const CAMO_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"]);
const TYPE_ALIASES: Record<string, string> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg" };
export const MAX_CAMO_BYTES = 10 * 1024 * 1024;
export const MAX_CAMO_REDIRECTS = 4;
export const CAMO_TIMEOUT_MS = 10_000;
/** How long a proxied image is cached: the origin's max-age, within these bounds; a day when it gives none. */
const MIN_TTL = 300;
const MAX_TTL = 7 * 86400;
const DEFAULT_TTL = 86400;

export interface CamoImage {
  body: Uint8Array;
  type: string;
  /** Seconds to cache it for. */
  ttl: number;
  etag: string | null;
  lastModified: string | null;
}

export interface CamoFetchDeps {
  env: KeyEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Fetch an image for the proxy, or null if it can't or mustn't be served: a host that isn't
 * public (checked again at every redirect), a status other than 200, a type that isn't an image
 * we serve, more than `maxBytes` (counted while reading, whatever Content-Length says), or no
 * answer within the timeout. Nothing of the viewer's (cookies, IP, user agent) is sent.
 */
export async function fetchCamoImage(url: string, deps: CamoFetchDeps): Promise<CamoImage | null> {
  const doFetch = deps.fetch ?? fetch;
  const maxBytes = deps.maxBytes ?? MAX_CAMO_BYTES;
  const signal = AbortSignal.timeout(deps.timeoutMs ?? CAMO_TIMEOUT_MS);
  let target = url;
  try {
    for (let hop = 0; hop <= MAX_CAMO_REDIRECTS; hop++) {
      const u = checkImageUrl(target, deps.env);
      if (!u) return null;
      const res = await doFetch(u.href, {
        method: "GET",
        headers: { accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8", "user-agent": "Diffinery-Camo/1 (image proxy)" },
        redirect: "manual",
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel();
        const loc = res.headers.get("location");
        if (!loc) return null;
        target = new URL(loc, u).href;
        continue;
      }
      if (res.status !== 200 || !res.body) {
        await res.body?.cancel();
        return null;
      }
      const raw = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const type = TYPE_ALIASES[raw] ?? raw;
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (!CAMO_TYPES.has(type) || declared > maxBytes) {
        await res.body.cancel();
        return null;
      }
      const body = await readCapped(res.body, maxBytes);
      if (!body) return null;
      return { body, type, ttl: cacheTtl(res.headers.get("cache-control")), etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
    }
    return null;
  } catch {
    return null;
  }
}

async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Seconds to cache an image, from the origin's Cache-Control. */
export function cacheTtl(cacheControl: string | null): number {
  const cc = (cacheControl ?? "").toLowerCase();
  if (/\b(no-store|no-cache|private)\b/.test(cc)) return MIN_TTL;
  const m = /\bs-maxage=(\d+)/.exec(cc) ?? /\bmax-age=(\d+)/.exec(cc);
  if (!m) return DEFAULT_TTL;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, Number(m[1])));
}

/** Headers for a proxied image: an SVG can't run scripts, and nothing is sniffed. */
export function camoHeaders(img: Pick<CamoImage, "type" | "ttl" | "etag" | "lastModified" | "body">): Headers {
  const h = new Headers({
    "content-type": img.type,
    "content-length": String(img.body.byteLength),
    "cache-control": `public, max-age=${img.ttl}`,
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "x-content-type-options": "nosniff",
    // Only Diffinery's own pages show these.
    "cross-origin-resource-policy": "same-origin",
  });
  if (img.etag) h.set("etag", img.etag);
  if (img.lastModified) h.set("last-modified", img.lastModified);
  return h;
}
