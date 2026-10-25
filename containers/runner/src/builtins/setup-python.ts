import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { errMsg, failure } from "../job.js";
import { hashFiles, inputList, maxSatisfying, satisfies, truthyInput, which } from "../util.js";
import type { Builtin, BuiltinContext } from "./index.js";
import { fetchJson, fetchToFile, packageCache, probe, readVersionFile, toolArch } from "./tools.js";

interface PyManifestEntry {
  version: string;
  stable: boolean;
  files: Array<{ filename: string; arch: string; platform: string; platform_version?: string; download_url: string }>;
}

const MANIFEST = "https://raw.githubusercontent.com/actions/python-versions/main/versions-manifest.json";

export const setupPython: Builtin = async (c) => {
  let spec = c.input("python-version");
  const file = c.input("python-version-file");
  if (!spec && file) spec = await readVersionFile(c, file, "python");
  if (!spec && existsSync(path.join(c.job.workspace, ".python-version"))) spec = await readVersionFile(c, ".python-version", "python");
  spec = spec.trim();
  if (/^pypy|graalpy/i.test(spec)) throw failure(`'${spec}' is not supported by the Diffinery setup-python built-in.`);
  const env = c.toolEnv();
  const installedRaw = await probe(c, "python3", ["--version"], env);
  const installed = installedRaw?.replace(/^Python\s+/, "") ?? null;

  let binDir: string;
  let version: string;
  const want = spec.replace(/-dev$/, "").replace(/\.x$/, "");
  if (installed && (!spec || satisfies(installed, want))) {
    c.log(`Using pre-installed Python ${installed}`);
    const py3 = which("python3", env.PATH)!;
    binDir = path.dirname(realpathSync(py3));
    version = installed;
    // make sure `python`/`pip` resolve to python3
    if (!which("python", env.PATH) || !which("pip", env.PATH)) {
      const shim = path.join(c.job.tempDir, "_python_shim");
      await mkdir(shim, { recursive: true });
      for (const [n, t] of [["python", "python3"], ["pip", "pip3"]] as const) {
        const target = which(t, env.PATH);
        const link = path.join(shim, n);
        if (target && !existsSync(link)) await symlink(target, link).catch(() => {});
      }
      c.addPath(shim);
    }
  } else {
    let manifest: PyManifestEntry[];
    try {
      manifest = await fetchJson<PyManifestEntry[]>(process.env.DIFFINERY_PYTHON_MANIFEST ?? MANIFEST);
    } catch (e) {
      throw failure(`Unable to fetch the Python versions manifest: ${errMsg(e)}`);
    }
    const arch = toolArch("python");
    const candidates = manifest.filter((m) => m.files.some((f) => f.platform === "linux" && f.arch === arch));
    let v = maxSatisfying(candidates.filter((m) => m.stable).map((m) => m.version), want);
    // allow-prereleases (and `-dev` specs) fall back to pre-release builds when no stable one matches.
    if (!v && (truthyInput(c.input("allow-prereleases"), false) || spec.endsWith("-dev"))) v = maxSatisfying(candidates.map((m) => m.version), want);
    if (!v) throw failure(`The version '${spec}' with architecture '${arch}' was not found for this operating system.`);
    const entry = candidates.find((m) => m.version === v)!;
    const files = entry.files.filter((f) => f.platform === "linux" && f.arch === arch);
    const f = files.find((x) => x.platform_version === "24.04") ?? files.find((x) => x.platform_version === "22.04") ?? files[0]!;
    const installDir = path.join(c.job.toolCache, "Python", v, arch);
    if (!existsSync(`${installDir}.complete`)) {
      const work = path.join(c.job.tempDir, `python-${randomUUID()}`);
      await mkdir(work, { recursive: true });
      try {
        c.log(`Downloading ${f.download_url}`);
        const tarball = path.join(work, "python.tar.gz");
        await fetchToFile(f.download_url, tarball);
        await c.run("tar", ["-xzf", tarball, "-C", work], { silent: true });
        c.log("Running python installer (setup.sh)");
        await c.run("bash", ["./setup.sh"], { cwd: work, env: c.toolEnv({ RUNNER_TOOL_CACHE: c.job.toolCache, AGENT_TOOLSDIRECTORY: c.job.toolCache }) });
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
    binDir = path.join(installDir, "bin");
    version = v;
    c.addPath(installDir);
    c.addPath(binDir);
    c.exportVariable("pythonLocation", installDir);
    c.exportVariable("Python_ROOT_DIR", installDir);
    c.exportVariable("Python3_ROOT_DIR", installDir);
    c.exportVariable("PKG_CONFIG_PATH", path.join(installDir, "lib", "pkgconfig"));
    c.exportVariable("LD_LIBRARY_PATH", [path.join(installDir, "lib"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"));
  }
  c.setOutput("python-version", version);
  c.setOutput("python-path", path.join(binDir, existsSync(path.join(binDir, "python")) ? "python" : "python3"));

  const cache = c.input("cache").toLowerCase();
  if (cache) {
    const ws = c.job.workspace;
    const arch = process.arch;
    const deps = c.input("cache-dependency-path");
    if (cache === "pip") {
      const hash = hashFiles(ws, inputList(deps || "**/requirements.txt")) || hashFiles(ws, ["**/pyproject.toml"]);
      if (!hash) throw failure(`No file in ${ws} matched to [${inputList(deps || "**/requirements.txt").join(",")} or **/pyproject.toml], make sure you have checked out the target repository`);
      let dir = await probe(c, "pip", ["cache", "dir"], c.toolEnv());
      if (dir?.includes("~")) dir = path.join(homedir(), dir.slice(dir.indexOf("~") + 1));
      const os = await linuxInfo(c);
      const prefix = `setup-python-Linux-${arch}-${os.version}-${os.name}-python-${version}-pip`;
      await packageCache(c, { key: `${prefix}-${hash}`, restoreKeys: [prefix], paths: dir ? [dir] : [], what: "pip" });
    } else if (cache === "pipenv") {
      const hash = hashFiles(ws, inputList(deps || "**/Pipfile.lock"));
      if (!hash) throw failure(`No file in ${ws} matched to [${inputList(deps || "**/Pipfile.lock").join(",")}], make sure you have checked out the target repository`);
      await packageCache(c, { key: `setup-python-Linux-${arch}-python-${version}-pipenv-${hash}`, paths: [path.join(homedir(), ".local/share/virtualenvs")], what: "pipenv" });
    } else {
      throw failure(`Caching for '${cache}' is not supported`);
    }
  }
};

/** setup-python's `lsb_release -i -r -s` (falls back to /etc/os-release). */
async function linuxInfo(c: BuiltinContext): Promise<{ name: string; version: string }> {
  const out = await probe(c, "lsb_release", ["-i", "-r", "-s"]);
  if (out) {
    const [name, version] = out.split("\n").map((s) => s.trim());
    if (name && version) return { name, version };
  }
  try {
    const rel = readFileSync("/etc/os-release", "utf8");
    const get = (k: string) => new RegExp(`^${k}="?([^"\n]*)"?`, "m").exec(rel)?.[1] ?? "";
    return { name: get("NAME").split(" ")[0] || "Linux", version: get("VERSION_ID") };
  } catch {
    return { name: "Linux", version: "" };
  }
}
