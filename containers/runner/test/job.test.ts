import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobSpec, StepSpec } from "@diffinery/shared";
import { apiBaseFor, runAgentJob } from "../src/agent.js";
import type { JobRunner } from "../src/job.js";
import { makeSpec, startFakeApi, tmp, type FakeApi } from "./helpers.js";

let api: FakeApi;
let workRoot: string;

beforeEach(async () => {
  api = await startFakeApi();
  workRoot = tmp();
});
afterEach(async () => {
  await api.close();
  rmSync(workRoot, { recursive: true, force: true });
});

function run(spec: JobSpec, extra: { onRunner?: (r: JobRunner) => void } = {}) {
  return runAgentJob(spec, {
    apiBase: apiBaseFor(spec.apiUrl, spec.jobId),
    workRoot,
    toolCache: path.join(workRoot, "_tool"),
    logIntervalMs: 50,
    echoLogs: false,
    ...extra,
  });
}

const workspace = () => path.join(workRoot, "widgets");

/** Async spawn: the fake API lives in this process, so the event loop must stay free. */
function spawnAsync(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (status) => {
      clearTimeout(t);
      resolve({ status, stdout, stderr });
    });
  });
}

describe("job runner end-to-end", () => {
  it("propagates env, outputs, path, summaries and job outputs", async () => {
    const spec = makeSpec(
      api,
      [
        {
          id: "one",
          name: "Step ${{ github.job }} one",
          run: [
            'echo "hello from step one"',
            'echo "FOO=bar" >> "$GITHUB_ENV"',
            '{ echo "MULTI<<EOF"; echo "line1"; echo "line2"; echo "EOF"; } >> "$GITHUB_ENV"',
            'echo "greeting=hi there" >> "$GITHUB_OUTPUT"',
            'mkdir -p "$RUNNER_TEMP/mybin" "$GITHUB_WORKSPACE/sub"',
            `printf '#!/bin/sh\\necho mytool-ran\\n' > "$RUNNER_TEMP/mybin/mytool"`,
            'chmod +x "$RUNNER_TEMP/mybin/mytool"',
            'echo "$RUNNER_TEMP/mybin" >> "$GITHUB_PATH"',
            'echo "::set-output name=legacy::old-style"',
            'echo "# Summary one" >> "$GITHUB_STEP_SUMMARY"',
          ].join("\n"),
        },
        {
          id: "two",
          env: { STEP_VAR: "${{ steps.one.outputs.greeting }}", FOO: "${{ env.FOO }}-override" },
          run: [
            'echo "foo=$FOO"',
            'echo "multi=$(echo "$MULTI" | tr "\\n" ",")"',
            "mytool",
            'echo "step_var=$STEP_VAR job_var=$JOB_VAR matrix=${{ matrix.os }}"',
            'echo "ci=$CI actions=$GITHUB_ACTIONS diffinery=$DIFFINERY repo=$GITHUB_REPOSITORY ref_name=$GITHUB_REF_NAME type=$GITHUB_REF_TYPE"',
            'echo "server=$GITHUB_SERVER_URL api=$GITHUB_API_URL os=$RUNNER_OS job=$GITHUB_JOB actor=$GITHUB_ACTOR"',
            'echo "event=$(cat "$GITHUB_EVENT_PATH" | tr -d " \\n")"',
            'echo "## Summary two" >> "$GITHUB_STEP_SUMMARY"',
          ].join("\n"),
        },
        { name: "conditional", if: "steps.one.outputs.greeting == 'hi there'", run: 'echo "conditional ran with $FOO"' },
        { name: "never", if: "steps.one.outputs.greeting == 'nope'", run: 'echo "SHOULD NOT RUN"' },
        { name: "wd", "working-directory": "sub", run: 'echo "pwd=$(pwd)"' },
        { name: "py", shell: "python", run: 'import os\nprint("py-foo=" + os.environ["FOO"])' },
        { name: "custom", shell: "sh -e {0}", run: 'echo "custom shell ok"' },
      ],
      {
        env: { JOB_VAR: "${{ github.repository }}-x" },
        matrix: { os: "linux" },
        outputs: { greeting: "${{ steps.one.outputs.greeting }}", legacy: "${{ steps.one.outputs.legacy }}", combo: "${{ steps.two.outcome }}/${{ env.FOO }}" },
      },
    );
    const c = await run(spec);
    const log = api.logText();
    expect(c.conclusion, log).toBe("success");
    expect(api.completion).toEqual(c);
    expect(c.outputs).toEqual({ greeting: "hi there", legacy: "old-style", combo: "success/bar" });
    expect(c.summary).toContain("# Summary one");
    expect(c.summary).toContain("## Summary two");

    const s1 = api.logText(1);
    expect(s1).toContain("foo=bar-override");
    expect(s1).toContain("multi=line1,line2,");
    expect(s1).toContain("mytool-ran");
    expect(s1).toContain("step_var=hi there job_var=acme/widgets-x matrix=linux");
    expect(s1).toContain("ci=true actions=true diffinery=true repo=acme/widgets ref_name=main type=branch");
    expect(s1).toContain(`server=${api.url} api=${api.url}/api/v3 os=Linux job=build actor=octo`);
    expect(s1).toContain('event={"ref":"refs/heads/main","pusher":{"name":"octo"}}');
    expect(api.logText(2)).toContain("conditional ran with bar");
    expect(log).not.toContain("SHOULD NOT RUN");
    expect(api.logText(4)).toContain(`pwd=${path.join(workspace(), "sub")}`);
    expect(api.logText(5)).toContain("py-foo=bar");
    expect(api.logText(6)).toContain("custom shell ok");

    expect(api.lastReport(0)).toMatchObject({ status: "completed", conclusion: "success", name: "Step build one" });
    expect(api.lastReport(3)).toMatchObject({ status: "completed", conclusion: "skipped" });
    expect(api.steps.find((s) => s.index === 0 && s.report.status === "in_progress")).toBeTruthy();
    expect(api.steps.find((s) => s.index === 3 && s.report.status === "in_progress")).toBeFalsy();
    // all requests authenticated with the job token
    expect(api.requests.every((r) => r.auth === `Bearer ${api.token}`)).toBe(true);
  });

  it("handles failures, continue-on-error, failure() and always()", async () => {
    const spec = makeSpec(api, [
      { id: "ok", run: "echo ok" },
      { id: "soft", "continue-on-error": true, run: "echo soft-failing; exit 3" },
      { name: "after-soft", run: 'echo "after soft ${{ steps.soft.outcome }} ${{ steps.soft.conclusion }} ${{ job.status }}"' },
      { id: "bad", name: "Compile", run: 'echo "compiling..."\necho "::error file=src/a.ts,line=4::type mismatch"\nexit 1' },
      { name: "skipped-by-failure", run: "echo SHOULD-NOT-RUN" },
      { name: "on-failure", if: "failure()", run: 'echo "failure handler: ${{ steps.bad.outcome }} ${{ job.status }}"' },
      { name: "always", if: "${{ always() }}", run: "echo always-ran" },
      { name: "on-success", if: "success()", run: "echo SHOULD-NOT-RUN-2" },
      { name: "cancelled-only", if: "cancelled()", run: "echo SHOULD-NOT-RUN-3" },
    ]);
    const c = await run(spec);
    expect(c.conclusion).toBe("failure");
    expect(c.failure).toEqual({ step: 3, message: "src/a.ts:4: type mismatch" });
    expect(api.lastReport(1)?.conclusion).toBe("success");
    expect(api.logText(2)).toContain("after soft failure success success");
    expect(api.lastReport(3)?.conclusion).toBe("failure");
    expect(api.lastReport(4)?.conclusion).toBe("skipped");
    expect(api.logText(5)).toContain("failure handler: failure failure");
    expect(api.lastReport(5)?.conclusion).toBe("success");
    expect(api.logText(6)).toContain("always-ran");
    expect(api.lastReport(7)?.conclusion).toBe("skipped");
    expect(api.lastReport(8)?.conclusion).toBe("skipped");
    expect(api.logText()).not.toMatch(/SHOULD-NOT-RUN/);
    expect(api.logText(3)).toContain("##[error]src/a.ts:4: type mismatch");
    expect(api.logText(3)).toContain("##[error]Process completed with exit code 1.");
  });

  it("summarises failures without annotations from the step's last log lines", async () => {
    const spec = makeSpec(api, [{ run: 'for i in $(seq 1 30); do echo "line $i"; done\necho "fatal: it broke" >&2\nexit 7' }]);
    const c = await run(spec);
    expect(c.conclusion).toBe("failure");
    expect(c.failure?.step).toBe(0);
    expect(c.failure?.message).toMatch(/^Process completed with exit code 7\./);
    expect(c.failure?.message).toContain("fatal: it broke");
    expect(c.failure?.message).toContain("line 30");
    expect(c.failure?.message).not.toContain("line 5\n");
  });

  it("masks secrets (incl. multi-line and ::add-mask::) in logs and outputs", async () => {
    const spec = makeSpec(
      api,
      [
        {
          id: "s",
          env: { TOKEN: "${{ secrets.GITHUB_TOKEN }}", PEM: "${{ secrets.PEM }}" },
          run: [
            'echo "key=${{ secrets.API_KEY }}"',
            'echo "token=$TOKEN"',
            'echo "$PEM"',
            'V=dynamic; echo "::add-mask::${V}-secret-42"',
            'echo "now ${V}-secret-42 is hidden"',
            'echo "leak=${{ secrets.API_KEY }}" >> "$GITHUB_OUTPUT"',
            'echo "fine=visible" >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
      ],
      {
        secrets: { API_KEY: "s3cr3t-value", PEM: "-----BEGIN-----\nabcdefghijklmnop\n-----END-----" },
        outputs: { leak: "${{ steps.s.outputs.leak }}", fine: "${{ steps.s.outputs.fine }}" },
      },
    );
    const c = await run(spec);
    expect(c.conclusion).toBe("success");
    const log = api.logText();
    expect(log).not.toContain("s3cr3t-value");
    expect(log).not.toContain(api.token);
    expect(log).not.toContain("abcdefghijklmnop");
    expect(log).not.toContain("dynamic-secret-42");
    expect(log).toContain("key=***");
    expect(log).toContain("token=***");
    expect(log).toContain("now *** is hidden");
    expect(c.outputs).toEqual({ fine: "visible" });
  });

  it("interprets workflow commands", async () => {
    const spec = makeSpec(
      api,
      [
        {
          run: [
            'echo "::group::My Group"',
            "echo inside",
            'echo "::endgroup::"',
            'echo "::warning title=Heads up::be careful"',
            'echo "::notice::multi%0Aline"',
            'echo "::debug::hidden debug"',
            'T=pause123; echo "::stop-commands::$T"',
            'echo "::warning::not a command"',
            'echo "::$T::"',
            'echo "::warning::real again"',
            'echo "::save-state name=x::y"',
          ].join("\n"),
        },
      ],
      {},
    );
    const c = await run(spec);
    expect(c.conclusion).toBe("success");
    const lines = api.logs.filter((l) => l.step === 0).map((l) => l.text);
    const after = lines.slice(lines.indexOf("##[endgroup]") + 1);
    expect(after).toEqual([
      "##[group]My Group",
      "inside",
      "##[endgroup]",
      "##[warning]Heads up: be careful",
      "##[notice]multi",
      "line",
      "::warning::not a command",
      "##[warning]real again",
    ]);
  });

  it("shows ::debug:: when ACTIONS_STEP_DEBUG is set", async () => {
    const spec = makeSpec(api, [{ run: 'echo "::debug::now visible"; echo "dbg=$RUNNER_DEBUG"' }], { secrets: { ACTIONS_STEP_DEBUG: "true" } });
    await run(spec);
    expect(api.logText(0)).toContain("##[debug]now visible");
    expect(api.logText(0)).toContain("dbg=1");
  });

  it("runs composite and node local actions with pre/post and state", async () => {
    const ws = workspace();
    mkdirSync(path.join(ws, ".github/actions/greet"), { recursive: true });
    mkdirSync(path.join(ws, ".github/actions/nodey"), { recursive: true });
    writeFileSync(
      path.join(ws, ".github/actions/greet/action.yml"),
      `name: Greet
description: composite greet
inputs:
  who:
    description: who
    required: true
  punct:
    default: "!"
outputs:
  message:
    description: msg
    value: \${{ steps.say.outputs.msg }}
runs:
  using: composite
  steps:
    - id: say
      shell: bash
      run: |
        echo "Hello \${{ inputs.who }}\${{ inputs.punct }}"
        echo "msg=Hello \${{ inputs.who }}" >> "$GITHUB_OUTPUT"
        echo "action path is $GITHUB_ACTION_PATH"
        echo "inherited=$OUTER"
    - name: nested if
      if: \${{ inputs.who == 'nobody' }}
      shell: bash
      run: echo "SHOULD-NOT-RUN"
    - shell: bash
      run: echo "COMPOSITE_ENV=set" >> $GITHUB_ENV
    - uses: ./.github/actions/nodey
      with:
        my-input: from-composite
`,
    );
    writeFileSync(
      path.join(ws, ".github/actions/nodey/action.yml"),
      `name: nodey
inputs:
  my-input:
    default: default-val
  repo:
    default: \${{ github.repository }}
outputs:
  result:
    description: r
runs:
  using: node20
  pre: pre.js
  main: index.js
  post: post.js
  post-if: success()
`,
    );
    writeFileSync(
      path.join(ws, ".github/actions/nodey/pre.js"),
      `require("fs").appendFileSync(process.env.GITHUB_STATE, "fromPre=pre-state\\n"); console.log("pre ran");`,
    );
    writeFileSync(
      path.join(ws, ".github/actions/nodey/index.js"),
      `const fs = require("fs");
console.log("input=" + process.env["INPUT_MY-INPUT"] + " repo=" + process.env.INPUT_REPO + " prestate=" + process.env.STATE_fromPre);
fs.appendFileSync(process.env.GITHUB_OUTPUT, "result=from-node-" + process.env["INPUT_MY-INPUT"] + "\\n");
fs.appendFileSync(process.env.GITHUB_STATE, "saved=state-" + process.env["INPUT_MY-INPUT"] + "\\n");
`,
    );
    writeFileSync(path.join(ws, ".github/actions/nodey/post.js"), `console.log("post ran with state " + process.env.STATE_saved + "/" + process.env.STATE_fromPre);`);

    const spec = makeSpec(api, [
      { uses: "./.github/actions/greet", id: "greet", with: { who: "World" }, env: { OUTER: "outer-env" } },
      { run: 'echo "composite said ${{ steps.greet.outputs.message }} env=$COMPOSITE_ENV"' },
      { uses: "./.github/actions/nodey", id: "nodey", with: { "my-input": "hello" } },
      { run: 'echo "node said ${{ steps.nodey.outputs.result }}"' },
    ]);
    const c = await run(spec);
    const log = api.logText();
    expect(c.conclusion, log).toBe("success");
    const s0 = api.logText(0);
    expect(s0).toContain("Hello World!");
    expect(s0).toContain(`action path is ${path.join(ws, ".github/actions/greet")}`);
    expect(s0).toContain("inherited=outer-env");
    expect(s0).toContain("input=from-composite repo=acme/widgets prestate=pre-state");
    expect(log).not.toContain("SHOULD-NOT-RUN");
    expect(api.logText(1)).toContain("composite said Hello World env=set");
    expect(api.logText(2)).toContain("pre ran");
    expect(api.logText(2)).toContain("input=hello repo=acme/widgets prestate=pre-state");
    expect(api.logText(3)).toContain("node said from-node-hello");
    // post steps run in reverse order after the main steps
    expect(api.logText(4)).toContain("post ran with state state-hello/pre-state");
    expect(api.logText(5)).toContain("post ran with state state-from-composite/pre-state");
    expect(api.lastReport(4)).toMatchObject({ status: "completed", conclusion: "success", name: "Post Run ./.github/actions/nodey" });
  });

  it("fails composite steps and reports the inner error", async () => {
    const ws = workspace();
    mkdirSync(path.join(ws, "act"), { recursive: true });
    writeFileSync(
      path.join(ws, "act/action.yaml"),
      `runs:
  using: composite
  steps:
    - run: echo "::error::inner broke"; exit 2
      shell: bash
    - run: echo "inner-cleanup"
      if: always()
      shell: bash
`,
    );
    const c = await run(makeSpec(api, [{ uses: "./act" }, { run: "echo after", if: "always()" }]));
    expect(c.conclusion).toBe("failure");
    expect(c.failure).toEqual({ step: 0, message: "inner broke" });
    expect(api.logText(0)).toContain("inner-cleanup");
    expect(api.logText(1)).toContain("after");
  });

  it("downloads and runs remote actions (owner/repo/path@ref)", async () => {
    // fake codeload: serves a tarball with a top-level folder, like GitHub does
    const src = tmp("remote-action-");
    const top = path.join(src, "tools-abc123");
    mkdirSync(path.join(top, "hello"), { recursive: true });
    writeFileSync(
      path.join(top, "hello/action.yml"),
      "name: hello\ninputs:\n  name:\n    default: anon\noutputs:\n  said:\n    description: x\nruns:\n  using: 'node24'\n  main: 'main.js'\n",
    );
    writeFileSync(
      path.join(top, "hello/main.js"),
      'require("fs").appendFileSync(process.env.GITHUB_OUTPUT, `said=hi ${process.env.INPUT_NAME}\\n`); console.log("remote action ran in", process.env.GITHUB_ACTION_REPOSITORY, process.env.GITHUB_ACTION_REF);',
    );
    const tarball = path.join(src, "a.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", src, "tools-abc123"]);
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/acme/tools/tar.gz/v1") {
        res.writeHead(200, { "content-type": "application/gzip" });
        res.end(readFileSync(tarball));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const prev = process.env.DIFFINERY_ACTIONS_DOWNLOAD_URL;
    process.env.DIFFINERY_ACTIONS_DOWNLOAD_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/{owner}/{repo}/tar.gz/{ref}`;
    try {
      const c = await run(
        makeSpec(api, [
          { id: "h", uses: "acme/tools/hello@v1", with: { name: "bob" } },
          { uses: "acme/tools/hello@v1" },
          { run: 'echo "out=${{ steps.h.outputs.said }}"' },
          { uses: "acme/missing@v9" },
        ]),
      );
      expect(api.logText(0)).toContain("remote action ran in acme/tools v1");
      expect(api.logText(2)).toContain("out=hi bob");
      expect(hits.filter((h) => h === "/acme/tools/tar.gz/v1")).toHaveLength(1); // cached after first download
      expect(c.conclusion).toBe("failure");
      expect(c.failure?.step).toBe(3);
      expect(c.failure?.message).toContain("Unable to resolve action 'acme/missing@v9'");
    } finally {
      if (prev === undefined) delete process.env.DIFFINERY_ACTIONS_DOWNLOAD_URL;
      else process.env.DIFFINERY_ACTIONS_DOWNLOAD_URL = prev;
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("runs github-script, and built-ins it cannot mirror, as the real actions", async () => {
    // fake codeload serving one node action for every repository
    const src = tmp("real-action-");
    mkdirSync(path.join(src, "top"), { recursive: true });
    writeFileSync(path.join(src, "top/action.yml"), "name: real\nruns:\n  using: node20\n  main: main.js\n");
    writeFileSync(
      path.join(src, "top/main.js"),
      'const e = process.env; console.log(`real ${e.GITHUB_ACTION_REPOSITORY}@${e.GITHUB_ACTION_REF} server=${e.GITHUB_SERVER_URL} results=${e.ACTIONS_RESULTS_URL} v2=${e.ACTIONS_CACHE_SERVICE_V2} token=${e.ACTIONS_RUNTIME_TOKEN ? "set" : "unset"} image=${e.ImageOS}`); require("fs").appendFileSync(e.GITHUB_OUTPUT, "artifact-url=https://github.com/acme/widgets/actions/runs/1/artifacts/7\\n");',
    );
    const tarball = path.join(src, "a.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", src, "top"]);
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(readFileSync(tarball));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const prev = process.env.DIFFINERY_ACTIONS_DOWNLOAD_URL;
    process.env.DIFFINERY_ACTIONS_DOWNLOAD_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/{owner}/{repo}/{ref}`;
    try {
      const c = await run(
        makeSpec(api, [
          { uses: "actions/github-script@v7", with: { script: "return 1" } },
          { uses: "actions/cache@v4", env: { DIFFINERY_BUILTINS: "false" }, with: { path: "x", key: "k" } },
          { uses: "actions/setup-node@v4", with: { "node-version": "20", "some-future-input": "x" } },
          { uses: "actions/checkout@main" },
          { id: "up", uses: "actions/upload-artifact@v4", with: { name: "a", path: "x", "unknown-input": "1" } },
          { run: 'echo "url=${{ steps.up.outputs.artifact-url }}"' },
        ]),
      );
      expect(c.conclusion, api.logText()).toBe("success");
      expect(api.logText(0)).toContain(`real actions/github-script@v7 server=${api.url} results=${api.url}/ v2=true token=set image=ubuntu24`);
      expect(api.logText(0)).not.toContain(api.runtimeToken);
      expect(api.logText(1)).toContain("real actions/cache@v4");
      expect(api.logText(2)).toContain("real actions/setup-node@v4");
      expect(api.logText(3)).toContain("real actions/checkout@main");
      // @actions/artifact refuses GHES, so the artifact actions see github.com and their URLs are mapped back
      expect(api.logText(4)).toContain("real actions/upload-artifact@v4 server=https://github.com");
      expect(api.logText(5)).toContain(`url=${api.url}/acme/widgets/actions/runs/1/artifacts/7`);
      expect(hits).toEqual(["/actions/github-script/v7", "/actions/cache/v4", "/actions/setup-node/v4", "/actions/checkout/main", "/actions/upload-artifact/v4"]);
    } finally {
      if (prev === undefined) delete process.env.DIFFINERY_ACTIONS_DOWNLOAD_URL;
      else process.env.DIFFINERY_ACTIONS_DOWNLOAD_URL = prev;
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("enforces step timeout-minutes", async () => {
    const start = Date.now();
    const c = await run(makeSpec(api, [{ "timeout-minutes": 0.02, run: "sleep 30" }, { if: "always()", run: "echo after-timeout" }]));
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(c.conclusion).toBe("failure");
    expect(c.failure?.message).toContain("timed out");
    expect(api.logText(1)).toContain("after-timeout");
  });

  const cancelOnce = async (steps: StepSpec[], cancel: (r: JobRunner) => void) => {
    let runner: JobRunner | undefined;
    const p = run(makeSpec(api, steps), { onRunner: (r) => (runner = r) });
    const t0 = Date.now();
    while (!api.logText(0).includes("started") && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
    cancel(runner!);
    return { c: await p, ms: Date.now() - t0 };
  };

  it("cancels on request: kills the process group, then runs only the steps that run after a cancel", async () => {
    const { c, ms } = await cancelOnce(
      [
        { run: "echo started; (sleep 60 & wait)" },
        { run: "echo never" },
        { if: "failure()", run: "echo never-failure" },
        { if: "always()", run: "echo always-ran" },
        { if: "${{ cancelled() }}", run: 'echo "cancelled-ran $JOB_STATUS"', env: { JOB_STATUS: "${{ job.status }}" } },
        { if: "!cancelled()", run: "echo never-not-cancelled" },
      ],
      (r) => r.cancel(),
    );
    expect(c.conclusion).toBe("cancelled");
    expect(c.failure?.message).toBe("The job was cancelled.");
    expect(api.lastReport(0)?.conclusion).toBe("cancelled");
    expect(api.lastReport(1)?.conclusion).toBe("cancelled");
    expect(api.lastReport(2)?.conclusion).toBe("cancelled");
    expect(api.lastReport(3)?.conclusion).toBe("success");
    expect(api.lastReport(4)?.conclusion).toBe("success");
    expect(api.lastReport(5)?.conclusion).toBe("cancelled");
    expect(api.logText(3)).toContain("always-ran");
    expect(api.logText(4)).toContain("cancelled-ran cancelled");
    expect(api.logText()).not.toContain("never");
    expect(api.completion?.conclusion).toBe("cancelled");
    expect(ms).toBeLessThan(10_000);
  });

  it("a second cancel stops the steps that run after a cancel", async () => {
    const steps: StepSpec[] = [{ run: "echo started; sleep 60" }, { if: "always()", run: "echo cleanup-started; sleep 60" }, { if: "always()", run: "echo never" }];
    let runner: JobRunner | undefined;
    const p = run(makeSpec(api, steps), { onRunner: (r) => (runner = r) });
    const t0 = Date.now();
    while (!api.logText(0).includes("started") && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
    runner!.cancel();
    const t1 = Date.now();
    while (!api.logText(1).includes("cleanup-started") && Date.now() - t1 < 15_000) await new Promise((r) => setTimeout(r, 50));
    expect(api.logText(1)).toContain("cleanup-started");
    runner!.cancel();
    const c = await p;
    expect(c.conclusion).toBe("cancelled");
    expect(api.lastReport(1)?.conclusion).toBe("cancelled");
    expect(api.lastReport(2)?.conclusion).toBe("cancelled");
    expect(api.logText(2)).not.toContain("never");
    expect(Date.now() - t1).toBeLessThan(15_000);
  });

  it("a process a step starts after the job was stopped is stopped at once", async () => {
    let runner: JobRunner | undefined;
    const p = run(makeSpec(api, [{ run: "echo started; sleep 60" }, { if: "always()", run: "echo cleanup-started; sleep 60" }]), { onRunner: (r) => (runner = r) });
    const t0 = Date.now();
    while (!api.logText(0).includes("started") && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
    // Both cancels before the cleanup step's process starts: it must not run its 60 seconds.
    runner!.cancel();
    runner!.cancel();
    const c = await p;
    expect(c.conclusion).toBe("cancelled");
    expect(api.lastReport(1)?.conclusion).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  it("stops the steps that run after a cancel once their grace runs out", async () => {
    let runner: JobRunner | undefined;
    const p = run(makeSpec(api, [{ run: "echo started; sleep 60" }, { if: "always()", run: "echo cleanup-started; sleep 60" }, { if: "always()", run: "echo never" }]), { onRunner: (r) => (runner = r) });
    const t0 = Date.now();
    while (!api.logText(0).includes("started") && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
    runner!.cancel("cancelled", 1500);
    const c = await p;
    expect(c.conclusion).toBe("cancelled");
    expect(api.logText(1)).toContain("cleanup-started");
    expect(api.lastReport(1)?.conclusion).toBe("cancelled");
    expect(api.lastReport(2)?.conclusion).toBe("cancelled");
    expect(api.logText()).toContain("took longer than");
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it("runs always() steps and post steps after the job's timeout", async () => {
    const c = await run(makeSpec(api, [{ run: "echo started; sleep 60" }, { run: "echo never" }, { if: "always()", run: "echo after-job-timeout" }], { timeoutMinutes: 0.03 }));
    expect(c.conclusion).toBe("failure");
    expect(c.failure?.message).toContain("maximum execution time");
    expect(api.lastReport(1)?.conclusion).toBe("cancelled");
    expect(api.lastReport(2)?.conclusion).toBe("success");
    expect(api.logText(2)).toContain("after-job-timeout");
  });

  it("never loses log lines when the log endpoint flakes", async () => {
    api.failLogs = 2;
    const c = await run(makeSpec(api, [{ run: "for i in $(seq 1 500); do echo \"n$i\"; done" }]));
    expect(c.conclusion).toBe("success");
    const nums = api.logs.filter((l) => l.step === 0 && /^n\d+$/.test(l.text)).map((l) => l.text);
    expect(nums).toEqual(Array.from({ length: 500 }, (_, i) => `n${i + 1}`));
  });

  it("caches and restores via the cache service, and round-trips artifacts", async () => {
    const steps: StepSpec[] = [
      { run: 'mkdir -p deps dist/sub && echo "${{ github.run_id }}" > deps/marker && echo a > dist/a.txt && echo b > dist/sub/b.txt' },
      { id: "cache", uses: "actions/cache@v4", with: { path: "deps", key: "deps-${{ hashFiles('**/lock.txt') }}-v1", "restore-keys": "deps-" } },
      { run: 'echo "hit=${{ steps.cache.outputs.cache-hit }}"; cat deps/marker' },
      { uses: "actions/upload-artifact@v4", with: { name: "dist", path: "dist/" } },
      { id: "dl", uses: "actions/download-artifact@v4", with: { name: "dist", path: "out" } },
      { run: 'cat out/a.txt out/sub/b.txt; echo "dl=${{ steps.dl.outputs.download-path }}"' },
    ];
    mkdirSync(workspace(), { recursive: true });
    writeFileSync(path.join(workspace(), "lock.txt"), "v1");
    const c1 = await run(makeSpec(api, steps, { runId: "first" }));
    expect(c1.conclusion, api.logText()).toBe("success");
    expect(api.logText(2)).toMatch(/\nhit=\n/); // like actions/cache, a miss leaves cache-hit unset
    expect([...api.cache.keys()]).toHaveLength(1);
    const key = [...api.cache.keys()][0]!;
    expect(key).toMatch(/^deps-[0-9a-f]{64}-v1$/);
    expect(api.artifacts.get("dist")?.mimeType).toBe("application/zip");
    expect(api.artifacts.get("dist")?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(api.logText(5)).toMatch(/a\nb\ndl=.*\/out/);
    // post step saved the cache
    expect(api.steps.some((s) => s.report.name === "Post Run actions/cache@v4" && s.report.conclusion === "success")).toBe(true);

    // second run: wipe the cached dir, it must come back from the cache
    rmSync(path.join(workspace(), "deps"), { recursive: true, force: true });
    api.logs = [];
    api.steps = [];
    const steps2 = [steps[1]!, steps[2]!];
    const c2 = await run(makeSpec(api, steps2, { runId: "second" }));
    expect(c2.conclusion, api.logText()).toBe("success");
    expect(api.logText(1)).toContain("hit=true");
    expect(api.logText(1)).toContain("first");
    // like actions/cache, the post step runs but does not save over an exact hit
    expect(api.logText()).toContain(`Cache hit occurred on the primary key ${key}, not saving cache.`);
    expect([...api.cache.keys()]).toEqual([key]);
  });

  it("streams a large cache entry in ranges, falls back to a full download, and leaves nothing half restored", async () => {
    const steps: StepSpec[] = [
      { id: "cache", uses: "actions/cache@v4", with: { path: "deps", key: "big-v1" } },
      { run: 'echo "hit=${{ steps.cache.outputs.cache-hit }}"; cat deps/marker; sha256sum deps/big.bin | cut -c1-16' },
    ];
    // Random data doesn't compress, so the archive spans several 8 MiB ranges.
    const big = randomBytes(20 * 1024 * 1024);
    const sum = createHash("sha256").update(big).digest("hex").slice(0, 16);
    const fill = () => {
      mkdirSync(path.join(workspace(), "deps"), { recursive: true });
      writeFileSync(path.join(workspace(), "deps", "marker"), "cached");
      writeFileSync(path.join(workspace(), "deps", "big.bin"), big);
    };
    fill();
    expect((await run(makeSpec(api, steps, { runId: "save" }))).conclusion, api.logText()).toBe("success");
    expect(api.cache.get("big-v1")!.length).toBeGreaterThan(16 * 1024 * 1024);

    const again = async (changes: number) => {
      rmSync(path.join(workspace(), "deps"), { recursive: true, force: true });
      api.logs = [];
      api.steps = [];
      api.blobGets = [];
      api.blobChanges = changes;
      return run(makeSpec(api, [steps[0]!, { run: 'set +e; echo "hit=${{ steps.cache.outputs.cache-hit }}"; ls deps 2>&1; cat deps/marker; sha256sum deps/big.bin | cut -c1-16; true' }], { runId: `r${changes}` }));
    };
    // Streamed: ranges, more than one, all of the same blob.
    expect((await again(0)).conclusion, api.logText()).toBe("success");
    expect(api.blobGets.length).toBeGreaterThan(2);
    expect(api.blobGets.every((r) => r.startsWith("bytes="))).toBe(true);
    expect(api.logText(1)).toContain("hit=true");
    expect(api.logText(1)).toContain(sum);

    // The blob changes under the stream once: the restore starts over from a full download.
    expect((await again(1)).conclusion, api.logText()).toBe("success");
    expect(api.logText(0)).toMatch(/Streaming the cache entry failed \(download failed: the blob changed while it was being downloaded\); downloading it in full/);
    expect(api.logText(1)).toContain(sum);

    // It keeps changing: the restore fails, and what the stream extracted is gone again.
    expect((await again(1000)).conclusion, api.logText()).toBe("success");
    expect(api.logText(0)).toContain("Failed to restore");
    expect(api.logText(1)).toMatch(/hit=\n/);
    expect(existsSync(path.join(workspace(), "deps"))).toBe(false);
  });

  it("checks out a repository with actions/checkout", async () => {
    const origin = tmp("origin-");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: origin, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(origin, "README.md"), "first\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    writeFileSync(path.join(origin, "README.md"), "second\n");
    git("commit", "-q", "-am", "second");
    const sha = git("rev-parse", "HEAD");
    git("tag", "v1");
    const spec = makeSpec(
      api,
      [
        { id: "co", uses: "actions/checkout@v4" },
        { run: 'cat README.md; git rev-parse HEAD; git rev-parse --abbrev-ref HEAD; echo "commit=${{ steps.co.outputs.commit }}"; git rev-list --count HEAD' },
        { uses: "actions/checkout@v4", with: { path: "full", "fetch-depth": "0", ref: "v1" } },
        { run: "git -C full rev-list --count HEAD; cat full/README.md" },
      ],
      { sha, repo: { owner: "acme", name: "widgets", cloneUrl: `file://${origin}`, defaultBranch: "main" } },
    );
    const c = await run(spec);
    expect(c.conclusion, api.logText()).toBe("success");
    const out = api.logText(1);
    expect(out).toContain("second");
    expect(out).toContain(sha);
    expect(out).toMatch(/\nmain\n/);
    expect(out).toContain(`commit=${sha}`);
    expect(out).toMatch(/\n1$/);
    expect(api.logText(3)).toMatch(/2\nsecond/);
    expect(existsSync(path.join(workspace(), ".git"))).toBe(true);
    rmSync(origin, { recursive: true, force: true });
  });

  it("checks out with LFS, submodules and sparse-checkout", async () => {
    const root = tmp("checkout-features-");
    const gitIn = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
    const sub = path.join(root, "sub");
    const origin = path.join(root, "origin");
    mkdirSync(sub);
    gitIn(sub, "init", "-q", "-b", "main");
    writeFileSync(path.join(sub, "lib.txt"), "from submodule\n");
    gitIn(sub, "add", ".");
    gitIn(sub, "commit", "-q", "-m", "sub");
    mkdirSync(path.join(origin, "a"), { recursive: true });
    mkdirSync(path.join(origin, "b"));
    gitIn(origin, "init", "-q", "-b", "main");
    gitIn(origin, "lfs", "install", "--local");
    gitIn(origin, "lfs", "track", "*.bin");
    writeFileSync(path.join(origin, "a/x.txt"), "x\n");
    writeFileSync(path.join(origin, "b/y.txt"), "y\n");
    writeFileSync(path.join(origin, "top.txt"), "top\n");
    writeFileSync(path.join(origin, "big.bin"), "real lfs content\n");
    gitIn(origin, "submodule", "add", "-q", `file://${sub}`, "vendor/sub");
    gitIn(origin, "add", ".");
    gitIn(origin, "commit", "-q", "-m", "init");
    const sha = gitIn(origin, "rev-parse", "HEAD");
    const spec = makeSpec(
      api,
      [
        { uses: "actions/checkout@v4", with: { path: "full", lfs: "true", submodules: "recursive", "persist-credentials": "false" } },
        { run: "cat full/big.bin full/vendor/sub/lib.txt full/b/y.txt" },
        { uses: "actions/checkout@v4", with: { path: "plain" } },
        { run: "head -n 1 plain/big.bin; ls plain/vendor/sub | wc -l" },
        { uses: "actions/checkout@v4", with: { path: "sparse", "sparse-checkout": "a" } },
        { run: "ls sparse; ls sparse/a" },
        { uses: "actions/checkout@v4", with: { path: "nocone", "sparse-checkout": "b/y.txt", "sparse-checkout-cone-mode": "false" } },
        { run: "find nocone -type f -not -path '*/.git/*' | sort" },
      ],
      {
        sha,
        repo: { owner: "acme", name: "widgets", cloneUrl: `file://${origin}`, defaultBranch: "main" },
        env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always" },
      },
    );
    try {
      const c = await run(spec);
      expect(c.conclusion, api.logText()).toBe("success");
      expect(api.logText(1)).toContain("real lfs content\nfrom submodule\ny");
      expect(api.logText(3)).toContain("version https://git-lfs.github.com/spec/v1");
      expect(api.logText(3)).toMatch(/\n0$/);
      expect(api.logText(5)).toMatch(/\na\nbig\.bin\ntop\.txt\nx\.txt$/); // cone mode keeps root files, drops b/ and vendor/
      expect(api.logText(7)).toMatch(/\nnocone\/b\/y\.txt$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the job token out of .git/config unless persist-credentials, even when checkout fails", async () => {
    const root = tmp("http-git-");
    const origin = path.join(root, "acme/widgets.git");
    mkdirSync(origin, { recursive: true });
    const seed = path.join(root, "seed");
    const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
    g(origin, "init", "-q", "--bare", "-b", "main");
    mkdirSync(seed);
    g(seed, "init", "-q", "-b", "main");
    writeFileSync(path.join(seed, "README.md"), "hello\n");
    g(seed, "add", ".");
    g(seed, "commit", "-q", "-m", "first");
    g(seed, "push", "-q", origin, "main");
    const sha = g(seed, "rev-parse", "HEAD");
    // git's smart HTTP through `git http-backend`, recording the credentials it is sent
    const auths: string[] = [];
    const server = createServer((req, res) => {
      auths.push(req.headers.authorization ?? "");
      const u = new URL(req.url ?? "/", "http://x");
      const cgi = spawn("git", ["http-backend"], {
        env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method ?? "GET", CONTENT_TYPE: req.headers["content-type"] ?? "", HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] ?? "") },
      });
      req.pipe(cgi.stdin);
      let buf = Buffer.alloc(0);
      cgi.stdout.on("data", (d: Buffer) => (buf = Buffer.concat([buf, d])));
      cgi.on("close", () => {
        const sep = buf.indexOf("\r\n\r\n");
        const head = buf.subarray(0, sep).toString();
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head.split("\r\n")) {
          const [k, ...v] = line.split(":");
          if (k!.toLowerCase() === "status") status = Number(v.join(":").trim().split(" ")[0]);
          else headers[k!] = v.join(":").trim();
        }
        res.writeHead(status, headers);
        res.end(buf.subarray(sep + 4));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const headers = "git config --get-regexp 'http\\..*\\.extraheader' | wc -l";
      const spec = makeSpec(
        api,
        [
          { uses: "actions/checkout@v4", with: { path: "a", "persist-credentials": "false" } },
          { run: `echo "a=$(cd a && ${headers})"; cat a/README.md` },
          { uses: "actions/checkout@v4", with: { path: "b" } },
          { run: `echo "b=$(cd b && ${headers})"` },
          { uses: "actions/checkout@v4", "continue-on-error": true, with: { path: "c", ref: "no-such-branch" } },
          { run: `echo "c=$(cd c && ${headers})"` },
        ],
        { sha, repo: { owner: "acme", name: "widgets", cloneUrl: `${url}/acme/widgets.git`, defaultBranch: "main" } },
      );
      const c = await run(spec);
      expect(c.conclusion, api.logText()).toBe("success");
      // the token reached the server while fetching...
      expect(auths.filter((a) => a.toLowerCase().startsWith("basic ")).length).toBeGreaterThan(0);
      expect(api.logText(1)).toContain("hello");
      // ...but stays in .git/config only when persisted, and not after a failed checkout
      expect(api.logText(1)).toContain("a=0");
      expect(api.logText(3)).toContain("b=1");
      expect(api.logText(4)).toContain("Failed to fetch ref 'no-such-branch'");
      expect(api.logText(5)).toContain("c=0");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives the runtime services' variables to actions, not to run steps, and never the runner's own token", async () => {
    const c = await runAgentJob(makeSpec(api, [{ run: 'echo "rt=${ACTIONS_RUNTIME_TOKEN:-unset} results=${ACTIONS_RESULTS_URL:-unset} gh=${DIFFINERY_GITHUB_TOKEN:-unset} job=${DIFFINERY_JOB_TOKEN:-unset}"' }]), {
      apiBase: apiBaseFor(api.url, "job-1"),
      workRoot,
      toolCache: path.join(workRoot, "_tool"),
      logIntervalMs: 50,
      echoLogs: false,
      baseEnv: { ...process.env, DIFFINERY_GITHUB_TOKEN: "ghp_operator", DIFFINERY_JOB_TOKEN: "djt_x" },
    });
    expect(c.conclusion, api.logText()).toBe("success");
    expect(api.logText(0)).toContain("rt=unset results=unset gh=unset job=unset");
  });

  it("sets OIDC request variables when id-token is granted", async () => {
    const c = await run(
      makeSpec(api, [{ run: 'curl -s -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts" ; echo' }], { idToken: true }),
    );
    expect(c.conclusion).toBe("success");
    expect(api.logText(0)).toContain('{"value":"oidc-for-sts"}');
  });

  it("evaluates job-level env and spec-level defaults.run", async () => {
    mkdirSync(path.join(workspace(), "pkg"), { recursive: true });
    const c = await run(
      makeSpec(api, [{ run: 'echo "wd=$(basename "$(pwd)") shell=$0 e=$E"' }], {
        defaults: { run: { shell: "sh -e {0}", "working-directory": "pkg" } },
        env: { E: "${{ vars.V }}-${{ inputs.i }}-${{ needs.prev.outputs.o }}" },
        vars: { V: "var" },
        inputs: { i: "inp" },
        needs: { prev: { result: "success", outputs: { o: "out" } } },
      }),
    );
    expect(c.conclusion).toBe("success");
    expect(api.logText(0)).toMatch(/wd=pkg shell=\S+\.sh e=var-inp-out/);
  });

  it("lets workflow env override CI and DIFFINERY but not GITHUB_* or RUNNER_*", async () => {
    const c = await run(
      makeSpec(api, [{ env: { CI: "step" }, run: 'echo "d=$DIFFINERY ci=$CI sha=$GITHUB_SHA os=$RUNNER_OS"' }], {
        env: { DIFFINERY: "https://diffinery.example", GITHUB_SHA: "nope", RUNNER_OS: "nope" },
      }),
    );
    expect(c.conclusion).toBe("success");
    expect(api.logText(0)).toMatch(/d=https:\/\/diffinery\.example ci=step sha=[0-9a-f]{40} os=Linux/);
  });
});

describe("agent binary (esbuild bundle)", () => {
  it("runs a --spec job and an env-driven job", async () => {
    const { build } = await import("esbuild");
    const out = path.join(workRoot, "agent.mjs");
    await build({
      entryPoints: [path.join(__dirname, "../src/main.ts")],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      outfile: out,
      logLevel: "silent",
      // keep in sync with the `build` script in package.json
      banner: { js: "import { createRequire as __diffineryCreateRequire } from 'node:module'; const require = __diffineryCreateRequire(import.meta.url);" },
    });
    const spec = makeSpec(api, [{ run: 'echo "from bundle $GITHUB_JOB"' }], { outputs: { x: "y" } });
    const specFile = path.join(workRoot, "spec.json");
    writeFileSync(specFile, JSON.stringify(spec));
    const env: NodeJS.ProcessEnv = { ...process.env, DIFFINERY_WORK_ROOT: path.join(workRoot, "w1") };
    delete env.DIFFINERY_API_URL;
    const r = await spawnAsync(process.execPath, [out, "--spec", specFile], env);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(api.completion).toMatchObject({ conclusion: "success", outputs: { x: "y" } });
    expect(api.logText(0)).toContain("from bundle build");

    // env mode: fetch the spec from the API, saying where the runner runs (its image and container)
    api.completion = null;
    api.specs.set("job-2", { ...spec, jobId: "job-2", steps: [{ run: "exit 4" }] });
    writeFileSync(path.join(workRoot, "image-tag"), "diffinery-runner:abc123\n");
    const r2 = await spawnAsync(process.execPath, [out], {
      ...process.env,
      CLOUDFLARE_LOCATION: "fra06",
      CLOUDFLARE_REGION: "EEUR",
      CLOUDFLARE_DURABLE_OBJECT_ID: "d0",
      DIFFINERY_WORK_ROOT: path.join(workRoot, "w2"),
      DIFFINERY_API_URL: api.url,
      DIFFINERY_JOB_ID: "job-2",
      DIFFINERY_JOB_TOKEN: api.token,
    });
    expect(r2.status).toBe(1);
    const runner = JSON.parse(api.requests.find((q) => q.path === "/runner/jobs/job-2")?.runner ?? "{}");
    expect(runner).toMatchObject({ image: "diffinery-runner:abc123", location: "fra06, EEUR", instance: "d0" });
    expect(api.logText()).toContain("Runner: image diffinery-runner:abc123, in fra06, EEUR, container d0");
    // A hosted runner also names its host's processor and, at the end, the share of its vCPUs' time the host took.
    if (existsSync("/proc/cpuinfo")) {
      expect(api.logText()).toContain(`Host: ${runner.cpu}`);
      expect(api.logText()).toMatch(/Host: \d+% of the vCPUs' time went to other work on the host \(steal\)/);
    }
    expect(api.completion).toMatchObject({ conclusion: "failure", failure: { step: 0 } });
    expect(readFileSync(path.join(workRoot, "w2/_temp/_github_workflow/event.json"), "utf8")).toContain("pusher");

    const startJob = (id: string, steps: StepSpec[]) => {
      api.completion = null;
      api.steps = [];
      api.logs = [];
      api.specs.set(id, { ...spec, jobId: id, steps });
      const child = spawn(process.execPath, [out], {
        env: { ...process.env, DIFFINERY_WORK_ROOT: path.join(workRoot, id), DIFFINERY_API_URL: api.url, DIFFINERY_JOB_ID: id, DIFFINERY_JOB_TOKEN: api.token },
      });
      const exited = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
      return { child, exited };
    };
    const waitForLog = async (text: string) => {
      const t0 = Date.now();
      while (!api.logs.some((l) => l.text === text) && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 50));
    };

    // One SIGTERM (a container rollout): the job keeps running and finishes.
    const drain = startJob("job-3", [{ run: "echo started; sleep 2" }, { run: "echo after" }]);
    await waitForLog("started");
    drain.child.kill("SIGTERM");
    expect(await drain.exited).toBe(0);
    expect(api.completion).toMatchObject({ conclusion: "success" });
    expect(api.completion).not.toHaveProperty("replaced");
    expect(api.logText()).toContain("The platform is stopping this runner");
    expect(api.logText(1)).toContain("after");

    // A second SIGTERM: kill the running step's process group and report cancelled.
    const t0 = Date.now();
    const stop = startJob("job-4", [{ run: "echo started; sleep 60" }, { run: "echo never" }]);
    await waitForLog("started");
    stop.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    stop.child.kill("SIGTERM");
    expect(await stop.exited).toBe(1);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(api.completion).toMatchObject({ conclusion: "cancelled", replaced: true });
    expect(api.lastReport(0)?.conclusion).toBe("cancelled");
    expect(api.lastReport(1)?.conclusion).toBe("cancelled");

    // SIGINT (Diffinery cancelling the job): cancel at once, with no drain.
    const t1 = Date.now();
    const cancel = startJob("job-5", [{ run: "echo started; sleep 60" }]);
    await waitForLog("started");
    cancel.child.kill("SIGINT");
    expect(await cancel.exited).toBe(1);
    expect(Date.now() - t1).toBeLessThan(15_000);
    expect(api.completion).toMatchObject({ conclusion: "cancelled" });
    expect(api.completion).not.toHaveProperty("replaced");
    expect(api.logText()).not.toContain("being replaced");

    // A rollout's SIGTERM reaches every process in the container, steps included: the
    // step fails with a message that names the rollout, the rest of the job is cancelled
    // without waiting out the drain, and the result says the runner was replaced, so
    // Diffinery can start the job again on a new runner.
    const t2 = Date.now();
    const rollout = startJob("job-6", [{ run: "echo started $$; sleep 60" }, { run: "echo never" }]);
    while (!/started \d+/.test(api.logText()) && Date.now() - t2 < 15_000) await new Promise((r) => setTimeout(r, 50));
    const pid = Number(/started (\d+)/.exec(api.logText())?.[1]);
    rollout.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    process.kill(-pid, "SIGTERM");
    expect(await rollout.exited).toBe(1);
    expect(Date.now() - t2).toBeLessThan(15_000);
    expect(api.completion).toMatchObject({ conclusion: "cancelled", replaced: true });
    expect(api.lastReport(0)?.conclusion).toBe("cancelled");
    expect(api.lastReport(1)?.conclusion).toBe("cancelled");
    expect(api.logText()).toContain("The platform stopped this step's processes while stopping the runner");
  }, 60_000);
});
