import { readFile } from "node:fs/promises";
import path from "node:path";
import { exactlyOne, list, positiveInt, repoPath, str, type Command, type Ctx, type Group, type RepoRef, type Values } from "../cli.js";
import { ApiError } from "../api.js";
import { currentBranch, gitCapture } from "../git.js";
import { CliError, ExitCode, readAll } from "../io.js";
import { ago, json, statusText, symbol, table, truncate } from "../output.js";

export interface IssueJson {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  state_reason: string | null;
  user: { login: string; type: string };
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  pull_request?: { url: string };
  head?: { ref: string; sha: string };
  base?: { ref: string };
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merged_by?: { login: string } | null;
  intent?: string | null;
}

interface PullDetail extends IssueJson {
  mergeable: boolean;
  mergeable_state: string;
  merge_blockers: string[];
  approvals: number;
  required_approvals: number;
  checks: Array<{ name: string; state: string }>;
  auto_merge?: { merge_method: string } | null;
  /** Only for agents and workflow tokens: what stops Diffinery landing it through auto-merge. */
  auto_merge_blockers?: string[];
}

export interface CommentJson {
  id: string;
  body: string;
  user: { login: string };
  created_at: string;
}

/** -b/--body, else --body-file (or "-" for stdin), else piped stdin when `stdinFallback`. */
export async function bodyFrom(ctx: Ctx, o: Values, stdinFallback = false): Promise<string | undefined> {
  const b = str(o, "body");
  if (b !== undefined) return b;
  const f = str(o, "body-file");
  if (f !== undefined) {
    if (f === "-") return readAll(ctx.io.stdin);
    return readFile(path.resolve(ctx.io.cwd, f), "utf8");
  }
  if (stdinFallback && !ctx.io.stdin.isTTY) return readAll(ctx.io.stdin);
  return undefined;
}

export const bodyOpts = {
  body: { type: "string" as const, short: "b", desc: "Body text (Markdown)", arg: "TEXT" },
  "body-file": { type: "string" as const, desc: "Read the body from a file ('-' for stdin)", arg: "FILE" },
};

export function prState(c: Ctx["c"], p: IssueJson): string {
  if (p.merged) return c.magenta("merged");
  if (p.state === "closed") return c.red("closed");
  if (p.draft) return c.dim("draft");
  return c.green("open");
}

const create: Command = {
  name: "pr create",
  summary: "Open a pull request",
  options: {
    title: { type: "string", short: "t", desc: "Title (required)", arg: "TEXT" },
    ...bodyOpts,
    head: { type: "string", short: "H", desc: "Branch with your changes (default: current branch)", arg: "BRANCH" },
    base: { type: "string", short: "B", desc: "Branch to merge into (default: the repository's default branch)", arg: "BRANCH" },
    draft: { type: "boolean", short: "d", desc: "Open as a draft" },
    intent: { type: "string", desc: "What this change is for, for reviewers (agents should always set it)", arg: "TEXT" },
    reviewer: { type: "string", short: "r", multiple: true, desc: "Request a review from this login", arg: "LOGIN" },
    auto: { type: "boolean", desc: "Turn on auto-merge as it opens: it merges once the base branch's required checks pass and every rule is met" },
    "no-auto": { type: "boolean", desc: "Keep auto-merge off, even if your setting turns it on for pull requests you open" },
  },
  repo: true,
  json: true,
  maxArgs: 0,
  async run(ctx, o) {
    const title = str(o, "title");
    if (!title) throw new CliError("--title is required", 2);
    if (o.auto === true && o["no-auto"] === true) throw new CliError("use only one of --auto, --no-auto", 2);
    const repo = await ctx.repo();
    const head = str(o, "head") ?? (await currentBranch(ctx.io));
    const reviewers = list(o, "reviewer");
    const payload = {
      title,
      body: await bodyFrom(ctx, o),
      head,
      base: str(o, "base"),
      draft: o.draft === true ? true : undefined,
      intent: str(o, "intent"),
      reviewers: reviewers.length ? reviewers : undefined,
      // Diffinery's: true turns auto-merge on as it opens, false keeps it off whatever your setting says.
      auto_merge: o.auto === true ? true : o["no-auto"] === true ? false : undefined,
    };
    const pr = await (await ctx.authedApi()).post<IssueJson & { auto_merge?: { merge_method: string } | null; auto_merge_skipped?: string }>(`${repoPath(repo)}/pulls`, payload);
    if (ctx.json) return json(ctx.io, pr);
    ctx.out(`${ctx.c.green("✓")} Opened #${pr.number} ${pr.title} (${pr.head?.ref} → ${pr.base?.ref})`);
    if (pr.auto_merge) ctx.out(`${ctx.c.dim("auto-merge:")} on (${pr.auto_merge.merge_method}): it merges once every requirement is met`);
    else if (pr.auto_merge_skipped) ctx.err(`${ctx.c.yellow("warning:")} auto-merge is off: ${pr.auto_merge_skipped}`);
    ctx.out(pr.html_url);
  },
};

