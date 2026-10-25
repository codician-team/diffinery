---
title: Organizations
description: Create organizations, add people by username or email, manage roles and invitations, set the base permission and picture, and share repositories.
---

An organization is a shared account that owns repositories, agents, container images and Actions secrets and variables on behalf of a group of people. Use one when more than one person works on the same code, so access doesn't depend on any one personal account.

## Organization roles

Every member has one of three roles. The role decides what they can do in the organization and the role they get on every repository the organization owns: owners and admins always get `admin`, and members get the organization's [base permission](#base-permission).

| Capability | member | admin | owner |
| --- | --- | --- | --- |
| Role on every organization repository | The base permission (`read` for new organizations) | admin | admin |
| See the organization's private repositories | Yes, unless the base permission is `none` | Yes | Yes |
| Create repositories in the organization, and get `admin` on the ones you create | Yes | Yes | Yes |
| Create container images in the organization and pull its images that aren't linked to a repository | Yes | Yes | Yes |
| Push to, delete and change the settings of an organization image that isn't linked to a repository | Only images they created | Yes | Yes |
| See the **People** and **Agents** tabs | Yes | Yes | Yes |
| **Add people** (by username or email) | No | Yes (as member or admin) | Yes (any role) |
| See and revoke pending invitations | No | Yes | Yes |
| Change roles, remove members | No | Yes, except owners | Yes, including owners |
| Create and manage the organization's agents | No | Yes | Yes |
| Manage organization Actions secrets | No | Yes | Yes |
| Read and manage organization Actions variables | No | Yes | Yes |
| Open the **Settings** tab: rename, display name, base permission, picture | No | No | Yes |
| Set the [agent policy](/docs/agents/organizations), and see or change the organization's model keys | No | No | Yes |
| Transfer repositories into the organization | No | Yes | Yes |
| Delete the organization (once it owns no repositories or images) | No | No | Yes |
| Change the display name, base permission and picture through the API | No | No | Yes |
| Get emails when repositories are created or deleted in the organization | No | Yes | Yes |

Site administrators can do everything an owner can in every organization, and have admin on every repository.

A container image linked to a repository follows that repository's roles instead (read pulls, write pushes, admin deletes), so a member who can't see a private repository can't pull its images either. See [Container registry](/docs/packages/container-registry).

A member's role on a repository is the highest of the role their organization role gives them (the base permission for members, `admin` for owners and admins) and any role given to them directly on that repository. A direct collaborator role can raise an organization member's access (for example to `maintain` or `admin`) but never lowers it. See [Permissions](/docs/accounts/permissions) for what each repository role allows.

## Base permission

The base permission is the repository role that every member of an organization gets on every repository the organization owns, like GitHub's "Base permissions" setting. It only applies to members: owners and admins always have `admin` on every organization repository, whatever the base permission is.

| Value | Option in the web UI | What members get on every organization repository |
| --- | --- | --- |
| `none` | No permission: members see only repositories they're given | No role. Members see only public repositories, repositories they were added to as collaborators, and repositories they created. |
| `read` | Read: members can clone and view | `read`: view and clone, open issues and comment |
| `write` | Write: members can also push | `write`: also push, open and merge pull requests and run workflows |
| `admin` | Admin: members can also change settings | `admin`: also change settings, collaborators, branch protection, secrets and webhooks |

`triage` and `maintain` can't be a base permission; give those roles per repository under **Settings → Collaborators**. See [Permissions](/docs/accounts/permissions) for everything each role allows.

### Default base permission

- A new organization starts with `read`, as on GitHub.
- Organizations that existed before Diffinery added the base permission were set to `write`, so their members kept the access they already had.

### How the base permission combines with other access

A member's role on an organization repository is the highest of:

| Source | Role |
| --- | --- |
| The organization's base permission | `none`, `read`, `write` or `admin` |
| A collaborator role on that repository (**Settings → Collaborators**, an accepted repository invitation, or `PUT /api/v3/repos/{owner}/{repo}/collaborators/{username}`) | The role they were given |
| They created the repository | `admin` |
| The repository is public | `read` |

A collaborator role can raise a member above the base permission but can't lower it, so to give most members less access and a few people more, set a low base permission and add those people as collaborators on the repositories they need. Diffinery has no teams.

