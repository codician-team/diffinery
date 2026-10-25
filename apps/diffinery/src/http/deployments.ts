import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppContext, AppVars } from "../auth/principal.js";
import { HttpError } from "../lib/util.js";
import { parsePayload, type Deployment, type DeploymentReview, type DeploymentStatus, type Environment, type Reviewer } from "../repo/deployments.js";
import type { PendingDeployment } from "../repo/actions.js";
import type { Caller } from "../repo/types.js";
import { baseOf, ghUser, isoSeconds, nodeId, pageOf, paginate, repoApi, repoHtml, setLinks } from "./gh.js";
import { intParam, jsonBody, loadTarget, repoParams } from "./ghctx.js";
import { refuseAgent, WHILE_IMPORTING } from "./common.js";
import { resolveReviewers, reviewDeployments, viewerFor } from "./environment-reviews.js";

/** Deployments, deployment statuses and environments, with environment secrets and variables (GitHub REST). */
export const deployments = new Hono<{ Bindings: Env; Variables: AppVars }>();

const R = "/repos/:owner/:repo";
const load = (c: AppContext, min: "read" | "write" | "admin" = "read", opts: { whileImporting?: boolean } = {}) => loadTarget(c, min, opts);
const api = (c: AppContext) => repoApi(baseOf(c), repoParams(c).owner, repoParams(c).repo);
const envName = (c: AppContext) => (c.req.param("env") ?? "");

function deploymentJson(c: AppContext, d: Deployment): Record<string, unknown> {
  const url = `${api(c)}/deployments/${d.id}`;
  return {
    url,
    id: d.id,
    node_id: nodeId("Deployment", `${repoParams(c).owner}/${repoParams(c).repo}/${d.id}`),
    sha: d.sha,
    ref: d.ref,
    task: d.task,
    payload: parsePayload(d.payload),
    original_environment: d.originalEnvironment,
    environment: d.environment,
    description: d.description,
    creator: ghUser(baseOf(c), d.creator),
    created_at: isoSeconds(d.createdAt),
    updated_at: isoSeconds(d.updatedAt),
    statuses_url: `${url}/statuses`,
    repository_url: api(c),
    transient_environment: d.transient,
    production_environment: d.production,
    performed_via_github_app: null,
  };
}

function statusJson(c: AppContext, s: DeploymentStatus) {
  const dep = `${api(c)}/deployments/${s.deploymentId}`;
  return {
    url: `${dep}/statuses/${s.id}`,
    id: s.id,
    node_id: nodeId("DeploymentStatus", `${repoParams(c).owner}/${repoParams(c).repo}/${s.id}`),
    state: s.state,
    creator: ghUser(baseOf(c), s.creator),
    description: s.description,
    environment: s.environment,
    target_url: s.logUrl,
    log_url: s.logUrl,
    environment_url: s.environmentUrl,
    created_at: isoSeconds(s.createdAt),
    updated_at: isoSeconds(s.createdAt),
    deployment_url: dep,
    repository_url: api(c),
    performed_via_github_app: null,
  };
}

const reviewerJson = (c: AppContext, r: Reviewer) => ({ type: "User", reviewer: ghUser(baseOf(c), { id: r.id, login: r.login, kind: "user" }) });

/** An environment as the REST API shows it inside other objects (pending deployments, approvals). */
function environmentRef(c: AppContext, e: { id: number; name: string }) {
  return {
    id: e.id,
    node_id: nodeId("Environment", `${repoParams(c).owner}/${repoParams(c).repo}/${e.id}`),
    name: e.name,
    url: `${api(c)}/environments/${encodeURIComponent(e.name)}`,
    html_url: `${repoHtml(baseOf(c), repoParams(c).owner, repoParams(c).repo)}/settings/environments/${encodeURIComponent(e.name)}`,
  };
}

function environmentJson(c: AppContext, e: Environment) {
  const p = e.protection;
  const rules: Array<Record<string, unknown>> = [];
  if (p.waitTimer > 0) rules.push({ id: e.id * 10 + 1, node_id: nodeId("WaitTimer", e.id), type: "wait_timer", wait_timer: p.waitTimer });
  if (p.reviewers.length) rules.push({ id: e.id * 10 + 2, node_id: nodeId("RequiredReviewers", e.id), type: "required_reviewers", prevent_self_review: p.preventSelfReview, reviewers: p.reviewers.map((r) => reviewerJson(c, r)) });
  if (e.policy) rules.push({ id: e.id * 10 + 3, node_id: nodeId("BranchPolicy", e.id), type: "branch_policy" });
  return {
    ...environmentRef(c, e),
    created_at: isoSeconds(e.createdAt),
    updated_at: isoSeconds(e.updatedAt),
    // Nobody skips an environment's rules, admins included.
    can_admins_bypass: false,
    protection_rules: rules,
    deployment_branch_policy: e.policy ? { protected_branches: e.policy.protected_branches, custom_branch_policies: e.policy.custom_branch_policies } : null,
  };
}

