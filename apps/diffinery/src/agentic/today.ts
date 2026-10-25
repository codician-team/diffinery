import type { DiffineryEvent } from "@diffinery/shared";
import { myTaskJson, tasksFor, type MyTask } from "./tasks.js";
import type { Env } from "../env.js";
import type { Account, Directory, Repo } from "../lib/directory.js";
import { repoStub } from "../http/common.js";
import { atLeast } from "../repo/types.js";
import type { RepoToday, TodayDeployment, TodayMerged, TodayPerson, TodayPull, TodayRelease, TodayRun } from "./today-repo.js";

/**
 * Today: one person's morning view across every repository they can see.
 * What needs them (reviews, agent pull requests waiting for a human), what
 * their agents are doing, and what landed or failed in the last day.
 *
 * Each repository's Durable Object summarises itself (./today-repo.ts); this
 * file picks the repositories, gathers their summaries and sorts the items
 * for one viewer. `classify` is pure so the rules are unit tested.
 */

/** Visit at most this many repositories, the most recently active first. */
export const MAX_REPOS = 100;
/** Repositories with no activity for this long are skipped. */
export const ACTIVE_DAYS = 30;
/** "Since yesterday" looks back this far. */
export const SINCE_HOURS = 24;

export interface TodayRepo {
  id: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  visibility: string;
}

export type NeedsKind = "review_requested" | "agent_approval" | "changes_requested" | "checks_failing" | "conflicting";

export type AgentPullState = "draft" | "in_base" | "conflicting" | "landing" | "checks_failing" | "changes_requested" | "approved" | "checks_running" | "waiting_for_approval";

export interface NeedsItem {
  kind: NeedsKind;
  repo: TodayRepo;
  pull: TodayPull;
}

export interface AgentItem {
  state: AgentPullState;
  repo: TodayRepo;
  pull: TodayPull;
}

export interface Today {
  generatedAt: string;
  since: string;
  /** How many repositories were read, and whether some active ones were left out or failed to answer. */
  repositories: number;
  incomplete: boolean;
  needsYou: NeedsItem[];
  agentsAtWork: AgentItem[];
  landed: Array<{ repo: TodayRepo; pull: TodayMerged }>;
  releases: Array<{ repo: TodayRepo; release: TodayRelease }>;
  failures: Array<{ repo: TodayRepo; run: TodayRun }>;
  /** Deployments waiting for the viewer as one of an environment's required reviewers. */
  deployments: Array<{ repo: TodayRepo; deployment: TodayDeployment }>;
  /** Agent tasks you started (an agent: the tasks it runs) that are running or changed since `since`. */
  tasks: MyTask[];
}

/** Labels and badge tones, shared by the Today page (web.tsx) and the morning digest email (digest.ts). */
export const NEEDS_TEXT: Record<NeedsKind, { label: string; tone: string }> = {
  review_requested: { label: "Review requested", tone: "blue" },
  agent_approval: { label: "Agent PR needs a person's approval", tone: "purple" },
  changes_requested: { label: "Changes requested", tone: "amber" },
  checks_failing: { label: "Checks failing", tone: "red" },
  conflicting: { label: "Merge conflicts", tone: "amber" },
};

export const AGENT_TEXT: Record<AgentPullState, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "" },
  in_base: { label: "Already in its base branch", tone: "" },
  conflicting: { label: "Merge conflicts", tone: "amber" },
  landing: { label: "Landing", tone: "green" },
  checks_failing: { label: "Checks failing", tone: "red" },
  changes_requested: { label: "Changes requested", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  checks_running: { label: "Checks running", tone: "blue" },
  waiting_for_approval: { label: "Waiting for approval", tone: "purple" },
};

export const TASK_TEXT: Record<MyTask["state"], { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "" },
  running: { label: "Running", tone: "blue" },
  ready: { label: "Ready", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  stopped: { label: "Stopped", tone: "" },
};

export interface ClassifyInput {
  me: { id: string; login: string };
  /** Agents the viewer or their organizations own (and the viewer itself, when an agent asks). */
  agentIds: Set<string>;
  /** Agents the viewer owns themselves: a run one of them started is the viewer's own for prevent_self_review. */
  ownAgentIds?: Set<string>;
  /** Repositories where the viewer can approve (write or more). */
  writable: Set<string>;
  repos: Array<{ repo: TodayRepo; data: RepoToday }>;
}

