import type { Context } from "hono";
import type { Env } from "../env.js";
import { devAuth } from "./dev.js";
import { Directory, type Account, type Repo, type RepoGrants, type TokenScope } from "../lib/directory.js";
import { Auth, SESSION_COOKIE, cookieFrom } from "./sessions.js";
import { HttpError, fromB64 } from "../lib/util.js";
import type { Caller, Role } from "../repo/types.js";
import { ROLE_LEVEL } from "../repo/types.js";
import { taskPersonAllowed } from "../agentic/access.js";
import { blockSubjects, isBlocked } from "../lib/moderation.js";
import { agentMayMerge } from "../lib/agent-setup.js";
import type { WatchLevel } from "../mail/prefs.js";
import { Apps, INSTALLATION_TOKEN_PREFIX, type App, type InstallationAuth } from "../apps/store.js";
import { looksLikeJwt } from "../apps/keys.js";
import { toJobPermissions } from "../apps/model.js";
import { roleForPermissions } from "../lib/job-permissions.js";

export type Principal =
  | {
      type: "account";
      account: Account;
      via: "session" | "token" | "dev";
      scopes: TokenScope[];
      repoIds: string[] | null;
      sessionId?: string;
      sessionAt?: string;
      importId?: string;
      tokenId?: string;
      /** An agent's owner as its token's check read it (lib/directory.ts verifyToken), so the request needn't read it again. */
      owner?: Account | null;
    }
  | { type: "repo-token"; repoId: string; token: string }
  /** A GitHub-compatible app signed in with a JWT made with its private key (apps/keys.ts): app endpoints only. */
  | { type: "app"; app: App }
  /** An app's installation access token ("dia_"): the repositories the installation covers, within its permissions. */
  | { type: "installation"; auth: InstallationAuth }
  | { type: "anonymous" };

export interface AppVars {
  principal: Principal;
  dir: Directory;
  /** Set for MCP tools that only read, so POST-carried reads count as reads. */
  readOnly?: boolean;
  /** Suspended people whose content this request hides, once looked up (http/common.ts hiddenAuthors). */
  hidden?: Promise<string[]>;
  /** The signed-in person's watch level for the repository the request is about, once looked up (http/common.ts watchLevelOnce). */
  watch?: { repoId: string; level: Promise<WatchLevel> };
}

export type AppContext = Context<{ Bindings: Env; Variables: AppVars }>;

/** Extract a bearer/basic credential, as git, curl, the CLI and MCP clients send it. */
export function credentialFrom(req: Request): string | null {
  // A request can carry the header twice (git-lfs sends http.extraheader and the batch API's
  // header), which arrives joined with ", ": use the first.
  const h = req.headers.get("authorization")?.split(",")[0]!.trim();
  if (!h) return null;
  const [scheme, value] = h.split(/\s+/, 2);
  if (!value) return null;
  if (/^bearer$/i.test(scheme!) || /^token$/i.test(scheme!)) return value.trim();
  if (/^basic$/i.test(scheme!)) {
    let bytes: Uint8Array;
    try {
      // Git LFS may send the same header twice (http.extraHeader and the batch action's header), joined by a comma.
      bytes = fromB64(value.split(",")[0]!.trim());
    } catch {
      throw new HttpError(401, "malformed basic credentials");
    }
    const decoded = new TextDecoder().decode(bytes);
    const idx = decoded.indexOf(":");
    const pass = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    const user = idx >= 0 ? decoded.slice(0, idx) : "";
    return pass || user || null;
  }
  return null;
}

/** The Cloudflare Access assertion, present only on the Access-protected recovery path. */
export function accessToken(req: Request): string | null {
  const h = req.headers.get("cf-access-jwt-assertion");
  if (h) return h;
  const cookie = req.headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m ? m[1]! : null;
}

const IMPORT_GIT_PATH = /^\/[^/]+\/[^/]+\/(info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/objects\/[^/]+)$/;

