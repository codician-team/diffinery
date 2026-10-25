import { describe, expect, it } from "vitest";
import { receiveWithRetry, resetByDeploy } from "../../src/http/git.js";
import type { Env } from "../../src/env.js";
import type { Caller } from "../../src/repo/types.js";

const RESET = "Durable Object reset because its code was updated.";

/** A repository namespace whose objects fail the first `failures` pushes with `message`. */
function fakes(failures: number, message = RESET) {
  let calls = 0;
  const stubs: number[] = [];
  const retries: boolean[] = [];
  const deleted: string[] = [];
  const stub = (n: number) => ({
    gitReceivePack: async (_body: unknown, _caller: unknown, o: { retry?: boolean }) => {
      stubs.push(n);
      retries.push(!!o.retry);
      if (calls++ < failures) throw new Error(message);
      return new Uint8Array([1]);
    },
  });
  let made = 0;
  const env = {
    REPO: { idFromName: (name: string) => name, get: () => stub(++made) },
    BUCKET: { delete: async (key: string) => void deleted.push(key) },
  } as unknown as Env;
  return { env, first: stub(0) as never, stubs, retries, deleted };
}

const caller = { role: "write" } as unknown as Caller;
const spilled = { spilled: "push/abc", size: 70 << 20 };

describe("a push cut off by a deploy", () => {
  it("is handed to the new code once more, through a new stub, marked as a retry", async () => {
    const f = fakes(1);
    expect(await receiveWithRetry(f.env, "r1", f.first, spilled, caller, false)).toEqual(new Uint8Array([1]));
    expect(f.stubs).toEqual([0, 1]);
    expect(f.retries).toEqual([false, true]);
    // The staged body stays for the retry and is deleted once the push is done.
    expect(f.deleted).toEqual(["push/abc"]);
  });

  it("deletes the staged body after a push that went through the first time", async () => {
    const f = fakes(0);
    await receiveWithRetry(f.env, "r1", f.first, spilled, caller, false);
    expect(f.retries).toEqual([false]);
    expect(f.deleted).toEqual(["push/abc"]);
  });

  it("fails after a second reset, and the staged body is deleted", async () => {
    const f = fakes(2);
    await expect(receiveWithRetry(f.env, "r1", f.first, spilled, caller, false)).rejects.toThrow(RESET);
    expect(f.stubs).toEqual([0, 1]);
    expect(f.deleted).toEqual(["push/abc"]);
  });

  it("is handed over once more after a memory reset too, marked as a retry", async () => {
    const f = fakes(1, "Durable Object's isolate exceeded its memory limit and was reset.");
    expect(await receiveWithRetry(f.env, "r1", f.first, new Uint8Array(4), caller, false)).toEqual(new Uint8Array([1]));
    expect(f.stubs).toEqual([0, 1]);
    expect(f.retries).toEqual([false, true]);
    // Not a third time.
    const g = fakes(2, "Durable Object's isolate exceeded its memory limit and was reset.");
    await expect(receiveWithRetry(g.env, "r1", g.first, new Uint8Array(4), caller, false)).rejects.toThrow(/memory limit/);
    expect(g.stubs).toEqual([0, 1]);
  });

  it("is not retried for any other error", async () => {
    const f = fakes(1, "Internal error in Durable Object storage write.");
    await expect(receiveWithRetry(f.env, "r1", f.first, new Uint8Array(4), caller, false)).rejects.toThrow(/storage write/);
    expect(f.stubs).toEqual([0]);
    expect(f.deleted).toEqual([]);
    expect(resetByDeploy(new Error(RESET))).toBe(true);
    expect(resetByDeploy("Durable Object reset because its code was updated.")).toBe(false);
  });
});
