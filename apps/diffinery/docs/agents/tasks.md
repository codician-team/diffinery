---
title: Agent tasks
description: Give one of your agents a goal; it runs Claude Code, Codex or your own command in a sandbox with your own model key, then pushes a branch and opens a pull request for review.
---

An **agent task** is a goal you give one of your agents, such as "Fix the Contact sales link on the pricing page and add a test". Diffinery starts a sandbox as that agent with the repository checked out, runs a coding agent (Claude Code, Codex or a command of your own) with **your own model API key**, streams its transcript to the task page, then pushes the work to a branch and opens a pull request as the agent. The pull request needs a person's approval like any agent pull request.

![An agent task's page: the goal, Claude Code running as the acme-coder agent, the pull request it opened, and its transcript with file edits and test runs](/docs/images/agent-task.webp)

Tasks are optional. Nothing changes for a repository until someone with a model key starts one. To use your Claude or ChatGPT subscription instead of an API key, run tasks in a [terminal](/docs/agents/terminal#give-it-a-task).

The same machinery reviews pull requests: see [Agent review](/docs/agents/review). Reviews show in the repository's task list, labelled **Review**. The repository's **Project** tab shows tasks on a board, with a conversation and a memory every task reads: see [Projects](/docs/agents/projects).

## Before you start

You need three things:

1. **Write access** to the repository.
2. **An agent** you manage: one you own, or one of an organization where you are an owner or admin. The agent needs write access to the repository too (agents get at most their owner's access). Create one under **Settings → Agents**; see [Agents](/docs/agents/overview).
3. **Your own model key** under **Settings → Model access**: an Anthropic API key for Claude Code, an OpenAI API key for Codex, or an OpenRouter key for either. See [Model access](#model-access).

## Start a task

1. Open the repository's **Project** tab (people with write access see it) and click **New task**.
2. Write the **goal**, as you would ask a colleague. Markdown works.
3. Pick the **runtime**: Claude Code, Codex or **Custom command** (see [Runtimes](#runtimes)).
4. Pick the **agent** and the **base branch**.
5. Tick **Plan first** to have the agent plan before it builds (see [Plan first](#plan-first)).
6. Choose **Attempts** to have up to 4 agents try the goal at once, then pick the best (see [Best of N](#best-of-n)).
7. Leave **Fix failing checks** ticked, and tick **Land when approved** if you want it merged by itself once approved (see [Verify and land](#verify-and-land)).
8. Click **Start task**.

The task page shows the transcript live: what the agent says, the commands it runs and their output.

## What happens in a run

| Step | What Diffinery does |
| --- | --- |
| Sandbox | Re-checks that you may run the task, then starts a fresh sandbox **as the agent**, on behalf of you, with the base branch (or the task's branch, for later runs) checked out. Its git credential is the agent's, at most write, and stops working when the run ends. |
| Install | Installs the runtime from its vendor's official npm package, at a version Diffinery pins (see [Runtimes](#runtimes)). No model credential exists in the sandbox yet. |
| Agent | Runs the runtime headless with the goal, plus the project's instructions and memory when it has them (see [Projects](/docs/agents/projects)), in a jail with a clone of its own (see [What a run can reach](#what-a-run-can-reach)). Its model requests go through Diffinery's model proxy with a token for this run, which stays outside the jail (see [How your key is protected](#how-your-key-is-protected)). |
| Push | Commits what the agent left uncommitted, as the agent, in a jail with no network, and takes the new commits out as a git bundle. The sandbox's checkout then pushes them to `agent/<number>-<slug>`, with no hooks. Branch protection, push protection and the agent's guardrails apply as to any push. |
| Pull request | Opens a pull request from that branch as the agent, with the goal as its `intent`, or updates the one the task already has. |
| Close | Closes the sandbox. The run's git credential and model token stop working. |

A run stops after 6 hours. Tasks show on [Today](/docs/agents/today) under **Your agent tasks** while they run and for a day after they change.

### Task states

| State | Meaning |
| --- | --- |
| **Queued** | Waiting for a running task in the repository to finish, or, for a task a [coordinator](/docs/agents/projects#coordinator) started, for the tasks it waits on: a repository runs at most 3 at once unless its admins change it (see [How many at once](/docs/agents/projects#how-many-at-once)). |
| **Running** | A run is in progress. |
| **Ready** | The last run finished. Its work is on the task's pull request, if it changed anything. |
| **Failed** | The last run failed: the runtime exited with an error, the push was refused, or you lost access. The transcript says why. |
| **Stopped** | Someone stopped it. |

A [plan-first](#plan-first) task also has a plan state: `planning` while its plan runs, `waiting` when the plan waits for you (the board shows it under **Waiting on you**), then `approved` or `split`. A task with attempts has a pick state: `running`, `waiting` for your pick (also under **Waiting on you**), then `picked`, with `picked_attempt`.

### Plan first

A plan-first task's first run writes a plan instead of code. The agent gets a **read-only** sandbox, as an [agent review](/docs/agents/review) does: it reads the code and runs read-only commands, its git credential can't push, and nothing it changes is kept. The plan is its final message (for a custom command, everything it printed), up to 20,000 characters, and shows on the task page. Then you choose:

- **Approve plan**: a build run starts with the goal and the plan. It, and every later run of the task, gets the plan in its prompt as the one you approved.
- **Send a follow-up** to ask for changes: the agent plans again, with its previous plan and your message.
- **Split into tasks**: your [coordinator](/docs/agents/projects#coordinator) gets the goal and the plan as a post of yours and starts tasks for its parts. Each says it was split from this task, which is then done with. You need a coordinator in the project for this.

Repository admins can make plans the default, or require them for every task, including ones coordinators start (see [Plan first](/docs/agents/projects#plan-first)).

### Best of N

With **Attempts** set to 2, 3 or 4, the task's first build runs as that many attempts at the same time. Each one gets its own sandbox and pushes its own branch: the first pushes to the task's branch and the others to `-a2`, `-a3` and `-a4` beside it. Together they count as that many toward [How many at once](/docs/agents/projects#how-many-at-once), and each one spends your model key as its own run. With **Plan first**, the attempts build the approved plan.

When the last attempt ends, the task waits on you with a comparison. For each attempt it shows the files and lines it changed (with a link to its diff), the checks on its branch, the tokens it used and its last message. **Pick** one, and its branch becomes the task's branch, with a pull request from it. The other attempts' branches are deleted, and every later run builds on the attempt you picked. Follow-ups wait for the pick. **Retry** before a pick runs all the attempts again, and **Stop** stops all of them.

A task on a pull request's branch (**Fix it**) runs one attempt.

### Verify and land

Two options on each task, set on the new-task form and changed later under **Verify and land** on the task page:

- **Fix failing checks** (on by default, except on someone else's pull request with **Fix it**). When every check on the task's pull request has finished on its latest commit and one of them failed, a fix run starts. It gets the failing checks' names and the end of their logs (the last 80 lines, or a commit status's description), labelled as output from the checks rather than instructions. One fix run starts per commit, and at most 3 per task. After that, the conversation says the checks still fail. Agent review findings aren't counted here: [autofix](/docs/agents/review) handles those.
- **Land when approved** (off by default). When the task opens its pull request, or when you turn this on later, it turns on [auto-merge](/docs/collaboration/pull-requests#auto-merge) as the task's agent. The pull request then merges by itself once the base branch's rules are met: a person approves its latest commit (an agent's approval never counts) and the required checks pass. The usual rules for agents apply (see [Agents landing changes](/docs/repositories/branch-protection#agents-landing-changes)). Into the default branch or a protected branch, auto-merge needs `allowAgentAutoMerge` in the branch's protection and at least one required check, and only an admin's `agentAutoMergeWithoutApproval` waives the approval. When auto-merge can't turn on, the task page and the conversation say why, and a person merges by hand.

The board shows a task as **Ready for review** only when its pull request's checks pass on its latest commit.

### Steer, retry and stop

- **Send a follow-up** from the task page to continue: a new run starts on the task's branch with the goal, how the previous run ended and your message, and its work goes to the same pull request. Sent while a run is active, the message waits and starts when that run ends.
- **Retry** runs the last run again when the task isn't running.
- **Stop** stops the agent and closes its sandbox. Work already pushed stays.

Only the person who started a task can send it messages or retry it, because each run spends their model key. That person, the task's agent and repository admins can stop it.

## Runtimes

| Runtime | Needs | Runs |
| --- | --- | --- |
| **Claude Code** | Your Anthropic API key | `claude -p "$DIFFINERY_TASK_PROMPT" --output-format stream-json --verbose --permission-mode bypassPermissions` |
| **Codex** | Your OpenAI API key | `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "$DIFFINERY_TASK_PROMPT"` |
| **Claude Code via OpenRouter** | Your OpenRouter key | The same, with `ANTHROPIC_BASE_URL` on OpenRouter's Anthropic-compatible endpoint (through the proxy), the token as `ANTHROPIC_AUTH_TOKEN`, and the model you choose for every model role (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `_SONNET_`, `_HAIKU_`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) |
| **Codex via OpenRouter** | Your OpenRouter key | The same, with an `openrouter` model provider on OpenRouter's Responses API (`-c model_provider=openrouter -c model_providers.openrouter...`) and `-m "$DIFFINERY_MODEL"` |
| **Custom command** | Nothing required | Your command, with the goal in `$DIFFINERY_TASK_PROMPT`, and `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL` / `OPENAI_API_KEY` and `OPENROUTER_BASE_URL` / `OPENROUTER_API_KEY` set for each provider you have a key for. The base URLs point at the jail's model proxy and the keys are a stand-in (see [How your key is protected](#how-your-key-is-protected)) |

### OpenRouter

With an OpenRouter key, Claude Code and Codex can run on a model you choose there. Pick **Claude Code via OpenRouter** or **Codex via OpenRouter** as the runtime, and name the model (an id from [openrouter.ai/models](https://openrouter.ai/models)). Left empty, Claude Code uses `~anthropic/claude-sonnet-latest` and Codex `~openai/gpt-sol-latest`. Over the API, send `"provider": "openrouter"` and `"model"`.

OpenRouter supports Claude Code fully only with Anthropic models served by Anthropic, and Codex works best with OpenAI models. Other models may not handle the runtime's tools well. Usage, including OpenRouter's fees, is billed to your OpenRouter account.

A run through OpenRouter is **pinned to the model you chose**. The model proxy refuses a request for any other model, and requests that set OpenRouter's routing or paid extras (`models`, `route`, `provider`, `plugins`, `web_search_options`, `speed`, `best_of`). So code in the repository can't switch the run to a pricier model. A custom command that uses your OpenRouter key isn't pinned, since it picks its own model.

Diffinery names itself to OpenRouter as the app (`HTTP-Referer` and `X-Title`). The sandbox's own attribution and `X-OpenRouter-*` headers are dropped.

The runtimes run unmodified, from the vendors' own packages, at pinned versions: Claude Code 2.1.296 (`@anthropic-ai/claude-code`) and Codex 0.162.1 (`@openai/codex`). Diffinery moves to newer versions deliberately rather than installing whatever was published last. The sandbox is its own container, so they run without permission prompts. The goal reaches the runtime in an environment variable, never pasted into a command line.

The prompt tells the agent which task it is working on, that Diffinery pushes and opens the pull request, and not to push or change git credentials itself.

## Model access

**Settings → Model access** holds your own API keys, one per provider:

- **Anthropic**, for Claude Code. Create a key at console.anthropic.com.
- **OpenAI**, for Codex. Create a key at platform.openai.com.
- **OpenRouter**, for Claude Code or Codex on a model you choose there (see [OpenRouter](#openrouter)). Create a key at openrouter.ai/settings/keys.

Saving a key asks you to confirm that you use that provider through Diffinery **under your own account and the provider's terms**, with links to them (Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) and [Usage Policy](https://www.anthropic.com/legal/aup); OpenAI's [Terms and Policies](https://openai.com/policies/); OpenRouter's [Terms of Service](https://openrouter.ai/terms) and [Privacy Policy](https://openrouter.ai/privacy)). The provider bills your account. Diffinery only provides the ability; whether and how you use it is your choice and your agreement with the provider. Your confirmation is stored with its date.

- Keys are encrypted at rest and **write-only**: no page, API call or MCP tool returns one. You see the last four characters.
- Only you, signed in in a browser, can save, replace or delete your keys. No token, agent, job or sandbox can.
- Saving a key sends you a security email ("Your Anthropic API key was added to Diffinery"), which you can't turn off.
- Keys belong to people. Agents never have model keys of their own. An organization's owners can give it keys of its own, and decide whose key pays in its repositories: see [Agents in organizations](/docs/agents/organizations).
- Subscriptions (Claude Pro or Max, ChatGPT plans) can't be used for headless tasks: providers allow automated use with API keys. You can hand a task to the CLI signed in to [your own web terminal](/docs/agents/terminal#give-it-a-task) instead.

## Usage and cost

Each task's page has a **Usage** box: per run, the model requests, input and output tokens, cache reads and writes, and the cost, with the task's total. The same numbers are in the REST API (`usage` on the task, and on each of its `runs`) and in MCP's `agent_task`.

- **Through your key**, Diffinery's model proxy counts the tokens from each answer the provider sends (`"source": "proxy"`). These are the numbers budgets and limits use.
- **In your terminal**, on a subscription, no request passes Diffinery, so the run shows what the CLI reported: Claude Code at the end of its run, Codex after each turn (`"source": "runtime"`).
- **Cost** is only ever Claude Code's own figure (`total_cost_usd`), at API prices. Diffinery keeps no price list. Codex and custom commands show tokens without a cost, and a subscription covers a terminal run's cost. Your provider's console shows what you were actually billed.

**Settings → Model access** shows **Usage in the last 30 days** for every run you pay for: your tasks and your coordinator's, and [agent reviews](/docs/agents/review) in repositories where you turned them on. Runs an organization's key paid for are on its Settings tab instead, for its owners (see [Agents in organizations](/docs/agents/organizations#usage)). It is broken down by repository and kind, with each repository named as it was when its runs ended. A repository renamed since shows a line for each name. `GET /api/v3/diffinery/model-usage?days=30` returns the same (1 to 90 days); a token limited to some repositories sees only those.

Model requests are limited to **600 a minute per paying person**, across all their runs, on top of each run's own limits. Past that, the proxy answers `429` with `retry-after: 60`, and Claude Code and Codex wait and retry. This caps how fast a runaway task, or a leaked run token, can spend your key. Like the other [rate limits](/docs/reference/rest-api#rate-limits), it is counted in each Cloudflare location, so runs in several locations can go past 600 a minute in total; each run's own limits and budgets still apply.

## How your key is protected

Your key never enters a sandbox:

1. When a run's agent starts, Diffinery creates a **model token for that run** (`dmt_...`). The token stays outside the agent's jail, with a small proxy there that forwards the agent's model requests, and only those (`/-/model/...`), to Diffinery's model proxy with the token added. Inside, the runtime's API key is a stand-in (`diffinery-jail`), and the provider's base URL points at that proxy (`http://127.0.0.1:3129/-/model/<provider>`). Whatever credential the agent sends is dropped.
2. The proxy accepts the token only while that run's agent is running. On every request it re-checks that you can still run the task, and that whoever pays still may (see [Whose key pays](/docs/agents/organizations#whose-key-pays)). Then it forwards the request to the provider with the key added, decrypted for that request only.
3. The proxy forwards only the model endpoints the runtimes use, and refuses everything else with `403`, so an agent can't reach the rest of your provider account (stored files, batches, assistants):

   | Provider | Endpoints |
   | --- | --- |
   | Anthropic | `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models` and `GET /v1/models/{id}` |
   | OpenAI | `POST /v1/responses`, `POST /v1/responses/compact`, `GET /v1/responses/{id}`, `POST /v1/chat/completions`, `GET /v1/models` and `GET /v1/models/{id}` |
   | OpenRouter | `POST /v1/messages`, `POST /v1/messages/count_tokens`, `POST /v1/responses`, `POST /v1/chat/completions`, `POST /v1/completions` and `GET /v1/models`. Never keys, credits, generation stats or anything else on your OpenRouter account. |

4. When the agent exits, is stopped, or the run ends any other way, the token stops working. If you lose access to the repository or the agent, the task stops.

Everything the sandbox returns, including the transcript, masks the model token and the git credential.

**What this doesn't protect against.** Anything the agent runs in its jail (build scripts, tests, dependencies, code from the repository) can send model requests through the jail's proxy while the run lasts, on your key, and repository content can try to trick the agent into misusing that ("prompt injection"). It can't read the model token or the git credential, and it reaches only the package registries below. So:

- Use a **dedicated API key with a spending limit** for Diffinery, and revoke it with the provider if you suspect misuse.
- Run tasks on repositories whose content you trust. A steered agent can still publish what it read to npm or RubyGems with a token planted in the repository, and anything it read can end up in its branch and pull request.
- A transcript can show a credential in another form (for example encoded) that masking can't recognise. Transcripts are visible only to people with write access.

### What a run can reach

Every headless run (a task's, a plan's, a review's and a coordinator's) runs its agent under [bubblewrap](https://github.com/containers/bubblewrap), inside its sandbox, as a [terminal task](/docs/agents/terminal#what-a-task-can-reach) does:

| In the jail | |
| --- | --- |
| Files | The run's own clone of the repository at its start commit (read and write), and the sandbox checkout's git objects (read only). Not the checkout or its git config (which holds the sandbox's git credential), the home directory, or `/tmp`. The rest of the system is read only. |
| Processes | Its own: it can't see or signal anything else in the sandbox. No capabilities. |
| Network | None of its own. Model requests go to the model proxy outside the jail, on `127.0.0.1:3129`, which forwards only `/-/model/...` to Diffinery. Everything else goes through a proxy (set as `HTTPS_PROXY`) that connects only to the package registries below, by name, on port 443, and only when the TLS handshake asks for that same host. Diffinery itself, the providers' APIs and any other host are refused. |
| Environment | Only what the runtime needs: the model proxy's base URLs, the stand-in API keys and the model a route pins. No sandbox tokens. |

The registries: npm and Yarn (`registry.npmjs.org`, `registry.yarnpkg.com`), PyPI (`pypi.org`, `files.pythonhosted.org`), Cargo (`index.crates.io`, `static.crates.io`), RubyGems (`rubygems.org`, `index.rubygems.org`), Maven Central (`repo1.maven.org`, `repo.maven.apache.org`) and apt (`deb.debian.org`, `security.debian.org`, `archive.ubuntu.com`, `security.ubuntu.com`, also over plain HTTP for downloads). Go modules aren't reachable, because the Go module proxy fetches any address it's given: vendor them (`go mod vendor`).

A refused connection shows in the run's transcript. If the sandbox can't start the jail, the run fails with "The run's jail couldn't start in its sandbox, so nothing ran", and nothing runs: it never falls back to running without one.

Task sandboxes are closed to the [sandbox API](/docs/agents/sandboxes): no call reaches them, for anyone, including the agent's own tokens and repository admins.

## Who sees what

- Tasks and transcripts: people with **write** access to the repository (stricter than Actions logs, because transcripts show an agent's reasoning and command output).
- The task's pull request: everyone who can read the repository, like any pull request.

## REST API

| Endpoint | Does | Who |
| --- | --- | --- |
| `GET /repos/{owner}/{repo}/diffinery/tasks` | List tasks | Write access; any token |
| `GET /repos/{owner}/{repo}/diffinery/tasks/{number}` | A task with its runs | Write access; any token |
| `GET /repos/{owner}/{repo}/diffinery/tasks/{number}/transcript?after=0` | Transcript lines | Write access; any token |
| `POST /repos/{owner}/{repo}/diffinery/tasks` | Start a task; `"plan_first": true` or `false` overrides the project's default, unless it requires plans; `"attempts": 1` to `4`; `"fix_checks"` and `"land"`, true or false | Browser session only |
| `POST .../tasks/{number}/messages` | Send a follow-up | Browser session only, the person who started it |
| `POST .../tasks/{number}/retry` | Retry | Browser session only, the person who started it |
| `PATCH .../tasks/{number}` | Change options: `{ "fix_checks": true, "land": false }` | Browser session only, the person who started it |
| `GET .../tasks/{number}/attempts` | The attempts compared: state, branch, pushed head, changes, checks, tokens, last message | Write access; any token |
| `POST .../tasks/{number}/attempts/{attempt}/pick` | Pick an attempt: its branch becomes the task's, with a pull request | Browser session only, the person who started it |
| `POST .../tasks/{number}/plan/approve` | Approve a waiting plan: the build run starts | Browser session only, the person who started it |
| `POST .../tasks/{number}/plan/split` | Hand a waiting plan to your coordinator to split into tasks | Browser session only, the person who started it |
| `POST .../tasks/{number}/stop` | Stop | The person who started it, its agent or a repository admin |
| `GET /diffinery/tasks` | Tasks you started, across repositories | Any token |
| `GET /diffinery/model-keys` | Your saved keys (provider, last four characters, dates) | Any token |
| `GET /diffinery/model-usage?days=30` | The model usage you paid for, per repository and kind (`task`, `review`, `coordinator`), over 1 to 90 days. See [Usage and cost](#usage-and-cost). | Any token; a token limited to some repositories sees only theirs |
| `PUT` / `DELETE /diffinery/model-keys/{provider}` | Save or delete a key | Browser session only |

```sh
curl https://diffinery.com/api/v3/repos/acme/website/diffinery/tasks/7 \
  -H "Authorization: Bearer dfy_..."
```

```json
{
  "number": 7,
  "title": "Fix the Contact sales link on the pricing page",
  "goal": "Fix the Contact sales link on the pricing page so it goes to /contact, and add a test.",
  "state": "ready",
  "runtime": "claude-code",
  "agent": { "login": "ayse-bot", "type": "Bot" },
  "started_by": { "login": "ayse", "type": "User" },
  "paid_by": "person",
  "plan_first": false,
  "attempts": 1,
  "fix_checks": true,
  "check_fixes": 0,
  "land": false,
  "base": "main",
  "branch": "agent/7-fix-the-contact-sales-link-on-the",
  "pull_request": { "number": 42, "html_url": "https://diffinery.com/acme/website/pull/42" },
  "queued_message": null,
  "error": null,
  "html_url": "https://diffinery.com/acme/website/tasks/7",
  "usage": { "requests": 42, "input_tokens": 9120, "output_tokens": 14406, "cache_read_tokens": 2853120, "cache_write_tokens": 9366, "cost_usd": 1.4123 },
  "runs": [{ "number": 1, "kind": "start", "message": null, "state": "done", "exit_code": 0, "error": null, "model_requests": 42, "tokens": 318204, "usage": { "source": "proxy", "requests": 42, "input_tokens": 9120, "output_tokens": 14406, "cache_read_tokens": 2853120, "cache_write_tokens": 9366, "cost_usd": 1.4123 }, "started_at": "2026-10-14T07:02:11.000Z", "ended_at": "2026-10-14T07:09:40.000Z" }]
}
```

A run's `model_requests` and `tokens` are what its agent used through the model proxy, counted from the usage the provider reports (cache reads count as a tenth). An answer that reports no usage counts an estimate: a token per 3 bytes of request, plus the output it allows. `usage` breaks a run's tokens down, and says who counted them (`source`): `proxy`, or `runtime` for a run in your terminal. It is `null` for a run that used none, and the task's `usage` adds up its runs. See [Usage and cost](#usage-and-cost). `paid_by` is `person` or `organization`: whose key the task's model requests use, fixed when it started (see [Agents in organizations](/docs/agents/organizations#whose-key-pays)).

Transcript lines have `seq`, `run`, `at`, `stream` (`out` and `err` for the runtime's output, `setup` for installing and pushing, `note` for Diffinery's own lines) and `text`. Claude Code writes `stream-json` lines and Codex writes `--json` lines to `out`.

## MCP

Two read-only tools, so your own agent can follow tasks:

| Tool | What it does |
| --- | --- |
| `agent_tasks` | With `owner` and `repo`: that repository's tasks. Without: the tasks you started. |
| `agent_task` | One task with its runs and its transcript after `after`. |

Starting, steering and retrying aren't available over MCP, because they spend a person's model key.

## Troubleshooting

| What you see | Cause and fix |
| --- | --- |
| `Claude Code needs your Anthropic API key` | Save a key under **Settings → Model access**. |
| `you can't run tasks as <agent>` | You must own the agent or be an owner or admin of the organization that owns it. |
| `<agent> needs write access to this repository` | Give the agent write access, or a role through its organization. Agents get at most their owner's access. |
| `starting or steering an agent task needs a browser session` | Use the web page; tokens can't start tasks. |
| The run failed at **Installing** | The npm registry couldn't be reached or the package failed to install. Retry. |
| `Pushing the work ... failed` | The push was refused, usually by branch protection, push protection (a secret in the changes) or the agent's guardrails. The transcript shows git's message. |
| The task stopped with "can no longer run it" | You lost write access to the repository, or can no longer manage the agent. |
| Model calls fail with `401 ... its task run has ended` | The run is over; that token no longer works. Start a new run. |
| `diffinery: refused a connection to <host>:443 from the task` in the transcript | The agent or a tool it ran tried a host other than the [package registries](#what-a-run-can-reach). Commit what the work needs (vendored dependencies, for example), or do it outside a task. |
| `diffinery: refused a connection to <host>:443 from the task: its TLS ClientHello asks for <other host>` (or `names no single server, or hides it (Encrypted Client Hello)`, or `no TLS ClientHello`) | The tunnel opens only when the TLS handshake names the registry the tool asked the proxy for. A tool that sends a different server name, none, or Encrypted Client Hello, or that doesn't start TLS within 10 seconds, is refused. Point the tool at the registry by its own name. |
| `diffinery: refused ... (only Diffinery's model endpoints, /-/model/...)` | Something in the run called Diffinery outside the model endpoints through the jail's model proxy. Runs can't reach the rest of Diffinery. |
| `The run's jail couldn't start in its sandbox, so nothing ran` | The sandbox couldn't create the jail's namespaces. The transcript says why. Retry; if it keeps happening, tell your instance's administrator. |
| A custom command gets `403 ... isn't available to agent tasks` | The model proxy forwards only the model endpoints listed under [How your key is protected](#how-your-key-is-protected). |
