import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

// The containers library's Container, with a start() each test gives: the real one needs the Workers runtime.
const lib = vi.hoisted(() => ({ start: async (_self: { onStop(p: { exitCode?: number; reason: string }): Promise<void> }): Promise<void> => {} }));
vi.mock("@cloudflare/containers", () => ({
  Container: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
    async start(): Promise<void> {
      await lib.start(this as never);
    }
    async setAllowedHosts(): Promise<void> {}
  },
}));

const { RunnerContainer } = await import("../../src/runner/containers.js");

function runner() {
  const kept = new Map<string, unknown>();
  const ctx = {
    storage: {
      kv: { get: () => undefined, put: () => {} },
      put: async (k: string, v: unknown) => void kept.set(k, v),
      get: async (k: string) => kept.get(k),
      delete: async (k: string) => kept.delete(k),
    },
  };
  const stops: unknown[][] = [];
  const env = { GITHUB_RUNNERS: { idFromName: (n: string) => n, get: () => ({ stopped: async (...a: unknown[]) => void stops.push(a) }) } };
  return { c: new RunnerContainer(ctx as never, env as unknown as Env), stops, kept };
}

const input = { accountId: "ann", runnerId: "row1", container: "gh-row1-1", jitConfig: "jit", egress: "open" as const, vcpu: 4 };

describe("a GitHub runner's container", () => {
  it("isn't reported stopped while its start is still under way", async () => {
    const { c, stops } = runner();
    // The platform had no machine for the first try: the library's alarm reports the container stopped with
    // exit code 0 while start() tries again, and the second try starts it.
    lib.start = async (self) => self.onStop({ exitCode: 0, reason: "exit" });
    await c.startGitHubRunner(input);
    expect(stops).toEqual([]);
    // Its real stop, after the job, with the container that stopped.
    await c.onStop({ exitCode: 0, reason: "exit" });
    expect(stops).toEqual([["ann", "row1", 0, "gh-row1-1"]]);
  });

  it("is reported stopped after a start that failed", async () => {
    const { c, stops } = runner();
    lib.start = async () => {
      throw new Error("there is no container instance that can be provided to this durable object");
    };
    await expect(c.startGitHubRunner(input)).rejects.toThrow(/no container instance/);
    await c.onStop({ exitCode: 1, reason: "exit" });
    expect(stops).toEqual([["ann", "row1", 1, "gh-row1-1"]]);
  });
});
