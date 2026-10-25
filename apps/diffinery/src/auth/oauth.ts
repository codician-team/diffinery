import type { Env } from "../env.js";
import { Directory, type Account, type TokenScope } from "../lib/directory.js";
import { checkPublicUrl } from "../imports/options.js";
import { HttpError, b64url, fromB64, newId, now, randomToken, sha256 } from "../lib/util.js";
import { localOnly } from "./dev.js";

/**
 * OAuth 2.1 for MCP clients, so people connect an app (a claude.ai connector, Claude Code, Codex,
 * Cursor, VS Code) to Diffinery by approving it in the browser instead of pasting a token. It
 * follows the MCP authorization spec: Diffinery is both the resource (/mcp, described at
 * /.well-known/oauth-protected-resource) and its authorization server (/.well-known/oauth-authorization-server).
 *
 * - Apps identify by registering themselves (RFC 7591, client_id "dfc_…"), or by a client metadata
 *   document whose https URL is the client_id (as the MCP spec's 2025-11-25 revision prefers).
 * - Only the authorization code flow with PKCE S256. Redirect URIs must match what the app
 *   registered exactly, except that a loopback http URI may use any port (RFC 8252).
 * - The person approves on /oauth/authorize, with a passkey sign-in from the last 2 hours, and picks
 *   whom the app acts as (themselves or one of their agents) and its access (read, write or admin;
 *   admin is never preselected).
 * - Access tokens are ordinary Diffinery tokens (dfy_…) that last 8 hours, so they work for git,
 *   the REST API and the CLI as well as MCP, with every permission check those apply. Refresh tokens
 *   (dfr_…) rotate on each use and lapse after 30 days without one; a stolen one used after it was
 *   replaced ends the connection.
 * - Each connection is listed under Settings → Access tokens → Connected apps, where revoking it
 *   revokes its tokens too.
 */

export const ACCESS_TTL_S = 8 * 3600;
export const REFRESH_IDLE_DAYS = 30;
export const CODE_TTL_S = 300;
/** A refresh token used again this soon after it was replaced is a client retrying, not a thief: refused, connection kept. */
export const REUSE_GRACE_S = 120;
/** Scopes an app may ask for (the token scopes); the person decides. Not imported from principal.ts, which would be an import cycle. */
export const OAUTH_SCOPES: readonly TokenScope[] = ["read", "write", "admin"];
const MAX_REDIRECTS = 10;
const MAX_URI = 2000;
const METADATA_TTL_MS = 86400_000;
const METADATA_MAX_BYTES = 8192;

/**
 * Copies of the metadata documents of the two clients this is mostly for, used only when reading
 * the live document fails (chatgpt.com's bot protection refuses some servers). Both send people
 * back only to a loopback address on their own computer, so a copy can't send a code elsewhere.
 */
const KNOWN_CLIENTS: Record<string, { name: string; clientUri: string; redirectUris: string[] }> = {
  "https://claude.ai/oauth/claude-code-client-metadata": { name: "Claude Code", clientUri: "https://claude.ai", redirectUris: ["http://localhost/callback", "http://127.0.0.1/callback"] },
  "https://chatgpt.com/oauth/codex/client.json": { name: "Codex", clientUri: "https://chatgpt.com/codex", redirectUris: ["http://127.0.0.1/callback", "http://localhost/callback"] },
};

/**
 * Diffinery's own editor integrations: the extension for VS Code and the editors built on it (apps/vscode) and the
 * plugin for JetBrains IDEs (apps/jetbrains). Each client_id is the URL of a metadata document this server publishes
 * about itself, so it's resolved here instead of fetched (a client_id can't point at Diffinery itself). VS Code-based
 * editors may send people back through their own URL scheme; both sign in through a loopback address on the person's
 * computer otherwise.
 */
