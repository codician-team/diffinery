---
title: Concepts
description: The Diffinery mental model in one page: accounts, agents, repositories, roles, tokens, checks, releases, environments, Actions and audit.
---

This page explains the building blocks of Diffinery and how they fit together. Each section is a short summary with a link to the page that covers it in full. If you know GitHub, most ideas carry over; the differences are called out as you go.

All of it happens on a Diffinery instance: one you have an account on, or one you [deploy to your own Cloudflare account](/docs/self-hosting/deploy). The examples use `https://diffinery.com` as the instance's address.

## Accounts

Every action on Diffinery is taken by an account. There are three kinds: users, organizations and agents. All three share one namespace, so `https://diffinery.com/diffy`, `https://diffinery.com/acme` and `https://diffinery.com/review-bot` are all account pages, and repositories live under users and organizations.

### Users

A user is a person. Diffinery is invite-only unless an instance turns on [open sign-up](/docs/accounts/passkeys-and-sign-in#open-sign-up): you join by opening an invite link (or, with open sign-up, confirming your email address), choosing a username and creating a passkey. There are no passwords. In the browser you sign in with a passkey; everything outside the browser (Git, the CLI, the REST API, MCP clients) uses a [token](#tokens).

Site administrators are users with admin access to every repository and to the **Site administration** section of settings (**People and invitations**, **Email** and **Audit log**).

See [Passkeys and sign-in](/docs/accounts/passkeys-and-sign-in), [Invitations](/docs/accounts/invitations) and [Site administration](/docs/admin/site-administration).

### Organizations

An organization is a shared account that owns repositories, agents, container images and Actions secrets for a group of people. Members have one of three roles, which decide their role on every repository the organization owns:

| Organization role | Role on the organization's repositories |
| --- | --- |
| member | The organization's base permission: `none`, `read`, `write` or `admin` |
| admin | admin |
| owner | admin, plus managing owners and renaming the organization |

The base permission is a setting of the organization, as on GitHub: new organizations start with `read`, and owners change it on the organization's **Settings** tab. A member who creates a repository in the organization gets `admin` on it. Unlike GitHub, there are no teams and no custom roles. To give someone more access to a single repository, add them as a collaborator on it. See [Organizations](/docs/accounts/organizations) and [Base permission](/docs/accounts/organizations#base-permission).

### Agents

An agent is an account for an AI tool or an automation, such as `review-bot`. It is owned by a user or an organization, acts on their behalf and authenticates only with tokens: it can't have a passkey, so it never signs in to the web UI. GitHub has no equivalent; the closest thing is a bot account or a GitHub App.

Agents are held to guardrails that keep a person in the loop:

- An agent never has more access than its owner. An organization's agent can reach only that organization's repositories.
- Its maximum role is `write` unless its owner chooses otherwise.
- It can't push to, or merge into, the default branch or a protected branch, unless a branch protection rule explicitly allows it. A rule can instead let it turn on auto-merge, so Diffinery merges its pull request once the required checks pass and a person approves (or, if an admin waives that, on green checks alone).
- A pull request it opens needs at least one approval from a person, and its own approvals never count.
- It can't change branch protection, add, change or delete secrets or variables (repository, organization or environment), create, change or delete environments, dismiss reviews, delete or transfer repositories, or bypass push protection.
- Commit statuses and check runs it reports never satisfy a required check, and tags it pushes never match an environment's tag rules.
- Commits it makes carry a `diffinery-agent` header naming the agent and the person it acts for.
- A workflow run whose code came from an agent (the agent triggered it, pushed the branch last, or opened the pull request, and re-runs and `workflow_run` followers of such a run) acts as the agent, so a workflow can't carry agent-written code past these rules.
- It can import from GitHub only into an organization it or its owner administers, its imports never bypass push protection, and they skip variables, secret names and environments.

Agents work through the [MCP server](/docs/agents/mcp), the REST API, the CLI and Git. Diffinery can also run one for you: an [agent task](/docs/agents/tasks) gives one of your agents a goal and runs Claude Code, Codex or your own command with your own model key, then opens a pull request, a [terminal](/docs/agents/terminal) gives you a shell in a sandbox where Claude Code or Codex runs on your own subscription and can take tasks too, a repository's [project](/docs/agents/projects) puts its tasks on a board with shared memory and instructions, and [agent review](/docs/agents/review) has one review pull requests for bugs. [Today](/docs/agents/today), the first page after signing in, shows what needs you and what your agents are doing. See [Agents](/docs/agents/overview).

### People imported from GitHub

When you [import from GitHub](/docs/migrate-from-github), no accounts are created. A GitHub user whose GitHub account is linked to a Diffinery account (under **Settings → Linked accounts**, matched by GitHub's numeric user id) is credited to that account. Everyone else becomes a **mannequin**: a placeholder that carries their issues, comments and reviews under their GitHub login, with a **GitHub** badge in the web UI and `"type": "Mannequin"` and a `github:<login>` login in the API. A mannequin isn't an account: it can't sign in or act. Imported reviews, whoever wrote them, are history and never count as approvals. See [People: linked accounts and mannequins](/docs/migrate-from-github#people-linked-accounts-and-mannequins).

## Repositories

A repository holds a project's Git history plus its issues, pull requests, reviews, checks, releases, deployment environments, workflow runs, webhooks, secrets and variables. It lives at `https://diffinery.com/<owner>/<name>` (for example `https://diffinery.com/acme/website`) and is cloned from the same URL with `.git` appended.

New repositories are private and use `main` as the default branch unless you choose otherwise.

A repository can be renamed, or transferred to your own account or to an organization you own or administer. Its old URLs keep working, as on GitHub: web pages and the REST API redirect, and Git, MCP and container images are served under the old name, for anyone who can still read it.

To move from GitHub, the server-side importer copies a repository, or every repository of an organization, with its history, issues and pull requests (keeping their numbers), comments, reviews, labels, milestones, releases, branch protection, variables and environments. Secret values are never copied, only their names. Start it from **Settings → Imports**, `diffinery migrate github`, the REST API or MCP. See [Migrate from GitHub](/docs/migrate-from-github).

There is no forking. Pull requests are always between two branches of the same repository, so contributors need write access to push a branch.

Repositories can carry topics, and any branch, tag or commit can be downloaded as a `.zip` or `.tar.gz` source archive. Code is shown with syntax highlighting.

See [Repositories](/docs/repositories/overview), [Browsing code](/docs/repositories/browsing-code), [Git over HTTPS](/docs/repositories/git) and [Git LFS](/docs/repositories/git-lfs).

## Visibility

A repository is either **private** or **public**.

| Visibility | Who can see it |
| --- | --- |
| Private | The owner, organization members (for organization repositories, unless the organization's base permission is `none`), collaborators and site administrators |
| Public | Everyone, including people who aren't signed in. Signed-in users get `read`. |

Someone without access to a private repository gets `404 repository not found`, never `403`, so its name isn't revealed. Writing to a public repository still needs a signed-in account (or a token) with a role that allows it. People who aren't signed in can only read: opening an issue, commenting, reacting or pushing without an account fails with `401 authentication required` (for a push, Git then asks for your token). See [Visibility](/docs/repositories/overview#visibility).

## Roles

Every request to a repository runs with one effective role. Diffinery uses GitHub's five repository roles, and each one includes the ones before it:

| Role | In short |
| --- | --- |
| `read` | View and clone; when signed in, also open issues and comment |
| `triage` | Manage issues, pull requests and labels without pushing code |
| `write` | Push, open and merge pull requests, run workflows |
| `maintain` | Also move or delete tags, edit other people's comments and dismiss reviews |
| `admin` | Settings, access, branch protection, secrets and webhooks |

Your role on a repository comes from owning it, your organization role (members get the organization's base permission), a collaborator grant or the repository being public, whichever is highest. Tokens and agent limits can then only lower it. See [Permissions](/docs/accounts/permissions).

## Tokens

A personal access token lets Git, the `diffinery` CLI, scripts and MCP clients act as you (or as an agent). Tokens start with `dfy_`, are shown once when you create them, and last 1 to 366 days (90 by default). Diffinery emails you whenever a token is created on your account.

Each token has a scope that caps your role, whatever your role actually is:

| Scope | Highest effective role |
| --- | --- |
| `read` | read |
| `write` | maintain |
| `admin` | admin |

A `read` token can only read: it can clone and fetch, download Git LFS files, call `GET` endpoints and use the MCP tools that only read, and every change it attempts fails with `403 this token needs the write scope`. New tokens get the `write` scope unless you choose another; scopes other than `read`, `write` and `admin` are refused (`422`).

Some actions belong to your account rather than to a repository, and need a minimum scope whatever your role:

| Action | Token scope needed |
| --- | --- |
| Create a repository | `write` |
| Create an organization, send invitations, manage organization secrets | `admin` |
| Create or revoke tokens, create or disable agents, create agent tokens | `admin` |

A token can also be restricted to a list of repositories; every other repository then answers `404` as if you had no access, and the token can't create repositories or organizations, send invitations, manage agents or create other tokens. A token can only be restricted to repositories your account can see. Browser sessions aren't capped, so in the web UI you always act with your full role. Unlike GitHub's fine-grained tokens, there are no per-permission settings: the scope and the repository list are the whole model.

Use a token as the Git password (with any username), as `Authorization: Bearer dfy_...` for the API and MCP, or let `diffinery login` and `diffinery auth setup-git` store it. See [Personal access tokens](/docs/accounts/tokens).

## Job tokens

Each workflow job gets a short-lived job token as `GITHUB_TOKEN` (also `DIFFINERY_TOKEN`). It starts with `djt_`, acts as `diffinery-actions[bot]` on the repository the job runs in (it can also read other public repositories) and stops working when the job completes.

As on GitHub, the token can do what the workflow's `permissions:` grant (`contents`, `issues`, `pull-requests`, `statuses`, `packages` and so on), and an endpoint it lacks the permission for answers `403 Resource not accessible by integration`. Without `permissions:`, a job gets the repository's default, which for new repositories is GitHub's restricted one (`contents` and `packages` read); a repository admin can change it (see [Workflow permissions](/docs/actions/workflow-permissions)). The token never acts above `write`, so branch protection applies; it never changes repository settings, secrets or workflow files; it can't open or approve pull requests unless the repository allows it, and its approvals never count; and a run whose code came from an agent acts as that agent.

Sandboxes get a similar token starting with `dst_` (see [Sandboxes](#sandboxes)). See [Job tokens and sandbox tokens](/docs/accounts/permissions#job-tokens-and-sandbox-tokens) and [Secrets and variables](/docs/actions/secrets-and-variables).

## Branch protection

A branch protection rule matches branch names with a pattern such as `main`, `release/*` (one path segment) or `release/**` (any depth), and controls how matching branches can change: whether changes must go through a pull request, how many approvals and which checks are required, whether force pushes, deletion and merge commits are allowed, whether a merge queue is used, and what agents may do. The server enforces the rules for every way a branch can change, whether through `git push`, the REST API, MCP or the web UI.

Required checks can be workflow jobs, check runs or commit statuses reported by other tools. When Diffinery Actions reports a check, it alone decides that check; to have another tool decide a required check, a rule binds the check to that reporter. See [Checks and statuses](/docs/collaboration/checks-and-statuses).

Some protections apply even without any rule: the default branch can't be deleted, and agents can't push to it or merge into it. When several rules match a branch, the rule that names the branch exactly wins over patterns; otherwise the oldest matching rule applies.

Repository admins can bypass the rules unless the rule sets **Do not allow administrators to bypass these rules** (`enforceAdmins`). A push by an admin bypasses them on its own. A merge doesn't: an admin has to ask for it explicitly (the **Merge without waiting for requirements (bypass)** button, `"bypass_rules": true` in the API, or `diffinery pr merge --admin`), and the bypass is recorded in the audit log as `pull_request.merge_bypassed`. `"bypass_rules": true` skips unmet rules, and `"bypass_merge_queue": true` skips only a required merge queue. Bypassing merge requirements is for people only, never agents, and never works for a draft or a pull request with conflicts.

See [Branch protection](/docs/repositories/branch-protection) and [Merge queue](/docs/collaboration/merge-queue).

## Pull requests with intent

A pull request proposes merging one branch (the head) into another (the base) of the same repository. Pull requests and issues share one number sequence per repository, as on GitHub.

Besides a title and a description, every pull request can carry an **intent**: one or two sentences on what the change is meant to achieve, for example "Fix the race in token refresh without changing the public API." The intent is shown at the top of the pull request, included in notification emails and returned by the API, the CLI and MCP, so reviewers, human or AI, can check the diff against the stated goal. It can't be edited after the pull request is opened, and agents should always set it.

A pull request can be opened as a **draft**: a draft can't be merged until it is marked ready for review (the **Ready for review** button, `diffinery pr ready`, or `PATCH` with `"draft": false`), and it can be turned back into a draft later.

Pull requests are reviewed with **Approve**, **Request changes** or comments, checked by workflow runs and other CI, and merged with a merge commit, a squash or a fast-forward rebase once nothing blocks them. With **auto-merge** turned on, Diffinery merges a pull request by itself as soon as nothing blocks it. See [Pull requests](/docs/collaboration/pull-requests) and [Issues](/docs/collaboration/issues).

## Actions

Diffinery Actions runs GitHub Actions workflows from `.github/workflows/` (or `.diffinery/workflows/`) on Cloudflare. Most existing workflow files run unchanged; differences are listed in [Compatibility with GitHub Actions](/docs/actions/compatibility).

### Runs, jobs and steps

| Term | Meaning |
| --- | --- |
| Workflow | A YAML file that says when to run (`on:`) and what to run (`jobs:`). |
| Event | What starts a workflow: a push, a pull request update, a merge queue group, a manual dispatch, a schedule, another workflow's run, a published release or a `repository_dispatch` API call. |
| Run | One execution of one workflow for one event, with a number, a status and a conclusion. |
| Job | A set of steps that runs on one runner. Jobs run in parallel unless linked with `needs`; a matrix expands one job into several. |
| Step | One command (`run:`) or one action (`uses:`), run in order in the job's workspace. |
| Check | The result of one job, reported on the commit as `<workflow name> / <job name>`, for example `CI / test`. Branch protection can require it. |
| Environment | A deployment target such as `production`, with its own secrets, variables and branch policy. A job with `environment:` gets them only if the policy allows the ref. |

Runs are orchestrated durably, so they survive platform restarts, and a job can run for at most 6 hours. See [Actions overview](/docs/actions/overview), [Workflow syntax](/docs/actions/workflow-syntax) and [Events that trigger workflows](/docs/actions/events).

### Runners

A runner is the machine that executes one job. You pick one per job with `runs-on`:

- **Hosted runners** run each job in a fresh Ubuntu 24.04 container on Cloudflare. `runs-on: ubuntu-latest` and similar labels use them.
- **Self-hosted runners** run jobs on a machine you control, such as a Mac, a GPU box or a server on a private network. You start one with `diffinery runner`, and jobs with `runs-on: self-hosted` (plus any other labels) go to it.

See [Runners](/docs/actions/runners).

## Checks and commit statuses

A check is a pass or fail result attached to a commit. Diffinery Actions reports one check per job. Other tools report results over the GitHub-compatible REST API, either as **commit statuses** (a state and a context name, such as `ci/external`) or as **check runs**. All of them appear together on the commit and the pull request, and branch protection can require any of them by name. See [Checks and statuses](/docs/collaboration/checks-and-statuses).

## Releases

A release marks a tag as a version you ship, with a title, Markdown release notes and downloadable files (assets, up to 100 MB each). Releases can be drafts or pre-releases, one of them is the latest, and notes can be generated from the merged pull requests. Each release page also links to source archives of its tag. Publishing a release starts `on: release` workflows and sends a `release` webhook. Manage releases at `https://diffinery.com/acme/website/releases`, with the REST API or with the MCP release tools. See [Releases](/docs/collaboration/releases).

## Environments and deployments

An environment, such as `staging` or `production`, groups the secrets and variables a deployment needs with a policy for which branches and tags may deploy to it. A workflow job that names an environment (`environment: production`) creates a deployment, gets that environment's secrets and variables, and is refused if the policy doesn't allow its ref. Environment secrets never reach pull request runs. Tools outside Actions can record deployments and their status through the REST API, as on GitHub. Environments are managed with the REST API by repository admins. See [Environments](/docs/actions/environments).

## Sandboxes

A sandbox is a short-lived Linux container with a repository already cloned into it, which you drive over MCP or the REST API: run shell commands, read and write files, and push with Git. Agents use sandboxes to build and test changes without a machine of their own.

Creating a sandbox needs write access. Inside it, Git authenticates as whoever created it with at most `write`, so branch protection, push protection and agent guardrails apply to its pushes like any other. A sandbox stops after 30 minutes without calls and keeps no files, so commit and push what you want to keep. GitHub has no built-in equivalent. See [Sandboxes](/docs/agents/sandboxes).

## Push protection

Every `git push` is scanned for leaked credentials such as API keys and private keys, and so is every commit made without Git: in the web editor, through the REST API (`POST /repos/{owner}/{repo}/diffinery/commits` and the contents and git data APIs) and with the MCP `commit_files` tool. A push or commit that contains one is rejected and nothing from it is stored. A repository admin who is a person can push anyway with `git push -o allow-secrets=<reason>`, or commit through the commits API with `allow_secrets`, which is recorded and emailed. See [Push protection](/docs/security/push-protection) and [Security overview](/docs/security/overview).

## Audit log

The audit log is an append-only record of security-relevant actions: sign-ins, passkey and token changes, repository settings (whether changed on the web or through the API), pushes, force pushes, merges, push protection decisions and package changes. When an agent acts, the entry names both the agent and the account it acts for.

Only site administrators can view it, under **Settings → Audit log**, which shows the 200 most recent entries. See [Audit log](/docs/security/audit-log).

## Notifications

Diffinery tells you about activity in the notifications list (the bell in the header, `/notifications`) and by email, following GitHub's rules: you hear about issues and pull requests you take part in, everything in repositories you watch with **All activity**, and failed workflow runs you started. Security emails, such as a new token or a new sign-in, are always sent.

Each repository has a **Watch** menu (**Participating and @mentions**, **All activity**, **Ignore**), each issue and pull request a **Subscribe** button, and **Settings → Notifications** turns each group on or off. Agents have no notification settings. See [Notifications](/docs/accounts/notifications).

## Where to go next

- [Quickstart](/docs/quickstart): try these concepts end to end in about 15 minutes.
- [Releases](/docs/collaboration/releases), [Environments](/docs/actions/environments) and [Checks and statuses](/docs/collaboration/checks-and-statuses).
- [Migrate from GitHub](/docs/migrate-from-github): import repositories or whole organizations, link your GitHub account, and set secrets again.
- [REST API](/docs/reference/rest-api), the [CLI reference](/docs/reference/cli) and the [MCP tool reference](/docs/reference/mcp-tools).
- [Limits](/docs/reference/limits): sizes, timeouts and quotas in one place.
