---
title: Give an AI coding agent its own account, with guardrails
description: Create an agent account for Claude Code, Codex or any MCP client on Diffinery, connect it, and let the server keep a person in charge of protected branches, merges and secrets.
updated: 2026-10-25
---

On Diffinery, an AI coding agent gets an account of its own, separate from yours: you create it under **Settings → Agents**, give it a token (or let Claude Code or Codex sign in as it through the browser), and its commits, pull requests and comments show as the agent's, on your behalf. The server holds it to guardrails whatever tool it uses: it can't push to or merge into the default branch or protected branches, its pull requests need a person's approval, its own approvals and check results never count, and runs of the code it writes get none of your repository or organization secrets. Repository admins relax these rules, per branch or per repository, when you're ready, for example to let its pull requests merge by themselves once CI passes and a person approves.

## Steps

1. **Create the agent.** Go to **Settings → Agents**, enter an **Agent username** (for example `review-bot`), choose the **Owner** (you, or an organization where you're an owner or admin) and keep the **Maximum role** at **Write**. Click **Create agent**. Only people can create agents, and an organization's agent can reach only that organization's repositories.
2. **Create a token for it**, unless the agent will sign in through the browser (step 4). In the agent's row, open **Create a token for review-bot**, keep the **Scope** at **Write**, choose the **Days** (1 to 366), and click **Create token**. Copy it: it's shown once. Give it to the agent as an environment variable such as `DIFFINERY_TOKEN`, never in a file you commit. See [Tokens for agents](/docs/agents/overview#tokens-for-agents).
3. **Protect the default branch.** Under the repository's **Settings → Branch protection**, add a rule for `main` with **Require a pull request before merging**, at least one **Required approvals**, and your CI checks under **Required status checks**. Agents can't push to the default branch either way; the rule makes sure every change is reviewed and tested. See [Branch protection](/docs/repositories/branch-protection).
4. **Connect the agent** (see [Connect Claude Code, Codex or another MCP client](#connect-claude-code-codex-or-another-mcp-client)).
5. **Tell it how to work**, for example in your agent instructions file: work on a new branch, open a pull request with an `intent` that states the goal, wait for checks with `diffinery pr checks --watch`, and fix failures before asking for review.
6. **Review and merge its pull requests**, by hand or with merge on green (see [Review and merge agent pull requests](#review-and-merge-agent-pull-requests)).

## What the server enforces

These rules hold for Git pushes, the REST API, MCP tools and sandboxes alike, whatever the agent's role:

| Rule | What it means |
| --- | --- |
| Never more access than its owner | Its role is the lowest of its maximum role (write by default), its owner's role on the repository and its token's scope. |
| No pushes to the default branch or protected branches | Pushes and commits there fail with `agents may not push to protected or default branches; open a pull request`. It pushes other branches freely. |
| No merges into the default branch or protected branches | The merge blocker reads `agents may not merge into this branch; a human must merge`. |
| A person approves its pull requests | At least one approval from a person, even on a branch with no rule. An agent's approval never counts; its requested changes still block. |
| Its check results don't count | Commit statuses and check runs an agent reports never satisfy a required check, so it can't mark its own work as passing. |
| No secrets for runs of its code | A workflow run whose code came from an agent gets no repository or organization secrets, only its job token, and its token is held to the same rules. Environment secrets reach it only from environments limited to protected branches, and never on pull request refs. |
| No settings that guard the repository | It can't change branch protection, secrets, variables or environments, dismiss reviews, delete or transfer repositories, or create other agents. |
| No push protection bypass | A push or commit containing something that looks like a credential is always refused. |
| Stamped commits | Commits Diffinery writes for it carry a `diffinery-agent review-bot on-behalf-of diffy` header. |

The full table, with how to relax each rule, is in [Guardrails](/docs/agents/overview#guardrails).

## Connect Claude Code, Codex or another MCP client

Every app connects to the same MCP server, `https://diffinery.com/mcp`. Apps with browser sign-in need no token: on Diffinery's consent page, choose to **act as** your agent, and Write access.

- **Claude Code:** install the CLI and run `diffinery setup`, which adds the Diffinery plugins. Then run `/mcp`, select **plugin:diffinery:diffinery**, choose **Authenticate**, and pick the agent on the consent page. See [Claude Code](/docs/connect/claude-code).
- **Codex:** run `diffinery setup`, add the Diffinery plugin, then run `codex mcp login diffinery` and pick the agent on the consent page. See [Codex](/docs/connect/codex).
- **Cursor, VS Code and other MCP apps:** add `https://diffinery.com/mcp` as a remote HTTP server and sign in. See [Other apps](/docs/connect/other-apps).
- **Headless (CI, scripts, scheduled jobs):** send the agent's token instead. For Claude Code:

  ```sh
  claude mcp add --scope user --transport http diffinery https://diffinery.com/mcp \
    --header 'Authorization: Bearer ${DIFFINERY_TOKEN}'
  ```

  `diffinery mcp-config` prints a snippet for other clients. See [Headless use](/docs/connect/how-sign-in-works#headless-use).
- **Git and the CLI:** with `DIFFINERY_TOKEN` set, `diffinery auth setup-git` lets Git push with it, and `diffinery auth setup-gh` makes `gh pr create` and `gh pr checks` work against Diffinery. See [GitHub CLI](/docs/agents/github-cli).

Ask the agent "Who am I on Diffinery?" to check: the `whoami` tool answers with the agent's login.

**Cloud environments.** For a Claude Code cloud environment, or any other agent sandbox, open the repository's **Settings → Agent setup** and choose **Generate agent token**. It makes an agent that can reach only that repository and gives you the allowed domain, a one-line setup script and the environment variables to paste. A **Check** turns green once a session has set itself up. See [Cloud agent environments](/docs/connect/cloud-agents).

## Review and merge agent pull requests

- **Find what needs you.** [Today](/docs/agents/today), the first page after signing in, lists **Agent PR needs a person's approval** for agent pull requests no person has approved at their latest commit.
- **Read the intent first.** Every pull request can carry an `intent`, one or two sentences on what the change is meant to do, shown at the top so you can check the diff against it. See [Pull requests](/docs/collaboration/pull-requests).
- **Approve, then merge.** You (or anyone with write access other than the agent) approve. The agent's owner can approve, because the owner is a different account from the agent.
- **Let it merge on green.** An admin opens the repository's **Settings → Merge on green**, ticks the checks that must pass and the agents, and chooses whether agents' pull requests merge **Once the checks pass and a person approved** or **As soon as the checks pass**. Each agent pull request then merges by itself when its conditions are met. See [Merge on green automatically](/docs/collaboration/merge-on-green).
- **Or allow auto-merge per branch.** **Allow agents to land pull requests through auto-merge** on a branch's rule (with at least one required check) lets the agent turn on auto-merge for its own pull requests (`enable_auto_merge` over MCP, or `diffinery pr merge --auto`). Diffinery merges once every rule is met; if the agent pushes again, a person approves again. See [Agents landing changes](/docs/repositories/branch-protection#agents-landing-changes).
- **Workflow changes always need a person.** A pull request that adds, changes or deletes a workflow file never lands through an agent's auto-merge: CI can't vouch for a change to itself.
- **Plan for deploys after agent merges.** A merge that auto-merge makes for an agent is the agent's push, so later runs on that branch are runs of agent code and get no repository or organization secrets. Keep deploy credentials in an environment limited to protected branches, or have an admin turn on **Give runs of agent code the repository's and organization's secrets**. See [Which runs receive secrets](/docs/actions/secrets-and-variables#which-runs-receive-secrets).

To have one of your agents review pull requests for bugs before you do, turn on [Agent review](/docs/agents/review). To give an agent a goal and get a pull request back, see [Agent tasks](/docs/agents/tasks).

## Audit what agents did

- **On every item:** agents have an `agent` badge and `on behalf of <owner>` next to their name on pull requests, reviews, comments and workflow runs, and the API returns `"type": "Bot"` for them.
- **In Git:** commits Diffinery writes for an agent carry the `diffinery-agent ... on-behalf-of ...` header, covered by the commit's SHA. See it with `git cat-file -p <sha>`.
- **Its tokens:** **Settings → Agents** lists each agent's tokens with their scope and last use, and a **revoke** link. Diffinery sends a security email when an agent or an agent token is created.
- **The audit log:** site administrators see every audited action under **Settings → Audit log**, with the agent as the actor and its owner alongside (`review-bot for diffy`). See [Audit log](/docs/security/audit-log).
- **Cut it off:** revoke one token to stop one running copy, or **Disable** the agent under **Settings → Agents** to revoke all its tokens at once.

## Frequently asked questions

### Can an AI agent push to main on Diffinery?

Not by default. Agents can't push to the default branch or to any protected branch; they push a branch and open a pull request. A repository admin can allow it on a branch's protection rule with **Allow agents to push directly**.

### Can an agent approve or merge its own pull request?

An agent's approval never counts toward required approvals, and agents can't merge into the default branch or protected branches. A person approves its pull request. A repository admin can let agents land approved pull requests through auto-merge, so CI and a person decide rather than the agent, or waive the approval so green required checks are enough.

### Can an agent read my repository secrets?

Agents can't create, change or delete secrets, and a workflow run of code an agent wrote gets no repository or organization secrets unless a repository admin turns that on. Environment secrets reach such a run only from environments limited to protected branches, and never on pull request refs. Agents with write access can read Actions variables, which aren't secret.

### Which AI coding agents work with Diffinery?

Any agent that uses Git, the GitHub CLI, the REST API or MCP. There are guides for [Claude](/docs/connect/claude), [Claude Code](/docs/connect/claude-code), [Codex](/docs/connect/codex), Cursor and VS Code ([Other apps](/docs/connect/other-apps)).

### How do I take away an agent's access?

Revoke its token under **Settings → Agents**, or click **Disable** next to the agent to revoke all its tokens at once. An app connected through the browser is disconnected under **Settings → Access tokens → Connected apps**.
