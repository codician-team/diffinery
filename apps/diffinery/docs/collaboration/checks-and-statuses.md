---
title: Checks and commit statuses
description: How Diffinery Actions, external CI and bots report check runs and commit statuses on commits, and how they decide required checks in branch protection.
---

Checks tell you whether a commit passes your tests. Diffinery Actions reports a check for every job it runs, and any other CI system or bot can report its own results through the GitHub-compatible REST API, as check runs or as commit statuses. Pull requests, commits and the merge queue show them, and branch protection can require some of them to pass before a pull request merges.

## Check runs and commit statuses

There are two kinds of report. Both show up in the same lists and both can satisfy a required check.

| | Check run | Commit status |
|---|---|---|
| Reported by | Diffinery Actions (one per job), or any account with the write role over `POST /repos/{owner}/{repo}/check-runs` | Any account with the write role over `POST /repos/{owner}/{repo}/statuses/{sha}` |
| Identified by | Its `name` | Its `context` |
| States | `status`: `queued`, `in_progress`, `completed`; when completed, a `conclusion` such as `success` or `failure` | `state`: `pending`, `success`, `failure`, `error` |
| Extra detail | Title, summary, text and line annotations | A one-line description |
| Can be changed | Yes, by the account that created it (`PATCH`) | No: post a new status for the same context; the newest one counts |
| Webhook | None | `status` |

Use check runs when you want annotations or to update one report as the build progresses. Use commit statuses for the simplest integration: one request per state change.

## Checks from Diffinery Actions

Every job of a [Diffinery Actions](/docs/actions/overview) workflow run reports a check run named `<workflow name> / <job name>`, for example `ci / test` for the job `test` in a workflow with `name: ci`. The check is:

- created as `queued` when the job is scheduled, set to `in_progress` when it starts, and `completed` with the job's conclusion (for example `success`, `failure`, `cancelled` or `timed_out`) when it ends;
- reported on the commit the run is for. For pull request runs, that is the pull request's head commit, not the test merge commit;
- linked to the job's page (`https://diffinery.com/acme/website/actions/runs/{run_id}/job/{job_id}`);
- reported by the app `diffinery-actions`.

Re-running a job replaces the check of the same name on the same commit. A job that a failed-job re-run keeps from the earlier attempt keeps its conclusion, and its check run points at the new attempt. Check runs from Actions can't be changed over the REST API: a `PATCH` fails with `check runs from Diffinery Actions can't be changed over the API`.

A job's `check_run_url` (in `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` and `GET /repos/{owner}/{repo}/actions/jobs/{job_id}`) is `https://diffinery.com/api/v3/repos/acme/website/check-runs/{job_id}`. `GET` on it returns the check run that job reports (its latest one, after a re-run), so tools that follow `check_run_url` from a job to its check run work as on GitHub.

> **Note:** GitHub names an Actions check run after the job only. In Diffinery the name includes the workflow name, so required check names copied from GitHub usually need the `<workflow> / ` prefix.

A step can also report with the job's own `GITHUB_TOKEN`, within the job's `permissions:`:

