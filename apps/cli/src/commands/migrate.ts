import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApiError, type Api } from "../api.js";
import { parseRepoArg, repoPath, str, type Command, type Ctx, type Group, type RepoRef, type Values } from "../cli.js";
import { basicAuthHeader, git, gitCapture, withGitConfig } from "../git.js";
import { GitHub, GitHubError } from "../github.js";
import { CliError } from "../io.js";
import type { IssueJson } from "./pr.js";
import type { RepoJson } from "./repo.js";

interface GhRepo {
  full_name: string;
  name: string;
  private: boolean;
  visibility?: "public" | "private" | "internal";
  description: string | null;
  default_branch: string;
  clone_url: string;
  html_url: string;
}

interface GhUser {
  login: string;
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason?: string | null;
  user: GhUser | null;
  labels: Array<{ name: string } | string>;
  comments: number;
  created_at: string;
  pull_request?: unknown;
}

interface GhPull {
  number: number;
  title: string;
  body: string | null;
  draft?: boolean;
  user: GhUser | null;
  created_at: string;
  head: { ref: string; repo: { full_name: string } | null };
  base: { ref: string };
}

interface GhComment {
  body: string | null;
  user: GhUser | null;
  created_at: string;
}

const day = (iso: string) => iso.slice(0, 10);
const who = (u: GhUser | null) => (u ? `@${u.login}` : "a deleted user");

export function attribution(kind: "issue" | "pull request" | "comment", n: number, user: GhUser | null, createdAt: string, htmlBase: string): string {
  const link = `${htmlBase}/${kind === "pull request" ? "pull" : "issues"}/${n}`;
  if (kind === "comment") return `> Imported from GitHub: comment by ${who(user)} on ${day(createdAt)}`;
  return `> Imported from GitHub ${kind} [#${n}](${link}) by ${who(user)} on ${day(createdAt)}`;
}

const withAttribution = (line: string, body: string | null) => `${line}\n\n${body ?? ""}`.trimEnd();

interface Summary {
  repo: string;
  created: boolean;
  branches: number;
  tags: number;
  pushFailures: string[];
  defaultBranch: string | null;
  labels: number;
  issues: Array<{ from: number; to: number }>;
  pulls: Array<{ from: number; to: number }>;
  skippedPulls: Array<{ number: number; reason: string }>;
  comments: number;
  variables: string[];
  secrets: string[];
  warnings: string[];
}

async function optional<T>(ctx: Ctx, s: Summary, what: string, f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 403 || e.status === 404)) {
      s.warnings.push(`could not read ${what} from GitHub (${e.status}; the token may lack access)`);
      ctx.err(`${ctx.c.yellow("warning:")} could not read ${what} from GitHub (${e.status})`);
      return null;
    }
    throw e;
  }
}

async function ensureRepo(ctx: Ctx, api: Api, to: RepoRef, me: string, gh: GhRepo, forcePrivate: boolean): Promise<{ repo: RepoJson; created: boolean }> {
  const existing = await api.raw<RepoJson>("GET", repoPath(to), { allow: [404] });
  if (existing.status !== 404) {
    ctx.out(`Using existing repository ${to.owner}/${to.name}`);
    return { repo: existing.data, created: false };
  }
  // Diffinery has only public and private; GitHub "internal" repositories become private.
  const visibility = !forcePrivate && (gh.visibility === "public" || (gh.visibility === undefined && !gh.private)) ? "public" : "private";
  const body = { name: to.name, description: gh.description ?? undefined, visibility };
  const repo = await api.post<RepoJson>(to.owner === me ? "/user/repos" : `/orgs/${encodeURIComponent(to.owner)}/repos`, body);
  ctx.out(`${ctx.c.green("✓")} Created ${repo.full_name} (${repo.visibility})`);
  return { repo, created: true };
}

