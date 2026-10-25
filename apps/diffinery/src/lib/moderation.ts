import type { Env } from "../env.js";
import type { Account } from "./directory.js";
import { stopIn, type Stopped } from "./killswitch.js";
import { enqueueMail } from "../mail/send.js";
import { HttpError, newId, now } from "./util.js";

/**
 * Moderation, as on GitHub: reporting content to the site administrators, blocking people,
 * suspending accounts and hiding (minimizing) comments.
 *
 * - Reports: any signed-in person reports a person, a repository, an issue, a pull request or a
 *   comment, with a reason from REPORT_REASONS and a note. Site administrators work through the
 *   queue under Site administration → Reports and resolve each report with a note.
 * - Blocks: a person, or an organization through one of its owners, blocks a person. In the
 *   blocker's repositories the blocked person (and their agents) can't open issues or pull
 *   requests, comment, review or react; they aren't collaborators there any more, the two can't
 *   invite each other, and the blocker hears nothing from them. What they can read stays as it is.
 * - Suspension: a site administrator suspends a person (accounts.suspended_*, with status
 *   `disabled`). Nothing they hold works while it lasts: sessions end, tokens, agents and runners
 *   are refused, running Actions and sandboxes in their repositories stop. Their repositories,
 *   profile, issues, pull requests and comments are hidden from everyone but site administrators.
 *   Unsuspending restores all of it; tokens weren't revoked.
 * - Hidden comments: someone with write access to a repository (site administrators have it
 *   everywhere) minimizes a comment with a reason; it is shown collapsed.
 */

// ---------------------------------------------------------------- reports

/** Why something is reported (GitHub's report form, shortened). */
export const REPORT_REASONS = {
  spam: "Spam",
  harassment: "Harassment or bullying",
  hate: "Hateful content",
  violence: "Violence or threats",
  sexual: "Sexual content",
  malware: "Malware or phishing",
  impersonation: "Impersonation",
  other: "Something else",
} as const;
export type ReportReason = keyof typeof REPORT_REASONS;

