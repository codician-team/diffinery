---
title: Git LFS
description: Store large files with Git LFS on Diffinery: setup, authentication, the batch API, using LFS files in workflows, and limits.
---

Diffinery has a built-in Git LFS server, so `git lfs push`, `git lfs pull` and clones of repositories that use LFS work against `https://diffinery.com` like they do against GitHub. Use LFS for large binary files (images, models, archives) that would otherwise bloat the Git history or exceed the 100 MB push limit.

## Set up LFS in a repository

You need the `git-lfs` client installed (`git lfs version` to check) and a Diffinery token for pushing. Then use LFS as usual:

```sh
git lfs install                 # once per machine
cd website
git lfs track "*.psd" "assets/video/**"
git add .gitattributes assets/hero.psd
git commit -m "Track design files with LFS"
git push origin main
```

`git push` uploads the LFS objects first, then pushes the commits, which contain only small pointer files. There is nothing to turn on: every Diffinery repository accepts LFS objects.

Cloning and checking out download LFS files automatically when `git-lfs` is installed:

```sh
git clone https://diffinery.com/acme/website.git
git lfs pull                    # fetch LFS files for the current checkout, if you skipped them
```

## Endpoint and authentication

Git LFS finds the server from the remote URL, so no configuration is needed. The endpoint is:

```text
https://diffinery.com/acme/website.git/info/lfs
```

