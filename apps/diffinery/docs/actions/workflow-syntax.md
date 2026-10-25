---
title: Workflow syntax
description: Every workflow, job and step key Diffinery supports, how each behaves, which are ignored, and the exact errors you see when a file is invalid.
---

This page is the reference for the YAML in a Diffinery workflow file. Diffinery uses GitHub Actions workflow syntax, so most existing workflows run unchanged; for every key it says whether Diffinery supports it fully, partly or not at all, and what differs from GitHub.

For when workflows run, see [Events that trigger workflows](/docs/actions/events). For `${{ }}` expressions and contexts, see [Expressions](/docs/actions/expressions). For how runs execute and how to watch them, see [Actions overview](/docs/actions/overview).

## Workflow files

- Workflow files live directly in `.github/workflows/` or `.diffinery/workflows/` and end in `.yml` or `.yaml`. Files in subdirectories are ignored.
- A file holds one YAML document whose top level is a mapping. Anchors, aliases and merge keys (`<<: *defaults`) are supported.
- Keys are case-sensitive, as on GitHub.
- A file that fails validation never runs. When a push or merge group commit contains an invalid file, Diffinery records a failed run titled `Invalid workflow file: <first error>` whose single job, **Invalid workflow file**, lists every error.

A complete example that uses most features:

```yaml
name: CI
run-name: CI for ${{ github.ref_name }} by ${{ github.actor }}

on:
  push:
    branches: [main, "release/**"]
    paths-ignore: ["docs/**"]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read
  packages: write

env:
  NODE_ENV: test

defaults:
  run:
    shell: bash

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run lint

  test:
    needs: lint
    name: Test (node ${{ matrix.node }})
    runs-on: ubuntu-latest
    timeout-minutes: 30
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        node: [20, 22]
        include:
          - node: 22
            coverage: true
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: --health-cmd "pg_isready" --health-interval 5s --health-retries 10
    outputs:
      version: ${{ steps.meta.outputs.version }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - id: meta
        run: echo "version=$(jq -r .version package.json)" >> "$GITHUB_OUTPUT"
      - run: npm ci
      - run: npm test
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
      - if: ${{ matrix.coverage }}
        run: npm run coverage

  report:
    needs: test
    if: always()
    runs-on: ubuntu-latest
    steps:
      - run: echo "Tests ${{ needs.test.result }}, version ${{ needs.test.outputs.version }}"
```

## Validate workflow files

Check files before you push with the CLI. It uses the same parser as the server and needs no network access or token:

```sh
diffinery workflow validate                       # every file in .github/workflows and .diffinery/workflows
diffinery workflow validate .github/workflows/ci.yml
diffinery workflow validate --json                # machine-readable results
```

Each problem is printed as `<file>:<line>:<col>: error: <message> (<path>)` or `... warning: ...`, and the command exits with status 1 when any file has an error.

- **Errors** make the file invalid; it doesn't run.
- **Warnings** don't stop the file from running. You get one for every key Diffinery doesn't know (`unknown top-level key 'x'`, `unknown job key 'x'`, `unknown step key 'x'`, `unknown reusable-workflow job key 'x'`), for every event name it doesn't know (`unknown event 'x'`) and for unknown permission scopes (`unknown permission scope 'x'`). Unknown keys are ignored. The server doesn't show warnings, so run `validate` to see them.

On the server, the **Actions** tab, `diffinery workflow list` and `GET /repos/{owner}/{repo}/actions/workflows` show each invalid workflow's errors as `<path>:<line>: <message>`, for example `jobs.build.steps[0]:12: step must have either 'run' or 'uses'`.

## Top-level keys

