import { refreshRepoLimit } from "../agentic/org-policy.js";
import { AgentSetup, parseReport, type SetupCheck } from "../lib/agent-setup.js";
import { Hono } from "hono";
import { fromUtf8 } from "@diffinery/git-core";
import type { Env } from "../env.js";
import { callerFor, parseScopes, requireAccount, requireAccountScope, requireBrowserSession, requireRecentSignIn, requireUnlimitedToken, tokenRepos, type AppContext, type AppVars } from "../auth/principal.js";
import { baseRole, type Account, type Directory, type Repo, type TokenScope } from "../lib/directory.js";
import { encryptSecret } from "../lib/crypto.js";
import { monthStart, quotasFor, setQuotas, usageOf } from "../lib/quotas.js";
import { serverErrors } from "../lib/server-errors.js";
import { changePause, changeSuspension, cleanReason, computePause, killSwitches, suspensionOf, type Stopped } from "../lib/killswitch.js";
import { publicJwk } from "../lib/jwt.js";
import { visibleTo } from "../lib/moderation.js";
import { HttpError, b64, fromB64 } from "../lib/util.js";
import { MAX_LOG_DEPTH, atLeast, ROLE_LEVEL, type ProtectionRulesInput, type Role } from "../repo/types.js";
import type { JobInfo, RunInfo } from "../repo/actions.js";
import type { CommitInfo } from "../repo/RepoDO.js";
import type { QueueEntry } from "../repo/queue.js";
import { parseAutoMergeDefault, type AutoMergeDefault } from "../repo/auto-merge.js";
import { imports } from "./imports.js";
import { schedulerStub } from "../lib/schedules.js";
import { agenticApi } from "../agentic/api.js";
import { auditRepo, hiddenAuthors, loadRepo, refuseAgent, repoStub, WHILE_IMPORTING } from "./common.js";
import { repoCreated } from "../mail/notify.js";
import { actionsRest } from "./actions-runtime.js";
import { compat } from "./compat.js";
import { appsApi } from "./apps.js";
import { isAppCaller } from "../repo/token-policy.js";
import { baseOf, encPath, ghAutoMerge, ghCheckRun, ghComment, ghCommit, ghGitCommit, ghJob, ghRef, ghRun, ghFile, ghLabel, ghReview, ghReviewComment, ghUser, isoSeconds, nodeId, normalizeHomepage, numericId, pageOf, paginate, repoApi, repoHtml, setLinks } from "./gh.js";
import { decodePath, issueCtx, issuesOut, pullDetail, pullsOut, repoOut } from "./ghctx.js";

/**
 * REST API. Paths and payloads follow GitHub's REST API v3 where practical so
 * existing scripts and tools work; Diffinery-only endpoints live under /api/v3/diffinery.
 */
export const api = new Hono<{ Bindings: Env; Variables: AppVars }>().basePath("/api/v3");

// GitHub-compatible endpoints that live in their own files (releases, statuses, Git data, ...).
// Mounted first: some of their paths (like /issues/comments) would otherwise match routes below.
api.route("/", compat);
// GitHub-compatible apps: /app, installations and their tokens, /diffinery/apps (http/apps.ts).
api.route("/", appsApi);

const userJson = (c: AppContext, a: Pick<Account, "id" | "login" | "kind" | "name">) => ({ ...ghUser(baseOf(c), a)!, name: a.name || null });

const repoJson = repoOut;

async function body<T>(c: AppContext): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
}

/** Called with an access token (scripts, the CLI, agents) rather than from a browser. */
const viaToken = (c: AppContext) => {
  const p = c.get("principal");
  return p.type === "account" && p.via === "token";
};
const P = (c: AppContext) => ({ owner: c.req.param("owner")!, repo: c.req.param("repo")! });
const num = (c: AppContext, name = "number") => {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, "not found");
  return n;
};

// GitHub imports, milestones, organization variables and linked accounts.
api.route("/", imports);
// Agentic work: the Today view (agentic/).
api.route("/", agenticApi);

// ---------------------------------------------------------------- meta & users

export const apiRootJson = (c: AppContext) => c.json({ name: "Diffinery", api: "v3", docs: `${c.env.PUBLIC_URL}/docs/api`, mcp: `${c.env.PUBLIC_URL}/mcp`, graphql: `${c.env.PUBLIC_URL}/api/graphql` });
api.get("/", apiRootJson);
// Imported when used: web/indexnow.ts reaches the docs, whose API reference imports this module.
const indexNow = () => import("../web/indexnow.js");
api.get("/meta", async (c) => c.json({ name: "Diffinery", oidc: !!c.env.OIDC_PRIVATE_KEY, runner_image: c.env.RUNNER_IMAGE ?? null, indexnow: await (await indexNow()).indexNowMeta(c.env) }));
/** Site admin: the newest unexpected server errors (lib/server-errors.ts), and one by the request id its 5xx answer carried. */
api.get("/diffinery/admin/errors", async (c) => {
  if (!requireAccount(c).site_admin) throw new HttpError(403, "site administrators only");
  const n = Number(c.req.query("per_page") ?? 100);
  return c.json(await serverErrors(c.env, { limit: Number.isFinite(n) ? n : 100 }));
});
api.get("/diffinery/admin/errors/:id", async (c) => {
  if (!requireAccount(c).site_admin) throw new HttpError(403, "site administrators only");
  const [e] = await serverErrors(c.env, { id: c.req.param("id") });
  if (!e) throw new HttpError(404, "no server error with that request id (only the newest 500 are kept)");
  return c.json(e);
});
/** Site admin: what IndexNow has told search engines (web/indexnow.ts). */
api.get("/diffinery/admin/indexnow", async (c) => {
  if (!requireAccount(c).site_admin) throw new HttpError(403, "site administrators only");
  const n = Number(c.req.query("per_page") ?? 50);
  const s = await (await indexNow()).indexNowStatus(c.env, Number.isFinite(n) ? Math.max(1, Math.min(200, Math.floor(n))) : 50);
  return c.json({ enabled: !s.off, off_reason: s.off, key_location: s.keyLocation, site_pages: s.site, repositories: s.repos, queued: s.queued, retry_at: s.retryAt, repositories_checked_at: s.reposCheckedAt, submissions: s.submissions });
});
/** Site admin: the workflow scheduler's state, to tell a scheduler that stopped ticking from a run that failed to start. */
api.get("/diffinery/admin/scheduler", async (c) => {
  if (!requireAccount(c).site_admin) throw new HttpError(403, "site administrators only");
  return c.json(await schedulerStub(c.env).status());
});
api.get("/user", (c) => {
  const a = requireAccount(c);
  return c.json({ ...userJson(c, a), email: a.email, site_admin: !!a.site_admin });
});
api.get("/users/:login", async (c) => {
  const me = requireAccount(c);
  const a = await c.get("dir").accountByLogin(c.req.param("login"));
  // A suspended person's profile is hidden from everyone but site administrators (lib/moderation.ts).
  if (!a || a.deleted_at || !visibleTo(a, me)) throw new HttpError(404, "not found");
  // Site administrators also see a suspension, as in GitHub Enterprise.
  return c.json({ ...userJson(c, a), ...(me.site_admin && a.kind === "user" ? { suspended_at: isoSeconds(a.suspended_at ?? null), suspension_reason: a.suspended_reason ?? null } : {}) });
});
// Quotas and what an account uses of them (lib/quotas.ts): your own, an organization's for its owners
// and admins, and any account's for site administrators, who can also change them.
const usageJson = async (c: AppContext, account: Account) => {
  const [q, u] = await Promise.all([quotasFor(c.env, account.id), usageOf(c.env, account.id)]);
  return {
    account: account.login,
    exempt: q.exempt,
    period_start: monthStart(),
    hosted_minutes: { used: u.hosted_minutes, limit: q.hosted_minutes },
    hosted_jobs: { running: u.hosted_jobs, limit: q.hosted_jobs },
    sandboxes: { open: u.sandboxes, limit: q.sandboxes },
    repositories: { count: u.repositories, limit: q.repositories },
    storage_bytes: { used: u.storage_bytes, limit: q.storage_bytes },
  };
};
api.get("/user/usage", async (c) => {
  requireAccountScope(c, "read");
  const me = requireAccount(c);
  return c.json(await usageJson(c, me.kind === "agent" && me.owner_id ? ((await c.get("dir").account(me.owner_id)) ?? me) : me));
});
api.get("/orgs/:org/usage", async (c) => {
  requireAccountScope(c, "read");
  const a = requireAccount(c);
  const dir = c.get("dir");
  const org = await dir.accountByLogin(c.req.param("org"));
  if (!org || org.kind !== "org") throw new HttpError(404, "not found");
  const role = await dir.orgRole(org.id, a.id);
  if (!role && !a.site_admin) throw new HttpError(404, "not found");
  if (role !== "owner" && role !== "admin" && !a.site_admin) throw new HttpError(403, "only organization owners and admins can see its usage");
  return c.json(await usageJson(c, org));
});
const quotaTarget = async (c: AppContext) => {
  const a = requireAccount(c);
  if (!a.site_admin) throw new HttpError(403, "only site administrators can see and change quotas");
  const account = await c.get("dir").accountByLogin(c.req.param("login") ?? "");
  if (!account || account.kind === "agent") throw new HttpError(404, "no person or organization with that name");
  return { a, account };
};
api.get("/admin/accounts/:login/quotas", async (c) => {
  requireAccountScope(c, "read");
  const { account } = await quotaTarget(c);
  return c.json(await usageJson(c, account));
});
api.patch("/admin/accounts/:login/quotas", async (c) => {
  requireAccountScope(c, "admin");
  requireUnlimitedToken(c, "change quotas");
  const { a, account } = await quotaTarget(c);
  const b = await body<Record<string, number | null>>(c);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(422, "send the quotas to change, e.g. {\"hosted_minutes\": 6000}");
  await setQuotas(c.env, account.id, b, a.login);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: a.id, actorLogin: a.login, action: "account.quotas.set", target: account.login, detail: b }));
  return c.json(await usageJson(c, account));
});
// Kill switches (lib/killswitch.ts): site administrators suspend Actions for a repository or an
// account, or pause hosted compute on the whole instance. Same checks as the quotas above.
const siteAdmin = (c: AppContext, what: string) => {
  const a = requireAccount(c);
  if (!a.site_admin) throw new HttpError(403, `only site administrators can ${what}`);
  return a;
};
const stoppedJson = (s: Stopped | null) => (s ? { stopped: { repositories: s.repositories, runs: s.runs, jobs: s.jobs, sandboxes: s.sandboxes, failed: s.failed } } : {});
const repoSuspension = async (c: AppContext, write: boolean) => {
  if (write) {
    requireAccountScope(c, "admin");
    requireUnlimitedToken(c, "suspend Actions");
  } else requireAccountScope(c, "read");
  const a = siteAdmin(c, "see or change Actions suspensions");
  const repo = await c.get("dir").repo(c.req.param("owner") ?? "", c.req.param("repo") ?? "");
  if (!repo) throw new HttpError(404, "no repository with that name");
  return { a, repo, json: async (stopped: Stopped | null = null) => {
    const k = await killSwitches(c.env, repo.id);
    return { repository: `${repo.owner_login}/${repo.name}`, suspended: !!k.repo, reason: k.repo?.reason ?? null, suspended_by: k.repo?.by ?? null, suspended_at: k.repo?.at ?? null, owner_suspended: !!k.account, ...stoppedJson(stopped) };
  } };
};
api.get("/admin/repos/:owner/:repo/actions-suspension", async (c) => c.json(await (await repoSuspension(c, false)).json()));
api.put("/admin/repos/:owner/:repo/actions-suspension", async (c) => {
  const { a, repo, json } = await repoSuspension(c, true);
  const reason = cleanReason((await body<{ reason?: unknown }>(c).catch(() => ({}) as { reason?: unknown }))?.reason);
  const stopped = await changeSuspension(c.env, (e) => c.get("dir").audit(e), a, { kind: "repo", id: repo.id, name: `${repo.owner_login}/${repo.name}` }, reason, "api");
  return c.json(await json(stopped));
});
api.delete("/admin/repos/:owner/:repo/actions-suspension", async (c) => {
  const { a, repo, json } = await repoSuspension(c, true);
  await changeSuspension(c.env, (e) => c.get("dir").audit(e), a, { kind: "repo", id: repo.id, name: `${repo.owner_login}/${repo.name}` }, null, "api");
  return c.json(await json());
});
const accountSuspension = async (c: AppContext, write: boolean) => {
  if (write) {
    requireAccountScope(c, "admin");
    requireUnlimitedToken(c, "suspend Actions");
  } else requireAccountScope(c, "read");
  const a = siteAdmin(c, "see or change Actions suspensions");
  const account = await c.get("dir").accountByLogin(c.req.param("login") ?? "");
  if (!account || account.kind === "agent") throw new HttpError(404, "no person or organization with that name");
  return { a, account, json: async (stopped: Stopped | null = null) => {
    const s = await suspensionOf(c.env, { accountId: account.id });
    return { account: account.login, suspended: !!s, reason: s?.reason ?? null, suspended_by: s?.by ?? null, suspended_at: s?.at ?? null, ...stoppedJson(stopped) };
  } };
};
api.get("/admin/accounts/:login/actions-suspension", async (c) => c.json(await (await accountSuspension(c, false)).json()));
api.put("/admin/accounts/:login/actions-suspension", async (c) => {
  const { a, account, json } = await accountSuspension(c, true);
  const reason = cleanReason((await body<{ reason?: unknown }>(c).catch(() => ({}) as { reason?: unknown }))?.reason);
  const stopped = await changeSuspension(c.env, (e) => c.get("dir").audit(e), a, { kind: "account", id: account.id, login: account.login }, reason, "api");
  return c.json(await json(stopped));
});
api.delete("/admin/accounts/:login/actions-suspension", async (c) => {
  const { a, account, json } = await accountSuspension(c, true);
  await changeSuspension(c.env, (e) => c.get("dir").audit(e), a, { kind: "account", id: account.id, login: account.login }, null, "api");
  return c.json(await json());
});
const pauseJson = async (c: AppContext, stopped: Stopped | null = null) => {
  const p = await computePause(c.env);
  return { paused: !!p, reason: p?.reason ?? null, paused_by: p?.by ?? null, paused_at: p?.at ?? null, ...stoppedJson(stopped) };
};
const pauseAdmin = (c: AppContext, write: boolean) => {
  if (write) {
    requireAccountScope(c, "admin");
    requireUnlimitedToken(c, "pause hosted compute");
  } else requireAccountScope(c, "read");
  return siteAdmin(c, "see or change the hosted compute pause");
};
api.get("/admin/hosted-compute-pause", async (c) => {
  pauseAdmin(c, false);
  return c.json(await pauseJson(c));
});
api.put("/admin/hosted-compute-pause", async (c) => {
  const a = pauseAdmin(c, true);
  const reason = cleanReason((await body<{ reason?: unknown }>(c).catch(() => ({}) as { reason?: unknown }))?.reason);
  return c.json(await pauseJson(c, await changePause(c.env, (e) => c.get("dir").audit(e), a, reason, "api")));
});
api.delete("/admin/hosted-compute-pause", async (c) => {
  const a = pauseAdmin(c, true);
  await changePause(c.env, (e) => c.get("dir").audit(e), a, null, "api");
  return c.json(await pauseJson(c));
});
api.get("/user/orgs", async (c) => c.json((await c.get("dir").orgsFor(requireAccount(c).id)).map((o) => ({ ...userJson(c, o), role: o.role }))));
api.post("/user/orgs", async (c) => {
  requireAccountScope(c, "admin");
  const a = requireAccount(c);
  // An organization is a person's: an agent that owned one could send its invitations, past its owner's say.
  if (a.kind !== "user") throw new HttpError(403, "only people can create organizations");
  const b = await body<{ login: string; name?: unknown }>(c);
  if (typeof b.login !== "string") throw new HttpError(422, "login is required", { errors: [{ resource: "Organization", code: "missing_field", field: "login" }] });
  if (b.name !== undefined && b.name !== null && typeof b.name !== "string") throw new HttpError(422, "name must be a string", { errors: [{ resource: "Organization", code: "invalid", field: "name" }] });
  return c.json(userJson(c, await c.get("dir").createOrg(b.login, (b.name as string | null | undefined) || b.login, a)), 201);
});
// GitHub's organization object; members and their agents also see the base permission (default_repository_permission).
const orgJson = async (c: AppContext, org: Account, me: Account) => ({ ...userJson(c, org), ...((await c.get("dir").inOrg(org.id, me)) ? { default_repository_permission: baseRole(org) } : {}) });
api.get("/orgs/:org", async (c) => {
  const a = requireAccount(c);
  const org = await c.get("dir").accountByLogin(c.req.param("org"));
  if (!org || org.kind !== "org") throw new HttpError(404, "not found");
  return c.json(await orgJson(c, org, a));
});
api.patch("/orgs/:org", async (c) => {
  requireAccountScope(c, "admin");
  const a = requireAccount(c);
  const dir = c.get("dir");
  const org = await dir.accountByLogin(c.req.param("org"));
  if (!org || org.kind !== "org") throw new HttpError(404, "not found");
  const role = await dir.orgRole(org.id, a.id);
  if (!role && !a.site_admin) throw new HttpError(404, "not found");
  if (role !== "owner" && !a.site_admin) throw new HttpError(403, "only organization owners can change its settings");
  const b = await body<{ name?: unknown; default_repository_permission?: unknown }>(c);
  await dir.updateAccount(org.id, { name: b.name, baseRole: b.default_repository_permission });
  c.executionCtx.waitUntil(dir.audit({ actorId: a.id, actorLogin: a.login, action: "org.update", target: org.login, detail: { name: b.name, base_role: b.default_repository_permission } }));
  return c.json(await orgJson(c, (await dir.account(org.id))!, a));
});
// Owners only. Refused while the organization still owns repositories (see Directory.deleteOrg).
api.delete("/orgs/:org", async (c) => {
  requireAccountScope(c, "admin");
  const a = requireAccount(c);
  const dir = c.get("dir");
  const org = await dir.accountByLogin(c.req.param("org"));
  if (!org || org.kind !== "org") throw new HttpError(404, "not found");
  const role = await dir.orgRole(org.id, a.id);
  if (!role && !a.site_admin) throw new HttpError(404, "not found");
  if (role !== "owner" && !a.site_admin) throw new HttpError(403, "only organization owners can delete it");
  requireRecentSignIn(c, `/${org.login}?tab=settings`);
  await dir.deleteOrg(org);
  c.executionCtx.waitUntil(dir.audit({ actorId: a.id, actorLogin: a.login, action: "org.delete", target: org.login }));
  return c.json({}, 202);
});
api.get("/orgs/:org/members", async (c) => {
  const a = requireAccount(c);
  const dir = c.get("dir");
  const org = await dir.accountByLogin(c.req.param("org"));
  if (!org || org.kind !== "org") throw new HttpError(404, "not found");
  if (!(await dir.orgRole(org.id, a.id)) && !a.site_admin) throw new HttpError(404, "not found");
  return c.json((await dir.orgMembers(org.id)).map((m) => ({ ...userJson(c, m), role: m.role })));
});
api.post("/orgs/:org/invitations", async (c) => {
  requireAccountScope(c, "admin");
  const a = requireAccount(c);
  const dir = c.get("dir");
  const org = await dir.accountByLogin(c.req.param("org"));
  if (!org || org.kind !== "org") throw new HttpError(404, "not found");
  const role = await dir.orgRole(org.id, a.id);
  if (role !== "owner" && role !== "admin" && !a.site_admin) throw new HttpError(403, "only organization owners and admins can invite");
  const b = await body<{ email: string; role?: "member" | "admin" | "owner" }>(c);
  if (!/^[^@\s]+@[^@\s]+$/.test(b.email ?? "")) throw new HttpError(422, "a valid email is required");
  const inv = await dir.createInvite(a, { email: b.email, orgId: org.id, role: b.role ?? "member" });
  c.executionCtx.waitUntil(dir.audit({ actorId: a.id, actorLogin: a.login, action: "org.invite", target: org.login, detail: { email: b.email, role: b.role ?? "member" } }));
  return c.json({ id: inv.id, url: inv.url }, 201);
});

