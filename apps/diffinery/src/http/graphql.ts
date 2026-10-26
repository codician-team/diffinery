/**
 * GitHub's GraphQL API at /api/graphql, read-only, for the schema in ./graphql-schema.ts.
 *
 * Why: the GitHub CLI treats any host other than github.com as GitHub Enterprise Server and talks
 * to it at https://<host>/api/v3 (REST) and https://<host>/api/graphql. Claude Code builds its pull
 * request badge and CI status on exactly those calls (the open pull request for the current branch
 * over REST, its review decision and check counts over GraphQL, and `gh pr view --json
 * statusCheckRollup`), so with this endpoint a Diffinery repository gets the same pull request and
 * CI chip a GitHub one does. See /docs/api/graphql.
 *
 * The same endpoint answers the GitHub CLI's issue commands (`gh issue list`, `view`, `create`,
 * `comment`, `close`, `reopen`, `edit`, `status`), and a workflow's GITHUB_TOKEN may use it with the
 * same per-scope `permissions:` it has over REST.
 *
 * Execution is lenient where GitHub is strict: a field Diffinery doesn't have is left out of the
 * answer (and named in `extensions.unsupported`) instead of failing the whole query, because gh
 * asks for many fields at once and most commands need only a few of them.
 */
import { Hono } from "hono";
import {
  buildSchema,
  execute,
  FieldsOnCorrectTypeRule,
  GraphQLError,
  KnownArgumentNamesRule,
  Kind,
  KnownTypeNamesRule,
  OverlappingFieldsCanBeMergedRule,
  parse,
  PossibleFragmentSpreadsRule,
  specifiedRules,
  validate,
  type DocumentNode,
  type GraphQLSchema,
  type SelectionSetNode,
} from "graphql";
import type { Env } from "../env.js";
import type { AppContext, AppVars } from "../auth/principal.js";
import type { Account, Repo } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { denied, type JobPermissions, type PermissionScope, type Requirement } from "../lib/job-permissions.js";
import { isAppCaller } from "../repo/token-policy.js";
import { overLimit, RATE_LIMITS } from "../lib/rate-limit.js";
import { atLeast, type Caller, type Role } from "../repo/types.js";
import type { Check, Issue, Review } from "../repo/collab.js";
import type { CommitStatus } from "../repo/statuses.js";
import { hiddenAuthors, loadRepo, repoStub } from "./common.js";
import { baseOf, nodeId, numericId, repoHtml } from "./gh.js";
import { SCHEMA_SDL } from "./graphql-schema.js";
import { apiRootJson } from "./api.js";

export const graphql = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** Limits on one request, so a query can't make the Worker walk the whole site. */
export const LIMITS = { queryBytes: 64 * 1024, depth: 16, fields: 2000, pageSize: 100, repositories: 25 };

let built: GraphQLSchema | null = null;
export const schema = (): GraphQLSchema => (built ??= buildSchema(SCHEMA_SDL));

/**
 * Validation rules: GitHub's, less those that reject what Diffinery's smaller schema doesn't have
 * (fields, arguments, and types such as `... on Team` that gh asks for on GitHub's union types), and
 * the overlap rule, which GitHub itself doesn't hold gh's queries to (User.name and Team.name differ in nullability).
 */
const LENIENT = new Set([FieldsOnCorrectTypeRule, KnownArgumentNamesRule, KnownTypeNamesRule, PossibleFragmentSpreadsRule, OverlappingFieldsCanBeMergedRule]);
const RULES = specifiedRules.filter((r) => !LENIENT.has(r));

type Stub = ReturnType<typeof repoStub>;
type Obj = Record<string, unknown>;
type Args = Record<string, unknown>;

/** Per-request state: the request, and lookups shared by every field that needs them. */
interface Ctx {
  c: AppContext;
  base: string;
  memo: Map<string, Promise<unknown>>;
  repos: number;
}

const once = <T>(ctx: Ctx, key: string, f: () => Promise<T>): Promise<T> => {
  let p = ctx.memo.get(key) as Promise<T> | undefined;
  if (!p) {
    p = f();
    ctx.memo.set(key, p);
  }
  return p;
};

/** GitHub's NOT_FOUND error (gh reads `type`), for a repository or pull request that isn't there or isn't visible. */
const notFound = (message: string) => new GraphQLError(message, { extensions: { type: "NOT_FOUND" } });

/** A Durable Object error ("404: ...") or an HttpError as its status and message. */
function statusOf(e: unknown): { status: number; message: string } | null {
  if (e instanceof HttpError) return { status: e.status, message: e.detail };
  const m = /^(\d{3}): ([\s\S]*)$/.exec((e as Error)?.message ?? "");
  return m ? { status: Number(m[1]), message: m[2]! } : null;
}

// ---------------------------------------------------------------- connections

const cursorOf = (i: number) => btoa(`cursor:${i}`);
function offsetOf(cursor: unknown): number {
  if (typeof cursor !== "string" || !cursor) return -1;
  try {
    const m = /^cursor:(\d+)$/.exec(atob(cursor));
    if (m) return Number(m[1]);
  } catch {
    // fall through
  }
  throw new GraphQLError(`"${cursor}" does not appear to be a valid cursor.`, { extensions: { type: "INVALID_CURSOR_ARGUMENTS" } });
}

function pageSize(args: Args): void {
  for (const k of ["first", "last"] as const) {
    const n = args[k];
    if (n === undefined || n === null) continue;
    if (typeof n !== "number" || n < 0) throw new GraphQLError(`"${k}" on a connection cannot be less than zero.`);
    if (n > LIMITS.pageSize) throw new GraphQLError(`Requesting ${n} records on the connection exceeds the "${k}" limit of ${LIMITS.pageSize} records.`, { extensions: { type: "EXCESSIVE_PAGINATION" } });
  }
}

/** first/last/after/before over a list already in memory. */
function connection<T>(all: T[], args: Args, extra: Obj = {}) {
  pageSize(args);
  let start = 0;
  let end = all.length;
  const after = offsetOf(args.after);
  const before = offsetOf(args.before);
  if (after >= 0) start = Math.min(after + 1, end);
  if (before >= 0) end = Math.max(Math.min(before, end), start);
  if (typeof args.first === "number") end = Math.min(end, start + args.first);
  if (typeof args.last === "number") start = Math.max(start, end - args.last);
  const slice = all.slice(start, end);
  return {
    totalCount: all.length,
    nodes: slice,
    edges: slice.map((node, i) => ({ node, cursor: cursorOf(start + i) })),
    pageInfo: { hasNextPage: end < all.length, hasPreviousPage: start > 0, startCursor: slice.length ? cursorOf(start) : null, endCursor: slice.length ? cursorOf(end - 1) : null },
    ...extra,
  };
}

type Page<T> = { items: T[]; total: number };

/**
 * first/last/after/before over a list the repository pages itself (`fetch(limit, offset)`), so a
 * connection over thousands of issues reads only the page asked for. The total is read first only
 * when `last` or `before` needs it.
 */
async function pagedConnection<T>(args: Args, fetch: (limit: number, offset: number) => Promise<Page<T>>, map: (x: T) => Obj): Promise<Obj> {
  pageSize(args);
  const after = offsetOf(args.after);
  const before = offsetOf(args.before);
  const first = typeof args.first === "number" ? args.first : null;
  const last = typeof args.last === "number" ? args.last : null;
  let start = after >= 0 ? after + 1 : 0;
  let total: number | null = null;
  if (last !== null || before >= 0) total = (await fetch(0, 0)).total;
  let end = total ?? Number.MAX_SAFE_INTEGER;
  if (before >= 0) end = Math.max(Math.min(before, end), start);
  if (first !== null) end = Math.min(end, start + first);
  if (last !== null) start = Math.max(start, end - last);
  if (first === null && last === null) end = Math.min(end, start + LIMITS.pageSize);
  const page = end > start ? await fetch(end - start, start) : { items: [] as T[], total: total ?? (await fetch(0, 0)).total };
  total = page.total;
  const slice = page.items.slice(0, Math.max(0, end - start));
  const nodes = slice.map(map);
  return {
    totalCount: total,
    nodes,
    edges: nodes.map((node, i) => ({ node, cursor: cursorOf(start + i) })),
    pageInfo: { hasNextPage: start + slice.length < total, hasPreviousPage: start > 0, startCursor: slice.length ? cursorOf(start) : null, endCursor: slice.length ? cursorOf(start + slice.length - 1) : null },
  };
}

/** Every match, a page at a time (the repository answers at most 100 per call), up to GitHub's 1,000 search results. */
async function everyIssue(stub: Stub, opts: Parameters<Stub["issues"]>[0]): Promise<Issue[]> {
  const out: Issue[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const res = await stub.issues({ ...opts, limit: 100, offset });
    out.push(...res.items);
    if (res.items.length < 100 || out.length >= res.total) break;
  }
  return out;
}

// ---------------------------------------------------------------- people

type Person = { id: string; login: string; kind?: string | null; name?: string | null };