const isAgent = (p: TodayPerson) => p.kind === "agent";
const byNewest = <T>(at: (x: T) => string) => (a: T, b: T) => at(b).localeCompare(at(a));

/**
 * Where an agent's open pull request stands, in the order a person would act on it. One whose head is
 * already in its base branch has nothing left to merge, and one with conflicts waits for its agent to
 * update it (auto-merge can't land it either), so neither waits for a person's approval.
 */
export function agentPullState(p: TodayPull): AgentPullState {
  if (p.draft) return "draft";
  if (p.mergeState === "in_base") return "in_base";
  if (p.mergeState === "conflicting") return "conflicting";
  if (p.queued || p.autoMerge) return "landing";
  if (p.checks === "failure") return "checks_failing";
  if (p.changesRequestedBy.length) return "changes_requested";
  if (p.approvedHead) return "approved";
  if (p.checks === "pending") return "checks_running";
  return "waiting_for_approval";
}

/** Repositories with an agent pull request that may be waiting for a person: only these need the viewer's role. */
export function approvalCandidates(repos: ClassifyInput["repos"], me: { id: string }): string[] {
  return repos.filter((r) => r.data.pulls.some((p) => isAgent(p.author) && p.author.id !== me.id && waitsForPerson(p))).map((r) => r.repo.id);
}

const waitsForPerson = (p: TodayPull) => ["waiting_for_approval", "checks_running"].includes(agentPullState(p));

export function classify(input: ClassifyInput): Omit<Today, "generatedAt" | "since" | "repositories" | "incomplete" | "tasks"> {
  const me = input.me.login.toLowerCase();
  const needsYou: NeedsItem[] = [];
  const agentsAtWork: AgentItem[] = [];
  const landed: Today["landed"] = [];
  const releases: Today["releases"] = [];
  const failures: Today["failures"] = [];
  const deployments: Today["deployments"] = [];
  for (const { repo, data } of input.repos) {
    for (const deployment of data.deployments ?? []) {
      const own = deployment.selfBlocked.some((id) => id === input.me.id || input.ownAgentIds?.has(id));
      if (deployment.reviewerIds.includes(input.me.id) && !own) deployments.push({ repo, deployment });
    }
    for (const pull of data.pulls) {
      const mine = pull.author.id === input.me.id;
      let need: NeedsKind | null = null;
      if (!pull.draft && !mine && pull.requestedReviewers.some((r) => r.toLowerCase() === me)) need = "review_requested";
      else if (!mine && isAgent(pull.author) && input.writable.has(repo.id) && waitsForPerson(pull)) need = "agent_approval";
      else if (mine && pull.changesRequestedBy.length) need = "changes_requested";
      else if (mine && pull.checks === "failure") need = "checks_failing";
      else if (mine && !pull.draft && pull.mergeState === "conflicting") need = "conflicting";
      if (need) needsYou.push({ kind: need, repo, pull });
      if (input.agentIds.has(pull.author.id)) agentsAtWork.push({ state: agentPullState(pull), repo, pull });
    }
    for (const pull of data.merged) landed.push({ repo, pull });
    for (const release of data.releases) releases.push({ repo, release });
    const defaultRef = `refs/heads/${repo.defaultBranch}`;
    for (const run of data.failedRuns) {
      const ours = run.actor.id === input.me.id || input.agentIds.has(run.actor.id);
      const onDefault = (run.ref === defaultRef || run.ref === repo.defaultBranch) && run.event !== "pull_request";
      if (ours || onDefault) failures.push({ repo, run });
    }
  }
  needsYou.sort(byNewest((x) => x.pull.updatedAt));
  agentsAtWork.sort(byNewest((x) => x.pull.updatedAt));
  landed.sort(byNewest((x) => x.pull.mergedAt));
  releases.sort(byNewest((x) => x.release.publishedAt));
  failures.sort(byNewest((x) => x.run.at));
  deployments.sort(byNewest((x) => x.deployment.since));
  return { needsYou, agentsAtWork, landed: landed.slice(0, 30), releases: releases.slice(0, 20), failures: failures.slice(0, 20), deployments: deployments.slice(0, 20) };
}

