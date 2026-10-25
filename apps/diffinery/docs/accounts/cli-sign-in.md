---
title: Install and sign in to the CLI
description: Install the diffinery CLI with one command, then set up sign-in, git and gh with diffinery setup, through your browser or with a code on machines without one. No tokens to copy.
---

The `diffinery` command-line client installs with one command and signs in through your browser: you click **Authorize** on diffinery.com and the CLI is signed in, with no token to copy or paste. For every command, see the [CLI reference](/docs/reference/cli).

The short version, on Linux and macOS:

```sh
curl -fsSL https://diffinery.com/install | bash
diffinery setup
```

`diffinery setup` signs you in through your browser, lets git use the sign-in, signs in the GitHub CLI (`gh`) when you have it, and adds Diffinery's plugins to Claude Code when you have it ([CI status in Claude](/docs/connect/ci-status-in-claude)). The rest of this page explains each step.

## Install

On Linux and macOS:

```sh
curl -fsSL https://diffinery.com/install | bash
```

On Windows, in PowerShell:

```powershell
powershell -c "irm https://diffinery.com/install.ps1 | iex"
```

What the script does:

- Puts the CLI in `~/.diffinery` (`%USERPROFILE%\.diffinery` on Windows): the CLI itself in `lib/diffinery.mjs` and the `diffinery` command in `bin/`.
- Adds `~/.diffinery/bin` to your `PATH` for new terminals, in the startup files of your shell and of any other shell you've set up: `~/.zshrc` for zsh; `~/.bashrc` and the login file bash reads (`~/.bash_profile`, `~/.bash_login` or `~/.profile`, whichever you have; a new `~/.bash_profile` on macOS or `~/.profile` on Linux when you have none) for bash; `~/.config/fish/conf.d/diffinery.fish` for fish; `~/.profile` for other shells. Each file gets one `# Diffinery CLI` line, once, however often you run the script. On Windows, it adds the folder to your user `PATH`.
- Makes `diffinery` work right away, in the terminal you ran it in: when `~/.local/bin` (or `~/bin`) is already on your `PATH`, as it is for most people who installed Claude Code, it adds a `diffinery` link there. It never replaces a different file of that name. Without such a folder, the script prints an `export PATH=...` line to run, or open a new terminal. On Windows, the PowerShell window you ran it in is updated too.
- In a workflow job, it adds `~/.diffinery/bin` to `GITHUB_PATH`, so the job's later steps can run `diffinery`.
- Runs the CLI on your Node.js when it's version 22 or later. Otherwise it downloads the current Node.js LTS from `nodejs.org` for the CLI's own use, checks it against the SHA-256 that nodejs.org publishes, and keeps it in `~/.diffinery/node`. Your own Node.js setup isn't touched. On Alpine and other musl-based systems, install Node.js with the package manager (`apk add nodejs`) first.
- Prints the version it installed and what to run next.

| Variable | Effect |
| --- | --- |
| `DIFFINERY_INSTALL` | Install somewhere other than `~/.diffinery`. |
| `DIFFINERY_NO_MODIFY_PATH=1` | Don't change any startup file or your `PATH`, and don't add the link. |

The script downloads the CLI from the server it came from, so on your own Diffinery instance use `curl -fsSL https://<your-host>/install | bash`. You can read the script first: open `https://diffinery.com/install` (or `/install.ps1`) in a browser.

To update, run `diffinery upgrade`, or run the install command again. To uninstall, delete `~/.diffinery`, the `diffinery` link in `~/.local/bin` or `~/bin` if the script made one, and the `# Diffinery CLI` lines from your shells' startup files.

The CLI is one JavaScript file, so you can also install it by hand next to any Node.js 22 or later: download `https://diffinery.com/-/cli/diffinery.mjs` and run it with `node diffinery.mjs`.

## Set up in one go

```sh
diffinery setup
```

```text
✓ Logged in to https://diffinery.com as diffy with write access until Jan 12, 2027
✓ git will use diffinery for https://diffinery.com
✓ gh is signed in to diffinery.com

Connect Claude Code, Codex, Cursor and other AI apps: https://diffinery.com/docs/connect
```

It does three things, each explained below:

1. Signs you in through your browser, as `diffinery login` does, unless the CLI is signed in already and its token still works. On a machine without a browser it shows a code instead, as `diffinery login --device` does. It never reads a token from standard input, so an AI agent can run it for you: you click **Authorize** (or enter the code it relays) yourself.
2. Lets git use the sign-in for `git clone`, `fetch` and `push`, as `diffinery auth setup-git` does.
3. Signs in the [GitHub CLI](/docs/agents/github-cli), as `diffinery auth setup-gh` does, when `gh` is installed. Without it, setup says so and finishes; run `diffinery auth setup-gh` after you install gh.

Run it again whenever you like: it keeps a sign-in that works and changes nothing that's already set up. It takes the same `--url`, `--scope`, `--web` and `--device` options as `diffinery login`. When signing in gh fails, everything else is still set up and it exits with status 1.

## Sign in

```sh
diffinery login
```

