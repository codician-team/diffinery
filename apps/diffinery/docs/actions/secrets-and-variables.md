---
title: Secrets and variables
description: Store credentials as encrypted secrets and settings as variables for workflows, per repository, organization or environment, and who can manage them.
---

Secrets hold sensitive values such as API tokens and deploy keys; variables hold plain configuration such as a region or a feature flag. Workflows read them as `${{ secrets.NAME }}` and `${{ vars.NAME }}`, exactly as on GitHub. Secrets are encrypted at rest and masked in logs; variables are stored and shown in plain text.

## What you can store

| Kind | Scope | Manage in the web UI | Manage with the CLI and API | Who can manage |
|---|---|---|---|---|
| Repository secret | One repository | Yes | Yes | People with the admin role on the repository |
| Organization secret | Every repository the organization owns, its private ones, or the ones you select | No | Yes | Organization owners and admins, and site admins (people only) |
| Repository variable | One repository | Yes | Yes | People with the admin role on the repository |
| Organization variable | Every repository the organization owns | No | API only | Organization owners and admins, and site admins (people only) |
| Environment secret | Jobs of one repository that use the environment | No | API only | People with the admin role on the repository |
| Environment variable | Jobs of one repository that use the environment | No | API only | People with the admin role on the repository |

Agents can't create, change or delete secrets or variables anywhere, whatever their role (see [Agents, secrets and variables](#agents-secrets-and-variables)). Environment secrets and variables are described in [Environment secrets and variables](#environment-secrets-and-variables) below and in full in [Deployments and environments](/docs/actions/environments).

## Names

- Names use letters, digits and underscores, and don't start with a digit (`^[A-Za-z_][A-Za-z0-9_]*$`). For repository variables, only the web form checks this (the organization variables API checks it too); the variables API accepts other names, which expressions may not be able to read, so keep to the same format.
- Names are stored in uppercase: saving `api_key` creates `API_KEY`. In expressions, `secrets.api_key` and `secrets.API_KEY` both find it.
- Repository and environment secrets, and environment and organization variables, can't start with `GITHUB_`. Saving one fails with `invalid secret name` (or `invalid variable name`).
- Don't name a secret `DIFFINERY_TOKEN` or `GITHUB_TOKEN`: in a job, both always hold the job's own token, which replaces any secret with the same name.

## Repository secrets

### Secrets in the web UI

1. Open the repository and go to **Settings → Secrets and variables**.
2. Under **Repository secrets**, enter a **Name** and a **Value**.
3. Click **Save secret**. Setting an existing name replaces its value.

The page lists each secret's name and when it was last updated. Values are never shown again. Click **Delete** next to a secret to remove it.

### Secrets with the CLI

The CLI needs to act as a person with admin access to the repository, with the `admin` scope. Install it and sign in:

```sh
curl -fsSL https://diffinery.com/install | bash
diffinery login --scope admin
```

The value comes from `--body`, from stdin when piped, or from a hidden prompt:

```sh
diffinery secret set CLOUDFLARE_API_TOKEN -R acme/website              # prompts for the value
diffinery secret set NPM_TOKEN -R acme/website --body "$NPM_TOKEN"
diffinery secret set DEPLOY_KEY -R acme/website < ~/.ssh/deploy_key      # multi-line values from a file
diffinery secret list -R acme/website
diffinery secret delete NPM_TOKEN -R acme/website
```

Without `-R`, the CLI uses the repository of the current directory's git `origin` remote. Passing a value with `--body` can leave it in your shell history; prefer stdin or the prompt. See [CLI reference](/docs/reference/cli) for every flag.

### Secrets with the API

```sh
# Create or replace a secret (204 No Content)
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/actions/secrets/NPM_TOKEN \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"value": "npm_..."}'

# List names (values are never returned)
curl https://diffinery.com/api/v3/repos/acme/website/actions/secrets \
  -H "Authorization: Bearer dfy_..."

# Delete (204 No Content)
curl -X DELETE https://diffinery.com/api/v3/repos/acme/website/actions/secrets/NPM_TOKEN \
  -H "Authorization: Bearer dfy_..."
```

