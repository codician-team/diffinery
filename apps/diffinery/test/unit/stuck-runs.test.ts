import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { parseWorkflow } from "@diffinery/workflow-yaml";
import { Actions, STUCK_RUN_FINISH_MS, STUCK_RUN_MS } from "../../src/repo/actions.js";
import { REPO_SCHEMA, migrateRepoSchema } from "../../src/repo/schema.js";
import { testD1 } from "./stubs/d1.js";
import type { RepoDO } from "../../src/repo/RepoDO.js";
import type { Env } from "../../src/env.js";
import type { Caller } from "../../src/repo/types.js";

/** The Durable Object's SqlStorage over node:sqlite: exec(query, ...bindings) with toArray() and one(). */
function sqlStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...args: unknown[]) {
      const params = args.map((a) => (a === undefined ? null : a)) as Array<string | number | null>;
      let rows: unknown[] = [];
      if (!params.length && query.trim().replace(/;\s*$/, "").includes(";")) db.exec(query);
      else rows = db.prepare(query).all(...params);
      return {
        toArray: () => rows as never[],
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0] as never;
        },
      };
    },
  };
}

// Like main's End-to-end: one run at a time per branch, without cancelling the running one.
const WORKFLOW = `name: e2e
on: push
concurrency:
  group: e2e-\${{ github.ref }}
jobs:
  test:
    runs-on: ubuntu-latest
    steps: [{ run: echo test }]
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps: [{ run: echo deploy }]
`;

const ADA: Caller = { id: "u1", login: "ada", kind: "user", role: "write" };

/**
 * Actions over an in-memory repository, with a stand-in RunWorkflow whose instances report `states[runId]`
 * ("waiting" by default) and record the events they get; `lose` drops events, as during a deploy.
 */
function fixture() {
  const sql = sqlStorage();
  sql.exec(REPO_SCHEMA);
  migrateRepoSchema(sql as unknown as SqlStorage);
  const DB = testD1();
  DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, created_at) VALUES ('acme', 'acme', 'org', 'active', ?)").run(new Date().toISOString());
  const events: { runId: string; type: string }[] = [];
  const completed: string[] = [];
  const alarms: number[] = [];
  const states: Record<string, string> = {};
  const net = { lose: false };
  const repo = {
    sql,
    meta: { repoId: "r", owner: "acme", ownerId: "acme", ownerKind: "org", name: "app", defaultBranch: "main" },
    headRef: "refs/heads/main",
    getRef: () => null,
    upsertCheck: () => {},
    broadcast: () => {},
    emit: (e: { type: string; action?: string; runId?: string }) => void (e.type === "workflow_run" && e.action === "completed" && completed.push(e.runId!)),
    deploys: { jobCompleted: () => {}, protection: () => null },
    runtime: { sweepJob: async () => {} },
    policy: { agentOrigin: () => false },
    alarmBy: (at: number) => void alarms.push(at),
  } as unknown as RepoDO;
  const env = {
    DB,
    PUBLIC_URL: "https://d.test",
    BUCKET: { put: async () => {} },
    RUNNER: { idFromName: (n: string) => n, get: () => ({ startJob: async () => {}, stopJob: async () => {} }) },
    RUN_WORKFLOW: {
      create: async () => {},
      get: async (runId: string) => ({
        sendEvent: async (e: { type: string }) => {
          if (net.lose) throw new Error("network connection lost");
          events.push({ runId, type: e.type });
        },
        status: async () => ({ status: states[runId] ?? "waiting" }),
      }),
    },
  } as unknown as Env;
  const actions = new Actions(repo, env);
  const { workflow } = parseWorkflow(WORKFLOW, ".github/workflows/e2e.yml");
  Object.defineProperty(actions, "loadWorkflows", { value: async () => [{ path: ".github/workflows/e2e.yml", workflow, errors: [] }] });
  const internal = actions as unknown as { completeJob(id: string, c: unknown): Promise<void> };
  const jobs = (runId: string) => sql.exec("SELECT id, job_key, name, status, conclusion, failure FROM jobs WHERE run_id = ? ORDER BY rowid", runId).toArray() as { id: string; job_key: string; name: string; status: string; conclusion: string; failure: string | null }[];
  const push = async () => (await actions.createRun(workflow!, { event: "push", ref: "refs/heads/main", sha: "abc", payload: {}, caller: ADA, title: "push" }))!.id;
  /** Plans the run and runs its `test` job to `conclusion`, as the run's workflow and runner would. */
  const runTest = async (runId: string, conclusion = "success") => {
    expect((await actions.plan(runId)).concurrencyBlocked).toBe(false);
    await actions.startJobKey(runId, "test");
    await internal.completeJob(jobs(runId)[0]!.id, { conclusion, outputs: {} });
  };
  /** Moves the run's finished jobs `ms` into the past. */
  const age = (runId: string, ms: number) => {
    const t = new Date(Date.now() - ms).toISOString();
    sql.exec("UPDATE jobs SET completed_at = ? WHERE run_id = ?", t, runId);
    sql.exec("UPDATE runs SET created_at = ? WHERE id = ?", t, runId);
  };
  return { sql, actions, events, completed, alarms, states, net, jobs, push, runTest, age };
}

