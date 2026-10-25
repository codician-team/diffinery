import type { AppContext } from "../auth/principal.js";
import type { loadRepo } from "../http/common.js";
import { HttpError } from "../lib/util.js";
import { atLeast } from "../repo/types.js";
import type { Account } from "../lib/directory.js";
import { taskCaller, TaskAccessError } from "./access.js";
import { COORDINATOR_TOKENS_DEFAULT, TASK_TOKENS_DEFAULT, TOKENS_MAX, TOKENS_MIN, type CoordinatorSettings } from "./coordinator.js";
import { BOARD, boardState, isPlanFirst, MAX_INSTRUCTIONS, MAX_MEMORY, MAX_POST, validMaxRunning, type BoardState, type MemoryRow, type PostRow, type ProjectSettings, type PullState } from "./project.js";
import type { TaskRow } from "./ProjectDO.js";
import { isRuntime, MAX_COMMAND } from "./runtimes.js";
import { modelRoute, projectStub, requirePersonSession, starter, taskJson } from "./tasks.js";
import { payerFor } from "./org-policy.js";

/**
 * The project layer over a repository (agentic/project.ts): the board, the
 * conversation, memory and settings, as the Project tab, REST and MCP use them.
 * Everything here needs write access, as tasks do.
 */

type Loaded = Awaited<ReturnType<typeof loadRepo>>;

/** How many tasks the board shows, newest activity first. */
const BOARD_TASKS = 100;
/** How many closed or merged pull requests the board looks up per load. */
const MAX_PULL_LOOKUPS = 40;

export interface Board {
  columns: Record<BoardState, TaskRow[]>;
  settings: ProjectSettings;
  memory: MemoryRow | null;
}

export async function loadBoard(c: AppContext, l: Loaded): Promise<Board> {
  const project = projectStub(c.env, l.repo.id);
  const [tasks, settings, memory, today] = await Promise.all([project.list({ limit: BOARD_TASKS }), project.projectSettings(), project.memory(), l.stub.todaySummary(new Date().toISOString())]);
  const open = new Map(today.pulls.map((p) => [p.number, p]));
  const pulls = new Map<number, PullState>();
  let lookups = 0;
  for (const t of tasks) {
    if (t.kind !== "task" || !t.pr_number || pulls.has(t.pr_number)) continue;
    const p = open.get(t.pr_number);
    if (p) pulls.set(t.pr_number, { open: true, pull: p });
    else if (t.state === "ready" && lookups++ < MAX_PULL_LOOKUPS) {
      const { issue } = await l.stub.issue(t.pr_number).catch(() => ({ issue: null }));
      if (issue?.pull) pulls.set(t.pr_number, issue.state === "open" ? { open: true, pull: { checks: "none", approvedHead: false, autoMerge: false, queued: false, draft: false } } : { open: false, merged: !!issue.pull.merged });
    }
  }
  const columns = Object.fromEntries(BOARD.map((b) => [b, [] as TaskRow[]])) as Record<BoardState, TaskRow[]>;
  // Reviews show on their pull requests and coordinators in the conversation, not as the project's work.
  for (const t of tasks) if (t.kind === "task") columns[boardState(t, t.pr_number ? (pulls.get(t.pr_number) ?? null) : null)].push(t);
  return { columns, settings, memory };
}

export function requireProjectWriter(l: Loaded): void {
  if (l.repo.archived) throw new HttpError(403, "repository is archived (read-only)");
  if (!atLeast(l.caller.role, "write")) throw new HttpError(403, "write access required");
}

export type Handled = { task: number; status: "started" | "queued" } | { error: string };

/**
 * Post in the project conversation. A post starts the poster's coordinator on their model key (unless they ask
 * it not to), so it needs a person in a browser, as starting a task does. The post stays when the coordinator
 * can't start; `handled` says why.
 */
