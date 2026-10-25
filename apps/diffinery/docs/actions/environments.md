---
title: Deployments and environments
description: Create deployment environments, limit which branches and tags deploy to them, give them their own secrets and variables, and track deployments.
---

An environment is a named deployment target, such as `staging` or `production`, with its own secrets, variables and a policy that decides which branches and tags may deploy to it. A workflow job that names an environment gets that environment's secrets and variables, is refused if its ref isn't allowed, and records a deployment with statuses that other tools can follow. Diffinery implements GitHub's environments, deployments and deployment statuses, including their REST API and webhooks; the differences are listed in [Differences from GitHub](#differences-from-github).

## How it fits together

| Concept | What it is |
|---|---|
| Environment | A name in one repository (`production`), with an optional deployment branch policy, protection rules, secrets and variables. |
| Deployment branch policy | Which refs may use the environment: any ref (no policy), protected branches only, or a list of branch and tag patterns. |
| Required reviewers | Up to 6 people, one of whom must approve before a run's jobs deploy to the environment. |
| Wait timer | Minutes a job waits before it deploys, up to 43,200 (30 days). |
| Environment secret | An encrypted value that only jobs using the environment receive, and only when the rules in [Who receives environment secrets](#who-receives-environment-secrets) allow it. |
| Environment variable | A plain value that jobs using the environment receive in the `vars` context. |
| Deployment | A record that a commit was (or is being) deployed to an environment. Workflow jobs create one automatically; you can also create them with the REST API. |
| Deployment status | The state of a deployment over time: `queued`, `pending`, `in_progress`, `success`, `failure`, `error` or `inactive`, with optional log and environment URLs. |

A typical setup:

1. A repository admin creates `production`, limits it to protected branches, and stores the deploy credentials as environment secrets.
2. The deploy job in a workflow says `environment: production`.
3. When the job starts on `main` (a protected branch), Diffinery records a deployment with an `in_progress` status, and the job gets the `production` secrets and variables.
4. When the job finishes, the deployment gets a final status (`success`, `failure` or `inactive`). Webhooks receive a `deployment` event when the deployment is created and `deployment_status` events for each status.

Repository admins manage environments under **Settings → Environments** (protection rules) and with the REST API, which follows GitHub's paths and JSON shapes, so `gh api`, Octokit and existing scripts work after you point them at `https://diffinery.com/api/v3`. Branch patterns, environment secrets and variables are managed with the API.

## Create an environment

An environment is created in one of three ways:

- **Explicitly**, with `PUT /api/v3/repos/{owner}/{repo}/environments/{name}`. This needs a person with the admin role on the repository and a token with the `admin` scope.
- **By a workflow job** that names an environment that doesn't exist yet. The job creates it with no branch policy, secrets or variables, and the job runs.
- **By creating a deployment** with the REST API for an environment that doesn't exist yet.

Environments created automatically have no branch policy, so every ref may use them. Create sensitive environments yourself, with a policy, before a workflow uses them.

### Environment names

- 1 to 255 characters, with no control characters, `/` or `\`. Anything else fails with `422 invalid environment name`.
- Names are case-insensitive: `Production` and `production` are the same environment. Once an environment exists, deployments, statuses and jobs that name it in another case use its existing spelling, and filtering deployments with `?environment=` ignores case.
- URL-encode the name in API paths, for example `environments/QA%20cluster`.

### Create one with the API

An empty body creates the environment with no branch policy:

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/environments/staging \
  -H "Authorization: Bearer dfy_..."
```

Create one that only protected branches may use:

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/environments/production \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"deployment_branch_policy": {"protected_branches": true, "custom_branch_policies": false}}'
```

The response (`200 OK`) is the environment:

```json
{
  "id": 1,
  "node_id": "RW52aXJvbm1lbnQ6YWNtZS93ZWJzaXRlLzE",
  "name": "production",
  "url": "https://diffinery.com/api/v3/repos/acme/website/environments/production",
  "html_url": "https://diffinery.com/acme/website/settings/environments/production",
  "created_at": "2026-10-13T09:00:00Z",
  "updated_at": "2026-10-13T09:00:00Z",
  "can_admins_bypass": false,
  "protection_rules": [{ "id": 13, "node_id": "QnJhbmNoUG9saWN5OjE", "type": "branch_policy" }],
  "deployment_branch_policy": { "protected_branches": true, "custom_branch_policies": false }
}
```

Notes on the fields:

- `protection_rules` lists a `wait_timer` entry (with `wait_timer`), a `required_reviewers` entry (with `prevent_self_review` and `reviewers`, each `{"type": "User", "reviewer": {...}}`) and a `branch_policy` entry, for the rules the environment has. See [Required reviewers and wait timers](#required-reviewers-and-wait-timers).
- `can_admins_bypass` is always `false`: nobody bypasses an environment's rules, admins included.
- `html_url` is the environment's page under **Settings → Environments**.

`PUT` on an existing environment updates it. Fields you leave out keep their values. The body accepts:

| Field | Effect |
|---|---|
| `deployment_branch_policy` | `null` removes the policy (any ref may deploy). An object sets exactly one of `protected_branches` and `custom_branch_policies` to `true`. Leave the field out to keep the current policy. |
| `wait_timer` | Minutes a job waits before it deploys, from `0` to `43200`. Anything else fails with `422 wait_timer must be a whole number of minutes from 0 to 43200`. |
| `reviewers` | Up to 6 required reviewers, each `{"type": "User", "id": <id>}` with the numeric `id` Diffinery's API shows for the person, or `{"type": "User", "login": "alice"}`. `[]` or `null` removes them. Each must be a person with at least read access: an agent fails with `422 reviewers[0]: <login> is an agent; only people can be required reviewers`, and `{"type": "Team"}` fails because Diffinery has no teams. |
| `prevent_self_review` | `true` stops whoever started a run from approving it. See [Prevent self-review](#prevent-self-review). |

### List, get and delete environments

```sh
# Every environment, sorted by name (read access)
curl https://diffinery.com/api/v3/repos/acme/website/environments \
  -H "Authorization: Bearer dfy_..."

