import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { Conclusion, ContainerSpec, JobCompletion, JobSpec, StepReport, StepSpec } from "@diffinery/shared";
import { evaluate, evaluateIf, interpolate, type StatusFns } from "@diffinery/workflow-yaml";
import { cpuTimes, runnerInfo, type RunnerApi } from "./api.js";
import { parseKeyValueFile, parsePathFile } from "./commands.js";
import { Docker, type Wrap } from "./docker.js";
import { JobLogger, OutputProcessor, type Annotation, type OutputSink } from "./log.js";
import { Masker } from "./mask.js";
import { ToolPrefetch } from "./prefetch.js";
import { RuntimeClient } from "./runtime.js";
import { runAction } from "./steps/actions.js";
import { runScript } from "./steps/run.js";
import { exec, hashFiles, killTree, nowIso, runnerArch, type ExecResult } from "./util.js";

export type Outcome = "success" | "failure" | "cancelled" | "skipped";

/**
 * After a cancel or a job timeout, how long the steps that still run (`if: always()`, `if: cancelled()`,
 * post steps) get before they are stopped too: GitHub's runner gives them 5 minutes.
 */
export const CANCEL_GRACE_MS = 5 * 60_000;

export interface StepContextEntry {
  outputs: Record<string, string>;
  outcome: Outcome;
  conclusion: Outcome;
}

/** Execution scope: the job itself, or the inside of a composite action. */
export interface Scope {
  steps: Record<string, StepContextEntry>;
  inputs: Record<string, unknown>;
  /** A step in this scope failed (without continue-on-error). */
  failed: boolean;
  /** Env inherited from the calling step (composite actions). */
  inheritedEnv: Record<string, string>;
  composite: boolean;
  action?: { path: string; repository: string; ref: string };
  depth: number;
}

export interface StepIO extends OutputSink {
  /** Short reason recorded when the step fails (e.g. exit code). */
  reason?: string;
}

export interface StepResult {
  outcome: Outcome;
  conclusion: Outcome;
  outputs: Record<string, string>;
}

export interface PostStep {
  name: string;
  /** Expression evaluated with job status (e.g. `always()`, `success()`). */
  condition: string;
  run: (logIndex: number) => Promise<void>;
}

export interface RunnerOptions {
  workRoot: string;
  /** Tool cache dir; defaults to `${workRoot}/_tool` (or RUNNER_TOOL_CACHE). */
  toolCache?: string;
  echoLogs?: boolean;
  /** Base env for child processes (defaults to process.env). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Start the Docker daemon as the job begins when the job will use Docker (hosted runners). */
  prewarmDocker?: boolean;
  /** Hosted runners: start installing the job's Go or Java toolchain as the job begins (prefetch.ts). */
  prefetchTools?: boolean;
}

export class StepFailure extends Error {}

/**
 * Whether a job will use Docker: job or service containers, `docker://` actions, or a step that names
 * docker (a `run:` script, or an action such as docker/build-push-action). A guess, so only for a head start.
 */
export function jobUsesDocker(spec: JobSpec): boolean {
  if (spec.container?.image || Object.keys(spec.services ?? {}).length) return true;
  return spec.steps.some((s) => /\bdocker\b|testcontainers/i.test(`${s.uses ?? ""}\n${s.run ?? ""}`));
}

/** The runner's own credentials: never in a step's environment. */
const SENSITIVE_ENV = ["DIFFINERY_JOB_TOKEN", "DIFFINERY_SANDBOX_SECRET", "DIFFINERY_GITHUB_TOKEN"];

export class JobRunner {
  readonly masker = new Masker();
  readonly logger: JobLogger;
  readonly workspace: string;
  readonly tempDir: string;
  readonly toolCache: string;
  readonly actionsDir: string;
  readonly fileCmdDir: string;
  readonly eventPath: string;
  readonly debug: boolean;

  /** Accumulated GITHUB_ENV values. */
  envAccum: Record<string, string> = {};
  /** Accumulated GITHUB_PATH entries, most recent first. */
  pathAccum: string[] = [];
  jobEnv: Record<string, string> = {};
  readonly summaries: string[] = [];
  readonly posts: PostStep[] = [];
  readonly children = new Set<ChildProcess>();
  /**
   * Aborted when the job is cancelled or times out, for work the runner does itself (downloads). A new
   * one takes its place for the steps that still run after a cancel.
   */
  private aborter = new AbortController();
  readonly stepErrors = new Map<number, Annotation[]>();
  readonly stepReasons = new Map<number, string>();
  /** Job and service containers, and Docker actions (self-hosted runners with Docker). */
  readonly docker: Docker;
  readonly prefetch = new ToolPrefetch(this);
  /** The Actions runtime services client (null when the server sent none). */
  readonly runtime: RuntimeClient | null;