LFS uses the same credentials as Git: a personal access token as the password, through your credential helper or `diffinery auth setup-git` (see [Git over HTTPS](/docs/repositories/git#authentication)).

If you also pass the token with `http.extraHeader` (as `actions/checkout` does when it keeps credentials), `git-lfs` sends that header and the batch response's `Authorization` header together on each transfer. Diffinery accepts the repeated header and uses the first value, so this works. A `Basic` credential that isn't valid base64 gets `401 malformed basic credentials`.

| Operation | Needs |
| --- | --- |
| Download from a public repository | Nothing |
| Download from a private repository | A token with at least the `read` scope, for an account with read access |
| Upload | A token with the `write` or `admin` scope, for an account with write access. The repository must not be archived. |

The batch request is always a `POST`, but a batch request for `download` counts as a read, so anonymous callers (on public repositories), `read`-scoped tokens and job tokens with `contents: read` can download LFS files. A batch request for `upload` and the `PUT` that sends the file are writes:

| Caller | Upload refused with |
| --- | --- |
| No credentials | `401 authentication required` (the `git-lfs` client then asks for credentials) |
| A `read`-scoped token | `403 this token needs the write scope` |
| A token whose account has less than write access | `403 write access required` |
| A workflow's job token without `contents: write` | `403 Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: contents: write)` |
| Anyone, on an archived repository | `403 repository is archived (read-only)` |

Agents can upload LFS objects like any account with write access. Branch protection applies to the commits that reference the objects, not to the LFS upload itself.

### Disable the locking check

Diffinery doesn't implement the LFS file locking API. If `git push` prints a warning that the remote doesn't support the Git LFS locking API, turn the check off for the repository:

```sh
git config lfs.https://diffinery.com/acme/website.git/info/lfs.locksverify false
```

`git lfs lock` and `git lfs unlock` don't work on Diffinery.

## How the batch API works

Diffinery implements the standard Git LFS batch API with the `basic` transfer adapter and SHA-256 object IDs. You normally never call it yourself, but scripts and other LFS clients can.

```http
POST /acme/website.git/info/lfs/objects/batch HTTP/1.1
Host: diffinery.com
Authorization: Basic eC10b2tlbjpkZnlfLi4u
Accept: application/vnd.git-lfs+json
Content-Type: application/vnd.git-lfs+json

{"operation": "download", "objects": [{"oid": "4d7a2146...a6b0", "size": 52428800}]}
```

The response lists an action for each object:

```json
{
  "transfer": "basic",
  "hash_algo": "sha256",
  "objects": [
    {
      "oid": "4d7a2146...a6b0",
      "size": 52428800,
      "authenticated": true,
      "actions": {
        "download": {
          "href": "https://diffinery.com/acme/website.git/info/lfs/objects/4d7a2146...a6b0",
          "header": { "Authorization": "Basic eC10b2tlbjpkZnlfLi4u" },
          "expires_in": 3600
        }
      }
    }
  ]
}
```

| Operation | Object state | Response for the object |
| --- | --- | --- |
| `download` | Stored | A `download` action pointing at `GET .../info/lfs/objects/<oid>`. |
| `download` | Not stored | `"error": {"code": 404, "message": "object not found"}` |
| `upload` | Not stored yet | An `upload` action pointing at `PUT .../info/lfs/objects/<oid>`. |
| `upload` | Already stored | No action, so the client skips it. |
| either | `oid` isn't 64 lowercase hex characters | `"error": {"code": 422, "message": "invalid oid"}` |

Action URLs carry the same `Authorization` header as the batch request, and the transfer requests are checked again (read for downloads, write and the `write` token scope for uploads). On upload, Diffinery hashes the body and rejects it with `422 content does not match oid` if the SHA-256 differs from the object ID, so a corrupted upload is never stored. There is no separate `verify` step.

At most 1,000 objects are handled per batch request; the `git-lfs` client sends 100 at a time by default.

## Storage

LFS objects are stored in Diffinery's object storage (Cloudflare R2), separately from the repository's Git objects. They are stored once per repository and deduplicated by SHA-256. The repository's **Size** in the **About** box counts Git objects only, not LFS files.

## LFS files in the web UI, the API and archives

Outside the LFS endpoints, Diffinery sees only the small pointer files that Git stores in place of LFS content:

- The file view and raw URLs (`/acme/website/blob/main/assets/hero.psd`, `/acme/website/raw/main/assets/hero.psd`) show the pointer text, not the file.
- `GET /api/v3/repos/acme/website/contents/{path}` and the MCP `get_file` tool return the pointer.
- [Source code archives](/docs/repositories/overview#source-code-archives) (zipball and tarball, and the **Source code** links on releases) contain the pointers. This differs from GitHub, which can include LFS content in archives.

To hand out a large file to people without Git, attach it to a release instead (up to 100 MB per asset). See [Releases](/docs/collaboration/releases).

## Use LFS files in workflows

As on GitHub, `actions/checkout` downloads LFS files when you set `lfs: true` (the default is `false`, which leaves pointer files in the workspace). With `submodules: true` or `recursive`, it also pulls the submodules' LFS files. Hosted runners have `git-lfs` installed:

```yaml
name: Build
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          lfs: true
      - run: ls -lh assets/
```

You can also download them in a later step. The checkout leaves the job's token configured for the repository's URL (unless you set `persist-credentials: false`), so `git lfs pull` works without extra credentials. To download only some files, use `git lfs pull --include="assets/video/**"`.

The job token reads LFS files with `contents: read` (the default for new repositories) and uploads them with `contents: write`, as on GitHub. On self-hosted runners, install `git-lfs` on the machine first. See [Compatibility with GitHub Actions](/docs/actions/compatibility).

## Moving LFS files from GitHub

`git clone --mirror` and `diffinery migrate github` copy LFS pointers, not the LFS files. Copy the files yourself from a clone that has them:

```sh
git clone https://github.com/acme/website.git
cd website
git lfs fetch --all origin
git remote add diffinery https://diffinery.com/acme/website.git
git lfs push --all diffinery
```

See [Migrate from GitHub](/docs/migrate-from-github).

## Limits

| Limit | Value |
| --- | --- |
| Objects per batch request | 1,000 |
| Transfer adapter | `basic` only (no multipart or resumable uploads) |
| Size of one LFS file | Each file is uploaded in a single request, and Cloudflare limits one request to 100 MB, so files over 100 MB can't be uploaded. |
| Hash algorithm | SHA-256 |
| File locking | Not supported |
| Push protection | LFS file contents are not scanned for secrets, only the pointer files in the Git push. |
| Storage | LFS objects count toward the repository owner's [storage quota](/docs/reference/limits#account-quotas). Past it, uploads are refused: each object in the batch response gets error `507` with the reason. |

## Troubleshooting

| What you see | Cause and fix |
| --- | --- |
| `Remote "origin" does not support the Git LFS locking API` | Expected: locking isn't implemented. Set `lfs.<url>.locksverify` to `false` as shown in [Disable the locking check](#disable-the-locking-check). |
| `object not found` when cloning or pulling | The LFS file was never uploaded to Diffinery, for example after a mirror push from GitHub. Push it from a clone that has it: `git lfs push --all origin`. |
| Upload fails with HTTP 403 | Your token is `read`-scoped (`this token needs the write scope`), your role is below write (`write access required`), or the repository is archived (`repository is archived (read-only)`). Use a token with the `write` scope for an account with write access. |
| Upload fails with HTTP 401 | The upload had no credentials (`authentication required`). Configure a credential helper or `diffinery auth setup-git`, as in [Endpoint and authentication](#endpoint-and-authentication). |
| Upload fails for a very large file | Files over 100 MB can't be uploaded. Split the file, or keep it outside the repository. |
| Workflow sees small text files instead of the real files | The checkout step ran without `lfs: true`. Add `with: lfs: true` to `actions/checkout`, or a `git lfs pull` step after it. |
| Upload from a workflow fails with HTTP 403 `Resource not accessible by integration` | The job's token has no `contents: write`. Add `permissions: contents: write` to the job. |
| Upload fails with HTTP 401 `malformed basic credentials` | The `Authorization: Basic` value isn't valid base64. Check how the credential is built, or send `Authorization: Bearer dfy_...`. |
| `content does not match oid` | The uploaded bytes didn't match the object ID, usually a corrupted local object. Run `git lfs fsck` and push again. |
