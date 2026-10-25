import path from "node:path";
import { enc } from "../api.js";
import { exactlyOne, parseRepoArg, repoPath, str, type Command, type Group } from "../cli.js";
import { basicAuthHeader, gitInteractive, withGitConfig } from "../git.js";
import { CliError } from "../io.js";
import { ago, json, table, truncate } from "../output.js";

export interface RepoJson {
  id: string;
  name: string;
  full_name: string;
  owner: { login: string; type: string };
  private: boolean;
  visibility: "public" | "private";
  description: string | null;
  default_branch: string;
  archived: boolean;
  html_url: string;
  clone_url: string;
  pushed_at: string | null;
  updated_at: string;
  permissions?: { role: string };
  stats?: Record<string, unknown>;
}

const create: Command = {
  name: "repo create",
  summary: "Create a repository",
  args: "<name>",
  options: {
    org: { type: "string", desc: "Create it in this organization", arg: "ORG" },
    private: { type: "boolean", desc: "Only collaborators can see it (default)" },
    public: { type: "boolean", desc: "Anyone can see it" },
    description: { type: "string", short: "d", desc: "Description", arg: "TEXT" },
    "default-branch": { type: "string", desc: "Default branch name", arg: "BRANCH" },
  },
  json: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, o, [name]) {
    const visibility = exactlyOne(o, ["private", "public"], "private");
    const api = await ctx.authedApi();
    const org = str(o, "org");
    const r = await api.post<RepoJson>(org ? `/orgs/${enc(org)}/repos` : "/user/repos", { name, description: str(o, "description"), visibility, default_branch: str(o, "default-branch") });
    if (ctx.json) return json(ctx.io, r);
    ctx.out(`${ctx.c.green("✓")} Created ${ctx.c.bold(r.full_name)} (${r.visibility})`);
    ctx.out(r.html_url);
    ctx.err(ctx.c.dim(`git remote add origin ${r.clone_url}`));
  },
};

const listCmd: Command = {
  name: "repo list",
  summary: "List repositories you can see",
  options: { owner: { type: "string", desc: "Only repositories owned by this user or organization", arg: "OWNER" } },
  json: true,
  maxArgs: 0,
  async run(ctx, o) {
    const api = await ctx.api();
    const owner = str(o, "owner");
    // The server has no /users/:login/repos; /orgs/:owner/repos accepts any account login.
    const repos = await api.get<RepoJson[]>(owner ? `/users/${enc(owner)}/repos` : "/user/repos");
    if (ctx.json) return json(ctx.io, repos);
    if (!repos.length) return ctx.err("No repositories.");
    ctx.io.stdout.write(table(repos.map((r) => [ctx.c.bold(r.full_name), r.archived ? ctx.c.dim("archived") : r.visibility, truncate(r.description, 50), ctx.c.dim(ago(r.pushed_at ?? r.updated_at))])));
  },
};

const view: Command = {
  name: "repo view",
  summary: "Show a repository",
  args: "[OWNER/NAME]",
  repo: true,
  json: true,
  maxArgs: 1,
  async run(ctx, _o, [arg]) {
    const ref = arg ? parseRepoArg(arg) : await ctx.repo();
    const r = await (await ctx.api()).get<RepoJson>(repoPath(ref));
    if (ctx.json) return json(ctx.io, r);
    const c = ctx.c;
    ctx.out(`${c.bold(r.full_name)}  ${c.dim(r.visibility)}${r.archived ? c.yellow("  archived") : ""}`);
    if (r.description) ctx.out(r.description);
    const rows: string[][] = [
      ["default branch", r.default_branch],
      ["web", r.html_url],
      ["clone", r.clone_url],
    ];
    if (r.permissions?.role) rows.push(["your role", r.permissions.role]);
    if (r.pushed_at) rows.push(["last push", ago(r.pushed_at)]);
    for (const [k, v] of Object.entries(r.stats ?? {})) if (typeof v === "number" || typeof v === "string") rows.push([k.replace(/_/g, " "), String(v)]);
    ctx.io.stdout.write(table(rows.map(([k, v]) => [c.dim(k!), v!])));
  },
};

const clone: Command = {
  name: "repo clone",
  summary: "Clone a repository",
  description: "The token is passed to this one git command as an HTTP header and is never written to .git/config.\nRun 'diffinery auth setup-git' so later fetches and pushes authenticate too.",
  args: "<OWNER/NAME> [directory]",
  minArgs: 1,
  maxArgs: 2,
  async run(ctx, _o, [arg, dir]) {
    const ref = parseRepoArg(arg!);
    const cfg = await ctx.config();
    const url = `${cfg.url}/${ref.owner}/${ref.name}.git`;
    const env = cfg.token ? withGitConfig(ctx.io.env, [basicAuthHeader(cfg.url, "x-token", cfg.token), ["protocol.version", "2"]]) : withGitConfig(ctx.io.env, [["protocol.version", "2"]]);
    const code = await gitInteractive(ctx.io, ["clone", url, ...(dir ? [dir] : [])], { env });
    if (code !== 0) throw new CliError(`git clone exited with ${code}`, code);
    ctx.err(ctx.c.dim(`Cloned into ${dir ?? path.basename(ref.name)}. Tip: 'diffinery auth setup-git' lets plain git push/fetch authenticate.`));
  },
};

export const repoGroup: Group = { name: "repo", summary: "Create, list, view and clone repositories", commands: [create, listCmd, view, clone] };
