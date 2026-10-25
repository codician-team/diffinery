import type { Env } from "../env.js";
import { decryptAndReseal, encryptSecret } from "../lib/crypto.js";
import { HttpError, now } from "../lib/util.js";
import type { RepoDO } from "./RepoDO.js";
import { requiredCheck } from "./required.js";
import { atLeast, globToRegExp, type Caller } from "./types.js";

type DeploymentRow = {
  id: number;
  sha: string;
  ref: string;
  task: string;
  environment: string;
  original_environment: string;
  description: string | null;
  payload: string;
  transient: number;
  production: number;
  creator_id: string;
  creator_login: string;
  creator_kind: string;
  job_id: string | null;
  created_at: string;
  updated_at: string;
};

type StatusRow = {
  id: number;
  deployment_id: number;
  state: string;
  description: string;
  environment: string;
  environment_url: string;
  log_url: string;
  creator_id: string;
  creator_login: string;
  creator_kind: string;
  created_at: string;
};

type EnvironmentRow = { id: number; name: string; branch_policy: string | null; reviewers: string | null; wait_timer: number; prevent_self_review: number; created_at: string; updated_at: string };

type ReviewRow = { id: number; run_id: string; environment: string; state: "approved" | "rejected"; comment: string; user_id: string; user_login: string; created_at: string };

export type Person = { id: string; login: string; kind: string };

export type Deployment = {
  id: number;
  sha: string;
  ref: string;
  task: string;
  environment: string;
  originalEnvironment: string;
  description: string | null;
  /** The payload as JSON text (see parsePayload). */
  payload: string;
  transient: boolean;
  production: boolean;
  creator: Person;
  createdAt: string;
  updatedAt: string;
  /** State of the newest status, if any. */
  state: string | null;
};

export type DeploymentStatus = {
  id: number;
  deploymentId: number;
  state: string;
  description: string;
  environment: string;
  environmentUrl: string;
  logUrl: string;
  creator: Person;
  createdAt: string;
};

/** Which refs may deploy to an environment (GitHub's deployment branch policy). */
export type BranchPolicy = { protected_branches: boolean; custom_branch_policies: boolean; patterns: Array<{ id: number; name: string; type: "branch" | "tag" }> };

/**
 * Whether a job on `ref`, started by an actor of `actorKind`, may receive an
 * environment's secrets. Pull request refs never do: their code is whatever the
 * pull request says. Runs started by agents only do when the environment is
 * limited to protected branches, where changes need review.
 */
export function secretsAllowedFor(policy: BranchPolicy | null, ref: string, actorKind: string, rules: { agentsMayPush?: boolean } | null): boolean {
  if (ref.startsWith("refs/pull/")) return false;
  // "Protected" has to mean agents can't push there themselves: a rule that lets them push
  // straight to the branch would hand the environment's secrets to any agent run.
  if (actorKind === "agent") return !!policy?.protected_branches && !!rules && !rules.agentsMayPush;
  return true;
}

/** A required reviewer: a person with access to the repository (Diffinery has no teams). */
export type Reviewer = { type: "User"; id: string; login: string };

/** An environment's protection rules beyond its branch policy, as GitHub has them. */
export type Protection = { reviewers: Reviewer[]; waitTimer: number; preventSelfReview: boolean };

export type Environment = { id: number; name: string; policy: BranchPolicy | null; protection: Protection; createdAt: string; updatedAt: string };

/** One required reviewer's decision on an environment for a workflow run. */
export type DeploymentReview = { id: number; runId: string; environment: string; state: "approved" | "rejected"; comment: string; user: { id: string; login: string }; createdAt: string };

/** GitHub's limits: up to 6 required reviewers, and a wait timer of up to 30 days. */
export const MAX_REVIEWERS = 6;
export const MAX_WAIT_TIMER = 43_200;
/** A job waits this long for its environment's reviewers before it fails, as on GitHub. */
export const APPROVAL_DAYS = 30;
export const MAX_REVIEW_COMMENT = 4_000;

const STATES = new Set(["error", "failure", "inactive", "in_progress", "queued", "pending", "success"]);
const ENV_NAME = /^[^\x00-\x1f\x7f/\\]{1,255}$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const person = (id: string, login: string, kind: string): Person => ({ id, login, kind });