// Site-wide invitation (no organization): site admins only.
api.post("/invitations", async (c) => {
  requireAccountScope(c, "admin");
  const a = requireAccount(c);
  if (!a.site_admin) throw new HttpError(403, "only site admins can invite people without an organization");
  const b = await body<{ email: string }>(c);
  if (!/^[^@\s]+@[^@\s]+$/.test(b.email ?? "")) throw new HttpError(422, "a valid email is required");
  const dir = c.get("dir");
  const inv = await dir.createInvite(a, { email: b.email, role: "member" });
  c.executionCtx.waitUntil(dir.audit({ actorId: a.id, actorLogin: a.login, action: "site.invite", detail: { email: b.email } }));
  return c.json({ id: inv.id, url: inv.url }, 201);
});

// Pending invitations: list and revoke, for an organization's owners and admins, a repository's admins,
// and site admins (invitations to the site itself).
const inviteJson = (i: Awaited<ReturnType<Directory["invites"]>>[number]) => ({ id: i.id, email: i.email, login: i.login, role: i.role, inviter: i.invitedBy ? { login: i.invitedBy } : null, created_at: i.createdAt, expires_at: i.expiresAt });
const orgForInvites = async (c: AppContext) => {
  requireAccountScope(c, "read");
  const a = requireAccount(c);
  const dir = c.get("dir");
  const org = await dir.accountByLogin(c.req.param("org") ?? "");
  if (!org || org.kind !== "org") throw new HttpError(404, "not found");
  const role = await dir.orgRole(org.id, a.id);
  if (!role && !a.site_admin) throw new HttpError(404, "not found");
  if (role !== "owner" && role !== "admin" && !a.site_admin) throw new HttpError(403, "only organization owners and admins can manage invitations");
  return { a, dir, org };
};
const revoked = async (c: AppContext, ok: boolean, action: string, target?: string) => {
  if (!ok) throw new HttpError(404, "no pending invitation with this id");
  const a = requireAccount(c);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: a.id, actorLogin: a.login, action, target, detail: { id: c.req.param("id"), via: "api" } }));
  return c.body(null, 204);
};
api.get("/orgs/:org/invitations", async (c) => {
  const { dir, org } = await orgForInvites(c);
  return c.json((await dir.invites({ orgId: org.id, pending: true })).map(inviteJson));
});
api.delete("/orgs/:org/invitations/:id", async (c) => {
  requireAccountScope(c, "admin");
  const { dir, org } = await orgForInvites(c);
  return revoked(c, await dir.revokeInvite(c.req.param("id"), { orgId: org.id }), "org.invite.revoke", org.login);
});
api.get("/repos/:owner/:repo/invitations", async (c) => {
  const { repo } = await loadRepo(c, P(c).owner, P(c).repo, "admin");
  return c.json((await c.get("dir").invites({ repoId: repo.id, pending: true })).map(inviteJson));
});
api.delete("/repos/:owner/:repo/invitations/:id", async (c) => {
  const { repo, caller } = await loadRepo(c, P(c).owner, P(c).repo, "admin", WHILE_IMPORTING);
  if (!(await c.get("dir").revokeInvite(c.req.param("id"), { repoId: repo.id }))) throw new HttpError(404, "no pending invitation with this id");
  auditRepo(c, caller, repo, "repo.invite.revoke", { id: c.req.param("id") });
  return c.body(null, 204);
});
api.get("/invitations", async (c) => {
  requireAccountScope(c, "read");
  if (!requireAccount(c).site_admin) throw new HttpError(403, "only site admins can list site invitations");
  return c.json((await c.get("dir").invites({ site: true, pending: true })).map(inviteJson));
});
api.delete("/invitations/:id", async (c) => {
  requireAccountScope(c, "admin");
  if (!requireAccount(c).site_admin) throw new HttpError(403, "only site admins can revoke site invitations");
  return revoked(c, await c.get("dir").revokeInvite(c.req.param("id"), {}), "invite.revoke");
});

// ---------------------------------------------------------------- repositories

