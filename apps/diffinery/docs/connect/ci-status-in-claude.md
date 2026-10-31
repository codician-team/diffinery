---
title: CI status in Claude
description: See a Diffinery pull request and its CI checks live in Claude Code, and have Claude told when CI on its pushed commit passes or fails, cloud sessions included.
---

Claude Code shows the pull request of the branch you're on, with its CI. On Diffinery, the `diffinery-ci` plugin adds a live view of the checks, and tells Claude when CI on a commit it pushed passes or fails, so it can fix what broke. `diffinery setup` installs it for you, with the `diffinery` plugin, in every place Claude Code runs:

| Where you run Claude Code | What you see | Set up |
| --- | --- | --- |
| Terminal, the desktop app's Code tab, VS Code, JetBrains | Claude Code's own pull request badge, a live band of the PR's checks above the prompt, a checks pane and a status line entry. Claude is told when CI on its pushed commit fails. | [Two commands, once per computer](#on-your-computer) |
| Cloud sessions on claude.ai/code, and project threads | Claude is told when CI on its pushed commit passes or fails, and says so in the thread; `/diffinery-ci` answers in text. No floating card (see [what Claude's cloud doesn't show](#what-claudes-cloud-doesnt-show)). | [The repository's Agent setup](#in-cloud-sessions-and-project-threads), which you need there anyway |
| Anywhere | Claude can follow CI itself with `diffinery pr checks --watch`, `gh pr checks` or the MCP tools | [Claude Code](/docs/connect/claude-code) |

## On your computer

1. Install the CLI and run its setup, in a terminal:

   ```sh
   curl -fsSL https://diffinery.com/install | bash
   diffinery setup
   ```

   On Windows, in PowerShell: `irm https://diffinery.com/install.ps1 | iex`, then `diffinery setup`.

2. `diffinery setup` opens your browser: choose **Authorize**. It then sets up git and `gh`, and adds both Claude Code plugins. Its output includes these lines (the `gh` one when gh is installed):

   ```text
   ✓ git will use diffinery for https://diffinery.com
   ✓ gh is signed in to diffinery.com
   ✓ Claude Code plugins: diffinery 0.1.5 and diffinery-ci 0.2.5 load in new Claude Code sessions (named in ~/.claude/settings.json)
   ```

3. Start a new Claude Code session in a clone of a Diffinery repository (or run `/reload-plugins` in an open one). On a branch with a pull request, the band appears above the prompt.

That's all. `gh` signed in to Diffinery also gives Claude Code's own footer badge (`PR #12`) and the desktop app's session chip; see [GitHub CLI and Claude Code](/docs/agents/github-cli#claude-codes-pull-request-badge). Run `diffinery setup` again at any time to bring the plugins up to date.

> [!NOTE]
> `diffinery setup` saves the plugins in `~/.claude/diffinery-plugins/` and names them in `CLAUDE_CODE_PLUGIN_DIRS`, in the `env` block of `~/.claude/settings.json`, which Claude Code reads at the start of every session in the terminal, the desktop app and the editors. It keeps everything else in that file. To skip it, run `diffinery setup --no-claude-plugins`. A plugin you already installed from the Diffinery marketplace (`claude plugin install diffinery-ci@diffinery`) is left as it is.

> [!NOTE]
> On a [self-hosted Diffinery](/docs/self-hosting), install the CLI from your instance and give `diffinery setup` its URL: `curl -fsSL https://git.example.com/install | bash`, then `diffinery setup --url https://git.example.com`. The band then reads that instance: it follows `DIFFINERY_URL`, else the plugin's **Diffinery URL** setting (which `diffinery setup` sets, and `/config` changes), else the URL `diffinery login` saved. It sends a token only to the instance the token belongs to. See [Claude Code: Self-hosted Diffinery](/docs/connect/claude-code#self-hosted-diffinery).

## In cloud sessions and project threads

A Claude Code cloud environment gets the plugins from the setup script of the repository's **Settings → Agent setup**, the same three boxes that give it git, gh and the CLI. Follow [Cloud agent environments](/docs/connect/cloud-agents#set-up-a-claude-code-cloud-environment). In short:

1. On Diffinery, open the repository's **Settings → Agent setup** and choose **Generate agent token**.
2. At [claude.ai/code](https://claude.ai/code), edit the cloud environment (the one your sessions or your project's threads use) from the environment selector under the message box.
3. **Network access**: **Custom**, with `diffinery.com` under **Allowed domains**.
4. **Setup script**: box 3, `curl -fsSL https://diffinery.com/<owner>/<repo>/agent-setup.sh | bash`.
5. **Environment variables**: box 4, as it is.
6. Save and start a session. The setup log has the line `✓ Claude Code plugins: … load in new Claude Code sessions` and ends with `✓ Ready: git, gh and the diffinery CLI work with <owner>/<repo>`, and the Agent setup page's **Check** turns green.

From then on, when Claude pushes the branch or opens its pull request, it hears how CI went once the checks finish, and tells you in the thread.

> [!NOTE]
> Claude Code keeps a snapshot of the environment after its setup script runs, for about seven days or until you change the script or the allowed domains. An environment set up before the plugins were added gets them when the snapshot is next made: to get them now, change the setup script (adding a blank line is enough) and save.

You don't need to upload anything on claude.ai, and the cloud environment needs no other variable.

## What the plugin shows

`diffinery-ci` is a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview): a plugin whose code runs inside Claude Code. It needs Claude Code 2.1.287 or later in the terminal (2.1.286 in the desktop app). It reads your token from `DIFFINERY_TOKEN`, from `diffinery login`, or from gh signed in to Diffinery, and sends it only to Diffinery.


- **A band above the prompt** for the current branch's pull request: its number and title, the checks (`✗ 1 failed · ● 3 running · ✓ 6`), and the review and merge state (approved, changes requested, merge conflict, auto-merge on). **Checks** opens the pane, **Open** opens the pull request, **Hide** folds the band away until you run `/diffinery-ci`.
- **`/diffinery-ci`** opens a pane with every check, how long it took and a link to its log, plus **Refresh**, **Fix CI** (asks Claude to read the failing logs and fix what's clear) and a switch for the note below.
- **The status line** reads `PR #12 ✓ 10/10`, `PR #12 ● 4/10` or `PR #12 ✗ 1 failed`, and a toast says when CI passes or fails.

It looks again every 15 seconds while checks run, every minute otherwise, and right after Claude pushes, switches branch or runs a `pr` command. In a folder with several clones it follows the one Claude last worked in.

## Claude hears when CI settles

When Claude pushes the branch or opens its pull request in the session, the plugin follows that exact commit. Once its checks finish, it sends Claude a note. When something failed, the note names each failed check with its log link and asks Claude to fix what's clear and say so when the failure isn't caused by the branch. This is what GitHub repositories get from Anthropic's GitHub App as auto-fix.

Where the band shows (terminal, desktop app, VS Code), Claude hears about failures only, since the band already shows a pass. Where nothing draws (cloud sessions, project threads, `claude -p`), Claude hears about passes too and says so in one line, so you see the result in the transcript either way.

| To | Do |
| --- | --- |
| Stop the notes for this session | `/diffinery-ci off` (`on` turns them back on), or the switch in the pane |
| Choose which results Claude hears | `/diffinery-ci notes auto` (the default), `failures`, `all` or `off`. It's kept for later sessions; `/diffinery-ci notes` says the current choice. |

The note comes from the plugin, and Claude reads it as one: the transcript names `diffinery-ci` as its sender.

## What Claude's cloud doesn't show

The floating pull request and CI cards in claude.ai/code cloud sessions and in projects come from Anthropic's GitHub integration, the Claude GitHub App, and GitHub's own webhooks. As of October 2026:

- **Projects** work with repositories on github.com only.
- **Cloud sessions** reach GitHub Enterprise Server instances that an Owner connected under **Organization settings → Git providers**, on Team and Enterprise plans only. Projects aren't offered on those plans.
- Claude Code reports a pull request on any other host (`code_change_published` with provider `github-enterprise`), but the cloud only draws cards for hosts its GitHub integration reaches.

So a Diffinery pull request gets no card there today, and nothing a repository or plugin does can add one. That's Anthropic's to change; the plugin covers what it can in the meantime.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The band says `not signed in to Diffinery` | Set `DIFFINERY_TOKEN`, run `diffinery login`, or `diffinery auth setup-gh`. The plugin reads the token again on its next look. |
| No band, although the branch has a pull request | The folder's remote isn't on the Diffinery the band reads (`git remote -v`; for your own instance, see the note under [On your computer](#on-your-computer)), the band is hidden (run `/diffinery-ci`), or mods are off: `/plugin` lists the mods a session loaded. |
| `/diffinery-ci` says there's no pull request | The current branch has none yet. Open one with `diffinery pr create` or `gh pr create`. |
| Claude wasn't told when CI failed | Notes follow commits the session itself pushed, and stop after `/diffinery-ci off`. A push from outside the session shows in the band only. |
| `diffinery setup` says `~/.claude/settings.json isn't valid JSON` | Claude Code's settings file has a typo. Fix it (or move it away), then run `diffinery setup` again. |
| A cloud session has no `/diffinery-ci` command | Look for the `Claude Code plugins` line at the end of the environment's setup log. No line: the snapshot is older than the plugins, so change the setup script and save (see the note in [the cloud steps](#in-cloud-sessions-and-project-threads)). A `✗` line: it says what failed, usually `diffinery.com` missing from the allowed domains. |
| You'd rather install from the marketplace | Run `claude plugin marketplace add codician-team/diffinery` (the public GitHub repository, no sign-in needed), then `claude plugin install diffinery-ci@diffinery`. `diffinery setup` then leaves that plugin to the marketplace. |
