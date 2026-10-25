import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ProjectDO, type RunRow, type TaskView } from "../../src/agentic/ProjectDO.js";
import type { Env } from "../../src/env.js";
import { testD1 } from "./stubs/d1.js";

/** The Durable Object's SqlStorage over node:sqlite. */
function sqlStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...args: unknown[]) {
      const params = args.map((a) => (a === undefined ? null : a)) as Array<string | number | null>;
      let rows: unknown[] = [];
      if (!params.length && query.trim().replace(/;\s*$/, "").includes(";")) db.exec(query);
      else rows = db.prepare(query).all(...params);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0];
        },
      };
    },
  };
}

/**
 * A project with one task whose run is in its agent step, in a sandbox. Closing the sandbox calls `during`, which
 * reads (or changes) the project between the run's end and the sandbox's close.
 */
function fixture(during: (p: ProjectDO) => Promise<void> | void) {
  const ctx = { storage: { sql: sqlStorage(), setAlarm: async () => {} }, waitUntil: () => {} } as unknown as DurableObjectState;
  const stub = { idFromName: (n: string) => n };
  let p!: ProjectDO;
  const env = {
    DB: testD1(),
    REPO: { ...stub, get: () => ({ closeTaskSandbox: async () => during(p) }) },
    SANDBOX: { ...stub, get: () => ({ call: async () => ({ status: 200, body: "{}" }) }) },
  } as unknown as Env;
  p = new ProjectDO(ctx, env);
  const sql = (ctx.storage as unknown as { sql: ReturnType<typeof sqlStorage> }).sql;
  const at = new Date().toISOString();
  sql.exec(
    "INSERT INTO tasks (number, id, repo_id, goal, title, runtime, agent_id, agent_login, person_id, person_login, base, branch, state, created_at, updated_at) VALUES (1, 't1', 'r1', 'Do it', 'Do it', 'custom', 'a1', 'bot', 'u1', 'ada', 'main', 'agent/1-do-it', 'running', ?, ?)",
    at,
    at,
  );
  sql.exec("INSERT INTO runs (task, seq, kind, prompt, providers, step, sandbox_id, proc, started_at) VALUES (1, 1, 'start', '', '[]', 'agent', 'sb1', 'agent', ?)", at);
  const run = () => sql.exec("SELECT * FROM runs WHERE task = 1 AND seq = 1").one() as RunRow;
  const end = (step: "done" | "failed" | "stopped") => (p as unknown as { endRun(r: RunRow, s: string, e: string | null): Promise<void> }).endRun(run(), step, null);
  return { p, sql, end };
}

describe("a run's end", () => {
  it("settles its task before the sandbox closes", async () => {
    let seen: TaskView | null = null;
    const f = fixture((p) => {
      seen = p.get(1);
    });
    await f.end("done");
    // Read between the run's end and the sandbox's close: the run is done, and so is the task.
    expect(seen!.runs[0]!.step).toBe("done");
    expect(seen!.state).toBe("ready");
    expect(f.p.get(1)!.state).toBe("ready");
  });

  it("keeps a waiting message's task running, and starts its run once the sandbox is closed", async () => {
    let seen: TaskView | null = null;
    const f = fixture((p) => {
      seen = p.get(1);
    });
    f.sql.exec("UPDATE tasks SET queued = 'And add a test' WHERE number = 1");
    await f.end("done");
    expect(seen!.state).toBe("running");
    expect(seen!.runs.length).toBe(1);
    const after = f.p.get(1)!;
    expect(after.state).not.toBe("ready");
    expect(after.runs.map((r) => [r.seq, r.kind, r.message])).toEqual([
      [1, "start", null],
      [2, "message", "And add a test"],
    ]);
    expect(after.queued).toBeNull();
  });

  it("leaves a stop made while the sandbox closed as it is", async () => {
    const f = fixture(async (p) => {
      await p.stop(1, "ada");
    });
    f.sql.exec("UPDATE tasks SET queued = 'And add a test' WHERE number = 1");
    await f.end("done");
    const after = f.p.get(1)!;
    expect(after.state).toBe("stopped");
    expect(after.runs.length).toBe(1);
  });
});
