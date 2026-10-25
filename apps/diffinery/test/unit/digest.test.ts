import { describe, expect, it } from "vitest";
import { DIGEST_MAX_ITEMS, digestSummary } from "../../src/agentic/digest.js";
import type { Today, TodayRepo } from "../../src/agentic/today.js";
import type { TodayPull } from "../../src/agentic/today-repo.js";
import { DEFAULT_SINCE_HOURS, digestCron, digestSince, localDate, nextDigestAt } from "../../src/mail/digest.js";
import { DEFAULT_PREFS, MailStore, mergePrefs, wantsEmail, type NotificationPrefs } from "../../src/mail/prefs.js";
import { compose, toText } from "../../src/mail/templates.js";
import { categoryOf, type MailJob } from "../../src/mail/types.js";
import { testD1 } from "./stubs/d1.js";

const digest = (d: Partial<NotificationPrefs["digest"]>) => ({ ...DEFAULT_PREFS.digest, email: true, ...d });
const iso = (d: Date) => d.toISOString();

describe("nextDigestAt", () => {
  it("is the chosen hour in UTC, today if it is still ahead, else tomorrow", () => {
    // 2026-10-14 is a Wednesday.
    expect(iso(nextDigestAt(digest({ hour: 8 }), new Date("2026-10-14T07:59:00Z")))).toBe("2026-10-14T08:00:00.000Z");
    expect(iso(nextDigestAt(digest({ hour: 8 }), new Date("2026-10-14T08:00:00Z")))).toBe("2026-10-15T08:00:00.000Z");
    expect(iso(nextDigestAt(digest({ hour: 0 }), new Date("2026-10-14T23:30:00Z")))).toBe("2026-10-15T00:00:00.000Z");
  });

  it("is the local hour in the person's time zone", () => {
    // Istanbul is UTC+3 all year.
    expect(iso(nextDigestAt(digest({ hour: 8, timeZone: "Europe/Istanbul" }), new Date("2026-10-14T04:00:00Z")))).toBe("2026-10-14T05:00:00.000Z");
    expect(iso(nextDigestAt(digest({ hour: 8, timeZone: "Europe/Istanbul" }), new Date("2026-10-14T06:00:00Z")))).toBe("2026-10-15T05:00:00.000Z");
    // Late in the UTC day it is already tomorrow in Tokyo (UTC+9).
    expect(iso(nextDigestAt(digest({ hour: 7, timeZone: "Asia/Tokyo" }), new Date("2026-10-14T20:00:00Z")))).toBe("2026-10-14T22:00:00.000Z");
    // And still yesterday in Los Angeles (UTC-7 in October).
    expect(iso(nextDigestAt(digest({ hour: 9, timeZone: "America/Los_Angeles" }), new Date("2026-10-15T03:00:00Z")))).toBe("2026-10-15T16:00:00.000Z");
  });

  it("skips Saturdays and Sundays unless weekends are on", () => {
    // Friday 2026-10-16, after the hour: the next is Monday.
    const fri = new Date("2026-10-16T10:00:00Z");
    expect(iso(nextDigestAt(digest({ hour: 8 }), fri))).toBe("2026-10-19T08:00:00.000Z");
    expect(iso(nextDigestAt(digest({ hour: 8, weekends: true }), fri))).toBe("2026-10-17T08:00:00.000Z");
    // A weekday in the person's zone, not in UTC: Monday 07:00 in Tokyo is Sunday 22:00 UTC.
    expect(iso(nextDigestAt(digest({ hour: 7, timeZone: "Asia/Tokyo" }), new Date("2026-10-17T00:00:00Z")))).toBe("2026-10-18T22:00:00.000Z");
  });

  it("follows clock changes", () => {
    // New York leaves daylight saving time on 2026-11-01: 08:00 is 12:00 UTC before, 13:00 UTC after.
    const ny = digest({ hour: 8, timeZone: "America/New_York", weekends: true });
    expect(iso(nextDigestAt(ny, new Date("2026-10-31T09:00:00Z")))).toBe("2026-10-31T12:00:00.000Z");
    expect(iso(nextDigestAt(ny, new Date("2026-10-31T12:00:00Z")))).toBe("2026-11-01T13:00:00.000Z");
    // Berlin skips 02:00 to 03:00 on 2026-03-29: a 02:00 digest goes out at 03:00 local that day.
    const berlin = digest({ hour: 2, timeZone: "Europe/Berlin", weekends: true });
    expect(iso(nextDigestAt(berlin, new Date("2026-03-28T12:00:00Z")))).toBe("2026-03-29T01:00:00.000Z");
  });
});

