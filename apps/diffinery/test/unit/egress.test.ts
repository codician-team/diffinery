import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { egressFor, egressStart, type Egress } from "../../src/lib/egress.js";
import { Actions } from "../../src/repo/actions.js";
import { REPO_SCHEMA, migrateRepoSchema } from "../../src/repo/schema.js";
import type { RepoDO } from "../../src/repo/RepoDO.js";
import type { Caller } from "../../src/repo/types.js";
import type { Env } from "../../src/env.js";
import { testD1 } from "./stubs/d1.js";

const at = "2026-10-01T00:00:00.000Z";

/** Accounts as in quotas.test.ts: ann and her organization acme, root (a site administrator) and his organization ops. */
function accounts() {
  const DB = testD1();
  const add = (id: string, kind: string, siteAdmin = 0) => DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, site_admin, created_at) VALUES (?, ?, ?, 'active', ?, ?)").run(id, id, kind, siteAdmin, at);
  add("ann", "user");
  add("root", "user", 1);
  add("acme", "org");
  add("ops", "org");
  DB.sqlite.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('acme', 'ann', 'owner', ?), ('ops', 'root', 'owner', ?)").run(at, at);
  return DB;
}

function sqlStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...args: unknown[]) {
      const params = args.map((a) => (a === undefined ? null : a)) as Array<string | number | null>;
      let rows: unknown[] = [];
      if (!params.length && query.trim().replace(/;\s*$/, "").includes(";")) db.exec(query);
      else rows = db.prepare(query).all(...params);
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
}

/** A repository owned by `owner` whose hosted job launch and sandbox boot record the egress they're given. */
function repository(owner: string, vars: Record<string, string>) {
  const sql = sqlStorage();
  sql.exec(REPO_SCHEMA);
  migrateRepoSchema(sql as unknown as SqlStorage);
  const started: { job?: Egress; sandbox?: Egress } = {};
  const repo = {
    sql,
    meta: { repoId: "r", owner, ownerId: owner, name: "app", defaultBranch: "main" },
    upsertCheck: () => {},
    broadcast: () => {},
    resolve: async () => "abc",
  } as unknown as RepoDO;
  const env = {
    DB: accounts(),
    PUBLIC_URL: "https://d.test",
    ...vars,
    RUNNER: { idFromName: (n: string) => n, get: () => ({ startJob: async (i: { egress?: Egress }) => void (started.job = i.egress) }) },
    SANDBOX: { idFromName: (n: string) => n, get: () => ({ boot: async (...a: unknown[]) => void (started.sandbox = a[4] as Egress) }) },
  } as unknown as Env;
  const actions = new Actions(repo, env);
  const t = new Date().toISOString();
  sql.exec("INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, event_payload) VALUES ('run1', 1, 'w.yml', 'w', 'push', 'refs/heads/main', 'abc', '{}', 'in_progress', ?, ?, '{}')", t, t);
  sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status) VALUES ('j1', 'run1', 'k', 'k', 'queued')");
  const caller = { id: "ann", login: "ann", kind: "user", role: "write" } as Caller;
  return {
    started,
    async run() {
      await (actions as unknown as { launch(id: string): Promise<void> }).launch("j1");
      await actions.createSandbox(caller);
      return started;
    },
  };
}

describe("egress of hosted compute", () => {
  it("is open unless EGRESS is web, and a site administrator's accounts stay open", async () => {
    const DB = accounts();
    const env = (vars: Record<string, string> = {}) => ({ DB, ...vars }) as unknown as Env;
    for (const id of ["ann", "acme", "root", "ops"]) {
      expect(await egressFor(env(), id)).toBe("open");
      expect(await egressFor(env({ EGRESS: "open" }), id)).toBe("open");
      expect(await egressFor(env({ EGRESS: "everything" }), id)).toBe("open");
    }
    expect(await egressFor(env({ EGRESS: "web" }), "ann")).toBe("web");
    expect(await egressFor(env({ EGRESS: "web" }), "acme")).toBe("web");
    expect(await egressFor(env({ EGRESS: "web" }), "root")).toBe("open");
    expect(await egressFor(env({ EGRESS: "web" }), "ops")).toBe("open");
  });

  it("web starts a container without internet, HTTP and HTTPS to every host through the Worker", () => {
    expect(egressStart("open")).toEqual({ enableInternet: true, interceptHttps: false, envVars: {} });
    expect(egressStart("web")).toEqual({ enableInternet: false, interceptHttps: true, allowedHosts: ["*"], envVars: { DIFFINERY_EGRESS: "web" } });
  });

  it("the repository owner's policy reaches its hosted jobs and sandboxes", async () => {
    expect(await repository("acme", {}).run()).toEqual({ job: "open", sandbox: "open" });
    expect(await repository("acme", { EGRESS: "web" }).run()).toEqual({ job: "web", sandbox: "web" });
    expect(await repository("ann", { EGRESS: "web" }).run()).toEqual({ job: "web", sandbox: "web" });
    // Diffinery's own pipelines run in a site administrator's organization: they keep their egress.
    expect(await repository("ops", { EGRESS: "web" }).run()).toEqual({ job: "open", sandbox: "open" });
  });
});
