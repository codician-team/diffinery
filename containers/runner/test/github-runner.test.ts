import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGitHubRunner } from "../src/github-runner.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A stand-in for GitHub's run.sh that records its arguments and environment, then exits with `code`. */
async function fakeRunner(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gh-runner-"));
  dirs.push(dir);
  await writeFile(join(dir, "run.sh"), `#!/bin/sh\n${script}\n`);
  await chmod(join(dir, "run.sh"), 0o755);
  return dir;
}

describe.skipIf(process.platform === "win32")("GitHub's runner", () => {
  it("runs with the just-in-time configuration, as root, without the configuration in the job's environment", async () => {
    const dir = await fakeRunner('echo "$1 $2" > args; env > env; exit 3');
    const code = await runGitHubRunner({ jitConfig: "abc==", runnerDir: dir, env: { PATH: process.env.PATH, DIFFINERY_GITHUB_JIT_CONFIG: "abc==", KEEP: "1" } });
    expect(code).toBe(3);
    expect((await readFile(join(dir, "args"), "utf8")).trim()).toBe("--jitconfig abc==");
    const env = await readFile(join(dir, "env"), "utf8");
    expect(env).toContain("RUNNER_ALLOW_RUNASROOT=1");
    expect(env).toContain("KEEP=1");
    expect(env).not.toContain("DIFFINERY_GITHUB_JIT_CONFIG");
  });

  it("passes SIGINT on at once and holds SIGTERM back while the job may finish", async () => {
    const dir = await fakeRunner('trap "echo int > got; exit 130" INT; trap "echo term > got; exit 143" TERM; touch ready; while true; do sleep 0.05; done');
    const running = runGitHubRunner({ jitConfig: "x", runnerDir: dir, env: { PATH: process.env.PATH }, drainOnSigtermMs: 60_000 });
    // Its traps are set once it says it is ready.
    while (!(await readFile(join(dir, "ready")).then(() => true, () => false))) await new Promise((r) => setTimeout(r, 20));
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    await expect(readFile(join(dir, "got"), "utf8")).rejects.toThrow();
    process.emit("SIGINT");
    expect(await running).toBe(130);
    expect((await readFile(join(dir, "got"), "utf8")).trim()).toBe("int");
  });

  it("reports a runner that isn't there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gh-runner-"));
    dirs.push(dir);
    expect(await runGitHubRunner({ jitConfig: "x", runnerDir: dir, env: { PATH: process.env.PATH } })).toBe(2);
  });
});
