import { readFile } from "node:fs/promises";
import path from "node:path";
import { enc } from "../api.js";
import { list, positiveInt, repoPath, str, type Command, type Group } from "../cli.js";
import { CliError, ExitCode, readAll, valueFromFlagOrStdin } from "../io.js";
import { ago, json, table } from "../output.js";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function checkName(name: string, what: string): string {
  if (!NAME_RE.test(name)) throw new CliError(`invalid ${what} name "${name}": use letters, digits and _, not starting with a digit`, 2);
  return name;
}

// ---------------------------------------------------------------- secrets

const secretSet: Command = {
  name: "secret set",
  summary: "Create or update an Actions secret",
  description: `The value comes from --body, from stdin when piped, or a hidden prompt.
Repository level by default; --org sets an organization secret. An organization secret
reaches every repository unless --visibility (or --repos, which implies selected) says otherwise.`,
  args: "<NAME>",
  options: {
    body: { type: "string", short: "b", desc: "Secret value", arg: "VALUE" },
    org: { type: "string", short: "o", desc: "Set an organization secret instead", arg: "ORG" },
    visibility: { type: "string", desc: "Organization secrets: which repositories get it (all, private or selected)", arg: "all|private|selected" },
    repos: { type: "string", desc: "Organization secrets: the repositories that get it, comma separated", arg: "a,b" },
  },
  repo: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, o, [name]) {
    checkName(name!, "secret");
    const org = str(o, "org");
    const target = org ? `/orgs/${enc(org)}/actions/secrets/${enc(name!)}` : `${repoPath(await ctx.repo())}/actions/secrets/${enc(name!)}`;
    const repos = (str(o, "repos") ?? "").split(",").map((r) => r.trim()).filter(Boolean);
    const visibility = str(o, "visibility") ?? (repos.length ? "selected" : undefined);
    if ((visibility || repos.length) && !org) throw new CliError("--visibility and --repos are for organization secrets (--org)", 2);
    if (visibility && !["all", "private", "selected"].includes(visibility)) throw new CliError("--visibility must be all, private or selected", 2);
    if (visibility === "selected" && !repos.length) throw new CliError("--visibility selected needs --repos", 2);
    if (repos.length && visibility !== "selected") throw new CliError("--repos needs --visibility selected", 2);
    const value = await valueFromFlagOrStdin(ctx.io, str(o, "body"), `Value for ${name}: `);
    if (!value) throw new CliError("secret value is empty");
    const api = await ctx.authedApi();
    const ids = await Promise.all(repos.map(async (r) => (await api.get<{ id: number }>(`/repos/${enc(org!)}/${enc(r.replace(/^.*\//, ""))}`)).id));
    await api.put(target, { value, ...(visibility ? { visibility } : {}), ...(ids.length ? { selected_repository_ids: ids } : {}) });
    ctx.out(`${ctx.c.green("✓")} Set secret ${name}${org ? ` for ${org}` : ""}`);
  },
};

const secretList: Command = {
  name: "secret list",
  summary: "List Actions secret names",
  options: { org: { type: "string", short: "o", desc: "List organization secrets instead", arg: "ORG" } },
  repo: true,
  json: true,
  maxArgs: 0,
  async run(ctx, o) {
    const org = str(o, "org");
    const path = org ? `/orgs/${enc(org)}/actions/secrets` : `${repoPath(await ctx.repo())}/actions/secrets`;
    const res = await (await ctx.authedApi()).get<{ secrets: Array<{ name: string; updated_at: string }> }>(path);
    if (ctx.json) return json(ctx.io, res.secrets);
    if (!res.secrets.length) return ctx.err("No secrets.");
    ctx.io.stdout.write(table(res.secrets.map((s) => [s.name, ctx.c.dim(`updated ${ago(s.updated_at)}`)])));
  },
};

