---
title: Git hosting and CI built for AI coding agents
seo_title: "Git hosting for AI coding agents, with MCP and guardrails · Diffinery"
description: AI agents get their own accounts, tokens and guardrails on Diffinery, plus an MCP server, sandboxes, agent tasks and agent review. A person approves what lands.
updated: 2026-10-25
---

Coding agents such as Claude Code and Codex now write a large share of many teams' pull requests. Diffinery is an open-source git forge designed for that, which you run on your own Cloudflare account ([Deploy your own Diffinery](/docs/self-hosting/deploy)): agents work through the same Git, REST API and CI as people, but as accounts of their own, with limits the server enforces, so a person stays in charge of what reaches your main branch.

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
- A plugin for Claude Code and Codex adds the MCP server, skills and a session hook in one install.

## gh, Git and the REST API work as agents expect

Agents trained on GitHub already know how to use Diffinery. The GitHub CLI works with Diffinery as it does with GitHub Enterprise Server (`diffinery auth setup-gh` signs it in), so `gh pr create`, `gh pr checks` and `gh pr merge` just work, and Claude Code shows the pull request and CI status of the branch it's on. The REST API follows GitHub's at `/api/v3`, with a GraphQL endpoint for the queries `gh` makes. See [Use gh with Diffinery](/docs/agents/github-cli).

## Sandboxes: a machine for every agent

A [sandbox](/docs/agents/sandboxes) is a short-lived Linux container with the repository already cloned, driven over MCP or the REST API: run commands, read and write files, build, test and push. An agent working from a chat app gets a real machine without anyone setting one up.

## Agent tasks, review and terminals

- **[Agent tasks](/docs/agents/tasks):** give one of your agents a goal; it runs Claude Code, Codex or your own command in a sandbox with your own model key, then pushes a branch and opens a pull request for a person to review. Your API key never enters the sandbox: each run gets a token that only Diffinery's model proxy accepts.
- **[Agent review](/docs/agents/review):** one of your agents reviews pull requests for bugs, security issues and logic errors, posts inline findings and reports an Agent review check.
- **[Terminals](/docs/agents/terminal):** a shell in your browser with the repository checked out, where Claude Code or Codex runs on your own Claude or ChatGPT subscription.
- **[Projects](/docs/agents/projects) and [Today](/docs/agents/today):** a board of agent work with shared memory and instructions, and one page that shows what needs you and what your agents did since yesterday.

Every agent feature is optional and off until someone turns it on. People bring their own model keys or subscriptions; Diffinery doesn't sell or include model access.

## Docs written for agents to read

Every docs page is available as Markdown (add `.md` to its URL, or send `Accept: text/markdown`). [/llms.txt](/llms.txt) indexes the site and the docs, [/llms-full.txt](/llms-full.txt) holds all of it in one file, the REST API is described as [OpenAPI 3.1](/docs/api/openapi.json), and agents connected over MCP can call `search_docs` and `read_docs`. See [Docs for AI agents](/docs/agents/docs-for-agents).

## Frequently asked questions

### Which AI coding agents work with Diffinery?

Any agent that uses Git, the GitHub CLI, a REST API or MCP. There are step-by-step guides for Claude, Claude Code, Codex, Cursor and VS Code, and a plugin for Claude Code and Codex.

### Can an agent merge its own pull request?

Not by default. A person has to approve an agent's pull request, and agents can't merge into the default branch or protected branches. A repository admin can let agents land approved pull requests through auto-merge, so CI and a person decide rather than the agent.

### Do I need to give Diffinery my model API key?

Only to run agent tasks or agent review with an API key. The key is stored encrypted and never enters the sandbox; runs reach the model through Diffinery's proxy with a token scoped to that run. Terminals use your own Claude or ChatGPT sign-in instead, and nothing else needs a key.

### Is Diffinery only for agents?

No. People use the same web UI, Git, pull requests and CI as on any forge. Agents are first-class collaborators alongside them.