- **Commit statuses** need `statuses: write`. They are reported by `diffinery-actions[bot]` and count toward required checks like any other non-agent report (in a run whose code came from an agent, the token acts as an agent, and its statuses don't count).
- **Check runs** can't be created with the job token: `POST .../check-runs` fails with `this account can't report check runs`. Report a commit status instead, or use a personal token with the `write` scope stored as a secret.

```yaml
permissions:
  contents: read
  statuses: write
steps:
  - run: |
      curl -sS -X POST -H "Authorization: Bearer $GITHUB_TOKEN" -H "Content-Type: application/json" \
        "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/statuses/$GITHUB_SHA" \
        -d '{"state": "success", "context": "lighthouse", "description": "Score 98"}'
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Without `statuses: write`, the request fails with `403` and `Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: statuses: write)`.

## Report results from external CI

An external CI system (or any script or bot) reports results with a token for an account that has the **write** role on the repository. A personal access token with the `write` scope works. For results that should satisfy required checks, use a regular account, not an agent: reports from agents never satisfy required checks (see [Agents and checks](#agents-and-checks)).

A common setup is a dedicated account, for example `ci-bot`, added as a collaborator with the write role, with a `write` token stored in your CI system. Bind your required checks to it with [requiredCheckSources](#bind-a-required-check-to-its-reporter) so nobody else can satisfy them.

### Report a commit status

```sh
SHA=9c4d8e2f1a0b3c5d7e9f2a4b6c8d0e1f3a5b7c9d

# When the build starts
curl -sS -X POST \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  https://diffinery.com/api/v3/repos/acme/website/statuses/$SHA \
  -d '{
    "state": "pending",
    "context": "ci/external",
    "description": "Build #812 started",
    "target_url": "https://ci.example.com/builds/812"
  }'

# When it finishes
curl -sS -X POST \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  https://diffinery.com/api/v3/repos/acme/website/statuses/$SHA \
  -d '{
    "state": "success",
    "context": "ci/external",
    "description": "Build #812 passed in 3m 12s",
    "target_url": "https://ci.example.com/builds/812"
  }'
```

| Field | Required | Description |
|---|---|---|
| `state` | yes | `pending`, `success`, `failure` or `error`. Anything else fails with `state must be one of error, failure, pending, success`. |
| `context` | no | The name the status is reported under, and the name a required check matches. Default `default`. At most 255 characters (longer values are cut). |
| `description` | no | A short description, shown next to the check. At most 1024 characters (longer values are cut). |
| `target_url` | no | A link to the build. Must start with `http://` or `https://`, otherwise the request fails with `target_url must be an http(s) URL`. |

The `{sha}` in the path is normally a full commit SHA. Diffinery also accepts anything that resolves to a commit, such as a branch name, and stores the status on the resolved commit. A commit that does not exist fails with `no commit found for SHA: <sha>`.

The response is `201`:

```json
{
  "url": "https://diffinery.com/api/v3/repos/acme/website/statuses/9c4d8e2f1a0b3c5d7e9f2a4b6c8d0e1f3a5b7c9d",
  "avatar_url": "https://diffinery.com/api/avatars/ci-bot",
  "id": 17,
  "node_id": "U3RhdHVzQ29udGV4dDphY21lL3dlYnNpdGUvMTc",
  "state": "success",
  "description": "Build #812 passed in 3m 12s",
  "target_url": "https://ci.example.com/builds/812",
  "context": "ci/external",
  "created_at": "2026-10-13T09:40:00Z",
  "updated_at": "2026-10-13T09:40:00Z",
  "creator": {
    "login": "ci-bot",
    "id": 1058134509943791,
    "node_id": "VXNlcjpjMWIyYTNkNGU1ZjYwNzE4MjkzYTRiNWM2ZDdlOGY5YQ",
    "avatar_url": "https://diffinery.com/api/avatars/ci-bot",
    "gravatar_id": "",
    "url": "https://diffinery.com/api/v3/users/ci-bot",
    "html_url": "https://diffinery.com/ci-bot",
    "repos_url": "https://diffinery.com/api/v3/users/ci-bot/repos",
    "organizations_url": "https://diffinery.com/api/v3/users/ci-bot/orgs",
    "type": "User",
    "user_view_type": "public",
    "site_admin": false
  }
}
```

Statuses are append-only: to change a status, post a new one with the same `context`. A commit can have up to 1,000 statuses per context; after that, posting fails with `this SHA and context has reached the maximum number of statuses`. Every new status sends a `status` webhook event.

### Read commit statuses

| Endpoint | Returns |
|---|---|
| `GET /repos/{owner}/{repo}/commits/{ref}/statuses` (also `GET /repos/{owner}/{repo}/statuses/{ref}`) | Every status of the commit, newest first, paginated |
| `GET /repos/{owner}/{repo}/commits/{ref}/status` | The combined status: the newest status of each context, and an overall state |

`{ref}` can be a SHA, a branch or a tag. An unknown ref returns `404` with `No commit found for the ref`. Reading needs the read role (none for a public repository).

```sh
curl -sS -H "Authorization: Bearer dfy_..." \
  https://diffinery.com/api/v3/repos/acme/website/commits/main/status
```

The combined status has these fields:

| Field | Description |
|---|---|
| `state` | `failure` if any context's newest status is `failure` or `error`; otherwise `pending` if any is `pending` or there are no statuses; otherwise `success` |
| `statuses` | The newest status of each context, sorted by context (paginated with `per_page`, default 100) |
| `sha` | The commit |
| `total_count` | Number of contexts |
| `repository` | The repository object |
| `commit_url`, `url` | API links |

The combined status only covers commit statuses. Check runs are listed separately (see [Read check runs and check suites](#read-check-runs-and-check-suites)).

### Report a check run

Create the check run when the build starts, keep its `id`, and update it when the build ends:

```sh
SHA=9c4d8e2f1a0b3c5d7e9f2a4b6c8d0e1f3a5b7c9d

# Start: returns the check run, including its numeric "id"
curl -sS -X POST \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  https://diffinery.com/api/v3/repos/acme/website/check-runs \
  -d '{
    "name": "ci/external",
    "head_sha": "'"$SHA"'",
    "status": "in_progress",
    "details_url": "https://ci.example.com/builds/812",
    "external_id": "812",
    "output": { "title": "Building", "summary": "Build #812 is running" }
  }'

# Finish, with two annotations
curl -sS -X PATCH \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  https://diffinery.com/api/v3/repos/acme/website/check-runs/31 \
  -d '{
    "conclusion": "failure",
    "output": {
      "title": "2 lint errors",
      "summary": "eslint found 2 problems",
      "annotations": [
        { "path": "src/app.ts", "start_line": 12, "end_line": 12, "annotation_level": "failure", "message": "Unexpected any" },
        { "path": "src/util.ts", "start_line": 40, "end_line": 41, "annotation_level": "warning", "title": "Unused variable", "message": "'tmp' is never read" }
      ]
    }
  }'
```

Fields of `POST /repos/{owner}/{repo}/check-runs`:

| Field | Required | Description |
|---|---|---|
| `name` | yes | The check's name, at most 255 characters. Required checks match this. Otherwise the request fails with `name is required`. |
| `head_sha` | yes | The commit. A branch or tag name also works. Unknown commits fail with `head_sha is not a commit in this repository`. |
| `status` | no | Default `queued`. |
| `conclusion` | no | Setting it marks the check run `completed`. |
| `details_url` | no | Link to the build; the check's name links there in the web UI. |
| `external_id` | no | Your own id for the run. |
| `output` | no | `title`, `summary`, `text` and `annotations`. |

Fields of `PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}`:

| Field | Description |
|---|---|
| `name` | Rename the check run. |
| `status` | `queued`, `in_progress`, `completed`, `waiting`, `requested` or `pending`. Other values fail with `invalid status`. |
| `conclusion` | `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required` or `stale`. Other values fail with `invalid conclusion`. Setting a conclusion marks the check run `completed`. `status: completed` without a conclusion fails with `conclusion is required when status is completed`. |
| `details_url` | Must start with `http://` or `https://` (`details_url must be an http(s) URL`). |
| `external_id` | Your own id. |
| `started_at`, `completed_at` | ISO 8601 times. When omitted, Diffinery records when the check run started and completed. |
| `output.title`, `output.summary`, `output.text` | Replace the stored values. Each is cut to 65,535 characters. |
| `output.annotations` | Added to the annotations already stored, like GitHub. At most 50 per request are taken, and a check run keeps at most 1,000. |

Each annotation can have `path`, `start_line`, `end_line`, `start_column`, `end_column`, `annotation_level` (`notice`, `warning` or `failure`; default `notice`), `title`, `message` and `raw_details`. Read them back with `GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations`. The web UI does not display annotations.

The response of both requests is the check run:

```json
{
  "id": 31,
  "head_sha": "9c4d8e2f1a0b3c5d7e9f2a4b6c8d0e1f3a5b7c9d",
  "node_id": "Q2hlY2tSdW46OWY4ZTdkNmM1YjRhMzkyODE3MDZmNWU0ZDNjMmIxYTA",
  "external_id": "812",
  "url": "https://diffinery.com/api/v3/repos/acme/website/check-runs/31",
  "html_url": "https://ci.example.com/builds/812",
  "details_url": "https://ci.example.com/builds/812",
  "status": "completed",
  "conclusion": "failure",
  "started_at": "2026-10-13T09:36:01Z",
  "completed_at": "2026-10-13T09:39:13Z",
  "output": {
    "title": "2 lint errors",
    "summary": "eslint found 2 problems",
    "text": null,
    "annotations_count": 2,
    "annotations_url": "https://diffinery.com/api/v3/repos/acme/website/check-runs/31/annotations"
  },
  "name": "ci/external",
  "check_suite": { "id": "app-ci-bot-9c4d8e2f1a0b3c5d7e9f2a4b6c8d0e1f3a5b7c9d" },
  "app": { "id": "ci-bot", "slug": "ci-bot", "node_id": "QXBwOmNpLWJvdA", "name": "ci-bot", "owner": null },
  "pull_requests": [],
  "run_id": null,
  "job_id": null
}
```

- `app` is the login of the account that reported the check run, or `diffinery-actions` for Actions. `run_id` and `job_id` are set only for Actions checks.
- A check run is keyed by commit, name and reporter. Posting again with the same `head_sha` and `name` from the same account updates that check run (same `id`) instead of adding a second one.
- Accounts whose login starts with `diffinery-actions` can't report check runs (`this account can't report check runs`).

### Who may update a check run

Only the account that created a check run can update it. Anyone else, including repository admins, gets `only the app that created a check run can update it`. Check runs from Diffinery Actions can't be updated by anyone over the API. Updating needs the write role, like creating.

### Read check runs and check suites

| Endpoint | Returns |
|---|---|
| `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` | All check runs of a commit (from Actions and external reporters) as `{ total_count, check_runs }`. Filter with `check_name` and `status`. |
| `GET /repos/{owner}/{repo}/check-runs/{check_run_id}` | One check run |
| `GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations` | Its annotations |
| `GET /repos/{owner}/{repo}/commits/{ref}/check-suites` | The commit's check suites as `{ total_count, check_suites }` |
| `GET /repos/{owner}/{repo}/check-suites/{check_suite_id}` | One check suite |
| `GET /repos/{owner}/{repo}/check-suites/{check_suite_id}/check-runs` | The check runs of a suite |

Check suites are derived, not created: each Actions workflow run is one suite (its id is the run id), and each external reporter has one suite per commit (id `app-<login>-<sha>`). A suite is `completed` when all its check runs are, with conclusion `failure` if any of them failed, timed out, was cancelled or needs action, and `success` otherwise. You can't create or re-request suites, and commit statuses are not part of any suite.

## Required checks

A branch protection rule's **Required status checks** (`requiredChecks` in the API) lists check names that must pass on a pull request's head commit before it can merge, and on a merge group's commit before the merge queue merges it. Both check runs and commit statuses count: a required check named `ci/external` is satisfied by a check run named `ci/external` or by a commit status with context `ci/external`.

To set them in the web UI, open **Settings**, then **Branch protection**, and enter the names in **Required status checks**, one per line, exactly as they appear on pull requests. A name may contain commas, for example `CI / test (ubuntu, 22)`. See [Branch protection](/docs/repositories/branch-protection) for the whole rule.

### How a required check is decided

For each required name, Diffinery looks at every check run and commit status with that name on the commit, then:

1. If the rule binds the name to a reporter in `requiredCheckSources`, only reports from that reporter count.
2. Otherwise, if Diffinery Actions reported a check with that name, only the Actions check counts. Other reports with the same name are ignored.
3. Reports from agents are ignored.
4. Of the reports left:
   - none: the check has not run, and the pull request is blocked with `required check '<name>' has not run`;
   - any completed with a conclusion other than `success`, `neutral` or `skipped` (a status of `failure` or `error` counts as failed): blocked with `required check '<name>' <conclusion>`, for example `required check 'ci/external' failure`;
   - any still pending or in progress: blocked with `required check '<name>' is <status>`, for example `required check 'ci / test' is in_progress`;
   - otherwise the check passes.

For commit statuses, only the newest status of each context from each reporter counts. One account's later status never replaces another account's.

These blockers appear in the pull request's merge box, in `merge_blockers` from `GET /repos/{owner}/{repo}/pulls/{number}`, in `mergeability.blockers` from the MCP `get_pull_request` tool, and in the error of a refused merge.

### Bind a required check to its reporter

Without a binding, any account with the write role could post a passing status with the same name as your external CI. Bind each external required check to the account that reports it with `requiredCheckSources`, a map from check name to the reporter's login (or `diffinery-actions` for Actions):

```sh
curl -sS -X PUT \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  https://diffinery.com/api/v3/repos/acme/website/branches/main/protection \
  -d '{
    "requirePullRequest": true,
    "requiredApprovals": 1,
    "requiredChecks": ["ci / test", "ci/external"],
    "requiredCheckSources": { "ci/external": "ci-bot", "ci / test": "diffinery-actions" }
  }'
```

- The request replaces the whole rule, so send every field you want to keep. It needs a token with the `admin` scope for a person with the admin role. Agents can't change branch protection.
- Each value must be a login (letters, digits, `.`, `_`, `-`, `[` and `]`, starting with a letter or digit, up to 100 characters) or `diffinery-actions`, and each name at most 255 characters. Otherwise the request fails with `invalid source for required check '<name>'`, or with `requiredCheckSources must map check names to a reporter login or diffinery-actions` when it isn't an object.
- Logins are compared without regard to case.
- Binding only affects names listed in `requiredChecks`.
- Binding a check to an agent's login means it can never pass, because agent reports are ignored.

`requiredCheckSources` can only be set through the API, and the **Branch protection** settings page does not show it. Saving the rule from that page keeps the bindings of every check that is still listed in **Required status checks** (also when you rename the rule's pattern). A binding for a check you removed from the list is dropped; add the check back with the API, binding included.

### Required checks and the merge queue

When the base branch uses a [merge queue](/docs/collaboration/merge-queue), required checks are evaluated on each merge group's commit, on the `gh-readonly-queue/<base>/...` branch. Actions workflows with `on: merge_group` (or `on: push` for those branches) report there automatically. An external CI system must also build the merge group branch and report its status or check run on the merge group commit; otherwise the entry waits until the queue's check timeout and leaves the queue. The queue page shows a required check that has not reported yet as `expected`.

A finished commit status, or a check run sent with `POST .../check-runs` as completed, makes the queue look at the group again at once. Completing a check run with `PATCH` doesn't: the queue only notices it at its next event, at the latest when the check timeout ends. To finish a check that the queue waits on, post the final result with `POST` (the same account, commit and name update the existing check run).

### Required checks for deployments

`POST /repos/{owner}/{repo}/deployments` uses the same rules (without source bindings) for `required_contexts`: without `required_contexts`, every check name on the commit that a non-agent reported must have passed; with a list, those names must have passed; `[]` skips the check. Deployments that a workflow job creates for its `environment:` skip the check. A failing check makes the request fail with `409` and `Conflict: Commit status checks failed for <ref>.` See [Environments](/docs/actions/environments).

## Agents and checks

[Agents](/docs/agents/overview) with the write role can report check runs and commit statuses, and their reports appear on pull requests and commits like any other. But a report from an agent never satisfies a required check, and never fails one either: Diffinery ignores agent reports when it decides required checks, merge queue verdicts and deployment `required_contexts`. This stops an agent from approving its own changes by reporting a passing check. Run the checks you rely on in Diffinery Actions, or report them from a person's account bound with `requiredCheckSources`.

## Checks in the web UI

### On a pull request

- The **Conversation** tab's merge box lists every check run and commit status on the head commit, with a summary: **All checks have passed**, **Some checks haven't completed yet**, or the number of failing checks (for example **2 failing checks**), and the number of checks. Each line has a status icon, the name, the check's title (for a commit status, its description) and how long it ran. Below are the approvals and the merge blockers, including any required check that is missing, pending or failed.
- The **Checks** tab shows **Checks for** the head commit's short SHA: each check with its reporter (`diffinery-actions`, the login of an external reporter, or `status` for a commit status), its state, the start of its summary, and its duration. When nothing has reported, it says **No checks have reported for the latest commit.** Under **Workflow runs** are the pull request's Actions runs.

The check lists update live while the page is open.

### On a commit

The commit page (`https://diffinery.com/acme/website/commit/<sha>`) lists the commit's check runs and statuses under its header, with their titles or descriptions.

### Where a check's name links

| Check | Link |
|---|---|
| From Diffinery Actions | The job's page and log |
| Check run with `details_url`, or commit status with `target_url` | That URL, in a new tab (only `http` and `https` links) |
| Otherwise | No link |

## Differences from GitHub

| GitHub | Diffinery |
|---|---|
| Actions check runs are named after the job | Named `<workflow> / <job>`. |
| Check runs are created by GitHub Apps; personal tokens can't create them | Any account with the write role can create check runs; `app` is the account's login. |
| Creating a check run with an existing name adds a new run | The same account, commit and name update the existing check run. |
| Check suites can be created and re-requested | Check suites are derived from check runs and read-only. |
| Status descriptions are limited to 140 characters | Up to 1,024 characters are kept. |
| `required_status_checks` with an app id restricts who can satisfy a check | `requiredCheckSources` binds a check name to a login or to `diffinery-actions`; when Actions reports a name, it alone decides that check even without a binding. |
| Statuses and check runs can be posted with the workflow's `GITHUB_TOKEN` | Statuses can (with `statuses: write`); check runs can't. |
| `check_run` and `check_suite` webhook events | Not sent. Commit statuses send `status` events. |
| Agents don't exist | Reports from agents never decide a required check. |

## Troubleshooting

| Symptom or message | Cause and fix |
|---|---|
| `required check '<name>' has not run` | No report with exactly that name on the head commit, or only reports that don't count (from agents, from Actions-overridden reporters, or from someone other than the bound source). Compare the name with the **Checks** tab, including the `<workflow> / ` prefix for Actions jobs. |
| A passing external status is ignored | Actions also reports a check with that name, and Actions wins; or `requiredCheckSources` binds the name to a different login; or the reporter is an agent. Rename your context or fix the binding. |
| Bindings disappeared | The check was removed from **Required status checks** when the rule was saved from the **Branch protection** settings page, which drops the binding of a check that is no longer required. Set it again with the API. |
| `write access required` | The token's account lacks the write role, or a workflow's `GITHUB_TOKEN` has no write permission at all (for example `permissions: read-all`). |
| `Resource not accessible by integration (...)` | A workflow's `GITHUB_TOKEN` lacks the permission named in the message. Add `statuses: write` to the job's `permissions:` to post statuses. |
| `this account can't report check runs` | Check runs can't be created with a workflow's `GITHUB_TOKEN`. Post a commit status, or use a personal token. |
| `this token needs the write scope` | The token has only the `read` scope. Use a token with the `write` scope. |
| `only the app that created a check run can update it` | Update the check run with the same account (any of its tokens) that created it. |
| `check runs from Diffinery Actions can't be changed over the API` | Re-run the job instead. |
| `conclusion is required when status is completed` | Send a `conclusion` when completing a check run. |
| `this SHA and context has reached the maximum number of statuses` | You posted 1,000 statuses for one context on one commit. Post less often, for example only on state changes. |
| A merge queue entry waits for an external check | Your CI must report on the merge group commit (`gh-readonly-queue/...` branch), not only on the pull request's head commit. |
