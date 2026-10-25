---
title: Releases
description: Publish versioned releases with notes and downloadable files, from the web UI, the REST API, MCP or a workflow, and react to them with webhooks.
---

A release marks a tag as a version of your project and attaches release notes and downloadable files (assets) to it. Use releases to publish builds, changelogs and source archives for each version, and to start deployment workflows when a version is published. Diffinery releases follow GitHub's model and REST API, so GitHub clients and scripts that manage releases work with small or no changes.

## How releases work

- Every release belongs to one tag, `refs/tags/<tag_name>`. If the tag does not exist when you publish, Diffinery creates it at `target_commitish` (a branch, tag or commit SHA; the default branch when omitted). An existing tag is used as it is and never moved.
- A release is either a **draft** or **published**. Drafts are visible only to people and agents with the write role or higher. Readers, anonymous visitors of public repositories and the REST API for read-only callers never see them. Publishing a draft creates its tag.
- A published release can be marked as a **pre-release** (not production ready).
- One published, non-pre-release release is the repository's **latest release**. It appears on the repository home page and at `/releases/latest`.
- Release notes are Markdown. Diffinery can generate them from the pull requests merged since the previous release, grouped by the categories in `.github/release.yml`.
- Assets are files of up to 100 MB each, stored with the release and downloadable by anyone who can see the release. Every published release also offers the source code as zip and tar.gz archives.
- Creating, publishing, editing and deleting a release sends `release` webhook events and starts `on: release` workflows.

Each repository numbers its releases and assets with its own integer ids, starting at 1.

## Who can do what

| Action | Role needed |
|---|---|
| See published releases, their notes and assets; download assets and source archives | read (anyone, for a public repository) |
| See draft releases | write |
| Create, edit, publish and delete releases; save drafts | write |
| Upload, rename and delete assets | write |
| Generate release notes (REST API and MCP) | write |
| React to a release | read (signed in) |

