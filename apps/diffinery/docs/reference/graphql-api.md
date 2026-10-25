---
title: GraphQL API
description: The GitHub-shaped GraphQL endpoint at /api/graphql that the GitHub CLI and Claude Code use for pull requests and CI: what it answers, limits and errors.
---

Diffinery answers GraphQL at `https://diffinery.com/api/graphql` with the part of GitHub's GraphQL schema that covers repositories, pull requests, reviews and CI. Type, field, argument and enum names are GitHub's, so tools written for GitHub's GraphQL API work unchanged for those queries. The main users are the GitHub CLI (`gh pr create`, `gh pr view`, `gh pr checks`, `gh pr status`, `gh pr merge` and the rest, see [GitHub CLI and Claude Code](/docs/agents/github-cli)) and Claude Code, which shows a session's pull request and its CI from it.

Everything else (issues, releases, Actions, settings and so on) is in the [REST API](/docs/reference/rest-api).

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
| Authentication | Required. A personal access token or agent token (`Authorization: Bearer dfy_...`, or `token dfy_...`), or a browser session. Without one the answer is `401`. A workflow job's token can't use it yet: in workflows, use the REST API. |
| Token scopes | `read` is enough for queries. Mutations need `write`, like the REST calls that make the same change. |
| Permissions | The same as over REST: a repository you can't see answers as if it didn't exist, and each mutation needs the role its REST equivalent needs. Branch protection, required checks, required reviews and the agent rules apply to merges here too. |
| Introspection | `__schema` and `__type` work, so you can read the whole schema with any GraphQL client. |
| Subscriptions | Not supported. |

## What it answers

**Queries**

| Field | What you get |
| --- | --- |
| `viewer` | The signed-in account. |
| `repository(owner, name)` | A repository: its id, name, owner, visibility, default branch, merge methods, your permission, `pullRequest(number)`, `pullRequests(states, headRefName, baseRefName, labels, orderBy)`, `labels`, `milestones`, `assignableUsers` and `mentionableUsers`. A renamed repository is found by its old name. |
| `user(login)` | A person or agent by login. |
| `node(id)`, `nodes(ids)` | A repository or pull request by its global id (the `node_id` of the REST API). |
| `search(query, type: ISSUE)` | Pull requests in one repository. The query needs a `repo:owner/name` qualifier and understands `is:pr`, `is:open`, `is:closed`, `is:merged`, `state:`, `author:`, `assignee:`, `review-requested:`, `head:`, `base:`, `label:` and `draft:`, with `@me` for yourself. This is what `gh pr status` sends. |
| `rateLimit` | A budget in GitHub's shape. Diffinery limits requests per account (see [Limits](#limits)), not by query cost. |

A `PullRequest` has its number, title, body, state, draft flag, author, branches (`baseRef` and `headRef`, with the branch's protection rule) and head commit, additions, deletions and changed files, labels, assignees, milestone, review requests, reviews and `latestReviews`, `reviewDecision`, comments, files, commits, `mergeable` and `mergeStateStatus`, auto-merge (`autoMergeRequest`) and `statusCheckRollup`.

**CI.** A commit's `statusCheckRollup` combines its check runs and commit statuses: `state` is `SUCCESS`, `FAILURE`, `ERROR`, `PENDING` or `EXPECTED`, and `contexts` lists each `CheckRun` and `StatusContext`, with `checkRunCountsByState` and `statusContextCountsByState` for the counts. A check run from Diffinery Actions has its workflow under `checkSuite.workflowRun.workflow.name`, and `isRequired(pullRequestNumber:)` says whether the base branch requires it.

**Mutations**

| Mutation | What it does | `gh` command |
| --- | --- | --- |
| `createPullRequest` | Opens a pull request, as a draft with `draft: true`. | `gh pr create` |
| `updatePullRequest` | Changes the title, body, state, labels, assignees or milestone. The base branch can't change. | `gh pr edit` |
| `addLabelsToLabelable`, `removeLabelsFromLabelable` | Adds or removes labels. | `gh pr edit --add-label`, `--remove-label` |
| `addAssigneesToAssignable`, `removeAssigneesFromAssignable` | Adds or removes assignees. | `gh pr edit --add-assignee`, `--remove-assignee` |
| `requestReviews` | Asks people for a review. Team reviewers aren't supported. | `gh pr create --reviewer`, `gh pr edit --add-reviewer` |
| `markPullRequestReadyForReview`, `convertPullRequestToDraft` | Moves a pull request out of draft or back into it. | `gh pr ready`, `gh pr ready --undo` |
| `addComment` | Comments on a pull request. | `gh pr comment` |
| `closePullRequest`, `reopenPullRequest` | Closes or reopens a pull request. | `gh pr close`, `gh pr reopen` |
| `mergePullRequest` | Merges with `MERGE`, `SQUASH` or `REBASE`, if nothing blocks it. | `gh pr merge` |
| `enablePullRequestAutoMerge`, `disablePullRequestAutoMerge` | Turns [auto-merge](/docs/collaboration/pull-requests) on or off. | `gh pr merge --auto`, `--disable-auto` |

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

Each request counts against your account's request limit like a REST call, and `createPullRequest` and `addComment` also count against the limit on creating things (60 a minute), as `POST /pulls` and comments do over REST. See [Rate limits](/docs/reference/rest-api#rate-limits).