Any member can create repositories in the organization, whatever the base permission. As on GitHub, the member who creates a repository becomes its admin: Diffinery adds them as an `admin` collaborator, so they appear under the repository's **Settings → Collaborators**. When a member's personal agent creates the repository, the member gets that grant. Owners and admins already have `admin` everywhere, so no grant is added for them.

The base permission also limits agents that belong to a member, because a personal agent never has more access than its owner. Organization agents aren't affected: their access comes from their **Maximum role** (see [Agents](/docs/agents/overview)). Container images that aren't linked to a repository aren't affected: every member can still create images in the organization and pull them. An image linked to a repository follows that repository's access, so with `none` a member can't pull images of private repositories they can't see, and the registry catalog leaves those images out (see [Container registry](/docs/packages/container-registry)).

Roles are worked out on every request, so a change to the base permission applies to every member right away, including in Git and through tokens they already have.

### Change the base permission in the web UI

Organization owners and site administrators:

1. Open the organization's page and click the **Settings** tab (`https://diffinery.com/acme?tab=settings`).
2. In the **Base permission** menu, pick **No permission**, **Read**, **Write** or **Admin**. The hint under it reads "What every member can do in all of this organization's repositories. Owners and admins always have admin access, and repository settings can give people more."
3. Click **Save**. You see "Organization updated."

Admins and members can't open the **Settings** tab: they get `403 organization owners only`. The change is recorded in the audit log as `org.update`, with the new value as `base_role` (see [Audit log](/docs/security/audit-log)).

### Change the base permission with the API

The API uses GitHub's field name, `default_repository_permission`. `GET /api/v3/orgs/{org}` returns the organization; members of the organization, their agents and site administrators also see `default_repository_permission` in it. Agents can also read it with the MCP tool `get_organization`. Any signed-in account can read the organization, but other accounts don't get that field.

```sh
curl https://diffinery.com/api/v3/orgs/acme \
  -H "Authorization: Bearer dfy_..."
```

```json
{
  "login": "acme",
  "type": "Organization",
  "html_url": "https://diffinery.com/acme",
  "avatar_url": "https://diffinery.com/api/avatars/acme",
  "name": "Acme Inc.",
  "default_repository_permission": "read"
}
```

