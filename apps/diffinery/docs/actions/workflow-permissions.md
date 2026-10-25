---
title: GITHUB_TOKEN permissions
description: What a workflow job's GITHUB_TOKEN may do on Diffinery, how permissions are resolved, the repository default, and the rules no permission can lift.
---

Every workflow job gets its own token, `GITHUB_TOKEN`, that works against Diffinery's REST API and git server. What the token may do follows GitHub's `permissions:` model: each API endpoint needs a permission scope, and the job's effective `permissions:` decide which scopes the token has. This page explains how those permissions are worked out, how to change the repository's default, and the rules that apply whatever a workflow asks for.

## The job token

The token is available as `secrets.GITHUB_TOKEN`, `github.token` and, under a Diffinery name, `secrets.DIFFINERY_TOKEN`. It isn't an environment variable unless you set one:

```yaml
- run: gh api repos/${{ github.repository }}
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- It works only while the job runs. When the job completes, the token stops working, and it never works more than 30 minutes past the job's timeout (counted from when the job started), even if the job is never marked complete.
- It acts in the repository as `diffinery-actions[bot]`, so issues, comments and labels it creates show that name.
- Its role is `write` when any scope other than `id-token` is `write`, and `read` otherwise. It never has the `maintain` or `admin` role, so [branch protection](/docs/repositories/branch-protection) always applies to it.
- Each request is then checked against the scope its endpoint needs (see [What each endpoint needs](#what-each-endpoint-needs)).

## How permissions are resolved

A job's effective permissions come from the first of these that exists:

1. The job's own `permissions:` (`jobs.<id>.permissions`). It replaces the workflow's, it isn't merged with it.
2. The workflow's top-level `permissions:`.
3. The repository default, set by an admin (see [The repository default](#the-repository-default)).

Inside a [reusable workflow](/docs/actions/reusable-workflows), the calling job's permissions take the place of the repository default and also cap everything the called workflow declares. See [Reusable workflows](#reusable-workflows).

### Scopes

`permissions:` takes these scopes, the same as GitHub's:

| Scope | What it covers on Diffinery |
| --- | --- |
| `actions` | Workflows, runs, jobs, logs, artifacts and caches (`/actions/...`), including starting a `workflow_dispatch` run |
| `attestations` | `/attestations` |
| `checks` | Check runs and check suites |
| `contents` | Git fetch and push, files, commits, branches, tags, releases and release assets, compare, archives, commit comments, `repository_dispatch`, merging pull requests |
| `deployments` | Deployments, deployment statuses, and reading environments |
| `discussions` | `/discussions` |
| `id-token` | Requesting an [OIDC](/docs/actions/oidc) token. Only `write` (or `none`) has a meaning. |
| `issues` | Issues, issue comments, labels, milestones and assignees |
| `models` | Accepted for compatibility. Only `read` or `none`. |
| `packages` | The [container registry](/docs/packages/container-registry) |
| `pages` | `/pages` |
| `pull-requests` | Pull requests, reviews and review comments, and issue endpoints used on pull requests |
| `repository-projects` | `/projects` |
| `security-events` | `/code-scanning`, `/secret-scanning`, `/dependabot` |
| `statuses` | Commit statuses |

Each scope takes `read`, `write` or `none`. `write` includes `read`. An unknown scope gives the warning `unknown permission scope '<scope>'` when the workflow is parsed, and an invalid level fails the file with `permission '<scope>' must be 'read', 'write' or 'none'`.

### Shorthand values

| Value | Result |
| --- | --- |
| `read-all` | Every scope `read`, except `id-token`, which gets nothing. |
| `write-all` | Every scope `write`, except `models`, which stays `read`. Includes `id-token: write`. |
| `{}` | Every scope `none`. The token can still read what anyone may read in a public repository. |
| A mapping | The scopes you list get the levels you give. **Every scope you don't list is `none`.** |

Two scopes have special rules:

- `id-token: read` grants nothing. OIDC needs `id-token: write`.
- `models: write` is lowered to `read`.

Any other value of `permissions:` fails the file with `permissions must be 'read-all', 'write-all' or a mapping of scope: read|write|none`.

### Examples

A workflow that only reads code, with one job that comments on pull requests:

```yaml
permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test

  comment:
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read        # the job's map replaces the workflow's, so repeat contents
      pull-requests: write
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: "Tests passed.",
            });
```

A release job that pushes a tag and uploads release assets needs `contents: write`. A job that pushes an image needs `packages: write`, and because naming any scope sets the others to `none`, it also needs `contents: read` to check out a private repository:

```yaml
jobs:
  image:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