export async function resolvePrincipal(req: Request, env: Env, dir: Directory): Promise<Principal> {
  const cred = credentialFrom(req);
  if (cred) {
    if (cred.startsWith("dfy_")) {
      const v = await dir.verifyToken(cred);
      if (!v) throw new HttpError(401, "invalid, expired or revoked token");
      if (v.importId) {
        // An import's push token reaches only Git, Git LFS and its own agent endpoints.
        const path = new URL(req.url).pathname;
        const agent = path.startsWith(`/api/v3/diffinery/imports/${v.importId}/agent/`);
        if (!agent && !IMPORT_GIT_PATH.test(path)) throw new HttpError(403, "this token can only be used by its GitHub import");
        return { type: "account", account: v.account, via: "token", scopes: v.scopes, repoIds: v.repoIds, importId: v.importId, tokenId: v.id, owner: v.owner };
      }
      return { type: "account", account: v.account, via: "token", scopes: v.scopes, repoIds: v.repoIds, tokenId: v.id, owner: v.owner };
    }
    // Job and sandbox tokens, and self-hosted runners' own tokens (which only claim jobs: runnerAuth refuses them).
    if (cred.startsWith("djt_") || cred.startsWith("dst_") || cred.startsWith("drn_")) {
      const repoId = cred.split("_")[1];
      if (!repoId) throw new HttpError(401, "malformed token");
      return { type: "repo-token", repoId, token: cred };
    }
    if (cred.startsWith(INSTALLATION_TOKEN_PREFIX)) {
      const auth = await new Apps(env, dir).verifyToken(cred);
      if (!auth) throw new HttpError(401, "Bad credentials");
      return { type: "installation", auth };
    }
    if (looksLikeJwt(cred)) return { type: "app", app: await new Apps(env, dir).appForJwt(cred) };
    throw new HttpError(401, "unrecognised token; create one under Settings → Access tokens");
  }
  // Browsers sign in with a passkey (or the Access recovery path) and carry a session cookie.
  const session = cookieFrom(req, SESSION_COOKIE);
  if (session) {
    const s = await new Auth(env).session(session);
    if (s) return { type: "account", account: s.account, via: "session", scopes: ["admin"], repoIds: null, sessionId: s.session.id, sessionAt: s.session.created_at };
  }
  if (devAuth(env, req.url)) {
    const account = await dir.userForEmail(env.DEV_AUTH!);
    return { type: "account", account, via: "dev", scopes: ["admin"], repoIds: null };
  }
  return { type: "anonymous" };
}

export function requireAccount(c: AppContext): Account {
  const p = c.get("principal");
  // GitHub's answer to an app's credentials on an endpoint for people.
  if (p.type === "app" || p.type === "installation") throw new HttpError(403, "Resource not accessible by integration");
  if (p.type !== "account") throw new HttpError(401, "sign in required");
  if (p.account.status === "pending") throw new HttpError(403, "your account is waiting for an invite");
  if (p.account.status === "disabled") throw new HttpError(403, "your account is disabled");
  return p.account;
}

export const TOKEN_SCOPES: readonly TokenScope[] = ["read", "write", "admin"];

/**
 * Personal access tokens carry a scope; browser sessions act with full scope.
 * Throws 403 when the request's token lacks `need` (read < write < admin).
 */
export function requireScope(c: AppContext, need: TokenScope): void {
  const p = c.get("principal");
  if (p.type !== "account" || p.via !== "token") return;
  const have = Math.max(...p.scopes.map((s) => TOKEN_SCOPES.indexOf(s)));
  if (have < TOKEN_SCOPES.indexOf(need)) throw new HttpError(403, `this token needs the ${need} scope`);
}

/** Account-level changes (orgs, invitations, agents, tokens, settings) also refuse tokens limited to repositories. */
export function requireAccountScope(c: AppContext, need: TokenScope): void {
  requireScope(c, need);
  const p = c.get("principal");
  if (p.type === "account" && p.via === "token" && p.repoIds) throw new HttpError(403, "this token is limited to repositories and can't change account settings");
}

/** `repos` narrowed to the ones a repository-limited token may use, so listing never reveals the others. */
export function tokenRepos<T extends { id: string }>(c: AppContext, repos: T[]): T[] {
  const p = c.get("principal");
  const only = p.type === "account" ? p.repoIds : null;
  return only ? repos.filter((r) => only.includes(r.id)) : repos;
}

/** Notifications span every repository, so a repository-limited token can't read them (as with GitHub's fine-grained tokens). */
export function requireUnlimitedToken(c: AppContext, what: string): void {
  const p = c.get("principal");
  if (p.type === "account" && p.via === "token" && p.repoIds) throw new HttpError(403, `this token is limited to repositories and can't ${what}`);
}