function actor(ctx: Ctx, u: Person | null | undefined): Obj | null {
  if (!u) return null;
  if (u.kind === "github" || u.login.startsWith("github:")) {
    const login = u.login.replace(/^github:/, "");
    return { __typename: "Mannequin", id: nodeId("Mannequin", u.id), login: `github:${login}`, url: `https://github.com/${encodeURIComponent(login)}`, resourcePath: `/${login}`, avatarUrl: () => `${ctx.base}/api/avatars/${encodeURIComponent(login)}` };
  }
  const typename = u.kind === "org" ? "Organization" : u.kind === "agent" || u.kind === "system" ? "Bot" : "User";
  return {
    __typename: typename,
    id: nodeId(typename, u.id),
    databaseId: numericId(u.id),
    login: u.login,
    name: u.name ?? null,
    email: "",
    isBot: typename === "Bot",
    url: `${ctx.base}/${u.login}`,
    resourcePath: `/${u.login}`,
    avatarUrl: () => `${ctx.base}/api/avatars/${encodeURIComponent(u.login)}`,
  };
}

/** An account as a GraphQL User (review requests and assignees are always people). */
const userByLogin = (ctx: Ctx, login: string): Obj => ({ ...actor(ctx, { id: login, login, kind: "user" }), __typename: "User" });

/** Reactions aren't counted here yet: an empty list, which GitHub clients show as no reactions. */
const NO_REACTIONS: Obj[] = [];

// ---------------------------------------------------------------- repositories

const PERMISSION: Record<Role, string> = { admin: "ADMIN", maintain: "MAINTAIN", write: "WRITE", triage: "TRIAGE", read: "READ" };

type Loaded = { repo: Repo; caller: Caller; stub: Stub };

/**
 * A workflow job's or an app's token reads through GraphQL only what its permissions let it read
 * over REST: the repository itself always, pull requests with pull-requests, issues with issues.
 * Anyone may read a public repository's. (Changes are checked as each repository is loaded for
 * one: see loadForWrite.)
 */
function need(l: Loaded, scopes: PermissionScope[]): void {
  if (!l.caller.permissions || l.repo.visibility === "public") return;
  const reason = denied(l.caller.permissions as JobPermissions, { scopes, access: "read" }, isAppCaller(l.caller) ? "app" : "job");
  if (reason) throw new GraphQLError(reason, { extensions: { type: "FORBIDDEN" } });
}

const writes = (...scopes: PermissionScope[]): Requirement => ({ scopes, access: "write" });

async function loadRepository(ctx: Ctx, owner: string, name: string): Promise<Loaded | null> {
  return once(ctx, `repo:${owner.toLowerCase()}/${name.toLowerCase()}`, async () => {
    if (++ctx.repos > LIMITS.repositories) throw new GraphQLError(`A query can look up at most ${LIMITS.repositories} repositories.`, { extensions: { type: "MAX_NODE_LIMIT_EXCEEDED" } });
    try {
      // The repository's metadata: what any job token may read about its own repository.
      const { repo, caller, stub } = await loadRepo(ctx.c, owner, name, "read", { follow: true, permission: { metadata: true } });
      return { repo, caller, stub };
    } catch (e) {
      const s = statusOf(e);
      if (s && (s.status === 404 || s.status === 403 || s.status === 401)) return null;
      throw e;
    }
  });
}

/** Who can be assigned or asked for a review: the owner or the organization's members, and collaborators. */
async function people(ctx: Ctx, l: Loaded, query: unknown): Promise<Obj[]> {
  const dir = ctx.c.get("dir");
  const all = await once(ctx, `people:${l.repo.id}`, async () => {
    const found = new Map<string, Account>();
    if (l.repo.owner_kind === "org") for (const m of await dir.orgMembers(l.repo.owner_id)) found.set(m.id, m);
    else {
      const owner = await dir.account(l.repo.owner_id);
      if (owner) found.set(owner.id, owner);
    }
    for (const x of await dir.collaborators(l.repo.id)) found.set(x.account.id, x.account);
    return [...found.values()].filter((a) => a.status === "active" && a.kind !== "org").sort((a, b) => a.login.localeCompare(b.login));
  });
  const q = typeof query === "string" ? query.toLowerCase() : "";
  return all.filter((a) => !q || a.login.toLowerCase().includes(q) || (a.name ?? "").toLowerCase().includes(q)).map((a) => ({ ...actor(ctx, a), __typename: "User" }));
}

const labelObj = (l: Loaded, name: string, row?: { color?: string; description?: string | null }): Obj => ({
  __typename: "Label",
  id: nodeId("Label", `${l.repo.owner_login}/${l.repo.name}/${name}`),
  name,
  color: row?.color ?? "ededed",
  description: row?.description ?? null,
});

const milestoneObj = (l: Loaded, m: { number: number; title: string; state: string; dueOn?: string | null; description?: string | null }): Obj => ({
  __typename: "Milestone",
  id: nodeId("Milestone", `${l.repo.id}/${m.number}`),
  number: m.number,
  title: m.title,
  state: m.state.toUpperCase(),
  dueOn: m.dueOn ?? null,
  description: m.description ?? null,
});

function repository(ctx: Ctx, l: Loaded): Obj {
  const { repo, caller, stub } = l;
  const html = repoHtml(ctx.base, repo.owner_login, repo.name);
  const self = (): Obj => repository(ctx, l);
  return {
    __typename: "Repository",
    id: nodeId("Repository", repo.id),
    databaseId: numericId(repo.id),
    name: repo.name,
    nameWithOwner: `${repo.owner_login}/${repo.name}`,
    owner: actor(ctx, { id: repo.owner_id, login: repo.owner_login, kind: repo.owner_kind }),
    url: html,
    resourcePath: `/${repo.owner_login}/${repo.name}`,
    sshUrl: `${html}.git`,
    description: repo.description || null,
    homepageUrl: repo.homepage || null,
    isPrivate: repo.visibility !== "public",
    visibility: repo.visibility === "public" ? "PUBLIC" : "PRIVATE",
    isArchived: !!repo.archived,
    isFork: false,
    isMirror: false,
    isTemplate: false,
    isLocked: false,
    isInOrganization: repo.owner_kind === "org",
    isEmpty: () => defaultHead(ctx, l).then((sha) => !sha),
    hasIssuesEnabled: true,
    hasWikiEnabled: false,
    hasProjectsEnabled: false,
    hasDiscussionsEnabled: false,
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true,
    deleteBranchOnMerge: false,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    pushedAt: repo.pushed_at,
    parent: null,
    viewerPermission: caller.role ? PERMISSION[caller.role] : null,
    viewerCanAdminister: caller.role === "admin",
    defaultBranchRef: async () => {
      const sha = await defaultHead(ctx, l);
      return sha ? { __typename: "Ref", id: nodeId("Ref", `${repo.id}/refs/heads/${repo.default_branch}`), name: repo.default_branch, prefix: "refs/heads/", target: commit(ctx, l, sha) } : null;
    },
    assignableUsers: async (args: Args) => connection(await people(ctx, l, args.query), args),
    mentionableUsers: async (args: Args) => connection(await people(ctx, l, args.query), args),
    labels: async (args: Args) => {
      need(l, ["issues", "pull-requests"]);
      const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
      const rows = await once(ctx, `labels:${repo.id}`, () => stub.labelRows());
      return connection(rows.filter((r) => !q || r.name.toLowerCase().includes(q)).map((r) => labelObj(l, r.name, r)), args);
    },
    label: async (args: Args) => {
      need(l, ["issues", "pull-requests"]);
      const rows = await once(ctx, `labels:${repo.id}`, () => stub.labelRows());
      const r = rows.find((x) => x.name.toLowerCase() === String(args.name).toLowerCase());
      return r ? labelObj(l, r.name, r) : null;
    },
    milestones: async (args: Args) => {
      need(l, ["issues", "pull-requests"]);
      const states = Array.isArray(args.states) ? (args.states as string[]) : [];
      const list = await stub.milestones(states.length === 1 ? (states[0] === "CLOSED" ? "closed" : "open") : "all");
      return connection(list.map((m) => milestoneObj(l, m)), args);
    },
    pullRequest: async (args: Args) => {
      need(l, ["pull-requests"]);
      const n = args.number as number;
      const issue = await issueOrNull(ctx, l, n);
      if (!issue || issue.kind !== "pull") throw notFound(`Could not resolve to a PullRequest with the number of ${n}.`);
      return pullRequest(ctx, l, issue, self);
    },
    issue: async (args: Args) => {
      need(l, ["issues"]);
      const n = args.number as number;
      const issue = await issueOrNull(ctx, l, n);
      if (!issue || issue.kind !== "issue") throw notFound(`Could not resolve to an Issue with the number of ${n}.`);
      return issueObj(ctx, l, issue, self);
    },
    issueOrPullRequest: async (args: Args) => {
      const n = args.number as number;
      const issue = await issueOrNull(ctx, l, n);
      if (!issue) throw notFound(`Could not resolve to an issue or pull request with the number of ${n}.`);
      need(l, [issue.kind === "pull" ? "pull-requests" : "issues"]);
      return issue.kind === "pull" ? pullRequest(ctx, l, issue, self) : issueObj(ctx, l, issue, self);
    },
    issues: async (args: Args) => {
      need(l, ["issues"]);
      const opts = await issueFilters(ctx, l, args);
      if (!opts) return pagedConnection(args, async () => ({ items: [], total: 0 }), () => ({}));
      const hide = await hiddenAuthors(ctx.c);
      return pagedConnection(
        args,
        (limit, offset) => stub.issues({ ...opts, kind: "issue", limit, offset, hide }),
        (i) => {
          ctx.memo.set(`issue:${repo.id}:${i.number}`, Promise.resolve(i));
          return issueObj(ctx, l, i, self);
        },
      );
    },
    pullRequests: async (args: Args) => {
      need(l, ["pull-requests"]);
      pageSize(args);
      const states = (args.states as string[] | null | undefined) ?? [];
      const want = new Set(states);
      const state = !want.size || (want.has("OPEN") && (want.has("CLOSED") || want.has("MERGED"))) ? "all" : want.has("OPEN") ? "open" : "closed";
      const labels = Array.isArray(args.labels) && args.labels.length ? (args.labels as string[]) : undefined;
      const order = args.orderBy as { field?: string; direction?: string } | undefined;
      const sort = order?.field === "UPDATED_AT" ? "updated" : order?.field === "COMMENTS" ? "comments" : "created";
      // GitHub lists oldest first unless asked otherwise.
      const direction = order?.direction === "DESC" ? "desc" : "asc";
      let items = await everyIssue(stub, { kind: "pull", state, head: (args.headRefName as string) || undefined, base: (args.baseRefName as string) || undefined, labels, sort, direction, hide: await hiddenAuthors(ctx.c) });
      // "closed" holds both closed and merged pull requests: keep only the states asked for.
      if (want.size && state !== "all") items = items.filter((i) => want.has(pullState(i)));
      else if (want.size && !(want.has("CLOSED") && want.has("MERGED"))) items = items.filter((i) => want.has(pullState(i)));
      for (const i of items) ctx.memo.set(`issue:${repo.id}:${i.number}`, Promise.resolve(i));
      return connection(
        items.map((i) => pullRequest(ctx, l, i, self)),
        args,
      );
    },
  };
}

