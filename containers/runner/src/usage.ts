import { readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUSY_BUCKETS, type JobUsage } from "@diffinery/shared";

/** Reads of the machine at one moment: CPU time (busy and all, in ticks), memory and disk in use. */
type Reading = { busy: number; total: number; memUsed: number; memTotal: number; diskUsed: number; diskTotal: number; oom: number | null };

export interface UsageSamplerOptions {
  /** Where /proc is (tests point it at a fake one). */
  procRoot?: string;
  /** The filesystem whose use is measured (the root filesystem holds the image, the workspace and the tool cache). */
  diskPath?: string;
  /** How often memory and disk are read; CPU is read on the same tick. */
  sampleMs?: number;
  /** Busy cores are measured over windows this long. */
  windowMs?: number;
  /** The machine's share of CPU in vCPUs (a quarter or half for the smallest hosted runners); by default the CPUs it sees. */
  cores?: number;
  /** CPUs the machine shows in /proc/stat (busy time is a share of all of them). */
  visible?: number;
}

/**
 * Measures what a job uses of its machine while it runs: busy cores (from /proc/stat), memory in use
 * (MemTotal less MemAvailable from /proc/meminfo, which leaves out cache the kernel can drop), disk in
 * use, and out-of-memory kills (/proc/vmstat). A hosted container is its own virtual machine, so these
 * are the job's own numbers. Diffinery sizes the job's later runs by them (apps/diffinery/src/runner/sizes.ts).
 * Off Linux, or where /proc can't be read, it measures nothing and reports null.
 */
export class UsageSampler {
  private readonly proc: string;
  private readonly diskPath: string;
  private readonly sampleMs: number;
  private readonly windowMs: number;
  private readonly cores: number;
  private readonly visible: number;
  private timer: NodeJS.Timeout | null = null;
  private first: Reading | null = null;
  private windowStart: Reading | null = null;
  private windowStartedAt = 0;
  private startedAt = 0;
  private busyWindows: number[] = [];
  private busySeconds = BUSY_BUCKETS.map(() => 0);
  private cpuSeconds = 0;
  private memPeak = 0;
  private diskPeak = 0;
  private last: Reading | null = null;

  constructor(o: UsageSamplerOptions = {}) {
    this.proc = o.procRoot ?? "/proc";
    this.diskPath = o.diskPath ?? "/";
    // A quarter second: a short burst of CPU is measured at its height, not averaged away
    // (apps/diffinery/src/runner/sizes.ts sizes later runs by the busiest window).
    this.sampleMs = o.sampleMs ?? 250;
    this.windowMs = o.windowMs ?? 250;
    this.visible = o.visible ?? os.availableParallelism();
    this.cores = o.cores && o.cores > 0 ? o.cores : this.visible;
  }

  start(): void {
    const r = this.read();
    if (!r) return;
    this.first = this.windowStart = this.last = r;
    this.startedAt = this.windowStartedAt = Date.now();
    this.note(r);
    this.timer = setInterval(() => this.tick(), this.sampleMs);
    this.timer.unref();
  }

