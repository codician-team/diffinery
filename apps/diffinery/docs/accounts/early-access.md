---
title: Early access
description: Ask for an invitation to an invite-only Diffinery instance, what happens to your request and data, how the form is protected, and how site administrators invite, decline or delete requests.
---

While a Diffinery instance is invite-only (the default), people without an invitation can ask for one at `/early-access` on that instance. The sign-in page and the sign-up address lead there. A request never grants access by itself: a site administrator reads it and decides whether to send an [invitation](/docs/accounts/invitations).

The form is only there while sign-up is closed. On an instance with [open sign-up](/docs/accounts/passkeys-and-sign-in#open-sign-up) (`SIGNUP=open`), `/early-access` leads to the sign-up page instead.

## Request early access

1. Open `/early-access`. If you're already signed in, you go to your dashboard instead.
2. Fill in the form. Only **Work email** is required:

   | Field | Limit | What it's for |
   | --- | --- | --- |
   | **Work email** | a valid address, up to 254 characters | Where the confirmation link and, later, the invitation go |
   | **Name** | up to 100 characters | How the site administrators address you |
   | **Company or team** | up to 120 characters | Who you'd use Diffinery with |
   | **What would you use Diffinery for?** | up to 1,000 characters, plain text | What you'd move or build, so the site administrators can prioritize |
   | **Where do you host your code today?** | one of GitHub, GitLab, Bitbucket, Azure DevOps, Self-hosted, Somewhere else, Nowhere yet | Helps plan your move |

3. Complete the "are you a person" check if one shows, and click **Request early access**.
4. You see **Check your inbox**. Open the email titled "Confirm your early access request" and click **Confirm my request**, then press **Confirm my request** on the page that opens. The link works once, for 48 hours; asking again sends a new link, and only the newest one works.
5. You see **You're on the list**. Your request now waits for a site administrator.

When a site administrator invites you, you get the usual invitation email ("invited you to Diffinery"). Its link lets you pick a username and create a passkey; see [How sign-up works](/docs/accounts/invitations#how-sign-up-works). Nobody emails you if your request is declined.

### What the email says

The form always shows **Check your inbox**, whatever the address. What arrives depends on the address:

| The address | The email |
| --- | --- |
| New, or asked before but never confirmed | "Confirm your early access request", with the link. The new details replace the unconfirmed ones. |
| Already confirmed or declined | "We already have your early access request": nothing else to do |
| Already invited | "You're already invited", with the date the invitation was sent |
| Belongs to an active Diffinery account | "You already have a Diffinery account", with a link to sign in |
| Belongs to a disabled or suspended account | Nothing |

So only the person who reads that inbox learns whether the address has an account or asked before; the form itself never tells anyone. These emails never contain anything typed into the form.

### Removing your request

You can delete your request yourself at any time, whatever its state:

1. Open `/early-access/remove` (the form's privacy note links to it).
2. Enter the address of the request, complete the check if one shows, and click **Email me a removal link**.
3. Open the email titled "Remove your early access request" and click **Remove my request**, then press **Remove my request** on the page that opens. You see **Your request is removed**.

The link works once, for 24 hours. The page answers **Check your inbox** whether or not the address has a request, and only an address with one gets an email, so nobody can remove or look up someone else's request. Removal links count towards the same daily limits as requests. A site administrator can also delete a request for you.

Unconfirmed requests are deleted automatically 7 days after they were last sent.

## What is stored

| What | Kept |
| --- | --- |
| The fields you filled in and the request's state | Until a site administrator deletes the request; unconfirmed requests for 7 days |
| A SHA-256 hash of the confirmation link's code | Until the link is used or replaced |
| A SHA-256 hash of a removal link's code, when you ask for one | Until the request is removed |
| One row per form submission with SHA-256 hashes of your IP address and of the address typed | One day, for the daily limits only, even after the request is deleted |

Your IP address and the address you typed are never stored in the clear for the limits, and nothing you type is written to logs. Only site administrators can read requests. In the [data model](/docs/self-hosting/architecture), these are the `early_access` and `early_access_attempts` tables.

## How the form is protected

| Protection | What it does |
| --- | --- |
| Cloudflare Turnstile | The "are you a person" check, the same one the [security report form](/docs/security/disclosure) uses. A deployed instance without Turnstile keys (`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`) doesn't show the form; on your own machine the check is skipped. |
| Honeypot and timing | A field people never see, and a signed time stamp: a form that fills the hidden field, comes back within 3 seconds, or carries a missing or forged stamp gets the usual **Check your inbox** page and nothing is stored or sent. A form left open more than 24 hours asks you to send it again. |
| Per-minute limit | At most 20 sign-in attempts, security reports and early access requests a minute from one network (`RL_AUTH`, see [Rate limits](/docs/reference/rest-api#rate-limits)). |
| Daily limits | At most 10 submissions from one IP address, 3 emails to one address, and 500 emails from the form in total, in 24 hours. Past the network limit you see "Too many requests from your network today"; past the other two the page looks the same and no email is sent. |
| Double opt-in | A request counts only after its address follows the emailed link, so nobody can sign up someone else. |
| Strict input | Lengths are capped (longer is refused, never cut), the email address is checked, the hosting answer must be one of the list, and control and text-direction characters are removed. Everything is shown as plain text, never as HTML or Markdown. |

## For site administrators

**Settings → Early access** (`/settings/admin/early-access`) is in the **Site administration** group. The sidebar shows how many confirmed requests are waiting, **People and invitations** has a reminder while any are, and each site administrator gets one in-app notification, "New early access requests are waiting for you", which stays until it is read however many requests arrive. There are no per-request emails. Anyone who isn't a site administrator gets `404`.

The tabs filter by state, with counts:

| Tab | State | Meaning |
| --- | --- | --- |
| **Confirmed** (the default) | `confirmed` | The address confirmed; waiting for you to invite or decline |
| **Unconfirmed** | `unconfirmed` | The address hasn't followed the link yet |
| **Invited** | `invited` | Invited, by whom and when |
| **Declined** | `declined` | Declined, by whom and when |
| **All** | | Every request |

The search box finds requests whose address, name, company or use contains what you type. Each request shows its name and address, company, where they host code, when they asked, the start of what they'd use Diffinery for, and an amber **has an account** badge when an active account already uses the address. Click a name to see everything, including the full text and its reference.

- **Invite** asks you to confirm, then sends the address the instance's invitation email, exactly like **Invite someone to this instance** on [People and invitations](/docs/admin/site-administration#invites): it works once for 14 days. The request becomes **Invited**. If the address already has a pending instance invitation, that one is kept and no second email is sent. An address that already has an account has no **Invite** button. You can invite an unconfirmed request too: the invitation itself only works for someone who reads that inbox.
- **Decline** marks the request **Declined**. Nobody is emailed. **Put back** on a declined request returns it to **Confirmed** (or **Unconfirmed**, if it never was).
- **Delete request**, on a request's page, removes it for good, for someone who asks for their data to be removed. An invitation already sent stays; revoke it on **People and invitations**.

Every decision is in the [audit log](/docs/security/audit-log): `early_access.invite` (with `invite.create` when a new invitation is sent), `early_access.decline`, `early_access.restore` and `early_access.delete` (also when someone removes their own request), and `early_access.confirm` when an address confirms. Entries name the request by its id; none holds what the request said, and `early_access.delete` doesn't hold the address.

### From the API

With a site administrator's token (`read` to list, `admin` to change):

| Endpoint | What it does |
| --- | --- |
| `GET /api/v3/diffinery/admin/early-access` | List requests, newest first. `state`, `q`, `per_page` (up to 500) and `page` filter and page them. |
| `GET /api/v3/diffinery/admin/early-access/{id}` | One request |
| `POST /api/v3/diffinery/admin/early-access/{id}/invite` | Invite it, as **Invite** does |
| `PATCH /api/v3/diffinery/admin/early-access/{id}` | `{"state": "declined"}` declines it; `{"state": "confirmed"}` puts a declined request back |
| `DELETE /api/v3/diffinery/admin/early-access/{id}` | Delete it (`204`) |

```bash
# Confirmed requests waiting for a decision
curl -H "Authorization: Bearer $DIFFINERY_TOKEN" \
  "https://diffinery.com/api/v3/diffinery/admin/early-access?state=confirmed"

# Invite one
curl -X POST -H "Authorization: Bearer $DIFFINERY_TOKEN" \
  https://diffinery.com/api/v3/diffinery/admin/early-access/<id>/invite
```

Each request has `id`, `state`, `email`, `name`, `company`, `use_case`, `hosting`, `confirmed_at`, `invite_id`, `decided_by`, `decided_at`, `created_at`, `updated_at` and `html_url`. Everyone else gets `404`. See the [API reference](/docs/api) for every field.

## Troubleshooting

| What you see | Why, and what to do |
| --- | --- |
| No email after **Check your inbox** | Check the spam folder. The address may have had 3 emails from the form today, or the address belongs to a disabled account; try again tomorrow, or ask someone who uses the instance. |
| "This link doesn't work any more" | The link was already used, is older than 48 hours, or a newer one was sent. If you confirmed already, you're on the list. Otherwise request again. |
| "This link is incomplete" | The part after `#` was cut off. Open the link from the email in full, or copy all of it. |
| "This link doesn't work any more" after **Remove my request** | The removal link was already used, is older than 24 hours, or a newer one was sent. If you used it, the request is gone. |
| "We couldn't confirm that you're a person" | The Turnstile check failed or expired. Reload the page and try again. |
| "This form was open for a long time" | The page was open more than 24 hours. Check the fields and send it again. |
| "Too many requests from your network today" | 10 submissions came from your network in 24 hours. Try again tomorrow. |
