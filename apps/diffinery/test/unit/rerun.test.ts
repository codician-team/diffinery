import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { parseWorkflow, type Workflow } from "@diffinery/workflow-yaml";
import { Actions, canonicalJson } from "../../src/repo/actions.js";
import { REPO_SCHEMA, migrateRepoSchema } from "../../src/repo/schema.js";
import { logKeys } from "../../src/lib/storage-keys.js";
import { uuidNumber, uuidPattern, workflowNumber } from "../../src/http/gh.js";
import { Runtime } from "../../src/repo/runtime.js";
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

const parse = (yaml: string, path: string): Workflow => {
  const { workflow, errors } = parseWorkflow(yaml, path);
  if (!workflow) throw new Error(errors.map((e) => e.message).join("; "));
  return workflow;
};

const WORKFLOW = `name: w
on: push
jobs:
  lint:
    runs-on: ubuntu-latest
    steps: [{ run: echo lint }]
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [a, b, c]
    steps: [{ run: echo test }]
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps: [{ run: echo deploy }]
  report:
    needs: lint
    runs-on: ubuntu-latest
    steps: [{ run: echo report }]
`;

type Row = { id: string; run_id: string; job_key: string; name: string; status: string; conclusion: string | null; matrix: string; carried_from: string | null; container: string | null };
type Outcome = (job: Row) => "success" | "failure";

const ADA: Caller = { id: "u1", login: "ada", kind: "user", role: "write" };

/**
 * Actions over an in-memory repository and D1, with the workflow files given, and a stand-in for
 * RunWorkflow (`drive`) that walks the job graph and finishes each started job as `outcome` says.
 */
