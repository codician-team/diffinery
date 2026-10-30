---
title: Runners
description: Where workflow jobs run: hosted Linux runners in Cloudflare Containers (sizes, limits, late starts, restarts after a runner is replaced) and self-hosted runners via diffinery runner.
---

A runner is the machine that executes one workflow job. Diffinery offers two kinds: **hosted runners**, which run each job in a fresh Ubuntu 24.04 container on Cloudflare, and **self-hosted runners**, which run jobs on a machine you control (a Mac, a GPU box, a server on a private network) using the `diffinery runner` command. You pick one per job with `runs-on`, the same key GitHub Actions uses.

Repositories that stay on GitHub can use the same hosted runners too: see [GitHub runners](/docs/actions/github-runners).

## How runs-on picks a runner

Diffinery reads the job's `runs-on` labels (case-insensitive) and decides:

1. If any label is `self-hosted`, the job waits for a self-hosted runner that offers **every** label in `runs-on`. See [Self-hosted runners](#self-hosted-runners).
2. Otherwise, if every label is one Diffinery hosts, the job runs on a hosted runner.
3. Otherwise the job fails at once with:

```text
No Diffinery runner matches runs-on: windows-latest. Linux (ubuntu-*) runners are hosted; anything else needs runs-on: [self-hosted, ...] and a registered runner.
```

| Label in `runs-on` | Runs on |
|---|---|
| `ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04`, or any other `ubuntu-*` label | Hosted runner (always the same Ubuntu 24.04, x64 image) |
| `linux` | Hosted runner |
| `x64`, `amd64` | Hosted runner |
| `diffinery`, or any `diffinery-*` label | Hosted runner |
| `self-hosted` (plus any labels you add) | A self-hosted runner offering all the labels |
| Anything else, for example `windows-latest`, `macos-latest`, `macos-14`, `gpu` without `self-hosted` | The job fails with the message above |

Things to know:

- Every `ubuntu-*` label gets the same Ubuntu 24.04 x64 image, including `ubuntu-22.04` and labels that ask for Arm, such as `ubuntu-24.04-arm`.
- `runs-on` can be a string, a list, or a mapping with `labels`. A `group` in the mapping form is ignored; only `labels` count.
- `runs-on` is evaluated for each matrix combination, so an entry can be an expression using `github`, `inputs`, `vars`, `needs`, `matrix` and `strategy`. An expression can give one label or a list of labels. Empty and `null` values are dropped.
- If evaluating `runs-on` fails, only that matrix combination fails, with `Error evaluating the job for this matrix combination: <message>`. If no labels are left, the job fails with `No Diffinery runner matches runs-on: (no labels). ...`.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest        # hosted
    steps:
      - run: echo "hosted"
  build:
    strategy:
      matrix:
        target: [linux, macos]
    # The linux leg runs on a hosted runner; the macos leg waits for a
    # self-hosted runner with the macos label.
    runs-on: ${{ matrix.target == 'macos' && fromJSON('["self-hosted","macos"]') || 'ubuntu-latest' }}
    steps:
      - run: uname -a
  gpu:
    runs-on: [self-hosted, linux, gpu]   # waits for a runner started with --labels linux,gpu
    steps:
      - run: nvidia-smi
```

## Hosted runners

Each job on a hosted runner gets its own container on [Cloudflare Containers](https://developers.cloudflare.com/containers/), started for that job and thrown away when it finishes. Nothing carries over between jobs except what you save with caches and artifacts (see [Caching and artifacts](/docs/actions/caching-and-artifacts)).

### Machine

| Property | Value |
|---|---|
| Platform | Cloudflare Containers. A large runner (instance type `standard-4`) has 4 vCPU, 12 GiB of memory and 20 GB of disk; see [Runner sizes](#runner-sizes) for the smaller ones |
| Architecture | `linux/amd64` (`runner.arch` is `X64`) |
| Operating system | Ubuntu 24.04 (`runner.os` is `Linux`) |
| User | `root`. `sudo` is installed and needs no password, so `sudo apt-get install ...` works as on GitHub |
| Virtualization | `/dev/kvm` is available, for the Android emulator, QEMU and other KVM tools. See [Hardware virtualization (KVM)](#hardware-virtualization-kvm) |
| Network | Outbound internet access (only HTTP and HTTPS on instances that set [`EGRESS=web`](/docs/reference/limits#egress)); no inbound connections |
| Workspace | `/workspace/<repository name>` (`GITHUB_WORKSPACE`) |
| Temp directory | `/workspace/_temp` (`RUNNER_TEMP`) |
| Tool cache | `/opt/hostedtoolcache` (`RUNNER_TOOL_CACHE`, `AGENT_TOOLSDIRECTORY`) |
| Locale | `LANG=C.UTF-8`, `LC_ALL=C.UTF-8` |
| Concurrency | Up to 20 hosted jobs at once per account by default, across all its repositories, like GitHub's Free plan; further jobs stay queued and start, oldest first, as running ones finish. See [Limits](/docs/reference/limits) |

### Runner sizes

Hosted runners come in four sizes. Every size runs the same image, so a job behaves the same on each; only the machine differs.

| Size | `runs-on` label | vCPU | Memory | Disk | Cloudflare instance type |
|---|---|---|---|---|---|
| large | `diffinery-large` | 4 | 12 GiB | 20 GB | `standard-4` |
| medium | `diffinery-medium` | 2 | 8 GiB | 16 GB | `standard-3` |
| small | `diffinery-small` | 1/2 | 4 GiB | 8 GB | `standard-1` |
| tiny | `diffinery-tiny` | 1/4 | 1 GiB | 4 GB | `basic` |

A job with one of these labels in `runs-on` gets that size (with several, the largest): `runs-on: [ubuntu-latest, diffinery-small]`, or the label alone. A job without one gets **large**, unless its own earlier runs show a smaller size serves it just as well. That's how Diffinery keeps hosted minutes cheap: Cloudflare bills a container's memory and disk for what its size provides, used or not, so a deploy job that waits on another service for a minute costs a large runner's memory for that minute.

How a size is picked for a job without a label:

- The runner measures every hosted job: busy cores, memory and disk in use every quarter second, and processes the kernel killed for want of memory. The last lines of the job's log say what it used, for example `Resources: 0.1 of 4 vCPUs busy on average (0.3 at the 95th percentile), peak memory 0.3 GiB of 12.0 GiB, peak disk 1.6 GB of 19.3 GB`. The job API (`GET /repos/{owner}/{repo}/actions/jobs/{job_id}`) returns it as `usage`, and the size as `runner_size`.
- The next run of the same job (the same workflow file and job name, so each matrix leg on its own) looks at up to its last 5 runs, and needs at least 3. It gets a smaller size only if every one of them would have fit it with room to spare: peak memory times 1.5, plus 0.5 GiB, and peak disk times 1.25, plus 1 GB, within the size; and at least half as many vCPUs again as the job kept busy in its busiest quarter second, so a job that bursts onto several cores even briefly, such as a test suite, keeps a runner with room for that. Busy cores count as on the slowest host processor runners land on: Cloudflare's hosts mix AMD EPYC generations whose cores differ about 2x in speed, so a job measured on a fast host gets cores to spare for a slow one (a run whose host processor isn't known counts as on the fastest). A job that kept its runner's CPU busy to the limit never gets a smaller size than that one.
- A job stays on large when it has no measured runs yet, when one of those runs ran out of memory, when one failed or timed out on a smaller size, or when one took longer on a smaller size than the job takes on large allowing for its own run-to-run noise there: more than a tenth plus 2 seconds over the median of its large runs (on the same host processor where there is one), and slower than all but one of its last ten large runs. A job whose earlier runs were measured before quarter-second measuring (October 16, 2026) is sized again from new runs. After a smaller size ran a job out of memory, failed it or slowed it, the job stays on large for its next 20 runs, so it doesn't move back and forth. A re-run always runs on large, and so does a job that found no smaller runner free when it first started. So a smaller size is never the reason a job fails or slows down twice.
- The job's log names the size it got and why, near the top: `Runner size: tiny (0.25 of a vCPU, 1 GiB of memory, 4 GB of disk), sized by this job's last 5 runs (peak memory 0.3 GiB)`.

Set `runs-on: diffinery-large` to keep a job on large whatever it uses.

### What hosted jobs cost, and keeping it low

A hosted runner exists only while its job runs: Diffinery starts a fresh container when the job starts and stops it when the job ends, and Cloudflare bills it by the 10 milliseconds, with no rounding up to whole minutes. Its memory and disk are billed for what the size provides, and its CPU for what the job uses. Nothing runs or bills between jobs.

What that means for your workflows:

- **CPU-bound jobs** (builds, test suites) are best on large, where they finish fastest; their cost follows the CPU they use, so a faster machine costs about the same per job. Automatic sizing keeps them there.
- **Jobs that wait** (deploys, API calls, polling, `sleep`) pay mostly for memory. If you know a job waits, pin a size: `runs-on: [ubuntu-latest, diffinery-small]` costs about a third of large per minute and `diffinery-tiny` about a tenth. Automatic sizing moves a job only when its own measured runs leave room to spare even on the slowest hosts. A job that checks out and then calls an API and waits typically moves to medium after its third measured run, about a third less per minute at the same speed; steps such as `actions/setup-node` or installing a CLI keep a core busy for a few seconds, which keeps a job on large. Pin a size to go further.
- **Superseded runs** keep running unless the workflow says otherwise, as on GitHub: a new push to a pull request doesn't cancel the run for the commit before it. To stop paying for runs nobody will look at, cancel them with a concurrency group per workflow and branch:

  ```yaml
  concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: ${{ github.event_name == 'pull_request' }}
  ```

  This cancels a pull request's older runs when a new commit arrives, and leaves runs on your default branch (such as deploys) to finish. It isn't on by default, because cancelling a run can cut off a deploy halfway or turn an older commit's checks into "cancelled". See [concurrency](/docs/actions/workflow-syntax#concurrency).

### The Ubuntu 24.04 image

The hosted image is built from `containers/runner/Dockerfile` in the Diffinery source. It is deliberately small. This is the complete list of what is preinstalled:

| Group | Installed |
|---|---|
| Base tools | `ca-certificates`, `curl`, `git`, `git-lfs`, `jq`, `zip`, `unzip`, `xz-utils`, `tar`, `gzip`, `zstd`, `sudo`, `pkg-config`, `openssh-client`, `gnupg` |
| GitHub CLI | `gh`, from GitHub's apt repository |
| Build tools | `build-essential` (gcc, g++, make and the C library headers) |
| Libraries for Ruby and native extensions | `libyaml-dev`, `libssl-dev`, `libffi-dev`, `zlib1g-dev`, `libreadline-dev`, `libgmp-dev`, so `ruby/setup-ruby`'s prebuilt Rubies run and gems with C extensions build |
| Python | Ubuntu's `python3` (3.12), `python3-pip`, `python3-venv`, `python-is-python3` (so `python` runs `python3`) |
| Node.js | Node.js 22.22.0 with npm, plus corepack shims activated for pnpm 10.28.0 and yarn 1.22.22; nvm 0.40.7 in `/usr/local/nvm` (`NVM_DIR`), loaded in login shells such as `shell: bash -l {0}`, as on GitHub |
| Docker | Docker Engine (`docker-ce`), the Docker CLI, `containerd.io`, the Buildx plugin, the Compose plugin, `iptables` |

Image settings that affect your steps:

- `git config --system safe.directory '*'` is set, and Git LFS is installed system-wide.
- `PIP_BREAK_SYSTEM_PACKAGES=1` is set, so `pip install` works without a virtual environment, as on GitHub's hosted runners.
- `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` is set, so corepack never stops to ask.
- `ImageOS=ubuntu24` and `ImageVersion=20250101.1` are set, as on GitHub's `ubuntu-24.04` image. `actions/setup-go` and `actions/setup-python` include them in their cache keys.
- `zstd` is installed, so `actions/cache` compresses with zstd, as on GitHub.
- The apt package lists are removed to keep the image small. Run `apt-get update` before `apt-get install`.

Anything else (Go, Java, Ruby, Rust, .NET, PowerShell, browsers, cloud CLIs) is **not** preinstalled. Install it in a step:

```yaml
steps:
  - uses: actions/setup-go@v5          # downloads Go from go.dev
    with:
      go-version: "1.23"
  - run: apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless
  - run: pip install awscli
```

`actions/setup-node`, `actions/setup-python` and `actions/setup-go` use the preinstalled Node.js or Python when its version satisfies the one you ask for, and download the version otherwise. See [Compatibility with GitHub Actions](/docs/actions/compatibility) for their supported inputs.

**Go and Java start installing as the job begins.** When a job has an `actions/setup-go` step (v4 to v6) or an `actions/setup-java` step (v2 to v5, `distribution: temurin`, a major version such as `java-version: 21`), and the version is written in the workflow or comes from `matrix`, `inputs` or `vars`, the runner starts downloading and extracting that toolchain as the job begins, while earlier steps such as checkout run. The setup step then finds it in the tool cache instead of downloading it. If it's still being installed when the step starts, the step logs `Waiting for Go 1.23, which the runner started installing as the job began` and continues once it's there. The runner installs the same release the action would pick, checks it against its published SHA-256, and puts it where the action looks (`setup-java` reports `Resolved Java ... from tool-cache`, as it does on GitHub's runners), so nothing else about the step changes. Jobs without these steps don't pay for any of this. Versions read from a file (`go-version-file`, `java-version-file`), other Java distributions, and jobs that run in a `container:` install the usual way.

> **Note:** Jobs run as `root`, and `sudo` runs commands without asking for a password, as on GitHub's runners. The image ships without apt package lists, so run `sudo apt-get update` before `sudo apt-get install ...`.

### Hardware virtualization (KVM)

Hosted runners have `/dev/kvm`, so jobs can start virtual machines with hardware acceleration: the Android emulator, QEMU with `-enable-kvm`, Firecracker and other KVM tools. Jobs run as `root`, so `/dev/kvm` is usable without changing its permissions.

For Android emulator tests with `reactivecircus/android-emulator-runner`, two things differ from GitHub's image:

- **Leave out the "Enable KVM" step** that writes `/etc/udev/rules.d/99-kvm4all.rules` and runs `udevadm`. The image has no udev, so that step fails with `tee: /etc/udev/rules.d/99-kvm4all.rules: No such file or directory`, and it isn't needed when the job runs as root.
- **Install the emulator's libraries** before it starts. GitHub's image has them; this one doesn't, and without them the emulator exits with `error while loading shared libraries: libX11.so.6`.

```yaml
jobs:
  android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 17
      - uses: android-actions/setup-android@v3
        with:
          packages: platform-tools
      - name: Emulator libraries
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y -qq --no-install-recommends libx11-6 libx11-xcb1 libxcb1 libpulse0 libgl1 libegl1 libnss3 \
            libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 libxrandr2 libxkbfile1 libasound2t64 libdbus-1-3 \
            libxkbcommon0 libxkbcommon-x11-0 libxcb-cursor0 libfontconfig1 libfreetype6
      - uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 30
          arch: x86_64
          script: ./gradlew connectedCheck
```

Measured on 2026-10-26 on a large hosted runner: an Android 11 (API 30, x86_64) emulator booted in 37 seconds, and `emulator -accel-check` reported `KVM (version 12) is installed and usable.` Installing the libraries took about 17 seconds. `packages: platform-tools` keeps `setup-android` from asking for the old `tools` package, which its default list includes and which the current SDK no longer has (`Warning: Failed to find package 'tools'`).

### Docker on hosted runners

Docker works on hosted runners the same way as on GitHub's: job containers, service containers, Docker container actions, and `docker build`, `docker run` and `docker compose` in `run:` steps. Details:

- **Started on first use.** The `docker` command is a wrapper that starts the Docker daemon the first time anything in the job needs it (a `docker` command in a step, a job `container:`, `services:`, or a Docker action). The first use prints `Starting the Docker daemon` and takes about 1 to 2 seconds (the daemon and the registry relay below start together); jobs that never touch Docker don't pay for it. A job that will use Docker (a job `container:`, `services:`, a `docker://` action, or a step whose `uses:` or `run:` names `docker`) gets the daemon started in the background as the job begins, so those seconds overlap checkout and setup. Docker commands that arrive while the daemon is starting wait for it. If the daemon can't start, or another command has been starting it for over 2 minutes, the step fails with `The Docker daemon did not start:` followed by the end of the daemon's log, rather than waiting until the job's timeout.
- **Docker Hub through `mirror.gcr.io`.** The daemon uses `https://mirror.gcr.io` as its registry mirror, so pulls of Docker Hub images (`redis:7-alpine`, `postgres:16`) usually come from Google's public mirror and avoid Docker Hub's anonymous rate limits. Images the mirror doesn't have are pulled from Docker Hub as usual.
- **DNS.** The daemon gives containers the DNS servers `1.1.1.1` and `8.8.8.8`.
- **Pushing to the Diffinery registry.** The daemon and BuildKit builders reach `diffinery.com` through a local relay that splits image layer uploads into chunks, so layers larger than Cloudflare's 100 MB request limit push from hosted workflows. See [Container registry](/docs/packages/container-registry).
- **Buildx builders.** `docker buildx create` with the `docker-container` driver (which `docker/setup-buildx-action` runs) is handled by the wrapper: it starts the BuildKit container on the host network and registers it as a remote builder, because the normal driver can't work inside a Cloudflare Container. `docker buildx rm` removes it.

The full guide is [Docker in workflows](/docs/actions/docker).

### Environment variables

Hosted and self-hosted runners set the GitHub-compatible variables (`CI=true`, `GITHUB_ACTIONS=true`, `GITHUB_REPOSITORY`, `GITHUB_SHA`, `GITHUB_REF`, `GITHUB_WORKSPACE`, `GITHUB_ENV`, `GITHUB_OUTPUT`, and so on) plus `DIFFINERY=true`. `GITHUB_SERVER_URL` is `https://diffinery.com` and `GITHUB_API_URL` is `https://diffinery.com/api/v3`. `RUNNER_NAME` is `diffinery` and `RUNNER_ENVIRONMENT` is `diffinery-hosted` on every runner. Workflows can override `CI` and `DIFFINERY`, but not `GITHUB_*` or `RUNNER_*` variables.

Other variables a job gets:

- `ImageOS` and `ImageVersion`, on hosted and self-hosted runners alike (`ubuntu24` and `20250101.1` unless the runner's environment sets them).
- `RUNNER_DEBUG=1` when the secret or variable `ACTIONS_STEP_DEBUG` or `ACTIONS_RUNNER_DEBUG` is `true`. See [Expressions and contexts](/docs/actions/expressions#default-environment-variables).
- `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RUNTIME_URL`, `ACTIONS_RESULTS_URL`, `ACTIONS_CACHE_URL` and `ACTIONS_CACHE_SERVICE_V2`, but only in JavaScript actions, Docker container actions and the built-in actions, never in `run:` steps. They let actions such as `actions/cache` and `actions/upload-artifact` use the cache and artifact services. See [Caching and artifacts](/docs/actions/caching-and-artifacts#the-runtime-services).

### Limits and timeouts

| Limit | Value | What happens |
|---|---|---|
| Job timeout | `timeout-minutes`, default 360 minutes, and values above 360 are capped at 360 | The job fails with "The job running on runner has exceeded the maximum execution time of N minutes." |
| Total wait per job | 6 hours from when the job is scheduled, including time spent waiting for a runner | The job fails with "The job exceeded its timeout of N minutes." |
| Step timeout | `steps[*].timeout-minutes`, no default | The step fails with "The step has timed out after N minutes." |
| Runner that stops responding | 10 minutes past the job timeout | The runner ends a job at its timeout itself and reports within seconds. If it hasn't reported 10 minutes later (its agent froze or its machine vanished), Diffinery stops the container and the job fails as timed out with "The job exceeded its timeout of N minutes, and its runner stopped responding: Diffinery ended it 10 minutes later." So a stuck runner holds a hosted container, a slot of the account's hosted jobs and its minutes for at most the job's timeout plus 10 minutes. Set `timeout-minutes` on jobs that should never run long. |
| Matrix size | 256 jobs per matrix | The job fails with "A matrix may produce at most 256 jobs." |
| Log line length | 16,384 characters | Longer lines are cut and end with `…` |
| Log size | 16 MiB of text per job | The log ends with "The log is cut off here: a job's log is limited to 16 MiB of text." Later lines are dropped; the job keeps running. |
| Platform updates | A deploy is set up not to replace the container of a running job, so running jobs normally finish on the version they started with. The platform doesn't guarantee it, though. If it replaces a container anyway, its stop signal reaches the running step too. The same goes when the platform stops or loses a job's container without warning (it ends with no exit code, for example when its host fails). Diffinery then starts the job again from the beginning on a new runner, up to twice, if no step but `actions/checkout` had started or if the job can only read: it uses no secrets (other than `GITHUB_TOKEN`), no deployment environment, and its token can't write. What the stopped attempt uploaded (artifacts, caches) is dropped first, as a re-run would. A job that could change something outside the run fails instead once another step has started, because running that step twice could repeat what it did (a deploy, a publish). Re-run it from the run page | The log shows "The platform is stopping this runner" and, on the step, "The platform stopped this step's processes while stopping the runner." A restarted job's log starts over with "Diffinery started the job again from the beginning on a new runner (restart N of 2)". A failed one says "The platform replaced this job's runner with a new version while step … ran" when a deploy replaced it (the runner was on an older image), or "The platform stopped this job's container while step … ran" when it ran the deployed image (or, after the third replacement, "… 3 times") |

If the container stops unexpectedly (for example it runs out of memory), the job fails with `The runner stopped unexpectedly (exit code N).` A container that stops before its runner fetched the job is replaced instead, since no step ran.

The log's first lines name where the job ran, for example `Runner: image diffinery-runner:96dbbe31790f, in fra06, EEUR, container 6f1c…`. On hosted runners a `Host:` line names the host's processor (Cloudflare's hosts mix AMD EPYC generations, so the same job can run up to about twice as fast on one host as on another), and the line before the job's conclusion says how much of the vCPUs' time the host gave to other work (steal). The jobs API returns the same as `runner` (`image`, `location`, `instance`, and `cpu` on hosted runners), next to `runner_name`. `GET /meta` names the image the last deploy set as `runner_image`. While a deploy's rollout is updating instances, a new container can still start on the previous image. Diffinery turns that runner away before it runs anything and starts the job again on another container (after 30 s, then 1, 2 and 4 minutes). After four tries, the job runs on whatever image it got rather than wait for a rollout that has stalled. The jobs API's `placementTries` counts the times a job went back in line before a runner took it (each time, the job's log gets a line saying why: no machine was free, the container stopped before the runner started, or a runner on the previous image was turned away), and `restarts` counts the times it started again because the platform replaced its runner.

### Windows and macOS

Cloudflare Containers run Linux only, so Diffinery has no Windows or macOS hosted runners. `runs-on: windows-latest` or `runs-on: macos-latest` fails with the "No Diffinery runner matches runs-on" message. For macOS builds, Windows-specific tooling or GPUs, use a [self-hosted runner](#self-hosted-runners) on your own machine with `runs-on: [self-hosted, ...]`.

## Self-hosted runners

A self-hosted runner is the `diffinery runner` command running on a machine you control. It polls one or more repositories for waiting jobs whose `runs-on` includes `self-hosted`, claims one, runs it with the Diffinery runner agent (the same program that runs inside hosted containers), streams the logs to Diffinery, and reports the result. Use it for:

- **macOS**: build and sign iOS or macOS apps with Xcode on a Mac.
- **GPUs**: run CUDA tests or model evaluation on a machine with a GPU.
- **Private networks**: deploy to or test against servers that Cloudflare can't reach (a database behind a VPN, an on-premises cluster).
- **Long-lived caches and big toolchains**: the runner's work directory and tool cache persist between jobs.

### Requirements

- **Node.js 22 or later** on the machine.
- **The `diffinery` CLI.** Install it with:

  ```sh
  curl -fsSL https://diffinery.com/install | bash
  ```

- **The runner agent**, a single Node.js file named `agent.mjs`. Build it from a checkout of the Diffinery source:

  ```sh
  pnpm install
  pnpm --filter @diffinery/runner build      # produces containers/runner/dist/agent.mjs
  ```

  Copy `containers/runner/dist/agent.mjs` to the runner machine (for example to `/opt/diffinery/agent.mjs`) and pass it with `--agent` or the `DIFFINERY_RUNNER_AGENT` environment variable.
- **A registration token** for each repository the runner serves, from a person with the **admin** role on it. A registration token works for an hour, and the runner trades it for its own **runner token**, which can claim that repository's jobs and do nothing else. Agents, job tokens and people without admin can't create one (`403 only repository admins can add self-hosted runners`).
- **Bash** (the default shell for `run:` steps; `sh` is used when bash is missing), `git` and `tar`, which the built-in actions use.
- **Docker**, only if jobs use `container:`, `services:` or Docker actions.

### Start a runner

1. On your own computer, as a repository admin, create a registration token (it works for an hour):

   ```sh
   diffinery api POST /repos/acme/website/actions/runners/registration-token
   ```

   ```json
   {"token": "drg_…", "expires_at": "2026-10-13T19:45:00.000Z"}
   ```

2. On the runner machine, register and start the runner. Set `DIFFINERY_URL` if you don't use `https://diffinery.com`. No login is needed:

   ```sh
   diffinery runner -R acme/website --registration-token drg_… --labels macos,arm64 --agent /opt/diffinery/agent.mjs
   ```

   It registers, saves the runner's credentials, prints the labels it offers and waits:

   ```text
   Registered runner my-mac with acme/website (saved to ~/.config/diffinery/runners/diffinery.com/acme/website/my-mac.json)
   Runner my-mac offering [self-hosted, macos, arm64] for acme/website
   Waiting for jobs. Press Ctrl-C to stop.
   ```

   Later starts use the saved registration: `diffinery runner -R acme/website --agent /opt/diffinery/agent.mjs`. Its labels are the ones it registered with. To change them, delete the saved file and register again.

   On a machine where you're signed in as a repository admin (`diffinery login`), `diffinery runner` registers itself with your token and claims jobs with the runner's own token. Prefer a registration token on shared or dedicated runner machines, so no personal token is kept where jobs could read it.

3. Target it from a workflow:

   ```yaml
   jobs:
     ios:
       runs-on: [self-hosted, macos, arm64]
       steps:
         - uses: actions/checkout@v4
         - run: xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 16' test
   ```

When a job arrives the runner prints `→ acme/website: running job ios (run <run id>, job <job id>)`, echoes the step output prefixed with the job name, and ends with `✓ job ios finished` or `X job ios finished with exit code 1`.

### diffinery runner options

| Flag | Short | Default | Description |
|---|---|---|---|
| `--repo OWNER/NAME` | `-R` | The repository of the current directory's git `origin` remote | Repository to take jobs from. Repeat the flag to serve several repositories. |
| `--labels a,b` | `-l` | none | Extra labels this runner offers, comma separated. `self-hosted` is always offered. |
| `--name NAME` | `-n` | The machine's host name | Runner name. Shown on claimed jobs and used for the default work directory. |
| `--once` | | off | Run at most one job, then exit with its exit code. Prints "No jobs waiting." and exits 0 if nothing is waiting. |
| `--agent PATH` | `-a` | `DIFFINERY_RUNNER_AGENT` | Path to the runner agent (`agent.mjs`). Required one way or the other. |
| `--work-dir DIR` | `-w` | `~/.cache/diffinery/runner/<name>` (or `$XDG_CACHE_HOME/diffinery/runner/<name>`) | Working directory for jobs. |
| `--interval SECONDS` | | `5` | Seconds between polls when idle. |
| `--quiet` | `-q` | off | Don't echo step output locally. Logs still go to Diffinery. |
| `--registration-token TOKEN` | | `DIFFINERY_RUNNER_REGISTRATION_TOKEN` | Register this runner with one repository, using a registration token from a repository admin. |
| `--ephemeral` | | off | Register for a single job: the runner's token stops working once it takes a job, the runner exits with the job's exit code, and nothing is saved. Use it in throwaway VMs or containers. |

The full generated reference is at [CLI reference](/docs/reference/cli).

### Labels and job matching

- A job is eligible when its `runs-on` contains `self-hosted` and **every** one of its labels is offered by the runner. The runner offers `self-hosted` plus everything in `--labels`. Comparison is case-insensitive.
- A runner with more labels than a job asks for can still take the job: `--labels linux,gpu,cuda12` takes `runs-on: [self-hosted, gpu]`.
- `runs-on: [self-hosted]` alone can be taken by any runner serving the repository.
- When several jobs are waiting, a runner takes the oldest run's jobs first.
- Labels have no meaning to Diffinery beyond matching. Choose names that describe the machine (`macos`, `arm64`, `gpu`, `vpn-prod`).

### How jobs are claimed

1. When a self-hosted job is ready to start, Diffinery marks it **waiting** and creates a queued check on the commit.
2. Each runner polls `POST /api/v3/repos/{owner}/{repo}/actions/runners/claim` with its runner token, every `--interval` seconds per repository while idle. It offers the labels it registered with. The response is `204 No Content` when nothing matches, or the job with a fresh job token:

   ```http
   POST /api/v3/repos/acme/website/actions/runners/claim
   Authorization: Bearer drn_...
   Content-Type: application/json

   {}
   ```

   ```json
   {"job_id": "…", "run_id": "…", "name": "ios", "token": "djt_…", "api_url": "https://diffinery.com"}
   ```

3. A claimed job belongs to that runner; no other runner can take it. The runner starts the agent with `DIFFINERY_API_URL`, `DIFFINERY_JOB_ID` and `DIFFINERY_JOB_TOKEN`, and the agent fetches the job, runs it and reports back.
4. A runner runs one job at a time. To run jobs in parallel on one machine, start several runners with different `--name` values (each gets its own work directory).

A job that no runner claims fails after 6 hours. While a job waits, the run page shows it as queued.

If the runner can't reach Diffinery it prints `warning: ... (will retry)` and keeps polling. A `401`, `403` or `404` from the claim request stops the runner, because retrying won't help. For a removed runner it says `runner <name> was removed from <owner>/<repo>; delete <file> and register it again`.

Only registered runners can claim jobs. A personal token, even a repository admin's, gets `403` with `personal tokens can't claim jobs; register this runner: ...`. Runners used to claim that way before registration. If an older runner stops with that message, upgrade the CLI and start it again while signed in, which registers it, or register it with `--registration-token`.

### Manage runners

| Endpoint | Does | Who |
|---|---|---|
| `POST /repos/{owner}/{repo}/actions/runners/registration-token` | A registration token, valid for an hour and for any number of runners: `{"token": "drg_…", "expires_at": "…"}` | Repository admins (people) |
| `POST /repos/{owner}/{repo}/actions/runners/register` | Register a runner: send `{"registration_token": "drg_…", "name": "my-mac", "labels": ["macos"], "ephemeral": false}` and get `{"id", "name", "labels", "ephemeral", "token": "drn_…"}`. The runner token is shown once. A wrong or expired registration token, or a repository that doesn't exist, gets `401 invalid or expired registration token`. | The registration token is the credential |
| `GET /repos/{owner}/{repo}/actions/runners` | GitHub's runner list: `id`, `name`, `os`, `status` (`online` when it polled in the last 90 seconds), `busy`, `ephemeral` and `labels` | Repository admins |
| `DELETE /repos/{owner}/{repo}/actions/runners/{id}` | Remove a runner. Its token stops working at once; a job it's running carries on with its own job token. | Repository admins (people) |

A repository can have at most 100 registered runners, each with at most 20 labels. An ephemeral runner is removed when its job finishes. Registering a runner, creating a registration token and removing a runner are recorded in the audit log.

### What a job sees on a self-hosted runner

- The job runs **directly on the machine**, as the user that started `diffinery runner`, with that user's files, network and permissions.
- The job's environment is the runner's environment, minus `DIFFINERY_TOKEN`, `DIFFINERY_URL`, `DIFFINERY_RUNNER_AGENT`, `GH_TOKEN` and `GITHUB_TOKEN`, plus the usual `GITHUB_*` and `RUNNER_*` variables. `DIFFINERY_GITHUB_TOKEN` (see below) is used by the agent to download actions but is removed from every step's environment.
- The workspace is `<work dir>/<repository name>` and is **not** wiped between jobs. `actions/checkout` cleans it by default (`clean: true`).
- The tool cache (`RUNNER_TOOL_CACHE`) is `<work dir>/_tool` unless the runner's environment sets `RUNNER_TOOL_CACHE`. Tools that `setup-node`, `setup-python` and `setup-go` download stay there for later jobs.
- `runner.os` reports `Linux` and `RUNNER_ENVIRONMENT` reports `diffinery-hosted` on every machine, including Macs. Use your own labels, or check `uname` in a step, if a workflow needs to know the platform.
- Remote actions (`uses: owner/repo@ref`) are downloaded from `codeload.github.com`. Set `DIFFINERY_GITHUB_TOKEN` in the runner's environment to authenticate those downloads (useful against GitHub's rate limits), or `DIFFINERY_ACTIONS_DOWNLOAD_URL` to a URL template containing `{owner}`, `{repo}` and `{ref}` to download from a mirror instead. If the download from `codeload.github.com` fails, the agent tries a shallow `git fetch` of the ref from `https://github.com/<owner>/<repo>`, then the copy Diffinery keeps of every action jobs have used, as hosted runners do (see [When GitHub is down](/docs/actions/compatibility#when-github-is-down)), before failing the step with `Failed to download action '<owner>/<repo>@<ref>': ...`. There is no `git` fallback, and no copy from Diffinery, when `DIFFINERY_ACTIONS_DOWNLOAD_URL` is set.
- The common official actions (`actions/checkout`, `actions/cache`, `actions/upload-artifact`, `actions/download-artifact`, `actions/setup-node`, `actions/setup-python`, `actions/setup-go`) run as built-in implementations when the version and inputs allow it. Set `DIFFINERY_DISABLE_BUILTINS=1` in the runner's environment to always download and run the real actions on that runner. See [Compatibility with GitHub Actions](/docs/actions/compatibility#built-in-actions).
- `setup-node`, `setup-python` and `setup-go` download their tools from `nodejs.org/dist`, the `actions/python-versions` manifest and `go.dev`. Override the sources with `DIFFINERY_NODE_MIRROR`, `DIFFINERY_PYTHON_MANIFEST` and `DIFFINERY_GO_INDEX` in the runner's environment if the machine can't reach them.

### Run as a service with systemd

On Linux, run the runner as a systemd service under a dedicated user so it starts at boot and restarts after failures.

1. Create a user and put the CLI and agent where it can read them:

   ```sh
   sudo useradd --system --create-home --shell /bin/bash diffinery-runner
   sudo install -m 0755 ~/.local/bin/diffinery /usr/local/bin/diffinery
   sudo install -D -m 0644 containers/runner/dist/agent.mjs /opt/diffinery/agent.mjs
   ```

2. Register the runner once as that user, with a registration token from a repository admin. Stop it with Ctrl-C once it says it's waiting:

   ```sh
   sudo -u diffinery-runner -H env DIFFINERY_URL=https://diffinery.com DIFFINERY_RUNNER_AGENT=/opt/diffinery/agent.mjs \
     diffinery runner -R acme/website --registration-token drg_… --labels linux,gpu --name gpu-box-1
   ```

   Its credentials are saved in that user's `~/.config/diffinery/runners`, so the service needs no token.

3. Create `/etc/systemd/system/diffinery-runner.service`:

   ```text
   [Unit]
   Description=Diffinery self-hosted runner
   After=network-online.target
   Wants=network-online.target

   [Service]
   User=diffinery-runner
   WorkingDirectory=/home/diffinery-runner
   Environment=DIFFINERY_URL=https://diffinery.com
   Environment=DIFFINERY_RUNNER_AGENT=/opt/diffinery/agent.mjs
   ExecStart=/usr/bin/node /usr/local/bin/diffinery runner -R acme/website --labels linux,gpu --name gpu-box-1 --quiet
   Restart=always
   RestartSec=10

   [Install]
   WantedBy=multi-user.target
   ```

   Adjust the path to `node` (`which node`) and the repositories and labels. Pass `-R` explicitly: a service has no git checkout to infer the repository from.

4. Start it and follow its output:

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now diffinery-runner
   journalctl -u diffinery-runner -f
   ```

Stopping the service sends the stop signal to the runner and the agent, which cancels the running job and reports it as cancelled. On macOS, use a `launchd` agent with the same command line and environment variables.

For a clean machine per job, run `diffinery runner --ephemeral --registration-token drg_…` inside a fresh virtual machine or container and throw it away afterwards. It exits with the job's exit code, and its token can't be used again.

### Docker on self-hosted runners

Job containers, service containers and Docker container actions work on a self-hosted runner that has Docker installed and running, with the `docker` CLI on the runner's `PATH` and permission to use the daemon (for example, membership in the `docker` group). Without Docker, those jobs fail with:

```text
Job containers (jobs.<id>.container) need Docker, and this runner has no docker CLI. Use runs-on: [self-hosted, ...] on a machine with Docker installed.
```

or, when the CLI exists but the daemon isn't running:

```text
Service containers (jobs.<id>.services) need Docker, and the Docker daemon on this runner is not reachable: ...
```

The daemon must be local to the machine, because the job container mounts the runner's work directory at the same path. Self-hosted runners don't have the registry relay that hosted runners have, so pushing an image layer larger than 100 MB to the Diffinery registry fails from a self-hosted runner. See [Docker in workflows](/docs/actions/docker) and [Container registry](/docs/packages/container-registry).

### macOS, Windows and GPU machines

- **macOS.** The runner and agent run on macOS with Node.js 22 or later. Steps run with `/bin/bash`. Because the built-in `setup-node`, `setup-python` and `setup-go` download Linux builds, install toolchains on the Mac yourself (Homebrew, Xcode) and either skip those actions or ask for a version that's already installed (the installed one is used when it satisfies the request). Docker-based features are designed for Linux hosts.
- **Windows.** The runner agent runs steps with bash or sh and rejects `shell: cmd` with "The `cmd` shell is not supported on Linux runners." It reports `runner.os` as `Linux`. Native Windows isn't a supported host in this version; the practical route is to run the runner inside WSL 2 and call Windows programs from steps through WSL interop (for example `powershell.exe`).
- **GPUs.** Start the runner with a label such as `gpu` and run steps directly on the machine. To use the GPU from a job container, install the NVIDIA Container Toolkit on the machine and pass the Docker option through: `container: { image: nvidia/cuda:12.4.1-base-ubuntu22.04, options: --gpus all }`.

### Security considerations

A self-hosted runner runs code from your repository's workflows on your machine. Before you start one:

- **Anyone who can push can run code on the machine.** People and agents with write access can push a branch or open a pull request whose workflow targets `self-hosted`, and `push` and `pull_request` runs use the workflow file from that commit. Only serve repositories whose writers you trust with the machine.
- **Jobs run as the runner's user.** A job can read anything that user can, including the runner's saved registration and other repositories' checkouts in the work directory. A runner registered with a registration token keeps only its runner token, which can claim that repository's jobs and nothing else: it can't read the repository, push, or call the API. Someone who steals it can still take that runner's future jobs, with their secrets, until you remove the runner. So use a dedicated OS user with no other access, don't sign in with a personal token on the runner machine, and prefer `--ephemeral` in a throwaway VM for anything sensitive.
- **Jobs get the repository's secrets**, just like on hosted runners, and can reach whatever the machine can reach on your network. A job with `environment:` also gets that environment's secrets when its branch policy and the rules for environment secrets allow it, so a runner that serves deploy jobs handles production credentials. See [Deployments and environments](/docs/actions/environments).
- **State persists.** The work directory, tool cache and anything a job writes elsewhere stay on the machine. A malicious job can leave something behind for the next job. For untrusted workloads, use `--ephemeral` in a throwaway VM: its token ends when it takes its one job.
- **Cancelling isn't instant on your machine.** When a run is cancelled, Diffinery marks the job cancelled and revokes its job token right away, but the agent finishes executing the current steps locally (their logs and results are discarded). Stop the runner (Ctrl-C) to stop the work immediately; a second Ctrl-C kills the agent.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No Diffinery runner matches runs-on: ...` | A label isn't hosted and the job doesn't include `self-hosted`. Use an `ubuntu-*` label, or add `self-hosted` and start a runner with matching `--labels`. |
| `No Diffinery runner matches runs-on: (no labels)` | Every `runs-on` entry evaluated to an empty value, for example a `matrix` key that the combination doesn't set. Check the expression. |
| A self-hosted job stays queued | No runner serving that repository offers every label. Compare the job's `runs-on` with the labels the runner printed at start. The job fails after 6 hours. |
| `403 admin access required` | The runner's token or account lacks admin on the repository, or the token isn't `admin`-scoped. |
| `no runner agent given` or `runner agent not found at ...` | Pass `--agent /path/to/agent.mjs` or set `DIFFINERY_RUNNER_AGENT`. Build it with `pnpm --filter @diffinery/runner build`. |
| `E: Unable to locate package ...` | Run `apt-get update` first; the image ships without package lists. |
| A hosted job starts a minute or more late, and its log begins with `No hosted runner could start the job yet: ...` | No machine was free (`there is no container instance that can be provided`), the start failed on the platform's side for a passing reason (`internal error; reference = ...`, a dropped connection), the container stopped before the runner started, or a deploy was rolling out and the runner came up on the previous image. Diffinery puts the job back in line and tries again (after 30 s, then 1, 2, 4 and 5 minutes, up to 8 times; a first container stop before the runner started, or a first internal error, is retried after 5 s and not counted; a runner on the previous image during a deploy is retried every 20 s for up to 10 minutes, not counted, and then runs on whichever image it got); `placementTries` in the jobs API counts the waits. Nothing to fix for an occasional wait. If a large matrix often waits, cap it with `strategy.max-parallel`. |
| `The platform replaced this job's runner with a new version while step ... ran` or `The platform stopped this job's container while step ... ran` | A deploy replaced the job's container mid-step (rare), or the platform stopped or moved it. Re-run the job. A job that can only read starts again by itself instead: give jobs that only build and test `permissions: contents: read`, no `environment:` and no secrets other than `GITHUB_TOKEN`. See Platform updates under [Limits and timeouts](#limits-and-timeouts). |
| `The runner stopped unexpectedly (exit code N).` | The hosted container exited, often from running out of memory. Reduce parallelism in the job (for example `make -j2`) or move it to a self-hosted runner. |
| `Connection refused` or `Connection timed out` on SSH (`git@...`), SMTP or a database port, on a hosted runner | The instance sets [`EGRESS=web`](/docs/self-hosting/configuration#egress), which lets hosted jobs use only HTTP and HTTPS. Use an `https://` remote or API, or run the job on a self-hosted runner. It's unset by default. |
| `unable to get local issuer certificate`, `x509: certificate signed by unknown authority` or another certificate error on a hosted runner | Under [`EGRESS=web`](/docs/self-hosting/configuration#how-a-blocked-connection-looks) HTTPS is re-signed with a Cloudflare CA. Most tools trust it already; a tool with its own CA list, or a Docker container the job starts, needs `/etc/cloudflare/certs/cloudflare-containers-ca.crt` added. |
