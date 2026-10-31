import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { RATE_PERIOD_S } from "./lib/rate-limit.js";

/**
 * Request rate limits for deployments without Cloudflare's rate limiting bindings, such as celld
 * (RATE_LIMITS=durable, lib/rate-limit.ts). Each object counts the keys of one shard in fixed
 * windows of RATE_PERIOD_S, in memory only: nothing is written to storage, so counting costs no
 * write per request, and an object that is evicted or moved starts its window again. Like the
 * bindings, the limits stop floods and scripted abuse rather than meter use exactly.
 */
export class RateLimiterDO extends DurableObject<Env> {
  private window = 0;
  /** `<bucket>\n<key>` → requests in the current window. Cleared when the window rolls over, so it holds one window's keys. */
  private counts = new Map<string, number>();

  /**
   * Counts one request for `key` against each bucket in turn ([name, limit per window]), and
   * returns the first bucket over its limit, or null. Buckets after that one aren't counted, as
   * with the bindings.
   */
  hit(key: string, limits: Array<[bucket: string, limit: number]>): string | null {
    const w = Math.floor(Date.now() / 1000 / RATE_PERIOD_S);
    if (w !== this.window) {
      this.window = w;
      this.counts.clear();
    }
    for (const [bucket, limit] of limits) {
      const k = `${bucket}\n${key}`;
      const n = (this.counts.get(k) ?? 0) + 1;
      this.counts.set(k, n);
      if (n > limit) return bucket;
    }
    return null;
  }
}
