import { readFileSync } from "node:fs";
import path from "node:path";
import type { JobCompletion, JobSpec, LogLine, StepReport } from "@diffinery/shared";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RequestOptions {
  method?: string;
  /** JSON body, or a factory producing a raw body (re-invoked on retry). */
  json?: unknown;
  body?: () => Promise<{ body: NonNullable<RequestInit["body"]>; length?: number; contentType?: string }>;
  retries?: number;
  /** Return the response for these statuses instead of throwing. */
  allow?: number[];
  headers?: Record<string, string>;
}

/**
 * Client for `${apiUrl}/runner/jobs/${jobId}` endpoints. When `base` is null
 * (offline `--spec` mode) all calls are no-ops.
 */
export class RunnerApi {
  constructor(
    public readonly base: string | null,
    private readonly token: string,
    private readonly opts: { minBackoffMs?: number; maxBackoffMs?: number } = {},
  ) {}

  get online(): boolean {
    return this.base !== null;
  }

  url(path: string): string {
    return `${this.base}${path}`;
  }

  authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  async request(path: string, o: RequestOptions = {}): Promise<Response> {
    if (!this.base) throw new Error("runner API not configured");
    return this.requestUrl(this.url(path), o);
  }

  async requestUrl(url: string, o: RequestOptions = {}, withAuth = true): Promise<Response> {
    const retries = o.retries ?? 6;
    const min = this.opts.minBackoffMs ?? 500;
    const max = this.opts.maxBackoffMs ?? 15000;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(Math.min(max, min * 2 ** (attempt - 1)));
      try {
        const headers: Record<string, string> = { ...(withAuth ? this.authHeaders() : {}), ...(o.headers ?? {}) };
        const init: RequestInit & { duplex?: string } = { method: o.method ?? "GET", headers };
        if (o.json !== undefined) {
          headers["content-type"] = "application/json";
          init.body = JSON.stringify(o.json);
        } else if (o.body) {
          const b = await o.body();
          init.body = b.body;
          if (b.contentType) headers["content-type"] = b.contentType;
          if (b.length !== undefined) headers["content-length"] = String(b.length);
          init.duplex = "half";
        }
        const res = await fetch(url, init);
        if (res.ok || o.allow?.includes(res.status)) return res;
        const text = await res.text().catch(() => "");
        const err = new HttpError(res.status, `${init.method} ${redactUrl(url)} -> ${res.status} ${text.slice(0, 300)}`, text);
        if (res.status === 408 || res.status === 429 || res.status >= 500) {
          lastErr = err;
          continue;
        }
        throw err;
      } catch (e) {
        if (e instanceof HttpError && !(e.status === 408 || e.status === 429 || e.status >= 500)) throw e;
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Fetches the job, telling Diffinery where it runs (`runnerInfo()`), which the job's API and log show. */
  async getSpec(runner: Record<string, string> = runnerInfo()): Promise<JobSpec> {
    const res = await this.request("", { retries: 8, headers: Object.keys(runner).length ? { "x-diffinery-runner": JSON.stringify(runner) } : {} });
    return (await res.json()) as JobSpec;
  }

  async postLogs(lines: LogLine[]): Promise<void> {
    if (!this.base) return;
    await this.request("/logs", { method: "POST", json: { lines }, retries: 0 });
  }

  async postStep(index: number, report: StepReport): Promise<void> {
    if (!this.base) return;
    await this.request(`/steps/${index}`, { method: "POST", json: report });
  }

  async complete(c: JobCompletion): Promise<void> {
    if (!this.base) return;
    await this.request("/complete", { method: "POST", json: c, retries: 10 });
  }
}

/**
 * Where this runner runs: the runner image tag (written next to the agent when the hosted image is
 * built, see scripts/runner-image.sh) and the Cloudflare container's location and instance.
 */
export function runnerInfo(env: NodeJS.ProcessEnv = process.env, agentPath = process.argv[1]): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const image = agentPath ? readFileSync(path.join(path.dirname(agentPath), "image-tag"), "utf8").trim() : "";
    if (image) out.image = image;
  } catch {
    /* not a hosted image */
  }
  const location = [env.CLOUDFLARE_LOCATION, env.CLOUDFLARE_REGION].filter(Boolean).join(", ");
  if (location) out.location = location;
  if (env.CLOUDFLARE_DURABLE_OBJECT_ID) out.instance = env.CLOUDFLARE_DURABLE_OBJECT_ID;
  const cpu = out.image ? hostCpu() : undefined;
  if (cpu) out.cpu = cpu;
  return out;
}

