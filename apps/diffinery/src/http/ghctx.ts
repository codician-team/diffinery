/**
 * Request-scoped helpers around ./gh.ts: they fetch what the GitHub JSON
 * builders need (label rows, reactions, people, branch heads) from the
 * repository Durable Object and the directory in as few calls as possible.
 */
import type { AppContext } from "../auth/principal.js";
import type { Repo } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { isPerson } from "../repo/auto-merge.js";
import type { Caller, Role } from "../repo/types.js";
import { hiddenAuthors, loadRepo, type repoStub } from "./common.js";
import { baseOf, ghIssue, ghPull, ghRepo, type IssueCtx, type IssueLike, type Who } from "./gh.js";

export type Stub = ReturnType<typeof repoStub>;

/**
 * loadRepo for the `:owner/:repo` in the path. Archived repositories are
 * read-only for everyone (comments, reactions and settings included), so any
 * request that isn't a read is refused, whatever role the route needs.
 */
export async function loadTarget(c: AppContext, min: Role = "read", opts: { whileImporting?: boolean } = {}): Promise<Awaited<ReturnType<typeof loadRepo>>> {
  const l = await loadRepo(c, c.req.param("owner") ?? "", c.req.param("repo") ?? "", min, opts);
  if (l.repo.archived && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) throw new HttpError(403, "repository is archived (read-only)");
  return l;
}

export const repoOut = (c: AppContext, r: Repo, role?: Role | null) => ghRepo(baseOf(c), r, role);

export const ownerOf = (r: Repo): Who => ({ id: r.owner_id, login: r.owner_login, kind: r.owner_kind });

/** Accounts for a set of logins (assignees, reviewers), so user objects carry real ids and types. */
export async function peopleFor(c: AppContext, logins: Iterable<string>): Promise<Map<string, Who>> {
  const out = new Map<string, Who>();
  const wanted = [...new Set([...logins].map((l) => l.toLowerCase()))].slice(0, 50);
  if (!wanted.length) return out;
  // One query for all of them.
  const r = await c.env.DB.prepare(`SELECT id, login, kind FROM accounts WHERE login IN (${wanted.map(() => "?").join(", ")})`)
    .bind(...wanted)
    .all<Who>()
    .catch(() => null);
  const found = new Map((r?.results ?? []).map((a) => [a.login.toLowerCase(), a]));
  for (const login of wanted) {
    const a = found.get(login);
    if (a) out.set(login, { id: a.id, login: a.login, kind: a.kind });
  }
  return out;
}

/** Everything ghIssue/ghPull need for `issues`, plus reaction counts for extra `subjects` (comments). */
export async function issueCtx(c: AppContext, repo: Repo, stub: Stub, issues: IssueLike[], subjects: string[] = []): Promise<IssueCtx> {
  const logins = issues.flatMap((i) => [...i.assignees, ...(i.pull?.requestedReviewers ?? []), ...(i.pull?.mergedBy ? [i.pull.mergedBy] : [])]);
  const [extras, people] = await Promise.all([
    stub.issueExtras(
      issues.map((i) => i.number),
      subjects,
    ),
    peopleFor(c, logins),
  ]);
  return {
    base: baseOf(c),
    owner: repo.owner_login,
    repo: repo.name,
    repoId: repo.id,
    labels: new Map(extras.labels.map((l) => [l.name, l])),
    people,
    reactions: extras.reactions,
    lockReasons: extras.lockReasons,
  };
}

export async function issuesOut(c: AppContext, repo: Repo, stub: Stub, issues: IssueLike[]) {
  const x = await issueCtx(c, repo, stub, issues);
  return issues.map((i) => ghIssue(x, i));
}

export async function pullsOut(c: AppContext, repo: Repo, stub: Stub, issues: IssueLike[]) {
  const [x, branches] = await Promise.all([issueCtx(c, repo, stub, issues), stub.branches()]);
  const heads = new Map(branches.map((b) => [b.name, b.sha]));
  const repoJson = ghRepo(x.base, repo);
  return issues.map((i) => ghPull(x, i, repoJson, ownerOf(repo), heads.get(i.pull!.base) ?? null));
}

// ---------------------------------------------------------------- small request helpers for the route files

export async function jsonBody<T>(c: AppContext, optional = false): Promise<T> {
  const text = await c.req.text();
  if (!text.trim() && optional) return {} as T;
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object") throw new Error("not an object");
    return v as T;
  } catch {
    throw new HttpError(400, "Problems parsing JSON");
  }
}

/**
 * Decode one piece of the request path. Hono leaves `%25` (and other reserved
 * escapes) in c.req.path, so this is the only decoding a path piece needs;
 * route params from c.req.param() are already decoded and must not go through it.
 */
export function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "malformed percent-encoding in the URL");
  }
}

export const repoParams = (c: AppContext) => ({ owner: c.req.param("owner")!, repo: c.req.param("repo")! });

export function intParam(c: AppContext, name: string): number {
  const n = Number(c.req.param(name));
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, "Not Found");
  return n;
}

/** GitHub's mergeable_state for Diffinery's mergeability state. */
export const mergeableState = (s: string): string => (s === "conflicting" ? "dirty" : s === "merged" || s === "closed" ? "unknown" : s);

/** A single pull request with mergeability (GitHub fields plus Diffinery's merge_blockers, approvals and checks). */
export async function pullDetail(c: AppContext, repo: Repo, stub: Stub, number: number, caller: Caller) {
  const { issue, comments } = await stub.issue(number, await hiddenAuthors(c));
  if (issue.kind !== "pull") throw new HttpError(404, "not a pull request");
  const open = issue.state === "open";
  // Everything else at once. For agents and workflow tokens, also what Diffinery itself would need to land it for them (auto-merge, the merge queue).
  const [[pull], m, automatic, commits, files, baseHead] = await Promise.all([
    pullsOut(c, repo, stub, [issue]),
    stub.mergeability(number, caller),
    isPerson(caller) ? null : stub.mergeability(number, caller, { automatic: true }),
    open || issue.pull!.merged ? stub.pullCommits(number).then((list) => list.length) : 0,
    stub.pullFiles(number).catch(() => null),
    open ? stub.resolve(issue.pull!.base) : null,
  ]);
  return {
    ...pull!,
    mergeable: open ? m.conflicts.length === 0 : null,
    mergeable_state: mergeableState(m.state),
    rebaseable: open ? m.conflicts.length === 0 && m.mergeBase === baseHead : null,
    review_comments: comments.filter((x) => x.reviewId).length,
    commits,
    additions: files?.additions ?? 0,
    deletions: files?.deletions ?? 0,
    changed_files: files?.totalFiles ?? 0,
    // Diffinery: why the pull request can't be merged yet, and what it is waiting for.
    merge_blockers: m.blockers,
    approvals: m.approvals,
    required_approvals: m.requiredApprovals,
    checks: m.checks,
    merge_queue: m.mergeQueue,
    // Diffinery, agents and workflow tokens only: why auto-merge (or the merge queue) can't land it yet; [] means it would now.
    ...(automatic ? { auto_merge_blockers: automatic.blockers } : {}),
  };
}