  /** Why the job is ending early: the job's status for status functions and its conclusion. */
  private stopping: null | "cancelled" | "timeout" = null;
  /**
   * Whether the work under way must stop now: set by a cancel, cleared once the steps that still
   * run after it begin (resumeAfterCancel), and set for good when their grace runs out (`forced`).
   */
  private halting = false;
  private forced = false;
  private graceTimer: NodeJS.Timeout | undefined;
  /** Set when the platform signals that it is replacing this runner (a container rollout). */
  replacing = false;
  private firstFailure: { step?: number; message: string } | null = null;
  /** The vCPUs' time when a hosted job started, to say at the end how much of it the host took (steal). */
  private cpuAtStart: { total: number; steal: number } | null = null;
  private githubCtx: Record<string, unknown> = {};
  private defaultEnv: Record<string, string> = {};
  /**
   * The Actions runtime services' variables. Like GitHub, only JavaScript and
   * Docker actions get them (and the built-ins, which call the services directly);
   * `run:` steps do not.
   */
  runtimeEnv: Record<string, string> = {};
  private baseEnv: NodeJS.ProcessEnv;
  private secrets: Record<string, string>;

  constructor(
    readonly spec: JobSpec,
    readonly api: RunnerApi,
    logger: JobLogger | null,
    readonly opts: RunnerOptions,
    batcher: import("./api.js").LogBatcher | null = null,
  ) {
    this.logger = logger ?? new JobLogger(this.masker, batcher, !!opts.echoLogs);
    this.workspace = path.join(opts.workRoot, spec.repo.name);
    this.tempDir = path.join(opts.workRoot, "_temp");
    this.toolCache = opts.toolCache ?? process.env.RUNNER_TOOL_CACHE ?? path.join(opts.workRoot, "_tool");
    this.actionsDir = path.join(opts.workRoot, "_actions");
    this.fileCmdDir = path.join(this.tempDir, "_runner_file_commands");
    this.eventPath = path.join(this.tempDir, "_github_workflow", "event.json");
    this.secrets = { ...spec.secrets, GITHUB_TOKEN: spec.token };
    this.debug = this.secrets.ACTIONS_STEP_DEBUG === "true" || spec.vars?.ACTIONS_STEP_DEBUG === "true";
    const base = { ...(opts.baseEnv ?? process.env) };
    for (const k of SENSITIVE_ENV) delete base[k];
    this.baseEnv = base;
    for (const v of Object.values(this.secrets)) this.masker.add(v);
    if (spec.runtime) this.masker.add(spec.runtime.token);
    this.runtime = RuntimeClient.fromSpec(spec);
    this.docker = new Docker(this);
  }

  /** The runner's own environment (for internal tools such as the docker CLI). */
  hostEnv(): NodeJS.ProcessEnv {
    return { ...this.baseEnv };
  }

  // ------------------------------------------------------------ public

  get signal(): AbortSignal {
    return this.aborter.signal;
  }

  /** Whether the step under way must stop (the job was cancelled or timed out while it ran). */
  get isStopping(): boolean {
    return this.halting;
  }

  /**
   * SIGINT / SIGTERM / external cancellation, or the job's timeout. Like GitHub, the step under way
   * stops, and the steps that still run after a cancel (`if: always()`, `if: cancelled()`, post steps)
   * get `graceMs` before they are stopped too. A second cancel stops them at once.
   */
  cancel(reason: "cancelled" | "timeout" = "cancelled", graceMs = CANCEL_GRACE_MS): void {
    if (this.stopping) return this.force();
    this.stopping = reason;
    this.halt();
    if (graceMs <= 0) return this.force();
    this.graceTimer = setTimeout(() => {
      this.logger.line(-1, `##[error]The steps that run after a cancel took longer than ${graceMs / 60_000} minutes; stopping them.`);
      this.force();
    }, graceMs);
    this.graceTimer.unref();
  }

  private force(): void {
    if (this.forced) return;
    this.forced = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.halt();
  }

  private halt(): void {
    this.halting = true;
    this.aborter.abort();
    for (const c of this.children) killTree(c);
  }

  /** A process the job started: stopped with the job, or at once when it started after the stop. */
  private track(c: ChildProcess): void {
    this.children.add(c);
    c.once("close", () => this.children.delete(c));
    if (this.halting) killTree(c);
  }

  /** Once the cancelled step has stopped: let the steps that still run after a cancel do their work. */
  private resumeAfterCancel(): void {
    if (!this.halting || this.forced) return;
    this.halting = false;
    this.aborter = new AbortController();
  }

