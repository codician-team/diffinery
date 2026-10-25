---
title: Quickstart
description: Go from an invite to a working Diffinery repository: passkey, CLI sign-in, first push, workflow run, pull request, release and an AI agent over MCP.
updated: 2026-10-25
---

This guide takes you from an invite email to a repository with code, a passing workflow, a merged pull request, a first release and an AI agent connected over MCP. It takes about 15 minutes. Each step shows the web UI and, where it exists, the `diffinery` CLI and the REST API.

The examples use the organization `acme`, the repository `acme/website`, the user `diffy` and the agent `review-bot`, on an instance at `https://diffinery.com`. Replace them with your own names and your instance's address.

## What you need

- An account on a Diffinery instance, or an invite to one. To run your own instance, [deploy it](/docs/self-hosting/deploy) to your Cloudflare account and sign in as its first administrator.
- A browser that supports passkeys (current Chrome, Safari, Edge or Firefox).
- Git 2.26 or newer (`git --version`).
- For an instance someone else runs, an invite. An instance is invite-only by default: a site administrator, an organization owner or admin, or a repository admin sends it. On an instance with [open sign-up](/docs/accounts/passkeys-and-sign-in#open-sign-up), create an account at `/signup` instead.

## 1. Join with your invite and create a passkey

Diffinery has no passwords. You sign in to the web UI with a passkey, which your device, phone or password manager stores and unlocks with your fingerprint, face or screen lock.

1. Open the invite link from the email (`https://diffinery.com/invite/...`). Invite links work for 14 days.
2. On **Join Diffinery**, check the **Username** (filled in from your email address) and optionally add a **Display name**. Your repositories will live at `https://diffinery.com/<username>/...`.
3. Click **Create a passkey and join** and complete your browser's prompt.

You are signed in. If the invite was for an organization or a repository, you are now a member of it (or a collaborator on it) and land on its page; otherwise you land on your dashboard. Next time, sign in at `https://diffinery.com/login` with **Sign in with a passkey**.

> **Note:** Add a second passkey on another device, or keep the passkey in a password manager that syncs, under **Settings → Passkeys and sessions**. See [Passkeys and sign-in](/docs/accounts/passkeys-and-sign-in).

## 2. Install the CLI and sign in

Install the `diffinery` command-line client. On Linux and macOS:

```sh
curl -fsSL https://diffinery.com/install | bash
```

On Windows, in PowerShell:

```powershell
powershell -c "irm https://diffinery.com/install.ps1 | iex"
```

The script puts the CLI in `~/.diffinery` and adds it to your `PATH`. It uses your Node.js 22 or later when you have one, and otherwise installs its own copy. See [Install and sign in to the CLI](/docs/accounts/cli-sign-in).

Sign in through your browser and let Git (and the GitHub CLI, if you have it) use the same sign-in:

```sh
diffinery setup            # opens diffinery.com; click Authorize
diffinery whoami           # prints diffy
```

`diffinery setup` runs `diffinery login`, then `diffinery auth setup-git`, so `git clone`, `fetch` and `push` to diffinery.com use the sign-in, and `diffinery auth setup-gh` when `gh` is installed. With Claude Code installed, it also adds Diffinery's plugins to it ([CI status in Claude](/docs/connect/ci-status-in-claude)). You can run those steps yourself instead. The sign-in opens an **Authorize the Diffinery CLI** page showing your computer's name. Check it, keep **Write** access for this guide, and click **Authorize**. The terminal prints `✓ Logged in to https://diffinery.com as diffy`. No token to copy: the CLI gets its own, valid for 90 days and listed under **Settings → Access tokens**, and `diffinery logout` revokes it. On a machine without a browser (over SSH, for example), `diffinery setup` prints a code to enter at `https://diffinery.com/login/device` from any device instead.

Working in VS Code, Cursor or Windsurf? Install the editor extension with `curl -fsSL https://diffinery.com/install-editor | bash`, then use **Git: Clone → Clone from Diffinery**. See [Clone in VS Code, Cursor and other editors](/docs/repositories/clone-in-your-editor). In IntelliJ IDEA, PyCharm or another JetBrains IDE, install the Diffinery plugin and use **Get from Version Control → Diffinery**: see [Clone in JetBrains IDEs](/docs/repositories/clone-in-jetbrains-ides).

## 3. Tokens for scripts and CI

Scripts, CI and plain Git without the CLI authenticate with a personal access token.

1. Go to **Settings → Access tokens** (`https://diffinery.com/settings/tokens`).
2. Under **Create a token**, enter a **Name** (for example `ci`), keep **Expires in (days)** at 90 (1 to 366), and pick a **Scope**:

   | Scope | Allows |
   | --- | --- |
   | **Read** | Clone, fetch and view only. Every change is refused (`this token needs the write scope`). |
   | **Write** (default) | Push, issues, pull requests, releases, runs and creating repositories (up to the maintain role). |
   | **Admin** | Everything you can do, including repository settings and secrets, and creating organizations, agents, invitations and other tokens. |

   Leave **Restrict to repositories** empty, or pick the repositories the script needs.
3. Click **Create token** and copy the token. It starts with `dfy_` and is shown only once.

Diffinery emails you whenever a token is created on your account, including by a CLI sign-in. See [Personal access tokens](/docs/accounts/tokens).

The `DIFFINERY_TOKEN` and `DIFFINERY_URL` environment variables give the CLI a token without signing in, which is handy in CI; `diffinery login --token dfy_...` saves one. Without the CLI, Git asks for a username and password: enter any username and the token as the password.

## 4. Create a repository

Pick one of these.

**Web UI.** Click **+** in the header (or open `https://diffinery.com/new`). Choose the **Owner** (you or an organization such as `acme`), enter the **Repository name** `website`, an optional **Description**, the **Visibility** (**Private** is the default) and the **Default branch** (`main`). Click **Create repository**.

**CLI.**

```sh
diffinery repo create website --org acme --private -d "Marketing site"
```

**REST API.**

```sh
curl -X POST https://diffinery.com/api/v3/orgs/acme/repos \
  -H "Authorization: Bearer dfy_..." \
  -H "content-type: application/json" \
  -d '{"name": "website", "description": "Marketing site", "visibility": "private"}'
```

Leave out `--org acme` (or use `POST /api/v3/user/repos`) to create it in your own account. See [Repositories](/docs/repositories/overview).

## 5. Push your code

To bring over a repository that lives on GitHub, import it instead of pushing: **Settings → Imports → Import from GitHub** in the web UI, or `diffinery migrate github acme/website --to acme/website`. The import runs on the server and copies the history, issues and pull requests with their numbers, reviews, labels, releases, branch protection and variables (secret names only, never values); see [Migrate from GitHub](/docs/migrate-from-github).

From an existing project:

```sh
cd website
git remote add origin https://diffinery.com/acme/website.git
git push -u origin main
```

Or start from scratch:

```sh
mkdir website && cd website
echo "# website" > README.md
git init -b main
git add README.md
git commit -m "first commit"
git remote add origin https://diffinery.com/acme/website.git
git push -u origin main
```

Open `https://diffinery.com/acme/website` to see the files (with syntax highlighting) and the rendered README.

Every push is checked for leaked credentials, and so is every commit made in the web editor, through the REST API or over MCP. If you accidentally commit an API key or private key, the push is rejected with `Push blocked: possible secrets detected.` and nothing from it is stored: remove the secret from your commits and push again. See [Push protection](/docs/security/push-protection) and [Git over HTTPS](/docs/repositories/git).

## 6. Add a workflow and watch it run

Diffinery runs GitHub Actions workflows from `.github/workflows/`. Add one:

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Show what we are building
        run: |
          echo "Event: ${{ github.event_name }}, commit: ${{ github.sha }}"
          ls -la
```

```sh
git add .github/workflows/ci.yml
git commit -m "Add CI"
git push
```

The push starts a run. Watch it:

- **Web UI**: open the repository's **Actions** tab, click the run, then the `test` job. The log streams live while the job runs.
- **CLI**: run these inside your clone (the CLI finds the repository from the `origin` remote, or pass `-R acme/website`):

  ```sh
  diffinery run list             # newest runs first, with their ID
  diffinery run watch <run-id>   # follow it until it finishes; exits non-zero if it fails
  diffinery run logs <job-id>    # print a job's log
  ```

- **API**: `GET https://diffinery.com/api/v3/repos/acme/website/actions/runs`.

`runs-on: ubuntu-latest` runs in a fresh Ubuntu 24.04 container on Diffinery's hosted runners. The job reports a check named `CI / test` (workflow name, then job name) on the commit, which you can require in branch protection later. If you also run another CI system, it can report its results on the same commits as commit statuses or check runs through the GitHub-compatible REST API; see [Checks and statuses](/docs/collaboration/checks-and-statuses). If a workflow file has a syntax error, its run fails and shows the errors; `diffinery workflow validate` checks files before you push. See [Actions](/docs/actions/overview).

Each job gets a `GITHUB_TOKEN` that follows GitHub's `permissions:` model. In a new repository it can only read the code and packages (`contents: read`, `packages: read`), which is all the checkout above needs. A workflow that comments on pull requests, pushes or publishes releases has to ask for more, for example:

```yaml
permissions:
  contents: write
  pull-requests: write
```

A repository admin can also change the default. See [Workflow permissions](/docs/actions/workflow-permissions).

## 7. Open a pull request

Make a change on a branch and push it:

```sh
git switch -c update-readme
echo "Our marketing site." >> README.md
git commit -am "Describe the project"
git push -u origin update-readme
```

The push output includes a link: `Create a pull request for 'update-readme':` followed by the compare URL.

**Web UI.** Open that link (or the repository's **Pull requests** tab, then **New pull request**). On the compare page, fill in:

- **Title**,
- **Intent**: one or two sentences on what the change is meant to do, for human and AI reviewers,
- **Description** (Markdown),

then click **Create pull request**.

**CLI.**

```sh
diffinery pr create --title "Describe the project" \
  --intent "Add a one-line description of the site to the README." \
  --body "Small docs change."
```

The pull request's `pull_request` workflow runs on a test merge of your branch into `main`, and its checks appear on the pull request. When the checks pass, merge it with **Merge pull request** (choose **Create a merge commit**, **Squash and merge** or **Rebase and merge (fast-forward)**), or:

```sh
diffinery pr merge 1 --squash --delete-branch
```

Teammates review with **Approve** or **Request changes** on the pull request, or `diffinery pr review 1 --approve`. You can't approve your own pull request. To require reviews and green checks before merging, add a rule under **Settings → Branch protection**. See [Pull requests](/docs/collaboration/pull-requests) and [Branch protection](/docs/repositories/branch-protection).

To skip the merge click from now on, open **Settings → Merge on green** once its checks have run: tick the checks and **Turn on auto-merge for pull requests I open**, and pull requests, yours and your agents', merge by themselves when the checks pass. See [Merge on green automatically](/docs/collaboration/merge-on-green).

## 8. Publish a release

A release turns a tag into a version people can download, with release notes and attached files.

**Web UI.** Open `https://diffinery.com/acme/website/releases` (or **Releases** in the sidebar of the repository page) and click **Draft a new release**. Under **Tag**, type a new tag such as `v0.1.0` (its **Target for a new tag** defaults to `main`), add a **Release title** and **Release notes**, optionally check **Generate release notes from merged pull requests (when the notes are empty)** and choose files under **Attach files**, then click **Publish release**. The release page also links to **Source code (zip)** and **Source code (tar.gz)** archives of the tag.

**REST API** (GitHub-compatible, so Octokit and similar tools work too):

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/releases \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" \
  -d '{"tag_name": "v0.1.0", "name": "First release", "generate_release_notes": true}'
```

Publishing creates the tag if it doesn't exist and starts workflows that listen for `on: release`. See [Releases](/docs/collaboration/releases).

To deploy from a workflow with its own secrets and branch rules, use an environment (`environment: production` on a job); see [Environments](/docs/actions/environments).

## 9. Connect an AI agent over MCP

Agents are separate accounts for AI tools. They act on behalf of the person or organization that owns them, never get more access than their owner, can't push or merge to the default branch or protected branches, and their pull requests always need a human approval.

### Create the agent

**Web UI.** Go to **Settings → Agents**. Under **Create an agent**, enter the **Agent username** `review-bot`, a **Display name**, the **Owner** (you or `acme`) and the **Maximum role** (keep **Write**). Click **Create agent**. Then open **Create a token for review-bot**, keep the defaults (**Scope** **Write**, 30 **Days**) and click **Create token**. Copy the token; it is shown once.

Tokens can't create agents or tokens, so create agents in the web UI under **Settings → Agents**, then create the agent's token in its row (**Create a token for**). The token is shown once. An agent owned by `acme` can work in every `acme` repository, up to its maximum role. Creating an organization agent needs the owner or admin role in the organization.

### Point your MCP client at Diffinery

Diffinery's MCP server is at `https://diffinery.com/mcp` (Streamable HTTP). Give the client the agent's token as a bearer token:

```json
{
  "mcpServers": {
    "diffinery": {
      "type": "http",
      "url": "https://diffinery.com/mcp",
      "headers": { "Authorization": "Bearer dfy_..." }
    }
  }
}
```

`diffinery mcp-config` prints this snippet with `${DIFFINERY_TOKEN}` in place of the token, which clients such as Claude Code expand from the environment. For Claude Code, save it as `.mcp.json` in your project and set `DIFFINERY_TOKEN` to the agent's token.

Ask the agent something like "Use the diffinery tools: who am I, and what pull requests are open in acme/website?". It calls `whoami` and `list_pull_requests`. Agents can read and commit files without Git (`get_file`, `list_tree`, `commit_files`), open pull requests with an intent (`create_pull_request`), review, follow workflow runs and logs (`list_workflow_runs`, `get_job_logs`), publish releases (`create_release`, `upload_release_asset`), and start sandboxes to build and test (`sandbox_create`, `sandbox_exec`). See [MCP](/docs/agents/mcp) and the [MCP tool reference](/docs/reference/mcp-tools).

## Next steps

- [Concepts](/docs/concepts): accounts, roles, tokens, visibility, Actions and agents in one page.
- [Migrate from GitHub](/docs/migrate-from-github): import a GitHub repository or organization from the web, the CLI, the API or MCP, then set its secrets again.
- [Merge on green automatically](/docs/collaboration/merge-on-green): pull requests merge by themselves once their checks pass.
- [Branch protection](/docs/repositories/branch-protection): require pull requests, reviews and checks, and [Checks and statuses](/docs/collaboration/checks-and-statuses) to report results from other CI systems.
- [Releases](/docs/collaboration/releases) and [Environments](/docs/actions/environments): ship versions and deploy them.
- [Organizations](/docs/accounts/organizations) and [Invitations](/docs/accounts/invitations): bring your team.
- [Secrets and variables](/docs/actions/secrets-and-variables): give workflows credentials.
- [Workflow syntax](/docs/actions/workflow-syntax) and [Compatibility with GitHub Actions](/docs/actions/compatibility).
- [Agents](/docs/agents/overview) and [Sandboxes](/docs/agents/sandboxes): put AI agents to work safely.
- [REST API](/docs/reference/rest-api) and the [CLI reference](/docs/reference/cli).