/** A deployment's payload: the JSON it was created with, or the raw string when it isn't JSON. */
export function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Deployments, deployment statuses and environments (with their own secrets
 * and variables). Workflow jobs with `environment:` record a deployment and
 * get that environment's secrets once its branch policy allows the ref.
 */
export class Deployments {
  constructor(
    private repo: RepoDO,
    private env: Env,
  ) {}

  private get sql() {
    return this.repo.sql;
  }

  private toDeployment(r: DeploymentRow): Deployment {
    const latest = this.sql.exec<{ state: string }>("SELECT state FROM deployment_statuses WHERE deployment_id = ? ORDER BY id DESC LIMIT 1", r.id).toArray()[0];
    return {
      id: r.id,
      sha: r.sha,
      ref: r.ref,
      task: r.task,
      environment: r.environment,
      originalEnvironment: r.original_environment,
      description: r.description,
      payload: r.payload,
      transient: !!r.transient,
      production: !!r.production,
      creator: person(r.creator_id, r.creator_login, r.creator_kind),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      state: latest?.state ?? null,
    };
  }

  private toStatus = (s: StatusRow): DeploymentStatus => ({
    id: s.id,
    deploymentId: s.deployment_id,
    state: s.state,
    description: s.description,
    environment: s.environment,
    environmentUrl: s.environment_url,
    logUrl: s.log_url,
    creator: person(s.creator_id, s.creator_login, s.creator_kind),
    createdAt: s.created_at,
  });

  private row(id: number): DeploymentRow {
    const r = this.sql.exec<DeploymentRow>("SELECT * FROM deployments WHERE id = ?", id).toArray()[0];
    if (!r) throw new HttpError(404, "deployment not found");
    return r;
  }

  private emit(type: "deployment" | "deployment_status", action: string, payload: Record<string, unknown>, caller: Pick<Caller, "id" | "login" | "kind" | "onBehalfOf">): void {
    const m = this.repo.meta;
    this.repo.emit({ type, action, repoId: m.repoId, owner: m.owner, repo: m.name, payload, actor: { id: caller.id, login: caller.login, kind: caller.kind, onBehalfOf: caller.onBehalfOf }, at: now() });
  }

  // ---------------------------------------------------------------- deployments

