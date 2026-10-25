import { Api, ApiError } from "../api.js";
import { Ctx, str, type Command, type Group } from "../cli.js";
import { DEFAULT_URL, normalizeUrl, readConfig, resolveConfig, writeConfig } from "../config.js";
import { spawn } from "node:child_process";
import { gitCapture } from "../git.js";
import { CliError, promptYesNo, readAll } from "../io.js";
import { browserLikely, browserLogin, deviceLogin, revokeCliToken, type Scope } from "../login.js";
import { json } from "../output.js";
import { agentSetup, ghEnvToken, setupRepo } from "./agent-setup.js";
import { setupClaudePlugins } from "./claude-plugins.js";

interface User {
  login: string;
  name?: string | null;
  type?: string;
  email?: string | null;
  html_url?: string;
}

const SCOPES = ["read", "write", "admin"] as const;

const login: Command = {
  name: "login",
  summary: "Sign in through your browser (or with a token)",
  description: `Opens your browser on the server's authorize page; approve the sign-in there and the CLI
gets its own token, valid for 90 days and listed under Settings → Access tokens.

On a machine without a browser (over SSH, in a container), --device prints a short code to
enter at <server>/login/device from any browser; the CLI picks this by itself when it sees no
display. For scripts and CI, pass a token with --token, or pipe one in with --with-token
(piping into a plain \`diffinery login\` still works). The config file is written with mode 0600.`,
  options: {
    url: { type: "string", desc: "Server URL (default: DIFFINERY_URL, the saved URL, or https://diffinery.com)", arg: "URL" },
    scope: { type: "string", desc: "Access to ask for: read, write (default) or admin. You can change it on the authorize page", arg: "SCOPE" },
    web: { type: "boolean", desc: "Sign in through the browser on this computer (the default in a terminal)" },
    device: { type: "boolean", desc: "Sign in with a code you enter in a browser on any device" },
    token: { type: "string", desc: "Use this token (dfy_...) instead of signing in through the browser", arg: "TOKEN" },
    "with-token": { type: "boolean", desc: "Read a token from stdin" },
  },
  maxArgs: 0,
  async run(ctx, o) {
    const stored = await readConfig(ctx.io.env);
    const cfg = await resolveConfig(ctx.io);
    const url = str(o, "url") ? normalizeUrl(str(o, "url")!) : cfg.url;
    const scope = (str(o, "scope") ?? "write") as Scope;
    if (!SCOPES.includes(scope)) throw new CliError(`--scope must be one of ${SCOPES.join(", ")}`, 2);
    const modes = (["web", "device", "with-token"] as const).filter((k) => o[k] === true);
    if (modes.length + (str(o, "token") !== undefined ? 1 : 0) > 1) throw new CliError("use only one of --web, --device, --token and --with-token", 2);

    let token: string;
    let note = "";
    if (str(o, "token") !== undefined || o["with-token"] || (!modes.length && !ctx.io.stdin.isTTY)) {
      token = (str(o, "token") ?? (await readAll(ctx.io.stdin)).replace(/\r?\n$/, "")).trim();
      if (!token) throw new CliError(o["with-token"] || str(o, "token") !== undefined ? "no token given" : "no token on stdin; run `diffinery login` in a terminal to sign in through your browser, or pass --token");
    } else {
      const device = o.device === true || (o.web !== true && !browserLikely(ctx.io));
      const grant = device ? await deviceLogin(ctx, url, scope) : await browserLogin(ctx, url, scope);
      token = grant.access_token;
      note = ` with ${grant.scope} access until ${new Date(grant.expires_at).toLocaleDateString("en-US", { dateStyle: "medium" })}`;
    }
    const me = await new Api(url, token).get<User>("/user");
    const file = await writeConfig(ctx.io.env, { ...stored, url, token });
    // The token this one replaces: revoke it if a CLI sign-in made it (never a token someone pasted, which may be used elsewhere).
    if (stored.token && stored.token !== token) await revokeCliToken(stored.url ? normalizeUrl(stored.url) : url, stored.token);
    ctx.out(`${ctx.c.green("✓")} Logged in to ${url} as ${ctx.c.bold(me.login)}${me.type === "Bot" ? " (agent)" : ""}${note}`);
    ctx.err(ctx.c.dim(`Saved to ${file}`));
    if (ctx.io.env.DIFFINERY_TOKEN) ctx.err(ctx.c.yellow("note: DIFFINERY_TOKEN is set and overrides the saved token"));
  },
};

