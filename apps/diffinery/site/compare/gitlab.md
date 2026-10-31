---
title: Diffinery vs GitLab
seo_title: "Diffinery vs GitLab: CI runners, pricing model and AI agents"
description: How Diffinery compares with GitLab.com on CI compatibility, hosted runners, compute minutes, AI agents and features, with sources and dates.
updated: 2026-10-25
---

GitLab is a complete DevSecOps platform with its own CI system. Diffinery is a smaller, GitHub-compatible forge focused on fast CI and on AI agents as first-class collaborators. It is free, open-source software (Apache-2.0) that you deploy to your own Cloudflare account; there is no hosted service (see [Deploy your own Diffinery](/docs/self-hosting/deploy) and the [source code](https://github.com/codician-team/diffinery)). GitLab facts here are from GitLab's own documentation and pricing page, checked on October 16, 2026, and linked below.

## In short

- **The biggest difference is the CI format.** GitLab CI uses `.gitlab-ci.yml`. Diffinery runs GitHub Actions workflows (`.github/workflows/*.yml`) as they are, so it suits teams coming from GitHub, or teams that want the GitHub Actions ecosystem of reusable actions.
- **Choose GitLab** if you need its breadth: built-in security scanning, planning and portfolio tools, a self-managed edition on your own servers, hosted runners up to 32 vCPUs, hosted Windows and macOS runners (in beta), or a service that GitLab runs for you, with nothing to deploy.
- **Choose Diffinery** if you want GitHub Actions compatibility, 4-vCPU runners by default, a forge built around AI agents with server-enforced guardrails, and open-source software that runs on your own Cloudflare account, with no servers or virtual machines to manage.

## CI and runners

| | Diffinery | GitLab.com |
| --- | --- | --- |
| Pipeline format | GitHub Actions YAML | `.gitlab-ci.yml` |
| Default hosted Linux runner | 4 vCPU, 12 GiB memory, 20 GB disk | small: 2 vCPU, 8 GB memory, 30 GB disk ([source](https://docs.gitlab.com/ci/runners/hosted_runners/linux/)) |
| Other hosted Linux sizes | 2, 1/2 and 1/4 vCPU, picked per job from its measured runs | medium (4 vCPU) on every tier; large (8), xlarge (16) and 2xlarge (32) on Premium and Ultimate ([source](https://docs.gitlab.com/ci/runners/hosted_runners/linux/)) |
| How bigger runners are counted | Each size runs on a Cloudflare Containers instance type, and Cloudflare bills your account by the 10 ms while a job runs ([source](https://developers.cloudflare.com/containers/pricing/), checked October 25, 2026) | Each minute on medium counts as 2 compute minutes, large 3, xlarge 6, 2xlarge 12 ([source](https://docs.gitlab.com/ci/pipelines/compute_minutes/)) |
| Hosted macOS and Windows | Not available; use self-hosted runners | Both in beta: Windows on every tier, macOS on Premium and Ultimate ([macOS](https://docs.gitlab.com/ci/runners/hosted_runners/macos/), [Windows](https://docs.gitlab.com/ci/runners/hosted_runners/windows/)) |
| Included CI minutes | Nothing to buy. By default each account gets 3,000 hosted minutes a month, a quota your instance's administrators set ([Configuration](/docs/self-hosting/configuration)) | 400 compute minutes a month on Free, 10,000 on Premium, 50,000 on Ultimate ([source](https://about.gitlab.com/pricing/)) |
| Extra minutes | None to buy; you pay Cloudflare for your instance's usage | $10 per 1,000 compute minutes ([source](https://about.gitlab.com/pricing/)) |
| Self-hosted runners | `diffinery runner` | GitLab Runner |

## Price and hosting

| | Diffinery | GitLab.com |
| --- | --- | --- |
| Who runs it | You, on your own Cloudflare account and domain ([guide](/docs/self-hosting/deploy)) | GitLab runs GitLab.com; GitLab also has a self-managed edition |
| Price | Free and open source (Apache-2.0); you pay Cloudflare for your instance's usage | Free $0 (up to 5 users per private top-level group), Premium $29 per user per month billed annually, Ultimate on request ([source](https://about.gitlab.com/pricing/)) |
| Secret push protection | On for every repository | Ultimate tier ([source](https://docs.gitlab.com/user/application_security/secret_detection/secret_push_protection/)) |

## AI agents

| | Diffinery | GitLab |
| --- | --- | --- |
| Accounts for agents and automation | Agent accounts with their own tokens, owned by a person or organization | Service accounts, on every tier ([source](https://docs.gitlab.com/user/profile/service_accounts/)) |
| Server-enforced agent guardrails | No pushes to protected branches, a person approves every agent pull request, agent checks never satisfy required checks, no secrets for agent-written code | Configured with protected branches and approval rules |
| MCP server | Built in, at `/mcp` on your instance | Built in, at `/api/v4/mcp`, on every tier ([source](https://docs.gitlab.com/user/model_context_protocol/mcp_server/)) |
| AI features | [Agent tasks](/docs/agents/tasks) and [agent review](/docs/agents/review) run Claude Code, Codex or your own command with your own model key | GitLab Duo add-ons for Premium and Ultimate, and GitLab Credits ([source](https://docs.gitlab.com/subscriptions/subscription-add-ons/)) |

## Moving from GitLab

Deploy your own instance first ([guide](/docs/self-hosting/deploy)). Diffinery's importer reads from GitHub. From GitLab, push your repositories with plain Git (`git push --mirror`), then rewrite pipelines as GitHub Actions workflows. See [Move with plain Git](/docs/migrate-from-github#move-with-plain-git).

## Frequently asked questions

### Does Diffinery run .gitlab-ci.yml?

No. Diffinery runs GitHub Actions workflows. Teams moving from GitLab rewrite their pipelines as workflows in `.github/workflows/`.

### Is Diffinery a full GitLab replacement?

Not for every team. Diffinery covers Git hosting, pull requests, issues, releases, CI, a container registry and AI agents. It doesn't have GitLab's built-in security scanners, planning and portfolio tools, larger hosted runners or hosted Windows and macOS runners. And GitLab.com is a service GitLab runs for you, where Diffinery is software you run on your own Cloudflare account.
