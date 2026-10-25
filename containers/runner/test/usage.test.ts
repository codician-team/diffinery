import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUSY_BUCKETS } from "@diffinery/shared";
import { UsageSampler, describeUsage, saturatedAt } from "../src/usage.js";
import { tmp } from "./helpers.js";

/** A fake /proc: CPU ticks (busy, idle) summed over all CPUs, memory in use and an OOM kill count. */
function fakeProc(dir: string) {
  mkdirSync(dir, { recursive: true });
  return (busy: number, idle: number, usedMiB: number, oom = 0, totalMiB = 4096) => {
    // user nice system idle iowait irq softirq steal: busy split over user and system; steal isn't busy.
    writeFileSync(path.join(dir, "stat"), `cpu  ${busy - 10} 0 10 ${idle} 0 0 0 7 0 0\ncpu0 1 2 3\n`);
    writeFileSync(path.join(dir, "meminfo"), `MemTotal:       ${totalMiB * 1024} kB\nMemFree:  1 kB\nMemAvailable:   ${(totalMiB - usedMiB) * 1024} kB\n`);
    writeFileSync(path.join(dir, "vmstat"), `pgfault 5\noom_kill ${oom}\n`);
  };
}

describe("usage sampler", () => {
  it("measures a short burst at its height with its default quarter-second windows", () => {
    vi.useFakeTimers({ now: 0 });
    try {
      for (const [windowMs, expected] of [[undefined, 1], [2000, 0.13]] as const) {
        const proc = path.join(tmp(), "proc");
        const set = fakeProc(proc);
        let busy = 10;
        let idle = 0;
        set(busy, idle, 500);
        const s = new UsageSampler({ procRoot: proc, diskPath: proc, visible: 4, ...(windowMs ? { windowMs, sampleMs: 500 } : {}) });
        s.start();
        // 1.75 s idle, then a quarter second with one of four CPUs busy, then idle: 10 ms ticks.
        for (let t = 0; t < 400; t++) {
          const on = t >= 175 && t < 200;
          busy += on ? 1 : 0;
          idle += on ? 3 : 4;
          set(busy, idle, 500);
          vi.advanceTimersByTime(10);
        }
        const u = s.stop()!;
        expect(u.coresMax).toBeCloseTo(expected, 1);
        expect(u.windowSeconds).toBe((windowMs ?? 250) / 1000);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("measures busy cores per window, peak memory and OOM kills", () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const proc = path.join(tmp(), "proc");
      const set = fakeProc(proc);
      set(0, 0, 500);
      const s = new UsageSampler({ procRoot: proc, diskPath: proc, sampleMs: 500, windowMs: 2000, visible: 4 });
      s.start();
      // First 2 s: 1 of 4 CPUs busy (busy is a quarter of all ticks). Memory peaks at 1500 MiB mid-window.
      set(100, 300, 1500);
      vi.advanceTimersByTime(1000);
      set(200, 600, 800);
      vi.advanceTimersByTime(1000);
      // Next 2 s: all 4 busy, and one OOM kill.
      set(1000, 600, 900, 1);
      vi.advanceTimersByTime(2000);
      const u = s.stop()!;
      expect(u.seconds).toBe(4);
      expect(u.cores).toBe(4);
      expect(u.cpuSeconds).toBeCloseTo(10, 1);
      expect(u.coresMax).toBe(4);
      expect(u.memoryPeak).toBe(1500 * 1024 * 1024);
      expect(u.memory).toBe(4096 * 1024 * 1024);
      expect(u.oomKills).toBe(1);
      expect(u.saturated).toBe(0.5);
      expect(u.busySeconds).toHaveLength(BUSY_BUCKETS.length);
      expect(u.busySeconds[BUSY_BUCKETS.indexOf(1)]).toBe(2);
      expect(u.busySeconds[BUSY_BUCKETS.indexOf(4)]).toBe(2);
      expect(describeUsage(u)).toBe("Resources: 2.5 of 4 vCPUs busy on average (4.0 at the 95th percentile), peak memory 1.5 GiB of 4.0 GiB, peak disk " + `${(u.diskPeak / 1e9).toFixed(1)} GB of ${(u.disk / 1e9).toFixed(1)} GB, 1 process(es) killed for want of memory`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts busy cores against a fractional share of CPU", () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const proc = path.join(tmp(), "proc");
      const set = fakeProc(proc);
      set(0, 0, 100);
      // One CPU visible, a quarter of it allotted: a quarter of the ticks busy is all it has.
      const s = new UsageSampler({ procRoot: proc, diskPath: proc, windowMs: 2000, visible: 1, cores: 0.25 });
      s.start();
      set(50, 150, 100);
      vi.advanceTimersByTime(2000);
      const u = s.stop()!;
      expect(u.cores).toBe(0.25);
      expect(u.coresMax).toBe(0.25);
      expect(u.saturated).toBe(1);
      expect(saturatedAt(0.25)).toBeCloseTo(0.225);
      expect(saturatedAt(4)).toBe(3.75);
    } finally {
      vi.useRealTimers();
    }
  });

  it("measures nothing where /proc can't be read", () => {
    const s = new UsageSampler({ procRoot: path.join(tmp(), "missing") });
    s.start();
    expect(s.stop()).toBeNull();
  });
});
