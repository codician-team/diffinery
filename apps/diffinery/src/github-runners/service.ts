import type { Env } from "../env.js";
import { egressFor, type Egress } from "../lib/egress.js";
import { accountKillSwitches, blockedBy } from "../lib/killswitch.js";
import { MAX_RUN_MS, endCompute, mayStart, startCompute } from "../lib/quotas.js";
import { newId, now } from "../lib/util.js";
import { RETRYABLE_START } from "../repo/actions.js";
import { RUNNER_SIZES, sizeLabel, sizeOfContainer, type RunnerSize } from "../runner/sizes.js";
import { GitHubApiError, type GitHubAppClient } from "./github.js";

/**
 * GitHub jobs on Diffinery runners (docs/actions/github-runners.md). GitHub tells Diffinery about each
 * queued job of a repository where the instance's GitHub App is installed (the workflow_job webhook);
 * when its runs-on asks for a Diffinery runner, the job waits here, one row per job, until the account
 * the installation is linked to may start a hosted job (lib/quotas.ts, lib/killswitch.ts). Diffinery
 * then registers a just-in-time runner with the job's labels in the repository and starts a hosted runner
 * container that runs GitHub's own runner with it. GitHub hands that runner a queued job with those labels,
 * the runner runs it and exits, and the container stops.
 *
 * The rows are in D1 (github_runner_jobs), for the settings page; each account's are changed by its own
 * GitHubRunnersDO, which calls this class.
 */

/** Labels a Diffinery runner has besides its own: GitHub's usual self-hosted labels. */
const COMPANION_LABELS = new Set(["self-hosted", "linux", "x64"]);

/**
 * The runner size a GitHub job's runs-on asks for, or null when it isn't for Diffinery: it needs
 * `diffinery` or `diffinery-<size>`, and any other label must be one a Diffinery runner has, or the
 * runner registered for it could never take it. `diffinery` alone is a large runner.
 */
export function runnerFor(labels: readonly string[]): RunnerSize | null {
  let ours = false;
  for (const l of labels) {
    const low = l.trim().toLowerCase();
    if (low === "diffinery" || sizeLabel([low])) ours = true;
    else if (!COMPANION_LABELS.has(low)) return null;
  }
  return ours ? (sizeLabel(labels) ?? "large") : null;
}

/** A runner that took no job within this long is stopped: its job was cancelled or ran on another runner. */
export const IDLE_MS = 10 * 60_000;
/** How often a queued job asks again for a hosted slot, while the account is at its hosted jobs at once. */
export const WAIT_RETRY_MS = 15_000;
/** Starts of one job's runner that may fail for a passing reason before the job is given up on. */
export const MAX_TRIES = 3;
/** Queued jobs one pass looks at; the rest wait for the next pass, right after. */
const BATCH = 20;

export interface QueuedJob {
  installationId: number;
  repo: string;
  githubJobId: number;
  runId: number | null;
  workflowName: string | null;
  jobName: string | null;
  htmlUrl: string | null;
  labels: string[];
}

export interface JobEvent {
  installationId: number;
  githubJobId: number;
  action: "in_progress" | "completed";
  runnerName: string | null;
  jobName: string | null;
  conclusion: string | null;
}

export interface RunnerJobRow {
  id: string;
  account_id: string;
  installation_id: number;
  repo: string;
  github_job_id: number;
  run_id: number | null;
  workflow_name: string | null;
  job_name: string | null;
  html_url: string | null;
  labels: string;
  size: RunnerSize;
  status: "queued" | "starting" | "running" | "completed" | "skipped" | "failed";
  tries: number;
  runner_name: string | null;
  github_runner_id: number | null;
  container: string | null;
  ran_job_id: number | null;
  ran_job_name: string | null;
  conclusion: string | null;
  message: string | null;
  stop_reason: string | null;
  exit_code: number | null;
  created_at: string;
  started_at: string | null;
  picked_at: string | null;
  ended_at: string | null;
}