/**
 * Minting credentials (tokens, agents and their tokens) needs a person signed in with a
 * passkey. No token can create another, so a leaked, repository-limited, agent, job or
 * sandbox token can never turn itself into a wider or longer-lived one.
 */
export function requireBrowserSession(c: AppContext): Account {
  const p = c.get("principal");
  if (p.type === "account" && (p.via === "session" || p.via === "dev")) {
    requireRecentSignIn(c, "/settings/tokens");
    return requireAccount(c);
  }
  if (p.type === "anonymous") throw new HttpError(401, "sign in required");
  throw new HttpError(403, `creating tokens needs a browser session: sign in at ${c.env.PUBLIC_URL}/settings/tokens`);
}

/** How long after a sign-in a browser may do sensitive things, as in GitHub's sudo mode. */
export const RECENT_SIGNIN_MS = 2 * 3600_000;

/** A sensitive action from a browser whose sign-in isn't recent: the person signs in again, then comes back to `next`. */
export class SignInAgain extends HttpError {
  readonly confirm: string;
  constructor(next: string) {
    const confirm = `/login?confirm=1&next=${encodeURIComponent(next)}`;
    super(403, "Confirm it's you: sign in with your passkey again to do this.", { confirm });
    this.confirm = confirm;
  }
}

/**
 * Adding a passkey, minting a token or an agent, issuing a sign-in link, changing your
 * username, and deleting or transferring a repository or organization need a sign-in from
 * the last 2 hours. So a
 * session left open on a shared computer, or a stolen session cookie, can't turn itself
 * into a lasting credential or destroy work. Tokens are bounded by their scopes instead.
 */
export function requireRecentSignIn(c: AppContext, next: string): void {
  const p = c.get("principal");
  if (p.type !== "account" || p.via !== "session") return;
  if (p.sessionAt && Date.now() - Date.parse(p.sessionAt) < RECENT_SIGNIN_MS) return;
  throw new SignInAgain(next);
}

/**
 * grantsFor reads for whoever the caller's role in `owner/name` depends on (the person, or an agent and its owner),
 * so loadRepo can read them alongside the repository. Nothing for callers whose role needs no grants.
 */
export function grantsFor(c: AppContext, owner: string, name: string): Promise<RepoGrants[]> {
  const p = c.get("principal");
  if (p.type !== "account" || p.account.status !== "active" || p.account.site_admin) return Promise.resolve([]);
  const a = p.account;
  const ids = a.kind === "agent" ? [a.id, ...(a.owner_id && p.owner?.id === a.owner_id && p.owner.kind === "user" ? [a.owner_id] : [])] : a.kind === "user" ? [a.id] : [];
  const dir = c.get("dir");
  return Promise.all(ids.map((id) => dir.grantsFor(owner, name, id))).then((all) => all.flat());
}

/** Validates scopes sent by a client: known names only, default write. */
export function parseScopes(input: unknown): TokenScope[] {
  if (input === undefined || input === null) return ["write"];
  if (!Array.isArray(input) || !input.length || input.some((s) => !TOKEN_SCOPES.includes(s as TokenScope))) throw new HttpError(422, `scopes must be a non-empty list of: ${TOKEN_SCOPES.join(", ")}`);
  return [...new Set(input as TokenScope[])];
}

const SCOPE_CAP: Record<TokenScope, Role> = { read: "read", write: "maintain", admin: "admin" };

/**
 * Resolve the caller's effective role on a repository, combining account
 * permissions with token scopes and repo restrictions. Returns null for no access.
 */
