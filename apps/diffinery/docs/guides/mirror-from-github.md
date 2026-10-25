---
title: Run Diffinery CI while your code stays on GitHub
description: Try Diffinery Actions on your existing workflows without moving: mirror every GitHub push to Diffinery with a GitHub workflow, copy the secrets it needs, and wait for the results.
updated: 2026-10-25
---

You can run your GitHub Actions workflows on Diffinery without moving your team off GitHub. A small GitHub workflow pushes every branch and tag to a Diffinery repository on each push, and Diffinery then runs the same `.github/workflows/` files on each mirrored commit. The same workflow can copy the secrets your workflows need straight from GitHub's secret store, and fail on GitHub when the runs on Diffinery fail. Diffinery itself was developed this way.

## Steps

1. **Create the Diffinery repository**, for example `acme/website`, at `https://diffinery.com/new` or with `diffinery repo create website --org acme`.
2. **Create a Diffinery token** with the `admin` scope, for an account that is an admin of that repository, under **Settings → Access tokens**. If force pushes to protected branches should go through, the protection rules must let admins bypass them.
3. **Add it on GitHub** as a repository secret named `DIFFINERY_TOKEN`.
4. **Add the mirror workflow on GitHub** as `.github/workflows/mirror-to-diffinery.yml`. Copy it from [Keep GitHub as upstream and mirror to Diffinery](/docs/migrate-from-github#keep-github-as-upstream-and-mirror-to-diffinery), and list in its secrets step every secret your workflows use.
5. **Push to GitHub.** The mirror pushes every branch and tag to Diffinery, and Diffinery starts your workflows on the mirrored commit. Watch them on the repository's **Actions** tab, or with `diffinery run list -R acme/website`.
6. **Optionally, wait for the results on GitHub.** Add the [Wait for Actions on Diffinery](/docs/migrate-from-github#wait-for-diffinerys-runs) step, which polls Diffinery's runs for the pushed commit and fails the GitHub job if any of them fail.

## How the mirror behaves

- **GitHub wins.** Every GitHub branch is pushed to the branch of the same name with a leading `+`, so changes made directly on Diffinery to mirrored branches are overwritten.
- **Deleted branches stay.** Branches deleted on GitHub aren't deleted on Diffinery; delete them there by hand.
- **Secrets go straight across.** The secrets step reads each value from GitHub's secret store inside your own workflow and sends it to Diffinery over HTTPS, without printing it. Variables can be copied the same way.
- **The mirror doesn't run on Diffinery.** The workflow has an `if: ${{ github.server_url == 'https://github.com' }}` guard, because Diffinery also runs the mirrored copy of the file.
- **Push protection still applies.** If a mirrored push is blocked because it contains something that looks like a credential, a repository admin can let it through with `-o allow-secrets=<reason>` on the `git push` line.

## Before you rely on the results

- **Check what differs.** Windows, macOS and Arm jobs need a self-hosted runner on Diffinery, the job token is read-only by default, and a few features aren't supported. See [Move your GitHub Actions workflows to Diffinery](/docs/guides/move-github-actions-workflows) and [Compatibility with GitHub Actions](/docs/actions/compatibility).
- **Keep Diffinery-only workflows apart.** Put workflows that should run only on Diffinery in `.diffinery/workflows/`, so GitHub doesn't run them, or guard a step with `if: github.server_url == 'https://diffinery.com'`. See [Where workflow files live](/docs/actions/overview#where-workflow-files-live).
- **Compare speed with your own jobs.** Every hosted job's log ends with what it used and names the runner size it got. See [Make your CI faster on Diffinery](/docs/guides/faster-ci).

## When you're ready to move

Import the repository with its issues, pull requests, reviews and releases (**Settings → Imports → Import from GitHub**, or `diffinery migrate github`), set its secrets, update everyone's remotes, then archive the GitHub repository or remove the mirror workflow. See [Migrate from GitHub](/docs/migrate-from-github).

## Frequently asked questions

### Can I use Diffinery Actions without moving my repository off GitHub?

Yes. Mirror every push from GitHub to a Diffinery repository with a GitHub workflow; Diffinery then runs your `.github/workflows/` files on each mirrored commit. People keep pushing and reviewing on GitHub.

### Do I have to re-enter my secrets on Diffinery to mirror?

No. The mirror workflow can copy the secrets you list from GitHub's secret store to Diffinery on each run, inside your own workflow, without printing them. You can also set them on Diffinery by hand.
