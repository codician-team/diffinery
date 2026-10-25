import { describe, expect, it } from "vitest";
import { expandMatrix, isWarning, jobOrder, matchesTrigger, parseWorkflow, type Workflow, type WorkflowError } from "../src/index.js";

function ok(src: string, path = ".github/workflows/test.yml"): Workflow {
  const { workflow, errors } = parseWorkflow(src, path);
  const fatal = errors.filter((e) => !isWarning(e));
  if (fatal.length > 0 || !workflow) throw new Error(`unexpected errors: ${JSON.stringify(errors, null, 2)}`);
  return workflow;
}

function errs(src: string): WorkflowError[] {
  return parseWorkflow(src, "w.yml").errors;
}

function fatal(src: string): WorkflowError[] {
  const res = parseWorkflow(src, "w.yml");
  const out = res.errors.filter((e) => !isWarning(e));
  expect(out.length).toBeGreaterThan(0);
  expect(res.workflow).toBeUndefined();
  return out;
}

const minimalJob = `jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;

describe("real-world workflows", () => {
  it("Node CI with matrix and cache", () => {
    const wf = ok(`
name: Node CI
on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]
env:
  CI: true
  FORCE_COLOR: 1
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  test:
    name: Test (node \${{ matrix.node-version }}, \${{ matrix.os }})
    runs-on: \${{ matrix.os }}
    timeout-minutes: 20
    strategy:
      fail-fast: false
      max-parallel: 4
      matrix:
        os: [ubuntu-latest, windows-latest]
        node-version: [18.x, 20.x, 22.x]
        exclude:
          - os: windows-latest
            node-version: 18.x
        include:
          - os: ubuntu-latest
            node-version: 22.x
            coverage: true
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Use Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: npm
      - name: Cache node modules
        uses: actions/cache@v4
        with:
          path: ~/.npm
          key: \${{ runner.os }}-node-\${{ hashFiles('**/package-lock.json') }}
          restore-keys: |
            \${{ runner.os }}-node-
      - run: npm ci
      - run: npm test -- --coverage
        if: matrix.coverage
        env:
          NODE_OPTIONS: --max-old-space-size=4096
      - run: npm test
        if: \${{ !matrix.coverage }}
        continue-on-error: \${{ matrix.os == 'windows-latest' }}
        timeout-minutes: 10
        working-directory: ./app
        shell: bash
`);
    expect(wf.name).toBe("Node CI");
    expect(wf.path).toBe(".github/workflows/test.yml");
    expect(wf.env).toEqual({ CI: "true", FORCE_COLOR: "1" });
    expect(wf.concurrency).toEqual({ group: "ci-${{ github.ref }}", cancelInProgress: true });
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(Object.keys(wf.on)).toEqual(["push", "pull_request"]);
    expect(wf.on.push).toEqual({ branches: ["main"] });

    const job = wf.jobs.test!;
    expect(job.key).toBe("test");
    expect(job.runsOn).toEqual(["${{ matrix.os }}"]);
    expect(job.needs).toEqual([]);
    expect(job.timeoutMinutes).toBe(20);
    expect(job.continueOnError).toBe(false);
    expect(job.strategy?.failFast).toBe(false);
    expect(job.strategy?.maxParallel).toBe(4);
    expect(job.steps).toHaveLength(6);
    expect(job.steps[0]).toEqual({ uses: "actions/checkout@v4", with: { "fetch-depth": "0" } });
    expect(job.steps[1]?.with).toEqual({ "node-version": "${{ matrix.node-version }}", cache: "npm" });
    expect(job.steps[2]?.with?.["restore-keys"]).toBe("${{ runner.os }}-node-\n");
    expect(job.steps[4]).toEqual({
      run: "npm test -- --coverage",
      if: "matrix.coverage",
      env: { NODE_OPTIONS: "--max-old-space-size=4096" },
    });
    expect(job.steps[5]).toEqual({
      run: "npm test",
      if: "${{ !matrix.coverage }}",
      "continue-on-error": "${{ matrix.os == 'windows-latest' }}",
      "timeout-minutes": 10,
      "working-directory": "./app",
      shell: "bash",
    });

    const combos = expandMatrix(job.strategy?.matrix);
    expect(combos).toHaveLength(5);
    expect(combos).toContainEqual({ os: "ubuntu-latest", "node-version": "22.x", coverage: true });

    expect(matchesTrigger(wf, { name: "push", ref: "refs/heads/main" })).toBe(true);
    expect(matchesTrigger(wf, { name: "push", ref: "refs/heads/feature" })).toBe(false);
    expect(matchesTrigger(wf, { name: "pull_request", action: "synchronize", baseRef: "main" })).toBe(true);
  });

  it("release workflow on tags", () => {
    const wf = ok(`
