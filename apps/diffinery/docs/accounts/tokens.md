---
title: Personal access tokens
description: Create, scope, restrict, use and revoke Diffinery personal access tokens (dfy_) for Git, the REST API, the CLI and MCP clients.
---

A personal access token lets Git, the `diffinery` CLI, scripts and MCP clients act as you. Tokens start with `dfy_`. You need one for anything outside the browser: passkeys only sign in to the web UI.

## What a token is

| Property | Value |
| --- | --- |
| Format | `dfy_` followed by 40 random characters (letters, digits, `-` and `_`) |
| Shown | Once, when you create it. Diffinery stores only a hash. |
| Prefix | The first 10 characters (for example `dfy_Ab12Cd`) are kept so you can recognize the token in lists and emails |
| Scopes | `read`, `write` or `admin` (default `write`) |
| Repository restriction | Optional list of repositories; default is every repository you can access |
| Lifetime | 1 to 366 days (default 90) |
| Last used | Recorded at most once an hour |

A token acts as your account with your current role. If your access changes (you leave an organization, a collaborator role is removed), the token's reach changes on the next request. If your account is disabled, all your tokens are revoked.

## Scopes

The scope caps the role a token can use on a repository. Your effective role through a token is the lower of your own role and this cap.

| Scope | Highest role | Typical use |
| --- | --- | --- |
| `read` | read | Clone and fetch, download Git LFS objects, read the API, CI that only downloads |
| `write` | maintain | Push, issues, pull requests, merging, running workflows; the right choice for most Git and CLI use |
| `admin` | admin | Everything you can do, including repository settings, collaborators, branch protection, secrets, webhooks, self-hosted runners and revoking tokens. No token can create tokens or agents |

The web form describes them as: "read: clone and view · write: push, issues, pull requests, runs (up to maintain) · admin: everything you can do, including settings."

### Read tokens never write

A `read` token only reads. Every request that changes something in a repository (any method other than `GET` or `HEAD`) is refused with `403 this token needs the write scope`, even actions the `read` role itself allows, such as opening an issue, commenting, reacting or leaving a comment-only review. Two Git operations use `POST` but only read, and keep working with a `read` token: `git fetch` and `git clone` (`git-upload-pack`) and Git LFS downloads (an LFS batch request for `download`). Pushing and LFS uploads need `write`.

The scope is checked after Diffinery has found a repository you can see, and before your role on it. So a `read` token that tries to change a private repository you can't see gets `404 repository not found`, the same answer as any other request for it, rather than a scope error that would reveal the repository exists. Use a `write` token for anything that opens, comments, pushes or merges, and an `admin` token for repository settings.

### Account-level actions

