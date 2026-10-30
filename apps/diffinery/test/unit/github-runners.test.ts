import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import { GitHubApiError, appJwt, githubApp, pkcs8FromPem, webhookSigned, type GitHubAppClient } from "../../src/github-runners/github.js";
import { githubWebhook } from "../../src/github-runners/http.js";
import { GitHubRunnerLinks } from "../../src/github-runners/links.js";
import { GitHubRunners, IDLE_MS, MAX_TRIES, WAIT_RETRY_MS, runnerFor, type QueuedJob, type RunnerHost, type RunnerJobRow } from "../../src/github-runners/service.js";
import type { Directory } from "../../src/lib/directory.js";
import { testD1 } from "./stubs/d1.js";

const at = "2026-10-01T00:00:00.000Z";
const { privateKey: PKCS1, publicKey: SPKI } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

const APP_VARS = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_SLUG: "diffinery-runners",
  GITHUB_APP_CLIENT_ID: "Iv1.abc",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_APP_PRIVATE_KEY: PKCS1,
  GITHUB_APP_WEBHOOK_SECRET: "hook-secret",
  PUBLIC_URL: "https://diffinery.test",
  MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

/** A D1 with ann (a person), acme (her organization) and bob (another person), and GitHub installation 11 linked to ann. */
function setup(vars: Record<string, unknown> = {}) {
  const DB = testD1();
  const add = (id: string, kind: string) => DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, site_admin, created_at) VALUES (?, ?, ?, 'active', 0, ?)").run(id, id, kind, at);
  add("ann", "user");
  add("acme", "org");
  add("bob", "user");
  DB.sqlite.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('acme', 'ann', 'owner', ?)").run(at);
  DB.sqlite.prepare("INSERT INTO github_installations (id, account_id, github_login, github_type, linked_by, linked_at) VALUES (11, 'ann', 'ann-gh', 'User', 'ann', ?)").run(at);
  return { DB, env: { DB, ...vars } as unknown as Env };
}

/** GitHub as the service sees it: just-in-time runners, a runner's state, removals. */
function fakeGitHub() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  let next = 500;
  const gh = {
    fail: null as Error | null,
    busy: false as boolean | null,
    async jitRunner(installationId: number, repo: string, name: string, labels: string[]) {
      calls.push({ op: "jit", args: [installationId, repo, name, labels] });
      if (gh.fail) throw gh.fail;
      return { runnerId: ++next, encodedJitConfig: `jit-${next}` };
    },
    async runner(installationId: number, repo: string, runnerId: number) {
      calls.push({ op: "runner", args: [installationId, repo, runnerId] });
      return gh.busy === null ? null : { busy: gh.busy, status: "online" };
    },
    async removeRunner(installationId: number, repo: string, runnerId: number) {
      calls.push({ op: "remove", args: [installationId, repo, runnerId] });
    },
  };
  return { gh, calls, client: gh as unknown as GitHubAppClient };
}

function fakeHost(sizes: string[] = ["large", "medium", "small", "tiny"]) {
  const started: Array<{ container: string; input: Parameters<RunnerHost["start"]>[1] }> = [];
  const stopped: string[] = [];
  const host = {
    fail: null as Error | null,
    async start(container: string, input: Parameters<RunnerHost["start"]>[1]) {
      if (host.fail) throw host.fail;
      started.push({ container, input });
    },
    async stop(container: string) {
      stopped.push(container);
    },
    has: (size: string) => sizes.includes(size),
  };
  return { host: host as RunnerHost & { fail: Error | null }, started, stopped };
}

const job = (id: number, labels = ["diffinery"]): QueuedJob => ({ installationId: 11, repo: "ann-gh/app", githubJobId: id, runId: 7, workflowName: "CI", jobName: `test ${id}`, htmlUrl: `https://github.com/ann-gh/app/actions/runs/7/job/${id}`, labels });

