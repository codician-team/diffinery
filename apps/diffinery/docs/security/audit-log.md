---
title: Audit log
description: What Diffinery records in its audit log, the fields of each entry, who can view it, and which entries also send security emails.
---

The audit log is an append-only record of security-relevant actions on a Diffinery instance: sign-ins, passkey and token changes, profile pictures, repository and environment settings (from the web UI and the API alike), pushes, merges, admin merges that bypass branch protection, push protection decisions, package changes, imports from GitHub, linked GitHub accounts, and moderation (reports, blocks, suspensions and hidden comments). Site administrators use it to answer "who did what, when, and on whose behalf".

## Viewing the audit log

The audit log is available to **site administrators** only.

1. Sign in with your passkey.
2. Open **Settings** at `https://diffinery.com/settings`.
3. In the sidebar, under the **Site administration** heading (shown only to site admins), select **Audit log**. It comes after **People and invitations** and **Email**. The page is at `https://diffinery.com/settings/audit`.

The page shows the 200 most recent entries, newest first, in a table with these columns:

| Column | Content |
|---|---|
| **When** | The time of the action |
| **Actor** | The login of the account that acted, followed by `for <owner>` when an agent acted on behalf of a person or organization. Shows `system` when no account is attached. |
| **Action** | The action name, such as `git.push` |
| **Target** | What the action applied to, such as `acme/website` or `acme/website:refs/heads/main` |
| **Detail** | Extra data as JSON (hover to see it all) |

There is no filtering, search or paging on the page, and organization owners and repository admins cannot open it. There is no REST API endpoint, MCP tool or CLI command for reading the audit log on this version.

## How long entries are kept

Entries are kept for 2 years (730 days). Older ones are deleted every hour. An account deletion doesn't remove the deleted account's entries; they go when they reach 2 years like the rest.

## Entry fields

Each entry is stored with these fields:

| Field | Description |
|---|---|
| `id` | A unique id for the entry |
| `at` | ISO 8601 timestamp of the action |
| `actor_id` | Id of the account that acted (empty for some system actions) |
| `actor_login` | Login of that account at the time |
| `on_behalf_of` | For agents: the login of the person or organization that owns the agent |
| `action` | The action name (see below) |
| `target` | What the action applied to; format depends on the action |
| `detail` | JSON with action-specific data, or empty |

Entries are only ever added. Diffinery has no feature to edit or delete them.

## Recorded actions

### Sign-in and account security