function pendingJson(c: AppContext, p: PendingDeployment) {
  return {
    environment: environmentRef(c, p.environment),
    wait_timer: p.waitTimer,
    wait_timer_started_at: isoSeconds(p.waitTimerStartedAt),
    current_user_can_approve: p.currentUserCanApprove,
    reviewers: p.reviewers.map((r) => reviewerJson(c, r)),
  };
}

function approvalJson(c: AppContext, r: DeploymentReview, envs: Environment[]) {
  const e = envs.find((x) => x.name.toLowerCase() === r.environment.toLowerCase());
  return {
    url: `${api(c)}/actions/runs/${r.runId}/approvals`,
    environments: [environmentRef(c, e ?? { id: 0, name: r.environment })],
    state: r.state,
    user: ghUser(baseOf(c), { id: r.user.id, login: r.user.login, kind: "user" }),
    comment: r.comment,
  };
}

/** Environment secrets and settings are sensitive: changes go to the audit log. */
function audit(c: AppContext, caller: Caller, action: string, detail: Record<string, unknown>) {
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: caller.id, actorLogin: caller.login, onBehalfOf: caller.onBehalfOf, action, target: `${repoParams(c).owner}/${repoParams(c).repo}`, detail }));
}

// ---------------------------------------------------------------- deployments

deployments.get(`${R}/deployments`, async (c) => {
  const { stub } = await load(c);
  const p = pageOf(c);
  const q = (k: string) => c.req.query(k) || undefined;
  const res = await stub.deployments({ sha: q("sha"), ref: q("ref"), task: q("task"), environment: q("environment"), limit: p.perPage, offset: p.offset });
  setLinks(c, p, res.total);
  return c.json(res.items.map((d) => deploymentJson(c, d)));
});
deployments.post(`${R}/deployments`, async (c) => {
  const { stub, caller } = await load(c, "write");
  const b = await jsonBody<{ ref?: string; task?: string; auto_merge?: boolean; required_contexts?: unknown; payload?: unknown; environment?: string; description?: string | null; transient_environment?: boolean; production_environment?: boolean }>(c);
  if (b.required_contexts !== undefined && b.required_contexts !== null && (!Array.isArray(b.required_contexts) || b.required_contexts.length > 100 || b.required_contexts.some((x) => typeof x !== "string"))) {
    throw new HttpError(422, "required_contexts must be an array of strings", { errors: [{ resource: "Deployment", code: "invalid", field: "required_contexts" }] });
  }
  const required = Array.isArray(b.required_contexts) ? (b.required_contexts as string[]) : undefined;
  const d = await stub.createDeployment({ ref: b.ref, task: b.task, payload: b.payload, environment: b.environment, description: b.description, transient_environment: b.transient_environment, production_environment: b.production_environment, required_contexts: required }, caller);
  return c.json(deploymentJson(c, d), 201);
});
deployments.get(`${R}/deployments/:id`, async (c) => {
  const { stub } = await load(c);
  return c.json(deploymentJson(c, await stub.deployment(intParam(c, "id"))));
});
deployments.delete(`${R}/deployments/:id`, async (c) => {
  const { stub, caller } = await load(c, "write");
  await stub.deleteDeployment(intParam(c, "id"), caller);
  return c.body(null, 204);
});
deployments.get(`${R}/deployments/:id/statuses`, async (c) => {
  const { stub } = await load(c);
  return c.json(paginate(c, (await stub.deploymentStatuses(intParam(c, "id"))).map((s) => statusJson(c, s))));
});
deployments.post(`${R}/deployments/:id/statuses`, async (c) => {
  const { stub, caller } = await load(c, "write");
  const b = await jsonBody<{ state?: string; target_url?: string; log_url?: string; description?: string; environment?: string; environment_url?: string; auto_inactive?: boolean }>(c);
  return c.json(statusJson(c, await stub.createDeploymentStatus(intParam(c, "id"), b, caller)), 201);
});
deployments.get(`${R}/deployments/:id/statuses/:status`, async (c) => {
  const { stub } = await load(c);
  return c.json(statusJson(c, await stub.deploymentStatus(intParam(c, "id"), intParam(c, "status"))));
});

// ---------------------------------------------------------------- environments

