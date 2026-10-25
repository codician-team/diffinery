import { Hono } from "hono";
import type { Env } from "../env.js";
import { requireAccount, requireRecentSignIn, type AppContext, type AppVars } from "../auth/principal.js";
import { loadRepo } from "../http/common.js";
import { HttpError } from "../lib/util.js";
import { isProvider, ModelKeys, type ModelKeyInfo } from "./keys.js";
import { approvePlan, attemptJson, compareAttempts, getTask, pickAttempt, setTaskOptions, lineJson, messageTask, myTasks, projectStub, requirePersonSession, requireTaskReader, retryTask, startTask, stopTask, taskJson, taskNumber, type StartInput } from "./tasks.js";
import { askForReview, findingJson, reviewSettings, reviewSettingsJson, saveReviewSettings, type SettingsInput } from "./reviews.js";
import { gatherToday, todayJson } from "./today.js";
import { orgUsageReport, orgUsageReportJson, usageDays, usageReport, usageReportJson } from "./ledger.js";
import { orgPolicy, orgSpend, parsePolicy, policyJson, savePolicy, spendMonth, type PolicyInput } from "./org-policy.js";
import { boardJson, coordinatorJson, coordinatorSummaryJson, handlePost, splitPlan, loadBoard, memoryJson, postJson, postToProject, saveCoordinator, saveMemory, saveProjectSettings, settingsJson, type CoordinatorInput } from "./projects.js";

async function jsonBody<T>(c: AppContext): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
}

/** Diffinery-only REST endpoints for agentic work, mounted under /api/v3 (see http/api.ts). */
export const agenticApi = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** The caller's token restriction to repositories, if any. */
export const tokenRepoIds = (c: AppContext): string[] | null => {
  const p = c.get("principal");
  return p.type === "account" ? p.repoIds : null;
};

agenticApi.get("/diffinery/today", async (c) => {
  const me = requireAccount(c);
  const today = await gatherToday(c.env, c.get("dir"), me, { repoIds: tokenRepoIds(c) });
  return c.json(todayJson(c.env.PUBLIC_URL.replace(/\/$/, ""), today));
});

// ---------------------------------------------------------------- model access (agentic/keys.ts)

const keyJson = (k: ModelKeyInfo) => ({ provider: k.provider, hint: k.hint, opted_in_at: k.optedInAt, ...(k.optedInBy ? { opted_in_by: k.optedInBy } : {}), created_at: k.createdAt, updated_at: k.updatedAt });

agenticApi.get("/diffinery/model-keys", async (c) => c.json((await new ModelKeys(c.env).list(requireAccount(c).id)).map(keyJson)));

/** Phase 5a: the model usage the caller paid for, across repositories, over the last `days` (1 to 90, default 30). */
agenticApi.get("/diffinery/model-usage", async (c) => {
  const report = await usageReport(c.env, requireAccount(c).id, usageDays(c.req.query("days")));
  // A token limited to some repositories sees only their lines.
  const only = tokenRepoIds(c);
  if (only) report.lines = report.lines.filter((l) => only.includes(l.repoId));
  return c.json(usageReportJson(report));
});

agenticApi.put("/diffinery/model-keys/:provider", async (c) => {
  // A key is spent by tasks this person starts; only they, in a browser, can set it.
  const me = requirePersonSession(c);
  const provider = c.req.param("provider");
  if (!isProvider(provider)) throw new HttpError(404, "unknown provider: use anthropic, openai or openrouter");
  // Swapping in another key sends the person's later prompts and code to that key's account: a sign-in from the last 2 hours, as for organizations' keys.
  requireRecentSignIn(c, "/settings/model-access");
  const b = await jsonBody<{ key?: unknown; accept_terms?: unknown }>(c);
  if (typeof b.key !== "string") throw new HttpError(422, "`key` is required");
  const k = await new ModelKeys(c.env).set(me, provider, b.key, b.accept_terms === true);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "model_key.set", target: provider, detail: { hint: k.hint, opted_in_at: k.optedInAt } }));
  return c.json(keyJson(k));
});

