---
title: How we run GitHub Actions on Cloudflare Containers
seo_title: "How we run GitHub Actions on Cloudflare Containers · Diffinery"
description: The design behind Diffinery Actions: a Durable Object per repository, a container per job, built-in actions, head starts and auto-sizing, with measurements.
published: 2026-10-25
updated: 2026-10-25
---

Diffinery is an open-source (Apache-2.0) git forge whose CI runs GitHub Actions workflow files as they are, and you run it on your own Cloudflare account. It has no servers of its own: everything runs on Cloudflare, and every workflow job runs in a Cloudflare Container started for that job and thrown away after it. This post explains how that works, what we changed after measuring it, what we decided not to build, and what is still hard.

Unless a section says otherwise, the numbers come from Diffinery's production runners between October 14 and 17, 2026. They're taken from step timestamps in job logs, from what each runner measured about its own job, and from Cloudflare's per-container metrics. We didn't run anything on GitHub for this post. Where GitHub comes up, the figures are from its own documentation, linked and dated.

## The shape of the system

Diffinery is one Cloudflare Worker plus the Cloudflare products it binds to ([Architecture](/docs/self-hosting/architecture)):

- **The Worker** serves the web UI, Git over HTTPS, the REST API, MCP, the container registry, the runner API and the Actions cache and artifact services. It holds no state: it signs the caller in, checks their role and calls the repository.
- **Each repository is a Durable Object** with its own SQLite database. It is the single writer for everything in the repository: refs, git objects, issues, pull requests, checks, workflow runs, logs while a job runs, secrets. Two pushes to the same branch are applied one after the other, and a compare-and-swap on the ref rejects the stale one, so we get strong consistency without locks, and one busy repository never slows another.
- **R2** holds what's too big for SQLite: git objects over 512 KiB compressed, Git LFS files, archived logs, caches, artifacts, image layers and release assets.
- **Each workflow run is a Cloudflare Workflow.** It asks the repository for the job graph, starts each job as soon as the jobs it `needs` finish, and waits for an event that the repository sends when a job completes, with a 6-hour timeout. Its steps and waits survive restarts and deploys, so a deploy of Diffinery doesn't lose a run.

A push flows through it like this: the Worker passes it to the repository's object, which scans it for leaked credentials, stores the objects, checks branch protection, moves the refs, parses `.github/workflows/*.yml` from the new commit and creates a Workflow instance for each run that matches.

## A container per job

When a job is ready, the repository's object starts a container named after the job. The runner agent inside fetches its job spec with a token scoped to that one job, checks out the code, runs the steps, streams log lines back to the repository's object (which forwards them to any open browser tab over WebSockets), reports its outputs and exits. Nothing carries over to the next job except caches and artifacts.

The image is Ubuntu 24.04 with Node.js 22, Python 3.12, Docker, `gh`, git, git-lfs and build tools, and nothing else. GitHub's image preinstalls most toolchains; ours stays small on purpose, for reasons that come up below. The full list is in [Runners](/docs/actions/runners#the-ubuntu-2404-image).

A container per job fits how Cloudflare bills containers. A container is billed for every 10 ms it runs: memory and disk for what its instance type provides, used or not, and CPU only for what it uses ([Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/), checked October 25, 2026). A container that exists only while its job runs means no idle fleet. We checked that it really works that way: joining Cloudflare's per-container metrics to our jobs over 24 hours on October 16, the 892 runner containers we could match to a job ran 39.0 container-hours for 36.9 job-hours. Starting and stopping cost 6%, and no runner idled after its job.

### What we got wrong first: 1-vCPU runners

The first runners used Cloudflare's `standard-2` instance type: 1 vCPU and 6 GiB. A probe on October 14 found what that meant in practice: every runner reported one core, and four Python processes took four times as long as one. On a developer machine, the same typecheck of Diffinery's monorepo took 48 seconds on one core and 21 on four, and the app's unit tests 54 and 21 seconds.

