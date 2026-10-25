import { describe, expect, it } from "vitest";
import { Timing, timedEnv } from "../../src/lib/timing.js";
import type { Env } from "../../src/env.js";

class Statement {
  constructor(readonly sql: string, readonly params: unknown[] = []) {}
  bind(...params: unknown[]) {
    return new Statement(this.sql, params);
  }
  async first() {
    return { sql: this.sql, params: this.params };
  }
  async all() {
    return { results: [], meta: { served_by_region: "WEUR", served_by_primary: true } };
  }
}

const fakeDb = (batched: unknown[][]) => ({
  prepare: (q: string) => new Statement(q),
  batch: async (s: Statement[]) => (batched.push(s), s.map(() => ({ results: [] }))),
});

const fakeNamespace = () => ({
  idFromName: (n: string) => ({ name: n }),
  get: (id: { name: string }) => ({ id, name: id.name, info: async (x: number) => x * 2, fetch: async () => new Response("ok") }),
});

describe("Server-Timing", () => {
  it("counts D1 queries and Durable Object calls without changing their results", async () => {
    const t = new Timing();
    const batched: unknown[][] = [];
    const env = timedEnv({ DB: fakeDb(batched), REPO: fakeNamespace() } as unknown as Env, t);
    const row = await env.DB.prepare("SELECT ?").bind(1).first();
    expect(row).toEqual({ sql: "SELECT ?", params: [1] });
    await env.DB.prepare("SELECT 2").all();
    // Batches still get the real statements.
    const s = env.DB.prepare("SELECT 3");
    await env.DB.batch([s]);
    expect(batched[0]![0]).toBeInstanceOf(Statement);
    const stub = env.REPO.get(env.REPO.idFromName("r")) as unknown as { name: string; info(x: number): Promise<number>; fetch(): Promise<Response> };
    expect(stub.name).toBe("r");
    expect(await stub.info(21)).toBe(42);
    expect(await (await stub.fetch()).text()).toBe("ok");
    await Promise.resolve();
    const h = t.header("IST");
    expect(h).toMatch(/^total;dur=\d+, /);
    expect(h).toMatch(/d1;dur=\d+;desc="3 queries, WEUR primary"/);
    expect(h).toMatch(/do;dur=\d+;desc="2 calls"/);
    expect(h).toContain('colo;desc="IST"');
    expect(t.header("not a colo")).not.toContain("colo");
  });

  it("leaves missing bindings alone", () => {
    const env = timedEnv({} as Env, new Timing());
    expect(env.DB).toBeUndefined();
    expect(env.REPO).toBeUndefined();
  });
});
