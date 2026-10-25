import type { JobCompletion, JobSpec } from "@diffinery/shared";
import { LogBatcher, RunnerApi } from "./api.js";
import { JobRunner, errMsg } from "./job.js";
import { UsageSampler, describeUsage } from "./usage.js";

export interface AgentOptions {
  /** `${apiUrl}/runner/jobs/${jobId}`, or null for offline mode (logs to stdout, no reports). */
  apiBase: string | null;
  workRoot: string;
  toolCache?: string;
  echoLogs?: boolean;
  /**
   * Install a SIGTERM/SIGINT handler that cancels the job: the step under way stops and the steps that
   * still run after a cancel (`if: always()`, `if: cancelled()`, post steps) run. A second signal stops them too.
   */
  handleSignals?: boolean;
  /**
   * Hosted runners: on SIGTERM (a platform rollout replacing this container), keep
   * running the job for up to this long before cancelling it. SIGINT or a second
   * SIGTERM still cancels at once.
   */
  drainOnSigtermMs?: number;
  /** Exposes the runner (e.g. so tests can cancel). */
  onRunner?: (r: JobRunner) => void;
  logIntervalMs?: number;
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * Measure what the job uses of the machine and report it with the result (hosted runners, where the
   * container is the job's own machine; on a shared self-hosted machine the numbers would be the host's).
   */
  measureUsage?: boolean | UsageSampler;
  /** Hosted runners: start the Docker daemon as the job begins when the job will use Docker (docker.ts prewarm). */
  prewarmDocker?: boolean;
  /** Hosted runners: start installing the job's Go or Java toolchain as the job begins (prefetch.ts). */
  prefetchTools?: boolean;
}

export function apiBaseFor(apiUrl: string | undefined | null, jobId: string): string | null {
  if (!apiUrl) return null;
  return `${apiUrl.replace(/\/$/, "")}/runner/jobs/${encodeURIComponent(jobId)}`;
}

/** Runs one job end-to-end: execute steps, ship logs, POST completion. */
export async function runAgentJob(spec: JobSpec, o: AgentOptions): Promise<JobCompletion> {
  const api = new RunnerApi(o.apiBase, spec.token);
  const batcher = api.online
    ? new LogBatcher((lines) => api.postLogs(lines), {
        intervalMs: o.logIntervalMs ?? 500,
        onError: (e) => process.stderr.write(`[diffinery-runner] log upload failed: ${errMsg(e)}\n`),
      })
    : null;
  const runner = new JobRunner(spec, api, null, { workRoot: o.workRoot, toolCache: o.toolCache, echoLogs: o.echoLogs ?? !api.online, baseEnv: o.baseEnv, prewarmDocker: o.prewarmDocker, prefetchTools: o.prefetchTools }, batcher);
  o.onRunner?.(runner);
  const onSignal = (sig: string) => {
    runner.logger.line(-1, `##[error]Received ${sig}; cancelling the job.`);
    // While the platform replaces this runner, its container stops soon: no steps run after the cancel.
    runner.cancel("cancelled", runner.replacing ? 0 : undefined);
  };
  let draining: NodeJS.Timeout | null = null;
  const sigterm = () => {
    if (!o.drainOnSigtermMs || draining) return onSignal("SIGTERM");
    const minutes = Math.round(o.drainOnSigtermMs / 60_000);
    runner.replacing = true;
    runner.logger.line(-1, `##[warning]The platform is stopping this runner (a rollout replacing it with a new version, or the platform moving it). The job keeps running for up to ${minutes} minutes; if the platform stops a step or the time runs out, the job ends, and Diffinery starts it again on a new runner when doing so can't repeat anything outside the run.`);
    draining = setTimeout(() => onSignal("SIGTERM"), o.drainOnSigtermMs);
    draining.unref();
  };
  const sigint = () => onSignal("SIGINT");
  if (o.handleSignals) {
    process.on("SIGTERM", sigterm);
    process.on("SIGINT", sigint);
  }
  const sampler = o.measureUsage instanceof UsageSampler ? o.measureUsage : o.measureUsage ? new UsageSampler() : null;
  sampler?.start();
  let completion: JobCompletion;
  try {
    completion = await runner.run();
  } catch (e) {
    completion = { conclusion: "failure", outputs: {}, failure: { message: `Runner error: ${errMsg(e)}` } };
  }
  const usage = sampler?.stop();
  if (usage) {
    completion.usage = usage;
    runner.logger.line(-1, describeUsage(usage));
  }
  if (batcher) {
    // After a SIGTERM the platform kills the container soon, so the result must not wait long on logs.
    const ok = await batcher.close(draining ? 30_000 : 120_000);
    if (!ok) process.stderr.write(`[diffinery-runner] gave up shipping ${batcher.pending} log lines\n`);
  }
  try {
    await api.complete(completion);
  } catch (e) {
    process.stderr.write(`[diffinery-runner] failed to report completion: ${errMsg(e)}\n`);
  }
  if (draining) clearTimeout(draining);
  if (o.handleSignals) {
    process.off("SIGTERM", sigterm);
    process.off("SIGINT", sigint);
  }
  return completion;
}