const secretDelete: Command = {
  name: "secret delete",
  summary: "Delete an Actions secret",
  args: "<NAME>",
  options: { org: { type: "string", short: "o", desc: "Delete an organization secret instead", arg: "ORG" } },
  repo: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, o, [name]) {
    const org = str(o, "org");
    await (await ctx.authedApi()).delete(org ? `/orgs/${enc(org)}/actions/secrets/${enc(name!)}` : `${repoPath(await ctx.repo())}/actions/secrets/${enc(name!)}`);
    ctx.out(`${ctx.c.green("✓")} Deleted secret ${name}`);
  },
};

const variableSet: Command = {
  name: "variable set",
  summary: "Create or update an Actions variable",
  description: "The value comes from --body, or from stdin when piped.",
  args: "<NAME>",
  options: { body: { type: "string", short: "b", desc: "Variable value", arg: "VALUE" } },
  repo: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, o, [name]) {
    checkName(name!, "variable");
    let value = str(o, "body");
    if (value === undefined) {
      if (ctx.io.stdin.isTTY) throw new CliError("pass --body VALUE or pipe the value on stdin", 2);
      value = (await readAll(ctx.io.stdin)).replace(/\r?\n$/, "");
    }
    await (await ctx.authedApi()).put(`${repoPath(await ctx.repo())}/actions/variables/${enc(name!)}`, { value });
    ctx.out(`${ctx.c.green("✓")} Set variable ${name}`);
  },
};

const variableList: Command = {
  name: "variable list",
  summary: "List Actions variables",
  repo: true,
  json: true,
  maxArgs: 0,
  async run(ctx) {
    const res = await (await ctx.api()).get<{ variables: Array<{ name: string; value: string }> }>(`${repoPath(await ctx.repo())}/actions/variables`);
    if (ctx.json) return json(ctx.io, res.variables);
    if (!res.variables.length) return ctx.err("No variables.");
    ctx.io.stdout.write(table(res.variables.map((v) => [v.name, v.value])));
  },
};

// ---------------------------------------------------------------- tokens

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  repoIds: string[] | null;
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
}

const tokenCreate: Command = {
  name: "token create",
  summary: "Create a personal access token (printed once)",
  description: "Tokens can't create tokens, so on diffinery.com this needs the web UI (Settings → Access tokens); the command works against a local development server.",
  options: {
    name: { type: "string", short: "n", desc: "Token name (required)", arg: "NAME" },
    scope: { type: "string", short: "s", multiple: true, desc: "read, write (default) or admin", arg: "SCOPE" },
    "expires-days": { type: "string", short: "e", desc: "Days until it expires (1-366, default 90)", arg: "DAYS" },
    repo: { type: "string", short: "R", multiple: true, desc: "Restrict the token to this repository", arg: "OWNER/NAME" },
  },
  json: true,
  maxArgs: 0,
  async run(ctx, o) {
    const name = str(o, "name");
    if (!name) throw new CliError("--name is required", 2);
    const scopes = list(o, "scope").flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
    for (const s of scopes) if (!["read", "write", "admin"].includes(s)) throw new CliError(`unknown scope "${s}" (read, write or admin)`, 2);
    const days = str(o, "expires-days") ? positiveInt(str(o, "expires-days"), "--expires-days") : undefined;
    const repos = list(o, "repo");
    const t = await (await ctx.authedApi()).post<{ token: string; id: string; expiresAt: string }>("/diffinery/tokens", { name, scopes: scopes.length ? scopes : undefined, expires_in_days: days, repositories: repos.length ? repos : undefined });
    if (ctx.json) return json(ctx.io, t);
    ctx.out(t.token);
    ctx.err(ctx.c.dim(`Token ${t.id} expires ${t.expiresAt.slice(0, 10)}. It will not be shown again.`));
  },
};

