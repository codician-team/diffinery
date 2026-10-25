import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startSandbox, type SandboxHandle } from "../src/sandbox.js";
import { startSandboxPool } from "../src/sandbox-pool.js";
import { tmp } from "./helpers.js";

const SECRET = "sandbox-secret-xyz";
const TOKEN = "job-token-abc-123";
let sb: SandboxHandle;
let workRoot: string;
let origin: string;
let base: string;

async function call(p: string, body?: unknown, auth = SECRET) {
  const res = await fetch(`${base}${p}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  workRoot = tmp("sandbox-");
  origin = tmp("sandbox-origin-");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: origin, env });
  writeFileSync(path.join(origin, "hello.txt"), "hello sandbox\n");
  execFileSync("git", ["add", "."], { cwd: origin, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: origin, env });
  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: origin, env });
  writeFileSync(path.join(origin, "feature.txt"), "on feature\n");
  execFileSync("git", ["add", "."], { cwd: origin, env });
  execFileSync("git", ["commit", "-q", "-m", "feat"], { cwd: origin, env });
  execFileSync("git", ["checkout", "-q", "main"], { cwd: origin, env });
  sb = await startSandbox({ port: 0, host: "127.0.0.1", secret: SECRET, workRoot, cloneUrl: `file://${origin}`, ref: "feature", token: TOKEN, maxOutputBytes: 1000 });
  base = `http://127.0.0.1:${sb.port}`;
  await sb.ready;
});

