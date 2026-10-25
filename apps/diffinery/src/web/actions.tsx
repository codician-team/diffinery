/** @jsxImportSource hono/jsx */
import { parseWorkflow, type DispatchInput } from "@diffinery/workflow-yaml";
import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import { loadRepo } from "../http/common.js";
import { HttpError } from "../lib/util.js";
import type { JobInfo, PendingDeployment, RunInfo } from "../repo/actions.js";
import type { DeploymentReview } from "../repo/deployments.js";
import { reviewDeployments, viewerFor } from "../http/environment-reviews.js";
import { atLeast } from "../repo/types.js";
import { ICONS } from "./assets.js";
import { KCheckbox, KSelect } from "./kumo.js";
import { csrfToken } from "./csrf.js";
import { ActionsBlockedBanner, actionsSwitches } from "./kill-switches.js";
import { Actor, Form, Markdown, Pager, Status, Time, act, duration, encPath, fmtBytes, pageNum, post, qs, refNames, render, repoUrl, shortSha, type WebApp, prm } from "./ui.js";

type Loaded = Awaited<ReturnType<typeof loadRepo>>;
type LogLine = { seq: number; t: string; step: number; text: string };
/** Plain (non-RPC-wrapped) shape of a run, which keeps type checking shallow. */
type RunWithJobs = RunInfo & { jobs: JobInfo[] };

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const MAX_LOG_LINES = 20000;
/** Conclusions "Re-run failed jobs" keeps (repo/actions.ts KEPT_CONCLUSIONS); the button shows when a job ended any other way. */
const KEPT_ON_RERUN = new Set(["success", "skipped", "neutral"]);

