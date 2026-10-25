---
title: Events that trigger workflows
description: Every event that can start a Diffinery workflow, its activity types and filters, the commit and ref it runs on, and its github.event payload.
---

The `on:` section of a workflow says which events start it. Diffinery supports the GitHub Actions events that matter for CI and automation: pushes, pull requests, merge queue groups, manual dispatch, schedules, other workflows' runs, published releases, external `repository_dispatch` events and reusable workflow calls. This page lists each one with its activity types, filters, the `GITHUB_SHA` and `GITHUB_REF` its runs get, and its `github.event` payload.

## Supported events

| Event | Fires when | Activity types | Filters |
| --- | --- | --- | --- |
| [`push`](#push) | A branch or tag is created or updated | | `branches`, `branches-ignore`, `tags`, `tags-ignore`, `paths`, `paths-ignore` |
| [`pull_request`](#pull_request) | A pull request is opened, updated, edited, reopened, closed, marked ready for review or converted to a draft | `opened`, `synchronize`, `reopened`, `closed`, `edited`, `ready_for_review`, `converted_to_draft` | `types`, `branches`, `branches-ignore`, `paths`, `paths-ignore` |
| [`pull_request_target`](#pull_request_target) | Same as `pull_request`, but runs the base branch's workflow | Same as `pull_request` | Same as `pull_request` |
| [`merge_group`](#merge_group) | The merge queue builds a merge group | `checks_requested` | `types`, `branches`, `branches-ignore` |
| [`workflow_dispatch`](#workflow_dispatch) | Someone starts the workflow from the UI, CLI, API or MCP | | `inputs` |
| [`schedule`](#schedule) | A cron schedule is due | | `cron` |
| [`workflow_run`](#workflow_run) | A run of another named workflow is requested or completes | `requested`, `completed` | `workflows`, `types`, `branches`, `branches-ignore` |
| [`release`](#release) | A release is published, unpublished, edited or deleted | `published`, `unpublished`, `created`, `edited`, `deleted`, `prereleased`, `released` | `types` |
| [`repository_dispatch`](#repository_dispatch) | Someone calls `POST /repos/{owner}/{repo}/dispatches` | Any `event_type` you choose | `types` |
| [`workflow_call`](#workflow_call) | Another workflow calls this one as a reusable workflow | | `inputs`, `outputs`, `secrets` |

### Other GitHub events

The other GitHub event names (`issues`, `issue_comment`, `create`, `delete`, `pull_request_review`, `check_run`, `status`, `deployment`, `deployment_status`, `label`, `watch` and the rest of GitHub's list) are accepted in `on:` without an error or warning, so workflows that list them still parse, but Diffinery never starts a run for them. A name that isn't a GitHub event at all gives the warning `unknown event '<name>'` in `diffinery workflow validate`.

## Writing on

```yaml
on: push                          # one event, no configuration
```

```yaml
on: [push, pull_request]          # several events, no configuration
```

```yaml
on:                               # events with configuration
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:
    types: [opened, synchronize, reopened, closed]
    paths: ["src/**"]
  workflow_dispatch:
```

An event's configuration must be a mapping (`on.<event> must be a mapping`), except `schedule`, which is a list. Each workflow file whose `on:` matches an event gets one run for it.

## Filter patterns

Branch, tag and path filters use GitHub's filter pattern syntax:

| Pattern | Matches |
| --- | --- |
| `*` | Any characters except `/`. `feature/*` matches `feature/login` but not `feature/a/b`. |
| `**` | Any characters, including `/`. `feature/**` matches `feature/a/b`. |
| `**/` at the start | Any directories, or none. `**/README.md` matches `README.md` and `docs/README.md`. |
| `?` | Zero or one of the preceding character. `v1?` matches `v` and `v1`. |
| `+` | One or more of the preceding character. `v1+` matches `v1` and `v111`. |
| `[abc]`, `[0-9]` | One character from the set or range. |
| `\` | Escapes the next character, for example `\*` for a literal `*`. |
| `!pattern` | In a list, excludes what earlier patterns matched. |

Patterns match the whole name: a branch name without `refs/heads/`, a tag name without `refs/tags/`, or a file path relative to the repository root. Quote patterns that start with `*`, `!` or `[` in YAML.

A list is read in order, and the last pattern that matches decides: a value is included when it matches a positive pattern and no later `!` pattern excludes it. A `!` pattern can only exclude what an earlier pattern included, so a list of only `!` patterns matches nothing.

```yaml
on:
  push:
    branches:
      - "releases/**"
      - "!releases/**-alpha"
```

This runs for `releases/10` and `releases/beta/mona`, but not `releases/10-alpha`.

### Include and ignore filters

- `branches` runs the workflow only for matching branches; `branches-ignore` runs it for every branch except matching ones. The same goes for `tags` and `tags-ignore`, and `paths` and `paths-ignore`.
- You can't use a filter and its `-ignore` form for the same event. The file fails with `'branches' and 'branches-ignore' cannot be used together for the same event` (or the same message for `tags` or `paths`). Use `!` patterns in the positive form instead.

### Path filters

- With `paths`, the workflow runs when at least one changed file matches the list.
- With `paths-ignore`, the workflow runs unless every changed file matches the list.
- For a push, the changed files are the difference between the commit before the push and the pushed commit. When the push creates a new branch, or the previous commit isn't known, Diffinery can't compute the change and path filters pass. (GitHub compares a new branch with the default branch instead.)
- For a pull request, the changed files are those the pull request changes, compared with the merge base of the head and the base branch. When a merged pull request is closed, path filters pass.
- Path filters are never evaluated for tag pushes.
- When branch or tag filters and path filters are both set, both must pass.

## push

Runs when you push to a branch or tag, including pushes that create a branch or tag, force pushes, pushes by agents, and merges made through the web UI, CLI, API or merge queue. Deleting a branch or tag doesn't start runs.

```yaml
on:
  push:
    branches: [main, "release/**"]
    tags: ["v*.*.*"]
    paths-ignore: ["docs/**", "**.md"]
```

How `branches` and `tags` combine, as on GitHub:

| Filters set | Branch pushes | Tag pushes |
| --- | --- | --- |
| None | Run | Run |
| Only `branches` or `branches-ignore` | Run when the branch matches | Don't run |
| Only `tags` or `tags-ignore` | Don't run | Run when the tag matches |
| Both kinds | Run when the branch matches | Run when the tag matches |
| Only `paths` or `paths-ignore` | Run when the paths match | Run (paths aren't checked for tags) |

The workflow file is read from the pushed commit, so a push that changes a workflow runs the new version.

When a merge queue builds a merge group, it pushes a branch named `gh-readonly-queue/<base>/pr-<n>-<head sha>`, and `push` workflows run on it as on GitHub. Add `branches-ignore: ["gh-readonly-queue/**"]` (or list only the branches you want) to avoid running twice.

| Variable | Value |
| --- | --- |
| `GITHUB_SHA` | The pushed commit |
| `GITHUB_REF` | The pushed ref, `refs/heads/<branch>` or `refs/tags/<tag>` |

Payload (`github.event`):

| Field | Value |
| --- | --- |
| `ref` | The pushed ref |
| `before` | The commit the ref pointed to before the push (`0000000000000000000000000000000000000000` for a new ref) |
| `after` | The pushed commit |
| `created`, `deleted`, `forced` | Whether the push created the ref, deleted it (always `false` for runs) or was a force push |
| `head_commit` | `id`, `message`, `timestamp` (committer time) and `author` (`name`, `email`) of the pushed commit |
| `commits` | A list with the pushed commit only (`id`, `message`). GitHub lists up to 20 commits. |
| `pusher` | `name`: the login of the account that pushed, and `email`: `null` |
| `sender` | See [The sender object](#the-sender-object) |
| `repository` | See [The repository object](#the-repository-object) |

## pull_request

Runs for activity on a pull request, using the workflow and code of the pull request's test merge commit: the head branch merged into the current base branch, as on GitHub.

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main]
    paths: ["src/**", "package.json"]
```

| Type | Fires when |
| --- | --- |
| `opened` | A pull request is created (drafts included) |
| `synchronize` | New commits are pushed to the head branch |
| `reopened` | A closed pull request is reopened |
| `closed` | A pull request is closed or merged. Check `github.event.pull_request.merged` to tell them apart. |
| `edited` | The title or description changed. Not for label changes, and not when the text saved is the same. |
| `ready_for_review` | A draft is marked ready for review: **Ready for review** in the web UI, `diffinery pr ready`, or `PATCH /repos/{owner}/{repo}/pulls/{number}` with `"draft": false` |
| `converted_to_draft` | An open pull request is turned back into a draft: `diffinery pr ready --undo`, or `PATCH` with `"draft": true` |

Without `types`, the workflow runs for `opened`, `synchronize` and `reopened`, as on GitHub. GitHub's other types (`labeled`, `assigned`, `review_requested`, `locked` and so on) are accepted in `types` but never fire on Diffinery.

A common use is to skip expensive jobs while a pull request is a draft and run them once it's ready:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  e2e:
    if: ${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run e2e
```

For `edited`, the payload has no `changes` object with the old title or body (GitHub sends one).

`branches` and `branches-ignore` filter on the pull request's base branch.

- The run checks out and runs `refs/pull/<n>/merge`. You can fetch that ref and `refs/pull/<n>/head` with git, but not push to them.
- While a pull request conflicts with its base, there is no test merge commit and its `pull_request` workflows don't run. `pull_request_target` workflows still do.
- For `closed` on a merged pull request, the run uses the merge commit instead.
- The run's checks are reported on the pull request's head commit, so they appear on the pull request.
- Every pull request comes from a branch of the same repository, so `pull_request` runs get the repository's secrets, like `push` runs.

| Variable | Value |
| --- | --- |
| `GITHUB_SHA` | The test merge commit (for a merged pull request's `closed` event, the merge commit) |
| `GITHUB_REF` | `refs/pull/<n>/merge` |
| `GITHUB_REF_NAME` | `<n>/merge` |
| `GITHUB_HEAD_REF` | The head branch |
| `GITHUB_BASE_REF` | The base branch |

Payload (`github.event`):

| Field | Value |
| --- | --- |
| `action` | The activity type |
| `number` | The pull request number |
| `pull_request.number`, `pull_request.id` | The pull request number (both) |
| `pull_request.node_id` | An opaque ID |
| `pull_request.state` | `open` or `closed` |
| `pull_request.locked` | `false` |
| `pull_request.title`, `pull_request.body` | Title and description |
| `pull_request.draft`, `pull_request.merged` | Booleans |
| `pull_request.merged_at` | When it merged, or `null` |
| `pull_request.merged_by` | `{ "login": ... }` or `null` |
| `pull_request.merge_commit_sha` | The merge commit once merged, otherwise the test merge commit (or `null` while it conflicts) |
| `pull_request.user` | The author, as a user object (see [The sender object](#the-sender-object)) |
| `pull_request.labels` | `[{ "name": ... }]` |
| `pull_request.assignees` | `[{ "login": ... }]` |
| `pull_request.requested_reviewers` | `[]` |
| `pull_request.author_association` | `MEMBER` |
| `pull_request.head` | `label` (`<owner>:<branch>`), `ref` (branch), `sha` (head commit), `user` (the repository owner) and `repo` (a repository object) |
| `pull_request.base` | The same fields for the base branch |
| `pull_request.html_url` | `https://diffinery.com/acme/website/pull/<n>` |
| `pull_request.url` | `https://diffinery.com/api/v3/repos/acme/website/pulls/<n>` |
| `pull_request.diff_url`, `pull_request.patch_url` | `https://diffinery.com/acme/website/pull/<n>.diff` and `.patch` |
| `pull_request.issue_url`, `pull_request.commits_url`, `pull_request.review_comments_url`, `pull_request.comments_url` | API URLs, as on GitHub |
| `repository` | See [The repository object](#the-repository-object) |
| `organization` | For repositories owned by an organization; see [The repository object](#the-repository-object) |
| `sender` | Whoever caused the event; see [The sender object](#the-sender-object) |

## pull_request_target

Same activity types, filters and payload as `pull_request`, but the run uses the base branch's own workflow file and code: the base branch's current commit. A pull request therefore can't change what runs with the repository's secrets. Check out the pull request's code (for example with `ref: ${{ github.event.pull_request.head.sha }}`) only if you trust it.

```yaml
on:
  pull_request_target:
    types: [opened, reopened]
jobs:
  welcome:
    runs-on: ubuntu-latest
    steps:
      - run: echo "Thanks for pull request #${{ github.event.number }}, ${{ github.event.pull_request.user.login }}"
```

Unlike `pull_request`, it also runs while the pull request conflicts with its base. Checks are reported on the pull request's head commit.

| Variable | Value |
| --- | --- |
| `GITHUB_SHA` | The base branch's current commit |
| `GITHUB_REF` | `refs/heads/<base branch>` |
| `GITHUB_HEAD_REF`, `GITHUB_BASE_REF` | The head and base branches |

## merge_group

Runs when the merge queue builds a merge group for a pull request: a commit holding the base branch, every pull request ahead in the queue, and this pull request's changes. The queue merges the pull request once the group's required checks pass. See [Merge queue](/docs/collaboration/merge-queue).

```yaml
on:
  pull_request:
  merge_group:
    types: [checks_requested]
    branches: [main]
```

- The only activity type is `checks_requested`, which is also the default.
- `branches` and `branches-ignore` filter on the queue's base branch.
- The queue reads the required checks from the merge group commit, so the workflows that produce them must run on it: list `merge_group` next to `pull_request`. (A `push` workflow without branch filters also runs there.) If a required check never reports, the pull request leaves the queue when the queue's check timeout expires.
- `push` workflows also run on the merge group branch; see [push](#push).
- A merge group commit with an invalid workflow file gets an `Invalid workflow file` run, like a push.

| Variable | Value |
| --- | --- |
| `GITHUB_SHA` | The merge group commit |
| `GITHUB_REF` | `refs/heads/gh-readonly-queue/<base>/pr-<n>-<head sha>` |

Payload (`github.event`):

| Field | Value |
| --- | --- |
| `action` | `checks_requested` |
| `merge_group.head_sha` | The merge group commit |
| `merge_group.head_ref` | The merge group ref |
| `merge_group.base_sha` | The commit the group was built on |
| `merge_group.base_ref` | `refs/heads/<base>` |
| `merge_group.head_commit` | `id`, `tree_id`, `message`, `timestamp`, `author` and `committer` (`name`, `email`) |
| `repository`, `sender` | As for other events |

The run's title is `Merge group for #<n>: <pull request title>`.

## workflow_dispatch

Lets people and agents with write access start the workflow on demand, on a branch or tag they choose, with typed inputs. How to start a run from the web UI, the CLI, the API and MCP is in [Actions overview](/docs/actions/overview#start-a-workflow-manually).

```yaml
on:
  workflow_dispatch:
    inputs:
      environment:
        description: Target environment
        type: choice
        options: [staging, production]
        default: staging
      version:
        description: Version to deploy
        required: true
      replicas:
        type: number
        default: 2
      dry-run:
        type: boolean
        default: false
      target:
        type: environment
```

Each input can have:

| Key | Meaning |
| --- | --- |
| `description` | Label in the **Run workflow** form (the input's name is shown under it). |
| `required` | `true` makes the input mandatory: an empty or missing value without a default is rejected with `input '<name>' is required`. Must be a boolean. |
| `default` | Used when no value is given. |
| `type` | `string` (the default), `boolean`, `number`, `choice` or `environment`. Another value fails with `input '<name>': invalid type '<type>' (expected one of string, boolean, number, choice, environment)`. |
| `options` | For `choice`: the allowed values. A `choice` input without options fails with `input '<name>' of type 'choice' must define 'options'`. A value outside the list is rejected with `input '<name>' must be one of <options>`. |
| `deprecationMessage` | Accepted and ignored. |

Values are converted by type: `boolean` inputs become `true` when the value is `true` or `"true"` and `false` otherwise; `number` inputs become numbers; `string`, `choice` and `environment` inputs stay as given. Values for inputs the workflow doesn't declare are dropped. An `environment` input is a plain text field in the **Run workflow** form, and its value isn't checked against the repository's [environments](/docs/actions/environments).

Read inputs with the `inputs` context (`${{ inputs.version }}`). `github.event.inputs` holds the same values with the same types; on GitHub, `github.event.inputs` values are always strings.

The workflow must exist and have a `workflow_dispatch` trigger at the chosen ref. A ref given without `refs/` is a branch if a branch with that name exists, and a tag otherwise.

| Variable | Value |
| --- | --- |
| `GITHUB_SHA` | The latest commit of the chosen ref |
| `GITHUB_REF` | `refs/heads/<branch>` or `refs/tags/<tag>` |

Payload (`github.event`): `inputs`, `ref` (the full ref), `workflow` (the workflow file's path), `repository` and `sender`.

Each accepted dispatch also sends a `workflow_dispatch` [webhook](/docs/reference/webhook-events#workflow_dispatch) event with the same `ref`, `workflow` and `inputs`, to webhooks subscribed to it.

## schedule

Runs the workflow on a schedule, in UTC.

```yaml
on:
  schedule:
    - cron: "30 5 * * 1-5"    # 05:30 UTC, Monday to Friday
    - cron: "0 */6 * * *"     # every 6 hours
```

`schedule` is a list of entries with a `cron` string. Each cron has 5 fields:

| Field | Values |
| --- | --- |
| Minute | `0`-`59` |
| Hour | `0`-`23` |
| Day of month | `1`-`31` |
| Month | `1`-`12` or `JAN`-`DEC` |
| Day of week | `0`-`6` (Sunday is `0`; `7` also means Sunday) or `SUN`-`SAT` |

Each field accepts `*`, a value, a range (`1-5`), a list (`1,15,30`) and a step (`*/15`, `0-30/10`, or `5/15` meaning from 5 to the end every 15). Names are case-insensitive. As in standard cron, when both day of month and day of week are restricted, a day matches if either one matches.

How schedules run:

- **Granularity is 5 minutes.** Diffinery checks schedules every 5 minutes and starts every schedule that was due at any minute since the last check. A schedule for `2 * * * *` starts a few minutes after :02, and one for `* * * * *` runs once per check, not every minute. GitHub's minimum interval is also 5 minutes. A check that comes late is caught up by the next one (up to an hour back), and a schedule starts once however many of its minutes it covers.
- **Only the default branch counts.** Schedules are read from the workflow files on the default branch, and refreshed on every push to it. A `schedule` in a workflow on another branch does nothing.
- Each run uses the workflow file on the default branch at that moment, and only if it still has that exact cron string.
- Schedules of archived repositories don't run.
- The run's actor is `diffinery-scheduler`. Notifications for scheduled runs go to the repository's watchers.

Invalid crons fail the file with `Invalid cron: <detail>`, for example `Invalid cron: Cron '0 3 * *' must have exactly 5 fields (minute hour day-of-month month day-of-week)`, `minute value 60 out of range 0-59 in cron '<cron>'` or `Invalid step '0' in minute field of cron '<cron>'`. `schedule` must be a list (`on.schedule must be a list of { cron: '...' } entries`) and each entry needs a `cron` string (`on.schedule entries must have a 'cron' string`).

| Variable | Value |
| --- | --- |
| `GITHUB_SHA` | The latest commit on the default branch |
| `GITHUB_REF` | `refs/heads/<default branch>` |

Payload (`github.event`): `schedule` (the cron string) and `repository`.

## workflow_run

Runs after a run of another workflow is requested or completes. Use it to post-process another workflow's results with access to secrets, or to chain workflows.

```yaml
name: Report
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]
jobs:
  report:
    if: ${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: ubuntu-latest
    steps:
      - run: echo "CI failed on ${{ github.event.workflow_run.head_branch }}: ${{ github.event.workflow_run.html_url }}"
```

- `workflows` is required: a list of workflow names (each workflow's `name`, or its path when it has none). A `workflow_run` trigger without `workflows` never fires.
- `types` can be `requested` (when the other run is created, including re-runs) and `completed`. Without `types`, both fire. GitHub's `in_progress` type never fires on Diffinery.
- `branches` and `branches-ignore` filter on the other run's head branch: the pushed branch, or the pull request's head branch for pull request runs.
- Like on GitHub, the triggered workflow is read from the default branch and runs there, whatever branch the other run was on.
- Chains stop after three levels: if A triggers B, B triggers C and C triggers D, D's runs don't trigger anything.
- If the run it follows came from an agent (for example CI on a branch an agent pushed), the `workflow_run` run counts as agent code too, although it runs on the default branch: its `GITHUB_TOKEN` acts as an agent and environment secrets follow the agent rules. A follower acts on what the other run produced (artifacts, outputs), so it can't be used to carry agent-written results past the agent guardrails. See [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions#runs-whose-code-came-from-an-agent).

| Variable | Value |
| --- | --- |
| `GITHUB_SHA` | The latest commit on the default branch |
| `GITHUB_REF` | `refs/heads/<default branch>` |

Payload (`github.event`):

| Field | Value |
| --- | --- |
| `action` | `requested` or `completed` |
| `workflow_run.id` | The other run's number, which is also its `github.run_id` and what `download-artifact`'s `run-id` takes |
| `workflow_run.name`, `workflow_run.path` | The other workflow's name and file path |
| `workflow_run.display_title` | The other run's title |
| `workflow_run.run_number`, `workflow_run.run_attempt` | Its number and attempt |
| `workflow_run.event` | The event that started it |
| `workflow_run.status`, `workflow_run.conclusion` | `queued` and `null` for `requested`; `completed` and the conclusion for `completed` |
| `workflow_run.head_branch`, `workflow_run.head_sha` | The branch and the commit it reported checks on |
| `workflow_run.actor`, `workflow_run.triggering_actor` | `{ "login": ... }` |
| `workflow_run.pull_requests` | `[{ "number": ... }]` for pull request runs, otherwise empty |
| `workflow_run.created_at`, `workflow_run.updated_at` | Timestamps |
| `workflow_run.html_url` | Link to the other run |
| `workflow` | `name` and `path` of the other workflow |
| `repository`, `sender` | As for other events |

## release

Runs when a release changes: when it's published, unpublished, edited or deleted. Use it to build and attach binaries, publish packages or deploy when you publish a release. Releases are managed on the repository's **Releases** page (`https://diffinery.com/acme/website/releases`), with `POST /api/v3/repos/{owner}/{repo}/releases` and `PATCH /api/v3/repos/{owner}/{repo}/releases/{release_id}`, or with the `create_release` and `update_release` MCP tools. All of them need write access. See [Releases](/docs/collaboration/releases).

```yaml
name: Release
on:
  release:
    types: [published]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make dist VERSION="${{ github.event.release.tag_name }}"
```

Each change sends one or more activity types, and a workflow with `on: release` and no `types` runs once for each of them. Creating a published release sends three (`created`, `published` and `released`), so you get three runs. Set `types` to the ones you need; `types: [published]` is the usual choice.

| Change | Activity types sent to workflows |
| --- | --- |
| Create a release that isn't a draft (**Publish release** on a new release) | `created`, `published`, then `released` (or `prereleased` for a pre-release) |
| Publish a draft (**Publish release** on a draft) | `published`, then `released` or `prereleased` |
| Turn a published release back into a draft (`"draft": true` in the API) | `unpublished` |
| Edit a published release (**Update release**) | `edited`, plus `released` or `prereleased` when the pre-release setting changed |
| Delete a published release | `deleted` |
| Create, edit or delete a draft | None. Webhooks still get `created`, `edited` and `deleted` for drafts, but workflows don't run for draft releases, as on GitHub. |

How a release run is set up:

- The run uses the commit the release's tag points to (the commit, for an annotated tag), and the workflow file at that commit. If the tag doesn't exist (for example it was deleted after the release was published), no run starts.
- Publishing a release whose tag doesn't exist yet creates the tag at `target_commitish` (the default branch when it's not set). Creating the tag is a push of that tag, so `push` workflows that match the tag run too, as on GitHub. Use either `on: push: tags` or `on: release` for the same job, not both.
- The run's title is the release's name, or its tag name when the release has no name.
- The run's actor is whoever made the change. Its checks are reported on the tagged commit.
- `types` is the only filter. `branches`, `tags` and `paths` aren't applied to `release`; check `github.event.release.tag_name` or `github.ref_name` in an `if:` instead.
- Invalid workflow files are skipped without an `Invalid workflow file` run.

| Variable | Value |
| --- | --- |
| `GITHUB_SHA` | The commit the release's tag points to |
| `GITHUB_REF` | `refs/tags/<tag>` |
| `GITHUB_REF_NAME` | The tag name |
| `GITHUB_REF_TYPE` | `tag` |

Payload (`github.event`):

| Field | Value |
| --- | --- |
| `action` | The activity type |
| `release.id` | The release's ID, a number |
| `release.tag_name` | The tag, for example `v1.2.0` |
| `release.target_commitish` | The branch or commit the tag was created from |
| `release.name`, `release.body` | Title and release notes, or `null` when empty |
| `release.draft`, `release.prerelease` | Booleans |
| `release.latest` | Whether this is the repository's latest release (a Diffinery field) |
| `release.immutable` | Always `false` |
| `release.created_at`, `release.updated_at`, `release.published_at` | Timestamps (`published_at` is `null` for drafts) |
| `release.author` | The user object of whoever created the release (`login`, `id`, `type` and URLs) |
| `release.assets` | The release's assets, each with `id`, `name`, `label`, `content_type`, `size`, `download_count`, `browser_download_url` and `url` |
| `release.html_url` | `https://diffinery.com/acme/website/releases/tag/<tag>` |
| `release.url`, `release.assets_url`, `release.upload_url` | API URLs. Upload assets to `upload_url` (with the `{?name,label}` template removed). |
| `release.tarball_url`, `release.zipball_url` | Source archives of the tag |
| `release.node_id`, `release.reactions` | As on GitHub |
| `repository` | See [The repository object](#the-repository-object) |
| `sender` | See [The sender object](#the-sender-object) |

Uploading an asset needs `contents: write`. Give the job that permission and use its `GITHUB_TOKEN`, or use a personal or agent token stored as a secret (see [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions)):

```yaml
on:
  release:
    types: [published]
jobs:
  upload:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: tar czf dist.tar.gz src
      - name: Attach dist.tar.gz to the release
        env:
          TOKEN: ${{ secrets.RELEASE_TOKEN }}
          UPLOAD_URL: ${{ github.event.release.upload_url }}
        run: |
          curl -fsS -X POST "${UPLOAD_URL%\{*}?name=dist.tar.gz" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/gzip" \
            --data-binary @dist.tar.gz
```

## repository_dispatch

Runs when someone calls the `dispatches` endpoint of the repository with an event type. Use it to start workflows from outside Diffinery: another system's CI, a deployment tool, a chat bot or an agent.

```yaml
on:
  repository_dispatch:
    types: [deploy, rollback]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./deploy.sh "${{ github.event.action }}" "${{ github.event.client_payload.version }}"
```

- `types` lists the `event_type` values that start the workflow. Without `types`, every `event_type` does.
- Like on GitHub, the workflow is read from the default branch's latest commit and runs there.
- The run's title is the `event_type`, and its actor is the account whose token sent the request.
- Invalid workflow files are skipped without an `Invalid workflow file` run.

### Send a repository_dispatch event

You need write access to the repository, with a token that has the write scope (see [Tokens](/docs/accounts/tokens)). People and agents can both send events.

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/dispatches \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"event_type": "deploy", "client_payload": {"version": "1.4.2", "environment": "staging"}}'
```

| Field | Required | Meaning |
| --- | --- | --- |
| `event_type` | Yes | A name for the event, 1 to 100 characters. Workflows match it against `types`, and it becomes `github.event.action`. |
| `client_payload` | No | A JSON object with at most 10 top-level properties and at most 64 KB as JSON. Becomes `github.event.client_payload`. Default: `{}`. |

The answer is `204 No Content`, as on GitHub, also when no workflow listens for the event type. The request doesn't return the runs it started; find them with `GET /api/v3/repos/acme/website/actions/runs?event=repository_dispatch` or `diffinery run list -R acme/website -e repository_dispatch`. Webhooks subscribed to `repository_dispatch` also get the event.

| Status | Message | Cause |
| --- | --- | --- |
| 403 | `write access required` | Your role or token scope is below write. |
| 403 | `repository is archived (read-only)` | Archived repositories don't accept events. |
| 422 | `event_type is required (at most 100 characters)` | `event_type` is missing, empty, not a string or too long. |
| 422 | `client_payload must be an object` | `client_payload` is an array or a scalar. |
| 422 | `client_payload can have at most 10 top-level properties` | Nest the values in fewer top-level properties. |
| 422 | `client_payload is too large` | The payload is over 64 KB as JSON. |
| 422 | `the repository is empty` | The default branch has no commits yet. |

| Variable | Value |
| --- | --- |
| `GITHUB_SHA` | The latest commit on the default branch |
| `GITHUB_REF` | `refs/heads/<default branch>` |

Payload (`github.event`):

| Field | Value |
| --- | --- |
| `action` | The `event_type` |
| `branch` | The default branch |
| `client_payload` | The `client_payload` you sent |
| `repository` | See [The repository object](#the-repository-object) |
| `sender` | The account whose token sent the event; see [The sender object](#the-sender-object) |

## workflow_call

Makes the workflow reusable: other workflows call it from a job with `uses:`. It never starts a run on its own.

```yaml
on:
  workflow_call:
    inputs:
      node-version:
        type: string
        default: "22"
    secrets:
      npm-token:
        required: true
    outputs:
      version:
        value: ${{ jobs.build.outputs.version }}
```

`inputs` take `type` (required: `string`, `boolean` or `number`), `description`, `required` and `default`. `secrets` take `description` and `required`. `outputs` each need a `value`. Runs of a called workflow use the caller's event, ref, commit and `github` context. The full reference is in [Reusable workflows](/docs/actions/reusable-workflows).

## GITHUB_SHA and GITHUB_REF by event

| Event | `GITHUB_SHA` | `GITHUB_REF` | Workflow file read from |
| --- | --- | --- | --- |
| `push` | Pushed commit | Pushed branch or tag | Pushed commit |
| `pull_request` | Test merge commit (merge commit once merged) | `refs/pull/<n>/merge` | Test merge commit |
| `pull_request_target` | Base branch's latest commit | `refs/heads/<base>` | Base branch's latest commit |
| `merge_group` | Merge group commit | `refs/heads/gh-readonly-queue/<base>/pr-<n>-<head sha>` | Merge group commit |
| `workflow_dispatch` | Latest commit of the chosen ref | Chosen branch or tag | Chosen ref |
| `schedule` | Default branch's latest commit | Default branch | Default branch |
| `workflow_run` | Default branch's latest commit | Default branch | Default branch |
| `release` | The commit the release's tag points to | `refs/tags/<tag>` | The tagged commit |
| `repository_dispatch` | Default branch's latest commit | Default branch | Default branch |

A re-run keeps the original run's commit, ref, event and payload.

## The repository object

Every payload has a `repository` field with GitHub's full repository object, the same one the REST API returns for `GET /repos/{owner}/{repo}`. The fields workflows read most:

| Field | Value |
| --- | --- |
| `id` | The repository's ID, a number |
| `node_id` | An opaque ID |
| `name` | `website` |
| `full_name` | `acme/website` |
| `private` | `true` for a private repository, `false` for a public one |
| `visibility` | `public` or `private` |
| `owner` | A user object for the owner (`login`, a numeric `id`, `type`: `User` or `Organization`, and URLs) |
| `default_branch` | `main` |
| `archived` | Whether the repository is archived |
| `topics` | The repository's topics |
| `html_url` | `https://diffinery.com/acme/website` |
| `clone_url` | `https://diffinery.com/acme/website.git` |
| `url` and the `*_url` templates | API URLs under `https://diffinery.com/api/v3/repos/acme/website` |
| `created_at`, `updated_at`, `pushed_at` | Timestamps |

For a repository owned by an organization, payloads also have an `organization` field with `login`, `id` (a number), `node_id`, `url`, `repos_url`, `avatar_url` and `description`.

The payload is also written to the file at `GITHUB_EVENT_PATH` for tools that read it from disk, such as `@actions/github`'s `context.payload` in `actions/github-script`.

## The sender object

`sender` is the account that caused the event, as a GitHub user object:

| Field | Value |
| --- | --- |
| `login` | The account's login |
| `id` | A number derived from the account's ID, like GitHub's numeric user IDs |
| `node_id` | An opaque ID |
| `type` | `User` for people, `Bot` for agents and Diffinery itself (for example `diffinery-scheduler`) |
| `site_admin` | `false` |
| `avatar_url`, `html_url`, `url` | The avatar, the profile page and the API URL |

## Runs started from inside a workflow

As on GitHub, an event caused by a job's own `GITHUB_TOKEN` doesn't start new workflow runs, so workflows can't trigger themselves in a loop. A push, a pull request or a release made with a job token starts nothing. The two exceptions, as on GitHub, are `workflow_dispatch` (a job with `permissions: actions: write` can start another workflow with `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`) and `repository_dispatch` (a job with `contents: write` can send `POST /repos/{owner}/{repo}/dispatches`).

Events caused by a personal or agent token stored as a secret are treated like any other event from that account and do start workflows: a push starts `push` workflows, a published release starts `release` workflows, and a dispatch starts `repository_dispatch` workflows.

```yaml
- name: Ask the deploy workflow to run
  env:
    TOKEN: ${{ secrets.DISPATCH_TOKEN }}
  run: |
    curl -fsS -X POST "${{ github.api_url }}/repos/${{ github.repository }}/dispatches" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"event_type": "deploy", "client_payload": {"sha": "${{ github.sha }}"}}'
```

Guard against loops, for example with `paths-ignore`, `types`, or an `if:` that checks `github.actor` or the commit message.

## Differences from GitHub

- Only the events in [Supported events](#supported-events) start runs. Other GitHub event names parse but never fire.
- `pull_request` and `pull_request_target` fire for `opened`, `synchronize`, `reopened`, `closed`, `edited`, `ready_for_review` and `converted_to_draft` only, and the `edited` payload has no `changes` object.
- `workflow_run` fires for `requested` and `completed`, not `in_progress`, and requires `workflows`.
- `release` workflows get no `branches`, `tags` or `paths` filtering, and a published release whose tag doesn't exist any more starts no runs.
- `deployment` and `deployment_status` events go to webhooks (a job with `environment:` sends both), but don't start workflow runs.
- `push` payloads list only the pushed commit in `commits`.
- Path filters pass when a push creates a branch.
- `github.event.inputs` keeps input types.
- `schedule` is checked every 5 minutes; a schedule runs within about 5 minutes after it is due.
