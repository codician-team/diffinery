import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isWarning, parseWorkflow } from "@diffinery/workflow-yaml";
import { enc } from "../api.js";
import { list, repoPath, str, type Command, type Group } from "../cli.js";
import { gitCapture } from "../git.js";
import { CliError } from "../io.js";
import { json, table } from "../output.js";
import type { RepoJson } from "./repo.js";

export const WORKFLOW_DIRS = [".github/workflows", ".diffinery/workflows"];
const isYaml = (f: string) => /\.ya?ml$/i.test(f);

/** Parses -f key=value pairs into workflow_dispatch inputs. */
export function parseInputs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i <= 0) throw new CliError(`-f expects key=value, got "${p}"`, 2);
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

const run: Command = {
  name: "workflow run",
  summary: "Start a workflow_dispatch run",
  args: "<workflow-file>",
  description: "The workflow is matched by path (.github/workflows/deploy.yml) or file name (deploy.yml).",
  options: {
    ref: { type: "string", short: "r", desc: "Branch or tag to run on (default: the default branch)", arg: "REF" },
    field: { type: "string", short: "f", multiple: true, desc: "Input value", arg: "KEY=VALUE" },
  },
  repo: true,
  json: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, o, [file]) {
    const inputs = parseInputs(list(o, "field"));
    const repo = await ctx.repo();
    const api = await ctx.authedApi();
    const ref = str(o, "ref") ?? (await api.get<RepoJson>(repoPath(repo))).default_branch;
    const wf = file!.replace(/^\.\//, "");
    const r = await api.post<{ run_id: string; html_url: string }>(`${repoPath(repo)}/actions/workflows/${enc(wf)}/dispatches`, { ref, inputs });
    if (ctx.json) return json(ctx.io, r);
    ctx.out(`${ctx.c.green("✓")} Started run ${r.run_id} of ${wf} on ${ref}`);
    ctx.out(r.html_url);
    ctx.err(ctx.c.dim(`Follow it: diffinery run watch ${r.run_id} -R ${repo.owner}/${repo.name}`));
  },
};

const listCmd: Command = {
  name: "workflow list",
  summary: "List the repository's workflows",
  repo: true,
  json: true,
  maxArgs: 0,
  async run(ctx) {
    const repo = await ctx.repo();
    const res = await (await ctx.api()).get<{ workflows: Array<{ name: string; path: string; state: string; errors: string[]; triggers?: string[] }> }>(`${repoPath(repo)}/actions/workflows`);
    if (ctx.json) return json(ctx.io, res.workflows);
    if (!res.workflows.length) return ctx.err("No workflows.");
    const c = ctx.c;
    ctx.io.stdout.write(table(res.workflows.map((w) => [w.name, c.dim(w.path), w.state === "active" ? c.green(w.state) : c.red(w.state), c.dim((w.triggers ?? []).join(", "))])));
  },
};

async function collectFiles(cwd: string, root: string, args: string[]): Promise<string[]> {
  const out: string[] = [];
  const addDir = async (dir: string, explicit: boolean) => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (e) {
      if (!explicit && (e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new CliError(`cannot read ${dir}: ${(e as Error).message}`);
    }
    for (const f of entries.sort()) if (isYaml(f)) out.push(path.join(dir, f));
  };
  if (!args.length) {
    for (const d of WORKFLOW_DIRS) await addDir(path.join(root, d), false);
    return out;
  }
  for (const a of args) {
    const p = path.resolve(cwd, a);
    let s;
    try {
      s = await stat(p);
    } catch {
      throw new CliError(`no such file: ${a}`);
    }
    if (s.isDirectory()) await addDir(p, true);
    else out.push(p);
  }
  return out;
}

const validate: Command = {
  name: "workflow validate",
  summary: "Check workflow files for errors",
  args: "[files or directories...]",
  description: `Default: every .yml/.yaml file in .github/workflows and .diffinery/workflows of the
current repository. Uses the same parser as the server. Exits 1 when any file has errors.`,
  json: true,
  async run(ctx, _o, args) {
    const top = await gitCapture(ctx.io, ["rev-parse", "--show-toplevel"]);
    const root = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : ctx.io.cwd;
    const files = await collectFiles(ctx.io.cwd, root, args);
    if (!files.length) {
      if (ctx.json) return json(ctx.io, []);
      ctx.err(`No workflow files found in ${WORKFLOW_DIRS.join(" or ")}.`);
      return 0;
    }
    const c = ctx.c;
    const results = [];
    let errors = 0;
    let warnings = 0;
    for (const f of files) {
      const rel = path.relative(ctx.io.cwd, f) || f;
      const relRoot = path.relative(root, f).split(path.sep).join("/");
      const source = await readFile(f, "utf8");
      const res = parseWorkflow(source, relRoot.startsWith("..") ? rel : relRoot);
      const items = res.errors.map((e) => ({ ...e, severity: isWarning(e) ? "warning" : "error", message: isWarning(e) ? e.message.replace(/^warning:\s*/, "") : e.message }));
      results.push({ file: rel, valid: !items.some((i) => i.severity === "error"), problems: items });
      for (const i of items) {
        if (i.severity === "error") errors++;
        else warnings++;
        if (ctx.json) continue;
        const loc = `${rel}${i.line ? `:${i.line}${i.col ? `:${i.col}` : ""}` : ""}`;
        ctx.out(`${c.bold(loc)}: ${i.severity === "error" ? c.red("error") : c.yellow("warning")}: ${i.message}${i.path ? c.dim(` (${i.path})`) : ""}`);
      }
      if (!ctx.json && !items.length) ctx.out(`${c.green("✓")} ${rel}`);
    }
    if (ctx.json) json(ctx.io, results);
    else ctx.err(`${files.length} file${files.length === 1 ? "" : "s"} checked: ${errors ? c.red(`${errors} error${errors === 1 ? "" : "s"}`) : "no errors"}, ${warnings} warning${warnings === 1 ? "" : "s"}`);
    return errors ? 1 : 0;
  },
};

export const workflowGroup: Group = { name: "workflow", summary: "Run and validate workflows", commands: [run, listCmd, validate] };