function world(vars: Record<string, unknown> = {}, sizes?: string[]) {
  const s = setup(vars);
  const g = fakeGitHub();
  const h = fakeHost(sizes);
  let t = Date.parse("2026-10-30T12:00:00.000Z");
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const svc = new GitHubRunners(s.env, g.client, h.host, clock.now);
  const rows = () => s.DB.sqlite.prepare("SELECT * FROM github_runner_jobs ORDER BY created_at, github_job_id").all() as unknown as RunnerJobRow[];
  const compute = () => s.DB.sqlite.prepare("SELECT * FROM compute_usage").all() as Array<{ id: string; repo_id: string; ended_at: string | null }>;
  return { ...s, ...g, ...h, svc, clock, rows, compute };
}

describe("the GitHub App", () => {
  it("is off until every setting is there", () => {
    expect(githubApp({ ...APP_VARS } as unknown as Env)).toMatchObject({ appId: "123", webUrl: "https://github.com", apiUrl: "https://api.github.com" });
    expect(githubApp({ ...APP_VARS, GITHUB_APP_URL: "https://ghe.example.com/" } as unknown as Env)).toMatchObject({ webUrl: "https://ghe.example.com", apiUrl: "https://ghe.example.com/api/v3" });
    expect(githubApp({ ...APP_VARS, GITHUB_APP_WEBHOOK_SECRET: "" } as unknown as Env)).toBeNull();
  });

  it("signs its JWT with the PKCS#1 key GitHub gives, also pasted on one line", async () => {
    for (const key of [PKCS1, PKCS1.replace(/\n/g, "\\n")]) {
      const jwt = await appJwt({ appId: "123", privateKey: key }, 1_800_000_000);
      const [h, p, sig] = jwt.split(".");
      expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: "123" });
      expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(SPKI, Buffer.from(sig!, "base64url"))).toBe(true);
    }
    const { privateKey: pkcs8 } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    expect(pkcs8FromPem(pkcs8)[0]).toBe(0x30);
    expect(() => pkcs8FromPem("not a key")).toThrow(/not a PEM private key/);
  });

  it("takes only webhooks GitHub signed with the app's secret", async () => {
    const body = '{"action":"queued"}';
    const sig = `sha256=${createHmac("sha256", "hook-secret").update(body).digest("hex")}`;
    expect(await webhookSigned("hook-secret", sig, body)).toBe(true);
    expect(await webhookSigned("hook-secret", sig, body + " ")).toBe(false);
    expect(await webhookSigned("other", sig, body)).toBe(false);
    expect(await webhookSigned("hook-secret", undefined, body)).toBe(false);
  });
});

describe("runs-on labels", () => {
  it("are for Diffinery with diffinery or a size, and only labels a Diffinery runner has", () => {
    expect(runnerFor(["diffinery"])).toBe("large");
    expect(runnerFor(["Diffinery-Medium"])).toBe("medium");
    expect(runnerFor(["self-hosted", "linux", "x64", "diffinery-tiny"])).toBe("tiny");
    expect(runnerFor(["diffinery-small", "diffinery-medium"])).toBe("medium");
    expect(runnerFor(["ubuntu-latest"])).toBeNull();
    expect(runnerFor(["self-hosted"])).toBeNull();
    expect(runnerFor(["diffinery", "gpu"])).toBeNull();
    expect(runnerFor(["diffinery", "arm64"])).toBeNull();
    expect(runnerFor([])).toBeNull();
  });
});

