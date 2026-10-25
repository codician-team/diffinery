import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configPath, writeConfig } from "../src/config.js";
import { fakeServer, gitRepo, isolatedEnv, run, tempDir, type FakeServer } from "./helpers.js";

const helpers = (env: NodeJS.ProcessEnv, url: string) => execFileSync("git", ["config", "--global", "--get-all", `credential.${url}.helper`], { env }).toString().split("\n").slice(0, -1);

/** A gh that records how it was called; `fail` makes `auth login` fail. */
function fakeGh(fail = false): { dir: string; seen: string } {
  const dir = tempDir("diffinery-fake-gh-");
  const seen = path.join(dir, "seen");
  writeFileSync(path.join(dir, "gh"), `#!/bin/sh\n[ "$1" = --version ] && exit 0\nprintf '%s ' "$@" > "${seen}.args"\ncat > "${seen}.stdin"\n${fail ? "echo 'gh: nope' >&2; exit 1\n" : ""}`);
  chmodSync(path.join(dir, "gh"), 0o755);
  return { dir, seen };
}

describe("diffinery setup", () => {
  let srv: FakeServer;
  beforeEach(async () => {
    srv = await fakeServer();
    srv.on("GET", "/api/v3/user", (r) => (r.headers.authorization === "Bearer dfy_good" ? { body: { login: "alice", type: "User" } } : { status: 401, body: { message: "bad credentials" } }));
    srv.on("POST", "/-/cli/token", { body: { access_token: "dfy_good", token_type: "bearer", scope: "write", expires_at: "2027-01-12T00:00:00Z", login: "alice" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    return srv.close();
  });

  /** A browser where the person clicks Authorize. */
  const approve = async (url: string) => {
    const u = new URL(url);
    await fetch(`http://127.0.0.1:${u.searchParams.get("port")}/callback?code=c&state=${u.searchParams.get("state")}`, { redirect: "manual" });
    return true;
  };

  it("signs in through the browser, then sets up git, even when an agent runs it without a terminal", async () => {
    const env = isolatedEnv();
    let opened = 0;
    const r = await run(["setup", "--url", srv.url], { env, stdinTTY: false, openUrl: (u) => (opened++, approve(u)) });
    expect(r.stderr).not.toContain("error");
    expect(r.code).toBe(0);
    expect(opened).toBe(1);
    expect(r.stdout).toContain(`Logged in to ${srv.url} as alice`);
    expect(r.stdout).toContain(`git will use diffinery for ${srv.url}`);
    expect(r.stdout).toContain(`${srv.url}/docs/connect`);
    expect(r.stderr).toContain("Skipped gh");
    expect(r.stdout + r.stderr).not.toContain("dfy_good");
    expect(JSON.parse(readFileSync(configPath(env), "utf8"))).toEqual({ url: srv.url, token: "dfy_good" });
    expect(helpers(env, srv.url)).toEqual(["", "!diffinery auth git-credential"]);
  });

  it("offers auto-merge for the person's pull requests on a terminal, and turns it on with yes", async () => {
    const env = isolatedEnv();
    await writeConfig(env, { url: srv.url, token: "dfy_good" });
    let enabled = false;
    srv.on("GET", "/api/v3/diffinery/auto-merge", () => ({ body: { enabled, merge_method: enabled ? "default" : null } }));
    srv.on("PUT", "/api/v3/diffinery/auto-merge", () => ((enabled = true), { body: { enabled: true, merge_method: "default" } }));
    // No terminal: nothing asked, nothing changed.
    const quiet = await run(["setup"], { env, stdinTTY: false });
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).not.toContain("Turn on auto-merge");
    expect(srv.find("PUT", "/api/v3/diffinery/auto-merge")).toHaveLength(0);
    // Asked and declined.
    const no = await run(["setup"], { env, stdinTTY: true, stdin: "\n" });
    expect(no.code).toBe(0);
    expect(no.stderr).toContain("Turn on auto-merge for pull requests you open? [y/N]");
    expect(no.stderr).toContain("Auto-merge stays off");
    expect(srv.find("PUT", "/api/v3/diffinery/auto-merge")).toHaveLength(0);
    // Asked and accepted.
    const yes = await run(["setup"], { env, stdinTTY: true, stdin: "y\n" });
    expect(yes.code).toBe(0);
    expect(srv.find("PUT", "/api/v3/diffinery/auto-merge")[0]!.body).toEqual({ enabled: true });
    expect(yes.stdout).toContain(`Auto-merge turns on by itself for pull requests you open (change it in ${srv.url}/settings/pull-requests)`);
    // Once on, it only says so.
    const again = await run(["setup"], { env, stdinTTY: true, stdin: "" });
    expect(again.stderr).not.toContain("[y/N]");
    expect(again.stdout).toContain("Auto-merge turns on by itself for pull requests you open");
    expect(srv.find("PUT", "/api/v3/diffinery/auto-merge")).toHaveLength(1);
  });

  it("turns auto-merge on without asking with --auto-merge, and never asks with --no-auto-merge or for an agent", async () => {
    const env = isolatedEnv();
    await writeConfig(env, { url: srv.url, token: "dfy_good" });
    srv.on("GET", "/api/v3/diffinery/auto-merge", { body: { enabled: false, merge_method: null } });
    srv.on("PUT", "/api/v3/diffinery/auto-merge", { body: { enabled: true, merge_method: "default" } });
    const skip = await run(["setup", "--no-auto-merge"], { env, stdinTTY: true, stdin: "y\n" });
    expect(skip.stderr).not.toContain("[y/N]");
    expect(srv.find("PUT", "/api/v3/diffinery/auto-merge")).toHaveLength(0);
    const yes = await run(["setup", "--auto-merge"], { env, stdinTTY: false });
    expect(yes.code).toBe(0);
    expect(srv.find("PUT", "/api/v3/diffinery/auto-merge")).toHaveLength(1);
    srv.on("GET", "/api/v3/user", { body: { login: "alice-bot", type: "Bot" } });
    const bot = await run(["setup", "--auto-merge"], { env, stdinTTY: true, stdin: "y\n" });
    expect(bot.stderr).not.toContain("[y/N]");
    expect(srv.find("PUT", "/api/v3/diffinery/auto-merge")).toHaveLength(1);
  });

  it("keeps a sign-in that still works, and is safe to run again", async () => {
    const env = isolatedEnv();
    await writeConfig(env, { url: srv.url, token: "dfy_good" });
    for (let i = 0; i < 2; i++) {
      const r = await run(["setup"], { env, openUrl: async () => expect.fail("opened a browser") });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Signed in to ${srv.url} as alice`);
    }
    expect(srv.find("POST", "/-/cli/token")).toHaveLength(0);
    expect(helpers(env, srv.url)).toEqual(["", "!diffinery auth git-credential"]);
  });

  it("signs in again when the saved token no longer works", async () => {
    const env = isolatedEnv();
    await writeConfig(env, { url: srv.url, token: "dfy_expired" });
    const r = await run(["setup"], { env, openUrl: approve });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Logged in to");
    expect(JSON.parse(readFileSync(configPath(env), "utf8")).token).toBe("dfy_good");
  });

  describe("with gh", () => {
    const host = "https://forge.example.com";
    // Requests to the HTTPS host reach the fake server, since gh only signs in to HTTPS hosts.
    beforeEach(() => {
      const real = fetch;
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => real(String(input instanceof Request ? input.url : input).replace(host, srv.url), init));
    });

    it("signs gh in with the token on stdin", async () => {
      const gh = fakeGh();
      const env = isolatedEnv({ PATH: `${gh.dir}${path.delimiter}${process.env.PATH}` });
      await writeConfig(env, { url: host, token: "dfy_good" });
      const r = await run(["setup"], { env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("gh is signed in to forge.example.com");
      expect(readFileSync(`${gh.seen}.args`, "utf8").trim()).toBe("auth login --hostname forge.example.com --with-token --git-protocol https");
      expect(readFileSync(`${gh.seen}.stdin`, "utf8")).toBe("dfy_good\n");
    });

    it("leaves gh to GH_ENTERPRISE_TOKEN when it's in the environment, since gh won't sign in over it", async () => {
      const gh = fakeGh();
      const env = isolatedEnv({ PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`, GH_ENTERPRISE_TOKEN: "dfy_good", GH_HOST: "forge.example.com" });
      await writeConfig(env, { url: host, token: "dfy_good" });
      const r = await run(["setup"], { env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("gh uses GH_ENTERPRISE_TOKEN for forge.example.com");
      expect(() => readFileSync(`${gh.seen}.args`)).toThrow();
      const other = await run(["setup"], { env: { ...env, GH_ENTERPRISE_TOKEN: "dfy_other" } });
      expect(other.code).toBe(1);
      expect(other.stderr).toContain("isn't your Diffinery token");
      expect(other.stdout + other.stderr).not.toMatch(/dfy_(good|other)/);
    });

    it("says when gh isn't installed", async () => {
      // A PATH with git and nothing else, wherever gh lives on this machine.
      const dir = tempDir("diffinery-no-gh-");
      symlinkSync(execFileSync("sh", ["-c", "command -v git"]).toString().trim(), path.join(dir, "git"));
      const env = isolatedEnv({ PATH: dir });
      await writeConfig(env, { url: host, token: "dfy_good" });
      const r = await run(["setup"], { env });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("Skipped gh, which isn't installed");
    });

    it("finishes the rest and exits 1 when gh fails", async () => {
      const gh = fakeGh(true);
      const env = isolatedEnv({ PATH: `${gh.dir}${path.delimiter}${process.env.PATH}` });
      await writeConfig(env, { url: host, token: "dfy_good" });
      const r = await run(["setup"], { env });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("gh auth login failed: gh: nope");
      expect(r.stdout).toContain("git will use diffinery");
      expect(r.stdout).toContain(`${host}/docs/connect`);
    });
  });
});

describe("diffinery setup --repo (an agent environment, as the hosted agent-setup.sh runs it)", () => {
  let srv: FakeServer;
  let push: boolean;
  beforeEach(async () => {
    const root = tempDir("diffinery-git-root-");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", path.join(root, "ada", "zutrix.git")]);
    const seed = gitRepo(isolatedEnv(), path.join(root, "ada", "zutrix.git"));
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed });
    srv = await fakeServer({ gitRoot: root });
    push = true;
    srv.on("GET", "/healthz", { body: { ok: true } });
    srv.on("GET", "/api/v3/user", (r) => (r.headers.authorization === "Bearer dfy_agent" ? { body: { login: "zutrix-agent", type: "Bot" } } : { status: 401, body: { message: "bad credentials" } }));
    srv.on("GET", "/api/v3/repos/ada/zutrix", () => ({ body: { full_name: "ada/zutrix", permissions: { pull: true, push } } }));
    srv.on("POST", "/api/v3/repos/ada/zutrix/diffinery/agent-setup/checks", { status: 201, body: { ok: true } });
  });
  afterEach(() => srv.close());

  /** A PATH with git and a diffinery command, and no gh. */
  const machine = (extra: NodeJS.ProcessEnv = {}) => {
    const bin = tempDir("diffinery-agent-bin-");
    symlinkSync(execFileSync("sh", ["-c", "command -v git"]).toString().trim(), path.join(bin, "git"));
    writeFileSync(path.join(bin, "diffinery"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, "diffinery"), 0o755);
    return isolatedEnv({ PATH: bin, DIFFINERY_CLONE_DIR: tempDir("diffinery-clones-"), ...extra });
  };
  const reports = () => srv.find("POST", "/api/v3/repos/ada/zutrix/diffinery/agent-setup/checks").map((r) => r.body as { checks: Array<{ name: string; ok: boolean; message: string }> });

  it("checks each part with the token from the environment, clones, reports, and writes no token to disk", async () => {
    const env = machine({ DIFFINERY_TOKEN: "dfy_agent" });
    const r = await run(["setup", "--repo", "ada/zutrix", "--url", srv.url], { env });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    for (const s of [`✓ server: ${srv.host} is reachable`, "✓ DIFFINERY_TOKEN: acts as zutrix-agent (agent)", "✓ repository: ada/zutrix with write access", "✓ git: git can reach", `✓ clone: cloned into ${path.join(env.DIFFINERY_CLONE_DIR!, "zutrix")}`, "✓ gh: skipped", "Ready:"]) expect(r.stdout).toContain(s);
    expect(r.stdout).not.toContain("dfy_agent");
    expect(JSON.parse(readFileSync(configPath(env), "utf8"))).toEqual({ url: srv.url });
    const [report] = reports();
    expect(report!.checks.every((l) => l.ok)).toBe(true);
    // Again, as at each session start: the clone is fetched, not cloned again.
    const again = await run(["setup", "--repo", "ada/zutrix", "--url", srv.url], { env });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("(up to date)");
  });

  it("says what to change, exits 1, and still reports, when a check fails", async () => {
    push = false;
    const env = machine({ DIFFINERY_TOKEN: "dfy_agent" });
    const r = await run(["setup", "--repo", "ada/zutrix", "--url", srv.url, "--no-clone"], { env });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`✗ repository: zutrix-agent can read ada/zutrix but not push: use a token from ${srv.url}/ada/zutrix/settings/agent-setup`);
    expect(r.stdout).toContain("1 of");
    expect(reports()[0]!.checks.find((l) => l.name === "repository")!.ok).toBe(false);
  });

  it("names the token that's missing or refused, with where to get a new one", async () => {
    const missing = await run(["setup", "--repo", "ada/zutrix", "--url", srv.url, "--no-clone"], { env: machine() });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain(`✗ DIFFINERY_TOKEN: not set: add DIFFINERY_TOKEN=<token> to the environment variables (generate one on ${srv.url}/ada/zutrix/settings/agent-setup)`);
    const refused = await run(["setup", "--repo", "ada/zutrix", "--url", srv.url, "--no-clone"], { env: machine({ DIFFINERY_TOKEN: "dfy_revoked" }) });
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain("✗ DIFFINERY_TOKEN: refused (revoked or expired)");
    expect(refused.stdout).not.toContain("dfy_revoked");
    expect(reports()).toHaveLength(0);
  });

  it("refuses a --repo that isn't OWNER/NAME", async () => {
    const r = await run(["setup", "--repo", "zutrix", "--url", srv.url], { env: machine({ DIFFINERY_TOKEN: "dfy_agent" }) });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--repo expects OWNER/NAME");
  });
});

