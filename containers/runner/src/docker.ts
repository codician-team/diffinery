import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ContainerSpec } from "@diffinery/shared";
import { failure, type JobRunner, type StepIO } from "./job.js";
import { shellWords, sleep, which } from "./util.js";

/**
 * Docker support for self-hosted runners: job containers (`jobs.<id>.container`),
 * service containers (`jobs.<id>.services`) and Docker container actions.
 *
 * Like GitHub's runner, every container of a job joins one bridge network, the job
 * container mounts the work directory at the same path it has on the host (so file
 * commands, scripts and the tool cache need no path mapping), and Docker actions run
 * as sibling containers with the workspace at /github/workspace.
 */

/** Env vars that would change how the docker CLI itself behaves, so they are passed inline. */
const INLINE_ENV = /^(PATH|HOME|TMPDIR|DOCKER_\w*|LD_\w*|SSL_CERT_\w*)$/;
const SOCKET = "/var/run/docker.sock";
/** Inside a job container, the runner's own node binary (for JavaScript actions). */
export const CONTAINER_NODE = "/__e/node";
const CONTAINER_HOME = "/github/home";

export interface RunningContainer {
  id: string;
  name: string;
  network: string;
  ports: Record<string, string>;
}

export interface JobContainer extends RunningContainer {
  /** PATH from the image, used when the workflow doesn't set one. */
  path: string;
  /** Shells and interpreters found in the image. */
  tools: Set<string>;
}

