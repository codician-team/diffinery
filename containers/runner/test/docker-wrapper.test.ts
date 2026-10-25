import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiBaseFor, runAgentJob } from "../src/agent.js";
import { makeSpec, startFakeApi, tmp, type FakeApi } from "./helpers.js";

// The hosted runner image's docker wrapper (image/docker), run as it is apart from its fixed paths,
// against a stand-in daemon that takes a moment to come up and then keeps running, like dockerd.
const WRAPPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../image/docker");
const tools = ["flock", "setsid", "openssl"].every((t) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0);

let api: FakeApi;
let dir: string;
let relayPort: number;

/**
 * Writes the wrapper to `dir/bin/docker`, with its paths moved into `dir`, and the stand-ins next to it:
 * a daemon that answers `daemonMs` after it starts, and a registry relay that listens `relayMs` after it
 * starts (or never, when null). Each notes when it started and when it came up in `dir/events`.
 */
function install({ daemonMs = 1000, relayMs = 1000 as number | null } = {}): string {
  const bin = path.join(dir, "bin");
  const sh = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  spawnSync("mkdir", ["-p", bin, path.join(dir, "log")]);
  let script = readFileSync(WRAPPER, "utf8");
  const moves: Array<[string, string]> = [
    ["real=/usr/bin/docker", `real=${bin}/docker-real`],
    ["ready=/run/diffinery-dockerd.ready", `ready=${dir}/dockerd.ready`],
    ["state=/run/diffinery\n", `state=${dir}/state\n`],
    ["/run/diffinery-dockerd.lock", `${dir}/dockerd.lock`],
    ["/var/log/", `${dir}/log/`],
    ["sys_path=/usr/local/sbin:", `sys_path=${bin}:/usr/local/sbin:`],
    ["relay_port=3129", `relay_port=${relayPort}`],
    ["/etc/docker/certs.d/", `${dir}/certs.d/`],
    ["/opt/diffinery/agent.mjs", `${dir}/relay.mjs`],
    ['"$(id -u)" = 0', "0 = 0"],
  ];
  for (const [from, to] of moves) {
    expect(script, `the wrapper no longer has ${JSON.stringify(from)}`).toContain(from);
    script = script.split(from).join(to);
  }
  writeFileSync(path.join(bin, "docker"), script);
  chmodSync(path.join(bin, "docker"), 0o755);
  // The daemon answers after a moment and keeps running (holding whatever it inherited). It notes
  // the proxy it was started with.
  sh("dockerd", `echo $$ >> ${dir}/dockerd.pids\necho "\${HTTPS_PROXY:-none}" >> ${dir}/dockerd.proxy\necho dockerd-started >> ${dir}/events\nsleep ${daemonMs / 1000}\ntouch ${dir}/dockerd.up\necho dockerd-up >> ${dir}/events\nexec sleep 60`);
  sh("docker-real", `[ -e ${dir}/dockerd.up ] || exit 1\necho "docker $*"`);
  sh("node", `exec ${process.execPath} "$@"`);
  writeFileSync(
    path.join(dir, "relay.mjs"),
    relayMs === null
      ? `process.exit(1);\n`
      : `import { appendFileSync } from "node:fs";\nimport { createServer } from "node:net";\nappendFileSync(${JSON.stringify(`${dir}/dockerd.pids`)}, process.pid + "\\n");\nappendFileSync(${JSON.stringify(`${dir}/events`)}, "relay-started\\n");\nsetTimeout(() => createServer((s) => s.end()).listen(Number(process.env.DIFFINERY_RELAY_PORT), "127.0.0.1", () => appendFileSync(${JSON.stringify(`${dir}/events`)}, "relay-up\\n")), ${relayMs});\n`,
  );
  return bin;
}