- With a personal access token, the token needs the `write` scope (or `admin`) to create or change releases. A `read` token can list and download.
- A workflow's `GITHUB_TOKEN` (the job token) can create, edit and delete releases and upload assets when the job has `contents: write`, as on GitHub. With only `contents: read` (the default for new repositories) it can read releases, and a write fails with `403` and `Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: contents: write)`. Releases a job token creates or changes don't start `on: release` workflows (see [Workflows triggered by releases](#workflows-triggered-by-releases)).
- On an archived repository, every release change (including assets) fails with `repository is archived (read-only)`.
- Deleting a release never deletes its tag. Moving or deleting an existing tag needs the maintain role.

See [Permissions](/docs/accounts/permissions) for the full role table and [Tokens](/docs/accounts/tokens) for scopes.

## Releases in the web UI

### Find releases

- The repository home page shows a **Releases** section in the sidebar: the number of releases and the latest release with a green **Latest** badge. When there are none it says **No releases published.**, with a **Create a new release** link if you can write.
- `https://diffinery.com/acme/website/releases` lists releases, newest first, ten per page. Each release shows its title (the tag name when it has no title), the badges **Draft**, **Pre-release** and **Latest** where they apply, the tag, who released it and when (**released this**, or **drafted this** for a draft), the notes and the assets. Long notes are shortened in the list; open the release to read them in full.
- `https://diffinery.com/acme/website/releases/tag/v1.2.0` shows one release in full.
- `https://diffinery.com/acme/website/releases/latest` redirects to the latest release, or to the list when there is none.
- The **Tags** button on the list opens the repository's tags.

Each release lists its **Assets** with their size and download count. Published releases also list **Source code (zip)** and **Source code (tar.gz)**, which download the repository at the tag (`/acme/website/archive/refs/tags/v1.2.0.zip` and `.tar.gz`). Drafts don't offer source archives.

### Create a release

1. Open `https://diffinery.com/acme/website/releases` and select **Draft a new release** (or go to `https://diffinery.com/acme/website/releases/new`; `?tag=v1.2.0` pre-fills the tag).
2. Under **Tag**, pick an existing tag from **Choose an existing tag**, or type a new one in the box below it (for example `v1.2.0`). A typed tag wins over the selected one.
3. For a new tag, choose the branch it should point at under **Target for a new tag**. It defaults to the default branch. The target is ignored when the tag already exists.
4. Enter a **Release title**. When you leave it empty, the tag name is shown instead.
5. Write the **Release notes** in Markdown, or leave them empty and keep **Generate release notes from merged pull requests (when the notes are empty)** checked to have Diffinery write them.
6. Optionally choose files under **Attach files**. All the files of one submission together can be up to 100 MB; upload larger files with the REST API.
7. Check **Set as a pre-release (not production ready)** if it applies. Keep **Set as the latest release** checked to make this the latest release, or uncheck it to keep the current one.
8. Select **Publish release**, or **Save draft** to keep it private to writers.

After publishing you land on the release page. If the release was saved but a file could not be attached, you see **The release was saved, but a file couldn't be attached:** followed by the reason, and the edit form opens so you can try again.

### Edit, publish or delete a release

- Select **Edit** on a release (`https://diffinery.com/acme/website/releases/edit/v1.2.0?id=7`). You can change the tag, target, title, notes, the pre-release and latest checkboxes, and attach more files.
- On a draft, **Publish release** publishes it (creating the tag if needed) and **Save draft** keeps it a draft. On a published release the button is **Update release**. The web UI can't turn a published release back into a draft; use the API (`"draft": true`).
- To remove an asset, open the release page and select the **×** next to the file.
- Select **Delete** on a release and confirm **Delete the release v1.2.0? The tag stays.** (with the release's title, or its tag when it has none). You see **Release deleted. The tag was kept.** The release's assets and reactions are deleted with it. Delete the tag separately (for example `git push origin --delete v1.2.0`) if you no longer want it.

## Releases with the REST API

The API is at `https://diffinery.com/api/v3` with GitHub's paths and JSON shapes. Authenticate with `Authorization: Bearer dfy_...`. Every endpoint is listed in the [REST API reference](/docs/api).

| Method and path | What it does | Role |
|---|---|---|
| `GET /repos/{owner}/{repo}/releases` | List releases, newest first (`per_page` up to 100, `page`; `Link` header). Drafts only for writers. | read |
| `POST /repos/{owner}/{repo}/releases` | Create a release | write |
| `GET /repos/{owner}/{repo}/releases/latest` | The latest release | read |
| `GET /repos/{owner}/{repo}/releases/tags/{tag}` | The published release of a tag | read |
| `GET /repos/{owner}/{repo}/releases/{id}` | One release by id | read (write for a draft) |
| `PATCH /repos/{owner}/{repo}/releases/{id}` | Edit, publish or unpublish a release | write |
| `DELETE /repos/{owner}/{repo}/releases/{id}` | Delete a release and its assets (the tag stays); returns `204` | write |
| `POST /repos/{owner}/{repo}/releases/generate-notes` | Generate release notes without creating anything | write |
| `GET /repos/{owner}/{repo}/releases/{id}/assets` | List a release's assets | read |
| `POST {upload_url}` | Upload an asset (see [Assets](#assets)) | write |
| `GET /repos/{owner}/{repo}/releases/assets/{asset_id}` | One asset as JSON, or its bytes with `Accept: application/octet-stream` | read |
| `PATCH /repos/{owner}/{repo}/releases/assets/{asset_id}` | Rename an asset or change its label | write |
| `DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}` | Delete an asset; returns `204` | write |
| `GET`, `POST /repos/{owner}/{repo}/releases/{id}/reactions`, `DELETE .../reactions/{reaction_id}` | Reactions on a release (adding one needs a signed-in account) | read |

### Create a release with the API

```sh
curl -sS -X POST \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  https://diffinery.com/api/v3/repos/acme/website/releases \
  -d '{
    "tag_name": "v1.2.0",
    "target_commitish": "main",
    "name": "Website 1.2.0",
    "generate_release_notes": true
  }'
```

| Field | Type | Default | Description |
|---|---|---|---|
| `tag_name` | string | required | The tag. Created at `target_commitish` when the release is published and the tag does not exist. |
| `target_commitish` | string | the default branch | Branch, tag or commit SHA for a new tag. Stored on the release even when the tag already exists. |
| `name` | string | none | The title. `null` or omitted means no title (the tag name is shown). With `generate_release_notes`, an empty title becomes the tag name. |
| `body` | string | none | Release notes in Markdown, at most 125,000 characters. |
| `draft` | boolean | `false` | Save as a draft, visible to writers only. No tag is created for a draft. |
| `prerelease` | boolean | `false` | Mark as a pre-release. |
| `make_latest` | `"true"`, `"false"`, `"legacy"` or boolean | `"true"` | Whether this release becomes the latest release. See [The latest release](#the-latest-release). |
| `generate_release_notes` | boolean | `false` | Generate notes from merged pull requests. When `body` is also given, the generated notes are appended after it, separated by a blank line. |

The response is `201` with the release:

```json
{
  "url": "https://diffinery.com/api/v3/repos/acme/website/releases/7",
  "assets_url": "https://diffinery.com/api/v3/repos/acme/website/releases/7/assets",
  "upload_url": "https://diffinery.com/api/uploads/repos/acme/website/releases/7/assets{?name,label}",
  "html_url": "https://diffinery.com/acme/website/releases/tag/v1.2.0",
  "id": 7,
  "author": {
    "login": "diffy",
    "id": 7220136606554077,
    "node_id": "VXNlcjphMWIyYzNkNGU1ZjYwNzE4MjkzYTRiNWM2ZDdlOGY5MA",
    "avatar_url": "https://diffinery.com/api/avatars/diffy",
    "gravatar_id": "",
    "url": "https://diffinery.com/api/v3/users/diffy",
    "html_url": "https://diffinery.com/diffy",
    "repos_url": "https://diffinery.com/api/v3/users/diffy/repos",
    "organizations_url": "https://diffinery.com/api/v3/users/diffy/orgs",
    "type": "User",
    "user_view_type": "public",
    "site_admin": false
  },
  "node_id": "UmVsZWFzZTo3",
  "tag_name": "v1.2.0",
  "target_commitish": "main",
  "name": "Website 1.2.0",
  "draft": false,
  "immutable": false,
  "prerelease": false,
  "created_at": "2026-10-13T10:00:00Z",
  "updated_at": "2026-10-13T10:00:00Z",
  "published_at": "2026-10-13T10:00:00Z",
  "assets": [],
  "tarball_url": "https://diffinery.com/api/v3/repos/acme/website/tarball/v1.2.0",
  "zipball_url": "https://diffinery.com/api/v3/repos/acme/website/zipball/v1.2.0",
  "body": "## What's Changed\n* Fix broken footer links by @diffy in https://diffinery.com/acme/website/pull/41\n\n**Full Changelog**: https://diffinery.com/acme/website/compare/v1.1.0...v1.2.0",
  "reactions": { "url": "https://diffinery.com/api/v3/repos/acme/website/releases/7/reactions", "total_count": 0, "+1": 0, "-1": 0, "laugh": 0, "confused": 0, "heart": 0, "hooray": 0, "rocket": 0, "eyes": 0 },
  "latest": true
}
```

`latest` is a Diffinery field: `true` for the repository's latest release. `name` and `body` are `null` when empty, and `published_at` is `null` for a draft.

Creating a published release whose tag does not exist yet also creates the tag, which sends a `push` event and starts `on: push` workflows that match the tag, exactly as if you had pushed it.

The same request with the CLI (install it with `curl -fsSL https://diffinery.com/install | bash`, then `diffinery login`):

```sh
cat > release.json <<'EOF'
{ "tag_name": "v1.2.0", "name": "Website 1.2.0", "generate_release_notes": true }
EOF
diffinery api POST /repos/acme/website/releases --input release.json
```

There is no dedicated `release` command in the CLI; `diffinery api` sends any request. Use `--input` with a JSON file for boolean fields: `-f key=value` sends every value as a string.

### Edit, publish and unpublish

`PATCH /repos/{owner}/{repo}/releases/{id}` takes the same fields as create, except `generate_release_notes`. Fields you leave out, or send as `null`, keep their value; send `""` to clear `name` or `body`.

```sh
# Publish a draft
curl -sS -X PATCH -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  https://diffinery.com/api/v3/repos/acme/website/releases/7 -d '{ "draft": false }'

# Turn a pre-release into a full release and make it the latest
curl -sS -X PATCH -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  https://diffinery.com/api/v3/repos/acme/website/releases/7 -d '{ "prerelease": false, "make_latest": "true" }'
```

- Setting `draft` to `false` on a draft publishes it: the tag is created if missing, `published_at` is set, and the release becomes the latest unless you send `"make_latest": "false"`.
- Setting `draft` to `true` on a published release unpublishes it. Its tag stays.
- Changing `tag_name` on a published release points it at that tag, creating the tag at `target_commitish` if it does not exist. The old tag stays.
- Only one published release can use a tag. Drafts can share a tag with each other and with a published release.

### Get releases

```sh
# The latest release
curl -sS -H "Authorization: Bearer dfy_..." https://diffinery.com/api/v3/repos/acme/website/releases/latest

# A release by tag
curl -sS -H "Authorization: Bearer dfy_..." https://diffinery.com/api/v3/repos/acme/website/releases/tags/v1.2.0
```

For a public repository you can leave out the `Authorization` header. `GET .../releases/tags/{tag}` returns only published releases; a draft returns `404`.

## The latest release

Diffinery picks the latest release like GitHub:

1. If a release was explicitly made latest (with `make_latest` set to `true`, or **Set as the latest release** in the web form) and it is still published and not a pre-release, it is the latest.
2. Otherwise, the most recently created published release that is not a pre-release is the latest.

Drafts and pre-releases are never the latest release.

| `make_latest` | Effect |
|---|---|
| `"true"` (the default when creating, and when publishing a draft) | This release becomes the latest, if it is published and not a pre-release. Otherwise nothing changes. |
| `"false"` | This release does not become the latest. The release that was latest before keeps that place, even though this one is newer. If this release was the latest, it stops being the pinned one and rule 2 applies. When no other published full release exists, rule 2 still makes this one the latest. |
| `"legacy"` | Clears the explicit choice, so the most recently created published full release is the latest. |

Booleans `true` and `false` mean the same as the strings. Any other value fails with `make_latest must be true, false or legacy`. When you edit a release without `make_latest`, the latest release does not change (except when publishing a draft, which defaults to `"true"`).

When the repository has no published full release, `GET .../releases/latest` returns `404` with `no published releases`.

## Generated release notes

Diffinery generates release notes the way GitHub's **Generate release notes** does:

1. It finds the previous release: the most recent published release whose tag is an ancestor of the new tag (or of `target_commitish`, when the tag doesn't exist yet). You can name it yourself with `previous_tag_name`.
2. It collects the pull requests merged into the commits between the previous tag and the new one (by merge commit or head commit).
3. It groups them by the categories in `.github/release.yml`, if that file exists.
4. It lists people whose first merged pull request in the repository is in the range under **New Contributors**.
5. It ends with a **Full Changelog** link: a compare link from the previous tag, or the tag's commit history when there is no previous release.

Each pull request becomes one line: `* <title> by @<author> in <link>`.

### Generate notes without creating a release

```sh
curl -sS -X POST -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  https://diffinery.com/api/v3/repos/acme/website/releases/generate-notes \
  -d '{ "tag_name": "v1.2.0", "target_commitish": "main", "previous_tag_name": "v1.1.0" }'
```

| Field | Required | Description |
|---|---|---|
| `tag_name` | yes | The tag the notes are for. It does not need to exist yet. |
| `target_commitish` | no | Used when the tag doesn't exist: the commit the notes run up to. Defaults to the default branch. |
| `previous_tag_name` | no | The tag to start from. It must exist, or the request fails with `previous tag '<name>' does not exist`. |
| `configuration_file_path` | no | Path of the configuration file in the repository, instead of `.github/release.yml`. |

The response has the suggested title (the tag name) and the Markdown body:

```json
{
  "name": "v1.2.0",
  "body": "## What's Changed\n### New Features\n* Add dark mode by @diffy in https://diffinery.com/acme/website/pull/40\n\n### Bug Fixes\n* Fix broken footer links by @diffy in https://diffinery.com/acme/website/pull/41\n\n**Full Changelog**: https://diffinery.com/acme/website/compare/v1.1.0...v1.2.0"
}
```

### Configure categories with .github/release.yml

Diffinery reads `.github/release.yml` (or `.github/release.yaml`) from the commit the notes are generated for. The file has the same format as on GitHub:

```yaml
changelog:
  exclude:
    labels:
      - ignore-for-release
    authors:
      - review-bot
  categories:
    - title: Breaking Changes
      labels:
        - breaking-change
    - title: New Features
      labels:
        - enhancement
        - feature
    - title: Bug Fixes
      labels:
        - bug
      exclude:
        labels:
          - wontfix
```

These keys are supported, all under `changelog`:

| Key | Type | Effect |
|---|---|---|
| `exclude.labels` | list of strings | Pull requests with any of these labels are left out of the notes. |
| `exclude.authors` | list of logins | Pull requests by these authors are left out. |
| `categories` | list | Sections of the notes, in order. |
| `categories[].title` | string | The section heading (`### <title>`). A category without a title is ignored. |
| `categories[].labels` | list of strings | A pull request with any of these labels goes into this category. |
| `categories[].exclude.labels` | list of strings | Pull requests with any of these labels are not put into this category. |
| `categories[].exclude.authors` | list of logins | Pull requests by these authors are not put into this category. |

- `"*"` in a labels list matches every pull request, including ones without labels; `"*"` in an authors list matches every author.
- Labels match exactly (case matters). Author logins match regardless of case.
- A single string works where a list is expected.
- A pull request goes into the first category it matches. Pull requests that match no category are listed under **Other Changes** at the end. Without `categories`, all pull requests are listed directly under **What's Changed**.
- A file that is not valid YAML, or has no `changelog` key, is ignored and the notes are generated without categories.
- **New Contributors** is not filtered by `exclude`.

## Assets

### Upload an asset

Upload a file by sending its bytes as the raw request body to the release's `upload_url` (from the release JSON), with the file name in the `name` query parameter:

```sh
curl -sS -X POST \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/gzip" \
  --data-binary @dist/website-linux-amd64.tar.gz \
  "https://diffinery.com/api/uploads/repos/acme/website/releases/7/assets?name=website-linux-amd64.tar.gz&label=Linux%20build"
```

| Part | Description |
|---|---|
| `name` query parameter | Required. The file name. Characters other than letters, digits and `. _ + @ ~ -` are replaced by `.`, leading and trailing dots are removed, and only the last path segment is kept. The result must be 1 to 255 characters. |
| `label` query parameter | Optional. A label shown next to the file name. |
| `Content-Type` header | Stored as the asset's content type and sent back on download. Defaults to `application/octet-stream`. |
| Body | The file. Up to 100 MB (104,857,600 bytes). |

The response is `201` with the asset:

```json
{
  "url": "https://diffinery.com/api/v3/repos/acme/website/releases/assets/12",
  "id": 12,
  "node_id": "UmVsZWFzZUFzc2V0OjEy",
  "name": "website-linux-amd64.tar.gz",
  "label": "Linux build",
  "uploader": {
    "login": "diffy",
    "id": 7220136606554077,
    "node_id": "VXNlcjphMWIyYzNkNGU1ZjYwNzE4MjkzYTRiNWM2ZDdlOGY5MA",
    "avatar_url": "https://diffinery.com/api/avatars/diffy",
    "gravatar_id": "",
    "url": "https://diffinery.com/api/v3/users/diffy",
    "html_url": "https://diffinery.com/diffy",
    "repos_url": "https://diffinery.com/api/v3/users/diffy/repos",
    "organizations_url": "https://diffinery.com/api/v3/users/diffy/orgs",
    "type": "User",
    "user_view_type": "public",
    "site_admin": false
  },
  "content_type": "application/gzip",
  "state": "uploaded",
  "size": 5242880,
  "digest": null,
  "download_count": 0,
  "created_at": "2026-10-13T10:01:00Z",
  "updated_at": "2026-10-13T10:01:00Z",
  "browser_download_url": "https://diffinery.com/acme/website/releases/download/v1.2.0/website-linux-amd64.tar.gz"
}
```

The upload host is the same as the rest of Diffinery: `upload_url` is under `https://diffinery.com/api/uploads/`, not a separate uploads host. Clients that read `upload_url` from the release, as GitHub clients do, work unchanged. You can upload to drafts. A release can't have two assets with the same name: delete the old one first, or rename it.

### Download an asset

- `browser_download_url`, `https://diffinery.com/{owner}/{repo}/releases/download/{tag}/{name}`, downloads the file. For a private repository, send your token (`curl -L -H "Authorization: Bearer dfy_..."`) or be signed in.
- `GET /api/v3/repos/{owner}/{repo}/releases/assets/{id}` with `Accept: application/octet-stream` returns the bytes directly. Without that header it returns the asset JSON.

```sh
curl -sSL -H "Authorization: Bearer dfy_..." -H "Accept: application/octet-stream" \
  -o website-linux-amd64.tar.gz \
  https://diffinery.com/api/v3/repos/acme/website/releases/assets/12
```

Downloads are always served as attachments (`Content-Disposition: attachment`), so browsers save them instead of displaying them. Each download adds one to `download_count`. Assets of a draft can be downloaded only by writers.

### Rename or delete an asset

```sh
# Rename and relabel
curl -sS -X PATCH -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  https://diffinery.com/api/v3/repos/acme/website/releases/assets/12 \
  -d '{ "name": "website-1.2.0-linux-amd64.tar.gz", "label": "Linux (amd64)" }'

# Delete
curl -sS -X DELETE -H "Authorization: Bearer dfy_..." \
  https://diffinery.com/api/v3/repos/acme/website/releases/assets/12
```

### Asset size limits

| Upload path | Limit |
|---|---|
| REST API `upload_url` | 100 MB per file |
| Web form (**Attach files**) | 100 MB for all files of one submission together |
| MCP `upload_release_asset` | 25 MB per file |

## Releases over MCP

Agents and MCP clients connected to `https://diffinery.com/mcp` get these tools. They apply the same permission checks as the REST API. Full input schemas are in the [MCP tool reference](/docs/reference/mcp-tools).

| Tool | What it does |
|---|---|
| `list_releases` | List releases, newest first (`limit` default 30, at most 100). Drafts only for writers. |
| `get_release` | Get a release by `tag` (drafts included for writers), by `id`, or the latest release when neither is given. |
| `create_release` | Create a release: `tag_name` (required), `target_commitish`, `name`, `body`, `draft`, `prerelease`, `make_latest` and `generate_release_notes`. Creates the tag when it doesn't exist. |
| `update_release` | Edit a release by `id`: tag, target, title, notes, draft and pre-release state, `make_latest`. Publishing a draft sends the release events. |
| `upload_release_asset` | Attach a file of up to 25 MB to `release_id`: pass text as `content`, or bytes as `content_base64` (exactly one of them), with `name`, and optionally `label` and `content_type` (default `text/plain` for `content`, `application/octet-stream` for `content_base64`). |
| `generate_release_notes` | Return generated notes for `tag_name` (with optional `target_commitish` and `previous_tag_name`) without creating anything. Needs write access. |

There is no MCP tool to delete a release; use the REST API or the web UI.

The tools return a compact release object: `id`, `tag_name`, `target_commitish`, `name`, `body`, `draft`, `prerelease`, `latest`, `author` (the login), `created_at`, `published_at`, `html_url` and `assets` (each with `id`, `name`, `label`, `content_type`, `size`, `download_count` and `download_url`).

## Workflows triggered by releases

A workflow with `on: release` runs when a release is published or changed. It runs from the workflow files at the release's tag, with `GITHUB_REF` set to `refs/tags/<tag>` and `GITHUB_SHA` set to the tagged commit.

```yaml
name: publish
on:
  release:
    types: [published]
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./build.sh "${{ github.event.release.tag_name }}"
      - name: Attach the build to the release
        env:
          TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          curl -fsS -X POST \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/gzip" \
            --data-binary @dist/website.tar.gz \
            "https://diffinery.com/api/uploads/repos/${{ github.repository }}/releases/${{ github.event.release.id }}/assets?name=website.tar.gz"
```

The job's own `GITHUB_TOKEN` uploads the asset, which needs `contents: write` (set above for the whole workflow). Uploads go to the release's `upload_url`, under `/api/uploads/repos/...` (GitHub's `uploads.github.com`). To use a personal or agent token instead, store it as an Actions secret and put it in `TOKEN`.

### Activity types

| Type | When |
|---|---|
| `created` | A release is created (published or not). |
| `published` | A release is published: created as published, or a draft is published. |
| `released` | A full release is published, or a published pre-release becomes a full release. |
| `prereleased` | A pre-release is published, or a published release becomes a pre-release. |
| `edited` | A published release is edited (without changing its draft state). |
| `unpublished` | A published release is turned back into a draft. |
| `deleted` | A published release is deleted. |

Like GitHub:

- Without `types`, every activity type starts the workflow. Creating a published release sends `created`, `published` and `released` (or `prereleased`), so a workflow without `types` runs three times. Use `types: [published]` for "run once per new release".
- Changes to drafts (creating, editing or deleting a draft) never start workflows. They do send webhooks.
- The workflow only runs when the release's tag exists.
- Releases created or changed with a job's `GITHUB_TOKEN` don't start workflows, so a workflow can't trigger itself in a loop. Releases made with a personal or agent token do.

### The event payload

`github.event` holds:

| Field | Description |
|---|---|
| `action` | The activity type, for example `published` |
| `release` | The release, in the same shape as the REST API (`id`, `tag_name`, `name`, `body`, `draft`, `prerelease`, `assets`, `upload_url`, `html_url`, `author`, ...) |
| `repository` | GitHub's full repository object, as `GET /repos/{owner}/{repo}` returns it: `id`, `name`, `full_name`, `owner`, `private` and `visibility` (the repository's real visibility), `default_branch`, `html_url`, `clone_url`, the API URLs and so on |
| `sender` | `login` and `type` (`User` or `Bot`) of who caused the event |

## Release webhooks

Webhooks subscribed to `release` (or to every event) get one delivery per action, including actions on drafts: `created`, `published`, `released`, `prereleased`, `edited`, `unpublished` and `deleted`. The payload is `{ "action", "release", "repository", "sender" }`, with `release` in the REST API shape. Uploading or deleting an asset does not send an event. See [Webhook events](/docs/reference/webhook-events#release) for the full payload and [Webhooks](/docs/repositories/webhooks) to set one up.

## Agents and releases

[Agents](/docs/agents/overview) have the write role at most, which is enough to create, edit and delete releases and upload assets, through the REST API or the MCP tools. The usual agent guardrails apply around them:

- A tag an agent creates, by pushing it or by publishing a release, never matches an environment's deployment tag patterns. Deployments of agent-made releases to tag-restricted [environments](/docs/actions/environments) need a person to create the tag.
- Workflow runs started by an agent's release get environment secrets only when the environment is limited to protected branches.
- Agents can't change branch protection, secrets or environments, so they can't loosen those rules to ship a release.

## Differences from GitHub

| GitHub | Diffinery |
|---|---|
| Uploads go to `uploads.github.com` | `upload_url` is on the same host, under `/api/uploads/`. |
| Asset downloads through the API redirect to a storage URL | `Accept: application/octet-stream` returns the bytes directly with `200`. |
| Assets up to 2 GiB | Assets up to 100 MB (25 MB over MCP). |
| `make_latest: legacy` considers creation date and semantic version | `legacy` uses creation date only. |
| Release ids are global | Release and asset ids are numbered per repository. |
| `discussion_category_name`, immutable releases, asset digests | Not supported: `discussion_category_name` is ignored, `immutable` is always `false` and `digest` is always `null`. |
| No `latest` field | Releases have a `latest` boolean. |

## Troubleshooting

| Message | Cause and fix |
|---|---|
| `tag_name is required` | Send `tag_name`, or in the web form choose a tag or type one (`choose a tag or type a new one`). |
| `a release for this tag already exists` | Only one published release per tag. Edit the existing release, or use another tag. |
| `'<tag>' is not a valid tag name` | The tag isn't a valid git ref name (for example it contains spaces, `..` or ends with `.lock`). |
| `target_commitish '<x>' does not exist` | The branch, tag or SHA for the new tag doesn't exist in the repository. `generate-notes` reports it as `target_commitish does not exist`. |
| `tag was created concurrently; retry` | Someone created the tag at the same moment. Send the request again. |
| `write access required` | Your role is below write, or the request used a workflow's `GITHUB_TOKEN` without any write permission. |
| `Resource not accessible by integration (...)` | A workflow's `GITHUB_TOKEN` lacks `contents: write`. Add it to the job's or workflow's `permissions:`. |
| `this token needs the write scope` | Your token has only the `read` scope. |
| `release not found` | Wrong id, or the release is a draft and you can't write to the repository. |
| `no published releases` | `/releases/latest` with no published full release. Publish one, or mark one as latest. |
| `body is too long (maximum is 125000 characters)` | Shorten the notes, or attach the full changelog as an asset. |
| `the name query parameter is required` | Add `?name=<file name>` to the upload URL (drop the `{?name,label}` template part). |
| `release assets are limited to 100 MB` | Split the file or host it elsewhere and link to it from the notes. |
| `an asset named <name> already exists` | Delete or rename the existing asset first. |
| `asset name must be 1 to 255 characters` | The name is empty after sanitizing, or too long. |
| `the web form takes up to 100 MB of files at once; upload larger files with the REST API` | Attach fewer files per submission, or use `upload_url`. |
| `MCP uploads are limited to 25 MB; use the upload_url of the REST API for larger files` | Upload large files over REST. |
| `previous tag '<name>' does not exist` | Check `previous_tag_name`, or leave it out to let Diffinery find the previous release. |
| An `on: release` workflow runs three times | It has no `types` filter. Add `types: [published]`. |
| An `on: release` workflow doesn't run for a draft | Draft changes never start workflows. Publish the release. |
| Generated notes are missing a pull request | Only merged pull requests whose merge or head commit is between the previous tag and this one are listed, minus `exclude` matches in `.github/release.yml`. Pass `previous_tag_name` if the wrong previous release was picked. |
