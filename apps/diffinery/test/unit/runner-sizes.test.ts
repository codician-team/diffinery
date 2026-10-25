import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { BUSY_BUCKETS, type JobUsage } from "@diffinery/shared";
import { parseWorkflow } from "@diffinery/workflow-yaml";
import { Actions } from "../../src/repo/actions.js";
import { REPO_SCHEMA, migrateRepoSchema } from "../../src/repo/schema.js";
import { chooseSize, cleanUsage, containerName, describeSize, hostFactor, hostModel, sizeLabel, sizeOfContainer, peakCores, slowLimit, type SizedRun } from "../../src/runner/sizes.js";
import { testD1 } from "./stubs/d1.js";
import type { RepoDO } from "../../src/repo/RepoDO.js";
import type { Env } from "../../src/env.js";
import type { Caller } from "../../src/repo/types.js";

const GiB = 1024 ** 3;

/** A measured run: `busy` maps busy cores (a bucket's upper bound) to seconds spent there. */
function usage(o: { seconds?: number; memGiB?: number; diskGB?: number; busy?: Record<number, number>; cores?: number; saturated?: number; oom?: number | null } = {}): JobUsage {
  const seconds = o.seconds ?? 120;
  const busy = o.busy ?? { 0.1: seconds };
  const busySeconds = BUSY_BUCKETS.map((b) => busy[b] ?? 0);
  return {
    seconds,
    cpuSeconds: Object.entries(busy).reduce((a, [c, s]) => a + Number(c) * s, 0),
    coresP95: 0,
    coresMax: 0,
    saturated: o.saturated ?? 0,
    busySeconds,
    windowSeconds: 0.25,
    memoryPeak: (o.memGiB ?? 0.3) * GiB,
    diskPeak: (o.diskGB ?? 1.5) * 1e9,
    cores: o.cores ?? 4,
    memory: 12 * GiB,
    disk: 20e9,
    oomKills: o.oom === undefined ? 0 : o.oom,
  };
}
/** Host processors as the runner describes them (`Host:` lines seen on 2026-10-16). */
const ZEN2 = "AMD EPYC 7B12 64-Core Processor (family 23, model 49), 4 vCPUs, 2250 MHz";
const ZEN4 = "AMD EPYC 9654 96-Core Processor (family 25, model 17), 4 vCPUs, 2400 MHz";
/** A run, on a Zen 2 host (the slowest generation, so busy cores count nearly as measured) unless `cpu` says otherwise. */
const ran = (u: JobUsage | null, size: SizedRun["size"] = "large", conclusion = "success", cpu: string | null = ZEN2): SizedRun => ({ conclusion, size, usage: u, cpu });
/** The run, then enough measured runs like it behind it to size by. */
const runs = (...first: SizedRun[]) => [...first, ...Array.from({ length: Math.max(0, 3 - first.length) }, () => ran(usage()))];

