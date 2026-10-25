import type { AppContext } from "../auth/principal.js";
import { blockedBy, killSwitches } from "../lib/killswitch.js";
import type { Env } from "../env.js";
import type { loadRepo } from "../http/common.js";
import type { Account, Directory, Repo } from "../lib/directory.js";
import { mayStart } from "../lib/quotas.js";
import { HttpError, newId, now } from "../lib/util.js";
import { taskCaller, TaskAccessError } from "./access.js";
import type { TaskView } from "./ProjectDO.js";
import { MAX_GOAL, RUNTIME_VERSIONS, type RuntimeId } from "./runtimes.js";
import { projectStub, requirePersonSession, starter } from "./tasks.js";
import { terminalRefusal } from "./org-policy.js";

/**
 * Web terminals (phase 4, /mnt/project-files/agentic/phase4-design.md): a sandbox one person opens
 * to work in directly, for example signed in to their own Claude or ChatGPT subscription.
 *
 * - Only a person in a browser session opens one, with write access, driving one of their agents
 *   (the sandbox's git credential acts as that agent, capped at write, as for tasks).
 * - Only that person sees it or attaches to it: not an admin, not the repository's owner, because
 *   the shell may hold their provider sign-in. The sandbox API never reaches it either.
 * - It ends on End, after TERMINAL_IDLE_MS with nobody attached, or after TERMINAL_MAX_MS; ending
 *   stops the container (its disk, and any sign-in, go with it) and revokes its git credential.
 * - Nothing typed or shown is stored outside the container.
 */

type Loaded = Awaited<ReturnType<typeof loadRepo>>;

export const MAX_TERMINALS_PER_REPO = 2;
export const MAX_TERMINALS = 5;
export const TERMINAL_IDLE_MS = 30 * 60_000;
export const TERMINAL_MAX_MS = 8 * 3600_000;
/** Bump when the notice changes: everyone opts in again. */
export const TERMINAL_TERMS_VERSION = 3;

export type TerminalStatus = "starting" | "running" | "ended";
export type TerminalEndReason = "person" | "idle" | "limit" | "access" | "stopped" | "failed" | "disabled" | "suspended";

export interface TerminalRow {
  id: string;
  repo_id: string;
  person_id: string;
  agent_id: string;
  ref: string;
  status: TerminalStatus;
  sandbox_id: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  /** 1 when the person opened it to run agent tasks (phase 4b); a terminal opened without it never runs one. */
  tasks: number;
}

export const TERMINAL_END_TEXT: Record<TerminalEndReason, string> = {
  person: "You ended it.",
  idle: `Nobody was attached for ${TERMINAL_IDLE_MS / 60_000} minutes.`,
  limit: `It reached the ${TERMINAL_MAX_MS / 3600_000}-hour limit.`,
  access: "You or the agent no longer have write access here.",
  stopped: "Its sandbox stopped.",
  failed: "Its sandbox didn't start.",
  disabled: "Terminals were switched off on this Diffinery.",
  suspended: "A site administrator suspended Actions and sandboxes here, or paused hosted compute on this Diffinery.",
};

/** Terminals can be switched off for the whole instance (`TERMINALS=off`). */
export function terminalsEnabled(env: Env): boolean {
  return (env.TERMINALS ?? "on").toLowerCase() !== "off";
}

