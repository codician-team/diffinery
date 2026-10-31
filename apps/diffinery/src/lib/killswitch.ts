import type { Env } from "../env.js";
import { MAX_RUN_MS } from "./quotas.js";
import { HttpError, now } from "./util.js";

/**
 * Kill switches: a site administrator stops Actions and agent sandboxes at three levels.
 *
 * - A repository: its Actions are suspended (repos.actions_suspended_*).
 * - An account (a person or an organization): Actions are suspended for every repository it owns
 *   (accounts.actions_suspended_*).
 * - The instance: hosted compute (hosted Actions jobs and agent sandboxes) is paused everywhere
 *   (site_flags `hosted_compute_paused`). Self-hosted runners keep working: they cost the instance nothing.
 *
 * While a repository or its owner is suspended no workflow run starts, queued jobs (hosted or
 * self-hosted) fail instead of starting, and no sandbox opens. While the instance is paused hosted
 * jobs fail instead of starting and no sandbox opens. Suspending or pausing also stops what is
 * running then (RepoDO.stopActions); lifting one only allows new work again. Nobody is exempt,
 * not even site administrators' own accounts. A suspended person (lib/moderation.ts) counts as an
 * account whose Actions are suspended, with the suspension's reason.
 *
 * GitHub jobs on Diffinery runners (github-runners/) count as the linked account's hosted jobs: its
 * suspension and the instance's pause stop them too (accountKillSwitches, stopGitHubRunners).
 */

export const PAUSE_FLAG = "hosted_compute_paused";
/** Longest reason kept, in characters. */
export const MAX_REASON = 500;

export interface Suspension {
  at: string;
  by: string | null;
  reason: string | null;
}

export interface KillSwitches {
  repo: Suspension | null;
  /** The owning account's suspension, with its login. */
  account: (Suspension & { login: string }) | null;
  paused: Suspension | null;
}

/** What wants to start: a workflow run, a hosted or self-hosted job, or an agent sandbox. */
export type Work = "run" | "hosted-job" | "self-hosted-job" | "sandbox";

const tail = (reason: string | null) => (reason ? `: ${reason}` : "");

/** Every switch that applies to a repository, in one query (this is on the path of every job and sandbox). */
export async function killSwitches(env: Env, repoId: string): Promise<KillSwitches> {
  const r = await env.DB.prepare(
    `SELECT r.actions_suspended_at AS r_at, r.actions_suspended_by AS r_by, r.actions_suspended_reason AS r_reason,
            a.login AS login, a.actions_suspended_at AS a_at, a.actions_suspended_by AS a_by, a.actions_suspended_reason AS a_reason,
            a.suspended_at AS s_at, a.suspended_by AS s_by, a.suspended_reason AS s_reason,
            f.value AS p_reason, f.updated_at AS p_at, f.updated_by AS p_by
       FROM repos r JOIN accounts a ON a.id = r.owner_id LEFT JOIN site_flags f ON f.key = ?
      WHERE r.id = ?`,
  )
    .bind(PAUSE_FLAG, repoId)
    .first<Record<string, string | null>>();
  if (!r) return { repo: null, account: null, paused: await computePause(env) };
  return {
    repo: r.r_at ? { at: r.r_at, by: r.r_by ?? null, reason: r.r_reason ?? null } : null,
    // A suspended owner (lib/moderation.ts) counts as an account whose Actions are suspended.
    account: r.a_at ? { at: r.a_at, by: r.a_by ?? null, reason: r.a_reason ?? null, login: r.login! } : r.s_at ? { at: r.s_at, by: r.s_by ?? null, reason: r.s_reason ?? null, login: r.login! } : null,
    paused: r.p_at ? { at: r.p_at, by: r.p_by ?? null, reason: r.p_reason || null } : null,
  };
}

/**
 * The switches over an account's work outside its repositories (GitHub jobs on Diffinery runners): its own
 * suspension (or the person's, lib/moderation.ts) and the instance's pause.
 */
