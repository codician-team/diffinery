#!/usr/bin/env node
// Render apps/diffinery/wrangler.celld.jsonc from wrangler.jsonc, for celld (https://celld.dev), the
// open-source Workers and Durable Objects runtime. wrangler.jsonc stays the one source of truth: this
// keeps what celld runs and drops the Cloudflare-network features, whose bindings the Worker treats as
// optional (CELLD_ABSENT_BINDINGS in src/env.ts). celld stops on a key it doesn't know, so a new
// key in wrangler.jsonc fails here until it is listed below (docs/self-hosting/celld.md).
//
//   node scripts/celld-config.mjs [--env dev] [--public-url https://git.example.com] [--var NAME=VALUE ...] [--out <file>]
//
// --env applies one of wrangler.jsonc's environments, as `wrangler -e` does (`--env dev` for `celld dev`).
// --var sets a Worker variable; repeat it. `celld deploy` takes no secrets of its own, so the secrets
// named in SECRETS are copied from this process's environment into `vars` when set: the rendered file
// then holds them, is written readable by its owner only and is ignored by git. celld keeps the
// deployment in the fleet bucket, whose credentials are the fleet's administrator access anyway.
// From the environment it also takes RUNNER_IMAGE, an image already in a registry (scripts/runner-image.sh).
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseJsonc } from "./jsonc.mjs";

/** Top-level keys `celld deploy` accepts (celld's docs/cloudflare-compat.md); any other stops the deploy. */
export const CELLD_KEYS = new Set(["$schema", "name", "main", "no_bundle", "compatibility_date", "compatibility_flags", "durable_objects", "migrations", "assets", "services", "triggers", "vars", "d1_databases", "kv_namespaces", "queues", "workflows", "r2_buckets", "worker_loaders", "containers", "define", "rules"]);

/** Keys celld accepts inside a list entry; any other stops the deploy. */
const NESTED = {
  migrations: ["tag", "new_sqlite_classes"],
  workflows: ["name", "binding", "class_name", "script_name"],
  producers: ["binding", "queue", "delivery_delay"],
  consumers: ["queue", "max_batch_size", "max_batch_timeout", "max_retries", "dead_letter_queue", "max_concurrency", "retry_delay"],
  d1_databases: ["binding", "database_name", "database_id", "migrations_dir", "migrations_table"],
  r2_buckets: ["binding", "bucket_name"],
};

/**
 * wrangler.jsonc keys celld has no equivalent for, and what the instance does without each. A key
 * that holds bindings names them, so the guard test can check the Worker runs without them.
 */
export const DROPPED = {
  routes: { why: "celld has no managed ingress: put a TLS-terminating proxy in front of the fleet" },
  workers_dev: { why: "a workers.dev subdomain only exists on Cloudflare" },
  observability: { why: "logs go to each celld node's output" },
  upload_source_maps: { why: "stack traces point into the bundle" },
  limits: { why: "celld has no per-request CPU limit to raise" },
  version_metadata: { why: "IndexNow hashes the site's pages at every check instead of once per deployed version", bindings: (v) => [v.binding] },
  ratelimits: { why: "requests are not rate limited: limit them in the proxy in front of the fleet", bindings: (v) => v.map((r) => r.name) },
  send_email: { why: "emails are logged as skipped, not sent", bindings: (v) => v.map((e) => e.name) },
};

/** Container keys celld accepts. The image build context is the Dockerfile's directory, as image_build_context says here. */
const CONTAINER_KEYS = ["class_name", "image", "name", "instance_type", "max_instances", "runtime"];

/** Secrets (`wrangler secret put` on Cloudflare) copied from the environment into `vars`. */
export const SECRETS = ["MASTER_KEY", "MASTER_KEY_PREV", "OIDC_PRIVATE_KEY", "MAIL_EVENTS_SECRET", "TURNSTILE_SECRET", "GITHUB_OAUTH_CLIENT_SECRET", "SANDBOX_POOL_SECRET"];

/**
 * wrangler.jsonc as celld takes it. Returns the config and the bindings left out (`absent`), which
 * must all be optional in the Worker's Env. Throws on anything celld would refuse or run differently.
 */
