import { spawn } from "node:child_process";

/** Where the image puts GitHub's runner (Dockerfile). */
export const ACTIONS_RUNNER_DIR = "/opt/actions-runner";

/**
 * How long a platform rollout's SIGTERM waits before it reaches the job, as for Diffinery's own jobs
 * (main.ts drainOnSigtermMs): Cloudflare gives a container 15 minutes after SIGTERM.
 */
export const DRAIN_ON_SIGTERM_MS = 13 * 60_000;

export interface GitHubRunnerOptions {
  /** The just-in-time configuration GitHub made for this runner: its credentials. Never logged. */
  jitConfig: string;
  runnerDir?: string;
  env?: NodeJS.ProcessEnv;
  drainOnSigtermMs?: number;
}

/**
 * A GitHub job on a Diffinery runner (apps/diffinery/src/github-runners/): runs GitHub's own runner with
 * its just-in-time configuration. GitHub hands it one queued job, it runs the job and exits, and the
 * container stops. Returns the runner's exit code.
 *
 * Jobs run as root, as Diffinery's own hosted jobs do (the image's tools and caches are root's). SIGINT
 * (Diffinery stopping the runner) reaches the runner at once, which cancels the job; SIGTERM (a platform
 * rollout) waits up to drainOnSigtermMs for the job to finish first.
 */
export function runGitHubRunner(o: GitHubRunnerOptions): Promise<number> {
  const dir = o.runnerDir ?? ACTIONS_RUNNER_DIR;
  const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env), RUNNER_ALLOW_RUNASROOT: "1" };
  // The job's steps inherit the runner's environment: the configuration stays out of it.
  delete env.DIFFINERY_GITHUB_JIT_CONFIG;
  const child = spawn(`${dir}/run.sh`, ["--jitconfig", o.jitConfig], { cwd: dir, env, stdio: ["ignore", "inherit", "inherit"] });
  let draining: NodeJS.Timeout | null = null;
  const forward = (sig: NodeJS.Signals) => {
    if (child.exitCode === null) child.kill(sig);
  };
  const onInt = () => forward("SIGINT");
  const onTerm = () => {
    if (draining) return forward("SIGTERM");
    process.stderr.write(`[diffinery-runner] the platform is stopping this runner; the job keeps running for up to ${Math.round((o.drainOnSigtermMs ?? DRAIN_ON_SIGTERM_MS) / 60_000)} minutes\n`);
    draining = setTimeout(() => forward("SIGTERM"), o.drainOnSigtermMs ?? DRAIN_ON_SIGTERM_MS);
    draining.unref();
  };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return new Promise((resolve) => {
    const done = (code: number) => {
      if (draining) clearTimeout(draining);
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(code);
    };
    child.on("error", (e) => {
      process.stderr.write(`[diffinery-runner] could not start GitHub's runner: ${e.message}\n`);
      done(2);
    });
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}
