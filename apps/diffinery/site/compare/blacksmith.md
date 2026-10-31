---
title: Diffinery vs Blacksmith
seo_title: "Diffinery vs Blacksmith: faster GitHub Actions, two approaches"
description: Blacksmith runs GitHub Actions jobs on its runners while you stay on GitHub. Diffinery replaces GitHub and Actions, or runs your GitHub jobs itself.
updated: 2026-10-30
---

Blacksmith and Diffinery both make GitHub Actions workflows run faster, in different ways. Blacksmith sells drop-in runners for GitHub Actions: your code, pull requests and workflows stay on GitHub, and jobs run on Blacksmith's machines. Diffinery replaces GitHub and GitHub Actions together, with fast runners built in, and those runners can also run the jobs of repositories that stay on GitHub ([GitHub runners](/docs/actions/github-runners)). Blacksmith is a service that runs the runners for you; Diffinery is free, open-source software (Apache-2.0) that you deploy to your own Cloudflare account, with no hosted service (see [Deploy your own Diffinery](/docs/self-hosting/deploy) and the [source code](https://github.com/codician-team/diffinery)). Blacksmith facts here are from its own website and documentation, checked on October 16, 2026, and linked below.

## In short

- **Choose Blacksmith** if you want to stay on GitHub and only want faster or cheaper CI. It needs a GitHub App and a new `runs-on` label, and offers Linux, Arm, Windows and macOS runners up to 32 vCPUs, run for you with nothing to deploy.
- **Choose Diffinery** if you want one platform for code, reviews and CI, with AI agents as accounts that the server holds to guardrails, and Linux runners that are 4 vCPU by default, and you're happy to run your own instance on Cloudflare. Not ready to move? Your instance's runners work for repositories that stay on GitHub too, with `runs-on: diffinery`.

## Side by side

| | Diffinery | Blacksmith |
| --- | --- | --- |
| What it is | Git hosting, pull requests, issues and GitHub Actions–compatible CI in one platform | Runners for GitHub Actions; you stay on GitHub ([source](https://docs.blacksmith.sh/introduction/quickstart)) |
| Who runs it | You: you deploy your instance to your own Cloudflare account and pay Cloudflare for its usage | Blacksmith runs the runners; GitHub runs the rest |
| Where your code lives | Your Diffinery instance | GitHub (github.com, Enterprise Server or Enterprise Cloud) |
| Setup | Deploy your instance ([guide](/docs/self-hosting/deploy)), then import your repositories; workflows run as they are | Install the GitHub App, change `runs-on` to a Blacksmith label such as `blacksmith-2vcpu-ubuntu-2404` |
| Runners for repositories on GitHub | Yes: install your instance's GitHub App and set `runs-on: diffinery` ([guide](/docs/actions/github-runners)) | Yes: that's the product |
| Personal repositories | Yes, on Diffinery and on GitHub | No: GitHub organizations only ([source](https://docs.blacksmith.sh/introduction/quickstart)) |
| Linux x64 runner sizes | 1/4, 1/2, 2 and 4 vCPU; 4 vCPU and 12 GiB by default, smaller sizes picked per job from its measured runs | 2, 4, 8, 16 and 32 vCPU ([source](https://docs.blacksmith.sh/blacksmith-runners/overview)) |
| Arm, Windows, macOS | Self-hosted runners only | Arm, Windows (public beta) and macOS on Apple M4 ([source](https://docs.blacksmith.sh/blacksmith-runners/overview)) |
| Machines | Cloudflare Containers on AMD EPYC hosts | "Modern gaming CPUs", in Firecracker microVMs ([source](https://docs.blacksmith.sh/blacksmith-runners/overview)) |
| Linux x64 price | Free and open source (Apache-2.0); you pay Cloudflare for your instance's usage, with runner containers billed by the 10 ms while a job runs ([source](https://developers.cloudflare.com/containers/pricing/), checked October 25, 2026) | $0.004 per minute at 2 vCPU, rising with vCPU count; 3,000 free 2-vCPU minutes a month per organization ([pricing](https://www.blacksmith.sh/pricing), [free minutes](https://docs.blacksmith.sh/blacksmith-runners/overview)) |
| Caches | Built-in cache actions that download in parallel ranges and extract while downloading | A colocated cache used by the official cache actions, plus Docker layer caching and sticky disks as paid add-ons ([source](https://www.blacksmith.sh/pricing)) |
| Speed claim | Measured on our runners and published with methods: [Performance](/performance) | "2x faster than GitHub's runners" (Blacksmith's own claim, [source](https://www.blacksmith.sh/)) |
| Regions | Cloudflare's network | Ashburn, Phoenix, Amsterdam and Frankfurt ([source](https://docs.blacksmith.sh/blacksmith-runners/overview)) |
| Compliance | None: Diffinery is open-source software you run, not a certified service | SOC 2 Type 2 ([source](https://www.blacksmith.sh/security)) |
| AI agents | Agent accounts with server-enforced guardrails, an MCP server, sandboxes, agent tasks and agent review | Agent products of its own; agents on GitHub work as they do there |
| Pull requests, issues, code review | Built in | GitHub's |

## Where each one is the better fit

**Blacksmith is the better fit when** your team is settled on GitHub, needs macOS, Windows, Arm or runners larger than 4 vCPUs, wants SOC 2 Type 2 today, or doesn't want to run any infrastructure itself.

**Diffinery is the better fit when** you'd rather have one platform than GitHub plus a runner service and are happy to run it on your own Cloudflare account, your CI is Linux, you work with AI coding agents and want the forge itself to limit what they can do, or you want workflows, `gh`, your editor and your agents to move together.

## Frequently asked questions

### Can I use Blacksmith with Diffinery?

No. Blacksmith runners connect to GitHub through its GitHub App. On Diffinery, jobs run on your instance's hosted runners in Cloudflare Containers or on your own machines with `diffinery runner`.

### Can Diffinery run jobs for repositories that stay on GitHub, like Blacksmith?

Yes. Install your instance's GitHub App on your GitHub user or organization, link it to the Diffinery account whose hosted minutes pay, and set a job's `runs-on` to `diffinery` (or `diffinery-medium`, `diffinery-small`, `diffinery-tiny`). GitHub's own runner then runs the job in a fresh container on your instance. See [GitHub runners](/docs/actions/github-runners).

### Is Diffinery cheaper than Blacksmith?

Diffinery itself is free and open source; you pay Cloudflare for what your instance uses, on the Workers Paid plan ("a minimum cost of $5 USD per month per account", plus usage above the included amounts; [source](https://developers.cloudflare.com/workers/platform/pricing/), checked October 25, 2026). That bill depends on your usage, so we don't quote a per-minute figure to compare. Blacksmith lists $0.004 per minute for a 2-vCPU Linux runner, against GitHub's $0.006, and runs the machines for you. Diffinery's default runner has 4 vCPUs.

### Which is faster?

We haven't benchmarked Blacksmith and don't quote others' numbers as our own. Diffinery's measured stage times are on the [Performance](/performance) page; Blacksmith publishes its own claims on its website.