name: Release
on:
  push:
    tags:
      - 'v[0-9]+.[0-9]+.[0-9]+'
      - '!v*-rc*'
permissions:
  contents: write
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.meta.outputs.version }}
    steps:
      - uses: actions/checkout@v4
      - id: meta
        run: echo "version=\${GITHUB_REF#refs/tags/v}" >> "$GITHUB_OUTPUT"
  publish:
    needs: build
    runs-on: [self-hosted, linux, x64]
    environment:
      name: production
      url: https://example.com/releases/\${{ needs.build.outputs.version }}
    if: startsWith(github.ref, 'refs/tags/')
    steps:
      - run: echo publishing \${{ needs.build.outputs.version }}
  announce:
    needs: [build, publish]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`);
    expect(wf.on.push).toEqual({ tags: ["v[0-9]+.[0-9]+.[0-9]+", "!v*-rc*"] });
    expect(wf.permissions).toEqual({ contents: "write", "id-token": "write" });
    expect(wf.jobs.build?.outputs).toEqual({ version: "${{ steps.meta.outputs.version }}" });
    expect(wf.jobs.build?.steps[1]?.id).toBe("meta");
    expect(wf.jobs.publish?.needs).toEqual(["build"]);
    expect(wf.jobs.publish?.runsOn).toEqual(["self-hosted", "linux", "x64"]);
    expect(wf.jobs.publish?.environment).toEqual({ name: "production", url: "https://example.com/releases/${{ needs.build.outputs.version }}" });
    expect(wf.jobs.publish?.if).toBe("startsWith(github.ref, 'refs/tags/')");
    expect(wf.jobs.publish?.timeoutMinutes).toBe(360);
    expect(wf.jobs.announce?.needs).toEqual(["build", "publish"]);
    expect(jobOrder(wf)).toEqual({ order: [["build"], ["publish"], ["announce"]], errors: [] });

    expect(matchesTrigger(wf, { name: "push", ref: "refs/tags/v1.2.3" })).toBe(true);
    expect(matchesTrigger(wf, { name: "push", ref: "refs/tags/v1.2.3-rc1" })).toBe(false);
    expect(matchesTrigger(wf, { name: "push", ref: "refs/heads/main" })).toBe(false);
  });

  it("workflow_dispatch with inputs", () => {
    const wf = ok(`
on:
  workflow_dispatch:
    inputs:
      logLevel:
        description: 'Log level'
        required: true
        default: 'warning'
        type: choice
        options:
          - info
          - warning
          - debug
      print_tags:
        description: 'True to print to STDOUT'
        required: true
        type: boolean
      environment:
        description: 'Environment to run tests against'
        type: environment
        required: true
      count:
        type: number
        default: 3
      free:
run-name: Deploy by @\${{ github.actor }}
jobs:
  print-tag:
    runs-on: ubuntu-latest
    if: \${{ inputs.print_tags }}
    steps:
      - name: Print the input tag to STDOUT
        run: echo  The tags are \${{ inputs.tags }}
`);
    expect(wf.runName).toBe("Deploy by @${{ github.actor }}");
    expect(wf.on.workflow_dispatch?.inputs).toEqual({
      logLevel: { description: "Log level", required: true, default: "warning", type: "choice", options: ["info", "warning", "debug"] },
      print_tags: { description: "True to print to STDOUT", required: true, type: "boolean" },
      environment: { description: "Environment to run tests against", type: "environment", required: true },
      count: { type: "number", default: 3 },
      free: {},
    });
    expect(matchesTrigger(wf, { name: "workflow_dispatch" })).toBe(true);
    expect(matchesTrigger(wf, { name: "push", ref: "refs/heads/main" })).toBe(false);
  });

  it("reusable workflow call and definition", () => {
    const caller = ok(`
on: push
jobs:
  call-workflow-passing-data:
    uses: octo-org/example-repo/.github/workflows/reusable-workflow.yml@main
    with:
      config-path: .github/labeler.yml
      debug: true
      retries: 2
    secrets: inherit
  local:
    uses: ./.github/workflows/deploy.yml
    needs: call-workflow-passing-data
    secrets:
      token: \${{ secrets.DEPLOY_TOKEN }}
    strategy:
      matrix:
        target: [dev, prod]
