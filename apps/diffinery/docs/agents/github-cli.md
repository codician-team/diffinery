---
title: GitHub CLI and Claude Code
description: Use gh with Diffinery repositories, and get Claude Code's pull request badge and CI status for them, by signing gh in to Diffinery once.
---

The GitHub CLI (`gh`) works with Diffinery the way it works with a GitHub Enterprise Server: in a clone of a Diffinery repository, `gh pr create`, `gh pr view`, `gh pr checks`, `gh pr merge` and the other pull request commands talk to Diffinery, and so do `gh issue list`, `gh issue create` and the other issue commands. Claude Code uses the same setup to show the pull request of the branch you're on and its CI, because it finds pull requests through gh's sign-in. Both go through Diffinery's [GraphQL API](/docs/reference/graphql-api) and [REST API](/docs/reference/rest-api).

## Set it up

You need a recent `gh` (Diffinery is tested with 2.89) and a Diffinery token. With the [Diffinery CLI](/docs/accounts/cli-sign-in) signed in, one command signs gh in too:

```sh
diffinery login
diffinery auth setup-gh
```

`diffinery auth setup-gh` runs `gh auth login --hostname diffinery.com --with-token --git-protocol https` and hands gh your token on its standard input, so the token never shows in your shell history or on screen. gh keeps it in its own credential store.

Without the Diffinery CLI, create a token under **Settings → Access tokens** (`write` scope, so gh can open and merge pull requests), save it to a file, and give it to gh the same way:

```sh
gh auth login --hostname diffinery.com --with-token --git-protocol https < ~/diffinery-token.txt
```

In CI or a container, set the host and token in the environment instead. gh and Claude Code both read them:

```sh
export GH_HOST=diffinery.com
export GH_ENTERPRISE_TOKEN=...   # from your secret store
```

Check it with `gh api user --hostname diffinery.com --jq .login`, which prints your login.

## Use gh

In a clone whose `origin` is on Diffinery, gh picks the host from the remote:

```sh
gh pr create --title "Fix the parser" --body "..." --draft
gh pr view --web
gh pr checks --watch
gh pr ready
gh pr merge --auto --squash
gh issue create --title "The parser drops comments" --label bug
gh issue list --label bug
gh issue close 42 --reason "not planned"
```

| Works | Commands |
| --- | --- |
| Reading | `gh pr view` (with `--json`), `gh pr list`, `gh pr status`, `gh pr checks`, `gh pr diff`, `gh issue list` (with `--label`, `--assignee`, `--author`, `--mention`, `--search`, `--state`), `gh issue view` (with `--comments` and `--json`), `gh issue status`, `gh repo view`, `gh label list`, `gh release list`, `gh api` (REST and `gh api graphql`) |
| Changing | `gh pr create` (with `--draft`, `--reviewer`, `--assignee`, `--label`), `gh pr edit`, `gh pr ready`, `gh pr comment`, `gh pr close`, `gh pr reopen`, `gh pr merge` (`--merge`, `--squash`, `--rebase`, `--auto`, `--disable-auto`), `gh issue create` (with `--label`, `--assignee`, `--milestone`), `gh issue edit`, `gh issue comment`, `gh issue close` (with `--reason`), `gh issue reopen`, `gh label create` |
| Not yet | Team reviewers, projects, `gh issue delete`, `lock`, `pin` and `transfer`. Use `gh api` with the REST paths for anything else. |

gh changes things with your token's permissions and Diffinery's rules: branch protection, required checks and reviews, and the [agent guardrails](/docs/agents/overview) apply as they do on the web and over REST. `gh pr merge --auto` turns on Diffinery's auto-merge, which merges once the required checks pass. When nothing blocks the merge, gh merges at once.

## gh in workflows

Inside a Diffinery workflow, gh works with the job's own token, as with `GITHUB_TOKEN` on GitHub. It can do what the job's [`permissions:`](/docs/actions/workflow-permissions) allow: `gh issue list` needs `issues: read`, `gh pr comment` needs `pull-requests: write`, and so on.

```yaml
permissions:
  issues: write
steps:
  - run: gh issue create --title "Nightly build failed" --body "See ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
    env:
      GH_TOKEN: ${{ github.token }}
```

## Claude Code's pull request badge

Claude Code shows the pull request for the branch a session is on, and follows it as it changes:

- **In the terminal**, the footer shows `PR #12` for the current branch's open pull request.
- **In the Claude desktop app**, the session's pull request chip shows the pull request and its CI. Claude Code reports the branch's pull request when a session starts, and a pull request it opens with `gh pr create` as soon as gh prints its URL.

There's nothing to set up beyond signing gh in. Claude Code treats any host other than github.com as GitHub Enterprise: it reads the remote of the folder it's in, gets the token from `GH_ENTERPRISE_TOKEN` (when `GH_HOST` names the host) or from `gh auth token --hostname diffinery.com`, and asks Diffinery's REST and GraphQL APIs for the pull request, its review decision and its CI counts. In the desktop app, the folder has to be one you've trusted.

Sessions in Claude Code on the web (claude.ai/code) and project threads run in Anthropic's cloud and get their pull request cards from Anthropic's GitHub integration, which doesn't reach Diffinery. Those sessions can still use gh and the [MCP server](/docs/agents/mcp) to open pull requests and follow CI, and the `diffinery-ci` plugin, which the repository's [Agent setup](/docs/connect/cloud-agents) script adds, tells Claude when CI on its pushed commit passes or fails. For a live view of every check in the terminal, the desktop app and VS Code, see [CI status in Claude](/docs/connect/ci-status-in-claude).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| gh asks you to run `gh auth login` in a Diffinery clone | gh has no token for the host. Run `diffinery auth setup-gh`, or check that `GH_HOST` matches the remote's host. |
| `HTTP 401` from gh | The token expired or was revoked. Create a new one and sign gh in again. |
| `gh pr create` or `gh pr merge` fails with a permission error | The token has the `read` scope only, or you need write access to the repository. |
| No badge in the terminal | The branch has no open pull request, or gh isn't signed in to the host. `gh pr view` in the same folder shows which. |
| `gh auth status` shows most of an older token | gh hides a token only after its last `_`. Tokens Diffinery creates now have no `_` after `dfy_`; if yours does, create a new one and sign gh in again. |
