import { describe, expect, it } from "vitest";
import { Directory } from "../../src/lib/directory.js";
import type { Env } from "../../src/env.js";

/** A D1 double that answers the two reads syncOrgVariables makes and accepts the batch write. */
function fakeEnv(repoIds: string[], failures: Record<string, number>) {
  const copies: Record<string, Array<Record<string, string>>> = {};
  const stmt = (sql: string) => ({
    bind: () => stmt(sql),
    all: async () => ({ results: sql.includes("FROM org_variables") ? [{ name: "REGION", value: "eu", updated_at: "t" }] : repoIds.map((id) => ({ id })) }),
    run: async () => ({ meta: { changes: 1 } }),
  });
  const env = {
    DB: { prepare: stmt, batch: async () => [] },
    REPO: {
      idFromName: (id: string) => id,
      get: (id: string) => ({
        setOrgVariables: async (vars: Record<string, string>) => {
          if ((failures[id] ?? 0) > 0) {
            failures[id]!--;
            throw new Error(`${id} is unavailable`);
          }
          (copies[id] ??= []).push(vars);
        },
      }),
    },
  } as unknown as Env;
  return { env, copies };
}

describe("organization variables", () => {
  it("reach every repository even when one fails, retrying the failures once", async () => {
    const { env, copies } = fakeEnv(["a", "b", "c"], { a: 1 });
    await new Directory(env).setOrgVariables("org", { REGION: "eu" });
    expect(Object.keys(copies).sort()).toEqual(["a", "b", "c"]);
    expect(copies.c).toEqual([{ REGION: "eu" }]);
  });

  it("says so when a repository still couldn't be updated, after updating the rest", async () => {
    const { env, copies } = fakeEnv(["a", "b", "c"], { b: 5 });
    await expect(new Directory(env).setOrgVariables("org", { REGION: "eu" })).rejects.toThrow(/1 repository wasn't updated; repeat the request/);
    expect(Object.keys(copies).sort()).toEqual(["a", "c"]);
  });
});