api.get("/user/repos", async (c) => c.json(paginate(c, tokenRepos(c, await c.get("dir").reposVisibleTo(requireAccount(c))).map((r) => repoJson(c, r)))));
api.post("/user/repos", async (c) => {
  requireAccountScope(c, "write");
  const a = requireAccount(c);
  const b = await body<{ name: string; description?: string; private?: boolean; visibility?: string; default_branch?: string }>(c);
  const owner = a.kind === "agent" ? (await c.get("dir").account(a.owner_id!))! : a;
  const r = await c.get("dir").createRepo(owner, a, { name: b.name, description: b.description, visibility: b.visibility ?? (b.private === false ? "public" : "private"), defaultBranch: b.default_branch });
  c.executionCtx.waitUntil(repoCreated(c.env, c.get("dir"), r, a, { viaToken: viaToken(c) }));
  return c.json(repoJson(c, r), 201);
});
api.get("/users/:login/repos", async (c) => {
  const a = requireAccount(c);
  const owner = await c.get("dir").accountByLogin(c.req.param("login"));
  if (!owner || !visibleTo(owner, a)) throw new HttpError(404, "not found");
  return c.json(paginate(c, tokenRepos(c, await c.get("dir").reposVisibleTo(a, owner.id)).map((r) => repoJson(c, r))));
});
api.get("/orgs/:org/repos", async (c) => {
  const a = requireAccount(c);
  const org = await c.get("dir").accountByLogin(c.req.param("org"));
  if (!org) throw new HttpError(404, "not found");
  return c.json(paginate(c, tokenRepos(c, await c.get("dir").reposVisibleTo(a, org.id)).map((r) => repoJson(c, r))));
});
api.post("/orgs/:org/repos", async (c) => {
  requireAccountScope(c, "write");
  const a = requireAccount(c);
  const org = await c.get("dir").accountByLogin(c.req.param("org"));
  if (!org || org.kind !== "org") throw new HttpError(404, "organization not found");
  const b = await body<{ name: string; description?: string; private?: boolean; visibility?: string; default_branch?: string }>(c);
  const r = await c.get("dir").createRepo(org, a, { name: b.name, description: b.description, visibility: b.visibility ?? (b.private === false ? "public" : "private"), defaultBranch: b.default_branch });
  c.executionCtx.waitUntil(repoCreated(c.env, c.get("dir"), r, a, { viaToken: viaToken(c) }));
  return c.json(repoJson(c, r), 201);
});
api.get("/repos/:owner/:repo", async (c) => {
  const { repo, caller, stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const stats = await stub.stats();
  return c.json({ ...repoOut(c, repo, caller.role), open_issues_count: stats.openIssues + stats.openPulls, open_issues: stats.openIssues + stats.openPulls, stats });
});
api.patch("/repos/:owner/:repo", async (c) => {
  const { repo, caller } = await loadRepo(c, P(c).owner, P(c).repo, "admin", { whileArchived: true });
  const b = await body<{ name?: string; description?: string; homepage?: string | null; private?: boolean; visibility?: Repo["visibility"]; default_branch?: string; archived?: boolean }>(c);
  const homepage = normalizeHomepage(b.homepage);
  if (b.private !== undefined && typeof b.private !== "boolean") throw new HttpError(422, "private must be a boolean", { errors: [{ resource: "Repository", code: "invalid", field: "private" }] });
  // GitHub's `private: false` makes the repository public.
  const visibility = b.visibility ?? (b.private === true ? "private" : b.private === false ? "public" : undefined);
  const updated = await c.get("dir").updateRepo(repo, { name: b.name, description: b.description, homepage, visibility, defaultBranch: b.default_branch, archived: b.archived });
  const changed = Object.fromEntries(Object.entries({ name: b.name, description: b.description, homepage, visibility, default_branch: b.default_branch, archived: b.archived }).filter(([, v]) => v !== undefined));
  if (b.archived !== undefined && b.archived !== !!repo.archived) auditRepo(c, caller, repo, b.archived ? "repo.archive" : "repo.unarchive");
  if (Object.keys(changed).some((k) => k !== "archived")) auditRepo(c, caller, repo, "repo.update", changed);
  return c.json(repoOut(c, updated, caller.role));
});
// Delete every object no ref, open pull request, merge queue entry or unfinished run reaches (after force-pushing a secret away).
api.post("/repos/:owner/:repo/diffinery/purge-unreachable", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo, "admin");
  requireRecentSignIn(c, `/${repo.owner_login}/${repo.name}/settings`);
  const r = await stub.purgeUnreachable(caller);
  auditRepo(c, caller, repo, "repo.purge_unreachable", { objects: r.objects, bytes: r.bytes, via: "api" });
  return c.json({ objects: r.objects, bytes: r.bytes });
});
api.delete("/repos/:owner/:repo", async (c) => {
  const { repo, caller } = await loadRepo(c, P(c).owner, P(c).repo, "admin", { whileArchived: true });
  if (caller.kind === "agent") throw new HttpError(403, "agents cannot delete repositories");
  requireRecentSignIn(c, `/${repo.owner_login}/${repo.name}/settings`);
  await c.get("dir").deleteRepo(repo);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: caller.id, actorLogin: caller.login, action: "repo.delete", target: `${repo.owner_login}/${repo.name}` }));
  return c.body(null, 204);
});
// GitHub's transfer: to the caller's own account or an organization they own or administer, optionally
// under a new name. People only: never agents, job tokens (GITHUB_TOKEN) or sandbox tokens.
api.post("/repos/:owner/:repo/transfer", async (c) => {
  const { repo, caller } = await loadRepo(c, P(c).owner, P(c).repo, "admin", { whileArchived: true });
  const p = c.get("principal");
  if (p.type !== "account" || caller.kind !== "user" || caller.permissions) throw new HttpError(403, "agents and workflow tokens cannot transfer repositories");
  requireAccountScope(c, "admin");
  requireRecentSignIn(c, `/${repo.owner_login}/${repo.name}/settings`);
  const b = await body<{ new_owner?: unknown; new_name?: unknown }>(c);
  if (typeof b.new_owner !== "string" || !b.new_owner.trim()) throw new HttpError(422, "new_owner is required", { errors: [{ resource: "Repository", code: "missing_field", field: "new_owner" }] });
  if (b.new_name !== undefined && b.new_name !== null && typeof b.new_name !== "string") throw new HttpError(422, "new_name must be a string", { errors: [{ resource: "Repository", code: "invalid", field: "new_name" }] });
  const dir = c.get("dir");
  const target = await dir.accountByLogin(b.new_owner.trim());
  if (!target) throw new HttpError(422, `no user or organization named ${b.new_owner.trim()}`, { errors: [{ resource: "Repository", code: "invalid", field: "new_owner" }] });
  const moved = await dir.transferRepo(repo, p.account, target, (b.new_name as string | null | undefined) ?? undefined);
  c.executionCtx.waitUntil(refreshRepoLimit(c.env, moved));
  auditRepo(c, caller, moved, "repo.transfer", { from: `${repo.owner_login}/${repo.name}`, to: `${moved.owner_login}/${moved.name}` });
  return c.json(repoOut(c, moved, (await dir.roleFor(p.account, moved)) ?? "read"), 202);
});
api.get("/repos/:owner/:repo/collaborators", async (c) => {
  // Who has which role is for people with push access, as on GitHub, not for every reader of a public repository.
  const { repo } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  return c.json(paginate(c, (await c.get("dir").collaborators(repo.id)).map((x) => ({ ...userJson(c, x.account), permissions: permissionsOf(x.role), role_name: x.role }))));
});
api.put("/repos/:owner/:repo/collaborators/:login", async (c) => {
  const { repo, caller } = await loadRepo(c, P(c).owner, P(c).repo, "admin", WHILE_IMPORTING);
  const who = await c.get("dir").accountByLogin(c.req.param("login"));
  if (!who) throw new HttpError(404, "user not found");
  if (who.kind === "org") throw new HttpError(422, "an organization can't be a collaborator: add its members, or transfer the repository to it");
  const b = await body<{ permission?: Role | "pull" | "push" }>(c).catch(() => ({ permission: "write" as Role }));
  const map: Record<string, Role> = { pull: "read", push: "write" };
  const role = map[b.permission ?? ""] ?? (b.permission as Role) ?? "write";
  if (!Object.hasOwn(ROLE_LEVEL, role)) throw new HttpError(422, "permission must be pull, triage, push, maintain or admin");
  // As on GitHub: someone new gets an invitation (201) and has access once they accept it; an
  // existing collaborator's role changes at once (204).
  const r = await c.get("dir").grantRepoAccess(repo, requireAccount(c), who, role);
  if ("invitedUser" in r) {
    auditRepo(c, caller, repo, "repo.invite", { login: who.login, role });
    const inv = (await c.get("dir").invites({ repoId: repo.id, pending: true })).find((i) => i.id === r.id);
    return c.json({ id: r.id, repository: { full_name: `${repo.owner_login}/${repo.name}`, name: repo.name, owner: { login: repo.owner_login } }, invitee: userJson(c, who), inviter: inv?.invitedBy ? { login: inv.invitedBy } : null, permissions: role, created_at: inv?.createdAt, expires_at: inv?.expiresAt, html_url: `${baseOf(c)}/settings/invitations` }, 201);
  }
  auditRepo(c, caller, repo, "repo.collaborator.set", { login: who.login, role });
  return c.body(null, 204);
});

// Invitations to the caller, as on GitHub: repository invitations, and organization memberships
// (pending until accepted). Accepting one gives access, so it needs a write token that isn't limited
// to repositories.
const myInvites = async (c: AppContext) => {
  requireAccountScope(c, "read");
  requireUnlimitedToken(c, "list invitations");
  return c.get("dir").invitesFor(requireAccount(c));
};
const answer = async (c: AppContext, id: string, accept: boolean) => {
  requireAccountScope(c, "write");
  requireUnlimitedToken(c, accept ? "accept invitations" : "decline invitations");
  const me = requireAccount(c);
  const dir = c.get("dir");
  await dir.answerInvite(id, me, accept);
  c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: accept ? "invite.accept" : "invite.decline", detail: { id, via: "api" } }));
};
const repoInvitationJson = (c: AppContext, me: Account, i: Awaited<ReturnType<Directory["invitesFor"]>>[number]) => {
  const [owner, name] = (i.repo ?? "/").split("/");
  return { id: i.id, repository: { full_name: i.repo, name, owner: { login: owner } }, invitee: userJson(c, me), inviter: i.invitedBy ? { login: i.invitedBy } : null, permissions: i.role, created_at: i.createdAt, expires_at: i.expiresAt, html_url: `${baseOf(c)}/settings/invitations` };
};
api.get("/user/repository_invitations", async (c) => {
  const me = requireAccount(c);
  return c.json((await myInvites(c)).filter((i) => i.repoId && i.repo).map((i) => repoInvitationJson(c, me, i)));
});
api.patch("/user/repository_invitations/:id", async (c) => {
  await answer(c, c.req.param("id"), true);
  return c.body(null, 204);
});
api.delete("/user/repository_invitations/:id", async (c) => {
  await answer(c, c.req.param("id"), false);
  return c.body(null, 204);
});
const membershipJson = (c: AppContext, me: Account, org: string, role: string, state: "active" | "pending") => ({
  url: `${baseOf(c)}/api/v3/user/memberships/orgs/${org}`,
  state,
  role: role === "owner" ? "admin" : role,
  diffinery_role: role,
  organization: { login: org, url: `${baseOf(c)}/api/v3/orgs/${org}` },
  user: userJson(c, me),
});
const myMemberships = (c: AppContext) => {
  requireAccountScope(c, "read");
  requireUnlimitedToken(c, "list organization memberships");
  return requireAccount(c);
};
api.get("/user/memberships/orgs", async (c) => {
  const me = myMemberships(c);
  const state = c.req.query("state");
  const active = state === "pending" ? [] : (await c.get("dir").orgsFor(me.id)).map((o) => membershipJson(c, me, o.login, o.role, "active"));
  const pending = state === "active" ? [] : (await myInvites(c)).filter((i) => i.org).map((i) => membershipJson(c, me, i.org!, i.role, "pending"));
  return c.json([...pending, ...active]);
});
api.get("/user/memberships/orgs/:org", async (c) => {
  const me = myMemberships(c);
  const org = c.req.param("org").toLowerCase();
  const active = (await c.get("dir").orgsFor(me.id)).find((o) => o.login.toLowerCase() === org);
  if (active) return c.json(membershipJson(c, me, active.login, active.role, "active"));
  const pending = (await myInvites(c)).find((i) => i.org?.toLowerCase() === org);
  if (pending) return c.json(membershipJson(c, me, pending.org!, pending.role, "pending"));
  throw new HttpError(404, "not found");
});
api.patch("/user/memberships/orgs/:org", async (c) => {
  requireAccountScope(c, "write");
  const me = myMemberships(c);
  const b = await body<{ state?: string }>(c).catch(() => ({ state: undefined }));
  if (b.state !== "active") throw new HttpError(422, 'state must be "active"');
  const org = c.req.param("org").toLowerCase();
  const pending = (await myInvites(c)).find((i) => i.org?.toLowerCase() === org);
  if (!pending) {
    const active = (await c.get("dir").orgsFor(me.id)).find((o) => o.login.toLowerCase() === org);
    if (active) return c.json(membershipJson(c, me, active.login, active.role, "active"));
    throw new HttpError(404, "no pending invitation to this organization");
  }
  await answer(c, pending.id, true);
  return c.json(membershipJson(c, me, pending.org!, pending.role, "active"));
});
api.delete("/repos/:owner/:repo/collaborators/:login", async (c) => {
  const { repo, caller } = await loadRepo(c, P(c).owner, P(c).repo, "admin", WHILE_IMPORTING);
  const who = await c.get("dir").accountByLogin(c.req.param("login"));
  if (who) {
    await c.get("dir").setCollaborator(repo.id, who.id, null);
    auditRepo(c, caller, repo, "repo.collaborator.remove", { login: who.login });
  }
  return c.body(null, 204);
});

// ---------------------------------------------------------------- git data

