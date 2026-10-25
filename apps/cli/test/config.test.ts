import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, normalizeUrl, resolveConfig, writeConfig } from "../src/config.js";
import type { Io } from "../src/io.js";
import { fakeServer, isolatedEnv, run, type FakeServer } from "./helpers.js";

const ioWith = (env: NodeJS.ProcessEnv) => ({ env }) as unknown as Io;

describe("config", () => {
  it("defaults to https://diffinery.com with no token", async () => {
    const cfg = await resolveConfig(ioWith(isolatedEnv()));
    expect(cfg).toMatchObject({ url: "https://diffinery.com", token: null, urlSource: "default", tokenSource: null });
  });

  it("reads the file under XDG_CONFIG_HOME and lets env vars override it", async () => {
    const env = isolatedEnv();
    const file = path.join(env.XDG_CONFIG_HOME!, "diffinery", "config.json");
    expect(configPath(env)).toBe(file);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ url: "https://forge.example.com/", token: "dfy_file" }));

    expect(await resolveConfig(ioWith(env))).toMatchObject({ url: "https://forge.example.com", token: "dfy_file", urlSource: "config", tokenSource: "config" });
    expect(await resolveConfig(ioWith({ ...env, DIFFINERY_TOKEN: "dfy_env" }))).toMatchObject({ url: "https://forge.example.com", token: "dfy_env", tokenSource: "env" });
    expect(await resolveConfig(ioWith({ ...env, DIFFINERY_URL: "other.example.com" }))).toMatchObject({ url: "https://other.example.com", token: "dfy_file", urlSource: "env" });
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    const env = isolatedEnv();
    delete env.XDG_CONFIG_HOME;
    expect(configPath(env)).toBe(path.join(env.HOME!, ".config", "diffinery", "config.json"));
  });

  it("writes the config with mode 0600", async () => {
    const env = isolatedEnv();
    const file = await writeConfig(env, { url: "https://a.example", token: "dfy_x" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ url: "https://a.example", token: "dfy_x" });
  });

  it("tightens an existing loose config directory and file, and leaves no temporary file", async () => {
    const env = isolatedEnv();
    const file = configPath(env);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    chmodSync(path.dirname(file), 0o755);
    writeFileSync(file, "{}", { mode: 0o644 });
    chmodSync(file, 0o644);
    await writeConfig(env, { url: "https://a.example", token: "dfy_y" });
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ url: "https://a.example", token: "dfy_y" });
    expect(readdirSync(path.dirname(file))).toEqual(["config.json"]);
  });

  it("normalizes URLs", () => {
    expect(normalizeUrl("forge.example.com/")).toBe("https://forge.example.com");
    expect(normalizeUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(normalizeUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeUrl("http://[::1]:8787")).toBe("http://[::1]:8787");
    expect(normalizeUrl("http://dev.localhost")).toBe("http://dev.localhost");
    expect(() => normalizeUrl("ftp://x")).toThrow();
  });

  it("refuses plain http anywhere but this machine, since tokens go with every request", () => {
    expect(() => normalizeUrl("http://forge.example.com")).toThrow(/unencrypted/);
    expect(() => normalizeUrl("http://10.0.0.5:8787")).toThrow(/unencrypted/);
    expect(() => normalizeUrl("http://localhost.example.com")).toThrow(/unencrypted/);
  });
});

describe("login / whoami / logout", () => {
  let srv: FakeServer;
  beforeEach(async () => {
    srv = await fakeServer();
    srv.on("GET", "/api/v3/user", (r) => (r.headers.authorization === "Bearer dfy_good" ? { body: { login: "alice", name: "Alice", type: "User" } } : { status: 401, body: { message: "bad credentials" } }));
  });
  afterEach(() => srv.close());

  it("verifies the token, saves it 0600, and whoami uses it", async () => {
    const env = isolatedEnv();
    const r = await run(["login", "--url", srv.url, "--token", "dfy_good"], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Logged in to");
    expect(r.stdout).toContain("alice");
    expect(r.stdout).not.toContain("dfy_good");
    const file = configPath(env);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ url: srv.url, token: "dfy_good" });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const who = await run(["whoami"], { env });
    expect(who.code).toBe(0);
    expect(who.stdout).toContain("alice");
    expect(srv.find("GET", "/api/v3/user").at(-1)!.headers.authorization).toBe("Bearer dfy_good");

    const out = await run(["logout"], { env });
    expect(out.code).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ url: srv.url });
    expect((await run(["whoami"], { env })).code).toBe(1);
  });

  it("reads the token from stdin when it is not a TTY", async () => {
    const env = isolatedEnv();
    const r = await run(["login", "--url", srv.url], { env, stdin: "dfy_good\n" });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(configPath(env), "utf8")).token).toBe("dfy_good");
  });

  it("refuses a token the server rejects and saves nothing", async () => {
    const env = isolatedEnv();
    const r = await run(["login", "--url", srv.url, "--token", "dfy_bad"], { env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("bad credentials");
    expect(() => readFileSync(configPath(env))).toThrow();
  });

  it("DIFFINERY_TOKEN/DIFFINERY_URL override the saved config", async () => {
    const env = isolatedEnv();
    await writeConfig(env, { url: "http://127.0.0.1:1", token: "dfy_saved" });
    const r = await run(["whoami", "--json"], { env: { ...env, DIFFINERY_URL: srv.url, DIFFINERY_TOKEN: "dfy_good" } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).login).toBe("alice");
  });

  it("mcp-config prints a snippet without the token unless asked", async () => {
    const env = isolatedEnv({ DIFFINERY_URL: srv.url, DIFFINERY_TOKEN: "dfy_good" });
    const r = await run(["mcp-config"], { env });
    const cfg = JSON.parse(r.stdout);
    expect(cfg.mcpServers.diffinery).toEqual({ type: "http", url: `${srv.url}/mcp`, headers: { Authorization: "Bearer ${DIFFINERY_TOKEN}" } });
    const shown = JSON.parse((await run(["mcp-config", "--show-token"], { env })).stdout);
    expect(shown.mcpServers.diffinery.headers.Authorization).toBe("Bearer dfy_good");
  });
});
