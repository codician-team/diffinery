/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { requireAccount, type AppContext, requireRecentSignIn } from "../auth/principal.js";
import { loadRepo } from "../http/common.js";
import { HttpError } from "../lib/util.js";
import { SettingsNav } from "../web/account.js";
import { csrfToken } from "../web/csrf.js";
import { KCheckbox, KRadio, KSelect } from "../web/kumo.js";
import { Form, Markdown, Time, act, post, prm, render, repoUrl, statusOf, type WebApp } from "../web/ui.js";
import { isProvider, ModelKeys, PROVIDERS, type Provider } from "./keys.js";
import type { TaskRow, TaskView } from "./ProjectDO.js";
import { fixGoal } from "./review.js";
import { MAX_ATTEMPTS, MAX_CHECK_FIXES } from "./project.js";
import { formatCost, formatTokens, totalUsage, type RunUsage } from "./usage.js";
import { OPENROUTER_DEFAULT_MODEL, parseRuntimeChoice, runtimeChoices, runtimeLabel, transcriptItem, type TranscriptItem } from "./runtimes.js";
import { approvePlan, compareAttempts, drivableAgents, getTask, pickAttempt, setTaskOptions, type AttemptCompare, mayStop, messageTask, projectStub, requireTaskReader, retryTask, startTask, stopTask, taskNumber } from "./tasks.js";
import { splitPlan } from "./projects.js";
import { runTaskInTerminal, terminalForTask, terminalId } from "./terminals.js";
import { usageReport, type UsageLine, type UsageReport } from "./ledger.js";

/**
 * Web pages for agent tasks: Settings → Model access, and a repository's
 * Tasks tab (list, new task, a task's live transcript with steer, stop and retry).
 */

type Loaded = Awaited<ReturnType<typeof loadRepo>>;

export const TASK_STATE: Record<TaskRow["state"], { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "" },
  running: { label: "Running", tone: "blue" },
  ready: { label: "Ready", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  stopped: { label: "Stopped", tone: "" },
};

const providerNames = Object.fromEntries(Object.values(PROVIDERS).map((p) => [p.id, p.name])) as Record<Provider, string>;

/** The model field for a runtime that goes through OpenRouter (tasks and agent review share it). */
export const OpenRouterModel: FC<{ value?: string | null }> = ({ value }) => (
  <div class="field">
    <label for="model">
      OpenRouter model <span class="faint">(through OpenRouter only)</span>
    </label>
    <input id="model" name="model" type="text" maxlength={200} value={value ?? ""} placeholder={`${OPENROUTER_DEFAULT_MODEL["claude-code"]} for Claude Code, ${OPENROUTER_DEFAULT_MODEL.codex} for Codex`} />
    <div class="hint">
      A model id from <a href="https://openrouter.ai/models" rel="noopener noreferrer" target="_blank">openrouter.ai/models</a>. Left empty, Claude Code uses {OPENROUTER_DEFAULT_MODEL["claude-code"]} and Codex {OPENROUTER_DEFAULT_MODEL.codex}. OpenRouter supports Claude Code fully only on Anthropic models, and Codex on OpenAI ones.
    </div>
  </div>
);

export const TaskBadge: FC<{ state: TaskRow["state"] }> = ({ state }) => <span class={`badge ${TASK_STATE[state].tone}`}>{TASK_STATE[state].label}</span>;

// ---------------------------------------------------------------- usage (phase 5a)

const RUN_KIND: Record<TaskView["runs"][number]["kind"], string> = { start: "Start", message: "Follow-up", retry: "Retry", review: "Review", coordinate: "Coordinate", plan: "Plan", build: "Build", fix: "Fix checks" };

export const UsageCells: FC<{ u: Omit<RunUsage, "source"> | null; subscription?: boolean }> = ({ u, subscription }) =>
  u ? (
    <>
      <td class="r">{u.requests ? u.requests.toLocaleString("en-US") : "—"}</td>
      <td class="r">{formatTokens(u.input)}</td>
      <td class="r">{formatTokens(u.output)}</td>
      <td class="r">
        {formatTokens(u.cacheRead)} / {formatTokens(u.cacheWrite)}
      </td>
      <td class="r">{u.costUsd === null ? "—" : `${formatCost(u.costUsd)}${subscription ? "*" : ""}`}</td>
    </>
  ) : (
    <td colspan={5} class="muted">
      None reported
    </td>
  );

