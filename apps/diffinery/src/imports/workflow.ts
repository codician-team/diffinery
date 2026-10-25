import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.js";
import { ImportService, PAGED_STEPS, type StepCursor } from "./service.js";
import { plainSteps } from "../lib/rpc.js";

export interface ImportParams {
  importId: string;
}

const RETRY = { retries: { limit: 5, delay: "15 seconds", backoff: "exponential" }, timeout: "15 minutes" } as const;
/** How long the workflow waits between checks on the Git transfer, and for how many checks (6 hours). */
const GIT_CHECK = "10 minutes";
const GIT_CHECKS = 36;
const GIT_TRIES = 2;
/** An overall cap on how many times one paged step may be called, so a hostile or broken source cannot run the workflow forever. */
const MAX_STEP_CALLS = 2000;
/** How many rate-limit sleeps (each at most an hour) the repository lookup may take. */
const MAX_RATE_LIMIT_WAITS = 48;

/**
 * Durable execution of one GitHub import (instance id `<importId>-<attempt>`).
 * A repository import runs its steps in order, each retried on failure and
 * paged so that no step runs long; rate limits become sleeps. A bulk import
 * fans out one repository import per repository, a few at a time: each one
 * starts the next when it ends, and the last one wakes the bulk import.
 */
export class ImportWorkflow extends WorkflowEntrypoint<Env, ImportParams> {
  override async run(event: WorkflowEvent<ImportParams>, rpcStep: WorkflowStep): Promise<unknown> {
    const step = plainSteps(rpcStep);
    const id = event.payload.importId;
    const svc = () => new ImportService(this.env);
    const begin = await step.do("begin", RETRY, () => svc().begin(id));
    if (begin.stop) return { stopped: true };
    try {
      if (begin.kind === "bulk") await this.bulk(id, step, svc);
      else await this.repository(id, step, svc);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await step.do("fail", RETRY, () => svc().fail(id, message));
    }
    await step.do("after", RETRY, () => svc().afterChild(id));
    return { done: true };
  }

  private async repository(id: string, step: WorkflowStep, svc: () => ImportService): Promise<void> {
    // GitHub's rate limit is slept off, never a failure (the first call keeps its original step name).
    for (let i = 0; ; i++) {
      if (i >= MAX_RATE_LIMIT_WAITS) throw new Error("GitHub kept rate limiting the repository lookup");
      const r = await step.do(i === 0 ? "repository" : `repository ${i}`, RETRY, () => svc().stepRepository(id));
      // `?.`: an instance that ran this step before the change replays it with no result.
      if (!r?.wait) break;
      await step.sleep(`repository rate limit ${i}`, `${r.wait} seconds`);
    }

    for (let attempt = 1; ; attempt++) {
      await step.do(`git start ${attempt}`, RETRY, () => svc().startGit(id));
      let status: Awaited<ReturnType<ImportService["gitStatus"]>> = { state: "running" };
      for (let i = 0; i < GIT_CHECKS; i++) {
        status = await step.do(`git check ${attempt}.${i}`, RETRY, () => svc().gitStatus(id));
        if (status.state !== "running") break;
        try {
          await step.waitForEvent(`git wait ${attempt}.${i}`, { type: "git-done", timeout: GIT_CHECK });
        } catch {
          // timed out: check again
        }
      }
      if (status.state === "done") break;
      if (status.state === "running") throw new Error("the Git transfer did not finish within 6 hours");
      if (!status.retryable || attempt >= GIT_TRIES) throw new Error(status.error ?? "the Git transfer failed");
      const error = status.error ?? "";
      await step.do(`git reset ${attempt}`, RETRY, () => svc().resetGit(id, error));
    }

    for (const name of PAGED_STEPS) {
      let cursor: StepCursor = null;
      for (let i = 0; ; i++) {
        if (i >= MAX_STEP_CALLS) throw new Error(`the ${name} step did not finish within ${MAX_STEP_CALLS} pages`);
        const r = await step.do(`${name} ${i}`, RETRY, () => svc().runStep(id, name, cursor));
        if (r.wait) await step.sleep(`${name} rate limit ${i}`, `${r.wait} seconds`);
        if (r.done) break;
        cursor = r.cursor;
      }
    }

    await step.do("finalize", RETRY, () => svc().finalize(id));
  }

  private async bulk(id: string, step: WorkflowStep, svc: () => ImportService): Promise<void> {
    for (let i = 0; ; i++) {
      const r = await step.do(`organization ${i}`, RETRY, () => svc().bulkOrganization(id));
      if (!r.wait) break;
      await step.sleep(`organization rate limit ${i}`, `${r.wait} seconds`);
    }
    await step.do("start repositories", RETRY, () => svc().startChildren(id));
    // Repository imports start each other; this only waits for the last one (and checks hourly, up to a week).
    for (let i = 0; i < 168; i++) {
      const { open } = await step.do(`progress ${i}`, RETRY, () => svc().bulkProgress(id));
      if (!open) break;
      try {
        await step.waitForEvent(`wait ${i}`, { type: "children-done", timeout: "1 hour" });
      } catch {
        // timed out: restart anything stuck in the queue, then check again
        await step.do(`restart ${i}`, RETRY, () => svc().startChildren(id));
      }
    }
    await step.do("finalize", RETRY, () => svc().bulkFinish(id));
  }
}
