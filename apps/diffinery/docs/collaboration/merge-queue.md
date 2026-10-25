---
title: Merge queue
description: Merge pull requests in order, each tested on top of the base branch and the pull requests ahead of it, with merge_group workflows and required checks.
---

A merge queue merges pull requests into a busy branch one after another, testing each one together with the base branch and every pull request queued ahead of it before it lands. Use it when many pull requests target the same branch and you want the branch to stay green without asking authors to rebase and re-run CI over and over. Diffinery's merge queue works like GitHub's: it uses the same `gh-readonly-queue/` branches and the same `merge_group` workflow event.

## How it works

1. You turn on **Require a merge queue** in the base branch's protection rule and list the **Required status checks**.
2. A pull request with no merge blockers is added to the queue with **Merge when ready** (or the CLI, API or MCP).
3. Diffinery builds a **merge group** for it: a commit that contains the base branch, every pull request ahead of it in the queue, and this pull request's changes. The commit goes on a branch named `gh-readonly-queue/<base>/pr-<number>-<head sha>`.
4. Creating that branch triggers `merge_group` workflows (and `push` workflows that match the branch) on the merge group commit. Their checks are reported on that commit.
5. When the required checks pass on the merge group and every pull request ahead has merged, the base branch fast-forwards to exactly that tested commit. The pull request is marked merged, and its merge group branch is deleted.
6. If a merge group fails a required check, conflicts, or takes longer than the check timeout, its pull request leaves the queue with a comment saying why, and the groups behind it are rebuilt without it.

Because each group already contains everything ahead of it, the base branch only ever moves to commits that were tested exactly as they land.

## Turn on the merge queue

You need admin access to the repository, and you must be a person: agents can't change branch protection.

### Turn it on in the web UI

1. Open the repository's **Settings** and choose **Branch protection** (`https://diffinery.com/acme/website/settings/branches`).
2. Open the rule for the branch (for example `main`), or fill in **Add a rule** with `main` as the **Branch name pattern**.
3. In **Required status checks**, list the checks that must pass, one per line and exactly as they appear on pull requests, for example `CI / test` and `CI / lint`.
4. Tick **Require a merge queue**, then set:
   - **Merge method**: **Create a merge commit**, **Squash and merge** or **Rebase and merge**.
   - **Build concurrency**: how many merge groups are built and checked at once.
   - **Check timeout (minutes)**: how long a merge group may wait for its required checks.
5. Click **Create rule** or **Save rule**. You see `Branch protection saved.`

### Turn it on with the REST API

`PUT /repos/{owner}/{repo}/branches/{branch}/protection` replaces the whole rule, so send every setting you want to keep:

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/branches/main/protection \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{
    "requirePullRequest": true,
    "requiredApprovals": 1,
    "requiredChecks": ["CI / test"],
    "mergeQueue": { "method": "squash", "buildConcurrency": 5, "checkTimeoutMinutes": 30 }
  }'
```

`"mergeQueue": true` turns it on with the defaults. Read the rule back with `GET` on the same path. The token needs the `admin` scope. See [Branch protection](/docs/repositories/branch-protection) for the other rule settings.

### Settings

| Setting | API field | Default | Allowed values |
| --- | --- | --- | --- |
| Merge method | `mergeQueue.method` | `merge` | `merge`, `squash`, `rebase` (anything else becomes `merge`) |
| Build concurrency | `mergeQueue.buildConcurrency` | 5 | 1 to 20 (values outside are clamped) |
| Check timeout (minutes) | `mergeQueue.checkTimeoutMinutes` | 60 | 1 to 360 (values outside are clamped) |

Turning the queue off removes every queued pull request with the comment `This pull request was removed from the merge queue: main no longer uses a merge queue.`

## Required checks

The queue decides on **Required status checks** from the same branch protection rule:

- A pull request needs its required checks to pass on its own head commit before it can join the queue, like any merge (see [merge blockers](/docs/collaboration/pull-requests#merge-blockers)).
- Its merge group needs the same required checks to pass on the merge group commit before it merges.
- A check passes when its conclusion is `success`, `skipped` or `neutral`. Checks that aren't required are ignored by the queue, even when they fail.
- A required check can be a check run or a commit status context, and the queue counts reports the same way as branch protection: when Diffinery Actions reports a check, only its result counts; a check bound in the rule's `requiredCheckSources` counts only that reporter; reports from agents never count; and any counted failure fails the group. See [Branch protection](/docs/repositories/branch-protection#required-checks).

So the workflows that produce your required checks must run on both `pull_request` and `merge_group`. A job's check name is `<workflow name> / <job name>`, and it is the same for both events.

An external CI system that reports a required check must also report it on the merge group commit (`github.event.merge_group.head_sha`, the head of the `gh-readonly-queue/...` branch), with `POST /repos/{owner}/{repo}/statuses/{sha}` or `POST /repos/{owner}/{repo}/check-runs`. A finished commit status, or a check run sent with `POST` as completed, makes the queue look at the group again at once. A check run completed later with `PATCH` is only noticed at the queue's next event, at the latest when the check timeout ends, so send the final result with `POST` (see [Required checks and the merge queue](/docs/collaboration/checks-and-statuses#required-checks-and-the-merge-queue)). See [Checks and statuses](/docs/collaboration/checks-and-statuses).

> **Important:** With no required checks, a merge group passes as soon as it is built, so pull requests merge immediately in queue order without any CI on the combined result. List at least one required check.

## Write workflows for the merge queue

Add `merge_group` to the triggers of each workflow that produces a required check:

```yaml
name: CI
on:
  pull_request:
    branches: [main]
  merge_group:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