# One environment (read access)
curl https://diffinery.com/api/v3/repos/acme/website/environments/production \
  -H "Authorization: Bearer dfy_..."

# Delete it, with its secrets and variables (admin, people only)
curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/environments/staging \
  -H "Authorization: Bearer dfy_..."
```

The list returns `{"total_count": 2, "environments": [...]}` and takes `per_page` (default 30, at most 100) and `page`. Deleting returns `204 No Content` and removes the environment's secrets and variables. The deployments recorded for it stay. A missing environment returns `404 environment not found`.

## Deployment branch policies

A branch policy decides which refs a workflow job may use the environment from. It's checked when a job with `environment:` starts. A job whose ref isn't allowed fails before any step runs, with:

```text
feature/login is not allowed to deploy to production due to environment protection rules.
```

The policy has three settings:

| Setting | API value | Which refs may deploy |
|---|---|---|
| No policy | `"deployment_branch_policy": null` | Every branch, tag and pull request ref. |
| Protected branches only | `{"protected_branches": true, "custom_branch_policies": false}` | Branches that a branch protection rule matches. Tags and pull request refs never. |
| Selected branches and tags | `{"protected_branches": false, "custom_branch_policies": true}` | Branches and tags that match one of the environment's patterns. Pull request refs never. |

Setting both values to `true`, or both to `false`, fails with `422 set exactly one of protected_branches and custom_branch_policies`.

The branch policy only applies to workflow jobs. A deployment created directly with the REST API isn't checked against it.

### Protected branches only

A branch counts as protected when one of the repository's branch protection rules matches its name (see [Branch protection](/docs/repositories/branch-protection)). The default branch is only protected for this purpose when a rule matches it, so add a rule for `main` if production deploys from `main`.

This is the setting to use for environments whose secrets matter: changes reach protected branches through reviewed pull requests, and it's the only setting under which runs whose code came from an agent receive environment secrets.

### Selected branches and tags

With `custom_branch_policies`, the environment allows the refs that match its patterns, and nothing else. A new custom policy has no patterns, so no ref may deploy until you add one.

Add a pattern (admin, people only):

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/environments/production/deployment-branch-policies \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "release/*", "type": "branch"}'
```

```json
{ "id": 1, "name": "release/*", "type": "branch", "node_id": "QnJhbmNoUG9saWN5OjEvMQ" }
```

`type` is `branch` (the default) or `tag`. A branch pattern is matched against branch names (`refs/heads/<name>`), and a tag pattern against tag names (`refs/tags/<name>`). Adding a pattern to an environment that doesn't use `custom_branch_policies` fails with `422 enable custom_branch_policies on the environment first`; an empty `name` fails with `422 name is required`.

List and delete patterns:

```sh
curl https://diffinery.com/api/v3/repos/acme/website/environments/production/deployment-branch-policies \
  -H "Authorization: Bearer dfy_..."

curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/environments/production/deployment-branch-policies/1 \
  -H "Authorization: Bearer dfy_..."
```

The list returns `{"total_count": 1, "branch_policies": [{"id": 1, "name": "release/*", "type": "branch", "node_id": "..."}]}`. Switching an environment from custom patterns to protected branches only clears its patterns; switching back to custom patterns starts empty.

Pattern syntax:

| Pattern | Matches |
|---|---|
| `*` | Any characters except `/` |
| `**` | Any characters, including `/` |
| `?` | One character other than `/` |
| Anything else | Itself, case-sensitively |

Examples:

| Pattern | Type | Matches | Doesn't match |
|---|---|---|---|
| `main` | branch | `main` | `main-2`, `Main` |
| `release/*` | branch | `release/1.4` | `release/1.4/hotfix`, `release` |
| `release/**` | branch | `release/1.4`, `release/1.4/hotfix` | `releases/1.4` |
| `v*` | tag | `v1.4.0`, `v2` | `1.4.0` |
| `v?.*` | tag | `v1.4`, `v2.0` | `v10.0` |

> **Important:** A tag pattern never matches a tag that an agent created or last moved, whether it pushed the tag with git, created it with a release or wrote it through the API. Diffinery remembers who last moved each tag. Tags that people push can deploy through a tag pattern; tags that agents push can't.

### The default policy when the first secret is added

When you add a secret to an environment that has no branch policy, Diffinery sets the policy to **protected branches only** at the same time. This keeps a new environment's secrets away from unreviewed branches. If you want selected branches and tags instead, set `custom_branch_policies` (before or after adding the secret) and add patterns. If you remove the policy afterwards with `"deployment_branch_policy": null`, it stays removed.

## Required reviewers and wait timers

Protection rules hold a job before it starts. When a job that names the environment is ready to run, and the environment has required reviewers or a wait timer, the job waits. No runner starts, no token is minted and no secret leaves Diffinery until the rules pass. The job's status is `waiting` (shown as **Waiting for approval** in the web UI), the run's status is `waiting`, and the job's deployment gets a `waiting` status. A waiting job holds no concurrency group and none of the repository's hosted-runner slots, so other jobs keep running.

The branch policy is checked first. A ref that may never deploy to the environment fails at once, without asking anyone.

Set the rules under **Settings → Environments → (environment)**, or with the API:

```sh
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/environments/production \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"reviewers": [{"type": "User", "login": "alice"}, {"type": "User", "login": "bob"}], "wait_timer": 10, "prevent_self_review": true}'
```

### Required reviewers

