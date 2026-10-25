import { nextLink, type RepoJson, type RepoRef } from "./util";

/** An HTTP error from the Diffinery API, with the server's own message when it sent one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface UserJson {
  login: string;
  id: number;
  type: "User" | "Bot" | "Organization";
  name?: string | null;
}

export interface OrgJson {
  login: string;
  role?: string;
}

const UA = "Diffinery-VSCode";

/** The REST API (GitHub-compatible, at /api/v3) with one token. */
export class Api {
  constructor(
    readonly server: string,
    private readonly token: string,
    private readonly version: string,
  ) {}

  private async request(method: string, url: string, body?: unknown): Promise<Response> {
    const res = await fetch(url.startsWith("http") ? url : `${this.server}/api/v3${url}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        "user-agent": `${UA}/${this.version}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = (await res.json()) as { message?: string; error?: string };
        msg = j.message || j.error || msg;
      } catch {
        // not JSON
      }
      throw new ApiError(res.status, res.status === 401 ? `Diffinery didn't accept your sign-in (${msg}). Sign in again.` : msg);
    }
    return res;
  }

  async get<T>(path: string): Promise<T> {
    return (await (await this.request("GET", path)).json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await (await this.request("POST", path, body)).json()) as T;
  }

  /** Every page of a list, following Link headers, up to `max` items. */
  async all<T>(path: string, max = 500): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = path;
    while (url && out.length < max) {
      const res: Response = await this.request("GET", url);
      out.push(...((await res.json()) as T[]));
      url = nextLink(res.headers.get("link"));
    }
    return out.slice(0, max);
  }

  user = () => this.get<UserJson>("/user");
  orgs = () => this.get<OrgJson[]>("/user/orgs");
  /** The repositories the account can read: its own, its organizations', and ones shared with it, most recently pushed first. */
  myRepos = () => this.all<RepoJson>("/user/repos?per_page=100");
  repo = (r: RepoRef) => this.get<RepoJson>(`/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`);
  async search(query: string): Promise<RepoJson[]> {
    const q = new URLSearchParams({ q: query, per_page: "30", sort: "updated" });
    return (await this.get<{ items: RepoJson[] }>(`/search/repositories?${q}`)).items;
  }
  async branches(r: RepoRef): Promise<string[]> {
    const list = await this.all<{ name: string }>(`/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/branches?per_page=100`, 1000);
    return list.map((b) => b.name);
  }
  createRepo(owner: string | null, body: { name: string; private: boolean; description?: string }) {
    return this.post<RepoJson>(owner ? `/orgs/${encodeURIComponent(owner)}/repos` : "/user/repos", body);
  }
}