function fixture(files: Record<string, string>) {
  const sql = sqlStorage();
  sql.exec(REPO_SCHEMA);
  migrateRepoSchema(sql as unknown as SqlStorage);
  const DB = testD1();
  DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, created_at) VALUES ('acme', 'acme', 'org', 'active', ?)").run(new Date().toISOString());
  const objects = new Map<string, string>();
  const started: string[] = [];
  const checks: Array<{ name: string; status: string; conclusion?: string | null; runId?: string; jobId?: string }> = [];
  const repo = {
    sql,
    meta: { repoId: "r", owner: "acme", ownerId: "acme", ownerKind: "org", name: "app", defaultBranch: "main" },
    headRef: "refs/heads/main",
    getRef: () => null,
    // Like Collab.upsertCheck: one check run per commit and name.
    upsertCheck: (c: (typeof checks)[number] & { sha: string }) => {
      checks.push(c);
      sql.exec("DELETE FROM checks WHERE sha = ? AND name = ?", c.sha, c.name);
      sql.exec("INSERT INTO checks (id, sha, name, status, conclusion, run_id, job_id) VALUES (?, ?, ?, ?, ?, ?, ?)", `${c.sha}/${c.name}`, c.sha, c.name, c.status, c.conclusion ?? null, c.runId ?? null, c.jobId ?? null);
    },
    broadcast: () => {},
    emit: () => {},
    deploys: { jobCompleted: () => {}, protection: () => null },
    protectionFor: (branch: string) => (branch === "release" ? {} : null),
    runtime: { sweepJob: async () => {} },
    policy: { agentOrigin: () => false },
    alarmBy: () => {},
  } as unknown as RepoDO;
  const env = {
    DB,
    PUBLIC_URL: "https://d.test",
    BUCKET: {
      put: async (k: string, v: string) => void objects.set(k, v),
      get: async (k: string) => (objects.has(k) ? { json: async () => JSON.parse(objects.get(k)!) } : null),
      delete: async (keys: string | string[]) => void [keys].flat().forEach((k) => objects.delete(k)),
    },
    RUNNER: { idFromName: (n: string) => n, get: (n: string) => ({ startJob: async () => void started.push(n), stopJob: async () => {} }) },
    RUN_WORKFLOW: { create: async () => {}, get: async () => ({ sendEvent: async () => {} }) },
  } as unknown as Env;
  const actions = new Actions(repo, env);
  const workflows = Object.entries(files).map(([path, text]) => ({ path, workflow: parse(text, path), errors: [] as string[] }));
  Object.defineProperty(actions, "loadWorkflows", { value: async () => workflows });
  Object.defineProperty(actions, "loadCalled", { value: async (uses: string) => ({ workflow: workflows.find((w) => w.path === uses.replace(/^\.\//, ""))!.workflow, source: { repoId: null, sha: "abc" } }) });
  const internal = actions as unknown as { completeJob(id: string, c: unknown): Promise<void> };
  const jobs = (runId: string) => sql.exec("SELECT * FROM jobs WHERE run_id = ? ORDER BY rowid", runId).toArray() as Row[];
  const leg = (j: Row) => `${j.job_key}${j.matrix === "{}" ? "" : ` ${Object.values(JSON.parse(j.matrix)).join(",")}`}`;
  /** Each job (by `leg`) with its conclusion, and whether it was kept from an earlier attempt. */
  const summary = (runId: string) => Object.fromEntries(jobs(runId).map((j) => [leg(j), `${j.conclusion}${j.carried_from ? " (kept)" : ""}`]));

  async function drive(runId: string, outcome: Outcome) {
    const plan = await actions.plan(runId);
    expect(plan.error).toBeUndefined();
    const done = new Set<string>();
    while (done.size < plan.jobs.length) {
      const next = plan.jobs.find((n) => !done.has(n.key) && n.needs.every((k) => done.has(k)))!;
      await actions.startJobKey(runId, next.key);
      // Finish the key's started legs one at a time, in order, as their runners would.
      for (;;) {
        const running = jobs(runId).find((j) => j.job_key === next.key && j.status === "waiting");
        if (!running) break;
        await internal.completeJob(running.id, { conclusion: outcome(running), outputs: {} });
      }
      expect(jobs(runId).filter((j) => j.job_key === next.key && j.status !== "completed")).toEqual([]);
      done.add(next.key);
    }
    return actions.finishRun(runId);
  }

  async function firstRun(outcome: Outcome, ref = "refs/heads/main") {
    const run = (await actions.createRun(workflows[0]!.workflow, { event: "push", ref, sha: "abc", payload: {}, caller: ADA, title: "first" }))!;
    await drive(run.id, outcome);
    return run.id;
  }
  return { sql, actions, started, checks, objects, jobs, leg, summary, drive, firstRun };
}

const failB: Outcome = (j) => (j.job_key === "test" && JSON.parse(j.matrix).os === "b" ? "failure" : "success");
const allPass: Outcome = () => "success";

describe("re-running failed jobs", () => {
  it("keeps the legs that passed and re-runs the failed and cancelled ones, with what depends on them", async () => {
    const f = fixture({ ".github/workflows/w.yml": WORKFLOW });
    const first = await f.firstRun(failB);
    // fail-fast: b's failure cancelled c, and deploy (needs test) was skipped.
    expect(f.summary(first)).toEqual({ lint: "success", "test a": "success", "test b": "failure", "test c": "cancelled", deploy: "skipped", report: "success" });
    expect(f.actions.getRun(first).conclusion).toBe("failure");

    const before = f.started.length;
    const second = await f.actions.rerun(first, ADA, "failed");
    expect(second).toMatchObject({ attempt: 2, number: f.actions.getRun(first).number });
    const done = await f.drive(second.id, allPass);
    expect(done.conclusion).toBe("success");
    expect(f.summary(second.id)).toEqual({ lint: "success (kept)", report: "success (kept)", "test a": "success (kept)", "test b": "success", "test c": "success", deploy: "success" });
    // Only the re-run legs started a container.
    const ran = f.jobs(second.id).filter((j) => !j.carried_from);
    expect(f.started.slice(before).sort()).toEqual(ran.map((j) => `job-${j.id}`).sort());
    // A kept job is a copy of the one that ran, pointing at it.
    const old = Object.fromEntries(f.jobs(first).map((j) => [f.leg(j), j]));
    for (const j of f.jobs(second.id).filter((x) => x.carried_from)) {
      expect(j.carried_from).toBe(old[f.leg(j)]!.id);
      expect(j.name).toBe(old[f.leg(j)]!.name);
    }
    // Kept jobs use no minutes.
    const usage = (await (f.actions as unknown as { env: Env }).env.DB.prepare("SELECT id FROM compute_usage").all<{ id: string }>()).results.map((r) => r.id);
    for (const j of f.jobs(second.id)) expect(usage.includes(j.id)).toBe(!j.carried_from);
    // The kept jobs' check runs now point at the new attempt, completed with their conclusion.
    const lintCheck = f.checks.filter((c) => c.name === "w / lint").at(-1)!;
    expect(lintCheck).toMatchObject({ status: "completed", conclusion: "success", runId: second.id });
  });

  it("refuses a run without failed jobs, and one that hasn't finished", async () => {
    const f = fixture({ ".github/workflows/w.yml": WORKFLOW });
    const first = await f.firstRun(allPass);
    await expect(f.actions.rerun(first, ADA, "failed")).rejects.toMatchObject({ status: 409, detail: "this run has no failed jobs to re-run" });
    const second = await f.actions.rerun(first, ADA);
    await expect(f.actions.rerun(second.id, ADA, "failed")).rejects.toMatchObject({ status: 409 });
    await expect(f.actions.rerunJob(f.jobs(first)[0]!.id, ADA)).resolves.toMatchObject({ attempt: 2 });
  });

  it("checks permissions like a full re-run", async () => {
    const f = fixture({ ".github/workflows/w.yml": WORKFLOW });
    const first = await f.firstRun(failB);
    await expect(f.actions.rerun(first, { ...ADA, role: "read" }, "failed")).rejects.toMatchObject({ status: 403 });
    await expect(f.actions.rerun(first, { ...ADA, id: "job:x" }, "failed")).rejects.toMatchObject({ status: 403, detail: "a workflow's GITHUB_TOKEN cannot re-run workflows" });
    await expect(f.actions.rerunJob(f.jobs(first)[0]!.id, { ...ADA, role: "read" })).rejects.toMatchObject({ status: 403 });
  });

  it("re-runs a full run as before", async () => {
    const f = fixture({ ".github/workflows/w.yml": WORKFLOW });
    const first = await f.firstRun(failB);
    const second = await f.actions.rerun(first, ADA);
    await f.drive(second.id, allPass);
    expect(Object.values(f.summary(second.id))).toEqual(Array(6).fill("success"));
    expect((f.sql.exec("SELECT rerun_carry FROM runs WHERE id = ?", second.id).one() as { rerun_carry: string | null }).rerun_carry).toBeNull();
  });

  it("starts up to max-parallel re-run legs; kept legs don't count", async () => {
    const f = fixture({
      ".github/workflows/w.yml": `name: w
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      max-parallel: 1
      matrix:
        n: [1, 2, 3, 4]
    steps: [{ run: echo }]
`,
    });
    const first = await f.firstRun((j) => (JSON.parse(j.matrix).n <= 2 ? "failure" : "success"));
    const second = await f.actions.rerun(first, ADA, "failed");
    await f.actions.plan(second.id);
    await f.actions.startJobKey(second.id, "test");
    expect(f.jobs(second.id).map((j) => [f.leg(j), j.status, !!j.carried_from])).toEqual([
      ["test 1", "waiting", false],
      ["test 2", "queued", false],
      ["test 3", "completed", true],
      ["test 4", "completed", true],
    ]);
  });
});

describe("re-running one job", () => {
  it("re-runs that job and its dependents and keeps the rest, failures included", async () => {
    const f = fixture({ ".github/workflows/w.yml": WORKFLOW });
    const first = await f.firstRun(failB);
    const lint = f.jobs(first).find((j) => j.job_key === "lint")!;
    const second = await f.actions.rerunJob(lint.id, ADA);
    await f.drive(second.id, allPass);
    expect(f.summary(second.id)).toEqual({ lint: "success", report: "success", "test a": "success (kept)", "test b": "failure (kept)", "test c": "cancelled (kept)", deploy: "skipped (kept)" });
    expect(f.actions.getRun(second.id).conclusion).toBe("failure");

    // One matrix leg: the other legs are kept. deploy needs test, so it runs again, and is skipped: test c is still cancelled.
    const b = f.jobs(second.id).find((j) => f.leg(j) === "test b")!;
    const third = await f.actions.rerunJob(b.id, ADA);
    expect(third.attempt).toBe(3);
    await f.drive(third.id, allPass);
    expect(f.summary(third.id)).toEqual({ lint: "success (kept)", report: "success (kept)", "test a": "success (kept)", "test b": "success", "test c": "cancelled (kept)", deploy: "skipped" });
    // A job kept twice points at the job that actually ran, in the first attempt.
    const a1 = f.jobs(first).find((j) => f.leg(j) === "test a")!;
    expect(f.jobs(third.id).find((j) => f.leg(j) === "test a")!.carried_from).toBe(a1.id);
  });

  it("serves a kept job's log from the job that ran", async () => {
    const f = fixture({ ".github/workflows/w.yml": WORKFLOW });
    const first = await f.firstRun((j) => {
      if (j.job_key === "lint") f.sql.exec("INSERT INTO logs (job_id, seq, t, step, text) VALUES (?, 0, 't', 0, 'linted')", j.id);
      return failB(j);
    });
    const lint = f.jobs(first).find((j) => j.job_key === "lint")!;
    expect(f.objects.has(logKeys("r", lint.id)[0]!)).toBe(true);
    const second = await f.actions.rerun(first, ADA, "failed");
    await f.drive(second.id, allPass);
    const kept = f.jobs(second.id).find((j) => j.job_key === "lint")!;
    expect(kept.carried_from).toBe(lint.id);
    const logs = await f.actions.logs(kept.id);
    expect(logs).toMatchObject({ complete: true, lines: [{ text: "linted" }] });
    expect(f.actions.getJob(kept.id).carriedFrom).toBe(lint.id);
    // gh asks by the REST API's numeric ids (http/gh.ts uuidNumber).
    expect(await f.actions.logs(String(uuidNumber(kept.id)))).toEqual(logs);
  });

  it("lists the kept jobs' artifacts with the new attempt's", async () => {
    const f = fixture({ ".github/workflows/w.yml": WORKFLOW });
    const first = await f.firstRun(failB);
    const byLeg = Object.fromEntries(f.jobs(first).map((j) => [f.leg(j), j.id]));
    const t = new Date().toISOString();
    const later = new Date(Date.now() + 86400_000).toISOString();
    const add = (runId: string, jobId: string, name: string) =>
      f.sql.exec("INSERT INTO rt_artifacts (run_id, job_id, name, size, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, 1, 'ready', ?, ?, ?)", runId, jobId, name, t, t, later);
    add(first, byLeg.lint!, "lint-report");
    add(first, byLeg["test b"]!, "failed-b");
    const second = await f.actions.rerun(first, ADA, "failed");
    await f.drive(second.id, allPass);
    add(second.id, f.jobs(second.id).find((j) => f.leg(j) === "test b")!.id, "passed-b");
    const rt = new Runtime({ sql: f.sql } as unknown as RepoDO, {} as Env);
    // The failed leg ran again, so its first attempt's artifact isn't the new attempt's.
    expect(rt.runArtifacts(second.id).map((a) => a.name).sort()).toEqual(["lint-report", "passed-b"]);
    expect(rt.runArtifacts(first).map((a) => a.name).sort()).toEqual(["failed-b", "lint-report"]);
    expect(rt.runArtifacts(String(uuidNumber(second.id))).map((a) => a.name).sort()).toEqual(["lint-report", "passed-b"]);
  });
});

describe("the REST API's numeric run and job ids", () => {
  it("are 16 digits that find the run or job again, while shorter numbers stay run numbers", async () => {
    const f = fixture({ ".github/workflows/w.yml": WORKFLOW });
    const first = await f.firstRun(failB);
    const second = await f.actions.rerun(first, ADA, "failed");
    const n = uuidNumber(first);
    expect(String(n)).toMatch(/^\d{16}$/);
    expect(uuidPattern(String(n))).not.toBeNull();
    expect(f.actions.getRun(String(n)).id).toBe(first);
    expect(f.actions.getRun(String(uuidNumber(second.id))).id).toBe(second.id);
    // A run number is the latest attempt, as before.
    expect(f.actions.getRun(String(second.number)).id).toBe(second.id);
    expect(f.actions.jobs(String(n)).map((j) => j.id)).toEqual(f.jobs(first).map((j) => j.id));
    const job = f.jobs(first)[0]!;
    expect(f.actions.getJob(String(uuidNumber(job.id))).id).toBe(job.id);
    expect(() => f.actions.getJob(String(uuidNumber(job.id) + 1))).toThrow(/job not found/);
    expect(() => f.actions.getRun("9999999999999999")).toThrow(/run not found/);
    expect(uuidPattern("123")).toBeNull();
    expect(uuidPattern("abc")).toBeNull();
  });

  it("give workflows a stable number of their own", () => {
    expect(workflowNumber(".github/workflows/ci.yml")).toBe(workflowNumber(".github/workflows/ci.yml"));
    expect(workflowNumber(".github/workflows/ci.yml")).not.toBe(workflowNumber(".github/workflows/cd.yml"));
    expect(Number.isSafeInteger(workflowNumber(".github/workflows/ci.yml"))).toBe(true);
  });
});

describe("re-running failed jobs of a reusable workflow call", () => {
  it("treats the call's jobs like any other and re-runs what needs the call", async () => {
    const f = fixture({
      ".github/workflows/w.yml": `name: w
on: push
jobs:
  build:
    uses: ./.github/workflows/lib.yml
  ship:
    needs: build
    runs-on: ubuntu-latest
    steps: [{ run: echo ship }]
  docs:
    runs-on: ubuntu-latest
    steps: [{ run: echo docs }]
`,
      ".github/workflows/lib.yml": `on: workflow_call
jobs:
  compile:
    runs-on: ubuntu-latest
    steps: [{ run: echo compile }]
  check:
    needs: compile
    runs-on: ubuntu-latest
    steps: [{ run: echo check }]
`,
    });
    const first = await f.firstRun((j) => (j.job_key === "build/check" ? "failure" : "success"));
    expect(f.summary(first)).toEqual({ "build/compile": "success", "build/check": "failure", ship: "skipped", docs: "success" });
    const second = await f.actions.rerun(first, ADA, "failed");
    await f.drive(second.id, allPass);
    expect(f.summary(second.id)).toEqual({ "build/compile": "success (kept)", "build/check": "success", ship: "success", docs: "success (kept)" });
  });
});

describe("canonicalJson", () => {
  it("doesn't depend on key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
  });
});

describe("starting a run's workflow", () => {
  const start = async (create: () => Promise<void>, exists: () => boolean) => {
    const f = fixture({ ".github/workflows/w.yml": WORKFLOW });
    let calls = 0;
    (f.actions as unknown as { env: Env }).env.RUN_WORKFLOW = {
      create: async () => {
        calls++;
        await create();
      },
      get: async () => ({
        status: async () => {
          if (!exists()) throw new Error("instance not found");
          return { status: "running" };
        },
        sendEvent: async () => {},
      }),
    } as unknown as Env["RUN_WORKFLOW"];
    vi.useFakeTimers();
    try {
      const pending = f.actions.createRun(parse(WORKFLOW, ".github/workflows/w.yml"), { event: "push", ref: "refs/heads/main", sha: "abc", payload: {}, caller: ADA, title: "t" });
      await vi.runAllTimersAsync();
      return { f, run: (await pending)!, calls: () => calls };
    } finally {
      vi.useRealTimers();
    }
  };

  it("tries again when the platform fails the call, and counts a call that failed after creating it", async () => {
    let fails = 1;
    const a = await start(async () => {
      if (fails-- > 0) throw new Error("internal error; reference = abc");
    }, () => false);
    expect(a.calls()).toBe(2);
    expect(a.run.status).toBe("queued");
    let created = false;
    const b = await start(async () => {
      created = true;
      throw new Error("internal error; reference = def");
    }, () => created);
    expect(b.calls()).toBe(1);
    expect(b.run.status).toBe("queued");
  });

  it("fails the run, saying why, rather than leave it queued for good", async () => {
    const { f, run, calls } = await start(async () => {
      throw new Error("internal error; reference = ghi");
    }, () => false);
    expect(calls()).toBe(3);
    expect(run).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(f.jobs(run.id).map((j) => [j.name, j.conclusion])).toEqual([["Set up workflow", "failure"]]);
    const failure = f.sql.exec<{ failure: string }>("SELECT failure FROM jobs WHERE run_id = ?", run.id).one().failure;
    expect(JSON.parse(failure).message).toBe("Diffinery couldn't start this run (internal error; reference = ghi). Re-run the workflow.");
  });
});

describe("deleting a run's logs", () => {
  const logged = (f: ReturnType<typeof fixture>) => (j: Row) => {
    f.sql.exec("INSERT INTO logs (job_id, seq, t, step, text) VALUES (?, 0, 't', 0, ?)", j.id, `log of ${j.job_key}`);
    f.sql.exec("UPDATE jobs SET summary = 'a summary' WHERE id = ?", j.id);
    return "success" as const;
  };

  it("deletes every job's lines, archived copy and summary, and keeps the run and its jobs", async () => {
    const f = fixture({ ".github/workflows/w.yml": WORKFLOW });
    const first = await f.firstRun(logged(f));
    const jobs = f.jobs(first);
    expect(jobs.every((j) => f.objects.has(logKeys("r", j.id)[0]!))).toBe(true);
    expect(await f.actions.deleteLogs(first, ADA)).toEqual(jobs.map((j) => j.id));
    for (const j of jobs) {
      expect(f.objects.has(logKeys("r", j.id)[0]!)).toBe(false);
      expect(await f.actions.logs(j.id)).toEqual({ lines: [], complete: true });
    }
    expect(f.sql.exec("SELECT count(*) AS n FROM logs").one()).toEqual({ n: 0 });
    expect(f.sql.exec("SELECT count(*) AS n FROM jobs WHERE run_id = ? AND summary IS NOT NULL", first).one()).toEqual({ n: 0 });
    expect(f.actions.getRun(first)).toMatchObject({ conclusion: "success", jobs: expect.arrayContaining([expect.objectContaining({ conclusion: "success" })]) });
  });

  it("needs write access, refuses job tokens and runs that haven't finished", async () => {
    const f = fixture({ ".github/workflows/w.yml": WORKFLOW });
    const first = await f.firstRun(allPass);
    await expect(f.actions.deleteLogs(first, { ...ADA, role: "read" })).rejects.toMatchObject({ status: 403 });
    await expect(f.actions.deleteLogs(first, { ...ADA, id: "job:x" })).rejects.toMatchObject({ status: 403 });
    const second = await f.actions.rerun(first, ADA);
    await expect(f.actions.deleteLogs(second.id, ADA)).rejects.toMatchObject({ status: 409 });
  });

  it("lets agents delete logs only of runs off the default and protected branches", async () => {
    const BOT: Caller = { id: "a1", login: "bot", kind: "agent", role: "write" };
    for (const [ref, ok] of [["refs/heads/main", false], ["refs/heads/release", false], ["refs/heads/feature", true], ["refs/pull/3/merge", true]] as const) {
      const f = fixture({ ".github/workflows/w.yml": WORKFLOW });
      const run = await f.firstRun(logged(f), ref);
      if (ok) await expect(f.actions.deleteLogs(run, BOT)).resolves.toHaveLength(6);
      else await expect(f.actions.deleteLogs(run, BOT)).rejects.toMatchObject({ status: 403 });
    }
    // People may delete logs of any branch's runs.
    const f = fixture({ ".github/workflows/w.yml": WORKFLOW });
    await expect(f.actions.deleteLogs(await f.firstRun(logged(f)), ADA)).resolves.toHaveLength(6);
  });
});