export async function accountKillSwitches(env: Env, accountId: string): Promise<KillSwitches> {
  const a = await env.DB.prepare(
    "SELECT login, actions_suspended_at AS a_at, actions_suspended_by AS a_by, actions_suspended_reason AS a_reason, suspended_at AS s_at, suspended_by AS s_by, suspended_reason AS s_reason FROM accounts WHERE id = ?",
  )
    .bind(accountId)
    .first<Record<string, string | null>>();
  const account = a?.a_at ? { at: a.a_at, by: a.a_by ?? null, reason: a.a_reason ?? null, login: a.login! } : a?.s_at ? { at: a.s_at, by: a.s_by ?? null, reason: a.s_reason ?? null, login: a.login! } : null;
  return { repo: null, account, paused: await computePause(env) };
}

/** Why `work` may not start under these switches (a sentence without a final period), or null when it may. */
export function blockedBy(k: KillSwitches, work: Work): string | null {
  if (k.repo) return `Actions are suspended for this repository by a site administrator${tail(k.repo.reason)}`;
  if (k.account) return `Actions are suspended for every repository of ${k.account.login} by a site administrator${tail(k.account.reason)}`;
  if (k.paused && work === "hosted-job") return `Hosted runners are paused on this instance by a site administrator${tail(k.paused.reason)}. Self-hosted runners still work`;
  if (k.paused && work === "sandbox") return `Agent sandboxes are paused on this instance by a site administrator${tail(k.paused.reason)}`;
  return null;
}

/** The instance's hosted compute pause, or null. */
export async function computePause(env: Env): Promise<Suspension | null> {
  const f = await env.DB.prepare("SELECT value, updated_at, updated_by FROM site_flags WHERE key = ?").bind(PAUSE_FLAG).first<{ value: string; updated_at: string; updated_by: string | null }>();
  return f ? { at: f.updated_at, by: f.updated_by, reason: f.value || null } : null;
}

/** A reason as sent by an administrator: required, trimmed and bounded. */
export function cleanReason(v: unknown): string {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!s) throw new HttpError(422, "give a reason (it is shown to the people affected and kept in the audit log)");
  if (s.length > MAX_REASON) throw new HttpError(422, `the reason can be at most ${MAX_REASON} characters`);
  return s;
}

/** Suspend (with a reason) or lift (null) Actions for a repository or an account. */
export async function setSuspension(env: Env, target: { repoId: string } | { accountId: string }, s: { reason: string; by: string } | null): Promise<void> {
  const [table, id] = "repoId" in target ? ["repos", target.repoId] : ["accounts", target.accountId];
  await env.DB.prepare(`UPDATE ${table} SET actions_suspended_at = ?, actions_suspended_by = ?, actions_suspended_reason = ? WHERE id = ?`)
    .bind(s ? now() : null, s?.by ?? null, s?.reason ?? null, id)
    .run();
}

/** A repository's or an account's own suspension (not its owner's), or null. */
export async function suspensionOf(env: Env, target: { repoId: string } | { accountId: string }): Promise<Suspension | null> {
  const [table, id] = "repoId" in target ? ["repos", target.repoId] : ["accounts", target.accountId];
  const r = await env.DB.prepare(`SELECT actions_suspended_at AS at, actions_suspended_by AS by, actions_suspended_reason AS reason FROM ${table} WHERE id = ?`).bind(id).first<{ at: string | null; by: string | null; reason: string | null }>();
  return r?.at ? { at: r.at, by: r.by, reason: r.reason } : null;
}

