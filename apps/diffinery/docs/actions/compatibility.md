---
title: Compatibility with GitHub Actions
description: What works, what works differently and what isn't supported when you run GitHub Actions workflows on Diffinery, with a checklist for porting workflows.
---

Diffinery runs GitHub Actions workflow files with the same syntax, triggers, expressions and actions, so most workflows run without changes. This page lists every place where Diffinery behaves differently, what happens when a workflow uses something that isn't supported, and a checklist for porting workflows from GitHub.

## At a glance

| Area | Status on Diffinery | Details |
| --- | --- | --- |
| Workflow syntax | Supported, with a few keys accepted but ignored | [Workflow syntax](#workflow-syntax) |
| Triggers | `push`, `pull_request`, `pull_request_target`, `merge_group`, `workflow_dispatch`, `schedule`, `workflow_run`, `release`, `repository_dispatch`, `workflow_call` | [Triggers](#triggers) |
| Expressions and contexts | Supported, with small differences in values | [Contexts and environment variables](#contexts-and-environment-variables) |
| Hosted runners | Linux x64 only (Ubuntu 24.04) | [Runners](#runners) |
| Self-hosted runners | Supported, through `diffinery runner` | [Runners](/docs/actions/runners) |
| Matrices, `needs`, outputs, job summaries | Supported | [Jobs and steps](#jobs-and-steps) |
| `actions/checkout`, `actions/setup-node`, `actions/setup-python`, `actions/setup-go` | Built into the runner for speed; the real action runs for versions or inputs the built-in doesn't cover | [Built-in actions](#built-in-actions) |
| `actions/cache`, `actions/upload-artifact`, `actions/download-artifact` | Built into the runner, sharing storage and formats with the official actions, which also work | [Caching and artifacts](/docs/actions/caching-and-artifacts) |
| `actions/github-script` | Supported (the real action runs) | [actions/github-script](#actionsgithub-script) |
| Other JavaScript, composite and Docker actions | Supported, downloaded from GitHub, with the cache and artifact runtime services | [Other actions](#other-actions) |
| Job containers and service containers | Supported | [Docker in workflows](/docs/actions/docker) |
| Reusable workflows | Supported, except a matrix on the calling job | [Reusable workflows](/docs/actions/reusable-workflows) |
| Secrets and variables | Repository, organization and environment secrets and variables | [Secrets and variables](/docs/actions/secrets-and-variables) |
| Environments | Supported: branch policies, required reviewers (people), wait timers, environment secrets and variables, deployments. | [Secrets, variables and environments](#secrets-variables-and-environments) |
| `GITHUB_TOKEN` | Follows `permissions:` per endpoint, as on GitHub; read-only by default in new repositories | [GITHUB_TOKEN and permissions](#github_token-and-permissions) |
| OIDC | Supported, with Diffinery as the issuer | [OIDC](/docs/actions/oidc) |
| Windows and macOS hosted runners | Not available (Cloudflare Containers run Linux only); use self-hosted runners | [Runners](#runners) |

## Workflow files

Diffinery reads workflows from `.github/workflows/` and from `.diffinery/workflows/`. Every `.yml` or `.yaml` file directly in either directory is a workflow; files in subdirectories are ignored. Workflows in both directories run, each as its own workflow. Put workflows that should only run on Diffinery in `.diffinery/workflows/`, so a GitHub mirror of the repository doesn't run them. See [Where workflow files live](/docs/actions/overview#where-workflow-files-live).

Check a workflow before you push it:

```sh
diffinery workflow validate .github/workflows/ci.yml
```

Errors fail the file; warnings, such as `unknown job key '<key>'` or `unknown event '<name>'`, are printed but the workflow still runs.

## Triggers

| Event | Status | Differences |
| --- | --- | --- |
| `push` | Supported | `commits` in the payload lists only the pushed head commit. Path filters pass when a push creates a branch. |
| `pull_request` | Supported | Activity types `opened`, `synchronize`, `reopened`, `closed`, `edited`, `ready_for_review` and `converted_to_draft` only; the `edited` payload has no `changes` object. No runs while the pull request conflicts with its base. Runs get the repository's secrets, because pull requests come from branches of the same repository. |
| `pull_request_target` | Supported | Same activity types as `pull_request`. Runs also while the pull request conflicts. |
| `merge_group` | Supported | `checks_requested`. |
| `workflow_dispatch` | Supported | `github.event.inputs` keeps the input types instead of turning them into strings. The dispatch API answers `201 Created` with the run instead of `204 No Content`. |
| `schedule` | Supported | Checked every 5 minutes, so a schedule starts within about 5 minutes after it's due. Runs have the actor `diffinery-scheduler`. |
| `workflow_run` | Supported | Activity types `requested` and `completed` (not `in_progress`), `workflows` is required, and chains go at most 3 levels deep. |
| `release` | Supported | Same activity types. No runs for draft releases, as on GitHub. Without `types`, a new published release starts three runs (`created`, `published`, `released`), as on GitHub. Only `types` filters; `branches`, `tags` and `paths` aren't applied. |
| `repository_dispatch` | Supported | `POST /repos/{owner}/{repo}/dispatches` answers `204`. The payload has `action`, `branch`, `client_payload`, `repository` and `sender`. |
| `workflow_call` | Supported | See [Reusable workflows](/docs/actions/reusable-workflows). |
| Every other GitHub event (`issues`, `issue_comment`, `pull_request_review`, `create`, `delete`, `status`, `deployment`, `deployment_status` and the rest) | Accepted, never fires | The workflow parses, but Diffinery never starts a run for these events. (Webhooks do get `status`, `deployment` and `deployment_status`.) |
| A name that isn't a GitHub event | Warning | `unknown event '<name>'`. |

Details for each event are in [Events that trigger workflows](/docs/actions/events).

## Workflow syntax

Every key of the GitHub Actions workflow syntax parses. These keys behave differently:

| Key | What happens on Diffinery |
| --- | --- |
| `jobs.<id>.runs-on` | Supported, including the `matrix` context (`runs-on: ${{ matrix.os }}`), but only Linux labels are hosted. The `group` key is ignored. |
| `jobs.<id>.environment` | Supported: the branch policy is enforced, the environment's secrets and variables are added and a deployment is recorded. Required reviewers and wait timers hold the job before it starts, and `url` can't use step outputs. See [environment](/docs/actions/workflow-syntax#environment). |
| `jobs.<id>.snapshot` | Accepted and ignored. |
| `jobs.<id>.timeout-minutes` | Default and maximum 360. Larger values are capped at 360. |
| `jobs.<id>.strategy.matrix` | At most 256 jobs per matrix, and at most 1,000 jobs in a run, matrix legs and the jobs of called workflows included. |
| `jobs.<id>.uses` with `strategy.matrix` | Not supported yet. The run fails with `jobs.<id>: a matrix on a job that calls a reusable workflow is not supported yet`. |
| `concurrency` (workflow level) | Same as GitHub: one run in progress and at most one waiting per group; a newer run cancels older waiting ones. After 6 hours of waiting a run starts anyway. See [Concurrency](/docs/actions/overview#concurrency). |
| `defaults.run.shell`, `jobs.<id>.steps[*].shell` | `cmd` isn't supported. `pwsh` and `powershell` need PowerShell, which hosted runners don't have. |

An unknown key gives a warning such as `unknown job key '<key>'` or `unknown step key '<key>'`, and the key is ignored. The full reference is [Workflow syntax](/docs/actions/workflow-syntax).

## Runners

| `runs-on` | GitHub | Diffinery |
| --- | --- | --- |
| `ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04` | Hosted Ubuntu VM | Hosted Ubuntu 24.04 container, x64. All three labels get the same image. |
| `ubuntu-24.04-arm` and other ARM labels | Hosted ARM runner | No hosted ARM runners. An `ubuntu-*` ARM label runs on the same x64 image as `ubuntu-latest`. For ARM, use `[self-hosted, ...]` labels on an ARM machine. |
| `windows-*`, `macos-*` | Hosted Windows or macOS VM | Not available: Cloudflare Containers run Linux only. The job fails with `No Diffinery runner matches runs-on: <labels>. Linux (ubuntu-*) runners are hosted; anything else needs runs-on: [self-hosted, ...] and a registered runner.` |
| Larger runners and runner groups | Supported | Not available. `group` is ignored. |
| `[self-hosted, ...]` | Self-hosted runner | Self-hosted runner started with `diffinery runner`, matched on every label. |

What's different about the hosted image:

- It's much smaller than GitHub's image. Git, Git LFS, curl, jq, zstd, build-essential, Python 3.12, Node.js 22 with npm, pnpm and yarn, nvm, Docker and the GitHub CLI (`gh`) are preinstalled. `ImageOS` is `ubuntu24`, as on GitHub's `ubuntu-24.04` image. Go, Java, Ruby, Rust, .NET, PowerShell, browsers and cloud CLIs aren't. See [The Ubuntu 24.04 image](/docs/actions/runners#the-ubuntu-2404-image).
- Jobs run as `root`. `sudo` is installed and needs no password, as on GitHub, so `sudo` in commands keeps working.
- The apt package lists are removed. Run `apt-get update` before `apt-get install`.
- Every job starts in a fresh container. Nothing carries over between jobs except caches and artifacts.

On self-hosted runners, `runner.os` is always `Linux`, and the setup actions download Linux builds, even on a macOS machine. See [Self-hosted runners](/docs/actions/runners#self-hosted-runners).

## Jobs and steps

These work the same as on GitHub: `needs` (a job starts as soon as the jobs it needs finish), job outputs, `if` conditions, status check functions (a skipped or failed job further up the `needs` chain skips the jobs below it unless their `if` says otherwise), matrices with `include` and `exclude`, `fail-fast`, `max-parallel`, job and step `continue-on-error`, job-level `concurrency`, `timeout-minutes`, `working-directory`, environment files (`GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`, `GITHUB_STATE`), workflow commands, job summaries, masking and debug logging with `ACTIONS_STEP_DEBUG` and `ACTIONS_RUNNER_DEBUG`.

Differences:

| Behaviour | GitHub | Diffinery |
| --- | --- | --- |
| Default shell for `run` | `bash -e {0}` | `bash --noprofile --norc -eo pipefail {0}`, so a failing command in a pipeline fails the step. |
| `::add-matcher::` problem matchers | Turn matching output into annotations | Not supported; the line is printed as is. |
| Annotations (`::error file=...`) | Shown on pull request files | Shown in the job log only. |
| `::set-env` and `::add-path` | Disabled | Disabled, with the same message. |
| `github.run_number` | Counts runs of one workflow | Counts runs of every workflow in the repository. |

See [Expressions and contexts](/docs/actions/expressions) and [Workflow syntax](/docs/actions/workflow-syntax) for the details.

## Built-in actions

For speed, the runner has its own implementation of these actions and runs it instead of downloading the action, when the step uses a version tag in the listed range:

| Action | Built-in for |
| --- | --- |
| `actions/checkout` | `v2` to `v6` |
| `actions/setup-node` | `v3` to `v7` |
| `actions/setup-python`, `actions/setup-go` | `v4` to `v6` |
| `actions/cache`, `actions/cache/restore`, `actions/cache/save` | `v3` to `v6` |
| `actions/upload-artifact` | `v4` to `v7` |
| `actions/download-artifact` | `v4` to `v8` |

The built-ins mirror the official actions' inputs, outputs and storage: a cache or artifact saved by a built-in works with the official action and the other way round. A built-in steps aside, and the real action is downloaded from GitHub and run, when:

- the reference isn't `vN`, `vN.N` or `vN.N.N` in the range, for example a commit SHA, a branch or a newer major version;
- the step passes an input the built-in doesn't list (see the tables below);
- an input has a value the built-in doesn't handle: `ssh-key` for checkout, an `architecture` other than the runner's, a `cache` value the built-in doesn't support, a PyPy or GraalPy version, or `update-environment: false` for setup-python;
- the workflow, job or step `env:` sets `DIFFINERY_BUILTINS` to `false`, `0`, `no` or `off`;
- a self-hosted runner was started with `DIFFINERY_DISABLE_BUILTINS=1`.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      DIFFINERY_BUILTINS: false   # this job runs the real actions
    steps:
      - uses: actions/checkout@v4
```

Built-in actions run on the runner, not inside a job container. In a job with `container:`, they work on the shared workspace.

### actions/checkout

Checks out a repository on the same Diffinery instance into the workspace.

| Input | Default | Notes |
| --- | --- | --- |
| `repository` | The workflow's repository | `owner/name` of a repository on Diffinery. Anything else fails with `Invalid repository '<value>'. Expected format {owner}/{repo}.` |
| `ref` | The commit that triggered the run, or the other repository's default branch | Branch, tag, full ref or 40-character commit SHA. A short SHA is treated as a branch or tag name. |
| `token` | The job's token | The job's token reads the workflow's own repository (with `contents: read`) and any public repository on Diffinery. For another private repository, pass a personal or agent token from a secret. The job's token is only ever sent to Diffinery; a different `github-server-url` needs an explicit `token`. |
| `fetch-depth` | `1` | `0` fetches all branches and tags with full history. |
| `fetch-tags` | `false` | |
| `path` | The workspace | Relative to the workspace. A path outside it fails with `Repository path '<path>' is not under '<workspace>'`. |
| `clean` | `true` | Runs `git clean -ffdx` and `git reset --hard HEAD` on an existing checkout. |
| `filter` | | A partial clone filter such as `blob:none`, passed to `git fetch`. Diffinery's git server doesn't support partial clone yet and sends everything. |
| `sparse-checkout` | | Patterns, one per line. Sets up a sparse checkout and fetches with `filter: blob:none` unless you set `filter`. |
| `sparse-checkout-cone-mode` | `true` | `false` uses non-cone patterns. |
| `lfs` | `false` | Fetches Git LFS objects for the checked-out commit (and runs `git lfs pull` in submodules). See [Git LFS](/docs/repositories/git-lfs). |
| `submodules` | `false` | `true` or `recursive`. Submodules on Diffinery are fetched with the same credentials. A failed submodule update fails the step. |
| `persist-credentials` | `true` | Writes the token into the repository's local Git config at the end, so later `git` commands authenticate. A post step removes it. With `false`, nothing is written. |
| `show-progress` | `true` | Passes `--progress` to `git fetch` and `git checkout`. |
| `set-safe-directory` | `true` | Marks the checkout as a Git safe directory for checkout's own commands. |
| `github-server-url` | Diffinery | Check out from another server, for example `https://github.com`, with an explicit `token` for private repositories. |
| `ssh-key` | | Not handled by the built-in: the real action runs. `ssh-known-hosts`, `ssh-strict` and `ssh-user` are accepted and ignored. |

While fetching, the token reaches git through the environment, so a checkout that fails halfway leaves no credentials in `.git/config`. Credentials a reused workspace still holds from another job are removed first.

Outputs: `commit` (the checked-out SHA) and `ref`.

As on GitHub, a `pull_request` run checks out the test merge commit (`refs/pull/<number>/merge`) by default, and a `pull_request_target` run checks out the base branch.

Errors:

- `Failed to fetch ref '<ref>' from <owner>/<repo>. Check that the ref exists and the token has read access.`
- `A branch or tag with the name '<ref>' could not be found` (with `fetch-depth: 0`).
- `Checked out <sha> but expected <sha>.`

### actions/setup-node

| Input | Notes |
| --- | --- |
| `node-version` | A version or range (`22`, `20.x`, `>=20.10`), `lts/*`, `lts/<codename>`, `lts/-1`, `latest`, `current` or `node`. |
| `node-version-file` | `package.json` (reads `volta.node`, then `devEngines.runtime.version`, then `engines.node`), `.tool-versions` (`nodejs` or `node`), or a file whose first non-comment line is the version, such as `.nvmrc` or `.node-version`. |
| `check-latest` | Download the newest matching version even when the preinstalled one satisfies the request. |
| `registry-url`, `scope`, `always-auth` | Writes an `.npmrc` that reads `NODE_AUTH_TOKEN`, and sets `NPM_CONFIG_USERCONFIG`. For `npm.pkg.github.com` the scope defaults to the repository owner. `always-auth` is written for `v4` and earlier, or when you set it. |
| `cache`, `cache-dependency-path` | `npm`, `pnpm` or `yarn`. See [Dependency caching with setup actions](/docs/actions/caching-and-artifacts#dependency-caching-with-setup-actions). |
| `package-manager-cache` | `v5` and later cache npm automatically when `package.json` names npm as its package manager; `false` turns that off. |
| `architecture`, `token` | Accepted. An `architecture` other than the runner's runs the real action. |

Hosted runners have Node.js 22.22.0. A request that it satisfies uses it without a download; any other version is downloaded from `nodejs.org` into the tool cache. Without `node-version` or `node-version-file`, the step logs `No node-version specified; using the pre-installed node <version>.` Other inputs, such as `mirror`, run the real action.

Outputs: `node-version` (for example `v22.22.0`), `cache-hit` and `cache-primary-key`.

### actions/setup-python

| Input | Notes |
| --- | --- |
| `python-version` | One CPython version or range, such as `3.12`, `3.11.9`, `3.x` or `3.14-dev`. PyPy and GraalPy versions run the real action. |
| `python-version-file` | `.python-version`, `.tool-versions` (`python`), `pyproject.toml` (`requires-python`), or a file whose first non-comment line is the version. Without either input, `.python-version` in the workspace is used if present. |
| `allow-prereleases` | Falls back to a pre-release build when no stable release matches. A version ending in `-dev` does the same. |
| `cache`, `cache-dependency-path` | `pip` or `pipenv`. Other values run the real action. See [Dependency caching with setup actions](/docs/actions/caching-and-artifacts#dependency-caching-with-setup-actions). |
| `architecture`, `check-latest`, `token`, `update-environment` | Accepted. An `architecture` other than the runner's, or `update-environment: false`, runs the real action. |

Hosted runners have Python 3.12. A request that it satisfies uses it. Other versions are installed from the `actions/python-versions` builds that GitHub publishes, and the step sets `pythonLocation`, `Python_ROOT_DIR`, `Python3_ROOT_DIR`, `PKG_CONFIG_PATH` and `LD_LIBRARY_PATH` like the original action. Other inputs, such as `freethreaded`, run the real action.

Outputs: `python-version`, `python-path` and `cache-hit`.

### actions/setup-go

| Input | Notes |
| --- | --- |
| `go-version` | A version or range, `stable` or `oldstable`. |
| `go-version-file` | `go.mod` or `go.work` (`toolchain` line first, then `go`), `.tool-versions` (`golang` or `go`), or a file whose first line is the version. |
| `check-latest` | Download the newest matching version. |
| `cache`, `cache-dependency-path` | On by default. Without a `go.sum` in the workspace root, the step warns `Restore cache failed: ...` and continues. |
| `architecture`, `token` | Accepted. An `architecture` other than the runner's runs the real action. |

Go isn't preinstalled on hosted runners, so the step downloads it from `go.dev`. Without a version on a runner that has no Go, it fails with `No go-version specified and Go is not installed on this runner.`

Outputs: `go-version` and `cache-hit`.

### actions/cache and artifacts

`actions/cache`, `actions/cache/restore`, `actions/cache/save`, `actions/upload-artifact` and `actions/download-artifact` support the official actions' inputs and outputs, including `retention-days`, `overwrite`, `compression-level`, `archive`, downloading all artifacts, `pattern`, `merge-multiple`, `artifact-ids`, and `run-id` with `github-token`. Caches are scoped per ref as on GitHub, each repository keeps up to 10 GB of caches, and artifacts are zip files kept for up to 90 days. [Caching and artifacts](/docs/actions/caching-and-artifacts) has the details.

### actions/github-script

`actions/github-script` isn't a built-in: the real action runs, and its `github` client talks to Diffinery's REST API (`GITHUB_API_URL`) with the job token. What it may do follows the job's `permissions:`:

```yaml
jobs:
  label:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      pull-requests: write
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            await github.rest.issues.addLabels({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              labels: ["needs-review"],
            });
```

`github.graphql` works for what Diffinery's [GraphQL API](/docs/reference/graphql-api) answers (repositories, issues, pull requests and CI), with the job token and its `permissions:`. REST calls to endpoints Diffinery doesn't have get a JSON `404 Not Found`. See [the REST API reference](/docs/reference/rest-api) for the endpoints Diffinery has.

## Other actions

Any other `uses: owner/repo[/path]@ref` (and a built-in action the built-in doesn't cover) is downloaded from GitHub (`codeload.github.com`, or with `git` from `github.com` when that endpoint can't be reached) when the step runs and executed according to its `action.yml` or `action.yaml`.

### JavaScript actions

Actions with `runs.using: node12`, `node16`, `node20`, `node24` or any other `node<version>` run with the runner's own Node.js 22, whatever version they ask for. `pre`, `main`, `post`, `pre-if` and `post-if` are supported.

One difference: on GitHub, `pre` scripts run at the start of the job, before any step. On Diffinery, an action's `pre` script runs immediately before its `main` script, as part of the same step. Post scripts run at the end of the job in reverse order, as on GitHub.

### Composite actions

Composite actions (`runs.using: composite`) are supported, including `inputs`, `outputs`, `env`, `if`, `shell`, `working-directory` and nested `uses`. Composite actions nest at most 10 levels; deeper nesting fails with `Composite action nesting is too deep (max 10).`

### Docker container actions

Actions with `runs.using: docker` are supported, with `runs.image` set to a `Dockerfile` in the action (built on the runner) or a `docker://` image, plus `args`, `entrypoint`, `env`, `pre-entrypoint` and `post-entrypoint`. A step can also run an image directly with `uses: docker://image`. Hosted runners have Docker; self-hosted runners need it installed. See [Docker container actions](/docs/actions/docker#docker-container-actions).

### Local actions

`uses: ./path/to/action` reads the action from the workspace, so check out the repository first. Otherwise the step fails with `Can't find 'action.yml' or 'action.yaml' under '<dir>'. Did you forget to run actions/checkout before running your local action?`

### Actions stored on Diffinery

`uses: acme/my-action@v1` always means the repository `acme/my-action` on GitHub, not on Diffinery. Actions in private GitHub repositories can't be used on hosted runners, because the download has no GitHub credentials. A [self-hosted runner](/docs/actions/runners#self-hosted-runners) can authenticate downloads with `DIFFINERY_GITHUB_TOKEN` in its environment. To use an action that lives in a Diffinery repository, check it out into a directory and use it as a local action:

```yaml
      - uses: actions/checkout@v4
        with:
          repository: acme/my-action
          ref: v1
          path: .actions/my-action
          token: ${{ secrets.ACTIONS_READ_TOKEN }}
      - uses: ./.actions/my-action
```

`ACTIONS_READ_TOKEN` is a personal or agent token with read access to `acme/my-action`, stored as a secret, because the job token can't read other private repositories. If `acme/my-action` is public, leave `token` out: the job token can read public repositories.

### Unsupported action runtimes

Any other `runs.using` value fails the step with `Unsupported action runtime 'runs.using: <value>' in <action>`.

A version or repository that doesn't exist on GitHub fails with `Unable to resolve action '<owner>/<repo>@<ref>', repository or version not found`. A reference without `@ref` fails with `Expected format {owner}/{repo}[/path]@ref. Actual '<value>'`.

### Actions that call the GitHub API

Actions built on `@actions/github` or Octokit read `GITHUB_API_URL` and `GITHUB_SERVER_URL`, which point at Diffinery, and authenticate with the job token. Diffinery's REST API uses GitHub's paths, JSON shapes, `Link` header pagination and error format, so calls to endpoints Diffinery has work (see [REST API](/docs/reference/rest-api)), within the job's `permissions:` (see [GITHUB_TOKEN and permissions](#github_token-and-permissions)). The same goes for the [GraphQL API](/docs/reference/graphql-api), for the issues, pull requests and CI it answers, so `gh` works in a job with `GH_TOKEN: ${{ github.token }}`.

### Actions that use the cache or artifact services

Diffinery sets `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RESULTS_URL`, `ACTIONS_CACHE_URL`, `ACTIONS_RUNTIME_URL` and `ACTIONS_CACHE_SERVICE_V2` for JavaScript actions, Docker container actions and the built-ins (not for `run:` steps, as on GitHub). Actions that use the `@actions/cache` or `@actions/artifact` packages directly, and `docker/build-push-action` with `cache-from: type=gha` and `cache-to: type=gha`, store their caches and artifacts in Diffinery. See [The runtime services](/docs/actions/caching-and-artifacts#the-runtime-services).

The official `actions/upload-artifact` and `actions/download-artifact` refuse to run on a server that looks like GitHub Enterprise Server, so the runner shows them `GITHUB_SERVER_URL=https://github.com`. Their API calls still go to Diffinery, and their `artifact-url` output is rewritten to point at Diffinery.

## Contexts and environment variables

| Value | GitHub | Diffinery |
| --- | --- | --- |
| `github.server_url`, `GITHUB_SERVER_URL` | `https://github.com` | `https://diffinery.com` |
| `github.api_url`, `GITHUB_API_URL` | `https://api.github.com` | `https://diffinery.com/api/v3` |
| `github.run_id`, `GITHUB_RUN_ID` | A number, unique per run | A number: the run's number, the same as `github.run_number`. The API accepts it wherever it takes a run id. |
| `github.repository_id` | A number | Diffinery's repository ID, a string |
| `github.ref_protected` | `true` for protected branches | Always `false` |
| `github.event.repository` | GitHub's repository object | The same object, with Diffinery's values; `id` is numeric and `private` and `visibility` reflect the repository |
| `github.actor` for scheduled runs | The last person who edited the cron | `diffinery-scheduler` |
| `github.token`, `secrets.GITHUB_TOKEN` | The job token | The job token, also available as `secrets.DIFFINERY_TOKEN` |
| `github.actor_id`, `github.repository_owner_id`, `github.workflow_sha` | Set | Not set |
| `runner.os`, `RUNNER_OS` | `Linux`, `Windows` or `macOS` | Always `Linux`, also on self-hosted macOS machines |
| `runner.name`, `RUNNER_NAME` | The runner's name | `diffinery` |
| `runner.environment`, `RUNNER_ENVIRONMENT` | `github-hosted` or `self-hosted` | `diffinery-hosted`, also on self-hosted runners |
| `DIFFINERY` | Not set | `true` |

`CI=true` and `GITHUB_ACTIONS=true` are set as on GitHub, so tools that detect GitHub Actions keep working. To run a step only on one forge, check the server URL:

```yaml
      - if: github.server_url == 'https://diffinery.com'
        run: echo "Running on Diffinery"
```

The complete list is in [Expressions and contexts](/docs/actions/expressions).

## GITHUB_TOKEN and permissions

Every job gets a token, available as `secrets.GITHUB_TOKEN`, `secrets.DIFFINERY_TOKEN` and `github.token`. As on GitHub:

- Its permissions come from the job's `permissions:`, else the workflow's, else the repository's default. `read-all`, `write-all`, `{}` and per-scope maps work as on GitHub, and a map sets every scope it doesn't list to `none`.
- Each REST endpoint needs its scope (`contents`, `issues`, `pull-requests`, `statuses`, `checks`, `deployments`, `actions`, `packages` and so on). A request without it gets `403 Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: <scope>: <level>)`.
- It never administers the repository, never reads or changes secrets and variables, and never creates or changes workflow files. Branch protection applies to it.
- It can open and approve pull requests only when the repository allows it, and its approvals don't count toward required reviews.
- It can read any public repository on Diffinery, but no other private repository.
- What it does starts no new runs, except `workflow_dispatch`.
- It stops working when the job completes.

Differences:

- New repositories default to read-only tokens (`contents` and `packages` read), as GitHub does for new repositories. Repositories created before this setting existed default to read and write. An admin changes it on the repository's **Settings → Actions** tab or with `PUT /repos/{owner}/{repo}/actions/permissions/workflow`.
- A run whose code came from an agent is held to the agent rules, so its token can't push or merge to the default branch or protected branches.

[GITHUB_TOKEN permissions](/docs/actions/workflow-permissions) has the full model, the scope each endpoint needs, and how to change the default.

## Secrets, variables and environments

| Feature | Status |
| --- | --- |
| Repository secrets and variables | Supported |
| Organization secrets | Supported (CLI and API) |
| Organization variables | Supported, through the REST API. Every repository in the organization sees them (no `private` or `selected` visibility). See [Organization variables](/docs/actions/secrets-and-variables#organization-variables). |
| Environments with deployment branch policies (protected branches only, or branch and tag patterns) | Supported, through the REST API. See [Environments](/docs/actions/environments). |
| Environment secrets and variables | Supported, through the REST API. They win over repository and organization values with the same name. Pull request runs never get environment secrets, and runs started by agents get them only from environments limited to protected branches. |
| Team reviewers and custom deployment protection rules | Not supported. Required reviewers are people. |
| Setting secrets with a sealed-box `encrypted_value` | Not supported yet. Send the plain `value` over HTTPS; it's encrypted at rest. |
| Secrets in `pull_request` runs | Provided, because every pull request comes from a branch of the same repository |
| Changing secrets and variables with an agent's token | Refused: only people manage secrets and variables |
| Secret names starting with `GITHUB_` | Rejected for repository secrets, as on GitHub |

See [Secrets and variables](/docs/actions/secrets-and-variables).

## Reusable workflows and OIDC

Reusable workflows work as on GitHub, with these limits: they must live on the same Diffinery instance, calls nest at most 4 levels deep, one run calls at most 20, and a calling job can't have a matrix yet. See [Differences from GitHub](/docs/actions/reusable-workflows#differences-from-github) in Reusable workflows.

OIDC works with `permissions: id-token: write`, and tokens are issued by `https://diffinery.com`. Configure your cloud provider to trust that issuer instead of `https://token.actions.githubusercontent.com`. The claims differ in a few places; see [Differences from GitHub](/docs/actions/oidc#differences-from-github) in OIDC.

## Porting checklist

Work through this list for each workflow you move from GitHub. Most workflows need only the first two items.

1. Run `diffinery workflow validate` on each file and fix any errors. Read the warnings for ignored keys.
2. Push and watch the first run with `diffinery run watch` or on the **Actions** tab.
3. Replace `runs-on: windows-*` and `macos-*` with Linux, or with `[self-hosted, ...]` labels and a [self-hosted runner](/docs/actions/runners#self-hosted-runners). This includes `matrix.os` values used in `runs-on`.
4. Add `apt-get update` before `apt-get install`.
5. Install tools the hosted image doesn't have (Go, Java, Ruby, Rust, PowerShell, cloud CLIs) with a setup action or `apt-get`.
6. Check what each job does with `GITHUB_TOKEN`. In a new repository the default token only reads, so give jobs that push, tag, comment, label or merge the `permissions:` they need, or have an admin set the repository default to write (see [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions)). Jobs that change workflow files, or that open or approve pull requests without the repository allowing it, need a personal or agent token from a secret.
7. Give `actions/checkout` of another private repository a token from a secret.
8. Recreate your environments, their branch policies, secrets and variables through the REST API (see [Environments](/docs/actions/environments)), and set required reviewers by Diffinery login (GitHub's numeric ids and teams don't carry over).
9. Check `github.graphql` calls in `actions/github-script`: queries about issues, pull requests and CI work; replace others with REST calls.
10. Replace `ghcr.io` with your instance's host (`diffinery.com` here) in image names and logins; see [Container registry](/docs/packages/container-registry#migrating-from-ghcrio).
11. Replace hard-coded `github.com` and `api.github.com` URLs with `${{ github.server_url }}` and `${{ github.api_url }}`.
12. Update OIDC trust policies in your cloud accounts to the Diffinery issuer and subject format.
13. Move actions from private GitHub repositories into a Diffinery repository and use them as local actions.

[Migrate from GitHub](/docs/migrate-from-github#workflows) covers moving the rest of the repository.

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| `No Diffinery runner matches runs-on: <labels>. ...` | The labels aren't hosted Linux labels and don't include `self-hosted`. Use `ubuntu-latest`, or `[self-hosted, ...]` with a registered runner. For a matrix job, check the value `runs-on` got for that combination. |
| `Error evaluating the job for this matrix combination: <message>` | An expression in `runs-on`, `name`, `timeout-minutes`, `continue-on-error` or `concurrency` failed for one matrix combination. |
| `Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: ...)` | Add the scope to the job's `permissions:`. See [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions). |
| `refusing to allow a GitHub App to create or update workflow ...` | Job tokens never change workflow files. Use a personal or agent token from a secret. |
| `GitHub Actions is not permitted to create pull requests. ...` | An admin allows it with `can_approve_pull_request_reviews`, and the job needs `pull-requests: write`. |
| `Unable to resolve action '<owner>/<repo>@<ref>', repository or version not found` | The action or version doesn't exist on GitHub, or the repository is private. |
| `Can't find 'action.yml' or 'action.yaml' under '<dir>'. ...` | Check out the repository before using a local action, and check the path. |
| `Unsupported action runtime 'runs.using: <value>' in <action>` | The action uses a runtime other than `node*`, `composite` or `docker`. |
| ``The `cmd` shell is not supported on Linux runners.`` | Use `bash` or `sh`. |
| `Failed to fetch ref '<ref>' from <owner>/<repo>. Check that the ref exists and the token has read access.` | Checking out another private repository needs a token from a secret, the job lacks `contents: read`, or the ref doesn't exist. |
| `No go-version specified and Go is not installed on this runner.` | Set `go-version` or `go-version-file`. |
| `jobs.<id>: a matrix on a job that calls a reusable workflow is not supported yet` | Move the matrix into the called workflow, or write one calling job per value. |
| `A matrix may produce at most 256 jobs.` | Split the matrix. |
| `A run may have at most 1000 jobs, ...` | Split the workflow, or trim its matrices. |
| `Composite action nesting is too deep (max 10).` | Flatten nested composite actions. |
| A built-in action behaves differently from the real one | Run the real action: set `DIFFINERY_BUILTINS: false` in the step's `env:`, or pin the action to a commit SHA. |
| A job is skipped although its `if:` looks true | A job further up its `needs` chain failed, was cancelled or was skipped, and the `if:` doesn't call a status function. Use `if: always() && ...` or `if: ${{ !cancelled() && !failure() }}`. |
