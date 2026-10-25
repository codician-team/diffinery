import type { Env } from "../env.js";
import type { Account, Directory } from "./directory.js";
import { normalEmail } from "../auth/signup.js";
import { enqueueMail } from "../mail/send.js";
import type { MailJob } from "../mail/types.js";
import { HttpError, newId, now, sha256 } from "./util.js";

/**
 * Private security reports: the form at /security/report, which security.txt names as its first
 * contact, so an instance takes reports without publishing an email address. Anyone can send one:
 * signed in, or anonymously after Cloudflare Turnstile (the same check as open sign-up). Only site
 * administrators can read them, in Site administration and through the API; each new report emails
 * every active site administrator its summary and a link, never the details.
 */

export type ReportState = "new" | "triaged" | "resolved";
export const REPORT_STATES: readonly ReportState[] = ["new", "triaged", "resolved"];

/** Longest summary, details, affected area and note, in characters. */
export const MAX_SUMMARY = 200;
export const MAX_DETAILS = 20_000;
export const MAX_AREA = 500;
export const MAX_NOTE = 2_000;

/** Reports in 24 hours: from one IP address, from one account, and from everyone not signed in together. */
export const REPORTS_PER_IP_PER_DAY = 5;
export const REPORTS_PER_ACCOUNT_PER_DAY = 10;
export const ANONYMOUS_REPORTS_PER_DAY = 50;

export interface SecurityReport {
  id: string;
  summary: string;
  details: string;
  area: string | null;
  reply_to: string | null;
  account_id: string | null;
  reporter_login: string | null;
  ip_hash: string | null;
  state: ReportState;
  note: string | null;
  updated_by: string | null;
  updated_at: string | null;
  created_at: string;
}

export interface ReportInput {
  summary: string;
  details: string;
  area: string | null;
  replyTo: string | null;
}

/**
 * Check what someone typed: a one-line summary and the details, both required and capped (refused
 * when too long, never cut), an optional affected URL or area, and a reply-to address, which only
 * someone who isn't signed in must give: we have a signed-in person's address already.
 */
export function validateReport(raw: { summary?: unknown; details?: unknown; area?: unknown; replyTo?: unknown }, signedIn: boolean): ReportInput {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const summary = str(raw.summary).replace(/\s+/g, " ").trim();
  // Line endings as the browser sent them, but no trailing blank lines.
  const details = str(raw.details).replace(/\r\n?/g, "\n").replace(/^\s*\n|\s+$/g, "");
  const area = str(raw.area).replace(/\s+/g, " ").trim();
  const typed = str(raw.replyTo).trim();
  if (!summary) throw new HttpError(422, "Write a one-line summary of the problem.");
  if (summary.length > MAX_SUMMARY) throw new HttpError(422, `Keep the summary to ${MAX_SUMMARY} characters; the details go below it.`);
  if (!details) throw new HttpError(422, "Describe the problem and how to reproduce it.");
  if (details.length > MAX_DETAILS) throw new HttpError(422, `Keep the details to ${MAX_DETAILS.toLocaleString("en")} characters. Offer to send logs or a longer write-up once we reply.`);
  if (area.length > MAX_AREA) throw new HttpError(422, `Keep the affected URL or area to ${MAX_AREA} characters.`);
  let replyTo: string | null = null;
  if (typed) {
    replyTo = normalEmail(typed);
    if (!replyTo) throw new HttpError(422, "Enter a valid email address to reply to, or leave it empty.");
  } else if (!signedIn) throw new HttpError(422, "Enter an email address we can reply to, or sign in.");
  return { summary, details, area: area || null, replyTo };
}

/** Security reports in D1. */
export class SecurityReports {
  constructor(private db: D1Database) {}

  async get(id: string): Promise<SecurityReport | null> {
    if (!/^[0-9a-f]{32}$/.test(id)) return null;
    return this.db.prepare("SELECT * FROM security_reports WHERE id = ?").bind(id).first<SecurityReport>();
  }

  /** Newest first, optionally only those in one state. */
  async list(o: { state?: ReportState; limit?: number } = {}): Promise<SecurityReport[]> {
    const limit = Math.min(Math.max(o.limit ?? 100, 1), 500);
    const q = o.state ? this.db.prepare("SELECT * FROM security_reports WHERE state = ? ORDER BY created_at DESC LIMIT ?").bind(o.state, limit) : this.db.prepare("SELECT * FROM security_reports ORDER BY created_at DESC LIMIT ?").bind(limit);
    return (await q.all<SecurityReport>()).results;
  }

  async counts(): Promise<Record<ReportState, number>> {
    const rows = (await this.db.prepare("SELECT state, count(*) AS n FROM security_reports GROUP BY state").all<{ state: ReportState; n: number }>()).results;
    const out: Record<ReportState, number> = { new: 0, triaged: 0, resolved: 0 };
    for (const r of rows) out[r.state] = r.n;
    return out;
  }

  /** How many reports were sent in the last 24 hours from this IP address, this account, and by everyone not signed in. */
  async sentToday(ipHash: string, accountId: string | null): Promise<{ ip: number; account: number; anonymous: number }> {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const r = await this.db
      .prepare(
        "SELECT (SELECT count(*) FROM security_reports WHERE ip_hash = ? AND created_at > ?) AS ip, (SELECT count(*) FROM security_reports WHERE account_id = ? AND created_at > ?) AS account, (SELECT count(*) FROM security_reports WHERE account_id IS NULL AND created_at > ?) AS anonymous",
      )
      .bind(ipHash, since, accountId ?? "", since, since)
      .first<{ ip: number; account: number; anonymous: number }>();
    return { ip: r?.ip ?? 0, account: r?.account ?? 0, anonymous: r?.anonymous ?? 0 };
  }

