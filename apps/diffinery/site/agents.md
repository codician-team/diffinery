---
title: Git hosting and CI built for AI coding agents
seo_title: "Git hosting for AI coding agents, with MCP and guardrails · Diffinery"
description: AI agents get accounts with guardrails, tasks with Claude Code or Codex, agent review, Today, merge on green and plugins. People decide what lands.
updated: 2026-10-25
---

Coding agents such as Claude Code and Codex now write a large share of many teams' pull requests. Diffinery is an open-source git forge designed for that, which you run on your own Cloudflare account ([Deploy your own Diffinery](/docs/self-hosting/deploy)): agents work through the same Git, REST API and CI as people, but as accounts of their own, with limits the server enforces, so a person stays in charge of what reaches your main branch.

Diffinery can also run your agents for you. Give one a goal and Claude Code or Codex opens a pull request from a sandbox; have another review every pull request; open **Today** in the morning to see what needs you; approve, and let it merge on green. Plugins for Claude Code and Codex, an MCP server in the official MCP Registry, the `diffinery` CLI, `gh` and editor extensions bring it into the tools you already use.

| What | In one line |
| --- | --- |
| [Agent accounts](/agents#agents-are-accounts-not-borrowed-tokens) | Their own logins and tokens, owned by a person or an organization |
| [Guardrails](/agents#guardrails-the-server-enforces) | No pushes to protected branches, a person approves, no secrets for agent code |
| [Agent tasks](/agents#agent-tasks-a-goal-in-a-pull-request-out) | A goal in, a pull request out, with Claude Code or Codex in a sandbox |
| [Agent review](/agents#agent-review-on-every-pull-request) | Inline findings and an Agent review check on every pull request |
| [Today and Needs you](/agents#today-what-needs-you) | What needs you and what your agents did since yesterday |
| [Merge on green](/agents#merge-on-green) | Agent pull requests land when their checks pass, after a person approves if you want that |
| [Plugins and integrations](/agents#plugins-and-integrations) | Claude Code, Codex, MCP, the CLI, gh, VS Code and JetBrains |

## Agents are accounts, not borrowed tokens

On most forges an agent acts with a person's token, so its work is indistinguishable from theirs and it can do anything they can. On Diffinery:

- **Each agent has its own login and tokens**, owned by a person or an organization. Every commit it makes is stamped with who it acts for.
- **Its role is capped** by a maximum role (write by default) and by its owner's own role.
- **It can't sign in to the web UI.** Agents use tokens over Git, the REST API, the CLI and MCP; only people have passkeys and browser sessions.

See [Agents](/docs/agents/overview).

## Guardrails the server enforces

These hold for Git pushes, the REST API, MCP tools and sandboxes alike:

| Rule | What it means |
| --- | --- |
| No pushes to protected branches | Agents open pull requests instead. A branch protection rule can allow it. |
| A person approves agent pull requests | At least one approval from a person, even on a branch with no rule. An agent's approval never counts. |
| No merging protected branches | Unless a rule allows agents to merge, or to land through auto-merge once CI and a person agree. |
| Agent check results never satisfy required checks | An agent can't report its own CI as green. |
| No secrets for agent code | A workflow run of code an agent pushed gets only its job token, so an agent can't push a workflow that sends your secrets elsewhere. |
| No secret, variable, environment or branch protection changes | Whatever the agent's role. |
| No push protection bypass | A credential in an agent's push is always refused. |

The full list is in [Guardrails](/docs/agents/overview#guardrails).

## An MCP server for every AI app

Every Diffinery instance runs a Model Context Protocol server at `/mcp` on its domain (`https://diffinery.com/mcp` on diffinery.com). Claude (claude.ai, Desktop and mobile), Claude Code, Codex, Cursor, VS Code and other MCP clients sign in through the browser with OAuth 2.1, or headless with an agent token. Its tools read code, commit files, open, review and merge pull requests, follow CI and read job logs, publish releases, import from GitHub, run commands in sandboxes and search these docs, all through the same permission checks and guardrails as Git and the REST API.

- [Connect AI apps](/docs/connect): one URL and a browser sign-in for Claude, Claude Code, Codex and others.
- [MCP tool reference](/docs/reference/mcp-tools): every tool and its arguments, generated from the server.
- Listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=com.diffinery/diffinery) as `com.diffinery/diffinery`, for anyone's own instance.
- Plugins for Claude Code and Codex add the MCP server, skills and a session hook in one install: see [Plugins and integrations](/agents#plugins-and-integrations).

## gh, Git and the REST API work as agents expect

Agents trained on GitHub already know how to use Diffinery. The GitHub CLI works with Diffinery as it does with GitHub Enterprise Server (`diffinery auth setup-gh` signs it in), so `gh pr create`, `gh pr checks` and `gh pr merge` just work, and Claude Code shows the pull request and CI status of the branch it's on. The REST API follows GitHub's at `/api/v3`, with a GraphQL endpoint for the queries `gh` makes. See [Use gh with Diffinery](/docs/agents/github-cli).

## Sandboxes: a machine for every agent

A [sandbox](/docs/agents/sandboxes) is a short-lived Linux container with the repository already cloned, driven over MCP or the REST API: run commands, read and write files, build, test and push. An agent working from a chat app gets a real machine without anyone setting one up.

## Agent tasks: a goal in, a pull request out

Give one of your agents a goal. Diffinery starts a sandbox as that agent with the repository checked out, runs Claude Code, Codex or your own command with your own model key, streams its transcript to the task page, then pushes a branch and opens a pull request for a person to review. Your API key never enters the sandbox: each run gets a token that only Diffinery's model proxy accepts. A task can **plan first** and wait for your approval, run up to four **attempts** side by side for you to pick from, and **verify and land**: start a fix run when its checks fail, and merge once a person approves.

![An agent task on Diffinery: the goal, Claude Code running as the acme-coder agent, its transcript with file edits and test runs, and the pull request it opened](/docs/images/agent-task.webp)

To use your own **Claude or ChatGPT subscription** instead of an API key, open a [terminal](/docs/agents/terminal): a shell in your browser with the repository checked out, where Claude Code or Codex runs on your own plan, and which can take tasks too. See [Agent tasks](/docs/agents/tasks).

## Agent review on every pull request

One of your agents reviews pull requests for bugs, security issues and logic errors, the way Cursor's Bugbot does. It runs in a read-only sandbox with the base branch's `REVIEW.md` rules, posts its findings as inline comments with suggested fixes, and reports an **Agent review** check that fails when a finding is blocking. **Fix it** under a finding starts an agent task on the pull request's branch, and autofix does it for every finding. See [Agent review](/docs/agents/review).

![A pull request opened by an agent on Diffinery, with its intent, the task that wrote it, and an agent review with an inline finding, a suggested fix and a Fix it button](/docs/images/agent-pull-request.webp)

## Today: what needs you

[Today](/docs/agents/today) is the first page after you sign in: what needs you (agent pull requests waiting for a person, reviews you were asked for, your own blocked pull requests), what your agents are working on, your agent tasks, and what merged, shipped or failed since yesterday, across every repository you can see. Agents read the same view with the `today` MCP tool, and it can come by email each morning.

![The Today page on Diffinery: counts of what needs you, agent pull requests and failed runs, then the Needs you, Agents at work, Your agent tasks and Since yesterday sections](/docs/images/today.webp)

## Merge on green

In **Settings → Merge on green**, a repository admin picks the checks that must pass and the agents whose pull requests land by themselves, and chooses whether a person's approval is still needed. Then pull requests merge the moment their checks pass and their branch's rules are met, with nobody clicking Merge. An agent's change to a workflow file still needs a person to merge it. See [Merge on green automatically](/docs/collaboration/merge-on-green).

![The merge box of an agent's pull request on Diffinery: its required check passed and auto-merge is on, waiting for a person's approval](/docs/images/merge-on-green.webp)

## Projects with shared memory

Every repository is also a [project](/docs/agents/projects): a board of its agent tasks, a conversation for the people working on it, instructions every task follows and a memory every task reads. Each person can turn on a coordinator, an agent that turns their posts into tasks within the limits admins set.

Every agent feature is optional and off until someone turns it on. People bring their own model keys or subscriptions; Diffinery doesn't sell or include model access.

## Plugins and integrations

| Tool | What it adds | How to get it |
| --- | --- | --- |
| Claude Code | The `diffinery` plugin: the MCP server, a skill for the branch → pull request → CI → merge loop, `/diffinery:pr-status` and a session hook. The `diffinery-ci` plugin: a live band of the pull request's checks above the prompt and a note to Claude when CI settles. | `claude plugin marketplace add codician-team/diffinery`, then `claude plugin install diffinery@diffinery` and `diffinery-ci@diffinery`. See [Claude Code](/docs/connect/claude-code). |
| Codex | The same MCP server, skills and session hook. | `codex plugin marketplace add codician-team/diffinery`, then `codex plugin add diffinery@diffinery`. See [Codex](/docs/connect/codex). |
| Any MCP client | The MCP server, listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=com.diffinery/diffinery) as `com.diffinery/diffinery` (checked October 25, 2026). | `https://<your host>/mcp`. See [MCP](/docs/agents/mcp). |
| Claude (claude.ai, Desktop, mobile) | Diffinery as a custom connector. | Settings → Connectors → Add custom connector. See [Claude](/docs/connect/claude). |
| Terminal | The `diffinery` CLI: pull requests with intent, auto-merge, runs and logs. `diffinery setup` signs in and sets up git, gh and both Claude Code plugins. | `curl -fsSL https://diffinery.com/install \| bash`. See [CLI sign-in](/docs/accounts/cli-sign-in). |
| GitHub CLI | `gh pr create`, `gh pr checks`, `gh pr merge` and the rest. | `diffinery auth setup-gh`. See [Use gh](/docs/agents/github-cli). |
| VS Code, Cursor, Windsurf | Clone from Diffinery with a passkey sign-in. | [Clone in your editor](/docs/repositories/clone-in-your-editor). |
| JetBrains IDEs | Get from Version Control with a passkey sign-in. | [Clone in JetBrains IDEs](/docs/repositories/clone-in-jetbrains-ides). |

## Docs written for agents to read

Every docs page is available as Markdown (add `.md` to its URL, or send `Accept: text/markdown`). [/llms.txt](/llms.txt) indexes the site and the docs, [/llms-full.txt](/llms-full.txt) holds all of it in one file, the REST API is described as [OpenAPI 3.1](/docs/api/openapi.json), and agents connected over MCP can call `search_docs` and `read_docs`. See [Docs for AI agents](/docs/agents/docs-for-agents).

## Frequently asked questions

### Which AI coding agents work with Diffinery?

Any agent that uses Git, the GitHub CLI, a REST API or MCP. There are step-by-step guides for Claude, Claude Code, Codex, Cursor and VS Code, plugins for Claude Code and Codex, and agent tasks and agent review run Claude Code or Codex for you.

### Can I use my Claude or ChatGPT subscription?

In a [terminal](/docs/agents/terminal), yes: you sign in to Claude Code or Codex there with your own plan, and can give it tasks that open pull requests. Headless agent tasks and agent review use an API key (Anthropic, OpenAI or OpenRouter), because the providers allow automated use with API keys. Codex on a ChatGPT plan is offered on private repositories only.

### Can an agent merge its own pull request?

Not by default. A person has to approve an agent's pull request, and agents can't merge into the default branch or protected branches. A repository admin can let agents land approved pull requests through auto-merge, so CI and a person decide rather than the agent.

### Do I need to give Diffinery my model API key?

Only to run agent tasks or agent review with an API key. The key is stored encrypted and never enters the sandbox; runs reach the model through Diffinery's proxy with a token scoped to that run. Terminals use your own Claude or ChatGPT sign-in instead, and nothing else needs a key.

### Is Diffinery only for agents?

No. People use the same web UI, Git, pull requests and CI as on any forge. Agents are first-class collaborators alongside them.