describe("runner sizes", () => {
  it("reads a size from runs-on labels, the largest when several", () => {
    expect(sizeLabel(["ubuntu-latest"])).toBeNull();
    expect(sizeLabel(["ubuntu-latest", "diffinery-small"])).toBe("small");
    expect(sizeLabel(["Diffinery-Tiny", "diffinery-medium"])).toBe("medium");
    expect(sizeLabel(["diffinery-huge"])).toBeNull();
  });

  it("names containers by size, and large ones as before", () => {
    expect(containerName("j1", 0, "large")).toBe("job-j1");
    expect(containerName("j1", 2, "large")).toBe("job-j1-r2");
    expect(containerName("j1", 1, "small")).toBe("job-j1-r1.small");
    expect(containerName("j1", 1, "small", 2)).toBe("job-j1-r1-p2.small");
    expect(sizeOfContainer("job-j1-p2.medium")).toBe("medium");
    expect(sizeOfContainer("job-j1-r1.small")).toBe("small");
    expect(sizeOfContainer("job-j1")).toBe("large");
  });

  it("stays large without history, after a re-run, or when a run wasn't measured", () => {
    expect(chooseSize([]).size).toBe("large");
    expect(chooseSize(runs(), { rerun: true }).size).toBe("large");
    expect(chooseSize(runs(ran(usage()), ran(null))).size).toBe("large");
    // Two measured runs aren't enough to size by.
    expect(chooseSize([ran(usage()), ran(usage())]).why).toContain("fewer than 3");
  });

  it("gives a job that waits on the network the smallest runner", () => {
    const c = chooseSize(runs(ran(usage({ memGiB: 0.3 })), ran(usage({ memGiB: 0.25 }))));
    expect(c.size).toBe("tiny");
    expect(c.why).toContain("last 3 runs");
  });

  it("keeps memory headroom: 1.5 times the peak plus half a GiB", () => {
    // 0.4 GiB * 1.5 + 0.5 = 1.1 GiB: more than tiny's 1 GiB, so small.
    expect(chooseSize(runs(ran(usage({ memGiB: 0.4 })))).size).toBe("small");
    // 5.5 GiB * 1.5 + 0.5 = 8.75 GiB: more than medium's 8 GiB, so large even with little CPU.
    expect(chooseSize(runs(ran(usage({ memGiB: 5.5 })))).size).toBe("large");
    // The largest of the recent runs counts.
    expect(chooseSize(runs(ran(usage({ memGiB: 0.2 })), ran(usage({ memGiB: 5.5 })))).size).toBe("large");
  });

  it("keeps disk headroom", () => {
    // 2.5 GB * 1.25 + 1 = 4.1 GB: more than tiny's 4 GB.
    expect(chooseSize(runs(ran(usage({ diskGB: 2.5 })))).size).toBe("small");
    expect(chooseSize(runs(ran(usage({ diskGB: 14 })))).size).toBe("large");
  });

  it("never gives a job fewer vCPUs than it kept busy, even for a few seconds", () => {
    // Two minutes at 3 cores: CPU-bound, so large.
    const busy = usage({ seconds: 130, busy: { 0.1: 10, 3: 120 }, memGiB: 2 });
    expect(peakCores(busy)).toBe(3);
    expect(chooseSize(runs(ran(busy))).size).toBe("large");
    // Mostly idle, but a few seconds at 3 cores (a test suite's burst): still large, since timing-sensitive
    // work can miss its own timeouts on fewer cores however short the burst.
    const burst = usage({ seconds: 300, busy: { 0.1: 290, 3: 10 }, memGiB: 2 });
    expect(chooseSize(runs(ran(burst))).size).toBe("large");
    // The peak reported by the runner counts even where the buckets show less, with half as much again
    // to spare: 0.4 cores needs 0.6, more than small's half vCPU.
    expect(chooseSize(runs(ran({ ...usage(), coresMax: 0.4 }))).size).toBe("medium");
    expect(chooseSize(runs(ran({ ...usage(), coresMax: 0.25 }))).size).toBe("small");
    // Steady single-core work fits medium's 2 vCPU but not half a vCPU.
    expect(chooseSize(runs(ran(usage({ seconds: 200, busy: { 1: 200 }, memGiB: 1 })))).size).toBe("medium");
  });

  it("moves a job back to large after it ran out of memory or failed on a smaller runner", () => {
    expect(chooseSize(runs(ran(usage({ oom: 1 })))).size).toBe("large");
    expect(chooseSize(runs(ran(usage(), "tiny", "failure"))).size).toBe("large");
    expect(chooseSize(runs(ran(usage(), "small", "timed_out"))).size).toBe("large");
    // A failure on large isn't the size's doing; cancelled runs don't count.
    expect(chooseSize(runs(ran(usage(), "large", "failure"))).size).toBe("tiny");
    expect(chooseSize([ran(null, "large", "cancelled"), ...runs()]).size).toBe("tiny");
  });

  it("moves a job back to large after it took longer on a smaller runner", () => {
    const large = (seconds: number) => ran(usage({ seconds }));
    const history = [large(100), large(110), large(90), large(300)];
    // Typical on large: 100 s (the median). 111 s on tiny is within a tenth and 2 s; 113 s isn't.
    expect(chooseSize([ran(usage({ seconds: 111 }), "tiny"), ...history]).size).toBe("tiny");
    const c = chooseSize([ran(usage({ seconds: 113 }), "tiny"), ...history]);
    expect(c.size).toBe("large");
    expect(c.why).toContain("took longer on a tiny runner");
    // Large runs further back still give the typical time.
    const old = [...Array.from({ length: 5 }, () => ran(usage({ seconds: 300 }), "tiny")), large(100), large(100)];
    expect(chooseSize(old).size).toBe("large");
  });

  it("counts busy cores as on the slowest host, since a job can land there", () => {
    expect(hostModel(ZEN4)).toBe("25/17");
    expect(hostModel("Intel something")).toBeNull();
    expect(hostFactor(ZEN2)).toBeCloseTo(1.14, 2);
    expect(hostFactor(ZEN4)).toBeCloseTo(2.19, 2);
    // An unknown processor counts as the fastest.
    expect(hostFactor(null)).toBe(hostFactor(ZEN4));
    // 0.25 cores on Zen 2 fits small's half vCPU with headroom; the same 0.25 cores on Zen 4 is about 0.55
    // on the slowest host, so medium.
    const quarter = usage({ busy: { 0.25: 120 } });
    expect(chooseSize(runs(ran(quarter), ran(quarter), ran(quarter))).size).toBe("small");
    const fast = ran(quarter, "large", "success", ZEN4);
    expect(chooseSize([fast, ran(quarter), ran(quarter)]).size).toBe("medium");
    // Unknown hosts: a mostly idle job gets small, not tiny.
    expect(chooseSize([ran(usage(), "large", "success", null), ran(usage()), ran(usage())]).size).toBe("small");
  });

  it("allows for a job's own noise on large, and no more", () => {
    const large = (seconds: number[]) => seconds.map((s) => ran(usage({ seconds: s })));
    // A lint job that took 9 to 14 s on large (median 11): 14.1 s is the limit.
    expect(slowLimit(large([9, 10, 11, 12, 14]), ZEN2)).toBeCloseTo(14.1, 5);
    // 15 s on tiny is slower than any of them: back to large. 13 s on medium is within its noise.
    const lint = large([9, 10, 11, 12, 14]);
    expect(chooseSize([ran(usage({ seconds: 15 }), "tiny"), ...lint]).size).toBe("large");
    expect(chooseSize([ran(usage({ seconds: 13 }), "medium"), ...lint]).size).not.toBe("large");
    // A job whose large runs vary a lot (a deploy waiting on another service) is judged by its slowest but one.
    expect(slowLimit(large([45, 60, 80, 120, 150]), ZEN2)).toBe(120);
    // Fewer than 5 runs: the median rule alone.
    expect(slowLimit(large([45, 150]), ZEN2)).toBeCloseTo(51.5, 5);
    expect(slowLimit([], ZEN2)).toBeNull();
  });

  it("counts runs measured over 2-second windows as not measured", () => {
    const coarse = { ...usage(), windowSeconds: 2 };
    const old = { ...usage() } as JobUsage;
    delete old.windowSeconds;
    expect(chooseSize(runs(ran(coarse))).why).toContain("closely enough");
    expect(chooseSize(runs(ran(old))).size).toBe("large");
  });

  it("keeps a job with short single-core bursts on a runner with a whole core to spare", () => {
    // Ten bursts of a third of a second on one core in 30 s, as quarter-second windows see them: about
    // 2.5 s at 1 core. Over 2-second windows the same job read as a sixth of a core and got half a vCPU.
    const bursty = usage({ seconds: 30, busy: { 0.1: 27.5, 1: 2.5 } });
    expect(chooseSize(runs(ran(bursty), ran(bursty), ran(bursty))).size).toBe("medium");
    const onZen4 = ran(bursty, "large", "success", ZEN4);
    expect(chooseSize([onZen4, onZen4, onZen4]).size).toBe("large");
  });

  it("compares a run's time with large runs on the same host processor", () => {
    const at = (seconds: number, size: SizedRun["size"], cpu: string) => ran(usage({ seconds }), size, "success", cpu);
    // Large: 60 s on Zen 4, 120 s on Zen 2. 110 s on tiny on Zen 4 is slower than Zen 4's 60 s, though
    // faster than the median of all large runs.
    const large = [at(60, "large", ZEN4), at(60, "large", ZEN4), at(120, "large", ZEN2), at(120, "large", ZEN2), at(120, "large", ZEN2)];
    expect(chooseSize([at(110, "tiny", ZEN4), ...large]).size).toBe("large");
    // 130 s on tiny on Zen 2 is like Zen 2's large runs: no slowdown (small, since some runs were on Zen 4).
    expect(chooseSize([at(130, "tiny", ZEN2), ...large]).size).toBe("small");
    // Large runs from further back (o.large) give the typical time when the last runs are all smaller.
    const smallOnly = Array.from({ length: 5 }, () => at(110, "tiny", ZEN4));
    expect(chooseSize(smallOnly).size).toBe("small");
    expect(chooseSize(smallOnly, { large }).size).toBe("large");
  });

  it("stays large for 20 runs after a smaller runner hurt a job, so it doesn't flap", () => {
    const fine = () => ran(usage());
    const failed = ran(usage(), "tiny", "failure");
    // The failure is 10 runs back: still large.
    expect(chooseSize([...Array.from({ length: 10 }, fine), failed]).size).toBe("large");
    // 20 runs later it has dropped out of view.
    expect(chooseSize([...Array.from({ length: 20 }, fine), failed]).size).toBe("tiny");
  });

  it("doesn't go below a runner whose CPU held the job back", () => {
    // Busy at small's half vCPU most of the time: it may need more, so at least medium.
    const capped = usage({ seconds: 100, busy: { 0.5: 100 }, cores: 0.5, saturated: 0.9 });
    expect(chooseSize(runs(ran(capped, "small"))).size).toBe("medium");
  });

  it("names the size and why in the log", () => {
    expect(describeSize("small", "sized by this job's last run (peak memory 0.4 GiB)", false)).toBe(
      "Runner size: small (0.5 of a vCPU, 4 GiB of memory, 8 GB of disk), sized by this job's last run (peak memory 0.4 GiB); runs-on: diffinery-large (or -medium, -small, -tiny) sets a size",
    );
    expect(describeSize("large", "", true)).toContain("asked for by runs-on");
  });

  it("keeps only a well-formed usage report", () => {
    const u = usage();
    expect(JSON.parse(cleanUsage({ ...u, extra: "x" })!)).toEqual(u);
    expect(cleanUsage({ ...u, memoryPeak: -1 })).toBeNull();
    expect(cleanUsage({ ...u, busySeconds: [1, 2] })).toBeNull();
    expect(cleanUsage({ ...u, seconds: "1" })).toBeNull();
    expect(cleanUsage(null)).toBeNull();
  });
});

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