describe("Claude Code plugins in diffinery setup", () => {
  let srv: FakeServer;
  const zips = { diffinery: "PK\u0003\u0004 diffinery plugin", "diffinery-ci": "PK\u0003\u0004 diffinery-ci plugin" } as const;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  beforeEach(async () => {
    srv = await fakeServer();
    srv.on("GET", "/api/v3/user", { body: { login: "alice", type: "User" } });
    for (const [name, body] of Object.entries(zips))
      srv.on("GET", `/-/claude/${name}.zip`, { body, headers: { "content-type": "application/zip", "x-diffinery-plugin-version": name === "diffinery" ? "0.1.1" : "0.2.0", "x-diffinery-plugin-sha256": sha(body) } });
  });
  afterEach(() => srv.close());

  /** A machine with Claude Code: its settings directory, with `settings` in it when given. */
  const withClaude = async (settings?: unknown) => {
    const env = isolatedEnv({ DIFFINERY_NO_CLAUDE_PLUGINS: "" });
    await writeConfig(env, { url: srv.url, token: "dfy_good" });
    mkdirSync(path.join(env.HOME!, ".claude"));
    if (settings !== undefined) writeFileSync(path.join(env.HOME!, ".claude", "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
    return env;
  };
  const settingsOf = (env: NodeJS.ProcessEnv) => JSON.parse(readFileSync(path.join(env.HOME!, ".claude", "settings.json"), "utf8"));
  const dirsOf = (env: NodeJS.ProcessEnv) => (settingsOf(env).env.CLAUDE_CODE_PLUGIN_DIRS as string).split(path.delimiter);

  it("saves both plugins and names them in Claude Code's settings, keeping what was there, and runs again cleanly", async () => {
    const env = await withClaude({ model: "opus", env: { FOO: "1", CLAUDE_CODE_PLUGIN_DIRS: "/opt/mine" } });
    for (let i = 0; i < 2; i++) {
      const r = await run(["setup"], { env, openUrl: async () => expect.fail("opened a browser") });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("✓ Claude Code plugins: diffinery 0.1.1 and diffinery-ci 0.2.0 load in new Claude Code sessions");
    }
    const dir = path.join(env.HOME!, ".claude", "diffinery-plugins");
    expect(dirsOf(env)).toEqual(["/opt/mine", path.join(dir, "diffinery.zip"), path.join(dir, "diffinery-ci.zip")]);
    expect(settingsOf(env)).toMatchObject({ model: "opus", env: { FOO: "1" } });
    expect(readFileSync(path.join(dir, "diffinery-ci.zip"), "utf8")).toBe(zips["diffinery-ci"]);
  });

  it("does nothing without Claude Code, with --no-claude-plugins, or for a plugin installed from the marketplace", async () => {
    // No Claude Code: no ~/.claude, and a PATH with git alone.
    const bin = tempDir("diffinery-no-claude-");
    symlinkSync(execFileSync("sh", ["-c", "command -v git"]).toString().trim(), path.join(bin, "git"));
    const none = isolatedEnv({ DIFFINERY_NO_CLAUDE_PLUGINS: "", PATH: bin });
    await writeConfig(none, { url: srv.url, token: "dfy_good" });
    expect((await run(["setup"], { env: none })).stdout).not.toContain("Claude Code plugins");
    expect(existsSync(path.join(none.HOME!, ".claude"))).toBe(false);

    const skip = await withClaude();
    expect((await run(["setup", "--no-claude-plugins"], { env: skip })).stdout).not.toContain("Claude Code plugins");
    expect(existsSync(path.join(skip.HOME!, ".claude", "settings.json"))).toBe(false);

    const market = await withClaude({ enabledPlugins: { "diffinery-ci@diffinery": true } });
    const r = await run(["setup"], { env: market });
    expect(r.stdout).toContain("diffinery 0.1.1 load in new Claude Code sessions");
    expect(r.stdout).toContain("diffinery-ci already installed from the Diffinery marketplace");
    expect(dirsOf(market)).toEqual([path.join(market.HOME!, ".claude", "diffinery-plugins", "diffinery.zip")]);
  });

  it("leaves settings it can't read alone, and refuses a download that doesn't match its checksum", async () => {
    const broken = await withClaude("{ not json");
    const r = await run(["setup"], { env: broken });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("isn't valid JSON, so it was left alone");
    expect(readFileSync(path.join(broken.HOME!, ".claude", "settings.json"), "utf8")).toBe("{ not json");

    srv.on("GET", "/-/claude/diffinery-ci.zip", { body: "tampered", headers: { "content-type": "application/zip", "x-diffinery-plugin-sha256": sha("other") } });
    const bad = await withClaude();
    const r2 = await run(["setup"], { env: bad });
    expect(r2.code).toBe(1);
    expect(r2.stderr).toContain("didn't match its checksum");
    expect(existsSync(path.join(bad.HOME!, ".claude", "settings.json"))).toBe(false);
  });
});