export function celldConfig(wrangler, { env, vars = {}, secrets = {}, runnerImage } = {}) {
  let cfg = structuredClone(wrangler);
  if (env) {
    const block = cfg.env?.[env];
    if (!block) throw new Error(`wrangler.jsonc has no environment "${env}"`);
    cfg = { ...cfg, ...structuredClone(block), name: `${cfg.name}-${env}` };
  }
  delete cfg.env;

  const absent = [];
  const dropped = [];
  for (const key of Object.keys(cfg)) {
    if (CELLD_KEYS.has(key)) continue;
    const d = DROPPED[key];
    if (!d) throw new Error(`wrangler.jsonc key "${key}" is not supported by celld; handle it in scripts/celld-config.mjs (DROPPED) and docs/self-hosting/celld.md`);
    absent.push(...(d.bindings?.(cfg[key]) ?? []));
    dropped.push({ key, why: d.why });
    delete cfg[key];
  }

  for (const m of cfg.migrations ?? []) only("migrations", m, NESTED.migrations);
  for (const w of cfg.workflows ?? []) only("workflows", w, NESTED.workflows);
  for (const p of cfg.queues?.producers ?? []) only("queues.producers", p, NESTED.producers);
  for (const c of cfg.queues?.consumers ?? []) only("queues.consumers", c, NESTED.consumers);
  for (const d of cfg.d1_databases ?? []) only("d1_databases", d, NESTED.d1_databases);
  for (const r of cfg.r2_buckets ?? []) only("r2_buckets", r, NESTED.r2_buckets);
  // celld schedules containers itself: no rollout settings, and the build context is the Dockerfile's directory.
  cfg.containers = (cfg.containers ?? []).map((c) => {
    if (c.image_build_context && resolve(c.image_build_context) !== dirname(resolve(c.image))) throw new Error(`container ${c.class_name}: celld builds in the Dockerfile's directory, not ${c.image_build_context}`);
    const out = Object.fromEntries(Object.entries(c).filter(([k]) => CONTAINER_KEYS.includes(k)));
    if (runnerImage) out.image = runnerImage;
    return out;
  });
  if (!cfg.containers.length) delete cfg.containers;

  // Wrangler's default module rules, which the Worker relies on (src/text-modules.d.ts), stated for celld's esbuild.
  const rules = cfg.rules ?? [];
  for (const [type, glob] of [["Text", "**/*.txt"], ["Data", "**/*.bin"]]) if (!rules.some((r) => r.globs?.includes(glob))) rules.push({ type, globs: [glob] });
  cfg.rules = rules;

  cfg.vars = { ...cfg.vars, ...vars, ...secrets };
  for (const [k, v] of Object.entries(cfg.vars)) if (typeof v !== "string") throw new Error(`var ${k} must be a string for celld`);
  // EGRESS=web starts containers without internet and intercepts their HTTPS (lib/egress.ts), which celld refuses.
  if (cfg.vars.EGRESS === "web") throw new Error("EGRESS=web needs Cloudflare Containers' outbound interception, which celld doesn't have; leave EGRESS unset");
  return { config: cfg, absent, dropped };
}

function only(where, entry, keys) {
  const extra = Object.keys(entry).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`${where}: celld doesn't support ${extra.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { env: { type: "string" }, "public-url": { type: "string" }, var: { type: "string", multiple: true }, out: { type: "string" } } });
  const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "diffinery");
  const vars = {};
  for (const v of values.var ?? []) {
    const i = v.indexOf("=");
    if (i < 1) throw new Error(`--var takes NAME=VALUE, not ${JSON.stringify(v)}`);
    vars[v.slice(0, i)] = v.slice(i + 1);
  }
  if (values["public-url"]) {
    const url = new URL(values["public-url"]);
    if (url.pathname !== "/") throw new Error("--public-url must be an origin, like https://git.example.com");
    vars.PUBLIC_URL = url.origin;
    vars.MAIL_FROM ??= `notifications@${url.hostname}`;
  }
  const secrets = Object.fromEntries(SECRETS.filter((s) => process.env[s]).map((s) => [s, process.env[s]]));
  const wrangler = parseJsonc(readFileSync(join(appDir, "wrangler.jsonc"), "utf8"));
  const { config, dropped } = celldConfig(wrangler, { env: values.env, vars, secrets, runnerImage: process.env.RUNNER_IMAGE });
  const out = values.out ? resolve(values.out) : join(appDir, "wrangler.celld.jsonc");
  writeFileSync(out, `// Generated by scripts/celld-config.mjs from wrangler.jsonc; do not edit.\n${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  for (const d of dropped) console.error(`left out ${d.key}: ${d.why}`);
  if (Object.keys(secrets).length) console.error(`copied ${Object.keys(secrets).join(", ")} into vars; keep ${out} private`);
  console.log(`wrote ${out}`);
}
