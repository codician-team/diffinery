/**
 * Diffinery runner agent entry point.
 *
 *   agent.mjs                       fetch the job from DIFFINERY_API_URL and run it
 *   agent.mjs --spec job.json       run a JobSpec from a file (reports to spec.apiUrl,
 *                                   or DIFFINERY_API_URL; `--offline` logs to stdout only)
 *   agent.mjs --sandbox             AI-agent sandbox HTTP server on :8080
 *   agent.mjs --sandbox-pool        many sandboxes in one process, for local development and
 *                                   end-to-end tests (see sandbox-pool.ts)
 *   agent.mjs --jail ...            run a terminal task's command in its jail (see jail.ts)
 *   agent.mjs --registry-relay      HTTPS proxy for the Docker daemon that splits big
 *                                   image layer uploads to the Diffinery registry (see relay.ts)
 *
 * With DIFFINERY_IMPORT_ID and DIFFINERY_IMPORT_TOKEN set (instead of a job), it
 * runs a GitHub import's Git transfer (see importer.ts) and exits.
 */
import { readFile } from "node:fs/promises";
import type { JobSpec } from "@diffinery/shared";
import { UsageSampler } from "./usage.js";
import { apiBaseFor, runAgentJob } from "./agent.js";
import { trustEgressCa } from "./egress.js";
import { RunnerApi } from "./api.js";
import { runJail } from "./jail.js";
import { runImportAgent } from "./importer.js";
import { startSandbox } from "./sandbox.js";
import { startSandboxPool } from "./sandbox-pool.js";
import { startRelay } from "./relay.js";

interface Args {
  spec?: string;
  sandbox: boolean;
  pool: boolean;
  relay: boolean;
  offline: boolean;
  workRoot?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { sandbox: false, pool: false, relay: false, offline: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "--spec") a.spec = argv[++i];
    else if (v.startsWith("--spec=")) a.spec = v.slice(7);
    else if (v === "--sandbox") a.sandbox = true;
    else if (v === "--sandbox-pool") a.pool = true;
    else if (v === "--registry-relay") a.relay = true;
    else if (v === "--offline") a.offline = true;
    else if (v === "--work-root") a.workRoot = argv[++i];
    else if (v === "--help" || v === "-h") {
      process.stdout.write("usage: agent.mjs [--spec job.json [--offline]] [--sandbox | --sandbox-pool] [--work-root dir]\n");
      process.exit(0);
    }
  }
  return a;
}

