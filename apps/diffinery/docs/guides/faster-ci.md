---
title: Make your CI faster on Diffinery
description: Speed up workflows on Diffinery Actions: runner sizes and auto-sizing, caching, setup and Docker head starts, matrices, and cancelling superseded runs, with measured numbers.
updated: 2026-10-25
---

On Diffinery, a hosted job gets 4 vCPUs and 12 GiB of memory by default, and the common setup actions are built into the runner, so many workflows are fast without changes. To go further: let CPU-heavy jobs use all four cores, cache dependencies with keys that the default branch saves, use the Node.js and Python versions the image already has, split long jobs into parallel jobs with `needs` and matrices, and turn on cancelling of superseded pull request runs, which is off by default. Every job's log says how much CPU, memory and disk it used, so you can see where the time goes.

## Steps

1. **Read what a job used.** The last lines of each hosted job's log show its usage, for example `Resources: 0.1 of 4 vCPUs busy on average (0.3 at the 95th percentile), peak memory 0.3 GiB of 12.0 GiB, peak disk 1.6 GB of 19.3 GB`, and a line near the top names the runner size it got and why. The jobs API returns the same as `usage` and `runner_size`.
2. **Keep CPU-heavy jobs on the large size.** It's the default, and automatic sizing keeps builds and test suites there. Pin it with `runs-on: diffinery-large` if you want to be sure (see [How runner sizing works](#how-runner-sizing-works)).
3. **Cache dependencies** with the `cache` input of the setup actions or with `actions/cache`, keyed on your lock file (see [Caching](#caching)).
4. **Use the toolchains the image has**, and let Go, Java and Docker start early (see [Setup actions and head starts](#setup-actions-and-head-starts)).
5. **Run jobs in parallel.** Split a long job into jobs that `needs` only what they depend on, and spread tests over a matrix (see [Matrices and parallel jobs](#matrices-and-parallel-jobs)).
6. **Stop runs nobody will look at.** Add a `concurrency` group that cancels a pull request's older runs, and path filters for changes that don't need CI (see [Cancel superseded runs](#cancel-superseded-runs)).
7. **Re-run only what failed.** **Re-run failed jobs** on the run page (or `diffinery run rerun <run-id> --failed`) runs the failed jobs and the jobs that depend on them, and keeps the rest from the earlier attempt without starting a runner. See [Re-run a run](/docs/actions/overview#re-run-a-run).

## How runner sizing works

Hosted runners come in four sizes. Every size runs the same Ubuntu 24.04 image, so a job behaves the same on each.

| Size | `runs-on` label | vCPU | Memory | Disk |
| --- | --- | --- | --- | --- |
| large (default) | `diffinery-large` | 4 | 12 GiB | 20 GB |
| medium | `diffinery-medium` | 2 | 8 GiB | 16 GB |
| small | `diffinery-small` | 1/2 | 4 GiB | 8 GB |
| tiny | `diffinery-tiny` | 1/4 | 1 GiB | 4 GB |

- **With a size label**, for example `runs-on: [ubuntu-latest, diffinery-small]`, the job gets that size (with several, the largest).
- **Without one**, the job gets **large**, unless its own last runs (at least 3 of up to 5) all fit a smaller size with room to spare, including room for bursts onto several cores and for slower hosts. A job that ran out of memory, failed, timed out or got slower on a smaller size goes back to large for its next 20 runs, and re-runs always run on large. So a smaller size is never the reason a job fails or slows down twice.
- **Smaller sizes are about cost, not speed.** A job that mostly waits (a deploy, API calls, polling) runs just as fast on a small machine and costs less. A job that computes is fastest on large.

Large is the biggest hosted size; there are no larger runners. See [Runner sizes](/docs/actions/runners#runner-sizes) and [What hosted jobs cost](/docs/actions/runners#what-hosted-jobs-cost-and-keeping-it-low).

## Caching

Diffinery's cache service works with the official `actions/cache` and with the built-in version, which downloads an archive in parallel ranges and extracts it while it arrives.

The simplest cache is the `cache` input of a setup action:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
    cache: pnpm
```

`actions/setup-python` takes `cache: pip` or `pipenv`, and `actions/setup-go` caches by default. For anything else, use `actions/cache` with a key that changes when your lock file does:

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.npm
    key: npm-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      npm-${{ runner.os }}-
```

Things that make caches hit more often:

- **Let the default branch save caches.** A run reads entries saved on its own ref, then (for pull requests) the base branch, then the default branch. Entries saved on one feature branch are never visible to another.
- **Include a hash of the lock file in the key.** Entries are immutable: a save with an existing key is skipped, so a key that never changes never refreshes.
- **Use `save-always: true`** if failing jobs should still save, since the post step saves only after a successful job by default.
- **Cache Docker layers** with `cache-from: type=gha` and `cache-to: type=gha` in `docker/build-push-action`, or with `type=registry` in the [container registry](/docs/packages/container-registry). `type=gha` in a plain `docker buildx build` step doesn't work, because `run:` steps don't get the cache service credentials.

Each repository keeps up to 10 GB of caches, and entries no job restored for 7 days are deleted. See [Caching and artifacts](/docs/actions/caching-and-artifacts).

## Setup actions and head starts

- **Node.js 22.22.0 and Python 3.12 are preinstalled.** When the version you ask `actions/setup-node` or `actions/setup-python` for is satisfied by them, the step uses them without a download. Any other version is downloaded each time.
- **Go and Java start installing as the job begins.** When a job has `actions/setup-go` (v4 to v6) or `actions/setup-java` (v2 to v5, `distribution: temurin`, a major version such as `java-version: 21`), and the version is written in the workflow or comes from `matrix`, `inputs` or `vars`, the runner downloads that toolchain while checkout runs. Versions read from a file (`go-version-file`, `java-version-file`) and jobs that run in a `container:` install the usual way, as the step runs.
- **Docker starts early for jobs that use it.** A job with `container:`, `services:`, a `docker://` action, or a step whose `uses:` or `run:` names `docker` gets the Docker daemon started in the background as the job begins. A `docker` command as the job's very first step waits for the daemon to finish starting.
- **Other toolchains** (Ruby, Rust, .NET, browsers) aren't in the image and install as their step runs, so cache what they download.

See [The Ubuntu 24.04 image](/docs/actions/runners#the-ubuntu-2404-image) and [Built-in actions](/docs/actions/compatibility#built-in-actions).

## Matrices and parallel jobs

Jobs without `needs` between them run at the same time, each in its own container, and a job starts as soon as the jobs it needs have finished. A matrix turns one job into several:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test -- --shard=${{ matrix.shard }}/4
```

- An account runs up to 20 hosted jobs at once by default, across all its repositories; further jobs wait in line, oldest first. If a large matrix often waits, cap it with `strategy.max-parallel`.
- A matrix may produce at most 256 jobs, and a run at most 1,000.
- With `fail-fast` (the default), one failed leg cancels its unfinished siblings, so you hear about a failure sooner.

See [strategy](/docs/actions/workflow-syntax#strategy) and [Limits](/docs/reference/limits).

## Cancel superseded runs

As on GitHub, a new push to a pull request doesn't cancel the run for the commit before it. Diffinery doesn't turn this on for you, because cancelling can cut off a deploy halfway or turn an older commit's checks into "cancelled". To opt in for pull requests only, add this to the workflow:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Older runs of the same pull request are cancelled when a new commit arrives, and runs on your default branch finish. A run on a protected branch is only ever cancelled by runs on that same branch. See [Concurrency](/docs/actions/overview#concurrency).

To skip runs entirely for changes that don't need them, use path filters on `push` and `pull_request`, for example `paths-ignore: ["docs/**", "**.md"]`. A job that doesn't run reports no check, and a required check that never reports shows as `required check '<name>' has not run`, so be careful with path filters on workflows whose checks are required. See [Path filters](/docs/actions/events#path-filters) and [Status checks](/docs/actions/overview#status-checks-on-commits-and-pull-requests).

## Measured numbers

From Diffinery's measurements on its production hosted runners on October 16, 2026 (see [How fast Diffinery Actions runs, measured](/performance) for the method). Ranges are wide because Cloudflare places containers on hosts whose cores differ about 2x in speed.

| Stage | Time |
| --- | --- |
| Push to first job running | 6 to 8 s |
| Job queued to first step | About 3 to 5 s |
| `actions/checkout` | 1 to 3 s |
| Restore a 216 MB pnpm cache | 3 to 4 s on fast hosts, about 10 s on the slowest |
| `pnpm install` from that cache | 3 to 7 s |
| Upload a 200 MB artifact | 7 to 9 s |
| `setup-python`, `setup-node` (preinstalled versions) | 0 s and 2 s |
| `setup-go`, `setup-java` (Temurin) | 1 to 3 s and 2 to 5 s |
| First `docker` command after checkout | 0.03 to 0.3 s |
| First `docker` command as a job's very first step | 1.4 to 2.3 s |

The same lint job (checkout, `npm ci`, eslint, prettier and `tsc` on 40 files) took 9 to 14 s on large, 10 to 13 s on medium, 13 to 14 s on small and 15 to 27 s on tiny. A job that only made ten REST requests took 4 seconds on both tiny and large. Diffinery's own pull requests run 10 required checks, including seven end-to-end suites, in about 3 minutes, and up to about 6 minutes on the slowest hosts.

## Frequently asked questions

### What hardware do Diffinery's hosted runners have?

By default, 4 vCPUs, 12 GiB of memory and 20 GB of disk, running Ubuntu 24.04 on x64 in a fresh container for each job. Smaller sizes (2, 1/2 and 1/4 vCPU) are picked per job from its own measured runs, or with a `diffinery-*` label.

### Does Diffinery cancel superseded workflow runs automatically?

No. As on GitHub, older runs keep running unless the workflow has a `concurrency` group with `cancel-in-progress`. Add one with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` to cancel older pull request runs and leave default-branch runs alone.

### Can I get a runner bigger than 4 vCPUs?

Not as a hosted runner: large (4 vCPU, 12 GiB) is the biggest size. For bigger machines, GPUs or long-lived caches, connect your own machine as a [self-hosted runner](/docs/actions/runners#self-hosted-runners).

### Why did my job get a smaller runner?

Its last runs all fit a smaller size with room to spare, so Diffinery picked it to save cost. The log's `Runner size:` line says which runs it was based on. If a smaller size ever makes the job fail or slower, it goes back to large for its next 20 runs. Pin `runs-on: diffinery-large` to keep it on large.
