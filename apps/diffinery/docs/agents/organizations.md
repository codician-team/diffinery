---
title: Agents in organizations
description: An organization's agent policy and model keys. Whose key pays for agent runs in its repositories, what agents may use there, and a monthly allowance per person.
---

An organization's owners decide how agents work in its repositories, on the organization's **Settings** tab under **Agents**:

- whose model key pays: each person's own, or the organization's;
- which runtimes and providers agents may use;
- how many tasks run at once per repository;
- whether web terminals and agent review are allowed;
- how many tokens each person may spend on the organization's keys in a month.

Nothing changes until an owner changes something. By default people use their own keys, as in [Agent tasks](/docs/agents/tasks#model-access), and everything is allowed. A repository owned by a person has no policy.

## The organization's model keys

An owner can save an Anthropic, OpenAI or OpenRouter API key for the organization, under **Settings → Agents → Model keys**.

- Saving a key asks the owner to accept the provider's terms for the organization. The provider bills the organization's account. The acceptance is recorded with its date and the owner who accepted.
- **Only owners** can see or change the organization's keys. Org admins can't, and neither can members.
- Saving or deleting a key needs a browser session with a sign-in from the last 2 hours. Diffinery asks you to sign in again if yours is older. No token can do it.
- Keys are **write-only**, like personal keys: pages and the API show only the provider, the last four characters and who accepted the terms when.
- Every owner gets a security email when a key is added ("An Anthropic API key was added to acme").
- Saves and deletions are in the audit log as `org.model_key.set` and `org.model_key.delete`. A [site administrator](/docs/admin/site-administration) can act as an owner, and is recorded as themselves.

The organization's key **never enters a sandbox, a container or a terminal**. As with personal keys, a run gets only its own model token. Diffinery's model proxy decrypts the key inside each request it forwards, after checking that the request may use it (see [How your key is protected](/docs/agents/tasks#how-your-key-is-protected)).

## Whose key pays

| Setting | Who pays |
| --- | --- |
| **Each person's own keys** (default) | The person who starts the work, with their own key, as anywhere else. |
| **The organization's keys, when it has them** | A member's run uses the organization's key when it has every provider the run needs, otherwise the member's own. An outside collaborator always uses their own key. |
| **Only the organization's keys** | Personal keys are never used in the organization's repositories. Only members can start tasks, agent reviews and coordinators there. An outside collaborator gets `403 acme pays for agents in its repositories with its own keys, which only its members can use`. |

**Only members spend the organization's key.** A member here is a person with the member, admin or owner role. An agent account never counts, even an agent the organization owns: what counts is the person behind the run.

- A task's payer is the person who started it, never its agent. A task a coordinator starts is paid like the coordinator's own run.
- An agent review's payer is the admin who turned reviews on (see [Agent review](/docs/agents/review)).
- A coordinator's payer is the person whose coordinator it is (see [Projects](/docs/agents/projects)).

**A task keeps whose key pays from when it starts.** The REST task shows it as `"paid_by": "organization"` or `"person"`.

- Messages, retries and plan approval keep it. Only the person who started the task can do those.
- An agent review decides when each review starts, and a coordinator when each run starts.
- A task the organization paid for can't be retried by someone who is no longer a member: `only members of acme can run agents on its keys`.

**Every model request checks again**, before the key is decrypted. Nothing is cached, so a change applies at the next request. The proxy checks that:

1. the repository still belongs to the organization, so a repository transferred out of it mid-task stops spending its key;
2. the policy still lets the organization's keys pay;
3. the person is still an active member;
4. the provider is still allowed;
5. the organization still has the key;
6. the person is under their monthly allowance.

For a personal key in an organization's repository, it checks that the policy doesn't now require the organization's keys, and that the provider is still allowed.

When a check fails, the proxy answers `403` with the reason, for example `mia is no longer a member of acme, whose key this task uses`. The task stops with a note saying why, and anything booked for that request is refunded.

## Monthly allowance per person

**Monthly tokens per person on the organization's keys** caps how much one person's runs can spend of the organization's keys in a calendar month (UTC). It goes from 10,000 to 10 billion, and is off by default.

- Tokens are counted as [run budgets](/docs/agents/projects#limits) count them: input, output and cache writes in full, and cache reads as a tenth.
- Before a request goes to the provider, the proxy books an estimate against the person's allowance, in one step: a token per 3 bytes of the request, plus the output it allows. The answer then settles the booking to what the provider reported.
- A request that would take the person over the allowance is refused with `403` and never reaches the provider: `this month's allowance of 2,000,000 tokens per person on acme's keys is used up`. The task stops.
- While an allowance is set, a person has at most 4 model requests on the organization's keys on their way at once, across all their runs. A fifth gets `429` with `retry-after`, and the agent's CLI tries again.
- So requests already on their way can take a person past the allowance by at most 4 requests. Each one's output is capped at what it booked; its input can cost more than its estimate when it tokenizes densely or carries images or PDFs, which bill by pixels and pages.
- A request still streaming after 15 minutes stops counting toward the 4.
- If the agent hangs up while an answer is still streaming, Diffinery keeps reading it for about 30 seconds. An answer that takes longer stays charged at its booking, and its place among the 4 frees after 15 minutes.
- An answer that reports no usage, or whose usage can't be read (a streamed line too long to keep, for example), is charged a token per byte sent, plus its output cap.
- A request books at most 1,000,000 output tokens, whatever cap it asks for, and is sent with that cap.
- Runs on a person's own key don't count.

So that a booking holds what a request can use, runs on the organization's key send only what their booking bounds, as [agent reviews](/docs/agents/review) do:

- A request that sets no output cap is sent with the one it was booked for, 32,000 tokens.
- Requests are refused with `403` when they pull in input the request doesn't carry:
  - context stored at the provider: `previous_response_id`, `conversation`, `prompt` or `item_reference` inputs in the Responses API, and an Anthropic `container`;
  - images, documents and files given by URL or file id rather than as their content.
- So are requests that start a background response (any `background` but `false`), ask for more than one answer (`n`), use an OpenRouter web search model (`:online`) or preset (`@preset/...`), or whose body isn't a JSON object, and routing and paid extras (`models`, `route`, `provider`, `plugins`, `web_search_options`, `speed`, `best_of`, `preset`). Reading back a stored response (`GET /v1/responses/...`) is refused too. Claude Code and Codex don't send any of them in normal use.
- Tools that run on the provider (web search, web fetch, code execution, file search, MCP servers, a shell in a hosted environment) are stripped, as in reviews, since each of their steps reads input the request doesn't show. Tools the agent runs itself stay.
- The request is sent as Diffinery read it, written out again, and OpenAI's `openai-organization` and `openai-project` headers are dropped: the key's own defaults apply.
- A refused request costs nothing, and the task goes on.

## Other policies

| Policy | Default | Checked |
| --- | --- | --- |
| **Allowed runtimes**: Claude Code, Codex, custom command | All | When a task, review, coordinator or terminal task starts, and when review or coordinator settings are saved. |
| **Allowed providers**: Anthropic, OpenAI, OpenRouter | All | As above, and on every model request. A custom command gets only the allowed providers' keys. A terminal's task counts as its runtime's provider: Claude Code as Anthropic, Codex as OpenAI. |
| **Most tasks at once per repository**, 1 to 10 | 10 | Each project's own "tasks at once" is held to it. More tasks wait in the queue. The project's settings page says when the organization's limit applies. |
| **Allow web terminals** | On | When a terminal opens. Turning it off closes no open terminal, but no new ones open. |
| **Let terminals run agent tasks** | On | When a terminal opens for tasks, and when a task is given to one. Under **Only the organization's keys**, only members can run tasks in a terminal, though the person's own subscription pays for them. |
| **Allow agent review** | On | When review settings are saved and when each review starts. Turning it off stops new reviews; the pull request's check says why. |

Saving the policy is recorded in the audit log as `org.agent_policy.update`, with the new values, and `site_admin: true` when a site administrator saved it. A repository transferred into the organization takes its limit on tasks at once, and one transferred out drops it.

## Usage

The **Paid with the organization's keys** box on the Settings tab shows owners:

- each person's tokens on the organization's keys this month, against the allowance;
- the runs the organization's keys paid for in the last 30 days, per repository, person and kind.

A person's own **Usage in the last 30 days** (**Settings → Model access**) shows only what they paid for, with their own keys or in their terminal.

## REST API

| Endpoint | Does | Who |
| --- | --- | --- |
| `GET /orgs/{org}/diffinery/agent-policy` | The policy | Owners; any token not limited to repositories |
| `PUT /orgs/{org}/diffinery/agent-policy` | Change it. Fields left out stay as they are. | Owners, browser session only |
| `GET /orgs/{org}/diffinery/model-keys` | The organization's keys: provider, last four characters, who accepted the terms and when | Owners; any token not limited to repositories |
| `PUT /orgs/{org}/diffinery/model-keys/{provider}` | Save a key: `{ "key": "sk-ant-...", "accept_terms": true }` | Owners, browser session with a recent sign-in |
| `DELETE /orgs/{org}/diffinery/model-keys/{provider}` | Delete a key | Owners, browser session with a recent sign-in |
| `GET /orgs/{org}/diffinery/model-usage?days=30` | The runs its keys paid for (1 to 90 days), and each person's tokens this month | Owners; any token not limited to repositories |

A token limited to some repositories gets `403` on all of them. Anyone who isn't a member gets `404`, and a member who isn't an owner gets `403 organization owners only`.

```json
{
  "keys": "either",
  "runtimes": ["claude-code", "codex", "custom"],
  "providers": ["anthropic", "openai", "openrouter"],
  "max_running": 4,
  "terminals": true,
  "terminal_tasks": true,
  "review": true,
  "member_monthly_tokens": 2000000,
  "updated_by": "ayse",
  "updated_at": "2026-10-14T07:02:11.000Z"
}
```

`keys` is `personal`, `either` or `organization`. `member_monthly_tokens` is `null` for no limit.

## Deleting the organization

Deleting an organization removes its model keys, its policy, its allowance counts and the usage its keys paid for (see [Organizations](/docs/accounts/organizations)).

Deleting a person's account keeps the runs the organization's keys paid for in its owners' report, under **Deleted account**.
