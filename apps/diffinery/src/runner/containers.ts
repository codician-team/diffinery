import { DurableObject } from "cloudflare:workers";
import { Container } from "@cloudflare/containers";
import type { StopParams } from "@cloudflare/containers";
import type { Env } from "../env.js";
import { egressStart, type Egress } from "../lib/egress.js";
import { endCompute, startCompute } from "../lib/quotas.js";
import { blockedBy, killSwitches } from "../lib/killswitch.js";

/**
 * Hosted compute (jobs and sandboxes) under the instance's egress policy (lib/egress.ts), set before
 * each start. A limited one is kept in storage, so the container starting again from this Durable
 * Object with its defaults (a sandbox after its idle sleep) is limited too; the allowed hosts are
 * kept by the library itself.
 */
abstract class HostedContainer extends Container<Env> {
  override enableInternet = true;

  constructor(ctx: DurableObject["ctx"], env: Env) {
    super(ctx, env);
    const kept = ctx.storage.kv.get<Egress>("egress");
    if (kept) this.adopt(kept);
  }

  /** Applies the policy before a start and returns the variables that tell the agent about it. */
  protected async useEgress(egress: Egress): Promise<Record<string, string>> {
    const o = this.adopt(egress);
    if (o.allowedHosts) await this.setAllowedHosts(o.allowedHosts);
    if (egress !== "open") this.ctx.storage.kv.put("egress", egress);
    return o.envVars;
  }

  private adopt(egress: Egress) {
    const o = egressStart(egress);
    this.enableInternet = o.enableInternet;
    this.interceptHttps = o.interceptHttps;
    return o;
  }
}

/** The job a runner container runs; stopRequested once Diffinery asked it to stop (stopJob). */
type RunnerJob = { repoId: string; jobId: string; container?: string; stopRequested?: boolean };
/** A GitHub job's runner (github-runners/): GitHub's own runner, for the account that pays. */
type GitHubRunner = { accountId: string; runnerId: string; container?: string };

/** How long a job's container may take to come up, and how often it is checked meanwhile. */
const START_WAIT_MS = 180_000;
const START_POLL_MS = 500;

/**
 * One container per workflow job. The runner agent inside fetches its job spec
 * from the Diffinery API, runs the steps and reports back, then exits.
 */
export class RunnerContainer extends HostedContainer {
  // Jobs make no inbound requests, so activity-based sleep must not stop them.
  override sleepAfter = "6h";
  /** True while start() runs (startRunner). */
  private starting = false;

  async startJob(input: { repoId: string; jobId: string; container?: string; token: string; apiUrl: string; egress?: Egress; vcpu?: number }): Promise<void> {
    await this.ctx.storage.put("job", { repoId: input.repoId, jobId: input.jobId, container: input.container });
    await this.startRunner({
      DIFFINERY_API_URL: input.apiUrl,
      DIFFINERY_JOB_ID: input.jobId,
      DIFFINERY_JOB_TOKEN: input.token,
      // The runner's share of CPU, which the agent measures the job's use against (runner/sizes.ts).
      ...(input.vcpu ? { DIFFINERY_RUNNER_VCPU: String(input.vcpu) } : {}),
      ...(await this.useEgress(input.egress ?? "open")),
    });
  }

  /**
   * A GitHub job's runner (github-runners/service.ts): the agent runs GitHub's runner with the just-in-time
   * configuration GitHub made for it, which holds the runner's credentials, so it is only ever in the
   * container's environment.
   */
  async startGitHubRunner(input: { accountId: string; runnerId: string; container?: string; jitConfig: string; egress: Egress; vcpu: number }): Promise<void> {
    await this.ctx.storage.put("github", { accountId: input.accountId, runnerId: input.runnerId, container: input.container } satisfies GitHubRunner);
    await this.startRunner({ DIFFINERY_GITHUB_JIT_CONFIG: input.jitConfig, DIFFINERY_RUNNER_VCPU: String(input.vcpu), ...(await this.useEgress(input.egress)) });
  }

  private async startRunner(envVars: Record<string, string>): Promise<void> {
    this.starting = true;
    try {
      await this.start(
        { envVars },
        // The library gives up after 8 s and reports "no container instance", but a container on a host
        // that hasn't pulled the runner image yet takes longer than that to come up: such jobs went back
        // in line for 30 to 90 s more (measured on 10-leg matrices). Wait for it instead.
        // The runner listens on no port: the library's own fallback port (33) answers "not listening" once it is up.
        // Each check can itself take up to 5 s, so the signal bounds the whole wait.
        { portToCheck: 33, waitInterval: START_POLL_MS, retries: Math.ceil(START_WAIT_MS / START_POLL_MS), signal: AbortSignal.timeout(START_WAIT_MS + 60_000) },
      );
    } finally {
      this.starting = false;
    }
  }

