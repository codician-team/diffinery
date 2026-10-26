---
title: GraphQL API
description: The GitHub-shaped GraphQL endpoint at /api/graphql that gh, Claude Code and release-please use for issues, pull requests, CI, commit history and releases: what it answers and limits.
---

Diffinery answers GraphQL at `https://diffinery.com/api/graphql` with the part of GitHub's GraphQL schema that covers repositories, issues, pull requests, reviews, CI, commit history and releases. Type, field, argument and enum names are GitHub's, so tools written for GitHub's GraphQL API work unchanged for those queries. The main users are the GitHub CLI (`gh pr create`, `gh pr view`, `gh pr checks`, `gh issue list`, `gh issue create` and the rest, see [GitHub CLI and Claude Code](/docs/agents/github-cli)) and Claude Code, which shows a session's pull request and its CI from it. [release-please](/docs/guides/release-please) reads commit history, merged pull requests and releases from it, and `gh release list` lists releases.

Everything else (creating releases, Actions, settings and so on) is in the [REST API](/docs/reference/rest-api).

## Requests

Send a `POST` with a JSON body and a token, as on GitHub:

```sh
curl https://diffinery.com/api/graphql \
  -H "Authorization: Bearer $DIFFINERY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "query { viewer { login } }"}'
```

| Property | Value |
| --- | --- |
| URL | `https://diffinery.com/api/graphql` |
| Method | `POST` with `{"query": "...", "variables": {...}, "operationName": "..."}`. A `GET` answers `405`. |
| Authentication | Required. A personal access token or agent token (`Authorization: Bearer dfy_...`, or `token dfy_...`), a workflow job's token (`GITHUB_TOKEN`), or a browser session. Without one the answer is `401`. |
| Token scopes | `read` is enough for queries. Mutations need `write`, like the REST calls that make the same change. |
| Permissions | The same as over REST: a repository you can't see answers as if it didn't exist, and each mutation needs the role its REST equivalent needs. Branch protection, required checks, required reviews and the agent rules apply to merges here too. A job's token reads and changes what its [`permissions:`](/docs/actions/workflow-permissions) allow: issues need `issues`, pull requests `pull-requests`, merging `contents`, and anyone may read a public repository's. |
| Introspection | `__schema` and `__type` work, so you can read the whole schema with any GraphQL client. |
| Subscriptions | Not supported. |

## What it answers

**Queries**

| Field | What you get |
| --- | --- |
| `viewer` | The signed-in account. |
| `repository(owner, name)` | A repository: its id, name, owner, visibility, default branch, merge methods, your permission, `issue(number)`, `issues(states, labels, orderBy, filterBy)`, `issueOrPullRequest(number)`, `pullRequest(number)`, `pullRequests(states, headRefName, baseRefName, labels, orderBy)`, `labels`, `milestones`, `assignableUsers`, `mentionableUsers`, `ref(qualifiedName)`, `releases(orderBy)`, `release(tagName)` and `latestRelease`. A renamed repository is found by its old name. |
| `user(login)` | A person or agent by login. |
| `node(id)`, `nodes(ids)` | A repository, issue or pull request by its global id (the `node_id` of the REST API). |
| `search(query, type: ISSUE)` | Issues and pull requests in one repository (`ISSUE_ADVANCED` works too). The query needs a `repo:owner/name` qualifier and understands `is:issue`, `is:pr`, `type:`, `is:open`, `is:closed`, `is:merged`, `state:`, `author:`, `assignee:`, `mentions:`, `label:`, `milestone:`, `no:assignee`, `no:label`, `no:milestone`, `review-requested:`, `head:`, `base:`, `draft:`, `sort:` and words to find in the title or body, with `@me` for yourself. This is what `gh pr status` and `gh issue list --search` send. |
| `rateLimit` | A budget in GitHub's shape. Diffinery limits requests per account (see [Limits](#limits)), not by query cost. |

`issues` takes GitHub's `filterBy`: `assignee` (a login, `*` for anyone, `null` for no one), `createdBy`, `mentioned`, `labels`, `milestoneNumber` (a number, `*` or `null`), `since` and `states`. `labels` on `issues` matches issues with any of the labels, as on GitHub. An `Issue` has its number, title, body, state and `stateReason`, author, labels, assignees, milestone and comments.

