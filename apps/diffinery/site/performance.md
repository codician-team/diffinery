---
title: How fast Diffinery Actions runs, measured
seo_title: "Diffinery Actions vs GitHub Actions: measured CI speed · Diffinery"
description: Measured job start, checkout, cache, install, Docker and toolchain times on Diffinery's hosted runners, next to GitHub's published runner specs.
updated: 2026-10-25
---

We measured every stage of typical CI jobs on Diffinery's live hosted runners on October 16, 2026, and set them next to GitHub's published runner specifications. Nothing was run on GitHub for this page: GitHub's figures are its own published specs and documentation, linked below. Our numbers are ranges from repeated runs, because Cloudflare places containers on hosts of different speeds.

## Summary

- **CPU-heavy jobs are faster.** A Diffinery job gets 4 vCPUs and 12 GiB of memory by default. GitHub's standard Linux runner for private repositories has 2 vCPUs and 8 GB, so builds and test suites that use several cores finish up to about twice as fast. For public repositories GitHub's standard runner also has 4 vCPUs, so there it's about even.
- **Jobs start in seconds.** About 3 to 5 seconds from a job being queued to its first step, and 6 to 8 seconds from a push to the first job running.
- **Setup steps are at or near parity.** Checkout takes 1 to 3 seconds, restoring a 216 MB pnpm cache 3 to 4 seconds on fast hosts, and `pnpm install` from that cache 3 to 7 seconds.
- **Where GitHub is still a little faster:** GitHub's image preinstalls Go, Java and a running Docker daemon. Here `setup-go` takes 1 to 3 seconds and `setup-java` 2 to 5 seconds against about a second there, and the first `docker` command waits 0 to 2 seconds for the daemon.

## Machine

| | Diffinery (default, large) | GitHub standard runner, private repository | GitHub standard runner, public repository |
| --- | --- | --- | --- |
| vCPU | 4 | 2 | 4 |
| Memory | 12 GiB | 8 GB | 16 GB |
| Disk | 20 GB | 14 GB SSD | 14 GB SSD |
| Architecture | x64 | x64 (arm64 available) | x64 (arm64 available) |
| Smaller sizes | 2, 1/2 and 1/4 vCPU, chosen per job from its own measured runs | 1 vCPU `ubuntu-slim` (15-minute job limit) | Same |

GitHub's figures are from [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), checked October 16, 2026. GitHub sells 4-core and larger Linux runners for private repositories on its Team and Enterprise plans, at twice the per-minute price of the 2-core runner ([runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)).

## Stage by stage: a typical Node.js CI job

Measured on Diffinery's large runner (4 vCPU) with the jobs of Diffinery's own CI and benchmark workflows:

| Stage | Diffinery | Notes |
| --- | --- | --- |
| Push to first job running | 6 to 8 s | From `git push` returning to the first job's first step. |
| Job start | About 3 to 5 s | A fresh container per job. |
| `actions/checkout` | 1 to 3 s | Built into the runner. |
| Restore a 216 MB pnpm cache | 3 to 4 s on fast hosts, about 10 s on the slowest | Downloads 16 ranges at once and extracts while it downloads. The whole `setup-node` step takes 5 to 10 s. |
| `pnpm install` from that cache | 3 to 7 s | |
| Upload a 200 MB artifact | 7 to 9 s | Blocks uploaded in parallel and joined as parallel parts. |
| `setup-python`, `setup-node` | 0 s and 2 s | Python 3.12 and Node.js 22 are preinstalled. |
| `setup-go`, `setup-java` (Temurin) | 1 to 3 s and 2 to 5 s | Installed while checkout runs, checked against the published SHA-256. GitHub preinstalls them, about 1 s. |
| First `docker` command after checkout | 0.03 to 0.3 s | The daemon starts as the job begins, only for jobs that use Docker. |
| First `docker` command as a job's very first step | 1.4 to 2.3 s | GitHub's daemon is already running: 0 s. |

## The same small job on every runner size

A lint job: checkout, `npm ci` (89 packages), eslint, prettier and `tsc` on 40 files, two runs per size.

| Size | vCPU | Whole job | `tsc` step |
| --- | --- | --- | --- |
| tiny | 1/4 | 15 to 27 s | 7 to 14 s |
| small | 1/2 | 13 to 14 s | 5 s |
| medium | 2 | 10 to 13 s | 2 to 3 s |
| large | 4 | 9 to 14 s | 2 to 4 s |

A job that only makes API calls (ten REST requests) took 4 seconds on both tiny and large. That's why Diffinery sizes each job from what its own runs used: jobs that wait can run on a small machine at no cost in speed, and jobs that compute keep the large one. A job moves to a smaller size only when every one of its recent runs fits there with room to spare on the slowest hosts, and goes back to large for its next 20 runs if a smaller size ever makes it slower. See [Runner sizes](/docs/actions/runners#runner-sizes).

## A real pipeline: Diffinery's own pull requests

Diffinery is developed on Diffinery. Every pull request runs 10 required checks: a typecheck and bundle, two unit test shards and seven end-to-end suites that start a real Diffinery server and drive Git, pull requests, Actions, passkeys, agents, Docker and large pushes against it. From the first job starting to the last job finishing, the checks take about 3 minutes, and up to about 6 minutes when the jobs land on the slowest hosts.

## Why it's fast

- **4 vCPUs by default**, so parallel test runners, bundlers and compilers have room.
- **The common actions are built into the runner.** `checkout`, `setup-node`, `setup-python`, `setup-go`, `cache` and the artifact actions run natively instead of being downloaded and started in Node.js for every job.
- **Head starts.** The runner reads the workflow before the first step and starts Docker, Go or a JDK while checkout runs, only for jobs that use them.
- **Parallel transfers.** Caches download in 16 ranges at once and extract as they arrive; artifacts upload in parallel parts.
- **A fresh machine per job.** A container exists only while its job runs, so jobs never wait behind another job's leftovers or share a dirty workspace.

## What isn't faster yet

- **Toolchains GitHub preinstalls.** Go, Java, Ruby, Rust, .NET and browsers are installed per job here. Go and Java get a head start; others install as the step runs. Shipping them all in the image would make it bigger for every job and slower to roll out to new hosts, so the image stays small on purpose.
- **Slow hosts.** Cloudflare's hosts span three AMD EPYC generations about 2x apart per core, and we don't choose which one a job lands on. The ranges above include them.
- **Linux x64 only.** There are no hosted macOS, Windows or Arm runners; use [self-hosted runners](/docs/actions/runners#self-hosted-runners) for those.

## How we measured

- All Diffinery numbers come from runs on the production hosted runners of diffinery.com, the instance Diffinery is developed on, on October 16, 2026, after the changes that produced them were deployed. Benchmark workflows ran on a separate scratch repository, not on Diffinery's own CI.
- Stage times are from step timestamps in job logs. Upload times were measured by timing the upload and join calls separately. Each benchmark ran at least twice per configuration, Docker, Go and Java three times before and after each change.
- GitHub's specs and prices are from GitHub's documentation, read on October 16, 2026. We did not run benchmarks on GitHub.
- Results depend on your workflow. If you run your own Diffinery instance ([Deploy your own Diffinery](/docs/self-hosting/deploy)) with your own workflows, every job's log ends with what it used (busy cores, peak memory and disk) and names the runner size it got.

See also: [Diffinery vs GitHub](/compare/github) and [Runners](/docs/actions/runners).
