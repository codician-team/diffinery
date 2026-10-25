/**
 * Parsing, normalization and validation of GitHub Actions workflow files.
 */
import { LineCounter, isAlias, isMap, isScalar, isSeq, parseDocument, type Document, type Node as YamlNode } from "yaml";
import { validateCron } from "./cron.js";
import { checkExpressionSyntax } from "./expr/evaluate.js";
import { soleExpression, splitTemplate, TemplateError } from "./expr/template.js";
import { jobOrder } from "./graph.js";
import { expandMatrix } from "./matrix.js";
import type {
  Concurrency,
  ContainerSpec,
  Defaults,
  DispatchInput,
  EnvironmentSpec,
  Job,
  Permissions,
  StepSpec,
  Strategy,
  Workflow,
  WorkflowCallTrigger,
  WorkflowError,
  WorkflowOn,
} from "./model.js";

type Seg = string | number;
type Obj = Record<string, unknown>;

export const WARNING_PREFIX = "warning:";
export const isWarning = (e: WorkflowError): boolean => e.message.startsWith(WARNING_PREFIX);

const TOP_LEVEL_KEYS = new Set(["name", "run-name", "on", "env", "defaults", "permissions", "concurrency", "jobs"]);
const JOB_KEYS = new Set([
  "name", "permissions", "needs", "if", "runs-on", "snapshot", "environment", "concurrency", "outputs", "env",
  "defaults", "steps", "timeout-minutes", "strategy", "continue-on-error", "container", "services", "uses", "with",
  "secrets",
]);
const REUSABLE_JOB_KEYS = new Set(["name", "uses", "with", "secrets", "needs", "if", "permissions", "concurrency", "strategy"]);
const STEP_KEYS = new Set([
  "id", "if", "name", "uses", "run", "working-directory", "shell", "with", "env", "continue-on-error", "timeout-minutes",
]);
export const KNOWN_EVENTS = new Set([
  "branch_protection_rule", "check_run", "check_suite", "create", "delete", "deployment", "deployment_status",
  "discussion", "discussion_comment", "fork", "gollum", "issue_comment", "issues", "label", "merge_group",
  "milestone", "page_build", "project", "project_card", "project_column", "public", "pull_request",
  "pull_request_review", "pull_request_review_comment", "pull_request_target", "push", "registry_package", "release",
  "repository_dispatch", "schedule", "status", "watch", "workflow_call", "workflow_dispatch", "workflow_run",
]);
const PERMISSION_SCOPES = new Set([
  "actions", "attestations", "checks", "contents", "deployments", "discussions", "id-token", "issues", "models",
  "packages", "pages", "pull-requests", "repository-projects", "security-events", "statuses",
]);
const INPUT_TYPES_DISPATCH = new Set(["string", "boolean", "number", "choice", "environment"]);
const INPUT_TYPES_CALL = new Set(["string", "boolean", "number"]);
const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isScalarValue = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

export function formatPath(path: readonly Seg[]): string {
  let out = "";
  for (const s of path) out += typeof s === "number" ? `[${s}]` : out === "" ? s : `.${s}`;
  return out;
}

class Context {
  readonly errors: WorkflowError[] = [];
  constructor(
    private readonly doc: Document,
    private readonly lc: LineCounter,
  ) {}

  /** Finds the YAML node at `path` (the key node when `key` is set), falling back to the deepest existing ancestor. */
  private locate(path: readonly Seg[], key: boolean): { line?: number; col?: number } {
    let node: unknown = this.doc.contents;
    let best: unknown = node;
    for (let i = 0; i < path.length; i++) {
      const seg = path[i]!;
      if (isAlias(node)) node = node.resolve(this.doc);
      if (isMap(node)) {
        const pair = node.items.find((p) => (isScalar(p.key) ? String(p.key.value) : String(p.key)) === String(seg));
        if (!pair) break;
        const last = i === path.length - 1;
        best = last && key ? pair.key : (pair.value ?? pair.key);
        node = pair.value;
      } else if (isSeq(node) && typeof seg === "number") {
        const item = node.items[seg];
        if (!item) break;
        best = item;
        node = item;
      } else {
        break;
      }
    }
    const range = (best as YamlNode | undefined)?.range;
    if (!range) return {};
    const pos = this.lc.linePos(range[0]);
    return { line: pos.line, col: pos.col };
  }