export async function postToProject(c: AppContext, l: Loaded, body: unknown, opts: { coordinator?: boolean } = {}): Promise<{ post: PostRow; handled: Handled | null }> {
  const person = requirePersonSession(c);
  requireProjectWriter(l);
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) throw new HttpError(422, "`body` is required");
  if (text.length > MAX_POST) throw new HttpError(422, `\`body\` is longer than ${MAX_POST} characters`);
  const project = projectStub(c.env, l.repo.id);
  const post = await project.post({ id: person.id, login: person.login }, text);
  if (opts.coordinator === false || !(await project.coordinator(person.id))) return { post, handled: null };
  try {
    return { post, handled: await handleAs(c, l, person, post.n) };
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    return { post, handled: { error: e.message } };
  }
}

/** Split a task's waiting plan into tasks: the person who started it hands it to their coordinator. */
export async function splitPlan(c: AppContext, l: Loaded, number: number): Promise<{ post: number; task: number; status: "started" | "queued" }> {
  const { person } = await starter(c, l, number);
  const { s, providers, keyOwner } = await coordinatorFor(c, l, person);
  const out = await projectStub(c.env, l.repo.id).splitPlan(number, s, providers, { id: l.repo.id, base: l.repo.default_branch }, keyOwner);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: person.id, actorLogin: person.login, action: "task.plan_split", target: `${l.repo.owner_login}/${l.repo.name}#${number}`, detail: { post: out.post, coordinator_task: out.task } }));
  return out;
}

/** "Handle this": hand a post nobody's coordinator took to yours. */
export async function handlePost(c: AppContext, l: Loaded, n: number): Promise<{ task: number; status: "started" | "queued" }> {
  const person = requirePersonSession(c);
  requireProjectWriter(l);
  return handleAs(c, l, person, n);
}

/** A person's coordinator here, checked: they may still drive its agent, and have the keys its runtime needs. */
async function coordinatorFor(c: AppContext, l: Loaded, person: Account) {
  const s = await projectStub(c.env, l.repo.id).coordinator(person.id);
  if (!s) throw new HttpError(422, "set up your coordinator for this project first");
  const agent = await c.get("dir").account(s.agent.id);
  if (!agent || agent.kind !== "agent") throw new HttpError(422, "your coordinator's agent no longer exists: choose another");
  try {
    await taskCaller(c.get("dir"), person, agent, l.repo);
  } catch (e) {
    if (e instanceof TaskAccessError) throw new HttpError(403, e.message);
    throw e;
  }
  const { providers, keyOwner } = await payerFor(c.env, c.get("dir"), l.repo, person, s.runtime, s.via);
  return { s, providers, keyOwner };
}

async function handleAs(c: AppContext, l: Loaded, person: Account, n: number) {
  const { s, providers, keyOwner } = await coordinatorFor(c, l, person);
  const out = await projectStub(c.env, l.repo.id).handlePost(n, s, providers, { id: l.repo.id, base: l.repo.default_branch }, keyOwner);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: person.id, actorLogin: person.login, action: "project.coordinate", target: `${l.repo.owner_login}/${l.repo.name}`, detail: { post: n, task: out.task, agent: s.agent.login, runtime: s.runtime } }));
  return out;
}

export interface CoordinatorInput {
  agent?: unknown;
  runtime?: unknown;
  command?: unknown;
  provider?: unknown;
  model?: unknown;
  tokens_per_run?: unknown;
  tokens_per_task?: unknown;
  accept?: unknown;
}

const tokens = (v: unknown, d: number, name: string): number => {
  const n = v === undefined || v === null || v === "" ? d : Number(v);
  if (!Number.isInteger(n) || n < TOKENS_MIN || n > TOKENS_MAX) throw new HttpError(422, `\`${name}\` must be a whole number from ${TOKENS_MIN} to ${TOKENS_MAX}`);
  return n;
};

