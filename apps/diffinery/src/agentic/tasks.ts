import { requireAccount, type AppContext } from "../auth/principal.js";
import type { DiffineryEvent } from "@diffinery/shared";
import type { Env } from "../env.js";
import type { loadRepo } from "../http/common.js";
import type { Account, Directory } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { atLeast, type Caller } from "../repo/types.js";
import { mayDriveAgent, taskCaller, TaskAccessError } from "./access.js";
import { isProvider, type Provider } from "./keys.js";
import { payerFor } from "./org-policy.js";
import type { AttemptView, TaskRow, TaskView } from "./ProjectDO.js";
import { MAX_ATTEMPTS } from "./project.js";
import { checksState, type ChecksState } from "./today-repo.js";
import { isRuntime, MAX_COMMAND, MAX_GOAL, OPENROUTER_DEFAULT_MODEL, OPENROUTER_MODEL, RUNTIMES, runtimeLabel, runtimeNeeds, type ModelRoute, type RuntimeId, type TranscriptLine } from "./runtimes.js";
import { totalUsage, usageJson } from "./usage.js";

/**
 * Who may do what with agent tasks. Shared by the REST API, MCP and the web.
 *
 * - Reading tasks and transcripts: write access to the repository or more.
 * - Starting, sending a message and retrying: only a person, in a browser
 *   session (each run spends their model key), and for an existing task only
 *   the person who started it. No token, agent, job or sandbox can.
 * - Stopping: the person who started it, its agent, or a repository admin.
 */

type Loaded = Awaited<ReturnType<typeof loadRepo>>;

export const projectStub = (env: Env, repoId: string) => env.PROJECT.get(env.PROJECT.idFromName(repoId));

/** Tasks are visible with write access or more: transcripts show an agent's reasoning and command output. */
export function requireTaskReader(l: Loaded): void {
  if (!atLeast(l.caller.role, "write")) throw new HttpError(404, "not found");
}

/** A person signed in in a browser (or the local dev sign-in): the only one who can spend their model key. */
export function requirePersonSession(c: AppContext): Account {
  const p = c.get("principal");
  if (p.type === "anonymous") throw new HttpError(401, "sign in required");
  if (p.type !== "account" || (p.via !== "session" && p.via !== "dev")) throw new HttpError(403, "starting or steering an agent task needs a browser session: each run spends your own model key, so no token can do it");
  const me = requireAccount(c);
  if (me.kind !== "user") throw new HttpError(403, "only people can start agent tasks");
  return me;
}

export function taskNumber(s: string | undefined): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, "task not found");
  return n;
}

export async function getTask(c: AppContext, l: Loaded, number: number): Promise<TaskView> {
  requireTaskReader(l);
  const t = await projectStub(c.env, l.repo.id).get(number);
  if (!t) throw new HttpError(404, "task not found");
  return t;
}

/**
 * The providers a run of `task` gets, and that whose key paid for it at its start (org-policy.ts) still may: a
 * message, retry or plan approval keeps the task's key owner.
 */
export async function taskProviders(c: AppContext, l: Loaded, person: Account, task: TaskRow): Promise<Provider[]> {
  return (await payerFor(c.env, c.get("dir"), l.repo, person, task.runtime, task.via, task.key_owner ?? task.person_id)).providers;
}

/**
 * Where a runtime's model calls go: `provider` is its own (the default) or
 * OpenRouter, which takes a `model` (a default one when none is given).
 */
