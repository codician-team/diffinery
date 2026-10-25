import { BUSY_BUCKETS, type JobUsage } from "@diffinery/shared";

/**
 * Hosted runner sizes. Each is its own container class (wrangler.jsonc `containers`) on a Cloudflare
 * Containers instance type. Cloudflare bills a running container's memory and disk for what the
 * instance type provisions, used or not, and its CPU for what it actually uses; so a job that waits
 * on the network, or uses one core of four, costs most of a large runner's price in memory alone.
 *
 * A job runs on `large` unless it asks for a size (`runs-on: diffinery-medium`, ...) or its own
 * earlier runs show that a smaller one would serve it as well (chooseSize). Smaller is never meant to
 * be slower or less reliable: anything that could make it so keeps the job on `large`.
 */
export type RunnerSize = "large" | "medium" | "small" | "tiny";
export type RunnerBinding = "RUNNER" | "RUNNER_MEDIUM" | "RUNNER_SMALL" | "RUNNER_TINY";

export const RUNNER_SIZES: Record<RunnerSize, { binding: RunnerBinding; instanceType: string; vcpu: number; memoryGiB: number; diskGB: number }> = {
  large: { binding: "RUNNER", instanceType: "standard-4", vcpu: 4, memoryGiB: 12, diskGB: 20 },
  medium: { binding: "RUNNER_MEDIUM", instanceType: "standard-3", vcpu: 2, memoryGiB: 8, diskGB: 16 },
  small: { binding: "RUNNER_SMALL", instanceType: "standard-1", vcpu: 0.5, memoryGiB: 4, diskGB: 8 },
  tiny: { binding: "RUNNER_TINY", instanceType: "basic", vcpu: 0.25, memoryGiB: 1, diskGB: 4 },
};
/** Smallest first: the order chooseSize tries them in. */
const ASCENDING: RunnerSize[] = ["tiny", "small", "medium", "large"];

/** The size a `runs-on` label asks for (`diffinery-small`, ...), the largest if several; null for none. */
export function sizeLabel(labels: readonly string[]): RunnerSize | null {
  let out: RunnerSize | null = null;
  for (const l of labels) {
    const m = /^diffinery-(large|medium|small|tiny)$/i.exec(l.trim());
    if (m && (!out || ASCENDING.indexOf(m[1]!.toLowerCase() as RunnerSize) > ASCENDING.indexOf(out))) out = m[1]!.toLowerCase() as RunnerSize;
  }
  return out;
}

/**
 * The container name of a hosted job: `job-<id>` (and `-r<n>` once restarted, `-p<n>` when placed
 * again after its runner never started) on a large runner, with `.<size>` after it on the others. The
 * name says which container class runs it.
 */
export function containerName(jobId: string, restarts: number, size: RunnerSize, placement = 0): string {
  return `job-${jobId}${restarts ? `-r${restarts}` : ""}${placement ? `-p${placement}` : ""}${size === "large" ? "" : `.${size}`}`;
}

export function sizeOfContainer(name: string): RunnerSize {
  const m = /\.(medium|small|tiny)$/.exec(name);
  return (m?.[1] as RunnerSize | undefined) ?? "large";
}

/**
 * One earlier run of the same job: how it ended, on which size, what it used, and the host processor it
 * ran on as the runner reported it (`Host:` in the log, e.g. "AMD EPYC 9654 96-Core Processor (family 25, model 17), ...").
 */
export type SizedRun = { conclusion: string | null; size: RunnerSize; usage: JobUsage | null; cpu?: string | null };

/**
 * How long a fixed single-thread loop took on each host processor Cloudflare's runners landed on (cpu
 * family/model; scalability probe, 2026-10-16): Zen 4 623 ms, Zen 3 837 ms at best, Zen 2 1190 ms; the slowest
 * host seen took SLOWEST_HOST_MS. A core on a slow host does about half the work of one on a fast host.
 */
const HOST_LOOP_MS: Record<string, number> = { "23/49": 1190, "25/1": 837, "25/17": 623 };
export const SLOWEST_HOST_MS = 1362;