export const EDITOR_CLIENT_PATH = "/oauth/clients/editor.json";
export const JETBRAINS_CLIENT_PATH = "/oauth/clients/jetbrains.json";
export const EDITOR_EXTENSION_ID = "codician.diffinery";
export const EDITOR_SCHEMES = ["vscode", "vscode-insiders", "cursor", "windsurf", "vscodium", "positron", "kiro"] as const;
const OWN_CLIENTS: Record<string, { name: string; docs: string; redirectUris: string[] }> = {
  [EDITOR_CLIENT_PATH]: {
    name: "Diffinery extension for VS Code and Cursor",
    docs: "/docs/repositories/clone-in-your-editor",
    redirectUris: [...EDITOR_SCHEMES.map((s) => `${s}://${EDITOR_EXTENSION_ID}/oauth`), "http://127.0.0.1/callback"],
  },
  [JETBRAINS_CLIENT_PATH]: { name: "Diffinery plugin for JetBrains IDEs", docs: "/docs/repositories/clone-in-jetbrains-ides", redirectUris: ["http://127.0.0.1/callback"] },
};
export const OWN_CLIENT_PATHS = Object.keys(OWN_CLIENTS);
/** The metadata document of one of Diffinery's own clients, by its path on this server, or null. */
export function ownClientDocument(env: Pick<Env, "PUBLIC_URL">, path: string) {
  const c = OWN_CLIENTS[path];
  if (!c) return null;
  return {
    client_id: `${base(env)}${path}`,
    client_name: c.name,
    client_uri: `${base(env)}${c.docs}`,
    redirect_uris: c.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export type AuthMethod = "none" | "client_secret_basic" | "client_secret_post";

export interface OAuthClient {
  id: string;
  kind: "registered" | "metadata";
  name: string;
  client_uri: string | null;
  redirect_uris: string[];
  auth_method: AuthMethod;
  secret_hash: string | null;
}

export interface OAuthGrant {
  id: string;
  client_id: string;
  client_name: string;
  redirect_host: string;
  person_id: string;
  account_id: string;
  scope: TokenScope;
  created_at: string;
  used_at: string | null;
  refresh_expires_at: string;
}

/** An error the OAuth endpoints answer with ({error, error_description}), RFC 6749 §5.2. */
export class OAuthError extends Error {
  constructor(
    readonly error: "invalid_request" | "invalid_client" | "invalid_grant" | "unauthorized_client" | "unsupported_grant_type" | "invalid_scope" | "invalid_target" | "invalid_redirect_uri" | "invalid_client_metadata" | "access_denied" | "server_error",
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

const base = (env: Pick<Env, "PUBLIC_URL">) => env.PUBLIC_URL.replace(/\/$/, "");

/** RFC 9728: what /mcp is and who issues tokens for it. */
export function protectedResourceMetadata(env: Pick<Env, "PUBLIC_URL">) {
  const b = base(env);
  return {
    resource: `${b}/mcp`,
    authorization_servers: [b],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Diffinery",
    resource_documentation: `${b}/docs/agents/mcp`,
  };
}

/** RFC 8414: the authorization server's endpoints and what it supports. */
export function authorizationServerMetadata(env: Pick<Env, "PUBLIC_URL">) {
  const b = base(env);
  return {
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`,
    revocation_endpoint: `${b}/oauth/revoke`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    service_documentation: `${b}/docs/connect/how-sign-in-works`,
  };
}

/** The WWW-Authenticate header a 401 from /mcp carries, so a client finds where to sign in (RFC 9728 §5.1). */
export const mcpChallenge = (env: Pick<Env, "PUBLIC_URL">, error?: "invalid_token") =>
  `Bearer realm="Diffinery", resource_metadata="${base(env)}/.well-known/oauth-protected-resource/mcp"${error ? `, error="${error}"` : ""}`;

// ---------------------------------------------------------------- redirect URIs

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;
/** Schemes an app's redirect URI may never use: they run code, read files, or aren't apps. */
const BAD_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:", "about:", "filesystem:", "ftp:", "ws:", "wss:", "mailto:", "tel:", "sms:", "view-source:", "chrome:", "chrome-extension:", "moz-extension:", "intent:", "content:", "jar:"]);

/**
 * A redirect URI an app may register: https on any host, http only on this computer (RFC 8252
 * loopback), or an app's own scheme such as cursor:// or vscode://. Never a fragment or credentials.
 */
export function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw || raw.length > MAX_URI) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || raw.includes("#") || u.username || u.password) return false;
  if (u.protocol === "https:") return !!u.hostname;
  if (u.protocol === "http:") return LOOPBACK_HOST.test(u.hostname);
  if (BAD_SCHEMES.has(u.protocol)) return false;
  // A private-use scheme (RFC 8252 §7.1): letters, digits, + . -, starting with a letter.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}

/** Whether `asked` is one of `registered`: exactly, or a loopback http URI that differs only in its port. */
export function redirectMatches(registered: string[], asked: string): boolean {
  if (registered.includes(asked)) return true;
  let a: URL;
  try {
    a = new URL(asked);
  } catch {
    return false;
  }
  if (a.protocol !== "http:" || !LOOPBACK_HOST.test(a.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === "http:" && u.hostname === a.hostname && u.pathname === a.pathname && u.search === a.search;
    } catch {
      return false;
    }
  });
}

/** What the person sees as where they'll be sent back: a host, or an app's scheme. */
export function redirectLabel(uri: string): string {
  const u = new URL(uri);
  if (u.protocol === "http:" && LOOPBACK_HOST.test(u.hostname)) return "an app on this computer";
  return u.protocol === "https:" ? u.host : `${u.protocol}//${u.host}`;
}

/** The CSP form-action source that lets the consent form lead to this redirect URI. */
export function formActionSource(uri: string): string {
  const u = new URL(uri);
  if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
  return u.protocol;
}

/** The access an app asked for, as a starting choice: the widest of read and write it names, never admin. */
export function requestedScope(raw: string | undefined | null): TokenScope {
  const words = (raw ?? "").split(/[\s+,]+/).filter(Boolean);
  if (!words.length) return "write";
  if (words.includes("write") || words.includes("admin")) return "write";
  if (words.includes("read")) return "read";
  return "write";
}

/** The resource indicator (RFC 8707), when sent, must name this server or its /mcp. */
export function checkResource(env: Pick<Env, "PUBLIC_URL">, resource: string | undefined | null): void {
  if (!resource) return;
  const b = base(env);
  const r = resource.replace(/\/+$/, "");
  if (r !== b && r !== `${b}/mcp`) throw new OAuthError("invalid_target", `resource must be ${b}/mcp`);
}

const cleanText = (v: unknown, max: number) =>
  (typeof v === "string" ? v : "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** A client_id that is a metadata document's URL: https with a path, no fragment or credentials. */
export function isMetadataClientId(id: string, local = false): boolean {
  // Plain http only for a Worker on this computer (the end-to-end tests' document server).
  if (!(id.startsWith("https://") || (local && id.startsWith("http://"))) || id.length > MAX_URI) return false;
  try {
    const u = new URL(id);
    return u.pathname.length > 1 && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * Whom a person may connect an app as: themselves, an agent they own, or an agent of an organization
 * they own or administer. Checked when they approve, and again on every refresh, so losing the
 * right ends the connection.
 */
/**
 * The access a person may give an app acting as `account`. A site administrator's account can't be connected
 * with admin access: an app would carry site-wide administration in a token, without the passkey step-up.
 */
export const adminAllowed = (account: Account) => !account.site_admin;

export async function canActAs(dir: Directory, person: Account, account: Account): Promise<boolean> {
  if (person.kind !== "user" || person.status !== "active" || person.suspended_at || account.status !== "active") return false;
  if (account.id === person.id) return true;
  if (account.kind !== "agent" || !account.owner_id) return false;
  if (account.owner_id === person.id) return true;
  const role = await dir.orgRole(account.owner_id, person.id);
  return role === "owner" || role === "admin";
}

// ---------------------------------------------------------------- the store

export class OAuth {
  constructor(
    private env: Env,
    private dir = new Directory(env),
  ) {}

  private get db(): D1Database {
    return this.env.DB;
  }

  /** RFC 7591 dynamic registration. Anyone may register (rate limited per address); approving is what counts. */
  async register(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length) throw new OAuthError("invalid_redirect_uri", "redirect_uris must list at least one URI");
    if (uris.length > MAX_REDIRECTS) throw new OAuthError("invalid_redirect_uri", `at most ${MAX_REDIRECTS} redirect_uris`);
    for (const u of uris) if (!validRedirectUri(u)) throw new OAuthError("invalid_redirect_uri", `redirect URI not allowed: ${String(u).slice(0, 200)} (use https, http on localhost or 127.0.0.1, or your app's own scheme)`);
    const method = (body.token_endpoint_auth_method ?? "none") as AuthMethod;
    if (!["none", "client_secret_basic", "client_secret_post"].includes(method)) throw new OAuthError("invalid_client_metadata", "token_endpoint_auth_method must be none, client_secret_basic or client_secret_post");
    const grants = body.grant_types;
    if (grants !== undefined && (!Array.isArray(grants) || grants.some((g) => g !== "authorization_code" && g !== "refresh_token"))) throw new OAuthError("invalid_client_metadata", "grant_types may be authorization_code and refresh_token");
    const responses = body.response_types;
    if (responses !== undefined && (!Array.isArray(responses) || responses.some((r) => r !== "code"))) throw new OAuthError("invalid_client_metadata", "response_types may only be code");
    const name = cleanText(body.client_name, 80) || "Unnamed app";
    const clientUri = typeof body.client_uri === "string" && /^https:\/\//.test(body.client_uri) && body.client_uri.length <= MAX_URI ? body.client_uri : null;
    const software = cleanText([body.software_id, body.software_version].filter((v) => typeof v === "string").join(" "), 120) || null;
    const id = `dfc_${randomToken(18)}`;
    const secret = method === "none" ? null : `dfs_${randomToken(30)}`;
    const at = now();
    await this.db
      .prepare("INSERT INTO oauth_clients (id, kind, name, client_uri, redirect_uris, auth_method, secret_hash, software, created_at) VALUES (?, 'registered', ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, name, clientUri, JSON.stringify(uris), method, secret ? await sha256(secret) : null, software, at)
      .run();
    return {
      client_id: id,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.parse(at) / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
      ...(clientUri ? { client_uri: clientUri } : {}),
    };
  }

  /**
   * The app a client_id names: registered here, or its metadata document (fetched, then cached a day).
   * `fetch: false` (the token and revocation endpoints) uses only what an approval already fetched, so
   * nobody can make Diffinery fetch and store documents without signing in.
   */
  async client(id: string | undefined | null, opts: { fetch?: boolean } = {}): Promise<OAuthClient | null> {
    if (!id || id.length > MAX_URI) return null;
    const row = await this.db.prepare("SELECT * FROM oauth_clients WHERE id = ?").bind(id).first<Record<string, string | null>>();
    const fresh = row && (row.kind === "registered" || (row.fetched_at && Date.now() - Date.parse(row.fetched_at) < METADATA_TTL_MS));
    if (row && (fresh || opts.fetch === false)) return toClient(row);
    const own = id.startsWith(`${base(this.env)}/`) ? ownClientDocument(this.env, id.slice(base(this.env).length)) : null;
    if (opts.fetch === false && !own) return null;
    if (!own && !isMetadataClientId(id, localOnly(this.env))) return null;
    const doc = own
      ? { name: own.client_name, clientUri: own.client_uri, redirectUris: own.redirect_uris }
      : ((await this.fetchMetadata(id).catch((e) => {
          console.error("client metadata document failed", id, String(e));
          return null;
        })) ??
        KNOWN_CLIENTS[id] ??
        null);
    if (!doc) return row ? toClient(row) : null;
    const at = now();
    await this.db
      .prepare(
        "INSERT INTO oauth_clients (id, kind, name, client_uri, redirect_uris, auth_method, created_at, fetched_at) VALUES (?, 'metadata', ?, ?, ?, 'none', ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, client_uri = excluded.client_uri, redirect_uris = excluded.redirect_uris, fetched_at = excluded.fetched_at",
      )
      .bind(id, doc.name, doc.clientUri, JSON.stringify(doc.redirectUris), at, at)
      .run();
    return { id, kind: "metadata", name: doc.name, client_uri: doc.clientUri, redirect_uris: doc.redirectUris, auth_method: "none", secret_hash: null };
  }

  /** Reads a client metadata document: https on a public host, no redirects, small, and naming itself. */
  private async fetchMetadata(id: string): Promise<{ name: string; clientUri: string | null; redirectUris: string[] } | null> {
    checkPublicUrl(id, localOnly(this.env), "client_id", new URL(this.env.PUBLIC_URL).hostname);
    const res = await fetch(id, { redirect: "manual", headers: { accept: "application/json", "user-agent": "Diffinery-OAuth/1 (+https://diffinery.com/docs/connect/how-sign-in-works)" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.error("client metadata document refused", id, res.status);
      return null;
    }
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > METADATA_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let off = 0;
    for (const ch of chunks) {
      bytes.set(ch, off);
      off += ch.byteLength;
    }
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
    if (!doc || typeof doc !== "object" || doc.client_id !== id) return null;
    const uris = doc.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECTS || !uris.every(validRedirectUri)) return null;
    const method = doc.token_endpoint_auth_method ?? "none";
    if (method !== "none") return null;
    return { name: cleanText(doc.client_name, 80) || new URL(id).host, clientUri: typeof doc.client_uri === "string" && /^https:\/\//.test(doc.client_uri) ? doc.client_uri.slice(0, MAX_URI) : null, redirectUris: uris as string[] };
  }

  /**
   * Checks an authorization request before anyone sees a consent page. Errors that can't safely go
   * back to the app (an unknown app or redirect URI) throw HttpError, to be shown on the page;
   * the rest throw OAuthError, which the caller sends back to the redirect URI.
   */
  async checkAuthorize(q: { client_id?: string; redirect_uri?: string; response_type?: string; code_challenge?: string; code_challenge_method?: string; resource?: string }): Promise<{ client: OAuthClient; redirectUri: string }> {
    const client = await this.client(q.client_id);
    if (!client) throw new HttpError(400, "This app isn't registered with Diffinery, or its registration expired. Connect it again from the app.");
    let redirectUri = q.redirect_uri;
    if (!redirectUri) {
      if (client.redirect_uris.length !== 1) throw new HttpError(400, "The app didn't say where to send you back (redirect_uri).");
      redirectUri = client.redirect_uris[0]!;
    }
    if (!redirectMatches(client.redirect_uris, redirectUri)) throw new HttpError(400, "The app asked to send you back to an address it didn't register. Nothing was shared.");
    if (q.response_type !== "code") throw new OAuthError("invalid_request", "response_type must be code");
    if (!q.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) throw new OAuthError("invalid_request", "a PKCE code_challenge (S256) is required");
    if (q.code_challenge_method !== "S256") throw new OAuthError("invalid_request", "code_challenge_method must be S256");
    checkResource(this.env, q.resource);
    return { client, redirectUri };
  }

  /** The person approved: a one-time code for the app's redirect URI. */
  async issueCode(input: { client: OAuthClient; redirectUri: string; challenge: string; person: Account; account: Account; scope: TokenScope }): Promise<string> {
    const code = `dfa_${randomToken(32)}`;
    const at = now();
    await this.db
      .prepare("INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, person_id, account_id, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(await sha256(code), input.client.id, input.redirectUri, input.challenge, input.person.id, input.account.id, input.scope, at, new Date(Date.now() + CODE_TTL_S * 1000).toISOString())
      .run();
    await this.db.prepare("UPDATE oauth_clients SET used_at = ? WHERE id = ?").bind(at, input.client.id).run();
    return code;
  }

  /** Who is calling the token or revocation endpoint: a public app names itself, a confidential one proves it. */
  async authenticateClient(form: Record<string, string>, authorization: string | null | undefined): Promise<OAuthClient> {
    let id = form.client_id;
    let secret = form.client_secret;
    if (authorization && /^basic\s/i.test(authorization)) {
      let decoded: string;
      try {
        decoded = new TextDecoder().decode(fromB64(authorization.replace(/^basic\s+/i, "").trim()));
      } catch {
        throw new OAuthError("invalid_client", "malformed basic credentials", 401);
      }
      const i = decoded.indexOf(":");
      id = decodeURIComponent(i >= 0 ? decoded.slice(0, i) : decoded);
      secret = decodeURIComponent(i >= 0 ? decoded.slice(i + 1) : "");
    }
    const client = await this.client(id, { fetch: false });
    if (!client) throw new OAuthError("invalid_client", "unknown client_id", 401);
    if (client.auth_method !== "none") {
      if (!secret || !client.secret_hash || (await sha256(secret)) !== client.secret_hash) throw new OAuthError("invalid_client", "client authentication failed", 401);
    }
    return client;
  }

  /** authorization_code: the code, with the verifier the app kept and the same redirect URI. */
  async exchangeCode(client: OAuthClient, form: Record<string, string>): Promise<TokenResponse> {
    if (!form.code || !form.code_verifier) throw new OAuthError("invalid_request", "code and code_verifier are required");
    checkResource(this.env, form.resource);
    const at = now();
    const row = await this.db
      .prepare("UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING *")
      .bind(at, await sha256(form.code), at)
      .first<{ client_id: string; redirect_uri: string; code_challenge: string; person_id: string; account_id: string; scope: string }>();
    if (!row) throw new OAuthError("invalid_grant", "unknown, expired or already used code");
    // Checked after the claim, so a wrong guess burns the code instead of allowing retries.
    if (row.client_id !== client.id) throw new OAuthError("invalid_grant", "the code was issued to another client");
    if (form.redirect_uri !== undefined && form.redirect_uri !== row.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri doesn't match the authorization request");
    if (b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.code_verifier)))) !== row.code_challenge) throw new OAuthError("invalid_grant", "the code verifier doesn't match");
    const person = await this.dir.account(row.person_id);
    const account = row.account_id === row.person_id ? person : await this.dir.account(row.account_id);
    if (!person || !account || !(await canActAs(this.dir, person, account))) throw new OAuthError("invalid_grant", "the account that approved this can no longer sign in");
    const scope = scopeName(row.scope);
    const grantId = newId();
    const refresh = `dfr_${randomToken(32)}`;
    let host: string;
    try {
      host = redirectLabel(row.redirect_uri);
    } catch {
      host = "unknown";
    }
    // Each approval is its own connection, even for the same app and account: Claude Code and Codex share one
    // client_id across every computer they run on, so replacing would sign out the person's other computers.
    await this.db
      .prepare("INSERT INTO oauth_grants (id, client_id, client_name, redirect_host, person_id, account_id, scope, refresh_hash, refresh_expires_at, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(grantId, client.id, client.name, host, person.id, account.id, scope, await sha256(refresh), refreshExpiry(), at, at)
      .run();
    const access = await this.mintAccess(account, { id: grantId, client_name: client.name, scope }, true);
    await this.dir.audit({ actorId: person.id, actorLogin: person.login, action: "oauth.connect", target: account.login, detail: { app: client.name, client_id: client.id, scope, redirect: host } });
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
  }

  /** refresh_token: a new access token and a new refresh token; the old refresh token stops working. */
  async refresh(client: OAuthClient, form: Record<string, string>): Promise<TokenResponse> {
    if (!form.refresh_token) throw new OAuthError("invalid_request", "refresh_token is required");
    checkResource(this.env, form.resource);
    const hash = await sha256(form.refresh_token);
    const next = `dfr_${randomToken(32)}`;
    const at = now();
    const g = await this.db
      .prepare("UPDATE oauth_grants SET prev_refresh_hash = refresh_hash, refresh_hash = ?, refreshed_at = ?, used_at = ?, refresh_expires_at = ? WHERE refresh_hash = ? AND revoked_at IS NULL AND refresh_expires_at > ? RETURNING *")
      .bind(await sha256(next), at, at, refreshExpiry(), hash, at)
      .first<OAuthGrant>();
    if (!g) {
      // A replaced refresh token used again: someone else may have it. Past a short grace for a
      // client retrying a lost response, the connection ends (OAuth 2.1 §4.3.1).
      const stale = await this.db.prepare("SELECT id, refreshed_at FROM oauth_grants WHERE prev_refresh_hash = ? AND revoked_at IS NULL").bind(hash).first<{ id: string; refreshed_at: string | null }>();
      if (stale && (!stale.refreshed_at || Date.now() - Date.parse(stale.refreshed_at) > REUSE_GRACE_S * 1000)) {
        await this.revokeGrant(stale.id);
        console.warn("oauth refresh token reused; connection revoked", stale.id);
      }
      throw new OAuthError("invalid_grant", "unknown, expired or already used refresh token");
    }
    if (g.client_id !== client.id) {
      await this.revokeGrant(g.id);
      throw new OAuthError("invalid_grant", "the refresh token was issued to another client");
    }
    const [person, account] = await Promise.all([this.dir.account(g.person_id), this.dir.account(g.account_id)]);
    if (!person || !account || !(await canActAs(this.dir, person, account))) {
      await this.revokeGrant(g.id);
      throw new OAuthError("invalid_grant", "the account this connection acts as can no longer sign in");
    }
    const access = await this.mintAccess(account, g, false);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: next, scope: scopeName(g.scope) };
  }

  private async mintAccess(account: Account, g: { id: string; client_name: string; scope: string }, first: boolean): Promise<string> {
    const t = await this.dir.createToken(account, { name: `${g.client_name} (connected app)`.slice(0, 80), scopes: [scopeName(g.scope)], expiresInSeconds: ACCESS_TTL_S, client: "oauth", oauthGrantId: g.id, notify: first });
    return t.token;
  }

  /** RFC 7009: revoking either token ends the whole connection. Unknown tokens are not an error. */
  async revokeToken(client: OAuthClient, token: string): Promise<void> {
    const hash = await sha256(token);
    let grant = await this.db.prepare("SELECT id, client_id FROM oauth_grants WHERE refresh_hash = ? OR prev_refresh_hash = ?").bind(hash, hash).first<{ id: string; client_id: string }>();
    if (!grant) {
      const t = await this.db.prepare("SELECT g.id, g.client_id FROM tokens t JOIN oauth_grants g ON g.id = t.oauth_grant_id WHERE t.token_hash = ?").bind(hash).first<{ id: string; client_id: string }>();
      grant = t ?? null;
    }
    if (grant && grant.client_id === client.id) await this.revokeGrant(grant.id);
  }

  /** Ends a connection and its access tokens. */
  async revokeGrant(id: string): Promise<void> {
    const at = now();
    await this.db.batch([
      this.db.prepare("UPDATE oauth_grants SET revoked_at = ?, refresh_hash = NULL WHERE id = ? AND revoked_at IS NULL").bind(at, id),
      this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE oauth_grant_id = ? AND revoked_at IS NULL").bind(at, id),
    ]);
  }

  /** The connections a person approved and that still work, newest first. */
  async grantsFor(personId: string): Promise<Array<OAuthGrant & { account_login: string; last_used_at: string | null }>> {
    const r = await this.db
      .prepare(
        "SELECT g.*, a.login AS account_login, (SELECT max(t.last_used_at) FROM tokens t WHERE t.oauth_grant_id = g.id) AS last_used_at FROM oauth_grants g JOIN accounts a ON a.id = g.account_id WHERE g.person_id = ? AND g.revoked_at IS NULL AND g.refresh_expires_at > ? ORDER BY g.created_at DESC",
      )
      .bind(personId, now())
      .all<OAuthGrant & { account_login: string; last_used_at: string | null }>();
    return r.results;
  }

  /** The person revokes one of their connections. False when it isn't theirs or was already gone. */
  async revokeFor(personId: string, id: string): Promise<OAuthGrant | null> {
    const g = await this.db.prepare("SELECT * FROM oauth_grants WHERE id = ? AND person_id = ? AND revoked_at IS NULL").bind(id, personId).first<OAuthGrant>();
    if (!g) return null;
    await this.revokeGrant(g.id);
    return g;
  }

  /** Housekeeping: spent codes, expired access tokens, old connections, and registrations nobody used. */
  async prune(): Promise<void> {
    const day = new Date(Date.now() - 86400_000).toISOString();
    const month = new Date(Date.now() - 30 * 86400_000).toISOString();
    const week = new Date(Date.now() - 7 * 86400_000).toISOString();
    await this.db.batch([
      this.db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(day),
      this.db.prepare("DELETE FROM tokens WHERE oauth_grant_id IS NOT NULL AND expires_at < ?").bind(day),
      this.db.prepare("DELETE FROM oauth_grants WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR refresh_expires_at < ?").bind(month, month),
      this.db.prepare("DELETE FROM oauth_clients WHERE kind = 'registered' AND created_at < ? AND (used_at IS NULL OR used_at < ?) AND id NOT IN (SELECT client_id FROM oauth_grants)").bind(week, month),
      // Metadata documents are cached copies: drop the ones no connection uses once they're a day old.
      this.db.prepare("DELETE FROM oauth_clients WHERE kind = 'metadata' AND fetched_at < ? AND id NOT IN (SELECT client_id FROM oauth_grants) AND id NOT IN (SELECT client_id FROM oauth_codes)").bind(day),
    ]);
  }
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: TokenScope;
}

const refreshExpiry = () => new Date(Date.now() + REFRESH_IDLE_DAYS * 86400_000).toISOString();
const scopeName = (s: string): TokenScope => (OAUTH_SCOPES.includes(s as TokenScope) ? (s as TokenScope) : "read");

function toClient(row: Record<string, string | null>): OAuthClient {
  return { id: row.id!, kind: row.kind as OAuthClient["kind"], name: row.name!, client_uri: row.client_uri ?? null, redirect_uris: JSON.parse(row.redirect_uris!), auth_method: (row.auth_method ?? "none") as AuthMethod, secret_hash: row.secret_hash ?? null };
}
