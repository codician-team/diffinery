/**
 * Mapping GitHub REST objects to the rows an import writes into a repository.
 * Pure functions, unit tested; the workflow fetches and the repository stores.
 */

export interface GhUser {
  login: string;
  id?: number;
  type?: string;
}

export interface GhLabel {
  name: string;
  color?: string | null;
  description?: string | null;
}

export interface GhMilestone {
  number: number;
  title: string;
  description?: string | null;
  state: "open" | "closed";
  due_on?: string | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  creator?: GhUser | null;
}

export interface GhIssue {
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  state_reason?: string | null;
  user: GhUser | null;
  labels?: Array<GhLabel | string>;
  assignees?: GhUser[] | null;
  milestone?: { number: number } | null;
  locked?: boolean;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  pull_request?: unknown;
}

export interface GhPull extends GhIssue {
  draft?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  merged_by?: GhUser | null;
  requested_reviewers?: GhUser[] | null;
  head: { ref: string; sha: string; label?: string; repo: { full_name: string } | null };
  base: { ref: string; sha?: string; repo?: { full_name: string } | null };
}

export interface GhComment {
  id: number;
  body?: string | null;
  user: GhUser | null;
  created_at: string;
  updated_at: string;
  issue_url?: string;
}

export interface GhReview {
  id: number;
  user: GhUser | null;
  state: string;
  body?: string | null;
  commit_id?: string | null;
  submitted_at?: string | null;
}

export interface GhReviewComment {
  id: number;
  pull_request_review_id?: number | null;
  pull_request_url?: string;
  user: GhUser | null;
  body?: string | null;
  path: string;
  line?: number | null;
  original_line?: number | null;
  side?: "LEFT" | "RIGHT" | null;
  commit_id?: string | null;
  original_commit_id?: string | null;
  in_reply_to_id?: number | null;
  created_at: string;
  updated_at: string;
}

/** Who did something: a linked Diffinery account, or a GitHub user shown as imported. */
export interface Person {
  id: string;
  login: string;
  kind: "user" | "github";
}

/** A verified link from a GitHub account to a Diffinery account (see account_links). */
export interface Link {
  externalId: string;
  externalLogin: string;
  accountId: string;
  login: string;
}

/** Prefix for GitHub logins stored where Diffinery expects a login (assignees, reviewers, merged by). */
export const IMPORTED_PREFIX = "github:";

/**
 * Maps GitHub users to Diffinery accounts only through verified links, matched by
 * GitHub's numeric user id (logins can be renamed and reused). Everyone else stays
 * a GitHub user, shown as imported; no accounts are created.
 */
export class People {
  private byId = new Map<string, Link>();
  private byLogin = new Map<string, Link>();
  readonly mapped = new Set<string>();
  readonly unmapped = new Set<string>();

  constructor(links: Link[]) {
    for (const l of links) {
      this.byId.set(l.externalId, l);
      this.byLogin.set(l.externalLogin.toLowerCase(), l);
    }
  }

  private link(u: GhUser): Link | undefined {
    // Objects without an id (rare, e.g. some Enterprise payloads) fall back to the linked login.
    return u.id !== undefined && u.id !== null ? this.byId.get(String(u.id)) : this.byLogin.get(u.login.toLowerCase());
  }

  person(u: GhUser | null | undefined): Person {
    if (!u) return { id: "github:ghost", login: "ghost", kind: "github" };
    const l = this.link(u);
    if (l) {
      this.mapped.add(u.login);
      return { id: l.accountId, login: l.login, kind: "user" };
    }
    this.unmapped.add(u.login);
    return { id: `github:${u.id ?? u.login}`, login: u.login, kind: "github" };
  }

  /** A login for fields that hold logins: the Diffinery login when linked, else "github:<login>". */
  login(u: GhUser | null | undefined): string {
    const p = this.person(u);
    return p.kind === "user" ? p.login : `${IMPORTED_PREFIX}${p.login}`;
  }
}

export interface ImportedIssue {
  number: number;
  kind: "issue" | "pull";
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: string | null;
  author: Person;
  assignees: string[];
  labels: string[];
  milestone: number | null;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  pull?: {
    headRef: string;
    /** The GitHub repository a fork's head is in ("owner/name"); null for the same repository. */
    headRepo: string | null;
    headSha: string;
    baseRef: string;
    draft: boolean;
    merged: boolean;
    mergedAt: string | null;
    mergedBy: string | null;
    mergeCommit: string | null;
    requestedReviewers: string[];
  };
}

export interface ImportedComment {
  id: string;
  number: number;
  author: Person;
  body: string;
  createdAt: string;
  updatedAt: string;
  reviewId?: string | null;
  path?: string | null;
  line?: number | null;
  side?: "LEFT" | "RIGHT" | null;
  commitId?: string | null;
  inReplyTo?: string | null;
}

export interface ImportedReview {
  id: string;
  number: number;
  author: Person;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  body: string;
  commitId: string;
  submittedAt: string;
}

export interface ImportedMilestone {
  number: number;
  title: string;
  description: string;
  state: "open" | "closed";
  dueOn: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  creator: string | null;
}

const labelName = (l: GhLabel | string) => (typeof l === "string" ? l : l.name);

const STATE_REASONS = new Set(["completed", "not_planned", "reopened", "duplicate"]);

