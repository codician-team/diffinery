import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { VERSION } from "../version.js";

/**
 * Claude Code's Diffinery plugins, set up by `diffinery setup` with nothing else to do: the `diffinery`
 * plugin (skill, /diffinery:pr-status, MCP server) and `diffinery-ci` (live CI band and pane, and a note
 * to Claude when CI on a commit it pushed settles). The server serves them at <server>/-/claude/<name>.zip;
 * they're saved in Claude Code's settings directory and named in the `env` block of its user settings as
 * CLAUDE_CODE_PLUGIN_DIRS, which Claude Code reads at the start of every session: the terminal, the
 * desktop app, VS Code, and cloud sessions and project threads, whose setup script runs this. A cloud
 * environment keeps them in its snapshot. Running it again brings them up to date.
 */

export const CLAUDE_PLUGINS = ["diffinery", "diffinery-ci"] as const;

/** Where Claude Code keeps its user settings: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(env.HOME || homedir(), ".claude");
}

/** Whether Claude Code is on this machine: its settings directory exists, or `claude` is on PATH. */
export function hasClaude(env: NodeJS.ProcessEnv): boolean {
  if (isDir(claudeDir(env))) return true;
  return (env.PATH ?? "").split(path.delimiter).some((d) => d && existsSync(path.join(d, "claude")));
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** CLAUDE_CODE_PLUGIN_DIRS with ours in place of any earlier copy of them, others kept in their order. */
export function withOurs(current: string | undefined, ours: string[]): string {
  const names = new Set(ours.map((p) => path.basename(p)));
  const kept = (current ?? "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter((p) => p && !(path.basename(path.dirname(p)) === "diffinery-plugins" && names.has(path.basename(p))) && !ours.includes(p));
  return [...kept, ...ours].join(path.delimiter);
}

export interface PluginsResult {
  ok: boolean;
  message: string;
}

/**
 * Downloads the plugins and names them in Claude Code's user settings. Returns the check line's
 * outcome, or null when there's nothing to do here (no Claude Code, or DIFFINERY_NO_CLAUDE_PLUGINS).
 * `claudeCloud`: a Claude Code cloud environment, whose setup script may run before Claude Code has
 * made its settings directory.
 */
export async function setupClaudePlugins(env: NodeJS.ProcessEnv, url: string, claudeCloud = false): Promise<PluginsResult | null> {
  if (env.DIFFINERY_NO_CLAUDE_PLUGINS) return null;
  if (!claudeCloud && !hasClaude(env)) return null;
  const dir = claudeDir(env);
  const settingsFile = path.join(dir, "settings.json");

  // Read the settings first: a file we can't read as JSON is left as it is.
  let settings: Record<string, unknown> = {};
  try {
    const text = await readFile(settingsFile, "utf8");
    const parsed: unknown = text.trim() ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    settings = parsed as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, message: `${settingsFile} isn't valid JSON, so it was left alone: fix it, then run this again` };
  }

  // A plugin already installed from the Diffinery marketplace (`claude plugin install`) stays as it is.
  const enabled = settings.enabledPlugins && typeof settings.enabledPlugins === "object" ? Object.keys(settings.enabledPlugins as object) : [];
  const wanted = CLAUDE_PLUGINS.filter((n) => !enabled.some((k) => k.startsWith(`${n}@`) && (settings.enabledPlugins as Record<string, unknown>)[k] !== false));
  const fromMarketplace = CLAUDE_PLUGINS.filter((n) => !wanted.includes(n));

  const target = path.join(dir, "diffinery-plugins");
  await mkdir(target, { recursive: true });
  const got: string[] = [];
  const files: string[] = [];
  for (const name of wanted) {
    let res: Response;
    try {
      res = await fetch(`${url}/-/claude/${name}.zip`, { headers: { "user-agent": `diffinery-cli/${VERSION}` } });
    } catch (e) {
      return { ok: false, message: `couldn't download the ${name} plugin: ${(e as Error).message}` };
    }
    if (!res.ok) return { ok: false, message: `couldn't download the ${name} plugin: ${url} answered ${res.status}` };
    const body = Buffer.from(await res.arrayBuffer());
    const sha = res.headers.get("x-diffinery-plugin-sha256");
    if (!sha || createHash("sha256").update(body).digest("hex") !== sha) return { ok: false, message: `the ${name} plugin download didn't match its checksum: run this again` };
    const file = path.join(target, `${name}.zip`);
    await writeFile(`${file}.tmp`, body);
    await rename(`${file}.tmp`, file);
    files.push(file);
    got.push(`${name} ${res.headers.get("x-diffinery-plugin-version") ?? ""}`.trim());
  }

  if (files.length) {
    const block = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? (settings.env as Record<string, unknown>) : {};
    const current = typeof block.CLAUDE_CODE_PLUGIN_DIRS === "string" ? block.CLAUDE_CODE_PLUGIN_DIRS : undefined;
    const next = { ...settings, env: { ...block, CLAUDE_CODE_PLUGIN_DIRS: withOurs(current, files) } };
    await writeFile(`${settingsFile}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
    await rename(`${settingsFile}.tmp`, settingsFile);
  }
  const parts = [];
  if (got.length) parts.push(`${got.join(" and ")} load in new Claude Code sessions (named in ${settingsFile})`);
  if (fromMarketplace.length) parts.push(`${fromMarketplace.join(" and ")} already installed from the Diffinery marketplace`);
  return { ok: true, message: parts.join("; ") };
}
