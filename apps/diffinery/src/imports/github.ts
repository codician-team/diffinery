/**
 * A small GitHub REST client for imports: GET only, `Link` pagination, rate
 * limits surfaced as `RateLimited` so the workflow can sleep instead of
 * failing, and redirects followed only on the same host (no SSRF through a
 * redirect).
 */

export class RateLimited extends Error {
  constructor(
    /** Seconds to wait before trying again. */
    readonly waitSeconds: number,
  ) {
    super(`GitHub rate limit reached; continuing in ${waitSeconds} seconds`);
  }
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Page<T> {
  items: T[];
  /** The next page as a path relative to the API base, or null on the last page. */
  next: string | null;
}

/** Join byte chunks into one array of a known total length. */
function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export class GitHubClient {
  /** Never buffer more than this from a GitHub JSON response (API payloads are far smaller). */
  static readonly MAX_JSON_BYTES = 8 * 1024 * 1024;

  private readonly base: URL;

  constructor(
    apiUrl: string,
    private readonly token: string | null,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    /** Pauses before retrying a read that met a dropped connection or a 502/503/504 (one retry per entry). */
    private readonly retryDelaysMs: readonly number[] = [500, 2000],
  ) {
    this.base = new URL(apiUrl.replace(/\/+$/, "") + "/");
  }

  /** `path` is relative to the API base ("repos/o/r/issues?state=all") or an absolute URL on the same host. */
  private resolve(path: string): URL {
    const u = new URL(path.replace(/^\/+/, ""), this.base);
    if (u.origin !== this.base.origin || !u.pathname.startsWith(this.base.pathname)) throw new GitHubError(400, "GitHub returned a link to another host");
    return u;
  }

  /** The part of a same-host URL after the API base, for storing as a cursor. */
  private relative(u: URL): string {
    return u.pathname.slice(this.base.pathname.length) + u.search;
  }

  /**
   * One request. Reads are retried a couple of times when GitHub or the path to it drops the
   * connection or answers 502/503/504, which pass in seconds; a timeout is not retried.
   */
  private async fetchRetrying(url: URL, method: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const last = method !== "GET" || attempt >= this.retryDelaysMs.length;
      let res: Response;
      try {
        res = await this.fetcher(url.toString(), { ...init, signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        if (last || (e instanceof Error && e.name === "TimeoutError")) throw e;
        await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]));
        continue;
      }
      if (last || ![502, 503, 504].includes(res.status)) return res;
      await res.body?.cancel().catch(() => undefined);
      await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]));
    }
  }

  private async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    let url = this.resolve(path);
    for (let hop = 0; hop < 4; hop++) {
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "user-agent": "Diffinery-Importer",
        "x-github-api-version": "2022-11-28",
      };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      const method = init.method ?? "GET";
      let body: string | undefined;
      if (init.body !== undefined) {
        body = JSON.stringify(init.body);
        headers["content-type"] = "application/json";
      }
      const res = await this.fetchRetrying(url, method, { method, body, headers, redirect: "manual" });
      if ([301, 302, 307, 308].includes(res.status) && method === "GET") {
        const loc = res.headers.get("location");
        if (!loc) throw new GitHubError(502, "GitHub redirected without a location");
        url = this.resolve(new URL(loc, url).toString());
        continue;
      }
      // Primary limits answer 403 with remaining 0; secondary limits answer 403 or 429 with retry-after.
      if (res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")))) {
        const retry = Number(res.headers.get("retry-after"));
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const wait = retry > 0 ? retry : reset > 0 ? reset - Math.floor(Date.now() / 1000) + 5 : 60;
        throw new RateLimited(Math.min(Math.max(wait, 5), 3600));
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let message = text.slice(0, 200);
        try {
          message = (JSON.parse(text) as { message?: string }).message ?? message;
        } catch {
          // not JSON
        }
        // Secondary (abuse) rate limits come back as 403/422 with a distinctive message; treat them
        // as a rate limit to wait on, not a fatal error.
        if (/secondary rate limit|abuse detection|you have exceeded a secondary/i.test(message)) {
          const retry = Number(res.headers.get("retry-after"));
          throw new RateLimited(Math.min(Math.max(retry > 0 ? retry : 60, 5), 3600));
        }
        throw new GitHubError(res.status, `GitHub ${res.status} for ${url.pathname}: ${message}`);
      }
      return res;
    }
    throw new GitHubError(508, "too many redirects");
  }

  /**
   * Read and parse a JSON body, never buffering more than `MAX_JSON_BYTES`.
   * API responses are small, but a bounded read keeps a hostile or broken
   * server from exhausting memory in a Worker or Durable Object.
   */
  private async readJson<T>(res: Response): Promise<T> {
    const max = GitHubClient.MAX_JSON_BYTES;
    const declared = Number(res.headers.get("content-length"));
    if (declared > max) throw new GitHubError(502, `GitHub response is too large (${declared} bytes)`);
    const body = res.body;
    if (!body) return JSON.parse(await res.text()) as T;
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new GitHubError(502, "GitHub response exceeded the size limit");
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder().decode(concat(chunks, total))) as T;
  }

  async get<T>(path: string): Promise<T> {
    return this.readJson<T>(await this.request(path));
  }

  /** One page of a list endpoint. */
  async page<T>(path: string): Promise<Page<T>> {
    const res = await this.request(path);
    const items = await this.readJson<T[] | { repositories?: T[]; variables?: T[]; secrets?: T[]; environments?: T[]; branch_policies?: T[] }>(res);
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
    const list = Array.isArray(items) ? items : (items.repositories ?? items.variables ?? items.secrets ?? items.environments ?? items.branch_policies ?? []);
    return { items: list, next: next ? this.relative(this.resolve(next)) : null };
  }

  /** Every item of a list endpoint (for short lists: labels, milestones, variables). */
  async all<T>(path: string, max = 5000): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path;
    while (next && out.length < max) {
      const p: Page<T> = await this.page<T>(next);
      out.push(...p.items);
      next = p.next;
    }
    return out;
  }
}

/** `path?query` with `per_page=100` added. */
export const listPath = (path: string, query: Record<string, string> = {}) => `${path}?${new URLSearchParams({ per_page: "100", ...query })}`;