api.get("/repos/:owner/:repo/branches", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const api = repoApi(baseOf(c), P(c).owner, P(c).repo);
  let list = await stub.branches();
  if (c.req.query("protected") !== undefined) list = list.filter((b) => b.protected === (c.req.query("protected") === "true"));
  return c.json(paginate(c, list.map((b) => ({ name: b.name, commit: { sha: b.sha, url: `${api}/commits/${b.sha}` }, protected: b.protected, default: b.isDefault }))));
});
api.get("/repos/:owner/:repo/branches/:branch", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const name = c.req.param("branch");
  const b = (await stub.branches()).find((x) => x.name === name);
  if (!b) throw new HttpError(404, "Branch not found");
  const api = repoApi(baseOf(c), P(c).owner, P(c).repo);
  return c.json({
    name,
    commit: ghCommit(baseOf(c), P(c).owner, P(c).repo, await stub.commitInfo(b.sha)),
    _links: { self: `${api}/branches/${encPath(name)}`, html: `${repoHtml(baseOf(c), P(c).owner, P(c).repo)}/tree/${encPath(name)}` },
    protected: b.protected,
    protection: { enabled: b.protected, required_status_checks: { enforcement_level: b.protected ? "non_admins" : "off", contexts: [], checks: [] } },
    protection_url: `${api}/branches/${encPath(name)}/protection`,
  });
});
api.get("/repos/:owner/:repo/tags", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const api = repoApi(baseOf(c), P(c).owner, P(c).repo);
  const tags = (await stub.tags()).reverse();
  return c.json(paginate(c, tags.map((t) => ({ name: t.name, zipball_url: `${api}/zipball/refs/tags/${encPath(t.name)}`, tarball_url: `${api}/tarball/refs/tags/${encPath(t.name)}`, commit: { sha: t.target, url: `${api}/commits/${t.target}` }, node_id: nodeId("Ref", `${P(c).owner}/${P(c).repo}/refs/tags/${t.name}`) }))));
});
// GET /git/refs/<ref>: one ref when the path names it exactly, else every ref under it (GitHub's legacy form).
api.get("/repos/:owner/:repo/git/refs/*", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const name = `refs/${decodePath(c.req.path.split("/git/refs/")[1] ?? "")}`.replace(/\/$/, "");
  const all = await stub.refsWithTypes("refs/");
  const exact = all.find((r) => r.ref === name);
  if (exact) return c.json(refJson(c, exact));
  const matches = all.filter((r) => r.ref.startsWith(`${name}/`) && !r.ref.startsWith("refs/pull/"));
  if (!matches.length) throw new HttpError(404, "Not Found");
  return c.json(paginate(c, matches.map((r) => refJson(c, r)), 100));
});
api.post("/repos/:owner/:repo/git/refs", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const b = await body<{ ref: string; sha: string }>(c);
  if (typeof b.ref !== "string" || !b.ref.startsWith("refs/") || b.ref.split("/").length < 3) throw new HttpError(422, "Reference name must start with 'refs/' and have at least two slashes.", { errors: [{ resource: "Reference", code: "invalid", field: "ref" }] });
  if (typeof b.sha !== "string") throw new HttpError(422, "sha is required", { errors: [{ resource: "Reference", code: "missing_field", field: "sha" }] });
  await stub.createRef(b.ref, b.sha, caller);
  return c.json(refJson(c, { ref: b.ref, sha: b.sha, type: (await stub.objectType(b.sha)) ?? "commit" }), 201);
});
api.patch("/repos/:owner/:repo/git/refs/*", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const ref = `refs/${decodePath(c.req.path.split("/git/refs/")[1] ?? "")}`;
  const b = await body<{ sha: string; force?: boolean }>(c);
  if (typeof b.sha !== "string") throw new HttpError(422, "sha is required", { errors: [{ resource: "Reference", code: "missing_field", field: "sha" }] });
  await stub.updateRef(ref, b.sha, !!b.force, caller);
  return c.json(refJson(c, { ref, sha: b.sha, type: (await stub.objectType(b.sha)) ?? "commit" }));
});
api.delete("/repos/:owner/:repo/git/refs/*", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  await stub.deleteRef(`refs/${decodePath(c.req.path.split("/git/refs/")[1] ?? "")}`, caller);
  return c.body(null, 204);
});
api.get("/repos/:owner/:repo/commits", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const p = pageOf(c);
  // GitHub's answer when a listing is paged deeper than it allows; the history walk stops at MAX_LOG_DEPTH commits.
  if (p.offset >= MAX_LOG_DEPTH) throw new HttpError(422, "In order to keep the API fast for everyone, pagination is limited for this resource.");
  const rev = c.req.query("sha") ?? "HEAD";
  if (!(await stub.resolve(rev))) {
    if (!(await stub.resolve("HEAD"))) throw new HttpError(409, "Git Repository is empty.");
    throw new HttpError(404, `No commit found for SHA: ${rev}`);
  }
  let list = await stub.log(rev, { path: c.req.query("path"), limit: p.perPage + 1, skip: p.offset });
  const author = c.req.query("author")?.toLowerCase();
  if (author) list = list.filter((x) => x.author.email.toLowerCase() === author || x.author.name.toLowerCase() === author || x.author.email.toLowerCase().startsWith(`${author}@`));
  const since = c.req.query("since") ? Date.parse(c.req.query("since")!) / 1000 : null;
  const until = c.req.query("until") ? Date.parse(c.req.query("until")!) / 1000 : null;
  if (since) list = list.filter((x) => x.committer.timestamp >= since);
  if (until) list = list.filter((x) => x.committer.timestamp <= until);
  setLinks(c, p, null, list.length > p.perPage);
  return c.json(list.slice(0, p.perPage).map((x) => ghCommit(baseOf(c), P(c).owner, P(c).repo, x)));
});
api.get("/repos/:owner/:repo/commits/:ref", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const sha = await stub.resolve(c.req.param("ref"));
  if (!sha) throw new HttpError(422, `No commit found for SHA: ${c.req.param("ref")}`);
  const x = await stub.commitWithDiff(sha);
  const files = x.files.map((f) => ghFile(baseOf(c), P(c).owner, P(c).repo, sha, f));
  return c.json({ ...ghCommit(baseOf(c), P(c).owner, P(c).repo, x), stats: { total: x.additions + x.deletions, additions: x.additions, deletions: x.deletions }, files, truncated: x.truncated, total_files: x.totalFiles });
});
api.get("/repos/:owner/:repo/compare/:spec{.+}", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const spec = c.req.param("spec");
  const [base, head] = spec.includes("...") ? spec.split("...") : spec.split("..");
  if (!base || !head) throw new HttpError(422, "use base...head");
  const r = await stub.compare(base.includes(":") ? base.split(":")[1]! : base, head.includes(":") ? head.split(":")[1]! : head);
  const b = baseOf(c);
  const { owner, repo } = P(c);
  const api = repoApi(b, owner, repo);
  const html = repoHtml(b, owner, repo);
  const commits = paginate(c, r.commits, 250);
  return c.json({
    url: `${api}/compare/${spec}`,
    html_url: `${html}/compare/${spec}`,
    permalink_url: `${html}/compare/${r.baseSha}...${r.headSha}`,
    diff_url: `${html}/compare/${spec}.diff`,
    patch_url: `${html}/compare/${spec}.patch`,
    base_commit: ghCommit(b, owner, repo, await stub.commitInfo(r.baseSha)),
    merge_base_commit: r.mergeBase ? ghCommit(b, owner, repo, await stub.commitInfo(r.mergeBase)) : null,
    status: r.aheadBy && r.behindBy ? "diverged" : r.aheadBy ? "ahead" : r.behindBy ? "behind" : "identical",
    ahead_by: r.aheadBy,
    behind_by: r.behindBy,
    total_commits: r.aheadBy,
    commits: commits.map((x) => ghCommit(b, owner, repo, x)),
    files: r.files.map((f) => ghFile(b, owner, repo, r.headSha, f)),
    // Diffinery: the same comparison in its own words.
    base_sha: r.baseSha,
    head_sha: r.headSha,
    merge_base: r.mergeBase,
  });
});
// Contents: files come back base64-encoded with GitHub's links; `Accept: application/vnd.github.raw` returns the bytes.
async function getContents(c: AppContext) {
  const { stub, repo } = await loadRepo(c, P(c).owner, P(c).repo);
  const path = decodePath(c.req.path.split("/contents/")[1] ?? "").replace(/^\/+|\/+$/g, "");
  const ref = c.req.query("ref") || repo.default_branch;
  const sha = await stub.resolve(ref);
  if (!sha) throw new HttpError(404, `No commit found for the ref ${ref}`);
  const tree = await stub.tree(sha, path);
  if (tree) return c.json(tree.items.map((i) => contentJson(c, ref, i.path, i.oid, i.size ?? 0, i.type === "tree" ? "dir" : i.type === "commit" ? "submodule" : i.mode === "120000" ? "symlink" : "file")));
  const blob = await stub.blob(sha, path);
  if (!blob) throw new HttpError(404, "Not Found");
  if (/application\/vnd\.github(\.v3)?\.raw/.test(c.req.header("accept") ?? "")) {
    return new Response(blob.content, { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "content-security-policy": "sandbox", etag: `"${blob.oid}"` } });
  }
  const type = blob.mode === "120000" ? "symlink" : "file";
  return c.json({ ...contentJson(c, ref, path, blob.oid, blob.size, type), ...(type === "symlink" ? { target: new TextDecoder().decode(blob.content) } : {}), encoding: "base64", content: b64(blob.content).replace(/(.{60})/g, "$1\n"), commit: blob.sha });
}
api.get("/repos/:owner/:repo/contents/*", getContents);
api.get("/repos/:owner/:repo/contents", getContents);
api.put("/repos/:owner/:repo/contents/*", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const path = decodeURIComponent(c.req.path.split("/contents/")[1] ?? "");
  const b = await body<{ message: string; content: string; branch?: string; sha?: string; committer?: { name: string; email: string }; author?: { name: string; email: string } }>(c);
  if (typeof b.content !== "string") throw new HttpError(422, "content is required (base64)", { errors: [{ resource: "Contents", code: "missing_field", field: "content" }] });
  let bytes: Uint8Array;
  try {
    bytes = fromB64(b.content.replace(/\s+/g, ""));
  } catch {
    throw new HttpError(422, "content is not valid Base64", { errors: [{ resource: "Contents", code: "invalid", field: "content" }] });
  }
  const sig = (s?: { name: string; email: string }) => (s && typeof s.name === "string" && typeof s.email === "string" ? { name: s.name, email: s.email } : undefined);
  const res = await stub.putContents({ path, content: bytes, message: b.message, branch: b.branch, sha: b.sha, author: sig(b.author), committer: sig(b.committer) ?? sig(b.author) }, caller);
  const ref = b.branch || (await loadRepo(c, P(c).owner, P(c).repo)).repo.default_branch;
  return c.json({ content: contentJson(c, ref, path, res.blob.sha, res.blob.size, "file"), commit: gitCommitJson(c, res.commit) }, res.created ? 201 : 200);
});
api.delete("/repos/:owner/:repo/contents/*", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const path = decodeURIComponent(c.req.path.split("/contents/")[1] ?? "");
  const b = await body<{ message: string; branch?: string; sha?: string; committer?: { name: string; email: string }; author?: { name: string; email: string } }>(c);
  const commit = await stub.deleteContents({ path, message: b.message, branch: b.branch, sha: b.sha, author: b.author, committer: b.committer ?? b.author }, caller);
  return c.json({ content: null, commit: gitCommitJson(c, commit) });
});

/** Agent-friendly multi-file commit without a Git client. */
api.post("/repos/:owner/:repo/diffinery/commits", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const b = await body<{ branch: string; message: string; base?: string; expected_head_sha?: string; allow_secrets?: string; files: Array<{ path: string; content?: string; encoding?: "utf-8" | "base64"; delete?: boolean; mode?: "100644" | "100755" }> }>(c);
  if (!Array.isArray(b.files) || b.files.length === 0) throw new HttpError(422, "files is required");
  const changes = b.files.map((f) => (f.delete ? { path: f.path, delete: true } : { path: f.path, mode: f.mode, content: f.encoding === "base64" ? fromB64(f.content ?? "") : new TextEncoder().encode(f.content ?? "") }));
  return c.json(await stub.commitFiles({ branch: b.branch, message: b.message, changes, createBranchFrom: b.base, expectedHeadSha: b.expected_head_sha, allowSecrets: typeof b.allow_secrets === "string" ? b.allow_secrets : undefined }, caller), 201);
});

api.get("/repos/:owner/:repo/raw/:ref/*", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const path = decodeURIComponent(c.req.path.split(`/raw/${c.req.param("ref")}/`)[1] ?? "");
  const blob = await stub.blob(c.req.param("ref"), path);
  if (!blob) throw new HttpError(404, "not found");
  return new Response(blob.content, { headers: { "content-type": blob.binary ? "application/octet-stream" : "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" } });
});

// ---------------------------------------------------------------- branch protection

api.get("/repos/:owner/:repo/branches/:branch/protection", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo, "admin");
  const rule = (await stub.listProtections()).find((p) => p.pattern === c.req.param("branch"));
  if (!rule) throw new HttpError(404, "branch not protected");
  return c.json(rule);
});
api.put("/repos/:owner/:repo/branches/:branch/protection", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo, "admin");
  if (caller.kind === "agent") throw new HttpError(403, "agents cannot change branch protection");
  const input = await body<ProtectionRulesInput>(c);
  await stub.setProtection(c.req.param("branch"), input, caller);
  auditRepo(c, caller, repo, "repo.protection.set", { pattern: c.req.param("branch") });
  // As stored: autoMergeAgents named by login come back as { id, login }.
  const saved = (await stub.listProtections()).find((p) => p.pattern === c.req.param("branch"));
  return c.json({ pattern: c.req.param("branch"), rules: saved?.rules ?? input });
});
api.delete("/repos/:owner/:repo/branches/:branch/protection", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo, "admin");
  if (caller.kind === "agent") throw new HttpError(403, "agents cannot change branch protection");
  await stub.setProtection(c.req.param("branch"), null, caller);
  auditRepo(c, caller, repo, "repo.protection.delete", { pattern: c.req.param("branch") });
  return c.body(null, 204);
});

// ---------------------------------------------------------------- issues & pulls

/** Label names from a GitHub payload (strings or `{ name }` objects). */
const labelNames = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map((l) => (typeof l === "string" ? l : String((l as { name?: unknown })?.name ?? ""))).filter(Boolean) : undefined);
/** Assignee logins from `assignees` or the older singular `assignee`. */
const assigneeLogins = (b: { assignees?: unknown; assignee?: unknown }): string[] | undefined =>
  Array.isArray(b.assignees) ? b.assignees.map(String) : b.assignee === null ? [] : typeof b.assignee === "string" ? [b.assignee] : undefined;
const sortParam = (v: string | undefined) => (v === "updated" || v === "comments" || v === "created" ? v : undefined);