/** What starts and stops runner containers: the hosted runner classes (runner/containers.ts), or a test's stand-in. */
export interface RunnerHost {
  start(container: string, input: { accountId: string; runnerId: string; jitConfig: string; egress: Egress; vcpu: number }): Promise<void>;
  stop(container: string): Promise<void>;
  has(size: RunnerSize): boolean;
}

/** The hosted runner container classes, picked by the size at the end of a container's name. */
export function containerHost(env: Env): RunnerHost {
  const ns = (container: string) => env[RUNNER_SIZES[sizeOfContainer(container)].binding] ?? env.RUNNER;
  return {
    start: (container, input) => ns(container).get(ns(container).idFromName(container)).startGitHubRunner(input),
    stop: (container) => ns(container).get(ns(container).idFromName(container)).stopJob(false),
    has: (size) => size === "large" || !!env[RUNNER_SIZES[size].binding],
  };
}

/** A GitHub runner's container: `gh-<row>-<try>`, with the size after a dot as for Actions jobs (runner/sizes.ts). */
export function githubContainerName(rowId: string, tries: number, size: RunnerSize): string {
  return `gh-${rowId}-${tries}${size === "large" ? "" : `.${size}`}`;
}

/** The compute_usage repo_id of a GitHub runner: it has no Diffinery repository (lib/killswitch.ts runningCompute). */
export const githubComputeRepo = (installationId: number): string => `github:${installationId}`;

const ENDED = new Set(["completed", "skipped", "failed"]);

type Placement = { row: RunnerJobRow; container: string; jitConfig: string; egress: Egress };

export class GitHubRunners {
  private readonly db: D1Database;

  constructor(
    private readonly env: Env,
    private readonly gh: GitHubAppClient,
    private readonly host: RunnerHost,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.db = env.DB;
  }

  private at(ms = this.clock()): string {
    return new Date(ms).toISOString();
  }

  private row(id: string): Promise<RunnerJobRow | null> {
    return this.db.prepare("SELECT * FROM github_runner_jobs WHERE id = ?").bind(id).first<RunnerJobRow>();
  }