Actions that change your account or an organization, rather than a single repository, check the token's scope directly. Most of them also refuse tokens that are restricted to repositories, with `403 this token is limited to repositories and can't change account settings`. Browser sessions can do all of them.

| Action | Token needs | Restricted tokens |
| --- | --- | --- |
| Create a repository (`POST /api/v3/user/repos`, `POST /api/v3/orgs/{org}/repos`, `diffinery repo create`) | `write` or `admin` | Refused |
| Mark notifications read (`PUT /api/v3/notifications`), change notification settings, send yourself a test email | `write` or `admin` | Refused |
| Watch or unwatch a repository (`PUT`/`DELETE /api/v3/repos/{owner}/{repo}/subscription`) | `write` or `admin` | Allowed for the listed repositories |
| Upload or remove a profile picture (`/api/v3/user/avatar`, `/api/v3/orgs/{org}/avatar`) | `write` or `admin` | Refused |
| Change an organization's display name or base permission (`PATCH /api/v3/orgs/{org}`, owners only) | `admin` | Refused |
| Create a token (`POST /api/v3/diffinery/tokens`, `diffinery token create`) | No token can: a browser session only | Refused |
| Revoke a token (`DELETE /api/v3/diffinery/tokens/{id}`, `diffinery token revoke`) | `admin` | Refused |
| Create an organization (`POST /api/v3/user/orgs`) | `admin` | Refused |
| Invite people (`POST /api/v3/orgs/{org}/invitations`, `POST /api/v3/invitations`, `diffinery invite`) | `admin` | Refused |
| Accept or decline an invitation you received (`PATCH`/`DELETE /api/v3/user/repository_invitations/{id}`, `PATCH /api/v3/user/memberships/orgs/{org}`) | `write` or `admin` | Refused |
| List, set and delete organization secrets (`/api/v3/orgs/{org}/actions/secrets`, `diffinery secret ... --org`) | `admin` | Refused |
| Create an agent or a token for an agent (`POST /api/v3/diffinery/agents`, `POST /api/v3/diffinery/agents/{login}/tokens`, `diffinery agent create`) | No token can: a browser session only | Refused |
| Disable an agent (`DELETE /api/v3/diffinery/agents/{login}`) | `admin` | Refused |
| Send every email template (site administrators) | `admin` | Refused |
| Manage passkeys and browser sessions; change your username, display name or appearance | Not possible with a token; use the browser | |

A token whose scope is too low gets `403 this token needs the write scope` or `403 this token needs the admin scope`. Watching a repository with a `read` token gets `403 this needs a write or admin token`, and changing a profile picture with the wrong token gets `403 changing a profile picture needs a write or admin token that is not limited to repositories`.

See [Permissions](/docs/accounts/permissions) for what each role allows.

## Create a token

Creating a token needs a sign-in from the last 2 hours. If yours is older, Diffinery asks you to [Confirm it's you](/docs/security/overview#confirming-its-you) with your passkey first.

### In the web UI

1. Go to **Settings → Access tokens** (`/settings/tokens`).
2. Under **Create a token**, fill in:
   - **Name**: what the token is for, for example `laptop`, `ci` or `claude-code` (up to 80 characters).
   - **Expires in (days)**: 1 to 366. The default is 90.
   - **Scope**: **Read**, **Write** (default) or **Admin**.
   - **Restrict to repositories** (optional): pick one or more repositories. Leave it empty for every repository you can access.
3. Click **Create token**.

The page shows **Your new token** with a copy button. Copy it now: it is never shown again. Diffinery also emails you "A personal access token was added to your account".

Your first token has to be created in the web UI; after that you can create more from the CLI or API with an `admin` token.

### With the CLI

You don't need to create a token for the CLI itself: `diffinery login` signs it in through your browser and creates its own token (see [Install and sign in to the CLI](/docs/accounts/cli-sign-in)). Install it with:

```sh
curl -fsSL https://diffinery.com/install | bash
diffinery login
```

No token can create another token, so on a deployed instance `diffinery token create` gets `403 creating tokens needs a browser session: sign in at https://diffinery.com/settings/tokens`: create tokens in the web UI. The command works against a local development server (see [Deploy](/docs/self-hosting/deploy)):

```sh
# A write token for CI, valid for 30 days, only for acme/website
diffinery token create --name ci --scope write --expires-days 30 -R acme/website
```

| Option | Description |
| --- | --- |
| `-n, --name NAME` | Token name. Required. |
| `-s, --scope SCOPE` | `read`, `write` (default) or `admin`. Repeatable, or comma-separated. |
| `-e, --expires-days DAYS` | Days until it expires, 1 to 366 (default 90). |
| `-R, --repo OWNER/NAME` | Restrict the token to this repository. Repeatable. |
| `--json` | Print `token`, `id` and `expiresAt` as JSON. |

The token is printed on standard output (so you can pipe it), and the ID and expiry date on standard error.

### With the API

`POST /api/v3/diffinery/tokens`, from a browser session (the session cookie you get by signing in with a passkey). No token can create a token, whatever its scope, so a leaked or limited token can never turn itself into a wider or longer-lived one:

```sh
curl -X POST https://diffinery.com/api/v3/diffinery/tokens \
  -H "Cookie: __Host-dfy_session=..." \
  -H "Content-Type: application/json" \
  -d '{"name": "ci", "scopes": ["write"], "repositories": ["acme/website"], "expires_in_days": 30}'
```

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Token name |
| `scopes` | array of strings | One or more of `read`, `write`, `admin`. Omit it (or send `null`) for the default `["write"]`. An empty list, a value that isn't a list, or an unknown name returns `422 scopes must be a non-empty list of: read, write, admin`. Repeated names are stored once. |
| `repositories` | array of strings | `owner/name` of each repository to restrict to. Omit for every repository. You can only list repositories your account can see: a repository that doesn't exist, or a private one you have no access to, returns `422 unknown repository <name>` (the same message for both, so the answer doesn't reveal private repositories). |
| `expires_in_days` | number | 1 to 366 (values outside are clamped). Default 90. |