const listCmd: Command = {
  name: "pr list",
  summary: "List pull requests",
  options: {
    state: { type: "string", short: "s", desc: "open, closed, merged or all (default: open)", arg: "STATE" },
    limit: { type: "string", short: "L", desc: "Maximum number to show (default 30)", arg: "N" },
    author: { type: "string", short: "A", desc: "Only pull requests opened by this login", arg: "LOGIN" },
    head: { type: "string", short: "H", desc: "Only pull requests from this branch", arg: "BRANCH" },
  },
  repo: true,
  json: true,
  maxArgs: 0,
  async run(ctx, o) {
    const repo = await ctx.repo();
    const state = str(o, "state") ?? "open";
    if (!["open", "closed", "merged", "all"].includes(state)) throw new CliError("--state must be open, closed, merged or all", 2);
    const limit = str(o, "limit") ? positiveInt(str(o, "limit"), "--limit") : 30;
    const head = str(o, "head");
    const api = await ctx.api();
    let prs = await api.get<IssueJson[]>(`${repoPath(repo)}/pulls`, {
      state: state === "merged" ? "closed" : state,
      per_page: Math.min(100, state === "merged" ? 100 : limit),
      creator: str(o, "author"),
      head: head ? headQuery(repo, head) : undefined,
    });
    if (state === "merged") prs = prs.filter((p) => p.merged);
    prs = prs.slice(0, limit);
    if (ctx.json) return json(ctx.io, prs);
    if (!prs.length) return ctx.err(`No ${state === "all" ? "" : `${state} `}pull requests ${head ? `from ${head} ` : ""}in ${repo.owner}/${repo.name}.`);
    const c = ctx.c;
    ctx.io.stdout.write(table(prs.map((p) => [c.bold(`#${p.number}`), truncate(p.title, 60), c.cyan(`${p.head?.ref ?? ""}`), prState(c, p), c.dim(p.user.login), c.dim(ago(p.updated_at))])));
  },
};

/** GitHub's `head` filter form, OWNER:BRANCH (Diffinery also accepts a bare branch). */
const headQuery = (repo: RepoRef, branch: string) => (branch.includes(":") ? branch : `${repo.owner}:${branch}`);

/**
 * The pull request number argument; without one, like gh, the open pull request whose head is
 * the current git branch.
 */