  /** Records a queued job for a Diffinery runner; false when GitHub sent the same job before. */
  async queued(accountId: string, job: QueuedJob, size: RunnerSize): Promise<boolean> {
    const r = await this.db
      .prepare(
        "INSERT OR IGNORE INTO github_runner_jobs (id, account_id, installation_id, repo, github_job_id, run_id, workflow_name, job_name, html_url, labels, size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
      )
      .bind(newId(), accountId, job.installationId, job.repo, job.githubJobId, job.runId, job.workflowName, job.jobName, job.htmlUrl, JSON.stringify(job.labels), size, this.at())
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** A job started on a runner or ended: which job a Diffinery runner took, or a queued job that no longer needs one. */
  async jobEvent(ev: JobEvent): Promise<void> {
    if (ev.runnerName) {
      if (ev.action === "in_progress") {
        await this.db
          .prepare("UPDATE github_runner_jobs SET status = CASE WHEN status = 'starting' THEN 'running' ELSE status END, picked_at = coalesce(picked_at, ?), ran_job_id = ?, ran_job_name = ? WHERE installation_id = ? AND runner_name = ?")
          .bind(this.at(), ev.githubJobId, ev.jobName, ev.installationId, ev.runnerName)
          .run();
      } else {
        await this.db
          .prepare("UPDATE github_runner_jobs SET conclusion = ?, ran_job_id = coalesce(ran_job_id, ?), ran_job_name = coalesce(ran_job_name, ?) WHERE installation_id = ? AND runner_name = ?")
          .bind(ev.conclusion, ev.githubJobId, ev.jobName, ev.installationId, ev.runnerName)
          .run();
      }
    }
    // Cancelled before its runner started, or taken by another runner (one started for another job with the same labels):
    // a runner started for it now would only wait for IDLE_MS.
    if (ev.action === "completed" || ev.runnerName) {
      await this.db
        .prepare("UPDATE github_runner_jobs SET status = 'skipped', message = ?, conclusion = ?, ended_at = ? WHERE installation_id = ? AND github_job_id = ? AND status = 'queued'")
        .bind(ev.runnerName ? `The job ran on ${ev.runnerName} before a runner started for it` : "The job ended before a runner started for it", ev.conclusion, this.at(), ev.installationId, ev.githubJobId)
        .run();
    }
  }

  /**
   * Starts runners for the account's queued jobs, oldest first, and stops runners that took no job or ran too
   * long. Returns how soon to look again: null when nothing waits or runs.
   */
  async pump(accountId: string): Promise<{ next: number | null }> {
    await this.sweep(accountId);
    const queued = (await this.db.prepare("SELECT * FROM github_runner_jobs WHERE account_id = ? AND status = 'queued' ORDER BY created_at LIMIT ?").bind(accountId, BATCH).all<RunnerJobRow>()).results;
    const placements: Placement[] = [];
    let waiting = false;
    for (const row of queued) {
      const r = await this.admit(row);
      if (r === "wait") {
        waiting = true;
        break;
      }
      if (r) placements.push(r);
    }
    // A start that failed for a passing reason is tried again after a pause, not at once.
    if ((await Promise.all(placements.map((p) => this.place(p)))).some(Boolean)) waiting = true;
    return { next: await this.nextLook(accountId, waiting) };
  }

  private async nextLook(accountId: string, waiting: boolean): Promise<number | null> {
    const counts = await this.db
      .prepare("SELECT status, count(*) AS n, min(started_at) AS oldest FROM github_runner_jobs WHERE account_id = ? AND status IN ('queued', 'starting', 'running') GROUP BY status")
      .bind(accountId)
      .all<{ status: string; n: number; oldest: string | null }>();
    const by = new Map(counts.results.map((c) => [c.status, c]));
    const looks: number[] = [];
    if (by.has("queued")) looks.push(waiting ? WAIT_RETRY_MS : 0);
    const starting = by.get("starting");
    if (starting?.oldest) looks.push(Math.max(5_000, Date.parse(starting.oldest) + IDLE_MS - this.clock()));
    if (by.has("running")) looks.push(IDLE_MS);
    return looks.length ? Math.min(...looks) : null;
  }

  private async finish(row: RunnerJobRow, status: "skipped" | "failed", message: string): Promise<void> {
    await this.db.prepare("UPDATE github_runner_jobs SET status = ?, message = ?, ended_at = ? WHERE id = ? AND status = 'queued'").bind(status, message, this.at(), row.id).run();
  }

  /** Everything before a queued job's container starts: null when it doesn't start, "wait" when the account must wait for a slot. */
  private async admit(row: RunnerJobRow): Promise<Placement | "wait" | null> {
    const inst = await this.db.prepare("SELECT account_id, suspended_at FROM github_installations WHERE id = ?").bind(row.installation_id).first<{ account_id: string; suspended_at: string | null }>();
    if (!inst || inst.account_id !== row.account_id) {
      await this.finish(row, "skipped", "The GitHub installation is no longer linked to this account");
      return null;
    }
    if (inst.suspended_at) {
      await this.finish(row, "skipped", "The app's installation is suspended on GitHub");
      return null;
    }
    const block = blockedBy(await accountKillSwitches(this.env, row.account_id), "hosted-job");
    if (block) {
      await this.finish(row, "failed", `The runner was not started: ${block}`);
      return null;
    }
    const quota = await mayStart(this.env, row.account_id, "job").catch((e: unknown) => {
      console.error("quota check failed", e);
      return { ok: true } as const;
    });
    if (!quota.ok) {
      if (!quota.wait) {
        await this.finish(row, "failed", `The runner was not started: ${quota.message}`);
        return null;
      }
      await this.db.prepare("UPDATE github_runner_jobs SET message = ? WHERE id = ?").bind(`Waiting: ${quota.message}`, row.id).run();
      return "wait";
    }
    const tries = row.tries + 1;
    const size = this.host.has(row.size) ? row.size : "large";
    const name = `diffinery-${row.id}-${tries}`;
    let jit;
    try {
      jit = await this.gh.jitRunner(row.installation_id, row.repo, name, JSON.parse(row.labels) as string[]);
    } catch (e) {
      const message = (e as Error).message;
      // GitHub refusing (no permission, a repository gone) won't change by asking again.
      if ((e instanceof GitHubApiError && e.status < 500 && e.status !== 429) || tries >= MAX_TRIES) await this.finish(row, "failed", `Could not register a runner on GitHub: ${message}`);
      else {
        await this.db.prepare("UPDATE github_runner_jobs SET tries = ?, message = ? WHERE id = ?").bind(tries, `Registering a runner on GitHub failed; trying again: ${message}`, row.id).run();
        return "wait";
      }
      return null;
    }
    const container = githubContainerName(row.id, tries, size);
    const claimed = await this.db
      .prepare("UPDATE github_runner_jobs SET status = 'starting', tries = ?, runner_name = ?, github_runner_id = ?, container = ?, size = ?, message = NULL, stop_reason = NULL, started_at = ?, picked_at = NULL WHERE id = ? AND status = 'queued'")
      .bind(tries, name, jit.runnerId, container, size, this.at(), row.id)
      .run();
    if (!claimed.meta.changes) {
      // Stopped or ended meanwhile (a kill switch, the job cancelled).
      await this.gh.removeRunner(row.installation_id, row.repo, jit.runnerId).catch(() => {});
      return null;
    }
    await startCompute(this.env, { id: container, accountId: row.account_id, repoId: githubComputeRepo(row.installation_id), kind: "job" }).catch((e: unknown) => console.error("compute usage failed", e));
    return { row: { ...row, tries, container, runner_name: name, github_runner_id: jit.runnerId, size }, container, jitConfig: jit.encodedJitConfig, egress: await egressFor(this.env, row.account_id) };
  }

  /**
   * Starts an admitted runner's container; one that failed for a passing reason goes back in line, up to
   * MAX_TRIES starts. Returns whether it went back in line.
   */
  private async place(p: Placement): Promise<boolean> {
    try {
      await this.host.start(p.container, { accountId: p.row.account_id, runnerId: p.row.id, jitConfig: p.jitConfig, egress: p.egress, vcpu: RUNNER_SIZES[p.row.size].vcpu });
      return false;
    } catch (e) {
      const message = (e as Error).message;
      const row = await this.row(p.row.id);
      if (!row || row.status !== "starting" || row.container !== p.container) return false;
      await endCompute(this.env, p.container).catch(() => {});
      await this.gh.removeRunner(row.installation_id, row.repo, row.github_runner_id!).catch(() => {});
      const again = (RETRYABLE_START.test(message) || (e as { retryable?: unknown }).retryable === true) && row.tries < MAX_TRIES;
      await this.db
        .prepare("UPDATE github_runner_jobs SET status = ?, message = ?, container = NULL, ended_at = ? WHERE id = ? AND status = 'starting'")
        .bind(again ? "queued" : "failed", again ? `Starting a runner failed; trying again: ${message}` : `Could not start a runner: ${message}`, again ? null : this.at(), row.id)
        .run();
      return again;
    }
  }

  /** Runners that took no job within IDLE_MS (unless GitHub says they are busy), and runners past the longest a job runs. */
  private async sweep(accountId: string): Promise<void> {
    const t = this.clock();
    const rows = (await this.db.prepare("SELECT * FROM github_runner_jobs WHERE account_id = ? AND status IN ('starting', 'running') AND started_at < ?").bind(accountId, this.at(t - IDLE_MS)).all<RunnerJobRow>()).results;
    for (const row of rows) {
      if (Date.parse(row.started_at!) + MAX_RUN_MS.job < t) {
        await this.stopRunner(row, "The runner ran past the longest a job may run");
        continue;
      }
      if (row.status !== "starting") continue;
      // The in_progress webhook may be late or lost: GitHub knows whether the runner has a job.
      const state = await this.gh.runner(row.installation_id, row.repo, row.github_runner_id!).catch(() => undefined);
      if (state?.busy) {
        await this.db.prepare("UPDATE github_runner_jobs SET status = 'running', picked_at = coalesce(picked_at, ?) WHERE id = ? AND status = 'starting'").bind(this.at(t), row.id).run();
        continue;
      }
      if (state === undefined) continue;
      await this.stopRunner(row, `No job took this runner within ${IDLE_MS / 60_000} minutes: the job it was started for was cancelled or ran on another runner`);
    }
  }

  /** Stops a runner's container and ends its row with `reason`. */
  private async stopRunner(row: RunnerJobRow, reason: string): Promise<void> {
    await this.db.prepare("UPDATE github_runner_jobs SET stop_reason = ? WHERE id = ?").bind(reason, row.id).run();
    if (row.container) await this.host.stop(row.container).catch((e: unknown) => console.error(`stopping GitHub runner ${row.id} failed`, e));
    await this.ended(row.id, null);
  }

  /** A runner's container stopped (runner/containers.ts onStop), or Diffinery stopped it. */
  async stopped(rowId: string, exitCode: number | null): Promise<void> {
    const row = await this.row(rowId);
    if (!row) return;
    // A runner that crashed before it took a job (nothing of the job ran) is replaced, a few times.
    if (row.status === "starting" && !row.stop_reason && exitCode !== 0 && exitCode !== null && row.tries < MAX_TRIES) {
      if (row.container) await endCompute(this.env, row.container).catch(() => {});
      if (row.github_runner_id) await this.gh.removeRunner(row.installation_id, row.repo, row.github_runner_id).catch(() => {});
      await this.db
        .prepare("UPDATE github_runner_jobs SET status = 'queued', container = NULL, message = ? WHERE id = ? AND status = 'starting'")
        .bind(`The runner stopped before it took a job (exit code ${exitCode}); starting another`, row.id)
        .run();
      return;
    }
    await this.ended(rowId, exitCode);
  }

  private async ended(rowId: string, exitCode: number | null): Promise<void> {
    const row = await this.row(rowId);
    if (!row) return;
    if (row.container) await endCompute(this.env, row.container).catch((e: unknown) => console.error("compute usage failed", e));
    if (ENDED.has(row.status)) return;
    const neverPicked = row.status === "starting";
    // A just-in-time runner removes itself after its job; one that never took a job is removed here.
    if (neverPicked && row.github_runner_id) await this.gh.removeRunner(row.installation_id, row.repo, row.github_runner_id).catch(() => {});
    const message = row.stop_reason ?? (neverPicked && exitCode ? `The runner stopped before it took a job (exit code ${exitCode})` : null);
    await this.db.prepare("UPDATE github_runner_jobs SET status = 'completed', exit_code = ?, message = ?, ended_at = ? WHERE id = ?").bind(exitCode, message, this.at(), rowId).run();
  }

  /** A kill switch: queued jobs fail and running runners stop, with `message`. Returns the runners stopped. */
  async stopAll(accountId: string, message: string): Promise<number> {
    await this.db.prepare("UPDATE github_runner_jobs SET status = 'failed', message = ?, ended_at = ? WHERE account_id = ? AND status = 'queued'").bind(message, this.at(), accountId).run();
    const rows = (await this.db.prepare("SELECT * FROM github_runner_jobs WHERE account_id = ? AND status IN ('starting', 'running')").bind(accountId).all<RunnerJobRow>()).results;
    for (const row of rows) await this.stopRunner(row, message);
    return rows.length;
  }
}
