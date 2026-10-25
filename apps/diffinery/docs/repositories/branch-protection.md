---
title: Branch protection
description: Protect branches with rules for pull requests, approvals, required checks, force pushes, deletion, agents and merge queues, from the web UI or the API.
---

Branch protection rules control how matching branches can change: whether changes must go through a pull request, how many approvals and which checks a pull request needs, whether force pushes and deletion are allowed, and what agents may do. Diffinery enforces the rules on the server for every way a branch can change: `git push`, the REST API, MCP tools and the web UI.

## Concepts

A rule has a **branch name pattern** and a set of **rules**. A branch is protected when a pattern matches its name. A pattern is stored per repository, and you need the **admin** role on the repository to create, change or delete rules.

Two protections apply even when a repository has no rules at all:

- The default branch cannot be deleted.
- Agents cannot push directly to the default branch or merge pull requests into it. A rule matching the default branch can allow them (see [Agent rules](#agent-rules)).

Some pull request rules also apply without any branch protection:

- A pull request that has a "changes requested" review from anyone is blocked until that reviewer approves, a new review from them replaces it, or the review is dismissed.
- A pull request opened by an agent needs at least one approval from a person.

### Patterns

| Pattern | Matches | Does not match |
|---|---|---|
| `main` | `main` | `main2`, `feature/main` |
| `release/*` | `release/1.0`, `release/next` | `release/1.0/hotfix`, `release` |
| `release/**` | `release/1.0`, `release/1.0/hotfix` | `release` |
| `**` | every branch | |
| `v?` | `v1`, `v2` | `v10` |

- `*` matches any characters except `/` (within one path segment).
- `**` matches any characters, including `/`.
- `?` matches exactly one character other than `/`.
- Everything else matches literally, and the pattern must match the whole branch name.
- Patterns cannot contain spaces.

### Which rule applies

Only one rule applies to a branch; settings from several matching rules are never combined. When more than one pattern matches a branch, Diffinery picks the rule the same way GitHub does:

1. A rule whose pattern is exactly the branch name wins. For branch `main`, a `main` rule beats `*` and `**`.
2. Otherwise, the oldest matching rule wins: the one created first.

For example, with a `**` rule created first and a `release/*` rule created later, `release/1.0` follows the `**` rule. Add a rule named exactly `release/1.0` if that branch needs its own settings.

Saving an existing rule (from the web UI or with `PUT` on its pattern) keeps its age. Changing a rule's pattern in the web UI deletes the old rule and creates a new one, so the renamed rule becomes the newest. The **Branch protection** page lists rules alphabetically, not in this order.

The same rule decides pushes, merges, merge blockers, the merge queue, the **protected** badge and environment branch policies that allow only protected branches.

## Rule settings

These are the fields of a rule, as JSON (`ProtectionRules`) with their labels on the **Branch protection** settings page. Every field is optional; a missing field means `false` or none.

On the page, a rule's settings come in sections: the branch name pattern first, then **Pull requests and reviews**, **Status checks**, **Pushes and history**, **Agents** and **Merge queue**, with **Save rule** (or **Create rule**) at the bottom. Each field has its label above it and its explanation under it.

| JSON field | UI label | Type | Default | Effect |
|---|---|---|---|---|
| `requirePullRequest` | Require a pull request before merging | boolean | `false` | Direct pushes to matching branches are rejected, including creating a new matching branch by push. Changes land by merging pull requests. |
| `requiredApprovals` | Required approvals | number | `0` | Approving reviews from people needed before a pull request can merge. The UI accepts 0 to 10. |
| `dismissStaleReviews` | Dismiss stale approvals when new commits are pushed | boolean | `false` | When the pull request's branch moves, approvals given on older commits stop counting and are marked dismissed. |
| `requiredChecks` | Required status checks | array of strings | none | Check run names or commit status contexts that must pass on the pull request's head commit. See [Required checks](#required-checks). |
| `requiredCheckSources` | none (API only) | object | none | Binds a required check to the one account whose reports count: check name to reporter login, or `diffinery-actions`. See [Binding a check to a reporter](#binding-a-check-to-a-reporter). |
| `allowForcePush` | Allow force pushes | boolean | `false` | Allows non-fast-forward updates to matching branches. |
| `allowDeletion` | Allow deletion | boolean | `false` | Allows deleting matching branches. |
| `requireLinearHistory` | Require linear history | boolean | `false` | Pushes containing merge commits are rejected, a pull request must be up to date with its base to merge, merging with the `merge` method is refused (`main requires linear history; use squash or rebase`), and the API's default merge method becomes squash. |
| `enforceAdmins` | Do not allow administrators to bypass these rules | boolean | `false` | Applies the rules to repository admins too. |
| `agentsMayPush` | Allow agents to push directly | boolean | `false` | Lets agents push to matching branches. |
| `agentsMayMerge` | Allow agents to merge pull requests | boolean | `false` | Lets agents merge pull requests into matching branches. |
| `allowAgentAutoMerge` | Allow agents to land pull requests through auto-merge | boolean | `false` | Lets agents (and workflow tokens) turn on auto-merge or add pull requests to the merge queue for matching branches, so Diffinery merges once every rule is met. Needs at least one required check. See [Agents landing changes](#agents-landing-changes). |
| `agentAutoMergeWithoutApproval` | Let agents' auto-merges land without an approving review | boolean | `false` | With `allowAgentAutoMerge`: what Diffinery lands for agents needs no approval from a person, only green required checks. Requested changes still block it, and a workflow change still needs a person. See [Waiving approvals for agents](#waiving-approvals-for-agents). |
| `autoMergeAgents` | Auto-merge pull requests from these agents | array of agent logins | none | With `allowAgentAutoMerge`: Diffinery turns auto-merge on by itself for pull requests these agents open into matching branches, so nobody has to click Merge or turn auto-merge on. Stored as `{ "id", "login" }` objects. See [Auto-merging agents' pull requests](#auto-merging-agents-pull-requests). |
| `autoMergeMethod` | Their merge method | `merge`, `squash` or `rebase` | as the branch merges | How what `autoMergeAgents` turns on merges. Without it: the merge queue's method, else squash with `requireLinearHistory`, else a merge commit. |
| `mergeQueue` | Require a merge queue | object | none | Pull requests merge through a merge queue. See [Merge queue settings](#merge-queue-settings). |

### Required checks

A required check is matched by its exact name against two kinds of reports on the pull request's head commit (and on a merge group commit, when a [merge queue](/docs/collaboration/merge-queue) is used):

- **Check runs.** For Diffinery Actions jobs the check name is `<workflow name> / <job name>`, for example `ci / test` for job `test` in a workflow with `name: ci`. External CI systems and bots create check runs with `POST /repos/{owner}/{repo}/check-runs` and choose their own `name`.
- **Commit statuses.** A status's `context` counts as a check name, as on GitHub, so a required check can name a status that external CI posts with `POST /repos/{owner}/{repo}/statuses/{sha}` (for example `ci/external`). A status with the state `success` passes, `pending` is still running, and `failure` or `error` fails.

Copy names exactly as they appear in a pull request's checks list. See [Checks and statuses](/docs/collaboration/checks-and-statuses) for how to report them.

A check run passes when its conclusion is `success`, `skipped` or `neutral`. Several accounts can report the same name, so Diffinery decides which reports count, in this order:

1. If the rule binds the check to a reporter in `requiredCheckSources`, only that reporter's reports count.
2. Otherwise, if Diffinery Actions reported a check with that name on the commit, only the Actions result counts. Another account posting a status or check run with the same name cannot override it.
3. Reports from agents never count, whoever they are and whatever the binding says.
4. Of the reports left, any failure fails the check, and any report that has not finished keeps it pending. The check passes only when every counted report passed.

A required check named **Agent review** is bound to Diffinery's own reviewer (`diffinery-agent-review`), so only [agent review](/docs/agents/review) can pass it.

For commit statuses, only each reporter's latest status for a context is used, so one account's later status cannot replace another account's.

A required check with no counted report blocks the merge with `required check '<name>' has not run`. That includes a check that only an agent reported. Make sure the workflow or CI system runs for every pull request into the protected branch.

Required checks also gate direct pushes, as on GitHub. A push, an API commit or a ref update that moves the protected branch is accepted only when its new commit has already passed every required check, counted the same way. Otherwise it is refused with `protected branch: required check '<name>' has not run on <sha>; push to another branch and open a pull request` (or `has not finished`, or `ended with <conclusion>`). Repository administrators are exempt unless `enforceAdmins` is set.

> **Note:** GitHub names an Actions check run after the job only. In Diffinery the check name includes the workflow name, so required check names copied from GitHub usually need the `<workflow> / ` prefix added.

### Binding a check to a reporter

`requiredCheckSources` maps a required check's name to the one account whose reports decide it: the login of the account (person or bot account) that posts the check run or commit status, or `diffinery-actions` for Diffinery Actions. Use it when a check comes from an external system and you don't want anyone else with write access to be able to satisfy it.

```json
{
  "requirePullRequest": true,
  "requiredChecks": ["ci / test", "ci/external"],
  "requiredCheckSources": { "ci/external": "ci-bot", "ci / test": "diffinery-actions" }
}
```

- Logins are matched without regard to case and are stored in lowercase.
- A source must start with a letter or digit and contain only letters, digits, `.`, `_`, `-`, `[` and `]`, at most 100 characters. Otherwise the request fails with `422` and `invalid source for required check '<name>'`.
- A value that is not an object fails with `requiredCheckSources must map check names to a reporter login or diffinery-actions`.
- An entry only has an effect for a name that is also in `requiredChecks`.
- Binding a check to an agent's login makes it impossible to satisfy, because agents' reports never count.

`requiredCheckSources` can only be set through the API. The **Branch protection** page does not show it, but saving a rule there keeps the bindings of every check that is still listed in **Required status checks**, also when you change the rule's pattern. A binding for a check you remove from **Required status checks** is dropped with it; to require and bind that check again, send the rule with `PUT .../protection`.

### Approvals

Diffinery counts each reviewer's most recent approving or "request changes" review:

- Only approvals from people count. Approvals from agents and from a workflow's `GITHUB_TOKEN` are advisory and never count. (A job token can approve at all only when the repository allows workflows to approve pull requests; see [Pull requests and workflow tokens](/docs/collaboration/pull-requests#pull-requests-and-workflow-tokens).)
- You cannot approve your own pull request, and approving requires the write role.
- With `dismissStaleReviews`, only approvals given on the pull request's current head commit count.
- If a pull request was opened by an agent, it needs at least one approval from a person even when `requiredApprovals` is `0`.

### Agent rules

Agents are accounts that act for a person or organization (see [Agents](/docs/agents/overview)). By default:

- Agents cannot push to the default branch or to any branch that has a rule. The push is rejected with `agents may not push to protected or default branches; open a pull request`. Set `agentsMayPush` on a rule to allow it for matching branches.
- Agents cannot merge pull requests into the default branch or a protected branch. The merge is blocked with `agents may not merge into this branch; a human must merge`. Set `agentsMayMerge` to allow it. An agent from **Settings → Agent setup** with **Can merge pull requests** on may merge there once a person approved the pull request's latest commit and every rule is met, never a change to a workflow file ([Merging](/docs/connect/cloud-agents#merging)).
- Agents cannot create, change or delete branch protection rules (`agents cannot change branch protection`).
- Check runs and commit statuses that agents report never satisfy a required check (see [Required checks](#required-checks)), so an agent cannot mark its own pull request as passing.

To let agents push to or merge into the default branch, create a rule whose pattern matches the default branch and turn on the option you need.

### Agents landing changes

`allowAgentAutoMerge` lets agents land their work on a protected or default branch without ever merging it themselves and without any bypass. An agent turns on auto-merge for its pull request (`PUT /repos/{owner}/{repo}/pulls/{number}/auto-merge`, `diffinery pr merge 12 --auto`, or the MCP tool `enable_auto_merge`), and Diffinery merges it once every rule of the branch is met: required checks green on the head commit, approvals from people (an agent's pull request still needs one), no changes requested, linear history and an up-to-date branch where required. On a branch with a merge queue, the pull request joins the queue instead, and the queue's own checks gate it.

- The rule must set `allowAgentAutoMerge` and have at least one required check. Without the setting the agent gets `403` (`agents may not have pull requests merged into main automatically unless its branch protection allows it ...`); without a required check, `422` (`main has no required status checks: allowAgentAutoMerge needs at least one ...`). The same holds for adding a pull request to the merge queue.
- A pull request that adds, changes or deletes a workflow file can't land this way (`the pull request changes workflow file ...; a person must merge it`), since the workflows are what gate it.
- When a pull request lands this way, a person's approval counts only for the commit it approved, whatever `dismissStaleReviews` says: if the agent pushes again, someone approves again.
- Only people with the admin role change the setting, like every other rule; agents and workflow tokens never can. Turning it on or off is audited as `repo.protection.agent_auto_merge`.
- The merge is made as the agent, on behalf of its owner, and its commit carries the `diffinery-agent` header. Workflows that the merge triggers run as code from an agent, so their tokens are held to the agent rules too.
- A workflow's `GITHUB_TOKEN` is held to the same rule as agents (and needs `contents: write`), even when the run's code didn't come from an agent.
- The agent's access is checked again when the merge happens, and auto-merge turns itself off, with a comment saying why, if the rule no longer allows it, if the merge queue refuses the pull request, or if someone else pushes to the pull request's branch.
- An archived repository lands nothing by itself. Archiving it turns every waiting auto-merge off (`Auto-merge was turned off: the repository is archived.`) and empties its merge queues (`This pull request was removed from the merge queue: the repository is archived.`); unarchiving doesn't turn them back on.
- With `delete_branch` (`diffinery pr merge 12 --auto --delete-branch`), the head branch is deleted once the pull request lands, directly or through the queue, as with a manual merge. A merge never deletes the default branch or a protected branch, even where its rule sets `allowDeletion`.
- `GET /repos/{owner}/{repo}/pulls/{number}` and the MCP tool `get_pull_request` show agents and workflow tokens `auto_merge_blockers`, what auto-merge still needs, next to the blockers of a direct merge (which keep saying `agents may not merge into this branch; a human must merge`).

Turning on auto-merge, turning it off and the merge itself are audited (`pull_request.auto_merge_enabled`, `pull_request.auto_merge_disabled`, `pull_request.auto_merged`, or `pull_request.auto_merge_enqueued` when it joins a merge queue). How to turn auto-merge on and off in the web UI, the API and MCP, and when it turns itself off, is in [Auto-merge](/docs/collaboration/pull-requests#auto-merge).

#### Waiving approvals for agents

By default an agent's pull request needs an approving review from a person before it lands, even through auto-merge. Where a repository's agents should land work on green CI alone, an admin turns on **Let agents' auto-merges land without an approving review** (`agentAutoMergeWithoutApproval`) on the branch's rule, next to `allowAgentAutoMerge`, which it needs (`422` otherwise).

- It applies only to what Diffinery lands for an agent or a workflow token through auto-merge or the merge queue. A direct merge by an agent is still refused, and people's own pull requests keep the rule's `requiredApprovals`.
- The required checks must pass on the head commit, as always; the setting can't be on without at least one, since `allowAgentAutoMerge` needs one.
- A person's requested changes still block the merge, and a pull request that changes a workflow file still needs a person to merge it.
- It is set per branch rule, only by people with the admin role, and never comes in with an import. Turning `allowAgentAutoMerge` off turns this off too. Every change is audited as `repo.protection.agent_approval_waiver`.
- What lands this way is the agent's push, so later runs on the branch are runs of agent code (see [Workflow permissions](/docs/actions/workflow-permissions#runs-whose-code-came-from-an-agent)). They get no repository or organization secrets unless an admin turns on **Give runs of agent code the repository's and organization's secrets**, and they do get the secrets of environments limited to protected branches. A deploy that runs after an agent's merge needs one of the two; see [Which runs receive secrets](/docs/actions/secrets-and-variables#which-runs-receive-secrets).

#### Auto-merging agents' pull requests

The quickest way to set this up, with the required checks, is the repository's **Settings → Merge on green** page; see [Merge on green automatically](/docs/collaboration/merge-on-green).

`allowAgentAutoMerge` still needs someone to turn auto-merge on for each pull request. Where a repository's agents should land their work with nobody acting at all, an admin names those agents on the branch's rule, in **Auto-merge pull requests from these agents** (`autoMergeAgents`). Diffinery then turns auto-merge on by itself, as the agent, when one of them:

- opens a pull request into a matching branch (not a draft),
- marks its draft pull request ready for review, or
- pushes to a pull request it opened, which is how a pull request opened before the agent was named gets picked up.

Each such pull request then lands exactly as the agent's own auto-merge would, with nothing loosened:

- The rule needs `allowAgentAutoMerge` and at least one required check (`422` otherwise), and the required checks must pass on the head commit.
- An approval from a person is still needed unless the rule also has `agentAutoMergeWithoutApproval`. With it, green required checks are enough: that pairing is what lands agents' work with no human step.
- A person's requested changes still block it.
- A pull request that adds, changes or deletes a workflow file never turns on this way. Diffinery says so in a comment (``Auto-merge didn't turn on by itself (branch rule `main` auto-merges my-agent's pull requests): the pull request changes workflow file ...``), and a person merges it.
- The agent's write access is checked again when the merge happens, and the merge is made as the agent, on behalf of its owner.
- Once auto-merge on a pull request is turned off, by anyone or by Diffinery (for example because a person pushed to the branch), the rule never turns it back on for that pull request. A person can still turn it on, or merge.
- Pull requests from other agents, and from people, are left alone.

To turn it on for `main`:

1. Open the repository's **Settings**, then **Branch protection** in the sidebar (`/{owner}/{repo}/settings/branches`) and expand the rule for `main` (or add one).
2. Make sure **Required status checks** (under **Status checks**) lists your CI checks, and under **Agents** tick **Allow agents to land pull requests through auto-merge**.
3. To land without an approving review, also tick **Let agents' auto-merges land without an approving review**.
4. In **Auto-merge pull requests from these agents**, enter the agent logins, one per line, and pick **Their merge method** if it should differ from how the branch merges.
5. Click **Save rule**.

With the API, the same rule is:

```bash
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/branches/main/protection \
  -H "Authorization: Bearer $DIFFINERY_TOKEN" \
  -d '{"requirePullRequest": true, "requiredChecks": ["ci"], "allowAgentAutoMerge": true,
       "agentAutoMergeWithoutApproval": true, "autoMergeAgents": ["my-agent"], "autoMergeMethod": "squash"}'
```

The answer shows the agents as stored, `"autoMergeAgents": [{ "id": "...", "login": "my-agent" }]`, and that form can be sent back as is. Only accounts that are agents can be named (`422`: `autoMergeAgents: olive is not an agent; ...`), at most 20 per rule.

- Only people with the admin role change it, never agents or workflow tokens, and it never comes in with an import. Turning `allowAgentAutoMerge` off removes it.
- Every change to the agents or the method is audited as `repo.protection.agent_auto_merge_rule` (`pattern`, `enabled`, `agents`, `method`, `withoutApproval`, `requiredChecks`). Each pull request it turns auto-merge on for is audited as `pull_request.auto_merge_enabled` by `diffinery-auto-merge[bot]`, with `byRule` (the rule's pattern) and `agent`, and the merge as `pull_request.auto_merged` by the agent.
- The pull request page says **Auto-merge is on · turned on by the branch rule `main` for my-agent**, with the usual **Disable auto-merge** button.

### Workflow tokens

A workflow job's `GITHUB_TOKEN` is held to branch protection like a person with the write role:

- It never has more than the write role, whatever its `permissions:` say, so it can't bypass any rule as an admin, and it can't read or change branch protection rules (`this endpoint is not available to a workflow's GITHUB_TOKEN`).
- Pushes and merges with it need `contents: write`.
- It can't create, change or delete files under `.github/workflows/` or `.diffinery/workflows/`, by push, API commit or merge: the update is rejected with ``refusing to allow a GitHub App to create or update workflow `<path>` without `workflows` permission``.
- In a run whose code came from an agent (an agent started the run, pushed the branch last, or opened the pull request, and re-runs of such runs and `workflow_run` runs that follow them), the token acts as an agent: the agent rules above apply to it.
- Its approvals never count toward `requiredApprovals`.

### Merge queue settings

`mergeQueue` turns on a merge queue for matching branches. Pull requests are then added to the queue instead of being merged directly, and each is tested on top of the base branch and the pull requests ahead of it. See [Merge queue](/docs/collaboration/merge-queue) for how the queue works.

| JSON field | UI label | Default | Allowed values |
|---|---|---|---|
| `method` | Merge method | `"merge"` | `"merge"` (Create a merge commit), `"squash"` (Squash and merge), `"rebase"` (Rebase and merge) |
| `buildConcurrency` | Build concurrency | `5` | 1 to 20: how many queued pull requests are built and checked at once |
| `checkTimeoutMinutes` | Check timeout (minutes) | `60` | 1 to 360: how long to wait for required checks on a merge group before removing it from the queue |

Values outside the allowed range are clamped. An unknown `method` becomes `"merge"`. `"mergeQueue": true` turns the queue on with the defaults. On a rule that also sets `requireLinearHistory`, the queue can't create merge commits: a `method` of `"merge"` (or an unknown one) is refused with `422`, and without a `method` the queue squashes.

## Who can bypass the rules

Repository admins can bypass branch protection unless the rule sets `enforceAdmins`. Admins are the repository owner, the owners and admins of the organization that owns it, collaborators with the admin role, and site admins. When you use a token, it needs the `admin` scope: a `write`-scoped token caps your role at maintain. See [Permissions](/docs/accounts/permissions).

Pushes bypass the rules automatically. Merges don't: an admin's merge is held to the rules like anyone else's until the admin explicitly asks for a bypass.

| Action | Admin bypass (when `enforceAdmins` is off) |
|---|---|
| Direct push, force push or deletion on a protected branch | Automatic for admins. An agent with the admin role gets this only on branches where `agentsMayPush` is on. |
| Merging a pull request that has blockers | Only on request, and only for admins who are people, when the pull request has no merge conflicts and is not a draft. In the web UI the button reads **Merge without waiting for requirements (bypass)** and asks for confirmation; it isn't shown when the rule sets `enforceAdmins`. Through the API send `"bypass_rules": true` on `PUT /repos/{owner}/{repo}/pulls/{number}/merge`; with the CLI use `diffinery pr merge 12 --admin`. Without the flag the merge fails with `405`, and the message ends with `(as an admin you can bypass with bypass_rules)`. |
| A merge commit on a branch that requires linear history | Refused with `405` and `main requires linear history; use squash or rebase`, unless the admin sends `bypass_rules`. The web merge form doesn't offer **Create a merge commit** on such a branch at all. |
| Merging directly when a merge queue is required | Only on request: **Merge now (bypass the queue)** in the web UI, `"bypass_merge_queue": true` on `PUT /repos/{owner}/{repo}/pulls/{number}/merge`, or `diffinery pr merge 12 --admin`. This skips only the queue: a pull request that doesn't meet the rules also needs `"bypass_rules": true`. In the web UI the button then reads **Merge now (bypass the queue and the unmet requirements)** and sends both. |
| Deleting the default branch | Never allowed. |
| Agent rules | Never bypassed by admin status for merges. |

A merge that bypassed anything is recorded in the [audit log](/docs/security/audit-log#git-and-pull-requests) as `pull_request.merge_bypassed`, with the pull request (`acme/website#42`) as the target and the `base` branch and bypassed `blockers` in the detail: the unmet rules, `linear history required` for a merge commit on a linear-history branch, and `merge queue` for a skipped queue. See [Admin bypass](/docs/collaboration/pull-requests#admin-bypass).

With `enforceAdmins` on, admins follow the same rules as everyone else.

## Managing rules in the web UI

You need the admin role on the repository.

1. Open the repository, for example `https://diffinery.com/acme/website`.
2. Select **Settings**, then **Branch protection** in the sidebar (`https://diffinery.com/acme/website/settings/branches`).
3. Under **Add a rule**, enter the **Branch name pattern**, for example `main`. The form starts with **Require a pull request before merging** checked and **Required approvals** set to 1.
4. Set **Required approvals**, enter **Required status checks** one check name per line (names may contain commas, as matrix jobs' do), and check the options you want.
5. To use a merge queue, check **Require a merge queue** and choose the **Merge method**, **Build concurrency** and **Check timeout (minutes)**.
6. Select **Create rule**.

Existing rules are listed above the form with a summary such as `PR required · 1 approval · 2 required checks`. Click a rule to expand and edit it, then select **Save rule**. You see `Branch protection saved.` Saving keeps the rule's `requiredCheckSources` bindings for the checks that are still required. If you change the pattern of an existing rule, the old pattern's rule is replaced, and the rule counts as newly created when several rules match a branch (see [Which rule applies](#which-rule-applies)). Select **Delete** next to a rule to remove it.

Changes are recorded in the [audit log](/docs/security/audit-log) as `repo.protection.set` and `repo.protection.delete`, whether they come from the web UI or the API (API changes carry `"via": "api"` in the detail). On an archived repository, rules can't be changed (`repository is archived (read-only)`).

The repository's branches list marks protected branches with a **protected** badge, and `GET /api/v3/repos/{owner}/{repo}/branches` returns `"protected": true` for them.

## Managing rules with the API

The endpoints need a token for an account with the admin role on the repository, with the `admin` scope. Agents' tokens are refused for changes.

| Method and path | Purpose |
|---|---|
| `GET /api/v3/repos/{owner}/{repo}/branches/{pattern}/protection` | Read the rule stored for exactly this pattern |
| `PUT /api/v3/repos/{owner}/{repo}/branches/{pattern}/protection` | Create or replace the rule for this pattern |
| `DELETE /api/v3/repos/{owner}/{repo}/branches/{pattern}/protection` | Delete the rule for this pattern |

The `{pattern}` path segment is the rule's pattern, not a branch name: `GET .../branches/release%2F*/protection` reads the `release/*` rule, and returns `404` with `branch not protected` if no rule has exactly that pattern, even when the branch is matched by another pattern. URL-encode `/` in patterns as `%2F`.

`PUT` replaces the whole rule with the JSON body. Fields you leave out are turned off.

> **Important:** The request body uses Diffinery's rule fields shown above (`requirePullRequest`, `requiredApprovals` and so on). It does not accept GitHub's protection body (`required_status_checks`, `required_pull_request_reviews`, `enforce_admins` ...). Diffinery does not translate those fields, so a GitHub-style body protects nothing.

### Create a rule with curl

```sh
curl -sS -X PUT \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  https://diffinery.com/api/v3/repos/acme/website/branches/main/protection \
  -d '{
    "requirePullRequest": true,
    "requiredApprovals": 1,
    "dismissStaleReviews": true,
    "requiredChecks": ["ci / test", "ci / lint"]
  }'
```

The response echoes the pattern and the rules you sent:

```json
{
  "pattern": "main",
  "rules": {
    "requirePullRequest": true,
    "requiredApprovals": 1,
    "dismissStaleReviews": true,
    "requiredChecks": ["ci / test", "ci / lint"]
  }
}
```

### Create a rule with the CLI

The `diffinery api` command sends an authenticated request (install the CLI with `curl -fsSL https://diffinery.com/install | bash`, then `diffinery login`):

```sh
cat > rules.json <<'EOF'
{ "requirePullRequest": true, "requiredApprovals": 2, "enforceAdmins": true }
EOF
diffinery api PUT /repos/acme/website/branches/main/protection --input rules.json
diffinery api GET /repos/acme/website/branches/main/protection
diffinery api DELETE /repos/acme/website/branches/main/protection
```

See [CLI reference](/docs/reference/cli) and [REST API](/docs/api).

### Example rules

A default branch that only changes through reviewed pull requests with green CI, and that admins cannot bypass:

```json
{
  "requirePullRequest": true,
  "requiredApprovals": 2,
  "dismissStaleReviews": true,
  "requiredChecks": ["ci / test"],
  "requireLinearHistory": true,
  "enforceAdmins": true
}
```

Release branches (`PUT .../branches/release%2F*/protection`) that may be force-pushed and deleted after a release:

```json
{
  "allowForcePush": true,
  "allowDeletion": true
}
```

Agent working branches (`PUT .../branches/bots%2F**/protection`) where agents push directly and merge their own pull requests:

```json
{
  "agentsMayPush": true,
  "agentsMayMerge": true
}
```

A default branch that merges through a merge queue, squashing each pull request:

```json
{
  "requirePullRequest": true,
  "requiredApprovals": 1,
  "requiredChecks": ["ci / test"],
  "mergeQueue": { "method": "squash", "buildConcurrency": 3, "checkTimeoutMinutes": 30 }
}
```

## What happens on a push

For each ref in a push (and for each branch update from the API, the web editor or MCP), Diffinery checks, in order:

1. The ref name is valid, and you have at least the write role.
2. `refs/pull/...` refs and merge queue branches (`gh-readonly-queue/...`) are managed by Diffinery and cannot be pushed. The objects the update points at must exist on the server.
3. Moving an existing tag needs the maintain role.
4. Agents are stopped at the default branch and protected branches unless `agentsMayPush` is on.
5. The default branch cannot be deleted.
6. If no rule matches, the update is accepted. If you are an admin and the rule does not set `enforceAdmins`, it is accepted.
7. Deletion needs `allowDeletion`.
8. `requirePullRequest` rejects every direct update.
9. A non-fast-forward update needs `allowForcePush`.
10. With `requireLinearHistory`, new commits must not include merge commits (the first 1,000 new commits are checked).

A workflow's `GITHUB_TOKEN` is also refused, right after step 2, when the update creates, changes or deletes a file under `.github/workflows/` or `.diffinery/workflows/`. A new branch is compared with where it branched off the default branch.

A rejected ref shows the reason in git's output:

```text
 ! [remote rejected] main -> main (protected branch: changes must be made through a pull request)
```

Through the API, the same reasons come back as `403` errors with a `message`.

| Reason | Meaning |
|---|---|
| `permission denied` | You need the write role. |
| `agents may not push to protected or default branches; open a pull request` | An agent pushed to the default branch or a protected branch without `agentsMayPush`. |
| `cannot delete the default branch` | Choose another default branch first. |
| `protected branch: deletion not allowed` | The rule does not set `allowDeletion`. |
| `protected branch: changes must be made through a pull request` | The rule sets `requirePullRequest`. |
| `protected branch: force push not allowed` | The update is not a fast-forward and the rule does not set `allowForcePush`. |
| `protected branch: merge commits not allowed (linear history)` | The pushed commits include a merge commit. |
| `protected branch: required check '<name>' has not run on <sha>; push to another branch and open a pull request` (or `has not finished`, `ended with <conclusion>`) | The rule requires status checks, and the commit the push moves the branch to hasn't passed them. Push to another branch and open a pull request. Administrators are exempt unless `enforceAdmins` is set. |
| `only maintainers may move tags` | Moving an existing tag needs the maintain role. |
| `merge queue branches are read-only` | `gh-readonly-queue/...` branches belong to the merge queue. |
| `refs/pull/ is managed by Diffinery for pull requests` | Pull request refs cannot be pushed. |
| `missing objects` | The update points at a commit the server doesn't have. Push the commits too, or fetch the full history first. |
| ``refusing to allow a GitHub App to create or update workflow `<path>` without `workflows` permission`` | A workflow's `GITHUB_TOKEN` tried to add, change or delete a workflow file. Push it as a person or with a personal token. |

## Merge blockers

Before a pull request merges, Diffinery evaluates the rule for its base branch and lists every reason it cannot merge yet. You see the list on the pull request page above the merge button, in `merge_blockers` from `GET /api/v3/repos/{owner}/{repo}/pulls/{number}`, and in `blockers` from `GET /api/v3/repos/{owner}/{repo}/pulls/{number}/merge`.

| Blocker text | Cause |
|---|---|
| `already merged` | The pull request is merged. |
| `pull request is closed` | Reopen it first. |
| `base branch <name> no longer exists` | The base branch was deleted. |
| `pull request is a draft` | Draft pull requests cannot merge. |
| `merge conflicts in <n> file(s)` | Resolve the conflicts on the head branch. |
| `needs <n> more approving review(s)` | Approvals from people are short of `requiredApprovals` (or of 1 for an agent's pull request). |
| `changes requested by <logins>` | These reviewers' latest review requests changes. |
| `required check '<name>' has not run` | No counted check run or commit status with that name exists on the head commit (reports from agents, or from accounts other than the bound reporter, don't count). |
| `required check '<name>' is queued` or `is in_progress` | The check has not finished. A commit status in the `pending` state shows as `is in_progress`. |
| `required check '<name>' <conclusion>` | The check finished with a conclusion other than success, skipped or neutral, for example `required check 'ci / test' failure`. A commit status in the `failure` or `error` state shows as `failure`. |
| `branch is behind its base; update it (linear history required)` | With `requireLinearHistory`, the head branch must contain the latest base commit. |
| `write access is required to merge` | Your role is below write. |
| `agents may not merge into this branch; a human must merge` | An agent (or a workflow token in a run whose code came from an agent) tried to merge into the default branch or a protected branch without `agentsMayMerge`. Agents can [land changes through auto-merge](#agents-landing-changes) instead. |
| `the pull request changes workflow file <path>; a person must merge it` | An agent's auto-merge or merge queue entry relies on `allowAgentAutoMerge`, and the pull request changes a workflow. |
| ``refusing to allow a GitHub App to create or update workflow `<path>` without `workflows` permission`` | A workflow's `GITHUB_TOKEN` tried to merge a pull request that changes a workflow file. |

Example response from `GET /api/v3/repos/acme/website/pulls/42`, trimmed:

```json
{
  "number": 42,
  "mergeable": true,
  "rebaseable": true,
  "mergeable_state": "blocked",
  "merge_blockers": [
    "needs 1 more approving review(s)",
    "required check 'ci / test' is in_progress"
  ],
  "approvals": 0,
  "required_approvals": 1,
  "checks": [{ "name": "ci / test", "state": "in_progress" }]
}
```

As on GitHub, `mergeable` only says whether the head merges into the base without conflicts (`null` once the pull request is closed); the rules are reported in `mergeable_state` and `merge_blockers`. `mergeable_state` is one of:

| Value | Meaning |
|---|---|
| `clean` | No blockers: the pull request can merge now. |
| `blocked` | One or more blockers other than conflicts, listed in `merge_blockers`. |
| `dirty` | The head conflicts with the base. |
| `draft` | The pull request is a draft. |
| `unknown` | The pull request is merged or closed, or its base branch no longer exists. |

`GET /api/v3/repos/{owner}/{repo}/pulls/{number}/merge` returns Diffinery's report (`mergeable`, `state`, `blockers`, `checks` and more), where `state` uses `conflicting` instead of `dirty` and `merged` or `closed` instead of `unknown`. A client that sends a GitHub media type (`Accept: application/vnd.github+json`) gets GitHub's answer from that path instead: `204` if the pull request is merged and `404` if not.

When you try to merge anyway with `PUT /api/v3/repos/{owner}/{repo}/pulls/{number}/merge`, the response is `405` with the blockers joined into the message and listed in `blockers`:

```json
{
  "message": "pull request is not mergeable: needs 1 more approving review(s); required check 'ci / test' is in_progress",
  "blockers": ["needs 1 more approving review(s)", "required check 'ci / test' is in_progress"]
}
```

For an admin who may bypass (see [Who can bypass the rules](#who-can-bypass-the-rules)), the message ends with `(as an admin you can bypass with bypass_rules)`.

On a branch with `requireLinearHistory`, a merge with `"merge_method": "merge"` returns `405` with `main requires linear history; use squash or rebase`, even when the pull request has no blockers. When no method is given, the API squashes on such a branch.

If the base branch requires a merge queue, a direct merge returns `405` with `main requires a merge queue: add the pull request to the queue` and the blocker `main merges through a merge queue`. Add the pull request to the queue with `PUT /api/v3/repos/{owner}/{repo}/pulls/{number}/merge-queue` instead. See [Merge queue](/docs/collaboration/merge-queue) and [Pull requests](/docs/collaboration/pull-requests).

## Differences from GitHub

- Rules are set by pattern with Diffinery's own JSON fields; GitHub's branch protection request body is not supported (see [Managing rules with the API](#managing-rules-with-the-api)).
- Commit status contexts count as required checks, as on GitHub. Where GitHub binds a required check to a GitHub App, Diffinery binds it to an account login (or `diffinery-actions`) with `requiredCheckSources`, and a check that Diffinery Actions reports is decided by Actions alone even without a binding.
- Reports from agents never satisfy a required check.
- Agent controls (`agentsMayPush`, `agentsMayMerge`, `allowAgentAutoMerge`, `agentAutoMergeWithoutApproval`) and the human-approval requirement for agents' pull requests have no GitHub equivalent.
- Required Actions check names include the workflow name: `ci / test`.
- Rules have no options for restricting pushes to specific users or teams, requiring signed commits, requiring conversation resolution or requiring code owner reviews.
- A "changes requested" review blocks merging even on branches without a rule.
- An admin's merge past unmet rules must be asked for with `bypass_rules`, and skipping a merge queue with `bypass_merge_queue`; each covers only what it names, and both are written to the audit log as `pull_request.merge_bypassed`.
- When several rules match, the choice follows GitHub: a rule naming the branch exactly wins, then the oldest rule.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `branch not protected` from `GET .../protection` | No rule has exactly that pattern. List rules on the **Branch protection** page, and URL-encode `/` as `%2F`. |
| A required check never turns green | The name does not match. Compare it with the checks list on the pull request, including the `workflow / ` prefix. |
| A check shows as passed on the pull request but the merge says `has not run` | The passing report doesn't count: it came from an agent, or from an account other than the one bound in `requiredCheckSources`, or Diffinery Actions also reported a check with the same name. Report the check from the bound account, or change the binding. |
| `invalid source for required check '<name>'` | A value in `requiredCheckSources` is not a valid login. Use the reporter's login or `diffinery-actions`. |
| A `requiredCheckSources` binding disappeared | The check was removed from **Required status checks** when the rule was saved in the web UI, which drops the bindings of checks that are no longer required. Send the rule again with `PUT .../protection`. |
| An agent's pull request needs an approval even with `requiredApprovals: 0` | Agent-authored pull requests always need one approval from a person. |
| An approval disappeared after a push | `dismissStaleReviews` is on. Ask the reviewer to approve the new commits. |
| Your admin push was rejected | The rule sets `enforceAdmins`, or your token has the `write` scope instead of `admin`. |
| Your admin merge was refused with `pull request is not mergeable: ...` | Admins aren't exempt from merge rules by default. Send `"bypass_rules": true`, use `diffinery pr merge --admin`, or click **Merge without waiting for requirements (bypass)**. If the message doesn't end with `(as an admin you can bypass with bypass_rules)`, a bypass isn't possible: the rule sets `enforceAdmins`, the pull request conflicts or is a draft, or your token lacks the `admin` scope. |
| `main requires linear history; use squash or rebase` | The base branch requires linear history and you asked for a merge commit. Merge with `squash` or `rebase`. |
| A branch follows a different rule than you expect | Several patterns match it. A rule with the exact branch name wins, otherwise the oldest matching rule. See [Which rule applies](#which-rule-applies). |
| `agents cannot change branch protection` | Change rules as a person, from the web UI or with your own token. |
