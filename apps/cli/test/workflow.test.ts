import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseInputs } from "../src/commands/workflow.js";
import { fakeServer, isolatedEnv, run, tempDir, type FakeServer } from "./helpers.js";

const GOOD = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

const BAD = `name: Broken
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        bogus: true
  deploy:
    needs: missing-job
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`;

describe("workflow validate", () => {
  function project(files: Record<string, string>): string {
    const dir = tempDir("diffinery-wf-");
    for (const [p, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      writeFileSync(path.join(dir, p), content);
    }
    return dir;
  }

  it("passes valid files in both workflow directories", async () => {
    const cwd = project({ ".github/workflows/ci.yml": GOOD, ".diffinery/workflows/other.yaml": GOOD, ".github/workflows/README.md": "not yaml" });
    const r = await run(["workflow", "validate"], { cwd, env: isolatedEnv() });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(".github/workflows/ci.yml");
    expect(r.stdout).toContain(".diffinery/workflows/other.yaml");
    expect(r.stderr).toContain("2 files checked: no errors");
  });

  it("reports errors with file:line and exits 1", async () => {
    const cwd = project({ ".github/workflows/ci.yml": GOOD, ".github/workflows/bad.yml": BAD });
    const r = await run(["workflow", "validate"], { cwd, env: isolatedEnv() });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/\.github\/workflows\/bad\.yml:10(:\d+)?: error: .*missing-job/);
    expect(r.stdout).toMatch(/\.github\/workflows\/bad\.yml:8(:\d+)?: (error|warning): .*bogus/);
    expect(r.stderr).toMatch(/2 files checked: \d+ errors?/);
  });

  it("validates explicit files and reports YAML syntax errors", async () => {
    const cwd = project({ "x.yml": "jobs: [unclosed\n" });
    const r = await run(["workflow", "validate", "x.yml", "--json"], { cwd, env: isolatedEnv() });
    expect(r.code).toBe(1);
    const res = JSON.parse(r.stdout);
    expect(res[0].file).toBe("x.yml");
    expect(res[0].valid).toBe(false);
    expect(res[0].problems[0].message).toMatch(/YAML/);
  });

  it("is fine with no workflow files", async () => {
    const r = await run(["workflow", "validate"], { cwd: project({}), env: isolatedEnv() });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("No workflow files");
  });
});

describe("workflow run", () => {
  let srv: FakeServer;
  beforeEach(async () => {
    srv = await fakeServer();
  });
  afterEach(() => srv.close());

  it("dispatches with inputs on the default branch", async () => {
    srv.on("GET", "/api/v3/repos/o/r", { body: { default_branch: "trunk" } });
    srv.on("POST", /\/actions\/workflows\/.+\/dispatches$/, { status: 201, body: { run_id: "run1", html_url: "http://x" } });
    const env = isolatedEnv({ DIFFINERY_URL: srv.url, DIFFINERY_TOKEN: "dfy" });
    const r = await run(["workflow", "run", "deploy.yml", "-R", "o/r", "-f", "env=prod", "-f", "dry=true"], { env });
    expect(r.code).toBe(0);
    const req = srv.find("POST", /dispatches$/)[0]!;
    expect(req.path).toBe("/api/v3/repos/o/r/actions/workflows/deploy.yml/dispatches");
    expect(req.body).toEqual({ ref: "trunk", inputs: { env: "prod", dry: "true" } });
  });

  it("parses -f pairs", () => {
    expect(parseInputs(["a=1", "b=x=y", "c="])).toEqual({ a: "1", b: "x=y", c: "" });
    expect(() => parseInputs(["nope"])).toThrow();
  });
});