for (const kind of ["issues", "pulls"] as const) {
  api.get(`/repos/:owner/:repo/${kind}`, async (c) => {
    const { stub, repo } = await loadRepo(c, P(c).owner, P(c).repo);
    const p = pageOf(c);
    const q = (k: string) => c.req.query(k) || undefined;
    const labels = q("labels")?.split(",").map((l) => l.trim()).filter(Boolean);
    const head = q("head");
    // `milestone`: a milestone number, `none` or `*` (any), as on GitHub.
    const ms = q("milestone");
    if (ms && !/^(\d+|none|\*)$/.test(ms)) throw new HttpError(422, "milestone must be a milestone number, none or *");
    const res = await stub.issues({
      milestone: ms === "none" || ms === "*" ? ms : ms ? Number(ms) : undefined,
      kind: kind === "pulls" ? "pull" : undefined,
      state: (q("state") as "open" | "closed" | "all") ?? "open",
      labels,
      author: q("creator"),
      assignee: q("assignee"),
      since: q("since"),
      head: head?.includes(":") ? head.slice(head.indexOf(":") + 1) : head,
      base: q("base"),
      sort: kind === "pulls" && q("sort") === "popularity" ? "comments" : sortParam(q("sort")),
      direction: q("direction") === "asc" ? "asc" : q("direction") === "desc" ? "desc" : undefined,
      q: q("q"),
      limit: p.perPage,
      offset: p.offset,
      hide: await hiddenAuthors(c),
    });
    c.header("x-total-count", String(res.total));
    setLinks(c, p, res.total);
    return c.json(kind === "pulls" ? await pullsOut(c, repo, stub, res.items) : await issuesOut(c, repo, stub, res.items));
  });
}
api.post("/repos/:owner/:repo/issues", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo);
  const b = await body<{ title: string; body?: string; labels?: unknown; assignees?: unknown; assignee?: unknown }>(c);
  if (typeof b.title !== "string" && typeof b.title !== "number") throw new HttpError(422, "title is required", { errors: [{ resource: "Issue", code: "missing_field", field: "title" }] });
  const issue = await stub.createIssue({ title: String(b.title), body: b.body ?? undefined, labels: labelNames(b.labels), assignees: assigneeLogins(b) }, caller);
  return c.json((await issuesOut(c, repo, stub, [issue]))[0], 201);
});
api.get("/repos/:owner/:repo/issues/:number", async (c) => {
  const { stub, repo } = await loadRepo(c, P(c).owner, P(c).repo);
  return c.json((await issuesOut(c, repo, stub, [(await stub.issue(num(c), await hiddenAuthors(c))).issue]))[0]);
});
api.patch("/repos/:owner/:repo/issues/:number", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo);
  const b = await body<{ title?: string; body?: string | null; state?: "open" | "closed"; state_reason?: string | null; labels?: unknown; assignees?: unknown; assignee?: unknown; milestone?: unknown }>(c);
  // `milestone` (a number or null) is checked before anything is saved. As with labels and assignees,
  // it is silently dropped for people without triage access.
  if (b.milestone !== undefined && b.milestone !== null && (typeof b.milestone !== "number" || !Number.isInteger(b.milestone))) throw new HttpError(422, "milestone must be a milestone number or null");
  const milestone = atLeast(caller.role, "triage") ? (b.milestone as number | null | undefined) : undefined;
  if (typeof milestone === "number" && !(await stub.milestones("all")).some((m) => m.number === milestone)) throw new HttpError(422, "Validation Failed", { errors: [{ resource: "Issue", code: "invalid", field: "milestone" }] });
  let issue = await stub.updateIssue(num(c), { title: b.title, body: b.body ?? undefined, state: b.state, stateReason: b.state_reason ?? undefined, labels: labelNames(b.labels), assignees: assigneeLogins(b) }, caller);
  if (milestone !== undefined) {
    await stub.setIssueMilestone(num(c), milestone);
    issue = (await stub.issue(num(c))).issue;
  }
  return c.json((await issuesOut(c, repo, stub, [issue]))[0]);
});
api.get("/repos/:owner/:repo/issues/:number/comments", async (c) => {
  const { stub, repo } = await loadRepo(c, P(c).owner, P(c).repo);
  const n = num(c);
  const { issue, comments } = await stub.issue(n, await hiddenAuthors(c));
  const since = c.req.query("since");
  const list = paginate(c, comments.filter((x) => !x.reviewId && (!since || x.updatedAt >= since)));
  const x = await issueCtx(c, repo, stub, [], list.map((cm) => `comment:${cm.id}`));
  return c.json(list.map((cm) => ghComment(x, n, issue.kind === "pull", cm)));
});
api.post("/repos/:owner/:repo/issues/:number/comments", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo);
  const n = num(c);
  const b = await body<{ body: string }>(c);
  if (typeof b.body !== "string") throw new HttpError(422, "body is required", { errors: [{ resource: "IssueComment", code: "missing_field", field: "body" }] });
  const cm = await stub.addComment(n, b.body, caller);
  const { issue } = await stub.issue(n);
  return c.json(ghComment(await issueCtx(c, repo, stub, []), n, issue.kind === "pull", cm), 201);
});
api.patch("/repos/:owner/:repo/issues/comments/:id", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo);
  const b = await body<{ body: string }>(c);
  if (typeof b.body !== "string" || !b.body.trim()) throw new HttpError(422, "body is required", { errors: [{ resource: "IssueComment", code: "missing_field", field: "body" }] });
  await stub.editComment(c.req.param("id"), b.body, caller);
  const found = await stub.comment(c.req.param("id"));
  return c.json(ghComment(await issueCtx(c, repo, stub, [], [`comment:${found.comment.id}`]), found.number, found.isPull, found.comment));
});
api.get("/repos/:owner/:repo/labels", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  return c.json(paginate(c, (await stub.labelRows()).map((l) => ghLabel(baseOf(c), P(c).owner, P(c).repo, l))));
});
api.post("/repos/:owner/:repo/labels", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "triage");
  const b = await body<{ name: string; color?: string; description?: string }>(c);
  return c.json(ghLabel(baseOf(c), P(c).owner, P(c).repo, await stub.createLabel(b, caller)), 201);
});

api.post("/repos/:owner/:repo/pulls", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const b = await body<{ title: string; body?: string; head: string; base?: string; draft?: boolean; intent?: string; reviewers?: string[]; auto_merge?: boolean }>(c);
  if (typeof b.head !== "string" || !b.head) throw new HttpError(422, "head is required", { errors: [{ resource: "PullRequest", code: "missing_field", field: "head" }] });
  if (b.auto_merge !== undefined && typeof b.auto_merge !== "boolean") throw new HttpError(422, "auto_merge must be true or false");
  // auto_merge is Diffinery's: true turns auto-merge on as the pull request opens, false keeps it off even where the
  // opener's own setting turns it on. When it was asked for and stayed off, auto_merge_skipped says why.
  const { auto_merge, ...rest } = b;
  const issue = await stub.createPull({ ...rest, head: b.head.includes(":") ? b.head.split(":")[1]! : b.head, ...(auto_merge !== undefined ? { autoMerge: auto_merge } : {}) }, caller);
  const out = (await pullsOut(c, repo, stub, [issue]))[0];
  return c.json(issue.autoMergeSkipped ? { ...out, auto_merge_skipped: issue.autoMergeSkipped } : out, 201);
});
api.get("/repos/:owner/:repo/pulls/:number", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo);
  // GitHub's diff media type (`gh pr diff` asks for it): the changes as one unified diff.
  if (/application\/vnd\.github(\.v3)?\.(diff|patch)/.test(c.req.header("accept") ?? "")) {
    const res = await stub.pullFiles(num(c));
    return new Response(res.files.map((f) => f.patch ?? "").join(""), { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" } });
  }
  return c.json(await pullDetail(c, repo, stub, num(c), caller));
});
api.patch("/repos/:owner/:repo/pulls/:number", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo);
  const b = await body<{ title?: string; body?: string | null; state?: "open" | "closed"; draft?: boolean }>(c);
  // `draft` is a Diffinery extension (GitHub only offers it through GraphQL).
  if (typeof b.draft === "boolean") await stub.setPullDraft(num(c), b.draft, caller);
  const issue = b.title !== undefined || b.body !== undefined || b.state !== undefined ? await stub.updateIssue(num(c), { title: b.title, body: b.body ?? undefined, state: b.state }, caller) : (await stub.issue(num(c))).issue;
  if (issue.kind !== "pull") throw new HttpError(404, "not a pull request");
  return c.json((await pullsOut(c, repo, stub, [issue]))[0]);
});
api.get("/repos/:owner/:repo/pulls/:number/files", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const res = await stub.pullFiles(num(c));
  return c.json(paginate(c, res.files.map((f) => ({ ...ghFile(baseOf(c), P(c).owner, P(c).repo, res.headSha, f), binary: f.binary }))));
});
api.get("/repos/:owner/:repo/pulls/:number/commits", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  return c.json(paginate(c, (await stub.pullCommits(num(c))).map((x) => ghCommit(baseOf(c), P(c).owner, P(c).repo, x)), 250));
});
// GitHub clients (Accept: application/vnd.github...) get GitHub's "is it merged" answer: 204 or 404.
// Other clients get Diffinery's mergeability report: blockers, approvals, checks and the merge queue.
api.get("/repos/:owner/:repo/pulls/:number/merge", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo);
  const n = num(c);
  if ((c.req.header("accept") ?? "").includes("application/vnd.github")) {
    const { issue } = await stub.issue(n);
    if (issue.pull?.merged) return c.body(null, 204);
    throw new HttpError(404, "Not Found");
  }
  return c.json(await stub.mergeability(n, caller));
});
api.put("/repos/:owner/:repo/pulls/:number/merge", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const b = await body<{ merge_method?: "merge" | "squash" | "rebase"; commit_title?: string; commit_message?: string; sha?: string; delete_branch?: boolean; bypass_merge_queue?: boolean; bypass_rules?: boolean }>(c).catch(() => ({}) as Record<string, undefined>);
  const r = await stub.mergePull(num(c), { method: b.merge_method, title: b.commit_title, message: b.commit_message, expectedHeadSha: b.sha, deleteBranch: b.delete_branch, bypassMergeQueue: b.bypass_merge_queue, bypassRules: b.bypass_rules }, caller);
  return c.json({ ...r, message: "Pull Request successfully merged" });
});

// Merge queue (GitHub exposes it through GraphQL only; these follow its REST conventions).
const queueJson = (e: QueueEntry) => ({
  number: e.number,
  title: e.title,
  base_ref: e.base,
  position: e.position,
  state: e.state,
  head_sha: e.headSha,
  merge_method: e.method,
  delete_branch: e.deleteBranch,
  enqueued_by: { login: e.enqueuedBy.login },
  enqueued_at: e.enqueuedAt,
  merge_group: e.groupSha ? { head_sha: e.groupSha, head_ref: e.groupRef, base_sha: e.parentSha, built_at: e.builtAt } : null,
  checks: e.checks,
});
api.get("/repos/:owner/:repo/merge-queue/:branch{.+}", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const branch = c.req.param("branch");
  const settings = await stub.mergeQueueSettings(branch);
  return c.json({ branch, enabled: !!settings, settings, entries: (await stub.mergeQueue(branch)).map(queueJson) });
});
api.put("/repos/:owner/:repo/pulls/:number/merge-queue", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const b = await body<{ merge_method?: "merge" | "squash" | "rebase"; delete_branch?: boolean }>(c).catch(() => ({}) as Record<string, undefined>);
  const r = await stub.enqueuePull(num(c), { method: b.merge_method, deleteBranch: b.delete_branch }, caller);
  return c.json({ state: r.state, entry: r.entry ? queueJson(r.entry) : null, merge_commit_sha: r.mergeCommit ?? null, reason: r.reason ?? null }, r.state === "queued" ? 201 : 200);
});
api.delete("/repos/:owner/:repo/pulls/:number/merge-queue", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  await stub.dequeuePull(num(c), caller);
  return c.body(null, 204);
});
// Auto-merge (GitHub's enablePullRequestAutoMerge and disablePullRequestAutoMerge, which it exposes through GraphQL only).
api.put("/repos/:owner/:repo/pulls/:number/auto-merge", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const b = await body<{ merge_method?: string; commit_title?: string; commit_message?: string; delete_branch?: unknown; sha?: unknown }>(c).catch(() => ({}) as Record<string, undefined>);
  if (b.delete_branch !== undefined && typeof b.delete_branch !== "boolean") throw new HttpError(422, "delete_branch must be a boolean", { errors: [{ resource: "PullRequest", code: "invalid", field: "delete_branch" }] });
  if (b.sha !== undefined && typeof b.sha !== "string") throw new HttpError(422, "sha must be a string", { errors: [{ resource: "PullRequest", code: "invalid", field: "sha" }] });
  const r = await stub.enableAutoMerge(num(c), { method: b.merge_method, commitTitle: b.commit_title, commitMessage: b.commit_message, deleteBranch: b.delete_branch, expectedHeadSha: b.sha || undefined }, caller);
  return c.json({ state: r.state, auto_merge: ghAutoMerge(baseOf(c), r.autoMerge), merge_commit_sha: r.mergeCommit ?? null });
});
api.delete("/repos/:owner/:repo/pulls/:number/auto-merge", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  await stub.disableAutoMerge(num(c), caller);
  return c.body(null, 204);
});
api.get("/repos/:owner/:repo/pulls/:number/reviews", async (c) => {
  const { stub, repo } = await loadRepo(c, P(c).owner, P(c).repo);
  const n = num(c);
  const x = await issueCtx(c, repo, stub, []);
  return c.json(paginate(c, (await stub.issue(n, await hiddenAuthors(c))).reviews.map((r) => ghReview(x, n, r))));
});
api.post("/repos/:owner/:repo/pulls/:number/reviews", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo);
  const n = num(c);
  const b = await body<{ event?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string; commit_id?: string; comments?: Array<{ path: string; line?: number; position?: number; side?: "LEFT" | "RIGHT"; body: string }> }>(c);
  if (b.event && !["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(b.event)) throw new HttpError(422, "event must be APPROVE, REQUEST_CHANGES or COMMENT", { errors: [{ resource: "PullRequestReview", code: "invalid", field: "event" }] });
  const comments = Array.isArray(b.comments) ? b.comments.map((cm) => ({ path: String(cm.path), line: Number(cm.line ?? cm.position), side: cm.side, body: String(cm.body ?? "") })) : undefined;
  if (comments?.some((cm) => !cm.path || !Number.isInteger(cm.line) || cm.line < 1 || !cm.body)) throw new HttpError(422, "each review comment needs a path, a line and a body", { errors: [{ resource: "PullRequestReviewComment", code: "invalid", field: "comments" }] });
  const r = await stub.submitReview(n, { event: b.event ?? "COMMENT", body: b.body, comments }, caller);
  return c.json(ghReview(await issueCtx(c, repo, stub, []), n, r), 201);
});
api.get("/repos/:owner/:repo/pulls/:number/comments", async (c) => {
  const { stub, repo } = await loadRepo(c, P(c).owner, P(c).repo);
  const n = num(c);
  const list = paginate(c, (await stub.issue(n, await hiddenAuthors(c))).comments.filter((x) => x.reviewId));
  const x = await issueCtx(c, repo, stub, [], list.map((cm) => `review_comment:${cm.id}`));
  return c.json(list.map((cm) => ghReviewComment(x, n, cm)));
});
api.post("/repos/:owner/:repo/pulls/:number/requested_reviewers", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo);
  const n = num(c);
  const b = await body<{ reviewers?: string[]; team_reviewers?: string[] }>(c);
  if (b.team_reviewers?.length) throw new HttpError(422, "team reviewers are not supported; request people by login");
  await stub.requestReviewers(n, (b.reviewers ?? []).map(String), caller);
  return c.json((await pullsOut(c, repo, stub, [(await stub.issue(n)).issue]))[0], 201);
});

