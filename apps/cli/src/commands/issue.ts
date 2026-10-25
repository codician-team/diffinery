import { list, positiveInt, repoPath, str, type Command, type Ctx, type Group } from "../cli.js";
import { CliError } from "../io.js";
import { ago, json, table, truncate } from "../output.js";
import { bodyFrom, bodyOpts, type CommentJson, type IssueJson } from "./pr.js";

const issueState = (c: Ctx["c"], i: IssueJson) => (i.state === "open" ? c.green("open") : c.dim(i.state_reason === "not_planned" ? "not planned" : "closed"));

const create: Command = {
  name: "issue create",
  summary: "Open an issue",
  options: {
    title: { type: "string", short: "t", desc: "Title (required)", arg: "TEXT" },
    ...bodyOpts,
    label: { type: "string", short: "l", multiple: true, desc: "Add a label", arg: "NAME" },
    assignee: { type: "string", short: "a", multiple: true, desc: "Assign a login", arg: "LOGIN" },
  },
  repo: true,
  json: true,
  maxArgs: 0,
  async run(ctx, o) {
    const title = str(o, "title");
    if (!title) throw new CliError("--title is required", 2);
    const repo = await ctx.repo();
    const labels = list(o, "label");
    const assignees = list(o, "assignee");
    const i = await (await ctx.authedApi()).post<IssueJson>(`${repoPath(repo)}/issues`, { title, body: await bodyFrom(ctx, o), labels: labels.length ? labels : undefined, assignees: assignees.length ? assignees : undefined });
    if (ctx.json) return json(ctx.io, i);
    ctx.out(`${ctx.c.green("✓")} Opened issue #${i.number} ${i.title}`);
    ctx.out(i.html_url);
  },
};

const listCmd: Command = {
  name: "issue list",
  summary: "List issues",
  options: {
    state: { type: "string", short: "s", desc: "open, closed or all (default: open)", arg: "STATE" },
    label: { type: "string", short: "l", desc: "Only issues with this label", arg: "NAME" },
    author: { type: "string", short: "A", desc: "Only issues opened by this login", arg: "LOGIN" },
    search: { type: "string", short: "S", desc: "Search text", arg: "QUERY" },
    limit: { type: "string", short: "L", desc: "Maximum number to show (default 30)", arg: "N" },
  },
  repo: true,
  json: true,
  maxArgs: 0,
  async run(ctx, o) {
    const repo = await ctx.repo();
    const state = str(o, "state") ?? "open";
    if (!["open", "closed", "all"].includes(state)) throw new CliError("--state must be open, closed or all", 2);
    const limit = str(o, "limit") ? positiveInt(str(o, "limit"), "--limit") : 30;
    const items = await (await ctx.api()).get<IssueJson[]>(`${repoPath(repo)}/issues`, { state, labels: str(o, "label"), creator: str(o, "author"), q: str(o, "search"), per_page: Math.min(100, limit + 20) });
    // The issues endpoint can include pull requests (as on GitHub); show only issues.
    const issues = items.filter((i) => !i.pull_request).slice(0, limit);
    if (ctx.json) return json(ctx.io, issues);
    if (!issues.length) return ctx.err(`No ${state === "all" ? "" : `${state} `}issues in ${repo.owner}/${repo.name}.`);
    const c = ctx.c;
    ctx.io.stdout.write(table(issues.map((i) => [c.bold(`#${i.number}`), truncate(i.title, 60), issueState(c, i), c.cyan(i.labels.map((l) => l.name).join(", ")), c.dim(i.user.login), c.dim(ago(i.updated_at))])));
  },
};

const view: Command = {
  name: "issue view",
  summary: "Show an issue and its comments",
  args: "<number>",
  repo: true,
  json: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, _o, [num]) {
    const n = positiveInt(num, "issue number");
    const repo = await ctx.repo();
    const api = await ctx.api();
    const [i, comments] = await Promise.all([api.get<IssueJson>(`${repoPath(repo)}/issues/${n}`), api.get<CommentJson[]>(`${repoPath(repo)}/issues/${n}/comments`)]);
    if (ctx.json) return json(ctx.io, { ...i, comment_list: comments });
    const c = ctx.c;
    ctx.out(`${c.bold(i.title)} ${c.dim(`#${i.number}`)}`);
    ctx.out(`${issueState(c, i)} · opened by ${i.user.login} ${ago(i.created_at)}${i.labels.length ? ` · ${c.cyan(i.labels.map((l) => l.name).join(", "))}` : ""}${i.assignees.length ? ` · assigned to ${i.assignees.map((a) => a.login).join(", ")}` : ""}`);
    if (i.body?.trim()) ctx.out(`\n${i.body.trim()}`);
    for (const cm of comments) ctx.out(`\n${c.bold(cm.user.login)} ${c.dim(ago(cm.created_at))}\n${cm.body.trim()}`);
    ctx.out(`\n${c.dim(i.html_url)}`);
  },
};

const comment: Command = {
  name: "issue comment",
  summary: "Comment on an issue",
  args: "<number>",
  options: bodyOpts,
  repo: true,
  json: true,
  minArgs: 1,
  maxArgs: 1,
  async run(ctx, o, [num]) {
    const n = positiveInt(num, "issue number");
    const body = await bodyFrom(ctx, o, true);
    if (!body?.trim()) throw new CliError("--body is required", 2);
    const repo = await ctx.repo();
    const r = await (await ctx.authedApi()).post<CommentJson>(`${repoPath(repo)}/issues/${n}/comments`, { body });
    if (ctx.json) return json(ctx.io, r);
    ctx.out(`${ctx.c.green("✓")} Commented on #${n}`);
  },
};

function setState(state: "open" | "closed"): Command {
  return {
    name: state === "closed" ? "issue close" : "issue reopen",
    summary: state === "closed" ? "Close an issue" : "Reopen an issue",
    args: "<number>",
    options: {
      ...(state === "closed" ? { reason: { type: "string" as const, short: "r", desc: "completed (default) or not_planned", arg: "REASON" } } : {}),
      comment: { type: "string", short: "c", desc: "Leave a comment too", arg: "TEXT" },
    },
    repo: true,
    json: true,
    minArgs: 1,
    maxArgs: 1,
    async run(ctx, o, [num]) {
      const n = positiveInt(num, "issue number");
      const reason = str(o, "reason")?.replace(/[\s-]+/g, "_");
      if (reason && !["completed", "not_planned"].includes(reason)) throw new CliError("--reason must be completed or not_planned", 2);
      const repo = await ctx.repo();
      const api = await ctx.authedApi();
      if (str(o, "comment")) await api.post(`${repoPath(repo)}/issues/${n}/comments`, { body: str(o, "comment") });
      const i = await api.patch<IssueJson>(`${repoPath(repo)}/issues/${n}`, { state, state_reason: state === "closed" ? (reason ?? "completed") : undefined });
      if (ctx.json) return json(ctx.io, i);
      ctx.out(`${ctx.c.green("✓")} ${state === "closed" ? "Closed" : "Reopened"} #${n} ${i.title}`);
    },
  };
}

export const issueGroup: Group = { name: "issue", summary: "Work with issues", commands: [create, listCmd, view, comment, setState("closed"), setState("open")] };