describe("digestSince", () => {
  const at = new Date("2026-10-19T08:00:00Z");
  it("starts at the last digest, so Monday's covers the weekend", () => {
    expect(digestSince("2026-10-16T08:00:00.000Z", at)).toBe("2026-10-16T08:00:00.000Z");
  });
  it("covers a day without one, or after a long gap", () => {
    const day = new Date(at.getTime() - DEFAULT_SINCE_HOURS * 3600_000).toISOString();
    expect(digestSince(null, at)).toBe(day);
    expect(digestSince("2026-09-01T08:00:00.000Z", at)).toBe(day);
    expect(digestSince("2026-10-20T08:00:00.000Z", at)).toBe(day);
  });
});

describe("digest settings", () => {
  it("are off by default, and keep only an hour and a time zone that exist", () => {
    expect(mergePrefs(null).digest).toEqual({ email: false, hour: 8, timeZone: "UTC", weekends: false });
    expect(mergePrefs({ digest: { email: true, hour: 6, timeZone: "Europe/Istanbul", weekends: true } }).digest).toEqual({ email: true, hour: 6, timeZone: "Europe/Istanbul", weekends: true });
    expect(mergePrefs({ digest: { email: true, hour: 24, timeZone: "Mars/Olympus" } }).digest).toEqual({ email: true, hour: 8, timeZone: "UTC", weekends: false });
    expect(mergePrefs({ digest: { hour: 7.5 } }).digest.hour).toBe(8);
  });

  it("are their own settings group, so the unsubscribe link turns only the digest off", () => {
    const job = { kind: "digest", reason: "digest" } as const;
    expect(categoryOf(job)).toBe("digest");
    expect(wantsEmail(DEFAULT_PREFS, "digest")).toBe(false);
    expect(wantsEmail(mergePrefs({ digest: { email: true } }), "digest")).toBe(true);
  });
});

describe("the digest's schedule", () => {
  const ID = "u-mia";
  function setup() {
    const db = testD1();
    db.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, created_at) VALUES (?, 'mia', 'user', 'active', ?)").run(ID, new Date().toISOString());
    const store = new MailStore(db);
    const sent: MailJob[] = [];
    const cron = (at: string) => digestCron(db, new Date(at), (ids) => store.prefsFor(ids), async (jobs) => void sent.push(...jobs));
    const row = () => db.sqlite.prepare("SELECT next_at, last_sent_at FROM mail_digests WHERE account_id = ?").get(ID) as { next_at: string; last_sent_at: string | null } | undefined;
    return { db, store, sent, cron, row };
  }

  it("is written when the digest is turned on and removed when it is turned off", async () => {
    const { store, row } = setup();
    await store.setPrefs(ID, mergePrefs({ digest: { email: true, hour: 9, timeZone: "Europe/Istanbul" } }));
    expect(row()?.next_at).toBe(iso(nextDigestAt(digest({ hour: 9, timeZone: "Europe/Istanbul" }), new Date())));
    expect(await store.digestNext(ID)).toBe(row()!.next_at);
    await store.setPrefs(ID, mergePrefs({ digest: { email: false, hour: 9 } }));
    expect(row()).toBeUndefined();
    expect(await store.digestNext(ID)).toBeNull();
  });

  it("queues each due digest once, then moves it to the next day", async () => {
    const { db, store, sent, cron, row } = setup();
    await store.setPrefs(ID, mergePrefs({ digest: { email: true, hour: 8 } }));
    db.sqlite.prepare("UPDATE mail_digests SET next_at = ? WHERE account_id = ?").run("2026-10-14T08:00:00.000Z", ID);
    expect(await cron("2026-10-14T07:58:00Z")).toBe(0);
    expect(await cron("2026-10-14T08:02:00Z")).toBe(1);
    expect(sent).toEqual([{ kind: "digest", data: { since: "2026-10-13T08:02:00.000Z" }, to: { accountId: ID }, reason: "digest", at: "2026-10-14T08:02:00.000Z" }]);
    expect(row()).toEqual({ next_at: "2026-10-15T08:00:00.000Z", last_sent_at: "2026-10-14T08:02:00.000Z" });
    // The next run, five minutes later, finds nothing due.
    expect(await cron("2026-10-14T08:07:00Z")).toBe(0);
    // Tomorrow's covers what happened since today's.
    expect(await cron("2026-10-15T08:01:00Z")).toBe(1);
    expect(sent[1]!.data).toEqual({ since: "2026-10-14T08:02:00.000Z" });
  });

  it("drops a row whose digest was turned off some other way", async () => {
    const { db, sent, cron, row } = setup();
    db.sqlite.prepare("INSERT INTO mail_digests (account_id, next_at) VALUES (?, ?)").run(ID, "2026-10-14T08:00:00.000Z");
    expect(await cron("2026-10-14T08:01:00Z")).toBe(0);
    expect(sent).toEqual([]);
    expect(row()).toBeUndefined();
  });
});

// ---------------------------------------------------------------- content and the email