  error(path: readonly Seg[], message: string, opts: { key?: boolean } = {}): void {
    this.errors.push({ path: formatPath(path), ...this.locate(path, opts.key ?? false), message });
  }

  warn(path: readonly Seg[], message: string): void {
    this.error(path, `${WARNING_PREFIX} ${message}`, { key: true });
  }

  /** Re-anchors an error whose path is a dotted string (from jobOrder). */
  errorDotted(dotted: string, message: string): void {
    this.error(dotted.split("."), message, { key: true });
  }

  // ---- value helpers -------------------------------------------------------

  str(v: unknown, path: Seg[], what = "a string"): string | undefined {
    if (v === undefined || v === null) return undefined;
    if (isScalarValue(v)) return String(v);
    this.error(path, `${formatPath(path)} must be ${what}`);
    return undefined;
  }

  strList(v: unknown, path: Seg[]): string[] | undefined {
    if (v === undefined || v === null) return undefined;
    if (isScalarValue(v)) return [String(v)];
    if (Array.isArray(v)) {
      const out: string[] = [];
      v.forEach((item, i) => {
        if (isScalarValue(item)) out.push(String(item));
        else this.error([...path, i], `${formatPath([...path, i])} must be a string`);
      });
      return out;
    }
    this.error(path, `${formatPath(path)} must be a string or a list of strings`);
    return undefined;
  }

  strMap(v: unknown, path: Seg[]): Record<string, string> {
    const out: Record<string, string> = {};
    if (v === undefined || v === null) return out;
    if (typeof v === "string" && soleExpression(v) !== undefined) {
      // e.g. `env: ${{ fromJSON(...) }}` — cannot be normalized statically.
      this.error(path, `${formatPath(path)} must be a mapping (expressions producing whole mappings are not supported here)`);
      return out;
    }
    if (!isObj(v)) {
      this.error(path, `${formatPath(path)} must be a mapping`);
      return out;
    }
    for (const [k, val] of Object.entries(v)) {
      if (val === null || val === undefined) out[k] = "";
      else if (isScalarValue(val)) out[k] = String(val);
      else this.error([...path, k], `${formatPath([...path, k])} must be a string, number or boolean`);
    }
    return out;
  }

  boolOrExpr(v: unknown, path: Seg[], dflt: boolean): boolean | string {
    if (v === undefined || v === null) return dflt;
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      if (v === "true" || v === "false") return v === "true";
      if (soleExpression(v) !== undefined) return v;
    }
    this.error(path, `${formatPath(path)} must be a boolean or an expression`);
    return dflt;
  }

  numOrExpr(v: unknown, path: Seg[]): number | string | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      if (/^\d+(\.\d+)?$/.test(v.trim())) return Number(v);
      if (soleExpression(v) !== undefined) return v;
    }
    this.error(path, `${formatPath(path)} must be a number or an expression`);
    return undefined;
  }

  unknownKeys(obj: Obj, allowed: Set<string>, path: Seg[], what: string): void {
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) this.warn([...path, k], `unknown ${what} key '${k}'`);
    }
  }
}

// ---- `on:` ---------------------------------------------------------------------

function normalizeOn(c: Context, raw: unknown): WorkflowOn {
  const on: WorkflowOn = {};
  const path: Seg[] = ["on"];
  if (typeof raw === "string") {
    addEvent(c, on, raw, null, path);
  } else if (Array.isArray(raw)) {
    raw.forEach((ev, i) => {
      if (typeof ev === "string") addEvent(c, on, ev, null, [...path, i]);
      else c.error([...path, i], "on[] entries must be event names");
    });
  } else if (isObj(raw)) {
    for (const [ev, cfg] of Object.entries(raw)) addEvent(c, on, ev, cfg, [...path, ev]);
  } else {
    c.error(path, "'on' must be an event name, a list of event names or a mapping");
  }
  if (Object.keys(on).length === 0 && (Array.isArray(raw) || isObj(raw))) c.error(path, "'on' must define at least one event");
  return on;
}

