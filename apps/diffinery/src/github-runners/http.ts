import { Hono } from "hono";
import type { AppVars } from "../auth/principal.js";
import type { Env } from "../env.js";
import { now } from "../lib/util.js";
import { githubApp, webhookSigned } from "./github.js";
import { runnerFor, type JobEvent, type QueuedJob } from "./service.js";

/**
 * POST /-/github/webhook: the GitHub App's webhook (github-runners/github.ts). Off (404) until the app is
 * configured; every delivery must carry GitHub's signature made with GITHUB_APP_WEBHOOK_SECRET.
 *
 * - workflow_job: a queued job whose runs-on asks for a Diffinery runner waits for one in the GitHubRunnersDO
 *   of the account its installation is linked to; in_progress and completed say which job a Diffinery
 *   runner took, and drop queued jobs that no longer need one.
 * - installation and installation_target: an uninstalled app's link goes, a suspended one starts nothing,
 *   and a renamed GitHub account keeps its link under the new name.
 */

/** Largest delivery read, in bytes: workflow_job deliveries are a few kilobytes, installation ones list repositories. */
export const MAX_WEBHOOK_BODY = 5 << 20;

export const githubWebhook = new Hono<{ Bindings: Env; Variables: AppVars }>();

interface WorkflowJobPayload {
  action: string;
  workflow_job: { id: number; run_id?: number; name?: string; workflow_name?: string | null; labels?: string[]; runner_name?: string | null; conclusion?: string | null; html_url?: string };
  repository: { full_name: string };
  installation?: { id: number };
}

interface InstallationPayload {
  action: string;
  installation: { id: number; account?: { login?: string } | null };
}

githubWebhook.post("/-/github/webhook", async (c) => {
  const app = githubApp(c.env);
  if (!app || !c.env.GITHUB_RUNNERS) return c.json({ message: "GitHub runners are off: this Diffinery has no GitHub App" }, 404);
  if (Number(c.req.header("content-length") ?? 0) > MAX_WEBHOOK_BODY) return c.json({ message: "body too large" }, 413);
  const body = await c.req.text();
  if (body.length > MAX_WEBHOOK_BODY) return c.json({ message: "body too large" }, 413);
  if (!(await webhookSigned(app.webhookSecret, c.req.header("x-hub-signature-256"), body))) return c.json({ message: "missing or bad signature" }, 401);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.json({ message: "body must be JSON" }, 400);
  }
  const event = c.req.header("x-github-event") ?? "";
  const db = c.env.DB;
  if (event === "ping") return c.json({ ok: true });

  if (event === "installation" || event === "installation_target") {
    const p = payload as InstallationPayload;
    const id = p.installation?.id;
    if (typeof id !== "number") return c.json({ message: "no installation" }, 400);
    if (event === "installation" && p.action === "deleted") await db.prepare("DELETE FROM github_installations WHERE id = ?").bind(id).run();
    else if (event === "installation" && p.action === "suspend") await db.prepare("UPDATE github_installations SET suspended_at = ? WHERE id = ?").bind(now(), id).run();
    else if (event === "installation" && p.action === "unsuspend") await db.prepare("UPDATE github_installations SET suspended_at = NULL WHERE id = ?").bind(id).run();
    else if (event === "installation_target" && p.action === "renamed" && p.installation.account?.login) await db.prepare("UPDATE github_installations SET github_login = ? WHERE id = ?").bind(p.installation.account.login, id).run();
    return c.json({ ok: true });
  }

  if (event !== "workflow_job") return c.json({ ignored: `event ${event}` });
  const p = payload as WorkflowJobPayload;
  const job = p.workflow_job;
  const installationId = p.installation?.id;
  if (!job || typeof job.id !== "number" || typeof installationId !== "number" || !p.repository?.full_name) return c.json({ message: "not a workflow_job delivery" }, 400);
  const labels = (job.labels ?? []).filter((l): l is string => typeof l === "string").slice(0, 100);
  const size = runnerFor(labels);
  const ours = typeof job.runner_name === "string" && job.runner_name.startsWith("diffinery-");
  // Most jobs of an installed repository aren't for Diffinery: nothing to look up for those.
  if (!size && !ours) return c.json({ ignored: "not for a Diffinery runner" });
  const link = await db.prepare("SELECT account_id FROM github_installations WHERE id = ?").bind(installationId).first<{ account_id: string }>();
  if (!link) return c.json({ ignored: "this installation isn't linked to a Diffinery account" });
  const stub = c.env.GITHUB_RUNNERS.get(c.env.GITHUB_RUNNERS.idFromName(link.account_id));

  if (p.action === "queued" && size) {
    const q: QueuedJob = {
      installationId,
      repo: p.repository.full_name,
      githubJobId: job.id,
      runId: typeof job.run_id === "number" ? job.run_id : null,
      workflowName: job.workflow_name ?? null,
      jobName: job.name ?? null,
      htmlUrl: typeof job.html_url === "string" && job.html_url.startsWith(app.webUrl + "/") ? job.html_url : null,
      labels,
    };
    await stub.queued(link.account_id, q, size);
    return c.json({ queued: true, size });
  }
  if (p.action === "in_progress" || p.action === "completed") {
    const ev: JobEvent = { installationId, githubJobId: job.id, action: p.action, runnerName: ours ? job.runner_name! : null, jobName: job.name ?? null, conclusion: job.conclusion ?? null };
    await stub.jobEvent(link.account_id, ev);
  }
  return c.json({ ok: true });
});