const repo: TodayRepo = { id: "r1", fullName: "acme/web", url: "/acme/web", defaultBranch: "main", visibility: "private" };
const pull = (n: number, over: Partial<TodayPull> = {}): TodayPull => ({
  number: n,
  title: `PR ${n}`,
  author: { id: "u-bob", login: "bob", kind: "user" },
  head: "h",
  base: "main",
  draft: false,
  requestedReviewers: [],
  intent: null,
  createdAt: "2026-10-13T08:00:00Z",
  updatedAt: "2026-10-13T08:00:00Z",
  approvedBy: [],
  approvedHead: false,
  changesRequestedBy: [],
  reviewerIds: [],
  checks: "success",
  failingChecks: [],
  autoMerge: false,
  queued: false,
  ...over,
});
const today = (over: Partial<Today> = {}): Today => ({
  generatedAt: "2026-10-14T08:00:00Z",
  since: "2026-10-13T08:00:00Z",
  repositories: 3,
  incomplete: false,
  needsYou: [],
  agentsAtWork: [],
  landed: [],
  releases: [],
  failures: [],
  deployments: [],
  tasks: [],
  ...over,
});
const BASE = "https://diffinery.example";

describe("digestSummary", () => {
  it("keeps the sections that have something, in Today's order, with links", () => {
    const bot = { id: "a-bot", login: "fix-bot", kind: "agent" };
    const s = digestSummary(
      BASE,
      today({
        needsYou: [{ kind: "review_requested", repo, pull: pull(4) }],
        agentsAtWork: [
          { state: "checks_failing", repo, pull: pull(5, { author: bot }) },
          { state: "draft", repo, pull: pull(6, { author: bot, draft: true }) },
        ],
        landed: [{ repo, pull: { number: 3, title: "Merged one", author: bot, mergedBy: "mia", mergedAt: "2026-10-13T20:00:00Z" } }],
      }),
      "Wednesday, October 14",
    );
    expect(s.counts).toEqual({ needsYou: 1, agents: 1, merged: 1, failed: 0 });
    expect(s.sections.map((x) => x.id)).toEqual(["needs_you", "agents", "landed"]);
    expect(s.sections[0]!.items[0]).toEqual({ title: "PR 4", url: `${BASE}/acme/web/pull/4`, where: "acme/web#4", note: "Review requested · by bob", mark: "dot" });
    expect(s.sections[1]!.items[0]!.mark).toBe("fail");
    expect(s.sections[2]!.items[0]!.note).toBe("by fix-bot (agent), merged by mia");
  });

  it("caps each section and keeps the total", () => {
    const s = digestSummary(BASE, today({ needsYou: Array.from({ length: 12 }, (_, i) => ({ kind: "review_requested" as const, repo, pull: pull(i + 1) })) }), "x");
    expect(s.sections[0]!.total).toBe(12);
    expect(s.sections[0]!.items.length).toBe(DIGEST_MAX_ITEMS);
  });

  it("has no sections on a quiet day", () => {
    expect(digestSummary(BASE, today(), "x").sections).toEqual([]);
  });
});

describe("the digest email", () => {
  const job = (summary: ReturnType<typeof digestSummary>): MailJob => ({ kind: "digest", reason: "digest", to: { accountId: "u" }, at: "2026-10-14T08:00:00Z", data: { since: "2026-10-13T08:00:00Z", summary } });

  it("leads with what needs you, and lists each section", () => {
    const s = digestSummary(BASE, today({ needsYou: [{ kind: "review_requested", repo, pull: pull(4) }], failures: [{ repo, run: { id: "run1", runNumber: 7, workflow: "CI", title: "Fix it", ref: "refs/heads/main", event: "push", conclusion: "failure", actor: { id: "u", login: "mia", kind: "user" }, prNumber: null, at: "2026-10-13T22:00:00Z" } }] }), localDate("Europe/Istanbul", new Date("2026-10-14T05:00:00Z")));
    const e = compose(job(s), BASE);
    expect(e.subject).toBe("[Diffinery] Today: 1 needs you, 1 failed run");
    expect(e.eyebrow?.text).toBe("Wednesday, October 14");
    const text = toText(e, { publicUrl: BASE, reason: "digest" });
    expect(text).toContain("Needs you · 1");
    expect(text).toContain(`PR 4 acme/web#4 · Review requested · by bob <${BASE}/acme/web/pull/4>`);
    expect(text).toContain("[failed] Fix it acme/web · CI on main · mia");
    expect(text).toContain(`Open Today: ${BASE}/`);
    expect(text).toContain("you turned on the morning digest");
  });

  it("says so on a quiet day (sent only when asked for)", () => {
    const e = compose(job(digestSummary(BASE, today(), "x")), BASE);
    expect(e.subject).toBe("[Diffinery] Today: nothing needs you");
    expect(toText(e, { publicUrl: BASE, reason: "digest" })).toContain("Nothing needs you");
  });
});