function exclusive(c: Context, cfg: Obj, path: Seg[], a: string, b: string): void {
  if (cfg[a] !== undefined && cfg[b] !== undefined) c.error(path, `'${a}' and '${b}' cannot be used together for the same event`);
}

function addEvent(c: Context, on: WorkflowOn, ev: string, cfg: unknown, path: Seg[]): void {
  if (!KNOWN_EVENTS.has(ev)) c.warn(path, `unknown event '${ev}'`);
  if (ev === "schedule") {
    on.schedule = normalizeSchedule(c, cfg, path);
    return;
  }
  if (cfg !== null && cfg !== undefined && !isObj(cfg)) {
    c.error(path, `on.${ev} must be a mapping`);
    on[ev] = {};
    return;
  }
  const o: Obj = cfg ?? {};
  const list = (k: string) => c.strList(o[k], [...path, k]);
  const pick = <T extends Obj>(entries: Record<string, unknown>): T =>
    Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined)) as T;

  switch (ev) {
    case "push":
      exclusive(c, o, path, "branches", "branches-ignore");
      exclusive(c, o, path, "tags", "tags-ignore");
      exclusive(c, o, path, "paths", "paths-ignore");
      on.push = pick({
        branches: list("branches"),
        branchesIgnore: list("branches-ignore"),
        tags: list("tags"),
        tagsIgnore: list("tags-ignore"),
        paths: list("paths"),
        pathsIgnore: list("paths-ignore"),
      });
      return;
    case "pull_request":
    case "pull_request_target":
      exclusive(c, o, path, "branches", "branches-ignore");
      exclusive(c, o, path, "paths", "paths-ignore");
      on[ev] = pick({
        types: list("types"),
        branches: list("branches"),
        branchesIgnore: list("branches-ignore"),
        paths: list("paths"),
        pathsIgnore: list("paths-ignore"),
      });
      return;
    case "workflow_dispatch": {
      const inputs = normalizeInputs(c, o.inputs, [...path, "inputs"], INPUT_TYPES_DISPATCH, false);
      on.workflow_dispatch = inputs ? { inputs } : {};
      return;
    }
    case "workflow_call": {
      const call: WorkflowCallTrigger = {};
      const inputs = normalizeInputs(c, o.inputs, [...path, "inputs"], INPUT_TYPES_CALL, true);
      if (inputs) call.inputs = inputs;
      if (o.outputs !== undefined && o.outputs !== null) {
        if (!isObj(o.outputs)) c.error([...path, "outputs"], "on.workflow_call.outputs must be a mapping");
        else {
          call.outputs = {};
          for (const [name, def] of Object.entries(o.outputs)) {
            const p = [...path, "outputs", name];
            if (!isObj(def) || typeof def.value !== "string") {
              c.error(p, `workflow_call output '${name}' must be a mapping with a 'value'`);
              continue;
            }
            call.outputs[name] = pick({ description: c.str(def.description, [...p, "description"]), value: def.value });
          }
        }
      }
      if (o.secrets !== undefined && o.secrets !== null) {
        if (!isObj(o.secrets)) c.error([...path, "secrets"], "on.workflow_call.secrets must be a mapping");
        else {
          call.secrets = {};
          for (const [name, def] of Object.entries(o.secrets)) {
            const d = isObj(def) ? def : {};
            call.secrets[name] = pick({
              description: c.str(d.description, [...path, "secrets", name, "description"]),
              required: typeof d.required === "boolean" ? d.required : undefined,
            });
          }
        }
      }
      on.workflow_call = call;
      return;
    }
    case "merge_group":
      exclusive(c, o, path, "branches", "branches-ignore");
      on.merge_group = pick({ types: list("types"), branches: list("branches"), branchesIgnore: list("branches-ignore") });
      return;
    case "workflow_run":
      exclusive(c, o, path, "branches", "branches-ignore");
      on.workflow_run = pick({
        workflows: list("workflows"),
        types: list("types"),
        branches: list("branches"),
        branchesIgnore: list("branches-ignore"),
      });
      return;
    default: {
      const out: Obj = { ...o };
      if (o.types !== undefined) out.types = list("types");
      on[ev] = out;
    }
  }
}

