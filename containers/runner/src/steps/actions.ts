import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StepSpec } from "@diffinery/shared";
import { getBuiltin, makeBuiltinContext } from "../builtins/index.js";
import { errMsg, failure, StepFailure, type JobRunner, type Scope, type StepIO } from "../job.js";
import { exec, shellWords } from "../util.js";
import { parseYaml } from "../yaml.js";
import type { StepExec } from "./run.js";

export type UsesRef =
  | { kind: "docker"; image: string }
  | { kind: "local"; path: string }
  | { kind: "remote"; owner: string; repo: string; subpath: string; ref: string; name: string };

export function parseUses(uses: string): UsesRef {
  const u = uses.trim();
  if (u.startsWith("docker://")) return { kind: "docker", image: u.slice("docker://".length) };
  if (u.startsWith("./") || u.startsWith("../") || u === ".") return { kind: "local", path: u };
  const at = u.lastIndexOf("@");
  if (at <= 0) throw failure(`Expected format {owner}/{repo}[/path]@ref. Actual '${u}'`);
  const ref = u.slice(at + 1);
  const parts = u.slice(0, at).split("/");
  if (parts.length < 2 || !parts[0] || !parts[1] || !ref) throw failure(`Expected format {owner}/{repo}[/path]@ref. Actual '${u}'`);
  return { kind: "remote", owner: parts[0], repo: parts[1], subpath: parts.slice(2).join("/"), ref, name: parts.join("/") };
}

export interface ActionInput {
  description?: string;
  required?: boolean;
  default?: unknown;
  deprecationMessage?: string;
}

export interface ActionMeta {
  name?: string;
  inputs?: Record<string, ActionInput | null>;
  outputs?: Record<string, { description?: string; value?: string } | null>;
  runs: {
    using: string;
    main?: string;
    pre?: string;
    "pre-if"?: string;
    post?: string;
    "post-if"?: string;
    steps?: StepSpec[];
    image?: string;
    env?: Record<string, string>;
    entrypoint?: string;
    args?: unknown[];
    "pre-entrypoint"?: string;
    "post-entrypoint"?: string;
  };
}

export async function loadActionMeta(dir: string): Promise<ActionMeta> {
  for (const f of ["action.yml", "action.yaml"]) {
    const p = path.join(dir, f);
    if (existsSync(p)) {
      const meta = parseYaml(await readFile(p, "utf8")) as ActionMeta | null;
      if (!meta || typeof meta !== "object" || !meta.runs || typeof meta.runs !== "object") {
        throw failure(`Invalid action metadata in ${p}: missing 'runs'`);
      }
      return meta;
    }
  }
  if (existsSync(path.join(dir, "Dockerfile"))) return { runs: { using: "docker", image: "Dockerfile" } };
  throw failure(`Can't find 'action.yml' or 'action.yaml' under '${dir}'. Did you forget to run actions/checkout before running your local action?`);
}

