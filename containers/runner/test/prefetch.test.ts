import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import type { StepSpec } from "@diffinery/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiBaseFor, runAgentJob } from "../src/agent.js";
import type { JobRunner } from "../src/job.js";
import { ToolPrefetch } from "../src/prefetch.js";
import { makeSpec, startFakeApi, tmp, type FakeApi } from "./helpers.js";

// The toolchain head start (src/prefetch.ts), against a stand-in for go.dev and the Adoptium API.

let api: FakeApi;
let dir: string;
let server: Server;
let base: string;
/** Paths the stand-in served, with when each was asked for. */
let served: Array<{ path: string; at: number }>;
let files: Map<string, { body: Buffer; delayMs?: number }>;
const saved = { ...process.env };

/** A .tar.gz of `entries` (relative path -> shell script) under one top-level folder. */
function tarball(top: string, entries: Record<string, string>): Buffer {
  const src = path.join(dir, `src-${top}`);
  for (const [rel, body] of Object.entries(entries)) {
    const f = path.join(src, top, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
    chmodSync(f, 0o755);
  }
  const out = path.join(dir, `${top}.tar.gz`);
  expect(spawnSync("tar", ["-czf", out, "-C", src, top]).status).toBe(0);
  return readFileSync(out);
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function goRelease(version: string, body: Buffer, sum = sha(body)) {
  files.set(`/dl/go${version}.linux-amd64.tar.gz`, { body, delayMs: 1500 });
  return { version: `go${version}`, stable: true, files: [{ filename: `go${version}.linux-amd64.tar.gz`, os: "linux", arch: "amd64", kind: "archive", sha256: sum }] };
}

beforeEach(async () => {
  api = await startFakeApi();
  dir = tmp("prefetch-");
  served = [];
  files = new Map();
  server = createServer((req, res) => {
    const p = (req.url ?? "").split("?")[0]!;
    served.push({ path: p, at: Date.now() });
    const f = files.get(p);
    if (!f) {
      res.writeHead(404).end();
      return;
    }
    setTimeout(() => res.writeHead(200).end(f.body), f.delayMs ?? 0);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.DIFFINERY_GO_INDEX = `${base}/dl/index.json`;
  process.env.DIFFINERY_GO_DL = `${base}/dl/`;
  process.env.DIFFINERY_ADOPTIUM_API = `${base}/adoptium`;
});
afterEach(async () => {
  process.env = { ...saved };
  await api.close();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.arch !== "x64")("toolchain head start", () => {
  it("installs Go while the job's first steps run, and setup-go uses it", async () => {
    const go = tarball("go", { "bin/go": `#!/bin/sh\ncase "$1" in version) echo "go version go1.99.1 linux/amd64" ;; env) echo "${dir}/gopath" ;; esac\n` });
    files.set("/dl/index.json", { body: Buffer.from(JSON.stringify([goRelease("1.99.1", go), goRelease("1.98.4", go)])) });
    const steps: StepSpec[] = [
      { name: "checkout stand-in", run: "sleep 1.5" },
      { uses: "actions/setup-go@v5", with: { "go-version": "${{ matrix.go }}", cache: "false" } },
      { run: "go version" },
    ];
    const spec = makeSpec(api, steps, { matrix: { go: "1.99" } });
    const started = Date.now();
    const done = await runAgentJob(spec, {
      apiBase: apiBaseFor(spec.apiUrl, spec.jobId),
      workRoot: path.join(dir, "work"),
      toolCache: path.join(dir, "tool"),
      logIntervalMs: 50,
      echoLogs: false,
      prefetchTools: true,
      baseEnv: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    expect(done.conclusion, api.logText()).toBe("success");
    expect(api.logText()).toContain("go version go1.99.1 linux/amd64");
    expect(api.logText()).toContain("Found in cache @");
    // One download, asked for as the job began (before the first step's 1.5 s were up), not by the step.
    const downloads = served.filter((s) => s.path.endsWith(".tar.gz"));
    expect(downloads.map((s) => s.path)).toEqual(["/dl/go1.99.1.linux-amd64.tar.gz"]);
    expect(downloads[0]!.at - started).toBeLessThan(1000);
    expect(existsSync(path.join(dir, "tool", "go", "1.99.1", "amd64.complete"))).toBe(true);
  }, 30_000);

  it("leaves nothing behind when a download doesn't match its published checksum", async () => {
    const go = tarball("go", { "bin/go": "#!/bin/sh\necho go\n" });
    files.set("/dl/index.json", { body: Buffer.from(JSON.stringify([goRelease("1.99.1", go, "0".repeat(64))])) });
    const tool = path.join(dir, "tool");
    const p = new ToolPrefetch({ toolCache: tool, signal: new AbortController().signal } as unknown as JobRunner);
    p.start(makeSpec(api, [{ uses: "actions/setup-go@v5", with: { "go-version": "1.99" } }]));
    const lines: string[] = [];
    await p.wait(0, (m) => lines.push(m));
    expect(lines).toEqual(["Waiting for Go 1.99, which the runner started installing as the job began"]);
    // It was tried three times; none of it was kept.
    expect(served.filter((s) => s.path.endsWith(".tar.gz"))).toHaveLength(3);
    expect(readdirSync(path.join(tool, "go", "1.99.1"))).toEqual([]);
  }, 30_000);

  it("lays a Temurin JDK out in the tool cache the way setup-java caches one", async () => {
    const jdk = tarball("jdk-21.0.5+11", { "bin/java": "#!/bin/sh\necho java\n", release: 'JAVA_VERSION="21.0.5"\n' });
    files.set("/adoptium/v3/assets/latest/21/hotspot", {
      body: Buffer.from(JSON.stringify([{ binary: { package: { link: `${base}/jdk.tar.gz`, checksum: sha(jdk) } }, version: { semver: "21.0.5+11.0.LTS" } }])),
    });
    files.set("/jdk.tar.gz", { body: jdk, delayMs: 200 });
    const tool = path.join(dir, "tool");
    const p = new ToolPrefetch({ toolCache: tool, signal: new AbortController().signal } as unknown as JobRunner);
    p.start(makeSpec(api, [{ run: "true" }, { uses: "actions/setup-java@v4", with: { distribution: "temurin", "java-version": "21", cache: "maven" } }]));
    await p.wait(0, () => {});
    await p.wait(1, () => {});
    const home = path.join(tool, "Java_Temurin-Hotspot_jdk", "21.0.5-11.0.LTS", "x64");
    expect(readFileSync(path.join(home, "release"), "utf8")).toContain("21.0.5");
    expect(existsSync(path.join(home, "bin", "java"))).toBe(true);
    expect(existsSync(`${home}.complete`)).toBe(true);
    expect(readdirSync(path.dirname(home))).toEqual(["x64", "x64.complete"]);

    // A second job on the same machine finds it there and downloads nothing.
    served = [];
    const again = new ToolPrefetch({ toolCache: tool, signal: new AbortController().signal } as unknown as JobRunner);
    again.start(makeSpec(api, [{ uses: "actions/setup-java@v4", with: { distribution: "temurin", "java-version": "21" } }]));
    await again.wait(0, () => {});
    expect(served).toEqual([]);
  }, 30_000);

  it("does nothing for jobs without a toolchain it can name", async () => {
    const tool = path.join(dir, "tool");
    const steps: StepSpec[] = [
      { run: "go version" },
      { uses: "actions/setup-java@v4", with: { distribution: "zulu", "java-version": "21" } },
      { uses: "actions/setup-java@v4", with: { distribution: "temurin", "java-version": "${{ steps.v.outputs.java }}" } },
      { uses: "actions/setup-java@v4", with: { distribution: "temurin", "java-version": "21", "java-package": "jre" } },
      { uses: "actions/setup-go@v5", with: { "go-version-file": "go.mod" } },
      { uses: "actions/setup-go@v2", with: { "go-version": "1.22" } },
      { uses: "actions/setup-node@v4", with: { "node-version": "22" } },
    ];
    const p = new ToolPrefetch({ toolCache: tool, signal: new AbortController().signal } as unknown as JobRunner);
    p.start(makeSpec(api, steps));
    p.start(makeSpec(api, [{ uses: "actions/setup-go@v5", with: { "go-version": "1.22" } }], { container: { image: "golang:1.22" } }));
    for (let i = 0; i < steps.length; i++) await p.wait(i, () => {});
    await p.stop();
    expect(served).toEqual([]);
  });
});