describe("runs stuck after their jobs finished", () => {
  it("a lost job event is sent again, so the run's workflow carries on and the next run in the group starts", async () => {
    const f = fixture();
    const a = await f.push();
    f.net.lose = true;
    const before = Date.now();
    await f.runTest(a);
    f.net.lose = false;
    // The run's last job arms a check for later.
    expect(f.alarms.at(-1)).toBeGreaterThanOrEqual(before + STUCK_RUN_MS);
    // The next push waits behind it: the run is too fresh to call stuck.
    const b = await f.push();
    expect((await f.actions.plan(b)).concurrencyBlocked).toBe(true);
    expect(f.actions.nextStuckRunCheck()).toBeGreaterThanOrEqual(before + STUCK_RUN_MS);

    // Past STUCK_RUN_MS its workflow, still waiting, gets the job's event again, once.
    const later = Date.now() + STUCK_RUN_MS + 1000;
    await f.actions.repairStuckRuns(later);
    await f.actions.repairStuckRuns(later + 1000);
    expect(f.events).toEqual([{ runId: a, type: `job-${f.jobs(a)[0]!.id}` }]);
    expect(f.actions.getRun(a).status).toBe("in_progress");
    expect(f.actions.nextStuckRunCheck(later)).toBeGreaterThan(later + STUCK_RUN_FINISH_MS - STUCK_RUN_MS - 2000);

    // The workflow carries on with the rest of the graph and finishes the run, and b can start.
    await f.actions.startJobKey(a, "deploy");
    await (f.actions as unknown as { completeJob(id: string, c: unknown): Promise<void> }).completeJob(f.jobs(a)[1]!.id, { conclusion: "success", outputs: {} });
    expect((await f.actions.finishRun(a)).conclusion).toBe("success");
    expect((await f.actions.plan(b)).concurrencyBlocked).toBe(false);
    expect(f.completed).toEqual([a]);
  });

  it("a run whose workflow failed is finished, failing and naming the jobs that never started; the late workflow changes nothing", async () => {
    const f = fixture();
    const a = await f.push();
    await f.runTest(a);
    f.states[a] = "errored";
    await f.actions.repairStuckRuns(Date.now() + STUCK_RUN_MS + 1000);
    const run = f.actions.getRun(a);
    expect(run).toMatchObject({ status: "completed", conclusion: "failure" });
    const setup = f.jobs(a).find((j) => j.name === "Set up workflow")!;
    expect(JSON.parse(setup.failure!).message).toBe("The run's workflow stopped after its jobs finished, so a job never started (deploy). Re-run the workflow.");
    expect(f.actions.nextStuckRunCheck()).toBeNull();
    // Should the workflow come back after all, it starts nothing and doesn't finish the run a second time.
    expect(await f.actions.startJobKey(a, "deploy")).toEqual({ jobIds: [] });
    expect((await f.actions.finishRun(a)).conclusion).toBe("failure");
    expect(f.completed).toEqual([a]);
  });

  it("a run still stuck STUCK_RUN_FINISH_MS after its jobs finished is finished, though its workflow looks alive", async () => {
    const f = fixture();
    const a = await f.push();
    await f.runTest(a, "failure");
    const t = Date.now();
    await f.actions.repairStuckRuns(t + STUCK_RUN_MS + 1000);
    expect(f.actions.getRun(a).status).toBe("in_progress");
    await f.actions.repairStuckRuns(t + STUCK_RUN_FINISH_MS + 1000);
    // Its failed job fails the run.
    expect(f.actions.getRun(a)).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  it("a waiting run in the group repairs the stuck one when it plans: a cancelled run whose jobs ended long ago frees the group", async () => {
    const f = fixture();
    const a = await f.push();
    await f.runTest(a);
    // As on main at 14:46: the run was cancelled, its jobs ended, and its workflow never finished it.
    f.sql.exec("UPDATE runs SET conclusion = 'cancelled' WHERE id = ?", a);
    f.age(a, 2 * 60 * 60_000);
    f.states[a] = "waiting";
    const b = await f.push();
    // Long past STUCK_RUN_FINISH_MS: finished at once, cancelled, with nothing added.
    expect((await f.actions.plan(b)).concurrencyBlocked).toBe(false);
    expect(f.actions.getRun(a)).toMatchObject({ status: "completed", conclusion: "cancelled" });
    expect(f.jobs(a).map((j) => j.name)).toEqual(["test"]);
  });

  it("leaves alone runs with a job still going, and runs that finished", async () => {
    const f = fixture();
    const a = await f.push();
    expect((await f.actions.plan(a)).concurrencyBlocked).toBe(false);
    await f.actions.startJobKey(a, "test");
    f.age(a, 2 * 60 * 60_000);
    await f.actions.repairStuckRuns();
    expect(f.actions.getRun(a).status).toBe("in_progress");
    expect(f.actions.nextStuckRunCheck()).toBeNull();
    expect(f.events).toEqual([]);

    // A re-run that just started, whose kept jobs finished in the earlier attempt hours ago, isn't stuck.
    const b = await f.push();
    f.sql.exec("UPDATE jobs SET status = 'completed', conclusion = 'success', completed_at = ? WHERE run_id = ?", new Date().toISOString(), a);
    await f.actions.finishRun(a);
    expect((await f.actions.plan(b)).concurrencyBlocked).toBe(false);
    f.sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status, conclusion, completed_at, carried_from) VALUES ('kept', ?, 'test', 'test', 'completed', 'success', ?, 'old')", b, new Date(Date.now() - 3 * 60 * 60_000).toISOString());
    await f.actions.repairStuckRuns(Date.now() + 1000);
    expect(f.actions.getRun(b).status).toBe("in_progress");
  });
});

describe("a concurrency group without cancel-in-progress", () => {
  it("keeps one run waiting, like GitHub: a newer run replaces older waiting ones, which finish cancelled at once", async () => {
    const f = fixture();
    const a = await f.push();
    expect((await f.actions.plan(a)).concurrencyBlocked).toBe(false);
    await f.actions.startJobKey(a, "test");
    const b = await f.push();
    expect((await f.actions.plan(b)).concurrencyBlocked).toBe(true);
    const c = await f.push();
    const d = await f.push();
    // b and c are replaced as d comes in; the running a is left alone.
    expect(f.actions.getRun(b).conclusion).toBe("cancelled");
    expect(f.actions.getRun(c).conclusion).toBe("cancelled");
    expect(f.actions.getRun(a)).toMatchObject({ status: "in_progress", conclusion: null });
    // A replaced run doesn't wait its turn: its next plan has nothing to run, and its workflow finishes it.
    expect(await f.actions.plan(c)).toEqual({ jobs: [], concurrencyBlocked: false });
    expect((await f.actions.finishRun(c)).conclusion).toBe("cancelled");
    expect(f.jobs(c)).toEqual([]);
    expect((await f.actions.plan(d)).concurrencyBlocked).toBe(true);
    // When a ends, d (the last push) runs next.
    await (f.actions as unknown as { completeJob(id: string, c: unknown): Promise<void> }).completeJob(f.jobs(a)[0]!.id, { conclusion: "success", outputs: {} });
    await f.actions.startJobKey(a, "deploy");
    await (f.actions as unknown as { completeJob(id: string, c: unknown): Promise<void> }).completeJob(f.jobs(a)[1]!.id, { conclusion: "success", outputs: {} });
    await f.actions.finishRun(a);
    expect((await f.actions.plan(d)).concurrencyBlocked).toBe(false);
    expect(f.actions.getRun(d).status).toBe("in_progress");
  });

  it("clears runs that waited before newer runs replaced older ones: the oldest doesn't take the group ahead of the newest", async () => {
    const f = fixture();
    const runs = [await f.push(), await f.push(), await f.push()];
    // As in a deploy group from before this change: every push waiting, none cancelled.
    f.sql.exec("UPDATE runs SET status = 'queued', conclusion = NULL");
    // The group is free, and the oldest plans first: it is replaced by the newest, and runs nothing.
    expect(await f.actions.plan(runs[0]!)).toEqual({ jobs: [], concurrencyBlocked: false });
    expect(f.actions.getRun(runs[1]!).conclusion).toBe("cancelled");
    expect(f.actions.getRun(runs[2]!)).toMatchObject({ status: "queued", conclusion: null });
    expect((await f.actions.plan(runs[2]!)).concurrencyBlocked).toBe(false);
    expect(f.actions.getRun(runs[2]!).status).toBe("in_progress");
  });
});
