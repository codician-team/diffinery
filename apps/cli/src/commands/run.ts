import { enc } from "../api.js";
import { positiveInt, repoPath, str, type Command, type Ctx, type Group } from "../cli.js";
import { CliError, ExitCode } from "../io.js";
import { ago, json, statusText, symbol, table, truncate } from "../output.js";

export interface RunJson {
  id: string;
  run_number: number;
  run_attempt: number;
  name: string;
  display_title: string;
  path: string;
  event: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  actor: { login: string };
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request_number: number | null;
}

export interface JobJson {
  id: string;
  runId: string;
  key: string;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  steps: Array<{ index: number; name?: string; status?: string; conclusion?: string | null }>;
  failure: { message?: string } | null;
}

type RunDetail = RunJson & { jobs: JobJson[] };

function duration(a: string | null, b: string | null): string {
  if (!a) return "";
  const ms = (b ? Date.parse(b) : Date.now()) - Date.parse(a);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

const listCmd: Command = {
  name: "run list",
  summary: "List workflow runs",
  options: {
    branch: { type: "string", short: "b", desc: "Only runs for this branch", arg: "BRANCH" },
    workflow: { type: "string", short: "w", desc: "Only runs of this workflow (file name or path)", arg: "FILE" },
    status: { type: "string", short: "s", desc: "Only runs with this status (queued, in_progress, completed, ...)", arg: "STATUS" },
    event: { type: "string", short: "e", desc: "Only runs triggered by this event", arg: "EVENT" },
    commit: { type: "string", short: "c", desc: "Only runs for this commit SHA", arg: "SHA" },
    limit: { type: "string", short: "L", desc: "Maximum number to show (default 20)", arg: "N" },
  },
  repo: true,
  json: true,
  maxArgs: 0,
  async run(ctx, o) {
    const repo = await ctx.repo();
    const limit = str(o, "limit") ? positiveInt(str(o, "limit"), "--limit") : 20;
    const res = await (await ctx.api()).get<{ total_count: number; workflow_runs: RunJson[] }>(`${repoPath(repo)}/actions/runs`, {
      branch: str(o, "branch"),
      workflow: str(o, "workflow"),
      status: str(o, "status"),
      event: str(o, "event"),
      head_sha: str(o, "commit"),
      per_page: Math.min(limit, 100),
    });
    if (ctx.json) return json(ctx.io, res.workflow_runs);
    if (!res.workflow_runs.length) return ctx.err("No runs found.");
    const c = ctx.c;
    ctx.io.stdout.write(
      table([
        ["", "TITLE", "WORKFLOW", "BRANCH", "EVENT", "ID", "AGE"].map((h) => c.dim(h)),
        ...res.workflow_runs.map((r) => [symbol(c, r.status, r.conclusion), truncate(r.display_title, 50), r.name, c.cyan(r.head_branch), r.event, r.id, c.dim(ago(r.created_at))]),
      ]),
    );
  },
};

function printRun(ctx: Ctx, r: RunDetail): void {
  const c = ctx.c;
  ctx.out(`${symbol(c, r.status, r.conclusion)} ${c.bold(r.display_title)} ${c.dim(`${r.name} #${r.run_number}${r.run_attempt > 1 ? ` (attempt ${r.run_attempt})` : ""}`)}`);
  ctx.out(`${statusText(c, r.status, r.conclusion)} · ${r.event} on ${c.cyan(r.head_branch)} ${c.dim(r.head_sha.slice(0, 7))} · ${r.actor.login} · ${ago(r.created_at)}`);
  ctx.out("");
  ctx.io.stdout.write(table(r.jobs.map((j) => [symbol(c, j.status, j.conclusion), j.name, statusText(c, j.status, j.conclusion), c.dim(duration(j.startedAt, j.completedAt)), c.dim(`job ${j.id}`)])));
  for (const j of r.jobs) if (j.failure?.message) ctx.out(`${c.red("X")} ${j.name}: ${j.failure.message}`);
  ctx.out(c.dim(r.html_url));
}

const view: Command = {
  name: "run view",
  summary: "Show a run and its jobs",
  args: "<run-id>",
  repo: true,
  json: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, _o, [id]) {
    const repo = await ctx.repo();
    const r = await (await ctx.api()).get<RunDetail>(`${repoPath(repo)}/actions/runs/${enc(id!)}`);
    if (ctx.json) return json(ctx.io, r);
    printRun(ctx, r);
  },
};

const watch: Command = {
  name: "run watch",
  summary: "Follow a run until it completes",
  description: "Polls every 3 seconds and prints job status changes. Exits non-zero unless the run succeeds.",
  args: "<run-id>",
  options: { interval: { type: "string", short: "i", desc: "Seconds between polls (default 3)", arg: "SECONDS" } },
  repo: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, o, [id]) {
    const repo = await ctx.repo();
    const api = await ctx.api();
    const interval = Math.max(0, Number(str(o, "interval") ?? 3)) * 1000;
    if (!Number.isFinite(interval)) throw new CliError("--interval must be a number", 2);
    const c = ctx.c;
    const seen = new Map<string, string>();
    let first = true;
    let failures = 0;
    for (;;) {
      let r: RunDetail;
      try {
        r = await api.get<RunDetail>(`${repoPath(repo)}/actions/runs/${enc(id!)}`);
        failures = 0;
      } catch (e) {
        // Ride out transient network/server errors; give up on client errors.
        const status = (e as { status?: number }).status;
        if ((status && status < 500 && status !== 429) || ++failures > 5) throw e;
        await ctx.io.sleep(interval);
        continue;
      }
      if (first) {
        ctx.out(`${c.bold(r.display_title)} ${c.dim(`${r.name} #${r.run_number} · ${r.html_url}`)}`);
        first = false;
      }
      for (const j of r.jobs) {
        const key = `${j.status}/${j.conclusion ?? ""}`;
        if (seen.get(j.id) === key) continue;
        seen.set(j.id, key);
        const extra = j.status === "completed" ? ` ${c.dim(duration(j.startedAt, j.completedAt))}` : "";
        ctx.out(`${symbol(c, j.status, j.conclusion)} ${j.name}: ${statusText(c, j.status, j.conclusion)}${extra}${j.failure?.message && j.status === "completed" ? ` ${c.dim(`(${j.failure.message})`)}` : ""}`);
      }
      if (r.status === "completed") {
        ctx.out(`${symbol(c, r.status, r.conclusion)} Run ${r.id} completed: ${statusText(c, r.status, r.conclusion)}`);
        if (r.conclusion !== "success") {
          const failed = r.jobs.find((j) => j.conclusion === "failure" || j.conclusion === "timed_out");
          if (failed) ctx.err(c.dim(`See the log: diffinery run logs ${failed.id} -R ${repo.owner}/${repo.name}`));
        }
        throw new ExitCode(r.conclusion === "success" ? 0 : 1);
      }
      await ctx.io.sleep(interval);
    }
  },
};

const logs: Command = {
  name: "run logs",
  summary: "Print a job's log",
  args: "<job-id>",
  repo: true,
  json: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, _o, [id]) {
    const repo = await ctx.repo();
    const api = await ctx.api();
    if (ctx.json) return json(ctx.io, await api.get(`${repoPath(repo)}/actions/jobs/${enc(id!)}/logs`, { format: "json" }));
    const res = await api.raw<string>("GET", `${repoPath(repo)}/actions/jobs/${enc(id!)}/logs`, { text: true });
    ctx.io.stdout.write(res.data.endsWith("\n") || !res.data ? res.data : `${res.data}\n`);
  },
};

