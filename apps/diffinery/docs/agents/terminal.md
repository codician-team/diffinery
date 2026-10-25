---
title: Terminals
description: A shell in your browser with the repository checked out, where Claude Code or Codex runs on your own subscription, and that can take agent tasks.
---

A **terminal** is a sandbox with a repository checked out, in your browser. You type into a real shell, and you can start Claude Code or Codex there and sign in with your own Claude or ChatGPT plan, instead of an API key. Whatever you push from it is pushed as one of your agents, so its pull requests need a person's approval like any agent's. Once you're signed in, you can also [give it a task](#give-it-a-task): Diffinery runs the goal with that sign-in, as an [agent task](/docs/agents/tasks), and opens a pull request.

Terminals are optional. Nothing changes for a repository until someone opens one.

## Before you start

You need:

1. **Write access** to the repository.
2. **An agent** you manage, with write access to the repository, as for [tasks](/docs/agents/tasks#before-you-start).
3. **A browser session.** Terminals open only from a signed-in browser. Tokens, the REST API and MCP can't open one or connect to one.

In an organization's repository, its [agent policy](/docs/agents/organizations#other-policies) can turn terminals off, or stop them from running agent tasks.

## Open a terminal

1. Open the repository's **Project** tab and click **Terminals** (the **Agent tasks** page has the same button), or go to `/<owner>/<repo>/terminals`.
2. Pick the **agent** and the **branch**. Tick **Will run agent tasks** if you'll [give it tasks](#give-it-a-task). Without it, the terminal is only a shell and never runs one.
3. The first time, tick the notice: you use Claude Code and Codex with your own Anthropic or OpenAI account, under that provider's terms, and usage is billed to your account. Diffinery records when you accepted it and which version of the notice it was. When the notice changes, you're asked again. It also says what a task in your terminal can reach, and what that leaves exposed (see [What a task can reach](#what-a-task-can-reach)).
4. Click **Open a terminal**.

The page shows **Starting** while the sandbox starts, then the terminal. Reloading the page, or opening it in another tab, connects to the same shell and redraws its recent output. Only one tab is connected at a time: the newest one wins, and the older tab says so.

## Signing in

The toolbar has buttons that type a command for you:

| Button | What it runs |
| --- | --- |
| **Start Claude Code** | Installs Claude Code at the version Diffinery pins for [tasks](/docs/agents/tasks#runtimes) if it isn't installed, then starts it. Type `/login`, choose your Claude subscription, open the link it shows, sign in with Anthropic and paste the code back. You can use an API key instead: `export ANTHROPIC_API_KEY=…` before starting it. |
| **Start Codex** | Installs Codex the same way, runs `codex login --device-auth` if you aren't signed in, then starts it. Open the link it shows, sign in with OpenAI and enter the code. A ChatGPT workspace admin may have to allow device codes. Offered on **private repositories only**, because OpenAI allows signing in with a ChatGPT plan only there; on a public repository you can still use an OpenAI API key. |

The sign-in happens in the provider's own flow and stays in that sandbox. Diffinery never sees or keeps it, and it's gone when the terminal ends. The providers' terms: [Anthropic's Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Claude Code's legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) and [OpenAI's Terms of Use](https://openai.com/policies/terms-of-use).

## Give it a task

A terminal you open with **Will run agent tasks** can run [agent tasks](/docs/agents/tasks) with the Claude Code or Codex you signed in to there, on your own subscription, with no API key. A terminal opened without it never runs one; open another to give tasks.

- **Start one from the terminal.** Under the terminal, **Give it a task** takes a goal and **Runs with** Claude Code or Codex (Codex on private repositories only). Click **Run with my subscription**. The task's page opens and shows the transcript as it runs.
- **Run a task again in it.** On a task you started, with the same agent as an open terminal of yours that runs tasks, **Run in my terminal** runs it again there, and **Send to my terminal** sends your follow-up there.

What happens:

| Step | What Diffinery does |
| --- | --- |
| Check | Checks again, on each click, that the terminal is yours, open for tasks and acting as the task's agent, that you accepted the notice, and that you and the agent may still write to the repository. |
| Clone | Gives the task a clone of its own of the task's branch (or the terminal's branch, for a new task), beside your checkout. Your checkout and anything you're doing in it are left alone. |
| Run | Runs the CLI headless with the goal, in a jail (below), with no model key or token: it signs itself in with the account you signed in to in the terminal. If the CLI isn't installed yet, Diffinery installs the pinned version first, outside the repository. |
| Push | Commits what the agent left, in a jail with no network, and takes the new commits out as a git bundle. Your checkout's credential then pushes them to the task's branch as the agent, and Diffinery opens a pull request, as for any task. The task's clone is then removed. |

Only your own click starts a run in your terminal. Nothing else does: not a coordinator, a schedule, a retry, [Best of N](/docs/agents/tasks#best-of-n) or a failing check. A task whose last run was in a terminal doesn't start a fix run when its checks fail; run it again yourself. A terminal runs one task at a time, it counts as attached while it does (so it doesn't end for being idle), and ending the terminal stops the task. Tasks that plan first or have more than one attempt run in sandboxes of their own.

The task's transcript is kept, as for any task: it is the CLI's output for that run, not what you type in the terminal. Its **Usage** shows the tokens the CLI reported, and Claude Code's cost at API prices, which your subscription covers. See [Usage and cost](/docs/agents/tasks#usage-and-cost).

### What a task can reach

The agent runs under [bubblewrap](https://github.com/containers/bubblewrap), inside your terminal's sandbox. Diffinery never sees your sign-in or the agent's traffic: the jail is in the sandbox, not in Diffinery.

| In the jail | |
| --- | --- |
| Files | The task's clone (read and write), your checkout's git objects (read only), and copies of the CLI's own sign-in and settings (`~/.claude/.credentials.json` and `~/.claude.json`, or `~/.codex/auth.json` and `~/.codex/config.toml`). The copies are never written back, so nothing the agent writes there reaches your terminal. If the CLI refreshes its sign-in during a task and the provider retires the old refresh token, the terminal's CLI may ask you to sign in again. Nothing else of your home directory, your checkout or its git config (which holds the sandbox's git credential), or `/tmp`. The rest of the system is read only. |
| Processes | Its own: it can't see or signal your shell or anything else in the sandbox. No capabilities. |
| Network | None of its own. Its only way out is a proxy outside the jail (set as `HTTPS_PROXY`) that connects only to the hosts below, by name, on port 443, and only when the connection's TLS handshake asks for that same host (some of them share addresses with every other site on their CDN). The proxy doesn't decrypt anything. |
| Environment | Only what the CLI needs: no sandbox tokens. Web search and fetch are off, and Claude Code is told not to read or edit `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.config` or the checkout's git config. |

The hosts:

| For | Hosts |
| --- | --- |
| Claude Code | `api.anthropic.com`, `console.anthropic.com`, `platform.claude.com` |
| Codex on a ChatGPT plan | `chatgpt.com`, `auth.openai.com` |
| npm and Yarn | `registry.npmjs.org`, `registry.yarnpkg.com` |
| PyPI | `pypi.org`, `files.pythonhosted.org` |
| Cargo | `index.crates.io`, `static.crates.io` |
| RubyGems | `rubygems.org`, `index.rubygems.org` |
| Maven Central | `repo1.maven.org`, `repo.maven.apache.org` |
| apt | `deb.debian.org`, `security.debian.org`, `archive.ubuntu.com`, `security.ubuntu.com` (also plain HTTP, downloads only) |

The registries are there for downloads. PyPI and crates.io publish through other hosts (`upload.pypi.org`, `crates.io`), so a task can't publish there; npm and RubyGems take uploads on the same hosts they serve downloads from (see the risks below).

Anything else is refused, and the refusal shows in the task's transcript. Go modules aren't reachable, because the Go module proxy fetches any address it's given. Vendor them (`go mod vendor`). Codex signed in with an API key instead of ChatGPT needs `api.openai.com`, which isn't on the list, so use a ChatGPT sign-in.

If the sandbox can't start the jail, the task fails and nothing runs.

**Give it tasks only in repositories whose contents you trust.** Anything in the repository the agent reads (a CLAUDE.md, a file, an issue the goal quotes) can steer it, because it runs without asking before each step. The jail limits what a steered agent can do, but not all of it:

- **Your sign-in is in the jail.** The CLI needs it there. A shell command the agent runs, such as `cat ~/.claude/.credentials.json`, can read it. The deny rules only cover Claude Code's own file tools, and Codex has no such rules.
- **It can send what it read to an allowed host under someone else's account.** For example, the agent could send your sign-in or the repository's code to an AI provider with an attacker's credentials, or publish it to npm or RubyGems with a token planted in the repository.
- **The task pushes to this repository.** Anything it read can end up in its branch, its commits or its pull request.

A task in its own sandbox runs in the same kind of jail, without the first risk: it has no sign-in, and its model token stays outside the jail (see [What a run can reach](/docs/agents/tasks#what-a-run-can-reach)). The notice you accept says this too.

## Who can reach it

- **Only you.** Nobody else sees your terminal or connects to it: not a repository admin, not the repository's owner, not a site administrator. The terminal may hold your provider sign-in.
- **Only from a browser on this Diffinery.** The connection must come from a page on the instance's own address with your session cookie. A request without that `Origin`, from another site, or with a token is refused.
- **Not through the sandbox API.** A terminal's sandbox isn't listed by the [sandbox API or MCP tools](/docs/agents/sandboxes), and they can't run commands in it, read its files or close it, whoever asks.

## What the sandbox can do

- Git in the sandbox acts as the agent you picked, at most with write access to this one repository. The credential stops working when the terminal ends, and it's checked again every minute: if you or the agent lose write access, the terminal ends.
- Your provider sign-in and anything else you type into the shell can be read by any process in the sandbox, including the sandbox's own server and its credentials, which reach only this sandbox. Don't paste secrets you wouldn't keep on that machine.
- The sandbox has outbound internet access, as other sandboxes do (only HTTP and HTTPS on instances that set [`EGRESS=web`](/docs/self-hosting/configuration#egress)).

## When it ends

A terminal ends, and its sandbox stops with everything on its disk, when:

| Reason | What the page says |
| --- | --- |
| You click **End** | You ended it. |
| No tab was connected for 30 minutes | Nobody was attached for 30 minutes. |
| It ran for 8 hours | It reached the 8-hour limit. |
| You or the agent lost write access | You or the agent no longer have write access here. |
| The sandbox stopped or didn't start | Its sandbox stopped. / Its sandbox didn't start. |
| An administrator switched terminals off | Terminals were switched off on this Diffinery. |

Push your work before it ends: nothing in the sandbox is kept. Exiting the shell starts a new one in the same sandbox.

## Limits

You can have **2** terminals open in a repository and **5** in all. Opening another one is refused with `429` until you end one.

A terminal's sandbox counts toward the [account quotas](/docs/reference/limits#account-quotas) of the account that owns the repository, like any agent sandbox: its sandboxes open at once and its hosted minutes for the month. Past either, opening a terminal is refused with `429` and the quota's message.

## Nothing is stored

What you type and what the shell prints go only between your browser and the sandbox. Diffinery keeps no copy and doesn't log it: the recent output that redraws the screen lives in the sandbox's memory and is gone when the terminal ends. The [audit log](/docs/security/audit-log) records only that a terminal was opened or ended, by whom, in which repository, with which agent and branch and the Claude Code and Codex versions its buttons install, and that you accepted the notice (`terminal.terms`, `terminal.open`, `terminal.task`, `terminal.end`).

## Troubleshooting

| What you see | Cause and fix |
| --- | --- |
| No **Give it a task** box, or `the terminal was opened without agent tasks` | The terminal was opened without **Will run agent tasks**. End it and open another with the box ticked. |
| `diffinery: refused a connection to <host>:443 from the task (only the hosts in /docs/agents/terminal#what-a-task-can-reach)` in the transcript | The agent or a tool it ran tried a host outside the [list](#what-a-task-can-reach). Work that needs other hosts belongs in the terminal itself, outside a task. |
| `diffinery: refused a connection to <host>:443 from the task: its TLS ClientHello asks for <other host>` (or `names no single server, or hides it (Encrypted Client Hello)`, or `no TLS ClientHello`) | The tunnel opens only when the TLS handshake names the host the tool asked the proxy for. A tool that sends a different server name, none, or Encrypted Client Hello, or that doesn't start TLS within 10 seconds, is refused. Point the tool at the allowed host by its own name and turn off Encrypted Client Hello in it. |
| `go: ... dial tcp ...` or another Go module download error | Go modules aren't reachable from a terminal task, or from any other agent run. Commit them with `go mod vendor`. |
| The task fails with "The task's jail couldn't start in this terminal's sandbox, so nothing ran." | bubblewrap couldn't start in the sandbox; the transcript has its error. Nothing ran and nothing was pushed. End the terminal, open a new one and run the task again. |
| The terminal's Claude Code or Codex asks you to sign in again after a task | The CLI refreshed its sign-in inside the task, on its private copy, and the provider retired the old refresh token. Sign in again in the terminal. |
| Codex fails to reach `api.openai.com` in a task | Codex is signed in with an API key, and only ChatGPT sign-ins work in terminal tasks. Run `codex login` with your ChatGPT plan, or use a task with a sandbox of its own. |

## For administrators

Terminals are on by default. Set the Worker variable `TERMINALS` to `off` to switch them off: nobody can open one, and the ones that are open end within a minute. See [Configuration](/docs/self-hosting/configuration#worker-variables).
