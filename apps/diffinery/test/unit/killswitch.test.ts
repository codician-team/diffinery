import { describe, expect, it } from "vitest";
import { blockedBy, changePause, changeSuspension, cleanReason, computePause, killSwitches, runningCompute, suspendedList, suspensionOf } from "../../src/lib/killswitch.js";
import type { Env } from "../../src/env.js";
import { testD1 } from "./stubs/d1.js";

const at = "2026-10-01T00:00:00.000Z";

/** A D1 with accounts ann (a person, site administrator) and acme (an organization), and repositories r1, r2 (acme's) and r3 (ann's); REPO answers stopActions. */
function setup() {
  const DB = testD1();
  const add = (id: string, kind: string, siteAdmin = 0) => DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, site_admin, created_at) VALUES (?, ?, ?, 'active', ?, ?)").run(id, id, kind, siteAdmin, at);
  add("ann", "user", 1);
  add("acme", "org");
  const repo = (id: string, owner: string) => DB.sqlite.prepare("INSERT INTO repos (id, owner_id, name, description, visibility, default_branch, created_at, updated_at) VALUES (?, ?, ?, '', 'private', 'main', ?, ?)").run(id, owner, id, at, at);
  repo("r1", "acme");
  repo("r2", "acme");
  repo("r3", "ann");
  const stops: Array<{ repo: string; hostedOnly: boolean; message: string }> = [];
  const REPO = {
    idFromName: (n: string) => n,
    get: (id: string) => ({
      stopActions: async (o: { hostedOnly: boolean; message: string }) => {
        stops.push({ repo: id, ...o });
        if (id === "broken") throw new Error("gone");
        return { runs: 1, jobs: 2, sandboxes: 1 };
      },
    }),
  };
  const audits: Array<{ action: string; target?: string; detail?: unknown }> = [];
  const audit = async (e: { action: string; target?: string; detail?: unknown }) => void audits.push(e);
  return { env: { DB, REPO } as unknown as Env, DB, stops, audits, audit };
}

const ann = { id: "ann", login: "ann" };

