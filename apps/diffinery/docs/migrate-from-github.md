---
title: Migrate from GitHub
description: Import GitHub repositories or whole organizations with the server-side importer (web, CLI, API or MCP), then set secrets, update remotes and check workflows.
---

Diffinery imports a GitHub repository, or every repository of a GitHub organization or user, on the server: it copies the Git history in a container and everything else through GitHub's REST API, keeping issue and pull request numbers, comments, reviews and their authors. You start an import from the web, the `diffinery` CLI, the REST API or MCP, and nothing runs on your machine. This page covers the importer in full, the older client-side and plain Git paths, mirroring from GitHub, and what to change after you move.

## Choose a method

| Method | Copies | Use it when |
| --- | --- | --- |
| [The server-side importer](#how-the-importer-works) (web, `diffinery migrate github`, REST API, MCP) | Branches, tags, pull request heads, Git LFS objects, issues and pull requests with their numbers, comments, reviews and review comments, labels, milestones, releases and assets, branch protection, Actions variables, deployment environments with their variables, and the names (never the values) of secrets. | You are moving a repository or an organization to Diffinery. This is the default. |
| [`diffinery migrate github --local`](#the-local-client-side-import) | Branches, tags, default branch, repository variables and secret names. With `--issues`, also labels, issues, comments and open pull requests, created anew. | You want the older client-side path that clones on your machine. |
| [Plain Git](#move-with-plain-git) | Branches and tags. | You only need the code. |
| [Mirror from GitHub](#keep-github-as-upstream-and-mirror-to-diffinery) | Every branch and tag on every push, plus the secrets you list. | You want to try Diffinery (or run its Actions) while your team keeps working on GitHub. |

Whatever you choose, Diffinery runs your existing `.github/workflows/*.yml` files. See [Workflows](#workflows).

## How the importer works

An import is a record on the server that runs through fixed steps, each retried on failure and resumed where it stopped:

1. **Create the repository** under the Diffinery user or organization you chose, with GitHub's description, homepage, topics (up to 20) and default branch.
2. **Copy branches, tags and history.** A container clones the GitHub repository with `git clone --mirror` and pushes it to Diffinery in chunks of about 32 MB, then copies Git LFS objects.
3. **Copy issues, pull requests, comments, reviews, review comments, labels, milestones, branch protection, variables, secret names, environments and releases** through GitHub's REST API, page by page.
4. **Finish:** create `refs/pull/<n>/head` for every imported pull request, set the default branch, archive the repository if it is archived on GitHub, and write the summary.

Things to know:

- **Nothing the import writes fires events.** No workflow runs start, no webhooks are delivered and nobody is notified about imported issues, comments or pushes. Your first push after the import starts workflows as usual.
- **The repository is locked while the import runs.** Until the import finishes, fails or is cancelled, only the import writes to it. A push from anyone else is refused with `repository is locked by an import in progress`, and any other change through the REST API, the web UI or MCP (an issue, a comment, a label, a webhook, a branch protection rule, a rename or transfer) gets `423 repository is locked by an import in progress; try again when it finishes, or cancel the import`. Reading the repository and watching it work as usual, and so do settings that don't touch its Git data, issues or pull requests: Actions secrets and variables, environments with their secrets and variables, and collaborators and their invitations. You can set the imported secrets' values while the history is still arriving.
- **Every write is keyed by GitHub's ids**, so a retried step or a retried import never duplicates issues, pull requests, comments, reviews, labels, milestones, branch protection rules or releases (a release is matched by its tag and creation date, and assets already copied are kept).
- **The import keeps running if you close the page or stop the CLI.** You get an entry in your notifications list when it succeeds (`Imported acme/website into acme/website`) or fails, linking to its page.
- **Every import is audited:** `import.create`, `import.push`, `import.finish`, `import.fail`, `import.cancel` and `import.retry` appear in the audit log. See [Audit log](/docs/security/audit-log).

## Before you start

You need:

- **A Diffinery account.** Diffinery is invite-only; ask a site administrator or an owner or admin of your organization for an invite, or create an account at `/signup` on an instance with [open sign-up](/docs/accounts/passkeys-and-sign-in#open-sign-up). See [Invitations](/docs/accounts/invitations).
- **An organization** if the repositories should belong to one, for example `acme`, where you are an owner or admin. Create it under **Settings → Organizations**. See [Organizations](/docs/accounts/organizations).
- **For the CLI, API or MCP, a Diffinery token with the `write` or `admin` scope.** Use `admin` if old history may contain credentials and you want them imported with a bypass (see [Secrets in old history](#secrets-in-old-history)). The web UI needs no token. See [Personal access tokens](/docs/accounts/tokens).
- **A GitHub token** for a private repository, and for Git LFS, variables, secret names, environments and branch protection. See [GitHub token](#github-token).
- **Optionally, a linked GitHub account**, so your own past issues, comments and reviews are attributed to your Diffinery account. Link it before you import. See [Link your GitHub account](#link-your-github-account).

### Who can import where

| Who | Can import into |
| --- | --- |
| A person | Their own account, and organizations where they are an owner or admin |
| A site administrator | Any user or organization |
| An agent | Only organizations: the organization that owns the agent, or one where the agent's owner is an owner or admin. Never a user account. The agent's maximum role must be at least `write`. |
| An organization | Nothing: `organizations cannot start imports` |

Organization members who aren't owners or admins can't import into the organization (`you can import only into your own account or organizations you administer, not acme`). The check runs again when the import starts; if you lost the right in the meantime the import fails with `the person or agent who started this import can no longer import into this account`.

### GitHub token

Without a GitHub token, the importer reads only public data, and GitHub's limit for anonymous requests (60 an hour) makes a large import slow. The importer waits whenever GitHub asks it to, so it still finishes. With a token:

| To import | The GitHub token needs |
| --- | --- |
| A private repository, its Git data, issues, pull requests, comments, reviews, labels, milestones and releases | Classic token: the `repo` scope. Fine-grained token: read access to **Contents**, **Metadata**, **Issues** and **Pull requests**. |
| Branch protection | Admin access to the repository on GitHub |
| Actions variables, secret names and environments | Admin access to the repository, or for a fine-grained token **Variables** and **Secrets** read access |
| Organization variables and secret names (organization imports) | Admin access to the GitHub organization |
| Private repositories of a GitHub organization or user (organization imports) | Access to those repositories; the list includes private ones only when the token can see them |

When the token can't read something optional, the import carries on and records a warning, for example `Branch protection of main could not be read (the GitHub token needs admin access to the repository); set it up under Settings → Branch protection.`

How the token is handled:

- It is used only for this import, encrypted at rest, and deleted when the import finishes, fails or is cancelled. A retry needs it again.
- It is never returned by the API, MCP or the web UI, and never written to logs. In the container, Git gets it from per-host configuration, never on its command line.
- It is sent only to the one GitHub host you import from. Redirects to another host are not followed, the clone URL must be on that host (`GitHub returned a clone URL on another host`), and release assets get the token only when they are on the API's own origin.
- The CLI sends `GH_TOKEN` (or `GITHUB_TOKEN`) to Diffinery over HTTPS so the server can use it, and says so on stderr (`note: sending GH_TOKEN to https://diffinery.com so it can read <owner/repo> from GitHub during the import`). Unset both to import only public data without a token.

### GitHub Enterprise Server

To import from GitHub Enterprise Server, name its REST API base explicitly: the **GitHub Enterprise API URL** field in the web form, `github_api_url` in the API and MCP, or `GITHUB_API_URL` for the CLI. The rules:

| Rule | Details |
| --- | --- |
| Default | `https://api.github.com`. `github.com`, `www.github.com` and `api.github.com` all mean github.com. |
| Form | `https://ghe.example.com/api/v3`. A bare host such as `https://ghe.example.com` gets `/api/v3` added. |
| Must be https on a public host | Otherwise `github_api_url must use https`, `github_api_url must be a public host` (localhost, single-label names, `.local`, `.internal` and private or loopback addresses are refused), `github_api_url must not contain credentials` or `github_api_url is not a valid URL`. |
| A token with an Enterprise source URL | If `source` is a URL on an Enterprise host and you give a token, `github_api_url` is required (`github_api_url is required when a github_token is given and the source names a GitHub Enterprise host`) and must be on the same host (`github_api_url must be on the same host as the source repository`). This keeps a token from going to a host taken from the source URL. |
| No token | A source URL on an Enterprise host implies `https://<host>/api/v3`. |

Release assets are downloaded only from github.com's asset hosts and from the GitHub Enterprise host the server administrator configured (`IMPORT_GHE_HOST`). On other Enterprise hosts, assets are skipped with a warning and the releases themselves are still imported.

## Import from the web

### One repository

1. Open the import form in any of these ways:
   - **Settings → Imports**, then **Import from GitHub**.
   - On **Create a new repository** (`https://diffinery.com/new`), the **Import a repository** link.
   - On an organization's page, **Import from GitHub** next to **New repository** (shown to its owners and admins; it opens the form for an organization import into that organization).
   - Directly: `https://diffinery.com/new/import`.
2. Under **What to import**, choose **One repository**.
3. In **GitHub repository, or organization/user**, enter `acme/website` or `https://github.com/acme/website`.
4. In **Import into**, choose yourself or an organization you administer.
5. Optionally set **New repository name** (defaults to the GitHub name).
6. Choose **Visibility**: **Keep** (a public GitHub repository stays public, any other becomes private), **Private** or **Public**.
7. Paste a **GitHub token** if the repository is private or you want LFS, variables and protection.
8. Optionally open **What to copy, and GitHub Enterprise** to turn parts off, choose what happens to [secrets in old history](#secrets-in-old-history), or set **GitHub Enterprise API URL**. See [Import options](#import-options).
9. Click **Start import**. The import's page opens and follows its progress.

### An organization or user

1. Open the import form as above. The **Import from GitHub** button on an organization's page preselects it.
2. Under **What to import**, choose **A whole organization or user**.
3. In **GitHub repository, or organization/user**, enter the GitHub organization or user, for example `acme`.
4. Choose **Import into**, **Visibility**, the **GitHub token** and the options, and set **Repositories at a time** (1 to 8, default 3).
5. Click **Start import**. The **Choose repositories** page lists the account's repositories with `private`, `fork` and `archived` badges. Everything except forks and archived repositories is ticked.
6. Use the filter box with **Filter**, **Select all** (or **Select all shown** when filtered) and **Clear** to adjust the selection, then click **Import N repositories**.

Each repository becomes its own import under the organization import, keeps its GitHub name, and is imported in full. A repository whose name already exists in the target fails straight away with `acme/website already exists`; the others go ahead.

An organization import waiting on **Choose repositories** is a draft. Drafts left for seven days are cancelled (`draft expired`) and their stored GitHub token is erased.

### Import options

| Web label | API field (`options.`) | Default | What it controls |
| --- | --- | --- | --- |
| **Issues and pull requests** | `issues` | on | Issues and pull requests with comments, reviews and review comments |
| **Labels and milestones** | `labels` | on | Labels and milestones, even without issues |
| **Branch protection** | `branch_protection` | on | Classic branch protection rules |
| **Actions variables and secret names** | `variables` | on | Repository variables, secret names, and deployment environments with their variables and secret names; for organization imports also organization variables and secret names |
| **Releases** | `releases` | on | Releases and their assets |
| **Git LFS objects** | `lfs` | on | Git LFS files |
| **Secrets found in old history (push protection)**: **Import with an audited bypass** or **Stop the import** | `secrets`: `"bypass"` or `"stop"` | `bypass` | What happens when push protection finds a credential in old commits. Agents always get `stop`. |

Branches, tags and history are always copied. A step whose option is off shows as skipped with `Not selected`.

### Follow progress

The import's page (`https://diffinery.com/imports/<id>`) refreshes itself every few seconds while the import runs ("This page refreshes automatically.") and shows:

- The source, the target and a status badge: `queued`, `running`, `succeeded`, `failed` or `cancelled` (and `draft` for an organization import that waits for its selection).
- Each step with its state and a short message, such as `12 branches, 30 tags, 118 pull request heads, 4 LFS objects`.
- For an organization import, every repository with its status and an **Open** button.
- After it finishes: **Imported** (counts), **Secret names** with a **Set secret values** button, **Possible secrets in history (rotate these)** when a bypass was used, and **Warnings**.
- **Cancel import** while it runs, and **Retry this import** when it failed or was cancelled.

**Settings → Imports** (`https://diffinery.com/imports`) lists the imports you started, newest first. Admins of the target account can also open an import's page by its link.

| Step | Title on the page |
| --- | --- |
| `repository` | Create the repository |
| `git` | Copy branches, tags and history |
| `labels` | Labels and milestones |
| `issues` | Issues and pull requests |
| `comments` | Comments |
| `reviews` | Reviews |
| `review_comments` | Review comments |
| `protection` | Branch protection |
| `variables` | Variables and secret names |
| `releases` | Releases |
| `finalize` | Finish |

An organization import has three steps: `organization` (**Organization variables and secret names**), `repositories` (**Repositories**, with `3 of 10 finished (2 imported, 1 failed)`) and `finalize` (**Finish**). Each step is `pending`, `running`, `done`, `skipped` or `failed`.

## Import with the CLI

Install the CLI and sign in (approve the sign-in in your browser; `--scope admin` if you'll also set secrets):

```sh
curl -fsSL https://diffinery.com/install | bash
diffinery login            # opens your browser to authorize
```

### diffinery migrate github

Starts a server-side import of one repository and follows it until it finishes:

```sh
export GH_TOKEN=ghp_...                    # needed for private repositories, LFS, variables and protection
diffinery migrate github acme/website --to acme/website
```

```text
diffinery migrate github <GH-OWNER/GH-REPO> [options]
```

The argument can also be a URL such as `https://github.com/acme/website`; the CLI keeps only `owner/name` from it, so for GitHub Enterprise set `GITHUB_API_URL`.

| Option | Default | Meaning |
| --- | --- | --- |
| `-t, --to OWNER/NAME` | `<you>/<github repo name>` | The Diffinery repository to create. It must not exist yet. |
| `-p, --private` | off | Create the repository as private, whatever its visibility on GitHub (otherwise visibility is kept) |
| `-l, --local` | off | Run the older client-side import instead. See [The local client-side import](#the-local-client-side-import). |
| `-i, --issues` | off | With `--local` only: also copy labels, issues, comments and open pull requests |
| `--json` | off | Print the final import object as JSON instead of progress lines |

| Environment variable | Meaning |
| --- | --- |
| `GH_TOKEN` or `GITHUB_TOKEN` | GitHub token, sent to Diffinery for the import (`GH_TOKEN` wins if both are set) |
| `GITHUB_API_URL` | GitHub Enterprise API base, for example `https://ghe.example.com/api/v3` |
| `DIFFINERY_TOKEN`, `DIFFINERY_URL` | Override the token and server saved by `diffinery login` |

The CLI imports with every option on and `secrets` set to `bypass`. To turn parts off or stop on secrets, use the web form or the API.

While it runs, the command prints each step and Git phase as it changes:

```text
Starting server import of acme/website …
  … Create the repository
  ✓ Create the repository (acme/website)
  … Copy branches, tags and history (Starting the import container)
  … git: Cloning acme/website
  … git: Pushing history of main: chunk 1 (31.6 MB)
  ✓ Copy branches, tags and history (42)
  ✓ Labels and milestones (14)
  ✓ Issues and pull requests (220)
  ...
  ✓ Finish (180 issues, 40 pull requests)

Imported acme/website → acme/website

GitHub does not reveal secret values. Set these 3 secrets by hand:
  diffinery secret set NPM_TOKEN -R acme/website
  diffinery secret set SENTRY_DSN -R acme/website
  diffinery api PUT /repos/acme/website/environments/production/secrets/DEPLOY_KEY -f value=...

https://diffinery.com/acme/website
```

Warnings are printed to standard error. Repository secrets get a `diffinery secret set` line. Environment secrets (`production/DEPLOY_KEY` in the summary) have no `secret set` option, so they get a `diffinery api PUT .../environments/<environment>/secrets/<NAME>` line instead (see [Environments and their secrets](#environments-and-their-secrets)). Replace `...` with the value, or pipe it in.

Stopping the command (Ctrl-C) stops following, not the import. Check on it at `https://diffinery.com/imports` or with `GET /api/v3/diffinery/imports`.

### diffinery migrate github-org

Starts a server-side import of many repositories of a GitHub organization or user and follows it until every repository has finished:

```sh
export GH_TOKEN=ghp_...
diffinery migrate github-org acme --to acme --exclude-forks --exclude-archived
```

```text
diffinery migrate github-org <GH-ORG-OR-USER> [options]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-t, --to OWNER` | you | The Diffinery user or organization to import into |
| `--repos A,B,C` | all | Comma-separated names of the repositories to import |
| `-p, --private` | off | Create every repository as private |
| `--exclude-forks` | off | Skip forks |
| `--exclude-archived` | off | Skip archived repositories |
| `-c, --concurrency N` | 3 | Repositories imported at the same time, 1 to 8 |
| `--json` | off | Print the final import object as JSON |

Unlike the web form, the CLI has no selection step: it starts importing the repositories straight away. It prints a line per repository as its state changes, then a summary such as `Bulk import of acme: 9/10 repositories imported, 1 failed` and the import's URL.

### JSON output and exit status

With `--json`, both commands print the final [import object](#the-import-object). Both exit with status `0` when the import succeeded and `1` otherwise (failed or cancelled). An organization import counts as failed when any of its repositories wasn't imported.

### The local client-side import

`diffinery migrate github --local` runs the older import on your machine. It needs Git 2.31 or newer and a Diffinery token with the `admin` scope that isn't restricted to repositories, from a person, not an agent (it creates the repository, sets the default branch and Actions variables). Run `diffinery auth setup-git` once so Git can use the token.

```sh
export GH_TOKEN=ghp_...
diffinery migrate github acme/website --to acme/website --local --issues
```

What it does:

1. Creates the target repository with GitHub's description and visibility (or private with `--private`), or uses it if it exists (`Using existing repository acme/website`).
2. Clones with `git clone --mirror` into a temporary folder and pushes every `refs/heads/*` and `refs/tags/*` in one `git push`. If that fails, it prints `warning: bulk push failed (...); pushing refs one at a time` and pushes each ref separately.
3. Sets the default branch, copies repository variables and lists secret names with a `diffinery secret set` line for each.
4. With `--issues`: copies labels, then creates issues, recreates open pull requests whose branches are in the same repository, copies conversation comments and closes closed issues. Everything is created by you, now, with new numbers (the output lists `GitHub #12 → #9`), and each item starts with an attribution line such as `> Imported from GitHub issue [#12](https://github.com/acme/website/issues/12) by @diffy on 2026-03-01`.

It doesn't copy closed or merged pull requests, reviews, review comments, milestones, assignees, releases, Git LFS files, environments or branch protection, and pushes go through push protection like any other push (and start workflows). `--issues` isn't idempotent: running it twice creates every issue again. It exits with status 1 if any branch or tag failed to push. With `--json` it prints `repo`, `created`, `branches`, `tags`, `pushFailures`, `defaultBranch`, `labels`, `issues` and `pulls` (`{from, to}` pairs), `skippedPulls`, `comments`, `variables`, `secrets` and `warnings`.

Prefer the server-side import: it keeps numbers, authors, dates, reviews and merged pull requests, and doesn't depend on your connection.

## Import with the REST API

The importer is a Diffinery extension of the REST API under `/api/v3/diffinery/imports`. Every endpoint needs a token (or a browser session). Starting an import needs the `write` or `admin` scope (`starting an import needs a token with write or admin scope`); cancelling, retrying and choosing repositories need the `write` scope on a token that isn't restricted to repositories.

### Start an import

`POST /api/v3/diffinery/imports` with a JSON body. One repository:

```sh
curl -X POST https://diffinery.com/api/v3/diffinery/imports \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" \
  -d '{
    "source": "acme/website",
    "owner": "acme",
    "name": "website",
    "visibility": "keep",
    "github_token": "ghp_...",
    "options": { "releases": true, "secrets": "bypass" }
  }'
```

Many repositories from an organization or user:

```sh
curl -X POST https://diffinery.com/api/v3/diffinery/imports \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" \
  -d '{
    "source_owner": "acme",
    "owner": "acme",
    "exclude_forks": true,
    "exclude_archived": true,
    "concurrency": 4,
    "github_token": "ghp_..."
  }'
```

| Field | Applies to | Default | Meaning |
| --- | --- | --- | --- |
| `source` | One repository | | `owner/name`, a github.com or Enterprise URL, or an SSH remote such as `git@github.com:acme/website.git`. Give either `source` or `source_owner`. |
| `source_owner` | Many | | A GitHub organization or user login |
| `owner` | Both | required | The Diffinery user or organization to import into |
| `name` | One repository | the GitHub name | The new repository's name: letters, digits, `.`, `-` and `_`. It must not exist yet. |
| `repositories` | Many | all | Names of the repositories to import, at most 1,000. Unknown names fail the request (`not found in acme: a, b`). |
| `exclude_forks` | Many | `false` | Skip forks (ignored when `repositories` is given) |
| `exclude_archived` | Many | `false` | Skip archived repositories (ignored when `repositories` is given) |
| `concurrency` | Many | `3` | Repositories imported at the same time, 1 to 8 |
| `visibility` | Both | `keep` | `keep`, `private` or `public`. With `keep`, a public GitHub repository stays public and any other becomes private. |
| `options` | Both | everything on, `secrets: "bypass"` | An object with `issues`, `labels`, `branch_protection`, `variables`, `releases`, `lfs` (booleans) and `secrets` (`"bypass"` or `"stop"`). Unknown keys fail with `unknown option "..."`. See [Import options](#import-options). |
| `github_token` | Both | none | GitHub token; at most 400 characters, no spaces |
| `github_api_url` | Both | `https://api.github.com` | GitHub Enterprise API base. See [GitHub Enterprise Server](#github-enterprise-server). |

Before it records anything, the server reads the source on GitHub, so mistakes fail right away: `GitHub repository acme/website was not found or the token cannot read it`, `GitHub rejected the token (expired or revoked?)`, `no GitHub organization or user named acme`, `acme has no repositories to import`, or `acme/website already exists; choose another name`. A single repository larger than the size limit is refused here too (see [Limits](#limits)).

The response is `201 Created` with the [import object](#the-import-object). An organization import created through the API starts at once with the repositories you named (or all of them); the draft and selection step exists only in the web form.

### The import object

The same object is returned by the REST API, by the MCP tools and by `--json`. It never contains a credential.

```json
{
  "id": "01JA7Q3V9X2M8K4T6R5N0B1C2D",
  "url": "https://diffinery.com/api/v3/diffinery/imports/01JA7Q3V9X2M8K4T6R5N0B1C2D",
  "html_url": "https://diffinery.com/imports/01JA7Q3V9X2M8K4T6R5N0B1C2D",
  "kind": "repository",
  "parent_id": null,
  "status": "running",
  "attempt": 1,
  "source": { "full_name": "acme/website", "html_url": "https://github.com/acme/website", "api_url": "https://api.github.com" },
  "target": { "owner": "acme", "name": "website", "full_name": "acme/website", "html_url": "https://diffinery.com/acme/website" },
  "visibility": "keep",
  "options": { "issues": true, "releases": true, "labels": true, "branch_protection": true, "variables": true, "lfs": true, "secrets": "bypass" },
  "created_by": { "login": "diffy", "type": "User" },
  "steps": [
    { "name": "repository", "title": "Create the repository", "status": "done", "message": "acme/website", "count": null, "started_at": "2026-10-13T09:00:01.000Z", "finished_at": "2026-10-13T09:00:03.000Z" },
    { "name": "git", "title": "Copy branches, tags and history", "status": "running", "message": "Starting the import container", "count": null, "started_at": "2026-10-13T09:00:03.000Z", "finished_at": null }
  ],
  "git": { "phase": "push", "message": "Pushing history of main: chunk 3 (31.9 MB)", "chunks": 2, "bytes": 66846720, "tries": 1 },
  "summary": {},
  "warnings": [],
  "error": null,
  "created_at": "2026-10-13T09:00:00.000Z",
  "updated_at": "2026-10-13T09:04:12.000Z",
  "started_at": "2026-10-13T09:00:01.000Z",
  "finished_at": null
}
```

| Field | Meaning |
| --- | --- |
| `kind` | `repository` or `organization` |
| `parent_id` | For a repository of an organization import, the organization import's id |
| `status` | `draft`, `queued`, `running`, `succeeded`, `failed` or `cancelled` |
| `attempt` | 1, plus one per retry |
| `target.html_url` | Set once the repository exists |
| `steps` | Every step in order, with `status` (`pending`, `running`, `done`, `skipped`, `failed`), `message` and `count` |
| `git` | The Git transfer: `phase` (`starting`, `clone`, `lfs-fetch`, `push`, `refs`, `lfs-push`, `cleanup`, `done` or `failed`), `message`, history `chunks` and `bytes` pushed, and `tries` |
| `summary` | Filled in as steps finish: `counts` (`issues`, `pulls`, `comments`, `reviews`, `labels`, `milestones`), `git` (`branches`, `tags`, `pullRefs`, `lfsObjects`, `lfsBytes`, `defaultBranch` and more), `pullRefs.missing`, `protections`, `variables`, `secretNames`, `environments` (`imported`, `variables`, `secretNames`), `releases` (`imported`, `assets`, `skippedAssets`), `findings` (`kind`, `blob`, `path`), `people` (`linked`, `imported`), and for organization imports `orgVariables`, `orgSecretNames` and `children` counts |
| `warnings` | Things that didn't come across, in words |
| `error` | Why the import failed or who cancelled it |
| `concurrency`, `candidates`, `children` | Organization imports only: the concurrency, the repositories to choose from (drafts), and each repository import (`id`, `html_url`, `source`, `target`, `status`, the running `step`, `error`) |

### Endpoints

| Endpoint | Purpose | Response |
| --- | --- | --- |
| `POST /api/v3/diffinery/imports` | Start an import | `201` with the import |
| `GET /api/v3/diffinery/imports` | The imports you started (not the repositories of an organization import), newest first, up to 100 | `200` with a list |
| `GET /api/v3/diffinery/imports/{id}` | One import, with `children` for an organization import | `200`, or `404 import not found` |
| `POST /api/v3/diffinery/imports/{id}/cancel` | Cancel a draft, queued or running import (an organization import cancels its queued and running repositories) | `200` with the import |
| `POST /api/v3/diffinery/imports/{id}/retry` | Run a failed or cancelled import again; body `{"github_token": "ghp_..."}` (optional) | `202` with the import |
| `POST /api/v3/diffinery/imports/{id}/selection` | Choose the repositories of a draft organization import (created in the web form) and start it; body `{"repositories": ["website", "docs"]}` | `202` with the import |

You can read an import if you started it, if you are a person who administers the account it imports into, or if you are a site administrator. The same people can cancel it. Only whoever started it can retry it, except that a person who may import into the target can take over the retry of an agent's import (see [Retries, cancelling and the repository lock](#retries-cancelling-and-the-repository-lock)).

Poll an import until it finishes:

```sh
while :; do
  s=$(curl -fsS https://diffinery.com/api/v3/diffinery/imports/$ID -H "Authorization: Bearer dfy_..." | jq -r .status)
  echo "$s"; case "$s" in succeeded|failed|cancelled) break;; esac; sleep 10
done
```

See the [REST API reference](/docs/api) for every endpoint.

## Import over MCP

The [MCP server](/docs/agents/mcp) has three import tools:

| Tool | Read-only | What it does |
| --- | --- | --- |
| `start_github_import` | No | Start a single-repository import. Arguments: `source` and `owner` (required), `name`, `visibility` (`keep`, `private`, `public`), `github_token`, `github_api_url`. Returns the [import object](#the-import-object). |
| `get_import` | Yes | An import by `id`: status, steps, warnings, error and, for an organization import, its repositories |
| `list_imports` | Yes | The imports you started, newest first |

`start_github_import` imports with every option on. An agent's import never bypasses push protection and skips variables, secret names and environments (see [Agents and imports](#agents-and-imports)). `start_github_import` needs a `write` or `admin` token, like every tool that isn't read-only.

```sh
curl -s https://diffinery.com/mcp \
  -H "Authorization: Bearer $DIFFINERY_TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"start_github_import","arguments":{"source":"acme/website","owner":"acme"}}}'
```

Then call `get_import` with the returned `id` every minute or so until `status` is `succeeded`, `failed` or `cancelled`.

## What comes across

| Data | What is imported |
| --- | --- |
| Repository | Description, homepage, topics (up to 20), default branch, archived state, and visibility as you chose |
| Branches and tags | Every branch and tag. GitHub merge queue branches (`gh-readonly-queue/*`), `refs/pull/<n>/merge`, notes and other refs are skipped. |
| Pull request heads | Each pull request's head commit, kept as `refs/pull/<n>/head`, also for merged and closed pull requests and pull requests from forks |
| Git LFS | Every LFS object GitHub serves for the repository |
| Issues | Number, title, body, author, assignees, labels, milestone, open or closed with its reason (`completed`, `not_planned`, `reopened`, `duplicate`), locked state and original dates |
| Pull requests | Number, title, body, author, base and head branch, head commit, draft state, open, closed or merged, merge commit, who merged it, requested reviewers (open pull requests), labels, milestone and original dates |
| Comments | Conversation comments on issues and pull requests, with author and dates |
| Reviews | Approve, request changes, comment and dismissed reviews with body, commit and date (pending reviews are skipped). They never count as approvals. |
| Review comments | Line comments with path, line, side, commit, review and reply threading |
| Labels | Name, color and description |
| Milestones | Number, title, description, state, due date, creator and dates |
| Branch protection | Classic rules (see [Branch protection rules](#branch-protection-rules)) |
| Actions variables | Repository variables with their values |
| Secrets | Names only: repository secrets and environment secrets (organization secrets for organization imports) |
| Environments | Name, deployment branch policy, custom branch patterns, and environment variables |
| Organization variables | For an organization imported into a Diffinery organization: variables the Diffinery organization doesn't have yet |
| Releases | Tag, target, name, notes, draft and pre-release state, author, dates, and assets up to 2 GiB each with their download counts |

Issue and pull request numbers are kept, gaps and all. New issues and pull requests on Diffinery continue after the highest imported number, so links like `#123` in old text still point at the right place.

### Branch protection rules

Each protected branch's classic rule becomes a Diffinery rule for the same branch name: **Require a pull request before merging**, required approvals, dismissing stale approvals, required status checks, force pushes and deletions allowed, linear history, and whether rules apply to admins. Required checks are renamed to the names Diffinery's workflows report (`<workflow name> / <job name>`), matched by job, so a rule that required `build` on GitHub requires `CI / build` here. Check them under **Settings → Branch protection** after the import. Repository rulesets aren't imported.

### Variables, secret names and environments

- Repository variables are imported with their values. Names that start with `GITHUB_` or aren't valid variable names are skipped.
- Secret **values are never read and never copied**: GitHub doesn't reveal them, and the importer doesn't try. Only names are listed, in the summary and on the import's page, for an admin to set by hand. Environment secret names appear as `<environment>/<NAME>`.
- Environments are created with their branch policy and variables; their secrets are listed by name only.
- In an organization import into a Diffinery organization, the GitHub organization's variables are added to the Diffinery organization when it has no variable of that name. Existing ones are left alone (`Organization variable NPM_REGISTRY already exists and was left unchanged.`). Organization variables are shared by every repository of the organization; a repository variable of the same name wins. So only GitHub organization variables available to all repositories are copied. One limited to private or selected repositories on GitHub is skipped with a warning: `Organization variable NPM_TOKEN is limited to selected repositories on GitHub and was not copied; organization variables on Diffinery reach every repository, so add it to the repositories that need it.`

### Releases and assets

Releases keep their tag, notes, dates and author. Importing a release creates no tag (the tags came with the Git data), starts no `release` workflows and sends no webhook. Assets are copied with their names, labels, content types and download counts; an asset with an unsafe file name, over 2 GiB, or on a host the server may not download from is skipped with a warning such as `Release v1.0.0: could not import asset "app.zip": ...`.

## What doesn't come across

- **Secret values** of any kind. Set them again yourself (see [Set secret values](#set-secret-values)).
- **Accounts.** No Diffinery accounts are created for GitHub users. See [People: linked accounts and mannequins](#people-linked-accounts-and-mannequins).
- **Reactions**, wikis, projects, discussions, GitHub Pages, packages, webhooks, deploy keys, collaborators and teams, repository rulesets, Actions run history, and GitHub Apps.
- **Required reviewers and wait timers** on environments. Set them again under Settings → Environments, with Diffinery people (see [Required reviewers and wait timers](/docs/actions/environments#required-reviewers-and-wait-timers)).
- **Auto-merge** on open pull requests. Turn it on again on Diffinery (see [Auto-merge](/docs/collaboration/pull-requests#auto-merge)).
- **Pull request heads whose fork was deleted on GitHub.** The pull request is imported but has no head commit (`3 pull requests have no head commit (their fork was deleted on GitHub): #12, #15, #40`).
- **Anything a GitHub token couldn't read**, listed under **Warnings**.

## People: linked accounts and mannequins

No accounts are created during an import. Each GitHub user who appears in the imported data (authors, commenters, reviewers, assignees, requested reviewers, who merged) is either mapped to a Diffinery account or shown as a mannequin.

### Mannequins

A mannequin is a placeholder for a GitHub user who has no linked Diffinery account. It carries the history but isn't an account: it can't sign in or do anything on Diffinery, and its imported reviews never count as votes.

| Where | How a mannequin appears |
| --- | --- |
| Web UI | The GitHub login with its picture and a **GitHub** badge, not linked, with the tooltip "Imported from GitHub; not linked to a Diffinery account" |
| REST API | A user object with `login` `github:<login>`, `type` `"Mannequin"`, and `html_url` and `url` pointing at the GitHub profile |
| Assignees, requested reviewers, merged by | Stored as `github:<login>` |
| Issue search | `author:github:diffy` finds the mannequin's issues; `author:diffy` finds only the Diffinery account `diffy` |
| Squash merges | A squash commit for a pull request a mannequin opened is authored as `diffy <diffy@users.noreply.github.com>`, never as a Diffinery address |

A deleted GitHub user appears as `ghost`.

### Link your GitHub account

Linking proves that you control a GitHub account, so imports attribute that account's work to you. Link it **before** you import: links are applied as an import runs, and work already imported stays with the mannequin.

In the web UI, go to **Settings → Linked accounts** (`https://diffinery.com/settings/linked-accounts`), the **Linked GitHub accounts** page.

With a gist (no token needed):

1. Under **Step 1 · get a code**, leave **GitHub Enterprise API URL** blank for github.com (or enter your Enterprise API URL) and click **Get my code**. The code looks like `diffinery-link-3f9a...`. It is the same every time for your account and that host.
2. On GitHub, create a **public** gist whose description or one of whose files contains the code.
3. Under **Step 2 · verify your gist**, enter **Your GitHub username on github.com** and click **Verify and link**. You see "GitHub account linked."

Diffinery reads your public profile and public gists without any token, from the API host you named, and links the account only when it finds the code. It looks at up to 100 of your gists (and reads the contents of up to 20). You can delete the gist afterwards.

With GitHub OAuth, when the server administrator configured a GitHub OAuth app (`GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`): the page shows **Link with GitHub**. Click **Continue to GitHub**, authorize read-only access to your profile (`read:user`), and you come back linked. The OAuth flow links github.com accounts only; its state is bound to your account, so a callback can't be replayed for someone else.

To remove a link, click **Unlink** next to it and confirm. Only people can link accounts (`only people can link GitHub accounts`); agents can't.

With the REST API (a token with the `admin` scope that isn't restricted to repositories):

```sh
# Step 1: get the code (api_url is optional; default github.com)
curl -X POST https://diffinery.com/api/v3/diffinery/user/linked-accounts/github/challenge \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" -d '{}'
# {"nonce": "diffinery-link-...", "apiBase": "https://api.github.com", "host": "github.com", "gistsUrl": "https://api.github.com/gists"}

# Step 2: after creating the public gist
curl -X POST https://diffinery.com/api/v3/diffinery/user/linked-accounts/github \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" -d '{"login": "diffy"}'
# 201 {"id": "...", "host": "github.com", "login": "diffy"}
```

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v3/diffinery/user/linked-accounts` | Your links: `id`, `host`, `apiBase`, `login`, `externalId` (GitHub's numeric user id), `createdAt` |
| `POST /api/v3/diffinery/user/linked-accounts/github/challenge` | Your code for a host; body `{"api_url": "..."}` (optional) |
| `POST /api/v3/diffinery/user/linked-accounts/github` | Verify the gist and link; body `{"login": "diffy", "api_url": "..."}` |
| `DELETE /api/v3/diffinery/user/linked-accounts/{id}` | Remove one of your links (`204`) |
| `DELETE /api/v3/diffinery/admin/linked-accounts/{id}` | Site administrators: remove anyone's link (`204`), recorded in the audit log as `account.link_cleared` |

Linking and unlinking are audited as `account.link_github` and `account.unlink_github`.

### How links are matched

- A link stores GitHub's **numeric user id**, not only the login, and imports match by that id. Renaming a GitHub account, or someone else taking an old login, can't move work to the wrong person.
- Links are kept per GitHub host (the full API base), so a github.com link and an Enterprise link are separate even if the logins match.
- One GitHub account can be linked to only one Diffinery account (`GitHub user diffy is linked to another Diffinery account`). One Diffinery account can link several GitHub accounts.
- Only links of active accounts are used.

The summary lists which GitHub users were mapped (`people.linked`) and which became mannequins (`people.imported`).

### Imported reviews never count as approvals

Imported reviews are history, not votes. A review imported from GitHub never counts toward required approvals and never blocks a merge, even when its author is a linked account and even if it was an approval. A pull request still open after the import needs a fresh review on Diffinery to be approved.

## Secrets in old history

Imported history goes through [push protection](/docs/security/push-protection) like any push. When old commits contain something that looks like a credential, the `secrets` option decides:

| Option | What happens |
| --- | --- |
| **Import with an audited bypass** (`bypass`, the default) | The history is imported anyway, because it is already on GitHub. The push carries the reason `Imported from GitHub acme/website`, is audited as `push.secret_bypassed` with the import and the blobs, and the import's page lists each finding under **Possible secrets in history (rotate these)** (`summary.findings`, with the file path where one was found). Rotate those credentials. |
| **Stop the import** (`stop`) | The import fails at the Git step so you can clean the history first. |

A bypass works only for a person who is an admin of the target repository and started the import with an `admin`-scoped token or from the web. Otherwise (an agent, or a `write` token) the import fails with `Push protection found possible secrets in the history (AWS access key). Only a person who administers the target can import them with an audited bypass (agents and write-scoped tokens cannot); start a new import as such a person.`

**Agents never bypass push protection.** An import started by an agent always uses `stop`, whatever it asks for.

A retry keeps the original options, so it can't switch from `stop` to `bypass`. After a stop, rotate the credentials, then start a new import with `bypass` as an admin (into a new name, or after deleting the partly imported repository), or clean the history on GitHub first.

## Limits

| Limit | Value |
| --- | --- |
| Imports running at once | Per account that starts them and per target account: at most 3 single-repository imports (`too many repository imports are already running (at most 3 at a time); wait for one to finish`) and 1 organization import, drafts included (`an organization import is already in progress (at most 1 at a time); wait for it to finish or cancel it`). Repositories inside an organization import don't count toward the 3. |
| Repository size | 10 GB by default, as GitHub reports it; a single-repository import over it is refused up front with `the repository is about 12 GB, over the 10 GB import limit; ask an administrator to raise IMPORT_MAX_REPO_KB or split the repository`. In an organization import, a repository over it fails with the same message before anything is copied, and the others carry on. Self-hosters set `IMPORT_MAX_REPO_KB`. |
| Git transfer | 6 hours. A transfer still running after that fails with `the Git transfer did not finish within 6 hours`. A failed transfer is tried a second time automatically. |
| Single Git object | 100 MB (the push limit). A larger blob can't be imported. |
| Repositories per organization import | 1,000 |
| Concurrency of an organization import | 1 to 8, default 3 |
| Organization import duration | The organization import waits up to a week for its repositories |
| Draft organization imports | Cancelled after 7 days (`draft expired`), and the GitHub token erased |
| Release asset | 2 GiB each |
| Warnings kept per import | 500 |

## Retries, cancelling and the repository lock

**Cancel** an import with **Cancel import** on its page (confirm "Cancel this import?"), or `POST /api/v3/diffinery/imports/{id}/cancel`. Its container is stopped, its credentials are revoked and the repository lock is released. Cancelling one repository of an organization import starts the next queued one. Cancelling a finished import fails with `the import already succeeded` (or `failed`, `cancelled`).

**Retry** a failed or cancelled import with **Retry this import** on its page, or `POST /api/v3/diffinery/imports/{id}/retry`:

- Whoever started the import can retry it. The one exception is an import an agent started: a person who may import into the target (its owner, an owner or admin of the target organization, or a site administrator) can retry it too, and should once the repository exists. Anyone else gets `404 import not found`.
- Give the GitHub token again for a private repository (or for LFS, variables and protection): the first run's token was deleted when it ended. Leave it out for a public repository.
- Retry the whole organization import, not one of its repositories (`retry the organization import this repository belongs to`). Its failed and cancelled repositories are retried; those that failed because the name already existed are not.
- The options can't change on a retry.
- Finished work isn't repeated or duplicated: steps write by GitHub id, and the Git transfer only sends what the repository doesn't have yet.
- An agent can't retry once the repository was created (`an agent cannot retry an import after the repository was created; a person who administers acme must retry it`). A person who administers the target retries it with **Retry this import** or the API, giving the GitHub token again if the source is private.

**The repository lock.** From the moment the import creates the repository until it finishes, fails or is cancelled, only the import may write to it. Any other push gets `repository is locked by an import in progress`, and any other write through the REST API, the web UI or MCP gets `423 repository is locked by an import in progress; try again when it finishes, or cancel the import`. Watching the repository still works, and so do Actions secrets and variables, environments (with their secrets and variables), and collaborators and invitations. The import never writes secret values; its variables step writes GitHub's values, so a variable you set before that step under the same name ends with GitHub's value. The import itself may only create refs or move refs it wrote. A retry claims the repository again only when it holds nothing the import didn't write. If anyone pushed a branch, opened an issue, added a label, a protection rule or a release in the meantime (for example after the import failed and released the lock), the retry fails with `repository already holds content not written by this import; start a new import`. A failed or cancelled import leaves the partly imported repository in place; delete it before importing again under the same name.

## Agents and imports

Agents can start imports over MCP, the REST API or the CLI, with these rules:

- **Only where its owner may import.** An agent owned by a person imports into that person's own account or an organization the person owns or administers (anywhere, if the person is a site administrator). An agent owned by an organization imports into that organization. Otherwise `agents can import only where their owner may: the owner's own account or an organization the owner administers, not <owner>`.
- **The agent's maximum role must be at least `write`** (`this agent's policy does not allow writing; an import needs at least write`), and its token needs the `write` scope.
- **Never a push protection bypass.** The `secrets` option is forced to `stop`.
- **No variables, secret names or environments.** The **Variables and secret names** step, and an organization import's **Organization variables and secret names** step, are skipped with `skipped (agents cannot manage variables)`. A person imports or sets those afterwards. For people, the right to manage variables is checked again when that step runs.
- **No retry after the repository exists.** A person who administers the target takes the retry over.
- **No secret values**, ever. Agents can't set secrets anywhere; a person with admin access sets them.
- An agent sees and lists only the imports it started.

Everything else (Git data, issues, pull requests, reviews, labels, milestones, branch protection, releases) is imported as for a person. See [Agents](/docs/agents/overview).

## After the import

### Set secret values

The import lists secret names; set each value from where you keep it (a password manager, your cloud provider's console). Repository admins who are people can:

- Click **Set secret values** on the import's page. It lists each repository secret name with a `set` or `empty` badge, a **Value** field and **Save**.
- Use the CLI, which prompts for the value without echoing it:

  ```sh
  diffinery secret set NPM_TOKEN -R acme/website
  printf '%s' "$NPM_TOKEN" | diffinery secret set NPM_TOKEN -R acme/website
  diffinery secret set SENTRY_DSN --org acme     # organization secret
  ```

- Use the API (see [Move secrets and variables](#move-secrets-and-variables)).

Environment secrets (listed as `production/DEPLOY_KEY`) are set with the environments API, as in [Environments and their secrets](#environments-and-their-secrets).

You don't have to wait for the import to finish: secrets, variables, environments and collaborators can be set while it is still running (see [Retries, cancelling and the repository lock](#retries-cancelling-and-the-repository-lock)). Set them before your first push, because that push starts the imported workflows.

### Check the rest

1. Under **Settings → General**, check the default branch, description and visibility.
2. Under **Settings → Branch protection**, check the imported rules and their required check names.
3. Under **Settings → Collaborators**, add people, and invite your team to the organization.
4. Recreate webhooks under **Settings → Webhooks**.
5. Push a commit and watch the first workflow runs. The import itself started none.
6. If the repository landed under the wrong owner or name, [transfer](/docs/repositories/overview#transfer-a-repository) or [rename](/docs/repositories/overview#rename-a-repository) it once the import has finished (a transfer is refused while the import runs). The old Diffinery URL keeps working.
7. Agent settings in branch protection (**Allow agents to push directly**, **Allow agents to merge pull requests**, **Allow agents to land pull requests through auto-merge** and its approval waiver) never come across with an import; an admin sets them here.

## Move with plain Git

If you only need the code, copy it with Git (2.26 or newer). Create an empty repository on Diffinery first (web: `https://diffinery.com/new`, or CLI), using the same default branch name as on GitHub:

```sh
diffinery repo create website --org acme --private --default-branch main
```

Then copy every branch and tag:

```sh
git clone --mirror https://github.com/acme/website.git
cd website.git
git push https://diffinery.com/acme/website.git 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'
```

Push branches and tags explicitly rather than with `git push --mirror`: a mirror clone from GitHub also contains GitHub's `refs/pull/*` refs, and Diffinery rejects pushes to `refs/pull/` (`refs/pull/ is managed by Diffinery for pull requests`).

If the push is over 100 MB, it fails with `push exceeds 100 MB; split it into smaller pushes`. Push the history in steps, oldest first:

```sh
# Push the default branch in chunks of 2,000 commits, then everything else
for sha in $(git rev-list --reverse --first-parent main | awk 'NR % 2000 == 0'); do
  git push https://diffinery.com/acme/website.git "$sha:refs/heads/main"
done
git push https://diffinery.com/acme/website.git 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'
```

If push protection blocks the push because old commits contain something that looks like a credential, rotate that credential. A repository admin (a person, not an agent) using an `admin`-scoped token can then push anyway with a reason, which is audited:

```sh
git push -o allow-secrets="historic keys, all rotated" https://diffinery.com/acme/website.git 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'
```

If GitHub's default branch isn't the one you created the repository with, change it under **Settings → General → Default branch**.

## Move releases

The importer copies releases and their assets. If you moved the code with plain Git or `--local`, recreate releases with the GitHub-compatible releases API once the tags are on Diffinery. This script uses GitHub's `gh` CLI to read each release and `curl` to recreate it, oldest first so the newest ends up as the latest release, and copies its assets:

```sh
export DIFFINERY_TOKEN=dfy_...     # write scope or higher
SRC=acme/website                   # on GitHub
DST=acme/website                   # on Diffinery
API=https://diffinery.com/api/v3

gh release list -R "$SRC" --limit 1000 --json tagName --jq 'reverse | .[].tagName' |
while read -r tag; do
  gh release view "$tag" -R "$SRC" --json tagName,name,body,isDraft,isPrerelease \
    --jq '{tag_name: .tagName, name: .name, body: .body, draft: .isDraft, prerelease: .isPrerelease}' > release.json
  id=$(curl -fsS -X POST "$API/repos/$DST/releases" \
    -H "Authorization: Bearer $DIFFINERY_TOKEN" -H "content-type: application/json" \
    --data-binary @release.json | jq -r .id)
  rm -rf assets && mkdir assets
  gh release download "$tag" -R "$SRC" -D assets 2>/dev/null || true
  for f in assets/*; do
    [ -f "$f" ] || continue
    name=$(jq -rn --arg n "$(basename "$f")" '$n | @uri')
    curl -fsS -o /dev/null -X POST "https://diffinery.com/api/uploads/repos/$DST/releases/$id/assets?name=$name" \
      -H "Authorization: Bearer $DIFFINERY_TOKEN" -H "content-type: application/octet-stream" \
      --data-binary @"$f"
    echo "$tag: uploaded $(basename "$f")"
  done
done
```

Things to know:

- Push the tags first. If a release's tag is missing on Diffinery, publishing the release creates the tag on the default branch, which is probably not the commit you want.
- Unlike imported releases, each release published this way starts the repository's `on: release` workflows, and webhooks get a `release` event. Disable or guard those workflows during the copy if they publish or deploy.
- Release notes, titles, draft and pre-release state are copied. Authors and dates are not: the releases are created by you, now.
- An asset uploaded through the API can be up to 100 MB.
- Source code archives (**Source code (zip)** and **Source code (tar.gz)**) are not assets: Diffinery builds them from the tag. See [Source code archives](/docs/repositories/overview#source-code-archives).

See [Releases](/docs/collaboration/releases) for the API in full.

## Move Git LFS files

The importer copies Git LFS objects. Neither `git clone --mirror` nor `diffinery migrate github --local` does: they copy only the pointers. If you moved the code that way and the repository uses LFS, copy the files from a clone that can fetch them:

```sh
git clone https://github.com/acme/website.git website-lfs
cd website-lfs
git lfs fetch --all origin
git lfs push --all https://diffinery.com/acme/website.git
```

Files over 100 MB can't be uploaded to Diffinery. See [Git LFS](/docs/repositories/git-lfs).

## Move secrets and variables

### Secrets

GitHub never shows secret values, so you set them again on Diffinery. Get the list of names from the import's summary, from `diffinery migrate github`'s output, or with GitHub's CLI (`gh secret list -R acme/website`). Then set them as in [Set secret values](#set-secret-values), or with the API (an admin role on the repository, and not an agent):

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/actions/secrets/NPM_TOKEN \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" \
  -d '{"value": "npm_..."}'
```

Unlike GitHub, the API takes the plain value over HTTPS; there is no public-key encryption step, and a sealed-box `encrypted_value` is refused (send `value` instead). Secret names use letters, digits and `_`, are stored in upper case, and can't start with `GITHUB_`.

To copy secrets without handling the values yourself, let a GitHub workflow send them, as in [Keep GitHub as upstream](#keep-github-as-upstream-and-mirror-to-diffinery).

### Environments and their secrets

Diffinery has deployment environments with their own secrets, variables and branch policies, like GitHub. The importer creates them with their branch policies and variables. They have no page in the web UI yet: change them, and set their secrets, with the REST API, as a repository admin who is a person (agents can't manage environments, secrets or variables).

```sh
# Create the environment (the importer already did if it came from GitHub)
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/environments/production \
  -H "Authorization: Bearer dfy_..."

# Add its secrets
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/environments/production/secrets/DEPLOY_KEY \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" \
  -d '{"value": "..."}'

# Add its variables
curl -X POST https://diffinery.com/api/v3/repos/acme/website/environments/production/variables \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" \
  -d '{"name": "DEPLOY_URL", "value": "https://www.example.com"}'
```

Jobs with `environment: production` then get these secrets and variables. When an environment without a branch policy gets its first secret, it is limited to protected branches, so add a [branch protection](/docs/repositories/branch-protection) rule for the branch you deploy from (or set the environment's branch policy). Add required reviewers and a wait timer under Settings → Environments. See [Environments](/docs/actions/environments).

### Variables

The importer and `diffinery migrate github --local` copy repository variables. To copy them yourself:

```sh
gh variable list -R acme/website --json name,value --jq '.[] | [.name, .value] | @tsv' |
while IFS=$'\t' read -r name value; do
  diffinery variable set "$name" --body "$value" -R acme/website
done
```

Organization variables are shared by every repository of a Diffinery organization; a repository variable of the same name wins. An organization import copies them. Owners and admins of the organization (people, with an `admin`-scoped token for changes) manage them with `GET` and `POST /api/v3/orgs/{org}/actions/variables` and `GET`, `PATCH` and `DELETE /api/v3/orgs/{org}/actions/variables/{name}`:

```sh
curl -X POST https://diffinery.com/api/v3/orgs/acme/actions/variables \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" \
  -d '{"name": "NPM_REGISTRY", "value": "https://registry.npmjs.org"}'
```

See [Secrets and variables](/docs/actions/secrets-and-variables).

## Update remotes and local clones

Everyone with a clone points it at Diffinery:

```sh
git remote set-url origin https://diffinery.com/acme/website.git
git fetch origin
```

Or keep GitHub as a second remote while you move:

```sh
git remote rename origin github
git remote add origin https://diffinery.com/acme/website.git
git fetch origin
git branch --set-upstream-to=origin/main main
```

Git asks for a password the first time: use a Diffinery token, or run `diffinery auth setup-git` once so Git gets it from the CLI. See [Git over HTTPS](/docs/repositories/git).

People who clone from VS Code, Cursor or Windsurf install the Diffinery extension, which puts **Clone from Diffinery** next to **Clone from GitHub** in the clone picker and signs Git in through the browser: see [Clone in VS Code, Cursor and other editors](/docs/repositories/clone-in-your-editor). People who use IntelliJ IDEA, PyCharm, WebStorm, GoLand or another JetBrains IDE install the Diffinery plugin, which adds **Diffinery** next to GitHub in **Get from Version Control**: see [Clone in JetBrains IDEs](/docs/repositories/clone-in-jetbrains-ides).

Also update anything else that holds the old URL: CI and deploy scripts, package manifests (`repository` fields), submodule URLs in `.gitmodules`, badges and links in READMEs.

## Workflows

Diffinery runs GitHub Actions workflows from `.github/workflows/` as they are: the same triggers, expressions, matrices, `needs`, job outputs, caches, artifacts, secrets, `GITHUB_TOKEN` permissions, OIDC, `actions/checkout`, `actions/setup-node`, `setup-python`, `setup-go`, `actions/github-script`, and remote JavaScript and composite actions. `runs-on: ubuntu-latest` runs on Diffinery's hosted runners. An import starts no workflow runs; the first push after it does.

Things to check after the move:

| If a workflow... | Do this on Diffinery |
| --- | --- |
| Has jobs that mostly wait (deploys, API calls, polling), or runs on every push | They run as they are. To spend less hosted runner time, pin a smaller size for waiting jobs (`runs-on: [ubuntu-latest, diffinery-small]`) and cancel superseded pull request runs with a `concurrency` group. See [What hosted jobs cost](/docs/actions/runners#what-hosted-jobs-cost-and-keeping-it-low). |
| Uses `runs-on: windows-*` or `macos-*` | Diffinery has no Windows or macOS hosted runners: Cloudflare Containers run Linux only. Run the job on a self-hosted runner (`diffinery runner`). See [Runners](/docs/actions/runners). |
| Uses `actions/github-script` | Works with the REST API (`github.rest.*`) and the job's token. `github.graphql` works for the issues, pull requests and CI that Diffinery's [GraphQL API](/docs/reference/graphql-api) answers. |
| Relies on `GITHUB_TOKEN` writing (comments, labels, statuses, releases, pushes) without a `permissions:` block | Repositories created on Diffinery, imported ones included, give the job token GitHub's restricted default, `contents` and `packages` read. Add a `permissions:` block (for example `contents: write`, `issues: write`, `pull-requests: write`) to the workflow or job, or have an admin set the repository default to write. Each endpoint needs its permission, as on GitHub; a missing one gets `403 Resource not accessible by integration`. See [Workflow permissions](/docs/actions/workflow-permissions). |
| Pushes commits or tags using `GITHUB_TOKEN` | Works with `permissions: contents: write`, as on GitHub, within branch protection. The token can't change files under `.github/workflows/`, and a push made with it starts no new `push` workflows. |
| Opens or approves pull requests using `GITHUB_TOKEN` | Refused until a repository admin allows it (`can_approve_pull_request_reviews` in the workflow permissions setting, off by default, as GitHub's **Allow GitHub Actions to create and approve pull requests**). Approvals from the token never count toward required approvals. |
| Uses environments (`environment: production`) | The importer creates the environments and their variables; set their secrets with the API (see [Environments and their secrets](#environments-and-their-secrets)). Required reviewers and wait timers don't come across; set them again under Settings → Environments. |
| Runs on `release` or `repository_dispatch` | Works: publishing a release on Diffinery starts `on: release` workflows, and `POST /api/v3/repos/acme/website/dispatches` starts `on: repository_dispatch` workflows. |
| Checks out Git LFS files (`lfs: true`) | Works as on GitHub. See [Git LFS](/docs/repositories/git-lfs). |
| Publishes images to `ghcr.io` | Use your instance's registry (`diffinery.com` here) instead. See [Container registry](/docs/packages/container-registry). |
| Hard-codes `github.com` or `api.github.com` | Use `${{ github.server_url }}` (`https://diffinery.com`) and `${{ github.api_url }}` (`https://diffinery.com/api/v3`). |
| Should run only on one forge | Guard it with `if: github.server_url == 'https://github.com'` (or `'https://diffinery.com'`). |

A job that uses an unsupported feature fails with a message saying so. `diffinery workflow validate` checks workflow files before you push. Full details are in [Compatibility with GitHub Actions](/docs/actions/compatibility).

## Scripts and tools that call GitHub's API

Diffinery serves a GitHub-compatible REST API at `https://diffinery.com/api/v3`, with the same paths, JSON shapes, errors and `Link`-header pagination, so most scripts and Octokit-based tools only need a new base URL and a Diffinery token:

```js
import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.DIFFINERY_TOKEN, baseUrl: "https://diffinery.com/api/v3" });
const { data } = await octokit.rest.repos.listReleases({ owner: "acme", repo: "website" });
```

Inside workflows, `${{ github.api_url }}` is already `https://diffinery.com/api/v3`. Imported people without a Diffinery account come back as user objects with `"type": "Mannequin"` and a `github:` login, so tools that look up users by login should expect them. Differences to check, including endpoints and features that are not supported yet, are listed in the [REST API reference](/docs/reference/rest-api). The [GraphQL API](/docs/reference/graphql-api) covers repositories, issues, pull requests and CI, which is what the GitHub CLI needs (see [GitHub CLI and Claude Code](/docs/agents/github-cli)).

## Keep GitHub as upstream and mirror to Diffinery

You can keep GitHub as the place where people push and review, and mirror every push to Diffinery with a GitHub Actions workflow. Diffinery then runs its own Actions on each mirrored commit. Diffinery itself was developed this way: its GitHub repository mirrors every branch and tag, plus the secrets its workflows need, to Diffinery on each push, and fails if the runs on Diffinery fail.

Set it up:

1. Create the Diffinery repository (for example `acme/website`).
2. Create a Diffinery token with the `admin` scope for an account that is an admin of that repository. If you want force pushes to protected branches to go through, protection rules must let admins bypass them.
3. On GitHub, add it as a repository secret named `DIFFINERY_TOKEN`.
4. Add this workflow on GitHub as `.github/workflows/mirror-to-diffinery.yml`:

```yaml
name: Mirror to Diffinery

on:
  push:
  workflow_dispatch:

permissions:
  contents: read

# One mirror at a time, in push order.
concurrency:
  group: mirror-to-diffinery
  cancel-in-progress: false

jobs:
  mirror:
    # The mirrored copy of this file also exists on Diffinery; do nothing there.
    if: ${{ github.server_url == 'https://github.com' }}
    runs-on: ubuntu-latest
    env:
      DIFFINERY: https://diffinery.com
      TARGET: acme/website
      TOKEN: ${{ secrets.DIFFINERY_TOKEN }}
    steps:
      - name: Copy Actions secrets
        env:
          S_NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          S_SENTRY_DSN: ${{ secrets.SENTRY_DSN }}
        run: |
          set -euo pipefail
          for name in NPM_TOKEN SENTRY_DSN; do
            v="S_$name"
            [ -n "${!v}" ] || { echo "::warning::secret $name is empty here; not copied"; continue; }
            jq -n --arg v "${!v}" '{value: $v}' | curl -fsS -o /dev/null -X PUT \
              "$DIFFINERY/api/v3/repos/$TARGET/actions/secrets/$name" \
              -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" --data-binary @-
            echo "secret $name copied"
          done

      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # lfs: true   # if the repository uses Git LFS

      - name: Push every branch and tag
        run: |
          set -euo pipefail
          git fetch -q --tags origin '+refs/heads/*:refs/remotes/origin/*'
          refs=$(git for-each-ref --format='+%(refname):refs/heads/%(refname:lstrip=3)' refs/remotes/origin | grep -v ':refs/heads/HEAD$')
          git -c "http.$DIFFINERY/.extraHeader=Authorization: Bearer $TOKEN" \
            push -q "$DIFFINERY/$TARGET.git" $refs '+refs/tags/*:refs/tags/*'
          # If the repository uses Git LFS:
          # git lfs ls-files | grep -q . && git -c "http.$DIFFINERY/.extraHeader=Authorization: Bearer $TOKEN" lfs push --all "$DIFFINERY/$TARGET.git"
```

How it works:

- The checkout fetches the full history, then every GitHub branch is pushed to the branch of the same name on Diffinery, with a leading `+` so GitHub always wins. Changes made directly on Diffinery to mirrored branches are overwritten.
- Branches deleted on GitHub are not deleted on Diffinery. Delete them there by hand (`git push https://diffinery.com/acme/website.git --delete old-branch`).
- The secrets step sends each value from GitHub's secret store, inside your own workflow, straight to Diffinery over HTTPS; values are never printed. List every secret your workflows use. Variables can be copied the same way with `vars.NAME` and the `actions/variables` endpoint.
- The `if:` guard keeps the job from running on Diffinery, which also runs `.github/workflows/` files once they are mirrored.
- If push protection blocks a mirrored push, a repository admin can let it through with `-o allow-secrets=<reason>` on the `git push` line, for example from a `workflow_dispatch` input. Leave it empty normally.

### Wait for Diffinery's runs

To make the GitHub workflow fail when the workflows on Diffinery fail, add a step that polls Diffinery's runs for the pushed commit:

```yaml
      - name: Wait for Actions on Diffinery
        if: github.ref == 'refs/heads/main'
        run: |
          set -euo pipefail
          sha=$(git rev-parse HEAD)
          api() { curl -fsS "$DIFFINERY/api/v3/repos/$TARGET$1" -H "Authorization: Bearer $TOKEN"; }
          for i in $(seq 1 240); do
            runs=$(api "/actions/runs?head_sha=$sha&per_page=100")
            total=$(jq '.workflow_runs | length' <<<"$runs")
            pending=$(jq '[.workflow_runs[] | select(.status != "completed")] | length' <<<"$runs")
            [ "$total" -gt 0 ] && [ "$pending" = 0 ] && break
            sleep 15
          done
          jq -r '.workflow_runs[] | "\(.name) [\(.event)]: \(.status) \(.conclusion) \(.html_url)"' <<<"$runs"
          [ "$(jq '[.workflow_runs[] | select(.conclusion != "success")] | length' <<<"$runs")" = 0 ]
```

`GET /api/v3/repos/{owner}/{repo}/actions/runs?head_sha=<sha>` lists the runs for a commit, with `status`, `conclusion` and `html_url`; `GET .../actions/runs/{id}/jobs` and `GET .../actions/jobs/{id}/logs` give the jobs and logs of a failed run. Runs started by other runs (`workflow_run`) can appear after the first ones finish, so a robust script waits until the list stays complete for a few polls.

## Checklist

1. Get a Diffinery account and create the organization.
2. Link your GitHub account under **Settings → Linked accounts**, and ask your team to link theirs, so their work is attributed to them.
3. Create a GitHub token that can read the repositories (admin access for branch protection, variables and secret names).
4. Import: **Settings → Imports → Import from GitHub**, `diffinery migrate github acme/website --to acme/website`, or `diffinery migrate github-org acme --to acme`.
5. Read the import's **Warnings** and rotate anything under **Possible secrets in history (rotate these)**.
6. Set every secret listed (**Set secret values**), environment secrets with the API, and organization secrets with `diffinery secret set NAME --org acme`.
7. Check the default branch, description and visibility under **Settings → General**, and the imported rules under **Settings → Branch protection** (required check names are `<workflow name> / <job name>`; see [Branch protection](/docs/repositories/branch-protection)).
8. Add collaborators under **Settings → Collaborators**, and invite your team to the organization.
9. Recreate webhooks under **Settings → Webhooks**. Deliveries carry GitHub's `X-GitHub-Event` header and are signed with `X-Hub-Signature-256`, but check the payload fields your receiver uses. Failed deliveries (network errors, `408`, `429` and `5xx`) are retried up to five times with the same `X-GitHub-Delivery` ID, so make your receiver ignore a delivery ID it has already handled. See [Webhooks](/docs/repositories/webhooks).
10. If an outside CI system reported commit statuses or checks to GitHub, point it at `https://diffinery.com/api/v3` with a Diffinery token. Its status contexts and check names can be required checks in branch protection, as on GitHub. See [Checks and statuses](/docs/collaboration/checks-and-statuses).
11. Push a commit and watch the first workflow runs in the **Actions** tab (or `diffinery run list -R acme/website`). Fix anything from [Workflows](#workflows).
12. Create agent accounts for AI tools and connect them over MCP. See [Agents](/docs/agents/overview).
13. Update remotes on every clone, and URLs in scripts, manifests and READMEs.
14. When the team has moved, archive the GitHub repository or remove the mirror workflow.

## Troubleshooting

### Starting an import

| Message | Cause and fix |
| --- | --- |
| `GitHub repository acme/website was not found or the token cannot read it` | The name is wrong, or the repository is private and the GitHub token is missing or can't see it. |
| `GitHub rejected the token (expired or revoked?)` | Create a new GitHub token. |
| `acme has reached its storage limit of N bytes (...)` | The Diffinery owner is at its [storage quota](/docs/reference/limits#account-quotas). An import stores what it copies, so it is refused up front, and one that reaches the limit on the way stops with the same message. Free space or ask a site administrator to raise it, then retry. |
| `no GitHub organization or user named acme` | Check the spelling, and `github_api_url` for Enterprise. |
| `acme has no repositories to import` | The account has none the token can see, or the filters excluded all of them. |
| `acme/website already exists; choose another name` | Pick another `name` (or **New repository name**), or delete the existing repository. |
| `you can import only into your own account or organizations you administer, not acme` | Ask an owner of `acme` to make you an admin, or to run the import. |
| `agents can import only where their owner may: ...` | The target isn't the owner's own account or an organization the owner administers (or, for an organization's agent, that organization). |
| `starting an import needs a token with write or admin scope` | Use a `write` or `admin` token. |
| `this token needs the write scope` or `this token is limited to repositories and can't change account settings` | Cancelling, retrying and choosing repositories need a `write` token that isn't restricted to repositories. |
| `too many repository imports are already running (at most 3 at a time); wait for one to finish` | Wait for one to finish, or cancel one. |
| `an organization import is already in progress (at most 1 at a time); wait for it to finish or cancel it` | Includes drafts waiting on **Choose repositories**. Finish or cancel it. |
| `the repository is about N GB, over the 10 GB import limit; ...` | Split the repository, or on your own instance raise `IMPORT_MAX_REPO_KB`. |
| `give either source (one repository) or source_owner (an organization or user)` | Send exactly one of them. |
| `github_api_url is required when a github_token is given and the source names a GitHub Enterprise host` | Add `github_api_url` for that host, or pass `owner/name` as the source. |
| `github_api_url must be on the same host as the source repository` | The API URL and the source URL name different hosts. |
| `GitHub rate limit reached; continuing in N seconds` | Shown on a step while the importer waits; it continues by itself. At start time it comes back as `429`; try again later or use a GitHub token. |

### While an import runs

| Message | Cause and fix |
| --- | --- |
| `Push protection found possible secrets in the history (...)` | See [Secrets in old history](#secrets-in-old-history). |
| `a single Git object of N MB could not be pushed even on its own (...)` | One file in the history is too large for Diffinery to take in one push (the server's answer is in brackets). Remove it from history on GitHub (for example with `git filter-repo`), or move it to Git LFS, and import again. |
| `pushes kept failing even in chunks of N KB (...)` | Diffinery kept refusing or dropping the transfer's pushes; the server's answer is in brackets. Retry the import; if it fails the same way, report it. |
| `the Git transfer did not finish within 6 hours` | The repository is too large or GitHub was too slow. Retry, or split the repository. |
| `the import container stopped before finishing (exit code ...)` | The transfer is retried once automatically; after that, retry the import. |
| `The Git transfer failed and is being retried: ...` (warning) | The first transfer failed and a second one started. Nothing to do. |
| `repository is locked by an import in progress` (on a push), or `423 repository is locked by an import in progress; try again when it finishes, or cancel the import` | You wrote to a repository an import is still filling. Wait for the import to finish, or cancel it. Actions secrets and variables, environments and collaborators aren't locked: set them while the import runs. |
| `repository already holds content not written by this import; start a new import` | Someone changed the repository between attempts. Start a new import under another name, or delete the repository first. |
| `skipped (agents cannot manage variables)` | An agent started the import. A person sets variables and secrets afterwards. |
| `skipped (you no longer administer the target)` | You lost admin rights on the target before the variables step ran. |
| `Branch protection of main could not be read ...` | The GitHub token lacks admin access. Set the rule up under **Settings → Branch protection**. |
| `Actions variables could not be read ...` (or `secrets`, `environments`) | Give the token admin access, or the fine-grained **Variables** and **Secrets** read permissions, and set the rest by hand. |
| `N pull requests have no head commit (their fork was deleted on GitHub): ...` | Those pull requests are imported without their commits. Nothing to do. |
| `the person or agent who started this import can no longer import into this account` | The starter lost the right to import there, or their account was disabled. |

### Retrying and cancelling

| Message | Cause and fix |
| --- | --- |
| `import not found` | You didn't start the import (only the starter can retry, or for an agent's import a person who administers the target), or you can't see it. |
| `only failed or cancelled imports can be retried` | The import is still running or succeeded. |
| `retry the organization import this repository belongs to` | Retry the parent import. |
| `an agent cannot retry an import after the repository was created; a person who administers <owner> must retry it` | A person who administers the target retries it. |
| `the import already succeeded` (or `failed`, `cancelled`) | Only drafts and queued or running imports can be cancelled. |

### Linking a GitHub account

| Message | Cause and fix |
| --- | --- |
| `create a PUBLIC gist whose description or a file contains diffinery-link-..., then try again` | The gist is missing, secret, or doesn't contain the exact code. |
| `GitHub user diffy was not found` | Check the username and the host. |
| `GitHub user diffy is linked to another Diffinery account` | Unlink it there first, or ask a site administrator to clear the link. |
| `that is not a valid GitHub login` | Use the username, not an email address or URL. |
| `invalid or expired OAuth state` | Start **Continue to GitHub** again from your own settings page. |

### Errors from the local import

| Message | Cause and fix |
| --- | --- |
| `git clone --mirror failed: ...` | Git couldn't clone from GitHub. Check `GH_TOKEN` and that Git is installed. |
| `warning: bulk push failed (...); pushing refs one at a time` | One push was too big or a ref was rejected. Check the refs listed as failed in the summary. |
| A ref fails with `secret detected (push protection)` | Rotate the credential, then push that ref with plain Git and `-o allow-secrets=<reason>` as a repository admin, or use the server-side importer. |
| A ref fails with `push exceeds 100 MB` | Push that branch's history in steps, as in [Move with plain Git](#move-with-plain-git), or use the server-side importer. |
| `could not read ... from GitHub (403; the token may lack access)` | The GitHub token can't read that data. |
| `agents cannot manage variables` or `agents may not push to protected or default branches` | `--local` needs a token of your own account, not an agent's. |