const defaultHead = (ctx: Ctx, l: Loaded) => once(ctx, `head:${l.repo.id}`, () => l.stub.resolve(l.repo.default_branch).catch(() => null));

const issueOf = (ctx: Ctx, l: Loaded, n: number): Promise<Issue> =>
  once(ctx, `issue:${l.repo.id}:${n}`, async () => (await l.stub.issue(n, await hiddenAuthors(ctx.c))).issue);

const issueOrNull = (ctx: Ctx, l: Loaded, n: number): Promise<Issue | null> =>
  issueOf(ctx, l, n).catch((e) => {
    if (statusOf(e)?.status === 404) return null;
    throw e;
  });

const pullState = (i: Issue): string => (i.pull?.merged ? "MERGED" : i.state === "open" ? "OPEN" : "CLOSED");

/**
 * Repository.issues' arguments as the repository's own list filters, or null when they can match
 * nothing (a milestone or person that isn't there). `states`, `labels` (any of them, as on GitHub),
 * `orderBy` and `filterBy` (assignee, createdBy, mentioned, labels, milestoneNumber, since, states).
 */
async function issueFilters(ctx: Ctx, l: Loaded, args: Args): Promise<Parameters<Stub["issues"]>[0] | null> {
  const f = (args.filterBy ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  const states = new Set(list(args.states).length ? list(args.states) : list(f.states));
  const state = states.size === 1 ? (states.has("OPEN") ? "open" : "closed") : "all";
  const anyLabels = [...new Set([...list(args.labels), ...list(f.labels)])];
  const order = args.orderBy as { field?: string; direction?: string } | undefined;
  const sort = order?.field === "UPDATED_AT" ? "updated" : order?.field === "COMMENTS" ? "comments" : "created";
  // As GitHub: oldest first unless asked otherwise.
  const direction = order?.direction === "DESC" ? "desc" : "asc";
  const me = ctx.c.get("principal");
  const who = (v: unknown) => (typeof v === "string" && v === "@me" && me.type === "account" ? me.account.login : v);
  // assignee: a login, "*" for anyone, null for no one (as on GitHub).
  const assignee = f.assignee === null ? "none" : typeof f.assignee === "string" ? String(who(f.assignee)) : undefined;
  // milestoneNumber: a number, "*" for any, null for none. `milestone` is GitHub's older name for it.
  const m = f.milestoneNumber !== undefined ? f.milestoneNumber : f.milestone;
  let milestone: number | "none" | "*" | undefined;
  if (m === null || m === "none") milestone = "none";
  else if (m === "*") milestone = "*";
  else if (typeof m === "string" && /^\d+$/.test(m)) milestone = Number(m);
  else if (typeof m === "string") {
    // A title, as `gh issue list --milestone` passes when it can.
    const found = (await l.stub.milestones("all")).find((x) => x.title === m);
    if (!found) return null;
    milestone = found.number;
  }
  const mentioned = typeof f.mentioned === "string" ? String(who(f.mentioned)) : undefined;
  return {
    state,
    anyLabels: anyLabels.length ? anyLabels : undefined,
    author: typeof f.createdBy === "string" ? String(who(f.createdBy)) : undefined,
    assignee,
    mentioned,
    milestone,
    since: typeof f.since === "string" ? f.since : undefined,
    sort,
    direction,
  };
}

// ---------------------------------------------------------------- issues and pull requests

type CommentRow = { id: string; author: Person; body: string; createdAt: string; reviewId?: string | null; minimized?: { reason: string } | string | null };
type Full = { issue: Issue; comments: CommentRow[]; reviews: Review[] };

const association = (l: Loaded, login: string) => (login.toLowerCase() === l.repo.owner_login.toLowerCase() ? "OWNER" : "NONE");

/** An issue's or pull request's conversation comments (review comments belong to their reviews). */
function commentConnection(ctx: Ctx, l: Loaded, url: string, full: Full, args: Args): Obj {
  return connection(
    full.comments
      .filter((cm) => !cm.reviewId)
      .map((cm) => {
        const minimized = typeof cm.minimized === "string" ? cm.minimized : (cm.minimized?.reason ?? null);
        return { __typename: "IssueComment", id: nodeId("IssueComment", `${l.repo.id}/${cm.id}`), author: actor(ctx, cm.author), authorAssociation: association(l, cm.author.login), body: cm.body, createdAt: cm.createdAt, url: `${url}#issuecomment-${cm.id}`, includesCreatedEdit: false, isMinimized: !!minimized, minimizedReason: minimized, reactionGroups: NO_REACTIONS, viewerDidAuthor: viewerId(ctx) === cm.author.id };
      }),
    args,
  );
}

const STATE_REASONS: Record<string, string> = { completed: "COMPLETED", not_planned: "NOT_PLANNED", reopened: "REOPENED", duplicate: "DUPLICATE" };

function issueObj(ctx: Ctx, l: Loaded, i: Issue, repoObj: () => Obj): Obj {
  const { repo, stub, caller } = l;
  const url = `${repoHtml(ctx.base, repo.owner_login, repo.name)}/issues/${i.number}`;
  const full = () => once(ctx, `full:${repo.id}:${i.number}`, async () => stub.issue(i.number, await hiddenAuthors(ctx.c))) as Promise<Full>;
  return {
    __typename: "Issue",
    id: nodeId("Issue", `${repo.id}/${i.number}`),
    databaseId: i.number,
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    url,
    resourcePath: `/${repo.owner_login}/${repo.name}/issues/${i.number}`,
    state: i.state === "open" ? "OPEN" : "CLOSED",
    stateReason: i.stateReason ? (STATE_REASONS[i.stateReason] ?? null) : null,
    closed: i.state === "closed",
    closedAt: i.closedAt,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    locked: i.locked,
    author: actor(ctx, i.author),
    authorAssociation: association(l, i.author.login),
    viewerCanUpdate: atLeast(caller.role, "triage") || viewerId(ctx) === i.author.id,
    reactionGroups: NO_REACTIONS,
    projectItems: (args: Args) => connection([], args),
    repository: repoObj,
    milestone: i.milestone ? milestoneObj(l, { ...i.milestone, description: null }) : null,
    labels: async (args: Args) => {
      const rows = await once(ctx, `labels:${repo.id}`, () => stub.labelRows());
      const byName = new Map(rows.map((r) => [r.name, r]));
      return connection(
        i.labels.map((name) => labelObj(l, name, byName.get(name))),
        args,
      );
    },
    assignees: (args: Args) => connection(i.assignees.map((login) => userByLogin(ctx, login)), args),
    comments: async (args: Args) => commentConnection(ctx, l, url, await full(), args),
  };
}

function pullRequest(ctx: Ctx, l: Loaded, i: Issue, repoObj: () => Obj): Obj {
  const { repo, stub, caller } = l;
  const p = i.pull!;
  const html = repoHtml(ctx.base, repo.owner_login, repo.name);
  const url = `${html}/pull/${i.number}`;
  const key = `${repo.id}:${i.number}`;
  const full = () => once(ctx, `full:${key}`, () => stub.issue(i.number, [])) as Promise<Full>;
  const stats = () => once(ctx, `stats:${key}`, () => stub.pullStats(i.number));
  const review = () => once(ctx, `review:${key}`, () => stub.reviewState(i.number));
  const merge = () => once(ctx, `merge:${key}`, () => stub.mergeability(i.number, caller));
  const head = () => commit(ctx, l, p.headSha, { pullNumber: i.number, review });
  const ref = (name: string, oid: string | null): Obj | null =>
    oid === null
      ? null
      : {
          __typename: "Ref",
          id: nodeId("Ref", `${repo.id}/refs/heads/${name}`),
          name,
          prefix: "refs/heads/",
          target: () => commit(ctx, l, oid),
          branchProtectionRule: async () => {
            if (name !== p.base) return null;
            const rules = (await review()).protection;
            if (!rules) return null;
            const required = (await review()).requiredChecks;
            return { __typename: "BranchProtectionRule", id: nodeId("BranchProtectionRule", `${repo.id}/${name}`), pattern: name, requiredApprovingReviewCount: rules.requiredApprovals, requiresApprovingReviews: rules.requiredApprovals > 0, requiredStatusCheckContexts: required, requiresStatusChecks: required.length > 0, requiresStrictStatusChecks: false, requiresLinearHistory: rules.linearHistory };
          },
        };
  const assoc = (login: string) => association(l, login);
  const reviewObj = (r: Review): Obj => ({ __typename: "PullRequestReview", id: nodeId("PullRequestReview", `${repo.id}/${r.id}`), author: actor(ctx, r.author), authorAssociation: assoc(r.author.login), body: r.body, includesCreatedEdit: false, reactionGroups: NO_REACTIONS, state: r.state, submittedAt: r.submittedAt, commit: r.commitId ? commit(ctx, l, r.commitId) : null });
  return {
    __typename: "PullRequest",
    id: nodeId("PullRequest", `${repo.id}/${i.number}`),
    databaseId: i.number,
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    url,
    permalink: url,
    resourcePath: `/${repo.owner_login}/${repo.name}/pull/${i.number}`,
    state: pullState(i),
    isDraft: p.draft,
    closed: i.state === "closed",
    merged: p.merged,
    mergedAt: p.mergedAt,
    mergedBy: p.mergedBy ? actor(ctx, { id: p.mergedBy, login: p.mergedBy }) : null,
    closedAt: i.closedAt,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    locked: i.locked,
    author: actor(ctx, i.author),
    authorAssociation: assoc(i.author.login),
    headRefName: p.head,
    headRefOid: p.headSha,
    baseRefName: p.base,
    baseRef: async () => ref(p.base, await stub.resolve(p.base).catch(() => null)),
    headRef: () => (p.merged || i.state === "closed" ? null : ref(p.head, p.headSha)),
    reactionGroups: NO_REACTIONS,
    projectItems: (args: Args) => connection([], args),
    baseRefOid: async () => (await stub.resolve(p.base).catch(() => null)) ?? "",
    repository: repoObj,
    baseRepository: repoObj,
    headRepository: repoObj,
    headRepositoryOwner: actor(ctx, { id: repo.owner_id, login: repo.owner_login, kind: repo.owner_kind }),
    isCrossRepository: false,
    maintainerCanModify: false,
    mergeCommit: p.mergeCommit ? commit(ctx, l, p.mergeCommit) : null,
    additions: async () => (await stats()).additions,
    deletions: async () => (await stats()).deletions,
    changedFiles: async () => (await stats()).changedFiles,
    reviewDecision: async () => (await review()).decision,
    mergeable: async () => {
      if (i.state !== "open") return "UNKNOWN";
      return (await merge()).conflicts.length ? "CONFLICTING" : "MERGEABLE";
    },
    mergeStateStatus: async () => {
      if (i.state !== "open") return "UNKNOWN";
      const m = await merge();
      // GitHub's UNSTABLE: nothing blocks the merge, but a check that is not required is failing or still running.
      if (m.state === "clean" && m.checks.some((ch: { state: string }) => !["success", "neutral", "skipped"].includes(ch.state))) return "UNSTABLE";
      return { clean: "CLEAN", blocked: "BLOCKED", conflicting: "DIRTY", behind: "BEHIND", draft: "DRAFT" }[m.state as string] ?? "UNKNOWN";
    },
    statusCheckRollup: () => (head().statusCheckRollup as () => Promise<unknown>)(),
    commits: async (args: Args) => {
      pageSize(args);
      // The head commit alone (`commits(last: 1)`, which Claude Code and gh ask for on every poll) needs no history walk.
      if (args.last === 1 && !args.first && !args.after && !args.before) {
        const node = { __typename: "PullRequestCommit", id: nodeId("PullRequestCommit", `${repo.id}/${p.headSha}`), url: `${url}/commits/${p.headSha}`, commit: head() };
        return {
          nodes: [node],
          edges: [{ node, cursor: "head" }],
          totalCount: async () => (await once(ctx, `commits:${key}`, () => stub.pullCommits(i.number))).length,
          pageInfo: { hasNextPage: false, hasPreviousPage: true, startCursor: "head", endCursor: "head" },
        };
      }
      const list = await once(ctx, `commits:${key}`, () => stub.pullCommits(i.number));
      return connection(
        list.map((cm) => ({ __typename: "PullRequestCommit", id: nodeId("PullRequestCommit", `${repo.id}/${cm.sha}`), url: `${url}/commits/${cm.sha}`, commit: commit(ctx, l, cm.sha, cm.sha === p.headSha ? { pullNumber: i.number, review } : {}, cm) })),
        args,
      );
    },
    labels: async (args: Args) => {
      const rows = await once(ctx, `labels:${repo.id}`, () => stub.labelRows());
      const byName = new Map(rows.map((r) => [r.name, r]));
      return connection(
        i.labels.map((name) => labelObj(l, name, byName.get(name))),
        args,
      );
    },
    assignees: (args: Args) => connection(i.assignees.map((login) => userByLogin(ctx, login)), args),
    reviewRequests: (args: Args) => connection(p.requestedReviewers.map((login) => ({ requestedReviewer: userByLogin(ctx, login) })), args),
    reviews: async (args: Args) => {
      const states = Array.isArray(args.states) && args.states.length ? new Set(args.states as string[]) : null;
      return connection((await full()).reviews.filter((r) => !states || states.has(r.state)).map(reviewObj), args);
    },
    latestReviews: async (args: Args) => {
      const latest = new Map<string, Review>();
      for (const r of (await full()).reviews) if (r.state !== "COMMENTED" || !latest.has(r.author.id)) latest.set(r.author.id, r);
      return connection([...latest.values()].map(reviewObj), args);
    },
    comments: async (args: Args) => commentConnection(ctx, l, url, await full(), args),
    files: async (args: Args) => {
      const res = await once(ctx, `files:${key}`, () => stub.pullFiles(i.number));
      const change: Record<string, string> = { added: "ADDED", deleted: "DELETED", modified: "MODIFIED" };
      return connection(
        res.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, changeType: change[f.status as string] ?? "CHANGED" })),
        args,
      );
    },
    milestone: i.milestone ? milestoneObj(l, { ...i.milestone, description: null }) : null,
    autoMergeRequest: p.autoMerge
      ? { authorEmail: null, enabledAt: p.autoMerge.enabledAt, enabledBy: actor(ctx, p.autoMerge.enabledBy as Person), mergeMethod: p.autoMerge.method.toUpperCase(), commitHeadline: p.autoMerge.commitTitle ?? null, commitBody: p.autoMerge.commitMessage ?? null }
      : null,
  };
}

