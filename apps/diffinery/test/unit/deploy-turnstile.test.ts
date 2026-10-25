import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * scripts/turnstile.sh (run by bootstrap.sh), its use in ensure-secrets.sh, and render-config.mjs's
 * TURNSTILE_SITE_KEY, against a fake Cloudflare API (curl) and a fake wrangler (pnpm) on PATH.
 */

const repo = new URL("../../../../", import.meta.url).pathname;
const SECRET = "0x4AAAAAAAsecret-key-of-the-widget";

type Widget = { sitekey: string; secret: string; name: string; domains: string[]; mode: string };
type State = {
  /** Every Turnstile call answers "Authentication error", as for a token without Turnstile Edit. */
  denied?: boolean;
  /** Only creating widgets and reading a widget's secret fail. */
  readOnly?: boolean;
  widgets: Widget[];
  /** The deployed Worker's bindings, or null before the first deploy. */
  worker: Array<{ type: string; name: string; text?: string }> | null;
  /** Names wrangler secret list returns. */
  secrets: string[];
};

// curl -sS -X METHOD URL [-H ...] [--data BODY]: answers from state.json, logs each call.
const FAKE_CURL = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = process.env.FAKE_DIR;
const state = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const a = process.argv.slice(2);
const method = a[a.indexOf("-X") + 1] ?? "GET";
const url = a.find((x) => x.startsWith("https://"));
const body = a.includes("--data") ? a[a.indexOf("--data") + 1] : null;
fs.appendFileSync(dir + "/calls.log", JSON.stringify({ method, url, body }) + "\\n");
const path = new URL(url).pathname.replace(/^\\/client\\/v4\\/accounts\\/acct/, "");
const fail = (code, message) => ({ success: false, errors: [{ code, message }], result: null });
let out;
if (path.startsWith("/challenges/widgets")) {
  const key = path.split("/")[3];
  if (state.denied) out = fail(10000, "Authentication error");
  else if (method === "GET" && !key) out = { success: true, result: state.widgets.map(({ secret, ...w }) => w) };
  else if (state.readOnly) out = fail(10000, "Authentication error");
  else if (method === "POST") {
    const w = { ...JSON.parse(body), sitekey: "0x4AAAAAAAnew", secret: "${SECRET}" };
    state.widgets.push(w);
    fs.writeFileSync(dir + "/state.json", JSON.stringify(state));
    out = { success: true, result: w };
  } else {
    const w = state.widgets.find((x) => x.sitekey === key);
    out = w ? { success: true, result: w } : fail(10404, "not found");
  }
} else if (path === "/workers/scripts/diffinery/settings") {
  out = state.worker ? { success: true, result: { bindings: state.worker } } : fail(10007, "This Worker does not exist on your account.");
} else out = fail(7003, "no route for " + path);
process.stdout.write(JSON.stringify(out));
`;

// pnpm --dir APP exec wrangler secret (list|put NAME) ...: logs each put with what came on stdin.
const FAKE_PNPM = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = process.env.FAKE_DIR;
const state = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const a = process.argv.slice(process.argv.indexOf("wrangler") + 1);
if (a[0] === "secret" && a[1] === "list") process.stdout.write(JSON.stringify(state.secrets.map((name) => ({ name, type: "secret_text" }))));
else if (a[0] === "secret" && a[1] === "put") {
  const value = fs.readFileSync(0, "utf8");
  fs.appendFileSync(dir + "/puts.log", JSON.stringify({ name: a[2], value, args: a.slice(3) }) + "\\n");
  console.log("Success! Uploaded secret " + a[2]);
} else { console.error("fake pnpm: unexpected " + a.join(" ")); process.exit(1); }
`;

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function tree(state: State, wranglerVars: Record<string, string> = {}): string {
  dir = mkdtempSync(join(tmpdir(), "turnstile-"));
  for (const d of ["scripts", "apps/diffinery", "bin"]) mkdirSync(join(dir, d), { recursive: true });
  for (const f of ["turnstile.sh", "ensure-secrets.sh", "jsonc.mjs", "render-config.mjs"]) copyFileSync(join(repo, "scripts", f), join(dir, "scripts", f));
  const cfg = readFileSync(join(repo, "apps/diffinery/wrangler.jsonc"), "utf8");
  const vars = Object.entries(wranglerVars).map(([k, v]) => `\n    ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("");
  writeFileSync(join(dir, "apps/diffinery/wrangler.jsonc"), cfg.replace(/"vars": \{/, `"vars": {${vars}`));
  writeFileSync(join(dir, "bin/curl"), FAKE_CURL);
  writeFileSync(join(dir, "bin/pnpm"), FAKE_PNPM);
  chmodSync(join(dir, "bin/curl"), 0o755);
  chmodSync(join(dir, "bin/pnpm"), 0o755);
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  return dir;
}

function run(cmd: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: dir, FAKE_DIR: dir, CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: "acct", DIFFINERY_DOMAIN: "git.example.com", ...extraEnv },
  });
  const lines = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const calls = lines("calls.log") as Array<{ method: string; url: string; body: string | null }>;
  const puts = lines("puts.log") as Array<{ name: string; value: string; args: string[] }>;
  // Whatever happens, the secret key never reaches the log.
  expect(r.stdout + r.stderr).not.toContain(SECRET);
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr, calls, puts };
}

const turnstile = () => run(["bash", join(dir, "scripts/turnstile.sh")]);
const widget = (sitekey = "0x4AAAAAAAold"): Widget => ({ sitekey, secret: SECRET, name: "diffinery git.example.com", domains: ["git.example.com"], mode: "managed" });
const PERMISSION = "Account → Turnstile → Edit";

describe("scripts/turnstile.sh", () => {
  it("creates the widget when there is none, and prints its site key", () => {
    tree({ widgets: [{ ...widget("0x4AAAAAAAother"), name: "someone else's" }], worker: null, secrets: [] });
    const r = turnstile();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("0x4AAAAAAAnew");
    expect(r.calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`)).toEqual([
      "GET /client/v4/accounts/acct/challenges/widgets?per_page=1000",
      "POST /client/v4/accounts/acct/challenges/widgets",
      "GET /client/v4/accounts/acct/workers/scripts/diffinery/settings",
    ]);
    expect(JSON.parse(r.calls[1]!.body!)).toEqual({ name: "diffinery git.example.com", domains: ["git.example.com"], mode: "managed" });
    // The Worker isn't deployed yet: ensure-secrets.sh sets TURNSTILE_SECRET after the deploy.
    expect(r.puts).toEqual([]);
    expect(r.stderr).toContain("ensure-secrets.sh sets TURNSTILE_SECRET");
  });

  it("reuses the widget it finds by name, and leaves a secret that goes with it alone", () => {
    tree({ widgets: [widget()], worker: [{ type: "plain_text", name: "TURNSTILE_SITE_KEY", text: "0x4AAAAAAAold" }, { type: "secret_text", name: "TURNSTILE_SECRET" }], secrets: [] });
    const r = turnstile();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("0x4AAAAAAAold");
    expect(r.calls.some((c) => c.method === "POST")).toBe(false);
    expect(r.puts).toEqual([]);
    expect(r.stderr).not.toContain("::warning::");
  });

  it("leaves a missing TURNSTILE_SECRET to ensure-secrets.sh", () => {
    tree({ widgets: [widget()], worker: [{ type: "plain_text", name: "TURNSTILE_SITE_KEY", text: "0x4AAAAAAAold" }], secrets: [] });
    const r = turnstile();
    expect(r.stdout).toBe("0x4AAAAAAAold");
    expect(r.puts).toEqual([]);
  });

  it("replaces a TURNSTILE_SECRET that goes with another site key before the deploy", () => {
    for (const deployed of ["0x4AAAAAAAgone", undefined]) {
      tree({ widgets: [widget()], worker: [...(deployed ? [{ type: "plain_text", name: "TURNSTILE_SITE_KEY", text: deployed }] : []), { type: "secret_text", name: "TURNSTILE_SECRET" }], secrets: [] });
      const r = turnstile();
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("0x4AAAAAAAold");
      expect(r.puts).toEqual([{ name: "TURNSTILE_SECRET", value: SECRET, args: ["--name", "diffinery"] }]);
      expect(r.calls.some((c) => c.method === "GET" && c.url.endsWith("/challenges/widgets/0x4AAAAAAAold"))).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("without the permission, warns naming it, prints no site key and exits 0", () => {
    tree({ denied: true, widgets: [], worker: null, secrets: [] });
    const r = turnstile();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("::warning::Could not read the account's Turnstile widgets");
    expect(r.stderr).toContain(PERMISSION);
    expect(r.stderr).toContain("10000: Authentication error");
    expect(r.puts).toEqual([]);
  });

  it("with read-only access, warns when it can't create the widget", () => {
    tree({ readOnly: true, widgets: [], worker: null, secrets: [] });
    const r = turnstile();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain('::warning::Could not create the Turnstile widget "diffinery git.example.com"');
    expect(r.stderr).toContain(PERMISSION);
  });

  it("deploys no new site key when a secret that goes with another widget can't be replaced", () => {
    tree({ readOnly: true, widgets: [widget()], worker: [{ type: "plain_text", name: "TURNSTILE_SITE_KEY", text: "0x4AAAAAAAgone" }, { type: "secret_text", name: "TURNSTILE_SECRET" }], secrets: [] });
    const r = turnstile();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.puts).toEqual([]);
    expect(r.stderr).toContain("::warning::Could not read the secret key of Turnstile widget 0x4AAAAAAAold");
    expect(r.stderr).toContain("TURNSTILE_SECRET goes with another Turnstile widget and couldn't be replaced");
  });

  it("leaves keys set in wrangler.jsonc alone", () => {
    tree({ widgets: [], worker: null, secrets: [] }, { TURNSTILE_SITE_KEY: "0x4AAAAAAAmine" });
    const r = turnstile();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.calls).toEqual([]);
  });
});

