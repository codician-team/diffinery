import type { Env } from "../env.js";
import { mcpChallenge } from "../auth/oauth.js";
import type { Repo } from "../lib/directory.js";
import { denied, readOnly, requestPermission, type JobPermissions } from "../lib/job-permissions.js";
import { HttpError } from "../lib/util.js";
import { errorRecord, recordServerError, requestId } from "../lib/server-errors.js";
import { movedPath, movedStatus } from "../lib/redirects.js";
import { GITHUB_DOCS } from "./gh.js";
import { callerFor, grantsFor, requireScope, type AppContext } from "../auth/principal.js";
import { atLeast, type Caller, type Role } from "../repo/types.js";
import { suspendedIds } from "../lib/moderation.js";
import { isAppCaller } from "../repo/token-policy.js";
import { MailStore, type WatchLevel } from "../mail/prefs.js";

export const repoStub = (env: Env, repoId: string) => env.REPO.get(env.REPO.idFromName(repoId));

/** A repository that was transferred or renamed: answered with a redirect to `location` (see loadRepo). */
export class RepoMoved extends HttpError {
  constructor(
    status: 301 | 307,
    readonly location: string,
  ) {
    super(status, "Moved Permanently");
  }
}

/**
 * For `loadRepo`: a settings change that doesn't touch the repository's Git data, issues or pull
 * requests (secrets, variables, environments, collaborators and invitations) goes through while
 * an import fills the repository, so people can set it up as it arrives. An import never writes
 * secret values; its variables and environments step writes GitHub's, so one set here before that
 * step under the same name ends with GitHub's value. Webhooks stay locked: nothing the import
 * does may reach one.
 */
export const WHILE_IMPORTING = { whileImporting: true } as const;

/**
 * Load a repository and the caller's role, enforcing a minimum role (404 hides
 * private repos; signed-out callers get the same answer for private and missing ones). Anonymous callers get read access to public repositories but
 * may only read: any other method needs a signed-in caller, as on GitHub,
 * unless the route is a read that happens to use POST (git fetch, LFS
 * download) and says so. Writes also need a token with the write scope.
 * Archived repositories refuse every write, whatever role the route needs,
 * except the few routes that pass `whileArchived` (unarchiving, deleting,
 * watching), as on GitHub. While a GitHub import fills the repository, every
 * write is refused with 423 except the import's own (its push token) and the
 * routes that pass `whileImporting` (watching, settings that don't touch Git
 * data (see WHILE_IMPORTING), and pushes, which the repository refuses itself
 * with a message the git client shows).
 *
 * An owner/name that a repository was transferred or renamed away from leads
 * to it, after the same visibility check, so callers who can't read it still
 * get a 404. Where the old name is in the request path, the answer is a
 * redirect (RepoMoved: 301 for reads, 307 otherwise, as GitHub does);
 * `follow` (Git, MCP) serves the repository under the old name instead, and
 * `moved` says it was reached that way.
 */
/** Paths whose reads show issues, pull requests or their comments (the web pages and the REST API). */
const CONVERSATION_PATH = /\/(?:issues|pulls?|comments)(?:\/|$)/;

export async function loadRepo(c: AppContext, owner: string, name: string, min: Role = "read", opts: { readOnlyPost?: boolean; whileArchived?: boolean; whileImporting?: boolean; follow?: boolean } = {}): Promise<{ repo: Repo; caller: Caller; stub: ReturnType<typeof repoStub>; moved: boolean }> {
  const dir = c.get("dir");
  const anonymous = c.get("principal").type === "anonymous";
  const reading = c.req.method === "GET" || c.req.method === "HEAD" || (opts.readOnlyPost && c.req.method === "POST") || c.get("readOnly") === true;
  // Signed-out callers can't tell a private repository from one that doesn't exist: writes are
  // refused before the lookup, and reads of either get the same answer. That is a 404 from the REST
  // API, as on GitHub, and a 401 everywhere else, so git asks for credentials and the web offers sign-in.
  if (anonymous && !reading) throw new HttpError(401, "authentication required");
  const hidden = () => (anonymous && !c.req.path.startsWith("/api/") ? new HttpError(401, "authentication required") : new HttpError(404, "repository not found"));
  // Reads of conversations leave out suspended people's posts (hiddenAuthors): look them up alongside the repository.
  if (reading && CONVERSATION_PATH.test(c.req.path)) hiddenAuthors(c).catch(() => {});
  // The repository and the grants that decide the caller's role in it, side by side.
  const [found, grants] = await Promise.all([dir.repo(owner, name.replace(/\.git$/, "")), grantsFor(c, owner, name)]);
  let repo = found;
  const moved = !repo;
  repo ??= await dir.movedRepo(owner, name);
  if (!repo) throw hidden();
  const caller = await callerFor(c, repo, grants);
  if (!caller) throw hidden();
  // A job or sandbox token reading another public repository acts as nobody in particular: it may read, never write.
  if (caller.id === "anonymous" && !reading) throw new HttpError(403, c.get("principal").type === "installation" ? "Resource not accessible by integration (the app isn't installed on this repository, or the token wasn't made for it)" : "this token can only write to its own repository");
  if (moved && !opts.follow) {
    const url = new URL(c.req.url);
    const path = movedPath(url.pathname, { owner, name }, { owner: repo.owner_login, name: repo.name });
    if (path) throw new RepoMoved(movedStatus(c.req.method), new URL(path + url.search, url).toString());
  }
  // After the visibility check, so a read token's write to a private repository it can't see is still a 404.
  if (!reading) requireScope(c, "write");
  if (!atLeast(caller.role, min)) throw new HttpError(403, `${min} access required`);
  if (caller.permissions) {
    // A workflow's GITHUB_TOKEN: each kind of endpoint needs its permission (issues, contents, ...).
    // What anyone may read in a public repository stays readable with `permissions: { contents: none }`.
    const req = requestPermission(c.req.method, c.req.path, min);
    const reason = denied(caller.permissions as JobPermissions, req, isAppCaller(caller) ? "app" : "job");
    if (reason && !(repo.visibility === "public" && readOnly(req))) throw new HttpError(403, reason);
  }
  if (repo.archived && !reading && !opts.whileArchived) throw new HttpError(403, "repository is archived (read-only)");
  const stub = repoStub(c.env, repo.id);
  // A page a person opens shows whether they watch the repository: start reading it now, alongside the page's own reads.
  const p = c.get("principal");
  if (reading && c.req.method === "GET" && p.type === "account" && p.via !== "token" && !c.req.path.startsWith("/api/") && !c.req.path.endsWith("/live")) {
    watchLevelOnce(c, repo.id).catch(() => {});
  }
  if (!reading && !opts.whileImporting) {
    const holder = await stub.importLockHolder();
    if (holder && !(p.type === "account" && p.importId === holder)) throw new HttpError(423, "repository is locked by an import in progress; try again when it finishes, or cancel the import");
  }
  return { repo, caller, stub, moved };
}