// ---------------------------------------------------------------- commits and checks

type CommitOpts = { pullNumber?: number; review?: () => Promise<{ requiredChecks: string[] }> };
type CommitLike = { sha: string; message: string; author: { name: string; email: string; date?: string; time?: number }; committer: { name: string; email: string; date?: string; time?: number } };

function commit(ctx: Ctx, l: Loaded, oid: string, opts: CommitOpts = {}, known?: CommitLike): Obj {
  const { repo, stub } = l;
  const html = repoHtml(ctx.base, repo.owner_login, repo.name);
  const info = () => (known ? Promise.resolve(known) : (once(ctx, `commit:${repo.id}:${oid}`, () => stub.commitInfo(oid)) as Promise<CommitLike>));
  const signed = (s: CommitLike["author"]) => ({ name: s.name, email: s.email, date: dateOf(s), user: null });
  const message = async () => (await info()).message.replace(/\n+$/, "");
  const rollup = () => once(ctx, `rollup:${repo.id}:${oid}`, async () => {
    const [checks, combined, required] = await Promise.all([stub.checks(oid), stub.combinedStatus(oid), opts.review ? opts.review().then((r) => r.requiredChecks) : Promise.resolve([] as string[])]);
    return { checks, statuses: combined.statuses, required: new Set(required) };
  });
  return {
    __typename: "Commit",
    id: nodeId("Commit", oid),
    oid,
    abbreviatedOid: oid.slice(0, 7),
    url: `${html}/commit/${oid}`,
    commitUrl: `${html}/commit/${oid}`,
    message,
    messageHeadline: async () => (await message()).split("\n")[0]!,
    messageBody: async () => (await message()).split("\n").slice(1).join("\n").replace(/^\n+/, ""),
    authoredDate: async () => dateOf((await info()).author),
    committedDate: async () => dateOf((await info()).committer),
    author: async () => signed((await info()).author),
    authors: async (args: Args) => connection([signed((await info()).author)], args),
    committer: async () => signed((await info()).committer),
    status: async () => {
      const { statuses } = await rollup();
      if (!statuses.length) return null;
      return { __typename: "Status", id: nodeId("Status", `${repo.id}/${oid}`), state: combinedState(statuses.map(statusState)), contexts: statuses.map((s) => statusContext(ctx, s, new Set())) };
    },
    statusCheckRollup: async () => {
      const { checks, statuses, required } = await rollup();
      if (!checks.length && !statuses.length) return null;
      const contexts: Obj[] = [...checks.map((c) => checkRun(ctx, l, c, required)), ...statuses.map((s) => statusContext(ctx, s, required))];
      const runStates = checks.map(checkRunState);
      const statusStates = statuses.map(statusState);
      return {
        __typename: "StatusCheckRollup",
        id: nodeId("StatusCheckRollup", `${repo.id}/${oid}`),
        state: rollupState(runStates, statusStates),
        commit: () => commit(ctx, l, oid, opts, known),
        contexts: (args: Args) =>
          connection(contexts, args, {
            checkRunCount: checks.length,
            checkRunCountsByState: counts(runStates),
            statusContextCount: statuses.length,
            statusContextCountsByState: counts(statusStates),
          }),
      };
    },
  };
}

