import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { Api, ApiError, enc } from "../api.js";
import { Ctx, type RepoRef } from "../cli.js";
import { gitCapture, parseRemote } from "../git.js";
import { CliError } from "../io.js";
import { VERSION } from "../version.js";
import { setupClaudePlugins } from "./claude-plugins.js";

/**
 * `diffinery setup --repo OWNER/NAME`: sets up an agent environment (a Claude Code cloud environment,
 * Codex, a CI runner) for one repository, without a person at the keyboard. What the hosted script
 * (<server>/<owner>/<repo>/agent-setup.sh, from Settings → Agent setup) runs once it has installed the CLI.
 *
 * The token comes from DIFFINERY_TOKEN and is never written to disk: git asks `diffinery auth
 * git-credential`, which reads it from the environment each time, and gh reads GH_ENTERPRISE_TOKEN. So a
 * snapshot of the machine (Claude Code caches what a setup script leaves on disk) holds no credential,
 * and a new token works as soon as the environment variables change. Then a self-test, one line per
 * check saying what to change when it fails, and a report to the repository's Agent setup page (its Check).
 */

export interface CheckLine {
  name: string;
  ok: boolean;
  message: string;
}

interface Proc {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program and captures its output; a program that isn't installed exits 127. */
export function capture(cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; cwd?: string; input?: string }): Promise<Proc> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env: o.env, cwd: o.cwd, stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: 127, stdout: "", stderr: (e as Error).message });
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: (e as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(o.input);
    }
  });
}

/** The gh token environment variables for a host other than github.com, in gh's order. */
const GH_ENTERPRISE_VARS = ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

/** Which environment variable gives gh its token for `host`, if any (gh then refuses `gh auth login`). */
export function ghEnvToken(env: NodeJS.ProcessEnv, host: string): { name: string; value: string } | null {
  if (/^(github\.com|.*\.ghe\.com)$/i.test(host)) return null;
  for (const name of GH_ENTERPRISE_VARS) if (env[name]) return { name, value: env[name]! };
  return null;
}

/** First line of a command's error output, without anything token-like. */
const firstLine = (s: string) =>
  (s.trim().split("\n").find((l) => l.trim()) ?? "")
    .replace(/dfy_[A-Za-z0-9]+/g, "dfy_…")
    .slice(0, 200);

