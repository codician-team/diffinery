---
title: Notifications
description: In-app notifications and email from Diffinery: every email group and template, settings, watching, thread subscriptions, unsubscribe links, headers and the API.
---

Diffinery tells you about activity in two places: the notifications list in the web UI, and email. Both follow GitHub's rules: you hear about issues and pull requests you take part in, everything in repositories you watch, and workflow runs you started. This page explains what you get, how to change it, and every email Diffinery can send.

## The notifications list and notification settings

Two pages share the name, and they do different things:

| Page | Where | What it is for |
| --- | --- | --- |
| **Notifications** (the list) | The bell in the header, or `/notifications` | Reading what happened: your recent notifications, marking them read |
| **Notification settings** | **Settings → Notifications** (`/settings/notifications`), or the gear button on the list | Choosing what you hear about, in the list and by email; watched repositories; your recent emails |

The list only shows what your settings let through. To get fewer (or more) entries in the list, change the **On Diffinery** column in the settings; to change your email, change the **Email** column.

## The notifications list

The bell in the header opens **Notifications** (`/notifications`). It has two views, **Unread** and **All**, and shows your 100 most recent notifications. Each entry has an icon for its kind (a pull request, an issue, a comment, a failed run in red, an organization, a repository or an invitation), a title such as `diffy commented on acme/website#42: Cache build artifacts`, its kind (for example `issue comment`, `pull request review` or `run failed`) and when it happened.

- Click an entry to open what it is about; that marks it read.
- Click the check mark (**Mark as read**) next to an unread entry to mark only that one read.
- Click **Mark all as read** to clear the list.
- Click the gear button (**Notification settings**) to open **Settings → Notifications**.

Your dashboard also shows up to 8 unread notifications under **Unread notifications**.

You get an in-app notification for:

