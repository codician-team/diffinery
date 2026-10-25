import { describe, expect, it } from "vitest";
import { checkRepositoryQuota, checkStorageQuota, DEFAULT_QUOTAS, endCompute, fleetLimits, HOSTED_JOBS_LIMIT, mayStart, monthStart, quotasFor, setQuotas, startCompute, storageRefusal, storedBytes, usageOf } from "../../src/lib/quotas.js";
import type { Env } from "../../src/env.js";
import { testD1 } from "./stubs/d1.js";

const at = "2026-10-01T00:00:00.000Z";

function setup(vars: Record<string, string> = {}) {
  const DB = testD1();
  const add = (id: string, kind: string, siteAdmin = 0) => DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, site_admin, created_at) VALUES (?, ?, ?, 'active', ?, ?)").run(id, id, kind, siteAdmin, at);
  add("ann", "user");
  add("root", "user", 1);
  add("acme", "org");
  add("ops", "org");
  DB.sqlite.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('acme', 'ann', 'owner', ?), ('ops', 'root', 'owner', ?)").run(at, at);
  const usage = (id: string, account: string, kind: "job" | "sandbox", start: string, end: string | null) =>
    DB.sqlite.prepare("INSERT INTO compute_usage (id, account_id, repo_id, kind, started_at, ended_at) VALUES (?, ?, 'r', ?, ?, ?)").run(id, account, kind, start, end);
  return { env: { DB, ...vars } as unknown as Env, DB, usage };
}