// ---------------------------------------------------------------- checks (for plugins and external CI)

api.get("/repos/:owner/:repo/commits/:ref/check-runs", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const sha = await stub.resolve(c.req.param("ref"));
  if (!sha) throw new HttpError(404, "ref not found");
  let runs = await stub.checks(sha);
  const name = c.req.query("check_name");
  const status = c.req.query("status");
  if (name) runs = runs.filter((r) => r.name === name);
  if (status) runs = runs.filter((r) => r.status === status);
  const page = paginate(c, runs);
  return c.json({ total_count: runs.length, check_runs: page.map((r) => checkRunJson(c, r)) });
});
api.post("/repos/:owner/:repo/check-runs", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const b = await body<{ name: string; head_sha: string; status?: "queued" | "in_progress" | "completed"; conclusion?: string; details_url?: string; external_id?: string; started_at?: string; completed_at?: string; output?: { title?: string; summary?: string; text?: string; annotations?: unknown[] } }>(c);
  if (typeof b.name !== "string" || !b.name || b.name.length > 255) throw new HttpError(422, "name is required", { errors: [{ resource: "CheckRun", code: "missing_field", field: "name" }] });
  if (/^diffinery-(actions|agent-review)/i.test(caller.login)) throw new HttpError(403, "this account can't report check runs");
  const sha = typeof b.head_sha === "string" ? await stub.resolve(b.head_sha) : null;
  if (!sha) throw new HttpError(422, "head_sha is not a commit in this repository", { errors: [{ resource: "CheckRun", code: "invalid", field: "head_sha" }] });
  // Shown as a link on the pull request, so only web addresses (as the web UI already insists).
  if (b.details_url !== undefined && b.details_url !== null && (typeof b.details_url !== "string" || b.details_url.length > 2000 || !/^https?:\/\/[^\s]+$/i.test(b.details_url))) throw new HttpError(422, "details_url must be an http or https URL", { errors: [{ resource: "CheckRun", code: "invalid", field: "details_url" }] });
  const status = b.conclusion ? "completed" : (b.status ?? "queued");
  const { annotations: _a, text: _t, ...output } = b.output ?? {};
  let check = await stub.upsertCheck({ sha, name: b.name, status, conclusion: b.conclusion, detailsUrl: b.details_url, output: b.output ? output : undefined, app: isAppCaller(caller) ? caller.login.replace(/\[bot\]$/, "") : caller.login, creator: { id: caller.id, login: caller.login, kind: caller.kind } });
  if (b.external_id !== undefined || b.output?.text !== undefined || Array.isArray(b.output?.annotations)) check = await stub.updateCheckRun(check.id, { external_id: b.external_id, output: b.output }, caller);
  return c.json(checkRunJson(c, check), 201);
});

// ---------------------------------------------------------------- actions

const runJson = (c: AppContext, owner: string, repo: string, r: RunInfo) => ghRun(baseOf(c), owner, repo, r);