/** Downloads `owner/repo@ref` into the action cache and returns its root dir. */
export async function downloadAction(job: JobRunner, io: StepIO, owner: string, repo: string, ref: string): Promise<string> {
  const dest = path.join(job.actionsDir, owner, repo, ref);
  if (existsSync(path.join(dest, ".diffinery-complete"))) return dest;
  const tpl = process.env.DIFFINERY_ACTIONS_DOWNLOAD_URL ?? "https://codeload.github.com/{owner}/{repo}/tar.gz/{ref}";
  const url = tpl.replace("{owner}", owner).replace("{repo}", repo).replace("{ref}", encodeURIComponent(ref));
  job.logger.line(io.logIndex, `Download action repository '${owner}/${repo}@${ref}'`);
  const headers: Record<string, string> = { "user-agent": "diffinery-runner" };
  const ghToken = GITHUB_TOKEN;
  if (ghToken && url.startsWith("https://codeload.github.com/")) headers.authorization = `token ${ghToken}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    try {
      const res = await fetch(url, { headers, redirect: "follow" });
      if (res.status === 404) throw failure(`Unable to resolve action '${owner}/${repo}@${ref}', repository or version not found`);
      if (res.status === 401 || res.status === 403) {
        lastErr = new Error(`HTTP ${res.status} downloading ${url}`);
        break;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
      await mkdir(tmp, { recursive: true });
      const tarFile = `${tmp}.tar.gz`;
      await writeFile(tarFile, buf);
      const r = await exec("tar", ["-xzf", tarFile, "-C", tmp, "--strip-components=1"], { capture: true });
      await rm(tarFile, { force: true });
      if (r.exitCode !== 0) throw new Error(`Failed to extract action archive: ${r.stderr.trim()}`);
      await rm(dest, { recursive: true, force: true });
      await mkdir(path.dirname(dest), { recursive: true });
      await rename(tmp, dest);
      await writeFile(path.join(dest, ".diffinery-complete"), "");
      return dest;
    } catch (e) {
      if (e instanceof StepFailure) throw e;
      lastErr = e;
    }
  }
  // The tarball endpoint can be unreachable (proxies, rate limits) while git still works.
  if (!process.env.DIFFINERY_ACTIONS_DOWNLOAD_URL && (await cloneAction(dest, owner, repo, ref, ghToken))) return dest;
  throw failure(`Failed to download action '${owner}/${repo}@${ref}': ${errMsg(lastErr)}`);
}

/** Fetches `owner/repo@ref` (branch, tag or commit SHA) from github.com with git; false when that fails. */
async function cloneAction(dest: string, owner: string, repo: string, ref: string, token: string | undefined): Promise<boolean> {
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || ref.startsWith("-") || /[\s\\]|\.\.|[~^:?*[]/.test(ref)) return false;
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  // The header goes through the environment, not argv, where other processes could read it.
  const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const auth: Record<string, string> = token
    ? { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: "http.https://github.com/.extraheader", [`GIT_CONFIG_VALUE_${n}`]: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` }
    : {};
  const git = (args: string[]) => exec("git", args, { cwd: tmp, capture: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...auth } });
  try {
    await mkdir(tmp, { recursive: true });
    for (const args of [["init", "-q"], ["fetch", "-q", "--depth", "1", `https://github.com/${owner}/${repo}`, ref], ["checkout", "-q", "FETCH_HEAD"]]) {
      if ((await git(args)).exitCode !== 0) throw new Error(args[0]);
    }
    await rm(path.join(tmp, ".git"), { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(tmp, dest);
    await writeFile(path.join(dest, ".diffinery-complete"), "");
    return true;
  } catch {
    await rm(tmp, { recursive: true, force: true });
    return false;
  }
}

export function inputEnvName(name: string): string {
  return `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
}

/** Evaluates `with:` plus defaults from action.yml. */
export function computeInputs(job: JobRunner, x: StepExec, meta: ActionMeta | null): Record<string, string> {
  const inputs: Record<string, string> = {};
  const given = new Map<string, string>();
  for (const [k, v] of Object.entries(x.step.with ?? {})) {
    given.set(k.toLowerCase(), job.interp(v === null || v === undefined ? "" : String(v), x.ctx, x.scope));
    inputs[k] = given.get(k.toLowerCase())!;
  }
  for (const [k, def] of Object.entries(meta?.inputs ?? {})) {
    if (given.has(k.toLowerCase())) {
      // normalise the key to the declared spelling
      const actual = Object.keys(inputs).find((x) => x.toLowerCase() === k.toLowerCase())!;
      if (actual !== k) {
        inputs[k] = inputs[actual]!;
        delete inputs[actual];
      }
      if (def?.deprecationMessage) job.logger.line(x.io.logIndex, `##[warning]Input '${k}' has been deprecated with message: ${def.deprecationMessage}`);
      continue;
    }
    if (def && def.default !== undefined && def.default !== null) {
      inputs[k] = job.interp(String(def.default), x.ctx, x.scope);
    } else if (def?.required) {
      job.logger.line(x.io.logIndex, `##[warning]Input required and not supplied: ${k}`);
    }
  }
  return inputs;
}

