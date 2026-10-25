import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { errMsg, failure } from "../job.js";
import { maxSatisfying, parseVer, satisfies, truthyInput } from "../util.js";
import type { Builtin, BuiltinContext } from "./index.js";
import { fetchJson, installTarball, isCached, packageCache, probe, readVersionFile, rootLockHash, toolArch, toolDir } from "./tools.js";

interface NodeDistEntry {
  version: string; // "v22.11.0"
  lts: string | false;
  files: string[];
}

export function nodeMirror(): string {
  return (process.env.DIFFINERY_NODE_MIRROR ?? "https://nodejs.org/dist").replace(/\/$/, "");
}

/** Resolves a setup-node version spec against nodejs.org's index. */
export function resolveNodeVersion(index: NodeDistEntry[], spec: string): string | null {
  const s = spec.trim().toLowerCase();
  const arch = `linux-${toolArch("node")}`;
  const avail = index.filter((e) => e.files.includes(arch) || e.files.length === 0);
  if (s.startsWith("lts/")) {
    const code = s.slice(4);
    const lts = avail.filter((e) => e.lts && (code === "*" || String(e.lts).toLowerCase() === code));
    if (code.startsWith("-")) {
      // lts/-1: previous LTS line
      const n = Number(code.slice(1));
      const majors = [...new Set(avail.filter((e) => e.lts).map((e) => parseVer(e.version)![0]))].sort((a, b) => b - a);
      const major = majors[n];
      return major === undefined ? null : maxSatisfying(avail.filter((e) => e.lts).map((e) => e.version), String(major))?.replace(/^v/, "") ?? null;
    }
    return maxSatisfying(lts.map((e) => e.version), "*")?.replace(/^v/, "") ?? null;
  }
  if (s === "latest" || s === "current" || s === "node") return maxSatisfying(avail.map((e) => e.version), "*")?.replace(/^v/, "") ?? null;
  return maxSatisfying(avail.map((e) => e.version), s.replace(/^v/, ""))?.replace(/^v/, "") ?? null;
}

export const setupNode: Builtin = async (c) => {
  let spec = c.input("node-version");
  const file = c.input("node-version-file");
  if (!spec && file) spec = await readVersionFile(c, file, "node");
  const installed = (await probe(c, "node", ["--version"]))?.replace(/^v/, "") ?? null;
  let version = installed;

  if (spec) {
    const s = spec.trim().replace(/^v(?=\d)/, "");
    let ok = false;
    if (installed && !truthyInput(c.input("check-latest"), false)) {
      if (/^(lts\/|latest|current|node$)/i.test(s)) {
        try {
          const target = resolveNodeVersion(await fetchJson<NodeDistEntry[]>(`${nodeMirror()}/index.json`), s);
          ok = !!target && parseVer(target)![0] === parseVer(installed)![0];
        } catch (e) {
          c.warn(`Could not resolve '${s}' (${errMsg(e)}); using installed node ${installed}.`);
          ok = true;
        }
      } else {
        ok = satisfies(installed, s);
      }
    }
    if (ok) {
      c.log(`Found in cache @ ${installed} (pre-installed node satisfies '${s}')`);
    } else {
      let index: NodeDistEntry[];
      try {
        index = await fetchJson<NodeDistEntry[]>(`${nodeMirror()}/index.json`);
      } catch (e) {
        throw failure(`Unable to fetch the Node.js version index: ${errMsg(e)}`);
      }
      const v = resolveNodeVersion(index, s);
      if (!v) throw failure(`Unable to find Node version '${s}' for platform linux and architecture ${toolArch("node")}.`);
      const dir = toolDir(c, "node", v, toolArch("node"));
      if (!isCached(dir)) {
        await installTarball(c, `${nodeMirror()}/v${v}/node-v${v}-linux-${toolArch("node")}.tar.gz`, dir);
      } else c.log(`Found in cache @ ${dir}`);
      c.addPath(path.join(dir, "bin"));
      version = v;
    }
  } else {
    c.log(`No node-version specified; using the pre-installed node ${installed ?? "(none)"}.`);
  }
  if (version) c.setOutput("node-version", `v${version}`);

  const registry = c.input("registry-url");
  if (registry) await configureRegistry(c, registry);

  let pm = c.input("cache").toLowerCase();
  // setup-node v5+: caches npm automatically when package.json names npm as its package manager.
  if (!pm && major(c) >= 5 && truthyInput(c.input("package-manager-cache"), true) && packageJsonUsesNpm(c.job.workspace)) {
    c.log("Detected npm as the package manager from package.json's packageManager field. Auto caching has been enabled for npm. If you want to disable it, set package-manager-cache input to false");
    pm = "npm";
  }
  if (pm) {
    const env = c.toolEnv();
    let dir: string | null;
    let lockFiles: string[];
    if (pm === "npm") {
      dir = await probe(c, "npm", ["config", "get", "cache"], env);
      lockFiles = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock"];
    } else if (pm === "pnpm") {
      dir = await probe(c, "pnpm", ["store", "path", "--silent"], env);
      lockFiles = ["pnpm-lock.yaml"];
    } else if (pm === "yarn") {
      const ver = await probe(c, "yarn", ["--version"], env);
      dir = ver && parseVer(ver)![0] >= 2 ? await probe(c, "yarn", ["config", "get", "cacheFolder"], env) : await probe(c, "yarn", ["cache", "dir"], env);
      lockFiles = ["yarn.lock"];
    } else {
      throw failure(`Caching for '${pm}' is not supported`);
    }
    const hash = rootLockHash(c, c.input("cache-dependency-path"), lockFiles);
    if (!hash) throw failure("Some specified paths were not resolved, unable to cache dependencies.");
    const key = `node-cache-Linux-${toolArch("node")}-${pm}-${hash}`;
    c.setOutput("cache-primary-key", key);
    await packageCache(c, { key, paths: dir ? [dir] : [], what: pm });
  }
};

