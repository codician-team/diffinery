---
title: Issues
description: Open, discuss, label, assign, lock, react to, close and search issues, and group them in milestones, in the web UI, the CLI, the REST API and over MCP.
---

Issues track bugs, tasks and ideas for a repository. Each issue has a title, a Markdown description, a conversation, labels, assignees and an open or closed state, and you can work with them from the web UI, the `diffinery` CLI, the REST API or an MCP client.

## How issues work

- **One number sequence per repository.** Issues and pull requests share the same counter, like on GitHub. If `#4` is a pull request, the next issue is `#5`. Opening `/acme/website/issues/4` when `#4` is a pull request redirects to `/acme/website/pull/4`, and the other way round.
- **State.** An issue is `open` or `closed`. A closed issue also has a reason: `completed` (the default) or `not_planned`. Pull requests that merged are closed with the reason `merged`.
- **Markdown everywhere.** Titles are plain text. Descriptions and comments are Markdown (see [Markdown](#markdown)).
- **Labels and assignees** are lists of names stored on the issue. Labels have a color and description defined per repository; assignees are account logins.
- **The API lists pull requests too.** As on GitHub, `GET /repos/{owner}/{repo}/issues` returns issues and pull requests; pull requests carry a `pull_request` field. Everything on this page about comments, labels, assignees, locking, reactions and events also works for pull requests through the issue endpoints.
- **GitHub-shaped API.** The REST API returns GitHub's issue objects, so Octokit and other GitHub clients work: an issue's `id` is its number, comment ids are numbers, `labels` are label objects and `assignees` are user objects.

## Permissions

Repository roles are read, triage, write, maintain and admin. A token's scope can lower your role. See [Permissions](/docs/accounts/permissions) and [Tokens](/docs/accounts/tokens).

Every change on this page needs a signed-in account and a token that can write:

- **Anonymous callers only read.** Without a token you can view the issues of a public repository, but opening an issue, commenting, reacting or any other change gets `401 authentication required`, as on GitHub.
- **`read` tokens only read.** Although the read role can open issues and comment, a token with only the `read` scope can't change anything: those requests get `403 this token needs the write scope`. Use a token with the `write` scope (the default) for issue work, even if your role on the repository is read.

| Action | Who can do it |
| --- | --- |
| View issues | Anyone who can read the repository (anyone at all for a public repository) |
| Open an issue | Anyone signed in who can read the repository (with a `write` or `admin` token through the API) |
| Comment | Anyone signed in who can read the repository (with a `write` or `admin` token through the API) |
| Edit the title or description | The issue's author, or triage or higher |
| Close or reopen | The issue's author, or triage or higher |
| Set labels and assignees in the web UI | Triage or higher |
| Set labels and assignees with `PATCH .../issues/{number}` | The issue's author, or triage or higher |
| Add or remove labels and assignees with the label and assignee endpoints | Triage or higher |
| Create, rename, recolor and delete labels | Triage or higher |
| Create, edit and close milestones, and set an issue's milestone | Triage or higher |
| Edit or delete a comment | The comment's author, or maintain or higher |
| Lock and unlock a conversation | Triage or higher |
| Comment or react on a locked issue | Triage or higher |
| Add a reaction | Anyone signed in who can read the repository (with a `write` or `admin` token through the API) |
| Delete a reaction | The person who added it, or admin |

When you open an issue, the `labels` and `assignees` you send are applied only if you have triage access or higher. Without it they are silently dropped and the issue is created without them, as on GitHub: the request still succeeds with `201`. This applies to the REST API, the CLI (`--label`, `--assignee`) and the MCP `create_issue` tool; the web form only offers labels to triage or higher. Editing works the same way: when the issue's author (or anyone else) without triage access sends `labels` or `assignees` with `PATCH .../issues/{number}`, they are dropped too, and the rest of the edit is applied.

In an archived repository every change is refused, whatever your role: opening and editing issues, comments, labels, assignees, locks and reactions, through the web UI, the REST API, the CLI and MCP, all fail with `403` and `repository is archived (read-only)`. The web UI shows issues read-only. Subscribing to an issue and watching the repository still work.

A workflow's `GITHUB_TOKEN` can work with issues within its `permissions:`: opening an issue (`POST .../issues`) needs `issues: write`, and comments, labels, assignees and reactions on an issue accept `issues: write` or `pull-requests: write`. Without them the request fails with `403` and `Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: issues: write)`. A job token acts with at most the write role, so it can set labels and assignees when it opens an issue.

## Open an issue

### Open an issue in the web UI

1. Go to the repository and open the **Issues** tab, or go straight to `https://diffinery.com/acme/website/issues/new`.
2. Click **New issue**.
3. Fill in **Title** (required) and **Description** (Markdown).
4. If you have triage access and the repository has labels, tick the **Labels** to apply.
5. Click **Submit new issue**. You land on the new issue's page.

You can prefill the title with a query parameter: `https://diffinery.com/acme/website/issues/new?title=Broken%20link%20on%20pricing%20page`.

### Open an issue with the CLI

Install the CLI and sign in through your browser:

```sh
curl -fsSL https://diffinery.com/install | bash
diffinery login
```

Then, inside a clone of the repository (or with `-R acme/website`):

```sh
diffinery issue create -R acme/website \
  --title "Broken link on pricing page" \
  --body "The *Contact sales* link returns 404." \
  --label bug --label website \
  --assignee diffy
```

| Flag | Meaning |
| --- | --- |
| `-t, --title TEXT` | Title (required) |
| `-b, --body TEXT` | Description (Markdown) |
| `--body-file FILE` | Read the description from a file, or from stdin with `-` |
| `-l, --label NAME` | Add a label (repeat for more) |
| `-a, --assignee LOGIN` | Assign a login (repeat for more) |
| `-R, --repo OWNER/NAME` | Repository (default: inferred from the git `origin` remote) |
| `--json` | Print the created issue as JSON |

The command prints `✓ Opened issue #12 Broken link on pricing page` and the issue URL.

### Open an issue with the REST API

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/issues \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Broken link on pricing page", "body": "The *Contact sales* link returns 404.", "labels": ["bug"], "assignees": ["diffy"]}'
```

The response (`201 Created`) is GitHub's issue object: `id` and `number` (both the issue number), `title`, `body`, `state`, `state_reason`, `locked`, `active_lock_reason`, `user` (`login`, `id`, and `type` `User` or `Bot`), `labels` (label objects with `id`, `name`, `color`, `description`), `assignee` and `assignees` (user objects), `comments`, `reactions` (counts), `created_at`, `updated_at`, `closed_at`, `html_url` and API URLs such as `comments_url`, `events_url` and `timeline_url`. `assignee` (a single login) is accepted in place of `assignees`, and `labels` may be names or `{ "name": ... }` objects.

### Open an issue over MCP

The `create_issue` tool takes `owner`, `repo`, `title`, and optionally `body` and `labels`. See [MCP server](/docs/agents/mcp).

## Markdown

Descriptions, comments and review bodies are rendered as Markdown. Supported: headings, paragraphs, hard line breaks, fenced code blocks, horizontal rules, blockquotes, ordered, unordered and task lists (nested), tables, inline code, bold, italic, strikethrough, links, images and bare URLs.

- Raw HTML is escaped, never rendered. HTML comments (`<!-- ... -->`) are hidden, as on GitHub, except inside code. They stay in the body, so the API and the edit box still show them, but pages and notification emails don't.
- Only `http(s)` URLs, `#fragment` links and relative paths are kept in links and images. Relative links resolve against the repository's default branch.
- Task list items (`- [ ]` and `- [x]`) render as checkboxes. They are display only; edit the text to tick them.
- A body larger than 512 KB is shown as plain preformatted text.

## Labels

Labels are defined per repository, each with a name, a six-digit hex color and an optional description.

### Create, change and delete labels

In the web UI (triage or higher):

1. Open the **Issues** tab and click **Labels**, or go to `https://diffinery.com/acme/website/labels`.
2. Under **New label**, enter a **Name** (up to 50 characters), an optional **Description** (up to 100 characters) and pick a **Color**.
3. Click **Create label**.

In the web UI, to change a label's color or description, create it again with the same name: the new values replace the old ones. To remove a label, click **Delete** next to it and confirm. Deleting a label in the web UI removes only the definition: issues that use it keep the name, shown in a neutral gray.

With the REST API (triage or higher for changes):

```sh
# List labels, or read one
curl -H "Authorization: Bearer dfy_..." https://diffinery.com/api/v3/repos/acme/website/labels
curl -H "Authorization: Bearer dfy_..." https://diffinery.com/api/v3/repos/acme/website/labels/bug

# Create a label
curl -X POST https://diffinery.com/api/v3/repos/acme/website/labels \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"name": "bug", "color": "d73a4a", "description": "Something is broken"}'

# Rename it, or change its color or description
curl -X PATCH https://diffinery.com/api/v3/repos/acme/website/labels/bug \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"new_name": "type: bug", "color": "b60205"}'

# Delete it
curl -X DELETE "https://diffinery.com/api/v3/repos/acme/website/labels/type%3A%20bug" -H "Authorization: Bearer dfy_..."
```

| Rule | Detail |
| --- | --- |
| Name | 1 to 100 characters through the API (the web form allows up to 50). Creating a name that exists fails with `a label with this name already exists`. |
| Color | Six hex digits, with or without a leading `#`. Defaults to `ededed`. Anything else fails with `color must be a 6-digit hex code`. |
| Description | Up to 100 characters (longer text is cut). |
| Rename | `new_name` renames the label on every issue that has it. |
| Delete | `DELETE` removes the label from every issue that has it, unlike the web UI's **Delete**. |

Labels are returned as GitHub label objects: `id`, `node_id`, `url`, `name`, `color`, `default` (always `false`) and `description`.

### Apply labels to an issue

- **Web UI (triage or higher):** in the issue's sidebar under **Labels**, click **Edit labels**, tick the labels you want, and click **Apply**. Type a name into **New label…** to create a label on the spot; it gets a color picked from a built-in palette.
- **CLI:** `diffinery issue create --label NAME` when you open the issue.
- **REST API, whole list:** send the complete list in `labels` with `PATCH /repos/{owner}/{repo}/issues/{number}`. It replaces the previous list.

```sh
curl -X PATCH https://diffinery.com/api/v3/repos/acme/website/issues/12 \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"labels": ["bug", "website"]}'
```

- **REST API, one change at a time (triage or higher):** the issue label endpoints work as on GitHub. Each returns the issue's labels after the change.

| Method and path | Effect |
| --- | --- |
| `GET /repos/{owner}/{repo}/issues/{number}/labels` | List the issue's labels |
| `POST /repos/{owner}/{repo}/issues/{number}/labels` | Add labels, keeping the existing ones. Body: `{"labels": ["bug"]}` or `["bug"]`. |
| `PUT /repos/{owner}/{repo}/issues/{number}/labels` | Replace all labels |
| `DELETE /repos/{owner}/{repo}/issues/{number}/labels/{name}` | Remove one label (`404 Label does not exist` if the issue doesn't have it) |
| `DELETE /repos/{owner}/{repo}/issues/{number}/labels` | Remove all labels (`204`) |

The add and replace endpoints create any label that doesn't exist yet, with the color `ededed`, like GitHub. An issue can have at most 100 labels through `POST` (`an issue can have at most 100 labels`).

- **MCP:** `update_issue` with `labels` (the complete list).

Label names set with `PATCH`, MCP or the web UI don't have to match a defined label. An undefined name is shown in gray.

## Assignees

An issue can have several assignees. Assigned people are notified and follow the thread from then on.

- **Web UI (triage or higher):** in the sidebar under **Assignees**, click **Edit assignees**, type logins separated by commas or spaces (a leading `@` is ignored, at most 10), and click **Save**. Leave the box empty to remove everyone.
- **CLI:** `diffinery issue create --assignee diffy`.
- **REST API, whole list:** send the complete list in `assignees` (or a single `assignee`; `"assignee": null` clears them) on `POST .../issues` or `PATCH .../issues/{number}`.
- **REST API, add or remove (triage or higher):**

```sh
# Add assignees (returns the issue, 201)
curl -X POST https://diffinery.com/api/v3/repos/acme/website/issues/12/assignees \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"assignees": ["diffy", "review-bot"]}'

# Remove assignees (returns the issue)
curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/issues/12/assignees \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"assignees": ["review-bot"]}'
```

These endpoints allow at most 10 assignees (`an issue can have at most 10 assignees`), and removal ignores letter case.

Logins are not checked when you assign them, so check the spelling. `GET /repos/{owner}/{repo}/assignees` lists the accounts GitHub clients offer as assignees: the repository's direct collaborators with triage or higher, plus the owner of a personal repository. `GET /repos/{owner}/{repo}/assignees/{login}` answers `204` for those accounts and `404` otherwise; it doesn't stop you from assigning anyone else.

## Milestones

A milestone groups issues and pull requests that belong to one goal, such as a release, with an optional due date. Each issue or pull request has at most one milestone. Milestones have their own numbers in each repository, starting at 1; milestones brought in by a [GitHub import](/docs/migrate-from-github) keep their GitHub numbers, and new ones are numbered after them.

You create and edit milestones with the REST API (there's no web page, CLI command or MCP tool for them yet) and set an issue's milestone in the web UI or with the REST API. Creating, editing and setting milestones needs triage or higher and a token with the `write` scope; anyone who can read the repository can read them.

### Milestone fields

| Field | Description |
| --- | --- |
| `number` (also `id`) | The milestone's number in the repository |
| `title` | 1 to 255 characters; required when you create a milestone |
| `description` | Text up to 65,536 characters; empty by default |
| `state` | `open` or `closed`. New milestones are `open` unless you create them with `"state": "closed"`. |
| `due_on` | An ISO 8601 timestamp, or `null` for no due date. It's stored in UTC. |
| `creator` | `{"login": "..."}` of the account that created it |
| `open_issues`, `closed_issues` | How many open and closed issues and pull requests have this milestone (merged pull requests count as closed) |
| `created_at`, `updated_at`, `closed_at` | Timestamps; `closed_at` is set when the milestone is closed and cleared when it's reopened |

### Create and edit milestones with the REST API

| Request | Needs | Does |
| --- | --- | --- |
| `GET /repos/{owner}/{repo}/milestones` | read | Lists milestones. `state` is `open` (default), `closed` or `all`. Sorted by due date (milestones without one last), then by number. The list isn't paged. |
| `GET /repos/{owner}/{repo}/milestones/{number}` | read | One milestone, or `404 milestone not found` |
| `POST /repos/{owner}/{repo}/milestones` | triage | Creates a milestone from `title`, `description`, `state` and `due_on`; returns `201` with the milestone |
| `PATCH /repos/{owner}/{repo}/milestones/{number}` | triage | Changes any of `title`, `description`, `state` and `due_on` (`null` removes the due date); returns the milestone |

```sh
# Create a milestone
curl -X POST https://diffinery.com/api/v3/repos/acme/website/milestones \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"title": "v2.0", "description": "Pricing page redesign", "due_on": "2026-12-01T00:00:00Z"}'

# Close it
curl -X PATCH https://diffinery.com/api/v3/repos/acme/website/milestones/1 \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"state": "closed"}'

# List every milestone, open and closed
curl "https://diffinery.com/api/v3/repos/acme/website/milestones?state=all" \
  -H "Authorization: Bearer dfy_..."
```

Milestones can't be deleted; close one you no longer use. To clear a description, send `"description": ""` (`null` leaves it unchanged).

### Set the milestone of an issue or pull request

- **Web UI (triage or higher):** the sidebar of an issue or pull request has a **Milestone** section showing the milestone's title, a `closed` badge if it's closed and its due date, or **No milestone**. Click **Set milestone**, choose a milestone in the **Milestone** list (it offers the open milestones and **No milestone**), and click **Save**. **Set milestone** appears only when the repository has an open milestone or the issue already has one. Click the milestone's title to list its open issues (or pull requests, on a pull request).
- **REST API (triage or higher):** send `milestone` with the milestone's number, or `null` to remove it, on `PATCH /repos/{owner}/{repo}/issues/{number}`. This works for pull request numbers too, and also accepts closed milestones. From someone without triage access, such as an issue's author, `milestone` is ignored without an error, like `labels` and `assignees`.

```sh
curl -X PATCH https://diffinery.com/api/v3/repos/acme/website/issues/12 \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"milestone": 1}'
```

Issues and pull requests returned by the REST API carry a `milestone` object (`number`, `id`, `title`, `state`, `due_on`, `url`; `description` is always `null` there), or `null`. Things to know about setting it with `PATCH`:

- The response shows the issue with its new milestone.
- The milestone is checked before anything is saved: a number no milestone has fails with `422 Validation Failed`, and nothing in the request is saved.
- A value that isn't a whole number or `null` fails with `422 milestone must be a milestone number or null`, and nothing is saved.

A workflow's `GITHUB_TOKEN` needs `issues: write` or `pull-requests: write` to create, edit or set milestones.

Setting or changing a milestone doesn't create an event in the timeline, doesn't send a webhook or a notification, and there are no `milestone` webhook events. To list a milestone's issues and pull requests, send `milestone` on `GET .../issues`: a milestone number, `none` (no milestone) or `*` (any milestone). In the web UI, add `milestone=` and the number to the issue list's address; a milestone's `html_url` (`/{owner}/{repo}/milestone/{number}`) opens that list. `milestone:` in a search is still searched as text.

## Comments

### Add a comment

- **Web UI:** type in **Add a comment** at the bottom of the issue and click **Comment**. Clicking **Comment** with an empty box shows `write a comment first`.
- **CLI:** `diffinery issue comment 12 --body "Fixed in #15."` The body can also come from `--body-file FILE`, or from stdin when you pipe it in.
- **REST API:**

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/issues/12/comments \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"body": "Fixed in #15."}'
```

- **MCP:** the `comment` tool (needs triage or higher when used over MCP).

An empty body is rejected with `body is required`. On a [locked](#lock-a-conversation) issue, only triage or higher can comment; others get `conversation is locked`.

### List comments

```sh
# Comments on one issue (since: only comments updated at or after this time)
curl -H "Authorization: Bearer dfy_..." "https://diffinery.com/api/v3/repos/acme/website/issues/12/comments?since=2026-10-01T00:00:00Z"

# Comments on every issue and pull request in the repository
curl -H "Authorization: Bearer dfy_..." "https://diffinery.com/api/v3/repos/acme/website/issues/comments?sort=updated&direction=desc&per_page=50"

# One comment
curl -H "Authorization: Bearer dfy_..." https://diffinery.com/api/v3/repos/acme/website/issues/comments/1234
```

Each comment has a numeric `id` (as on GitHub), `body`, `user`, `created_at`, `updated_at`, `issue_url`, `html_url` and `reactions`. The repository-wide list takes `since`, `sort` (`created`, the default, or `updated`), `direction` (`asc`, the default, or `desc`), `per_page` and `page`. These lists hold conversation comments only; line comments on pull requests are under `/pulls/comments` (see [Pull requests](/docs/collaboration/pull-requests#line-comments)). `diffinery issue view 12` prints the issue and all its comments.

### Edit or delete a comment

Edit or delete a comment through the REST API, using its `id`:

```sh
curl -X PATCH https://diffinery.com/api/v3/repos/acme/website/issues/comments/1234 \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"body": "Fixed in #15 and #16."}'

curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/issues/comments/1234 \
  -H "Authorization: Bearer dfy_..."
```

Only the comment's author or someone with maintain or higher can edit or delete it (`permission denied` otherwise). Deleting a comment also deletes its reactions. The web UI and the CLI have no comment editing or deleting yet.

### Hide a comment

Someone with write access to the repository (site administrators everywhere) can hide a comment that is spam, abuse, off-topic, outdated, a duplicate or resolved, as GitHub's **Hide** does. On the web, open the comment's **…** menu and pick a reason under **Hide comment**. The comment stays, collapsed behind a line such as "This comment was marked as spam."; anyone can click **Show comment** to read it. **Unhide** in the same menu shows it again. This works on issue and pull request comments, review comments and reviews' comments alike.

Through the API (Diffinery's; GitHub only has GraphQL's `minimizeComment`), with the comment's `id`:

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/diffinery/comments/1234/minimized \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"reason": "spam"}'

curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/diffinery/comments/1234/minimized \
  -H "Authorization: Bearer dfy_..."
```

`reason` is `spam`, `abuse`, `off_topic`, `outdated`, `duplicate` or `resolved` (GitHub's classifiers, such as `OFF_TOPIC` in `classifier`, work too). The answer is `{"is_minimized": true, "minimized_reason": "spam"}`. Agents can't hide comments. Hiding and showing are audited as `comment.minimize` and `comment.unminimize`.

To report a comment to the site administrators instead, pick **Report content** in the same menu. See [Blocking and reporting](/docs/accounts/blocking-and-reporting).

### Edit the title and description

- **Web UI:** click **Edit** next to the title, change **Title** or **Description**, and click **Save**. An empty title is rejected with `title is required`.
- **REST API:** `PATCH /repos/{owner}/{repo}/issues/{number}` with `title` and/or `body`.
- **MCP:** `update_issue` with `title` and/or `body`.

Changing the title records a `renamed` event. A change to the title or the description sends an `issues` webhook with the action `edited` (for a pull request, a `pull_request` webhook with `edited`, which also triggers workflows that listen for `pull_request` `edited`). Saving the same text again sends nothing. See [Webhook events](/docs/reference/webhook-events).

## Lock a conversation

Lock an issue or pull request when a discussion should stop. While it is locked, only people with triage or higher can comment, review, add line comments or react; everyone else gets `403` with `conversation is locked`. Closing, reopening and merging are not affected.

```sh
# Lock, with an optional reason
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/issues/12/lock \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"lock_reason": "too heated"}'

# Unlock
curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/issues/12/lock \
  -H "Authorization: Bearer dfy_..."
```

Both need triage or higher and return `204`. `lock_reason` is optional and must be `off-topic`, `too heated`, `resolved` or `spam` (otherwise `lock_reason must be off-topic, too heated, resolved or spam`). A locked issue reports `"locked": true` and the reason in `active_lock_reason`, and the timeline gets `locked` and `unlocked` events. Locking is available through the REST API only; the web UI doesn't show a lock control or badge yet, and its comment form returns the same error.

## Reactions

Reactions are emoji responses to an issue, a pull request, a conversation comment, a pull request line comment or a [release](/docs/collaboration/releases). The allowed `content` values are the same as on GitHub: `+1`, `-1`, `laugh`, `confused`, `heart`, `hooray`, `rocket` and `eyes`.

| Subject | Endpoint |
| --- | --- |
| Issue or pull request | `/repos/{owner}/{repo}/issues/{number}/reactions` |
| Conversation comment | `/repos/{owner}/{repo}/issues/comments/{id}/reactions` |
| Pull request line comment | `/repos/{owner}/{repo}/pulls/comments/{id}/reactions` |
| Release | `/repos/{owner}/{repo}/releases/{id}/reactions` |

```sh
# Add a reaction: 201 when new, 200 when you had already reacted with that content
curl -X POST https://diffinery.com/api/v3/repos/acme/website/issues/12/reactions \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"content": "+1"}'

# List reactions, optionally only one kind
curl -H "Authorization: Bearer dfy_..." "https://diffinery.com/api/v3/repos/acme/website/issues/12/reactions?content=heart"

# Remove a reaction by its id
curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/issues/12/reactions/7 -H "Authorization: Bearer dfy_..."
```

Each reaction has `id`, `content`, `user` and `created_at`. Issues, comments and releases carry a `reactions` object with a `total_count` and a count per content. Rules:

- You need to be signed in, with a `write` or `admin` token: anonymous requests get `401 authentication required`, and a `read` token gets `403 this token needs the write scope`.
- An unknown `content` fails with `422` and `content must be one of +1, -1, laugh, confused, heart, hooray, rocket, eyes`.
- On a locked issue or pull request, only triage or higher can react.
- You can delete your own reactions; admins can delete anyone's (`you can only delete your own reactions` otherwise).

Reactions are available through the REST API only; the web UI, the CLI and MCP don't show them yet.

## Events and timeline

Diffinery records what happens to an issue or pull request as events, with the same names as GitHub:

| Event | Extra fields |
| --- | --- |
| `labeled`, `unlabeled` | `label` (`name`, `color`) |
| `assigned`, `unassigned` | `assignee`, `assigner` |
| `renamed` | `rename` (`from`, `to`) |
| `closed` | `state_reason`; for a merge, `commit_id` |
| `reopened` | none |
| `locked`, `unlocked` | `lock_reason` |
| `review_requested`, `review_request_removed` | `requested_reviewer`, `review_requester` |
| `review_dismissed` | `dismissed_review` (`state`, `review_id`, `dismissal_message`) |
| `merged` | `commit_id` |
| `ready_for_review`, `convert_to_draft` | none; pull requests only (see [Pull requests](/docs/collaboration/pull-requests#drafts)). The matching webhook actions are `ready_for_review` and `converted_to_draft`. |

Every event also has `id`, `actor`, `event`, `created_at`, `commit_id` and `commit_url`.

| Method and path | Returns |
| --- | --- |
| `GET /repos/{owner}/{repo}/issues/{number}/events` | The events of one issue or pull request, oldest first |
| `GET /repos/{owner}/{repo}/issues/events` | Events across the repository, newest first, each with its `issue` |
| `GET /repos/{owner}/{repo}/issues/events/{id}` | One event |
| `GET /repos/{owner}/{repo}/issues/{number}/timeline` | Events, comments (`"event": "commented"`) and reviews (`"event": "reviewed"`) in time order |

All lists are paged with `per_page` and `page`. Opening an issue and posting a comment are not events; read the issue and its comments for those.

## Mentions

Write `@login` in an issue description, a comment or a review to notify that person or agent. Mentions inside code blocks and inline code are ignored, and at most 50 mentions per text are picked up. A mentioned account is notified only if it can read the repository. A mention gets through even when that person has muted the thread. See [Notifications](/docs/accounts/notifications).

## Close and reopen

### Close reasons

| Reason | Set by | Shown as |
| --- | --- | --- |
| `completed` | **Close issue**, `diffinery issue close`, or `state: "closed"` without a reason | Closed |
| `not_planned` | **Close as not planned**, `--reason not_planned`, or `state_reason: "not_planned"` | Closed as not planned |
| `merged` | A pull request that merged | Merged |

### Close and reopen in the web UI

At the bottom of an open issue, click **Close issue** or **Close as not planned**. If you typed a comment first, it is posted and then the issue closes. On a closed issue, click **Reopen** (again posting any comment you typed).

### Close and reopen with the CLI

```sh
diffinery issue close 12                           # reason: completed
diffinery issue close 12 --reason not_planned --comment "Out of scope for v2."
diffinery issue reopen 12 --comment "Still happening on Safari."
```

`--reason` accepts `completed` or `not_planned` (anything else exits with `--reason must be completed or not_planned`). `-c, --comment TEXT` posts a comment before changing the state.

### Close and reopen with the REST API

```sh
curl -X PATCH https://diffinery.com/api/v3/repos/acme/website/issues/12 \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"state": "closed", "state_reason": "not_planned"}'
```

Send `{"state": "open"}` to reopen; the reason is cleared.

### Close issues from a pull request

When a pull request merges, Diffinery closes every open issue in the same repository that its title or description references with a closing keyword: `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves` or `resolved`, followed by `#` and the number (for example `Fixes #12`). The keywords are case-insensitive and the issues close with the reason `completed`. References to other repositories are not supported.

## Subscribe and unsubscribe

You get notifications for an issue when you opened it, commented, were assigned or @mentioned, or watch the repository with **All activity**. The issue sidebar's **Notifications** section tells you why and has a **Subscribe** or **Unsubscribe** button:

- **Subscribe** sends you every new comment and state change: `Subscribed. You'll be notified about all activity.`
- **Unsubscribe** mutes the thread: `Unsubscribed. You'll still be notified if you're @mentioned, assigned or asked to review.`

Thread subscriptions are set in the web UI or from the unsubscribe link in a notification email; there is no API for them yet. To watch a whole repository, use its **Watch** menu or the `/repos/{owner}/{repo}/subscription` API. See [Notifications](/docs/accounts/notifications).

## Find issues

### The issue list

The **Issues** tab (`https://diffinery.com/acme/website/issues`) lists issues newest first, 25 per page.

- **Open and Closed:** the two counters at the top switch between open and closed issues.
- **Search:** the search box (press `/` to focus it) matches text anywhere in the title or the description, up to 200 characters.
- **Label:** pick one from the **Label ▾** menu, or click a label on any issue.
- **Author:** click an author's login on any issue to show only their issues.
- **Milestone:** click the milestone in an issue's sidebar, or add `milestone=` and its number to the address.
- Active filters appear at the top of the list with a **clear** link. Filters combine.

Filters are query parameters, so you can bookmark or share them:

```text
https://diffinery.com/acme/website/issues?state=closed&label=bug&author=diffy&q=pricing
```

### List issues with the CLI

```sh
diffinery issue list -R acme/website --state all --label bug --author diffy --search pricing --limit 50
diffinery issue view 12
```

| Flag | Meaning |
| --- | --- |
| `-s, --state STATE` | `open` (default), `closed` or `all` |
| `-l, --label NAME` | Only issues with this label |
| `-A, --author LOGIN` | Only issues opened by this login |
| `-S, --search QUERY` | Text to find in titles and descriptions |
| `-L, --limit N` | Maximum number to show (default 30) |

`diffinery issue list` hides pull requests. All issue commands accept `--json`.

### List issues with the REST API

```sh
curl -H "Authorization: Bearer dfy_..." \
  "https://diffinery.com/api/v3/repos/acme/website/issues?state=all&labels=bug&creator=diffy&q=pricing&per_page=50&page=1"
```

| Parameter | Meaning |
| --- | --- |
| `state` | `open` (default), `closed` or `all` |
| `labels` | Comma-separated label names (exact match); an issue must have all of them |
| `assignee` | A login, `none` (no assignees) or `*` (any assignee) |
| `creator` | Author login (case-insensitive) |
| `since` | Only issues updated at or after this ISO 8601 time |
| `sort` | `created` (default), `updated` or `comments` |
| `direction` | `desc` (default) or `asc` |
| `q` | Text to find in titles and descriptions (a Diffinery extension) |
| `per_page` | Results per page, default 30, at most 100 |
| `page` | Page number, starting at 1 |

The `x-total-count` response header holds the total number of matches, and a `Link` header points at the next, previous, first and last pages, so `octokit.paginate` works. Results include pull requests.

Over MCP, `list_issues` takes `state`, `q` and `label` and returns up to 100 issues (no pull requests); `get_issue` returns one issue with its comments.

### Search issues and pull requests

`GET /search/issues` searches issues and pull requests with GitHub's query syntax, across every repository you can read:

```sh
curl -H "Authorization: Bearer dfy_..." --get https://diffinery.com/api/v3/search/issues \
  --data-urlencode 'q=repo:acme/website is:issue is:open label:bug -label:wontfix pricing' \
  --data-urlencode 'sort=updated' --data-urlencode 'order=desc'
```

The response has `total_count`, `incomplete_results` and `items` (issue objects, each with `"score": 1`), with a `Link` header for further pages.

| Qualifier | Meaning |
| --- | --- |
| `repo:acme/website` | Only this repository (repeat for several) |
| `user:`, `org:`, `owner:` | Only repositories of this account |
| `is:issue`, `is:pr` (also `type:`) | Issues or pull requests |
| `is:open`, `is:closed` (also `state:`) | State; `-is:open` means closed |
| `is:merged`, `is:unmerged` | Merged or not (pull requests only) |
| `is:draft`, `draft:true`, `draft:false` | Draft pull requests or not |
| `is:locked`, `is:unlocked` | Locked conversations or not |
| `label:bug`, `label:bug,ui` | Has these labels (all of them); `-label:` excludes |
| `no:label`, `no:assignee` | Has no labels, or no assignees |
| `author:diffy`, `-author:review-bot` | Opened by, or not by, this login |
| `assignee:diffy` | Assigned to this login |
| `head:fix-pricing-link`, `base:main` | Pull requests by head or base branch |
| `in:title`, `in:body`, `in:comments` | Where words must appear (default: title and body); combine with commas |
| `created:`, `updated:`, `closed:` | Date ranges: `>2026-09-01`, `>=`, `<`, `<=`, `2026-09-01..2026-09-30`, `2026-09-01..*`, or one day |
| `sort:created-asc`, `sort:updated`, `sort:comments-desc` | Order (default: newest created first) |

Words without a qualifier must all appear (case-insensitive substring match); `-word` excludes a word, and `"two words"` is matched as a phrase. Unknown qualifiers are searched as text. The `sort` (`created`, `updated` or `comments`) and `order` (`asc` or `desc`) query parameters override a `sort:` qualifier.

Limits:

- A query can be up to 256 characters (`The search is longer than 256 characters.`), and an empty `q` fails with `Validation Failed`.
- One search looks at up to 50 repositories. When you can read more, `incomplete_results` is `true`; narrow the search with `repo:`, `user:` or `org:`.
- Only the first 1,000 results can be paged through (`Only the first 1000 search results are available`).
- In each repository, the 5,000 newest issues and pull requests are searched, and `in:comments` reads the 2,000 newest comments.
- Without a token, only public repositories are searched. A workflow job token searches only its own repository.

The web UI's issue list and `diffinery issue list --search` don't use this syntax; they match plain text in titles and descriptions.

## Differences from GitHub

- An issue's `id` is its number; issues are addressed by number only.
- `/search/issues` covers at most 50 repositories per search and ignores qualifiers it doesn't know (they are searched as text). `review-requested:`, `mentions:`, `commenter:`, `milestone:`, `linked:` and `reactions:` are not supported.
- There are no issue types, issue templates, transfers or pinned issues.
- Milestones are created and edited through the REST API only, can't be deleted, and have no events or webhooks. See [Milestones](#milestones).
- Deleting a label in the web UI keeps its name on issues; deleting it through the API removes it from them.
- Locking, reactions, events and comment deletion are available through the REST API only, not in the web UI.
- `GET /repos/{owner}/{repo}/assignees` lists direct collaborators only, not organization members.
- Thread subscriptions have no API.

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| `title is required` | The title was empty. Give the issue a title. |
| `body is required` | You posted an empty comment. |
| `permission denied` | You tried to edit, close or reopen someone else's issue without triage access, or edit someone else's comment without maintain access. |
| `triage access required` | Creating, changing or deleting labels, setting labels and assignees in the web UI, the issue label, assignee and lock endpoints, and creating, editing and setting milestones need triage or higher. |
| `#12 not found` | There is no issue or pull request with that number. |
| `you can't open issues or pull requests, comment, review or react in acme's repositories: acme blocked you` | The repository's owner blocked you. See [Blocking and reporting](/docs/accounts/blocking-and-reporting). |
| `conversation is locked` | The issue is locked. Only triage or higher can comment or react. |
| `a label with this name already exists` | Use `PATCH /labels/{name}` to change an existing label. |
| `milestone not found` | There is no milestone with that number. List them with `GET .../milestones?state=all`. |
| `title is required`, `title must be 1 to 255 characters` | A new milestone needs a title, and a milestone title can't be blank or longer than 255 characters. |
| `due_on must be an ISO 8601 timestamp` | Send a date such as `2026-12-01T00:00:00Z`, or `null`. |
| `state must be open or closed`, `state must be open, closed or all` | Use one of the listed values for a milestone's `state`, or for the `state` filter when listing milestones. |
| `description must be a string` | A milestone description must be text of at most 65,536 characters. |
| `milestone must be a milestone number or null` | `PATCH .../issues/{number}` takes the milestone's number, not its title. |
| The milestone didn't change in the `PATCH` response | The response shows the issue before the milestone changed. Read the issue again. |
| `incomplete_results: true` in a search | You can read more than 50 repositories. Add `repo:`, `user:` or `org:` to the query. |
| `repository not found` | The repository doesn't exist, or your account or token can't see it (private repositories return 404). |
| `authentication required` | You called the API without a token, either on a private repository or to change something (open an issue, comment, react) on a public one. Send `Authorization: Bearer dfy_...`. |
| `this token needs the write scope` | Your token has only the `read` scope, which can't open issues, comment or react. Create a token with the `write` scope. |
| The new issue has no labels or assignees | You don't have triage access, so the `labels` and `assignees` you sent were dropped. Ask someone with triage access to add them. |
| `repository is archived (read-only)` | The repository is archived. An admin must unarchive it before issues can change. |
| `Resource not accessible by integration (...)` | A workflow's `GITHUB_TOKEN` lacks the permission named in the message. Add `issues: write` to the job's `permissions:`. |