export function modelRoute(runtime: RuntimeId, provider: unknown, model: unknown): ModelRoute {
  const own = RUNTIMES[runtime].needs[0];
  if (provider === undefined || provider === null || provider === "" || provider === own) {
    if (model !== undefined && model !== null && model !== "") throw new HttpError(422, "`model` is only for OpenRouter: set `provider` to openrouter");
    return { via: null, model: null };
  }
  if (typeof provider !== "string" || !isProvider(provider) || !RUNTIMES[runtime].alternatives.includes(provider)) {
    const ok = [own, ...RUNTIMES[runtime].alternatives].filter(Boolean);
    throw new HttpError(422, ok.length ? `\`provider\` for ${RUNTIMES[runtime].name} must be ${ok.join(" or ")}` : `${RUNTIMES[runtime].name} gets every provider you have a key for: leave \`provider\` out`);
  }
  const m = typeof model === "string" && model.trim() ? model.trim() : (OPENROUTER_DEFAULT_MODEL[runtime] ?? "");
  if (!OPENROUTER_MODEL.test(m)) throw new HttpError(422, "`model` must be an OpenRouter model id, such as anthropic/claude-sonnet-4.5");
  return { via: provider, model: m };
}

async function asTaskCaller(c: AppContext, person: Account, agent: Account, l: Loaded): Promise<Caller> {
  try {
    return await taskCaller(c.get("dir"), person, agent, l.repo);
  } catch (e) {
    if (e instanceof TaskAccessError) throw new HttpError(403, e.message);
    throw e;
  }
}

export interface StartInput {
  goal?: unknown;
  runtime?: unknown;
  agent?: unknown;
  base?: unknown;
  command?: unknown;
  /** The runtime's own provider (the default) or `openrouter`, with `model`. */
  provider?: unknown;
  model?: unknown;
  /** Work on this pull request's branch (Fix it) instead of a new branch. */
  pull?: unknown;
  /** Plan first: true or false; left out, the project's default. A project can require it. */
  plan_first?: unknown;
  /** Best of N: run the first build as 1 to 4 attempts, then pick one. */
  attempts?: unknown;
  /** Verify: start a fix run when the pull request's checks fail (default on, except on someone's pull request). */
  fix_checks?: unknown;
  /** Land when approved: turn on auto-merge for its pull request (default off). */
  land?: unknown;
}