async function prNumber(ctx: Ctx, num: string | undefined): Promise<number> {
  if (num !== undefined) return positiveInt(num, "pull request number");
  const r = await gitCapture(ctx.io, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = r.code === 0 ? r.stdout.trim() : "";
  if (!branch) throw new CliError("no pull request number given, and there is no current branch to find one for (detached HEAD or not a git repository); pass a pull request number");
  const repo = await ctx.repo();
  const prs = await (await ctx.api()).get<IssueJson[]>(`${repoPath(repo)}/pulls`, { head: headQuery(repo, branch), state: "open" });
  const pr = prs.find((p) => p.head?.ref === branch);
  if (!pr) throw new CliError(`no open pull request for the current branch (${branch}) in ${repo.owner}/${repo.name}; pass a pull request number`);
  return pr.number;
}

async function getPull(ctx: Ctx, n: number) {
  const repo = await ctx.repo();
  const api = await ctx.api();
  return { repo, api, pr: await api.get<PullDetail>(`${repoPath(repo)}/pulls/${n}`) };
}

const view: Command = {
  name: "pr view",
  summary: "Show a pull request",
  description: "Without a number, shows the open pull request for the current branch.",
  args: "[<number>]",
  options: { comments: { type: "boolean", short: "c", desc: "Include the conversation" } },
  repo: true,
  json: true,
  maxArgs: 1,
  async run(ctx, o, [num]) {
    const n = await prNumber(ctx, num);
    const { pr, api, repo } = await getPull(ctx, n);
    const comments = o.comments ? await api.get<CommentJson[]>(`${repoPath(repo)}/issues/${n}/comments`) : undefined;
    if (ctx.json) return json(ctx.io, comments ? { ...pr, comment_list: comments } : pr);
    const c = ctx.c;
    ctx.out(`${c.bold(pr.title)} ${c.dim(`#${pr.number}`)}`);
    ctx.out(`${prState(c, pr)} · ${pr.user.login} wants to merge ${c.cyan(pr.head?.ref ?? "?")} into ${c.cyan(pr.base?.ref ?? "?")} · ${ago(pr.created_at)}`);
    if (pr.intent) ctx.out(`${c.dim("intent:")} ${pr.intent}`);
    if (pr.state === "open") {
      ctx.out(`${c.dim("mergeable:")} ${statusText(c, pr.mergeable_state)} · approvals ${pr.approvals}/${pr.required_approvals}`);
      for (const b of pr.merge_blockers ?? []) ctx.out(`  ${c.red("•")} ${b}`);
      if (pr.auto_merge) {
        // For an agent, merge_blockers can name an approval its auto-merge doesn't need; say what is really left.
        const left = pr.auto_merge_blockers;
        const when = !left ? "it merges by itself once every requirement is met" : left.length ? "it merges by itself once these are done:" : "nothing is left, it merges now";
        ctx.out(`${c.dim("auto-merge:")} on (${pr.auto_merge.merge_method}), ${when}`);
        for (const b of left ?? []) ctx.out(`  ${c.yellow("•")} ${b}`);
      }
    }
    if (pr.checks?.length) ctx.out(`${c.dim("checks:")} ${pr.checks.map((k) => `${checkSymbol(ctx, k.state)} ${k.name}`).join("  ")}`);
    if (pr.body?.trim()) ctx.out(`\n${pr.body.trim()}\n`);
    for (const cm of comments ?? []) ctx.out(`\n${c.bold(cm.user.login)} ${c.dim(ago(cm.created_at))}\n${cm.body.trim()}`);
    ctx.out(c.dim(pr.html_url));
  },
};

function checkSymbol(ctx: Ctx, state: string): string {
  const done = ["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"];
  return done.includes(state) ? symbol(ctx.c, "completed", state) : symbol(ctx.c, state);
}

const diff: Command = {
  name: "pr diff",
  summary: "Show a pull request's changes as a unified diff",
  description: "Without a number, shows the open pull request for the current branch.",
  args: "[<number>]",
  options: { "name-only": { type: "boolean", desc: "Only list changed file names" } },
  repo: true,
  maxArgs: 1,
  async run(ctx, o, [num]) {
    const n = await prNumber(ctx, num);
    const repo = await ctx.repo();
    const files = await (await ctx.api()).get<Array<{ filename: string; status: string; patch?: string; binary?: boolean }>>(`${repoPath(repo)}/pulls/${n}/files`);
    if (o["name-only"]) {
      ctx.io.stdout.write(files.map((f) => `${f.filename}\n`).join(""));
      return;
    }
    const c = ctx.c;
    for (const f of files) {
      const patch = f.patch ?? `diff --git a/${f.filename} b/${f.filename}\n`;
      if (!c.enabled) {
        ctx.io.stdout.write(patch.endsWith("\n") ? patch : `${patch}\n`);
        continue;
      }
      for (const line of patch.replace(/\n$/, "").split("\n")) {
        if (line.startsWith("diff --git") || line.startsWith("--- ") || line.startsWith("+++ ")) ctx.out(c.bold(line));
        else if (line.startsWith("@@")) ctx.out(c.cyan(line));
        else if (line.startsWith("+")) ctx.out(c.green(line));
        else if (line.startsWith("-")) ctx.out(c.red(line));
        else ctx.out(line);
      }
    }
  },
};

const DONE = ["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required"];
const FAILED = ["failure", "cancelled", "timed_out", "action_required"];
const PENDING = ["queued", "in_progress", "waiting", "pending", "requested"];
/** Right after a push, a pull request has no checks until its runs start: --watch waits this long for the first. */
const FIRST_CHECK_WAIT_MS = 120_000;

const checks: Command = {
  name: "pr checks",
  summary: "Show check status for a pull request",
  description:
    "Without a number, shows the open pull request for the current branch. With --watch, polls until no check is pending (waiting up to 2 minutes for the first check to appear, as right after a push), printing the checks whenever they change (on a terminal; otherwise once at the end).\n\nExit status: 0 when all checks passed, 1 when any failed, 8 when some are still pending (never with --watch).",
  args: "[<number>]",
  options: {
    watch: { type: "boolean", desc: "Wait until no check is pending" },
    interval: { type: "string", short: "i", desc: "Seconds between polls with --watch (default 10)", arg: "SECONDS" },
  },
  repo: true,
  json: true,
  maxArgs: 1,
  async run(ctx, o, [num]) {
    const interval = Math.max(0, Number(str(o, "interval") ?? 10)) * 1000;
    if (!Number.isFinite(interval)) throw new CliError("--interval must be a number", 2);
    const n = await prNumber(ctx, num);
    const repo = await ctx.repo();
    const api = await ctx.api();
    const render = (list: PullDetail["checks"]) => table(list.map((k) => [checkSymbol(ctx, k.state), k.name, statusText(ctx.c, DONE.includes(k.state) ? "completed" : k.state, k.state)]));
    // Like `gh pr checks --watch`: on a terminal, show progress as it happens; when piped, only the result.
    const live = o.watch === true && !ctx.json && !!ctx.io.stdout.isTTY;
    let shown: string | undefined;
    let failures = 0;
    let waited = 0;
    let list: PullDetail["checks"];
    for (;;) {
      try {
        list = (await api.get<PullDetail>(`${repoPath(repo)}/pulls/${n}`)).checks ?? [];
        failures = 0;
      } catch (e) {
        // While watching, ride out transient network/server errors; give up on client errors.
        const status = (e as { status?: number }).status;
        if (o.watch !== true || (status && status < 500 && status !== 429) || ++failures > 5) throw e;
        await ctx.io.sleep(interval);
        continue;
      }
      const waitingForFirst = !list.length && waited < FIRST_CHECK_WAIT_MS;
      if (o.watch !== true || (!waitingForFirst && !list.some((k) => PENDING.includes(k.state)))) break;
      const t = render(list);
      if (live && t && t !== shown) {
        ctx.io.stdout.write(`${shown === undefined ? "" : "\n"}${t}`);
        shown = t;
      }
      await ctx.io.sleep(interval);
      waited += Math.max(interval, 1000);
    }
    if (ctx.json) json(ctx.io, list);
    else if (!list.length) ctx.err("No checks reported for this pull request.");
    else if (render(list) !== shown) ctx.io.stdout.write(`${shown === undefined ? "" : "\n"}${render(list)}`);
    const failed = list.some((k) => FAILED.includes(k.state));
    const pending = list.some((k) => PENDING.includes(k.state));
    throw new ExitCode(failed ? 1 : pending ? 8 : 0);
  },
};

const review: Command = {
  name: "pr review",
  summary: "Approve, request changes or comment on a pull request",
  description: "Without a number, reviews the open pull request for the current branch.",
  args: "[<number>]",
  options: {
    approve: { type: "boolean", short: "a", desc: "Approve" },
    "request-changes": { type: "boolean", short: "r", desc: "Request changes" },
    comment: { type: "boolean", short: "c", desc: "Comment without approving" },
    ...bodyOpts,
  },
  repo: true,
  json: true,
  maxArgs: 1,
  async run(ctx, o, [num]) {
    const which = exactlyOne(o, ["approve", "request-changes", "comment"]);
    const event = which === "approve" ? "APPROVE" : which === "request-changes" ? "REQUEST_CHANGES" : "COMMENT";
    const body = await bodyFrom(ctx, o);
    if (event !== "APPROVE" && !body) throw new CliError(`--body is required with --${which}`, 2);
    const n = await prNumber(ctx, num);
    const repo = await ctx.repo();
    const r = await (await ctx.authedApi()).post<{ id: string; state: string }>(`${repoPath(repo)}/pulls/${n}/reviews`, { event, body });
    if (ctx.json) return json(ctx.io, r);
    const verb = event === "APPROVE" ? "Approved" : event === "REQUEST_CHANGES" ? "Requested changes on" : "Reviewed";
    ctx.out(`${ctx.c.green("✓")} ${verb} #${n}`);
  },
};

const merge: Command = {
  name: "pr merge",
  summary: "Merge a pull request",
  description: "Without a number, merges the open pull request for the current branch.",
  args: "[<number>]",
  options: {
    merge: { type: "boolean", short: "m", desc: "Create a merge commit (default)" },
    squash: { type: "boolean", short: "s", desc: "Squash into one commit" },
    rebase: { type: "boolean", short: "r", desc: "Rebase the commits onto the base branch" },
    "delete-branch": { type: "boolean", short: "d", desc: "Delete the head branch after merging" },
    subject: { type: "string", short: "t", desc: "Commit title", arg: "TEXT" },
    ...bodyOpts,
    "match-head-commit": { type: "string", desc: "Only merge if the head is still at this SHA", arg: "SHA" },
    admin: { type: "boolean", desc: "Merge now, bypassing unmet branch rules and any merge queue (repository admins; audited)" },
    auto: { type: "boolean", desc: "Turn on auto-merge: merge (or join the merge queue) once every requirement is met" },
    "disable-auto": { type: "boolean", desc: "Turn off auto-merge (and take the pull request out of the merge queue if it is in it)" },
  },
  repo: true,
  json: true,
  maxArgs: 1,
  async run(ctx, o, [num]) {
    const method = exactlyOne(o, ["merge", "squash", "rebase"], "merge");
    const explicit = ["merge", "squash", "rebase"].some((k) => o[k] === true);
    if (o.auto === true && o["disable-auto"] === true) throw new CliError("use only one of --auto, --disable-auto", 2);
    if (o.auto === true && o.admin === true) throw new CliError("--admin merges now; it can't be combined with --auto", 2);
    const n = await prNumber(ctx, num);
    const repo = await ctx.repo();
    const api = await ctx.authedApi();
    if (o["disable-auto"] === true) {
      // Like `gh pr merge --disable-auto`: turn auto-merge off. Diffinery should not land it by
      // itself afterwards, so a pull request auto-merge (or someone) already queued leaves the queue too.
      await api.delete(`${repoPath(repo)}/pulls/${n}/auto-merge`);
      let dequeued = true;
      try {
        await api.delete(`${repoPath(repo)}/pulls/${n}/merge-queue`);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
        dequeued = false;
      }
      if (ctx.json) return json(ctx.io, { auto_merge: null, dequeued });
      return ctx.out(`${ctx.c.green("✓")} Turned off auto-merge for #${n}${dequeued ? " and removed it from the merge queue" : ""}`);
    }
    if (o.auto === true) {
      // Like `gh pr merge --auto`: PUT /pulls/{n}/auto-merge. Without a method flag the server picks
      // the merge queue's method, squash where linear history is required, else a merge commit.
      const r = await api.put<{ state: "enabled" | "queued" | "merged"; auto_merge: { merge_method: string } | null; merge_commit_sha: string | null }>(`${repoPath(repo)}/pulls/${n}/auto-merge`, {
        merge_method: explicit ? method : undefined,
        delete_branch: o["delete-branch"] === true ? true : undefined,
        commit_title: str(o, "subject"),
        commit_message: await bodyFrom(ctx, o),
        sha: str(o, "match-head-commit"),
      });
      if (ctx.json) return json(ctx.io, r);
      if (r.state === "merged") return ctx.out(`${ctx.c.green("✓")} Merged #${n} ${ctx.c.dim(String(r.merge_commit_sha ?? "").slice(0, 12))}`);
      if (r.state === "queued") return ctx.out(`${ctx.c.green("✓")} Added #${n} to the merge queue`);
      return ctx.out(`${ctx.c.green("✓")} Auto-merge is on for #${n} (${r.auto_merge?.merge_method ?? method}): it merges once every requirement is met`);
    }
    const payload = {
      merge_method: method,
      delete_branch: o["delete-branch"] === true ? true : undefined,
      commit_title: str(o, "subject"),
      commit_message: await bodyFrom(ctx, o),
      sha: str(o, "match-head-commit"),
      bypass_merge_queue: o.admin === true ? true : undefined,
      bypass_rules: o.admin === true ? true : undefined,
    };
    let r: { merged: boolean; sha: string; method: string };
    try {
      r = await api.put(`${repoPath(repo)}/pulls/${n}/merge`, payload);
    } catch (e) {
      // Like `gh pr merge`: a base branch with a merge queue gets the pull request queued instead.
      if (!(e instanceof ApiError) || e.status !== 405 || !/merge queue/.test(e.message) || o.admin === true) throw e;
      const q = await api.put<{ state: string; entry: { position: number } | null; merge_commit_sha: string | null; reason: string | null }>(`${repoPath(repo)}/pulls/${n}/merge-queue`, {
        merge_method: explicit ? method : undefined,
        delete_branch: payload.delete_branch,
      });
      if (ctx.json) return json(ctx.io, q);
      if (q.state === "queued") return ctx.out(`${ctx.c.green("✓")} Added #${n} to the merge queue (position ${q.entry?.position ?? "?"})`);
      if (q.state === "merged") return ctx.out(`${ctx.c.green("✓")} Merged #${n} through the merge queue ${ctx.c.dim(String(q.merge_commit_sha ?? "").slice(0, 12))}`);
      throw new CliError(`#${n} left the merge queue: ${q.reason ?? "see the pull request"}`);
    }
    if (ctx.json) return json(ctx.io, r);
    ctx.out(`${ctx.c.green("✓")} Merged #${n} (${r.method ?? method}) ${ctx.c.dim(String(r.sha ?? "").slice(0, 12))}${payload.delete_branch ? " and deleted the branch" : ""}`);
  },
};

const comment: Command = {
  name: "pr comment",
  summary: "Comment on a pull request",
  description: "Without a number, comments on the open pull request for the current branch.",
  args: "[<number>]",
  options: bodyOpts,
  repo: true,
  json: true,
  maxArgs: 1,
  async run(ctx, o, [num]) {
    const body = await bodyFrom(ctx, o, true);
    if (!body?.trim()) throw new CliError("--body is required", 2);
    const n = await prNumber(ctx, num);
    const repo = await ctx.repo();
    const r = await (await ctx.authedApi()).post<CommentJson>(`${repoPath(repo)}/issues/${n}/comments`, { body });
    if (ctx.json) return json(ctx.io, r);
    ctx.out(`${ctx.c.green("✓")} Commented on #${n}`);
  },
};

const ready: Command = {
  name: "pr ready",
  summary: "Mark a draft pull request ready for review",
  description: "Without a number, uses the open pull request for the current branch.",
  args: "[<number>]",
  options: { undo: { type: "boolean", desc: "Convert the pull request back to a draft" } },
  repo: true,
  json: true,
  maxArgs: 1,
  async run(ctx, o, [num]) {
    const n = await prNumber(ctx, num);
    const repo = await ctx.repo();
    const pr = await (await ctx.authedApi()).patch<IssueJson>(`${repoPath(repo)}/pulls/${n}`, { draft: o.undo === true });
    if (ctx.json) return json(ctx.io, pr);
    ctx.out(`${ctx.c.green("✓")} ${o.undo === true ? `Converted #${n} to a draft` : `Marked #${n} ready for review`}`);
  },
};

export const prGroup: Group = { name: "pr", summary: "Work with pull requests", commands: [create, listCmd, view, diff, checks, review, merge, ready, comment] };