  async run(): Promise<JobCompletion> {
    const spec = this.spec;
    let jobTimer: NodeJS.Timeout | undefined;
    if (spec.timeoutMinutes > 0) {
      jobTimer = setTimeout(() => {
        this.logger.line(-1, `##[error]The job running on runner has exceeded the maximum execution time of ${spec.timeoutMinutes} minutes.`);
        this.cancel("timeout");
      }, spec.timeoutMinutes * 60_000);
      jobTimer.unref();
    }
    const top: Scope = { steps: {}, inputs: spec.inputs ?? {}, failed: false, inheritedEnv: {}, composite: false, depth: 0 };
    if (this.opts.prewarmDocker && jobUsesDocker(spec)) this.docker.prewarm();
    if (this.opts.prefetchTools) this.prefetch.start(spec);
    try {
      await this.setup();
      await this.initContainers(top);
      for (let i = 0; i < spec.steps.length; i++) {
        const step = spec.steps[i]!;
        const fallbackName = defaultStepName(step);
        if (this.forced) {
          await this.report(i, { status: "completed", conclusion: "cancelled", name: safeName(step, fallbackName), completedAt: nowIso() });
          continue;
        }
        this.resumeAfterCancel();
        const startedAt = nowIso();
        let started = false;
        const res = await this.executeStep(step, top, i, async (name) => {
          started = true;
          await this.report(i, { status: "in_progress", name, startedAt });
        });
        await this.report(i, {
          status: "completed",
          // After a cancel, a step whose condition kept it from running shows as cancelled, as before.
          conclusion: this.stopping && res.conclusion === "skipped" ? "cancelled" : res.conclusion,
          name: res.name ?? fallbackName,
          ...(started ? { startedAt } : {}),
          completedAt: nowIso(),
        });
      }
      if (!this.forced) await this.runPosts(top);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.line(-1, `##[error]${msg}`);
      top.failed = true;
      this.firstFailure ??= { message: msg };
    } finally {
      if (jobTimer) clearTimeout(jobTimer);
      if (this.graceTimer) clearTimeout(this.graceTimer);
      await this.prefetch.stop();
      try {
        await this.docker.cleanup({ logIndex: -1, outputs: {}, state: {} });
      } catch (e) {
        this.logger.line(-1, `##[warning]Could not remove the job's containers: ${errMsg(e)}`);
      }
    }

    let conclusion: Conclusion = top.failed ? "failure" : "success";
    if (this.stopping === "cancelled") conclusion = "cancelled";
    if (this.stopping === "timeout") {
      conclusion = "failure";
      this.firstFailure = { ...(this.firstFailure ?? {}), message: `The job exceeded the maximum execution time of ${spec.timeoutMinutes} minutes.` };
    }
    const outputs = this.jobOutputs(top);
    const completion: JobCompletion = { conclusion, outputs };
    const summary = this.summaries.filter((s) => s.trim() !== "").join("\n");
    if (summary) completion.summary = this.masker.mask(summary);
    if (conclusion === "failure" && this.firstFailure) completion.failure = { ...this.firstFailure, message: this.masker.mask(this.firstFailure.message) };
    if (conclusion === "cancelled") completion.failure = { message: "The job was cancelled." };
    if (this.replacing && conclusion !== "success") completion.replaced = true;
    const stolen = this.stolenShare();
    if (stolen !== null) this.logger.line(-1, `Host: ${stolen}% of the vCPUs' time went to other work on the host (steal)`);
    this.logger.line(-1, `Job completed with conclusion: ${conclusion}`);
    return completion;
  }

  /** The share of the vCPUs' time since the job started that the hypervisor gave to other work, in percent. */
  private stolenShare(): number | null {
    const end = this.cpuAtStart && cpuTimes();
    if (!this.cpuAtStart || !end || end.total <= this.cpuAtStart.total) return null;
    return Math.round((100 * (end.steal - this.cpuAtStart.steal)) / (end.total - this.cpuAtStart.total));
  }

  // ------------------------------------------------------------ setup