`);
    const j = caller.jobs["call-workflow-passing-data"]!;
    expect(j.uses).toBe("octo-org/example-repo/.github/workflows/reusable-workflow.yml@main");
    expect(j.runsOn).toEqual([]);
    expect(j.steps).toEqual([]);
    expect(j.with).toEqual({ "config-path": ".github/labeler.yml", debug: true, retries: 2 });
    expect(j.secrets).toBe("inherit");
    expect(caller.jobs.local?.secrets).toEqual({ token: "${{ secrets.DEPLOY_TOKEN }}" });
    expect(caller.jobs.local?.needs).toEqual(["call-workflow-passing-data"]);

    const callee = ok(`
on:
  workflow_call:
    inputs:
      config-path:
        required: true
        type: string
      debug:
        type: boolean
        default: false
    outputs:
      firstword:
        description: "The first output string"
        value: \${{ jobs.example_job.outputs.output1 }}
    secrets:
      token:
        required: true
jobs:
  example_job:
    runs-on: ubuntu-latest
    outputs:
      output1: \${{ steps.step1.outputs.firstword }}
    steps:
      - id: step1
        run: echo "firstword=hello" >> $GITHUB_OUTPUT
`);
    expect(callee.on.workflow_call).toEqual({
      inputs: { "config-path": { required: true, type: "string" }, debug: { type: "boolean", default: false } },
      outputs: { firstword: { description: "The first output string", value: "${{ jobs.example_job.outputs.output1 }}" } },
      secrets: { token: { required: true } },
    });
  });

  it("services, container, defaults, runs-on group, concurrency string", () => {
    const wf = ok(`
on: push
defaults:
  run:
    shell: bash
    working-directory: scripts
concurrency: deploy
jobs:
  db:
    runs-on:
      group: big-runners
      labels: [linux]
    container: node:20
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        ports: ['5432:5432']
        options: --health-cmd pg_isready
      redis: redis:7
    permissions: read-all
    concurrency:
      group: db-\${{ github.ref }}
      cancel-in-progress: \${{ github.ref != 'refs/heads/main' }}
    continue-on-error: true
    steps:
      - run: psql -h postgres
`);
    expect(wf.defaults).toEqual({ run: { shell: "bash", "working-directory": "scripts" } });
    expect(wf.concurrency).toEqual({ group: "deploy", cancelInProgress: false });
    const j = wf.jobs.db!;
    expect(j.runsOn).toEqual(["linux"]);
    expect(j.runsOnGroup).toBe("big-runners");
    expect(j.container).toEqual({ image: "node:20" });
    expect(j.services).toEqual({
      postgres: { image: "postgres:16", env: { POSTGRES_PASSWORD: "postgres" }, ports: ["5432:5432"], options: "--health-cmd pg_isready" },
      redis: { image: "redis:7" },
    });
    expect(j.permissions).toBe("read-all");
    expect(j.concurrency).toEqual({ group: "db-${{ github.ref }}", cancelInProgress: "${{ github.ref != 'refs/heads/main' }}" });
    expect(j.continueOnError).toBe(true);
  });

  it("supports YAML anchors and merge keys", () => {
    const wf = ok(`
on: push
jobs:
  a: &base
    runs-on: ubuntu-latest
    env: &env
      A: 1
    steps:
      - run: echo a
  b:
    <<: *base
    env:
      <<: *env
      B: 2