export function terminalId(s: string | undefined): string {
  if (!s || !/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new HttpError(404, "terminal not found");
  return s;
}

export class Terminals {
  constructor(private env: Env) {}

  private get db() {
    return this.env.DB;
  }

  async get(id: string): Promise<TerminalRow | null> {
    return (await this.db.prepare("SELECT * FROM agent_terminals WHERE id = ?").bind(id).first<TerminalRow>()) ?? null;
  }

  /** A terminal as its opener sees it; anyone else, admins included, gets 404. */
  async mine(id: string, person: Account, repo: Repo): Promise<TerminalRow> {
    const t = await this.get(id);
    if (!t || t.person_id !== person.id || t.repo_id !== repo.id) throw new HttpError(404, "terminal not found");
    return t;
  }

  async list(personId: string, repoId: string, limit = 20): Promise<TerminalRow[]> {
    return (await this.db.prepare("SELECT * FROM agent_terminals WHERE person_id = ? AND repo_id = ? ORDER BY created_at DESC LIMIT ?").bind(personId, repoId, limit).all<TerminalRow>()).results;
  }

  async open(personId: string): Promise<{ total: number; byRepo: Map<string, number> }> {
    const rows = (await this.db.prepare("SELECT repo_id, count(*) AS n FROM agent_terminals WHERE person_id = ? AND status != 'ended' GROUP BY repo_id").bind(personId).all<{ repo_id: string; n: number }>()).results;
    return { total: rows.reduce((a, r) => a + r.n, 0), byRepo: new Map(rows.map((r) => [r.repo_id, r.n])) };
  }

  async termsAt(personId: string): Promise<string | null> {
    const r = await this.db.prepare("SELECT version, opted_in_at FROM terminal_terms WHERE account_id = ?").bind(personId).first<{ version: number; opted_in_at: string }>();
    return r && r.version >= TERMINAL_TERMS_VERSION ? r.opted_in_at : null;
  }

  async acceptTerms(personId: string): Promise<string> {
    const at = now();
    await this.db
      .prepare("INSERT INTO terminal_terms (account_id, version, opted_in_at) VALUES (?, ?, ?) ON CONFLICT (account_id) DO UPDATE SET version = excluded.version, opted_in_at = excluded.opted_in_at")
      .bind(personId, TERMINAL_TERMS_VERSION, at)
      .run();
    return at;
  }

  async insert(t: Pick<TerminalRow, "repo_id" | "person_id" | "agent_id" | "ref" | "tasks">): Promise<TerminalRow> {
    const row: TerminalRow = { ...t, id: newId(), status: "starting", sandbox_id: null, created_at: now(), started_at: null, ended_at: null, end_reason: null, tasks: t.tasks };
    await this.db
      .prepare("INSERT INTO agent_terminals (id, repo_id, person_id, agent_id, ref, status, sandbox_id, created_at, tasks) VALUES (?, ?, ?, ?, ?, 'starting', NULL, ?, ?)")
      .bind(row.id, row.repo_id, row.person_id, row.agent_id, row.ref, row.created_at, row.tasks)
      .run();
    return row;
  }

  async started(id: string, sandboxId: string): Promise<boolean> {
    const r = await this.db.prepare("UPDATE agent_terminals SET status = 'running', sandbox_id = ?, started_at = ? WHERE id = ? AND status = 'starting'").bind(sandboxId, now(), id).run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** Marks it ended (once); the caller stops the sandbox. Returns whether this call ended it. */
  async markEnded(id: string, reason: TerminalEndReason): Promise<boolean> {
    const r = await this.db.prepare("UPDATE agent_terminals SET status = 'ended', ended_at = ?, end_reason = ? WHERE id = ? AND status != 'ended'").bind(now(), reason, id).run();
    return (r.meta.changes ?? 0) > 0;
  }

  async running(repoId: string): Promise<TerminalRow[]> {
    return (await this.db.prepare("SELECT * FROM agent_terminals WHERE repo_id = ? AND status != 'ended' ORDER BY created_at").bind(repoId).all<TerminalRow>()).results;
  }
}

/**
 * Opens a terminal for the person in this browser session. The sandbox starts in the project's
 * alarm (it can take a minute); the page shows "Starting" until then.
 */
export async function openTerminal(c: AppContext, l: Loaded, input: { agent?: string; ref?: string; accept?: boolean; tasks?: boolean }): Promise<TerminalRow> {
  const me = requirePersonSession(c);
  if (!terminalsEnabled(c.env)) throw new HttpError(403, "terminals are switched off on this Diffinery");
  if (l.repo.archived) throw new HttpError(403, "repository is archived (read-only)");
  // The organization's agent policy (phase 5b): terminals, and tasks in them, allowed.
  const dir = c.get("dir");
  const refused = await terminalRefusal(c.env, l.repo, { tasks: !!input.tasks, person: { dir, account: me } });
  if (refused) throw new HttpError(403, refused);
  const agent = input.agent ? await dir.accountByLogin(input.agent) : null;
  if (!agent || agent.kind !== "agent") throw new HttpError(422, "choose one of your agents");
  try {
    await taskCaller(dir, me, agent, l.repo);
  } catch (e) {
    if (e instanceof TaskAccessError) throw new HttpError(403, e.message);
    throw e;
  }
  const terminals = new Terminals(c.env);
  if (!(await terminals.termsAt(me.id))) {
    if (!input.accept) throw new HttpError(422, "accept the notice first: you use your own provider account, under its terms");
    await terminals.acceptTerms(me.id);
    audit(c, me, l.repo, "terminal.terms", { version: TERMINAL_TERMS_VERSION });
  }
  const ref = (input.ref ?? "").trim() || l.repo.default_branch;
  if (!(await l.stub.getRef(`refs/heads/${ref}`))) throw new HttpError(422, `the branch ${ref} doesn't exist`);
  const open = await terminals.open(me.id);
  if ((open.byRepo.get(l.repo.id) ?? 0) >= MAX_TERMINALS_PER_REPO) throw new HttpError(429, `you have ${MAX_TERMINALS_PER_REPO} terminals open in this repository, the most allowed; end one first`);
  if (open.total >= MAX_TERMINALS) throw new HttpError(429, `you have ${MAX_TERMINALS} terminals open, the most allowed; end one first`);
  // The account that owns the repository pays for the sandbox (lib/quotas.ts); say so now rather than
  // after it fails to start. RepoDO.createSandbox checks again when it starts.
  // Kill switches (lib/killswitch.ts) refuse new sandboxes, terminals included.
  const block = blockedBy(await killSwitches(c.env, l.repo.id), "sandbox");
  if (block) throw new HttpError(403, block);
  const quota = await mayStart(c.env, l.repo.owner_id, "sandbox");
  if (!quota.ok) throw new HttpError(429, quota.message);
  const t = await terminals.insert({ repo_id: l.repo.id, person_id: me.id, agent_id: agent.id, ref, tasks: input.tasks ? 1 : 0 });
  audit(c, me, l.repo, "terminal.open", { terminal: t.id, agent: agent.login, ref, tasks: !!input.tasks, runtimes: { "claude-code": RUNTIME_VERSIONS["claude-code"], codex: RUNTIME_VERSIONS.codex } });
  await projectStub(c.env, l.repo.id).wakeTerminals(l.repo.id);
  return t;
}

/**
 * Ends a terminal: marks it ended, stops a task running in it, then stops its sandbox (which revokes its git
 * credential). `project` is the repository's ProjectDO when the caller is that object itself.
 */
export async function endTerminal(env: Env, dir: Directory, t: TerminalRow, reason: TerminalEndReason, by?: Account, project?: { terminalEnded(id: string): Promise<void> }): Promise<void> {
  if (!(await new Terminals(env).markEnded(t.id, reason))) return;
  await (project ?? projectStub(env, t.repo_id)).terminalEnded(t.id).catch((e: unknown) => console.error("stopping the terminal's task failed", e));
  if (t.sandbox_id) await env.REPO.get(env.REPO.idFromName(t.repo_id)).closeTaskSandbox(t.sandbox_id).catch((e) => console.error("terminal sandbox close failed", e));
  const repo = await dir.repoById(t.repo_id).catch(() => null);
  const actor = by ?? (await dir.account(t.person_id).catch(() => null));
  await dir
    .audit({ actorId: actor?.id ?? t.person_id, actorLogin: actor?.login ?? "unknown", action: "terminal.end", target: repo ? `${repo.owner_login}/${repo.name}` : t.repo_id, detail: { terminal: t.id, reason } })
    .catch((e) => console.error("audit failed", e));
}

function audit(c: AppContext, me: Account, repo: Repo, action: string, detail: Record<string, unknown>): void {
  c.executionCtx.waitUntil(
    c
      .get("dir")
      .audit({ actorId: me.id, actorLogin: me.login, action, target: `${repo.owner_login}/${repo.name}`, detail })
      .catch((e) => console.error("audit failed", e)),
  );
}

// ---------------------------------------------------------------- 4b: tasks in a terminal

/**
 * The runtimes a terminal runs tasks with, signed in there: Claude Code, and Codex on private repositories only
 * (OpenAI allows signing in with a ChatGPT plan only there).
 */
export function terminalRuntimes(repo: Repo): RuntimeId[] {
  return repo.visibility === "public" ? ["claude-code"] : ["claude-code", "codex"];
}

/** The person's own open terminal in this repository, with the opt-in in force, checked again at every dispatch. */
async function dispatchTerminal(c: AppContext, l: Loaded, me: Account, id: string | undefined, runtime: RuntimeId, agentId?: string): Promise<{ t: TerminalRow; to: { id: string; sandboxId: string } }> {
  if (!terminalsEnabled(c.env)) throw new HttpError(403, "terminals are switched off on this Diffinery");
  const refused = await terminalRefusal(c.env, l.repo, { tasks: true, runtime, person: { dir: c.get("dir"), account: me } });
  if (refused) throw new HttpError(403, refused);
  const terminals = new Terminals(c.env);
  const t = await terminals.mine(terminalId(id), me, l.repo);
  if (t.status !== "running" || !t.sandbox_id) throw new HttpError(409, "the terminal isn't running");
  if (!t.tasks) throw new HttpError(409, "this terminal was opened without agent tasks: open one with \"Will run agent tasks\" to give it one");
  if (!(await terminals.termsAt(me.id))) throw new HttpError(403, "accept the notice for terminals first: tasks there use your own provider account");
  // Kill switches (lib/killswitch.ts) stop sandboxes here: the terminal's is ending, and starts no task meanwhile.
  const block = blockedBy(await killSwitches(c.env, l.repo.id), "sandbox");
  if (block) throw new HttpError(403, block);
  if (agentId && t.agent_id !== agentId) throw new HttpError(422, "this terminal acts as a different agent than the task's: open one with the task's agent");
  if (await projectStub(c.env, l.repo.id).terminalTask(t.id)) throw new HttpError(409, "your terminal is already running a task; one at a time");
  return { t, to: { id: t.id, sandboxId: t.sandbox_id } };
}

function terminalRuntime(l: Loaded, runtime: unknown): RuntimeId {
  const ok = terminalRuntimes(l.repo);
  if (typeof runtime !== "string" || !ok.includes(runtime as RuntimeId)) throw new HttpError(422, l.repo.visibility === "public" ? "a public repository's terminal runs tasks with Claude Code" : "a terminal runs tasks with Claude Code or Codex");
  return runtime as RuntimeId;
}

/**
 * Start a task in the person's terminal (phase 4b): only from their own click on the terminal's page. The CLI signed
 * in there does the work, on their own subscription, as the terminal's agent; Diffinery pushes and opens the pull
 * request as for any task. Its checks don't start fix runs by themselves.
 */
export async function startTaskInTerminal(c: AppContext, l: Loaded, id: string | undefined, input: { goal?: unknown; runtime?: unknown }): Promise<TaskView> {
  const me = requirePersonSession(c);
  if (l.repo.archived) throw new HttpError(403, "repository is archived (read-only)");
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (!goal) throw new HttpError(422, "write the goal");
  if (goal.length > MAX_GOAL) throw new HttpError(422, `the goal is longer than ${MAX_GOAL} characters`);
  const runtime = terminalRuntime(l, input.runtime);
  const { t, to } = await dispatchTerminal(c, l, me, id, runtime);
  const dir = c.get("dir");
  const agent = await dir.account(t.agent_id);
  if (!agent) throw new HttpError(403, "the terminal's agent no longer exists");
  try {
    await taskCaller(dir, me, agent, l.repo);
  } catch (e) {
    if (e instanceof TaskAccessError) throw new HttpError(403, e.message);
    throw e;
  }
  if (!(await l.stub.getRef(`refs/heads/${t.ref}`))) throw new HttpError(422, `the branch ${t.ref} doesn't exist any more`);
  const project = projectStub(c.env, l.repo.id);
  if ((await project.projectSettings()).planFirst === "required") throw new HttpError(422, "this project requires a plan first, which is written in a sandbox of its own: start the task from New task");
  const task = await project.create({ repoId: l.repo.id, goal, runtime, command: null, agent: { id: agent.id, login: agent.login }, person: { id: me.id, login: me.login }, base: t.ref, providers: [], planFirst: false, attempts: 1, fixChecks: false, land: false, terminal: to });
  audit(c, me, l.repo, "task.start", { agent: agent.login, runtime, terminal: t.id, fix_checks: false, land: false });
  audit(c, me, l.repo, "terminal.task", { terminal: t.id, task: task.number, runtime, version: RUNTIME_VERSIONS[runtime as "claude-code" | "codex"] });
  return task;
}

/** Run an existing task again in the person's terminal (phase 4b): only from their own click on the task's page. */
export async function runTaskInTerminal(c: AppContext, l: Loaded, number: number, id: string | undefined, message: unknown): Promise<TaskView> {
  const { person, task } = await starter(c, l, number);
  if (task.kind !== "task") throw new HttpError(409, "only agent tasks run in a terminal");
  const runtime = terminalRuntime(l, task.runtime);
  const text = typeof message === "string" ? message.trim() : "";
  if (text.length > MAX_GOAL) throw new HttpError(422, `the message is longer than ${MAX_GOAL} characters`);
  const { t, to } = await dispatchTerminal(c, l, person, id, runtime, task.agent_id);
  const out = await projectStub(c.env, l.repo.id).runInTerminal(number, to, text || null);
  audit(c, person, l.repo, "terminal.task", { terminal: t.id, task: number, runtime, version: RUNTIME_VERSIONS[runtime as "claude-code" | "codex"] });
  return out;
}

/** The person's open terminal a task could run in now, for its page's Run in my terminal button; null when none. */
export async function terminalForTask(env: Env, me: Account, repo: Repo, task: TaskView): Promise<string | null> {
  if (!terminalsEnabled(env) || task.kind !== "task" || task.person_id !== me.id || !terminalRuntimes(repo).includes(task.runtime)) return null;
  if ((task.attempts > 1 && task.picked === null) || task.plan_state === "planning" || task.plan_state === "waiting") return null;
  const terminals = new Terminals(env);
  const open = (await terminals.list(me.id, repo.id)).filter((t) => t.status === "running" && t.tasks && t.agent_id === task.agent_id);
  if (!open.length || !(await terminals.termsAt(me.id))) return null;
  const project = projectStub(env, repo.id);
  for (const t of open) if ((await project.terminalTask(t.id)) === null) return t.id;
  return null;
}
