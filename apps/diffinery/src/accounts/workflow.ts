import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.js";
import { AUTHORED_PAGE, assembleExport, exportAccount, exportAuthored, exportRepository, failExport, startExport, type ExportJob } from "./export.js";
import { deleteAccountObjects, destroyRepository, ghostPage, type DeletionCleanup } from "./lifecycle.js";
import { plainSteps } from "../lib/rpc.js";

export type AccountJob = ExportJob | DeletionCleanup;

const RETRY = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "15 minutes" } as const;
/** Bundling a large repository, or putting a large archive together, takes longer. */
const LONG = { ...RETRY, timeout: "60 minutes" } as const;
/** An overall cap on paged steps, so a broken page can't run forever (enough for 100,000 repositories). */
const MAX_PAGES = 4000;

/**
 * The background part of the account lifecycle (accounts/): building an export (instance `export-<id>`), and
 * finishing a deletion (instance `delete-<account id>`): wiping the deleted repositories, the account's own
 * R2 objects, and attributing its work in every other repository to the ghost. Each step is retried on
 * failure; an export that still fails is marked failed with the reason.
 */
export class AccountWorkflow extends WorkflowEntrypoint<Env, AccountJob> {
  override async run(event: WorkflowEvent<AccountJob>, rpcStep: WorkflowStep): Promise<unknown> {
    const step = plainSteps(rpcStep);
    const job = event.payload;
    if (job.kind === "export") return this.export(job.exportId, step);
    return this.cleanup(job, step);
  }

  private async export(id: string, step: WorkflowStep): Promise<unknown> {
    try {
      const plan = await step.do("start", RETRY, () => startExport(this.env, id));
      await step.do("account", RETRY, () => exportAccount(this.env, id));
      for (const repoId of plan.owned) await step.do(`repository ${repoId}`, LONG, () => exportRepository(this.env, id, repoId));
      for (let i = 0; i < plan.visible.length; i += AUTHORED_PAGE) {
        const page = plan.visible.slice(i, i + AUTHORED_PAGE);
        await step.do(`authored ${i}`, RETRY, () => exportAuthored(this.env, id, page));
      }
      await step.do("assemble", LONG, () => assembleExport(this.env, id));
      return { ready: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await step.do("fail", RETRY, () => failExport(this.env, id, message));
      return { failed: message };
    }
  }

  private async cleanup(job: DeletionCleanup, step: WorkflowStep): Promise<unknown> {
    for (const repoId of job.repoIds) await step.do(`destroy ${repoId}`, LONG, () => destroyRepository(this.env, repoId));
    for (let i = 0; i < 10; i++) {
      if (await step.do(`objects ${i}`, RETRY, () => deleteAccountObjects(this.env, job.accountId))) break;
    }
    let after: string | null = "";
    for (let i = 0; after !== null && i < MAX_PAGES; i++) {
      const from: string = after;
      after = await step.do(`ghost ${i}`, RETRY, () => ghostPage(this.env, job, from));
    }
    return { done: true };
  }
}