/** Your coordinator in this project: who runs it, with what, and its token budgets. It spends only your key. */
export async function saveCoordinator(c: AppContext, l: Loaded, input: CoordinatorInput | null): Promise<CoordinatorSettings | null> {
  const me = requirePersonSession(c);
  requireProjectWriter(l);
  const project = projectStub(c.env, l.repo.id);
  const current = await project.coordinator(me.id);
  if (!input) {
    await project.setCoordinator(me.id, null);
    if (current) c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "project.coordinator", target: `${l.repo.owner_login}/${l.repo.name}`, detail: { enabled: false } }));
    return null;
  }
  const runtime = typeof input.runtime === "string" ? input.runtime : "claude-code";
  if (!isRuntime(runtime)) throw new HttpError(422, "`runtime` must be claude-code, codex or custom");
  const command = runtime === "custom" ? (typeof input.command === "string" ? input.command.trim() : "") : null;
  if (runtime === "custom" && !command) throw new HttpError(422, "`command` is required for the custom runtime");
  if (command && command.length > MAX_COMMAND) throw new HttpError(422, `\`command\` is longer than ${MAX_COMMAND} characters`);
  const agentLogin = typeof input.agent === "string" ? input.agent.trim() : "";
  const agent = agentLogin ? await c.get("dir").accountByLogin(agentLogin) : null;
  if (!agent || agent.kind !== "agent") throw new HttpError(422, "`agent` must be the login of one of your agents");
  try {
    await taskCaller(c.get("dir"), me, agent, l.repo);
  } catch (e) {
    if (e instanceof TaskAccessError) throw new HttpError(403, e.message);
    throw e;
  }
  const route = modelRoute(runtime, input.provider, input.model);
  await payerFor(c.env, c.get("dir"), l.repo, me, runtime, route.via);
  const tokensPerRun = tokens(input.tokens_per_run, current?.tokensPerRun ?? COORDINATOR_TOKENS_DEFAULT, "tokens_per_run");
  const tokensPerTask = tokens(input.tokens_per_task, current?.tokensPerTask ?? TASK_TOKENS_DEFAULT, "tokens_per_task");
  if (input.accept !== true) throw new HttpError(422, "confirm that your coordinator, and the tasks it starts, use your model key");
  const at = new Date().toISOString();
  const s: CoordinatorSettings = { person: { id: me.id, login: me.login }, agent: { id: agent.id, login: agent.login }, runtime, command, via: route.via, model: route.model, tokensPerRun, tokensPerTask, optedInAt: current?.optedInAt ?? at, updatedAt: at };
  await project.setCoordinator(me.id, s);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "project.coordinator", target: `${l.repo.owner_login}/${l.repo.name}`, detail: { enabled: true, agent: agent.login, runtime, ...(route.via ? { provider: route.via, model: route.model } : {}), tokens_per_run: tokensPerRun, tokens_per_task: tokensPerTask } }));
  return s;
}

export async function saveMemory(c: AppContext, l: Loaded, body: unknown, restore?: number): Promise<MemoryRow> {
  const person = requirePersonSession(c);
  requireProjectWriter(l);
  const project = projectStub(c.env, l.repo.id);
  let text: string;
  if (restore !== undefined) {
    const v = await project.memoryVersion(restore);
    if (!v) throw new HttpError(404, "no such memory version");
    text = v.body;
  } else {
    if (typeof body !== "string") throw new HttpError(422, "`body` is required");
    text = body.replace(/\r\n/g, "\n");
  }
  if (text.length > MAX_MEMORY) throw new HttpError(422, `memory is longer than ${MAX_MEMORY} characters`);
  const m = await project.setMemory(text, { id: person.id, login: person.login, kind: "person" });
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: person.id, actorLogin: person.login, action: "project.memory", target: `${l.repo.owner_login}/${l.repo.name}`, detail: { version: m.n, ...(restore !== undefined ? { restored: restore } : {}), length: text.length } }));
  return m;
}

