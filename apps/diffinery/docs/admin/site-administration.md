---
title: Site administration
description: Site administrators manage people, handle abuse and security reports and contact messages, suspend and delete accounts, stop Actions, post incidents, oversee imports, and check audit and email logs.
---

Site administrators run a Diffinery instance. They decide who gets in, help people who lost their passkeys, handle private security reports, post incidents on the status page, and check the audit log and email delivery. This page covers who the site administrators are and each page in the **Site administration** group of **Settings**.

## Site administrators

Site administrators have admin on every repository, can act as an owner of every organization (including its **Settings** tab, where the organization's name, picture and base permission are changed, and the **Add people** form on its **People** tab), and see an extra **Site administration** group in the **Settings** sidebar with these pages:

| Page | Path | What it is for |
| --- | --- | --- |
| **People and invitations** | `/settings/admin` | Access requests, instance invitations, the list of users, account status and sign-in links |
| **Early access** | `/settings/admin/early-access` | Requests from people without an invitation, to invite, decline or delete |
| **Contact messages** | `/settings/admin/contact` | Messages from the contact form, to read, answer, mark handled or spam, and delete |
| **Reports** | `/settings/admin/reports` | What people reported as abusive, to look at and resolve |
| **Email** | `/settings/admin/email` | Email delivery status, the suppression list, template previews and the log of every email |
| **Kill switches** | `/settings/admin/kill-switches` | Stop Actions and agent sandboxes for a repository, an account or the whole instance |
| **Security reports** | `/settings/admin/security-reports` | Private vulnerability reports from the report form, to read, triage and resolve |
| **Status** | `/settings/admin/status` | Incidents on the public status page, to open, update and resolve |
| **Search engines** | `/settings/admin/search-engines` | What Diffinery told search engines through IndexNow about new, changed and removed public pages |
| **Audit log** | `/settings/audit` | The most recent security-relevant events |

Their **Settings → Profile** page shows **Site admin** as yes, and they have an **admin** badge in the users list.

### Who becomes a site administrator

The instance setting `BOOTSTRAP_ADMINS` is a comma-separated list of email addresses, set on deploy from the `BOOTSTRAP_ADMINS` environment variable (a deploy without it keeps the list the instance has; see [BOOTSTRAP_ADMINS](/docs/self-hosting/configuration#bootstrap_admins)). An account becomes a site administrator when:

- it is created with an email address on the list (from an invite, after opening the link emailed to that address, or by verifying the email address through email recovery at `/auth/access`), or
- it was waiting for an invite (pending) and the person verifies an email address on the list at `/auth/access`.

Bootstrap administrators don't need an invite. Adding an address to the list later doesn't promote an account that is already active; use **Make admin** instead. See [Configuration](/docs/self-hosting/configuration) for the setting.

### Granting and removing site administration

In the **Users** table on **Settings → People and invitations**, the **Site admin** column has a **Make admin** button for each active person who isn't a site administrator, and a **Remove admin** button for each one who is. Both ask you to confirm, and both need a sign-in from the last 2 hours: if yours is older, Diffinery asks you to sign in again and brings you back. You see "diffy is now a site administrator." or "diffy is no longer a site administrator."

- Only active accounts can be made site administrators. Enable a pending or disabled account first.
- The last site administrator can never be removed: "Diffinery needs at least one site administrator: make someone else a site administrator first". You can remove yourself while there is another one; you then lose access to these pages.
- The person gets a security email saying who made the change.
- Each change is recorded in the [audit log](/docs/security/audit-log) as `site_admin.grant` or `site_admin.revoke`, with who made it and the person it was about.

### First sign-in for administrators

On a new instance nobody has a passkey yet. A bootstrap administrator signs in through email recovery:

1. Open `https://diffinery.com/auth/access`.
2. Confirm your email address with the one-time PIN that Cloudflare Access emails you.
3. On the page that follows (**Settings → Passkeys and sessions**), click **Add a passkey**.

From then on you sign in with the passkey. Email recovery needs Cloudflare Access to be set up for `/auth/access`; see [Passkeys and sign-in](/docs/accounts/passkeys-and-sign-in).

### Tokens and site administration

A site administrator's tokens are capped by their scope like anyone's: to act as admin on repositories through Git or the API, use an `admin`-scoped token. See [Personal access tokens](/docs/accounts/tokens).

## People

**Settings → People and invitations** (`/settings/admin`, titled **Site administration**) has three sections: **Pending access requests**, **Invite someone to this instance** and **Users**. Other people get `403 site administrators only`.

### Pending access requests

People who verified their email address at `/auth/access` without an invite have a pending account and can click **Request access** with a note. Each request is listed with the person's email address, when they asked and their note. Diffinery also emails up to 20 active site administrators about each request.

- **Approve** makes the account active. The person can then use Diffinery, but isn't added to any organization or repository; invite them to one, by email address or by username.
- **Deny** disables the account. The person gets a "Your account was disabled" email.

See [Invitations](/docs/accounts/invitations#access-requests) for the requester's side.

### Users

The **Users** table lists every person (not organizations, agents or deleted accounts) with their picture and username, email address, when they joined, their status and whether they are a site administrator. Each row has **Make admin** or **Remove admin** (see [Granting and removing site administration](#granting-and-removing-site-administration)), **Sign-in link** (see [Sign-in links](#sign-in-links)) and **Delete** (see [Deleting an account](#deleting-an-account)). For each user except yourself you can pick a status in the menu and click **Save**. You see "User updated."

| Status in the menu | Value | Meaning |
| --- | --- | --- |
| **Active** | `active` | Can sign in and use everything their roles allow |
| **Pending** | `pending` | Waiting for an invite: can sign in but only sees the **Waiting for an invite** page |
| **Disabled** | `disabled` | Can't use Diffinery |

A suspended person has a red **suspended** badge, and their status is `disabled` until you unsuspend them (see [Suspend an account](#suspend-an-account)). Each row also has **Suspend** (with a reason), or **Unsuspend** for someone suspended.

You can't change your own status ("you cannot change your own status").

Pending accounts also become active without you when someone invites their email address (including with **Add people**), or when the person accepts an invitation sent to their username on the **Waiting for an invite** page. Being invited by username doesn't make the account active by itself.

### Disable an account

Set the user's status to **Disabled** and click **Save**. Immediately:

- every browser session they have ends, so they are signed out everywhere, and passkey sign-in is refused with "Your account is disabled.",
- every access token the person has is revoked,
- agents they own stop working, because an agent can never do more than its owner,
- they get a "Your account was disabled" email.

Their repositories, organizations and memberships stay as they are, but they can't be added to organizations or repositories while disabled ("diffy's account is disabled"). Set the status back to **Active** to enable the account; the person gets "Your account was enabled" and signs in with their passkey again. Their old tokens stay revoked, so they need to create new ones.

Every status change is recorded in the audit log as `user.active`, `user.pending` or `user.disabled`.

### Deleting an account

Click **Delete** on the person's row in the **Users** table. A page shows what will go: their repositories (with how many), container images, tokens, passkeys, agents, settings and memberships. Type their username and click **Delete this account**. It needs a sign-in from the last 2 hours, like granting site administration. You see "Deleted the account diffy." and the person gets an email saying a site administrator deleted their account.

The page says why, and the button is off, when the person is the only owner of an organization (it names each one), the only site administrator, or has a GitHub import running. Make someone else an owner, or delete the organization, first.

Deleting an account is the same as the person deleting it themselves: everything they own goes, what they wrote in other people's repositories is shown as written by **ghost**, and their username can't be used for 90 days. See [Exporting and deleting your account](/docs/accounts/account-data#deleting-your-account). It can't be undone; to keep someone out while you decide, disable the account instead. Each deletion is recorded in the audit log as `account.delete`, with `"via":"admin"`.

### Suspend an account

Suspending is for abuse: like disabling, it stops the person at once, but it also hides what they made, and unsuspending puts everything back as it was, tokens included. It works as on GitHub Enterprise.

In the **Users** table, click **Suspend** next to the person, enter a **Reason** (at most 500 characters; it is emailed to them and kept in the audit log) and click **Suspend diffy**. You can also suspend from a report about the person. Immediately:

- every browser session they have ends, and passkey sign-in is refused with "Your account is disabled.",
- their access tokens, their agents' tokens and their runners are refused (`401`), but not revoked,
- running workflow runs and agent sandboxes in their repositories stop, and no new ones start, as with [Suspend Actions for an account](#kill-switches),
- their profile, repositories (on the web, through Git, the API and the container registry) and packages answer `404` to everyone else,
- their issues and pull requests answer `404` and are left out of lists and search, and their comments and reviews are left out of every conversation,
- they get a "Your account was suspended" email with the reason.

Site administrators still see all of it, with a **suspended** badge on the profile; `GET /api/v3/users/{username}` shows them `suspended_at` and `suspension_reason`. Site administrators can't be suspended, and you can't suspend yourself.

**Unsuspend** makes the account active again. Their tokens, agents and runners work again, their content is shown again and they get a "Your account is no longer suspended" email. Their browser sessions stay ended, so they sign in again with their passkey. Workflow runs that were stopped don't restart.

Suspensions are audited as `user.suspend` (with the reason and what was stopped) and `user.unsuspend`. From the API, with an `admin`-scoped token that isn't limited to repositories (GitHub Enterprise's endpoints):

```sh
echo '{"reason": "spam in issues, see report 4f2c"}' | diffinery api PUT /users/diffy/suspended --input -
diffinery api DELETE /users/diffy/suspended
```

Both answer `204`. Anyone else gets `403 site administrators only`.

## Early access

While the instance is invite-only, people without an invitation can ask for one at `/early-access`, and confirm their address with an emailed link. **Settings → Early access** (`/settings/admin/early-access`) lists the requests: **Confirmed** ones wait for you, with their count next to **Early access** in the sidebar and a reminder on **People and invitations**. **Invite** sends the usual instance invitation (see [Invites](#invites)), **Decline** emails nobody, and **Delete request** removes everything stored about a request. Each decision is in the audit log. See [Early access](/docs/accounts/early-access#for-site-administrators) for the whole page, the API and how the form is protected.

## Contact messages

Anyone can write to the site administrators at `/contact`, linked from every page's footer. People who aren't signed in pass Turnstile and confirm their address with an emailed link first. **Settings → Contact messages** (`/settings/admin/contact`) lists the messages: **New** ones wait for you, with their count next to **Contact messages** in the sidebar, and each one emails every site administrator with the sender as Reply-To. **Reply by email** opens your mail app, **Mark handled** and **Spam** sort them, a **Note** tells the other site administrators what happened, and **Delete message** removes everything stored about one. Each change is in the audit log. See [Contact form](/docs/admin/contact-form#for-site-administrators) for the whole page, the API and how the form is protected.

## Reports

Anyone signed in can report a person, a repository, an issue, a pull request or a comment as abusive, from the **…** menu on it (or on a profile) and **Report**. They pick a reason (spam, harassment or bullying, hateful content, violence or threats, sexual content, malware or phishing, impersonation, or something else) and can add a note of up to 2,000 characters; "Something else" needs the note. The person reported isn't told. One person files at most 20 reports a day, and one open report per thing.

**Settings → Reports** (`/settings/admin/reports`) lists the open reports, newest first, with what was reported, the reason, who reported it and when; **Resolved** lists the rest. Open one to see:

- a link to what was reported, and the account that wrote it,
- the reporter's note,
- what was reported as it was then (an issue's title and text, a comment's text), so editing or deleting it afterwards hides nothing,
- **Resolve with a note**: say what you did (hid the comment, suspended the account, nothing to do) and click **Resolve**. A resolved report can be reopened with **Reopen**.
- **Suspend** the account that wrote it, with a reason.

Filing, resolving and reopening are audited as `report.create`, `report.resolve` and `report.reopen`.

From the API, people file reports with `POST /api/v3/diffinery/reports`; site administrators read the queue with `GET /api/v3/admin/reports` (`?state=open`, `resolved` or `all`) and `GET /api/v3/admin/reports/{id}`, and resolve with `PATCH /api/v3/admin/reports/{id}` and `{"state": "resolved", "resolution": "..."}` (an `admin`-scoped token). See [REST API](/docs/reference/rest-api#moderation).

Other tools for abuse: [blocking](/docs/accounts/blocking-and-reporting) (anyone, for themselves or their organization), [hiding comments](/docs/collaboration/issues#hide-a-comment) (anyone with write access to the repository; site administrators everywhere) and the [kill switches](#kill-switches).

## Invites

Under **Invite someone to this instance**, enter an **Email address** and click **Send invitation** (the hint says "We email them a link. Opening it lets them pick a username and create a passkey."). The invite isn't tied to an organization or repository: it only lets the person create an account. Diffinery emails the link and also shows it to you under "Invite created for friend@example.com" with a copy button, with the note that it expires in 14 days and works once. Instance invitations can't be revoked.

The same works from the CLI (`diffinery invite friend@example.com`, without `--org`) and the API (`POST /api/v3/invitations` with `{"email": "friend@example.com"}`); both are limited to site administrators. Site administrators can also add people to any organization with **Add people** on its **People** tab, and revoke its pending invitations there. See [Invitations](/docs/accounts/invitations) for all kinds of invites.

## Sign-in links

When someone loses their passkeys, a site administrator can give them a one-time link that adds a new passkey to their existing account.

1. In the **Users** table, click **Sign-in link** next to the person.
2. Confirm "Create a one-time link that adds a passkey to diffy? Only send it to them."
3. The page shows **Sign-in link for diffy** with the link and a copy button. Diffinery has already emailed it to the person ("Your one-time sign-in link"); you can also send it yourself through a channel you trust.

The person opens the link, creates a passkey and is signed in. See [Passkeys and sign-in](/docs/accounts/passkeys-and-sign-in#sign-in-link-from-an-administrator) for their side.

| Rule | Value |
| --- | --- |
| Lifetime | 24 hours |
| Uses | Once |
| Disabled accounts | Refused with "enable this account first"; enable the account, then create the link |
| Link format | `https://<host>/signin#<token>`. The token is in the URL fragment, which browsers never send to the server, so it stays out of request logs and `Referer` headers. The page removes it from the address bar. Older `/signin/<token>` links still work. |
| Effect | Adds a passkey and signs that browser in; the person's other passkeys stay |
| Audit | `signin_link.create` when you create it, `passkey.add` when it is used |

Anyone with the link can add a passkey to the account, so send it only to that person. The link also works for a first sign-in, for an account that exists but has no passkey yet.

## Kill switches

Kill switches stop Actions and agent sandboxes quickly, for abuse, a runaway workflow or a cost problem. There are three, from the narrowest:

| Switch | What stops | What keeps working |
| --- | --- | --- |
| **Suspend Actions for a repository** | Every workflow run of the repository, on hosted and self-hosted runners, and its agent sandboxes (including agent tasks' and reviews') | Everything else in the repository: Git, issues, pull requests |
| **Suspend Actions for an account** | The same, for every repository a person or an organization owns, including repositories created or transferred in later | The account's other repositories' Git and collaboration |
| **Pause hosted compute** | Hosted Actions jobs and agent sandboxes in every repository on the instance | Self-hosted runners, which cost the instance nothing, and workflow runs themselves |

Nobody is exempt, not even site administrators' own accounts and organizations (unlike [account quotas](/docs/reference/limits#account-quotas)). Every change is in the audit log: `actions.suspend` and `actions.unsuspend` with the repository (`owner/name`) or the account's login as the target, `compute.pause` and `compute.unpause`, each with the reason and what was stopped.

### While a switch is on

While a repository or its owner is suspended:

- no workflow run starts: pushes, pull requests, schedules and other events start nothing, and no run is recorded;
- **Run workflow** (`workflow_dispatch`), `repository_dispatch` and **Re-run** are refused with `403 Actions are suspended for this repository by a site administrator: <reason>` (or `... for every repository of <account> ...`);
- a job that would start fails instead, with "The job was not started: Actions are suspended ...", and a self-hosted runner isn't given a job that was already waiting;
- a new sandbox is refused with the same `403`, so agent tasks and reviews fail when they try to start theirs, with that message.
- [web terminals](/docs/agents/terminal) can't be opened or attached to, and open ones end within a minute ("A site administrator suspended Actions and sandboxes here").

While hosted compute is paused:

- a job on a hosted runner fails without starting: "The job was not started: Hosted runners are paused on this instance by a site administrator: <reason>. Self-hosted runners still work." Jobs of the same run on self-hosted runners run as usual;
- a new sandbox is refused with `403 Agent sandboxes are paused on this instance by a site administrator: <reason>` (agent tasks and reviews fail to start theirs), and a sandbox that went to sleep doesn't wake up.
- web terminals can't be opened or attached to, and open ones end within a minute.

The repository's **Actions** page, its run pages and its **Settings** pages show a red banner with the reason, so the people affected know why. While hosted compute is paused, every **Site administration** page shows "Hosted compute is paused on this instance" at the top, so nobody forgets to turn it back on.

### Turning a switch on stops what is running

- Suspending a repository or an account cancels each of its unfinished runs ("Cancelled: Actions are suspended ...", including jobs on self-hosted runners) and closes each of its open sandboxes.
- Pausing hosted compute fails each running hosted job ("The job was stopped: Hosted runners are paused ...") and closes the open sandboxes, in every repository with hosted compute running (Diffinery finds them from the hosted minutes it is counting). Jobs that wait in the queue fail when they would start.
- [GitHub jobs on Diffinery runners](/docs/actions/github-runners) count as the linked account's hosted jobs: suspending that account, or pausing hosted compute, fails its GitHub jobs that wait for a runner and stops its running GitHub runners (counted in `jobs`). The jobs on GitHub end as their runner stops.

The answer says what was stopped: `stopped` with `repositories`, `runs`, `jobs`, `sandboxes`, and `failed` for repositories that didn't answer (their work still can't start).

Turning a switch off only lets new work start again. Nothing that was stopped restarts: re-run the runs you want and start new sandboxes.

### From the web

**Settings → Kill switches** (`/settings/admin/kill-switches`):

- **Hosted compute** shows **running** or **paused**. Enter a **Reason** and click **Pause hosted compute** (you confirm first), or click **Resume hosted compute**.
- **Suspend Actions for an account**: the person's or organization's login and a **Reason**, then **Suspend**.
- **Suspend Actions for a repository**: `owner/name` and a **Reason**, then **Suspend**.
- **Suspended** lists every suspended account and repository with who suspended it, when and why, and a **Lift** button.

A reason is required (at most 500 characters): it is shown to the people affected and kept in the audit log.

### From the API

Site administrators only (`403 only site administrators can ...` for anyone else). Reading needs any token that isn't limited to repositories; changing needs an `admin`-scoped token that isn't limited to repositories, or a browser session.

| Method and path | Does |
| --- | --- |
| `GET /api/v3/admin/repos/{owner}/{repo}/actions-suspension` | `suspended`, `reason`, `suspended_by`, `suspended_at`, and `owner_suspended` when the owner's Actions are suspended |
| `PUT /api/v3/admin/repos/{owner}/{repo}/actions-suspension` | Suspend, with `{"reason": "..."}` |
| `DELETE /api/v3/admin/repos/{owner}/{repo}/actions-suspension` | Lift |
| `GET`, `PUT`, `DELETE /api/v3/admin/accounts/{login}/actions-suspension` | The same for a person or an organization |
| `GET`, `PUT`, `DELETE /api/v3/admin/hosted-compute-pause` | `paused`, `reason`, `paused_by` and `paused_at`; pause with `{"reason": "..."}`, resume with `DELETE` |

```sh
echo '{"reason": "crypto mining, see ticket 123"}' | diffinery api PUT /admin/repos/acme/website/actions-suspension --input -
diffinery api DELETE /admin/repos/acme/website/actions-suspension
echo '{"reason": "runner image incident"}' | diffinery api PUT /admin/hosted-compute-pause --input -
```

## GitHub imports and linked accounts

Site administrators have extra reach over [imports from GitHub](/docs/migrate-from-github):

- **Import into any account.** A site administrator can start an import into any user's account or any organization, not only their own (agent accounts can't own imports).
- **See and cancel any import.** Open `https://diffinery.com/imports/<id>`, or call `GET /api/v3/diffinery/imports/{id}`, for any import, and stop one with **Cancel import** or `POST /api/v3/diffinery/imports/{id}/cancel` (audited as `import.cancel`, with you in `by`). The **Imports** page and `GET /api/v3/diffinery/imports` still list only the imports you started yourself.
- **Retrying stays with the starter, except for agents' imports.** A person's import can be retried only by that person, even by a site administrator. An import an agent started can also be retried by any person who may import into the target, which includes site administrators.

### Clear a GitHub link

An import attributes a GitHub user's issues, pull requests, comments and reviews to the Diffinery account linked to that GitHub user. If a link is wrong, for example after a Diffinery account changed hands, a site administrator can remove it. There is no page for this; use the API with an `admin`-scoped token that isn't limited to repositories (or a browser session):

```sh
diffinery api DELETE /diffinery/admin/linked-accounts/<link id>
```

The link id comes from `GET /api/v3/diffinery/user/linked-accounts`, called by the account that owns the link; Diffinery has no endpoint that lists other people's links. The request answers `204`, or `404 link not found`, and is audited as `account.link_cleared` with the link (`github.com/diffy`) as the target and the Diffinery account's id in the detail. Imports that already ran keep their attribution; later imports treat that GitHub user as a mannequin until someone links the account again. People unlink their own accounts on **Settings → Linked accounts** (`account.unlink_github`).

## Account quotas

Every person and organization has [quotas](/docs/reference/limits#account-quotas) on hosted minutes per month, hosted jobs running at once, agent sandboxes open at once, repositories and storage. Accounts run by a site administrator have none. The defaults come from the `QUOTA_*` variables in [Configuration](/docs/self-hosting/configuration). There is no page for quotas; use the API:

```sh
diffinery api GET /admin/accounts/acme/quotas
echo '{"hosted_minutes": 6000, "repositories": -1, "storage_bytes": 53687091200}' | diffinery api PATCH /admin/accounts/acme/quotas --input -
```

| Request | What it does | Who |
| --- | --- | --- |
| `GET /api/v3/admin/accounts/{login}/quotas` | The account's quotas and what it uses: `hosted_minutes` (`used`, `limit`), `hosted_jobs` (`running`, `limit`), `sandboxes` (`open`, `limit`), `repositories` (`count`, `limit`), `storage_bytes` (`used`, `limit`, in bytes), with `exempt` and `period_start` (the start of the month, UTC) | site administrator, any token scope |
| `PATCH /api/v3/admin/accounts/{login}/quotas` | Changes only the quotas you send: a whole number (`storage_bytes` in bytes, up to 1 PiB), `-1` for unlimited, or `null` to go back to the default. Answers like `GET`. Audited as `account.quotas.set`. | site administrator, with an `admin` token not limited to repositories, or a browser session |

`{login}` is a person or an organization; an agent gets `404 no person or organization with that name`, because agents use their owner's quotas. Anyone else gets `403 only site administrators can see and change quotas`. People see their own usage with `GET /api/v3/user/usage`, and organization owners and admins see their organization's with `GET /api/v3/orgs/{org}/usage`.

Storage is counted per repository as it changes: each repository's Durable Object keeps a running total of its git objects, Git LFS objects and release assets and reports it to D1 (`repo_storage`), where the owner's repositories and packages are added up. A repository that hasn't reported yet, such as one made before storage was counted, is measured the first time its account's storage is checked (up to 25 per check): its git objects are added up once from its own database, and its Git LFS objects are listed from R2 once. Purging unreachable objects counts the repository again.

## Audit log

**Settings → Audit log** (`/settings/audit`) shows the 200 most recent security-relevant events: sign-ins, passkeys, tokens, invites, account status changes, repository and access changes, pushes, merges and push protection. Repository and organization settings changed through the REST API or the CLI are recorded too: repository settings, archiving, collaborators, branch protection, Actions secrets and variables (repository, environment and organization), webhooks, a repository's workflow token settings, and deleted Actions artifacts and caches. Imports from GitHub (`import.create`, `import.push`, `import.finish` and the rest) and linked GitHub accounts are recorded too. Settings changes made through the API have `via: api` in their **Detail**. Each row has **When**, **Actor** (and who an agent acted for), **Action**, **Target** and **Detail**. See [Audit log](/docs/security/audit-log) for every action and how to use it.

## Email

**Settings → Email** (`/settings/admin/email`) shows whether the instance can send email and lets you check every template.

| Item | What it shows |
| --- | --- |
| **Sending** | "Cloudflare Email Sending is bound"; "over SMTP: smtps://user@host:465", the server in `SMTP_URL` (never the password); "SMTP_URL is set but can't be used: ..." with the reason; or "not configured (no EMAIL binding or SMTP_URL): emails are logged, not sent". See [SMTP](/docs/self-hosting/configuration#smtp). |
| **Queue** | `diffinery-mail`, or "not bound: emails are dropped" |
| **From** | The address emails are sent from: `MAIL_FROM`, or `notifications@<your hostname>` when it is empty (see [Configuration](/docs/self-hosting/configuration)) |
| **Bounces and complaints** | Where they come from: the `diffinery-mail-events` queue, and whether the signed endpoint is on (`MAIL_EVENTS_SECRET` set) |
| **Last 24 hours** | How many emails were sent, failed and skipped |

Buttons:

- **Send me a test email** sends one test email to you right away and shows the result.
- **Send every template to me** queues one sample of every template to your address, ignoring your notification settings. They show up under **Recent emails** as they are sent.

Under **Templates**, pick a template from the menu to preview it in the page. **Open HTML** opens the HTML version in a new tab; **Plain text** shows the text version with its headers (`From`, `Subject`, `X-Diffinery-Reason`, `List-Unsubscribe` and the rest). The previews use sample data such as the repository `acme/website`.

**Suppressed addresses** lists every address Diffinery sends nothing to, newest first, with why (`hard-bounce`, `complaint` or `manual`), where that came from and since when. **Remove** sends email to the address again; **Suppress an address** adds one by hand, with an optional note. Both are recorded in the audit log. See [Bounces, complaints and the suppression list](#bounces-complaints-and-the-suppression-list).

**Recent emails** lists the last 100 emails sent to anyone, with the time, recipient address, subject, template kind, the message ID (Cloudflare's, or the `Message-ID` Diffinery gave an email sent over SMTP), the status (`sent`, `failed` or `skipped`) and the reason when it wasn't sent. The log keeps 90 days.

See [Notifications](/docs/accounts/notifications#every-email-diffinery-sends) for when each email is sent.

### Email API for administrators

| Method and path | Description | Needs |
| --- | --- | --- |
| `GET /api/v3/diffinery/admin/email` | `sending` and `queue` (whether they are configured), `transport` (`email-sending`, `smtp` or `null`), `smtp` (`url`, the server without the password, and `error`, why `SMTP_URL` can't be used; `null` unless `transport` is `smtp`), `from` (the sender address: `MAIL_FROM`, or `notifications@<your hostname>` when it is empty), `last_24h` counts (`sent`, `failed`, `skipped`) and the `last` email logged | site administrator, any token scope |
| `POST /api/v3/diffinery/admin/emails/samples` | Send every template to yourself now, or only some with `{"only": ["signin", "invite-org"]}`. Returns `to`, `sent`, `total` and each result. | site administrator, with an `admin` token for all repositories or a browser session |
| `GET /api/v3/diffinery/admin/email/suppressions` | The suppression list, newest first: `email`, `reason`, `detail`, `source` (`cloudflare`, `webhook`, `send` or `admin`), `created_by`, `created_at` and `owner_can_lift` | site administrator, any token scope |
| `PUT /api/v3/diffinery/admin/email/suppressions/{email}` | Suppress an address by hand, with an optional `{"note": "..."}`. Audited as `email.suppression.add`. | site administrator, with an `admin` token or a browser session |
| `DELETE /api/v3/diffinery/admin/email/suppressions/{email}` | Remove an address from the list, whatever put it there; `204`, or `404` when it isn't there. Audited as `email.suppression.remove`. | site administrator, with an `admin` token or a browser session |
| `GET /api/v3/diffinery/emails?all=1` | Everyone's recent emails (without `all=1`, only yours). Also takes `kind`, `since` and `per_page` (up to 500). | site administrator for `all=1` |

The sample IDs are `pr-opened`, `issue-opened`, `comment`, `review-approved`, `review-changes`, `review-requested`, `assigned`, `pushed`, `merged`, `closed`, `reopened`, `run-failed`, `signin`, `passkey-added`, `passkey-removed`, `token-created`, `token-expiring`, `agent-created`, `model-key-added`, `review-limit`, `push-bypassed`, `push-blocked`, `commit-blocked`, `account-disabled`, `account-enabled`, `account-suspended`, `account-unsuspended`, `invite-org`, `invite-repo`, `invite-accepted`, `welcome`, `signin-link`, `email-verify`, `access-request`, `org-member`, `repo-access`, `repo-created`, `repo-deleted`, `repo-transferred` and `test`.

### Bounces, complaints and the suppression list

Diffinery sends no email at all to an address on the suppression list: not notifications, not security alerts, not sign-in links or account recovery. Such an email shows in **Recent emails** as `skipped` with "address is suppressed: ..." as the reason. An address gets on the list three ways:

| Reason | How |
| --- | --- |
| `hard-bounce` | Email to it bounced permanently (the mailbox or domain doesn't exist, or the receiving server refuses it for good), or Email Sending refused to send to it for good (`E_RECIPIENT_SUPPRESSED`, source `send`), or the SMTP server refused the recipient for good (`E_SMTP_RECIPIENT_REJECTED`, source `send`). Soft bounces, delays and temporary send errors (rate and daily limits, delivery errors) change nothing. |
| `complaint` | Its owner marked an email from Diffinery as spam. |
| `manual` | A site administrator added it, under **Suppress an address** or with the API. |

A newer event replaces an older one for the same address. Every addition is in the audit log as `email.suppression.add`.

**Lifting a suppression.** A site administrator can remove any address (**Remove**, or `DELETE /api/v3/diffinery/admin/email/suppressions/{email}`). People can lift a bounce or complaint on their own address themselves: **Settings → Email** shows that the address is suppressed and why, and **Send a verification email** sends one email to it, past the list. Following its link while signed in to the same account turns email back on (`email.suppression.lift` in the audit log). The link works for 24 hours, and at most 3 can be asked for in an hour. A `manual` suppression can only be removed by an administrator. See [Notifications](/docs/accounts/notifications#when-diffinery-stops-emailing-you).

Cloudflare Email Sending keeps a suppression list of its own, for bounces and complaints it sees. When it refuses to send to an address on that list (`E_RECIPIENT_SUPPRESSED`, shown as `failed` in **Recent emails**), Diffinery adds the address to its own list as a `hard-bounce` with source `send`, so later emails are skipped. If you remove such an address from Diffinery's list, remove it in the Cloudflare dashboard too (**Email Service → Email Sending → Suppressions**), or the next email to it puts it back.

#### Where bounces and complaints come from

Cloudflare Email Sending publishes delivery events (`message.delivered`, `message.bounced`, `message.complained` and others) through [event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/) to a queue. Diffinery consumes the `diffinery-mail-events` queue, and **the deploy sets it all up**: `scripts/bootstrap.sh` creates the queue and, when it is missing, an event subscription named `diffinery-mail-events <domain>` with source **Email Sending**, your sending domain (`MAIL_DOMAIN`, or `DIFFINERY_DOMAIN`), and the **bounced** and **complained** events. A subscription you made yourself for that domain and queue is kept; any of those two events it lacks are added. Other events are ignored.

The deploy's API token needs **Account → Queues → Edit** for this (the [API reference](https://developers.cloudflare.com/api/resources/queues/subresources/subscriptions/methods/create/) calls it "Queues Write"), and **Zone → Zone → Read** on the zone of your sending domain to look up its zone ID; the domain must be onboarded to Email Sending. Without them the deploy goes on and prints a warning such as `Could not subscribe diffinery-mail-events to Email Sending's bounce and complaint events for example.com. The token needs Account → Queues → Edit ...`, followed by Cloudflare's error. Then either add the permission to the token and deploy again, or subscribe the queue by hand once:

1. In the Cloudflare dashboard, open **Storage & databases → Queues** and select `diffinery-mail-events`.
2. On the **Subscriptions** tab, click **Subscribe to events**.
3. Name the subscription (for example `diffinery-bounces`), pick **Email Sending** as the source and your sending domain (the domain of `MAIL_FROM`), and select at least the **bounced** and **complained** events. Others are ignored.
4. Click **Subscribe**.

With Wrangler, the same is `wrangler queues subscription create diffinery-mail-events --source email.sending --zone-id <zone id> --domain <sending domain> --events message.bounced,message.complained`.

Only Cloudflare can publish to the queue, so its messages need no signature. Until the subscription exists, bounces and complaints reach the list only when Email Sending refuses a send (see above); administrators can still add and remove addresses by hand.

**The signed endpoint.** Anything else that can relay bounces and complaints, such as another provider's webhook through a small relay, can POST them to `https://<your host>/-/email/events`. It is off (`404`) until you set the `MAIL_EVENTS_SECRET` Worker secret, and it refuses (`401`) any request without a good signature:

- Header `X-Diffinery-Signature: t=<unix seconds>,v1=<signature>`, where the signature is the hex HMAC-SHA256, keyed with `MAIL_EVENTS_SECRET`, of `<t>.<the raw request body>`. Requests more than 5 minutes old (or ahead) are refused, so a captured request can't be replayed later.
- The body is JSON: one event, an array of events, or `{"events": [...]}`, at most 1,000 events and 1 MB. Each event has Cloudflare's shape: a `type` ending in `message.bounced` or `message.complained`, and a `payload` with `recipient` and, for bounces, `bounce.type` (`hard` or `soft`) and `bounce.reason`.
- The answer is `{"suppressed": <n>, "ignored": <n>}`. Events of any other type, and soft bounces, are ignored.

```sh
secret=...   # the value of MAIL_EVENTS_SECRET
body='{"type":"message.bounced","payload":{"recipient":"someone@example.com","bounce":{"type":"hard","reason":"550 5.1.1 User unknown"}}}'
t=$(date +%s)
sig=$(printf '%s' "$t.$body" | openssl dgst -sha256 -hmac "$secret" -hex | sed 's/^.* //')
curl -sS https://diffinery.example/-/email/events -H 'content-type: application/json' \
  -H "X-Diffinery-Signature: t=$t,v1=$sig" --data "$body"
```

Set the secret with `wrangler secret put MAIL_EVENTS_SECRET -c wrangler.deploy.jsonc` (see [Configuration](/docs/self-hosting/configuration#worker-secrets)).

## Security reports

`/.well-known/security.txt` names the instance's private report form, `/security/report`, as its first contact (see [Configuration](/docs/self-hosting/configuration#security-contact)). Anyone can send a report there: signed in, or without an account after Cloudflare Turnstile, which the deploy sets up when its API token has **Account → Turnstile → Edit** (see [Turnstile](/docs/self-hosting/configuration#turnstile); without it, only people who are signed in can report). A report has a one-line summary (up to 200 characters), details (plain text, up to 20,000 characters), optionally the affected URL or area, and a reply-to address: required without an account, optional when signed in, when the account's own address is used. Limits: 5 reports a day from one IP address for people who aren't signed in, 50 a day from all of them together, 10 a day per account, and the sign-in rate limit of 20 requests a minute per IP address.

Only site administrators can see reports. To anyone else the pages and the API answer `404`, as if they didn't exist.

Each new report emails every active site administrator (`security_report`, an email that always sends). The email has the summary and a link to the report, never the details: read those in Diffinery.

**Settings → Security reports** (`/settings/admin/security-reports`) lists reports newest first, with when they arrived, the summary, who sent it (a username, or "not signed in") and the state: **New**, **Triaged** or **Resolved**. The **Show** menu filters by state. Click a summary to open the report: its state, when it arrived, the reporter, the reply-to address, the affected URL or area, its reference (the id the reporter was shown) and the details as plain text. Under **Triage**, pick a state, write a note for the other administrators and click **Save**; you see "Report updated." Each change is in the audit log (`security_report.triage`, `security_report.resolve`, or `security_report.reopen` when set back to **New**), with the note. Reply to the reporter from your own mailbox: Diffinery doesn't email them.

| Method and path | Description | Needs |
| --- | --- | --- |
| `GET /api/v3/diffinery/admin/security-reports` | Reports, newest first: `id`, `state`, `summary`, `details`, `area`, `reply_to`, `reporter` (a login, or `null`), `note`, `updated_by`, `updated_at`, `created_at` and `html_url`. Takes `state` (`new`, `triaged` or `resolved`) and `per_page` (default 100, up to 500). | site administrator, a `read` token not limited to repositories, or a browser session |
| `GET /api/v3/diffinery/admin/security-reports/{id}` | One report, as in the list | site administrator, a `read` token not limited to repositories, or a browser session |
| `PATCH /api/v3/diffinery/admin/security-reports/{id}` | `{"state": "triaged", "note": "..."}`: sets the state (`triaged`, `resolved`, or `new` to reopen) and the note (up to 2,000 characters; leaving it out clears it). Answers with the report. Audited like **Save**, with `via: api`. | site administrator, with an `admin` token not limited to repositories, or a browser session |

```sh
diffinery api GET '/diffinery/admin/security-reports?state=new'
echo '{"state": "resolved", "note": "Fixed in 2026.10.15; reporter credited."}' | diffinery api PATCH /diffinery/admin/security-reports/<id> --input -
```

## Status

Every instance has a public [status page](/docs/self-hosting/status-page) at `/status`, with JSON at `GET /api/v3/diffinery/status`: each component's status, incidents in progress and those resolved in the last 14 days. Anyone can read it without signing in.

**Settings → Status** (`/settings/admin/status`) shows what the page says now, a form to open an incident (a title, the impact, the affected components, a state and the first update), each open incident with a form to post an update or resolve it, and the recent incidents. While an incident isn't resolved, its impact sets the status of each component it names; pausing hosted compute (see [Kill switches](#kill-switches)) puts **Actions** and **Agents and sandboxes** under maintenance without one. Each change is in the audit log (`status_incident.create`, `status_incident.update` or `status_incident.resolve`). Incidents and their updates are public, so keep internal details out of them.

| Method and path | Description | Needs |
| --- | --- | --- |
| `GET /api/v3/diffinery/admin/status/incidents` | Incidents, newest first, with their updates | site administrator, a `read` token not limited to repositories, or a browser session |
| `POST /api/v3/diffinery/admin/status/incidents` | `{"title": "...", "impact": "major", "components": ["git"], "state": "investigating", "body": "..."}`: opens an incident | site administrator, with an `admin` token not limited to repositories, or a browser session |
| `POST /api/v3/diffinery/admin/status/incidents/{id}/updates` | `{"state": "resolved", "body": "..."}`: posts an update, which resolves the incident when its state is `resolved` | site administrator, with an `admin` token not limited to repositories, or a browser session |

To anyone else these endpoints answer `404`. The status page runs in the instance's own Worker, so it is down whenever the whole Worker is: watch `/healthz` with an external uptime monitor too (see [Monitoring from outside](/docs/self-hosting/status-page#monitoring-from-outside)).

## Search engines

Diffinery tells search engines about public pages that are added, change or go away through [IndexNow](https://www.indexnow.org), so Bing, Yandex, Naver, Seznam, Yep and the other engines that share IndexNow submissions recrawl them within minutes instead of whenever they next visit. Nobody needs to do anything: it runs by itself after every deploy.

What it covers:

- **After each deploy**, the pages the deploy added, changed or removed: the home page, the product, comparison and company pages (`/features`, `/compare/github`, ...), every docs page, each of those pages' Markdown version (`/index.md`, `/compare/github.md`, `/docs/quickstart.md`, ...), `/llms.txt`, `/llms-full.txt`, `/contact`, and `/early-access` while the instance is invite-only. These are the pages in `/sitemap.xml` plus their Markdown versions. A deploy that changes no page's content submits nothing.
- **Every hour**, public repositories pushed since they were last submitted (their page, `/<owner>/<repo>`, as the sitemap lists it).
- **Never** a private repository, a repository whose owner is suspended, or any page behind sign-in (settings, notifications, the API, sign-in pages). A repository is only submitted in the same check that found it public, so one made private in the meantime isn't sent, and it is forgotten. Removed site and docs pages are submitted once more, so search engines learn they are gone.

How it works: the Worker's five-minute cron notices a new deploy, hashes each page's content and compares the hashes with the ones it last submitted, then sends only the differences in one request (up to 10,000 URLs; more wait for the next run) to `api.indexnow.org`. Engines share what any of them receives, so when `api.indexnow.org` answers `429` or `5xx` or can't be reached, the same request goes to Bing's own endpoint (`www.bing.com/indexnow`), then Yandex's (`yandex.com/indexnow`): IndexNow limits requests per IP address, and a Worker sends from addresses it shares with other Workers. A run on an older version during a deploy's rollout is ignored. Submitting happens after the deploy, in the background, so it can't fail or slow one. If every endpoint answers `429 Too Many Requests`, the pages stay queued for an hour; after another refusal (`400`, `403`, `422`) for 6 hours; if it can't be reached or fails (`5xx`, a timeout), for 15 minutes. IndexNow's `200 OK` and `202 Accepted` (key validation pending) count as submitted.

The key that proves submissions come from this site is served at the site root, `/<key>.txt`. It is 32 hex characters derived from the instance's `MASTER_KEY` and `PUBLIC_URL`, so each instance has its own and nothing needs configuring. [Rotating MASTER_KEY](/docs/self-hosting/configuration#rotating-master_key) gives the instance a new key, which the next submission uses.

**Settings → Search engines** (`/settings/admin/search-engines`) shows whether IndexNow is on and its key file, how many pages and public repositories it tracks and how many are waiting, and the newest submissions: when, how many URLs, which endpoint answered, its answer and how long it took, any error, and the pages sent. The newest 200 submissions are kept. The same is available over the API:

```bash
diffinery api GET "/diffinery/admin/indexnow?per_page=10"
```

Anyone can see whether it is on and how the last submission went, without the pages, in `GET /api/v3/meta` (`indexnow`). Each submission is also logged in the Worker's logs as `indexnow: <n> URLs, <status> in <ms> ms`.

IndexNow is off when `INDEXNOW` is `off`, when `PUBLIC_URL` isn't a public `https` origin (`localhost`, an IP address or `http`, as in local development), or when `MASTER_KEY` isn't set. See [Configuration](/docs/self-hosting/configuration#worker-variables).

## Workflow scheduler

Scheduled workflows are started by Diffinery's own timer, every 5 minutes, which also catches up checks that came late (see [Scheduled workflows](/docs/actions/events#schedule)). When a scheduled run doesn't start, read the scheduler's state to tell a timer that stopped from a run that failed to start:

```bash
diffinery api GET /diffinery/admin/scheduler
```

```json
{ "tick_minutes": 5, "last_tick_at": "2026-10-13T17:30:01.204Z", "covered_until": "2026-10-13T17:30:00.000Z", "next_tick_at": "2026-10-13T17:35:00.000Z" }
```

| Field | Meaning |
| --- | --- |
| `tick_minutes` | Minutes between checks (`SCHEDULE_TICK_MINUTES`, default 5) |
| `last_tick_at` | When the last check finished, or `null` before the first |
| `covered_until` | The last minute whose schedules have been started |
| `next_tick_at` | When the next check is due, or `null` if the timer isn't set (the cron trigger sets it again within 5 minutes) |

A `last_tick_at` far behind the time means checks are failing; look in the Worker's logs for `schedule tick failed`. Site administrators only, with any token scope. How it works is in [Architecture](/docs/self-hosting/architecture#workflow-schedules).

## Server errors

When Diffinery answers a request with a 5xx status, it keeps a record of the error. The answer's JSON includes a `request_id`, which also appears in the `x-request-id` header, and an error page shows it as **Request ID**. Look the request ID up under **Settings → Server errors**, or over the API:

```bash
diffinery api GET /diffinery/admin/errors/<request id>
diffinery api GET "/diffinery/admin/errors?per_page=20"
```

Each record has the request's method, `route` (the matched route pattern), `path`, `status`, `message` and `stack`. Only the newest 500 errors are kept. Records never include request bodies, query strings or headers. Tokens that appear in a message are masked, and a path that carries a secret, such as a sign-in link, is stored as its route pattern instead. On Cloudflare, the request ID is the request's Ray ID, so the same request can also be found in Cloudflare's logs.

## Administration from the CLI

The CLI covers invites and, through `diffinery api`, any API endpoint:

```sh
curl -fsSL https://diffinery.com/install | bash
diffinery login

# Invite someone to the instance (site administrators only)
diffinery invite friend@example.com

# Invite someone to an organization as an admin
diffinery invite friend@example.com --org acme --role admin

# Email delivery status
diffinery api GET /diffinery/admin/email

# Send two sample emails to yourself (needs an admin-scoped token)
echo '{"only": ["signin", "test"]}' | diffinery api POST /diffinery/admin/emails/samples --input -

# Everyone's recent emails, with their status
diffinery api GET /diffinery/emails -f all=1 -f per_page=100
```

`diffinery api METHOD PATH` sends an authenticated request; `PATH` is relative to `/api/v3`. `-f key=value` adds a field (a query parameter for `GET`), and `--input FILE` (or `-` for standard input) sends a JSON body. The CLI also manages tokens, agents and organization secrets; see [CLI reference](/docs/reference/cli).

Approving access requests, changing account status and creating sign-in links are only available on the **People and invitations** page.

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| `403 site administrators only` | Your account isn't a site administrator. |
| `403 site admin only` from `DELETE /api/v3/diffinery/admin/linked-accounts/{id}` | Your account isn't a site administrator. |
| `404 link not found` | No GitHub link has that id. Ask the account's owner for the id from `GET /api/v3/diffinery/user/linked-accounts`. |
| "you cannot change your own status" | Ask another site administrator. |
| `422 ... site administrators can't be suspended` | Site administrators can't be suspended. |
| `422 give a reason for the suspension` | Suspending needs a reason. |
| `403 Actions are suspended ... by a site administrator` | A kill switch is on for the repository or its owner. Lift it under **Settings → Kill switches**. |
| "Hosted runners are paused on this instance" | Hosted compute is paused. Resume it under **Settings → Kill switches**, or run the job on a self-hosted runner. |
| `422 give a reason` | Kill switches need a reason. |
| "enable this account first" | Sign-in links can't be created for disabled accounts. Set the status to `active`, then create the link. |
| "enter a valid email address" | The invite form needs an address like `friend@example.com`. |
| `403 only site admins can invite people without an organization` | Instance invites from the CLI or API need a site administrator; others must pass `--org`. |
| **Sending** says "not configured" | The Worker has neither a `send_email` binding nor `SMTP_URL`, so emails are logged as skipped. See [Configuration](/docs/self-hosting/configuration) and [SMTP](/docs/self-hosting/configuration#smtp). |
| **Sending** says "SMTP_URL is set but can't be used" | Fix what it names, such as a password in the URL (it belongs in the `SMTP_PASSWORD` secret) or a missing `SMTP_PASSWORD`. Until then emails fail with `E_SMTP_CONFIG`. |
| `E_SMTP_REJECTED: SMTP AUTH: 535 ...` | The SMTP server refused the user or password. Check the user in `SMTP_URL` and the `SMTP_PASSWORD` secret. |
| `E_SMTP_REJECTED: SMTP MAIL FROM: 5...` | The SMTP user may not send from `MAIL_FROM`. Use an address the server allows. |
| `gave up after 6 attempts: SMTP ...` | The SMTP server kept answering `4xx`, or couldn't be reached in time. Check the host and port in `SMTP_URL`; port 25 is blocked on Cloudflare. |
| Emails show as `failed` | The **Recent emails** detail has Cloudflare's or the SMTP server's error. Check the sending domain's DNS records and the queue. |
| Emails show as `skipped` with "address is suppressed" | The address bounced, reported spam or was suppressed by hand. See [Bounces, complaints and the suppression list](#bounces-complaints-and-the-suppression-list). |
| `E_RECIPIENT_SUPPRESSED` | The address is on Cloudflare's own suppression list. Remove it in the Cloudflare dashboard. |
| `401 missing or bad signature` from `/-/email/events` | The `X-Diffinery-Signature` header is missing, signed with another secret, or more than 5 minutes old. |