export async function runAction(job: JobRunner, x: StepExec): Promise<void> {
  const uses = job.interp(String(x.step.uses), x.ctx, x.scope);
  const ref = parseUses(uses);
  if (ref.kind === "docker") {
    // `uses: docker://image`: `with.args` and `with.entrypoint` drive the container; the rest become INPUT_*.
    const given = computeInputs(job, x, null);
    const inputs: Record<string, string> = {};
    let args: string[] = [];
    let entrypoint: string | undefined;
    for (const [k, v] of Object.entries(given)) {
      if (k.toLowerCase() === "args") args = shellWords(v);
      else if (k.toLowerCase() === "entrypoint") entrypoint = v || undefined;
      else inputs[k] = v;
    }
    logActionHeader(job, x.io, uses, given);
    await runDockerAction(job, x, { image: `docker://${ref.image}`, dir: null, args, entrypoint, env: {}, inputs, action: { path: "", repository: "", ref: "" } });
    return;
  }

  if (ref.kind === "remote") {
    const given = computeInputs(job, x, null);
    const builtin = getBuiltin(ref.name, ref.ref, given, x.envCtx);
    if (builtin) {
      const inputs = given;
      logActionHeader(job, x.io, uses, inputs);
      const c = makeBuiltinContext(job, x, inputs, uses);
      await builtin(c);
      return;
    }
  }

  let dir: string;
  let repository: string;
  let actionRef: string;
  if (ref.kind === "local") {
    dir = path.resolve(job.workspace, ref.path);
    repository = "";
    actionRef = "";
  } else {
    const root = await downloadAction(job, x.io, ref.owner, ref.repo, ref.ref);
    dir = ref.subpath ? path.join(root, ref.subpath) : root;
    repository = `${ref.owner}/${ref.repo}`;
    actionRef = ref.ref;
  }
  const meta = await loadActionMeta(dir);
  const using = String(meta.runs.using ?? "").toLowerCase();
  const inputs = computeInputs(job, x, meta);
  logActionHeader(job, x.io, uses, inputs);
  const actionInfo = { path: dir, repository, ref: actionRef };

  if (using === "docker" || meta.runs.image) {
    const runs = meta.runs;
    if (!runs.image) throw failure(`Action '${uses}' uses Docker but has no 'runs.image'`);
    const actx = job.contexts({ ...x.scope, inputs }, x.envCtx);
    const ev = (v: unknown) => job.interp(v === undefined || v === null ? "" : String(v), actx, x.scope);
    const args = Array.isArray(runs.args) ? runs.args.map(ev) : [];
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(runs.env ?? {})) env[k] = ev(v);
    await runDockerAction(job, x, {
      image: runs.image,
      dir,
      args,
      entrypoint: runs.entrypoint ? ev(runs.entrypoint) : undefined,
      pre: runs["pre-entrypoint"] ? ev(runs["pre-entrypoint"]) : undefined,
      post: runs["post-entrypoint"] ? ev(runs["post-entrypoint"]) : undefined,
      preIf: runs["pre-if"],
      postIf: runs["post-if"],
      env,
      inputs,
      action: actionInfo,
    });
    return;
  }
  if (using === "composite") {
    await runComposite(job, x, meta, inputs, actionInfo);
    return;
  }
  if (/^node\d+$/.test(using)) {
    await runNodeAction(job, x, meta, inputs, actionInfo);
    return;
  }
  throw failure(`Unsupported action runtime 'runs.using: ${meta.runs.using}' in ${uses}`);
}

function logActionHeader(job: JobRunner, io: StepIO, uses: string, inputs: Record<string, string>): void {
  job.logger.line(io.logIndex, `##[group]Run ${uses}`);
  const keys = Object.keys(inputs);
  if (keys.length) {
    job.logger.line(io.logIndex, "with:");
    for (const k of keys) job.logger.line(io.logIndex, `  ${k}: ${inputs[k]!.split("\n").join("\n    ")}`);
  }
  job.logger.line(io.logIndex, "##[endgroup]");
}