The list response is `{"total_count": 1, "secrets": [{"name": "NPM_TOKEN", "updated_at": "..."}]}`. Unlike GitHub, the value is sent as plain JSON over HTTPS; there's no public key to encrypt it with first. A body that only has GitHub's sealed-box `encrypted_value` fails with ``422 encrypted_value (sealed box) is not supported yet: send the secret as `value` over HTTPS; it is encrypted at rest``, and there's no `public-key` endpoint, so tools that encrypt the value first don't work; send `value` instead. The token needs the `admin` scope and its owner needs the admin role on the repository. See [API reference](/docs/api) for the full endpoint list.

## Organization secrets

Organization secrets are available to workflows in the organization's repositories. As on GitHub, each secret has a `visibility` that says which repositories get it:

- `all`: every repository the organization owns (the default for a new secret).
- `private`: its private and internal repositories, not its public ones.
- `selected`: only the repositories you list.

They're managed with the CLI or the API; there's no web page for them.

```sh
diffinery secret set SENTRY_AUTH_TOKEN --org acme
diffinery secret set DEPLOY_KEY --org acme --repos website,api        # only these two repositories
diffinery secret set NPM_TOKEN --org acme --visibility private
diffinery secret list --org acme
diffinery secret delete SENTRY_AUTH_TOKEN --org acme
```

```sh
curl -X PUT https://diffinery.com/api/v3/orgs/acme/actions/secrets/SENTRY_AUTH_TOKEN \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"value": "sntrys_..."}'
```