deployments.get(`${R}/environments`, async (c) => {
  const { stub } = await load(c);
  const all = await stub.environments();
  return c.json({ total_count: all.length, environments: paginate(c, all).map((e) => environmentJson(c, e)) });
});
deployments.get(`${R}/environments/:env`, async (c) => {
  const { stub } = await load(c);
  return c.json(environmentJson(c, await stub.environment(envName(c))));
});
deployments.put(`${R}/environments/:env`, async (c) => {
  const { stub, caller, repo } = await load(c, "admin", WHILE_IMPORTING);
  const b = await jsonBody<{ wait_timer?: unknown; reviewers?: unknown; deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null; prevent_self_review?: unknown }>(c, true);
  if (caller.kind === "agent") throw new HttpError(403, "only repository admins (people, not agents) can manage environments");
  const reviewers = await resolveReviewers(c, repo, b.reviewers);
  const e = await stub.upsertEnvironment(envName(c), { ...b, reviewers }, caller);
  audit(c, caller, "environment.update", {
    environment: e.name,
    deployment_branch_policy: b.deployment_branch_policy ?? null,
    ...(reviewers !== undefined ? { reviewers: (reviewers ?? []).map((r) => r.login) } : {}),
    ...(b.wait_timer !== undefined ? { wait_timer: b.wait_timer } : {}),
    ...(b.prevent_self_review !== undefined ? { prevent_self_review: b.prevent_self_review } : {}),
  });
  return c.json(environmentJson(c, e));
});
deployments.delete(`${R}/environments/:env`, async (c) => {
  const { stub, caller } = await load(c, "admin", WHILE_IMPORTING);
  await stub.deleteEnvironment(envName(c), caller);
  audit(c, caller, "environment.delete", { environment: envName(c) });
  return c.body(null, 204);
});
deployments.get(`${R}/environments/:env/deployment-branch-policies`, async (c) => {
  const { stub } = await load(c);
  const e = await stub.environment(envName(c));
  const list = e.policy?.patterns ?? [];
  return c.json({ total_count: list.length, branch_policies: paginate(c, list).map((p) => ({ ...p, node_id: nodeId("BranchPolicy", `${e.id}/${p.id}`) })) });
});
deployments.post(`${R}/environments/:env/deployment-branch-policies`, async (c) => {
  const { stub, caller } = await load(c, "admin", WHILE_IMPORTING);
  const b = await jsonBody<{ name?: string; type?: string }>(c);
  const p = await stub.addEnvironmentBranchPattern(envName(c), b, caller);
  audit(c, caller, "environment.branch_policy.create", { environment: envName(c), pattern: p.name, type: p.type });
  return c.json({ ...p, node_id: nodeId("BranchPolicy", p.id) });
});
deployments.delete(`${R}/environments/:env/deployment-branch-policies/:id`, async (c) => {
  const { stub, caller } = await load(c, "admin", WHILE_IMPORTING);
  await stub.removeEnvironmentBranchPattern(envName(c), intParam(c, "id"), caller);
  audit(c, caller, "environment.branch_policy.delete", { environment: envName(c), id: intParam(c, "id") });
  return c.body(null, 204);
});

// ---------------------------------------------------------------- environment secrets (names only, never values) and variables

deployments.get(`${R}/environments/:env/secrets`, async (c) => {
  const { stub } = await load(c, "admin");
  const list = await stub.environmentSecretNames(envName(c));
  return c.json({ total_count: list.length, secrets: paginate(c, list).map((s) => ({ name: s.name, created_at: isoSeconds(s.updatedAt), updated_at: isoSeconds(s.updatedAt) })) });
});
deployments.get(`${R}/environments/:env/secrets/:name`, async (c) => {
  const { stub } = await load(c, "admin");
  const s = (await stub.environmentSecretNames(envName(c))).find((x) => x.name === c.req.param("name").toUpperCase());
  if (!s) throw new HttpError(404, "Not Found");
  return c.json({ name: s.name, created_at: isoSeconds(s.updatedAt), updated_at: isoSeconds(s.updatedAt) });
});
deployments.put(`${R}/environments/:env/secrets/:name`, async (c) => {
  const { stub, caller } = await load(c, "admin", WHILE_IMPORTING);
  if (caller.kind === "agent") throw new HttpError(403, "agents cannot manage secrets");
  const b = await jsonBody<{ value?: string; encrypted_value?: string }>(c);
  if (typeof b.value !== "string" && typeof b.encrypted_value === "string") throw new HttpError(422, "encrypted_value (sealed box) is not supported yet: send the secret as `value` over HTTPS; it is encrypted at rest");
  if (typeof b.value !== "string") throw new HttpError(422, "value is required (send it over HTTPS; it is encrypted at rest)");
  const existed = (await stub.environmentSecretNames(envName(c))).some((x) => x.name === c.req.param("name").toUpperCase());
  await stub.setEnvironmentSecret(envName(c), c.req.param("name"), b.value, caller);
  audit(c, caller, "environment.secret.set", { environment: envName(c), name: c.req.param("name").toUpperCase() });
  return c.body(null, existed ? 204 : 201);
});
deployments.delete(`${R}/environments/:env/secrets/:name`, async (c) => {
  const { stub, caller } = await load(c, "admin", WHILE_IMPORTING);
  if (caller.kind === "agent") throw new HttpError(403, "agents cannot manage secrets");
  await stub.deleteEnvironmentSecret(envName(c), c.req.param("name"), caller);
  audit(c, caller, "environment.secret.delete", { environment: envName(c), name: c.req.param("name").toUpperCase() });
  return c.body(null, 204);
});

