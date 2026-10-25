import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.js";
import { graphFromLevels, runGraph, type JobNode } from "../repo/job-graph.js";
import { MAX_PLACEMENT_TRIES, MAX_RUNNER_RESTARTS, QUICK_RETRIES } from "../repo/actions.js";
import { plainSteps } from "../lib/rpc.js";

export interface RunParams {
  repoId: string;
  runId: string;
}

/**
 * Durable orchestration of one workflow run: walks the job graph, starting each
 * job's containers as soon as the jobs it needs have finished, and waits for the
 * runner to report completion. Retries, sleeps and waits survive restarts of the
 * platform. Each job costs a fixed number of steps (start, then a status check
 * and one wait per matrix leg), however long it runs, plus a few per wake while
 * its environment's reviewers or wait timer hold it.
 */
export class RunWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  override async run(event: WorkflowEvent<RunParams>, rpcStep: WorkflowStep): Promise<unknown> {
    const step = plainSteps(rpcStep);
    const { repoId, runId } = event.payload;
    const repo = () => this.env.REPO.get(this.env.REPO.idFromName(repoId));

    let plan = await step.do("plan", () => repo().runPlan(runId));
    // Concurrency groups without cancel-in-progress: wait for the running run to finish.
    for (let i = 0; plan.concurrencyBlocked && i < 360; i++) {
      await step.sleep(`concurrency-wait-${i}`, "1 minute");
      plan = await step.do(`plan-${i}`, () => repo().runPlan(runId));
    }
    if (plan.error) {
      await step.do("record-error", () => repo().plannedRunError(runId, plan.error!));
      return step.do("finish", () => repo().finishRun(runId));
    }

    const waitFor = async (jobId: string) => {
      let status = await step.do(`job ${jobId} info`, () => repo().jobStatus(jobId));
      // Held by its environment's protection rules: wait for a reviewer's decision or the wait timer,
      // for up to 30 days (repo/actions.ts jobGate fails it after that). Each wake re-checks the rules.
      for (let i = 0; status === "approval" && i < 100; i++) {
        const gate = await step.do(`gate ${jobId} ${i}`, () => repo().jobGate(jobId));
        status = gate.status;
        if (status !== "approval") break;
        const until = Date.parse(gate.until ?? "") || Date.now() + 60_000;
        if (gate.wait === "timer") await step.sleepUntil(`timer ${jobId} ${i}`, until);
        else {
          try {
            await step.waitForEvent(`approval ${jobId} ${i}`, { type: `gate-${jobId}`, timeout: Math.max(1000, until - Date.now()) });
          } catch {
            // The deadline passed: the next gate check fails the job.
          }
        }
      }
      if (status === "completed" || status === "approval") return;
      // A job whose container got no machine, or whose runner a rollout replaced before its steps ran
      // (repo/actions.ts runnerReplaced), comes back with `retryInSeconds`: pause, start it again
      // and keep waiting. The first round keeps its step names, so runs already in flight replay.
      for (let i = 0; ; i++) {
        const n = i ? ` ${i}` : "";
        if (i && (await step.do(`job ${jobId} info${n}`, () => repo().jobStatus(jobId))) === "completed") return;
        let event: { payload?: { retryInSeconds?: number } };
        try {
          event = await step.waitForEvent(`wait ${jobId}${n}`, { type: `job-${jobId}`, timeout: "6 hours" });
        } catch {
          await step.do(`timeout ${jobId}${n}`, () => repo().jobTimedOut(jobId));
          return;
        }
        const pause = event.payload?.retryInSeconds;
        if (!pause || i >= MAX_PLACEMENT_TRIES + MAX_RUNNER_RESTARTS + QUICK_RETRIES) return;
        await step.sleep(`pause ${jobId} ${i + 1}`, `${pause} seconds`);
        await step.do(`relaunch ${jobId} ${i + 1}`, () => repo().relaunchJob(jobId));
      }
    };
    // Runs planned before plans carried a graph replay with their recorded levels.
    const legacy = plan as { jobs?: JobNode[]; levels?: string[][] };
    await runGraph(legacy.jobs ?? graphFromLevels(legacy.levels ?? []), async (key) => {
      const started = await step.do(`start ${key}`, { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, () => repo().startJobKey(runId, key));
      await Promise.all(started.jobIds.map(waitFor));
    });
    return step.do("finish", () => repo().finishRun(runId));
  }
}