function normalizeSchedule(c: Context, cfg: unknown, path: Seg[]): { cron: string }[] {
  if (!Array.isArray(cfg)) {
    c.error(path, "on.schedule must be a list of { cron: '...' } entries");
    return [];
  }
  const out: { cron: string }[] = [];
  cfg.forEach((entry, i) => {
    const p = [...path, i];
    if (!isObj(entry) || typeof entry.cron !== "string") {
      c.error(p, "on.schedule entries must have a 'cron' string");
      return;
    }
    const err = validateCron(entry.cron);
    if (err) c.error([...p, "cron"], `Invalid cron: ${err}`);
    else out.push({ cron: entry.cron });
  });
  return out;
}

function normalizeInputs(
  c: Context,
  raw: unknown,
  path: Seg[],
  types: Set<string>,
  typeRequired: boolean,
): Record<string, DispatchInput> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) {
    c.error(path, `${formatPath(path)} must be a mapping`);
    return undefined;
  }
  const out: Record<string, DispatchInput> = {};
  for (const [name, def] of Object.entries(raw)) {
    const p = [...path, name];
    const d = isObj(def) ? def : {};
    if (def !== null && !isObj(def)) c.error(p, `input '${name}' must be a mapping`);
    const input: DispatchInput = {};
    const description = c.str(d.description, [...p, "description"]);
    if (description !== undefined) input.description = description;
    if (d.required !== undefined) {
      if (typeof d.required === "boolean") input.required = d.required;
      else c.error([...p, "required"], `input '${name}': 'required' must be a boolean`);
    }
    if (d.default !== undefined) input.default = d.default;
    if (d.type !== undefined) {
      const t = String(d.type);
      if (!types.has(t)) c.error([...p, "type"], `input '${name}': invalid type '${t}' (expected one of ${[...types].join(", ")})`);
      input.type = t;
    } else if (typeRequired) {
      c.error(p, `input '${name}' must declare a 'type'`, { key: true });
    }
    if (d.options !== undefined) input.options = c.strList(d.options, [...p, "options"]) ?? [];
    if (input.type === "choice" && (!input.options || input.options.length === 0)) {
      c.error(p, `input '${name}' of type 'choice' must define 'options'`, { key: true });
    }
    if (typeof d.deprecationMessage === "string") input.deprecationMessage = d.deprecationMessage;
    out[name] = input;
  }
  return out;
}

// ---- shared job/workflow pieces --------------------------------------------------

function normalizeDefaults(c: Context, raw: unknown, path: Seg[]): Defaults {
  if (raw === undefined || raw === null) return {};
  if (!isObj(raw)) {
    c.error(path, `${formatPath(path)} must be a mapping`);
    return {};
  }
  const out: Defaults = {};
  if (raw.run !== undefined && raw.run !== null) {
    if (!isObj(raw.run)) c.error([...path, "run"], `${formatPath([...path, "run"])} must be a mapping`);
    else {
      out.run = {};
      const shell = c.str(raw.run.shell, [...path, "run", "shell"]);
      const wd = c.str(raw.run["working-directory"], [...path, "run", "working-directory"]);
      if (shell !== undefined) out.run.shell = shell;
      if (wd !== undefined) out.run["working-directory"] = wd;
    }
  }
  return out;
}

