import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHub, nextLink } from "../src/github.js";
import { withGitConfig } from "../src/git.js";
import { fakeServer, isolatedEnv, run, type FakeServer, type Reply } from "./helpers.js";

describe("run watch", () => {
  let srv: FakeServer;
  beforeEach(async () => {
    srv = await fakeServer();
  });
  afterEach(() => srv.close());

  const runBody = (status: string, conclusion: string | null, jobs: Array<[string, string, string | null]>) => ({
    id: "run1",
    run_number: 4,
    run_attempt: 1,
    name: "CI",
    display_title: "Fix bug",
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "main",
    head_sha: "abcdef1234",
    status,
    conclusion,
    actor: { login: "alice" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    html_url: "http://x/runs/run1",
    jobs: jobs.map(([id, s, c]) => ({ id, name: `job-${id}`, status: s, conclusion: c, startedAt: null, completedAt: null, steps: [], failure: c === "failure" ? { message: "exit 1" } : null })),
  });

  it("prints job transitions and exits 1 when the run fails", async () => {
    const states = [
      runBody("queued", null, [["a", "queued", null]]),
      runBody("in_progress", null, [["a", "in_progress", null]]),
      runBody("in_progress", null, [["a", "in_progress", null]]),
      runBody("completed", "failure", [["a", "completed", "failure"]]),
    ];
    let i = 0;
    srv.on("GET", "/api/v3/repos/o/r/actions/runs/run1", () => ({ body: states[Math.min(i++, states.length - 1)] }));
    const r = await run(["run", "watch", "run1", "-R", "o/r", "--interval", "0"], { env: isolatedEnv({ DIFFINERY_URL: srv.url, DIFFINERY_TOKEN: "t" }) });
    expect(r.code).toBe(1);
    const lines = r.stdout.split("\n").filter((l) => l.includes("job-a"));
    expect(lines).toHaveLength(3); // queued, in progress, failure (no duplicate for the repeated state)
    expect(r.stdout).toContain("completed: failure");
  });

  it("exits 0 on success", async () => {
    srv.on("GET", "/api/v3/repos/o/r/actions/runs/run1", { body: runBody("completed", "success", [["a", "completed", "success"]]) });
    const r = await run(["run", "watch", "run1", "-R", "o/r"], { env: isolatedEnv({ DIFFINERY_URL: srv.url, DIFFINERY_TOKEN: "t" }) });
    expect(r.code).toBe(0);
  });
});

describe("run rerun", () => {
  let srv: FakeServer;
  beforeEach(async () => {
    srv = await fakeServer();
  });
  afterEach(() => srv.close());

  it("re-runs a run, its failed jobs, or one job", async () => {
    for (const p of ["runs/run1/rerun", "runs/run1/rerun-failed-jobs", "jobs/job1/rerun"]) srv.on("POST", `/api/v3/repos/o/r/actions/${p}`, { status: 201, body: { run_id: "run2" } });
    const env = isolatedEnv({ DIFFINERY_URL: srv.url, DIFFINERY_TOKEN: "t" });
    for (const [args, p] of [
      [["run1"], "runs/run1/rerun"],
      [["run1", "--failed"], "runs/run1/rerun-failed-jobs"],
      [["--job", "job1"], "jobs/job1/rerun"],
    ] as const) {
      const r = await run(["run", "rerun", ...args, "-R", "o/r"], { env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Re-running as run run2");
      expect(srv.find("POST", `/api/v3/repos/o/r/actions/${p}`)).toHaveLength(1);
    }
    expect((await run(["run", "rerun", "-R", "o/r"], { env })).code).toBe(2);
  });
});

describe("GitHub client", () => {
  let srv: FakeServer;
  beforeEach(async () => {
    srv = await fakeServer();
  });
  afterEach(() => srv.close());

  it("follows Link pagination and waits out rate limits", async () => {
    let hits = 0;
    srv.on("GET", "/repos/o/r/issues", (req): Reply => {
      hits++;
      if (hits === 1) return { status: 403, headers: { "retry-after": "2" }, body: { message: "secondary rate limit" } };
      if (req.query.page === "2") return { body: [{ number: 3 }] };
      return { body: [{ number: 1 }, { number: 2 }], headers: { link: `<${srv.url}/repos/o/r/issues?page=2&per_page=100>; rel="next", <${srv.url}/repos/o/r/issues?page=2>; rel="last"` } };
    });
    srv.on("GET", "/repos/o/r/actions/variables", (req) =>
      req.query.page === "2" ? { body: { total_count: 2, variables: [{ name: "B", value: "2" }] } } : { body: { total_count: 2, variables: [{ name: "A", value: "1" }] }, headers: { link: `<${srv.url}/repos/o/r/actions/variables?page=2>; rel="next"` } },
    );
    srv.on("GET", "/rate", () => (hits++ < 10 ? { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000" }, body: { message: "API rate limit exceeded" } } : { body: { ok: true } }));
    const waits: number[] = [];
    const gh = new GitHub({ baseUrl: srv.url, token: "ght", sleep: async (ms) => void waits.push(ms), now: () => 990_000 });
    expect((await gh.paginate<{ number: number }>("/repos/o/r/issues", { state: "all" })).map((i) => i.number)).toEqual([1, 2, 3]);
    expect(waits).toEqual([2000]);
    expect(srv.requests[0]!.headers.authorization).toBe("Bearer ght");
    expect(srv.requests[0]!.query).toMatchObject({ state: "all", per_page: "100" });
    expect(await gh.paginate("/repos/o/r/actions/variables", {}, "variables")).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "2" },
    ]);
    hits = 5;
    waits.length = 0;
    expect(await gh.get("/rate")).toEqual({ ok: true });
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]).toBe(11_000); // reset (1000s) - now (990s) + 1s
  });

  it("parses Link headers", () => {
    expect(nextLink('<https://a/x?page=2>; rel="next", <https://a/x?page=9>; rel="last"')).toBe("https://a/x?page=2");
    expect(nextLink('<https://a/x?page=1>; rel="prev"')).toBeNull();
    expect(nextLink(null)).toBeNull();
  });
});

describe("misc", () => {
  it("withGitConfig appends to an existing GIT_CONFIG_COUNT", () => {
    const env = withGitConfig({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" }, [["http.extraHeader", "X: y"]]);
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_1: "http.extraHeader", GIT_CONFIG_VALUE_1: "X: y" });
  });

  it("--help works for every command and --version prints the version", async () => {
    const { registry } = await import("../src/main.js");
    const env = isolatedEnv();
    for (const g of registry.groups) {
      expect((await run([g.name, "--help"], { env })).code).toBe(0);
      for (const c of g.commands) {
        const r = await run([...c.name.split(" "), "--help"], { env });
        expect(r.code, c.name).toBe(0);
        expect(r.stdout).toContain(`Usage: diffinery ${c.name}`);
      }
    }
    for (const c of registry.commands) expect((await run([c.name, "--help"], { env })).code).toBe(0);
    expect((await run(["--version"], { env })).stdout).toMatch(/^diffinery \d+\.\d+\.\d+/);
    expect((await run(["nope"], { env })).code).toBe(2);
  });

  it("api prints JSON and exits 1 on HTTP errors", async () => {
    const srv = await fakeServer();
    try {
      srv.on("GET", "/api/v3/user", { body: { login: "alice" } });
      srv.on("POST", "/api/v3/repos/o/r/labels", (req) => ({ status: 201, body: req.body }));
      const env = isolatedEnv({ DIFFINERY_URL: srv.url, DIFFINERY_TOKEN: "t" });
      const r = await run(["api", "get", "/user"], { env });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ login: "alice" });
      const p = await run(["api", "POST", "repos/o/r/labels", "--input", "-"], { env, stdin: '{"name":"bug"}' });
      expect(JSON.parse(p.stdout)).toEqual({ name: "bug" });
      const missing = await run(["api", "GET", "/nope"], { env });
      expect(missing.code).toBe(1);
      expect(JSON.parse(missing.stdout)).toEqual({ message: "not found" });
    } finally {
      await srv.close();
    }
  });
});