```

## The repository default

When neither the job nor the workflow sets `permissions:`, the job gets the repository default. It's one of two settings, the same as GitHub's "Workflow permissions" setting:

| `default_workflow_permissions` | Token permissions |
| --- | --- |
| `read` | `contents: read` and `packages: read`. Every other scope `none`. |
| `write` | Every scope `write` (`models` `read`), except `id-token`, which gets nothing. |

| Repository | Default |
| --- | --- |
| Created after this setting was added | `read`, and pull request creation and approval off |
| Created before | `write`, and pull request creation and approval off |

A second setting, `can_approve_pull_request_reviews`, decides whether job tokens may open pull requests and approve or request changes on them (see [Creating and approving pull requests](#creating-and-approving-pull-requests)). It's `false` by default.

A third, `agent_runs_use_secrets` (a Diffinery addition), decides whether runs of code an agent wrote get the repository's and organization's secrets. It's `false` by default; see [Which runs receive secrets](/docs/actions/secrets-and-variables#which-runs-receive-secrets).

### Read and change the setting

In the web UI, open the repository's **Settings → Actions** tab (`/{owner}/{repo}/settings/actions`). Under **Workflow permissions**, pick **Read repository contents and packages permissions** or **Read and write permissions**, check or clear **Allow GitHub Actions to create and approve pull requests** and **Give runs of agent code the repository's and organization's secrets**, and click **Save**. You see "Actions settings saved." The tab needs the **admin** role on the repository.

You can also read and change it with the REST API or the CLI. Both need the **admin** role on the repository, and only people can change it: an agent's token gets `403 only people can change what workflows are allowed to do`.

Read the current setting:

```http
GET /api/v3/repos/acme/website/actions/permissions/workflow
Authorization: Bearer dfy_...
```

```json
{
  "default_workflow_permissions": "read",
  "can_approve_pull_request_reviews": false,
  "agent_runs_use_secrets": false
}
```

Change it with `PUT`. Send any of the fields; a field you leave out keeps its value. The response is `204 No Content`:

```sh
curl -fsS -X PUT https://diffinery.com/api/v3/repos/acme/website/actions/permissions/workflow \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"default_workflow_permissions": "write", "can_approve_pull_request_reviews": true}'
```

With the CLI (install it with `curl -fsSL https://diffinery.com/install | bash`, then `diffinery login`):

```sh
diffinery api GET /repos/acme/website/actions/permissions/workflow
diffinery api PUT /repos/acme/website/actions/permissions/workflow -f default_workflow_permissions=write
```

`-f` sends string values only. To change `can_approve_pull_request_reviews`, which is a boolean, send a JSON body with `--input` (a file, or `-` for stdin):

```sh
echo '{"can_approve_pull_request_reviews": true}' \
  | diffinery api PUT /repos/acme/website/actions/permissions/workflow --input -
```

Every change is recorded in the [audit log](/docs/security/audit-log) as `repo.actions_workflow_settings`, with the new values.

| Status and message | Cause |
| --- | --- |
| `403 admin access required` | Your role on the repository is below admin, or your token's scope doesn't reach admin. |
| `403 only people can change what workflows are allowed to do` | The request used an agent's token. |
| `422 a JSON body is required` | The body is missing or isn't JSON. |
| `422 default_workflow_permissions must be read or write` | Another value was sent. |
| `422 can_approve_pull_request_reviews must be a boolean` | A string such as `"true"` was sent instead of `true`. |

> **Note:** The setting is read when a job starts. Jobs that are already running keep the permissions they started with.

## What each endpoint needs

Each request the token makes to `/api/v3/repos/{owner}/{repo}/...`, to the git server, or to a repository's web pages is matched to a scope by the first path segment after the repository. `GET`, `HEAD` and `OPTIONS` need `read`; other methods need `write`. Git fetches (`git-upload-pack`) and Git LFS downloads are reads even though they use `POST`.

| Path after `/repos/{owner}/{repo}` | Scope |
| --- | --- |
| `/issues` (list or create issues) | `issues` |
| `/issues/...`, `/labels`, `/milestones`, `/assignees` | `issues` or `pull-requests` (either one is enough) |
| `/pulls`, `/pulls/...` | `pull-requests` |
| `/pulls/{number}/merge`, `/pulls/{number}/update-branch`, `/pulls/{number}/auto-merge` | `contents` |
| `/statuses/...`, `/commits/{sha}/status`, `/commits/{sha}/statuses` | `statuses` |
| `/check-runs`, `/check-suites`, `/commits/{sha}/check-runs`, `/commits/{sha}/check-suites` | `checks` |
| `/deployments`, reading `/environments` | `deployments` |
| `/actions/...` | `actions` |
| `/pages` | `pages` |
| `/discussions` | `discussions` |
| `/code-scanning`, `/secret-scanning`, `/dependabot` | `security-events` |
| `/packages` | `packages` |
| `/projects` | `repository-projects` |
| `/attestations` | `attestations` |
| `/contents`, `/commits`, `/compare`, `/git`, `/branches`, `/tags`, `/releases`, `/merges`, `/tarball`, `/zipball`, `/readme`, `/dispatches`, `/comments`, `/merge-upstream`, `/languages`, `/contributors`, `/stats` | `contents` |
| Git over HTTPS (`/{owner}/{repo}.git/...`), including push | `contents` |
| Release asset uploads (`/api/uploads/repos/{owner}/{repo}/releases/{id}/assets`) | `contents` |
| `GET /repos/{owner}/{repo}` and other reads not listed here | None: repository metadata is always readable |

