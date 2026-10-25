---
title: Git over HTTPS
description: Clone, fetch and push Diffinery repositories with Git over smart HTTP, authenticate with tokens, and what Diffinery checks and triggers on every push.
---

Diffinery serves Git over smart HTTP at `https://diffinery.com/<owner>/<repo>.git`. Any recent Git client works: clone, fetch, push, shallow clones, tags, force pushes and branch deletion behave as on GitHub. This page covers URLs, authentication, protocol support, pull request refs, push options, what happens on every push, and the limits and differences from GitHub.

There is no SSH access. Use HTTPS with a token.

## Clone URLs

| What | URL |
| --- | --- |
| Clone, fetch and push | `https://diffinery.com/acme/website.git` |
| The same without `.git` | `https://diffinery.com/acme/website` |
| Web page | `https://diffinery.com/acme/website` |
| Download a ref without Git | `https://diffinery.com/acme/website/archive/main.zip` (or `.tar.gz`) |

Both forms of the Git URL work. Archives are covered in [Source code archives](/docs/repositories/overview#source-code-archives). The repository page shows the clone URL in its **Clone** box with a **Copy** button, and the REST API returns it as `clone_url` from `GET /api/v3/repos/acme/website`.

```sh
git clone https://diffinery.com/acme/website.git
cd website
git push origin main
```

You need Git 2.26 or newer (see [Protocol versions](#protocol-versions)).

## Authentication

Git authenticates with a personal access token (`dfy_...`) used as the HTTP password. Passkeys are only for the browser.

| Operation | Public repository | Private repository |
| --- | --- | --- |
| Clone and fetch | No credentials needed | A token with at least the `read` scope, for an account with read access |
| Push | A token with the `write` (or `admin`) scope, for an account with write access | Same |

Anonymous callers can only read: they can clone and fetch public repositories, but every push needs a token. A `read`-scoped token works for clone and fetch (and for downloading [Git LFS](/docs/repositories/git-lfs) files) on any repository its account can read, and is refused for every push.

Create a token under **Settings → Access tokens** (`https://diffinery.com/settings/tokens`). See [Personal access tokens](/docs/accounts/tokens).

When Git asks for credentials:

- **Username**: anything. Diffinery ignores it. Your username, `x-token` or `git` all work.
- **Password**: the token.

Diffinery also accepts the token as the username with an empty password, and as an `Authorization: Bearer dfy_...` header.

### Let your editor handle credentials

In VS Code, Cursor, Windsurf or VSCodium, the [Diffinery extension](/docs/repositories/clone-in-your-editor) adds **Clone from Diffinery** to the clone picker and answers Git's password prompts with the account you signed in with in the browser. No token to create or paste. In IntelliJ IDEA, PyCharm, WebStorm, GoLand and the other JetBrains IDEs, the [Diffinery plugin](/docs/repositories/clone-in-jetbrains-ides) does the same from **Get from Version Control**.

### Let the CLI handle credentials

The `diffinery` CLI can act as Git's credential helper for the Diffinery host, so plain `git clone`, `fetch` and `push` use the token you logged in with. Install the CLI:

```sh
curl -fsSL https://diffinery.com/install | bash
```

Then:

```sh
diffinery login            # authorize in your browser; the token is saved to ~/.config/diffinery/config.json (mode 0600)
diffinery auth setup-git   # configure git to ask diffinery for credentials
git clone https://diffinery.com/acme/website.git
```

`diffinery auth setup-git` runs the equivalent of:

```sh
git config --global --unset-all credential.https://diffinery.com.helper
git config --global --add credential.https://diffinery.com.helper ""
git config --global --add credential.https://diffinery.com.helper "!diffinery auth git-credential"
```

The empty entry resets the helper list for this host, so a generic helper such as your OS keychain doesn't answer first. The helper answers only for the configured Diffinery host and protocol, with username `x-token` and the token from the config file or the `DIFFINERY_TOKEN` environment variable. It never stores anything (`store` and `erase` are no-ops), so revoking or replacing the token takes effect at once. The `diffinery` command must be on your `PATH` for Git to run it.

Git only asks a credential helper (or you) for a token when the server answers `401`. Diffinery answers `401 authentication required` with a `WWW-Authenticate: Basic realm="Diffinery"` challenge to every anonymous push, to public repositories too, and to every anonymous clone or fetch of a private repository. So you can clone a public repository without credentials and push to it later: Git asks the helper for the token at the first push.

`diffinery repo clone acme/website` clones with the token passed as a one-off HTTP header that is never written to `.git/config`.

### Other ways to pass the token

| Method | Example | Notes |
| --- | --- | --- |
| Git's own helper | `git config --global credential.helper store` | Git prompts once, then stores the token in plain text in `~/.git-credentials`. An OS keychain helper (`osxkeychain`, `manager`, `libsecret`) is safer. |
| Header for one command | `git -c http.extraHeader="Authorization: Bearer $DIFFINERY_TOKEN" clone https://diffinery.com/acme/website.git` | Good for CI. Nothing is saved. |
| Token in the URL | `https://x-token:dfy_...@diffinery.com/acme/website.git` | Works, but the token ends up in `.git/config` and shell history. Avoid outside throwaway jobs. |

Inside Diffinery Actions, `actions/checkout` authenticates with the job's own token automatically. Whether that token can push depends on the workflow's `permissions:` (see [Job tokens](#job-tokens)).

### Token scopes and roles

What a push or fetch may do is the lower of your role on the repository and your token's scope:

| Token scope | Acts as at most |
| --- | --- |
| `read` | read: clone and fetch only. Every push is refused. |
| `write` | maintain: push branches, move and delete tags |
| `admin` | admin: also bypass branch protection rules that let admins bypass, and bypass push protection |

A token restricted to some repositories gets `404 repository not found` for every other repository. Agents' tokens follow the same rules plus the agent guardrails (see [Agents and protected branches](#agents-and-protected-branches)).

### Job tokens

Each Actions job gets a token (`GITHUB_TOKEN`, starting with `djt_`) that works for Git and the REST API and stops working when the job completes. As on GitHub, what it may do over Git follows the workflow's `permissions:`:

| `contents` permission | Git with the job token |
| --- | --- |
| `read` | Clone and fetch the job's repository |
| `write` | Also push to it |
| `none` | Nothing on a private repository; a public one can still be cloned, as anyone can |

Without `permissions:` in the workflow, the job gets the repository's default: `contents: read` for repositories created now, write for repositories created before the setting existed. A repository admin changes the default with `PUT /api/v3/repos/{owner}/{repo}/actions/permissions/workflow`; see [Workflow permissions](/docs/actions/workflow-permissions). To push from a workflow, ask for it:

```yaml
permissions:
  contents: write
```

Pushes with a job token have these limits:

- The token acts with at most the **write** role, so branch protection always applies to it.
- It can never create, change or delete files under `.github/workflows/` or `.diffinery/workflows/`. Git rejects the ref with the reason: refusing to allow a GitHub App to create or update workflow `<path>` without `workflows` permission. Use a personal token for that.
- If the run's code came from an agent (an agent triggered the run, pushed the branch last, or opened the pull request, or the run re-runs or follows through `workflow_run` such a run), the token acts as an agent: it can't push to the default branch or a protected branch (`agents may not push to protected or default branches; open a pull request`).
- A push made with a job token starts no new `push` workflows, as on GitHub.
- The token can also clone other public repositories (for example public submodules), but no other private repository.

## Protocol versions

| Operation | Protocol | Notes |
| --- | --- | --- |
| Clone and fetch (`git-upload-pack`) | Git protocol v2 only | Git 2.26 and newer use v2 by default. |
| Push (`git-receive-pack`) | Smart HTTP v0 | Works with every Git version that supports smart HTTP. |
| Dumb HTTP | Not supported | |

If a clone or fetch arrives without protocol v2, the server answers HTTP 400 with this message (Git itself only prints `The requested URL returned error: 400`):

```text
Diffinery requires Git protocol v2 (git 2.26 or newer, or run: git config --global protocol.version 2)
```

Older Git versions that support v2 (2.18 to 2.25) work once you run `git config --global protocol.version 2`. Dumb HTTP requests get HTTP 403 with `dumb HTTP protocol is not supported; update git`.

Supported protocol v2 features: `ls-refs` (including `unborn`, so cloning an empty repository sets up the default branch) and `fetch` with `shallow` and `wait-for-done` (so `push.negotiate=true` works). Only SHA-1 repositories are supported (`object-format=sha1`). Request bodies compressed with gzip are accepted.

Push supports `report-status`, `report-status-v2`, `delete-refs`, `side-band-64k`, `quiet`, `atomic`, `ofs-delta` and `push-options`. Signed pushes (`git push --signed`) are not supported.

## Shallow clones

Shallow clones and fetches work:

```sh
git clone --depth 1 https://diffinery.com/acme/website.git
git clone --shallow-since=2026-01-01 https://diffinery.com/acme/website.git
git fetch --depth 50
git fetch --unshallow          # get the full history later
```

Differences and limits:

| Option | Behaviour |
| --- | --- |
| `--depth <n>` | Supported. |
| `--shallow-since <date>` | Supported. |
| `--unshallow` | Supported. |
| `--deepen <n>` | Treated like `--depth <n>` counted from the commits you fetch, not from your current shallow boundary. Use a larger `--depth` or `--unshallow` to get more history. |
| `--shallow-exclude <ref>` | Not supported. The fetch fails with `--shallow-exclude is not supported; use --depth or --shallow-since`. |
| `--filter=...` (partial clone, blobless or treeless clones) | Not supported. Diffinery doesn't advertise the `filter` capability, so Git warns that filtering is not recognized by the server and makes a full clone. A client that sends a filter anyway gets `partial clones (--filter) are not supported yet`. |
| `--sparse` / sparse checkout | Works on the client side, but every object is still downloaded. |

`actions/checkout` in Diffinery workflows uses `fetch-depth: 1` by default, like GitHub.

## Pull request refs

Like GitHub, Diffinery keeps two refs for each open pull request:

| Ref | Points at |
| --- | --- |
| `refs/pull/<n>/head` | The pull request's head commit. |
| `refs/pull/<n>/merge` | A test merge commit of the head into the current base branch. It is recomputed on pull request events (opened, reopened, new commits on the head branch) and removed while the pull request conflicts with its base. |

Fetch them by name:

```sh
git fetch origin pull/12/head:pr-12
git checkout pr-12

# The test merge that pull_request workflows run on
git fetch origin refs/pull/12/merge
git log -1 FETCH_HEAD
```

To fetch every pull request head, add a refspec:

```sh
git config --add remote.origin.fetch '+refs/pull/*/head:refs/remotes/origin/pr/*'
git fetch origin
```

You can't push to `refs/pull/`: Git reports `refs/pull/ is managed by Diffinery for pull requests`. These refs are hidden from push, so `git push --mirror` leaves them alone. `pull_request` workflows check out `refs/pull/<n>/merge`. See [Pull requests](/docs/collaboration/pull-requests).

## Push options

Diffinery reads one push option:

| Option | Effect |
| --- | --- |
| `allow-secrets=<reason>` | Push even though push protection found possible secrets. Only works for a person (not an agent) with the **admin** role on the repository, using a token with the `admin` scope. The reason (up to 200 characters) is shown in the push output, recorded in the audit log as `push.secret_bypassed`, and emailed to the pusher and the repository's admins. An empty reason doesn't count. |

```sh
git push -o allow-secrets="test fixture, key is revoked" origin main
```

Other push options are accepted and ignored. See [Push protection](/docs/security/push-protection).

## What happens when you push

Every push goes through these steps, in this order. If an earlier step fails, nothing after it happens.

1. **Authorization.** You must send a token: a push without credentials gets HTTP 401 (`authentication required`) with a `WWW-Authenticate` challenge, for public and private repositories alike, which makes Git ask for credentials and retry. Your account needs write access, your token the `write` or `admin` scope, and the repository must not be archived. Otherwise the server answers HTTP 403 (`write access required` when your role only allows reading, `this token needs the write scope` for a `read`-scoped token, or `repository is archived (read-only)`), or HTTP 404 if the account can't see the repository at all. Git shows these as `Authentication failed` or `The requested URL returned error: 403`.
2. **Size check.** A push larger than 100 MB (after decompression), or one whose pack unpacks to more than 512 MiB, is refused. Git shows `remote unpack failed: push exceeds 100 MB; split it into smaller pushes`, or an HTTP error if the request is stopped before it reaches Diffinery.
3. **Unpacking.** The pack is parsed and every object checked. A push over 16 MB is staged in storage as it arrives and unpacked from there in pieces, one object at a time, so its memory use depends on its largest files rather than on its size. A smaller push whose objects don't all fit in memory at once, such as a long history, is unpacked in pieces too. Either way, unpacking may hold at most 80 MiB at once; a push that needs more is refused with `pack needs more than 80 MiB of memory to unpack; split it into smaller pushes`.
4. **Push protection.** New text files are scanned for credentials such as AWS keys, GitHub and Diffinery tokens, Slack and Stripe keys, Google, Anthropic and OpenAI API keys, and private keys. If any are found, the whole push is rejected, nothing from it is stored, and the output lists each finding:

   ```text
   remote: Push blocked: possible secrets detected.
   remote:   AWS access key in blob 3f2a9c81d0
   remote: Remove the secret from your commits, or rotate it and contact an admin.
   ```

   A file that contains the text `diffinery:allow-secret` is not scanned (use it for test fixtures). Blocked pushes are audited as `push.blocked_secret`, and the pusher gets an email (for an agent, the person who owns it). See [Push protection](/docs/security/push-protection).
5. **Ref checks.** Each updated ref is checked: valid ref name, write role, not under `refs/pull/` or the merge queue's `gh-readonly-queue/` branches, objects present, tag rules, branch protection and agent guardrails (see the next sections). With `git push --atomic`, if any ref fails, none is updated (`atomic transaction failed`).
6. **Ref update.** Each ref is moved with a compare-and-swap. If someone else pushed in between, Git shows `fetch first (stale info)`.
7. **After the update**, for every ref that moved:
   - A `push` event goes to webhooks, notifications and the audit log (`git.push`, `git.force_push` or `git.delete_ref`).
   - Open pull requests whose head is the pushed branch are updated (`synchronize`), stale approvals are dismissed when the base branch's rule asks for it, and the push output links them: `Updated pull request #12: https://diffinery.com/acme/website/pull/12`.
   - For a new branch with no pull request, the output suggests one:

     ```text
     remote: Create a pull request for 'feature/login':
     remote:   https://diffinery.com/acme/website/compare/feature%2Flogin
     ```

   - Workflows in `.github/workflows/` (or `.diffinery/workflows/`) of the pushed commit whose `on: push` filters match start a run. A pull request update also starts its `pull_request` workflows. A workflow file that fails to parse creates a failed run that shows the errors. If starting workflows fails, the push still succeeds and the output shows `Workflow trigger error: ...`. See [Events that trigger workflows](/docs/actions/events).
   - A push to the default branch updates the repository's `on: schedule` workflows.
   - A merge queue whose base branch moved is rechecked. See [Merge queue](/docs/collaboration/merge-queue).

Deleting a branch or tag sends the `push` event but starts no workflows.

## Branches, force pushes and deletion

On a branch without a protection rule, anyone with write access can create, update, force push and delete it:

```sh
git push origin feature/login                 # create or update
git push --force-with-lease origin feature/login
git push origin --delete feature/login        # delete
```

The default branch can never be deleted (`cannot delete the default branch`). Change the default branch first under **Settings → General**.

A force push or a deleted branch doesn't delete the commits it leaves behind: anyone who can read the repository can still fetch them by SHA. To remove a pushed secret for good, see [Removing a secret that was pushed](/docs/security/push-protection#removing-a-secret-that-was-pushed).

On a branch that matches a [branch protection](/docs/repositories/branch-protection) rule:

| Rule | Push refused with |
| --- | --- |
| **Require a pull request before merging** | `protected branch: changes must be made through a pull request` |
| Force push without **Allow force pushes** | `protected branch: force push not allowed` |
| Deletion without **Allow deletion** | `protected branch: deletion not allowed` |
| **Require linear history** and the push adds a merge commit | `protected branch: merge commits not allowed (linear history)` |
| **Required status checks** and the new commit hasn't passed one | `protected branch: required check '<name>' has not run on <sha>; push to another branch and open a pull request` (or `has not finished`, or `ended with <conclusion>`) |

Admins (with an `admin`-scoped token) bypass these rules on push unless the rule has **Do not allow administrators to bypass these rules**.

When several rules match a branch, only one applies: the rule whose pattern is exactly the branch name (for example `main`) wins over wildcard patterns (such as `*` or `release/*`); otherwise the oldest matching rule applies. This is the same order GitHub uses. You can also create, delete and compare branches on the repository's **Branches** page (see [Browsing code](/docs/repositories/browsing-code#branches)).

## Tags

```sh
git tag -a v1.2.0 -m "Release 1.2.0"
git push origin v1.2.0        # or: git push --tags
git push origin --delete v1.2.0
```

| Action | Needs |
| --- | --- |
| Create a new tag | write |
| Move an existing tag (force push it) | maintain |
| Delete a tag | maintain |

Otherwise Git shows `only maintainers may move tags`. Branch protection rules don't apply to tags. Lightweight and annotated tags both work, and the **Tags** page lists them.

Tags and the other Diffinery features:

- **Releases.** A release points at a tag. Publishing a release (not saving a draft) for a tag that doesn't exist yet creates the tag at the release's target (the default branch unless you choose another), with the same checks as pushing it, and the tag push starts `on: push` workflows like any other. Deleting a release keeps its tag. See [Releases](/docs/collaboration/releases).
- **Archives.** Every tag can be downloaded as `https://diffinery.com/acme/website/archive/refs/tags/v1.2.0.zip` (or `.tar.gz`). The REST API returns these as `zipball_url` and `tarball_url` in `GET /api/v3/repos/acme/website/tags`.
- **Environments.** A deployment environment can allow tags by pattern. Tags pushed by an agent never match those patterns, so an agent can't start a deployment by pushing a tag. See [Environments](/docs/actions/environments).
- **Workflows.** Pushing a tag starts `on: push` workflows whose `tags` filters match. Publishing a release starts `on: release` workflows. See [Events that trigger workflows](/docs/actions/events).

## Agents and protected branches

Agent accounts push like people, with these guardrails:

- They can't push to the default branch or to any branch matching a protection rule, unless that rule has **Allow agents to push directly**. Git shows `agents may not push to protected or default branches; open a pull request`.
- They can't bypass push protection, whatever their role.
- Commits they create through the REST API or MCP (without a Git client) are stamped with a `diffinery-agent` commit header naming the agent and the person it acts for.

So an agent's normal flow is: push a branch, then open a pull request. See [Agents](/docs/agents/overview).

## Limits and differences from GitHub

| Topic | Diffinery |
| --- | --- |
| Transport | HTTPS only. No SSH and no `git://`. |
| Fetch protocol | Protocol v2 only (Git 2.26+, or `protocol.version=2`). |
| Push size | 100 MB per push. Split bigger histories (see [Troubleshooting](#troubleshooting)). |
| Large files | Use [Git LFS](/docs/repositories/git-lfs). |
| Partial clone, `--shallow-exclude` | Not supported yet. |
| `--deepen` | Behaves like `--depth`. |
| Packs sent to clients | Sent without deltas, so clones and fetches download more bytes than from GitHub. |
| Signed pushes | Not supported. Signed commits push normally. |
| `GITHUB_TOKEN` in workflows | Follows `permissions:` as on GitHub (`contents: write` to push), but new repositories default to read-only, it never changes workflow files, and code from an agent is held to the agent rules. |
| Repository rename or transfer | The old URL keeps working, as on GitHub: clones, fetches and pushes are served under the old name, and a push prints `This repository moved. Please use the new location:` with the new URL. Update remotes anyway. |
| `refs/pull/*` | Same as GitHub: fetchable, not pushable, hidden from `push --mirror`. |
| Ref names | Must start with `refs/` and follow Git's ref name rules, otherwise `invalid ref name`. |

## Troubleshooting

Git shows the server's message for errors that happen inside the Git protocol (`remote error: ...`, `remote rejected`, `remote: ...` lines). For HTTP-level errors (401, 403, 404, 400) it only shows the status code; the table gives the server's reason for each.

| What you see | Cause | Fix |
| --- | --- | --- |
| `remote: Push refused: acme has reached its storage limit of N bytes ...` and every ref `[remote rejected] ... (storage limit reached)` | The push brings new objects and the repository owner is at its [storage quota](/docs/reference/limits#account-quotas) (git objects, Git LFS objects, release assets and packages, 10 GB by default). Nothing from the push is kept. | Free space: delete releases, assets, image versions or repositories, or delete branches and then [purge unreachable objects](/docs/security/push-protection#removing-a-secret-that-was-pushed). Or ask a site administrator to raise the quota. Pushes that only delete or move refs still work. |
| `The requested URL returned error: 400` on clone or fetch | Git is older than 2.26 or protocol v2 is turned off. The server's message is `Diffinery requires Git protocol v2 (git 2.26 or newer, or run: git config --global protocol.version 2)`. | Update Git, or run `git config --global protocol.version 2`. |
| `Authentication failed` after entering a password | You entered a password instead of a token, the token expired or was revoked (`invalid, expired or revoked token`), or it isn't a `dfy_` token (`unrecognised token; create one under Settings → Access tokens`). | Create a token under **Settings → Access tokens** and use it as the password. Clear the old one from your credential helper (for example `git credential reject`, or your keychain). |
| `repository '...' not found` for a repository you can see in the browser | The token belongs to another account, is restricted to other repositories, or Git sent stale credentials. | Check with `diffinery whoami` and `diffinery token list`. |
| `The requested URL returned error: 403` on push | Your role or your token's scope only allows reading (`write access required`, `this token needs the write scope`), or the repository is archived (`repository is archived (read-only)`). | Ask an admin for write access, use a `write` token, or unarchive the repository. |
| Git asks for a username and password when you push to a public repository you cloned without credentials | Expected: anonymous pushes get `401`, so Git asks for credentials. | Enter any username and your token as the password, or set up a credential helper with `diffinery auth setup-git`. |
| `The requested URL returned error: 403` on push from a workflow | The job's token has no `contents: write` (`Resource not accessible by integration`). | Add `permissions: contents: write` to the workflow or job, or have an admin change the repository's default workflow permissions. |
| `[remote rejected] ... (refusing to allow a GitHub App to create or update workflow ...)` | A workflow's job token tried to push a change to a workflow file. | Push workflow changes with a personal or agent token instead. |
| `remote unpack failed: the push needs more memory than one push may use; split it into smaller pushes (...)` | Unpacking or storing this push ran out of the memory one push may use, even though it is under the size limits. Pushes over 16 MB are unpacked in pieces, so this now comes from a single very large file, or a delta against one. Nothing from the push is kept. | Push history in steps, oldest first, as for the 100 MB limit below. The GitHub importer does this by itself. |
| `remote unpack failed: pack needs more than 80 MiB of memory to unpack; split it into smaller pushes` | Unpacking would hold more than 80 MiB at once: files under 4 MiB inflated, plus about 768 bytes per object. Very many objects (well over 100,000) or many small files that compress well hit it before the size limits. A push unpacked in pieces (over 16 MB, or one that didn't fit) counts its caches, the files in use and about 128 bytes per object instead, so there it comes from very large files. See [Limits](/docs/reference/limits). | Push history in steps, oldest first, as for the 100 MB limit below. The GitHub importer does this by itself. |
| `remote unpack failed: push exceeds 100 MB; split it into smaller pushes` | The pack for this push is larger than 100 MB. | Push history in steps, oldest first, for example `git push origin <older-commit>:refs/heads/main`, then later commits. Move large binaries to Git LFS. |
| `remote: Push refused: tree <id>: duplicate entry '<name>'` (or another reason), `remote unpack failed: fsck error: ...` and `[remote rejected] ... (fsck failed)` | A tree or `.gitmodules` file in the push fails git's `fsck` checks: an entry that is empty, `.`, `..`, a spelling of `.git`, contains `/` or appears twice, a tree over 8 MiB, a commit or tag over 4 MiB, a `.gitmodules` that is a symbolic link, or a submodule whose name has `..` or whose `url` or `path` starts with `-`. Nothing from the push is kept. | Run `git fsck` locally to find the object, fix the tree or `.gitmodules` in a new commit (or rewrite the commit that added it), and push again. |
| `[remote rejected] ... (protected branch: required check '<name>' has not run on <sha>; ...)` | The branch requires status checks, and the commit you pushed hasn't passed them. | Push to another branch and open a pull request, or push a commit that already passed the checks. |
| `[remote rejected] ... (secret detected (push protection))` | A pushed file contains something that looks like a credential. | Remove it from every commit in the push (`git commit --amend`, or `git rebase -i`), rotate the credential, and push again. See [Push protection](/docs/security/push-protection). |
| `[remote rejected] ... (fetch first (stale info))` | The branch moved since you fetched. | `git pull --rebase` (or fetch and merge), then push. |
| `[remote rejected] ... (missing objects)` | The push referenced objects the server doesn't have, often after a shallow clone. | Fetch the full history (`git fetch --unshallow`) and push again. |
| `[remote rejected] ... (agents may not push to protected or default branches; open a pull request)` | An agent pushed to a protected or default branch. | Push to another branch and open a pull request. |
| `remote error: --shallow-exclude is not supported; use --depth or --shallow-since` | `--shallow-exclude` isn't supported. | Use `--depth` or `--shallow-since`. |
| `the receiving end does not support --signed push` | Signed pushes aren't supported. | Push without `--signed`. |
| `warning: filtering not recognized by server, ignoring` | Partial clones aren't supported. | Nothing to do; Git made a full clone. |