That day we switched the default runner to `standard-4` (4 vCPUs, 12 GiB, 20 GB of disk). Diffinery's CI jobs had taken 1.7 times as long on 1 vCPU, and its end-to-end shards 1.1 to 1.4 times as long. Because CPU is billed by use, a CPU-bound job costs about the same either way at Cloudflare's list prices: it does the same work in less time. Our unit test job went from about 115 seconds to about 55.

That fixed CPU-bound jobs and made jobs that wait more wasteful. Measured on October 15 and 16, Diffinery's own CI and end-to-end jobs kept 0.5 to 2 vCPUs busy on average and peaked at 3.2 to 6 GiB of memory, and a set of deploy jobs that waited on another service kept 0.00 to 0.07 cores busy at about 0.3 GiB while paying for 12 GiB. That led to runner sizes, further down.

## Built-in actions

`actions/checkout`, `setup-node`, `setup-python`, `setup-go`, `cache`, `upload-artifact` and `download-artifact` are implemented inside the runner instead of being downloaded and started in Node.js for every job. They mirror the official actions' inputs, outputs and storage formats, so a cache saved by a built-in restores with the official action and the other way round. When a step uses a version, input or value the built-in doesn't handle, the real action is downloaded from GitHub and runs instead ([Built-in actions](/docs/actions/compatibility#built-in-actions)).

Caches and artifacts use the same services GitHub's Actions toolkit talks to. The Worker implements them and accepts the parts of the Azure Blob Storage protocol the toolkit uses (blocks, block lists and ranged reads), storing the data in R2. One wrinkle: the official artifact actions refuse to run on a server that looks like GitHub Enterprise Server, so the runner shows them `GITHUB_SERVER_URL=https://github.com` while their API calls still go to Diffinery.

Two changes on October 16 made these fast:

- **Cache restores** now download 16 ranges at once and extract while they download. Restoring a 216 MB pnpm cache went from 8 to 21 seconds down to 3 to 4 seconds on fast hosts (about 10 seconds on the slowest), and `pnpm install` from that cache from 12 to 15 seconds down to 3 to 7 seconds. Part of the install gain came from a pnpm setting in our own project (its side-effects cache turned off), not from the runner.
- **Artifact uploads** are joined as parallel parts, in a Durable Object of their own for each upload step instead of the repository's object. Uploading a 200 MB artifact went from 25 to 38 seconds down to 7 to 9 seconds. Before, the repository's other requests slowed to 1 to 4 seconds (peaks of 10) during a big upload; afterwards they stayed at about 0.2 seconds.

## Head starts during checkout

The runner reads the workflow before the first step runs, so it knows what the job will need. Two things are worth starting early.

**Docker.** Running `dockerd` in every container, as GitHub's image does, would cost memory on every runner, including the many jobs that never use Docker, and the smallest runner has 1 GiB. Instead, `docker` is a wrapper that starts the daemon on first use, and a job whose workflow mentions Docker (a job `container:`, `services:`, a Docker action or a step that names `docker`) gets the daemon started as the job begins, so checkout hides the start. The first `docker` command after checkout went from 2 to 5 seconds down to 0.03 to 0.3 seconds. When `docker` is a job's very first step, it still waits 1.4 to 2.3 seconds for the daemon; on GitHub it's already running.

Getting there took two fixes the head start exposed: a lock that leaked, and a daemon start with no time limit, which could leave a stuck job hanging until its 6-hour timeout. A stuck start now fails the step within minutes, and a pre-merge CI check runs real Docker with the change's own wrapper.

Docker inside a Cloudflare Container needs some adapting. The usual Buildx `docker-container` driver can't work there, so the wrapper starts the BuildKit container on the host network and registers it as a remote builder. Image layers larger than Cloudflare's 100 MB request limit go through a local relay that splits them into chunks. Docker Hub pulls go through `mirror.gcr.io`, which avoids Docker Hub's anonymous rate limits. Details are in [Docker in workflows](/docs/actions/docker).

**Go and Java.** When a job has `actions/setup-go`, or `actions/setup-java` with Temurin, and the version is known from the workflow, the runner starts downloading and extracting that toolchain as the job begins, checks it against its published SHA-256 and puts it where the action looks. `setup-go` went from 5 seconds to 1 to 3 seconds and `setup-java` from 7 to 13 seconds to 2 to 5 seconds; a whole small Go job from 7 to 4 to 5 seconds and a Java job from 9 to 15 to 4 to 7 seconds. What's left is writing the toolchain to disk, 250 MB for Go and 350 MB for a JDK, which takes 2.5 to 3.5 seconds even with no network. GitHub, which preinstalls them, takes about a second.

## What we didn't build: a second runner image

The obvious way to close that last gap is an image with Go and Java preinstalled, used by the jobs that ask for them. We weighed it and didn't build it:

- **The gain is small.** It saves at most 1 to 3 seconds per job, and only when the job asks for a version the image holds. Each Go version is 250 MB on disk and each JDK 350 MB (measured), so preinstalling a few of each would add well over 1 GB (our estimate). A job asking for any other version downloads it anyway.
- **It multiplies the moving parts.** Every runner size would need its own container class with that image: four more container classes, four more Durable Object classes and migrations, and four more image rollouts on every deploy.
- **Cold image pulls cost more than it saves.** A container's first start on a machine pulls its image, and after a deploy that can take minutes. An image that only Go and Java jobs use stays cached on far fewer machines, so those jobs would hit that pull much more often. One such start costs more than 1 to 3 seconds saved across hundreds of jobs.
- **Rollouts are already the touchiest part.** Rollouts were behind some of the worst delays we chased (below), and a second image would double what gets rolled out.

The head start already got most of the gain with none of that, so the image stays small.

## Sizing each job from its own CPU samples

Since memory and disk are billed for what a container provides, a job that waits on an API for a minute pays for 12 GiB for that minute. So hosted runners come in four sizes, all with the same image ([Runner sizes](/docs/actions/runners#runner-sizes)):

| Size | vCPU | Memory | Disk | Cloudflare instance type |
| --- | --- | --- | --- | --- |
| large (default) | 4 | 12 GiB | 20 GB | `standard-4` |
| medium | 2 | 8 GiB | 16 GB | `standard-3` |
| small | 1/2 | 4 GiB | 8 GB | `standard-1` |
| tiny | 1/4 | 1 GiB | 4 GB | `basic` |

A job can name a size with a label such as `diffinery-small`. A job that doesn't is sized from its own history, under rules designed so that a smaller runner is never the reason a job fails or slows down:

- **Measure everything.** The runner samples busy cores, memory and disk every quarter second, and counts processes the kernel killed for want of memory. The end of each job's log says what it used, and the job API returns it.
- **Smaller only with headroom.** The next run of the same job looks at up to its last 5 runs and needs at least 3. It gets a smaller size only if every one of them would have fit with room to spare: 1.5 times peak memory plus 0.5 GiB, 1.25 times peak disk plus 1 GB, and at least 1.5 times the cores it kept busy in its busiest quarter second. Busy cores count as if measured on the slowest host processor, because Cloudflare's hosts differ about 2x per core (more on that below). A job that kept its runner's CPU busy to the limit never gets smaller than that runner.
- **Back to large after any slowdown.** A job returns to large if a smaller size ran it out of memory, failed it, timed it out, or made it slower than it is on large beyond its own run-to-run noise: more than a tenth plus 2 seconds over the median of its large runs, and slower than all but one of its last ten large runs. It then stays on large for its next 20 runs, so it doesn't flap. Re-runs always run on large, and so does a job that found no smaller runner free.

### What we got wrong first: 2-second windows

The first version sampled busy cores over 2-second windows. Checking the rules against the speed benchmarks on October 16 showed the flaw: averaging over 2 seconds reads short bursts low. A 30-second job with ten third-of-a-second bursts on one core read as 0.17 busy cores and would have been given half a vCPU, about 10% slower. We moved to quarter-second windows the same day, counted every run measured the old way as unmeasured, and tightened the slowdown limit, which had been a fifth plus 10 seconds over the median.

The change caught a real case. A long-running test job of ours had moved to medium after three clean runs on large. One later run on medium took 457 seconds against 310 to 329 seconds on large. The extra time was in steps waiting for other jobs to start, not in its own work, but under the new limit it counts as slower, and measured the new way the job peaks at 1.26 cores rather than the 0.4 to 0.5 it read over 2-second windows. It went back to large for 20 runs and stays there by its peak. We would rather keep a job on large by mistake than slow it down.

### What sizing does in practice

The same lint job (checkout, `npm ci` with 89 packages, eslint, prettier and `tsc` on 40 files), two runs per size on October 16:

| Size | Whole job | `tsc` step |
| --- | --- | --- |
| tiny (1/4 vCPU) | 15 to 27 s | 7 to 14 s |
| small (1/2 vCPU) | 13 to 14 s | 5 s |
| medium (2 vCPU) | 10 to 13 s | 2 to 3 s |
| large (4 vCPU) | 9 to 14 s | 2 to 4 s |

A job that only made ten REST calls took 4 seconds on both tiny and large. A deploy-style job from an unchanged workflow (checkout, API calls and a `sleep`) moved to medium after its third measured run, at the same 49 to 51 seconds and the same 3 to 5 second start. A test job keeping 4 cores busy stayed on large.

For Diffinery's own pipeline, the rules keep every job on large, so sizing saves us about nothing: our CI and end-to-end jobs burst onto 3 or 4 cores. Even a half-second deploy job that only reads the tip of `main` kept 1.6 cores busy while it ran. The savings go to jobs that genuinely wait, and to anyone who pins a size.

A probe pinned one job to each size on October 16. All four started within 4 to 5 seconds of the run being created and had the expected machine. A short single-threaded loop ran as fast on tiny (738 ms) as on large (730 ms), because Cloudflare lets short bursts through, but the rules don't count on that.

## What's still hard

### Hosts span CPU generations

Cloudflare places containers on hosts with different AMD EPYC generations, and we don't choose which. In a 40-job probe on October 16, pinned to large, 36 jobs landed on Zen 4 hosts, 3 on Zen 3 and 1 on Zen 2. The same single-threaded Node.js loop took a median of 714 ms on Zen 4, 887 ms on Zen 3 and 1,421 ms on Zen 2, roughly 2x between the fastest and slowest cores. Earlier that day, the same unit test shard took 28 to 31 seconds on one host and 78 to 90 seconds on others at the same time. It wasn't memory, and it wasn't throttling: identical work used more CPU-seconds on the slower cores, while steal (CPU time the host gave to other work) was mostly low. A later run saw a Zen 5 host for the first time.

Since placement isn't ours to pick, we made everything else independent of it. Each job's log names the host's processor and how much steal it saw, so a slow job can be told from a slow host. Our own tests that check speed compare against the same work timed on the same machine. Sizing counts busy cores as on the slowest host. And the numbers we publish are ranges that include the slow hosts.

### Placement churn in bursts

When many jobs start at once, some containers don't make it. In a 40-job burst on October 16, 24 jobs started at once and 16 waited: every one of the 16 logs said its container had stopped before the runner started, 6 to 50 seconds after the run was created. The platform stopped them with no exit code. A retry 30 seconds later worked every time, but each affected job lost 60 to 75 seconds. Now the first such stop is retried after 5 seconds and isn't counted against the job's retries, which saves about 25 seconds per affected job. When no machine is free at all, a job goes back in line and retries after 30 seconds, then 1, 2, 4 and 5 minutes, up to 8 times; each wait adds a line to the job's log saying why.

The platform can also stop a container in the middle of a job. Diffinery then starts the job again from the beginning on a new runner, up to twice, but only if the job can only read: no secrets other than the job token, no deployment environment and a token that can't write. A job that could change something outside the run, such as a deploy or a publish, fails instead, naming the step, because running that step twice could repeat what it did ([Limits and timeouts](/docs/actions/runners#limits-and-timeouts)).

### Rollouts

A deploy of Diffinery rolls a new runner image out across Cloudflare's machines. Running jobs are left alone: the rollout's grace period is longer than a job can run, so jobs finish on the image they started with. New containers are the problem: for a while, a new container can still start on the previous image. The runner reports its image, and Diffinery turns away an outdated runner before it runs anything and starts the job again.

That check had a bug. Right after a deploy on October 16, the repository's object still held the previous image's ID for a few minutes while new containers already ran the new image, so 18 of 40 jobs were turned away as outdated when they weren't, and waited through 30, 60 and 120 seconds of back-off. The check now uses the image of the Worker that took the runner's request. On the next deploy, 55 jobs saw no wrong refusals, and 13 runners that really were on the old image were correctly turned away. We also shortened the wait: a job turned away during a rollout now tries again every 20 seconds instead of backing off. On a rollout on October 17, a job turned away three times started on the new image 69 seconds after its first refusal; before, three refusals took at least three and a half minutes.

### Git storage without deltas

A repository per Durable Object has a cost on the Git side too. Objects are stored one compressed stream each, without deltas, which we measured at about 6 times the size of a git pack for two repositories (October 14 to 16), and packs are sent to clients without deltas, so clones download more bytes than from GitHub ([Git over HTTPS](/docs/repositories/git#limits-and-differences-from-github)). Storing objects with deltas is the biggest piece of open architecture work, and it touches the core of the git store, so it will get its own careful change.

## Where it landed

Measured on Diffinery's large runner on October 16, 2026, after the changes above were deployed ([Performance](/performance) has the full tables and method):

| Stage | Diffinery |
| --- | --- |
| Push to first job running | 6 to 8 s |
| Job start | About 3 to 5 s |
| `actions/checkout` | 1 to 3 s |
| Restore a 216 MB pnpm cache | 3 to 4 s on fast hosts, about 10 s on the slowest |
| `pnpm install` from that cache | 3 to 7 s |
| Upload a 200 MB artifact | 7 to 9 s |
| `setup-go`, `setup-java` | 1 to 3 s and 2 to 5 s |
| First `docker` command after checkout | 0.03 to 0.3 s |

Diffinery's own pull requests run 10 required checks, including seven end-to-end suites that start a real Diffinery server. From the first job starting to the last finishing, they take about 3 minutes, and up to about 6 when jobs land on the slowest hosts.

For comparison, GitHub's standard Linux runner for private repositories has 2 vCPUs and 8 GB of memory, and 4 vCPUs and 16 GB for public ones ([GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), checked October 25, 2026). Diffinery's default has 4 vCPUs and 12 GiB, so jobs that use several cores get twice as many as on GitHub's private-repository runner, and as many as on its public-repository one. We haven't run the same jobs on both, so we don't claim a speed-up figure. GitHub is still faster where it preinstalls things: Go, Java and a running Docker daemon.

## How we measured

- All Diffinery numbers are from diffinery.com's production hosted runners between October 14 and 17, 2026, mostly from benchmark workflows on a separate scratch repository and from Diffinery's own CI. Each benchmark ran at least twice per configuration; Docker, Go and Java ran three times before and after each change.
- Stage times come from step timestamps in job logs. Upload times were measured by timing the block uploads and the final join separately. Repository latency during uploads was measured by a separate runner timing two requests every half second.
- CPU, memory and disk use come from the runner's own quarter-second samples, reported with each job. Container time comes from Cloudflare's per-container analytics, joined to Diffinery's jobs by container ID.
- Where this post talks about cost, it means Cloudflare's published list prices for containers, not invoices. Diffinery itself is free; an instance's Cloudflare account pays for what its containers use.
- GitHub's figures come from GitHub's documentation, read on October 25, 2026. We didn't run benchmarks on GitHub.

If you run Diffinery with your own workflows, every job's log ends with what it used and names the runner size it got and why. The source code is at [diffinery.com/codician/diffinery](https://diffinery.com/codician/diffinery), mirrored on [GitHub](https://github.com/codician-team/diffinery), and [Deploy your own Diffinery](/docs/self-hosting/deploy) shows how to run it on your own Cloudflare account. See also [Runners](/docs/actions/runners), [Compatibility with GitHub Actions](/docs/actions/compatibility) and [Built on Cloudflare](/built-on-cloudflare).