/** Pause (with a reason) or resume (null) hosted compute on the instance. */
export async function setComputePause(env: Env, s: { reason: string; by: string } | null): Promise<void> {
  if (!s) await env.DB.prepare("DELETE FROM site_flags WHERE key = ?").bind(PAUSE_FLAG).run();
  else
    await env.DB.prepare("INSERT INTO site_flags (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
      .bind(PAUSE_FLAG, s.reason, now(), s.by)
      .run();
}

/**
 * Repositories with hosted compute running now (compute_usage rows still open), with the ids of
 * their jobs and sandboxes. A sandbox that slept and woke has segment ids `<sandbox id>:<n>`;
 * these are reported as the sandbox's own id. Rows older than the longest a job or sandbox can
 * run are counted as ended, as quotas count them.
 */
export async function runningCompute(env: Env, at = new Date()): Promise<Map<string, { jobs: string[]; sandboxes: string[] }>> {
  const since = new Date(at.getTime() - MAX_RUN_MS.sandbox).toISOString();
  const rows = await env.DB.prepare("SELECT id, repo_id, kind, started_at FROM compute_usage WHERE ended_at IS NULL AND started_at > ?").bind(since).all<{ id: string; repo_id: string; kind: "job" | "sandbox"; started_at: string }>();
  const out = new Map<string, { jobs: string[]; sandboxes: string[] }>();
  for (const r of rows.results) {
    if (Date.parse(r.started_at) + MAX_RUN_MS[r.kind] <= at.getTime()) continue;
    // GitHub runners have no Diffinery repository (stopGitHubRunners stops them).
    if (r.repo_id.startsWith(GITHUB_COMPUTE)) continue;
    const e = out.get(r.repo_id) ?? { jobs: [], sandboxes: [] };
    const id = r.kind === "sandbox" ? r.id.split(":")[0]! : r.id;
    const list = r.kind === "job" ? e.jobs : e.sandboxes;
    if (!list.includes(id)) list.push(id);
    out.set(r.repo_id, e);
  }
  return out;
}

/** Suspended repositories and accounts, for the site administration page. */
export async function suspendedList(env: Env): Promise<{ accounts: Array<Suspension & { login: string; kind: string }>; repos: Array<Suspension & { owner: string; name: string }> }> {
  const [a, r] = await Promise.all([
    env.DB.prepare("SELECT login, kind, actions_suspended_at AS at, actions_suspended_by AS by, actions_suspended_reason AS reason FROM accounts WHERE actions_suspended_at IS NOT NULL ORDER BY actions_suspended_at DESC LIMIT 200").all<Suspension & { login: string; kind: string }>(),
    env.DB.prepare(
      "SELECT a.login AS owner, r.name AS name, r.actions_suspended_at AS at, r.actions_suspended_by AS by, r.actions_suspended_reason AS reason FROM repos r JOIN accounts a ON a.id = r.owner_id WHERE r.actions_suspended_at IS NOT NULL ORDER BY r.actions_suspended_at DESC LIMIT 200",
    ).all<Suspension & { owner: string; name: string }>(),
  ]);
  return { accounts: a.results, repos: r.results };
}

// ---------------------------------------------------------------- turning switches on and off (REST and web)

export type Stopped = { repositories: number; runs: number; jobs: number; sandboxes: number; failed: number };

/** Ask each repository's RepoDO to stop its work (RepoDO.stopActions), a few at a time. */
export async function stopIn(env: Env, repoIds: string[], o: { hostedOnly: boolean; message: string }): Promise<Stopped> {
  const out: Stopped = { repositories: 0, runs: 0, jobs: 0, sandboxes: 0, failed: 0 };
  const queue = [...repoIds];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        const r = await env.REPO.get(env.REPO.idFromName(id)).stopActions(o);
        out.repositories++;
        out.runs += r.runs;
        out.jobs += r.jobs;
        out.sandboxes += r.sandboxes;
      } catch (e) {
        console.error(`kill switch: stopping work in repository ${id} failed`, e);
        out.failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
  return out;
}

/** compute_usage.repo_id of GitHub runners starts with this (github-runners/service.ts githubComputeRepo). */
const GITHUB_COMPUTE = "github:";

/**
 * Stops the GitHub jobs on Diffinery runners of these accounts (all accounts running one when null):
 * queued ones fail and running runners stop, with `message`. Returns the runners stopped.
 */
export async function stopGitHubRunners(env: Env, accountIds: string[] | null, message: string): Promise<number> {
  const ns = env.GITHUB_RUNNERS;
  if (!ns) return 0;
  const ids =
    accountIds ??
    (await env.DB.prepare("SELECT DISTINCT account_id FROM github_runner_jobs WHERE status IN ('queued', 'starting', 'running')").all<{ account_id: string }>()).results.map((r) => r.account_id);
  let n = 0;
  for (const id of ids) {
    try {
      n += await ns.get(ns.idFromName(id)).stopAll(id, message);
    } catch (e) {
      console.error(`kill switch: stopping GitHub runners of ${id} failed`, e);
    }
  }
  return n;
}

type Actor = { id: string; login: string };
type Audit = (entry: { actorId?: string; actorLogin?: string; action: string; target?: string; detail?: unknown }) => Promise<void>;

/**
 * Suspend Actions for a repository or an account (`reason`), or lift the suspension (null), and
 * audit it as `actions.suspend` or `actions.unsuspend`. Suspending stops what runs now: every
 * unfinished run is cancelled and every open sandbox closed, in the repository or in each one
 * the account owns. Lifting what isn't suspended changes nothing and isn't audited.
 */
export async function changeSuspension(
  env: Env,
  audit: Audit,
  actor: Actor,
  target: { kind: "repo"; id: string; name: string } | { kind: "account"; id: string; login: string },
  reason: string | null,
  via: "api" | "web",
): Promise<Stopped | null> {
  const key = target.kind === "repo" ? { repoId: target.id } : { accountId: target.id };
  const label = target.kind === "repo" ? target.name : target.login;
  if (reason === null) {
    if (!(await suspensionOf(env, key))) return null;
    await setSuspension(env, key, null);
    await audit({ actorId: actor.id, actorLogin: actor.login, action: "actions.unsuspend", target: label, detail: { kind: target.kind, via } });
    return null;
  }
  await setSuspension(env, key, { reason, by: actor.login });
  const s = { at: now(), by: actor.login, reason };
  const message = blockedBy(target.kind === "repo" ? { repo: s, account: null, paused: null } : { repo: null, account: { ...s, login: target.login }, paused: null }, "run")!;
  let stopped: Stopped | null = null;
  try {
    const ids = target.kind === "repo" ? [target.id] : (await env.DB.prepare("SELECT id FROM repos WHERE owner_id = ?").bind(target.id).all<{ id: string }>()).results.map((r) => r.id);
    stopped = await stopIn(env, ids, { hostedOnly: false, message });
    if (target.kind === "account") stopped.jobs += await stopGitHubRunners(env, [target.id], message);
  } finally {
    // The switch is on even if stopping what ran failed: it is recorded either way.
    await audit({ actorId: actor.id, actorLogin: actor.login, action: "actions.suspend", target: label, detail: { kind: target.kind, reason, via, stopped } });
  }
  return stopped;
}

/**
 * Pause hosted compute on the instance (`reason`), or resume it (null), audited as
 * `compute.pause` or `compute.unpause`. Pausing stops the hosted jobs and sandboxes running now:
 * open compute_usage rows say which repositories to ask. Resuming what isn't paused changes nothing.
 */
export async function changePause(env: Env, audit: Audit, actor: Actor, reason: string | null, via: "api" | "web"): Promise<Stopped | null> {
  if (reason === null) {
    if (!(await computePause(env))) return null;
    await setComputePause(env, null);
    await audit({ actorId: actor.id, actorLogin: actor.login, action: "compute.unpause", detail: { via } });
    return null;
  }
  await setComputePause(env, { reason, by: actor.login });
  const message = blockedBy({ repo: null, account: null, paused: { at: now(), by: actor.login, reason } }, "hosted-job")!;
  let stopped: Stopped | null = null;
  try {
    stopped = await stopIn(env, [...(await runningCompute(env)).keys()], { hostedOnly: true, message });
    stopped.jobs += await stopGitHubRunners(env, null, message);
  } finally {
    await audit({ actorId: actor.id, actorLogin: actor.login, action: "compute.pause", detail: { reason, via, stopped } });
  }
  return stopped;
}