function normalizePermissions(c: Context, raw: unknown, path: Seg[]): Permissions | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return {};
  if (raw === "read-all" || raw === "write-all") return raw;
  if (!isObj(raw)) {
    c.error(path, "permissions must be 'read-all', 'write-all' or a mapping of scope: read|write|none");
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [scope, level] of Object.entries(raw)) {
    if (!PERMISSION_SCOPES.has(scope)) c.warn([...path, scope], `unknown permission scope '${scope}'`);
    if (level !== "read" && level !== "write" && level !== "none") {
      c.error([...path, scope], `permission '${scope}' must be 'read', 'write' or 'none'`);
      continue;
    }
    out[scope] = level;
  }
  return out;
}

function normalizeConcurrency(c: Context, raw: unknown, path: Seg[]): Concurrency | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (isScalarValue(raw)) return { group: String(raw), cancelInProgress: false };
  if (!isObj(raw) || !isScalarValue(raw.group)) {
    c.error(path, "concurrency must be a group string or a mapping with 'group'");
    return undefined;
  }
  return { group: String(raw.group), cancelInProgress: c.boolOrExpr(raw["cancel-in-progress"], [...path, "cancel-in-progress"], false) };
}

function normalizeContainer(c: Context, raw: unknown, path: Seg[]): ContainerSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return { image: raw };
  if (!isObj(raw) || typeof raw.image !== "string") {
    c.error(path, `${formatPath(path)} must be an image string or a mapping with 'image'`);
    return undefined;
  }
  const out: ContainerSpec = { image: raw.image };
  if (isObj(raw.credentials)) {
    out.credentials = {};
    const u = c.str(raw.credentials.username, [...path, "credentials", "username"]);
    const p = c.str(raw.credentials.password, [...path, "credentials", "password"]);
    if (u !== undefined) out.credentials.username = u;
    if (p !== undefined) out.credentials.password = p;
  }
  if (raw.env !== undefined) out.env = c.strMap(raw.env, [...path, "env"]);
  if (raw.ports !== undefined) {
    if (Array.isArray(raw.ports) && raw.ports.every((p) => typeof p === "string" || typeof p === "number")) {
      out.ports = raw.ports as Array<string | number>;
    } else c.error([...path, "ports"], `${formatPath([...path, "ports"])} must be a list of ports`);
  }
  if (raw.volumes !== undefined) out.volumes = c.strList(raw.volumes, [...path, "volumes"]) ?? [];
  const options = c.str(raw.options, [...path, "options"]);
  if (options !== undefined) out.options = options;
  return out;
}

function normalizeEnvironment(c: Context, raw: unknown, path: Seg[]): EnvironmentSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (isScalarValue(raw)) return { name: String(raw) };
  if (!isObj(raw) || !isScalarValue(raw.name)) {
    c.error(path, "environment must be a name or a mapping with 'name'");
    return undefined;
  }
  const env: EnvironmentSpec = { name: String(raw.name) };
  const url = c.str(raw.url, [...path, "url"]);
  if (url !== undefined) env.url = url;
  return env;
}

// ---- steps and jobs ----------------------------------------------------------------