const variableJson = (v: { name: string; value: string; createdAt: string; updatedAt: string }) => ({ name: v.name, value: v.value, created_at: isoSeconds(v.createdAt), updated_at: isoSeconds(v.updatedAt) });

deployments.get(`${R}/environments/:env/variables`, async (c) => {
  const { stub } = await load(c, "write");
  const list = await stub.environmentVariables(envName(c));
  return c.json({ total_count: list.length, variables: paginate(c, list, 10).map(variableJson) });
});
deployments.get(`${R}/environments/:env/variables/:name`, async (c) => {
  const { stub } = await load(c, "write");
  const v = (await stub.environmentVariables(envName(c))).find((x) => x.name === c.req.param("name").toUpperCase());
  if (!v) throw new HttpError(404, "Not Found");
  return c.json(variableJson(v));
});
deployments.post(`${R}/environments/:env/variables`, async (c) => {
  const { stub, caller } = await load(c, "admin", WHILE_IMPORTING);
  refuseAgent(caller, "variables");
  const b = await jsonBody<{ name?: string; value?: string }>(c);
  if (typeof b.name !== "string" || typeof b.value !== "string") throw new HttpError(422, "name and value are required");
  if ((await stub.environmentVariables(envName(c))).some((x) => x.name === b.name!.toUpperCase())) throw new HttpError(409, "Already exists - Variable already exists");
  await stub.setEnvironmentVariable(envName(c), b.name, b.value, caller);
  audit(c, caller, "environment.variable.set", { environment: envName(c), name: b.name.toUpperCase() });
  return c.json({}, 201);
});
deployments.patch(`${R}/environments/:env/variables/:name`, async (c) => {
  const { stub, caller } = await load(c, "admin", WHILE_IMPORTING);
  refuseAgent(caller, "variables");
  const b = await jsonBody<{ name?: string; value?: string }>(c);
  const name = c.req.param("name");
  const all = await stub.environmentVariables(envName(c));
  const current = all.find((x) => x.name === name.toUpperCase());
  if (!current) throw new HttpError(404, "Not Found");
  const next = typeof b.name === "string" && b.name ? b.name : name;
  if (next.toUpperCase() !== name.toUpperCase() && all.some((x) => x.name === next.toUpperCase())) throw new HttpError(409, "Already exists - Variable already exists");
  await stub.setEnvironmentVariable(envName(c), next, typeof b.value === "string" ? b.value : current.value, caller);
  if (next.toUpperCase() !== name.toUpperCase()) await stub.setEnvironmentVariable(envName(c), name, null, caller);
  audit(c, caller, "environment.variable.set", { environment: envName(c), name: next.toUpperCase(), ...(next.toUpperCase() !== name.toUpperCase() ? { renamed_from: name.toUpperCase() } : {}) });
  return c.body(null, 204);
});
deployments.delete(`${R}/environments/:env/variables/:name`, async (c) => {
  const { stub, caller } = await load(c, "admin", WHILE_IMPORTING);
  refuseAgent(caller, "variables");
  await stub.setEnvironmentVariable(envName(c), c.req.param("name"), null, caller);
  audit(c, caller, "environment.variable.delete", { environment: envName(c), name: c.req.param("name").toUpperCase() });
  return c.body(null, 204);
});

// ---------------------------------------------------------------- deployments waiting on reviewers (pending deployments)

deployments.get(`${R}/actions/runs/:id/pending_deployments`, async (c) => {
  const { stub, repo } = await load(c);
  const viewer = await viewerFor(c, repo);
  return c.json((await stub.pendingDeployments(c.req.param("id"), viewer)).map((x) => pendingJson(c, x)));
});
deployments.post(`${R}/actions/runs/:id/pending_deployments`, async (c) => {
  const l = await load(c);
  const b = await jsonBody<{ environment_ids?: unknown; state?: unknown; comment?: unknown }>(c);
  const out = await reviewDeployments(c, l, c.req.param("id"), b);
  return c.json(out.deployments.map((d) => deploymentJson(c, d)));
});
deployments.get(`${R}/actions/runs/:id/approvals`, async (c) => {
  const { stub } = await load(c);
  const [reviews, envs] = await Promise.all([stub.deploymentReviews(c.req.param("id")), stub.environments()]);
  return c.json(reviews.map((r) => approvalJson(c, r, envs)));
});
