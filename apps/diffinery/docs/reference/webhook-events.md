---
title: Webhook events
description: Reference of every webhook event and action Diffinery sends, with the exact payload fields and example payloads.
---

This page lists every event a Diffinery [webhook](/docs/repositories/webhooks) can deliver, the actions of each event, and the exact payload fields, with an example for each. Use it to write or adapt a webhook receiver.

There are two kinds of payload. `push`, `pull_request`, `pull_request_review`, `issues`, `issue_comment` and `workflow_run` have small Diffinery payloads with ids and links. `release`, `status`, `deployment`, `deployment_status`, `deployment_review`, `repository_dispatch` and `workflow_dispatch` have GitHub's payload structure.

## Common structure

Every delivery is an HTTPS `POST` with a compact JSON body and these headers:

| Header | Value |
|---|---|
| `X-GitHub-Event` | The event name from this page, for example `pull_request` |
| `X-Diffinery-Event` | The same event name |
| `X-GitHub-Delivery` | A unique delivery id (32 hexadecimal characters). Retries of a failed delivery keep the same id. |
| `X-Hub-Signature-256` | `sha256=` and the hex HMAC-SHA256 of the body with the webhook's secret |
| `User-Agent` | `Diffinery-Hookshot/1` |
| `Content-Type` | `application/json` |

Every payload contains:

| Field | Type | Description |
|---|---|---|
| `action` | string | The action, for events that have one. Absent for `push`, `status` and `workflow_dispatch`. |
| `at` | string | ISO 8601 time the event happened. In the small payloads and in `workflow_dispatch`; `release`, `status`, `deployment`, `deployment_status`, `deployment_review` and `repository_dispatch` have no `at` (use their own `created_at` and `updated_at` fields). |
| `repository` | object | The repository (see below) |
| `sender` | object | The account that caused the event (see below) |

