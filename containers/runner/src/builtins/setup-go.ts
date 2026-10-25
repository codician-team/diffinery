import path from "node:path";
import { errMsg, failure } from "../job.js";
import { maxSatisfying, satisfies, truthyInput } from "../util.js";
import type { Builtin } from "./index.js";
import { fetchJson, installTarball, isCached, packageCache, probe, readVersionFile, rootLockHash, toolArch, toolDir } from "./tools.js";

interface GoRelease {
  version: string; // "go1.22.3"
  stable: boolean;
  files: Array<{ filename: string; os: string; arch: string; kind: string; sha256?: string }>;
}

let index: { url: string; at: number; releases: Promise<GoRelease[]> } | null = null;

/** Go's releases index, fetched at most every 10 minutes: the job's head start (prefetch.ts) and the step share it. */
function goReleases(): Promise<GoRelease[]> {
  const url = process.env.DIFFINERY_GO_INDEX ?? "https://go.dev/dl/?mode=json&include=all";
  if (!index || index.url !== url || Date.now() - index.at > 10 * 60_000) {
    const releases = fetchJson<GoRelease[]>(url);
    index = { url, at: Date.now(), releases };
    releases.catch(() => {
      if (index?.releases === releases) index = null;
    });
  }
  return index.releases;
}

/** The stable Go release `spec` asks for ("1.22", "1.22.3", "stable", "oldstable", a range), as setup-go picks it. */
export async function resolveGo(spec: string): Promise<{ version: string; url: string; sha256?: string } | null> {
  const releases = await goReleases();
  const arch = toolArch("go");
  const stable = releases.filter((r) => r.stable && r.files.some((f) => f.os === "linux" && f.arch === arch && f.kind === "archive"));
  let v: string | null;
  if (spec === "stable") v = maxSatisfying(stable.map((r) => r.version.replace(/^go/, "")), "*");
  else if (spec === "oldstable") {
    const sorted = stable.map((r) => r.version.replace(/^go/, ""));
    const latest = maxSatisfying(sorted, "*");
    const latestMinor = latest ? latest.split(".").slice(0, 2).join(".") : "";
    v = maxSatisfying(sorted.filter((x) => !x.startsWith(latestMinor + ".") && x !== latestMinor), "*");
  } else v = maxSatisfying(stable.map((r) => r.version.replace(/^go/, "")), spec);
  if (!v) return null;
  const rel = stable.find((r) => r.version === `go${v}`)!;
  const f = rel.files.find((x) => x.os === "linux" && x.arch === arch && x.kind === "archive")!;
  return { version: v, url: `${process.env.DIFFINERY_GO_DL ?? "https://go.dev/dl/"}${f.filename}`, sha256: f.sha256 };
}

export const setupGo: Builtin = async (c) => {
  let spec = c.input("go-version");
  const file = c.input("go-version-file");
  if (!spec && file) spec = await readVersionFile(c, file, "go");
  spec = spec.trim().replace(/^go/, "");
  const installedRaw = await probe(c, "go", ["version"]);
  const installed = /go(\d+\.\d+(?:\.\d+)?)/.exec(installedRaw ?? "")?.[1] ?? null;
  let version = installed;

  if (!spec && !installed) throw failure("No go-version specified and Go is not installed on this runner.");
  const useInstalled = installed && (!spec || (!/^(stable|oldstable)$/.test(spec) && satisfies(installed, spec))) && !truthyInput(c.input("check-latest"), false);
  if (useInstalled) {
    c.log(`Using pre-installed Go ${installed}`);
  } else {
    let rel: Awaited<ReturnType<typeof resolveGo>>;
    try {
      rel = await resolveGo(spec);
    } catch (e) {
      throw failure(`Unable to fetch the Go versions index: ${errMsg(e)}`);
    }
    const arch = toolArch("go");
    if (!rel) throw failure(`Unable to find Go version '${spec}' for platform linux and architecture ${arch}.`);
    const v = rel.version;
    const dir = toolDir(c, "go", v, arch);
    if (!isCached(dir)) await installTarball(c, rel.url, dir, 1, rel.sha256);
    else c.log(`Found in cache @ ${dir}`);
    c.addPath(path.join(dir, "bin"));
    version = v;
  }
  const gopath = await probe(c, "go", ["env", "GOPATH"], c.toolEnv());
  if (gopath) c.addPath(path.join(gopath, "bin"));
  if (version) c.setOutput("go-version", version);

  if (truthyInput(c.input("cache"), true)) {
    let hash: string;
    try {
      hash = rootLockHash(c, c.input("cache-dependency-path"), ["go.sum"]);
      if (!hash) throw failure("Some specified paths were not resolved, unable to cache dependencies.");
    } catch (e) {
      c.warn(`Restore cache failed: ${errMsg(e)}`);
      return;
    }
    const env = c.toolEnv();
    const modcache = await probe(c, "go", ["env", "GOMODCACHE"], env);
    const buildcache = await probe(c, "go", ["env", "GOCACHE"], env);
    const imageOs = env.ImageOS ?? "ubuntu24";
    await packageCache(c, {
      key: `setup-go-Linux-${process.arch}-${imageOs}-go-${version}-${hash}`,
      paths: [modcache ?? "", buildcache ?? ""].filter(Boolean),
      what: "go",
    });
  }
};
