---
title: Invitations
description: How people join an invite-only Diffinery instance, who can invite, Add people by username or email, accepting or declining invitations, revoking them, the CLI and API, and access requests.
---

Diffinery is invite-only by default: nobody can sign up from the sign-in page. (An operator can turn on [open sign-up](/docs/accounts/passkeys-and-sign-in#open-sign-up) with `SIGNUP=open`, where people create an account by confirming their email with a code; invitations work the same either way.) A person joins by opening an invite link sent to their email address, picking a username and creating a passkey. Organizations and repositories have an **Add people** form that takes a username or an email address. Either way the person gets an invitation, as on GitHub: someone added by username accepts it under **Settings → Invitations**, and an email address gets an invite link that also creates the account if there is none.

Without an invitation, someone can [request early access](/docs/accounts/early-access) at `/early-access`, which the sign-in page links to. A site administrator reads the request and decides whether to invite them.

## How sign-up works

1. Someone with permission creates an invite for an email address. The invite can be for the whole instance, for an organization (with an organization role) or for a repository (with a repository role).
2. Diffinery emails the invite link to that address, and shows the link to the person who created it so they can also send it another way.
3. The invited person opens the link from the invitation email, picks a username, creates a passkey and is signed in. The emailed link carries a proof that they can read mail at that address. The link the inviter sees (`https://diffinery.com/invite/<token>`) doesn't: opening it shows **Confirm your email** with an **Email me the link** button, which sends the link to the invited address again (at most once every 2 minutes and 5 times a day).
4. Their account is active, and every open invite for their email address is accepted at once: they join each organization and repository they were invited to.
5. They land on the organization or repository of the invite they opened (or the dashboard, for an instance invite).

Nobody needs a password or a Cloudflare account. After joining, they use their passkey in the browser and create [personal access tokens](/docs/accounts/tokens) for Git, the CLI and agents.

## Who can invite

| Who | What they can invite to | Where |
| --- | --- | --- |
| Site administrators | The instance (no organization or repository), and any organization | **Settings → People and invitations**, an organization's **People** tab, `diffinery invite`, the API |
| Organization owners | Their organization, as member, admin or owner | The organization's **People** tab (**Add people**), `diffinery invite --org`, the API |
| Organization admins | Their organization, as member or admin | The organization's **People** tab (**Add people**), `diffinery invite --org`, the API |
| Repository admins (including the owner of a personal repository) | One repository, with a repository role from read to admin | The repository's **Settings → Collaborators** page (**Add people**), `PUT /api/v3/repos/{owner}/{repo}/collaborators/{username}` |

Everyone else, including organization members and people with a lower repository role, can't create invites.

## Invite from the web UI

### Invite someone to the instance

Site administrators only. An instance invite lets the person create an account, without adding them to any organization or repository.

1. Open **Settings → People and invitations** (`/settings/admin`).
2. Under **Invite someone to this instance**, enter the **Email address**.
3. Click **Send invitation**.

The page shows "Invite created for <email>" with the link and a copy button: "We emailed it to <email>; you can also send it yourself. It expires in 14 days and works once: they pick a username and create a passkey."

An address can have only one pending instance invitation at a time (letter case doesn't matter). A second one is refused with "friend@example.com already has a pending invitation; revoke it first to send a new one"; revoke the first one under **Pending invitations** on the same page, then invite the address again.

### Add people to an organization

Organization owners and admins, and site administrators. The **Add people** form on the organization's **People** tab takes a username or an email address.

1. Open the organization's page, for example `https://diffinery.com/acme`, and click the **People** tab.
2. Under **Add people**, enter a **Username or email**: `diffy` (or `@diffy`) for someone who has an account, or `friend@example.com` for anyone.
3. Choose a **Role**: **Member** (default), **Admin** or **Owner**. Only owners can choose **Owner**.
4. Click **Add**.

| You entered | What happens |
| --- | --- |
| A username | Diffinery sends them an invitation: "Invited diffy to acme as member. They join once they accept." They get an email and an in-app notification, and join when they accept it under **Settings → Invitations** (see [Invitations you receive](#invitations-you-receive)). If they already have a pending invitation to the organization, it offers the role you chose instead of sending another: "diffy already had a pending invitation; it now offers the admin role." |
| An email address | Diffinery emails an invitation, whether or not the address has an account, so the form never tells you who an address belongs to and nobody joins without agreeing. The page shows **Invitation sent to friend@example.com** with the link and a copy button, and the note "We emailed them an invitation. You can also send them this link yourself. It works once and expires in 14 days: they join when they accept it, creating an account and passkey first if they don't have one." |

A site administrator who enters their own username joins at once. The invitation then appears under **Pending invitations** on the same tab, with who sent it, when, the expiry date and the role. An invitation sent to a username shows as `@diffy`, never the person's email address. See [Organizations](/docs/accounts/organizations#add-people) for every message the form can show.

An email address can have only one pending invitation per organization, whether it came from this form, the CLI or the API. Letter case doesn't matter: `Friend@Example.com` and `friend@example.com` are the same address. To send a new one, revoke the old one first ("friend@example.com already has a pending invitation; revoke it first to send a new one").

### Revoke an invitation

Every pending invitation can be revoked until it's used:

- organization invitations on the organization's **People** tab (owners and admins);
- repository invitations on the repository's **Settings → Collaborators** page (repository admins);
- instance invitations on **Settings → People and invitations** (site administrators).

Under **Pending invitations**, click **Revoke** next to the invitation and confirm "Revoke the invitation for friend@example.com? The link stops working." (for an invitation sent to a username: "Revoke the invitation for @diffy?"). You see "Invitation revoked." Opening the link afterwards shows "this invite is invalid, already used, or expired", and an invitation sent to a username disappears from the person's **Settings → Invitations**. The person isn't notified, and you can invite the same address or username again.

### Add people to a repository

Repository admins. The **Add people** form on the repository's **Settings → Collaborators** page (`/acme/website/settings/access`) works the same way, and also accepts agents:

1. Under **Add people**, enter a **Username or email**: a person (`diffy`), an agent (`review-bot`) or an email address (`friend@example.com`).
2. Choose a **Role**: **Read**, **Triage**, **Write** (default), **Maintain** or **Admin**.
3. Click **Add**.

| You entered | What happens |
| --- | --- |
| The username of a person | Diffinery sends them an invitation: "Invited diffy with write access. They get access once they accept." They get an email and an in-app notification, and get the role when they accept it under **Settings → Invitations** (see [Invitations you receive](#invitations-you-receive)). If they already have a pending invitation to the repository, it offers the role you chose instead of sending another: "diffy already had a pending invitation; it now offers admin access." |
| The username of an agent, of a person who already is a direct collaborator, of a member of the organization that owns the repository, or your own | They get the role right away as a direct collaborator, with no invitation: "diffy now has write access. We let them know." People get an email and an in-app notification. A collaborator's role changes to the one you chose. |
| An email address | Diffinery emails an invitation, whether or not the address has an account, and shows **Invitation sent to friend@example.com** with the link to send yourself. When the person accepts it, they get that role on the repository. |

| Message | Cause |
| --- | --- |
| "no one has the username diffy; to invite someone new, enter their email address" | No account has that username. |
| "acme is an organization; add its people instead" | Organizations can't be collaborators. |
| "diffy's account is disabled" | A site administrator disabled the account. |
| "enter a valid email address" | The text has an `@` but isn't a complete address. |
| "friend@example.com already has a pending invitation; revoke it first to send a new one" | The address already has an open invitation to this repository (letter case doesn't matter). Revoke it under **Pending invitations**, then add the address again. |

Pending invitations are listed under **Pending invitations** on the same page, where you can revoke them. See [Permissions](/docs/accounts/permissions) for what each role allows.

## Invite from the CLI

`diffinery invite` invites to an organization, or to the instance when you leave out `--org` (site administrators only). You need to be logged in (`diffinery login`) with a token that has the `admin` scope and isn't restricted to repositories; a `read` or `write` token gets `403 this token needs the admin scope`. If you don't have the CLI yet:

```sh
curl -fsSL https://diffinery.com/install | bash
diffinery login --scope admin
```

The CLI needs Node.js 22 or later.

```sh
# Invite to the acme organization as a member (the default role)
diffinery invite friend@example.com --org acme

# Invite as an organization admin
diffinery invite friend@example.com --org acme --role admin

# Invite to the instance only (site administrators)
diffinery invite friend@example.com
```

| Option | Description |
| --- | --- |
| `-o, --org ORG` | Organization to join. Leave it out for an instance invite, which only site administrators can create. |
| `-r, --role ROLE` | `member` (default), `admin` or `owner`. Needs `--org`. |
| `--json` | Print the API response (`id` and `url`) as JSON. |

The command prints the invite link and reminds you that it is valid for 14 days. Like the web form, `diffinery invite` always creates an invitation, even when the address already has an account (they accept it with **Accept invite**; see [Accept an invite with an existing account](#accept-an-invite-with-an-existing-account)). It refuses an address that already has a pending invitation to the organization (see [API errors](#api-errors)). The CLI can't create repository invites; use the repository's **Settings → Collaborators** page or `PUT /api/v3/repos/{owner}/{repo}/collaborators/{username}`. See [CLI reference](/docs/reference/cli) for every command.

## Invite with the API

The organization and instance endpoints take a JSON body and return `201 Created` with the invite's `id` and `url`. Diffinery also emails the link.

Inviting to an organization or the instance is an account-level action, so both endpoints need a personal access token with the `admin` scope that isn't restricted to repositories (or a browser session). A token with only `read` or `write` gets `403 this token needs the admin scope`, and a token restricted to repositories gets `403 this token is limited to repositories and can't change account settings`. See [Personal access tokens](/docs/accounts/tokens#account-level-actions).

### Organization invite

`POST /api/v3/orgs/{org}/invitations`

| Field | Type | Description |
| --- | --- | --- |
| `email` | string | Required. The address to invite. |
| `role` | string | `member` (default), `admin` or `owner`. |

```sh
curl -X POST https://diffinery.com/api/v3/orgs/acme/invitations \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"email": "friend@example.com", "role": "member"}'
```

```json
{ "id": "3f1c0e8a9b7d4c2e8f6a5b4c3d2e1f0a", "url": "https://diffinery.com/invite/..." }
```

The caller must be an owner or admin of the organization, or a site administrator. Only owners (and site administrators) can invite with the `owner` role. Like the CLI and the web form, this endpoint always creates an invitation; it doesn't add existing accounts directly. It refuses an address that already has a pending invitation to the organization (compared without regard to letter case). An address whose account is already a member still gets an invitation, so the answer never tells you whose address it is; accepting it changes nothing.

### Instance invite

`POST /api/v3/invitations` with `{"email": "friend@example.com"}`. Site administrators only.

### Repository invite by username

`PUT /api/v3/repos/{owner}/{repo}/collaborators/{username}` with `{"permission": "write"}` works like **Add people** on the repository's **Settings → Collaborators** page. It needs admin on the repository, through an `admin` token (it may be restricted to that repository) or a browser session.

- When the person gets an invitation, the answer is `201 Created` with the invitation: `id`, `repository` (`full_name`, `name`, `owner.login`), `invitee`, `inviter` (`login`), `permissions`, `created_at`, `expires_at` and `html_url` (their **Settings → Invitations** page). If they already had a pending invitation to the repository, the same invitation now offers the new role.
- When the role applies at once (an agent, someone who already is a direct collaborator, a member of the organization that owns the repository, or yourself), the answer is `204 No Content`.

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/collaborators/diffy \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"permission": "write"}'
```

It answers `404 user not found` when no account has that username, `422 diffy's account is disabled` for a disabled account, and `429 you can send at most 50 invitations in 24 hours; try again later` like the other ways of inviting.

### List and revoke pending invitations

| Method and path | Who |
| --- | --- |
| `GET /api/v3/orgs/{org}/invitations`, `DELETE /api/v3/orgs/{org}/invitations/{id}` | The organization's owners and admins |
| `GET /api/v3/repos/{owner}/{repo}/invitations`, `DELETE /api/v3/repos/{owner}/{repo}/invitations/{id}` | The repository's admins |
| `GET /api/v3/invitations`, `DELETE /api/v3/invitations/{id}` | Site administrators (instance invitations only) |

Each listed invitation has an `id`, `email`, `login`, `role`, `inviter`, `created_at` and `expires_at`. An invitation sent to an email address has the `email` and a `login` of `null`; one sent to a username has the `login` and an `email` of `null`. `DELETE` returns `204 No Content`, or `404 no pending invitation with this id` when the invitation was already used or revoked, or belongs to another organization, repository or kind. Revoking organization and instance invitations needs an `admin` token; revoking a repository invitation needs admin on the repository. Agents use the MCP tools `list_invitations` and `revoke_invitation` with `owner` and `repo`, `org`, or neither.

### API errors

| Status | Message | Cause |
| --- | --- | --- |
| 401 | `sign in required` | No token was sent. |
| 403 | `this token needs the admin scope` | The token's scope is `read` or `write`. Create an `admin` token. |
| 403 | `this token is limited to repositories and can't change account settings` | The token was created with a repository list. Use a token without one. |
| 403 | `only organization owners and admins can invite` | You are not an owner or admin of the organization. |
| 403 | `only owners can invite owners` | An organization admin asked for `"role": "owner"`. |
| 403 | `only site admins can invite people without an organization` | Instance invites need a site administrator. |
| 429 | `you can send at most 50 invitations in 24 hours; try again later` | You sent 50 invitations in the last 24 hours. Site administrators aren't limited. See [Limits](/docs/reference/limits#email). |
| 404 | `not found` | The organization doesn't exist, or the name is not an organization. |
| 422 | `a valid email is required` | The `email` field is missing or isn't an email address. |
| 422 | `role must be member, admin or owner` | `role` has another value. |
| 422 | `friend@example.com already has a pending invitation; revoke it first to send a new one` | The address already has an open invitation to this organization (or, for `POST /api/v3/invitations`, an open instance invitation). Letter case doesn't matter. Revoke the organization invitation on the **People** tab first. |

Error bodies are JSON: `{"message": "...", "documentation_url": "..."}`.

The full endpoint list is in the [API reference](/docs/api).

## The invite email

Diffinery sends the invite from `notifications@diffinery.com`. The subject depends on the kind of invite:

| Invite | Subject |
| --- | --- |
| Organization | `@diffy invited you to join the acme organization on Diffinery` |
| Repository | `@diffy invited you to collaborate on acme/website` |
| Instance | `@diffy invited you to Diffinery` |

The email lists who invited you, the organization or repository and the role (for organization and repository invites) and the expiry date, and has an **Accept invitation** button. It says the invitation only works for that email address. Invite emails can't be turned off, because they are the only way to reach someone without an account.

If the address already belongs to a Diffinery account, the email goes to that account.

An invitation sent to a username has the same subject and details, but its button is **View invitation** and opens **Settings → Invitations** (`/settings/invitations`), where you accept or decline it. It carries no link that accepts the invitation by itself. See [Invitations you receive](#invitations-you-receive).

## Invite link rules

| Rule | Value |
| --- | --- |
| Lifetime | 14 days from creation |
| Uses | Once. A used, revoked or expired link shows "this invite is invalid, already used, or expired" (HTTP 404). If you are already signed in, the page still shows **Accept invite**, and clicking it answers "this invite is invalid or has expired" (HTTP 404). |
| Who can use it | Only the email address it was sent to |
| Link format | The emailed link is `https://<host>/invite/<token>#proof=<proof>`. The proof, which shows you received the email, is in the URL fragment: browsers never send it to the server, so it can't end up in request logs. The page removes it from the address bar. Older links with `?proof=` still work. |
| What joining accepts | Every open invite for that email address, not just the one you opened |
| Withdrawing | Pending invitations can be revoked: organization invitations on the organization's **People** tab, repository invitations on the repository's **Settings → Collaborators** page, instance invitations on **Settings → People and invitations**. Otherwise they stop working once used or after 14 days. |

If you sent a repository or instance invite to the wrong address, a site administrator can disable the account it creates (see [Site administration](/docs/admin/site-administration#people)).

## Choosing a username

The **Join Diffinery** page suggests a username made from the part of the email address before the `@`. Rules:

- Starts with a letter or digit, then letters, digits, `-` and `_`, up to 39 characters.
- Not already taken (case-insensitive) and not reserved. Reserved names include `api`, `mcp`, `settings`, `new`, `notifications`, `invite`, `login`, `admin`, `explore`, `docs`, `auth`, `signin`, `signup`, `security`, `status`, `diffinery`, `ghost`, `github-actions`, `noreply`, `support`, `abuse`, `postmaster`, `root` and `staff`.

Your username is part of your repository URLs (`https://diffinery.com/<username>/<repo>`). You can change it later under **Settings → Profile**, which changes those URLs; existing clones then need a new remote URL (see [Profile and preferences](/docs/accounts/profile-and-preferences#change-your-username)).

| Message | What to do |
| --- | --- |
| "Usernames use letters, numbers and dashes (up to 39), and some names are reserved." | Pick a name that follows the rules above. |
| "The username <name> is taken. Pick another one." | Pick another name. |
| "<email> already has an account. Sign in with its passkey, then open this invite again." | The address already has an account: sign in, then open the link and click **Accept invite**. |
| "This invite has no email address. Sign in first, then open it again." | Sign in with your existing account, then open the link again. |

## Accept an invite with an existing account

If the invited address already has an account:

1. Open the invite link from the email. The page says the address already has an account and shows a **Sign in** button. (A copy of the link without the email's proof, such as the one the inviter sees, asks you to confirm your email instead, and also offers **Sign in** to accept.)
2. Sign in with your passkey. Diffinery brings you back to the invite.
3. Click **Accept invite**.

You are taken to the repository or organization you were invited to. The invite only works when the signed-in account's email address matches; otherwise you get "this invite was sent to <email>; sign in with that address" (HTTP 403).

When someone accepts your invite, you get an "@<username> accepted your invitation" email (part of the **Organizations** email group, which you can turn off; see [Notifications](/docs/accounts/notifications)). For an invitation you sent to a username, the email doesn't show the person's email address.

## Invitations you receive

When an organization owner or admin, or a repository admin, adds you by username, you get an invitation instead of access, as on GitHub. You get an in-app notification (kind `invitation`, for example "diffy invited you to acme as member" or "diffy invited you to acme/website as write") and an email with a **View invitation** button. Both lead to **Settings → Invitations**. You have no access until you accept.

### Accept or decline in the web UI

Open **Settings → Invitations** (`/settings/invitations`). It lists your pending invitations to organizations and repositories: those sent to your username, and those sent to your email address. Each one shows the organization or repository, the role, who invited you, when, and when it expires. With none, the page shows "No pending invitations."

- **Accept** gives you the role and takes you to the repository or organization.
- **Decline** deletes the invitation. You see "Invitation declined." Nobody is told, and they can invite you again.

An invitation expires after 14 days. If the admin adds you again while one is pending, that invitation offers the new role; you don't get a second one.

If your account is waiting for an invite (see [Pending accounts](#pending-accounts)), your invitations appear under **Your invitations** on the **Waiting for an invite** page instead, with the same **Accept** and **Decline** buttons. Accepting one makes your account active.

### Accept or decline with the API

The endpoints follow GitHub's. Listing needs a token with at least the `read` scope; accepting and declining need `write` or `admin`. All of them refuse tokens restricted to repositories (`403 this token is limited to repositories and can't change account settings`).

| Method and path | What it does |
| --- | --- |
| `GET /api/v3/user/repository_invitations` | Your pending repository invitations: `id`, `repository` (`full_name`, `name`, `owner.login`), `invitee`, `inviter` (`login`), `permissions`, `created_at`, `expires_at`, `html_url` |
| `PATCH /api/v3/user/repository_invitations/{id}` | Accept a repository invitation. Returns `204 No Content`. |
| `DELETE /api/v3/user/repository_invitations/{id}` | Decline a repository invitation. Returns `204 No Content`. |
| `GET /api/v3/user/memberships/orgs` | Your organization memberships, pending invitations first. Add `?state=active` or `?state=pending` for only one kind. |
| `GET /api/v3/user/memberships/orgs/{org}` | Your membership of one organization, active or pending. `404 not found` when you have neither. |
| `PATCH /api/v3/user/memberships/orgs/{org}` | With `{"state": "active"}`, accept your pending invitation to the organization. Returns the membership. |

A membership has `url`, `state` (`active` or `pending`), `role` (`admin` or `member`, as on GitHub, where owners count as `admin`), `diffinery_role` (`owner`, `admin` or `member`), `organization` (`login`, `url`) and `user`.

```sh
# List your repository invitations
curl https://diffinery.com/api/v3/user/repository_invitations -H "Authorization: Bearer dfy_..."

# Accept one
curl -X PATCH https://diffinery.com/api/v3/user/repository_invitations/3f1c0e8a9b7d4c2e8f6a5b4c3d2e1f0a -H "Authorization: Bearer dfy_..."

# Accept an invitation to the acme organization
curl -X PATCH https://diffinery.com/api/v3/user/memberships/orgs/acme \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"state": "active"}'
```

| Status | Message | Cause |
| --- | --- | --- |
| 404 | `no pending invitation with this id` | The id is unknown, the invitation was already accepted, declined, revoked or expired, or it is someone else's. |
| 404 | `no pending invitation to this organization` | `PATCH /user/memberships/orgs/{org}` when you have no pending invitation to it and aren't a member. If you already are a member, the answer is your active membership. |
| 422 | `state must be "active"` | The `PATCH` body has another `state`, or none. |

An account that is waiting for an invite can't use the API; it accepts on the **Waiting for an invite** page.

## Pending accounts

An account can exist without being active. Its status is **pending** when someone verified their email address through email recovery (`/auth/access`) without having an invite. A pending account:

- can sign in, but only sees a **Waiting for an invite** page, which lists its pending invitations to organizations and repositories under **Your invitations**,
- can't see repositories, create organizations or tokens, or use the API (requests return "your account is waiting for an invite"),
- becomes active as soon as anyone creates an invite for its email address (including with **Add people**), the person accepts an invitation on the **Waiting for an invite** page, or a site administrator approves it. Being invited by username doesn't make the account active by itself.

> **Note:** If email recovery is set up on the instance and an invited person verifies their address at `/auth/access` instead of opening the invite link, Diffinery creates their account right away with a username based on their email address, accepts their invites and asks them to add a passkey.

## Access requests

From the **Waiting for an invite** page, a person with a pending account can ask the administrators for access:

1. Optionally write a **Note to the administrators** (up to 500 characters), for example who you are and what you want to work on.
2. Click **Request access**. You see "Request sent. An administrator will review it."

Diffinery emails up to 20 active site administrators an "<email> asked for access" message with the note. The request appears under **Pending access requests** on **Settings → People and invitations**, where an administrator clicks **Approve** (the account becomes active) or **Deny** (the account is disabled). Sending another request replaces the earlier note.

Approving an account doesn't add it to any organization or repository; invite the person or add them by username for that.

## How invitations differ from GitHub

- On GitHub anyone can create an account. On an invite-only Diffinery instance (the default) the only ways in are an invite, an approved access request, or being listed as a bootstrap administrator of the instance; with open sign-up, anyone who can read mail at their address can join too.
- GitHub organization and repository invitations go to existing GitHub users. Diffinery invites can also go to an email address, and the same link creates the account.
- **Add people** takes a username or an email address, as on GitHub. Someone added by username gets an invitation to accept under **Settings → Invitations**, as on GitHub. An email address always gets an invitation link, whether or not it has an account.
- Pending invitations of every kind can be revoked, in the web UI, the API or over MCP; otherwise they expire after 14 days.
