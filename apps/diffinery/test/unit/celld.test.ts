import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CELLD_ABSENT_BINDINGS } from "../../src/env.js";
import { CELLD_KEYS, SECRETS, celldConfig } from "../../../../scripts/celld-config.mjs";
import { parseJsonc } from "../../../../scripts/jsonc.mjs";

/**
 * Diffinery runs on Cloudflare and on celld, the open-source Workers runtime (docs/self-hosting/celld.md).
 * These checks keep it that way: wrangler.jsonc renders to a config celld accepts, the bindings celld
 * lacks are optional in Env, and the Worker's own code uses only modules and handlers celld provides.
 */

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const wrangler = parseJsonc(readFileSync(join(repo, "apps/diffinery/wrangler.jsonc"), "utf8"));

describe("wrangler.jsonc for celld", () => {
  it("renders with only keys celld accepts", () => {
    for (const env of [undefined, "dev"]) {
      const { config } = celldConfig(wrangler, { env });
      for (const key of Object.keys(config)) expect(CELLD_KEYS.has(key), `${env ?? "production"}: ${key}`).toBe(true);
      for (const c of config.containers ?? []) expect(Object.keys(c).every((k) => ["class_name", "image", "name", "instance_type", "max_instances", "runtime"].includes(k))).toBe(true);
      expect(config.rules).toEqual(expect.arrayContaining([{ type: "Text", globs: ["**/*.txt"] }, { type: "Data", globs: ["**/*.bin"] }]));
    }
    expect(celldConfig(wrangler, { env: "dev" }).config.name).toBe("diffinery-dev");
  });

  it("leaves out exactly the bindings the Worker runs without", () => {
    // CELLD_ABSENT_BINDINGS is type-checked to be optional in Env; this ties it to what the script drops.
    const { absent } = celldConfig(wrangler);
    expect(new Set(absent)).toEqual(new Set(CELLD_ABSENT_BINDINGS));
  });

  it("stops on a key it doesn't know, a nested key celld refuses, and EGRESS=web", () => {
    expect(() => celldConfig({ ...wrangler, tail_consumers: [{ service: "x" }] })).toThrow(/"tail_consumers" is not supported by celld/);
    expect(() => celldConfig({ ...wrangler, r2_buckets: [{ binding: "BUCKET", bucket_name: "b", jurisdiction: "eu" }] })).toThrow(/r2_buckets: celld doesn't support jurisdiction/);
    expect(() => celldConfig({ ...wrangler, migrations: [{ tag: "v9", renamed_classes: [] }] })).toThrow(/renamed_classes/);
    expect(() => celldConfig(wrangler, { vars: { EGRESS: "web" } })).toThrow(/EGRESS=web/);
  });

  it("takes secrets and variables into vars, and a registry image for every container", () => {
    const { config } = celldConfig(wrangler, { vars: { SIGNUP: "open" }, secrets: { MASTER_KEY: "k" }, runnerImage: "registry.example.com/runner:1" });
    expect(config.vars).toMatchObject({ SIGNUP: "open", MASTER_KEY: "k", PUBLIC_URL: wrangler.vars.PUBLIC_URL });
    expect(config.containers.every((c: { image: string }) => c.image === "registry.example.com/runner:1")).toBe(true);
    expect(SECRETS).toContain("OIDC_PRIVATE_KEY");
  });
});

/** Built-in modules celld implements (its docs/cloudflare-compat.md); node:crypto and node:zlib only in part. */
const CELLD_MODULES = new Set(["cloudflare:workers", "cloudflare:workflows", ...["assert", "async_hooks", "buffer", "crypto", "diagnostics_channel", "events", "fs", "os", "path", "stream", "timers/promises", "util", "zlib"].map((m) => `node:${m}`)]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(f) && !f.endsWith(".d.ts") ? [p] : [];
  });
}

describe("Worker code celld runs", () => {
  const files = ["apps/diffinery/src", "packages/git-core/src", "packages/shared/src", "packages/workflow-yaml/src"].flatMap((d) => sources(join(repo, d)));

  it("imports only runtime modules celld provides, and no query-suffixed paths", () => {
    const bad: string[] = [];
    for (const file of files) {
      // Static imports and re-exports (`from "x"`, `import "x"`) and dynamic `import("x")`.
      for (const [, a, b] of readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\b[^;]*?(?:\bfrom\s*|import\s+)"([^"\n]+)"|\bimport\(\s*"([^"\n]+)"\s*\)/gm)) {
        const spec = a ?? b;
        const builtin = /^(?:node|cloudflare):/.test(spec);
        // `x.wasm?module` and the like: celld's esbuild picks a loader by extension only.
        if ((builtin && !CELLD_MODULES.has(spec)) || spec.includes("?")) bad.push(`${file.slice(repo.length)}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("returns no stream from a Durable Object's RPC methods", () => {
    // celld: "RPC streams cannot cross isolate boundaries yet". A streamed answer goes through the object's
    // fetch() instead, as git-upload-pack does (RepoDO.fetch).
    const bad: string[] = [];
    for (const file of files.filter((f) => /extends (?:DurableObject|Container)\b/.test(readFileSync(f, "utf8")))) {
      for (const [m] of readFileSync(file, "utf8").matchAll(/^ {2}(?!private |protected |static |override async fetch\b|async fetch\b)(?:override )?(?:async )?\w+\([^)]*\)\s*:\s*Promise<(?:ReadableStream|Response|R2ObjectBody)\b[^\n]*/gm)) bad.push(`${file.slice(repo.length)}: ${m.trim()}`);
    }
    expect(bad).toEqual([]);
  });

  it("exports only the handlers celld calls", () => {
    // celld has no email or tail handlers.
    const handlers = readFileSync(join(repo, "apps/diffinery/src/index.ts"), "utf8").match(/export default \{([^}]*)\}/)?.[1];
    const names = (handlers ?? "").split(",").map((h) => h.split(":")[0].trim()).filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(["fetch", "queue", "scheduled", "alarm"]).toContain(n);
  });
});
