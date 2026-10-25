import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { sha256 } from "../../src/lib/util.js";
import { Actions, MAX_JOB_TOKEN_TTL_MS, jobTokenExpiry } from "../../src/repo/actions.js";
import type { RepoDO } from "../../src/repo/RepoDO.js";
import { REPO_SCHEMA, migrateRepoSchema } from "../../src/repo/schema.js";

const HOUR = 3600_000;
const t0 = Date.parse("2026-10-16T00:00:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();

describe("when a job token expires", () => {
  it("counts the job's timeout plus half an hour from when it started", () => {
    expect(jobTokenExpiry({ started_at: at(t0), token_at: at(t0 - HOUR), timeout_minutes: 60 })).toBe(t0 + 1.5 * HOUR);
    // The longest timeout a job can have (360 minutes) still gets its margin.
    expect(jobTokenExpiry({ started_at: at(t0), token_at: null, timeout_minutes: 360 })).toBe(t0 + 6.5 * HOUR);
  });

  it("counts from when the token was issued while the job hasn't started", () => {
    expect(jobTokenExpiry({ started_at: null, token_at: at(t0), timeout_minutes: 10 })).toBe(t0 + 40 * 60_000);
  });

  it("never lasts more than seven hours, whatever the row says", () => {
    expect(jobTokenExpiry({ started_at: at(t0), token_at: null, timeout_minutes: 100_000 })).toBe(t0 + MAX_JOB_TOKEN_TTL_MS);
    expect(jobTokenExpiry({ started_at: at(t0), token_at: null, timeout_minutes: -5 })).toBe(t0 + 30 * 60_000);
  });

  it("is unknown without a start or issue time", () => {
    expect(jobTokenExpiry({ started_at: null, token_at: null, timeout_minutes: 60 })).toBeNull();
  });
});

/** A minimal SqlStorage over node:sqlite with the repository schema. */
function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  db.exec(REPO_SCHEMA);
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        const rows = stmt.all(...(bindings as never[]));
        return { toArray: () => rows, one: () => rows[0] } as unknown as SqlStorageCursor<Record<string, SqlStorageValue>>;
      }
      stmt.run(...(bindings as never[]));
      return { toArray: () => [], one: () => undefined } as unknown as SqlStorageCursor<Record<string, SqlStorageValue>>;
    },
  } as unknown as SqlStorage;
  migrateRepoSchema(sql);
  return sql;
}

describe("job tokens", () => {
  afterEach(() => void vi.useRealTimers());

  async function fixture(o: { started_at: string | null; token_at: string | null; status?: string; timeout?: number }) {
    const sql = sqlStorage();
    const token = "djt_r_j1_secretsecretsecret";
    sql.exec("INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, event_payload) VALUES ('run1', 1, 'w.yml', 'w', 'push', 'refs/heads/main', 'abc', '{}', 'in_progress', ?, ?, '{}')", at(t0), at(t0));
    sql.exec(
      "INSERT INTO jobs (id, run_id, job_key, name, status, matrix, strategy, timeout_minutes, token_hash, token_at, started_at) VALUES ('j1', 'run1', 'build', 'build', ?, '{}', '{}', ?, ?, ?, ?)",
      o.status ?? "in_progress",
      o.timeout ?? 60,
      await sha256(token),
      o.token_at,
      o.started_at,
    );
    const repo = { sql, meta: { repoId: "r" }, runtime: { grantFor: () => ({ role: "write", permissions: {} }) } } as unknown as RepoDO;
    return { actions: new Actions(repo, {} as Env), token, sql };
  }

  it("work while the job is within its timeout and margin, and not after, even if it never completes", async () => {
    const { actions, token } = await fixture({ started_at: at(t0), token_at: at(t0 - 60_000) });
    vi.useFakeTimers({ now: t0 + 89 * 60_000 });
    expect((await actions.runnerAuth(token))?.kind).toBe("job");
    vi.setSystemTime(t0 + 90 * 60_000);
    expect(await actions.runnerAuth(token)).toBeNull();
  });

  it("issued for a job that never started stop working too", async () => {
    const { actions, token } = await fixture({ started_at: null, token_at: at(t0), status: "waiting" });
    vi.useFakeTimers({ now: t0 + 60_000 });
    expect((await actions.runnerAuth(token))?.kind).toBe("job");
    vi.setSystemTime(t0 + 2 * HOUR);
    expect(await actions.runnerAuth(token)).toBeNull();
  });

  it("issued before token_at was recorded count from the upgrade", async () => {
    const sql = sqlStorage();
    // Drop the column and add it back, as an upgrade would, over a job holding a token.
    sql.exec("ALTER TABLE jobs DROP COLUMN token_at");
    sql.exec("INSERT INTO runs (id, run_number, workflow_path, workflow_name, event, ref, sha, actor, status, created_at, updated_at, event_payload) VALUES ('run1', 1, 'w.yml', 'w', 'push', 'refs/heads/main', 'abc', '{}', 'in_progress', ?, ?, '{}')", at(t0), at(t0));
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status, matrix, strategy, token_hash) VALUES ('j1', 'run1', 'build', 'build', 'waiting', '{}', '{}', 'h')");
    sql.exec("INSERT INTO jobs (id, run_id, job_key, name, status, matrix, strategy) VALUES ('j2', 'run1', 'test', 'test', 'queued', '{}', '{}')");
    migrateRepoSchema(sql);
    const rows = sql.exec<{ id: string; token_at: string | null }>("SELECT id, token_at FROM jobs ORDER BY id").toArray();
    expect(Date.parse(rows[0]!.token_at!)).toBeGreaterThan(Date.now() - 60_000);
    expect(rows[1]!.token_at).toBeNull();
  });
});