api.get("/repos/:owner/:repo/actions/workflows", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const wfs = await stub.workflows();
  return c.json({ total_count: wfs.length, workflows: wfs.map((w) => ({ id: w.path, name: w.name, path: w.path, state: w.errors.length ? "invalid" : "active", errors: w.errors, triggers: w.triggers })) });
});
api.post("/repos/:owner/:repo/actions/workflows/:workflow/dispatches", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const b = await body<{ ref: string; inputs?: Record<string, unknown> }>(c);
  const run = await stub.dispatchWorkflow(decodeURIComponent(c.req.param("workflow")), b.ref, b.inputs ?? {}, caller);
  return c.json({ run_id: run.id, html_url: `${c.env.PUBLIC_URL}/${P(c).owner}/${P(c).repo}/actions/runs/${run.id}` }, 201);
});
// Self-hosted runners poll this to pick up `runs-on: [self-hosted, ...]` jobs (see `diffinery runner`).
// Only a registered runner claims, with its own token and the labels it registered with. A person's
// token can't: it would sit on the runner machine where the jobs it runs could read it.
api.post("/repos/:owner/:repo/actions/runners/claim", async (c) => {
  const p = c.get("principal");
  if (p.type === "repo-token" && p.token.startsWith("drn_")) {
    const repo = await c.get("dir").repo(P(c).owner, P(c).repo);
    if (!repo || repo.id !== p.repoId) throw new HttpError(401, "this runner token belongs to another repository");
    const job = await repoStub(c.env, repo.id).claimJobAsRunner(p.token);
    if (!job) return c.body(null, 204);
    return c.json({ job_id: job.jobId, run_id: job.runId, name: job.name, token: job.token, api_url: new URL(c.req.url).origin });
  }
  await loadRepo(c, P(c).owner, P(c).repo, "admin");
  throw new HttpError(403, `personal tokens can't claim jobs; register this runner: run \`diffinery runner -R ${P(c).owner}/${P(c).repo}\` signed in with an up-to-date CLI, or pass --registration-token (see /docs/actions/runners)`);
});
// GitHub's runner registration token: an hour to register runners (`diffinery runner --registration-token`).
api.post("/repos/:owner/:repo/actions/runners/registration-token", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "admin");
  if (c.get("principal").type !== "account") throw new HttpError(403, "only repository admins can add self-hosted runners");
  const t = await stub.runnerRegistrationToken(caller);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: caller.id, actorLogin: caller.login, action: "runner.registration_token", target: `${P(c).owner}/${P(c).repo}` }));
  return c.json(t, 201);
});
// A machine trades a registration token for its own runner token. The registration token is the only credential.
api.post("/repos/:owner/:repo/actions/runners/register", async (c) => {
  const b = await body<{ registration_token?: unknown; name?: unknown; labels?: unknown; ephemeral?: unknown }>(c);
  if (typeof b.registration_token !== "string" || !b.registration_token.startsWith("drg_")) throw new HttpError(401, "invalid or expired registration token");
  // A repository that doesn't exist answers like a wrong token, so the endpoint can't probe for private names.
  const repo = await c.get("dir").repo(P(c).owner, P(c).repo);
  if (!repo) throw new HttpError(401, "invalid or expired registration token");
  const labels = Array.isArray(b.labels) ? b.labels.map(String) : [];
  const { registeredBy, ...runner } = await repoStub(c.env, repo.id).registerRunner(b.registration_token, typeof b.name === "string" ? b.name : "runner", labels, b.ephemeral === true);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorLogin: registeredBy, action: "runner.register", target: `${repo.owner_login}/${repo.name}`, detail: { id: runner.id, name: runner.name, labels: runner.labels, ephemeral: runner.ephemeral } }));
  return c.json(runner, 201);
});
api.get("/repos/:owner/:repo/actions/runners", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "admin");
  const runners = await stub.runners(caller);
  return c.json({ total_count: runners.length, runners });
});
api.delete("/repos/:owner/:repo/actions/runners/:id", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "admin");
  await stub.deleteRunner(Number(c.req.param("id")), caller);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: caller.id, actorLogin: caller.login, action: "runner.remove", target: `${P(c).owner}/${P(c).repo}`, detail: { id: Number(c.req.param("id")) } }));
  return c.body(null, 204);
});
api.get("/repos/:owner/:repo/actions/runs", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const perPage = Math.min(Math.max(Math.trunc(Number(c.req.query("per_page") ?? 25)) || 25, 1), 100);
  const page = Math.min(Math.max(Math.trunc(Number(c.req.query("page") ?? 1)) || 1, 1), 1000);
  const res = await stub.runs({ workflow: c.req.query("workflow"), branch: c.req.query("branch"), status: c.req.query("status"), event: c.req.query("event"), sha: c.req.query("head_sha"), limit: perPage, offset: (page - 1) * perPage });
  setLinks(c, { page, perPage, offset: (page - 1) * perPage }, res.total);
  return c.json({ total_count: res.total, workflow_runs: res.runs.map((r) => runJson(c, P(c).owner, P(c).repo, r)) });
});
api.get("/repos/:owner/:repo/actions/runs/:id", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const r = await stub.run(c.req.param("id"));
  return c.json({ ...runJson(c, P(c).owner, P(c).repo, r), jobs: r.jobs });
});
api.get("/repos/:owner/:repo/actions/runs/:id/jobs", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const run = await stub.run(c.req.param("id"));
  const jobs = (await stub.runJobs(c.req.param("id"))) as unknown as JobInfo[];
  return c.json({ total_count: jobs.length, jobs: paginate(c, jobs).map((j) => jobJson(c, P(c).owner, P(c).repo, run, j)) });
});
api.post("/repos/:owner/:repo/actions/runs/:id/cancel", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  await stub.cancelRun(c.req.param("id"), caller);
  return c.json({}, 202);
});
// GitHub answers `{}`; `run_id` is the new attempt's. The body's `enable_debug_logging` is accepted and ignored.
for (const [path, scope] of [["rerun", "all"], ["rerun-failed-jobs", "failed"]] as const) {
  api.post(`/repos/:owner/:repo/actions/runs/:id/${path}`, async (c) => {
    const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
    const r = await stub.rerun(c.req.param("id"), caller, scope);
    return c.json({ run_id: r.id }, 201);
  });
}
api.post("/repos/:owner/:repo/actions/jobs/:id/rerun", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const r = await stub.rerunJob(c.req.param("id"), caller);
  return c.json({ run_id: r.id }, 201);
});
api.get("/repos/:owner/:repo/actions/jobs/:id", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const job = (await stub.job(c.req.param("id"))) as unknown as JobInfo;
  return c.json(jobJson(c, P(c).owner, P(c).repo, await stub.run(job.runId), job));
});
api.get("/repos/:owner/:repo/actions/jobs/:id/logs", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const { lines } = await stub.jobLogs(c.req.param("id"), Number(c.req.query("after") ?? -1));
  if (c.req.query("format") === "json") return c.json(lines);
  return c.text(lines.map((l) => `${l.t} ${l.text}`).join("\n"));
});
api.route("/", actionsRest);
api.get("/repos/:owner/:repo/actions/secrets", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo, "admin");
  const s = await stub.secretNames();
  return c.json({ total_count: s.length, secrets: s.map((x) => ({ name: x.name, updated_at: x.updatedAt })) });
});
api.put("/repos/:owner/:repo/actions/secrets/:name", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo, "admin", WHILE_IMPORTING);
  if (caller.kind === "agent") throw new HttpError(403, "agents cannot manage secrets");
  const b = await body<{ value: string; encrypted_value?: string }>(c);
  if (typeof b.value !== "string" && typeof b.encrypted_value === "string") throw new HttpError(422, "encrypted_value (sealed box) is not supported yet: send the secret as `value` over HTTPS; it is encrypted at rest");
  if (typeof b.value !== "string") throw new HttpError(422, "value is required (send it over HTTPS; it is encrypted at rest)");
  await stub.setSecret(c.req.param("name"), b.value);
  auditRepo(c, caller, repo, "repo.secret.set", { name: c.req.param("name").toUpperCase() });
  return c.body(null, 204);
});
api.delete("/repos/:owner/:repo/actions/secrets/:name", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo, "admin", WHILE_IMPORTING);
  refuseAgent(caller, "secrets");
  await stub.deleteSecret(c.req.param("name"));
  auditRepo(c, caller, repo, "repo.secret.delete", { name: c.req.param("name").toUpperCase() });
  return c.body(null, 204);
});
api.get("/repos/:owner/:repo/actions/variables", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  // The repository's own variables; organization variables are listed under /orgs/:org/actions/variables.
  const all = Object.entries(await stub.variables(false)).map(([name, value]) => ({ name, value }));
  return c.json({ total_count: all.length, variables: paginate(c, all) });
});
api.delete("/repos/:owner/:repo/actions/variables/:name", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo, "admin", WHILE_IMPORTING);
  refuseAgent(caller, "variables");
  await stub.setVariable(c.req.param("name"), null);
  auditRepo(c, caller, repo, "repo.variable.delete", { name: c.req.param("name").toUpperCase() });
  return c.body(null, 204);
});
api.put("/repos/:owner/:repo/actions/variables/:name", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo, "admin", WHILE_IMPORTING);
  refuseAgent(caller, "variables");
  await stub.setVariable(c.req.param("name"), (await body<{ value: string }>(c)).value);
  auditRepo(c, caller, repo, "repo.variable.set", { name: c.req.param("name").toUpperCase() });
  return c.body(null, 204);
});
async function orgAdmin(c: AppContext) {
  requireAccountScope(c, "admin");
  const a = requireAccount(c);
  if (a.kind === "agent") throw new HttpError(403, "agents cannot manage secrets");
  const dir = c.get("dir");
  const org = await dir.accountByLogin(c.req.param("org")!);
  if (!org || org.kind !== "org") throw new HttpError(404, "not found");
  const role = await dir.orgRole(org.id, a.id);
  if (role !== "owner" && role !== "admin" && !a.site_admin) throw new HttpError(403, "organization admins only");
  return { a, org };
}
type OrgSecretRow = { name: string; updated_at: string; visibility: "all" | "private" | "selected" };
const ORG_SECRET_VISIBILITY = ["all", "private", "selected"] as const;
const orgSecretJson = (c: AppContext, org: Account, s: OrgSecretRow) => ({
  name: s.name,
  created_at: s.updated_at,
  updated_at: s.updated_at,
  visibility: s.visibility,
  ...(s.visibility === "selected" ? { selected_repository_ids_url: `${c.env.PUBLIC_URL}/api/v3/orgs/${org.login}/actions/secrets/${s.name}/repositories`, selected_repositories_url: `${c.env.PUBLIC_URL}/api/v3/orgs/${org.login}/actions/secrets/${s.name}/repositories` } : {}),
});
/** The organization's repositories with the given numeric (GitHub) ids; 422 for any id that isn't one of them. */
async function orgReposById(c: AppContext, org: Account, ids: unknown): Promise<Repo[]> {
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "number" && typeof x !== "string")) throw new HttpError(422, "selected_repository_ids must be a list of repository ids");
  if (ids.length > 1000) throw new HttpError(422, "at most 1000 repositories can be selected");
  const repos = await c.get("dir").reposVisibleTo(requireAccount(c), org.id);
  const byId = new Map(repos.map((r) => [String(numericId(r.id)), r]));
  return ids.map((x) => {
    const r = byId.get(String(x));
    if (!r) throw new HttpError(422, `${x} isn't a repository of ${org.login}`);
    return r;
  });
}
async function orgSecret(c: AppContext, org: Account, name: string): Promise<OrgSecretRow> {
  const s = await c.env.DB.prepare("SELECT name, updated_at, visibility FROM org_secrets WHERE org_id = ? AND name = ?").bind(org.id, name.toUpperCase()).first<OrgSecretRow>();
  if (!s) throw new HttpError(404, "secret not found");
  return s;
}
async function setSecretRepos(c: AppContext, org: Account, name: string, repos: Repo[]): Promise<void> {
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM org_secret_repos WHERE org_id = ? AND name = ?").bind(org.id, name),
    ...repos.map((r) => c.env.DB.prepare("INSERT OR IGNORE INTO org_secret_repos (org_id, name, repo_id) VALUES (?, ?, ?)").bind(org.id, name, r.id)),
  ]);
}
api.get("/orgs/:org/actions/secrets", async (c) => {
  const { org } = await orgAdmin(c);
  const { results } = await c.env.DB.prepare("SELECT name, updated_at, visibility FROM org_secrets WHERE org_id = ? ORDER BY name").bind(org.id).all<OrgSecretRow>();
  return c.json({ total_count: results.length, secrets: results.map((s) => orgSecretJson(c, org, s)) });
});
api.get("/orgs/:org/actions/secrets/:name", async (c) => {
  const { org } = await orgAdmin(c);
  return c.json(orgSecretJson(c, org, await orgSecret(c, org, c.req.param("name"))));
});
// GitHub's repository selection for a secret with `visibility: selected`.
api.get("/orgs/:org/actions/secrets/:name/repositories", async (c) => {
  const { org } = await orgAdmin(c);
  const s = await orgSecret(c, org, c.req.param("name"));
  const { results } = await c.env.DB.prepare("SELECT r.* FROM org_secret_repos x JOIN repos r ON r.id = x.repo_id WHERE x.org_id = ? AND x.name = ? ORDER BY r.name").bind(org.id, s.name).all<{ id: string }>();
  const repos = (await Promise.all(results.map((r) => c.get("dir").repoById(r.id)))).filter((r): r is Repo => !!r);
  return c.json({ total_count: repos.length, repositories: repos.map((r) => repoJson(c, r)) });
});
api.put("/orgs/:org/actions/secrets/:name/repositories", async (c) => {
  const { a, org } = await orgAdmin(c);
  const s = await orgSecret(c, org, c.req.param("name"));
  if (s.visibility !== "selected") throw new HttpError(409, "the secret's visibility isn't selected");
  const repos = await orgReposById(c, org, (await body<{ selected_repository_ids?: unknown }>(c)).selected_repository_ids);
  await setSecretRepos(c, org, s.name, repos);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: a.id, actorLogin: a.login, action: "org.secret.repositories", target: org.login, detail: { name: s.name, repositories: repos.map((r) => r.name), via: "api" } }));
  return c.body(null, 204);
});
for (const method of ["put", "delete"] as const) {
  api[method]("/orgs/:org/actions/secrets/:name/repositories/:repoId", async (c) => {
    const { a, org } = await orgAdmin(c);
    const s = await orgSecret(c, org, c.req.param("name"));
    if (s.visibility !== "selected") throw new HttpError(409, "the secret's visibility isn't selected");
    const [repo] = await orgReposById(c, org, [c.req.param("repoId")]);
    if (method === "put") await c.env.DB.prepare("INSERT OR IGNORE INTO org_secret_repos (org_id, name, repo_id) VALUES (?, ?, ?)").bind(org.id, s.name, repo!.id).run();
    else await c.env.DB.prepare("DELETE FROM org_secret_repos WHERE org_id = ? AND name = ? AND repo_id = ?").bind(org.id, s.name, repo!.id).run();
    c.executionCtx.waitUntil(c.get("dir").audit({ actorId: a.id, actorLogin: a.login, action: method === "put" ? "org.secret.repository.add" : "org.secret.repository.remove", target: org.login, detail: { name: s.name, repository: repo!.name, via: "api" } }));
    return c.body(null, 204);
  });
}
api.delete("/orgs/:org/actions/secrets/:name", async (c) => {
  const { a, org } = await orgAdmin(c);
  const r = await c.env.DB.prepare("DELETE FROM org_secrets WHERE org_id = ? AND name = ?").bind(org.id, c.req.param("name").toUpperCase()).run();
  await c.env.DB.prepare("DELETE FROM org_secret_repos WHERE org_id = ? AND name = ?").bind(org.id, c.req.param("name").toUpperCase()).run();
  // Like GitHub: deleting a secret that doesn't exist is a 404, and nothing is audited.
  if (!r.meta?.changes) throw new HttpError(404, "secret not found");
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: a.id, actorLogin: a.login, action: "org.secret.delete", target: org.login, detail: { name: c.req.param("name").toUpperCase(), via: "api" } }));
  return c.body(null, 204);
});
api.put("/orgs/:org/actions/secrets/:name", async (c) => {
  const { a, org } = await orgAdmin(c);
  const name = c.req.param("name").toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new HttpError(422, "invalid secret name");
  const b = await body<{ value: string; visibility?: unknown; selected_repository_ids?: unknown }>(c);
  if (b.visibility !== undefined && !ORG_SECRET_VISIBILITY.includes(b.visibility as OrgSecretRow["visibility"])) throw new HttpError(422, "visibility must be all, private or selected");
  if (b.selected_repository_ids !== undefined && b.visibility !== "selected") throw new HttpError(422, "selected_repository_ids needs visibility selected");
  const existing = await c.env.DB.prepare("SELECT visibility FROM org_secrets WHERE org_id = ? AND name = ?").bind(org.id, name).first<{ visibility: OrgSecretRow["visibility"] }>();
  // A new secret reaches every repository unless the request says otherwise; an update keeps its selection.
  const visibility = (b.visibility as OrgSecretRow["visibility"] | undefined) ?? existing?.visibility ?? "all";
  const repos = b.selected_repository_ids !== undefined ? await orgReposById(c, org, b.selected_repository_ids) : null;
  await c.env.DB.prepare("INSERT OR REPLACE INTO org_secrets (org_id, name, ciphertext, updated_at, visibility) VALUES (?, ?, ?, ?, ?)").bind(org.id, name, await encryptSecret(c.env, `org:${org.id}`, b.value), new Date().toISOString(), visibility).run();
  if (repos) await setSecretRepos(c, org, name, repos);
  else if (visibility !== "selected") await c.env.DB.prepare("DELETE FROM org_secret_repos WHERE org_id = ? AND name = ?").bind(org.id, name).run();
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: a.id, actorLogin: a.login, action: "org.secret.set", target: org.login, detail: { name, visibility, ...(repos ? { repositories: repos.map((r) => r.name) } : {}), via: "api" } }));
  return c.body(null, 204);
});

// ---------------------------------------------------------------- webhooks

api.get("/repos/:owner/:repo/hooks", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo, "admin");
  return c.json(paginate(c, (await stub.webhooks()).map((h) => hookJson(c, h))));
});
api.post("/repos/:owner/:repo/hooks", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo, "admin");
  const b = await body<{ config: { url: string; secret?: string }; events?: string[] }>(c);
  if (typeof b.config?.url !== "string") throw new HttpError(422, "config.url is required", { errors: [{ resource: "Hook", code: "missing_field", field: "config.url" }] });
  const created = await stub.createWebhook(b.config.url, Array.isArray(b.events) ? b.events.map(String) : ["*"], b.config.secret);
  const hook = (await stub.webhooks()).find((h) => h.id === created.id)!;
  auditRepo(c, caller, repo, "repo.webhook.create", { id: created.id, url: b.config.url });
  // The generated secret is shown once, here (GitHub never returns secrets; Diffinery makes one when none is given).
  return c.json({ ...hookJson(c, hook), secret: b.config.secret ? undefined : created.secret }, 201);
});
api.delete("/repos/:owner/:repo/hooks/:id", async (c) => {
  const { stub, caller, repo } = await loadRepo(c, P(c).owner, P(c).repo, "admin");
  await stub.deleteWebhook(c.req.param("id"));
  auditRepo(c, caller, repo, "repo.webhook.delete", { id: c.req.param("id") });
  return c.body(null, 204);
});

// ---------------------------------------------------------------- Diffinery: tokens, agents, sandboxes, notifications

