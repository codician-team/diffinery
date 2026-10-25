import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * BOOTSTRAP_ADMINS on deploy: scripts/bootstrap-admins.sh (run by bootstrap.sh) and render-config.mjs's
 * --admins, against a fake Cloudflare API (curl) on PATH. The deploy takes the list from the environment,
 * else wrangler.jsonc, else keeps the deployed Worker's, and never logs the addresses.
 */

const repo = new URL("../../../../", import.meta.url).pathname;
const LIVE = "first@example.com,second@example.com";

type State = {
  /** The deployed Worker's bindings; null before the first deploy, "denied" for a token without Workers Scripts. */
  worker: Array<{ type: string; name: string; text?: string }> | null | "denied";
};

// curl ... URL -H ...: answers from state.json, logs each call.
const FAKE_CURL = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = process.env.FAKE_DIR;
const state = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const a = process.argv.slice(2);
const method = a.includes("-X") ? a[a.indexOf("-X") + 1] : "GET";
const url = a.find((x) => x.startsWith("https://"));
fs.appendFileSync(dir + "/calls.log", JSON.stringify({ method, url }) + "\\n");
const path = new URL(url).pathname.replace(/^\\/client\\/v4\\/accounts\\/acct/, "");
const fail = (code, message) => ({ success: false, errors: [{ code, message }], result: null });
let out;
if (path === "/workers/scripts/diffinery/settings") {
  if (state.worker === "denied") out = fail(10000, "Authentication error");
  else out = state.worker ? { success: true, result: { bindings: state.worker } } : fail(10007, "This Worker does not exist on your account.");
} else out = fail(7003, "no route for " + path);
process.stdout.write(JSON.stringify(out));
`;

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function tree(state: State, fileAdmins?: string): void {
  dir = mkdtempSync(join(tmpdir(), "admins-"));
  for (const d of ["scripts", "apps/diffinery", "bin"]) mkdirSync(join(dir, d), { recursive: true });
  for (const f of ["bootstrap-admins.sh", "jsonc.mjs", "render-config.mjs"]) copyFileSync(join(repo, "scripts", f), join(dir, "scripts", f));
  let cfg = readFileSync(join(repo, "apps/diffinery/wrangler.jsonc"), "utf8");
  if (fileAdmins !== undefined) cfg = cfg.replace(/"BOOTSTRAP_ADMINS": "[^"]*",(\s*"ACCESS_TEAM_DOMAIN": "",\s*"ACCESS_AUD": ""\s*\},\s*"d1_databases")/, `"BOOTSTRAP_ADMINS": ${JSON.stringify(fileAdmins)},$1`);
  writeFileSync(join(dir, "apps/diffinery/wrangler.jsonc"), cfg);
  writeFileSync(join(dir, "bin/curl"), FAKE_CURL);
  chmodSync(join(dir, "bin/curl"), 0o755);
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

function run(cmd: string[], extraEnv: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: dir, FAKE_DIR: dir, CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: "acct" };
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
  else env[k] = v;
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: dir, encoding: "utf8", env });
  const calls = existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { method: string; url: string }) : [];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
}

const admins = (env: Record<string, string | undefined> = {}) => {
  const r = run(["bash", join(dir, "scripts/bootstrap-admins.sh")], env);
  // The addresses go to render-config on stdout, never into the deploy log.
  for (const email of [...LIVE.split(","), "ops@example.com", "file@example.com"]) expect(r.stderr).not.toContain(email);
  return { ...r, list: r.stdout.trim() };
};
const live = [{ type: "plain_text", name: "BOOTSTRAP_ADMINS", text: LIVE }, { type: "plain_text", name: "PUBLIC_URL", text: "https://git.example.com" }, { type: "secret_text", name: "MASTER_KEY" }];

describe("scripts/bootstrap-admins.sh", () => {
  it("takes BOOTSTRAP_ADMINS from the environment first, without asking Cloudflare", () => {
    tree({ worker: live }, "file@example.com");
    const r = admins({ BOOTSTRAP_ADMINS: " ops@example.com, me@example.com " });
    expect(r.status).toBe(0);
    expect(r.list).toBe("ops@example.com, me@example.com");
    expect(r.calls).toEqual([]);
    expect(r.stderr).toContain("2 address(es), from the BOOTSTRAP_ADMINS environment variable");
  });

  it("then a list kept in wrangler.jsonc", () => {
    tree({ worker: live }, "file@example.com");
    const r = admins({ BOOTSTRAP_ADMINS: "" });
    expect(r.status).toBe(0);
    expect(r.list).toBe("file@example.com");
    expect(r.calls).toEqual([]);
  });

  it("keeps the deployed Worker's list when neither sets one (the Deploy workflow)", () => {
    tree({ worker: live });
    const r = admins();
    expect(r.status).toBe(0);
    expect(r.list).toBe(LIVE);
    expect(r.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /client/v4/accounts/acct/workers/scripts/diffinery/settings"]);
    expect(r.stderr).toContain("2 address(es), from the deployed diffinery Worker");
    expect(r.stderr).not.toContain("::warning::");
  });

  it("warns loudly on a brand-new instance with no list, and goes on with none", () => {
    for (const worker of [null, [{ type: "plain_text", name: "BOOTSTRAP_ADMINS", text: "" }]]) {
      tree({ worker });
      const r = admins();
      expect(r.status).toBe(0);
      expect(r.list).toBe("");
      expect(r.stderr).toContain("::warning::BOOTSTRAP_ADMINS is empty");
      expect(r.stderr).toContain("nobody becomes a site administrator");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns, without calling Cloudflare, when there are no credentials", () => {
    tree({ worker: live });
    const r = admins({ CLOUDFLARE_API_TOKEN: undefined });
    expect(r.status).toBe(0);
    expect(r.list).toBe("");
    expect(r.calls).toEqual([]);
    expect(r.stderr).toContain("::warning::BOOTSTRAP_ADMINS is empty");
  });

  it("stops the deploy when the Worker's settings can't be read, rather than drop its list", () => {
    tree({ worker: "denied" });
    const r = admins();
    expect(r.status).toBe(1);
    expect(r.list).toBe("");
    expect(r.stderr).toContain("::error::Could not read the diffinery Worker's settings to keep its BOOTSTRAP_ADMINS");
    expect(r.stderr).toContain("Workers Scripts → Edit");
    expect(r.stderr).toContain("10000: Authentication error");
  });
});

describe("scripts/render-config.mjs --admins", () => {
  const render = (args: string[]) => {
    const r = run(["node", join(dir, "scripts/render-config.mjs"), "--d1", "db-id", "--public-url", "https://git.example.com", ...args]);
    const cfg = r.status === 0 ? (JSON.parse(readFileSync(join(dir, "apps/diffinery/wrangler.deploy.jsonc"), "utf8").split("\n").slice(1).join("\n")) as { vars: Record<string, string> }) : null;
    return { ...r, cfg };
  };

  it("sets BOOTSTRAP_ADMINS, trimmed, and leaves wrangler.jsonc's value without the flag", () => {
    tree({ worker: null });
    expect(render(["--admins", " a@example.com ,b@example.com,, "]).cfg!.vars.BOOTSTRAP_ADMINS).toBe("a@example.com,b@example.com");
    expect(render(["--admins", ""]).cfg!.vars.BOOTSTRAP_ADMINS).toBe("");
    expect(render([]).cfg!.vars.BOOTSTRAP_ADMINS).toBe("");
    rmSync(dir, { recursive: true, force: true });
    tree({ worker: null }, "file@example.com");
    expect(render([]).cfg!.vars.BOOTSTRAP_ADMINS).toBe("file@example.com");
  });

  it("refuses an entry that isn't an email address", () => {
    tree({ worker: null });
    const r = render(["--admins", "a@example.com,diffy"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not an email address: "diffy"');
  });

  it("ships no personal addresses: the repository's wrangler.jsonc leaves the list empty", () => {
    tree({ worker: null });
    const r = render([]);
    expect(r.cfg!.vars.BOOTSTRAP_ADMINS).toBe("");
    expect(JSON.stringify(r.cfg)).not.toContain("diffinery.com");
  });
});