/** A task's model usage, per run and in all: counted by Diffinery's model proxy, or as the CLI in a terminal reported it. */
const UsageBox: FC<{ t: TaskView }> = ({ t }) => {
  const total = totalUsage(t.runs.map((r) => r.usage));
  if (!total) return null;
  const subscription = t.runs.some((r) => r.usage?.source === "runtime" && r.usage.costUsd !== null);
  return (
    <details class="box" id="usage">
      <summary class="head">
        <h2>Usage</h2>
        <span class="badge">
          {formatTokens(total.input + total.output + total.cacheRead + total.cacheWrite)} tokens{total.costUsd !== null ? ` · ${formatCost(total.costUsd)}` : ""}
        </span>
      </summary>
      <div class="body">
        <div class="xscroll">
        <table class="tbl">
          <thead>
            <tr>
              <th>Run</th>
              <th>Counted by</th>
              <th class="r">Requests</th>
              <th class="r">Input</th>
              <th class="r">Output</th>
              <th class="r">Cache read / write</th>
              <th class="r">Cost</th>
            </tr>
          </thead>
          <tbody>
            {t.runs.map((r) => (
              <tr>
                <td>
                  {r.seq} · {RUN_KIND[r.kind]}
                  {r.attempt ? ` · attempt ${r.attempt}` : ""}
                </td>
                <td class="muted">{r.usage ? (r.usage.source === "proxy" ? "Diffinery" : `${runtimeLabel(t.runtime)} in the terminal`) : "—"}</td>
                <UsageCells u={r.usage} subscription={r.usage?.source === "runtime"} />
              </tr>
            ))}
            {t.runs.length > 1 ? (
              <tr>
                <th>Total</th>
                <td />
                <UsageCells u={total} />
              </tr>
            ) : null}
          </tbody>
        </table>
        </div>
        <p class="muted small mt">
          {t.key_owner && t.key_owner !== t.person_id ? "The organization's key paid for this task's model requests. " : ""}Requests through a key are counted by Diffinery from the provider's answers. A run in your terminal is counted by the CLI signed in there. Cost is only ever Claude Code's own figure: Codex and custom commands report none.
          {subscription ? " * At API prices: a subscription covers it." : ""} Your usage across repositories is in <a href="/settings/model-access#usage">Settings → Model access</a>.
        </p>
      </div>
    </details>
  );
};

// ---------------------------------------------------------------- Settings → Model access

const ModelAccessPage = async (c: AppContext) => {
  const me = requireAccount(c);
  const t = csrfToken(c);
  const keys = new Map((await new ModelKeys(c.env).list(me.id)).map((k) => [k.provider, k]));
  const usage = await usageReport(c.env, me.id);
  return render(
    c,
    { title: "Model access" },
    <div class="grid left">
      <SettingsNav me={me} tab="model-access" db={c.env.DB} />
      <div>
        <h1>Model access</h1>
        <p class="muted">
          Agent tasks you start run Claude Code or Codex with your own API key: Anthropic's or OpenAI's, or OpenRouter's to run them on a model you choose there. Diffinery keeps the key encrypted, never shows it again, and never puts it in a sandbox: the agent calls the provider through Diffinery, which adds your key. See <a href="/docs/agents/tasks">Agent tasks</a>.
        </p>
        <div class="flash info">
          Anything an agent runs in its sandbox, including code from the repository and its dependencies, can use your model access while the task runs, and could be tricked into misusing it. Use a <b>dedicated key with a spending limit</b> for Diffinery, and revoke it with the provider if you suspect misuse.
        </div>
        {(Object.keys(PROVIDERS) as Provider[]).map((id) => {
          const p = PROVIDERS[id];
          const k = keys.get(id);
          return (
            <div class="box">
              <div class="head">
                <h2>{p.name}</h2>
                {k ? <span class="badge green">Key saved</span> : <span class="badge">No key</span>}
              </div>
              <div class="body">
                {k ? (
                  <div class="row mb">
                    <div class="grow">
                      <span class="mono">…{k.hint}</span>
                      <span class="muted small">
                        {" "}
                        · added <Time at={k.createdAt} /> · updated <Time at={k.updatedAt} /> · terms accepted <Time at={k.optedInAt} />
                      </span>
                    </div>
                    <Form action={`/settings/model-access/${id}/delete`} t={t} class="inline" confirm={`Delete your ${p.name} key? Running tasks that use it stop getting model access.`}>
                      <button class="btn sm danger">Delete</button>
                    </Form>
                  </div>
                ) : null}
                <Form action={`/settings/model-access/${id}`} t={t}>
                  <div class="field">
                    <label for={`key-${id}`}>{k ? `Replace your ${p.name} API key` : `Your ${p.name} API key`}</label>
                    <input id={`key-${id}`} name="key" type="password" autocomplete="off" required placeholder={id === "anthropic" ? "sk-ant-…" : id === "openrouter" ? "sk-or-…" : "sk-…"} />
                    <div class="hint">
                      Create one at <a href={p.keysUrl} rel="noopener noreferrer" target="_blank">{p.keysUrl.replace("https://", "")}</a>.
                    </div>
                  </div>
                  <div class="field">
                    <KCheckbox
                      name="accept"
                      label={
                        <>
                          I use {p.name} through Diffinery under my own {p.name} account and its terms ({p.terms.map((x, i) => (
                            <>
                              {i ? ", " : ""}
                              <a href={x.url} rel="noopener noreferrer" target="_blank">
                                {x.label}
                              </a>
                            </>
                          ))}
                          ). Usage is billed to my account. Diffinery only provides the ability.
                        </>
                      }
                    />
                  </div>
                  <button class="btn primary">{k ? "Replace key" : "Save key"}</button>
                </Form>
              </div>
            </div>
          );
        })}
        <UsageReportBox report={usage} />
      </div>
    </div>,
  );
};

const USAGE_KIND: Record<UsageLine["kind"], string> = { task: "Tasks", review: "Agent reviews", coordinator: "Coordinator" };