/** The signed-in person's watch level for a repository, read once per request: the page header and a conversation's subscription box both show it. */
export function watchLevelOnce(c: AppContext, repoId: string): Promise<WatchLevel> {
  const p = c.get("principal");
  if (p.type !== "account") return Promise.resolve("participating");
  const known = c.get("watch");
  if (known?.repoId === repoId) return known.level;
  const level = new MailStore(c.env.DB).watchLevel(p.account.id, repoId);
  c.set("watch", { repoId, level });
  return level;
}

/**
 * Suspended people (lib/moderation.ts): the issues, pull requests, reviews and comments they wrote are
 * left out for everyone but site administrators. Looked up once per request.
 */
export function hiddenAuthors(c: AppContext): Promise<string[]> {
  const p = c.get("principal");
  if (p.type === "account" && p.account.site_admin) return Promise.resolve([]);
  let v = c.get("hidden");
  if (!v) {
    v = suspendedIds(c.env);
    c.set("hidden", v);
  }
  return v;
}

/** Record a repository settings change made through the API, like the web settings pages do. */
export function auditRepo(c: AppContext, caller: Caller, repo: Pick<Repo, "owner_login" | "name">, action: string, detail: Record<string, unknown> = {}): void {
  c.executionCtx.waitUntil(
    c
      .get("dir")
      .audit({ actorId: caller.id, actorLogin: caller.login, onBehalfOf: caller.onBehalfOf, action, target: `${repo.owner_login}/${repo.name}`, detail: { ...detail, via: "api" } })
      .catch((e) => console.error("audit failed", e)),
  );
}

/** Secrets and Actions variables are managed by people only. */
export function refuseAgent(caller: Caller, what = "secrets and variables"): void {
  if (caller.kind === "agent") throw new HttpError(403, `agents cannot manage ${what}`);
}

/** API clients get GitHub's JSON 404 for unknown paths, never the HTML page. */
export function apiNotFound(): Response {
  return new Response(JSON.stringify({ message: "Not Found", documentation_url: GITHUB_DOCS }), { status: 404, headers: { "content-type": "application/json" } });
}

/**
 * Records a 5xx answer for site administrators (lib/server-errors.ts) and returns the request id
 * the answer reports, so a failure seen in a client or CI log can be looked up.
 */
export function noteServerError(c: AppContext, e: unknown, status: number): string {
  const id = requestId(c.req.raw);
  let route: string | null = null;
  try {
    route = c.req.routePath;
  } catch {
    // No route matched.
  }
  const saved = recordServerError(c.env, errorRecord(e, { id, method: c.req.method, route, path: c.req.path, status }));
  try {
    c.executionCtx.waitUntil(saved);
  } catch {
    // No execution context (tests): the write runs on its own.
  }
  return id;
}

export function errorResponse(e: unknown, c?: AppContext): Response {
  const json = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    if (status >= 500 && c) {
      const id = noteServerError(c, e, status);
      body = { ...body, request_id: id };
      headers = { ...headers, "x-request-id": id };
    }
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  if (e instanceof HttpError) {
    const headers: Record<string, string> = {};
    // MCP clients learn from /mcp's challenge where to sign in with OAuth (auth/oauth.ts); git and curl get Basic.
    if (e.status === 401) headers["www-authenticate"] = c && c.req.path === "/mcp" ? mcpChallenge(c.env, c.get("principal")?.type === "anonymous" ? undefined : "invalid_token") : 'Basic realm="Diffinery", charset="UTF-8"';
    // GitHub's answer for a renamed or transferred repository: the new URL in Location and in the body.
    if (e instanceof RepoMoved) return json(e.status, { message: e.detail, url: e.location, documentation_url: GITHUB_DOCS }, { ...headers, location: e.location });
    return json(e.status, { message: e.detail, documentation_url: GITHUB_DOCS, ...e.extra }, headers);
  }
  // Errors thrown inside Durable Objects arrive as plain Errors; recover HttpError-like status when present.
  const msg = (e as Error)?.message ?? String(e);
  const remote = /^(\d{3}):/.exec(msg);
  if (remote) return json(Number(remote[1]), { message: msg.slice(5), documentation_url: GITHUB_DOCS });
  console.error(e);
  return json(500, { message: "internal error" });
}