### Endpoints a job token can never use

Some endpoints are refused whatever the permissions, even with `write-all`:

- `/hooks`, `/collaborators`, `/keys`, `/invitations`, `/settings`, `/rulesets`, `/teams`, `/transfer`, `/autolinks`, `/vulnerability-alerts`
- `/actions/secrets`, `/actions/variables`, `/actions/runners`, `/actions/permissions`, `/actions/oidc`
- Creating, changing or deleting environments, and environment secrets and variables
- Branch protection (`/branches/{branch}/protection`)
- Changing or deleting the repository itself (`PATCH` or `DELETE /repos/{owner}/{repo}`)
- Any write to a path not in the table above

Most of these endpoints need the admin role, which a job token never has, so the response is `403 admin access required`. The others answer `403 this endpoint is not available to a workflow's GITHUB_TOKEN`.

A job token can't re-run workflows either: `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun` (and `/rerun-failed-jobs`, and `POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun`) fails with `403 a workflow's GITHUB_TOKEN cannot re-run workflows`.

### The 403 response

A request whose scope the token lacks gets GitHub's message, with the scope it needed:

```json
{
  "message": "Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: issues: write)",
  "documentation_url": "https://docs.github.com/rest"
}
```

When either of two scopes is enough, the message lists both, for example `needs permissions: issues or pull-requests: write`. Add the scope to the job's `permissions:` and run the job again.

## Reading public repositories

What anyone may read in a public repository, a job token may read too, whatever its permissions:

- In its own public repository, a read is allowed even with `permissions: {}` or `contents: none`.
- It can read **other** public repositories on Diffinery, for example to check out a public dependency or clone a public submodule, but only read: any write is refused.
- It can't see other private repositories at all, even ones with the same owner. A request gets `404`. To check out another private repository, pass a personal or agent token from a secret as `token:`.

## Workflow files

A job token never creates, changes or deletes files under `.github/workflows/` or `.diffinery/workflows/`, whatever its permissions. This is GitHub's `workflows` permission, which a `GITHUB_TOKEN` can't have. The refusal reads:

```text
refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission
```

It applies to:

- `git push`: the ref update is rejected with that reason.
- Commits through the API, such as the contents API.
- Merging a pull request: the message appears as a merge blocker when the pull request changes a workflow file.

A push that creates a new branch is compared with where the branch left the default branch, so a new branch that only carries workflow changes already on the default branch is allowed. To change workflow files from automation, use a personal or agent token from a secret.

## Creating and approving pull requests

By default a job token can't open pull requests, approve them or request changes on them. The request fails with:

```text
GitHub Actions is not permitted to create pull requests. An admin can allow it in the repository's Actions settings ("Allow GitHub Actions to create and approve pull requests").
```

For reviews the message says `approve` instead of `create`. Commenting reviews are always allowed. To allow the rest, set `can_approve_pull_request_reviews` to `true` (see [Read and change the setting](#read-and-change-the-setting)); the job also needs `pull-requests: write`.

Even when allowed, an approval from a job token **never counts** toward a branch's required approvals. Only approvals by people count.

## Pull requests from forks

A `pull_request` run for a pull request whose head is in another repository gets read access only: `read-all` at most, whatever the workflow asks for, and never `id-token: write`. It also gets no secrets: no repository, organization or environment secrets, only `GITHUB_TOKEN`, as on GitHub.

Diffinery has no forks of its own, so today this applies to pull requests [imported from GitHub](/docs/migrate-from-github) whose head was in a fork. Their head shows as `owner:branch`.

## Reusable workflows

A [reusable workflow](/docs/actions/reusable-workflows) never gets more than its caller:

- A job in the called workflow without `permissions:` (and a called workflow without top-level `permissions:`) inherits the calling job's permissions.
- Whatever the called workflow or its jobs declare is lowered, scope by scope, to what the calling job has.
- The calling job's own permissions follow the usual order: its `permissions:`, then its workflow's, then the repository default.

```yaml
# caller
jobs:
  deploy:
    uses: ./.github/workflows/deploy.yml
    permissions:
      contents: read
      id-token: write