/** Phase 5a: what the person's agents used, per repository and kind, from the agent_usage ledger (ledger.ts). */
const UsageReportBox: FC<{ report: UsageReport }> = ({ report }) => {
  const total = report.lines.reduce(
    (a, l) => ({ runs: a.runs + l.runs, requests: a.requests + l.requests, input: a.input + l.input, output: a.output + l.output, cacheRead: a.cacheRead + l.cacheRead, cacheWrite: a.cacheWrite + l.cacheWrite, costUsd: l.costUsd === null ? a.costUsd : (a.costUsd ?? 0) + l.costUsd }),
    { runs: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null as number | null },
  );
  return (
    <div class="box" id="usage">
      <div class="head">
        <h2>Usage in the last {report.days} days</h2>
        {report.lines.length ? <span class="badge">{formatTokens(total.input + total.output + total.cacheRead + total.cacheWrite)} tokens</span> : null}
      </div>
      <div class="body">
        {report.lines.length ? (
          <div class="xscroll">
            <table class="tbl">
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>For</th>
                  <th class="r">Runs</th>
                  <th class="r">Requests</th>
                  <th class="r">Input</th>
                  <th class="r">Output</th>
                  <th class="r">Cache read / write</th>
                  <th class="r">Cost</th>
                </tr>
              </thead>
              <tbody>
                {report.lines.map((l) => (
                  <tr>
                    <td>{l.repository ? <a href={`/${l.repository}/tasks`}>{l.repository}</a> : <span class="muted">Unknown</span>}</td>
                    <td>{USAGE_KIND[l.kind]}</td>
                    <td class="r">
                      {l.runs}
                      {l.reportedRuns ? <span class="muted"> ({l.reportedRuns} in a terminal)</span> : null}
                    </td>
                    <UsageCells u={l} />
                  </tr>
                ))}
                {report.lines.length > 1 ? (
                  <tr>
                    <th>Total</th>
                    <td />
                    <td class="r">{total.runs}</td>
                    <UsageCells u={total} />
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="muted">None of your agents' runs used a model in the last {report.days} days.</p>
        )}
        <p class="muted small mt">
          Runs you pay for: your tasks and your coordinator's, and agent reviews in repositories where you turned them on. Runs an organization's key paid for are on that organization's Settings tab, for its owners. Repositories are named as they were when the runs ended. Diffinery counts requests through your keys from the provider's answers; runs in your terminal count what the CLI signed in there reported. Cost is only Claude Code's own figure, at API prices; check your provider's console for what you were billed. Also at <code>GET /api/v3/diffinery/model-usage</code>.
        </p>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- repository Tasks tab

async function forTasks(c: AppContext): Promise<Loaded> {
  if (c.get("principal").type !== "account") throw new HttpError(401, "sign in required");
  const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
  requireTaskReader(l);
  return l;
}

const TaskList: FC<{ l: Loaded; tasks: TaskRow[] }> = ({ l, tasks }) => {
  const base = repoUrl(l.repo);
  return tasks.length ? (
    <ul class="list">
      {tasks.map((t) => (
        <li>
          <div class="grow">
            <a href={`${base}/tasks/${t.number}`}>
              <b>{t.title}</b>
            </a>{" "}
            {t.kind === "review" ? <span class="badge purple">Review</span> : t.kind === "coordinator" ? <span class="badge purple">Coordinator</span> : t.coordinator_post ? <span class="badge">From a coordinator</span> : null} <TaskBadge state={t.state} />
            <div class="muted small">
              #{t.number} · {runtimeLabel(t.runtime, t)} as <a href={`/${t.agent_login}`}>{t.agent_login}</a> · started by <a href={`/${t.person_login}`}>{t.person_login}</a> <Time at={t.created_at} />
              {t.pr_number ? (
                <>
                  {" "}
                  · <a href={`${base}/pull/${t.pr_number}`}>#{t.pr_number}</a>
                </>
              ) : null}
            </div>
          </div>
          <span class="muted small">
            <Time at={t.updated_at} />
          </span>
        </li>
      ))}
    </ul>
  ) : (
    <div class="empty">
      No agent tasks yet. Give one of your agents a goal; it works in a sandbox and opens a pull request for review.
    </div>
  );
};

const ItemView: FC<{ item: TranscriptItem; base: string }> = ({ item, base }) => {
  if (item.kind === "text") return <div class="tx-text"><Markdown text={item.body} /></div>;
  if (item.kind === "result")
    return (
      <div class="tx-result">
        <div class="small muted">{item.title}</div>
        {item.body ? <Markdown text={item.body} /> : null}
      </div>
    );
  if (item.kind === "note") return <div class="tx-note muted small">{item.body}</div>;
  if (item.kind === "tool")
    return (
      <details class="tx-tool">
        <summary class="mono small">{item.title}</summary>
        <pre class="tx-pre">{item.body}</pre>
      </details>
    );
  return <pre class={`tx-pre${item.kind === "error" ? " tx-err" : ""}`}>{item.body}</pre>;
};

function taskPage(c: AppContext, l: Loaded, t: TaskView, items: Array<{ run: number; item: TranscriptItem }>, truncated: boolean, canSplit = false, attempts: AttemptCompare[] = [], terminal: string | null = null) {
  const base = repoUrl(l.repo);
  const tk = csrfToken(c);
  const me = requireAccount(c);
  const review = t.kind === "review";
  const starter = me.id === t.person_id && t.kind === "task";
  const running = t.state === "running" || t.state === "queued";
  return render(
    c,
    { title: `${t.title} · Task #${t.number}`, repo: { repo: l.repo, caller: l.caller, tab: "project" }, refresh: running ? 5 : undefined },
    <div>
      <div class="row mb" style="align-items:flex-start">
        <div class="grow">
          <h1 class="m0">
            {t.title} <span class="faint">#{t.number}</span>
          </h1>
          <div class="muted small mt">
            <TaskBadge state={t.state} /> {runtimeLabel(t.runtime, t)} as <a href={`/${t.agent_login}`}>{t.agent_login}</a>, started by <a href={`/${t.person_login}`}>{t.person_login}</a> <Time at={t.created_at} /> · branch <span class="mono">{t.branch}</span> from <span class="mono">{t.base}</span>
            {t.pr_number ? (
              <>
                {" "}
                · pull request <a href={`${base}/pull/${t.pr_number}`}>#{t.pr_number}</a>
              </>
            ) : null}
          </div>
        </div>
        {running && mayStop(l.caller, t) ? (
          <Form action={`${base}/tasks/${t.number}/stop`} t={tk} class="inline" confirm="Stop this task? The agent is stopped and its sandbox closed; work it already pushed stays.">
            <button class="btn sm danger">Stop</button>
          </Form>
        ) : null}
        {!running && starter ? (
          <Form action={`${base}/tasks/${t.number}/retry`} t={tk} class="inline">
            <button class="btn sm">Retry</button>
          </Form>
        ) : null}
        {!running && terminal ? (
          <Form action={`${base}/tasks/${t.number}/terminal`} t={tk} class="inline">
            <input type="hidden" name="terminal" value={terminal} />
            <button class="btn sm" title={`Runs it again in your open terminal, with the ${runtimeLabel(t.runtime, t)} you're signed in to there, on your own subscription.`}>
              Run in my terminal
            </button>
          </Form>
        ) : null}
      </div>
      {t.coordinator_post ? (
        <div class="flash info">
          {t.person_login}'s coordinator started this task while handling <a href={`${base}/project#post-${t.coordinator_post}`}>post #{t.coordinator_post}</a>. It wrote the goal below; each run may use at most {t.token_budget ? `${t.token_budget.toLocaleString("en-US")} tokens` : "its budget"}.
        </div>
      ) : null}
      <div class="box">
        <div class="head">
          <h2>Goal</h2>
        </div>
        <div class="body"><Markdown text={t.goal} /></div>
      </div>
      {t.error ? <div class="flash error">{t.error}</div> : null}
      {t.plan && t.plan_state === "waiting" ? (
        <div class="box" id="plan">
          <div class="head">
            <h2>Plan</h2>
            <span class="badge amber">Waiting for {t.person_login}</span>
          </div>
          <div class="body">
            <Markdown text={t.plan} />
            {starter ? (
              <div class="row mt" style="gap:8px;flex-wrap:wrap">
                <Form action={`${base}/tasks/${t.number}/plan/approve`} t={tk} class="inline">
                  <button class="btn primary">Approve plan</button>
                </Form>
                {canSplit ? (
                  <Form action={`${base}/tasks/${t.number}/plan/split`} t={tk} class="inline" confirm="Hand this plan to your coordinator to split into tasks? This task is then done with.">
                    <button class="btn">Split into tasks</button>
                  </Form>
                ) : (
                  <span class="muted small">
                    <a href={`${base}/project/coordinator`}>Set up your coordinator</a> to split plans into tasks.
                  </span>
                )}
                <span class="muted small">Or ask for changes below.</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : t.plan ? (
        <details class="box">
          <summary class="head">
            <h2>Plan</h2>
            <span class="badge">{t.plan_state === "split" ? "Split into tasks" : t.plan_state === "approved" ? "Approved" : "Being revised"}</span>
          </summary>
          <div class="body">
            <Markdown text={t.plan} />
          </div>
        </details>
      ) : t.plan_state === "planning" ? (
        <div class="flash info">This task plans first: its run reads the code in a read-only sandbox and writes a plan for {t.person_login} to approve, change or split into tasks.</div>
      ) : null}
      {attempts.length ? <Attempts t={t} attempts={attempts} base={base} tk={tk} starter={starter} /> : null}
      {t.parent_task ? (
        <div class="flash info">
          Split from the plan of <a href={`${base}/tasks/${t.parent_task}`}>task #{t.parent_task}</a>.
        </div>
      ) : null}
      {t.kind === "task" ? (
        <Form action={`${base}/tasks/${t.number}/options`} t={tk} class="box" id="options">
          <div class="head">
            <h2>Verify and land</h2>
            {t.check_fixes ? <span class="badge">{t.check_fixes} of {MAX_CHECK_FIXES} fix runs used</span> : null}
          </div>
          <div class="body">
            <KCheckbox name="fix_checks" checked={!!t.fix_checks} disabled={!starter} label={<>Fix failing checks: a fix run starts when the pull request's checks fail on its head (up to {MAX_CHECK_FIXES})</>} />
            <KCheckbox name="land" checked={!!t.land} disabled={!starter} label={<>Land when approved: auto-merge, once a person approves its latest commit and its checks pass</>} />
            {starter ? (
              <button class="btn sm mt">Save</button>
            ) : null}
          </div>
        </Form>
      ) : null}
      <UsageBox t={t} />
      {t.queued ? <div class="flash info">A message is waiting for the current run to end: {t.queued}</div> : null}
      <div class="box">
        <div class="head">
          <h2>Transcript</h2>
          {running ? <span class="badge blue">Live</span> : null}
        </div>
        <div class="body tx">
          {truncated ? (
            <p class="muted small">
              Showing the latest lines. The whole transcript is at <a href={`/api/v3/repos/${l.repo.owner_login}/${l.repo.name}/diffinery/tasks/${t.number}/transcript`}>the API</a>.
            </p>
          ) : null}
          {items.length ? items.map((x, i) => (
            <>
              {i === 0 || items[i - 1]!.run !== x.run ? <h4 class="tx-run">Run {x.run}{t.runs[x.run - 1]?.attempt ? ` · attempt ${t.runs[x.run - 1]!.attempt}` : ""}{t.runs[x.run - 1]?.message ? " · follow-up" : ""}{t.runs[x.run - 1]?.terminal_id ? ` · in ${t.person_login}'s terminal` : ""}</h4> : null}
              <ItemView item={x.item} base={base} />
            </>
          )) : <div class="empty">Starting…</div>}
        </div>
      </div>
      {starter && t.attempts > 1 && (t.pick_state === "running" || t.pick_state === "waiting") ? (
        <p class="muted small">{t.pick_state === "running" ? `Follow-ups open once you've picked one of the ${t.attempts} attempts.` : "Pick an attempt to continue: follow-ups go to the picked attempt's branch."}</p>
      ) : starter ? (
        <Form action={`${base}/tasks/${t.number}/messages`} t={tk} class="box">
          <div class="head">
            <h2>{t.plan_state === "waiting" ? "Ask for changes to the plan" : running ? "Send a follow-up" : "Continue the task"}</h2>
          </div>
          <div class="body">
            <div class="field">
              <textarea name="body" rows={4} required maxlength={20000} placeholder={running ? "It starts a new run on the same branch when this run ends." : "What should the agent do next? It continues on the same branch and pull request."} />
            </div>
            <button class="btn primary">Send</button>
            {!running && terminal ? (
              <>
                {" "}
                <button class="btn" formaction={`${base}/tasks/${t.number}/terminal`} name="terminal" value={terminal} title="Runs it in your open terminal, with the CLI you're signed in to there, on your own subscription.">
                  Send to my terminal
                </button>
              </>
            ) : null}
          </div>
        </Form>
      ) : review ? (
        <p class="muted small">
          Each run is one agent review of <a href={`${base}/pull/${t.pr_number}`}>#{t.pr_number}</a>, using {t.person_login}'s model key. To review again, use Request agent review on the pull request.
        </p>
      ) : t.kind === "coordinator" ? (
        <p class="muted small">
          Each run is {t.person_login}'s coordinator handling posts in the <a href={`${base}/project`}>project conversation</a>, using {t.person_login}'s model key.
        </p>
      ) : (
        <p class="muted small">Only {t.person_login}, who started this task, can steer or retry it: each run spends their own model key.</p>
      )}
    </div>,
  );
}

/** Best of N: the attempts side by side, with Pick. */
const Attempts: FC<{ t: TaskView; attempts: AttemptCompare[]; base: string; tk: string; starter: boolean }> = ({ t, attempts, base, tk, starter }) => {
  const waiting = t.pick_state === "waiting";
  return (
    <div class="box" id="attempts">
      <div class="head">
        <h2>Attempts</h2>
        {waiting ? <span class="badge amber">Pick one</span> : t.pick_state === "picked" ? <span class="badge green">Attempt {t.picked} picked</span> : t.pick_state === "running" ? <span class="badge blue">Running</span> : null}
      </div>
      <div class="body">
        <table class="tbl">
          <thead>
            <tr>
              <th>Attempt</th>
              <th>Changes</th>
              <th>Checks</th>
              <th>Tokens</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((a) => (
              <tr id={`attempt-${a.attempt}`}>
                <td>
                  <strong>Attempt {a.attempt}</strong>
                  <div class="muted small mono">{a.head_sha && t.pick_state !== "picked" ? <a href={`${base}/compare/${t.base}...${a.branch}`}>{a.branch}</a> : a.branch}</div>
                </td>
                <td>{a.head_sha ? <span>{a.files} {a.files === 1 ? "file" : "files"}, <span style="color:var(--green)">+{a.additions}</span> <span style="color:var(--red)">−{a.deletions}</span></span> : <span class="muted">{a.step === "done" ? "No changes" : a.step === "failed" ? `Failed${a.error ? `: ${a.error}` : ""}` : a.step === "stopped" ? "Stopped" : "Running"}</span>}</td>
                <td>{a.head_sha ? <span class={`badge ${a.checks.state === "success" ? "green" : a.checks.state === "failure" ? "red" : a.checks.state === "pending" ? "blue" : ""}`}>{a.checks.state === "none" ? "No checks" : a.checks.state === "success" ? "Passing" : a.checks.state === "failure" ? `Failing: ${a.checks.failing.join(", ")}` : "Running"}</span> : null}</td>
                <td class="muted small">{a.tokens ? `${formatTokens(a.tokens)} (${a.model_calls} ${a.model_calls === 1 ? "request" : "requests"})` : "—"}</td>
                <td>
                  {waiting && starter && a.head_sha && a.step === "done" ? (
                    <Form action={`${base}/tasks/${t.number}/attempts/${a.attempt}/pick`} t={tk} class="inline" confirm={`Pick attempt ${a.attempt}? Its branch becomes the task's branch and opens a pull request; the other attempts' branches are deleted.`}>
                      <button class="btn sm primary">Pick</button>
                    </Form>
                  ) : t.picked === a.attempt ? (
                    <span class="badge green">Picked</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {attempts.map((a) =>
          a.summary ? (
            <details class="mt">
              <summary>What attempt {a.attempt} said last</summary>
              <Markdown text={a.summary} />
            </details>
          ) : null,
        )}
      </div>
    </div>
  );
};

async function newTaskPage(c: AppContext, l: Loaded, error?: string, v: { goal?: string; runtime?: string; agent?: string; base?: string; command?: string; model?: string; pull?: string; plan_first?: string; attempts?: string; fix_checks?: string; land?: string } = {}) {
  const me = requireAccount(c);
  const base = repoUrl(l.repo);
  const tk = csrfToken(c);
  const [agents, keys, branches, settings] = await Promise.all([drivableAgents(c, me, l), new ModelKeys(c.env).providers(me.id), l.stub.refs("refs/heads/"), projectStub(c.env, l.repo.id).projectSettings()]);
  const runtimes = runtimeChoices(keys, providerNames);
  const firstUsable = runtimes.find((r) => !r.disabled)?.value ?? "custom";
  return render(
    c,
    { title: "New agent task", repo: { repo: l.repo, caller: l.caller, tab: "project" }, status: error ? 422 : undefined },
    <div style="max-width:780px">
      <h1>New agent task</h1>
      {v.pull ? (
        <p class="muted">
          The agent works in a fresh sandbox on the branch of pull request <a href={`${base}/pull/${v.pull}`}>#{v.pull}</a> and pushes its fix there as itself, under that branch's protection rules. The model calls use <a href="/settings/model-access">your own key</a>.
        </p>
      ) : (
        <p class="muted">
          The agent works in a fresh sandbox with this repository checked out, pushes to a new branch as itself and opens a pull request, which needs a person's approval like any agent pull request. The model calls use <a href="/settings/model-access">your own key</a>.
        </p>
      )}
      {error ? <div class="flash error">{error}</div> : null}
      {!agents.length ? (
        <div class="flash info">
          You don't have an agent with write access here yet. <a href="/settings/agents">Create an agent</a>, then give it write access to this repository (or let it inherit yours).
        </div>
      ) : null}
      <Form action={`${base}/tasks`} t={tk} class="box">
        <div class="body">
          <div class="field">
            <label for="goal">Goal</label>
            <textarea id="goal" name="goal" rows={8} required maxlength={20000} placeholder="Fix the Contact sales link on the pricing page so it goes to /contact, and add a test.">
              {v.goal ?? ""}
            </textarea>
            <div class="hint">What you want done, as you would ask a colleague. Markdown works.</div>
          </div>
          <div class="field">
            <label>Runtime</label>
            <KRadio name="runtime" label="Runtime" value={v.runtime ?? firstUsable} items={runtimes} />
          </div>
          <OpenRouterModel value={v.model} />
          <div class="field">
            <label for="command">
              Command <span class="faint">(custom runtime only)</span>
            </label>
            <input id="command" name="command" type="text" maxlength={2000} value={v.command ?? ""} placeholder='aider --yes --message "$DIFFINERY_TASK_PROMPT"' />
            <div class="hint">Runs in the repository with the goal in $DIFFINERY_TASK_PROMPT, and ANTHROPIC_BASE_URL, OPENAI_BASE_URL or OPENROUTER_BASE_URL (with the matching _API_KEY) set for the providers you have keys for.</div>
          </div>
          <div class="row" style="align-items:flex-start">
            <div class="field grow">
              <label for="agent">Agent</label>
              <KSelect id="agent" name="agent" block label="Agent" value={v.agent ?? agents[0]?.login} options={agents.map((a) => ({ value: a.login, label: a.name ? `${a.login} (${a.name})` : a.login }))} placeholder="Choose an agent" />
            </div>
            {v.pull ? (
              <input type="hidden" name="pull" value={v.pull} />
            ) : (
              <div class="field grow">
                <label for="base">Base branch</label>
                <KSelect id="base" name="base" block label="Base branch" value={v.base ?? l.repo.default_branch} options={branches.slice(0, 500).map((b) => ({ value: b.name.slice("refs/heads/".length), label: b.name.slice("refs/heads/".length) }))} />
              </div>
            )}
          </div>
          <div class="field">
            <KCheckbox
              name="plan_first"
              checked={settings.planFirst === "required" || (v.plan_first ?? (settings.planFirst === "default" ? "1" : "")) === "1"}
              disabled={settings.planFirst === "required"}
              label={<>Plan first: the agent reads the code and writes a plan in a read-only sandbox; it builds once you approve the plan{settings.planFirst === "required" ? " (this project requires it)" : ""}</>}
            />
          </div>
          {v.pull ? null : (
            <div class="field" style="max-width:320px">
              <label for="attempts">Attempts</label>
              <KSelect id="attempts" name="attempts" block label="Attempts" value={v.attempts ?? "1"} options={Array.from({ length: MAX_ATTEMPTS }, (_, i) => ({ value: String(i + 1), label: i === 0 ? "1 attempt" : `${i + 1} attempts, then pick the best` }))} />
              <p class="muted small">Each attempt runs in its own sandbox on its own branch, at the same time, and counts toward the project's limit. Each spends your model key.</p>
            </div>
          )}
          <div class="field">
            <KCheckbox name="fix_checks" checked={(v.fix_checks ?? (v.pull ? "" : "1")) === "1"} label={<>Fix failing checks: when its pull request's checks fail, the agent gets their logs and fixes them (up to {MAX_CHECK_FIXES} runs)</>} />
          </div>
          <div class="field">
            <KCheckbox name="land" checked={v.land === "1"} label={<>Land when approved: turn on auto-merge, so the pull request merges once a person approves it and its checks pass</>} />
          </div>
          <button class="btn primary" disabled={!agents.length}>
            Start task
          </button>
        </div>
      </Form>
    </div>,
  );
}

export function registerTasks(web: WebApp): void {
  web.get("/settings/model-access", (c) => ModelAccessPage(c));

  post(web, "/settings/model-access/:provider", async (c, f) => {
    const me = requireAccount(c);
    const provider = prm(c, "provider");
    if (!isProvider(provider)) throw new HttpError(404, "not found");
    // Another key would send this person's later prompts and code to its account: a recent sign-in, as for organizations' keys.
    requireRecentSignIn(c, "/settings/model-access");
    return act(
      c,
      "/settings/model-access",
      async () => {
        const k = await new ModelKeys(c.env).set(me, provider, f.s("key"), f.all("accept").length > 0);
        c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "model_key.set", target: provider, detail: { hint: k.hint, opted_in_at: k.optedInAt } }));
      },
      `${PROVIDERS[provider].name} key saved.`,
    );
  });

  post(web, "/settings/model-access/:provider/delete", async (c) => {
    const me = requireAccount(c);
    const provider = prm(c, "provider");
    if (!isProvider(provider)) throw new HttpError(404, "not found");
    return act(
      c,
      "/settings/model-access",
      async () => {
        await new ModelKeys(c.env).delete(me.id, provider);
        c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "model_key.delete", target: provider }));
      },
      `${PROVIDERS[provider].name} key deleted.`,
    );
  });

  web.get("/:owner/:repo/tasks", async (c) => {
    const l = await forTasks(c);
    const tasks = await projectStub(c.env, l.repo.id).list({ limit: 100 });
    return render(
      c,
      { title: `Tasks · ${l.repo.owner_login}/${l.repo.name}`, repo: { repo: l.repo, caller: l.caller, tab: "project" }, refresh: tasks.some((t) => t.state === "running" || t.state === "queued") ? 10 : undefined },
      <div>
        <div class="row mb">
          <h1 class="grow m0">Agent tasks</h1>
          <a class="btn" href={`${repoUrl(l.repo)}/terminals`}>
            Terminals
          </a>
          {l.repo.archived ? null : (
            <a class="btn primary" href={`${repoUrl(l.repo)}/tasks/new`}>
              New task
            </a>
          )}
        </div>
        <div class="box">
          <TaskList l={l} tasks={tasks} />
        </div>
      </div>,
    );
  });

  web.get("/:owner/:repo/tasks/new", async (c) => {
    const l = await forTasks(c);
    // Fix it on an agent review finding: work on that pull request's branch, with the finding as the goal.
    const pull = c.req.query("pull");
    // "Start a task" on a project post: the post is the goal.
    const fromPost = c.req.query("post");
    if (fromPost && /^\d{1,9}$/.test(fromPost)) {
      const [p] = await projectStub(c.env, l.repo.id).posts(Number(fromPost) - 1, 1);
      return newTaskPage(c, l, undefined, p && p.n === Number(fromPost) && p.kind === "person" ? { goal: p.body } : {});
    }
    if (!pull || !/^\d{1,9}$/.test(pull)) return newTaskPage(c, l);
    const f = c.req.query("finding") ? await projectStub(c.env, l.repo.id).finding(c.req.query("finding")!) : null;
    const goal = f && f.pr === Number(pull) ? fixGoal(f.pr, [f]) : `Work on pull request #${pull}: `;
    return newTaskPage(c, l, undefined, { pull, goal });
  });

  post(web, "/:owner/:repo/tasks", async (c, f) => {
    const l = await forTasks(c);
    const v = { goal: f.s("goal"), runtime: f.s("runtime") || "claude-code", agent: f.s("agent"), base: f.s("base"), command: f.s("command"), model: f.s("model"), pull: f.s("pull") || undefined, plan_first: f.all("plan_first").length ? "1" : "", attempts: f.s("attempts") || "1", fix_checks: f.all("fix_checks").length ? "1" : "", land: f.all("land").length ? "1" : "" };
    try {
      const { runtime, provider } = parseRuntimeChoice(v.runtime);
      const t = await startTask(c, l, { ...v, runtime, provider, model: provider ? v.model : undefined, plan_first: v.plan_first === "1", fix_checks: v.fix_checks === "1", land: v.land === "1" });
      return c.redirect(`${repoUrl(l.repo)}/tasks/${t.number}`, 303);
    } catch (e) {
      const st = statusOf(e);
      if (st.status >= 500) throw e;
      return newTaskPage(c, l, st.message, v);
    }
  });

  web.get("/:owner/:repo/tasks/:number", async (c) => {
    const l = await forTasks(c);
    const n = taskNumber(c.req.param("number"));
    const t = await getTask(c, l, n);
    const stub = projectStub(c.env, l.repo.id);
    // The latest lines: page backwards from the end would need an index; fetch the head and keep the tail.
    const lines = await stub.lines(n, 0, 5000);
    const tail = lines.slice(-1500);
    const items = tail.flatMap((line) => transcriptItem(line).map((item) => ({ run: line.run, item })));
    const canSplit = t.plan_state === "waiting" && !!(await stub.coordinator(requireAccount(c).id));
    const attempts = t.attempts > 1 ? await compareAttempts(c, l, n) : [];
    const terminal = await terminalForTask(c.env, requireAccount(c), l.repo, t).catch(() => null);
    return taskPage(c, l, t, items, lines.length > tail.length, canSplit, attempts, terminal);
  });

  post(web, "/:owner/:repo/tasks/:number/messages", async (c, f) => {
    const l = await forTasks(c);
    const n = taskNumber(c.req.param("number"));
    return act(c, `${repoUrl(l.repo)}/tasks/${n}`, async () => {
      await messageTask(c, l, n, f.s("body"));
    });
  });

  post(web, "/:owner/:repo/tasks/:number/options", async (c, f) => {
    const l = await forTasks(c);
    const n = taskNumber(c.req.param("number"));
    return act(c, `${repoUrl(l.repo)}/tasks/${n}`, async () => {
      await setTaskOptions(c, l, n, { fix_checks: f.all("fix_checks").length > 0, land: f.all("land").length > 0 });
    }, "Saved.");
  });

  post(web, "/:owner/:repo/tasks/:number/attempts/:attempt/pick", async (c) => {
    const l = await forTasks(c);
    const n = taskNumber(c.req.param("number"));
    const k = Number(prm(c, "attempt"));
    return act(c, `${repoUrl(l.repo)}/tasks/${n}`, async () => {
      await pickAttempt(c, l, n, k);
    }, `Attempt ${k} picked.`);
  });

  post(web, "/:owner/:repo/tasks/:number/plan/approve", async (c) => {
    const l = await forTasks(c);
    const n = taskNumber(c.req.param("number"));
    return act(c, `${repoUrl(l.repo)}/tasks/${n}`, async () => {
      await approvePlan(c, l, n);
    }, "Plan approved: building it.");
  });

  post(web, "/:owner/:repo/tasks/:number/plan/split", async (c) => {
    const l = await forTasks(c);
    const n = taskNumber(c.req.param("number"));
    return act(c, `${repoUrl(l.repo)}/tasks/${n}`, async () => {
      const out = await splitPlan(c, l, n);
      return `${repoUrl(l.repo)}/project#post-${out.post}`;
    }, "Your coordinator is splitting the plan into tasks.");
  });

  post(web, "/:owner/:repo/tasks/:number/retry", async (c) => {
    const l = await forTasks(c);
    const n = taskNumber(c.req.param("number"));
    return act(c, `${repoUrl(l.repo)}/tasks/${n}`, async () => {
      await retryTask(c, l, n);
    }, "Retrying.");
  });

  // Phase 4b: only the person's own click here runs a task in their terminal (with the follow-up, if they wrote one).
  post(web, "/:owner/:repo/tasks/:number/terminal", async (c, f) => {
    const l = await forTasks(c);
    const n = taskNumber(c.req.param("number"));
    return act(c, `${repoUrl(l.repo)}/tasks/${n}`, async () => {
      await runTaskInTerminal(c, l, n, terminalId(f.s("terminal")), f.s("body"));
    }, "Running in your terminal.");
  });

  post(web, "/:owner/:repo/tasks/:number/stop", async (c) => {
    const l = await forTasks(c);
    const n = taskNumber(c.req.param("number"));
    return act(c, `${repoUrl(l.repo)}/tasks/${n}`, async () => {
      await stopTask(c, l, n);
    }, "Task stopped.");
  });
}