export function mapIssue(i: GhIssue, people: People): ImportedIssue {
  return {
    number: i.number,
    kind: "issue",
    title: i.title || `Issue #${i.number}`,
    body: i.body ?? "",
    state: i.state === "closed" ? "closed" : "open",
    stateReason: i.state === "closed" ? (i.state_reason && STATE_REASONS.has(i.state_reason) ? i.state_reason : "completed") : null,
    author: people.person(i.user),
    assignees: (i.assignees ?? []).map((a) => people.login(a)),
    labels: (i.labels ?? []).map(labelName).filter(Boolean),
    milestone: i.milestone?.number ?? null,
    locked: !!i.locked,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    closedAt: i.state === "closed" ? (i.closed_at ?? i.updated_at) : null,
  };
}

/**
 * A pull request keeps its number, state and history. Same-repository heads keep
 * their branch name; heads in forks have no branch here, so they are kept as
 * "fork-owner:branch" (never a valid local branch, so pushes never move them)
 * with the head commit pinned by `refs/pull/N/head`.
 */
export function mapPull(p: GhPull, sourceFullName: string, people: People): ImportedIssue {
  const merged = !!p.merged_at;
  const sameRepo = p.head.repo?.full_name?.toLowerCase() === sourceFullName.toLowerCase();
  const forkOwner = p.head.label?.split(":")[0] ?? p.head.repo?.full_name?.split("/")[0] ?? "unknown";
  return {
    ...mapIssue(p, people),
    kind: "pull",
    title: p.title || `Pull request #${p.number}`,
    stateReason: p.state === "closed" ? (merged ? "merged" : null) : null,
    pull: {
      headRef: sameRepo ? p.head.ref : `${forkOwner}:${p.head.ref}`,
      headRepo: sameRepo ? null : (p.head.repo?.full_name ?? `${forkOwner}/unknown`),
      headSha: p.head.sha,
      baseRef: p.base.ref,
      draft: !!p.draft,
      merged,
      mergedAt: p.merged_at ?? null,
      mergedBy: merged && p.merged_by ? people.login(p.merged_by) : null,
      mergeCommit: merged ? (p.merge_commit_sha ?? null) : null,
      requestedReviewers: p.state === "open" ? (p.requested_reviewers ?? []).map((r) => people.login(r)) : [],
    },
  };
}

/** The issue or pull request number a comment belongs to, from its API URL. */
export function numberFromUrl(url: string | undefined): number | null {
  const m = /\/(?:issues|pulls)\/(\d+)$/.exec(url ?? "");
  return m ? Number(m[1]) : null;
}

export function mapIssueComment(c: GhComment, people: People): ImportedComment | null {
  const number = numberFromUrl(c.issue_url);
  if (!number) return null;
  return { id: `gh-ic${c.id}`, number, author: people.person(c.user), body: c.body ?? "", createdAt: c.created_at, updatedAt: c.updated_at };
}

export function mapReview(r: GhReview, number: number, people: People): ImportedReview | null {
  if (!r.submitted_at || r.state === "PENDING") return null;
  const state = (["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"] as const).find((s) => s === r.state) ?? "COMMENTED";
  return { id: `gh-r${r.id}`, number, author: people.person(r.user), state, body: r.body ?? "", commitId: r.commit_id ?? "", submittedAt: r.submitted_at };
}

export function mapReviewComment(c: GhReviewComment, people: People): ImportedComment | null {
  const number = numberFromUrl(c.pull_request_url);
  if (!number) return null;
  return {
    id: `gh-rc${c.id}`,
    number,
    author: people.person(c.user),
    body: c.body ?? "",
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    reviewId: c.pull_request_review_id ? `gh-r${c.pull_request_review_id}` : null,
    path: c.path,
    line: c.line ?? c.original_line ?? null,
    side: c.side === "LEFT" ? "LEFT" : "RIGHT",
    commitId: c.commit_id ?? c.original_commit_id ?? null,
    inReplyTo: c.in_reply_to_id ? `gh-rc${c.in_reply_to_id}` : null,
  };
}

export function mapMilestone(m: GhMilestone, people: People): ImportedMilestone {
  return {
    number: m.number,
    title: m.title,
    description: m.description ?? "",
    state: m.state === "closed" ? "closed" : "open",
    dueOn: m.due_on ?? null,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    closedAt: m.closed_at ?? null,
    creator: m.creator ? people.login(m.creator) : null,
  };
}

/** GitHub branch protection (REST shape) to Diffinery's rules. */
export interface GhProtection {
  required_status_checks?: { contexts?: string[]; checks?: Array<{ context: string }> } | null;
  required_pull_request_reviews?: { required_approving_review_count?: number; dismiss_stale_reviews?: boolean } | null;
  enforce_admins?: { enabled?: boolean } | null;
  required_linear_history?: { enabled?: boolean } | null;
  allow_force_pushes?: { enabled?: boolean } | null;
  allow_deletions?: { enabled?: boolean } | null;
}

export function mapProtection(p: GhProtection): {
  requirePullRequest: boolean;
  requiredApprovals: number;
  dismissStaleReviews: boolean;
  requiredChecks: string[];
  allowForcePush: boolean;
  allowDeletion: boolean;
  requireLinearHistory: boolean;
  enforceAdmins: boolean;
} {
  const reviews = p.required_pull_request_reviews ?? null;
  const checks = [...(p.required_status_checks?.contexts ?? []), ...(p.required_status_checks?.checks ?? []).map((c) => c.context)];
  return {
    requirePullRequest: !!reviews,
    requiredApprovals: reviews?.required_approving_review_count ?? 0,
    dismissStaleReviews: !!reviews?.dismiss_stale_reviews,
    requiredChecks: [...new Set(checks)],
    allowForcePush: !!p.allow_force_pushes?.enabled,
    allowDeletion: !!p.allow_deletions?.enabled,
    requireLinearHistory: !!p.required_linear_history?.enabled,
    enforceAdmins: !!p.enforce_admins?.enabled,
  };
}
