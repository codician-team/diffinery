import { describe, expect, it } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { plain, plainSteps } from "../../src/lib/rpc.js";

/** An object shaped like an RPC result: the runtime gives each one a non-enumerable `Symbol.dispose`. */
function rpcResult<T extends object>(value: T, disposed: string[], name: string): T {
  Object.defineProperty(value, Symbol.dispose, { value: () => disposed.push(name), enumerable: false });
  return value;
}
const hasDisposer = (v: unknown) => typeof (v as Record<symbol, unknown>)[Symbol.dispose] === "function";

describe("plain", () => {
  it("copies an RPC result without its disposer and disposes it", async () => {
    const disposed: string[] = [];
    const out = await plain(Promise.resolve(rpcResult({ jobIds: ["a"], at: new Date(5) }, disposed, "r")));
    expect(out).toEqual({ jobIds: ["a"], at: new Date(5) });
    expect(hasDisposer(out)).toBe(false);
    expect(disposed).toEqual(["r"]);
  });

  it("leaves plain values alone", async () => {
    const obj = { a: 1 };
    expect(await plain(obj)).toBe(obj);
    expect(await plain(null)).toBe(null);
    expect(await plain("completed")).toBe("completed");
    expect(await plain(undefined)).toBe(undefined);
  });

  it("disposes the result even when it can't be copied", async () => {
    const disposed: string[] = [];
    await expect(plain(rpcResult({ f: () => 1 }, disposed, "r"))).rejects.toThrow();
    expect(disposed).toEqual(["r"]);
  });
});

describe("plainSteps", () => {
  /** A stand-in for the engine's step: records what each callback returned, and returns RPC-shaped results. */
  function engine() {
    const disposed: string[] = [];
    const returned: unknown[] = [];
    const calls: unknown[][] = [];
    const step = {
      async do(name: string, ...rest: unknown[]) {
        calls.push([name, ...rest.filter((a) => typeof a !== "function")]);
        const cb = rest.find((a) => typeof a === "function") as (ctx: unknown) => Promise<unknown>;
        const v = await cb({ attempt: 1 });
        returned.push(v);
        return v !== null && typeof v === "object" ? rpcResult({ ...v }, disposed, name) : v;
      },
      async sleep() {},
      async sleepUntil() {},
      async waitForEvent(name: string) {
        return rpcResult({ type: name, payload: { retryInSeconds: 3 }, timestamp: new Date(1) }, disposed, name);
      },
    };
    return { step: plainSteps(step as unknown as WorkflowStep), disposed, returned, calls };
  }

  it("hands the engine plain callback results, and returns plain step results", async () => {
    const e = engine();
    const callbackDisposed: string[] = [];
    const out = await e.step.do("start build", { retries: { limit: 3, delay: "10 seconds" } }, async () => rpcResult({ jobIds: ["j1"] }, callbackDisposed, "repo"));
    expect(out).toEqual({ jobIds: ["j1"] });
    expect(hasDisposer(out)).toBe(false);
    // The Durable Object's result was disposed in the callback, and the engine got a copy without a disposer.
    expect(callbackDisposed).toEqual(["repo"]);
    expect(e.returned.map(hasDisposer)).toEqual([false]);
    // The step's own result was disposed too, and the config went through untouched.
    expect(e.disposed).toEqual(["start build"]);
    expect(e.calls).toEqual([["start build", { retries: { limit: 3, delay: "10 seconds" } }]]);
  });

  it("works without a config, for scalar results, and for events", async () => {
    const e = engine();
    expect(await e.step.do("info", async () => "completed")).toBe("completed");
    const event = await e.step.waitForEvent("job-1", { type: "job-1", timeout: "6 hours" });
    expect(event).toEqual({ type: "job-1", payload: { retryInSeconds: 3 }, timestamp: new Date(1) });
    expect(hasDisposer(event)).toBe(false);
    expect(e.disposed).toEqual(["job-1"]);
  });
});