function dateOf(s: { date?: string; time?: number; timestamp?: number }): string | null {
  if (typeof s.date === "string") return s.date;
  const t = typeof s.time === "number" ? s.time : typeof s.timestamp === "number" ? s.timestamp : null;
  return t === null ? null : new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function counts(states: string[]): Array<{ state: string; count: number }> {
  const m = new Map<string, number>();
  for (const s of states) m.set(s, (m.get(s) ?? 0) + 1);
  return [...m].map(([state, count]) => ({ state, count }));
}

const CONCLUSIONS = new Set(["ACTION_REQUIRED", "TIMED_OUT", "CANCELLED", "FAILURE", "SUCCESS", "NEUTRAL", "SKIPPED", "STARTUP_FAILURE", "STALE"]);
const conclusionOf = (c: Check): string | null => {
  if (c.status !== "completed") return null;
  const v = (c.conclusion ?? "neutral").toUpperCase();
  return CONCLUSIONS.has(v) ? v : "NEUTRAL";
};
const statusOfCheck = (c: Check): string => (c.status === "in_progress" ? "IN_PROGRESS" : c.status === "completed" ? "COMPLETED" : "QUEUED");
/** A check run counted by state as GitHub counts it: its conclusion once complete, its status before. */
const checkRunState = (c: Check): string => conclusionOf(c) ?? statusOfCheck(c);
const statusState = (s: CommitStatus): string => s.state.toUpperCase();

const BAD = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const WAITING = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"]);
function combinedState(states: string[]): string {
  if (states.includes("ERROR")) return "ERROR";
  if (states.some((s) => BAD.has(s))) return "FAILURE";
  if (states.some((s) => WAITING.has(s))) return "PENDING";
  return "SUCCESS";
}
/** GitHub's rollup: failure if anything failed, pending while anything runs, success otherwise. */
const rollupState = (runs: string[], statuses: string[]): string => {
  const s = combinedState([...runs, ...statuses]);
  return s === "ERROR" ? "FAILURE" : s;
};

function checkRun(ctx: Ctx, l: Loaded, c: Check, required: Set<string>): Obj {
  const { repo } = l;
  const html = repoHtml(ctx.base, repo.owner_login, repo.name);
  // Diffinery names an Actions check "<workflow> / <job>"; GitHub keeps the job in `name` and the workflow on the suite.
  const split = c.runId ? /^(.+?) \/ (.+)$/.exec(c.name) : null;
  const workflowName = split?.[1] ?? null;
  const conclusion = conclusionOf(c);
  const status = statusOfCheck(c);
  const runUrl = c.runId ? `${html}/actions/runs/${c.runId}` : null;
  const link = c.detailsUrl ?? runUrl ?? `${html}/commit/${c.sha}`;
  return {
    __typename: "CheckRun",
    id: nodeId("CheckRun", c.id),
    databaseId: c.seq ?? null,
    name: split?.[2] ?? c.name,
    status,
    conclusion,
    startedAt: c.startedAt,
    completedAt: c.completedAt,
    detailsUrl: link,
    url: link,
    permalink: link,
    title: c.output?.title ?? null,
    summary: c.output?.summary ?? null,
    text: null,
    isRequired: () => required.has(c.name),
    checkSuite: {
      id: nodeId("CheckSuite", c.runId ?? `${c.app}/${c.sha}`),
      status,
      conclusion,
      app: { id: nodeId("App", c.app), name: c.app === "diffinery-actions" ? "Diffinery Actions" : c.app, slug: c.app, logoUrl: () => `${ctx.base}/api/avatars/${encodeURIComponent(c.app)}` },
      workflowRun: c.runId
        ? { id: nodeId("WorkflowRun", c.runId), databaseId: null, runNumber: 0, event: "", url: runUrl, workflow: { id: nodeId("Workflow", `${repo.id}/${workflowName}`), name: workflowName ?? "" } }
        : null,
    },
  };
}

function statusContext(ctx: Ctx, s: CommitStatus, required: Set<string>): Obj {
  return {
    __typename: "StatusContext",
    id: nodeId("StatusContext", String(s.id)),
    context: s.context,
    state: statusState(s),
    description: s.description,
    targetUrl: s.targetUrl,
    createdAt: s.createdAt,
    creator: actor(ctx, s.creator as Person),
    avatarUrl: () => (s.creator ? `${ctx.base}/api/avatars/${encodeURIComponent(s.creator.login)}` : null),
    isRequired: () => required.has(s.context),
  };
}

// ---------------------------------------------------------------- the root

const viewerId = (ctx: Ctx): string | null => {
  const p = ctx.c.get("principal");
  return p.type === "account" ? p.account.id : null;
};

/** The type and key a node id (./gh.ts nodeId) was made from, or null for anything else. */
function decodeNodeId(id: string): { type: string; key: string } | null {
  try {
    const padded = id.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((id.length + 3) % 4);
    const m = /^([A-Za-z]+):(.+)$/.exec(new TextDecoder().decode(Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0))));
    return m ? { type: m[1]!, key: m[2]! } : null;
  } catch {
    return null;
  }
}

/** A repository, issue or pull request by node id, with the same access check as a lookup by name. */
async function nodeById(ctx: Ctx, id: string): Promise<Obj | null> {
  const d = decodeNodeId(id);
  if (!d || (d.type !== "Repository" && d.type !== "PullRequest" && d.type !== "Issue")) return null;
  const [repoId, num] = d.type === "Repository" ? [d.key] : d.key.split("/");
  const row = await ctx.c.get("dir").repoById(repoId!);
  if (!row) return null;
  const l = await loadRepository(ctx, row.owner_login, row.name);
  if (!l) return null;
  const repoObj = repository(ctx, l);
  if (d.type === "Repository") return repoObj;
  const issue = await issueOf(ctx, l, Number(num)).catch(() => null);
  if (!issue || issue.kind !== (d.type === "Issue" ? "issue" : "pull")) return null;
  need(l, [issue.kind === "pull" ? "pull-requests" : "issues"]);
  return issue.kind === "pull" ? pullRequest(ctx, l, issue, () => repoObj) : issueObj(ctx, l, issue, () => repoObj);
}

/**
 * GitHub's issue search, in one repository: `repo:` is required, and `is:` (open, closed, merged,
 * issue, pr), `type:`, `state:`, `author:`, `assignee:`, `mentions:`, `label:`, `milestone:`,
 * `no:` (assignee, label, milestone), `head:`, `base:`, `review-requested:`, `draft:` and words
 * (in the title or body) narrow it; `sort:` orders it. GitHub's advanced syntax parses too, for
 * the AND of its terms (gh writes `( words ) qualifiers`).
 */
