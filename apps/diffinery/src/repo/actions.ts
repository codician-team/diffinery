import { ZERO_OID, diffTrees, fromUtf8, isTreeMode, readCommit, readTree, resolvePath } from "@diffinery/git-core";
import type { Actor, Conclusion, Json, JobCompletion, JobSpec, JobUsage, LogLine, NeedsResult, StepReport } from "@diffinery/shared";
import {
  evaluateIf,
  evaluateValue,
  expandMatrix,
  interpolate,
  isWarning,
  jobOrder,
  matchesTrigger,
  parseWorkflow,
  type ExprContext,
  type Job,
  type StatusFns,
  type TriggerEvent,
  type Workflow,
} from "@diffinery/workflow-yaml";
import { decryptAndReseal, encryptSecret } from "../lib/crypto.js";
import { Directory } from "../lib/directory.js";
import { getFirst, headFirst, legacyArtifactKeys, legacyCacheKeys, logKeys } from "../lib/storage-keys.js";
import { permissionsForJob, type JobPermissions } from "../lib/job-permissions.js";
import { signRuntimeToken } from "../lib/runtime-auth.js";
import { ghRepo, numericId, uuidPattern } from "../http/gh.js";
import { HttpError, newId, noreplyEmail, now, randomToken, sha256 } from "../lib/util.js";
import { localOnly } from "../auth/dev.js";
import { egressFor, type Egress } from "../lib/egress.js";
import { endCompute, fleetLimits, mayStart, startCompute } from "../lib/quotas.js";
import { blockedBy, killSwitches, type Work } from "../lib/killswitch.js";
import type { Env } from "../env.js";
import type { RepoDO } from "./RepoDO.js";
import { completePayload } from "./event-payloads.js";
import { CACHE_IDLE_MS, CACHE_LIMIT_BYTES, artifactFileName, artifactObjectKeys } from "./runtime.js";
import { atLeast, type Caller } from "./types.js";
import { isJobCaller } from "./token-policy.js";
import { ReusableError, expandReusable, localKey, parseCallRef, type Expanded, type Source } from "./reusable.js";
import { ancestors, combineResults, jobStatus, runnerLabels, type JobNode } from "./job-graph.js";
import { schedulerStub } from "../lib/schedules.js";
import { APPROVAL_DAYS, type Deployment, type DeploymentReview, type Reviewer } from "./deployments.js";
import { referencedSecrets, RUNNER_SECRETS, secretsFor } from "./job-secrets.js";
import { chooseSize, cleanUsage, containerName, describeSize, LOOKBACK, RUNNER_SIZES, sizeLabel, sizeOfContainer, type RunnerSize, type SizedRun } from "../runner/sizes.js";

/** How long a sandbox token works after the sandbox starts. */
export const SANDBOX_TOKEN_TTL_MS = 24 * 3600_000;
/** A job token works this long past the job's timeout, so a runner can still report a job that hit it. */
const JOB_TOKEN_MARGIN_MS = 30 * 60_000;
/**
 * How long past its timeout-minutes (from when its runner fetched it) a running job may go without
 * reporting before Diffinery ends it itself. The runner stops a job at its timeout and reports within
 * seconds, or within CANCEL_GRACE_MS when steps run after the timeout (`if: always()`), so this only ends
 * jobs whose runner agent froze or vanished, which would otherwise hold their container, quota slot and
 * minutes for up to 6 hours.
 */
export const JOB_DEADLINE_GRACE_MS = 10 * 60_000;
/**
 * A cancelled hosted job's runner stops the step under way and then, like GitHub's, runs the steps that
 * run after a cancel (`if: always()`, `if: cancelled()`, post steps) for up to 5 minutes, so cleanup such
 * as deleting what the job created still happens. Diffinery waits this long for it to report (its 5
 * minutes, and time for the logs and the result), then stops its container and ends the job itself.
 */
export const CANCEL_STOP_MS = 7 * 60_000;
/**
 * A run finishes when its workflow (runner/workflow.ts) has had every job's completion event. An event
 * lost while the platform updates (completeJob's sendEvent failing during a deploy) leaves the workflow
 * waiting up to 6 hours, and a workflow instance that failed never finishes the run: either way the run
 * stays in progress and holds its concurrency group. Once every job of a run has been finished this long,
 * Diffinery sends the jobs' completion events again (repairStuckRuns), so the workflow carries on with
 * the rest of the graph.
 */
export const STUCK_RUN_MS = 5 * 60_000;
/**
 * A run still stuck this long after its last job finished, though its workflow got the events again, is
 * finished by Diffinery itself (a run whose workflow no longer runs, after STUCK_RUN_MS).
 */
export const STUCK_RUN_FINISH_MS = 30 * 60_000;
/** Workflow instance states in which the run's workflow can still finish the run itself. */
const LIVE_WORKFLOW = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);
/** timeout-minutes when a job row has none (GitHub's default). */
const DEFAULT_TIMEOUT_MINUTES = 360;
/** A job token never works longer than this after the job started (timeouts are at most 360 minutes). */
export const MAX_JOB_TOKEN_TTL_MS = 7 * 3600_000;

/**
 * When a job's token stops working, in ms since the epoch: its timeout plus a margin after the job
 * started (or, before it starts, after the token was issued), at most MAX_JOB_TOKEN_TTL_MS. The
 * Workflow that times jobs out normally ends the token first; this holds even if it never does.
 */
export function jobTokenExpiry(j: Pick<JobRow, "started_at" | "token_at" | "timeout_minutes">): number | null {
  const from = Date.parse(j.started_at ?? j.token_at ?? "");
  if (!Number.isFinite(from)) return null;
  const minutes = Math.max(Number(j.timeout_minutes) || 0, 0);
  return from + Math.min(minutes * 60_000 + JOB_TOKEN_MARGIN_MS, MAX_JOB_TOKEN_TTL_MS);
}
/** Sandboxes one person or agent may have open in a repository at once: their containers are shared by the whole instance. */
export const MAX_OPEN_SANDBOXES = 5;

const WORKFLOW_DIRS = [".github/workflows", ".diffinery/workflows"];
/** Characters of text a job's log keeps; the rest is dropped after a line saying so. */
export const MAX_JOB_LOG = 16 * 1048576;
/** Every push reads and parses a commit's workflow files: at most this many, each at most this large. */
export const MAX_WORKFLOW_FILES = 256;
/** Jobs in one run, counting each matrix leg and each job of a called workflow: keeps a run's rows and its RunWorkflow steps bounded. */
export const MAX_RUN_JOBS = 1000;
export const MAX_WORKFLOW_BYTES = 512 * 1024;
/**
 * A hosted job whose container never got a machine (the platform had none free, usually when many
 * jobs start at once or right after a deploy) goes back in line and starts again later, this many
 * times, before it fails. Only jobs whose runner never reported in: nothing of theirs has run.
 */
export const MAX_PLACEMENT_TRIES = 8;
/** Seconds before the next start of a job whose container got no machine: 30 s, doubling to 5 minutes. */
export const placementDelay = (tries: number): number => Math.min(30 * 2 ** (tries - 1), 300);
/**
 * A container the platform stops after it started but before its runner fetched the job (it happens
 * to a share of the containers a burst of jobs starts), or a start the runtime failed for a passing
 * reason (PASSING_START): nothing ran and little was billed, so the first time the job starts again
 * after QUICK_RETRY_SECONDS, not counted toward MAX_PLACEMENT_TRIES. Another one waits like any other
 * (placementDelay).
 */
export const QUICK_RETRIES = 1;
export const QUICK_RETRY_SECONDS = 5;
/**
 * While a deploy's container rollout updates instances, a new container can still start on the
 * previous runner image. A hosted runner that reports another image than the deployed one
 * (RUNNER_IMAGE) is turned away before it runs anything, and the job starts again after
 * STALE_IMAGE_RETRY_SECONDS, up to this many times (about 10 minutes, longer than a rollout takes);
 * after that it runs on whatever image it got rather than wait on a stuck rollout. These waits are
 * fixed and not counted toward MAX_PLACEMENT_TRIES: a rollout ends by itself within minutes, and
 * backing off past its end (30 s doubling) only made jobs start late.
 */
export const STALE_IMAGE_TRIES = 30;
export const STALE_IMAGE_RETRY_SECONDS = 20;
/**
 * A deploy's container rollout can stop a hosted runner while its job runs. A job stopped before
 * any of its steps but checkout ran is started again from the beginning on a new runner, this many
 * times. One stopped later fails instead and says so: its steps may have had effects (a deploy, a
 * publish) that running them again would repeat.
 */
export const MAX_RUNNER_RESTARTS = 2;
/**
 * A container start that failed on the platform's side and works when tried again: no machine free,
 * a container sidecar or Durable Object restarting under it (seen during rollouts as "Container
 * sidecar is shutting down"), a dropped connection to it, a container that didn't come up in time,
 * the runtime's own "internal error; reference = ..." (twice on 2026-10-24, on an End-to-end job
 * after a merge and on the Live test right after a deploy; re-runs started both at once), or the
 * job's new container object running out of memory in its own storage ("out of memory: SQLITE_NOMEM",
 * 2026-10-24 on a Typecheck job; its re-run started at once). The runtime marks other errors of its
 * own that pass as `retryable`.
 */
const RETRYABLE_START = /no container instance|is shutting down|network connection lost|durable object reset|no longer active|overloaded|too many containers|aborted waiting for container to start|container did not start after|internal error|out of memory|sqlite_nomem/i;
/**
 * Of those, the ones that say nothing about free machines (the runtime failing under one start): the
 * first is retried after QUICK_RETRY_SECONDS, like a fresh container's early stop, rather than waiting
 * out placementDelay as a full platform does.
 */
const PASSING_START = /network connection lost|durable object reset|no longer active|internal error|out of memory|sqlite_nomem/i;
/** Pauses before creating a run's workflow again after the platform failed the call (startOrchestration). */
const RUN_START_RETRY_MS = [1000, 3000];
/** Hosted containers one matrix starts at once: each start takes a couple of seconds. */
const START_AT_ONCE = 8;
/** Runs one repository may have unfinished at once; past it, new ones aren't started. */
export const MAX_ACTIVE_RUNS = 500;
/** Self-hosted runners one repository may have registered. */
export const MAX_RUNNERS = 100;
/** How long a runner registration token works, as on GitHub. */
const REGISTRATION_TTL_MS = 3600_000;
/** A runner that polled this recently shows as online. */
const RUNNER_ONLINE_MS = 90_000;

/** A hosted job admitted to start (Actions.admit), and what its container starts with. */
type Placement = { jobId: string; container: string; token: string; egress: Egress; vcpu: number };

type RunnerRow = { id: number; name: string; labels: string; token_hash: string | null; ephemeral: number; created_by: string; created_at: string; last_seen_at: string | null };

export interface RunnerInfo {
  id: number;
  name: string;
  os: string;
  status: "online" | "offline";
  busy: boolean;
  ephemeral: boolean;
  labels: Array<{ id: number; name: string; type: "read-only" | "custom" }>;
}
const SUPPORTED_LABEL = /^(ubuntu-.*|linux|diffinery(-.*)?|self-hosted|x64|amd64)$/i;

export type RunRow = {
  id: string;
  run_number: number;
  workflow_path: string;
  workflow_name: string;
  event: string;
  ref: string;
  sha: string;
  actor: string;
  status: "queued" | "in_progress" | "completed" | "waiting";
  conclusion: Conclusion | "timed_out" | null;
  created_at: string;
  updated_at: string;
  pr_number: number | null;
  attempt: number;
  event_payload: string;
  inputs: string;
  concurrency_group: string | null;
  display_title: string;
  /** Commit the run reports checks on, when it differs from `sha` (pull request runs). */
  head_sha: string | null;
  /** 1 when the code the run executes came from an agent; its jobs then act as an agent. */
  agent_origin?: number;
  /** Account ids that started earlier attempts of this run (JSON list), for prevent_self_review. */
  prior_actors?: string | null;
  /** What a partial re-run keeps from the attempt it re-runs (JSON RerunCarry); null for every other run. */
  rerun_carry?: string | null;
  /** Commits that the run's `owner/repo/path@ref` calls resolved to when it was planned (JSON, "repoId@ref" → sha). */
  call_refs?: string | null;
};

/**
 * What a partial re-run (failed jobs, or one job) keeps from the attempt it re-runs, per job key:
 * `all` of the key's job rows, or the `legs` that aren't re-run, by their matrix (canonicalJson).
 * startJobKey copies them into the new attempt instead of running them. Keys not listed run as usual.
 */
export type RerunCarry = Record<string, { all: string[] } | { legs: Record<string, string[]> }>;

/** Conclusions a partial re-run keeps; a job that ended any other way runs again with "re-run failed jobs". */
const KEPT_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

/** JSON with object keys sorted, so two equal matrix combinations compare equal. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export type JobRow = {
  id: string;
  run_id: string;
  job_key: string;
  name: string;
  /**
   * pending: held back by its concurrency group until the group's running job finishes.
   * approval: waiting on its environment's required reviewers or wait timer; nothing has started.
   */
  status: "queued" | "pending" | "approval" | "waiting" | "in_progress" | "completed";
  conclusion: Conclusion | "timed_out" | null;
  matrix: string;
  strategy: string;
  started_at: string | null;
  completed_at: string | null;
  outputs: string;
  steps: string;
  failure: string | null;
  token_hash: string | null;
  /** When token_hash was issued (null for tokens issued before it was recorded, until the schema backfills it). */
  token_at: string | null;
  summary: string | null;
  container: string | null;
  timeout_minutes: number;
  /** runs-on labels for self-hosted jobs (JSON array); null for Diffinery-hosted containers. */
  labels: string | null;
  /** `continue-on-error` as evaluated for this matrix leg (0 or 1). */
  continue_on_error: number;
  /** Job-level `concurrency` group as evaluated for this leg, and its cancel-in-progress (0 or 1). */
  concurrency_group: string | null;
  concurrency_cancel: number;
  log_chars: number;
  fleet_held: number;
  runner_id: number | null;
  /** `environment:` as evaluated at launch (null for jobs without one, and for jobs launched before it was stored). */
  environment: string | null;
  /** When the job started waiting on its environment's protection rules, and "released" once they passed. */
  gate_since: string | null;
  gate_state: string | null;
  placement_tries: number;
  early_stops: number;
  /** Times a runner on the previous image was turned away (STALE_IMAGE_TRIES), and when the job starts again, in ms since the epoch. */
  stale_tries?: number;
  image_retry_at?: number | null;
  runner_info: string | null;
  /** Set on a job a partial re-run copied from an earlier attempt: the job that actually ran. */
  carried_from?: string | null;
  /** When a running hosted job was cancelled (ms since the epoch) and why, while its runner finishes (CANCEL_STOP_MS). */
  cancel_at?: number | null;
  cancel_reason?: string | null;
  restarts: number;
  /** Hosted runner size runs-on asked for (runner/sizes.ts); null when it is chosen from the job's earlier runs. */
  runner_size?: string | null;
  /** The log line naming the size the job got and why. */
  size_note?: string | null;
  /** What the job used of its hosted runner (JSON JobUsage), as the runner measured it. */
  usage?: string | null;
};

/** Where a job ran, as its runner reported it: the runner image, the container's location and instance, and the host's processor. */
export type JobRunnerInfo = { image?: string; location?: string; instance?: string; cpu?: string };

