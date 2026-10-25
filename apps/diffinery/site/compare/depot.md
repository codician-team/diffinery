---
title: Diffinery vs Depot
seo_title: "Diffinery vs Depot: CI runners, Depot CI and Git hosting"
description: Depot sells fast GitHub Actions runners, its own Depot CI engine and container builds. How it compares with Diffinery, with specs, prices and trade-offs.
updated: 2026-10-25
---

Depot started with fast container builds and now sells drop-in runners for GitHub Actions, its own CI engine that runs GitHub Actions YAML (Depot CI), and Git hosting in beta (Depot Code). Diffinery is a git forge with pull requests, issues, GitHub Actions–compatible CI and AI agents in one platform. Depot is a service that runs everything for you; Diffinery is free, open-source software (Apache-2.0) that you deploy to your own Cloudflare account, with no hosted service (see [Deploy your own Diffinery](/docs/self-hosting/deploy) and the [source code](https://diffinery.com/codician/diffinery)). Depot facts here are from its own website and documentation, checked on October 16, 2026, and linked below.

## In short

- **Choose Depot** if you want faster CI and container builds while staying on GitHub, need large, Arm, Windows or macOS runners, want SOC 2 Type 2 today, or want a service that runs the machines for you.
- **Choose Diffinery** if you want code hosting, pull request review and CI in one product, and AI agents held to guardrails by the forge itself, and you're happy to run your own instance on Cloudflare.

## Side by side

| | Diffinery | Depot |
| --- | --- | --- |
| Who runs it | You: you deploy your instance to your own Cloudflare account and pay Cloudflare for its usage | Depot |
| What it is | Git hosting, pull requests, issues, releases, a container registry and GitHub Actions–compatible CI | GitHub Actions runners, Depot CI (generally available since March 2026), container builds, a registry, and Depot Code (beta) ([runners](https://depot.dev/docs/github-actions/overview), [Depot CI](https://depot.dev/changelog/2026-03-24-depot-ci-now-available)) |
| Git hosting and pull requests | Yes, with reviews, required checks, auto-merge and a merge queue | Depot Code, in beta: repositories or GitHub mirrors that trigger CI on push; Depot says a code review UI is in progress ([source](https://depot.dev/docs/code/overview)) |
| Runners for GitHub-hosted repositories | No (Diffinery runs its own repositories' workflows) | Yes, for repositories owned by GitHub organizations, with a `runs-on: depot-ubuntu-24.04` label ([source](https://depot.dev/docs/github-actions/overview)) |
| Linux x64 runner sizes | 1/4, 1/2, 2 and 4 vCPU; 4 vCPU and 12 GiB by default | 2 to 64 vCPU, 8 to 256 GB, on AMD EPYC Genoa ([source](https://depot.dev/docs/github-actions/runner-types)) |
| Arm, Windows, macOS | Self-hosted runners only | Arm (Graviton4) and Windows; macOS on the Startup and Business plans ([source](https://depot.dev/docs/github-actions/runner-types)) |
| Linux x64 price | Free and open source (Apache-2.0); you pay Cloudflare for your instance's usage, with runner containers billed by the 10 ms while a job runs ([source](https://developers.cloudflare.com/containers/pricing/), checked October 25, 2026) | $0.006 per minute at 2 vCPU, tracked per second; plans from $20 a month with 2,000 runner minutes included ([source](https://depot.dev/pricing)) |
| Free use | The software is free; your Cloudflare account needs the Workers Paid plan, "a minimum cost of $5 USD per month per account" ([source](https://developers.cloudflare.com/workers/platform/pricing/), checked October 25, 2026) | A 7-day trial ([source](https://depot.dev/pricing)) |
| Caches | Built-in cache actions with parallel downloads | Accelerated Actions cache with no configuration, and remote BuildKit builders for Docker ([source](https://depot.dev/docs/github-actions/overview)) |
| Speed claim | Measured on our runners and published with methods: [Performance](/performance) | "Up to 3x faster than a GitHub-hosted runner" and "10x faster caching" (Depot's own claims, [source](https://depot.dev/docs/github-actions/overview)) |
| Compliance | None: Diffinery is open-source software you run, not a certified service | SOC 2 Type 2 ([source](https://depot.dev/security)) |
| AI agents | Agent accounts with server-enforced guardrails, an MCP server, sandboxes, agent tasks and agent review | Agent sandboxes; agents on GitHub work as they do there |

## Where each one is the better fit

**Depot is the better fit when** container image builds are your bottleneck, you need runners bigger than 4 vCPUs or on macOS, Windows or Arm, you want to keep GitHub as your forge and speed up CI around it, or you don't want to run any infrastructure yourself.

**Diffinery is the better fit when** you want one place for code, review and CI with a mature pull request workflow, when your CI is Linux, and when AI agents do a growing share of your work and you want the forge to enforce what they can and can't do. You run Diffinery yourself, on your own Cloudflare account.

## Frequently asked questions

### Can Depot runners run Diffinery workflows?

No. Depot's runners connect to GitHub organizations, and Depot CI runs workflows for GitHub and Depot Code repositories. On Diffinery, jobs run on your instance's hosted runners in Cloudflare Containers or on your own machines with `diffinery runner`.

### Can I build container images on Diffinery?

Yes. Hosted runners include Docker with Buildx, and images push to your instance's own registry at `<your instance's domain>/<owner>/<name>`. See [Docker in workflows](/docs/actions/docker) and [Container registry](/docs/packages/container-registry).

### Which is faster?

We haven't benchmarked Depot and don't quote others' numbers as our own. Diffinery's measured stage times are on the [Performance](/performance) page; Depot publishes its own claims in its documentation.
