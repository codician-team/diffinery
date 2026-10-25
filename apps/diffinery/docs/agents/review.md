---
title: Agent review
description: One of your agents reviews pull requests for bugs, security issues and logic errors, like Cursor's Bugbot, with inline findings, an Agent review check and one-click fixes.
---

**Agent review** has one of your agents review pull requests, the way Cursor's Bugbot does. The agent runs Claude Code, Codex or a command of your own in a read-only sandbox, using a model key you bring. It reads the pull request's changes and looks for bugs, security issues and logic errors, not style. Diffinery then posts what it found as a review with inline comments, and reports an **Agent review** check that fails when a finding is blocking.

![A pull request an agent task opened, with an agent review: its summary and an inline finding with a suggested fix and a Fix it button](/docs/images/agent-pull-request.webp)

Agent review is off until a repository admin turns it on. Nothing changes for a repository that doesn't use it.

## Turn it on

You need to be a **repository admin**, with an agent you manage that has write access (see [Agent tasks](/docs/agents/tasks#before-you-start)) and your own model key under **Settings → Model access**.

1. Open the repository's **Settings → Agent review**.
2. Pick the **agent** and the **runtime**: Claude Code (your Anthropic key), Codex (your OpenAI key), either of them via OpenRouter on a model you choose (your OpenRouter key; see [OpenRouter](/docs/agents/tasks#openrouter)), or a custom command.
3. Choose **when to review**:
   - **Every pull request, when it opens and on every push** (the default).
   - **Once per pull request**, when it opens or is marked ready for review.
   - **Only when someone asks.**
4. Choose **which pull requests** to review: all of them, only ones from people, or only ones from agents. Drafts are skipped unless you tick **Review draft pull requests too**.
5. Optionally turn on **Autofix** (see [Fix it and autofix](#fix-it-and-autofix)).
6. Set the **daily limit**: the most reviews the repository runs in 24 hours (50 unless you change it; see [Limits](#limits)).
7. Tick the confirmation and click **Turn on agent review**.

**Every review on the repository uses your model key**, automatic reviews and ones other people ask for alike. The settings page and every review's footer name whose key it is. Another admin who saves the settings becomes the one whose key is used. **Turn off** stops new reviews.

## What a review does

1. Diffinery re-checks that you can still run the agent and that your key is still saved. Otherwise the check reports why, and nothing runs.
2. It starts a **read-only sandbox** as the agent, with the pull request's head checked out. The sandbox can clone and read, but its git credential can't push and can't write through the API.
3. The runtime gets a prompt containing:
   - the pull request's title, description and changed files;
   - the base and head commits;
   - your project's review rules (below);
   - its own earlier findings on this pull request.
4. It reports findings as a JSON block at the end of its final message. A block anywhere else, such as in a file the agent read, doesn't count. (A custom command's whole output is read.)
5. Diffinery posts the findings as a **Comment** review by the agent:
   - Each finding becomes an inline comment marked **🔴 Blocking** or **🟡 Not blocking**, with the reasoning and, for a one-line fix, a `suggestion` block.
   - Findings outside the changed lines go in the review's summary.
   - At most 25 inline findings are posted per review.
6. It completes the **Agent review** check on that commit:

| Result | Check |
| --- | --- |
| No blocking findings | success |
| One or more blocking findings | failure |
| The agent produced no findings block | failure: "The review didn't produce findings" |
| The review was stopped, or a newer push superseded it | cancelled |
| The review ran past its time or model-request limit | failure: "The review didn't finish" |
| Your key or your access is gone, the author can't be reviewed automatically, or a daily limit was reached | action required |

The review and its findings show on the pull request like any review. The run, with its full transcript, is in the repository's task list (**Project → All tasks**), labelled **Review**. Reviews don't count toward required approvals, and an agent review never requests changes. Whether findings block a merge is up to the check.

### Re-reviews

On the next push, the review covers what changed since its last review and checks its earlier findings:

- When the code now fixes a finding, the agent replies **Fixed in `abc1234`.** and resolves its own thread.
- It doesn't repeat a finding a person dismissed by resolving its thread.
- It never resolves a person's thread.

Only one review of a pull request runs at a time. Pushes during a review queue one more review of the newest head. If the pull request changes while a review runs, that review's findings aren't posted, because their lines may be wrong, and the queued review covers the new head.

## Ask for a review

People with **write access** can ask for a review at any time, whatever the trigger setting:

- **Request agent review** in the pull request's Reviewers sidebar.
- A comment starting with `@<agent> review`, for example `@review-bot review`.
- Requesting the agent as a reviewer.
- `POST /repos/{owner}/{repo}/pulls/{number}/diffinery/agent-review`, with any of your tokens.

Agents can't ask for reviews, so agents can't set off review loops.

**Pull requests from people without write access aren't reviewed automatically.** Their check says it is waiting for a request. Someone with write access asks for the review, much like approving a workflow run for an outside contributor.

## Project rules: REVIEW.md

Write review rules in `REVIEW.md` files: what matters in this codebase, what to ignore, and conventions to enforce.

- Diffinery reads `REVIEW.md` at the repository root and in every directory above a changed file. A file nearer a changed file wins for it.
- It also reads `.cursor/BUGBOT.md` files, so rules written for Bugbot carry over.

Rules are read from the **base branch**, never from the pull request. A pull request can't rewrite the rules it is reviewed against. A change to `REVIEW.md` takes effect once it is merged.

A review also gets the repository's [project instructions](/docs/agents/projects#project-instructions), which only admins set. It never gets the project's memory, which an agent may have written.

## Fix it and autofix

- **Fix it** appears under every finding for people with write access. It opens a new agent task, prefilled with the finding, that works **on the pull request's own branch**. It runs as your agent with your key, and it pushes its fix to that branch under the branch's protection rules. The next review then checks the fix.
- **Autofix** does this by itself when a review finds blocking problems: one task for all of them, as the agent and with the key of the admin who turned reviews on.
  - It runs at most 3 times per pull request.
  - It runs only for pull requests whose author has write access.

## Require it before merging

Add **Agent review** to a branch's required checks under **Settings → Branch protection**. Diffinery binds a required "Agent review" to its own reviewer (`diffinery-agent-review`), so nobody else can post a passing check with that name, and a check an agent posts itself never counts.

A passing Agent review means **the agent found nothing**, not that the change is safe. Pull request content can try to trick the agent ("prompt injection") into reporting nothing. Keep people's approvals required as well.

## Limits

Diffinery enforces these itself, so an agent misled by a pull request can't run past them:

| Limit | What happens |
| --- | --- |
| **30 minutes** per review | The review stops, and its check fails. |
| **200 model requests** per review | The model proxy refuses the next request and stops the review, and its check fails. |
| **Tokens per review** (default 2,000,000, from 100,000 to 50,000,000) | The same, once the next request could take the review past its budget. |
| **10 automatic reviews** per pull request in 24 hours | Later pushes get an action-required "Waiting for a request" check. People with write access can still ask. |
| **20 reviews** per pull request in 24 hours, asked for or automatic | The check asks for action, and asking returns `429`. |
| The repository's **daily limit** (default 50, from 1 to 1000) | The check asks for action, asking returns `429`, autofix waits, and the admin whose key reviews use gets an email, at most once a day. |

Daily limits count the reviews and autofix runs started in the last 24 hours, so reviews run again as older ones fall out of that window.

Diffinery counts tokens itself, as requests pass through the model proxy:

- Before a request goes to the provider, the proxy books the most it may cost: a token per 3 bytes of request, plus the output it allows (its `max_tokens` or the endpoint's equivalent, or 32,000 when it sets none; a Codex compaction, which can't be capped, books 128,000). If that could take the review past its budget, the request is refused and the review stops. A review has at most 4 requests on their way at once (a fifth gets `429` and is tried again), so requests sent at once can overrun its budget by at most that many: each one's output is capped at what it booked, and only its input can cost more than its estimate (dense text, or images and PDFs, which bill by pixels and pages).
- Once the response has streamed through, the booking is replaced by the usage the provider reports: input, output and cache writes in full, cache reads as a tenth, since providers bill them at about a tenth. A response that reports no usage, or whose usage can't be read (a streamed line too long to keep, for example), is charged a token per byte sent, plus its output cap. An error response costs nothing. If the agent hangs up while an answer is still streaming, Diffinery keeps reading it for about 30 seconds; an answer that takes longer stays charged at its booking, and its place among the 4 frees after 15 minutes.
- A review can't start background responses, pull in input its request doesn't carry (`previous_response_id`, `conversation`, `prompt` or `item_reference` inputs, an Anthropic `container`, or images, documents and files given by URL or file id), send a body that isn't a JSON object, ask for more than one answer (`n`), use an OpenRouter web search model (`:online`) or preset, read back stored responses, or set routing and paid extras (`models`, `route`, `provider`, `plugins`, `web_search_options`, `speed`, `best_of`, `preset`). A review through OpenRouter asks only for its configured model. A review's requests keep only tools the agent runs itself (function and custom tools, and client-run ones such as bash, text editor, memory, a local shell and apply patch); every tool that runs on the provider is stripped, along with MCP servers, so web search, web fetch, code execution, file search, image generation and any server tool a provider adds later never reach it. Claude Code reviews also run with WebSearch and WebFetch turned off, and Codex reviews with web search disabled. A review's request is sent with every output cap set to the one booked (the largest it set, or 32,000 when it set none), so its booking holds.

Every run's model requests and tokens show in its transcript and in the API's `runs` (`model_requests`, `tokens`).

Change the daily limit and the token budget under **Settings → Agent review**.

## Who pays, and the risks

- Every review spends the model key of the admin who turned reviews on. In an organization's repository, its [agent policy](/docs/agents/organizations#whose-key-pays) can have the organization's key pay instead, while that admin is a member; it can also turn agent review off for all its repositories. Use a **dedicated key with a spending limit** with your provider as well: Diffinery's [limits](#limits) count reviews, requests and tokens, not money.
- While a review runs, anything in its jail, including code from the pull request, can use that key through the model proxy, though it can't read the key or the review's model token. The proxy forwards only the model endpoints, and the token stops working when the agent exits (see [How your key is protected](/docs/agents/tasks#how-your-key-is-protected)). Otherwise the jail reaches only the package registries (see [What a run can reach](/docs/agents/tasks#what-a-run-can-reach)).
- The sandbox can't push or write repository content. Its credential acts as the agent with read access.

## REST API

| Endpoint | Does | Who |
| --- | --- | --- |
| `GET /repos/{owner}/{repo}/diffinery/agent-review` | The repository's agent review settings | Write access |
| `PUT /repos/{owner}/{repo}/diffinery/agent-review` | Turn on, change (`agent`, `runtime`, `provider` and `model` for OpenRouter, `command`, `trigger`: `push`, `open` or `request`, `authors`: `all`, `people` or `agents`, `drafts`, `autofix`, `daily_limit`: 1 to 1000, `tokens_per_review`, `accept_terms: true`) or turn off (`enabled: false`) | Repository admin, browser session only |
| `GET /repos/{owner}/{repo}/pulls/{number}/diffinery/agent-review` | The pull request's review task, the last reviewed head and every finding with its state (`open`, `fixed`, `dismissed`) | Write access |
| `POST /repos/{owner}/{repo}/pulls/{number}/diffinery/agent-review` | Ask for a review (`429` past a daily limit) | People with write access (not agents) |

```json
{
  "task": { "number": 12, "kind": "review", "state": "ready", "html_url": "https://diffinery.com/acme/website/tasks/12" },
  "reviewed_sha": "9f2c…",
  "findings": [
    { "id": "F1", "path": "src/math.js", "line": 2, "side": "RIGHT", "severity": "blocking", "title": "Divides by zero", "state": "fixed", "fixed_in": "4be1…" }
  ]
}
```

## Moving from Bugbot

| Bugbot | Agent review |
| --- | --- |
| Reviews on open and every push | **When to review: every pull request** |
| `bugbot run` comment | `@<agent> review`, or **Request agent review** |
| `.cursor/BUGBOT.md` | Read as is, with `REVIEW.md` |
| Fix in Cursor / Autofix | **Fix it** / **Autofix** |
| Bugbot check | **Agent review** check |