Response (`201 Created`):

```json
{ "token": "dfy_...", "id": "9b2f0c1d4e5a6b7c8d9e0f1a2b3c4d5e", "expiresAt": "2027-01-11T09:30:00.000Z" }
```

Any request authenticated with a token (personal, agent, job or sandbox) gets `403 creating tokens needs a browser session: sign in at https://diffinery.com/settings/tokens`. The CLI checks scope names before sending and exits with `unknown scope "<name>" (read, write or admin)`.

## Restrict a token to repositories

A restricted token only works on the repositories you picked. Any other repository answers `404 repository not found`, as if it didn't exist, even if you could normally read it. Inside the listed repositories the usual role and scope cap apply. Repository lists (`GET /api/v3/user/repos`, `/users/{login}/repos`, `/orgs/{org}/repos` and the MCP `list_repos` tool) show only the listed repositories, and reading notifications, which cover every repository, answers `403 this token is limited to repositories and can't read notifications`. Other account-level reads (such as `GET /api/v3/user` or listing your tokens) still work, but account-level changes don't: creating repositories or organizations, inviting people, managing agents, organization secrets, notification settings and profile pictures, and creating or revoking tokens all answer `403 this token is limited to repositories and can't change account settings` (profile pictures have their own message). See [Account-level actions](#account-level-actions).

Restrict tokens you hand to CI systems, agents and third-party tools to the repositories they need.

## List your tokens

The **Active tokens** table on **Settings → Access tokens** shows each token's **Name** and prefix, **Scopes**, **Repositories** (or "all"), **Expires** date and **Last used** time ("never" if it hasn't been used). Revoked tokens aren't listed.

```sh
diffinery token list
```

```sh
curl -H "Authorization: Bearer dfy_..." https://diffinery.com/api/v3/diffinery/tokens
```

The API returns an array of objects with `id`, `name`, `prefix`, `scopes`, `repoIds` (`null` when unrestricted), `expiresAt`, `lastUsedAt` and `createdAt`.

## Expiry and reminder emails

Every token expires; you can't create one that doesn't. After the expiry date, requests with it fail with `401 invalid, expired or revoked token`.

About a week before a token expires, Diffinery emails you "Your token "<name>" expires on <date>", with the token's prefix and a **Create a new token** button. The reminder is sent once per token, and only for tokens that were created to last more than 8 days. To replace a token, create a new one, swap it in wherever the old one is used (Git credentials, CI secrets, MCP client settings), then revoke the old one.

## Revoke a token

- **Web UI:** click **Revoke** next to the token on **Settings → Access tokens** and confirm. You see "Token revoked."
- **CLI:** `diffinery token revoke <id>` (the ID is in `diffinery token list`).
- **API:** `DELETE /api/v3/diffinery/tokens/{id}`, which returns `204`. Revoking through the API or CLI needs an `admin` token that isn't restricted to repositories.

A revoked token stops working immediately and can't be restored. Anything still using it gets `401 invalid, expired or revoked token`.

## Use a token

### Git over HTTPS

Use any username and the token as the password:

```sh
git clone https://diffinery.com/acme/website.git
# Username: diffy (anything works)
# Password: dfy_...
```

To avoid typing it, let the CLI answer Git's credential prompts for `diffinery.com`:

```sh
diffinery login           # paste the token once; saved in ~/.config/diffinery/config.json (mode 0600)
diffinery auth setup-git  # git uses the saved token for https://diffinery.com
```

`diffinery auth setup-git` configures `credential.https://diffinery.com.helper` in your global Git config. You can also use Git's own helpers, for example `git config --global credential.helper store`, or your operating system's keychain helper. See [Git](/docs/repositories/git).