  /**
   * Diffinery ended the job (a timeout, fail-fast, a newer run in its concurrency group): the container
   * goes at once. `graceful` (someone cancelled the run) sends SIGINT instead: the runner stops the step
   * under way, runs the steps that run after a cancel and reports. The agent reads SIGTERM as a platform
   * rollout and keeps the job running for up to 14 minutes, which a cancelled job must not do.
   */
  async stopJob(graceful = false): Promise<void> {
    // Noted first, so onStop can tell Diffinery's own stop (a cancel, a timeout) from the platform's.
    const job = await this.ctx.storage.get<RunnerJob>("job");
    if (job) await this.ctx.storage.put("job", { ...job, stopRequested: true });
    if (!this.ctx.container?.running) return;
    if (graceful) await this.stop("SIGINT");
    else await this.destroy();
  }

  override async onStop(params: StopParams): Promise<void> {
    const gh = await this.ctx.storage.get<GitHubRunner>("github");
    if (gh) {
      // While a start the platform had no machine for is tried again, the library's alarm reports the container
      // stopped with exit code 0, though nothing ran and the start goes on. Told so, Diffinery removed the runner
      // from GitHub and its job waited 24 hours for another (2 or 3 jobs of 10 started at once). The start ends in
      // a running runner, or in an error that github-runners/service.ts place() handles.
      if (this.starting) return;
      const ns = this.env.GITHUB_RUNNERS;
      if (ns) await ns.get(ns.idFromName(gh.accountId)).stopped(gh.accountId, gh.runnerId, params.exitCode ?? null, gh.container);
      await this.ctx.storage.delete("github");
      return;
    }
    const job = await this.ctx.storage.get<RunnerJob>("job");
    if (!job) return;
    const repo = this.env.REPO.get(this.env.REPO.idFromName(job.repoId));
    await repo.containerStopped(job.jobId, params.exitCode ?? null, job.container, !!job.stopRequested);
    await this.ctx.storage.delete("job");
  }

  override onError(error: unknown): void {
    console.error("runner container error", error);
  }
}

/**
 * The smaller hosted runner sizes (runner/sizes.ts): the same runner on smaller Cloudflare instance
 * types, each its own container class because a container class has one instance type.
 */
export class RunnerContainerMedium extends RunnerContainer {}
export class RunnerContainerSmall extends RunnerContainer {}
export class RunnerContainerTiny extends RunnerContainer {}

/**
 * Long-lived task sandbox for AI agents: the repo checked out with toolchains,
 * and an HTTP API (exec, read/write files) on port 8080.
 */
export class SandboxContainer extends HostedContainer {
  override defaultPort = 8080;
  override sleepAfter = "30m";

  async boot(envVars: Record<string, string>, secret: string, _name?: string, usage?: { id: string; accountId: string; repoId: string }, egress: Egress = "open"): Promise<void> {
    await this.ctx.storage.put("secret", secret);
    // Its running time counts against the repository owner's hosted minutes (lib/quotas.ts).
    if (usage) await this.ctx.storage.put("usage", usage);
    envVars = { ...envVars, ...(await this.useEgress(egress)) };
    // The first start on a host after a deploy pulls the runner image, which takes
    // well over the library's 8 s / 20 s defaults.
    await this.startAndWaitForPorts({
      ports: 8080,
      startOptions: { envVars, entrypoint: ["node", "/opt/diffinery/agent.mjs", "--sandbox"] },
      cancellationOptions: { instanceGetTimeoutMS: 180_000, portReadyTimeoutMS: 120_000, waitInterval: 500 },
    });
  }

  /** Forward an API call (JSON text) to the sandbox's HTTP server with its secret attached. */
  async call(path: string, body: string): Promise<{ status: number; body: string; json: boolean }> {
    const secret = await this.ctx.storage.get<string>("secret");
    // A sandbox that slept after 30 idle minutes starts again for this call: its time counts again.
    const usage = await this.ctx.storage.get<{ id: string; accountId: string; repoId: string; part?: number }>("usage");
    if (usage && !this.ctx.container?.running) {
      // It doesn't wake while a kill switch stops sandboxes (lib/killswitch.ts).
      const block = await killSwitches(this.env, usage.repoId).then(
        (k) => blockedBy(k, "sandbox"),
        () => null,
      );
      if (block) return { status: 403, body: JSON.stringify({ message: block }), json: true };
      const part = (usage.part ?? 0) + 1;
      await startCompute(this.env, { id: `${usage.id}:${part}`, accountId: usage.accountId, repoId: usage.repoId, kind: "sandbox" });
      await this.ctx.storage.put("usage", { ...usage, part });
    }
    const res = await this.containerFetch(`http://sandbox${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: body || "{}",
    });
    return { status: res.status, body: await res.text(), json: (res.headers.get("content-type") ?? "").includes("json") };
  }

  async shutdown(): Promise<void> {
    if (this.ctx.container?.running) await this.stop();
  }

  /** Whether the container is up (calling into a stopped one would start it without its checkout). */
  async running(): Promise<boolean> {
    return !!this.ctx.container?.running && !!(await this.ctx.storage.get<string>("secret"));
  }

  /**
   * A web terminal's socket (agentic/terminal-web.ts checked who is asking): only a WebSocket
   * upgrade to /pty, with the sandbox's secret added. A sandbox that isn't running isn't started
   * again (it would come up without its checkout), and nothing else of the sandbox is reachable here.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/pty" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("not found", { status: 404 });
    const secret = await this.ctx.storage.get<string>("secret");
    if (!secret || !this.ctx.container?.running) return new Response("the terminal isn't running", { status: 410 });
    const headers = new Headers({ upgrade: "websocket", authorization: `Bearer ${secret}` });
    return this.containerFetch(new Request(`http://sandbox/pty${url.search}`, { headers }), 8080);
  }

  override async onStop(): Promise<void> {
    const usage = await this.ctx.storage.get<{ id: string; part?: number }>("usage");
    if (usage) await endCompute(this.env, usage.part ? `${usage.id}:${usage.part}` : usage.id);
  }
}

/**
 * Local development and end-to-end tests only: `env.dev` binds SANDBOX to this
 * instead of SandboxContainer, because containers don't run under `wrangler dev`.
 * The same calls, served by one `agent.mjs --sandbox-pool` process at
 * SANDBOX_POOL_URL that runs each sandbox's server.
 */
export class SandboxPoolDO extends DurableObject<Env> {
  private poolAuth() {
    return { authorization: `Bearer ${this.env.SANDBOX_POOL_SECRET ?? ""}` };
  }