export async function startTask(c: AppContext, l: Loaded, input: StartInput): Promise<TaskView> {
  const person = requirePersonSession(c);
  if (l.repo.archived) throw new HttpError(403, "repository is archived (read-only)");
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (!goal) throw new HttpError(422, "`goal` is required");
  if (goal.length > MAX_GOAL) throw new HttpError(422, `\`goal\` is longer than ${MAX_GOAL} characters`);
  const runtime = typeof input.runtime === "string" ? input.runtime : "claude-code";
  if (!isRuntime(runtime)) throw new HttpError(422, "`runtime` must be claude-code, codex or custom");
  const command = runtime === "custom" ? (typeof input.command === "string" ? input.command.trim() : "") : null;
  if (runtime === "custom" && !command) throw new HttpError(422, "`command` is required for the custom runtime");
  if (command && command.length > MAX_COMMAND) throw new HttpError(422, `\`command\` is longer than ${MAX_COMMAND} characters`);
  const route = modelRoute(runtime, input.provider, input.model);
  const agentLogin = typeof input.agent === "string" ? input.agent.trim() : "";
  const agent = agentLogin ? await c.get("dir").accountByLogin(agentLogin) : null;
  if (!agent || agent.kind !== "agent") throw new HttpError(422, "`agent` must be the login of one of your agents");
  await asTaskCaller(c, person, agent, l);
  let base = typeof input.base === "string" && input.base.trim() ? input.base.trim() : l.repo.default_branch;
  let pull: { number: number; head: string } | undefined;
  if (input.pull !== undefined && input.pull !== null && input.pull !== "") {
    const n = Number(input.pull);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(422, "`pull` must be a pull request number");
    const { issue } = await l.stub.issue(n).catch(() => ({ issue: null }));
    if (!issue?.pull) throw new HttpError(422, `#${n} isn't a pull request`);
    if (issue.state !== "open") throw new HttpError(422, `#${n} is closed`);
    if (!(await l.stub.getRef(`refs/heads/${issue.pull.head}`))) throw new HttpError(422, `#${n}'s branch ${issue.pull.head} isn't in this repository`);
    pull = { number: n, head: issue.pull.head };
    base = issue.pull.base;
  }
  if (!(await l.stub.getRef(`refs/heads/${base}`))) throw new HttpError(422, `branch ${base} doesn't exist`);
  if (input.plan_first !== undefined && typeof input.plan_first !== "boolean") throw new HttpError(422, "`plan_first` must be true or false");
  const attempts = input.attempts === undefined || input.attempts === null || input.attempts === "" ? 1 : Number(input.attempts);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) throw new HttpError(422, `\`attempts\` must be a whole number from 1 to ${MAX_ATTEMPTS}`);
  if (attempts > 1 && pull) throw new HttpError(422, "a task on a pull request's branch runs one attempt");
  for (const k of ["fix_checks", "land"] as const) if (input[k] !== undefined && typeof input[k] !== "boolean") throw new HttpError(422, `\`${k}\` must be true or false`);
  const fixChecks = input.fix_checks === undefined ? !pull : input.fix_checks === true;
  const land = input.land === true;
  const { providers, keyOwner, orgMaxRunning } = await payerFor(c.env, c.get("dir"), l.repo, person, runtime, route.via);
  const project = projectStub(c.env, l.repo.id);
  const { planFirst: policy } = await project.projectSettings();
  const planFirst = policy === "required" || (input.plan_first === undefined ? policy === "default" : input.plan_first === true);
  const t = await project.create({ repoId: l.repo.id, goal, runtime, command, route, agent: { id: agent.id, login: agent.login }, person: { id: person.id, login: person.login }, base, providers, pull, planFirst, attempts, fixChecks, land, keyOwner, orgMaxRunning });
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: person.id, actorLogin: person.login, action: "task.start", target: `${l.repo.owner_login}/${l.repo.name}#${t.number}`, detail: { agent: agent.login, runtime, ...(keyOwner !== person.id ? { paid_by: l.repo.owner_login } : {}), ...(route.via ? { provider: route.via, model: route.model } : {}), ...(planFirst ? { plan_first: true } : {}), ...(attempts > 1 ? { attempts } : {}), fix_checks: fixChecks, land } }));
  return t;
}

/** The person who started the task, in a browser session, still allowed to drive its agent here. */
export async function starter(c: AppContext, l: Loaded, number: number): Promise<{ person: Account; task: TaskView }> {
  const person = requirePersonSession(c);
  const task = await getTask(c, l, number);
  if (task.kind === "review") throw new HttpError(409, "an agent review takes no messages and isn't retried: ask for a new review on its pull request");
  if (task.kind === "coordinator") throw new HttpError(409, "a coordinator takes no messages and isn't retried: post in the project instead");
  if (task.person_id !== person.id) throw new HttpError(403, `only ${task.person_login}, who started this task, can steer or retry it: each run spends their model key`);
  if (l.repo.archived) throw new HttpError(403, "repository is archived (read-only)");
  const agent = await c.get("dir").account(task.agent_id);
  if (!agent) throw new HttpError(403, "the task's agent no longer exists");
  await asTaskCaller(c, person, agent, l);
  return { person, task };
}

export async function messageTask(c: AppContext, l: Loaded, number: number, text: unknown): Promise<TaskView> {
  const body = typeof text === "string" ? text.trim() : "";
  if (!body) throw new HttpError(422, "`body` is required");
  if (body.length > MAX_GOAL) throw new HttpError(422, `\`body\` is longer than ${MAX_GOAL} characters`);
  const { person, task } = await starter(c, l, number);
  const t = await projectStub(c.env, l.repo.id).message(number, body, await taskProviders(c, l, person, task));
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: person.id, actorLogin: person.login, action: "task.message", target: `${l.repo.owner_login}/${l.repo.name}#${number}` }));
  return t;
}

