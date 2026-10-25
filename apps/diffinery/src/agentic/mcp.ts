import { requireAccount } from "../auth/principal.js";
import type { Tool } from "../mcp/server.js";
import { tokenRepoIds } from "./api.js";
import { loadRepo } from "../http/common.js";
import { HttpError } from "../lib/util.js";
import { getTask, lineJson, myTasks, projectStub, requireTaskReader, taskJson } from "./tasks.js";
import { gatherToday, todayJson } from "./today.js";
import { boardJson, loadBoard, postJson } from "./projects.js";

type Args = Record<string, unknown>;
const OWNER_REPO = {
  owner: { type: "string", description: "Repository owner (user or org login)" },
  repo: { type: "string", description: "Repository name" },
};
const need = (a: Args, k: string): string => {
  if (typeof a[k] !== "string" || !a[k]) throw new HttpError(422, `${k} is required`);
  return a[k] as string;
};
const num = (a: Args, k: string): number => {
  const n = Number(a[k]);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(422, `${k} must be a positive integer`);
  return n;
};

/** MCP tools for agentic work (merged into mcp/server.ts). */
export const AGENTIC_TOOLS: Record<string, Tool> = {
  today: {
    description:
      "Your morning view across every repository you can see: pull requests that need you (review requests, agent pull requests waiting for a person's approval, your own blocked ones), what your agents are working on and where each stands, and what merged, was released or failed in the last 24 hours.",
    input: {},
    readOnly: true,
    run: async (c) => todayJson(c.env.PUBLIC_URL.replace(/\/$/, ""), await gatherToday(c.env, c.get("dir"), requireAccount(c), { repoIds: tokenRepoIds(c) })),
  },
  // Agent tasks are read-only over MCP: starting, steering and retrying spend a person's own model key, so they need a browser session.
  agent_tasks: {
    description:
      "List agent tasks. With owner and repo: that repository's tasks (you need write access). Without: the tasks you started (for an agent: the tasks it runs). Starting, steering and retrying tasks happens on the web, by the person whose model key it spends.",
    input: { ...OWNER_REPO },
    readOnly: true,
    run: async (c, a) => {
      if (!a.owner && !a.repo) return myTasks(c, requireAccount(c), tokenRepoIds(c));
      const l = await loadRepo(c, need(a, "owner"), need(a, "repo"), "read", { follow: true });
      requireTaskReader(l);
      const base = c.env.PUBLIC_URL.replace(/\/$/, "");
      return (await projectStub(c.env, l.repo.id).list({ limit: 50 })).map((t) => taskJson(base, `${l.repo.owner_login}/${l.repo.name}`, t));
    },
  },
  project: {
    description:
      "A repository as a project: its task board grouped by state (waiting on you, working, queued, ready for review, landing, done, idle), the project's memory and its settings (how many tasks run at once, instructions every task gets). You need write access.",
    input: { ...OWNER_REPO },
    required: ["owner", "repo"],
    readOnly: true,
    run: async (c, a) => {
      const l = await loadRepo(c, need(a, "owner"), need(a, "repo"), "read", { follow: true });
      requireTaskReader(l);
      return boardJson(c.env.PUBLIC_URL.replace(/\/$/, ""), `${l.repo.owner_login}/${l.repo.name}`, await loadBoard(c, l));
    },
  },
  project_posts: {
    description: "The project conversation: people's posts and task events, oldest first, after `after` (a post id), or the latest 100. Posting happens on the web, by a person.",
    input: { ...OWNER_REPO, after: { type: "integer", description: "Return posts after this id" } },
    required: ["owner", "repo"],
    readOnly: true,
    run: async (c, a) => {
      const l = await loadRepo(c, need(a, "owner"), need(a, "repo"), "read", { follow: true });
      requireTaskReader(l);
      const base = c.env.PUBLIC_URL.replace(/\/$/, "");
      return (await projectStub(c.env, l.repo.id).posts(Number(a.after) || 0, 100)).map((p) => postJson(base, `${l.repo.owner_login}/${l.repo.name}`, p));
    },
  },
  agent_task: {
    description: "One agent task: its goal, state, runs, branch and pull request, and its transcript after `after` (a line number; default from the start, at most 500 lines).",
    input: { ...OWNER_REPO, number: { type: "integer", description: "Task number" }, after: { type: "integer", description: "Return transcript lines after this one" } },
    required: ["owner", "repo", "number"],
    readOnly: true,
    run: async (c, a) => {
      const l = await loadRepo(c, need(a, "owner"), need(a, "repo"), "read", { follow: true });
      const n = num(a, "number");
      const t = await getTask(c, l, n);
      const lines = await projectStub(c.env, l.repo.id).lines(n, Number(a.after) || 0, 500);
      return { ...taskJson(c.env.PUBLIC_URL.replace(/\/$/, ""), `${l.repo.owner_login}/${l.repo.name}`, t), transcript: lines.map(lineJson) };
    },
  },
};
