import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Api, ApiError } from "../api.js";
import { configDir } from "../config.js";
import { list, parseRepoArg, repoPath, str, type Command, type Ctx, type RepoRef } from "../cli.js";
import { CliError, type Io } from "../io.js";

export interface ClaimedJob {
  job_id: string;
  run_id: string;
  name: string;
  token: string;
  api_url: string;
}

const AGENT_HELP = `The runner needs the Diffinery runner agent (a single Node.js file). Build it from the
Diffinery repository with:

  pnpm --filter @diffinery/runner build      # produces containers/runner/dist/agent.mjs

then pass --agent /path/to/agent.mjs or set DIFFINERY_RUNNER_AGENT.`;

export function resolveAgentPath(io: Io, flag: string | undefined): string {
  const p = flag ?? io.env.DIFFINERY_RUNNER_AGENT;
  if (!p) throw new CliError(`no runner agent given.\n\n${AGENT_HELP}`);
  const abs = path.resolve(io.cwd, p);
  if (!existsSync(abs)) throw new CliError(`runner agent not found at ${abs}.\n\n${AGENT_HELP}`);
  return abs;
}

/** POST .../actions/runners/claim: a job, or null when nothing is waiting (204). A registered runner sends an empty body. */
export async function claim(api: Api, repo: RepoRef, body: { name?: string; labels?: string[] }): Promise<ClaimedJob | null> {
  const res = await api.raw<ClaimedJob | null>("POST", `${repoPath(repo)}/actions/runners/claim`, { body });
  if (res.status === 204 || !res.data || typeof res.data !== "object") return null;
  return res.data;
}

/** A registered runner's own credentials: the token claims this repository's jobs and nothing else. */
export interface RunnerCredentials {
  url: string;
  owner: string;
  repo: string;
  id: number;
  name: string;
  labels: string[];
  token: string;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

/** Where a registered runner's credentials are kept (mode 0600). */
export function runnerFile(env: NodeJS.ProcessEnv, url: string, repo: RepoRef, name: string): string {
  return path.join(configDir(env), "runners", safe(new URL(url).host), safe(repo.owner), safe(repo.name), `${safe(name)}.json`);
}

async function readRunner(file: string): Promise<RunnerCredentials | null> {
  try {
    const v = JSON.parse(await readFile(file, "utf8")) as RunnerCredentials;
    return typeof v.token === "string" && v.token.startsWith("drn_") ? v : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError(`${file} is not a valid runner registration; delete it and register again`);
  }
}

async function saveRunner(file: string, creds: RunnerCredentials): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  await chmod(file, 0o600);
}

/** POST .../actions/runners/register: trade a registration token for the runner's own token. */
export async function register(url: string, repo: RepoRef, registrationToken: string, name: string, labels: string[], ephemeral: boolean): Promise<RunnerCredentials> {
  const res = await new Api(url, null).raw<{ id: number; name: string; labels: string[]; token: string }>("POST", `${repoPath(repo)}/actions/runners/register`, {
    body: { registration_token: registrationToken, name, labels, ephemeral },
  });
  return { url, owner: repo.owner, repo: repo.name, id: res.data.id, name: res.data.name, labels: res.data.labels, token: res.data.token };
}

/** How the runner claims from one repository: with its own registered token, or (older servers) the signed-in person's. */
interface Source {
  repo: RepoRef;
  api: Api;
  body: { name?: string; labels?: string[] };
  /** The saved registration, when the token came from one. */
  file?: string;
}

/** Environment for the agent: the job's credentials, minus the CLI's own token. */
export function agentEnv(base: NodeJS.ProcessEnv, job: ClaimedJob, workRoot: string, echo: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of ["DIFFINERY_TOKEN", "DIFFINERY_URL", "DIFFINERY_RUNNER_AGENT", "GH_TOKEN", "GITHUB_TOKEN"]) delete env[k];
  env.DIFFINERY_API_URL = job.api_url;
  env.DIFFINERY_JOB_ID = job.job_id;
  env.DIFFINERY_JOB_TOKEN = job.token;
  env.DIFFINERY_WORK_ROOT ??= workRoot;
  if (echo) env.DIFFINERY_ECHO_LOGS = "1";
  return env;
}