async function search(ctx: Ctx, args: Args): Promise<Obj> {
  pageSize(args);
  const empty = () => ({ ...connection([], args), issueCount: 0, repositoryCount: 0, userCount: 0 });
  if (args.type !== "ISSUE" && args.type !== "ISSUE_ADVANCED") return empty();
  const q: Record<string, string[]> = {};
  const words: string[] = [];
  for (const m of String(args.query).matchAll(/(-?)(?:([a-z-]+):("[^"]*"|[^\s()]+)|("[^"]*"|[^\s()]+))/g)) {
    if (m[2]) {
      if (!m[1]) (q[m[2]] ??= []).push(m[3]!.replace(/^"|"$/g, ""));
    } else if (!m[1] && m[4] && !/^(AND|OR)$/.test(m[4])) words.push(m[4].replace(/^"|"$/g, "").toLowerCase());
  }
  const viewer = ctx.c.get("principal");
  const me = viewer.type === "account" ? viewer.account.login : "";
  const who = (v: string | undefined) => (v === "@me" ? me : v);
  const [full] = q.repo ?? [];
  if (!full || q.repo!.length > 1) return empty();
  const [owner, name] = full.split("/");
  const l = owner && name ? await loadRepository(ctx, owner, name) : null;
  if (!l) return empty();
  const is = new Set([...(q.is ?? []), ...(q.type ?? [])].map((x) => (x === "pull-request" || x === "pullrequest" ? "pr" : x)));
  const kind = is.has("issue") && !is.has("pr") ? "issue" : is.has("pr") && !is.has("issue") ? "pull" : undefined;
  need(l, kind === "issue" ? ["issues"] : kind === "pull" ? ["pull-requests"] : ["issues", "pull-requests"]);
  const states = new Set([...(q.state ?? []), ...[...is].filter((x) => ["open", "closed", "merged"].includes(x))]);
  const state = states.size === 1 && states.has("open") ? "open" : states.size && !states.has("open") ? "closed" : "all";
  const no = new Set(q.no ?? []);
  let milestone: number | "none" | undefined = no.has("milestone") ? "none" : undefined;
  if (q.milestone?.[0]) {
    const found = (await l.stub.milestones("all")).find((x) => x.title === q.milestone![0]);
    if (!found) return empty();
    milestone = found.number;
  }
  const sortBy = /^(created|updated|comments)(?:-(asc|desc))?$/.exec(q.sort?.[0] ?? "");
  const all = await everyIssue(l.stub, {
    kind,
    state,
    author: who(q.author?.[0]),
    assignee: no.has("assignee") ? "none" : who(q.assignee?.[0]),
    mentioned: who(q.mentions?.[0]),
    labels: q.label,
    milestone,
    head: q.head?.[0],
    base: q.base?.[0],
    sort: (sortBy?.[1] as "created" | "updated" | "comments" | undefined) ?? "created",
    direction: sortBy?.[2] === "asc" ? "asc" : "desc",
    hide: await hiddenAuthors(ctx.c),
  });
  const reviewer = who(q["review-requested"]?.[0])?.toLowerCase();
  const items = all.filter((i) => {
    if (states.has("merged") && !states.has("closed") && !i.pull?.merged) return false;
    if (q.draft?.[0] && String(!!i.pull?.draft) !== q.draft[0]) return false;
    if (reviewer && !i.pull?.requestedReviewers.some((r) => r.toLowerCase() === reviewer)) return false;
    if (no.has("label") && i.labels.length) return false;
    const text = `${i.title}\n${i.body ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const repoObj = repository(ctx, l);
  return { ...connection(items.map((i) => (i.kind === "pull" ? pullRequest(ctx, l, i, () => repoObj) : issueObj(ctx, l, i, () => repoObj))), args), issueCount: items.length, repositoryCount: 0, userCount: 0 };
}

function root(ctx: Ctx): Obj {
  const p = ctx.c.get("principal");
  return {
    viewer: () => {
      if (p.type !== "account") throw new GraphQLError("This endpoint requires you to be authenticated.");
      return { ...actor(ctx, { id: p.account.id, login: p.account.login, kind: p.account.kind, name: p.account.name || null }), __typename: "User", email: p.account.email ?? "" };
    },
    user: async (args: Args) => {
      const a = await ctx.c.get("dir").accountByLogin(String(args.login)).catch(() => null);
      if (!a || a.kind === "org") throw notFound(`Could not resolve to a User with the login of '${args.login}'.`);
      return { ...actor(ctx, { id: a.id, login: a.login, kind: a.kind, name: a.name || null }), __typename: "User" };
    },
    repository: async (args: Args) => {
      const owner = String(args.owner);
      const name = String(args.name);
      const l = await loadRepository(ctx, owner, name);
      if (!l) throw notFound(`Could not resolve to a Repository with the name '${owner}/${name}'.`);
      return repository(ctx, l);
    },
    node: (args: Args) => nodeById(ctx, String(args.id)),
    nodes: (args: Args) => {
      const ids = (args.ids as string[]) ?? [];
      if (ids.length > LIMITS.pageSize) throw new GraphQLError(`You may not ask for more than ${LIMITS.pageSize} nodes at once.`, { extensions: { type: "EXCESSIVE_PAGINATION" } });
      return ids.map((id) => nodeById(ctx, id));
    },
    search: (args: Args) => search(ctx, args),
    rateLimit: () => ({ cost: 1, limit: 5000, nodeCount: 0, remaining: 4999, used: 1, resetAt: new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z") }),
  };
}

// ---------------------------------------------------------------- mutations (the pull request ones gh uses)

/**
 * loadRepo for a change: the role the REST route for the same change needs, and the permission a
 * workflow's GITHUB_TOKEN needs for it (`permission`, as REST asks for the same change).
 */
async function loadForWrite(ctx: Ctx, owner: string, name: string, min: Role, permission: Requirement): Promise<Loaded> {
  try {
    const { repo, caller, stub } = await loadRepo(ctx.c, owner, name, min, { follow: true, permission });
    return { repo, caller, stub };
  } catch (e) {
    if (statusOf(e)?.status === 404) throw notFound(`Could not resolve to a Repository with the name '${owner}/${name}'.`);
    throw e;
  }
}

async function repoForWrite(ctx: Ctx, id: unknown, min: Role, permission: Requirement): Promise<Loaded> {
  const d = decodeNodeId(String(id));
  const row = d?.type === "Repository" ? await ctx.c.get("dir").repoById(d.key) : null;
  if (!row) throw notFound(`Could not resolve to a node with the global id of '${id}'.`);
  return loadForWrite(ctx, row.owner_login, row.name, min, permission);
}

/**
 * The issue or pull request a change names by node id. `only` refuses the other kind, as GitHub's
 * pull request mutations refuse an issue's id. Without a `permission`, a workflow's token needs
 * issues or pull-requests write, whichever the node is.
 */
async function issueForWrite(ctx: Ctx, id: unknown, o: { min?: Role; permission?: Requirement; only?: "issue" | "pull" } = {}): Promise<{ l: Loaded; number: number }> {
  const d = decodeNodeId(String(id));
  const type = d?.type === "PullRequest" ? "pull" : d?.type === "Issue" ? "issue" : null;
  const [repoId, n] = d && type && (!o.only || o.only === type) ? d.key.split("/") : [];
  const row = repoId ? await ctx.c.get("dir").repoById(repoId) : null;
  if (!row || !Number.isSafeInteger(Number(n))) throw notFound(`Could not resolve to a node with the global id of '${id}'.`);
  const l = await loadForWrite(ctx, row.owner_login, row.name, o.min ?? "read", o.permission ?? writes(type === "pull" ? "pull-requests" : "issues"));
  const found = await issueOrNull(ctx, l, Number(n));
  // An id made for the other kind (an issue's number with a pull request's type) is no node at all.
  if (!found || found.kind !== type) throw notFound(`Could not resolve to a node with the global id of '${id}'.`);
  return { l, number: Number(n) };
}

const pullForWrite = (ctx: Ctx, id: unknown, min: Role = "read", permission: Requirement = writes("pull-requests")) => issueForWrite(ctx, id, { min, permission, only: "pull" });

/** What a label or assignee change returns: the issue or pull request as it is now. */
async function labelable(ctx: Ctx, l: Loaded, number: number): Promise<Obj> {
  return (await issueOf(ctx, l, number)).kind === "pull" ? freshPull(ctx, l, number) : freshIssue(ctx, l, number);
}

/** The issue as it is after a change. */
async function freshIssue(ctx: Ctx, l: Loaded, number: number): Promise<Obj> {
  for (const k of ["issue", "full"]) ctx.memo.delete(`${k}:${l.repo.id}:${number}`);
  const issue = await issueOf(ctx, l, number);
  const repoObj = repository(ctx, l);
  return issueObj(ctx, l, issue, () => repoObj);
}

/** The pull request as it is after a change (this request's cached copies are dropped). */
async function freshPull(ctx: Ctx, l: Loaded, number: number): Promise<Obj> {
  for (const k of ["issue", "full", "review", "merge", "stats", "commits", "files"]) ctx.memo.delete(k === "issue" ? `issue:${l.repo.id}:${number}` : `${k}:${l.repo.id}:${number}`);
  const issue = await issueOf(ctx, l, number);
  const repoObj = repository(ctx, l);
  return pullRequest(ctx, l, issue, () => repoObj);
}

const input = (args: Args) => (args.input ?? {}) as Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const method = (v: unknown): string | undefined => (typeof v === "string" ? v.toLowerCase() : undefined);
const payload = (inp: Record<string, unknown>, rest: Obj): Obj => ({ clientMutationId: inp.clientMutationId ?? null, ...rest });

/** Logins for GitHub user node ids (as gh resolves `--reviewer` logins), or logins passed as they are. */
async function loginsFor(ctx: Ctx, ids: unknown): Promise<string[]> {
  const out: string[] = [];
  for (const id of Array.isArray(ids) ? ids.slice(0, 50) : []) {
    const d = decodeNodeId(String(id));
    const a = d && d.type === "User" ? ((await ctx.c.get("dir").account(d.key).catch(() => null)) ?? (await ctx.c.get("dir").accountByLogin(d.key).catch(() => null))) : null;
    if (!a) throw notFound(`Could not resolve to a User with the global id of '${id}'.`);
    out.push(a.login);
  }
  return out;
}

/** Label names from Label node ids, which must belong to this repository. */
async function labelNamesFor(ctx: Ctx, l: Loaded, ids: unknown[]): Promise<string[]> {
  const prefix = `${l.repo.owner_login}/${l.repo.name}/`;
  const rows = await once(ctx, `labels:${l.repo.id}`, () => l.stub.labelRows());
  return ids.slice(0, 100).map((id) => {
    const d = decodeNodeId(String(id));
    const name = d?.type === "Label" && d.key.startsWith(prefix) ? d.key.slice(prefix.length) : null;
    const row = name !== null ? rows.find((r) => r.name === name) : undefined;
    if (!row) throw notFound(`Could not resolve to a Label with the global id of '${id}'.`);
    return row.name;
  });
}

async function setMilestone(ctx: Ctx, l: Loaded, number: number, id: unknown): Promise<void> {
  if (id !== null && typeof id !== "string") return;
  let n: number | null = null;
  if (id) {
    const d = decodeNodeId(id);
    const [repoId, num] = d?.type === "Milestone" ? d.key.split("/") : [];
    n = repoId === l.repo.id ? Number(num) : NaN;
    if (!Number.isInteger(n) || !(await l.stub.milestones("all")).some((m) => m.number === n)) throw notFound(`Could not resolve to a Milestone with the global id of '${id}'.`);
  }
  // As over REST: only people with triage access set milestones.
  if (!l.caller.role || !["triage", "write", "maintain", "admin"].includes(l.caller.role)) throw new GraphQLError("Setting a milestone needs triage access.", { extensions: { type: "FORBIDDEN" } });
  await l.stub.setIssueMilestone(number, n);
  ctx.memo.delete(`issue:${l.repo.id}:${number}`);
}

/** Creating a pull request or comment counts against the same per-account limit as over REST (lib/rate-limit.ts). */
async function creating(ctx: Ctx): Promise<void> {
  const p = ctx.c.get("principal");
  if (p.type === "account" && (await overLimit(ctx.c.env, [["RL_CREATE", `acct:${p.account.id}`]]))) {
    throw new GraphQLError(`Too many pull requests and comments from your account: at most ${RATE_LIMITS.RL_CREATE} a minute. Try again in a minute.`, { extensions: { type: "RATE_LIMITED" } });
  }
}

function mutations(ctx: Ctx): Obj {
  return {
    createPullRequest: async (args: Args) => {
      const inp = input(args);
      const l = await repoForWrite(ctx, inp.repositoryId, "write", writes("pull-requests"));
      await creating(ctx);
      const head = String(inp.headRefName ?? "");
      const issue = await l.stub.createPull({ title: String(inp.title ?? ""), body: str(inp.body), head: head.includes(":") ? head.slice(head.indexOf(":") + 1) : head, base: str(inp.baseRefName), draft: inp.draft === true }, l.caller);
      ctx.memo.set(`issue:${l.repo.id}:${issue.number}`, Promise.resolve(issue));
      return payload(inp, { pullRequest: await freshPull(ctx, l, issue.number) });
    },
    updatePullRequest: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.pullRequestId);
      if (Array.isArray(inp.projectIds) && inp.projectIds.length) throw new GraphQLError("Projects aren't supported.", { extensions: { type: "UNPROCESSABLE" } });
      const current = await issueOf(ctx, l, number);
      if (typeof inp.baseRefName === "string" && inp.baseRefName !== current.pull?.base) throw new GraphQLError("Changing a pull request's base branch isn't supported.", { extensions: { type: "UNPROCESSABLE" } });
      const state = inp.state === "OPEN" ? "open" : inp.state === "CLOSED" ? "closed" : undefined;
      const labels = Array.isArray(inp.labelIds) ? await labelNamesFor(ctx, l, inp.labelIds) : undefined;
      const assignees = Array.isArray(inp.assigneeIds) ? await loginsFor(ctx, inp.assigneeIds) : undefined;
      if (inp.title !== undefined || inp.body !== undefined || state || labels || assignees) await l.stub.updateIssue(number, { title: str(inp.title), body: str(inp.body), state, labels, assignees }, l.caller);
      if (inp.milestoneId !== undefined) await setMilestone(ctx, l, number, inp.milestoneId);
      return payload(inp, { pullRequest: await freshPull(ctx, l, number), actor: root(ctx).viewer });
    },
    closePullRequest: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.pullRequestId);
      await l.stub.updateIssue(number, { state: "closed" }, l.caller);
      return payload(inp, { pullRequest: await freshPull(ctx, l, number) });
    },
    reopenPullRequest: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.pullRequestId);
      await l.stub.updateIssue(number, { state: "open" }, l.caller);
      return payload(inp, { pullRequest: await freshPull(ctx, l, number) });
    },
    markPullRequestReadyForReview: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.pullRequestId);
      await l.stub.setPullDraft(number, false, l.caller);
      return payload(inp, { pullRequest: await freshPull(ctx, l, number) });
    },
    convertPullRequestToDraft: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.pullRequestId);
      await l.stub.setPullDraft(number, true, l.caller);
      return payload(inp, { pullRequest: await freshPull(ctx, l, number) });
    },
    enablePullRequestAutoMerge: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.pullRequestId, "write", writes("contents"));
      await l.stub.enableAutoMerge(number, { method: method(inp.mergeMethod), commitTitle: str(inp.commitHeadline), commitMessage: str(inp.commitBody), expectedHeadSha: str(inp.expectedHeadOid) }, l.caller);
      return payload(inp, { pullRequest: await freshPull(ctx, l, number), actor: root(ctx).viewer });
    },
    disablePullRequestAutoMerge: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.pullRequestId, "write", writes("contents"));
      await l.stub.disableAutoMerge(number, l.caller);
      return payload(inp, { pullRequest: await freshPull(ctx, l, number), actor: root(ctx).viewer });
    },
    mergePullRequest: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.pullRequestId, "write", writes("contents"));
      await l.stub.mergePull(number, { method: method(inp.mergeMethod) as "merge" | "squash" | "rebase" | undefined, title: str(inp.commitHeadline), message: str(inp.commitBody), expectedHeadSha: str(inp.expectedHeadOid) }, l.caller);
      return payload(inp, { pullRequest: await freshPull(ctx, l, number), actor: root(ctx).viewer });
    },
    addComment: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await issueForWrite(ctx, inp.subjectId, { permission: writes("issues", "pull-requests") });
      const body = String(inp.body ?? "");
      if (!body.trim()) throw new GraphQLError("Body can't be blank.", { extensions: { type: "UNPROCESSABLE" } });
      await creating(ctx);
      const cm = await l.stub.addComment(number, body, l.caller);
      const html = repoHtml(ctx.base, l.repo.owner_login, l.repo.name);
      const issue = await issueOf(ctx, l, number);
      const node = { __typename: "IssueComment", id: nodeId("IssueComment", `${l.repo.id}/${cm.id}`), author: actor(ctx, cm.author), authorAssociation: association(l, cm.author.login), body: cm.body, createdAt: cm.createdAt, url: `${html}/${issue.kind === "pull" ? "pull" : "issues"}/${number}#issuecomment-${cm.id}`, includesCreatedEdit: false, isMinimized: false, minimizedReason: null, reactionGroups: NO_REACTIONS, viewerDidAuthor: true };
      return payload(inp, { commentEdge: { cursor: cursorOf(0), node }, subject: await labelable(ctx, l, number) });
    },
    addLabelsToLabelable: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await issueForWrite(ctx, inp.labelableId, { permission: writes("issues", "pull-requests") });
      const current = await issueOf(ctx, l, number);
      const add = await labelNamesFor(ctx, l, Array.isArray(inp.labelIds) ? inp.labelIds : []);
      await l.stub.updateIssue(number, { labels: [...new Set([...current.labels, ...add])] }, l.caller);
      return payload(inp, { labelable: await labelable(ctx, l, number) });
    },
    removeLabelsFromLabelable: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await issueForWrite(ctx, inp.labelableId, { permission: writes("issues", "pull-requests") });
      const current = await issueOf(ctx, l, number);
      const drop = new Set(await labelNamesFor(ctx, l, Array.isArray(inp.labelIds) ? inp.labelIds : []));
      await l.stub.updateIssue(number, { labels: current.labels.filter((x) => !drop.has(x)) }, l.caller);
      return payload(inp, { labelable: await labelable(ctx, l, number) });
    },
    addAssigneesToAssignable: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await issueForWrite(ctx, inp.assignableId, { permission: writes("issues", "pull-requests") });
      const current = await issueOf(ctx, l, number);
      await l.stub.updateIssue(number, { assignees: [...new Set([...current.assignees, ...(await loginsFor(ctx, inp.assigneeIds))])] }, l.caller);
      return payload(inp, { assignable: await labelable(ctx, l, number) });
    },
    removeAssigneesFromAssignable: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await issueForWrite(ctx, inp.assignableId, { permission: writes("issues", "pull-requests") });
      const current = await issueOf(ctx, l, number);
      const drop = new Set(await loginsFor(ctx, inp.assigneeIds));
      await l.stub.updateIssue(number, { assignees: current.assignees.filter((x) => !drop.has(x)) }, l.caller);
      return payload(inp, { assignable: await labelable(ctx, l, number) });
    },
    createIssue: async (args: Args) => {
      const inp = input(args);
      const l = await repoForWrite(ctx, inp.repositoryId, "read", writes("issues"));
      if (Array.isArray(inp.projectIds) && inp.projectIds.length) throw new GraphQLError("Projects aren't supported.", { extensions: { type: "UNPROCESSABLE" } });
      const title = String(inp.title ?? "");
      if (!title.trim()) throw new GraphQLError("Title can't be blank.", { extensions: { type: "UNPROCESSABLE" } });
      const labels = Array.isArray(inp.labelIds) ? await labelNamesFor(ctx, l, inp.labelIds) : undefined;
      const assignees = Array.isArray(inp.assigneeIds) ? await loginsFor(ctx, inp.assigneeIds) : undefined;
      await creating(ctx);
      const issue = await l.stub.createIssue({ title, body: str(inp.body), labels, assignees }, l.caller);
      // As over REST, a milestone from someone without triage access is left off.
      if (inp.milestoneId && atLeast(l.caller.role, "triage")) await setMilestone(ctx, l, issue.number, inp.milestoneId);
      return payload(inp, { issue: await freshIssue(ctx, l, issue.number) });
    },
    updateIssue: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await issueForWrite(ctx, inp.id, { only: "issue" });
      if (Array.isArray(inp.projectIds) && inp.projectIds.length) throw new GraphQLError("Projects aren't supported.", { extensions: { type: "UNPROCESSABLE" } });
      const state = inp.state === "OPEN" ? "open" : inp.state === "CLOSED" ? "closed" : undefined;
      const labels = Array.isArray(inp.labelIds) ? await labelNamesFor(ctx, l, inp.labelIds) : undefined;
      const assignees = Array.isArray(inp.assigneeIds) ? await loginsFor(ctx, inp.assigneeIds) : undefined;
      if (inp.title !== undefined || inp.body !== undefined || state || labels || assignees) await l.stub.updateIssue(number, { title: str(inp.title), body: str(inp.body), state, labels, assignees }, l.caller);
      if (inp.milestoneId !== undefined) await setMilestone(ctx, l, number, inp.milestoneId);
      return payload(inp, { issue: await freshIssue(ctx, l, number), actor: root(ctx).viewer });
    },
    closeIssue: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await issueForWrite(ctx, inp.issueId, { only: "issue" });
      const reason = { COMPLETED: "completed", NOT_PLANNED: "not_planned", DUPLICATE: "duplicate" }[String(inp.stateReason ?? "COMPLETED")] ?? "completed";
      await l.stub.updateIssue(number, { state: "closed", stateReason: reason }, l.caller);
      return payload(inp, { issue: await freshIssue(ctx, l, number) });
    },
    reopenIssue: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await issueForWrite(ctx, inp.issueId, { only: "issue" });
      await l.stub.updateIssue(number, { state: "open" }, l.caller);
      return payload(inp, { issue: await freshIssue(ctx, l, number) });
    },
    requestReviews: async (args: Args) => {
      const inp = input(args);
      if (Array.isArray(inp.teamIds) && inp.teamIds.length) throw new GraphQLError("Team reviewers aren't supported; request people.", { extensions: { type: "UNPROCESSABLE" } });
      const { l, number } = await pullForWrite(ctx, inp.pullRequestId);
      await l.stub.requestReviewers(number, await loginsFor(ctx, inp.userIds), l.caller);
      return payload(inp, { pullRequest: await freshPull(ctx, l, number), actor: root(ctx).viewer });
    },
  };
}

