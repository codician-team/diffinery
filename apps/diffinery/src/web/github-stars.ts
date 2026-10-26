/**
 * The star count of Diffinery's GitHub mirror (GITHUB_REPO), for the "Star on GitHub" buttons on the public site.
 *
 * Fetched by the server, never by the visitor's browser, so no page loads a third-party script or tells GitHub who
 * looked at it. Pages never wait for GitHub: a request reads the isolate's copy or the colo's Cache API entry, and
 * a stale or missing count is refreshed in the background (the button shows no number until one is known).
 * GitHub's REST API allows few unauthenticated requests per IP address, and Workers share theirs, so the count
 * stays fresh for 30 minutes and shields.io's JSON badge is the fallback.
 */
import type { AppContext } from "../auth/principal.js";

/** Diffinery's mirror on GitHub (site.tsx's SOURCE.github), where people star the project. */
export const GITHUB_REPO = "https://github.com/codician-team/diffinery";

export interface Stored {
  stars: number;
  /** When it was fetched (ms since the epoch). */
  at: number;
}

/** How long a count is used before it is fetched again. */
export const FRESH_MS = 30 * 60_000;
/** After a failed refresh, how long until the next try. */
export const RETRY_MS = 10 * 60_000;
/** How long an isolate trusts its own copy before it looks at the colo's cache again. */
const LOCAL_MS = 60_000;
/** How long the colo keeps a count it couldn't refresh: an old number beats none. */
const KEEP_S = 7 * 86400;

const slug = new URL(GITHUB_REPO).pathname.slice(1);

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The count from GitHub's REST API, else from shields.io's badge (which rounds large counts, e.g. "1.2k"); null if neither answers. */
export async function fetchGitHubStars(f: Fetch = fetch): Promise<number | null> {
  const signal = () => AbortSignal.timeout(5000);
  try {
    const r = await f(`https://api.github.com/repos/${slug}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Diffinery (https://diffinery.com)", "x-github-api-version": "2022-11-28" },
      signal: signal(),
    });
    if (r.ok) {
      const n = ((await r.json()) as { stargazers_count?: unknown }).stargazers_count;
      if (typeof n === "number" && Number.isInteger(n) && n >= 0) return n;
    }
  } catch {
    // Try the badge.
  }
  try {
    const r = await f(`https://img.shields.io/github/stars/${slug}.json`, { headers: { "user-agent": "Diffinery (https://diffinery.com)" }, signal: signal() });
    if (r.ok) return parseBadgeCount(((await r.json()) as { message?: unknown }).message);
  } catch {
    // Neither answered.
  }
  return null;
}

/** "30" -> 30, "1.2k" -> 1200, "3M" -> 3000000; anything else (such as "repo not found") -> null. */
export function parseBadgeCount(message: unknown): number | null {
  const m = typeof message === "string" ? /^(\d+(?:\.\d+)?)([kM]?)$/.exec(message.trim()) : null;
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "M" ? 1e6 : 1));
}

/** A count as GitHub shows it on its Star button: 30, 999, 1k, 1.2k, 12.3k. */
export function formatStars(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${trim(n / 1e3)}k`;
  return `${trim(n / 1e6)}M`;
}
const trim = (x: number) => (x >= 100 ? String(Math.floor(x)) : (Math.floor(x * 10) / 10).toFixed(1).replace(/\.0$/, ""));

export interface Store {
  get(): Promise<Stored | null>;
  put(s: Stored): Promise<void>;
}

/** Keeps the count for a colo, under this instance's own origin, so no other site's entries are touched. */
function edgeStore(origin: string): Store | null {
  const cache = typeof caches === "undefined" ? null : (caches as unknown as { default: Cache }).default;
  if (!cache) return null;
  const key = new Request(`${origin}/-/cache/github-stars/${slug}`);
  return {
    async get() {
      const r = await cache.match(key).catch(() => undefined);
      const s = r ? ((await r.json().catch(() => null)) as Stored | null) : null;
      return s && typeof s.stars === "number" && typeof s.at === "number" ? s : null;
    },
    async put(s) {
      await cache.put(key, new Response(JSON.stringify(s), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${KEEP_S}` } })).catch(() => undefined);
    },
  };
}

/** One per isolate: the last count it saw, and the refresh it is running. */
export class StarCount {
  private local: (Stored & { seen: number }) | null = null;
  private refreshing: Promise<void> | null = null;
  /** When it last asked GitHub, so a failure with no count to keep isn't retried on every request. */
  private tried = -Infinity;

  constructor(
    private readonly fetchStars: () => Promise<number | null> = () => fetchGitHubStars(),
    private readonly clock: () => number = Date.now,
  ) {}

  /** The count to show now, or null; starts a refresh when the count is old or unknown. Never waits on GitHub. */
  async read(store: Store, background: (p: Promise<void>) => void): Promise<number | null> {
    const now = this.clock();
    if (!this.local || now - this.local.seen >= LOCAL_MS) {
      const s = await store.get();
      if (s && (!this.local || s.at >= this.local.at)) this.local = { ...s, seen: now };
      else if (this.local) this.local.seen = now;
    }
    if ((!this.local || now - this.local.at >= FRESH_MS) && !this.refreshing && now - this.tried >= RETRY_MS) {
      this.tried = now;
      const p = this.refresh(store).finally(() => (this.refreshing = null));
      this.refreshing = p;
      background(p);
    }
    return this.local?.stars ?? null;
  }

  private async refresh(store: Store): Promise<void> {
    const now = this.clock();
    const stars = await this.fetchStars().catch(() => null);
    // A failure keeps the last count and tries again in RETRY_MS, here and in every other isolate of the colo.
    const s: Stored | null = stars !== null ? { stars, at: now } : this.local ? { stars: this.local.stars, at: now - FRESH_MS + RETRY_MS } : null;
    if (!s) return;
    this.local = { ...s, seen: now };
    await store.put(s);
  }
}

const isolate = new StarCount();
const perRequest = new WeakMap<Request, Promise<number | null>>();

/**
 * The mirror's star count for this request (looked up once however many buttons the page has), or null while unknown.
 * Without the Cache API (unit tests, workers.dev) there is nowhere to keep a count, so GitHub isn't asked.
 */
export function githubStars(c: AppContext): Promise<number | null> {
  let p = perRequest.get(c.req.raw);
  if (!p) {
    const store = edgeStore(new URL(c.req.url).origin);
    if (!store) return Promise.resolve(null);
    const background = (q: Promise<void>) => {
      try {
        c.executionCtx.waitUntil(q);
      } catch {
        // No execution context (tests): the refresh finishes on its own.
      }
    };
    p = isolate.read(store, background).catch(() => null);
    perRequest.set(c.req.raw, p);
  }
  return p;
}
