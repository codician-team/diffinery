/**
 * GitHub REST v3 JSON shapes and pagination, shared by every API route.
 *
 * Octokit, `gh api`, `actions/github-script` and marketplace actions read
 * fields like `node_id`, `url`, `html_url`, full `user` objects and `Link`
 * headers, so responses carry them alongside Diffinery's own fields. The
 * builders take the instance's public URL (no Worker context) so the
 * repository Durable Object can use them for webhook payloads too.
 */
import type { Context } from "hono";
import { b64, HttpError } from "../lib/util.js";
import { atLeast, type Role } from "../repo/types.js";

export const GITHUB_DOCS = "https://docs.github.com/rest";

/** PUBLIC_URL without a trailing slash. */
export const baseOf = (c: { env: { PUBLIC_URL: string } }): string => c.env.PUBLIC_URL.replace(/\/$/, "");
export const apiRoot = (base: string): string => `${base}/api/v3`;
export const repoApi = (base: string, owner: string, repo: string): string => `${base}/api/v3/repos/${owner}/${repo}`;
export const repoHtml = (base: string, owner: string, repo: string): string => `${base}/${owner}/${repo}`;
export const encPath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

/** Opaque GraphQL-style node id, stable for a type and id. */
export const nodeId = (type: string, id: string | number): string => b64(new TextEncoder().encode(`${type}:${id}`)).replace(/=+$/, "");

/** ISO 8601 without milliseconds, like GitHub. */
export const isoSeconds = (iso: string | null | undefined): string | null => (iso ? iso.replace(/\.\d{3}Z$/, "Z") : null);
export const unixIso = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

// ---------------------------------------------------------------- users and repositories

/**
 * A stable positive integer for an internal string id (two FNV-1a hashes, 53
 * bits), so users and repositories get numeric `id`s like GitHub's. Internal
 * ids stay strings; nothing looks an account or repository up by this number.
 */
export function numericId(s: string): number {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    a = Math.imul(a ^ ch, 0x01000193);
    b = Math.imul(b ^ ch, 0x5bd1e995);
    b ^= b >>> 13;
  }
  return ((a >>> 0) % 0x200000) * 0x100000000 + (b >>> 0) || 1;
}

/**
 * GitHub's numeric id for a workflow run or job, whose Diffinery ids are UUIDs written as 32 hex
 * digits. It keeps 52 of the UUID's random bits (the version digit skipped) above 10^15, so it
 * always has 16 digits: shorter numbers stay run numbers (`github.run_id`, `diffinery run view 42`),
 * and `uuidPattern` turns it back into a lookup. Anything else gets `numericId`'s hash.
 */
export function uuidNumber(id: string): number {
  if (!/^[0-9a-f]{32}$/.test(id)) return numericId(id);
  return UUID_NUMBERS + parseInt(id.slice(0, 12) + id[13], 16);
}

/** The SQLite GLOB that matches the ids `uuidNumber` maps to `raw`, or null when `raw` isn't such a number. */
export function uuidPattern(raw: string): string | null {
  if (!/^\d{16}$/.test(raw)) return null;
  const n = Number(raw) - UUID_NUMBERS;
  if (n < 0 || n >= 2 ** 52) return null;
  const h = n.toString(16).padStart(13, "0");
  return `${h.slice(0, 12)}?${h[12]}*`;
}

const UUID_NUMBERS = 1e15;

/** A workflow's numeric id (GitHub's `workflow_id`): a hash of its path, which the API also takes. */
export function workflowNumber(path: string): number {
  return numericId(`workflow:${path}`);
}

export type Who = { id: string; login: string; kind?: string | null };

export const userType = (kind?: string | null): "User" | "Organization" | "Bot" => (kind === "org" ? "Organization" : kind === "agent" || kind === "system" ? "Bot" : "User");

export function ghUser(base: string, u: Who | null | undefined) {
  if (!u) return null;
  // People imported from GitHub without a Diffinery account are mannequins: login "github:<login>",
  // type "Mannequin", pointing at their GitHub profile. They are clearly not Diffinery accounts.
  if (u.kind === "github" || u.login.startsWith("github:")) {
    const login = u.login.replace(/^github:/, "");
    return {
      login: `github:${login}`,
      id: numericId(u.id),
      node_id: nodeId("Mannequin", u.id),
      avatar_url: `${base}/api/avatars/${encodeURIComponent(login)}`,
      gravatar_id: "",
      url: `https://github.com/${encodeURIComponent(login)}`,
      html_url: `https://github.com/${encodeURIComponent(login)}`,
      type: "Mannequin",
      user_view_type: "public",
      site_admin: false,
    };
  }
  const api = `${apiRoot(base)}/users/${encodeURIComponent(u.login)}`;
  return {
    login: u.login,
    id: numericId(u.id),
    node_id: nodeId(userType(u.kind), u.id),
    avatar_url: `${base}/api/avatars/${encodeURIComponent(u.login)}`,
    gravatar_id: "",
    url: api,
    html_url: `${base}/${u.login}`,
    repos_url: `${api}/repos`,
    organizations_url: `${api}/orgs`,
    type: userType(u.kind),
    user_view_type: "public",
    site_admin: false,
  };
}

