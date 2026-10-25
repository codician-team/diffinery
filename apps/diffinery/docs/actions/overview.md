---
title: Actions overview
description: How Diffinery Actions runs GitHub Actions workflows on Cloudflare, and how to start, watch, cancel and re-run runs from the web UI, CLI, API and MCP.
---

Diffinery Actions is the CI system built into every Diffinery repository. It reads GitHub Actions workflow files from your repository, runs their jobs in Linux containers on Cloudflare (or on your own machines), and reports the results as checks on commits and pull requests. Use it to build, test and deploy your code on push, on pull requests, on a schedule or on demand.

## Key concepts

| Term | Meaning |
| --- | --- |
| Workflow | A YAML file in `.github/workflows/` or `.diffinery/workflows/` that says when to run (`on:`) and what to run (`jobs:`). The syntax is GitHub Actions syntax. See [Workflow syntax](/docs/actions/workflow-syntax). |
| Event | Something that happens in the repository and can start a workflow: a push, a pull request update, a merge queue group, a manual dispatch, a schedule, another workflow's run, a published release or a `repository_dispatch` call. See [Events that trigger workflows](/docs/actions/events). |
| Run | One execution of one workflow for one event. A run has a number, a status and a conclusion, and holds one or more jobs. |
| Job | A set of steps that runs on one runner. Jobs run in parallel unless they depend on each other with `needs`. A matrix turns one job definition into several jobs. |
| Step | One command (`run:`) or one action (`uses:`) inside a job. Steps run in order in the same workspace. |
| Runner | The machine that executes a job. Diffinery-hosted runners are Cloudflare Containers; self-hosted runners are machines you connect with `diffinery runner`. See [Runners](/docs/actions/runners). |
| Check | The result of one job, reported on the commit the run is about. Branch protection can require checks to pass before merging. |
| Environment | A named deployment target, such as `production`, with its own secrets, variables and branch policy. A job that sets `environment:` gets them and records a deployment. See [Environments](/docs/actions/environments). |

Workflows are compatible with GitHub Actions: the same triggers, expressions, matrices, `needs`, outputs, caches, artifacts, secrets, environments, OIDC, a `GITHUB_TOKEN` that follows `permissions:`, the official actions (`actions/checkout`, `actions/cache`, `actions/upload-artifact`, `actions/download-artifact`, `actions/github-script`, `actions/setup-node`, `actions/setup-python`, `actions/setup-go` and the rest), and remote JavaScript, composite and Docker actions. Differences are called out on each page and collected in [GitHub Actions compatibility](/docs/actions/compatibility).

## Your first workflow

You need write access to the repository so you can push. This example runs the tests of a Node.js project on every push to `main` and on every pull request.

1. In a clone of `acme/website`, create `.github/workflows/ci.yml`:

   ```yaml
   name: CI
   on:
     push:
       branches: [main]
     pull_request:
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 22
             cache: npm
         - run: npm ci
         - run: npm test
         - name: Write a summary
           run: echo "### Tests passed on \`${{ github.ref_name }}\`" >> "$GITHUB_STEP_SUMMARY"
   ```

2. Check the file before you push. The CLI uses the same parser as the server:

   ```sh
   diffinery workflow validate .github/workflows/ci.yml
   ```

3. Commit and push:

   ```sh
   git add .github/workflows/ci.yml
   git commit -m "Add CI"
   git push origin main
   ```

4. Open `https://diffinery.com/acme/website/actions`. A run titled `Add CI` (the first line of the commit message) appears under **All workflows** and under **CI** in the sidebar. Click it to see its jobs, then click the `test` job to follow its log live.

5. Or follow it from your terminal:

   ```sh
   diffinery run list -R acme/website --limit 1
   diffinery run watch <run-id> -R acme/website
   ```

When the job finishes, the commit shows a check named `CI / test`. On a pull request, the same check appears on the pull request's head commit.

If you don't have the CLI yet, install it and sign in through your browser:

```sh
curl -fsSL https://diffinery.com/install | bash
diffinery login
```

## Where workflow files live

Diffinery reads workflow files from two directories at the root of the repository:

- `.github/workflows/`
- `.diffinery/workflows/`

Every file directly in one of these directories whose name ends in `.yml` or `.yaml` is a workflow. Files in subdirectories are ignored. There is no precedence between the two directories: workflows from both are loaded (`.github/workflows/` first), each one is its own workflow identified by its path, and each one that matches an event starts its own run. Use `.diffinery/workflows/` for workflows that only make sense on Diffinery, so a GitHub mirror of the repository doesn't try to run them.

When you name a workflow by file name rather than path (for example `deploy.yml` in `diffinery workflow run deploy.yml`), Diffinery picks the first file whose path is, or ends with `/deploy.yml`, so `.github/workflows/deploy.yml` wins over `.diffinery/workflows/deploy.yml`. Pass the full path to pick the other one.

