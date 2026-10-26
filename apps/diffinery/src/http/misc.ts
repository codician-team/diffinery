import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppContext, AppVars } from "../auth/principal.js";
import { HttpError } from "../lib/util.js";
import { baseOf, ghRun, isoSeconds, nodeId, normalizeTopics, repoApi, repoHtml, workflowNumber } from "./gh.js";
import { intParam, jsonBody, loadTarget, repoParams } from "./ghctx.js";
import { auditRepo, refuseAgent, WHILE_IMPORTING } from "./common.js";

/**
 * Smaller GitHub endpoints scripts and actions call: rate limits, topics,
 * repository_dispatch, workflow details, run attempts and log archives, and
 * the POST/PATCH/GET forms of repository variables.
 */
export const misc = new Hono<{ Bindings: Env; Variables: AppVars }>();

const R = "/repos/:owner/:repo";
const load = (c: AppContext, min: "read" | "write" | "admin" = "read", opts: { whileImporting?: boolean } = {}) => loadTarget(c, min, opts);

// Diffinery doesn't meter API calls; report a generous, constant budget so clients that check it carry on.
const LIMIT = 15_000;
misc.get("/rate_limit", (c) => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const r = (limit: number) => ({ limit, used: 0, remaining: limit, reset });
  return c.json({ resources: { core: r(LIMIT), search: r(1000), graphql: r(LIMIT), integration_manifest: r(LIMIT), code_search: r(1000), actions_runner_registration: r(LIMIT) }, rate: r(LIMIT) });
});

// ---------------------------------------------------------------- topics

misc.get(`${R}/topics`, async (c) => {
  const { repo } = await load(c);
  let names: string[] = [];
  try {
    names = JSON.parse(repo.topics ?? "[]");
  } catch {
    names = [];
  }
  return c.json({ names });
});
misc.put(`${R}/topics`, async (c) => {
  const { repo, caller } = await load(c, "admin");
  const b = await jsonBody<{ names?: unknown }>(c);
  if (!Array.isArray(b.names)) throw new HttpError(422, "names must be an array", { errors: [{ resource: "Repository", code: "invalid", field: "names" }] });
  const names = normalizeTopics(b.names);
  await c.get("dir").setTopics(repo.id, names);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: caller.id, actorLogin: caller.login, onBehalfOf: caller.onBehalfOf, action: "repo.topics", target: `${repo.owner_login}/${repo.name}`, detail: { names } }));
  return c.json({ names });
});

// ---------------------------------------------------------------- repository_dispatch

misc.post(`${R}/dispatches`, async (c) => {
  const { stub, caller } = await load(c, "write");
  const b = await jsonBody<{ event_type?: string; client_payload?: unknown }>(c);
  if (typeof b.event_type !== "string" || !b.event_type || b.event_type.length > 100) throw new HttpError(422, "event_type is required (at most 100 characters)", { errors: [{ resource: "Repository", code: "invalid", field: "event_type" }] });
  const payload = b.client_payload ?? {};
  if (typeof payload !== "object" || Array.isArray(payload)) throw new HttpError(422, "client_payload must be an object");
  if (Object.keys(payload).length > 10) throw new HttpError(422, "client_payload can have at most 10 top-level properties");
  if (JSON.stringify(payload).length > 64 * 1024) throw new HttpError(422, "client_payload is too large");
  await stub.repositoryDispatch(b.event_type, payload as Record<string, unknown>, caller);
  return c.body(null, 204);
});

// ---------------------------------------------------------------- workflows

async function findWorkflow(c: AppContext) {
  const { stub } = await load(c);
  const id = (c.req.param("workflow") ?? "");
  const wfs = await stub.workflows();
  const wf = wfs.find((w) => w.path === id || w.path.endsWith(`/${id}`)) ?? (/^\d+$/.test(id) ? wfs.find((w) => workflowNumber(w.path) === Number(id)) : undefined);
  if (!wf) throw new HttpError(404, "Not Found");
  return { stub, wf };
}

misc.get(`${R}/actions/workflows/:workflow`, async (c) => {
  const { wf } = await findWorkflow(c);
  const b = baseOf(c);
  const { owner, repo } = repoParams(c);
  const now = isoSeconds(new Date().toISOString());
  return c.json({
    id: workflowNumber(wf.path),
    node_id: nodeId("Workflow", `${owner}/${repo}/${wf.path}`),
    name: wf.name,
    path: wf.path,
    state: wf.errors.length ? "invalid" : "active",
    created_at: now,
    updated_at: now,
    url: `${repoApi(b, owner, repo)}/actions/workflows/${workflowNumber(wf.path)}`,
    html_url: `${repoHtml(b, owner, repo)}/blob/HEAD/${wf.path}`,
    badge_url: `${repoHtml(b, owner, repo)}/workflows/${encodeURIComponent(wf.name)}/badge.svg`,
    errors: wf.errors,
    triggers: wf.triggers,
  });
});

