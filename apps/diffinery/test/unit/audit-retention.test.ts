import { describe, expect, it } from "vitest";
import { AUDIT_RETENTION_DAYS, pruneAuditLog } from "../../src/lib/directory.js";
import { testD1 } from "./stubs/d1.js";

// The privacy policy says the audit log is kept 2 years: entries older than that are deleted every hour.
describe("audit log retention", () => {
  it("deletes entries older than two years and keeps the rest", async () => {
    const DB = testD1();
    const at = new Date("2026-10-14T03:00:00Z");
    const daysAgo = (d: number) => new Date(at.getTime() - d * 86400_000).toISOString();
    const add = DB.sqlite.prepare("INSERT INTO audit_log (id, at, action) VALUES (?, ?, 'session.create')");
    add.run("old1", daysAgo(AUDIT_RETENTION_DAYS + 1));
    add.run("old2", daysAgo(AUDIT_RETENTION_DAYS + 400));
    add.run("kept1", daysAgo(AUDIT_RETENTION_DAYS - 1));
    add.run("kept2", daysAgo(0));
    expect(AUDIT_RETENTION_DAYS).toBe(730);
    expect(await pruneAuditLog(DB, at)).toBe(2);
    const ids = (DB.sqlite.prepare("SELECT id FROM audit_log ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(["kept1", "kept2"]);
  });

  it("deletes a bounded batch at a time", async () => {
    const DB = testD1();
    const at = new Date("2026-10-14T03:00:00Z");
    const add = DB.sqlite.prepare("INSERT INTO audit_log (id, at, action) VALUES (?, ?, 'git.push')");
    for (let i = 0; i < 5; i++) add.run(`old${i}`, "2020-01-01T00:00:00.000Z");
    expect(await pruneAuditLog(DB, at, 3)).toBe(3);
    expect(await pruneAuditLog(DB, at, 3)).toBe(2);
    expect(await pruneAuditLog(DB, at, 3)).toBe(0);
  });
});