const logout: Command = {
  name: "logout",
  summary: "Sign out: forget the saved token, and revoke it if a browser sign-in created it",
  maxArgs: 0,
  async run(ctx) {
    const stored = await readConfig(ctx.io.env);
    if (!stored.token) ctx.out("Not logged in.");
    else {
      const url = stored.url ? normalizeUrl(stored.url) : DEFAULT_URL;
      const revoked = await revokeCliToken(url, stored.token);
      await writeConfig(ctx.io.env, { url: stored.url });
      ctx.out(`Logged out of ${url}${revoked ? " and revoked the CLI's token" : ""}.`);
    }
    if (ctx.io.env.DIFFINERY_TOKEN) ctx.err(ctx.c.yellow("note: DIFFINERY_TOKEN is still set in your environment"));
  },
};

const whoami: Command = {
  name: "whoami",
  summary: "Show the account the current token acts as",
  json: true,
  maxArgs: 0,
  async run(ctx) {
    const cfg = await ctx.config();
    const me = await (await ctx.authedApi()).get<User>("/user");
    if (ctx.json) return json(ctx.io, me);
    ctx.out(`${ctx.c.bold(me.login)}${me.name && me.name !== me.login ? ` (${me.name})` : ""}${me.type === "Bot" ? " [agent]" : ""}`);
    ctx.out(ctx.c.dim(`${cfg.url} · token from ${cfg.tokenSource === "env" ? "DIFFINERY_TOKEN" : cfg.file}`));
  },
};

const setupGit: Command = {
  name: "auth setup-git",
  summary: "Make git use your Diffinery token for HTTPS remotes",
  description: `Runs: git config --global credential.<url>.helper "!diffinery auth git-credential"
(after resetting other helpers for that URL), so clone/fetch/push to the Diffinery host
authenticate with the token from the config file or DIFFINERY_TOKEN.`,
  maxArgs: 0,
  async run(ctx) {
    const cfg = await ctx.config();
    const key = `credential.${cfg.url}.helper`;
    await gitCapture(ctx.io, ["config", "--global", "--unset-all", key]);
    // An empty helper resets the list so a generic helper (e.g. a keychain) does not answer first.
    for (const value of ["", "!diffinery auth git-credential"]) {
      const r = await gitCapture(ctx.io, ["config", "--global", "--add", key, value]);
      if (r.code !== 0) throw new CliError(`git config failed: ${r.stderr.trim()}`);
    }
    ctx.out(`${ctx.c.green("✓")} git will use diffinery for ${cfg.url}`);
  },
};

