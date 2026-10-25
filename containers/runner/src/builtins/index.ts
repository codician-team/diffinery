import { failure, type JobRunner, type Scope, type StepIO } from "../job.js";
import type { Readable } from "node:stream";
import type { StepExec } from "../steps/run.js";
import type { ExecResult } from "../util.js";
import { artifactDownload, artifactUpload } from "./artifacts.js";
import { cacheAction, cacheRestoreAction, cacheSaveAction } from "./cache.js";
import { checkout } from "./checkout.js";
import { setupGo } from "./setup-go.js";
import { setupNode } from "./setup-node.js";
import { setupPython } from "./setup-python.js";

export interface BuiltinContext {
  job: JobRunner;
  io: StepIO;
  scope: Scope;
  ctx: Record<string, unknown>;
  envCtx: Record<string, string>;
  uses: string;
  name: string;
  /** Raw `with:` values (already interpolated); lookups are case-insensitive. */
  inputs: Record<string, string>;
  input(name: string, dflt?: string): string;
  log(msg: string): void;
  warn(msg: string): void;
  setOutput(name: string, value: string): void;
  exportVariable(name: string, value: string): void;
  addPath(dir: string): void;
  /** Env for child tools (job env + GITHUB_ENV + PATH additions). */
  toolEnv(extra?: Record<string, string>): NodeJS.ProcessEnv;
  exec(cmd: string, args: string[], o?: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean; silent?: boolean; input?: string | Readable }): Promise<ExecResult>;
  /** Like exec but throws on non-zero exit. */
  run(cmd: string, args: string[], o?: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean; silent?: boolean; input?: string | Readable }): Promise<ExecResult>;
  registerPost(name: string, condition: string, fn: (c: BuiltinContext) => Promise<void>): void;
}

export type Builtin = (c: BuiltinContext) => Promise<void>;

interface BuiltinDef {
  run: Builtin;
  /** Major versions (`@vN`) the built-in mirrors; other refs (SHAs, branches, newer majors) run the real action. */
  majors: [number, number];
  /** The `with:` inputs it understands; anything else runs the real action. */
  inputs: string[];
  /** Further input values it cannot handle (the real action runs instead). */
  supports?: (inputs: Map<string, string>) => boolean;
}

const hostArch = (v: string | undefined) => !v || v.toLowerCase() === (process.arch === "arm64" ? "arm64" : "x64");
const CACHE_INPUTS = ["key", "path", "restore-keys", "upload-chunk-size", "enablecrossosarchive", "fail-on-cache-miss", "lookup-only", "save-always"];

/**
 * Actions the runner implements itself because that is much faster than
 * downloading and starting them. Each mirrors the official action's inputs,
 * outputs and storage (the same cache and artifact services), and steps
 * aside for the real action when it sees a ref or input it does not mirror.
 */
const BUILTINS: Record<string, BuiltinDef> = {
  "actions/checkout": {
    run: checkout,
    majors: [2, 6],
    inputs: ["repository", "ref", "token", "ssh-key", "ssh-known-hosts", "ssh-strict", "ssh-user", "persist-credentials", "path", "clean", "filter", "sparse-checkout", "sparse-checkout-cone-mode", "fetch-depth", "fetch-tags", "show-progress", "lfs", "submodules", "set-safe-directory", "github-server-url"],
    supports: (i) => !i.get("ssh-key"),
  },
  "actions/cache": { run: cacheAction, majors: [3, 6], inputs: CACHE_INPUTS },
  "actions/cache/restore": { run: cacheRestoreAction, majors: [3, 6], inputs: CACHE_INPUTS },
  "actions/cache/save": { run: cacheSaveAction, majors: [3, 6], inputs: CACHE_INPUTS },
  "actions/upload-artifact": { run: artifactUpload, majors: [4, 7], inputs: ["name", "path", "if-no-files-found", "retention-days", "compression-level", "overwrite", "include-hidden-files", "archive"] },
  "actions/download-artifact": { run: artifactDownload, majors: [4, 8], inputs: ["name", "path", "pattern", "merge-multiple", "github-token", "repository", "run-id", "artifact-ids", "skip-decompress", "digest-mismatch"] },
  "actions/setup-node": {
    run: setupNode,
    majors: [3, 7],
    inputs: ["node-version", "node-version-file", "architecture", "check-latest", "registry-url", "scope", "token", "cache", "cache-dependency-path", "always-auth", "package-manager-cache"],
    supports: (i) => hostArch(i.get("architecture")) && ["", "npm", "pnpm", "yarn"].includes((i.get("cache") ?? "").toLowerCase()),
  },
  "actions/setup-python": {
    run: setupPython,
    majors: [4, 6],
    inputs: ["python-version", "python-version-file", "cache", "architecture", "check-latest", "token", "cache-dependency-path", "update-environment", "allow-prereleases"],
    supports: (i) =>
      hostArch(i.get("architecture")) &&
      !/^(pypy|graalpy)/i.test(i.get("python-version") ?? "") &&
      ["", "pip", "pipenv"].includes((i.get("cache") ?? "").toLowerCase()) &&
      (i.get("update-environment") ?? "true").toLowerCase() !== "false",
  },
  "actions/setup-go": { run: setupGo, majors: [4, 6], inputs: ["go-version", "go-version-file", "check-latest", "token", "cache", "cache-dependency-path", "architecture"], supports: (i) => hostArch(i.get("architecture")) },
};