### curl and other HTTP clients

Send the token as a bearer token:

```sh
curl -H "Authorization: Bearer dfy_..." https://diffinery.com/api/v3/user
```

Diffinery accepts these `Authorization` forms:

| Form | Example |
| --- | --- |
| Bearer | `Authorization: Bearer dfy_...` |
| Token (GitHub style) | `Authorization: token dfy_...` |
| Basic | `Authorization: Basic base64(username:dfy_...)`. The password is used; the username can be anything. If the password is empty, the username is used as the token. |

Git uses Basic authentication; the CLI, MCP clients and most scripts use Bearer. They are equivalent. A `Basic` value that isn't valid base64 is refused with `401 malformed basic credentials`.

If a request carries the `Authorization` header twice (Git LFS does this when you set `http.extraHeader` and it also sends its own header), Diffinery uses the first one.

### The CLI

`diffinery login` signs the CLI in through your browser and saves the server URL and the token it gets in `~/.config/diffinery/config.json` (or under `$XDG_CONFIG_HOME`). Those tokens are listed here with a **CLI sign-in** badge and named after the computer; see [Install and sign in to the CLI](/docs/accounts/cli-sign-in). `diffinery login --token dfy_...` saves a token you created instead. The environment variables `DIFFINERY_TOKEN` and `DIFFINERY_URL` override the saved values, which is handy in CI:

```sh
export DIFFINERY_TOKEN=dfy_...
diffinery whoami
```

