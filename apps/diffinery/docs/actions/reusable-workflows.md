---
title: Reusable workflows
description: Call one workflow from another with jobs.<id>.uses, pass inputs and secrets, read outputs, and share workflows across repositories.
---

A reusable workflow is a workflow file with an `on: workflow_call` trigger that other workflows call as a job, with `jobs.<id>.uses`. Use one to keep a build, test or deploy pipeline in one place and call it from many workflows or repositories. Diffinery implements GitHub's syntax and behaviour; the differences are listed in [Differences from GitHub](#differences-from-github).

## A minimal example

The called workflow declares its inputs, secrets and outputs under `on.workflow_call`:

```yaml
# .github/workflows/build.yml
name: Build
on:
  workflow_call:
    inputs:
      node-version:
        type: string
        default: "22"
      run-e2e:
        type: boolean
        default: false
    secrets:
      NPM_TOKEN:
        required: true
    outputs:
      version:
        description: The version that was built
        value: ${{ jobs.build.outputs.version }}

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.meta.outputs.version }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ inputs.node-version }}
      - run: npm ci
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - id: meta
        run: echo "version=$(node -p 'require(\"./package.json\").version')" >> "$GITHUB_OUTPUT"
      - if: ${{ inputs.run-e2e }}
        run: npm run test:e2e
```

The caller uses it as a job:

```yaml
# .github/workflows/ci.yml
name: CI
on: push

jobs:
  build:
    uses: ./.github/workflows/build.yml
    with:
      run-e2e: true
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}

  report:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo "Built version ${{ needs.build.outputs.version }}"
```

## Calling a workflow

A calling job has `uses` instead of `runs-on` and `steps`. It accepts these keys:

| Key | Description |
|---|---|
| `uses` | The workflow to call (required). See the formats below. |
| `with` | Values for the called workflow's inputs. |
| `secrets` | A mapping of secrets, or `inherit`. |
| `needs` | Jobs to wait for, as for any job. |
| `if` | Skip the call (and every job inside it) when false. |
| `name` | Display name, used as the prefix of the jobs inside the call. |
| `strategy` | Accepted, but a `matrix` isn't supported yet (see [Matrix on the calling job](#matrix-on-the-calling-job)). |
| `permissions` | The most the jobs inside the call may have. They inherit these permissions, and anything the called workflow declares is lowered to them. See [Permissions in called workflows](#permissions-in-called-workflows). |
| `concurrency` | Accepted but has no effect on a calling job. Jobs inside the called workflow can use their own job-level `concurrency`. |

Any other key produces a warning (`unknown reusable-workflow job key '...'`) and is ignored. That includes `environment`: as on GitHub, a calling job can't use an environment, so put `environment:` on the jobs inside the called workflow (see [Environments in called workflows](#environments-in-called-workflows)). `steps` or `runs-on` on a calling job is an error.

### Local workflows

```yaml
uses: ./.github/workflows/build.yml
```

The path starts with `./`, is relative to the repository root, names a file in `.github/workflows/` or `.diffinery/workflows/` and ends in `.yml` or `.yaml`. The file is read from the **same commit** as the calling workflow, so a branch or pull request can change both together. Workflows under `.diffinery/workflows/` can be called the same way (`./.diffinery/workflows/build.yml`).

### Workflows in other repositories

```yaml
uses: acme/shared-workflows/.github/workflows/deploy.yml@v2
```

The format is `<owner>/<repo>/<path>@<ref>`, where `<ref>` is a branch, a tag or a commit SHA, and the repository is on the same Diffinery instance (here, diffinery.com). A workflow on github.com can't be called; copy it into a Diffinery repository first.

Which repositories you can call:

| Called repository | Can be called from |
|---|---|
| Public | Any repository on Diffinery |
| Private | Only repositories with the **same owner** (the same user or organization) |

Access is decided by the two repositories' owners, not by who pushed the commit. A call that isn't allowed fails with `repository acme/shared-workflows not found, or its workflows are not shared with acme/website`.

Inside a workflow called from another repository, a local `./` reference resolves in that other repository, at the commit the called workflow came from.

A branch or tag `<ref>` is resolved once, when the run is planned: every job of the run, including one that waits for an environment's approval, uses the called workflow from that commit, even if the branch moves during the run.

## Inputs

Declare inputs under `on.workflow_call.inputs`. Each input must have a `type`:

| Key | Description |
|---|---|
| `type` | `string`, `boolean` or `number` (required). |
| `required` | `true` to make the call fail when the input is missing or empty. |
| `default` | Value used when the caller doesn't pass one. Expressions are allowed. |
| `description` | Free text. |

The caller passes values with `with`. Rules:

- Every key in `with` must be a declared input. An unknown key fails the run with `jobs.<id>.with.<key>: <uses> has no input named '<key>'`.
- `with` values can use expressions with the `github`, `needs` (the calling job's `needs`), `inputs` (when the caller is itself inside a reusable workflow) and `vars` contexts.
- Values are converted to the declared type: a `boolean` input is true for `true` or `"true"`; a `number` input goes through `Number()`.
- A missing optional input with no default is `""`, `false` or `0` depending on its type.
- A missing required input fails the jobs inside the call with `jobs.<id>: input '<name>' is required by <uses>`.

Inside the called workflow, read inputs with `${{ inputs.<name> }}`.

## Secrets

The called workflow only sees the secrets the caller passes, plus `GITHUB_TOKEN`, which is always the job's own token, plus, in a job with `environment:`, that environment's secrets (see [Environments in called workflows](#environments-in-called-workflows)).

Pass specific secrets with a mapping. Each value is an expression evaluated against the caller's secrets:

```yaml
secrets:
  DEPLOY_KEY: ${{ secrets.PROD_DEPLOY_KEY }}
  NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Or pass everything the caller has with `inherit`:

```yaml
secrets: inherit
```

At the top level, "everything the caller has" is the calling repository's secrets plus its organization's secrets. In a nested call, it's whatever the enclosing call received.

Declare the secrets a workflow needs under `on.workflow_call.secrets`. A secret declared with `required: true` that the caller doesn't provide fails the jobs inside the call with `jobs.<id>: secret '<NAME>' is required by <uses>`. Secret names are case-insensitive and are stored uppercase.

Secrets for a cross-repository call always come from the **calling** repository and its organization, never from the repository that holds the workflow.

## Outputs

A called workflow exposes results through `on.workflow_call.outputs`. Each output has a `value`, an expression that can read the `jobs` context of the called workflow (`jobs.<job id>.outputs.<name>` and `jobs.<job id>.result`) and its `inputs`:

```yaml
on:
  workflow_call:
    outputs:
      image:
        value: ${{ jobs.publish.outputs.image }}
```

The caller reads it as `${{ needs.<calling job id>.outputs.image }}`. Values are strings; objects are JSON-encoded. Only declared outputs are visible to the caller.

`needs.<calling job id>.result` summarizes the jobs inside the call: `failure` if any failed or timed out, otherwise `cancelled` if any was cancelled, `skipped` if all were skipped, and `success` otherwise.

## Contexts inside a called workflow

| Context | Value inside the called workflow |
|---|---|
| `github` | The caller's run: the same event, `ref`, `sha`, `repository` and actor. `github.job` is the job's own key inside the called workflow. |
| `inputs` | The resolved inputs. |
| `secrets` | The passed secrets and `GITHUB_TOKEN`, plus the environment's secrets in a job with `environment:`. |
| `vars` | The calling repository's variables, plus the environment's variables in a job with `environment:`. |
| `env` | The called workflow's own `env` (workflow and job level). The caller's `env` is not passed. |
| `needs` | Job ids as written inside the called workflow. |

Because `github.repository` is the caller's, `actions/checkout` with no inputs checks out the **calling** repository, as on GitHub. To check out the repository that holds the workflow, pass `repository:`. The job's `GITHUB_TOKEN` can read that repository when it's public; when it's private, also pass a `token:` from a secret.

### Permissions in called workflows

The jobs inside a call get their `GITHUB_TOKEN` permissions like this, as on GitHub:

1. Start from the calling job's effective permissions: its own `permissions:`, or else the calling workflow's, or else the repository default.
2. If the called workflow or the called job declares `permissions:`, use that instead, but lowered scope by scope to what the calling job has. A called workflow can never get more than its caller.
3. If neither declares anything, the called jobs get exactly the calling job's permissions.

```yaml
# .github/workflows/release.yml in acme/website
jobs:
  deploy:
    permissions:
      contents: read
      id-token: write
    uses: ./.github/workflows/deploy.yml
```

Here the jobs in `deploy.yml` can have at most `contents: read` and `id-token: write`. If `deploy.yml` declares `permissions: write-all`, its jobs still get only those two. If it declares `packages: write`, its jobs get no `packages` access, because the calling job has none. This applies to `id-token` for [OIDC](/docs/actions/oidc), to `packages` for the [container registry](/docs/packages/container-registry), and to every other scope. See [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions#reusable-workflows).

## Environments in called workflows

A job inside a called workflow can deploy to an [environment](/docs/actions/environments) with `environment:`, and the environment's name and `url` can use the called workflow's `inputs`:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: ${{ inputs.environment }}
      url: https://${{ inputs.environment }}.example.com
    steps:
      - run: ./deploy.sh
```

How it works:

- The environment belongs to the **calling** repository, the one whose run it is, even when the workflow file lives in another repository. Its branch policy is checked against the caller's ref.
- The job gets the environment's secrets and variables without the caller passing them in `secrets:`, as on GitHub. An environment secret replaces a passed secret with the same name.
- A secret declared with `required: true` under `on.workflow_call.secrets` must still be passed by the caller, even if the environment has it. Don't declare secrets that come from the environment.
- The job records a deployment like any other job with `environment:`, and the usual rules for who receives environment secrets apply (pull request refs never do; runs whose code came from an agent only from environments set to protected branches only).

## How calls appear in runs and checks

The called workflow's jobs become jobs of the caller's run. A calling job `build` that calls a workflow with jobs `compile` and `test` produces the jobs **build / compile** and **build / test** (the calling job's `name`, if it has one, replaces `build`). Checks on the commit are named `<workflow name> / <calling job> / <job>`.

Ordering follows GitHub:

- Jobs inside the call that have no `needs` wait for the calling job's `needs`.
- A job that `needs` the calling job waits for every job inside the call.
- If the calling job's `if` is false, or (with the default `if`) any job it depends on, directly or through other jobs, failed or was skipped, every job inside the call is reported as skipped.

## Nesting

A called workflow can itself call reusable workflows, up to **four levels** below the top-level workflow, as on GitHub. A fifth level fails the run with:

```text
jobs.a/b/c/d/e: reusable workflows can be nested at most 4 levels deep
```

A run can call at most **20** reusable workflows in total (counting every call at every level); more fails with `a run can call at most 20 reusable workflows`.

## Matrix on the calling job

A `strategy.matrix` on a job that calls a reusable workflow isn't supported yet. The run fails with:

```text
jobs.deploy: a matrix on a job that calls a reusable workflow is not supported yet
```

Put the matrix on the jobs inside the called workflow instead, passing the list as an input:

```yaml
# caller
jobs:
  test:
    uses: ./.github/workflows/test.yml
    with:
      versions: '["20", "22"]'

# .github/workflows/test.yml
on:
  workflow_call:
    inputs:
      versions:
        type: string
        required: true
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: ${{ fromJSON(inputs.versions) }}
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: node --version
```

Or write one calling job per value.

## Example: a shared deploy pipeline

An organization keeps its deploy workflow in `acme/shared-workflows` (private) and calls it from `acme/website` (same owner, so allowed):

```yaml
# acme/shared-workflows: .github/workflows/deploy.yml
name: Deploy
on:
  workflow_call:
    inputs:
      environment:
        type: string
        required: true
      dry-run:
        type: boolean
        default: false
    secrets:
      CLOUDFLARE_API_TOKEN:
        required: true
    outputs:
      url:
        value: ${{ jobs.deploy.outputs.url }}

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment }}   # acme/website's staging or production environment
    outputs:
      url: ${{ steps.deploy.outputs.url }}
    steps:
      - uses: actions/checkout@v4          # checks out acme/website, the caller
      - run: npm ci && npm run build
      - id: deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: |
          if [ "${{ inputs.dry-run }}" = "true" ]; then
            npx wrangler deploy --dry-run
          else
            npx wrangler deploy --env "${{ inputs.environment }}"
          fi
          echo "url=https://${{ inputs.environment }}.example.com" >> "$GITHUB_OUTPUT"
```

```yaml
# acme/website: .github/workflows/release.yml
name: Release
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test

  staging:
    needs: test
    uses: acme/shared-workflows/.github/workflows/deploy.yml@v2
    with:
      environment: staging
    secrets: inherit

  production:
    needs: staging
    uses: acme/shared-workflows/.github/workflows/deploy.yml@v2
    with:
      environment: production
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}

  announce:
    needs: production
    runs-on: ubuntu-latest
    steps:
      - run: echo "Live at ${{ needs.production.outputs.url }}"
```

The `deploy` job uses `acme/website`'s `staging` and `production` environments, so each call is checked against that environment's branch policy and records a deployment there. If those environments have their own `CLOUDFLARE_API_TOKEN` secret, it replaces the one the caller passes.

## Differences from GitHub

| Area | Diffinery |
|---|---|
| Where workflows come from | Only repositories on the same Diffinery instance. |
| Private repositories | Callable only from repositories with the same owner. |
| Matrix on the calling job | Not supported yet. |
| `concurrency` | The top-level workflow's `concurrency` and job-level `concurrency` on the jobs inside a call apply. A called workflow's top-level `concurrency` and a calling job's `concurrency` are ignored. |
| Number of calls per run | At most 20. |
| OIDC `job_workflow_ref` claim | The top-level workflow's reference, not the called workflow's. See [OpenID Connect (OIDC)](/docs/actions/oidc). |
| Branch references | Re-resolved whenever a job of the run is planned or started. |

## Errors

Errors in the **calling workflow's syntax** make the workflow file invalid. On `push`, Diffinery records a failed run titled "Invalid workflow file: ..."; the workflow list in the API reports it as `invalid`.

| Message | Fix |
|---|---|
| `reusable workflow reference '...' must be './path/to/workflow.yml' or 'owner/repo/path/to/workflow.yml@ref'` | Fix the `uses` value. Cross-repository references need `@<ref>`; local ones need `./`. |
| `'./...' must be a file in ./.github/workflows or ./.diffinery/workflows` | Move the called workflow into a workflow directory. Files there count as workflow changes, which agents can't merge on their own and job tokens can't push. |
| `a job that calls a reusable workflow ('uses') cannot have 'steps'` (or `'runs-on'`) | Move the steps into the called workflow. |
| `input '<name>' must declare a 'type'` | Add `type: string`, `boolean` or `number` to the input under `on.workflow_call.inputs`. |
| `input '<name>': invalid type '<t>' (expected one of string, boolean, number)` | `choice` and `environment` exist only for `workflow_dispatch`. |
| `workflow_call output '<name>' must be a mapping with a 'value'` | Give each output a `value:` expression. |

Errors found while **loading the called workflows** fail the run before any job starts. The run shows one failed job, **Set up workflow**, with the message:

| Message | Fix |
|---|---|
| `jobs.<id>.uses: <uses> not found` | The file doesn't exist at that path and ref. |
| `jobs.<id>.uses: unknown ref <ref> in <owner>/<repo>` | The branch, tag or SHA doesn't exist in the called repository. |
| `jobs.<id>.uses: repository <owner>/<repo> not found, or its workflows are not shared with <owner>/<repo>` | The repository doesn't exist, or it's private and has a different owner. |
| `jobs.<id>.uses: <uses> is not a reusable workflow (it has no 'on: workflow_call' trigger)` | Add `workflow_call` to the called workflow's `on`. |
| `jobs.<id>.uses: <uses> is invalid: ...` | The called workflow has a syntax error; the details follow. |
| `jobs.<id>.with.<key>: <uses> has no input named '<key>'` | Remove the key from `with`, or declare the input. |
| `jobs.<id>: a matrix on a job that calls a reusable workflow is not supported yet` | Move the matrix into the called workflow. |
| `jobs.<id>: reusable workflows can be nested at most 4 levels deep` | Flatten the chain of calls. |
| `a run can call at most 20 reusable workflows` | Combine calls. |

Errors in the **values passed** fail the jobs inside the call when they're about to start:

| Message | Fix |
|---|---|
| `jobs.<id>: input '<name>' is required by <uses>` | Pass the input with `with`, or give it a default. |
| `jobs.<id>: secret '<NAME>' is required by <uses>` | Pass the secret in `secrets`, use `secrets: inherit`, or create the secret in the calling repository or its organization. |

For the full workflow syntax, see [Workflow syntax](/docs/actions/workflow-syntax). For expressions, see [Expressions and contexts](/docs/actions/expressions).