function major(c: { uses: string }): number {
  return Number(/@v?(\d+)/.exec(c.uses)?.[1] ?? 99);
}

function packageJsonUsesNpm(workspace: string): boolean {
  const npm = /^(\^)?npm(@.*)?$/;
  try {
    const pkg = JSON.parse(readFileSync(path.join(workspace, "package.json"), "utf8")) as { packageManager?: unknown; devEngines?: { packageManager?: unknown } };
    const dev = pkg.devEngines?.packageManager;
    for (const o of Array.isArray(dev) ? dev : dev ? [dev] : []) if (typeof (o as { name?: unknown })?.name === "string" && npm.test((o as { name: string }).name)) return true;
    return typeof pkg.packageManager === "string" && npm.test(pkg.packageManager);
  } catch {
    return false;
  }
}

/** setup-node's `registry-url`: an .npmrc in RUNNER_TEMP that reads NODE_AUTH_TOKEN. */
async function configureRegistry(c: BuiltinContext, registry: string): Promise<void> {
  const url = registry.endsWith("/") ? registry : `${registry}/`;
  let scope = c.input("scope");
  if (!scope && url.includes("npm.pkg.github.com")) scope = c.job.spec.repo.owner;
  if (scope && !scope.startsWith("@")) scope = `@${scope}`;
  const prefix = scope ? `${scope.toLowerCase()}:` : "";
  const npmrc = path.join(c.job.tempDir, ".npmrc");
  await mkdir(c.job.tempDir, { recursive: true });
  let contents = "";
  if (existsSync(npmrc)) {
    for (const line of (await readFile(npmrc, "utf8")).split("\n")) if (!line.toLowerCase().startsWith(`${prefix}registry`)) contents += `${line}\n`;
  }
  contents += `${url.replace(/^\w+:/, "")}:_authToken=\${NODE_AUTH_TOKEN}\n${prefix}registry=${url}`;
  const alwaysAuth = c.input("always-auth");
  if (major(c) < 5 || alwaysAuth) contents += `\nalways-auth=${alwaysAuth || "false"}`;
  await writeFile(npmrc, contents);
  c.exportVariable("NPM_CONFIG_USERCONFIG", npmrc);
  c.exportVariable("NODE_AUTH_TOKEN", c.toolEnv().NODE_AUTH_TOKEN || "XXXXX-XXXXX-XXXXX-XXXXX");
}
