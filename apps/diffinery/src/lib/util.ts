export const now = (): string => new Date().toISOString();

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function randomToken(bytes = 24): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return b64url(b);
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** `length` random letters and digits (no `_` or `-`), drawn without bias. */
export function randomAlnum(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const v of crypto.getRandomValues(new Uint8Array(length))) {
      // 248 = 4 × 62: values above it would favour the first characters.
      if (v < 248 && out.length < length) out += ALNUM[v % 62];
    }
  }
  return out;
}

export function b64url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, body: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const sig = await crypto.subtle.sign("HMAC", key, data as BufferSource);
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** GitHub's limits on issue, pull request and comment text. */
export const MAX_TITLE = 256;
export const MAX_BODY = 65_536;

/** Refuses a title or body over GitHub's limits, with GitHub's error. */
export function checkText(resource: string, text: { title?: unknown; body?: unknown }): void {
  for (const [field, max] of [["title", MAX_TITLE], ["body", MAX_BODY]] as const) {
    const v = text[field];
    if (typeof v === "string" && v.length > max) throw new HttpError(422, `${field} is too long (maximum is ${max} characters)`, { errors: [{ resource, code: "custom", field }] });
  }
}

export class HttpError extends Error {
  /** The message without the status prefix. */
  readonly detail: string;
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    // The status is part of the message so it survives Durable Object RPC boundaries.
    super(`${status}: ${message}`);
    this.detail = message;
  }
}

/**
 * The address commits made in Diffinery (web edits, merges, the merge queue, sandboxes) carry for
 * an account: <login>@users.noreply.<host of PUBLIC_URL>, like GitHub's users.noreply.github.com.
 * On diffinery.com that is <login>@users.noreply.diffinery.com; a self-hosted instance uses its own host.
 */
export function noreplyEmail(publicUrl: string, login: string): string {
  return `${login}@users.noreply.${noreplyHost(publicUrl)}`;
}

/** The instance's own host for noreply addresses: PUBLIC_URL's host name, without a port. */
export function noreplyHost(publicUrl: string): string {
  try {
    return new URL(publicUrl).hostname || "localhost";
  } catch {
    return "localhost";
  }
}

/** Top-level paths the app serves; no account may use them as its login. */
export const RESERVED_LOGINS = new Set(["api", "mcp", "runner", "settings", "new", "notifications", "invite", "request-access", "healthz", "twirp", "install", "install.sh", "install.ps1", "install-editor", "install-editor.sh", "install-editor.ps1", "cli", "oauth", "login", "logout", "admin", "explore", "favicon.ico", "robots.txt", "about", "features", "agents", "performance", "compare", "pricing", "blog", "changelog", "customers", "docs", "static", "assets", "www", "git", "diffinery", "auth", "signin", "signup", "early-access", "security", "status", "faq", "built-on-cloudflare", "open-source", "v2", "imports", "apps", "-", "diffinery-agent-review", "ghost", "github-actions", "diffinery-actions", "noreply", "no-reply", "support", "abuse", "postmaster", "root", "staff"]);

/**
 * Who a deleted account's issues, pull requests and comments are attributed to, as on GitHub. Not an account:
 * pages show the login, and its profile page says what it means (accounts/lifecycle.ts).
 */
export const GHOST = { id: "ghost", login: "ghost", kind: "user" } as const;

export const isValidLogin = (s: string): boolean => isValidName(s) && !s.includes(".") && !RESERVED_LOGINS.has(s.toLowerCase());

export const isValidName = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(s) && !s.endsWith(".git") && s !== "." && s !== "..";

export function isValidRefName(ref: string): boolean {
  if (!ref.startsWith("refs/")) return false;
  if (/(^|\/)\.|\.\.|[\x00-\x20~^:?*[\\\x7f]|@\{|\/\/|\/$|\.lock(\/|$)|\.$/.test(ref)) return false;
  return true;
}