- One approval from any listed reviewer lets the run's jobs for that environment go on. A rejection fails them, with `The deployment to production was rejected by alice: <comment>`, and jobs that need them are skipped as usual.
- The first decision on an environment in a run is the one that counts. Approving covers every job and matrix leg of that run that names the environment.
- Reviewers get a notification and an email (Actions email settings apply), the environment shows under **Deployments waiting for you** on [Today](/docs/agents/today), and the run page shows a **Review deployments** box with each environment they may approve, a comment and **Approve and deploy** or **Reject**.
- Only a person can approve, signed in to the web UI or with a personal token that has the `write` scope. Agents, a workflow's `GITHUB_TOKEN` and sandbox tokens can't, even when an agent's account is listed by mistake. Being listed is enough; a reviewer with read access may approve. That access is checked again when they decide, and it has to be access they were given (as the owner, a collaborator or an organization member): on a public repository, a reviewer removed from it can't approve, even though they can still read it.
- A job waits at most 30 days. After that it fails with `The deployment to production wasn't approved within 30 days.`

### Prevent self-review

With `prevent_self_review`, these people can't approve a run, even when they're listed:

- whoever started the run,
- whoever started an earlier attempt of a re-run,
- the person who owns the agent that started it.

This compares accounts, not logins, so renaming an account doesn't get around it.

They see why on the run page, and the API answers `403 production doesn't let whoever started a run approve it`.

### Wait timers

A wait timer delays the job by that many minutes, counted from when it became ready to start. With reviewers too, the job starts once someone approved and the timer has passed, whichever comes last. Nobody can skip a timer.

### Re-runs

A re-run is a new run: its jobs wait again and need a new approval. The timer starts again too. A job that a failed-job or single-job re-run keeps from the earlier attempt doesn't run again, so it neither waits nor deploys.

### Review with the API

```sh
# Environments the run waits on, and whether you may approve them
curl https://diffinery.com/api/v3/repos/acme/website/actions/runs/{run_id}/pending_deployments \
  -H "Authorization: Bearer dfy_..."

# Approve (or "rejected"); returns the deployments of the jobs that were waiting
curl -X POST https://diffinery.com/api/v3/repos/acme/website/actions/runs/{run_id}/pending_deployments \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"environment_ids": [1], "state": "approved", "comment": "Ship it"}'

# Past decisions on the run
curl https://diffinery.com/api/v3/repos/acme/website/actions/runs/{run_id}/approvals \
  -H "Authorization: Bearer dfy_..."
```

A pending deployment looks like GitHub's:

```json
[
  {
    "environment": { "id": 1, "node_id": "...", "name": "production", "url": "...", "html_url": "..." },
    "wait_timer": 10,
    "wait_timer_started_at": "2026-10-13T09:30:00Z",
    "current_user_can_approve": true,
    "reviewers": [{ "type": "User", "reviewer": { "login": "alice", "id": 12345, "type": "User" } }]
  }
]
```

| Error | Meaning |
|---|---|
| `422 environment 1 isn't waiting for a review in this run` | Nothing in the run waits on that environment, or someone already decided. |
| `403 you aren't a required reviewer for production` | Only listed reviewers may decide. |
| `403 only people can review deployments, not agents` | Agents never approve deployments. |
| `403 reviewing deployments needs a token that may write` | Use a token with the `write` scope. |
| `403 only people with access to this repository review its deployments` | The reviewer was removed from the repository after being listed. Add them back, or change the environment's reviewers. |

Each approval and rejection is in the audit log as `deployment.approve` or `deployment.reject`, with the comment.

## Environment secrets and variables

Environment secrets and variables work like repository ones, but only jobs that use the environment receive them. They are managed with the REST API. Secret values are encrypted at rest with a key specific to the repository and the environment.

### Environment secrets

Setting and deleting environment secrets needs a person (not an agent) with the admin role on the repository, and a token with the `admin` scope. The environment must exist.

```sh
# Create or replace a secret: 201 Created when new, 204 No Content when replaced
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/environments/production/secrets/CLOUDFLARE_API_TOKEN \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"value": "cf_..."}'

# List names (values are never returned)
curl https://diffinery.com/api/v3/repos/acme/website/environments/production/secrets \
  -H "Authorization: Bearer dfy_..."

# One secret's metadata
curl https://diffinery.com/api/v3/repos/acme/website/environments/production/secrets/CLOUDFLARE_API_TOKEN \
  -H "Authorization: Bearer dfy_..."

# Delete (204 No Content)
curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/environments/production/secrets/CLOUDFLARE_API_TOKEN \
  -H "Authorization: Bearer dfy_..."
```

The list returns `{"total_count": 1, "secrets": [{"name": "CLOUDFLARE_API_TOKEN", "created_at": "...", "updated_at": "..."}]}`; listing and reading need the admin role.

Rules:

