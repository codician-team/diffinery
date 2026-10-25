import { describe, expect, it } from "vitest";
import { CATCH_UP_MINUTES, dueSchedules, eachLimited, nextTick, tickMinutes, tickWindow } from "../../src/lib/schedules.js";

const t = (iso: string) => Date.parse(iso);
const iso = (ds: Date[]) => ds.map((d) => d.toISOString().slice(11, 16));

describe("workflow schedules", () => {
  it("ticks on multiples of the tick length", () => {
    expect(new Date(nextTick(t("2026-10-13T16:05:45Z"), 5)).toISOString()).toBe("2026-10-13T16:10:00.000Z");
    expect(new Date(nextTick(t("2026-10-13T16:10:00Z"), 5)).toISOString()).toBe("2026-10-13T16:15:00.000Z");
    expect(new Date(nextTick(t("2026-10-13T16:10:30Z"), 1)).toISOString()).toBe("2026-10-13T16:11:00.000Z");
    expect(tickMinutes(undefined)).toBe(5);
    expect(tickMinutes("1")).toBe(1);
    expect(tickMinutes("0")).toBe(5);
    expect(tickMinutes("soon")).toBe(5);
  });

  it("a first tick covers its own window", () => {
    expect(iso(tickWindow(t("2026-10-13T16:10:00.250Z"), undefined, 5))).toEqual(["16:06", "16:07", "16:08", "16:09", "16:10"]);
  });

  it("a tick covers the minutes since the last finished tick", () => {
    expect(iso(tickWindow(t("2026-10-13T16:15:00Z"), t("2026-10-13T16:10:00Z"), 5))).toEqual(["16:11", "16:12", "16:13", "16:14", "16:15"]);
    // An early alarm leaves nothing behind: the next tick starts where this one stopped.
    expect(iso(tickWindow(t("2026-10-13T16:14:59.900Z"), t("2026-10-13T16:10:00Z"), 5))).toEqual(["16:11", "16:12", "16:13", "16:14"]);
    expect(tickWindow(t("2026-10-13T16:10:00Z"), t("2026-10-13T16:10:00Z"), 5)).toEqual([]);
  });

  it("catches up ticks that never came (the 2026-10-13 live test: none from 16:10 to 16:20)", () => {
    const rows = [{ repo: "live", cron: "*/5 * * * *" }, { repo: "nightly", cron: "0 3 * * *" }];
    // The 16:25 tick is the first since 16:05: it covers every minute since then, and the run starts once.
    const minutes = tickWindow(t("2026-10-13T16:25:00Z"), t("2026-10-13T16:05:00Z"), 5);
    expect(minutes).toHaveLength(20);
    expect(dueSchedules(rows, minutes)).toEqual([rows[0]]);
  });

  it("looks back at most an hour", () => {
    const minutes = tickWindow(t("2026-10-13T18:00:00Z"), t("2026-10-13T10:00:00Z"), 5);
    expect(minutes).toHaveLength(CATCH_UP_MINUTES);
    expect(iso(minutes).slice(0, 1)).toEqual(["17:01"]);
  });

  it("skips crons that don't parse instead of failing the tick", () => {
    const rows = [{ cron: "not a cron" }, { cron: "* * * * *" }];
    expect(dueSchedules(rows, [new Date(t("2026-10-13T16:10:00Z"))])).toEqual([rows[1]]);
  });

  it("starts runs a few at a time", async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      done.push(n);
      running--;
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