/** The repositories Today visits: not archived, active in the last ACTIVE_DAYS, most recent first. */
export function pickRepos(repos: Repo[], activity: Map<string, string>, now: Date): { repos: Repo[]; skipped: number } {
  const cutoff = new Date(now.getTime() - ACTIVE_DAYS * 86400_000).toISOString();
  const lastActive = (r: Repo) => [r.pushed_at ?? "", activity.get(r.id) ?? "", r.created_at].reduce((a, b) => (b > a ? b : a), "");
  const active = repos
    .filter((r) => !r.archived && lastActive(r) >= cutoff)
    .map((r) => ({ r, at: lastActive(r) }))
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((x) => x.r);
  return { repos: active.slice(0, MAX_REPOS), skipped: Math.max(0, active.length - MAX_REPOS) };
}

const repoRef = (r: Repo): TodayRepo => ({ id: r.id, fullName: `${r.owner_login}/${r.name}`, url: `/${r.owner_login}/${r.name}`, defaultBranch: r.default_branch, visibility: r.visibility });

/**
 * Gather Today for one account (a person, or an agent asking over the API or MCP).
 * `repoIds` limits it to the repositories a token is restricted to.
 */
export async function gatherToday(
  env: Env,
  dir: Directory,
  me: Account,
  opts: { repoIds?: string[] | null; now?: Date; since?: string; visible?: Promise<Repo[]>; orgs?: ReturnType<Directory["orgsFor"]> } = {},
): Promise<Today> {
  const now = opts.now ?? new Date();
  // The morning digest passes its own start: the last digest, which can be days ago after a weekend.
  const since = opts.since ?? new Date(now.getTime() - SINCE_HOURS * 3600_000).toISOString();
  const cutoff = new Date(now.getTime() - ACTIVE_DAYS * 86400_000).toISOString();
  // The caller (the dashboard) may already be reading these for itself.
  const [visible, orgs] = await Promise.all([opts.visible ?? dir.reposVisibleTo(me), me.kind === "user" ? (opts.orgs ?? dir.orgsFor(me.id)) : Promise.resolve([])]);
  // Activity of these repositories only, not of every repository active on the instance; the agents at the same time.
  const activity = new Map<string, string>();
  const chunks: string[][] = [];
  for (let i = 0; i < visible.length; i += 90) chunks.push(visible.slice(i, i + 90).map((r) => r.id));
  const owners = me.kind === "agent" ? [] : [me.id, ...orgs.map((o) => o.id)];
  const [found, agents] = await Promise.all([
    Promise.all(
      chunks.map((ids) =>
        env.DB.prepare(`SELECT repo_id, at FROM repo_activity WHERE repo_id IN (${ids.map(() => "?").join(", ")}) AND at >= ?`)
          .bind(...ids, cutoff)
          .all<{ repo_id: string; at: string }>(),
      ),
    ),
    dir.agentsOwnedBy(owners),
  ]);
  for (const rows of found) for (const r of rows.results) activity.set(r.repo_id, r.at);
  const allowed = opts.repoIds ? visible.filter((r) => opts.repoIds!.includes(r.id)) : visible;
  const { repos, skipped } = pickRepos(allowed, activity, now);
  const agentIds = new Set(agents.map((a) => a.id));
  const ownAgentIds = new Set(agents.filter((a) => a.owner_id === me.id).map((a) => a.id));
  if (me.kind === "agent") agentIds.add(me.id);

  const tasks = tasksFor(env, dir, me, { repoIds: opts.repoIds, since, activeOrSince: true, limit: 20 }).catch((e) => {
    console.error("today: tasks failed", e);
    return [] as MyTask[];
  });
  const settled = await Promise.allSettled(repos.map(async (r) => ({ repo: repoRef(r), data: await repoStub(env, r.id).todaySummary(since) })));
  const answered = settled.flatMap((s, i) => {
    if (s.status === "fulfilled") return [s.value];
    console.error("today: repository summary failed", repos[i]!.id, s.reason);
    return [];
  });

  const byId = new Map(repos.map((r) => [r.id, r]));
  const writable = new Set<string>();
  await Promise.all(
    // An agent's approval never counts, so nothing waits on an agent to approve.
    (me.kind === "agent" ? [] : approvalCandidates(answered, me)).map(async (id) => {
      if (atLeast(await dir.roleFor(me, byId.get(id)!), "write")) writable.add(id);
    }),
  );

  return {
    generatedAt: now.toISOString(),
    since,
    repositories: answered.length,
    incomplete: skipped > 0 || answered.length < repos.length,
    ...classify({ me, agentIds, ownAgentIds, writable, repos: answered }),
    tasks: await tasks,
  };
}