misc.get(`${R}/actions/workflows/:workflow/runs`, async (c) => {
  const { stub, wf } = await findWorkflow(c);
  const perPage = Math.min(Math.max(Number(c.req.query("per_page")) || 30, 1), 100);
  const page = Math.max(Number(c.req.query("page")) || 1, 1);
  const res = await stub.runs({ workflow: wf.path, branch: c.req.query("branch"), status: c.req.query("status"), event: c.req.query("event"), sha: c.req.query("head_sha"), limit: perPage, offset: (page - 1) * perPage });
  return c.json({ total_count: res.total, workflow_runs: res.runs.map((r) => ghRun(baseOf(c), repoParams(c).owner, repoParams(c).repo, r)) });
});

// ---------------------------------------------------------------- runs: attempts and logs

misc.get(`${R}/actions/runs/:id/attempts/:attempt`, async (c) => {
  const { stub } = await load(c);
  const id = await stub.runAttemptId(c.req.param("id"), intParam(c, "attempt"));
  return c.json(ghRun(baseOf(c), repoParams(c).owner, repoParams(c).repo, await stub.run(id)));
});

misc.get(`${R}/actions/runs/:id/logs`, async (c) => {
  const { stub } = await load(c);
  const zip = await stub.runLogsZip(c.req.param("id"));
  return new Response(zip, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="logs_${c.req.param("id").replace(/[^\w-]/g, "")}.zip"` } });
});
// GitHub's "delete workflow run logs" (repo/actions.ts deleteLogs): 204, and the deletion is audited.
misc.delete(`${R}/actions/runs/:id/logs`, async (c) => {
  const { stub, caller, repo } = await load(c, "write");
  const jobs = await stub.deleteRunLogs(c.req.param("id"), caller);
  auditRepo(c, caller, repo, "repo.actions.logs.delete", { run: c.req.param("id"), jobs: jobs.length });
  return c.body(null, 204);
});

// ---------------------------------------------------------------- repository variables (GitHub's POST/GET/PATCH forms)
// These see only the repository's own variables: organization variables are read and changed under
// /orgs/:org/actions/variables, and a repository variable of the same name overrides one in workflows.

misc.get(`${R}/actions/variables/:name`, async (c) => {
  const { stub } = await load(c, "write");
  const name = c.req.param("name").toUpperCase();
  const vars = await stub.variables(false);
  if (!(name in vars)) throw new HttpError(404, "Not Found");
  return c.json({ name, value: vars[name], created_at: null, updated_at: null });
});
misc.post(`${R}/actions/variables`, async (c) => {
  const { stub, caller, repo } = await load(c, "admin", WHILE_IMPORTING);
  refuseAgent(caller, "variables");
  const b = await jsonBody<{ name?: string; value?: string }>(c);
  if (typeof b.name !== "string" || typeof b.value !== "string") throw new HttpError(422, "name and value are required", { errors: [{ resource: "ActionsVariable", code: "missing_field", field: typeof b.name !== "string" ? "name" : "value" }] });
  if (b.name.toUpperCase() in (await stub.variables(false))) throw new HttpError(409, "Already exists - Variable already exists");
  await stub.setVariable(b.name, b.value);
  auditRepo(c, caller, repo, "repo.variable.set", { name: b.name.toUpperCase() });
  return c.json({}, 201);
});
misc.patch(`${R}/actions/variables/:name`, async (c) => {
  const { stub, caller, repo } = await load(c, "admin", WHILE_IMPORTING);
  refuseAgent(caller, "variables");
  const name = c.req.param("name");
  const vars = await stub.variables(false);
  if (!(name.toUpperCase() in vars)) throw new HttpError(404, "Not Found");
  const b = await jsonBody<{ name?: string; value?: string }>(c);
  const next = typeof b.name === "string" && b.name ? b.name : name;
  if (next.toUpperCase() !== name.toUpperCase() && next.toUpperCase() in vars) throw new HttpError(409, "Already exists - Variable already exists");
  await stub.setVariable(next, typeof b.value === "string" ? b.value : vars[name.toUpperCase()]!);
  if (next.toUpperCase() !== name.toUpperCase()) await stub.setVariable(name.toUpperCase(), null);
  auditRepo(c, caller, repo, "repo.variable.set", { name: next.toUpperCase(), ...(next.toUpperCase() !== name.toUpperCase() ? { renamed_from: name.toUpperCase() } : {}) });
  return c.body(null, 204);
});

