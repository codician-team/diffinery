import { newId, now } from "../lib/util.js";
import { syncDigest } from "./digest.js";
import type { Category } from "./types.js";

/** Per-person notification settings. Missing keys fall back to DEFAULT_PREFS. */
export interface NotificationPrefs {
  /** Issues and pull requests you take part in: authored, commented, reviewed, assigned, review requested, @mentioned or subscribed. */
  participating: { web: boolean; email: boolean };
  /** Everything else in repositories you watch. */
  watching: { web: boolean; email: boolean };
  /** Workflow runs you started (or the repositories you watch, for scheduled runs). */
  actions: { web: boolean; email: boolean; failuresOnly: boolean };
  /** Repositories created, deleted, or access granted to you. */
  repos: { email: boolean };
  /** Organization membership, accepted invitations and (for admins) access requests. */
  orgs: { email: boolean };
  /** Also email me about my own comments and changes (GitHub's "Include your own updates"). */
  ownActivity: boolean;
  /** Watch repositories I create. */
  autoWatch: boolean;
  /** The morning digest (phase 5c): Today by email, at a local hour. Off unless the person turns it on. */
  digest: DigestPrefs;
}

export interface DigestPrefs {
  email: boolean;
  /** Local hour, 0 to 23. */
  hour: number;
  /** IANA time zone, e.g. Europe/Istanbul. */
  timeZone: string;
  /** Also on Saturdays and Sundays. */
  weekends: boolean;
}

/** Whether a string is a time zone this runtime knows. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const isDigestHour = (h: unknown): h is number => typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= 23;

export const DEFAULT_PREFS: NotificationPrefs = {
  participating: { web: true, email: true },
  watching: { web: true, email: true },
  actions: { web: true, email: true, failuresOnly: true },
  repos: { email: true },
  orgs: { email: true },
  ownActivity: false,
  autoWatch: true,
  digest: { email: false, hour: 8, timeZone: "UTC", weekends: false },
};

export function mergePrefs(stored: unknown): NotificationPrefs {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const pick = <T extends object>(d: T, v: unknown): T => {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const out = { ...d } as Record<string, unknown>;
    for (const k of Object.keys(d)) if (typeof o[k] === "boolean") out[k] = o[k];
    return out as T;
  };
  return {
    participating: pick(DEFAULT_PREFS.participating, s.participating),
    watching: pick(DEFAULT_PREFS.watching, s.watching),
    actions: pick(DEFAULT_PREFS.actions, s.actions),
    repos: pick(DEFAULT_PREFS.repos, s.repos),
    orgs: pick(DEFAULT_PREFS.orgs, s.orgs),
    ownActivity: typeof s.ownActivity === "boolean" ? s.ownActivity : DEFAULT_PREFS.ownActivity,
    autoWatch: typeof s.autoWatch === "boolean" ? s.autoWatch : DEFAULT_PREFS.autoWatch,
    digest: mergeDigest(s.digest),
  };
}

function mergeDigest(v: unknown): DigestPrefs {
  const d = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const def = DEFAULT_PREFS.digest;
  return {
    email: typeof d.email === "boolean" ? d.email : def.email,
    hour: isDigestHour(d.hour) ? d.hour : def.hour,
    timeZone: isTimeZone(d.timeZone) ? d.timeZone : def.timeZone,
    weekends: typeof d.weekends === "boolean" ? d.weekends : def.weekends,
  };
}

/** Whether a settings group wants email (security and account emails always send). */
export function wantsEmail(p: NotificationPrefs, c: Category): boolean {
  switch (c) {
    case "security":
    case "account":
      return true;
    case "participating":
      return p.participating.email;
    case "watching":
      return p.watching.email;
    case "actions":
      return p.actions.email;
    case "repos":
      return p.repos.email;
    case "orgs":
      return p.orgs.email;
    case "digest":
      return p.digest.email;
  }
}

export type WatchLevel = "all" | "participating" | "ignore";
export const WATCH_LEVELS: WatchLevel[] = ["participating", "all", "ignore"];

