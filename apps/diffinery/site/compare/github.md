---
title: Diffinery vs GitHub
seo_title: "Diffinery vs GitHub and GitHub Actions: an honest comparison"
description: How Diffinery compares with GitHub and GitHub Actions on CI speed, runners, workflow compatibility, AI agents, security and features, with sources and dates.
updated: 2026-10-25
---

Diffinery is a git forge and CI platform that runs GitHub Actions workflows as they are. If you're on GitHub today, this page sets out what changes if you move, what gets better, and what GitHub still does that Diffinery doesn't. GitHub facts are from GitHub's own documentation and pricing pages, checked on October 16, 2026, and linked below. Diffinery's speed figures are measured; see [Performance](/performance). Diffinery is free, open-source software (Apache-2.0) that you deploy to your own Cloudflare account and domain; there is no hosted service, so moving from GitHub also means running your own instance. See [Deploy your own Diffinery](/docs/self-hosting/deploy) and the [source code](https://diffinery.com/codician/diffinery), mirrored [on GitHub](https://github.com/codician-team/diffinery). Diffinery is an open-source platform where Git hosting, pull requests with reviews in a web UI and GitHub Actions–compatible CI, marketplace actions included, all run on Cloudflare (checked October 25, 2026; see [Built on Cloudflare](/built-on-cloudflare#other-git-and-ci-projects-on-cloudflare)).

## In short

- **Choose Diffinery** if your team runs CI on private repositories and wants faster runners by default, uses AI coding agents and wants the server to enforce limits on them, works on Linux, and is happy to run its own instance on Cloudflare.
- **Stay on GitHub** if you need hosted macOS, Windows or Arm runners, forks for outside contributors, GitHub's app marketplace, Codespaces, Pages or Discussions, if you're an open-source project that depends on GitHub's network, or if you'd rather not run anything yourself: GitHub runs github.com for you, while a Diffinery instance is yours to deploy, update and pay Cloudflare for.
- **Moving is mostly mechanical.** Diffinery's importer copies repositories with history, issues, pull requests, reviews and releases, workflow files run unchanged, and `gh`, VS Code, Cursor and JetBrains IDEs keep working.

## CI and runners

| | Diffinery | GitHub Actions |
| --- | --- | --- |
| Workflow syntax | GitHub Actions YAML, read from `.github/workflows/` as is. Differences are listed in [Compatibility](/docs/actions/compatibility). | GitHub Actions YAML |
| Default Linux runner, private repositories | 4 vCPU, 12 GiB memory, 20 GB disk | 2 vCPU, 8 GB memory, 14 GB SSD ([source](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)) |
| Default Linux runner, public repositories | 4 vCPU, 12 GiB memory, 20 GB disk | 4 vCPU, 16 GB memory, 14 GB SSD ([source](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)) |
| Smaller runners | 2, 1/2 and 1/4 vCPU, picked per job from its measured runs, or by label | 1 vCPU `ubuntu-slim`, with a 15-minute job limit ([source](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)) |
| Larger runners | Not available above 4 vCPU | Linux up to 96 vCPU, on the Team and Enterprise Cloud plans, billed per minute ([source](https://docs.github.com/en/actions/reference/runners/larger-runners)) |
| Hosted macOS, Windows, Arm, GPU | Not available; use self-hosted runners | Available |
| Job start | About 3 to 5 s (measured) | No published figure |
| Common actions | `checkout`, `setup-node`, `setup-python`, `setup-go`, `cache` and artifact actions built into the runner | Downloaded and run per job |
| Preinstalled toolchains | A small image: Node.js, Python, Docker, gh, build tools. Go and Java install while checkout runs (1 to 5 s). | A large image with most toolchains preinstalled |
| Self-hosted runners | `diffinery runner`, on any machine | GitHub's runner application |
| Max job time | 6 hours | 6 hours ([source](https://docs.github.com/en/actions/reference/limits)) |
| Concurrent hosted jobs | 20 per account by default; your instance's administrators set it ([Configuration](/docs/self-hosting/configuration)) | 20 on Free, 40 on Pro, 60 on Team, 500 on Enterprise ([source](https://docs.github.com/en/actions/reference/limits)) |
| Linux runner price | Free and open source (Apache-2.0); you pay Cloudflare for your instance's usage, with runner containers billed by the 10 ms while a job runs ([source](https://developers.cloudflare.com/containers/pricing/), checked October 25, 2026) | $0.006 per minute for 2-core, $0.012 for 4-core, each job rounded up to the whole minute ([source](https://docs.github.com/en/billing/reference/actions-runner-pricing)) |

GitHub cut its hosted runner prices by up to 39% on January 1, 2026 ([changelog](https://github.blog/changelog/2026-01-01-reduced-pricing-for-github-hosted-runners-usage/)); the figures above are the current ones.

## Code hosting and collaboration

| | Diffinery | GitHub |
| --- | --- | --- |
| Who runs it | You, on your own Cloudflare account and domain ([guide](/docs/self-hosting/deploy)) | GitHub runs github.com; GitHub Enterprise Server runs on your own servers |
| Git over HTTPS | Yes | Yes |
| Git over SSH | No | Yes |
| Git LFS | Yes | Yes |
| Pull requests, reviews, required approvals and checks | Yes, plus an `intent` field saying what a change is for | Yes |
| Suggested changes, pending reviews, resolving threads | Not yet | Yes |
| Forks | No: pull requests are between branches of one repository | Yes |
| Auto-merge and merge queue | Yes, with GitHub's `merge_group` event | Yes |
| Issues, labels, milestones, releases | Yes | Yes |
| Projects, Discussions, wikis, Pages, Codespaces | No | Yes |
| Container registry | Yes, at `<your instance's domain>/<owner>/<name>` | Yes, ghcr.io |
| REST API | GitHub-style at `/api/v3`, with a GraphQL endpoint for `gh` | Yes |
| `gh` CLI | Works, as with GitHub Enterprise Server | Yes |
| App marketplace and GitHub Apps | No | Yes |

## AI agents

| | Diffinery | GitHub |
| --- | --- | --- |
| Agent identity | An agent account of its own, owned by a person or organization, with its own tokens | Usually a person's token, a GitHub App or a bot account |
| Guardrails enforced by the server | Agents can't push to protected branches, their pull requests need a person's approval, their checks never satisfy required checks, and runs of their code get no secrets | Configured per repository with rulesets and permissions |
| MCP server | At `/mcp` on your instance, with browser sign-in | The GitHub MCP Server, generally available since September 2025 ([source](https://github.blog/changelog/2025-09-04-remote-github-mcp-server-is-now-generally-available/)) |
| Agent that turns an issue or goal into a pull request | [Agent tasks](/docs/agents/tasks) run Claude Code, Codex or your own command with your own model key | Copilot cloud agent, on paid Copilot plans ([source](https://docs.github.com/en/copilot/concepts/enterprise/cloud-agent-access)) |
| AI pull request review | [Agent review](/docs/agents/review) with your own model key | Copilot code review, on paid Copilot plans ([source](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review)) |
| Sandboxes for agents | Yes, over MCP and the REST API | Codespaces, and the Copilot agent's own environment |

## Security

| | Diffinery | GitHub |
| --- | --- | --- |
| Sign-in | Passkeys only | A password with two-factor authentication (required for everyone who contributes code since 2023), or a passkey ([source](https://docs.github.com/en/authentication/authenticating-with-a-passkey/about-passkeys)) |
| Push protection for leaked credentials | On for every repository, private ones included, for every push and every commit made through the API or MCP | On by default for pushes to public repositories; for private repositories it needs GitHub Secret Protection, a paid add-on ([source](https://docs.github.com/en/code-security/concepts/secret-security/push-protection)) |
| Secrets for workflow runs of agent-written code | Never given | Depends on your configuration |
| Audit log | Yes, append-only, for every account | Organization owners can review it; the audit log API and streaming need Enterprise Cloud ([source](https://docs.github.com/en/enterprise-cloud@latest/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/reviewing-the-audit-log-for-your-organization)) |

## Moving from GitHub

First, deploy your own instance to your Cloudflare account; see [Deploy your own Diffinery](/docs/self-hosting/deploy). Then:

1. Import a repository or a whole organization from **Settings → Imports**, or with `diffinery migrate github`. History, issues, pull requests, reviews, comments, labels, milestones, releases, branch protection, variables and secret names come across, with their numbers.
2. Enter each secret's value (GitHub never reveals them, so no tool can copy them).
3. Point your clones at Diffinery and sign `gh` in with `diffinery auth setup-gh`.
4. Push. Your workflows run on your instance's runners.

See [Migrate from GitHub](/docs/migrate-from-github) for the full guide.

## Frequently asked questions

### Do GitHub Actions workflows run on Diffinery without changes?

Most do. Diffinery reads `.github/workflows/*.yml` with the same triggers, expressions, matrices, reusable workflows, secrets, OIDC and Docker support, and runs JavaScript, composite and Docker actions from GitHub. Jobs that need hosted macOS, Windows or Arm runners need a self-hosted runner instead. Every difference is listed in [Compatibility with GitHub Actions](/docs/actions/compatibility).

### Is Diffinery faster than GitHub Actions?

For CPU-heavy jobs on private repositories, usually yes: Diffinery's default runner has 4 vCPUs where GitHub's standard private-repository runner has 2, and jobs start in about 3 to 5 seconds. Setup steps such as checkout and cache restores are at or near parity. GitHub is still up to about 4 seconds faster at setting up Go and Java, which it preinstalls. See [Performance](/performance) for the measurements.

### Can I keep using the GitHub CLI and my editor?

Yes. `gh` works with Diffinery as it does with GitHub Enterprise Server, VS Code, Cursor and Windsurf can clone from Diffinery, and JetBrains IDEs get a plugin.

### Can I keep a copy on GitHub?

Yes. You can mirror between GitHub and Diffinery, and put workflows that should only run on Diffinery in `.diffinery/workflows/`. See [Keep GitHub as upstream](/docs/migrate-from-github#keep-github-as-upstream-and-mirror-to-diffinery).

### How much does Diffinery cost?

Diffinery itself is free and open source under the Apache-2.0 license; there are no plans or paid tiers. You deploy it to your own Cloudflare account and pay Cloudflare for what your instance uses: the Workers Paid plan, "a minimum cost of $5 USD per month per account", plus usage above the included amounts ([source](https://developers.cloudflare.com/workers/platform/pricing/), checked October 25, 2026), and runner containers billed by the 10 ms while a job runs ([source](https://developers.cloudflare.com/containers/pricing/), checked October 25, 2026). See [Deploy your own Diffinery](/docs/self-hosting/deploy).
