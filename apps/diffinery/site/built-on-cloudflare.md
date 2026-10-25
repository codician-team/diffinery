---
title: Git hosting and CI built entirely on Cloudflare
seo_title: "Git hosting and GitHub Actions CI built on Cloudflare · Diffinery"
description: How open-source Diffinery runs Git hosting and GitHub Actions–compatible CI in your own Cloudflare account on Workers, Durable Objects, R2, D1 and Containers.
updated: 2026-10-25
---

Diffinery is an open-source (Apache-2.0) git forge and CI platform that runs entirely on Cloudflare, and you deploy it to your own Cloudflare account. There are no servers, virtual machines or databases behind it that anyone has to run: one Cloudflare Worker and the Cloudflare products it uses serve Git, pull requests, the REST API, the MCP server and the container registry, and every workflow job runs in a Cloudflare Container started for that job. Diffinery is an open-source platform where Git hosting, pull requests with reviews in a web UI and GitHub Actions–compatible CI, marketplace actions included, all run on Cloudflare (checked October 25, 2026; see [Other Git and CI projects on Cloudflare](/built-on-cloudflare#other-git-and-ci-projects-on-cloudflare)). This page explains how to run your own instance, which Cloudflare product does what, what that means for the people using it, how it differs from Cloudflare's own Workers Builds and from other projects on Cloudflare, and the limits that come with it.

## Run Diffinery on your own Cloudflare account

Diffinery is free, open-source software under the Apache-2.0 license. There is no hosted service to sign up for: you deploy your own instance to your own Cloudflare account, with your own domain, and run it as you like. Because Diffinery is one Worker plus the Cloudflare products it binds to, an instance needs a Cloudflare account on the Workers Paid plan, a domain on that account and a Cloudflare Zero Trust organization, and no machines to look after. The repository's Deploy workflow creates what's missing in your account and deploys the Worker, and every step of it is safe to repeat.

- **Source code:** [diffinery.com/codician/diffinery](https://diffinery.com/codician/diffinery), where Diffinery is developed, mirrored on GitHub at [github.com/codician-team/diffinery](https://github.com/codician-team/diffinery). Issues and pull requests are welcome on the GitHub mirror from people without a diffinery.com account.
- **Deploying:** [Deploy your own Diffinery](/docs/self-hosting/deploy) walks through it step by step. [Self-hosting](/docs/self-hosting) gives the overview, [Configuration](/docs/self-hosting/configuration) lists every setting and [Architecture](/docs/self-hosting/architecture) explains how the parts fit.
- **What it costs:** Diffinery itself is free. You pay Cloudflare for what your instance uses. It needs the Workers Paid plan, which has "a minimum cost of $5 USD per month per account", plus usage above the included amounts ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), checked October 25, 2026). Runner containers are billed by the 10 ms while a job runs ([Containers pricing](https://developers.cloudflare.com/containers/pricing/), checked October 25, 2026).
- **Who needs a Cloudflare account:** only the deployment. Nobody who uses your instance needs one; they sign in with passkeys. Every instance is invite-only by default, and `SIGNUP=open` opens sign-up.

## Which Cloudflare product runs what

This is the same mapping as the [Architecture](/docs/self-hosting/architecture) documentation, which goes into more detail.

| Cloudflare product | What it runs in Diffinery |
| --- | --- |
| Workers | The web UI and the public docs, Git over HTTPS, Git LFS, the REST API, the MCP server, the container registry, the runner API, and the Actions cache and artifact services. The Worker holds no state of its own: it signs the caller in, checks their role and hands the request to the right repository. |
| Durable Objects with SQLite, one per repository | Everything inside one repository: branches and tags, git objects, issues, pull requests, reviews, checks and commit statuses, releases, environments, workflow runs, secrets, webhooks and the merge queue. Live run logs and pull request updates reach the browser over the object's WebSockets. |
| R2 | Anything too large for SQLite: git objects over 512 KiB compressed, Git LFS files, archived job logs, Actions caches and artifacts, container image layers, release assets and cached source archives. |
| D1 | Data that belongs to no single repository: accounts, organizations, tokens, the list of repositories and who can reach them, invitations, notifications, the audit log and the container registry's index. |
| Queues | Webhook deliveries and their retries, notifications, audit log entries and email jobs, sent in the background so the request that caused them doesn't wait. |
| Workflows | Every workflow run, as a durable Cloudflare Workflow whose steps and waits survive restarts and deploys. GitHub imports and account exports run as Workflows too. |
| Containers | Hosted job runners (one container per job), agent sandboxes, and the Git transfer of each GitHub import. |
| Durable Object alarms and Cron Triggers | Scheduled workflows, checked every 5 minutes, and housekeeping such as registry cleanup and token expiry reminders. |
| Email Sending | Every email Diffinery sends: invitations, notifications and security emails. |
| Cloudflare Access | Only email-based account recovery and the first administrator's sign-in. Everyday sign-in is passkeys. |

## How a push and a workflow run move through it

1. `git push` reaches the Worker, which checks your token and your role on the repository and passes the push to the repository's Durable Object.
2. The object scans every new file for leaked credentials ([push protection](/docs/security/push-protection)), stores the objects (small ones in its SQLite database, large ones in R2), checks branch protection and moves each branch with a compare-and-swap, so two pushes to the same branch are applied one after the other.
3. It reads `.github/workflows/*.yml` from the pushed commit and starts a Cloudflare Workflow for each run that matches.
4. The Workflow plans the job graph and starts each job as soon as the jobs it `needs` have finished. For each job, the repository's object starts a fresh Cloudflare Container.
5. The runner in the container fetches its job, checks out the code and runs the steps. Logs stream to the repository's object and on to any browser watching; caches and artifacts go to R2.
6. When the job ends the container stops, and the Workflow starts whatever jobs were waiting on it.

## What this means for you

- **No servers to run.** Your instance is a Worker and the Cloudflare products it binds to, so there is nothing to provision, patch or scale: no CI machines, no runner fleet and no database. Workflow files, `gh` and your editor work as they do with GitHub.
- **Jobs start in seconds.** A fresh container per job starts in about 3 to 5 seconds, and the first job runs 6 to 8 seconds after `git push` returns (measured on October 16, 2026; see [Performance](/performance)).
- **Runners exist only while a job runs.** Diffinery starts a container when a job starts and stops it when the job ends, so no runner sits idle between jobs. Cloudflare bills a container by the 10 ms while it runs: its memory and disk for what its instance type provides, and its CPU by use ([Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/), checked October 25, 2026). That's why Diffinery picks a smaller runner for jobs that mostly wait, when their own measured runs show it serves them just as well ([Runner sizes](/docs/actions/runners#runner-sizes)). Over 24 hours on October 16, 2026, runner containers ran 6% longer than the jobs in them, for starting and stopping. Diffinery itself is free; what the containers use is billed to the Cloudflare account your instance runs in.
- **One busy repository never slows another.** Each repository is its own Durable Object with its own database, the single writer for everything in it, so ref updates, merges and run state are strongly consistent without locks.
- **Runs survive restarts.** A workflow run is a durable Workflow, so a deploy or a restart doesn't lose it. A deploy is set up not to replace the container of a running job, so jobs normally finish on the version they started with.
- **Cloudflare's network.** Requests are answered by the Worker at the Cloudflare location that receives them, and hosted jobs run in Cloudflare locations around the world: a 40-job probe on October 16, 2026 landed in North America, Europe and Japan. Each job's log names where it ran. A repository's own data lives in its Durable Object, in one place, so pages that read a repository make a trip to wherever that object is.

## Diffinery and Cloudflare Workers Builds

Cloudflare has its own build service, Workers Builds. In Cloudflare's words, it lets you "integrate with Git and automatically build and deploy your Worker when pushing a change", for a Worker connected to "a repository hosted by Artifacts, GitHub, or GitLab". A build runs an optional build command and then a deploy command, which defaults to `npx wrangler deploy`; builds of the production branch create a new version of the Worker, and other branches get a Preview ([Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) and [its configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), checked October 25, 2026).

Diffinery does a different job:

| | Diffinery | Cloudflare Workers Builds |
| --- | --- | --- |
| What it is | A git forge with pull requests, issues, releases, a container registry and GitHub Actions–compatible CI | A build and deploy service for Workers projects |
| Where your code lives | On your Diffinery instance, in your own Cloudflare account | Artifacts, GitHub or GitLab |
| What it runs | Any GitHub Actions workflow: tests, matrices, Docker, service containers, any language, on push, pull request, schedule and other triggers | A build command and a deploy command for a Worker |
| What it deploys | Whatever your workflow deploys, including Workers with `wrangler deploy` | The connected Worker |

They work together. A Diffinery repository doesn't appear in Workers Builds's list of repositories, so [Deploy to Cloudflare Workers](/docs/actions/deploy-to-cloudflare-workers) shows two ways to deploy automatically: a Diffinery Actions job that runs `wrangler deploy` on every push to `main` and gives each pull request its own Worker Preview (this is how Diffinery deploys itself), or a mirror of the branch to Cloudflare Artifacts for Workers Builds to build.

## Other Git and CI projects on Cloudflare

Cloudflare has made Git on its network a theme in 2026, and Diffinery isn't the only open-source project there. Here is what we found when we checked each one's own documentation and code on October 25, 2026, and how each differs:

| | Git hosting | Pull requests | CI on Cloudflare | Runs GitHub Actions workflows |
| --- | --- | --- | --- | --- |
| Diffinery (open source, Apache-2.0) | Yes, in your own Cloudflare account; no hosted service ([source](https://diffinery.com/codician/diffinery)) | Yes, with reviews and a merge queue | Yes, Cloudflare Containers | Yes, marketplace actions included ([differences](/docs/actions/compatibility)) |
| Cloudflare Artifacts with Cloudflare's CI SDK | Yes: Git-compatible repositories on Cloudflare ([source](https://developers.cloudflare.com/artifacts/)) | Not offered | Yes: pipelines written in TypeScript, run as Workflows in sandboxes when a repository is pushed ([source](https://blog.cloudflare.com/ci-workflows/), August 4, 2026) | No: TypeScript instead of YAML workflows ([source](https://blog.cloudflare.com/ci-workflows/)) |
| Flare Forge (open source, hosted demo) | Yes, on Artifacts ([source](https://github.com/everyai-com/flare-forge)) | Replaced by "intents" ([source](https://github.com/everyai-com/flare-forge)) | Yes, Cloudflare Containers ([source](https://github.com/everyai-com/flare-forge)) | Partly: workflow files are translated to its own format, and JavaScript and container `uses:` steps are dropped with a warning ([source](https://github.com/everyai-com/flare-forge/blob/main/apps/worker/src/actionsCompat.ts)) |
| git-forge by levino (open source, MIT) | Yes, in your own Cloudflare account; no hosted service ([source](https://github.com/levino/git-forge)) | Listed, with "the web UI and collaboration features are next" ([source](https://github.com/levino/git-forge)) | Yes, Cloudflare Containers since October 18, 2026, when its "CI runners on Cloudflare Containers" pull request was merged ([source](https://github.com/levino/git-forge/pull/61)); its README still says "not yet deployed" ([source](https://github.com/levino/git-forge)) | Yes, real workflows with the official `actions/runner` ([source](https://github.com/levino/git-forge)) |

Projects that only run GitHub's self-hosted runner in Cloudflare Containers keep the code and the pull requests on GitHub, so they aren't on this list. We re-check these projects when we update this page, and change the comparison when one of them changes.

## Deploying to Cloudflare from Diffinery CI

The recommended setup is a workflow like any GitHub Actions deploy: store a Cloudflare API token and your account ID as repository secrets, then run Wrangler in a job.

```yaml
jobs:
  deploy:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

The full guide, with Previews per pull request and keeping the production token in an environment, is [Deploy to Cloudflare Workers](/docs/actions/deploy-to-cloudflare-workers). For clouds that accept OpenID Connect, jobs can use short-lived [OIDC](/docs/actions/oidc) tokens instead of stored keys.

## Limits that come with building on Cloudflare

- **Hosted runners are Linux x64 only.** Cloudflare Containers run Linux, so there are no hosted macOS or Windows runners, and every `ubuntu-*` label, including `ubuntu-24.04-arm`, gets the same Ubuntu 24.04 x64 image. Use [self-hosted runners](/docs/actions/runners#self-hosted-runners) for macOS, Windows, Arm and GPUs.
- **At most 4 vCPUs and 12 GiB per hosted job.** The largest runner is Cloudflare's `standard-4` instance type; there are no larger hosted sizes.
- **Hosts span CPU generations.** Cloudflare's hosts mix AMD EPYC generations whose cores differ about 2x in speed, and nobody picks which one a job lands on. The same job can run up to about twice as fast on one host as on another; each job's log names the host's processor, and the ranges on [Performance](/performance) include the slow hosts.
- **Jobs sometimes wait for a machine.** When many jobs start at once, a container occasionally isn't placed or stops before its runner starts. Diffinery puts the job back in line and tries again on its own; it usually costs the job up to a minute or two. See [Runners troubleshooting](/docs/actions/runners#troubleshooting).
- **A push carries at most 100 MB.** Use [Git LFS](/docs/repositories/git-lfs) for large files. Container image layers larger than Cloudflare's 100 MB request limit push from hosted runners through a relay that splits them, but not from self-hosted runners.
- **Clones send more bytes than GitHub's.** Packs are sent without deltas, so clones and fetches download more data. See [Git over HTTPS](/docs/repositories/git#limits-and-differences-from-github).
- **20 hosted jobs at once per account and 80 per instance, by default.** Further jobs wait their turn. An instance's administrators set these limits (`HOSTED_JOBS_LIMIT` and the `QUOTA_*` variables in [Configuration](/docs/self-hosting/configuration)). See [Limits](/docs/reference/limits).

## Frequently asked questions

### Is Diffinery open source?

Yes. Diffinery is open source under the Apache-2.0 license, and nothing about it is sold. It is developed at [diffinery.com/codician/diffinery](https://diffinery.com/codician/diffinery) and mirrored on GitHub at [github.com/codician-team/diffinery](https://github.com/codician-team/diffinery). You run it by deploying your own instance to your own Cloudflare account; see [Deploy your own Diffinery](/docs/self-hosting/deploy).

### What does it cost to run Diffinery?

Diffinery itself is free. You pay Cloudflare for what your instance uses: it needs the Workers Paid plan, "a minimum cost of $5 USD per month per account", plus usage above the included amounts ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), checked October 25, 2026), and runner containers are billed by the 10 ms while a job runs ([Containers pricing](https://developers.cloudflare.com/containers/pricing/), checked October 25, 2026).

### Does Diffinery run on Cloudflare?

Yes, entirely. A Cloudflare Worker serves the web UI, Git, the REST API and MCP; each repository is a Durable Object with its own SQLite database; large files live in R2 and accounts in D1; workflow runs are Cloudflare Workflows; and every workflow job runs in its own Cloudflare Container. See [Architecture](/docs/self-hosting/architecture).

### Is Diffinery the only Git and CI platform on Cloudflare?

No. Other open-source projects run Git and CI on Cloudflare too; here's how they differ (checked October 25, 2026). Cloudflare Artifacts with Cloudflare's CI SDK runs TypeScript pipelines rather than GitHub Actions workflows and has no pull requests; Flare Forge uses "intents" instead of pull requests and drops JavaScript and container `uses:` steps from workflow files; and git-forge (MIT) runs real workflows with the official `actions/runner` on Cloudflare Containers since October 18, 2026, while its README says "the web UI and collaboration features are next". Diffinery has all three today: Git hosting, pull requests with reviews in a web UI, and GitHub Actions–compatible CI with marketplace actions. See [Other Git and CI projects on Cloudflare](/built-on-cloudflare#other-git-and-ci-projects-on-cloudflare).

### Is Diffinery the same as Cloudflare Workers Builds?

No. Workers Builds builds and deploys a Worker from a repository on Artifacts, GitHub or GitLab. Diffinery hosts the repository itself, with pull requests and issues, and runs any GitHub Actions workflow, which can deploy a Worker among other things.

### Can I deploy to Cloudflare Workers from Diffinery?

Yes. A workflow job runs `wrangler deploy` with a Cloudflare API token stored as a secret, and can give each pull request its own Worker Preview. See [Deploy to Cloudflare Workers](/docs/actions/deploy-to-cloudflare-workers).

### Does Docker work on runners in Cloudflare Containers?

Yes. Job containers, service containers, Docker actions, `docker build` and `docker compose` work as on GitHub's runners. The Docker daemon starts the first time a job uses it, or as the job begins when the workflow uses Docker. See [Docker in workflows](/docs/actions/docker).