- Names use letters, digits and underscores, don't start with a digit, and don't start with `GITHUB_`. Anything else fails with `422 invalid secret name`. Names are stored in uppercase.
- Send the value as `value`, in plain JSON over HTTPS. A body with only GitHub's sealed-box `encrypted_value` fails with ``422 encrypted_value (sealed box) is not supported yet: send the secret as `value` over HTTPS; it is encrypted at rest``. There's no `public-key` endpoint.
- Adding the first secret to an environment without a branch policy sets it to protected branches only (see [The default policy when the first secret is added](#the-default-policy-when-the-first-secret-is-added)).
- Agents can't set or delete them, whatever their role (`403 agents cannot manage secrets` for an agent with the admin role).

### Environment variables

| Request | Needs | Does |
|---|---|---|
| `GET /api/v3/repos/{owner}/{repo}/environments/{env}/variables` | write role | Returns `{"total_count": 1, "variables": [{"name", "value", "created_at", "updated_at"}]}`. `per_page` defaults to 10 (at most 100). |
| `GET /api/v3/repos/{owner}/{repo}/environments/{env}/variables/{name}` | write role | Returns one variable, or `404 Not Found`. |
| `POST /api/v3/repos/{owner}/{repo}/environments/{env}/variables` with `{"name": "...", "value": "..."}` | admin role, people only | Creates a variable (`201`). An existing name fails with `409 Already exists - Variable already exists`. |
| `PATCH /api/v3/repos/{owner}/{repo}/environments/{env}/variables/{name}` with `{"value": "..."}` and optionally a new `"name"` | admin role, people only | Updates or renames a variable (`204`), or `404 Not Found`. Renaming onto a name that already exists fails with `409 Already exists - Variable already exists`. |
| `DELETE /api/v3/repos/{owner}/{repo}/environments/{env}/variables/{name}` | admin role, people only | Deletes a variable (`204`). |

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/environments/production/variables \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "DEPLOY_URL", "value": "https://www.example.com"}'
```

Variable names follow the same rules as secret names (`422 invalid variable name` otherwise) and are stored in uppercase. Variables are not secret: anyone with write access can read them. Agents can't create, change or delete them, whatever their role (`403 agents cannot manage variables` for an agent with the admin role).

### Who receives environment secrets

A job that uses an environment receives its secrets only when all of these hold:

1. The environment's branch policy allows the job's ref (otherwise the job fails, see [Deployment branch policies](#deployment-branch-policies)).
2. The run isn't on a pull request ref (`refs/pull/<number>/merge`). Environment secrets never go to `pull_request` runs, whatever the policy says.
3. If the run's code came from an agent, the environment is set to **protected branches only**. With no policy or with custom patterns, those runs get no environment secrets.

A run's code came from an agent when any of these is true:

- An agent started the run, for example with a push, a `workflow_dispatch` or a re-run.
- The run is for a branch whose last push was made by an agent.
- The run is for a pull request that an agent opened, or whose head branch an agent pushed to last.
- The run is a re-run of a run whose code came from an agent, whoever starts the re-run.
- The run was started by `workflow_run` after a run whose code came from an agent (it acts on that run's artifacts and outputs).

In such a run the job also acts as an agent: its deployment's creator is recorded as an agent, and its `GITHUB_TOKEN` follows the rules for agents (see [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions#runs-whose-code-came-from-an-agent)).

When a rule withholds the secrets, the job still runs with the environment's variables, and `${{ secrets.NAME }}` for an environment secret evaluates to an empty string.

| Run | No policy | Protected branches only | Selected branches and tags |
|---|---|---|---|
| Started by a person, on an allowed branch or tag | Secrets | Secrets | Secrets |
| Code from an agent, on an allowed branch | No secrets | Secrets | No secrets |
| `pull_request` run (`refs/pull/<n>/merge`) | Job runs, no secrets | Job fails (ref not allowed) | Job fails (ref not allowed) |
| Ref not allowed by the policy | Not applicable | Job fails | Job fails |

`pull_request_target` runs use the base branch as their ref, so they're treated like a run on that branch.

### Precedence

In a job that uses an environment:

- An environment secret replaces a repository or organization secret with the same name (and, in a called reusable workflow, a secret passed by the caller).
- An environment variable replaces a repository variable with the same name.
- `GITHUB_TOKEN` and `DIFFINERY_TOKEN` are always the job's own token.

Values are read when the job starts, so changes affect jobs that start afterwards. Environment secrets are masked in logs like every other secret. See [Secrets and variables](/docs/actions/secrets-and-variables) for masking, names and repository secrets.

## Use an environment in a job

### Syntax

Name the environment with a string:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: ./deploy.sh
```

Or with a mapping that also gives the URL of the deployed site:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://www.example.com
    steps:
      - run: ./deploy.sh
```

| Key | Description |
|---|---|
| `name` | The environment's name (required in the mapping form). Expressions are allowed. |
| `url` | Optional. Stored as the deployment status's `environment_url` when it's an `http://` or `https://` URL; other values are ignored. Expressions are allowed. |

Both values can use the `github`, `inputs`, `vars`, `matrix`, `strategy` and `needs` contexts. Other contexts evaluate to empty:

- A `name` that evaluates to an empty string fails the job with `invalid environment name ''`.
- A `url` that refers to `steps` (for example `${{ steps.deploy.outputs.url }}`, which GitHub allows) is ignored, so the deployment has no environment URL. Compute the URL from `inputs`, `vars`, `matrix` or a job output in `needs` instead, or post a deployment status yourself (see [Deployment statuses](#deployment-statuses)).

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        target: [staging, production]
    environment:
      name: ${{ matrix.target }}
      url: https://${{ matrix.target }}.example.com
    steps:
      - run: ./deploy.sh "${{ matrix.target }}"
```

`environment` belongs on jobs that have `steps`. On a job that calls a reusable workflow (`uses:`), it produces the warning `unknown reusable-workflow job key 'environment'` and is ignored; put `environment:` on the jobs inside the called workflow instead (see [Reusable workflows](#reusable-workflows)).

### What happens when the job starts

When a job with `environment:` is ready to run, Diffinery evaluates `name` once, and that name is the one the job deploys to. If the environment has required reviewers or a wait timer, the job [waits for them](#required-reviewers-and-wait-timers) first. When a hosted or self-hosted runner then starts the job, Diffinery:

1. Evaluates `url`.
2. Creates the environment if it doesn't exist (with no branch policy).
3. Checks the branch policy against the run's ref, and fails the job if the ref isn't allowed. A job whose environment needs an approval it didn't get fails with `The environment production requires approval this job didn't get. Re-run the job to ask for it.` (This happens when someone adds reviewers while the job is already on its way to a runner.)
4. Creates a deployment for the job: `ref` is the branch or tag name (or `refs/pull/<n>/merge`), `sha` is the commit the run checked out, `task` is `deploy`, `payload` is `{}`, the creator is the person or agent who started the run (an agent when the run's code came from an agent), and `production_environment` is `true` when the environment is named `production` in any case (`Production` counts).
5. Sends a `deployment` webhook event with the action `created`, then adds an `in_progress` status, with `log_url` set to the job's page (`https://diffinery.com/acme/website/actions/runs/<run id>/job/<job id>`) and `environment_url` from `url`.
6. Passes the environment's variables to the job, and its secrets when [the rules](#who-receives-environment-secrets) allow it.

A job creates one deployment, even if its runner fetches the job more than once. A re-run creates a new deployment, because it's a new job. The deployment's commit statuses and checks aren't required to have passed, unlike [deployments created with the API](#required-contexts).

### Automatic deployment statuses

When the job finishes, its deployment gets a final status with the same `log_url` and `environment_url`:

| Job conclusion | Deployment status |
|---|---|
| `success` | `success` |
| `cancelled` or `skipped` | `inactive` |
| Anything else (`failure`, timed out) | `failure` |

A `success` status also marks older deployments to the same environment as `inactive` when their latest status is `success`, unless they are transient or production deployments. Deployments created after this one are left alone. See [auto_inactive](#deployment-statuses).

### Reusable workflows

Jobs inside a called workflow can have `environment:`. The environment, its branch policy, secrets and variables come from the **calling** repository (the repository whose run it is), and the policy is checked against the caller's ref. Environment secrets are added to the job even though the caller didn't pass them in `secrets:`, as on GitHub. The environment name can use the called workflow's `inputs`:

```yaml
# .github/workflows/deploy.yml
on:
  workflow_call:
    inputs:
      target:
        type: string
        required: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: ${{ inputs.target }}
      url: https://${{ inputs.target }}.example.com
    steps:
      - uses: actions/checkout@v4
      - run: npx wrangler deploy --env "${{ inputs.target }}"
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

```yaml
# .github/workflows/release.yml
on:
  push:
    branches: [main]

jobs:
  staging:
    uses: ./.github/workflows/deploy.yml
    with:
      target: staging
  production:
    needs: staging
    uses: ./.github/workflows/deploy.yml
    with:
      target: production
```

Here `CLOUDFLARE_API_TOKEN` can be a different environment secret in `staging` and in `production`. See [Reusable workflows](/docs/actions/reusable-workflows).

### Choosing an environment when you run a workflow manually

A `workflow_dispatch` input with `type: environment` is accepted. It's shown as a text field when you run the workflow from the web UI, and its value isn't checked against the repository's environments. Use it like a string input:

```yaml
on:
  workflow_dispatch:
    inputs:
      target:
        type: environment
        required: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: ${{ inputs.target }}
    steps:
      - run: ./deploy.sh
```

Because a dispatched run can name any environment, the environment's branch policy is what keeps a branch from deploying where it shouldn't.

### Example: staging on main, production on version tags

1. Set up the environments (as a repository admin):

   ```sh
   api=https://diffinery.com/api/v3/repos/acme/website
   auth="Authorization: Bearer dfy_..."

   # staging: protected branches only (add a branch protection rule for main first)
   curl -X PUT "$api/environments/staging" -H "$auth" -H "Content-Type: application/json" \
     -d '{"deployment_branch_policy": {"protected_branches": true, "custom_branch_policies": false}}'

   # production: only tags that match v*
   curl -X PUT "$api/environments/production" -H "$auth" -H "Content-Type: application/json" \
     -d '{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}'
   curl -X POST "$api/environments/production/deployment-branch-policies" -H "$auth" \
     -H "Content-Type: application/json" -d '{"name": "v*", "type": "tag"}'

   # A different token for each environment
   curl -X PUT "$api/environments/staging/secrets/CLOUDFLARE_API_TOKEN" -H "$auth" \
     -H "Content-Type: application/json" -d '{"value": "cf_staging_..."}'
   curl -X PUT "$api/environments/production/secrets/CLOUDFLARE_API_TOKEN" -H "$auth" \
     -H "Content-Type: application/json" -d '{"value": "cf_production_..."}'
   ```

2. Write the workflow:

   ```yaml
   name: Deploy
   on:
     push:
       branches: [main]
       tags: ["v*"]

   jobs:
     staging:
       if: github.ref == 'refs/heads/main'
       runs-on: ubuntu-latest
       environment:
         name: staging
         url: https://staging.example.com
       steps:
         - uses: actions/checkout@v4
         - run: npm ci && npm run build
         - run: npx wrangler deploy --env staging
           env:
             CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}

     production:
       if: startsWith(github.ref, 'refs/tags/v')
       runs-on: ubuntu-latest
       environment:
         name: production
         url: https://www.example.com
       steps:
         - uses: actions/checkout@v4
         - run: npm ci && npm run build
         - run: npx wrangler deploy --env production
           env:
             CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
   ```

Pushing to `main` deploys to staging; a person pushing the tag `v1.4.0` deploys to production. A tag pushed by an agent fails the production job with the "not allowed to deploy" message.

## Deployments API

You can create deployments yourself, for example from a deploy tool outside Diffinery Actions, and report their progress with statuses. The endpoints follow GitHub's REST API. Creating deployments and statuses needs the write role and a token with the `write` scope; reading needs read access. Agents with write access can create deployments and statuses.

A workflow step can create deployments and statuses with `GITHUB_TOKEN` when the job has `deployments: write` in its `permissions:`. Without it, the request fails with `403 Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: deployments: write)`, or `403 write access required` when the token has no write scope at all. Often `environment:` on the job is simpler, because it records the deployment for you. See [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions).

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      deployments: write
    steps:
      - run: |
          curl -fsS -X POST "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/deployments" \
            -H "Authorization: Bearer $GITHUB_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{"ref": "${{ github.sha }}", "environment": "preview", "required_contexts": []}'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Create a deployment

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/deployments \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"ref": "main", "environment": "production", "description": "Deploy 1.4.0", "required_contexts": ["ci/build"]}'
```

| Field | Default | Description |
|---|---|---|
| `ref` | required | A branch, tag or commit SHA. Missing: `422 ref is required`. Unknown: `422 no ref found for: <ref>`. |
| `environment` | `production` | The environment's name. It's created if it doesn't exist. |
| `task` | `deploy` | Free text. Only the first 100 characters are kept. |
| `payload` | `{}` | Any JSON value, or a string. Returned as it was sent. |
| `description` | `null` | Free text. Only the first 1,000 characters are kept. |
| `required_contexts` | every context | See [Required contexts](#required-contexts). Up to 100 strings. |
| `transient_environment` | `false` | Marks the environment as temporary (it's skipped by `auto_inactive`). |
| `production_environment` | `true` when `environment` is `production`, in any case | Marks a production deployment (it's skipped by `auto_inactive`). |
| `auto_merge` | | Accepted and ignored. Diffinery never merges the default branch into `ref`. |

The response is `201 Created` with the deployment (some user fields left out here):

```json
{
  "url": "https://diffinery.com/api/v3/repos/acme/website/deployments/7",
  "id": 7,
  "node_id": "RGVwbG95bWVudDphY21lL3dlYnNpdGUvNw",
  "sha": "9fceb02d0ae598e95dc970b74767f19372d61af8",
  "ref": "main",
  "task": "deploy",
  "payload": {},
  "original_environment": "production",
  "environment": "production",
  "description": "Deploy 1.4.0",
  "creator": { "login": "diffy", "type": "User" },
  "created_at": "2026-10-13T09:30:00Z",
  "updated_at": "2026-10-13T09:30:00Z",
  "statuses_url": "https://diffinery.com/api/v3/repos/acme/website/deployments/7/statuses",
  "repository_url": "https://diffinery.com/api/v3/repos/acme/website",
  "transient_environment": false,
  "production_environment": true,
  "performed_via_github_app": null
}
```

### Required contexts

Before creating a deployment, Diffinery checks the commit's checks and commit statuses, as GitHub does:

- **`required_contexts` left out:** every check and status context reported on the commit must have passed. Contexts reported only by agents aren't counted.
- **A list of names:** each named context must have passed. A name that nothing reported counts as not passed.
- **`[]`:** nothing is checked.

A context passes when its result is `success`, `neutral` or `skipped`. When several reporters use the same name, the same rules as for required checks in branch protection apply: Diffinery Actions decides a check it reported, any failure fails, anything unfinished is pending, and reports from agents never count. See [Checks and commit statuses](/docs/collaboration/checks-and-statuses).

If a context hasn't passed, the request fails with `409`:

```json
{
  "message": "Conflict: Commit status checks failed for main.",
  "errors": [
    { "contexts": [{ "context": "ci/build", "state": "pending" }], "resource": "Deployment", "field": "required_contexts" }
  ],
  "documentation_url": "https://docs.github.com/rest"
}
```

`state` is `failure`, `pending` or `missing`. Wait for the checks to finish, or pass `required_contexts` with only the contexts you care about.

Deployments that workflow jobs create for `environment:` skip this check.

### List, get and delete deployments

```sh
# Newest first; filter by sha, ref, task or environment (exact match)
curl "https://diffinery.com/api/v3/repos/acme/website/deployments?environment=production&per_page=10" \
  -H "Authorization: Bearer dfy_..."

curl https://diffinery.com/api/v3/repos/acme/website/deployments/7 \
  -H "Authorization: Bearer dfy_..."

curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/deployments/7 \
  -H "Authorization: Bearer dfy_..."
```

- The list takes `per_page` (default 30, at most 100) and `page`, and sends a `Link` header.
- The `ref` filter compares the stored ref exactly. Deployments created by workflow jobs store the branch or tag name (`main`, `v1.4.0`), not `refs/heads/main`.
- A missing deployment returns `404 deployment not found`.
- Deleting needs the write role and returns `204 No Content`. A deployment whose latest status is `success` can't be deleted while other deployments to the same environment exist: `422 We cannot delete an active deployment unless it is the only deployment in a given environment.` Post an `inactive` status first.

### Deployment statuses

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/deployments/7/statuses \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"state": "success", "log_url": "https://ci.example.com/builds/812", "environment_url": "https://www.example.com", "description": "Deployed"}'
```

| Field | Description |
|---|---|
| `state` | Required: `error`, `failure`, `inactive`, `in_progress`, `queued`, `pending` or `success`. Anything else fails with `422 state must be one of error, failure, inactive, in_progress, queued, pending, success`. |
| `log_url` | Link to the deployment's output. `target_url` is accepted as an older name for it. |
| `environment_url` | Link to the deployed environment. |
| `description` | Up to 140 characters; longer text is cut. |
| `environment` | Moves the deployment to another environment (created if needed). The deployment's `original_environment` keeps the first name. |
| `auto_inactive` | Default `true`. With a `success` state, older deployments to the same environment whose latest status is `success` get an `inactive` status, except transient and production deployments. Deployments created after this one are left alone. Send `false` to keep them all. |

URLs must start with `http://` or `https://` (`422 URLs must be http(s)`). The response is `201 Created`:

```json
{
  "url": "https://diffinery.com/api/v3/repos/acme/website/deployments/7/statuses/15",
  "id": 15,
  "node_id": "RGVwbG95bWVudFN0YXR1czphY21lL3dlYnNpdGUvMTU",
  "state": "success",
  "creator": { "login": "diffy", "type": "User" },
  "description": "Deployed",
  "environment": "production",
  "target_url": "https://ci.example.com/builds/812",
  "log_url": "https://ci.example.com/builds/812",
  "environment_url": "https://www.example.com",
  "created_at": "2026-10-13T09:34:10Z",
  "updated_at": "2026-10-13T09:34:10Z",
  "deployment_url": "https://diffinery.com/api/v3/repos/acme/website/deployments/7",
  "repository_url": "https://diffinery.com/api/v3/repos/acme/website",
  "performed_via_github_app": null
}
```

List a deployment's statuses, newest first, with `GET /api/v3/repos/{owner}/{repo}/deployments/{id}/statuses` (`per_page`, `page`), and get one with `GET /api/v3/repos/{owner}/{repo}/deployments/{id}/statuses/{status_id}` (`404 deployment status not found` if it doesn't exist).

## Endpoint summary

All paths are under `https://diffinery.com/api/v3`. Every endpoint is also in the [API reference](/docs/api).

| Method and path | Needs |
|---|---|
| `GET /repos/{owner}/{repo}/deployments` | read |
| `POST /repos/{owner}/{repo}/deployments` | write |
| `GET /repos/{owner}/{repo}/deployments/{id}` | read |
| `DELETE /repos/{owner}/{repo}/deployments/{id}` | write |
| `GET /repos/{owner}/{repo}/deployments/{id}/statuses` | read |
| `POST /repos/{owner}/{repo}/deployments/{id}/statuses` | write |
| `GET /repos/{owner}/{repo}/deployments/{id}/statuses/{status_id}` | read |
| `GET /repos/{owner}/{repo}/environments` | read |
| `GET /repos/{owner}/{repo}/environments/{env}` | read |
| `PUT /repos/{owner}/{repo}/environments/{env}` | admin, people only |
| `DELETE /repos/{owner}/{repo}/environments/{env}` | admin, people only |
| `GET /repos/{owner}/{repo}/environments/{env}/deployment-branch-policies` | read |
| `POST /repos/{owner}/{repo}/environments/{env}/deployment-branch-policies` | admin, people only |
| `DELETE /repos/{owner}/{repo}/environments/{env}/deployment-branch-policies/{id}` | admin, people only |
| `GET /repos/{owner}/{repo}/environments/{env}/secrets` and `.../secrets/{name}` | admin |
| `PUT` and `DELETE /repos/{owner}/{repo}/environments/{env}/secrets/{name}` | admin, people only |
| `GET /repos/{owner}/{repo}/environments/{env}/variables` and `.../variables/{name}` | write |
| `POST /repos/{owner}/{repo}/environments/{env}/variables` | admin, people only |
| `PATCH` and `DELETE /repos/{owner}/{repo}/environments/{env}/variables/{name}` | admin, people only |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments` | read |
| `POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments` | a listed reviewer (people only, `write` token) |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals` | read |

The token's scope caps the role: a `read` token only reads (any other request gets `403 this token needs the write scope`), a `write` token also writes, and only an `admin` token reaches the admin endpoints. Requests without a token can read the environments and deployments of a public repository, but any change gets `401 authentication required`. On an archived repository, every request other than a read fails with `403 repository is archived (read-only)`.

## Webhooks

Repository webhooks receive three events, with the GitHub event names in the `X-GitHub-Event` header. In the web UI's **Add a webhook** form, choose **Everything** to receive them; with the API, list `deployment`, `deployment_status` and `deployment_review` in the webhook's `events`. See [Webhooks](/docs/repositories/webhooks).

### deployment

Sent when a deployment is created with the REST API:

```json
{
  "action": "created",
  "deployment": {
    "id": 7,
    "sha": "9fceb02d0ae598e95dc970b74767f19372d61af8",
    "ref": "main",
    "task": "deploy",
    "environment": "production",
    "description": "Deploy 1.4.0",
    "payload": {},
    "created_at": "2026-10-13T09:30:00.000Z"
  },
  "repository": { "full_name": "acme/website" },
  "sender": { "login": "diffy", "type": "User" }
}
```

Deployments that workflow jobs create for `environment:` send this event too, when the job starts. Their `description` is `null`, `task` is `deploy` and `payload` is `{}`.

### deployment_status

Sent for every status created with the REST API or by a workflow job (the `in_progress` status when the job starts and the final status when it ends):

```json
{
  "action": "created",
  "deployment_status": {
    "id": 15,
    "state": "success",
    "description": "",
    "environment": "production",
    "environment_url": "https://www.example.com",
    "log_url": "https://diffinery.com/acme/website/actions/runs/01J9Z.../job/01J9Z...",
    "created_at": "2026-10-13T09:34:10.000Z"
  },
  "deployment": { "id": 7, "sha": "9fceb02d0ae598e95dc970b74767f19372d61af8", "ref": "main", "task": "deploy", "environment": "production" },
  "repository": { "full_name": "acme/website" },
  "sender": { "login": "diffy", "type": "User" }
}
```

The `inactive` statuses that `auto_inactive` adds to older deployments don't send events. The `repository` and `sender` objects have more fields than shown; see [Webhook events](/docs/reference/webhook-events).

### deployment_review

Sent when a run starts waiting on an environment's required reviewers (`requested`), and when a reviewer decides (`approved` or `rejected`). The payload has `environment`, `environment_id`, `comment`, `workflow_run` (`id`, `run_number`, `name`, `display_title`, `head_sha`, `head_branch`, `html_url`), `reviewers`, and `requestor` (requested) or `approver` (approved and rejected).

Workflows with `on: deployment` or `on: deployment_status` are accepted but never started. To run something after a deployment, use `needs:` on a later job, or a webhook.

## Agents and environments

Environments guard deployment credentials, so agents are limited:

- Agents can't create, change or delete environments or their branch policies, whatever their role. An agent with the write role gets `403 admin access required`; one that was given the admin role gets `403 only repository admins (people, not agents) can manage environments`.
- Agents can't set or delete environment secrets: an agent with the admin role gets `403 agents cannot manage secrets`.
- Agents can't create, change or delete environment variables: an agent with the admin role gets `403 agents cannot manage variables`.
- Runs whose code came from an agent only get environment secrets from environments set to protected branches only, and never on pull request refs (see [Who receives environment secrets](#who-receives-environment-secrets)).
- Tags that an agent created or moved never match an environment's tag patterns.
- Agents with write access can create deployments and deployment statuses with the API (with a `write` token), and can read environments and environment variables.

Together with branch protection (agents can't push to protected branches unless a rule allows it, and pull requests opened by agents need a human approval), this means an agent can't get production credentials into code that no person reviewed. The exception is a branch whose rule has **Let agents' auto-merges land without an approving review** on (see [Waiving approvals for agents](/docs/repositories/branch-protection#waiving-approvals-for-agents)): there an agent's pull request lands on green required checks alone, and the runs that follow on that branch receive the secrets of environments limited to protected branches. Turn that waiver on only where the required checks are the review you rely on. See [Agents](/docs/agents/overview).

## Audit log

Changes to environments made with the API are recorded in the audit log, without secret values:

| Action | When |
|---|---|
| `environment.update` | An environment is created or updated with `PUT` or in Settings (with the new branch policy, reviewers, wait timer and self-review setting). |
| `environment.delete` | An environment is deleted. |
| `environment.branch_policy.create` | A branch or tag pattern is added. |
| `environment.branch_policy.delete` | A pattern is removed. |
| `environment.secret.set` | An environment secret is created or replaced (name only). |
| `environment.secret.delete` | An environment secret is deleted. |
| `deployment.approve`, `deployment.reject` | A required reviewer approves or rejects a run's environments (with the comment). |

Environment variable changes aren't recorded. See [Audit log](/docs/security/audit-log).

## What isn't supported

- **Custom deployment protection rules** (GitHub Apps that gate deployments) and **team reviewers**. Diffinery has no teams; list people.
- **Admin bypass.** Nobody skips an environment's rules.
- **Web UI for branch patterns, environment secrets and variables.** Settings → Environments edits the protection rules; the rest is managed with the REST API.
- **Reading or updating a single branch pattern.** You can list, add and delete patterns, but not `GET` or `PUT` one by id.
- **Sealed-box secrets.** Send `value`, not `encrypted_value`.
- **Organization-level environments and environment secrets.** Environments belong to one repository.
- **`on: deployment` and `on: deployment_status` workflow triggers.** Accepted but never started.

## Differences from GitHub

| Area | GitHub | Diffinery |
|---|---|---|
| Managing environments | Web UI and API | Protection rules in Settings → Environments and the API; patterns, secrets and variables with the API |
| Required reviewers | People and teams | People only, never agents; an agent or a job token can't approve |
| Prevent self-review | Covers whoever triggered the run | Also covers earlier attempts' starters and the owner of an agent that started it |
| Admin bypass | Admins can bypass protection rules | Nobody bypasses them; `can_admins_bypass` is `false` |
| Default branch policy | All branches | All refs, until the first secret is added; then protected branches only |
| Protected branches | Branches with protection rules | Branches matched by a branch protection rule; the default branch counts only when a rule matches it |
| Pull request runs | Fork pull requests get no secrets | No `pull_request` run gets environment secrets |
| Agents | No equivalent | Agents can't manage environments, get environment secrets only under "protected branches only", and their tags never match tag patterns |
| `environment.url` | Can use `steps` outputs | `steps` references are ignored |
| Deployment `auto_merge` | Merges the default branch into the ref | Ignored |
| Branch patterns | `fnmatch` syntax with character classes | `*`, `**` and `?` only, unlike workflow filters |

## Troubleshooting

| Problem | Cause and fix |
|---|---|
| `<ref> is not allowed to deploy to <env> due to environment protection rules.` | The environment's branch policy doesn't allow the run's ref. Check the policy with `GET .../environments/<env>`: with protected branches only, add a branch protection rule for the branch; with custom patterns, add a matching pattern. A tag last pushed by an agent never matches. |
| The deploy job fails on a pull request | Pull request refs never pass a branch policy. Add `if: github.event_name == 'push'` (or a branch check) to the deploy job. |
| `invalid environment name ''` | `environment.name` evaluated to an empty string, for example because it uses `steps`, or a `needs` output that's empty. Use `inputs`, `vars`, `matrix`, `needs` or a literal. |
| An environment secret is empty in the job | The run is on a pull request ref, or the run's code came from an agent and the environment isn't set to protected branches only, or the name is wrong. Variables are still set. |
| A new environment suddenly refuses a branch | Adding its first secret set the policy to protected branches only. Add a branch protection rule, or switch to custom patterns. |
| `403 only repository admins (people, not agents) can manage environments` | Use a person's token with the `admin` scope and the admin role on the repository. |
| `403 agents cannot manage secrets` | Use a person's token. |
| `403 agents cannot manage variables` | Agents can't change environment variables. Use a person's token. |
| `403 this token needs the write scope` | The token has only the `read` scope. Use a `write` token for deployments and statuses, or an `admin` token for environment settings. |
| A job stays **Waiting for approval** | The environment has required reviewers: one of them approves on the run page or with `pending_deployments`. With a wait timer, the job starts when it ends. |
| `422 reviewers[0]: no such person with access to this repository` | GitHub's numeric user ids don't carry over. Use `{"type": "User", "login": "..."}` with a Diffinery login. |
| `422 set exactly one of protected_branches and custom_branch_policies` | Set one to `true` and the other to `false`, or send `null` to remove the policy. |
| `422 enable custom_branch_policies on the environment first` | Set `custom_branch_policies: true` with `PUT` before adding patterns. |
| `409 Conflict: Commit status checks failed for <ref>.` | A context on the commit hasn't passed. Wait for it, or pass `required_contexts` (`[]` to skip the check). |
| `422 We cannot delete an active deployment unless it is the only deployment in a given environment.` | Post an `inactive` status to the deployment first. |
| `403 Resource not accessible by integration` or `403 write access required` when a workflow step creates a deployment | The job lacks `deployments: write`. Add it to the job's `permissions:`, or use `environment:` on the job. |
| `403 admin access required` | Managing environments, branch patterns, environment secrets and variable changes needs the admin role and an `admin`-scoped token. |
| The deployment has no environment URL | `environment.url` used `steps`, or wasn't an `http(s)` URL. |