api.get("/diffinery/tokens", async (c) => c.json(await c.get("dir").tokens(requireAccount(c).id)));
api.post("/diffinery/tokens", async (c) => {
  // Minting a token needs a browser session: no token (however wide) can create another.
  const a = requireBrowserSession(c);
  const b = await body<{ name: string; scopes?: TokenScope[]; repositories?: string[]; expires_in_days?: number }>(c);
  const scopes = parseScopes(b.scopes);
  let repoIds: string[] | null = null;
  if (b.repositories?.length) {
    repoIds = [];
    for (const full of b.repositories) {
      const [o, n] = full.split("/");
      const r = o && n ? ((await c.get("dir").repo(o, n)) ?? (await c.get("dir").movedRepo(o, n))) : null;
      // Repositories the account can't see are "unknown", so this doesn't reveal private ones.
      if (!r || !(await callerFor(c, r))) throw new HttpError(422, `unknown repository ${full}`);
      repoIds.push(r.id);
    }
  }
  const t = await c.get("dir").createToken(a, { name: b.name, scopes, repoIds, expiresInDays: b.expires_in_days });
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: a.id, actorLogin: a.login, action: "token.create", detail: { name: b.name, scopes } }));
  return c.json(t, 201);
});
api.delete("/diffinery/tokens/:id", async (c) => {
  requireAccountScope(c, "admin");
  const a = requireAccount(c);
  await c.get("dir").revokeToken(a.id, c.req.param("id"));
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: a.id, actorLogin: a.login, action: "token.revoke", target: c.req.param("id"), detail: { via: "api" } }));
  return c.body(null, 204);
});
api.get("/diffinery/agents", async (c) => {
  const a = requireAccount(c);
  const orgs = (await c.get("dir").orgsFor(a.id)).filter((o) => o.role !== "member").map((o) => o.id);
  return c.json((await c.get("dir").agentsOwnedBy([a.id, ...orgs])).map((x) => ({ ...userJson(c, x), owner_id: x.owner_id, policy: x.agent_policy ? JSON.parse(x.agent_policy) : {}, auto_merge: autoMergeJson(x) })));
});
api.post("/diffinery/agents", async (c) => {
  // Creating an agent mints its first token, so it needs a browser session too.
  const a = requireBrowserSession(c);
  if (a.kind !== "user") throw new HttpError(403, "only people can create agents");
  const b = await body<{ login: string; name?: string; org?: string; policy?: Record<string, unknown>; token?: { scopes?: TokenScope[]; expires_in_days?: number }; auto_merge?: unknown }>(c);
  const autoMerge = b.auto_merge === undefined ? null : autoMergeInput(b.auto_merge);
  const dir = c.get("dir");
  const org = b.org ? await dir.accountByLogin(b.org) : null;
  const agent = await dir.createAgent(a, { login: b.login, name: b.name, orgId: org?.id, policy: b.policy });
  if (autoMerge) await dir.setAutoMerge(agent.id, autoMerge);
  const token = await dir.createToken(agent, { name: "default", scopes: parseScopes(b.token?.scopes), expiresInDays: b.token?.expires_in_days ?? 90 });
  c.executionCtx.waitUntil(dir.audit({ actorId: a.id, actorLogin: a.login, action: "agent.create", target: agent.login }));
  return c.json({ agent: userJson(c, agent), token }, 201);
});
// The setting "turn on auto-merge for my pull requests" (repo/auto-merge.ts applyOwn): yours, and your agents'.
// It automates the click on each pull request it opens, so it never lets anything land that its own click wouldn't.
const autoMergeJson = (a: Account) => {
  const v = parseAutoMergeDefault(a.auto_merge);
  return { enabled: !!v, merge_method: v };
};
/** `{ enabled, merge_method? }`, or `true`/`false`, as the setting to store (null when off). */
function autoMergeInput(v: unknown): AutoMergeDefault | null {
  if (typeof v === "boolean") return v ? "default" : null;
  const b = (v && typeof v === "object" ? v : null) as { enabled?: unknown; merge_method?: unknown } | null;
  if (!b || typeof b.enabled !== "boolean") throw new HttpError(422, "auto_merge must be { enabled: true or false, merge_method?: default, merge, squash or rebase }");
  if (b.merge_method !== undefined && b.merge_method !== null && !parseAutoMergeDefault(b.merge_method)) throw new HttpError(422, "merge_method must be default, merge, squash or rebase");
  return b.enabled ? (parseAutoMergeDefault(b.merge_method) ?? "default") : null;
}
api.get("/diffinery/auto-merge", async (c) => {
  requireAccountScope(c, "read");
  return c.json(autoMergeJson(requireAccount(c)));
});
api.put("/diffinery/auto-merge", async (c) => {
  requireAccountScope(c, "write");
  const me = requireAccount(c);
  if (me.kind !== "user") throw new HttpError(403, "an agent's owner sets this for it: PUT /api/v3/diffinery/agents/{login}/auto-merge, or Settings → Agents");
  const v = autoMergeInput(await body<unknown>(c));
  await c.get("dir").setAutoMerge(me.id, v);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "account.auto_merge", target: me.login, detail: { merge_method: v } }));
  return c.json({ enabled: !!v, merge_method: v });
});
api.put("/diffinery/agents/:login/auto-merge", async (c) => {
  requireAccountScope(c, "write");
  const a = requireAccount(c);
  if (a.kind !== "user") throw new HttpError(403, "only an agent's owner can change this");
  const dir = c.get("dir");
  const agent = await dir.accountByLogin(c.req.param("login"));
  if (!agent || agent.kind !== "agent") throw new HttpError(404, "agent not found");
  const orgRole = agent.owner_id && agent.owner_id !== a.id ? await dir.orgRole(agent.owner_id, a.id) : null;
  if (agent.owner_id !== a.id && orgRole !== "owner" && orgRole !== "admin") throw new HttpError(403, "not your agent");
  const v = autoMergeInput(await body<unknown>(c));
  await dir.setAutoMerge(agent.id, v);
  c.executionCtx.waitUntil(dir.audit({ actorId: a.id, actorLogin: a.login, action: "agent.auto_merge", target: agent.login, detail: { merge_method: v } }));
  return c.json({ enabled: !!v, merge_method: v });
});
api.post("/diffinery/agents/:login/tokens", async (c) => {
  const a = requireBrowserSession(c);
  const dir = c.get("dir");
  const agent = await dir.accountByLogin(c.req.param("login"));
  if (!agent || agent.kind !== "agent") throw new HttpError(404, "agent not found");
  const orgRole = agent.owner_id && agent.owner_id !== a.id ? await dir.orgRole(agent.owner_id, a.id) : null;
  if (agent.owner_id !== a.id && orgRole !== "owner" && orgRole !== "admin") throw new HttpError(403, "not your agent");
  const b = await body<{ name?: string; scopes?: TokenScope[]; expires_in_days?: number }>(c).catch(() => ({}) as Record<string, undefined>);
  const scopes = parseScopes(b.scopes);
  const t = await dir.createToken(agent, { name: b.name ?? "token", scopes, expiresInDays: b.expires_in_days });
  c.executionCtx.waitUntil(dir.audit({ actorId: a.id, actorLogin: a.login, action: "agent.token.create", target: agent.login, detail: { scopes } }));
  return c.json(t, 201);
});
api.delete("/diffinery/agents/:login", async (c) => {
  requireAccountScope(c, "admin");
  const a = requireAccount(c);
  const dir = c.get("dir");
  const agent = await dir.accountByLogin(c.req.param("login"));
  if (!agent || agent.kind !== "agent") throw new HttpError(404, "agent not found");
  const orgRole = agent.owner_id && agent.owner_id !== a.id ? await dir.orgRole(agent.owner_id, a.id) : null;
  if (agent.owner_id !== a.id && orgRole !== "owner" && orgRole !== "admin" && !a.site_admin) throw new HttpError(403, "not your agent");
  await dir.setStatus(agent.id, "disabled");
  c.executionCtx.waitUntil(dir.audit({ actorId: a.id, actorLogin: a.login, action: "agent.disable", target: agent.login }));
  return c.body(null, 204);
});

// Agent setup (lib/agent-setup.ts): the hosted setup script reports its self-test here, which is the Check on
// Settings → Agent setup. Only a token with write access reports (people's browsers and job tokens don't).
api.post("/repos/:owner/:repo/diffinery/agent-setup/checks", async (c) => {
  const p = c.get("principal");
  if (p.type !== "account" || p.via !== "token") throw new HttpError(403, "the setup script reports with the token in DIFFINERY_TOKEN");
  const { repo } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const report = parseReport(await body<unknown>(c));
  await new AgentSetup(c.env, c.get("dir")).recordCheck(repo, p.account, p.tokenId ?? null, report);
  return c.json({ ok: report.ok, html_url: `${c.env.PUBLIC_URL}/${repo.owner_login}/${repo.name}/settings/agent-setup` }, 201);
});
api.get("/repos/:owner/:repo/diffinery/agent-setup", async (c) => {
  const { repo } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const check = await new AgentSetup(c.env, c.get("dir")).check(repo);
  return c.json({ check: check ? agentSetupCheckJson(check) : null, html_url: `${c.env.PUBLIC_URL}/${repo.owner_login}/${repo.name}/settings/agent-setup` });
});

api.post("/repos/:owner/:repo/diffinery/sandboxes", async (c) => {
  // A sandbox's token outlives the job that would start it, so job and sandbox tokens can't start one.
  if (c.get("principal").type === "repo-token") throw new HttpError(403, "job and sandbox tokens can't start sandboxes");
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const b = await body<{ ref?: string }>(c).catch(() => ({}) as { ref?: string });
  return c.json(await stub.createSandbox(caller, b.ref), 201);
});
api.post("/repos/:owner/:repo/diffinery/sandboxes/:id/:action", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const id = c.req.param("id");
  const action = c.req.param("action");
  await stub.sandbox(id, caller);
  if (action === "close") {
    await stub.closeSandbox(id, caller);
    return c.body(null, 204);
  }
  const map: Record<string, string> = { exec: "/exec", read: "/files/read", write: "/files/write" };
  if (!map[action]) throw new HttpError(404, "unknown sandbox action");
  const res = await c.env.SANDBOX.get(c.env.SANDBOX.idFromName(id)).call(map[action]!, JSON.stringify(await c.req.json().catch(() => ({}))));
  return new Response(res.body, { status: res.status, headers: { "content-type": res.json ? "application/json" : "text/plain; charset=utf-8" } });
});

api.get("/notifications", async (c) => {
  requireUnlimitedToken(c, "read notifications");
  return c.json(await c.get("dir").notifications(requireAccount(c).id, c.req.query("all") !== "true"));
});
api.put("/notifications", async (c) => {
  requireAccountScope(c, "write");
  await c.get("dir").markRead(requireAccount(c).id);
  return c.body(null, 205);
});

// OIDC discovery for workflow id tokens.
export const wellKnown = new Hono<{ Bindings: Env; Variables: AppVars }>();
wellKnown.get("/.well-known/openid-configuration", (c) =>
  c.json({ issuer: c.env.PUBLIC_URL, jwks_uri: `${c.env.PUBLIC_URL}/.well-known/jwks`, response_types_supported: ["id_token"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["ES256"], claims_supported: ["sub", "aud", "iss", "repository", "repository_id", "repository_owner", "repository_owner_id", "environment", "agent_origin", "ref", "ref_type", "sha", "workflow", "event_name", "actor", "actor_id", "run_id"] }),
);
wellKnown.get("/.well-known/jwks", (c) => c.json({ keys: c.env.OIDC_PRIVATE_KEY ? [publicJwk(JSON.parse(c.env.OIDC_PRIVATE_KEY))] : [] }));

// ---------------------------------------------------------------- GitHub JSON helpers used above

function permissionsOf(role: Role) {
  return { admin: role === "admin", maintain: role === "admin" || role === "maintain", push: role !== "read" && role !== "triage", triage: role !== "read", pull: true };
}

function refJson(c: AppContext, r: { ref: string; sha: string; type: string }) {
  return ghRef(baseOf(c), P(c).owner, P(c).repo, r);
}

function contentJson(c: AppContext, ref: string, path: string, sha: string, size: number, type: string) {
  const b = baseOf(c);
  const api = repoApi(b, P(c).owner, P(c).repo);
  const html = repoHtml(b, P(c).owner, P(c).repo);
  const self = `${api}/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`;
  const git = `${api}/git/${type === "dir" ? "trees" : "blobs"}/${sha}`;
  const htmlUrl = `${html}/${type === "dir" ? "tree" : "blob"}/${encPath(ref)}/${encPath(path)}`;
  return {
    type,
    size: type === "dir" ? 0 : size,
    name: path.split("/").pop() ?? path,
    path,
    sha,
    url: self,
    git_url: git,
    html_url: htmlUrl,
    download_url: type === "file" || type === "symlink" ? `${html}/raw/${encPath(ref)}/${encPath(path)}` : null,
    _links: { self, git, html: htmlUrl },
  };
}

function gitCommitJson(c: AppContext, x: CommitInfo) {
  return ghGitCommit(baseOf(c), P(c).owner, P(c).repo, x);
}

function checkRunJson(c: AppContext, r: Parameters<typeof ghCheckRun>[3]) {
  return ghCheckRun(baseOf(c), P(c).owner, P(c).repo, r);
}

function jobJson(c: AppContext, owner: string, repo: string, run: RunInfo, j: JobInfo): Record<string, unknown> {
  return ghJob(baseOf(c), owner, repo, run, j);
}

function hookJson(c: AppContext, h: { id: string; url: string; events: string[]; active: boolean; createdAt: string; lastStatus: number | null; lastDeliveryAt: string | null; secret?: string }) {
  const api = repoApi(baseOf(c), P(c).owner, P(c).repo);
  return {
    type: "Repository",
    id: h.id,
    name: "web",
    active: h.active,
    events: h.events,
    config: { url: h.url, content_type: "json", insecure_ssl: "0", ...(h.secret ? { secret: "********" } : {}) },
    updated_at: isoSeconds(h.lastDeliveryAt ?? h.createdAt),
    created_at: isoSeconds(h.createdAt),
    url: `${api}/hooks/${h.id}`,
    ping_url: `${api}/hooks/${h.id}/pings`,
    deliveries_url: `${api}/hooks/${h.id}/deliveries`,
    last_response: { code: h.lastStatus, status: h.lastStatus === null ? "unused" : h.lastStatus >= 200 && h.lastStatus < 300 ? "active" : "failed", message: null },
  };
}

export { fromUtf8 };

/** The Check as the REST API shows it. */
export function agentSetupCheckJson(k: SetupCheck) {
  return {
    ok: k.ok,
    checked_at: k.at,
    first_ok_at: k.firstOkAt,
    account: k.account?.login ?? null,
    token: k.token ? { name: k.token.name, prefix: k.token.prefix } : null,
    cli_version: k.cliVersion,
    checks: k.checks,
  };
}
