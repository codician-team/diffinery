// Pure helpers, without the vscode module, so the unit tests can run them under Node.
import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";

export const EXTENSION_ID = "codician.diffinery";
/** Editors whose URL scheme the Diffinery server accepts as a redirect back to this extension (src/auth/oauth.ts there). */
export const EDITOR_SCHEMES = ["vscode", "vscode-insiders", "cursor", "windsurf", "vscodium", "positron", "kiro"];
export const DEFAULT_SERVER = "https://diffinery.com";

function checkServer(s: string): { server: string } | { invalid: "url" | "https" } {
  let u: URL;
  try {
    u = new URL(s.includes("://") ? s : `https://${s}`);
  } catch {
    return { invalid: "url" };
  }
  const loopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return { invalid: "https" };
  return { server: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}` };
}

/** The server's base URL from the setting: https (or http on this computer), no trailing slash, no path. */
export function normalizeServer(raw: string | undefined): string {
  const s = (raw ?? "").trim() || DEFAULT_SERVER;
  const r = checkServer(s);
  if ("server" in r) return r.server;
  throw new Error(r.invalid === "url" ? `The Diffinery server URL "${s}" isn't a valid URL. Fix diffinery.serverUrl in your settings.` : `The Diffinery server URL must use https (diffinery.serverUrl is ${s}).`);
}

/** Why what someone typed as a server address can't be used, for the input box; null when it can. */
export function serverInputError(raw: string): string | null {
  const s = raw.trim();
  if (!s) return "Enter your Diffinery's address, such as git.example.com.";
  if (/\s/.test(s)) return "An address has no spaces.";
  const r = checkServer(s);
  return "server" in r ? null : r.invalid === "url" ? `"${s}" isn't a valid address.` : "The address must use https (http only for a server on this computer).";
}

/** A server as people read it: diffinery.com, git.example.com:8443. */
export function serverLabel(server: string): string {
  const u = new URL(server);
  return `${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * Where the editor installer (install/install.sh, install.ps1) leaves the address of the self-hosted Diffinery that
 * served it, for the extension to offer on its next start: the CLI's config folder (~/.config/diffinery, or under
 * XDG_CONFIG_HOME), on every system.
 */
export function installHintPath(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(env.HOME || home, ".config");
  return path.join(base, "diffinery", "editor-server");
}

/** The server named in the installer's hint file, or null when the file holds anything else. */
export function readInstallHint(text: string): string | null {
  const line = text.split(/\r?\n/, 1)[0]!.trim();
  if (!line || line.length > 2000 || serverInputError(line)) return null;
  return normalizeServer(line);
}

/** The OAuth client_id of this extension on a server: the URL of the metadata document the server publishes about it. */
export const clientId = (server: string) => `${server}/oauth/clients/editor.json`;

/** Where the server sends the browser back after approval: the editor's own scheme when the server knows it, else null (use loopback). */
export function editorRedirect(scheme: string): string | null {
  return EDITOR_SCHEMES.includes(scheme) ? `${scheme}://${EXTENSION_ID}/oauth` : null;
}

export const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");

export function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()), state: b64url(randomBytes(16)) };
}

export function authorizeUrl(server: string, redirectUri: string, challenge: string, state: string): string {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId(server), redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state, scope: "write" });
  return `${server}/oauth/authorize?${q}`;
}

/**
 * What a callback from the server carries: the code, or why there isn't one. Checks the state (it must be the one this
 * sign-in sent) and, when present, the issuer (RFC 9207), so a code from another server or another attempt is refused.
 */
export function readCallback(query: string, expect: { state: string; server: string }): { code: string } | { error: string } {
  const q = new URLSearchParams(query);
  if (q.get("state") !== expect.state) return { error: "The sign-in response didn't match this sign-in. Try again." };
  const iss = q.get("iss");
  if (iss && iss.replace(/\/+$/, "") !== expect.server) return { error: `The sign-in response came from ${iss}, not ${expect.server}.` };
  const err = q.get("error");
  if (err) return { error: err === "access_denied" ? "Sign-in was cancelled in the browser." : `Diffinery refused the sign-in: ${q.get("error_description") || err}` };
  const code = q.get("code");
  return code ? { code } : { error: "The sign-in response had no code. Try again." };
}

export interface RepoRef {
  owner: string;
  repo: string;
}

const NAME = /^[A-Za-z0-9._-]+$/;

/** owner/repo from "owner/repo", or from a web or clone URL on this server. Null for anything else. */
export function repoRef(server: string, input: string): RepoRef | null {
  const s = input.trim();
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    const base = new URL(server);
    if (u.host.toLowerCase() !== base.host.toLowerCase()) return null;
    path = u.pathname.slice(base.pathname.replace(/\/+$/, "").length);
  } else {
    path = s;
  }
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, "");
  if (!NAME.test(owner) || !NAME.test(repo) || repo === "." || repo === "..") return null;
  // A web URL deeper in the repository (/owner/repo/tree/main/src) still names the repository; a bare "a/b/c" doesn't.
  if (parts.length > 2 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
  return { owner, repo };
}

export interface RepoJson {
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  private: boolean;
  visibility?: string;
  archived?: boolean;
  fork?: boolean;
  clone_url: string;
  html_url: string;
  default_branch?: string;
  pushed_at?: string | null;
  updated_at?: string | null;
}

/** Repositories that match what someone typed: every word in the full name or description, ignoring case. */
export function matches(r: RepoJson, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${r.full_name} ${r.description ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Merges lists of repositories, first occurrence wins, in order. */
export function dedupe(...lists: RepoJson[][]): RepoJson[] {
  const seen = new Set<string>();
  const out: RepoJson[] = [];
  for (const list of lists)
    for (const r of list) {
      const k = r.full_name.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(r);
      }
    }
  return out;
}

/** The next page from a Link header (RFC 8288), as GitHub-style APIs send it. */
export function nextLink(link: string | null | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

/** -1, 0 or 1, comparing dotted version numbers (a pre-release suffix sorts before the release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core!.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The lines `git credential approve|reject` reads for a token on the server's host. */
export function credentialInput(server: string, username: string, password: string, expiresAt?: number): string {
  const u = new URL(server);
  const lines = [`protocol=${u.protocol.replace(/:$/, "")}`, `host=${u.host}`, `username=${username}`, `password=${password}`];
  // Git 2.41+ passes this on, and helpers that keep it (Git Credential Manager, osxkeychain, libsecret, cache) stop
  // handing out the token once it has expired, so Git asks the editor for a fresh one instead of failing.
  if (expiresAt) lines.push(`password_expiry_utc=${Math.floor(expiresAt / 1000)}`);
  if (/[\n\0]/.test(lines.join(""))) throw new Error("credential contains a newline");
  return `${lines.join("\n")}\n\n`;
}

/** A repository name Diffinery accepts, from a folder name: unsupported characters become "-". */
export function repoNameFrom(folder: string): string {
  const n = folder
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
  return n || "repository";
}