`);
    expect(wf.jobs.b?.runsOn).toEqual(["ubuntu-latest"]);
    expect(wf.jobs.b?.env).toEqual({ A: "1", B: "2" });
  });
});

describe("`on` forms", () => {
  it("string", () => {
    expect(ok(`on: push\n${minimalJob}`).on).toEqual({ push: {} });
  });
  it("list", () => {
    expect(ok(`on: [push, pull_request, workflow_dispatch]\n${minimalJob}`).on).toEqual({
      push: {},
      pull_request: {},
      workflow_dispatch: {},
    });
  });
  it("map with null values", () => {
    expect(ok(`on:\n  push:\n  issues:\n    types: opened\n${minimalJob}`).on).toEqual({ push: {}, issues: { types: ["opened"] } });
  });
  it("map with all push/pull_request filters", () => {
    const wf = ok(`on:
  push:
    branches-ignore: [wip/**]
    tags-ignore: [nightly]
    paths-ignore: [docs/**]
  pull_request:
    types: [opened]
    branches-ignore: [gh-pages]
    paths: [src/**]
  schedule:
    - cron: '0 0 * * *'
    - cron: '*/30 9-17 * * MON-FRI'
  workflow_run:
    workflows: ["CI"]
    types: [completed]
  release:
    types: [published]
${minimalJob}`);
    expect(wf.on).toEqual({
      push: { branchesIgnore: ["wip/**"], tagsIgnore: ["nightly"], pathsIgnore: ["docs/**"] },
      pull_request: { types: ["opened"], branchesIgnore: ["gh-pages"], paths: ["src/**"] },
      schedule: [{ cron: "0 0 * * *" }, { cron: "*/30 9-17 * * MON-FRI" }],
      workflow_run: { workflows: ["CI"], types: ["completed"] },
      release: { types: ["published"] },
    });
  });
  it("'on' is not treated as a YAML 1.1 boolean", () => {
    const res = parseWorkflow(`"on": push\n${minimalJob}`, "w.yml");
    expect(res.workflow?.on).toEqual({ push: {} });
  });
});

describe("validation errors", () => {
  it("YAML syntax errors carry a line", () => {
    const e = fatal(`on: push\njobs:\n  build:\n    runs-on: [ubuntu\n    steps: x: y\n`);
    expect(e[0]?.message).toMatch(/YAML syntax error/);
    expect(e[0]?.line).toBeGreaterThan(0);
  });

  it("empty file / non-mapping", () => {
    expect(fatal("")[0]?.message).toMatch(/empty/);
    expect(fatal("- a\n- b\n")[0]?.message).toMatch(/must be a mapping/);
  });

  it("missing on", () => {
    const e = fatal(minimalJob);
    expect(e).toEqual([expect.objectContaining({ path: "on", message: "workflow is missing the 'on' trigger section" })]);
  });

  it("missing jobs", () => {
    const e = fatal("name: x\non: push\n");
    expect(e).toEqual([expect.objectContaining({ path: "jobs", message: "workflow is missing the 'jobs' section" })]);
    expect(fatal("on: push\njobs: {}\n")[0]?.message).toMatch(/at least one job/);
  });

  it("job missing runs-on, with line number of the job key", () => {
    const e = fatal(`on: push\njobs:\n  ok:\n    runs-on: x\n    steps: [{run: a}]\n  build:\n    steps:\n      - run: echo\n`);
    expect(e).toEqual([{ path: "jobs.build", line: 6, col: 3, message: "job 'build' is missing 'runs-on'" }]);
  });

  it("reusable workflow job does not need runs-on but cannot have steps", () => {
    expect(errs(`on: push\njobs:\n  call:\n    uses: ./.github/workflows/x.yml\n`)).toEqual([]);
    const e = fatal(`on: push\njobs:\n  call:\n    uses: ./.github/workflows/x.yml\n    steps:\n      - run: a\n`);
    expect(e[0]?.message).toMatch(/cannot have 'steps'/);
    expect(fatal(`on: push\njobs:\n  call:\n    uses: not-a-workflow\n`)[0]?.message).toMatch(/reusable workflow reference/);
  });

  it("step with both or neither run and uses", () => {
    const e = fatal(`on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo
        uses: actions/checkout@v4
      - name: nothing
`);
    expect(e).toEqual([
      { path: "jobs.build.steps[0]", line: 6, col: 9, message: "step cannot have both 'run' and 'uses'" },
      { path: "jobs.build.steps[1]", line: 8, col: 9, message: "step must have either 'run' or 'uses'" },
    ]);
  });

  it("job without steps", () => {
    expect(fatal(`on: push\njobs:\n  b:\n    runs-on: x\n`)[0]?.message).toMatch(/must have a list of 'steps'/);
  });

  it("duplicate step ids and invalid job ids", () => {
    const e = fatal(`on: push\njobs:\n  1bad:\n    runs-on: x\n    steps:\n      - id: a\n        run: x\n      - id: a\n        run: y\n`);
    expect(e.map((x) => x.message)).toEqual([expect.stringMatching(/job id '1bad'/), expect.stringMatching(/duplicate step id 'a'/)]);
  });

  it("unknown needs", () => {
    const e = fatal(`on: push\njobs:\n  a:\n    runs-on: x\n    needs: [nope]\n    steps: [{run: a}]\n`);
    expect(e).toEqual([{ path: "jobs.a.needs", line: 5, col: 5, message: "Job 'a' depends on unknown job 'nope'" }]);
  });

  it("dependency cycles", () => {
    const e = fatal(`on: push
jobs:
  a:
    runs-on: x
    needs: c
    steps: [{run: a}]
  b:
    runs-on: x
    needs: a
    steps: [{run: a}]
  c:
    runs-on: x
    needs: b
    steps: [{run: a}]
`);
    expect(e).toHaveLength(1);
    expect(e[0]?.message).toBe("Dependency cycle between jobs: a -> c -> b -> a");
    expect(e[0]?.line).toBe(5);
  });

  it("invalid cron", () => {
    const e = fatal(`on:\n  schedule:\n    - cron: '0 0 * *'\n${minimalJob}`);
    expect(e[0]).toMatchObject({ path: "on.schedule[0].cron", line: 3 });
    expect(e[0]?.message).toMatch(/Invalid cron: .*5 fields/);
    expect(fatal(`on:\n  schedule:\n    - cron: '61 * * * *'\n${minimalJob}`)[0]?.message).toMatch(/out of range/);
  });

  it("unclosed ${{", () => {
    const e = fatal(`on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ github.ref
`);
    expect(e).toEqual([
      expect.objectContaining({ path: "jobs.build.steps[0].run", line: 6, message: expect.stringMatching(/Unclosed expression/) }),
    ]);
  });

  it("expression syntax errors, including bare if conditions", () => {
    const e = fatal(`on: push
jobs:
  build:
    if: github.event_name ==
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ nosuch(1) }}
      - run: echo ok
        if: \${{ (1 }}
`);
    expect(e.map((x) => x.path)).toEqual(["jobs.build.if", "jobs.build.steps[0].run", "jobs.build.steps[1].if"]);
    expect(e[1]?.message).toMatch(/Unrecognized function 'nosuch'/);
  });

  it("invalid dispatch inputs and push filter conflicts", () => {
    const e = fatal(`on:
  push:
    branches: [main]
    branches-ignore: [dev]
  workflow_dispatch:
    inputs:
      a:
        type: chioce
      b:
        type: choice
${minimalJob}`);
    expect(e.map((x) => x.message)).toEqual([
      "'branches' and 'branches-ignore' cannot be used together for the same event",
      expect.stringMatching(/invalid type 'chioce'/),
      expect.stringMatching(/must define 'options'/),
    ]);
  });

  it("invalid static matrix", () => {
    const e = fatal(`on: push\njobs:\n  b:\n    runs-on: x\n    strategy:\n      matrix:\n        os: ubuntu\n    steps: [{run: a}]\n`);
    expect(e[0]?.message).toMatch(/matrix.os must be a list/);
  });

  it("unknown keys are warnings and do not block the workflow", () => {
    const res = parseWorkflow(
      `on:\n  push:\n  pushh:\nfoo: 1\njobs:\n  b:\n    runs-on: x\n    bar: 1\n    steps:\n      - run: a\n        baz: 1\n`,
      "w.yml",
    );
    expect(res.workflow).toBeDefined();
    expect(res.errors.map((e) => [e.path, e.line, e.message])).toEqual([
      ["on.pushh", 3, "warning: unknown event 'pushh'"],
      ["foo", 4, "warning: unknown top-level key 'foo'"],
      ["jobs.b.bar", 8, "warning: unknown job key 'bar'"],
      ["jobs.b.steps[0].baz", 11, "warning: unknown step key 'baz'"],
    ]);
    expect(res.errors.every(isWarning)).toBe(true);
  });

  it("type errors in env and with", () => {
    const e = fatal(`on: push\nenv:\n  A: [1]\n${minimalJob}`);
    expect(e[0]).toMatchObject({ path: "env.A", message: "env.A must be a string, number or boolean" });
  });
});

describe("jobOrder", () => {
  it("groups jobs into levels in file order", () => {
    const wf = ok(`on: push
jobs:
  lint: {runs-on: x, steps: [{run: a}]}
  test: {runs-on: x, steps: [{run: a}]}
  build: {runs-on: x, needs: [lint, test], steps: [{run: a}]}
  docs: {runs-on: x, needs: lint, steps: [{run: a}]}
  deploy: {runs-on: x, needs: [build, docs], steps: [{run: a}]}
`);
    expect(jobOrder(wf)).toEqual({ order: [["lint", "test"], ["build", "docs"], ["deploy"]], errors: [] });
  });

  it("reports unknown needs and cycles on a constructed workflow", () => {
    const wf = ok(`on: push\n${minimalJob}`);
    const job = wf.jobs.build!;
    wf.jobs = {
      a: { ...job, key: "a", needs: ["b"] },
      b: { ...job, key: "b", needs: ["a"] },
      c: { ...job, key: "c", needs: ["zzz"] },
    };
    const res = jobOrder(wf);
    expect(res.order).toEqual([["c"]]);
    expect(res.errors.map((e) => e.message)).toEqual([
      "Job 'c' depends on unknown job 'zzz'",
      "Dependency cycle between jobs: a -> b -> a",
    ]);
  });
});
