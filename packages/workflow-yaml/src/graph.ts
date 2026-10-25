import type { Workflow, WorkflowError } from "./model.js";

/**
 * Groups jobs into topological levels from `needs`: every job in level N only
 * needs jobs in levels < N. Jobs keep file order within a level. Unknown
 * `needs` and dependency cycles are reported as errors; jobs involved in a
 * cycle (or depending on one) are left out of `order`.
 */
export function jobOrder(wf: Workflow): { order: string[][]; errors: WorkflowError[] } {
  const errors: WorkflowError[] = [];
  const keys = Object.keys(wf.jobs);
  const known = new Set(keys);
  const deps = new Map<string, string[]>();
  for (const key of keys) {
    const needs = wf.jobs[key]!.needs;
    for (const n of needs) {
      if (!known.has(n)) {
        errors.push({ path: `jobs.${key}.needs`, message: `Job '${key}' depends on unknown job '${n}'` });
      }
    }
    deps.set(key, needs.filter((n) => known.has(n)));
  }

  const order: string[][] = [];
  const placed = new Set<string>();
  let remaining = keys.slice();
  while (remaining.length > 0) {
    const level = remaining.filter((k) => deps.get(k)!.every((d) => placed.has(d)));
    if (level.length === 0) break;
    order.push(level);
    for (const k of level) placed.add(k);
    remaining = remaining.filter((k) => !placed.has(k));
  }

  if (remaining.length > 0) {
    const cycle = findCycle(remaining, deps);
    const where = cycle ? cycle[0]! : remaining[0]!;
    errors.push({
      path: `jobs.${where}.needs`,
      message: cycle
        ? `Dependency cycle between jobs: ${cycle.join(" -> ")}`
        : `Jobs ${remaining.map((r) => `'${r}'`).join(", ")} can never run because of a dependency cycle`,
    });
  }
  return { order, errors };
}

function findCycle(nodes: string[], deps: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | undefined => {
    state.set(n, 1);
    stack.push(n);
    for (const d of deps.get(n) ?? []) {
      const s = state.get(d);
      if (s === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (s === undefined) {
        const found = visit(d);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(n, 2);
    return undefined;
  };
  for (const n of nodes) {
    if (!state.has(n)) {
      const found = visit(n);
      if (found) return found;
    }
  }
  return undefined;
}