describe("GitHub jobs on Diffinery runners", () => {
  it("start a runner for a queued job, follow it through its job and end when its container stops", async () => {
    const w = world();
    expect(await w.svc.queued("ann", job(1001, ["self-hosted", "diffinery-small"]), "small")).toBe(true);
    // GitHub delivers a webhook again after a timeout: the same job doesn't get a second runner.
    expect(await w.svc.queued("ann", job(1001, ["self-hosted", "diffinery-small"]), "small")).toBe(false);
    expect((await w.svc.pump("ann")).next).toBe(IDLE_MS);
    const [row] = w.rows();
    expect(row).toMatchObject({ status: "starting", tries: 1, size: "small", runner_name: `diffinery-${row!.id}-1`, github_runner_id: 501, container: `gh-${row!.id}-1.small` });
    expect(w.calls[0]).toEqual({ op: "jit", args: [11, "ann-gh/app", `diffinery-${row!.id}-1`, ["self-hosted", "diffinery-small"]] });
    expect(w.started).toEqual([{ container: `gh-${row!.id}-1.small`, input: { accountId: "ann", runnerId: row!.id, jitConfig: "jit-501", egress: "open", vcpu: 0.5 } }]);
    // It counts as one of ann's hosted jobs, under no Diffinery repository.
    expect(w.compute()).toEqual([expect.objectContaining({ id: `gh-${row!.id}-1.small`, repo_id: "github:11", ended_at: null })]);

    await w.svc.jobEvent({ installationId: 11, githubJobId: 1001, action: "in_progress", runnerName: `diffinery-${row!.id}-1`, jobName: "test 1001", conclusion: null });
    expect(w.rows()[0]).toMatchObject({ status: "running", ran_job_id: 1001 });
    await w.svc.jobEvent({ installationId: 11, githubJobId: 1001, action: "completed", runnerName: `diffinery-${row!.id}-1`, jobName: "test 1001", conclusion: "success" });
    await w.svc.stopped(row!.id, 0);
    expect(w.rows()[0]).toMatchObject({ status: "completed", conclusion: "success", exit_code: 0, message: null });
    expect(w.compute()[0]!.ended_at).not.toBeNull();
    // A runner that ran its job removes itself from GitHub.
    expect(w.calls.filter((c) => c.op === "remove")).toEqual([]);
    expect((await w.svc.pump("ann")).next).toBeNull();
  });

  it("wait while the account runs as many hosted jobs as it may, and start once one ends", async () => {
    const w = world({ QUOTA_HOSTED_JOBS: "1" });
    w.DB.sqlite.prepare("INSERT INTO compute_usage (id, account_id, repo_id, kind, started_at) VALUES ('other', 'ann', 'r', 'job', ?)").run(new Date().toISOString());
    await w.svc.queued("ann", job(1), "large");
    expect((await w.svc.pump("ann")).next).toBe(WAIT_RETRY_MS);
    expect(w.rows()[0]).toMatchObject({ status: "queued", message: expect.stringMatching(/^Waiting: waiting for one of this account's 1 hosted jobs/) });
    expect(w.started).toEqual([]);
    w.DB.sqlite.prepare("UPDATE compute_usage SET ended_at = ? WHERE id = 'other'").run(new Date().toISOString());
    await w.svc.pump("ann");
    expect(w.rows()[0]!.status).toBe("starting");
  });

  it("don't start while the account's Actions are suspended or hosted compute is paused", async () => {
    const w = world();
    w.DB.sqlite.prepare("UPDATE accounts SET actions_suspended_at = ?, actions_suspended_reason = 'mining' WHERE id = 'ann'").run(at);
    await w.svc.queued("ann", job(1), "large");
    await w.svc.pump("ann");
    expect(w.rows()[0]).toMatchObject({ status: "failed", message: "The runner was not started: Actions are suspended for every repository of ann by a site administrator: mining" });
    w.DB.sqlite.prepare("UPDATE accounts SET actions_suspended_at = NULL WHERE id = 'ann'").run();
    w.DB.sqlite.prepare("INSERT INTO site_flags (key, value, updated_at, updated_by) VALUES ('hosted_compute_paused', 'maintenance', ?, 'root')").run(at);
    await w.svc.queued("ann", job(2), "large");
    await w.svc.pump("ann");
    expect(w.rows()[1]!.message).toMatch(/^The runner was not started: Hosted runners are paused on this instance by a site administrator: maintenance/);
    expect(w.started).toEqual([]);
  });

  it("skip jobs that end before their runner starts, and jobs of an installation no longer linked or suspended", async () => {
    const w = world({ QUOTA_HOSTED_JOBS: "0" });
    await w.svc.queued("ann", job(1), "large");
    await w.svc.jobEvent({ installationId: 11, githubJobId: 1, action: "completed", runnerName: null, jobName: "test 1", conclusion: "cancelled" });
    expect(w.rows()[0]).toMatchObject({ status: "skipped", conclusion: "cancelled", message: "The job ended before a runner started for it" });
    // A Diffinery runner this account didn't start (another instance's, say) took it.
    await w.svc.queued("ann", job(2), "large");
    await w.svc.jobEvent({ installationId: 11, githubJobId: 2, action: "in_progress", runnerName: "diffinery-other-1", jobName: "test 2", conclusion: null });
    expect(w.rows()[1]).toMatchObject({ status: "skipped", message: "The job ran on diffinery-other-1 before a runner started for it" });

    const v = world();
    v.DB.sqlite.prepare("UPDATE github_installations SET suspended_at = ?").run(at);
    await v.svc.queued("ann", job(1), "large");
    await v.svc.pump("ann");
    expect(v.rows()[0]).toMatchObject({ status: "skipped", message: "The app's installation is suspended on GitHub" });
    v.DB.sqlite.prepare("DELETE FROM github_installations").run();
    await v.svc.queued("ann", job(2), "large");
    await v.svc.pump("ann");
    expect(v.rows()[1]).toMatchObject({ status: "skipped", message: "The GitHub installation is no longer linked to this account" });
  });

  it("still start a runner for a job when the runner started for it took another queued job", async () => {
    const w = world();
    const byJob = (id: number) => w.rows().find((r) => r.github_job_id === id)!;
    await w.svc.queued("ann", job(1, ["diffinery-small", "diffinery-medium"]), "medium");
    await w.svc.pump("ann");
    const first = w.rows()[0]!;
    // Job 2 is queued after job 1, and GitHub hands it to job 1's runner before a runner starts for it.
    w.clock.advance(1000);
    await w.svc.queued("ann", job(2, ["diffinery-small"]), "small");
    const queued2 = byJob(2).created_at;
    await w.svc.jobEvent({ installationId: 11, githubJobId: 2, action: "in_progress", runnerName: first.runner_name, jobName: "test 2", conclusion: null });
    // The rows trade jobs: the runner's row shows the job it runs, the other waits for job 1 in job 1's place in line.
    expect(byJob(2)).toMatchObject({ id: first.id, status: "running", job_name: "test 2", html_url: job(2).htmlUrl, labels: '["diffinery-small"]', size: "medium", created_at: queued2, ran_job_id: 2, container: first.container });
    expect(byJob(1)).toMatchObject({ status: "queued", job_name: "test 1", html_url: job(1).htmlUrl, labels: '["diffinery-small","diffinery-medium"]', size: "medium", created_at: first.created_at, runner_name: null, ran_job_id: null });
    const waiting = byJob(1);

    await w.svc.pump("ann");
    expect(byJob(1)).toMatchObject({ id: waiting.id, status: "starting", runner_name: `diffinery-${waiting.id}-1`, container: `gh-${waiting.id}-1.medium` });
    expect(w.calls.filter((c) => c.op === "jit").map((c) => c.args[3])).toEqual([
      ["diffinery-small", "diffinery-medium"],
      ["diffinery-small", "diffinery-medium"],
    ]);
    expect(w.compute().map((c) => [c.id, c.ended_at])).toEqual([
      [first.container, null],
      [`gh-${waiting.id}-1.medium`, null],
    ]);
    // Each runner's row ends with its own container.
    await w.svc.jobEvent({ installationId: 11, githubJobId: 2, action: "completed", runnerName: first.runner_name, jobName: "test 2", conclusion: "success" });
    await w.svc.stopped(first.id, 0);
    expect(byJob(2)).toMatchObject({ status: "completed", conclusion: "success", exit_code: 0 });
    expect(byJob(1)).toMatchObject({ status: "starting" });
    expect(w.compute().map((c) => c.ended_at === null)).toEqual([false, true]);

    // Job 1 cancelled while its row waits: the row is skipped and no runner starts for it.
    const v = world();
    await v.svc.queued("ann", job(1), "large");
    await v.svc.pump("ann");
    const runner = v.rows()[0]!.runner_name;
    await v.svc.queued("ann", job(2), "large");
    await v.svc.jobEvent({ installationId: 11, githubJobId: 2, action: "in_progress", runnerName: runner, jobName: "test 2", conclusion: null });
    await v.svc.jobEvent({ installationId: 11, githubJobId: 1, action: "completed", runnerName: null, jobName: "test 1", conclusion: "cancelled" });
    expect(v.rows().map((r) => [r.github_job_id, r.status, r.message])).toEqual([
      [1, "skipped", "The job ended before a runner started for it"],
      [2, "running", null],
    ]);
    await v.svc.pump("ann");
    expect(v.started).toHaveLength(1);

    // A job whose own runner already started keeps it: GitHub hands that runner the job the other was started for.
    const u = world();
    await u.svc.queued("ann", job(1), "large");
    await u.svc.queued("ann", job(2), "large");
    await u.svc.pump("ann");
    const [r1, r2] = u.rows();
    await u.svc.jobEvent({ installationId: 11, githubJobId: 2, action: "in_progress", runnerName: r1!.runner_name, jobName: "test 2", conclusion: null });
    await u.svc.jobEvent({ installationId: 11, githubJobId: 1, action: "in_progress", runnerName: r2!.runner_name, jobName: "test 1", conclusion: null });
    expect(u.rows().map((r) => [r.id, r.github_job_id, r.status, r.ran_job_id])).toEqual([
      [r1!.id, 1, "running", 2],
      [r2!.id, 2, "running", 1],
    ]);
  });

  it("run a size this Diffinery doesn't have on a large runner", async () => {
    const w = world({}, ["large"]);
    await w.svc.queued("ann", job(1, ["diffinery-tiny"]), "tiny");
    await w.svc.pump("ann");
    expect(w.rows()[0]).toMatchObject({ size: "large" });
    expect(w.started[0]!.container).not.toContain(".");
    expect(w.started[0]!.input.vcpu).toBe(4);
  });

  it("give up when GitHub refuses the runner, and try again later when GitHub is down", async () => {
    const w = world();
    w.gh.fail = new GitHubApiError(403, "GitHub answered 403 to POST repos/ann-gh/app/actions/runners/generate-jitconfig: Resource not accessible by integration");
    await w.svc.queued("ann", job(1), "large");
    await w.svc.pump("ann");
    expect(w.rows()[0]).toMatchObject({ status: "failed", message: expect.stringMatching(/^Could not register a runner on GitHub: .*Resource not accessible/) });

    w.gh.fail = new GitHubApiError(502, "bad gateway");
    await w.svc.queued("ann", job(2), "large");
    expect((await w.svc.pump("ann")).next).toBe(WAIT_RETRY_MS);
    expect(w.rows()[1]).toMatchObject({ status: "queued", tries: 1 });
    w.gh.fail = null;
    await w.svc.pump("ann");
    expect(w.rows()[1]).toMatchObject({ status: "starting", tries: 2 });
  });

  it("put a runner whose container got no machine back in line, and fail one whose start can't work", async () => {
    const w = world();
    w.host.fail = new Error("there is no container instance that can be provided to this durable object");
    await w.svc.queued("ann", job(1), "large");
    expect((await w.svc.pump("ann")).next).toBe(WAIT_RETRY_MS);
    const row = w.rows()[0]!;
    expect(row).toMatchObject({ status: "queued", container: null, message: expect.stringMatching(/^Starting a runner failed; trying again/) });
    expect(w.calls.filter((c) => c.op === "remove")).toEqual([{ op: "remove", args: [11, "ann-gh/app", 501] }]);
    expect(w.compute()[0]!.ended_at).not.toBeNull();
    w.host.fail = new Error("image not found");
    await w.svc.pump("ann");
    expect(w.rows()[0]).toMatchObject({ status: "failed", message: "Could not start a runner: image not found" });
  });

  it("replace a runner that crashed before it took a job, a few times", async () => {
    const w = world();
    await w.svc.queued("ann", job(1), "large");
    for (let i = 1; i < MAX_TRIES; i++) {
      await w.svc.pump("ann");
      await w.svc.stopped(w.rows()[0]!.id, 1);
      expect(w.rows()[0]).toMatchObject({ status: "queued", tries: i, message: "The runner stopped before it took a job (exit code 1); starting another" });
    }
    await w.svc.pump("ann");
    await w.svc.stopped(w.rows()[0]!.id, 1);
    expect(w.rows()[0]).toMatchObject({ status: "completed", tries: MAX_TRIES, message: "The runner stopped before it took a job (exit code 1)" });
    expect(w.compute().every((c) => c.ended_at)).toBe(true);
    expect(w.started.map((s) => s.container)).toEqual([1, 2, 3].map((n) => `gh-${w.rows()[0]!.id}-${n}`));
  });

  it("stop a runner no job took within the idle time, unless GitHub says it is busy", async () => {
    const w = world();
    await w.svc.queued("ann", job(1), "large");
    await w.svc.queued("ann", job(2), "large");
    await w.svc.pump("ann");
    w.clock.advance(IDLE_MS + 1000);
    // The first runner's in_progress webhook never came, but it has a job; the second has none.
    let n = 0;
    const runner = w.gh.runner.bind(w.gh);
    w.gh.runner = async (...a) => ((w.gh.busy = n++ === 0), runner(...a));
    await w.svc.pump("ann");
    const [a, b] = w.rows();
    expect(a).toMatchObject({ status: "running" });
    expect(b).toMatchObject({ status: "completed", message: expect.stringMatching(/^No job took this runner within 10 minutes/) });
    expect(w.stopped).toEqual([b!.container]);
    expect(w.calls.filter((c) => c.op === "remove")).toEqual([{ op: "remove", args: [11, "ann-gh/app", b!.github_runner_id] }]);
    // Its container's stop arrives afterwards and changes nothing.
    await w.svc.stopped(b!.id, 137);
    expect(w.rows()[1]).toMatchObject({ status: "completed", exit_code: null });
  });

  it("stop everything for a kill switch", async () => {
    const w = world({ QUOTA_HOSTED_JOBS: "1" });
    await w.svc.queued("ann", job(1), "large");
    await w.svc.queued("ann", job(2), "large");
    await w.svc.pump("ann");
    expect(await w.svc.stopAll("ann", "paused")).toBe(1);
    expect(w.rows().map((r) => [r.status, r.message])).toEqual([
      ["completed", "paused"],
      ["failed", "paused"],
    ]);
    expect(w.stopped).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- the webhook

function hookEnv(DB: D1Database, vars: Record<string, unknown> = APP_VARS) {
  const calls: Array<{ op: string; name: string; args: unknown[] }> = [];
  const stub = (name: string) => ({
    queued: async (...args: unknown[]) => void calls.push({ op: "queued", name, args }),
    jobEvent: async (...args: unknown[]) => void calls.push({ op: "jobEvent", name, args }),
  });
  const GITHUB_RUNNERS = { idFromName: (n: string) => n, get: (n: string) => stub(n) };
  return { env: { DB, GITHUB_RUNNERS, ...vars } as unknown as Env, calls };
}

async function deliver(env: Env, event: string, payload: unknown, secret = "hook-secret") {
  const body = JSON.stringify(payload);
  return githubWebhook.request("/-/github/webhook", { method: "POST", body, headers: { "x-github-event": event, "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` } }, env);
}

const queuedPayload = (labels: string[], installation = 11, action = "queued", runner_name: string | null = null) => ({
  action,
  workflow_job: { id: 99, run_id: 7, name: "test", workflow_name: "CI", labels, runner_name, conclusion: null, html_url: "https://github.com/ann-gh/app/actions/runs/7/job/99" },
  repository: { full_name: "ann-gh/app" },
  installation: { id: installation },
});

describe("the GitHub App's webhook", () => {
  it("is off without the app and refuses unsigned deliveries", async () => {
    const { DB } = setup();
    expect((await deliver(hookEnv(DB, { PUBLIC_URL: "https://diffinery.test" }).env, "ping", {})).status).toBe(404);
    const { env } = hookEnv(DB);
    expect((await deliver(env, "ping", {}, "wrong")).status).toBe(401);
    expect((await deliver(env, "ping", {})).status).toBe(200);
  });

  it("hands queued jobs for Diffinery to the linked account, and nothing else", async () => {
    const { DB } = setup();
    const { env, calls } = hookEnv(DB);
    expect(await (await deliver(env, "workflow_job", queuedPayload(["diffinery-medium"]))).json()).toEqual({ queued: true, size: "medium" });
    expect(calls).toEqual([{ op: "queued", name: "ann", args: ["ann", expect.objectContaining({ installationId: 11, repo: "ann-gh/app", githubJobId: 99, labels: ["diffinery-medium"] }), "medium"] }]);
    expect(await (await deliver(env, "workflow_job", queuedPayload(["ubuntu-latest"]))).json()).toEqual({ ignored: "not for a Diffinery runner" });
    expect(await (await deliver(env, "workflow_job", queuedPayload(["diffinery"], 12))).json()).toEqual({ ignored: "this installation isn't linked to a Diffinery account" });
    await deliver(env, "workflow_job", queuedPayload(["diffinery"], 11, "in_progress", "diffinery-abc-1"));
    expect(calls[1]).toEqual({ op: "jobEvent", name: "ann", args: ["ann", { installationId: 11, githubJobId: 99, action: "in_progress", runnerName: "diffinery-abc-1", jobName: "test", conclusion: null }] });
    // Another provider's runner doesn't count as Diffinery's.
    await deliver(env, "workflow_job", queuedPayload(["diffinery"], 11, "completed", "hosted-runner-7"));
    expect(calls[2]!.args[1]).toMatchObject({ action: "completed", runnerName: null });
    expect(calls).toHaveLength(3);
  });

  it("follows the installation: suspended, renamed, uninstalled", async () => {
    const { DB } = setup();
    const { env } = hookEnv(DB);
    const inst = () => DB.sqlite.prepare("SELECT * FROM github_installations WHERE id = 11").get() as { suspended_at: string | null; github_login: string } | undefined;
    await deliver(env, "installation", { action: "suspend", installation: { id: 11 } });
    expect(inst()!.suspended_at).not.toBeNull();
    await deliver(env, "installation", { action: "unsuspend", installation: { id: 11 } });
    expect(inst()!.suspended_at).toBeNull();
    await deliver(env, "installation_target", { action: "renamed", installation: { id: 11, account: { login: "ann-new" } } });
    expect(inst()!.github_login).toBe("ann-new");
    await deliver(env, "installation", { action: "deleted", installation: { id: 11 } });
    expect(inst()).toBeUndefined();
  });
});

// ---------------------------------------------------------------- linking an installation

function linking(installations: Array<{ id: number; account: { login: string; type: string } }>) {
  const s = setup({ ...APP_VARS, GITHUB_RUNNERS: {} });
  const audits: Array<{ action: string; target?: string; detail?: unknown }> = [];
  const accounts = { ann: { id: "ann", login: "ann", kind: "user" }, bob: { id: "bob", login: "bob", kind: "user" } } as const;
  const dir = {
    orgsFor: async (id: string) => (id === "ann" ? [{ id: "acme", login: "acme", kind: "org", role: "owner" }] : []),
    audit: async (e: { action: string; target?: string; detail?: unknown }) => void audits.push(e),
  } as unknown as Directory;
  const requests: string[] = [];
  const fetcher = (async (input: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${input}`);
    if (input === "https://github.com/login/oauth/access_token") {
      const code = (JSON.parse(String(init!.body)) as { code: string }).code;
      return Response.json(code === "good" ? { access_token: "ghu_x" } : { error_description: "bad code" });
    }
    if (input.startsWith("https://api.github.com/user/installations")) return Response.json({ installations });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const links = new GitHubRunnerLinks(s.env, dir, fetcher);
  const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
  const linked = () => s.DB.sqlite.prepare("SELECT id, account_id, github_login FROM github_installations ORDER BY id").all();
  return { ...s, links, audits, requests, stateOf, linked, ann: accounts.ann as never, bob: accounts.bob as never };
}

describe("linking an installation", () => {
  it("installs on GitHub for an account the person manages, and links what GitHub says they can manage", async () => {
    const l = linking([{ id: 42, account: { login: "acme-gh", type: "Organization" } }]);
    const install = await l.links.installUrl(l.ann, "acme");
    expect(install).toMatch(/^https:\/\/github\.com\/apps\/diffinery-runners\/installations\/new\?state=/);
    // No code (user authorization during installation is off): authorize the app first.
    const r1 = await l.links.setup(l.ann, { installationId: 42, code: null, state: l.stateOf(install) });
    if (!("redirect" in r1)) throw new Error("expected a redirect");
    expect(r1.redirect).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?client_id=Iv1\.abc&redirect_uri=https%3A%2F%2Fdiffinery\.test%2Fsettings%2Fgithub-runners%2Fsetup/);
    const r2 = await l.links.setup(l.ann, { installationId: null, code: "good", state: l.stateOf(r1.redirect) });
    expect(r2).toMatchObject({ linked: { id: 42, account_id: "acme", github_login: "acme-gh", github_type: "Organization", linked_by: "ann" } });
    expect(l.audits).toEqual([{ actorId: "ann", actorLogin: "ann", action: "github_runners.link", target: "acme", detail: { installation: 42, github: "acme-gh" } }]);
  });

  it("refuses an installation the person can't manage on GitHub, an account they don't manage, and someone else's state", async () => {
    const l = linking([{ id: 42, account: { login: "acme-gh", type: "Organization" } }]);
    const state = l.stateOf(await l.links.installUrl(l.ann, "ann"));
    await expect(l.links.setup(l.ann, { installationId: 43, code: "good", state })).rejects.toThrow(/can't manage that installation/);
    await expect(l.links.installUrl(l.bob, "acme")).rejects.toThrow(/only to your own account or an organization you own or administer/);
    await expect(l.links.setup(l.bob, { installationId: 42, code: "good", state })).rejects.toThrow(/made for someone else/);
    await expect(l.links.setup(l.ann, { installationId: 42, code: "good", state: state.slice(0, -2) + "xx" })).rejects.toThrow(/not valid/);
    await expect(l.links.setup(l.ann, { installationId: 42, code: "bad", state })).rejects.toThrow(/did not sign you in: bad code/);
    expect(l.linked()).toEqual([{ id: 11, account_id: "ann", github_login: "ann-gh" }]);
  });

  it("never uses a code that came without the person's own state, and links a picked installation to the account they pick", async () => {
    const l = linking([
      { id: 11, account: { login: "ann-gh", type: "User" } },
      { id: 42, account: { login: "acme-gh", type: "Organization" } },
    ]);
    // A code without a state may be another GitHub user's: authorize again with the person's own.
    const r1 = await l.links.setup(l.ann, { installationId: 42, code: "someone-elses", state: null });
    if (!("redirect" in r1)) throw new Error("expected a redirect");
    expect(l.requests).toEqual([]);
    const r2 = await l.links.setup(l.ann, { installationId: null, code: "good", state: l.stateOf(r1.redirect) });
    if (!("choose" in r2)) throw new Error("expected a choice");
    expect(r2.choose.map((i) => [i.id, i.login, i.linkedTo])).toEqual([
      [11, "ann-gh", "ann"],
      [42, "acme-gh", null],
    ]);
    expect(l.linked()).toHaveLength(1);
    const proof = r2.choose[1]!.proof;
    await expect(l.links.linkWithProof(l.bob, proof, "bob")).rejects.toThrow(/made for someone else/);
    await expect(l.links.linkWithProof(l.ann, proof, "bob")).rejects.toThrow(/only to your own account/);
    await l.links.linkWithProof(l.ann, proof, "acme");
    expect(l.linked()).toEqual([
      { id: 11, account_id: "ann", github_login: "ann-gh" },
      { id: 42, account_id: "acme", github_login: "acme-gh" },
    ]);
  });

  it("unlinks: jobs waiting for a runner get none", async () => {
    const l = linking([]);
    l.DB.sqlite
      .prepare("INSERT INTO github_runner_jobs (id, account_id, installation_id, repo, github_job_id, labels, size, status, created_at) VALUES ('j', 'ann', 11, 'ann-gh/app', 1, '[\"diffinery\"]', 'large', 'queued', ?)")
      .run(at);
    await expect(l.links.unlink(l.bob, 11)).rejects.toThrow(/only to your own account/);
    await l.links.unlink(l.ann, 11);
    expect(l.linked()).toEqual([]);
    expect(l.DB.sqlite.prepare("SELECT status, message FROM github_runner_jobs").get()).toEqual({ status: "skipped", message: "The GitHub installation was unlinked" });
    expect(l.audits.at(-1)).toMatchObject({ action: "github_runners.unlink", target: "ann", detail: { installation: 11, github: "ann-gh" } });
  });
});