describe("secret set --org", () => {
  let srv: FakeServer;
  beforeEach(async () => {
    srv = await fakeServer();
  });
  afterEach(() => srv.close());

  it("shares an organization secret with the repositories given in --repos", async () => {
    const env = isolatedEnv({ DIFFINERY_URL: srv.url, DIFFINERY_TOKEN: "dfy_t" });
    srv.on("GET", "/api/v3/repos/acme/web", { body: { id: 11, name: "web" } });
    srv.on("GET", "/api/v3/repos/acme/api", { body: { id: 22, name: "api" } });
    srv.on("PUT", "/api/v3/orgs/acme/actions/secrets/DEPLOY", { status: 204 });
    const r = await run(["secret", "set", "DEPLOY", "--org", "acme", "--body", "v", "--repos", "web, acme/api"], { env });
    expect(r.code).toBe(0);
    expect(srv.find("PUT", "/api/v3/orgs/acme/actions/secrets/DEPLOY")[0]!.body).toEqual({ value: "v", visibility: "selected", selected_repository_ids: [11, 22] });
    const plain = await run(["secret", "set", "DEPLOY", "--org", "acme", "--body", "v2"], { env });
    expect(plain.code).toBe(0);
    expect(srv.find("PUT", "/api/v3/orgs/acme/actions/secrets/DEPLOY")[1]!.body).toEqual({ value: "v2" });
    const bad = await run(["secret", "set", "DEPLOY", "--org", "acme", "--body", "v", "--visibility", "selected"], { env });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("needs --repos");
  });
});