```

With this workflow, add `CI / test` to **Required status checks**.

What a `merge_group` run sees:

| Value | Content |
| --- | --- |
| `github.event_name` | `merge_group` |
| `github.ref` | `refs/heads/gh-readonly-queue/main/pr-12-<head sha>` |
| `github.sha` | The merge group commit |
| `github.event.action` | `checks_requested` |
| `github.event.merge_group.head_sha` | The merge group commit |
| `github.event.merge_group.head_ref` | The merge group branch, as a full ref |
| `github.event.merge_group.base_sha` | The commit the group was built on (the base tip, or the group ahead of it) |
| `github.event.merge_group.base_ref` | `refs/heads/main` |
| `github.event.merge_group.head_commit` | `id`, `tree_id`, `message`, `timestamp`, `author`, `committer` |

Trigger filters:

- `merge_group` accepts `types` (only `checks_requested` exists) and `branches` / `branches-ignore`, which match the **base** branch (`main`), not the queue branch.
- Creating a merge group branch is also a push, so `push` workflows whose branch filters match `gh-readonly-queue/...` run on it, as on GitHub. Restrict `push` to the branches you mean (as above), or exclude the queue with `branches-ignore: ['gh-readonly-queue/**']`.

`actions/checkout` checks out the merge group commit, so the job tests exactly what would land.

## Add a pull request to the queue

The pull request must have no merge blockers: approvals, required checks on its head, no conflicts, not a draft (mark a draft ready first with **Ready for review** or `diffinery pr ready 12`; see [Drafts](/docs/collaboration/pull-requests#drafts)). You need write access, and through the API a token with the `write` scope. Agents (and workflow tokens) can queue a pull request into the default branch or a protected one only when its rule has **Allow agents to land pull requests through auto-merge** and at least one required check, or, for agents, **Allow agents to merge pull requests**. To queue a pull request that isn't ready yet, turn on [auto-merge](/docs/collaboration/pull-requests#auto-merge): it adds the pull request to the queue by itself once it has no blockers, with the auto-merge method (by default the queue's). Agents use it the same way (see [Agents landing changes](/docs/repositories/branch-protection#agents-landing-changes)).

### Queue in the web UI

On the pull request's **Conversation** tab, the merge box says `main merges through a merge queue: the pull request is tested together with the ones ahead of it before it merges.`

1. Pick the **Merge method**. It defaults to the queue's method.
2. Leave **Delete fix-pricing-link after merge** ticked to delete the head branch when it merges.
3. Click **Merge when ready**. You see `Added to the merge queue.`, or `Merged through the merge queue.` if it merged straight away.

The merge box then shows `Queued to merge · position 2 in the main merge queue`, followed by `checking merge group abc1234` or `waiting for the pull requests ahead of it`, the required checks of the merge group, and a **Remove from queue** button.

### Queue with the CLI

```sh
diffinery pr merge 12 --squash --delete-branch
```

`diffinery pr merge` first tries a direct merge. Like `gh pr merge`, when the base branch uses a merge queue it adds the pull request to the queue instead, unless you pass `--admin` (see [Bypass the queue](#bypass-the-queue)). It prints `✓ Added #12 to the merge queue (position 2)`, or `✓ Merged #12 through the merge queue` and the commit when it merged at once. A method flag (`--merge`, `--squash`, `--rebase`) overrides the queue's method; without one the queue's method is used.