| Key | Support | Notes |
| --- | --- | --- |
| `name` | Supported | Display name of the workflow. Default: the file's path. |
| `run-name` | Supported | Title of each run. Evaluated with the `github`, `inputs` and `vars` contexts. |
| `on` | Supported | The events that start the workflow. Required. See [Events that trigger workflows](/docs/actions/events). |
| `permissions` | Supported | What the job token (`GITHUB_TOKEN`) may do, for jobs without their own `permissions`. See [permissions](#permissions). |
| `env` | Supported | Environment variables for every job. |
| `defaults` | Supported | `defaults.run.shell` and `defaults.run.working-directory` for every `run` step. |
| `concurrency` | Supported | Groups runs and optionally cancels older ones. See [Concurrency](#concurrency). |
| `jobs` | Supported | The jobs to run. Required, with at least one job. |

Any other top-level key gives the warning `unknown top-level key '<key>'` and is ignored.

### name

```yaml
name: CI
```

The name appears in the **Actions** sidebar, in run lists, in check names (`CI / test`) and as `github.workflow` and `GITHUB_WORKFLOW`. Without `name`, the file's path (for example `.github/workflows/ci.yml`) is used everywhere a name is needed. `on: workflow_run` matches other workflows by this name.

### run-name

```yaml
run-name: Deploy ${{ inputs.environment }} by @${{ github.actor }}
```

Sets each run's title. It's evaluated once, when the run is created, with the `github`, `inputs` and `vars` contexts (as on GitHub). Without `run-name`, or if evaluation fails, the default title is used: the first line of the commit message for pushes, the pull request title for pull request events, `Merge group for #<n>: <title>` for merge groups, the release's name (or tag) for `release`, the `event_type` for `repository_dispatch`, and the workflow name for other events.

### on

Required. Without it the file fails with `workflow is missing the 'on' trigger section`. It can be a single event name, a list of names, or a mapping of event names to their configuration:

```yaml
on: push
```

```yaml
on: [push, pull_request]
```

```yaml
on:
  push:
    branches: [main]
  schedule:
    - cron: "0 3 * * 1-5"
```

An empty list or mapping fails with `'on' must define at least one event`. Event names, activity types, filters and the payload of each event are documented in [Events that trigger workflows](/docs/actions/events).

### env

```yaml
env:
  NODE_ENV: production
  RETRIES: 3
  VERBOSE: false
```

A mapping of variable names to strings, numbers or booleans (numbers and booleans become strings; an empty value becomes an empty string). Values may contain expressions; they're evaluated when each job starts. A value that is a list or mapping fails with `env.<name> must be a string, number or boolean`, and `env: ${{ fromJSON(...) }}` fails with `env must be a mapping (expressions producing whole mappings are not supported here)`.

Workflow `env` is merged with each job's `env` (the job wins) and then with each step's `env` (the step wins). Variables named `GITHUB_*` or `RUNNER_*` that Diffinery sets can't be overridden; other defaults such as `CI` can. See [Default environment variables](/docs/actions/expressions#default-environment-variables).

### defaults

```yaml
defaults:
  run:
    shell: bash
    working-directory: ./app
```

`defaults.run.shell` and `defaults.run.working-directory` apply to every `run` step that doesn't set its own. Job-level `defaults` override workflow-level ones key by key. They don't apply to `uses` steps or to the steps inside composite actions, as on GitHub. Values may contain expressions.

### permissions

```yaml
permissions:
  contents: read
  id-token: write
  packages: write
```

`permissions` may be `read-all`, `write-all`, an empty mapping (`{}`), or a mapping of scopes to `read`, `write` or `none`. Recognised scopes: `actions`, `attestations`, `checks`, `contents`, `deployments`, `discussions`, `id-token`, `issues`, `models`, `packages`, `pages`, `pull-requests`, `repository-projects`, `security-events` and `statuses`. Another scope gives a warning; another level fails with `permission '<scope>' must be 'read', 'write' or 'none'`.

They work as on GitHub:

- A job's `permissions` replace the workflow's. A job with neither gets the repository's default: read-only (`contents` and `packages` read) for repositories created since the setting was added, read and write for older ones.
- `read-all` gives every scope `read`; `write-all` gives every scope `write`, including `id-token`; `{}` gives nothing.
- In a mapping, every scope you don't list is `none`. A job that pushes images and checks out a private repository needs both `packages: write` and `contents: read`.
- Each REST endpoint and git operation needs its scope: `contents` for git fetch and push, files, releases and merges, `issues` for issues and labels, `pull-requests` for pull requests and reviews, `statuses`, `checks`, `deployments`, `actions` and so on. A request without it fails with `Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: <scope>: <level>)`.
- `id-token: write` lets the job request OIDC tokens (see [OIDC](/docs/actions/oidc)); `id-token: read` grants nothing. `packages` decides what the token can do in the [container registry](/docs/packages/container-registry).

Whatever `permissions` says, the token never administers the repository, never reads or changes secrets and variables, never creates or changes workflow files, and follows branch protection. [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions) has the full model, the scope each endpoint needs, and how an admin changes the repository default.

### concurrency

```yaml
concurrency: deploy-production
```

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

`group` is evaluated when the run is created, with the `github`, `inputs` and `vars` contexts. `cancel-in-progress` is `true`, `false` (the default) or an expression evaluated with the same contexts. With `true`, a new run cancels every unfinished run in its group. With `false`, the new run waits while another run in the group is in progress, and cancels older runs still waiting there (as on GitHub, a group has one waiting run at most). Groups are shared by all workflows of the repository, but a run on a protected branch is only cancelled by runs on that same branch; runs from elsewhere wait for it. See [Concurrency](/docs/actions/overview#concurrency) for the differences from GitHub.

A value that is neither a string nor a mapping with `group` fails with `concurrency must be a group string or a mapping with 'group'`.

## Jobs

`jobs` is a mapping of job IDs to job definitions. It's required (`workflow is missing the 'jobs' section`), must be a mapping (`'jobs' must be a mapping of job id to job`) and must hold at least one job (`'jobs' must define at least one job`).

A job ID must start with a letter or `_` and contain only letters, digits, `-` and `_`; otherwise the file fails with `job id '<id>' must start with a letter or '_' and contain only alphanumerics, '-' or '_'`.

### Job keys

| Key | Support | Notes |
| --- | --- | --- |
| `name` | Supported | Display name. May use `matrix`; evaluated for each matrix combination. |
| `needs` | Supported | Jobs that must finish first. |
| `if` | Supported | Condition evaluated before the job starts. |
| `runs-on` | Supported | Hosted Linux labels or self-hosted labels, plus `diffinery-large`, `-medium`, `-small` or `-tiny` to pick a hosted [runner size](/docs/actions/runners#runner-sizes). May use `matrix`; evaluated for each matrix combination. `group` is ignored. |
| `environment` | Supported | The deployment environment: its branch policy, required reviewers, wait timer, secrets and variables apply, and a deployment is recorded. See [environment](#environment). |
| `outputs` | Supported | Values passed to dependent jobs through `needs`. |
| `env` | Supported | Environment variables for every step of the job. |
| `defaults` | Supported | `defaults.run` for the job's `run` steps. |
| `steps` | Supported | Required for jobs that don't call a reusable workflow. |
| `timeout-minutes` | Supported | Default and maximum 360. |
| `strategy` | Supported | `matrix` with `include` and `exclude`, `fail-fast`, `max-parallel`. |
| `continue-on-error` | Supported | A failing job doesn't fail the run. See [continue-on-error (job)](#continue-on-error-job). |
| `container` | Supported | Runs the steps in a Docker container. |
| `services` | Supported | Starts service containers next to the job. |
| `uses` | Supported | Calls a reusable workflow. |
| `with` | Supported | Inputs for a reusable workflow. |
| `secrets` | Supported | Secrets for a reusable workflow, or `inherit`. |
| `permissions` | Supported | See [permissions (job)](#permissions-job). |
| `concurrency` | Supported | One job of a group runs at a time. See [concurrency (job)](#concurrency-job). |
| `snapshot` | Accepted, ignored | |

Any other key gives the warning `unknown job key '<key>'`.

### name (job)

```yaml
jobs:
  test:
    name: Test on node ${{ matrix.node }}
```

The job's display name in the UI and in check names (`<workflow name> / <job name>`). `GITHUB_JOB` and `github.job` stay the job's ID. It can use the `github`, `needs`, `inputs`, `vars`, `matrix` and `strategy` contexts. Without `name`, a job is named after its ID, and each matrix job gets its values appended, for example `test (ubuntu-latest, 22)`.

### needs

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{ run: make }]
  test:
    needs: build
    runs-on: ubuntu-latest
    steps: [{ run: make test }]
  deploy:
    needs: [build, test]
    runs-on: ubuntu-latest
    steps: [{ run: make deploy }]
```

A job ID or list of job IDs. A dependent job starts only after the jobs it needs have finished, and reads their results and outputs through the `needs` context. Errors:

- `Job '<id>' depends on unknown job '<other>'`
- `Dependency cycle between jobs: a -> b -> a`

A job starts as soon as every job it needs has finished, as on GitHub. It doesn't wait for unrelated jobs.

By default a job runs only when every job above it in the `needs` chain succeeded (a job with `continue-on-error: true` that failed counts as a success). If any of them failed, was cancelled or was skipped, the job is skipped too, and so are the jobs that need it. `needs.<id>.result` is `skipped` for a skipped job. Use a status function in `if` to change that, for example `if: ${{ !cancelled() && !failure() }}` to run after a skipped job; see [Status check functions](/docs/actions/expressions#status-check-functions).

### if (job)

```yaml
jobs:
  deploy:
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
```

The condition may be written with or without `${{ }}`. It's checked for syntax when the file is parsed (`Invalid expression: ...`) and evaluated just before the job starts, with the `github`, `needs`, `inputs`, `vars` and `env` (workflow-level) contexts. Without a status function the condition is treated as `success() && (<condition>)`, as on GitHub. A job whose condition is false is recorded as `skipped`. A runtime error fails the job with `Error evaluating 'if': <message>`.

### runs-on

```yaml
runs-on: ubuntu-latest
```

```yaml
runs-on: [self-hosted, linux, gpu]
```

```yaml
runs-on:
  labels: [self-hosted, macos]
```

A label, a list of labels, or a mapping with `labels` (and `group`, which Diffinery ignores). Required for jobs that don't call a reusable workflow (`job '<id>' is missing 'runs-on'`).

| Labels | Where the job runs |
| --- | --- |
| Only labels matching `ubuntu-*`, `linux`, `diffinery`, `diffinery-*`, `x64` or `amd64` (case-insensitive) | A Diffinery-hosted Linux container (Ubuntu 24.04, x64). `ubuntu-latest`, `ubuntu-22.04` and `ubuntu-24.04` all get the same image. `diffinery-large`, `diffinery-medium`, `diffinery-small` or `diffinery-tiny` picks its size; without one, the job's own earlier runs pick it. See [Runner sizes](/docs/actions/runners#runner-sizes). |
| Any list that includes `self-hosted` | A self-hosted runner whose labels include every label in the list. See [Runners](/docs/actions/runners). |
| Anything else (for example `windows-latest` or `macos-14` without `self-hosted`) | Nowhere. The job fails with `No Diffinery runner matches runs-on: <labels>. Linux (ubuntu-*) runners are hosted; anything else needs runs-on: [self-hosted, ...] and a registered runner.` |

Labels may be expressions, evaluated for each matrix combination with the `github`, `needs`, `inputs`, `vars`, `matrix` and `strategy` contexts. An expression can give one label or a list of labels:

```yaml
jobs:
  test:
    strategy:
      matrix:
        runner: [ubuntu-latest, [self-hosted, arm64]]
    runs-on: ${{ matrix.runner }}
```

If an expression fails, only that combination fails, with `Error evaluating the job for this matrix combination: <message>`. If it gives no labels, the job fails with `No Diffinery runner matches runs-on: (no labels). ...`.

### environment

```yaml
environment: production
```

```yaml
environment:
  name: production
  url: https://www.example.com
```

The deployment environment the job deploys to: a name, or a mapping with `name` and an optional `url`. Anything else fails the file with `environment must be a name or a mapping with 'name'`. Environments, their branch policies, secrets and variables are managed through the REST API; see [Environments](/docs/actions/environments) for the full guide.

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: ${{ github.ref_name == 'main' && 'production' || 'staging' }}
      url: https://${{ github.ref_name == 'main' && 'www' || 'staging' }}.example.com
    steps:
      - uses: actions/checkout@v4
      - run: ./deploy.sh
        env:
          API_KEY: ${{ secrets.DEPLOY_API_KEY }}     # an environment secret
          REGION: ${{ vars.REGION }}                 # an environment variable
```

What happens when a job with `environment` starts:

1. `name` and `url` are evaluated with the `github`, `needs`, `inputs`, `vars` (repository variables), `matrix` and `strategy` contexts. A `url` that refers to `steps.` is ignored, because step outputs don't exist yet when the job starts.
2. The name is checked: it must be 1 to 255 characters without `/`, `\` or control characters, otherwise the job fails with `invalid environment name '<name>'`. Names are case-insensitive. An environment that doesn't exist yet is created, with no branch policy.
3. The environment's deployment branch policy is checked against the run's ref (`GITHUB_REF`). If the ref isn't allowed, the job fails before any step runs with `<branch or tag> is not allowed to deploy to <name> due to environment protection rules.`
4. A deployment is recorded for the run's commit and ref, with the task `deploy`, marked as a production deployment when the environment is named `production` (in any case), and a deployment status `in_progress` whose log URL is the job's log. When `url` is an `http://` or `https://` URL, it's stored as the status's environment URL.
5. The environment's secrets are added to the `secrets` context and its variables to the `vars` context. They win over repository and organization secrets and variables with the same names. `GITHUB_TOKEN` and `DIFFINERY_TOKEN` can't be overridden.

When the job finishes, the deployment gets a final status: `success` when the job succeeded, `inactive` when it was cancelled, and `failure` otherwise (including timeouts). Each attempt of a re-run that runs the job again records its own deployment. When the job succeeds, older successful deployments to the same environment become `inactive` (newer ones are left alone, and production deployments are never made inactive this way). Read deployments with `GET /api/v3/repos/{owner}/{repo}/deployments`; webhooks subscribed to `deployment` get a `created` event for each deployment, and those subscribed to `deployment_status` get each status.

Environment secrets aren't always handed out, even when the branch policy allows the ref:

- Runs on pull request refs (`refs/pull/<n>/merge`, used by `pull_request` runs) never get environment secrets, because their code is whatever the pull request says.
- Runs whose code came from an agent (an agent started the run, pushed the branch last, or opened the pull request, and re-runs and `workflow_run` followers of such runs) get environment secrets only when the environment's policy is "protected branches only".

In those cases the job still runs, with the environment's variables but without its secrets (an unset secret is `''`).

Differences from GitHub:

- Required reviewers are people only (Diffinery has no teams), nobody bypasses the rules, and custom deployment protection rules aren't supported. See [Required reviewers and wait timers](/docs/actions/environments#required-reviewers-and-wait-timers).
- `url` can't use step outputs.
- The environment doesn't change the job token's permissions. To create deployment statuses yourself, give the job `deployments: write`.

A job that calls a reusable workflow (`uses`) can't set `environment` (you get the warning `unknown reusable-workflow job key 'environment'` and it's ignored). Set it on the jobs inside the called workflow instead.

### outputs

```yaml
jobs:
  version:
    runs-on: ubuntu-latest
    outputs:
      tag: ${{ steps.tag.outputs.value }}
    steps:
      - id: tag
        run: echo "value=v$(date +%Y.%m.%d)" >> "$GITHUB_OUTPUT"
  release:
    needs: version
    runs-on: ubuntu-latest
    steps:
      - run: echo "Releasing ${{ needs.version.outputs.tag }}"
```

A mapping of names to strings, usually expressions over `steps`. They're evaluated after the job's last step, with every context available to steps. An output whose value contains a secret is dropped with the log warning `Skip output '<name>' since it may contain secret.`; one that fails to evaluate is dropped with `Failed to evaluate job output '<name>': <message>`. Outputs appear under **Outputs** on the job page.

For a matrix job, the outputs of all its jobs are merged into `needs.<id>.outputs`; when two jobs set the same output, the one that was created later wins.

### env (job)

Like the [top-level `env`](#env), for one job. Job values override workflow values. Values may use any context available to steps except `env` itself and `steps` (they're evaluated before the first step).

### defaults (job)

Like the [top-level `defaults`](#defaults), for one job. Overrides the workflow's `defaults.run` key by key.

### steps (job)

A list of steps, required for a job that doesn't call a reusable workflow (`job '<id>' must have a list of 'steps'`) and not empty (`job '<id>' must have at least one step`). See [Steps](#steps).

### timeout-minutes (job)

```yaml
timeout-minutes: 20
```

A number or an expression (which may use `matrix`; evaluated for each matrix combination). Default: 360. Values above 360 are capped at 360, the longest a job can run on Diffinery. When the time is up, the runner logs `The job running on runner has exceeded the maximum execution time of <n> minutes.`, stops the job's processes, marks the remaining steps cancelled, and the job fails with `The job exceeded the maximum execution time of <n> minutes.`

### strategy

```yaml
strategy:
  fail-fast: true
  max-parallel: 3
  matrix:
    os: [ubuntu-22.04, ubuntu-24.04]
    node: [20, 22]
    exclude:
      - os: ubuntu-22.04
        node: 20
    include:
      - node: 22
        experimental: true
      - os: ubuntu-24.04
        node: 23
```

#### matrix

`matrix` is a mapping of variables to lists. Diffinery creates one job for every combination, then applies `exclude` and `include` with GitHub's rules:

1. Every combination of the lists is built.
2. `exclude` entries remove every combination they match. An entry matches when each of its keys equals the combination's value (a partial match is enough).
3. Each `include` entry is merged into every remaining combination whose original values it doesn't change. It may add new keys and may overwrite values added by an earlier `include`, but never a value from the original lists. If it can't be merged into any combination, it becomes a new combination of its own.

The example above produces `(ubuntu-22.04, 22, experimental)`, `(ubuntu-24.04, 20)`, `(ubuntu-24.04, 22, experimental)` and `(ubuntu-24.04, 23)`. Values are compared by their string form, so `18` equals `'18'`.

- A matrix with only `include` produces exactly the `include` entries.
- The whole matrix, any list, `include` or `exclude` can be a single `${{ }}` expression, for example `matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}`. Such expressions are evaluated when the job starts, with the `github`, `needs`, `inputs`, `vars` and `env` contexts.
- A matrix may produce at most 256 jobs. A larger one fails the job with `A matrix may produce at most 256 jobs.`
- Before `exclude` is applied, the vectors may have at most 4,096 combinations, and `include` and `exclude` at most 256 entries each. A larger matrix is refused before it is expanded (at parse time, or at run time for one built with `fromJSON`).
- The `matrix` and `strategy` contexts give each job its values (`strategy.job-index`, `strategy.job-total`, `strategy.fail-fast`, `strategy.max-parallel`).

Parse and runtime errors: `matrix produces no job combinations`, `matrix.<key> must be a list (got <type>)`, `matrix.include must be a list of mappings`, `matrix.exclude[<n>] must be a mapping`, `matrix must be a mapping or a single ${{ }} expression`, `the matrix has <n> combinations before exclusions; at most 4096 are allowed (and a matrix may produce at most 256 jobs)`, `matrix.include has <n> entries; at most 256 are allowed`, and at runtime `Error expanding matrix: <message>`.

#### fail-fast

`true` (the default), `false` or an expression. With `true`, when one job of the matrix fails or times out (and doesn't have `continue-on-error: true`), its unfinished sibling jobs are stopped and marked `cancelled` with the reason `Cancelled because <job name> failed (fail-fast).`

#### max-parallel

A number or an expression. At most this many jobs of the matrix run at the same time; the others stay queued and start as running ones finish. Default: all at once. When `fail-fast` stops the matrix, queued jobs are cancelled too.

### continue-on-error (job)

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    continue-on-error: ${{ matrix.experimental }}
    strategy:
      matrix:
        node: [20, 22]
        experimental: [false]
        include:
          - node: 24
            experimental: true
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci && npm test
```

`true`, `false` or an expression, evaluated for each matrix combination (it may use `matrix` and `strategy`). When a job with `continue-on-error: true` fails or times out:

- The job itself still shows as failed, but the run's conclusion isn't `failure` because of it.
- It doesn't trigger `fail-fast`, so its matrix siblings keep running.
- It counts as a success in `needs.<id>.result` and for the `success()` checks of the jobs that need it.

### container

```yaml
container:
  image: node:22-bookworm
  credentials:
    username: ${{ secrets.REGISTRY_USER }}
    password: ${{ secrets.REGISTRY_TOKEN }}
  env:
    NODE_ENV: test
  ports: [8080]
  volumes: ["/data:/data"]
  options: --cpus 2
```

Runs every `run` step and JavaScript action of the job inside a container started from `image`. A string is short for `image:`. Keys: `image` (required), `credentials` (`username` and `password`, both required when present), `env`, `ports`, `volumes` and `options` (extra `docker run` flags; `--network` is rejected because every container of a job shares one network). Values may use expressions. Hosted runners have Docker; self-hosted runners need it installed. Details are in [Docker in workflows](/docs/actions/docker).

### services

```yaml
services:
  redis:
    image: redis:7
    ports: ["6379:6379"]
    options: --health-cmd "redis-cli ping" --health-interval 2s --health-retries 15
```

A mapping of service names to the same keys as `container`. Each service starts before the first step, on the job's network, and Diffinery waits for its health check when the image or `options` define one. Steps in a job container reach a service by its name (`redis:6379`); steps on the runner reach it on `localhost` through its mapped ports. A service whose `image` evaluates to an empty string is skipped. See [Docker in workflows](/docs/actions/docker).

### uses, with and secrets (reusable workflows)

```yaml
jobs:
  call-tests:
    uses: ./.github/workflows/tests.yml
    with:
      node-version: 22
    secrets: inherit
  deploy:
    needs: call-tests
    uses: acme/shared-workflows/.github/workflows/deploy.yml@v2
    with:
      environment: production
    secrets:
      token: ${{ secrets.DEPLOY_TOKEN }}
```

A job with `uses` calls a reusable workflow instead of running steps. `uses` must be `./path/to/workflow.yml` (from the same commit) or `owner/repo/path/to/workflow.yml@ref` (from a repository on the same Diffinery instance); otherwise the file fails with `reusable workflow reference '<value>' must be './path/to/workflow.yml' or 'owner/repo/path/to/workflow.yml@ref'`.

Such a job may only have `name`, `uses`, `with`, `secrets`, `needs`, `if`, `permissions`, `concurrency` and `strategy`. `steps` and `runs-on` are errors (`a job that calls a reusable workflow ('uses') cannot have 'steps'`); other keys give the warning `unknown reusable-workflow job key '<key>'`. A `matrix` on a calling job isn't supported yet and fails the run with `jobs.<id>: a matrix on a job that calls a reusable workflow is not supported yet`.

Calls nest up to 4 levels deep, and one run can call at most 20 reusable workflows. Inputs, secrets, outputs and every error message are in [Reusable workflows](/docs/actions/reusable-workflows).

### permissions (job)

Same syntax as the [top-level `permissions`](#permissions). The job's value replaces the workflow's completely, as on GitHub: scopes the workflow grants but the job's mapping leaves out are `none` for this job. In a [reusable workflow](/docs/actions/reusable-workflows), a job's permissions can't exceed the calling job's. See [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions).

### concurrency (job)

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency:
      group: deploy-${{ github.ref }}
      cancel-in-progress: true
```

Same syntax as the top-level `concurrency`. At most one job of a group runs at a time across the whole repository, whichever run or workflow it belongs to. `group` and `cancel-in-progress` are evaluated for each matrix combination, with the `github`, `needs`, `inputs`, `vars`, `matrix` and `strategy` contexts.

- Without `cancel-in-progress`, a job waits with the status `pending` while another job of its group runs. Only the newest pending job is kept: a new pending job cancels the older one.
- With `cancel-in-progress: true`, the new job starts and the group's running and pending jobs are cancelled.
- A job cancelled by its group ends with the message `Canceling since a higher priority waiting request for '<group>' exists`.
- When a running job finishes, the oldest pending job of the group starts.

The concurrency of a job that calls a reusable workflow is ignored; set it on the jobs inside the called workflow.

## Steps

Each item in `steps` is a mapping. A step runs either a shell script (`run`) or an action (`uses`), never both.

| Key | Support | Notes |
| --- | --- | --- |
| `id` | Supported | Lets later steps read this step through `steps.<id>`. |
| `if` | Supported | Condition evaluated before the step. |
| `name` | Supported | Display name; may use expressions. |
| `uses` | Supported | An action: `owner/repo@ref`, `owner/repo/path@ref`, `./path` or `docker://image`. |
| `run` | Supported | A script run by `shell`. |
| `shell` | Supported | `bash`, `sh`, `python`, `pwsh`, `powershell` or a custom command with `{0}`. `cmd` fails. |
| `with` | Supported | Action inputs; scalar values only. |
| `env` | Supported | Environment variables for this step. |
| `continue-on-error` | Supported | `true`, `false` or an expression. |
| `timeout-minutes` | Partly | A number works; an expression is accepted but ignored. |
| `working-directory` | Supported | For `run` steps. |

Any other key gives the warning `unknown step key '<key>'`. A step with neither `run` nor `uses` fails with `step must have either 'run' or 'uses'`; one with both fails with `step cannot have both 'run' and 'uses'`.

### id

```yaml
- id: build
  run: echo "artifact=dist/app.tar.gz" >> "$GITHUB_OUTPUT"
- run: echo "${{ steps.build.outputs.artifact }} ${{ steps.build.outcome }}"
```

Must start with a letter or `_` and contain only letters, digits, `-` and `_` (`step id '<id>' must start with a letter or '_' and contain only alphanumerics, '-' or '_'`), and be unique within the job (`duplicate step id '<id>'`). The step's ID is also `GITHUB_ACTION` while it runs (`__run` for a `run` step without an ID).

### if (step)

```yaml
- if: failure() && steps.test.outcome == 'failure'
  run: ./collect-crash-logs.sh
```

With or without `${{ }}`. Evaluated just before the step, with every step context. Without a status function it's treated as `success() && (<condition>)`: the step is skipped once an earlier step has failed (and not set `continue-on-error`), or once the job is being cancelled. A skipped step's `outcome` and `conclusion` are `skipped`. An evaluation error fails the step with `Error evaluating 'if' condition: <message>`.

### name (step)

The step's title in the log. Without it, Diffinery uses `Run <uses>` or `Run <first line of the script>`, as on GitHub.

### uses

```yaml
- uses: actions/checkout@v4                 # an action repository
- uses: actions/cache/restore@v4            # an action in a subdirectory
- uses: ./.github/actions/setup             # a local action in the workspace
- uses: docker://alpine:3.20                # a Docker image
  with:
    entrypoint: /bin/sh
    args: -c "echo hello"
```

- `actions/checkout`, `actions/cache` (and `cache/restore`, `cache/save`), `actions/upload-artifact`, `actions/download-artifact`, `actions/setup-node`, `actions/setup-python` and `actions/setup-go` are built into the runner for their current major versions. A commit SHA, a branch, a newer major version, an input the built-in doesn't know, or `DIFFINERY_BUILTINS: false` in `env` runs the real action instead (see [Built-in actions](/docs/actions/compatibility#built-in-actions)).
- Other `owner/repo@ref` actions are downloaded from GitHub and run with their `action.yml`: JavaScript (`node*`), composite and Docker actions are supported. JavaScript actions run with the runner's Node.js 22 whatever `runs.using` says.
- `./path` actions are read from the workspace, so check out the repository first. Otherwise the step fails with `Can't find 'action.yml' or 'action.yaml' under '<dir>'. Did you forget to run actions/checkout before running your local action?`
- `docker://image` runs a container; `with.args` and `with.entrypoint` set its arguments and entrypoint.
- `actions/github-script` and other actions that call the API work with the job token, within its `permissions`.
- A reference without `@ref` fails with `Expected format {owner}/{repo}[/path]@ref. Actual '<value>'`. An unknown action or version fails with `Unable to resolve action '<owner>/<repo>@<ref>', repository or version not found`.

What each built-in action supports is in [GitHub Actions compatibility](/docs/actions/compatibility) and [Caching and artifacts](/docs/actions/caching-and-artifacts).

### with

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
    cache: npm
```

A mapping of input names to strings, numbers or booleans; lists and mappings fail with `<path> must be a string, number or boolean`. Values may contain expressions. JavaScript and Docker actions receive each input as `INPUT_<NAME>` (upper case, spaces replaced by `_`). Defaults from the action's `action.yml` fill in missing inputs; a missing required input without a default logs `Input required and not supplied: <name>`.

### run

```yaml
- name: Build
  run: |
    npm ci
    npm run build
```

The script is written to a temporary file and run with the step's shell from `working-directory` (default: `GITHUB_WORKSPACE`). Expressions in it are replaced before it runs. The step fails when the script exits with a non-zero status: `Process completed with exit code <n>.`

### shell

| Value | Command | Notes |
| --- | --- | --- |
| (not set) | `bash --noprofile --norc -eo pipefail {0}` | Falls back to `sh -e {0}` when `bash` isn't installed (for example in an Alpine job container). |
| `bash` | `bash --noprofile --norc -eo pipefail {0}` | |
| `sh` | `sh -e {0}` | |
| `python` | `python {0}` | Uses `python3` when there is no `python`. |
| `pwsh` | `pwsh -command ". '{0}'"` | PowerShell isn't installed on hosted runners; use a job container or self-hosted runner that has it. |
| `powershell` | `powershell -command ". '{0}'"` | Uses `pwsh` when there is no `powershell`. |
| `cmd` | | Fails with ``The `cmd` shell is not supported on Linux runners.`` |
| A command containing `{0}` | As written, with `{0}` replaced by the script's path | For example `node {0}` or `perl {0}`. The script file gets `.py`, `.ps1`, `.js` or `.sh` depending on the command. |

Anything else fails with `Invalid shell option '<value>'. Shell must be a valid built-in (bash, sh, python, pwsh) or a format string containing '{0}'`. A shell that isn't installed fails with `<command>: command not found. The shell '<value>' is not available on this runner.` (or `in the job container`).

> **Note:** On GitHub, a step without `shell` runs `bash -e {0}`, and only an explicit `shell: bash` adds `--noprofile --norc -o pipefail`. Diffinery always uses the stricter form, so a pipeline like `false | true` fails a step even when `shell` isn't set.

### env (step)

```yaml
- run: ./deploy.sh
  env:
    API_TOKEN: ${{ secrets.API_TOKEN }}
    TARGET: staging
```

Variables for this step only, on top of the workflow's, the job's and those added with `$GITHUB_ENV`. A step's values can refer to its earlier keys through `env`.

### continue-on-error (step)

```yaml
- run: npm run flaky-e2e
  continue-on-error: true
```

`true`, `false` or an expression that evaluates to `true` or `false`. When the step fails, its `outcome` is `failure` but its `conclusion` is `success`, the log shows `Step failed but continue-on-error is set; continuing.`, and later steps run as if it had succeeded.

### timeout-minutes (step)

```yaml
- run: npm test
  timeout-minutes: 10
```

A number of minutes (fractions allowed). When it's up, the step's processes are stopped and the step fails with `The step has timed out after <n> minutes.` Without it, only the job's timeout applies.

> **Note:** The parser accepts an expression here, but Diffinery currently ignores it and the step runs without its own timeout. Use a plain number.

### working-directory

```yaml
- run: npm test
  working-directory: packages/api
```

The directory a `run` step starts in, relative to `GITHUB_WORKSPACE` unless absolute. It must exist: otherwise the step fails with `An error occurred trying to start process '<shell>' with working directory '<dir>'. No such file or directory`.

## Workflow commands

Steps talk to the runner by printing lines in the form `::command key=value,key=value::message` to standard output or standard error, as on GitHub.

| Command | Effect |
| --- | --- |
| `::add-mask::<value>` | Masks the value as `***` in every later log line. Values shorter than 3 characters are not masked. |
| `::group::<title>` and `::endgroup::` | Folds the lines between them under a title in the log. |
| `::error file=<f>,line=<n>,title=<t>::<message>` | Logs an error. When the step fails, the last error it printed becomes the job's failure reason. |
| `::warning file=<f>,line=<n>,title=<t>::<message>` | Logs a warning. |
| `::notice file=<f>,line=<n>,title=<t>::<message>` | Logs a notice. |
| `::debug::<message>` | Logged only when debug logging is on: set the secret or variable `ACTIONS_STEP_DEBUG` to `true`. Debug logging also sets `RUNNER_DEBUG=1` and `runner.debug`. |
| `::set-output name=<name>::<value>` | Sets a step output. Deprecated on GitHub but still works; prefer `$GITHUB_OUTPUT`. |
| `::save-state name=<name>::<value>` | Saves state for an action's post step (`STATE_<name>`). |
| `::stop-commands::<token>` ... `::<token>::` | Stops processing commands until the token line, so you can print untrusted text. |
| `::echo::on` and `::echo::off` | Echoes processed commands into the log. |
| `::set-env` and `::add-path` | Disabled, as on GitHub. They log ``The `set-env` command is disabled. Please upgrade to using Environment Files.`` |

Annotations (`error`, `warning`, `notice`) are shown in the log with their file, line and title; only `file`, `line` and `title` are read, and other properties such as `col` are ignored. Diffinery doesn't attach annotations to files in pull requests.

## Environment files

Each step gets fresh, empty files whose paths are in these variables. Write to them to pass data on:

| Variable | Format | Effect |
| --- | --- | --- |
| `GITHUB_OUTPUT` | `name=value`, or `name<<EOF` ... `EOF` for multi-line values | Sets the step's outputs (`steps.<id>.outputs.<name>`). |
| `GITHUB_ENV` | `NAME=value`, or `NAME<<EOF` ... `EOF` | Sets environment variables for the following steps. `NODE_OPTIONS` values containing `--require` or `-r` are ignored. |
| `GITHUB_PATH` | One directory per line | Prepends the directories to `PATH` for the following steps. |
| `GITHUB_STEP_SUMMARY` | Markdown | Adds to the job summary shown on the job page. |
| `GITHUB_STATE` | `name=value` | Saves state for an action's post step. |

```yaml
- id: info
  run: |
    echo "sha_short=$(git rev-parse --short HEAD)" >> "$GITHUB_OUTPUT"
    {
      echo "CHANGELOG<<EOF"
      git log -5 --oneline
      echo "EOF"
    } >> "$GITHUB_ENV"
    echo "$HOME/.local/bin" >> "$GITHUB_PATH"
```

A malformed line logs `Unable to process file command '<env|path|output|state>' successfully: Invalid file command format: <line>` (or `Matching delimiter not found '<delimiter>'`) and marks an error.

## Masking

Every secret's value (each line separately for multi-line secrets), the job's token and every value passed to `::add-mask::` are replaced by `***` in log lines, step names, the job summary and the failure reason. Values shorter than 3 characters are never masked, because masking them would make logs unreadable. A job output that contains a masked value is dropped.

## Validation errors

The most common errors from the parser, with what to do:

| Message | Fix |
| --- | --- |
| `YAML syntax error: <detail>` | Fix the YAML at the reported line (indentation, quotes, tabs). |
| `workflow file is empty` | Add content, or delete the file. |
| `workflow is missing the 'on' trigger section` | Add `on:`. |
| `workflow is missing the 'jobs' section` | Add `jobs:`. |
| `job '<id>' is missing 'runs-on'` | Add `runs-on: ubuntu-latest`. |
| `job '<id>' must have a list of 'steps'` | Add `steps:` with at least one step. |
| `step must have either 'run' or 'uses'` | Give the step a `run` or `uses`. |
| `'branches' and 'branches-ignore' cannot be used together for the same event` | Use one of them, with `!` patterns for exceptions. The same applies to `tags`/`tags-ignore` and `paths`/`paths-ignore`. |
| `Invalid cron: <detail>` | Fix the `schedule` cron expression; see [schedule](/docs/actions/events#schedule). |
| `Unclosed expression: '${{' at offset <n> has no matching '}}'` | Close the expression. |
| `Invalid expression ${{ <expr> }}: <detail>` | Fix the expression syntax; see [Expressions](/docs/actions/expressions). |
| `<path> must be a mapping (expressions producing whole mappings are not supported here)` | Write `env`, `with` or `outputs` as a mapping and use expressions in the values. |
| `input '<name>' of type 'choice' must define 'options'` | Add `options:` to the `workflow_dispatch` input. |
| `input '<name>' must declare a 'type'` | `workflow_call` inputs need a `type`. |

## Limits

| Limit | Value |
| --- | --- |
| Job timeout | 360 minutes (default and maximum) |
| Jobs per matrix | 256 |
| Reusable workflow nesting | 4 levels |
| Reusable workflows called per run | 20 |
| Composite action nesting | 10 levels |
| Characters per log line | 16,384 (longer lines are cut and end with `…`) |

See [Limits](/docs/reference/limits) for the rest of Diffinery's limits.