/** A host processor's family and model ("25/17"), from the runner's description of it; null when it doesn't say. */
export function hostModel(cpu: string | null | undefined): string | null {
  const m = /\(family (\d+), model (\d+)\)/.exec(cpu ?? "");
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * How many times the cores a run kept busy it would keep busy for the same work on the slowest host. Where
 * a job lands isn't ours to pick, so a smaller runner must serve it there too; an unknown processor
 * counts as the fastest one, which gives the largest factor.
 */
export function hostFactor(cpu: string | null | undefined): number {
  const ms = HOST_LOOP_MS[hostModel(cpu) ?? ""] ?? Math.min(...Object.values(HOST_LOOP_MS));
  return Math.max(1, SLOWEST_HOST_MS / ms);
}

/** Headroom a smaller runner must leave over what the job used: memory and disk are sampled, so a peak can be missed. */
export const MEMORY_HEADROOM = { factor: 1.5, plusGiB: 0.5 };
export const DISK_HEADROOM = { factor: 1.25, plusGB: 1 };
/**
 * CPU headroom: a smaller runner must have this many times the cores the job kept busy at its busiest, so a
 * burst shorter than a sample (or a little busier than the last runs) still has room and doesn't queue.
 */
export const CPU_HEADROOM = 1.5;
/**
 * A run on a smaller runner was slowed by it, or may have been, when it took longer than the job takes on
 * large plus its own run-to-run noise there: over a tenth and 2 seconds above the median of its measured
 * large runs (on the same host processor when there are any), and above the slowest but one of the last
 * ten of them (see slowLimit). The job then goes back to large.
 */
export const SLOWER = { factor: 1.1, plusSeconds: 2 };
/**
 * Busy cores are measured over windows of at most this many seconds (the runner's own sampling). Shorter
 * windows catch a short burst at its height: averaged over 2 seconds, a third of a second on one core reads
 * as a sixth of a core, and a runner sized by that would run each such burst at half speed or less.
 * Runs measured with longer windows (runners from before 2026-10-16) count as not measured.
 */
export const MAX_WINDOW_SECONDS = 0.25;
/** A run busy at its runner's limit this share of its time may have wanted more: no smaller runner than that one. */
export const SATURATED = 0.05;
/** Earlier runs looked at, and how many measured ones a job needs before it can get a smaller runner. */
export const HISTORY = 5;
export const MIN_MEASURED = 3;
/**
 * Once a smaller runner ran a job out of memory, failed it or slowed it, the job stays on large while that
 * run is among its last LOOKBACK, so it doesn't move back and forth between sizes.
 */
export const LOOKBACK = 20;

/**
 * The most cores a run kept busy in any quarter-second window, counted at its level's upper bound (never below
 * what was measured). A smaller runner must have at least this many vCPUs: its average says little about a
 * test suite's bursts, and a job that is short of CPU even for seconds can miss its own timeouts.
 */
export function peakCores(u: JobUsage): number {
  let top = 0;
  u.busySeconds.forEach((secs, i) => {
    if (secs > 0) top = Math.max(top, Math.min(BUSY_BUCKETS[i] ?? Infinity, u.cores));
  });
  return Math.max(top, u.coresMax);
}

/** Why a size would not do for a run, or null when it would. */
function unfit(size: RunnerSize, r: SizedRun & { usage: JobUsage }): string | null {
  const s = RUNNER_SIZES[size];
  const u = r.usage;
  if (u.memoryPeak / 1024 ** 3 * MEMORY_HEADROOM.factor + MEMORY_HEADROOM.plusGiB > s.memoryGiB) return "memory";
  if (u.diskPeak / 1e9 * DISK_HEADROOM.factor + DISK_HEADROOM.plusGB > s.diskGB) return "disk";
  // Held back by its own runner's CPU: it may need more than it showed, so nothing smaller than that runner.
  if (u.saturated > SATURATED && s.vcpu <= RUNNER_SIZES[r.size].vcpu) return "cpu";
  // Counted as on the slowest host, with headroom for bursts shorter than a sample.
  if (peakCores(u) * hostFactor(r.cpu) * CPU_HEADROOM > s.vcpu) return "cpu";
  return null;
}

export type SizeChoice = { size: RunnerSize; why: string };

/**
 * The size for a hosted job from its earlier runs (the same workflow and job name, newest first). It is
 * `large` unless each of its last few runs (at least MIN_MEASURED, all measured) fits a smaller one with
 * headroom: peak memory and disk well inside it, and half as many cores again as it kept busy at its
 * busiest, counted as on the slowest host. A run that ran out of memory, failed on a smaller runner, or
 * took longer there than the job takes on large keeps the job on `large` for its next LOOKBACK runs, so a
 * smaller runner is never what makes a job fail or slow down twice. A re-run of a failed job always gets
 * `large`. `large` gives the job's measured runs on large when they go back further than `history`.
 */
export function chooseSize(history: readonly SizedRun[], o: { rerun?: boolean; large?: readonly SizedRun[] } = {}): SizeChoice {
  if (o.rerun) return { size: "large", why: "a re-run runs on the large runner" };
  const counted = history.filter((r) => r.conclusion !== "cancelled" && r.conclusion !== "skipped").slice(0, LOOKBACK);
  const runs = counted.slice(0, HISTORY);
  if (!runs.length) return { size: "large", why: "no earlier run of this job to size it by" };
  for (const r of runs) {
    if (!r.usage) return { size: "large", why: "an earlier run of this job wasn't measured" };
    if (!(r.usage.windowSeconds! <= MAX_WINDOW_SECONDS)) return { size: "large", why: "an earlier run of this job wasn't measured closely enough (busy cores every quarter second)" };
  }
  const onLarge = (o.large ?? history).filter((r) => r.size === "large" && r.conclusion === "success" && r.usage);
  for (const r of counted) {
    if (r.usage?.oomKills) return { size: "large", why: "an earlier run of this job ran out of memory" };
    if (r.size === "large") continue;
    if (r.conclusion !== "success") return { size: "large", why: `an earlier run of this job failed on a ${r.size} runner` };
    const limit = slowLimit(onLarge, r.cpu);
    if (r.usage && limit !== null && r.usage.seconds > limit) {
      return { size: "large", why: `an earlier run of this job took longer on a ${r.size} runner than it does on large` };
    }
  }
  if (runs.length < MIN_MEASURED) return { size: "large", why: `fewer than ${MIN_MEASURED} measured runs of this job to size it by` };
  const measured = runs as Array<SizedRun & { usage: JobUsage }>;
  for (const size of ASCENDING) {
    if (size === "large") break;
    if (measured.every((r) => !unfit(size, r))) {
      const peak = Math.max(...measured.map((r) => r.usage.memoryPeak)) / 1024 ** 3;
      return { size, why: `sized by this job's last ${measured.length} runs (peak memory ${peak.toFixed(1)} GiB)` };
    }
  }
  return { size: "large", why: "this job uses what a smaller runner doesn't have" };
}

/**
 * The longest a run on a smaller runner may take before it counts as slowed: the job's time on large plus its
 * own noise there. Its measured large runs on the same host processor as `cpu` are compared (cores differ
 * about 2x between hosts), or all of them when none ran on that one; null with none. The limit is a tenth and
 * 2 seconds over their median, or, with 5 or more of them, their slowest but one when that is higher: a job
 * whose own large runs vary that much can't be told to be slower by less.
 */
export function slowLimit(onLarge: readonly SizedRun[], cpu: string | null | undefined): number | null {
  const model = hostModel(cpu);
  const same = model ? onLarge.filter((r) => hostModel(r.cpu) === model) : [];
  const secs = (same.length ? same : onLarge).slice(0, 10).map((r) => r.usage!.seconds).sort((a, b) => a - b);
  if (!secs.length) return null;
  const median = secs[Math.floor((secs.length - 1) / 2)]!;
  const spread = secs.length >= 5 ? secs[secs.length - 2]! : 0;
  return Math.max(median * SLOWER.factor + SLOWER.plusSeconds, spread);
}

/** The log line naming the job's runner size and why it got it. */
export function describeSize(size: RunnerSize, why: string, pinned: boolean): string {
  const s = RUNNER_SIZES[size];
  const cores = s.vcpu >= 1 ? `${s.vcpu} vCPU` : `${s.vcpu} of a vCPU`;
  return `Runner size: ${size} (${cores}, ${s.memoryGiB} GiB of memory, ${s.diskGB} GB of disk), ${pinned ? "asked for by runs-on" : `${why}; runs-on: diffinery-large (or -medium, -small, -tiny) sets a size`}`;
}

/**
 * A runner's usage report as stored (JSON), or null when it isn't one. The runner holding the job's token
 * writes it, so only known fields are kept, as finite numbers in range: at worst a job misreports its own
 * use and is sized for that, and a run that then fails on a smaller runner goes back to large.
 */
export function cleanUsage(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const num = (k: string, max: number) => {
    const v = u[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : null;
  };
  const out: Record<string, unknown> = {};
  const limits: Record<string, number> = { seconds: 1e6, cpuSeconds: 1e8, coresP95: 1024, coresMax: 1024, saturated: 1, memoryPeak: 2 ** 50, diskPeak: 2 ** 50, cores: 1024, memory: 2 ** 50, disk: 2 ** 50 };
  for (const [k, max] of Object.entries(limits)) {
    const v = num(k, max);
    if (v === null) return null;
    out[k] = v;
  }
  out.oomKills = u.oomKills === null ? null : num("oomKills", 1e6);
  const busy = u.busySeconds;
  if (!Array.isArray(busy) || busy.length !== BUSY_BUCKETS.length || !busy.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) return null;
  out.busySeconds = busy.map((v: number) => Math.min(v, 1e6));
  // Optional: absent from runners before 2026-10-16 (such a run counts as not measured closely enough).
  const w = u.windowSeconds;
  if (typeof w === "number" && Number.isFinite(w) && w > 0) out.windowSeconds = Math.min(w, 60);
  return JSON.stringify(out);
}
