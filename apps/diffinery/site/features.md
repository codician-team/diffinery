---
title: Git hosting, pull requests and GitHub Actions–compatible CI in one place
seo_title: "Features: Git hosting, pull requests, CI and AI agents · Diffinery"
description: Everything open-source Diffinery does: Git hosting, pull requests and a merge queue, GitHub Actions–compatible CI, a container registry and AI agents.
updated: 2026-10-25
---

Diffinery is an open-source (Apache-2.0) git forge for teams of people and AI agents. It hosts your repositories, reviews and CI in one place, runs your existing GitHub Actions workflows as they are, and treats AI coding agents as accounts with their own tokens and guardrails. It runs entirely on Cloudflare: you [deploy your own instance](/docs/self-hosting/deploy) to your own Cloudflare account and domain, and there are no servers to manage. The source code is at [diffinery.com/codician/diffinery](https://diffinery.com/codician/diffinery), mirrored on [GitHub](https://github.com/codician-team/diffinery).

This page lists what Diffinery does today, what it doesn't do yet, and where each feature is documented.

## Git hosting

- **Clone, fetch and push over HTTPS** with a token or a browser sign-in from the CLI or your editor. Shallow clones, Git LFS, tags and `refs/pull/<n>/head` and `/merge` work as on GitHub. See [Git over HTTPS](/docs/repositories/git).
- **Every repository is its own strongly consistent store.** Each repository is a Cloudflare Durable Object with its own SQLite database, so one busy repository never slows another.
- **Push protection on by default.** Every push, and every commit made through the web editor, the API or MCP, is scanned for leaked credentials, and a push that contains one is refused with nothing kept. See [Push protection](/docs/security/push-protection).
- **Branch protection** with required pull requests, approvals, required checks, linear history, merge queues and rules for agents. See [Branch protection](/docs/repositories/branch-protection).
- **Browse code** in the web UI with highlighted files and diffs, history, branches and tags, a command palette and an in-browser editor. See [Browsing code](/docs/repositories/browsing-code).

## Pull requests, reviews and issues

- **Pull requests with intent.** Every pull request can say what the change is meant to do, so human and AI reviewers check the right thing. Drafts, reviews with line comments, required approvals and checks, and merge, squash or rebase. See [Pull requests](/docs/collaboration/pull-requests).
- **Auto-merge and a merge queue.** Pull requests land on their own once they're approved and green, and a merge queue tests each one on top of the base branch and the pull requests ahead of it, with the same `merge_group` event and `gh-readonly-queue/` branches as GitHub. See [Merge queue](/docs/collaboration/merge-queue).
- **Issues** with labels, assignees, milestones, reactions, locking and search. See [Issues](/docs/collaboration/issues).
- **Releases** with notes and downloadable files, following GitHub's model and REST API. See [Releases](/docs/collaboration/releases).
- **Checks and commit statuses** from Diffinery Actions, external CI and bots. See [Checks and commit statuses](/docs/collaboration/checks-and-statuses).

## Actions: CI that runs your GitHub workflows

- **Drop-in for GitHub Actions.** Diffinery reads `.github/workflows/*.yml` with the same triggers, expressions, matrices, `needs`, outputs, reusable workflows, environments, secrets, variables, OIDC, service containers and Docker. JavaScript, composite and Docker actions from GitHub run as they do there. See [Compatibility with GitHub Actions](/docs/actions/compatibility), which lists every difference.
- **Fast built-in actions.** `actions/checkout`, `setup-node`, `setup-python`, `setup-go`, `cache`, `upload-artifact` and `download-artifact` are built into the runner, sharing storage and formats with the official actions. Caches restore in parallel ranges while they extract.
- **Hosted runners on Cloudflare Containers.** Each job gets a fresh Ubuntu 24.04 x64 container with 4 vCPUs and 12 GiB of memory by default. Jobs start in about 3 to 5 seconds. See [Runners](/docs/actions/runners) and the [measured performance](/performance).
- **Right-sized automatically.** Four sizes, from 1/4 vCPU to 4 vCPUs. Diffinery measures what each job uses and moves a job to a smaller runner only when its own runs show it fits with room to spare on the slowest hosts, and moves it back if it ever runs slower. See [Runner sizes](/docs/actions/runners#runner-sizes).
- **Self-hosted runners** for macOS, Windows, Arm, GPUs or machines on your own network, with `diffinery runner`. See [Self-hosted runners](/docs/actions/runners#self-hosted-runners).
- **Caches and artifacts** with the official `actions/cache` and `upload-artifact` formats. See [Caching and artifacts](/docs/actions/caching-and-artifacts).

## Container registry

Push and pull images at `<your instance's domain>/<owner>/<name>` (such as `diffinery.com/<owner>/<name>` on diffinery.com) with `docker`, `podman`, `buildx`, `crane` or the `docker/*` actions, instead of ghcr.io. Images are private by default and can be linked to a repository whose collaborators then share access. See [Container registry](/docs/packages/container-registry).

## Built for AI agents

- **Agents are accounts.** Each AI agent gets its own login and tokens, acts for a person or an organization, and is held to guardrails: unless a branch protection rule allows it, an agent can't push to or merge into protected branches, and its pull requests need a person's approval.
- **An MCP server** at `/mcp` on your instance (`https://diffinery.com/mcp` on diffinery.com) with browser sign-in, so Claude, Claude Code, Codex, Cursor and other AI apps can read code, commit, open and review pull requests, follow CI and run commands in sandboxes.
- **Agent tasks, reviews and terminals.** Give an agent a goal and get a pull request back, have one review pull requests for bugs, or run Claude Code or Codex in a browser terminal on your own subscription.

See [Diffinery for AI agents](/agents) for the whole picture.

## Works with the tools you already use

| Tool | How it works with Diffinery |
| --- | --- |
| `git` | Standard Git over HTTPS. `diffinery auth setup-git` signs git in through the browser. |
| GitHub CLI (`gh`) | Works as with GitHub Enterprise Server, through Diffinery's GitHub-compatible REST and GraphQL APIs. See [Use gh](/docs/agents/github-cli). |
| VS Code, Cursor, Windsurf | "Clone from Diffinery" with a passkey sign-in. See [Clone in your editor](/docs/repositories/clone-in-your-editor). |
| JetBrains IDEs | Get from Version Control with a passkey sign-in. See [Clone in JetBrains IDEs](/docs/repositories/clone-in-jetbrains-ides). |
| Claude Code and Codex | A plugin with the MCP server, skills and a session hook. See [Connect AI apps](/docs/connect). |
| Scripts and integrations | A GitHub-style REST API at `/api/v3`, described as [OpenAPI 3.1](/docs/api/openapi.json), and GitHub-compatible [webhooks](/docs/repositories/webhooks). |
| The `diffinery` CLI | Repositories, pull requests, issues, runs, secrets, runners and migrations from a terminal. See the [CLI reference](/docs/reference/cli). |

## Moving from GitHub

A server-side importer brings over a GitHub repository, or every repository of an organization, with its full Git history, issues, pull requests, reviews, comments, labels, milestones, releases and branch protection, keeping issue and pull request numbers. Secret names come across with a field to enter each value. Start it from the web, the CLI (`diffinery migrate github`), the REST API or MCP; nothing runs on your machine. See [Migrate from GitHub](/docs/migrate-from-github).

## Security

Passkeys instead of passwords, invite-only sign-up by default, branch and push protection, envelope-encrypted secrets, job tokens limited by `permissions:`, signed webhooks and an append-only audit log. See [Security](/security).

## How it runs

Everything runs on Cloudflare, in the account you deploy your instance to: a Worker serves the web UI, Git, the REST API and MCP; each repository is a Durable Object with SQLite; large objects, caches, artifacts and images live in R2; accounts live in D1; workflow runs are durable Cloudflare Workflows; and jobs and agent sandboxes run in Cloudflare Containers. See [Architecture](/docs/self-hosting/architecture).

Diffinery itself is free. You pay Cloudflare for what your instance uses: it needs the Workers Paid plan, plus usage above the included amounts. See [Built on Cloudflare](/built-on-cloudflare#run-diffinery-on-your-own-cloudflare-account).

## What Diffinery doesn't do yet

Diffinery is young, and we'd rather you know its limits before you move:

- **Hosted runners are Linux x64 only.** macOS, Windows and Arm jobs need [self-hosted runners](/docs/actions/runners#self-hosted-runners).
- **HTTPS only for Git.** There's no SSH access.
- **No forks.** Pull requests are between branches of the same repository.
- **No wikis, discussions, GitHub Pages-style sites, Codespaces-style cloud editors or app marketplace.**
- **Reviews are simpler than GitHub's.** No pending reviews, suggested changes or thread resolution yet, and branch protection has no code-owner reviews or signed-commit requirement.
- **No hosted service.** Nobody runs Diffinery for you: you deploy and run your own instance in your own Cloudflare account, and you pay Cloudflare for what it uses. See [Deploy your own Diffinery](/docs/self-hosting/deploy).