/** The repository row as the directory stores it (topics arrive as a JSON string). */
export interface RepoRow {
  id: string;
  owner_id: string;
  owner_login: string;
  owner_kind: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  default_branch: string;
  archived: number;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
  topics?: string | null;
  homepage?: string | null;
}

export function topicsOf(r: Pick<RepoRow, "topics">): string[] {
  try {
    const t = JSON.parse(r.topics ?? "[]");
    return Array.isArray(t) ? t.map(String) : [];
  } catch {
    return [];
  }
}

/** A repository's website (GitHub's `homepage`): "" clears it, anything else must be an http(s) URL of at most 500 characters. */
export function normalizeHomepage(v: unknown): string | undefined {
  if (v === undefined || v === null) return v === null ? "" : undefined;
  const s = String(v).trim();
  if (!s) return "";
  let ok = false;
  try {
    ok = s.length <= 500 && ["http:", "https:"].includes(new URL(s).protocol);
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(422, "homepage must be an http or https URL of at most 500 characters", { errors: [{ resource: "Repository", code: "invalid", field: "homepage" }] });
  return s;
}

/** Lowercases, dedupes and checks a list of topics as GitHub does (422 when one is invalid or there are more than 20). */
export function normalizeTopics(raw: unknown[]): string[] {
  const names = [...new Set(raw.map((n) => String(n).trim().toLowerCase()).filter(Boolean))];
  const bad = names.find((n) => !/^[a-z0-9][a-z0-9-]{0,49}$/.test(n));
  if (bad) throw new HttpError(422, `${bad} is not a valid topic. Topics must start with a lowercase letter or number, consist of 50 characters or less, and can include hyphens.`, { errors: [{ resource: "Repository", code: "invalid", field: "names" }] });
  if (names.length > 20) throw new HttpError(422, "a repository can have at most 20 topics");
  return names;
}

export function permissionsFor(role: Role | null | undefined) {
  return { admin: atLeast(role, "admin"), maintain: atLeast(role, "maintain"), push: atLeast(role, "write"), triage: atLeast(role, "triage"), pull: atLeast(role, "read") };
}

export function ghRepo(base: string, r: RepoRow, role?: Role | null, extra: { openIssues?: number } = {}) {
  const full = `${r.owner_login}/${r.name}`;
  const api = repoApi(base, r.owner_login, r.name);
  const html = repoHtml(base, r.owner_login, r.name);
  const open = extra.openIssues ?? 0;
  return {
    id: numericId(r.id),
    node_id: nodeId("Repository", r.id),
    name: r.name,
    full_name: full,
    private: r.visibility !== "public",
    owner: ghUser(base, { id: r.owner_id, login: r.owner_login, kind: r.owner_kind }),
    html_url: html,
    description: r.description || null,
    fork: false,
    url: api,
    archive_url: `${api}/{archive_format}{/ref}`,
    branches_url: `${api}/branches{/branch}`,
    commits_url: `${api}/commits{/sha}`,
    compare_url: `${api}/compare/{base}...{head}`,
    contents_url: `${api}/contents/{+path}`,
    deployments_url: `${api}/deployments`,
    git_refs_url: `${api}/git/refs{/sha}`,
    hooks_url: `${api}/hooks`,
    issues_url: `${api}/issues{/number}`,
    labels_url: `${api}/labels{/name}`,
    languages_url: `${api}/languages`,
    merges_url: `${api}/merges`,
    pulls_url: `${api}/pulls{/number}`,
    releases_url: `${api}/releases{/id}`,
    statuses_url: `${api}/statuses/{sha}`,
    tags_url: `${api}/tags`,
    git_url: `${html}.git`,
    ssh_url: `${html}.git`,
    clone_url: `${html}.git`,
    svn_url: html,
    homepage: r.homepage || null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: !!r.archived,
    disabled: false,
    open_issues_count: open,
    license: null,
    allow_forking: false,
    is_template: false,
    web_commit_signoff_required: false,
    topics: topicsOf(r),
    visibility: r.visibility,
    forks: 0,
    open_issues: open,
    watchers: 0,
    default_branch: r.default_branch,
    created_at: isoSeconds(r.created_at),
    updated_at: isoSeconds(r.updated_at),
    pushed_at: isoSeconds(r.pushed_at),
    ...(role ? { permissions: { ...permissionsFor(role), role } } : {}),
  };
}

// ---------------------------------------------------------------- labels, reactions, issues

export type LabelRow = { id: number; name: string; color: string; description: string };

export function ghLabel(base: string, owner: string, repo: string, l: Pick<LabelRow, "name"> & Partial<LabelRow>) {
  return {
    id: l.id ?? 0,
    node_id: nodeId("Label", `${owner}/${repo}/${l.name}`),
    url: `${repoApi(base, owner, repo)}/labels/${encodeURIComponent(l.name)}`,
    name: l.name,
    color: l.color ?? "ededed",
    default: false,
    description: l.description || null,
  };
}

export const REACTIONS = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"] as const;
export type ReactionContent = (typeof REACTIONS)[number];
export type ReactionCounts = Partial<Record<ReactionContent, number>>;

export function ghReactions(url: string, counts: ReactionCounts | undefined) {
  const out: Record<string, number | string> = { url, total_count: 0 };
  let total = 0;
  for (const r of REACTIONS) {
    out[r] = counts?.[r] ?? 0;
    total += counts?.[r] ?? 0;
  }
  out.total_count = total;
  return out;
}

/** Issue and pull request fields as `../repo/collab.ts` returns them (plus `locked`). */
export interface IssueLike {
  number: number;
  kind: "issue" | "pull";
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: string | null;
  author: { id: string; login: string; kind: string };
  assignees: string[];
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: number;
  locked?: boolean;
  lockReason?: string | null;
  milestone?: { number: number; title: string; state: "open" | "closed"; dueOn: string | null } | null;
  pull?: {
    head: string;
    headSha: string;
    base: string;
    draft: boolean;
    merged: boolean;
    mergedAt: string | null;
    mergedBy: string | null;
    mergeCommit: string | null;
    requestedReviewers: string[];
    intent: string | null;
    autoMerge?: AutoMergeLike | null;
  };
}

/** Auto-merge as `../repo/auto-merge.ts` reports it. */
export type AutoMergeLike = { method: string; commitTitle: string | null; commitMessage: string | null; enabledBy: Who; deleteBranch?: boolean; byRule?: string; byDefault?: boolean };

/** GitHub's `auto_merge` object of a pull request (null while auto-merge is off). */
export function ghAutoMerge(base: string, a: AutoMergeLike | null | undefined) {
  // Diffinery's own: delete_branch (the head branch is deleted once it lands), and what turned it on by itself:
  // by_rule (a branch rule's agents) or by_default (the author's own setting, accounts.auto_merge).
  return a
    ? { enabled_by: ghUser(base, a.enabledBy), merge_method: a.method, commit_title: a.commitTitle, commit_message: a.commitMessage, delete_branch: !!a.deleteBranch, ...(a.byRule ? { by_rule: a.byRule } : {}), ...(a.byDefault ? { by_default: true } : {}) }
    : null;
}

/** Per-request lookups the issue builders need (labels by name, people by login, reactions by subject). */
export interface IssueCtx {
  base: string;
  owner: string;
  repo: string;
  repoId: string;
  labels?: Map<string, LabelRow>;
  people?: Map<string, Who>;
  reactions?: Record<string, ReactionCounts>;
  lockReasons?: Record<number, string | null>;
}

const personByLogin = (x: IssueCtx, login: string): Who => x.people?.get(login.toLowerCase()) ?? { id: login, login, kind: "user" };

/** A GitHub-shaped milestone object for embedding in an issue or pull request. */
function ghIssueMilestone(x: IssueCtx, m: { number: number; title: string; state: "open" | "closed"; dueOn: string | null }) {
  const api = repoApi(x.base, x.owner, x.repo);
  return { url: `${api}/milestones/${m.number}`, html_url: `${repoHtml(x.base, x.owner, x.repo)}/milestone/${m.number}`, id: m.number, number: m.number, title: m.title, description: null, state: m.state, due_on: m.dueOn };
}
const association = (x: IssueCtx, login: string) => (login.toLowerCase() === x.owner.toLowerCase() ? "OWNER" : "NONE");

export function ghIssue(x: IssueCtx, i: IssueLike) {
  const api = repoApi(x.base, x.owner, x.repo);
  const html = repoHtml(x.base, x.owner, x.repo);
  const url = `${api}/issues/${i.number}`;
  const assignees = i.assignees.map((l) => ghUser(x.base, personByLogin(x, l)));
  const merged = !!i.pull?.merged;
  return {
    url,
    repository_url: api,
    labels_url: `${url}/labels{/name}`,
    comments_url: `${url}/comments`,
    events_url: `${url}/events`,
    html_url: `${html}/${i.kind === "pull" ? "pull" : "issues"}/${i.number}`,
    id: i.number,
    node_id: nodeId(i.kind === "pull" ? "PullRequest" : "Issue", `${x.repoId}/${i.number}`),
    number: i.number,
    title: i.title,
    user: ghUser(x.base, i.author),
    labels: i.labels.map((name) => ghLabel(x.base, x.owner, x.repo, x.labels?.get(name) ?? { name })),
    state: merged ? "closed" : i.state,
    locked: !!i.locked,
    assignee: assignees[0] ?? null,
    assignees,
    milestone: i.milestone ? ghIssueMilestone(x, i.milestone) : null,
    comments: i.comments,
    created_at: isoSeconds(i.createdAt),
    updated_at: isoSeconds(i.updatedAt),
    closed_at: isoSeconds(i.closedAt),
    closed_by: null,
    author_association: association(x, i.author.login),
    active_lock_reason: i.locked ? (i.lockReason ?? x.lockReasons?.[i.number] ?? null) : null,
    body: i.body || null,
    reactions: ghReactions(`${url}/reactions`, x.reactions?.[`issue:${i.number}`]),
    timeline_url: `${url}/timeline`,
    performed_via_github_app: null,
    state_reason: i.stateReason,
    ...(i.pull
      ? {
          draft: i.pull.draft,
          pull_request: { url: `${api}/pulls/${i.number}`, html_url: `${html}/pull/${i.number}`, diff_url: `${html}/pull/${i.number}.diff`, patch_url: `${html}/pull/${i.number}.patch`, merged_at: isoSeconds(i.pull.mergedAt) },
        }
      : {}),
  };
}

/** A pull request; `repoJson` is the full repository object used for `head.repo` and `base.repo`. */
export function ghPull(x: IssueCtx, i: IssueLike, repoJson: unknown, owner: Who, baseSha: string | null) {
  const p = i.pull!;
  const api = repoApi(x.base, x.owner, x.repo);
  const html = repoHtml(x.base, x.owner, x.repo);
  const url = `${api}/pulls/${i.number}`;
  const issue = ghIssue(x, i);
  const ownerJson = ghUser(x.base, owner);
  return {
    url,
    id: i.number,
    node_id: issue.node_id,
    html_url: `${html}/pull/${i.number}`,
    diff_url: `${html}/pull/${i.number}.diff`,
    patch_url: `${html}/pull/${i.number}.patch`,
    issue_url: `${api}/issues/${i.number}`,
    commits_url: `${url}/commits`,
    review_comments_url: `${url}/comments`,
    review_comment_url: `${api}/pulls/comments{/number}`,
    comments_url: `${api}/issues/${i.number}/comments`,
    statuses_url: `${api}/statuses/${p.headSha}`,
    number: i.number,
    state: issue.state,
    state_reason: i.stateReason,
    locked: issue.locked,
    title: i.title,
    user: issue.user,
    body: issue.body,
    labels: issue.labels,
    milestone: i.milestone ? ghIssueMilestone(x, i.milestone) : null,
    active_lock_reason: issue.active_lock_reason,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    merged_at: isoSeconds(p.mergedAt),
    merge_commit_sha: p.mergeCommit,
    assignee: issue.assignee,
    assignees: issue.assignees,
    requested_reviewers: p.requestedReviewers.map((l) => ghUser(x.base, personByLogin(x, l))),
    requested_teams: [],
    head: { label: `${x.owner}:${p.head}`, ref: p.head, sha: p.headSha, user: ownerJson, repo: repoJson },
    base: { label: `${x.owner}:${p.base}`, ref: p.base, sha: baseSha, user: ownerJson, repo: repoJson },
    _links: {
      self: { href: url },
      html: { href: `${html}/pull/${i.number}` },
      issue: { href: `${api}/issues/${i.number}` },
      comments: { href: `${api}/issues/${i.number}/comments` },
      review_comments: { href: `${url}/comments` },
      review_comment: { href: `${api}/pulls/comments{/number}` },
      commits: { href: `${url}/commits` },
      statuses: { href: `${api}/statuses/${p.headSha}` },
    },
    author_association: issue.author_association,
    auto_merge: ghAutoMerge(x.base, p.autoMerge),
    draft: p.draft,
    merged: p.merged,
    merged_by: p.mergedBy ? ghUser(x.base, personByLogin(x, p.mergedBy)) : null,
    comments: i.comments,
    maintainer_can_modify: false,
    // Diffinery: the change's purpose, written by agents for reviewers.
    intent: p.intent,
    pull_request: { url },
  };
}

export type CommentLike = { id: string; seq?: number; author: { id: string; login: string; kind: string }; body: string; createdAt: string; updatedAt: string };

export function ghComment(x: IssueCtx, number: number, isPull: boolean, cm: CommentLike) {
  const api = repoApi(x.base, x.owner, x.repo);
  const id = cm.seq ?? cm.id;
  const url = `${api}/issues/comments/${id}`;
  return {
    url,
    html_url: `${repoHtml(x.base, x.owner, x.repo)}/${isPull ? "pull" : "issues"}/${number}#issuecomment-${cm.id}`,
    issue_url: `${api}/issues/${number}`,
    id,
    node_id: nodeId("IssueComment", `${x.repoId}/${cm.id}`),
    user: ghUser(x.base, cm.author),
    created_at: isoSeconds(cm.createdAt),
    updated_at: isoSeconds(cm.updatedAt),
    author_association: association(x, cm.author.login),
    body: cm.body,
    reactions: ghReactions(`${url}/reactions`, x.reactions?.[`comment:${cm.id}`]),
    performed_via_github_app: null,
  };
}

export type ReviewCommentLike = CommentLike & { reviewId: string | null; reviewSeq?: number | null; path: string | null; line: number | null; side: string | null; commitId: string | null; inReplyTo: string | null; inReplyToSeq?: number | null; resolved: boolean };

export function ghReviewComment(x: IssueCtx, number: number, cm: ReviewCommentLike) {
  const api = repoApi(x.base, x.owner, x.repo);
  const html = `${repoHtml(x.base, x.owner, x.repo)}/pull/${number}`;
  const id = cm.seq ?? cm.id;
  const url = `${api}/pulls/comments/${id}`;
  return {
    url,
    pull_request_review_id: cm.reviewSeq ?? cm.reviewId,
    id,
    node_id: nodeId("PullRequestReviewComment", `${x.repoId}/${cm.id}`),
    diff_hunk: "",
    path: cm.path,
    position: cm.line,
    original_position: cm.line,
    commit_id: cm.commitId,
    original_commit_id: cm.commitId,
    in_reply_to_id: cm.inReplyTo ? (cm.inReplyToSeq ?? cm.inReplyTo) : undefined,
    user: ghUser(x.base, cm.author),
    body: cm.body,
    created_at: isoSeconds(cm.createdAt),
    updated_at: isoSeconds(cm.updatedAt),
    html_url: `${html}#discussion_r${id}`,
    pull_request_url: `${api}/pulls/${number}`,
    author_association: association(x, cm.author.login),
    _links: { self: { href: url }, html: { href: `${html}#discussion_r${id}` }, pull_request: { href: `${api}/pulls/${number}` } },
    start_line: null,
    original_start_line: null,
    start_side: null,
    line: cm.line,
    original_line: cm.line,
    side: cm.side ?? "RIGHT",
    subject_type: "line",
    reactions: ghReactions(`${url}/reactions`, x.reactions?.[`review_comment:${cm.id}`]),
    // Diffinery: whether the thread was resolved.
    resolved: cm.resolved,
  };
}

export type ReviewLike = { id: string; seq?: number; author: { id: string; login: string; kind: string }; state: string; body: string; commitId: string; submittedAt: string };

export function ghReview(x: IssueCtx, number: number, r: ReviewLike) {
  const api = repoApi(x.base, x.owner, x.repo);
  const html = `${repoHtml(x.base, x.owner, x.repo)}/pull/${number}#pullrequestreview-${r.seq ?? r.id}`;
  return {
    id: r.seq ?? r.id,
    node_id: nodeId("PullRequestReview", `${x.repoId}/${r.id}`),
    user: ghUser(x.base, r.author),
    body: r.body,
    state: r.state,
    html_url: html,
    pull_request_url: `${api}/pulls/${number}`,
    author_association: association(x, r.author.login),
    _links: { html: { href: html }, pull_request: { href: `${api}/pulls/${number}` } },
    submitted_at: isoSeconds(r.submittedAt),
    commit_id: r.commitId,
  };
}

// ---------------------------------------------------------------- commits and files

export type Sig = { name: string; email: string; timestamp: number; timezone: string };
export type CommitLike = { sha: string; tree: string; parents: string[]; author: Sig; committer: Sig; message: string; signed: boolean };

export const sigJson = (s: Sig) => ({ name: s.name, email: s.email, date: unixIso(s.timestamp) });

/** Verification block; Diffinery does not verify signatures yet. */
export const verification = (signed: boolean) => ({ verified: false, reason: signed ? "unknown_key" : "unsigned", signature: null, payload: null, verified_at: null });

export function ghCommit(base: string, owner: string, repo: string, c: CommitLike, people?: Map<string, Who>) {
  const api = repoApi(base, owner, repo);
  const html = repoHtml(base, owner, repo);
  const who = (s: Sig) => people?.get(s.email.toLowerCase()) ?? null;
  return {
    sha: c.sha,
    node_id: nodeId("Commit", c.sha),
    commit: {
      author: sigJson(c.author),
      committer: sigJson(c.committer),
      message: c.message.replace(/\n$/, ""),
      tree: { sha: c.tree, url: `${api}/git/trees/${c.tree}` },
      url: `${api}/git/commits/${c.sha}`,
      comment_count: 0,
      verification: verification(c.signed),
    },
    url: `${api}/commits/${c.sha}`,
    html_url: `${html}/commit/${c.sha}`,
    comments_url: `${api}/commits/${c.sha}/comments`,
    author: ghUser(base, who(c.author)),
    committer: ghUser(base, who(c.committer)),
    parents: c.parents.map((p) => ({ sha: p, url: `${api}/commits/${p}`, html_url: `${html}/commit/${p}` })),
  };
}

/** A reference (GET /git/ref/:ref): `type` is the kind of object it points at. */
export function ghRef(base: string, owner: string, repo: string, r: { ref: string; sha: string; type: string }) {
  const api = repoApi(base, owner, repo);
  const kind = r.type === "tag" ? "tags" : r.type === "tree" ? "trees" : r.type === "blob" ? "blobs" : "commits";
  return { ref: r.ref, node_id: nodeId("Ref", `${owner}/${repo}/${r.ref}`), url: `${api}/git/${r.ref}`, object: { sha: r.sha, type: r.type, url: `${api}/git/${kind}/${r.sha}` } };
}

/** A commit as the Git data API returns it (GET /git/commits/:sha). */
export function ghGitCommit(base: string, owner: string, repo: string, c: CommitLike) {
  const api = repoApi(base, owner, repo);
  const html = repoHtml(base, owner, repo);
  return {
    sha: c.sha,
    node_id: nodeId("Commit", c.sha),
    url: `${api}/git/commits/${c.sha}`,
    html_url: `${html}/commit/${c.sha}`,
    author: sigJson(c.author),
    committer: sigJson(c.committer),
    message: c.message,
    tree: { sha: c.tree, url: `${api}/git/trees/${c.tree}` },
    parents: c.parents.map((p) => ({ sha: p, url: `${api}/git/commits/${p}`, html_url: `${html}/commit/${p}` })),
    verification: verification(c.signed),
  };
}

export type FileLike = { path: string; status: string; oldOid?: string; newOid?: string; additions: number; deletions: number; patch?: string; binary?: boolean };

export function ghFile(base: string, owner: string, repo: string, ref: string, f: FileLike) {
  const api = repoApi(base, owner, repo);
  const html = repoHtml(base, owner, repo);
  return {
    sha: f.newOid ?? f.oldOid ?? null,
    filename: f.path,
    status: f.status === "deleted" ? "removed" : f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.additions + f.deletions,
    blob_url: `${html}/blob/${ref}/${encPath(f.path)}`,
    raw_url: `${html}/raw/${ref}/${encPath(f.path)}`,
    contents_url: `${api}/contents/${encPath(f.path)}?ref=${ref}`,
    patch: f.binary ? undefined : f.patch,
  };
}

// ---------------------------------------------------------------- checks

export function ghCheckRun(base: string, owner: string, repo: string, r: { id: string; seq?: number | null; sha: string; name: string; status: string; conclusion: string | null; runId: string | null; jobId: string | null; detailsUrl: string | null; output: Record<string, unknown> | null; app: string; startedAt: string | null; completedAt: string | null }) {
  const api = repoApi(base, owner, repo);
  const id = r.seq ?? r.id;
  const out = (r.output ?? {}) as { title?: string; summary?: string; text?: string; annotations?: unknown[]; external_id?: string };
  return {
    id,
    head_sha: r.sha,
    node_id: nodeId("CheckRun", r.id),
    external_id: out.external_id ?? "",
    url: `${api}/check-runs/${id}`,
    html_url: r.detailsUrl,
    details_url: r.detailsUrl,
    status: r.status,
    conclusion: r.conclusion,
    started_at: isoSeconds(r.startedAt),
    completed_at: isoSeconds(r.completedAt),
    output: { title: out.title ?? null, summary: out.summary ?? null, text: out.text ?? null, annotations_count: out.annotations?.length ?? 0, annotations_url: `${api}/check-runs/${id}/annotations` },
    name: r.name,
    check_suite: { id: r.runId ? uuidNumber(r.runId) : numericId(`app-${r.app}-${r.sha}`) },
    app: { id: r.app, slug: r.app, node_id: nodeId("App", r.app), name: r.app, owner: null },
    pull_requests: [],
    // Diffinery: the workflow run and job behind an Actions check.
    run_id: r.runId && uuidNumber(r.runId),
    job_id: r.jobId && uuidNumber(r.jobId),
  };
}

// ---------------------------------------------------------------- Actions runs and jobs

export type RunLike = {
  id: string;
  number: number;
  attempt: number;
  workflowPath: string;
  workflowName: string;
  title: string;
  event: string;
  ref: string;
  sha: string;
  headSha: string;
  headBranch: string;
  actor: Who;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  prNumber: number | null;
};

/**
 * A workflow run: GitHub's fields plus Diffinery's `sha`/`ref` (what the run checked out) and `pull_request_number`.
 * Its `id`, `workflow_id` and `check_suite_id` are numbers, as clients like gh expect; the API takes them back too.
 */
export function ghRun(base: string, owner: string, repo: string, r: RunLike) {
  const api = repoApi(base, owner, repo);
  const id = uuidNumber(r.id);
  const url = `${api}/actions/runs/${id}`;
  return {
    id,
    node_id: nodeId("WorkflowRun", r.id),
    run_number: r.number,
    run_attempt: r.attempt,
    name: r.workflowName,
    display_title: r.title,
    path: r.workflowPath,
    workflow_id: workflowNumber(r.workflowPath),
    check_suite_id: id,
    event: r.event,
    head_branch: r.headBranch,
    head_sha: r.headSha,
    // The commit the run checked out (GITHUB_SHA): the test merge commit for pull_request runs.
    sha: r.sha,
    ref: r.ref,
    status: r.status,
    conclusion: r.conclusion,
    actor: ghUser(base, r.actor),
    triggering_actor: ghUser(base, r.actor),
    created_at: isoSeconds(r.createdAt),
    updated_at: isoSeconds(r.updatedAt),
    run_started_at: isoSeconds(r.createdAt),
    url,
    html_url: `${repoHtml(base, owner, repo)}/actions/runs/${r.id}`,
    jobs_url: `${url}/jobs`,
    logs_url: `${url}/logs`,
    artifacts_url: `${url}/artifacts`,
    cancel_url: `${url}/cancel`,
    rerun_url: `${url}/rerun`,
    workflow_url: `${api}/actions/workflows/${workflowNumber(r.workflowPath)}`,
    previous_attempt_url: r.attempt > 1 ? `${url}/attempts/${r.attempt - 1}` : null,
    pull_requests: r.prNumber ? [{ number: r.prNumber, url: `${api}/pulls/${r.prNumber}` }] : [],
    pull_request_number: r.prNumber,
  };
}

export type JobLike = {
  id: string;
  runId: string;
  carriedFrom?: string | null;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  runnerName?: string | null;
  runnerSize?: string | null;
  steps: Array<{ index: number; name: string; status: string; conclusion?: string | null; startedAt?: string; completedAt?: string }>;
};

/**
 * A job: GitHub's snake_case fields next to Diffinery's own (camelCase) ones, which the CLI and web UI read.
 * `id`, `run_id` and `carriedFrom` are numbers like GitHub's ids (`runId` stays Diffinery's own id).
 */
export function ghJob<J extends JobLike>(base: string, owner: string, repo: string, run: RunLike, j: J) {
  const api = repoApi(base, owner, repo);
  const id = uuidNumber(j.id);
  const runId = uuidNumber(j.runId);
  return {
    ...j,
    id,
    carriedFrom: j.carriedFrom ? uuidNumber(j.carriedFrom) : null,
    // A job held by its environment's reviewers or wait timer is "waiting", as on GitHub.
    status: j.status === "approval" ? "waiting" : j.status,
    run_id: runId,
    run_url: `${api}/actions/runs/${runId}`,
    run_attempt: run.attempt,
    node_id: nodeId("Job", j.id),
    head_sha: run.headSha,
    head_branch: run.headBranch,
    url: `${api}/actions/jobs/${id}`,
    html_url: `${repoHtml(base, owner, repo)}/actions/runs/${j.runId}/job/${j.id}`,
    started_at: isoSeconds(j.startedAt),
    completed_at: isoSeconds(j.completedAt),
    workflow_name: run.workflowName,
    check_run_url: `${api}/check-runs/${id}`,
    labels: [] as string[],
    runner_name: j.runnerName ?? null,
    // Hosted runner size (large, medium, small, tiny); `usage` (from ...j) is what the job used of it.
    runner_size: j.runnerSize ?? null,
    steps: j.steps.map((s) => ({ ...s, number: s.index + 1, started_at: isoSeconds(s.startedAt), completed_at: isoSeconds(s.completedAt), conclusion: s.conclusion ?? null })),
  };
}

// ---------------------------------------------------------------- pagination

export interface Page {
  page: number;
  perPage: number;
  offset: number;
}

export function pageOf(c: Context, def = 30): Page {
  const per = parseInt(c.req.query("per_page") ?? "", 10);
  const perPage = Math.min(Math.max(Number.isFinite(per) && per > 0 ? per : def, 1), 100);
  const pg = parseInt(c.req.query("page") ?? "", 10);
  const page = Math.min(Math.max(Number.isFinite(pg) && pg > 0 ? pg : 1, 1), 100_000);
  return { page, perPage, offset: (page - 1) * perPage };
}

/**
 * `Link` header with first/prev/next/last, as Octokit's paginate() follows it.
 * Pass `total` when known; otherwise `hasMore` decides whether there is a next page.
 */
export function setLinks(c: Context, p: Page, total: number | null, hasMore?: boolean): void {
  const url = new URL(c.req.url);
  const at = (n: number) => {
    url.searchParams.set("per_page", String(p.perPage));
    url.searchParams.set("page", String(n));
    return url.toString();
  };
  const last = total === null ? null : Math.max(1, Math.ceil(total / p.perPage));
  const more = last === null ? !!hasMore : p.page < last;
  const links: string[] = [];
  if (p.page > 1) links.push(`<${at(p.page - 1)}>; rel="prev"`, `<${at(1)}>; rel="first"`);
  if (more) links.push(`<${at(p.page + 1)}>; rel="next"`);
  if (last !== null && p.page < last) links.push(`<${at(last)}>; rel="last"`);
  if (links.length) c.header("link", links.join(", "));
}

/** Paginate an in-memory list and set the Link header. */
export function paginate<T>(c: Context, items: readonly T[], def = 30): T[] {
  const p = pageOf(c, def);
  setLinks(c, p, items.length);
  return items.slice(p.offset, p.offset + p.perPage);
}

// ---------------------------------------------------------------- releases

export type AssetLike = { id: number; name: string; label: string; contentType: string; size: number; state: string; downloadCount: number; uploader: Who | null; createdAt: string; updatedAt: string };
export type ReleaseLike = {
  id: number;
  tagName: string;
  targetCommitish: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  author: Who;
  createdAt: string;
  publishedAt: string | null;
  updatedAt: string;
  latest?: boolean;
  assets: AssetLike[];
};

export function ghAsset(base: string, owner: string, repo: string, tag: string, a: AssetLike) {
  return {
    url: `${repoApi(base, owner, repo)}/releases/assets/${a.id}`,
    id: a.id,
    node_id: nodeId("ReleaseAsset", a.id),
    name: a.name,
    label: a.label || null,
    uploader: ghUser(base, a.uploader),
    content_type: a.contentType,
    state: a.state,
    size: a.size,
    digest: null,
    download_count: a.downloadCount,
    created_at: isoSeconds(a.createdAt),
    updated_at: isoSeconds(a.updatedAt),
    browser_download_url: `${repoHtml(base, owner, repo)}/releases/download/${encPath(tag)}/${encodeURIComponent(a.name)}`,
  };
}

export function ghRelease(base: string, owner: string, repo: string, r: ReleaseLike, reactions?: ReactionCounts) {
  const api = repoApi(base, owner, repo);
  const url = `${api}/releases/${r.id}`;
  return {
    url,
    assets_url: `${url}/assets`,
    upload_url: `${base}/api/uploads/repos/${owner}/${repo}/releases/${r.id}/assets{?name,label}`,
    html_url: `${repoHtml(base, owner, repo)}/releases/tag/${encPath(r.tagName)}`,
    id: r.id,
    author: ghUser(base, r.author),
    node_id: nodeId("Release", r.id),
    tag_name: r.tagName,
    target_commitish: r.targetCommitish,
    name: r.name || null,
    draft: r.draft,
    immutable: false,
    prerelease: r.prerelease,
    created_at: isoSeconds(r.createdAt),
    updated_at: isoSeconds(r.updatedAt),
    published_at: isoSeconds(r.publishedAt),
    assets: r.assets.map((a) => ghAsset(base, owner, repo, r.tagName, a)),
    tarball_url: `${api}/tarball/${encPath(r.tagName)}`,
    zipball_url: `${api}/zipball/${encPath(r.tagName)}`,
    body: r.body || null,
    reactions: ghReactions(`${url}/reactions`, reactions),
    // Diffinery: whether this is the repository's latest release.
    latest: !!r.latest,
  };
}
