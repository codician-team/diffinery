---
title: Diffinery vs CircleCI
seo_title: "Diffinery vs CircleCI: CI service or forge with CI built in"
description: CircleCI runs CI for code on GitHub, GitLab or Bitbucket. Diffinery hosts the code and runs GitHub Actions workflows. Formats, runners, prices, trade-offs.
updated: 2026-10-25
---

CircleCI is a hosted CI/CD service: your code stays on GitHub, GitLab or Bitbucket, and CircleCI runs the pipelines you define in `.circleci/config.yml`. It also sells a self-hosted edition, CircleCI Server, and since September 2026 it has been previewing support for running GitHub Actions workflow files. Diffinery is a git forge with CI built in: it hosts your repositories, pull requests and issues, and runs GitHub Actions workflows as they are. It is free, open-source software (Apache-2.0) that you deploy to your own Cloudflare account, with no hosted service (see [Deploy your own Diffinery](/docs/self-hosting/deploy) and the [source code](https://github.com/codician-team/diffinery)). CircleCI facts here are from its own website and documentation, checked on October 25, 2026, and linked below.

## In short

- **The biggest difference is what each one replaces.** CircleCI replaces only your CI and works next to the Git host you already have. Diffinery replaces the Git host and the CI together.
- **Choose CircleCI** if you want to keep your code where it is, need hosted Arm, Windows, macOS or GPU machines, want machines larger than 4 vCPUs, want SOC 2 Type 2 and FedRAMP today, want a self-hosted edition on your own Kubernetes cluster, or want a service that CircleCI runs for you.
- **Choose Diffinery** if you want code hosting, review and CI in one product, workflows written as GitHub Actions YAML (supported as the main format, not in preview), and AI agents held to guardrails by the forge itself, and you're happy to run your own instance on Cloudflare.

## Side by side

| | Diffinery | CircleCI |
| --- | --- | --- |
| What it is | Git hosting, pull requests, issues, releases, a container registry and GitHub Actions–compatible CI in one platform | A CI/CD service that connects to your Git host, with a self-hosted edition ([source](https://circleci.com/pricing/server/)) |
| Who runs it | You: you deploy your instance to your own Cloudflare account and pay Cloudflare for its usage | CircleCI, or you with CircleCI Server |
| Where your code lives | Your Diffinery instance | GitHub.com, GitHub Enterprise Cloud and Server, GitLab (SaaS and self-managed), Bitbucket Cloud, or Cursor Origin (beta) ([source](https://circleci.com/docs/guides/integration/version-control-system-integration-overview/)) |
| Pipeline format | GitHub Actions YAML in `.github/workflows/` | `.circleci/config.yml` ([source](https://circleci.com/docs/reference/configuration-reference/)), with reusable configuration packages called orbs ([source](https://circleci.com/docs/orb-intro/)) |
| GitHub Actions workflow files | The main format; every difference is listed in [Compatibility](/docs/actions/compatibility) | In preview: GitHub repositories only, Linux only, and some keys are ignored, such as the `branches`, `paths` and `types` filters under `on:`, `schedule` and `concurrency` ([source](https://circleci.com/docs/guides/orchestrate/use-a-github-actions-workflow-file-as-your-pipeline-configuration/)) |
| Linux x64 machine sizes | 1/4, 1/2, 2 and 4 vCPU; 4 vCPU and 12 GiB by default, smaller sizes picked per job from its measured runs | Docker from Small (1 CPU, 2 GB) to X-large (8 CPU, 16 GB), and Linux VMs from Medium (2 CPU, 7.5 GB) ([source](https://circleci.com/pricing/price-list/)); 2X-large and larger classes on the Scale plan ([source](https://circleci.com/pricing/)) |
| Arm, Windows, macOS, GPU | Self-hosted runners only | Arm, Windows and macOS on every plan; GPU on the Scale plan ([source](https://circleci.com/pricing/)) |
| Linux x64 price | Free and open source (Apache-2.0); you pay Cloudflare for your instance's usage, with runner containers billed by the 10 ms while a job runs ([source](https://developers.cloudflare.com/containers/pricing/), checked October 25, 2026) | Credits at $0.0006 each, billed by the second ([source](https://circleci.com/docs/guides/plans-pricing/credits/)). A 2-CPU Docker Medium uses 10 credits a minute ([source](https://circleci.com/pricing/price-list/)), which works out to $0.006 a minute |
| Plans | None. Your Cloudflare account needs the Workers Paid plan, "a minimum cost of $5 USD per month per account", plus usage above the included amounts ([source](https://developers.cloudflare.com/workers/platform/pricing/), checked October 25, 2026) | Free: 30,000 credits a month and up to 5 active users. Performance: from $15 a month with 5 active users, $15 a month for each extra user. Scale: custom, billed annually ([source](https://circleci.com/pricing/)) |
| Self-hosted runners | `diffinery runner`, on any machine | On every plan: 5 concurrent tasks on Free, 20 on Performance, unlimited on Scale ([source](https://circleci.com/pricing/)) |
| Self-hosted edition | Diffinery is always self-deployed: open source (Apache-2.0), on your own Cloudflare account ([guide](/docs/self-hosting/deploy)). It doesn't run on your own servers or Kubernetes | CircleCI Server, on GKE, EKS or your own Kubernetes, for GitHub Enterprise Cloud and Server only ([source](https://circleci.com/pricing/server/)) |
| Compliance | None: Diffinery is open-source software you run, not a certified service | SOC 2 Type 2 and FedRAMP LI-SaaS, among others listed on its Trust Center ([source](https://trust.circleci.com/)) |
| MCP server | Built in at `/mcp` on your instance: read code, commit, open, review and merge pull requests, follow CI and run commands in sandboxes | Hosted at `https://mcp.circleci.com/v1/mcp`: inspect runs, jobs, logs, artifacts and test results, and rerun or cancel workflows ([source](https://circleci.com/docs/guides/toolkit/circleci-mcp-overview/)) |
| AI agents | Agent accounts with server-enforced guardrails, sandboxes, agent tasks and agent review | Agents on your Git host work as they do there |
| Pull requests, issues, code review | Built in | Your Git host's |

## Where each one is the better fit

**CircleCI is the better fit when** you want to keep GitHub, GitLab or Bitbucket and change only your CI, when you build for macOS, Windows, Arm or GPUs on hosted machines, when your builds need more than 4 vCPUs, when you need SOC 2 Type 2 or FedRAMP paperwork today, when you need to run CI inside your own network with CircleCI Server, or when you'd rather not run any infrastructure yourself.

**Diffinery is the better fit when** you'd rather have one platform than a Git host plus a CI service and are happy to run it on your own Cloudflare account, your CI is Linux, you want to write workflows in the GitHub Actions format and use actions from GitHub as they are, and you work with AI coding agents and want the forge to limit what they can do.

## Moving from CircleCI

Deploy your own instance first ([guide](/docs/self-hosting/deploy)). Diffinery's importer reads from GitHub. If your code is on GitHub, it brings over each repository with its history, issues, pull requests, reviews and releases; see [Migrate from GitHub](/docs/migrate-from-github). From GitLab or Bitbucket, push branches and tags with plain Git; see [Move with plain Git](/docs/migrate-from-github#move-with-plain-git). Then rewrite each `.circleci/config.yml` as workflows in `.github/workflows/`, and check them with `diffinery workflow validate`.

## Frequently asked questions

### Is Diffinery a CircleCI alternative?

Yes, if you're willing to move your repositories as well. Diffinery's CI runs on its own repositories, so it replaces CircleCI and your Git host together. If you want to keep your current Git host and only change CI, CircleCI or a GitHub Actions runner service is the closer fit; see [GitHub Actions alternatives, compared](/compare).

### Can I run my CircleCI config on Diffinery?

No. Diffinery runs GitHub Actions workflows, not `.circleci/config.yml`, and CircleCI orbs don't run on it. Teams moving from CircleCI rewrite their pipelines as workflows, usually replacing each orb with a GitHub action that does the same job.

### Can CircleCI run GitHub Actions workflows?

In preview. CircleCI announced on September 22, 2026 that it can run existing GitHub Actions workflow files on its own machines ([source](https://circleci.com/blog/github-actions-alternative-run-actions-on-circleci/)). Its documentation says the preview works with GitHub repositories, runs Linux jobs only, doesn't apply the filters under `on:` or `schedule`, and gives `concurrency` no effect ([source](https://circleci.com/docs/guides/orchestrate/use-a-github-actions-workflow-file-as-your-pipeline-configuration/)). On Diffinery, GitHub Actions is the native format.

### Can I use CircleCI with Diffinery?

Not today. CircleCI connects to GitHub, GitLab, Bitbucket Cloud and Cursor Origin, and Diffinery isn't one of them. On Diffinery, jobs run on your instance's hosted runners in Cloudflare Containers or on your own machines with `diffinery runner`.

### Is Diffinery cheaper than CircleCI?

Diffinery itself is free and open source; you pay Cloudflare for what your instance uses, which depends on your usage, so we don't quote a per-minute figure to compare. CircleCI's Free plan includes 30,000 credits a month, and a 2-CPU Docker job uses 10 credits a minute, so about 3,000 minutes of that size. Paid credits cost $0.0006 each, and CircleCI runs the machines for you. Diffinery's default runner has 4 vCPUs and 12 GiB of memory, against 2 CPUs and 4 GB on CircleCI's Docker Medium.

### Which is faster, Diffinery or CircleCI?

We haven't benchmarked CircleCI and don't quote others' numbers as our own. Diffinery's measured stage times are on the [Performance](/performance) page. CircleCI says sampled builds in its GitHub Actions preview ran "40% faster" than on GitHub Actions (CircleCI's own claim, [source](https://circleci.com/blog/github-actions-alternative-run-actions-on-circleci/)).
