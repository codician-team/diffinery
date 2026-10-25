import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppVars } from "../auth/principal.js";
import { camoHeaders, camoKeys, fetchCamoImage, verifyCamo } from "../lib/camo.js";

/**
 * GET /-/camo/<signature>/<url, base64url>: an image from another site, fetched by Diffinery so the
 * viewer's browser never contacts that site (lib/camo.ts). Unsigned, tampered or unfetchable URLs
 * get a quick 404. Answers are kept in Cloudflare's cache, so repeated views don't fetch again;
 * failures are kept briefly too, so a dead image doesn't wait on its host for every viewer.
 */
export const camo = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** Seconds a failed fetch is remembered. */
const FAILURE_TTL = 120;

const notFound = (cacheable: boolean) =>
  new Response("image not available", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": cacheable ? `public, max-age=${FAILURE_TTL}` : "no-store",
      "cross-origin-resource-policy": "same-origin",
    },
  });

camo.get("/-/camo/:sig/:url", async (c) => {
  const url = verifyCamo(camoKeys(c.env), c.req.param("sig"), c.req.param("url"));
  if (!url) return notFound(false);

  const cache = typeof caches === "undefined" ? null : (caches as unknown as { default: Cache }).default;
  // Keyed by our own URL (no query, no headers), so the viewer's cookies never reach the cache key.
  const cacheKey = new Request(new URL(c.req.path, c.req.url).href, { method: "GET" });
  const hit = await cache?.match(cacheKey).catch(() => undefined);
  if (hit) return new Response(hit.body, hit);

  const img = await fetchCamoImage(url, { env: c.env });
  const res = img ? new Response(img.body, { status: 200, headers: camoHeaders(img) }) : notFound(true);
  if (cache) {
    const put = cache.put(cacheKey, res.clone()).catch((e) => console.error("camo cache put failed", e));
    try {
      c.executionCtx.waitUntil(put);
    } catch {
      await put;
    }
  }
  return res;
});
