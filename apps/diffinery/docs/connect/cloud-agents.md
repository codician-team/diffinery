---
title: Cloud agent environments
description: Set up a Claude Code cloud environment, or any other agent sandbox, for a Diffinery repository by pasting three boxes from Settings → Agent setup. git, gh and the CLI then work from the first session.
---

A cloud agent runs in a sandbox that starts fresh: a Claude Code cloud environment, Codex in the cloud, or any other agent platform. **Settings → Agent setup** on a repository gives it everything it needs to work on that repository from its first session, with no manual wiring:

- a token that reaches **only that repository**,
- the domain to allow,
- a one-line setup script hosted on Diffinery,
- the environment variables, with the token filled in,
- and a **Check** that turns green once a session has set itself up and passed a self-test.

Then the agent can clone, push branches, open pull requests and use `gh` against the repository. The page is the same for every agent platform: each one asks for the same three things.

## Before you start

- On a [self-hosted Diffinery](/docs/self-hosting), everything below works the same with your instance's domain in place of `diffinery.com`: its **Agent setup** page shows the setup script and environment variables with its own URLs, and the network setting must allow its domain.

- You need write access to the repository. Admins find **Agent setup** among the repository's settings; people with write access get a **Settings** tab that opens it.
- Generating a token needs a passkey sign-in from the last 2 hours, as for any token. If yours is older, Diffinery asks you to confirm with your passkey first.

## Set up a Claude Code cloud environment