  private async setup(): Promise<void> {
    const spec = this.spec;
    await mkdir(this.workspace, { recursive: true });
    await mkdir(this.fileCmdDir, { recursive: true });
    await mkdir(this.toolCache, { recursive: true });
    await mkdir(this.actionsDir, { recursive: true });
    await mkdir(path.dirname(this.eventPath), { recursive: true });
    const g = spec.github ?? {};
    const refName = String(g.ref_name ?? spec.ref.replace(/^refs\/(heads|tags)\//, ""));
    const refType = String(g.ref_type ?? (spec.ref.startsWith("refs/tags/") ? "tag" : "branch"));
    const server = spec.apiUrl.replace(/\/$/, "");
    const repoFull = `${spec.repo.owner}/${spec.repo.name}`;
    this.githubCtx = {
      repository: repoFull,
      repository_owner: spec.repo.owner,
      sha: spec.sha,
      ref: spec.ref,
      ref_name: refName,
      ref_type: refType,
      run_id: spec.runId,
      run_number: g.run_number ?? "1",
      run_attempt: g.run_attempt ?? "1",
      job: spec.jobKey,
      workflow: spec.workflowPath,
      event_name: "push",
      event: {},
      actor: "diffinery",
      server_url: server,
      api_url: `${server}/api/v3`,
      graphql_url: `${server}/api/graphql`,
      ...g,
      workspace: this.workspace,
      token: spec.token,
      action: "",
      action_path: "",
    };
    await writeFile(this.eventPath, JSON.stringify(this.githubCtx.event ?? {}, null, 2));
    const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
    const d: Record<string, string> = {
      CI: "true",
      GITHUB_ACTIONS: "true",
      DIFFINERY: "true",
      GITHUB_REPOSITORY: repoFull,
      GITHUB_REPOSITORY_OWNER: spec.repo.owner,
      GITHUB_SHA: spec.sha,
      GITHUB_REF: spec.ref,
      GITHUB_REF_NAME: refName,
      GITHUB_REF_TYPE: refType,
      GITHUB_HEAD_REF: str(g.head_ref),
      GITHUB_BASE_REF: str(g.base_ref),
      GITHUB_RUN_ID: str(this.githubCtx.run_id),
      GITHUB_RUN_NUMBER: str(this.githubCtx.run_number),
      GITHUB_RUN_ATTEMPT: str(this.githubCtx.run_attempt),
      GITHUB_JOB: spec.jobKey,
      GITHUB_ACTOR: str(this.githubCtx.actor),
      GITHUB_TRIGGERING_ACTOR: str(g.triggering_actor ?? this.githubCtx.actor),
      GITHUB_EVENT_NAME: str(this.githubCtx.event_name),
      GITHUB_EVENT_PATH: this.eventPath,
      GITHUB_SERVER_URL: server,
      GITHUB_API_URL: `${server}/api/v3`,
      GITHUB_GRAPHQL_URL: `${server}/api/graphql`,
      // GitHub Enterprise's names for the same two URLs. Tools such as super-linter build api.github.com from a
      // default domain unless these are set, and would send the job's token there.
      GITHUB_CUSTOM_API_URL: `${server}/api/v3`,
      GITHUB_CUSTOM_SERVER_URL: server,
      GITHUB_WORKFLOW: str(g.workflow ?? spec.workflowPath),
      GITHUB_WORKFLOW_REF: str(g.workflow_ref ?? `${repoFull}/${spec.workflowPath}@${spec.ref}`),
      GITHUB_WORKSPACE: this.workspace,
      GITHUB_RETENTION_DAYS: "90",
      RUNNER_OS: "Linux",
      RUNNER_ARCH: runnerArch(),
      RUNNER_NAME: "diffinery",
      RUNNER_ENVIRONMENT: "diffinery-hosted",
      RUNNER_TEMP: this.tempDir,
      RUNNER_TOOL_CACHE: this.toolCache,
      RUNNER_WORKSPACE: path.dirname(this.workspace),
      AGENT_TOOLSDIRECTORY: this.toolCache,
      // What hosted ubuntu-24.04 runners report; setup-* actions key tool and dependency caches on it.
      ImageOS: process.env.ImageOS ?? "ubuntu24",
      ImageVersion: process.env.ImageVersion ?? process.env.DIFFINERY_IMAGE_VERSION ?? "20250101.1",
    };
    if (this.debug || this.secrets.ACTIONS_RUNNER_DEBUG === "true" || spec.vars?.ACTIONS_RUNNER_DEBUG === "true") d.RUNNER_DEBUG = "1";
    if (spec.runtime) {
      // The Actions runtime services (cache, artifacts), scoped to this job and expiring with it.
      this.runtimeEnv = {
        ACTIONS_RUNTIME_TOKEN: spec.runtime.token,
        ACTIONS_RESULTS_URL: spec.runtime.resultsUrl,
        ACTIONS_CACHE_URL: spec.runtime.cacheUrl,
        ACTIONS_RUNTIME_URL: spec.runtime.runtimeUrl,
        ACTIONS_CACHE_SERVICE_V2: "true",
      };
    }
    if (spec.idToken && this.api.online) {
      // @actions/core appends `&audience=...`, so the URL must already carry a query string.
      d.ACTIONS_ID_TOKEN_REQUEST_URL = `${this.api.url("/oidc")}?api-version=2.0`;
      d.ACTIONS_ID_TOKEN_REQUEST_TOKEN = spec.token;
    }
    this.defaultEnv = d;
    this.logger.line(-1, `Diffinery runner: job ${spec.jobKey} (${spec.name}) for ${repoFull}@${spec.sha.slice(0, 12)}`);
    const where = runnerInfo();
    if (Object.keys(where).length) this.logger.line(-1, `Runner: ${[where.image && `image ${where.image}`, where.location && `in ${where.location}`, where.instance && `container ${where.instance}`].filter(Boolean).join(", ")}`);
    if (spec.runnerSize) this.logger.line(-1, spec.runnerSize);
    if (where.cpu) {
      this.logger.line(-1, `Host: ${where.cpu}`);
      this.cpuAtStart = cpuTimes();
    }
    this.logger.line(-1, `Workspace: ${this.workspace}`);
    // job-level env
    const ctx = this.contexts({ steps: {}, inputs: spec.inputs ?? {}, failed: false, inheritedEnv: {}, composite: false, depth: 0 }, {});
    for (const [k, v] of Object.entries(spec.env ?? {})) {
      this.jobEnv[k] = this.interp(String(v ?? ""), ctx);
    }
  }

  // ------------------------------------------------------------ containers

  private evalContainer(spec: ContainerSpec, ctx: Record<string, unknown>): ContainerSpec {
    const i = (v: unknown) => this.interp(v === undefined || v === null ? "" : String(v), ctx);
    const out: ContainerSpec = { image: i(spec.image).trim() };
    if (spec.credentials) out.credentials = { username: i(spec.credentials.username), password: i(spec.credentials.password) };
    if (spec.env) out.env = Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, i(v)]));
    if (spec.ports) out.ports = spec.ports.map((p) => i(p)).filter(Boolean);
    if (spec.volumes) out.volumes = spec.volumes.map((v) => i(v)).filter(Boolean);
    if (spec.options) out.options = i(spec.options);
    return out;
  }

  /** Starts service containers and the job container, like GitHub's "Initialize containers". */
  private async initContainers(top: Scope): Promise<void> {
    const spec = this.spec;
    if (!spec.container && !Object.keys(spec.services ?? {}).length) return;
    const ctx = this.contexts(top, { ...this.jobEnv });
    const container = spec.container ? this.evalContainer(spec.container, ctx) : null;
    // A service whose image evaluates to an empty string is skipped (GitHub does the same).
    const services = Object.entries(spec.services ?? {})
      .map(([k, s]) => [k, this.evalContainer(s, ctx)] as const)
      .filter(([, s]) => s.image);
    if (!container?.image && !services.length) return;
    const io: StepIO = { logIndex: -1, outputs: {}, state: {} };
    this.logger.line(-1, "##[group]Initialize containers");
    try {
      await this.docker.ensure(io, container?.image ? "Job containers (jobs.<id>.container)" : "Service containers (jobs.<id>.services)");
      for (const [key, s] of services) await this.docker.startService(io, key, s);
      if (container?.image) await this.docker.startJobContainer(io, container);
    } finally {
      this.logger.line(-1, "##[endgroup]");
    }
  }

  /** Wraps a step process so it runs in the job container, when there is one. */
  containerWrap(): Wrap | undefined {
    return this.docker.execWrap();
  }

  /** The node binary JavaScript actions run with (the runner's own, mounted into a job container). */
  nodePath(): string {
    return this.docker.container ? "/__e/node" : process.execPath;
  }

  // ------------------------------------------------------------ contexts

  statusFns(scope: Scope): StatusFns {
    return {
      success: () => !scope.failed && this.stopping === null,
      // GitHub: once the job is cancelled its status is cancelled, so failure() is false.
      failure: () => scope.failed && this.stopping === null,
      cancelled: () => this.stopping !== null,
      always: () => true,
    };
  }

  extra(): { hashFiles: (...p: string[]) => string } {
    return { hashFiles: (...patterns: string[]) => hashFiles(this.workspace, patterns) };
  }

  /** Env context visible to a step before its own `env:` is applied. */
  baseEnvContext(scope: Scope): Record<string, string> {
    return { ...this.jobEnv, ...this.envAccum, ...scope.inheritedEnv };
  }

  contexts(scope: Scope, env: Record<string, string>): Record<string, unknown> {
    const spec = this.spec;
    const github = { ...this.githubCtx };
    if (scope.action) {
      github.action_path = scope.action.path;
      github.action_repository = scope.action.repository;
      github.action_ref = scope.action.ref;
    }
    return {
      github,
      env,
      vars: spec.vars ?? {},
      secrets: this.secrets,
      matrix: spec.matrix ?? {},
      needs: spec.needs ?? {},
      steps: scope.steps,
      runner: {
        os: "Linux",
        arch: runnerArch(),
        name: "diffinery",
        temp: this.tempDir,
        tool_cache: this.toolCache,
        workspace: path.dirname(this.workspace),
        debug: this.debug ? "1" : "",
        environment: "diffinery-hosted",
      },
      inputs: scope.inputs,
      job: {
        status: this.stopping ? "cancelled" : scope.failed ? "failure" : "success",
        container: this.docker.container ? { id: this.docker.container.id, network: this.docker.container.network } : {},
        services: Object.fromEntries(Object.entries(this.docker.services).map(([k, v]) => [k, { id: v.id, network: v.network, ports: v.ports }])),
      },
      strategy: spec.strategy ?? {},
    };
  }

  interp(template: string, ctx: Record<string, unknown>, scope?: Scope): string {
    if (!template.includes("${{")) return template;
    const status = scope ? this.statusFns(scope) : undefined;
    return interpolate(template, ctx, status, this.extra());
  }

  evalIf(cond: string | undefined, ctx: Record<string, unknown>, scope: Scope): boolean {
    return evaluateIf(cond, ctx, this.statusFns(scope), this.extra());
  }

  evalExpr(expr: string, ctx: Record<string, unknown>, scope: Scope): unknown {
    return evaluate(expr, ctx, this.statusFns(scope), this.extra());
  }

  /**
   * Layers workflow env over the runner's defaults. Like GitHub, workflows can
   * override defaults such as CI or DIFFINERY, but not GITHUB_* or RUNNER_*.
   */
  withDefaults(envCtx: Record<string, string>): Record<string, string> {
    const env = { ...this.defaultEnv, ...envCtx };
    for (const [k, v] of Object.entries(this.defaultEnv)) if (/^(GITHUB|RUNNER)_/.test(k)) env[k] = v;
    return env;
  }

  /** Builds the environment for a child process. */
  processEnv(envCtx: Record<string, string>, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.baseEnv, ...this.withDefaults(envCtx), ...extra };
    const basePath = envCtx.PATH ?? this.baseEnv.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    env.PATH = [...this.pathAccum, basePath].filter(Boolean).join(path.delimiter);
    return env;
  }

  // ------------------------------------------------------------ steps

  /**
   * Evaluates `if`, env, name; runs the step; updates the scope's steps
   * context and failure state.
   */
  async executeStep(step: StepSpec, scope: Scope, logIndex: number, onStart?: (name: string) => Promise<void>): Promise<StepResult & { name: string }> {
    const baseEnv = this.baseEnvContext(scope);
    let ctx = this.contexts(scope, baseEnv);
    let name = defaultStepName(step);
    try {
      name = step.name !== undefined ? this.interp(String(step.name), ctx, scope) : name;
    } catch {
      /* keep default */
    }
    const id = step.id;
    const record = (outcome: Outcome, conclusion: Outcome, outputs: Record<string, string>) => {
      if (id) scope.steps[id] = { outputs, outcome, conclusion };
    };

    let run: boolean;
    try {
      run = evaluateIf(step.if, ctx, this.statusFns(scope), this.extra());
    } catch (e) {
      this.logger.line(logIndex, `##[error]Error evaluating 'if' condition: ${errMsg(e)}`);
      this.noteFailure(logIndex, `Error evaluating 'if' condition of step '${name}': ${errMsg(e)}`);
      scope.failed = true;
      record("failure", "failure", {});
      return { outcome: "failure", conclusion: "failure", outputs: {}, name };
    }
    if (!run) {
      if (scope.depth > 0) this.logger.line(logIndex, `Skipping step '${name}' (condition not met)`);
      record("skipped", "skipped", {});
      return { outcome: "skipped", conclusion: "skipped", outputs: {}, name };
    }
    await onStart?.(name);
    if (scope.depth === 0) await this.prefetch.wait(logIndex, (m) => this.logger.line(logIndex, m));

    const io: StepIO = { logIndex, outputs: {}, state: {} };
    let outcome: Outcome = "success";
    let continueOnError = false;
    try {
      continueOnError = this.evalBoolish(step["continue-on-error"], ctx, scope);
      const stepEnv: Record<string, string> = {};
      const envCtx = { ...baseEnv };
      ctx = this.contexts(scope, envCtx);
      for (const [k, v] of Object.entries(step.env ?? {})) {
        stepEnv[k] = this.interp(String(v ?? ""), ctx, scope);
        envCtx[k] = stepEnv[k]!;
      }
      const timeoutMin = this.evalNumber(step["timeout-minutes"], ctx, scope);
      const timeoutMs = timeoutMin > 0 ? timeoutMin * 60_000 : 0;
      if (step.run !== undefined) {
        await runScript(this, { step, scope, ctx, envCtx, io, timeoutMs, name });
      } else if (step.uses) {
        await runAction(this, { step, scope, ctx, envCtx, io, timeoutMs, name });
      } else {
        throw new StepFailure("Step has neither `run` nor `uses`.");
      }
      if (this.halting) outcome = "cancelled";
    } catch (e) {
      if (this.halting) {
        outcome = "cancelled";
      } else {
        outcome = "failure";
        const msg = errMsg(e);
        if (!(e instanceof StepFailure && (e as StepFailure & { logged?: boolean }).logged)) {
          this.logger.line(logIndex, `##[error]${msg}`);
          this.addAnnotation(logIndex, { level: "error", message: msg });
        }
        io.reason ??= msg;
      }
    }

    let conclusion: Outcome = outcome;
    if (outcome === "failure") {
      if (continueOnError) {
        conclusion = "success";
        this.logger.line(logIndex, "##[warning]Step failed but continue-on-error is set; continuing.");
      } else {
        scope.failed = true;
        this.noteFailure(logIndex, io.reason);
      }
    }
    record(outcome, conclusion, io.outputs);
    return { outcome, conclusion, outputs: io.outputs, name };
  }

  private evalBoolish(v: unknown, ctx: Record<string, unknown>, scope: Scope): boolean {
    if (v === undefined || v === null || v === false) return false;
    if (v === true) return true;
    let s = String(v).trim();
    if (s.includes("${{")) s = this.interp(s, ctx, scope);
    return s === "true";
  }

  private evalNumber(v: unknown, ctx: Record<string, unknown>, scope: Scope): number {
    if (v === undefined || v === null || v === "") return 0;
    if (typeof v === "number") return v;
    let s = String(v);
    if (s.includes("${{")) s = this.interp(s, ctx, scope);
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  addAnnotation(logIndex: number, a: Annotation): void {
    let list = this.stepErrors.get(logIndex);
    if (!list) this.stepErrors.set(logIndex, (list = []));
    list.push(a);
  }

  private noteFailure(logIndex: number, reason?: string): void {
    if (this.firstFailure) return;
    const errs = (this.stepErrors.get(logIndex) ?? []).filter((a) => a.level === "error");
    // prefer annotations emitted by the step itself over our generic "exit code" message
    const userErr = [...errs].reverse().find((a) => a.message !== reason);
    let message: string;
    if (userErr) {
      const loc = userErr.file ? `${userErr.file}${userErr.line ? `:${userErr.line}` : ""}: ` : "";
      message = `${loc}${userErr.title ? `${userErr.title}: ` : ""}${userErr.message}`;
    } else {
      const tail = this.logger.tail(logIndex, 20).filter((l) => !l.startsWith("##[error]"));
      message = [reason ?? "Step failed", ...(tail.length ? ["", ...tail] : [])].join("\n");
    }
    this.firstFailure = { step: logIndex >= 0 ? logIndex : undefined, message };
    if (this.firstFailure.step === undefined) delete this.firstFailure.step;
  }

  /**
   * Runs a process for a step with fresh file-command files, interpreting
   * workflow commands, then applies GITHUB_ENV/PATH/OUTPUT/STATE/SUMMARY.
   */
  async runStepProcess(
    argv: string[],
    o: {
      cwd: string;
      envCtx: Record<string, string>;
      io: StepIO;
      timeoutMs?: number;
      extraEnv?: Record<string, string>;
      timeoutLabel?: string;
      /** Run the process somewhere else (the job container, or a Docker action's container). */
      wrap?: Wrap;
    },
  ): Promise<ExecResult> {
    const id = randomUUID();
    const files = {
      GITHUB_ENV: path.join(this.fileCmdDir, `set_env_${id}`),
      GITHUB_PATH: path.join(this.fileCmdDir, `add_path_${id}`),
      GITHUB_OUTPUT: path.join(this.fileCmdDir, `set_output_${id}`),
      GITHUB_STATE: path.join(this.fileCmdDir, `save_state_${id}`),
      GITHUB_STEP_SUMMARY: path.join(this.fileCmdDir, `step_summary_${id}`),
    };
    await mkdir(this.fileCmdDir, { recursive: true });
    await Promise.all(Object.values(files).map((f) => writeFile(f, "")));
    const proc = this.processor(o.io);
    if (!existsSync(o.cwd)) {
      throw new StepFailure(`An error occurred trying to start process '${argv[0]}' with working directory '${o.cwd}'. No such file or directory`);
    }
    let cmd = argv;
    let cwd = o.cwd;
    let env = this.processEnv(o.envCtx, { ...(o.extraEnv ?? {}), ...files });
    if (o.wrap) ({ argv: cmd, cwd, env } = o.wrap(argv, { ...this.withDefaults(o.envCtx), ...(o.extraEnv ?? {}), ...files }, o.cwd));
    const res = await exec(cmd[0]!, cmd.slice(1), {
      cwd,
      env,
      timeoutMs: o.timeoutMs,
      onLine: (l) => proc.handle(l),
      onSpawn: (c) => this.track(c),
    });
    await this.applyFileCommands(files, o.io);
    if (res.signal && this.replacing && !this.stopping) {
      // The platform's SIGTERM (a rollout, or a move) reaches every process in the container, not only the agent. The job
      // can't succeed now, so stop it and report at once: Diffinery starts it again on a new runner.
      const msg = "The platform stopped this step's processes while stopping the runner.";
      this.logger.line(o.io.logIndex, `##[error]${msg}`);
      this.addAnnotation(o.io.logIndex, { level: "error", message: msg });
      // No steps run after this cancel: the platform is stopping the container, and the job may start again elsewhere.
      this.cancel("cancelled", 0);
    }
    if (res.timedOut) {
      const mins = (o.timeoutMs ?? 0) / 60000;
      const msg = `The ${o.timeoutLabel ?? "step"} has timed out after ${Number(mins.toFixed(2))} minutes.`;
      this.logger.line(o.io.logIndex, `##[error]${msg}`);
      this.addAnnotation(o.io.logIndex, { level: "error", message: msg });
      o.io.reason = msg;
    }
    return res;
  }

  processor(io: StepIO): OutputProcessor {
    return new OutputProcessor(this.logger, this.masker, io, {
      debug: this.debug,
      onAnnotation: (a) => this.addAnnotation(io.logIndex, a),
    });
  }

  private async applyFileCommands(files: Record<string, string>, io: StepIO): Promise<void> {
    const read = async (f: string) => {
      try {
        return await readFile(f, "utf8");
      } catch {
        return "";
      }
    };
    const [envC, pathC, outC, stateC, sumC] = await Promise.all([
      read(files.GITHUB_ENV!),
      read(files.GITHUB_PATH!),
      read(files.GITHUB_OUTPUT!),
      read(files.GITHUB_STATE!),
      read(files.GITHUB_STEP_SUMMARY!),
    ]);
    const safe = (label: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        this.logger.line(io.logIndex, `##[error]Unable to process file command '${label}' successfully: ${errMsg(e)}`);
        this.addAnnotation(io.logIndex, { level: "error", message: `Unable to process file command '${label}': ${errMsg(e)}` });
      }
    };
    safe("env", () => {
      for (const [k, v] of parseKeyValueFile(envC)) {
        if (k === "NODE_OPTIONS" && /--require|-r\b/.test(v)) continue;
        this.envAccum[k] = v;
      }
    });
    safe("path", () => {
      for (const p of parsePathFile(pathC)) this.addPath(p);
    });
    safe("output", () => {
      for (const [k, v] of parseKeyValueFile(outC)) io.outputs[k] = v;
    });
    safe("state", () => {
      for (const [k, v] of parseKeyValueFile(stateC)) io.state[k] = v;
    });
    if (sumC.trim()) this.summaries.push(sumC);
  }

  addPath(p: string): void {
    this.pathAccum = [p, ...this.pathAccum.filter((x) => x !== p)];
  }

  /** Runs an internal tool (git, tar, ...) streaming its output into the step log. */
  async tool(cmd: string, args: string[], o: { io: StepIO; cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean; silent?: boolean; input?: string | Readable }): Promise<ExecResult> {
    return exec(cmd, args, {
      cwd: o.cwd ?? this.workspace,
      env: o.env ?? this.processEnv(this.baseEnvContext({ steps: {}, inputs: {}, failed: false, inheritedEnv: {}, composite: false, depth: 0 })),
      capture: o.capture,
      input: o.input,
      onLine: o.silent ? undefined : (l) => this.logger.line(o.io.logIndex, l),
      onSpawn: (c) => this.track(c),
    });
  }

  registerPost(p: PostStep): void {
    this.posts.push(p);
  }

  private async runPosts(top: Scope): Promise<void> {
    const posts = [...this.posts].reverse();
    let index = this.spec.steps.length;
    for (const p of posts) {
      const logIndex = index++;
      if (this.forced) break;
      this.resumeAfterCancel();
      let ok: boolean;
      try {
        ok = evaluateIf(p.condition, this.contexts(top, this.baseEnvContext(top)), this.statusFns(top), this.extra());
      } catch {
        ok = false;
      }
      if (!ok) continue;
      const startedAt = nowIso();
      await this.report(logIndex, { status: "in_progress", name: p.name, startedAt });
      let conclusion: Conclusion = "success";
      try {
        await p.run(logIndex);
      } catch (e) {
        conclusion = "failure";
        const msg = errMsg(e);
        if (!(e instanceof StepFailure && (e as StepFailure & { logged?: boolean }).logged)) {
          this.logger.line(logIndex, `##[error]${msg}`);
          this.addAnnotation(logIndex, { level: "error", message: msg });
        }
        top.failed = true;
        this.noteFailure(logIndex, msg);
      }
      if (this.halting) conclusion = "cancelled";
      await this.report(logIndex, { status: "completed", conclusion, name: p.name, startedAt, completedAt: nowIso() });
    }
  }

  private jobOutputs(top: Scope): Record<string, string> {
    const out: Record<string, string> = {};
    const ctx = this.contexts(top, this.baseEnvContext(top));
    for (const [k, expr] of Object.entries(this.spec.outputs ?? {})) {
      try {
        const v = this.interp(String(expr), ctx, top);
        if (this.masker.containsSecret(v)) {
          this.logger.line(-1, `##[warning]Skip output '${k}' since it may contain secret.`);
          continue;
        }
        out[k] = v;
      } catch (e) {
        this.logger.line(-1, `##[warning]Failed to evaluate job output '${k}': ${errMsg(e)}`);
      }
    }
    return out;
  }

  private async report(index: number, r: StepReport): Promise<void> {
    try {
      await this.api.postStep(index, { ...r, name: this.masker.mask(r.name) });
    } catch (e) {
      this.logger.line(-1, `##[warning]Failed to report step ${index}: ${errMsg(e)}`);
    }
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function failure(message: string, logged = false): StepFailure {
  const f = new StepFailure(message) as StepFailure & { logged?: boolean };
  f.logged = logged;
  return f;
}

export function defaultStepName(step: StepSpec): string {
  if (step.name) return String(step.name);
  if (step.uses) return `Run ${step.uses}`;
  if (step.run) return `Run ${String(step.run).trim().split("\n")[0]}`;
  return "Step";
}

function safeName(step: StepSpec, fallback: string): string {
  return step.name && !String(step.name).includes("${{") ? String(step.name) : fallback;
}
