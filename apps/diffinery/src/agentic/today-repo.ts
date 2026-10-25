import type { Check } from "../repo/collab.js";

/**
 * One repository's part of the Today view (the morning view of agent work),
 * read inside its Durable Object in one call: open pull requests with their
 * review and check state, and what landed or failed since a point in time.
 * Who the viewer is doesn't matter here; agentic/today.ts sorts the items
 * into "needs you", "agents at work" and "since yesterday" per person.
 */

export type ChecksState = "success" | "failure" | "pending" | "none";

export interface TodayPerson {
  id: string;
  login: string;
  kind: string;
}

export interface TodayPull {
  number: number;
  title: string;
  author: TodayPerson;
  head: string;
  base: string;
  draft: boolean;
  requestedReviewers: string[];
  intent: string | null;
  createdAt: string;
  updatedAt: string;
  /** People whose latest vote is an approval, and whether one of them approved the current head. */
  approvedBy: string[];
  approvedHead: boolean;
  /** People (and agents) whose latest vote asks for changes. */
  changesRequestedBy: string[];
  /** Ids of everyone whose latest vote is an approval or a change request. */
  reviewerIds: string[];
  checks: ChecksState;
  failingChecks: string[];
  autoMerge: boolean;
  /**
   * An agent's pull request with auto-merge on that still needs a person to approve its latest commit (merge on
   * green with approvals kept): it isn't landing until someone does, so Today asks them.
   */
  awaitingApproval?: boolean;
  queued: boolean;
  /**
   * What the last mergeability check found, while the base branch and the head are still the commits it saw:
   * conflicts, or a head that is already part of the base. Null when nobody checked since either moved.
   * Absent in summaries from repositories still running code from before it existed.
   */
  mergeState?: MergeState | null;
}

export type MergeState = "clean" | "conflicting" | "in_base";

/** At most this many pull requests' mergeability is checked after one summary (RepoDO.todaySummary). */
export const MERGE_CHECKS_PER_SUMMARY = 5;

/**
 * An agent's pull request that may be waiting for a person's approval, with no mergeability check for its
 * current base and head: Today checks it after answering, so a later Today knows whether it conflicts.
 */
export const needsMergeCheck = (p: TodayPull): boolean =>
  p.author.kind === "agent" && p.mergeState === null && !p.draft && (!p.autoMerge || !!p.awaitingApproval) && !p.queued && p.checks !== "failure" && !p.changesRequestedBy.length && !p.approvedHead;

export interface TodayMerged {
  number: number;
  title: string;
  author: TodayPerson;
  mergedAt: string;
  mergedBy: string | null;
}

export interface TodayRelease {
  tag: string;
  name: string;
  author: TodayPerson;
  publishedAt: string;
  prerelease: boolean;
}

export interface TodayRun {
  id: string;
  runNumber: number;
  workflow: string;
  title: string;
  ref: string;
  event: string;
  actor: TodayPerson;
  conclusion: string;
  prNumber: number | null;
  at: string;
}

/** A run's jobs waiting on an environment's required reviewers. */
export interface TodayDeployment {
  runId: string;
  runNumber: number;
  workflow: string;
  title: string;
  ref: string;
  environment: string;
  /** People listed as the environment's required reviewers. */
  reviewerIds: string[];
  /**
   * Account ids that can't approve because the environment prevents self-review: who started the run
   * and its earlier attempts. When one of them is an agent, its owner can't either (see classify).
   */
  selfBlocked: string[];
  actor: TodayPerson;
  since: string;
}

export interface RepoToday {
  pulls: TodayPull[];
  merged: TodayMerged[];
  releases: TodayRelease[];
  failedRuns: TodayRun[];
  /** Absent in summaries from before environment reviewers existed. */
  deployments?: TodayDeployment[];
}

/** At most this many open pull requests per repository (most recently updated first). */
export const MAX_PULLS = 50;
const MAX_RECENT = 20;

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required", "cancelled"]);

/** One state for a commit's checks and statuses: any failure wins, then anything unfinished. */
export function checksState(checks: Pick<Check, "name" | "status" | "conclusion">[]): { state: ChecksState; failing: string[] } {
  if (!checks.length) return { state: "none", failing: [] };
  const failing = checks.filter((c) => c.status === "completed" && FAILED.has(c.conclusion ?? "")).map((c) => c.name);
  if (failing.length) return { state: "failure", failing: [...new Set(failing)] };
  return { state: checks.some((c) => c.status !== "completed") ? "pending" : "success", failing: [] };
}