const OFF = /^(0|false|no|off)$/i;

/**
 * The built-in for `name@ref` with these `with:` inputs, or null to run the
 * real action. `DIFFINERY_BUILTINS: false` in a workflow, job or step `env:`
 * (or DIFFINERY_DISABLE_BUILTINS=1 on the runner) always runs the real action.
 */
export function getBuiltin(name: string, ref: string, inputs: Record<string, string> = {}, env: Record<string, string> = {}): Builtin | null {
  if (process.env.DIFFINERY_DISABLE_BUILTINS === "1" || OFF.test(env.DIFFINERY_BUILTINS ?? "")) return null;
  const def = BUILTINS[name.toLowerCase()];
  const m = /^v(\d+)(\.\d+){0,2}$/.exec(ref);
  if (!def || !m || Number(m[1]) < def.majors[0] || Number(m[1]) > def.majors[1]) return null;
  const given = new Map(Object.entries(inputs).map(([k, v]) => [k.toLowerCase(), v]));
  if ([...given.keys()].some((k) => !def.inputs.includes(k))) return null;
  if (def.supports && !def.supports(given)) return null;
  return def.run;
}

export function makeBuiltinContext(job: JobRunner, x: StepExec, inputs: Record<string, string>, uses: string): BuiltinContext {
  const lower = new Map(Object.entries(inputs).map(([k, v]) => [k.toLowerCase(), v]));
  const make = (io: StepIO, envCtx: Record<string, string>, name: string): BuiltinContext => {
    const toolEnv = (extra: Record<string, string> = {}) => job.processEnv({ ...envCtx, ...job.envAccum }, extra);
    const c: BuiltinContext = {
      job,
      io,
      scope: x.scope,
      ctx: x.ctx,
      envCtx,
      uses,
      name,
      inputs,
      input: (n, d = "") => {
        const v = lower.get(n.toLowerCase());
        return v === undefined || v === "" ? d : v;
      },
      log: (m) => job.logger.line(io.logIndex, m),
      warn: (m) => {
        job.logger.line(io.logIndex, `##[warning]${m}`);
        job.addAnnotation(io.logIndex, { level: "warning", message: m });
      },
      setOutput: (k, v) => {
        io.outputs[k] = v;
      },
      exportVariable: (k, v) => {
        job.envAccum[k] = v;
        envCtx[k] = v;
      },
      addPath: (d) => job.addPath(d),
      toolEnv,
      exec: (cmd, args, o = {}) => job.tool(cmd, args, { io, cwd: o.cwd, env: o.env ?? toolEnv(), capture: o.capture, silent: o.silent, input: o.input }),
      run: async (cmd, args, o = {}) => {
        const r = await c.exec(cmd, args, { ...o, capture: o.capture ?? true });
        if (job.isStopping) throw failure("cancelled");
        if (r.exitCode !== 0) {
          const detail = o.silent ? ` ${r.stderr.trim().split("\n").slice(-5).join("\n")}` : "";
          throw failure(`The process '${cmd}' failed with exit code ${r.exitCode}${detail ? ":" + detail : ""}`);
        }
        return r;
      },
      registerPost: (pname, condition, fn) => {
        job.registerPost({
          name: pname,
          condition,
          run: async (logIndex) => {
            const pio: StepIO = { logIndex, outputs: {}, state: {} };
            await fn(make(pio, { ...envCtx, ...job.envAccum }, pname));
          },
        });
      },
    };
    return c;
  };
  return make(x.io, x.envCtx, x.name);
}