export async function callerFor(c: AppContext, repo: Repo, grants: RepoGrants[] = []): Promise<Caller | null> {
  const p = c.get("principal");
  const dir = c.get("dir");
  // A suspended person's repositories are hidden from everyone but site administrators, and their
  // job, sandbox and runner tokens stop working (lib/moderation.ts).
  if (repo.owner_suspended_at && !(p.type === "account" && p.account.site_admin)) return null;
  if (p.type === "repo-token") {
    // Like GITHUB_TOKEN, a job or sandbox token reads other repositories only when they are public,
    // and only once its own repository has vouched for it: a made-up token must not pass as a
    // credential (it would skip the anonymous rate limit). Reads only: loadRepo refuses writes.
    if (p.repoId !== repo.id) {
      if (repo.visibility !== "public") return null;
      const own = await dir.repoById(p.repoId);
      if (!own || !(await c.env.REPO.get(c.env.REPO.idFromName(own.id)).runnerAuth(p.token))) throw new HttpError(401, "invalid, expired or revoked token");
      return { id: "anonymous", login: "anonymous", kind: "user", role: "read" };
    }
    const stub = c.env.REPO.get(c.env.REPO.idFromName(repo.id));
    const auth = await stub.runnerAuth(p.token);
    if (!auth) return null;
    // A job token can do what the workflow's `permissions:` grant, checked per request in
    // loadRepo. Runs an agent started act as an agent, so its guardrails still apply.
    if (auth.kind === "job") {
      return { id: `job:${auth.jobId}`, login: "diffinery-actions[bot]", kind: auth.actorKind === "agent" ? "agent" : "system", role: auth.role, permissions: auth.permissions };
    }
    // A sandbox acts as the person or agent who started it, never beyond what they can do now:
    // disabling the account or losing access ends its sandboxes' tokens too.
    const account = await dir.account(auth.caller.id);
    const now = account?.status === "active" ? await dir.roleFor(account, repo) : null;
    if (!now) return null;
    // An agent task's sandbox (agentic/) also stops working once the person who started the task
    // is disabled, loses write access or can no longer drive the agent.
    if (auth.taskPerson && !(await taskPersonAllowed(dir, auth.taskPerson, account!, repo))) return null;
    let cap: Role = ROLE_LEVEL[auth.caller.role] > ROLE_LEVEL.write ? "write" : auth.caller.role;
    if (ROLE_LEVEL[now] < ROLE_LEVEL[cap]) cap = now;
    return { ...auth.caller, role: cap };
  }
  if (p.type === "installation") return installationCaller(c, p.auth, repo);
  // An app's JWT works on app endpoints only (http/apps.ts), as on GitHub.
  if (p.type === "app") return null;
  if (p.type !== "account") {
    return repo.visibility === "public" ? { id: "anonymous", login: "anonymous", kind: "user", role: "read" } : null;
  }
  if (p.repoIds && !p.repoIds.includes(repo.id)) return null;
  const a = p.account;
  // An agent's owner: from its token's check when that read it, else read alongside the role.
  const known = a.kind === "agent" && a.owner_id && p.owner?.id === a.owner_id ? p.owner : undefined;
  const [found, owner] = await Promise.all([dir.roleFor(a, repo, known, grants), a.kind === "agent" && a.owner_id ? (known ?? dir.account(a.owner_id)) : null]);
  let role = found;
  if (!role) return null;
  const cap = p.scopes.reduce<Role>((best, s) => (ROLE_LEVEL[SCOPE_CAP[s]] > ROLE_LEVEL[best] ? SCOPE_CAP[s] : best), "read");
  if (ROLE_LEVEL[role] > ROLE_LEVEL[cap]) role = cap;
  const onBehalfOf = owner?.login;
  // Someone the repository's owner blocked (or their agent) can still read, but not take part (lib/moderation.ts).
  // Checked for changes only: reads stay as fast as they were.
  const writing = c.req.method !== "GET" && c.req.method !== "HEAD";
  const blocked = writing && repo.owner_id !== a.id && (await isBlocked(c.env, repo.owner_id, blockSubjects(a)));
  return { id: a.id, login: a.login, kind: a.kind === "agent" ? "agent" : "user", onBehalfOf, role, ...(blocked ? { blockedBy: repo.owner_login } : {}), ...(agentMayMerge(a) ? { mayMerge: true } : {}) };
}

/**
 * An installation token in a repository: the app's bot with the token's permissions, checked per
 * endpoint by the same table as a workflow's GITHUB_TOKEN (loadRepo). Outside what the installation
 * covers (or the repositories the token was narrowed to) it reads public repositories like anyone.
 */
async function installationCaller(c: AppContext, auth: InstallationAuth, repo: Repo): Promise<Caller | null> {
  const mine = (!auth.repoIds || auth.repoIds.includes(repo.id)) && (await new Apps(c.env, c.get("dir")).covers(auth.installation, repo));
  if (!mine) return repo.visibility === "public" ? { id: "anonymous", login: "anonymous", kind: "user", role: "read" } : null;
  const permissions = toJobPermissions(auth.permissions);
  return { id: `app:${auth.installation.id}`, login: `${auth.app.slug}[bot]`, kind: "system", role: roleForPermissions(permissions), permissions };
}