// ---------------------------------------------------------------- limits

/** Depth and field count of the operation, with fragments expanded (each fragment counted where it's spread). */
export function measure(doc: DocumentNode): { depth: number; fields: number } {
  const fragments = new Map<string, SelectionSetNode>();
  for (const d of doc.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d.selectionSet);
  let fields = 0;
  let depth = 0;
  const walk = (set: SelectionSetNode, level: number, seen: Set<string>) => {
    if (level > depth) depth = level;
    if (fields > LIMITS.fields || depth > LIMITS.depth) return;
    for (const s of set.selections) {
      if (s.kind === Kind.FIELD) {
        fields++;
        if (s.selectionSet) walk(s.selectionSet, level + 1, seen);
      } else if (s.kind === Kind.INLINE_FRAGMENT) walk(s.selectionSet, level, seen);
      else {
        const f = fragments.get(s.name.value);
        if (f && !seen.has(s.name.value)) walk(f, level, new Set([...seen, s.name.value]));
      }
    }
  };
  for (const d of doc.definitions) if (d.kind === Kind.OPERATION_DEFINITION) walk(d.selectionSet, 1, new Set());
  return { depth, fields };
}

const failure = (status: number, message: string) => new Response(JSON.stringify({ message, documentation_url: "https://docs.github.com/graphql" }), { status, headers: { "content-type": "application/json" } });