```

Here the jobs in `deploy.yml` can have at most `contents: read` and `id-token: write`, even if `deploy.yml` asks for `write-all`.

## Runs whose code came from an agent

A run is treated as agent code when:

- an agent triggered it,
- an agent last pushed the branch or tag it runs on (a merge that Diffinery lands for an agent through auto-merge counts as the agent's push),
- for pull request and merge queue events, an agent opened the pull request or last pushed its head branch, or
- off the default branch, the code it runs includes a commit an agent pushed that hasn't landed on the default branch yet. A person pushing on top of an agent's commits, tagging them, making a release from them or dispatching a workflow on them doesn't make that code a person's. Once a person merges the commits into the default branch (or a person lands them there), they count as that person's, since the default branch's runs go by who moved it.

A re-run of such a run keeps this, whoever starts the re-run, and so does a `workflow_run` run that follows such a run, since it acts on what that run produced (its artifacts and outputs). The jobs of these runs act as an agent, so the [agent guardrails](/docs/agents/overview) hold for code an agent wrote, even when a person triggered the run:

- Pushes to the default branch or a protected branch are refused with `agents may not push to protected or default branches; open a pull request`, unless the branch's protection rule has **Allow agents to push directly** on.
- Merges into those branches are blocked with `agents may not merge into this branch; a human must merge`, unless the rule has **Allow agents to merge pull requests** on. The token can still turn on [auto-merge](/docs/collaboration/pull-requests#auto-merge) where the rule has **Allow agents to land pull requests through auto-merge** and a required check; that rule holds for every job token on those branches, agent code or not.
- A pull request the job opens counts as agent-authored, so it needs at least one approval from a person, unless the base branch's rule [waives approvals for agents' auto-merges](/docs/repositories/branch-protection#waiving-approvals-for-agents).
- A deployment the job records counts as the agent's, so [environment secret rules for agents](/docs/actions/environments#who-receives-environment-secrets) apply.
- The jobs get no repository or organization secrets, only the job token, unless a repository admin who is a person turns on `agent_runs_use_secrets` (see [Which runs receive secrets](/docs/actions/secrets-and-variables#which-runs-receive-secrets)).

## Runs started by the token

Like on GitHub, what a job does with its token starts no new workflow runs, so a workflow can't trigger itself in a loop. Pushes, pull requests, releases and merges made with a job token (including a later merge by an auto-merge the token turned on) don't start runs. The two exceptions, as on GitHub, are `workflow_dispatch` (a job with `actions: write` can start another workflow with `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`) and `repository_dispatch` (`POST /repos/{owner}/{repo}/dispatches`, which needs `contents: write`).

## Differences from GitHub

| Area | GitHub | Diffinery |
| --- | --- | --- |
| Changing the default | **Settings** > **Actions** > **General** > **Workflow permissions** | **Settings** > **Actions** > **Workflow permissions**, or `PUT /repos/{owner}/{repo}/actions/permissions/workflow` |
| Organization and enterprise defaults | Can limit repositories | Not available; each repository has its own setting |
| Agent code | Not a concept | Runs whose code came from an agent are held to the agent rules |
| Name in the repository | `github-actions[bot]` | `diffinery-actions[bot]` |
| Extra name | None | `secrets.DIFFINERY_TOKEN` |

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: <scope>: write)` | Add that scope to the job's `permissions:`, or to the workflow's when the job has none. In a reusable workflow, the calling job needs it too. |
| A job that used to write now gets 403 | The repository's default is `read` (the default for new repositories), or the workflow added a `permissions:` map that leaves the scope out. Add the scope, or have an admin set `default_workflow_permissions` to `write`. |
| `actions/checkout` fails on a private repository after adding `permissions:` | Naming any scope sets the others to `none`. Add `contents: read`. |
| `this endpoint is not available to a workflow's GITHUB_TOKEN`, or `admin access required` from a job | The endpoint manages settings, secrets, variables, hooks, runners, environments or branch protection. Use a personal or agent token from a secret. |
| `refusing to allow a GitHub App to create or update workflow ...` | Job tokens never change workflow files. Use a personal or agent token. |
| `GitHub Actions is not permitted to create pull requests. ...` | An admin sets `can_approve_pull_request_reviews` to `true`, and the job needs `pull-requests: write`. |
| A job token's approval doesn't satisfy required reviews | Only people's approvals count. |
| `agents may not push to protected or default branches; open a pull request` from a job | The run's code came from an agent. Open a pull request for a person to review and merge. |
| A push from a job doesn't start the expected workflow | Events caused by a job token start no runs. Use `workflow_dispatch` with `actions: write` or `repository_dispatch` with `contents: write`, or a personal or agent token. |
| `Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable` | Add `id-token: write`. `id-token: read` grants nothing. |