async function migrateGit(ctx: Ctx, gh: GhRepo, target: string, token: string | null, diffineryUrl: string, s: Summary): Promise<Set<string>> {
  const dir = await mkdtemp(path.join(tmpdir(), "diffinery-migrate-"));
  const mirror = path.join(dir, "repo.git");
  try {
    ctx.out(`Cloning ${gh.html_url} …`);
    const cloneToken = /^https?:\/\//.test(gh.clone_url) ? ghTokenFor(ctx, gh.clone_url) : null;
    const cloneEnv = withGitConfig(ctx.io.env, cloneToken ? [basicAuthHeader(new URL(gh.clone_url).origin, "x-access-token", cloneToken)] : []);
    const cl = await gitCapture(ctx.io, ["clone", "--mirror", "--quiet", gh.clone_url, mirror], { env: { ...cloneEnv, GIT_TERMINAL_PROMPT: "0" } });
    if (cl.code !== 0) throw new CliError(`git clone --mirror failed: ${cl.stderr.trim()}`);
    const refs = (await git(ctx.io, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"], { cwd: mirror })).split("\n").filter(Boolean);
    const branches = new Set(refs.filter((r) => r.startsWith("refs/heads/")).map((r) => r.slice("refs/heads/".length)));
    s.branches = branches.size;
    s.tags = refs.length - branches.size;
    if (!refs.length) {
      ctx.out("The GitHub repository is empty; nothing to push.");
      return branches;
    }
    ctx.out(`Pushing ${s.branches} branch${s.branches === 1 ? "" : "es"} and ${s.tags} tag${s.tags === 1 ? "" : "s"} to ${target} …`);
    const pushEnv = { ...withGitConfig(ctx.io.env, token ? [basicAuthHeader(diffineryUrl, "x-token", token)] : []), GIT_TERMINAL_PROMPT: "0" };
    const remote = `${diffineryUrl}/${target}.git`;
    const all = await gitCapture(ctx.io, ["push", "--quiet", remote, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"], { cwd: mirror, env: pushEnv });
    if (all.code !== 0) {
      // One big push can hit request size limits or a rejected ref; fall back to ref by ref.
      ctx.err(`${ctx.c.yellow("warning:")} bulk push failed (${all.stderr.trim().split("\n").pop()}); pushing refs one at a time`);
      for (const ref of refs) {
        const r = await gitCapture(ctx.io, ["push", "--quiet", remote, `${ref}:${ref}`], { cwd: mirror, env: pushEnv });
        if (r.code !== 0) {
          s.pushFailures.push(`${ref}: ${r.stderr.trim().split("\n").pop()}`);
          ctx.err(`${ctx.c.red("X")} ${ref}: ${r.stderr.trim().split("\n").pop()}`);
        }
      }
    }
    return branches;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function migrateIssues(ctx: Ctx, gh: GitHub, api: Api, src: string, gr: GhRepo, to: RepoRef, branches: Set<string>, s: Summary): Promise<void> {
  const base = repoPath(to);
  const ghPath = `/repos/${src}`;
  // Labels
  const labels = (await optional(ctx, s, "labels", () => gh.paginate<{ name: string; color: string; description: string | null }>(`${ghPath}/labels`))) ?? [];
  for (const l of labels) {
    try {
      await api.post(`${base}/labels`, { name: l.name, color: l.color, description: l.description ?? "" });
      s.labels++;
    } catch (e) {
      s.warnings.push(`label ${l.name}: ${(e as Error).message}`);
    }
  }
  if (labels.length) ctx.out(`${ctx.c.green("✓")} Copied ${s.labels} label${s.labels === 1 ? "" : "s"}`);

  const openPulls = new Map<number, GhPull>();
  for (const p of (await optional(ctx, s, "pull requests", () => gh.paginate<GhPull>(`${ghPath}/pulls`, { state: "open" }))) ?? []) openPulls.set(p.number, p);
  const items = ((await optional(ctx, s, "issues", () => gh.paginate<GhIssue>(`${ghPath}/issues`, { state: "all", sort: "created", direction: "asc" }))) ?? []).sort((a, b) => a.number - b.number);
  ctx.out(`Importing ${items.length} issues and pull requests …`);

  for (const it of items) {
    let created: IssueJson | null = null;
    if (it.pull_request) {
      const p = openPulls.get(it.number);
      if (it.state !== "open" || !p) {
        s.skippedPulls.push({ number: it.number, reason: it.state === "open" ? "not found" : "closed or merged" });
        continue;
      }
      if (p.head.repo?.full_name?.toLowerCase() !== gr.full_name.toLowerCase()) {
        s.skippedPulls.push({ number: it.number, reason: "head branch is in a fork" });
        continue;
      }
      if (!branches.has(p.head.ref) || !branches.has(p.base.ref)) {
        s.skippedPulls.push({ number: it.number, reason: `branch ${branches.has(p.head.ref) ? p.base.ref : p.head.ref} missing` });
        continue;
      }
      try {
        created = await api.post<IssueJson>(`${base}/pulls`, { title: p.title, body: withAttribution(attribution("pull request", p.number, p.user, p.created_at, gr.html_url), p.body), head: p.head.ref, base: p.base.ref, draft: p.draft || undefined });
        s.pulls.push({ from: it.number, to: created.number });
      } catch (e) {
        s.skippedPulls.push({ number: it.number, reason: (e as Error).message });
        continue;
      }
    } else {
      const labelNames = it.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
      const body = withAttribution(attribution("issue", it.number, it.user, it.created_at, gr.html_url), it.body);
      try {
        created = await api.post<IssueJson>(`${base}/issues`, { title: it.title, body, labels: labelNames.length ? labelNames : undefined });
      } catch (e) {
        if (!(e instanceof ApiError) || !labelNames.length) throw e;
        created = await api.post<IssueJson>(`${base}/issues`, { title: it.title, body });
        s.warnings.push(`issue #${it.number}: labels not applied (${e.message})`);
      }
      s.issues.push({ from: it.number, to: created.number });
    }
    if (it.comments > 0) {
      const comments = (await optional(ctx, s, `comments of #${it.number}`, () => gh.paginate<GhComment>(`${ghPath}/issues/${it.number}/comments`))) ?? [];
      for (const cm of comments) {
        await api.post(`${base}/issues/${created.number}/comments`, { body: withAttribution(attribution("comment", it.number, cm.user, cm.created_at, gr.html_url), cm.body) });
        s.comments++;
      }
    }
    if (it.state === "closed" && !it.pull_request) {
      await api.patch(`${base}/issues/${created.number}`, { state: "closed", state_reason: it.state_reason === "not_planned" ? "not_planned" : "completed" });
    }
    ctx.out(ctx.c.dim(`  GitHub #${it.number} → #${created.number} ${it.title.slice(0, 60)}`));
  }
}

// ---------------------------------------------------------------- the server importer

/** The import resource returned by `/api/v3/diffinery/imports` (the fields the CLI shows). */
interface ImportJson {
  id: string;
  html_url: string;
  status: "draft" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
  kind: "repository" | "organization";
  source: { full_name: string };
  target: { full_name: string | null; html_url: string | null };
  steps: Array<{ name: string; title: string; status: "pending" | "running" | "done" | "skipped" | "failed"; message: string | null; count: number | null }>;
  git: { phase: string | null; message: string | null; bytes: number; chunks: number } | null;
  summary: { secretNames?: string[]; environments?: { secretNames: string[] } } & Record<string, unknown>;
  warnings: string[];
  error: string | null;
  children?: Array<{ id: string; source: string; target: string; status: string; step: string | null; error: string | null }>;
}

const DONE = new Set(["succeeded", "failed", "cancelled"]);
const POLL_MS = 1500;

/** Poll an import to completion, printing each step and Git phase as it changes. */
async function pollImport(ctx: Ctx, api: Api, id: string): Promise<ImportJson> {
  const seenStep = new Map<string, string>();
  let seenGit = "";
  let seenChild = new Map<string, string>();
  for (let i = 0; ; i++) {
    const imp = await api.get<ImportJson>(`/diffinery/imports/${encodeURIComponent(id)}`);
    if (!ctx.json) {
      for (const s of imp.steps) {
        const prev = seenStep.get(s.name);
        if (prev === s.status) continue;
        seenStep.set(s.name, s.status);
        if (s.status === "running") ctx.out(ctx.c.dim(`  … ${s.title}${s.message ? ` (${s.message})` : ""}`));
        else if (s.status === "done") ctx.out(`  ${ctx.c.green("✓")} ${s.title}${s.count != null ? ` (${s.count})` : s.message ? ` (${s.message})` : ""}`);
        else if (s.status === "skipped") ctx.out(ctx.c.dim(`  – ${s.title}${s.message ? ` (${s.message})` : ""}`));
        else if (s.status === "failed") ctx.out(`  ${ctx.c.red("X")} ${s.title}${s.message ? `: ${s.message}` : ""}`);
      }
      if (imp.git && imp.git.phase && imp.git.phase !== seenGit) {
        seenGit = imp.git.phase;
        ctx.out(ctx.c.dim(`  … git: ${imp.git.message ?? imp.git.phase}`));
      }
      for (const ch of imp.children ?? []) {
        const key = `${ch.status}:${ch.step ?? ""}`;
        if (seenChild.get(ch.id) === key) continue;
        seenChild.set(ch.id, key);
        const mark = ch.status === "succeeded" ? ctx.c.green("✓") : ch.status === "failed" ? ctx.c.red("X") : ch.status === "cancelled" ? ctx.c.dim("–") : ctx.c.dim("…");
        ctx.out(`  ${mark} ${ch.source} → ${ch.target}${ch.status === "running" && ch.step ? ctx.c.dim(` (${ch.step})`) : ch.error ? ctx.c.red(` ${ch.error}`) : ""}`);
      }
    }
    if (DONE.has(imp.status)) return imp;
    await ctx.io.sleep(POLL_MS);
  }
}

/**
 * Secret names across the repository and its environments, with the command to set each.
 * Environment secrets (`<environment>/<NAME>`) have no `secret set` option, so they get the
 * REST call through `diffinery api` instead.
 */
function secretLines(ctx: Ctx, imp: ImportJson, target: string): void {
  const repoNames = imp.summary.secretNames ?? [];
  const envNames = imp.summary.environments?.secretNames ?? [];
  const total = repoNames.length + envNames.length;
  if (!total) return;
  ctx.out("");
  ctx.out(`GitHub does not reveal secret values. Set these ${total} secret${total === 1 ? "" : "s"} by hand:`);
  for (const n of repoNames) ctx.out(`  diffinery secret set ${n} -R ${target}`);
  for (const n of envNames) {
    const at = n.lastIndexOf("/");
    const [env, name] = [n.slice(0, at), n.slice(at + 1)];
    ctx.out(`  diffinery api PUT /repos/${target}/environments/${encodeURIComponent(env)}/secrets/${encodeURIComponent(name)} -f value=...`);
  }
}

function renderImport(ctx: Ctx, imp: ImportJson): number {
  if (ctx.json) {
    ctx.out(JSON.stringify(imp, null, 2));
    return imp.status === "succeeded" ? 0 : 1;
  }
  const c = ctx.c;
  const target = imp.target.full_name ?? "—";
  ctx.out("");
  if (imp.status === "succeeded") ctx.out(c.bold(`Imported ${imp.source.full_name} → ${target}`));
  else if (imp.status === "cancelled") ctx.out(c.yellow(`Import of ${imp.source.full_name} was cancelled`));
  else ctx.out(c.red(`Import of ${imp.source.full_name} failed${imp.error ? `: ${imp.error}` : ""}`));
  for (const w of imp.warnings) ctx.err(`${c.yellow("warning:")} ${w}`);
  if (imp.status === "succeeded") {
    secretLines(ctx, imp, target);
    if (imp.target.html_url) {
      ctx.out("");
      ctx.out(imp.target.html_url);
    }
  }
  return imp.status === "succeeded" ? 0 : 1;
}

const ghToken = (ctx: Ctx) => ctx.io.env.GH_TOKEN || ctx.io.env.GITHUB_TOKEN || null;

/** Server imports send the ambient GitHub token along: say so, and to which server, rather than do it silently. */
async function noteSendingToken(ctx: Ctx, token: string | undefined, what: string): Promise<void> {
  if (!token) return;
  ctx.err(ctx.c.yellow(`note: sending ${ctx.io.env.GH_TOKEN ? "GH_TOKEN" : "GITHUB_TOKEN"} to ${(await ctx.config()).url} so it can read ${what} from GitHub during the import`));
}
const ghApiUrl = (ctx: Ctx) => ctx.io.env.GITHUB_API_URL || undefined;

/**
 * The GitHub token to send to a given URL, or null. M3: only attach it to github.com (its API/host)
 * or to the host of an explicitly configured GITHUB_API_URL — never to a host taken from the source
 * repository argument, so a crafted source cannot capture the token.
 */
function ghTokenFor(ctx: Ctx, url: string): string | null {
  const token = ghToken(ctx);
  if (!token) return null;
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
  if (host === "github.com" || host === "www.github.com" || host === "api.github.com") return token;
  const apiUrl = ctx.io.env.GITHUB_API_URL;
  if (apiUrl) {
    try {
      if (new URL(apiUrl).host.toLowerCase() === host) return token;
    } catch {
      // ignore a malformed GITHUB_API_URL
    }
  }
  return null;
}

/** The server-side single-repository import: POST the request, then follow it to completion. */
async function runServer(ctx: Ctx, o: Values, srcArg: string): Promise<number> {
  const src = parseRepoArg(srcArg.replace(/^https?:\/\/github\.com\//, ""));
  const srcName = `${src.owner}/${src.name}`;
  const api = await ctx.authedApi();
  const to = str(o, "to") ? parseRepoArg(str(o, "to")!) : null;
  let owner = to?.owner;
  if (!owner) owner = (await api.get<{ login: string }>("/user")).login;
  const body = {
    source: srcName,
    owner,
    name: to?.name,
    visibility: o.private === true ? "private" : "keep",
    github_token: ghToken(ctx) ?? undefined,
    github_api_url: ghApiUrl(ctx),
  };
  await noteSendingToken(ctx, body.github_token, srcName);
  if (!ctx.json) ctx.out(`Starting server import of ${srcName} …`);
  const created = await api.post<ImportJson>("/diffinery/imports", body);
  const final = await pollImport(ctx, api, created.id);
  return renderImport(ctx, final);
}

const github: Command = {
  name: "migrate github",
  summary: "Import a GitHub repository (git data, issues, pull requests, releases and more)",
  args: "<GH-OWNER/GH-REPO>",
  description: `Runs a full server-side import: git data (keeping issue and pull-request numbers), labels,
milestones, issues and pull requests with comments and reviews, branch protection, Actions
variables, release assets and deployment environments. The command follows progress until the
import finishes. Secret values are never read from GitHub; their names are listed to set by hand.

With --local, runs the old client-side import instead (mirror push plus a best-effort recreation
of issues and open pull requests); --issues then also copies labels, issues and comments.

GitHub access uses GH_TOKEN or GITHUB_TOKEN (needed for private repositories; GITHUB_API_URL
selects a GitHub Enterprise API).`,
  options: {
    to: { type: "string", short: "t", desc: "Diffinery repository to create (default: <you>/<gh-repo>)", arg: "OWNER/NAME" },
    private: { type: "boolean", short: "p", desc: "Create the repository as private regardless of GitHub's visibility" },
    local: { type: "boolean", short: "l", desc: "Use the old client-side import (no server importer)" },
    issues: { type: "boolean", short: "i", desc: "With --local: also import labels, issues, comments and open pull requests" },
  },
  json: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, o, [srcArg]) {
    if (o.local !== true) return runServer(ctx, o, srcArg!);
    const src = parseRepoArg(srcArg!.replace(/^https?:\/\/github\.com\//, ""));
    const srcName = `${src.owner}/${src.name}`;
    const api = await ctx.authedApi();
    const cfg = await ctx.config();
    const token = ghToken(ctx);
    const gh = new GitHub({ baseUrl: ctx.io.env.GITHUB_API_URL, token, sleep: (ms) => ctx.io.sleep(ms), log: (m) => ctx.err(ctx.c.yellow(m)) });
    if (!token) ctx.err(ctx.c.yellow("note: GH_TOKEN/GITHUB_TOKEN is not set; only public data can be read and GitHub rate limits are low"));

    const me = await api.get<{ login: string }>("/user");
    const gr = await gh.get<GhRepo>(`/repos/${srcName}`);
    const to = str(o, "to") ? parseRepoArg(str(o, "to")!) : { owner: me.login, name: gr.name };
    const target = `${to.owner}/${to.name}`;
    const s: Summary = { repo: target, created: false, branches: 0, tags: 0, pushFailures: [], defaultBranch: null, labels: 0, issues: [], pulls: [], skippedPulls: [], comments: 0, variables: [], secrets: [], warnings: [] };

    const { created } = await ensureRepo(ctx, api, to, me.login, gr, o.private === true);
    s.created = created;
    const branches = await migrateGit(ctx, gr, target, cfg.token, cfg.url, s);
    if (branches.has(gr.default_branch)) {
      await api.patch(repoPath(to), { default_branch: gr.default_branch });
      s.defaultBranch = gr.default_branch;
    }

    const vars = (await optional(ctx, s, "Actions variables", () => gh.paginate<{ name: string; value: string }>(`/repos/${srcName}/actions/variables`, {}, "variables"))) ?? [];
    for (const v of vars) {
      await api.put(`${repoPath(to)}/actions/variables/${encodeURIComponent(v.name)}`, { value: v.value });
      s.variables.push(v.name);
    }
    s.secrets = ((await optional(ctx, s, "Actions secret names", () => gh.paginate<{ name: string }>(`/repos/${srcName}/actions/secrets`, {}, "secrets"))) ?? []).map((x) => x.name);

    if (o.issues) await migrateIssues(ctx, gh, api, srcName, gr, to, branches, s);

    if (ctx.json) {
      ctx.out(JSON.stringify(s, null, 2));
      return s.pushFailures.length ? 1 : 0;
    }
    const c = ctx.c;
    ctx.out("");
    ctx.out(c.bold(`Imported ${srcName} → ${target}`));
    ctx.out(`  git:        ${s.branches} branches, ${s.tags} tags${s.pushFailures.length ? c.red(` (${s.pushFailures.length} refs failed)`) : ""}`);
    ctx.out(`  default:    ${s.defaultBranch ?? c.dim("unchanged")}`);
    ctx.out(`  variables:  ${s.variables.length}`);
    if (o.issues) {
      ctx.out(`  labels:     ${s.labels}`);
      ctx.out(`  issues:     ${s.issues.length} (${s.comments} comments)`);
      ctx.out(`  pulls:      ${s.pulls.length} recreated, ${s.skippedPulls.filter((p) => p.reason !== "closed or merged").length} skipped`);
      for (const p of s.skippedPulls.filter((x) => x.reason !== "closed or merged")) ctx.out(c.dim(`    #${p.number}: ${p.reason}`));
    }
    if (s.secrets.length) {
      ctx.out("");
      ctx.out(`GitHub does not reveal secret values. Set these ${s.secrets.length} secret${s.secrets.length === 1 ? "" : "s"}:`);
      for (const n of s.secrets) ctx.out(`  diffinery secret set ${n} -R ${target}`);
    }
    for (const w of s.warnings) ctx.err(`${c.yellow("warning:")} ${w}`);
    ctx.out("");
    ctx.out(`${cfg.url}/${target}`);
    return s.pushFailures.length ? 1 : 0;
  },
};

const githubOrg: Command = {
  name: "migrate github-org",
  summary: "Import many repositories from a GitHub organization or user",
  args: "<GH-ORG-OR-USER>",
  description: `Starts a server-side bulk import of every repository in a GitHub organization or user account
(or just the ones named with --repos), into a Diffinery organization or user. Each repository is
imported in full, the same as "migrate github". The command follows progress until every
repository has finished.

GitHub access uses GH_TOKEN or GITHUB_TOKEN; GITHUB_API_URL selects a GitHub Enterprise API.`,
  options: {
    to: { type: "string", short: "t", desc: "Diffinery owner to import into (default: you)", arg: "OWNER" },
    repos: { type: "string", desc: "Comma-separated repository names to import (default: all)", arg: "A,B,C" },
    private: { type: "boolean", short: "p", desc: "Create every repository as private" },
    "exclude-forks": { type: "boolean", desc: "Skip forks" },
    "exclude-archived": { type: "boolean", desc: "Skip archived repositories" },
    concurrency: { type: "string", short: "c", desc: "Repositories to import at once, 1–8 (default 3)", arg: "N" },
  },
  json: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, o, [orgArg]) {
    const org = orgArg!.replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
    const api = await ctx.authedApi();
    const owner = str(o, "to") || (await api.get<{ login: string }>("/user")).login;
    const repositories = str(o, "repos")
      ? str(o, "repos")!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const concurrency = str(o, "concurrency") ? Number(str(o, "concurrency")) : undefined;
    const body = {
      source_owner: org,
      owner,
      repositories,
      exclude_forks: o["exclude-forks"] === true || undefined,
      exclude_archived: o["exclude-archived"] === true || undefined,
      concurrency,
      visibility: o.private === true ? "private" : "keep",
      github_token: ghToken(ctx) ?? undefined,
      github_api_url: ghApiUrl(ctx),
    };
    await noteSendingToken(ctx, body.github_token, org);
    if (!ctx.json) ctx.out(`Starting bulk import of ${org} into ${owner} …`);
    const created = await api.post<ImportJson>("/diffinery/imports", body);
    const final = await pollImport(ctx, api, created.id);
    if (ctx.json) {
      ctx.out(JSON.stringify(final, null, 2));
      return final.status === "succeeded" ? 0 : 1;
    }
    const c = ctx.c;
    const kids = final.children ?? [];
    const ok = kids.filter((k) => k.status === "succeeded").length;
    const failed = kids.filter((k) => k.status === "failed").length;
    ctx.out("");
    ctx.out(c.bold(`Bulk import of ${org}: ${ok}/${kids.length} repositories imported${failed ? c.red(`, ${failed} failed`) : ""}`));
    for (const w of final.warnings) ctx.err(`${c.yellow("warning:")} ${w}`);
    ctx.out("");
    ctx.out(final.html_url);
    return final.status === "succeeded" ? 0 : 1;
  },
};

export const migrateGroup: Group = { name: "migrate", summary: "Import repositories from other forges", commands: [github, githubOrg] };
