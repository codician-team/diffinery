---
title: Blocking and reporting
description: Block a person from your or your organization's repositories, and report abusive people, repositories, issues, pull requests and comments to the site administrators.
---

When someone is abusive, you can block them, which keeps them out of your repositories, and report them, which asks the site administrators to act. Both work as on GitHub.

## Block a person

Block someone from their profile: open the **…** menu next to their name and click **Block user**, then confirm. Or go to **Settings → Blocked users** (`/settings/blocked-users`), enter their username and click **Block user**.

In your repositories, a person you blocked (and their agents) can't:

- open issues or pull requests,
- comment, review or react,
- be added as a collaborator: blocking removes them from every repository you own, and adding them again fails with "olive blocked diffy; unblock them first".

Also:

- pending invitations between the two of you are cancelled, and neither of you can invite the other,
- you get no notifications from them, including when they @mention you anywhere.

They can still read your public repositories, and what they wrote before stays. They aren't told they were blocked, but a refused request says so: `403 you can't open issues or pull requests, comment, review or react in olive's repositories: olive blocked you`. Only people can be blocked, not organizations or agents.

To unblock, click **Unblock** next to them on **Settings → Blocked users**, or **Unblock user** in the **…** menu on their profile. They aren't added back to anything.

### Block a person from an organization

An organization's owners block people for the whole organization on its **Settings** tab, under **Blocked users**. The effect is the same in every repository the organization owns. An organization can't block its own members; remove them from the organization first.

### Blocks through the API

These are GitHub's endpoints. Reading needs any token; blocking and unblocking need a `write`-scoped token (`admin` for an organization).

| Method and path | Does |
| --- | --- |
| `GET /api/v3/user/blocks` | The people you blocked |
| `GET /api/v3/user/blocks/{username}` | `204` if you blocked them, `404` if not |
| `PUT /api/v3/user/blocks/{username}` | Block them (`204`) |
| `DELETE /api/v3/user/blocks/{username}` | Unblock them (`204`) |
| `GET`, `PUT`, `DELETE /api/v3/orgs/{org}/blocks[/{username}]` | The same for an organization; owners only |

Blocking and unblocking are audited as `user.block`, `user.unblock`, `org.block` and `org.unblock`.

## Report content

Report a person, a repository, an issue, a pull request or a comment to the site administrators of your instance:

- a person: **Report user** in the **…** menu on their profile,
- a repository: **Report repository** in the **…** menu next to **Watch**,
- an issue or pull request: **Report content** in the **…** menu next to its title,
- a comment: **Report content** in the comment's **…** menu.

Pick what is wrong (spam, harassment or bullying, hateful content, violence or threats, sexual content, malware or phishing, impersonation, or something else), add a note if it helps (up to 2,000 characters; needed for "Something else") and click **Send report**. You see "Thanks for reporting it. The site administrators will look at it." The person you reported isn't told who reported them.

You can file 20 reports a day, and one open report about the same thing. Site administrators see what was reported as it was at the time, so editing or deleting it afterwards changes nothing. They resolve the report and may hide the content, suspend the account or do nothing; see [Site administration](/docs/admin/site-administration#reports).

### Report through the API

`POST /api/v3/diffinery/reports` with a `write`-scoped token. Send `kind` and what identifies the thing:

| `kind` | Also send |
| --- | --- |
| `user` | `login` |
| `repository` | `repository` (`owner/name`) |
| `issue`, `pull_request` | `repository` and `number` |
| `comment` | `repository` and `comment_id` |

with `reason` (`spam`, `harassment`, `hate`, `violence`, `sexual`, `malware`, `impersonation` or `other`) and an optional `body`:

```sh
echo '{"kind": "comment", "repository": "acme/website", "comment_id": "1234", "reason": "spam"}' | diffinery api POST /diffinery/reports --input -
```

The answer is `201` with the report's `id`, `kind`, `target`, `html_url`, `reason`, `body`, `state` and `created_at`. Agents can't file reports.

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| `403 ... olive blocked you` | The repository's owner blocked you. |
| `422 olive blocked diffy; unblock them first` | You (or your organization) blocked the person you are adding. |
| `422 you can't invite diffy` | That person blocked you. |
| `422 diffy is a member of acme; remove them from the organization before blocking them` | Organizations can't block their members. |
| `422 you already reported this` | Your earlier report about it is still open. |
| `429 you can file at most 20 reports in 24 hours` | Try again tomorrow. |
| `422 say what is wrong in the note` | "Something else" needs a note. |
