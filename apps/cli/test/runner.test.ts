import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeServer, isolatedEnv, run, tempDir, type FakeServer } from "./helpers.js";

/** A stand-in for containers/runner/dist/agent.mjs: records argv, env and cwd, then exits. */
function fakeAgent(exitCode = 0): { agent: string; record: string } {
  const dir = tempDir("diffinery-agent-");
  const record = path.join(dir, "record.json");
  const agent = path.join(dir, "agent.mjs");
  writeFileSync(
    agent,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
console.log("hello from the agent");
console.error("agent stderr line");
process.exit(${exitCode});
`,
  );
  return { agent, record };
}

describe("runner", () => {
  let srv: FakeServer;
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    srv = await fakeServer();
    env = isolatedEnv({ DIFFINERY_URL: srv.url, DIFFINERY_TOKEN: "dfy_user_token" });
  });
  afterEach(() => srv.close());

  it("--once claims a job, runs the agent with the job's env, and returns its exit code", async () => {
    let claims = 0;
    srv.on("POST", "/api/v3/repos/acme/app/actions/runners/claim", () =>
      ++claims === 1 ? { body: { job_id: "job42", run_id: "run7", name: "build (linux)", token: "djt_repo_job42_secret", api_url: srv.url } } : { status: 204 },
    );
    const { agent, record } = fakeAgent(3);
    const work = tempDir("diffinery-work-");
    const r = await run(["runner", "-R", "acme/app", "--once", "--agent", agent, "--labels", "gpu, linux", "--name", "box-1", "--work-dir", work], { env });

    expect(r.code).toBe(3);
    const claimReq = srv.find("POST", "/api/v3/repos/acme/app/actions/runners/claim");
    expect(claimReq).toHaveLength(1);
    expect(claimReq[0]!.body).toEqual({ name: "box-1", labels: ["gpu", "linux"] });
    expect(claimReq[0]!.headers.authorization).toBe("Bearer dfy_user_token");

    const rec = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; cwd: string; env: Record<string, string> };
    expect(rec.argv).toEqual([]);
    expect(rec.env.DIFFINERY_API_URL).toBe(srv.url);
    expect(rec.env.DIFFINERY_JOB_ID).toBe("job42");
    expect(rec.env.DIFFINERY_JOB_TOKEN).toBe("djt_repo_job42_secret");
    expect(rec.env.DIFFINERY_WORK_ROOT).toBe(work);
    expect(rec.env.DIFFINERY_TOKEN).toBeUndefined();
    expect(rec.env.DIFFINERY_URL).toBeUndefined();

    expect(r.stdout).toContain("[build (linux)] hello from the agent");
    expect(r.stderr).toContain("[build (linux)] agent stderr line");
    expect(r.stdout).not.toContain("djt_repo_job42_secret");
  });

  it("--once with no waiting job exits 0 without running the agent", async () => {
    srv.on("POST", /\/runners\/claim$/, { status: 204 });
    const { agent, record } = fakeAgent(0);
    const r = await run(["runner", "-R", "acme/app", "-R", "acme/other", "--once", "--agent", agent], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No jobs waiting");
    expect(existsSync(record)).toBe(false);
    expect(srv.find("POST", /runners\/claim$/).map((q) => q.path)).toEqual(["/api/v3/repos/acme/app/actions/runners/claim", "/api/v3/repos/acme/other/actions/runners/claim"]);
  });

  it("uses DIFFINERY_RUNNER_AGENT and tries the next repository", async () => {
    srv.on("POST", "/api/v3/repos/acme/app/actions/runners/claim", { status: 204 });
    srv.on("POST", "/api/v3/repos/acme/other/actions/runners/claim", { body: { job_id: "j1", run_id: "r1", name: "test", token: "djt_x", api_url: srv.url } });
    const { agent, record } = fakeAgent(0);
    const r = await run(["runner", "-R", "acme/app", "-R", "acme/other", "--once", "--work-dir", tempDir()], { env: { ...env, DIFFINERY_RUNNER_AGENT: agent } });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(record, "utf8")).env.DIFFINERY_JOB_ID).toBe("j1");
  });

  it("explains how to build the agent when none is configured", async () => {
    const r = await run(["runner", "-R", "acme/app", "--once"], { env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("pnpm --filter @diffinery/runner build");
    expect(r.stderr).toContain("containers/runner/dist/agent.mjs");
  });

  it("fails fast on permission errors", async () => {
    srv.on("POST", "/api/v3/repos/acme/app/actions/runners/claim", { status: 403, body: { message: "admin access required" } });
    const { agent } = fakeAgent(0);
    const r = await run(["runner", "-R", "acme/app", "--agent", agent, "--interval", "0"], { env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("admin access required");
  });

  describe("registered runners", () => {
    const job = { body: { job_id: "j9", run_id: "r9", name: "build", token: "djt_repo_j9_secret", api_url: "" } };
    const registered = { status: 201, body: { id: 7, name: "box", labels: ["linux"], token: "drn_repo_7_runnersecret" } };

    it("registers with a registration token, keeps no personal token, and claims with its own", async () => {
      const bare = isolatedEnv({ DIFFINERY_URL: srv.url });
      srv.on("POST", "/api/v3/repos/acme/app/actions/runners/register", registered);
      let claims = 0;
      srv.on("POST", "/api/v3/repos/acme/app/actions/runners/claim", () => (++claims === 1 ? job : { status: 204 }));
      const { agent, record } = fakeAgent(0);
      const r = await run(["runner", "-R", "acme/app", "--registration-token", "drg_abc", "--labels", "linux", "--name", "box", "--once", "--agent", agent, "--work-dir", tempDir()], { env: bare });
      expect(r.code).toBe(0);
      const reg = srv.find("POST", "/api/v3/repos/acme/app/actions/runners/register");
      expect(reg[0]!.body).toEqual({ registration_token: "drg_abc", name: "box", labels: ["linux"], ephemeral: false });
      expect(reg[0]!.headers.authorization).toBeUndefined();
      const claimReq = srv.find("POST", "/api/v3/repos/acme/app/actions/runners/claim");
      expect(claimReq[0]!.headers.authorization).toBe("Bearer drn_repo_7_runnersecret");
      expect(claimReq[0]!.body).toEqual({});
      // The job never sees the runner's token.
      expect(JSON.stringify(JSON.parse(readFileSync(record, "utf8")).env)).not.toContain("drn_");
      expect(r.stdout).toContain("Registered runner");
      expect(r.stdout).not.toContain("drn_");
      const file = path.join(bare.XDG_CONFIG_HOME ?? path.join(bare.HOME!, ".config"), "diffinery", "runners", srv.host.replace(":", "_"), "acme", "app", "box.json");
      expect(JSON.parse(readFileSync(file, "utf8")).token).toBe("drn_repo_7_runnersecret");
      expect(statSync(file).mode & 0o777).toBe(0o600);

      // The next start uses the saved registration.
      const again = await run(["runner", "-R", "acme/app", "--name", "box", "--once", "--agent", agent], { env: bare });
      expect(again.code).toBe(0);
      expect(srv.find("POST", "/api/v3/repos/acme/app/actions/runners/register")).toHaveLength(1);
      expect(srv.find("POST", "/api/v3/repos/acme/app/actions/runners/claim").at(-1)!.headers.authorization).toBe("Bearer drn_repo_7_runnersecret");

      // A removed runner says so.
      srv.on("POST", "/api/v3/repos/acme/app/actions/runners/claim", { status: 401, body: { message: "this runner was removed" } });
      const gone = await run(["runner", "-R", "acme/app", "--name", "box", "--agent", agent, "--interval", "0"], { env: bare });
      expect(gone.code).toBe(1);
      expect(gone.stderr).toContain("was removed from acme/app");
      expect(gone.stderr).toContain(file);
    });

    it("signed in as an admin, registers itself and claims with the runner's token", async () => {
      srv.on("POST", "/api/v3/repos/acme/app/actions/runners/registration-token", { status: 201, body: { token: "drg_auto", expires_at: "2099-01-01T00:00:00Z" } });
      srv.on("POST", "/api/v3/repos/acme/app/actions/runners/register", registered);
      srv.on("POST", "/api/v3/repos/acme/app/actions/runners/claim", { status: 204 });
      const { agent } = fakeAgent(0);
      const r = await run(["runner", "-R", "acme/app", "--name", "box", "--once", "--agent", agent], { env });
      expect(r.code).toBe(0);
      expect(srv.find("POST", /registration-token$/)[0]!.headers.authorization).toBe("Bearer dfy_user_token");
      expect(srv.find("POST", /register$/)[0]!.body).toMatchObject({ registration_token: "drg_auto" });
      expect(srv.find("POST", /claim$/)[0]!.headers.authorization).toBe("Bearer drn_repo_7_runnersecret");
    });

    it("--ephemeral takes one job, saves nothing and exits with its code", async () => {
      srv.on("POST", "/api/v3/repos/acme/app/actions/runners/register", registered);
      srv.on("POST", "/api/v3/repos/acme/app/actions/runners/claim", job);
      const { agent } = fakeAgent(4);
      const bare = isolatedEnv({ DIFFINERY_URL: srv.url });
      const r = await run(["runner", "-R", "acme/app", "--registration-token", "drg_abc", "--ephemeral", "--name", "box", "--agent", agent, "--work-dir", tempDir()], { env: bare });
      expect(r.code).toBe(4);
      expect(srv.find("POST", /register$/)[0]!.body).toMatchObject({ ephemeral: true });
      expect(srv.find("POST", /claim$/)).toHaveLength(1);
      expect(r.stdout).not.toContain("Registered runner");
    });
  });
});
