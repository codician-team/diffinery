---
title: Repositories
description: Create, configure, share, archive, rename, transfer and delete Diffinery repositories, and use topics, READMEs, languages and source archives.
---

A repository holds a project's Git history, issues, pull requests, workflows, secrets and webhooks. This page covers creating repositories, naming and visibility, the settings pages, collaborators and roles, archiving, renaming, transferring, deleting and watching, plus topics, the README and languages endpoints, and source code archives (zipball and tarball). For pushing and cloning, see [Git over HTTPS](/docs/repositories/git).

Every repository lives at `https://diffinery.com/<owner>/<name>`, for example `https://diffinery.com/acme/website`, and clones from `https://diffinery.com/acme/website.git`. The owner is either a person (a user) or an organization.

## User and organization repositories

| Owner | Who can create repositories there | Who gets access automatically |
| --- | --- | --- |
| Your user account (`diffy/notes`) | Only you (and site administrators) | You are **admin**. Nobody else, unless you add collaborators or make it public. |
| An organization (`acme/website`) | Any member of the organization | Organization **members** get the organization's base permission (**read** for new organizations; owners can set **none**, **read**, **write** or **admin**). Organization **owners** and **admins** get **admin**. A member who creates the repository gets **admin** on it. |

You can add collaborators to either kind for extra access (see [Collaborators and roles](#collaborators-and-roles)). Organizations have no teams: access in an organization comes from the member's organization role plus any collaborator role on the repository, and a collaborator role can raise a member above the base permission but not lower it. See [Base permission](/docs/accounts/organizations#base-permission).

An agent that creates a repository with `POST /api/v3/user/repos` creates it for the account that owns the agent. See [Agents](/docs/agents/overview).

## Create a repository

You need a signed-in account (web) or a token (CLI and API). To create a repository in an organization you must be a member of it.

### In the web UI

1. Click the **+** (New repository) icon in the header, or open `https://diffinery.com/new`. To preselect an organization, open `https://diffinery.com/new?owner=acme`.
2. On **Create a new repository**, fill in:

   | Field | Notes |
   | --- | --- |
   | **Owner** | You or one of your organizations. |
   | **Repository name** | See [Repository names](#repository-names). |
   | **Description** (optional) | Up to 350 characters. |
   | **Visibility** | **Private** (default) or **Public**. See [Visibility](#visibility). |
   | **Default branch** | Defaults to `main`. |

3. Click **Create repository**.

Diffinery takes you to the new, empty repository. Its **Quick setup** box shows the clone URL and the commands to push a new or existing project, and, if you have write access, a link to create a README in the browser.

### With the CLI

Install the CLI and sign in with `diffinery login`:

```sh
curl -fsSL https://diffinery.com/install | bash
```

Then:

```sh
# In your own account, private by default
diffinery repo create notes

# In an organization, public, with a description and a different default branch
diffinery repo create website --org acme --public -d "Marketing site" --default-branch trunk
```

| Option | Meaning |
| --- | --- |
| `--org ORG` | Create it in this organization instead of your account. |
| `--private` | Only people with access can see it (the default). |
| `--public` | Anyone can see and clone it. |
| `-d, --description TEXT` | Description. |
| `--default-branch BRANCH` | Default branch name (default `main`). |
| `--json` | Print the created repository as JSON. |

The command prints the repository URL and the `git remote add origin ...` line to use. See [CLI reference](/docs/reference/cli) for every command.

### With the REST API

Send a token in the `Authorization` header. It needs the `write` or `admin` scope (`write` is the default scope for new tokens) and must not be restricted to some repositories. A `read` token gets `403 this token needs the write scope`, and a token restricted to repositories gets `403 this token is limited to repositories and can't change account settings`.

```sh
# In your own account
curl -X POST https://diffinery.com/api/v3/user/repos \
  -H "Authorization: Bearer dfy_..." \
  -H "content-type: application/json" \
  -d '{"name": "notes", "description": "Personal notes"}'

# In an organization, public
curl -X POST https://diffinery.com/api/v3/orgs/acme/repos \
  -H "Authorization: Bearer dfy_..." \
  -H "content-type: application/json" \
  -d '{"name": "website", "description": "Marketing site", "visibility": "public", "default_branch": "main"}'
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `name` | string | (required) | See [Repository names](#repository-names). |
| `description` | string | `""` | |
| `visibility` | `"public"` or `"private"` | `"private"` | Any other value fails with `visibility must be public or private` (HTTP 422), with `errors` naming the `visibility` field. |
| `private` | boolean | | As on GitHub: `false` creates a public repository, `true` a private one. When you send both, `visibility` wins. |
| `default_branch` | string | `"main"` | |

The response is `201 Created` with the repository in GitHub's shape: a numeric `id`, `node_id`, `name`, `full_name`, `owner`, `private`, `visibility`, `description`, `default_branch`, `archived`, `topics`, `html_url`, `clone_url`, the GitHub URL templates (`contents_url`, `releases_url`, `languages_url` and so on), `created_at`, `updated_at` and `pushed_at`. Fields for features Diffinery doesn't have are filled with fixed values, for example `fork: false`, `forks_count: 0` and `has_wiki: false`.

Organization owners and admins get an email when someone else creates a repository in their organization (see [Notifications](/docs/accounts/notifications)).

## Repository names

- Start with a letter or digit.
- Then letters, digits, `.`, `-` and `_`, up to 100 characters in total.
- Must not end in `.git`, and must not be `.` or `..`.
- Names are unique per owner and case-insensitive: `acme/Website` and `acme/website` are the same repository. Opening the repository home page with a different capitalisation (or with `.git` on the end) redirects to the repository's own spelling.

If the name is invalid you get `invalid repository name: use letters, numbers, '.', '-' and '_'` (HTTP 422). If the owner already has a repository with that name you get `a repository with this name already exists` (HTTP 422).

## Visibility

| Visibility | Who can see and clone it |
| --- | --- |
| **Private** (default) | The owner, the organization's members (for organization repositories, unless the organization's base permission is **none**), collaborators, and site administrators. |
| **Public** | Anyone, including people who are not signed in. Signed-out visitors can browse the code, and `git clone` works without credentials. Every signed-in user gets **read** access. |

Writing to a public repository still needs a signed-in account (or a token) with a role that allows it. People who aren't signed in can read a public repository but can't change anything in it: opening an issue, commenting, reacting, watching and pushing all need an account, and the API answers such requests with `401 authentication required`. An anonymous `git push` gets a `401` with a `WWW-Authenticate` challenge, so Git asks for your credentials (or uses its credential helper) and tries again with them. A `read`-scoped token can read too, but every write with it gets `403 this token needs the write scope`. Only public repositories are indexed by search engines; private pages carry a `noindex` tag. A public repository's page is listed in the sitemap, and search engines are told about it through IndexNow within the hour after a push (see [Search engines](/docs/admin/site-administration#search-engines)); a private one never is. A public repository's home page also describes it to search engines and AI assistants as schema.org `SoftwareSourceCode` structured data: its name, description, topics, license file and last push.

For people without access, a private repository looks like it does not exist: the web UI, Git and the API answer `404` (`repository not found`) rather than `403`, so the name is not revealed. Signed-out requests can't tell a private repository from a missing one either: Git, Git LFS and the web UI answer both with `401` (`authentication required`), so Git asks for credentials and the web UI offers sign-in, and the REST API answers both with `404`, as GitHub does. A signed-out write gets `401` whether or not the repository exists.

Change visibility on the **General** settings page or with `PATCH /api/v3/repos/{owner}/{repo}` and `{"visibility": "public"}`. As on GitHub, `{"private": false}` also makes a repository public and `{"private": true}` makes it private. `visibility` accepts only `public` and `private` here too: any other value gets the same `422 visibility must be public or private` as when creating a repository.

## Repository settings

The **Settings** tab appears only for people with the **admin** role on the repository. It has five pages:

| Page | Path | What it controls |
| --- | --- | --- |
| **General** | `/acme/website/settings` | Name, description, default branch, visibility, archive, transfer, delete. |
| **Collaborators** | `/acme/website/settings/access` | Direct access for people and agents, and email invitations, from one **Add people** form. |
| **Branch protection** | `/acme/website/settings/branches` | Rules for matching branches. See [Branch protection](/docs/repositories/branch-protection). |
| **Secrets and variables** | `/acme/website/settings/secrets` | Actions secrets and variables. See [Secrets and variables](/docs/actions/secrets-and-variables). |
| **Webhooks** | `/acme/website/settings/webhooks` | HTTPS endpoints that receive events. See [Webhooks](/docs/repositories/webhooks). |

Every change on these pages is written to the audit log (for example `repo.update`, `repo.collaborator.set`, `repo.protection.set`, `repo.secret.set`, `repo.webhook.create`). The same changes made through the REST API are recorded too, with `via: "api"` in the entry's detail. See [Audit log](/docs/security/audit-log#repositories).

Some repository features have no settings page:

- **Releases** live at `/acme/website/releases`, and anyone with write access manages them there. See [Releases](/docs/collaboration/releases).
- **Deployment environments** (with their own secrets, variables and branch policies) are managed with the REST API. See [Environments](/docs/actions/environments).
- **Workflow permissions** (what a workflow's `GITHUB_TOKEN` may do by default, and whether workflows may create and approve pull requests) are set on the **Actions** tab or with the REST API. See [Workflow permissions](#workflow-permissions).

### General

The **General** page has these fields, saved together with **Save changes**:

- **Repository name**: renames the repository. See [Rename a repository](#rename-a-repository).
- **Description**: up to 350 characters, shown under the repository name and in the **About** box. It is also the page's description in search results and link previews.
- **Website**: the project's site, an `http` or `https` URL of up to 500 characters, linked from the **About** box. GitHub calls it `homepage`; `PATCH /api/v3/repos/{owner}/{repo}` with `{"homepage": "https://example.com"}` sets it too, and `""` clears it.
- **Topics**: up to 20, separated by spaces or commas. See [Topics](#topics).
- **Default branch**: a list of the repository's branches (a text field while the repository is empty). The default branch is what the repository page shows, what clones check out, the base for new pull requests, and it is always protected from agents.
- **Visibility**: **Private** or **Public**.

Below it, the **Danger zone** has **Archive this repository**, **Transfer ownership** (see [Transfer a repository](#transfer-a-repository)), **Purge unreachable objects** (see [Removing a secret that was pushed](/docs/security/push-protection#removing-a-secret-that-was-pushed)) and **Delete this repository**.

### Secrets and variables

The page lists **Repository secrets** (names and when they were updated; values are never shown again) and **Variables** (names and values). Workflows read them as `${{ secrets.NAME }}` and `${{ vars.NAME }}`.

- Names use letters, digits and `_` and don't start with a digit. They are stored in upper case.
- Secret names can't start with `GITHUB_`.
- Saving an existing name replaces its value.
- Only people manage them. Agents get `403 agents cannot manage secrets` or `403 agents cannot manage variables` when they try to add, change or delete one, even with the admin role.

Organization secrets, available to every repository in the organization, are managed with the API or `diffinery secret set NAME --org acme`. Details are in [Secrets and variables](/docs/actions/secrets-and-variables).

### Workflow permissions

Each repository has GitHub's **Workflow permissions** setting for Actions. It decides the permissions a job's `GITHUB_TOKEN` gets when the workflow doesn't set `permissions:`, and whether workflows may open pull requests and approve or request changes on them.

| Field | Values | Default |
| --- | --- | --- |
| `default_workflow_permissions` | `read`: `contents` and `packages` read only. `write`: read and write on every permission except `id-token`. | `read` for repositories created now; `write` for repositories created before the setting existed |
| `can_approve_pull_request_reviews` | `true` or `false` | `false` |

In the web UI, open the repository's **Settings → Actions** tab (`/{owner}/{repo}/settings/actions`). Under **Workflow permissions**, pick **Read repository contents and packages permissions** or **Read and write permissions**, check or clear **Allow GitHub Actions to create and approve pull requests**, and click **Save**. You see "Actions settings saved." The tab needs the **admin** role on the repository.

With the REST API (admin role, so an `admin`-scoped token):

```sh
# Read the setting
curl https://diffinery.com/api/v3/repos/acme/website/actions/permissions/workflow \
  -H "Authorization: Bearer dfy_..."

# Give workflows read and write by default, and let them create and approve pull requests
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/actions/permissions/workflow \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" \
  -d '{"default_workflow_permissions": "write", "can_approve_pull_request_reviews": true}'
```

`GET` returns `{"default_workflow_permissions": "read", "can_approve_pull_request_reviews": false}`, and `PUT` returns `204`. Fields you leave out keep their value. Only people can change it (agents get `403 only people can change what workflows are allowed to do`), an invalid value gets `422 default_workflow_permissions must be read or write` or `422 can_approve_pull_request_reviews must be a boolean`, and each change is recorded in the audit log as `repo.actions_workflow_settings`. Even when workflows may approve, their approvals never count toward required approvals. See [Workflow permissions](/docs/actions/workflow-permissions) for how the token's permissions are worked out.

### Webhooks

Add a webhook with a **Payload URL** (must start with `https://`), the **Events** to send (**Everything**, or any of `push`, `pull_request`, `pull_request_review`, `issues`, `issue_comment`, `workflow_run`, `workflow_dispatch`; **Everything** also covers `release`, `status`, `deployment`, `deployment_status` and `repository_dispatch`) and an optional **Secret** (generated when left empty, and shown once). Diffinery signs each delivery with an HMAC-SHA256 of the body in `X-Hub-Signature-256`, like GitHub. A delivery that fails with a network error, a timeout, `408`, `429` or a `5xx` status is retried up to five times (1 minute after the first failure, then 5 minutes, 30 minutes, 1 hour and 3 hours after each further failure), with the same `X-GitHub-Delivery` ID. The list shows each webhook's last delivery status. See [Webhooks](/docs/repositories/webhooks).

## Collaborators and roles

A role decides what someone can do in a repository. Roles are the same as GitHub's:

| Role | Can |
| --- | --- |
| **read** | View and clone. |
| **triage** | Also manage issues and labels. |
| **write** | Also push, open and merge pull requests, run workflows, create branches and tags. |
| **maintain** | Also move and delete tags. |
| **admin** | Also change settings, secrets, branch protection, webhooks and access, archive and delete the repository. |

A person's role is the highest of: owning the repository (admin), their organization role (members get the organization's base permission, owners and admins admin), a collaborator role, and **read** on public repositories. Site administrators are admin everywhere. A token can lower this further (a `read` token acts as read and can't make any change, a `write` token acts as at most maintain). Agents have their own limits on top: for example, whatever their role, they can't add, change or delete secrets or variables, change branch protection or delete the repository. See [Permissions](/docs/accounts/permissions) for the full matrix.

### Add a collaborator in the web UI

Open **Settings → Collaborators** and use the **Add people** form:

1. In **Username or email**, enter a person's or agent's username (for example `diffy` or `review-bot`, with or without a leading `@`) or an email address.
2. Pick a **Role** (**Read**, **Triage**, **Write**, **Maintain** or **Admin**; the default is **Write**).
3. Click **Add**.

What happens depends on what you entered:

| You entered | Result |
| --- | --- |
| The username of a person | Diffinery sends them an invitation, as on GitHub: "Invited diffy with write access. They get access once they accept." They get a notification on Diffinery and an email, and get the role when they accept it under **Settings → Invitations**. The invitation expires after 14 days. If they already have a pending invitation to this repository, it offers the role you chose instead: "diffy already had a pending invitation; it now offers admin access." |
| The username of an agent, of a person who already is a direct collaborator, of a member of the organization that owns the repository, or your own | They get the role right away, with no invitation. People get a notification on Diffinery and an email. The page confirms with "diffy now has write access. We let them know." |
| An email address | Diffinery emails an invitation, whether or not the address has an account, and shows the link once ("Invitation sent to ..."), so you can also send it yourself. The link works once and expires in 14 days. Opening it gives the person the role on this repository, creating their account and passkey first if they don't have one. See [Invitations](/docs/accounts/invitations). |

Errors you may see:

| Message | Meaning |
| --- | --- |
| `no one has the username <name>; to invite someone new, enter their email address` | No account has that username. Check the spelling, or enter the person's email address to invite them. |
| `<name> is an organization; add its people instead` | Organizations can't be collaborators. Add the people one by one. |
| `<name>'s account is disabled` | A site administrator disabled that account. |
| `enter a valid email address` | The text contains `@` but isn't a valid address. |
| `<email> already has a pending invitation; revoke it first to send a new one` | That address already has an open invitation to this repository (letter case doesn't matter). Revoke it under **Pending invitations**, then add the address again. |

The table lists direct collaborators. Change someone's role with the role list and **Save**, or remove them with **Remove**. People get an email when their access to a repository is granted or changed.

Invitations that haven't been accepted yet are listed under **Pending invitations**, with who sent them, when, the expiry date and the role. An invitation sent to a username shows as `@diffy`, never the person's email address. Click **Revoke** to withdraw one; the person isn't told. See [Invitations](/docs/accounts/invitations#revoke-an-invitation).

Organization members don't appear in this table: they get their access from the organization's base permission. The exception is a member who created the repository, who is listed with **Admin**.

### Manage collaborators with the API

These need an admin role on the repository.

```sh
# List collaborators (any reader can list)
curl https://diffinery.com/api/v3/repos/acme/website/collaborators -H "Authorization: Bearer dfy_..."

# Invite a collaborator, or change a collaborator's role
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/collaborators/diffy \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" \
  -d '{"permission": "maintain"}'

# Remove a collaborator
curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/collaborators/diffy -H "Authorization: Bearer dfy_..."
```

`permission` accepts `read`, `triage`, `write`, `maintain` or `admin`, and GitHub's `pull` (read) and `push` (write). It defaults to `write`. The list response gives each account's `role_name`.

As on GitHub, `PUT` invites a person who doesn't have access yet: it answers `201 Created` with the invitation (`id`, `repository`, `invitee`, `inviter`, `permissions`, `created_at`, `expires_at`, `html_url`), and they get the role once they accept it. For an agent, someone who already is a direct collaborator, a member of the organization that owns the repository, or yourself, the role changes at once and `PUT` answers `204 No Content`. `GET /api/v3/repos/{owner}/{repo}/invitations` lists pending invitations and `DELETE /api/v3/repos/{owner}/{repo}/invitations/{id}` revokes one. See [Invitations](/docs/accounts/invitations#repository-invite-by-username).

## Archive a repository

Archiving makes a repository read-only, as on GitHub: nobody can push, open or change issues and pull requests, comment, review, create or edit releases, start runs or change settings, and scheduled workflows stop. Everything stays readable, cloneable and downloadable as an archive.

- **Web UI**: **Settings → General → Danger zone → Archive**, then confirm. **Unarchive** reverses it.
- **API**: `PATCH /api/v3/repos/acme/website` with `{"archived": true}` (or `false`).

Archived repositories show an **archived** badge. Every request that would write to one fails with `repository is archived (read-only)` (HTTP 403), whatever role it needs and whoever sends it, admins included: pushes, issues, comments, reactions, reviews, pull requests, releases, statuses, deployments, topics, collaborators, branch protection, secrets, variables, environments, webhooks and MCP tools that change something. A `git push` fails with the same message. Unarchive the repository first.

Only these still work on an archived repository:

| Action | How |
| --- | --- |
| Unarchive it | **Settings → General → Unarchive**, or `PATCH /api/v3/repos/acme/website` with `{"archived": false}` |
| Delete it | **Settings → General → Delete this repository**, or `DELETE /api/v3/repos/acme/website` |
| Transfer it | **Settings → General → Transfer ownership**, or `POST /api/v3/repos/acme/website/transfer`. See [Transfer a repository](#transfer-a-repository). |
| Watch or unwatch it | The **Watch** menu, or `PUT`/`DELETE /api/v3/repos/acme/website/subscription` |
| Link a container image to it | The package's settings, or the packages API. See [Container registry](/docs/packages/container-registry). |

Archiving and unarchiving are recorded in the audit log as `repo.archive` and `repo.unarchive`, from the web UI and the API alike.

## Rename a repository

Admins can rename a repository on **Settings → General** (change **Repository name** and click **Save changes**) or with:

```sh
curl -X PATCH https://diffinery.com/api/v3/repos/acme/website \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" \
  -d '{"name": "site"}'
```

Renaming changes the repository's URL and clone URL. The old name keeps working, exactly as after a transfer (see [Old URLs after a transfer or rename](#old-urls-after-a-transfer-or-rename)), until a repository is created with that name. Update your remotes anyway: `git remote set-url origin https://diffinery.com/acme/site.git`, and anything else that uses the old name, such as CI scripts and webhook consumers. A name the owner already uses is refused (`a repository with this name already exists`, HTTP 422).

## Transfer a repository

A transfer moves a repository to another owner, like GitHub's transfer: from your account to an organization, from an organization to your account, or between organizations. Everything in the repository moves with it, and its old URLs keep working.

### Who can transfer

- You must be a person with the **admin** role on the repository. Agents, workflow tokens (`GITHUB_TOKEN`) and sandbox tokens can't transfer repositories.
- A personal repository can only be transferred by its owner (or a site administrator).
- The new owner must be your own account, or an organization where you are an **owner** or **admin**. You can't transfer a repository to another person's account, or to an organization where you are only a member. Because of this, there is no acceptance step: the transfer happens at once.
- Archived repositories can be transferred without unarchiving them first.
- Through the API, you need a token with the `admin` scope that isn't limited to repositories.

### Transfer in the web UI

1. Open the repository's **Settings** tab (the **General** page) and scroll to the **Danger zone**.
2. Under **Transfer ownership**, pick the **New owner**: your own account (shown as `diffy (your account)`) or one of the organizations you own or administer. The current owner isn't listed.
3. Optionally type a **New name**. Leave it empty to keep the current name.
4. Type the repository's full name (for example `acme/website`) in the confirmation box, as `Type acme/website to confirm.` asks, and click **Transfer**.

You land on the repository's settings at its new address, with `Transferred acme/website to acme-labs/website.` When you can't transfer it, the section says why instead: `Only diffy can transfer this repository.` for someone else's personal repository, or `You don't own or administer another account or organization to transfer it to.`

### Transfer with the API

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/transfer \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"new_owner": "acme-labs", "new_name": "site"}'
```

| Field | Meaning |
| --- | --- |
| `new_owner` | Required. The login of your own account or of an organization you own or administer. |
| `new_name` | Optional. A new name for the repository; it follows the [naming rules](#repository-names). Default: keep the current name. |

The response is `202 Accepted` with the repository object at its new owner and name. The transfer is complete when the response arrives. GitHub's `team_ids` field isn't used, since Diffinery has no teams.

### What moves with the repository

The repository keeps its id, so everything stored in it moves: Git history and Git LFS objects, issues, pull requests, reviews, releases, the merge queue, Actions runs, logs, artifacts and caches, repository secrets and variables, environments, webhooks, branch protection rules and watchers. Its numeric id in the API and in webhook payloads doesn't change.

- **Access.** Direct collaborators keep their roles. Access that came from the old organization is removed: its members' roles (including the admin grant of the member who created the repository), their agents' and the organization's own agents'. The new owner's access applies instead: for an organization, its owners and admins get admin and its members get its base permission; for your own account, you are admin.
- **Organization secrets and variables.** The old organization's secrets and variables no longer reach the repository's workflows; the new organization's do. Repository and environment secrets stay.
- **Container images.** Images linked to the repository move to the new owner with it and keep following its access (see [Container registry](/docs/packages/container-registry#when-the-repository-moves)). Images that aren't linked to it stay with the old owner.
- **Source archives.** Zipballs and tarballs are built again with the new owner and name in their folder name.
- **Webhooks.** They keep firing, with the new `full_name` and URLs in their payloads. No `repository` event is sent for the transfer itself.
- **Tokens.** Personal access tokens limited to the repository keep working, since they refer to it by id.

### Old URLs after a transfer or rename

The old owner/name keeps working for anyone who can still read the repository, as on GitHub. Everyone else gets the same answer as for the repository under its new name (`404`, or `401` without credentials), so a redirect never shows that a private repository exists:

| Where | What happens under the old name |
| --- | --- |
| Web pages | `301` to the same page under the new name, query string kept |
| REST API | `301` with the new URL in `Location` (and `url` in the body) for `GET` and `HEAD`, `307` for other methods so the method and body are kept, like GitHub |
| Git | Clones, fetches, pushes and Git LFS are served under the old name, with no redirect; a push prints `This repository moved. Please use the new location:` and the new URL |
| MCP tools | Served as if you had named the new owner and name |
| Reusable workflows | `uses: acme/website/.github/workflows/build.yml@main` still finds the moved repository's workflow |
| Container images | `diffinery.com/<old owner>/<image>` resolves to the moved image, for pulls and pushes |

Git is served rather than redirected because Git follows redirects only on its first request and rebuilds its credentials from the new URL, which would drop a token embedded in the remote URL. Update remotes when you can:

```sh
git remote set-url origin https://diffinery.com/acme-labs/site.git
```

The redirect ends for good when a repository is created at the old owner and name (by anyone who can create one there), and when the moved repository is deleted. A renamed repository leaves the same redirect, and so does every repository of a renamed user or organization (see [Rename an organization](/docs/accounts/organizations#rename-an-organization)).

### After a transfer

- The transfer is recorded in the audit log as `repo.transfer`, with the new name as the target and `from` and `to` in the detail.
- The admins of both owners (for a personal account, the person; for an organization, its owners and admins) get an email such as `[acme-labs/website] Repository transferred from acme/website`, with the `git remote set-url` command to run, except whoever made the transfer. See [Notifications](/docs/accounts/notifications).

### Transfer errors

| Message | Cause and fix |
| --- | --- |
| `new_owner is required` (422) | Send `new_owner`. |
| `no user or organization named acme-labs` (422) | Check the login. |
| `you can transfer repositories only to your own account or to an organization you own or administer` (403) | Ask an owner of the target organization to make you an admin, or to do the transfer. |
| `only the owner can transfer a personal repository` (403) | Only the account that owns a personal repository can transfer it. |
| `repositories can only be transferred to a person or an organization` (422) | The target is an agent or a disabled account. |
| `acme/website already belongs to acme` (422) | The repository already has that owner. To change only its name, [rename it](#rename-a-repository). |
| `acme-labs already has a repository named website` (422) | Pick another `new_name`, or rename or delete the other repository first. |
| `acme-labs already has a container image named website; this repository's image of that name would replace it` (422) | Delete or rename the target's image, or unlink the image from this repository first. |
| `invalid repository name: use letters, numbers, '.', '-' and '_'` (422) | Fix `new_name`. |
| `repository is locked by an import in progress; transfer it once the import finishes` (423) | Wait for the [GitHub import](/docs/migrate-from-github) filling the repository to finish. |
| `agents and workflow tokens cannot transfer repositories` (403) | Transfer as a person, with your own token or the web UI. |
| `admin access required` (403) | You need the admin role. A `write` token caps you at maintain: use an `admin` token. |
| `this token is limited to repositories and can't change account settings` (403) | Use an `admin` token that isn't restricted to repositories. |
| `type acme/website to confirm the transfer` | The web confirmation box didn't match the repository's full name. |
| `choose the new owner` | Pick a **New owner** in the web form. |

## Delete a repository

Deleting permanently removes the repository with its history, issues, pull requests, releases, runs, secrets, environments, webhooks and pending invitations, its LFS files and release assets, and its Actions caches, artifacts, job logs and cached source archives. It can't be undone. An archived repository can be deleted without unarchiving it first.

- **Web UI**: **Settings → General → Danger zone → Delete this repository**. Type the full name (for example `acme/website`) and click **Delete this repository**.
- **API**: `DELETE /api/v3/repos/acme/website` returns `204 No Content`. It needs an admin role. Agents can't delete repositories (`agents cannot delete repositories`, HTTP 403).
- **Recent sign-in**: from a browser whose sign-in is more than 2 hours old, Diffinery first asks you to [Confirm it's you](/docs/security/overview#confirming-its-you) with your passkey. Transferring a repository asks the same.

Deletions are recorded in the audit log as `repo.delete`. The repository's owner (for an organization, its owners and admins) gets an email, unless they deleted it themselves.

## Change the default branch

Pick another branch under **Settings → General → Default branch**, or `PATCH /api/v3/repos/acme/website` with `{"default_branch": "trunk"}`. The default branch can't be deleted (pushes that try get `cannot delete the default branch`). Pushes to it from agents are always refused unless a branch protection rule for it allows agents to push.

## Watch a repository

Each repository page has a **Watch** menu in the header that decides which activity notifies you:

| Option | You are notified about |
| --- | --- |
| **Watch: participating** (default) | Only issues and pull requests you take part in or are @mentioned in. |
| **Watch: all activity** | Everything in the repository. |
| **Watch: ignore** | Nothing from this repository. |

With the API (GitHub-compatible):

```sh
# Watch all activity
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/subscription \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" -d '{"subscribed": true}'

# Ignore the repository
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/subscription \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" -d '{"ignored": true}'

# Back to participating only
curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/subscription -H "Authorization: Bearer dfy_..."
```

`GET` on the same path returns `404` when you are on the default (participating). **Settings → Notifications** lists the repositories you watch. See [Notifications](/docs/accounts/notifications).

## Look up repositories

| Task | Web | CLI | API |
| --- | --- | --- | --- |
| Repositories you can see | Your dashboard | `diffinery repo list` | `GET /api/v3/user/repos` |
| One owner's repositories | `https://diffinery.com/acme` | `diffinery repo list --owner acme` | `GET /api/v3/orgs/acme/repos` or `GET /api/v3/users/diffy/repos` |
| One repository | `https://diffinery.com/acme/website` | `diffinery repo view acme/website` | `GET /api/v3/repos/acme/website` |

`GET /api/v3/repos/{owner}/{repo}` also returns your access as `permissions` (GitHub's `admin`, `maintain`, `push`, `triage` and `pull` booleans plus Diffinery's `role`) and `stats` (objects, stored bytes, refs, open issues and open pull requests). The repository page's **About** box shows the same numbers with the last push time.

To find repositories by name, description or topic, use `GET /api/v3/search/repositories?q=...`. It matches words against the name, description and topics, supports the qualifiers `user:`, `org:`, `owner:`, `repo:`, `topic:`, `in:name,description,topics`, `is:public`, `is:private` and `archived:true` or `archived:false`, and only returns repositories you can read. GitHub's `stars:`, `forks:`, `language:` and similar qualifiers are accepted but ignored. See [REST API](/docs/reference/rest-api).

## Topics

Topics are short labels that describe a repository, such as `docs` or `static-site`, as on GitHub. They appear in a **Topics** section on the repository home page (only when the repository has some), are returned as `topics` in every repository object, and can be searched with `topic:` (for example `GET /api/v3/search/repositories?q=topic:docs`).

Admins set them in the **Topics** field on **Settings → General**, separated by spaces or commas, or with the REST API:

```sh
# Read them (anyone who can read the repository)
curl https://diffinery.com/api/v3/repos/acme/website/topics -H "Authorization: Bearer dfy_..."

# Replace the whole list (admin role; an admin-scoped token)
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/topics \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" \
  -d '{"names": ["docs", "static-site"]}'
```

Both return `{"names": [...]}`. `PUT` replaces every topic; send `{"names": []}` to remove them all. The change is recorded in the audit log as `repo.topics`.

Rules, the same as GitHub's:

- Names are trimmed and lowercased, and duplicates and empty names are dropped.
- A topic starts with a lowercase letter or digit, then has lowercase letters, digits and `-`, up to 50 characters. Otherwise: `<name> is not a valid topic. Topics must start with a lowercase letter or number, consist of 50 characters or less, and can include hyphens.` (HTTP 422).
- A repository has at most 20 topics (`a repository can have at most 20 topics`, HTTP 422).
- `names` must be an array (`names must be an array`, HTTP 422).
- An archived repository refuses changes.

## README

The repository home page and every folder page render the folder's README (see [Browsing code](/docs/repositories/browsing-code#readmes-and-markdown)). Scripts can fetch it with GitHub's endpoints:

```sh
# The README at the root of the default branch, as a contents object (base64 content)
curl https://diffinery.com/api/v3/repos/acme/website/readme -H "Authorization: Bearer dfy_..."

# The README of a folder, at another ref, as raw text
curl "https://diffinery.com/api/v3/repos/acme/website/readme/docs?ref=v1.2.0" \
  -H "Authorization: Bearer dfy_..." -H "Accept: application/vnd.github.raw"
```

| Detail | Behaviour |
| --- | --- |
| Which file | A file named `README`, or `README` with any one extension, in any capitalisation. `README.md` and `README.markdown` win over the others. |
| `ref` | A branch, tag or commit. Defaults to the default branch. |
| Response | A contents object with `name`, `path`, `sha`, `size`, `encoding: "base64"`, `content`, `html_url` and `download_url`. With `Accept: application/vnd.github.raw`, the file's text instead. |
| No README | `404 Not Found`. |

## Languages

`GET /api/v3/repos/acme/website/languages` returns how many bytes of each language the default branch contains, largest first, like GitHub:

```json
{ "TypeScript": 182344, "CSS": 20311, "Shell": 1022 }
```

The language comes from the file extension (and a few file names such as `Dockerfile` and `Makefile`). Files with an unknown extension, symbolic links, submodules and folders named `node_modules`, `vendor`, `third_party`, `dist`, `build` and `.yarn` are not counted. The result is computed once per commit of the default branch. In very large trees, counting stops after 100,000 entries and the endpoint returns what it counted. An empty repository returns `{}`.

## Source code archives

You can download any branch, tag or commit as a `.zip` or `.tar.gz` file without Git. Public repositories need no credentials; private ones need read access (a token in the API, or being signed in for the web URLs).

| Format | Web URL | REST API |
| --- | --- | --- |
| zip | `https://diffinery.com/acme/website/archive/<ref>.zip` | `GET /api/v3/repos/acme/website/zipball/<ref>` |
| tar.gz | `https://diffinery.com/acme/website/archive/<ref>.tar.gz` | `GET /api/v3/repos/acme/website/tarball/<ref>` |

`<ref>` is a branch, a tag, a commit SHA, or a full ref such as `refs/heads/main` or `refs/tags/v1.2.0`; names with slashes work. Leave it out of the API path (`.../zipball`) to get the default branch. Release pages link to the archives of their tag as **Source code (zip)** and **Source code (tar.gz)**, and the API returns them as `zipball_url` and `tarball_url` on tags and releases.

```sh
# Download the v1.2.0 tag with a token
curl -fL -o website.tar.gz -H "Authorization: Bearer dfy_..." \
  https://diffinery.com/api/v3/repos/acme/website/tarball/v1.2.0

# Download main of a public repository
curl -fLO https://diffinery.com/acme/website/archive/main.zip
```

What the archive contains:

- The file is named `<owner>-<repo>-<short sha>.zip` (or `.tar.gz`), for example `acme-website-3f2a9c8.zip`, and everything sits in one top-level folder of the same name, like GitHub's archives.
- Files keep their executable bit, symbolic links stay links, and every entry has the commit's date. Submodules are empty folders.
- The full commit SHA is stored as the archive comment (for tar, in a pax header, as `git archive` does).
- Git LFS files appear as their small pointer files, not their content.
- Entries with names Git refuses to check out (such as `.git` in any spelling) are left out.

Unlike GitHub, the API answers with the file itself (`200`) rather than redirecting to another host; `curl -L` works either way. Diffinery builds the archive the first time a commit is requested and serves the same file afterwards, for up to 30 days; after that it is built again the next time someone asks for it.

Limits:

| Limit | Error |
| --- | --- |
| At most 24 MB of file content (uncompressed) | `repository is too large for an on-the-fly archive; clone it with git instead` (HTTP 413) |
| At most 100,000 tree entries | `the tree has more than 100,000 entries; clone it with git instead` (HTTP 413) |
| Folders nested at most 128 deep | `the tree is nested too deeply` (HTTP 413) |
| A zip holds at most 65,535 entries | `this repository has too many files for a zip archive (more than 65,535); download the .tar.gz archive or clone it with git` (HTTP 413) |
| 20 newly built archives per repository per hour (archives already built don't count) | `too many archives were built for this repository in the last hour; try again later or clone it with git` (HTTP 429) |
| The ref must exist | `Not Found` (HTTP 404) |

For anything bigger, clone with Git (`git clone --depth 1` is fastest; see [Git over HTTPS](/docs/repositories/git#shallow-clones)).

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| `invalid repository name: use letters, numbers, '.', '-' and '_'` | The name breaks a [naming rule](#repository-names). |
| `a repository with this name already exists` | The owner already has a repository with that name (names are case-insensitive). |
| `you are not a member of this organization` | Ask an organization owner to add you before creating repositories there. |
| `you can only create repositories for yourself or your organizations` | You tried to create a repository for another person's account. |
| `admin access required` | Settings, collaborators and deletion need the admin role. A `write` token is capped at maintain even if you are an admin: use an `admin` token or the web UI. |
| `authentication required` (HTTP 401) | You sent a request that changes something without a token or session. Even on a public repository, every write needs a signed-in account. |
| `this token needs the write scope` | Your token is `read`-scoped and can only read. Create a token with the `write` or `admin` scope. |
| `this token is limited to repositories and can't change account settings` | Creating a repository needs a token that isn't restricted to some repositories. Use an unrestricted `write` token or the web UI. |
| `repository is archived (read-only)` | Unarchive the repository first. |
| `404 repository not found` for a repository that exists | You (or the token) have no access to this private repository, or the token is restricted to other repositories. |
| `visibility must be public or private` | Send `"public"` or `"private"` (or use the `private` boolean). |
| `remote: This repository moved. Please use the new location:` on push | The repository was transferred or renamed. The push went through; run `git remote set-url origin <new URL>`. |
| An API call answers `301` or `307` with `Moved Permanently` | The repository was transferred or renamed. Follow `Location` and update the owner and name in your scripts. See [Old URLs after a transfer or rename](#old-urls-after-a-transfer-or-rename). |
| `no one has the username <name>; to invite someone new, enter their email address` | The **Add people** form found no account with that username. Enter an email address to send an invitation. |
| `<name> is not a valid topic...` or `a repository can have at most 20 topics` | Follow the [topic rules](#topics). |
| `repository is too large for an on-the-fly archive; clone it with git instead` | The [source archive](#source-code-archives) would hold more than 24 MB. Clone the repository instead. |
| `too many archives were built for this repository in the last hour; ...` | Wait, download an archive that was already built (for example the same tag), or clone with Git. |