/** Actions over an in-memory repository, with stand-ins for each runner class recording what started where. */
function fixture(bindings: string[] = ["RUNNER", "RUNNER_MEDIUM", "RUNNER_SMALL", "RUNNER_TINY"], refuse: (binding: string) => boolean = () => false) {
  const sql = sqlStorage();
  sql.exec(REPO_SCHEMA);
  migrateRepoSchema(sql as unknown as SqlStorage);
  const DB = testD1();
  DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, created_at) VALUES ('acme', 'acme', 'org', 'active', ?)").run(new Date().toISOString());
  const started: Array<{ binding: string; name: string; vcpu?: number }> = [];
  const stopped: Array<{ binding: string; name: string }> = [];
  const repo = {
    sql,
    meta: { repoId: "r", owner: "acme", ownerId: "acme", ownerKind: "org", name: "app", defaultBranch: "main" },
    headRef: "refs/heads/main",
    getRef: () => null,
    upsertCheck: () => {},
    broadcast: () => {},
    emit: () => {},
    armAlarm: () => {},
    deploys: { jobCompleted: () => {}, protection: () => null },
    runtime: { sweepJob: async () => {} },
    policy: { agentOrigin: () => false },
    alarmBy: () => {},
  } as unknown as RepoDO;
  const ns = (binding: string) => ({
    idFromName: (n: string) => n,
    get: (n: string) => ({
      startJob: async (input: { vcpu?: number }) => {
        if (refuse(binding)) throw new Error("there is no container instance that can be provided to this durable object");
        started.push({ binding, name: n, vcpu: input.vcpu });
      },
      stopJob: async () => void stopped.push({ binding, name: n }),
    }),
  });
  const env = {
    DB,
    PUBLIC_URL: "https://d.test",
    BUCKET: { put: async () => {}, get: async () => null },
    ...Object.fromEntries(bindings.map((b) => [b, ns(b)])),
    RUN_WORKFLOW: { create: async () => {}, get: async () => ({ sendEvent: async () => {} }) },
  } as unknown as Env;
  const actions = new Actions(repo, env);
  async function run(runsOn = "ubuntu-latest") {
    const yaml = `name: w\non: push\njobs:\n  deploy:\n    runs-on: ${runsOn}\n    steps: [{ run: echo hi }]\n`;
    const { workflow } = parseWorkflow(yaml, ".github/workflows/w.yml");
    Object.defineProperty(actions, "loadWorkflows", { value: async () => [{ path: ".github/workflows/w.yml", workflow, errors: [] }], configurable: true });
    const r = (await actions.createRun(workflow!, { event: "push", ref: "refs/heads/main", sha: "abc", payload: {}, caller: ADA, title: "t" }))!;
    expect((await actions.plan(r.id)).error).toBeUndefined();
    const { jobIds } = await actions.startJobKey(r.id, "deploy");
    return jobIds[0]!;
  }
  const complete = (jobId: string, conclusion: "success" | "failure", u: JobUsage | null) =>
    (actions as unknown as { completeJob: (id: string, c: unknown) => Promise<void> }).completeJob(jobId, { conclusion, outputs: {}, ...(u ? { usage: u } : {}) });
  const job = (id: string) => sql.exec("SELECT * FROM jobs WHERE id = ?", id).one() as { container: string; size_note: string; usage: string | null; runner_size: string | null };
  return { actions, started, stopped, run, complete, job };
}