### Queue with the REST API

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/pulls/12/merge-queue \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"merge_method": "squash", "delete_branch": true}'
```

Both fields are optional; `merge_method` defaults to the queue's method. The response says where the pull request stands after the queue has been processed once:

```json
{
  "state": "queued",
  "entry": {
    "number": 12,
    "title": "Fix the Contact sales link",
    "base_ref": "main",
    "position": 2,
    "state": "checking",
    "head_sha": "3f2a9c1e...",
    "merge_method": "squash",
    "delete_branch": true,
    "enqueued_by": { "login": "diffy" },
    "enqueued_at": "2026-10-13T09:12:44.000Z",
    "merge_group": {
      "head_sha": "9be41d07...",
      "head_ref": "refs/heads/gh-readonly-queue/main/pr-12-3f2a9c1e...",
      "base_sha": "51c0e2aa...",
      "built_at": "2026-10-13T09:12:45.000Z"
    },
    "checks": [{ "name": "CI / test", "state": "in_progress" }]
  },
  "merge_commit_sha": null,
  "reason": null
}
```

| `state` | HTTP status | Meaning |
| --- | --- | --- |
| `queued` | 201 | In the queue; `entry` describes it |
| `merged` | 200 | Merged during this call; `merge_commit_sha` is the commit |
| `removed` | 200 | It joined but left at once; `reason` says why |

Adding a pull request that is already queued returns its current entry.

### Queue over MCP

`merge_pull_request` queues the pull request when its base branch uses a merge queue, with the optional `method` and `delete_branch`. If you pass `expected_head_sha` and the head has moved, it fails with `head branch was modified; review and try again`. The result has the same `state`, `entry`, `mergeCommit` and `reason` information.

## Order and merge groups

- **Order.** Pull requests are queued first come, first served, per base branch. `position` 1 is the front of the queue.
- **Group contents.** The first group is built on the current tip of the base branch. Each later group is built on the group ahead of it, so it contains the base and every pull request ahead plus its own changes.
- **Branch.** Each group lives on `gh-readonly-queue/<base>/pr-<number>-<head sha>`. Nobody can push to these branches: `merge queue branches are read-only`.
- **Concurrency.** At most **Build concurrency** groups exist at once. Pull requests beyond that wait with the state `queued` (shown as `waiting to be built`) and are built as the ones ahead merge or leave. A built group has the state `checking`.
- **Merging.** Only the front group merges, and only when it was built on the current base tip and its required checks passed. A group further back whose checks passed waits for those ahead.
- **Group commits** depend on the merge method:

| Method | Merge group commit |
| --- | --- |
| `merge` | A merge commit with parents (previous group or base, pull request head). Subject `Merge pull request #12 from fix-pricing-link`, body the pull request title. |
| `squash` | One commit on top of the previous group. Subject `<title> (#12)`, body a `* <subject>` line per commit. Author: the pull request's author. |
| `rebase` | Each of the pull request's commits replayed on top of the previous group, keeping its author and message. Pull requests that contain merge commits can't be rebased. |

The committer is the person who queued the pull request (`<login>@users.noreply.diffinery.com`). If the base branch requires linear history, the `merge` method is refused: `main requires linear history; use squash or rebase`. A rule can't combine the two in the queue's own method either: it is refused with `422`, and a queue without a method squashes there.

## When a pull request merges

When its turn comes, the base branch fast-forwards to the merge group commit. Then, as for any merge:

- the pull request is closed as merged, with `merge_commit_sha` set to the merge group commit and `merged_by` set to whoever queued it;
- `push` workflows and webhooks run for the base branch;
- open issues referenced with closing keywords (`Fixes #12`) close;
- the head branch is deleted if **Delete ... after merge** was ticked;
- the merge group branch is deleted. Its runs are left to finish.

## When a pull request leaves the queue

The queue removes a pull request in these cases. Except where noted, it posts a comment from `diffinery-merge-queue[bot]` on the pull request: `This pull request was removed from the merge queue: <reason>.`