function normalizeStep(c: Context, raw: unknown, path: Seg[], ids: Set<string>): StepSpec | undefined {
  if (!isObj(raw)) {
    c.error(path, "step must be a mapping");
    return undefined;
  }
  c.unknownKeys(raw, STEP_KEYS, path, "step");
  const step: StepSpec = {};
  const hasRun = raw.run !== undefined && raw.run !== null;
  const hasUses = raw.uses !== undefined && raw.uses !== null;
  if (hasRun && hasUses) c.error(path, "step cannot have both 'run' and 'uses'");
  if (!hasRun && !hasUses) c.error(path, "step must have either 'run' or 'uses'");

  const id = c.str(raw.id, [...path, "id"]);
  if (id !== undefined) {
    if (!ID_RE.test(id) && soleExpression(id) === undefined) {
      c.error([...path, "id"], `step id '${id}' must start with a letter or '_' and contain only alphanumerics, '-' or '_'`);
    }
    if (ids.has(id)) c.error([...path, "id"], `duplicate step id '${id}'`);
    ids.add(id);
    step.id = id;
  }
  const name = c.str(raw.name, [...path, "name"]);
  if (name !== undefined) step.name = name;
  const cond = c.str(raw.if, [...path, "if"]);
  if (cond !== undefined) step.if = cond;
  const run = c.str(raw.run, [...path, "run"]);
  if (run !== undefined) step.run = run;
  const uses = c.str(raw.uses, [...path, "uses"]);
  if (uses !== undefined) {
    if (uses.trim() === "") c.error([...path, "uses"], "'uses' must not be empty");
    step.uses = uses;
  }
  if (raw.with !== undefined && raw.with !== null) step.with = c.strMap(raw.with, [...path, "with"]);
  if (raw.env !== undefined && raw.env !== null) step.env = c.strMap(raw.env, [...path, "env"]);
  const shell = c.str(raw.shell, [...path, "shell"]);
  if (shell !== undefined) step.shell = shell;
  const wd = c.str(raw["working-directory"], [...path, "working-directory"]);
  if (wd !== undefined) step["working-directory"] = wd;
  if (raw["continue-on-error"] !== undefined) {
    step["continue-on-error"] = c.boolOrExpr(raw["continue-on-error"], [...path, "continue-on-error"], false);
  }
  const timeout = c.numOrExpr(raw["timeout-minutes"], [...path, "timeout-minutes"]);
  if (timeout !== undefined) step["timeout-minutes"] = timeout;
  return step;
}

function normalizeStrategy(c: Context, raw: unknown, path: Seg[]): Strategy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) {
    c.error(path, "strategy must be a mapping");
    return undefined;
  }
  const strategy: Strategy = { failFast: c.boolOrExpr(raw["fail-fast"], [...path, "fail-fast"], true) };
  const maxParallel = c.numOrExpr(raw["max-parallel"], [...path, "max-parallel"]);
  if (maxParallel !== undefined) strategy.maxParallel = maxParallel;
  if (raw.matrix !== undefined) {
    strategy.matrix = raw.matrix;
    if (!JSON.stringify(raw.matrix).includes("${{")) {
      try {
        if (expandMatrix(raw.matrix).length === 0) c.error([...path, "matrix"], "matrix produces no job combinations");
      } catch (e) {
        c.error([...path, "matrix"], (e as Error).message);
      }
    } else if (!isObj(raw.matrix) && (typeof raw.matrix !== "string" || soleExpression(raw.matrix) === undefined)) {
      c.error([...path, "matrix"], "matrix must be a mapping or a single ${{ }} expression");
    }
  }
  return strategy;
}

function normalizeRunsOn(c: Context, raw: unknown, path: Seg[], job: Job): void {
  if (isScalarValue(raw)) job.runsOn = [String(raw)];
  else if (Array.isArray(raw)) job.runsOn = c.strList(raw, path) ?? [];
  else if (isObj(raw)) {
    if (raw.group !== undefined) {
      const g = c.str(raw.group, [...path, "group"]);
      if (g !== undefined) job.runsOnGroup = g;
    }
    job.runsOn = c.strList(raw.labels, [...path, "labels"]) ?? [];
    if (raw.group === undefined && raw.labels === undefined) c.error(path, "runs-on mapping must define 'group' and/or 'labels'");
  } else c.error(path, "runs-on must be a label, a list of labels or a mapping with group/labels");
}

