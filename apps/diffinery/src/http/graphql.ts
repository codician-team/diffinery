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
import { overLimit, RATE_LIMITS } from "../lib/rate-limit.js";
import type { Caller, Role } from "../repo/types.js";
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

async function loadRepository(ctx: Ctx, owner: string, name: string): Promise<Loaded | null> {
  return once(ctx, `repo:${owner.toLowerCase()}/${name.toLowerCase()}`, async () => {
    if (++ctx.repos > LIMITS.repositories) throw new GraphQLError(`A query can look up at most ${LIMITS.repositories} repositories.`, { extensions: { type: "MAX_NODE_LIMIT_EXCEEDED" } });
    try {
      const { repo, caller, stub } = await loadRepo(ctx.c, owner, name, "read", { follow: true });
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
      const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
      const rows = await once(ctx, `labels:${repo.id}`, () => stub.labelRows());
      return connection(rows.filter((r) => !q || r.name.toLowerCase().includes(q)).map((r) => labelObj(l, r.name, r)), args);
    },
    label: async (args: Args) => {
      const rows = await once(ctx, `labels:${repo.id}`, () => stub.labelRows());
      const r = rows.find((x) => x.name.toLowerCase() === String(args.name).toLowerCase());
      return r ? labelObj(l, r.name, r) : null;
    },
    milestones: async (args: Args) => {
      const states = Array.isArray(args.states) ? (args.states as string[]) : [];
      const list = await stub.milestones(states.length === 1 ? (states[0] === "CLOSED" ? "closed" : "open") : "all");
      return connection(list.map((m) => milestoneObj(l, m)), args);
    },
    pullRequest: async (args: Args) => {
      const n = args.number as number;
      const issue = await issueOf(ctx, l, n).catch((e) => {
        if (statusOf(e)?.status === 404) return null;
        throw e;
      });
      if (!issue || issue.kind !== "pull") throw notFound(`Could not resolve to a PullRequest with the number of ${n}.`);
      return pullRequest(ctx, l, issue, self);
    },
    pullRequests: async (args: Args) => {
      pageSize(args);
      const states = (args.states as string[] | null | undefined) ?? [];
      const want = new Set(states);
      const state = !want.size || (want.has("OPEN") && (want.has("CLOSED") || want.has("MERGED"))) ? "all" : want.has("OPEN") ? "open" : "closed";
      const labels = Array.isArray(args.labels) && args.labels.length ? (args.labels as string[]) : undefined;
      const order = args.orderBy as { field?: string; direction?: string } | undefined;
      const sort = order?.field === "UPDATED_AT" ? "updated" : order?.field === "COMMENTS" ? "comments" : "created";
      // GitHub lists oldest first unless asked otherwise.
      const direction = order?.direction === "DESC" ? "desc" : "asc";
      const res = await stub.issues({ kind: "pull", state, head: (args.headRefName as string) || undefined, base: (args.baseRefName as string) || undefined, labels, sort, direction, limit: 500, hide: await hiddenAuthors(ctx.c) });
      let items = res.items;
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

const pullState = (i: Issue): string => (i.pull?.merged ? "MERGED" : i.state === "open" ? "OPEN" : "CLOSED");

// ---------------------------------------------------------------- pull requests

function pullRequest(ctx: Ctx, l: Loaded, i: Issue, repoObj: () => Obj): Obj {
  const { repo, stub, caller } = l;
  const p = i.pull!;
  const html = repoHtml(ctx.base, repo.owner_login, repo.name);
  const url = `${html}/pull/${i.number}`;
  const key = `${repo.id}:${i.number}`;
  const full = () => once(ctx, `full:${key}`, () => stub.issue(i.number, [])) as Promise<{ issue: Issue; comments: Array<{ id: string; author: Person; body: string; createdAt: string; reviewId?: string | null; minimized?: string | null }>; reviews: Review[] }>;
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
  const assoc = (login: string) => (login.toLowerCase() === repo.owner_login.toLowerCase() ? "OWNER" : "NONE");
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
    comments: async (args: Args) =>
      connection(
        (await full()).comments
          .filter((cm) => !cm.reviewId)
          .map((cm) => ({ __typename: "IssueComment", id: nodeId("IssueComment", `${repo.id}/${cm.id}`), author: actor(ctx, cm.author), authorAssociation: assoc(cm.author.login), body: cm.body, createdAt: cm.createdAt, url: `${url}#issuecomment-${cm.id}`, includesCreatedEdit: false, isMinimized: !!cm.minimized, minimizedReason: cm.minimized ?? null, reactionGroups: NO_REACTIONS, viewerDidAuthor: viewerId(ctx) === cm.author.id })),
        args,
      ),
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

/** A repository or pull request by node id, with the same access check as a lookup by name. */
async function nodeById(ctx: Ctx, id: string): Promise<Obj | null> {
  const d = decodeNodeId(id);
  if (!d || (d.type !== "Repository" && d.type !== "PullRequest")) return null;
  const [repoId, num] = d.type === "PullRequest" ? d.key.split("/") : [d.key];
  const row = await ctx.c.get("dir").repoById(repoId!);
  if (!row) return null;
  const l = await loadRepository(ctx, row.owner_login, row.name);
  if (!l) return null;
  const repoObj = repository(ctx, l);
  if (d.type === "Repository") return repoObj;
  const issue = await issueOf(ctx, l, Number(num)).catch(() => null);
  return issue?.kind === "pull" ? pullRequest(ctx, l, issue, () => repoObj) : null;
}

/**
 * GitHub's issue search, for pull requests in one repository: `repo:` is required, and `is:`,
 * `state:`, `author:`, `assignee:`, `review-requested:`, `head:`, `base:`, `label:` and `draft:` narrow it.
 */
async function search(ctx: Ctx, args: Args): Promise<Obj> {
  pageSize(args);
  const empty = () => ({ ...connection([], args), issueCount: 0, repositoryCount: 0, userCount: 0 });
  if (args.type !== "ISSUE" && args.type !== "ISSUE_ADVANCED") return empty();
  const q: Record<string, string[]> = {};
  for (const m of String(args.query).matchAll(/(-?)([a-z-]+):("[^"]*"|\S+)/g)) if (!m[1]) (q[m[2]!] ??= []).push(m[3]!.replace(/^"|"$/g, ""));
  const viewer = ctx.c.get("principal");
  const me = viewer.type === "account" ? viewer.account.login : "";
  const who = (v: string | undefined) => (v === "@me" ? me : v);
  const [full] = q.repo ?? [];
  if (!full || q.repo!.length > 1 || (q.is ?? []).includes("issue") || (q.type ?? []).includes("issue")) return empty();
  const [owner, name] = full.split("/");
  const l = owner && name ? await loadRepository(ctx, owner, name) : null;
  if (!l) return empty();
  const states = new Set([...(q.state ?? []), ...(q.is ?? []).filter((x) => ["open", "closed", "merged"].includes(x))]);
  const state = states.size === 1 && states.has("open") ? "open" : states.size && !states.has("open") ? "closed" : "all";
  const res = await l.stub.issues({ kind: "pull", state, author: who(q.author?.[0]), assignee: who(q.assignee?.[0]), labels: q.label, head: q.head?.[0], base: q.base?.[0], sort: "created", direction: "desc", limit: 500, hide: await hiddenAuthors(ctx.c) });
  const reviewer = who(q["review-requested"]?.[0])?.toLowerCase();
  const items = res.items.filter((i) => {
    if (states.has("merged") && !states.has("closed") && !i.pull?.merged) return false;
    if (q.draft?.[0] && String(!!i.pull?.draft) !== q.draft[0]) return false;
    if (reviewer && !i.pull?.requestedReviewers.some((r) => r.toLowerCase() === reviewer)) return false;
    return true;
  });
  const repoObj = repository(ctx, l);
  return { ...connection(items.map((i) => pullRequest(ctx, l, i, () => repoObj)), args), issueCount: items.length, repositoryCount: 0, userCount: 0 };
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

/** loadRepo for a change: the role the REST route for the same change needs. */
async function loadForWrite(ctx: Ctx, owner: string, name: string, min: Role): Promise<Loaded> {
  try {
    const { repo, caller, stub } = await loadRepo(ctx.c, owner, name, min, { follow: true });
    return { repo, caller, stub };
  } catch (e) {
    if (statusOf(e)?.status === 404) throw notFound(`Could not resolve to a Repository with the name '${owner}/${name}'.`);
    throw e;
  }
}

async function repoForWrite(ctx: Ctx, id: unknown, min: Role): Promise<Loaded> {
  const d = decodeNodeId(String(id));
  const row = d?.type === "Repository" ? await ctx.c.get("dir").repoById(d.key) : null;
  if (!row) throw notFound(`Could not resolve to a node with the global id of '${id}'.`);
  return loadForWrite(ctx, row.owner_login, row.name, min);
}

async function pullForWrite(ctx: Ctx, id: unknown, min: Role = "read"): Promise<{ l: Loaded; number: number }> {
  const d = decodeNodeId(String(id));
  const [repoId, n] = d && (d.type === "PullRequest" || d.type === "Issue") ? d.key.split("/") : [];
  const row = repoId ? await ctx.c.get("dir").repoById(repoId) : null;
  if (!row || !Number.isSafeInteger(Number(n))) throw notFound(`Could not resolve to a node with the global id of '${id}'.`);
  return { l: await loadForWrite(ctx, row.owner_login, row.name, min), number: Number(n) };
}

/** What a label or assignee change returns: the pull request (issues aren't part of this API). */
async function labelable(ctx: Ctx, l: Loaded, number: number): Promise<Obj | null> {
  return (await issueOf(ctx, l, number)).kind === "pull" ? freshPull(ctx, l, number) : null;
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
      const l = await repoForWrite(ctx, inp.repositoryId, "write");
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
      const { l, number } = await pullForWrite(ctx, inp.pullRequestId, "write");
      await l.stub.enableAutoMerge(number, { method: method(inp.mergeMethod), commitTitle: str(inp.commitHeadline), commitMessage: str(inp.commitBody), expectedHeadSha: str(inp.expectedHeadOid) }, l.caller);
      return payload(inp, { pullRequest: await freshPull(ctx, l, number), actor: root(ctx).viewer });
    },
    disablePullRequestAutoMerge: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.pullRequestId, "write");
      await l.stub.disableAutoMerge(number, l.caller);
      return payload(inp, { pullRequest: await freshPull(ctx, l, number), actor: root(ctx).viewer });
    },
    mergePullRequest: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.pullRequestId, "write");
      await l.stub.mergePull(number, { method: method(inp.mergeMethod) as "merge" | "squash" | "rebase" | undefined, title: str(inp.commitHeadline), message: str(inp.commitBody), expectedHeadSha: str(inp.expectedHeadOid) }, l.caller);
      return payload(inp, { pullRequest: await freshPull(ctx, l, number), actor: root(ctx).viewer });
    },
    addComment: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.subjectId);
      const body = String(inp.body ?? "");
      if (!body.trim()) throw new GraphQLError("Body can't be blank.", { extensions: { type: "UNPROCESSABLE" } });
      await creating(ctx);
      const cm = await l.stub.addComment(number, body, l.caller);
      const html = repoHtml(ctx.base, l.repo.owner_login, l.repo.name);
      const issue = await issueOf(ctx, l, number);
      const node = { __typename: "IssueComment", id: nodeId("IssueComment", `${l.repo.id}/${cm.id}`), author: actor(ctx, cm.author), authorAssociation: "NONE", body: cm.body, createdAt: cm.createdAt, url: `${html}/${issue.kind === "pull" ? "pull" : "issues"}/${number}#issuecomment-${cm.id}`, includesCreatedEdit: false, isMinimized: false, minimizedReason: null, reactionGroups: NO_REACTIONS, viewerDidAuthor: true };
      return payload(inp, { commentEdge: { cursor: cursorOf(0), node }, subject: issue.kind === "pull" ? await freshPull(ctx, l, number) : null });
    },
    addLabelsToLabelable: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.labelableId);
      const current = await issueOf(ctx, l, number);
      const add = await labelNamesFor(ctx, l, Array.isArray(inp.labelIds) ? inp.labelIds : []);
      await l.stub.updateIssue(number, { labels: [...new Set([...current.labels, ...add])] }, l.caller);
      return payload(inp, { labelable: await labelable(ctx, l, number) });
    },
    removeLabelsFromLabelable: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.labelableId);
      const current = await issueOf(ctx, l, number);
      const drop = new Set(await labelNamesFor(ctx, l, Array.isArray(inp.labelIds) ? inp.labelIds : []));
      await l.stub.updateIssue(number, { labels: current.labels.filter((x) => !drop.has(x)) }, l.caller);
      return payload(inp, { labelable: await labelable(ctx, l, number) });
    },
    addAssigneesToAssignable: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.assignableId);
      const current = await issueOf(ctx, l, number);
      await l.stub.updateIssue(number, { assignees: [...new Set([...current.assignees, ...(await loginsFor(ctx, inp.assigneeIds))])] }, l.caller);
      return payload(inp, { assignable: await labelable(ctx, l, number) });
    },
    removeAssigneesFromAssignable: async (args: Args) => {
      const inp = input(args);
      const { l, number } = await pullForWrite(ctx, inp.assignableId);
      const current = await issueOf(ctx, l, number);
      const drop = new Set(await loginsFor(ctx, inp.assigneeIds));
      await l.stub.updateIssue(number, { assignees: current.assignees.filter((x) => !drop.has(x)) }, l.caller);
      return payload(inp, { assignable: await labelable(ctx, l, number) });
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