export type Wrap = (argv: string[], env: Record<string, string>, cwd: string) => { argv: string[]; env: NodeJS.ProcessEnv; cwd: string };

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[^A-Za-z0-9]+/, "") || "x";
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export class Docker {
  readonly label: string;
  network: string | null = null;
  container: JobContainer | null = null;
  readonly services: Record<string, RunningContainer> = {};
  private bin: string | null = null;
  private configDir: string | null = null;
  private seq = 0;

  constructor(private readonly job: JobRunner) {
    this.label = `diffinery.job=${sanitize(job.spec.jobId)}`;
  }

  // ------------------------------------------------------------ CLI

  /**
   * Hosted runners start the Docker daemon the first time anything runs `docker` (image/docker), which
   * takes 2-5 s. A job that will use Docker starts it as the job begins instead, while checkout and
   * setup run; the first real `docker` call then waits only for what is left (the wrapper's lock).
   * If this start fails, that first call starts the daemon again and reports why it can't.
   */
  prewarm(): void {
    const env = this.job.hostEnv();
    const bin = which("docker", env.PATH);
    if (!bin) return;
    try {
      const child = spawn(bin, ["version"], { env, stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    } catch {
      /* the first real docker call starts it */
    }
  }

  /** Fails with a clear message when the runner has no usable Docker. */
  async ensure(io: StepIO, what: string): Promise<string> {
    if (this.bin) return this.bin;
    const bin = which("docker", this.job.hostEnv().PATH);
    if (!bin) throw failure(`${what} need Docker, and this runner has no docker CLI. Use runs-on: [self-hosted, ...] on a machine with Docker installed.`);
    const r = await this.job.tool(bin, ["version", "--format", "{{.Server.Version}}"], { io, capture: true, silent: true, env: this.job.hostEnv() });
    if (r.exitCode !== 0) throw failure(`${what} need Docker, and the Docker daemon on this runner is not reachable: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
    this.job.logger.line(io.logIndex, `Docker ${r.stdout.trim()}`);
    this.bin = bin;
    return bin;
  }

  private async docker(io: StepIO, args: string[], o: { capture?: boolean; silent?: boolean; input?: string; env?: NodeJS.ProcessEnv; config?: boolean } = {}) {
    const bin = this.bin!;
    const full = o.config && this.configDir ? ["--config", this.configDir, ...args] : args;
    return this.job.tool(bin, full, { io, capture: o.capture, silent: o.silent, input: o.input, env: o.env ?? this.job.hostEnv() });
  }

  private async must(io: StepIO, args: string[], o: Parameters<Docker["docker"]>[2] = {}): Promise<string> {
    const r = await this.docker(io, args, { capture: true, ...o });
    if (r.exitCode !== 0) throw failure(`docker ${args[0]} failed (exit code ${r.exitCode}): ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
    return r.stdout.trim();
  }

  /** `-e NAME` flags with the values carried in the docker CLI's own environment (keeps secrets out of argv). */
  envArgs(env: Record<string, string>): { args: string[]; env: NodeJS.ProcessEnv } {
    const args: string[] = [];
    const cli: NodeJS.ProcessEnv = this.job.hostEnv();
    for (const [k, v] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      if (INLINE_ENV.test(k)) args.push("-e", `${k}=${v}`);
      else {
        args.push("-e", k);
        cli[k] = v;
      }
    }
    return { args, env: cli };
  }

  async ensureNetwork(io: StepIO): Promise<string> {
    if (this.network) return this.network;
    const name = `diffinery_${sanitize(this.job.spec.jobId)}_${hash(`${Date.now()}${Math.random()}`).slice(0, 6)}`;
    await this.must(io, ["network", "create", "--label", this.label, name]);
    this.network = name;
    return name;
  }

  private async login(io: StepIO, image: string, creds: ContainerSpec["credentials"]): Promise<void> {
    if (!creds?.username && !creds?.password) return;
    if (!creds.username || !creds.password) throw failure(`Registry credentials for ${image} need both a username and a password.`);
    this.configDir ??= path.join(this.job.tempDir, "_docker_config");
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    this.job.masker.add(creds.password);
    const first = image.split("/")[0]!;
    const registry = image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost") ? first : "";
    await this.must(io, ["login", "--username", creds.username, "--password-stdin", ...(registry ? [registry] : [])], { input: creds.password, config: true });
  }

  async pull(io: StepIO, image: string, creds?: ContainerSpec["credentials"]): Promise<void> {
    await this.login(io, image, creds);
    this.job.logger.line(io.logIndex, `##[command]docker pull ${image}`);
    const r = await this.docker(io, ["pull", image], { config: !!creds?.username });
    if (r.exitCode !== 0) throw failure(`Could not pull ${image} (docker pull exited with ${r.exitCode}).`);
  }

  // ------------------------------------------------------------ services and the job container

  private specArgs(spec: ContainerSpec, where: string): string[] {
    const args: string[] = [];
    for (const p of spec.ports ?? []) args.push("-p", String(p));
    for (const v of spec.volumes ?? []) args.push("-v", v);
    const options = spec.options ? shellWords(spec.options) : [];
    for (const o of options) {
      if (/^--(network|net)(=|$)/.test(o)) throw failure(`${where}: the --network option is not supported; every container of the job shares one network.`);
    }
    return [...args, ...options];
  }

  private async ports(io: StepIO, id: string): Promise<Record<string, string>> {
    const out = await this.must(io, ["port", id]).catch(() => "");
    const ports: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const m = /^(\d+)\/\w+\s*->\s*.*:(\d+)$/.exec(line.trim());
      if (m && !ports[m[1]!]) ports[m[1]!] = m[2]!;
    }
    return ports;
  }

  /** Waits for a container's health check, if it has one. */
  private async healthy(io: StepIO, id: string, name: string): Promise<void> {
    const deadline = Date.now() + 15 * 60_000;
    let delay = 1000;
    for (;;) {
      const status = await this.must(io, ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{end}}", id]);
      if (status === "" || status === "healthy") {
        if (status) this.job.logger.line(io.logIndex, `${name} is healthy`);
        return;
      }
      if (status === "unhealthy") {
        await this.docker(io, ["logs", "--tail", "50", id]);
        throw failure(`Service container ${name} failed its health check.`);
      }
      const running = await this.must(io, ["inspect", "--format", "{{.State.Status}}", id]);
      if (running === "exited" || running === "dead") {
        await this.docker(io, ["logs", "--tail", "50", id]);
        throw failure(`Service container ${name} exited before it became healthy.`);
      }
      if (Date.now() > deadline || this.job.isStopping) throw failure(`Service container ${name} did not become healthy in time (status: ${status}).`);
      this.job.logger.line(io.logIndex, `Waiting for ${name} to be healthy (${status})...`);
      await sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
  }

  async startService(io: StepIO, key: string, spec: ContainerSpec): Promise<void> {
    const network = await this.ensureNetwork(io);
    await this.pull(io, spec.image, spec.credentials);
    const name = `${sanitize(key)}_${hash(network)}`;
    const { args: envArgs, env } = this.envArgs(spec.env ?? {});
    const args = ["run", "-d", "--name", name, "--label", this.label, "--network", network, "--network-alias", key, ...envArgs, ...this.specArgs(spec, `services.${key}`), spec.image];
    this.job.logger.line(io.logIndex, `##[command]docker ${["run", "-d", "--name", name, "--network", network, "--network-alias", key, ...this.specArgs(spec, `services.${key}`), spec.image].join(" ")}`);
    const id = await this.must(io, args, { env });
    await this.healthy(io, id, key);
    const ports = await this.ports(io, id);
    this.services[key] = { id, name, network, ports };
    const shown = Object.entries(ports).map(([c, h]) => `${c} -> localhost:${h}`);
    this.job.logger.line(io.logIndex, `Service ${key} is running${shown.length ? ` (${shown.join(", ")})` : ""}`);
  }

  async startJobContainer(io: StepIO, spec: ContainerSpec): Promise<void> {
    const network = await this.ensureNetwork(io);
    await this.pull(io, spec.image, spec.credentials);
    const job = this.job;
    const name = `job_${hash(`${network}${job.spec.jobId}`)}`;
    const workRoot = path.resolve(job.opts.workRoot);
    const home = path.join(job.tempDir, "_github_home");
    await mkdir(home, { recursive: true });
    const mounts = ["-v", `${workRoot}:${workRoot}`, "-v", `${home}:${CONTAINER_HOME}`];
    const toolCache = path.resolve(job.toolCache);
    if (!toolCache.startsWith(`${workRoot}/`)) mounts.push("-v", `${toolCache}:${toolCache}`);
    const tempDir = path.resolve(job.tempDir);
    if (!tempDir.startsWith(`${workRoot}/`)) mounts.push("-v", `${tempDir}:${tempDir}`);
    mounts.push("-v", `${process.execPath}:${CONTAINER_NODE}:ro`);
    if (existsSync(SOCKET)) mounts.push("-v", `${SOCKET}:${SOCKET}`);
    const { args: envArgs, env } = this.envArgs(spec.env ?? {});
    const extra = this.specArgs(spec, "container");
    const args = ["run", "-d", "--name", name, "--label", this.label, "--network", network, "--workdir", job.workspace, ...mounts, ...envArgs, ...extra, "--entrypoint", "tail", spec.image, "-f", "/dev/null"];
    job.logger.line(io.logIndex, `##[command]docker run -d --name ${name} --network ${network} --workdir ${job.workspace} ${[...mounts, ...extra].join(" ")} --entrypoint tail ${spec.image} -f /dev/null`);
    const id = await this.must(io, args, { env });
    const running = await this.must(io, ["inspect", "--format", "{{.State.Running}}", id]);
    if (running !== "true") {
      await this.docker(io, ["logs", "--tail", "50", id]);
      throw failure(`The job container (${spec.image}) exited right after starting. The image needs a 'tail' command to stay up.`);
    }
    const imageEnv = await this.must(io, ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", id]);
    const pathLine = imageEnv.split("\n").find((l) => l.startsWith("PATH="));
    const probe = await this.docker(io, ["exec", id, "sh", "-c", 'for c in bash sh python python3 pwsh powershell; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done'], { capture: true, silent: true });
    const tools = new Set(probe.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
    this.container = {
      id,
      name,
      network,
      ports: await this.ports(io, id),
      path: pathLine ? pathLine.slice(5) : "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      tools,
    };
    job.logger.line(io.logIndex, `Steps run in the job container ${spec.image} (${name})`);
  }

  /** Runs a step's process inside the job container. */
  execWrap(): Wrap | undefined {
    const c = this.container;
    if (!c) return undefined;
    return (argv, env, cwd) => {
      const inner = { ...env, HOME: CONTAINER_HOME, PATH: [...this.job.pathAccum, env.PATH ?? c.path].filter(Boolean).join(":") };
      const e = this.envArgs(inner);
      return { argv: [this.bin!, "exec", "-w", cwd, ...e.args, c.id, ...argv], env: e.env, cwd };
    };
  }

  // ------------------------------------------------------------ Docker actions

  /** Pulls `docker://image` or builds an action's Dockerfile; returns the image to run. */
  async prepareAction(io: StepIO, image: string, actionDir: string | null): Promise<string> {
    await this.ensure(io, "Docker container actions");
    if (image.startsWith("docker://")) {
      const ref = image.slice("docker://".length);
      await this.pull(io, ref);
      return ref;
    }
    if (!actionDir) throw failure(`Invalid Docker image '${image}'`);
    const dockerfile = path.resolve(actionDir, image);
    if (!dockerfile.startsWith(`${path.resolve(actionDir)}/`) || !existsSync(dockerfile)) throw failure(`Dockerfile '${image}' not found in the action at ${actionDir}`);
    const tag = `diffinery-action-${hash(dockerfile)}:latest`;
    this.job.logger.line(io.logIndex, `##[command]docker build -t ${tag} -f ${dockerfile} ${actionDir}`);
    const r = await this.docker(io, ["build", "-t", tag, "-f", dockerfile, actionDir]);
    if (r.exitCode !== 0) throw failure(`Building the action's Dockerfile failed (exit code ${r.exitCode}).`);
    return tag;
  }

  /** Runs an action image as a sibling container on the job network. */
  async runWrap(io: StepIO, image: string, o: { entrypoint?: string; args: string[] }): Promise<Wrap> {
    const network = await this.ensureNetwork(io);
    const job = this.job;
    const home = path.join(job.tempDir, "_github_home");
    await mkdir(home, { recursive: true });
    const tempDir = path.resolve(job.tempDir);
    const name = `action_${hash(`${network}${++this.seq}`)}_${this.seq}`;
    const mounts = ["-v", `${path.resolve(job.workspace)}:/github/workspace`, "-v", `${tempDir}:${tempDir}`, "-v", `${home}:${CONTAINER_HOME}`];
    if (existsSync(SOCKET)) mounts.push("-v", `${SOCKET}:${SOCKET}`);
    return (_argv, env) => {
      const inner: Record<string, string> = { ...env, GITHUB_WORKSPACE: "/github/workspace", HOME: CONTAINER_HOME };
      // The image keeps its own PATH unless the workflow set one.
      if (env.PATH === undefined) delete inner.PATH;
      const e = this.envArgs(inner);
      const argv = [this.bin!, "run", "--rm", "--name", name, "--label", this.label, "--network", network, "--workdir", "/github/workspace", ...mounts, ...e.args];
      if (o.entrypoint) argv.push("--entrypoint", o.entrypoint);
      argv.push(image, ...o.args);
      return { argv, env: e.env, cwd: job.workspace };
    };
  }

  // ------------------------------------------------------------ cleanup

  async cleanup(io: StepIO): Promise<void> {
    if (!this.bin) return;
    const ids = (await this.docker(io, ["ps", "-aq", "--filter", `label=${this.label}`], { capture: true, silent: true })).stdout.split("\n").filter(Boolean);
    if (ids.length) {
      this.job.logger.line(io.logIndex, `Stopping ${ids.length} container${ids.length === 1 ? "" : "s"}`);
      await this.docker(io, ["rm", "-f", "-v", ...ids], { capture: true, silent: true });
    }
    if (this.network) await this.docker(io, ["network", "rm", this.network], { capture: true, silent: true });
    this.network = null;
    this.container = null;
  }
}