| Reason in the comment | What happened |
| --- | --- |
| `the required check 'CI / test' failed on its merge group` | A required check concluded with a failure. Other wordings: `timed out`, `was cancelled`, `needs action`. |
| `required checks did not finish within 60 minutes ('CI / test')` | The required checks hadn't all completed within **Check timeout** of the group being built. |
| `it conflicts with main and the pull requests ahead of it (src/app.ts)` | The pull request can't be combined with the base and the groups ahead. Up to five files are listed. |
| `rebase merges cannot include merge commits; use a merge commit or squash` | The queue uses `rebase` and the pull request contains a merge commit. |
| `new commits were pushed to its branch` | The head branch moved after the pull request was queued. Queue it again once its checks pass. |
| `main no longer uses a merge queue` | The merge queue was turned off for the branch. |
| `the base branch main no longer exists` | The base branch was deleted. |
| `the pull request was closed` | No comment is posted. |
| `diffy removed it from the queue` | Someone removed it by hand. No comment is posted. |

When a pull request leaves, its merge group branch is deleted and its unfinished runs are cancelled with `Cancelled because its merge group was rebuilt or left the queue.` Fix the problem, wait for the pull request's own checks, and add it to the queue again.

Webhooks receive `pull_request` events with the actions `enqueued` and `dequeued`. Queueing and removal don't send notifications themselves; the removal comment does, like any comment.

## Rebuilding groups

A group is thrown away and rebuilt (and its unfinished runs cancelled) when the commit it was built on is no longer the expected one:

- a pull request ahead of it left the queue, so the groups behind it are rebuilt without it;
- the base branch moved outside the queue, for example an admin pushed to it or bypassed the queue, so every group is rebuilt on the new tip.

A rebuilt group gets a new commit, runs its `merge_group` workflows again, and its check timeout starts over.

## Remove a pull request from the queue

- **Web UI:** click **Remove from queue** in the merge box. You see `Removed from the merge queue.`
- **CLI:** `diffinery pr merge 12 --disable-auto`. Like `gh`, it turns auto-merge off, and a pull request that is in the queue also leaves it.
- **REST API:** `DELETE /repos/{owner}/{repo}/pulls/{number}/merge-queue` (returns `204`, or `404 #12 is not in the merge queue`).
- **MCP:** the `dequeue_pull_request` tool.

You need write access. Closing the pull request or pushing to its branch also removes it.

## The queue page

Each branch with a queue has a page at `/<owner>/<repo>/queue/<branch>`, for example `https://diffinery.com/acme/website/queue/main`. The merge box links to it. It shows the merge method and, for each queued pull request, its position, title and number, who queued it and when, and either `checking merge group abc1234` with the state of each required check, or `waiting to be built`. The page updates live. When the queue is empty it says `The queue is empty.`; for a branch without a queue it says `main does not use a merge queue. Turn it on in the branch protection settings.`

The same data is available from the API (read access):

```sh
curl -H "Authorization: Bearer dfy_..." https://diffinery.com/api/v3/repos/acme/website/merge-queue/main
```

```json
{
  "branch": "main",
  "enabled": true,
  "settings": { "method": "squash", "buildConcurrency": 5, "checkTimeoutMinutes": 30 },
  "entries": []
}
```

`entries` has the same shape as `entry` in the enqueue response. Each entry's `checks` lists the required checks (or, without required checks, the names of the check runs and statuses reported so far) with a state such as `expected` (no counted report yet), `queued`, `in_progress`, `success` or `failure`. A `pending` commit status shows as `in_progress`, and an `error` status as `failure`. `GET /repos/{owner}/{repo}/pulls/{number}/merge` also includes `mergeQueue` (`method` and the pull request's `entry`) when its base uses a queue.

## Bypass the queue

A repository admin who is a person can merge a pull request directly, skipping the queue, when it has no conflicts, isn't a draft, and the rule doesn't have **Do not allow administrators to bypass these rules**. Through a token, that needs the `admin` scope. The bypass must be asked for explicitly, and it skips only the queue:

| Request | Effect |
| --- | --- |
| `"bypass_merge_queue": true` | Merges directly instead of queueing. The pull request must still meet its branch rules (approvals, required checks on its head, linear history); otherwise the merge fails with `405` and `pull request is not mergeable: ...`. |
| `"bypass_rules": true` | Skips unmet branch rules, but not the queue: alone, it still gets `main requires a merge queue: add the pull request to the queue`. |
| Both | Merges directly even with unmet branch rules. |