const refLabel = (ref: string): string => ref.replace(/^refs\/(heads|tags)\//, "");

function runDuration(r: Pick<RunInfo, "status" | "createdAt" | "updatedAt">): string {
  return duration(r.createdAt, r.status === "completed" ? r.updatedAt : null);
}

function matrixLabel(m: Record<string, unknown>): string {
  const entries = Object.entries(m ?? {});
  if (!entries.length) return "";
  return entries.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(", ");
}

const RunRow: FC<{ base: string; r: RunInfo }> = ({ base, r }) => (
  <li>
    <Status status={r.status} conclusion={r.conclusion} />
    <div class="grow">
      <a class="title" href={`${base}/actions/runs/${r.id}`}>
        {r.title || r.workflowName}
      </a>
      <div class="meta">
        <b>{r.workflowName}</b> #{r.number}
        {r.attempt > 1 ? ` (attempt ${r.attempt})` : ""}: {r.event.replace(/_/g, " ")}
        {r.prNumber ? (
          <>
            {" "}
            for <a href={`${base}/pull/${r.prNumber}`}>#{r.prNumber}</a>
          </>
        ) : null}{" "}
        by {r.actor.login}
        {r.actor.kind === "agent" ? <span class="badge agent" style="margin-left:4px">agent</span> : null}
      </div>
    </div>
    <span class="badge mono nowrap" title={r.ref}>
      {refLabel(r.ref)}
    </span>
    <div class="right small muted nowrap" style="min-width:110px">
      <div>
        <Time at={r.createdAt} />
      </div>
      <div>{runDuration(r)}</div>
    </div>
  </li>
);

/** Parse workflow_dispatch input definitions from the workflow file on the default branch. */
async function dispatchInputs(l: Loaded, path: string): Promise<Record<string, DispatchInput> | null> {
  try {
    const blob = await l.stub.blob(l.repo.default_branch, path);
    if (!blob || blob.binary) return null;
    const { workflow } = parseWorkflow(new TextDecoder().decode(blob.content), path);
    const d = workflow?.on.workflow_dispatch;
    return d ? (d.inputs ?? {}) : null;
  } catch {
    return null;
  }
}

function classify(text: string): { cls: string; text: string } {
  const t = text.replace(ANSI, "");
  if (t.startsWith("::group::")) return { cls: "grp", text: `▾ ${t.slice(9)}` };
  if (t.startsWith("::endgroup::")) return { cls: "grp", text: "" };
  if (/^(##\[error\]|::error)/.test(t)) return { cls: "err", text: t };
  if (/^(##\[warning\]|::warning)/.test(t)) return { cls: "wrn", text: t };
  return { cls: "", text: t };
}

async function allLogs(l: Loaded, jobId: string): Promise<{ lines: LogLine[]; complete: boolean; truncated: boolean }> {
  const out: LogLine[] = [];
  let after = -1;
  let complete = false;
  for (let i = 0; i < 5; i++) {
    const page = await l.stub.jobLogs(jobId, after);
    complete = page.complete;
    out.push(...page.lines);
    if (page.lines.length < 5000 || out.length >= MAX_LOG_LINES) break;
    after = page.lines[page.lines.length - 1]!.seq;
  }
  return { lines: out.slice(0, MAX_LOG_LINES), complete, truncated: out.length >= MAX_LOG_LINES };
}

/** Environments the run waits on: who may approve, any wait timer, and a review form for listed reviewers. */
const ReviewDeployments: FC<{ base: string; runId: string; pending: PendingDeployment[]; reviews: DeploymentReview[]; t: string; canAct: boolean }> = ({ base, runId, pending, reviews, t, canAct }) => {
  const mine = pending.filter((p) => p.currentUserCanApprove);
  return (
    <div class="box" style="border-color:var(--amber)">
      <div class="head">
        <h3>Waiting for {pending.some((p) => p.needsReview) ? "review" : "a wait timer"}</h3>
      </div>
      <ul class="list">
        {pending.map((p) => {
          const timerEnds = new Date(Date.parse(p.waitTimerStartedAt) + p.waitTimer * 60_000).toISOString();
          return (
            <li>
              <div class="grow">
                <b>{p.environment.name}</b>
                <div class="meta">
                  {p.needsReview ? <>Needs an approval from {p.reviewers.map((r) => r.login).join(", ")}. </> : p.reviewers.length ? "Approved. " : null}
                  {p.waitTimer > 0 ? (
                    <>
                      Wait timer of {p.waitTimer} minute{p.waitTimer === 1 ? "" : "s"}, ends <Time at={timerEnds} />.{" "}
                    </>
                  ) : null}
                  {p.selfBlocked ? "You started this run, and this environment doesn't let you approve it." : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {canAct && mine.length ? (
        <Form action={`${base}/actions/runs/${runId}/review`} t={t} class="body" style="border-top:1px solid var(--border2)">
          <div class="field">
            <label>Environments to review</label>
            {mine.map((p) => (
              <div>
                <KCheckbox name="environment" value={String(p.environment.id)} checked label={p.environment.name} />
              </div>
            ))}
          </div>
          <div class="field">
            <label>Comment</label>
            <textarea name="comment" maxlength={4000} style="min-height:60px" placeholder="Optional"></textarea>
          </div>
          <div class="row">
            <button class="btn primary" name="state" value="approved">
              Approve and deploy
            </button>
            <button class="btn danger" name="state" value="rejected">
              Reject
            </button>
          </div>
        </Form>
      ) : null}
      {reviews.length ? <ReviewHistory reviews={reviews} /> : null}
    </div>
  );
};

const ReviewHistory: FC<{ reviews: DeploymentReview[] }> = ({ reviews }) => (
  <ul class="list">
    {reviews.map((r) => (
      <li>
        <div class="grow small">
          <b>{r.user.login}</b> {r.state} <b>{r.environment}</b> <Time at={r.createdAt} />
          {r.comment ? <div class="muted">{r.comment}</div> : null}
        </div>
      </li>
    ))}
  </ul>
);

export function registerActions(web: WebApp): void {
  web.get("/:owner/:repo/actions", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const { repo, caller, stub } = l;
    const base = repoUrl(repo);
    const workflow = c.req.query("workflow") ?? "";
    const branch = c.req.query("branch") ?? "";
    const status = c.req.query("status") ?? "";
    const page = pageNum(c);
    const per = 25;
    const switches = actionsSwitches(c.env, repo.id);
    const [runs, workflows, names] = await Promise.all([
      stub.runs({ workflow: workflow || undefined, branch: branch || undefined, status: status || undefined, limit: per, offset: (page - 1) * per }),
      stub.workflows().catch(() => [] as Array<{ path: string; name: string; errors: string[]; triggers: string[] }>),
      refNames(stub),
    ]);
    const selected = workflow ? workflows.find((w) => w.path === workflow || w.path.endsWith(`/${workflow}`)) : undefined;
    const canWrite = atLeast(caller.role, "write") && c.get("principal").type === "account" && !repo.archived;
    const inputs = selected && canWrite && selected.triggers.includes("workflow_dispatch") ? await dispatchInputs(l, selected.path) : null;
    const t = csrfToken(c);
    const href = (p: Record<string, string | number | undefined>) => `${base}/actions${qs({ workflow: workflow || undefined, branch: branch || undefined, status: status || undefined, ...p })}`;
    return render(
      c,
      { title: `Actions · ${repo.owner_login}/${repo.name}`, repo: { repo, caller, tab: "actions" }, live: "runs" },
      <div class="grid left">
        <aside class="side">
          <section>
            <h3>Workflows</h3>
            <div class="nav">
              <a href={`${base}/actions`} class={!workflow ? "on" : ""}>
                All workflows
              </a>
              {workflows.map((w) => (
                <a href={`${base}/actions${qs({ workflow: w.path })}`} class={selected?.path === w.path ? "on" : ""} title={w.path}>
                  {w.errors.length ? <span class="bad">{raw(ICONS.failure)}</span> : null} {w.name}
                </a>
              ))}
            </div>
            {workflows.length === 0 ? (
              <p class="muted small">
                No workflows on <span class="mono">{repo.default_branch}</span>. Add a YAML file under <code>.github/workflows/</code>.
              </p>
            ) : null}
          </section>
          <section>
            <h3>Help</h3>
            <p class="small muted m0">Workflows use GitHub Actions syntax. Jobs run on Linux containers; secrets and variables are configured in repository settings.</p>
          </section>
        </aside>
        <div>
          <ActionsBlockedBanner env={c.env} repoId={repo.id} switches={switches} />
          <div class="row between mb">
            <h1 class="m0">{selected ? selected.name : "All workflows"}</h1>
            {selected ? <span class="mono muted small">{selected.path}</span> : null}
          </div>
          {selected?.errors.length ? (
            <div class="failure">
              <b>This workflow file has errors</b>
              <pre>{selected.errors.join("\n")}</pre>
            </div>
          ) : null}
          {!selected && workflows.some((w) => w.errors.length) ? (
            <div class="failure">
              <b>Some workflow files have errors</b>
              <pre>{workflows.filter((w) => w.errors.length).map((w) => `${w.path}\n  ${w.errors.join("\n  ")}`).join("\n")}</pre>
            </div>
          ) : null}
          {selected && inputs ? (
            <details class="box">
              <summary class="head" style="cursor:pointer">
                {raw(ICONS.play)} <b>Run workflow</b>
                <span class="muted small">This workflow has a workflow_dispatch trigger.</span>
              </summary>
              <Form action={`${base}/actions/dispatch`} t={t} class="body">
                <input type="hidden" name="workflow" value={selected.path} />
                <div class="field" style="max-width:320px">
                  <label>Use workflow from</label>
                  <KSelect
                    name="ref"
                    block
                    label="Use workflow from"
                    value={names.branches.includes(repo.default_branch) ? repo.default_branch : undefined}
                    options={[...names.branches.map((b) => ({ value: b, label: b })), ...names.tags.map((tg) => ({ value: tg, label: `tag: ${tg}` }))]}
                  />
                </div>
                {Object.entries(inputs).map(([name, d]) => (
                  <div class="field" style="max-width:520px">
                    {d.type === "boolean" ? (
                      <>
                        <input type="hidden" name={`in_${name}`} value="false" />
                        <KCheckbox name={`in_${name}`} value="true" checked={d.default === true || d.default === "true"} label={d.description ?? name} />
                      </>
                    ) : (
                      <>
                        <label>
                          {d.description ?? name} {d.required ? <span class="bad">*</span> : null}
                        </label>
                        {d.type === "choice" && d.options?.length ? (
                          <KSelect
                            name={`in_${name}`}
                            block
                            label={d.description ?? name}
                            value={d.options.includes(String(d.default ?? "")) ? String(d.default ?? "") : undefined}
                            options={d.options.map((o) => ({ value: o, label: o }))}
                          />
                        ) : (
                          <input type={d.type === "number" ? "number" : "text"} name={`in_${name}`} value={d.default === undefined || d.default === null ? "" : String(d.default)} required={!!d.required} />
                        )}
                      </>
                    )}
                    {d.description && d.type !== "boolean" ? <div class="hint mono">{name}</div> : null}
                  </div>
                ))}
                <button class="btn green">{raw(ICONS.play)} Run workflow</button>
              </Form>
            </details>
          ) : null}
          <div class="box" data-fragment="runs">
            <div class="head">
              <b>
                {runs.total} workflow run{runs.total === 1 ? "" : "s"}
              </b>
              <span class="grow" />
              <form method="get" action={`${base}/actions`} class="row" style="gap:6px">
                {workflow ? <input type="hidden" name="workflow" value={workflow} /> : null}
                <KSelect
                  name="branch"
                  size="sm"
                  label="Branch"
                  autosubmit
                  value={branch && names.branches.includes(branch) ? branch : ""}
                  options={[{ value: "", label: "All branches" }, ...names.branches.map((b) => ({ value: b, label: b }))]}
                />
                <KSelect
                  name="status"
                  size="sm"
                  label="Status"
                  autosubmit
                  value={status ?? ""}
                  options={[{ value: "", label: "Any status" }, ...["queued", "in_progress", "completed", "success", "failure", "cancelled"].map((s) => ({ value: s, label: s.replace("_", " ") }))]}
                />
                <button class="btn sm">Filter</button>
              </form>
            </div>
            {runs.runs.length ? (
              <ul class="list">
                {runs.runs.map((r) => (
                  <RunRow base={base} r={r} />
                ))}
              </ul>
            ) : (
              <div class="empty">{workflow || branch || status ? "No runs match these filters." : "No workflow runs yet. Push a commit with a workflow file to start one."}</div>
            )}
          </div>
          <Pager page={page} hasNext={page * per < runs.total} href={(p) => href({ page: p > 1 ? p : undefined })} />
        </div>
      </div>,
    );
  });

  post(web, "/:owner/:repo/actions/dispatch", async (c, f) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "write");
    if (c.get("principal").type !== "account") throw new HttpError(401, "sign in required");
    const base = repoUrl(l.repo);
    const workflow = f.s("workflow");
    const inputs: Record<string, unknown> = {};
    for (const key of f.keys()) if (key.startsWith("in_")) inputs[key.slice(3)] = f.all(key).pop();
    return act(c, `${base}/actions${qs({ workflow })}`, async () => {
      const run = await l.stub.dispatchWorkflow(workflow, f.s("ref") || l.repo.default_branch, inputs, l.caller);
      return `${base}/actions/runs/${run.id}`;
    });
  });

  web.get("/:owner/:repo/actions/runs/:runId", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const { repo, caller, stub } = l;
    const base = repoUrl(repo);
    const runId = prm(c, "runId");
    // The run, its artifacts and the viewer side by side, then its deployments (they need the run's own id and status).
    const switches = actionsSwitches(c.env, repo.id);
    const [run, artifacts, viewer] = await Promise.all([
      stub.run(runId) as unknown as Promise<RunWithJobs>,
      stub.artifacts(runId).catch(() => [] as Array<{ name: string; size: number; createdAt: string }>),
      viewerFor(c, repo),
    ]);
    const principal = c.get("principal");
    const [pending, reviews] = await Promise.all([run.status !== "completed" ? stub.pendingDeployments(run.id, viewer) : Promise.resolve([] as PendingDeployment[]), stub.deploymentReviews(run.id)]);
    const groups = new Map<string, JobInfo[]>();
    for (const j of run.jobs) groups.set(j.key, [...(groups.get(j.key) ?? []), j]);
    const canWrite = atLeast(caller.role, "write") && c.get("principal").type === "account" && !repo.archived;
    const t = csrfToken(c);
    const behalf = run.actor.onBehalfOf;
    return render(
      c,
      { title: `${run.title || run.workflowName} · Run #${run.number}`, repo: { repo, caller, tab: "actions" }, live: run.status !== "completed" ? `run:${run.id}` : undefined },
      <div data-fragment="run">
        <ActionsBlockedBanner env={c.env} repoId={repo.id} switches={switches} />
        <div class="row between mb" style="align-items:flex-start">
          <div class="grow">
            <div class="muted small">
              <a href={`${base}/actions${qs({ workflow: run.workflowPath })}`}>{run.workflowName}</a> · run #{run.number}
              {run.attempt > 1 ? ` · attempt ${run.attempt}` : ""}
            </div>
            <h1 class="row" style="gap:8px;margin-top:4px">
              <Status status={run.status} conclusion={run.conclusion} /> {run.title || run.workflowName}
            </h1>
          </div>
          <div class="row">
            {canWrite && run.status !== "completed" ? (
              <Form action={`${base}/actions/runs/${run.id}/cancel`} t={t} class="inline" confirm="Cancel this run?">
                <button class="btn danger">{raw(ICONS.cancelled)} Cancel run</button>
              </Form>
            ) : null}
            {canWrite && run.status === "completed" && run.jobs.some((j) => !KEPT_ON_RERUN.has(j.conclusion ?? "")) ? (
              <Form action={`${base}/actions/runs/${run.id}/rerun-failed`} t={t} class="inline">
                <button class="btn">{raw(ICONS.history)} Re-run failed jobs</button>
              </Form>
            ) : null}
            {canWrite && run.status === "completed" ? (
              <Form action={`${base}/actions/runs/${run.id}/rerun`} t={t} class="inline">
                <button class="btn">{raw(ICONS.history)} Re-run all jobs</button>
              </Form>
            ) : null}
          </div>
        </div>
        <div class="box">
          <div class="body">
            <dl class="kv">
              <dt>Status</dt>
              <dd>
                <b>{run.status === "completed" ? (run.conclusion ?? "completed") : run.status.replace("_", " ")}</b>
                {run.status === "completed" ? <span class="muted"> in {runDuration(run)}</span> : <span class="muted"> for {runDuration(run)}</span>}
              </dd>
              <dt>Triggered</dt>
              <dd>
                {run.event.replace(/_/g, " ")} by <Actor login={run.actor.login} kind={run.actor.kind} onBehalfOf={behalf} avatar={false} /> <Time at={run.createdAt} />
              </dd>
              <dt>Commit</dt>
              <dd>
                <a class="sha" href={`${base}/commit/${run.sha}`}>
                  {shortSha(run.sha)}
                </a>{" "}
                on{" "}
                <a class="mono" href={`${base}/tree/${encPath(refLabel(run.ref))}`}>
                  {refLabel(run.ref)}
                </a>
                {run.prNumber ? (
                  <>
                    {" "}
                    · pull request <a href={`${base}/pull/${run.prNumber}`}>#{run.prNumber}</a>
                  </>
                ) : null}
              </dd>
              <dt>Workflow file</dt>
              <dd>
                <a class="mono" href={`${base}/blob/${run.sha}/${encPath(run.workflowPath)}`}>
                  {run.workflowPath}
                </a>
              </dd>
            </dl>
          </div>
        </div>
        {pending.length ? (
          <ReviewDeployments base={base} runId={run.id} pending={pending} reviews={reviews} t={t} canAct={principal.type === "account" && principal.account.kind === "user" && !repo.archived} />
        ) : reviews.length ? (
          <div class="box">
            <div class="head">
              <h3>Deployment reviews</h3>
            </div>
            <ReviewHistory reviews={reviews} />
          </div>
        ) : null}
        {[...groups.entries()].map(([key, jobs]) => (
          <div class="box jobgroup">
            <div class="head">
              <b class="mono">{key}</b>
              {jobs.length > 1 ? <span class="muted small">{jobs.length} jobs (matrix)</span> : null}
            </div>
            {jobs.map((j) => (
              <a class="job" href={`${base}/actions/runs/${run.id}/job/${j.id}`}>
                <Status status={j.status} conclusion={j.conclusion} />
                <div class="grow">
                  <b>{j.name}</b>
                  {matrixLabel(j.matrix) && !j.name.includes("(") ? <span class="muted small"> ({matrixLabel(j.matrix)})</span> : null}
                  {j.failure ? <div class="small bad">{j.failure.message.split("\n")[0]}</div> : null}
                  {j.carriedFrom ? <div class="small muted">Kept from an earlier attempt</div> : null}
                </div>
                <span class="muted small nowrap">{j.startedAt ? duration(j.startedAt, j.completedAt) : j.status === "approval" ? "waiting for approval" : j.status}</span>
              </a>
            ))}
          </div>
        ))}
        {run.jobs.length === 0 ? <div class="blank mb">{run.status === "completed" ? "This run has no jobs." : "Waiting for jobs to be scheduled…"}</div> : null}
        {artifacts.length ? (
          <div class="box">
            <div class="head">
              <h3>{raw(ICONS.download)} Artifacts</h3>
            </div>
            <ul class="list">
              {artifacts.map((a) => (
                <li>
                  <div class="grow">
                    <a class="title" href={`${base}/actions/runs/${run.id}/artifacts/${encodeURIComponent(a.name)}`}>
                      {a.name}
                    </a>
                    <div class="meta">
                      {fmtBytes(a.size)} · <Time at={a.createdAt} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>,
    );
  });

  post(web, "/:owner/:repo/actions/runs/:runId/review", async (c, f) => {
    // Listed reviewers may have read access only; the rules are checked again where the decision is made.
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const back = `${repoUrl(l.repo)}/actions/runs/${prm(c, "runId")}`;
    const state = f.s("state");
    return act(
      c,
      back,
      async () => {
        await reviewDeployments(c, l, prm(c, "runId"), { environment_ids: f.all("environment").map(Number), state, comment: f.s("comment") });
      },
      state === "approved" ? "Approved. The jobs start once any wait timer has passed." : "Rejected. The waiting jobs fail.",
    );
  });

  post(web, "/:owner/:repo/actions/runs/:runId/cancel", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "write");
    const back = `${repoUrl(l.repo)}/actions/runs/${prm(c, "runId")}`;
    return act(c, back, async () => l.stub.cancelRun(prm(c, "runId"), l.caller), "Cancellation requested.");
  });

  for (const [path, scope] of [["rerun", "all"], ["rerun-failed", "failed"]] as const) {
    post(web, `/:owner/:repo/actions/runs/:runId/${path}`, async (c) => {
      const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "write");
      const base = repoUrl(l.repo);
      return act(c, `${base}/actions/runs/${prm(c, "runId")}`, async () => {
        const run = await l.stub.rerun(prm(c, "runId"), l.caller, scope);
        return `${base}/actions/runs/${run.id}`;
      });
    });
  }

  post(web, "/:owner/:repo/actions/runs/:runId/job/:jobId/rerun", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "write");
    const base = repoUrl(l.repo);
    return act(c, `${base}/actions/runs/${prm(c, "runId")}/job/${prm(c, "jobId")}`, async () => {
      const job = (await l.stub.job(prm(c, "jobId"))) as unknown as JobInfo;
      if (job.runId !== prm(c, "runId")) throw new HttpError(404, "job not found");
      const run = await l.stub.rerunJob(job.id, l.caller);
      return `${base}/actions/runs/${run.id}`;
    });
  });

  web.get("/:owner/:repo/actions/runs/:runId/job/:jobId", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const { repo, caller, stub } = l;
    const base = repoUrl(repo);
    const runId = prm(c, "runId");
    const jobId = prm(c, "jobId");
    const run = (await stub.run(runId)) as unknown as RunWithJobs;
    const job = (await stub.job(jobId)) as unknown as JobInfo;
    if (job.runId !== run.id) throw new HttpError(404, "job not found");
    const logs = await allLogs(l, jobId);
    const byStep = new Map<number, LogLine[]>();
    for (const line of logs.lines) byStep.set(line.step, [...(byStep.get(line.step) ?? []), line]);
    const stepIdx = new Set<number>([...job.steps.map((s) => s.index), ...byStep.keys()]);
    const sections = [...stepIdx].sort((a, b) => a - b);
    const stepOf = new Map(job.steps.map((s) => [s.index, s]));
    const lastSeq = logs.lines.length ? logs.lines[logs.lines.length - 1]!.seq : -1;
    const live = job.status !== "completed";
    const failedStep = job.failure?.step;
    const canRerun = run.status === "completed" && atLeast(caller.role, "write") && c.get("principal").type === "account" && !repo.archived;
    return render(
      c,
      { title: `${job.name} · ${run.title || run.workflowName}`, repo: { repo, caller, tab: "actions" }, live: live ? `job:${job.id}` : undefined, liveMode: "log", lastSeq, wide: true },
      <div class="grid left">
        <aside class="side">
          <section>
            <a href={`${base}/actions/runs/${run.id}`} class="small">
              ← {run.workflowName} #{run.number}
            </a>
            <h3 class="mt">Jobs</h3>
            <div class="nav">
              {run.jobs.map((j) => (
                <a href={`${base}/actions/runs/${run.id}/job/${j.id}`} class={j.id === job.id ? "on" : ""} style="display:flex;gap:6px;align-items:center">
                  <Status status={j.status} conclusion={j.conclusion} /> <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{j.name}</span>
                </a>
              ))}
            </div>
          </section>
        </aside>
        <div>
          <div class="row between mb">
            <h1 class="row m0" style="gap:8px">
              <Status status={job.status} conclusion={job.conclusion} /> {job.name}
            </h1>
            <div class="row">
              <span class="muted small">
                {job.startedAt ? (
                  <>
                    {job.status === "completed" ? "took" : "running for"} {duration(job.startedAt, job.completedAt)}
                  </>
                ) : (
                  job.status
                )}
              </span>
              <a class="btn sm" href={`${base}/actions/runs/${run.id}/job/${job.id}/logs`}>
                {raw(ICONS.download)} Raw logs
              </a>
              {canRerun ? (
                <Form action={`${base}/actions/runs/${run.id}/job/${job.id}/rerun`} t={csrfToken(c)} class="inline">
                  <button class="btn sm">{raw(ICONS.history)} Re-run this job</button>
                </Form>
              ) : null}
            </div>
          </div>
          {matrixLabel(job.matrix) ? <p class="muted small">Matrix: {matrixLabel(job.matrix)}</p> : null}
          {job.carriedFrom ? <p class="muted small">Kept from an earlier attempt of this run: it didn't run again in attempt {run.attempt}.</p> : null}
          {job.failure ? (
            <div class="failure">
              <b>
                {raw(ICONS.failure)} {job.conclusion === "cancelled" ? "Cancelled" : job.conclusion === "timed_out" ? "Timed out" : "Failed"}
                {failedStep !== undefined && failedStep !== null ? (
                  <>
                    {" "}
                    at{" "}
                    <a href={`#step-${failedStep}`} class="bad">
                      {stepOf.get(failedStep)?.name ?? `step ${failedStep + 1}`}
                    </a>
                  </>
                ) : null}
              </b>
              <pre>{job.failure.message}</pre>
            </div>
          ) : null}
          {logs.truncated ? (
            <div class="flash info">
              Showing the first {MAX_LOG_LINES.toLocaleString("en-US")} lines. <a href={`${base}/actions/runs/${run.id}/job/${job.id}/logs`}>Download the full log</a>.
            </div>
          ) : null}
          <div class="log">
            {sections.length === 0 ? <div style="padding:14px;color:#9aa3ad">{live ? "Waiting for the runner to start…" : "No log output."}</div> : null}
            {sections.map((idx) => {
              const s = stepOf.get(idx);
              const lines = byStep.get(idx) ?? [];
              const failed = s?.conclusion === "failure" || failedStep === idx;
              const running = s?.status === "in_progress";
              return (
                <details data-step={String(idx)} id={`step-${idx}`} open={failed || running || (live && idx === sections[sections.length - 1])}>
                  <summary>
                    {s ? (
                      <Status status={s.status} conclusion={s.conclusion} />
                    ) : idx < 0 ? (
                      <Status conclusion={job.startedAt ? "success" : "queued"} />
                    ) : (
                      <Status conclusion="neutral" />
                    )}
                    {idx < 0 ? "Set up job" : (s?.name ?? `Step ${idx + 1}`)}
                    <span class="dur">{s?.startedAt ? duration(s.startedAt, s.completedAt) : ""}</span>
                  </summary>
                  <pre>
                    {lines.map((ln) => {
                      const k = classify(ln.text);
                      return <span class={k.cls || undefined}>{k.text}</span>;
                    })}
                  </pre>
                </details>
              );
            })}
          </div>
          {job.summary ? (
            <div class="box">
              <div class="head">
                <h3>Job summary</h3>
              </div>
              <div class="body">
                <Markdown text={job.summary} />
              </div>
            </div>
          ) : null}
          {Object.keys(job.outputs ?? {}).length ? (
            <div class="box">
              <div class="head">
                <h3>Outputs</h3>
              </div>
              <div class="body">
                <dl class="kv">
                  {Object.entries(job.outputs).map(([k, v]) => (
                    <>
                      <dt class="mono">{k}</dt>
                      <dd class="mono" style="word-break:break-all">
                        {v}
                      </dd>
                    </>
                  ))}
                </dl>
              </div>
            </div>
          ) : null}
        </div>
      </div>,
    );
  });

  web.get("/:owner/:repo/actions/runs/:runId/job/:jobId/logs", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const job = await l.stub.job(prm(c, "jobId"));
    if (job.runId !== prm(c, "runId")) throw new HttpError(404, "job not found");
    const out: string[] = [];
    let after = -1;
    for (let i = 0; i < 40; i++) {
      const page = await l.stub.jobLogs(job.id, after);
      for (const ln of page.lines) out.push(`${ln.t} ${ln.text.replace(ANSI, "")}`);
      if (page.lines.length < 5000) break;
      after = page.lines[page.lines.length - 1]!.seq;
    }
    return new Response(`${out.join("\n")}\n`, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(`${job.name}.log`)}`,
        "cache-control": "private, no-store",
      },
    });
  });
}
