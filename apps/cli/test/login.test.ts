import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, writeConfig } from "../src/config.js";
import { fakeServer, isolatedEnv, run, tempDir, type FakeServer } from "./helpers.js";

/** The CLI's side of signing in through the browser; the server's side is tested in apps/diffinery. */
describe("diffinery login in the browser", () => {
  let srv: FakeServer;
  beforeEach(async () => {
    srv = await fakeServer();
    srv.on("GET", "/api/v3/user", (r) => (r.headers.authorization === "Bearer dfy_from_browser" ? { body: { login: "alice", type: "User" } } : { status: 401, body: { message: "bad credentials" } }));
  });
  afterEach(() => srv.close());

  /** A browser that approves: Diffinery redirects to the CLI's callback with a code and the state it was given. */
  const approvingBrowser = (seen: { authorize?: URL; landing?: string }) => async (url: string) => {
    const u = new URL(url);
    seen.authorize = u;
    const callback = `http://127.0.0.1:${u.searchParams.get("port")}/callback?code=the-code&state=${u.searchParams.get("state")}`;
    // A stray request with the wrong state is ignored, and the real one still works afterwards.
    expect((await fetch(callback.replace(/state=[^&]+/, "state=forged"), { redirect: "manual" })).status).toBe(400);
    const res = await fetch(callback, { redirect: "manual" });
    seen.landing = res.headers.get("location") ?? "";
    return true;
  };

  it("opens the authorize page with a PKCE challenge, trades the code with the verifier, and saves the token", async () => {
    let verifier = "";
    srv.on("POST", "/-/cli/token", (r) => {
      const b = r.body as Record<string, string>;
      verifier = b.code_verifier!;
      return b.grant_type === "authorization_code" && b.code === "the-code" ? { body: { access_token: "dfy_from_browser", token_type: "bearer", scope: "write", expires_at: "2027-01-12T00:00:00Z", login: "alice" } } : { status: 400, body: { error: "invalid_grant" } };
    });
    const env = isolatedEnv();
    const seen: { authorize?: URL; landing?: string } = {};
    const r = await run(["login", "--url", srv.url], { env, stdinTTY: true, openUrl: approvingBrowser(seen) });
    expect(r.stderr).not.toContain("error");
    expect(r.code).toBe(0);
    const a = seen.authorize!;
    expect(`${a.origin}${a.pathname}`).toBe(`${srv.url}/login/cli`);
    expect(a.searchParams.get("code_challenge_method")).toBe("S256");
    expect(a.searchParams.get("scope")).toBe("write");
    expect(a.searchParams.get("host")).toBeTruthy();
    // The verifier never went to the browser; only its hash did.
    expect(a.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(url(a)).not.toContain(verifier);
    expect(seen.landing).toBe(`${srv.url}/login/cli/done?result=ok`);
    expect(r.stdout).toContain("Logged in to");
    expect(r.stdout).toContain("alice");
    expect(r.stdout).toContain("with write access until");
    expect(r.stdout).not.toContain("dfy_from_browser");
    expect(r.stderr).not.toContain("dfy_from_browser");
    expect(JSON.parse(readFileSync(configPath(env), "utf8"))).toEqual({ url: srv.url, token: "dfy_from_browser" });
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
  });

  it("reports a cancelled sign-in and saves nothing", async () => {
    const env = isolatedEnv();
    const r = await run(["login", "--url", srv.url, "--web", "--scope", "admin"], {
      env,
      openUrl: async (url) => {
        const u = new URL(url);
        expect(u.searchParams.get("scope")).toBe("admin");
        const res = await fetch(`http://127.0.0.1:${u.searchParams.get("port")}/callback?error=access_denied&state=${u.searchParams.get("state")}`, { redirect: "manual" });
        expect(res.headers.get("location")).toBe(`${srv.url}/login/cli/done?result=denied`);
        return true;
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cancelled in the browser");
    expect(() => readFileSync(configPath(env))).toThrow();
  });

  it("prints the link when no browser opens", async () => {
    srv.on("POST", "/-/cli/token", { body: { access_token: "dfy_from_browser", scope: "write", expires_at: "2027-01-12T00:00:00Z", login: "alice" } });
    const r = await run(["login", "--url", srv.url, "--web"], {
      openUrl: async (url) => {
        const u = new URL(url);
        // The person copies the link into a browser themselves.
        setTimeout(() => void fetch(`http://127.0.0.1:${u.searchParams.get("port")}/callback?code=c&state=${u.searchParams.get("state")}`, { redirect: "manual" }), 20);
        return false;
      },
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Open this link in a browser on this computer");
    expect(r.stderr).toContain(`${srv.url}/login/cli?port=`);
  });

  it("refuses an unknown scope", async () => {
    const r = await run(["login", "--url", srv.url, "--scope", "root"], { stdinTTY: true });
    expect(r.code).toBe(2);
  });
});

const url = (u: URL) => u.toString();

describe("diffinery login --device", () => {
  let srv: FakeServer;
  beforeEach(async () => {
    srv = await fakeServer();
    srv.on("GET", "/api/v3/user", (r) => (r.headers.authorization === "Bearer dfy_from_device" ? { body: { login: "alice", type: "User" } } : { status: 401, body: { message: "bad credentials" } }));
    srv.on("POST", "/-/cli/device", { body: { device_code: "secret-device-code", user_code: "BCDF-GHJK", verification_uri: `${"https://diffinery.example"}/login/device`, expires_in: 600, interval: 5 } });
  });
  afterEach(() => srv.close());

  it("prints the code and polls until the person approves", async () => {
    let polls = 0;
    srv.on("POST", "/-/cli/token", (r) => {
      expect(r.body).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "secret-device-code" });
      polls++;
      if (polls === 1) return { status: 400, body: { error: "authorization_pending" } };
      if (polls === 2) return { status: 400, body: { error: "slow_down" } };
      return { body: { access_token: "dfy_from_device", scope: "read", expires_at: "2027-01-12T00:00:00Z", login: "alice" } };
    });
    const env = isolatedEnv();
    const r = await run(["login", "--url", srv.url, "--device", "--scope", "read"], { env });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("BCDF-GHJK");
    expect(r.stderr).toContain("https://diffinery.example/login/device");
    expect(r.stderr).not.toContain("secret-device-code");
    expect((srv.find("POST", "/-/cli/device")[0]!.body as { scope: string; client: { host: string } }).scope).toBe("read");
    expect(polls).toBe(3);
    expect(JSON.parse(readFileSync(configPath(env), "utf8")).token).toBe("dfy_from_device");
  });

  it("is what a terminal without a display gets", async () => {
    srv.on("POST", "/-/cli/token", { body: { access_token: "dfy_from_device", scope: "write", expires_at: "2027-01-12T00:00:00Z", login: "alice" } });
    const r = await run(["login", "--url", srv.url], { env: isolatedEnv({ SSH_CONNECTION: "10.0.0.1 5000 10.0.0.2 22" }), stdinTTY: true });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("BCDF-GHJK");
  });

  it("stops when the person cancels", async () => {
    srv.on("POST", "/-/cli/token", { status: 400, body: { error: "access_denied" } });
    const r = await run(["login", "--url", srv.url, "--device"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cancelled in the browser");
  });
});

describe("diffinery logout", () => {
  let srv: FakeServer;
  beforeEach(async () => {
    srv = await fakeServer();
  });
  afterEach(() => srv.close());

  it("revokes a CLI sign-in's token on the server, then forgets it", async () => {
    srv.on("DELETE", "/-/cli/token", { body: { revoked: true } });
    const env = isolatedEnv();
    await writeConfig(env, { url: srv.url, token: "dfy_cli" });
    const r = await run(["logout"], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("revoked the CLI's token");
    expect(srv.find("DELETE", "/-/cli/token")[0]!.headers.authorization).toBe("Bearer dfy_cli");
    expect(JSON.parse(readFileSync(configPath(env), "utf8"))).toEqual({ url: srv.url });
  });

  it("still signs out locally when the server can't revoke it", async () => {
    srv.on("DELETE", "/-/cli/token", { status: 401, body: { message: "invalid, expired or revoked token" } });
    const env = isolatedEnv();
    await writeConfig(env, { url: srv.url, token: "dfy_old" });
    const r = await run(["logout"], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`Logged out of ${srv.url}.\n`);
  });

  it("a new sign-in revokes the CLI token it replaces", async () => {
    srv.on("DELETE", "/-/cli/token", { body: { revoked: true } });
    srv.on("GET", "/api/v3/user", { body: { login: "alice" } });
    const env = isolatedEnv();
    await writeConfig(env, { url: srv.url, token: "dfy_previous" });
    const r = await run(["login", "--url", srv.url, "--token", "dfy_next"], { env });
    expect(r.code).toBe(0);
    expect(srv.find("DELETE", "/-/cli/token").map((q) => q.headers.authorization)).toEqual(["Bearer dfy_previous"]);
  });
});

describe("diffinery upgrade", () => {
  let srv: FakeServer;
  const build = (n: number) => `#!/usr/bin/env node\n// build ${n}\n${"x".repeat(20_000)}\n`;
  beforeEach(async () => {
    srv = await fakeServer();
  });
  afterEach(() => srv.close());

  it("replaces the file it runs from when the server has a new build, and says when it's current", async () => {
    srv.on("GET", "/-/cli/diffinery.mjs", { body: build(2), headers: { "content-type": "text/javascript", "x-diffinery-cli-version": "0.2.0" } });
    const self = path.join(tempDir(), "diffinery.mjs");
    writeFileSync(self, build(1), { mode: 0o755 });
    const env = isolatedEnv({ DIFFINERY_URL: srv.url });
    const r = await run(["upgrade"], { env, selfPath: self });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Updated diffinery");
    expect(readFileSync(self, "utf8")).toBe(build(2));
    expect(statSync(self).mode & 0o777).toBe(0o755);
    const again = await run(["upgrade"], { env, selfPath: self });
    expect(again.stdout).toContain("is up to date");
  });

  it("refuses to replace a source checkout or with something that isn't the CLI", async () => {
    srv.on("GET", "/-/cli/diffinery.mjs", { body: "<html>maintenance</html>", headers: { "content-type": "text/html" } });
    const env = isolatedEnv({ DIFFINERY_URL: srv.url });
    const src = path.join(tempDir(), "bin.ts");
    writeFileSync(src, "import x from 'y';\n");
    expect((await run(["upgrade"], { env, selfPath: src })).stderr).toContain("isn't an installed diffinery CLI");
    const self = path.join(tempDir(), "diffinery.mjs");
    writeFileSync(self, build(1));
    const r = await run(["upgrade"], { env, selfPath: self });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("doesn't look like the CLI");
    expect(readFileSync(self, "utf8")).toBe(build(1));
  });
});