describe("kill switches", () => {
  it("block nothing until one is on", async () => {
    const { env } = setup();
    const k = await killSwitches(env, "r1");
    expect(k).toEqual({ repo: null, account: null, paused: null });
    for (const w of ["run", "hosted-job", "self-hosted-job", "sandbox"] as const) expect(blockedBy(k, w)).toBeNull();
  });

  it("suspending a repository stops all its work, and lifting it only allows new work", async () => {
    const { env, stops, audits, audit } = setup();
    const stopped = await changeSuspension(env, audit, ann, { kind: "repo", id: "r1", name: "acme/r1" }, "crypto mining", "api");
    expect(stopped).toEqual({ repositories: 1, runs: 1, jobs: 2, sandboxes: 1, failed: 0 });
    expect(stops).toEqual([{ repo: "r1", hostedOnly: false, message: "Actions are suspended for this repository by a site administrator: crypto mining" }]);
    const k = await killSwitches(env, "r1");
    expect(k.repo).toMatchObject({ by: "ann", reason: "crypto mining" });
    for (const w of ["run", "hosted-job", "self-hosted-job", "sandbox"] as const) expect(blockedBy(k, w)).toBe("Actions are suspended for this repository by a site administrator: crypto mining");
    // Its neighbour isn't.
    expect(blockedBy(await killSwitches(env, "r2"), "run")).toBeNull();
    expect(audits).toEqual([{ actorId: "ann", actorLogin: "ann", action: "actions.suspend", target: "acme/r1", detail: { kind: "repo", reason: "crypto mining", via: "api", stopped } }]);

    expect(await changeSuspension(env, audit, ann, { kind: "repo", id: "r1", name: "acme/r1" }, null, "web")).toBeNull();
    expect(blockedBy(await killSwitches(env, "r1"), "run")).toBeNull();
    expect(stops).toHaveLength(1);
    expect(audits[1]).toEqual({ actorId: "ann", actorLogin: "ann", action: "actions.unsuspend", target: "acme/r1", detail: { kind: "repo", via: "web" } });
    // Lifting what isn't suspended changes nothing and isn't recorded.
    await changeSuspension(env, audit, ann, { kind: "repo", id: "r1", name: "acme/r1" }, null, "web");
    expect(audits).toHaveLength(2);
  });

  it("suspending an account covers every repository it owns, even a site administrator's", async () => {
    const { env, stops, audit } = setup();
    await changeSuspension(env, audit, ann, { kind: "account", id: "acme", login: "acme" }, "abuse", "api");
    expect(stops.map((s) => s.repo).sort()).toEqual(["r1", "r2"]);
    expect(stops[0]!.message).toBe("Actions are suspended for every repository of acme by a site administrator: abuse");
    for (const r of ["r1", "r2"]) expect(blockedBy(await killSwitches(env, r), "self-hosted-job")).toMatch(/every repository of acme/);
    expect(blockedBy(await killSwitches(env, "r3"), "run")).toBeNull();
    // Nobody is exempt: ann is a site administrator.
    await changeSuspension(env, audit, ann, { kind: "account", id: "ann", login: "ann" }, "testing", "web");
    expect(blockedBy(await killSwitches(env, "r3"), "sandbox")).toMatch(/every repository of ann/);
    expect(await suspensionOf(env, { accountId: "acme" })).toMatchObject({ by: "ann", reason: "abuse" });
    const list = await suspendedList(env);
    expect(list.accounts.map((a) => a.login).sort()).toEqual(["acme", "ann"]);
    expect(list.repos).toEqual([]);
  });

  it("pausing hosted compute stops hosted jobs and sandboxes only, in the repositories running some", async () => {
    const { env, DB, stops, audits, audit } = setup();
    const usage = (id: string, repo: string, kind: "job" | "sandbox", start: string, end: string | null = null) =>
      DB.sqlite.prepare("INSERT INTO compute_usage (id, account_id, repo_id, kind, started_at, ended_at) VALUES (?, 'acme', ?, ?, ?, ?)").run(id, repo, kind, start, end);
    const recent = new Date(Date.now() - 60_000).toISOString();
    usage("j1", "r1", "job", recent);
    usage("s1", "r2", "sandbox", recent, recent);
    usage("s1:1", "r2", "sandbox", recent); // woke up after sleeping
    usage("j2", "r3", "job", recent, recent); // ended
    usage("j3", "r3", "job", new Date(Date.now() - 8 * 3600_000).toISOString()); // lost its end long ago
    const running = await runningCompute(env);
    expect([...running.entries()].sort()).toEqual([
      ["r1", { jobs: ["j1"], sandboxes: [] }],
      ["r2", { jobs: [], sandboxes: ["s1"] }],
    ]);

    const stopped = await changePause(env, audit, ann, "cost overrun", "api");
    expect(stopped).toMatchObject({ repositories: 2, failed: 0 });
    expect(stops.map((s) => [s.repo, s.hostedOnly]).sort()).toEqual([
      ["r1", true],
      ["r2", true],
    ]);
    expect(stops[0]!.message).toBe("Hosted runners are paused on this instance by a site administrator: cost overrun. Self-hosted runners still work");
    const k = await killSwitches(env, "r3");
    expect(blockedBy(k, "hosted-job")).toMatch(/^Hosted runners are paused on this instance by a site administrator: cost overrun/);
    expect(blockedBy(k, "sandbox")).toBe("Agent sandboxes are paused on this instance by a site administrator: cost overrun");
    // Self-hosted runners still work, and runs still start (for them).
    expect(blockedBy(k, "self-hosted-job")).toBeNull();
    expect(blockedBy(k, "run")).toBeNull();
    expect(await computePause(env)).toMatchObject({ by: "ann", reason: "cost overrun" });
    expect(audits[0]).toMatchObject({ action: "compute.pause", detail: { reason: "cost overrun", via: "api" } });

    expect(await changePause(env, audit, ann, null, "web")).toBeNull();
    expect(await computePause(env)).toBeNull();
    expect(blockedBy(await killSwitches(env, "r3"), "hosted-job")).toBeNull();
    expect(audits[1]).toMatchObject({ action: "compute.unpause", detail: { via: "web" } });
    expect(stops).toHaveLength(2);
  });

  it("counts repositories that couldn't be stopped, and needs a reason", async () => {
    const { env, DB, audit } = setup();
    DB.sqlite.prepare("INSERT INTO compute_usage (id, account_id, repo_id, kind, started_at) VALUES ('j', 'acme', 'broken', 'job', ?)").run(new Date().toISOString());
    expect(await changePause(env, audit, ann, "x", "api")).toMatchObject({ repositories: 0, failed: 1 });
    expect(() => cleanReason("  ")).toThrow(/give a reason/);
    expect(() => cleanReason(undefined)).toThrow(/give a reason/);
    expect(() => cleanReason("x".repeat(501))).toThrow(/at most 500/);
    expect(cleanReason("  too   many\nspaces ")).toBe("too many spaces");
  });
});
