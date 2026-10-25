---
title: Move your GitHub Actions workflows to Diffinery
description: Run your existing .github/workflows files on Diffinery: what runs unchanged, runner labels and sizes, secrets, caches, Docker, OIDC, environments, and what to change.
updated: 2026-10-25
---

Most GitHub Actions workflows run on Diffinery without changes: Diffinery reads `.github/workflows/*.yml`, supports the same triggers, expressions, matrices, `needs`, caches, artifacts, secrets, OIDC and Docker, and downloads marketplace actions from GitHub as they are. Jobs with `runs-on: ubuntu-latest` run on hosted Ubuntu 24.04 runners with 4 vCPUs and 12 GiB of memory by default. What you change is usually small: set your secret values again (GitHub never reveals them), move Windows, macOS and Arm jobs to self-hosted runners, and give `GITHUB_TOKEN` the `permissions:` it needs.

## Steps

1. **Bring the repository over.** Import it under **Settings → Imports → Import from GitHub**, or run `diffinery migrate github acme/website --to acme/website`. The importer copies the history (workflow files included), issues, pull requests, branch protection, Actions variables, environments and the names of your secrets. The import starts no workflow runs; your first push does. See [Migrate from GitHub](/docs/migrate-from-github).
2. **Set your secret values.** The import lists every secret name, but never a value. A person who is a repository admin enters each one: **Set secret values** on the import's page, `diffinery secret set NPM_TOKEN -R acme/website`, or the REST API. Do this before your first push, because that push starts the workflows. See [Set secret values](/docs/migrate-from-github#set-secret-values).
3. **Check the workflow files.** Run `diffinery workflow validate .github/workflows/ci.yml` on each file. Errors fail the file; warnings name keys that are accepted but ignored.
4. **Fix `runs-on` where needed.** `ubuntu-*` labels run on hosted runners. Windows, macOS and Arm jobs need a self-hosted runner (see [Runners and runner sizes](#runners-and-runner-sizes)).
5. **Add `permissions:` where a job writes.** In repositories created on Diffinery, imported ones included, the job token can only read code and packages by default. A job that comments, labels, pushes, tags or publishes needs a `permissions:` block, for example `contents: write` or `pull-requests: write`, or an admin sets the repository default to write. See [Workflow permissions](/docs/actions/workflow-permissions).
6. **Push a commit and watch the first runs** on the **Actions** tab, or with `diffinery run list` and `diffinery run watch <run-id>`. Fix what fails using the sections below.

## What runs unchanged

- **Triggers:** `push`, `pull_request`, `pull_request_target`, `merge_group`, `workflow_dispatch`, `schedule`, `workflow_run`, `release`, `repository_dispatch` and `workflow_call`. See [Events that trigger workflows](/docs/actions/events).
- **Workflow syntax:** expressions and contexts, matrices with `include` and `exclude`, `needs`, job outputs, `if` conditions, `concurrency`, job summaries, environment files and workflow commands. See [Workflow syntax](/docs/actions/workflow-syntax).
- **Reusable workflows**, as long as they live on the same Diffinery instance and the calling job has no matrix. See [Reusable workflows](/docs/actions/reusable-workflows).
- **Workflows in `.github/workflows/`.** Diffinery also reads `.diffinery/workflows/`, for workflows that should only run on Diffinery.

## Runners and runner sizes

| `runs-on` | On Diffinery |
| --- | --- |
| `ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04`, any other `ubuntu-*` label, `linux`, `x64` | A hosted Ubuntu 24.04 x64 container, fresh for each job |
| `diffinery-tiny`, `diffinery-small`, `diffinery-medium`, `diffinery-large` | A hosted runner of that size |
| `windows-*`, `macos-*` | Fails: there are no Windows or macOS hosted runners |
| `ubuntu-24.04-arm` and other Arm labels | Runs on the same x64 image; there are no hosted Arm runners |
| `[self-hosted, ...]` | A machine you connect with `diffinery runner`, matched on every label |

A job without a size label gets the **large** size (4 vCPU, 12 GiB of memory, 20 GB of disk), unless its own earlier runs show that a smaller size serves it just as well. Add a label such as `runs-on: [ubuntu-latest, diffinery-small]` to pin a size. See [Runner sizes](/docs/actions/runners#runner-sizes).

The hosted image is smaller than GitHub's. It has Git, Git LFS, curl, jq, build-essential, Python 3.12, Node.js 22 with npm, pnpm and yarn, Docker and `gh`. Go, Java, Ruby, Rust, .NET, PowerShell, browsers and cloud CLIs aren't preinstalled: install them with a setup action or `apt-get`. The apt package lists are removed, so run `apt-get update` before `apt-get install`. See [The Ubuntu 24.04 image](/docs/actions/runners#the-ubuntu-2404-image).

**macOS, Windows, Arm and GPU jobs** run on a [self-hosted runner](/docs/actions/runners#self-hosted-runners): a repository admin creates a registration token, and you start `diffinery runner` on your machine with labels such as `--labels macos,arm64`. Jobs with `runs-on: [self-hosted, macos, arm64]` then go to it. On Windows, the documented route is to run the runner inside WSL 2. See [macOS, Windows and GPU machines](/docs/actions/runners#macos-windows-and-gpu-machines).

## Marketplace actions

Any `uses: owner/repo@ref` is downloaded from GitHub when the step runs, so marketplace actions keep working. JavaScript actions (they run on the runner's Node.js 22), composite actions and Docker container actions are all supported.

- `actions/checkout`, `actions/setup-node`, `actions/setup-python`, `actions/setup-go`, `actions/cache`, `actions/upload-artifact` and `actions/download-artifact` are built into the runner for speed, for the version ranges listed in [Built-in actions](/docs/actions/compatibility#built-in-actions). For other versions or inputs, the real action runs.
- `actions/github-script` works with the REST API (`github.rest.*`); `github.graphql` doesn't, because the job token can't use Diffinery's GraphQL API yet.
- Actions in **private GitHub repositories** can't be downloaded on hosted runners. Move them into a Diffinery repository and use them as local actions. See [Actions stored on Diffinery](/docs/actions/compatibility#actions-stored-on-diffinery).
- `uses: acme/my-action@v1` always means the repository on GitHub, not on Diffinery.

## Secrets and variables

- **Values come from people.** The importer copies repository variables with their values, and only the **names** of repository, environment and organization secrets. A repository admin who is a person sets each secret's value. Agents can't set secrets or variables anywhere.
- **Where to set them:** repository secrets on **Settings → Secrets and variables** or with `diffinery secret set`; organization secrets with `diffinery secret set NAME --org acme`; environment secrets with the REST API.
- **Pull request runs get secrets.** Every pull request comes from a branch of the same repository (there are no forks), so `pull_request` runs receive the repository's secrets. Runs of code an agent wrote don't, unless an admin allows it. See [Which runs receive secrets](/docs/actions/secrets-and-variables#which-runs-receive-secrets).
- **Tools that encrypt secrets first** (GitHub's sealed-box `encrypted_value`) don't work: send the plain `value` over HTTPS; it's encrypted at rest.

See [Secrets and variables](/docs/actions/secrets-and-variables).

## Caches and artifacts

`actions/cache`, `actions/upload-artifact` and `actions/download-artifact` work as on GitHub, and the built-in versions share their storage and formats with the official actions. Caches are scoped per ref with the same fallbacks to the base branch and the default branch, each repository keeps up to 10 GB of caches, and artifacts are kept for up to 90 days. The `cache` input of the setup actions works too. See [Caching and artifacts](/docs/actions/caching-and-artifacts).

## Docker

Job containers, service containers, Docker container actions, `docker build`, `docker run` and `docker compose` work on hosted runners, and so do `docker/setup-buildx-action`, `docker/login-action` and `docker/build-push-action`. The Docker daemon starts on first use, and Docker Hub images are pulled through the `mirror.gcr.io` mirror. If you publish images to `ghcr.io`, push them to the registry at `diffinery.com` instead, signed in with the job's `GITHUB_TOKEN` and `packages: write`. See [Docker in workflows](/docs/actions/docker) and [Migrating from ghcr.io](/docs/packages/container-registry#migrating-from-ghcrio).

## OIDC

OIDC works with `permissions: id-token: write`, with `https://diffinery.com` as the issuer. In your cloud provider's trust policy, change the issuer host from `token.actions.githubusercontent.com` to `diffinery.com`, and keep your `sub` patterns unless they rely on a customized subject template. See [OpenID Connect (OIDC)](/docs/actions/oidc#differences-from-github).

## Environments

The importer creates your environments with their deployment branch policies and variables, and lists their secret names. Then:

- Set environment secrets with the REST API, as a repository admin who is a person. See [Environments and their secrets](/docs/migrate-from-github#environments-and-their-secrets).
- Set required reviewers and wait timers again under **Settings → Environments**, with Diffinery people. They don't come across. See [Required reviewers and wait timers](/docs/actions/environments#required-reviewers-and-wait-timers).
- Pull request runs never get environment secrets. Keep production credentials in an environment limited to protected branches.

## What doesn't work

The full list, with error messages, is in [Compatibility with GitHub Actions](/docs/actions/compatibility). The differences you're most likely to meet:

- No hosted Windows, macOS or Arm runners, no larger runners above 4 vCPU and no runner groups (`group` is ignored).
- Events other than the ten listed above (`issues`, `issue_comment`, `pull_request_review` and the rest) parse but never start a run.
- A matrix on a job that calls a reusable workflow isn't supported yet.
- `github.graphql` in `actions/github-script` fails.
- Problem matchers aren't supported, and annotations show in the job log only.
- The `cmd` shell isn't supported, and hosted runners have no PowerShell.
- Hard-coded `github.com` and `api.github.com` URLs point at GitHub: use `${{ github.server_url }}` and `${{ github.api_url }}`.

## Checklist

1. Import the repository (or push it) and read the import's warnings.
2. Set every secret value listed by the import, including environment and organization secrets.
3. Run `diffinery workflow validate` on every workflow file.
4. Replace `windows-*`, `macos-*` and Arm labels with `[self-hosted, ...]` labels and start a runner, or move the job to Linux. Check `matrix.os` values used in `runs-on`.
5. Add `apt-get update` before `apt-get install`, and install tools the hosted image doesn't have.
6. Add `permissions:` to jobs that write with `GITHUB_TOKEN`.
7. Move actions from private GitHub repositories into Diffinery and use them as local actions.
8. Replace `ghcr.io` with your instance's host (`diffinery.com` here), and hard-coded GitHub URLs with `github.server_url` and `github.api_url`.
9. Update OIDC trust policies to the `https://diffinery.com` issuer.
10. Set environment secrets, required reviewers and wait timers.
11. Check the required check names under **Settings → Branch protection** (they're `<workflow name> / <job name>`, such as `CI / test`).
12. Push and watch the first runs.

## Frequently asked questions

### Do my GitHub Actions workflows run unchanged on Diffinery?

Most do. Diffinery reads `.github/workflows/` and supports the same syntax, triggers, expressions, matrices, caches, artifacts, secrets, OIDC and Docker. Jobs that need Windows, macOS or Arm, actions from private GitHub repositories, or `github.graphql` need changes. See [Compatibility with GitHub Actions](/docs/actions/compatibility).

### Does Diffinery copy my GitHub secrets?

It copies their names, never their values: GitHub doesn't reveal secret values, and the importer doesn't try. A repository admin who is a person sets each value on Diffinery, from the import's **Set secret values** page, the CLI or the API.

### Can I run macOS or Windows jobs on Diffinery?

Not on hosted runners: Cloudflare Containers run Linux only. Run them on your own machine with a self-hosted runner (`diffinery runner`) and `runs-on: [self-hosted, ...]` labels.

### Do marketplace actions work on Diffinery?

Yes. Diffinery downloads `uses: owner/repo@ref` actions from GitHub when the step runs. JavaScript, composite and Docker container actions are supported. Actions in private GitHub repositories can't be downloaded on hosted runners.

### Can I try Diffinery Actions before I move?

Yes. Keep GitHub as the place where people push, and mirror every push to Diffinery with a GitHub workflow, so Diffinery runs your workflows on each commit. See [Run Diffinery CI while your code stays on GitHub](/docs/guides/mirror-from-github).