agenticApi.delete("/diffinery/model-keys/:provider", async (c) => {
  const me = requirePersonSession(c);
  const provider = c.req.param("provider");
  if (!isProvider(provider)) throw new HttpError(404, "unknown provider: use anthropic, openai or openrouter");
  if (!(await new ModelKeys(c.env).delete(me.id, provider))) throw new HttpError(404, "no key for that provider");
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "model_key.delete", target: provider }));
  return c.body(null, 204);
});

// ---------------------------------------------------------------- organizations' agent policy and keys (phase 5b, org-policy.ts)

/**
 * An organization's agent settings: its owners only (and site admins, audited as themselves). A token limited to
 * repositories can't reach them. Writes need a browser session; key writes also a sign-in from the last 2 hours.
 */
async function orgOwner(c: AppContext, need: "read" | "write" | "key") {
  const me = need === "read" ? requireAccount(c) : requirePersonSession(c);
  if (tokenRepoIds(c)) throw new HttpError(403, "a token limited to repositories can't use an organization's agent settings");
  const dir = c.get("dir");
  const org = await dir.accountByLogin(c.req.param("org") ?? "");
  if (!org || org.kind !== "org" || org.status === "disabled") throw new HttpError(404, "not found");
  const role = await dir.orgRole(org.id, me.id);
  if (role !== "owner" && !me.site_admin) throw new HttpError(role ? 403 : 404, role ? "organization owners only" : "not found");
  if (need === "key") requireRecentSignIn(c, `/${org.login}?tab=settings`);
  return { me, org, dir, asSiteAdmin: role !== "owner" };
}

agenticApi.get("/orgs/:org/diffinery/agent-policy", async (c) => {
  const { org } = await orgOwner(c, "read");
  return c.json(policyJson(await orgPolicy(c.env, org.id)));
});

agenticApi.put("/orgs/:org/diffinery/agent-policy", async (c) => {
  const { me, org, dir } = await orgOwner(c, "write");
  const p = parsePolicy(await jsonBody<PolicyInput>(c), await orgPolicy(c.env, org.id));
  return c.json(policyJson(await savePolicy(c.env, dir, org, me, p, (x) => c.executionCtx.waitUntil(x))));
});

agenticApi.get("/orgs/:org/diffinery/model-keys", async (c) => {
  const { org } = await orgOwner(c, "read");
  return c.json((await new ModelKeys(c.env).list(org.id)).map(keyJson));
});

agenticApi.put("/orgs/:org/diffinery/model-keys/:provider", async (c) => {
  const { me, org, dir, asSiteAdmin } = await orgOwner(c, "key");
  const provider = c.req.param("provider");
  if (!isProvider(provider)) throw new HttpError(404, "unknown provider: use anthropic, openai or openrouter");
  const b = await jsonBody<{ key?: unknown; accept_terms?: unknown }>(c);
  if (typeof b.key !== "string") throw new HttpError(422, "`key` is required");
  const k = await new ModelKeys(c.env).set(org, provider, b.key, b.accept_terms === true, me);
  c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "org.model_key.set", target: org.login, detail: { provider, hint: k.hint, opted_in_at: k.optedInAt, ...(asSiteAdmin ? { site_admin: true } : {}) } }));
  return c.json(keyJson(k));
});

agenticApi.delete("/orgs/:org/diffinery/model-keys/:provider", async (c) => {
  const { me, org, dir, asSiteAdmin } = await orgOwner(c, "key");
  const provider = c.req.param("provider");
  if (!isProvider(provider)) throw new HttpError(404, "unknown provider: use anthropic, openai or openrouter");
  if (!(await new ModelKeys(c.env).delete(org.id, provider))) throw new HttpError(404, "no key for that provider");
  c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "org.model_key.delete", target: org.login, detail: { provider, ...(asSiteAdmin ? { site_admin: true } : {}) } }));
  return c.body(null, 204);
});

