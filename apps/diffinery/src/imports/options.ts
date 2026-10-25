import { HttpError, isValidName } from "../lib/util.js";

/**
 * Input of a GitHub import, validated and normalised. Kept free of platform
 * imports so it can be unit tested.
 */

export type ImportVisibility = "keep" | "private" | "public";

export interface ImportOptions {
  /** Issues and pull requests (with comments and reviews). */
  issues: boolean;
  releases: boolean;
  /** Labels and milestones. */
  labels: boolean;
  /** Branch protection rules. */
  protection: boolean;
  /** Actions variables and secret names. */
  variables: boolean;
  /** Git LFS objects. */
  lfs: boolean;
  /**
   * Push protection findings in old history: "bypass" imports them with an audited
   * admin bypass (the history is already on GitHub); "stop" fails the import.
   */
  secrets: "bypass" | "stop";
}

export const DEFAULT_OPTIONS: ImportOptions = { issues: true, releases: true, labels: true, protection: true, variables: true, lfs: true, secrets: "bypass" };

export interface ImportRequest {
  mode: "repo" | "bulk";
  /** "owner/name" for one repository, the GitHub organization or user for a bulk import. */
  source: string;
  /** Bulk: repository names to import (null: all of them). */
  repositories: string[] | null;
  excludeForks: boolean;
  excludeArchived: boolean;
  /** Diffinery user or organization that will own the repositories. */
  owner: string;
  /** Repository imports: the Diffinery repository name (default: the GitHub name). */
  name: string | null;
  visibility: ImportVisibility;
  options: ImportOptions;
  /** GitHub REST API base, e.g. https://api.github.com or https://ghe.example.com/api/v3 */
  apiUrl: string;
  token: string | null;
  /** Bulk: repositories imported at the same time. */
  concurrency: number;
}

export const MAX_BULK_REPOS = 1000;
const GH_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/;

const bad = (msg: string): never => {
  throw new HttpError(422, msg);
};

/**
 * Hosts a server-side fetch may reach: HTTPS on a public name. Loopback and
 * plain HTTP are allowed only in local development (`dev`), for test doubles.
 */
export function checkPublicUrl(raw: string, dev: boolean, what = "URL", ownHost?: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return bad(`${what} is not a valid URL`);
  }
  if (u.username || u.password) bad(`${what} must not contain credentials`);
  if (dev && (u.protocol === "http:" || u.protocol === "https:")) return u;
  if (u.protocol !== "https:") bad(`${what} must use https`);
  // A fully qualified name's trailing dot (`localhost.`) names the same host.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  const singleLabel = !host.includes(".") && !host.includes(":");
  if (singleLabel || host === "localhost" || /\.(localhost|local|internal)$/.test(host) || isPrivateAddress(host)) bad(`${what} must be a public host`);
  if (ownHost && (host === ownHost.toLowerCase() || host.endsWith(`.${ownHost.toLowerCase()}`))) bad(`${what} can't point at Diffinery itself`);
  return u;
}