Which version of a file runs depends on the event:

| Event | Workflow files are read from |
| --- | --- |
| `push` | The pushed commit |
| `pull_request` | The pull request's test merge commit (the head merged into the base) |
| `pull_request_target` | The base branch's current commit |
| `merge_group` | The merge group commit |
| `workflow_dispatch` | The branch or tag you choose |
| `schedule`, `workflow_run`, `repository_dispatch` | The default branch's current commit |
| `release` | The commit the release's tag points to |

The workflow list in the **Actions** sidebar and `GET /repos/{owner}/{repo}/actions/workflows` show the workflows on the default branch.

## How a run executes

1. **An event happens.** Diffinery loads the workflow files from the commit the event is about (see the table above) and checks each workflow's `on:` section, including branch, tag and path filters.
2. **A run is created** for each matching workflow, with status `queued`. It gets the next run number and a title: the `run-name` if the workflow sets one, otherwise the first line of the commit message (push), the pull request title (pull request events), `Merge group for #<n>: <title>` (merge groups), the release's name or tag (release), the `event_type` (repository_dispatch) or the workflow name (dispatch, schedule, workflow_run). If the workflow has a `concurrency` group, other runs in the group may be cancelled or this run may wait (see [Concurrency](#concurrency)).
3. **The run is orchestrated durably** by a Cloudflare Workflow. It walks the job graph from `needs`: each job starts as soon as the jobs it needs have finished, without waiting for unrelated jobs. The orchestration survives restarts of the platform, and each wait for a job lasts at most 6 hours.
4. **Each job is evaluated** just before it starts: its `if:` condition and its matrix. A job whose condition is false is recorded as `skipped`; without a status function in its `if:`, a job is also skipped when any job above it in the `needs` chain failed, was cancelled or was skipped. A matrix job becomes one job per combination (at most 256), started up to `max-parallel` at a time, and each combination gets its own `name`, `runs-on`, `timeout-minutes`, `continue-on-error` and job `concurrency` group, evaluated with its `matrix` values. A job with a `concurrency` group waits as `pending` while another job of the group runs.
5. **Each hosted job gets its own container.** A fresh Cloudflare Container (Ubuntu 24.04, linux/amd64) starts with a job token that is valid only for that job. The runner agent inside fetches the job definition (for a job with `environment:`, this is when the environment's branch policy is checked and its secrets and variables are added), runs the steps in order, streams the log back as it goes, and reports each step's result and the job's conclusion. The container stops when the job ends. Jobs for self-hosted runners wait until a `diffinery runner` with matching labels claims them instead.
6. **The run finishes** when every job is done. Its conclusion is `failure` if any job failed or timed out (except jobs with `continue-on-error: true`), otherwise `cancelled` if the run was cancelled or any job was cancelled, otherwise `skipped` if every job was skipped, otherwise `success`. Skipped jobs don't make a run fail. As on GitHub, a `workflow_run` job with `if: github.event.workflow_run.conclusion == 'success'` is skipped after a run whose jobs were all skipped.

   If the orchestration loses track of a run whose jobs have all finished (for example, a job's completion signal lost while the platform updates), Diffinery notices 5 minutes after the last job finished and signals the orchestration again. A run still unfinished 30 minutes after its last job, or whose orchestration has stopped, is finished by Diffinery itself, which frees its concurrency group. Jobs the run never started make it fail, and a `Set up workflow` job names them: `The run's workflow stopped after its jobs finished, so a job never started (deploy). Re-run the workflow.`

### Timeouts

| What | Default | Maximum |
| --- | --- | --- |
| A job (`jobs.<id>.timeout-minutes`) | 360 minutes | 360 minutes. Larger values are capped at 360. |
| A step (`steps[*].timeout-minutes`) | None (the job's timeout applies) | The job's timeout |
| Waiting for a self-hosted runner, plus running the job | | 6 hours, after which the job is marked timed out |

A job that runs past its `timeout-minutes` is stopped by its runner and fails with `The job exceeded the maximum execution time of <n> minutes.` If Diffinery hears nothing from a job for 6 hours (for example a self-hosted job that no runner picked up, or a runner that disappeared), it stops waiting, ends the job with `The job exceeded its timeout of <n> minutes.` and the conclusion `timed_out`, which the job page shows as **Timed out**.

### Run and job states

| Status | Meaning |
| --- | --- |
| `queued` | The run or job has been created and hasn't started. |
| `pending` | (Jobs) The job is held back by its job-level `concurrency` group until the group's running job finishes. Shown as **Pending**. |
| `waiting` | (Jobs) The job is waiting for its container to start, or for a self-hosted runner to claim it. |
| `in_progress` | The run is executing, or a runner has picked up the job. |
| `completed` | Finished. See the conclusion. |

| Conclusion | Meaning |
| --- | --- |
| `success` | Every step succeeded (steps with `continue-on-error: true` may have failed). |
| `failure` | A step failed, the job could not start, or (for runs) a job without `continue-on-error: true` failed. |
| `cancelled` | Someone cancelled the run, a newer run or job in the same concurrency group replaced it, or a sibling matrix job failed or timed out with `fail-fast` on. |
| `skipped` | The job's `if:` condition was false, or (for runs) every job was skipped. |
| `timed_out` | (Jobs) Diffinery waited 6 hours for the job without a result. |

## The Actions tab

Anyone who can read the repository can see its runs and logs (anyone at all for a public repository). Starting, cancelling and re-running runs needs write access.

### Runs list

`https://diffinery.com/acme/website/actions` shows the newest runs first, 25 per page.

- The sidebar lists **All workflows** and each workflow on the default branch by name. A workflow with errors shows a failure icon, and its page shows a **This workflow file has errors** box with each error and its line. The **All workflows** page shows **Some workflow files have errors** when any file is invalid.
- Filter by branch with the **Branch** menu (**All branches** by default) and by state with the **Status** menu: **Any status**, `queued`, `in progress`, `completed`, `success`, `failure` or `cancelled`. Click **Filter** to apply.
- Each row shows the run's title, workflow name, run number, attempt (when greater than 1), triggering event, pull request, actor (with an **agent** badge for agents), ref, age and duration.

The list updates live while you watch it.

### Run page

Click a run to open `https://diffinery.com/acme/website/actions/runs/<run-id>`. The run number works in place of the run ID (for example `.../actions/runs/128`) and opens its latest attempt. It shows:

- The run's **Status** and duration, what **Triggered** it and who, the **Commit** and ref (and pull request), and the **Workflow file** at that commit.
- One box per job id, listing the jobs it produced (a matrix job says how many, for example `4 jobs (matrix)`), each with its status, duration and, for a failed job, the first line of the failure reason.
- **Artifacts**, when jobs uploaded any that haven't expired, with their size and age. Click a name to download it: a `.zip` file, or the file itself for an artifact uploaded with `archive: false`. See [Caching and artifacts](/docs/actions/caching-and-artifacts).
- **Cancel run** while the run is not completed (you confirm with **Cancel this run?**), and **Re-run all jobs** once it has completed. Both need write access. A cancelled job on a Diffinery-hosted runner first runs its `if: always()` and `if: cancelled()` steps, for up to 5 minutes (see [Status check functions](/docs/actions/expressions#status-check-functions)); cancelling again stops them.

### Job page and logs

Click a job to open its log at `https://diffinery.com/acme/website/actions/runs/<run-id>/job/<job-id>`.

- The log is split into collapsible sections: **Set up job**, then one per step, then one per post step (for example `Post Run actions/cache@v4`). Failed and running steps open automatically.
- While the job runs, new lines stream in live.
- A failed job shows a box with **Failed at** the failing step and the reason: the step's own `::error::` message if it printed one, otherwise the exit code and the last lines of its output. Cancelled and timed-out jobs show **Cancelled** or **Timed out**.
- **Job summary** renders the Markdown that steps wrote to `$GITHUB_STEP_SUMMARY`.
- **Outputs** lists the job's outputs.
- **Raw logs** downloads the whole log as plain text, one line per log line prefixed with its timestamp. The page itself shows the first 20,000 lines and links to the full log when there are more.

Secret values, and values registered with `::add-mask::`, are replaced by `***` before log lines leave the runner.

## Start a workflow manually

A workflow with an `on: workflow_dispatch` trigger can be started on demand. You need write access.

```yaml
name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        description: Where to deploy
        type: choice
        options: [staging, production]
        default: staging
      dry-run:
        type: boolean
        default: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./deploy.sh "${{ inputs.environment }}" "${{ inputs.dry-run }}"
```

Input types, defaults and validation are described in [Events that trigger workflows](/docs/actions/events#workflow_dispatch).

### In the web UI

1. Open the **Actions** tab and click the workflow in the sidebar.
2. Expand **Run workflow** (shown when the workflow on the default branch has a `workflow_dispatch` trigger).
3. Pick the branch or tag under **Use workflow from**.
4. Fill in the inputs. Booleans are checkboxes, `choice` inputs are menus, `number` inputs are number fields, everything else is a text field. Required inputs are marked with `*`.
5. Click **Run workflow**. You land on the new run's page.

The form is built from the input definitions on the default branch; the run itself uses the workflow file at the ref you pick.

### With the CLI

```sh
diffinery workflow run deploy.yml -R acme/website --ref main \
  -f environment=production -f dry-run=false
```

| Flag | Meaning |
| --- | --- |
| `-r, --ref REF` | Branch or tag to run on. Default: the repository's default branch. |
| `-f, --field KEY=VALUE` | An input value. Repeat for more inputs. |
| `-R, --repo OWNER/NAME` | Repository. Default: inferred from the `origin` remote. |
| `--json` | Print the API response as JSON. |

The command prints the run ID and URL, and suggests `diffinery run watch <run-id>` to follow it.

### With the API

Use a token with the write scope (see [Tokens](/docs/accounts/tokens)):

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/actions/workflows/deploy.yml/dispatches \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"ref": "main", "inputs": {"environment": "production", "dry-run": false}}'
```

The workflow can be a file name (`deploy.yml`) or a URL-encoded path (`.github%2Fworkflows%2Fdeploy.yml`). Unlike GitHub, which answers `204 No Content`, Diffinery answers `201 Created` with the new run:

```json
{ "run_id": "3f9c2a7d0b8e4c1f9a6d5e2b7c4a1f08", "html_url": "https://diffinery.com/acme/website/actions/runs/3f9c2a7d0b8e4c1f9a6d5e2b7c4a1f08" }
```

| Status | Message | Cause |
| --- | --- | --- |
| 403 | `write access is required to run workflows` | Your role or token scope is below write. |
| 404 | `workflow deploy.yml not found at main` | No such file at that ref, or the file is invalid (the errors follow a colon). |
| 422 | `unknown ref <ref>` | The branch or tag doesn't exist. |
| 422 | `workflow does not have a workflow_dispatch trigger` | Add `on: workflow_dispatch` to the file at that ref. |
| 422 | `input '<name>' is required` | A required input is missing or empty and has no default. |
| 422 | `input '<name>' must be one of <a>, <b>` | A `choice` input got a value that is not in `options`. |

### With MCP

The `dispatch_workflow` tool takes `owner`, `repo`, `workflow`, an optional `ref` (default: the default branch) and an optional `inputs` object. See [MCP tools](/docs/reference/mcp-tools).

## Follow runs and read logs

### From the CLI

| Command | What it does |
| --- | --- |
| `diffinery run list` | Lists runs, newest first. Filter with `-b, --branch`, `-w, --workflow` (file name or path), `-s, --status`, `-e, --event`, `-c, --commit` and `-L, --limit` (default 20). |
| `diffinery run view <run-id>` | Shows a run and its jobs, with job IDs and failure reasons. |
| `diffinery run watch <run-id>` | Polls every 3 seconds (`-i, --interval SECONDS`) and prints each job's status changes. Exits 0 if the run succeeds and 1 otherwise, so you can use it in scripts. On failure it prints the `diffinery run logs` command for the failed job. |
| `diffinery run logs <job-id>` | Prints a job's log. With `--json`, prints the log lines as JSON objects with `seq`, `t` (timestamp), `step` (step index, `-1` for job setup) and `text`. |
| `diffinery run rerun <run-id>` | Re-runs a run; `--failed` re-runs only its failed jobs, and `--job <job-id>` one job (see [Re-run a run](#re-run-a-run)). |
| `diffinery run cancel <run-id>` | Cancels a queued or running run. |
| `diffinery workflow list` | Lists the workflows on the default branch, whether each is `active` or `invalid`, and their triggers. |
| `diffinery workflow validate [files...]` | Checks workflow files locally (see [Workflow syntax](/docs/actions/workflow-syntax#validate-workflow-files)). |

Every command takes `-R acme/website` when you're not inside a clone, and `--json` for machine-readable output. Full flags are in the [CLI reference](/docs/reference/cli).

A typical loop for an agent or a script after pushing:

```sh
run=$(diffinery run list -R acme/website --commit "$(git rev-parse HEAD)" --json | jq -r '.[0].id')
diffinery run watch "$run" -R acme/website || {
  job=$(diffinery run view "$run" -R acme/website --json | jq -r '.jobs[] | select(.conclusion == "failure") | .id' | head -n1)
  diffinery run logs "$job" -R acme/website | tail -n 100
}
```

### From the API

| Request | Returns |
| --- | --- |
| `GET /api/v3/repos/{owner}/{repo}/actions/workflows` | Workflows on the default branch, with `state` (`active` or `invalid`), `errors` and `triggers`. |
| `GET /api/v3/repos/{owner}/{repo}/actions/workflows/{workflow}` | One workflow on the default branch, by file name or URL-encoded path. Its `id` is its path. |
| `GET /api/v3/repos/{owner}/{repo}/actions/workflows/{workflow}/runs` | That workflow's runs, newest first. Takes `branch`, `status`, `event`, `head_sha`, `per_page` (at most 100, default 30) and `page`. |
| `GET /api/v3/repos/{owner}/{repo}/actions/runs` | Runs, newest first. Query parameters: `workflow`, `branch`, `status` (a status or a conclusion), `event`, `head_sha`, `per_page` (at most 100, default 25), `page`. |
| `GET /api/v3/repos/{owner}/{repo}/actions/runs/{run_id}` | One run with its `jobs`. |
| `GET /api/v3/repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt}` | Attempt `attempt` of the run (each attempt is its own run; see [Re-run a run](#re-run-a-run)). `404 run attempt not found` if there is no such attempt. |
| `GET /api/v3/repos/{owner}/{repo}/actions/runs/{run_id}/jobs` | The run's jobs, paginated with `per_page` (default 30) and `page`. |
| `GET /api/v3/repos/{owner}/{repo}/actions/runs/{run_id}/logs` | A zip file with one text file per job (`1_<job name>.txt`, `2_<job name>.txt`, ...), each line prefixed with its timestamp. Holds at most 24 MB of logs; jobs past that are left out. |
| `DELETE /api/v3/repos/{owner}/{repo}/actions/runs/{run_id}/logs` | Deletes every job's log and step summary for good (`204`); the run, its jobs, checks and artifacts stay. Needs write, and the run must have finished. Agents can delete only the logs of runs that didn't run on the default branch or a protected branch. Audited as `repo.actions.logs.delete`. |
| `GET /api/v3/repos/{owner}/{repo}/actions/jobs/{job_id}` | One job, with its steps, outputs, failure and summary. |
| `GET /api/v3/repos/{owner}/{repo}/actions/jobs/{job_id}/logs` | The log as text (`<timestamp> <line>` per line). Add `format=json` for JSON lines, and `after=<seq>` to get only lines after a sequence number. |
| `GET /api/v3/repos/{owner}/{repo}/actions/runs/{run_id}/artifacts` | The run's artifacts (every attempt when `run_id` is a run number), expired ones included. See [Download artifacts with the API](/docs/actions/caching-and-artifacts#download-artifacts-with-the-api) for the other artifact and cache endpoints. |
| `POST /api/v3/repos/{owner}/{repo}/actions/runs/{run_id}/cancel` | Cancels the run (`202`). Needs write. |
| `POST /api/v3/repos/{owner}/{repo}/actions/runs/{run_id}/rerun` | Re-runs every job of the run (`201`, `{"run_id": ...}`, the new attempt's ID). Needs write. |
| `POST /api/v3/repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs` | Re-runs the run's failed jobs and the jobs that depend on them (`201`, `{"run_id": ...}`). See below. |
| `POST /api/v3/repos/{owner}/{repo}/actions/jobs/{job_id}/rerun` | Re-runs one job and the jobs that depend on it (`201`, `{"run_id": ...}`). See below. |

Run objects use GitHub's field names (`id`, `node_id`, `run_number`, `run_attempt`, `name`, `display_title`, `path`, `workflow_id`, `event`, `head_branch`, `head_sha`, `sha`, `ref`, `status`, `conclusion`, `actor` and `triggering_actor` as user objects, `created_at`, `updated_at`, `run_started_at`, `url`, `html_url`, `jobs_url`, `logs_url`, `artifacts_url`, `cancel_url`, `rerun_url`, `workflow_url`, `previous_attempt_url` and `pull_requests`) plus `pull_request_number`. Job objects carry GitHub's fields (`run_id`, `run_attempt`, `head_sha`, `head_branch`, `html_url`, `started_at`, `completed_at`, `workflow_name`, `steps` with `number`) next to Diffinery's own camelCase fields, which the CLI reads. `head_sha` is the commit checks are reported on (the pull request head for pull request runs) and `sha` is the commit the run checked out. Run and job IDs are 32-character hexadecimal strings. Wherever a path takes `{run_id}`, the run number works too and means its latest attempt; this is what `github.run_id` and `GITHUB_RUN_ID` hold inside a job. A job's `check_run_url` points at `GET /repos/{owner}/{repo}/check-runs/{job_id}`, which returns the job's check run. While a job is running, one logs request returns at most 5,000 lines; page with `after`. The runs, jobs and artifacts lists send a `Link` header with `next`, `prev`, `first` and `last` URLs, so Octokit's `paginate()` works. Errors have a `message` and a `documentation_url`. Every endpoint is listed in the [API reference](/docs/api).

### From MCP

Agents can use `list_workflow_runs`, `get_workflow_run`, `get_job_logs` (the last 400 lines by default, set `tail` for more), `rerun_workflow` (with `failed_only` for the failed jobs only), `rerun_job`, `cancel_workflow` and `dispatch_workflow`. See [MCP tools](/docs/reference/mcp-tools).

## Cancel a run

Click **Cancel run** on the run page, run `diffinery run cancel <run-id>`, call `POST /actions/runs/{run_id}/cancel`, or use the `cancel_workflow` MCP tool. You need write access.

Cancelling stops every unfinished job's container at once and marks those jobs `cancelled` with the reason `Cancelled by <login>`. Jobs that haven't started yet and have no status function in their `if:` are skipped; a job with `if: always()` or `if: cancelled()` still runs, as on GitHub. The run's conclusion is `cancelled`.

## Re-run a run

You can re-run a run once it has finished, in three ways. You need write access.

| What runs again | Web | CLI | API | MCP |
| --- | --- | --- | --- | --- |
| Every job | **Re-run all jobs** on the run's page | `diffinery run rerun <run-id>` | `POST /actions/runs/{run_id}/rerun` | `rerun_workflow` |
| The failed jobs | **Re-run failed jobs** on the run's page (shown when a job failed, was cancelled or timed out) | `diffinery run rerun <run-id> --failed` | `POST /actions/runs/{run_id}/rerun-failed-jobs` | `rerun_workflow` with `failed_only: true` |
| One job | **Re-run this job** on the job's page | `diffinery run rerun --job <job-id>` | `POST /actions/jobs/{job_id}/rerun` | `rerun_job` |

Each re-run is a new attempt of the run, with:

- the same workflow file (read again from the original commit), commit, ref, event, event payload and inputs,
- the same run number and an attempt number one higher (shown as `attempt 2`, and available as `github.run_attempt`), so `github.run_id` stays the same,
- a new run ID in the API, and you as the actor,
- whether its code came from an agent, kept from the original run whoever re-runs it (see [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions#runs-whose-code-came-from-an-agent)).

**Re-run failed jobs** runs again, as on GitHub, every job and matrix leg whose conclusion was `failure`, `cancelled` or `timed_out`, and every job that depends on one of them through `needs`, directly or not (all of a dependent job's matrix legs run again). A job that never started because the run was cancelled first runs too. Jobs inside a [reusable workflow](/docs/actions/reusable-workflows) count like any other job, and a job that needs the calling job depends on every job inside the call. The other jobs and matrix legs are kept from the earlier attempt as they were: their conclusion, outputs, steps, log, summary and artifacts. They don't run again, start no runner and use no minutes, and they don't count toward `max-parallel`, so a matrix with `fail-fast` can't cancel a leg that already passed. Their check runs point at the new attempt with the same conclusion. On the run's page they're marked **Kept from an earlier attempt**, and in the API a kept job has `carriedFrom`, the ID of the job that ran. A run with no failed, cancelled or timed out job answers `409 this run has no failed jobs to re-run`.

**Re-run this job** works the same way for one job (one matrix leg): it runs again with every job that depends on it, and every other job is kept, whatever its conclusion.

The run's conclusion counts kept jobs like the others. The body field `enable_debug_logging` of the re-run endpoints is accepted and ignored.

Failed-job and single-job re-runs need a finished run (`409 this run hasn't finished yet; ...` otherwise). If what failed was the workflow's set-up (the file couldn't be read or a reusable workflow couldn't be loaded), every job runs again.

A workflow's own `GITHUB_TOKEN` can't re-run runs: `403 a workflow's GITHUB_TOKEN cannot re-run workflows`.

It fails with `422 workflow file no longer valid at this commit` if the file can't be loaded from that commit any more.

> **Note:** On GitHub a re-run keeps the same run ID in the API, and a kept job keeps its job ID and the attempt it ran in. On Diffinery the new attempt has a new `id` (the run number, `github.run_id`, stays the same), a kept job is a copy with its own ID in the new attempt, and its `run_attempt` is the new attempt's.

## Job summaries

Append Markdown to the file named by `$GITHUB_STEP_SUMMARY` in any step:

```yaml
- name: Report coverage
  run: |
    {
      echo "## Coverage"
      echo ""
      echo "| File | Lines |"
      echo "| --- | --- |"
      echo "| src/app.ts | 94% |"
    } >> "$GITHUB_STEP_SUMMARY"
```

Each step gets its own empty summary file. At the end of the job, the non-empty summaries of all steps are joined in step order, secrets are masked, and the result is shown under **Job summary** on the job page and returned as `summary` by `GET /actions/jobs/{job_id}`.

## Status checks on commits and pull requests

Every job reports a check on the commit the run is about:

- For `push`, `merge_group`, `workflow_dispatch`, `schedule`, `workflow_run`, `release` and `repository_dispatch` runs, that is the run's commit.
- For `pull_request` and `pull_request_target` runs, it is the pull request's head commit, even though the job checks out the test merge commit or the base commit.

The check is named `<workflow name> / <job name>`, for example `CI / test`, or `CI / test (ubuntu-latest, 22)` for a matrix job without a `name`. It becomes `queued` when the job is launched, `in_progress` when a runner picks it up, and `completed` with the job's conclusion. Its details link opens the job's log.

Pull requests show the checks of their head commit in the merge box and on the **Checks** tab. To block merging until checks pass, list them by these exact names under **Required status checks** in a branch protection rule; see [Branch protection](/docs/repositories/branch-protection).

External CI systems can report results too, as check runs (`POST /repos/{owner}/{repo}/check-runs`) or as commit statuses (`POST /repos/{owner}/{repo}/statuses/{sha}`, where the status's `context` is its name). Both count as checks for required checks and the merge queue. Read them with `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` and `GET /repos/{owner}/{repo}/commits/{ref}/status`. See [Checks and commit statuses](/docs/collaboration/checks-and-statuses).

How Diffinery decides a required check when several reporters use the same name:

- When Diffinery Actions reports a check with that name, only its result counts. Another reporter can't satisfy or override it.
- To have a required check decided by a specific reporter instead, bind it to that reporter in the branch protection rule through the API (`requiredCheckSources`, for example `{"ci/external": "ci-bot"}`, or `diffinery-actions` for Actions).
- Results that agents report never satisfy a required check.
- Of the reports that count, any failure fails the check, and any unfinished one keeps it pending.
- Check runs created by Diffinery Actions can't be changed through the REST API.

> **Important:** A job that is skipped by its `if:` condition, or that fails before it is launched (for example because no runner matches its `runs-on`), doesn't report a check. If such a job is a required check, the pull request shows `required check '<name>' has not run`. A check also appears only when its job is launched, so a required check for a job that `needs` others shows as not run until those finish.

## Concurrency

Set `concurrency` at the top of a workflow to make runs in the same group exclusive:

```yaml
concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: true
```

- The group is evaluated when the run is created, with the `github`, `inputs` and `vars` contexts. Groups are scoped to the repository, so two workflows can share a group.
- With `cancel-in-progress: true`, creating a run cancels every unfinished run (queued or in progress) in the same group, with the reason `cancelled by a newer run in the same concurrency group`.
- Without it, a new run waits while another run in the group is in progress, checking once a minute. After 6 hours of waiting it starts anyway. As on GitHub, a group has at most one waiting run: a new run cancels older runs still waiting in the group (not the one in progress), with the reason `Canceling since a higher priority waiting request for '<group>' exists`, so a deploy group runs the newest push next, never older ones one after another. A run cancelled while it waits finishes within a minute, with none of its jobs run.
- A run or job on a protected branch is cancelled or replaced through its group only by runs on that same branch. A workflow on another branch that names the same group, `cancel-in-progress` or not, waits for it instead, so a branch can't cancel a protected branch's deploy.

If the group expression fails to evaluate, the run has no concurrency group.

### Job concurrency

`jobs.<id>.concurrency` limits a group to one running job at a time across the repository, whatever run or workflow the jobs belong to:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency:
      group: deploy-${{ matrix.env }}
      cancel-in-progress: false
    strategy:
      matrix:
        env: [staging, production]
    steps:
      - run: ./deploy.sh ${{ matrix.env }}
```

- The group is evaluated for each matrix combination, with the `github`, `needs`, `inputs`, `vars`, `matrix` and `strategy` contexts.
- Without `cancel-in-progress`, a job whose group has a running job waits with the status `pending`. Only the newest pending job is kept: an older pending job of the group is cancelled.
- With `cancel-in-progress: true`, the new job takes the group and cancels the group's running and pending jobs.
- Jobs cancelled this way end as `cancelled` with the message `Canceling since a higher priority waiting request for '<group>' exists`.
- When the running job finishes, the oldest pending job of the group starts, from whichever run it belongs to.

## Notifications

When a run completes with `success` or `failure`, Diffinery notifies the person who triggered it (for a run an agent triggered, the agent's owner; for runs started by the scheduler or the merge queue, the repository's watchers). By default they get an email and a web notification when a run fails; in their notification settings they can turn off **Only failed runs** to get emails for successful runs too. Cancelled runs don't notify anyone. See [Notifications](/docs/accounts/notifications).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Nothing runs after a push | Check that the file is directly in `.github/workflows/` or `.diffinery/workflows/` and ends in `.yml` or `.yaml`, and that the `on:` filters match the branch, tag or paths. Run `diffinery workflow validate`. |
| A run stays in progress though all its jobs finished, and newer runs in its concurrency group wait with no jobs | The run's orchestration lost track of it. Diffinery repairs it by itself: within 5 minutes of its last job the orchestration is signalled again, and by 30 minutes the run is finished, freeing the group. Nothing to do; re-run the workflow if it names jobs that never started. |
| A run titled `Invalid workflow file: ...` appears | A workflow file in the pushed commit has errors. Its one job, **Invalid workflow file**, lists every error with its path and line. Pushes and merge groups create these runs; other events skip invalid files silently. |
| A pull request's `pull_request` workflows don't run | The pull request conflicts with its base, so there is no test merge commit. Resolve the conflicts. `pull_request_target` workflows still run. |
| `No Diffinery runner matches runs-on: <labels>. Linux (ubuntu-*) runners are hosted; anything else needs runs-on: [self-hosted, ...] and a registered runner.` | Hosted runners accept `ubuntu-*`, `linux`, `diffinery`, `diffinery-*`, `x64` and `amd64`. For other platforms, add `self-hosted` and start a runner with matching labels. See [Runners](/docs/actions/runners). |
| A self-hosted job stays `waiting` | No runner with all the job's labels is polling. Start `diffinery runner` with those labels. After 6 hours the job times out. |
| `The job was not started: this account has used its <n> hosted minutes for this month ...` | The account that owns the repository used its monthly hosted minutes. They renew on the 1st (UTC); until then use a self-hosted runner, or ask a site administrator to raise the quota. See [Account quotas](/docs/reference/limits#account-quotas). |
| A hosted job stays queued, then fails with `The job waited 6 hours for a hosted runner (one of this account's hosted jobs to finish, or a free runner), and was not started.` | The account already runs as many hosted jobs at once as its quota allows (20 by default, at most 40), or every hosted runner of the instance was busy. Queued jobs start as running ones finish. See [Account quotas](/docs/reference/limits#account-quotas) and [hosted runner limits](/docs/reference/limits#actions). |
| `The job was not started: Actions are suspended for this repository by a site administrator: <reason>.` (or `for every repository of <account>`) | A site administrator suspended Actions here. Nothing runs until they lift it, and a red banner on the Actions page shows the reason. See [Kill switches](/docs/admin/site-administration#kill-switches). |
| `The job was not started: Hosted runners are paused on this instance by a site administrator: <reason>. Self-hosted runners still work.` | Hosted compute is paused on the whole instance. Use a self-hosted runner, or re-run once it is resumed. See [Kill switches](/docs/admin/site-administration#kill-switches). |
| `Could not start a runner: ...` | The job's container failed to start with an error that trying again won't fix (passing platform errors are retried first; see [Limits](/docs/reference/limits)). Re-run the run. |
| `The runner stopped unexpectedly (exit code <n>).` | The job's container exited before reporting a result. Re-run the run; if it repeats, check that the job doesn't exhaust memory or disk. |
| `The platform is stopping this runner (a rollout replacing it with a new version, or the platform moving it). The job keeps running for up to 13 minutes; ...` | The platform sent the job's container its stop signal. Deploys leave running jobs alone, so this is rare and usually the platform moving the container. The signal reaches the running step as well, which then fails with "The platform stopped this step's processes while stopping the runner." A job that can only read starts again by itself; see Platform updates in [Runners](/docs/actions/runners#limits-and-timeouts). Otherwise re-run the job. |
| `Error evaluating 'if': ...` | The job's `if:` expression failed at runtime. See [Expressions](/docs/actions/expressions). |
| A step can't reach a secret | Secrets are configured in the repository or organization settings. See [Secrets and variables](/docs/actions/secrets-and-variables). |
| `git push` from a job fails | The job's `GITHUB_TOKEN` needs `contents: write` (new repositories default to read-only tokens), can't change workflow files, and follows branch protection. See [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions). |
| `Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: ...)` | Add the named scope to the job's `permissions:`. See [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions). |
| A job is `skipped` though its `if:` is true | A job above it in the `needs` chain failed, was cancelled or was skipped. Add a status function, for example `if: ${{ !cancelled() && !failure() }}`. |
| `<branch> is not allowed to deploy to <environment> due to environment protection rules.` | The job sets `environment:` and the environment's branch policy doesn't allow the run's ref. Run it from an allowed branch or tag, or change the policy. See [Environments](/docs/actions/environments). |
| `invalid environment name '<name>'` | The job's `environment` name is empty, longer than 255 characters, or contains `/`, `\` or control characters. |
| An `on: release` workflow runs three times | Creating a published release sends `created`, `published` and `released`. Add `types: [published]`. See [release](/docs/actions/events#release). |
| An `on: release` workflow doesn't run | Workflows don't run for draft releases, and the workflow file must exist at the commit the release's tag points to. |