With the API, send `visibility` and, for `selected`, `selected_repository_ids` (the repositories' numeric `id`s) with the value: `{"value": "…", "visibility": "selected", "selected_repository_ids": [123, 456]}`. An update that leaves them out keeps the secret's selection. An id that isn't one of the organization's repositories gets `422`.

| Endpoint | Does |
|---|---|
| `GET /api/v3/orgs/{org}/actions/secrets` | Lists names, update times and `visibility` |
| `GET /api/v3/orgs/{org}/actions/secrets/{name}` | One secret's name, update time and `visibility` (never the value) |
| `GET /api/v3/orgs/{org}/actions/secrets/{name}/repositories` | The selected repositories |
| `PUT /api/v3/orgs/{org}/actions/secrets/{name}/repositories` | Replaces the selection: `{"selected_repository_ids": [123, 456]}` |
| `PUT` or `DELETE /api/v3/orgs/{org}/actions/secrets/{name}/repositories/{repository_id}` | Adds or removes one repository |
| `DELETE /api/v3/orgs/{org}/actions/secrets/{name}` | Removes the secret |

Changing the selection of a secret whose visibility isn't `selected` gets `409 the secret's visibility isn't selected`. A repository that leaves the selection stops getting the secret from its next job. Only organization owners and admins (and site admins) can use these endpoints; anyone else gets `403 organization admins only`.

All three endpoints, listing included, are account-level actions: the CLI or API needs a personal token with the `admin` scope that isn't restricted to repositories. A `read` or `write` token gets `403 this token needs the admin scope`, and a token restricted to repositories gets `403 this token is limited to repositories and can't change account settings`.

## Variables

### Variables in the web UI

On **Settings → Secrets and variables**, the **Variables** section lists every variable with its value. Enter a **Name** and a **Value** and click **Save variable** to add or replace one, or click **Delete** to remove one.

### Variables with the CLI

```sh
diffinery variable set DEPLOY_REGION -R acme/website --body eu-west-1
echo "https://staging.example.com" | diffinery variable set STAGING_URL -R acme/website
diffinery variable list -R acme/website
```

There is no `variable delete` command; delete variables in the web UI or with the API.

### Variables with the API

The API has GitHub's endpoints (`POST` to create, `PATCH` to update) plus a Diffinery `PUT` that creates or replaces in one call:

| Request | Needs | Does |
|---|---|---|
| `GET /api/v3/repos/{owner}/{repo}/actions/variables` | write role | Returns `{"total_count": 1, "variables": [{"name": "...", "value": "..."}]}`. Takes `per_page` (default 30, at most 100) and `page`. |
| `GET /api/v3/repos/{owner}/{repo}/actions/variables/{name}` | write role | Returns `{"name", "value", "created_at": null, "updated_at": null}`, or `404 Not Found` |
| `POST /api/v3/repos/{owner}/{repo}/actions/variables` with `{"name": "...", "value": "..."}` | admin role, people only | Creates a variable (201). An existing name fails with `409 Already exists - Variable already exists`; a missing field with `422 name and value are required`. |
| `PATCH /api/v3/repos/{owner}/{repo}/actions/variables/{name}` with `{"value": "..."}` and optionally a new `"name"` | admin role, people only | Updates or renames a variable (204), or `404 Not Found`. Renaming onto a name that already exists fails with `409 Already exists - Variable already exists`. A body with only `name` keeps the value. |
| `PUT /api/v3/repos/{owner}/{repo}/actions/variables/{name}` with `{"value": "..."}` | admin role, people only | Creates or replaces a variable (204) |
| `DELETE /api/v3/repos/{owner}/{repo}/actions/variables/{name}` | admin role, people only | Deletes a variable (204) |

Changing variables needs a token with the `admin` scope. An agent's token gets `403 agents cannot manage variables` for every change, whatever its role.

```sh
curl -X POST https://diffinery.com/api/v3/repos/acme/website/actions/variables \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "DEPLOY_REGION", "value": "eu-west-1"}'
```

Variable names are stored in uppercase, and every endpoint, `DELETE` included, matches them without regard to letter case.

## Organization variables

Organization variables are available as `${{ vars.NAME }}` to every workflow in every repository the organization owns, including repositories created later. Use them for settings that many repositories share, such as a registry URL or a cloud region. A repository or environment variable with the same name wins (see [Precedence](#precedence)).

They're managed with the REST API only: there's no web page for them and no CLI command (`diffinery variable` works on one repository). A [GitHub organization import](/docs/migrate-from-github) also adds the GitHub organization's variables that the Diffinery organization doesn't have yet, and leaves existing ones unchanged. Imported variables reach every repository, whatever repository selection they had on GitHub.

### Who can manage organization variables

| Action | Who | Token |
|---|---|---|
| List variables and read their values | Organization owners and admins, and site admins | Any scope |
| Create, update or delete a variable | Organization owners and admins, and site admins (people only) | The `admin` scope, not restricted to repositories |

Other members get `403 organization admins only`, and accounts outside the organization get `404 not found`. Agents get `403 organization admins only` (or `404 not found` when neither the agent nor its owner belongs to the organization), whatever their role: agents can't read, create, change or delete organization variables through these endpoints.

### Organization variables with the API

| Request | Does |
|---|---|
| `GET /api/v3/orgs/{org}/actions/variables` | Returns `{"total_count": 1, "variables": [{"name": "...", "value": "...", "visibility": "all", "created_at": "...", "updated_at": "..."}]}`, sorted by name. The list isn't paged. |
| `GET /api/v3/orgs/{org}/actions/variables/{name}` | Returns one variable in the same shape, or `404 variable not found`. The name is matched case-insensitively. |
| `POST /api/v3/orgs/{org}/actions/variables` with `{"name": "...", "value": "..."}` | Creates a variable, or replaces the value of an existing one. Returns `201` with an empty body. |
| `PATCH /api/v3/orgs/{org}/actions/variables/{name}` with `{"value": "..."}` | Sets the value, creating the variable if it doesn't exist. Returns `204`. |
| `DELETE /api/v3/orgs/{org}/actions/variables/{name}` | Deletes the variable (case-insensitive name). Returns `204`, or `404 variable not found` when there's no such variable. |

```sh
# Create or replace
curl -X POST https://diffinery.com/api/v3/orgs/acme/actions/variables \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "NPM_REGISTRY", "value": "https://registry.npmjs.org"}'

# List with values
curl https://diffinery.com/api/v3/orgs/acme/actions/variables \
  -H "Authorization: Bearer dfy_..."

# Delete
curl -X DELETE https://diffinery.com/api/v3/orgs/acme/actions/variables/NPM_REGISTRY \
  -H "Authorization: Bearer dfy_..."
```

Names must match `^[A-Za-z_][A-Za-z0-9_]*$` and can't start with `GITHUB_`; otherwise the request fails with `422 invalid variable name`. Names are stored in uppercase. The value must be a string of at most 48 KB (49,152 characters); otherwise the request fails with `422 value must be a string of at most 48 KB`. In the responses, `created_at` is the time of the last change, the same as `updated_at`.

Differences from GitHub:

- There is no per-repository selection: `visibility` is always `all`, a `visibility` or `selected_repository_ids` field in the request is ignored, and there are no `/repositories` endpoints for a variable.
- `POST` on an existing name replaces the value instead of failing with `409`, and `PATCH` creates a missing variable instead of failing with `404`.
- `PATCH` can't rename a variable; a `name` in the body is ignored. Delete it and create it under the new name.
- The list isn't paged; `per_page` and `page` are ignored.

### Organization and repository variables with the same name

A repository's variables (the **Variables** section of **Settings → Secrets and variables**, `diffinery variable list`, and the `/api/v3/repos/{owner}/{repo}/actions/variables` endpoints) are only the repository's own, never the organization's. `GET` and `PATCH` on a name only the organization has answer `404 Not Found`, and `POST` creates a repository variable even when the organization has one of that name; in workflows, the repository's value wins. `DELETE` on a repository variable never removes an organization variable.

## Environment secrets and variables

An [environment](/docs/actions/environments) such as `production` can have its own secrets and variables. Only jobs that name the environment with `environment:` receive them:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}   # the production secret
          DEPLOY_URL: ${{ vars.DEPLOY_URL }}                          # the production variable
```

They're managed with the REST API only. Creating and deleting environment secrets needs a person (not an agent) with the admin role and an `admin`-scoped token; listing their names needs the admin role. Environment variables are listed with the write role and changed by a person (not an agent) with the admin role.

```sh
# Environment secret: 201 when new, 204 when replaced
curl -X PUT https://diffinery.com/api/v3/repos/acme/website/environments/production/secrets/CLOUDFLARE_API_TOKEN \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"value": "cf_..."}'

# Environment variable: 201
curl -X POST https://diffinery.com/api/v3/repos/acme/website/environments/production/variables \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "DEPLOY_URL", "value": "https://www.example.com"}'
```

The environment must exist first (`404 environment not found` otherwise); create it with `PUT /api/v3/repos/{owner}/{repo}/environments/{name}`. The full set of endpoints is in [Deployments and environments](/docs/actions/environments#environment-secrets-and-variables).

### Rules for environment secrets

Environment secrets are meant for credentials that only reviewed code should use, so they're handed out more carefully than repository secrets:

- **Branch policy.** A job can only use the environment from a ref its deployment branch policy allows; otherwise the job fails with `<ref> is not allowed to deploy to <env> due to environment protection rules.`
- **Protected branches by default.** Adding the first secret to an environment that has no branch policy sets it to **protected branches only**.
- **Never on pull request refs.** Environment secrets never go to runs on `refs/pull/*` (`pull_request` runs), whatever the policy.
- **Agents only under "protected branches only".** A run started by an agent (for example by its push or workflow dispatch) only gets environment secrets when the environment is set to protected branches only.
- **Agents' tags don't count.** A tag that an agent created or moved never matches an environment's tag patterns.

When a rule withholds the secrets, the job still runs and still gets the environment's variables; the withheld secrets evaluate to empty strings. See [Who receives environment secrets](/docs/actions/environments#who-receives-environment-secrets).

## Using secrets and variables in workflows

```yaml
name: Deploy
on:
  push:
    branches: [main]

env:
  REGION: ${{ vars.DEPLOY_REGION }}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: npx wrangler deploy --env production
```

- Pass a secret to a step through `env` and read it from the environment, rather than writing `${{ secrets.X }}` into the script text.
- A secret or variable that doesn't exist evaluates to an empty string.
- Values are read when each job starts, so changing a secret affects jobs that start afterwards, including later jobs of a run that's in progress.
- A reusable workflow only receives the secrets its caller passes (a mapping or `secrets: inherit`). See [Reusable workflows](/docs/actions/reusable-workflows).
- A job's runner receives only the secrets the job names in its expressions (`secrets.NAME` or `secrets['NAME']`, in any letter case, anywhere in the job or in the workflow's `env`), as on GitHub, plus `ACTIONS_STEP_DEBUG` and `ACTIONS_RUNNER_DEBUG`. Other secrets never reach the runner, so a compromised action or tool in one job can't read them. A job that uses `secrets` as a whole, such as `toJSON(secrets)` or an index computed at run time, gets all of them.

### Precedence

From highest to lowest, for a name that exists in several places:

1. `GITHUB_TOKEN` and `DIFFINERY_TOKEN`: always the job's own token.
2. Environment secrets, in a job that uses the environment.
3. Repository secrets (in a called reusable workflow: the secrets the caller passed).
4. Organization secrets shared with the repository (see [Organization secrets](#organization-secrets)).

For variables, from highest to lowest:

1. Environment variables, in a job that uses the environment.
2. Repository variables.
3. Organization variables (repositories owned by an organization only).

In places evaluated before a job starts, such as `jobs.<id>.if` and `runs-on`, `vars` holds only repository and organization variables; environment variables are added when the job starts. A change to an organization variable reaches the organization's repositories right away, so jobs that start afterwards see the new value. If some repository can't be updated, the others still are and the request fails with `503`; repeat it to finish.

### Which runs receive secrets

Every workflow run in the repository receives its repository and organization secrets, whatever the event (the one exception, pull requests from forks, is below): `push`, `pull_request`, `pull_request_target`, `merge_group`, `workflow_dispatch`, `schedule`, `workflow_run`, `release` and `repository_dispatch`. Environment secrets follow stricter rules (see [Rules for environment secrets](#rules-for-environment-secrets)).

This is a difference from GitHub worth understanding. GitHub withholds secrets from `pull_request` runs of pull requests that come from forks. Diffinery has no forks: every pull request comes from a branch in the same repository, pushed by someone with write access, so `pull_request` runs get the repository's secrets, and they run the workflow files from the pull request's own test merge commit. The exception is a pull request [imported from GitHub](/docs/migrate-from-github) whose head was in a fork (its head shows as `owner:branch`): its runs get no secrets and a read-only token, as on GitHub. `pull_request_target` runs the base branch's workflow on the base commit, also with secrets, so a pull request can't change what it runs.

Runs of code an agent wrote are the other exception. A run whose trigger was an agent, whose branch or tag an agent pushed last, whose pull request an agent opened or pushed to, or (off the default branch) whose code includes a commit an agent pushed that hasn't landed on the default branch yet gets no repository or organization secrets, only its job token. A person pushing on top of an agent's commits, tagging them or dispatching a run on them doesn't change that; see [Runs whose code came from an agent](/docs/actions/workflow-permissions#runs-whose-code-came-from-an-agent). An agent with write access could otherwise push a workflow that sends them anywhere. A repository admin who is a person can allow it under **Settings → Actions** (**Give runs of agent code the repository's and organization's secrets**), or with `PUT /repos/{owner}/{repo}/actions/permissions/workflow` and `"agent_runs_use_secrets": true`. The change is audited. Environment secrets follow the environment's own rules.

This includes the default branch once agents land changes on it. When an agent's pull request lands through [auto-merge](/docs/collaboration/pull-requests#auto-merge), the merge is the agent's push, so the branch was last pushed by an agent: every run on it from then on is agent code until a person pushes or merges there. That covers `push` runs and the `workflow_run` runs that follow them, such as a Deploy workflow that runs after CI. Such a run gets empty strings for repository and organization secrets, and the job log doesn't say they were withheld, so a deploy typically fails on its first missing value (`CLOUDFLARE_ACCOUNT_ID is required`, say). If agents land on your default branch, choose one of these:

- **Keep deploy credentials in an environment** limited to protected branches, add `environment: <name>` to the deploying job, and protect the branch. Runs of agent code receive that environment's secrets on protected branches only, and never on pull request refs, so no other agent run sees them. This is the tighter option. See [Environments](/docs/actions/environments#who-receives-environment-secrets).
- **Turn on Give runs of agent code the repository's and organization's secrets.** Every run of agent code then gets them, branches and pull requests included, so treat write access for an agent as access to those secrets.

In practice: **anyone who can push a branch can run a workflow that uses the repository's secrets**, and so can agents with write access where an admin allows it. Give write access only to people and agents you trust with the repository secrets, and keep production credentials in an [environment](/docs/actions/environments) set to protected branches only (see [Branch protection](/docs/repositories/branch-protection)) rather than in repository secrets. Pull request runs and branches that aren't protected never receive them.

## Masking in logs

The runner replaces every secret value with `***` before log lines leave the runner, so secrets don't appear in job logs, step names, step summaries or failure messages.

- Every secret passed to the job is masked, including `GITHUB_TOKEN`.
- Values shorter than 3 characters aren't masked, because masking them would make logs unreadable. Don't use very short secrets.
- Multi-line secrets are masked line by line as well as whole.
- Masking matches the literal text only. A transformed value (base64-encoded, URL-encoded, split across lines, printed one character at a time) is not masked. Don't print secrets, even in debugging.
- A job output whose value contains a secret is dropped, with the warning `Skip output 'NAME' since it may contain secret.`
- Variables are never masked.

### Masking other values with ::add-mask::

Mask a value that isn't a secret, such as a token you fetch during the job, by printing the `add-mask` workflow command:

```yaml
- name: Get a short-lived token
  run: |
    token=$(curl -fsS -X POST https://auth.example.com/token -d "key=$API_KEY" | jq -r .token)
    echo "::add-mask::$token"
    echo "SESSION_TOKEN=$token" >> "$GITHUB_ENV"
  env:
    API_KEY: ${{ secrets.API_KEY }}
```

From that line on, the value is replaced with `***` in the rest of the job's log. The `add-mask` line itself is never echoed.

### Debug logging

Set a secret or a variable named `ACTIONS_STEP_DEBUG` to `true` to show `::debug::` messages in the log, set `RUNNER_DEBUG=1` for steps and make `runner.debug` `1`. A secret or variable named `ACTIONS_RUNNER_DEBUG` set to `true` also sets `RUNNER_DEBUG=1`, but doesn't change `runner.debug`. Turn them off again when you're done.

## GITHUB_TOKEN and the job token

Every job gets its own token, created when the job starts and revoked when it finishes. It's available as `${{ secrets.GITHUB_TOKEN }}`, `${{ secrets.DIFFINERY_TOKEN }}` and `${{ github.token }}`, and `actions/checkout` uses it by default. It always replaces a repository or organization secret with the same name.

What the token may do follows the job's `permissions:`, as on GitHub:

| Access | Allowed |
|---|---|
| Clone and fetch the repository that runs the workflow (including Git LFS downloads) | With `contents: read` or `write`, or always when the repository is public |
| Push to the repository | With `contents: write`. Branch protection applies, and changes to files under `.github/workflows/` are always refused. |
| Read the repository through the REST API | With the scope each endpoint needs, for example `issues: read` for issues. A public repository can always be read. |
| Write through the REST API (comments, labels, pull requests, releases, statuses, deployments) | With the matching scope at `write`, for example `pull-requests: write` to comment on a pull request |
| Read another repository | Only if that repository is public |
| Write to another repository | No |
| Use the container registry | Decided by the `packages` scope: `write` pushes and pulls, `read` pulls, `none` neither. Pushes reach only packages linked to the workflow's repository, or new packages, which get linked to it. |
| Request an OIDC token | Only with `id-token: write`. See [OpenID Connect (OIDC)](/docs/actions/oidc). |
| Manage secrets, variables, environments or repository settings | No |

A job without any `permissions:` (in the job or the workflow) gets the repository's default: read access to contents and packages for repositories created after this setting was introduced, and write access to everything except `id-token` for older ones. An admin can change it. The full rules, the scope each endpoint needs and the error messages are on [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions).

```yaml
permissions:
  contents: write
  pull-requests: write

jobs:
  bump:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          git config user.name "diffinery-actions[bot]"
          git config user.email "diffinery-actions[bot]@users.noreply.diffinery.com"
          npm version patch --no-git-tag-version
          git switch -c bump-version
          git commit -am "Bump version"
          git push origin bump-version
```

Use a personal access token stored as a secret instead when a workflow needs something the job token can't do, such as changing workflow files, writing to another repository, or pushing to a branch whose protection doesn't let the job push:

```yaml
- uses: actions/checkout@v4
  with:
    token: ${{ secrets.BOT_TOKEN }}
```

Create the token as a person, with the `write` scope and restricted to the repositories it needs. Pushes made this way still follow branch protection. See [Personal access tokens](/docs/accounts/tokens).

## Encryption at rest

Secret values are encrypted before they're stored, with envelope encryption:

- Each repository, each organization and each environment has its own AES-256-GCM key, derived from the instance's master key with HKDF.
- The scope (the repository, the organization, or the repository and environment) is bound to every ciphertext as additional authenticated data, so a stored value copied into another repository or environment can't be decrypted there.
- Values are decrypted only when a job starts, and sent to that job's runner over HTTPS with the rest of the job's definition.
- The API, CLI and web UI only ever return names and update times.

## Agents, secrets and variables

Agents (AI accounts) can't add, change or delete secrets or variables, whatever their role:

- The organization secret endpoints (listing included) return `403 agents cannot manage secrets` for any agent's token.
- Setting and deleting repository secrets (`PUT` and `DELETE /api/v3/repos/{owner}/{repo}/actions/secrets/{name}`) and environment secrets refuse an agent's token: an agent with the admin role gets `403 agents cannot manage secrets`; with the write role, the request already fails with `403 admin access required`.
- Creating, changing and deleting repository variables (`POST`, `PATCH`, `PUT` and `DELETE` on `/api/v3/repos/{owner}/{repo}/actions/variables`) and environment variables refuse an agent's token the same way, with `403 agents cannot manage variables` for an agent with the admin role.
- The organization variable endpoints (`/api/v3/orgs/{org}/actions/variables`, listing included) return `403 organization admins only` for any agent's token, or `404 not found` when neither the agent nor its owner belongs to the organization. A GitHub import started by an agent skips variables, secret names and environments.
- Agents can't create, change or delete environments or their branch policies (`403 only repository admins (people, not agents) can manage environments` for an agent with the admin role).
- Listing repository secret names and environment secret names needs the admin role; listing and reading variables needs the write role, so an agent with write access can read the repository's variable values (organization variables are readable only by organization owners and admins). An agent has the write role unless a person gave it more (its **Maximum role**, or an explicit admin role on the repository).

Agents can still push branches and open pull requests. The workflows that run for them get no repository or organization secrets unless a repository admin allows it with `agent_runs_use_secrets` (see [Which runs receive secrets](#which-runs-receive-secrets)); where it's allowed, treat write access for an agent as access to those secrets. Environment secrets are different: runs whose code came from an agent only get them from environments set to protected branches only, and never on pull request refs. In those runs the job token also acts as an agent, so it can't push to protected or default branches. See [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions#runs-whose-code-came-from-an-agent) and [Agents](/docs/agents/overview).

## Audit log

Changes are recorded in the audit log with the name but never the value:

| Change | Audit action |
|---|---|
| Set or delete a repository secret | `repo.secret.set`, `repo.secret.delete` |
| Create, update, rename or delete a repository variable | `repo.variable.set` (a rename adds `renamed_from` with the old name), `repo.variable.delete` |
| Set or delete an organization secret | `org.secret.set`, `org.secret.delete` |
| Create, update or delete an organization variable | `org.variable_set`, `org.variable_delete`, with the organization as the target and `name` in the details |
| Set or delete an environment secret | `environment.secret.set`, `environment.secret.delete` |
| Create, update, rename or delete an environment variable | `environment.variable.set` (a rename adds `renamed_from`), `environment.variable.delete` |
| Change an environment or its branch policies | `environment.update`, `environment.delete`, `environment.branch_policy.create`, `environment.branch_policy.delete` |

Repository and organization secret changes made with the API or the CLI include `"via": "api"` in the entry's details; changes made on the settings page don't. Organization variable changes made with the API include it too. When a GitHub organization import adds organization variables, each one is recorded as `org.variable_set` by the person who started the import, with the GitHub organization as the target and the import's id, the Diffinery organization (`org`) and `name` in the details. See [Audit log](/docs/security/audit-log).

## Limits

| Limit | Value |
|---|---|
| Name format | `^[A-Za-z_][A-Za-z0-9_]*$`, stored uppercase; repository and environment secrets, and environment and organization variables, can't start with `GITHUB_` |
| Shortest value that is masked | 3 characters |
| Organization variable value | 48 KB (49,152 characters) |
| Number of organization variables | No limit of its own |
| Number and size of secrets | Diffinery doesn't enforce a limit of its own; every secret is decrypted when each job starts (only the ones the job names are sent to its runner), so keep them few and small |

## Troubleshooting

| Problem | Cause and fix |
|---|---|
| `422 invalid secret name` | The name has characters other than letters, digits and `_`, starts with a digit, or (repository secrets) starts with `GITHUB_`. |
| `invalid secret name "...": use letters, digits and _, not starting with a digit` | The CLI checks the name before sending it. |
| `422 value is required (send it over HTTPS; it is encrypted at rest)` | The JSON body has no string `value`. |
| ``422 encrypted_value (sealed box) is not supported yet: send the secret as `value` over HTTPS; it is encrypted at rest`` | The client encrypted the value with a public key, as GitHub requires. Send the plain value as `value`. |
| `secret value is empty` | The CLI got an empty value from `--body` or stdin. |
| A secret is empty in a workflow run, or a deploy fails on a missing value such as `CLOUDFLARE_ACCOUNT_ID is required`, though the secret is set | The run is agent code: an agent triggered it, pushed its branch last (an agent's auto-merge counts), or opened or pushed its pull request. It gets no repository or organization secrets. Move the secrets into an environment limited to protected branches, or have an admin turn on **Give runs of agent code the repository's and organization's secrets**. See [Which runs receive secrets](#which-runs-receive-secrets). |
| `403 agents cannot manage secrets` | Use a person's token. |
| `403 agents cannot manage variables` | Agents can't create, change or delete variables. Use a person's token. |
| `403 admin access required` | The token's owner isn't a repository admin, or the token lacks the `admin` scope. |
| `403 this token needs the write scope` | The token has only the `read` scope and can't change anything. Use an `admin` token. |
| `403 this token needs the admin scope` | Organization secrets need an `admin`-scoped token, even for listing. Creating, changing and deleting organization variables needs one too. |
| `403 this token is limited to repositories and can't change account settings` | Organization secrets, and changes to organization variables, need a token without a repository list. |
| `403 organization admins only` | Only organization owners and admins (people) manage organization secrets and organization variables, and only they can read organization variables. |
| `422 invalid variable name` | The organization variable's name has characters other than letters, digits and `_`, starts with a digit, or starts with `GITHUB_`. |
| `422 value must be a string of at most 48 KB` | The organization variable request has no string `value`, or the value is longer than 49,152 characters. |
| `404 variable not found` | The organization has no variable of that name. |
| `403 only repository admins (people, not agents) can manage environments` | Environments and their branch policies need a person with the admin role. |
| `404 environment not found` | Create the environment with `PUT .../environments/{name}` before adding secrets or variables. |
| An environment secret is empty in the job | The run is on a pull request ref, or an agent started it and the environment isn't set to protected branches only, or the job has no `environment:`. |
| `<ref> is not allowed to deploy to <env> due to environment protection rules.` | The environment's branch policy doesn't allow the ref. See [Deployments and environments](/docs/actions/environments#deployment-branch-policies). |
| A secret is empty in the workflow | Check the name, that it's set on this repository, its organization or the job's environment, and, in a reusable workflow, that the caller passes it. |
| `***` appears in output where you expected text | The text contains a secret's value (or a value shorter than you think matches part of it). Rename or change the secret, or don't print that text. |
| `git push` with `GITHUB_TOKEN` fails with `403` | The job has no `contents: write`. Add it to the job's or the workflow's `permissions:`, or ask an admin to change the repository default. See [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions). |
| `Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: ...)` | The job's `permissions:` don't include the scope that endpoint needs. Add the scope the message names. |
| `409 Already exists - Variable already exists` | A variable with that name already exists in the repository, or (for `POST` on a repository) the organization has a variable with that name. Update it with `PATCH` or `PUT`, use `PUT` to give the repository its own value, or choose another name. |
| A variable is empty in the workflow | Check the name and that it's set on this repository, its organization or the job's environment. Environment variables aren't available in `jobs.<id>.if` or `runs-on`. |