/** Whether process `pid` is running: it exists and isn't a zombie. */
function running(pid: string): boolean {
  try {
    return !/^\S+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

beforeEach(async () => {
  api = await startFakeApi();
  dir = tmp("docker-wrapper-");
  relayPort = await new Promise<number>((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
});
afterEach(async () => {
  await api.close();
  // Stand-in daemons started with setsid outlive the job, like the real one.
  const pids = path.join(dir, "dockerd.pids");
  if (existsSync(pids)) spawnSync("kill", readFileSync(pids, "utf8").split("\n").filter(Boolean));
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!tools)("docker wrapper", () => {
  it("lets docker commands that arrive while the daemon is starting through, with the head start on", async () => {
    const bin = install();
    // The head start runs `docker version` as the job begins; the step's commands arrive while it is
    // still starting the daemon, and must not wait on its lock for good.
    const spec = makeSpec(api, [{ run: "docker info & docker ps & wait\ndocker version" }], { timeoutMinutes: 1 });
    const started = Date.now();
    const done = await runAgentJob(spec, {
      apiBase: apiBaseFor(spec.apiUrl, spec.jobId),
      workRoot: path.join(dir, "work"),
      toolCache: path.join(dir, "tool"),
      logIntervalMs: 50,
      echoLogs: false,
      prewarmDocker: true,
      baseEnv: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(done.conclusion, api.logText()).toBe("success");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(api.logText()).toContain("docker info");
    expect(api.logText()).toContain("docker ps");
    expect(api.logText()).toContain("docker version");
    expect(readFileSync(path.join(dir, "log", "dockerd.log"), "utf8")).toBe("");
  }, 30_000);

  it("gives up with a message, not a hang, when the daemon never comes up", () => {
    const bin = install();
    writeFileSync(path.join(bin, "dockerd"), `#!/bin/bash\necho $$ >> ${dir}/dockerd.pids\necho "failed to start daemon: no cgroups" >&2\nexec sleep 60\n`);
    // Shorten the waits for the test: the start loop and the lock wait.
    const script = readFileSync(path.join(bin, "docker"), "utf8").replace("seq 1 600", "seq 1 10").replace("flock -w 150 9", "flock -w 2 9");
    writeFileSync(path.join(bin, "docker"), script);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const r = spawnSync("bash", ["-c", "docker version & sleep 0.2; docker info; echo \"second exited $?\"; wait"], { env, encoding: "utf8", timeout: 20_000 });
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain("second exited 1");
    expect(r.stderr).toContain("The Docker daemon did not start");
    expect(r.stderr).toContain("failed to start daemon: no cgroups");
  }, 30_000);

  it("starts the registry relay and the daemon together", () => {
    // Two seconds each to come up.
    const bin = install({ daemonMs: 2000, relayMs: 2000 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DIFFINERY_API_URL: "https://diffinery.test/api" };
    const r = spawnSync("bash", ["-c", "docker version"], { env, encoding: "utf8", timeout: 20_000 });
    expect(r.status, r.stderr).toBe(0);
    // Together: each started before the other came up (one after the other, one would come up first).
    // Order, not elapsed time, so a slow host doesn't change the verdict.
    const events = readFileSync(path.join(dir, "events"), "utf8").split("\n").filter(Boolean);
    expect(events.indexOf("dockerd-started"), events.join(", ")).toBeLessThan(events.indexOf("relay-up"));
    expect(events.indexOf("relay-started"), events.join(", ")).toBeLessThan(events.indexOf("dockerd-up"));
    expect(r.stderr).not.toContain("relay did not start");
    expect(readFileSync(path.join(dir, "dockerd.proxy"), "utf8")).toBe(`http://127.0.0.1:${relayPort}\n`);
    expect(readFileSync(path.join(dir, "state", "relay.host"), "utf8")).toBe("diffinery.test\n");
    expect(existsSync(path.join(dir, "certs.d", "diffinery.test", "ca.crt"))).toBe(true);
  }, 30_000);

  it("starts the daemon again without the relay when the relay never comes up", () => {
    const bin = install({ relayMs: null });
    // Shorten the relay wait for the test.
    const script = readFileSync(path.join(bin, "docker"), "utf8").replace("seq 1 400", "seq 1 10");
    writeFileSync(path.join(bin, "docker"), script);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DIFFINERY_API_URL: "https://diffinery.test/api" };
    const r = spawnSync("bash", ["-c", "docker version"], { env, encoding: "utf8", timeout: 20_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("docker version");
    expect(r.stderr).toContain("The registry relay did not start");
    expect(readFileSync(path.join(dir, "dockerd.proxy"), "utf8")).toBe(`http://127.0.0.1:${relayPort}\nnone\n`);
    const [first, second] = readFileSync(path.join(dir, "dockerd.pids"), "utf8").split("\n").filter(Boolean);
    // Gone (or a zombie: nothing may reap it in a container), while the new one runs.
    expect(running(first!)).toBe(false);
    expect(running(second!)).toBe(true);
    expect(existsSync(path.join(dir, "state", "relay.host"))).toBe(false);
  }, 30_000);
});