/** Where the clone goes: --clone-dir, DIFFINERY_CLONE_DIR, a Claude Code cloud session's /home/user, or here. */
export function cloneParent(env: NodeJS.ProcessEnv, cwd: string, flag?: string): string {
  const chosen = flag ?? env.DIFFINERY_CLONE_DIR;
  if (chosen) return path.resolve(cwd, chosen);
  // Claude Code cloud sessions start in /home/user, but setup scripts run elsewhere.
  const claude = "/home/user";
  const inside = cwd === claude || cwd.startsWith(`${claude}/`);
  if (!inside && isDir(claude)) return claude;
  return cwd;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `dir`, or a directory above it, is a clone of `repo` on `host`. Returns its top level. */
async function cloneRoot(ctx: Ctx, dir: string, host: string, repo: RepoRef): Promise<string | null> {
  if (!isDir(dir)) return null;
  const top = await gitCapture(ctx.io, ["rev-parse", "--show-toplevel"], { cwd: dir });
  if (top.code !== 0) return null;
  const url = await gitCapture(ctx.io, ["remote", "get-url", "origin"], { cwd: dir });
  const r = url.code === 0 ? parseRemote(url.stdout, host) : null;
  return r && r.owner.toLowerCase() === repo.owner.toLowerCase() && r.name.toLowerCase() === repo.name.toLowerCase() ? top.stdout.trim() : null;
}

/** An executable named `name` in one of PATH's directories. */
async function onPath(name: string, pathVar: string | undefined): Promise<string | null> {
  for (const dir of (pathVar ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      await access(file, constants.X_OK);
      return file;
    } catch {
      /* next */
    }
  }
  return null;
}

export interface AgentSetupOptions {
  repo: RepoRef;
  url: string;
  clone: boolean;
  cloneDir?: string;
  report: boolean;
  claudePlugins: boolean;
}

export async function agentSetup(ctx: Ctx, o: AgentSetupOptions, wireGit: (ctx: Ctx) => Promise<void>): Promise<number> {
  const { io } = ctx;
  const env = io.env;
  const url = o.url;
  const host = new URL(url).host;
  const slug = `${o.repo.owner}/${o.repo.name}`;
  const page = `${url}/${slug}/settings/agent-setup`;
  const lines: CheckLine[] = [];
  const line = (name: string, ok: boolean, message: string) => {
    lines.push({ name, ok, message });
    ctx.out(`${ok ? ctx.c.green("✓") : ctx.c.red("✗")} ${name}: ${message}`);
  };

  const cfg = await ctx.config();
  const token = cfg.token;

  // 1. The server.
  let reachable = false;
  try {
    const res = await fetch(`${url}/healthz`, { headers: { "user-agent": `diffinery-cli/${VERSION}` } });
    reachable = res.ok;
    line("server", res.ok, res.ok ? `${host} is reachable` : `${host} answered ${res.status}; try again in a minute`);
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message;
    line("server", false, `can't reach ${host} (${cause}): allow ${host} in the environment's network settings (Custom with ${host}, or Full)`);
  }

  // 2. The diffinery command, for git's credential helper and for the agent.
  const cmd = await onPath("diffinery", env.DIFFINERY_SETUP_PATH ?? env.PATH);
  line("diffinery on PATH", !!cmd, cmd ? `${cmd} (${VERSION})` : "not on PATH: run the setup script again, or add ~/.diffinery/bin to PATH");

  // 3. The token and what it can do.
  let login: string | null = null;
  let canPush = false;
  if (!token) {
    line("DIFFINERY_TOKEN", false, `not set: add DIFFINERY_TOKEN=<token> to the environment variables (generate one on ${page})`);
  } else if (reachable) {
    const api = new Api(url, token);
    try {
      const me = await api.get<{ login: string; type?: string }>("/user");
      login = me.login;
      line("DIFFINERY_TOKEN", true, `acts as ${me.login}${me.type === "Bot" ? " (agent)" : ""}`);
    } catch (e) {
      line("DIFFINERY_TOKEN", false, e instanceof ApiError && e.status === 401 ? `refused (revoked or expired): generate a new token on ${page} and paste it into DIFFINERY_TOKEN and GH_ENTERPRISE_TOKEN` : firstLine((e as Error).message));
    }
    if (login) {
      try {
        const r = await api.get<{ permissions?: { push?: boolean } }>(`/repos/${enc(o.repo.owner)}/${enc(o.repo.name)}`);
        canPush = !!r.permissions?.push;
        line("repository", canPush, canPush ? `${slug} with write access` : `${login} can read ${slug} but not push: use a token from ${page}`);
      } catch (e) {
        line("repository", false, e instanceof ApiError && e.status === 404 ? `the token can't see ${slug}: use a token from ${page}` : firstLine((e as Error).message));
      }
    }
  }

  // 4. git: the credential helper reads the token from the environment whenever git asks.
  try {
    await wireGit(ctx);
  } catch (e) {
    line("git", false, firstLine((e as Error).message));
  }
  const remote = `${url}/${slug}.git`;
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
  if (token && reachable && !lines.some((l) => l.name === "git")) {
    const r = await gitCapture(io, ["ls-remote", "--heads", remote], { env: gitEnv });
    line("git", r.code === 0, r.code === 0 ? `git can reach ${remote} with no prompt` : `git ls-remote failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
  }

  // 5. The clone.
  let clone: string | null = null;
  if (o.clone && token && reachable) {
    const parent = cloneParent(env, io.cwd, o.cloneDir);
    clone = (await cloneRoot(ctx, io.cwd, host, o.repo)) ?? null;
    const target = clone ?? path.join(parent, o.repo.name);
    if (!clone && existsSync(target)) {
      clone = await cloneRoot(ctx, target, host, o.repo);
      if (!clone) line("clone", false, `${target} exists and isn't a clone of ${slug}: move it, or set DIFFINERY_CLONE_DIR to another directory`);
    }
    if (clone) {
      const f = await gitCapture(io, ["fetch", "--quiet", "origin"], { cwd: clone, env: gitEnv });
      let note = "fetched";
      if (f.code === 0) {
        // A clean checkout moves up to its branch on the server, as a fresh clone would be.
        const dirty = (await gitCapture(io, ["status", "--porcelain"], { cwd: clone })).stdout.trim();
        const up = await gitCapture(io, ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: clone });
        if (!dirty && up.code === 0 && (await gitCapture(io, ["merge", "--ff-only", "--quiet", up.stdout.trim()], { cwd: clone })).code === 0) note = "up to date";
      }
      line("clone", f.code === 0, f.code === 0 ? `${clone} (${note})` : `git fetch failed in ${clone}: ${firstLine(f.stderr)}`);
    } else if (!lines.some((l) => l.name === "clone")) {
      const r = await gitCapture(io, ["clone", "--quiet", remote, target], { env: gitEnv });
      if (r.code === 0) clone = target;
      line("clone", r.code === 0, r.code === 0 ? `cloned into ${target}` : `git clone failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
    }
  }

  // 6. gh: GH_ENTERPRISE_TOKEN in the environment, or gh's own sign-in when it isn't set.
  const ghVersion = await capture("gh", ["--version"], { env });
  if (ghVersion.code !== 0) {
    line("gh", true, "skipped: the GitHub CLI isn't installed (install it for gh pr and gh api: https://cli.github.com)");
  } else if (token && reachable && login) {
    const fromEnv = ghEnvToken(env, host);
    let ready = true;
    if (fromEnv && fromEnv.value !== token) {
      line("gh", false, `${fromEnv.name} isn't the same token as DIFFINERY_TOKEN: paste the same token into both`);
      ready = false;
    } else if (!fromEnv) {
      // No token for gh in the environment: sign gh in with this one (gh keeps it in its own config).
      const r = await capture("gh", ["auth", "login", "--hostname", host, "--with-token", "--git-protocol", "https"], { env, input: `${token}\n` });
      if (r.code !== 0) {
        line("gh", false, `gh auth login failed: ${firstLine(r.stderr)}; or add GH_ENTERPRISE_TOKEN=<token> and GH_HOST=${host} to the environment variables`);
        ready = false;
      }
    }
    if (ready && fromEnv && env.GH_HOST !== host) {
      line("GH_HOST", false, env.GH_HOST ? `is ${env.GH_HOST}: set GH_HOST=${host} in the environment variables` : `not set: add GH_HOST=${host} to the environment variables`);
      ready = false;
    }
    if (ready) {
      const r = await capture("gh", ["api", "user", "--hostname", host, "--jq", ".login"], { env });
      const who = r.stdout.trim();
      line("gh", r.code === 0 && who === login, r.code === 0 ? (who === login ? `gh api acts as ${who}` : `gh acts as ${who}, not ${login}: paste the same token into GH_ENTERPRISE_TOKEN and DIFFINERY_TOKEN`) : `gh api user failed: ${firstLine(r.stderr)}`);
      if (clone && r.code === 0 && who === login) {
        const prs = await capture("gh", ["pr", "list", "--state", "all", "--limit", "1", "--json", "number"], { env, cwd: clone });
        line("gh in the clone", prs.code === 0, prs.code === 0 ? "gh pr list works in the clone" : `gh pr list failed in ${clone}: ${firstLine(prs.stderr)}`);
      }
    }
  }

  // 7. Claude Code's Diffinery plugins, where Claude Code runs (a Claude Code cloud environment).
  if (reachable && o.claudePlugins) {
    try {
      // Claude Code cloud sessions start in /home/user (as for the clone above).
      const p = await setupClaudePlugins(env, url, isDir("/home/user"));
      if (p) line("Claude Code plugins", p.ok, p.message);
    } catch (e) {
      line("Claude Code plugins", false, firstLine((e as Error).message));
    }
  }

  // 8. The report, which is the Check on the repository's Agent setup page.
  const ok = lines.every((l) => l.ok);
  if (o.report && token && reachable && login) {
    try {
      await new Api(url, token).post(`/repos/${enc(o.repo.owner)}/${enc(o.repo.name)}/diffinery/agent-setup/checks`, { checks: lines, cli_version: VERSION });
      ctx.out(ctx.c.dim(`Reported to ${page}`));
    } catch (e) {
      ctx.err(`${ctx.c.yellow("warning:")} couldn't report the check to ${page}: ${firstLine((e as Error).message)}`);
    }
  }
  const failed = lines.filter((l) => !l.ok).length;
  ctx.out("");
  ctx.out(ok ? `${ctx.c.green("✓")} Ready: git, gh and the diffinery CLI work with ${slug}${clone ? ` (in ${clone})` : ""}.` : `${ctx.c.red("✗")} ${failed} of ${lines.length} checks failed; fix them as each line says, then run this again.`);
  return ok ? 0 : 1;
}

/** Parses --repo for setup, which must name the repository explicitly. */
export function setupRepo(v: string): RepoRef {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)$/.exec(v.trim().replace(/\.git$/, ""));
  if (!m) throw new CliError(`--repo expects OWNER/NAME, got "${v}"`, 2);
  return { owner: m[1]!, name: m[2]! };
}