async function runNodeAction(
  job: JobRunner,
  x: StepExec,
  meta: ActionMeta,
  inputs: Record<string, string>,
  action: { path: string; repository: string; ref: string },
): Promise<void> {
  const runs = meta.runs;
  if (!runs.main) throw failure(`Action '${x.step.uses}' has no 'runs.main'`);
  const inputEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs)) inputEnv[inputEnvName(k)] = v;
  const baseExtra: Record<string, string> = {
    ...job.runtimeEnv,
    ...inputEnv,
    GITHUB_ACTION: x.step.id ?? "__" + (action.repository || "local").replace(/[^A-Za-z0-9]/g, "_"),
    GITHUB_ACTION_PATH: action.path,
    GITHUB_ACTION_REPOSITORY: action.repository,
    GITHUB_ACTION_REF: action.ref,
  };
  // @actions/artifact refuses to run on anything that looks like GitHub Enterprise Server
  // (any GITHUB_SERVER_URL but github.com), so the artifact actions see github.com; their
  // API calls still go to GITHUB_API_URL and the runtime services, and the URLs they
  // output are pointed back at this server.
  const serverUrl = job.processEnv(x.envCtx).GITHUB_SERVER_URL ?? "";
  const artifactAction = ARTIFACT_ACTIONS.has(action.repository.toLowerCase());
  if (artifactAction) baseExtra.GITHUB_SERVER_URL = "https://github.com";
  const state: Record<string, string> = {};
  const runScriptFile = async (file: string, io: StepIO, envCtx: Record<string, string>, extra: Record<string, string>, label: string) => {
    const res = await job.runStepProcess([job.nodePath(), path.join(action.path, file)], {
      cwd: job.workspace,
      envCtx,
      io,
      timeoutMs: x.timeoutMs,
      extraEnv: extra,
      wrap: job.containerWrap(),
    });
    if (job.isStopping) return;
    if (res.timedOut) throw failure(io.reason ?? "The step timed out.", true);
    if (res.exitCode !== 0) {
      const msg = `${label}: Process completed with exit code ${res.exitCode}.`;
      job.logger.line(io.logIndex, `##[error]${msg}`);
      job.addAnnotation(io.logIndex, { level: "error", message: msg });
      io.reason = msg;
      throw failure(msg, true);
    }
  };

  const ctxScope = x.scope;
  if (runs.pre) {
    const cond = runs["pre-if"] ?? "always()";
    let ok = true;
    try {
      ok = job.evalIf(cond, x.ctx, ctxScope);
    } catch (e) {
      throw failure(`Error evaluating pre-if: ${errMsg(e)}`);
    }
    if (ok) {
      const preIo: StepIO = { logIndex: x.io.logIndex, outputs: {}, state: {} };
      job.logger.line(x.io.logIndex, `Running pre: ${runs.pre}`);
      await runScriptFile(runs.pre, preIo, x.envCtx, baseExtra, "pre");
      Object.assign(state, preIo.state);
    }
  }
  if (runs.post) {
    const postFile = runs.post;
    const envAtMain = { ...x.envCtx };
    job.registerPost({
      name: `Post ${x.name}`,
      condition: runs["post-if"] ?? "always()",
      run: async (logIndex) => {
        const stateEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(state)) stateEnv[`STATE_${k}`] = v;
        const postIo: StepIO = { logIndex, outputs: {}, state: {} };
        await runScriptFile(postFile, postIo, { ...envAtMain, ...job.envAccum }, { ...baseExtra, ...stateEnv }, "post");
      },
    });
  }
  const mainIo = x.io;
  try {
    await runScriptFile(runs.main, mainIo, x.envCtx, { ...baseExtra, ...stateEnvOf(state) }, "main");
  } finally {
    Object.assign(state, mainIo.state);
    const url = mainIo.outputs["artifact-url"];
    if (artifactAction && serverUrl && url?.startsWith("https://github.com/")) mainIo.outputs["artifact-url"] = `${serverUrl}/${url.slice("https://github.com/".length)}`;
  }
}

const ARTIFACT_ACTIONS = new Set(["actions/upload-artifact", "actions/download-artifact"]);

/**
 * The operator's github.com token for downloading actions (rate limits, private
 * actions), read once when the runner starts. Steps never see it: job.ts strips
 * it from every child environment.
 */
const GITHUB_TOKEN = process.env.DIFFINERY_GITHUB_TOKEN || undefined;