/** Remember when a repository last had activity (from the events queue), so Today finds it. Never throws. */
export async function recordActivity(env: Env, ev: DiffineryEvent): Promise<void> {
  if (ev.type === "audit" || !ev.repoId) return;
  try {
    await env.DB.prepare("INSERT INTO repo_activity (repo_id, at) VALUES (?, ?) ON CONFLICT(repo_id) DO UPDATE SET at = excluded.at WHERE excluded.at > repo_activity.at")
      .bind(ev.repoId, ev.at)
      .run();
  } catch (e) {
    console.error("today: recording activity failed", ev.repoId, e);
  }
}

// ---------------------------------------------------------------- JSON for the REST API and MCP

const person = (p: TodayPerson) => ({ login: p.login, type: p.kind === "agent" ? "Bot" : p.kind === "user" ? "User" : p.kind });

function pullJson(base: string, repo: TodayRepo, p: TodayPull) {
  return {
    repository: repo.fullName,
    number: p.number,
    title: p.title,
    html_url: `${base}${repo.url}/pull/${p.number}`,
    user: person(p.author),
    head: p.head,
    base: p.base,
    draft: p.draft,
    intent: p.intent,
    requested_reviewers: p.requestedReviewers,
    approved_by: p.approvedBy,
    approved_head: p.approvedHead,
    changes_requested_by: p.changesRequestedBy,
    checks: p.checks,
    failing_checks: p.failingChecks,
    auto_merge: p.autoMerge,
    in_merge_queue: p.queued,
    merge_state: p.mergeState ?? null,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

export function todayJson(base: string, t: Today) {
  return {
    generated_at: t.generatedAt,
    since: t.since,
    repositories: t.repositories,
    incomplete_results: t.incomplete,
    needs_you: t.needsYou.map((x) => ({ reason: x.kind, ...pullJson(base, x.repo, x.pull) })),
    agents_at_work: t.agentsAtWork.map((x) => ({ state: x.state, ...pullJson(base, x.repo, x.pull) })),
    landed: t.landed.map((x) => ({ repository: x.repo.fullName, number: x.pull.number, title: x.pull.title, html_url: `${base}${x.repo.url}/pull/${x.pull.number}`, user: person(x.pull.author), merged_by: x.pull.mergedBy, merged_at: x.pull.mergedAt })),
    releases: t.releases.map((x) => ({ repository: x.repo.fullName, tag_name: x.release.tag, name: x.release.name, prerelease: x.release.prerelease, html_url: `${base}${x.repo.url}/releases/tag/${encodeURIComponent(x.release.tag)}`, author: person(x.release.author), published_at: x.release.publishedAt })),
    tasks: t.tasks.map((x) => myTaskJson(base, x)),
    deployments_waiting: t.deployments.map((x) => ({ repository: x.repo.fullName, environment: x.deployment.environment, run_id: x.deployment.runId, run_number: x.deployment.runNumber, workflow: x.deployment.workflow, title: x.deployment.title, ref: x.deployment.ref, actor: person(x.deployment.actor), html_url: `${base}${x.repo.url}/actions/runs/${x.deployment.runId}`, waiting_since: x.deployment.since })),
    failures: t.failures.map((x) => ({ repository: x.repo.fullName, run_id: x.run.id, run_number: x.run.runNumber, workflow: x.run.workflow, title: x.run.title, ref: x.run.ref, event: x.run.event, conclusion: x.run.conclusion, html_url: `${base}${x.repo.url}/actions/runs/${x.run.id}`, actor: person(x.run.actor), pull_request: x.run.prNumber, completed_at: x.run.at })),
  };
}
