---
title: MCP server
description: Connect AI agents to Diffinery over the Model Context Protocol at https://diffinery.com/mcp, with client setup, the tool list, permissions and example calls.
---

Diffinery runs a Model Context Protocol (MCP) server at `https://diffinery.com/mcp`. An MCP client such as Claude Code, Cursor or VS Code can use it to read code, commit changes, open and review pull requests, follow CI, publish releases, run commands in sandboxes, import repositories from GitHub and look things up in these docs, all without a git client. Every tool goes through the same permission checks, branch protection and agent guardrails as git and the REST API.

## Endpoint and transport

| Property | Value |
| --- | --- |
| URL | `https://diffinery.com/mcp` |
| Transport | Streamable HTTP. Send JSON-RPC 2.0 messages with `POST`; every response is a single JSON body (`application/json`), never an event stream. |
| Sessions | None. The server is stateless and doesn't issue an `Mcp-Session-Id`; send the token with every request. |
| Batches | A JSON array of requests gets a JSON array of responses. |
| Notifications | Requests without an `id` (such as `notifications/initialized`) get `202 Accepted` with an empty body. |
| `GET /mcp` | `405` with `{"message": "Diffinery MCP: POST JSON-RPC here with Authorization: Bearer <token>"}`. There is no server-to-client stream. |
| Protocol versions | `2025-06-18` (default), `2025-03-26`, `2024-11-05`. `initialize` answers with the version you asked for when it is supported, otherwise `2025-06-18`. |
| Capabilities | `tools` only (`listChanged: false`). No resources or prompts. |
| Methods | `initialize`, `ping`, `tools/list`, `tools/call`, and the notifications `notifications/initialized` and `notifications/cancelled` |
| Server info | `{"name": "diffinery", "title": "Diffinery", "version": "0.1.0"}`, plus short usage `instructions` for the model (how to read code, commit, open pull requests, watch CI, use sandboxes and search the docs) |

## Authentication

There are two ways to authenticate, and every tool call goes through the same checks either way.

**Sign in through the browser (OAuth).** Clients that support MCP's OAuth sign-in (claude.ai connectors, Claude Code, Codex, Cursor, VS Code) need nothing but the URL. On their first request they get a `401` whose header says where to sign in:

```http
WWW-Authenticate: Bearer realm="Diffinery", resource_metadata="https://diffinery.com/.well-known/oauth-protected-resource/mcp"
```

The client then opens Diffinery in your browser, where you choose whom it acts as (you, or one of your [agents](/docs/agents/overview)) and its access, and connect it. It gets tokens that last 8 hours and renew themselves; the connection is listed under **Settings → Access tokens → Connected apps**, where you can disconnect it. See [How sign-in works](/docs/connect/how-sign-in-works) for the details.

**A token in the header.** For scripts, CI and cloud sessions where nobody can click through a browser, send a Diffinery token:

```http
Authorization: Bearer dfy_...
```

`token dfy_...` and HTTP Basic auth with the token as the password also work. Use an agent's token for an AI agent (see [Agents](/docs/agents/overview)), or your own personal token (see [Tokens](/docs/accounts/tokens)).