export async function saveProjectSettings(c: AppContext, l: Loaded, input: { max_running?: unknown; instructions?: unknown; plan_first?: unknown }): Promise<ProjectSettings> {
  const person = requirePersonSession(c);
  if (l.repo.archived) throw new HttpError(403, "repository is archived (read-only)");
  if (!atLeast(l.caller.role, "admin")) throw new HttpError(403, "admin access required");
  const next: Partial<ProjectSettings> = {};
  if (input.max_running !== undefined) {
    try {
      next.maxRunning = validMaxRunning(typeof input.max_running === "string" ? Number(input.max_running) : input.max_running);
    } catch (e) {
      throw new HttpError(422, (e as Error).message);
    }
  }
  if (input.instructions !== undefined) {
    if (typeof input.instructions !== "string") throw new HttpError(422, "`instructions` must be text");
    const text = input.instructions.replace(/\r\n/g, "\n").trim();
    if (text.length > MAX_INSTRUCTIONS) throw new HttpError(422, `\`instructions\` is longer than ${MAX_INSTRUCTIONS} characters`);
    next.instructions = text;
  }
  if (input.plan_first !== undefined) {
    if (!isPlanFirst(input.plan_first)) throw new HttpError(422, "`plan_first` must be off, default or required");
    next.planFirst = input.plan_first;
  }
  const s = await projectStub(c.env, l.repo.id).setProjectSettings(next);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: person.id, actorLogin: person.login, action: "project.settings", target: `${l.repo.owner_login}/${l.repo.name}`, detail: { max_running: s.maxRunning, instructions_length: s.instructions.length, plan_first: s.planFirst } }));
  return s;
}

// ---------------------------------------------------------------- JSON

export const postJson = (base: string, repoFull: string, p: PostRow) => ({
  id: p.n,
  kind: p.kind,
  author: p.author_login ? { login: p.author_login, type: p.kind === "coordinator" ? "Bot" : "User" } : null,
  body: p.body,
  task: p.task ? { number: p.task, html_url: `${base}/${repoFull}/tasks/${p.task}` } : null,
  handled_by: p.handled_by ? { number: p.handled_by, html_url: `${base}/${repoFull}/tasks/${p.handled_by}` } : null,
  memory_version: p.memory_version ?? null,
  created_at: p.at,
});

export const coordinatorJson = (s: CoordinatorSettings | null) =>
  s ? { enabled: true, agent: { login: s.agent.login }, runtime: s.runtime, command: s.command, provider: s.via, model: s.model, tokens_per_run: s.tokensPerRun, tokens_per_task: s.tokensPerTask, opted_in_at: s.optedInAt, updated_at: s.updatedAt } : { enabled: false };

/** Someone's coordinator as every member sees it: whose it is, its agent and model. Never its budgets or custom command. */
export const coordinatorSummaryJson = (s: CoordinatorSettings) => ({ person: { login: s.person.login }, agent: { login: s.agent.login }, runtime: s.runtime, provider: s.via, model: s.model, opted_in_at: s.optedInAt });

export const memoryJson = (m: MemoryRow | null) => (m ? { body: m.body, version: m.n, updated_by: { login: m.by_login, type: m.by_kind === "person" ? "User" : "Bot" }, updated_at: m.at } : { body: "", version: null, updated_by: null, updated_at: null });

export const settingsJson = (s: ProjectSettings) => ({ max_running: s.maxRunning, ...(s.orgMaxRunning !== null ? { org_max_running: s.orgMaxRunning } : {}), instructions: s.instructions, plan_first: s.planFirst });

export function boardJson(base: string, repoFull: string, b: Board) {
  return {
    settings: settingsJson(b.settings),
    memory: memoryJson(b.memory),
    board: Object.fromEntries(BOARD.map((k) => [k, b.columns[k].map((t) => taskJson(base, repoFull, t))])),
  };
}