/** Verify and land: change a task's options (the person who started it, in a browser). */
export async function setTaskOptions(c: AppContext, l: Loaded, number: number, input: { fix_checks?: unknown; land?: unknown }): Promise<TaskView> {
  const { person } = await starter(c, l, number);
  const o: { fixChecks?: boolean; land?: boolean } = {};
  for (const [k, to] of [["fix_checks", "fixChecks"], ["land", "land"]] as const) {
    const v = input[k];
    if (v === undefined) continue;
    if (typeof v !== "boolean") throw new HttpError(422, `\`${k}\` must be true or false`);
    o[to] = v;
  }
  const t = await projectStub(c.env, l.repo.id).setOptions(number, o, person.login);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: person.id, actorLogin: person.login, action: "task.options", target: `${l.repo.owner_login}/${l.repo.name}#${number}`, detail: { fix_checks: !!t.fix_checks, land: !!t.land } }));
  return t;
}

/**
 * Verify (phase 3e): a workflow run or a commit status finished. If the repository has agent tasks with a pull
 * request, its project checks whether any of them should start a fix run. Called from the event queue, best effort.
 */
export async function onVerifyEvent(env: Env, ev: DiffineryEvent): Promise<void> {
  if (!((ev.type === "workflow_run" && ev.action === "completed") || ev.type === "status")) return;
  const any = await env.DB.prepare("SELECT 1 FROM agent_tasks WHERE repo_id = ? AND state = 'ready' AND pr_number IS NOT NULL LIMIT 1").bind(ev.repoId).first();
  if (!any) return;
  await projectStub(env, ev.repoId).verify();
}

/** Best of N: pick one of a task's attempts, which becomes its branch and pull request. */
export async function pickAttempt(c: AppContext, l: Loaded, number: number, attempt: number): Promise<TaskView> {
  const { person } = await starter(c, l, number);
  const t = await projectStub(c.env, l.repo.id).pick(number, attempt, person.login);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: person.id, actorLogin: person.login, action: "task.pick", target: `${l.repo.owner_login}/${l.repo.name}#${number}`, detail: { attempt } }));
  return t;
}

/** One attempt as the comparison shows it: what it changed, its checks, what it cost, what it said. */
export interface AttemptCompare extends AttemptView {
  files: number;
  additions: number;
  deletions: number;
  checks: { state: ChecksState; failing: string[] };
}

export async function compareAttempts(c: AppContext, l: Loaded, number: number): Promise<AttemptCompare[]> {
  const list = await projectStub(c.env, l.repo.id).attempts(number);
  return Promise.all(
    list.map(async (a) => {
      if (!a.head_sha) return { ...a, files: 0, additions: 0, deletions: 0, checks: { state: "none" as ChecksState, failing: [] } };
      const [d, checks] = await Promise.all([l.stub.diff(a.start_sha, a.head_sha, { patch: false }).catch(() => null), l.stub.checksAndStatuses(a.head_sha).catch(() => [])]);
      return { ...a, files: d?.totalFiles ?? 0, additions: d?.additions ?? 0, deletions: d?.deletions ?? 0, checks: checksState(checks) };
    }),
  );
}

export const attemptJson = (base: string, repoFull: string, a: AttemptCompare) => ({
  attempt: a.attempt,
  run: a.run,
  state: a.step,
  error: a.error,
  branch: a.branch,
  head_sha: a.head_sha,
  changes: { files: a.files, additions: a.additions, deletions: a.deletions },
  checks: a.checks.state,
  failing_checks: a.checks.failing,
  model_requests: a.model_calls,
  tokens: a.tokens,
  summary: a.summary,
  ...(a.head_sha ? { compare_url: `${base}/${repoFull}/compare/${a.start_sha ?? ""}...${a.branch}` } : {}),
});

/** Approve a task's waiting plan: its build run starts. */
export async function approvePlan(c: AppContext, l: Loaded, number: number): Promise<TaskView> {
  const { person, task } = await starter(c, l, number);
  const t = await projectStub(c.env, l.repo.id).approvePlan(number, await taskProviders(c, l, person, task), person.login);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: person.id, actorLogin: person.login, action: "task.plan_approve", target: `${l.repo.owner_login}/${l.repo.name}#${number}` }));
  return t;
}

