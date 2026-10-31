import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";
import type { RunnerSize } from "../runner/sizes.js";
import { GitHubAppClient, githubApp } from "./github.js";
import { GitHubRunners, containerHost, type JobEvent, type QueuedJob } from "./service.js";

/**
 * One per Diffinery account that pays for GitHub jobs on Diffinery runners (named by the account id).
 * Webhooks and container stops only record what happened and set the alarm; the alarm starts runners
 * and stops idle ones (GitHubRunners.pump), one pass at a time, so a webhook never waits on a container
 * start and GitHub's 10-second delivery timeout is never at risk.
 */
export class GitHubRunnersDO extends DurableObject<Env> {
  private client: GitHubAppClient | null = null;

  private runners(): GitHubRunners | null {
    const app = githubApp(this.env);
    if (!app) return null;
    this.client ??= new GitHubAppClient(app);
    return new GitHubRunners(this.env, this.client, containerHost(this.env));
  }

  /** Sets the alarm `ms` from now unless it is already due sooner. */
  private async wake(accountId: string, ms: number): Promise<void> {
    await this.ctx.storage.put("account", accountId);
    const at = Date.now() + ms;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
  }

  async queued(accountId: string, job: QueuedJob, size: RunnerSize): Promise<void> {
    const r = this.runners();
    if (r && (await r.queued(accountId, job, size))) await this.wake(accountId, 0);
  }

  async jobEvent(accountId: string, ev: JobEvent): Promise<void> {
    const r = this.runners();
    if (!r) return;
    await r.jobEvent(ev);
    await this.wake(accountId, 0);
  }

  /** A runner's container stopped (runner/containers.ts onStop); containers started before it said which don't. */
  async stopped(accountId: string, runnerId: string, exitCode: number | null, container?: string): Promise<void> {
    const r = this.runners();
    if (!r) return;
    await r.stopped(runnerId, exitCode, container);
    await this.wake(accountId, 0);
  }

  /** A kill switch (lib/killswitch.ts stopGitHubRunners). */
  async stopAll(accountId: string, message: string): Promise<number> {
    return (await this.runners()?.stopAll(accountId, message)) ?? 0;
  }

  override async alarm(): Promise<void> {
    const accountId = await this.ctx.storage.get<string>("account");
    const r = this.runners();
    if (!accountId || !r) return;
    const { next } = await r.pump(accountId);
    if (next !== null) await this.wake(accountId, next);
  }
}
