---
title: Sandboxes
description: Start an isolated Linux container with a repository checked out, run commands and read and write files in it over MCP or the REST API.
---

A sandbox is a short-lived Linux container with a repository already cloned, which you drive over MCP or the REST API: run shell commands, read and write files, and push from it with git. Agents use sandboxes to build and test changes without a machine of their own; people can use them the same way from scripts.

## What a sandbox is

- **A container per sandbox.** Each sandbox is its own Cloudflare Container, isolated from other sandboxes and from workflow jobs. It has outbound internet access (only HTTP and HTTPS on instances that set [`EGRESS=web`](/docs/self-hosting/configuration#egress)).
- **The repository, checked out.** On start, the sandbox clones the repository and checks out the ref you asked for (the default branch if you don't say) into `/workspace/repo`.
- **The hosted runner image.** Sandboxes run the same Ubuntu 24.04 image as hosted workflow jobs, so the same toolchains are there. See [What's inside](#whats-inside).
- **An HTTP API, not a shell session.** Each command runs on its own in `bash -c`, so `cd` and `export` don't carry over to the next command; use `cwd` and `env` instead. Files stay between commands.
- **Tied to its creator.** Only the account that created a sandbox (or a repository admin) can use it, and git inside it acts as that account.
- **Not the sandboxes of [agent tasks](/docs/agents/tasks).** Those run a person's model access, so no sandbox call reaches them, for anyone.

## Lifecycle

1. **Create.** `sandbox_create` (MCP) or `POST /repos/{owner}/{repo}/diffinery/sandboxes` (REST) starts the container and returns the sandbox `id` once its server is listening. The clone runs in the background. Creating a sandbox usually takes seconds, but the first sandbox on a host after Diffinery is deployed has to pull the container image first, which can take a few minutes. The call waits up to 3 minutes; if the container still hasn't started, it fails with `503 the sandbox container did not start; try again`, and the sandbox is marked failed. Retry the call.
2. **Use.** `exec`, `read` and `write` calls wait for the clone to finish before running, so the first call can take a little longer.
3. **Idle stop.** A sandbox that gets no calls for 30 minutes stops. Its files are not kept; start a new sandbox to continue.
4. **Close.** `sandbox_close` (MCP) or `POST .../sandboxes/{id}/close` (REST) shuts it down and revokes its git credentials. Close sandboxes when you are done.

Commit and push anything you want to keep before the sandbox stops or closes.

## Permissions

- Creating and using a sandbox needs **write** access to the repository. A `read`-scoped token can't create one.
- Each call on a sandbox is allowed for the account that created it and for repository admins; anyone else gets `not your sandbox`.
- Inside the sandbox, git authenticates as the creator, with the role the creator had when the sandbox was created, capped at write (even if the creator is an admin) and at the creator's current role. The sandbox's credentials stop working 24 hours after it starts, when it is closed, or as soon as the creator's account is disabled or loses access to the repository.
- The sandbox's git credential (a `dst_` token) also lets git clone and fetch other public repositories, for example public submodules, but no other private repository. Use a token of your own inside the sandbox if you need one.
- Job and sandbox tokens can't create sandboxes (`403 job and sandbox tokens can't start sandboxes`). Pushes from the sandbox follow the same rules as any push: branch protection, push protection (secret scanning) and, for agents, the [agent guardrails](/docs/agents/overview#guardrails). An agent can't push to the default branch from a sandbox either.
- Archived repositories can't have sandboxes: starting one, and every call on an existing one (running commands, reading or writing files, closing it), gets `403 repository is archived (read-only)`. A sandbox left running when its repository is archived stops on its own after 30 idle minutes.

## What's inside

| Item | Details |
| --- | --- |
| OS | Ubuntu 24.04 (linux/amd64), running as root |
| Working directory | `/workspace/repo`, the clone of the repository |
| Node.js | 22 (22.22.0), with npm, and pnpm 10.28.0 and yarn 1.22.22 through corepack |
| Python | Python 3 with `pip` and `venv` (`python` points to `python3`); `pip install` works system-wide (`PIP_BREAK_SYSTEM_PACKAGES=1`) |
| Build tools | `build-essential` (gcc, g++, make), `pkg-config` |
| Git | `git` and `git-lfs` |
| Utilities | `curl`, `jq`, `zip`, `unzip`, `xz-utils`, `tar`, `gzip`, `gnupg`, `openssh-client`, `ca-certificates` |
| Docker | Docker Engine with the buildx and compose plugins; the daemon starts the first time `docker` runs |

Install anything else with `apt-get`, `npm`, `pip` and so on; the sandbox has internet access (only HTTP and HTTPS on instances that set [`EGRESS=web`](/docs/self-hosting/configuration#egress)).

Environment variables available to commands:

| Variable | Value |
| --- | --- |
| `CI` | `true` |
| `DIFFINERY`, `DIFFINERY_SANDBOX` | `true` |
| `DIFFINERY_CLONE_URL` | `https://diffinery.com/acme/website.git` |
| `DIFFINERY_REF` | The ref the sandbox started on |
| `DIFFINERY_API_URL` | `https://diffinery.com` |
| `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME` | The creator's login, for example `review-bot` |
| `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL` | `<login>@users.noreply.diffinery.com` |

The sandbox's own credentials are not in the environment. The clone's git configuration holds them so that `git fetch` and `git push` work, and they are replaced with `***` wherever they appear in command output.

## Create a sandbox

### Create over MCP

```json
{ "name": "sandbox_create", "arguments": { "owner": "acme", "repo": "website", "ref": "fix-pricing-link" } }
```

The result is `{ "id": "...", "ref": "fix-pricing-link" }`. `ref` can be a branch, a tag or a commit SHA.

### Create with the REST API

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/diffinery/sandboxes \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"ref": "fix-pricing-link"}'
```

```json
{ "id": "SANDBOX_ID", "ref": "fix-pricing-link" }
```

The response is `201 Created`. An unknown ref fails with `422 unknown ref`. If the container doesn't start within about 3 minutes, the response is `503` with `{"message": "the sandbox container did not start; try again"}`; nothing is left running, so create the sandbox again. Give the request a client timeout of at least 3 minutes, for example `curl --max-time 240`.

## Run commands

### Run commands over MCP

```json
{ "name": "sandbox_exec", "arguments": { "owner": "acme", "repo": "website", "sandbox_id": "SANDBOX_ID", "command": "npm ci && npm test", "timeout_seconds": 900 } }
```

| Argument | Meaning |
| --- | --- |
| `command` | Shell command, run with `bash -c` (required) |
| `cwd` | Directory to run in: relative to `/workspace/repo`, or absolute (default `/workspace/repo`) |
| `timeout_seconds` | Time limit (default 600, that is 10 minutes) |

### Run commands with the REST API

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/diffinery/sandboxes/SANDBOX_ID/exec \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"cmd": "npm test -- --reporter=dot", "cwd": "packages/web", "env": {"NODE_ENV": "test"}, "timeoutMs": 900000}'
```

| Field | Meaning |
| --- | --- |
| `cmd` | Shell command (required) |
| `cwd` | Directory, relative to `/workspace/repo` or absolute |
| `env` | Extra environment variables, as an object of strings |
| `timeoutMs` | Time limit in milliseconds (default 600000) |

### Command results

```json
{
  "exitCode": 0,
  "stdout": "...",
  "stderr": "",
  "timedOut": false,
  "truncated": false,
  "durationMs": 48211
}
```

- `exitCode` is the command's exit status. A command that runs past its time limit is stopped (SIGTERM to the whole process tree, then SIGKILL 5 seconds later) and reports `exitCode: 124` with `timedOut: true`.
- `stdout` and `stderr` are each capped at 1 MiB; `truncated` is `true` when either was cut. Redirect large output to a file and read the parts you need.
- A non-zero exit code is a normal result, not an error: check `exitCode`.

The call returns when the command finishes, so keep each command within your client's request timeout. Start long-running processes in the background (`nohup ... &`) and poll for their output in later commands.

## Read and write files

Paths are relative to `/workspace/repo`, or absolute.

### Files over MCP

```json
{ "name": "sandbox_read_file", "arguments": { "owner": "acme", "repo": "website", "sandbox_id": "SANDBOX_ID", "path": "coverage/summary.txt" } }
{ "name": "sandbox_write_file", "arguments": { "owner": "acme", "repo": "website", "sandbox_id": "SANDBOX_ID", "path": "src/pricing.html", "content": "<a href=\"/contact\">Contact sales</a>\n" } }
```

`sandbox_read_file` returns `{ path, size, content }` with the content as text when the file is valid UTF-8, and otherwise `encoding: "base64"` with base64 content. `sandbox_write_file` writes `content` as UTF-8 text, creating parent directories as needed.

### Files with the REST API

The REST endpoints use base64 for file contents in both directions:

```sh
# Read: returns {"path": "/workspace/repo/coverage/summary.txt", "size": 812, "content": "<base64>"}
curl -X POST https://diffinery.com/api/v3/repos/acme/website/diffinery/sandboxes/SANDBOX_ID/read \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"path": "coverage/summary.txt"}'

# Write: content is base64; mode (optional) is a numeric file mode, for example 493 for 0755
curl -X POST https://diffinery.com/api/v3/repos/acme/website/diffinery/sandboxes/SANDBOX_ID/write \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d "{\"path\": \"scripts/check.sh\", \"content\": \"$(printf '#!/bin/sh\necho ok\n' | base64)\", \"mode\": 493}"
```

A write returns `{"ok": true, "path": "/workspace/repo/scripts/check.sh", "size": 18}`.

Errors raised inside the sandbox (a missing `cmd` or `path`, a missing file, a file that is too large) come back from the REST `exec`, `read` and `write` endpoints as `{"error": "..."}` with a `4xx` status, rather than the usual `{"message": "..."}`. Over MCP the same text is the tool's error message.

## Close a sandbox

- **MCP:** `sandbox_close` with `sandbox_id`. Returns `{ "closed": true }`.
- **REST API:** `POST /repos/{owner}/{repo}/diffinery/sandboxes/{id}/close`. Returns `204`.

Closing stops the container and revokes the sandbox's git credentials.

## Limits

| Limit | Value |
| --- | --- |
| Time to start | Up to 3 minutes (usually seconds), then `503` |
| Idle time before the sandbox stops | 30 minutes without calls |
| Default command time limit | 10 minutes (`timeout_seconds` or `timeoutMs` to change it) |
| Output per command | 1 MiB each for stdout and stderr |
| Request body (REST) | 64 MiB |
| File size for reads | 64 MiB |
| Git access from inside | The creator's role, at most write |
| Open sandboxes | 5 per account in each repository, until each is closed or its credentials expire after 24 hours (agent task sandboxes don't count) |

## Example: test a change and push it

An agent fixes a bug on a branch, runs the tests in a sandbox, and pushes a follow-up commit from it:

```text
1. sandbox_create   { owner: "acme", repo: "website", ref: "fix-pricing-link" }      -> { id: "SANDBOX_ID" }
2. sandbox_exec     { ..., command: "npm ci" }                                         -> exitCode 0
3. sandbox_exec     { ..., command: "npm test" }                                       -> exitCode 1, stderr shows a failing snapshot
4. sandbox_exec     { ..., command: "npm test -- -u && git add -A && git commit -m 'Update pricing snapshot' && git push origin HEAD:fix-pricing-link" }
5. sandbox_close    { ..., sandbox_id: "SANDBOX_ID" }
6. list_workflow_runs { owner: "acme", repo: "website", branch: "fix-pricing-link" }  -> CI runs on the new commit
```

Pushing to `fix-pricing-link` updates its pull request and starts its `pull_request` workflows as usual.

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| `write access required` | Sandboxes need write access, and a token with the `write` or `admin` scope. |
| `you have 5 open sandboxes in this repository, the most allowed; close one first` (`429`) | Close a sandbox you no longer need (`sandbox_close`, or the REST `close` action), or wait for one to expire. |
| `the sandbox container did not start; try again` (`503`) | The container didn't start within about 3 minutes, which can happen right after a deploy while the host pulls the image. Create the sandbox again. |
| `sandbox_create` or the REST call seems to hang | The first sandbox after a deploy can take a few minutes to start. Wait, and keep your client's timeout above 3 minutes. |
| `unknown ref` | The `ref` isn't a branch, tag or commit in the repository. |
| `sandbox not found` | Wrong `sandbox_id`, or a sandbox from another repository. |
| `not your sandbox` | Only the creator or a repository admin can use a sandbox. |
| `unknown sandbox action` | REST actions are `exec`, `read`, `write` and `close`. |
| `cmd` is required | The REST `exec` body needs `cmd` (MCP: `command`). |
| `cwd does not exist: ...` | The directory doesn't exist. If it is `/workspace/repo` itself, the clone or checkout failed; create a new sandbox with a valid ref. |
| `not found: ...` or `path is a directory` | Check the path; relative paths start at `/workspace/repo`. |
| `file too large` or `request body too large` | Files over 64 MiB can't be read or written through the API. Compress them, or push them with git. |
| `exitCode: 124` with `timedOut: true` | The command hit its time limit. Raise `timeout_seconds` or `timeoutMs`, or run it in the background. |
| `agents may not push to protected or default branches; open a pull request` (from `git push`) | Push to a feature branch and open a pull request. |
| Calls fail after a long pause | The sandbox stopped after 30 idle minutes. Create a new one. |