describe("hosted jobs on sized runners", () => {
  it("runs a first job large, then sizes it by what it used", async () => {
    const f = fixture();
    const first = await f.run();
    expect(f.started.at(-1)).toMatchObject({ binding: "RUNNER", name: `job-${first}`, vcpu: 4 });
    expect(f.job(first).size_note).toContain("no earlier run");
    await f.complete(first, "success", usage({ memGiB: 0.3 }));
    expect(JSON.parse(f.job(first).usage!).memoryPeak).toBe(0.3 * GiB);
    // Large until three measured runs say otherwise.
    for (let i = 0; i < 2; i++) {
      const id = await f.run();
      expect(f.started.at(-1)).toMatchObject({ binding: "RUNNER" });
      await f.complete(id, "success", usage({ memGiB: 0.3 }));
    }

    const second = await f.run();
    // The runs reported no host processor, so they count as on the fastest: small, not tiny.
    expect(f.started.at(-1)).toMatchObject({ binding: "RUNNER_SMALL", name: `job-${second}.small`, vcpu: 0.5 });
    expect(f.actions.getJob(second).runnerSize).toBe("small");
    expect(f.job(second).size_note).toMatch(/^Runner size: small/);

    // It fails there: the next run is large again.
    await f.complete(second, "failure", usage({ memGiB: 0.3, cores: 0.5 }));
    const third = await f.run();
    expect(f.started.at(-1)).toMatchObject({ binding: "RUNNER", name: `job-${third}` });
    expect(f.job(third).size_note).toContain("failed on a small runner");
  });

  it("runs a job where runs-on asks, and stops it there", async () => {
    const f = fixture();
    const id = await f.run("[ubuntu-latest, diffinery-medium]");
    expect(f.job(id).runner_size).toBe("medium");
    expect(f.started.at(-1)).toMatchObject({ binding: "RUNNER_MEDIUM", name: `job-${id}.medium`, vcpu: 2 });
    expect(f.job(id).size_note).toContain("asked for by runs-on");
    await (f.actions as unknown as { stopContainer: (j: unknown) => Promise<void> }).stopContainer(f.job(id));
    expect(f.stopped).toEqual([{ binding: "RUNNER_MEDIUM", name: `job-${id}.medium` }]);
  });

  it("starts a job large when no smaller runner was free for it", async () => {
    const f = fixture(undefined, (b) => b === "RUNNER_SMALL");
    for (let i = 0; i < 3; i++) await f.complete(await f.run(), "success", usage({ memGiB: 0.3 }));
    const second = await f.run();
    // The small runner had no machine: the job went back in line, and starts again on large.
    expect(f.job(second)).toMatchObject({ container: null });
    await f.actions.relaunchJob(second);
    expect(f.started.at(-1)).toMatchObject({ binding: "RUNNER", name: `job-${second}-p1` });
    expect(f.job(second).size_note).toContain("no smaller runner was free");
  });

  it("runs every job large where the smaller runners aren't deployed", async () => {
    const f = fixture(["RUNNER"]);
    const id = await f.run("diffinery-small");
    expect(f.started.at(-1)).toMatchObject({ binding: "RUNNER", name: `job-${id}`, vcpu: 4 });
    expect(f.job(id).size_note).toContain("no smaller runners");
  });
});