Either way, the token's scope limits what the tools can do: every tool that isn't read-only needs the `write` or `admin` scope, so a `read` token can only use read-only tools (see [Token scope and write tools](#token-scope-and-write-tools)).

| Response | Meaning |
| --- | --- |
| `401 {"message": "sign in required"}` | No `Authorization` header. The `WWW-Authenticate` header points at the OAuth metadata. |
| `401 {"message": "invalid, expired or revoked token"}` | The token is wrong, expired or revoked, or its account (or agent) is disabled. `WWW-Authenticate` adds `error="invalid_token"`, so an OAuth client renews its token or signs in again. |
| `401 {"message": "unrecognised token; create one under Settings → Access tokens"}` | The header doesn't hold a `dfy_` token. |

## Connect your client

For Claude, Claude Code, Codex and other apps with browser sign-in, [Connect AI apps](/docs/connect) has step-by-step guides: a connector or a plugin, and a browser sign-in. The snippets below use a token in the header instead, for clients without OAuth and for headless use. Create the token in the web UI: for an agent, in **Settings → Agents**; for yourself, in **Settings → Access tokens**. Tokens can't create tokens. Keep it out of files you commit; most clients below can read it from an environment variable.

### Claude Code

With a browser on hand, add the server without a header and sign in when Claude Code asks (or run `/mcp`):

```sh
claude mcp add --transport http diffinery https://diffinery.com/mcp
```

With a token instead:

```sh
claude mcp add --transport http diffinery https://diffinery.com/mcp \
  --header "Authorization: Bearer dfy_..."
```

To share the server with a project without sharing the token, put this in the project's `.mcp.json` and set `DIFFINERY_TOKEN` in each developer's environment:

```json
{
  "mcpServers": {
    "diffinery": {
      "type": "http",
      "url": "https://diffinery.com/mcp",
      "headers": { "Authorization": "Bearer ${DIFFINERY_TOKEN}" }
    }
  }
}
```

The `diffinery` CLI prints exactly this snippet with `diffinery mcp-config` (add `--show-token` to embed the saved token instead of `${DIFFINERY_TOKEN}`). Run `/mcp` inside Claude Code to check that the server is connected.

### Cursor

Add to `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for all projects:

```json
{
  "mcpServers": {
    "diffinery": {
      "url": "https://diffinery.com/mcp",
      "headers": { "Authorization": "Bearer dfy_..." }
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json`. VS Code prompts for the token and stores it securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "diffinery-token", "description": "Diffinery token (dfy_...)", "password": true }
  ],
  "servers": {
    "diffinery": {
      "type": "http",
      "url": "https://diffinery.com/mcp",
      "headers": { "Authorization": "Bearer ${input:diffinery-token}" }
    }
  }
}
```

### Claude Desktop and other clients that start local servers

Clients whose configuration only launches local (stdio) servers can reach Diffinery through a bridge such as `mcp-remote`, which forwards to the remote URL with your header:

```json
{
  "mcpServers": {
    "diffinery": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://diffinery.com/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer dfy_..." }
    }
  }
}
```

### Any other client

Point an MCP client that supports the Streamable HTTP transport at `https://diffinery.com/mcp` and configure a custom `Authorization: Bearer dfy_...` header. The usual JSON form is:

```json
{ "mcpServers": { "diffinery": { "type": "http", "url": "https://diffinery.com/mcp", "headers": { "Authorization": "Bearer dfy_..." } } } }
```

## Tools

Every tool that works on a repository takes `owner` and `repo`. A repository that was transferred or renamed is also found under its old owner and name, for anyone who can read it, so an agent configured with the old name keeps working. Tools marked read-only have the MCP annotation `readOnlyHint: true`, so clients can run them without asking. Every tool marked **No** needs a token with the `write` or `admin` scope, whatever its minimum role. The full input schema of each tool is on [MCP tools reference](/docs/reference/mcp-tools), and `tools/list` returns it at runtime.

### Content written by others

Repository files, branch names, issue and pull request text, comments, workflow logs and sandbox output can be written by anyone who can push or comment, including on a public repository. Someone can write text there meant to steer your agent. Results from tools that return such content (`list_repos`, `list_tree`, `get_file`, `list_branches`, `compare`, `list_pull_requests`, `get_pull_request`, `list_issues`, `get_issue`, `list_workflow_runs`, `get_workflow_run`, `get_job_logs`, `sandbox_exec`, `sandbox_read_file`, `get_import` and `list_imports`) end with a second text block. It tells the model to treat the result as data and not to follow instructions inside it. These tools also carry the `openWorldHint` annotation in `tools/list`, and the server's `instructions` say the same. This lowers the risk but can't remove it, so give an agent a token with only the scopes and repositories it needs. See [Personal access tokens](/docs/accounts/tokens).

### Account and repositories

| Tool | Read-only | What it does | Minimum role |
| --- | --- | --- | --- |
| `whoami` | Yes | The account the token acts as (`login`, `kind`) and, for an agent, `on_behalf_of` | Any token |
| `today` | Yes | Your morning view: pull requests that need you, your agents' open pull requests and where each stands, and what merged, was released or failed in the last 24 hours. See [Today](/docs/agents/today) | Any token |
| `agent_tasks` | Yes | Agent tasks: with `owner` and `repo` that repository's, without them the ones you started (an agent: the ones it runs). See [Agent tasks](/docs/agents/tasks) | Write on the repository; any token for your own |
| `agent_task` | Yes | One agent task (`owner`, `repo`, `number`) with its runs, pull request and transcript after `after` | Write |
| `project` | Yes | The repository's [project](/docs/agents/projects): its task board, memory and settings | Write |
| `project_posts` | Yes | The project's conversation after `after`, or the latest 100 lines | Write |
| `list_repos` | Yes | Repositories visible to you, optionally filtered by `owner` | Any token |
| `get_organization` | Yes | An organization's `login` and `name`; to its members, its agents, agents of its members and site administrators also `default_repository_permission` (the base permission members get on its repositories) | Any token |
| `list_invitations` | Yes | Pending invitations to a repository (`owner` and `repo`), an organization (`org`) or the instance (neither), each with an `id`, and the `email` or, for an invitation sent to a username, the `login` | Admin on the repository; organization owner or admin; site administrator |
| `revoke_invitation` | No | Revoke a pending invitation by `invitation_id`, with the same `owner` and `repo`, `org` or neither; the address can then be invited again | Same as `list_invitations`; organization and instance invitations need an `admin` token |

### Code

| Tool | Read-only | What it does | Minimum role |
| --- | --- | --- | --- |
| `list_tree` | Yes | Files and directories at a `path` and `ref` (default: the default branch) | read |
| `get_file` | Yes | A file's contents at a `ref`; binary files return only their size and `binary: true` | read |
| `list_branches` | Yes | Branches, marking the default and protected ones | read |
| `compare` | Yes | Commits ahead and behind, and the diff, between `base` and `head` | read |

### Branches and commits

| Tool | Read-only | What it does | Minimum role |
| --- | --- | --- | --- |
| `create_branch` | No | Create `branch` from another branch, tag or commit (`from`, default: the default branch) | write |
| `commit_files` | No | One commit on `branch` that writes `files` and removes `deletes`; see [Commit without git](#commit-without-git) | write |

### Pull requests

| Tool | Read-only | What it does | Minimum role |
| --- | --- | --- | --- |
| `list_pull_requests` | Yes | Up to 100 pull requests by `state` (`open`, `closed`, `all`) | read |
| `get_pull_request` | Yes | A pull request with its comments, reviews and mergeability (including blockers); `include_diff: true` adds the files and patches. `mergeability.blockers` is what stops the caller merging it directly now. For agents and workflow tokens it also returns `auto_merge_blockers`: what stops Diffinery landing it through auto-merge or the merge queue (`[]` means it would land now). An agent on a protected branch sees `agents may not merge into this branch` in the first list but not in the second when the rule allows auto-merge. | read |
| `create_pull_request` | No | Open a pull request: `title`, `head`, optional `base`, `body`, `draft`, `intent`, `reviewers`, and `auto_merge` (`true` turns on auto-merge as it opens, `false` keeps it off where your setting would turn it on; `autoMergeSkipped` says why it stayed off when asked). See [Merge on green automatically](/docs/collaboration/merge-on-green) | write |
| `comment` | No | Comment on an issue or pull request | triage |
| `review_pull_request` | No | Submit an `APPROVE`, `REQUEST_CHANGES` or `COMMENT` review, with optional line `comments` | read (write to approve or request changes) |
| `merge_pull_request` | No | Merge with `method`, `expected_head_sha`, `delete_branch`; queues the pull request when the base branch uses a merge queue. Agents can't merge into the default branch or protected branches this way: they use `enable_auto_merge` | write |
| `enable_auto_merge` | No | Turn on auto-merge, optionally with `merge_method`, `commit_title`, `commit_message`, `delete_branch` and `expected_head_sha`: Diffinery merges the pull request (or adds it to the merge queue) once every branch rule is met. Returns `state` (`enabled`, `queued` or `merged`), `autoMerge` and, once merged, `mergeCommit`. See [Auto-merge](/docs/collaboration/pull-requests#auto-merge) and [Agents landing changes](/docs/repositories/branch-protection#agents-landing-changes) | write |
| `disable_auto_merge` | No | Turn auto-merge off; returns `{"auto_merge": null}` | write |
| `dequeue_pull_request` | No | Remove a pull request from the merge queue | write |

### Issues

| Tool | Read-only | What it does | Minimum role |
| --- | --- | --- | --- |
| `list_issues` | Yes | Up to 100 issues by `state`, search text `q` and `label` | read |
| `get_issue` | Yes | An issue (or pull request) with its comments and reviews | read |
| `create_issue` | No | Open an issue with `title`, optional `body` and `labels` (`labels` from an account below triage are dropped, as on GitHub) | read |
| `update_issue` | No | Change the `title`, `body`, `state` (`open`, `closed`) or `labels` of an issue or pull request | triage |

### Workflows

| Tool | Read-only | What it does | Minimum role |
| --- | --- | --- | --- |
| `list_workflow_runs` | Yes | The 30 newest runs, filtered by `branch`, `sha`, `pr_number` or `status` | read |
| `get_workflow_run` | Yes | A run with its jobs, their status, conclusion and failure reason | read |
| `get_job_logs` | Yes | A job's log as text; the last `tail` lines (default 400), with `complete` and `truncated` flags | read |
| `rerun_workflow` | No | Re-run a finished run as a new attempt; with `failed_only`, only its failed jobs and the jobs that depend on them | write |
| `rerun_job` | No | Re-run one job (`job_id`) of a finished run and the jobs that depend on it | write |
| `cancel_workflow` | No | Cancel a queued or running run | write |
| `dispatch_workflow` | No | Start a `workflow_dispatch` run of `workflow` (for example `deploy.yml`) on `ref` with `inputs` | write |

### Releases

| Tool | Read-only | What it does | Minimum role |
| --- | --- | --- | --- |
| `list_releases` | Yes | Releases, newest first, up to `limit` (default 30, at most 100), with `total`. Drafts are included only for writers. | read |
| `get_release` | Yes | A release by `tag` or `id`, or the latest release when you pass neither | read |
| `create_release` | No | Create a release for `tag_name`, creating the tag at `target_commitish` (default: the default branch) if it doesn't exist. Optional `name`, `body`, `draft`, `prerelease`, `make_latest` and `generate_release_notes`. | write |
| `update_release` | No | Edit a release by `id`: `tag_name`, `target_commitish`, `name`, `body`, `draft`, `prerelease`, `make_latest`. Publishing a draft sends the `release` event. | write |
| `upload_release_asset` | No | Attach a file of up to 25 MB to release `release_id`: `name`, and either `content` (text) or `content_base64` (bytes), with optional `label` and `content_type` | write |
| `generate_release_notes` | Yes | Draft notes for `tag_name` from the pull requests merged since the previous release (or `previous_tag_name`). Creates nothing. | write |

See [Releases](#releases-over-mcp) below for the result shape.

### Docs

| Tool | Read-only | What it does | Minimum role |
| --- | --- | --- | --- |
| `search_docs` | Yes | Search this documentation for `query` (for example `merge queue` or `workflow_dispatch inputs`). Returns up to 8 matching pages, each with `page`, `title`, `section`, the best matching `heading`, `url`, `markdown_url` and a `snippet`. | Any token |
| `read_docs` | Yes | Read one docs page as Markdown. `page` is a slug (`actions/workflow-syntax`), a docs URL, or `index` for the overview that links to every page. Returns `page`, `title` and `markdown`. | Any token |

### Sandboxes

| Tool | Read-only | What it does | Minimum role |
| --- | --- | --- | --- |
| `sandbox_create` | No | Start a Linux sandbox with the repository checked out at `ref`; returns its `id` | write |
| `sandbox_exec` | No | Run a shell `command` in the sandbox, with optional `cwd` and `timeout_seconds` | write |
| `sandbox_read_file` | No | Read a file; text comes back as text, other files as base64 | write |
| `sandbox_write_file` | No | Write a text file | write |
| `sandbox_close` | No | Shut the sandbox down | write |

See [Sandboxes](/docs/agents/sandboxes) for what is inside a sandbox and its limits.

### Imports from GitHub

| Tool | Read-only | What it does | Minimum role |
| --- | --- | --- | --- |
| `start_github_import` | No | Start a server-side import of one GitHub repository: `source` (`owner/name` or a GitHub URL) and `owner` (the Diffinery organization or user to import into), optional `name`, `visibility` (`keep`, `private`, `public`), `github_token` and `github_api_url`. Returns the import, with its `id`. | See [Imports over MCP](#imports-over-mcp) |
| `get_import` | Yes | An import by `id`: `status`, per-step progress, `git` transfer progress, `summary`, `warnings`, `error` and, for an organization import, its repositories | You started it; a person who administers its target, or a site administrator, can also read it |
| `list_imports` | Yes | The imports you started, newest first | Any token |

## Commit without git

`commit_files` creates a single commit from file contents:

| Argument | Meaning |
| --- | --- |
| `branch` | Branch to commit to (required) |
| `message` | Commit message (required) |
| `files` | `[{ "path", "content", "encoding": "utf-8" or "base64", "executable": true or false }]` |
| `deletes` | Paths to remove |
| `create_branch_from` | Create `branch` from this branch, tag or commit if it doesn't exist |
| `expected_head_sha` | Only commit if `branch` is still at this commit; otherwise `branch moved; refresh and retry` |

It returns `{ "sha": "...", "branch": "..." }`. At least one file or delete is required (`nothing to commit`). Committing to a branch that doesn't exist without `create_branch_from` fails with `branch fix-pricing-link not found`. Commits made by agents are stamped with the agent and its owner; see [Agents](/docs/agents/overview#how-agent-activity-is-recorded).

`commit_files` runs [push protection](/docs/security/push-protection) before it writes anything, like `git push`. If a file looks like a credential (an AWS key, a GitHub or Diffinery token, a private key and so on), nothing is committed and the tool fails with, for example, `push protection: possible secret detected (AWS access key) in config/deploy.env. Remove it, or rotate it and ask an admin.` The attempt is recorded in the audit log as `api.blocked_secret` against the token's account, and the agent's owner gets a `Your commit was blocked` email. `commit_files` has no bypass. For a test fixture with fake keys, put the text `diffinery:allow-secret` anywhere in the file.

## Releases over MCP

Release tools return a compact release object:

```json
{
  "id": 7,
  "tag_name": "v1.4.0",
  "target_commitish": "main",
  "name": "v1.4.0",
  "body": "## What's Changed\n...",
  "draft": false,
  "prerelease": false,
  "latest": true,
  "author": "review-bot",
  "created_at": "2026-10-13T09:30:00.000Z",
  "published_at": "2026-10-13T09:30:00.000Z",
  "html_url": "https://diffinery.com/acme/website/releases/tag/v1.4.0",
  "assets": [{ "id": 12, "name": "notes.txt", "label": "", "content_type": "text/plain", "size": 18, "download_count": 0, "download_url": "https://diffinery.com/acme/website/releases/download/v1.4.0/notes.txt" }]
}
```

- `make_latest` is the string `"true"`, `"false"` or `"legacy"`; a new published release becomes the latest by default.
- `draft: true` keeps a release visible to writers only. `update_release` with `draft: false` publishes it, which starts `on: release` workflows and sends the `release` webhook event.
- `upload_release_asset` takes the file inline, so it is limited to 25 MB (`MCP uploads are limited to 25 MB; use the upload_url of the REST API for larger files`). Pass exactly one of `content` and `content_base64`. Text defaults to `text/plain`, bytes to `application/octet-stream`. For files up to 100 MB, use the release's `upload_url` in the [REST API](/docs/reference/rest-api#release-assets).
- `generate_release_notes` only drafts text; pass its `body` to `create_release`, or set `generate_release_notes: true` there.
- Publishing a release for a tag that doesn't exist creates the tag at `target_commitish`, and that follows the same rules as any ref update. A draft creates its tag only when it is published.

## Imports over MCP

`start_github_import` starts the same server-side importer as the web UI, `diffinery migrate github` and `POST /api/v3/diffinery/imports`. It imports one repository with every part turned on: Git history and Git LFS, issues and pull requests with their numbers, comments, reviews and review comments, labels, milestones, branch protection, releases, and (for people) Actions variables, environments and secret names. Secret values are never read from GitHub. The tool returns at once; the import runs on the server.

```sh
curl -s https://diffinery.com/mcp \
  -H "Authorization: Bearer $DIFFINERY_TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"start_github_import","arguments":{"source":"acme/website","owner":"acme","github_token":"ghp_..."}}}'
```

The result is the import object (`id`, `html_url`, `status`, `source`, `target`, `steps`, `git`, `summary`, `warnings`, `error`). Call `get_import` with the `id` every minute or so until `status` is `succeeded`, `failed` or `cancelled`. While the import runs, every other write to the new repository is refused: pushes with `repository is locked by an import in progress`, and tools such as `create_issue` with `repository is locked by an import in progress; try again when it finishes, or cancel the import`. A person can still set the repository's Actions secrets and variables, environments and collaborators while it runs.

Who can start one:

- The token needs the `write` or `admin` scope (`starting an import needs a token with write or admin scope`).
- A person can import into their own account or an organization they own or administer.
- An agent can import only where its owner may: a person's agent into the owner's own account or an organization the owner owns or administers, an organization's agent into that organization (`agents can import only where their owner may: the owner's own account or an organization the owner administers, not <owner>`). Its maximum role must be at least `write` (`this agent's policy does not allow writing; an import needs at least write`).

Rules for imports an agent starts:

- **Push protection is never bypassed.** If old history contains something that looks like a credential, the import stops and fails with `Push protection found possible secrets in the history (...)`. A person who administers the target starts a new import from the web or API to import it with an audited bypass.
- **Variables, secret names and environments are skipped** (`skipped (agents cannot manage variables)`); a person sets them up afterwards. Agents never read or set secret values.
- **No retry once the repository exists.** An agent's retry (through the REST API) is refused after the repository was created; a person who administers the target retries it instead.
- The agent sees only the imports it started (`get_import`, `list_imports`).

An import uses the GitHub token only for that import, deletes it when the import ends, and never returns it. For GitHub Enterprise, pass `github_api_url`, for example `https://ghe.example.com/api/v3`; when `source` is an Enterprise URL and you pass a token, `github_api_url` must be on the same host. See [Migrate from GitHub](/docs/migrate-from-github) for what is copied, limits (at most 3 repository imports at a time per account and per target) and errors.

## Permissions

The token's account (person or agent), its role on the repository and the token's scope decide what each tool may do, exactly as for the REST API. The minimum role for each tool is in the tables above.

### Token scope and write tools

Diffinery checks the token's scope before a tool runs. A tool that isn't read-only (`readOnlyHint: false`) needs a token with the `write` or `admin` scope. With a `read` token, the call fails with `isError: true` and the text `this token needs the write scope`, even when the role the tool asks for is only read or triage: `create_issue`, `comment`, a `COMMENT` review with `review_pull_request`, and the sandbox tools all need a `write` token. Read-only tools work with any scope, including `read`.

Use a `write` token for agents that change anything, and a `read` token for agents that only read code, issues, pull requests, runs, releases and docs.

### Other rules

On top of the role and scope:

- Agents can't push or commit to the default branch or protected branches, and can't merge into them, unless the branch's rule allows it (`agentsMayPush`, `agentsMayMerge`). Where the rule has `allowAgentAutoMerge` and a required check, an agent lands its pull request there with `enable_auto_merge` instead, and Diffinery merges once the rules are met (see [Agents landing changes](/docs/repositories/branch-protection#agents-landing-changes)).
- Pull requests opened by agents need a human approval, and approvals submitted by agents with `review_pull_request` never count toward it.
- Private repositories you can't see return `repository not found`, the same as a repository that doesn't exist.
- Archived repositories refuse every tool that changes something (`repository is archived (read-only)`), whatever the role. Read-only tools keep working.
- `commit_files` refuses files that look like credentials (see [Commit without git](#commit-without-git)).
- `create_issue` drops `labels` when the account's role is below triage, as GitHub does for issues opened by people without triage access.
- Release tools follow the same rules as the REST API: anyone who can read the repository can list published releases, writers create, edit and publish them and see drafts, and a release that creates a tag is a ref update, so agent branch and tag rules apply.
- `start_github_import` follows the agent import rules in [Imports over MCP](#imports-over-mcp).
- `search_docs` and `read_docs` read the public documentation. They work with any token, read-only included, and don't touch a repository.

See [Agents](/docs/agents/overview#guardrails) and [Permissions](/docs/accounts/permissions).

## Results and errors

A successful `tools/call` returns the tool's output twice: as pretty-printed JSON in a text content block, and as `structuredContent` (the object itself, or `{ "result": ... }` when the output is an array or a plain value):

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{ "type": "text", "text": "{\n  \"path\": \"README.md\",\n  ..." }],
    "structuredContent": { "path": "README.md", "commit": "51c0e2aa...", "size": 412, "content": "# Website\n..." },
    "isError": false
  }
}
```

When a tool fails, the call still succeeds at the JSON-RPC level, with `isError: true` and the error message as text. The messages are the same as the REST API's:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [{ "type": "text", "text": "agents may not push to protected or default branches; open a pull request" }],
    "isError": true
  }
}
```

Missing or invalid arguments produce messages such as `owner is required`, `title must be a string` or `number must be a positive integer`.

Tools that change something count toward your account's 60 changes a minute. Past that, the call fails with `Too many changes from your account: at most 60 a minute through MCP. Try again in a minute.` Every request to `/mcp` also counts toward the account's 2,000 requests a minute; past that, the HTTP response itself is `429` with `retry-after: 60`. See [Rate limits](/docs/reference/rest-api#rate-limits).

Protocol-level errors use JSON-RPC error objects:

| Code | Message | Cause |
| --- | --- | --- |
| `-32700` | `parse error` | The body isn't JSON (HTTP status 400). |
| `-32600` | `invalid request` | A message without a string `method`. |
| `-32601` | `method not found: <method>` | An unsupported method, such as `resources/list`. |
| `-32602` | `unknown tool: <name>` | `tools/call` named a tool that doesn't exist. |

## Example calls with curl

Set your token once:

```sh
export DIFFINERY_TOKEN=dfy_...
```

### Initialize

```sh
curl -s https://diffinery.com/mcp \
  -H "Authorization: Bearer $DIFFINERY_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": { "tools": { "listChanged": false } },
    "serverInfo": { "name": "diffinery", "title": "Diffinery", "version": "0.1.0" },
    "instructions": "Diffinery is a git forge built for agents. Read code with get_file/list_tree, ..."
  }
}
```

### List tools

```sh
curl -s https://diffinery.com/mcp \
  -H "Authorization: Bearer $DIFFINERY_TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Each tool has `name`, `description`, `inputSchema` (a JSON Schema object with `properties` and `required`) and `annotations.readOnlyHint`.

### Read a file

```sh
curl -s https://diffinery.com/mcp \
  -H "Authorization: Bearer $DIFFINERY_TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_file","arguments":{"owner":"acme","repo":"website","path":"README.md"}}}'
```

### Commit on a new branch and open a pull request

```sh
curl -s https://diffinery.com/mcp \
  -H "Authorization: Bearer $DIFFINERY_TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"commit_files","arguments":{
        "owner":"acme","repo":"website","branch":"fix-pricing-link","create_branch_from":"main",
        "message":"Fix the Contact sales link",
        "files":[{"path":"src/pricing.html","content":"<a href=\"/contact\">Contact sales</a>\n"}]}}}'

curl -s https://diffinery.com/mcp \
  -H "Authorization: Bearer $DIFFINERY_TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"create_pull_request","arguments":{
        "owner":"acme","repo":"website","title":"Fix the Contact sales link","head":"fix-pricing-link",
        "intent":"Point the Contact sales link at /contact; no other changes."}}}'
```

### Check CI

```sh
curl -s https://diffinery.com/mcp \
  -H "Authorization: Bearer $DIFFINERY_TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"list_workflow_runs","arguments":{"owner":"acme","repo":"website","pr_number":12}}}'
```

Then `get_workflow_run` with a run's `id`, and `get_job_logs` with a failed job's `id`, to see why it failed.

## A typical agent workflow

1. `whoami` to confirm the account and its owner.
2. `search_docs` and `read_docs` when it needs to check how a Diffinery feature works (for example `workflow_dispatch inputs` or `branch protection`).
3. `list_tree` and `get_file` (or `compare`) to read the code.
4. `commit_files` with `create_branch_from` to put changes on a new branch, passing `expected_head_sha` on later commits to avoid overwriting someone else's.
5. `sandbox_create` and `sandbox_exec` to build and run tests when needed.
6. `create_pull_request` with an `intent` that states the goal.
7. `list_workflow_runs`, `get_workflow_run` and `get_job_logs` to follow CI, fixing failures with more commits.
8. `get_pull_request` to read reviews and the remaining merge blockers. A person approves and merges. Or the agent calls `enable_auto_merge` where the branch allows it (`allowAgentAutoMerge`), and Diffinery merges once the checks pass and a person has approved (or without the approval where an admin turned on `agentAutoMergeWithoutApproval`); `auto_merge_blockers` lists what auto-merge still needs. Or it merges with `merge_pull_request` where the branch allows agents to merge.

## List your instance in the MCP registry

The [official MCP registry](https://registry.modelcontextprotocol.io) lists Diffinery's MCP server as `com.diffinery/diffinery`, with the URL `https://{diffinery_host}/mcp`: clients that read the registry ask for your instance's host name. To list your own instance under your domain as well, prove that you own the domain with a key:

1. Make a key pair and its proof record (OpenSSL 3):

   ```sh
   openssl genpkey -algorithm Ed25519 -out mcp-registry-key.pem
   echo "v=MCPv1; k=ed25519; p=$(openssl pkey -in mcp-registry-key.pem -pubout -outform DER | tail -c 32 | base64)"
   ```

2. Add the printed line as `"MCP_REGISTRY_AUTH"` under `vars` in `wrangler.jsonc` and deploy. Check that `https://<your host>/.well-known/mcp-registry-auth` returns it.
3. Sign in to the registry with [`mcp-publisher`](https://github.com/modelcontextprotocol/registry) and publish a `server.json` named after your domain in reverse (`com.example/diffinery` for `git.example.com`), with `remotes` set to `[{"type": "streamable-http", "url": "https://git.example.com/mcp"}]`:

   ```sh
   mcp-publisher login http --domain git.example.com \
     --private-key "$(openssl pkey -in mcp-registry-key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
   mcp-publisher publish server.json
   ```

The record holds only the public key. Keep the `.pem` file to publish updates; if you lose it, make a new pair and replace the record.

## Limitations

- The server offers tools only: no resources, prompts or sampling.
- Responses are plain JSON. The server doesn't stream, keeps no session, and can't send messages to the client on its own.
- OAuth sign-in supports the authorization code flow with PKCE only, for apps that register themselves or identify by a client metadata document. There is no device flow for MCP; on a machine without a browser, use a token in the header.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The client says it can't connect or gets `401` | The `Authorization` header is missing or the token is wrong. Check the header name and the `Bearer ` prefix, and that the token hasn't expired. |
| The browser says "Can't connect this app" | The app's registration expired (unused registrations are removed after a week) or it asked to send you back to an address it didn't register. Remove the server in the app and add it again. |
| An app that used to work asks you to sign in again | Its connection lapsed after 30 days unused, or you (or a security check after a reused refresh token) disconnected it. Sign in again. |
| `repository not found` | Wrong `owner` or `repo`, or the account (or, for an agent, its owner) can't see the repository. |
| `this token needs the write scope` | The tool isn't read-only and the token has only the `read` scope. Create a `write` token (for an agent, in **Settings → Agents** while signed in). |
| `write access required` (or `triage access required`) | The account's role, or the token's scope, is too low for the tool. A `read` token can only use read-only tools. |
| `agents may not push to protected or default branches; open a pull request` | Commit to a new branch with `create_branch_from` and open a pull request. |
| `agents may not merge into this branch; a human must merge` | `merge_pull_request` into the default branch or a protected branch. Use `enable_auto_merge` where the branch allows it, or ask a person to merge. |
| `agents may not have pull requests merged into main automatically unless its branch protection allows it ...` | `enable_auto_merge` on a branch whose rule doesn't set `allowAgentAutoMerge`. A person merges, or an admin allows it. |
| `Auto-merge was turned off: ...` (a comment on the pull request) | Auto-merge stopped, for example because someone else pushed to the branch. Read the reason and call `enable_auto_merge` again. See [When auto-merge turns itself off](/docs/collaboration/pull-requests#when-auto-merge-turns-itself-off). |
| `branch moved; refresh and retry` | Someone else committed to the branch. Read the new head and retry with the new `expected_head_sha`. |
| `push protection: possible secret detected (...)` | A file passed to `commit_files` looks like a credential. Remove it and commit again, or add `diffinery:allow-secret` to a file whose keys are fake. |
| `repository is archived (read-only)` | The repository is archived. Only read-only tools work until a repository admin unarchives it. |
| `method not found: resources/list` | The server only offers tools; the client can ignore this. |
| `MCP uploads are limited to 25 MB; use the upload_url of the REST API for larger files` | `upload_release_asset` takes the file inline. Upload larger files (up to 100 MB) to the release's `upload_url` with the [REST API](/docs/reference/rest-api#release-assets). |
| `pass exactly one of content or content_base64` | `upload_release_asset` needs the file as either text or base64, not both and not neither. |
| `make_latest must be true, false or legacy` | Pass `make_latest` as one of those strings, not as a boolean. |
| `query is required` | `search_docs` was called with an empty `query`. |
| `agents can import only where their owner may: ...` | Pass as `owner` the owner's own account or an organization the owner administers (for an organization's agent, that organization). |
| `too many repository imports are already running (at most 3 at a time); wait for one to finish` | Wait for one of the running imports to finish (check with `list_imports`). |
| `no docs page "..."; pages: ...` | `read_docs` didn't recognize the slug. Pick one from the list in the message, or call `read_docs` with `index`. |