1. The CLI opens your browser on **Authorize the Diffinery CLI** at diffinery.com. If you aren't signed in, sign in with your passkey first. If your last sign-in was more than 2 hours ago, Diffinery asks you to confirm it's you with your passkey, as it does before creating any token.
2. The page shows the computer asking (its name, operating system and CLI version) and the access it asks for. Check that it's the computer you're on, and pick the **Access**:

   | Access | Allows |
   | --- | --- |
   | **Read** | Clone, and view repositories, issues, pull requests and runs. |
   | **Write** (default) | Also push, open and merge pull requests, comment, and run workflows (up to the maintain role). |
   | **Admin** | Everything you can do, including settings, secrets and variables. |

3. Click **Authorize**. The browser says "You're signed in", and the terminal prints `✓ Logged in to https://diffinery.com as diffy with write access until Jan 12, 2027`.

Click **Cancel** instead and the CLI stops with `error: the sign-in was cancelled in the browser`.

To ask for admin access up front (for `diffinery secret set`, for example), run `diffinery login --scope admin`. The page still preselects **Write** and says the CLI asked for Admin: choose **Admin** yourself. A command that needs more access than you signed in with says which `diffinery login --scope ...` to run.

Then let Git use the same sign-in for `git clone`, `fetch` and `push` to diffinery.com:

```sh
diffinery auth setup-git
```

### On a machine without a browser

Over SSH, in a container or on any machine without a display, sign in with a code:

```sh
diffinery login --device
```

```text
Your one-time code: WDJB-MJHT
Open https://diffinery.com/login/device in a browser on any device, sign in, and enter the code.
Waiting for you to approve (Ctrl+C to cancel)…
```

Open `https://diffinery.com/login/device` on your laptop or phone, enter the code, check the details (the computer's name, and where and when the code was asked for), and click **Authorize**. When the code was asked for from another country than the one your browser is in, the page says so in red; from another network, it notes that too. The CLI finishes on its own within a few seconds. The code works for 10 minutes. The CLI uses this way by itself when it sees no display (no `DISPLAY` or `WAYLAND_DISPLAY` on Linux, or an SSH session); `--web` forces the browser way.

### Scripts and CI

For scripts and CI, use a [personal access token](/docs/accounts/tokens) instead:

```sh
export DIFFINERY_TOKEN=dfy_...          # used by every command, nothing saved
diffinery login --token dfy_...         # or save it in the config file
echo "$TOKEN" | diffinery login --with-token
```

## Your CLI sign-ins

Each sign-in gives the CLI its own token, named after the computer (for example **Diffinery CLI on diffys-laptop**). It's listed under **Settings → Access tokens** with a **CLI sign-in** badge, and Diffinery emails you about it like any new token.

- It lasts 90 days. Diffinery emails you before it expires; run `diffinery login` again to get a new one.
- `diffinery logout` revokes it on the server and removes it from the computer. Signing in again on the same computer revokes the token it replaces.
- Revoke it under **Settings → Access tokens** to sign a lost or old computer out.

The CLI saves the server URL and the token in `~/.config/diffinery/config.json` (or under `$XDG_CONFIG_HOME`), readable only by you: the folder is set to `0700` and the file to `0600` each time it is saved. `DIFFINERY_TOKEN` and `DIFFINERY_URL` override the saved values. The server URL must be `https://`, since the token goes with every request; plain `http://` works only for this computer (`localhost`, `127.0.0.1`, `[::1]`), such as a local development server, and anything else fails with `refusing http://<host>: tokens would be sent unencrypted`.

## How it stays safe

- **No secret in a link.** The browser sign-in uses a one-time code that Diffinery sends only to the CLI on your own computer (`http://127.0.0.1:<port>`), and it works only together with a secret the CLI never lets out of its process (PKCE, as in OAuth for native apps). A sign-in link someone sends you can't sign their computer in as you: the code would go to your own computer.
- **Codes are typed, never linked.** A device code is never part of a URL, so nobody can send you a link that approves their code. Only approve a code that your own terminal shows. If someone asks you to enter a code for them, don't. The page warns when the code came from another country or network, and never preselects **Admin**, whatever the CLI asked for.
- **Short-lived and single-use.** Browser codes expire after 2 minutes and device codes after 10, each works once, and Diffinery stores only their hashes. The token is created when the CLI collects it and is never shown in the browser.
- **The same rules as tokens.** Approving needs a passkey sign-in from the last 2 hours, sign-ins are in the audit log (`token.create`), and a CLI token is limited by the access you chose like any token.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `command not found: diffinery` after installing | Open a new terminal, or run the `export PATH=...` line the installer printed. Run the install command again to check: it says which startup files put `~/.diffinery/bin` on your `PATH`. |
| The browser doesn't open | Copy the link the CLI prints into a browser on the same computer, or use `diffinery login --device`. |
| "This sign-in link is incomplete" | The page was opened without the CLI's details. Run `diffinery login` again and use the page it opens. |
| "That code isn't valid or has expired" | Check the code in your terminal. Codes last 10 minutes; run `diffinery login --device` again for a new one. |
| `error: diffinery needs Node.js 22 or later` | The `node` on your `PATH` is older. Run the install command again: it installs a Node.js for the CLI. |
| `403 this token needs the admin scope` | Run `diffinery login --scope admin` and choose **Admin** on the authorize page. |
