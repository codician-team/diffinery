import type { WorkflowStep } from "cloudflare:workers";

/** `Symbol.dispose` (the ES2023 lib this app type-checks against doesn't name it). */
const DISPOSE = (Symbol as unknown as { dispose: symbol }).dispose;

/**
 * The value of an RPC result as plain data, with the result itself disposed.
 *
 * Every object an RPC call returns (a Durable Object method, a Workflow step) comes with a
 * `Symbol.dispose` from the runtime. Handed on as the result of another RPC call, such as a Workflow
 * step's callback, that disposer tells the caller the object needs disposing, so the caller keeps the
 * call open until it disposes the object or garbage collection drops it. The Workflows engine never
 * disposes step results, and neither did our workflows: every step held its call open until a
 * collection, which then logged a warning from inside the collector, and in local dev that crashed
 * the runtime (a V8 check in GCTracer::StartCycle) and lost the run's workflow mid-step.
 */
export async function plain<T>(value: T | Promise<T>): Promise<T> {
  const v = await value;
  if (v === null || typeof v !== "object") return v;
  const dispose = (v as Partial<Record<symbol, unknown>>)[DISPOSE];
  if (typeof dispose !== "function") return v;
  try {
    // A copy has no disposer: structured clone copies only string-keyed properties.
    return structuredClone(v);
  } finally {
    dispose.call(v);
  }
}

/**
 * The step, with each callback's result and each step's result made plain (see `plain`), so no step
 * leaves a call open on either side.
 */
export function plainSteps(step: WorkflowStep): WorkflowStep {
  const s = step as unknown as {
    do(name: string, ...rest: unknown[]): Promise<unknown>;
    waitForEvent(name: string, options: unknown): Promise<unknown>;
  };
  return {
    do: (name: string, ...rest: unknown[]) => {
      const at = rest.findIndex((a) => typeof a === "function");
      const callback = rest[at] as (ctx: unknown) => unknown;
      const args = rest.map((a, i) => (i === at ? (ctx: unknown) => plain(callback(ctx)) : a));
      return plain(s.do(name, ...args));
    },
    sleep: (name: string, duration: Parameters<WorkflowStep["sleep"]>[1]) => step.sleep(name, duration),
    sleepUntil: (name: string, timestamp: Parameters<WorkflowStep["sleepUntil"]>[1]) => step.sleepUntil(name, timestamp),
    waitForEvent: (name: string, options: unknown) => plain(s.waitForEvent(name, options)),
  } as unknown as WorkflowStep;
}
