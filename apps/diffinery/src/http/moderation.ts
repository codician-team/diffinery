import { Hono } from "hono";
import type { Env } from "../env.js";
import { requireAccount, requireAccountScope, requireUnlimitedToken, type AppContext, type AppVars } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import {
  block,
  blockList,
  cleanReport,
  cleanResolution,
  createReport,
  isBlocked,
  minimizeReason,
  REPORT_KINDS,
  report,
  reports,
  setReportState,
  suspend,
  suspendReason,
  unblock,
  unsuspend,
  visibleTo,
  type Report,
  type ReportKind,
  type ReportTarget,
} from "../lib/moderation.js";
import { HttpError } from "../lib/util.js";
import { auditRepo, hiddenAuthors, loadRepo } from "./common.js";
import { baseOf, ghUser, isoSeconds } from "./gh.js";
import { jsonBody } from "./ghctx.js";

/**
 * Moderation endpoints (lib/moderation.ts): blocking people (GitHub's /user/blocks and
 * /orgs/{org}/blocks), reporting content, the site administrators' report queue, suspending
 * accounts (GitHub Enterprise's PUT and DELETE /users/{username}/suspended) and hiding comments.
 */
export const moderation = new Hono<{ Bindings: Env; Variables: AppVars }>();

const audit = (c: AppContext) => (e: Parameters<AppVars["dir"]["audit"]>[0]) => c.get("dir").audit(e);

/** A person (never an agent) acting for themselves. */
function person(c: AppContext, what: string): Account {
  const me = requireAccount(c);
  if (me.kind !== "user") throw new HttpError(403, `only people can ${what}`);
  return me;
}

/** Someone to block or unblock, by login: 404 when there is no such person or you can't see them. */
async function blockTarget(c: AppContext, me: Account): Promise<Account> {
  const user = await c.get("dir").accountByLogin(c.req.param("username") ?? "");
  if (!user || !visibleTo(user, me)) throw new HttpError(404, "Not Found");
  return user;
}

// ---------------------------------------------------------------- blocks (a person's own)

moderation.get("/user/blocks", async (c) => {
  requireAccountScope(c, "read");
  const me = person(c, "block people");
  return c.json((await blockList(c.env, me.id)).map((b) => ghUser(baseOf(c), b.account)));
});
moderation.get("/user/blocks/:username", async (c) => {
  requireAccountScope(c, "read");
  const me = person(c, "block people");
  const user = await blockTarget(c, me);
  if (!(await isBlocked(c.env, me.id, [user.id]))) throw new HttpError(404, "Not Found");
  return c.body(null, 204);
});
moderation.put("/user/blocks/:username", async (c) => {
  requireAccountScope(c, "write");
  const me = person(c, "block people");
  const user = await blockTarget(c, me);
  if (await block(c.env, me, user, me)) c.executionCtx.waitUntil(audit(c)({ actorId: me.id, actorLogin: me.login, action: "user.block", target: user.login, detail: { via: "api" } }));
  return c.body(null, 204);
});
moderation.delete("/user/blocks/:username", async (c) => {
  requireAccountScope(c, "write");
  const me = person(c, "block people");
  const user = await blockTarget(c, me);
  if (await unblock(c.env, me.id, user.id)) c.executionCtx.waitUntil(audit(c)({ actorId: me.id, actorLogin: me.login, action: "user.unblock", target: user.login, detail: { via: "api" } }));
  return c.body(null, 204);
});

// ---------------------------------------------------------------- blocks (an organization's, by its owners)

async function orgOwner(c: AppContext, write: boolean): Promise<{ me: Account; org: Account }> {
  requireAccountScope(c, write ? "admin" : "read");
  const me = person(c, "block people for an organization");
  const dir = c.get("dir");
  const org = await dir.accountByLogin(c.req.param("org") ?? "");
  if (!org || org.kind !== "org" || org.status === "disabled") throw new HttpError(404, "Not Found");
  const role = await dir.orgRole(org.id, me.id);
  if (!role && !me.site_admin) throw new HttpError(404, "Not Found");
  if (role !== "owner" && !me.site_admin) throw new HttpError(403, "only organization owners can block people for it");
  return { me, org };
}

moderation.get("/orgs/:org/blocks", async (c) => {
  const { org } = await orgOwner(c, false);
  return c.json((await blockList(c.env, org.id)).map((b) => ghUser(baseOf(c), b.account)));
});
moderation.get("/orgs/:org/blocks/:username", async (c) => {
  const { me, org } = await orgOwner(c, false);
  const user = await blockTarget(c, me);
  if (!(await isBlocked(c.env, org.id, [user.id]))) throw new HttpError(404, "Not Found");
  return c.body(null, 204);
});
moderation.put("/orgs/:org/blocks/:username", async (c) => {
  const { me, org } = await orgOwner(c, true);
  const user = await blockTarget(c, me);
  if (await block(c.env, org, user, me)) c.executionCtx.waitUntil(audit(c)({ actorId: me.id, actorLogin: me.login, action: "org.block", target: org.login, detail: { user: user.login, via: "api" } }));
  return c.body(null, 204);
});
moderation.delete("/orgs/:org/blocks/:username", async (c) => {
  const { me, org } = await orgOwner(c, true);
  const user = await blockTarget(c, me);
  if (await unblock(c.env, org.id, user.id)) c.executionCtx.waitUntil(audit(c)({ actorId: me.id, actorLogin: me.login, action: "org.unblock", target: org.login, detail: { user: user.login, via: "api" } }));
  return c.body(null, 204);
});