(Other fields of GitHub's user object, such as `id`, `node_id` and `url`, are left out here.)

`PATCH /api/v3/orgs/{org}` changes it. Only owners and site administrators can call it, with a personal access token that has the `admin` scope and isn't restricted to repositories (or a browser session). The body takes:

| Field | Type | Description |
| --- | --- | --- |
| `default_repository_permission` | string | `none`, `read`, `write` or `admin`. |
| `name` | string | The display name. An empty value clears it, and pages show the organization name instead. |

```sh
curl -X PATCH https://diffinery.com/api/v3/orgs/acme \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"default_repository_permission": "write"}'
```

The response is the updated organization, including `default_repository_permission`. With the CLI, `diffinery api PATCH /orgs/acme -f default_repository_permission=write` sends the same request (it needs an `admin` token). There is no dedicated CLI command.

| Status | Message | Cause |
| --- | --- | --- |
| 403 | `this token needs the admin scope` | The token's scope is `read` or `write`. |
| 403 | `this token is limited to repositories and can't change account settings` | The token was created with a repository list. |
| 403 | `only organization owners can change its settings` | You are an admin or member of the organization, not an owner. |
| 404 | `not found` | The organization doesn't exist, or you aren't a member of it. |
| 422 | `base permission must be none, read, write or admin` | `default_repository_permission` has another value. |
| 422 | `name must be a string` | `name` is a number, object or other non-string value. |

Every field is checked before anything is saved, so a refused value changes nothing.

## Create an organization

Any active account can create an organization and becomes its first owner.

### In the web UI

1. Go to **Settings → Organizations** (`/settings/orgs`), or click **New organization** on your dashboard.
2. Under **New organization**, enter the **Organization name** (for example `acme`) and optionally a **Display name** (for example `Acme Inc.`).
3. Click **Create organization**.

Diffinery opens the new organization's **People** tab, where you can add people right away.

### With the API

```sh
curl -X POST https://diffinery.com/api/v3/user/orgs \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"login": "acme", "name": "Acme Inc."}'
```

The response (`201 Created`) describes the organization, with `"type": "Organization"` and its `html_url`.

Creating an organization through the API needs a personal access token with the `admin` scope that isn't restricted to repositories. A `read` or `write` token gets `403 this token needs the admin scope`, and a restricted token gets `403 this token is limited to repositories and can't change account settings`. In the browser no token is needed.

### Name rules

The organization name is its URL (`https://diffinery.com/acme`) and the owner part of every repository URL. It shares one namespace with usernames and agent names.

- Starts with a letter or digit, then letters, digits, `-` and `_`, up to 100 characters. Dots aren't allowed.
- Not already used by a person, organization or agent: "name already taken".
- Not reserved (for example `api`, `settings`, `new`, `login`, `admin`, `docs`): "invalid or reserved organization name".

## The organization page

Open `https://diffinery.com/acme` (you need to be signed in). The header shows the organization's picture, display name, name and your role ("you are an owner", "you are an admin" or "you are a member"). The tabs are:

| Tab | Who sees it | What it shows |
| --- | --- | --- |
| **Repositories** | Everyone signed in | Repositories you can see. Members get a **New repository** button. |
| **People** | Everyone signed in | Members and their roles. Owners and admins also get the **Add people** form and the **Pending invitations** list. |
| **Agents** | Everyone signed in | The organization's agents, their maximum role and status. Owners and admins get a **Manage agents** button. |
| **Settings** | Owners | The organization's picture, name, display name and [base permission](#base-permission), and its [agent policy and model keys](/docs/agents/organizations). Others get `403 organization owners only`. |
| **Packages** | Everyone signed in | Container images the organization owns (`/acme/-/packages`). See [Container registry](/docs/packages/container-registry). |

Members see every repository of the organization, unless the base permission is `none`: then they see public repositories and the ones they were given access to or created. People who aren't members only see repositories that are public, or that they were added to directly.

## Add and remove members

Owners and admins manage members on the **People** tab. The top of the tab shows how many members and pending invitations there are, for example "4 members · 1 pending invitation".

### Add people

The **Add people** form takes a username or an email address, like GitHub's "Add people" or "Invite member" dialog:

1. Open `https://diffinery.com/acme?tab=people`.
2. In **Username or email**, enter a username (`diffy`, or `@diffy`) or an email address (`friend@example.com`).
3. Choose a **Role**: **Member** (default) or **Admin**. Owners can also choose **Owner**.
4. Click **Add**.

What happens depends on who you entered:

| You entered | Result |
| --- | --- |
| The username of a person | Diffinery sends them an invitation, as on GitHub. You see "Invited diffy to acme as member. They join once they accept." They get an email ("@<your username> invited you to join the acme organization on Diffinery", with a **View invitation** button) and an in-app notification ("<your username> invited you to acme as member"), and become a member when they accept it under **Settings → Invitations** (see [Invitations you receive](/docs/accounts/invitations#invitations-you-receive)). If they already have a pending invitation to the organization, it offers the role you chose instead of sending another: "diffy already had a pending invitation; it now offers the admin role." |
| An email address | Diffinery creates an invitation and emails it, whether or not the address has an account: the form doesn't reveal who an address belongs to, and they join only by accepting. The page shows **Invitation sent to friend@example.com** with the link and a copy button: "We emailed them an invitation. You can also send them this link yourself. It works once and expires in 14 days: they join when they accept it, creating an account and passkey first if they don't have one." |

A site administrator who enters their own username joins at once. A person whose account is waiting for an invite (pending) becomes active when you invite their email address, or when they accept an invitation sent to their username. See [Invitations](/docs/accounts/invitations) for how invitations work, including inviting from the CLI and API.

| Message | Cause |
| --- | --- |
| "enter a username or an email address" | The field was empty. |
| "enter a valid email address" | The text has an `@` but isn't a complete address such as `friend@example.com`. |
| "no one has the username diffy; to invite someone new, enter their email address" | No account has that username. Enter their email address to invite them. |
| "review-bot is not a person; agents belong to an organization through Settings → Agents" | Agents and organizations can't be members. Create an organization agent instead (see [Organization agents](#organization-agents)). |
| "diffy's account is disabled" | A site administrator disabled the account. |
| "diffy is already a member of acme" | Change their role in the members table instead. |
| "friend@example.com already has a pending invitation; revoke it first to send a new one" | The address already has an open invitation to this organization. Letter case doesn't matter: `Friend@Example.com` counts as the same address. Revoke the invitation under **Pending invitations**, then add the address again. |
| "only owners can add owners" | Admins can add members and admins only. |
| "organization admins only" | Only owners, admins and site administrators can add people. |

### Pending invitations

Owners and admins see a **Pending invitations** list on the **People** tab with each invitation's email address (or `@diffy` for an invitation sent to a username, never the person's email address), who invited them and when, the expiry date and the role. Accepted, declined and expired invitations aren't listed.

To withdraw an invitation, click **Revoke** and confirm "Revoke the invitation for friend@example.com? The link stops working." (or "Revoke the invitation for @diffy?"). You see "Invitation revoked." Opening the revoked link shows "this invite is invalid, already used, or expired". The person isn't told.

### Change a member's role

In the member's row, pick a new role (**Owner**, **Admin** or **Member**) in the **Role** menu and click **Save**. The member gets an email saying their role changed and who changed it.

### Remove a member

Click **Remove** in the member's row and confirm "Remove diffy from acme?". The member loses the organization's repository access on their next request, including through their tokens, and gets an email saying they were removed. Any collaborator roles they or their agents had on the organization's repositories are removed too, including admin on repositories they created. Their personal repositories and accounts are not affected.

Rules:

| Rule | Message |
| --- | --- |
| Only owners can promote someone to owner, change an owner's role or remove an owner. | "only owners can manage owners" |
| An organization always keeps at least one owner: you can't remove or demote the last one. | "an organization needs at least one owner; make someone else an owner first" |
| Only owners and admins can manage members. | "organization admins only" |
| The username must belong to a person. | "user not found" |

### Leave an organization

There is no separate **Leave** button. Ask an owner or admin to remove you. Owners and admins can remove themselves from the **People** tab, as long as another owner remains.

## Organization repositories

Any member can create a repository owned by the organization.

- **Web UI:** click **New repository** on the organization's **Repositories** tab, or choose the organization as **Owner** on the **Create a new repository** page (`/new`).
- **CLI:** `diffinery repo create website --org acme` (add `--public` for a public repository; the default is private).
- **API:** `POST /api/v3/orgs/acme/repos` with `{"name": "website", "visibility": "private"}`. The CLI and API need a token with the `write` or `admin` scope that isn't restricted to repositories; a `read` token gets `403 this token needs the write scope`.

Access to organization repositories comes from the organization role (members get the [base permission](#base-permission), owners and admins get admin), plus any collaborators added under the repository's **Settings → Collaborators**, which can include people outside the organization and agents. A member who creates a repository is added to it as an `admin` collaborator, whatever the base permission. When a repository is created, the organization's other owners and admins get an email, and when one is deleted they are told who deleted it.

## Organization secrets

Organization Actions secrets are available to workflows in every repository the organization owns, as `${{ secrets.NAME }}`. If a repository has a secret with the same name, the repository's value wins.

Owners and admins (and site administrators) manage them with the CLI or the API; agents can't (`403 agents cannot manage secrets`). There is no page for them in the web UI yet. Listing, setting and deleting all need a personal access token with the `admin` scope that isn't restricted to repositories: other tokens get `403 this token needs the admin scope` or `403 this token is limited to repositories and can't change account settings`.

```sh
# Create or update (the value is read from a hidden prompt, stdin or --body)
diffinery secret set NPM_TOKEN --org acme

# List names and when they were updated (values are never returned)
diffinery secret list --org acme

# Delete
diffinery secret delete NPM_TOKEN --org acme
```

| Method and path | What it does |
| --- | --- |
| `GET /api/v3/orgs/{org}/actions/secrets` | List secret names and `updated_at` |
| `PUT /api/v3/orgs/{org}/actions/secrets/{name}` | Create or update; body `{"value": "..."}`; returns `204` |
| `DELETE /api/v3/orgs/{org}/actions/secrets/{name}` | Delete; returns `204` |

Names are stored in upper case and must match `^[A-Z_][A-Z0-9_]*$` after upper-casing, otherwise the API returns `422 invalid secret name`. Values are encrypted at rest. Deleting a secret that doesn't exist returns `404 secret not found` and isn't recorded. Each change is recorded in the [audit log](/docs/security/audit-log) as `org.secret.set` or `org.secret.delete`, with the organization as the target and the secret's name (never its value) in the detail. See [Secrets and variables](/docs/actions/secrets-and-variables) for how workflows use them.

## Organization variables

Organization Actions variables are available to workflows in every repository the organization owns, as `${{ vars.NAME }}`, including repositories created later. If a repository has a variable with the same name, the repository's value wins, and an environment variable wins over both. Unlike secrets, variable values are stored and returned in plain text.

Owners and admins (and site administrators) manage them with the REST API; there is no page for them in the web UI and no CLI command. Agents can't read or manage them, whatever their role (`403 organization admins only`, or `404 not found` when neither the agent nor its owner belongs to the organization). Members who aren't owners or admins get `403 organization admins only`. Reading needs a token of any scope; creating, changing and deleting need a personal access token with the `admin` scope that isn't restricted to repositories.

| Method and path | What it does |
| --- | --- |
| `GET /api/v3/orgs/{org}/actions/variables` | List variables with their values, sorted by name (not paged) |
| `GET /api/v3/orgs/{org}/actions/variables/{name}` | One variable, or `404 variable not found` |
| `POST /api/v3/orgs/{org}/actions/variables` | Create or replace; body `{"name": "...", "value": "..."}`; returns `201` |
| `PATCH /api/v3/orgs/{org}/actions/variables/{name}` | Set the value (creating the variable if needed); body `{"value": "..."}`; returns `204` |
| `DELETE /api/v3/orgs/{org}/actions/variables/{name}` | Delete; returns `204` |

```sh
curl -X POST https://diffinery.com/api/v3/orgs/acme/actions/variables \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "NPM_REGISTRY", "value": "https://registry.npmjs.org"}'
```

Names must match `^[A-Za-z_][A-Za-z0-9_]*$`, can't start with `GITHUB_` (`422 invalid variable name`) and are stored in upper case. Values are strings of at most 48 KB (`422 value must be a string of at most 48 KB`). Every variable applies to all of the organization's repositories (`"visibility": "all"`); there is no per-repository selection. Each change is recorded in the [audit log](/docs/security/audit-log) as `org.variable_set` or `org.variable_delete`, with the organization as the target and the variable's name in the detail. A [GitHub organization import](/docs/migrate-from-github) adds the GitHub organization's variables that don't exist here yet. See [Secrets and variables](/docs/actions/secrets-and-variables#organization-variables) for the full details and the differences from GitHub.

## Organization agents

An agent can be owned by an organization instead of a person, so it keeps working when people come and go. Owners and admins create one under **Settings → Agents** by choosing the organization as **Owner**, or with `diffinery agent create review-bot --org acme`. An organization agent can only reach that organization's repositories, and its security emails (new tokens, expiring tokens) go to the organization's owners and admins. See [Agents](/docs/agents/overview).

## Organization picture

The organization's picture shows on its page, next to its repositories and in member lists. Without one, Diffinery shows the first letter or digit of the organization's name on a colored background.

Owners change it on the **Settings** tab, in the **Profile picture** box:

1. Under **Upload a new picture**, choose a JPEG, PNG or WebP file of up to 5 MB. It is cropped to a centred square; a preview shows the result.
2. Click **Save picture**. You see "Organization picture updated."
3. To go back to initials, click **Remove picture** and confirm "Remove the picture of acme?". You see "Organization picture removed."

Owners (and site administrators) can also change it through the API, with a token that has the `write` or `admin` scope and isn't restricted to repositories. The body is the raw image file:

```sh
curl -X PUT https://diffinery.com/api/v3/orgs/acme/avatar \
  -H "Authorization: Bearer dfy_..." \
  --data-binary @logo.png

curl -X DELETE https://diffinery.com/api/v3/orgs/acme/avatar \
  -H "Authorization: Bearer dfy_..."
```

Both return `200` with the picture's URL, for example `{"avatar_url": "https://diffinery.com/api/avatars/acme?v=1760350000"}` after an upload and `{"avatar_url": "https://diffinery.com/api/avatars/acme"}` after removing it. Errors include `403 only organization owners can change its picture` for admins and members, and `404 not found` when you aren't in the organization. See [Profile and preferences](/docs/accounts/profile-and-preferences#profile-pictures) for the limits, error messages, the public picture URL and caching.

## Rename an organization

Owners open the **Settings** tab, change **Organization name**, **Display name** or **Base permission** and click **Save**. You see "Organization updated." Every field is checked before anything is saved, so a value that's refused changes nothing. If you clear **Display name**, pages show the organization name instead, and the API returns `"name": null`. The display name can also be changed with `PATCH /api/v3/orgs/{org}` and `{"name": "Acme Inc."}` (see [Change the base permission with the API](#change-the-base-permission-with-the-api)); the organization name can't. Renaming changes every repository URL in the organization, so existing clones need a new remote URL:

```sh
git remote set-url origin https://diffinery.com/acme-inc/website.git
```

URLs with the old name keep working, like those of a [transferred repository](/docs/repositories/overview#old-urls-after-a-transfer-or-rename): web pages and the API redirect, and Git and container images are served under the old name, until another person or organization takes it.

## Delete an organization

Deleting an organization removes it for good. It is allowed only once the organization owns nothing that people still use: no repositories and no container images, and no GitHub import running into it. Unlike GitHub, deleting an organization never deletes its repositories along with it: move them out first.

### Before you delete

- **Who:** organization owners (and site administrators). Admins and members can't delete it.
- **Repositories:** [transfer](/docs/repositories/overview#transfer-a-repository) each repository to another owner, or delete it. Transferred repositories keep their old URLs working after the organization is gone.
- **Container images:** delete the organization's images (images linked to a repository move with it when you transfer the repository). See [Container registry](/docs/packages/container-registry).
- **Imports:** wait for an import into the organization to finish, or cancel it, including drafts and queued imports.

### Delete in the web UI

1. Open the organization's page and its **Settings** tab (owners only).
2. In the **Danger zone**, under **Delete this organization**, type the organization's login (for example `acme`) in the confirmation box.
3. Click **Delete this organization**.

You see `Deleted acme.` and land on your home page. If you signed in more than 2 hours ago, Diffinery first asks you to [Confirm it's you](/docs/security/overview#confirming-its-you) with your passkey.

### Delete with the API

```sh
curl -X DELETE https://diffinery.com/api/v3/orgs/acme \
  -H "Authorization: Bearer dfy_..."
```

It returns `202 Accepted` with an empty object (`{}`) once the organization is deleted. It needs a token with the `admin` scope that isn't limited to repositories.

### What deleting does

- Its members, pending invitations, organization secrets and organization variables are removed.
- Its agents are disabled, and their tokens revoked.
- Its login is freed: anyone can create a user or organization with that name afterwards. Older logins from earlier renames stop redirecting.
- Repositories transferred out of it earlier keep their redirects: their old URLs under its name still lead to them, until a repository is created at that owner and name (see [Old URLs after a transfer or rename](/docs/repositories/overview#old-urls-after-a-transfer-or-rename)).
- Its page and API answer `404`.
- The audit log keeps the entries that name it, and records the deletion as `org.delete`. Its import history and agents still refer to it.

Deleting can't be undone. To use the name again, create a new organization.

### Errors when deleting

| Message | Cause and fix |
| --- | --- |
| `acme still owns 3 repositories; transfer or delete them before deleting the organization` (422) | Transfer or delete the repositories first. |
| `acme still owns 2 container images; delete them before deleting the organization` (422) | Delete the images first. |
| `an import into acme is still in progress; wait for it to finish or cancel it first` (422) | Wait for the import, or cancel it. |
| `only organization owners can delete it` (403) | You are an admin or member. Ask an owner. |
| `not found` (404) | The organization doesn't exist, or you aren't a member of it. |
| `this token needs the admin scope` (403) | Use a token with the `admin` scope. |
| `this token is limited to repositories and can't change account settings` (403) | Use a token that isn't restricted to repositories. |
| `type acme to confirm deletion` | The web confirmation box didn't match the organization's login. |
| `organization owners only` | Only owners can delete the organization from the web UI. |

## Organizations API

| Method and path | Description |
| --- | --- |
| `GET /api/v3/user/orgs` | Organizations you belong to, each with your `role` |
| `POST /api/v3/user/orgs` | Create an organization: `{"login": "acme", "name": "Acme Inc."}`. Needs an `admin` token. |
| `GET /api/v3/orgs/{org}` | The organization; members, their agents and site administrators also get `default_repository_permission` |
| `PATCH /api/v3/orgs/{org}` | Change `name` or `default_repository_permission` (`none`, `read`, `write` or `admin`). Owners only; needs an `admin` token. |
| `DELETE /api/v3/orgs/{org}` | Delete the organization once it owns no repositories, container images or running imports; returns `202`. Owners only; needs an `admin` token. See [Delete an organization](#delete-an-organization). |
| `GET /api/v3/orgs/{org}/members` | Members and their roles. Members and site administrators only; others get `404`. |
| `POST /api/v3/orgs/{org}/invitations` | Invite by email: `{"email": "...", "role": "member"}`. Needs an `admin` token. See [Invitations](/docs/accounts/invitations#invite-with-the-api). |
| `GET /api/v3/orgs/{org}/invitations` | Pending invitations, each with an `id`. Owners and admins. |
| `DELETE /api/v3/orgs/{org}/invitations/{id}` | Revoke a pending invitation; returns `204`. Owners and admins; needs an `admin` token. |
| `GET /api/v3/orgs/{org}/repos` | Repositories you can see in the organization |
| `POST /api/v3/orgs/{org}/repos` | Create a repository in the organization. Needs a `write` or `admin` token. |
| `GET`, `PUT`, `DELETE /api/v3/orgs/{org}/actions/secrets[/{name}]` | Organization secrets. Needs an `admin` token. |
| `GET`, `POST`, `PATCH`, `DELETE /api/v3/orgs/{org}/actions/variables[/{name}]` | Organization variables. Owners and admins; changes need an `admin` token. |
| `PUT /api/v3/orgs/{org}/avatar` | Upload the organization's picture (raw image body). Owners only. |
| `DELETE /api/v3/orgs/{org}/avatar` | Remove the organization's picture. Owners only. |

Organization objects in API responses follow GitHub's shape, with `"type": "Organization"`, `html_url` and `avatar_url`.

Every endpoint in this table that changes something is an account-level action: besides the scope noted, the token must not be restricted to repositories, or the request gets `403 this token is limited to repositories and can't change account settings` (the picture endpoints answer `403 changing a profile picture needs a write or admin token that is not limited to repositories`). See [Personal access tokens](/docs/accounts/tokens#account-level-actions).

Adding people by username, changing a member's role and removing a member are done in the web UI. A person accepts an invitation to an organization with `PATCH /api/v3/user/memberships/orgs/{org}` and `{"state": "active"}` (see [Invitations you receive](/docs/accounts/invitations#accept-or-decline-with-the-api)). The full list of endpoints is in the [API reference](/docs/api).

## How organizations differ from GitHub

- Diffinery has three organization roles: owner, admin and member. Admins manage members, invitations, agents, secrets and variables but can't manage owners, open the organization's **Settings** tab or change the organization's picture.
- The base permission works like GitHub's, with the same four values (`none`, `read`, `write`, `admin`) and the same default for new organizations (`read`). Organizations created before Diffinery had the setting use `write`.
- A member who creates a repository gets `admin` on it, as on GitHub.
- There are no teams. Give extra access per repository under **Settings → Collaborators**.
- **Add people** works like GitHub's: enter a username or an email address. Someone added by username gets an invitation and joins when they accept it under **Settings → Invitations**. An email address gets an invitation link, which also creates the account if there is none.
- Organization pages need you to be signed in.
- Organization secrets and variables apply to every repository in the organization; there is no per-repository selection.
- Deleting an organization is refused while it owns repositories or container images; GitHub deletes them with it. Transfer or delete them first.
- Repositories can be transferred only to your own account or to an organization you own or administer, so a transfer needs no acceptance by the new owner.