function pipeLines(stream: NodeJS.ReadableStream, prefix: string, write: (s: string) => void): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (l) => write(`${prefix}${l}\n`));
    rl.on("close", () => resolve());
  });
}

async function runJob(ctx: Ctx, agent: string, job: ClaimedJob, repo: RepoRef, workRoot: string, echo: boolean, onChild: (c: ChildProcess | null) => void): Promise<number> {
  const c = ctx.c;
  const prefix = c.dim(`[${job.name}] `);
  ctx.out(`${c.cyan("→")} ${repo.owner}/${repo.name}: running job ${c.bold(job.name)} ${c.dim(`(run ${job.run_id}, job ${job.job_id})`)}`);
  await mkdir(workRoot, { recursive: true });
  const child = spawn(process.execPath, [agent], { cwd: workRoot, env: agentEnv(ctx.io.env, job, workRoot, echo), stdio: ["ignore", "pipe", "pipe"] });
  onChild(child);
  const done = Promise.all([pipeLines(child.stdout!, prefix, (s) => ctx.io.stdout.write(s)), pipeLines(child.stderr!, prefix, (s) => ctx.io.stderr.write(s))]);
  const code = await new Promise<number>((resolve) => {
    child.on("error", (e) => {
      ctx.err(`${c.red("error:")} could not start the agent: ${e.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 + (signal === "SIGKILL" ? 9 : 15) : 1)));
  });
  await done;
  onChild(null);
  ctx.out(`${code === 0 ? c.green("✓") : c.red("X")} job ${job.name} finished${code === 0 ? "" : ` with exit code ${code}`}`);
  return code;
}

export const runnerCommand: Command = {
  name: "runner",
  summary: "Run self-hosted workflow jobs on this machine",
  description: `Polls the given repositories for jobs with 'runs-on: [self-hosted, ...]' whose labels this
runner offers, and runs each with the Diffinery runner agent. Jobs run directly on this machine
with your user's permissions.

The runner registers with each repository and claims jobs with its own token, which can't do
anything else. Register it with a registration token from a repository admin
(POST /repos/OWNER/NAME/actions/runners/registration-token, valid for an hour):

  diffinery runner -R OWNER/NAME --registration-token drg_... --labels linux

so the machine never holds a personal token, which the jobs it runs could read. The runner's
credentials are saved under ~/.config/diffinery/runners and used on the next start. Signed in
as a repository admin instead, the runner registers itself with your token.

--ephemeral registers a runner for one job: its token stops working once it takes the job, and
the runner exits when the job finishes.

${AGENT_HELP}`,
  options: {
    repo: { type: "string", short: "R", multiple: true, desc: "Repository to take jobs from (default: the git origin)", arg: "OWNER/NAME" },
    labels: { type: "string", short: "l", desc: "Extra labels this runner offers, comma separated ('self-hosted' is implied)", arg: "a,b" },
    name: { type: "string", short: "n", desc: "Runner name (default: host name)", arg: "NAME" },
    once: { type: "boolean", desc: "Run at most one job, then exit with its exit code" },
    agent: { type: "string", short: "a", desc: "Path to the runner agent (agent.mjs); default DIFFINERY_RUNNER_AGENT", arg: "PATH" },
    "work-dir": { type: "string", short: "w", desc: "Working directory for jobs (default ~/.cache/diffinery/runner/<name>)", arg: "DIR" },
    interval: { type: "string", desc: "Seconds between polls when idle (default 5)", arg: "SECONDS" },
    quiet: { type: "boolean", short: "q", desc: "Do not echo step output locally (logs still go to the server)" },
    "registration-token": { type: "string", desc: "Register this runner with a repository admin's registration token (one repository)", arg: "TOKEN" },
    ephemeral: { type: "boolean", desc: "Register for a single job, then exit when it finishes" },
  },
  maxArgs: 0,
  async run(ctx, o) {
    const agent = resolveAgentPath(ctx.io, str(o, "agent"));
    const repos = list(o, "repo").length ? list(o, "repo").map(parseRepoArg) : [await ctx.repo()];
    const labels = (str(o, "labels") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const name = str(o, "name") ?? hostname();
    const intervalMs = Math.max(0, Number(str(o, "interval") ?? 5)) * 1000;
    if (!Number.isFinite(intervalMs)) throw new CliError("--interval must be a number", 2);
    const cacheHome = ctx.io.env.XDG_CACHE_HOME && path.isAbsolute(ctx.io.env.XDG_CACHE_HOME) ? ctx.io.env.XDG_CACHE_HOME : path.join(ctx.io.env.HOME || homedir(), ".cache");
    const workRoot = path.resolve(ctx.io.cwd, str(o, "work-dir") ?? path.join(cacheHome, "diffinery", "runner", name.replace(/[^A-Za-z0-9._-]/g, "_")));
    const c = ctx.c;
    const ephemeral = o.ephemeral === true;
    const registration = str(o, "registration-token") ?? ctx.io.env.DIFFINERY_RUNNER_REGISTRATION_TOKEN;
    if (registration && repos.length > 1) throw new CliError("a registration token is for one repository: pass a single -R OWNER/NAME", 2);
    const url = (await ctx.config()).url;
    const sources: Source[] = [];
    for (const repo of repos) {
      const file = runnerFile(ctx.io.env, url, repo, name);
      const saved = ephemeral ? null : await readRunner(file);
      let creds: RunnerCredentials | null = null;
      if (registration) creds = await register(url, repo, registration, name, labels, ephemeral);
      else if (saved) {
        creds = saved;
        if (labels.length && labels.join(",") !== saved.labels.join(",")) ctx.err(`${c.yellow("warning:")} ${name} was registered with ${repo.owner}/${repo.name} offering [${saved.labels.join(", ")}]; to change its labels, delete ${file} and register it again`);
      } else {
        // Signed in: register with the person's token, so jobs are claimed with the runner's own.
        const user = await ctx.authedApi();
        const t = await user.raw<{ token: string }>("POST", `${repoPath(repo)}/actions/runners/registration-token`, { allow: [404, 405] });
        if (t.status === 201 && t.data?.token) creds = await register(url, repo, t.data.token, name, labels, ephemeral);
        else sources.push({ repo, api: user, body: { name, labels } }); // an older server without registration
      }
      if (!creds) continue;
      if (!saved && !ephemeral) {
        await saveRunner(file, creds);
        ctx.out(`Registered runner ${c.bold(creds.name)} with ${repo.owner}/${repo.name} ${c.dim(`(saved to ${file})`)}`);
      }
      sources.push({ repo, api: new Api(url, creds.token), body: {}, file: ephemeral ? undefined : file });
    }

    let stopping = false;
    let child: ChildProcess | null = null;
    const abort = new AbortController();
    let signals = 0;
    const onSignal = () => {
      signals++;
      stopping = true;
      abort.abort();
      if (child && child.exitCode === null) {
        if (signals === 1) {
          ctx.err(c.yellow("Stopping: asking the running job to cancel (press Ctrl-C again to kill it)…"));
          child.kill("SIGTERM");
        } else child.kill("SIGKILL");
      }
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    try {
      ctx.out(`Runner ${c.bold(name)} offering [${["self-hosted", ...labels].join(", ")}] for ${repos.map((r) => `${r.owner}/${r.name}`).join(", ")}`);
      if (!o.once) ctx.out(c.dim("Waiting for jobs. Press Ctrl-C to stop."));
      let lastError = "";
      while (!stopping) {
        let ran = false;
        for (const { repo, api, body, file } of sources) {
          if (stopping) break;
          let job: ClaimedJob | null;
          try {
            job = await claim(api, repo, body);
            lastError = "";
          } catch (e) {
            if (file && e instanceof ApiError && e.status === 401) throw new CliError(`runner ${name} was removed from ${repo.owner}/${repo.name}; delete ${file} and register it again`);
            if (o.once || ephemeral || (e instanceof ApiError && [401, 403, 404].includes(e.status))) throw e;
            const msg = (e as Error).message;
            if (msg !== lastError) ctx.err(`${c.yellow("warning:")} ${msg} (will retry)`);
            lastError = msg;
            continue;
          }
          if (!job) continue;
          ran = true;
          const code = await runJob(ctx, agent, job, repo, workRoot, !o.quiet, (ch) => (child = ch));
          if (o.once || ephemeral) return code;
          if (stopping) break;
        }
        if (o.once) {
          ctx.out("No jobs waiting.");
          return 0;
        }
        if (!ran && !stopping) await ctx.io.sleep(intervalMs, abort.signal);
      }
      ctx.out("Runner stopped.");
      return 0;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  },
};