A delivery that fails with a network error, a timeout (10 seconds), `408`, `429` or a `5xx` status is sent again up to five times, 1 minute, 5 minutes, 30 minutes, 1 hour and 3 hours after each failed attempt, with the same id and body. See [Webhooks](/docs/repositories/webhooks#retries).

Deliveries to an [app's](/docs/repositories/apps) webhook also carry `installation` (`id` and `node_id`): the installation they came through. Apps also get `installation` events (`created`, `deleted`, `suspend`, `unsuspend`, `new_permissions_accepted`, with the installation object and, when created, its `repositories`) and `installation_repositories` events (`added`, `removed`, with `repositories_added` and `repositories_removed`), shaped like GitHub's.

The other top-level fields depend on the event. In the small payloads, Diffinery-specific fields use camelCase (`headRef`, `headSha`, `baseRef`, `commentId`, `runId`), and GitHub-style objects (`pull_request`, `issue`) are added where GitHub has them.

### The repository object

`repository` is GitHub's full repository object, the same shape `GET /api/v3/repos/{owner}/{repo}` returns, so receivers that read `repository.private`, `repository.visibility`, `repository.owner` or `repository.default_branch` work unchanged:

```json
{
  "id": 6628874657374920,
  "node_id": "UmVwb3NpdG9yeTo1YzBlOGI3ZjJkMWE0ZTNiOWY2YTdjOGQ5ZTBmMWEyYg",
  "name": "website",
  "full_name": "acme/website",
  "private": false,
  "owner": {
    "login": "acme",
    "id": 3915577218345164,
    "node_id": "T3JnYW5pemF0aW9uOjdlNmQ1YzRiM2EyZjFlMGQ5YzhiN2E2ZjVlNGQzYzJi",
    "avatar_url": "https://diffinery.com/api/avatars/acme",
    "gravatar_id": "",
    "url": "https://diffinery.com/api/v3/users/acme",
    "html_url": "https://diffinery.com/acme",
    "repos_url": "https://diffinery.com/api/v3/users/acme/repos",
    "organizations_url": "https://diffinery.com/api/v3/users/acme/orgs",
    "type": "Organization",
    "user_view_type": "public",
    "site_admin": false
  },
  "html_url": "https://diffinery.com/acme/website",
  "description": "The acme.example website",
  "fork": false,
  "url": "https://diffinery.com/api/v3/repos/acme/website",
  "archive_url": "https://diffinery.com/api/v3/repos/acme/website/{archive_format}{/ref}",
  "branches_url": "https://diffinery.com/api/v3/repos/acme/website/branches{/branch}",
  "commits_url": "https://diffinery.com/api/v3/repos/acme/website/commits{/sha}",
  "compare_url": "https://diffinery.com/api/v3/repos/acme/website/compare/{base}...{head}",
  "contents_url": "https://diffinery.com/api/v3/repos/acme/website/contents/{+path}",
  "deployments_url": "https://diffinery.com/api/v3/repos/acme/website/deployments",
  "git_refs_url": "https://diffinery.com/api/v3/repos/acme/website/git/refs{/sha}",
  "hooks_url": "https://diffinery.com/api/v3/repos/acme/website/hooks",
  "issues_url": "https://diffinery.com/api/v3/repos/acme/website/issues{/number}",
  "labels_url": "https://diffinery.com/api/v3/repos/acme/website/labels{/name}",
  "languages_url": "https://diffinery.com/api/v3/repos/acme/website/languages",
  "merges_url": "https://diffinery.com/api/v3/repos/acme/website/merges",
  "pulls_url": "https://diffinery.com/api/v3/repos/acme/website/pulls{/number}",
  "releases_url": "https://diffinery.com/api/v3/repos/acme/website/releases{/id}",
  "statuses_url": "https://diffinery.com/api/v3/repos/acme/website/statuses/{sha}",
  "tags_url": "https://diffinery.com/api/v3/repos/acme/website/tags",
  "git_url": "https://diffinery.com/acme/website.git",
  "ssh_url": "https://diffinery.com/acme/website.git",
  "clone_url": "https://diffinery.com/acme/website.git",
  "svn_url": "https://diffinery.com/acme/website",
  "homepage": null,
  "size": 0,
  "stargazers_count": 0,
  "watchers_count": 0,
  "language": null,
  "has_issues": true,
  "has_projects": false,
  "has_downloads": true,
  "has_wiki": false,
  "has_pages": false,
  "has_discussions": false,
  "forks_count": 0,
  "mirror_url": null,
  "archived": false,
  "disabled": false,
  "open_issues_count": 0,
  "license": null,
  "allow_forking": false,
  "is_template": false,
  "web_commit_signoff_required": false,
  "topics": [
    "website"
  ],
  "visibility": "public",
  "forks": 0,
  "open_issues": 0,
  "watchers": 0,
  "default_branch": "main",
  "created_at": "2026-03-02T14:20:11Z",
  "updated_at": "2026-10-12T16:03:40Z",
  "pushed_at": "2026-10-13T09:30:00Z"
}
```

| Field | Description |
|---|---|
| `id` | The repository's numeric id, the same number the REST API returns. It does not change when the repository is renamed or transferred, so use it rather than `full_name` to recognize a repository. |
| `node_id` | An opaque string id for the repository, as in the REST API |
| `name`, `full_name` | Repository name, and `owner/name` |
| `private` | `true` for a private repository, `false` for a public one |
| `visibility` | `public` or `private`: the repository's real visibility when the event is delivered |
| `owner` | The owning account as a user object: `login`, numeric `id`, `node_id`, `type` (`User` or `Organization`), `html_url`, `avatar_url` and API URLs |
| `description` | The repository's description, or `null` |
| `default_branch` | The default branch, for example `main` |
| `archived` | `true` when the repository is archived |
| `topics` | The repository's topics |
| `html_url`, `clone_url`, `git_url`, `ssh_url`, `svn_url` | Web address and clone URLs (all HTTPS: Diffinery has no SSH or git protocol access) |
| `url` and the `*_url` templates | REST API addresses, as on GitHub |
| `created_at`, `updated_at`, `pushed_at` | ISO 8601 times |

Fields GitHub fills with counts (`size`, `stargazers_count`, `watchers_count`, `forks_count`, `open_issues_count` and their short forms) are always `0` in webhook payloads, `fork` and `allow_forking` are `false`, and there is no `permissions` object. If the repository was deleted before the delivery was sent, `repository` falls back to a minimal object (`id`, `node_id`, `name`, `full_name`, `owner.login`, `html_url`, `clone_url`) with `"private": true` and `"visibility": "private"`.

To keep them short, the examples on this page show `repository` with only a few of its fields.

### The sender object

A person:

```json
{ "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "login": "diffy", "type": "User" }
```

An agent, with the login of the person or organization it acts for:

```json
{ "id": "f0e1d2c3b4a5968778695a4b3c2d1e0f", "login": "review-bot", "type": "Bot", "on_behalf_of": "diffy" }
```

| Field | Description |
|---|---|
| `id` | Account id (32 hexadecimal characters, unlike the numeric `repository.id`), or an id such as `system:merge-queue` for Diffinery's own actors |
| `login` | Login of the account |
| `type` | `User` for people, `Bot` for agents and for Diffinery's own actors |
| `on_behalf_of` | Only for agents: the login of the agent's owner |

Diffinery's own actors appear as `Bot` senders: `diffinery-merge-queue[bot]` (merge queue), `diffinery-scheduler` (scheduled workflow runs), and `diffinery-actions[bot]` with an id such as `job:2f1e0d9c8b7a69584736251403f2e1d0` for what a workflow job does with its `GITHUB_TOKEN` (opening an issue, posting a status, creating a release, ...).

## push

Sent when a branch or tag is created, moved or deleted. This includes `git push`, commits from the web editor, the contents API, the Git data API (`git/refs`) and MCP, merges of pull requests (a push to the base branch), updating a pull request's branch, the merge queue's own `gh-readonly-queue/...` branches, and tags created by publishing a release.

| Field | Type | Description |
|---|---|---|
| `ref` | string | The full ref, for example `refs/heads/main` or `refs/tags/v1.2.0` |
| `before` | string | Commit SHA the ref pointed to before; 40 zeros when the ref was created |
| `after` | string | Commit SHA the ref points to now; 40 zeros when the ref was deleted |
| `forced` | boolean | `true` when the update was not a fast-forward |
| `created` | boolean | `true` when the ref was created |
| `deleted` | boolean | `true` when the ref was deleted |
| `at` | string | Time of the push |

There is no `action`, no `commits` list, no `head_commit` and no `pusher`; `sender` is the pusher. Use `GET /api/v3/repos/{owner}/{repo}/compare/{before}...{after}` to get the commits.

```json
{
  "ref": "refs/heads/main",
  "before": "6f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6",
  "after": "9c4d8e2f1a0b3c5d7e9f2a4b6c8d0e1f3a5b7c9d",
  "forced": false,
  "created": false,
  "deleted": false,
  "at": "2026-10-13T09:30:00.000Z",
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "login": "diffy", "type": "User" }
}
```

A new branch:

```json
{
  "ref": "refs/heads/fix-typo",
  "before": "0000000000000000000000000000000000000000",
  "after": "2b7e9d4c1a3f5e7d9b0c2a4e6f8d0b1c3e5a7f9d",
  "forced": false,
  "created": true,
  "deleted": false,
  "at": "2026-10-13T09:31:12.000Z",
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "f0e1d2c3b4a5968778695a4b3c2d1e0f", "login": "review-bot", "type": "Bot", "on_behalf_of": "diffy" }
}
```

## pull_request

Sent for pull request activity.

| Action | Sent when | Sender |
|---|---|---|
| `opened` | A pull request is created | Its author |
| `synchronize` | The head branch moved to a new commit | The pusher |
| `edited` | The title or description changed (web UI, `PATCH /pulls/{number}`, or the `update_issue` MCP tool). Not sent when the new text equals the old, or for label changes. | Who edited it |
| `ready_for_review` | A draft is marked ready for review (**Ready for review**, `diffinery pr ready`, or `PATCH` with `"draft": false`) | Who marked it |
| `converted_to_draft` | An open pull request is turned back into a draft (`diffinery pr ready --undo`, or `PATCH` with `"draft": true`). The pull request's timeline records this as `convert_to_draft`, GitHub's timeline name; the webhook action is `converted_to_draft`, as on GitHub. | Who converted it |
| `closed` | The pull request is closed without merging (`pull_request.merged` is `false`), or is merged (`pull_request.merged` is `true`) | Who closed or merged it; for a merge by the merge queue, who added it to the queue |
| `reopened` | A closed pull request is reopened | Who reopened it |
| `assigned` | One or more people are newly assigned | Who assigned them |
| `review_requested` | One or more reviewers are newly requested | Who requested the review |
| `enqueued` | The pull request was added to a merge queue | Who added it |
| `dequeued` | The pull request was removed from the merge queue without merging: by a person, or because its merge group failed, conflicted or timed out | Who removed it, or `diffinery-merge-queue[bot]` |
| `auto_merge_enabled` | [Auto-merge](/docs/collaboration/pull-requests#auto-merge) was turned on, or its method changed | Who turned it on |
| `auto_merge_disabled` | Auto-merge was turned off: by someone, by a push from someone else, by converting the pull request to a draft, or by itself because it can't go through | Who turned it off, the pusher, or `diffinery-auto-merge[bot]` |

| Field | Type | Description |
|---|---|---|
| `action` | string | One of the actions above |
| `number` | number | The pull request number |
| `headRef` | string | Head branch name |
| `headSha` | string | Head commit SHA |
| `baseRef` | string | Base branch name |
| `at` | string | Time of the event |
| `assignees` | array of strings | Only for `assigned`: logins newly assigned |
| `reviewers` | array of strings | Only for `review_requested`: logins newly requested |
| `pull_request.number` | number | The pull request number |
| `pull_request.html_url` | string | Web address of the pull request |
| `pull_request.head.ref` | string | Head branch name |
| `pull_request.head.sha` | string | Head commit SHA |
| `pull_request.base.ref` | string | Base branch name |
| `pull_request.merged` | boolean | `true` only when the pull request was merged (action `closed`) |

The payload does not include the title, body, author, labels or draft state, and `edited` has no `changes` object with the old values. Fetch the current values with `GET /api/v3/repos/{owner}/{repo}/pulls/{number}`.

Opened:

```json
{
  "action": "opened",
  "number": 42,
  "headRef": "fix-typo",
  "headSha": "2b7e9d4c1a3f5e7d9b0c2a4e6f8d0b1c3e5a7f9d",
  "baseRef": "main",
  "at": "2026-10-13T09:32:40.000Z",
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "f0e1d2c3b4a5968778695a4b3c2d1e0f", "login": "review-bot", "type": "Bot", "on_behalf_of": "diffy" },
  "pull_request": {
    "number": 42,
    "html_url": "https://diffinery.com/acme/website/pull/42",
    "head": { "ref": "fix-typo", "sha": "2b7e9d4c1a3f5e7d9b0c2a4e6f8d0b1c3e5a7f9d" },
    "base": { "ref": "main" },
    "merged": false
  }
}
```

Merged (delivered as `closed`):

```json
{
  "action": "closed",
  "number": 42,
  "headRef": "fix-typo",
  "headSha": "2b7e9d4c1a3f5e7d9b0c2a4e6f8d0b1c3e5a7f9d",
  "baseRef": "main",
  "at": "2026-10-13T10:05:11.000Z",
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "login": "diffy", "type": "User" },
  "pull_request": {
    "number": 42,
    "html_url": "https://diffinery.com/acme/website/pull/42",
    "head": { "ref": "fix-typo", "sha": "2b7e9d4c1a3f5e7d9b0c2a4e6f8d0b1c3e5a7f9d" },
    "base": { "ref": "main" },
    "merged": true
  }
}
```

A merge also sends a `push` event for the base branch.

Review requested:

```json
{
  "action": "review_requested",
  "number": 42,
  "headRef": "fix-typo",
  "headSha": "2b7e9d4c1a3f5e7d9b0c2a4e6f8d0b1c3e5a7f9d",
  "baseRef": "main",
  "at": "2026-10-13T09:33:05.000Z",
  "reviewers": ["diffy"],
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "f0e1d2c3b4a5968778695a4b3c2d1e0f", "login": "review-bot", "type": "Bot", "on_behalf_of": "diffy" },
  "pull_request": {
    "number": 42,
    "html_url": "https://diffinery.com/acme/website/pull/42",
    "head": { "ref": "fix-typo", "sha": "2b7e9d4c1a3f5e7d9b0c2a4e6f8d0b1c3e5a7f9d" },
    "base": { "ref": "main" },
    "merged": false
  }
}
```

The `assigned` payload has the same shape with `"assignees": ["diffy"]` instead of `reviewers`.

Ready for review (`edited` and `converted_to_draft` look the same apart from `action`):

```json
{
  "action": "ready_for_review",
  "number": 42,
  "headRef": "fix-typo",
  "headSha": "2b7e9d4c1a3f5e7d9b0c2a4e6f8d0b1c3e5a7f9d",
  "baseRef": "main",
  "at": "2026-10-13T09:45:10.000Z",
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "login": "diffy", "type": "User" },
  "pull_request": {
    "number": 42,
    "html_url": "https://diffinery.com/acme/website/pull/42",
    "head": { "ref": "fix-typo", "sha": "2b7e9d4c1a3f5e7d9b0c2a4e6f8d0b1c3e5a7f9d" },
    "base": { "ref": "main" },
    "merged": false
  }
}
```

## pull_request_review

Sent when someone submits a review on a pull request.

| Action | Sent when |
|---|---|
| `submitted` | A review is submitted (approve, request changes, or comment) |

| Field | Type | Description |
|---|---|---|
| `action` | string | `submitted` |
| `number` | number | The pull request number |
| `state` | string | `APPROVED`, `CHANGES_REQUESTED` or `COMMENTED` (uppercase) |
| `at` | string | Time of the review |

There is no `review` or `pull_request` object, and the review body is not included. Get the review with `GET /api/v3/repos/{owner}/{repo}/pulls/{number}/reviews`. GitHub sends `review.state` in lowercase; Diffinery's top-level `state` is uppercase.

```json
{
  "action": "submitted",
  "number": 42,
  "state": "APPROVED",
  "at": "2026-10-13T09:50:00.000Z",
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "login": "diffy", "type": "User" }
}
```

## issues

Sent for issue activity. Pull requests send `pull_request` events instead.

| Action | Sent when |
|---|---|
| `opened` | An issue is created |
| `edited` | The title or body changed (web UI, `PATCH /issues/{number}`, or the `update_issue` MCP tool) |
| `closed` | An issue is closed, including by a merged pull request that says `fixes #12` |
| `reopened` | A closed issue is reopened |
| `assigned` | One or more people are newly assigned |

Saving the same title and body again sends nothing, and changing labels sends no event. `edited` has no `changes` object with the old values; read the issue with the REST API for the current ones.

| Field | Type | Description |
|---|---|---|
| `action` | string | One of the actions above |
| `number` | number | The issue number |
| `at` | string | Time of the event |
| `assignees` | array of strings | Only for `assigned`: logins newly assigned |
| `issue.number` | number | The issue number |
| `issue.html_url` | string | Web address of the issue |

```json
{
  "action": "opened",
  "number": 12,
  "at": "2026-10-13T08:15:00.000Z",
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "login": "diffy", "type": "User" },
  "issue": { "number": 12, "html_url": "https://diffinery.com/acme/website/issues/12" }
}
```

```json
{
  "action": "assigned",
  "number": 12,
  "at": "2026-10-13T08:20:00.000Z",
  "assignees": ["review-bot"],
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "login": "diffy", "type": "User" },
  "issue": { "number": 12, "html_url": "https://diffinery.com/acme/website/issues/12" }
}
```

## issue_comment

Sent when a comment is added to an issue or to a pull request's conversation. Line comments inside a review do not send this event.

| Action | Sent when |
|---|---|
| `created` | A comment is added |

| Field | Type | Description |
|---|---|---|
| `action` | string | `created` |
| `number` | number | The issue or pull request number |
| `commentId` | string | The comment's id |
| `at` | string | Time of the comment |
| `issue.number` | number | The issue or pull request number |
| `issue.html_url` | string | `https://diffinery.com/{owner}/{repo}/issues/{number}`; for a pull request this address redirects to the pull request |

The comment body is not included. Read it with `GET /api/v3/repos/{owner}/{repo}/issues/{number}/comments` and find the entry whose `id` equals `commentId`. Comments posted by `diffinery-merge-queue[bot]` (for example when a pull request leaves the queue) also send this event.

```json
{
  "action": "created",
  "number": 42,
  "commentId": "3e2d1c0b9a8f4e7d6c5b4a3f2e1d0c9b",
  "at": "2026-10-13T09:40:00.000Z",
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "f0e1d2c3b4a5968778695a4b3c2d1e0f", "login": "review-bot", "type": "Bot", "on_behalf_of": "diffy" },
  "issue": { "number": 42, "html_url": "https://diffinery.com/acme/website/issues/42" }
}
```

## workflow_run

Sent when a [Diffinery Actions](/docs/actions/overview) workflow run is created and when it finishes.

| Action | Sent when |
|---|---|
| `requested` | A run is created, for any trigger (push, pull request, schedule, manual dispatch, merge queue, workflow run, release, repository dispatch) |
| `completed` | The run finished |

| Field | Type | Description |
|---|---|---|
| `action` | string | `requested` or `completed` |
| `runId` | string | The run id. The run is at `https://diffinery.com/{owner}/{repo}/actions/runs/{runId}` and in the API at `GET /api/v3/repos/{owner}/{repo}/actions/runs/{runId}`. |
| `conclusion` | string | Only for `completed`: `success`, `failure` or `cancelled` |
| `at` | string | Time of the event |

The sender is the account that triggered the run; for scheduled runs it is `diffinery-scheduler`. The sender of this event has no `on_behalf_of` field, even for agents. There is no `workflow_run` object: fetch the run for its workflow, branch and SHA.

```json
{
  "action": "completed",
  "runId": "8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a",
  "conclusion": "success",
  "at": "2026-10-13T09:36:21.000Z",
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "login": "diffy", "type": "User" }
}
```

## release

Sent for release activity, including activity on drafts. See [Releases](/docs/collaboration/releases).

| Action | Sent when |
|---|---|
| `created` | A release is created, as a draft or published |
| `published` | A release is published: created as published, or a draft is published |
| `released` | A full (not pre-release) release is published, or a published pre-release becomes a full release |
| `prereleased` | A pre-release is published, or a published release becomes a pre-release |
| `edited` | A release is edited without publishing or unpublishing it (also for drafts) |
| `unpublished` | A published release is turned back into a draft |
| `deleted` | A release is deleted |

One change can send several deliveries, in this order. Creating a published release sends `created`, `published` and then `released` (or `prereleased`). Publishing a draft sends `published` and `released` (or `prereleased`). Editing a published release's pre-release flag sends `edited` and `released` (or `prereleased`). Uploading, renaming or deleting assets sends nothing.

| Field | Type | Description |
|---|---|---|
| `action` | string | One of the actions above |
| `release` | object | The release, exactly as `GET /api/v3/repos/{owner}/{repo}/releases/{id}` returns it, including `assets`, `upload_url`, `author` and Diffinery's `latest` |
| `repository` | object | The repository |
| `sender` | object | Who made the change |

The `release.reactions` counts in webhook payloads are always zero; read reactions with the REST API.

```json
{
  "action": "published",
  "release": {
    "url": "https://diffinery.com/api/v3/repos/acme/website/releases/7",
    "assets_url": "https://diffinery.com/api/v3/repos/acme/website/releases/7/assets",
    "upload_url": "https://diffinery.com/api/uploads/repos/acme/website/releases/7/assets{?name,label}",
    "html_url": "https://diffinery.com/acme/website/releases/tag/v1.2.0",
    "id": 7,
    "author": {
      "login": "diffy",
      "id": 7220136606554077,
      "node_id": "VXNlcjphMWIyYzNkNGU1ZjYwNzE4MjkzYTRiNWM2ZDdlOGY5MA",
      "avatar_url": "https://diffinery.com/api/avatars/diffy",
      "gravatar_id": "",
      "url": "https://diffinery.com/api/v3/users/diffy",
      "html_url": "https://diffinery.com/diffy",
      "repos_url": "https://diffinery.com/api/v3/users/diffy/repos",
      "organizations_url": "https://diffinery.com/api/v3/users/diffy/orgs",
      "type": "User",
      "user_view_type": "public",
      "site_admin": false
    },
    "node_id": "UmVsZWFzZTo3",
    "tag_name": "v1.2.0",
    "target_commitish": "main",
    "name": "Website 1.2.0",
    "draft": false,
    "immutable": false,
    "prerelease": false,
    "created_at": "2026-10-13T10:00:00Z",
    "updated_at": "2026-10-13T10:00:00Z",
    "published_at": "2026-10-13T10:00:00Z",
    "assets": [],
    "tarball_url": "https://diffinery.com/api/v3/repos/acme/website/tarball/v1.2.0",
    "zipball_url": "https://diffinery.com/api/v3/repos/acme/website/zipball/v1.2.0",
    "body": "## What's Changed\n* Fix broken footer links by @diffy in https://diffinery.com/acme/website/pull/41\n\n**Full Changelog**: https://diffinery.com/acme/website/compare/v1.1.0...v1.2.0",
    "reactions": { "url": "https://diffinery.com/api/v3/repos/acme/website/releases/7/reactions", "total_count": 0, "+1": 0, "-1": 0, "laugh": 0, "confused": 0, "heart": 0, "hooray": 0, "rocket": 0, "eyes": 0 },
    "latest": true
  },
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "login": "diffy", "type": "User" }
}
```

> **Note:** Webhooks receive events for drafts, which only people with the write role can see in the web UI and API. Treat release payloads from private repositories, and drafts in public ones, as private.

## status

Sent every time a commit status is posted with `POST /repos/{owner}/{repo}/statuses/{sha}`. There is no `action`. See [Checks and commit statuses](/docs/collaboration/checks-and-statuses).

| Field | Type | Description |
|---|---|---|
| `id` | number | The status id |
| `sha` | string | The commit |
| `name` | string | The repository's full name, `owner/name` |
| `state` | string | `pending`, `success`, `failure` or `error` |
| `context` | string | The status context (`default` when none was given) |
| `description` | string or null | The description |
| `target_url` | string or null | The link to the build |
| `commit.sha` | string | The commit, again |
| `created_at`, `updated_at` | string | When the status was posted (ISO 8601 with milliseconds) |

```json
{
  "id": 17,
  "sha": "9c4d8e2f1a0b3c5d7e9f2a4b6c8d0e1f3a5b7c9d",
  "name": "acme/website",
  "state": "success",
  "context": "ci/external",
  "description": "Build #812 passed in 3m 12s",
  "target_url": "https://ci.example.com/builds/812",
  "commit": { "sha": "9c4d8e2f1a0b3c5d7e9f2a4b6c8d0e1f3a5b7c9d" },
  "created_at": "2026-10-13T09:40:00.000Z",
  "updated_at": "2026-10-13T09:40:00.000Z",
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "c1b2a3d4e5f60718293a4b5c6d7e8f9a", "login": "ci-bot", "type": "User" }
}
```

Unlike GitHub's `status` payload, `commit` holds only the SHA and there is no `branches` list. Check runs don't send webhook events.

## deployment

Sent when a deployment is created:

- with `POST /repos/{owner}/{repo}/deployments` (sender: who created it);
- when a workflow job with `environment:` starts (sender: who started the run), as on GitHub. The `deployment` event comes first, then a `deployment_status` event with `in_progress`. Such a deployment has the task `deploy`, `description` `null`, `payload` `{}`, and `ref` set to the branch or tag name the run is for.

| Action | Sent when |
|---|---|
| `created` | A deployment is created |

| Field | Type | Description |
|---|---|---|
| `action` | string | `created` |
| `deployment.id` | number | The deployment id |
| `deployment.sha` | string | The commit being deployed |
| `deployment.ref` | string | The ref as it was given (branch, tag or SHA) |
| `deployment.task` | string | The task, `deploy` by default |
| `deployment.environment` | string | The environment, `production` by default. Environment names are case-insensitive: a deployment to `Production` when a `production` environment exists reports `production`. |
| `deployment.description` | string or null | The description |
| `deployment.payload` | any | The `payload` sent when creating the deployment: the JSON value, or the string when it wasn't JSON. `{}` by default. |
| `deployment.created_at` | string | Creation time (ISO 8601 with milliseconds) |

```json
{
  "action": "created",
  "deployment": {
    "id": 3,
    "sha": "9c4d8e2f1a0b3c5d7e9f2a4b6c8d0e1f3a5b7c9d",
    "ref": "main",
    "task": "deploy",
    "environment": "production",
    "description": "Deploy website 1.2.0",
    "payload": { "version": "1.2.0" },
    "created_at": "2026-10-13T10:05:00.000Z"
  },
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "login": "diffy", "type": "User" }
}
```

## deployment_status

Sent when a deployment gets a new status:

- with `POST /repos/{owner}/{repo}/deployments/{id}/statuses`;
- when a workflow job with `environment:` starts (`in_progress`, sender: who started the run);
- when that job finishes (`success`; `inactive` when it was cancelled or skipped; `failure` otherwise; sender: who started the run).

When a `success` status makes older deployments (created earlier) to the same environment `inactive`, those `inactive` statuses don't send events. Deployments created later than the one that succeeded are left as they are.

| Action | Sent when |
|---|---|
| `created` | A status is added |

| Field | Type | Description |
|---|---|---|
| `action` | string | `created` |
| `deployment_status.id` | number | The status id |
| `deployment_status.state` | string | `error`, `failure`, `inactive`, `in_progress`, `queued`, `pending` or `success` |
| `deployment_status.description` | string | The description, up to 140 characters; empty when none |
| `deployment_status.environment` | string | The environment |
| `deployment_status.environment_url` | string | The deployed site's URL; empty when none |
| `deployment_status.log_url` | string | The deployment's log (for jobs, the job's page); empty when none |
| `deployment_status.created_at` | string | When the status was added (ISO 8601 with milliseconds) |
| `deployment.id`, `.sha`, `.ref`, `.task`, `.environment` | | The deployment the status belongs to |

```json
{
  "action": "created",
  "deployment_status": {
    "id": 5,
    "state": "success",
    "description": "",
    "environment": "production",
    "environment_url": "https://www.acme.example",
    "log_url": "https://diffinery.com/acme/website/actions/runs/8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a/job/2f1e0d9c8b7a69584736251403f2e1d0",
    "created_at": "2026-10-13T10:07:44.000Z"
  },
  "deployment": {
    "id": 3,
    "sha": "9c4d8e2f1a0b3c5d7e9f2a4b6c8d0e1f3a5b7c9d",
    "ref": "main",
    "task": "deploy",
    "environment": "production"
  },
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "login": "diffy", "type": "User" }
}
```

## deployment_review

Sent when a workflow run starts waiting on an environment's [required reviewers](/docs/actions/environments#required-reviewers-and-wait-timers), and when a reviewer decides, on the run page or with `POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments`. An environment with only a wait timer sends no event.

| Action | Sent when | Sender |
|---|---|---|
| `requested` | A job that names the environment becomes ready and has to wait for a reviewer (once per environment and run) | Who started the run |
| `approved` | A reviewer approves the environment for the run | The reviewer |
| `rejected` | A reviewer rejects it | The reviewer |

| Field | Type | Description |
|---|---|---|
| `action` | string | `requested`, `approved` or `rejected` |
| `since` | string | When the event happened (ISO 8601) |
| `environment` | string | The environment's name |
| `environment_id` | number or null | The environment's id, as `GET .../environments` shows it |
| `state` | string | `approved` or `rejected`. Absent on `requested`. |
| `comment` | string | The reviewer's comment; empty on `requested` or when none was given |
| `workflow_run` | object | `id`, `run_number`, `name`, `display_title`, `head_sha`, `head_branch` and `html_url` of the run |
| `reviewers` | array | The environment's required reviewers, each `{ "type": "User", "reviewer": { "login", "id" } }` |
| `requestor` | object | `{ "login" }` of who started the run. Only on `requested`. |
| `approver` | object | `{ "login" }` of the reviewer who decided. Only on `approved` and `rejected`. |

```json
{
  "action": "approved",
  "since": "2026-10-13T10:12:30.000Z",
  "environment": "production",
  "environment_id": 4,
  "comment": "Release notes look good",
  "state": "approved",
  "workflow_run": {
    "id": "8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a",
    "run_number": 128,
    "name": "Deploy",
    "display_title": "Release 2.4",
    "head_sha": "4f1c2e9d0b7a6c5e3f2d1c0b9a8e7d6c5b4a3f2e",
    "head_branch": "main",
    "html_url": "https://diffinery.com/acme/website/actions/runs/8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a"
  },
  "reviewers": [{ "type": "User", "reviewer": { "login": "alice", "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90" } }],
  "approver": { "login": "alice" },
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "login": "alice", "type": "User" }
}
```

Unlike GitHub, `workflow_run` holds only the fields above and `reviewers[].reviewer.id` is the Diffinery account id.

## repository_dispatch

Sent when someone with the write role calls `POST /repos/{owner}/{repo}/dispatches`. The same request starts workflows with `on: repository_dispatch` (see [Events that trigger workflows](/docs/actions/events)).

```sh
curl -sS -X POST -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  https://diffinery.com/api/v3/repos/acme/website/dispatches \
  -d '{ "event_type": "deploy-docs", "client_payload": { "version": "1.2.0" } }'
```

| Field | Type | Description |
|---|---|---|
| `action` | string | The `event_type` from the request (1 to 100 characters) |
| `branch` | string | The repository's default branch |
| `client_payload` | object | The `client_payload` from the request (`{}` when none): at most 10 top-level keys and 64 KB |

```json
{
  "action": "deploy-docs",
  "branch": "main",
  "client_payload": { "version": "1.2.0" },
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "f0e1d2c3b4a5968778695a4b3c2d1e0f", "login": "review-bot", "type": "Bot", "on_behalf_of": "diffy" }
}
```

## workflow_dispatch

Sent when someone with the write role starts a workflow by hand: **Run workflow** in the web UI, `diffinery workflow run`, `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`, or the `dispatch_workflow` MCP tool. It is sent once the request is accepted (the workflow exists at the ref, has a `workflow_dispatch` trigger and the inputs are valid), alongside the `workflow_run` event with `"action": "requested"` for the new run. There is no `action`.

| Field | Type | Description |
|---|---|---|
| `ref` | string | The full ref the workflow runs on, for example `refs/heads/main` or `refs/tags/v1.2.0` |
| `workflow` | string | The workflow file's path, for example `.github/workflows/deploy.yml` |
| `inputs` | object | The inputs after defaults and type conversion: booleans and numbers keep their types (GitHub sends strings). Inputs the workflow doesn't declare are dropped. |
| `at` | string | Time of the dispatch |

```json
{
  "ref": "refs/heads/main",
  "workflow": ".github/workflows/deploy.yml",
  "inputs": { "environment": "staging", "version": "1.2.0", "dry-run": false },
  "at": "2026-10-13T10:15:00.000Z",
  "repository": { "id": 6628874657374920, "name": "website", "full_name": "acme/website", "private": false, "visibility": "public", "html_url": "https://diffinery.com/acme/website" },
  "sender": { "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "login": "diffy", "type": "User" }
}
```

The workflow's own inputs are in the [workflow_dispatch trigger](/docs/actions/events#workflow_dispatch).

## Events that are never delivered

Audit entries (sign-ins, push protection decisions, settings changes) are not sent to webhooks. They are in the [audit log](/docs/security/audit-log). Check runs and check suites (GitHub's `check_run` and `check_suite`) send no events either; commit statuses send `status`. Transferring or renaming a repository sends no event (GitHub sends a `repository` event); a webhook keeps receiving deliveries afterwards, with the new `full_name` and `html_url`.

An [import from GitHub](/docs/migrate-from-github) sends no events while it fills a repository: the branches and tags it pushes send no `push`, and the issues, pull requests, comments, reviews and releases it copies send no `issues`, `pull_request`, `issue_comment`, `pull_request_review` or `release`, so a webhook added during an import isn't flooded with old history and no workflows start. Changes that people, agents and workflows make send events as usual. A repository imported with a homepage on GitHub has it as `homepage` in the repository object; otherwise `homepage` is `null`.

## Comparing with GitHub payloads

| Event | Fields GitHub sends that Diffinery does not |
|---|---|
| `push` | `commits`, `head_commit`, `pusher`, `compare`, `base_ref` |
| `pull_request` | The full pull request object (title, body, user, labels, state, draft, timestamps), and `changes` for `edited` |
| `pull_request_review` | `review` and `pull_request` objects |
| `issues` | The full issue object, and `changes` for `edited` |
| `issue_comment` | `comment` object, full `issue` object |
| `workflow_run` | `workflow_run` and `workflow` objects |
| `release` | Nothing in the `release` object, which has the REST API shape |
| `status` | `branches` and the full `commit` object |
| `deployment` | Most `deployment` fields (`url`, `creator`, `statuses_url`, `transient_environment`, `production_environment`, ...) |
| `deployment_status` | Most `deployment_status` fields (`url`, `creator`, `target_url`, ...) and the full `deployment` object |
| `repository_dispatch` | Nothing: the same `action`, `branch` and `client_payload` |
| `workflow_dispatch` | Nothing: the same `inputs`, `ref` and `workflow` (inputs keep their types) |

All events also lack GitHub's `installation` and `organization` objects. The `repository` object is complete apart from counters (always `0`) and `permissions`. Use the [REST API](/docs/api) to fetch any detail you need, keyed by `number`, `commentId` or `runId`. See [Webhooks](/docs/repositories/webhooks) for delivery behavior and signature verification.