export async function retryTask(c: AppContext, l: Loaded, number: number): Promise<TaskView> {
  const { person, task } = await starter(c, l, number);
  const t = await projectStub(c.env, l.repo.id).retry(number, await taskProviders(c, l, person, task));
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: person.id, actorLogin: person.login, action: "task.retry", target: `${l.repo.owner_login}/${l.repo.name}#${number}` }));
  return t;
}

/** Whether `caller` can stop the task: its person, its agent, or a repository admin. */
export const mayStop = (caller: Caller, t: TaskRow) => caller.id === t.person_id || caller.id === t.agent_id || atLeast(caller.role, "admin");

export async function stopTask(c: AppContext, l: Loaded, number: number): Promise<TaskView> {
  const task = await getTask(c, l, number);
  if (!mayStop(l.caller, task)) throw new HttpError(403, "only the person who started the task, its agent or a repository admin can stop it");
  const t = await projectStub(c.env, l.repo.id).stop(number, l.caller.login);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: l.caller.id, actorLogin: l.caller.login, onBehalfOf: l.caller.onBehalfOf, action: "task.stop", target: `${l.repo.owner_login}/${l.repo.name}#${number}` }));
  return t;
}

/** Agents a person can run tasks as, here: ones they manage that have write access to the repository. */
export async function drivableAgents(c: AppContext, person: Account, l: Loaded): Promise<Account[]> {
  const dir = c.get("dir");
  const orgs = (await dir.orgsFor(person.id)).filter((o) => o.role === "owner" || o.role === "admin").map((o) => o.id);
  const agents = await dir.agentsOwnedBy([person.id, ...orgs]);
  const out: Account[] = [];
  for (const a of agents) {
    if (!(await mayDriveAgent(dir, person, a))) continue;
    if (atLeast(await dir.roleFor(a, l.repo), "write")) out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------- JSON

export function taskJson(base: string, repoFull: string, t: TaskRow | TaskView) {
  return {
    number: t.number,
    kind: t.kind,
    title: t.title,
    goal: t.goal,
    state: t.state,
    runtime: t.runtime,
    ...(t.command ? { command: t.command } : {}),
    provider: t.via ?? RUNTIMES[t.runtime].needs[0] ?? null,
    model: t.model ?? null,
    agent: { login: t.agent_login, type: "Bot" },
    started_by: { login: t.person_login, type: "User" },
    // Phase 5b: whose key pays, fixed when the task started: the person's own, or the organization's.
    paid_by: t.key_owner && t.key_owner !== t.person_id ? "organization" : "person",
    plan_first: !!t.plan_first,
    ...(t.plan_first ? { plan_state: t.plan_state, plan: t.plan } : {}),
    ...(t.parent_task ? { parent_task: t.parent_task } : {}),
    attempts: t.attempts ?? 1,
    ...((t.attempts ?? 1) > 1 ? { pick_state: t.pick_state, picked_attempt: t.picked } : {}),
    fix_checks: !!t.fix_checks,
    check_fixes: t.check_fixes ?? 0,
    land: !!t.land,
    // Security 3b: a task a coordinator started says so, with the post it came from.
    ...(t.coordinator_post ? { started_via: { type: "coordinator", post: t.coordinator_post }, token_budget: t.token_budget, waits_for: t.after_tasks ? (JSON.parse(t.after_tasks) as number[]) : [] } : {}),
    base: t.base,
    branch: t.branch,
    pull_request: t.pr_number ? { number: t.pr_number, html_url: `${base}/${repoFull}/pull/${t.pr_number}` } : null,
    queued_message: t.queued ?? null,
    error: t.error,
    html_url: `${base}/${repoFull}/tasks/${t.number}`,
    created_at: t.created_at,
    updated_at: t.updated_at,
    ...("runs" in t ? { usage: usageOrNull(totalUsage(t.runs.map((r) => r.usage))), runs: t.runs.map((r) => ({ number: r.seq, kind: r.kind, message: r.message, state: r.step, exit_code: r.exit_code, error: r.error, model_requests: r.model_calls ?? 0, tokens: r.tokens ?? 0, usage: usageOrNull(r.usage), ...(r.attempt ? { attempt: r.attempt } : {}), ...(r.terminal_id ? { in_terminal: true } : {}), started_at: r.started_at, ended_at: r.ended_at })) } : {}),
  };
}

const usageOrNull = (u: Parameters<typeof usageJson>[0] | null) => (u ? usageJson(u) : null);

export const lineJson = (l: TranscriptLine) => ({ seq: l.seq, run: l.run, at: l.at, stream: l.stream, text: l.text });

export interface MyTask {
  repository: string;
  repoId: string;
  number: number;
  title: string;
  runtime: RuntimeId;
  state: TaskRow["state"];
  agent: string;
  prNumber: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Tasks a person started (or, for an agent, tasks it runs), newest activity
 * first, from the D1 index, in repositories where they still have write access.
 */
export async function tasksFor(env: Env, dir: Directory, me: Account, opts: { repoIds?: string[] | null; since?: string; activeOrSince?: boolean; limit?: number } = {}): Promise<MyTask[]> {
  const col = me.kind === "agent" ? "t.agent_id" : "t.started_by";
  const since = opts.since ?? "";
  const r = await env.DB.prepare(
    `SELECT t.repo_id, t.number, t.title, t.runtime, t.state, t.pr_number, t.created_at, t.updated_at, o.login AS owner_login, r.name AS repo_name, ag.login AS agent_login
     FROM agent_tasks t JOIN repos r ON r.id = t.repo_id JOIN accounts o ON o.id = r.owner_id JOIN accounts ag ON ag.id = t.agent_id
     WHERE ${col} = ? AND (t.updated_at >= ?${opts.activeOrSince ? " OR t.state IN ('running', 'queued')" : ""}) ORDER BY t.updated_at DESC LIMIT ?`,
  )
    .bind(me.id, since, Math.min(opts.limit ?? 50, 100))
    .all<{ repo_id: string; number: number; title: string; runtime: RuntimeId; state: TaskRow["state"]; pr_number: number | null; created_at: string; updated_at: string; owner_login: string; repo_name: string; agent_login: string }>();
  const allowed = new Map<string, boolean>();
  const out: MyTask[] = [];
  for (const t of r.results) {
    if (opts.repoIds && !opts.repoIds.includes(t.repo_id)) continue;
    if (!allowed.has(t.repo_id)) {
      const repo = await dir.repoById(t.repo_id);
      allowed.set(t.repo_id, !!repo && atLeast(await dir.roleFor(me, repo), "write"));
    }
    if (!allowed.get(t.repo_id)) continue;
    out.push({ repository: `${t.owner_login}/${t.repo_name}`, repoId: t.repo_id, number: t.number, title: t.title, runtime: t.runtime, state: t.state, agent: t.agent_login, prNumber: t.pr_number, createdAt: t.created_at, updatedAt: t.updated_at });
  }
  return out;
}

export const myTaskJson = (base: string, t: MyTask) => ({
  repository: t.repository,
  number: t.number,
  title: t.title,
  state: t.state,
  runtime: t.runtime,
  agent: { login: t.agent, type: "Bot" },
  pull_request: t.prNumber ? { number: t.prNumber, html_url: `${base}/${t.repository}/pull/${t.prNumber}` } : null,
  html_url: `${base}/${t.repository}/tasks/${t.number}`,
  created_at: t.createdAt,
  updated_at: t.updatedAt,
});

export async function myTasks(c: AppContext, me: Account, repoIds: string[] | null) {
  return (await tasksFor(c.env, c.get("dir"), me, { repoIds })).map((t) => myTaskJson(c.env.PUBLIC_URL.replace(/\/$/, ""), t));
}
