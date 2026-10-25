import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { JobSpec, StepSpec } from "@diffinery/shared";
import { getBuiltin } from "./builtins/index.js";
import { resolveGo } from "./builtins/setup-go.js";
import { extractUrl, fetchJson, isCached, toolArch } from "./builtins/tools.js";
import type { JobRunner } from "./job.js";
import { parseUses } from "./steps/actions.js";

/** How long a step waits for its head start before installing the tool itself. */
const WAIT_MS = 3 * 60_000;

interface Tool {
  /** Same key, same download: two steps asking for the same tool share one. */
  key: string;
  what: string;
  fetch: (toolCache: string, signal: AbortSignal) => Promise<void>;
}

interface Pending {
  what: string;
  done: Promise<void>;
  settled: boolean;
  abort: AbortController;
}

/**
 * Hosted runners: the toolchain head start. For a job that sets up Go (actions/setup-go) or a Temurin
 * JDK (actions/setup-java) with a version the workflow names, the runner starts downloading and
 * extracting it into the tool cache as the job begins, while the job checks out its code, and the
 * setup step finds it there. It installs exactly what the step would (the same release, in the same
 * place), so the step behaves as it would without it. Jobs without such a step do nothing extra.
 */
export class ToolPrefetch {
  private readonly steps = new Map<number, Pending>();
  private readonly all: Pending[] = [];

  constructor(private readonly job: JobRunner) {}

  start(spec: JobSpec): void {
    // Steps in a job container run in another image, which may need another build of the tool.
    if (spec.container?.image) return;
    const byKey = new Map<string, Pending>();
    spec.steps.forEach((step, i) => {
      const tool = toolFor(step, spec);
      if (!tool) return;
      let p = byKey.get(tool.key);
      if (!p) {
        const abort = new AbortController();
        const signal = AbortSignal.any([abort.signal, this.job.signal]);
        const entry: Pending = { what: tool.what, settled: false, abort, done: Promise.resolve() };
        entry.done = tool
          .fetch(this.job.toolCache, signal)
          // On any failure the step installs the tool itself, as it would without a head start.
          .catch(() => {})
          .finally(() => {
            entry.settled = true;
          });
        p = entry;
        byKey.set(tool.key, p);
        this.all.push(p);
      }
      this.steps.set(i, p);
    });
  }

  /** Before step `i` (of the job's own steps) runs: lets its head start finish, if it has one. */
  async wait(i: number, log: (msg: string) => void): Promise<void> {
    const p = this.steps.get(i);
    if (!p || p.settled) return;
    log(`Waiting for ${p.what}, which the runner started installing as the job began`);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        p.abort.abort();
        resolve();
      }, WAIT_MS);
    });
    await Promise.race([p.done, late]);
    clearTimeout(timer);
    // Aborted: let it clean up before the step installs the tool itself.
    await p.done;
  }

  /** At the end of the job: stops head starts that no step waited for. */
  async stop(): Promise<void> {
    for (const p of this.all) if (!p.settled) p.abort.abort();
    await Promise.all(this.all.map((p) => p.done));
  }
}

/** A `with:` value as the workflow names it: literal, or exactly `${{ matrix.x }}` / `${{ inputs.x }}` / `${{ vars.x }}`. */
function literal(v: string | undefined, spec: JobSpec): string | null {
  if (v === undefined) return "";
  if (!v.includes("${{")) return v.trim();
  const m = /^\$\{\{\s*(matrix|inputs|vars)\.([\w-]+)\s*\}\}$/.exec(v.trim());
  if (!m) return null;
  const ctx = (m[1] === "matrix" ? spec.matrix : m[1] === "inputs" ? spec.inputs : spec.vars) as Record<string, unknown> | undefined;
  const value = ctx?.[m[2]!];
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : null;
}

function toolFor(step: StepSpec, spec: JobSpec): Tool | null {
  if (!step.uses || step.run !== undefined) return null;
  let ref;
  try {
    ref = parseUses(step.uses);
  } catch {
    return null;
  }
  if (ref.kind !== "remote") return null;
  const name = ref.name.toLowerCase();
  const inputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.with ?? {})) {
    const lit = literal(String(v), spec);
    if (lit === null) return null;
    inputs[k.toLowerCase()] = lit;
  }
  if (name === "actions/setup-go") return goTool(ref.ref, inputs, { ...spec.env, ...step.env });
  if (name === "actions/setup-java") return javaTool(ref.ref, inputs);
  return null;
}

/** Go, for the runner's own setup-go (builtins/setup-go.ts), which installs it to `go/<version>/<arch>`. */
function goTool(version: string, inputs: Record<string, string>, env: Record<string, string>): Tool | null {
  if (!getBuiltin("actions/setup-go", version, inputs, env)) return null;
  const spec = (inputs["go-version"] ?? "").replace(/^go/, "");
  if (!spec) return null;
  return {
    key: `go ${spec}`,
    what: `Go ${spec}`,
    fetch: async (toolCache, signal) => {
      const rel = await resolveGo(spec);
      if (!rel) return;
      const dir = path.join(toolCache, "go", rel.version, toolArch("go"));
      if (!isCached(dir)) await extractUrl(rel.url, dir, { sha256: rel.sha256, signal });
    },
  };
}

interface AdoptiumAsset {
  binary: { package: { link: string; checksum?: string } };
  version: { semver: string };
}

/**
 * A Temurin JDK for the real actions/setup-java, laid out in the tool cache the way it caches one
 * (`Java_Temurin-Hotspot_jdk/<version, + as ->/<arch>`), so it finds the JDK there and uses it, as it
 * does with the JDKs preinstalled on GitHub's runners. Only a major version (`java-version: 21`),
 * which setup-java resolves to the same latest release.
 */
function javaTool(version: string, inputs: Record<string, string>): Tool | null {
  const m = /^v(\d+)(\.\d+){0,2}$/.exec(version);
  if (!m || Number(m[1]) < 2 || Number(m[1]) > 5) return null;
  const major = inputs["java-version"] ?? "";
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (
    !arch ||
    !/^\d+$/.test(major) ||
    (inputs.distribution ?? "").toLowerCase() !== "temurin" ||
    !["", "jdk"].includes(inputs["java-package"] ?? "") ||
    !["", arch].includes((inputs.architecture ?? "").toLowerCase()) ||
    /^true$/i.test(inputs["check-latest"] ?? "") ||
    inputs.jdkfile
  ) {
    return null;
  }
  return {
    key: `java ${major}`,
    what: `Java ${major} (Temurin)`,
    fetch: async (toolCache, signal) => {
      const root = path.join(toolCache, "Java_Temurin-Hotspot_jdk");
      // Already there (a self-hosted runner's cache): setup-java will use it.
      if (existsSync(root) && readdirSync(root).some((v) => v.split(/[.+-]/)[0] === major && existsSync(path.join(root, v, `${arch}.complete`)))) return;
      const api = process.env.DIFFINERY_ADOPTIUM_API ?? "https://api.adoptium.net";
      const assets = await fetchJson<AdoptiumAsset[]>(`${api}/v3/assets/latest/${major}/hotspot?architecture=${arch === "arm64" ? "aarch64" : arch}&image_type=jdk&os=linux&vendor=eclipse`);
      const a = assets.find((x) => x.binary?.package?.link && x.version?.semver);
      if (!a) return;
      const dir = path.join(root, a.version.semver.replace("+", "-"), arch);
      if (!isCached(dir)) await extractUrl(a.binary.package.link, dir, { sha256: a.binary.package.checksum, signal });
    },
  };
}
