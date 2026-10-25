import type { Conclusion } from "@diffinery/shared";
import { evaluateValue, type ExprContext, type StatusFns } from "@diffinery/workflow-yaml";

/**
 * Pure pieces of job scheduling, GitHub-compatible: the dependency graph a run
 * walks, the status functions a job's `if:` sees, how matrix legs combine into
 * one `needs.<job>.result`, and `runs-on` evaluated for one matrix leg.
 */

/** A job and the jobs it waits for. */
export type JobNode = { key: string; needs: string[] };

/**
 * Every job (or reusable workflow call) that `keys` depend on, directly or
 * through their own `needs`: GitHub's "ancestor" jobs. `needs` maps a key to
 * the keys it declares.
 */
export function ancestors(needs: ReadonlyMap<string, readonly string[]>, keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (k: string) => {
    if (seen.has(k)) return;
    seen.add(k);
    for (const n of needs.get(k) ?? []) visit(n);
  };
  for (const k of keys) visit(k);
  return [...seen];
}

/**
 * Status functions for a job's `if:`, from the results of all of its ancestors.
 * Like GitHub: success() needs every ancestor to have succeeded (a skipped one
 * counts against it, so a skip cascades down the chain), failure() is true when
 * any ancestor failed, and cancelled() when the run was cancelled.
 */
export function jobStatus(ancestorResults: readonly Conclusion[], cancelled: boolean): StatusFns {
  return {
    success: () => !cancelled && ancestorResults.every((r) => r === "success"),
    failure: () => ancestorResults.some((r) => r === "failure"),
    cancelled: () => cancelled,
    always: () => true,
  };
}

/**
 * The result a job reports to the jobs that need it, from its matrix legs: any
 * failure fails it, else any cancellation cancels it; a job that never started,
 * or whose legs were all skipped, is skipped. A leg with `continue-on-error`
 * that failed counts as a success, as on GitHub.
 */
export function combineResults(legs: ReadonlyArray<{ conclusion: Conclusion | "timed_out" | null; continueOnError?: boolean }>): Conclusion {
  if (legs.length === 0 || legs.every((l) => l.conclusion === "skipped")) return "skipped";
  let result: Conclusion = "success";
  for (const l of legs) {
    let c: Conclusion = l.conclusion === "timed_out" ? "failure" : (l.conclusion ?? "failure");
    if (c === "failure" && l.continueOnError) c = "success";
    if (c === "failure") result = "failure";
    else if (c === "cancelled" && result !== "failure") result = "cancelled";
  }
  return result;
}

/**
 * `runs-on` labels for one matrix leg. Each entry may be an expression (github,
 * needs, strategy, matrix, vars and inputs are available, as on GitHub) that
 * yields a label or a list of labels.
 */
export function runnerLabels(runsOn: readonly string[], ctx: ExprContext): string[] {
  const out: string[] = [];
  for (const entry of runsOn) {
    const v = evaluateValue(entry, ctx);
    for (const label of Array.isArray(v) ? v : [v]) {
      if (label === null || label === undefined || typeof label === "object") continue;
      const s = String(label).trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * Walk a job graph: `start` runs for each job as soon as every job it needs has
 * finished (its own needs only, not a whole "level"), and the returned promise
 * settles once every job has. Needs outside the graph are ignored; the graph
 * must have no cycles (the planner rejects them).
 */
export async function runGraph(nodes: readonly JobNode[], start: (key: string) => Promise<void>): Promise<void> {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const done = new Map<string, Promise<void>>();
  const visit = (key: string): Promise<void> => {
    let p = done.get(key);
    if (!p) {
      const needs = (byKey.get(key)?.needs ?? []).filter((n) => byKey.has(n));
      p = Promise.all(needs.map(visit)).then(() => start(key));
      done.set(key, p);
    }
    return p;
  };
  await Promise.all(nodes.map((n) => visit(n.key)));
}

/** The graph of a plan made before plans carried one: each level waits for the level before it. */
export function graphFromLevels(levels: readonly string[][]): JobNode[] {
  return levels.flatMap((level, i) => level.map((key) => ({ key, needs: i > 0 ? [...levels[i - 1]!] : [] })));
}
