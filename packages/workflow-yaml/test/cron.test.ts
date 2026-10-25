import { describe, expect, it } from "vitest";
import { CronError, cronMatches, nextCronMatch, parseCron, validateCron } from "../src/index.js";

const d = (iso: string) => new Date(iso);

describe("parseCron", () => {
  it("parses wildcards, lists, ranges and steps", () => {
    const c = parseCron("*/15 0-6/2 1,15 * *");
    expect([...c.minutes]).toEqual([0, 15, 30, 45]);
    expect([...c.hours]).toEqual([0, 2, 4, 6]);
    expect([...c.daysOfMonth]).toEqual([1, 15]);
    expect(c.months.size).toBe(12);
    expect(c.daysOfWeek.size).toBe(7);
  });

  it("supports month and day names (case-insensitive) and 7 as Sunday", () => {
    const c = parseCron("0 0 * jan-mar,DEC MON-FRI");
    expect([...c.months]).toEqual([1, 2, 3, 12]);
    expect([...c.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron("0 0 * * 7").daysOfWeek]).toEqual([0]);
    expect([...parseCron("0 0 * * 5-7").daysOfWeek].sort()).toEqual([0, 5, 6]);
  });

  it("supports a start/step without a range", () => {
    expect([...parseCron("5/20 * * * *").minutes]).toEqual([5, 25, 45]);
  });

  const invalid = ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8",
    "*/0 * * * *", "5-1 * * * *", "a * * * *", "1,,2 * * * *", "* * * foo *"];
  for (const cron of invalid) {
    it(`rejects ${JSON.stringify(cron)}`, () => {
      expect(() => parseCron(cron)).toThrow(CronError);
      expect(validateCron(cron)).toBeTypeOf("string");
    });
  }
});

describe("cronMatches", () => {
  it("matches in UTC", () => {
    expect(cronMatches("30 5 * * *", d("2026-10-12T05:30:00Z"))).toBe(true);
    expect(cronMatches("30 5 * * *", d("2026-10-12T05:31:00Z"))).toBe(false);
    expect(cronMatches("30 5 * * *", d("2026-10-12T05:30:00+02:00"))).toBe(false);
  });

  it("matches weekdays", () => {
    // 2026-10-12 is a Monday.
    expect(cronMatches("0 9 * * MON", d("2026-10-12T09:00:00Z"))).toBe(true);
    expect(cronMatches("0 9 * * 2", d("2026-10-12T09:00:00Z"))).toBe(false);
    expect(cronMatches("30 5 * * 1,3", d("2026-10-14T05:30:00Z"))).toBe(true);
  });

  it("day-of-month OR day-of-week when both are restricted", () => {
    // 1st of month or Friday
    expect(cronMatches("0 0 1 * 5", d("2026-10-01T00:00:00Z"))).toBe(true); // Thursday, 1st
    expect(cronMatches("0 0 1 * 5", d("2026-10-16T00:00:00Z"))).toBe(true); // Friday
    expect(cronMatches("0 0 1 * 5", d("2026-10-15T00:00:00Z"))).toBe(false);
    // With dow wildcard, only dom applies.
    expect(cronMatches("0 0 1 * *", d("2026-10-16T00:00:00Z"))).toBe(false);
    expect(cronMatches("0 0 * * 5", d("2026-10-01T00:00:00Z"))).toBe(false);
  });

  it("matches months", () => {
    expect(cronMatches("0 0 1 JAN *", d("2027-01-01T00:00:00Z"))).toBe(true);
    expect(cronMatches("0 0 1 JAN *", d("2026-11-01T00:00:00Z"))).toBe(false);
  });

  it("ignores seconds", () => {
    expect(cronMatches("*/5 * * * *", d("2026-10-12T10:05:42Z"))).toBe(true);
  });
});

describe("nextCronMatch", () => {
  it("finds the next minute strictly after the given date", () => {
    expect(nextCronMatch("*/15 * * * *", d("2026-10-12T10:00:00Z"))?.toISOString()).toBe("2026-10-12T10:15:00.000Z");
    expect(nextCronMatch("0 9 * * MON", d("2026-10-12T09:00:00Z"))?.toISOString()).toBe("2026-10-19T09:00:00.000Z");
    expect(nextCronMatch("0 0 29 2 *", d("2026-10-12T00:00:00Z"))?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("returns null when it never matches", () => {
    expect(nextCronMatch("0 0 31 2 *", d("2026-10-12T00:00:00Z"))).toBe(null);
  });
});