// ---------------------------------------------------------------- reports

/** What a report is about, as a client names it. */
export type ReportSubject = { kind: string; login?: string; repository?: string; number?: number; comment_id?: string };

/**
 * Resolve what someone reports, checking they can see it: a person or organization by login, a
 * repository as owner/name, an issue or pull request by number, a comment by id (issue or review
 * comment, either id form). Keeps an excerpt of the content as it is now.
 */
export async function reportTarget(c: AppContext, s: ReportSubject): Promise<ReportTarget> {
  const kind = REPORT_KINDS.find((k) => k === s.kind) as ReportKind | undefined;
  if (!kind) throw new HttpError(422, `kind must be one of ${REPORT_KINDS.join(", ")}`, { errors: [{ resource: "Report", code: "invalid", field: "kind" }] });
  const pub = baseOf(c);
  const me = requireAccount(c);
  if (kind === "user") {
    const a = await c.get("dir").accountByLogin((s.login ?? "").trim().replace(/^@/, ""));
    if (!a || !visibleTo(a, me) || (a.kind === "org" && a.status === "disabled")) throw new HttpError(404, "no one with that username");
    return { kind, target: a.login, url: `${pub}/${a.login}`, accountId: a.id, repoId: null, excerpt: a.name && a.name !== a.login ? a.name : null };
  }
  const [owner, name, extra] = (s.repository ?? "").trim().split("/");
  if (!owner || !name || extra !== undefined) throw new HttpError(422, "repository must be owner/name", { errors: [{ resource: "Report", code: "invalid", field: "repository" }] });
  // A report is a read of what it is about: anyone who can see the repository can report it.
  const { repo, stub } = await loadRepo(c, owner, name, "read", { readOnlyPost: true });
  const full = `${repo.owner_login}/${repo.name}`;
  const html = `${pub}/${full}`;
  if (kind === "repository") return { kind, target: full, url: html, accountId: repo.owner_id, repoId: repo.id, excerpt: repo.description || null };
  const hide = await hiddenAuthors(c);
  if (kind === "issue" || kind === "pull_request") {
    const n = Number(s.number);
    if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(422, "number is required", { errors: [{ resource: "Report", code: "missing_field", field: "number" }] });
    const { issue } = await stub.issue(n, hide);
    if ((issue.kind === "pull") !== (kind === "pull_request")) throw new HttpError(404, kind === "issue" ? "no issue with that number" : "no pull request with that number");
    return { kind, target: `${full}#${n}`, url: `${html}/${issue.kind === "pull" ? "pull" : "issues"}/${n}`, accountId: issue.author.id, repoId: repo.id, excerpt: `${issue.title}\n\n${issue.body}`.trim() };
  }
  const id = String(s.comment_id ?? "").trim();
  if (!id) throw new HttpError(422, "comment_id is required", { errors: [{ resource: "Report", code: "missing_field", field: "comment_id" }] });
  const found = await stub.comment(id, false, hide).catch(() => stub.comment(id, true, hide));
  const where = `${html}/${found.isPull ? "pull" : "issues"}/${found.number}`;
  return { kind, target: `${full}#${found.number} comment ${found.comment.id}`, url: found.comment.reviewId ? `${where}/files#c-${found.comment.id}` : `${where}#c-${found.comment.id}`, accountId: found.comment.author.id, repoId: repo.id, excerpt: found.comment.body };
}

/** File a report and audit it as `report.create`. */
export async function fileReport(c: AppContext, s: ReportSubject, input: { reason?: unknown; body?: unknown }, via: "api" | "web"): Promise<Report> {
  const me = requireAccount(c);
  const clean = cleanReport(input);
  const target = await reportTarget(c, s);
  const r = await createReport(c.env, me, target, clean);
  c.executionCtx.waitUntil(audit(c)({ actorId: me.id, actorLogin: me.login, action: "report.create", target: r.target, detail: { id: r.id, kind: r.kind, reason: r.reason, via } }));
  return r;
}

const reportJson = (c: AppContext, r: Report, full: boolean) => ({
  id: r.id,
  kind: r.kind,
  target: r.target,
  html_url: r.url,
  reason: r.reason,
  body: r.body,
  state: r.state,
  created_at: isoSeconds(r.created_at),
  ...(full
    ? {
        reporter: r.reporter_login,
        reported_account: r.account_login,
        excerpt: r.excerpt,
        resolved_at: isoSeconds(r.resolved_at),
        resolved_by: r.resolved_by,
        resolution: r.resolution,
        admin_url: `${baseOf(c)}/settings/admin/reports/${r.id}`,
      }
    : {}),
});