describe("scripts/ensure-secrets.sh and TURNSTILE_SECRET", () => {
  const deployConfig = (vars: Record<string, string>) =>
    writeFileSync(join(dir, "apps/diffinery/wrangler.deploy.jsonc"), `// Generated by scripts/render-config.mjs; do not edit.\n${JSON.stringify({ name: "diffinery", vars })}\n`);
  const ensure = () => run(["bash", join(dir, "scripts/ensure-secrets.sh")]);

  it("sets it from the deployed site key's widget when it's missing", () => {
    tree({ widgets: [widget()], worker: [], secrets: ["MASTER_KEY", "OIDC_PRIVATE_KEY"] });
    deployConfig({ TURNSTILE_SITE_KEY: "0x4AAAAAAAold" });
    const r = ensure();
    expect(r.status).toBe(0);
    expect(r.puts).toEqual([{ name: "TURNSTILE_SECRET", value: SECRET, args: ["-c", "wrangler.deploy.jsonc"] }]);
    expect(r.stdout).toContain("set TURNSTILE_SECRET");
  });

  it("leaves it alone when it exists, or when no site key was deployed", () => {
    tree({ widgets: [widget()], worker: [], secrets: ["MASTER_KEY", "OIDC_PRIVATE_KEY", "TURNSTILE_SECRET"] });
    deployConfig({ TURNSTILE_SITE_KEY: "0x4AAAAAAAold" });
    expect(ensure().puts).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
    tree({ widgets: [widget()], worker: [], secrets: ["MASTER_KEY", "OIDC_PRIVATE_KEY"] });
    deployConfig({});
    const r = ensure();
    expect(r.puts).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it("warns, naming the permission, and goes on when it can't read the widget's secret", () => {
    tree({ denied: true, widgets: [], worker: [], secrets: ["MASTER_KEY", "OIDC_PRIVATE_KEY"] });
    deployConfig({ TURNSTILE_SITE_KEY: "0x4AAAAAAAold" });
    const r = ensure();
    expect(r.status).toBe(0);
    expect(r.puts).toEqual([]);
    expect(r.stderr).toContain(PERMISSION);
    expect(r.stderr).toContain("::warning::TURNSTILE_SECRET is not set");
  });
});

describe("scripts/render-config.mjs and TURNSTILE_SITE_KEY", () => {
  const render = (env: Record<string, string>) => {
    const r = run(["node", join(dir, "scripts/render-config.mjs"), "--d1", "db-id", "--public-url", "https://git.example.com"], env);
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(readFileSync(join(dir, "apps/diffinery/wrangler.deploy.jsonc"), "utf8").split("\n").slice(1).join("\n")) as { vars: Record<string, string> };
  };

  it("deploys the site key bootstrap passes, unless wrangler.jsonc sets its own", () => {
    tree({ widgets: [], worker: null, secrets: [] });
    expect(render({ TURNSTILE_SITE_KEY: "0x4AAAAAAAold" }).vars.TURNSTILE_SITE_KEY).toBe("0x4AAAAAAAold");
    expect(render({}).vars.TURNSTILE_SITE_KEY).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
    tree({ widgets: [], worker: null, secrets: [] }, { TURNSTILE_SITE_KEY: "0x4AAAAAAAmine" });
    expect(render({ TURNSTILE_SITE_KEY: "0x4AAAAAAAold" }).vars.TURNSTILE_SITE_KEY).toBe("0x4AAAAAAAmine");
    // Keys don't open sign-up: render-config never sets SIGNUP.
    expect(render({ TURNSTILE_SITE_KEY: "0x4AAAAAAAold" }).vars.SIGNUP).toBeUndefined();
  });
});
