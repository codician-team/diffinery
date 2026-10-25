import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Codex's `diffinery` MCP server, pointed at a self-hosted Diffinery by `diffinery setup`. The Codex plugin's
 * server is https://diffinery.com/mcp (Codex has no plugin settings to change it), and a server of the same
 * name in Codex's own config replaces it, so for another instance this adds that server to config.toml.
 * Not with `codex mcp add`, which starts a browser sign-in for a server that offers OAuth and waits for it.
 * Nothing happens for diffinery.com, or where Codex isn't installed.
 */

const DEFAULT_URL = "https://diffinery.com";

function codex(env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("codex", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: 127, stdout: "", stderr: (e as Error).message });
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export interface CodexResult {
  ok: boolean;
  message: string;
}

/** Null when there's nothing to do: diffinery.com, DIFFINERY_NO_CODEX, or no `codex` on PATH. */
export async function setupCodexMcp(env: NodeJS.ProcessEnv, url: string): Promise<CodexResult | null> {
  if (url === DEFAULT_URL || env.DIFFINERY_NO_CODEX) return null;
  const want = `${url}/mcp`;
  // The server Codex uses now: the user's own, else the plugin's, else none (exit status 1).
  const got = await codex(env, ["mcp", "get", "diffinery", "--json"]);
  if (got.code === 127) return null;
  let bearer: string | null = null;
  if (got.code === 0) {
    try {
      const t = (JSON.parse(got.stdout) as { transport?: { url?: unknown; bearer_token_env_var?: unknown } }).transport ?? {};
      if (t.url === want) return { ok: true, message: `the diffinery MCP server is ${want}` };
      // A headless setup that sends DIFFINERY_TOKEN keeps doing so.
      if (typeof t.bearer_token_env_var === "string") bearer = t.bearer_token_env_var;
    } catch {
      // An answer we can't read: add the server all the same.
    }
  }
  const home = env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(env.HOME || homedir(), ".codex");
  const file = path.join(home, "config.toml");
  const text = await readFile(file, "utf8").catch(() => "");
  // A server of the user's own goes first (codex removes it however it's written); the plugin's stays.
  if (/^\s*\[\s*mcp_servers\s*\.\s*"?diffinery"?\s*\]/m.test(text) || /^\s*mcp_servers\s*\.\s*"?diffinery"?\s*[.=]/m.test(text)) {
    const rm = await codex(env, ["mcp", "remove", "diffinery"]);
    if (rm.code !== 0) return { ok: false, message: `codex mcp remove diffinery failed: ${(rm.stderr.trim().split("\n")[0] || `exit status ${rm.code}`).slice(0, 200)}` };
  }
  const now = await readFile(file, "utf8").catch(() => "");
  const table = `[mcp_servers.diffinery]\nurl = ${JSON.stringify(want)}\n${bearer ? `bearer_token_env_var = ${JSON.stringify(bearer)}\n` : ""}`;
  await mkdir(home, { recursive: true });
  await appendFile(file, `${now && !now.endsWith("\n") ? "\n" : ""}${now ? "\n" : ""}${table}`);
  const check = await codex(env, ["mcp", "get", "diffinery", "--json"]);
  if (!check.stdout.includes(JSON.stringify(want).slice(1, -1))) return { ok: false, message: `Codex doesn't read the diffinery server added to ${file}: check that file` };
  return { ok: true, message: `the diffinery MCP server is now ${want} (sign in with: codex mcp login diffinery)` };
}