type PullJoin = {
  number: number;
  title: string;
  author_id: string;
  author_login: string;
  author_kind: string;
  created_at: string;
  updated_at: string;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  draft: number;
  requested_reviewers: string;
  intent: string | null;
  auto_merge: string | null;
  queued: number;
  merge_state: MergeState | null;
};

type ReviewRow = { number: number; author_id: string; author_login: string; author_kind: string; state: string; commit_id: string; imported: string | null };

/**
 * `agentApprovalWaived(base)`: whether what Diffinery lands for agents into `base` needs no approving review
 * (its rule's "as soon as the checks pass"); otherwise an agent's pull request waits for a person even with auto-merge on.
 */
export function repoToday(sql: SqlStorage, checksFor: (sha: string) => Check[], since: string, agentApprovalWaived: (base: string) => boolean = () => false): RepoToday {
  const rows = sql
    .exec<PullJoin>(
      `SELECT i.number, i.title, i.author_id, i.author_login, i.author_kind, i.created_at, i.updated_at,
              p.head_ref, p.head_sha, p.base_ref, p.draft, p.requested_reviewers, p.intent, p.auto_merge,
              EXISTS (SELECT 1 FROM merge_queue q WHERE q.number = i.number) AS queued,
              (SELECT m.state FROM pull_merge_state m JOIN refs b ON b.name = 'refs/heads/' || p.base_ref
                WHERE m.number = i.number AND m.base_sha = b.oid AND m.head_sha = p.head_sha) AS merge_state
         FROM issues i JOIN pulls p ON p.number = i.number
        WHERE i.kind = 'pull' AND i.state = 'open'
        ORDER BY i.updated_at DESC LIMIT ?`,
      MAX_PULLS,
    )
    .toArray();
  const numbers = rows.map((r) => r.number);
  const reviews = numbers.length
    ? sql
        .exec<ReviewRow>(
          `SELECT number, author_id, author_login, author_kind, state, commit_id, imported FROM reviews
            WHERE number IN (${numbers.map(() => "?").join(",")}) ORDER BY submitted_at`,
          ...numbers,
        )
        .toArray()
    : [];
  const pulls = rows.map((r): TodayPull => {
    // Each reviewer's latest vote, as the merge rules count them: comments don't vote, imported reviews are history.
    const latest = new Map<string, ReviewRow>();
    for (const rv of reviews) if (rv.number === r.number && rv.state !== "COMMENTED" && !rv.imported && rv.author_kind !== "github") latest.set(rv.author_id, rv);
    const votes = [...latest.values()];
    const approvals = votes.filter((v) => v.state === "APPROVED" && v.author_kind === "user");
    const checks = checksState(checksFor(r.head_sha));
    const approvedHead = approvals.some((v) => v.commit_id === r.head_sha);
    return {
      number: r.number,
      title: r.title,
      author: { id: r.author_id, login: r.author_login, kind: r.author_kind },
      head: r.head_ref,
      base: r.base_ref,
      draft: !!r.draft,
      requestedReviewers: JSON.parse(r.requested_reviewers) as string[],
      intent: r.intent,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      approvedBy: approvals.map((v) => v.author_login),
      approvedHead,
      changesRequestedBy: votes.filter((v) => v.state === "CHANGES_REQUESTED").map((v) => v.author_login),
      reviewerIds: votes.filter((v) => v.state === "APPROVED" || v.state === "CHANGES_REQUESTED").map((v) => v.author_id),
      checks: checks.state,
      failingChecks: checks.failing,
      autoMerge: !!r.auto_merge,
      awaitingApproval: r.author_kind === "agent" && !!r.auto_merge && !approvedHead && !agentApprovalWaived(r.base_ref),
      queued: !!r.queued,
      mergeState: r.merge_state,
    };
  });

  const merged = sql
    .exec<{ number: number; title: string; author_id: string; author_login: string; author_kind: string; merged_at: string; merged_by: string | null }>(
      `SELECT i.number, i.title, i.author_id, i.author_login, i.author_kind, p.merged_at, p.merged_by
         FROM pulls p JOIN issues i ON i.number = p.number
        WHERE p.merged = 1 AND p.merged_at >= ? AND p.imported IS NULL
        ORDER BY p.merged_at DESC LIMIT ?`,
      since,
      MAX_RECENT,
    )
    .toArray()
    .map((m) => ({ number: m.number, title: m.title, author: { id: m.author_id, login: m.author_login, kind: m.author_kind }, mergedAt: m.merged_at, mergedBy: m.merged_by }));

  const releases = sql
    .exec<{ tag_name: string; name: string; author_id: string; author_login: string; author_kind: string; published_at: string; prerelease: number }>(
      `SELECT tag_name, name, author_id, author_login, author_kind, published_at, prerelease FROM releases
        WHERE draft = 0 AND published_at >= ? ORDER BY published_at DESC LIMIT ?`,
      since,
      MAX_RECENT,
    )
    .toArray()
    .map((x) => ({ tag: x.tag_name, name: x.name || x.tag_name, author: { id: x.author_id, login: x.author_login, kind: x.author_kind }, publishedAt: x.published_at, prerelease: !!x.prerelease }));

  const failedRuns = sql
    .exec<{ id: string; run_number: number; workflow_name: string; display_title: string; ref: string; event: string; actor: string; conclusion: string; pr_number: number | null; updated_at: string }>(
      `SELECT id, run_number, workflow_name, display_title, ref, event, actor, conclusion, pr_number, updated_at FROM runs
        WHERE status = 'completed' AND conclusion IN ('failure', 'timed_out', 'startup_failure') AND updated_at >= ?
        ORDER BY updated_at DESC LIMIT ?`,
      since,
      MAX_RECENT,
    )
    .toArray()
    .map((x) => {
      let actor: TodayPerson = { id: "", login: "unknown", kind: "system" };
      try {
        const a = JSON.parse(x.actor) as Partial<TodayPerson>;
        actor = { id: a.id ?? "", login: a.login ?? "unknown", kind: a.kind ?? "user" };
      } catch {
        // An unreadable actor shows as unknown.
      }
      return { id: x.id, runNumber: x.run_number, workflow: x.workflow_name, title: x.display_title, ref: x.ref, event: x.event, actor, conclusion: x.conclusion, prNumber: x.pr_number, at: x.updated_at };
    });

  const parsePerson = (json: string): TodayPerson & { onBehalfOf?: string } => {
    try {
      const a = JSON.parse(json) as Partial<TodayPerson> & { onBehalfOf?: string };
      return { id: a.id ?? "", login: a.login ?? "unknown", kind: a.kind ?? "user", onBehalfOf: a.onBehalfOf };
    } catch {
      return { id: "", login: "unknown", kind: "system" };
    }
  };
  const deployments = sql
    .exec<{ run_id: string; environment: string; since: string; run_number: number; workflow_name: string; display_title: string; ref: string; actor: string; prior_actors: string | null; reviewers: string | null; prevent_self_review: number }>(
      `SELECT j.run_id, e.name AS environment, MIN(j.gate_since) AS since, r.run_number, r.workflow_name, r.display_title, r.ref, r.actor, r.prior_actors, e.reviewers, e.prevent_self_review
         FROM jobs j JOIN runs r ON r.id = j.run_id JOIN environments e ON e.name = j.environment COLLATE NOCASE
        WHERE j.status = 'approval' AND e.reviewers IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM deployment_reviews d WHERE d.run_id = j.run_id AND d.environment = e.name COLLATE NOCASE)
        GROUP BY j.run_id, e.name ORDER BY since DESC LIMIT ?`,
      MAX_RECENT,
    )
    .toArray()
    .map((x): TodayDeployment => {
      const actor = parsePerson(x.actor);
      const self = x.prevent_self_review ? [actor.id, ...((x.prior_actors ? JSON.parse(x.prior_actors) : []) as string[])].filter((l): l is string => !!l) : [];
      return {
        runId: x.run_id,
        runNumber: x.run_number,
        workflow: x.workflow_name,
        title: x.display_title,
        ref: x.ref,
        environment: x.environment,
        reviewerIds: (JSON.parse(x.reviewers!) as Array<{ id: string }>).map((r) => r.id),
        selfBlocked: [...new Set(self)],
        actor: { id: actor.id, login: actor.login, kind: actor.kind },
        since: x.since,
      };
    });

  return { pulls, merged, releases, failedRuns, deployments };
}