  async create(r: Omit<SecurityReport, "state" | "note" | "updated_by" | "updated_at">): Promise<SecurityReport> {
    await this.db
      .prepare("INSERT INTO security_reports (id, summary, details, area, reply_to, account_id, reporter_login, ip_hash, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)")
      .bind(r.id, r.summary, r.details, r.area, r.reply_to, r.account_id, r.reporter_login, r.ip_hash, r.created_at)
      .run();
    return { ...r, state: "new", note: null, updated_by: null, updated_at: null };
  }

  /** Change a report's state and note; the report as it was before, or null when there is none. */
  async update(id: string, state: ReportState, note: string | null, by: string): Promise<SecurityReport | null> {
    const before = await this.get(id);
    if (!before) return null;
    await this.db.prepare("UPDATE security_reports SET state = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?").bind(state, note, by, now(), id).run();
    return before;
  }
}

/** The IP address as stored: only a hash, which the daily limits compare. */
export const ipHash = (ip: string | null | undefined): Promise<string> => sha256(`diffinery-security-report:${ip || "unknown"}`);

type Audit = (e: { actorId?: string; actorLogin?: string; action: string; target?: string; detail?: unknown }) => Promise<void>;

/**
 * Store a validated report, after the daily limits, audit it (without its content) and queue the
 * email to every active site administrator. `reporter` is the signed-in person, or null.
 */
export async function submitReport(env: Env, audit: Audit, input: ReportInput, reporter: Account | null, ip: string | null): Promise<SecurityReport> {
  const reports = new SecurityReports(env.DB);
  const hash = await ipHash(ip);
  const sent = await reports.sentToday(hash, reporter?.id ?? null);
  if (reporter && sent.account >= REPORTS_PER_ACCOUNT_PER_DAY) throw new HttpError(429, `You have sent ${REPORTS_PER_ACCOUNT_PER_DAY} reports today. Add to an earlier one when we reply, or try again tomorrow.`);
  if (!reporter && sent.ip >= REPORTS_PER_IP_PER_DAY) throw new HttpError(429, "Too many reports from your network today. Sign in, or try again tomorrow.");
  if (!reporter && sent.anonymous >= ANONYMOUS_REPORTS_PER_DAY) throw new HttpError(429, "This instance has taken all the reports it can today from people who aren't signed in. Sign in, or try again tomorrow.");
  const report = await reports.create({
    id: newId(),
    summary: input.summary,
    details: input.details,
    area: input.area,
    reply_to: input.replyTo ?? reporter?.email ?? null,
    account_id: reporter?.id ?? null,
    reporter_login: reporter?.login ?? null,
    ip_hash: hash,
    created_at: now(),
  });
  await audit({ actorId: reporter?.id, actorLogin: reporter?.login, action: "security_report.create", target: report.id, detail: { signed_in: !!reporter } });
  const admins = (await env.DB.prepare("SELECT id FROM accounts WHERE kind = 'user' AND site_admin = 1 AND status = 'active'").all<{ id: string }>()).results;
  await enqueueMail(env, admins.map((a): MailJob => ({ kind: "security_report", data: { id: report.id, summary: report.summary }, to: { accountId: a.id }, reason: "admin", at: report.created_at })));
  return report;
}

/** Audit actions for a change of state. */
const ACTION: Record<ReportState, string> = { new: "security_report.reopen", triaged: "security_report.triage", resolved: "security_report.resolve" };

/** Mark a report triaged or resolved (or new again), with a note; audited. 404 when there is no such report. */
export async function changeReport(db: D1Database, audit: Audit, me: Account, id: string, state: unknown, note: unknown, via: "web" | "api"): Promise<SecurityReport> {
  if (typeof state !== "string" || !REPORT_STATES.includes(state as ReportState)) throw new HttpError(422, `state must be one of ${REPORT_STATES.join(", ")}`);
  if (note !== undefined && note !== null && typeof note !== "string") throw new HttpError(422, "note must be a string");
  const text = typeof note === "string" ? note.replace(/\r\n?/g, "\n").trim() : "";
  if (text.length > MAX_NOTE) throw new HttpError(422, `Keep the note to ${MAX_NOTE} characters.`);
  const reports = new SecurityReports(db);
  const before = await reports.update(id, state as ReportState, text || null, me.login);
  if (!before) throw new HttpError(404, "no security report with that id");
  await audit({ actorId: me.id, actorLogin: me.login, action: ACTION[state as ReportState], target: id, detail: { from: before.state, to: state, note: text || null, via } });
  return (await reports.get(id))!;
}

/** The API's view of a report. */
export const reportJson = (env: Pick<Env, "PUBLIC_URL">, r: SecurityReport) => ({
  id: r.id,
  state: r.state,
  summary: r.summary,
  details: r.details,
  area: r.area,
  reply_to: r.reply_to,
  reporter: r.reporter_login,
  note: r.note,
  updated_by: r.updated_by,
  updated_at: r.updated_at,
  created_at: r.created_at,
  html_url: `${env.PUBLIC_URL}/settings/admin/security-reports/${r.id}`,
});
