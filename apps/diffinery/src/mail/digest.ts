import type { DigestPrefs, NotificationPrefs } from "./prefs.js";
import type { MailJob } from "./types.js";

/**
 * The morning digest's schedule (phase 5c). A person turns the digest on in their notification
 * settings and picks a local hour, a time zone and whether weekends count. Saving those settings
 * writes the next send time to `mail_digests`; the five-minute cron queues a `digest` job for every
 * row that is due and moves it on to the next day. The job is an ordinary email: it goes through
 * deliver() in send.ts, so the recipient's settings, the suppression list and the one-click
 * unsubscribe header all apply. Today itself is gathered when the job is sent (agentic/digest.ts).
 */

/** Digests queued per cron run; the rest wait for the next run, five minutes later. */
export const DIGESTS_PER_RUN = 200;
/** "Since the last digest" never reaches back further than this. */
export const MAX_SINCE_DAYS = 7;
/** Without a last digest (or after a long gap) the digest covers this many hours. */
export const DEFAULT_SINCE_HOURS = 24;

interface Local {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function local(tz: string, t: number): Local {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(t))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour! % 24, mi: p.minute!, s: p.second! };
}

/** How far the zone is ahead of UTC at instant t, in milliseconds. */
function offsetAt(tz: string, t: number): number {
  const l = local(tz, t);
  return Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s) - Math.floor(t / 1000) * 1000;
}

/** The instant a local wall-clock hour happens on a local date. A time skipped by a clock change comes out an hour later. */
function atLocal(tz: string, y: number, m: number, d: number, h: number): number {
  const wall = Date.UTC(y, m - 1, d, h);
  let t = wall - offsetAt(tz, wall);
  const again = offsetAt(tz, t);
  if (wall - again !== t) t = wall - again;
  return t;
}

/** When the next digest goes out after `after`: the chosen local hour on the next day that counts. */
export function nextDigestAt(p: Pick<DigestPrefs, "hour" | "timeZone" | "weekends">, after: Date): Date {
  const today = local(p.timeZone, after.getTime());
  for (let i = 0; i < 10; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const weekday = day.getUTCDay();
    if (!p.weekends && (weekday === 0 || weekday === 6)) continue;
    const t = atLocal(p.timeZone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), p.hour);
    if (t > after.getTime()) return new Date(t);
  }
  // Unreachable: some day in the next ten is a weekday with the hour still ahead.
  return new Date(after.getTime() + 86400_000);
}

/** The local date for the digest's title, e.g. "Wednesday, October 14". */
export function localDate(tz: string, at: Date): string {
  return at.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" });
}

/** Keep the schedule in step with someone's settings: a row while the digest is on, none while it is off. */
export async function syncDigest(db: D1Database, accountId: string, prefs: NotificationPrefs, at = new Date()): Promise<void> {
  if (!prefs.digest.email) {
    await db.prepare("DELETE FROM mail_digests WHERE account_id = ?").bind(accountId).run();
    return;
  }
  await db
    .prepare("INSERT INTO mail_digests (account_id, next_at) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET next_at = excluded.next_at")
    .bind(accountId, nextDigestAt(prefs.digest, at).toISOString())
    .run();
}

/** Where a digest sent at `at` starts: the last one, if it was within MAX_SINCE_DAYS, else DEFAULT_SINCE_HOURS ago. */
export function digestSince(lastSentAt: string | null, at: Date): string {
  const floor = new Date(at.getTime() - MAX_SINCE_DAYS * 86400_000).toISOString();
  if (lastSentAt && lastSentAt >= floor && lastSentAt < at.toISOString()) return lastSentAt;
  return new Date(at.getTime() - DEFAULT_SINCE_HOURS * 3600_000).toISOString();
}

/**
 * From the cron: queue the digests that are due and move each row to its next send. A row moves
 * only if no other cron run moved it first, so overlapping runs never send one twice.
 */
export async function digestCron(db: D1Database, at: Date, prefsFor: (ids: string[]) => Promise<Map<string, NotificationPrefs>>, send: (jobs: MailJob[]) => Promise<void>): Promise<number> {
  const now = at.toISOString();
  const due = (
    await db.prepare("SELECT account_id, next_at, last_sent_at FROM mail_digests WHERE next_at <= ? ORDER BY next_at LIMIT ?").bind(now, DIGESTS_PER_RUN).all<{ account_id: string; next_at: string; last_sent_at: string | null }>()
  ).results;
  if (!due.length) return 0;
  const prefs = await prefsFor(due.map((r) => r.account_id));
  const jobs: MailJob[] = [];
  for (const r of due) {
    const p = prefs.get(r.account_id);
    if (!p?.digest.email) {
      await db.prepare("DELETE FROM mail_digests WHERE account_id = ? AND next_at = ?").bind(r.account_id, r.next_at).run();
      continue;
    }
    const moved = await db.prepare("UPDATE mail_digests SET next_at = ?, last_sent_at = ? WHERE account_id = ? AND next_at = ?").bind(nextDigestAt(p.digest, at).toISOString(), now, r.account_id, r.next_at).run();
    if (!moved.meta.changes) continue;
    jobs.push({ kind: "digest", data: { since: digestSince(r.last_sent_at, at) }, to: { accountId: r.account_id }, reason: "digest", at: now });
  }
  await send(jobs);
  return jobs.length;
}