`diffinery logout` removes the saved token, and revokes it when a CLI sign-in created it (a token you pasted may be in use elsewhere, so it's left alone). See [CLI reference](/docs/reference/cli).

### MCP clients

Point the client at `https://diffinery.com/mcp` with the token in an `Authorization` header. `diffinery mcp-config` prints a ready-made snippet:

```json
{ "mcpServers": { "diffinery": { "type": "http", "url": "https://diffinery.com/mcp", "headers": { "Authorization": "Bearer ${DIFFINERY_TOKEN}" } } } }
```

By default the snippet refers to `${DIFFINERY_TOKEN}` from the environment; `diffinery mcp-config --show-token` embeds the saved token instead. For an AI agent, create an agent account with its own token rather than giving it yours. See [MCP](/docs/agents/mcp) and [Agents](/docs/agents/overview).

## Agent tokens

Agents have their own `dfy_` tokens, created by their owner under **Settings → Agents** (default lifetime 30 days there), with `diffinery agent create`, or with `POST /api/v3/diffinery/agents/{login}/tokens`. Creating them through the API or CLI needs an `admin` token that isn't restricted to repositories; the `scopes` field follows the same rules as for personal tokens (default `["write"]`, `422` for an empty list or unknown name). They work like personal tokens but act as the agent, within its policy. Their creation and expiry emails go to the agent's owner (or, for an organization agent, the organization's owners and admins). See [Agents](/docs/agents/overview).

## Job tokens and sandbox tokens

Two other kinds of token exist. You don't create them yourself:

- **Job tokens** (`djt_`) are given to each workflow job as `GITHUB_TOKEN` and `DIFFINERY_TOKEN`. They act as `diffinery-actions[bot]` on the repository the job runs in, with what the workflow's `permissions:` grant, as on GitHub: each API endpoint needs its permission (`contents`, `issues`, `pull-requests`, `statuses`, `checks` and so on), and a request without it gets `403 Resource not accessible by integration`. Without `permissions:` a job gets the repository's default, which is read-only (`contents` and `packages` read) for new repositories; an admin changes it with the repository's workflow permissions setting (`PUT /api/v3/repos/{owner}/{repo}/actions/permissions/workflow`). A job token's role never goes above write, so branch protection applies to it, and it never changes repository settings, secrets, variables, webhooks, runners or branch protection, or creates or changes workflow files. A run whose code came from an agent acts as an agent, so it can't push or merge to the default or protected branches. The token also reads other public repositories (not other private ones), uses the container registry according to `permissions: packages`, and stops working when the job finishes. See [Workflow permissions](/docs/actions/workflow-permissions) and [Secrets and variables](/docs/actions/secrets-and-variables).
- **Sandbox tokens** (`dst_`) are given to each agent sandbox. They act as whoever started the sandbox, capped at write, on that repository, can also read other public repositories, and stop working when the sandbox closes. See [Sandboxes](/docs/agents/sandboxes).

Self-hosted runners have tokens of their own too. A repository admin creates a **registration token** (`drg_`, valid for an hour), and each runner trades it for a **runner token** (`drn_`) that can claim that repository's jobs and nothing else: it can't read the repository, push or call any other API. Removing the runner ends its token. See [Manage runners](/docs/actions/runners#manage-runners).

[Push protection](/docs/security/push-protection) blocks a push or commit that contains a job, sandbox or [agent task](/docs/agents/tasks) model token (`dmt_`), as it does for `dfy_` tokens, so one printed into a file or a commit message by a job or an agent isn't stored in the repository.

## Security emails about tokens

| Email | Sent to | When |
| --- | --- | --- |
| A personal access token was added to your account | You | Every time a token is created for you, from the web UI, the CLI or the API |
| A token was created for the agent <agent> | The agent's owner, or its organization's owners and admins | A token is created for an agent |
| Your token "<name>" expires on <date> | The same people | About 7 days before expiry (once per token, for tokens with a lifetime over 8 days) |

These can't be turned off. If you get one for a token you didn't create, revoke it right away.

## How tokens differ from GitHub

- Diffinery has one kind of personal token with three scopes, plus an optional repository list. GitHub has classic tokens with many scopes and fine-grained tokens with per-permission settings.
- Every token expires, after at most 366 days.
- Tokens can only be created with the API or CLI when you already hold an `admin`-scoped token that isn't restricted to repositories; the first one comes from the web UI.
- Git accepts a token as the password with any username, as on GitHub.

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| `401 invalid, expired or revoked token` | The token is unknown, expired or revoked, or your account is disabled or not yet active. Create a new token. |
| `401 unrecognised token; create one under Settings → Access tokens` | The credential doesn't start with `dfy_` (or `djt_`, `dst_`, `drn_`), for example a GitHub token or a password. Use a Diffinery token from **Settings → Access tokens**. |
| `401 authentication required` | No token was sent to a private repository. Configure Git credentials or add the `Authorization` header. |
| `404 repository not found` | You have no access, or the token is restricted to other repositories. A `read` token that tries to change a private repository it can't see also gets this. |
| `401 malformed basic credentials` | The `Authorization: Basic` value isn't valid base64. Encode `username:token` with base64, or send `Authorization: Bearer dfy_...` instead. |
| `422 unknown repository <name>` when creating a token | The repository doesn't exist, or it is private and your account can't see it. Check the `owner/name` spelling and your access. |
| `401 authentication required` on a public repository | You sent no token for a change (opening an issue, commenting, reacting, watching). Anonymous callers can only read. Send a `write` token. |
| `403 write access required` (or another role) | Your role, or the token's scope, is too low. For `admin` actions, use an `admin` token. |
| `403 this token needs the write scope` | A `read` token tried to change something. Use a `write` or `admin` token. |
| `403 this token needs the admin scope` | Account-level actions such as inviting, creating organizations or agents, organization secrets, and creating or revoking tokens need an `admin` token. |
| `403 this token is limited to repositories and can't change account settings` | The token has a repository list. Use a token without one, or the web UI. |
| `422 scopes must be a non-empty list of: read, write, admin` | The `scopes` field was empty, not a list, or had an unknown name. |
| `403 creating tokens needs a browser session: sign in at https://diffinery.com/settings/tokens` | Tokens can't create tokens. Create it in the web UI. |
| `403 this needs a write or admin token` | Watching or unwatching a repository needs a `write` or `admin` token. |
| `403 changing a profile picture needs a write or admin token that is not limited to repositories` | Use a `write` or `admin` token without a repository restriction, or the web UI. |
| The CLI adds "token invalid or expired; run `diffinery login`" | Run `diffinery login` with a new token. If `DIFFINERY_TOKEN` is set, it overrides the saved token. |
| Git keeps asking for a password | Your credential helper has an old token. Run `diffinery auth setup-git`, or update the stored credential. |