/** Runs gh with `input` on stdin; output is captured, so a token on stdin never reaches the terminal. */
function ghCapture(env: NodeJS.ProcessEnv, args: string[], input: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("gh", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: 127, stderr: String((e as Error).message) });
    }
    let stderr = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: 127, stderr: (e as NodeJS.ErrnoException).code === "ENOENT" ? "gh is not installed (https://cli.github.com)" : e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const setupGh: Command = {
  name: "auth setup-gh",
  summary: "Sign the GitHub CLI (gh) in to Diffinery with your token",
  description: `Runs: gh auth login --hostname <host> --with-token --git-protocol https, with the token
from the config file or DIFFINERY_TOKEN on its standard input. gh then treats the Diffinery host
like GitHub Enterprise Server: gh pr create, view, checks, status, merge and the rest work in
clones of Diffinery repositories, and so does the pull request badge of Claude Code, which
asks gh for its token.`,
  maxArgs: 0,
  async run(ctx) {
    const cfg = await ctx.config();
    if (!cfg.token) throw new CliError("not logged in: run `diffinery login` or set DIFFINERY_TOKEN");
    const url = new URL(cfg.url);
    if (url.protocol !== "https:") throw new CliError(`gh only talks to hosts over HTTPS; ${cfg.url} is ${url.protocol.replace(/:$/, "")}`);
    // gh refuses to sign in while a token for the host is in its environment, and uses that one instead.
    const fromEnv = ghEnvToken(ctx.io.env, url.host);
    if (fromEnv) {
      if (fromEnv.value !== cfg.token) throw new CliError(`gh uses ${fromEnv.name} from the environment for ${url.host}, which isn't your Diffinery token: set it to the same token, or unset it`);
      ctx.out(`${ctx.c.green("✓")} gh uses ${fromEnv.name} for ${url.host}${ctx.io.env.GH_HOST === url.host ? "" : ` (set GH_HOST=${url.host} too, so gh finds it in clones)`}`);
      return;
    }
    const r = await ghCapture(ctx.io.env, ["auth", "login", "--hostname", url.host, "--with-token", "--git-protocol", "https"], `${cfg.token}\n`);
    if (r.code !== 0) throw new CliError(`gh auth login failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    ctx.out(`${ctx.c.green("✓")} gh is signed in to ${url.host}`);
  },
};

/** Parses the git credential helper protocol's key=value lines. */
export function parseCredentialInput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line) break;
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const gitCredential: Command = {
  name: "auth git-credential",
  summary: "Git credential helper (used by 'auth setup-git')",
  args: "<get|store|erase>",
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, _o, [op]) {
    const input = parseCredentialInput(await readAll(ctx.io.stdin));
    if (op !== "get") return; // store/erase: the token lives in the config file
    const cfg = await ctx.config();
    if (!cfg.token) return;
    const want = new URL(cfg.url);
    const proto = (input.protocol ?? "").toLowerCase();
    const host = (input.host ?? "").toLowerCase();
    if (proto !== want.protocol.replace(/:$/, "") || host !== want.host.toLowerCase()) return;
    ctx.io.stdout.write(`protocol=${proto}\nhost=${input.host}\nusername=x-token\npassword=${cfg.token}\n`);
  },
};

const mcpConfig: Command = {
  name: "mcp-config",
  summary: "Print an MCP server config snippet for Claude Code and other MCP clients",
  description: `By default the token is written as \${DIFFINERY_TOKEN} (expanded by clients such as
Claude Code from the environment). Pass --show-token to embed the saved token instead.`,
  options: { "show-token": { type: "boolean", desc: "Embed the actual token in the snippet" } },
  maxArgs: 0,
  async run(ctx, o) {
    const cfg = await ctx.config();
    let token = "${DIFFINERY_TOKEN}";
    if (o["show-token"]) {
      if (!cfg.token) throw new CliError("not logged in: run `diffinery login` or set DIFFINERY_TOKEN");
      token = cfg.token;
    }
    json(ctx.io, { mcpServers: { diffinery: { type: "http", url: `${cfg.url}/mcp`, headers: { Authorization: `Bearer ${token}` } } } });
  },
};

/** The signed-in account, or null when there is no token or the server turns it down. */
async function signedInAs(url: string, token: string | null): Promise<User | null> {
  if (!token) return null;
  try {
    return await new Api(url, token).get<User>("/user");
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

/**
 * The last step of `diffinery setup` for a person: offer to turn on auto-merge for the pull requests they open
 * (Settings → Pull requests), asked on a terminal only, or turned on straight away with --auto-merge.
 */
async function offerAutoMerge(ctx: Ctx, url: string, o: { yes: boolean; skip: boolean }): Promise<void> {
  if (o.skip) return;
  const api = await ctx.authedApi();
  const [me, now] = await Promise.all([api.get<User>("/user").catch(() => null), api.get<{ enabled: boolean }>("/diffinery/auto-merge").catch(() => null)]);
  // An agent's owner sets it for the agent; and a server without the setting has nothing to offer.
  if (!me || me.type === "Bot" || !now) return;
  const page = `${url}/settings/pull-requests`;
  if (now.enabled) return ctx.out(`${ctx.c.green("✓")} Auto-merge turns on by itself for pull requests you open (${page})`);
  let yes = o.yes;
  if (!yes) {
    if (!ctx.io.stdin.isTTY) return;
    ctx.out("");
    ctx.out("Pull requests can merge by themselves once their checks pass: Diffinery turns on auto-merge as you open each one,");
    ctx.out("wherever the branch has required checks, and it still waits for every rule of the branch, approvals included.");
    yes = await promptYesNo(ctx.io, "Turn on auto-merge for pull requests you open? [y/N] ");
  }
  if (!yes) return ctx.err(ctx.c.dim(`Auto-merge stays off. Turn it on in ${page}, or for one pull request with diffinery pr create --auto.`));
  await api.put("/diffinery/auto-merge", { enabled: true });
  ctx.out(`${ctx.c.green("✓")} Auto-merge turns on by itself for pull requests you open (change it in ${page})`);
}

const setup: Command = {
  name: "setup",
  summary: "Set up this computer in one go: sign in, then git and gh",
  description: `Signs in through your browser (or with a code, on a machine without one) unless the CLI is
signed in already, then runs \`diffinery auth setup-git\` so git clone, fetch and push use the
sign-in, and \`diffinery auth setup-gh\` when the GitHub CLI (gh) is installed. Where Claude Code is
installed, it also adds Claude Code's Diffinery plugins (diffinery and diffinery-ci): they're saved in
~/.claude/diffinery-plugins and named in ~/.claude/settings.json, so every new Claude Code session loads
them. Skip that with --no-claude-plugins (or DIFFINERY_NO_CLAUDE_PLUGINS=1). Last, on a terminal, it asks
whether to turn on auto-merge for the pull requests you open (--auto-merge says yes without asking,
--no-auto-merge skips the question). Safe to run again; it brings the plugins up to date.

With --repo OWNER/NAME it sets up an agent environment instead (a Claude Code cloud environment,
Codex, a CI runner), with no browser and no prompt: git and gh use the token in DIFFINERY_TOKEN
(and GH_ENTERPRISE_TOKEN with GH_HOST for gh) straight from the environment, so no token is written
to disk; the repository is cloned unless it's there already; then a self-test prints one line per
check, saying what to change when one fails, and reports the result to the repository's Agent setup
page. Exits 1 when a check fails. This is what <server>/OWNER/NAME/agent-setup.sh runs.`,
  options: {
    url: login.options!.url!,
    scope: login.options!.scope!,
    web: login.options!.web!,
    device: login.options!.device!,
    repo: { type: "string", desc: "Set up an agent environment for this repository instead, with the token in DIFFINERY_TOKEN (what <server>/OWNER/NAME/agent-setup.sh runs)", arg: "OWNER/NAME" },
    "no-clone": { type: "boolean", desc: "With --repo: don't clone the repository (also DIFFINERY_NO_CLONE=1)" },
    "clone-dir": { type: "string", desc: "With --repo: where the clone goes (default: DIFFINERY_CLONE_DIR, /home/user in a Claude Code cloud environment, else the current directory)", arg: "DIR" },
    "no-report": { type: "boolean", desc: "With --repo: don't report the result to the repository's Agent setup page" },
    "no-claude-plugins": { type: "boolean", desc: "Don't add Claude Code's Diffinery plugins (also DIFFINERY_NO_CLAUDE_PLUGINS=1)" },
    "auto-merge": { type: "boolean", desc: "Turn on auto-merge for pull requests you open, without asking (it still waits for each branch's required checks and approvals)" },
    "no-auto-merge": { type: "boolean", desc: "Don't ask about auto-merge" },
  },
  maxArgs: 0,
  async run(ctx, o) {
    if (str(o, "repo") !== undefined) {
      // Run by a setup script: never a browser, never a prompt.
      const cfg = await ctx.config();
      const url = str(o, "url") ? normalizeUrl(str(o, "url")!) : cfg.url;
      let next = ctx;
      if (url !== cfg.url) {
        if (cfg.urlSource === "env") throw new CliError(`DIFFINERY_URL is ${cfg.url}, but this sets up ${url}: unset DIFFINERY_URL or set it to ${url}`, 2);
        // The server is saved (its URL only: a saved token belongs to the other server), so git's credential
        // helper and later commands use it in sessions that don't set DIFFINERY_URL.
        await writeConfig(ctx.io.env, { url });
        next = new Ctx(ctx.io, ctx.opts);
      }
      return agentSetup(next, { repo: setupRepo(str(o, "repo")!), url, clone: o["no-clone"] !== true && !ctx.io.env.DIFFINERY_NO_CLONE, cloneDir: str(o, "clone-dir"), report: o["no-report"] !== true, claudePlugins: o["no-claude-plugins"] !== true }, (c) => setupGit.run(new Ctx(c.io, {}), {}, []) as Promise<void>);
    }
    const cfg = await ctx.config();
    const url = str(o, "url") ? normalizeUrl(str(o, "url")!) : cfg.url;
    const me = url === cfg.url ? await signedInAs(url, cfg.token) : null;
    if (me) ctx.out(`${ctx.c.green("✓")} Signed in to ${url} as ${ctx.c.bold(me.login)}${me.type === "Bot" ? " (agent)" : ""}`);
    else {
      // Unlike login, setup never reads a token from stdin: run by an agent or a script, it still signs in a person.
      const how = o.web === true || o.device === true ? {} : browserLikely(ctx.io) ? { web: true } : { device: true };
      await login.run(ctx, { ...o, ...how }, []);
    }
    // A fresh context, so the next steps read the sign-in just saved.
    const next = new Ctx(ctx.io, {});
    await setupGit.run(next, {}, []);
    let failed = false;
    if (new URL(url).protocol !== "https:") ctx.err(ctx.c.dim("Skipped gh: it only talks to hosts over HTTPS."));
    else if ((await ghCapture(ctx.io.env, ["--version"], "")).code !== 0) ctx.err(ctx.c.dim("Skipped gh, which isn't installed. Run `diffinery auth setup-gh` after installing it (https://cli.github.com)."));
    else
      try {
        await setupGh.run(next, {}, []);
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
        ctx.err(`${ctx.c.yellow("warning:")} ${e.message}`);
        failed = true;
      }
    if (o["no-claude-plugins"] !== true) {
      try {
        const p = await setupClaudePlugins(ctx.io.env, url);
        if (p?.ok) ctx.out(`${ctx.c.green("✓")} Claude Code plugins: ${p.message}`);
        else if (p) {
          ctx.err(`${ctx.c.yellow("warning:")} Claude Code plugins: ${p.message}`);
          failed = true;
        }
      } catch (e) {
        ctx.err(`${ctx.c.yellow("warning:")} Claude Code plugins: ${(e as Error).message}`);
        failed = true;
      }
    }
    try {
      await offerAutoMerge(new Ctx(ctx.io, {}), url, { yes: o["auto-merge"] === true, skip: o["no-auto-merge"] === true });
    } catch (e) {
      ctx.err(`${ctx.c.yellow("warning:")} auto-merge: ${(e as Error).message}`);
    }
    ctx.out("");
    ctx.out(`Connect Claude Code, Codex, Cursor and other AI apps: ${url}/docs/connect`);
    return failed ? 1 : 0;
  },
};

export const authCommands: Command[] = [login, logout, whoami, setup, mcpConfig];
export const authGroup: Group = { name: "auth", summary: "Git and GitHub CLI integration", commands: [setupGit, setupGh, gitCredential] };
