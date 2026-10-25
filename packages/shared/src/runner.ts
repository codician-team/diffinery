/**
 * JSON-safe values. Typed loosely on purpose: a recursive JSON type is too deep
 * for the Durable Object RPC type mapping, and `unknown` is not serialisable.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above
export type Json = any;

/**
 * Contract between the Diffinery control plane (Worker) and the runner agent
 * that executes a single job inside a Cloudflare Container.
 *
 * All runner endpoints live under `${apiUrl}/runner/jobs/:jobId/...` and are
 * authenticated with `Authorization: Bearer <job token>`. The job token is
 * scoped to one job, one repository (read access for clone) and expires when
 * the job's timeout elapses.
 */

export type Conclusion = "success" | "failure" | "cancelled" | "skipped";

export type StepSpec = {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  shell?: string;
  "working-directory"?: string;
  "continue-on-error"?: boolean | string;
  "timeout-minutes"?: number;
};

/** `jobs.<id>.container` or one of `jobs.<id>.services`; values may contain `${{ }}`. */
export type ContainerSpec = {
  image: string;
  credentials?: { username?: string; password?: string };
  env?: Record<string, string>;
  ports?: Array<string | number>;
  volumes?: string[];
  options?: string;
};

export interface NeedsResult {
  result: Conclusion;
  outputs: Record<string, string>;
}

export type JobSpec = {
  /** Hosted runners: a log line naming the runner's size and why the job got it (apps/diffinery/src/runner/sizes.ts). */
  runnerSize?: string;
  runId: string;
  jobId: string;
  /** Key of the job in the workflow file, e.g. `build`. */
  jobKey: string;
  /** Display name, already evaluated (matrix values substituted). */
  name: string;
  repo: { owner: string; name: string; cloneUrl: string; defaultBranch: string };
  sha: string;
  ref: string;
  workflowPath: string;
  /** The full `github` context (event name, payload, actor, sha, ref, ...). */
  github: Record<string, Json>;
  /** Workflow-level env merged with job-level env; values may contain `${{ }}`. */
  env: Record<string, string>;
  defaults?: { run?: { shell?: string; "working-directory"?: string } };
  matrix: Record<string, Json>;
  strategy: { "fail-fast": boolean; "job-index": number; "job-total": number; "max-parallel"?: number };
  needs: Record<string, NeedsResult>;
  inputs: Record<string, Json>;
  vars: Record<string, string>;
  /** Only the secrets this job may see. Values must be masked in logs. */
  secrets: Record<string, string>;
  /** Job `outputs:` map; values are expressions evaluated after the steps. */
  outputs: Record<string, string>;
  steps: StepSpec[];
  /** Job container: steps run inside it (needs Docker on the runner). */
  container?: ContainerSpec;
  /** Service containers, reachable by name from a job container or via mapped ports. */
  services?: Record<string, ContainerSpec>;
  timeoutMinutes: number;
  continueOnError: boolean;
  /** Whether `permissions: id-token: write` was granted. */
  idToken: boolean;
  /** Base URL of the Diffinery API, e.g. `https://diffinery.com`. */
  apiUrl: string;
  /** Bearer token for runner endpoints and for `git clone` (as password). */
  token: string;
  /**
   * GitHub's Actions runtime services (cache and artifacts, as the official
   * toolkit speaks them). Absent when the server cannot sign runtime tokens.
   */
  runtime?: {
    /** ACTIONS_RUNTIME_TOKEN: a JWT for this job only; it expires with the job's timeout. */
    token: string;
    /** ACTIONS_RESULTS_URL (cache v2 and artifacts v4 Twirp services). */
    resultsUrl: string;
    /** ACTIONS_CACHE_URL (legacy cache v1 REST API). */
    cacheUrl: string;
    /** ACTIONS_RUNTIME_URL. */
    runtimeUrl: string;
  };
};

export type LogLine = {
  /** ISO timestamp. */
  t: string;
  /** Index of the step this line belongs to; -1 for job setup/teardown. */
  step: number;
  text: string;
};

export type StepReport = {
  status: "in_progress" | "completed";
  conclusion?: Conclusion;
  name: string;
  startedAt?: string;
  completedAt?: string;
};

export type JobCompletion = {
  conclusion: Conclusion;
  outputs: Record<string, string>;
  /** Markdown written to $GITHUB_STEP_SUMMARY, if any. */
  summary?: string;
  /** Short machine-readable reason when the job failed (for agents). */
  failure?: { step?: number; message: string };
  /**
   * Hosted runners: the platform began replacing the runner's container (a rollout's SIGTERM)
   * and the job didn't succeed, so Diffinery may start it again on a new runner.
   */
  replaced?: boolean;
  /** What the job used of its machine, measured by the runner (hosted runners size later runs by it). */
  usage?: JobUsage;
};

/**
 * A job's use of its machine, sampled by the runner while the job ran (containers/runner/src/usage.ts).
 * Busy cores come from /proc/stat, memory from /proc/meminfo (total less available), disk from the
 * root filesystem. Sampled every half second, so a spike shorter than that can be missed.
 */
/** Upper bounds (busy cores) of the levels JobUsage.busySeconds counts. */
export const BUSY_BUCKETS: readonly number[] = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 16, 32, 64];

export type JobUsage = {
  /** Seconds measured, and CPU seconds used (all cores) in that time. */
  seconds: number;
  cpuSeconds: number;
  /** Busy cores at the 95th percentile and in the busiest window (see windowSeconds). */
  coresP95: number;
  coresMax: number;
  /** Share of samples (0 to 1) in which the job kept nearly all its cores busy (90%, or all but a quarter core): it was held back by the CPU. */
  saturated: number;
  /** Seconds spent at each level of busy cores: entry i counts windows with at most BUSY_BUCKETS[i] cores busy (and more than the one before). */
  busySeconds: number[];
  /** How long the windows busy cores were measured over, in seconds (absent from runners before 2026-10-16, which used 2 s). */
  windowSeconds?: number;
  /** Peak memory and disk in use, in bytes. */
  memoryPeak: number;
  diskPeak: number;
  /** What the machine had: vCPUs (its share, which can be a fraction), memory and disk in bytes. */
  cores: number;
  memory: number;
  disk: number;
  /** Processes the kernel killed for want of memory while the job ran (null when it doesn't say). */
  oomKills: number | null;
};

/** Runner API paths, relative to `${apiUrl}/runner/jobs/${jobId}`. */
export const RunnerPaths = {
  spec: "",
  logs: "/logs", // POST { lines: LogLine[] }
  step: (index: number) => `/steps/${index}`, // POST StepReport
  complete: "/complete", // POST JobCompletion
  cache: "/cache", // GET ?key=&restore=a,b -> { key, url } | 404 ; PUT /cache/:key body=tar.gz
  artifacts: "/artifacts", // PUT /artifacts/:name body=zip|tar ; GET /artifacts/:name
  oidc: "/oidc", // POST { audience } -> { value }
} as const;