describe("quotas", () => {
  it("uses the defaults, the environment's, then a site administrator's override", async () => {
    const { env } = setup();
    expect(await quotasFor(env, "ann")).toEqual({ ...DEFAULT_QUOTAS, exempt: false });
    const fromEnv = setup({ QUOTA_HOSTED_MINUTES: "120", QUOTA_SANDBOXES: "junk" }).env;
    expect((await quotasFor(fromEnv, "ann")).hosted_minutes).toBe(120);
    expect((await quotasFor(fromEnv, "ann")).sandboxes).toBe(DEFAULT_QUOTAS.sandboxes);
    await setQuotas(env, "ann", { hosted_jobs: 1, repositories: -1 }, "root");
    await setQuotas(env, "ann", { hosted_minutes: 10 }, "root");
    expect(await quotasFor(env, "ann")).toEqual({ ...DEFAULT_QUOTAS, hosted_jobs: 1, repositories: -1, hosted_minutes: 10, exempt: false });
    await setQuotas(env, "ann", { hosted_jobs: null }, "root");
    expect((await quotasFor(env, "ann")).hosted_jobs).toBe(DEFAULT_QUOTAS.hosted_jobs);
    await expect(setQuotas(env, "ann", { storage: 1 } as never, "root")).rejects.toThrow(/unknown quota storage/);
    await expect(setQuotas(env, "ann", { hosted_jobs: -5 }, "root")).rejects.toThrow(/whole number/);
  });

  it("doesn't limit accounts run by a site administrator", async () => {
    const { env } = setup();
    expect((await quotasFor(env, "root")).exempt).toBe(true);
    expect((await quotasFor(env, "ops")).exempt).toBe(true);
    expect((await quotasFor(env, "acme")).exempt).toBe(false);
  });

  it("counts this month's minutes and what is running now", async () => {
    const { env, usage } = setup();
    const now = new Date("2026-10-13T12:00:00.000Z");
    usage("j1", "acme", "job", "2026-10-13T10:00:00.000Z", "2026-10-13T10:10:30.000Z"); // 11 minutes (rounded up)
    usage("j2", "acme", "job", "2026-10-13T11:30:00.000Z", null); // running: 30 minutes so far
    usage("s1", "acme", "sandbox", "2026-10-13T11:00:00.000Z", null); // open: 60 minutes
    usage("j3", "acme", "job", "2026-09-30T23:50:00.000Z", "2026-10-01T00:20:00.000Z"); // 20 of its minutes are this month's
    usage("j4", "acme", "job", "2026-09-10T10:00:00.000Z", "2026-09-10T11:00:00.000Z"); // last month
    usage("j5", "acme", "job", "2026-10-12T00:00:00.000Z", null); // lost its end: counted as ended after 7 hours
    usage("j6", "ann", "job", "2026-10-13T11:00:00.000Z", null); // someone else's
    expect(await usageOf(env, "acme", now)).toEqual({ hosted_minutes: 11 + 30 + 60 + 20 + 420, hosted_jobs: 1, sandboxes: 1, repositories: 0, storage_bytes: 0 });
    expect(monthStart(now)).toBe("2026-10-01T00:00:00.000Z");
  });

  it("refuses work past the minutes, holds jobs past the running jobs, and refuses sandboxes past theirs", async () => {
    const { env } = setup();
    await setQuotas(env, "acme", { hosted_jobs: 1, sandboxes: 1 }, "root");
    expect(await mayStart(env, "acme", "job")).toEqual({ ok: true });
    await startCompute(env, { id: "job-a", accountId: "acme", repoId: "r", kind: "job" });
    expect(await mayStart(env, "acme", "job")).toMatchObject({ ok: false, wait: true });
    await endCompute(env, "job-a");
    await endCompute(env, "job-a");
    expect(await mayStart(env, "acme", "job")).toEqual({ ok: true });
    await startCompute(env, { id: "sb", accountId: "acme", repoId: "r", kind: "sandbox" });
    expect(await mayStart(env, "acme", "sandbox")).toMatchObject({ ok: false, wait: false, message: expect.stringMatching(/already has 1 agent sandboxes open/) });
    // A job still starts: sandboxes and jobs have their own counts.
    expect(await mayStart(env, "acme", "job")).toEqual({ ok: true });
    await setQuotas(env, "acme", { hosted_minutes: 0 }, "root");
    for (const kind of ["job", "sandbox"] as const) expect(await mayStart(env, "acme", kind)).toMatchObject({ ok: false, wait: false, message: expect.stringMatching(/used its 0 hosted minutes for this month/) });
    // The administrator's own organization is never held up.
    await setQuotas(env, "ops", { hosted_minutes: 0 }, "root");
    expect(await mayStart(env, "ops", "job")).toEqual({ ok: true });
  });

  it("holds every account, exempt ones too, to half the fleet, and the fleet to its limit", async () => {
    expect(fleetLimits({} as Env)).toEqual({ total: HOSTED_JOBS_LIMIT, share: HOSTED_JOBS_LIMIT / 2 });
    expect(fleetLimits({ HOSTED_JOBS_LIMIT: "9" } as Env)).toEqual({ total: 9, share: 4 });
    for (const junk of ["", "1", "-1", "lots"]) expect(fleetLimits({ HOSTED_JOBS_LIMIT: junk } as Env).total).toBe(HOSTED_JOBS_LIMIT);
    const { env, usage } = setup({ HOSTED_JOBS_LIMIT: "6" });
    const recent = new Date(Date.now() - 60_000).toISOString();
    await setQuotas(env, "acme", { hosted_jobs: -1 }, "root");
    // ops is run by a site administrator: no quota of its own, but still half the fleet (3 of 6).
    for (const id of ["o1", "o2"]) usage(id, "ops", "job", recent, null);
    expect(await mayStart(env, "ops", "job")).toEqual({ ok: true });
    usage("o3", "ops", "job", recent, null);
    expect(await mayStart(env, "ops", "job")).toMatchObject({ ok: false, wait: true, message: expect.stringMatching(/one account runs at most 3 at once, half of this Diffinery's hosted runners/) });
    // A sandbox isn't a job: the fleet's limits don't apply to it.
    expect(await mayStart(env, "ops", "sandbox")).toEqual({ ok: true });
    // acme, with no limit of its own, gets the other half; then the fleet is full for anyone.
    for (const id of ["a1", "a2"]) usage(id, "acme", "job", recent, null);
    expect(await mayStart(env, "acme", "job")).toEqual({ ok: true });
    usage("a3", "acme", "job", recent, null);
    expect(await mayStart(env, "ann", "job")).toMatchObject({ ok: false, wait: true, message: expect.stringMatching(/all 6 of this Diffinery's hosted runners are busy/) });
    // A job that ends frees its place, and a row left open past a job's longest run no longer counts.
    await endCompute(env, "o3");
    expect(await mayStart(env, "ann", "job")).toEqual({ ok: true });
    expect(await mayStart(env, "ops", "job")).toEqual({ ok: true });
    usage("stale", "ann", "job", new Date(Date.now() - 8 * 3600_000).toISOString(), null);
    expect(await mayStart(env, "ann", "job")).toEqual({ ok: true });
  });

  it("caps the repositories an account owns", async () => {
    const { env, DB } = setup();
    await setQuotas(env, "ann", { repositories: 1 }, "root");
    await checkRepositoryQuota(env, "ann", "ann");
    DB.sqlite.prepare("INSERT INTO repos (id, owner_id, name, description, visibility, default_branch, created_at, updated_at) VALUES ('r1', 'ann', 'one', '', 'private', 'main', ?, ?)").run(at, at);
    await expect(checkRepositoryQuota(env, "ann", "ann")).rejects.toThrow(/ann has reached its limit of 1 repositories/);
    await setQuotas(env, "ann", { repositories: -1 }, "root");
    await checkRepositoryQuota(env, "ann", "ann");
  });
});

describe("storage quota", () => {
  /** acme's repositories r1 (reported 1000 bytes) and r2 (never measured), ann's r3; `measured` lists the repositories asked to report. */
  function storage(vars: Record<string, string> = {}) {
    const s = setup(vars);
    const repo = (id: string, owner: string) => s.DB.sqlite.prepare("INSERT INTO repos (id, owner_id, name, description, visibility, default_branch, created_at, updated_at) VALUES (?, ?, ?, '', 'private', 'main', ?, ?)").run(id, owner, id, at, at);
    const report = (id: string, bytes: number) => s.DB.sqlite.prepare("INSERT INTO repo_storage (repo_id, bytes, updated_at) VALUES (?, ?, ?) ON CONFLICT(repo_id) DO UPDATE SET bytes = excluded.bytes").run(id, bytes, at);
    repo("r1", "acme");
    repo("r2", "acme");
    repo("r3", "ann");
    report("r1", 1000);
    report("r3", 5000);
    const measured: string[] = [];
    // A repository asked to report writes its row, as RepoDO.reportStorage does.
    const REPO = { idFromName: (id: string) => id, get: (id: string) => ({ reportStorage: async () => (measured.push(id), report(id, 200)) }) };
    const env = { ...s.env, REPO } as unknown as Env;
    return { ...s, env, repo, report, measured };
  }

  it("is 10 GB by default, from QUOTA_STORAGE_BYTES, or a site administrator's override up to 1 PiB", async () => {
    expect(DEFAULT_QUOTAS.storage_bytes).toBe(10 * 1024 ** 3);
    const { env } = storage();
    expect((await quotasFor(env, "acme")).storage_bytes).toBe(10 * 1024 ** 3);
    expect((await quotasFor(storage({ QUOTA_STORAGE_BYTES: "2048" }).env, "acme")).storage_bytes).toBe(2048);
    await setQuotas(env, "acme", { storage_bytes: 100 * 1024 ** 4 }, "root");
    expect((await quotasFor(env, "acme")).storage_bytes).toBe(100 * 1024 ** 4);
    await expect(setQuotas(env, "acme", { storage_bytes: 2 ** 51 }, "root")).rejects.toThrow(/whole number/);
    expect((await quotasFor(env, "root")).storage_bytes).toBe(-1);
  });

  it("adds up the account's repositories, measuring those that never reported, and its packages", async () => {
    const { env, DB, measured } = storage();
    // r2 never reported: it is asked once, then its report counts.
    expect(await storedBytes(env, "acme")).toBe(1000 + 200);
    expect(measured).toEqual(["r2"]);
    expect(await storedBytes(env, "acme")).toBe(1200);
    expect(measured).toEqual(["r2"]);
    // A repository counting its own bytes replaces its report.
    expect(await storedBytes(env, "acme", { repoId: "r1", bytes: 1500 })).toBe(1500 + 200);
    // Packages: each blob once however many of the account's packages use it, plus the manifests.
    const p = (id: string, owner: string) => DB.sqlite.prepare("INSERT INTO packages (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, owner, id, at, at);
    p("p1", "acme");
    p("p2", "acme");
    p("p3", "ann");
    DB.sqlite.prepare("INSERT INTO registry_blobs (digest, size, r2_key, created_at) VALUES ('sha256:a', 300, 'k1', ?), ('sha256:b', 40, 'k2', ?)").run(at, at);
    DB.sqlite.prepare("INSERT INTO package_blobs (package_id, digest, created_at) VALUES ('p1', 'sha256:a', ?), ('p2', 'sha256:a', ?), ('p3', 'sha256:b', ?)").run(at, at, at);
    DB.sqlite.prepare("INSERT INTO package_manifests (package_id, digest, media_type, size, created_at) VALUES ('p1', 'sha256:m', 'x', 7, ?)").run(at);
    expect(await storedBytes(env, "acme")).toBe(1200 + 300 + 7);
    expect(await storedBytes(env, "ann")).toBe(5000 + 40);
    expect((await usageOf(env, "acme")).storage_bytes).toBe(1507);
    // A deleted repository's report goes with it.
    DB.sqlite.prepare("DELETE FROM repos WHERE id = 'r1'").run();
    expect(await storedBytes(env, "acme")).toBe(507);
  });

  it("refuses a write that would take the account past its quota, naming the account and the limit", async () => {
    const { env } = storage();
    await setQuotas(env, "acme", { storage_bytes: 1300 }, "root");
    expect(await storageRefusal(env, "acme", "acme", 100)).toBeNull();
    expect(await storageRefusal(env, "acme", "acme", 101)).toMatch(/^acme has reached its storage limit of 1300 bytes/);
    await expect(checkStorageQuota(env, "acme", "acme", 101)).rejects.toThrow(/403: acme has reached its storage limit of 1300 bytes/);
    // The repository's own count, fresher than its report, decides.
    expect(await storageRefusal(env, "acme", "acme", 0, { repoId: "r1", bytes: 1200 })).toMatch(/storage limit/);
    await setQuotas(env, "acme", { storage_bytes: -1 }, "root");
    expect(await storageRefusal(env, "acme", "acme", 1e12)).toBeNull();
    // Accounts run by a site administrator have no limit.
    await setQuotas(env, "ops", { storage_bytes: 0 }, "root");
    expect(await storageRefusal(env, "ops", "ops", 1e12)).toBeNull();
  });
});