/** GitHub's error shape: `type` sits beside `message` (gh reads it), as well as under `extensions`. */
function errorJson(e: GraphQLError): Obj {
  const out = e.toJSON() as unknown as Obj;
  const type = e.extensions?.type;
  if (typeof type === "string") out.type = type;
  return out;
}

export async function runGraphql(c: AppContext, input: { query?: unknown; variables?: unknown; operationName?: unknown }): Promise<{ status: number; body: Obj }> {
  if (typeof input.query !== "string" || !input.query.trim()) return { status: 200, body: { errors: [{ message: "A query attribute must be specified and must be a string." }] } };
  if (input.query.length > LIMITS.queryBytes) return { status: 200, body: { errors: [{ message: `The query is over ${LIMITS.queryBytes} bytes.` }] } };
  let doc: DocumentNode;
  try {
    doc = parse(input.query, { maxTokens: 20_000 });
  } catch (e) {
    return { status: 200, body: { errors: [errorJson(e as GraphQLError)] } };
  }
  const operationName = typeof input.operationName === "string" && input.operationName ? input.operationName : undefined;
  const ops = doc.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION);
  const op = operationName ? ops.find((d) => d.kind === Kind.OPERATION_DEFINITION && d.name?.value === operationName) : ops[0];
  const mutation = op?.kind === Kind.OPERATION_DEFINITION && op.operation === "mutation";
  if (op?.kind === Kind.OPERATION_DEFINITION && op.operation === "subscription") {
    return { status: 200, body: { errors: [{ message: "Subscriptions aren't supported.", type: "FORBIDDEN" }] } };
  }
  const size = measure(doc);
  if (size.depth > LIMITS.depth) return { status: 200, body: { errors: [{ message: `The query is nested ${size.depth} levels deep; the limit is ${LIMITS.depth}.`, type: "MAX_NODE_LIMIT_EXCEEDED" }] } };
  if (size.fields > LIMITS.fields) return { status: 200, body: { errors: [{ message: `The query asks for more than ${LIMITS.fields} fields.`, type: "MAX_NODE_LIMIT_EXCEEDED" }] } };
  const s = schema();
  const errors = validate(s, doc, RULES);
  if (errors.length) return { status: 200, body: { errors: errors.map(errorJson) } };
  // Fields Diffinery doesn't have are reported, not fatal (see the top of this file).
  const unsupported = [...new Set(validate(s, doc, [FieldsOnCorrectTypeRule]).map((e) => e.message.replace(/ Did you mean .*$/, "")))];
  // A query only reads: repository lookups run as reads whatever the HTTP method. A mutation is a
  // write, so each repository it touches is loaded as one (write scope, archive and import checks).
  if (!mutation) c.set("readOnly", true);
  const ctx: Ctx = { c, base: baseOf(c), memo: new Map(), repos: 0 };
  const variables = input.variables && typeof input.variables === "object" && !Array.isArray(input.variables) ? (input.variables as Record<string, unknown>) : undefined;
  const result = await execute({ schema: s, document: doc, rootValue: mutation ? mutations(ctx) : root(ctx), contextValue: ctx, variableValues: variables, operationName });
  const body: Obj = {};
  if (result.errors?.length) {
    // Unexpected failures are logged and hidden; GitHub-style errors (not found, limits) are shown.
    body.errors = result.errors.map((e) => {
      const original = e.originalError;
      if (!original || original instanceof GraphQLError) return errorJson(e);
      const st = statusOf(original);
      if (st && st.status < 500) return errorJson(new GraphQLError(st.message, { path: e.path, nodes: e.nodes, extensions: { type: st.status === 404 ? "NOT_FOUND" : st.status === 403 ? "FORBIDDEN" : st.status === 429 ? "RATE_LIMITED" : "UNPROCESSABLE" } }));
      console.error("graphql", e.path?.join("."), original);
      return errorJson(new GraphQLError("Something went wrong while executing your query.", { path: e.path, nodes: e.nodes }));
    });
  }
  body.data = result.data ?? null;
  if (unsupported.length) body.extensions = { unsupported };
  return { status: 200, body };
}

graphql.post("/api/graphql", async (c) => {
  // As on GitHub, the GraphQL API needs a signed-in caller (a token, or a browser session).
  if (c.get("principal").type === "anonymous") return failure(401, "This endpoint requires you to be authenticated.");
  let input: { query?: unknown; variables?: unknown; operationName?: unknown };
  try {
    input = (await c.req.json()) as typeof input;
  } catch {
    return failure(400, "Problems parsing JSON");
  }
  if (!input || typeof input !== "object") return failure(400, "Problems parsing JSON");
  const { status, body } = await runGraphql(c, input);
  return c.json(body, status as 200);
});
// GitHub Enterprise's REST root ends in a slash: the GitHub CLI checks a token there (`gh auth login --hostname`).
graphql.get("/api/v3/", apiRootJson);
graphql.get("/api/graphql", (c) => failure(405, "The GraphQL API takes POST requests with a JSON body: {\"query\": \"...\", \"variables\": {...}}."));
