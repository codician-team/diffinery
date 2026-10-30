import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The GitHub App of GitHub runners on deploy: render-config.mjs takes its IDs from the environment
 * (the Deploy workflow maps the DIFFINERY_GITHUB_APP_* repository variables to them), so the
 * repository's wrangler.jsonc names no instance's app.
 */

const repo = new URL("../../../../", import.meta.url).pathname;
const APP = { GITHUB_APP_ID: "1234567", GITHUB_APP_SLUG: "diffinery-runners", GITHUB_APP_CLIENT_ID: "Iv23liAbCdEf", GITHUB_APP_URL: "https://ghe.example.com" };

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function tree(wranglerVars: Record<string, string> = {}): void {
  dir = mkdtempSync(join(tmpdir(), "github-app-"));
  for (const d of ["scripts", "apps/diffinery"]) mkdirSync(join(dir, d), { recursive: true });
  for (const f of ["jsonc.mjs", "render-config.mjs"]) copyFileSync(join(repo, "scripts", f), join(dir, "scripts", f));
  const cfg = readFileSync(join(repo, "apps/diffinery/wrangler.jsonc"), "utf8");
  const vars = Object.entries(wranglerVars).map(([k, v]) => `\n    ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("");
  writeFileSync(join(dir, "apps/diffinery/wrangler.jsonc"), cfg.replace(/"vars": \{/, `"vars": {${vars}`));
}

function render(env: Record<string, string> = {}) {
  const r = spawnSync("node", [join(dir, "scripts/render-config.mjs"), "--d1", "db-id", "--public-url", "https://git.example.com"], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, ...env },
  });
  const cfg = r.status === 0 ? (JSON.parse(readFileSync(join(dir, "apps/diffinery/wrangler.deploy.jsonc"), "utf8").split("\n").slice(1).join("\n")) as { vars: Record<string, string> }) : null;
  return { status: r.status, stderr: r.stderr, vars: cfg?.vars ?? null };
}

describe("scripts/render-config.mjs and the GitHub App", () => {
  it("sets the app's IDs from the environment, trimmed", () => {
    tree();
    const { vars } = render({ ...APP, GITHUB_APP_SLUG: " diffinery-runners\n" });
    expect(vars).toMatchObject(APP);
  });

  it("leaves them out without the environment: the repository's wrangler.jsonc has none, so the feature is off", () => {
    tree();
    const { vars } = render({ GITHUB_APP_ID: "", GITHUB_APP_SLUG: "" });
    for (const key of Object.keys(APP)) expect(vars).not.toHaveProperty(key);
  });

  it("keeps a copy's own wrangler.jsonc values when the environment has none, and the environment wins over them", () => {
    tree({ GITHUB_APP_ID: "42", GITHUB_APP_SLUG: "own-app" });
    expect(render().vars).toMatchObject({ GITHUB_APP_ID: "42", GITHUB_APP_SLUG: "own-app" });
    expect(render({ GITHUB_APP_ID: "7" }).vars).toMatchObject({ GITHUB_APP_ID: "7", GITHUB_APP_SLUG: "own-app" });
  });

  it("refuses a value of the wrong shape without printing it", () => {
    tree();
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----";
    for (const [key, value, message] of [
      ["GITHUB_APP_ID", pem, "GITHUB_APP_ID must be the App ID, a number"],
      ["GITHUB_APP_SLUG", "Diffinery Runners", "GITHUB_APP_SLUG must be the slug"],
      ["GITHUB_APP_CLIENT_ID", "Iv23li with space", "GITHUB_APP_CLIENT_ID must be the Client ID"],
      ["GITHUB_APP_URL", "https://ghe.example.com/api/v3", "GITHUB_APP_URL must be an https origin"],
    ] as const) {
      const r = render({ [key]: value });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(message);
      expect(r.stderr).not.toContain(value);
    }
  });
});
