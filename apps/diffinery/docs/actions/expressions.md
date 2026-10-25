---
title: Expressions and contexts
description: The ${{ }} expression language in Diffinery workflows: operators, functions, every context property Diffinery sets, and the default environment variables.
---

Expressions let a workflow compute values and conditions at run time: `${{ github.ref_name }}`, `if: failure()`, `${{ fromJSON(needs.plan.outputs.matrix) }}`. Diffinery implements the GitHub Actions expression language, with the same syntax, operators, functions and type rules, and fills in the same contexts. This page is the reference for all of it, including the default environment variables every step gets and every difference from GitHub.

## Syntax

An expression is written between `${{` and `}}`:

```yaml
env:
  IMAGE: diffinery.com/acme/website:${{ github.sha }}
steps:
  - run: echo "Building ${{ github.ref_name }} for ${{ github.actor }}"
```

- In most values, each `${{ }}` is replaced by its result converted to a string, and the text around it is kept.
- When a value is exactly one expression (for example `matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}`), the result keeps its type: a list stays a list, a number stays a number.
- In `if:` conditions of jobs and steps, `${{ }}` is optional: `if: github.event_name == 'push'` is the same as `if: ${{ github.event_name == 'push' }}`.
- `}}` inside a single-quoted string doesn't end the expression. To write a literal `${{`, use `${{ '${{' }}`.
- Expressions in `on:` are not evaluated.

Every expression in a file is checked for syntax when the file is parsed. A mistake fails the file with `Invalid expression ${{ <expr> }}: <detail>` (or `Invalid expression: <detail>` in an `if:` without `${{ }}`), and an unclosed one with `Unclosed expression: '${{' at offset <n> has no matching '}}'`. Run `diffinery workflow validate` to catch these before you push.

> **Note:** In an `if:` that mixes text and expressions, such as `if: ${{ a }} && ${{ b }}`, the result is a string, which is true unless it's empty. Write the whole condition as one expression instead: `if: a && b`. GitHub behaves the same way.

## Literals

| Type | Examples | Notes |
| --- | --- | --- |
| null | `null` | |
| Boolean | `true`, `false` | |
| Number | `42`, `-1`, `3.14`, `2e3`, `0xff`, `0o17`, `NaN`, `Infinity` | Any JSON number, plus hexadecimal (`0x`) and octal (`0o`). A leading `-` or `+` is part of the number: there is no arithmetic and no unary minus. |
| String | `'hello'`, `'it''s'` | Single quotes only; write `''` for a quote. Double quotes fail with `Unexpected double quote; string literals use single quotes`. |

## Operators

| Operator | Meaning |
| --- | --- |
| `( )` | Grouping |
| `[ ]` | Index: `github.event['pull_request']`, `matrix.include[0]` |
| `.` | Property: `github.event.pull_request.title` |
| `.*`, `[*]` | Object filter (see below) |
| `!` | Not |
| `<`, `<=`, `>`, `>=` | Comparison |
| `==`, `!=` | Equality |
| `&&` | And |

The or operator is `||`. Precedence, from highest to lowest: property access and indexing, `!`, comparisons, equality, `&&`, `||`. There are no arithmetic operators, as on GitHub.

`&&` and `||` return one of their operands, not a boolean: `a && b` is `a` when `a` is falsy and `b` otherwise; `a || b` is `a` when `a` is truthy and `b` otherwise. That gives you defaults: `${{ inputs.tag || 'latest' }}`.

### Property access

- Property names are case-insensitive: `github.EVENT_NAME` reads `github.event_name`.
- Names may contain `-`: `steps.build-app.outputs.path`, `matrix.node-version`.
- Reading a property of something that doesn't have it gives `null` instead of an error, so `github.event.pull_request.title` is `null` on a push. An unknown context name is `null` too.
- Array indexes start at 0. An index out of range gives `null`.

### Object filters

`.*` collects a property from every item of an array or object and gives a list:

```yaml
- run: echo "${{ toJSON(github.event.pull_request.labels.*.name) }}"
- if: contains(github.event.pull_request.labels.*.name, 'deploy')
  run: ./deploy.sh
```

### Types and conversion

Comparisons convert values the way GitHub does:

| Rule | Example |
| --- | --- |
| Values of different types are compared as numbers. `null` is `0`, `true` is `1`, `false` is `0`, `''` is `0`, numeric strings are their number, and anything else is `NaN`. | `'1' == 1` is true, `null == 0` is true |
| Strings are compared case-insensitively. | `'Main' == 'main'` is true |
| A comparison with `NaN` is false. | `'abc' < 1` is false |
| Arrays and objects are only equal to themselves. | `fromJSON('[1]') == fromJSON('[1]')` is false |

Truthiness: `false`, `0`, `-0`, `NaN`, `''` and `null` are falsy; everything else, including every array and object, is truthy.

When a result is inserted into text: `null` becomes `''`, booleans become `true` or `false`, whole numbers have no decimals, and arrays and objects become JSON (indented by 2 spaces).

## Functions

Function names are case-insensitive. Calling an unknown function fails with `Unrecognized function '<name>'`, and a wrong number of arguments with `Function '<name>' expects <n> argument(s) but got <m>`.

| Function | Returns |
| --- | --- |
| `contains(search, item)` | If `search` is an array: `true` when an element equals `item` (with the equality rules above). Otherwise `true` when the string `search` contains `item`, ignoring case. |
| `startsWith(string, prefix)` | `true` when `string` starts with `prefix`, ignoring case. |
| `endsWith(string, suffix)` | `true` when `string` ends with `suffix`, ignoring case. |
| `format(string, value0, value1, ...)` | `string` with `{0}`, `{1}`, ... replaced by the values. Write `{{` and `}}` for literal braces. |
| `join(array, separator)` | The elements joined with `separator` (default `,`). A non-array is converted to a string. |
| `toJSON(value)` | `value` as JSON, indented by 2 spaces. |
| `fromJSON(string)` | The parsed value. Use it to turn strings into booleans, numbers, lists or objects. |
| `hashFiles(pattern, ...)` | A SHA-256 hash of the matching files, or `''` when none match (see below). |
| `success()`, `failure()`, `cancelled()`, `always()` | Status checks (see below). |

Examples:

```yaml
- run: echo "${{ format('{0}/{1}@{2}', github.repository_owner, github.event.repository.name, github.sha) }}"
- if: startsWith(github.ref, 'refs/tags/v')
  run: ./release.sh
- uses: actions/cache@v4
  with:
    path: ~/.npm
    key: npm-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}
```

Runtime errors from functions fail the step or job that evaluates them:

| Message | Cause |
| --- | --- |
| `fromJSON: invalid JSON "<text>": <detail>` | The argument isn't valid JSON. |
| `format: invalid format string '<string>'` | A `{` isn't followed by a number and `}`. |
| `format: invalid format string '<string>' (unescaped '}')` | A lone `}`. Write `}}`. |
| `format: placeholder {<n>} has no matching argument in '<string>'` | Not enough values. |

### hashFiles

`hashFiles` takes one or more glob patterns relative to `GITHUB_WORKSPACE` (`*`, `**`, `?`, `[...]`, and `!pattern` to exclude). It hashes each matching file with SHA-256, then hashes those hashes together, and returns the hex digest. Files outside the workspace and `.git` directories are ignored. It returns `''` when no file matches.

`hashFiles` only works in places evaluated on the runner, that is in steps, job `env`, `container`, `services` and `outputs`. Elsewhere (job `if`, `runs-on`, `strategy`, `name`) it returns `''`.

### Status check functions

In a job's `if:`, the functions look at all of the job's ancestors: the jobs in its `needs`, the jobs those need, and so on up the chain, as on GitHub.

| Function | True when |
| --- | --- |
| `success()` | The run hasn't been cancelled and every ancestor succeeded. A skipped or cancelled ancestor makes it false. |
| `failure()` | An ancestor failed or timed out. |
| `cancelled()` | The run has been cancelled. |
| `always()` | Always. |

A matrix job's result combines its legs: any failed leg fails it, otherwise any cancelled leg cancels it, and it's skipped when every leg was skipped. A leg that failed with `continue-on-error: true` counts as a success. A reusable workflow call's result combines the jobs inside it the same way.

In a step's `if:`:

| Function | True when |
| --- | --- |
| `success()` | No earlier step of the job failed (steps with `continue-on-error: true` don't count) and the job isn't being cancelled or timing out. |
| `failure()` | An earlier step failed, and the job isn't being cancelled or timing out. |
| `cancelled()` | The job is being cancelled or has hit its timeout. |
| `always()` | Always. |

When a job on a Diffinery-hosted runner is cancelled or hits its `timeout-minutes`, the step that is running stops, and then, as on GitHub, the remaining steps whose `if:` is true still run: `if: always()`, `if: cancelled()` and post steps such as the cache save with `save-always`. They have 5 minutes together. Use them to clean up what the job created, for example a test environment or a temporary repository. Cancelling the run a second time stops them at once. The job still ends as `cancelled` (or failed, after a timeout).

An `if:` that doesn't call any of these is treated as `success() && (<condition>)`. So `if: github.ref == 'refs/heads/main'` is skipped after a failure, while `if: always() && github.ref == 'refs/heads/main'` still runs. Inside a composite action, the functions look at the action's own steps.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - if: failure()
        run: echo "::error::Tests failed"
  notify:
    needs: test
    if: always()
    runs-on: ubuntu-latest
    steps:
      - run: echo "test finished with ${{ needs.test.result }}"
```

Because a job's default `if:` is `success()`, a skipped job skips every job that depends on it, directly or further down the chain. To run a job anyway, give it a status function, for example `if: always()` or `if: ${{ !cancelled() && needs.build.result != 'failure' }}`:

```yaml
jobs:
  build:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - run: make
  test:
    needs: build            # skipped when build is skipped
    runs-on: ubuntu-latest
    steps:
      - run: make test
  report:
    needs: test
    if: ${{ !cancelled() }} # runs even when build and test were skipped
    runs-on: ubuntu-latest
    steps:
      - run: echo "test result was ${{ needs.test.result }}"
```

## Contexts

### Where each context is available

Some values are evaluated by Diffinery before a job starts, and the rest by the runner while the job runs, so not every context is available everywhere:

| Where | Available contexts |
| --- | --- |
| `run-name`, top-level `concurrency` | `github`, `inputs`, `vars` |
| `jobs.<id>.if` | `github`, `needs`, `inputs`, `vars`, `env` (workflow-level values, unevaluated), status functions |
| `jobs.<id>.strategy` | `github`, `needs`, `inputs`, `vars`, `env` |
| `jobs.<id>.name`, `jobs.<id>.runs-on`, `jobs.<id>.timeout-minutes`, `jobs.<id>.continue-on-error`, `jobs.<id>.concurrency` | `github`, `needs`, `inputs`, `vars`, `env`, `matrix`, `strategy`. These are evaluated for each matrix combination. |
| `jobs.<id>.environment` (`name` and `url`) | `github`, `needs`, `inputs`, `vars`, `matrix`, `strategy`. A `url` that refers to `steps.` is ignored. |
| `jobs.<id>.with` (reusable workflow call) | `github`, `needs`, `inputs`, `vars` |
| `jobs.<id>.secrets` (reusable workflow call) | `github`, `needs`, `inputs`, `vars`, `secrets` |
| `jobs.<id>.env`, `container`, `services` | `github`, `needs`, `inputs`, `vars`, `secrets`, `matrix`, `strategy`, `runner`, `job` |
| Steps: `if`, `name`, `uses`, `run`, `with`, `env`, `shell`, `working-directory`, `continue-on-error`, `timeout-minutes` | `github`, `env`, `vars`, `secrets`, `matrix`, `needs`, `steps`, `runner`, `inputs`, `job`, `strategy` |
| `jobs.<id>.outputs` | Same as steps |
| `on.workflow_call.outputs` | `github`, `jobs`, `inputs`, `vars` |

In places evaluated before the job starts, `github.token` is empty and `github.workspace` isn't set, and `vars` and `secrets` hold only repository (and organization) values: a job's [environment](/docs/actions/workflow-syntax#environment) variables and secrets are added when the job starts, so they're available in steps, `jobs.<id>.env`, `container`, `services` and `outputs`, but not in `jobs.<id>.if`, `runs-on`, `name` or `environment` itself.

### github

Information about the run and the event. Most properties are also environment variables (see [Default environment variables](#default-environment-variables)).

| Property | Value |
| --- | --- |
| `github.event_name` | The event that started the run, for example `push`, `pull_request`, `release` or `repository_dispatch` |
| `github.event` | The event payload. See [Events that trigger workflows](/docs/actions/events) for each event's fields, for example `github.event.release.tag_name` for `release` and `github.event.client_payload` for `repository_dispatch`. |
| `github.sha` | The commit the run checks out. See the table in [Events that trigger workflows](/docs/actions/events#github_sha-and-github_ref-by-event). |
| `github.ref` | The full ref, for example `refs/heads/main`, `refs/tags/v1.2.0` (also for `release` runs) or `refs/pull/7/merge` |
| `github.ref_name` | The short ref: `main`, `v1.2.0`, or `7/merge` for pull requests |
| `github.ref_type` | `tag` for tags, `branch` otherwise |
| `github.ref_protected` | Always `false` |
| `github.head_ref` | The pull request's head branch for `pull_request` and `pull_request_target`, otherwise `''` |
| `github.base_ref` | The pull request's base branch for `pull_request` and `pull_request_target`, otherwise `''` |
| `github.repository` | `acme/website` |
| `github.repository_id` | The repository's ID |
| `github.repository_owner` | `acme` |
| `github.repositoryUrl` | `https://diffinery.com/acme/website.git` |
| `github.actor` | The login of the account that triggered the run (for a re-run, who re-ran it): for `release`, whoever published, edited or deleted the release; for `repository_dispatch`, the account whose token sent the event. Scheduled runs use `diffinery-scheduler`; merge queue groups use the login of whoever queued the pull request. |
| `github.triggering_actor` | Same as `github.actor` |
| `github.run_id` | The run number, as a string, for example `128`. It stays the same on a re-run, and the REST API accepts it wherever a run ID goes, so actions that parse it as a number work. |
| `github.run_number` | The run's number, as a string |
| `github.run_attempt` | `1`, or higher for re-runs, as a string |
| `github.workflow` | The workflow's `name`, or its path when it has none |
| `github.workflow_ref` | `acme/website/.github/workflows/ci.yml@refs/heads/main` |
| `github.job` | The job's ID (inside a reusable workflow, its ID in that workflow) |
| `github.server_url` | `https://diffinery.com` |
| `github.api_url` | `https://diffinery.com/api/v3` |
| `github.graphql_url` | `https://diffinery.com/api/graphql`. The job's token can't use the [GraphQL API](/docs/reference/graphql-api) yet |
| `github.token` | The job's token (same as `secrets.GITHUB_TOKEN`) |
| `github.workspace` | The workspace directory, `GITHUB_WORKSPACE` |
| `github.retention_days` | `90` |
| `github.secret_source` | `Actions` |
| `github.action` | `''` |
| `github.action_path` | Inside a composite action: the action's directory. Otherwise `''`. |
| `github.action_repository`, `github.action_ref` | Inside a composite action: the action's repository and ref. |

GitHub properties Diffinery doesn't set include `github.actor_id`, `github.repository_owner_id`, `github.workflow_sha`, `github.event_path` (use the `GITHUB_EVENT_PATH` variable), `github.env`, `github.path`, `github.output`, `github.state` and `github.step_summary` (use the environment variables of the same names).

> **Note:** `github.run_number` counts runs of all workflows in the repository, not each workflow separately as on GitHub. Because `github.run_id` is the run number, the two are always equal.

### env

Environment variables set in the workflow: the workflow's `env`, the job's `env`, the step's `env` and anything earlier steps wrote to `$GITHUB_ENV`. It doesn't include the default variables such as `GITHUB_SHA`; read those with `github.*` or in the shell.

```yaml
env:
  STAGE: production
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - if: env.STAGE == 'production'
        run: echo "Deploying to $STAGE"
```

### vars

The repository's variables, set under **Settings** > **Secrets and variables** or with `PUT /repos/{owner}/{repo}/actions/variables/{name}`. In a job with `environment:`, the environment's variables are added once the job starts and win over repository variables with the same name. Names are stored in upper case, and lookups ignore case. An unset variable is `''`. See [Secrets and variables](/docs/actions/secrets-and-variables) and [Environments](/docs/actions/environments).

### secrets

| Property | Value |
| --- | --- |
| `secrets.<NAME>` | A repository secret, or an organization secret shared with the repository (by its `visibility`; see [Organization secrets](/docs/actions/secrets-and-variables#organization-secrets)). A repository secret wins over an organization secret with the same name. In a job with `environment:`, the environment's secrets win over both (pull request runs, and some runs whose code came from an agent, don't get environment secrets; see [environment](/docs/actions/workflow-syntax#environment)). |
| `secrets.GITHUB_TOKEN` | The job's token. What it may do follows the job's `permissions:`; see [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions). |
| `secrets.DIFFINERY_TOKEN` | The same job token, under a Diffinery name. |

Secret names are stored in upper case and lookups ignore case; an unset secret is `''`. Inside a reusable workflow, `secrets` holds only what the caller passed (or everything with `secrets: inherit`), plus the two tokens. Secret values are masked in logs.

### matrix

The values of the current matrix combination, for example `matrix.os` and `matrix.node`. Empty for jobs without a matrix.

### strategy

| Property | Value |
| --- | --- |
| `strategy.fail-fast` | Whether `fail-fast` is on |
| `strategy.job-index` | This job's position in the matrix, from 0 |
| `strategy.job-total` | How many jobs the matrix produced |
| `strategy.max-parallel` | The effective `max-parallel` |

### needs

For each job in the job's `needs`:

| Property | Value |
| --- | --- |
| `needs.<job_id>.result` | `success`, `failure`, `cancelled` or `skipped`. For a matrix job: `failure` if any of its jobs failed or timed out, otherwise `cancelled` if any was cancelled, `skipped` if all were skipped, otherwise `success`. |
| `needs.<job_id>.outputs.<name>` | The job's outputs (strings). For a matrix job, the merged outputs of all its jobs. For a reusable workflow call, the called workflow's `on.workflow_call.outputs`. |

### steps

For each earlier step with an `id` in the same job (or the same composite action):

| Property | Value |
| --- | --- |
| `steps.<id>.outputs.<name>` | Outputs the step set with `$GITHUB_OUTPUT` or `::set-output` |
| `steps.<id>.outcome` | `success`, `failure`, `cancelled` or `skipped`, before `continue-on-error` |
| `steps.<id>.conclusion` | The same, after `continue-on-error` (a failed step with `continue-on-error: true` is `success`) |

### runner

| Property | Value |
| --- | --- |
| `runner.os` | `Linux` |
| `runner.arch` | `X64` on hosted runners (`ARM64`, `ARM` or `X86` on self-hosted machines with those processors) |
| `runner.name` | `diffinery` |
| `runner.environment` | `diffinery-hosted` |
| `runner.temp` | A temporary directory for the job; `/workspace/_temp` on hosted runners, where every job starts in a fresh container |
| `runner.tool_cache` | Where setup actions install tools; `/opt/hostedtoolcache` on hosted runners |
| `runner.workspace` | The parent of `GITHUB_WORKSPACE`; `/workspace` on hosted runners |
| `runner.debug` | `1` when debug logging is on (secret or variable `ACTIONS_STEP_DEBUG` set to `true`), otherwise `''`. `ACTIONS_RUNNER_DEBUG` doesn't change it. |

### job

| Property | Value |
| --- | --- |
| `job.status` | `success`, `failure` or `cancelled`: the job's state so far |
| `job.container.id`, `job.container.network` | The job container's ID and network, when the job has a `container` |
| `job.services.<name>.id`, `.network`, `.ports` | Each service container's ID, network and port mappings (`ports['5432']` is the host port) |

### inputs

For `workflow_dispatch` runs: the dispatch inputs, typed (booleans are booleans, numbers are numbers). Inside a reusable workflow: the inputs the caller passed with `with`, plus declared defaults. For other events: empty.

### jobs

Only in `on.workflow_call.outputs` of a reusable workflow: `jobs.<job_id>.result` and `jobs.<job_id>.outputs.<name>` for the called workflow's jobs.

## Default environment variables

Every step gets these variables. Workflows can't override the `GITHUB_*` and `RUNNER_*` ones; setting them in `env` has no effect. Paths are those of hosted runners, where the repository `acme/website` is checked out at `/workspace/website`.

| Variable | Value |
| --- | --- |
| `CI` | `true` |
| `GITHUB_ACTIONS` | `true` |
| `DIFFINERY` | `true`. Use it to detect Diffinery in scripts. |
| `GITHUB_REPOSITORY` | `acme/website` |
| `GITHUB_REPOSITORY_OWNER` | `acme` |
| `GITHUB_SHA` | The commit the run is about (see [Events that trigger workflows](/docs/actions/events#github_sha-and-github_ref-by-event)) |
| `GITHUB_REF` | The full ref |
| `GITHUB_REF_NAME` | The short ref (`main`, `v1.2.0`, `7/merge`) |
| `GITHUB_REF_TYPE` | `branch` or `tag` |
| `GITHUB_HEAD_REF` | The head branch for pull request events, otherwise empty |
| `GITHUB_BASE_REF` | The base branch for pull request events, otherwise empty |
| `GITHUB_RUN_ID` | The run number, as in `github.run_id` |
| `GITHUB_RUN_NUMBER` | The run's number |
| `GITHUB_RUN_ATTEMPT` | The attempt number |
| `GITHUB_JOB` | The job's ID |
| `GITHUB_ACTOR` | Who triggered the run |
| `GITHUB_TRIGGERING_ACTOR` | Same as `GITHUB_ACTOR` |
| `GITHUB_EVENT_NAME` | The event name |
| `GITHUB_EVENT_PATH` | A JSON file holding the event payload, `/workspace/_temp/_github_workflow/event.json` |
| `GITHUB_SERVER_URL` | `https://diffinery.com` |
| `GITHUB_API_URL` | `https://diffinery.com/api/v3` |
| `GITHUB_GRAPHQL_URL` | `https://diffinery.com/api/graphql`. The job's token can't use the [GraphQL API](/docs/reference/graphql-api) yet |
| `GITHUB_CUSTOM_API_URL`, `GITHUB_CUSTOM_SERVER_URL` | The same as `GITHUB_API_URL` and `GITHUB_SERVER_URL`. Tools built for GitHub Enterprise, such as super-linter, read these; without them they call api.github.com with the job's token |
| `GITHUB_WORKFLOW` | The workflow's name, or its path |
| `GITHUB_WORKFLOW_REF` | `acme/website/.github/workflows/ci.yml@refs/heads/main` |
| `GITHUB_WORKSPACE` | `/workspace/website` |
| `GITHUB_RETENTION_DAYS` | `90` |
| `GITHUB_ACTION` | The step's `id`, or `__run` for a `run` step without one (for actions, `__` plus the action's repository with other characters replaced by `_`) |
| `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_OUTPUT`, `GITHUB_STATE`, `GITHUB_STEP_SUMMARY` | Paths of the step's [environment files](/docs/actions/workflow-syntax#environment-files) |
| `RUNNER_OS` | `Linux` |
| `RUNNER_ARCH` | `X64` on hosted runners |
| `RUNNER_NAME` | `diffinery` |
| `RUNNER_ENVIRONMENT` | `diffinery-hosted` |
| `RUNNER_TEMP` | `/workspace/_temp` |
| `RUNNER_TOOL_CACHE` | `/opt/hostedtoolcache` |
| `RUNNER_WORKSPACE` | `/workspace` |
| `AGENT_TOOLSDIRECTORY` | Same as `RUNNER_TOOL_CACHE` |
| `ImageOS` | `ubuntu24`, as on GitHub's `ubuntu-24.04` image |
| `ImageVersion` | `20250101.1` |

Set only in some cases:

| Variable | When |
| --- | --- |
| `RUNNER_DEBUG` | `1` when the secret or variable `ACTIONS_STEP_DEBUG` or `ACTIONS_RUNNER_DEBUG` is `true` |
| `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RUNTIME_URL`, `ACTIONS_RESULTS_URL`, `ACTIONS_CACHE_URL`, `ACTIONS_CACHE_SERVICE_V2` | In JavaScript actions, Docker container actions and the built-in actions only, never in `run:` steps. They give access to the job's cache and artifact services and stop working when the job ends. See [Caching and artifacts](/docs/actions/caching-and-artifacts#the-runtime-services). |
| `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN` | When the job has `permissions: id-token: write`. Used by OIDC clients; see [OIDC](/docs/actions/oidc). |
| `GITHUB_ACTION_PATH`, `GITHUB_ACTION_REPOSITORY`, `GITHUB_ACTION_REF` | In JavaScript and Docker actions, and in the steps of composite actions |
| `INPUT_<NAME>` | In JavaScript and Docker actions: each input, with the name upper-cased and spaces replaced by `_` |
| `STATE_<NAME>` | In an action's main and post scripts: values saved with `$GITHUB_STATE` or `::save-state` |

Hosted runners also set `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `PIP_BREAK_SYSTEM_PACKAGES=1` (so `pip install` works with Ubuntu's Python) and `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`.

GitHub variables that Diffinery doesn't set include `GITHUB_ACTOR_ID`, `GITHUB_REPOSITORY_ID`, `GITHUB_REPOSITORY_OWNER_ID`, `GITHUB_WORKFLOW_SHA` and `GITHUB_REF_PROTECTED`. `GITHUB_TOKEN` isn't an environment variable unless you set it, as on GitHub:

```yaml
- run: gh api repos/${{ github.repository }}
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Differences from GitHub

- `jobs.<id>.environment.url` can't use step outputs.
- Job-level `if:` can also read the workflow-level `env`.
- `hashFiles()` returns `''` outside steps and other runner-evaluated values.
- `github.event.inputs` keeps the types of dispatch inputs; on GitHub its values are strings.
- `github.run_number` counts runs across all workflows of the repository, and `github.run_id` is the same number.
- On a re-run, `github.actor` is whoever started the re-run (and `github.triggering_actor` matches it).
- `github.ref_protected` is always `false`, and `secrets.DIFFINERY_TOKEN` is an extra name for the job token.
- `GITHUB_*` and `RUNNER_*` defaults can't be overridden, but `CI` and `DIFFINERY` can.
