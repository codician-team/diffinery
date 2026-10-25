---
title: Exporting and deleting your account
description: Download an archive of your account, with your repositories as Git bundles and the issues you wrote, or delete your account and everything it owns.
---

**Settings → Account** (`/settings/account`) is where you download a copy of your data and where you delete your account. Both ask you to have signed in within the last 2 hours; if you signed in earlier, Diffinery asks you to sign in again first and then brings you back.

## Exporting your data

Click **Start export**. Diffinery builds the archive in the background, which takes from a few seconds to a while for large repositories, and emails you when it's ready (when the instance sends email). The **Account** page shows it too: **Preparing your export…** while it is built, then **Export ready** with its size and a **Download** button. You can download it as often as you like for 7 days; after that it is deleted. Starting a new export replaces the old one. Only one export can be built at a time.

Only you can download your export. Site administrators can't. Asking for an export and downloading it are both recorded in the [audit log](/docs/security/audit-log).

### What's in the archive

The download is a tar file named `diffinery-export-<username>-<date>.tar`. Unpack it with `tar -xf`. Everything is in one folder, `diffinery-export-<username>/`:

| File | What it holds |
| --- | --- |
| `manifest.json` | The format version (`format`, now `1`), the instance's address, your username, when the archive was made, and every file in it with its size in bytes. |
| `account.json` | Your profile (username, display name, email address, when you joined, whether you are a site administrator, your profile picture's address), your settings (appearance, notification settings, watched repositories), your organizations and role in each, your agents, your access tokens and passkeys, your linked accounts and your model provider keys. |
| `repositories/<name>.json` | Each repository you own: description, visibility, default branch, topics, homepage, when it was created and last pushed, its clone URL, and the name of its bundle. |
| `repositories/<name>.bundle` | The repository's branches and tags as a Git bundle. |
| `issues/<owner>/<repository>.json` | For each repository you can see where you wrote something: the issues and pull requests you opened (`issues`, with `kind` saying which), the comments you wrote (`comments`, review comments with their file and line) and the reviews you submitted (`reviews`). |

Access tokens, passkeys and model keys are listed by name and date only. Nothing in the archive can sign in as you or use your keys. Secrets of your repositories and Actions are not exported.

To get a repository back from its bundle:

```bash
git clone diffinery-export-alice/repositories/notes.bundle notes
```

A repository with no branches or tags has no bundle, and one larger than 4 GiB isn't bundled; its JSON file has a `note` saying so, and `bundle` is `null`. Clone it from `clone_url` while your account exists. Issues, comments and reviews are exported up to 5,000 of each per repository.

## Deleting your account

The **Delete your account** box at the bottom of the **Account** page deletes your account at once. Type your username and click **Delete your account**. You are signed out and sent to the sign-in page.

You can't delete your account while:

- you are the only owner of an organization. The page names the organization. Make someone else an owner of it, or delete the organization, first (see [Organizations](/docs/accounts/organizations)).
- you are the only site administrator. Make someone else a site administrator first (see [Site administration](/docs/admin/site-administration#site-administrators)).
- a GitHub import you started, or one into your account, is still running. Wait for it to finish or cancel it.

### What goes and what stays

Deleted at once:

- every repository you own, with its history, issues, pull requests, workflow runs, secrets, webhooks and releases. Their names, and any old names that redirected to them, stop working straight away; their storage is wiped in the background.
- your container images and other packages.
- your access tokens, passkeys and every browser session.
- your agents, with their tokens.
- your organization memberships, repository collaborator access and pending invitations.
- your notifications, watches, notification settings, linked accounts, model keys, saved terminal setups, quotas and usage, sign-in links and email history.
- your profile and profile picture. `https://diffinery.com/<username>` no longer exists.

What stays:

- issues, pull requests, comments, reviews and reactions you wrote in other people's repositories. They are shown as written by **ghost**, a placeholder for people who deleted their accounts. This happens in the background, so for a few minutes after the deletion some may still show your old username.
- commits you pushed to other people's repositories. They are part of those repositories' Git history and keep the name and email address in the commit.
- the [audit log](/docs/security/audit-log), which keeps what you did, under your old username.

Diffinery emails you to say the account was deleted.

### Your username

Nobody, you included, can use your username for 90 days after the deletion: creating a person, organization or agent with it, or renaming one to it, is refused with `This username belonged to an account that was deleted recently; it can be used again from <date>` (`This name ...` when renaming). The same goes for the usernames of your agents.

### Deletion by a site administrator

Site administrators can delete anyone's account from **Site administration** (see [Deleting an account](/docs/admin/site-administration#deleting-an-account)). The same rules apply, and the person gets an email saying a site administrator deleted their account.