const rerun: Command = {
  name: "run rerun",
  summary: "Re-run a workflow run",
  args: "[run-id]",
  options: {
    failed: { type: "boolean", desc: "Only re-run the failed jobs and the jobs that depend on them" },
    job: { type: "string", short: "j", desc: "Re-run this job and the jobs that depend on it (no run id needed)", arg: "JOB-ID" },
  },
  repo: true,
  json: true,
  maxArgs: 1,
  async run(ctx, o, [id]) {
    const repo = await ctx.repo();
    const job = str(o, "job");
    if (!job && !id) throw new CliError("give a run id, or --job <job-id>", 2);
    const path = job ? `actions/jobs/${enc(job)}/rerun` : `actions/runs/${enc(id!)}/${o.failed ? "rerun-failed-jobs" : "rerun"}`;
    const r = await (await ctx.authedApi()).post<{ run_id: string }>(`${repoPath(repo)}/${path}`);
    if (ctx.json) return json(ctx.io, r);
    ctx.out(`${ctx.c.green("✓")} Re-running as run ${r.run_id}`);
  },
};

const cancel: Command = {
  name: "run cancel",
  summary: "Cancel a queued or running run",
  args: "<run-id>",
  repo: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, _o, [id]) {
    const repo = await ctx.repo();
    await (await ctx.authedApi()).post(`${repoPath(repo)}/actions/runs/${enc(id!)}/cancel`);
    ctx.out(`${ctx.c.green("✓")} Cancellation requested for run ${id}`);
  },
};

export const runGroup: Group = { name: "run", summary: "Inspect and control workflow runs", commands: [listCmd, view, watch, logs, rerun, cancel] };
