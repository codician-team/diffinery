---
title: GitHub runners
description: Keep your code on GitHub and run its Actions jobs on Diffinery's hosted runners: install the app, link the account that pays, and set runs-on to diffinery.
updated: 2026-10-31
---

You don't have to move your code to use Diffinery's runners. Keep your repositories and workflows on GitHub, install Diffinery's GitHub App, and change a job's `runs-on` to `diffinery`. The job then runs on a Diffinery hosted runner (a fresh Ubuntu 24.04 container with 4 vCPUs on Cloudflare) instead of a GitHub-hosted one. Logs, checks, caches, artifacts and `GITHUB_TOKEN` stay on GitHub, as with any self-hosted runner.

## How it works

1. GitHub tells Diffinery about each queued job of a repository where the app is installed (the `workflow_job` webhook).
2. If the job's `runs-on` asks for a Diffinery runner, Diffinery checks the hosted minutes and hosted jobs of the Diffinery account you linked, then registers a [just-in-time runner](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/autoscaling-with-self-hosted-runners#using-just-in-time-runners) for that one job in the repository.
3. Diffinery starts a hosted runner container. It runs GitHub's own runner ([actions/runner](https://github.com/actions/runner)), which takes the job, runs it and reports to GitHub.
4. When the job ends, the runner removes itself from GitHub and the container stops. Nothing carries over to the next job.

Because GitHub's own runner runs the job, everything a GitHub workflow does works the same way: `uses:` actions, service containers, `actions/cache`, artifacts, OIDC, environments and required reviewers, concurrency and re-runs.

## Set it up

You need a Diffinery account, and on GitHub you must be able to install apps on the user or organization (an organization owner, or the owner of a personal account).

1. Open **Settings → GitHub runners**.
2. Under **Connect GitHub**, pick the **Account that pays**: yourself, or a Diffinery organization you own or administer. Its hosted minutes pay for the jobs.
3. Click **Install on GitHub**. On GitHub, pick the user or organization, and **All repositories** or the repositories that should use Diffinery runners, then click **Install**.
4. GitHub asks you to authorize the app: click **Authorize**. This shows Diffinery which installations your GitHub account can manage; Diffinery doesn't keep the token.
5. You're back on **Settings → GitHub runners**, with the installation listed under the account that pays.

If the app is already installed (for example, someone else installed it), click **Link an existing installation** instead. After you authorize the app, Diffinery lists the installations your GitHub account can manage. Pick one and the account that pays, and click **Link**. Linking an installation that is linked to another Diffinery account moves it.

To change which repositories can use Diffinery runners later, click **Choose repositories on GitHub** next to the installation.

## Use it in a workflow

Set `runs-on` to a Diffinery label:

```yaml
jobs:
  test:
    runs-on: diffinery          # 4 vCPU, 12 GiB of memory
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test
  lint:
    runs-on: diffinery-small    # 1/2 vCPU, 4 GiB of memory
    steps:
      - uses: actions/checkout@v4
      - run: npm run lint
```

| `runs-on` | Runner |
|---|---|
| `diffinery` or `diffinery-large` | large: 4 vCPU, 12 GiB of memory, 20 GB of disk |
| `diffinery-medium` | medium: 2 vCPU, 8 GiB, 16 GB |
| `diffinery-small` | small: 1/2 vCPU, 4 GiB, 8 GB |
| `diffinery-tiny` | tiny: 1/4 vCPU, 1 GiB, 4 GB |

Rules:

- A job is for Diffinery when its labels include `diffinery` or `diffinery-<size>`, and every other label is one of `self-hosted`, `linux` or `x64`. With several sizes, the largest wins. `runs-on: [self-hosted, linux, diffinery]` works.
- Any other label (`ubuntu-latest`, `gpu`, `arm64`, a runner group) leaves the job to GitHub: Diffinery starts no runner for it.
- Jobs without a Diffinery label keep running on GitHub-hosted runners, so you can move one job at a time.
- Diffinery doesn't pick a smaller size by itself for GitHub jobs, as it does for [jobs of Diffinery repositories](/docs/actions/runners#runner-sizes): the label sets the size.
- Matrix legs each get their own runner.

### Switch a whole repository with one variable

To move every job at once, and to be able to move them back without a commit, read the label from a repository variable:

```yaml
    runs-on: ${{ vars.RUNS_ON || 'ubuntu-latest' }}
```

Then set the variable to `diffinery` (`gh variable set RUNS_ON --body diffinery`). Setting it back to `ubuntu-latest` returns the jobs to GitHub-hosted runners, for example to keep a deploy working while Diffinery can't start runners. Forks without the variable keep running on GitHub. Diffinery's own repository does this with `DIFFINERY_RUNS_ON`.

## The machine

The container runs the same image as Diffinery's own [hosted runners](/docs/actions/runners#hosted-runners): Ubuntu 24.04 on x64 with Git, Node.js 22, Python 3.12, Docker, the GitHub CLI and `/dev/kvm`. Differences from a GitHub-hosted runner:

- The image is much smaller than GitHub's: Go, Java, Ruby, Rust, .NET, browsers and cloud CLIs aren't preinstalled. The `actions/setup-*` actions install them. See [The Ubuntu 24.04 image](/docs/actions/runners#the-ubuntu-2404-image).
- Jobs run as `root` (`RUNNER_ALLOW_RUNASROOT=1`). `sudo` needs no password, as on GitHub.
- The workspace is under `/opt/actions-runner/_work`; use `GITHUB_WORKSPACE` rather than a fixed path.
- `runner.environment` is `self-hosted` and the runner's name is `diffinery-<id>-<try>`.
- On instances that set [`EGRESS=web`](/docs/self-hosting/configuration#egress), jobs reach only HTTP, HTTPS and DNS.

## What it costs, and limits

GitHub jobs on Diffinery runners count exactly like hosted jobs of the linked account's own repositories (see [Limits](/docs/reference/limits#account-quotas)):

- Their running time counts against the account's **hosted minutes** for the month, from the moment the container starts until it stops.
- They count against the account's **hosted jobs at once**. Further jobs wait, oldest first, and start as running ones finish. **Settings → GitHub runners** shows them as **waiting**, with the reason.
- When the account has used its hosted minutes for the month, new jobs aren't started: they show as **failed** with the reason, and stay queued on GitHub until GitHub gives up on them (after 24 hours) or you cancel them. Switch `runs-on` back to `ubuntu-latest` to run them on GitHub.
- A job runs for at most 6 hours.

GitHub doesn't charge minutes for jobs on self-hosted runners, which is what Diffinery runners are to GitHub.

## See what ran

**Settings → GitHub runners** lists the last 30 runners of each account you manage, newest first, with the job (linked to its log on GitHub), the size, how long it ran and a status:

| Status | Meaning |
|---|---|
| waiting | The job waits for a hosted slot of the account, or for GitHub to register its runner again. |
| starting | The runner is registered and its container is starting, or it waits for GitHub to hand it the job. |
| running | GitHub handed the runner a job. |
| done | The container stopped. The GitHub job's conclusion is shown under it. |
| skipped | The job ended before its runner started (cancelled, or run by a runner that isn't one of this account's Diffinery runners), or the installation was suspended or unlinked. |
| failed | No runner was started: the reason is shown, such as a kill switch, minutes used up, or GitHub refusing to register a runner. |

GitHub hands a runner any queued job of the repository whose labels it has, so a runner may run a different queued job with the same labels instead of the one it was started for. Each queued job still gets one runner: the runner's row then shows the job it ran, and the job it was started for waits for the next runner, in its place in line, with its own labels and size.

## Security

- Each job gets a new container and a new just-in-time runner, registered in that one repository for that one job. Nothing of one job, not even the runner's credentials, is there for the next.
- The just-in-time configuration is the runner's credential. Diffinery passes it only to the container's environment, removes it from the job's environment, and never stores or logs it.
- The app asks for these repository permissions: **Administration: Read and write**, which GitHub requires to register and remove a repository's self-hosted runners; **Actions: Read** and **Metadata: Read**. It never reads your code.
- Only a person signed in with a passkey can link or unlink an installation, and only for themselves or an organization they own or administer; GitHub must confirm they can manage the installation. Linking and unlinking are in the [audit log](/docs/security/audit-log) as `github_runners.link` and `github_runners.unlink`.
- **Public repositories:** anyone who opens a pull request can change a workflow, and a workflow that runs on `diffinery` uses the linked account's minutes. Under the repository's **Settings → Actions → General**, require approval for fork pull request workflows from outside contributors (for example **Require approval for all external contributors**), as GitHub advises for any self-hosted runner.
- A site administrator's [kill switches](/docs/admin/site-administration#kill-switches) apply: suspending an account's Actions, or pausing hosted compute, fails the waiting jobs and stops the running runners.

## Unlink or uninstall

- **Unlink** on **Settings → GitHub runners** stops new runners for the installation. Jobs that wait get none; runners already started finish their jobs.
- Uninstalling the app on GitHub (in the user's or organization's settings, under **GitHub Apps** or **Applications → Installed GitHub Apps**) unlinks it too.
- Suspending the app on GitHub starts no runners until you unsuspend it.

## Troubleshooting

**The job stays queued on GitHub with "Waiting for a runner to pick up this job".** Check, in this order:

1. The job's labels: every one must be `diffinery`, `diffinery-<size>`, `self-hosted`, `linux` or `x64`.
2. The repository is among the installation's repositories (**Choose repositories on GitHub**).
3. The installation is linked: it is listed on **Settings → GitHub runners**.
4. The job's row on **Settings → GitHub runners** and its message.

**"Could not register a runner on GitHub: ... Resource not accessible by integration".** The app lacks the **Administration: Read and write** permission on the repository. An owner of the GitHub account reviews and accepts the app's new permissions in the installation's settings on GitHub (**Choose repositories on GitHub** opens them).

**"No job took this runner within 10 minutes".** The job it was started for was cancelled, or ran on another runner with the same labels, and GitHub had no other job for it. This also happens, rarely, when a job is cancelled just as the runner started for it takes a different queued job: Diffinery then starts one more runner for the cancelled job. Diffinery stopped the runner and removed it from GitHub; nothing to do.

**"The runner stopped before it took a job (exit code N); starting another".** GitHub's runner exited before a job started, for example because GitHub was unreachable. Diffinery tries up to 3 runners for a job.

**"The runner's container stopped before it took a job; starting another".** The runner's container stopped without an error before GitHub handed it a job, for example because Cloudflare lost the machine it ran on. GitHub still had the job queued, so Diffinery started another runner for it. As with a runner that exited with an error, Diffinery tries up to 3 runners for a job.

**Settings → GitHub runners says "This Diffinery has no GitHub App".** The instance's administrator hasn't set the app up. See [Configuration](/docs/self-hosting/configuration#github-runners).
