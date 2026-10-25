---
title: Deploy to Cloudflare Workers
description: Deploy a Cloudflare Worker from Diffinery on every push to main, with a Preview per pull request, or let Workers Builds build it through a Cloudflare Artifacts mirror.
---

Cloudflare's own build service, Workers Builds, connects to GitHub, GitLab, Cursor Origin and Cloudflare Artifacts repositories (as of October 2026), so a Diffinery repository doesn't show up under **Connect to a repository** in the Cloudflare dashboard yet. You don't need it there to deploy automatically. This page shows two ways that work today:

| | [Deploy with Diffinery Actions](#deploy-with-diffinery-actions) (recommended) | [Mirror to Cloudflare Artifacts](#mirror-to-cloudflare-artifacts-for-workers-builds) |
|---|---|---|
| Who builds | A Diffinery Actions job runs `wrangler deploy` | Workers Builds, after Diffinery pushes a copy of the branch to Artifacts |
| Result on the pull request | The job is a check on the pull request, and a comment links the Preview | Nothing; build results are in the Cloudflare dashboard |
| Previews | One per pull request, removed when it closes | One per branch |
| Production branch | Any branch you choose | `main` only |
| Cloudflare plan | Any | Workers Paid (Artifacts isn't on the Free plan) |
| Cloudflare credentials in Diffinery | An API token that can edit Workers | An API token that can edit Artifacts |

Both use the same Wrangler configuration as any other Worker, so a project that already deploys from GitHub Actions or Workers Builds moves over without changes to its code.

## Deploy with Diffinery Actions

A workflow deploys `main` to production and gives each pull request its own [Worker Preview](https://developers.cloudflare.com/workers/previews/), with the Preview's address commented on the pull request. This is how Diffinery deploys itself.

### 1. Create a Cloudflare API token

1. In the Cloudflare dashboard, open **Manage account → Account API tokens** and select **Create Token**.
2. Use the **Edit Cloudflare Workers** template.
3. Under **Account Resources**, include only the account the Worker deploys to. Under **Zone Resources**, include only the zones whose routes the Worker uses (or none, for a `workers.dev` Worker).
4. Create the token and copy it. Copy your **Account ID** too (it's on the account's home page, and in `npx wrangler whoami`).

If the Worker uses other resources, such as D1, R2 or Queues, add **Edit** for each of them to the token.

### 2. Store the token in Diffinery

Under **Settings → Secrets and variables** of the repository, add two repository secrets:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

Or from a terminal, with the [Diffinery CLI](/docs/actions/secrets-and-variables#secrets-with-the-cli) signed in with the `admin` scope:

```sh
diffinery secret set CLOUDFLARE_API_TOKEN
diffinery secret set CLOUDFLARE_ACCOUNT_ID
```

Pull request runs get repository secrets, because every pull request on Diffinery comes from a branch of the same repository, pushed by someone with write access (see [Secrets and variables](/docs/actions/secrets-and-variables)). That is what lets the preview job below deploy a Preview. If you'd rather keep the production token away from pull request runs, see [Keep the production token in an environment](#keep-the-production-token-in-an-environment).

### 3. Allow Previews in the Wrangler configuration

Worker Previews need Wrangler 4.135.0 or later in the project, and a `previews` block in the Wrangler configuration (it can be empty). Settings in `previews` apply to Previews only, so a Preview can use its own variables and resources:

```sh
npm i -D wrangler@latest
```

```jsonc
// wrangler.jsonc
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "vars": { "ENVIRONMENT": "production" },
  "previews": {
    "vars": { "ENVIRONMENT": "preview" }
  }
}
```

Cloudflare's [Previews configuration](https://developers.cloudflare.com/workers/previews/configuration/) explains which settings belong in `previews`. Without Previews, leave out the `preview` and `cleanup` jobs below and keep `deploy`.

### 4. Add the workflow

Commit this as `.github/workflows/cloudflare.yml` (Diffinery reads workflows from `.github/workflows/` and `.diffinery/workflows/`). Replace `npm ci` with your project's install and build commands:

```yaml
name: Cloudflare

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, closed]

permissions:
  contents: read

jobs:
  deploy:
    name: Deploy to production
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    concurrency:
      group: cloudflare-production
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

  preview:
    name: Preview
    if: github.event_name == 'pull_request' && github.event.action != 'closed'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      pull-requests: write
    concurrency:
      group: cloudflare-preview-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Create or update the Preview
        id: preview
        run: |
          set -euo pipefail
          out=$(npx wrangler preview --name "pr-$PR" --json)
          url=$(printf '%s' "$out" | jq -er '.preview.urls[0]')
          echo "url=$url" >> "$GITHUB_OUTPUT"
          echo "Preview: $url" >> "$GITHUB_STEP_SUMMARY"
        env:
          PR: ${{ github.event.pull_request.number }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - name: Link the Preview on the pull request
        run: |
          set -euo pipefail
          api="$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/issues"
          auth=(-H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json")
          marker='<!-- cloudflare-preview -->'
          text=$(printf '%s\n**Cloudflare Preview:** %s (commit %s)' "$marker" "$URL" "${SHA:0:7}")
          body=$(jq -n --arg b "$text" '{body: $b}')
          # The job's own earlier comment, if any: one comment per pull request, kept up to date.
          id=$(curl -fsS "${auth[@]}" "$api/$PR/comments?per_page=100" \
            | jq -r --arg m "$marker" '[.[] | select(.user.login == "diffinery-actions[bot]" and (.body | startswith($m)))][0].id // empty')
          if [ -n "$id" ]; then
            curl -fsS -X PATCH "${auth[@]}" "$api/comments/$id" -d "$body" > /dev/null
          else
            curl -fsS -X POST "${auth[@]}" "$api/$PR/comments" -d "$body" > /dev/null
          fi
        env:
          PR: ${{ github.event.pull_request.number }}
          URL: ${{ steps.preview.outputs.url }}
          SHA: ${{ github.event.pull_request.head.sha }}
          TOKEN: ${{ secrets.GITHUB_TOKEN }}

  cleanup:
    name: Delete the Preview
    if: github.event_name == 'pull_request' && github.event.action == 'closed'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx wrangler preview delete --name "pr-$PR" --skip-confirmation
        env:
          PR: ${{ github.event.pull_request.number }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

What happens:

- **Pushes to `main`** run **Deploy to production**, which runs `wrangler deploy`. Deploys take turns in the `cloudflare-production` group, and when several are waiting only the newest runs, so two merges in a row never deploy out of order.
- **Opening or updating a pull request** runs **Preview**. It creates or updates the Preview named `pr-<number>` and keeps one comment on the pull request up to date with the Preview's address. The job is a check on the pull request, so a failed build shows there, and you can make it a [required check](/docs/repositories/branch-protection) for merging. A newer push cancels a Preview build that's still running for the same pull request.
- **Closing or merging a pull request** runs **Delete the Preview**, which removes it from Cloudflare.

The comment step uses the REST API directly, because `gh` on a runner only reads `GH_TOKEN` for github.com. To use `gh pr comment` instead, set `GH_HOST: diffinery.com` and `GH_ENTERPRISE_TOKEN: ${{ secrets.GITHUB_TOKEN }}` on the step.

`cloudflare/wrangler-action` works too, if you prefer it to running `npx wrangler` yourself: actions from GitHub run on Diffinery's runners (see [Compatibility](/docs/actions/compatibility)).

### Keep the production token in an environment

Repository secrets go to every run, including pull request runs, so anyone who can push a branch can run code that reads them. To keep the production deploy token for reviewed code only, put it in an [environment](/docs/actions/environments) instead:

1. Create an environment named `production` and add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to it as environment secrets, with the REST API as shown in [Environment secrets and variables](/docs/actions/secrets-and-variables#environment-secrets-and-variables). Adding the first secret limits the environment to protected branches, so protect `main` if it isn't already. Optionally add required reviewers under **Settings → Environments**, so each deploy waits for an approval.
2. Add `environment: production` to the `deploy` job.
3. For Previews, create a second API token and store it as the repository secret `CLOUDFLARE_PREVIEW_API_TOKEN`; use it in the `preview` and `cleanup` jobs.

Environment secrets never go to pull request runs, so the production token stays with jobs on protected branches. A Workers API token can't be limited to Previews, so this keeps the two tokens apart and lets you revoke the preview token on its own; it doesn't stop the preview token from deploying.

## Mirror to Cloudflare Artifacts for Workers Builds

If you'd rather have Workers Builds run your builds, with its build history and logs in the Cloudflare dashboard, keep developing on Diffinery and let a workflow push each branch to a [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) repository. Workers Builds can connect to Artifacts, so it builds and deploys `main` and creates Previews for other branches.

Know the limits first: Artifacts needs the Workers Paid plan and bills per operation and per GB stored (the first 10,000 operations and 1 GB each month are included); a repository holds at most 1 GB; only `main` can be the production branch; and Workers Builds doesn't report back to Diffinery, so build results stay in the Cloudflare dashboard.

### 1. Create the Artifacts repository

With Wrangler signed in to your Cloudflare account:

```sh
npx wrangler artifacts repos create my-worker --namespace default --default-branch main
```

### 2. Store a token that can push to it

Create an account API token with the **Artifacts Edit** permission, and add it to the Diffinery repository as the secret `CLOUDFLARE_ARTIFACTS_TOKEN`, with your account ID as `CLOUDFLARE_ACCOUNT_ID`. The workflow below uses it to mint a short-lived push token for the one repository on each run, so no long-lived git password is stored anywhere.

### 3. Add the mirror workflow

```yaml
name: Mirror to Cloudflare Artifacts

on:
  push:
    branches: ['**']

permissions:
  contents: read

concurrency:
  group: artifacts-mirror-${{ github.ref }}
  cancel-in-progress: false

jobs:
  mirror:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      NAMESPACE: default
      REPO: my-worker
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Push to Artifacts
        run: |
          set -euo pipefail
          base="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/artifacts/namespaces/$NAMESPACE"
          auth=(-H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json")
          remote=$(curl -fsS "${auth[@]}" "$base/repos/$REPO" | jq -er .result.remote)
          token=$(curl -fsS -X POST "${auth[@]}" "$base/tokens" \
            -d "$(jq -n --arg r "$REPO" '{repo: $r, scope: "write", ttl: 600}')" | jq -er .result.plaintext)
          echo "::add-mask::$token"
          git -c http.extraHeader="Authorization: Bearer $token" push --force "$remote" "HEAD:refs/heads/$GITHUB_REF_NAME"
        env:
          CF_TOKEN: ${{ secrets.CLOUDFLARE_ARTIFACTS_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Each push to a branch pushes that branch to Artifacts. Pushes to the same branch take turns, and when several are waiting only the newest runs, so Artifacts always ends up with the branch's latest commit. Deleting a branch on Diffinery doesn't delete it in Artifacts (workflows don't run for deletions); remove old branches there with `git push <remote> --delete <branch>` and a token from `npx wrangler artifacts repos issue-token`. The tokens the workflow mints last 10 minutes. Change `NAMESPACE` and `REPO` to match step 1.

### 4. Connect Workers Builds

In the Cloudflare dashboard, open **Workers & Pages**, select your Worker (or **Create application → Continue with Artifacts** for a new one), then **Settings → Builds → Connect**, and choose the Artifacts namespace and repository. To get Previews for branches, turn on **Builds for Preview branches** under **Settings → Builds**. Cloudflare's [Artifacts integration guide](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/artifacts-integration/) has the details.

From then on, merging to `main` on Diffinery deploys the Worker through Workers Builds.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Authentication error [code: 10000]` from Wrangler | The API token is missing a permission, or doesn't include the Worker's account or zone. Edit the token in the Cloudflare dashboard. |
| `wrangler preview` is an unknown command | The project's Wrangler is older than 4.135.0. Run `npm i -D wrangler@latest` and commit the lockfile. |
| The preview job deploys, but no comment appears | The job needs `pull-requests: write` in its `permissions:`. |
| Secrets are empty in the preview job | The secrets are environment secrets, which pull request runs never receive. Store the preview token as a repository secret. |
| The mirror push fails with `403` | The Artifacts token is missing **Artifacts Edit**, or `NAMESPACE` and `REPO` don't name an existing repository. |

## Related

- [Deployments and environments](/docs/actions/environments): approvals, branch rules and deployment history for production.
- [Secrets and variables](/docs/actions/secrets-and-variables): which runs receive which secrets.
- [Workflow permissions](/docs/actions/workflow-permissions): what `GITHUB_TOKEN` may do.
- Cloudflare's [GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) and [Previews examples](https://developers.cloudflare.com/workers/previews/examples/), which the workflow above follows.