const readText = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/**
 * The host's processor as the container sees it. Cloudflare's hosts mix AMD EPYC generations whose
 * cores differ about 2x in speed (Zen 2, 3 and 4 were all seen on 2026-10-16), so a job's speed
 * depends on where it lands; the family and model say which one it got.
 */
export function hostCpu(cpuinfo = readText("/proc/cpuinfo")): string | undefined {
  const field = (k: string) => new RegExp(`^${k}\\s*:\\s*(.*)$`, "m").exec(cpuinfo)?.[1]?.trim();
  const name = field("model name");
  if (!name) return undefined;
  const family = field("cpu family");
  const model = field("model");
  const mhz = Number(field("cpu MHz"));
  const vcpus = cpuinfo.match(/^processor\s*:/gm)?.length ?? 0;
  return [`${name}${family && model ? ` (family ${family}, model ${model})` : ""}`, vcpus && `${vcpus} vCPUs`, mhz > 0 && `${Math.round(mhz)} MHz`].filter(Boolean).join(", ");
}

/** The vCPUs' time so far, from /proc/stat: all of it, and what the hypervisor gave to other work ("steal"). */
export function cpuTimes(stat = readText("/proc/stat")): { total: number; steal: number } | null {
  const f = /^cpu\s+(.*)$/m.exec(stat)?.[1]?.trim().split(/\s+/).map(Number);
  if (!f || f.length < 8 || f.some((n) => !Number.isFinite(n))) return null;
  // user nice system idle iowait irq softirq steal (guest time is already in user).
  return { total: f.slice(0, 8).reduce((a, b) => a + b, 0), steal: f[7]! };
}

function redactUrl(u: string): string {
  return u.replace(/([?&](?:token|sig|signature)=)[^&]+/gi, "$1***");
}

/**
 * Batches log lines and ships them every `intervalMs` or when `maxLines`
 * accumulate. Lines are never dropped: failed batches are retried with
 * exponential backoff and kept in order.
 */
export class LogBatcher {
  private queue: LogLine[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private failures = 0;
  private nextAttemptAt = 0;
  private closed = false;

  constructor(
    private readonly sink: (lines: LogLine[]) => Promise<void>,
    private readonly opts: { intervalMs?: number; maxLines?: number; maxBatch?: number; maxBackoffMs?: number; onError?: (e: unknown) => void } = {},
  ) {
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 500);
    this.timer.unref?.();
  }

  push(line: LogLine): void {
    this.queue.push(line);
    if (this.queue.length >= (this.opts.maxLines ?? 200)) void this.tick();
  }

  get pending(): number {
    return this.queue.length;
  }

  private tick(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.queue.length === 0) return Promise.resolve();
    if (Date.now() < this.nextAttemptAt) return Promise.resolve();
    const batch = this.queue.slice(0, this.opts.maxBatch ?? 1000);
    this.inflight = this.sink(batch)
      .then(() => {
        this.queue.splice(0, batch.length);
        this.failures = 0;
        this.nextAttemptAt = 0;
      })
      .catch((e) => {
        this.failures++;
        this.nextAttemptAt = Date.now() + Math.min(this.opts.maxBackoffMs ?? 30000, 250 * 2 ** this.failures);
        this.opts.onError?.(e);
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Flushes everything, retrying until `deadlineMs` elapses. */
  async flush(deadlineMs = 120000): Promise<boolean> {
    const until = Date.now() + deadlineMs;
    while (this.queue.length > 0 || this.inflight) {
      if (Date.now() > until) return false;
      if (this.inflight) {
        await this.inflight;
        continue;
      }
      const wait = this.nextAttemptAt - Date.now();
      if (wait > 0) await sleep(Math.min(wait, Math.max(0, until - Date.now())));
      await this.tick();
    }
    return true;
  }

  async close(deadlineMs?: number): Promise<boolean> {
    if (this.closed) return true;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    return this.flush(deadlineMs);
  }
}