moderation.post("/diffinery/reports", async (c) => {
  requireAccountScope(c, "write");
  person(c, "report content");
  const b = await jsonBody<{ kind?: string; login?: string; repository?: string; number?: number; comment_id?: string | number; reason?: unknown; body?: unknown }>(c);
  const r = await fileReport(c, { kind: String(b.kind ?? ""), login: b.login, repository: b.repository, number: b.number, comment_id: b.comment_id === undefined ? undefined : String(b.comment_id) }, b, "api");
  return c.json(reportJson(c, r, false), 201);
});

function siteAdmin(c: AppContext, write: boolean): Account {
  if (write) {
    requireAccountScope(c, "admin");
    requireUnlimitedToken(c, "moderate");
  } else requireAccountScope(c, "read");
  const me = requireAccount(c);
  if (!me.site_admin) throw new HttpError(403, "site administrators only");
  return me;
}

moderation.get("/admin/reports", async (c) => {
  siteAdmin(c, false);
  const state = (["open", "resolved", "all"] as const).find((s) => s === c.req.query("state")) ?? "open";
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const per = Math.min(100, Math.max(1, Number(c.req.query("per_page")) || 30));
  const res = await reports(c.env, state, per, (page - 1) * per);
  c.header("x-total-count", String(res.total));
  return c.json(res.items.map((r) => reportJson(c, r, true)));
});
moderation.get("/admin/reports/:id", async (c) => {
  siteAdmin(c, false);
  const r = await report(c.env, c.req.param("id"));
  if (!r) throw new HttpError(404, "Not Found");
  return c.json(reportJson(c, r, true));
});
moderation.patch("/admin/reports/:id", async (c) => {
  const me = siteAdmin(c, true);
  const b = await jsonBody<{ state?: unknown; resolution?: unknown }>(c);
  if (b.state !== "resolved" && b.state !== "open") throw new HttpError(422, "state must be resolved or open", { errors: [{ resource: "Report", code: "invalid", field: "state" }] });
  const note = b.state === "resolved" ? cleanResolution(b.resolution) : null;
  const r = await setReportState(c.env, c.req.param("id"), me, b.state, note);
  if (!r) throw new HttpError(404, "Not Found");
  c.executionCtx.waitUntil(audit(c)({ actorId: me.id, actorLogin: me.login, action: b.state === "resolved" ? "report.resolve" : "report.reopen", target: r.target, detail: { id: r.id, ...(note ? { resolution: note } : {}), via: "api" } }));
  return c.json(reportJson(c, r, true));
});

// ---------------------------------------------------------------- suspension (GitHub Enterprise's shape)

async function suspendTarget(c: AppContext): Promise<{ me: Account; user: Account }> {
  const me = siteAdmin(c, true);
  const user = await c.get("dir").accountByLogin(c.req.param("username") ?? "");
  if (!user || user.kind !== "user") throw new HttpError(404, "no person with that username");
  return { me, user };
}

moderation.put("/users/:username/suspended", async (c) => {
  const { me, user } = await suspendTarget(c);
  const b = await jsonBody<{ reason?: unknown }>(c, true);
  await suspend(c.env, audit(c), me, user, suspendReason(b.reason), "api");
  return c.body(null, 204);
});
moderation.delete("/users/:username/suspended", async (c) => {
  const { me, user } = await suspendTarget(c);
  await unsuspend(c.env, audit(c), me, user, "api");
  return c.body(null, 204);
});

// ---------------------------------------------------------------- hidden comments (GitHub's minimizeComment)

const minimizeRoute = "/repos/:owner/:repo/diffinery/comments/:id/minimized";
moderation.put(minimizeRoute, async (c) => {
  const { stub, caller, repo } = await loadRepo(c, c.req.param("owner")!, c.req.param("repo")!, "write");
  const b = await jsonBody<{ reason?: unknown; classifier?: unknown }>(c);
  const reason = minimizeReason(b.reason ?? b.classifier);
  const r = await stub.minimizeComment(c.req.param("id")!, reason, caller);
  auditRepo(c, caller, repo, "comment.minimize", { comment: c.req.param("id"), number: r.number, reason });
  return c.json({ is_minimized: true, minimized_reason: reason });
});
moderation.delete(minimizeRoute, async (c) => {
  const { stub, caller, repo } = await loadRepo(c, c.req.param("owner")!, c.req.param("repo")!, "write");
  const r = await stub.minimizeComment(c.req.param("id")!, null, caller);
  auditRepo(c, caller, repo, "comment.unminimize", { comment: c.req.param("id"), number: r.number });
  return c.json({ is_minimized: false, minimized_reason: null });
});
