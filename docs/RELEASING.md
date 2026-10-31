# Releasing Diffinery

This is the playbook for cutting a Diffinery release. Follow it step by step, whether you
are a maintainer or an AI agent preparing the release for one.

Diffinery is deployed continuously: every merge to `main` that passes CI deploys
diffinery.com. A release doesn't deploy anything. It names a point on `main` that
self-hosters can deploy, with a changelog, a tag and a GitHub release.

## What a release contains

- A `## [X.Y.Z] - YYYY-MM-DD` section in [CHANGELOG.md](../CHANGELOG.md).
- The new version in every file listed in [Bump the version](#4-bump-the-version).
- Docs, README, ROADMAP and CITATION brought up to date with what shipped.
- A tag `vX.Y.Z` on `main` and a GitHub release at
  https://github.com/codician-team/diffinery/releases with the release notes.

The editor extensions (`apps/vscode`, `apps/jetbrains`) and the plugins (`plugins/`) have
versions of their own. They are released when they change, not with every Diffinery
release. See [Extensions and plugins](#extensions-and-plugins).

## Who does what

- **An agent or a contributor** prepares the release pull request: steps 1 to 7.
- **A maintainer** (write access on `codician-team/diffinery`) merges it and publishes the
  tag and the GitHub release: steps 8 and 9.

Agents: never create a tag or a GitHub release, and never push to `main`, without a
maintainer's go-ahead in the conversation for that release.

## Choosing the version

Diffinery is at `0.y.z`, so:

- **Minor** (`0.2.0` → `0.3.0`): new features, new settings, new D1 migrations, or anything a
  self-hoster must act on (a new secret, a renamed setting, a changed default).
- **Patch** (`0.2.0` → `0.2.1`): fixes and docs only, no migrations and no new settings.

Once Diffinery reaches `1.0.0`, a change that breaks an existing instance, API client or
workflow needs a major version.

## 1. Find what changed

Start from an up-to-date `main`:

```sh
git fetch origin --tags
PREV=$(git describe --tags --abbrev=0 origin/main)   # the last release, such as v0.1.0
git log --no-merges --format='%h %s' "$PREV"..origin/main
```

Then look for what self-hosters must know:

```sh
git diff --name-only "$PREV"..origin/main -- apps/diffinery/migrations   # new D1 migrations
git diff "$PREV"..origin/main -- apps/diffinery/src/env.ts apps/diffinery/wrangler.jsonc   # new settings and bindings
git diff --stat "$PREV"..origin/main -- apps/diffinery/docs                # docs that already changed
```

Leave out changes that only touch tests, CI of this repository or internal scripts, unless
they change how people deploy or contribute.

## 2. Branch

```sh
git switch -c release/vX.Y.Z origin/main
```

## 3. Write the changelog

In [CHANGELOG.md](../CHANGELOG.md):

1. Add `## [X.Y.Z] - YYYY-MM-DD` (today's date, UTC) below `## [Unreleased]`, and move
   anything under `[Unreleased]` into it. Keep `## [Unreleased]` empty above it.
2. Open with one or two sentences on what the release is about.
3. Group entries under the headings the earlier releases use: **Actions (CI/CD)**, **Git
   hosting and collaboration**, **AI agents and integrations**, **Self-hosting**, and
   **Changed**, **Removed** or **Security** when there are such entries. Leave out empty
   groups.
4. Write each entry for the person who uses or runs Diffinery: what they can do now, with
   the exact names of buttons, settings, endpoints and flags. One line per change, not one
   per commit.
5. Under **Self-hosting**, name every new setting, secret and binding, and say if the
   update needs anything beyond running Deploy or `scripts/setup.sh`.
6. Update the links at the bottom:

   ```
   [Unreleased]: https://github.com/codician-team/diffinery/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/codician-team/diffinery/compare/vPREV...vX.Y.Z
   ```

## 4. Bump the version

The Worker, the CLI, the runner and the packages share one version. Change it in:

| File | What |
| --- | --- |
| `apps/diffinery/package.json` | `"version"` |
| `apps/cli/package.json` | `"version"` |
| `apps/cli/src/version.ts` | `VERSION`, which `diffinery --version` prints and the docs show |
| `containers/runner/package.json` | `"version"` |
| `packages/git-core/package.json`, `packages/shared/package.json`, `packages/workflow-yaml/package.json` | `"version"` |
| `apps/diffinery/src/mcp/server.ts` | `serverInfo.version` of the MCP server |
| `apps/diffinery/docs/agents/mcp.md` | the two `serverInfo` examples |
| `CITATION.cff` | `version` and `date-released` |

Then check that nothing still names the old version, apart from the changelog, tests and
examples:

```sh
git grep -n "OLD.VERSION" -- ':!pnpm-lock.yaml' ':!CHANGELOG.md'
```

## 5. Update the docs and the README

Features ship with their docs (see [AGENTS.md](../AGENTS.md)), so most pages are already
current. Check the rest:

- **Docs** in `apps/diffinery/docs`: every user- or admin-visible change from step 1 has a
  page that describes it. Fix any that doesn't. Differences from GitHub go in
  `actions/compatibility.md`. The version example in `self-hosting/deploy.md` under
  **Updating** names the new tag.
- **README.md**: the sections *Who Diffinery is for*, *Why Diffinery*, *Plugins and
  integrations*, *Features*, *Self-host on your own Cloudflare account*, *How it runs on
  Cloudflare*, *What Diffinery doesn't do (yet)* and *FAQ*. Add what's new, remove gaps that
  are closed, and update numbers such as the count of MCP tools and the `git checkout`
  tag in *Self-host*.
- **ROADMAP.md**: move anything that now works from *Known gaps* to *Works today*.
- **Product pages** in `apps/diffinery/site` (`features.md`, `faq.md`, `compare/*.md`) for
  anything the README changed.
- **CITATION.cff**: the `abstract` if what Diffinery is has changed.

Keep the style: short sentences, exact names, no marketing words.

## 6. Check

```sh
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

All four must pass. Never skip or disable a test to get green.

## 7. Open the pull request

Commit everything in one commit and open one pull request against `main` on GitHub:

- Title: `Release vX.Y.Z`.
- Description: the changelog section, the version, and the person you work for.

## 8. Merge and wait for the deploy

A maintainer squash-merges the pull request. Wait until **CI** and **Deploy** on `main`
are green for the merge commit, so the tag points at a commit that is live on
diffinery.com.

```sh
git fetch origin
SHA=$(git rev-parse origin/main)   # the merge commit of the release pull request
gh run list -R codician-team/diffinery --commit "$SHA"
```

## 9. Tag and publish the GitHub release

Write the release notes to a file, `notes.md`, outside the repository. Use the shape of
the earlier releases:

1. One paragraph: what Diffinery is, and what this release is about.
2. The links line:
   `**[Deploy your own](https://diffinery.com/docs/self-hosting/deploy)** · **[Documentation](https://diffinery.com/docs)** · **[Changelog](https://github.com/codician-team/diffinery/blob/main/CHANGELOG.md)**`
3. `## Highlights`: three to seven bullets, each a bold sentence and one or two sentences
   more, with a link to the docs page.
4. `## Updating`: for existing instances, `git fetch --tags && git checkout vX.Y.Z`, then
   `scripts/setup.sh` or Deploy, plus anything the changelog's **Self-hosting** section
   asks for (new secrets, settings, migrations).
5. `## Known gaps`: copied from ROADMAP.md's *Known gaps*, shortened.
6. The full list: a link to the version's section of CHANGELOG.md, such as
   `https://github.com/codician-team/diffinery/blob/main/CHANGELOG.md#020---2026-10-31` for
   `## [0.2.0] - 2026-10-31`.

Then create the tag and the release in one step:

```sh
gh release create vX.Y.Z -R codician-team/diffinery --target "$SHA" \
  --title "Diffinery vX.Y.Z: <what the release is about>" --notes-file notes.md --latest
```

Check that:

- https://github.com/codician-team/diffinery/releases/tag/vX.Y.Z shows the notes, marked
  **Latest**.
- `git ls-remote --tags origin vX.Y.Z` prints `$SHA`.
- The compare link in CHANGELOG.md opens.

If a mistake slips into the notes, edit them with `gh release edit vX.Y.Z --notes-file
notes.md`. Never move a tag that has been published: fix forward with a patch release.

## Extensions and plugins

Check whether these changed since the last release:

```sh
git diff --stat "$PREV"..origin/main -- apps/vscode apps/jetbrains plugins
```

- **VS Code, Cursor, Windsurf extension**: bump `version` in `apps/vscode/package.json`,
  add an entry to `apps/vscode/CHANGELOG.md`, and publish to the marketplaces as described
  in [apps/vscode/PUBLISHING.md](../apps/vscode/PUBLISHING.md).
- **JetBrains plugin**: bump `pluginVersion` in `apps/jetbrains/gradle.properties` and add
  an entry to `apps/jetbrains/CHANGELOG.md`.
- **Claude Code and Codex plugins**: bump the plugin's version in its manifests and in both
  marketplace files, pack it with `python3 scripts/pack-plugins.py <name>`, and replace its
  zip in `apps/diffinery/claude-plugins`, as described in
  [apps/diffinery/claude-plugins/README.md](../apps/diffinery/claude-plugins/README.md).

Their changes can go in the release pull request or in one of their own before it. Mention
them in the release notes when people should update.
