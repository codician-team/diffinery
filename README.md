# Diffinery

**An open-source, self-hostable git forge with GitHub Actions–compatible CI, built for teams of people and AI agents, running entirely on Cloudflare.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-diffinery.com%2Fdocs-f38020.svg)](https://diffinery.com/docs)
[![Runs on Cloudflare](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020.svg)](https://diffinery.com/built-on-cloudflare)

Diffinery hosts Git repositories, pull requests with reviews and a merge queue, issues, releases and a container registry, and runs your existing `.github/workflows/*.yml` files as they are. AI agents get accounts of their own, with guardrails the server enforces, and work through MCP, the REST API, git or the CLI. Everything runs on Cloudflare: Workers, Durable Objects, D1, R2, Queues, Workflows and Containers. There are no servers to run, and you can deploy your own instance to your own Cloudflare account.

- **Website and public instance:** [diffinery.com](https://diffinery.com)
- **Documentation:** [diffinery.com/docs](https://diffinery.com/docs) ([llms.txt](https://diffinery.com/llms.txt) for AI assistants)
- **Source:** [diffinery.com/codician/diffinery](https://diffinery.com/codician/diffinery), where development happens. [github.com/codician-team/diffinery](https://github.com/codician-team/diffinery) is a mirror of it.

## Contents

- [Why Diffinery](#why-diffinery)
- [Features](#features)
- [Self-host on your own Cloudflare account](#self-host-on-your-own-cloudflare-account)
- [How it runs on Cloudflare](#how-it-runs-on-cloudflare)
- [Develop locally](#develop-locally)
- [Repository layout](#repository-layout)
- [What Diffinery doesn't do (yet)](#what-diffinery-doesnt-do-yet)
- [FAQ](#faq)
- [Contributing, security and license](#contributing-security-and-license)

## Why Diffinery

- **Git hosting, pull requests and CI in one serverless app.** One Cloudflare Worker serves the web UI, git over HTTPS, a GitHub-compatible REST and GraphQL API, and an MCP server. Each repository is its own Durable Object with its own SQLite database, so repositories scale out instead of sharing one database server.
- **Your GitHub Actions workflows run unchanged.** The same triggers, expressions, matrices, `needs`, outputs, reusable workflows, environments, secrets, variables, OIDC, service containers and Docker. Marketplace actions (`uses: owner/repo@ref`) are downloaded and run. Every known difference is listed in [Compatibility with GitHub Actions](https://diffinery.com/docs/actions/compatibility).
- **Runners that exist only while a job runs.** Each job gets a fresh Ubuntu 24.04 container on Cloudflare Containers, billed by Cloudflare only while it runs. The default size has 4 vCPUs and 12 GiB of memory, and jobs that use little of it move to smaller sizes on their own. Self-hosted runners cover macOS, Windows, Arm and GPUs.
- **Built for AI agents, with a human in the loop.** Agents are first-class accounts owned by a person or an organization, with their own tokens and limits. They can't push or merge to protected branches unless a rule allows it, their pull requests need a human approval, and every commit they make records who they act for. Agent tasks run Claude Code, Codex or your own command in a sandbox and open a pull request.
- **Secure by default.** Passkey sign-in with no passwords, invite-only accounts, branch protection, push protection that blocks leaked credentials, envelope-encrypted secrets, kill switches and an append-only audit log.
- **Moving from GitHub is one step.** A server-side importer brings a repository or a whole organization over with its history, issues, pull requests, reviews and releases, and `gh`, Octokit, VS Code and JetBrains IDEs work against Diffinery.

## Features

| Area | What you get | Docs |
| --- | --- | --- |
| Git | Clone, fetch and push over HTTPS with a token; shallow clones, Git LFS, `refs/pull/<n>/head` and `/merge`; large pushes unpacked from R2 in pieces | [Git over HTTPS](https://diffinery.com/docs/repositories/git) |
| Pull requests | Draft PRs, reviews with line comments, required approvals and checks, merge, squash and rebase, auto-merge, a merge queue with `merge_group` runs, and an `intent` field that tells reviewers what a change is for | [Pull requests](https://diffinery.com/docs/collaboration/pull-requests) |
| Issues and releases | Issues, labels, milestones, reactions, mentions, releases with assets and generated notes | [Collaboration](https://diffinery.com/docs/collaboration/issues) |
| Actions (CI/CD) | GitHub Actions–compatible workflows on hosted runners in Cloudflare Containers or self-hosted runners; caches, artifacts, secrets, environments, OIDC, Docker, service containers, concurrency groups, scheduled runs | [Actions overview](https://diffinery.com/docs/actions/overview) |
| Container registry | Push and pull OCI images at `<your host>/<owner>/<name>`, in place of ghcr.io | [Container registry](https://diffinery.com/docs/packages/container-registry) |
| Agents | Agent accounts and tokens, an MCP server at `/mcp`, sandboxes, agent tasks, agent code review, projects with shared memory, and a Today page of what needs you | [Agents](https://diffinery.com/docs/agents/overview) |
| API and tools | GitHub-compatible REST (`/api/v3`) and GraphQL (`/api/graphql`) APIs, webhooks, the `diffinery` CLI, `gh` support, VS Code and JetBrains plugins, a Claude Code and Codex plugin (in [`plugins/`](plugins)) | [REST API](https://diffinery.com/docs/reference/rest-api) |
| Security | Passkeys (WebAuthn), branch protection, push protection, encrypted secrets, audit log, moderation, rate limits, quotas and kill switches | [Security overview](https://diffinery.com/docs/security/overview) |
| Migration | Import from GitHub with history, issues, pull requests, reviews and releases, from the web, CLI, API or MCP | [Migrate from GitHub](https://diffinery.com/docs/migrate-from-github) |

## Self-host on your own Cloudflare account

Diffinery is designed to be deployed by anyone to their own Cloudflare account and domain. Nobody who uses your instance needs a Cloudflare account; only the deployment does.

**You need:**

- A Cloudflare account on the **Workers Paid** plan, with R2 enabled. Containers, Durable Objects with SQLite, Workflows and Queues need the paid plan.
- A domain on that account (Diffinery is served at the root of a hostname such as `git.example.com`).
- A Cloudflare API token with the permissions listed in [Deploy your own Diffinery](https://diffinery.com/docs/self-hosting/deploy#step-2-create-a-cloudflare-api-token).
- Node.js 22, pnpm 10, Docker, `jq`, `curl` and `openssl` on the machine you deploy from.

**Deploy:**

```sh
git clone https://diffinery.com/codician/diffinery.git   # or the GitHub mirror
cd diffinery

export CLOUDFLARE_API_TOKEN=...            # never commit it
export CLOUDFLARE_ACCOUNT_ID=...
export DIFFINERY_DOMAIN=git.example.com    # your hostname
export BOOTSTRAP_ADMINS=you@example.com    # who becomes site administrator on first sign-in

scripts/setup.sh --dry-run                 # checks tools, token and config without changing anything
scripts/setup.sh                           # creates the Cloudflare resources and deploys
```

The setup script creates whatever is missing in your account (the D1 database, R2 bucket and lifecycle rules, queues, a Turnstile widget and a Cloudflare Access application for email recovery), applies the database migrations, deploys the Worker and the runner image, generates the Worker's own secrets once, and checks that the site answers. Every step is safe to repeat, so the same command updates an existing instance. Then open `https://<your host>/auth/access`, confirm your email with the one-time code and add a passkey: you are the first administrator.

You can also deploy from CI with the included [Deploy workflow](.github/workflows/deploy.yml) on Diffinery or GitHub Actions. The full guide, including email sending, DNS, Access and troubleshooting, is [Deploy your own Diffinery](https://diffinery.com/docs/self-hosting/deploy), and every setting is described in [Configuration](https://diffinery.com/docs/self-hosting/configuration).

## How it runs on Cloudflare

| Piece | Cloudflare product |
| --- | --- |
| Web UI, git smart HTTP, REST and GraphQL APIs, MCP | Workers ([Hono](https://hono.dev)) |
| One repository: refs, objects, pull requests, issues, reviews, checks, runs | A Durable Object with SQLite (`RepoDO`), one per repository |
| Large objects, Git LFS, container images, logs, caches, artifacts | R2 |
| Accounts, organizations, tokens, invites, notifications, audit log | D1, read through the Sessions API for read replicas |
| Webhooks, notifications, email | Queues, with dead-letter queues, and Email Sending |
| Workflow runs (durable, survive restarts, 6-hour job timeout) | Workflows |
| Job runners, agent sandboxes and import transfers | Containers (an Ubuntu 24.04 image in `containers/runner`) |
| Scheduled workflows (`on: schedule`) | Cron Triggers |
| Live logs and pull request updates | Durable Object WebSockets with hibernation |
| Sign-in | Passkeys (WebAuthn); Cloudflare Access guards only `/auth/access`, the email recovery path |

More in [Architecture](https://diffinery.com/docs/self-hosting/architecture).

## Develop locally

```sh
pnpm install
pnpm -r build && pnpm -r typecheck && pnpm -r test
pnpm --filter @diffinery/app db:migrate:local
pnpm dev                                    # http://localhost:8787, signed in as dev@diffinery.local
pnpm --filter @diffinery/app e2e            # wrangler dev, real git, the runner agent and Chromium
```

`pnpm dev` runs the Worker under `wrangler dev` with local D1, R2 and queues, so you need no Cloudflare account to work on Diffinery. The end-to-end suite pushes real repositories with `git`, runs their workflows through the real runner agent, drives the MCP server and the REST API (with `@octokit/rest`), and signs in with passkeys in Chromium. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Repository layout

```
apps/diffinery          the Worker: web UI, git, REST/GraphQL, MCP, Actions, D1 migrations, docs, e2e tests
apps/cli                the `diffinery` command-line client
apps/vscode             the VS Code, Cursor and Windsurf extension
apps/jetbrains          the JetBrains IDE plugin
plugins                 the Claude Code and Codex plugins (marketplaces in .claude-plugin/ and .agents/plugins/)
containers/runner       the runner agent, sandbox server and the container image
packages/git-core       git objects, packfiles, deltas, diff and merge, in pure TypeScript
packages/workflow-yaml  the GitHub Actions workflow parser, expressions, matrices and cron
packages/shared         types shared by the Worker and the runner
scripts                 setup, bootstrap and deploy scripts for Cloudflare
```

## What Diffinery doesn't do (yet)

Diffinery is honest about its gaps. Today it has no hosted macOS, Windows or Arm runners (use self-hosted runners), no forks, no app marketplace, and nothing like Codespaces, Pages or Discussions. Some GitHub events, such as `issues` and `issue_comment`, are accepted in workflows but never start a run. The full list is in [Compatibility with GitHub Actions](https://diffinery.com/docs/actions/compatibility) and [Diffinery vs GitHub](https://diffinery.com/compare/github).

## FAQ

**What is Diffinery?**
An open-source git forge and CI platform that runs entirely on Cloudflare. It replaces GitHub's code hosting, pull requests and GitHub Actions in one app that you can self-host on your own Cloudflare account.

**Is Diffinery a self-hosted GitHub alternative?**
Yes. Like Gitea, Forgejo or GitLab, you can run it yourself, but instead of a server or a Kubernetes cluster it deploys to Cloudflare's serverless platform, and its CI runs GitHub Actions workflow files instead of a format of its own.

**Do my GitHub Actions workflows run without changes?**
Most do. Diffinery reads `.github/workflows/*.yml` with the same syntax and runs marketplace actions. Jobs that need hosted macOS, Windows or Arm runners need a self-hosted runner. See [Compatibility with GitHub Actions](https://diffinery.com/docs/actions/compatibility).

**What does it cost to run?**
Diffinery is free and open source under the Apache License 2.0. Running it costs whatever your own Cloudflare account bills: the Workers Paid plan plus usage. Hosted runners are Cloudflare Containers, which bill only while a job runs.

**Does it work with AI coding agents?**
Yes. Agents connect over MCP (`https://<your host>/mcp`), the REST API, git or the GitHub CLI. There are guides for Claude, Claude Code, Codex, Cursor and VS Code, and a plugin for Claude Code and Codex, installable with `claude plugin marketplace add https://diffinery.com/codician/diffinery.git` (sources in [`plugins/`](plugins)). See [Connect AI apps](https://diffinery.com/docs/connect).

**Can I move my repositories from GitHub?**
Yes. The importer brings a repository or a whole organization with history, issues, pull requests, reviews and releases. Secret names come over with a field to enter each value. See [Migrate from GitHub](https://diffinery.com/docs/migrate-from-github).

**Where is development happening?**
On Diffinery itself, at [diffinery.com/codician/diffinery](https://diffinery.com/codician/diffinery). Diffinery's own CI, deploys and pull requests run there. The GitHub repository is a mirror.

## Contributing, security and license

- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Security:** please don't open public issues for vulnerabilities. Report them privately as described in [SECURITY.md](SECURITY.md).
- **License:** [Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