/** The runs the organization's keys paid for over the last `days`, and each person's tokens this month against the allowance. */
agenticApi.get("/orgs/:org/diffinery/model-usage", async (c) => {
  const { org } = await orgOwner(c, "read");
  const [report, policy, spend] = await Promise.all([orgUsageReport(c.env, org.id, usageDays(c.req.query("days"))), orgPolicy(c.env, org.id), orgSpend(c.env, org.id)]);
  return c.json({
    ...orgUsageReportJson(report),
    month: { month: spendMonth(), member_monthly_tokens: policy.memberMonthlyTokens, people: spend.map((x) => ({ person: x.login, tokens: x.tokens })) },
  });
});

// ---------------------------------------------------------------- agent tasks (agentic/tasks.ts)

const base = (c: AppContext) => c.env.PUBLIC_URL.replace(/\/$/, "");
const full = (l: { repo: { owner_login: string; name: string } }) => `${l.repo.owner_login}/${l.repo.name}`;
const repoOf = (c: AppContext, min: "read" | "write" | "admin" = "read") => loadRepo(c, c.req.param("owner")!, c.req.param("repo")!, min);

agenticApi.get("/repos/:owner/:repo/diffinery/tasks", async (c) => {
  const l = await repoOf(c);
  requireTaskReader(l);
  const state = c.req.query("state");
  const tasks = await projectStub(c.env, l.repo.id).list({ limit: Number(c.req.query("per_page")) || 50, state: state === "queued" || state === "running" || state === "ready" || state === "failed" || state === "stopped" || state === "active" ? state : undefined });
  return c.json(tasks.map((t) => taskJson(base(c), full(l), t)));
});

agenticApi.post("/repos/:owner/:repo/diffinery/tasks", async (c) => {
  requirePersonSession(c);
  const l = await repoOf(c, "write");
  const t = await startTask(c, l, await jsonBody<StartInput>(c));
  return c.json(taskJson(base(c), full(l), t), 201);
});

agenticApi.get("/repos/:owner/:repo/diffinery/tasks/:number", async (c) => {
  const l = await repoOf(c);
  return c.json(taskJson(base(c), full(l), await getTask(c, l, taskNumber(c.req.param("number")))));
});

agenticApi.patch("/repos/:owner/:repo/diffinery/tasks/:number", async (c) => {
  const l = await repoOf(c);
  return c.json(taskJson(base(c), full(l), await setTaskOptions(c, l, taskNumber(c.req.param("number")), await jsonBody<{ fix_checks?: unknown; land?: unknown }>(c))));
});

agenticApi.get("/repos/:owner/:repo/diffinery/tasks/:number/transcript", async (c) => {
  const l = await repoOf(c);
  const n = taskNumber(c.req.param("number"));
  await getTask(c, l, n);
  const lines = await projectStub(c.env, l.repo.id).lines(n, Number(c.req.query("after")) || 0, Number(c.req.query("per_page")) || 2000);
  return c.json(lines.map(lineJson));
});

agenticApi.post("/repos/:owner/:repo/diffinery/tasks/:number/messages", async (c) => {
  requirePersonSession(c);
  const l = await repoOf(c, "write");
  const b = await jsonBody<{ body?: unknown }>(c);
  return c.json(taskJson(base(c), full(l), await messageTask(c, l, taskNumber(c.req.param("number")), b.body)), 201);
});

agenticApi.post("/repos/:owner/:repo/diffinery/tasks/:number/retry", async (c) => {
  requirePersonSession(c);
  const l = await repoOf(c, "write");
  return c.json(taskJson(base(c), full(l), await retryTask(c, l, taskNumber(c.req.param("number")))), 201);
});

