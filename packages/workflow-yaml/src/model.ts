/** Normalized workflow model produced by parseWorkflow(). */

export interface WorkflowError {
  /** Dotted path into the workflow, e.g. `jobs.build.steps[2].run`. */
  path: string;
  /** 1-based line in the YAML source, when known. */
  line?: number;
  /** 1-based column in the YAML source, when known. */
  col?: number;
  /** Message; warnings are prefixed with `warning:`. */
  message: string;
}

export interface RefFilters {
  branches?: string[];
  branchesIgnore?: string[];
  tags?: string[];
  tagsIgnore?: string[];
  paths?: string[];
  pathsIgnore?: string[];
}

export interface PushTrigger extends RefFilters {}

export interface PullRequestTrigger {
  types?: string[];
  branches?: string[];
  branchesIgnore?: string[];
  paths?: string[];
  pathsIgnore?: string[];
}

/** `merge_group`: runs on a merge queue's temporary branch; `branches` filters on the queue's base branch. */
export interface MergeGroupTrigger {
  types?: string[];
  branches?: string[];
  branchesIgnore?: string[];
}

export interface ScheduleTrigger {
  cron: string;
}

export interface DispatchInput {
  description?: string;
  required?: boolean;
  default?: unknown;
  /** string | boolean | number | choice | environment (workflow_dispatch) — string | boolean | number (workflow_call). */
  type?: string;
  options?: string[];
  deprecationMessage?: string;
}

export interface WorkflowDispatchTrigger {
  inputs?: Record<string, DispatchInput>;
}

export interface WorkflowCallTrigger {
  inputs?: Record<string, DispatchInput>;
  outputs?: Record<string, { description?: string; value: string }>;
  secrets?: Record<string, { description?: string; required?: boolean }>;
}

export interface WorkflowRunTrigger {
  workflows?: string[];
  types?: string[];
  branches?: string[];
  branchesIgnore?: string[];
}

/** Generic event configuration (issues, issue_comment, release, ...). */
export interface ActivityTrigger {
  types?: string[];
  [key: string]: unknown;
}

export interface WorkflowOn {
  push?: PushTrigger;
  pull_request?: PullRequestTrigger;
  pull_request_target?: PullRequestTrigger;
  merge_group?: MergeGroupTrigger;
  schedule?: ScheduleTrigger[];
  workflow_dispatch?: WorkflowDispatchTrigger;
  workflow_call?: WorkflowCallTrigger;
  workflow_run?: WorkflowRunTrigger;
  [event: string]: unknown;
}

export interface Defaults {
  run?: { shell?: string; "working-directory"?: string };
}

export type Permissions = "read-all" | "write-all" | Record<string, string>;

export interface Concurrency {
  group: string;
  /** Boolean, or an expression string evaluated at runtime. */
  cancelInProgress: boolean | string;
}

export interface ContainerSpec {
  image: string;
  credentials?: { username?: string; password?: string };
  env?: Record<string, string>;
  ports?: Array<string | number>;
  volumes?: string[];
  options?: string;
}

export interface EnvironmentSpec {
  name: string;
  url?: string;
}

/** Compatible with `StepSpec` in @diffinery/shared. */
export interface StepSpec {
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
  "timeout-minutes"?: number | string;
}

export interface Strategy {
  /** Raw matrix (map, or a `${{ }}` expression string); expand with expandMatrix(). */
  matrix?: unknown;
  /** Defaults to true; may be an expression string. */
  failFast: boolean | string;
  maxParallel?: number | string;
}

export interface Job {
  key: string;
  name?: string;
  /** Runner labels; an expression string stays a single (unevaluated) entry. */
  runsOn: string[];
  /** Runner group, from `runs-on: { group: ... }`. */
  runsOnGroup?: string;
  needs: string[];
  if?: string;
  env: Record<string, string>;
  defaults: Defaults;
  outputs: Record<string, string>;
  steps: StepSpec[];
  strategy?: Strategy;
  /** Defaults to 360; may be an expression string. */
  timeoutMinutes: number | string;
  /** Defaults to false; may be an expression string. */
  continueOnError: boolean | string;
  permissions?: Permissions;
  concurrency?: Concurrency;
  services?: Record<string, ContainerSpec>;
  container?: ContainerSpec;
  environment?: EnvironmentSpec;
  /** Reusable workflow reference (`owner/repo/.github/workflows/x.yml@ref` or `./.github/workflows/x.yml`). */
  uses?: string;
  /** Inputs for a reusable workflow call (values keep their YAML types). */
  with?: Record<string, unknown>;
  secrets?: "inherit" | Record<string, string>;
}

export interface Workflow {
  /** Path the workflow was loaded from, e.g. `.github/workflows/ci.yml`. */
  path: string;
  name?: string;
  runName?: string;
  on: WorkflowOn;
  env: Record<string, string>;
  defaults: Defaults;
  permissions?: Permissions;
  concurrency?: Concurrency;
  /** Jobs keyed by job id, in file order. */
  jobs: Record<string, Job>;
  /** The YAML document as plain JS (aliases and merge keys resolved). */
  raw: Record<string, unknown>;
}
