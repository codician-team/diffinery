---
title: Open source
seo_title: "Open-source, self-hosted GitHub alternative on Cloudflare · Diffinery"
description: Diffinery is free, open-source software (Apache-2.0). Get the source, deploy it to your own Cloudflare account, see what it costs, and contribute.
updated: 2026-10-25
---

Diffinery is open source under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). Everything on this site, from Git hosting and pull requests to GitHub Actions–compatible CI, hosted runners, the MCP server and the agent features, is in one public repository. There are no plans, prices or sales, and no paid edition. You run Diffinery yourself, on your own Cloudflare account and domain.

## Source code

| | |
| --- | --- |
| Repository | [diffinery.com/codician/diffinery](https://diffinery.com/codician/diffinery), where Diffinery is developed and its CI runs |
| Mirror on GitHub | [github.com/codician-team/diffinery](https://github.com/codician-team/diffinery) |
| License | Apache-2.0, in the repository's `LICENSE` file, with a `NOTICE` file ("Copyright 2026 The Diffinery Authors") |
| Language and platform | TypeScript, on Cloudflare Workers, Durable Objects, R2, D1, Queues, Workflows and Containers. See [Architecture](/docs/self-hosting/architecture). |

Clone it from either place:

```bash
git clone https://diffinery.com/codician/diffinery.git
# or
git clone https://github.com/codician-team/diffinery.git
```

The Apache License lets you use, change and redistribute Diffinery, commercially or not, as long as you keep the license and notices; it also grants a patent license from contributors. Read the [license text](https://www.apache.org/licenses/LICENSE-2.0) for the exact terms.

## Run your own Diffinery

Diffinery is one Cloudflare Worker plus the Cloudflare products it binds to, so an instance has no servers, virtual machines or databases of its own. One command, `scripts/setup.sh` from a clone, checks your tools, API token and zone and then deploys: it creates what's missing in your Cloudflare account (the D1 database, R2 bucket, queues, Turnstile widget and Cloudflare Access application), applies migrations, uploads the Worker and builds the runner image. Then you sign in as the first administrator and invite your team.

What you need:

- A Cloudflare account on the Workers Paid plan, with R2 turned on.
- A domain added to that account, for your instance's hostname.
- A Cloudflare Zero Trust organization, for the first administrator's email sign-in and passkey recovery.
- A machine with Node.js 22, pnpm, `jq`, `curl`, `openssl` and Docker to run the deploy, or a forge with GitHub-compatible Actions to run the Deploy workflow.

Nobody who uses your instance needs a Cloudflare account; only the deployment does. Follow [Deploy your own Diffinery](/docs/self-hosting/deploy) step by step, and see [Self-hosting](/docs/self-hosting) for an overview and [Configuration](/docs/self-hosting/configuration) for every setting.

## What it costs

Diffinery is free. You pay Cloudflare for what your instance uses, on your own Cloudflare bill:

- The Workers Paid plan has "a minimum cost of $5 USD per month per account", which includes Workers and Durable Objects usage up to its allowances, and you pay for usage above them ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), checked October 25, 2026).
- Hosted CI runners and agent sandboxes are Cloudflare Containers. Cloudflare bills a container by the 10 ms while it runs ([Containers pricing](https://developers.cloudflare.com/containers/pricing/), checked October 25, 2026), and Diffinery starts one only when a job starts and stops it when the job ends, so idle time costs nothing. Jobs that mostly wait move to smaller runners on their own ([Runner sizes](/docs/actions/runners#runner-sizes)).
- R2, D1, Queues and Workflows bill by use under Cloudflare's own pricing for each product.

What a month costs depends on how much your team pushes and builds. Each instance sets per-account quotas for hosted minutes, jobs at once, sandboxes, repositories and storage, with defaults its administrators change; see [Limits](/docs/reference/limits#account-quotas).

## What diffinery.com is

diffinery.com is the project's home: this site, the [documentation](/docs), and the Diffinery instance that Diffinery itself is developed on, with its CI, deploys and agents. Accounts there are by invitation. If you'd like to try Diffinery before running your own, [request early access](https://diffinery.com/early-access): its administrators review requests and email invitations. It isn't a hosted service for teams; to use Diffinery for your work, run your own instance.

## Contribute

- **Issues and pull requests:** on [the GitHub mirror](https://github.com/codician-team/diffinery) if you don't have a diffinery.com account, or on [the Diffinery repository](https://diffinery.com/codician/diffinery). The repository's `CONTRIBUTING.md` explains how to build, test and send changes.
- **Security problems:** report them privately with the [report form](/security/report), not in a public issue. See [Vulnerability disclosure](/docs/security/disclosure).
- **Docs:** every page at [/docs](/docs) is Markdown in the repository, under `apps/diffinery/docs/`.

## Frequently asked questions

### Is Diffinery open source?

Yes, under the Apache License 2.0. The source is at [diffinery.com/codician/diffinery](https://diffinery.com/codician/diffinery) and mirrored to [github.com/codician-team/diffinery](https://github.com/codician-team/diffinery).

### Is there a paid or enterprise edition?

No. There's one edition, the open-source one, and nothing is sold.

### Is there a hosted version I can sign up for?

Not one to sign up for. To try Diffinery, [request early access](https://diffinery.com/early-access) to diffinery.com, the project's own instance, where accounts are by invitation. To use Diffinery for your team, deploy your own instance to your Cloudflare account; see [Deploy your own Diffinery](/docs/self-hosting/deploy).

### What does running Diffinery cost?

Diffinery itself is free. Your instance runs on your Cloudflare account, which needs the Workers Paid plan (a minimum of $5 USD per month per account, plus usage above its allowances), and pays for containers, storage and the other Cloudflare products by use. See [What it costs](/open-source#what-it-costs).

### Can I run Diffinery somewhere other than Cloudflare?

No. Diffinery is built on Cloudflare's products (Workers, Durable Objects, R2, D1, Queues, Workflows and Containers) and has no version for other clouds or for your own servers. Self-hosted runners, though, run jobs on any machine you control; see [Self-hosted runners](/docs/actions/runners#self-hosted-runners).
