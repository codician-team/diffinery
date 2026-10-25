import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppContext, AppVars } from "../auth/principal.js";
import { HttpError } from "../lib/util.js";
import type { CommitStatus } from "../repo/statuses.js";
import { loadRepo } from "./common.js";
import { baseOf, ghCheckRun, ghRepo, ghUser, isoSeconds, nodeId, paginate, repoApi } from "./gh.js";
import { jsonBody, loadTarget, repoParams } from "./ghctx.js";

/** Commit statuses, single check runs and check suites (GitHub REST). */
export const statuses = new Hono<{ Bindings: Env; Variables: AppVars }>();

const R = "/repos/:owner/:repo";

function statusJson(c: AppContext, s: CommitStatus) {
  const b = baseOf(c);
  const { owner, repo } = repoParams(c);
  const creator = ghUser(b, s.creator);
  return {
    url: `${repoApi(b, owner, repo)}/statuses/${s.sha}`,
    avatar_url: creator?.avatar_url ?? null,
    id: s.id,
    node_id: nodeId("StatusContext", `${owner}/${repo}/${s.id}`),
    state: s.state,
    description: s.description,
    target_url: s.targetUrl,
    context: s.context,
    created_at: isoSeconds(s.createdAt),
    updated_at: isoSeconds(s.updatedAt),
    creator,
  };
}

statuses.post(`${R}/statuses/:sha`, async (c) => {
  const { stub, caller } = await loadTarget(c, "write");
  const b = await jsonBody<{ state?: string; target_url?: string | null; description?: string | null; context?: string }>(c);
  const s = await stub.createStatus(c.req.param("sha"), { state: b.state, target_url: b.target_url, description: b.description, context: b.context }, caller);
  return c.json(statusJson(c, s), 201);
});

async function listStatuses(c: AppContext) {
  const { stub } = await loadTarget(c);
  const sha = await stub.resolve(c.req.param("ref"));
  if (!sha) throw new HttpError(404, "No commit found for the ref");
  return c.json(paginate(c, (await stub.commitStatuses(sha)).map((s) => statusJson(c, s))));
}
statuses.get(`${R}/commits/:ref{.+}/statuses`, listStatuses);
statuses.get(`${R}/statuses/:ref{.+}`, listStatuses);

statuses.get(`${R}/commits/:ref{.+}/status`, async (c) => {
  const { stub, repo } = await loadTarget(c);
  const sha = await stub.resolve(c.req.param("ref"));
  if (!sha) throw new HttpError(404, "No commit found for the ref");
  const combined = await stub.combinedStatus(sha);
  const api = repoApi(baseOf(c), repo.owner_login, repo.name);
  return c.json({
    state: combined.state,
    statuses: paginate(c, combined.statuses.map((s) => statusJson(c, s)), 100),
    sha,
    total_count: combined.statuses.length,
    repository: ghRepo(baseOf(c), repo),
    commit_url: `${api}/commits/${sha}`,
    url: `${api}/commits/${sha}/status`,
  });
});

// ---------------------------------------------------------------- check runs by id

statuses.get(`${R}/check-runs/:id`, async (c) => {
  const { stub, repo } = await loadTarget(c);
  return c.json(ghCheckRun(baseOf(c), repo.owner_login, repo.name, await stub.checkRun(c.req.param("id"))));
});

statuses.patch(`${R}/check-runs/:id`, async (c) => {
  const { stub, caller, repo } = await loadTarget(c, "write");
  const b = await jsonBody<Parameters<typeof stub.updateCheckRun>[1]>(c);
  return c.json(ghCheckRun(baseOf(c), repo.owner_login, repo.name, await stub.updateCheckRun(c.req.param("id"), b, caller)));
});

statuses.get(`${R}/check-runs/:id/annotations`, async (c) => {
  const { stub } = await loadTarget(c);
  const check = await stub.checkRun(c.req.param("id"));
  const list = ((check.output as { annotations?: Array<Record<string, unknown>> } | null)?.annotations ?? []).map((a) => ({
    path: a.path ?? null,
    start_line: a.start_line ?? null,
    end_line: a.end_line ?? a.start_line ?? null,
    start_column: a.start_column ?? null,
    end_column: a.end_column ?? null,
    annotation_level: a.annotation_level ?? "notice",
    title: a.title ?? null,
    message: a.message ?? "",
    raw_details: a.raw_details ?? null,
    blob_href: null,
  }));
  return c.json(paginate(c, list));
});

// ---------------------------------------------------------------- check suites (one per workflow run, or per app)

type Suite = Awaited<ReturnType<Awaited<ReturnType<typeof loadRepo>>["stub"]["checkSuite"]>>;

function suiteJson(c: AppContext, s: Suite) {
  const b = baseOf(c);
  const { owner, repo } = repoParams(c);
  return {
    id: s.id,
    node_id: nodeId("CheckSuite", s.id),
    head_branch: null,
    head_sha: s.headSha,
    status: s.status,
    conclusion: s.conclusion,
    url: `${repoApi(b, owner, repo)}/check-suites/${s.id}`,
    app: { id: s.app, slug: s.app, name: s.app },
    pull_requests: [],
    latest_check_runs_count: s.runs.length,
    check_runs_url: `${repoApi(b, owner, repo)}/check-suites/${s.id}/check-runs`,
  };
}

statuses.get(`${R}/commits/:ref{.+}/check-suites`, async (c) => {
  const { stub } = await loadTarget(c);
  const sha = await stub.resolve(c.req.param("ref"));
  if (!sha) throw new HttpError(404, "ref not found");
  const suites = await stub.checkSuites(sha);
  return c.json({ total_count: suites.length, check_suites: paginate(c, suites).map((s) => suiteJson(c, s)) });
});

statuses.get(`${R}/check-suites/:id`, async (c) => {
  const { stub } = await loadTarget(c);
  return c.json(suiteJson(c, await stub.checkSuite(c.req.param("id"))));
});

statuses.get(`${R}/check-suites/:id/check-runs`, async (c) => {
  const { stub, repo } = await loadTarget(c);
  const suite = await stub.checkSuite(c.req.param("id"));
  return c.json({ total_count: suite.runs.length, check_runs: paginate(c, suite.runs).map((r) => ghCheckRun(baseOf(c), repo.owner_login, repo.name, r)) });
});