  async create(
    input: { ref?: string; task?: string; payload?: unknown; environment?: string; description?: string | null; transient_environment?: boolean; production_environment?: boolean; required_contexts?: string[] },
    caller: Caller,
    jobId: string | null = null,
  ): Promise<Deployment> {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "write access is required to create deployments");
    const ref = (input.ref ?? "").trim();
    if (!ref) throw new HttpError(422, "ref is required", { errors: [{ resource: "Deployment", code: "missing_field", field: "ref" }] });
    const sha = await this.repo.resolve(ref);
    if (!sha) throw new HttpError(422, `no ref found for: ${ref}`, { errors: [{ resource: "Deployment", code: "invalid", field: "ref" }] });
    const rawEnvironment = (input.environment ?? "production").trim();
    if (!ENV_NAME.test(rawEnvironment)) throw new HttpError(422, "invalid environment name");
    // Environment names are case-insensitive, as on GitHub: reuse the existing spelling.
    const environment = this.envRow(rawEnvironment)?.name ?? rawEnvironment;
    // Like GitHub: without required_contexts every context on the commit must have passed; [] skips the check.
    // Deployments a workflow job makes for its `environment:` are not checked (the job's own run is still going).
    if (jobId === null && (input.required_contexts === undefined || input.required_contexts.length)) {
      const entries = [...this.repo.statuses.asChecks(sha), ...this.repo.collab.checks(sha)];
      const contexts = input.required_contexts ?? [...new Set(entries.filter((e) => e.creatorKind !== "agent").map((e) => e.name))];
      const states = contexts.map((ctx) => ({ context: ctx, state: requiredCheck(ctx, entries).state }));
      const failing = states.filter((x) => x.state !== "success");
      if (failing.length) throw new HttpError(409, `Conflict: Commit status checks failed for ${ref}.`, { errors: failing.map((x) => ({ contexts: [x], resource: "Deployment", field: "required_contexts" })) });
    }
    this.ensureEnvironment(environment);
    const t = now();
    this.sql.exec(
      "INSERT INTO deployments (sha, ref, task, environment, original_environment, description, payload, transient, production, creator_id, creator_login, creator_kind, job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      sha,
      ref,
      (input.task || "deploy").slice(0, 100),
      environment,
      environment,
      input.description ? String(input.description).slice(0, 1000) : null,
      typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload ?? {}),
      input.transient_environment ? 1 : 0,
      (input.production_environment ?? environment.toLowerCase() === "production") ? 1 : 0,
      caller.id,
      caller.login,
      caller.kind,
      jobId,
      t,
      t,
    );
    const d = this.toDeployment(this.sql.exec<DeploymentRow>("SELECT * FROM deployments WHERE id = last_insert_rowid()").one());
    this.emit("deployment", "created", { deployment: { id: d.id, sha, ref, task: d.task, environment, description: d.description, payload: parsePayload(d.payload), created_at: t } }, caller);
    return d;
  }

  list(filter: { sha?: string; ref?: string; task?: string; environment?: string; limit: number; offset: number }): { items: Deployment[]; total: number } {
    const where: string[] = [];
    const args: unknown[] = [];
    for (const [col, v] of [["sha", filter.sha], ["ref", filter.ref], ["task", filter.task], ["environment", filter.environment]] as const) {
      if (v) {
        where.push(col === "environment" ? "environment = ? COLLATE NOCASE" : `${col} = ?`);
        args.push(v);
      }
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM deployments ${w}`, ...args).one().n;
    const rows = this.sql.exec<DeploymentRow>(`SELECT * FROM deployments ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, Math.min(filter.limit, 100), filter.offset).toArray();
    return { items: rows.map((r) => this.toDeployment(r)), total };
  }

  get(id: number): Deployment {
    return this.toDeployment(this.row(id));
  }

  remove(id: number, caller: Caller): void {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "write access is required to delete deployments");
    const d = this.get(id);
    const others = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM deployments WHERE environment = ? COLLATE NOCASE AND id != ?", d.environment, id).one().n;
    if (d.state === "success" && others > 0) throw new HttpError(422, "We cannot delete an active deployment unless it is the only deployment in a given environment.");
    this.sql.exec("DELETE FROM deployment_statuses WHERE deployment_id = ?", id);
    this.sql.exec("DELETE FROM deployments WHERE id = ?", id);
  }

  createStatus(
    id: number,
    input: { state?: string; target_url?: string; log_url?: string; description?: string; environment?: string; environment_url?: string; auto_inactive?: boolean },
    caller: Pick<Caller, "id" | "login" | "kind" | "onBehalfOf" | "role">,
  ): DeploymentStatus {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "write access is required to create deployment statuses");
    const d = this.row(id);
    const state = String(input.state ?? "");
    if (!STATES.has(state)) throw new HttpError(422, "state must be one of error, failure, inactive, in_progress, queued, pending, success", { errors: [{ resource: "DeploymentStatus", code: "invalid", field: "state" }] });
    const urls = [input.log_url ?? input.target_url ?? "", input.environment_url ?? ""];
    for (const u of urls) if (u && !/^https?:\/\//i.test(u)) throw new HttpError(422, "URLs must be http(s)");
    let environment = input.environment?.trim() || d.environment;
    if (environment.toLowerCase() === d.environment.toLowerCase()) environment = d.environment;
    else {
      if (!ENV_NAME.test(environment)) throw new HttpError(422, "invalid environment name");
      environment = this.ensureEnvironment(environment).name;
      this.sql.exec("UPDATE deployments SET environment = ? WHERE id = ?", environment, id);
    }
    const t = now();
    this.sql.exec(
      "INSERT INTO deployment_statuses (deployment_id, state, description, environment, environment_url, log_url, creator_id, creator_login, creator_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      state,
      (input.description ?? "").slice(0, 140),
      environment,
      urls[1],
      urls[0],
      caller.id,
      caller.login,
      caller.kind,
      t,
    );
    const statusId = this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id;
    this.sql.exec("UPDATE deployments SET updated_at = ? WHERE id = ?", t, id);
    if (state === "success" && input.auto_inactive !== false) {
      // Older non-transient, non-production deployments to the same environment become inactive (newer ones stay as they are).
      const older = this.sql.exec<{ id: number }>("SELECT id FROM deployments WHERE environment = ? COLLATE NOCASE AND id < ? AND transient = 0 AND production = 0", environment, id).toArray();
      for (const o of older) {
        const last = this.sql.exec<{ state: string }>("SELECT state FROM deployment_statuses WHERE deployment_id = ? ORDER BY id DESC LIMIT 1", o.id).toArray()[0];
        if (last?.state === "success") {
          this.sql.exec(
            "INSERT INTO deployment_statuses (deployment_id, state, description, environment, creator_id, creator_login, creator_kind, created_at) VALUES (?, 'inactive', '', ?, ?, ?, ?, ?)",
            o.id,
            environment,
            caller.id,
            caller.login,
            caller.kind,
            t,
          );
        }
      }
    }
    const status = this.status(id, statusId);
    this.emit("deployment_status", "created", { deployment_status: { id: statusId, state, description: status.description, environment, environment_url: status.environmentUrl, log_url: status.logUrl, created_at: t }, deployment: { id, sha: d.sha, ref: d.ref, task: d.task, environment } }, caller);
    return status;
  }

  statuses(id: number): DeploymentStatus[] {
    this.row(id);
    return this.sql.exec<StatusRow>("SELECT * FROM deployment_statuses WHERE deployment_id = ? ORDER BY id DESC", id).toArray().map(this.toStatus);
  }

  status(id: number, statusId: number): DeploymentStatus {
    const s = this.sql.exec<StatusRow>("SELECT * FROM deployment_statuses WHERE deployment_id = ? AND id = ?", id, statusId).toArray()[0];
    if (!s) throw new HttpError(404, "deployment status not found");
    return this.toStatus(s);
  }

  // ---------------------------------------------------------------- environments

  /** Environments guard deployment secrets, so only people with admin access change them, never agents. */
  private requireHumanAdmin(caller: Caller): void {
    if (!atLeast(caller.role, "admin") || caller.kind === "agent") throw new HttpError(403, "only repository admins (people, not agents) can manage environments");
  }

  /** Remember who last moved a tag: tags created by agents never satisfy environment tag patterns. */
  noteRefUpdate(ref: string, newOid: string, caller: Pick<Caller, "id" | "kind">): void {
    if (!ref.startsWith("refs/tags/")) return;
    if (/^0+$/.test(newOid)) this.sql.exec("DELETE FROM ref_actors WHERE ref = ?", ref);
    else this.sql.exec("INSERT OR REPLACE INTO ref_actors (ref, actor_id, actor_kind, updated_at) VALUES (?, ?, ?, ?)", ref, caller.id, caller.kind, now());
  }

  private tagByAgent(tag: string): boolean {
    return this.sql.exec<{ actor_kind: string }>("SELECT actor_kind FROM ref_actors WHERE ref = ?", `refs/tags/${tag}`).toArray()[0]?.actor_kind === "agent";
  }

  private envRow(name: string): EnvironmentRow | undefined {
    return this.sql.exec<EnvironmentRow>("SELECT * FROM environments WHERE name = ?", name).toArray()[0];
  }

  private toEnvironment = (r: EnvironmentRow): Environment => ({
    id: r.id,
    name: r.name,
    policy: r.branch_policy ? (JSON.parse(r.branch_policy) as BranchPolicy) : null,
    protection: { reviewers: r.reviewers ? (JSON.parse(r.reviewers) as Reviewer[]) : [], waitTimer: r.wait_timer ?? 0, preventSelfReview: !!r.prevent_self_review },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  private ensureEnvironment(name: string): EnvironmentRow {
    const existing = this.envRow(name);
    if (existing) return existing;
    const t = now();
    this.sql.exec("INSERT INTO environments (name, created_at, updated_at) VALUES (?, ?, ?)", name, t, t);
    return this.envRow(name)!;
  }

  environments(): Environment[] {
    return this.sql.exec<EnvironmentRow>("SELECT * FROM environments ORDER BY name").toArray().map(this.toEnvironment);
  }

  environment(name: string): Environment {
    const r = this.envRow(name);
    if (!r) throw new HttpError(404, "environment not found");
    return this.toEnvironment(r);
  }

  /**
   * Create or update an environment. `reviewers` arrive resolved to people (http/environments.ts
   * checks each is a person with access); a field left out keeps its value.
   */
  upsertEnvironment(
    name: string,
    input: { wait_timer?: unknown; reviewers?: Reviewer[] | null; prevent_self_review?: unknown; deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null },
    caller: Caller,
  ): Environment {
    this.requireHumanAdmin(caller);
    if (!ENV_NAME.test(name)) throw new HttpError(422, "invalid environment name");
    if (input.wait_timer !== undefined && input.wait_timer !== null && (typeof input.wait_timer !== "number" || !Number.isInteger(input.wait_timer) || input.wait_timer < 0 || input.wait_timer > MAX_WAIT_TIMER)) {
      throw new HttpError(422, `wait_timer must be a whole number of minutes from 0 to ${MAX_WAIT_TIMER}`);
    }
    if (input.prevent_self_review !== undefined && input.prevent_self_review !== null && typeof input.prevent_self_review !== "boolean") throw new HttpError(422, "prevent_self_review must be true or false");
    if (input.reviewers) {
      if (input.reviewers.length > MAX_REVIEWERS) throw new HttpError(422, `an environment can have at most ${MAX_REVIEWERS} required reviewers`);
      if (input.reviewers.some((r) => r.type !== "User" || typeof r.id !== "string" || typeof r.login !== "string")) throw new HttpError(422, "reviewers must be people");
    }
    const row = this.ensureEnvironment(name);
    if (input.wait_timer !== undefined && input.wait_timer !== null) this.sql.exec("UPDATE environments SET wait_timer = ?, updated_at = ? WHERE id = ?", input.wait_timer, now(), row.id);
    if (input.prevent_self_review !== undefined && input.prevent_self_review !== null) this.sql.exec("UPDATE environments SET prevent_self_review = ?, updated_at = ? WHERE id = ?", input.prevent_self_review ? 1 : 0, now(), row.id);
    if (input.reviewers !== undefined) {
      const unique = [...new Map((input.reviewers ?? []).map((r) => [r.id, { type: "User" as const, id: r.id, login: r.login }])).values()];
      this.sql.exec("UPDATE environments SET reviewers = ?, updated_at = ? WHERE id = ?", unique.length ? JSON.stringify(unique) : null, now(), row.id);
    }
    if (input.deployment_branch_policy !== undefined) {
      const p = input.deployment_branch_policy;
      if (p && !!p.protected_branches === !!p.custom_branch_policies) throw new HttpError(422, "set exactly one of protected_branches and custom_branch_policies");
      const old = row.branch_policy ? (JSON.parse(row.branch_policy) as BranchPolicy) : null;
      const policy: BranchPolicy | null = p ? { protected_branches: !!p.protected_branches, custom_branch_policies: !!p.custom_branch_policies, patterns: p.custom_branch_policies ? (old?.patterns ?? []) : [] } : null;
      this.sql.exec("UPDATE environments SET branch_policy = ?, updated_at = ? WHERE id = ?", policy ? JSON.stringify(policy) : null, now(), row.id);
    }
    return this.environment(name);
  }

  /** The environment's reviewers and wait timer, or null when it has neither (its jobs then start at once). */
  protection(name: string): Protection | null {
    const r = this.envRow(name);
    if (!r) return null;
    const p = this.toEnvironment(r).protection;
    return p.reviewers.length || p.waitTimer > 0 ? p : null;
  }

  /** Record a reviewer's decision for a run's environment (the caller checked who may decide). */
  addReview(runId: string, environment: string, state: "approved" | "rejected", comment: string, user: { id: string; login: string }): DeploymentReview {
    const t = now();
    this.sql.exec("INSERT INTO deployment_reviews (run_id, environment, state, comment, user_id, user_login, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", runId, environment, state, comment.slice(0, MAX_REVIEW_COMMENT), user.id, user.login, t);
    return this.toReview(this.sql.exec<ReviewRow>("SELECT * FROM deployment_reviews WHERE id = last_insert_rowid()").one());
  }

  /** The decision on a run's environment so far: the first one counts, as on GitHub. */
  decision(runId: string, environment: string): "approved" | "rejected" | null {
    return this.sql.exec<{ state: "approved" | "rejected" }>("SELECT state FROM deployment_reviews WHERE run_id = ? AND environment = ? COLLATE NOCASE ORDER BY id LIMIT 1", runId, environment).toArray()[0]?.state ?? null;
  }

  /** The deployments workflow jobs recorded, newest first. */
  jobDeployments(jobIds: string[]): Deployment[] {
    if (!jobIds.length) return [];
    return this.sql.exec<DeploymentRow>(`SELECT * FROM deployments WHERE job_id IN (${jobIds.map(() => "?").join(",")}) ORDER BY id DESC`, ...jobIds).toArray().map((r) => this.toDeployment(r));
  }

  reviews(runId: string): DeploymentReview[] {
    return this.sql.exec<ReviewRow>("SELECT * FROM deployment_reviews WHERE run_id = ? ORDER BY id", runId).toArray().map((r) => this.toReview(r));
  }

  private toReview = (r: ReviewRow): DeploymentReview => ({ id: r.id, runId: r.run_id, environment: r.environment, state: r.state, comment: r.comment, user: { id: r.user_id, login: r.user_login }, createdAt: r.created_at });

  deleteEnvironment(name: string, caller: Caller): void {
    this.requireHumanAdmin(caller);
    this.environment(name);
    this.sql.exec("DELETE FROM environments WHERE name = ?", name);
    this.sql.exec("DELETE FROM environment_secrets WHERE environment = ?", name);
    this.sql.exec("DELETE FROM environment_variables WHERE environment = ?", name);
  }

  addBranchPattern(name: string, pattern: { name?: string; type?: string }, caller: Caller): { id: number; name: string; type: "branch" | "tag" } {
    this.requireHumanAdmin(caller);
    const env = this.environment(name);
    if (!env.policy?.custom_branch_policies) throw new HttpError(422, "enable custom_branch_policies on the environment first");
    const p = { id: Math.max(0, ...env.policy.patterns.map((x) => x.id)) + 1, name: String(pattern.name ?? "").trim(), type: pattern.type === "tag" ? ("tag" as const) : ("branch" as const) };
    if (!p.name) throw new HttpError(422, "name is required");
    env.policy.patterns.push(p);
    this.sql.exec("UPDATE environments SET branch_policy = ?, updated_at = ? WHERE id = ?", JSON.stringify(env.policy), now(), env.id);
    return p;
  }

  removeBranchPattern(name: string, id: number, caller: Caller): void {
    this.requireHumanAdmin(caller);
    const env = this.environment(name);
    if (!env.policy) throw new HttpError(404, "branch policy not found");
    env.policy.patterns = env.policy.patterns.filter((x) => x.id !== id);
    this.sql.exec("UPDATE environments SET branch_policy = ?, updated_at = ? WHERE id = ?", JSON.stringify(env.policy), now(), env.id);
  }

  /** Whether a run on `ref` may use the environment (and see its secrets). */
  refAllowed(name: string, ref: string): boolean {
    const r = this.envRow(name);
    const policy = r?.branch_policy ? (JSON.parse(r.branch_policy) as BranchPolicy) : null;
    if (!policy) return true;
    const branch = ref.startsWith("refs/heads/") ? ref.slice(11) : null;
    const tag = ref.startsWith("refs/tags/") ? ref.slice(10) : null;
    if (policy.protected_branches) return !!branch && !!this.repo.protectionFor(branch);
    return policy.patterns.some((p) => (p.type === "tag" ? tag !== null && !this.tagByAgent(tag) && globToRegExp(p.name).test(tag) : branch !== null && globToRegExp(p.name).test(branch)));
  }

  /** Whether a job may receive the environment's secrets (it already passed refAllowed); see secretsAllowedFor. */
  secretsAllowed(name: string, ref: string, actorKind: string): boolean {
    const r = this.envRow(name);
    const rules = ref.startsWith("refs/heads/") ? this.repo.protectionFor(ref.slice(11)) : null;
    return secretsAllowedFor(r?.branch_policy ? (JSON.parse(r.branch_policy) as BranchPolicy) : null, ref, actorKind, rules);
  }

  // ---------------------------------------------------------------- environment secrets and variables

  private scope(name: string): string {
    return `repo:${this.repo.meta.repoId}:env:${name.toLowerCase()}`;
  }

  async setSecret(envName: string, name: string, value: string, caller: Caller): Promise<void> {
    if (!atLeast(caller.role, "admin") || caller.kind === "agent") throw new HttpError(403, "only repository admins (people, not agents) can manage secrets");
    if (!SECRET_NAME.test(name) || /^GITHUB_/i.test(name)) throw new HttpError(422, "invalid secret name");
    const env = this.environment(envName);
    // An environment holding secrets defaults to protected branches only, like a fresh GitHub environment should be.
    if (!env.policy) this.sql.exec("UPDATE environments SET branch_policy = ?, updated_at = ? WHERE id = ?", JSON.stringify({ protected_branches: true, custom_branch_policies: false, patterns: [] } satisfies BranchPolicy), now(), env.id);
    this.sql.exec("INSERT OR REPLACE INTO environment_secrets (environment, name, ciphertext, updated_at) VALUES (?, ?, ?, ?)", env.name, name.toUpperCase(), await encryptSecret(this.env, this.scope(env.name), value), now());
  }

  deleteSecret(envName: string, name: string, caller: Caller): void {
    if (!atLeast(caller.role, "admin") || caller.kind === "agent") throw new HttpError(403, "only repository admins (people, not agents) can manage secrets");
    this.sql.exec("DELETE FROM environment_secrets WHERE environment = ? AND name = ?", envName, name.toUpperCase());
  }

  secretNames(envName: string): Array<{ name: string; updatedAt: string }> {
    this.environment(envName);
    return this.sql.exec<{ name: string; updated_at: string }>("SELECT name, updated_at FROM environment_secrets WHERE environment = ? ORDER BY name", envName).toArray().map((r) => ({ name: r.name, updatedAt: r.updated_at }));
  }

  setVariable(envName: string, name: string, value: string | null, caller: Caller, mustExist = false): void {
    if (!atLeast(caller.role, "admin")) throw new HttpError(403, "admin access is required to manage variables");
    const env = this.environment(envName);
    const key = name.toUpperCase();
    if (value === null) {
      this.sql.exec("DELETE FROM environment_variables WHERE environment = ? AND name = ?", env.name, key);
      return;
    }
    if (!SECRET_NAME.test(name) || /^GITHUB_/i.test(name)) throw new HttpError(422, "invalid variable name");
    const existing = this.sql.exec("SELECT 1 FROM environment_variables WHERE environment = ? AND name = ?", env.name, key).toArray().length > 0;
    if (mustExist && !existing) throw new HttpError(404, "variable not found");
    const t = now();
    if (existing) this.sql.exec("UPDATE environment_variables SET value = ?, updated_at = ? WHERE environment = ? AND name = ?", value, t, env.name, key);
    else this.sql.exec("INSERT INTO environment_variables (environment, name, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", env.name, key, value, t, t);
  }

  variables(envName: string): Array<{ name: string; value: string; createdAt: string; updatedAt: string }> {
    this.environment(envName);
    return this.sql
      .exec<{ name: string; value: string; created_at: string; updated_at: string }>("SELECT * FROM environment_variables WHERE environment = ? ORDER BY name", envName)
      .toArray()
      .map((r) => ({ name: r.name, value: r.value, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  // ---------------------------------------------------------------- workflow jobs with `environment:`

  /**
   * Called when a job starts waiting on its environment's protection rules: records its
   * deployment with a `waiting` status, as GitHub shows a deployment waiting for review.
   */
  jobWaiting(job: { id: string; ref: string; sha: string; logUrl: string; actor: Person }, name: string): void {
    if (this.sql.exec("SELECT 1 FROM deployments WHERE job_id = ?", job.id).toArray().length) return;
    const env = this.ensureEnvironment(name).name;
    const system: Caller = { ...job.actor, kind: job.actor.kind as Caller["kind"], role: "write" };
    const id = this.insertJobDeployment(job, env);
    const t = now();
    // Not a state the REST API accepts from clients; GitHub reports it the same way for deployments waiting for review.
    this.sql.exec(
      "INSERT INTO deployment_statuses (deployment_id, state, description, environment, log_url, creator_id, creator_login, creator_kind, created_at) VALUES (?, 'waiting', ?, ?, ?, ?, ?, ?, ?)",
      id,
      "Waiting for the environment's protection rules",
      env,
      job.logUrl,
      system.id,
      system.login,
      system.kind,
      t,
    );
  }

  private insertJobDeployment(job: { id: string; ref: string; sha: string; actor: Person }, name: string): number {
    const t = now();
    const ref = job.ref.replace(/^refs\/(heads|tags)\//, "");
    this.sql.exec(
      "INSERT INTO deployments (sha, ref, task, environment, original_environment, payload, production, creator_id, creator_login, creator_kind, job_id, created_at, updated_at) VALUES (?, ?, 'deploy', ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)",
      job.sha,
      ref,
      name,
      name,
      name.toLowerCase() === "production" ? 1 : 0,
      job.actor.id,
      job.actor.login,
      job.actor.kind,
      job.id,
      t,
      t,
    );
    const id = this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id;
    const system: Caller = { ...job.actor, kind: job.actor.kind as Caller["kind"], role: "write" };
    this.emit("deployment", "created", { deployment: { id, sha: job.sha, ref, task: "deploy", environment: name, description: null, payload: {}, created_at: t } }, system);
    return id;
  }

  /**
   * Called when a job with `environment:` starts: checks the environment's
   * branch policy, records a deployment with an in_progress status, and
   * returns the environment's secrets and variables for the job.
   */
  async jobStarted(job: { id: string; ref: string; sha: string; logUrl: string; actor: Person }, environment: { name: string; url?: string }): Promise<{ secrets: Record<string, string>; vars: Record<string, string> }> {
    const raw = environment.name.trim();
    if (!ENV_NAME.test(raw)) throw new HttpError(422, `invalid environment name '${raw}'`);
    const name = this.ensureEnvironment(raw).name;
    if (!this.refAllowed(name, job.ref)) throw new HttpError(403, `${job.ref.replace(/^refs\/(heads|tags)\//, "")} is not allowed to deploy to ${name} due to environment protection rules.`);
    const system: Caller = { ...job.actor, kind: job.actor.kind as Caller["kind"], role: "write" };
    const existing = this.sql.exec<{ id: number }>("SELECT id FROM deployments WHERE job_id = ?", job.id).toArray()[0];
    const environmentUrl = environment.url && /^https?:\/\//i.test(environment.url) ? environment.url : undefined;
    if (!existing) this.createStatus(this.insertJobDeployment(job, name), { state: "in_progress", log_url: job.logUrl, environment_url: environmentUrl }, system);
    else if (this.sql.exec<{ state: string }>("SELECT state FROM deployment_statuses WHERE deployment_id = ? ORDER BY id DESC LIMIT 1", existing.id).toArray()[0]?.state === "waiting") {
      // Its protection rules passed: the deployment it recorded while waiting goes on.
      this.createStatus(existing.id, { state: "in_progress", log_url: job.logUrl, environment_url: environmentUrl }, system);
    }
    const secrets: Record<string, string> = {};
    const rows = this.secretsAllowed(name, job.ref, job.actor.kind) ? this.sql.exec<{ name: string; ciphertext: string }>("SELECT name, ciphertext FROM environment_secrets WHERE environment = ?", name).toArray() : [];
    for (const r of rows) {
      secrets[r.name] = await decryptAndReseal(this.env, this.scope(name), r.ciphertext, (sealed) =>
        this.sql.exec("UPDATE environment_secrets SET ciphertext = ? WHERE environment = ? AND name = ? AND ciphertext = ?", sealed, name, r.name, r.ciphertext),
      );
    }
    const vars = Object.fromEntries(this.sql.exec<{ name: string; value: string }>("SELECT name, value FROM environment_variables WHERE environment = ?", name).toArray().map((r) => [r.name, r.value]));
    return { secrets, vars };
  }

  /** Called when a job finishes: the deployment it recorded gets a final status. */
  jobCompleted(jobId: string, conclusion: string | null): void {
    const d = this.sql.exec<DeploymentRow>("SELECT * FROM deployments WHERE job_id = ?", jobId).toArray()[0];
    if (!d) return;
    const last = this.sql.exec<StatusRow>("SELECT * FROM deployment_statuses WHERE deployment_id = ? ORDER BY id DESC LIMIT 1", d.id).toArray()[0];
    const state = conclusion === "success" ? "success" : conclusion === "cancelled" || conclusion === "skipped" ? "inactive" : "failure";
    this.createStatus(d.id, { state, log_url: last?.log_url || undefined, environment_url: last?.environment_url || undefined }, { id: d.creator_id, login: d.creator_login, kind: d.creator_kind as Caller["kind"], role: "write" });
  }
}
