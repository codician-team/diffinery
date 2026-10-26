import { describe, expect, it } from "vitest";
import { COMPUTE_RETENTION_DAYS, NOTIFICATION_RETENTION_DAYS, pruneExpired } from "../../src/lib/retention.js";
import { testD1 } from "./stubs/d1.js";

describe("retention", () => {
  it("deletes expired sessions, old notifications and old compute records, and keeps the rest", async () => {
    const DB = testD1();
    const at = new Date("2026-10-14T10:00:00Z");
    const ago = (d: number) => new Date(at.getTime() - d * 86400_000).toISOString();
    DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, created_at) VALUES ('u', 'u', 'user', 'active', ?)").run(ago(1000));
    const session = DB.sqlite.prepare("INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES (?, 'u', 'passkey', ?, ?, ?)");
    session.run("expired", ago(40), ago(10), ago(2));
    session.run("just-expired", ago(40), ago(1), ago(0.5));
    session.run("live", ago(1), ago(0), ago(-29));
    const note = DB.sqlite.prepare("INSERT INTO notifications (id, account_id, kind, title, url, created_at) VALUES (?, 'u', 'issues', 't', 'u', ?)");
    note.run("old", ago(NOTIFICATION_RETENTION_DAYS + 1));
    note.run("recent", ago(NOTIFICATION_RETENTION_DAYS - 1));
    const usage = DB.sqlite.prepare("INSERT INTO compute_usage (id, account_id, repo_id, kind, started_at, ended_at) VALUES (?, 'u', 'r', 'job', ?, ?)");
    usage.run("old-job", ago(COMPUTE_RETENTION_DAYS + 2), ago(COMPUTE_RETENTION_DAYS + 1));
    usage.run("recent-job", ago(30), ago(30));
    usage.run("running", ago(0), null);
    expect(await pruneExpired(DB, at)).toEqual({ sessions: 1, notifications: 1, compute_usage: 1, early_access: 0, early_access_attempts: 0, contact_messages: 0, contact_attempts: 0 });
    const ids = (t: string) => (DB.sqlite.prepare(`SELECT id FROM ${t} ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids("sessions")).toEqual(["just-expired", "live"]);
    expect(ids("notifications")).toEqual(["recent"]);
    expect(ids("compute_usage")).toEqual(["recent-job", "running"]);
  });

  it("deletes a bounded batch at a time", async () => {
    const DB = testD1();
    const at = new Date("2026-10-14T10:00:00Z");
    DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, created_at) VALUES ('u', 'u', 'user', 'active', '2020-01-01T00:00:00Z')").run();
    const note = DB.sqlite.prepare("INSERT INTO notifications (id, account_id, kind, title, url, created_at) VALUES (?, 'u', 'issues', 't', 'u', '2020-01-01T00:00:00Z')");
    for (let i = 0; i < 5; i++) note.run(`n${i}`);
    expect((await pruneExpired(DB, at, 3)).notifications).toBe(3);
    expect((await pruneExpired(DB, at, 3)).notifications).toBe(2);
  });
});