afterAll(async () => {
  await sb?.close();
  rmSync(workRoot, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
});

describe("sandbox server", () => {
  it("reports health without auth and rejects unauthenticated calls", async () => {
    const h = await fetch(`${base}/health`);
    expect(await h.json()).toEqual({ ok: true, ready: true });
    expect((await call("/exec", { cmd: "true" }, "wrong")).status).toBe(401);
    const noAuth = await fetch(`${base}/exec`, { method: "POST", body: "{}" });
    expect(noAuth.status).toBe(401);
  });

  it("cloned the repo at the requested ref", async () => {
    const r = await call("/exec", { cmd: "git rev-parse --abbrev-ref HEAD && cat hello.txt feature.txt" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ exitCode: 0, stdout: "feature\nhello sandbox\non feature\n", stderr: "" });
  });

  it("executes commands with cwd/env, masks secrets and truncates output", async () => {
    await call("/exec", { cmd: "mkdir -p sub" });
    const r = await call("/exec", { cmd: 'pwd; echo "v=$MYVAR"; echo "s=$DIFFINERY_SANDBOX_SECRET"; echo err >&2; echo "tok=' + TOKEN + '"; exit 3', cwd: "sub", env: { MYVAR: "x1" } });
    expect(r.json.exitCode).toBe(3);
    expect(r.json.stdout).toBe(`${path.join(sb.repoDir, "sub")}\nv=x1\ns=\ntok=***\n`);
    expect(r.json.stderr).toBe("err\n");
    const big = await call("/exec", { cmd: "head -c 5000 /dev/zero | tr '\\0' a" });
    expect(big.json.stdout.length).toBe(1000);
    expect(big.json.truncated).toBe(true);
  });

  it("times out long commands", async () => {
    const r = await call("/exec", { cmd: "sleep 20", timeoutMs: 300 });
    expect(r.json.timedOut).toBe(true);
    expect(r.json.exitCode).toBe(124);
  });

  it("reads and writes files (base64)", async () => {
    const content = Buffer.from("bin\0ary ✓").toString("base64");
    const w = await call("/files/write", { path: "new/dir/file.bin", content });
    expect(w.json).toMatchObject({ ok: true, size: Buffer.from("bin\0ary ✓").length });
    expect(readFileSync(path.join(sb.repoDir, "new/dir/file.bin"), "utf8")).toBe("bin\0ary ✓");
    const r = await call("/files/read", { path: "new/dir/file.bin" });
    expect(Buffer.from(r.json.content, "base64").toString()).toBe("bin\0ary ✓");
    expect((await call("/files/read", { path: "missing.txt" })).status).toBe(404);
    expect((await call("/files/read", {})).status).toBe(400);
    expect((await call("/nope", {})).status).toBe(404);
  });

  it("runs background processes: env, secret env masked, output from offsets, exit codes", async () => {
    // Built at run time so push protection never sees a key-shaped literal in this file.
    const KEY = ["sk", "ant", "api03", "secret-key-value"].join("-");
    const start = await call("/proc/start", { id: "run1", cmd: 'echo "a=$A"; echo "key=$MODEL_KEY"; echo oops >&2; sleep 0.3; echo done; exit 4', env: { A: "1" }, secretEnv: { MODEL_KEY: KEY } });
    expect(start.status).toBe(200);
    expect((await call("/proc/start", { id: "run1", cmd: "true" })).status).toBe(409);
    let out = "";
    let err = "";
    let so = 0;
    let se = 0;
    let r;
    for (;;) {
      r = await call("/proc/read", { id: "run1", stdoutOffset: so, stderrOffset: se });
      out += r.json.stdout;
      err += r.json.stderr;
      so = r.json.stdoutOffset;
      se = r.json.stderrOffset;
      if (!r.json.running) break;
      await new Promise((x) => setTimeout(x, 50));
    }
    expect(out).toBe("a=1\nkey=***\ndone\n");
    expect(err).toBe("oops\n");
    expect(r.json.exitCode).toBe(4);
    // The secret is masked everywhere from now on, and other commands don't get it in their environment.
    const ex = await call("/exec", { cmd: `echo ${KEY}; echo "env=$MODEL_KEY"` });
    expect(ex.json.stdout).toBe("***\nenv=\n");
    // A finished process can start again under the same id.
    expect((await call("/proc/start", { id: "run1", cmd: "echo again" })).status).toBe(200);
    expect((await call("/proc/read", { id: "missing" })).status).toBe(404);
    expect((await call("/proc/start", { id: "bad id!", cmd: "true" })).status).toBe(409);
  });

  it("kills a background process tree and times one out", async () => {
    await call("/proc/start", { id: "long", cmd: "sleep 30 & sleep 30; echo never" });
    expect((await call("/proc/kill", { id: "long" })).json.killed).toBe(true);
    let r;
    do r = await call("/proc/read", { id: "long" });
    while (r.json.running);
    expect(r.json.stdout).toBe("");
    await call("/proc/start", { id: "slow", cmd: "sleep 30", timeoutMs: 200 });
    do r = await call("/proc/read", { id: "slow" });
    while (r.json.running);
    expect(r.json).toMatchObject({ exitCode: 124, timedOut: true });
  });
});

describe("sandbox pool", () => {
  it("boots sandboxes on demand and routes calls to each by id", async () => {
    const pool = await startSandboxPool({ port: 0, secret: "pool-secret", workRoot: tmp("pool-") });
    const p = `http://127.0.0.1:${pool.port}`;
    const boot = (auth: string) => fetch(`${p}/boot`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify({ id: "sb1", secret: "s1", env: { DIFFINERY_CLONE_URL: `file://${origin}`, DIFFINERY_REF: "main", FOO: "bar" } }) });
    expect((await boot("wrong")).status).toBe(401);
    expect((await boot("pool-secret")).status).toBe(200);
    const exec = (auth: string) => fetch(`${p}/s/sb1/exec`, { method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify({ cmd: 'cat hello.txt; echo "$FOO"' }) });
    expect((await exec("wrong")).status).toBe(401);
    expect(await (await exec("s1")).json()).toMatchObject({ exitCode: 0, stdout: "hello sandbox\nbar\n" });
    expect((await fetch(`${p}/s/nope/exec`, { method: "POST" })).status).toBe(404);
    await pool.close();
  });
});


