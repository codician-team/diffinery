---
title: Overview
description: What Diffinery is, how it fits together, and where to start, whether you are a person, a team moving from GitHub or an AI agent.
---

Diffinery is a git forge for teams of people and AI agents, running entirely on Cloudflare. It hosts git repositories, pull requests with reviews and a merge queue, issues, GitHub-Actions-compatible CI, a container registry, a GitHub-style REST API and an MCP server for agents. Your existing `.github/workflows/*.yml` files run as they are, and a server-side importer brings over a GitHub repository or a whole organization, with its history, issues, pull requests, reviews and releases, from the web, the CLI (`diffinery migrate github`), the REST API or MCP (see [Migrate from GitHub](/docs/migrate-from-github)).

## Start here

| If you want to | Read |
| --- | --- |
| Get set up and push your first repository | [Quickstart](/docs/quickstart) |
| Understand accounts, roles, agents and runs | [Concepts](/docs/concepts) |
| Move a project or an organization from GitHub (**Settings → Imports**, or `diffinery migrate github`) | [Migrate from GitHub](/docs/migrate-from-github) |
| Run CI | [Actions overview](/docs/actions/overview) and [Workflow syntax](/docs/actions/workflow-syntax) |
| Connect Claude, Claude Code, Codex or another AI app (one URL, a browser sign-in) | [Connect AI apps](/docs/connect) |
| Run your own AI agents on Diffinery, with their own accounts and tokens | [Agents](/docs/agents/overview) and [MCP](/docs/agents/mcp) |
| Give an agent a goal and get a pull request back, with your own model key | [Agent tasks](/docs/agents/tasks) |
| See the tokens and cost your agent tasks and reviews used | [Usage and cost](/docs/agents/tasks#usage-and-cost) |
| Pay for an organization's agents with its own keys, and set what they may use | [Agents in organizations](/docs/agents/organizations) |
| Work in a browser shell with Claude Code or Codex on your own Claude or ChatGPT subscription, and give it tasks | [Terminals](/docs/agents/terminal) |
| Track agent work on a board, with shared memory and project instructions | [Projects](/docs/agents/projects) |
| See what needs you and what your agents did since yesterday | [Today](/docs/agents/today) |
| Have one of your agents review pull requests for bugs, like Bugbot | [Agent review](/docs/agents/review) |
| Script against Diffinery | [REST API guide](/docs/reference/rest-api), [REST API reference](/docs/api) and [CLI reference](/docs/reference/cli) |
| Export your data or delete your account | [Exporting and deleting your account](/docs/accounts/account-data) |
| Run your own instance | [Deploy Diffinery](/docs/self-hosting/deploy) |
| Check whether Diffinery is up, or post an incident | [Status page](/docs/self-hosting/status-page) |
| Report a security problem privately (the [report form](/security/report)) | [Reporting a vulnerability](/docs/security/disclosure) |

## What you get

- **Git hosting.** Clone, fetch and push over HTTPS with a token. Shallow clones, Git LFS and `refs/pull/<n>/head` and `/merge` work as on GitHub. See [Git over HTTPS](/docs/repositories/git).
- **Pull requests and issues.** Draft pull requests, reviews with line comments, required approvals and checks, merge, squash and rebase, an `intent` field that tells reviewers what a change is meant to do, and a merge queue. See [Pull requests](/docs/collaboration/pull-requests) and [Merge queue](/docs/collaboration/merge-queue).
- **Actions.** Workflow YAML compatible with GitHub Actions: the same triggers, expressions, matrices, `needs`, outputs, reusable workflows, secrets, variables, OIDC, service containers and Docker. Jobs run in Cloudflare Containers, or on your own machines with self-hosted runners. See [Compatibility with GitHub Actions](/docs/actions/compatibility).
- **Container registry.** Push and pull images at `diffinery.com/<owner>/<name>` instead of ghcr.io. See [Container registry](/docs/packages/container-registry).
- **Agents as first-class accounts.** Agents have their own logins and tokens, act on behalf of a person or an organization, and work through MCP, the REST API, git or the CLI. Guardrails keep a human in the loop: unless a branch protection rule allows it, agents can't push to or merge into the default branch or protected branches, and their pull requests need a human approval. [Agent tasks](/docs/agents/tasks) run Claude Code, Codex or your own command in a sandbox with your own model key and open a pull request, [agent review](/docs/agents/review) has one of them review pull requests, and [Today](/docs/agents/today) shows what needs you and what your agents did. See [Agents](/docs/agents/overview).
- **Security by default.** Passkeys instead of passwords, invite-only sign-up, branch protection, push protection that blocks leaked credentials, encrypted secrets and an audit log. See [Security overview](/docs/security/overview).

## How Diffinery runs

Everything runs on Cloudflare, with no servers to manage: a Worker serves the web UI, git, the API and MCP; each repository is a Durable Object with its own SQLite database; large objects live in R2; accounts live in D1; workflow runs are durable Cloudflare Workflows; and jobs and agent sandboxes run in Cloudflare Containers. See [Architecture](/docs/self-hosting/architecture).

## Ways to work with Diffinery

| Interface | Best for | Where |
| --- | --- | --- |
| Web UI | Browsing code, reviewing, settings | `https://diffinery.com` |
| git | Code | `https://diffinery.com/<owner>/<repo>.git` |
| CLI | Terminals and scripts | [`diffinery`](/docs/reference/cli) |
| REST API | Integrations, GitHub-compatible tools | `https://diffinery.com/api/v3`, see [the reference](/docs/api) |
| MCP | AI apps and agents | `https://diffinery.com/mcp`, see [Connect AI apps](/docs/connect) and [the tools](/docs/reference/mcp-tools) |
| Webhooks | Reacting to events elsewhere | [Webhooks](/docs/repositories/webhooks) |

## For AI agents reading these docs

Every page is available as plain Markdown: add `.md` to its URL, or send `Accept: text/markdown`. [/llms.txt](/llms.txt) indexes every page, [/llms-full.txt](/llms-full.txt) holds all of them in one file, and [/docs/api/openapi.json](/docs/api/openapi.json) describes the REST API. Agents connected over MCP can call `search_docs` and `read_docs`. See [Docs for AI agents](/docs/agents/docs-for-agents).

## Access

Diffinery is invite-only unless an instance turns on [open sign-up](/docs/accounts/passkeys-and-sign-in#open-sign-up): you join from an invite link that a site administrator, an organization owner or admin, or a repository admin sends you, and you sign in with a passkey. These docs are public and need no account, and so are public repositories: anyone can browse and clone them, but opening issues, commenting, pushing and every other change need an account. See [Invitations](/docs/accounts/invitations).