| Action | Recorded when | Target | Detail |
|---|---|---|---|
| `session.create` | Someone signs in with a passkey, or through the email recovery path | none | `method` (`passkey` or `access`), `device`, `ip`, `location`, and for passkeys `passkey` (name) and `passkeyId` |
| `passkey.add` | A passkey is added from **Passkeys and sessions**, or through a one-time sign-in link | none | `name`, `passkeyId`, `device`, `ip`, `location`; `via: "signin-link"` when added through a link |
| `passkey.remove` | A passkey is removed | none | `name` |
| `session.revoke` | You sign out one of your other browsers with **Sign out** on **Passkeys and sessions** | none | none |
| `account.auto_merge` | You turn **Turn on auto-merge for pull requests I open** on or off, on **Settings → Pull requests**, the repository's **Merge on green** page, `diffinery setup` or `PUT /api/v3/diffinery/auto-merge` (see [Merge on green automatically](/docs/collaboration/merge-on-green#your-own-pull-requests)) | your login | `merge_method` (`null` when off) |
| `session.revoke_others` | Recovering an account signs out its other browsers: through email recovery at `/auth/access` from a browser that wasn't signed in to the account, or with a one-time sign-in link (see [Recover your account](/docs/accounts/passkeys-and-sign-in#recover-your-account)) | none | `via` (`access` or `signin-link`), `sessions` (how many were signed out) |
| `signup` | Someone creates an account and passkey through open sign-up (`SIGNUP=open`), after confirming their email with a code | none | `method` (`passkey`), `email`, `passkeyId`, `device`, `ip`, `location` |
| `invite.accept` | Someone creates an account and passkey from an invite link, or an existing user accepts an invite (from its link, **Settings → Invitations**, the **Waiting for an invite** page or the API) | for an existing user who opened the link, the path the invite led to (such as `/acme/website`) | for a new account: `method` (`passkey`), `passkeyId`, `device`, `ip`, `location`; from **Settings → Invitations** or the API: `id` (the invitation id), and `via: "api"` for the API |
| `invite.decline` | Someone declines an invitation on **Settings → Invitations**, the **Waiting for an invite** page, or with `DELETE /api/v3/user/repository_invitations/{id}` | none | `id` (the invitation id), and `via: "api"` for the API |
| `token.create` | A personal access token is created on **Access tokens** or with `POST /api/v3/diffinery/tokens` | your login (web) | `name` and `scope`/`scopes`, and for the web the number of repositories it is restricted to |
| `token.revoke` | A token is revoked on **Access tokens** or with `DELETE /api/v3/diffinery/tokens/{id}` | the token id | `via: "api"` for the API |
| `signin_link.create` | A site admin creates a one-time sign-in link for someone | that user's login | none |
| `user.active`, `user.pending`, `user.disabled` | A site admin changes a user's status | that user's login | none |
| `site_admin.grant`, `site_admin.revoke` | A site administrator makes someone a site administrator, or removes them, with **Make admin** or **Remove admin** in **Site administration** | that user's login | none |
| `account.delete` | Someone deletes their account on **Settings → Account**, or a site administrator deletes it (see [Exporting and deleting your account](/docs/accounts/account-data)) | the deleted account's login | `via` (`settings` or `admin`), `repositories` and `packages` (how many were deleted), `agents` (the logins of the agents deleted with it) |
| `account.export` | Someone asks for an export of their account on **Settings → Account** | none | `id` (the export's id) |
| `account.export_download` | Someone downloads their account export | none | `id`, `size` (in bytes) |
| `user.suspend` | A site administrator [suspends](/docs/admin/site-administration#suspend-an-account) a person, from the **Users** table, a report, or `PUT /api/v3/users/{username}/suspended` | that person's login | `reason`, `via` (`web` or `api`), `stopped` (runs, jobs and sandboxes stopped in their repositories) |
| `user.unsuspend` | A site administrator lifts a suspension (**Unsuspend**, or `DELETE /api/v3/users/{username}/suspended`) | that person's login | `via` |
| `account.link_github` | You link a GitHub account on **Settings → Linked accounts** (gist code or GitHub sign-in) or with `POST /api/v3/diffinery/user/linked-accounts/github` | `<host>/<GitHub login>`, such as `github.com/diffy` | none |
| `account.unlink_github` | You unlink a GitHub account (**Unlink**, or `DELETE /api/v3/diffinery/user/linked-accounts/{id}`) | the link's id | none |
| `account.link_cleared` | A site admin clears someone's GitHub link with `DELETE /api/v3/diffinery/admin/linked-accounts/{id}` | `<host>/<GitHub login>` | `account` (the id of the Diffinery account the link belonged to) |
| `avatar.update`, `avatar.remove` | A profile picture is uploaded or removed, for yourself or for an organization you administer (web UI, `PUT`/`DELETE /api/v3/user/avatar` or `PUT`/`DELETE /api/v3/orgs/{org}/avatar`) | the login of the person or organization | `kind` (`user` or `org`) and `via` (`web` or `api`) |

### Agents

| Action | Recorded when | Target | Detail |
|---|---|---|---|
| `agent.create` | An agent account is created (web or `POST /api/v3/diffinery/agents`) | the agent's login | `maxRole` and `auto_merge` (web) |
| `agent.auto_merge` | **Merge its pull requests on green** is turned on or off for an agent, on **Settings → Agents**, **Agent setup** or with `PUT /api/v3/diffinery/agents/{login}/auto-merge` | the agent's login (the repository on Agent setup, with `agent`) | `merge_method` (`null` when off) |
| `agent.token.create` | A token is created for an agent, from the web UI or with `POST /api/v3/diffinery/agents/{login}/tokens` | the agent's login | `scope` (web) or `scopes` (API) |
| `agent.enable`, `agent.disable` | An agent is enabled or disabled from the web UI; `agent.disable` also for `DELETE /api/v3/diffinery/agents/{login}` | the agent's login | none |

### Agent tasks and model keys

| Action | Recorded when | Target | Detail |
|---|---|---|---|
| `task.start` | Someone starts an [agent task](/docs/agents/tasks) | `owner/repo#<task number>` | `agent`, `runtime`; `provider` and `model` when it goes through OpenRouter; `plan_first` when it plans first; `attempts` when it runs more than one; `fix_checks` and `land` |
| `task.message`, `task.retry` | The person who started a task sends a follow-up or retries it | `owner/repo#<task number>` | none |
| `task.plan_approve` | The person who started a [plan-first](/docs/agents/tasks#plan-first) task approves its plan | `owner/repo#<task number>` | none |
| `task.options` | The person who started a task changes **Fix failing checks** or **Land when approved** | `owner/repo#<task number>` | `fix_checks`, `land` |
| `task.pick` | The person who started a task with [attempts](/docs/agents/tasks#best-of-n) picks one | `owner/repo#<task number>` | `attempt` |
| `task.plan_split` | The person who started a plan-first task hands its plan to their coordinator to split | `owner/repo#<task number>` | `post`, `coordinator_task` |
| `task.stop` | Someone stops a task (its starter, its agent or a repository admin) | `owner/repo#<task number>` | none |
| `terminal.terms` | Someone accepts the notice for [terminals](/docs/agents/terminal) | `owner/repo` | `version` |
| `terminal.open` | Someone opens a [terminal](/docs/agents/terminal) | `owner/repo` | `terminal`, `agent`, `ref`, `tasks` (whether it was opened to run agent tasks), `runtimes` (the Claude Code and Codex versions its buttons install) |
| `terminal.task` | Someone runs a task in their [terminal](/docs/agents/terminal#give-it-a-task) | `owner/repo` | `terminal`, `task`, `runtime`, `version` (the pinned version of the CLI) |
| `terminal.end` | A terminal ends | `owner/repo` | `terminal`, `reason` (`person`, `idle`, `limit`, `access`, `stopped`, `failed`, `disabled` or `suspended`) |
| `project.memory` | Someone saves or restores the [project](/docs/agents/projects) memory | `owner/repo` | `version`, `length`, and `restored` (the version restored) for a restore |
| `project.settings` | A repository admin changes **Settings → Project** | `owner/repo` | `max_running`, `instructions_length`, `plan_first` |
| `project.coordinator` | Someone turns their [coordinator](/docs/agents/projects#coordinator) on, changes it or turns it off | `owner/repo` | `enabled`, and when on `agent`, `runtime`, `provider` and `model` (OpenRouter), `tokens_per_run`, `tokens_per_task` |
| `project.coordinate` | Someone's coordinator is given a post to handle | `owner/repo` | `post`, `task`, `agent`, `runtime` |
| `review.settings` | A repository admin turns [agent review](/docs/agents/review) on or off, or changes its settings | `owner/repo` | `enabled`, `agent`, `runtime`, `trigger`, `autofix`, `daily_limit` |
| `review.request` | A person asks for an agent review with **Request agent review** or `POST /repos/{owner}/{repo}/pulls/{number}/diffinery/agent-review` | `owner/repo#<pull request number>` | none |
| `model_key.set`, `model_key.delete` | You save, replace or delete a model API key under **Settings → Model access** (or `PUT`/`DELETE /api/v3/diffinery/model-keys/{provider}`) | the provider (`anthropic`, `openai` or `openrouter`) | `hint` (the key's last four characters) and `opted_in_at` (when you accepted the provider's terms) for `model_key.set` |

### Organizations and invitations

| Action | Recorded when | Target | Detail |
|---|---|---|---|
| `org.create` | An organization is created from the web UI | the organization's login | none |
| `org.update` | An organization's settings are changed on its **Settings** tab, or with `PATCH /api/v3/orgs/{org}` | the organization's login | `login` and `base_role` (web UI), or `name` and `base_role` (API) |
| `org.delete` | An organization is deleted (web or `DELETE /api/v3/orgs/{org}`) | the organization's login | none |
| `org.secret.set`, `org.secret.delete` | An organization secret is saved or deleted with `PUT`/`DELETE /api/v3/orgs/{org}/actions/secrets/{name}` (or `diffinery secret ... --org`) | the organization's login | `name` (never the value), and for `set` its `visibility` and any selected `repositories`; `via: "api"` |
| `org.secret.repositories`, `org.secret.repository.add`, `org.secret.repository.remove` | An organization secret's repository selection is replaced, or one repository is added or removed | the organization's login | `name`, and `repositories` or `repository`; `via: "api"` |
| `org.variable_set`, `org.variable_delete` | An organization Actions variable is created, changed or deleted with `POST`, `PATCH` or `DELETE /api/v3/orgs/{org}/actions/variables[/{name}]`, or added by a GitHub import of an organization | the organization's login (API), or the GitHub organization (import) | `name` (upper-cased); `via: "api"` for API changes; an import adds `import` (its id) and `org` |
| `org.invite` | Someone is invited to an organization: an email address or a username entered in **Add people** on the organization's **People** tab, or `POST /api/v3/orgs/{org}/invitations` | the organization's login | `email` or `user`, and `role` |
| `org.invite.revoke` | A pending organization invitation is revoked with **Revoke** | the organization's login | `id` (the invitation id) |
| `org.member.set`, `org.member.remove` | A site administrator adds themselves with **Add people**, a member's role is changed, or a member is removed | the organization's login | `user`, `role` |
| `invite.create` | A site admin creates an invite from **Site administration** | the email address | none |
| `site.invite` | A site admin invites someone with `POST /api/v3/invitations` | none | `email` |
| `account.quotas.set` | A site administrator changes an account's quotas with `PATCH /api/v3/admin/accounts/{login}/quotas` | the account's login | the quotas sent, e.g. `hosted_minutes` |
| `actions.suspend` | A site administrator suspends Actions for a repository or an account ([kill switches](/docs/admin/site-administration#kill-switches)), on **Settings → Kill switches** or with `PUT /api/v3/admin/repos/{owner}/{repo}/actions-suspension` or `PUT /api/v3/admin/accounts/{login}/actions-suspension` | `owner/name`, or the account's login | `kind` (`repo` or `account`), `reason`, `via` (`web` or `api`), `stopped` (runs, jobs and sandboxes stopped) |
| `actions.unsuspend` | A site administrator lifts that suspension (**Lift**, or `DELETE` on the same path) | `owner/name`, or the account's login | `kind`, `via` |
| `compute.pause` | A site administrator pauses hosted compute on the instance (**Pause hosted compute**, or `PUT /api/v3/admin/hosted-compute-pause`) | none | `reason`, `via`, `stopped` |
| `org.block`, `org.unblock` | An organization owner [blocks](/docs/accounts/blocking-and-reporting) or unblocks a person for the organization (its **Settings** tab, or `PUT`/`DELETE /api/v3/orgs/{org}/blocks/{username}`) | the organization's login | `user`, `via` |
| `compute.unpause` | A site administrator resumes it (**Resume hosted compute**, or `DELETE /api/v3/admin/hosted-compute-pause`) | none | `via` |
| `email.suppression.add` | An address goes on the email suppression list: a permanent bounce or a spam complaint arrives, or Email Sending refuses to send to it for good (no actor, shown as `system`), or a site administrator adds it (**Suppress an address** on **Settings → Email**, or `PUT /api/v3/diffinery/admin/email/suppressions/{email}`). See [the suppression list](/docs/admin/site-administration#bounces-complaints-and-the-suppression-list). | the email address | `reason` (`hard-bounce`, `complaint` or `manual`), `source` (`cloudflare`, `webhook`, `send` or `admin`), `detail` (the provider's words or the administrator's note) |
| `email.suppression.remove` | A site administrator removes an address from the list (**Remove**, or `DELETE /api/v3/diffinery/admin/email/suppressions/{email}`) | the email address | `reason` and `source` of the entry removed |
| `email.suppression.lift` | Someone lifts a bounce or complaint on their own address by following the verification link from **Settings → Email** | the email address | `reason` of the entry lifted |
| `security_report.create` | Someone sends a private [security report](/docs/admin/site-administration#security-reports) through `/security/report`. The actor is the reporter when signed in, otherwise `system`. Nothing of the report's content is recorded. | the report's id | `signed_in` |
| `security_report.triage`, `security_report.resolve`, `security_report.reopen` | A site administrator marks a security report triaged or resolved, or new again (**Save** on the report's page, or `PATCH /api/v3/diffinery/admin/security-reports/{id}`) | the report's id | `from` and `to` (the states), `note`, `via` (`web` or `api`) |
| `early_access.confirm` | An address confirms its [early access](/docs/accounts/early-access) request with the emailed link (the actor is `system`) | the request's id | none |
| `early_access.invite` | A site administrator invites an early access request (**Invite** on **Settings → Early access**, or `POST /api/v3/diffinery/admin/early-access/{id}/invite`) | the request's id | `invite` (the invitation id), `from` (the state it was in), `existing_invitation` when a pending invitation was kept, `via` (`web` or `api`) |
| `early_access.decline`, `early_access.restore` | A site administrator declines a request, or puts a declined one back (**Decline** or **Put back**, or `PATCH /api/v3/diffinery/admin/early-access/{id}`) | the request's id | `from` or `to` (the states), `via` |
| `contact.create`, `contact.confirm` | Someone sends a message through the [contact form](/docs/admin/contact-form) (the actor is the sender when signed in, otherwise `system`), or confirms one with the emailed link (`system`) | the message's id | `signed_in` on `contact.create`; none on `contact.confirm` |
| `contact.handle`, `contact.spam`, `contact.reopen` | A site administrator marks a contact message handled or spam, or reopens it (**Mark handled**, **Spam** or **Reopen** on **Settings → Contact messages**, or `PATCH /api/v3/diffinery/admin/contact/{id}`) | the message's id | `from` and `to` (the states), `via` (`web` or `api`) |
| `contact.note`, `contact.delete` | A site administrator changes a message's note, or deletes it (**Delete message**, or `DELETE /api/v3/diffinery/admin/contact/{id}`). Neither the note, the address nor the message is recorded. | the message's id | `via`; `state` on `contact.delete` |
| `early_access.delete` | A site administrator deletes a request (**Delete request**, or `DELETE /api/v3/diffinery/admin/early-access/{id}`), or someone removes their own with an emailed link (the actor is `system`). Neither the address nor the request's content is recorded. | the request's id | `state`, `via` (`web`, `api` or `self`) |
| `status_incident.create` | A site administrator opens an incident on the [status page](/docs/self-hosting/status-page) (**Open the incident** on **Settings → Status**, or `POST /api/v3/diffinery/admin/status/incidents`) | the incident's id | `title`, `impact`, `components`, `state`, `via` (`web` or `api`); not the update's text |
| `status_incident.update`, `status_incident.resolve` | A site administrator posts an update to an incident (**Post the update**, or `POST /api/v3/diffinery/admin/status/incidents/{id}/updates`); `resolve` when it resolves the incident | the incident's id | `from` and `to` (the states), `via` |

### Moderation

| Action | Recorded when | Target | Detail |
|---|---|---|---|
| `user.block`, `user.unblock` | Someone [blocks](/docs/accounts/blocking-and-reporting) or unblocks a person (a profile's **…** menu, **Settings → Blocked users**, or `PUT`/`DELETE /api/v3/user/blocks/{username}`) | the person blocked | `via` |
| `report.create` | Someone reports content to the site administrators (**Report**, or `POST /api/v3/diffinery/reports`) | what was reported: a login, `owner/name`, `owner/name#12`, or `owner/name#12 comment <id>` | `id` (the report's), `kind`, `reason`, `via` |
| `report.resolve`, `report.reopen` | A site administrator resolves a report with a note, or reopens it (**Settings → Reports**, or `PATCH /api/v3/admin/reports/{id}`) | as for `report.create` | `id`, `resolution` (for `resolve`), `via` |
| `comment.minimize`, `comment.unminimize` | Someone with write access [hides a comment](/docs/collaboration/issues#hide-a-comment) or shows it again | `owner/name` | `comment` (its id), `number` (the issue or pull request), `reason` (for `minimize`), `via` |

Suspensions and organization blocks are listed under [Organizations and invitations](#organizations-and-invitations) and [Sign-in and account security](#sign-in-and-account-security).

### Repositories

All repository entries use the repository (`acme/website`) as the target. Settings changes are recorded the same way whether they are made on the web settings pages or through the REST API (and the CLI, which uses it). Entries written for an API call add `via: "api"` to the detail.

| Action | Recorded when | Detail |
|---|---|---|
| `repo.create` | A repository is created from the web UI | none (target `acme/website`) |
| `repo.update` | **General** settings are saved, or `PATCH /api/v3/repos/{owner}/{repo}` changes the name, description, visibility or default branch | Web: `name`, `visibility`, `defaultBranch`. API: the fields that were sent (`name`, `description`, `visibility`, `default_branch`) |
| `repo.archive`, `repo.unarchive` | The repository is archived or unarchived, on **General** or with `PATCH /api/v3/repos/{owner}/{repo}` and `{"archived": true}` (or `false`) | none |
| `repo.delete` | The repository is deleted (web or `DELETE /api/v3/repos/{owner}/{repo}`) | none |
| `repo.purge_unreachable` | Unreachable objects are purged (**Settings → Danger zone**, or `POST /api/v3/repos/{owner}/{repo}/diffinery/purge-unreachable`) | `objects`, `bytes` |
| `repo.delete_closed_pulls` | Every closed pull request is deleted and unreachable objects are purged (**Settings → Danger zone → Delete closed pull requests**, or `POST /api/v3/repos/{owner}/{repo}/diffinery/delete-closed-pulls`) | `pull_requests`, `objects`, `bytes` |
| `repo.transfer` | The repository is transferred to another owner (web or `POST /api/v3/repos/{owner}/{repo}/transfer`); the target is the new name | `from`, `to` |
| `repo.collaborator.set`, `repo.collaborator.remove` | On **Collaborators**: an account gets a role at once with **Add people** (an agent, an existing collaborator, a member of the owning organization, or yourself), a collaborator's role is changed, or a collaborator is removed. Through the API: `PUT` (when the role applied at once) or `DELETE /api/v3/repos/{owner}/{repo}/collaborators/{username}` | `login`, `role` |
| `repo.invite` | **Add people** or `PUT /api/v3/repos/{owner}/{repo}/collaborators/{username}` sends an invitation, to an email address or a username | `email` or `login`, and `role` |
| `repo.topics` | The topics are replaced with `PUT /api/v3/repos/{owner}/{repo}/topics` | `names` |
| `repo.protection.set`, `repo.protection.delete` | A branch protection rule is saved or deleted on **Branch protection**, or with `PUT`/`DELETE /api/v3/repos/{owner}/{repo}/branches/{branch}/protection` | `pattern`, and on the web `rules` when saved |
| `repo.protection.agent_auto_merge` | **Allow agents to land pull requests through auto-merge** (`allowAgentAutoMerge`) is turned on or off for a rule, from the web UI or the API | `pattern`, `enabled`, `requiredChecks` |
| `repo.protection.agent_approval_waiver` | **Let agents' auto-merges land without an approving review** (`agentAutoMergeWithoutApproval`) is turned on or off for a rule, from the web UI or the API | `pattern`, `enabled`, `requiredChecks` |
| `repo.merge_on_green` | Merge on green is turned on, changed or turned off on the repository's **Settings → Merge on green** page (the rule changes are recorded by the `repo.protection.*` entries too) | `branch`, `enabled`, and when on `checks`, `agents`, `withoutApproval`, `method` |
| `repo.protection.agent_auto_merge_rule` | **Auto-merge pull requests from these agents** (`autoMergeAgents`) or their merge method changes for a rule, from the web UI or the API (see [Auto-merging agents' pull requests](/docs/repositories/branch-protection#auto-merging-agents-pull-requests)) | `pattern`, `enabled`, `agents`, `method`, `withoutApproval`, `requiredChecks` |
| `repo.secret.set`, `repo.secret.delete` | An Actions secret is saved or deleted on **Secrets and variables**, or with `PUT`/`DELETE /api/v3/repos/{owner}/{repo}/actions/secrets/{name}` | `name` (never the value) |
| `repo.variable.set`, `repo.variable.delete` | An Actions variable is saved or deleted on **Secrets and variables**, or created, updated, renamed or deleted through `/api/v3/repos/{owner}/{repo}/actions/variables` | `name`, and `renamed_from` when a `PATCH` renamed it |
| `repo.actions.logs.delete` | A workflow run's logs are deleted with `DELETE /api/v3/repos/{owner}/{repo}/actions/runs/{run_id}/logs` | `run`, the run's ID, and `jobs`, how many jobs' logs were deleted |
| `repo.webhook.create`, `repo.webhook.delete` | A webhook is added or deleted on **Webhooks**, or with `POST /api/v3/repos/{owner}/{repo}/hooks` or `DELETE /api/v3/repos/{owner}/{repo}/hooks/{id}` | Web: `url` and `events`, or `id`. API: `id` and `url`, or `id` |
| `repo.actions_workflow_settings` | An admin changes the repository's workflow permissions on the **Actions** settings tab or with `PUT /api/v3/repos/{owner}/{repo}/actions/permissions/workflow` (see [Workflow permissions](/docs/actions/workflow-permissions)) | the new settings: `defaultPermissions` (`read` or `write`), `canApprovePullRequests` and `agentRunSecrets`, plus `via: "api"` when the change came through the API |
| `actions.cache.delete` | Actions caches are deleted with `DELETE /api/v3/repos/{owner}/{repo}/actions/caches?key=...` or `DELETE /api/v3/repos/{owner}/{repo}/actions/caches/{id}` | `key`, `ids`, `via: "api"` |
| `actions.artifact.delete` | A workflow artifact is deleted with `DELETE /api/v3/repos/{owner}/{repo}/actions/artifacts/{id}` | `id`, `name`, `via: "api"` |
| `runner.registration_token` | A repository admin creates a self-hosted runner registration token with `POST /api/v3/repos/{owner}/{repo}/actions/runners/registration-token` | none |
| `runner.register` | A self-hosted runner registers with a registration token; the actor is the admin who created that token | `id`, `name`, `labels`, `ephemeral` |
| `runner.remove` | A self-hosted runner is removed with `DELETE /api/v3/repos/{owner}/{repo}/actions/runners/{id}` | `id` |

### Environments

Changes to [environments](/docs/actions/environments) are made through the REST API by repository admins who are people (agents are refused). Each entry has the repository (`acme/website`) as the target and names the environment in `environment`.

| Action | Recorded when | Detail |
|---|---|---|
| `environment.update` | An environment is created or updated with `PUT /api/v3/repos/{owner}/{repo}/environments/{name}` | `environment`, `deployment_branch_policy` (as sent, or `null`); `reviewers` (logins), `wait_timer` and `prevent_self_review` when they were sent |
| `environment.delete` | An environment is deleted | `environment` |
| `environment.branch_policy.create` | A deployment branch or tag pattern is added | `environment`, `pattern`, `type` (`branch` or `tag`) |
| `environment.branch_policy.delete` | A deployment branch or tag pattern is removed | `environment`, `id` |
| `environment.secret.set`, `environment.secret.delete` | An environment secret is saved or deleted | `environment`, `name` (never the value) |
| `environment.variable.set`, `environment.variable.delete` | An environment variable is created, updated, renamed or deleted | `environment`, `name`, and `renamed_from` when a `PATCH` renamed it |
| `deployment.approve`, `deployment.reject` | A required reviewer approves or rejects a run's waiting deployments, on the run page or with `POST .../actions/runs/{run_id}/pending_deployments`. The actor is the reviewer. | `run`, `environments` (the environments decided), `comment` |

### Git and pull requests

| Action | Recorded when | Target | Detail |
|---|---|---|---|
| `git.push` | A branch or tag moves forward or is created, by any means: `git push`, the web editor, the API, MCP, a merge or the merge queue | `acme/website:refs/heads/main` | `before`, `after` (commit ids) |
| `git.force_push` | A ref moves to a commit that does not contain the old one | as above | `before`, `after` |
| `git.delete_ref` | A branch or tag is deleted | as above | `before`, `after` |
| `pull.merge` | A pull request is merged, directly, by the merge queue or by auto-merge | `acme/website#42` | none |
| `pull_request.merge_bypassed` | A repository admin merges a pull request past branch rules by asking for a bypass: with `"bypass_rules": true` (or **Merge without waiting for requirements (bypass)** in the web UI) past unmet blockers or a linear-history rule (a merge commit), or with `"bypass_merge_queue": true` (or **Merge now (bypass the queue)**) past a required merge queue. `diffinery pr merge --admin` sends both. A `pull.merge` entry follows. | `acme/website#42` | `blockers` (what was bypassed: the unmet blockers, such as `needs 1 more approving review(s)`, plus `linear history required` or `merge queue` when those were bypassed), `base` (the base branch) |
| `pull_request.auto_merge_enabled` | Someone turns on [auto-merge](/docs/collaboration/pull-requests#auto-merge) for a pull request, or changes its method (web UI, `PUT /api/v3/repos/{owner}/{repo}/pulls/{number}/auto-merge` or the `enable_auto_merge` MCP tool) | `acme/website#42` | `base`, `method`, `viaAgentRule` (`true` when an agent or workflow token relies on `allowAgentAutoMerge`); `byRule` and `agent` when a branch rule's `autoMergeAgents` turned it on, recorded as `diffinery-auto-merge[bot]`; `byDefault: true` when the author's own setting turned it on as the pull request opened |
| `pull_request.auto_merge_disabled` | Auto-merge is turned off: by someone (**Disable auto-merge**, `DELETE .../auto-merge` or `disable_auto_merge`), by a push from someone else, by converting the pull request to a draft, or by itself when it can't go through. The actor is who turned it off, the pusher, or `diffinery-auto-merge[bot]`. | `acme/website#42` | `enabledBy` (login), and `reason` when it turned itself off |
| `pull_request.auto_merged` | Auto-merge merges the pull request, as the account that turned it on. A `pull.merge` entry is written too. | `acme/website#42` | `base`, `method`, `sha` |
| `pull_request.auto_merge_enqueued` | Auto-merge adds the pull request to the base branch's merge queue | `acme/website#42` | `base`, `state` |
| `push.blocked_secret` | [Push protection](/docs/security/push-protection) blocks a push | `acme/website` | `kinds` (credential types found), `refs` |
| `push.secret_bypassed` | A repository admin pushes past push protection with `git push -o allow-secrets=<reason>`, or a GitHub import imports old history with an audited bypass (see [Imported history](/docs/security/push-protection#imported-history)) | `acme/website` | `kinds`, `reason`, `refs`; for an import also `import` (its id) and `blobs` (up to 50 blob ids), and the reason is `Imported from GitHub <owner>/<name>` |
| `api.blocked_secret` | [Push protection](/docs/security/push-protection#commits-and-writes-without-git) refuses a commit made with the web editor, `POST /repos/{owner}/{repo}/diffinery/commits`, the contents API or the MCP `commit_files` tool, or a file written with the git data API. The actor is the person or agent who made the request. | `acme/website` | `kinds`, and `paths` (up to 10), or `blob` for the git data API |
| `api.secret_bypassed` | A repository admin who is a person commits past push protection with `allow_secrets` on `POST /repos/{owner}/{repo}/diffinery/commits` | `acme/website` | `kinds`, `paths`, `reason` |
| `push.secret_marked` | A push lets through a file that opts out of push protection with `diffinery:allow-secret` and holds something that looks like a credential (see [Opting a file out](/docs/security/push-protection#opting-a-file-out)) | `acme/website` | `kinds`, `blobs` (up to 50 blob ids), `refs` |
| `api.secret_marked` | The same, for a commit made without Git or a blob written with the git data API | `acme/website` | `kinds`, and `paths` (up to 10), or `blob` for the git data API |

### GitHub imports

[Imports from GitHub](/docs/migrate-from-github) are recorded with the person or agent who started the import as the actor. Apart from `import.push` and the push protection entries, they don't fill in `on_behalf_of` for an agent. Entries written by the import service have the GitHub source (`diffy/hello-world`, or `diffy` for an organization import) as the target and the import's id as `import` in the detail.

| Action | Recorded when | Target | Detail |
|---|---|---|---|
| `import.create` | An import is started (web form, `POST /api/v3/diffinery/imports`, `diffinery migrate github`, MCP `start_github_import`), or a draft organization import starts after its repositories are chosen | the GitHub source | `import`, `kind` (`repo` or `bulk`), `owner` (the Diffinery account imported into), and `name` and `options`, or `repositories` (how many were chosen) |
| `import.push` | The import's Git transfer pushes history into the new repository. Replaces the `git.push` entries such pushes would otherwise write. | `acme/website` | `import`, `refs` (how many refs the push created or moved) |
| `import.cancel` | Someone cancels the import (**Cancel import**, or `POST /api/v3/diffinery/imports/{id}/cancel`) | the GitHub source | `import`, `by` (who cancelled it) |
| `import.retry` | Whoever started it retries a failed or cancelled import | the GitHub source | `import`, `by`, `attempt` |
| `import.fail` | An import fails after its retries | the GitHub source | `import`, `error` |
| `import.finish` | An import finishes. An organization import with repositories that weren't imported is recorded as `import.finish` too, and its status is `failed`. | the GitHub source | `import`, and `repo`, `counts` (issues, pull requests, comments, reviews, labels, milestones) and `findings` (how many push protection findings were bypassed), or `children` (counts of the organization import's repositories) |

Old history imported past push protection writes `push.secret_bypassed`, and a push blocked during an import writes `push.blocked_secret` (see [Git and pull requests](#git-and-pull-requests)). Organization variables an import adds write `org.variable_set`. Nothing an import writes into the repository (issues, comments, reviews, labels, milestones, releases, branch protection, variables) writes other entries.

### Container packages

| Action | Recorded when | Target | Detail |
|---|---|---|---|
| `package.create` | The first push creates a package | `acme/website` (owner and package name) | `repository` it is linked to |
| `package.push` | An image manifest is pushed | `acme/website:latest` (with the tag or digest) | `digest` |
| `package.update` | A package's visibility or linked repository changes | `acme/website` | the new settings |
| `package.delete` | A package is deleted | `acme/website` | none |
| `package.delete_version` | One version of a package is deleted | `acme/website@sha256:...` | none |

## Agents and on-behalf-of

When an agent acts, the entry records the agent as the actor and the agent's owner in `on_behalf_of`, so the page reads, for example, `review-bot for diffy`. This applies to pushes, merges, push protection decisions (including `api.blocked_secret`) and settings changes made with the agent's token, on the web or through the API. (Agents can never bypass branch protection on a merge, so `pull_request.merge_bypassed` always names a person.) See [Agents](/docs/agents/overview).

## Security emails

Some audit entries also send an email to the people affected. These emails are in the security group, which cannot be turned off:

| Action | Email |
|---|---|
| `session.create` | "New sign-in to your account", for a passkey sign-in from a device not seen before, and for every recovery sign-in |
| `passkey.add` | "A passkey was added to your account" |
| `passkey.remove` | "A passkey was removed from your account" |
| `agent.create` | "A new agent was added" |
| `push.blocked_secret` | "Your push was blocked: possible secrets", to the pusher (or the agent's owner); for a GitHub import, to whoever started it |
| `push.secret_bypassed`, `api.secret_bypassed` | "Push protection was bypassed", to the pusher (or committer) and the repository's admins |

Deleting a repository (`repo.delete`) also emails the repository owner, or the organization's owners and admins, except the person who deleted it. Token creation emails are sent when the token is created. See [Notifications](/docs/accounts/notifications).

## Troubleshooting

| Symptom | Cause |
|---|---|
| You don't see **Audit log** in the settings sidebar | Only site administrators can view it. Ask a site admin; see [Site administration](/docs/admin/site-administration). |
| A push or merge appears a few seconds late | `git.push`, `git.force_push`, `git.delete_ref`, `pull.merge`, `pull_request.merge_bypassed`, the `pull_request.auto_merge_*` and `pull_request.auto_merged` entries, `repo.protection.agent_auto_merge`, `repo.protection.agent_approval_waiver`, `repo.protection.agent_auto_merge_rule`, `repo.actions_workflow_settings` and push protection entries (including `api.blocked_secret` and `api.secret_bypassed`) are written by the event queue shortly after the action, not in the request itself. |
| An older entry is missing from the page | The page shows only the 200 most recent entries. |