function normalizeJob(c: Context, key: string, raw: unknown): Job | undefined {
  const path: Seg[] = ["jobs", key];
  if (!ID_RE.test(key)) {
    c.error(path, `job id '${key}' must start with a letter or '_' and contain only alphanumerics, '-' or '_'`, { key: true });
  }
  if (!isObj(raw)) {
    c.error(path, `job '${key}' must be a mapping`, { key: true });
    return undefined;
  }
  const isReusable = raw.uses !== undefined && raw.uses !== null;
  c.unknownKeys(raw, isReusable ? REUSABLE_JOB_KEYS : JOB_KEYS, path, isReusable ? "reusable-workflow job" : "job");

  const job: Job = {
    key,
    runsOn: [],
    needs: c.strList(raw.needs, [...path, "needs"]) ?? [],
    env: c.strMap(raw.env, [...path, "env"]),
    defaults: normalizeDefaults(c, raw.defaults, [...path, "defaults"]),
    outputs: c.strMap(raw.outputs, [...path, "outputs"]),
    steps: [],
    timeoutMinutes: c.numOrExpr(raw["timeout-minutes"], [...path, "timeout-minutes"]) ?? 360,
    continueOnError: c.boolOrExpr(raw["continue-on-error"], [...path, "continue-on-error"], false),
  };
  const name = c.str(raw.name, [...path, "name"]);
  if (name !== undefined) job.name = name;
  const cond = c.str(raw.if, [...path, "if"]);
  if (cond !== undefined) job.if = cond;

  if (isReusable) {
    const uses = c.str(raw.uses, [...path, "uses"]);
    if (uses !== undefined) {
      if (!/^\.\/.+\.ya?ml$/.test(uses) && !/^[^/\s]+\/[^/\s]+\/.+\.ya?ml@\S+$/.test(uses)) {
        c.error([...path, "uses"], `reusable workflow reference '${uses}' must be './path/to/workflow.yml' or 'owner/repo/path/to/workflow.yml@ref'`);
      }
      job.uses = uses;
    }
    if (raw.steps !== undefined) c.error([...path, "steps"], "a job that calls a reusable workflow ('uses') cannot have 'steps'", { key: true });
    if (raw["runs-on"] !== undefined) c.error([...path, "runs-on"], "a job that calls a reusable workflow ('uses') cannot have 'runs-on'", { key: true });
    if (raw.with !== undefined && raw.with !== null) {
      if (!isObj(raw.with)) c.error([...path, "with"], "with must be a mapping");
      else job.with = { ...raw.with };
    }
    if (raw.secrets !== undefined && raw.secrets !== null) {
      job.secrets = raw.secrets === "inherit" ? "inherit" : c.strMap(raw.secrets, [...path, "secrets"]);
    }
  } else {
    if (raw["runs-on"] === undefined || raw["runs-on"] === null) {
      c.error(path, `job '${key}' is missing 'runs-on'`, { key: true });
    } else {
      normalizeRunsOn(c, raw["runs-on"], [...path, "runs-on"], job);
    }
    if (!Array.isArray(raw.steps)) {
      c.error(raw.steps === undefined ? path : [...path, "steps"], `job '${key}' must have a list of 'steps'`, { key: true });
    } else {
      if (raw.steps.length === 0) c.error([...path, "steps"], `job '${key}' must have at least one step`, { key: true });
      const ids = new Set<string>();
      raw.steps.forEach((s, i) => {
        const step = normalizeStep(c, s, [...path, "steps", i], ids);
        if (step) job.steps.push(step);
      });
    }
    const container = normalizeContainer(c, raw.container, [...path, "container"]);
    if (container) job.container = container;
    if (raw.services !== undefined && raw.services !== null) {
      if (!isObj(raw.services)) c.error([...path, "services"], "services must be a mapping");
      else {
        job.services = {};
        for (const [name, svc] of Object.entries(raw.services)) {
          const spec = normalizeContainer(c, svc, [...path, "services", name]);
          if (spec) job.services[name] = spec;
        }
      }
    }
    const environment = normalizeEnvironment(c, raw.environment, [...path, "environment"]);
    if (environment) job.environment = environment;
  }

  const strategy = normalizeStrategy(c, raw.strategy, [...path, "strategy"]);
  if (strategy) job.strategy = strategy;
  const permissions = normalizePermissions(c, raw.permissions, [...path, "permissions"]);
  if (permissions) job.permissions = permissions;
  const concurrency = normalizeConcurrency(c, raw.concurrency, [...path, "concurrency"]);
  if (concurrency) job.concurrency = concurrency;
  return job;
}

// ---- expression validation ---------------------------------------------------------