function fail(msg: string): never {
  process.stderr.write(`[diffinery-runner] ${msg}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  if (process.argv[2] === "--jail") process.exit(await runJail(process.argv.slice(3)));
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const workRoot = args.workRoot ?? env.DIFFINERY_WORK_ROOT ?? "/workspace";
  await trustEgressCa(env);

  if (args.relay) {
    const { DIFFINERY_RELAY_HOST: host, DIFFINERY_RELAY_UPSTREAM: upstream, DIFFINERY_RELAY_CERT: cert, DIFFINERY_RELAY_KEY: key } = env;
    if (!host || !upstream || !cert || !key) fail("DIFFINERY_RELAY_HOST, DIFFINERY_RELAY_UPSTREAM, DIFFINERY_RELAY_CERT and DIFFINERY_RELAY_KEY are required with --registry-relay");
    await startRelay({ port: Number(env.DIFFINERY_RELAY_PORT ?? 3129), host, upstream, chunkSize: env.DIFFINERY_RELAY_CHUNK ? Number(env.DIFFINERY_RELAY_CHUNK) : undefined, cert: await readFile(cert, "utf8"), key: await readFile(key, "utf8") });
    return;
  }

  if (args.pool) {
    const secret = env.DIFFINERY_SANDBOX_POOL_SECRET;
    if (!secret) fail("DIFFINERY_SANDBOX_POOL_SECRET is required in --sandbox-pool mode");
    const pool = await startSandboxPool({ port: Number(env.DIFFINERY_SANDBOX_PORT ?? env.PORT ?? 8080), secret, workRoot });
    process.stdout.write(`[sandbox-pool] listening on :${pool.port}\n`);
    const stop = () => void pool.close().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return;
  }
  if (args.sandbox) {
    const secret = env.DIFFINERY_SANDBOX_SECRET;
    if (!secret) fail("DIFFINERY_SANDBOX_SECRET is required in --sandbox mode");
    const h = await startSandbox({
      port: Number(env.DIFFINERY_SANDBOX_PORT ?? env.PORT ?? 8080),
      secret,
      workRoot,
      cloneUrl: env.DIFFINERY_CLONE_URL,
      ref: env.DIFFINERY_REF,
      token: env.DIFFINERY_JOB_TOKEN,
    });
    process.stdout.write(`[sandbox] listening on :${h.port}\n`);
    const stop = () => void h.close().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return;
  }

  if (env.DIFFINERY_IMPORT_ID) {
    const api = env.DIFFINERY_API_URL;
    const token = env.DIFFINERY_IMPORT_TOKEN;
    if (!api || !token) fail("DIFFINERY_API_URL and DIFFINERY_IMPORT_TOKEN are required in import mode");
    const chunk = Number(env.DIFFINERY_IMPORT_CHUNK_BYTES);
    const large = Number(env.DIFFINERY_IMPORT_LARGE_BLOB_BYTES);
    const result = await runImportAgent({ apiUrl: api, importId: env.DIFFINERY_IMPORT_ID, token, workRoot, chunkBytes: Number.isFinite(chunk) && chunk > 0 ? chunk : undefined, largeBlobBytes: Number.isFinite(large) && large > 0 ? large : undefined });
    process.stdout.write(`[diffinery-import] ${result.ok ? "finished" : `failed: ${result.error}`}\n`);
    process.exit(result.ok ? 0 : 1);
  }

  let spec: JobSpec;
  let apiBase: string | null;
  if (args.spec) {
    spec = JSON.parse(await readFile(args.spec, "utf8")) as JobSpec;
    if (env.DIFFINERY_JOB_TOKEN && !spec.token) spec.token = env.DIFFINERY_JOB_TOKEN;
    apiBase = args.offline ? null : apiBaseFor(env.DIFFINERY_API_URL ?? spec.apiUrl, spec.jobId);
  } else {
    const api = env.DIFFINERY_API_URL;
    const jobId = env.DIFFINERY_JOB_ID;
    const token = env.DIFFINERY_JOB_TOKEN;
    if (!api || !jobId || !token) fail("DIFFINERY_API_URL, DIFFINERY_JOB_ID and DIFFINERY_JOB_TOKEN are required (or pass --spec / --sandbox)");
    apiBase = apiBaseFor(api, jobId);
    const client = new RunnerApi(apiBase, token);
    try {
      spec = await client.getSpec();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await client.complete({ conclusion: "failure", outputs: {}, failure: { message: `Runner could not fetch the job spec: ${msg}` } });
      } catch {
        /* nothing more we can do */
      }
      fail(`could not fetch job spec: ${msg}`);
    }
    spec.token ||= token;
    spec.apiUrl ||= api;
  }

  const completion = await runAgentJob(spec, {
    apiBase,
    workRoot,
    toolCache: env.RUNNER_TOOL_CACHE,
    echoLogs: env.DIFFINERY_ECHO_LOGS === "1" || apiBase === null,
    handleSignals: true,
    // Cloudflare gives a container 15 minutes after SIGTERM during a rollout; the last
    // two are for cancelling the steps and reporting the result before SIGKILL.
    drainOnSigtermMs: args.spec ? undefined : 13 * 60_000,
    // A hosted runner is its own machine (Cloudflare sets the Durable Object id in its container).
    // test/docker-wrapper.test.ts runs the image's docker wrapper with the head start on.
    prewarmDocker: !!env.CLOUDFLARE_DURABLE_OBJECT_ID,
    prefetchTools: !!env.CLOUDFLARE_DURABLE_OBJECT_ID,
    measureUsage: !!env.CLOUDFLARE_DURABLE_OBJECT_ID || env.DIFFINERY_MEASURE_USAGE === "1" ? new UsageSampler({ cores: Number(env.DIFFINERY_RUNNER_VCPU) || undefined }) : false,
  });
  process.stdout.write(`[diffinery-runner] job finished: ${completion.conclusion}\n`);
  process.exit(completion.conclusion === "success" ? 0 : 1);
}

main().catch((e: unknown) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