  async boot(envVars: Record<string, string>, secret: string, name?: string): Promise<void> {
    if (!this.env.SANDBOX_POOL_URL || !name) throw new Error("SANDBOX_POOL_URL is not set: start `agent.mjs --sandbox-pool` for sandboxes under wrangler dev");
    await this.ctx.storage.put({ secret, name });
    const r = await fetch(`${this.env.SANDBOX_POOL_URL}/boot`, { method: "POST", headers: this.poolAuth(), body: JSON.stringify({ id: name, secret, env: envVars }) });
    if (!r.ok) throw new Error(`sandbox pool boot failed: ${r.status} ${await r.text()}`);
  }

  async call(path: string, body: string): Promise<{ status: number; body: string; json: boolean }> {
    const [secret, name] = await Promise.all([this.ctx.storage.get<string>("secret"), this.ctx.storage.get<string>("name")]);
    if (!name) return { status: 404, body: JSON.stringify({ error: "sandbox not found" }), json: true };
    const res = await fetch(`${this.env.SANDBOX_POOL_URL}/s/${name}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: body || "{}" });
    return { status: res.status, body: await res.text(), json: (res.headers.get("content-type") ?? "").includes("json") };
  }

  async shutdown(): Promise<void> {
    const name = await this.ctx.storage.get<string>("name");
    if (name) await fetch(`${this.env.SANDBOX_POOL_URL}/shutdown/${name}`, { method: "POST", headers: this.poolAuth() }).catch(() => {});
  }

  async running(): Promise<boolean> {
    if (!(await this.ctx.storage.get<string>("name"))) return false;
    return (await this.call("/pty/status", "{}").catch(() => ({ status: 0 }))).status === 200;
  }

  /** As SandboxContainer.fetch: a terminal's WebSocket, through the pool. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/pty" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("not found", { status: 404 });
    const [secret, name] = await Promise.all([this.ctx.storage.get<string>("secret"), this.ctx.storage.get<string>("name")]);
    if (!secret || !name) return new Response("the terminal isn't running", { status: 410 });
    const res = await fetch(`${this.env.SANDBOX_POOL_URL}/s/${name}/pty${url.search}`, { headers: { upgrade: "websocket", authorization: `Bearer ${secret}` } });
    if (!res.webSocket) return new Response(await res.text(), { status: res.status === 101 ? 502 : res.status });
    return pipeSocket(res.webSocket);
  }
}

/** Hands a WebSocket this Durable Object holds to the caller, relaying frames and closes both ways. */
function pipeSocket(upstream: WebSocket): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  upstream.accept();
  server.accept();
  const code = (c: number) => (c === 1005 || c === 1006 ? 1000 : c);
  // Binary frames can arrive as Blobs; reading one is async, so each direction keeps its order with a chain.
  const relay = (from: WebSocket, to: WebSocket) => {
    let chain = Promise.resolve();
    from.addEventListener("message", (e) => {
      const data = e.data as string | ArrayBuffer | Blob;
      chain = chain.then(async () => to.send(data instanceof Blob ? await data.arrayBuffer() : data)).catch(() => to.close(1011, "relay failed"));
    });
  };
  relay(server, upstream);
  relay(upstream, server);
  server.addEventListener("close", (e) => upstream.close(code(e.code), e.reason));
  upstream.addEventListener("close", (e) => server.close(code(e.code), e.reason));
  server.addEventListener("error", () => upstream.close(1011, "client error"));
  upstream.addEventListener("error", () => server.close(1011, "sandbox error"));
  return new Response(null, { status: 101, webSocket: client });
}
