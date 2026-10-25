import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { parseWorkflow } from "@diffinery/workflow-yaml";
import { Actions } from "../../src/repo/actions.js";
import { fleetLimits } from "../../src/lib/quotas.js";
import { REPO_SCHEMA, migrateRepoSchema } from "../../src/repo/schema.js";
import { testD1 } from "./stubs/d1.js";
import type { RepoDO } from "../../src/repo/RepoDO.js";
import type { Env } from "../../src/env.js";
import type { Caller } from "../../src/repo/types.js";

/** Hosted jobs one account (and so one repository) runs at once by default. */
const SHARE = fleetLimits({} as Env).share;

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
        toArray: () => rows as never[],
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0] as never;
        },
      };
    },
  };
}

const ADA: Caller = { id: "u1", login: "ada", kind: "user", role: "write" };

const matrix = (legs: number) => `name: w
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [${Array.from({ length: legs }, (_, i) => i + 1).join(", ")}]
    steps: [{ run: echo test }]
`;

type Row = { id: string; status: string; fleet_held: number; placement_tries: number; container: string | null };

/**
 * Actions over an in-memory repository and D1, with a runner stand-in whose starts take `startMs`
 * and fail for the containers `refuse` names.
 */
function fixture(o: { startMs?: number; refuse?: (n: string) => string | null } = {}) {
  const sql = sqlStorage();
  sql.exec(REPO_SCHEMA);
  migrateRepoSchema(sql as unknown as SqlStorage);
  const DB = testD1();
  DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, created_at) VALUES ('acme', 'acme', 'org', 'active', ?)").run(new Date().toISOString());
  const started: string[] = [];
  let active = 0;
  let most = 0;
  const events: Array<{ type: string; payload: unknown }> = [];
  let alarms = 0;
  const repo = {
    sql,
    meta: { repoId: "r", owner: "acme", ownerId: "acme", ownerKind: "org", name: "app", defaultBranch: "main" },
    headRef: "refs/heads/main",
    getRef: () => null,
    upsertCheck: () => {},
    broadcast: () => {},
    emit: () => {},
    armAlarm: () => void alarms++,
    deploys: { jobCompleted: () => {}, protection: () => null },
    runtime: { sweepJob: async () => {} },
    policy: { agentOrigin: () => false },
  } as unknown as RepoDO;
  const env = {
    DB,
    PUBLIC_URL: "https://d.test",
    BUCKET: { put: async () => {}, get: async () => null },
    RUNNER: {
      idFromName: (n: string) => n,
      get: (n: string) => ({
        startJob: async () => {
          active++;
          most = Math.max(most, active);
          await new Promise((r) => setTimeout(r, o.startMs ?? 5));
          active--;
          const refused = o.refuse?.(n);
          if (refused) throw new Error(refused);
          started.push(n);
        },
        stopJob: async () => {},
      }),
    },
    RUN_WORKFLOW: { create: async () => {}, get: async () => ({ sendEvent: async (e: { type: string; payload: unknown }) => void events.push(e) }) },
  } as unknown as Env;
  const actions = new Actions(repo, env);
  const jobs = () => sql.exec("SELECT * FROM jobs ORDER BY rowid").toArray() as Row[];
  async function start(legs: number) {
    const { workflow } = parseWorkflow(matrix(legs), ".github/workflows/w.yml");
    Object.defineProperty(actions, "loadWorkflows", { value: async () => [{ path: ".github/workflows/w.yml", workflow, errors: [] }] });
    const run = (await actions.createRun(workflow!, { event: "push", ref: "refs/heads/main", sha: "abc", payload: {}, caller: ADA, title: "t" }))!;
    expect((await actions.plan(run.id)).error).toBeUndefined();
    return actions.startJobKey(run.id, "test");
  }
  return { DB, sql, actions, started, jobs, start, events, most: () => most, alarms: () => alarms };
}

describe("starting a matrix's hosted jobs", () => {
  it("starts several containers at once, up to the repository's share, and holds the rest", async () => {
    const f = fixture({ startMs: 20 });
    f.DB.sqlite.prepare("INSERT INTO account_quotas (account_id, hosted_jobs, updated_at, updated_by) VALUES ('acme', -1, ?, 'test')").run(new Date().toISOString());
    const legs = SHARE + 6;
    const t = Date.now();
    const { jobIds } = await f.start(legs);
    expect(jobIds).toHaveLength(legs);
    expect(f.started).toHaveLength(SHARE);
    // Not one after another: SHARE starts of 20 ms each took far less than SHARE * 20 ms.
    expect(f.most()).toBeGreaterThan(1);
    expect(f.most()).toBeLessThanOrEqual(8);
    expect(Date.now() - t).toBeLessThan(SHARE * 20);
    const rows = f.jobs();
    expect(rows.filter((j) => j.status === "waiting")).toHaveLength(SHARE);
    expect(rows.filter((j) => j.status === "queued" && j.fleet_held === 1)).toHaveLength(6);
  });

  it("holds the legs past the account's hosted jobs for its alarm, asking the quota once for them", async () => {
    const f = fixture();
    f.DB.sqlite.prepare("INSERT INTO account_quotas (account_id, hosted_jobs, updated_at, updated_by) VALUES ('acme', 3, ?, 'test')").run(new Date().toISOString());
    let quotaReads = 0;
    const prepare = f.DB.prepare.bind(f.DB);
    (f.DB as unknown as { prepare: typeof prepare }).prepare = (q: string) => {
      if (q.includes("FROM account_quotas")) quotaReads++;
      return prepare(q);
    };
    await f.start(10);
    expect(f.started).toHaveLength(3);
    const held = f.jobs().filter((j) => j.status === "queued" && j.fleet_held === 2);
    expect(held).toHaveLength(7);
    // Three admitted, the fourth told to wait; the other six joined it without asking again.
    expect(quotaReads).toBe(4);
    expect(f.alarms()).toBeGreaterThan(0);
  });

  it("puts a leg that got no machine back in line without holding up the others", async () => {
    let refused = false;
    const f = fixture({
      refuse: (n) => {
        if (refused || n !== `job-${f.jobs()[1]!.id}`) return null;
        refused = true;
        return "there is no container instance that can be provided to this durable object";
      },
    });
    await f.start(4);
    const rows = f.jobs();
    expect(f.started).toHaveLength(3);
    expect(rows[1]).toMatchObject({ status: "queued", placement_tries: 1, container: null });
    expect(f.events).toEqual([{ type: `job-${rows[1]!.id}`, payload: { retryInSeconds: 30 } }]);
  });
});