A `PullRequest` has its number, title, body, state, draft flag, author, branches (`baseRef` and `headRef`, with the branch's protection rule) and head commit, additions, deletions and changed files, labels, assignees, milestone, review requests, reviews and `latestReviews`, `reviewDecision`, comments, files, commits, `mergeable` and `mergeStateStatus`, auto-merge (`autoMergeRequest`) and `statusCheckRollup`.

**Commits and refs.** `ref(qualifiedName:)` takes a full name (`refs/heads/main`, `refs/tags/v1.0.0`) or a short one, which is looked up as a branch, then as a tag, as on GitHub; a ref that doesn't exist is `null`. A ref's `target` is its commit (an annotated tag is peeled to the commit it tags). A `Commit` has `history(first, after, last, before, path)`, the commit and its ancestors in `git log` order (with `path`, only the commits that changed that file or directory), and `associatedPullRequests`: for a commit on the default branch, the merged pull request that brought it there; for any other commit, also the open pull requests that contain it, as on GitHub.

**Releases.** `releases` lists published releases, and drafts for those who can push, oldest first unless `orderBy: {field: CREATED_AT, direction: DESC}` asks for newest first, as on GitHub. A `Release` has its `name`, `tagName`, `tag` and `tagCommit` (both `null` while a draft's tag doesn't exist yet), `description` (the notes), `url`, `isDraft`, `isPrerelease`, `isLatest`, `author`, `createdAt`, `publishedAt` and `updatedAt`.

**CI.** A commit's `statusCheckRollup` combines its check runs and commit statuses: `state` is `SUCCESS`, `FAILURE`, `ERROR`, `PENDING` or `EXPECTED`, and `contexts` lists each `CheckRun` and `StatusContext`, with `checkRunCountsByState` and `statusContextCountsByState` for the counts. A check run from Diffinery Actions has its workflow under `checkSuite.workflowRun.workflow.name`, and `isRequired(pullRequestNumber:)` says whether the base branch requires it.

**Mutations**

| Mutation | What it does | `gh` command |
| --- | --- | --- |
| `createPullRequest` | Opens a pull request, as a draft with `draft: true`. | `gh pr create` |
| `updatePullRequest` | Changes the title, body, state, labels, assignees or milestone. The base branch can't change. | `gh pr edit` |
| `addLabelsToLabelable`, `removeLabelsFromLabelable` | Adds or removes labels on a pull request or issue. | `gh pr edit` and `gh issue edit` with `--add-label`, `--remove-label` |
| `addAssigneesToAssignable`, `removeAssigneesFromAssignable` | Adds or removes assignees on a pull request or issue. | `gh pr edit` and `gh issue edit` with `--add-assignee`, `--remove-assignee` |
| `requestReviews` | Asks people for a review. Team reviewers aren't supported. | `gh pr create --reviewer`, `gh pr edit --add-reviewer` |
| `markPullRequestReadyForReview`, `convertPullRequestToDraft` | Moves a pull request out of draft or back into it. | `gh pr ready`, `gh pr ready --undo` |
| `addComment` | Comments on a pull request or issue. | `gh pr comment`, `gh issue comment` |
| `closePullRequest`, `reopenPullRequest` | Closes or reopens a pull request. | `gh pr close`, `gh pr reopen` |
| `mergePullRequest` | Merges with `MERGE`, `SQUASH` or `REBASE`, if nothing blocks it. | `gh pr merge` |
| `enablePullRequestAutoMerge`, `disablePullRequestAutoMerge` | Turns [auto-merge](/docs/collaboration/pull-requests) on or off. | `gh pr merge --auto`, `--disable-auto` |
| `createIssue` | Opens an issue, with labels, assignees and a milestone if you have triage access. | `gh issue create` |
| `updateIssue` | Changes an issue's title, body, state, labels, assignees or milestone. | `gh issue edit` |
| `closeIssue`, `reopenIssue` | Closes an issue, as `COMPLETED`, `NOT_PLANNED` or `DUPLICATE`, or reopens it. | `gh issue close --reason`, `gh issue reopen` |

## Fields Diffinery doesn't have

GitHub's schema is much larger than this one. To keep tools that ask for a few extra fields working, a field, argument or type that Diffinery doesn't know is left out of the answer instead of failing the whole query, and the answer says which:

```json
{
  "data": { "repository": { "pullRequest": { "number": 1 } } },
  "extensions": { "unsupported": ["Cannot query field \"notAThing\" on type \"PullRequest\"."] }
}
```

Lists Diffinery has no data for answer empty: `projectItems` and `reactionGroups`. Team review requests aren't supported. `isCrossRepository` is always `false`, since pull requests come from branches of the same repository.

## Errors

Errors use GitHub's shape: a `message`, the `path` of the field, and a `type` such as `NOT_FOUND`, `FORBIDDEN`, `UNPROCESSABLE` or `RATE_LIMITED`, both at the top of the error and under `extensions`. The GitHub CLI reads `type`. A field that fails is `null` while the rest of the answer still comes back.

```json
{
  "data": { "repository": null },
  "errors": [{ "type": "NOT_FOUND", "path": ["repository"], "message": "Could not resolve to a Repository with the name 'octo/nope'." }]
}
```

## Limits

| What | Limit |
| --- | --- |
| Query text | 64 KB, 20,000 tokens |
| Nesting | 16 levels |
| Fields in one query, fragments counted where they're spread | 2,000 |
| Page size (`first`, `last`) | 100 |
| Repositories in one query | 25 |

Each request counts against your account's request limit like a REST call, and `createPullRequest`, `createIssue` and `addComment` also count against the limit on creating things (60 a minute), as `POST /pulls`, `POST /issues` and comments do over REST. See [Rate limits](/docs/reference/rest-api#rate-limits).
