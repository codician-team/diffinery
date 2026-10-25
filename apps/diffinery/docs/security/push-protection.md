---
title: Push protection
description: How Diffinery scans git pushes, imported history, web editor commits and API and MCP writes for leaked credentials, and how to opt out or bypass.
---

Push protection scans the files in every `git push` for credentials such as cloud keys, API tokens and private keys, and rejects the whole push if it finds one. The same scan runs on every commit made without a Git client: the web editor, `POST /repos/{owner}/{repo}/diffinery/commits`, the contents API and the MCP `commit_files` tool, and on files written through the git data API. It is always on for every repository: there is nothing to enable, and nothing from a blocked push or write is stored. History brought in by an [import from GitHub](/docs/migrate-from-github) is scanned too (see [Imported history](#imported-history)).

## How it works

When you run `git push`, Diffinery receives your packfile and checks it before it writes anything:

1. It unpacks the packfile in memory. No object is written to the repository yet.
2. It scans the new file contents (blobs) in the pack against a fixed list of credential patterns.
3. If nothing matches, it stores the objects and then applies the usual checks (permissions and [branch protection](/docs/repositories/branch-protection)) to each ref you pushed.
4. If anything matches, it rejects every ref in the push, prints what it found, records the attempt in the [audit log](/docs/security/audit-log) and emails you. Nothing from the pack is kept, so a retry starts from a clean state, like git's own object quarantine.

A push is all or nothing: if one commit on one branch contains a secret, every branch and tag in that push is rejected, not only the affected one.

## What is detected

Diffinery looks for these credential types. Each name below is exactly what appears in the push output, the audit log and the email.

| Name | What matches |
|---|---|
| `AWS access key` | `AKIA` or `ASIA` followed by 16 uppercase letters or digits |
| `GitHub token` | `ghp_`, `gho_`, `ghu_`, `ghs_` or `ghr_` followed by 36 letters or digits, or `github_pat_` followed by 82 letters, digits or underscores |
| `Diffinery token` | `dfy_` followed by at least 32 letters, digits, `_` or `-` (a Diffinery personal or agent token) |
| `Diffinery job, sandbox or model token` | `djt_`, `dst_` or `dmt_`, a repository id, `_`, and at least 32 more letters, digits, `_` or `-` (a workflow job's `GITHUB_TOKEN`, an agent sandbox's token, or an agent task's model token) |
| `Slack token` | `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-` or `xoxs-` followed by at least 10 letters, digits or `-` |
| `Stripe live key` | `sk_live_` or `rk_live_` followed by at least 20 letters or digits |
| `Google API key` | `AIza` followed by 35 letters, digits, `_` or `-` |
| `Anthropic API key` | `sk-ant-` followed by at least 20 letters, digits, `_` or `-` |
| `OpenAI API key` | `sk-` or `sk-proj-` followed by at least 40 letters, digits, `_` or `-` |
| `Private key` | A PEM header line: `-----BEGIN PRIVATE KEY-----`, or the same with `RSA`, `EC`, `OPENSSH` or `DSA` before `PRIVATE KEY`, or `-----BEGIN PGP PRIVATE KEY BLOCK-----` |

Each pattern must stand on word boundaries, so a key embedded in a longer word does not match. Some other details:

- A file is reported at most once per credential type, even if it holds several keys of that type.
- One value can match more than one type. For example, an Anthropic key also has the shape of an OpenAI key, so the output can list both `Anthropic API key` and `OpenAI API key` for the same file.
- Only live Stripe keys are detected. Test keys (`sk_test_...`) are not.
- An encrypted PEM key (`-----BEGIN ENCRYPTED PRIVATE KEY-----`) is not matched by the `Private key` pattern.
- The list is fixed. You cannot add your own patterns.

## What is scanned

| Scanned | Not scanned |
|---|---|
| Blobs (file contents) contained in the packfile of a `git push` | Trees (file names) |
| Commit and annotated tag messages, in a push, a commit made without Git (`message`) and the git data API (`POST .../git/commits`, `POST .../git/tags`) | |
| Text files of any size, in a push or a commit made without Git | |
| Every ref in the push: branches and tags | Binary files: any blob that contains a NUL byte anywhere, except UTF-16 text |
| UTF-16 text files (with a byte order mark) | |
| Files you add or change in the web editor | Files that contain the text `diffinery:allow-secret` (see [Opting a file out](#opting-a-file-out)) |
| Files in a commit made with `POST /repos/{owner}/{repo}/diffinery/commits` or the MCP `commit_files` tool | Objects the server already has, which git does not send again |
| Files written with `PUT /repos/{owner}/{repo}/contents/{path}` | Git LFS objects, which are uploaded separately from the push |
| Blobs created with `POST /repos/{owner}/{repo}/git/blobs`, and inline `content` in `POST /repos/{owner}/{repo}/git/trees` | Release assets |
| | Deleted files |

Pushes larger than 100 MB are refused before scanning with `push exceeds 100 MB; split it into smaller pushes`.

> **Important:** Push protection is a safety net, not a guarantee. It finds only the formats listed above, in text files. Never rely on it as your only defense: keep secrets in [Actions secrets](/docs/actions/secrets-and-variables) and out of your repository.

## When a push is blocked

### What you see

git prints Diffinery's messages with a `remote:` prefix, followed by a rejection for each ref:

```text
$ git push origin main
Enumerating objects: 5, done.
...
remote: Push blocked: possible secrets detected.
remote:   AWS access key in blob 3f2a9c1d0e
remote:   Private key in blob 8b41e07a5c
remote: Remove the secret from your commits, or rotate it and contact an admin.
To https://diffinery.com/acme/website.git
 ! [remote rejected] main -> main (secret detected (push protection))
error: failed to push some refs to 'https://diffinery.com/acme/website.git'
```

The format is:

- The first line is always `Push blocked: possible secrets detected.`
- Then one line per finding, `  <type> in blob <first 10 characters of the blob id>`, for at most 10 findings.
- Then `Remove the secret from your commits, or rotate it and contact an admin.`
- If you passed `-o allow-secrets=...` but are not allowed to bypass, one more line: `Only repository admins (people, not agents) can bypass push protection.`
- Every ref in the push is rejected with the reason `secret detected (push protection)`.

### What else happens

- The attempt is recorded in the [audit log](/docs/security/audit-log) as `push.blocked_secret`, with the repository as the target and the detected types and refs as detail. The secret values themselves are never recorded.
- You get an email with the subject `[acme/website] Your push was blocked: possible secrets`. If an agent pushed, the email goes to the agent's owner (for an organization's agent, to the organization's owners and admins). This is a security email and is sent whatever your notification settings are.
- Nothing from the push is stored in the repository.

### How to fix it

1. Find the file. The blob id prefix in the output identifies the file version. In your local clone, run:

   ```sh
   git rev-list --objects --all | grep '^3f2a9c1d0e'
   ```

   The line it prints ends with the path of the file. If it prints no path, the finding is in a commit or tag message: `git cat-file -t 3f2a9c1d0e` says `commit` or `tag`, and `git log -1 3f2a9c1d0e` shows the message.

2. Remove the secret from every commit you are pushing, not only the latest one. For the most recent commit:

   ```sh
   # edit the file to remove the secret, then
   git add path/to/file
   git commit --amend --no-edit
   ```

   If the secret was added in an earlier commit, rewrite those commits with an interactive rebase (`git rebase -i origin/main`) and edit each one that contains it. For a secret in a commit message, reword the commit instead (`git commit --amend` for the latest, `reword` in the rebase for older ones); for an annotated tag, delete and recreate the tag.

3. If the value was a real credential, rotate it at its provider. Treat it as exposed: it was on your machine in a commit and may have been pushed elsewhere.

4. Push again.

## Commits and writes without Git

Commits made without a Git client run the same scan before anything is written. This covers:

| Where | What is scanned |
|---|---|
| The web editor (**Commit changes** on a new or edited file) | The file's new content |
| `POST /repos/{owner}/{repo}/diffinery/commits` | Every file in `files` that isn't a delete |
| The MCP `commit_files` tool | Every file in `files` |
| `PUT /repos/{owner}/{repo}/contents/{path}` | The new file content |
| `POST /repos/{owner}/{repo}/git/blobs` | The blob |
| `POST /repos/{owner}/{repo}/git/trees` | Each tree entry given with inline `content`; entries given by `sha` refer to blobs already stored and are not scanned again |
| `POST /repos/{owner}/{repo}/git/commits` and `POST /repos/{owner}/{repo}/git/tags` | The commit or tag `message` |

The web editor, the commits API, `commit_files` and the contents API (`PUT` and `DELETE`) scan the commit message too. A match in it is reported as `(commit message)` where a file path would be.

The patterns, the binary-file rule and the `diffinery:allow-secret` opt-out are the same as for pushes. Every text file is scanned, whatever its size.

### When a commit is refused

A commit that contains a credential fails with `422` and nothing is stored. For the web editor, the commits API, the contents API and MCP, the message names the types and up to 10 paths:

```json
{
  "message": "push protection: possible secret detected (AWS access key) in config/deploy.env. Remove it, or rotate it and ask an admin.",
  "documentation_url": "https://docs.github.com/rest"
}
```

The web editor shows the same message above the form and keeps your edit, so you can remove the value and commit again. If you sent `allow_secrets` but aren't allowed to bypass, the message ends with `Only repository admins (people, not agents) can bypass push protection.`

The git data endpoints answer `422` with the shorter `push protection: possible secret detected (AWS access key)`.

Each refused write is recorded in the [audit log](/docs/security/audit-log) as `api.blocked_secret`, against the person or agent who made the request, with the repository as the target and the detected types and paths (or, for the git data API, the blob id) as detail. You get an email with the subject `[acme/website] Your commit was blocked: possible secrets` (for an agent, its owner does).

### Bypassing with the commits API

A repository admin who is a person can commit a flagged file anyway through `POST /repos/{owner}/{repo}/diffinery/commits` by giving a reason in `allow_secrets`, the API counterpart of `git push -o allow-secrets=`:

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/diffinery/commits \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{
    "branch": "main",
    "message": "Add migration test fixture",
    "allow_secrets": "revoked key kept in a migration test",
    "files": [{ "path": "test/fixtures/old-key.txt", "content": "AKIA..." }]
  }'
```

The same [requirements](#who-can-bypass) apply as for a push: the admin role on the repository, a person rather than an agent, a token with the `admin` scope, and a non-empty reason (trimmed and cut to 200 characters). A bypassed commit is recorded in the audit log as `api.secret_bypassed`, with the detected types, the paths and your reason, and the `[acme/website] Push protection was bypassed` email goes to you and to the repository's admins.

The web editor, the contents API, the git data API and MCP have no bypass. If a file really must contain the value, add the `diffinery:allow-secret` marker to it, commit it with `allow_secrets` through the commits API, or push it with git and use [the bypass](#bypassing-push-protection).

## Opting a file out

Test fixtures sometimes need values that look like real keys. To let such a file through, put the text `diffinery:allow-secret` anywhere in it, usually in a comment:

```ts
// diffinery:allow-secret (fake keys for the parser tests)
export const FIXTURE_KEY = "AKIAIOSFODNN7EXAMPL3";
```

The marker applies to the **whole file**, not to one line. If `diffinery:allow-secret` appears anywhere in a file's content, Diffinery skips every pattern for that entire file. Writing it at the end of a line, as in `key = AKIA... # diffinery:allow-secret`, works only because it puts the marker somewhere in the file; any other credential in the same file is skipped too.

The opt-out is visible in the code and goes through review like any other change, so use it only for files whose secrets are fake. It matches the exact text `diffinery:allow-secret` (case-sensitive), in any comment syntax.

An opted-out file that holds something that looks like a credential is still let through, and the audit log records it: `push.secret_marked` for a push (with the credential types, up to 50 blob ids and the refs) and `api.secret_marked` for a commit made without Git (with the types and up to 10 paths). So an admin can see who used the opt-out and on what.

## Bypassing push protection

A repository admin who is a person can push a flagged change anyway by giving a reason with a git push option (for commits made through the API, see [Bypassing with the commits API](#bypassing-with-the-commits-api)):

```sh
git push -o allow-secrets="revoked key kept in a migration test" origin main
```

`--push-option=allow-secrets=...` is the long form of the same option.

### Who can bypass

All of these must be true:

| Requirement | Detail |
|---|---|
| You have the **admin** role on the repository | The repository owner, an owner or admin of the organization that owns it, a collaborator with the admin role, or a site admin. See [Permissions](/docs/accounts/permissions). |
| You are a person | Agents can never bypass push protection, whatever their role. |
| Your token allows admin | git authenticates with a token. A `write`-scoped token caps your role at maintain, so you need a token with the `admin` scope. See [Tokens](/docs/accounts/tokens). |
| You give a reason | The value after `allow-secrets=` must not be empty or only spaces. It is trimmed and cut to 200 characters. |

If any requirement is missing, the push is blocked as usual. When you supplied the option but are not allowed to use it, the output adds `Only repository admins (people, not agents) can bypass push protection.`

### What a bypass does

- The push continues and the output shows `Push protection bypassed by diffy: <reason>`, followed by the findings (up to 10).
- The bypass skips only the secret scan. Branch protection still applies to every ref.
- It is recorded in the [audit log](/docs/security/audit-log) as `push.secret_bypassed`, with the detected types, your reason and the refs.
- An email with the subject `[acme/website] Push protection was bypassed` goes to you and to the repository's admins (the owner or the organization's owners and admins, plus admin collaborators who are people). It names who pushed, the types found, the reason and the refs. You cannot turn this email off.

Bypassing does not make a real credential safe: anyone who can read the repository can read it. Rotate real credentials even after a bypass.

## Removing a secret that was pushed

Force-pushing a branch to drop a commit doesn't delete the commit. Like git, Diffinery keeps objects no branch reaches, and anyone who can read the repository can still fetch the commit by its SHA (`GET .../git/commits/{sha}`, the commit page, or `git fetch origin <sha>`). To remove it:

1. **Rotate the credential** at its provider. Treat it as exposed: clones, forks, caches and webhook receivers may already have it.
2. Rewrite the history without it and force-push every branch and tag that contains it. Close or update any pull request whose head contains it.
3. On the repository's **Settings**, under **Danger zone**, click **Purge unreachable objects** (or `POST /api/v3/repos/{owner}/{repo}/diffinery/purge-unreachable`). It permanently deletes every commit, tree and file that no branch, tag, pull request, merge queue entry or unfinished workflow run reaches, and empties the cache of downloadable archives. It answers `{"objects": 3, "bytes": 1234}`.

Only repository admins (people, not agents) can purge, with a sign-in from the last 2 hours in the browser. It is recorded in the [audit log](/docs/security/audit-log) as `repo.purge_unreachable`. A push that was in flight while the purge ran is refused with `the repository's unreachable objects were purged during this push; push again`. Purging works for repositories of up to 300,000 objects. Review comments on commits that were purged no longer show their diff.

## Imported history

An [import from GitHub](/docs/migrate-from-github) copies a repository's Git history by pushing it into Diffinery in chunks, and push protection scans every one of those pushes like any other: each new text blob, with the same patterns and the same `diffinery:allow-secret` opt-out. Git LFS objects and release assets are not scanned, as for any push. Old history often holds credentials that were committed and removed later, so every import has a setting for what happens when push protection finds one:

| Web form choice (under **Secrets found in old history (push protection)**) | API, CLI and MCP value | What happens |
|---|---|---|
| **Import with an audited bypass** (the default) | `"options": {"secrets": "bypass"}` | The import pushes with a bypass whose reason is `Imported from GitHub <owner>/<name>`. It works only when the import may bypass (see below); otherwise the import fails. |
| **Stop the import** | `"options": {"secrets": "stop"}` | The import fails at the first push with a finding, so you can rewrite the history on GitHub first. |

### Who can import past a finding

An import pushes as the person or agent who started it, with the token scope they started it with (a browser session counts as `admin`). So the bypass follows the same rules as a `git push -o allow-secrets=...`:

- The import was started by a person, not an agent. **Agents never bypass push protection**: an import an agent starts always uses `stop`, whatever it asks for.
- That person has the admin role on the new repository: it is in their own account, or in an organization they own or administer (site admins have it everywhere).
- They started the import in the web UI or with an `admin`-scoped token. With a `write` token the bypass is refused.

When a finding stops an import, the import fails with one of these errors, and the import page and `GET /api/v3/diffinery/imports/{id}` show it:

| Error | Why |
|---|---|
| `Push protection found possible secrets in the history (<types>). The import was set to stop on secrets. Rotate them, then start a NEW import with the secrets option set to bypass (as a person who administers the target); a retry cannot change the options.` | The import used `stop`, or an agent started it. |
| `Push protection found possible secrets in the history (<types>). Only a person who administers the target can import them with an audited bypass (agents and write-scoped tokens cannot); start a new import as such a person.` | The import used `bypass`, but whoever started it can't bypass. |

The Git transfer isn't tried again after such a failure, and retrying the import doesn't help, because a retry keeps the options and runs as the same person or agent. Rotate the credentials, then start a new import (as a person who administers the target, with `bypass`), or rewrite the history on GitHub and import again. The failed import's repository stays, so delete it or give the new import another `name`.

### What an imported bypass records

- Each bypassed push writes a `push.secret_bypassed` entry to the [audit log](/docs/security/audit-log), with the person who started the import as the actor, the reason `Imported from GitHub <owner>/<name>`, and in its detail the import's id and up to 50 blob ids.
- The person who started the import and the repository's admins get the `[acme/website] Push protection was bypassed` email.
- The import's summary lists every finding with its type, the file path when the import agent saw one, and the blob id: on the import page under **Possible secrets in history (rotate these)**, and as `summary.findings` in the API. Rotate these credentials. They are readable by anyone who can read the repository, and were already readable on GitHub.
- A push that push protection blocks during an import is recorded as `push.blocked_secret`, and the person who started the import (or the agent's owner) gets the `Your push was blocked: possible secrets` email.

## Differences from GitHub push protection

Diffinery's push protection follows the same idea as GitHub's: scan at push time, block before anything is stored, and allow an audited bypass. The differences:

| | GitHub | Diffinery |
|---|---|---|
| Patterns | A large catalog of provider patterns, plus custom patterns | The nine types listed above; no custom patterns |
| Enabling | A repository or organization setting | Always on for every repository; cannot be turned off |
| Bypass | A link in the push output where you pick a reason, then push again | `git push -o allow-secrets=<reason>` in the same push, or `allow_secrets` on `POST /repos/{owner}/{repo}/diffinery/commits`; repository admins who are people only |
| Excluding files | Paths in `.github/secret_scanning.yml` | A `diffinery:allow-secret` marker inside each file |
| Notification | Secret scanning alerts in the repository | Audit log entries and email to the pusher (and to admins on a bypass) |
| Existing history | Secret scanning can also scan existing content | Only new blobs in each push, and each file written through the web editor, the commits, contents and git data APIs and MCP, are scanned. History imported from GitHub is scanned as it is pushed in. |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `secret detected (push protection)` on every ref | At least one file in the push matched. Read the `remote:` lines above it for the type and blob, then follow [How to fix it](#how-to-fix-it). |
| The push is still blocked after you deleted the file in a new commit | The secret is still in an earlier commit you are pushing. Rewrite the commit that added it instead of adding a commit on top. |
| `Only repository admins (people, not agents) can bypass push protection.` | You used `-o allow-secrets=...` without being allowed. Check your role, that you are not using an agent's token, and that your token has the `admin` scope. |
| `-o allow-secrets=` seems to be ignored | The reason is empty. Give a non-empty reason, for example `-o allow-secrets="test fixture"`. |
| A real key was not caught | It is not one of the formats above, it is in a binary file, or the file contains `diffinery:allow-secret`. Rotate the key and remove it. |
| `push protection: possible secret detected (...) in (commit message)` (422) | The commit message, not a file, holds what looks like a credential. Change the message and commit again. |
| `push protection: possible secret detected (...)` (422) from the API, MCP or the web editor | A file you committed or wrote matched. Remove the value, or mark a test fixture with `diffinery:allow-secret`. A repository admin who is a person can commit it anyway with `allow_secrets` on `POST /repos/{owner}/{repo}/diffinery/commits`; the other endpoints have no bypass. |
| `... Only repository admins (people, not agents) can bypass push protection.` (422) from the commits API | You sent `allow_secrets` without being allowed. Check your role, that you are not using an agent's token, and that your token has the `admin` scope. |
| An import from GitHub failed with `Push protection found possible secrets in the history (...)` | The source's history contains credentials and the import couldn't bypass. See [Imported history](#imported-history). |
| `push exceeds 100 MB; split it into smaller pushes` | The pack is over the push size limit. Push fewer commits at a time, or move large files to [Git LFS](/docs/repositories/git-lfs). |