- issue and pull request activity you take part in, when **Participating → On Diffinery** is on,
- activity in repositories you watch with **All activity**, when **Watching → On Diffinery** is on,
- failed workflow runs you started, when **Actions → On Diffinery** is on,
- a run waiting for your approval to deploy to an environment where you are a [required reviewer](/docs/actions/environments#required-reviewers-and-wait-timers) ("Deployment to production in acme/website is waiting for your review"), when **Actions → On Diffinery** is on,
- someone inviting you by username to an organization or a repository (kind `invitation`, for example "<admin> invited you to acme as member"); it opens **Settings → Invitations** (see [Invitations you receive](/docs/accounts/invitations#invitations-you-receive)),
- someone giving you a repository role at once, without an invitation, because you are a member of the organization that owns the repository or already a collaborator on it (kind `repo access`, for example "<admin> gave you write access to acme/website"). This comes from **Add people**, the role menu on **Settings → Collaborators** or the API.

The last two are always sent, whatever your settings. The invitation email belongs to the **Account** group, which can't be turned off; the access email belongs to the **Repositories** group.

Your own actions never create a notification for you. Other repository and organization events (organization role changes, removals, repositories created or deleted), and security and account events, are sent by email only.

## Email groups

Every email belongs to one group. Security and account emails always send; you can turn the others off.

| Group | Emails | Can be turned off | Default |
| --- | --- | --- | --- |
| Security | New sign-in from a browser or device not seen before (and every email-recovery sign-in), passkey added or removed, access token created or about to expire, agent added, model API key added, push blocked or push protection bypassed, account disabled or enabled, and for site administrators a new security report | No | On |
| Account | Invitations, welcome, sign-in links, sign-up codes, test email, agent review's daily limit reached | No | On |
| Participating | Issues and pull requests you opened, commented on, reviewed, were assigned, were asked to review, were @mentioned in or subscribed to: new issues and pull requests, comments, reviews, pushes, merges, closes, reopens, assignments and review requests | Yes | On |
| Watching | Everything else in repositories you watch with **All activity** | Yes | On |
| Actions | Workflow runs you started (failed runs only, unless you turn off **Only failed runs**), and scheduled runs in repositories you watch | Yes | On, failures only |
| Repositories | Repositories created or deleted in your organizations (for owners and admins), your own new repositories, and repository access granted, changed or removed | Yes | On |
| Organizations | Your organization role added, changed or removed (with who did it), invitations you sent being accepted, and access requests and contact messages (for site administrators) | Yes | On |
| Morning digest | [Today](/docs/agents/today) by email, once a day at the hour you choose | Yes | Off |

## Notification settings

Open **Settings → Notifications** (`/settings/notifications`). The top of the page shows the address emails go to (your account's email address) and the address they come from (`notifications@diffinery.com`).

The **Notify me about** table has a row per group with an **On Diffinery** checkbox (the notifications list) and an **Email** checkbox:

| Row | On Diffinery | Email | Extra option |
| --- | --- | --- | --- |
| **Participating** | Yes | Yes | |
| **Watching** | Yes | Yes | |
| **Actions** | Yes | Yes | **Only failed runs** (on by default) |
| **Repositories** | No | Yes | |
| **Organizations** | No | Yes | |
| **Security and account** | No | Always on (locked) | |

Below the table:

- **Email me about my own comments and changes** (off by default). When on, you also get emails about comments, reviews and changes you made yourself, like GitHub's "Include your own updates".
- **Watch repositories I create (All activity)** (on by default). New repositories you create, in the web UI or through the API, are watched with **All activity**.

Under **Morning digest**:

- **Email me a morning digest** (off by default).
- **Hour** and **Time zone**: when it goes out, in your time zone. Until you save one, the time zone is your browser's.
- **On Saturdays and Sundays too** (off by default).

When the digest is on, the page says when the next one goes out. See [The morning digest](/docs/agents/today#the-morning-digest).

Click **Save notification settings**. You see "Notification settings saved."

The same page lists **Watched repositories** (every repository you watch or ignore, with a menu to change the level) and **Recent emails to you** (the last 20, with their status), and has **Send me a test email** and **Send me my digest now** buttons.

## Who gets notified about issues and pull requests

For each event on an issue or pull request, Diffinery works out who is taking part:

| You are notified because | Reason (`X-Diffinery-Reason`) |
| --- | --- |
| Your review was requested on the pull request | `review_requested` |
| You are assigned | `assign` |
| You were @mentioned in the text of this event (the description, comment or review) | `mention` |
| You opened the issue or pull request | `author` |
| You commented on it or reviewed it before | `comment` |
| You clicked **Subscribe** on it | `manual` |
| You watch the repository with **All activity** | `subscribed` |

When several apply, the email gives the first one in this order. Mentions use `@username` outside code blocks and inline code.

What sends:

| Event | Who hears about it |
| --- | --- |
| Issue or pull request opened | Participants (assignees, requested reviewers, people mentioned) and watchers |
| Comment | Participants and watchers |
| Review submitted | Participants and watchers |
| Closed, merged or reopened | Participants and watchers |
| New commits pushed to a pull request | Participants only |
| Someone assigned | The new assignees and other participants, not watchers |
| Review requested | The requested reviewers and other participants, not watchers |
| Title or description edited, merge queue changes | Nobody |

Rules that apply to every event:

- Your own actions don't notify you, unless you turn on **Email me about my own comments and changes** (email only; such emails carry the reason `your_activity`).
- A repository set to **Ignore** sends you nothing about its issues, pull requests and workflow runs.
- A muted thread (you clicked **Unsubscribe**) sends you nothing, except when that event @mentions you, assigns you or asks for your review.
- You must still be able to read the repository. People who lost access stop hearing about it.
- Agents don't receive email.

## Watch a repository

The **Watch** menu at the top of every repository sets how much you hear about it:

| Menu item | Level | Effect |
| --- | --- | --- |
| **Watch: participating** | Participating and @mentions | The default: only threads you take part in |
| **Watch: all activity** | All activity | Every new issue, pull request, comment, review and state change, plus scheduled workflow runs |
| **Watch: ignore** | Ignore | Nothing about this repository's issues, pull requests and workflow runs, even runs you started |

Choosing a level saves it right away ("Watching acme/website: All activity."). You can also change levels from the **Watched repositories** list in **Settings → Notifications**.

With the API (GitHub's repository subscription endpoints):

```sh
# Watch all activity
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/subscription \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"subscribed": true}'

# Ignore the repository
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/subscription \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"ignored": true}'

# Back to participating only
curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/subscription \
  -H "Authorization: Bearer dfy_..."
```

Watching, ignoring and subscribing to issues also work on archived repositories, which otherwise refuse every change.

`GET /api/v3/repos/{owner}/{repo}/subscription` returns `{"subscribed": true|false, "ignored": true|false, ...}`, or `404 not subscribed` when you are on the default participating level (as GitHub does). `PUT` with `{"subscribed": false}` also returns you to participating. Changing the level needs a `write` or `admin` token.

## Subscribe to or mute an issue or pull request

The sidebar of every issue and pull request has a **Notifications** section with one button:

- **Subscribe** follows the thread even if you aren't taking part: "Subscribed. You'll be notified about all activity."
- **Unsubscribe** mutes it: "Unsubscribed. You'll still be notified if you're @mentioned, assigned or asked to review."

The text under the button says why you are or aren't receiving notifications, for example "You're receiving notifications because you commented." or "You muted this pull request."

## Workflow run notifications

When a workflow run finishes:

| Run started by | Who is notified |
| --- | --- |
| A person (a push, a pull request, a manual dispatch) | That person |
| An agent | People watching the repository with **All activity** (the agent's owner isn't notified directly yet) |
| Diffinery itself (for example a schedule) | People watching the repository with **All activity** |

Failed and timed-out runs send an email and an in-app notification. Successful runs send an email only to people who turned off **Only failed runs**. Cancelled runs send nothing. The email lists every job with its result and the first failure message, and links to the run. Set a repository to **Ignore** to hear nothing about its runs, for example a test repository whose CI you expect to fail.

## Unsubscribe links

Every email in a group you can turn off has unsubscribe links in its footer, and `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (RFC 8058), so mail apps show their own Unsubscribe button.

| Footer link | Where | What it does |
| --- | --- | --- |
| **Mute this thread** | Issue and pull request emails | Mutes that issue or pull request, like **Unsubscribe** on the page |
| **Stop watching acme/website** | Emails you got because you watch the repository | Sets the repository back to participating |
| **Unsubscribe from emails like this** | Every email you can turn off | Turns off email for that group (for example Watching) |

The mail app's one-click button (`List-Unsubscribe`) turns off email for the group the email belongs to, the same as **Unsubscribe from emails like this**: for an issue or pull request email, that's every Participating email (or every Watching one, when you got it because you watch the repository). To mute just one thread, use **Mute this thread** in the footer instead. You can turn the group back on in notification settings.

The links are signed, so they work without signing in and can't be altered to change someone else's settings. Each link works for a year after the email was sent (links from before links carried an expiry work until October 16, 2027); after that, change what you get in notification settings. Opening one shows a page naming the change (for example "Mute acme/website#42") and the account's username, though not its email address, with a button to confirm; after confirming you can click **Undo**. Security and account emails have no unsubscribe links.

## Email headers

Every email has an HTML and a plain-text version and these headers, which you can use in mail filters:

| Header | Value |
| --- | --- |
| `From` | `notifications@diffinery.com`. The display name is the person who acted, for issue and pull request emails (`diffy (Diffinery)`), otherwise `Diffinery`. |
| `Subject` | Issue and pull request emails: `[acme/website] <title> (PR #42)` or `(Issue #37)`, with `Re: ` for every email after the first. Others start with `[acme/website]` or `[Diffinery]`. |
| `X-Diffinery-Reason` | Why you got the email (see below), like GitHub's `X-GitHub-Reason` |
| `X-Diffinery-Kind` | The email template, for example `thread`, `run` or `signin_new` (see [Every email Diffinery sends](#every-email-diffinery-sends)) |
| `X-Diffinery-Recipient` | Your username |
| `X-Diffinery-Repository` | `owner/repo` (or the organization) the email is about, when there is one |
| `List-Id` | For repository emails, `acme/website <website.acme.diffinery.com>` |
| `References`, `In-Reply-To` | All emails about one issue or pull request share `References: <acme/website/pull/42@diffinery.com>`; every email after the first also has it as `In-Reply-To`, so mail apps group them into one conversation |
| `List-Unsubscribe`, `List-Unsubscribe-Post` | On emails you can turn off |
| `Precedence: list` | On emails you can turn off |
| `Auto-Submitted: auto-generated` | On every email |

### X-Diffinery-Reason values

| Value | Meaning (as written in the email footer) |
| --- | --- |
| `author` | You opened this thread. |
| `comment` | You commented (or reviewed). |
| `mention` | You were mentioned. |
| `assign` | You were assigned. |
| `review_requested` | Your review was requested. |
| `manual` | You subscribed to this thread. |
| `subscribed` | You are watching this repository. |
| `your_activity` | Something you did on Diffinery (your own updates, a repository you created). |
| `ci_activity` | A workflow run triggered by you, or in a repository you watch. |
| `security_alert` | A security notice about your account. These can't be turned off. |
| `invitation` | Someone invited this email address or your account to Diffinery, an organization or a repository. |
| `admin` | You are an administrator (of the organization, repository or instance). |
| `account` | You have a Diffinery account (account and membership changes). |
| `signup` | Someone asked to create an account with this address through open sign-up (the sign-up code). |
| `early_access` | Someone asked for [early access](/docs/accounts/early-access) with this address. |
| `contact` | Someone sent a message through the [contact form](/docs/admin/contact-form) with this address (the confirmation link). |
| `digest` | You turned on the morning digest in your notification settings. |

## When Diffinery stops emailing you

When email to your address bounces for good (the mailbox doesn't exist or the server refuses it), or you mark an email from Diffinery as spam, Diffinery puts your address on its suppression list and sends nothing to it any more: no notifications, and no security alerts, sign-in links or account recovery emails either. A site administrator can also suppress an address by hand.

**Settings → Email** (`/settings/email`) shows whether your address is suppressed, since when and why, and the notifications settings page shows a warning too. To get email again after a bounce or a spam report:

1. Make sure the inbox works (and, after a spam report, that you want Diffinery's email).
2. On **Settings → Email**, click **Send a verification email**. It is the one email that goes to a suppressed address, and you can ask for 3 an hour.
3. Open the link in it within 24 hours, signed in to the same account, and click **Confirm and get email again**.

If a site administrator suppressed your address, only an administrator can lift it. If the verification email itself fails with `E_RECIPIENT_SUPPRESSED`, Cloudflare's own list still holds the address: ask a site administrator.

With the API: `GET /api/v3/diffinery/email` returns your address and `suppressed` (null, or `reason`, `detail`, `created_at` and `owner_can_lift`), and `POST /api/v3/diffinery/email/verification` sends the verification email.

## Every email Diffinery sends

The **Kind** column is the `X-Diffinery-Kind` header. Site administrators can preview every one of these under **Settings → Email** (see [Site administration](/docs/admin/site-administration#email)).

| Kind | Subject (example) | Group | Reason | Sent when |
| --- | --- | --- | --- | --- |
| `thread` | `[acme/website] Cache build artifacts (PR #42)` | Participating or Watching | `author`, `comment`, `mention`, `assign`, `review_requested`, `manual`, `subscribed` or `your_activity` | Activity on an issue or pull request (see the next table) |
| `run` | `[acme/website] Run failed: CI - main (3f9c2a1)` | Actions | `ci_activity` | A workflow run you started failed or timed out (or succeeded, if you asked for all runs) |
| `deployment_review_requested` | `[acme/website] Deployment to production is waiting for your review` | Actions | `review_requested` | A run waits for a required reviewer of an environment, and you are one of them (not when you started the run) |
| `signin_new` | `[Diffinery] New sign-in to your account` | Security | `security_alert` | A passkey sign-in from a browser and passkey combination not seen before, or any email-recovery sign-in |
| `passkey_added` | `[Diffinery] A passkey was added to your account` | Security | `security_alert` | You added a passkey in settings or with a sign-in link |
| `passkey_removed` | `[Diffinery] A passkey was removed from your account` | Security | `security_alert` | You removed a passkey |
| `token_created` | `[Diffinery] A personal access token was added to your account` (or `A token was created for the agent review-bot`) | Security | `security_alert` | A token was created for you or your agent, from the web UI, CLI or API |
| `token_expiring` | `[Diffinery] Your token "ci-deploy" expires on <date>` | Security | `security_alert` | About 7 days before a token expires (once per token, for tokens that last more than 8 days) |
| `agent_created` | `[Diffinery] A new agent was added: review-bot` | Security | `security_alert` | You created an agent |
| `model_key_added` | `[Diffinery] Your Anthropic API key was added to Diffinery` (or `OpenAI`, `OpenRouter`) | Security | `security_alert` | You saved a model API key for [agent tasks](/docs/agents/tasks) |
| `push_blocked` | `[acme/website] Your push was blocked: possible secrets` | Security | `security_alert` | Push protection rejected your `git push`, or a commit made in the web editor, through the REST API or over MCP (subject `Your commit was blocked`). For an agent, its owner is told. |
| `push_bypassed` | `[acme/website] Push protection was bypassed` | Security | `security_alert` | A repository admin pushed past push protection, or committed a flagged file through the commits API with `allow_secrets`; sent to that admin and the repository's admins |
| `account_status` | `[Diffinery] Your account was disabled` or `Your account was enabled` | Security | `account` | A site administrator disabled your account, or enabled it again |
| `security_report` | `[Diffinery] New security report` | Security | `admin` | Someone sent a private report through `/security/report` (sent to every active site administrator). It holds only the report's summary and a link to it in [Site administration](/docs/admin/site-administration#security-reports). |
| `early_access_confirm` | `[Diffinery] Confirm your early access request` | Account | `early_access` | Someone asked for [early access](/docs/accounts/early-access) with this address: the link that confirms the request. Sent to the address typed, not to an account. |
| `early_access_known` | `[Diffinery] We already have your early access request`, `You're already invited` or `You already have a Diffinery account` | Account | `early_access` | Someone asked for early access again with an address whose request is already confirmed, declined or invited, or that belongs to an active account |
| `early_access_remove` | `[Diffinery] Remove your early access request` | Account | `early_access` | Someone asked to remove the early access request for this address: the link that deletes it |
| `contact_confirm` | `[Diffinery] Confirm your message to the Diffinery team` | Account | `contact` | Someone who isn't signed in sent a message through the [contact form](/docs/admin/contact-form) with this address: the link that confirms it. Sent to the address typed. It never repeats what was typed. |
| `contact_received` | `[Diffinery] We got your message` | Account | `account` | You sent a message through the contact form while signed in: a copy, with its reference |
| `invite` | `@diffy invited you to join the acme organization on Diffinery` | Account | `invitation` | Someone invited your email address (organization, repository or instance), or your username (organization or repository; the button is **View invitation** and opens **Settings → Invitations**) |
| `welcome` | `Welcome to Diffinery, @diffy` | Account | `account` | You created your account from an invite or through open sign-up |
| `signup_code` | `[Diffinery] Your sign-up code` | Account | `signup` | With [open sign-up](/docs/accounts/passkeys-and-sign-in#open-sign-up), someone asked for a code for an address without an account. The code is in the message, not the subject. |
| `signup_attempt` | `[Diffinery] Someone tried to sign up with your email address` | Account | `account` | With open sign-up, someone asked for a code for your address, which already has an account (no code is sent) |
| `email_verify` | `[Diffinery] Confirm your email address to get email again` | Account | `account` | You asked for it on **Settings → Email** while your address was suppressed. It is the only email sent to a suppressed address. See [When Diffinery stops emailing you](#when-diffinery-stops-emailing-you). |
| `signin_link` | `[Diffinery] Your one-time sign-in link` | Account | `account` | A site administrator created a sign-in link for you |
| `review_limit_reached` | `[acme/website] Agent review reached its daily limit` | Account | `your_activity` | [Agent review](/docs/agents/review) on a repository whose reviews use your model key reached its daily limit (at most once a day per repository) |
| `test` | `[Diffinery] Test email` | Account | `account` | You clicked **Send me a test email** (or used the API) |
| `digest` | `[Diffinery] Today: 2 need you, 3 merged` | Morning digest | `digest` | At the hour you chose, when something needs you or happened since the last one; or when you click **Send me my digest now** |
| `invite_accepted` | `[Diffinery] @diffy accepted your invitation` | Organizations | `account` | Someone accepted an invite you created |
| `access_request` | `[Diffinery] newcomer@example.com asked for access` | Organizations | `admin` | A person waiting for an invite requested access (sent to site administrators) |
| `contact_message` | `[Diffinery] Contact: Press and media from Rivera Kim` | Organizations | `admin` | A [contact message](/docs/admin/contact-form) arrived, confirmed or from someone signed in (sent to every active site administrator). It holds the whole message, and its Reply-To is the sender, so replying answers them. |
| `org_membership` | `[Diffinery] You're now a member of acme` | Organizations | `account` | Your organization role was added, changed or removed by an owner or admin. The email names who added you ("Added by") or who changed your role ("Changed by"). |
| `repo_access` | `[acme/website] You now have write access to acme/website` | Repositories | `account` | Your collaborator role on a repository was added, changed or removed |
| `repo_created` | `[acme/website] New private repository` | Repositories | `your_activity` or `admin` | You created a repository in the web UI (not when a token or script creates it), or someone created one in an organization where you are an owner or admin |
| `repo_deleted` | `[acme/website] Repository deleted` | Repositories | `admin` | Someone else deleted a repository you own or that belongs to an organization where you are an owner or admin |
| `repo_transferred` | `[acme-labs/website] Repository transferred from acme/website` | Repositories | `admin` | Someone else transferred a repository away from or to you, or an organization where you are an owner or admin |

Issue and pull request emails (`thread`) come in these variants:

| Event | Title in the email |
| --- | --- |
| Opened | `@diffy wants to merge cache-artifacts into main` (pull request) or `@diffy opened acme/website#37` (issue); includes the description, the pull request's intent and recent commits |
| Comment | `@diffy commented on acme/website#42`, with the comment |
| Review | `@diffy approved`, `requested changes on` or `reviewed acme/website#42`, with the review and its line comments |
| Closed | `@diffy closed acme/website#37 as completed` (or `as not planned`) |
| Merged | `@diffy merged acme/website#42 into main` |
| Reopened | `@diffy reopened acme/website#37` |
| Assigned | `@diffy assigned you to acme/website#37` |
| Review requested | `@diffy requested your review on acme/website#42` |
| Pushed | `@diffy pushed 2 commits to cache-artifacts`, with the commits |

## Send a test email

Click **Send me a test email** on **Settings → Notifications**. Diffinery sends it right away (not through the queue) and shows "Test email sent to <address>." or the reason it wasn't sent, for example "The test email was skipped: ...".

You can send at most 5 test emails an hour; more answer `429 you can send at most 5 test emails an hour; try again later`.

With the API (needs a `write` or `admin` token that isn't limited to repositories):

```sh
curl -X POST https://diffinery.com/api/v3/diffinery/emails/test -H "Authorization: Bearer dfy_..."
```

```json
{ "status": "sent", "messageId": "..." }
```

`status` is `sent`, `skipped` or `failed`, with a `detail` when it wasn't sent.

## Notifications API

| Method and path | Description | Token scope |
| --- | --- | --- |
| `GET /api/v3/notifications` | Unread notifications (add `?all=true` for read ones too): `id`, `kind`, `title`, `url`, `createdAt`, `readAt` | any |
| `PUT /api/v3/notifications` | Mark all as read; returns `205` | `write` or `admin`, all repositories |
| `GET /api/v3/diffinery/notification-settings` | Your settings (see below) | any |
| `PUT /api/v3/diffinery/notification-settings` | Change settings; send only the keys to change | `write` or `admin`, all repositories |
| `GET /api/v3/repos/{owner}/{repo}/subscription` | Your watch level | any |
| `PUT /api/v3/repos/{owner}/{repo}/subscription` | Watch (`{"subscribed": true}`) or ignore (`{"ignored": true}`) | `write` or `admin` |
| `DELETE /api/v3/repos/{owner}/{repo}/subscription` | Back to participating | `write` or `admin` |
| `GET /api/v3/diffinery/emails` | Your recent emails: `kind`, `subject`, `status` (`sent`, `failed` or `skipped`), `detail`, `message_id`, `created_at`. Query: `kind`, `since` (ISO time), `per_page` (default 50, up to 500) | any |
| `POST /api/v3/diffinery/emails/test` | Send yourself a test email now | `write` or `admin`, all repositories |
| `POST /api/v3/diffinery/emails/digest` | Send yourself the morning digest now, even when it is off or has nothing in it (3 an hour) | `write` or `admin`, all repositories |
| `GET /api/v3/diffinery/email` | Your email address and whether it is suppressed | any |
| `POST /api/v3/diffinery/email/verification` | Send the email that lifts a bounce or complaint on your address | `write` or `admin`, all repositories |

The settings object, with its defaults:

```json
{
  "participating": { "web": true, "email": true },
  "watching": { "web": true, "email": true },
  "actions": { "web": true, "email": true, "failuresOnly": true },
  "repos": { "email": true },
  "orgs": { "email": true },
  "ownActivity": false,
  "autoWatch": true,
  "digest": { "email": false, "hour": 8, "timeZone": "UTC", "weekends": false }
}
```

`digest.hour` is 0 to 23 and `digest.timeZone` an IANA time zone, such as `Europe/Istanbul`; anything else returns `422`. To get the digest at 7:00 in Istanbul:

```sh
curl -X PUT https://diffinery.com/api/v3/diffinery/notification-settings \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"digest": {"email": true, "hour": 7, "timeZone": "Europe/Istanbul"}}'
```

For example, to stop watching emails and get every workflow run result:

```sh
curl -X PUT https://diffinery.com/api/v3/diffinery/notification-settings \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"watching": {"email": false}, "actions": {"failuresOnly": false}}'
```

The response is the full settings object. An unknown key returns `422 unknown setting <key>`. Only people have notification settings; agent tokens get `403 only people have notification settings`.

## Delivery

Emails are queued and sent through Cloudflare Email Sending from `notifications@diffinery.com`. A failed send is retried with increasing delays. Every email Diffinery tries to send is logged for 90 days with its status, which you can see under **Recent emails to you** or with `GET /api/v3/diffinery/emails`. A **skipped** email has a reason:

| Detail | Meaning |
| --- | --- |
| `turned off <group> emails` | You turned off that group (for example `turned off watching emails`). |
| `no email address` | Your account has no email address. |
| `account disabled` | Disabled accounts only get the email saying they were disabled or enabled. |
| `email sending is not configured (no EMAIL binding)` | The instance can't send email; ask a site administrator. |
| `address is suppressed: ...` | Email to your address bounced or was reported as spam, or a site administrator suppressed it. See [When Diffinery stops emailing you](#when-diffinery-stops-emailing-you). |

## How notifications differ from GitHub

- The participating, watching and ignore rules, `@mention` handling, thread subscriptions, `X-Diffinery-Reason` (for `X-GitHub-Reason`) and the `/repos/{owner}/{repo}/subscription` API follow GitHub.
- Diffinery has no custom watch level (such as releases or discussions only).
- Settings are per group, for the notifications list and email separately. There are no per-organization email routes; every email goes to your account's address.
- Security and account emails can't be turned off.
- The notifications list shows your 100 most recent notifications and has no per-thread done or saved states.
- Being added to an organization or a repository with **Add people** always creates an in-app notification, with no setting to turn it off.