agenticApi.post("/repos/:owner/:repo/diffinery/tasks/:number/stop", async (c) => {
  const l = await repoOf(c, "write");
  return c.json(taskJson(base(c), full(l), await stopTask(c, l, taskNumber(c.req.param("number")))));
});

agenticApi.get("/diffinery/tasks", async (c) => {
  const me = requireAccount(c);
  return c.json(await myTasks(c, me, tokenRepoIds(c)));
});

// ---------------------------------------------------------------- agent review (agentic/reviews.ts)

agenticApi.get("/repos/:owner/:repo/diffinery/agent-review", async (c) => {
  const l = await repoOf(c);
  requireTaskReader(l);
  return c.json(reviewSettingsJson(await reviewSettings(c.env, l.repo.id)));
});

agenticApi.put("/repos/:owner/:repo/diffinery/agent-review", async (c) => {
  // Every review spends the key of the admin who turns reviews on: only they, in a browser, can.
  requirePersonSession(c);
  const l = await repoOf(c, "admin");
  const b = await jsonBody<SettingsInput & { accept_terms?: unknown }>(c);
  const s = await saveReviewSettings(c, l, { ...b, accept: b.accept_terms });
  const me = requireAccount(c);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "review.settings", target: full(l), detail: { enabled: s?.enabled ?? false, agent: s?.agent.login, runtime: s?.runtime, trigger: s?.trigger, autofix: s?.autofix, daily_limit: s?.dailyLimit, tokens_per_review: s?.tokensPerReview } }));
  return c.json(reviewSettingsJson(s));
});

agenticApi.get("/repos/:owner/:repo/pulls/:number/diffinery/agent-review", async (c) => {
  const l = await repoOf(c);
  requireTaskReader(l);
  const n = Number(c.req.param("number"));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, "not found");
  const stub = projectStub(c.env, l.repo.id);
  const [t, findings] = await Promise.all([stub.reviewTask(n), stub.findings(n)]);
  return c.json({ task: t ? taskJson(base(c), full(l), t) : null, reviewed_sha: t?.reviewed_sha ?? null, findings: findings.map((f) => findingJson(base(c), full(l), f)) });
});

agenticApi.post("/repos/:owner/:repo/pulls/:number/diffinery/agent-review", async (c) => {
  const l = await repoOf(c, "write");
  const n = Number(c.req.param("number"));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, "not found");
  const out = await askForReview(c, l, n);
  return c.json({ status: out.status, task: out.task ? `${base(c)}/${full(l)}/tasks/${out.task}` : null }, 202);
});

// ---------------------------------------------------------------- the project (agentic/projects.ts)

agenticApi.get("/repos/:owner/:repo/diffinery/project", async (c) => {
  const l = await repoOf(c);
  requireTaskReader(l);
  return c.json(boardJson(base(c), full(l), await loadBoard(c, l)));
});

agenticApi.get("/repos/:owner/:repo/diffinery/project/posts", async (c) => {
  const l = await repoOf(c);
  requireTaskReader(l);
  const posts = await projectStub(c.env, l.repo.id).posts(Number(c.req.query("after")) || 0, Number(c.req.query("per_page")) || 100);
  return c.json(posts.map((p) => postJson(base(c), full(l), p)));
});

agenticApi.post("/repos/:owner/:repo/diffinery/project/posts", async (c) => {
  const l = await repoOf(c);
  requireTaskReader(l);
  const b = await jsonBody<{ body?: unknown; coordinator?: unknown }>(c);
  if (b.coordinator !== undefined && typeof b.coordinator !== "boolean") throw new HttpError(422, "`coordinator` must be true or false");
  const { post, handled } = await postToProject(c, l, b.body, { coordinator: b.coordinator as boolean | undefined });
  return c.json({ ...postJson(base(c), full(l), post), coordinator: handled }, 201);
});

agenticApi.get("/repos/:owner/:repo/diffinery/tasks/:number/attempts", async (c) => {
  const l = await repoOf(c);
  const n = taskNumber(c.req.param("number"));
  await getTask(c, l, n);
  return c.json((await compareAttempts(c, l, n)).map((a) => attemptJson(base(c), full(l), a)));
});