/** Docker container actions: `uses: docker://image`, or an action with `runs.using: docker`. */
async function runDockerAction(
  job: JobRunner,
  x: StepExec,
  d: {
    image: string;
    dir: string | null;
    args: string[];
    entrypoint?: string;
    pre?: string;
    post?: string;
    preIf?: string;
    postIf?: string;
    env: Record<string, string>;
    inputs: Record<string, string>;
    action: { path: string; repository: string; ref: string };
  },
): Promise<void> {
  const image = await job.docker.prepareAction(x.io, d.image, d.dir);
  const extra: Record<string, string> = {
    ...job.runtimeEnv,
    GITHUB_ACTION: x.step.id ?? "__" + (d.action.repository || "docker").replace(/[^A-Za-z0-9]/g, "_"),
    GITHUB_ACTION_REPOSITORY: d.action.repository,
    GITHUB_ACTION_REF: d.action.ref,
  };
  for (const [k, v] of Object.entries(d.inputs)) extra[inputEnvName(k)] = v;
  const runIn = async (io: StepIO, envCtx: Record<string, string>, o: { entrypoint?: string; args: string[] }, label: string) => {
    const wrap = await job.docker.runWrap(io, image, o);
    const res = await job.runStepProcess([], { cwd: job.workspace, envCtx: { ...envCtx, ...d.env }, io, timeoutMs: x.timeoutMs, extraEnv: extra, wrap });
    if (job.isStopping) return;
    if (res.timedOut) throw failure(io.reason ?? "The step timed out.", true);
    if (res.exitCode !== 0) {
      const msg = `${label}Docker run failed with exit code ${res.exitCode}`;
      job.logger.line(io.logIndex, `##[error]${msg}`);
      job.addAnnotation(io.logIndex, { level: "error", message: msg });
      io.reason = msg;
      throw failure(msg, true);
    }
  };
  if (d.pre) {
    let ok = true;
    try {
      ok = job.evalIf(d.preIf ?? "always()", x.ctx, x.scope);
    } catch (e) {
      throw failure(`Error evaluating pre-if: ${errMsg(e)}`);
    }
    if (ok) await runIn({ logIndex: x.io.logIndex, outputs: {}, state: {} }, x.envCtx, { entrypoint: d.pre, args: [] }, "pre: ");
  }
  if (d.post) {
    const post = d.post;
    const envAtMain = { ...x.envCtx };
    job.registerPost({
      name: `Post ${x.name}`,
      condition: d.postIf ?? "always()",
      run: async (logIndex) => runIn({ logIndex, outputs: {}, state: {} }, { ...envAtMain, ...job.envAccum }, { entrypoint: post, args: [] }, "post: "),
    });
  }
  await runIn(x.io, x.envCtx, { entrypoint: d.entrypoint, args: d.args }, "");
}

function stateEnvOf(state: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(state)) out[`STATE_${k}`] = v;
  return out;
}

async function runComposite(
  job: JobRunner,
  x: StepExec,
  meta: ActionMeta,
  inputs: Record<string, string>,
  action: { path: string; repository: string; ref: string },
): Promise<void> {
  if (x.scope.depth > 9) throw failure("Composite action nesting is too deep (max 10).");
  const steps = Array.isArray(meta.runs.steps) ? meta.runs.steps : [];
  const scope: Scope = {
    steps: {},
    inputs,
    failed: false,
    inheritedEnv: { ...x.envCtx },
    composite: true,
    action,
    depth: x.scope.depth + 1,
  };
  for (const s of steps) {
    if (job.isStopping) break;
    const sub = normaliseStep(s);
    await job.executeStep(sub, scope, x.io.logIndex);
  }
  // outputs
  const ctx = job.contexts(scope, job.baseEnvContext(scope));
  for (const [k, o] of Object.entries(meta.outputs ?? {})) {
    if (!o || o.value === undefined || o.value === null) continue;
    try {
      x.io.outputs[k] = job.interp(String(o.value), ctx, scope);
    } catch (e) {
      job.logger.line(x.io.logIndex, `##[warning]Failed to evaluate output '${k}': ${errMsg(e)}`);
    }
  }
  if (job.isStopping) return;
  if (scope.failed) throw failure(`Composite action '${x.step.uses}' failed.`, true);
}

function normaliseStep(s: unknown): StepSpec {
  const o = (s ?? {}) as Record<string, unknown>;
  const step: StepSpec = {};
  if (o.id !== undefined) step.id = String(o.id);
  if (o.name !== undefined) step.name = String(o.name);
  if (o.if !== undefined && o.if !== null) step.if = typeof o.if === "boolean" ? String(o.if) : String(o.if);
  if (o.run !== undefined) step.run = String(o.run);
  if (o.uses !== undefined) step.uses = String(o.uses);
  if (o.shell !== undefined) step.shell = String(o.shell);
  if (o["working-directory"] !== undefined) step["working-directory"] = String(o["working-directory"]);
  if (o["continue-on-error"] !== undefined) step["continue-on-error"] = o["continue-on-error"] as boolean | string;
  if (o["timeout-minutes"] !== undefined) step["timeout-minutes"] = Number(o["timeout-minutes"]);
  const strMap = (m: unknown) => {
    const r: Record<string, string> = {};
    if (m && typeof m === "object") for (const [k, v] of Object.entries(m)) r[k] = v === null || v === undefined ? "" : String(v);
    return r;
  };
  if (o.with) step.with = strMap(o.with);
  if (o.env) step.env = strMap(o.env);
  return step;
}
