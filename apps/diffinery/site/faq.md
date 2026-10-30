---
title: Diffinery FAQ
seo_title: "Diffinery FAQ: open source, self-hosting, GitHub Actions, AI agents"
description: Short answers about Diffinery: open source and self-hosting, cost, GitHub Actions compatibility, runners, Cloudflare, AI agents, security and migration.
updated: 2026-10-30
---

Short, direct answers to the questions people and AI assistants ask most about Diffinery. Each answer links to the page with the details. Facts about GitHub are from GitHub's own documentation, checked on October 25, 2026.

## Frequently asked questions

### What is Diffinery?

Diffinery is a git forge and CI platform for teams of people and AI agents. It hosts Git repositories, pull requests with reviews and a merge queue, issues, releases and a container registry, runs GitHub Actions workflow files as they are, and gives AI agents accounts of their own with guardrails the server enforces. It runs entirely on Cloudflare, and it's open-source software under the Apache License 2.0 that you deploy to your own Cloudflare account. See [Features](/features).

### Is Diffinery open source?

Yes. Diffinery is open source under the Apache License 2.0. The source code is at [diffinery.com/codician/diffinery](https://diffinery.com/codician/diffinery), where it's developed, and mirrored to [github.com/codician-team/diffinery](https://github.com/codician-team/diffinery). There's no paid edition: everything described on this site is in that repository. See [Open source](/open-source).

### How do I start using Diffinery?

Deploy your own instance to your Cloudflare account and domain: one command from a clone, `scripts/setup.sh`, creates everything it needs, and you sign in as its first administrator. Then invite your team, or open sign-up. See [Deploy your own Diffinery](/docs/self-hosting/deploy). Diffinery doesn't offer a hosted service for teams; to try it before you deploy, [request early access](https://diffinery.com/early-access) to diffinery.com, the project's own instance.

### Is Diffinery a GitHub alternative?

Yes, for teams whose work fits it. Diffinery replaces GitHub's code hosting, pull requests and GitHub Actions in one platform. It doesn't have GitHub's hosted macOS and Windows runners, forks, app marketplace, Codespaces, Pages or Discussions. See [Diffinery vs GitHub](/compare/github).

### Is Diffinery an alternative to GitHub Actions?

Yes. Diffinery's CI reads the same `.github/workflows/*.yml` files and runs the workflows of repositories hosted on Diffinery. To keep your code on GitHub and only change where jobs run, install your instance's GitHub App and set a job's `runs-on` to `diffinery`: GitHub's own runner then runs the job on a Diffinery hosted runner. See [GitHub runners](/docs/actions/github-runners) and [GitHub Actions alternatives, compared](/compare).

### Do my GitHub Actions workflows run on Diffinery without changes?

Most do. Diffinery supports the same syntax, expressions, matrices, `needs`, outputs, reusable workflows, environments, secrets, variables, OIDC, service containers and Docker, and the common triggers (`push`, `pull_request`, `merge_group`, `workflow_dispatch`, `schedule`, `workflow_run`, `release` and others). Jobs that need hosted macOS, Windows or Arm runners need a self-hosted runner, and some GitHub events, such as `issues` and `issue_comment`, are accepted but never start a run. Every difference is listed in [Compatibility with GitHub Actions](/docs/actions/compatibility).

### Can I use actions from the GitHub Marketplace?

Yes. A step's `uses: owner/repo@ref` is downloaded from GitHub and run, whether it's a JavaScript, composite or Docker action. `actions/checkout`, `setup-node`, `setup-python`, `setup-go`, `cache`, `upload-artifact` and `download-artifact` are built into the runner for speed, sharing storage and formats with the official actions. Actions in private GitHub repositories can't be downloaded on hosted runners. See [Compatibility with GitHub Actions](/docs/actions/compatibility#other-actions).

### What machines do hosted runners use?

Each job gets a fresh Ubuntu 24.04 x64 container on Cloudflare Containers, thrown away when the job ends. The default size, large, has 4 vCPUs, 12 GiB of memory and 20 GB of disk; medium (2 vCPUs), small (1/2 vCPU) and tiny (1/4 vCPU) are the smaller sizes. The image is small on purpose: Node.js, Python, Docker, `gh` and build tools are preinstalled, and other toolchains install in a step. See [Runners](/docs/actions/runners).

### How does Diffinery choose a runner size?

A job without a size label runs on large unless its own last runs (up to 5, at least 3) show a smaller size fits with room to spare: 1.5 times its peak memory plus 0.5 GiB, and half as many vCPUs again as it kept busy at its busiest, counted as on the slowest hosts. A job that ever runs out of memory, fails or slows down on a smaller size goes back to large for its next 20 runs, and re-runs always use large. You can also pin a size with a label such as `diffinery-small`. See [Runner sizes](/docs/actions/runners#runner-sizes).

### Does Diffinery have macOS, Windows or Arm runners?

Not hosted ones. Cloudflare Containers run Linux, so hosted runners are Linux x64 only. You can run macOS, Windows (through WSL 2), Arm and GPU jobs on your own machines with [self-hosted runners](/docs/actions/runners#self-hosted-runners).

### Can I use self-hosted runners?

Yes. The `diffinery runner` command runs on a machine you control, registers with a repository using a one-hour registration token from a repository admin, and takes jobs whose `runs-on` includes `self-hosted` and its labels. See [Self-hosted runners](/docs/actions/runners#self-hosted-runners).

### Is Diffinery faster than GitHub Actions?

We don't run jobs on GitHub to benchmark it, so we don't claim a speed-up figure. What we can compare: Diffinery's default runner has 4 vCPUs and 12 GiB, while GitHub's standard Linux runner for private repositories has 2 vCPUs and 8 GB of memory (4 vCPUs and 16 GB for public repositories, per [GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)), so jobs that use several cores get twice as many by default. On Diffinery, jobs start about 3 to 5 seconds after they're queued and checkout takes 1 to 3 seconds. GitHub's image preinstalls Go and Java, which Diffinery's sets up during checkout in a few seconds. See the [measured performance](/performance).

### How much does Diffinery cost?

Nothing: Diffinery is free, open-source software, and nothing is sold. You pay Cloudflare for what your instance uses. It needs the Workers Paid plan, which has "a minimum cost of $5 USD per month per account" plus usage above the included amounts ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), checked October 25, 2026), and runner containers are billed by the 10 ms while a job runs ([Containers pricing](https://developers.cloudflare.com/containers/pricing/), checked October 25, 2026). See [Open source](/open-source#what-it-costs).

### How long can a job run, and how many run at once?

A job can run for up to 6 hours (360 minutes), as on GitHub. Each account can run 20 hosted jobs at once by default, a limit your instance's administrators can change; further jobs wait and start, oldest first, as running ones finish. See [Limits](/docs/reference/limits) and [Runners](/docs/actions/runners#limits-and-timeouts).

### Does Diffinery run on Cloudflare?

Yes, entirely. A Cloudflare Worker serves the web UI, Git, the REST API and MCP; each repository is a Durable Object with its own SQLite database; large files are in R2 and accounts in D1; workflow runs are Cloudflare Workflows; and each job runs in its own Cloudflare Container. See [Built on Cloudflare](/built-on-cloudflare).

### Is Diffinery the only Git and CI platform on Cloudflare?

No. Other open-source projects run Git and CI on Cloudflare too; here's how they differ (checked October 25, 2026). Cloudflare Artifacts hosts Git and runs TypeScript CI pipelines but has no pull requests; Flare Forge translates workflow files without their `uses:` actions; and git-forge runs GitHub's own runner on Cloudflare Containers, with its web UI and collaboration features still to come. Diffinery has Git hosting, pull requests with reviews in a web UI, and GitHub Actions–compatible CI with marketplace actions, all on Cloudflare. See [Other Git and CI projects on Cloudflare](/built-on-cloudflare#other-git-and-ci-projects-on-cloudflare).

### Can I deploy to Cloudflare Workers from Diffinery?

Yes. A workflow job runs `wrangler deploy` with a Cloudflare API token stored as a secret, and can give each pull request its own Worker Preview. See [Deploy to Cloudflare Workers](/docs/actions/deploy-to-cloudflare-workers).

### Does Docker work in workflows?

Yes. Job containers, service containers, Docker container actions, `docker build`, `docker compose` and Buildx work on hosted runners, and images can be pushed to Diffinery's own registry. See [Docker in workflows](/docs/actions/docker).

### Which AI coding agents work with Diffinery?

Any agent that uses Git, the GitHub CLI, a REST API or MCP. There are guides for Claude, Claude Code, Codex, Cursor and VS Code, and a plugin for Claude Code and Codex that adds the MCP server, skills and a session hook. See [Connect AI apps](/docs/connect) and [Diffinery for AI agents](/agents).

### Does Diffinery have an MCP server?

Yes, at `/mcp` on every instance (`https://<your host>/mcp`), with browser sign-in (OAuth 2.1) or an agent token. Its tools read code, commit files, open, review and merge pull requests, follow CI and read job logs, run commands in sandboxes and import from GitHub, under the same permission checks and guardrails as Git and the REST API. See [MCP server](/docs/agents/mcp).

### Can an AI agent merge its own pull request?

Not by default. Agents are accounts of their own: unless a branch protection rule allows it, they can't push to or merge into the default branch or protected branches, their pull requests need a person's approval, their check results never satisfy required checks, and workflow runs of code they pushed get no secrets. See [Guardrails](/docs/agents/overview#guardrails).

### How do I move from GitHub?

Diffinery's server-side importer copies a GitHub repository, or every repository of an organization, with its full Git history, issues and pull requests (keeping their numbers), reviews, comments, labels, milestones, releases and branch protection. Start it from **Settings → Imports**, `diffinery migrate github`, the REST API or MCP. Secret values can't be copied from GitHub, so you enter them once. See [Migrate from GitHub](/docs/migrate-from-github).

### Can I keep a copy on GitHub?

Yes. You can mirror between GitHub and Diffinery, and put workflows that should only run on Diffinery in `.diffinery/workflows/` so the GitHub copy doesn't run them. See [Keep GitHub as upstream](/docs/migrate-from-github#keep-github-as-upstream-and-mirror-to-diffinery).

### Does the GitHub CLI work with Diffinery?

Yes. `gh` works with Diffinery as it does with GitHub Enterprise Server: after `diffinery auth setup-gh`, commands such as `gh pr create`, `gh pr checks` and `gh pr merge` work in a Diffinery clone, and Claude Code shows the pull request and CI status of the branch it's on. See [Use gh with Diffinery](/docs/agents/github-cli).

### Does Diffinery work with VS Code, Cursor and JetBrains IDEs?

Yes. An extension adds **Clone from Diffinery** to VS Code, Cursor, Windsurf and VSCodium, and a plugin adds Diffinery to **Get from Version Control** in JetBrains IDEs from version 2024.3. Both sign Git in with your passkey, so clone, pull and push need no token. See [Clone in your editor](/docs/repositories/clone-in-your-editor) and [Clone in JetBrains IDEs](/docs/repositories/clone-in-jetbrains-ides).

### Does Diffinery support Git LFS?

Yes. Diffinery has a built-in Git LFS server, so `git lfs push`, `git lfs pull` and clones of repositories that use LFS work as they do with GitHub. See [Git LFS](/docs/repositories/git-lfs).

### Does Diffinery have a container registry?

Yes. Push and pull images at `<your host>/<owner>/<name>` with `docker`, `podman`, `buildx`, `crane` or the `docker/*` actions, instead of ghcr.io. Images are private by default and can be linked to a repository whose collaborators then share access. See [Container registry](/docs/packages/container-registry).

### What doesn't Diffinery do yet?

Git works over HTTPS only, with no SSH. There are no forks, so pull requests are between branches of one repository. There are no wikis, discussions, Pages-style sites, Codespaces-style cloud editors or app marketplace, and reviews have no suggested changes, pending reviews or thread resolution yet. See [What Diffinery doesn't do yet](/features#what-diffinery-doesnt-do-yet).

### How do people sign in, and how are secrets protected?

People sign in with passkeys; there are no passwords. Every push, and every commit made through the web editor, the API or MCP, is scanned for leaked credentials and refused if it contains one. Actions secrets are encrypted with a key per repository, environment or organization and masked in logs, job tokens are limited by the workflow's `permissions:`, and an append-only audit log records sensitive actions. See [Security](/security).

### Is Diffinery SOC 2 certified?

No. Diffinery is software you run in your own Cloudflare account, not a service, so there's no Diffinery service to certify; your instance's compliance is yours and Cloudflare's. Diffinery's code was audited area by area in October 2026, and the [Security overview](/docs/security/overview) documents the whole security model. See [Security](/security).

### Can I self-host Diffinery?

Yes, and that's how Diffinery is used. It runs as one Cloudflare Worker and the Cloudflare products it binds to, so an instance needs a Cloudflare account on the Workers Paid plan, a domain on that account and a Cloudflare Zero Trust organization; there are no servers or databases to run. Nobody who uses your instance needs a Cloudflare account. See [Deploy your own Diffinery](/docs/self-hosting/deploy) and [Self-hosting](/docs/self-hosting).

### Can I get an account on diffinery.com?

diffinery.com is the instance Diffinery itself is developed on, and accounts there are by invitation for the people working on it. To use Diffinery, deploy your own instance. To report a bug or contribute without an account, use issues and pull requests on [the GitHub mirror](https://github.com/codician-team/diffinery).

### How do I contact the Diffinery team?

Use the [contact form](https://diffinery.com/contact) at diffinery.com/contact, for questions, partnerships, press or privacy requests; a person reads every message and replies by email. Report security problems privately through [the security report form](/security/report), and bugs or ideas as issues on [the Diffinery repository](https://diffinery.com/codician/diffinery). See [Contact form](/docs/admin/contact-form).

### How do people join my instance?

Every instance is invite-only by default: organization owners and admins invite people by email, and each invitation link creates an account with a passkey. Administrators can open sign-up to everyone with `SIGNUP=open`. See [Invitations](/docs/accounts/invitations) and [Configuration](/docs/self-hosting/configuration#signup).