1. Open the repository on Diffinery, then **Settings → Agent setup** (`https://diffinery.com/<owner>/<repo>/settings/agent-setup`).
2. Choose **Generate agent token**. Change the label if you like, so you can tell environments apart later. The token appears once, already filled into box 4.
3. In Claude Code, open the environment selector under the message box at [claude.ai/code](https://claude.ai/code), and edit the environment (the settings icon on its row) or add a new one. The **Edit cloud environment** dialog has the three fields to fill.
4. **Network access**: choose **Custom**, put `diffinery.com` under **Allowed domains**, and keep **Also include default list of common package managers** ticked. **Full** works too. The default **Trusted** level doesn't include diffinery.com.
5. **Setup script**: paste box 3, which looks like this:

   ```sh
   curl -fsSL https://diffinery.com/<owner>/<repo>/agent-setup.sh | bash
   ```

6. **Environment variables**: paste box 4 as it is:

   ```text
   DIFFINERY_TOKEN=dfy_…
   GH_ENTERPRISE_TOKEN=dfy_…
   GH_HOST=diffinery.com
   DIFFINERY_REPO=<owner>/<repo>
   ```

7. Save, and start a session in the environment. Back on the Agent setup page, the **Check** turns green within seconds of the setup script finishing (the page updates by itself).

In the session, the repository is cloned at `/home/user/<repo>`, Claude Code has the Diffinery plugins (so Claude hears when CI on its pushed commit passes or fails), and these all work with no prompt and no path prefix:

```sh
diffinery --version
diffinery whoami
git clone https://diffinery.com/<owner>/<repo>.git
gh api user --hostname diffinery.com --jq .login
gh pr list --state all          # inside the clone
```

> [!NOTE]
> Claude Code runs the setup script once and keeps a snapshot of the machine for later sessions, for about seven days or until you change the script or the allowed domains. So a later session's clone can be behind: ask Claude to `git pull` first. A new token needs no new snapshot: the token is read from the environment each time, never from disk.

## Other agent platforms

Every agent sandbox has the same three settings under its own names:

| Box | What it is | Where it goes |
| --- | --- | --- |
| Network | `diffinery.com` | The sandbox's allowed domains or internet access setting. |
| Setup script | `curl -fsSL https://diffinery.com/<owner>/<repo>/agent-setup.sh \| bash` | A setup, install or startup command that runs before the agent starts. It needs bash, curl and git, and Node.js 22 or later (it downloads Node.js from nodejs.org when there isn't one, so allow that domain too in that case). |
| Environment variables | The lines in box 4 | The sandbox's environment variables or secrets that are passed to commands. |

On a machine you already work on, you don't need any of this: install the CLI and run `diffinery setup` ([Install and sign in to the CLI](/docs/accounts/cli-sign-in)). Workflows on Diffinery Actions get their own token automatically ([Workflow permissions](/docs/actions/workflow-permissions)).

## What the setup script does

The script is the same for everyone, with the repository's name in it, and holds no secret: [read it](https://diffinery.com/codician/diffinery/agent-setup.sh) before you use it. It runs these steps, in order:

1. Installs the `diffinery` CLI and puts it on PATH (`/usr/local/bin/diffinery` when it runs as root, as in Claude Code). It skips the download when the installed CLI is already the server's current build, so later runs take a few seconds.
2. Stops with a clear message if `DIFFINERY_TOKEN` isn't set, after setting up what it can: git is then ready to use the token as soon as it is in the environment.
3. Runs `diffinery setup --repo <owner>/<repo>`, which:
   - makes git use the token for diffinery.com (`diffinery auth setup-git`): git asks the CLI, which reads `DIFFINERY_TOKEN` from the environment each time. The token is never written to disk, so no snapshot or file holds it.
   - leaves `gh` to `GH_ENTERPRISE_TOKEN` and `GH_HOST` from the environment. Without them it signs `gh` in with `DIFFINERY_TOKEN` instead (`gh` then keeps it in its own config).
   - clones the repository unless it's there already, or fetches it when it is. It goes in `/home/user/<repo>` in a Claude Code cloud environment and in the current directory elsewhere; set `DIFFINERY_CLONE_DIR` to choose, or `DIFFINERY_NO_CLONE=1` to skip it.
   - adds Claude Code's Diffinery plugins, `diffinery` and `diffinery-ci`, so sessions in the environment load them: Claude then hears when CI on a commit it pushed passes or fails ([CI status in Claude](/docs/connect/ci-status-in-claude)). Set `DIFFINERY_NO_CLAUDE_PLUGINS=1` to skip it.
   - checks each part and prints one line per check, saying what to change when one fails.
   - reports the result to the repository's **Check**.

It is fully non-interactive, never prints the token, and is safe to run at the start of every session. It exits with 1 when the CLI can't be installed or a check fails, so a broken setup isn't kept in a snapshot and the session's setup log shows why.

## The token

Each person gets their own agent for each repository the first time they generate a token there: an agent account named after the repository, such as `zutrix-agent`. Its commits, comments and pull requests show as the agent's, acting for you.

| Setting | What it is |
| --- | --- |
| Repository | This repository only. The agent, and every token it has, gets no access to any other repository or to account or organization settings, even public ones. |
| Code | Read and write. It pushes branches; protected branches and the default branch take pull requests instead. |
| Pull requests and issues | Read and write: open, comment, review (advisory), update. |
| Workflows and logs | Read, re-run and cancel. No access to secrets or variables. |
| Merge | On by default. See below. |
| Most it can do | Write, and never more than you can do: if you lose access, so does the agent. |
| Expiry | 90 days. **Renew** gives the same token another 90 days, so nothing needs pasting again. |
| Label | Shown in the token list and in the audit log. |

### Merging

With **Can merge pull requests** on (the default), the agent may merge a pull request, or turn on auto-merge for it, once:

- a person has approved the pull request's **latest commit**: agents' own reviews never count, and a push after the approval needs a new one;
- every rule of the branch is met: required approvals, required checks, linear history, the merge queue;
- the pull request doesn't change a workflow file (`.github/workflows/` or `.diffinery/workflows/`): those always need a person to merge, because CI can't vouch for a change to itself.

Turn it off on the page and the agent can't merge into the default branch or a protected one at all; a person merges. Rules on the branch itself still apply either way, such as **Allow agents to land pull requests through auto-merge** in [Branch protection](/docs/repositories/branch-protection).

**Merge its pull requests on green** (offered under **Label** when you generate the first token, and next to **Can merge pull requests** afterwards) has Diffinery turn on auto-merge for each pull request the agent opens, so it lands by itself once the default branch's required checks pass: right away where the repository waives the approval through [Merge on green](/docs/collaboration/merge-on-green), otherwise once a person approved its latest commit. The text under the box says which applies in this repository. It needs at least one required check on the branch, and a workflow change still needs a person.

### Renew, revoke and regenerate

- **Renew** keeps a token working for 90 days from today.
- **Revoke and regenerate** stops the token at once and makes a new one, filled into box 4 for you to paste. Use it whenever a token may have leaked.
- **Revoke** stops it.
- Admins of the repository see everyone's agents for it on the page and can turn any of them off, which revokes their tokens.

Every token change is in the audit log (`agent_setup.token.create`, `.regenerate`, `.renew`, `.revoke`), and you get the usual email when a token is created.

## Keep the token safe

- Environment variables are visible to anyone who uses the environment, so treat the token as shared with them.
- Never paste the token into a chat or a screenshot. If it leaks, choose **Revoke and regenerate**.
- Claude Code's **Network secrets** keep a credential outside the session, but they don't reach setup scripts, and `gh` won't run without a token of its own, so Agent setup uses environment variables.

## When the Check fails

The page shows each failed line with what to change. The usual ones:

| Line | What to do |
| --- | --- |
| `server: can't reach diffinery.com` | Allow `diffinery.com` in the environment's network settings (Custom with diffinery.com, or Full). |
| `DIFFINERY_TOKEN: not set` | Add the Environment variables lines from the page. |
| `DIFFINERY_TOKEN: refused (revoked or expired)` | **Revoke and regenerate** (or generate a new token), then paste the new token in both places. |
| `repository: the token can't see <owner>/<repo>` | Use a token from this repository's Agent setup page: each token reaches only its own repository. |
| `GH_HOST: not set` | Add `GH_HOST=diffinery.com` to the environment variables. |
| `gh: GH_ENTERPRISE_TOKEN isn't the same token as DIFFINERY_TOKEN` | Paste the same token into both. |
| `clone: … exists and isn't a clone of …` | Move that directory, or set `DIFFINERY_CLONE_DIR`. |

Until a session runs the script with every check passing, the Check says **Not connected yet**. To check again inside a running session, run the setup script again, or `diffinery setup --repo <owner>/<repo>`.

## For AI agents reading this page

If you are an agent in a sandbox with `DIFFINERY_TOKEN` set:

- `diffinery setup --repo <owner>/<repo>` checks your setup and fixes what it can; each failed line says what the person has to change in the environment's settings. Don't try to change those settings yourself.
- If `DIFFINERY_TOKEN` isn't set, ask the person to open the repository's **Settings → Agent setup** on Diffinery and paste its boxes into your environment's settings.
- Open pull requests with `diffinery pr create --intent` or `gh pr create`, and follow CI with `diffinery pr checks --watch`. You may merge only what a person approved; see [Merging](#merging).
- The [REST API](/docs/api) reports the Check at `GET /api/v3/repos/<owner>/<repo>/diffinery/agent-setup`.
