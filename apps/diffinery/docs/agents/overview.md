---
title: Agents
description: Agent accounts for AI tools and automation, how to create them and their tokens, what they can and can't do, and how to connect a coding agent.
---

An agent is an account for an AI tool or an automation, owned by a person or an organization. It has its own login and tokens, acts on behalf of its owner, and is held to guardrails that keep a human in the loop on protected branches. Give each AI coding agent, review bot or script its own agent account instead of a personal token.

## What an agent is

- **An account of its own.** An agent has a login (for example `review-bot`), a display name and its own tokens. Everything it does is recorded under its login, with its owner alongside.
- **Owned by a person or an organization.** The owner is set when the agent is created. Security emails about the agent go to its owner (for an organization, to the organization's owners and admins).
- **Tokens only.** Agents authenticate with `dfy_` tokens over git, the REST API, the CLI and MCP. They can't have passkeys, so they can't sign in to the web UI, and they have no notification settings.
- **Never more than its owner.** An agent's role on a repository is capped by a maximum role (write by default) and by its owner's own role there.
- **Guardrails everywhere.** The same rules apply to git pushes, the REST API, MCP tools and sandboxes. See [Guardrails](#guardrails).

## Create an agent

Only people can create agents. To create an agent owned by an organization, you must be an owner or admin of that organization. Creating an agent or an agent token needs a sign-in from the last 2 hours; if yours is older, Diffinery asks you to [Confirm it's you](/docs/security/overview#confirming-its-you) with your passkey first.

The agent's login follows the same rules as usernames: letters, digits, `-` and `_`, starting with a letter or digit, up to 100 characters, no dots, and not a reserved name (such as `api`, `mcp`, `settings` or `admin`).

### In the web UI

1. Go to **Settings → Agents** (`https://diffinery.com/settings/agents`).
2. Under **Create an agent**, fill in:
   - **Agent username**, for example `review-bot`.
   - **Display name** (optional), for example `Review bot`. Without one, the agent's username is shown.
   - **Owner**: yourself, or an organization where you are an owner or admin.
   - **Maximum role**: the highest role the agent can have on any repository (default `write`).
3. Click **Create agent**. You see `Agent created. Create a token for it below.`
4. In the agent's row, expand **Create a token for review-bot**, set the token **Name**, **Scope** and **Days** (1 to 366, default 30), and click **Create token**.
5. Copy the token from **Token for review-bot**. It is shown only once.

### With the CLI

Creating an agent mints its first token, and no token can create a token, so on a deployed instance create agents in the web UI (above). `diffinery agent create` works against a local development server. Listing and disabling agents work from the CLI with a personal token that has the `admin` scope and isn't restricted to repositories:

```sh
curl -fsSL https://diffinery.com/install | bash
diffinery login --scope admin
```

On a local development server, create the agent like this. The command also creates its first token and prints it once:

```sh
diffinery agent create review-bot --org acme --name "Review bot" --scope write --expires-days 90
```

| Flag | Meaning |
| --- | --- |
| `-o, --org ORG` | Owned by this organization instead of you |
| `-n, --name NAME` | Display name |
| `-s, --scope SCOPE` | Token scope: `read`, `write` (default) or `admin`. Repeatable. |
| `-e, --expires-days DAYS` | Token lifetime in days (default 90) |
| `--json` | Print the agent and token as JSON |

The output ends with `This token (expires 2027-01-11) will not be shown again. Give it to the agent as DIFFINERY_TOKEN.` The CLI creates agents with the default maximum role, `write`.

`diffinery agent list` lists the agents you and your organizations own, and `diffinery agent disable review-bot` disables one.

### With the REST API

Creating an agent mints a token, so it needs a browser session: a token gets `403 creating tokens needs a browser session: sign in at https://diffinery.com/settings/tokens`. Send it from a page on your instance while signed in, for example from the browser console:

```js
await fetch("/api/v3/diffinery/agents", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    login: "review-bot",
    name: "Review bot",
    org: "acme",
    policy: { maxRole: "write" },
    token: { scopes: ["write"], expires_in_days: 90 },
  }),
}).then((r) => r.json());
```

The response (`201`) contains the agent (`id`, `login`, `name`, `type: "Bot"`, `html_url`) and its first token (`token`, `id`, `expiresAt`). Leave out `org` to own the agent yourself, `policy.maxRole` for the default `write`, and `token` for a `write` token that lasts 90 days.

`token.scopes` (and `scopes` when you create another token) must be a non-empty list of `read`, `write` and `admin`; leaving it out gives `["write"]`. An empty list or an unknown name returns `422 scopes must be a non-empty list of: read, write, admin`.

The `POST` endpoints below create tokens, so they need a browser session. `DELETE` also accepts a personal token with the `admin` scope that isn't restricted to repositories.

| Endpoint | Purpose | Who |
| --- | --- | --- |
| `GET /api/v3/diffinery/agents` | List agents owned by you and by organizations where you are an owner or admin | You |
| `POST /api/v3/diffinery/agents` | Create an agent and its first token | People |
| `POST /api/v3/diffinery/agents/{login}/tokens` | Create another token (`name`, `scopes`, `expires_in_days`) | The owner, or an owner or admin of the owning organization |
| `DELETE /api/v3/diffinery/agents/{login}` | Disable the agent and revoke its tokens | The owner, an owner or admin of the owning organization, or a site admin |

## Tokens for agents

Agent tokens work like personal tokens (see [Tokens](/docs/accounts/tokens)):

- They start with `dfy_` and are sent as `Authorization: Bearer dfy_...` (or as the password for git over HTTPS).
- Each has a scope that caps the role it acts with: `read` (read), `write` (up to maintain) or `admin`. Use `write` for coding agents. A `read` token can't change anything at all: pushes, commits, comments, reviews and every MCP tool that isn't read-only get `403 this token needs the write scope`. Give `read` tokens only to agents that just look.
- Each expires after 1 to 366 days. Diffinery emails the owner before an agent token expires.
- Creating a token for an agent sends a security email to the agent's owner (for an organization, its owners and admins): `A token was created for the agent review-bot`.
- In **Settings → Agents**, each agent lists its tokens with scope and last use, and a **revoke** link.

Give each running agent its own token, store it as a secret in the agent's environment (for example `DIFFINERY_TOKEN`), and revoke it when the agent no longer needs it.

## Roles and access

An agent made on a repository's **Settings → Agent setup** reaches that one repository and nothing else, whatever token it uses ([Cloud agent environments](/docs/connect/cloud-agents#the-token)). For every agent, its role on a repository is the lowest of:

1. **Its cap on that repository.** If the agent was added as a collaborator on the repository (**Settings → Collaborators**, **Username (person or agent)**), that role. Otherwise its **Maximum role** (default `write`).
2. **Its owner's role there.**
   - An agent owned by a person has at most that person's role on the repository, so it can reach exactly the repositories its owner can.
   - An agent owned by an organization can reach only the organization's own repositories, and nothing outside the organization.
3. **Its token's scope**, as for any token.

Agents rarely need more than write. Write is enough to push branches, commit files, open and review pull requests, run workflows and use sandboxes. Whatever the role, the guardrails below still apply.

The agent's profile page (`https://diffinery.com/review-bot`) shows who it **Acts on behalf of**, its **Maximum role**, its **Status** and when it was **Created**.

## Guardrails

These rules apply to agents through git, the REST API, MCP and sandboxes:

| Rule | Details | How to relax it |
| --- | --- | --- |
| No pushes to the default branch or protected branches | Pushes, `commit_files`, the contents API, the git data refs API, the merges API, update-branch and branch updates are refused with `agents may not push to protected or default branches; open a pull request`. One exception: in an empty repository (no branches yet), an agent may push the first commit of the default branch, as creating a repository with a README would, unless a protection rule covers that branch or the commit adds workflow files (those come in a pull request a person merges). | Tick **Allow agents to push directly** (`agentsMayPush`) on that branch's protection rule. |
| No merges into the default branch or protected branches | The merge blocker `agents may not merge into this branch; a human must merge`. Agents can't add pull requests to a merge queue or turn on auto-merge there either. | An agent from **Settings → Agent setup** may merge what a person approved, with **Can merge pull requests** (on by default; see [Merging](/docs/connect/cloud-agents#merging)). Or tick **Allow agents to merge pull requests** (`agentsMayMerge`) on the rule, or, so that CI decides instead of the agent, **Allow agents to land pull requests through auto-merge** (`allowAgentAutoMerge`, see [Agents landing changes](/docs/repositories/branch-protection#agents-landing-changes)); the agent then turns on [auto-merge](/docs/collaboration/pull-requests#auto-merge-for-agents-and-workflow-tokens) with `enable_auto_merge` or `PUT /repos/{owner}/{repo}/pulls/{number}/auto-merge`. |
| Pull requests opened by agents need a human approval | At least one approval from a person, even on a branch with no protection rule. When an agent has Diffinery land its pull request on the default branch or a protected branch through auto-merge or the merge queue, the approval counts only for the commit it approved. | Only for landings an agent asked for: **Let agents' auto-merges land without an approving review** (`agentAutoMergeWithoutApproval`), which lets green required checks stand in for the approval. See [Waiving approvals for agents](/docs/repositories/branch-protection#waiving-approvals-for-agents). To have Diffinery turn auto-merge on for chosen agents' pull requests by itself, name them in **Auto-merge pull requests from these agents** (`autoMergeAgents`, see [Auto-merging agents' pull requests](/docs/repositories/branch-protection#auto-merging-agents-pull-requests)), or tick the agent's own **Merge its pull requests on green**. The repository's **Settings → Merge on green** sets all of it up at once; see [Merge on green automatically](/docs/collaboration/merge-on-green). |
| Agent approvals don't count | An agent's Approve review is shown but never counts toward required approvals. An agent's Request changes review still blocks. | None. |
| No branch protection changes | `agents cannot change branch protection` | None. |
| No secret management | Setting or deleting repository or environment secrets fails with `agents cannot manage secrets`, and agents can't use the organization secrets endpoints, whatever their role. | None. |
| No variable changes | Creating, changing or deleting repository or environment Actions variables fails with `agents cannot manage variables`, whatever the agent's role. Agents with write or higher can still list and read variables. | None. |
| No environment changes | Creating, changing or deleting an environment or its deployment branch policies fails with `only repository admins (people, not agents) can manage environments`. | None. |
| Agent reports never satisfy required checks | Commit statuses and check runs an agent reports are shown on the commit, but never count toward a required status check, and aren't counted when a deployment checks the commit's statuses. A failure reported by the real source still fails. | None. Report required checks from workflows or from a person's token. |
| Workflow runs of agent code act as the agent | A run counts as coming from an agent when an agent triggered it, an agent pushed the branch or tag it runs on last, (for pull request events) an agent opened the pull request or last pushed its head branch, or (off the default branch) its code includes a commit an agent pushed that a person hasn't merged into the default branch yet, whoever pushed, tagged or dispatched on top. Re-runs of such a run keep this, whoever starts them, and so do `workflow_run` runs that follow it, since they act on what it produced. The run's jobs act as an agent: their `GITHUB_TOKEN` gets the guardrails in this table, so it can't push or merge to the default or protected branches even with `permissions: contents: write`, and their deployments count as an agent's. Agent-written code can't reach a protected branch through a workflow. | The same per-branch settings, **Allow agents to push directly** and **Allow agents to merge pull requests**. |
| No repository or organization secrets for agent runs | A run whose code came from an agent (see the row above) gets no repository or organization secrets, only its job token, so an agent can't push a workflow that sends them elsewhere. Once an agent lands a pull request on the default branch through auto-merge, runs on that branch are agent code too, so a deploy there gets no repository secrets. | A repository admin who is a person ticks **Give runs of agent code the repository's and organization's secrets** under **Settings → Actions** (`agent_runs_use_secrets`), or, tighter, keeps deploy credentials in an environment limited to protected branches (next row). See [Which runs receive secrets](/docs/actions/secrets-and-variables#which-runs-receive-secrets). |
| No environment secrets for agent runs on open environments | A job with `environment:` in a run whose code came from an agent (see the row above) gets the environment's secrets only when the environment is limited to protected branches. Pull request runs never get environment secrets. | Limit the environment to **protected branches**. |
| Agent tags don't match environment tag rules | A tag last pushed or moved by an agent never matches an environment's tag pattern, so it can't deploy to that environment. | Have a person push the tag. |
| No review dismissal | Dismissing a review fails with `agents can't dismiss reviews`, whatever the agent's role. | None. |
| No repository deletion | `agents cannot delete repositories` | None. |
| No repository transfers | `agents and workflow tokens cannot transfer repositories`. Only people move repositories to another owner. | None. |
| No push protection bypass | Only repository admins who are people can commit past secret scanning, with `git push -o allow-secrets=<reason>` or `allow_secrets` on `POST /repos/{owner}/{repo}/diffinery/commits`. An agent's push or commit that contains a credential is always refused (and `commit_files` has no bypass at all); see [Push protection](/docs/security/push-protection). | None. |
| No admin bypass of merge requirements | Merging past unmet branch rules (`"bypass_rules": true`) or past the merge queue (`"bypass_merge_queue": true`) is for repository admins who are people. An agent's merge with these flags is still refused with the usual blockers. | None. |
| No creating agents | `only people can create agents` | None. |
| Imports from GitHub only where the owner may import | A person's agent imports into the owner's own account or an organization the owner owns or administers; an organization's agent imports into that organization (`agents can import only where their owner may: ...`). Its maximum role must be at least `write`. | None. |
| No push protection bypass in imports | An agent's import always stops when old history contains something that looks like a credential, whatever it asks for. | A person who administers the target starts the import. |
| No variables, secret names or environments in imports | The import's variables steps are skipped (`skipped (agents cannot manage variables)`). | A person sets them up after the import. |
| No import retry once the repository exists | `an agent cannot retry an import after the repository was created; a person who administers <owner> must retry it` | A person who administers the target retries it. |

The default branch is protected from agents even if it has no protection rule. Agents can still push freely to other branches, open pull requests, comment, review, run workflows, report commit statuses and check runs, create releases and start sandboxes, within their role.

To let a trusted agent push to a release branch, for example, add a protection rule for `release/*` with **Allow agents to push directly**. See [Branch protection](/docs/repositories/branch-protection), [Checks and statuses](/docs/collaboration/checks-and-statuses) and [Environments](/docs/actions/environments).

## How agent activity is recorded

### Commits

Commits that Diffinery writes for an agent are stamped with an extra header naming the agent and its owner, `diffinery-agent review-bot on-behalf-of diffy`. This covers commits made through:

- the `commit_files` MCP tool and `POST /repos/{owner}/{repo}/diffinery/commits`;
- the contents API (`PUT` and `DELETE /repos/{owner}/{repo}/contents/{path}`);
- the git data API (`POST /repos/{owner}/{repo}/git/commits`);
- the merges API (`POST /repos/{owner}/{repo}/merges`) and updating a pull request's branch (`PUT /repos/{owner}/{repo}/pulls/{number}/update-branch`);
- merge and squash commits of pull requests the agent merges, directly or through auto-merge.

The author and committer are the agent, for example `review-bot <review-bot@users.noreply.diffinery.com>`, unless the request sets `author` or `committer` (the contents and git data APIs accept them). The header is added either way.

The header is part of the commit, so it is covered by the commit's SHA and travels with it. See it with `git cat-file`:

```sh
git cat-file -p 9be41d07
```

```text
tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904
parent 51c0e2aa...
author review-bot <review-bot@users.noreply.diffinery.com> 1791883964 +0000
committer review-bot <review-bot@users.noreply.diffinery.com> 1791883964 +0000
diffinery-agent review-bot on-behalf-of diffy

Fix the Contact sales link
```

Commits an agent makes with its own git client and pushes are stored as the client wrote them. Inside a [sandbox](/docs/agents/sandboxes), git is preconfigured to author commits as the agent.

### Everywhere else

- **Web UI:** agents have a bot avatar, an `agent` badge and `on behalf of <owner>` next to their name on issues, pull requests, reviews, comments and workflow runs.
- **REST API:** user objects for agents have `"type": "Bot"` (people are `"User"`, organizations `"Organization"`). `diffinery whoami` adds `[agent]`, and the MCP `whoami` tool returns `kind: "agent"` and `on_behalf_of`.
- **Webhooks:** the `sender` of an event caused by an agent has `"type": "Bot"` and `on_behalf_of` set to the owner's login.
- **Audit log:** entries for agent actions (pushes, merges and other audited actions) record the owner in `on_behalf_of`. Creating, disabling and enabling agents, and creating agent tokens, are audited (`agent.create`, `agent.disable`, `agent.enable`, `agent.token.create`). See [Audit log](/docs/security/audit-log).
- **Email:** the person who creates an agent gets a security email, `A new agent was added: review-bot`, which can't be turned off.

## Imports from GitHub

Agents can import a GitHub repository with the `start_github_import` MCP tool (or `POST /api/v3/diffinery/imports`, or `diffinery migrate github` with the agent's token), and follow it with `get_import` and `list_imports`. The import runs on the server and copies the Git history, issues and pull requests with their numbers, comments, reviews, labels, milestones, branch protection and releases. The agent rules:

- The target must be somewhere the agent's owner may import: for a person's agent, the owner's own account or an organization the owner owns or administers; for an organization's agent, that organization.
- The agent's maximum role must be at least `write`, and its token needs the `write` scope.
- Push protection is never bypassed: the `secrets` option is always `stop`, so history with something that looks like a credential fails the import instead of being imported.
- Actions variables, secret names, environments and organization variables are skipped. Agents never read or set secret values.
- Once the repository exists, the agent can't retry a failed import; a person who administers the target retries it.
- The agent sees only the imports it started.

Everything the import writes fires no workflows, webhooks or notifications, and the repository is locked against other writes until the import ends. Imported reviews never count as approvals, so an imported open pull request still needs a fresh human approval. See [Migrate from GitHub](/docs/migrate-from-github#agents-and-imports) and [Imports over MCP](/docs/agents/mcp#imports-over-mcp).

## Disable an agent

Disabling an agent revokes all its tokens at once.

- **Web UI:** **Settings → Agents**, click **Disable** next to the agent. **Enable** turns it back on, but its old tokens stay revoked: create a new token.
- **CLI:** `diffinery agent disable review-bot`
- **REST API:** `DELETE /api/v3/diffinery/agents/review-bot` (returns `204`).

To cut off one running copy without disabling the agent, revoke just its token.

## Agent tasks, agent review and Today

- **[Agent tasks](/docs/agents/tasks)**: on a repository's **Project** tab, give one of your agents a goal. Diffinery runs Claude Code or Codex (on their own providers, or via [OpenRouter](/docs/agents/tasks#openrouter) on a model you choose) or your own command in a sandbox as that agent, with your own model API key (saved under **Settings → Model access**, and never placed in the sandbox), then pushes a branch and opens a pull request for review.
- **[Projects](/docs/agents/projects)**: the Project tab shows a repository's tasks on a board, with a conversation, a shared memory every task reads, project instructions, and a limit on how many tasks run at once. Your own coordinator agent can turn your posts there into tasks.
- **[Agent review](/docs/agents/review)**: one of your agents reviews pull requests for bugs, security issues and logic errors, like Cursor's Bugbot. It posts inline findings and an **Agent review** check, and **Fix it** starts a task that pushes the fix.
- **[Terminals](/docs/agents/terminal)**: a shell in your browser, in a sandbox with the repository checked out, acting as one of your agents. Start Claude Code or Codex there and sign in with your own Claude or ChatGPT subscription instead of an API key, then work in it yourself or [give it a task](/docs/agents/terminal#give-it-a-task) that runs on that subscription and opens a pull request.
- **[Today](/docs/agents/today)**: the first page after signing in, also `GET /api/v3/diffinery/today` and the `today` MCP tool. It shows the pull requests that need you, your agents' open pull requests and tasks, and what merged, was released or failed in the last 24 hours.

## Set up a coding agent

Coding agents such as Claude Code, Cursor or a CI bot can work with Diffinery in two ways:

- **MCP:** the agent calls tools on `https://diffinery.com/mcp` to read files, commit, open pull requests, follow CI and run commands in sandboxes, with no git client needed. Best for agents that already speak MCP.
- **git and the CLI:** the agent clones the repository, edits files locally, pushes a branch, and uses the `diffinery` CLI for pull requests and CI.

### Recommended setup

For an agent in a cloud sandbox, such as a Claude Code cloud environment, the repository's **Settings → Agent setup** does steps 1, 3 and 4 for you: it makes an agent that can only reach that repository, and gives you the token, setup script and environment variables to paste. See [Cloud agent environments](/docs/connect/cloud-agents).

1. **Create an agent** owned by you or your organization, with maximum role `write`, and a `write` token.
2. **Protect the default branch:** add a branch protection rule with **Require a pull request before merging**, at least one **Required approvals**, and your CI checks in **Required status checks**. Agents can't push to it either way; the rule makes sure every change is reviewed and tested.
3. **Give the token to the agent** as an environment variable, for example `DIFFINERY_TOKEN`, never committed to a repository.
4. **Connect the agent** with MCP or git, as below.
5. **Tell the agent how to work.** For example, in your agent instructions file: work on a new branch, open a pull request with an `intent` that states the goal, wait for checks with `diffinery pr checks --watch` or `list_workflow_runs`, and fix failures before asking for review.

### Connect over MCP

claude.ai, Claude Code and Codex can sign in through your browser instead of using a token, and a plugin teaches Claude Code and Codex how Diffinery repositories work: see [Connect AI apps](/docs/connect). With a token, for Claude Code:

```sh
claude mcp add --transport http diffinery https://diffinery.com/mcp \
  --header "Authorization: Bearer dfy_..."
```

For Cursor, add to `.cursor/mcp.json` (or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "diffinery": {
      "url": "https://diffinery.com/mcp",
      "headers": { "Authorization": "Bearer dfy_..." }
    }
  }
}
```

`diffinery mcp-config` prints a ready-made snippet that reads the token from `${DIFFINERY_TOKEN}`. See [MCP server](/docs/agents/mcp) for other clients, the tool list and example calls.

### Connect with git and the CLI

```sh
export DIFFINERY_TOKEN=dfy_...
diffinery auth setup-git                       # git uses the token for https://diffinery.com
git clone https://diffinery.com/acme/website.git
cd website
git switch -c fix-pricing-link
# ...edit and commit...
git push -u origin fix-pricing-link
diffinery pr create --title "Fix the Contact sales link" \
  --intent "Point the Contact sales link at /contact; no other changes."
diffinery pr checks --watch                    # wait for this branch's pull request: exit 0 passed, 1 failed
```

As with `gh`, `pr view`, `pr checks`, `pr diff`, `pr comment`, `pr review`, `pr ready` and `pr merge` act on the open pull request for the current branch when you leave out its number. Without `--watch`, `diffinery pr checks` returns at once and exits `8` while checks are still pending.

The CLI reads `DIFFINERY_TOKEN` (and `DIFFINERY_URL`, which defaults to `https://diffinery.com`) from the environment, so no `diffinery login` is needed. Without the CLI, use the token as the git password: `git clone https://x-token:dfy_...@diffinery.com/acme/website.git`.

## Differences from GitHub

- Agents are accounts owned by a person or an organization, rather than GitHub Apps with installations, and authenticate with ordinary `dfy_` tokens.
- Agents are held to built-in guardrails (no pushes or merges to default and protected branches, human approval for their pull requests, agent approvals not counted) that you relax per branch with `agentsMayPush`, `agentsMayMerge`, `allowAgentAutoMerge` and `agentAutoMergeWithoutApproval`; `autoMergeAgents` has Diffinery turn auto-merge on for chosen agents by itself. The guardrails also hold for workflow runs of code an agent wrote, so an agent can't use a workflow's `GITHUB_TOKEN` to get around them.
- Commit statuses and check runs reported by agents never satisfy required checks, and agents can't manage environments, secrets or Actions variables, or dismiss reviews.
- Agents can run GitHub imports, within the import rules above.
- Commits Diffinery writes for agents carry a `diffinery-agent ... on-behalf-of ...` header.

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| `agents may not push to protected or default branches; open a pull request` | Push to a new branch and open a pull request, or enable **Allow agents to push directly** on that branch's rule. |
| `agents may not merge into this branch; a human must merge` | A person must merge. Or turn on auto-merge (`enable_auto_merge`) on a branch whose rule allows it (`allowAgentAutoMerge`), or enable **Allow agents to merge pull requests** on the rule. |
| `needs 1 more approving review(s)` on an agent's pull request | A person with write access must approve it. Agent approvals don't count. |
| `only people can create agents` | You called the agents API with an agent's token. Use your own. |
| `agents cannot manage secrets` | A person with admin access must set or delete repository, environment and organization secrets. |
| `agents cannot manage variables` | A person with admin access must create, change or delete repository and environment variables. |
| A workflow on the agent's branch fails to push to `main` with `agents may not push to protected or default branches; open a pull request` | The run's code came from an agent, so its job token acts as the agent. Open a pull request from the branch and have a person merge it. |
| `push protection: possible secret detected (...)` from `commit_files` or the commits API | A file the agent committed looks like a credential. Remove it, or mark a test fixture with `diffinery:allow-secret`. Agents can't bypass push protection. |
| `this token needs the write scope` | The agent's token has only the `read` scope. Create a `write` token for it. |
| `this token needs the admin scope` | Creating agents or agent tokens, or disabling an agent, through the API or CLI needs your personal `admin` token. |
| `this token is limited to repositories and can't change account settings` | Managing agents needs a personal token without a repository list. |
| `scopes must be a non-empty list of: read, write, admin` | The `scopes` you sent were empty or had an unknown name. |
| `only repository admins (people, not agents) can manage environments` | A person with admin access must create or change the environment. |
| `agents can't dismiss reviews` | A person with maintain access must dismiss the review. |
| `required check 'NAME' has not run` although an agent reported it | Agent reports never satisfy required checks. Report it from a workflow or with a person's token. |
| `only organization admins can create organization agents` | You must be an owner or admin of the organization. |
| `invalid or reserved agent name` | Use letters, digits, `-` and `_`, no dots, and avoid reserved names. |
| `name already taken` | Pick another login; agents share the namespace with people and organizations. |
| `not your agent` | Only the owner, or an owner or admin of the owning organization, can manage it. |
| `repository not found` for a repository you can see | The agent's owner (or, for an organization agent, the organization) has no access to it. |
| `agents can import only where their owner may: ...` | Import into the owner's own account or an organization the owner administers; an organization's agent imports only into that organization. |
| `this agent's policy does not allow writing; an import needs at least write` | Raise the agent's **Maximum role** to `write` or higher. |
| `skipped (agents cannot manage variables)` on an import | Expected for an agent's import. A person sets variables, environments and secrets afterwards. |
| `invalid, expired or revoked token` | The token expired or was revoked, or the agent is disabled. Create a new token. |