const tokenList: Command = {
  name: "token list",
  summary: "List your tokens",
  json: true,
  maxArgs: 0,
  async run(ctx) {
    const rows = await (await ctx.authedApi()).get<TokenRow[]>("/diffinery/tokens");
    if (ctx.json) return json(ctx.io, rows);
    if (!rows.length) return ctx.err("No tokens.");
    const c = ctx.c;
    ctx.io.stdout.write(
      table([
        ["ID", "NAME", "PREFIX", "SCOPES", "EXPIRES", "LAST USED"].map((h) => c.dim(h)),
        ...rows.map((t) => [t.id, t.name, `${t.prefix}…`, t.scopes.join(",") + (t.repoIds ? ` (${t.repoIds.length} repo${t.repoIds.length === 1 ? "" : "s"})` : ""), t.expiresAt.slice(0, 10), t.lastUsedAt ? ago(t.lastUsedAt) : c.dim("never")]),
      ]),
    );
  },
};

const tokenRevoke: Command = {
  name: "token revoke",
  summary: "Revoke a token",
  args: "<id>",
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, _o, [id]) {
    await (await ctx.authedApi()).delete(`/diffinery/tokens/${enc(id!)}`);
    ctx.out(`${ctx.c.green("✓")} Revoked token ${id}`);
  },
};

// ---------------------------------------------------------------- agents & invites

const agentCreate: Command = {
  name: "agent create",
  summary: "Create an agent account and print its token once",
  description: "Creating an agent mints its first token, which tokens can't do: on diffinery.com create agents in the web UI (Settings → Agents); the command works against a local development server.",
  args: "<login>",
  options: {
    org: { type: "string", short: "o", desc: "Owned by this organization instead of you", arg: "ORG" },
    name: { type: "string", short: "n", desc: "Display name", arg: "NAME" },
    scope: { type: "string", short: "s", multiple: true, desc: "Token scope: read, write (default) or admin", arg: "SCOPE" },
    "expires-days": { type: "string", short: "e", desc: "Token lifetime in days (default 90)", arg: "DAYS" },
  },
  json: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, o, [login]) {
    const scopes = list(o, "scope");
    const days = str(o, "expires-days") ? positiveInt(str(o, "expires-days"), "--expires-days") : undefined;
    const r = await (await ctx.authedApi()).post<{ agent: { login: string; html_url: string }; token: { token: string; id: string; expiresAt: string } }>("/diffinery/agents", {
      login,
      name: str(o, "name"),
      org: str(o, "org"),
      token: scopes.length || days ? { scopes: scopes.length ? scopes : undefined, expires_in_days: days } : undefined,
    });
    if (ctx.json) return json(ctx.io, r);
    ctx.out(`${ctx.c.green("✓")} Created agent ${ctx.c.bold(r.agent.login)}`);
    ctx.out(r.token.token);
    ctx.err(ctx.c.dim(`This token (expires ${r.token.expiresAt.slice(0, 10)}) will not be shown again. Give it to the agent as DIFFINERY_TOKEN.`));
  },
};

const agentList: Command = {
  name: "agent list",
  summary: "List agents you or your organizations own",
  json: true,
  maxArgs: 0,
  async run(ctx) {
    const rows = await (await ctx.authedApi()).get<Array<{ login: string; name: string | null; owner_id: string; policy: Record<string, unknown> }>>("/diffinery/agents");
    if (ctx.json) return json(ctx.io, rows);
    if (!rows.length) return ctx.err("No agents.");
    ctx.io.stdout.write(table(rows.map((a) => [ctx.c.bold(a.login), a.name && a.name !== a.login ? a.name : "", ctx.c.dim(typeof a.policy?.maxRole === "string" ? `max role ${a.policy.maxRole}` : "")])));
  },
};

const agentDisable: Command = {
  name: "agent disable",
  summary: "Disable an agent (its tokens stop working)",
  args: "<login>",
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, _o, [login]) {
    await (await ctx.authedApi()).delete(`/diffinery/agents/${enc(login!)}`);
    ctx.out(`${ctx.c.green("✓")} Disabled agent ${login}`);
  },
};

