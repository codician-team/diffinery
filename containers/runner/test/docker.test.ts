import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobSpec } from "@diffinery/shared";
import { apiBaseFor, runAgentJob } from "../src/agent.js";
import { makeSpec, startFakeApi, tmp, type FakeApi } from "./helpers.js";

/** Job containers, service containers and Docker actions; skipped where Docker isn't available. */
function dockerWorks(): boolean {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

// Docker Hub rate-limits anonymous pulls; its official images are mirrored here.
const ALPINE = "mirror.gcr.io/library/alpine:3.20";
const DEBIAN = "mirror.gcr.io/library/debian:bookworm-slim";
const REDIS = "mirror.gcr.io/library/redis:7-alpine";

let api: FakeApi;
let workRoot: string;

beforeEach(async () => {
  api = await startFakeApi();
  workRoot = tmp();
});
afterEach(async () => {
  await api.close();
  // Containers may leave root-owned files behind; clean up through Docker.
  if (dockerWorks()) execFileSync("docker", ["run", "--rm", "-v", `${workRoot}:/w`, ALPINE, "sh", "-c", "rm -rf /w/* /w/.[!.]*"], { stdio: "ignore" });
  rmSync(workRoot, { recursive: true, force: true });
});

function run(spec: JobSpec, baseEnv?: NodeJS.ProcessEnv) {
  return runAgentJob(spec, { apiBase: apiBaseFor(spec.apiUrl, spec.jobId), workRoot, toolCache: path.join(workRoot, "_tool"), logIntervalMs: 50, echoLogs: false, baseEnv });
}

const leftovers = (jobId: string) =>
  execFileSync("docker", ["ps", "-aq", "--filter", `label=diffinery.job=${jobId}`], { encoding: "utf8" }).trim() +
  execFileSync("docker", ["network", "ls", "-q", "--filter", `label=diffinery.job=${jobId}`], { encoding: "utf8" }).trim();

const redisService = { image: REDIS, ports: [6379], options: "--health-cmd 'redis-cli ping' --health-interval 1s --health-timeout 2s --health-retries 20" };

describe.skipIf(!dockerWorks())("docker", () => {
  it("runs steps and JavaScript actions in a job container next to a service container", async () => {
    const action = `name: probe
outputs:
  version: { description: node }
runs:
  using: node20
  main: index.js
`;
    const js = `const fs = require("fs");
const os = fs.readFileSync("/etc/os-release", "utf8").includes("bookworm");
fs.appendFileSync(process.env.GITHUB_OUTPUT, "version=" + process.version + "\\n");
console.log("node action in debian=" + os + " input=" + process.env.INPUT_WHO);
`;
    const spec = makeSpec(
      api,
      [
        {
          run: [
            'grep -q bookworm /etc/os-release && echo "in debian, home=$HOME, ws=$GITHUB_WORKSPACE, greeting=$GREETING"',
            "exec 3<>/dev/tcp/redis/6379",
            "printf 'PING\\r\\n' >&3",
            "read -r line <&3",
            'echo "redis says ${line%$\'\\r\'}"',
            'echo "FROM_STEP=yes" >> "$GITHUB_ENV"',
            "mkdir -p .github/probe",
            `cat > .github/probe/action.yml <<'EOF'\n${action}EOF`,
            `cat > .github/probe/index.js <<'EOF'\n${js}EOF`,
          ].join("\n"),
        },
        { id: "probe", uses: "./.github/probe", with: { who: "octo" } },
        { run: 'echo "env=$FROM_STEP node=${{ steps.probe.outputs.version }} container=${{ job.container.id != \'\' }} port=${{ job.services.redis.ports[\'6379\'] != \'\' }}"' },
      ],
      { jobId: "dkr-container", container: { image: DEBIAN, env: { GREETING: "hi" } }, services: { redis: redisService } },
    );
    const c = await run(spec);
    const log = api.logText();
    expect(c.conclusion, log).toBe("success");
    expect(log).toContain(`in debian, home=/github/home, ws=${path.join(workRoot, "widgets")}, greeting=hi`);
    expect(log).toContain("redis says +PONG");
    expect(log).toContain("node action in debian=true input=octo");
    expect(log).toMatch(/env=yes node=v\d+\.\d+\.\d+ container=true port=true/);
    expect(leftovers("dkr-container")).toBe("");
  }, 180_000);

  it("runs docker:// steps and Dockerfile actions with inputs, outputs, args and post entrypoints", async () => {
    // Written up front: a `run:` script would expand the action's own ${{ inputs.who }}.
    const dir = path.join(workRoot, "widgets", ".github", "hello");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "action.yml"),
      `name: hello
inputs:
  who: { description: who, default: world }
runs:
  using: docker
  image: Dockerfile
  args: ["\${{ inputs.who }}", "two words"]
  post-entrypoint: /post.sh
`,
    );
    writeFileSync(path.join(dir, "Dockerfile"), `FROM ${ALPINE}\nCOPY entrypoint.sh post.sh /\nRUN chmod +x /entrypoint.sh /post.sh\nENTRYPOINT ["/entrypoint.sh"]\n`);
    writeFileSync(
      path.join(dir, "entrypoint.sh"),
      '#!/bin/sh\necho "hello $1 [$2] input=$INPUT_WHO ws=$GITHUB_WORKSPACE pwd=$(pwd)"\necho "said=hello-$1" >> "$GITHUB_OUTPUT"\necho "FROM_DOCKER=1" >> "$GITHUB_ENV"\nprintf "PING\\r\\n" | nc -w 2 redis 6379\n',
    );
    writeFileSync(path.join(dir, "post.sh"), '#!/bin/sh\necho "post ran"\n');
    const spec = makeSpec(
      api,
      [
        { id: "hello", uses: "./.github/hello", with: { who: "octo" } },
        { id: "raw", uses: `docker://${ALPINE}`, with: { args: "sh -c 'echo raw $INPUT_COLOR > /github/workspace/raw.txt; echo color=$INPUT_COLOR >> $GITHUB_OUTPUT'", color: "blue" } },
        { uses: `docker://${ALPINE}`, with: { entrypoint: "/bin/false" }, "continue-on-error": true },
        { run: 'echo "said=${{ steps.hello.outputs.said }} color=${{ steps.raw.outputs.color }} env=$FROM_DOCKER file=$(cat raw.txt)"' },
      ],
      { jobId: "dkr-actions", services: { redis: redisService } },
    );
    const c = await run(spec);
    const log = api.logText();
    expect(c.conclusion, log).toBe("success");
    expect(log).toContain("hello octo [two words] input=octo ws=/github/workspace pwd=/github/workspace");
    expect(log).toContain("+PONG");
    expect(log).toContain("Docker run failed with exit code 1");
    expect(log).toContain("said=hello-octo color=blue env=1 file=raw blue");
    expect(log).toContain("post ran");
    expect(readFileSync(path.join(workRoot, "widgets", "raw.txt"), "utf8")).toBe("raw blue\n");
    expect(leftovers("dkr-actions")).toBe("");
  }, 180_000);

  it("fails a service that never gets healthy, and cleans up", async () => {
    const spec = makeSpec(api, [{ run: "echo never" }], {
      jobId: "dkr-unhealthy",
      services: { bad: { image: REDIS, options: "--health-cmd false --health-interval 1s --health-retries 2" } },
    });
    const c = await run(spec);
    expect(c.conclusion).toBe("failure");
    expect(c.failure?.message).toContain("Service container bad failed its health check");
    expect(api.logText()).not.toContain("never");
    expect(leftovers("dkr-unhealthy")).toBe("");
  }, 120_000);
});

describe("docker missing", () => {
  it("explains that containers need Docker", async () => {
    const spec = makeSpec(api, [{ run: "echo hi" }], { jobId: "no-docker", services: { redis: { image: REDIS } } });
    const c = await run(spec, { PATH: path.join(workRoot, "empty-bin") });
    expect(c.conclusion).toBe("failure");
    expect(c.failure?.message).toContain("Service containers (jobs.<id>.services) need Docker");
    const c2 = await run(makeSpec(api, [{ uses: `docker://${ALPINE}` }], { jobId: "no-docker-2" }), { PATH: path.join(workRoot, "empty-bin") });
    expect(c2.failure?.message).toContain("Docker container actions need Docker, and this runner has no docker CLI");
  });
});