How to ask for it:

- **Web UI:** **Merge now (bypass the queue)** under **Merge when ready**, which asks `Merge directly, bypassing the merge queue?` first. It merges with the queue's merge method. When the pull request doesn't meet the rules, the button reads **Merge now (bypass the queue and the unmet requirements)** instead and also sends `bypass_rules`. The button isn't shown when the rule has **Do not allow administrators to bypass these rules**.
- **CLI:** `diffinery pr merge 12 --admin`. It sends `bypass_merge_queue` and `bypass_rules`, so it skips both the queue and unmet rules, and the CLI doesn't fall back to queueing the pull request.
- **REST API:** `PUT /repos/{owner}/{repo}/pulls/{number}/merge` with `"bypass_merge_queue": true`, plus `"bypass_rules": true` when the pull request has unmet rules.

A direct merge with the `merge` method on a branch that requires linear history also needs `bypass_rules`; otherwise it fails with `main requires linear history; use squash or rebase`.

Every merge that skipped the queue is recorded in the [audit log](/docs/security/audit-log#git-and-pull-requests) as `pull_request.merge_bypassed`, with `merge queue` in the detail's `blockers`, together with any unmet rules skipped with `bypass_rules` (and `linear history required` for a merge commit on a linear-history branch). See [Admin bypass](/docs/collaboration/pull-requests#admin-bypass).

Everyone else gets `main requires a merge queue: add the pull request to the queue` (`405`) from a direct merge; an admin who could bypass sees `(or, as an admin, bypass the queue with bypass_merge_queue)` added to it. A bypass moves the base branch, so the queued groups are rebuilt.

## Differences from GitHub

- Branch names (`gh-readonly-queue/<base>/pr-<number>-<sha>`), the `merge_group` event and its `checks_requested` action match GitHub, so existing workflows and `branches-ignore` filters work unchanged.
- GitHub manages the merge queue through GraphQL; Diffinery has REST endpoints: `GET /repos/{owner}/{repo}/merge-queue/{branch}`, and `PUT` and `DELETE /repos/{owner}/{repo}/pulls/{number}/merge-queue`.
- Each pull request has its own merge group. The settings are the merge method, build concurrency and check timeout; there are no minimum or maximum group sizes or wait times.
- The queue is configured inside a branch protection rule (`mergeQueue`), not a separate ruleset.
- `rebase` in the queue replays the commits; a direct `rebase` merge outside the queue is a fast-forward only.
- Pull requests opened by agents still need a human approval before they can be queued, and agents can queue only where agents may merge.

## Troubleshooting

| Message or symptom | Cause and fix |
| --- | --- |
| `main does not use a merge queue; merge the pull request directly` | The base branch's rule doesn't have **Require a merge queue**. Merge normally. |
| `pull request cannot be added to the merge queue: ...` | The pull request has merge blockers, listed after the colon. Fix them first. |
| `main requires linear history; use squash or rebase` | Pick `squash` or `rebase`, or change the queue's method. |
| **Merge now (bypass the queue)** fails with `pull request is not mergeable: ... (as an admin you can bypass with bypass_rules)` | Skipping the queue doesn't skip unmet rules. Meet them, or merge with `diffinery pr merge 12 --admin` (or the API with both `bypass_merge_queue` and `bypass_rules`). |
| `the pull request left the merge queue: ...` (web UI) | It joined and was removed in the same step, for example because it conflicts with the groups ahead. |
| `merge queue branches are read-only` | You pushed to a `gh-readonly-queue/` branch. Push to the pull request's branch instead. |
| The group waits until the timeout | The required check names don't match what the workflow reports, or the workflow has no `merge_group` trigger. Compare **Required status checks** with the check names on the merge group commit. |
| An external check passed on the merge group but the group still waits | The report doesn't count: it came from an agent, from an account other than the one bound in `requiredCheckSources`, or Diffinery Actions reports a check with the same name. It may also have been posted on the pull request's head commit instead of the merge group commit. |
| Pull requests merge without CI | No required checks are configured. Add them to the rule. |
| `push` workflows run on `gh-readonly-queue/...` | Restrict `on.push.branches`, or add `branches-ignore: ['gh-readonly-queue/**']`. |
