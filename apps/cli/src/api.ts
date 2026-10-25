import { CliError } from "./io.js";
import { VERSION } from "./version.js";

export class ApiError extends CliError {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Return the response text instead of parsing JSON. */
  text?: boolean;
  /** Treat these statuses as success (e.g. 404 when probing existence). */
  allow?: number[];
  headers?: Record<string, string>;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

/** Thin client for the Diffinery REST API (`/api/v3`, GitHub-shaped). */
export class Api {
  constructor(
    readonly baseUrl: string,
    readonly token: string | null,
  ) {}

  url(path: string, query?: RequestOptions["query"]): string {
    const p = /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path.startsWith("/api/") || path.startsWith("/-/") || path === "/mcp" ? "" : "/api/v3"}${path.startsWith("/") ? path : `/${path}`}`;
    const u = new URL(p);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    return u.toString();
  }

  async raw<T = unknown>(method: string, path: string, o: RequestOptions = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": `diffinery-cli/${VERSION}`, ...o.headers };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (o.body !== undefined) {
      body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
      headers["content-type"] ??= "application/json";
    }
    let res: Response;
    const url = this.url(path, o.query);
    try {
      res = await fetch(url, { method, headers, body });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new CliError(`could not reach ${new URL(url).origin}: ${cause?.code ?? cause?.message ?? (e as Error).message}`);
    }
    const text = await res.text();
    let data: unknown = text;
    if (!o.text && text && (res.headers.get("content-type") ?? "").includes("json")) {
      try {
        data = JSON.parse(text);
      } catch {
        /* leave as text */
      }
    } else if (!o.text && !text) data = null;
    if (!res.ok && !o.allow?.includes(res.status)) {
      const msg = data && typeof data === "object" && "message" in data ? String((data as { message: unknown }).message) : text.slice(0, 300) || res.statusText;
      let hint = "";
      if (res.status === 401) hint = this.token ? " (token invalid or expired; run `diffinery login`)" : " (not logged in; run `diffinery login`)";
      else if (res.status === 403 && /needs the (write|admin) scope/.test(msg)) hint = ` (run \`diffinery login --scope ${/admin/.test(msg) ? "admin" : "write"}\` to sign in with it)`;
      throw new ApiError(res.status, `${method} ${new URL(url).pathname}: ${res.status} ${msg}${hint}`, data);
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }

  async get<T = unknown>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return (await this.raw<T>("GET", path, { query })).data;
  }
  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return (await this.raw<T>("POST", path, { body: body ?? {} })).data;
  }
  async put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return (await this.raw<T>("PUT", path, { body: body ?? {} })).data;
  }
  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return (await this.raw<T>("PATCH", path, { body })).data;
  }
  async delete<T = unknown>(path: string): Promise<T> {
    return (await this.raw<T>("DELETE", path)).data;
  }
}

export const enc = encodeURIComponent;
