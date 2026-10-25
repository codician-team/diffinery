import type { Job, Workflow } from "@diffinery/workflow-yaml";

/**
 * Reusable workflows (`jobs.<id>.uses`), GitHub-compatible.
 *
 * A run's workflow is flattened before it is planned: a caller job `deploy` that
 * uses a workflow with jobs `build` and `ship` becomes the jobs `deploy/build`
 * and `deploy/ship`. Inner `needs` are prefixed; inner jobs without `needs`
 * wait for whatever the caller job needs; jobs that need `deploy` wait for every
 * job inside it. Calls nest up to four levels deep, like on GitHub.
 */

/** Where a workflow file came from: this repository (repoId null) or another one, at a commit. */
export type Source = { repoId: string | null; sha: string };

export type CallSite = {
  /** Full key of the caller job, e.g. "deploy" or "deploy/release". */
  key: string;
  /** Enclosing call, or null for a top-level caller job. */
  parent: string | null;
  /** The caller job: uses, with, secrets, if, name. */
  job: Job;
  /** The called workflow. */
  workflow: Workflow;
  /** The caller's own `needs`, as full keys in the parent scope. */
  needs: string[];
};

export type Expanded = {
  /** The run's workflow with only runnable jobs, keyed by full key, `needs` expanded for ordering. */
  workflow: Workflow;
  calls: Map<string, CallSite>;
  /** Full key → the call it belongs to (null at top level). Covers jobs and calls. */
  parentOf: Map<string, string | null>;
  /** Declared `needs` per job or call, as full keys (a call stays a call). */
  needs: Map<string, string[]>;
  /** The workflow each runnable job is defined in (env, defaults, permissions). */
  workflowOf: Map<string, Workflow>;
};

export type Loader = (uses: string, from: Source) => Promise<{ workflow: Workflow; source: Source }>;

export const MAX_CALL_DEPTH = 4;
export const MAX_CALLED_WORKFLOWS = 20;

export class ReusableError extends Error {}

/** Short key inside the call that defines it ("deploy/build" → "build"). */
export const localKey = (full: string, parent: string | null): string => (parent ? full.slice(parent.length + 1) : full);

export async function expandReusable(root: Workflow, rootSource: Source, load: Loader): Promise<Expanded> {
  const calls = new Map<string, CallSite>();
  const parentOf = new Map<string, string | null>();
  const needs = new Map<string, string[]>();
  const workflowOf = new Map<string, Workflow>();
  const leaves: Record<string, Job> = {};
  let called = 0;

  const walk = async (wf: Workflow, source: Source, prefix: string | null, depth: number, inherited: string[]): Promise<void> => {
    for (const [key, job] of Object.entries(wf.jobs)) {
      const full = prefix ? `${prefix}/${key}` : key;
      const declared = job.needs.map((n) => (prefix ? `${prefix}/${n}` : n));
      const ordering = job.needs.length ? declared : inherited;
      parentOf.set(full, prefix);
      needs.set(full, declared);
      if (!job.uses) {
        leaves[full] = { ...job, key: full, needs: ordering };
        workflowOf.set(full, wf);
        continue;
      }
      if (depth >= MAX_CALL_DEPTH) throw new ReusableError(`jobs.${full}: reusable workflows can be nested at most ${MAX_CALL_DEPTH} levels deep`);
      if (++called > MAX_CALLED_WORKFLOWS) throw new ReusableError(`a run can call at most ${MAX_CALLED_WORKFLOWS} reusable workflows`);
      if (job.strategy?.matrix !== undefined) throw new ReusableError(`jobs.${full}: a matrix on a job that calls a reusable workflow is not supported yet`);
      let target: { workflow: Workflow; source: Source };
      try {
        target = await load(job.uses, source);
      } catch (e) {
        throw new ReusableError(`jobs.${full}.uses: ${(e as Error).message}`);
      }
      if (!target.workflow.on.workflow_call) throw new ReusableError(`jobs.${full}.uses: ${job.uses} is not a reusable workflow (it has no 'on: workflow_call' trigger)`);
      const declaredInputs = target.workflow.on.workflow_call.inputs ?? {};
      for (const k of Object.keys(job.with ?? {})) {
        if (!(k in declaredInputs)) throw new ReusableError(`jobs.${full}.with.${k}: ${job.uses} has no input named '${k}'`);
      }
      calls.set(full, { key: full, parent: prefix, job, workflow: target.workflow, needs: declared });
      await walk(target.workflow, target.source, full, depth + 1, ordering);
    }
  };
  await walk(root, rootSource, null, 0, []);

  // A dependency on a call means a dependency on every runnable job inside it.
  const under = (call: string) => Object.keys(leaves).filter((k) => k.startsWith(`${call}/`));
  for (const job of Object.values(leaves)) job.needs = [...new Set(job.needs.flatMap((n) => (calls.has(n) ? under(n) : [n])))];

  return { workflow: { ...root, jobs: leaves }, calls, parentOf, needs, workflowOf };
}

/** Parse a `uses:` reference to a reusable workflow. */
export function parseCallRef(uses: string): { kind: "local"; path: string } | { kind: "remote"; owner: string; repo: string; path: string; ref: string } {
  // Only from the workflow directories, which agents' auto-merge and job tokens treat as workflow changes,
  // here or in the called repository (as on GitHub).
  const inWorkflowDir = (path: string) => /^\.(?:github|diffinery)\/workflows\//.test(path) && !path.split("/").some((s) => s === ".." || s === "." || s === "");
  const local = /^\.\/(.+\.ya?ml)$/.exec(uses);
  if (local) {
    if (!inWorkflowDir(local[1]!)) throw new Error(`'${uses}' must be a file in ./.github/workflows or ./.diffinery/workflows`);
    return { kind: "local", path: local[1]! };
  }
  const remote = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)\/(.+\.ya?ml)@(.+)$/.exec(uses);
  if (remote) {
    if (!inWorkflowDir(remote[3]!)) throw new Error(`'${uses}' must name a file in .github/workflows or .diffinery/workflows of ${remote[1]}/${remote[2]}`);
    return { kind: "remote", owner: remote[1]!, repo: remote[2]!, path: remote[3]!, ref: remote[4]! };
  }
  throw new Error(`'${uses}' must be ./.github/workflows/<file>.yml or <owner>/<repo>/.github/workflows/<file>.yml@<ref>`);
}
