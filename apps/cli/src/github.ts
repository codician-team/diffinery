import { CliError } from "./io.js";
import { VERSION } from "./version.js";

export class GitHubError extends CliError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubOptions {
  baseUrl?: string;
  token?: string | null;
  sleep: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Longest single wait for a rate-limit reset before giving up (default 1h). */
  maxWaitMs?: number;
  now?: () => number;
}

/** Next-page URL from a GitHub `Link` header. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

/** Minimal GitHub REST client with pagination and rate-limit handling. */
export class GitHub {
  readonly baseUrl: string;
  constructor(private o: GitHubOptions) {
    this.baseUrl = (o.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  }

  private async fetchRetrying(url: string): Promise<Response> {
    const now = this.o.now ?? Date.now;
    const maxWait = this.o.maxWaitMs ?? 3600_000;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": `diffinery-cli/${VERSION}` };
      if (this.o.token) headers.authorization = `Bearer ${this.o.token}`;
      let res: Response;
      try {
        res = await fetch(url, { headers });
      } catch (e) {
        if (attempt < 3) {
          await this.o.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new CliError(`could not reach GitHub (${new URL(url).host}): ${(e as Error).message}`);
      }
      if ((res.status === 403 || res.status === 429) && attempt < 8) {
        const retryAfter = res.headers.get("retry-after");
        const remaining = res.headers.get("x-ratelimit-remaining");
        const reset = res.headers.get("x-ratelimit-reset");
        let wait: number | null = null;
        if (retryAfter && Number.isFinite(Number(retryAfter))) wait = Number(retryAfter) * 1000;
        else if (remaining === "0" && reset && Number.isFinite(Number(reset))) wait = Math.max(0, Number(reset) * 1000 - now()) + 1000;
        else if (res.status === 429) wait = 60_000;
        else {
          const text = await res.clone().text();
          if (/secondary rate limit|abuse/i.test(text)) wait = 60_000;
        }
        if (wait !== null) {
          if (wait > maxWait) throw new GitHubError(res.status, `GitHub rate limit: reset is ${Math.ceil(wait / 60000)} minutes away; try again later${this.o.token ? "" : " or set GH_TOKEN"}`);
          this.o.log?.(`GitHub rate limit reached; waiting ${Math.ceil(wait / 1000)}s…`);
          await res.body?.cancel();
          await this.o.sleep(wait);
          continue;
        }
      }
      if (res.status >= 500 && attempt < 3) {
        await res.body?.cancel();
        await this.o.sleep(1000 * 2 ** attempt);
        continue;
      }
      return res;
    }
  }

  private url(path: string, query?: Record<string, string | number>): string {
    const u = new URL(/^https?:\/\//.test(path) ? path : `${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private async check(res: Response, url: string): Promise<void> {
    if (res.ok) return;
    let msg = res.statusText;
    try {
      const b = (await res.json()) as { message?: string };
      if (b.message) msg = b.message;
    } catch {
      /* not JSON */
    }
    throw new GitHubError(res.status, `GitHub ${new URL(url).pathname}: ${res.status} ${msg}`);
  }

  async get<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    const url = this.url(path, query);
    const res = await this.fetchRetrying(url);
    await this.check(res, url);
    return (await res.json()) as T;
  }

  /**
   * All pages of a list endpoint. `key` picks the array out of wrapped responses
   * such as `{ total_count, variables: [...] }`.
   */
  async paginate<T>(path: string, query: Record<string, string | number> = {}, key?: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = this.url(path, { per_page: 100, ...query });
    while (url) {
      const res = await this.fetchRetrying(url);
      await this.check(res, url);
      const body = (await res.json()) as unknown;
      const items = key ? ((body as Record<string, unknown>)[key] as T[] | undefined) : (body as T[]);
      if (Array.isArray(items)) out.push(...items);
      url = nextLink(res.headers.get("link"));
    }
    return out;
  }
}
