import { HANDLED_DAYS, SPAM_DAYS, UNCONFIRMED_DAYS as CONTACT_UNCONFIRMED_DAYS } from "./contact.js";
import { UNCONFIRMED_DAYS } from "./early-access.js";

/**
 * Rows D1 doesn't need to keep, deleted a bounded batch per table each hour so the tables stop
 * growing with every request, notification and job (scalability evaluation, 2026-10-14):
 *
 * - sessions a day past their expiry (a session is refused once expired; the day keeps a just-expired
 *   one visible on the sessions page meanwhile);
 * - notifications older than NOTIFICATION_RETENTION_DAYS, as GitHub drops them after five months;
 * - hosted compute records (lib/quotas.ts) ended more than COMPUTE_RETENTION_DAYS ago, past any month
 *   the usage pages show;
 * - GitHub jobs' runner rows (github-runners/) ended more than GITHUB_RUNNER_RETENTION_DAYS ago: the
 *   settings page shows the latest few, and their minutes stay in compute_usage;
 * - early access requests (lib/early-access.ts) never confirmed within UNCONFIRMED_DAYS of their last
 *   submission, and the form's daily-limit rows once they are a day old;
 * - contact messages (lib/contact.ts) never confirmed within CONTACT_UNCONFIRMED_DAYS, marked spam more
 *   than SPAM_DAYS ago or handled more than HANDLED_DAYS ago, and the form's daily-limit rows once they
 *   are a day old.
 */
export const NOTIFICATION_RETENTION_DAYS = 180;
export const COMPUTE_RETENTION_DAYS = 400;
export const GITHUB_RUNNER_RETENTION_DAYS = 30;
/** Rows deleted per table per run: an hourly run keeps up with 120,000 new rows a day per table. */
export const RETENTION_BATCH = 5000;

export async function pruneExpired(db: D1Database, at = new Date(), batch = RETENTION_BATCH): Promise<Record<"sessions" | "notifications" | "compute_usage" | "early_access" | "early_access_attempts" | "contact_messages" | "contact_attempts" | "github_runner_jobs", number>> {
  const ago = (days: number) => new Date(at.getTime() - days * 86400_000).toISOString();
  const [sessions, notifications, compute, early, attempts, contact, contactAttempts, githubRunners] = await db.batch([
    db.prepare("DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at < ? LIMIT ?)").bind(ago(1), batch),
    db.prepare("DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE created_at < ? LIMIT ?)").bind(ago(NOTIFICATION_RETENTION_DAYS), batch),
    db.prepare("DELETE FROM compute_usage WHERE id IN (SELECT id FROM compute_usage WHERE ended_at < ? LIMIT ?)").bind(ago(COMPUTE_RETENTION_DAYS), batch),
    db.prepare("DELETE FROM early_access WHERE id IN (SELECT id FROM early_access WHERE state = 'unconfirmed' AND updated_at < ? LIMIT ?)").bind(ago(UNCONFIRMED_DAYS), batch),
    db.prepare("DELETE FROM early_access_attempts WHERE id IN (SELECT id FROM early_access_attempts WHERE created_at < ? LIMIT ?)").bind(ago(1), batch),
    db
      .prepare("DELETE FROM contact_messages WHERE id IN (SELECT id FROM contact_messages WHERE (state = 'unconfirmed' AND created_at < ?) OR (state = 'spam' AND handled_at < ?) OR (state = 'handled' AND handled_at < ?) LIMIT ?)")
      .bind(ago(CONTACT_UNCONFIRMED_DAYS), ago(SPAM_DAYS), ago(HANDLED_DAYS), batch),
    db.prepare("DELETE FROM contact_attempts WHERE id IN (SELECT id FROM contact_attempts WHERE created_at < ? LIMIT ?)").bind(ago(1), batch),
    db.prepare("DELETE FROM github_runner_jobs WHERE id IN (SELECT id FROM github_runner_jobs WHERE ended_at < ? LIMIT ?)").bind(ago(GITHUB_RUNNER_RETENTION_DAYS), batch),
  ]);
  return {
    sessions: sessions!.meta.changes ?? 0,
    notifications: notifications!.meta.changes ?? 0,
    compute_usage: compute!.meta.changes ?? 0,
    early_access: early!.meta.changes ?? 0,
    early_access_attempts: attempts!.meta.changes ?? 0,
    contact_messages: contact!.meta.changes ?? 0,
    contact_attempts: contactAttempts!.meta.changes ?? 0,
    github_runner_jobs: githubRunners!.meta.changes ?? 0,
  };
}