/** IP literals in loopback, private, link-local, CGNAT or unspecified ranges. */
export function isPrivateAddress(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (host.includes(":")) {
    const h = host.toLowerCase();
    if (h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
    // NAT64 well-known prefix (64:ff9b::/96 and 64:ff9b:1::/48) can reach private IPv4 space.
    if (h.startsWith("64:ff9b:") || h.startsWith("64:ff9b::")) return true;
    // IPv4-mapped (::ffff:a.b.c.d / ::ffff:7f00:1) or -compatible (::7f00:1, ::a.b.c.d): re-check the embedded IPv4.
    const embedded = embeddedV4(h);
    if (embedded) return isPrivateAddress(embedded);
    return false;
  }
  return false;
}

/** The IPv4 address embedded in an IPv4-mapped or -compatible IPv6 literal, or null. */
function embeddedV4(h: string): string | null {
  const dotted = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(h);
  if (dotted) return dotted[1]!;
  const m = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (m) {
    const hi = parseInt(m[1]!, 16);
    const lo = parseInt(m[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** The REST API base for a GitHub host: github.com → api.github.com, Enterprise → https://host/api/v3. */
export function normalizeApiUrl(raw: string | undefined | null, dev: boolean, ownHost?: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "https://api.github.com";
  const u = checkPublicUrl(s, dev, "github_api_url", ownHost);
  // The import container clones from this host on its own network, so only the standard HTTPS port: other
  // ports would let an import probe services next to whatever address the name resolves to.
  if (!dev && u.port && u.port !== "443") bad("github_api_url must use the standard HTTPS port (443)");
  const host = u.host.toLowerCase();
  if (host === "github.com" || host === "www.github.com" || host === "api.github.com") return "https://api.github.com";
  let p = u.pathname.replace(/\/+$/, "");
  if (!p && !dev) p = "/api/v3";
  return `${u.protocol}//${u.host}${p}`;
}

/** The web host that goes with an API base (for clone URLs and links). */
export function webHostOf(apiUrl: string): string {
  const u = new URL(apiUrl);
  return u.host === "api.github.com" ? "github.com" : u.host;
}

/**
 * A repository reference: "owner/name", a github.com or Enterprise URL, or an
 * SSH remote. Returns the API base implied by a URL's host, if any.
 */
export function parseRepoSource(raw: string): { owner: string; name: string; host: string | null } {
  let s = raw.trim();
  let host: string | null = null;
  const ssh = /^git@([^:]+):(.+)$/.exec(s);
  if (ssh) {
    host = ssh[1]!;
    s = ssh[2]!;
  } else if (/^https?:\/\//i.test(s) || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(s)) {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    host = u.host.toLowerCase();
    s = u.pathname;
  }
  const parts = s.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) bad(`expected a GitHub repository like owner/name, got "${raw}"`);
  const [owner, name] = parts as [string, string];
  if (!GH_LOGIN.test(owner) || !GH_REPO.test(name)) bad(`"${raw}" is not a valid GitHub repository`);
  return { owner, name, host: host === "github.com" || host === "www.github.com" ? null : host };
}

function bool(v: unknown, dflt: boolean, key: string): boolean {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "boolean") bad(`${key} must be true or false`);
  return v as boolean;
}

export function parseOptions(raw: unknown): ImportOptions {
  if (raw === undefined || raw === null) return { ...DEFAULT_OPTIONS };
  if (typeof raw !== "object" || Array.isArray(raw)) return bad("options must be an object");
  const o = raw as Record<string, unknown>;
  const known = new Set(["issues", "releases", "labels", "branch_protection", "variables", "lfs", "secrets"]);
  for (const k of Object.keys(o)) if (!known.has(k)) bad(`unknown option "${k}"`);
  const secrets = o.secrets ?? DEFAULT_OPTIONS.secrets;
  if (secrets !== "bypass" && secrets !== "stop") bad('options.secrets must be "bypass" or "stop"');
  return {
    issues: bool(o.issues, DEFAULT_OPTIONS.issues, "options.issues"),
    releases: bool(o.releases, DEFAULT_OPTIONS.releases, "options.releases"),
    labels: bool(o.labels, DEFAULT_OPTIONS.labels, "options.labels"),
    protection: bool(o.branch_protection, DEFAULT_OPTIONS.protection, "options.branch_protection"),
    variables: bool(o.variables, DEFAULT_OPTIONS.variables, "options.variables"),
    lfs: bool(o.lfs, DEFAULT_OPTIONS.lfs, "options.lfs"),
    secrets: secrets as ImportOptions["secrets"],
  };
}

/**
 * Validate a REST request body (`POST /api/v3/diffinery/imports`):
 *
 *   one repository:  { source: "octo/app", owner, name?, visibility?, options?, github_token?, github_api_url? }
 *   many:            { source_owner: "octo", repositories?: [...], exclude_forks?, exclude_archived?, concurrency?, owner, … }
 */
export function parseImportRequest(body: unknown, o: { dev: boolean; ownHost?: string }): ImportRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("request body must be a JSON object");
  const b = body as Record<string, unknown>;
  const str = (k: string): string | null => {
    const v = b[k];
    if (v === undefined || v === null || v === "") return null;
    if (typeof v !== "string") return bad(`${k} must be a string`);
    return v.trim();
  };
  const single = str("source");
  const bulkOwner = str("source_owner");
  if (!!single === !!bulkOwner) bad("give either source (one repository) or source_owner (an organization or user)");
  const owner = str("owner");
  if (!owner) bad("owner (the Diffinery user or organization to import into) is required");
  // GitHub "internal" repositories import as private (Diffinery has only public and private).
  const rawVisibility = str("visibility") ?? "keep";
  const visibility = (rawVisibility === "internal" ? "private" : rawVisibility) as ImportVisibility;
  if (!["keep", "private", "public"].includes(visibility)) bad("visibility must be keep, private or public");
  const token = str("github_token");
  if (token && (token.length > 400 || /\s/.test(token))) bad("github_token is not a valid token");
  let apiUrl = str("github_api_url");
  let source: string;
  let name: string | null = null;
  let repositories: string[] | null = null;
  if (single) {
    const parsed = parseRepoSource(single);
    // M3: never send a token to a host taken from the (attacker-influenceable) source URL. When the
    // source names an Enterprise host and a token is supplied, the caller must give an explicit,
    // matching github_api_url; without a token the source host may imply the API base.
    if (parsed.host) {
      if (token) {
        if (!apiUrl) bad("github_api_url is required when a github_token is given and the source names a GitHub Enterprise host");
        if (new URL(normalizeApiUrl(apiUrl, o.dev, o.ownHost)).host.toLowerCase() !== parsed.host.toLowerCase()) bad("github_api_url must be on the same host as the source repository");
      } else if (!apiUrl) {
        apiUrl = `https://${parsed.host}/api/v3`;
      }
    }
    source = `${parsed.owner}/${parsed.name}`;
    name = str("name") ?? parsed.name;
    if (!isValidName(name)) bad(`"${name}" is not a valid repository name: use letters, numbers, '.', '-' and '_'`);
    if (b.repositories !== undefined) bad("repositories applies only to source_owner imports");
  } else {
    if (!GH_LOGIN.test(bulkOwner!)) bad(`"${bulkOwner}" is not a valid GitHub organization or user`);
    source = bulkOwner!;
    if (b.name !== undefined) bad("name applies only to single repository imports");
    if (b.repositories !== undefined && b.repositories !== null) {
      if (!Array.isArray(b.repositories) || b.repositories.some((r) => typeof r !== "string" || !GH_REPO.test(r))) bad("repositories must be a list of repository names");
      repositories = [...new Set(b.repositories as string[])];
      if (!repositories.length) bad("repositories is empty; omit it to import every repository");
      if (repositories.length > MAX_BULK_REPOS) bad(`at most ${MAX_BULK_REPOS} repositories per import`);
    }
  }
  const concurrency = b.concurrency === undefined || b.concurrency === null ? 3 : Number(b.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) bad("concurrency must be between 1 and 8");
  return {
    mode: single ? "repo" : "bulk",
    source,
    repositories,
    excludeForks: bool(b.exclude_forks, false, "exclude_forks"),
    excludeArchived: bool(b.exclude_archived, false, "exclude_archived"),
    owner: owner!,
    name,
    visibility,
    options: parseOptions(b.options),
    apiUrl: normalizeApiUrl(apiUrl, o.dev, o.ownHost),
    token,
    concurrency,
  };
}

/**
 * A safe asset filename: the final path segment with path-dangerous characters
 * removed. Rejects "", ".", "..", any ".git" variant, and anything with a
 * backslash or NUL, so nothing server-side ever writes a traversing name.
 */
export function safeAssetName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.includes("\0")) return null;
  const base = raw.split(/[\\/]/).pop() ?? "";
  // Reject dangerous names on the raw final segment, before cleaning strips the leading dot off ".git".
  if ([".", "..", ".git", ".git.", "git~1"].includes(base.toLowerCase())) return null;
  const cleaned = base.replace(/[^A-Za-z0-9._+@~-]+/g, ".").replace(/^\.+|\.+$/g, "");
  if (!cleaned) return null;
  if ([".", "..", ".git"].includes(cleaned.toLowerCase())) return null;
  return cleaned.slice(0, 255);
}

/** Diffinery visibility for a GitHub repository: only public or private (GitHub "internal" becomes private). */
export function visibilityFor(v: ImportVisibility, gh: { private?: boolean; visibility?: string }): "private" | "public" {
  if (v === "public") return "public";
  if (v === "private") return "private";
  // "keep": public stays public; private and internal both become private.
  return gh.visibility === "public" || (gh.visibility === undefined && gh.private === false) ? "public" : "private";
}