export interface EmailLogRow {
  id: string;
  account_id: string | null;
  to_addr: string;
  kind: string;
  subject: string;
  status: "sent" | "failed" | "skipped";
  detail: string | null;
  message_id: string | null;
  dev_copy: string | null;
  created_at: string;
}

/** D1 access for notification settings, watching, thread subscriptions, devices and the email log. */
export class MailStore {
  constructor(private db: D1Database) {}

  async prefs(accountId: string): Promise<NotificationPrefs> {
    const r = await this.db.prepare("SELECT prefs FROM notification_prefs WHERE account_id = ?").bind(accountId).first<{ prefs: string }>();
    let stored: unknown = null;
    try {
      stored = r ? JSON.parse(r.prefs) : null;
    } catch {
      stored = null;
    }
    return mergePrefs(stored);
  }

  async prefsFor(accountIds: string[]): Promise<Map<string, NotificationPrefs>> {
    const out = new Map<string, NotificationPrefs>(accountIds.map((id) => [id, mergePrefs(null)]));
    for (let i = 0; i < accountIds.length; i += 90) {
      const ids = accountIds.slice(i, i + 90);
      const r = await this.db.prepare(`SELECT account_id, prefs FROM notification_prefs WHERE account_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ account_id: string; prefs: string }>();
      for (const row of r.results) {
        try {
          out.set(row.account_id, mergePrefs(JSON.parse(row.prefs)));
        } catch {
          /* keep defaults */
        }
      }
    }
    return out;
  }

  /** Save someone's settings, and move their morning digest's schedule to match (digest.ts). */
  async setPrefs(accountId: string, prefs: NotificationPrefs): Promise<void> {
    const p = mergePrefs(prefs);
    await this.db
      .prepare("INSERT INTO notification_prefs (account_id, prefs, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at")
      .bind(accountId, JSON.stringify(p), now())
      .run();
    await syncDigest(this.db, accountId, p);
  }

  /** When the morning digest goes out next, if it is on (digest.ts). */
  async digestNext(accountId: string): Promise<string | null> {
    return (await this.db.prepare("SELECT next_at FROM mail_digests WHERE account_id = ?").bind(accountId).first<{ next_at: string }>())?.next_at ?? null;
  }

  /** When the last scheduled digest was queued. */
  async digestLastSent(accountId: string): Promise<string | null> {
    return (await this.db.prepare("SELECT last_sent_at FROM mail_digests WHERE account_id = ?").bind(accountId).first<{ last_sent_at: string | null }>())?.last_sent_at ?? null;
  }

  async watchLevel(accountId: string, repoId: string): Promise<WatchLevel> {
    const r = await this.db.prepare("SELECT level FROM repo_watches WHERE account_id = ? AND repo_id = ?").bind(accountId, repoId).first<{ level: WatchLevel }>();
    return r?.level ?? "participating";
  }

  async setWatch(accountId: string, repoId: string, level: WatchLevel): Promise<void> {
    if (level === "participating") {
      await this.db.prepare("DELETE FROM repo_watches WHERE account_id = ? AND repo_id = ?").bind(accountId, repoId).run();
      return;
    }
    await this.db
      .prepare("INSERT INTO repo_watches (account_id, repo_id, level, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, repo_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at")
      .bind(accountId, repoId, level, now())
      .run();
  }

  /** Accounts watching a repository, by level ('all' or 'ignore'). */
  async watchers(repoId: string): Promise<{ all: string[]; ignore: Set<string> }> {
    const r = await this.db.prepare("SELECT account_id, level FROM repo_watches WHERE repo_id = ? LIMIT 2000").bind(repoId).all<{ account_id: string; level: WatchLevel }>();
    return { all: r.results.filter((x) => x.level === "all").map((x) => x.account_id), ignore: new Set(r.results.filter((x) => x.level === "ignore").map((x) => x.account_id)) };
  }

  async watchedRepos(accountId: string): Promise<Array<{ repo_id: string; level: WatchLevel }>> {
    return (await this.db.prepare("SELECT repo_id, level FROM repo_watches WHERE account_id = ? ORDER BY updated_at DESC LIMIT 500").bind(accountId).all<{ repo_id: string; level: WatchLevel }>()).results;
  }

  /** Explicit thread subscriptions: account id → subscribed (true) or muted (false). */
  async threadSubs(repoId: string, number: number): Promise<Map<string, boolean>> {
    const r = await this.db.prepare("SELECT account_id, subscribed FROM thread_subscriptions WHERE repo_id = ? AND number = ?").bind(repoId, number).all<{ account_id: string; subscribed: number }>();
    return new Map(r.results.map((x) => [x.account_id, !!x.subscribed]));
  }

  async threadSub(accountId: string, repoId: string, number: number): Promise<boolean | null> {
    const r = await this.db.prepare("SELECT subscribed FROM thread_subscriptions WHERE account_id = ? AND repo_id = ? AND number = ?").bind(accountId, repoId, number).first<{ subscribed: number }>();
    return r ? !!r.subscribed : null;
  }

  async setThreadSub(accountId: string, repoId: string, number: number, subscribed: boolean): Promise<void> {
    await this.db
      .prepare("INSERT INTO thread_subscriptions (account_id, repo_id, number, subscribed, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, repo_id, number) DO UPDATE SET subscribed = excluded.subscribed, updated_at = excluded.updated_at")
      .bind(accountId, repoId, number, subscribed ? 1 : 0, now())
      .run();
  }

  /** Forget an explicit choice: the thread notifies as participation and watching say. */
  async clearThreadSub(accountId: string, repoId: string, number: number): Promise<void> {
    await this.db.prepare("DELETE FROM thread_subscriptions WHERE account_id = ? AND repo_id = ? AND number = ?").bind(accountId, repoId, number).run();
  }

  /** Counts by status since a time (site administration). */
  async counts(since: string): Promise<Record<"sent" | "failed" | "skipped", number>> {
    const r = await this.db.prepare("SELECT status, COUNT(*) AS n FROM email_log WHERE created_at >= ? GROUP BY status").bind(since).all<{ status: string; n: number }>();
    const out = { sent: 0, failed: 0, skipped: 0 };
    for (const x of r.results) if (x.status in out) out[x.status as keyof typeof out] = x.n;
    return out;
  }

  /** Record a sign-in device; true when it was not seen before. */
  async seeDevice(accountId: string, fingerprint: string, label: string): Promise<boolean> {
    const t = now();
    const r = await this.db
      .prepare("INSERT INTO known_devices (account_id, fingerprint, label, first_seen, last_seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, fingerprint) DO UPDATE SET last_seen = excluded.last_seen RETURNING first_seen")
      .bind(accountId, fingerprint, label, t, t)
      .first<{ first_seen: string }>();
    return r?.first_seen === t;
  }

  async log(row: Omit<EmailLogRow, "id" | "created_at">): Promise<void> {
    await this.db
      .prepare("INSERT INTO email_log (id, account_id, to_addr, kind, subject, status, detail, message_id, dev_copy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(newId(), row.account_id, row.to_addr, row.kind, row.subject.slice(0, 500), row.status, row.detail?.slice(0, 1000) ?? null, row.message_id, row.dev_copy, now())
      .run();
  }

  async recent(opts: { limit?: number; accountId?: string; kind?: string; since?: string } = {}): Promise<EmailLogRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.accountId) (where.push("account_id = ?"), args.push(opts.accountId));
    if (opts.kind) (where.push("kind = ?"), args.push(opts.kind));
    if (opts.since) (where.push("created_at >= ?"), args.push(opts.since));
    const q = `SELECT * FROM email_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
    return (await this.db.prepare(q).bind(...args, Math.min(Math.max(opts.limit ?? 50, 1), 500)).all<EmailLogRow>()).results;
  }

  /** Drop log rows older than 90 days. */
  async prune(): Promise<void> {
    await this.db.prepare("DELETE FROM email_log WHERE created_at < ?").bind(new Date(Date.now() - 90 * 86400_000).toISOString()).run();
  }
}