export const REPORT_KINDS = ["user", "repository", "issue", "pull_request", "comment"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Longest note a reporter writes, and resolution note an administrator writes, in characters. */
export const MAX_REPORT_TEXT = 2000;
/** Longest excerpt of the reported content kept with a report. */
export const MAX_EXCERPT = 2000;
/** Reports one person files in 24 hours, on top of the per-minute rate limit. */
export const MAX_REPORTS_PER_DAY = 20;

/** A report's reason and note as sent by the reporter: a known reason, a note within the limit. */
export function cleanReport(input: { reason?: unknown; body?: unknown }): { reason: ReportReason; body: string } {
  const reason = typeof input.reason === "string" ? input.reason.trim().toLowerCase() : "";
  if (!(reason in REPORT_REASONS)) throw new HttpError(422, `reason must be one of ${Object.keys(REPORT_REASONS).join(", ")}`, { errors: [{ resource: "Report", code: "invalid", field: "reason" }] });
  if (input.body !== undefined && input.body !== null && typeof input.body !== "string") throw new HttpError(422, "body must be a string", { errors: [{ resource: "Report", code: "invalid", field: "body" }] });
  const body = ((input.body as string | undefined) ?? "").replace(/\r\n/g, "\n").trim();
  if (body.length > MAX_REPORT_TEXT) throw new HttpError(422, `the note can be at most ${MAX_REPORT_TEXT} characters`, { errors: [{ resource: "Report", code: "invalid", field: "body" }] });
  if (reason === "other" && !body) throw new HttpError(422, "say what is wrong in the note", { errors: [{ resource: "Report", code: "missing_field", field: "body" }] });
  return { reason: reason as ReportReason, body };
}

/** An administrator's resolution note: required, trimmed and bounded. */
export function cleanResolution(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : "";
  if (!s) throw new HttpError(422, "write what you did about it (the note is kept with the report)");
  if (s.length > MAX_REPORT_TEXT) throw new HttpError(422, `the note can be at most ${MAX_REPORT_TEXT} characters`);
  return s;
}

/** What is reported, resolved by the caller (who checked the reporter can see it). */
export interface ReportTarget {
  kind: ReportKind;
  /** login, owner/name, owner/name#12, or owner/name#12 (comment id) */
  target: string;
  url: string;
  accountId: string | null;
  repoId: string | null;
  excerpt: string | null;
}

export interface Report {
  id: string;
  reporter_id: string;
  reporter_login: string | null;
  kind: ReportKind;
  target: string;
  url: string;
  account_id: string | null;
  account_login: string | null;
  repo_id: string | null;
  excerpt: string | null;
  reason: ReportReason;
  body: string;
  state: "open" | "resolved";
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
}

const REPORT_SELECT = "SELECT r.*, p.login AS reporter_login, a.login AS account_login FROM abuse_reports r LEFT JOIN accounts p ON p.id = r.reporter_id LEFT JOIN accounts a ON a.id = r.account_id";

/** File a report. One person files at most MAX_REPORTS_PER_DAY a day, and one open report per thing. */
export async function createReport(env: Env, reporter: Account, t: ReportTarget, input: { reason: ReportReason; body: string }): Promise<Report> {
  const since = new Date(Date.now() - 86400_000).toISOString();
  const filed = (await env.DB.prepare("SELECT count(*) AS n FROM abuse_reports WHERE reporter_id = ? AND created_at > ?").bind(reporter.id, since).first<{ n: number }>())?.n ?? 0;
  if (filed >= MAX_REPORTS_PER_DAY) throw new HttpError(429, `you can file at most ${MAX_REPORTS_PER_DAY} reports in 24 hours; try again later`);
  const open = await env.DB.prepare("SELECT 1 FROM abuse_reports WHERE reporter_id = ? AND kind = ? AND target = ? AND state = 'open'").bind(reporter.id, t.kind, t.target).first();
  if (open) throw new HttpError(422, "you already reported this; the site administrators haven't resolved your report yet");
  const id = newId();
  await env.DB.prepare("INSERT INTO abuse_reports (id, reporter_id, kind, target, url, account_id, repo_id, excerpt, reason, body, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)")
    .bind(id, reporter.id, t.kind, t.target, t.url, t.accountId, t.repoId, t.excerpt ? t.excerpt.slice(0, MAX_EXCERPT) : null, input.reason, input.body, now())
    .run();
  return (await report(env, id))!;
}

export async function report(env: Env, id: string): Promise<Report | null> {
  return env.DB.prepare(`${REPORT_SELECT} WHERE r.id = ?`).bind(id).first<Report>();
}

/** Reports in the queue, newest first: open ones, resolved ones, or (all) both. */
export async function reports(env: Env, state: "open" | "resolved" | "all" = "open", limit = 100, offset = 0): Promise<{ items: Report[]; total: number }> {
  const where = state === "all" ? "" : "WHERE r.state = ?";
  const args = state === "all" ? [] : [state];
  const [items, total] = await Promise.all([
    env.DB.prepare(`${REPORT_SELECT} ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).bind(...args, Math.min(limit, 100), offset).all<Report>(),
    env.DB.prepare(`SELECT count(*) AS n FROM abuse_reports r ${where}`).bind(...args).first<{ n: number }>(),
  ]);
  return { items: items.results, total: total?.n ?? 0 };
}

export async function openReportCount(env: Env): Promise<number> {
  return (await env.DB.prepare("SELECT count(*) AS n FROM abuse_reports WHERE state = 'open'").first<{ n: number }>())?.n ?? 0;
}

/** Resolve a report with a note, or (`open`) reopen it. Returns the report, or null when there is none. */
export async function setReportState(env: Env, id: string, by: Pick<Account, "login">, state: "open" | "resolved", note: string | null): Promise<Report | null> {
  const r = await report(env, id);
  if (!r) return null;
  if (state === "resolved") await env.DB.prepare("UPDATE abuse_reports SET state = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?").bind(now(), by.login, note, id).run();
  else await env.DB.prepare("UPDATE abuse_reports SET state = 'open', resolved_at = NULL, resolved_by = NULL, resolution = NULL WHERE id = ?").bind(id).run();
  return report(env, id);
}

// ---------------------------------------------------------------- blocks

/** The ids an account acts as for blocks: itself, and an agent's owner too. */
export const blockSubjects = (a: Pick<Account, "id" | "kind" | "owner_id">): string[] => (a.kind === "agent" && a.owner_id ? [a.id, a.owner_id] : [a.id]);

/** Whether `blockerId` (a person or an organization) blocked any of `ids`. */
export async function isBlocked(env: Env, blockerId: string, ids: Array<string | null | undefined>): Promise<boolean> {
  const list = ids.filter((x): x is string => !!x && x !== blockerId);
  if (!list.length) return false;
  return !!(await env.DB.prepare(`SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id IN (${list.map(() => "?").join(", ")}) LIMIT 1`).bind(blockerId, ...list).first());
}

/** Everyone who blocked any of `ids` (for notifications: a blocker hears nothing from the people they blocked). */
export async function blockersOf(env: Env, ids: Array<string | null | undefined>): Promise<Set<string>> {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return new Set();
  const r = await env.DB.prepare(`SELECT blocker_id FROM user_blocks WHERE blocked_id IN (${list.map(() => "?").join(", ")})`).bind(...list).all<{ blocker_id: string }>();
  return new Set(r.results.map((x) => x.blocker_id));
}

export interface Block {
  account: Account;
  createdAt: string;
  createdBy: string | null;
}

/** The people `blockerId` blocked, by login. */
export async function blockList(env: Env, blockerId: string): Promise<Block[]> {
  const r = await env.DB.prepare("SELECT a.*, b.created_at AS blocked_at, b.created_by AS blocked_by FROM user_blocks b JOIN accounts a ON a.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY a.login LIMIT 1000")
    .bind(blockerId)
    .all<Account & { blocked_at: string; blocked_by: string | null }>();
  return r.results.map(({ blocked_at, blocked_by, ...account }) => ({ account: account as Account, createdAt: blocked_at, createdBy: blocked_by }));
}

/**
 * Block `user` for `blocker` (a person blocking for themselves, or an organization blocking
 * through `by`, one of its owners). Only people can be blocked, never yourself, and an
 * organization can't block its own members (remove them first). Like GitHub, blocking also
 * removes the person (and their agents) as a collaborator on the blocker's repositories and
 * cancels pending invitations between the two. False when the person was already blocked.
 */
export async function block(env: Env, blocker: Account, user: Account, by: Account): Promise<boolean> {
  if (user.kind !== "user") throw new HttpError(422, `${user.login} is not a person; only people can be blocked`);
  if (user.id === blocker.id || user.id === by.id) throw new HttpError(422, "you can't block yourself");
  if (blocker.kind === "org" && (await env.DB.prepare("SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?").bind(blocker.id, user.id).first())) {
    throw new HttpError(422, `${user.login} is a member of ${blocker.login}; remove them from the organization before blocking them`);
  }
  const r = await env.DB.prepare("INSERT INTO user_blocks (blocker_id, blocked_id, created_at, created_by) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(blocker.id, user.id, now(), by.id === blocker.id ? null : by.login).run();
  if (!(r.meta?.changes ?? 0)) return false;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM repo_access WHERE repo_id IN (SELECT id FROM repos WHERE owner_id = ?) AND account_id IN (SELECT ? UNION SELECT id FROM accounts WHERE kind = 'agent' AND owner_id = ?)").bind(blocker.id, user.id, user.id),
    env.DB.prepare(
      `DELETE FROM invites WHERE accepted_at IS NULL AND (
         (account_id = ? AND (org_id = ? OR repo_id IN (SELECT id FROM repos WHERE owner_id = ?) OR invited_by = ?))
         OR (invited_by = ? AND (account_id = ? OR org_id = ?)))`,
    ).bind(user.id, blocker.id, blocker.id, blocker.id, user.id, blocker.id, blocker.id),
  ]);
  return true;
}

/** Unblock; false when the person wasn't blocked. */
export async function unblock(env: Env, blockerId: string, userId: string): Promise<boolean> {
  const r = await env.DB.prepare("DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?").bind(blockerId, userId).run();
  return (r.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------- suspension

type Actor = Pick<Account, "id" | "login">;
type Audit = (entry: { actorId?: string; actorLogin?: string; action: string; target?: string; detail?: unknown }) => Promise<void>;

/** Longest suspension reason, in characters. */
export const MAX_SUSPEND_REASON = 500;

export function suspendReason(v: unknown): string {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!s) throw new HttpError(422, "give a reason for the suspension (it is shown to the person and kept in the audit log)", { errors: [{ resource: "User", code: "missing_field", field: "reason" }] });
  if (s.length > MAX_SUSPEND_REASON) throw new HttpError(422, `the reason can be at most ${MAX_SUSPEND_REASON} characters`);
  return s;
}

/**
 * Suspend a person, as GitHub Enterprise does: their status becomes `disabled` with the reason,
 * their browser sessions end, and the work running in their repositories (Actions runs and jobs,
 * agent sandboxes) stops. Tokens aren't revoked: they are refused while the suspension lasts and
 * work again once it is lifted. Site administrators can't be suspended, nor can you suspend
 * yourself. Audited as `user.suspend`.
 */
export async function suspend(env: Env, audit: Audit, actor: Actor, user: Account, reason: string, via: "api" | "web"): Promise<Stopped | null> {
  if (user.kind !== "user") throw new HttpError(422, `${user.login} is not a person; only people can be suspended`);
  if (user.id === actor.id) throw new HttpError(422, "you can't suspend yourself");
  if (user.site_admin) throw new HttpError(422, `${user.login} is a site administrator; site administrators can't be suspended`);
  const before = user.suspended_at;
  await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET status = 'disabled', suspended_at = COALESCE(suspended_at, ?), suspended_by = ?, suspended_reason = ? WHERE id = ?").bind(now(), actor.login, reason, user.id),
    env.DB.prepare("DELETE FROM sessions WHERE account_id = ?").bind(user.id),
  ]);
  let stopped: Stopped | null = null;
  try {
    const ids = (await env.DB.prepare("SELECT id FROM repos WHERE owner_id = ?").bind(user.id).all<{ id: string }>()).results.map((r) => r.id);
    if (ids.length) stopped = await stopIn(env, ids, { hostedOnly: false, message: `Actions are suspended for every repository of ${user.login} by a site administrator: ${reason}` });
  } finally {
    await audit({ actorId: actor.id, actorLogin: actor.login, action: "user.suspend", target: user.login, detail: { reason, via, stopped } });
  }
  if (!before) await enqueueMail(env, [{ kind: "account_status", data: { status: "suspended", reason }, to: { accountId: user.id }, reason: "account", at: now() }]);
  return stopped;
}

/** Lift a suspension: the account is active again, with its tokens. Audited as `user.unsuspend`; false when it wasn't suspended. */
export async function unsuspend(env: Env, audit: Audit, actor: Actor, user: Account, via: "api" | "web"): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE accounts SET status = 'active', suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL WHERE id = ? AND suspended_at IS NOT NULL").bind(user.id).run();
  if (!(r.meta?.changes ?? 0)) return false;
  await audit({ actorId: actor.id, actorLogin: actor.login, action: "user.unsuspend", target: user.login, detail: { via } });
  await enqueueMail(env, [{ kind: "account_status", data: { status: "unsuspended" }, to: { accountId: user.id }, reason: "account", at: now() }]);
  return true;
}

/** Suspended people, newest first, for the site administration page. */
export async function suspendedAccounts(env: Env): Promise<Array<Pick<Account, "id" | "login" | "avatar_version" | "suspended_at" | "suspended_by" | "suspended_reason">>> {
  return (await env.DB.prepare("SELECT id, login, avatar_version, suspended_at, suspended_by, suspended_reason FROM accounts WHERE suspended_at IS NOT NULL ORDER BY suspended_at DESC LIMIT 500").all<Pick<Account, "id" | "login" | "avatar_version" | "suspended_at" | "suspended_by" | "suspended_reason">>()).results;
}

/** Ids of suspended people: what they wrote is hidden from everyone but site administrators. */
export async function suspendedIds(env: Env): Promise<string[]> {
  return (await env.DB.prepare("SELECT id FROM accounts WHERE suspended_at IS NOT NULL LIMIT 5000").all<{ id: string }>()).results.map((r) => r.id);
}

/** Whether a person's content is visible to `viewer`: always unless they are suspended, and then only to site administrators. */
export const visibleTo = (author: { suspended_at?: string | null }, viewer: Pick<Account, "site_admin"> | null): boolean => !author.suspended_at || !!viewer?.site_admin;

// ---------------------------------------------------------------- hidden (minimized) comments

/** GitHub's classifiers for minimizing a comment, and how each is shown. */
export const MINIMIZE_REASONS = {
  spam: "This comment was marked as spam.",
  abuse: "This comment was marked as abuse.",
  off_topic: "This comment was marked as off-topic.",
  outdated: "This comment was marked as outdated.",
  duplicate: "This comment was marked as duplicate.",
  resolved: "This comment was marked as resolved.",
} as const;
export type MinimizeReason = keyof typeof MINIMIZE_REASONS;

/** A reason as sent by a client: ours (`off_topic`) or GitHub's GraphQL classifier (`OFF_TOPIC`). */
export function minimizeReason(v: unknown): MinimizeReason {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (!(s in MINIMIZE_REASONS)) throw new HttpError(422, `reason must be one of ${Object.keys(MINIMIZE_REASONS).join(", ")}`, { errors: [{ resource: "IssueComment", code: "invalid", field: "reason" }] });
  return s as MinimizeReason;
}

/** The line a minimized comment shows instead of its body. */
export const minimizedNote = (reason: string | null | undefined): string => MINIMIZE_REASONS[reason as MinimizeReason] ?? "This comment has been minimized.";
