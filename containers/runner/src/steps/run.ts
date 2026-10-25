import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { StepSpec } from "@diffinery/shared";
import { failure, type JobRunner, type Scope, type StepIO } from "../job.js";
import { shellWords, which } from "../util.js";

export interface StepExec {
  step: StepSpec;
  scope: Scope;
  ctx: Record<string, unknown>;
  envCtx: Record<string, string>;
  io: StepIO;
  timeoutMs: number;
  name: string;
}

interface ShellPlan {
  argv: string[];
  ext: string;
}

/**
 * Resolves a `shell:` value to an argv (with `{0}` replaced by the script path).
 * `has` says whether a command exists (on the runner, or in the job container).
 */
export function resolveShell(shell: string | undefined, scriptPath: string, pathEnv: string | undefined, has: (cmd: string) => boolean = (c) => !!which(c, pathEnv)): ShellPlan {
  const s = (shell ?? "").trim();
  const sub = (tpl: string, ext: string): ShellPlan => {
    const words = shellWords(tpl).map((w) => w.split("{0}").join(scriptPath));
    return { argv: words, ext };
  };
  if (s === "" ) {
    if (has("bash")) return sub("bash --noprofile --norc -eo pipefail {0}", ".sh");
    return sub("sh -e {0}", ".sh");
  }
  switch (s) {
    case "bash":
      return sub("bash --noprofile --norc -eo pipefail {0}", ".sh");
    case "sh":
      return sub("sh -e {0}", ".sh");
    case "python": {
      const py = has("python") ? "python" : "python3";
      return sub(`${py} {0}`, ".py");
    }
    case "pwsh":
      return sub(`pwsh -command ". '{0}'"`, ".ps1");
    case "powershell":
      return sub(`${has("powershell") ? "powershell" : "pwsh"} -command ". '{0}'"`, ".ps1");
    case "cmd":
      throw failure("The `cmd` shell is not supported on Linux runners.");
  }
  if (!s.includes("{0}")) {
    throw failure(`Invalid shell option '${s}'. Shell must be a valid built-in (bash, sh, python, pwsh) or a format string containing '{0}'`);
  }
  const first = shellWords(s)[0] ?? "";
  const ext = /python/.test(first) ? ".py" : /pwsh|powershell/.test(first) ? ".ps1" : /node/.test(first) ? ".js" : ".sh";
  return sub(s, ext);
}

export function resolveWorkingDirectory(job: JobRunner, wd: string | undefined): string {
  if (!wd) return job.workspace;
  return path.isAbsolute(wd) ? wd : path.join(job.workspace, wd);
}

export async function runScript(job: JobRunner, x: StepExec): Promise<void> {
  const { step, scope, ctx, envCtx, io } = x;
  const script = job.interp(String(step.run ?? ""), ctx, scope);
  const defaults = scope.composite ? undefined : job.spec.defaults?.run;
  const shellRaw = step.shell ?? defaults?.shell;
  const shell = shellRaw ? job.interp(String(shellRaw), ctx, scope) : undefined;
  const wdRaw = step["working-directory"] ?? defaults?.["working-directory"];
  const wd = resolveWorkingDirectory(job, wdRaw ? job.interp(String(wdRaw), ctx, scope) : undefined);

  // Log a GitHub-like header
  const lines = script.replace(/\n$/, "").split("\n");
  job.logger.line(io.logIndex, `##[group]Run ${lines[0] ?? ""}`);
  for (const l of lines.slice(1)) job.logger.line(io.logIndex, l);
  const shown = { ...(step.env ?? {}) };
  const envKeys = Object.keys(shown);
  if (shell) job.logger.line(io.logIndex, `shell: ${shell}`);
  if (envKeys.length) {
    job.logger.line(io.logIndex, "env:");
    for (const k of envKeys) job.logger.line(io.logIndex, `  ${k}: ${envCtx[k] ?? ""}`);
  }
  job.logger.line(io.logIndex, "##[endgroup]");

  const tmpBase = path.join(job.tempDir, randomUUID());
  const pathEnv = job.processEnv(envCtx).PATH;
  const container = job.docker.container;
  // In a job container, only the probed shells are known; anything else is left to the container to resolve.
  const has = container ? (c: string) => container.tools.has(c) : (c: string) => !!which(c, pathEnv);
  const probe = resolveShell(shell, tmpBase, pathEnv, has);
  const scriptPath = tmpBase + probe.ext;
  const plan = resolveShell(shell, scriptPath, pathEnv, has);
  let content = script;
  if (probe.ext === ".ps1") {
    content = `$ErrorActionPreference = 'stop'\n${script}\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }\n`;
  }
  await writeFile(scriptPath, content, { mode: 0o755 });
  const known = container ? !container.tools.size || container.tools.has(plan.argv[0]!) || !["bash", "sh", "python", "python3", "pwsh", "powershell"].includes(plan.argv[0]!) : !!which(plan.argv[0]!, pathEnv);
  if (!known) {
    throw failure(`${plan.argv[0]}: command not found. The shell '${shell ?? "bash"}' is not available ${container ? "in the job container" : "on this runner"}.`);
  }
  const extraEnv: Record<string, string> = { GITHUB_ACTION: step.id ?? "__run" };
  if (scope.action) {
    extraEnv.GITHUB_ACTION_PATH = scope.action.path;
    extraEnv.GITHUB_ACTION_REPOSITORY = scope.action.repository;
    extraEnv.GITHUB_ACTION_REF = scope.action.ref;
  }
  const res = await job.runStepProcess(plan.argv, { cwd: wd, envCtx, io, timeoutMs: x.timeoutMs, extraEnv, wrap: job.containerWrap() });
  if (job.isStopping) return;
  if (res.timedOut) throw failure(io.reason ?? "The step timed out.", true);
  if (res.exitCode !== 0) {
    const msg = `Process completed with exit code ${res.exitCode}.`;
    job.logger.line(io.logIndex, `##[error]${msg}`);
    job.addAnnotation(io.logIndex, { level: "error", message: msg });
    io.reason = msg;
    throw failure(msg, true);
  }
}