/** Checks every string for unclosed `${{` and expression syntax errors. */
function checkExpressions(c: Context, value: unknown, path: Seg[]): void {
  if (typeof value === "string") {
    const isIf = path[0] === "jobs" && path[path.length - 1] === "if" && (path.length === 3 || (path.length === 5 && path[2] === "steps"));
    if (isIf && !value.includes("${{")) {
      if (value.trim() !== "") {
        const err = checkExpressionSyntax(value);
        if (err) c.error(path, `Invalid expression: ${err}`);
      }
      return;
    }
    if (!value.includes("${{")) return;
    try {
      for (const part of splitTemplate(value)) {
        if (part.kind !== "expr") continue;
        const err = checkExpressionSyntax(part.expr);
        if (err) c.error(path, `Invalid expression \${{ ${part.expr} }}: ${err}`);
      }
    } catch (e) {
      if (e instanceof TemplateError) c.error(path, e.message);
      else throw e;
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => checkExpressions(c, v, [...path, i]));
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) checkExpressions(c, v, [...path, k]);
  }
}

// ---- entry point -------------------------------------------------------------------

/**
 * Parses and validates a workflow file. Errors carry YAML line/column; entries
 * whose message starts with `warning:` are non-fatal. `workflow` is returned
 * only when there are no (non-warning) errors.
 */
export function parseWorkflow(source: string, filePath: string): { workflow?: Workflow; errors: WorkflowError[] } {
  const lc = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lc, merge: true, prettyErrors: false });
  if (doc.errors.length > 0) {
    return {
      errors: doc.errors.map((e) => {
        const pos = e.linePos?.[0] ?? lc.linePos(e.pos[0]);
        return { path: "", ...(pos ? { line: pos.line, col: pos.col } : {}), message: `YAML syntax error: ${e.message.split("\n")[0]}` };
      }),
    };
  }
  const c = new Context(doc, lc);
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 10000 });
  } catch (e) {
    return { errors: [{ path: "", message: `YAML error: ${(e as Error).message}` }] };
  }
  if (!isObj(raw)) {
    c.error([], raw === null || raw === undefined ? "workflow file is empty" : "workflow must be a mapping");
    return { errors: c.errors };
  }

  c.unknownKeys(raw, TOP_LEVEL_KEYS, [], "top-level");
  const wf: Workflow = {
    path: filePath,
    on: {},
    env: c.strMap(raw.env, ["env"]),
    defaults: normalizeDefaults(c, raw.defaults, ["defaults"]),
    jobs: {},
    raw,
  };
  const name = c.str(raw.name, ["name"]);
  if (name !== undefined) wf.name = name;
  const runName = c.str(raw["run-name"], ["run-name"]);
  if (runName !== undefined) wf.runName = runName;

  if (raw.on === undefined || raw.on === null) c.error(["on"], "workflow is missing the 'on' trigger section");
  else wf.on = normalizeOn(c, raw.on);

  const permissions = normalizePermissions(c, raw.permissions, ["permissions"]);
  if (permissions) wf.permissions = permissions;
  const concurrency = normalizeConcurrency(c, raw.concurrency, ["concurrency"]);
  if (concurrency) wf.concurrency = concurrency;

  if (raw.jobs === undefined || raw.jobs === null) {
    c.error(["jobs"], "workflow is missing the 'jobs' section");
  } else if (!isObj(raw.jobs)) {
    c.error(["jobs"], "'jobs' must be a mapping of job id to job");
  } else {
    if (Object.keys(raw.jobs).length === 0) c.error(["jobs"], "'jobs' must define at least one job", { key: true });
    for (const [key, rawJob] of Object.entries(raw.jobs)) {
      const job = normalizeJob(c, key, rawJob);
      if (job) wf.jobs[key] = job;
    }
    for (const e of jobOrder(wf).errors) c.errorDotted(e.path, e.message);
  }

  checkExpressions(c, raw, []);

  c.errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.col ?? 0) - (b.col ?? 0));
  const fatal = c.errors.some((e) => !isWarning(e));
  return fatal ? { errors: c.errors } : { workflow: wf, errors: c.errors };
}