/** Reads the runner's `x-diffinery-runner` header (JSON), keeping only short string fields. */
export function parseRunnerInfo(header: string | null | undefined): JobRunnerInfo | null {
  if (!header || header.length > 1000) return null;
  try {
    const raw = JSON.parse(header) as Record<string, unknown>;
    const out: JobRunnerInfo = {};
    for (const k of ["image", "location", "instance", "cpu"] as const) if (typeof raw[k] === "string" && raw[k]) out[k] = (raw[k] as string).slice(0, 200);
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** An environment a run's jobs wait on (GitHub's pending deployment). */
export type PendingDeployment = {
  environment: { id: number; name: string };
  waitTimer: number;
  waitTimerStartedAt: string;
  reviewers: Reviewer[];
  preventSelfReview: boolean;
  /** Still waiting for a required reviewer (false once approved, or when only a timer applies). */
  needsReview: boolean;
  currentUserCanApprove: boolean;
  /** The viewer is listed but started the run, and the environment prevents self-review. */
  selfBlocked: boolean;
};

export type RunInfo = {
  id: string;
  number: number;
  attempt: number;
  workflowPath: string;
  workflowName: string;
  title: string;
  event: string;
  ref: string;
  sha: string;
  /** The commit checks are reported on: the pull request head for pull_request runs. */
  headSha: string;
  /** Branch the run is about: the pull request's head branch for pull request runs. */
  headBranch: string;
  actor: Actor;
  status: RunRow["status"];
  conclusion: RunRow["conclusion"];
  createdAt: string;
  updatedAt: string;
  prNumber: number | null;
};

export type JobInfo = {
  id: string;
  runId: string;
  key: string;
  name: string;
  status: JobRow["status"];
  conclusion: JobRow["conclusion"];
  matrix: Record<string, Json>;
  startedAt: string | null;
  completedAt: string | null;
  outputs: Record<string, string>;
  steps: Array<StepReport & { index: number }>;
  failure: JobCompletion["failure"] | null;
  summary: string | null;
  /** The runner that took the job: a self-hosted runner's name, or the hosted container's name. */
  runnerName: string | null;
  runner: JobRunnerInfo | null;
  /** For a job a partial re-run kept from an earlier attempt (it didn't run again): the job that ran. */
  carriedFrom: string | null;
  /** Times a hosted job went back in line before a runner took it (no machine, or a runner on a replaced image). */
  placementTries: number;
  /** Times the platform replaced the job's runner before its steps ran, and the job started again. */
  restarts: number;
  /** A hosted job's runner size (runner/sizes.ts); null for self-hosted jobs and jobs not placed yet. */
  runnerSize: RunnerSize | null;
  /** What the job used of its hosted runner, as the runner measured it. */
  usage: JobUsage | null;
};

const toRun = (r: RunRow): RunInfo => ({
  id: r.id,
  number: r.run_number,
  attempt: r.attempt,
  workflowPath: r.workflow_path,
  workflowName: r.workflow_name,
  title: r.display_title,
  event: r.event,
  ref: r.ref,
  sha: r.sha,
  headSha: r.head_sha ?? r.sha,
  headBranch: (r.pr_number ? (JSON.parse(r.event_payload) as { pull_request?: { head?: { ref?: string } } }).pull_request?.head?.ref : undefined) ?? r.ref.replace(/^refs\/(heads|tags)\//, ""),
  actor: JSON.parse(r.actor),
  status: r.status,
  conclusion: r.conclusion,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  prNumber: r.pr_number,
});

const toJob = (j: JobRow): JobInfo => ({
  id: j.id,
  runId: j.run_id,
  key: j.job_key,
  name: j.name,
  status: j.status,
  conclusion: j.conclusion,
  matrix: JSON.parse(j.matrix),
  startedAt: j.started_at,
  completedAt: j.completed_at,
  outputs: JSON.parse(j.outputs),
  steps: JSON.parse(j.steps),
  failure: j.failure ? JSON.parse(j.failure) : null,
  summary: j.summary,
  runnerName: j.container?.replace(/^self-hosted:/, "") ?? null,
  runner: j.runner_info ? (JSON.parse(j.runner_info) as JobRunnerInfo) : null,
  carriedFrom: j.carried_from ?? null,
  placementTries: j.placement_tries ?? 0,
  restarts: j.restarts ?? 0,
  runnerSize: j.container && !j.container.startsWith("self-hosted:") ? sizeOfContainer(j.container) : null,
  usage: j.usage ? (JSON.parse(j.usage) as JobUsage) : null,
});

/**
 * GitHub Actions compatible run orchestration state. The Cloudflare Workflow
 * (`RunWorkflow`) drives a run through these methods; the runner agent inside
 * each job's container reports back through the runner* methods.
 */
export class Actions {
  constructor(
    private repo: RepoDO,
    private env: Env,
  ) {}

  private get sql() {
    return this.repo.sql;
  }

  // ---------------------------------------------------------------- workflow discovery

  async loadWorkflows(sha: string): Promise<Array<{ path: string; workflow?: Workflow; errors: string[] }>> {
    const commit = await readCommit(this.repo.store, sha);
    const out: Array<{ path: string; workflow?: Workflow; errors: string[] }> = [];
    for (const dir of WORKFLOW_DIRS) {
      const entry = await resolvePath(this.repo.store, commit.tree, dir);
      if (!entry || !isTreeMode(entry.mode)) continue;
      for (const f of await readTree(this.repo.store, entry.oid)) {
        if (!/\.ya?ml$/.test(f.name) || isTreeMode(f.mode)) continue;
        if (out.length >= MAX_WORKFLOW_FILES) break;
        const path = `${dir}/${f.name}`;
        if ((this.repo.store.size(f.oid) ?? 0) > MAX_WORKFLOW_BYTES) {
          out.push({ path, errors: [`: the workflow file is larger than ${MAX_WORKFLOW_BYTES / 1024} KiB`] });
          continue;
        }
        const o = await this.repo.store.read(f.oid);
        if (!o) continue;
        const { workflow, errors } = parseWorkflow(fromUtf8(o.content), path);
        out.push({ path, workflow, errors: errors.filter((e) => !isWarning(e)).map((e) => `${e.path}${e.line ? `:${e.line}` : ""}: ${e.message}`) });
      }
    }
    return out;
  }

  async listWorkflows(): Promise<Array<{ path: string; name: string; errors: string[]; triggers: string[] }>> {
    const sha = await this.repo.resolve("HEAD");
    if (!sha) return [];
    return (await this.loadWorkflows(sha)).map((w) => ({ path: w.path, name: w.workflow?.name ?? w.path.split("/").pop()!, errors: w.errors, triggers: w.workflow ? Object.keys(w.workflow.on) : [] }));
  }

  /** The `repository` object of event payloads: GitHub's shape, with the repository's real visibility. */
  async repositoryPayload(): Promise<Record<string, unknown>> {
    const m = this.repo.meta;
    const row = await new Directory(this.env).repoById(m.repoId);
    if (row) return ghRepo(this.env.PUBLIC_URL, row);
    return { id: numericId(m.repoId), name: m.name, full_name: `${m.owner}/${m.name}`, owner: { login: m.owner }, default_branch: m.defaultBranch, private: true, visibility: "private", html_url: `${this.env.PUBLIC_URL}/${m.owner}/${m.name}`, clone_url: `${this.env.PUBLIC_URL}/${m.owner}/${m.name}.git` };
  }

  // ---------------------------------------------------------------- triggers

  async onPush(ev: { ref: string; before: string; after: string; forced: boolean; created: boolean; deleted: boolean }, caller: Caller): Promise<void> {
    if (ev.deleted) return;
    const workflows = await this.loadWorkflows(ev.after);
    let changedFiles: string[] | undefined;
    if (ev.before !== ZERO_OID && this.repo.store.has(ev.before)) {
      const [a, b] = await Promise.all([readCommit(this.repo.store, ev.before), readCommit(this.repo.store, ev.after)]);
      changedFiles = (await diffTrees(this.repo.store, a.tree, b.tree)).map((c) => c.path);
    }
    const head = await readCommit(this.repo.store, ev.after);
    const payload = {
      ref: ev.ref,
      before: ev.before,
      after: ev.after,
      created: ev.created,
      deleted: ev.deleted,
      forced: ev.forced,
      repository: await this.repositoryPayload(),
      pusher: { name: caller.login },
      sender: { login: caller.login, type: caller.kind === "agent" ? "Bot" : "User" },
      head_commit: { id: ev.after, message: head.message, timestamp: new Date(head.committer.timestamp * 1000).toISOString(), author: { name: head.author.name, email: head.author.email } },
      commits: [{ id: ev.after, message: head.message }],
    };
    if (ev.ref === `refs/heads/${this.repo.meta.defaultBranch}`) await this.syncSchedules(workflows);
    for (const w of workflows) {
      if (!w.workflow) {
        if (w.errors.length) await this.createFailedRun(w.path, "push", ev.ref, ev.after, caller, w.errors);
        continue;
      }
      if (!matchesTrigger(w.workflow, { name: "push", ref: ev.ref, changedFiles })) continue;
      await this.createRun(w.workflow, { event: "push", ref: ev.ref, sha: ev.after, payload, caller, title: head.message.split("\n")[0] ?? "" });
    }
  }

  /**
   * Pull request workflows, like GitHub's: `pull_request` runs the workflow from the test
   * merge commit (`refs/pull/<n>/merge`, the head merged into the base; nothing runs while
   * they conflict), and `pull_request_target` runs the base branch's own workflow on the
   * base commit, so a pull request can never change what runs with the base's secrets.
   * Both report their checks on the pull request's head commit.
   */
  async onPullRequest(action: string, number: number, caller: Caller): Promise<void> {
    const { issue } = this.repo.collab.get(number);
    const pull = issue.pull!;
    // Once merged, the base already holds the changes: keep the refs as they were and let path filters pass.
    const { baseSha, mergeSha } = pull.merged ? { baseSha: this.repo.getRef(`refs/heads/${pull.base}`), mergeSha: null } : await this.repo.collab.refreshPullRefs(number);
    const changedFiles = pull.merged ? undefined : (await this.repo.collab.pullFiles(number)).files.map((f) => f.path);
    const m = this.repo.meta;
    const repository = await this.repositoryPayload();
    const payload = {
      action,
      number,
      pull_request: {
        number,
        id: number,
        state: issue.state,
        title: issue.title,
        body: issue.body,
        draft: pull.draft,
        merged: pull.merged,
        merged_at: pull.mergedAt,
        merged_by: pull.mergedBy ? { login: pull.mergedBy } : null,
        merge_commit_sha: pull.merged ? pull.mergeCommit : mergeSha,
        user: { login: issue.author.login },
        labels: issue.labels.map((name) => ({ name })),
        assignees: issue.assignees.map((login) => ({ login })),
        head: { ref: pull.head, sha: pull.headSha, repo: repository },
        base: { ref: pull.base, sha: baseSha, repo: repository },
        html_url: `${this.env.PUBLIC_URL}/${m.owner}/${m.name}/pull/${number}`,
        url: `${this.env.PUBLIC_URL}/api/v3/repos/${m.owner}/${m.name}/pulls/${number}`,
      },
      repository,
      sender: { login: caller.login },
    };
    const common = { payload, caller, prNumber: number, headSha: pull.headSha, headRef: pull.head, baseRef: pull.base, title: issue.title };
    // A merged pull request's runs use its merge commit, as on GitHub.
    const prSha = pull.merged ? pull.mergeCommit : mergeSha;
    if (prSha) {
      for (const w of await this.loadWorkflows(prSha)) {
        if (!w.workflow || !matchesTrigger(w.workflow, { name: "pull_request", action, baseRef: pull.base, changedFiles })) continue;
        await this.createRun(w.workflow, { ...common, event: "pull_request", ref: `refs/pull/${number}/merge`, sha: prSha });
      }
    }
    if (baseSha) {
      for (const w of await this.loadWorkflows(baseSha)) {
        if (!w.workflow || !matchesTrigger(w.workflow, { name: "pull_request_target", action, baseRef: pull.base, changedFiles })) continue;
        await this.createRun(w.workflow, { ...common, event: "pull_request_target", ref: `refs/heads/${pull.base}`, sha: baseSha });
      }
    }
  }

  /** `merge_group` workflows for a merge queue group, run from the group's commit. */
  async onMergeGroup(g: { number: number; base: string; ref: string; sha: string; parent: string; title: string; sender: Actor }): Promise<void> {
    const head = await readCommit(this.repo.store, g.sha);
    const payload = {
      action: "checks_requested",
      merge_group: {
        head_sha: g.sha,
        head_ref: g.ref,
        base_sha: g.parent,
        base_ref: `refs/heads/${g.base}`,
        head_commit: {
          id: g.sha,
          tree_id: head.tree,
          message: head.message,
          timestamp: new Date(head.committer.timestamp * 1000).toISOString(),
          author: { name: head.author.name, email: head.author.email },
          committer: { name: head.committer.name, email: head.committer.email },
        },
      },
      repository: await this.repositoryPayload(),
      sender: { login: g.sender.login },
    };
    for (const w of await this.loadWorkflows(g.sha)) {
      if (!w.workflow) {
        if (w.errors.length) await this.createFailedRun(w.path, "merge_group", g.ref, g.sha, g.sender, w.errors);
        continue;
      }
      if (!matchesTrigger(w.workflow, { name: "merge_group", action: "checks_requested", baseRef: g.base })) continue;
      await this.createRun(w.workflow, { event: "merge_group", ref: g.ref, sha: g.sha, payload, caller: g.sender, title: `Merge group for #${g.number}: ${g.title}`, prNumbers: [g.number] });
    }
  }

  /** Cancel unfinished runs on a ref (a merge group branch that is going away). */
  async cancelRunsOnRef(ref: string, reason: string): Promise<void> {
    for (const r of this.sql.exec<{ id: string }>("SELECT id FROM runs WHERE ref = ? AND status != 'completed'", ref).toArray()) await this.cancelInternal(r.id, reason);
  }

  async dispatch(workflowFile: string, ref: string, inputs: Record<string, unknown>, caller: Caller): Promise<RunInfo> {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "write access is required to run workflows");
    await this.refuseIfBlocked("run");
    const sha = await this.repo.resolve(ref);
    if (!sha) throw new HttpError(422, `unknown ref ${ref}`);
    const all = await this.loadWorkflows(sha);
    const w = all.find((x) => x.path === workflowFile || x.path.endsWith(`/${workflowFile}`));
    if (!w?.workflow) throw new HttpError(404, `workflow ${workflowFile} not found at ${ref}${w?.errors.length ? `: ${w.errors.join("; ")}` : ""}`);
    if (!w.workflow.on.workflow_dispatch) throw new HttpError(422, "workflow does not have a workflow_dispatch trigger");
    const defs = w.workflow.on.workflow_dispatch.inputs ?? {};
    const resolved: Record<string, unknown> = {};
    for (const [k, d] of Object.entries(defs)) {
      const v = inputs[k] ?? d.default;
      if (d.required && (v === undefined || v === "")) throw new HttpError(422, `input '${k}' is required`);
      if (d.type === "choice" && d.options && v !== undefined && !d.options.includes(String(v))) throw new HttpError(422, `input '${k}' must be one of ${d.options.join(", ")}`);
      resolved[k] = d.type === "boolean" ? v === true || v === "true" : d.type === "number" ? Number(v) : v;
    }
    const fullRef = ref.startsWith("refs/") ? ref : this.repo.getRef(`refs/heads/${ref}`) ? `refs/heads/${ref}` : `refs/tags/${ref}`;
    const payload = { inputs: resolved, ref: fullRef, repository: await this.repositoryPayload(), sender: { login: caller.login }, workflow: w.path };
    const m = this.repo.meta;
    this.repo.emit({ type: "workflow_dispatch", repoId: m.repoId, owner: m.owner, repo: m.name, ref: fullRef, workflow: w.path, inputs: resolved as Record<string, Json>, actor: { id: caller.id, login: caller.login, kind: caller.kind, onBehalfOf: caller.onBehalfOf }, at: now() });
    return (await this.createRun(w.workflow, { event: "workflow_dispatch", ref: fullRef, sha, payload, caller, inputs: resolved, title: w.workflow.name ?? w.path }))!;
  }

  async schedule(workflowPath: string, cron: string): Promise<void> {
    const sha = await this.repo.resolve("HEAD");
    if (!sha) return;
    const w = (await this.loadWorkflows(sha)).find((x) => x.path === workflowPath);
    if (!w?.workflow || !matchesTrigger(w.workflow, { name: "schedule", cron })) return;
    const system: Caller = { id: "system", login: "diffinery-scheduler", kind: "system", role: "write" };
    await this.createRun(w.workflow, { event: "schedule", ref: this.repo.headRef, sha, payload: { schedule: cron, repository: await this.repositoryPayload() }, caller: system, title: w.workflow.name ?? w.path });
  }

  private async syncSchedules(workflows: Array<{ path: string; workflow?: Workflow }>): Promise<void> {
    const repoId = this.repo.meta.repoId;
    const stmts = [this.env.DB.prepare("DELETE FROM schedules WHERE repo_id = ?").bind(repoId)];
    for (const w of workflows) for (const s of w.workflow?.on.schedule ?? []) stmts.push(this.env.DB.prepare("INSERT OR IGNORE INTO schedules (repo_id, workflow_path, cron) VALUES (?, ?, ?)").bind(repoId, w.path, s.cron));
    await this.env.DB.batch(stmts);
    // The scheduler's alarm starts with the first schedule, without waiting for the cron trigger.
    if (stmts.length > 1) await schedulerStub(this.env).ensure().catch((e) => console.error("scheduler alarm check failed", e));
  }

  // ---------------------------------------------------------------- runs

  private nextRunNumber(): number {
    this.sql.exec("INSERT INTO counters (name, value) VALUES ('run', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1");
    return this.sql.exec<{ value: number }>("SELECT value FROM counters WHERE name = 'run'").one().value;
  }

  private githubContext(run: RunRow, jobKey: string, token: string): Record<string, unknown> {
    const m = this.repo.meta;
    const payload = JSON.parse(run.event_payload) as Record<string, unknown>;
    const actor = JSON.parse(run.actor) as Actor;
    const refName = run.ref.replace(/^refs\/(heads|tags)\//, "").replace(/^refs\/pull\/(\d+)\/(head|merge)$/, "$1/merge");
    const pr = payload.pull_request as { head?: { ref?: string }; base?: { ref?: string } } | undefined;
    return {
      event_name: run.event,
      event: payload,
      sha: run.sha,
      ref: run.ref,
      ref_name: refName,
      ref_type: run.ref.startsWith("refs/tags/") ? "tag" : "branch",
      ref_protected: false,
      head_ref: pr?.head?.ref ?? "",
      base_ref: pr?.base?.ref ?? "",
      repository: `${m.owner}/${m.name}`,
      repository_id: String(numericId(m.repoId)),
      repository_owner: m.owner,
      repositoryUrl: `${this.env.PUBLIC_URL}/${m.owner}/${m.name}.git`,
      actor: actor.login,
      triggering_actor: actor.login,
      // Numeric like GitHub's (actions parse it, e.g. download-artifact's run-id); the API accepts it as a run id.
      run_id: String(run.run_number),
      run_number: String(run.run_number),
      run_attempt: String(run.attempt),
      workflow: run.workflow_name,
      workflow_ref: `${m.owner}/${m.name}/${run.workflow_path}@${run.ref}`,
      job: jobKey,
      server_url: this.env.PUBLIC_URL,
      api_url: `${this.env.PUBLIC_URL}/api/v3`,
      graphql_url: `${this.env.PUBLIC_URL}/api/graphql`,
      token,
      retention_days: "90",
      secret_source: "Actions",
    };
  }

  private async createFailedRun(path: string, event: string, ref: string, sha: string, caller: Actor, errors: string[]): Promise<void> {
    // While Actions are suspended no run is recorded, not even a failed one.
    if (await this.blocked("run")) return;
    const id = newId();
    const t = now();
    this.sql.exec(
      "INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, conclusion, created_at, updated_at, event_payload, display_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'failure', ?, ?, ?, ?)",
      id,
      this.nextRunNumber(),
      path,
      path,
      event,
      ref,
      sha,
      JSON.stringify({ id: caller.id, login: caller.login, kind: caller.kind }),
      t,
      t,
      "{}",
      `Invalid workflow file: ${errors[0] ?? path}`,
    );
    const jobId = newId();
    this.sql.exec(
      "INSERT INTO jobs (id, run_id, job_key, name, status, conclusion, started_at, completed_at, failure) VALUES (?, ?, 'invalid', 'Invalid workflow file', 'completed', 'failure', ?, ?, ?)",
      jobId,
      id,
      t,
      t,
      JSON.stringify({ message: errors.join("\n") }),
    );
  }

  async createRun(
    wf: Workflow,
    o: {
      event: string;
      ref: string;
      sha: string;
      headSha?: string;
      payload: Record<string, unknown>;
      caller: Caller | { id: string; login: string; kind: Actor["kind"] };
      prNumber?: number;
      inputs?: Record<string, unknown>;
      headRef?: string;
      baseRef?: string;
      title: string;
      /** Started by a run whose code came from an agent (a re-run, or a workflow_run follower). */
      agentOrigin?: boolean;
      /** Pull requests whose code the run includes (a merge group's). */
      prNumbers?: number[];
      /** A new attempt of an existing run: its number, attempt, earlier actors and what it keeps (rerun). */
      rerun?: { runNumber: number; attempt: number; priorActors: string[]; carry: RerunCarry | null };
    },
  ): Promise<RunInfo | null> {
    // Like GitHub, what a job does with its GITHUB_TOKEN (pushes, pull requests) starts no new
    // runs, so workflows cannot trigger themselves in a loop; workflow_dispatch and
    // repository_dispatch are the exceptions.
    if (isJobCaller(o.caller) && o.event !== "workflow_dispatch" && o.event !== "repository_dispatch") return null;
    // A site administrator suspended Actions here (lib/killswitch.ts): events start nothing, and a
    // dispatch, which someone asked for, is refused with the reason.
    const block = await this.blocked("run");
    if (block) {
      if (o.event === "workflow_dispatch" || o.event === "repository_dispatch") throw new HttpError(403, block);
      return null;
    }
    // A dispatch loop (or a flood of pushes) stops growing here.
    const active = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM runs WHERE status != 'completed'").one().n;
    if (active >= MAX_ACTIVE_RUNS) {
      if (o.event === "workflow_dispatch" || o.event === "repository_dispatch") throw new HttpError(429, `this repository has ${active} unfinished workflow runs, the most allowed; wait for some to finish`);
      console.warn(`not starting ${wf.path}: ${active} unfinished runs`);
      return null;
    }
    const id = newId();
    const t = now();
    const run: RunRow = {
      id,
      run_number: o.rerun?.runNumber ?? this.nextRunNumber(),
      workflow_path: wf.path,
      workflow_name: wf.name ?? wf.path,
      event: o.event,
      ref: o.ref,
      sha: o.sha,
      actor: JSON.stringify({ id: o.caller.id, login: o.caller.login, kind: o.caller.kind }),
      status: "queued",
      conclusion: null,
      created_at: t,
      updated_at: t,
      pr_number: o.prNumber ?? null,
      attempt: o.rerun?.attempt ?? 1,
      event_payload: JSON.stringify(completePayload({ publicUrl: this.env.PUBLIC_URL, meta: this.repo.meta, visibility: (o.payload.repository as { visibility?: string } | undefined)?.visibility === "public" ? "public" : "private" }, o.payload, o.caller)),
      inputs: JSON.stringify(o.inputs ?? {}),
      concurrency_group: null,
      display_title: o.title,
      head_sha: o.headSha && o.headSha !== o.sha ? o.headSha : null,
      agent_origin: (await this.repo.policy.agentOrigin({
        caller: o.caller,
        ref: o.ref,
        sha: o.sha,
        prNumbers: [...(o.prNumber !== undefined ? [o.prNumber] : []), ...(o.prNumbers ?? [])],
        inherited: o.agentOrigin,
      }))
        ? 1
        : 0,
      prior_actors: o.rerun ? JSON.stringify(o.rerun.priorActors) : null,
      rerun_carry: o.rerun?.carry ? JSON.stringify(o.rerun.carry) : null,
    };
    const ctx: ExprContext = { github: this.githubContext(run, "", ""), inputs: o.inputs ?? {}, vars: this.variables() };
    try {
      if (wf.runName) run.display_title = interpolate(wf.runName, ctx);
      if (wf.concurrency) run.concurrency_group = interpolate(wf.concurrency.group, ctx);
    } catch (e) {
      console.warn("run-name/concurrency evaluation failed", e);
    }
    this.sql.exec(
      "INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, pr_number, attempt, event_payload, inputs, concurrency_group, display_title, head_sha, agent_origin, prior_actors, rerun_carry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      run.id,
      run.run_number,
      run.workflow_path,
      run.workflow_name,
      run.event,
      run.ref,
      run.sha,
      run.actor,
      run.status,
      run.created_at,
      run.updated_at,
      run.pr_number,
      run.attempt,
      run.event_payload,
      run.inputs,
      run.concurrency_group,
      run.display_title,
      run.head_sha,
      run.agent_origin ?? 0,
      run.prior_actors ?? null,
      run.rerun_carry ?? null,
    );
    if (run.concurrency_group && wf.concurrency) {
      const cancelInProgress = evaluateValue(wf.concurrency.cancelInProgress, ctx);
      const others = this.sql.exec<{ id: string; ref: string }>("SELECT id, ref FROM runs WHERE concurrency_group = ? AND status != 'completed' AND id != ?", run.concurrency_group, id).toArray();
      // A run the newcomer may not cancel stays, and the newcomer waits for it like any run in the group.
      if (cancelInProgress === true || cancelInProgress === "true") {
        for (const other of others) if (this.mayCancel(run, other)) await this.cancelInternal(other.id, "cancelled by a newer run in the same concurrency group");
      } else await this.replaceWaiting(run);
    }
    const orchestration = await this.startOrchestration(id);
    if (orchestration) {
      // Without its workflow nothing would ever start or finish the run (it stayed queued, even when
      // cancelled): it fails now, saying why, and can be re-run.
      await this.plannedError(id, `Diffinery couldn't start this run (${orchestration}). Re-run the workflow.`);
      await this.finishRun(id);
      return toRun(this.runRow(id));
    }
    const m = this.repo.meta;
    this.repo.emit({ type: "workflow_run", action: "requested", repoId: m.repoId, owner: m.owner, repo: m.name, runId: id, actor: JSON.parse(run.actor), at: t });
    this.repo.broadcast("runs", { action: "created", runId: id });
    await this.onWorkflowRun(run, "requested");
    return toRun(run);
  }

  /**
   * Creates the run's workflow (RunWorkflow), trying again after RUN_START_RETRY_MS each when the
   * platform fails the call (2026-10-22 and 24: "End-to-end" runs that stayed queued until a newer
   * push replaced them). A call that failed although the workflow was created counts as created.
   * Returns null once it runs, or why it couldn't be started.
   */
  private async startOrchestration(id: string): Promise<string | null> {
    let why = "";
    for (let i = 0; i <= RUN_START_RETRY_MS.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, RUN_START_RETRY_MS[i - 1]));
      try {
        await this.env.RUN_WORKFLOW.create({ id, params: { repoId: this.repo.meta.repoId, runId: id } });
        return null;
      } catch (e) {
        why = (e as Error).message;
        console.error("could not create a run's workflow", id, e);
      }
      try {
        await (await this.env.RUN_WORKFLOW.get(id)).status();
        return null;
      } catch {
        // Not created: try again.
      }
    }
    return why;
  }

  /** A run by id, its REST API number (http/gh.ts uuidNumber), or its run number (github.run_id; the latest attempt). */
  private runRow(id: string): RunRow {
    const pattern = uuidPattern(id);
    const r = pattern
      ? this.sql.exec<RunRow>("SELECT * FROM runs WHERE id GLOB ? ORDER BY created_at DESC LIMIT 1", pattern).toArray()[0]
      : /^\d+$/.test(id)
        ? this.sql.exec<RunRow>("SELECT * FROM runs WHERE run_number = ? ORDER BY attempt DESC, created_at DESC LIMIT 1", Number(id)).toArray()[0]
        : this.sql.exec<RunRow>("SELECT * FROM runs WHERE id = ?", id).toArray()[0];
    if (!r) throw new HttpError(404, "run not found");
    return r;
  }

  /** A job by id or its REST API number (http/gh.ts uuidNumber). */
  private jobRow(id: string): JobRow {
    const pattern = uuidPattern(id);
    const j = pattern
      ? this.sql.exec<JobRow>("SELECT * FROM jobs WHERE id GLOB ? ORDER BY rowid DESC LIMIT 1", pattern).toArray()[0]
      : this.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", id).toArray()[0];
    if (!j) throw new HttpError(404, "job not found");
    return j;
  }

  listRuns(opts: { workflow?: string; branch?: string; status?: string; event?: string; sha?: string; prNumber?: number; limit?: number; offset?: number } = {}): { runs: RunInfo[]; total: number } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.workflow) {
      where.push("(workflow_path = ? OR workflow_path LIKE ?)");
      args.push(opts.workflow, `%/${opts.workflow}`);
    }
    if (opts.branch) {
      where.push("ref = ?");
      args.push(`refs/heads/${opts.branch}`);
    }
    if (opts.status) {
      where.push(opts.status === "completed" || opts.status === "queued" || opts.status === "in_progress" ? "status = ?" : "conclusion = ?");
      args.push(opts.status);
    }
    if (opts.event) {
      where.push("event = ?");
      args.push(opts.event);
    }
    if (opts.sha) {
      where.push("(sha = ? OR head_sha = ?)");
      args.push(opts.sha, opts.sha);
    }
    if (opts.prNumber) {
      where.push("pr_number = ?");
      args.push(opts.prNumber);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM runs ${w}`, ...args).one().n;
    const rows = this.sql.exec<RunRow>(`SELECT * FROM runs ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...args, Math.min(opts.limit ?? 25, 100), opts.offset ?? 0).toArray();
    return { runs: rows.map(toRun), total };
  }

  getRun(id: string): RunInfo & { jobs: JobInfo[] } {
    const run = this.runRow(id);
    return { ...toRun(run), jobs: this.jobs(run.id) };
  }

  jobs(runId: string): JobInfo[] {
    if (/^\d+$/.test(runId)) runId = this.runRow(runId).id;
    return this.sql.exec<JobRow>("SELECT * FROM jobs WHERE run_id = ? ORDER BY rowid", runId).toArray().map(toJob);
  }

  getJob(id: string): JobInfo {
    return toJob(this.jobRow(id));
  }

  async logs(jobId: string, afterSeq = -1): Promise<{ lines: Array<LogLine & { seq: number }>; complete: boolean }> {
    const j = this.jobRow(jobId);
    // A job a partial re-run kept from an earlier attempt shows the log of the job that ran.
    jobId = j.carried_from ?? j.id;
    const rows = this.sql.exec<LogLine & { seq: number }>("SELECT seq, t, step, text FROM logs WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT 5000", jobId, afterSeq).toArray();
    if (rows.length === 0 && j.status === "completed") {
      const archived = await getFirst(this.env.BUCKET, logKeys(this.repo.meta.repoId, jobId));
      if (archived && afterSeq < 0) return { lines: (await archived.json()) as Array<LogLine & { seq: number }>, complete: true };
    }
    return { lines: rows, complete: j.status === "completed" };
  }

  private logKey(jobId: string) {
    return logKeys(this.repo.meta.repoId, jobId)[0];
  }

  // ---------------------------------------------------------------- orchestration (called by RunWorkflow)

  /**
   * The run's job graph: each job with the jobs it waits for (reusable workflow calls
   * expanded). RunWorkflow starts a job as soon as its own needs have finished.
   */
  async plan(runId: string): Promise<{ jobs: JobNode[]; error?: string; concurrencyBlocked: boolean }> {
    const run = this.runRow(runId);
    if (run.status === "completed") return { jobs: [], error: "run already completed", concurrencyBlocked: false };
    let exp: Expanded;
    try {
      exp = await this.expanded(run);
    } catch (e) {
      return { jobs: [], error: (e as Error).message, concurrencyBlocked: false };
    }
    const { order, errors } = jobOrder(exp.workflow);
    if (errors.length) return { jobs: [], error: errors.map((e) => e.message).join("; "), concurrencyBlocked: false };
    if (order.flat().length > MAX_RUN_JOBS) return { jobs: [], error: `A run may have at most ${MAX_RUN_JOBS} jobs, those of called workflows included; this one has ${order.flat().length}.`, concurrencyBlocked: false };
    if (run.concurrency_group) {
      // Runs that waited in the group before newer runs replaced older ones: the newest replaces them now.
      const newest = this.sql.exec<RunRow>("SELECT * FROM runs WHERE concurrency_group = ? AND status = 'queued' AND conclusion IS NULL ORDER BY rowid DESC LIMIT 1", run.concurrency_group).toArray()[0];
      if (newest && newest.id !== run.id) await this.replaceWaiting(newest);
    }
    // Cancelled while it waited for its group: none of its jobs will run, so it finishes now instead of waiting its turn.
    if (this.runRow(runId).conclusion === "cancelled") return { jobs: [], concurrencyBlocked: false };
    const holders = () => (run.concurrency_group ? this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM runs WHERE concurrency_group = ? AND status = 'in_progress' AND id != ?", run.concurrency_group, runId).one().n : 0);
    // A run holding the group may be stuck though its jobs all finished (STUCK_RUN_MS): repair it rather than wait behind it.
    if (holders()) await this.repairStuckRuns();
    const blocked = holders() > 0;
    if (!blocked) this.sql.exec("UPDATE runs SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'queued'", now(), runId);
    return { jobs: order.flat().map((key) => ({ key, needs: exp.workflow.jobs[key]!.needs })), concurrencyBlocked: blocked };
  }

  /** The run's workflow with reusable workflow calls expanded (see ./reusable.ts). */
  private async expanded(run: RunRow): Promise<Expanded> {
    const wf = (await this.loadWorkflows(run.sha)).find((w) => w.path === run.workflow_path);
    if (!wf?.workflow) throw new ReusableError(`workflow file not found or invalid: ${wf?.errors.join("; ") || run.workflow_path}`);
    // A called workflow named by branch or tag runs the commit it pointed at when the run was planned, so a job
    // that waits for approval runs the steps that were approved, however the branch moves meanwhile.
    const saved = this.sql.exec<{ call_refs: string | null }>("SELECT call_refs FROM runs WHERE id = ?", run.id).toArray()[0]?.call_refs;
    const pinned: Record<string, string> = saved ? JSON.parse(saved) : {};
    const before = Object.keys(pinned).length;
    try {
      return await expandReusable(wf.workflow, { repoId: null, sha: run.sha }, (uses, from) => this.loadCalled(uses, from, pinned));
    } finally {
      // Kept even when a later call fails, so the next expansion (a re-plan while the run waits) sees the same commits.
      if (Object.keys(pinned).length !== before) this.sql.exec("UPDATE runs SET call_refs = ? WHERE id = ?", JSON.stringify(pinned), run.id);
    }
  }

  /** Load a called workflow: `./path` from the same commit, or `owner/repo/path@ref` from a repository on this instance. */
  private async loadCalled(uses: string, from: Source, pinned: Record<string, string> = {}): Promise<{ workflow: Workflow; source: Source }> {
    const ref = parseCallRef(uses);
    const m = this.repo.meta;
    let source: Source;
    let text: string | null;
    if (ref.kind === "local" && from.repoId === null) {
      source = from;
      const b = await this.repo.blob(from.sha, ref.path);
      text = b && !b.binary ? fromUtf8(b.content) : null;
    } else {
      let repoId: string;
      if (ref.kind === "local") repoId = from.repoId!;
      else if (ref.owner.toLowerCase() === m.owner.toLowerCase() && ref.repo.toLowerCase() === m.name.toLowerCase()) repoId = m.repoId;
      else {
        const dir = new Directory(this.env);
        // A transferred or renamed repository's workflows are found under the old name too.
        const target = (await dir.repo(ref.owner, ref.repo)) ?? (await dir.movedRepo(ref.owner, ref.repo));
        // Like GitHub: public workflows can be shared; private ones only within the same owner.
        if (!target || (target.visibility === "private" && target.owner_id !== m.ownerId)) throw new Error(`repository ${ref.owner}/${ref.repo} not found, or its workflows are not shared with ${m.owner}/${m.name}`);
        repoId = target.id;
      }
      if (repoId === m.repoId) {
        const sha = ref.kind === "local" ? from.sha : (pinned[`${repoId}@${ref.ref}`] ??= (await this.repo.resolve(ref.ref)) ?? "");
        if (!sha) throw new Error(`unknown ref ${ref.kind === "remote" ? ref.ref : ""}`);
        source = { repoId: null, sha };
        const b = await this.repo.blob(sha, ref.path);
        text = b && !b.binary ? fromUtf8(b.content) : null;
      } else {
        const stub = this.env.REPO.get(this.env.REPO.idFromName(repoId));
        const sha = ref.kind === "local" ? from.sha : (pinned[`${repoId}@${ref.ref}`] ??= (await stub.resolve(ref.ref)) ?? "");
        if (!sha) throw new Error(`unknown ref ${ref.kind === "remote" ? ref.ref : ""} in ${ref.kind === "remote" ? `${ref.owner}/${ref.repo}` : "the called repository"}`);
        source = { repoId, sha };
        const b = await stub.blob(sha, ref.path);
        text = b && !b.binary ? fromUtf8(b.content) : null;
      }
    }
    if (text === null) throw new Error(`${uses} not found`);
    const { workflow, errors } = parseWorkflow(text, ref.path);
    const fatal = errors.filter((e) => !isWarning(e));
    if (!workflow || fatal.length) throw new Error(`${uses} is invalid: ${fatal.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    return { workflow, source };
  }

  /** `needs` context for a job or call: keys are as written inside its own workflow. */
  private async needsResults(run: RunRow, exp: Expanded, keys: string[], scope: string | null): Promise<Record<string, NeedsResult>> {
    const out: Record<string, NeedsResult> = {};
    for (const key of keys) out[localKey(key, scope)] = await this.resultOf(run, exp, key);
    return out;
  }

  /** Status functions for the `if:` of a job or call: from the results of all its ancestors, like GitHub. */
  private statusOf(run: RunRow, exp: Expanded, key: string): StatusFns {
    const results = ancestors(exp.needs, exp.needs.get(key) ?? []).map((k) => combineResults(this.rowsOf(run, exp, k)));
    return jobStatus(results, run.conclusion === "cancelled");
  }

  /** The job rows of a job, or of every job inside a reusable workflow call. */
  private rowsOf(run: RunRow, exp: Expanded, key: string): Array<JobRow & { continueOnError: boolean }> {
    const rows = exp.calls.has(key)
      ? this.sql.exec<JobRow>("SELECT * FROM jobs WHERE run_id = ? AND substr(job_key, 1, ?) = ?", run.id, key.length + 1, `${key}/`).toArray()
      : this.sql.exec<JobRow>("SELECT * FROM jobs WHERE run_id = ? AND job_key = ?", run.id, key).toArray();
    return rows.map((r) => ({ ...r, continueOnError: !!r.continue_on_error }));
  }

  /** Result and outputs of a job, or of a reusable workflow call (from its `on.workflow_call.outputs`). */
  private async resultOf(run: RunRow, exp: Expanded, key: string): Promise<NeedsResult> {
    const call = exp.calls.get(key);
    const rows = this.rowsOf(run, exp, key);
    const result = combineResults(rows);
    let outputs: Record<string, string> = {};
    if (!call) for (const r of rows) Object.assign(outputs, JSON.parse(r.outputs));
    if (call && Object.keys(call.workflow.on.workflow_call?.outputs ?? {}).length) {
      const jobs: Record<string, NeedsResult> = {};
      for (const k of Object.keys(call.workflow.jobs)) jobs[k] = await this.resultOf(run, exp, `${key}/${k}`);
      const { inputs } = await this.callContext(run, exp, key, false);
      const ctx: ExprContext = { github: this.githubContext(run, localKey(key, call.parent), ""), jobs, inputs, vars: this.variables() };
      outputs = {};
      for (const [name, d] of Object.entries(call.workflow.on.workflow_call!.outputs!)) {
        try {
          const v = evaluateValue(d.value, ctx);
          outputs[name] = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
        } catch {
          outputs[name] = "";
        }
      }
    }
    return { result, outputs };
  }

  /**
   * `inputs` and `secrets` inside a reusable workflow call (or at the top level when
   * `callKey` is null): inputs from the caller's `with` and the declared defaults,
   * secrets from `secrets: inherit` or the caller's mapping.
   */
  private async callContext(run: RunRow, exp: Expanded, callKey: string | null, withSecrets: boolean): Promise<{ inputs: Record<string, unknown>; secrets: Record<string, string> }> {
    if (callKey === null) return { inputs: JSON.parse(run.inputs), secrets: withSecrets ? { ...(await this.orgSecrets()), ...(await this.repoSecrets()) } : {} };
    const call = exp.calls.get(callKey)!;
    const parent = await this.callContext(run, exp, call.parent, withSecrets);
    const ctx: ExprContext = { github: this.githubContext(run, localKey(callKey, call.parent), ""), needs: await this.needsResults(run, exp, call.needs, call.parent), inputs: parent.inputs, vars: this.variables() };
    const inputs: Record<string, unknown> = {};
    for (const [k, d] of Object.entries(call.workflow.on.workflow_call?.inputs ?? {})) {
      let v = call.job.with && k in call.job.with ? evaluateValue(call.job.with[k], ctx) : evaluateValue(d.default, ctx);
      if (v === undefined || v === null || v === "") {
        if (d.required) throw new ReusableError(`jobs.${callKey}: input '${k}' is required by ${call.job.uses}`);
        v = d.type === "boolean" ? false : d.type === "number" ? 0 : "";
      }
      inputs[k] = d.type === "boolean" ? v === true || v === "true" : d.type === "number" ? Number(v) : v;
    }
    const secrets: Record<string, string> = {};
    if (withSecrets) {
      if (call.job.secrets === "inherit") Object.assign(secrets, parent.secrets);
      else for (const [name, expr] of Object.entries(call.job.secrets ?? {})) secrets[name.toUpperCase()] = String(evaluateValue(expr, { ...ctx, secrets: parent.secrets }) ?? "");
      for (const [name, d] of Object.entries(call.workflow.on.workflow_call?.secrets ?? {})) {
        if (d.required && !secrets[name.toUpperCase()]) throw new ReusableError(`jobs.${callKey}: secret '${name}' is required by ${call.job.uses}`);
      }
    }
    return { inputs, secrets };
  }

  /**
   * Start every matrix instance of a job. Returns the ids the workflow must wait
   * for (instances beyond max-parallel are queued and started as others finish).
   */
  async startJobKey(runId: string, jobKey: string): Promise<{ jobIds: string[] }> {
    const run = this.runRow(runId);
    // Finished by repairStuckRuns while its workflow was stuck: nothing more starts.
    if (run.status === "completed") return { jobIds: [] };
    // A partial re-run copies what it keeps from the earlier attempt: the whole job, or some of its matrix legs.
    const carry = run.rerun_carry ? (JSON.parse(run.rerun_carry) as RerunCarry)[jobKey] : undefined;
    if (carry && "all" in carry) {
      for (const id of carry.all) this.carryJob(run, id);
      this.repo.broadcast(`run:${runId}`, { action: "jobs" });
      return { jobIds: [] };
    }
    const kept = new Map(Object.entries(carry && "legs" in carry ? carry.legs : {}).map(([k, ids]) => [k, [...ids]]));
    const exp = await this.expanded(run);
    const job = exp.workflow.jobs[jobKey]!;
    const owner = exp.workflowOf.get(jobKey)!;
    const parent = exp.parentOf.get(jobKey) ?? null;
    const chain: string[] = [];
    for (let c = parent; c; c = exp.calls.get(c)!.parent) chain.unshift(c);
    const prefix = chain.map((c) => exp.calls.get(c)!.job.name ?? localKey(c, exp.calls.get(c)!.parent)).join(" / ");
    const label = (name: string) => (prefix ? `${prefix} / ${name}` : name);
    const fail = (name: string, message: string, conclusion: Conclusion = "failure") => {
      const id = newId();
      const t = now();
      this.sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status, conclusion, started_at, completed_at, failure) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)", id, runId, jobKey, name, conclusion, t, t, conclusion === "failure" ? JSON.stringify({ message }) : null);
      this.repo.broadcast(`run:${runId}`, { action: "job", jobId: id });
      return { jobIds: [] as string[] };
    };
    const short = localKey(jobKey, parent);
    let needs: Record<string, NeedsResult>;
    let baseCtx: ExprContext;
    let shouldRun: boolean;
    try {
      // The callers decide first: a skipped call, or one whose ancestors failed or were skipped, skips everything inside it.
      for (const c of chain) {
        const call = exp.calls.get(c)!;
        const callNeeds = await this.needsResults(run, exp, call.needs, call.parent);
        const outer = await this.callContext(run, exp, call.parent, false);
        const callCtx: ExprContext = { github: this.githubContext(run, localKey(c, call.parent), ""), needs: callNeeds, inputs: outer.inputs, vars: this.variables() };
        if (!evaluateIf(call.job.if, callCtx, this.statusOf(run, exp, c))) return fail(label(job.name ?? short), "", "skipped");
      }
      // Resolve the call's inputs and secrets now, so a missing required one fails here rather than in the runner.
      if (parent) await this.callContext(run, exp, parent, true);
      needs = await this.needsResults(run, exp, exp.needs.get(jobKey) ?? [], parent);
      baseCtx = { github: this.githubContext(run, short, ""), needs, inputs: (await this.callContext(run, exp, parent, false)).inputs, vars: this.variables(), env: owner.env };
      shouldRun = evaluateIf(job.if, baseCtx, this.statusOf(run, exp, jobKey));
    } catch (e) {
      return fail(label(job.name ?? short), e instanceof ReusableError ? e.message : `Error evaluating 'if': ${(e as Error).message}`);
    }
    if (!shouldRun) return fail(label(job.name ?? short), "", "skipped");

    let combos: Array<Record<string, unknown>>;
    try {
      combos = expandMatrix(job.strategy?.matrix, baseCtx);
    } catch (e) {
      return fail(label(job.name ?? short), `Error expanding matrix: ${(e as Error).message}`);
    }
    if (combos.length > 256) return fail(label(job.name ?? short), "A matrix may produce at most 256 jobs.");
    const started = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE run_id = ?", run.id).one().n;
    if (started + combos.length > MAX_RUN_JOBS) return fail(label(job.name ?? short), `A run may have at most ${MAX_RUN_JOBS} jobs, matrix legs included.`);
    const failFast = evaluateValue(job.strategy?.failFast ?? true, baseCtx) !== false;
    const maxParallel = Number(evaluateValue(job.strategy?.maxParallel ?? combos.length, baseCtx)) || combos.length;
    const ids: string[] = [];
    combos.forEach((matrix, i) => {
      // A leg the re-run keeps isn't evaluated again: it is the earlier attempt's, and counts for neither max-parallel nor minutes.
      const keep = kept.get(canonicalJson(matrix))?.shift();
      if (keep && this.carryJob(run, keep)) return;
      // Like GitHub, name, runs-on, timeout-minutes, continue-on-error and concurrency are evaluated for each matrix leg.
      const ctx = { ...baseCtx, matrix, strategy: { "fail-fast": failFast, "job-index": i, "job-total": combos.length, "max-parallel": maxParallel } };
      let name = short;
      if (!job.name && Object.keys(matrix).length) name = `${short} (${Object.values(matrix).map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ")})`;
      let leg: { labels: string[]; timeout: number; continueOnError: boolean; group: string | null; cancel: boolean; environment: string | null };
      try {
        if (job.name) name = interpolate(job.name, ctx);
        const continueOnError = evaluateValue(job.continueOnError, ctx);
        const cancel = job.concurrency ? evaluateValue(job.concurrency.cancelInProgress, ctx) : false;
        leg = {
          labels: runnerLabels(job.runsOn, ctx),
          timeout: Number(evaluateValue(job.timeoutMinutes, ctx)) || 360,
          continueOnError: continueOnError === true || continueOnError === "true",
          group: (job.concurrency ? interpolate(job.concurrency.group, ctx).trim() : "") || null,
          cancel: cancel === true || cancel === "true",
          // Evaluated once, here: its protection rules gate the launch, and runnerSpec deploys to this same name.
          environment: job.environment ? interpolate(job.environment.name, ctx).trim() : null,
        };
      } catch (e) {
        fail(label(name), `Error evaluating the job for this matrix combination: ${(e as Error).message}`);
        return;
      }
      const unsupported = leg.labels.filter((l) => !SUPPORTED_LABEL.test(l));
      const selfHosted = leg.labels.some((l) => l.toLowerCase() === "self-hosted");
      if (!leg.labels.length || (unsupported.length && !selfHosted)) {
        fail(label(name), `No Diffinery runner matches runs-on: ${unsupported.join(", ") || "(no labels)"}. Linux (ubuntu-*) runners are hosted; anything else needs runs-on: [self-hosted, ...] and a registered runner.`);
        return;
      }
      const id = newId();
      this.sql.exec(
        "INSERT INTO jobs (id, run_id, job_key, name, status, matrix, strategy, timeout_minutes, labels, continue_on_error, concurrency_group, concurrency_cancel, environment, runner_size) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        runId,
        jobKey,
        label(name),
        JSON.stringify(matrix),
        JSON.stringify(ctx.strategy),
        Math.min(leg.timeout, 360),
        selfHosted ? JSON.stringify(leg.labels.map((l) => l.toLowerCase())) : null,
        leg.continueOnError ? 1 : 0,
        leg.group,
        leg.cancel ? 1 : 0,
        leg.environment,
        selfHosted ? null : sizeLabel(leg.labels),
      );
      ids.push(id);
    });
    await this.launchAll(ids.slice(0, maxParallel));
    this.repo.broadcast(`run:${runId}`, { action: "jobs" });
    return { jobIds: ids };
  }

  /**
   * Copies a finished job of an earlier attempt into `run` unchanged, for a partial re-run: it
   * doesn't run again, start a container or use minutes, and serves the earlier job's log. Its
   * check run (if it had one) now points at the new attempt, with the same conclusion.
   */
  private carryJob(run: RunRow, oldId: string): boolean {
    const old = this.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", oldId).toArray()[0];
    if (!old || old.status !== "completed") return false;
    const id = newId();
    this.sql.exec(
      `INSERT INTO jobs (id, run_id, job_key, name, status, conclusion, matrix, strategy, started_at, completed_at, outputs, steps, failure, summary, container, timeout_minutes, labels, continue_on_error, concurrency_group, concurrency_cancel, log_chars, environment, runner_info, carried_from)
       SELECT ?, ?, job_key, name, 'completed', conclusion, matrix, strategy, started_at, completed_at, outputs, steps, failure, summary, container, timeout_minutes, labels, continue_on_error, concurrency_group, concurrency_cancel, log_chars, environment, runner_info, COALESCE(carried_from, id) FROM jobs WHERE id = ?`,
      id,
      run.id,
      oldId,
    );
    if (this.sql.exec("SELECT 1 FROM checks WHERE job_id = ? AND app = 'diffinery-actions'", oldId).toArray().length) {
      const failure = old.failure ? (JSON.parse(old.failure) as { message: string }) : null;
      this.repo.upsertCheck({
        sha: run.head_sha ?? run.sha,
        name: this.checkName(run, old),
        status: "completed",
        conclusion: old.conclusion,
        runId: run.id,
        jobId: id,
        detailsUrl: this.jobUrl(run, id),
        output: failure ? { title: "Failed", summary: failure.message } : { title: old.conclusion ?? "completed" },
      });
    }
    this.repo.broadcast(`run:${run.id}`, { action: "job", jobId: id });
    return true;
  }

  private checkName(run: RunRow, job: JobRow): string {
    return `${run.workflow_name} / ${job.name}`;
  }

  private async launch(jobId: string): Promise<void> {
    const placement = await this.admit(jobId);
    if (placement) await this.place(placement);
  }

  /**
   * Starts jobs (matrix legs) together. Each is admitted (kill switches, gates, quotas, the
   * repository's share of the fleet) one after another, so no two take the same slot; their
   * containers then start START_AT_ONCE at a time, since one start takes seconds. Once a leg has to
   * wait for a slot, so would the rest: they wait in line with it without asking again.
   */
  private async launchAll(jobIds: string[]): Promise<void> {
    const starting = new Set<Promise<void>>();
    let heldAs = 0;
    for (const id of jobIds) {
      if (heldAs) {
        this.holdForSlot(this.jobRow(id), heldAs);
        continue;
      }
      const placement = await this.admit(id);
      if (!placement) {
        const j = this.jobRow(id);
        if (j.status === "queued" && j.fleet_held > 0) heldAs = j.fleet_held;
        continue;
      }
      const started: Promise<void> = this.place(placement).finally(() => starting.delete(started));
      starting.add(started);
      if (starting.size >= START_AT_ONCE) await Promise.race(starting);
    }
    await Promise.all(starting);
  }

  /** Puts a job in line for a hosted slot: 1 the repository's share of the fleet, 2 the account's hosted jobs. */
  private holdForSlot(job: JobRow, held: number): void {
    if (job.status === "completed") return;
    const run = this.runRow(job.run_id);
    const m = this.repo.meta;
    this.sql.exec("UPDATE jobs SET status = 'queued', fleet_held = ? WHERE id = ?", held, job.id);
    this.repo.upsertCheck({ sha: run.head_sha ?? run.sha, name: this.checkName(run, job), status: "queued", runId: run.id, jobId: job.id, detailsUrl: `${this.env.PUBLIC_URL}/${m.owner}/${m.name}/actions/runs/${run.id}/job/${job.id}` });
    if (held === 2) this.repo.armAlarm(null);
  }

  /** Everything before a hosted job's container starts; null when it doesn't start now (finished, parked or held). */
  private async admit(jobId: string): Promise<Placement | null> {
    const job = this.jobRow(jobId);
    if (job.status === "completed") return null;
    // Kill switches (lib/killswitch.ts): a suspended repository or owner starts no job; a paused instance no hosted one.
    const block = await this.blocked(job.labels ? "self-hosted-job" : "hosted-job");
    if (block) {
      await this.completeJob(jobId, { conclusion: "failure", outputs: {}, failure: { message: `The job was not started: ${block}.` } });
      return null;
    }
    if (!(await this.gate(job)) || !(await this.concurrencySlot(job))) return null;
    const run = this.runRow(job.run_id);
    const m = this.repo.meta;
    if (job.labels) {
      // Self-hosted: park the job until a registered runner with matching labels claims it.
      this.sql.exec("UPDATE jobs SET status = 'waiting', container = NULL WHERE id = ?", jobId);
      this.repo.upsertCheck({ sha: run.head_sha ?? run.sha, name: this.checkName(run, job), status: "queued", runId: run.id, jobId, detailsUrl: `${this.env.PUBLIC_URL}/${m.owner}/${m.name}/actions/runs/${run.id}/job/${jobId}` });
      return null;
    }
    // Already at an account's share of the fleet in this repository alone (lib/quotas.ts fleetLimits):
    // the job waits for one of the repository's own to finish. Checked here first, it needs no D1 read.
    const busy = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE labels IS NULL AND container IS NOT NULL AND status IN ('waiting', 'in_progress') AND id != ?", jobId).one().n;
    if (busy >= fleetLimits(this.env).share) {
      this.holdForSlot(job, 1);
      return null;
    }
    // The account that owns the repository pays (lib/quotas.ts): past its monthly minutes the job
    // fails; past its hosted jobs at once it waits (fleet_held = 2, retried by the alarm) for one to end.
    const quota = await mayStart(this.env, m.ownerId, "job").catch((e: unknown) => {
      console.error("quota check failed", e);
      return { ok: true } as const;
    });
    if (!quota.ok) {
      if (quota.wait) this.holdForSlot(job, 2);
      else await this.completeJob(jobId, { conclusion: "failure", outputs: {}, failure: { message: `The job was not started: ${quota.message}.` } });
      return null;
    }
    this.sql.exec("UPDATE jobs SET fleet_held = 0 WHERE id = ?", jobId);
    const token = `djt_${m.repoId}_${jobId}_${randomToken(24)}`;
    const { size, note } = this.runnerSize(job, run);
    // A restarted job gets a new container: the replaced one may still be shutting down. So does a job
    // placed again after its runner never started: a container given up on may still come up in the old
    // object, whose start would then do nothing, and an object the platform failed under (an internal
    // error, its storage out of memory) failed the next start too (2026-10-24).
    const container = containerName(jobId, job.restarts, size, job.placement_tries + (job.early_stops ?? 0) + (job.stale_tries ?? 0));
    this.sql.exec("UPDATE jobs SET status = 'waiting', token_hash = ?, token_at = ?, container = ?, size_note = ? WHERE id = ?", await sha256(token), now(), container, note, jobId);
    await startCompute(this.env, { id: jobId, accountId: m.ownerId, repoId: m.repoId, kind: "job" }).catch((e: unknown) => console.error("compute usage failed", e));
    this.repo.upsertCheck({ sha: run.head_sha ?? run.sha, name: this.checkName(run, job), status: "queued", runId: run.id, jobId, detailsUrl: `${this.env.PUBLIC_URL}/${m.owner}/${m.name}/actions/runs/${run.id}/job/${jobId}` });
    return { jobId, container, token, egress: await egressFor(this.env, m.ownerId), vcpu: RUNNER_SIZES[size].vcpu };
  }

  /**
   * The hosted runner size for a job (runner/sizes.ts): what its runs-on asks for, or else what its own
   * earlier runs (same workflow file and job name, on hosted runners) show it needs. A size this
   * deployment has no container class for runs as large.
   */
  private runnerSize(job: JobRow, run: RunRow): { size: RunnerSize; note: string } {
    const pinned = (job.runner_size as RunnerSize | null | undefined) ?? null;
    let size: RunnerSize;
    let why: string;
    if (pinned) {
      size = pinned;
      why = "asked for by runs-on";
    } else {
      type Row = { conclusion: string | null; container: string; usage: string | null; runner_info: string | null };
      const hosted = `FROM jobs j JOIN runs r ON r.id = j.run_id
            WHERE r.workflow_path = ? AND j.name = ? AND j.id != ? AND j.status = 'completed' AND j.labels IS NULL AND j.container IS NOT NULL AND j.carried_from IS NULL`;
      const sized = (rows: Row[]): SizedRun[] =>
        rows.map((r) => {
          let usage: SizedRun["usage"] = null;
          let cpu: string | null = null;
          try {
            usage = r.usage ? JSON.parse(r.usage) : null;
          } catch {
            /* unreadable: counts as not measured */
          }
          try {
            cpu = r.runner_info ? ((JSON.parse(r.runner_info) as { cpu?: unknown }).cpu as string | undefined) ?? null : null;
          } catch {
            /* unreadable: an unknown host */
          }
          return { conclusion: r.conclusion, size: sizeOfContainer(r.container), usage, cpu: typeof cpu === "string" ? cpu : null };
        });
      const history = sized(
        this.sql.exec<Row>(`SELECT j.conclusion, j.container, j.usage, j.runner_info ${hosted} ORDER BY j.completed_at DESC LIMIT ${LOOKBACK}`, run.workflow_path, job.name, job.id).toArray(),
      );
      // Its typical time on large, from its last measured large runs however far back they are.
      const large = sized(
        this.sql
          .exec<Row>(
            `SELECT j.conclusion, j.container, j.usage, j.runner_info ${hosted} AND j.conclusion = 'success' AND j.usage IS NOT NULL AND j.container NOT LIKE '%.%' ORDER BY j.completed_at DESC LIMIT 10`,
            run.workflow_path,
            job.name,
            job.id,
          )
          .toArray(),
      );
      ({ size, why } = chooseSize(history, { rerun: run.attempt > 1, large }));
      // A job that already waited for a machine doesn't wait again for a smaller one.
      if (size !== "large" && job.placement_tries > 0) {
        size = "large";
        why = "no smaller runner was free when it first started";
      }
    }
    if (size !== "large" && !this.env[RUNNER_SIZES[size].binding]) {
      size = "large";
      why = "this Diffinery has no smaller runners";
    }
    return { size, note: describeSize(size, why, !!pinned && size === pinned) };
  }

  /** The container class of a hosted job's container (its name says which size it is). */
  private runnerNamespace(container: string) {
    return this.env[RUNNER_SIZES[sizeOfContainer(container)].binding] ?? this.env.RUNNER;
  }

  /**
   * Starts an admitted job's container. One whose start failed for a reason that passes goes back in
   * line (placementFailed); any other start failure fails the job. Either only while the job still
   * waits for this container's runner: a runner that fetched the job before the start reported its
   * failure runs it, and the job ends the usual way (its report, containerStopped, its deadline).
   */
  private async place(p: Placement): Promise<void> {
    try {
      const ns = this.runnerNamespace(p.container);
      const stub = ns.get(ns.idFromName(p.container));
      await stub.startJob({ repoId: this.repo.meta.repoId, jobId: p.jobId, container: p.container, token: p.token, apiUrl: this.env.PUBLIC_URL, egress: p.egress, vcpu: p.vcpu });
    } catch (e) {
      const message = (e as Error).message;
      const j = this.jobRow(p.jobId);
      if (j.status !== "waiting" || j.container !== p.container) {
        console.error(`runner start for job ${p.jobId} failed after it was ${j.status}`, e);
        return;
      }
      if (RETRYABLE_START.test(message) || (e as { retryable?: unknown }).retryable === true) {
        return this.placementFailed(p.jobId, message, { quick: PASSING_START.test(message) && (j.early_stops ?? 0) < QUICK_RETRIES });
      }
      await this.completeJob(p.jobId, { conclusion: "failure", outputs: {}, failure: { message: `Could not start a runner: ${message}` } });
    }
  }


  // ---------------------------------------------------------------- environment protection rules

  private jobUrl(run: RunRow, jobId: string): string {
    const m = this.repo.meta;
    return `${this.env.PUBLIC_URL}/${m.owner}/${m.name}/actions/runs/${run.id}/job/${jobId}`;
  }

  /**
   * Whose run this is, for prevent_self_review, as account ids (logins can be renamed): who started
   * it and its earlier attempts, and for each of them that is an agent, the account that owns it.
   */
  async selfIds(run: RunRow): Promise<Set<string>> {
    const actor = JSON.parse(run.actor) as Actor;
    const ids = new Set([actor.id, ...((run.prior_actors ? JSON.parse(run.prior_actors) : []) as string[])].filter(Boolean));
    const dir = new Directory(this.env);
    for (const id of [...ids]) {
      const a = await dir.account(id).catch(() => null);
      if (a?.kind === "agent" && a.owner_id) ids.add(a.owner_id);
    }
    return ids;
  }

  /**
   * A job whose environment has required reviewers or a wait timer waits here, before a token is
   * minted or a runner started, in the status `approval`: no concurrency slot, no hosted slot.
   * Returns whether the job may go on to start. The branch policy is checked first, so a ref that
   * may never deploy fails at once instead of asking anyone.
   */
  private async gate(job: JobRow): Promise<boolean> {
    if (!job.environment || job.gate_state === "released") return true;
    const rules = this.repo.deploys.protection(job.environment);
    if (!rules) {
      if (job.status === "approval") this.release(job);
      return true;
    }
    const run = this.runRow(job.run_id);
    const fail = async (message: string) => {
      await this.completeJob(job.id, { conclusion: "failure", outputs: {}, failure: { message } });
      return false;
    };
    if (!this.repo.deploys.refAllowed(job.environment, run.ref)) return fail(`${run.ref.replace(/^refs\/(heads|tags)\//, "")} is not allowed to deploy to ${job.environment} due to environment protection rules.`);
    const decision = rules.reviewers.length ? this.repo.deploys.decision(run.id, job.environment) : null;
    if (decision === "rejected") {
      const r = this.repo.deploys.reviews(run.id).find((x) => x.environment.toLowerCase() === job.environment!.toLowerCase() && x.state === "rejected")!;
      return fail(`The deployment to ${job.environment} was rejected by ${r.user.login}${r.comment ? `: ${r.comment}` : "."}`);
    }
    let since = job.gate_since;
    if (job.status !== "approval") {
      since = now();
      this.sql.exec("UPDATE jobs SET status = 'approval', gate_since = ? WHERE id = ?", since, job.id);
      this.sql.exec("UPDATE runs SET status = 'waiting', updated_at = ? WHERE id = ? AND status != 'completed'", since, run.id);
      const actor = JSON.parse(run.actor) as Actor;
      this.repo.deploys.jobWaiting({ id: job.id, ref: run.ref, sha: run.sha, logUrl: this.jobUrl(run, job.id), actor: run.agent_origin ? { ...actor, kind: "agent" } : actor }, job.environment);
      this.repo.upsertCheck({ sha: run.head_sha ?? run.sha, name: this.checkName(run, job), status: "queued", runId: run.id, jobId: job.id, detailsUrl: this.jobUrl(run, job.id) });
      // Reviewers hear about it once per run and environment, from its first job to wait.
      const first = !this.sql.exec("SELECT 1 FROM jobs WHERE run_id = ? AND environment = ? COLLATE NOCASE AND gate_since IS NOT NULL AND id != ?", run.id, job.environment, job.id).toArray().length;
      if (first && rules.reviewers.length && !decision) this.emitReview("requested", run, job.environment, rules.reviewers, actor, null, "");
      this.repo.broadcast(`run:${run.id}`, { action: "job", jobId: job.id });
      this.repo.broadcast("runs", { action: "waiting", runId: run.id });
    }
    const timerEnds = Date.parse(since!) + rules.waitTimer * timerMinute(this.env);
    if ((rules.reviewers.length && decision !== "approved") || Date.now() < timerEnds) return false;
    this.release({ ...job, status: "approval" });
    return true;
  }

  /** The job's protection rules passed: it goes on to start, and its run stops waiting once no other job does. */
  private release(job: JobRow): void {
    this.sql.exec("UPDATE jobs SET gate_state = 'released', status = 'queued' WHERE id = ?", job.id);
    this.syncWaiting(job.run_id);
  }

  private syncWaiting(runId: string): void {
    if (this.sql.exec("SELECT 1 FROM jobs WHERE run_id = ? AND status = 'approval'", runId).toArray().length) return;
    this.sql.exec("UPDATE runs SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'waiting'", now(), runId);
  }

  private async wakeGate(runId: string, jobId: string): Promise<void> {
    try {
      await (await this.env.RUN_WORKFLOW.get(runId)).sendEvent({ type: `gate-${jobId}`, payload: {} });
    } catch (e) {
      console.error("failed to wake a job waiting for approval", e);
    }
  }

  private emitReview(action: "requested" | "approved" | "rejected", run: RunRow, environment: string, reviewers: Reviewer[], by: Actor, state: string | null, comment: string): void {
    const m = this.repo.meta;
    const url = `${this.env.PUBLIC_URL}/${m.owner}/${m.name}/actions/runs/${run.id}`;
    const ids = Object.fromEntries(this.repo.deploys.environments().map((e) => [e.name.toLowerCase(), e.id]));
    this.repo.emit({
      type: "deployment_review",
      action,
      repoId: m.repoId,
      owner: m.owner,
      repo: m.name,
      payload: {
        since: now(),
        environment: environment,
        environment_id: ids[environment.toLowerCase()] ?? null,
        comment,
        ...(state ? { state } : {}),
        workflow_run: { id: run.id, run_number: run.run_number, name: run.workflow_name, display_title: run.display_title, head_sha: run.head_sha ?? run.sha, head_branch: run.ref.replace(/^refs\/(heads|tags)\//, ""), html_url: url },
        reviewers: reviewers.map((r) => ({ type: "User", reviewer: { login: r.login, id: r.id } })),
        ...(action === "requested" ? { requestor: { login: by.login } } : { approver: { login: by.login } }),
      },
      actor: by,
      at: now(),
    });
  }

  /**
   * Where a job waiting on its environment stands, for the run's Workflow: what it waits for and
   * until when. Re-checks the rules first, so a job whose time came starts here.
   */
  async jobGate(jobId: string): Promise<{ status: JobRow["status"]; wait: "review" | "timer" | null; until: string | null }> {
    let job = this.jobRow(jobId);
    if (job.status === "approval") await this.launch(jobId);
    job = this.jobRow(jobId);
    if (job.status !== "approval") return { status: job.status, wait: null, until: null };
    const rules = this.repo.deploys.protection(job.environment!) ?? { reviewers: [], waitTimer: 0, preventSelfReview: false };
    const since = Date.parse(job.gate_since!);
    const deadline = since + APPROVAL_DAYS * 86400_000;
    if (Date.now() >= deadline) {
      await this.completeJob(jobId, { conclusion: "failure", outputs: {}, failure: { message: `The deployment to ${job.environment} wasn't approved within ${APPROVAL_DAYS} days.` } });
      return { status: "completed", wait: null, until: null };
    }
    const decided = this.repo.deploys.decision(job.run_id, job.environment!) === "approved";
    if (rules.reviewers.length && !decided) return { status: "approval", wait: "review", until: new Date(deadline).toISOString() };
    return { status: "approval", wait: "timer", until: new Date(since + rules.waitTimer * timerMinute(this.env)).toISOString() };
  }

  /** The environments a run's jobs wait on, with who may approve them (GitHub's pending deployments). */
  async pendingDeployments(runId: string, viewer: { id: string; login: string; mayReview?: boolean } | null): Promise<PendingDeployment[]> {
    const run = this.runRow(runId);
    const waiting = this.sql.exec<{ environment: string; since: string }>("SELECT environment, MIN(gate_since) AS since FROM jobs WHERE run_id = ? AND status = 'approval' GROUP BY environment COLLATE NOCASE", run.id).toArray();
    const self = viewer ? await this.selfIds(run) : new Set<string>();
    return waiting.flatMap((w) => {
      const env = this.repo.deploys.environments().find((e) => e.name.toLowerCase() === w.environment.toLowerCase());
      if (!env) return [];
      const p = env.protection;
      const decided = this.repo.deploys.decision(run.id, env.name);
      // A listed reviewer who lost access to the repository no longer decides (the caller says so in mayReview).
      const listed = !!viewer && viewer.mayReview !== false && p.reviewers.some((r) => r.id === viewer.id);
      const selfBlocked = !!viewer && p.preventSelfReview && self.has(viewer.id);
      return [
        {
          environment: { id: env.id, name: env.name },
          waitTimer: p.waitTimer,
          waitTimerStartedAt: w.since,
          reviewers: p.reviewers,
          preventSelfReview: p.preventSelfReview,
          needsReview: p.reviewers.length > 0 && decided !== "approved",
          currentUserCanApprove: listed && !selfBlocked && p.reviewers.length > 0 && !decided,
          selfBlocked,
        },
      ];
    });
  }

  /**
   * A required reviewer approves or rejects environments a run waits on. The caller checked that
   * `reviewer` is a person signed in or using a write token (never an agent or a job); here the
   * reviewer must be listed on every environment, and not whoever started the run when the
   * environment prevents self-review. One approval is enough. Approved jobs start once their
   * wait timer has also passed; rejected ones fail.
   */
  async reviewDeployments(runId: string, input: { environmentIds: number[]; state: "approved" | "rejected"; comment: string }, reviewer: { id: string; login: string; mayReview: boolean }): Promise<{ reviews: DeploymentReview[]; deployments: Deployment[] }> {
    const run = this.runRow(runId);
    if (!reviewer.mayReview) throw new HttpError(403, "only people with access to this repository review its deployments");
    if (!input.environmentIds.length) throw new HttpError(422, "environment_ids must name at least one environment");
    const pending = await this.pendingDeployments(run.id, reviewer);
    const chosen = input.environmentIds.map((id) => {
      const p = pending.find((x) => x.environment.id === id);
      if (!p || !p.needsReview) throw new HttpError(422, `environment ${id} isn't waiting for a review in this run`);
      if (p.selfBlocked) throw new HttpError(403, `${p.environment.name} doesn't let whoever started a run approve it`);
      if (!p.currentUserCanApprove) throw new HttpError(403, `you aren't a required reviewer for ${p.environment.name}`);
      return p;
    });
    const by: Actor = { id: reviewer.id, login: reviewer.login, kind: "user" };
    const out: DeploymentReview[] = [];
    const jobIds: string[] = [];
    for (const p of chosen) {
      out.push(this.repo.deploys.addReview(run.id, p.environment.name, input.state, input.comment, reviewer));
      this.emitReview(input.state, run, p.environment.name, p.reviewers, by, input.state, input.comment);
      const jobs = this.sql.exec<JobRow>("SELECT * FROM jobs WHERE run_id = ? AND status = 'approval' AND environment = ? COLLATE NOCASE", run.id, p.environment.name).toArray();
      for (const j of jobs) {
        jobIds.push(j.id);
        await this.launch(j.id);
        await this.wakeGate(run.id, j.id);
      }
    }
    this.repo.broadcast(`run:${run.id}`, { action: "reviewed" });
    return { reviews: out, deployments: this.repo.deploys.jobDeployments(jobIds) };
  }

  deploymentReviews(runId: string): DeploymentReview[] {
    return this.repo.deploys.reviews(this.runRow(runId).id);
  }

  /**
   * The job's container got no machine (its start failed, or it stopped before the runner reported
   * in). Put the job back in line and have the run's workflow start it again after a pause, or fail it
   * once it has waited MAX_PLACEMENT_TRIES times.
   */
  private async placementFailed(jobId: string, why: string, o: { quick?: boolean } = {}): Promise<void> {
    const job = this.jobRow(jobId);
    if (job.status === "completed") return;
    if (o.quick) {
      this.sql.exec("UPDATE jobs SET early_stops = early_stops + 1 WHERE id = ?", jobId);
      return this.backInLine(job, why, job.placement_tries, QUICK_RETRY_SECONDS, "not counted: the first failure like this is retried at once");
    }
    const tries = job.placement_tries + 1;
    if (tries > MAX_PLACEMENT_TRIES) {
      await this.completeJob(jobId, { conclusion: "failure", outputs: {}, failure: { message: `No hosted runner could be started: Diffinery tried ${MAX_PLACEMENT_TRIES} times over about half an hour (${why}). Re-run the job to try again.` } });
      return;
    }
    await this.backInLine(job, why, tries, placementDelay(tries), `wait ${tries} of ${MAX_PLACEMENT_TRIES}`);
  }

  /** Puts a job whose runner never started back in line, says why in its log, and has the run's workflow start it again in `delay` seconds. */
  private async backInLine(job: JobRow, why: string, tries: number, delay: number, count: string): Promise<void> {
    const jobId = job.id;
    this.sql.exec("UPDATE jobs SET status = 'queued', container = NULL, token_hash = NULL, placement_tries = ? WHERE id = ?", tries, jobId);
    await this.waiting(job, why, delay, count);
    try {
      const instance = await this.env.RUN_WORKFLOW.get(job.run_id);
      await instance.sendEvent({ type: `job-${jobId}`, payload: { retryInSeconds: delay } });
    } catch (e) {
      // The run's workflow couldn't be told (seen on 2026-10-24, failing a job whose fresh container had
      // stopped): this object starts the job again from its alarm instead, as during a rollout
      // (relaunchImageHeld), and the workflow keeps waiting for the job to finish. Whichever starts it
      // first wins: both start only a job that is still queued.
      console.error("could not ask the run's workflow to start the job again; this object will", e);
      const at = Date.now() + delay * 1000;
      this.sql.exec("UPDATE jobs SET image_retry_at = ? WHERE id = ?", at, jobId);
      this.repo.alarmBy(at);
    }
  }

  /** The log line of a job back in line, so a slow start can be told apart (no machine free, a rollout's stale image); it stops using minutes meanwhile. */
  private async waiting(job: JobRow, why: string, delay: number, count: string): Promise<void> {
    const jobId = job.id;
    const seq = (this.sql.exec<{ n: number | null }>("SELECT max(seq) AS n FROM logs WHERE job_id = ?", jobId).one().n ?? -1) + 1;
    const line = { t: new Date().toISOString(), step: -1, text: `##[warning]No hosted runner could start the job yet: ${why}. Diffinery tries again in ${delay} s (${count}).`, seq };
    this.sql.exec("INSERT INTO logs (job_id, seq, t, step, text) VALUES (?, ?, ?, ?, ?)", jobId, seq, line.t, line.step, line.text);
    this.sql.exec("UPDATE jobs SET log_chars = coalesce(log_chars, 0) + ? WHERE id = ?", line.text.length, jobId);
    this.repo.broadcast(`job:${jobId}`, { action: "logs", lines: [line] });
    // Not running while it waits: it holds none of the account's hosted jobs and uses no minutes.
    await endCompute(this.env, jobId).catch((e: unknown) => console.error("compute usage failed", e));
    this.repo.broadcast(`run:${job.run_id}`, { action: "job", jobId });
  }

  /**
   * A runner on the previous image was turned away during a rollout (refuseStaleRunner): the job goes
   * back in line and this object starts it again after STALE_IMAGE_RETRY_SECONDS (relaunchImageHeld,
   * from the alarm), without the run's workflow, which keeps waiting for the job to finish.
   */
  private async waitForImage(job: JobRow, why: string): Promise<void> {
    const tries = (job.stale_tries ?? 0) + 1;
    const at = Date.now() + STALE_IMAGE_RETRY_SECONDS * 1000;
    this.sql.exec("UPDATE jobs SET status = 'queued', container = NULL, token_hash = NULL, stale_tries = ?, image_retry_at = ? WHERE id = ?", tries, at, job.id);
    await this.waiting(job, why, STALE_IMAGE_RETRY_SECONDS, `rollout wait ${tries} of ${STALE_IMAGE_TRIES}, not counted`);
    this.repo.alarmBy(at);
  }

  /** When the next job this object starts again itself (waitForImage, backInLine) does, in ms since the epoch. */
  nextImageRetry(): number | null {
    return this.sql.exec<{ at: number | null }>("SELECT min(image_retry_at) AS at FROM jobs WHERE status = 'queued' AND image_retry_at IS NOT NULL").one().at;
  }

  /** Starts again the jobs whose wait this object keeps is over (waitForImage, backInLine). */
  async relaunchImageHeld(at = Date.now()): Promise<void> {
    for (const { id } of this.sql.exec<{ id: string }>("SELECT id FROM jobs WHERE status = 'queued' AND image_retry_at IS NOT NULL AND image_retry_at <= ? ORDER BY rowid", at).toArray()) {
      this.sql.exec("UPDATE jobs SET image_retry_at = NULL WHERE id = ?", id);
      await this.launch(id);
    }
  }

  /** The run's workflow starts a job again after placementFailed put it back in line. */
  async relaunchJob(jobId: string): Promise<void> {
    if (this.jobRow(jobId).status === "queued") await this.launch(jobId);
  }

  /**
   * Job-level `concurrency`, like GitHub: at most one job of a group runs at a time in
   * the repository. With cancel-in-progress the newcomer cancels the group's other jobs;
   * without it the newcomer waits as `pending` and replaces any older pending job.
   * Returns whether the job may start now.
   */
  private async concurrencySlot(job: JobRow): Promise<boolean> {
    if (!job.concurrency_group) return true;
    type Other = JobRow & { run_ref: string };
    const others = this.sql
      .exec<Other>("SELECT j.*, r.ref AS run_ref FROM jobs j JOIN runs r ON r.id = j.run_id WHERE j.concurrency_group = ? AND j.id != ? AND j.status IN ('pending', 'waiting', 'in_progress') ORDER BY j.rowid", job.concurrency_group, job.id)
      .toArray();
    const mine = this.sql.exec<{ ref: string }>("SELECT ref FROM runs WHERE id = ?", job.run_id).toArray()[0];
    // Jobs this one may replace or cancel (ACT-7); the rest it waits behind.
    const cancellable = (o: Other) => !mine || this.mayCancel(mine, { ref: o.run_ref });
    const pending = others.filter((o) => o.status === "pending" && cancellable(o));
    const running = others.filter((o) => o.status !== "pending");
    const failure = { message: `Canceling since a higher priority waiting request for '${job.concurrency_group}' exists` };
    if (running.length && (!job.concurrency_cancel || !running.every(cancellable))) {
      this.sql.exec("UPDATE jobs SET status = 'pending' WHERE id = ?", job.id);
      this.repo.broadcast(`run:${job.run_id}`, { action: "job", jobId: job.id });
      for (const o of pending) await this.completeJob(o.id, { conclusion: "cancelled", outputs: {}, failure });
      return false;
    }
    // Take the group before cancelling anything, so a job that starts meanwhile waits for this one.
    this.sql.exec("UPDATE jobs SET status = 'waiting' WHERE id = ?", job.id);
    for (const o of [...pending, ...running]) {
      await this.stopContainer(o);
      await this.completeJob(o.id, { conclusion: "cancelled", outputs: {}, failure });
    }
    return true;
  }

  /**
   * Like GitHub, a concurrency group without cancel-in-progress has at most one run waiting: a newer
   * run takes the place of older ones still waiting, which are cancelled. Otherwise every push to a
   * deploy's branch waits, and once the running deploy ends they start in no set order, each
   * deploying an older commit than the last push's (seen with a repository whose 15 queued deploys
   * waited behind one that hung: once it ended, production went back to older commits).
   */
  private async replaceWaiting(run: RunRow): Promise<void> {
    const older = this.sql
      .exec<{ id: string; ref: string }>("SELECT id, ref FROM runs WHERE concurrency_group = ? AND status = 'queued' AND conclusion IS NULL AND id != ? AND rowid < (SELECT rowid FROM runs WHERE id = ?)", run.concurrency_group, run.id, run.id)
      .toArray();
    for (const o of older) if (this.mayCancel(run, o)) await this.cancelInternal(o.id, `Canceling since a higher priority waiting request for '${run.concurrency_group}' exists`);
  }

  /**
   * Whether a run of `by` may cancel or replace `other` in a shared concurrency group. Groups are
   * repository-wide, as on GitHub, but a workflow pushed to some branch could otherwise name a
   * deploy's group and cancel it halfway: a run on a protected branch is cancelled only by runs on
   * that same branch (ACT-7).
   */
  private mayCancel(by: { ref: string }, other: { ref: string }): boolean {
    if (by.ref === other.ref) return true;
    return !(other.ref.startsWith("refs/heads/") && this.repo.protectionFor(other.ref.slice(11)));
  }

  /** Whether jobs wait on the account's hosted-job quota (RepoDO retries them on its alarm). */
  hasAccountHeldJobs(): boolean {
    return this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE fleet_held = 2 AND status = 'queued'").one().n > 0;
  }

  /** Try again to start jobs waiting on the account's hosted-job quota, oldest first, until one waits again. */
  async releaseAccountHeld(): Promise<void> {
    for (const { id } of this.sql.exec<{ id: string }>("SELECT id FROM jobs WHERE fleet_held = 2 AND status = 'queued' ORDER BY rowid").toArray()) {
      await this.launch(id);
      if (this.jobRow(id).fleet_held === 2) return;
    }
  }

  async jobTimedOut(jobId: string): Promise<void> {
    const j = this.jobRow(jobId);
    if (j.status === "completed") return;
    if (j.status === "queued" && j.fleet_held === 2) {
      await this.completeJob(jobId, { conclusion: "failure", outputs: {}, failure: { message: "The job waited 6 hours for a hosted runner (one of this account's hosted jobs to finish, or a free runner), and was not started." } }, "timed_out");
      return;
    }
    await this.stopContainer(j);
    await this.completeJob(jobId, { conclusion: "failure", outputs: {}, failure: { message: `The job exceeded its timeout of ${j.timeout_minutes} minutes.` } }, "timed_out");
  }

  private earlierDeadline(a: number | null, b: number | null): number | null {
    return a === null ? b : b === null ? a : Math.min(a, b);
  }

  /** When a running job's runner has had its timeout and JOB_DEADLINE_GRACE_MS to report, in ms since the epoch. */
  private jobDeadline(j: Pick<JobRow, "started_at" | "timeout_minutes">): number | null {
    const from = Date.parse(j.started_at ?? "");
    if (!Number.isFinite(from)) return null;
    const minutes = Number(j.timeout_minutes) > 0 ? Number(j.timeout_minutes) : DEFAULT_TIMEOUT_MINUTES;
    return from + minutes * 60_000 + JOB_DEADLINE_GRACE_MS;
  }

  /** The earliest deadline of a running job (RepoDO's alarm wakes up for it), or null. */
  nextJobDeadline(): number | null {
    let next: number | null = null;
    for (const j of this.sql.exec<JobRow>("SELECT started_at, timeout_minutes, cancel_at FROM jobs WHERE status = 'in_progress' AND started_at IS NOT NULL").toArray()) {
      const d = this.earlierDeadline(this.jobDeadline(j), j.cancel_at ? j.cancel_at + CANCEL_STOP_MS : null);
      if (d !== null && (next === null || d < next)) next = d;
    }
    return next;
  }

  /**
   * Ends running jobs past their deadline: their runner never reported, though it stops a job at its
   * timeout. Its container is stopped and the job fails as timed out, freeing the slot it held.
   */
  /**
   * Unfinished runs whose jobs have all finished, with when the last one did or the run was created,
   * whichever is later (ms since the epoch): a re-run's carried jobs keep their earlier finish times.
   */
  private finishedJobsRuns(): { id: string; last: number }[] {
    return this.sql
      .exec<{ id: string; last: string | null }>(
        `SELECT r.id, max(r.created_at, coalesce((SELECT max(completed_at) FROM jobs WHERE run_id = r.id), r.created_at)) AS last FROM runs r
         WHERE r.status != 'completed' AND EXISTS (SELECT 1 FROM jobs WHERE run_id = r.id)
           AND NOT EXISTS (SELECT 1 FROM jobs WHERE run_id = r.id AND status != 'completed')`,
      )
      .toArray()
      .map((r) => ({ id: r.id, last: Date.parse(r.last ?? "") || 0 }));
  }

  /** When repairStuckRuns next has something to do, in ms since the epoch. */
  nextStuckRunCheck(at = Date.now()): number | null {
    // Not yet due; due to finish (its workflow got the events again); or due but not repaired yet (its workflow's state was unknown): a minute later.
    const due = this.finishedJobsRuns().map((r) => (at < r.last + STUCK_RUN_MS ? r.last + STUCK_RUN_MS : this.nudged.has(r.id) ? r.last + STUCK_RUN_FINISH_MS : at + 60_000));
    return due.length ? Math.max(at, Math.min(...due)) : null;
  }

  /**
   * Repairs runs stuck in progress though all their jobs finished (see STUCK_RUN_MS): after STUCK_RUN_MS
   * their workflow gets the jobs' completion events again, and after STUCK_RUN_FINISH_MS, or after
   * STUCK_RUN_MS when the workflow no longer runs, Diffinery finishes the run, which frees its concurrency group.
   */
  async repairStuckRuns(at = Date.now()): Promise<void> {
    for (const r of this.finishedJobsRuns()) {
      if (at < r.last + STUCK_RUN_MS) continue;
      let instance: Awaited<ReturnType<Env["RUN_WORKFLOW"]["get"]>> | null = null;
      let state: string | null = null;
      try {
        instance = await this.env.RUN_WORKFLOW.get(r.id);
        state = (await instance.status()).status;
      } catch (e) {
        console.warn("run workflow status failed", r.id, e);
      }
      // Can't tell whether its workflow still runs: look again later (nextStuckRunCheck), up to STUCK_RUN_FINISH_MS.
      if (state === null && at < r.last + STUCK_RUN_FINISH_MS) continue;
      const live = state !== null && LIVE_WORKFLOW.has(state);
      if (instance && live && !this.nudged.has(r.id)) {
        this.nudged.add(r.id);
        console.warn("run stuck after its jobs finished: sending their completion events again", r.id, state);
        for (const j of this.sql.exec<{ id: string; conclusion: string | null }>("SELECT id, conclusion FROM jobs WHERE run_id = ?", r.id).toArray()) {
          await instance.sendEvent({ type: `job-${j.id}`, payload: { conclusion: j.conclusion } }).catch((e: unknown) => console.warn("resend job event failed", j.id, e));
        }
      }
      if (!live || at >= r.last + STUCK_RUN_FINISH_MS) await this.finishStuckRun(r.id, state ?? "unknown");
    }
  }

  /** Finishes a stuck run (repairStuckRuns). Jobs its workflow never started make it fail and are named, so it doesn't pass for a success. */
  private async finishStuckRun(runId: string, state: string): Promise<void> {
    console.warn("run stuck after its jobs finished: finishing it", runId, state);
    const run = this.runRow(runId);
    if (run.conclusion !== "cancelled") {
      let missing: string[] = [];
      try {
        const started = new Set(this.sql.exec<{ job_key: string }>("SELECT DISTINCT job_key FROM jobs WHERE run_id = ?", runId).toArray().map((j) => j.job_key));
        const exp = await this.expanded(run);
        missing = jobOrder(exp.workflow).order.flat().filter((k) => !started.has(k)).map((k) => exp.workflow.jobs[k]?.name ?? k);
      } catch (e) {
        console.warn("stuck run plan failed", runId, e);
      }
      if (missing.length) {
        const shown = missing.slice(0, 5).join(", ") + (missing.length > 5 ? ` and ${missing.length - 5} more` : "");
        await this.plannedError(runId, `The run's workflow stopped after its jobs finished, so ${missing.length === 1 ? "a job" : `${missing.length} jobs`} never started (${shown}). Re-run the workflow.`);
      }
    }
    await this.finishRun(runId);
  }

  /** Runs whose completion events were sent again (repairStuckRuns), so each run gets them once per object start. */
  private nudged = new Set<string>();

  async enforceJobDeadlines(at = Date.now()): Promise<void> {
    for (const j of this.sql.exec<JobRow>("SELECT * FROM jobs WHERE status = 'in_progress' AND started_at IS NOT NULL ORDER BY rowid").toArray()) {
      if (j.cancel_at && j.cancel_at + CANCEL_STOP_MS <= at) {
        await this.stopContainer(j);
        const message = `${j.cancel_reason ?? "Cancelled"}. Its runner didn't report within ${CANCEL_STOP_MS / 60_000} minutes of the cancel, so Diffinery stopped it.`;
        await this.completeJob(j.id, { conclusion: "cancelled", outputs: {}, failure: { message } });
        continue;
      }
      const d = this.jobDeadline(j);
      if (d === null || d > at) continue;
      const minutes = Number(j.timeout_minutes) > 0 ? Number(j.timeout_minutes) : DEFAULT_TIMEOUT_MINUTES;
      await this.stopContainer(j);
      await this.completeJob(
        j.id,
        { conclusion: "failure", outputs: {}, failure: { message: `The job exceeded its timeout of ${minutes} minutes, and its runner stopped responding: Diffinery ended it ${JOB_DEADLINE_GRACE_MS / 60_000} minutes later.` } },
        "timed_out",
      );
    }
  }

  async containerStopped(jobId: string, exitCode: number | null, container?: string, requested = false): Promise<void> {
    const j = this.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", jobId).toArray()[0];
    if (!j || j.status === "completed") return;
    // A container the job no longer runs in (it was replaced, and the job restarted in another).
    if (container && j.container !== container) return;
    // Cancelled, and its container stopped before the runner reported: the job ends as cancelled.
    if (j.cancel_at) return this.completeJob(jobId, { conclusion: "cancelled", outputs: {}, failure: { message: j.cancel_reason ?? "Cancelled" } });
    // Already back in line (placementFailed): a container given up on, which started after all,
    // finds its token revoked and exits. The job's next placement starts a new one.
    if (j.status === "queued") return;
    // Stopped before the runner fetched the job, so no step ran: place it again. During a
    // container rollout a new container can exit (or never get a machine) before it reports in.
    if (j.status === "waiting" && !j.labels) {
      if (exitCode) return this.placementFailed(jobId, `the runner exited with code ${exitCode} before it started the job`);
      return this.placementFailed(jobId, "the container stopped before the runner started", { quick: !requested && (j.early_stops ?? 0) < QUICK_RETRIES });
    }
    // Stopped without reporting while a newer runner image is deployed than the one it ran on: a rollout replaced it.
    const ran = j.runner_info ? (JSON.parse(j.runner_info) as JobRunnerInfo).image : undefined;
    if (!j.labels && ran && this.env.RUNNER_IMAGE && ran !== this.env.RUNNER_IMAGE) return this.runnerReplaced(j);
    // Stopped without an exit code (the library reports none, or 0) and not by Diffinery (a cancel, a
    // timeout): the platform stopped or lost the container, for example its host. The same as a
    // replacement. A runner that exits by itself reports its job first, and one that crashes exits non-zero.
    if (!j.labels && !exitCode && !requested) return this.runnerReplaced(j, "stopped");
    await this.completeJob(jobId, { conclusion: "failure", outputs: {}, failure: { message: exitCode ? `The runner stopped unexpectedly (exit code ${exitCode}).` : "The runner's container stopped before the job finished, without an exit code (the platform restarted or replaced it)." } });
  }

  /** The oldest waiting job whose runs-on labels the runner all offers, handed to it with a fresh job token. */
  private async assignJob(runnerName: string, runnerLabels: string[], runnerId: number | null): Promise<{ jobId: string; token: string; runId: string; name: string } | null> {
    const offered = new Set(["self-hosted", ...runnerLabels.map((l) => l.toLowerCase())]);
    const waiting = this.sql
      .exec<JobRow>("SELECT j.* FROM jobs j JOIN runs r ON r.id = j.run_id WHERE j.status = 'waiting' AND j.labels IS NOT NULL AND j.container IS NULL AND r.status != 'completed' ORDER BY r.created_at, j.rowid")
      .toArray();
    const job = waiting.find((j) => (JSON.parse(j.labels!) as string[]).every((l) => offered.has(l)));
    if (!job) return null;
    // A job parked before Actions were suspended here isn't handed out.
    const block = await this.blocked("self-hosted-job");
    if (block) {
      await this.completeJob(job.id, { conclusion: "failure", outputs: {}, failure: { message: `The job was not started: ${block}.` } });
      return null;
    }
    const m = this.repo.meta;
    const token = `djt_${m.repoId}_${job.id}_${randomToken(24)}`;
    const container = `self-hosted:${runnerName.slice(0, 64)}`;
    this.sql.exec("UPDATE jobs SET token_hash = ?, token_at = ?, container = ?, runner_id = ? WHERE id = ? AND container IS NULL", await sha256(token), now(), container, runnerId, job.id);
    this.repo.broadcast(`run:${job.run_id}`, { action: "job", jobId: job.id });
    return { jobId: job.id, token, runId: job.run_id, name: job.name };
  }

  // ------------------------------------------------------------ registered self-hosted runners

  /**
   * GitHub's runner registration token: a repository admin's credential, good for an hour, that a
   * machine trades for its own runner token. So the machine never holds a person's token, and the
   * jobs it runs (as the same OS user) can't read one.
   */
  async runnerRegistrationToken(caller: Caller): Promise<{ token: string; expires_at: string }> {
    if (caller.kind !== "user" || caller.permissions || !atLeast(caller.role, "admin")) throw new HttpError(403, "only repository admins can add self-hosted runners");
    const token = `drg_${randomToken(32)}`;
    const expires = new Date(Date.now() + REGISTRATION_TTL_MS).toISOString();
    const hash = await sha256(token);
    this.sql.exec("DELETE FROM runner_registrations WHERE expires_at < ?", now());
    this.sql.exec("INSERT INTO runner_registrations (token_hash, created_by, expires_at) VALUES (?, ?, ?)", hash, caller.login, expires);
    return { token, expires_at: expires };
  }

  /** Register a runner with a registration token; returns its own token, shown once. */
  async registerRunner(registration: string, name: string, labels: string[], ephemeral: boolean): Promise<{ id: number; name: string; labels: string[]; ephemeral: boolean; token: string; registeredBy: string }> {
    const hash = await sha256(registration);
    const reg = this.sql.exec<{ created_by: string }>("SELECT created_by FROM runner_registrations WHERE token_hash = ? AND expires_at > ?", hash, now()).toArray()[0];
    if (!reg) throw new HttpError(401, "invalid or expired registration token");
    const clean = [...new Set(labels.map((l) => String(l).trim().toLowerCase()).filter((l) => l && l !== "self-hosted"))];
    if (clean.length > 20) throw new HttpError(422, "a runner can offer at most 20 labels");
    const bad = clean.find((l) => !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(l));
    if (bad) throw new HttpError(422, `invalid label ${JSON.stringify(bad.slice(0, 70))}: use letters, digits, '.', '_' and '-' (up to 64)`);
    const runnerName = name.trim().slice(0, 64) || "runner";
    const count = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM runners").one().n;
    if (count >= MAX_RUNNERS) throw new HttpError(429, `this repository has ${count} self-hosted runners, the most allowed; remove one first`);
    const id = this.sql.exec<{ id: number }>("INSERT INTO runners (name, labels, ephemeral, created_by, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id", runnerName, JSON.stringify(clean), ephemeral ? 1 : 0, reg.created_by, now()).one().id;
    const token = `drn_${this.repo.meta.repoId}_${id}_${randomToken(32)}`;
    this.sql.exec("UPDATE runners SET token_hash = ? WHERE id = ?", await sha256(token), id);
    return { id, name: runnerName, labels: clean, ephemeral, token, registeredBy: reg.created_by };
  }

  /** A registered runner asks for work with its own token. An ephemeral runner's token ends with the job it takes. */
  async claimJobAsRunner(token: string): Promise<{ jobId: string; token: string; runId: string; name: string } | null> {
    const id = Number(token.split("_")[2]);
    const r = Number.isSafeInteger(id) ? this.sql.exec<RunnerRow>("SELECT * FROM runners WHERE id = ?", id).toArray()[0] : undefined;
    if (!r || !r.token_hash || r.token_hash !== (await sha256(token))) throw new HttpError(401, "this runner was removed, or its token is invalid; register it again");
    this.sql.exec("UPDATE runners SET last_seen_at = ? WHERE id = ?", now(), r.id);
    const job = await this.assignJob(r.name, JSON.parse(r.labels) as string[], r.id);
    if (job && r.ephemeral) this.sql.exec("UPDATE runners SET token_hash = NULL WHERE id = ?", r.id);
    return job;
  }

  runners(caller: Caller): RunnerInfo[] {
    if (!atLeast(caller.role, "admin") || caller.permissions) throw new HttpError(403, "only repository admins can list self-hosted runners");
    const busy = new Set(this.sql.exec<{ runner_id: number }>("SELECT DISTINCT runner_id FROM jobs WHERE runner_id IS NOT NULL AND status != 'completed'").toArray().map((x) => x.runner_id));
    return this.sql.exec<RunnerRow>("SELECT * FROM runners ORDER BY id").toArray().map((r) => ({
      id: r.id,
      name: r.name,
      os: "unknown",
      status: r.last_seen_at && Date.now() - Date.parse(r.last_seen_at) < RUNNER_ONLINE_MS ? "online" : "offline",
      busy: busy.has(r.id),
      ephemeral: !!r.ephemeral,
      labels: ["self-hosted", ...(JSON.parse(r.labels) as string[])].map((name, i) => ({ id: i + 1, name, type: i === 0 ? "read-only" : "custom" })),
    }));
  }

  /** Remove a runner: its token stops working at once. A job it is running carries on with its own job token. */
  deleteRunner(id: number, caller: Caller): void {
    if (caller.kind !== "user" || caller.permissions || !atLeast(caller.role, "admin")) throw new HttpError(403, "only repository admins can remove self-hosted runners");
    if (!this.sql.exec("DELETE FROM runners WHERE id = ? RETURNING id", id).toArray().length) throw new HttpError(404, "runner not found");
  }

  /**
   * Stops a hosted job's container, for a job Diffinery ends itself. `graceful` instead asks its runner to
   * cancel the job, running the steps that run after a cancel, and report (cancelInternal).
   */
  private async stopContainer(j: JobRow, graceful = false): Promise<void> {
    if (!j.container || j.container.startsWith("self-hosted:")) return;
    try {
      const ns = this.runnerNamespace(j.container);
      await ns.get(ns.idFromName(j.container)).stopJob(graceful);
    } catch (e) {
      console.warn("stop container failed", e);
    }
  }

  async finishRun(runId: string): Promise<RunInfo> {
    const run = this.runRow(runId);
    // Already finished by repairStuckRuns: the late workflow changes nothing and sends no second completed event.
    if (run.status === "completed") return toRun(run);
    const jobs = this.sql.exec<JobRow>("SELECT * FROM jobs WHERE run_id = ?", runId).toArray();
    let conclusion: RunRow["conclusion"] = run.conclusion === "cancelled" ? "cancelled" : "success";
    if (conclusion !== "cancelled") {
      // A job with continue-on-error may fail without failing the run.
      if (jobs.some((j) => (j.conclusion === "failure" || j.conclusion === "timed_out") && !j.continue_on_error)) conclusion = "failure";
      else if (jobs.some((j) => j.conclusion === "cancelled")) conclusion = "cancelled";
      // As on GitHub, a run whose jobs were all skipped is skipped, not a success, so a
      // workflow_run follower that checks for success (a live test after a deploy) doesn't run.
      else if (jobs.length && jobs.every((j) => j.conclusion === "skipped")) conclusion = "skipped";
    }
    const t = now();
    this.sql.exec("UPDATE runs SET status = 'completed', conclusion = ?, updated_at = ? WHERE id = ?", conclusion, t, runId);
    const m = this.repo.meta;
    this.repo.emit({ type: "workflow_run", action: "completed", repoId: m.repoId, owner: m.owner, repo: m.name, runId, conclusion: conclusion ?? undefined, actor: JSON.parse(run.actor), at: t });
    this.repo.broadcast(`run:${runId}`, { action: "completed", conclusion });
    this.repo.broadcast("runs", { action: "completed", runId });
    await this.onWorkflowRun(this.runRow(runId), "completed");
    return toRun(this.runRow(runId));
  }

  /**
   * Starts the default branch's `on: workflow_run` workflows that follow `run`. Like
   * GitHub, they run on the default branch, must name the workflows they follow, and
   * chains stop after three levels (A -> B -> C -> D; D's runs trigger nothing).
   */
  private async onWorkflowRun(run: RunRow, action: "requested" | "completed"): Promise<void> {
    if (this.chainDepth(run) >= 3) return;
    try {
      const sha = this.repo.getRef(this.repo.headRef);
      if (!sha) return;
      const followers = (await this.loadWorkflows(sha)).filter((w) => w.workflow?.on.workflow_run?.workflows?.length);
      if (!followers.length) return;
      const m = this.repo.meta;
      const payload = JSON.parse(run.event_payload) as { pull_request?: { head?: { ref?: string } } };
      const branch = payload.pull_request?.head?.ref ?? run.ref.replace(/^refs\/(heads|tags)\//, "");
      const actor = JSON.parse(run.actor) as Actor;
      const workflowRun = {
        id: run.run_number,
        name: run.workflow_name,
        display_title: run.display_title,
        path: run.workflow_path,
        run_number: run.run_number,
        run_attempt: run.attempt,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        head_branch: branch,
        head_sha: run.head_sha ?? run.sha,
        actor: { login: actor.login },
        triggering_actor: { login: actor.login },
        pull_requests: run.pr_number ? [{ number: run.pr_number }] : [],
        created_at: run.created_at,
        updated_at: run.updated_at,
        html_url: `${this.env.PUBLIC_URL}/${m.owner}/${m.name}/actions/runs/${run.id}`,
      };
      for (const w of followers) {
        if (!matchesTrigger(w.workflow!, { name: "workflow_run", action, workflow: run.workflow_name, branch })) continue;
        await this.createRun(w.workflow!, {
          event: "workflow_run",
          ref: this.repo.headRef,
          sha,
          payload: { action, workflow_run: workflowRun, workflow: { name: run.workflow_name, path: run.workflow_path }, repository: await this.repositoryPayload(), sender: { login: actor.login } },
          caller: actor,
          title: w.workflow!.name ?? w.path,
          // A follower acts on what the run it follows produced (artifacts, outputs), so it stays an agent's.
          agentOrigin: !!run.agent_origin,
        });
      }
    } catch (e) {
      console.warn("workflow_run trigger failed", e);
    }
  }

  /** How many workflow_run links led to `run` (0 for a run started by any other event). */
  private chainDepth(run: RunRow): number {
    let depth = 0;
    for (let r: RunRow | undefined = run; r?.event === "workflow_run" && depth < 3; depth++) {
      const parent: string | number | undefined = (JSON.parse(r.event_payload) as { workflow_run?: { id?: string | number } }).workflow_run?.id;
      r = parent !== undefined ? this.sql.exec<RunRow>("SELECT * FROM runs WHERE id = ? OR run_number = ? ORDER BY attempt DESC LIMIT 1", String(parent), Number(parent) || -1).toArray()[0] : undefined;
    }
    return depth;
  }

  async plannedError(runId: string, message: string): Promise<void> {
    const t = now();
    this.sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status, conclusion, started_at, completed_at, failure) VALUES (?, ?, 'setup', 'Set up workflow', 'completed', 'failure', ?, ?, ?)", newId(), runId, t, t, JSON.stringify({ message }));
  }

  // ---------------------------------------------------------------- cancellation and re-runs

  /**
   * Cancels a run's unfinished jobs. With `graceful` (someone cancelled the run), a running hosted job's
   * runner gets to run the steps that run after a cancel first, as on GitHub (CANCEL_STOP_MS); the job
   * ends when it reports. Otherwise, or when it was already cancelled that way, every job ends at once.
   */
  private async cancelInternal(runId: string, reason: string, graceful = false): Promise<void> {
    const run = this.runRow(runId);
    if (run.status === "completed") return;
    this.sql.exec("UPDATE runs SET conclusion = 'cancelled', updated_at = ? WHERE id = ?", now(), run.id);
    // One cancel, one deadline: the jobs it lets run their after-cancel steps all end together.
    const at = Date.now();
    for (const j of this.sql.exec<JobRow>("SELECT * FROM jobs WHERE run_id = ? AND status != 'completed'", run.id).toArray()) {
      if (graceful && !j.cancel_at && j.status === "in_progress" && !j.labels && j.container && !j.container.startsWith("self-hosted:")) {
        this.sql.exec("UPDATE jobs SET cancel_at = ?, cancel_reason = ? WHERE id = ?", at, reason, j.id);
        await this.stopContainer(j, true);
        this.repo.alarmBy(at + CANCEL_STOP_MS);
        continue;
      }
      await this.stopContainer(j);
      await this.completeJob(j.id, { conclusion: "cancelled", outputs: {}, failure: { message: j.cancel_reason ?? reason } });
    }
  }

  async cancel(runId: string, caller: Caller): Promise<void> {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "permission denied");
    await this.cancelInternal(runId, `Cancelled by ${caller.login}`, true);
  }

  /**
   * GitHub's "delete workflow run logs": every job's log lines (live and archived in R2) and step
   * summary go; the run, its jobs, checks and artifacts stay. A job of a later attempt that kept
   * this run's job shows an empty log too. People with write access may do it for any run; an
   * agent only for runs that didn't run on a protected or the default branch, so it can't erase
   * the record of what ran there. Returns the jobs whose logs were deleted.
   */
  async deleteLogs(runId: string, caller: Caller): Promise<string[]> {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "permission denied");
    if (caller.id.startsWith("job:")) throw new HttpError(403, "a workflow's GITHUB_TOKEN cannot delete workflow logs");
    const run = this.runRow(runId);
    if (run.status !== "completed") throw new HttpError(409, "this run hasn't finished yet; its logs can be deleted once it has");
    if (caller.kind === "agent" && run.ref.startsWith("refs/heads/")) {
      const branch = run.ref.slice("refs/heads/".length);
      if (branch === this.repo.meta.defaultBranch || this.repo.protectionFor(branch)) throw new HttpError(403, `agents can't delete the logs of runs on ${branch}, a protected or default branch`);
    }
    const jobIds = this.sql.exec<{ id: string }>("SELECT id FROM jobs WHERE run_id = ?", run.id).toArray().map((j) => j.id);
    for (const id of jobIds) {
      this.sql.exec("DELETE FROM logs WHERE job_id = ?", id);
      this.sql.exec("UPDATE jobs SET summary = NULL WHERE id = ?", id);
    }
    for (let i = 0; i < jobIds.length; i += 500) await this.env.BUCKET.delete(jobIds.slice(i, i + 500).flatMap((id) => logKeys(this.repo.meta.repoId, id)));
    return jobIds;
  }

  /**
   * A new attempt of a run, like GitHub's re-runs: `all` runs every job again; `failed` keeps the
   * jobs and matrix legs that succeeded, were skipped or were neutral (unless they depend on a job
   * that runs again) and runs the rest, with everything that depends on them.
   */
  async rerun(runId: string, caller: Caller, scope: "all" | "failed" = "all"): Promise<RunInfo> {
    await this.mayRerun(caller);
    const old = this.runRow(runId);
    if (scope === "all") return this.newAttempt(old, caller, null);
    if (old.status !== "completed") throw new HttpError(409, "this run hasn't finished yet; its failed jobs can be re-run once it has");
    const jobs = this.sql.exec<JobRow>("SELECT * FROM jobs WHERE run_id = ? ORDER BY rowid", old.id).toArray();
    const failed = jobs.filter((j) => !KEPT_CONCLUSIONS.has(j.conclusion ?? ""));
    if (!failed.length) throw new HttpError(409, "this run has no failed jobs to re-run");
    return this.newAttempt(old, caller, await this.carryFor(old, jobs, new Set(failed.map((j) => j.id))));
  }

  /** GitHub's "re-run a job": a new attempt that runs one job (one matrix leg) and every job that depends on it, keeping the rest. */
  async rerunJob(jobId: string, caller: Caller): Promise<RunInfo> {
    await this.mayRerun(caller);
    const job = this.jobRow(jobId);
    const old = this.runRow(job.run_id);
    if (old.status !== "completed") throw new HttpError(409, "this run hasn't finished yet; its jobs can be re-run once it has");
    const jobs = this.sql.exec<JobRow>("SELECT * FROM jobs WHERE run_id = ? ORDER BY rowid", old.id).toArray();
    return this.newAttempt(old, caller, await this.carryFor(old, jobs, new Set([job.id])));
  }

  private async mayRerun(caller: Caller): Promise<void> {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "permission denied");
    if (caller.id.startsWith("job:")) throw new HttpError(403, "a workflow's GITHUB_TOKEN cannot re-run workflows");
    await this.refuseIfBlocked("run");
  }

  /**
   * What a new attempt of `old` keeps when the jobs `rerun` (ids of its job rows) run again: every
   * job that neither runs again nor depends (through `needs`, reusable workflow calls included) on
   * one that does, and the other matrix legs of a job only some of whose legs run again. A job the
   * earlier attempt never got to (the run was cancelled first) runs too. Null means run everything:
   * the workflow can't be read any more, or what failed was the workflow's set-up.
   */
  private async carryFor(old: RunRow, jobs: JobRow[], rerun: Set<string>): Promise<RerunCarry | null> {
    let exp: Expanded;
    try {
      exp = await this.expanded(old);
    } catch {
      return null;
    }
    const defs = exp.workflow.jobs;
    if (jobs.some((j) => rerun.has(j.id) && !defs[j.job_key])) return null;
    const rows = new Map<string, JobRow[]>();
    for (const j of jobs) rows.set(j.job_key, [...(rows.get(j.job_key) ?? []), j]);
    const seeded = (key: string) => !rows.get(key)?.length || rows.get(key)!.some((j) => rerun.has(j.id));
    // The expanded workflow's `needs` already name a call's jobs, and what a called workflow's first jobs inherit from its caller.
    const memo = new Map<string, boolean>();
    const runsAgain = (key: string): boolean => {
      const known = memo.get(key);
      if (known !== undefined) return known;
      memo.set(key, false);
      const v = seeded(key) || upstream(key);
      memo.set(key, v);
      return v;
    };
    const upstream = (key: string): boolean => (defs[key]?.needs ?? []).some(runsAgain);
    const carry: RerunCarry = {};
    for (const key of Object.keys(defs)) {
      if (upstream(key)) continue;
      const mine = rows.get(key) ?? [];
      if (!seeded(key)) {
        carry[key] = { all: mine.map((j) => j.id) };
        continue;
      }
      const legs: Record<string, string[]> = {};
      for (const j of mine) if (!rerun.has(j.id) && j.status === "completed") (legs[canonicalJson(JSON.parse(j.matrix))] ??= []).push(j.id);
      if (Object.keys(legs).length) carry[key] = { legs };
    }
    return carry;
  }

  private async newAttempt(old: RunRow, caller: Caller, carry: RerunCarry | null): Promise<RunInfo> {
    const wf = (await this.loadWorkflows(old.sha)).find((w) => w.path === old.workflow_path)?.workflow;
    if (!wf) throw new HttpError(422, "workflow file no longer valid at this commit");
    // Whoever started an earlier attempt still can't approve this one where an environment prevents self-review.
    const priorActors = [...new Set([...((old.prior_actors ? JSON.parse(old.prior_actors) : []) as string[]), (JSON.parse(old.actor) as Actor).id])];
    const run = await this.createRun(wf, {
      event: old.event,
      ref: old.ref,
      sha: old.sha,
      headSha: old.head_sha ?? undefined,
      payload: JSON.parse(old.event_payload),
      caller,
      prNumber: old.pr_number ?? undefined,
      inputs: JSON.parse(old.inputs),
      title: old.display_title,
      // Re-running code an agent wrote keeps it acting as the agent, whoever re-runs it.
      agentOrigin: !!old.agent_origin,
      rerun: { runNumber: old.run_number, attempt: old.attempt + 1, priorActors, carry },
    });
    // Not started after all (Actions suspended meanwhile, or too many unfinished runs).
    if (!run) throw new HttpError(409, "the run was not started; try again later");
    return run;
  }

  // ---------------------------------------------------------------- runner protocol

  /** Validate a job or sandbox token. Returns what it grants. */
  async runnerAuth(
    token: string,
  ): Promise<{ kind: "job"; jobId: string; runId: string; role: Caller["role"]; permissions: JobPermissions; actorKind: Actor["kind"] } | { kind: "sandbox"; sandboxId: string; caller: Caller; taskPerson?: string } | null> {
    const parts = token.split("_");
    if (parts.length < 4) return null;
    const hash = await sha256(token);
    if (parts[0] === "djt") {
      const j = this.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", parts[2]!).toArray()[0];
      if (!j || j.token_hash !== hash || j.status === "completed") return null;
      // Bounded in time too: a job whose Workflow died never completes, and its token mustn't live on.
      const expires = jobTokenExpiry(j);
      if (expires === null || Date.now() >= expires) return null;
      const grant = this.repo.runtime.grantFor(j.id);
      // Code an agent wrote, pushed or opened a pull request with runs as that agent (repo/token-policy.ts).
      const run = this.sql.exec<{ agent_origin: number }>("SELECT agent_origin FROM runs WHERE id = ?", j.run_id).toArray()[0];
      const actorKind: Actor["kind"] = run?.agent_origin ? "agent" : "system";
      return { kind: "job", jobId: j.id, runId: j.run_id, role: grant.role, permissions: grant.permissions, actorKind };
    }
    if (parts[0] === "dst") {
      const s = this.sql.exec<{ id: string; secret: string; created_by: string; status: string; created_at: string; task_person: string | null }>("SELECT * FROM sandboxes WHERE id = ?", parts[2]!).toArray()[0];
      if (!s || s.secret !== hash || s.status !== "running") return null;
      // A sandbox's token lasts a day at most, even if nobody closes the sandbox.
      if (Date.now() - Date.parse(s.created_at) > SANDBOX_TOKEN_TTL_MS) return null;
      return { kind: "sandbox", sandboxId: s.id, caller: JSON.parse(s.created_by) as Caller, ...(s.task_person ? { taskPerson: s.task_person } : {}) };
    }
    return null;
  }

  private async authJob(jobId: string, token: string): Promise<JobRow> {
    const auth = await this.runnerAuth(token);
    if (!auth || auth.kind !== "job" || auth.jobId !== jobId) throw new HttpError(401, "invalid job token");
    return this.jobRow(jobId);
  }

  /** Claims for an OIDC id token; side-effect free (unlike runnerSpec). */
  async oidcClaims(jobId: string, token: string): Promise<{ allowed: boolean; github: Record<string, string> }> {
    const job = await this.authJob(jobId, token);
    if (job.status !== "in_progress") throw new HttpError(409, "job is not running");
    const run = this.runRow(job.run_id);
    const exp = await this.expanded(run);
    const def: Job = exp.workflow.jobs[job.job_key]!;
    const wf = exp.workflowOf.get(job.job_key)!;
    const allowed = this.repo.runtime.grantFor(jobId).permissions["id-token"] === "write";
    const ctx = this.githubContext(run, localKey(job.job_key, exp.parentOf.get(job.job_key) ?? null), token) as Record<string, Json>;
    const github: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx)) if (typeof v === "string" || typeof v === "number") github[k] = String(v);
    // Ids don't change when a name is reused, so a cloud trust policy can pin them; the environment is the one
    // whose protection rules this job passed (runnerSpec records its deployment).
    github.repository_owner_id = String(numericId(this.repo.meta.ownerId));
    const actor = JSON.parse(run.actor) as Actor;
    if (actor.id) github.actor_id = String(numericId(actor.id));
    const env = this.sql.exec<{ environment: string }>("SELECT environment FROM deployments WHERE job_id = ?", jobId).toArray()[0];
    // The environment claim vouches for the job like the environment's secrets do: a job refused those
    // (a pull request ref, or agent code the policy keeps them from) gets the ref or pull request subject.
    if (env && this.repo.deploys.secretsAllowed(env.environment, run.ref, run.agent_origin ? "agent" : actor.kind)) github.environment = env.environment;
    // Lets a cloud trust policy refuse code an agent wrote, whatever ref or environment it ran on.
    github.agent_origin = run.agent_origin ? "true" : "false";
    return { allowed, github };
  }

  /**
   * What a job token may do with container packages (the `packages` permission).
   * A workflow without a permissions block gets the repository's default: read in
   * repositories with read-only tokens (the default for new ones), write in those that
   * keep GitHub's old permissive default. A permissions map that leaves `packages` out gets none.
   */
  async packagesPermission(token: string): Promise<"none" | "read" | "write"> {
    const auth = await this.runnerAuth(token);
    return auth?.kind === "job" ? auth.permissions.packages : "none";
  }

  /**
   * A pull_request run for a pull request from another repository (a fork): its jobs
   * never get write or secrets. Decided from the pull request's row, not the event payload.
   */
  private untrusted(run: RunRow): boolean {
    return run.event === "pull_request" && this.repo.policy.isForkPull(run.pr_number);
  }

  /**
   * Turns away a hosted runner on an image other than the deployed one (see STALE_IMAGE_TRIES).
   * `deployed` is the image of the Worker that took the runner's request. After a deploy this
   * object can run the previous version for minutes, while the Worker is updated within seconds
   * and the containers come up on the new image: going by this object's own RUNNER_IMAGE then
   * turned away every runner on the new image until this object was updated too.
   */
  private async refuseStaleRunner(job: JobRow, runner: JobRunnerInfo | null, deployed: string | null = null): Promise<void> {
    const want = deployed ?? this.env.RUNNER_IMAGE;
    if (!want || job.labels || runner?.image === want || (job.stale_tries ?? 0) >= STALE_IMAGE_TRIES) return;
    await this.waitForImage(job, `a runner started on ${runner?.image ?? "an older image"} while the deploy of ${want} was rolling out`);
    throw new HttpError(409, `this runner's image (${runner?.image ?? "unknown"}) was replaced by ${want}; the job starts again on a new runner`);
  }

  /** `deployed`: the runner image of the Worker that took the request (see refuseStaleRunner). */
  async runnerSpec(jobId: string, token: string, runner: JobRunnerInfo | null = null, deployed: string | null = null): Promise<JobSpec> {
    const job = await this.authJob(jobId, token);
    await this.refuseStaleRunner(job, runner, deployed);
    const run = this.runRow(job.run_id);
    const exp = await this.expanded(run);
    const def: Job = exp.workflow.jobs[job.job_key]!;
    const wf = exp.workflowOf.get(job.job_key)!;
    const parent = exp.parentOf.get(job.job_key) ?? null;
    const short = localKey(job.job_key, parent);
    let scope: { inputs: Record<string, unknown>; secrets: Record<string, string> };
    try {
      // A fork's code never sees the repository's secrets, as on GitHub, and an agent's only where an admin allows it.
      scope = await this.callContext(run, exp, parent, !this.untrusted(run) && (!run.agent_origin || this.repo.policy.settings().agentRunSecrets));
    } catch (e) {
      await this.completeJob(jobId, { conclusion: "failure", outputs: {}, failure: { message: (e as Error).message } });
      throw new HttpError(409, (e as Error).message);
    }
    // The job may have gone back in line while this ran (a start that reported a failure although its
    // runner came up, see place): its token was revoked then, and its next runner runs it instead.
    // Checked again with no await before the job is marked started, so it never runs on two runners.
    const hash = await sha256(token);
    const holds = () => {
      const j = this.jobRow(jobId);
      if (j.status === "completed" || j.token_hash !== hash) throw new HttpError(409, "this runner's job went back in line; it starts again on a new runner");
    };
    holds();
    const m = this.repo.meta;
    // Deployment environment (`environment:`): its branch policy, secrets and variables, and a deployment record.
    let environment: { secrets: Record<string, string>; vars: Record<string, string> } = { secrets: {}, vars: {} };
    if (def.environment) {
      try {
        const ctx = { github: this.githubContext(run, short, ""), inputs: scope.inputs, vars: this.variables(), matrix: JSON.parse(job.matrix), strategy: JSON.parse(job.strategy), needs: await this.needsResults(run, exp, exp.needs.get(job.job_key) ?? [], parent) };
        // The name evaluated at launch, whose protection rules the job passed (older jobs evaluate it here).
        const name = job.environment ?? interpolate(def.environment.name, ctx);
        if (this.repo.deploys.protection(name) && job.gate_state !== "released") throw new Error(`The environment ${name} requires approval this job didn't get. Re-run the job to ask for it.`);
        const url = def.environment.url && !def.environment.url.includes("steps.") ? interpolate(def.environment.url, ctx) : undefined;
        const logUrl = `${this.env.PUBLIC_URL}/${m.owner}/${m.name}/actions/runs/${run.id}/job/${jobId}`;
        // Code an agent wrote deploys as that agent (environment rules hold it to the agent's limits).
        const actor = JSON.parse(run.actor) as Actor;
        environment = await this.repo.deploys.jobStarted({ id: jobId, ref: run.ref, sha: run.sha, logUrl, actor: run.agent_origin ? { ...actor, kind: "agent" } : actor }, { name, url });
      } catch (e) {
        await this.completeJob(jobId, { conclusion: "failure", outputs: {}, failure: { message: (e as Error).message } });
        throw new HttpError(409, (e as Error).message);
      }
    }
    holds();
    const t = now();
    this.sql.exec("UPDATE jobs SET status = 'in_progress', started_at = ?, runner_info = ? WHERE id = ?", t, runner ? JSON.stringify(runner) : null, jobId);
    // Wake up at its deadline in case its runner freezes (enforceJobDeadlines).
    this.repo.alarmBy(this.jobDeadline({ started_at: t, timeout_minutes: job.timeout_minutes })!);
    this.repo.upsertCheck({ sha: run.head_sha ?? run.sha, name: this.checkName(run, job), status: "in_progress", runId: run.id, jobId, detailsUrl: `${this.env.PUBLIC_URL}/${m.owner}/${m.name}/actions/runs/${run.id}/job/${jobId}` });
    this.repo.broadcast(`run:${run.id}`, { action: "job", jobId });
    // Only the secrets the job's expressions name reach the runner, as on GitHub (plus the runner's own debug switches).
    const used = referencedSecrets(def, wf.env);
    if (used !== "all") for (const name of RUNNER_SECRETS) used.add(name);
    const secrets: Record<string, string> = { ...secretsFor({ ...scope.secrets, ...(this.untrusted(run) ? {} : environment.secrets) }, used), GITHUB_TOKEN: token, DIFFINERY_TOKEN: token };
    // The job token can do what the effective `permissions:` allow (job level wins, like GitHub).
    const permissions = permissionsForJob(exp, job.job_key, { untrusted: this.untrusted(run), repoDefault: this.repo.policy.settings().defaultPermissions });
    this.repo.runtime.grant(jobId, permissions);
    const idToken = permissions["id-token"] === "write";
    return {
      ...(job.size_note && !job.labels ? { runnerSize: job.size_note } : {}),
      runId: run.id,
      jobId,
      jobKey: short,
      name: job.name,
      repo: { owner: m.owner, name: m.name, cloneUrl: `${this.env.PUBLIC_URL}/${m.owner}/${m.name}.git`, defaultBranch: m.defaultBranch },
      sha: run.sha,
      ref: run.ref,
      workflowPath: run.workflow_path,
      github: this.githubContext(run, short, token),
      env: { ...wf.env, ...def.env },
      defaults: { run: { ...wf.defaults.run, ...def.defaults.run } },
      matrix: JSON.parse(job.matrix),
      strategy: JSON.parse(job.strategy),
      needs: await this.needsResults(run, exp, exp.needs.get(job.job_key) ?? [], parent),
      inputs: scope.inputs,
      vars: { ...this.variables(), ...environment.vars },
      secrets,
      outputs: def.outputs,
      steps: def.steps.map((s) => ({ ...s, "timeout-minutes": s["timeout-minutes"] === undefined ? undefined : Number(s["timeout-minutes"]) })),
      container: def.container,
      services: def.services,
      timeoutMinutes: job.timeout_minutes,
      continueOnError: !!job.continue_on_error,
      idToken: !!idToken,
      apiUrl: this.env.PUBLIC_URL,
      token,
      runtime: await this.runtimeServices(run, job),
    };
  }

  /** ACTIONS_RUNTIME_TOKEN and the service URLs; the token expires when the job would time out. */
  private async runtimeServices(run: RunRow, job: JobRow): Promise<JobSpec["runtime"]> {
    if (!this.env.MASTER_KEY) return undefined;
    const origin = new URL(this.env.PUBLIC_URL).origin;
    const exp = Math.floor(Date.now() / 1000) + (job.timeout_minutes + 30) * 60;
    const { scopes } = this.repo.runtime.job(job.id);
    const token = await signRuntimeToken(this.env, origin, { repo: this.repo.meta.repoId, run: run.id, job: job.id, exp }, scopes);
    return { token, resultsUrl: `${origin}/`, cacheUrl: `${origin}/_runtime/`, runtimeUrl: `${origin}/_runtime/` };
  }

  async runnerLogs(jobId: string, token: string, lines: LogLine[]): Promise<void> {
    const job = await this.authJob(jobId, token);
    let chars = job.log_chars ?? 0;
    if (chars > MAX_JOB_LOG) return;
    let seq = this.sql.exec<{ n: number | null }>("SELECT max(seq) AS n FROM logs WHERE job_id = ?", jobId).one().n ?? -1;
    const out: Array<LogLine & { seq: number }> = [];
    for (const l of lines.slice(0, 5000)) {
      seq++;
      const t = String(l.t ?? "").slice(0, 40);
      const step = Number.isInteger(l.step) ? l.step : 0;
      let text = String(l.text ?? "");
      if (text.length > 16384) text = `${text.slice(0, 16384)}…`;
      // Past the cap, one last line says so and the rest is dropped: the whole log is read into
      // memory when the job completes, to archive it.
      if (chars + text.length > MAX_JOB_LOG) {
        text = `The log is cut off here: a job's log is limited to ${MAX_JOB_LOG / 1048576} MiB of text.`;
        chars = MAX_JOB_LOG + 1;
      } else chars += text.length;
      this.sql.exec("INSERT INTO logs (job_id, seq, t, step, text) VALUES (?, ?, ?, ?, ?)", jobId, seq, t, step, text);
      out.push({ t, step, text, seq });
      if (chars > MAX_JOB_LOG) break;
    }
    this.sql.exec("UPDATE jobs SET log_chars = ? WHERE id = ?", chars, jobId);
    this.repo.broadcast(`job:${jobId}`, { action: "logs", lines: out });
  }

  async runnerStep(jobId: string, token: string, index: number, report: StepReport): Promise<void> {
    const job = await this.authJob(jobId, token);
    const steps = JSON.parse(job.steps) as Array<StepReport & { index: number }>;
    const existing = steps.findIndex((s) => s.index === index);
    const next = { ...(existing >= 0 ? steps[existing] : {}), ...report, index };
    if (existing >= 0) steps[existing] = next;
    else steps.push(next);
    steps.sort((a, b) => a.index - b.index);
    this.sql.exec("UPDATE jobs SET steps = ? WHERE id = ?", JSON.stringify(steps), jobId);
    this.repo.broadcast(`job:${jobId}`, { action: "step", step: next });
    this.repo.broadcast(`run:${job.run_id}`, { action: "job", jobId });
  }

  async runnerComplete(jobId: string, token: string, completion: JobCompletion, deployed: string | null = null): Promise<void> {
    const job = await this.authJob(jobId, token);
    // Cancelled while it ran: it ends here whatever stopped it, never starting again, and says who cancelled it.
    if (job.cancel_at) {
      const { replaced: _, ...rest } = completion;
      return this.completeJob(jobId, rest.conclusion === "cancelled" ? { ...rest, failure: { message: job.cancel_reason ?? "Cancelled" } } : rest);
    }
    if (completion.replaced && completion.conclusion !== "success" && !job.labels) {
      // The runner can't tell a rollout's SIGTERM from the platform's own; its image can: on the
      // deployed one, no deploy replaced it (the platform stopped or moved its container).
      const image = job.runner_info ? (JSON.parse(job.runner_info) as JobRunnerInfo).image : undefined;
      const want = deployed ?? this.env.RUNNER_IMAGE;
      return this.runnerReplaced(job, image && want && image === want ? "stopped" : "replaced");
    }
    await this.completeJob(jobId, completion);
  }

  /**
   * The platform replaced a hosted job's runner while the job ran (a deploy's container rollout, or
   * the platform moving the container), or stopped its container without warning (`how` "stopped",
   * see containerStopped). Its stop signal reaches the running step too, so the job can't finish there. It starts again from the beginning on a new runner, as if it had just been
   * queued, up to MAX_RUNNER_RESTARTS times, when running its steps again can't repeat anything
   * outside the run: no step but checkout had started, or the job could only read (see `readOnly`).
   * Otherwise, or past the limit, the job fails and says why.
   */
  private async runnerReplaced(job: JobRow, how: "replaced" | "stopped" = "replaced"): Promise<void> {
    const what = how === "replaced" ? "The platform replaced this job's runner with a new version" : "The platform stopped this job's container";
    const run = this.runRow(job.run_id);
    const steps = JSON.parse(job.steps) as Array<StepReport & { index: number }>;
    let exp: Expanded | null = null;
    try {
      exp = await this.expanded(run);
    } catch (e) {
      console.error("could not read the job's steps", e);
    }
    const defs = exp?.workflow.jobs[job.job_key]?.steps ?? [];
    const ran = steps.filter((s) => s.startedAt && !/^actions\/checkout@/.test(defs[s.index]?.uses ?? ""));
    // The step the platform stopped: the last one that started.
    const stopped = ran.at(-1);
    const restarts = (job.restarts ?? 0) + 1;
    const repeatable = !stopped || (exp !== null && this.readOnly(run, job, exp));
    if (!repeatable || restarts > MAX_RUNNER_RESTARTS) {
      const why = !repeatable
        ? `while step "${stopped!.name}" ran. Diffinery doesn't start a job again by itself once its steps have run if it could change something outside the run (it uses secrets, a deployment environment, or a token that can write), since running them twice could repeat what they did`
        : `${stopped ? "after its steps had started" : "before the job's steps ran"}, ${MAX_RUNNER_RESTARTS + 1} times`;
      await this.completeJob(job.id, { conclusion: "failure", outputs: {}, failure: { message: `${what} ${why}. Re-run the job.` } });
      return;
    }
    const t = now();
    this.sql.exec(
      "UPDATE jobs SET status = 'queued', container = NULL, token_hash = NULL, started_at = NULL, steps = '[]', outputs = '{}', failure = NULL, summary = NULL, runner_info = NULL, log_chars = 0, restarts = ? WHERE id = ?",
      restarts,
      job.id,
    );
    // The log starts over, with a line that says why (its seq keeps counting up, for live readers).
    const when = stopped ? `while step "${stopped.name}" ran. The job can only read (no secrets, deployment environment or token that can write), so` : "before the job's steps ran.";
    const text = `##[warning]${what} ${when} Diffinery started the job again from the beginning on a new runner (restart ${restarts} of ${MAX_RUNNER_RESTARTS}).`;
    const seq = (this.sql.exec<{ n: number | null }>("SELECT max(seq) AS n FROM logs WHERE job_id = ?", job.id).one().n ?? -1) + 1;
    this.sql.exec("DELETE FROM logs WHERE job_id = ?", job.id);
    this.sql.exec("INSERT INTO logs (job_id, seq, t, step, text) VALUES (?, ?, ?, -1, ?)", job.id, seq, t, text);
    this.sql.exec("UPDATE jobs SET log_chars = ? WHERE id = ?", text.length, job.id);
    // What the stopped attempt uploaded goes too: the new attempt uploads its own, under the same names.
    await this.repo.runtime.sweepJob(job.id, { restart: true }).catch((e) => console.error("runtime sweep failed", e));
    await endCompute(this.env, job.id).catch((e: unknown) => console.error("compute usage failed", e));
    this.repo.upsertCheck({ sha: run.head_sha ?? run.sha, name: this.checkName(run, job), status: "queued", runId: run.id, jobId: job.id, detailsUrl: this.jobUrl(run, job.id) });
    this.repo.broadcast(`job:${job.id}`, { action: "restarted" });
    this.repo.broadcast(`run:${run.id}`, { action: "job", jobId: job.id });
    try {
      const instance = await this.env.RUN_WORKFLOW.get(run.id);
      await instance.sendEvent({ type: `job-${job.id}`, payload: { retryInSeconds: 10 } });
    } catch (e) {
      console.error("could not ask the run's workflow to start the job again", e);
      await this.completeJob(job.id, { conclusion: "failure", outputs: {}, failure: { message: `${what}, and Diffinery could not start the job again. Re-run the job.` } });
    }
  }

  /**
   * Whether the job could only read, so running it again from the beginning can't repeat anything
   * outside the run: its steps name no secrets (its token aside), it deploys to no environment, and
   * its token's effective `permissions:` write nothing (an OIDC token counts as a write). What it
   * left in the run itself (log, check, uploads, caches) is reset when it starts again.
   */
  private readOnly(run: RunRow, job: JobRow, exp: Expanded): boolean {
    try {
      const def = exp.workflow.jobs[job.job_key];
      const wf = exp.workflowOf.get(job.job_key);
      if (!def || !wf || def.environment) return false;
      const used = referencedSecrets(def, wf.env);
      if (used === "all" || [...used].some((name) => name !== "GITHUB_TOKEN" && !RUNNER_SECRETS.includes(name))) return false;
      const permissions = permissionsForJob(exp, job.job_key, { untrusted: this.untrusted(run), repoDefault: this.repo.policy.settings().defaultPermissions });
      return Object.values(permissions).every((access) => access !== "write");
    } catch (e) {
      console.error("could not tell whether the job only reads", e);
      return false;
    }
  }

  private async completeJob(jobId: string, completion: JobCompletion, override?: "timed_out"): Promise<void> {
    const job = this.jobRow(jobId);
    if (job.status === "completed") return;
    const gated = job.status === "approval";
    const run = this.runRow(job.run_id);
    const t = now();
    const conclusion = override ?? completion.conclusion;
    this.sql.exec(
      "UPDATE jobs SET status = 'completed', conclusion = ?, completed_at = ?, outputs = ?, failure = ?, summary = ?, token_hash = NULL, started_at = COALESCE(started_at, ?), usage = COALESCE(?, usage) WHERE id = ?",
      conclusion,
      t,
      JSON.stringify(completion.outputs ?? {}),
      completion.failure ? JSON.stringify(completion.failure) : null,
      completion.summary ?? null,
      t,
      job.labels ? null : cleanUsage(completion.usage),
      jobId,
    );
    // The run's last job: check later that the workflow finished the run (repairStuckRuns).
    if (!this.sql.exec("SELECT 1 FROM jobs WHERE run_id = ? AND status != 'completed' LIMIT 1", run.id).toArray().length) this.repo.alarmBy(Date.parse(t) + STUCK_RUN_MS);
    this.repo.deploys.jobCompleted(jobId, conclusion);
    const m = this.repo.meta;
    this.repo.upsertCheck({
      sha: run.head_sha ?? run.sha,
      name: this.checkName(run, job),
      status: "completed",
      conclusion: conclusion === "timed_out" ? "timed_out" : conclusion,
      runId: run.id,
      jobId,
      detailsUrl: `${this.env.PUBLIC_URL}/${m.owner}/${m.name}/actions/runs/${run.id}/job/${jobId}`,
      output: completion.failure ? { title: "Failed", summary: completion.failure.message } : { title: conclusion },
    });
    // Archive logs to R2 and free the Durable Object's storage.
    const lines = this.sql.exec<LogLine & { seq: number }>("SELECT seq, t, step, text FROM logs WHERE job_id = ? ORDER BY seq", jobId).toArray();
    if (lines.length) {
      await this.env.BUCKET.put(this.logKey(jobId), JSON.stringify(lines), { httpMetadata: { contentType: "application/json" } });
      this.sql.exec("DELETE FROM logs WHERE job_id = ?", jobId);
    }
    // Uploads the job left unfinished stop counting against the budgets, and their bytes go.
    await this.repo.runtime.sweepJob(jobId).catch((e) => console.error("runtime sweep failed", e));
    this.repo.broadcast(`job:${jobId}`, { action: "completed", conclusion });
    this.repo.broadcast(`run:${run.id}`, { action: "job", jobId });

    // fail-fast: cancel unfinished siblings of a failed matrix job (unless the failed leg may continue on error).
    const siblings = this.sql.exec<JobRow>("SELECT * FROM jobs WHERE run_id = ? AND job_key = ? AND id != ? AND status != 'completed'", run.id, job.job_key, jobId).toArray();
    const strategy = JSON.parse(job.strategy || "{}") as { "fail-fast"?: boolean };
    if ((conclusion === "failure" || conclusion === "timed_out") && !job.continue_on_error && strategy["fail-fast"] !== false && siblings.length) {
      for (const s of siblings) {
        await this.stopContainer(s);
        await this.completeJob(s.id, { conclusion: "cancelled", outputs: {}, failure: { message: `Cancelled because ${job.name} failed (fail-fast).` } });
      }
    } else {
      // A leg that never started (max-parallel), not one back in line after getting no machine or
      // being restarted: the run's workflow starts that one again (placementFailed, the safe restart).
      const queued = siblings.find((s) => s.status === "queued" && !s.placement_tries && !s.restarts);
      if (queued) await this.launch(queued.id);
    }
    // An ephemeral runner is done once its one job is.
    if (job.runner_id) this.sql.exec("DELETE FROM runners WHERE id = ? AND ephemeral = 1 AND token_hash IS NULL", job.runner_id);
    // A hosted job hands its slot to the oldest job waiting for one (the repository's or the account's).
    if (!job.labels && job.container) {
      await endCompute(this.env, jobId).catch((e: unknown) => console.error("compute usage failed", e));
      const held = this.sql.exec<{ id: string }>("SELECT id FROM jobs WHERE fleet_held > 0 AND status = 'queued' ORDER BY rowid LIMIT 1").toArray()[0];
      if (held) await this.launch(held.id);
    }
    // A job that held its concurrency group hands it to the oldest pending job (of any run).
    if (job.concurrency_group && (job.status === "waiting" || job.status === "in_progress")) {
      const next = this.sql.exec<{ id: string }>("SELECT id FROM jobs WHERE concurrency_group = ? AND status = 'pending' ORDER BY rowid LIMIT 1", job.concurrency_group).toArray()[0];
      if (next) await this.launch(next.id);
    }
    try {
      const instance = await this.env.RUN_WORKFLOW.get(run.id);
      await instance.sendEvent({ type: `job-${jobId}`, payload: { conclusion } });
    } catch (e) {
      console.error("failed to notify workflow", e);
    }
    // The Workflow waits for a job held for approval on its own event.
    if (gated) {
      this.syncWaiting(run.id);
      await this.wakeGate(run.id, jobId);
    }
  }

  // ---------------------------------------------------------------- secrets and variables

  private async repoSecrets(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const r of this.sql.exec<{ name: string; ciphertext: string }>("SELECT name, ciphertext FROM secrets").toArray()) {
      // Sealed with a previous MASTER_KEY: stored again with the current one (lib/crypto.ts), keeping updated_at, which is when a person set it.
      out[r.name] = await decryptAndReseal(this.env, `repo:${this.repo.meta.repoId}`, r.ciphertext, (sealed) =>
        this.sql.exec("UPDATE secrets SET ciphertext = ? WHERE name = ? AND ciphertext = ?", sealed, r.name, r.ciphertext),
      );
    }
    return out;
  }

  private async orgSecrets(): Promise<Record<string, string>> {
    const m = this.repo.meta;
    if (m.ownerKind !== "org") return {};
    // Only the secrets whose repository selection includes this repository (visibility all, private or selected).
    const rows = await this.env.DB.prepare(
      `SELECT s.name, s.ciphertext FROM org_secrets s WHERE s.org_id = ?1 AND (s.visibility = 'all'
         OR (s.visibility = 'private' AND EXISTS (SELECT 1 FROM repos r WHERE r.id = ?2 AND r.visibility != 'public'))
         OR (s.visibility = 'selected' AND EXISTS (SELECT 1 FROM org_secret_repos x WHERE x.org_id = s.org_id AND x.name = s.name AND x.repo_id = ?2)))`,
    )
      .bind(m.ownerId, m.repoId)
      .all<{ name: string; ciphertext: string }>();
    const out: Record<string, string> = {};
    for (const r of rows.results) {
      out[r.name] = await decryptAndReseal(this.env, `org:${m.ownerId}`, r.ciphertext, (sealed) =>
        this.env.DB.prepare("UPDATE org_secrets SET ciphertext = ? WHERE org_id = ? AND name = ? AND ciphertext = ?").bind(sealed, m.ownerId, r.name, r.ciphertext).run(),
      );
    }
    return out;
  }

  async setSecret(name: string, value: string): Promise<void> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^GITHUB_/i.test(name)) throw new HttpError(422, "invalid secret name");
    this.sql.exec("INSERT OR REPLACE INTO secrets (name, ciphertext, updated_at) VALUES (?, ?, ?)", name.toUpperCase(), await encryptSecret(this.env, `repo:${this.repo.meta.repoId}`, value), now());
  }

  deleteSecret(name: string): void {
    this.sql.exec("DELETE FROM secrets WHERE name = ?", name.toUpperCase());
  }

  secretNames(): Array<{ name: string; updatedAt: string }> {
    return this.sql.exec<{ name: string; updated_at: string }>("SELECT name, updated_at FROM secrets ORDER BY name").toArray().map((r) => ({ name: r.name, updatedAt: r.updated_at }));
  }

  setVariable(name: string, value: string | null): void {
    if (value === null) this.sql.exec("DELETE FROM variables WHERE name = ?", name.toUpperCase());
    else this.sql.exec("INSERT OR REPLACE INTO variables (name, value, updated_at) VALUES (?, ?, ?)", name.toUpperCase(), value, now());
  }

  /** Variables for `vars.*`: the organization's, overridden by the repository's. `withOrg = false` lists only the repository's own. */
  variables(withOrg = true): Record<string, string> {
    const own = Object.fromEntries(this.sql.exec<{ name: string; value: string }>("SELECT name, value FROM variables").toArray().map((r) => [r.name, r.value]));
    if (!withOrg) return own;
    const org = Object.fromEntries(this.sql.exec<{ name: string; value: string }>("SELECT name, value FROM org_variables").toArray().map((r) => [r.name, r.value]));
    return { ...org, ...own };
  }

  // ---------------------------------------------------------------- cache and artifacts

  /**
   * An older runner's cache (the runner API before the toolkit's cache service).
   * Entries are stored as `<ref>\n<key>` and scoped like the cache service's
   * (repo/runtime.ts): a job saves to its own ref and restores from its own ref,
   * then the pull request's base, then the default branch, so one branch or pull
   * request never sees another's caches. Entries saved before scoping (no ref)
   * are never restored, so they go a week after their last use.
   */
  async cacheLookup(jobId: string, token: string, key: string, restoreKeys: string[]): Promise<{ key: string; stored: string } | null> {
    await this.authJob(jobId, token);
    const { scopes } = this.repo.runtime.job(jobId);
    // An entry whose object is gone is forgotten, and the lookup moves on.
    for (let attempt = 0; attempt < 5; attempt++) {
      const hit = this.legacyCacheMatch(scopes, key, restoreKeys);
      if (!hit) return null;
      if (!(await headFirst(this.env.BUCKET, this.cacheR2Keys(hit)))) {
        this.sql.exec("DELETE FROM caches WHERE key = ?", hit);
        continue;
      }
      this.sql.exec("UPDATE caches SET last_used = ? WHERE key = ?", now(), hit);
      return { key: hit.slice(hit.indexOf("\n") + 1), stored: hit };
    }
    return null;
  }

  /** In each scope in turn: the exact key, then the newest entry for each restore key prefix. */
  private legacyCacheMatch(scopes: string[], key: string, restoreKeys: string[]): string | null {
    for (const scope of scopes) {
      const exact = this.sql.exec<{ key: string }>("SELECT key FROM caches WHERE key = ?", `${scope}\n${key}`).toArray()[0];
      if (exact) return exact.key;
      for (const prefix of restoreKeys) {
        const p = `${scope}\n${prefix}`;
        const r = this.sql.exec<{ key: string }>("SELECT key FROM caches WHERE substr(key, 1, ?) = ? ORDER BY created_at DESC LIMIT 1", p.length, p).toArray()[0];
        if (r) return r.key;
      }
    }
    return null;
  }

  /** Where a job saves `key` (its own ref's scope): the stored key and its R2 keys. */
  async cacheSaveKeys(jobId: string, token: string, key: string): Promise<{ stored: string; r2Keys: string[] }> {
    await this.authJob(jobId, token);
    const stored = `${this.repo.runtime.job(jobId).scopes[0]}\n${key}`;
    return { stored, r2Keys: this.cacheR2Keys(stored) };
  }

  /** The R2 keys of entry `stored`, when the job may read its scope. */
  async cacheReadKeys(jobId: string, token: string, stored: string): Promise<string[] | null> {
    await this.authJob(jobId, token);
    const nl = stored.indexOf("\n");
    if (nl < 0 || !this.repo.runtime.job(jobId).scopes.includes(stored.slice(0, nl))) return null;
    return this.cacheR2Keys(stored);
  }

  /** Where an older runner's cache entry is stored: the current key, then the old layout's. */
  cacheR2Keys(key: string): string[] {
    return legacyCacheKeys(this.repo.meta.repoId, key);
  }

  /** Records a saved entry; returns the R2 keys of the entries it evicted, for the caller to delete. */
  async cacheSaved(jobId: string, token: string, key: string, size: number): Promise<string[]> {
    const { stored } = await this.cacheSaveKeys(jobId, token, key);
    this.sql.exec("INSERT OR REPLACE INTO caches (key, size, created_at, last_used) VALUES (?, ?, ?, ?)", stored, size, now(), now());
    // Like the cache service (repo/runtime.ts): entries unused for a week go, then the
    // least recently used ones above 10 GB per repository.
    const stale = this.sql.exec<{ key: string }>("SELECT key FROM caches WHERE last_used < ?", new Date(Date.now() - CACHE_IDLE_MS).toISOString()).toArray().map((r) => r.key);
    for (const k of stale) this.sql.exec("DELETE FROM caches WHERE key = ?", k);
    const evicted = stale.flatMap((k) => this.cacheR2Keys(k));
    let total = this.sql.exec<{ n: number | null }>("SELECT sum(size) AS n FROM caches").one().n ?? 0;
    while (total > CACHE_LIMIT_BYTES) {
      const old = this.sql.exec<{ key: string; size: number }>("SELECT key, size FROM caches ORDER BY last_used LIMIT 1").one();
      this.sql.exec("DELETE FROM caches WHERE key = ?", old.key);
      evicted.push(...this.cacheR2Keys(old.key));
      total -= old.size;
    }
    return evicted;
  }

  /**
   * Where job `jobId` (authenticated by its token) stores artifact `name` of its run, and how many bytes
   * it may store there (what is left of the artifact quota). Refused when the run
   * already has an artifact of that name from the artifact service.
   */
  async artifactUploadKeys(jobId: string, token: string, name: string): Promise<{ r2Keys: string[]; room: number }> {
    const job = await this.authJob(jobId, token);
    this.repo.runtime.legacyArtifactCheck(job.run_id, name);
    return { r2Keys: this.artifactR2Keys(job.run_id, name), room: await this.repo.runtime.artifactRoom() };
  }

  /** Records an older runner's artifact, stored at its legacy key, with the artifact service's (repo/runtime.ts). */
  async artifactSaved(jobId: string, token: string, name: string, size: number): Promise<{ id: number }> {
    const job = await this.authJob(jobId, token);
    return { id: this.repo.runtime.legacyArtifactSaved(job.run_id, jobId, name, size).id };
  }

  /** Where job `jobId` (authenticated by its token) reads artifact `name` of its run. */
  async artifactKeysFor(jobId: string, token: string, name: string): Promise<string[]> {
    const job = await this.authJob(jobId, token);
    return this.artifactR2Keys(job.run_id, name);
  }

  /** Where an older runner's artifact is stored: the current key, then the old layout's. */
  artifactR2Keys(runId: string, name: string): string[] {
    return legacyArtifactKeys(this.repo.meta.repoId, runId, name);
  }

  /**
   * A run's artifacts: those uploaded through the artifact service (zip files, or
   * single unarchived files) and older runners' tarballs.
   */
  artifacts(runId: string): Array<{ name: string; size: number; createdAt: string; r2Keys: string[]; id: number; contentType: string; fileName: string }> {
    runId = this.runRow(runId).id;
    return this.repo.runtime
      .runArtifacts(runId)
      .map((a) => ({
        name: a.name,
        size: a.size,
        createdAt: a.createdAt,
        r2Keys: artifactObjectKeys(this.repo.meta.repoId, a),
        id: a.id,
        contentType: a.mimeType,
        fileName: artifactFileName(a),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------- sandboxes for agents

  /**
   * `task` is set only by agentic/ (never from a request): the sandbox of an agent task, started for
   * the agent `caller` by the person `task.personId`. No public sandbox call reaches it. An agent
   * review's sandbox is `readOnly`: stored with a `read` caller, its git credential can't push.
   * A web terminal's sandbox (`kind: "terminal"`) is a task sandbox one person works in directly.
   */
  async createSandbox(caller: Caller, ref?: string, task?: { personId: string; readOnly?: boolean; kind?: "task" | "terminal" }): Promise<{ id: string; ref: string }> {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "write access is required to create a sandbox");
    // A review's sandbox acts with read access only: its git credential can clone but never push.
    if (task?.readOnly) caller = { ...caller, role: "read" };
    if (!task) {
      const since = new Date(Date.now() - SANDBOX_TOKEN_TTL_MS).toISOString();
      const open = this.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM sandboxes WHERE kind = 'api' AND status = 'running' AND created_at > ? AND json_extract(created_by, '$.id') = ?", since, caller.id)
        .one().n;
      if (open >= MAX_OPEN_SANDBOXES) throw new HttpError(429, `you have ${open} open sandboxes in this repository, the most allowed; close one first`);
    }
    await this.refuseIfBlocked("sandbox", false);
    // The account that owns the repository pays for sandboxes too (lib/quotas.ts).
    const quota = await mayStart(this.env, this.repo.meta.ownerId, "sandbox");
    if (!quota.ok) throw new HttpError(429, quota.message);
    const sha = await this.repo.resolve(ref ?? "HEAD");
    if (!sha) throw new HttpError(422, "unknown ref");
    const id = newId();
    const m = this.repo.meta;
    const token = `dst_${m.repoId}_${id}_${randomToken(24)}`;
    const secret = randomToken(32);
    this.sql.exec(
      "INSERT INTO sandboxes (id, secret, created_by, ref, created_at, status, kind, task_person) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)",
      id,
      await sha256(token),
      JSON.stringify(caller),
      ref ?? m.defaultBranch,
      now(),
      task ? (task.kind ?? "task") : "api",
      task?.personId ?? null,
    );
    await startCompute(this.env, { id, accountId: m.ownerId, repoId: m.repoId, kind: "sandbox" });
    const stub = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(id));
    try {
      await stub.boot({
        DIFFINERY_CLONE_URL: `${this.env.PUBLIC_URL}/${m.owner}/${m.name}.git`,
        DIFFINERY_REF: ref ?? m.defaultBranch,
        DIFFINERY_JOB_TOKEN: token,
        DIFFINERY_SANDBOX_SECRET: secret,
        DIFFINERY_API_URL: this.env.PUBLIC_URL,
        GIT_AUTHOR_NAME: caller.login,
        GIT_AUTHOR_EMAIL: noreplyEmail(this.env.PUBLIC_URL, caller.login),
        GIT_COMMITTER_NAME: caller.login,
        GIT_COMMITTER_EMAIL: noreplyEmail(this.env.PUBLIC_URL, caller.login),
      }, secret, id, { id, accountId: m.ownerId, repoId: m.repoId }, await egressFor(this.env, m.ownerId));
    } catch (e) {
      console.error("sandbox boot failed", e);
      this.sql.exec("UPDATE sandboxes SET status = 'failed' WHERE id = ?", id);
      await endCompute(this.env, id).catch(() => {});
      await stub.shutdown().catch(() => {});
      throw new HttpError(503, "the sandbox container did not start; try again");
    }
    return { id, ref: ref ?? m.defaultBranch };
  }

  getSandbox(id: string, caller: Caller): { id: string; ref: string; status: string; createdAt: string } {
    const s = this.sql.exec<{ id: string; ref: string; status: string; created_at: string; created_by: string; kind: string }>("SELECT * FROM sandboxes WHERE id = ?", id).toArray()[0];
    // A task's sandbox holds a credential for the person's model access, and a terminal's may hold their
    // provider sign-in: nobody reaches either through the sandbox API, admins included.
    if (!s || s.kind !== "api") throw new HttpError(404, "sandbox not found");
    const owner = JSON.parse(s.created_by) as Caller;
    if (owner.id !== caller.id && !atLeast(caller.role, "admin")) throw new HttpError(403, "not your sandbox");
    return { id: s.id, ref: s.ref, status: s.status, createdAt: s.created_at };
  }

  async closeSandbox(id: string, caller: Caller): Promise<void> {
    this.getSandbox(id, caller);
    await this.endSandbox(id);
  }

  /** Close a sandbox: its token stops working, its time stops counting and its container stops. */
  private async endSandbox(id: string): Promise<void> {
    this.sql.exec("UPDATE sandboxes SET status = 'closed' WHERE id = ?", id);
    await endCompute(this.env, id);
    await this.env.SANDBOX.get(this.env.SANDBOX.idFromName(id)).shutdown();
  }

  /** Close an agent task's or a web terminal's sandbox (agentic/), which revokes its git credential. */
  async closeTaskSandbox(id: string): Promise<void> {
    const s = this.sql.exec<{ kind: string }>("SELECT kind FROM sandboxes WHERE id = ?", id).toArray()[0];
    if (s?.kind !== "task" && s?.kind !== "terminal") return;
    await this.endSandbox(id);
  }

  // ---------------------------------------------------------------- kill switches (lib/killswitch.ts)

  /**
   * Why `work` may not start here now, or null. One D1 read. A failed read lets work start
   * (`failOpen`), as quotas do for jobs: a D1 outage shouldn't stop every repository's CI.
   */
  private async blocked(work: Work, failOpen = true): Promise<string | null> {
    try {
      return blockedBy(await killSwitches(this.env, this.repo.meta.repoId), work);
    } catch (e) {
      if (!failOpen) throw e;
      console.error("kill switch check failed", e);
      return null;
    }
  }

  /** Refuse (403, with the reason) what someone asked to start while a kill switch stops it. */
  async refuseIfBlocked(work: Work, failOpen = true): Promise<void> {
    const block = await this.blocked(work, failOpen);
    if (block) throw new HttpError(403, block);
  }

  /**
   * A site administrator just suspended Actions here or for the owner (`hostedOnly` false): every
   * unfinished run is cancelled and every open sandbox closed. Or paused hosted compute on the
   * instance (`hostedOnly`): running hosted jobs fail and open sandboxes close; self-hosted jobs go on.
   * `message` says why. Jobs still queued fail when they would start (launch).
   */
  async stopActions(o: { hostedOnly: boolean; message: string }): Promise<{ runs: number; jobs: number; sandboxes: number }> {
    let runs = 0;
    let jobs = 0;
    let sandboxes = 0;
    if (o.hostedOnly) {
      for (const j of this.sql.exec<JobRow>("SELECT * FROM jobs WHERE labels IS NULL AND container IS NOT NULL AND status IN ('waiting', 'in_progress') ORDER BY rowid").toArray()) {
        await this.stopContainer(j);
        await this.completeJob(j.id, { conclusion: "failure", outputs: {}, failure: { message: `The job was stopped: ${o.message}.` } });
        jobs++;
      }
    } else {
      for (const r of this.sql.exec<{ id: string }>("SELECT id FROM runs WHERE status != 'completed' ORDER BY rowid").toArray()) {
        jobs += this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE run_id = ? AND status != 'completed'", r.id).one().n;
        await this.cancelInternal(r.id, `Cancelled: ${o.message}.`);
        runs++;
      }
    }
    for (const s of this.sql.exec<{ id: string }>("SELECT id FROM sandboxes WHERE status = 'running'").toArray()) {
      await this.endSandbox(s.id).catch((e: unknown) => console.error("closing a sandbox failed", e));
      sandboxes++;
    }
    return { runs, jobs, sandboxes };
  }
}

/**
 * One minute of a wait timer: a real minute, except in the end-to-end tests (WAIT_TIMER_MINUTE_MS). The setting
 * shortens a protection rule, so it counts only on a Worker that runs on this machine (auth/dev.ts): a deployed
 * one ignores it.
 */
export function timerMinute(env: Pick<Env, "WAIT_TIMER_MINUTE_MS" | "PUBLIC_URL" | "ACCESS_AUD">): number {
  if (!env.WAIT_TIMER_MINUTE_MS || !localOnly(env)) return 60_000;
  const ms = Number(env.WAIT_TIMER_MINUTE_MS);
  return Number.isInteger(ms) && ms > 0 && ms <= 60_000 ? ms : 60_000;
}