agenticApi.post("/repos/:owner/:repo/diffinery/tasks/:number/attempts/:attempt/pick", async (c) => {
  const l = await repoOf(c);
  const k = Number(c.req.param("attempt"));
  if (!Number.isInteger(k) || k < 1) throw new HttpError(404, "no such attempt");
  return c.json(taskJson(base(c), full(l), await pickAttempt(c, l, taskNumber(c.req.param("number")), k)), 202);
});

agenticApi.post("/repos/:owner/:repo/diffinery/tasks/:number/plan/approve", async (c) => {
  const l = await repoOf(c);
  return c.json(taskJson(base(c), full(l), await approvePlan(c, l, taskNumber(c.req.param("number")))), 202);
});

agenticApi.post("/repos/:owner/:repo/diffinery/tasks/:number/plan/split", async (c) => {
  const l = await repoOf(c);
  return c.json(await splitPlan(c, l, taskNumber(c.req.param("number"))), 202);
});

agenticApi.post("/repos/:owner/:repo/diffinery/project/posts/:n/handle", async (c) => {
  const l = await repoOf(c);
  requireTaskReader(l);
  const n = Number(c.req.param("n"));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, "no such post");
  return c.json(await handlePost(c, l, n), 202);
});

agenticApi.get("/repos/:owner/:repo/diffinery/project/coordinator", async (c) => {
  const l = await repoOf(c);
  requireTaskReader(l);
  const me = requireAccount(c);
  return c.json(coordinatorJson(await projectStub(c.env, l.repo.id).coordinator(me.id)));
});

agenticApi.get("/repos/:owner/:repo/diffinery/project/coordinators", async (c) => {
  const l = await repoOf(c);
  requireTaskReader(l);
  return c.json((await projectStub(c.env, l.repo.id).coordinators()).map(coordinatorSummaryJson));
});

agenticApi.put("/repos/:owner/:repo/diffinery/project/coordinator", async (c) => {
  const l = await repoOf(c);
  requireTaskReader(l);
  const b = await jsonBody<CoordinatorInput>(c);
  return c.json(coordinatorJson(await saveCoordinator(c, l, b)));
});

agenticApi.delete("/repos/:owner/:repo/diffinery/project/coordinator", async (c) => {
  const l = await repoOf(c);
  requireTaskReader(l);
  await saveCoordinator(c, l, null);
  return c.body(null, 204);
});

agenticApi.get("/repos/:owner/:repo/diffinery/project/memory", async (c) => {
  const l = await repoOf(c);
  requireTaskReader(l);
  const stub = projectStub(c.env, l.repo.id);
  const versions = await stub.memoryVersions();
  return c.json({ ...memoryJson(versions[0] ?? null), versions: versions.map((v) => ({ version: v.n, updated_by: { login: v.by_login, type: v.by_kind === "person" ? "User" : "Bot" }, updated_at: v.at, length: v.body.length })) });
});

agenticApi.put("/repos/:owner/:repo/diffinery/project/memory", async (c) => {
  const l = await repoOf(c);
  requireTaskReader(l);
  const b = await jsonBody<{ body?: unknown; restore?: unknown }>(c);
  const restore = b.restore === undefined || b.restore === null ? undefined : Number(b.restore);
  if (restore !== undefined && (!Number.isInteger(restore) || restore < 1)) throw new HttpError(422, "`restore` must be a version number");
  return c.json(memoryJson(await saveMemory(c, l, b.body, restore)));
});

agenticApi.put("/repos/:owner/:repo/diffinery/project/settings", async (c) => {
  const l = await repoOf(c);
  requireTaskReader(l);
  return c.json(settingsJson(await saveProjectSettings(c, l, await jsonBody<{ max_running?: unknown; instructions?: unknown; plan_first?: unknown }>(c))));
});
