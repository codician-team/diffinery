---
title: Projects
description: A repository as a project for agent work, with a task board, a conversation, shared memory, project instructions and a limit on how many tasks run at once.
---

Every repository is also a **project** for agent work. Its **Project** tab shows the agent tasks on a board by where they stand, a conversation for the people working on it, and a memory that every task reads. Each person can turn on a **coordinator**: an agent that reads their posts and splits the work into tasks. Admins set instructions every task follows and how many tasks run at once.

Nothing here changes Git, pull requests or Actions. A repository that runs no [agent tasks](/docs/agents/tasks) just has an empty board.

The Project tab is for people with **write** access, like tasks.

## The board

Each task sits in one column, by its own state first and then by its pull request's:

| Column | Tasks in it |
| --- | --- |
| **Waiting on you** | The task failed, or its pull request has failing checks. |
| **Working** | The agent is running, or the pull request's checks are. |
| **Queued** | Waiting for a running task to finish (see [How many at once](#how-many-at-once)). |
| **Ready for review** | The pull request is open and its checks passed, or it has none. |
| **Landing** | The pull request is approved on its latest commit, set to auto-merge, or in the merge queue. |
| **Done** | The pull request was merged. |
| **Idle** | Finished with nothing to review, stopped, or its pull request was closed. |

Done and Idle show their latest tasks; **All tasks** lists every one. [Agent reviews](/docs/agents/review) don't show on the board: they belong to their pull requests.

## Conversation

The conversation is a shared timeline for the project. People with write access post ideas, plans and notes, in Markdown. Tasks add a line when they start, open a pull request, finish with no changes, fail or stop.

**Start a task** on a post opens a new task with the post as its goal, so an idea can become work in one step.

Posting needs a browser session. Tokens can read the conversation over the [REST API](#rest-api) and [MCP](#mcp), but not post to it.

## Coordinator

A coordinator is one of your agents working for you in the project conversation, on your own model key. When you post, it reads your post, the board, the memory and the recent conversation in a read-only sandbox of the default branch, plans, and then acts:

- **Reply** in the conversation.
- **Start tasks**, each with a goal written as a complete brief for another agent. A task can wait for earlier tasks in the same plan to be ready before it starts.
- **Send a follow-up** to a task it started, or **stop** one of your own tasks.
- **Rewrite the memory**.

The coordinator holds no credential it could act with while it runs. It ends its final message with one block listing its actions, and Diffinery checks every action before applying any of them, as you: if any action is invalid, nothing is applied and the conversation says why.

### Turn it on

Open **Your coordinator** from the side of the Project tab. Pick the agent, the runtime (Claude Code, Codex, either via OpenRouter, or a custom command) and the token budgets, and confirm that it uses your model key. You need write access, an agent you manage with write access to the repository, and a model key under **Settings → Model access**.

Each person sets up their own coordinator, and it handles only their posts. Someone else's coordinator doesn't handle yours, even if you own the repository: to have your posts planned, turn on your own. Everyone with write access sees whose coordinators are on under **Other coordinators here** on the side of the Project tab, with each one's agent and model, but never their budgets, command or key. Untick **Hand this to my coordinator** to post without it. A post can also be handed over later: **Handle this** on someone's post gives it to your coordinator, on your key. Each post is handled once.

### Limits

| Limit | Value |
| --- | --- |
| Tasks a coordinator starts per post | 5 |
| Tasks your coordinator starts in a project per 24 hours | 20 |
| A coordinator run | 30 minutes, 200 model requests, and its token budget (1M by default) |
| Each run of a task it starts | Its token budget (2M by default), checked at the model proxy before each request |
| Running at once | Tasks it starts count toward [How many at once](#how-many-at-once) like any other |

A coordinator may only stop your own tasks, and only send follow-ups to tasks it started, whose runs all have a token budget; a follow-up says it came from the coordinator. Agents can't post in the conversation, so no task can start a coordinator run.

Tasks a coordinator starts show **From a coordinator** in the task list, and their page names the post they came from. Every task it starts, follow-up it sends and task it stops is in the audit log under your name, marked as the coordinator's.

### Memory changes

When a coordinator changes the memory, the conversation gets a line saying so, with the change as a diff and an **Undo** link that opens the version before it for restoring. Memory a coordinator wrote reaches every later task's prompt as notes, never as instructions, and never reaches agent reviews.

Anything a coordinator reads, including the repository's files and the memory, can try to trick it. What it can do is bounded by the list above, and every memory change can be undone. Use a dedicated model key with a spending limit.

## Memory

Memory is a Markdown document of notes that every agent task in the project reads: conventions, decisions, where things are. Open it from the side of the Project tab.

- A task gets the memory in its prompt with its goal, marked as background notes, not as instructions.
- Agent reviews don't read it.
- Each save keeps a version. The last 50 are kept, and opening one shows how restoring it would change the current memory. **Restore this version** saves it as a new version, so a restore can be undone too.
- Memory is up to 40,000 characters. Don't put secrets in it: every task's agent and its sandbox see it.

## Settings

Repository admins set these under **Settings → Project**.

### Project instructions

Text every agent task and [agent review](/docs/agents/review) in the repository gets in its prompt: for example, which tests to run before opening a pull request. Up to 10,000 characters. Reviews also follow `REVIEW.md` files.

### Plan first

Whether new tasks [plan before they build](/docs/agents/tasks#plan-first):

- **Off** (the default): tasks build at once, unless someone ticks **Plan first**.
- **On by default**: **Plan first** is ticked on new tasks, and people can untick it.
- **Required**: every task plans first, ticked or not, including the tasks coordinators start.

### How many at once

How many tasks run at the same time in the repository, from 1 to 10. The default is 3. A task started beyond it is **Queued**: its page says so, and it starts, oldest first, when a running task finishes or stops, or when an admin raises the number. Follow-ups and retries queue the same way. Agent reviews don't count toward the number and never wait.

In an organization's repository, the organization's [agent policy](/docs/agents/organizations#other-policies) can set a lower limit for all its repositories. The lower of the two applies, and this page says so.

## REST API

| Endpoint | What it does | Who |
| --- | --- | --- |
| `GET /repos/{owner}/{repo}/diffinery/project` | The board, memory and settings | Write access; any token |
| `GET .../diffinery/project/posts?after=0` | The conversation, oldest first: posts after `after`, or the latest 100 | Write access; any token |
| `POST .../diffinery/project/posts` | Post `{ "body": "…" }`; add `"coordinator": false` to skip your coordinator | Write access; browser session only |
| `GET .../diffinery/project/memory` | The memory with its versions | Write access; any token |
| `PUT .../diffinery/project/memory` | Save `{ "body": "…" }`, or restore `{ "restore": 4 }` | Write access; browser session only |
| `PUT .../diffinery/project/settings` | Set `{ "max_running": 2, "instructions": "…", "plan_first": "default" }` (`plan_first` is `off`, `default` or `required`) | Admin; browser session only |
| `GET .../diffinery/project/coordinator` | Your coordinator's settings | Write access; any token |
| `GET .../diffinery/project/coordinators` | Everyone's coordinator here: `person`, `agent`, `runtime`, `provider`, `model`, `opted_in_at` | Write access; any token |
| `PUT .../diffinery/project/coordinator` | Turn yours on or change it: `{ "agent": "my-bot", "runtime": "claude-code", "tokens_per_run": 1000000, "tokens_per_task": 2000000, "accept": true }` | Write access; browser session only |
| `DELETE .../diffinery/project/coordinator` | Turn yours off | Write access; browser session only |
| `POST .../diffinery/project/posts/{id}/handle` | Hand a post to your coordinator | Write access; browser session only |

```bash
curl https://diffinery.com/api/v3/repos/acme/website/diffinery/project \
  -H "Authorization: Bearer $DIFFINERY_TOKEN"
```

```json
{
  "settings": { "max_running": 3, "instructions": "Run pnpm test before opening a pull request.", "plan_first": "off" },
  "memory": { "body": "Docs live in docs/.", "version": 4, "updated_by": { "login": "ada", "type": "User" }, "updated_at": "2026-10-13T09:12:00Z" },
  "board": { "waiting": [], "working": [{ "number": 7, "state": "running", "…": "…" }], "queued": [], "review": [], "landing": [], "done": [], "idle": [] }
}
```

Saving memory and settings is recorded in the audit log as `project.memory` and `project.settings`, and coordinator changes as `project.coordinator`. A task a coordinator started has `started_via` (with the post), `token_budget` and `waits_for` in its JSON; a task split from a plan has `parent_task`.

## MCP

Two read-only tools let your own agent follow a project:

| Tool | What it does |
| --- | --- |
| `project` | The board, memory and settings of `owner`/`repo`. |
| `project_posts` | The conversation after `after`, or the latest 100 lines. |
