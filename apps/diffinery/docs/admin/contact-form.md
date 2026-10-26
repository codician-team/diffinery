---
title: Contact form
description: Write to the people who run a Diffinery instance at /contact, what happens to your message and data, how the form is protected, and how site administrators read, answer, mark and delete messages.
---

Every Diffinery instance has a contact form at `/contact`, linked from the footer of every page. Anyone can use it, signed in or not, to write to the instance's site administrators: questions, help with an account or invitation, running your own Diffinery, feedback, partnerships, press, and privacy requests. A person reads every message and replies by email.

On diffinery.com, the project's own instance, this is how to reach the Diffinery team: [diffinery.com/contact](https://diffinery.com/contact).

Two things have their own, better places:

- **A security problem:** use the private [security report form](/docs/security/disclosure) at `/security/report`.
- **A bug or an idea for Diffinery itself:** open an issue on [the Diffinery repository](https://diffinery.com/codician/diffinery) or its [GitHub mirror](https://github.com/codician-team/diffinery).

## Send a message

1. Open `/contact`, or click **Contact** in the footer.
2. Fill in the form. Every field is required:

   | Field | Limit | What it's for |
   | --- | --- | --- |
   | **Name** | up to 100 characters | How the team addresses you |
   | **Email** | a valid address, up to 254 characters | Where the confirmation link and the reply go. Not shown when you're signed in: your account's address is used. |
   | **Topic** | one of A question about Diffinery, My account or invitation, Running my own Diffinery, Feedback or an idea, Partnerships and integrations, Press and media, Privacy and my data, Something else | Gets your message to the right person |
   | **Message** | 10 to 5,000 characters and at most 5 links, plain text | What you want to tell us |

   A link can choose the topic for you: `/contact?topic=press` opens the form with **Press and media** selected. The values are `question`, `account`, `self-hosting`, `feedback`, `partnership`, `press`, `privacy` and `other`.
3. If you aren't signed in, complete the "are you a person" check if one shows.
4. Click **Send message**.

**If you aren't signed in**, you see **Check your inbox**. Open the email titled "Confirm your message to the Diffinery team" and click **Confirm my message**, then press **Confirm my message** on the page that opens. You see **Your message is with the team**. The link works once, for 48 hours. A message that is never confirmed is never read, and is deleted after 7 days. The confirmation email never repeats what you typed, so nobody can use the form to send someone else words through Diffinery.

**If you're signed in**, there's nothing to confirm: you see **Message sent**, and you get a copy of your message by email ("We got your message"), with its reference.

The team replies from their own mailbox to the address you gave, or your account's.

## What is stored

| What | Kept |
| --- | --- |
| Your name, address, topic and message, and the message's state | Until a site administrator deletes it; unconfirmed messages 7 days, messages marked spam 30 days after that, handled messages 365 days after they were handled |
| Your account, when you were signed in | With the message |
| A SHA-256 hash of the confirmation link's code | Until the link is used |
| One row per submission from someone not signed in, with SHA-256 hashes of the IP address and of the address typed | One day, for the daily limits only |
| A site administrator's note on the message | With the message |

Your IP address and the address you typed are never stored in the clear for the limits, and nothing you type is written to logs. Only site administrators can read messages. To have a message deleted sooner, ask through the form (topic **Privacy and my data**). In the [data model](/docs/self-hosting/architecture), these are the `contact_messages` and `contact_attempts` tables.

## How the form is protected

| Protection | What it does |
| --- | --- |
| Cloudflare Turnstile | The "are you a person" check for people who aren't signed in, the same one as the [early access](/docs/accounts/early-access) and security report forms. A deployed instance without Turnstile keys (`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`) takes messages only from people who are signed in; on your own machine the check is skipped. |
| Honeypot and timing | A field people never see, and a signed time stamp: a form that fills the hidden field, comes back within 3 seconds, or carries a missing or forged stamp gets the usual **Check your inbox** page, and nothing is stored or sent. A form left open more than 24 hours asks you to send it again. |
| Confirmation by email | A message from someone who isn't signed in reaches the team only after its address follows the emailed link, so nobody can write in someone else's name. |
| Per-minute limit | At most 20 sign-in attempts, security reports, early access requests and contact messages a minute from one network (`RL_AUTH`, see [Rate limits](/docs/reference/rest-api#rate-limits)). |
| Daily limits | Without signing in: at most 10 submissions from one IP address, 3 emails to one address, and 300 emails from the form in total, in 24 hours. Past the network limit you see "Too many messages from your network today"; past the other two the page looks the same and nothing is stored or sent. Signed in: 20 messages a day per person. |
| Spam | While a site administrator has a message from an address marked as spam, new messages from that address are dropped without an email; the page looks the same. |
| Strict input | Lengths are capped (longer is refused, never cut), the email address is checked, the topic must be one of the list, links are limited to 5, and control and text-direction characters are removed. Messages are shown as plain text, never as HTML or Markdown. |

## For site administrators

**Settings → Contact messages** (`/settings/admin/contact`) is in the **Site administration** group. The sidebar shows how many new messages are waiting. Anyone who isn't a site administrator gets `404`.

When a message arrives (confirmed, or from someone signed in), each active site administrator gets:

- an email, "Contact: *topic* from *name*", with the whole message. Its **Reply-To** is the sender, so replying in your mail app answers them directly. It belongs to the **Organizations** group of your [notification settings](/docs/accounts/notifications), so you can turn it off there;
- one in-app notification, "New contact messages are waiting for you", which stays until it is read however many messages arrive.

The tabs filter by state, with counts:

| Tab | State | Meaning |
| --- | --- | --- |
| **New** (the default) | `new` | Waiting for someone to answer |
| **Handled** | `handled` | Answered or dealt with, by whom and when |
| **Spam** | `spam` | Marked as spam; new messages from the same address are dropped |
| **Unconfirmed** | `unconfirmed` | The address hasn't followed the link yet; you don't need to act on these |
| **All** | | Every message |

The search box finds messages whose address, name or text contains what you type. Each message shows its sender's name and address, its state, the topic, when it was sent, the start of the text, and an amber badge when the sender was signed in or an active account uses the address. Click a name to read the whole message.

- **Reply by email** opens your mail app with a reply to the sender. Diffinery doesn't send replies itself, so the conversation stays in your mailbox.
- **Mark handled** marks the message **Handled**. **Spam** marks it **Spam**. **Reopen** puts a handled or spam message back to **New** (or **Unconfirmed**, if its address never confirmed it). Nobody is emailed.
- **Note**, on a message's page, keeps a note for the other site administrators, such as who replied and what was agreed, up to 2,000 characters. The sender never sees it. Save an empty note to clear it.
- **Delete message** removes it for good, for someone who asks for their data to be removed.

Every change is in the [audit log](/docs/security/audit-log): `contact.create` and `contact.confirm` when a message is sent and confirmed, `contact.handle`, `contact.spam`, `contact.reopen`, `contact.note` and `contact.delete`. Entries name the message by its id; none holds what it said, and `contact.delete` doesn't hold the address.

### From the API

With a site administrator's token (`read` to list, `admin` to change):

| Endpoint | What it does |
| --- | --- |
| `GET /api/v3/diffinery/admin/contact` | List messages, newest first. `state`, `q`, `per_page` (up to 500) and `page` filter and page them. |
| `GET /api/v3/diffinery/admin/contact/{id}` | One message |
| `PATCH /api/v3/diffinery/admin/contact/{id}` | `{"state": "handled"}`, `{"state": "spam"}` or `{"state": "new"}` (reopen), and or `{"note": "..."}` |
| `DELETE /api/v3/diffinery/admin/contact/{id}` | Delete it (`204`) |

```bash
# New messages
curl -H "Authorization: Bearer $DIFFINERY_TOKEN" \
  "https://diffinery.com/api/v3/diffinery/admin/contact?state=new"

# Mark one handled, with a note
curl -X PATCH -H "Authorization: Bearer $DIFFINERY_TOKEN" \
  -d '{"state": "handled", "note": "Replied with the self-hosting guide."}' \
  https://diffinery.com/api/v3/diffinery/admin/contact/<id>
```

Each message has `id`, `state`, `email`, `name`, `topic`, `message`, `sender` (the login of a signed-in sender, or null), `confirmed_at`, `note`, `updated_by`, `handled_at`, `created_at`, `updated_at` and `html_url`. Everyone else gets `404`. See the [API reference](/docs/api) for every field.

## Troubleshooting

| What you see | Why, and what to do |
| --- | --- |
| No email after **Check your inbox** | Check the spam folder. The address may have had 3 emails from the form today; try again tomorrow, or sign in and send it from your account. |
| "This link doesn't work any more" | The link was already used or is older than 48 hours. If you confirmed already, your message is with the team. Otherwise write it again. |
| "This link is incomplete" | The part after `#` was cut off. Open the link from the email in full, or copy all of it. |
| "We couldn't confirm that you're a person" | The Turnstile check failed or expired. Reload the page and try again. |
| "This form was open for a long time" | The page was open more than 24 hours. Check the fields and send it again. |
| "Too many messages from your network today" | 10 messages came from your network in 24 hours. Try again tomorrow. |
| "Keep your message to 5 links or fewer" | Messages with many links look like spam. Leave some out; you can send them once we reply. |
| The form says it takes messages only from people who are signed in | The instance has no Turnstile keys. Sign in, or ask its administrators to add them (see [Turnstile](/docs/self-hosting/configuration#turnstile)). |
