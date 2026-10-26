---
title: Automate versions and releases with release-please
description: Run release-please on Diffinery with the release-please action or its CLI: the workflow, the permissions and setting it needs, CI on release pull requests, and troubleshooting.
updated: 2026-10-26
---

[release-please](https://github.com/googleapis/release-please) reads your Conventional Commits, keeps a release pull request open with the next version and changelog, and creates the tag and release when you merge it. It works on Diffinery as it does on GitHub: the `googleapis/release-please-action@v4` action runs unchanged, and the `release-please` CLI works with Diffinery's API URLs. Diffinery answers the GraphQL queries release-please sends (commit history with each commit's pull request, merged pull requests and releases) and the REST calls it makes (files, git data, pull requests, labels, tags and releases).

## Steps

1. **Keep your release-please files.** `release-please-config.json` and `.release-please-manifest.json` (or the action's `release-type` input) work as they are. An imported repository already has them.
2. **Let workflows open pull requests.** Open the repository's **Settings → Actions** tab, check **Allow GitHub Actions to create and approve pull requests** under **Workflow permissions**, and click **Save**. This needs the admin role. It's off by default, as on GitHub, and without it the action fails with `GitHub Actions is not permitted to create pull requests.` See [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions#creating-and-approving-pull-requests).
3. **Add the workflow.** The same file as on GitHub:

   ```yaml
   # .github/workflows/release-please.yml
   on:
     push:
       branches: [main]

   permissions:
     contents: write       # tags and releases
     pull-requests: write  # the release pull request
     issues: write         # its labels

   jobs:
     release-please:
       runs-on: ubuntu-latest
       outputs:
         release_created: ${{ steps.release.outputs.release_created }}
         tag_name: ${{ steps.release.outputs.tag_name }}
       steps:
         - uses: googleapis/release-please-action@v4
           id: release
           with:
             release-type: node   # or leave it out and keep release-please-config.json
   ```

   The action's `github-api-url`, `github-graphql-url` and `changelog-host` inputs default to `${{ github.api_url }}`, `${{ github.graphql_url }}` and `${{ github.server_url }}`, which point at Diffinery, so you don't set them. Changelog links point at your repository on Diffinery.
4. **Build and ship from the release.** Later jobs read the outputs, as on GitHub, for example to build and upload a mobile app only when a release was created:

   ```yaml
     ship:
       needs: release-please
       if: ${{ needs.release-please.outputs.release_created == 'true' }}
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - run: ./scripts/ship.sh "${{ needs.release-please.outputs.tag_name }}"
   ```

5. **Merge the release pull request** when you want to release. Squash, merge commit and rebase merges all work. The next run of the workflow tags the merge, creates the release and relabels the pull request `autorelease: tagged`.

## CI on the release pull request

As on GitHub, what a job's `GITHUB_TOKEN` does starts no new workflow runs, so a release pull request opened with it gets no `pull_request` runs. If your branch protection requires checks, give the action a token of its own: a [personal or agent token](/docs/accounts/tokens) with the `write` scope, stored as a secret.

```yaml
      - uses: googleapis/release-please-action@v4
        with:
          token: ${{ secrets.RELEASE_PLEASE_TOKEN }}
```

Pull requests and pushes made with that token start workflows like anyone else's. If it's an [agent's](/docs/guides/ai-agent-with-guardrails) token, the agent rules apply: it opens and updates the release pull request, and a person merges it.

## The CLI

Run release-please from a terminal or another CI system with Diffinery's REST and GraphQL URLs. `--graphql-url` is the address without `/graphql` (release-please adds it):

```sh
export DIFFINERY_TOKEN=dfy_...   # a token with the write scope
npx release-please release-pr --repo-url acme/app --token "$DIFFINERY_TOKEN" \
  --api-url https://diffinery.com/api/v3 --graphql-url https://diffinery.com/api
npx release-please github-release --repo-url acme/app --token "$DIFFINERY_TOKEN" \
  --api-url https://diffinery.com/api/v3 --graphql-url https://diffinery.com/api
```

`--target-branch` picks another branch than the default one. For changelog links that point at Diffinery when you use the CLI, add `"changelog-host": "https://diffinery.com"` to `release-please-config.json`; the action sets it for you.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `GitHub Actions is not permitted to create pull requests.` | Check **Allow GitHub Actions to create and approve pull requests** (step 2), or use a token of its own. |
| `Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: ...)` | Add the `permissions:` from step 3 to the workflow or job. |
| `release-please failed: Error updating ref heads/release-please--branches--...` (the API answered ``refusing to allow a GitHub App to create or update workflow `...` without `workflows` permission``) | A workflow file changed on the base branch while the release pull request was open. Rebuilding the release branch on the new base would change workflow files on it, which a job's `GITHUB_TOKEN` may never do on Diffinery. Merge or close the release pull request and delete its branch (the next run opens a fresh one), or give the action a [token of its own](#ci-on-the-release-pull-request). |
| `Could not find commits for branch <name> - it likely does not exist.` | The branch in `target-branch` (or the default branch) doesn't exist, or the token can't read the repository. |
| Changelog links go to github.com | Set `changelog-host` (CLI), or check that the action's `changelog-host` input isn't set to GitHub. |
| `No commits for path: ., skipping` | Nothing since the last release follows Conventional Commits (`feat:`, `fix:`, `feat!:` and so on), so there's nothing to release. |

## Related

- [Releases](/docs/collaboration/releases): tags, drafts, notes and assets.
- [GraphQL API](/docs/reference/graphql-api): the queries Diffinery answers.
- [Move your GitHub Actions workflows to Diffinery](/docs/guides/move-github-actions-workflows).
