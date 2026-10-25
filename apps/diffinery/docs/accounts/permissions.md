---
title: Permissions
description: The repository roles (read, triage, write, maintain, admin), where roles come from, and how token scopes and agent policies cap them.
---

Every request to a repository, whether it comes from the web UI, Git, the REST API or MCP, runs with one effective role on that repository. This page explains the five roles, where a person's role comes from, and how token scopes, repository-restricted tokens and agent policies lower it.

## Repository roles

Diffinery uses the same five roles as GitHub. Each role includes everything the roles before it can do.

| Role | In short |
| --- | --- |
| `read` | View and clone; open issues and comment |
| `triage` | Manage issues, pull requests and labels without pushing code |
| `write` | Push, open and merge pull requests, run workflows |
| `maintain` | Also move or delete tags and edit other people's comments |
| `admin` | Settings, access, branch protection, secrets and webhooks |

### What each role can do

| Action | read | triage | write | maintain | admin |
| --- | --- | --- | --- | --- | --- |
| View code, history, issues, pull requests, workflow runs, logs and artifacts | Yes | Yes | Yes | Yes | Yes |
| Clone and fetch over Git, download Git LFS objects | Yes | Yes | Yes | Yes | Yes |
| List collaborators | Yes | Yes | Yes | Yes | Yes |
| Open issues, comment, and edit or close your own issues | Yes | Yes | Yes | Yes | Yes |
| Leave comment-only reviews and line comments on pull requests | Yes | Yes | Yes | Yes | Yes |
| Add and remove your own reactions | Yes | Yes | Yes | Yes | Yes |
| See published releases, download release assets and source archives (zip and tar) | Yes | Yes | Yes | Yes | Yes |
| See commit statuses, check runs, deployments and environments | Yes | Yes | Yes | Yes | Yes |
| Watch the repository and subscribe to threads | Yes | Yes | Yes | Yes | Yes |
| Create, apply and delete labels; set assignees (labels and assignees sent by someone below triage, when opening or editing an issue or pull request, are dropped) | No | Yes | Yes | Yes | Yes |
| Edit, close or reopen anyone's issue or pull request | No | Yes | Yes | Yes | Yes |
| Request reviewers on anyone's pull request | No | Yes | Yes | Yes | Yes |
| Lock and unlock conversations; comment and react on locked ones | No | Yes | Yes | Yes | Yes |
| Push branches and new tags; upload Git LFS objects | No | No | Yes | Yes | Yes |
| Create, update and delete branches and refs through the API; commit files in the web editor or API | No | No | Yes | Yes | Yes |
| Open pull requests | No | No | Yes | Yes | Yes |
| Approve or request changes on a pull request (not your own) | No | No | Yes | Yes | Yes |
| Merge pull requests, add them to or remove them from a merge queue, turn [auto-merge](/docs/collaboration/pull-requests#auto-merge) on or off | No | No | Yes | Yes | Yes |
| Resolve review threads | No | No | Yes | Yes | Yes |
| Run, cancel and re-run workflows | No | No | Yes | Yes | Yes |
| Report check runs and commit statuses (`POST /repos/{owner}/{repo}/check-runs`, `POST /repos/{owner}/{repo}/statuses/{sha}`) | No | No | Yes | Yes | Yes |
| Create, edit and delete releases and their assets; see draft releases | No | No | Yes | Yes | Yes |
| Create and delete deployments; report deployment statuses | No | No | Yes | Yes | Yes |
| Update a pull request's branch from its base (`PUT .../pulls/{number}/update-branch`) | No | No | Yes | Yes | Yes |
| Write Git objects through the API (blobs, trees, commits, tags, merges) | No | No | Yes | Yes | Yes |
| Trigger `repository_dispatch` (`POST /repos/{owner}/{repo}/dispatches`) | No | No | Yes | Yes | Yes |
| List Actions variables and environment variables | No | No | Yes | Yes | Yes |
| Start agent sandboxes | No | No | Yes | Yes | Yes |
| Move or delete existing tags | No | No | No | Yes | Yes |
| Edit or delete other people's comments | No | No | No | Yes | Yes |
| Dismiss a review on someone else's pull request (people only) | No | No | No | Yes | Yes |
| Change settings: name, description, visibility, default branch | No | No | No | No | Yes |
| Archive, unarchive and delete the repository | No | No | No | No | Yes |
| Transfer the repository to your own account or an organization you own or administer (people only; a personal repository only by its owner) | No | No | No | No | Yes |
| Add, change and remove collaborators; invite by email | No | No | No | No | Yes |
| Manage branch protection rules | No | No | No | No | Yes |
| List, set and delete Actions secrets; set and delete variables | No | No | No | No | Yes |
| Create, change and delete environments, their deployment branch policies and secrets (people only) | No | No | No | No | Yes |
| Set and delete environment variables | No | No | No | No | Yes |
| Set repository topics | No | No | No | No | Yes |
| Change the repository's workflow permissions setting: the default `GITHUB_TOKEN` permissions and whether workflows may create and approve pull requests (people only) | No | No | No | No | Yes |
| Delete other people's reactions | No | No | No | No | Yes |
| Manage webhooks | No | No | No | No | Yes |
| Run self-hosted runners for the repository (`diffinery runner`) | No | No | No | No | Yes |
| Bypass branch protection: push past it, merge past unmet rules by asking to (`"bypass_rules": true`), or merge without the merge queue by asking to (`"bypass_merge_queue": true`), unless the rule turns on **Do not allow administrators to bypass these rules** (people only for merges) | No | No | No | No | Yes |
| Commit past push protection with `git push -o allow-secrets=<reason>`, or with `allow_secrets` on `POST /repos/{owner}/{repo}/diffinery/commits` (people only) | No | No | No | No | Yes |

Some actions have extra conditions on top of the role:

- Branch protection can block pushes and merges for every role below admin, and for admins too when the rule enforces administrators. An admin's merge only skips unmet rules when they ask for it explicitly (**Merge without waiting for requirements (bypass)** in the web UI, `"bypass_rules": true` in the API, `diffinery pr merge --admin`). Each flag covers only what it names: `bypass_rules` skips unmet rules (including a merge commit on a branch that requires linear history), and `bypass_merge_queue` skips only the merge queue. Every bypass, including a bypassed linear-history rule or merge queue, is written to the audit log as `pull_request.merge_bypassed`. See [Branch protection](/docs/repositories/branch-protection).
- The `read` role's actions that change something (opening issues, commenting, reacting, comment-only reviews, watching) need a signed-in account. Anonymous visitors to a public repository can only read, and a `read`-scoped token can only read; see [Anonymous access](#anonymous-access) and [Token scopes cap your role](#token-scopes-cap-your-role).
- An archived repository refuses every write with `403 repository is archived (read-only)`, for every role and from the web UI, Git, the REST API and MCP alike: pushes, issues, comments, reviews, settings, collaborators, branch protection, secrets, variables and webhooks. Only unarchiving, deleting the repository, watching it, and linking a container image to it still work. See [Archive a repository](/docs/repositories/overview#archive-a-repository).
- You can't approve or request changes on your own pull request, and you can't dismiss reviews on it.
- Pull requests opened by agents always need at least one approval from a person.

Container images have their own permissions. An image linked to a repository follows that repository's roles: `read` pulls, `write` pushes, `admin` deletes. In an organization, every member can create images and pull the organization's images that aren't linked to a repository, but an image that isn't linked to a repository can be pushed to and managed only by the member who created it and the organization's owners and admins. See [Container registry](/docs/packages/container-registry).

## Where your role comes from

Diffinery works out your role on each request, so a change takes effect immediately for the browser, Git and every token you hold. Your role on a repository is the highest of:

| Source | Role |
| --- | --- |
| You own the repository (a personal repository) | admin |
| You are an owner or admin of the organization that owns it | admin |
| You are a member of the organization that owns it | the organization's base permission: `none`, `read`, `write` or `admin` (`read` for new organizations) |
| You created it in an organization as a member | admin (you are added as an `admin` collaborator) |
| You were added as a collaborator on the repository (**Settings → Collaborators**, an accepted repository invite, or `PUT /repos/{owner}/{repo}/collaborators/{username}`) | the role you were given |
| The repository is public | read |
| You are a site administrator | admin on every repository |

Because the highest role wins, a collaborator entry can raise an organization member's access above the base permission but can't lower it. Accounts that are pending or disabled have no role anywhere.

### Collaborators

Repository admins manage collaborators under **Settings → Collaborators** (`/acme/website/settings/access`):

- **Add people**: enter a **Username or email** (a person, an agent or an email address), pick a **Role** (**Read**, **Triage**, **Write**, **Maintain** or **Admin**; default **Write**) and click **Add**. A person's username gets an invitation, and they get the role once they accept it under **Settings → Invitations** ("Invited diffy with write access. They get access once they accept."). Agents, people who already are direct collaborators, members of the organization that owns the repository and you yourself get the role immediately ("diffy now has write access. We let them know."). An email address gets an invitation link; see [Invitations](/docs/accounts/invitations#add-people-to-a-repository).
- Change a collaborator's role with the **Role** menu and **Save**, or click **Remove** and confirm.

The person gets an email when their access is granted, changed or removed, and an in-app notification when someone adds or invites them with **Add people**. With the API:

```sh
# Invite diffy with the triage role, or change their role if they already are a collaborator
# (GitHub's "pull" and "push" also work: they mean read and write)
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/collaborators/diffy \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"permission": "triage"}'

# Remove diffy
curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/collaborators/diffy \
  -H "Authorization: Bearer dfy_..."
```

Without a body, `PUT` gives `write`. `PUT` answers `201 Created` with the invitation when it invited the person, and `204 No Content` when the role applied at once (the same cases as **Add people**). Both need admin on the repository and a token with the `admin` scope. Any other `permission` than `pull`, `read`, `triage`, `push`, `write`, `maintain` or `admin` answers `422 permission must be pull, triage, push, maintain or admin`, and an organization's login answers `422` too: add its members instead, or transfer the repository to it.

## Organization roles

Organizations have their own three roles, which map onto repository roles for every repository the organization owns. Members get the organization's base permission, which owners choose:

| Organization role | Role on organization repositories | Can also |
| --- | --- | --- |
| member | The base permission: `none`, `read`, `write` or `admin` | Create repositories (and get `admin` on the ones they create) and container images in the organization |
| admin | admin | Manage members (except owners), invites, agents and organization secrets |
| owner | admin | Everything an admin can, plus manage owners and the organization's **Settings** tab (name, display name, base permission, picture) |

New organizations start with a base permission of `read`; organizations that existed before the setting was added use `write`. Owners change it on the organization's **Settings** tab (**Base permission**) or with `PATCH /api/v3/orgs/{org}` and `{"default_repository_permission": "write"}`. With `none`, members don't see the organization's private repositories unless they are collaborators on them or created them. See [Base permission](/docs/accounts/organizations#base-permission) for details.

## Site administrators

Site administrators run the instance. They have admin on every repository, can act as an owner of every organization, and see a **Site administration** group in **Settings** with **People and invitations**, **Email** and **Audit log**. Accounts become site administrators when their email address or username is listed in the instance's `BOOTSTRAP_ADMINS` setting when the account is created. See [Site administration](/docs/admin/site-administration).

A site administrator's tokens are still capped by their scopes, like everyone's.

## Anonymous access

Without signing in or sending a token, you have `read` on public repositories, but only to look: you can browse them, clone and fetch over Git, download LFS objects and call the API's read endpoints (`GET` and `HEAD`) for those repositories. Anonymous callers can't change anything, as on GitHub: opening an issue, commenting, reacting, watching or any other request that isn't a read gets `401 authentication required`, even on a public repository. Everything else, including MCP, needs an account.

| Situation | Response |
| --- | --- |
| No credentials, private repository, or one that doesn't exist | Git, Git LFS and the web UI: `401 authentication required` (Git then asks for a username and password). REST API: `404`, as on GitHub. A signed-out caller can't tell the two apart. |
| No credentials, any change to a public repository (for example `POST /repos/{owner}/{repo}/issues`) | `401 authentication required` |
| Signed in or token, but no access to a private repository | `404 repository not found` (Diffinery doesn't reveal that it exists) |
| Access, but the role is too low | `403 <role> access required`, for example `403 write access required` |

## Token scopes cap your role

A personal access token never does more than its scope allows, whatever your role is. The cap is:

| Token scope | Highest effective role |
| --- | --- |
| `read` | read |
| `write` | maintain |
| `admin` | admin |

Your effective role through a token is the lower of your own role and the cap. If a token has several scopes, the highest one sets the cap. For example, an organization owner using a `write` token can push and merge in the organization's repositories but can't change their settings, secrets or branch protection; for that they need an `admin` token or the web UI.

A `read` token goes further than the cap: it can't make any change at all. Any repository request other than `GET` or `HEAD` gets `403 this token needs the write scope`, including the changes the `read` role allows (opening issues, commenting, reacting, comment-only reviews). `git fetch` and Git LFS downloads keep working, because they only read even though they use `POST`.

Browser sessions (signing in with a passkey) aren't capped: in the web UI you always act with your full role.

Account-level actions check the scope directly, and most also refuse tokens restricted to repositories (`403 this token is limited to repositories and can't change account settings`):

| Action | Needs |
| --- | --- |
| Create a repository (`POST /api/v3/user/repos`, `POST /api/v3/orgs/{org}/repos`) | a `write` or `admin` token that isn't restricted to repositories, or a browser session |
| Mark notifications read, change notification settings, send a test email | a `write` or `admin` token that isn't restricted to repositories, or a browser session |
| Watch or unwatch a repository | a `write` or `admin` token, or a browser session |
| Upload or remove your profile picture or an organization's (`PUT`/`DELETE /api/v3/user/avatar`, `/api/v3/orgs/{org}/avatar`; organization owners only) | a `write` or `admin` token that isn't restricted to repositories, or a browser session |
| Create a token (`POST /api/v3/diffinery/tokens`, `diffinery token create`) | an `admin` token or a browser session |
| Revoke a token, create an organization, invite people, manage organization secrets, create agents and agent tokens, disable agents | an `admin` token that isn't restricted to repositories, or a browser session |
| Send every email template (site administrators) | an `admin` token that isn't restricted to repositories, or a browser session |
| Change an organization's display name or base permission (`PATCH /api/v3/orgs/{org}`, owners only) | an `admin` token that isn't restricted to repositories, or a browser session |
| Change your username, display name or appearance | a browser session; there is no API |
| Add or remove passkeys, sign out other browsers | a browser session; tokens can't do this |

A token whose scope is too low gets `403 this token needs the write scope` or `403 this token needs the admin scope`.

See [Personal access tokens](/docs/accounts/tokens) for how to create tokens.

## Repository-restricted tokens

A token can be restricted to a list of repositories when you create it. With such a token, every other repository behaves as if you had no access: you get `404 repository not found`, even for repositories you could otherwise read. Inside the listed repositories, the usual role and scope cap apply. Restricting a token doesn't limit account-level reads such as `GET /api/v3/user`, but a restricted token can't make account-level changes: creating repositories or organizations, inviting, managing agents, organization secrets, notification settings or profile pictures, or revoking tokens. Those answer `403 this token is limited to repositories and can't change account settings` (profile pictures have their own message).

## Agents

Agents are accounts that act for a person or an organization. Their role on a repository is the lowest of:

1. **The owner's role.** A personal agent can never do more than the person who owns it. An organization agent has a role only on that organization's repositories (as an organization admin would) and none anywhere else.
2. **The agent's cap.** By default an agent's maximum role is `write`. The owner can choose another **Maximum role** when creating the agent. If the agent was added as a collaborator on a repository, that collaborator role replaces the maximum role for that repository.
3. **The token's scope**, as for any token.

On top of the role, these guardrails apply to agents everywhere (Git, the REST API, MCP and the web UI):

- Agents can't push to the default branch or any protected branch, unless a protection rule turns on **Allow agents to push directly** (`agentsMayPush`). They get "agents may not push to protected or default branches; open a pull request".
- Agents can't merge into the default branch or a protected branch, unless the rule turns on **Allow agents to merge pull requests** (`agentsMayMerge`).
- A pull request opened by an agent needs at least one approving review from a person. Only people's approvals count toward required approvals: approvals from agents and from workflow tokens never do.
- Agents can never bypass push protection, and the merge-protection bypass for admins (`"bypass_rules": true`) applies only to people.
- Check runs and commit statuses reported by agents never satisfy a required status check.
- Agents can't dismiss reviews.
- Through the API, agents can't change branch protection, delete repositories, or manage environments. Whatever their role, they can't create, update or delete Actions secrets (repository, environment or organization), and can't create, change or delete Actions variables (repository or environment); they get `403 agents cannot manage secrets` or `403 agents cannot manage variables`. An agent with `write` or higher can still list variables.
- A workflow run started by an agent only gets an environment's secrets when the environment is limited to protected branches. Tags created or moved by an agent never match an environment's tag patterns. See [Environments](/docs/actions/environments).
- Commits an agent makes carry a `diffinery-agent` header naming the agent and the person it acts for.

See [Agents](/docs/agents/overview) for creating and managing agents.

## Job tokens and sandbox tokens

Workflows and sandboxes get short-lived tokens of their own:

| Token | Prefix | Where it comes from | What it can do on the repository |
| --- | --- | --- | --- |
| Job token | `djt_` | Each workflow job gets one as `GITHUB_TOKEN` (also `DIFFINERY_TOKEN`) | Act as `diffinery-actions[bot]` with what the workflow's `permissions:` grant (see below). Container images follow the job's `permissions: packages`: it pulls its own repository's images, its owner's images not linked to a repository and public images, and pushes only to images linked to its own repository (creating them, linked, on first push) |
| Sandbox token | `dst_` | Each agent sandbox gets one | Act as the person or agent that started the sandbox, capped at `write`, on that repository |
| Runner token | `drn_` | A self-hosted runner gets one when it registers with a repository admin's registration token | Claim that repository's queued jobs, with the labels it registered. Nothing else: no reads, pushes or other API calls. It lasts until the runner is removed, or until its one job for an `--ephemeral` runner. See [Manage runners](/docs/actions/runners#manage-runners) |

Job and sandbox tokens can also read other public repositories (as anyone can), but no other private repository. They stop working when the job completes or the sandbox closes. See [Secrets and variables](/docs/actions/secrets-and-variables) and [Sandboxes](/docs/agents/sandboxes).

### What a job token may do

A job token follows GitHub's `permissions:` model. Its permissions come from the job's `permissions:`, else the workflow's, else the repository's default:

| Repository default | Permissions without `permissions:` |
| --- | --- |
| Read (the default for new repositories) | `contents` and `packages` read, nothing else |
| Read and write (repositories created before the setting existed) | Write on every permission except `id-token`, which stays off |

An admin changes the default, and whether workflows may create and approve pull requests (off by default), on the repository's **Settings → Actions** tab or with `PUT /api/v3/repos/{owner}/{repo}/actions/permissions/workflow`. See [Workflow permissions](/docs/actions/workflow-permissions) for the details.

On top of its permissions:

- Each endpoint needs its permission (`issues`, `pull-requests`, `contents`, `statuses`, `checks`, `deployments`, `actions` and so on). A request without it gets `403 Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: <scope>: <read or write>)`. Reads of a public repository are always allowed.
- The token's role is at most `write`, so branch protection always applies to it. Repository settings, collaborators, secrets, variables, webhooks, runners and branch protection are out of its reach (`403 this endpoint is not available to a workflow's GITHUB_TOKEN`).
- It never creates, changes or deletes files under `.github/workflows/` or `.diffinery/workflows/`, by push, API commit or merge. The refusal reads: refusing to allow a GitHub App to create or update workflow `<path>` without `workflows` permission.
- It can't open, approve or request changes on pull requests unless the repository allows it, and even then its approvals don't count toward required approvals.
- A reusable workflow never gets more than its caller.
- A run whose code came from an agent (an agent triggered it, pushed the branch last, or opened the pull request, and any re-run of such a run, whoever starts it, or `workflow_run` run that follows it) acts as an agent, so the agent guardrails apply: its token can't push or merge to the default branch or a protected branch.

## How permissions differ from GitHub

- The five repository roles match GitHub's names. Diffinery's `maintain` adds the ability to move or delete tags and to edit other people's comments; repository settings stay with `admin`.
- Opening a pull request needs `write`: its head branch must be a branch in the same repository.
- Organization members get the organization's base permission on every organization repository, as on GitHub, with the same values (`none`, `read`, `write`, `admin`) and the same default for new organizations (`read`). Organization owners and admins get `admin`. There are no teams or custom roles.
- Personal access tokens have three scopes (`read`, `write`, `admin`) instead of GitHub's fine-grained permissions; the scope caps your role.
- `GITHUB_TOKEN` in a workflow follows GitHub's `permissions:` model, but new repositories default to read-only tokens, the token never administers the repository or edits workflow files, and code that came from an agent runs under the agent rules.
- Agents are a separate account type with their own caps and guardrails.
