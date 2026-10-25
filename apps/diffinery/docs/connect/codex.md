---
title: Codex
description: Install the Diffinery plugin for OpenAI's Codex, sign in with codex mcp login, and let Codex work with pull requests, CI and issues on Diffinery.
---

Codex, OpenAI's coding agent, reads the same Diffinery plugin as Claude Code. It adds the Diffinery MCP server, a skill that teaches Codex how Diffinery repositories work, a `pr-status` skill, and a session hook that tells Codex when it's working in a Diffinery clone.

## 1. Install the CLI

```sh
curl -fsSL https://diffinery.com/install | bash
diffinery setup
```

On Windows, in PowerShell: `irm https://diffinery.com/install.ps1 | iex`, then `diffinery setup`. It signs you in through your browser, lets git use the sign-in (as `diffinery auth setup-git` does) and signs in `gh` when you have it. The CLI gives Codex git access and the pull request commands. The plugin's marketplace lives in the public codician/diffinery repository. See [Install and sign in to the CLI](/docs/accounts/cli-sign-in).

## 2. Install the plugin

```sh
codex plugin marketplace add https://diffinery.com/codician/diffinery.git
codex plugin add diffinery@diffinery
```

`codex plugin list` now shows `diffinery@diffinery` as installed and enabled.

## 3. Sign in

```sh
codex mcp login diffinery
```

Codex opens Diffinery's consent page in your browser. Choose whom Codex acts as and its access, then choose **Connect**.

![Diffinery's consent page for Codex: "Connect Codex to Diffinery", an app published by chatgpt.com that sends you back to an app on this computer, with Act as set to the agent ada-bot and Write access selected.](/docs/images/consent-codex.webp)

Without a browser on the machine, add `--no-browser`: Codex prints the link, you open it on any device, and paste the address you land on back into the terminal.

> [!TIP]
> Act as one of your [agents](/docs/agents/overview), so Codex's commits and pull requests are marked as the agent's and wait for a person's approval.

## Check that it works

```sh
codex mcp list
```

The `diffinery` server shows **OAuth** under **Auth** (before you sign in it says **Not logged in**). Then ask Codex: "Who am I on Diffinery?"

## What the plugin adds

| Part | What it does |
| --- | --- |
| MCP server | `https://diffinery.com/mcp` with browser sign-in: every [Diffinery tool](/docs/reference/mcp-tools). |
| `diffinery` skill | The loop on Diffinery: branch, `diffinery pr create --intent`, `diffinery pr checks --watch`, `diffinery run logs`, auto-merge, and the agent rules. |
| `pr-status` skill | This branch's pull request, its checks, and the log tail of failing jobs. (Codex plugins have no slash commands, so this is a skill.) |
| Session hook | In a Diffinery clone, tells Codex the repository is hosted on Diffinery and whether the CLI is installed and signed in. Codex runs plugin hooks only after you trust them: open `/hooks` in Codex and trust it. The skills work without it. |

To update it later: `codex plugin marketplace upgrade diffinery`, then `codex plugin add diffinery@diffinery` again.

## Without the plugin

```sh
codex mcp add diffinery --url https://diffinery.com/mcp
codex mcp login diffinery
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.diffinery]
url = "https://diffinery.com/mcp"
```

## Pull requests and CI

With the CLI installed, Codex pushes a branch, opens a pull request with `diffinery pr create --intent ...`, waits with `diffinery pr checks --watch`, reads failures with `diffinery run logs <job-id>`, and lands it with `diffinery pr merge --auto --squash`. For `gh`, run `diffinery auth setup-gh` once; see [GitHub CLI](/docs/agents/github-cli).

## Headless: CI and cloud sessions

Give Codex an [agent's token](/docs/agents/overview) in `DIFFINERY_TOKEN` and point the server at it. It takes the place of the plugin's server:

```sh
codex mcp add diffinery --url https://diffinery.com/mcp --bearer-token-env-var DIFFINERY_TOKEN
```

or, for one run without changing `config.toml`:

```sh
codex -c 'mcp_servers.diffinery.url="https://diffinery.com/mcp"' \
      -c 'mcp_servers.diffinery.bearer_token_env_var="DIFFINERY_TOKEN"' exec "..."
```

`codex mcp list` then shows **Bearer token** under **Auth**. More in [Headless use](/docs/connect/how-sign-in-works#headless-use).

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `codex plugin marketplace add` fails to fetch | Run `diffinery setup` first (step 1). |
| `codex mcp list` says **Not logged in** | Run `codex mcp login diffinery`. |
| The browser says "Can't connect this app" | Run `codex mcp logout diffinery`, then `codex mcp login diffinery` again. |
| A tool says it needs the write scope | You connected with **Read**. Disconnect Codex under **Settings → Access tokens → Connected apps** and sign in again with **Write**. |