const invite: Command = {
  name: "invite",
  summary: "Invite someone by email (to an organization, or to the site as an admin)",
  args: "<email>",
  options: {
    org: { type: "string", short: "o", desc: "Organization to join (omit for a site invite; site admins only)", arg: "ORG" },
    role: { type: "string", short: "r", desc: "member (default), admin or owner", arg: "ROLE" },
  },
  json: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, o, [email]) {
    const org = str(o, "org");
    const role = str(o, "role");
    if (!org && role) throw new CliError("--role needs --org", 2);
    if (role && !["member", "admin", "owner"].includes(role)) throw new CliError("--role must be member, admin or owner", 2);
    const r = await (await ctx.authedApi()).post<{ id: string; url: string }>(org ? `/orgs/${enc(org)}/invitations` : "/invitations", org ? { email, role } : { email });
    if (ctx.json) return json(ctx.io, r);
    ctx.out(`${ctx.c.green("✓")} Invited ${email}${org ? ` to ${org}` : ""}${role ? ` as ${role}` : ""}`);
    ctx.out(r.url);
    ctx.err(ctx.c.dim("Send them this link; it is valid for 14 days."));
  },
};

// ---------------------------------------------------------------- raw API

const apiCmd: Command = {
  name: "api",
  summary: "Make an authenticated API request and print the response",
  args: "<METHOD> <PATH>",
  description: `PATH is relative to /api/v3 (e.g. /user, /repos/OWNER/NAME/pulls) unless it starts with /api/.
--input sends a JSON body from a file, or from stdin with '-'.`,
  options: {
    input: { type: "string", short: "i", desc: "Request body file, or '-' for stdin", arg: "FILE" },
    field: { type: "string", short: "f", multiple: true, desc: "Add a string field to the JSON body (or query for GET)", arg: "KEY=VALUE" },
  },
  minArgs: 2,
  maxArgs: 2,
  async run(ctx, o, [method, p]) {
    const m = method!.toUpperCase();
    if (!/^[A-Z]+$/.test(m)) throw new CliError(`invalid method "${method}"`, 2);
    let body: string | undefined;
    const input = str(o, "input");
    if (input) body = input === "-" ? await readAll(ctx.io.stdin) : await readFile(path.resolve(ctx.io.cwd, input), "utf8");
    const fields: Record<string, string> = {};
    for (const f of list(o, "field")) {
      const i = f.indexOf("=");
      if (i <= 0) throw new CliError(`-f expects key=value, got "${f}"`, 2);
      fields[f.slice(0, i)] = f.slice(i + 1);
    }
    const hasFields = Object.keys(fields).length > 0;
    if (hasFields && m !== "GET" && m !== "HEAD") {
      if (body) throw new CliError("use either --input or -f, not both", 2);
      body = JSON.stringify(fields);
    }
    const api = await ctx.api();
    const res = await api.raw<unknown>(m, p!, { body, query: m === "GET" && hasFields ? fields : undefined, allow: Array.from({ length: 500 }, (_, i) => i + 100) });
    const out = typeof res.data === "string" ? res.data : res.data === null ? "" : JSON.stringify(res.data, null, 2);
    if (out) ctx.out(out);
    if (res.status >= 400) {
      ctx.err(ctx.c.red(`HTTP ${res.status}`));
      throw new ExitCode(1);
    }
  },
};

export const secretGroup: Group = { name: "secret", summary: "Manage Actions secrets", commands: [secretSet, secretList, secretDelete] };
export const variableGroup: Group = { name: "variable", summary: "Manage Actions variables", commands: [variableSet, variableList] };
export const tokenGroup: Group = { name: "token", summary: "Manage personal access tokens", commands: [tokenCreate, tokenList, tokenRevoke] };
export const agentGroup: Group = { name: "agent", summary: "Manage agent accounts", commands: [agentCreate, agentList, agentDisable] };
export const adminCommands: Command[] = [invite, apiCmd];
