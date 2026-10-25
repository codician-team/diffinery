---
title: Pull requests
description: Open, review, check, update and merge pull requests in the web UI, the CLI, the REST API and over MCP, including intent, drafts, blockers and auto-merge.
---

A pull request proposes merging the commits on one branch (the head) into another branch of the same repository (the base). Use it to get changes reviewed, run CI on them, and merge them under the base branch's protection rules, whether the author is a person or an AI agent.

## How pull requests work

- **Same repository.** The head and base are branches of the same repository. In the API, `head` may be written `owner:branch`; the part before the colon is ignored.
- **Shared numbering.** Pull requests and issues share one number sequence per repository, like on GitHub. `/acme/website/pull/12` and `/acme/website/issues/12` redirect to each other depending on what `#12` is, and `/acme/website/pulls/12` redirects to `/acme/website/pull/12`.
- **One open pull request per branch pair.** You can't open a second pull request for the same head and base while one is open.
- **The head moves with the branch.** Pushing to the head branch updates the pull request (a `synchronize` event), re-runs its `pull_request` workflows, and, if the base branch's rule has **Dismiss stale approvals when new commits are pushed**, dismisses earlier approvals. A push by anyone other than the person or agent who turned on [auto-merge](#auto-merge) turns it off.
- **Intent.** Each pull request can carry an `intent`: a short statement of what the change is meant to do, shown above the conversation. See [Intent](#intent).
- **Auto-merge.** Instead of waiting to click merge, you can turn on auto-merge: Diffinery merges the pull request by itself once every rule of its base branch is met. See [Auto-merge](#auto-merge).
- **Agents.** Pull requests opened by agents always need at least one human approval. See [Pull requests opened by agents](#pull-requests-opened-by-agents).

## Permissions

| Action | Who can do it |
| --- | --- |
| View pull requests | Anyone who can read the repository |
| Open a pull request | Write or higher |
| Comment and leave a Comment review | Anyone signed in who can read the repository |
| Approve or request changes | Write or higher, and not the pull request's author |
| Request reviewers after opening, or remove a request | The author, or triage or higher |
| Edit title and description, close, reopen | The author, or triage or higher |
| Mark a draft ready for review, or convert it back to a draft | The author, or write or higher |
| Edit or delete a comment or line comment | Its author, or maintain or higher |
| Lock and unlock the conversation | Triage or higher |
| Comment, review or react on a locked pull request | Triage or higher |
| Dismiss a review | Maintain or higher, not the pull request's author, and never an agent |
| Update the branch with its base (`update-branch`) | Write or higher, subject to the head branch's protection |
| Merge, or add to and remove from the merge queue | Write or higher, subject to [merge blockers](#merge-blockers) |
| Turn [auto-merge](#auto-merge) on or off | Write or higher; agents and workflow tokens only where the base branch allows it |

A token's scope can lower your role: a `read` token acts with at most read, a `write` token with at most maintain, and only an `admin` token keeps admin. Every change (opening, commenting, reviewing, editing, marking ready, merging) needs a signed-in caller: without credentials the API answers `401` with `authentication required`, even on a public repository, and a `read`-scoped token gets `403` with `this token needs the write scope`. On an archived repository every change is refused with `403` and `repository is archived (read-only)`. A workflow's `GITHUB_TOKEN` has extra limits: see [Pull requests and workflow tokens](#pull-requests-and-workflow-tokens). See [Permissions](/docs/accounts/permissions) and [Tokens](/docs/accounts/tokens).

## Open a pull request

### From a push

When you push a new branch (other than the default branch) that has no pull request yet, git prints a link to open one:

```text
remote: Create a pull request for 'fix-pricing-link':
remote:   https://diffinery.com/acme/website/compare/fix-pricing-link
```

Pushing to a branch that already has an open pull request prints `Updated pull request #12: https://diffinery.com/acme/website/pull/12`.

### In the web UI

1. Open the **Pull requests** tab and click **New pull request**, or go to `https://diffinery.com/acme/website/compare`. You can also open `https://diffinery.com/acme/website/compare/main...fix-pricing-link` directly, or click **Compare** next to a branch on the **Branches** page.
2. Pick the **base** (the branch to merge into) and the **compare** branch (your changes), then click **Compare**. The page shows how many commits the compare branch is ahead and behind, the commits, and the diff.
3. Under **Open a pull request**, fill in:
   - **Title** (required). With a single commit it defaults to that commit's subject; otherwise to the branch name.
   - **Intent**: what this change is meant to do. Optional, but recommended.
   - **Description** (Markdown). With a single commit it defaults to the rest of that commit's message.
   - **Create as draft** if the work isn't ready to merge.
4. Click **Create pull request**.

The form appears only when both sides are branches, the compare branch has commits the base doesn't, and you have write access. If a pull request for the pair is already open, the page says `A pull request for these branches already exists: #12` instead. When there is nothing to compare, it says `There isn't anything to compare.`

### With the CLI

Install the CLI and sign in through your browser:

```sh
curl -fsSL https://diffinery.com/install | bash
diffinery login
```

From a clone with your branch checked out:

```sh
git push -u origin fix-pricing-link
diffinery pr create \
  --title "Fix the Contact sales link" \
  --intent "Point the pricing page's Contact sales link at /contact; no other behaviour changes." \
  --body "Fixes #12" \
  --reviewer diffy
```

| Flag | Meaning |
| --- | --- |
| `-t, --title TEXT` | Title (required) |
| `-b, --body TEXT` | Description (Markdown) |
| `--body-file FILE` | Read the description from a file, or stdin with `-` |
| `-H, --head BRANCH` | Branch with your changes (default: the current branch) |
| `-B, --base BRANCH` | Branch to merge into (default: the repository's default branch) |
| `-d, --draft` | Open as a draft |
| `--intent TEXT` | What the change is for (agents should always set it) |
| `-r, --reviewer LOGIN` | Request a review (repeat for more) |
| `-R, --repo OWNER/NAME` | Repository (default: inferred from the git `origin` remote) |
| `--json` | Print the pull request as JSON |

### With the REST API

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/pulls \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{
    "title": "Fix the Contact sales link",
    "head": "fix-pricing-link",
    "base": "main",
    "body": "Fixes #12",
    "intent": "Point the pricing page'\''s Contact sales link at /contact; no other behaviour changes.",
    "draft": false,
    "reviewers": ["diffy"]
  }'
```

`base` defaults to the default branch. The response (`201 Created`) is GitHub's pull request object: `id` and `number` (both the pull request number), `title`, `body`, `state`, `locked`, `user`, `labels` (label objects), `assignees`, `requested_reviewers` (user objects), `head` and `base` (`ref`, `sha`, `label`, `repo`), `draft`, `merged`, `merged_at`, `merged_by`, `merge_commit_sha`, `html_url` and the usual `_links`, plus Diffinery's `intent`.

### Over MCP

The `create_pull_request` tool takes `owner`, `repo`, `title`, `head`, and optionally `body`, `base`, `draft`, `intent` and `reviewers`. An agent typically creates a branch and commits with `commit_files` first. See [MCP server](/docs/agents/mcp).

### Errors when opening

| Message | Cause |
| --- | --- |
| `head and base must be different branches` | Head and base are the same branch. |
| `head branch 'x' does not exist` | Push the branch first. |
| `base branch 'x' does not exist` | Check the base name. |
| `no commits between main and x` | The head has nothing the base doesn't already contain. |
| `a pull request already exists for x: #12` | Use the open pull request, or close it first. The response also includes `number`. |
| `title is required` | Give it a title. |
| `write access required` | Opening a pull request needs write access. |
| `GitHub Actions is not permitted to create pull requests. ...` (403) | A workflow's `GITHUB_TOKEN` tried to open a pull request in a repository that doesn't allow it. See [Pull requests and workflow tokens](#pull-requests-and-workflow-tokens). |

## Intent

The intent is a plain statement of what the change is supposed to achieve, separate from the description. It appears at the top of the conversation in a highlighted **Intent** box ("what this change is meant to do"), is included in notification emails, is returned as `intent` by the API and by `diffinery pr view`, and is included in the `get_pull_request` MCP result. Reviewers, human or AI, can check the diff against it rather than guessing the goal from the code.

Write it as one or two sentences about the outcome and its limits, for example: "Fix the race in token refresh without changing the public API." Agents should always set it. The intent is set when you open the pull request and can't be edited afterwards.

## Drafts

Open a pull request as a draft with **Create as draft**, `diffinery pr create --draft`, `"draft": true` in the API, or `draft: true` in `create_pull_request`. A draft:

- shows a **Draft** badge and appears in lists with a `draft` label,
- can be reviewed, and runs its `pull_request` workflows like any other pull request,
- can't be merged or added to a merge queue: it has the blocker `pull request is a draft`, and admins can't bypass it.

When the work is ready, mark the draft ready for review. You can also turn an open pull request back into a draft. Either change needs you to be the pull request's author or to have write access or higher, and the pull request must be open. Through the API, the token needs the `write` scope.

### Mark a draft ready for review

- **Web UI:** on the **Conversation** tab, the merge box of a draft says `This pull request is still a draft and can't be merged yet.` next to a **Ready for review** button. Click it; you see `Pull request marked ready for review.` The button is shown to the author and to people with write access, and not on archived repositories.
- **CLI:** `diffinery pr ready 12` prints `✓ Marked #12 ready for review`. With `--json` it prints the pull request instead.
- **REST API:** `PATCH /repos/{owner}/{repo}/pulls/{number}` with `{"draft": false}`. GitHub offers this only through GraphQL; on Diffinery `draft` is a field of the REST update.

```sh
curl -X PATCH https://diffinery.com/api/v3/repos/acme/website/pulls/12 \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"draft": false}'
```

The response is the pull request with `"draft": false`. There is no MCP tool for this yet: agents use the REST API or the CLI.

### Convert a pull request to a draft

- **CLI:** `diffinery pr ready 12 --undo` prints `✓ Converted #12 to a draft`.
- **REST API:** `PATCH /repos/{owner}/{repo}/pulls/{number}` with `{"draft": true}`.

The web UI has no button for this.

### What changing the draft state does

- The pull request's timeline gets a `ready_for_review` or `convert_to_draft` event (GitHub's timeline names), and webhooks get a `pull_request` event with the action `ready_for_review` or `converted_to_draft` (GitHub's webhook names). See [Webhook events](/docs/reference/webhook-events#pull_request).
- `pull_request` and `pull_request_target` workflows whose `types` include `ready_for_review` or `converted_to_draft` run. The default types don't include them. See [Events](/docs/actions/events#pull_request).
- Converting a pull request to a draft turns off [auto-merge](#auto-merge), with the comment `Auto-merge was turned off: the pull request was converted to a draft.` Marking it ready again doesn't turn auto-merge back on.
- Asking for the state the pull request already has changes nothing and sends no event.
- `PATCH` can change `draft` together with `title`, `body` and `state` in one request.

| Error | Cause |
| --- | --- |
| `only the author or someone with write access can change draft status` (403) | Ask the author or a maintainer. |
| `the pull request is not open` (422) | Reopen it first. |
| `not a pull request` (404) | The number belongs to an issue. |
| `this token needs the write scope` (403) | Use a token with the `write` or `admin` scope. |

## The pull request page

The page at `https://diffinery.com/acme/website/pull/12` has four tabs. It updates live as comments, reviews, pushes and checks arrive.

| Tab | Shows |
| --- | --- |
| **Conversation** | The description, the intent, comments, reviews with their line comments, the merge box, **Review changes**, the comment form, and a sidebar with **Reviewers**, **Labels**, **Milestone**, **Assignees**, **Notifications** and **Participants** |
| **Commits** | The commits on the head branch that aren't on the base (up to 250) |
| **Checks** | Check runs and commit statuses reported on the head commit, and the workflow runs for this pull request |
| **Files changed** | The diff from the merge base to the head (up to 300 files), where you can comment on lines |

The header says `wants to merge into main from fix-pricing-link` (or `merged into` once merged). Agent authors and reviewers are marked with an `agent` badge and `on behalf of` their owner.

Labels, assignees, milestones, comments, mentions, editing the title and description, and subscribing work exactly as on issues. See [Issues](/docs/collaboration/issues).

To put a pull request in a milestone, someone with triage access or higher uses **Set milestone** in the sidebar, or sends `{"milestone": 1}` (or `null`) with `PATCH /repos/{owner}/{repo}/issues/{number}` using the pull request's number. Pull request objects from the REST API carry the same `milestone` object as issues. Milestones themselves are created and edited with the REST API; see [Milestones](/docs/collaboration/issues#milestones).

## Reviews

A review is one of three kinds:

| Kind | Web UI label | API and MCP `event` | Effect |
| --- | --- | --- | --- |
| Approve | **Approve** | `APPROVE` | Counts toward required approvals (people only, not agents or workflow tokens) |
| Request changes | **Request changes** | `REQUEST_CHANGES` | Blocks merging until that reviewer approves |
| Comment | **Comment** | `COMMENT` | Feedback only; needs a body or line comments |

Rules:

- You can't approve or request changes on your own pull request; you can still leave a Comment review.
- Approving and requesting changes need write access. Anyone signed in who can read the repository can leave a Comment review.
- Only open pull requests can be reviewed.
- For each reviewer, their latest Approve or Request changes review is the one that counts. A later Comment review doesn't change it. To withdraw a change request, submit an Approve review, or ask a maintainer to [dismiss it](#dismiss-a-review).
- Approvals from agents and from a workflow's `GITHUB_TOKEN` are shown but never count toward required approvals. An agent's (or a workflow token's) Request changes review does block merging.
- A workflow's `GITHUB_TOKEN` can approve or request changes only when the repository allows it; see [Pull requests and workflow tokens](#pull-requests-and-workflow-tokens).
- If the base branch's rule has **Dismiss stale approvals when new commits are pushed**, pushing to the head marks earlier approvals as dismissed (shown as `reviewed (dismissed)`), and only approvals of the current head commit count.
- Submitting any review removes you from the pull request's requested reviewers.

Reviews are submitted immediately. There are no pending (draft) reviews.

### Review in the web UI

1. On the **Conversation** tab, expand **Review changes**.
2. Write a **Review summary** (Markdown).
3. Pick the **Review type**: **Comment**, **Approve** or **Request changes**. Approve and Request changes are disabled on your own pull request or without write access.
4. Click **Submit review**.

### Review with the CLI

```sh
diffinery pr review 12 --approve
diffinery pr review 12 --approve --body "Looks good."
diffinery pr review 12 --request-changes --body "Please add a test for the redirect."
diffinery pr review 12 --comment --body "Nit: the link text could be clearer."
```

Exactly one of `-a, --approve`, `-r, --request-changes` or `-c, --comment` is required. `--body` (or `--body-file`) is required for request changes and comment.

### Review with the REST API

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/pulls/12/reviews \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{
    "event": "REQUEST_CHANGES",
    "body": "Please add a test.",
    "comments": [{ "path": "src/pricing.html", "line": 42, "side": "RIGHT", "body": "This should be /contact." }]
  }'
```

`event` defaults to `COMMENT`. List reviews with `GET /repos/{owner}/{repo}/pulls/{number}/reviews`, or read one with `GET /repos/{owner}/{repo}/pulls/{number}/reviews/{review_id}`. Each has a numeric `id` (as on GitHub), `state` (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED`), `body`, `commit_id`, `submitted_at`, `user` and `html_url`.

### Review over MCP

`review_pull_request` takes `owner`, `repo`, `number`, `event`, and optionally `body` and `comments` (`[{ path, line, side?, body }]`).

### Dismiss a review

Dismissing a review takes it out of the merge decision: a dismissed approval stops counting toward required approvals, and a dismissed change request stops blocking. The review stays visible with the state `DISMISSED`, and the reviewer can review again. This is the same as GitHub's dismissal, with stricter rules about who may do it, because dismissing can unblock a merge:

- You need the maintain or admin role on the repository (a token with the `write` scope caps you at maintain, which is enough).
- You can't dismiss reviews on your own pull request.
- Agents can never dismiss reviews.
- Only `APPROVED` and `CHANGES_REQUESTED` reviews can be dismissed.

Dismiss through the REST API with a message saying why:

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/pulls/12/reviews/81/dismissals \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"message": "The requested test was added in 3f2a9c1."}'
```

`81` is the review's `id` from the reviews list. The response is the review with `"state": "DISMISSED"`, and the pull request's timeline gets a `review_dismissed` event with the message. There is no dismiss button in the web UI, CLI command or MCP tool yet.

| Error | Cause |
| --- | --- |
| `message is required` (422) | Send a non-empty `message`. |
| `maintain access is required to dismiss reviews` (403) | Your role, or your token's scope, is below maintain. |
| `agents can't dismiss reviews` (403) | Dismiss as a person. |
| `you can't dismiss reviews on your own pull request` (403) | Ask another maintainer. |
| `only approving or change-requesting reviews can be dismissed` (422) | The review is a Comment review or already dismissed. |
| `review not found` (404) | Check the review id and the pull request number. |

## Line comments

Line comments attach to a file and line of the diff.

- **Web UI:** on the **Files changed** tab, click a line, type in **Leave a comment on this line** and click **Add comment**. Each line comment is posted at once as a Comment review.
- **API and MCP:** include `comments` in a review: `path` (the file), `line` (the line number), `side` (`RIGHT` for the head version, the default, or `LEFT` for the base version) and `body`.

Line comments appear on the **Files changed** tab next to their line and in the conversation under their review. A comment made on an older head commit is marked `outdated`. List them with `GET /repos/{owner}/{repo}/pulls/{number}/comments` (fields include a numeric `id`, `pull_request_review_id`, `body`, `path`, `line`, `side`, `commit_id`, `in_reply_to_id`, `user`, `created_at`, `reactions` and Diffinery's `resolved`).

### Single line comments and replies with the REST API

You can also post one line comment, or reply to one, without writing a whole review. Each is stored as a one-comment Comment review, as on GitHub.

```sh
# A new line comment
curl -X POST https://diffinery.com/api/v3/repos/acme/website/pulls/12/comments \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"body": "This should be /contact.", "path": "src/pricing.html", "line": 42, "side": "RIGHT"}'

# A reply to line comment 57: it lands on the same file, line and side
curl -X POST https://diffinery.com/api/v3/repos/acme/website/pulls/12/comments/57/replies \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"body": "Done in the latest push."}'
```

`POST .../pulls/{number}/comments` with `in_reply_to` (the parent comment's id) and `body` is the same as the replies endpoint. `position` is accepted as another name for `line`. A new comment needs `path` and `line` (otherwise `path and line are required`), and every comment needs a `body` (`body is required`). The same rules as reviews apply: the pull request must be open, and a locked pull request accepts comments only from triage or higher.

Other line comment endpoints:

| Method and path | Purpose |
| --- | --- |
| `GET /repos/{owner}/{repo}/pulls/comments` | Line comments across all pull requests in the repository. Takes `since`, `sort` (`created` or `updated`), `direction` (`asc`, the default, or `desc`), `per_page` and `page`. |
| `GET /repos/{owner}/{repo}/pulls/comments/{id}` | One line comment |
| `PATCH /repos/{owner}/{repo}/pulls/comments/{id}` | Change its `body` (its author, or maintain or higher) |
| `DELETE /repos/{owner}/{repo}/pulls/comments/{id}` | Delete it (its author, or maintain or higher) |

Comment ids are numbers, as on GitHub.

## Requested reviewers

Ask specific people or agents to review:

- when opening: `reviewers` in the API and MCP, or `diffinery pr create --reviewer LOGIN`,
- later, through the API (the author, or triage or higher):

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/pulls/12/requested_reviewers \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"reviewers": ["diffy", "review-bot"]}'
```

Requested reviewers are notified and appear in the sidebar's **Reviewers** list as `pending` until they submit a review. Logins aren't checked. Requesting a review doesn't make it required; required approvals come from the branch protection rule. `team_reviewers` is refused with `team reviewers are not supported; request people by login`.

Read the current requests with `GET /repos/{owner}/{repo}/pulls/{number}/requested_reviewers` (`{"users": [...], "teams": []}`), and remove one (the author, or triage or higher):

```sh
curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/pulls/12/requested_reviewers \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"reviewers": ["review-bot"]}'
```

Requests and removals show in the pull request's events as `review_requested` and `review_request_removed`.

## Checks

Checks are reported on the pull request's head commit, as on GitHub. Each workflow job reports a check named `<workflow name> / <job name>` (for example `CI / test`). Other systems can report check runs or commit statuses (write access). Commit statuses show with the checks and count as checks for branch protection. See [Checks and statuses](/docs/collaboration/checks-and-statuses) for both APIs. A check run, for example:

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/check-runs \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"name": "lighthouse", "head_sha": "HEAD_SHA", "status": "completed", "conclusion": "success", "details_url": "https://ci.example.com/run/1", "output": {"title": "Score 98", "summary": "All budgets met."}}'
```

Posting again with the same `name` on the same commit (from the same account) updates the check. Read check runs with `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` and statuses with `GET /repos/{owner}/{repo}/commits/{ref}/status`. A check whose reporter gave a `details_url` (or a status `target_url`) links there from the pull request.

Where checks show up:

- The merge box lists every check with its state: `All checks have passed`, `N failing checks`, or `Some checks haven't completed yet`.
- The **Checks** tab shows each check and the pull request's workflow runs.
- `diffinery pr checks 12` prints them and exits `0` when all passed, `1` when any failed, and `8` when some are still pending, so scripts can wait on it. Like `gh pr checks --watch`, `diffinery pr checks 12 --watch` polls (every 10 seconds; `-i SECONDS` to change it) until no check is pending and then exits `0` or `1`. On a terminal it prints the checks each time they change; when piped, it prints them once at the end (`--json` prints the final list).
- `GET /repos/{owner}/{repo}/pulls/12` includes `checks` (name and state).

A check counts as passing when its conclusion is `success`, `skipped` or `neutral` (a status: when its state is `success`). Which checks must pass is set by **Required status checks** in branch protection, and not every report counts toward them: checks reported by agents never do, and a check that Diffinery Actions reports is decided by Actions alone. See [Branch protection](/docs/repositories/branch-protection#required-checks).

## Pull request workflows

Workflows that trigger on `pull_request` behave as on GitHub:

- They check out the **test merge commit**, `refs/pull/<n>/merge`: the head merged into the current base. `GITHUB_REF` is `refs/pull/<n>/merge` and `GITHUB_SHA` is the test merge commit. Their checks are reported on the head commit.
- The default activity types are `opened`, `synchronize` and `reopened`. Add `closed` to `types` to run when a pull request closes; `github.event.pull_request.merged` tells you whether it merged. Add `edited` to run when the title or description changes, and `ready_for_review` or `converted_to_draft` to run when the draft state changes.
- While the pull request conflicts with its base, there is no test merge commit and `pull_request` workflows don't run.
- `pull_request_target` workflows run the base branch's own workflow file on the base commit, with the repository's secrets, so a pull request can't change what runs. They run even while the pull request conflicts.

Example:

```yaml
name: CI
on:
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test
```

See [Events](/docs/actions/events) for every trigger and filter.

## Update a branch with its base

When the base branch has moved on, you can merge it into the pull request's head branch on the server, like GitHub's **Update branch**. This is available through the REST API (write access); the web UI, CLI and MCP have no button or command for it yet.

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/pulls/12/update-branch \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"expected_head_sha": "3f2a9c1e..."}'
```

`expected_head_sha` is optional: when given, the update only happens if the head is still at that commit. Diffinery creates a merge commit on the head branch with the parents (head, base), the message `Merge branch 'main' into fix-pricing-link`, and you as author and committer (`<login>@users.noreply.diffinery.com`). The response is `202` with `{"message": "Updating pull request branch.", "url": "..."}`, and the branch has already moved when it arrives.

The update is a push to the head branch: the head branch's protection rules and agent rules apply, the pull request gets a `synchronize` event, its `pull_request` workflows run again, and stale approvals are dismissed if the base's rule says so. A commit created by an agent carries the `diffinery-agent` header.

| Error | Cause |
| --- | --- |
| `There are no new commits on the base branch.` (422) | The head already contains the base. |
| `merge conflict between base and head` (422) | Resolve the conflict locally (see [Conflicts](#conflicts)). |
| `expected head sha didn't match current head ref.` (422) | Someone pushed to the head. Fetch it and try again. |
| `head branch moved; try again` (409) | The head moved while the merge was being made. |
| `pull request is closed` (422) | Only open pull requests can be updated. |
| `base branch main no longer exists` (422) | The base branch was deleted. |
| `write access is required to update the branch` (403) | You need write access. |

If the base requires linear history, don't use `update-branch`: it adds a merge commit to the head. Rebase locally instead.

## Conflicts

When the head and base change the same lines, the merge box says `This branch has conflicts that must be resolved`, lists the conflicting files, and shows the blocker `merge conflicts in N file(s)`. Diffinery has no web conflict editor, and `update-branch` refuses to merge a conflicting base. Resolve the conflict locally and push:

```sh
git fetch origin
git switch fix-pricing-link
git merge origin/main        # or: git rebase origin/main, then git push --force-with-lease
# fix the conflicts, then
git add -A && git commit
git push
```

The push updates the pull request, rebuilds its test merge commit, and runs its `pull_request` workflows again.

## Merge methods

| Method | Web UI label | Result |
| --- | --- | --- |
| `merge` | **Create a merge commit** | A merge commit with two parents (base, head). Subject `Merge pull request #12 from fix-pricing-link`, body the pull request title. Author and committer: the person merging. |
| `squash` | **Squash and merge** | One commit with a single parent (base). Subject `<title> (#12)`, body a `* <subject>` line per commit. Author: the pull request's author; committer: the person merging. |
| `rebase` | **Rebase and merge (fast-forward)** | No new commit: the base fast-forwards to the head. Only works when the head already contains the base; otherwise it fails with `rebase merge requires the branch to be up to date with its base (fast-forward only for now)`. |

Commits Diffinery writes use the email `<login>@users.noreply.diffinery.com`. Through the API (and `diffinery pr merge --subject/--body`) you can set the commit title and message for `merge` and `squash`.

Default method when you don't pick one:

| Where | Base branch without linear history | Base branch with **Require linear history** |
| --- | --- | --- |
| REST API (`merge_method` left out) | `merge` | `squash` |
| Web UI merge form | **Create a merge commit** | **Squash and merge**; **Create a merge commit** isn't offered |
| CLI (`diffinery pr merge` without `--merge`, `--squash` or `--rebase`) | `merge` | `merge`, which is refused: pass `--squash` or `--rebase` |
| MCP `merge_pull_request` (no `method`) | `merge` | `merge`, which is refused: pass `method` |

On a branch whose rule has **Require linear history**, a merge with the `merge` method is refused with `405` and `main requires linear history; use squash or rebase` (the merge queue refuses it with `422` and the same message), so choose `squash` or `rebase` there. Only an explicit [admin bypass](#admin-bypass) with `bypass_rules` can create a merge commit on such a branch, and that is recorded in the audit log.

In a [merge queue](/docs/collaboration/merge-queue), `rebase` replays each commit onto the queue instead of fast-forwarding.

## Merge a pull request

Merging needs write access and a pull request with no [merge blockers](#merge-blockers). If the base branch uses a merge queue, merging adds the pull request to the queue instead; see [Merge when ready and the merge queue](#merge-when-ready-and-the-merge-queue). If the pull request isn't ready yet, turn on [auto-merge](#auto-merge) and Diffinery merges it once it is.

### Merge in the web UI

1. On the **Conversation** tab, check the merge box: `This branch has no conflicts with the base branch` means it is ready; otherwise it lists the blockers.
2. Pick the **Merge method**: **Create a merge commit**, **Squash and merge** or **Rebase and merge (fast-forward)**. On a base branch that requires linear history, the form starts on **Squash and merge** and doesn't list **Create a merge commit**.
3. Leave **Delete fix-pricing-link after merge** ticked to delete the head branch, or untick it.
4. Click **Merge pull request**.

The timeline then shows `diffy merged commit abc1234 into main`.

### Merge with the CLI

```sh
diffinery pr merge 12 --squash --delete-branch
diffinery pr merge 12 --merge --subject "Merge the pricing fix" --body "Fixes #12"
diffinery pr merge 12 --rebase --match-head-commit 3f2a9c1e...
```

| Flag | Meaning |
| --- | --- |
| `-m, --merge` | Create a merge commit (default) |
| `-s, --squash` | Squash into one commit |
| `-r, --rebase` | Fast-forward the base to the head |
| `-d, --delete-branch` | Delete the head branch after merging (with `--auto`, once it lands). A merge never deletes the default branch or a protected branch. |
| `-t, --subject TEXT` | Commit title |
| `-b, --body TEXT`, `--body-file FILE` | Commit message body |
| `--match-head-commit SHA` | Only merge if the head is still at this commit |
| `--admin` | Merge now, bypassing unmet branch rules and any merge queue (repository admins; audited). Sends `bypass_rules` and `bypass_merge_queue`. See [Admin bypass](#admin-bypass). |
| `--auto` | Turn on auto-merge instead of merging now: Diffinery merges (or adds it to the merge queue) once every requirement is met. Sends `PUT /repos/{owner}/{repo}/pulls/{number}/auto-merge` with the method flag, `--delete-branch`, `--subject`, `--body` and `--match-head-commit` you pass. Can't be combined with `--admin`. |
| `--disable-auto` | Turn auto-merge off (`DELETE /repos/{owner}/{repo}/pulls/{number}/auto-merge`). If the pull request is already in the merge queue, it is also removed from it, so Diffinery no longer lands it by itself. |

Like `gh pr merge --auto`, `diffinery pr merge 12 --auto --squash` prints `✓ Auto-merge is on for #12 (squash): it merges once every requirement is met`, or `✓ Merged #12` / `✓ Added #12 to the merge queue` when the pull request was ready already. Without a method flag the server picks the merge queue's method, `squash` where linear history is required, and a merge commit otherwise. `diffinery pr merge 12 --disable-auto` prints `✓ Turned off auto-merge for #12`, followed by `and removed it from the merge queue` when it was queued.

### Merge with the REST API

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/pulls/12/merge \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"merge_method": "squash", "delete_branch": true, "sha": "HEAD_SHA"}'
```

| Field | Meaning |
| --- | --- |
| `merge_method` | `merge`, `squash` or `rebase` |
| `commit_title`, `commit_message` | Override the commit title and body (`merge` and `squash`) |
| `sha` | Only merge if the head is still at this commit; otherwise `409 head branch was modified; review and try again` |
| `delete_branch` | Delete the head branch after merging (default `false`) |
| `bypass_rules` | Admins only: merge even though the pull request has unmet branch rules, or create a merge commit on a branch that requires linear history. It doesn't skip a merge queue. See [Admin bypass](#admin-bypass). |
| `bypass_merge_queue` | Admins only: merge directly on a branch that uses a merge queue. It skips only the queue: a pull request with unmet branch rules also needs `bypass_rules`. |

The response is `{"merged": true, "sha": "...", "method": "squash", "message": "Pull Request successfully merged"}`.

### Check mergeability

`GET /repos/{owner}/{repo}/pulls/{number}` reports, like GitHub:

| Field | Meaning |
| --- | --- |
| `mergeable` | `true` when the head merges into the base without conflicts, `false` when it conflicts, `null` once the pull request is closed. It doesn't consider approvals or checks. |
| `mergeable_state` | `clean` (no blockers), `blocked` (blockers other than conflicts), `dirty` (conflicts), `draft`, or `unknown` (merged, closed, or the base branch is gone) |
| `rebaseable` | `true` when the head has no conflicts and already contains the latest base commit, so a `rebase` (fast-forward) merge works. `null` once closed. |

Diffinery adds `merge_blockers` (the reasons it can't merge yet), `approvals`, `required_approvals`, `checks` (name and state of every check run and status on the head) and `merge_queue`.

`GET /repos/{owner}/{repo}/pulls/{number}/merge` depends on the client. With a GitHub media type (`Accept: application/vnd.github+json`, as Octokit and `gh` send), it answers like GitHub: `204` if the pull request is merged and `404` if not. Other clients get Diffinery's mergeability report: `mergeable`, `state` (`clean`, `blocked`, `conflicting`, `draft`, `merged`, `closed` or `unknown`), `conflicts`, `approvals`, `requiredApprovals`, `changesRequested`, `checks`, `blockers`, `mergeBase` and `mergeQueue`.

### Merge over MCP

`merge_pull_request` takes `owner`, `repo`, `number`, and optionally `method`, `expected_head_sha` and `delete_branch`. On a branch with a merge queue it queues the pull request instead. Agents can't merge into the default branch or a protected branch themselves; they use `enable_auto_merge` there (see [Auto-merge](#auto-merge)).

### After the merge

- The pull request is closed with the reason `merged`, and `merged_by` and `merge_commit_sha` are set.
- The base branch moves as if pushed to: `push` workflows run and webhooks fire.
- `pull_request` workflows whose `types` include `closed` run, with `github.event.pull_request.merged` set to `true`.
- Open issues referenced with a closing keyword (`Fixes #12`, `closes #3`, `resolves #7`) close. See [Issues](/docs/collaboration/issues#close-issues-from-a-pull-request).
- If you asked for it, the head branch is deleted, unless it is the default branch or has moved since the merge.

### Admin bypass

A repository admin can merge a pull request whose branch rules aren't met, but only by asking for it explicitly. Without the request, an admin's merge is refused like anyone else's. A bypass is possible when all of these hold:

- you have the admin role on the repository (through a token, that needs the `admin` scope: a `write` token caps you at maintain);
- you are a person: agents can never bypass;
- the base branch's rule doesn't have **Do not allow administrators to bypass these rules**;
- the pull request has no merge conflicts and isn't a draft.

Each bypass flag covers only what it names:

| Flag | Skips | Doesn't skip |
| --- | --- | --- |
| `bypass_rules` | Missing approvals, change requests, required checks that failed or haven't run, a branch that is behind its base under linear history, and the refusal of merge commits under linear history | A merge queue |
| `bypass_merge_queue` | The merge queue: the pull request merges directly | Any unmet branch rule (approvals, checks, linear history) |

To merge past both a merge queue and unmet rules, send both flags. Conflicts, a draft state and the agent rules are never bypassed.

How to ask for it:

- **Web UI:** when you are an admin and the pull request has blockers but no conflicts and isn't a draft, the button reads **Merge without waiting for requirements (bypass)** and asks `Merge without meeting the branch requirements?` before merging. It sends `bypass_rules`. The button isn't shown when the base branch's rule has **Do not allow administrators to bypass these rules**. On a branch with a merge queue, the merge box instead offers **Merge now (bypass the queue)**, which sends only `bypass_merge_queue`; see [Merge queue](/docs/collaboration/merge-queue#bypass-the-queue).
- **CLI:** `diffinery pr merge 12 --squash --admin`. The CLI sends both `bypass_rules` and `bypass_merge_queue`.
- **REST API:** add `"bypass_rules": true` to `PUT /repos/{owner}/{repo}/pulls/{number}/merge`:

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/pulls/12/merge \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"merge_method": "squash", "bypass_rules": true}'
```

When you could bypass but didn't ask, the `405` message ends with `(as an admin you can bypass with bypass_rules)`, for example `pull request is not mergeable: needs 1 more approving review(s) (as an admin you can bypass with bypass_rules)`. MCP's `merge_pull_request` has no bypass option.

A merge that bypassed anything is recorded in the [audit log](/docs/security/audit-log#git-and-pull-requests) as `pull_request.merge_bypassed`, with the pull request as the target and the `base` branch and the bypassed `blockers` in the detail, in addition to the usual `pull.merge` entry. `blockers` lists the unmet rules skipped with `bypass_rules`, `linear history required` when a merge commit was created on a linear-history branch, and `merge queue` when the queue was skipped with `bypass_merge_queue`.

## Merge blockers

A pull request can be merged when it has no blockers. The merge box, `diffinery pr view`, `merge_blockers` in the API and `mergeability.blockers` in MCP list them with these exact messages:

| Blocker | Meaning and fix |
| --- | --- |
| `already merged` | The pull request is merged. |
| `pull request is closed` | Reopen it first. |
| `base branch main no longer exists` | The base branch was deleted. Recreate it, or open a new pull request against another base. |
| `pull request is a draft` | Drafts can't be merged. See [Drafts](#drafts). |
| `merge conflicts in N file(s)` | Resolve the conflicts and push. See [Conflicts](#conflicts). |
| `needs N more approving review(s)` | Get more approvals from people with write access. Agent approvals don't count. |
| `changes requested by diffy` | That reviewer must approve before merging. |
| `required check 'CI / test' has not run` | No counted check run or status with that exact name was reported on the head commit. Check the workflow's trigger and the check name. Reports from agents don't count, and neither do reports from accounts other than the one bound in the rule's `requiredCheckSources`. |
| `required check 'CI / test' is queued` (or `is in_progress`) | Wait for it to finish. A `pending` commit status shows as `is in_progress`. |
| `required check 'CI / test' failure` (or another conclusion such as `cancelled`, `timed_out` or `action_required`) | The check didn't pass. Fix the code or re-run the workflow. |
| `branch is behind its base; update it (linear history required)` | The base requires linear history and the head doesn't contain the latest base. Rebase onto the base and push. |
| `write access is required to merge` | You need write access. |
| `agents may not merge into this branch; a human must merge` | An agent tried to merge into the default branch or a branch with a protection rule that lacks **Allow agents to merge pull requests**. This also applies to a workflow's `GITHUB_TOKEN` in a run whose code came from an agent. Where the rule allows it, the agent can [turn on auto-merge](#auto-merge-for-agents-and-workflow-tokens) instead. |
| ``refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission`` | A workflow's `GITHUB_TOKEN` tried to merge a pull request that adds, changes or deletes a workflow file. A person must merge it. |

Required approvals come from the branch protection rule's **Required approvals** (0 to 10). Pull requests opened by agents need at least one even without a rule.

When the base branch uses a merge queue, merging directly fails with `main requires a merge queue: add the pull request to the queue` (`405`), with `blockers: ["main merges through a merge queue"]`. For an admin who could bypass, the message adds `(or, as an admin, bypass the queue with bypass_merge_queue)`.

Merge blockers apply to admins too, unless they ask for an [admin bypass](#admin-bypass).

When Diffinery lands a pull request for an agent or a workflow token, through [auto-merge](#auto-merge) or the merge queue, the agent blocker is replaced by the rules in [Auto-merge for agents and workflow tokens](#auto-merge-for-agents-and-workflow-tokens), and these blockers can appear: `needs N more approving review(s) of its latest commit`, ``the pull request changes workflow file `<path>`; a person must merge it``, and the refusals `agents may not have pull requests merged into main automatically ...` and `main has no required status checks: ...`.

## Auto-merge

Auto-merge lets you approve the outcome now and have Diffinery do the merge later: you turn it on for a pull request that isn't ready yet (required checks still running, an approval still missing, the branch behind its base), and Diffinery merges it by itself as soon as every rule of its base branch is met. It works like GitHub's auto-merge, and it is also how agents land changes on protected branches without ever merging there themselves.

To have it on for every pull request without turning it on each time, see [Merge on green automatically](/docs/collaboration/merge-on-green): a repository's **Settings → Merge on green** picks the checks to wait for, and **Settings → Pull requests** (or an agent's **Merge its pull requests on green**) turns auto-merge on as each pull request opens. `diffinery pr create --auto` and `"auto_merge": true` on `POST /repos/{owner}/{repo}/pulls` turn it on for one pull request.

### How auto-merge works

- **It checks right away.** When you turn it on, Diffinery looks at the pull request at once. If nothing blocks it, it merges immediately (the API answers `"state": "merged"`). Otherwise auto-merge stays on and waits.
- **It looks again when something changes.** Diffinery checks the pull request again when a check run completes or a commit status other than `pending` is reported on its head commit, when a review is submitted or dismissed, when its head branch or its base branch is pushed to, and when a branch protection rule is saved or deleted.
- **It merges only when nothing blocks.** The pull request must have no [merge blockers](#merge-blockers): every required check passed on the head commit, enough approvals from people, no changes requested, no conflicts, and an up-to-date branch where the base requires linear history. Auto-merge never bypasses anything, even when an admin turned it on. Checks that aren't required aren't waited for, so on a branch without required checks a pull request with enough approvals merges at once, even while CI is still running.
- **Into a merge queue, it queues.** When the base branch has **Require a merge queue**, auto-merge adds the pull request to the [merge queue](/docs/collaboration/merge-queue) once it is ready, with the auto-merge method, and then turns itself off: the queue takes over and merges it when its merge group passes. The API answers `"state": "queued"` when that happens right away.
- **It merges as the one who turned it on.** The merge is made by the person, agent or workflow token that turned auto-merge on, with their access at the time of the merge, and never with more than they had when they turned it on. They appear as `merged_by`, and the commit is written as if they had merged by hand (see [Merge methods](#merge-methods)). A merge or squash commit made for an agent carries the `diffinery-agent` header.
- **It keeps the head branch.** Auto-merge doesn't delete the head branch after merging. Delete it yourself afterwards.
- **Turning it on again changes it.** Calling it again while auto-merge is on replaces the merge method and commit text.

Closing the pull request, or merging it some other way, ends auto-merge quietly. Reopening a closed pull request doesn't turn it back on.

### Who can turn on auto-merge

- You need write access to the repository, and through the API a token with the `write` (or `admin`) scope. On an archived repository it is refused with `repository is archived (read-only)`.
- The pull request must be open, not a draft, not merged and not already in the merge queue.
- **People** can turn it on for any base branch.
- **Agents and workflow tokens** (`GITHUB_TOKEN`) can turn it on for a base branch that is neither the default branch nor protected by a rule. On the default branch or a protected branch, the branch's rule must have **Allow agents to land pull requests through auto-merge** (`allowAgentAutoMerge`) and at least one required status check; an agent may also use it where the rule has **Allow agents to merge pull requests** (`agentsMayMerge`). See [Auto-merge for agents and workflow tokens](#auto-merge-for-agents-and-workflow-tokens).
- A workflow's `GITHUB_TOKEN` needs `contents: write` in the job's `permissions:`, as for merging.

Anyone with write access can turn it off, whoever turned it on.

### Auto-merge method

Auto-merge uses one of the three [merge methods](#merge-methods). When you don't pick one:

| Base branch | Default auto-merge method |
| --- | --- |
| Uses a merge queue | The queue's method |
| Requires linear history (no merge queue) | `squash` |
| Anything else | `merge` |

On a branch that requires linear history, `merge` is refused with `main requires linear history; use squash or rebase` (`422`). Outside a merge queue, `rebase` is a fast-forward: it only works once the head already contains the latest base commit, so prefer `squash` unless you keep the branch rebased yourself. Through the API and MCP you can also set the commit title and message for `merge` and `squash`; the web form doesn't offer them.

### Turn on auto-merge in the web UI

1. Open the pull request's **Conversation** tab. The merge box offers auto-merge when you have write access, the pull request can't merge yet, has no conflicts and isn't a draft, and auto-merge isn't already on.
2. Under the merge button, next to `Merge by itself once every requirement is met.` (on a branch with a merge queue, `Join the merge queue by itself once every requirement is met.`), pick the **Auto-merge method**: **Create a merge commit**, **Squash and merge** or **Rebase and merge**. **Create a merge commit** isn't listed on a branch that requires linear history, and on a merge queue branch the queue's method is preselected.
3. Click **Enable auto-merge**.

You see `Auto-merge is on: it merges once every requirement is met.`, or `Pull request merged.` or `Added to the merge queue.` when the pull request turned out to be ready. While it waits, the merge box shows **Auto-merge is on**, who turned it on, and what it will do, for example `Auto-merge is on · turned on by diffy · squash and merge once every requirement is met` (or `joins the merge queue (squash and merge) once every requirement is met`). To turn it off, click **Disable auto-merge** in that row; you see `Auto-merge is off.`

The button isn't offered while the pull request can already merge: merge it directly instead.

### Turn on auto-merge with the REST API

GitHub offers auto-merge only through GraphQL (`enablePullRequestAutoMerge` and `disablePullRequestAutoMerge`); Diffinery has REST endpoints for it:

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/pulls/12/auto-merge \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"merge_method": "squash", "commit_title": "Fix the Contact sales link (#12)"}'
```

| Field | Meaning |
| --- | --- |
| `merge_method` | `merge`, `squash` or `rebase`. Default: see [Auto-merge method](#auto-merge-method). |
| `commit_title`, `commit_message` | Title and body of the merge or squash commit. Default: the same as a merge by hand. |

All fields are optional; an empty body works. The response (`200`) says what happened:

```json
{
  "state": "enabled",
  "auto_merge": {
    "enabled_by": { "login": "diffy", "type": "User" },
    "merge_method": "squash",
    "commit_title": "Fix the Contact sales link (#12)",
    "commit_message": null
  },
  "merge_commit_sha": null
}
```

| `state` | Meaning |
| --- | --- |
| `enabled` | Auto-merge is on and waiting. `auto_merge` shows its settings (`enabled_by` is a full user object). |
| `merged` | The pull request was ready and merged right away. `auto_merge` is `null` and `merge_commit_sha` is the new commit. |
| `queued` | The base branch uses a merge queue and the pull request was ready, so it joined the queue. `auto_merge` is `null`. |

While auto-merge is on, the pull request object (`GET /repos/{owner}/{repo}/pulls/{number}` and the list) carries the same `auto_merge` object, as on GitHub; otherwise `auto_merge` is `null`.

Turn it off with:

```sh
curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/pulls/12/auto-merge \
  -H "Authorization: Bearer dfy_..."
```

It returns `204`, also when auto-merge was already off. Both endpoints need write access and a `write` token.

### Turn on auto-merge with the CLI

`diffinery pr merge --auto` turns auto-merge on, with the same flags as a merge, and `--disable-auto` turns it off:

```sh
diffinery pr merge 12 --auto --squash --delete-branch
diffinery pr merge 12 --disable-auto
```

`diffinery pr view 12` lists the merge blockers auto-merge is waiting on.

### Turn on auto-merge over MCP

`enable_auto_merge` takes `owner`, `repo`, `number`, and optionally `merge_method`, `commit_title`, `commit_message`, `delete_branch` and `expected_head_sha`. It returns `state` (`enabled`, `queued` or `merged`), `autoMerge` (`method`, `commitTitle`, `commitMessage`, `enabledBy` and `enabledAt`, or `null`) and, once merged, `mergeCommit`. `disable_auto_merge` takes `owner`, `repo` and `number` and returns `{"auto_merge": null}`. `get_pull_request` shows the current setting as `issue.pull.autoMerge`. Both tools need a `write` token. See [MCP server](/docs/agents/mcp).

### When auto-merge turns itself off

Auto-merge turns itself off when the pull request can never go through as set up, and posts a comment on the pull request saying why, as `diffinery-auto-merge[bot]`: `Auto-merge was turned off: <reason>.` The comment notifies the pull request's participants like any other comment.

| Reason in the comment | What happened and what to do |
| --- | --- |
| `diffy pushed new commits to the branch` | Someone other than the one who turned auto-merge on pushed to the head branch, as on GitHub. Review the new commits and turn it on again. Pushes by the same person or agent keep it on. |
| `the pull request was converted to a draft` | Mark it ready for review and turn auto-merge on again. |
| `diffy no longer has write access` | The account that turned it on lost write access to the repository. Someone with write access turns it on again. |
| `agents may not have pull requests merged into main automatically unless its branch protection allows it ...` or `main has no required status checks: allowAgentAutoMerge needs at least one ...` | An agent's or workflow token's auto-merge, and the branch rule no longer allows it. See [Auto-merge for agents and workflow tokens](#auto-merge-for-agents-and-workflow-tokens). |
| `main requires linear history, and auto-merge was set to create a merge commit` | The rule started requiring linear history. Turn auto-merge on again with `squash` or `rebase`. |
| `rebase merge requires the branch to be up to date with its base (fast-forward only for now)` | A `rebase` auto-merge found the head behind the base. Rebase the branch and push, or use `squash`. |
| Another merge error, or `the merge failed` | The merge was attempted and refused for a reason that won't fix itself. Read the message, fix the cause, and turn auto-merge on again. |

When the head or base branch moves in the middle of the merge, auto-merge stays on and tries again on the next change. Whoever's action caused the turn-off (the pusher, or the person who converted the pull request to a draft) is recorded as turning it off; otherwise it is `diffinery-auto-merge[bot]`.

### Auto-merge for agents and workflow tokens

Agents never merge into the default branch or a protected branch themselves (`agents may not merge into this branch; a human must merge`). Auto-merge is how they land work there anyway, with CI and people still in control: the agent turns on auto-merge, and Diffinery merges once the branch's rules are met. A repository admin decides per branch rule whether this is allowed; see [Agents landing changes](/docs/repositories/branch-protection#agents-landing-changes) for the full rules. In short:

- The rule needs **Allow agents to land pull requests through auto-merge** (`allowAgentAutoMerge`) and at least one required status check. The same applies to agents adding a pull request to a merge queue on such a branch.
- Approvals are required as for any merge (the rule's **Required approvals**, and at least one from a person for a pull request an agent opened), but an approval counts only for the commit it approved: if the agent pushes again, a person approves again. The blocker then reads `needs 1 more approving review(s) of its latest commit`. An admin can waive the approval on green required checks with **Let agents' auto-merges land without an approving review** (`agentAutoMergeWithoutApproval`); see [Waiving approvals for agents](/docs/repositories/branch-protection#waiving-approvals-for-agents). Requested changes always block.
- A pull request that adds, changes or deletes a workflow file can't land this way; a person must merge it.
- A workflow's `GITHUB_TOKEN` is held to the same rule, even when the run's code didn't come from an agent.
- On branches that are neither the default branch nor protected, agents and workflow tokens can use auto-merge without any rule.
- An admin can also name agents in **Auto-merge pull requests from these agents** (`autoMergeAgents`) on the rule. Diffinery then turns auto-merge on by itself, as the agent, for each pull request those agents open, mark ready or push to, so neither the agent nor a person has to. Every point above still applies. See [Auto-merging agents' pull requests](/docs/repositories/branch-protection#auto-merging-agents-pull-requests).

A typical agent flow over MCP:

1. `commit_files` with `create_branch_from` to put the change on a new branch.
2. `create_pull_request` with an `intent`.
3. `enable_auto_merge` with `merge_method: "squash"` (not needed where the rule names the agent in `autoMergeAgents`: `get_pull_request` then already shows `issue.pull.autoMerge` with `byRule`). If the answer is `isError: true` with `agents may not have pull requests merged into main automatically ...`, the branch doesn't allow it: ask a person to merge, or an admin to set `allowAgentAutoMerge`.
4. Follow CI with `list_workflow_runs`, and fix failures with more commits. The agent's own pushes keep auto-merge on.
5. `get_pull_request` shows `issue.pull.autoMerge` while it waits, and `issue.pull.merged` once Diffinery merged it.

Over the REST API the same flow uses `PUT /repos/{owner}/{repo}/pulls/{number}/auto-merge` with the agent's token.

### Auto-merge events and audit log

- **Timeline:** turning auto-merge on or off adds an `auto_merge_enabled` or `auto_merge_disabled` event to the pull request (GitHub's names), returned by `GET /repos/{owner}/{repo}/issues/{number}/events` and the timeline. When a branch rule's `autoMergeAgents` turned it on, the event's actor is `diffinery-auto-merge[bot]`.
- **Webhooks:** a `pull_request` webhook with the action `auto_merge_enabled` or `auto_merge_disabled` is sent. The sender is who turned it on or off; when auto-merge turned itself off, it is the pusher, the person who converted the pull request to a draft, or `diffinery-auto-merge[bot]`. See [Webhook events](/docs/reference/webhook-events#pull_request).
- **Workflows and email:** these actions don't start `pull_request` workflows and send no notification emails. The merge itself does everything a merge by hand does (see [After the merge](#after-the-merge)).
- **Audit log:** each step is recorded with the pull request (`acme/website#12`) as the target:

| Action | When | Detail |
| --- | --- | --- |
| `pull_request.auto_merge_enabled` | Auto-merge is turned on (or changed) | `base`, `method`, `viaAgentRule` (`true` when it relies on `allowAgentAutoMerge`); with `byRule` (the branch rule's pattern) and `agent` when a rule's `autoMergeAgents` turned it on, by `diffinery-auto-merge[bot]` |
| `pull_request.auto_merge_disabled` | Auto-merge is turned off, by someone or by itself | `enabledBy`, and `reason` when it turned itself off |
| `pull_request.auto_merged` | Auto-merge merged the pull request; a `pull.merge` entry is written too | `base`, `method`, `sha` |
| `pull_request.auto_merge_enqueued` | Auto-merge added the pull request to the merge queue | `base`, `state` |

See [Audit log](/docs/security/audit-log#git-and-pull-requests).

### Auto-merge errors

| Message | Cause and fix |
| --- | --- |
| `pull request is a draft; mark it ready for review first` (422) | Mark it ready, then turn on auto-merge. |
| `pull request is closed` (422) or `pull request is already merged` (422) | Only open pull requests can auto-merge. |
| `not a pull request` (404) | The number belongs to an issue. |
| `pull request is already in the merge queue` (422) | It is queued already; the queue merges it. |
| `merge_method must be merge, squash or rebase` (422) | Fix `merge_method`. |
| `main requires linear history; use squash or rebase` (422) | Pick `squash` or `rebase`. |
| `write access required` (403) | You need write access to the repository. |
| `this token needs the write scope` (403) | Use a `write` or `admin` token. |
| `agents may not have pull requests merged into main automatically unless its branch protection allows it (allowAgentAutoMerge, set by a repository admin); a person must merge` (403) | The base branch's rule doesn't allow agents (or workflow tokens) to land changes. A person merges, or an admin turns on `allowAgentAutoMerge`. For a workflow token the message says `workflow tokens` instead of `agents`. |
| `main has no required status checks: allowAgentAutoMerge needs at least one, so that CI gates what agents land` (422) | Add a required status check to the rule. |
| ``the pull request changes workflow file `.github/workflows/ci.yml`; CI can't gate a change to itself, so a person must merge it`` (422) | An agent or workflow token relies on `allowAgentAutoMerge` for a pull request that changes a workflow. A person must merge it. |
| `Resource not accessible by integration (...)` (403) | A workflow's `GITHUB_TOKEN` lacks `contents: write`. |
| Auto-merge is on but nothing happens | A blocker remains. Check the merge box, `diffinery pr view 12` or `merge_blockers` in the API: usually a required check that hasn't run (check the check name), a missing approval, or a change request. |
| Auto-merge merged before CI finished | Only required checks are waited for. Add the checks to **Required status checks** in the branch's rule. |

## Pull requests opened by agents

When the author is an [agent](/docs/agents/overview):

- the pull request needs at least one approval from a person, even on a branch without protection rules, and approvals from agents never count;
- the agent's owner can approve it, because the owner is a different account from the agent;
- agents can't merge into the default branch or any protected branch unless its rule has **Allow agents to merge pull requests**, and even then the human approval is still required;
- where the rule has **Allow agents to land pull requests through auto-merge** and a required check, the agent can turn on [auto-merge](#auto-merge-for-agents-and-workflow-tokens) and Diffinery merges once the rules are met; an admin can also waive the human approval for those landings with **Let agents' auto-merges land without an approving review**;
- the author is shown with an `agent` badge and `on behalf of` its owner, and the API returns `"type": "Bot"` for it.

## Pull requests and workflow tokens

A workflow job's `GITHUB_TOKEN` can work with pull requests, within its `permissions:` and these limits, as on GitHub:

- **Permissions.** Opening, reviewing and editing pull requests (the `/pulls` endpoints) need `pull-requests: write`; conversation comments, labels and assignees (the `/issues/{number}/...` endpoints) accept `issues: write` or `pull-requests: write`. Merging needs `contents: write`. A request outside the token's permissions gets `403` with `Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: pull-requests: write)`.
- **Opening and approving is off by default.** A job token can't open a pull request, approve one or request changes unless a repository admin allows it. Otherwise the request fails with `403` and `GitHub Actions is not permitted to create pull requests.` (or `... to approve pull requests.`), followed by `An admin can allow it in the repository's Actions settings ("Allow GitHub Actions to create and approve pull requests").` Comment reviews are always allowed.
- **Its approvals never count.** Even where approving is allowed, an approval from a job token doesn't count toward required approvals: only people's approvals do. Its Request changes review still blocks merging.
- **No admin bypass.** A job token acts with at most the write role, so branch protection always applies to its merges.
- **No workflow file changes.** A job token can't merge a pull request that adds, changes or deletes files under `.github/workflows/` or `.diffinery/workflows/` (see [Merge blockers](#merge-blockers)).
- **Auto-merge.** A job token can turn on [auto-merge](#auto-merge) with `contents: write`. On the default branch or a protected branch it is held to the agent rule (**Allow agents to land pull requests through auto-merge** and a required check), even when the run's code didn't come from an agent. The later merge keeps the token's permissions from when it was turned on.
- **Code from agents.** In a run whose code came from an agent (an agent opened the pull request or pushed its branch last, or started the run, and re-runs of such a run and `workflow_run` runs that follow it), the job token acts as an agent: it can't merge into the default branch or a protected branch unless the rule has **Allow agents to merge pull requests**.
- **No new runs.** Pull requests a job token opens, pushes or merges don't start `pull_request` workflows, so workflows can't trigger each other in a loop.

An admin allows workflows to open and approve pull requests on the repository's **Settings → Actions** tab (check **Allow GitHub Actions to create and approve pull requests** and click **Save**), or with the REST API:

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/actions/permissions/workflow \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"can_approve_pull_request_reviews": true}'
```

`GET` on the same path returns `default_workflow_permissions` (`read` or `write`) and `can_approve_pull_request_reviews` (`false` by default). Changing it needs a person with the admin role (a token with the `admin` scope), and each change is recorded in the audit log as `repo.actions_workflow_settings`. See [Workflow syntax](/docs/actions/workflow-syntax) for `permissions:`.

## Merge when ready and the merge queue

If the base branch's protection rule has **Require a merge queue**, the merge box shows **Merge when ready** instead of **Merge pull request**. Clicking it (or `diffinery pr merge 12`, `PUT /repos/{owner}/{repo}/pulls/{number}/merge-queue`, or the `merge_pull_request` MCP tool) adds the pull request to the queue. Diffinery tests it together with the pull requests ahead of it on a merge group branch and merges it once the required checks pass there. The merge box then shows `Queued to merge`, its position, and a **Remove from queue** button.

The pull request must already have no blockers to join the queue. Pushing to its branch removes it from the queue. To have it join the queue by itself once it has none, turn on [auto-merge](#auto-merge). See [Merge queue](/docs/collaboration/merge-queue) for the full behaviour.

## Lock the conversation

Locking a pull request limits comments, reviews, line comments and reactions to people with triage access or higher. Lock and unlock with the issue endpoints (a pull request is an issue):

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/issues/12/lock \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"lock_reason": "resolved"}'
curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/issues/12/lock -H "Authorization: Bearer dfy_..."
```

Both need triage access and return `204`. `lock_reason` is optional and one of `off-topic`, `too heated`, `resolved` or `spam`. The pull request then reports `"locked": true` and `active_lock_reason`. Others get `403` with `conversation is locked`. Merging is not affected. The web UI doesn't show a lock control or badge yet. See [Issues](/docs/collaboration/issues#lock-a-conversation).

## Reactions

Add emoji reactions to a pull request, a conversation comment or a line comment through the REST API, the same way as on issues: `POST /repos/{owner}/{repo}/issues/{number}/reactions`, `POST /repos/{owner}/{repo}/issues/comments/{id}/reactions` or `POST /repos/{owner}/{repo}/pulls/comments/{id}/reactions` with `{"content": "+1"}`. See [Issues](/docs/collaboration/issues#reactions) for the allowed values and rules.

## Events and timeline

Changes to a pull request are recorded as events: `labeled`, `unlabeled`, `assigned`, `unassigned`, `renamed`, `closed`, `reopened`, `locked`, `unlocked`, `review_requested`, `review_request_removed`, `review_dismissed`, `ready_for_review`, `convert_to_draft`, `auto_merge_enabled`, `auto_merge_disabled` and `merged`, with GitHub's names. (The `pull_request` webhook action for converting to a draft is `converted_to_draft`, as on GitHub.) Read them with `GET /repos/{owner}/{repo}/issues/{number}/events`, or read events, comments and reviews in time order with `GET /repos/{owner}/{repo}/issues/{number}/timeline`. See [Issues](/docs/collaboration/issues#events-and-timeline).

## Close and reopen

- **Web UI:** **Close pull request** at the bottom of the conversation (posting any comment you typed), and **Reopen** on a closed one.
- **REST API:** `PATCH /repos/{owner}/{repo}/pulls/{number}` with `{"state": "closed"}` or `{"state": "open"}`. The same endpoint changes `title`, `body` and [`draft`](#drafts).
- **MCP:** `update_issue` with `state`.

Changing the title or description (in the web UI, with `PATCH`, or with `update_issue`) sends a `pull_request` webhook event with the action `edited` and runs `pull_request` workflows whose `types` include `edited`. Saving the same text again sends nothing.

Closing runs `pull_request` workflows whose `types` include `closed`, and removes the pull request from a merge queue. Reopening runs `pull_request` workflows with the `reopened` type. A merged pull request can't be reopened: `a merged pull request cannot be reopened`. Only the author or someone with triage or higher can close or reopen.

## Pull request refs

Like GitHub, every pull request has two read-only refs:

| Ref | Points at |
| --- | --- |
| `refs/pull/<n>/head` | The pull request's head commit |
| `refs/pull/<n>/merge` | The test merge commit: parents `[base, head]`, authored by `Diffinery <noreply@diffinery.com>`. Removed while the pull request conflicts. |

They are refreshed when the pull request is opened, pushed to, reopened or closed. Fetch them with git:

```sh
git fetch origin refs/pull/12/head:pr-12
git fetch origin +refs/pull/12/merge:refs/remotes/origin/pr/12/merge
```

They can't be pushed: `refs/pull/ is managed by Diffinery for pull requests`. They are also hidden from pushes, so `git push --mirror` leaves them alone.

## Find pull requests

The **Pull requests** tab lists pull requests with the same filters as the issue list: open or closed, search, label and author. See [Issues](/docs/collaboration/issues#find-issues).

```sh
diffinery pr list --state merged --author diffy --limit 20
diffinery pr list --head fix-pricing-link
diffinery pr view 12 --comments
diffinery pr diff 12 --name-only
```

`pr list --state` accepts `open` (default), `closed`, `merged` or `all`, and `pr list --head BRANCH` lists only pull requests from that branch.

As with `gh`, the pull request number is optional for `pr view`, `pr checks`, `pr diff`, `pr comment`, `pr review`, `pr ready` and `pr merge`: without it, the CLI uses the open pull request whose head is your current git branch, in the repository of your `origin` remote (or `-R OWNER/NAME`). With no current branch (a detached HEAD) or no open pull request for it, the command fails and asks for a number. The `list_pull_requests` and `get_pull_request` MCP tools do the same (`get_pull_request` with `include_diff: true` adds the diff).

The REST API is `GET /repos/{owner}/{repo}/pulls`. Closed results include merged ones. Results come back as a page, with a `Link` header for the next pages and `x-total-count` with the total.

| Parameter | Meaning |
| --- | --- |
| `state` | `open` (default), `closed` or `all` |
| `head` | Head branch, as `branch` or `owner:branch` (the owner part is ignored) |
| `base` | Base branch |
| `sort` | `created` (default), `updated`, or `popularity` (by number of comments) |
| `direction` | `desc` (default) or `asc` |
| `labels` | Comma-separated label names; a pull request must have all of them |
| `assignee` | A login, `none` (no assignees) or `*` (any assignee) |
| `creator` | Author login |
| `since` | Only pull requests updated at or after this ISO 8601 time |
| `q` | Text to find in titles and descriptions |
| `per_page`, `page` | Paging: up to 100 per page, default 30 |

To search across repositories with qualifiers, use `GET /search/issues` with `is:pr`, for example `q=repo:acme/website is:pr is:open base:main`. Supported qualifiers are listed in [Issues](/docs/collaboration/issues#search-issues-and-pull-requests).

To find the pull requests a commit belongs to, use `GET /repos/{owner}/{repo}/commits/{sha}/pulls`. It returns pull requests whose head commit or merge commit is that commit, and open pull requests (among the 50 most recently opened) whose head branch contains it. An unknown commit returns `422` with `No commit found for SHA: <sha>`.

`diffinery pr comment 12 --body "..."` adds a conversation comment.

## Differences from GitHub

- Pull requests are between branches of the same repository; there are no forks.
- The intent can't be edited after opening.
- Draft state changes through `PATCH /pulls/{number}` with `draft` (GitHub offers this only in GraphQL).
- An admin's merge past unmet branch rules must be asked for with `bypass_rules`, and skipping a merge queue with `bypass_merge_queue`; without them an admin is refused like anyone else. A merge commit is refused on a branch that requires linear history unless `bypass_rules` is sent.
- Reviews are submitted immediately; there are no pending reviews, suggested changes, or thread resolution yet.
- `rebase` outside the merge queue is a fast-forward only.
- `update-branch` exists in the REST API only (merge method only, no rebase); there is no **Update branch** button and no web conflict editor.
- Dismissing a review needs maintain access, and the pull request's author and agents can't do it.
- Pull requests opened by agents always need a human approval, and agent approvals never count.
- `GET /pulls/{number}/merge` answers GitHub clients with `204` or `404`, and other clients with a mergeability report.
- `mergeable_state` never reports `behind`, `unstable` or `has_hooks`.
- Requested reviewers are accounts only (no teams).
- Locking, reactions, review dismissal and repository-wide comment lists have no web UI yet.
- Auto-merge is available in every repository, with no repository setting to allow it first, and has REST endpoints (`PUT` and `DELETE /pulls/{number}/auto-merge`) where GitHub uses GraphQL. It waits only for required checks, never deletes the head branch, and its `auto_merge_enabled` and `auto_merge_disabled` actions don't start `pull_request` workflows. The CLI has no `--auto` flag.
- Agents land changes on protected branches through auto-merge only where a branch rule allows it (`allowAgentAutoMerge`), which has no GitHub equivalent.
- See also [Merge queue](/docs/collaboration/merge-queue#differences-from-github).

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| `pull request is not mergeable: ...` | The merge has blockers, listed after the colon. See [Merge blockers](#merge-blockers). If it ends with `(as an admin you can bypass with bypass_rules)`, you can merge anyway with an [admin bypass](#admin-bypass). |
| `main requires linear history; use squash or rebase` (405) | You asked for a merge commit on a branch that requires linear history. Use `squash` or `rebase` (`diffinery pr merge 12 --squash`). |
| `only the author or someone with write access can change draft status` (403) | Only the author or someone with write access can mark a draft ready or convert it back. |
| `GitHub Actions is not permitted to approve pull requests. ...` (403) | A workflow's `GITHUB_TOKEN` tried to approve or request changes. An admin can allow it; see [Pull requests and workflow tokens](#pull-requests-and-workflow-tokens). |
| `Resource not accessible by integration (...)` (403) | A workflow's `GITHUB_TOKEN` lacks the permission named in the message. Add it to the job's `permissions:`. |
| `repository is archived (read-only)` (403) | The repository is archived. An admin must unarchive it first. |
| `authentication required` (401) | You sent no credentials. Every change needs a signed-in caller, even on a public repository. |
| `this token needs the write scope` (403) | Your token has the `read` scope. Create one with `write` (or `admin`). |
| `head branch was modified; review and try again` (409) | Someone pushed after you loaded the page or read the head SHA. Review the new commits and merge again. |
| `base branch moved during merge; try again` (409) | The base changed while merging. Retry. |
| `merge conflicts` (405) | The head conflicts with the base. Resolve and push. |
| `rebase merge requires the branch to be up to date with its base (fast-forward only for now)` | Rebase the head onto the base and push, or use `merge` or `squash`. |
| `you cannot approve or request changes on your own pull request` | Ask someone else to review; you can leave a Comment review. |
| `write access is required to approve or request changes` | Approving needs write access. |
| `a comment review needs a body or line comments` | Add a review body or at least one line comment. |
| `pull request is closed` (when reviewing) | Only open pull requests can be reviewed. |
| `a merged pull request cannot be reopened` | Open a new pull request instead. |
| `conversation is locked` (403) | The pull request is locked. Only triage or higher can comment, review or react. |
| `path and line are required` | A new line comment needs `path` and `line` (or `in_reply_to` for a reply). |
| `team reviewers are not supported; request people by login` | Request reviewers by login in `reviewers`. |
| `main requires a merge queue: add the pull request to the queue` | Use **Merge when ready**, `diffinery pr merge`, or the merge queue API. |
| `Auto-merge was turned off: ...` (a comment) | Auto-merge can't go through as set up. See [When auto-merge turns itself off](#when-auto-merge-turns-itself-off). |
| `agents may not have pull requests merged into main automatically ...` | An agent or workflow token turned on auto-merge for a branch that doesn't allow it. See [Auto-merge errors](#auto-merge-errors). |
| No `pull_request` runs appear | The pull request conflicts with its base (no test merge commit), or the workflow's `on.pull_request` filters exclude it. |