/** A terminal connection that collects the screen output. */
async function term(url: string, auth = SECRET) {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${auth}` } });
  let out = "";
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (code, reason) => r({ code, reason: String(reason) })));
  ws.on("message", (d, binary) => {
    if (binary) out += String(d);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once("error", reject);
  });
  const until = async (re: RegExp, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!re.test(out)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${re} in ${JSON.stringify(out.slice(-500))}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { ws, out: () => out, until, closed, type: (s: string) => ws.send(Buffer.from(s)), control: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe("sandbox terminal", () => {
  it("runs one shell on a PTY in the checkout, resizes it, and redraws it for the next tab", async () => {
    const ws = base.replace("http", "ws");
    await expect(term(`${ws}/pty`, "wrong")).rejects.toThrow(/401/);
    expect((await call("/pty/status", {})).json).toMatchObject({ attached: false, running: false });
    const a = await term(`${ws}/pty?cols=100&rows=30`);
    a.type("tty; stty size; pwd; echo \"s=[$DIFFINERY_SANDBOX_SECRET] t=[$DIFFINERY_JOB_TOKEN] ci=[$CI]\"; echo mark-$((40+2))\n");
    await a.until(/mark-42/);
    expect(a.out()).toMatch(/\/dev\/pts\/\d+/);
    expect(a.out()).toContain("30 100");
    expect(a.out()).toContain(sb.repoDir);
    expect(a.out()).toContain("s=[] t=[] ci=[]");
    a.control({ type: "resize", cols: 132, rows: 43 });
    a.type("stty size\n");
    await a.until(/43 132/);
    expect((await call("/pty/status", {})).json).toMatchObject({ attached: true, running: true, idleSince: null });

    // A second tab takes over the same shell and gets the recent output; the first is told why it closed.
    a.type("export KEPT=yes\n");
    const b = await term(`${ws}/pty?cols=80&rows=24`);
    expect((await a.closed).code).toBe(4000);
    await b.until(/mark-42/);
    b.type("echo kept=$KEPT\n");
    await b.until(/kept=yes/);
    b.ws.close();
    await b.closed;
    await new Promise((r) => setTimeout(r, 100));
    const idle = (await call("/pty/status", {})).json;
    expect(idle).toMatchObject({ attached: false, running: true });
    expect(Date.parse(idle.idleSince)).toBeGreaterThan(Date.now() - 5000);

    // Exiting the shell closes the connection; the next attach starts a fresh one.
    const c = await term(`${ws}/pty`);
    c.type("exit\n");
    expect((await c.closed).reason).toBe("the shell exited");
    const d = await term(`${ws}/pty`);
    d.type("echo fresh=${KEPT:-none}\n");
    await d.until(/fresh=none/);
    await call("/pty/kill", {});
    expect((await d.closed).reason).toBe("terminal ended");
  });

  it("reaches a pooled sandbox's terminal through the pool", { timeout: 20_000 }, async () => {
    const pool = await startSandboxPool({ port: 0, secret: "pool-secret", workRoot: tmp("pool-") });
    const p = `127.0.0.1:${pool.port}`;
    await fetch(`http://${p}/boot`, { method: "POST", headers: { authorization: "Bearer pool-secret" }, body: JSON.stringify({ id: "sb2", secret: "s2", env: { DIFFINERY_CLONE_URL: `file://${origin}`, DIFFINERY_REF: "main" } }) });
    await expect(term(`ws://${p}/s/sb2/pty`, "wrong")).rejects.toThrow(/401/);
    await expect(term(`ws://${p}/s/nope/pty`, "s2")).rejects.toThrow(/404/);
    const t = await term(`ws://${p}/s/sb2/pty?cols=90&rows=20`, "s2");
    t.type("cat hello.txt; stty size\n");
    await t.until(/20 90/);
    expect(t.out()).toContain("hello sandbox");
    t.ws.close();
    await t.closed;
    await pool.close();
  });
});