  /** Stops sampling and returns what the job used, or null if nothing could be measured. */
  stop(): JobUsage | null {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.first) return null;
    this.tick(true);
    const first = this.first;
    const last = this.last ?? first;
    this.first = null;
    const seconds = (Date.now() - this.startedAt) / 1000;
    const sorted = [...this.busyWindows].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0);
    const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
    return {
      seconds: round(seconds, 1),
      cpuSeconds: round(this.cpuSeconds, 1),
      coresP95: round(pct(0.95)),
      coresMax: round(sorted.length ? sorted[sorted.length - 1]! : 0),
      saturated: round(sorted.length ? sorted.filter((b) => b >= saturatedAt(this.cores)).length / sorted.length : 0, 3),
      busySeconds: this.busySeconds.map((s) => round(s, 1)),
      windowSeconds: this.windowMs / 1000,
      memoryPeak: this.memPeak,
      diskPeak: this.diskPeak,
      cores: this.cores,
      memory: last.memTotal,
      disk: last.diskTotal,
      oomKills: first.oom !== null && last.oom !== null ? Math.max(0, last.oom - first.oom) : null,
    };
  }

  private tick(final = false): void {
    const r = this.read();
    if (!r) return;
    this.last = r;
    this.note(r);
    const now = Date.now();
    if (this.windowStart && (final || now - this.windowStartedAt >= this.windowMs)) {
      const dTotal = r.total - this.windowStart.total;
      const dBusy = r.busy - this.windowStart.busy;
      const secs = (now - this.windowStartedAt) / 1000;
      if (dTotal > 0 && secs > 0) {
        const busyCores = Math.min(this.cores, Math.max(0, (dBusy / dTotal) * this.visible));
        // A last window much shorter than the rest says little about how busy the job was.
        if (!final || secs >= this.windowMs / 2000) this.busyWindows.push(busyCores);
        this.cpuSeconds += busyCores * secs;
        const i = BUSY_BUCKETS.findIndex((b) => busyCores <= b);
        this.busySeconds[i < 0 ? BUSY_BUCKETS.length - 1 : i]! += secs;
      }
      this.windowStart = r;
      this.windowStartedAt = now;
    }
  }

  private note(r: Reading): void {
    this.memPeak = Math.max(this.memPeak, r.memUsed);
    this.diskPeak = Math.max(this.diskPeak, r.diskUsed);
  }

  private read(): Reading | null {
    try {
      const stat = readFileSync(path.join(this.proc, "stat"), "utf8");
      const cpu = stat.split("\n", 1)[0]!.trim().split(/\s+/);
      if (cpu[0] !== "cpu") return null;
      // user nice system idle iowait irq softirq steal: busy is what ran here, not idle, waiting or stolen time.
      const [user, nice, system, idle, iowait, irq, softirq, steal] = cpu.slice(1, 9).map((v) => Number(v) || 0);
      const busy = user! + nice! + system! + irq! + softirq!;
      const total = busy + idle! + iowait! + steal!;
      const mem = readFileSync(path.join(this.proc, "meminfo"), "utf8");
      const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(mem)?.[1] ?? NaN) * 1024;
      const memTotal = kb("MemTotal");
      const memAvailable = kb("MemAvailable");
      if (!Number.isFinite(memTotal) || !Number.isFinite(memAvailable)) return null;
      let diskUsed = 0;
      let diskTotal = 0;
      try {
        const fs = statfsSync(this.diskPath);
        diskTotal = fs.blocks * fs.bsize;
        diskUsed = (fs.blocks - fs.bfree) * fs.bsize;
      } catch {
        /* no disk numbers */
      }
      let oom: number | null = null;
      try {
        const m = /^oom_kill\s+(\d+)/m.exec(readFileSync(path.join(this.proc, "vmstat"), "utf8"));
        if (m) oom = Number(m[1]);
      } catch {
        /* an older kernel doesn't count them */
      }
      return { busy, total, memUsed: memTotal - memAvailable, memTotal, diskUsed, diskTotal, oom };
    } catch {
      return null;
    }
  }
}

/** Busy cores at which a machine of `cores` vCPUs counts as held back by its CPU. */
export const saturatedAt = (cores: number) => Math.max(cores * 0.9, cores - 0.25);

const gib = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GiB`;
const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

/** One log line saying what the job used of its machine. */
export function describeUsage(u: JobUsage): string {
  const avg = u.seconds > 0 ? u.cpuSeconds / u.seconds : 0;
  return `Resources: ${avg.toFixed(1)} of ${u.cores} vCPUs busy on average (${u.coresP95.toFixed(1)} at the 95th percentile), peak memory ${gib(u.memoryPeak)} of ${gib(u.memory)}, peak disk ${gb(u.diskPeak)} of ${gb(u.disk)}${u.oomKills ? `, ${u.oomKills} process(es) killed for want of memory` : ""}`;
}
