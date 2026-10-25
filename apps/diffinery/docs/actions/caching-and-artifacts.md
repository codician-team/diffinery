---
title: Caching and artifacts
description: Speed up workflows with actions/cache, pass files between jobs and runs with upload-artifact and download-artifact, and manage both through the API.
---

A cache keeps files such as dependency downloads between runs. An artifact keeps files produced by a run, so later jobs (in the same run or another one) can use them and you can download them afterwards. Diffinery serves the same cache and artifact services as GitHub, so the official `actions/cache`, `actions/upload-artifact` and `actions/download-artifact` work unmodified, and the runner also has faster built-in versions that share their storage and formats.

## Built-in actions and the official actions

For speed, the runner runs its own implementation of these actions instead of downloading them:

| Action | Built-in for | What it does |
| --- | --- | --- |
| `actions/cache` | `v3` to `v6` | Restores a cache entry, then saves one in a post step when the job ends |
| `actions/cache/restore` | `v3` to `v6` | Restores a cache entry only |
| `actions/cache/save` | `v3` to `v6` | Saves a cache entry only |
| `actions/upload-artifact` | `v4` to `v7` | Uploads files as an artifact of the run |
| `actions/download-artifact` | `v4` to `v8` | Downloads artifacts of this run, or of another run with `run-id` and `github-token` |

The built-ins use the same services, archive formats, cache versions and artifact ids as the official actions. An entry saved by the built-in `actions/cache` restores with the official action and the other way round, and an artifact uploaded by either downloads with either.

A built-in steps aside and the real action is downloaded from GitHub and run when:

- the reference isn't a version tag in the range above (`vN`, `vN.N` or `vN.N.N`), for example a commit SHA, a branch, or a newer major version;
- the step passes an input the built-in doesn't know;
- the step's environment has `DIFFINERY_BUILTINS` set to `false`, `0`, `no` or `off` (in the workflow's, the job's or the step's `env:`);
- a self-hosted runner was started with `DIFFINERY_DISABLE_BUILTINS=1`.

```yaml
env:
  DIFFINERY_BUILTINS: false   # every step in this workflow runs the real actions
```

The `cache` input of `actions/setup-node`, `actions/setup-python` and `actions/setup-go` uses the same service; see [Dependency caching with setup actions](#dependency-caching-with-setup-actions).

Third-party actions that use the `@actions/cache` or `@actions/artifact` toolkit packages, and `docker/build-push-action` with `cache-from: type=gha` and `cache-to: type=gha`, work as well (see [The runtime services](#the-runtime-services)).

## Caching dependencies

A cache entry is a compressed archive of one or more paths, stored under a key you choose. A typical workflow restores the entry at the start of a job and saves it at the end:

```yaml
name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/cache@v4
        id: npm-cache
        with:
          path: ~/.npm
          key: npm-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}
          restore-keys: |
            npm-${{ runner.os }}-
      - run: npm ci
      - run: npm test
```

On the first run there is no entry, so the step logs `Cache not found for input keys: ...` and the job continues. When the job succeeds, the post step **Post actions/cache@v4** archives `~/.npm` and saves it under the key (`Cache saved with key: <key>`). The next run with the same `package-lock.json` restores it (`Cache restored from key: <key>`).

### Inputs for actions/cache

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `path` | Yes | | Files and directories to cache, one per line. Supports globs and `!` exclusions (`! pattern` is read as `!pattern`). Relative paths are relative to the workspace; `~/` expands to the home directory. |
| `key` | Yes | | Key to save the entry under and to look up first. At most 512 characters, no commas. |
| `restore-keys` | No | | Prefixes to try, one per line, in order, when `key` has no exact match. At most 20. |
| `lookup-only` | No | `false` | Check whether an entry exists without downloading it. Logs `Cache found and can be restored from key: <key>`. |
| `fail-on-cache-miss` | No | `false` | Fail the step when neither `key` nor any restore key matches. |
| `save-always` | No | `false` | Save in the post step even when the job failed or was cancelled. |
| `upload-chunk-size`, `enableCrossOsArchive` | No | | Accepted. The built-in uploads in 16 MiB blocks, 8 at a time (8 MiB blocks, 4 at a time, on the 1 GiB `tiny` runner), whatever `upload-chunk-size` says. |

`actions/cache/restore` and `actions/cache/save` take the same inputs. If `key` or `path` is missing, the step fails with `Input required and not supplied: key` or `Input required and not supplied: path`.

### Outputs for actions/cache

| Output | Set by | Value |
| --- | --- | --- |
| `cache-hit` | `actions/cache`, `actions/cache/restore` | `true` when the restored entry's key equals `key` (ignoring case), `false` when a restore key matched. Not set on a miss. |
| `cache-primary-key` | `actions/cache/restore` | The `key` input, always. |
| `cache-matched-key` | `actions/cache/restore` | The key of the entry that was restored. Not set on a miss. |

Use `cache-hit` to skip work when the exact entry was restored. Compare with `'true'`, because the output is empty on a miss:

```yaml
      - uses: actions/cache@v4
        id: deps
        with:
          path: node_modules
          key: modules-${{ hashFiles('package-lock.json') }}
      - if: steps.deps.outputs.cache-hit != 'true'
        run: npm ci
```

### How keys and restore keys match

An entry has a key, a version and a scope. The version is a hash of the `path` lines and the compression, computed the way `@actions/cache` computes it, so an entry only restores for the same paths saved with the same compression. The scope is the ref of the job that saved it.

When a restore step runs, Diffinery searches these scopes in order, and stops at the first match:

1. The job's own ref, for example `refs/heads/feature-x`, `refs/tags/v1.2.0` or, for a `pull_request` run, `refs/pull/7/merge`.
2. For pull request runs, the pull request's base branch. For merge queue runs, the queue's target branch (`merge_group.base_ref`).
3. The default branch.

In each scope it tries:

1. An entry whose key equals `key` exactly.
2. The newest entry whose key starts with `key`.
3. For each line of `restore-keys`, in order, the newest entry whose key starts with that line.

```yaml
key: build-${{ github.ref_name }}-${{ hashFiles('**/go.sum') }}
restore-keys: |
  build-${{ github.ref_name }}-
  build-
```

With this configuration, a run on a feature branch first looks for the exact key and the newest `build-` entry saved on that branch, then on the default branch.

### Scope

A job saves only to its own ref. Branches, tags and pull requests read their own entries and those of the default branch (and pull requests those of their base branch), but never each other's. This is the same isolation GitHub has, so a pull request can't plant a cache entry that a release job on the default branch later restores.

Different repositories never share entries, even within one organization.

### When the cache is saved

`actions/cache` saves in a post step that runs after all other steps of the job:

- It runs only if the job succeeded so far. With `save-always: true` it runs even after a failure or cancellation.
- It's skipped when the restore found an exact match for `key`: `Cache hit occurred on the primary key <key>, not saving cache.`
- It archives whatever exists at `path` at that moment. If none of the paths exist, it logs the warning `Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.`

Entries are immutable. If an entry with the same key and version already exists in the job's scope, or another running job is saving it, the save logs `Failed to save: Unable to reserve cache with key <key>, another job may be creating this cache.` and the job continues. To refresh an entry, change its key, for example by including a hash of the lock file. An upload left unfinished by a job that has ended is discarded and the key can be saved again.

`actions/cache/save` saves immediately when its step runs, so you can save a cache mid-job or from a step with its own `if:`:

```yaml
      - uses: actions/cache/restore@v4
        id: restore
        with:
          path: .build-cache
          key: build-${{ github.sha }}
          restore-keys: build-
      - run: make build
      - uses: actions/cache/save@v4
        if: always()
        with:
          path: .build-cache
          key: ${{ steps.restore.outputs.cache-primary-key }}
```

### Archive format

The built-in creates the same archive as `@actions/cache`: a POSIX tar file of the matched paths, stored relative to the workspace, compressed with zstd when `zstd` is installed (it is on hosted runners) and with gzip otherwise. Restoring extracts it to the same paths relative to the workspace.

Restoring is built for speed. The runner downloads the archive in 8 MiB ranges, 16 at a time (4 on the 1 GiB `tiny` runner), and pipes them straight into `tar`, so the archive extracts while it is still arriving. On hosted runners a 216 MB pnpm store restores in about 3 to 5 seconds. Every range must come from the same stored entry; if one doesn't, or a range keeps failing after its retries, the log says `Streaming the cache entry failed (<reason>); downloading it in full and extracting it again.` and the runner downloads the whole archive to a file and extracts it again, which replaces anything the stream left half done. If that fails too, the restore removes what it had extracted and behaves like a miss, so a job never runs with half a cache. Artifact downloads use the same ranged download.

Saving is built for speed too. Files of up to 32 MiB go up in one request; larger ones go up in 16 MiB blocks, 8 at a time (8 MiB blocks, 4 at a time, on the `tiny` runner). Diffinery then joins the blocks into one stored object. Objects over 16 MiB are joined as 8 MiB parts, copied by several workers at once, so a 200 MB artifact or cache entry is stored within seconds of its last block. The same applies to uploads from the official actions.

- The compression is part of the version, so an entry saved on a runner with zstd doesn't restore on one without it.
- A path outside the workspace, such as `~/.npm`, is stored relative to the workspace too. A runner whose workspace sits at a different depth restores it into a different directory. Include `runner.environment` or a label in the key if you mix runner types.
- The step log shows the archive size as `Cache Size: ~<n> MB (<bytes> B)` on both save and restore.

### Size and eviction

| Limit | Value |
| --- | --- |
| Key | 512 characters, no commas. A longer key or a comma fails the restore step with `Key Validation Error: <key> cannot be larger than 512 characters.` or `Key Validation Error: <key> cannot contain commas.` |
| Restore keys | 20 per lookup |
| One entry | 10 GB. A larger archive isn't saved: `Cache size of ~<n> MB (<bytes> B) is over the 10GB limit, not saving cache.` |
| Repository total | 10 GB of entries, counting uploads in progress |
| One upload request | 256 MiB. The built-ins and the official actions upload large archives in smaller blocks, so this only matters for your own clients. |

Diffinery deletes entries in two ways:

- Entries that no job has restored for 7 days are deleted the next time a job saves a cache in the repository.
- When a save needs room above the 10 GB total, the least recently used entries are deleted until it fits. Restoring an entry counts as using it.

If uploads still in progress use the whole budget, the save is refused (`uploads in progress use the repository's whole cache budget`) and the job continues with a warning.

### Manage caches with the API

List, inspect and delete cache entries with the REST API. Reading needs read access to the repository; deleting needs write access. For a job's `GITHUB_TOKEN`, these endpoints need the `actions` permission.

List entries:

```http
GET /api/v3/repos/acme/website/actions/caches?key=npm-&ref=refs/heads/main
Authorization: Bearer dfy_...
```

```json
{
  "total_count": 1,
  "actions_caches": [
    {
      "id": 42,
      "ref": "refs/heads/main",
      "key": "npm-Linux-3f1c...",
      "version": "a1b2c3...",
      "last_accessed_at": "2026-10-12T09:41:07Z",
      "created_at": "2026-10-10T08:02:51Z",
      "size_in_bytes": 48211301
    }
  ]
}
```

| Query parameter | Meaning |
| --- | --- |
| `key` | Only entries whose key starts with this |
| `ref` | Only entries saved for this ref, for example `refs/heads/main` or `refs/pull/7/merge` |
| `sort` | `last_accessed_at` (default), `created_at` or `size_in_bytes` |
| `direction` | `desc` (default) or `asc` |
| `per_page`, `page` | Paging; `per_page` defaults to 30, at most 100 |

Other endpoints:

| Request | Result |
| --- | --- |
| `GET /repos/{owner}/{repo}/actions/cache/usage` | `{"full_name": "acme/website", "active_caches_size_in_bytes": ..., "active_caches_count": ...}` |
| `DELETE /repos/{owner}/{repo}/actions/caches?key=<key>&ref=<ref>` | Deletes the entries with exactly this key (in every scope, or only `ref`'s). Returns `{"total_count": n, "actions_caches": [...]}` with the deleted entries. `422 key is required` without `key`; `404 Not Found` when nothing matches. |
| `DELETE /repos/{owner}/{repo}/actions/caches/{cache_id}` | Deletes one entry. `204 No Content`, or `404 Not Found`. |

```sh
diffinery api GET "/repos/acme/website/actions/caches?key=npm-"
diffinery api DELETE "/repos/acme/website/actions/caches?key=npm-Linux-3f1c..."
```

Deletions are recorded in the [audit log](/docs/security/audit-log) as `actions.cache.delete`.

### Errors never fail the job

Cache service problems are reported as warnings and the job carries on, as on GitHub:

- `Failed to restore: <reason>` on restore. The step behaves like a miss, and nothing the restore extracted before it failed is left behind.
- `Failed to save: <reason>` on save.
- `The cache service is not available to this job; skipping.` when the job has no runtime services.

The exceptions are a key validation error (see the table above) and `fail-on-cache-miss: true`, which fails the step with `Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: <key>`.

## Dependency caching with setup actions

`actions/setup-node`, `actions/setup-python` and `actions/setup-go` can restore and save a dependency cache for you. They use the same service, scopes and limits as `actions/cache`, and the same keys and paths as the official setup actions, so a cache saved by the built-in restores with the official action and the other way round. The save happens in a post step only when the job succeeds, the exact key wasn't restored, and the cache directory exists.

| Action | Input | Cached directory | Files hashed by default | Key on a hosted runner |
| --- | --- | --- | --- | --- |
| `actions/setup-node` | `cache: npm`, `pnpm` or `yarn` | `npm config get cache`, `pnpm store path`, or the Yarn cache folder | The first of `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock` in the workspace root (npm); `pnpm-lock.yaml` (pnpm); `yarn.lock` (yarn) | `node-cache-Linux-x64-<manager>-<hash>` |
| `actions/setup-python` | `cache: pip` | `pip cache dir` | `**/requirements.txt`, or `**/pyproject.toml` when none match | `setup-python-Linux-x64-<os version>-<os name>-python-<version>-pip-<hash>`, with the part before the hash as a restore key |
| `actions/setup-python` | `cache: pipenv` | `~/.local/share/virtualenvs` | `**/Pipfile.lock` | `setup-python-Linux-x64-python-<version>-pipenv-<hash>` |
| `actions/setup-go` | `cache` (on by default) | `GOMODCACHE` and `GOCACHE` | `go.sum` in the workspace root | `setup-go-Linux-x64-ubuntu24-go-<version>-<hash>` |

All three accept `cache-dependency-path` to hash different files, one pattern per line, and set the `cache-hit` output (`true` or `false`). `actions/setup-node` also sets `cache-primary-key`.

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: apps/web/pnpm-lock.yaml
```

Details to be aware of:

- `actions/setup-node@v5` and later turn on npm caching by themselves when `package.json` names npm in `packageManager` or `devEngines.packageManager`, and log `Detected npm as the package manager from package.json's packageManager field. ...`. Set `package-manager-cache: false` to turn it off.
- If setup-node's lock file is missing, the step fails with `Dependencies lock file is not found in <workspace>. Supported file patterns: <files>`. If `cache-dependency-path` matches nothing, it fails with `Some specified paths were not resolved, unable to cache dependencies.`
- If setup-python's patterns match nothing, the step fails with `No file in <workspace> matched to [<patterns>], make sure you have checked out the target repository`.
- `actions/setup-go` doesn't fail without a `go.sum`: it logs the warning `Restore cache failed: Dependencies lock file is not found in <workspace>. Supported file patterns: go.sum` and continues. Set `cache: false` to turn caching off.
- On a miss the log says `<manager> cache is not found`, for example `npm cache is not found`.
- `cache` values the built-ins don't handle (for example `cache: poetry` in setup-python) run the official action instead.

## Artifacts

An artifact is a named file, normally a zip archive, that belongs to a workflow run. Jobs in the same run download it with `actions/download-artifact`, other runs can download it with `run-id` and a token, and anyone with read access to the repository can download it from the run page or the API until it expires.

### Upload an artifact

```yaml
      - run: npm run build
      - uses: actions/upload-artifact@v4
        id: upload
        with:
          name: site
          path: |
            dist/
            !dist/**/*.map
          if-no-files-found: error
          retention-days: 14
```

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `name` | No | `artifact` | Artifact name. It can't contain `"`, `:`, `<`, `>`, `\|`, `*`, `?`, `\`, `/`, carriage return or line feed. |
| `path` | Yes | | Files, directories or globs to upload, one per line. Lines starting with `!` exclude matches, and lines starting with `#` are ignored. Relative paths are relative to the workspace. |
| `if-no-files-found` | No | `warn` | `warn` logs a warning, `error` fails the step, `ignore` logs a plain message. |
| `retention-days` | No | 90 | Days to keep the artifact, from 1 to 90. |
| `compression-level` | No | `6` | Zip compression level, `0` (none) to `9` (best). Use `0` for files that are already compressed. |
| `overwrite` | No | `false` | Replace an artifact with the same name in the run instead of failing. |
| `include-hidden-files` | No | `false` | Include files and directories whose names start with `.`. |
| `archive` | No | `true` | `false` uploads a single file as it is, without a zip archive. The artifact is then named after the file. |

The step logs `With the provided path, there will be <n> file(s) uploaded`, then `Artifact <name> has been successfully uploaded! Final size is <n> bytes. Artifact ID is <id>`.

### Outputs of upload-artifact

| Output | Value |
| --- | --- |
| `artifact-id` | The artifact's numeric id |
| `artifact-digest` | The SHA-256 digest of the uploaded file, in hex |
| `artifact-url` | `https://diffinery.com/acme/website/actions/runs/<run number>/artifacts/<id>`, a link that downloads the artifact |

### What goes into the archive

The runner collects the matching files, then archives them relative to the deepest directory that contains all of them, as `actions/upload-artifact` does:

| `path` | Files matched | Paths inside the artifact |
| --- | --- | --- |
| `dist/` | `dist/index.html`, `dist/assets/app.js` | `index.html`, `assets/app.js` |
| `dist/index.html` | `dist/index.html` | `index.html` |
| `dist/` and `reports/junit.xml` | `dist/index.html`, `reports/junit.xml` | `dist/index.html`, `reports/junit.xml` |

Only files are uploaded; empty directories are dropped. Hidden files are left out unless `include-hidden-files: true`. The archive is a zip file.

With `archive: false`, exactly one file may match; otherwise the step fails with `When 'archive' is set to false, only a single file can be uploaded. Found <n> files to upload.` The file is stored with a content type from its extension, for example `text/html` for `.html`.

### Download artifacts in a later job

The job must run after the job that uploaded the artifact, so list that job in `needs`:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: site
          path: dist/

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        id: get-site
        with:
          name: site
          path: public
      - run: ls -R ${{ steps.get-site.outputs.download-path }}
```

| Input | Default | Description |
| --- | --- | --- |
| `name` | | Download only the artifact with this name. |
| `artifact-ids` | | Download only these artifacts, by id, separated by commas. Can't be combined with `name`. |
| `pattern` | | Download the artifacts whose names match this glob, for example `junit-*`. |
| `path` | The workspace | Directory to extract into, relative to the workspace. It's created if missing. |
| `merge-multiple` | `false` | Extract every selected artifact into `path` itself instead of one directory per artifact. |
| `skip-decompress` | `false` | Save the zip file instead of extracting it. |
| `digest-mismatch` | `error` for `v8` and later, `warn` before | What to do when a download doesn't match the artifact's digest: `ignore`, `info`, `warn` or `error`. |
| `github-token`, `run-id`, `repository` | | Download from another run or repository; see below. |

With no `name`, `artifact-ids` or `pattern`, every artifact of the run is downloaded. Where they go:

- With `name`, or `merge-multiple: true`, files go straight into `path`.
- Otherwise each artifact goes into `<path>/<artifact name>`. From `v5` on, a download that selects exactly one artifact goes straight into `path`.

The step sets the output `download-path` to the absolute directory, and logs `Artifact '<name>' downloaded to <path>` for each artifact.

### Download from another run or repository

Pass `run-id` and a token in `github-token` to read another run's artifacts through the REST API. Add `repository` for a run in another repository:

```yaml
jobs:
  report:
    runs-on: ubuntu-latest
    permissions:
      actions: read
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: coverage
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

- `run-id` is a run number, such as `github.run_id` or `github.event.workflow_run.id`. It covers every attempt of that run.
- The job's `GITHUB_TOKEN` can read another run of its own repository when the job has `actions: read` (or the repository default gives it). It can read artifacts of other **public** repositories on Diffinery, but not of other private ones; use a personal or agent token with read access for those. See [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions).
- `run-id` without `github-token` is ignored, and the current run is read.

Without these inputs, `actions/download-artifact` reads artifacts from the job's own run only. Jobs of a [reusable workflow](/docs/actions/reusable-workflows) are part of the caller's run, so the caller and the called workflow can exchange artifacts. A re-run attempt is a separate run for this purpose: its jobs don't see the artifacts of earlier attempts without `run-id`, except those of the jobs a failed-job or single-job re-run kept from an earlier attempt (see [Re-run a run](/docs/actions/overview#re-run-a-run)), which belong to the new attempt too.

### Uploading the same name twice

Artifact names are unique within a run. Uploading a name that already exists fails:

```text
Failed to CreateArtifact: an artifact with the name 'site' already exists on the workflow run. Set 'overwrite: true' to replace it.
```

Set `overwrite: true` to delete the old artifact and upload the new one. In a matrix, give each job its own name:

```yaml
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - run: npm test -- --reporter junit > junit.xml
      - uses: actions/upload-artifact@v4
        with:
          name: junit-node-${{ matrix.node }}
          path: junit.xml
```

A later job can collect them all with `pattern: junit-*` and `merge-multiple: true`.

### Retention and expiry

Each artifact keeps its `retention-days` from 1 to 90 days, 90 when you don't set one. A value above 90 is lowered with the warning `Retention days cannot be greater than the maximum allowed retention set within the repository. Using 90 instead.`

When an artifact expires:

- Its content is deleted, and it no longer counts toward the storage quota.
- The run page no longer lists it, and download-artifact no longer finds it.
- The REST API still lists it, with `"expired": true`, for another 90 days. Downloading it answers `410 Artifact has expired`.

### Storage quota

By default a repository can store up to 10 GB of artifacts. Live artifacts and uploads in progress count; expired and deleted artifacts don't. An upload beyond the quota fails the step with a message that ends in:

```text
the repository's artifact storage quota (10737418240 bytes) is used up; delete artifacts or wait for them to expire
```

Delete artifacts you no longer need with the API (see below). A job's unfinished uploads are removed when the job ends. An instance's administrators change the quota with `ARTIFACT_QUOTA_BYTES` (see [Configuration](/docs/self-hosting/configuration)).

## Download artifacts from the web

Open the run at `https://diffinery.com/<owner>/<repo>/actions/runs/<run number>`. When the run has artifacts that haven't expired, an **Artifacts** box lists each one with its size and upload time. Select a name to download it as `<name>.zip`, or as the file itself for an artifact uploaded with `archive: false`.

The download link is `https://diffinery.com/<owner>/<repo>/actions/runs/<run>/artifacts/<name or id>`, the same form as the `artifact-url` output. Extract a zip file with:

```sh
unzip site.zip -d site
```

You need read access to the repository. For a public repository, anyone can download. Artifacts uploaded by older Diffinery runner versions download as `<name>.tar.gz`.

## Download artifacts with the API

The REST API has GitHub's artifact endpoints. Reading needs read access to the repository; deleting needs write access. For a job's `GITHUB_TOKEN`, they need the `actions` permission.

| Request | Result |
| --- | --- |
| `GET /repos/{owner}/{repo}/actions/artifacts` | Every artifact of the repository, newest first, expired ones included. Takes `name`, `per_page` (default 30, at most 100) and `page`. |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts` | The artifacts of one run, expired ones included. `run_id` is the run number (every attempt) or a run's id. Takes `name`, `per_page` and `page`. |
| `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}` | One artifact. |
| `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip` | `302 Found` to a signed download URL valid for 10 minutes. `410 Artifact has expired` for an expired artifact. |
| `DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id}` | Deletes the artifact. `204 No Content`. Recorded in the [audit log](/docs/security/audit-log) as `actions.artifact.delete`. |

Both lists send a `Link` header, so `octokit.paginate` works. Artifacts uploaded by older Diffinery runners are listed, fetched and deleted the same way and kept for 90 days; their download is a gzip-compressed tar file (`<name>.tar.gz`) rather than a zip. Unknown ids answer `404 Not Found`. An artifact looks like this:

```json
{
  "id": 1187,
  "node_id": "MDg6QXJ0aWZhY3Q1187",
  "name": "site",
  "size_in_bytes": 482113,
  "url": "https://diffinery.com/api/v3/repos/acme/website/actions/artifacts/1187",
  "archive_download_url": "https://diffinery.com/api/v3/repos/acme/website/actions/artifacts/1187/zip",
  "expired": false,
  "digest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "created_at": "2026-10-12T09:41:07Z",
  "updated_at": "2026-10-12T09:41:07Z",
  "expires_at": "2026-10-26T09:41:07Z",
  "workflow_run": {
    "id": 128,
    "repository_id": "...",
    "head_repository_id": "...",
    "head_branch": "main",
    "head_sha": "9fceb02d0ae598e95dc970b74767f19372d61af8"
  }
}
```

`workflow_run.id` is the run number. Download with the CLI's API command or curl; curl follows the redirect with `-L`:

```sh
curl -fsSL -H "Authorization: Bearer dfy_..." \
  https://diffinery.com/api/v3/repos/acme/website/actions/artifacts/1187/zip -o site.zip
```

Install the CLI with `curl -fsSL https://diffinery.com/install | bash` and sign in with `diffinery login`, then list a run's artifacts:

```sh
diffinery api GET /repos/acme/website/actions/runs/128/artifacts
```

Artifacts uploaded by older Diffinery runner versions are in these endpoints too, as `.tar.gz` downloads.

## The runtime services

Diffinery gives each job the same runtime services GitHub does, through these environment variables:

| Variable | Value |
| --- | --- |
| `ACTIONS_RUNTIME_TOKEN` | A token for this job's cache and artifact requests. It works only while the job runs and expires 30 minutes after the job's timeout. |
| `ACTIONS_RESULTS_URL` | `https://diffinery.com/` |
| `ACTIONS_CACHE_URL`, `ACTIONS_RUNTIME_URL` | `https://diffinery.com/_runtime/` |
| `ACTIONS_CACHE_SERVICE_V2` | `true` |

As on GitHub, they're given to JavaScript actions, Docker container actions and the built-ins, not to `run:` steps. So `docker buildx build --cache-to type=gha` in a `run:` step finds no cache service, while `docker/build-push-action`, a JavaScript action, runs the build with them.

The services speak the protocols the `@actions/cache` and `@actions/artifact` toolkit packages use: cache service v2 and artifact service v4, the older cache REST API, and signed upload and download URLs. A signed download URL is valid for one hour. Requests from a job that has finished fail with `401 the job is not running`.

For Docker layer caching you can use `type=gha` through `docker/build-push-action`, which stores the layers as cache entries under the same 10 GB budget, or keep the cache in the [container registry](/docs/packages/container-registry) with `type=registry`, for example `diffinery.com/acme/website:buildcache`. See [Docker in workflows](/docs/actions/docker).

## Differences from GitHub

| Area | GitHub Actions | Diffinery |
| --- | --- | --- |
| How the actions run | Downloaded from GitHub | Built into the runner for the listed versions; the real action otherwise |
| Cache scope, size and eviction | Per ref with fallbacks, 10 GB, 7-day idle eviction | The same |
| Artifact storage | Counted against the account's storage | 10 GB per repository by default, then uploads are refused |
| Artifact retention | Set per repository or organization | 1 to 90 days, 90 by default |
| Web page for caches | Yes | No; use the API |
| `artifact-url` | Points at github.com | Points at Diffinery |
| `run-id` in download-artifact | The run's id | The run number (`github.run_id`), which is the same thing on Diffinery |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Cache not found for input keys: ...` on every run | The save never happened, or it's in a scope this run can't read. Check the post step's log: the job may have failed (use `save-always: true`), the paths may not exist. An entry saved on a feature branch isn't visible to other branches; save on the default branch for shared entries. |
| `Failed to save: Unable to reserve cache with key <key>, another job may be creating this cache.` | An entry with this key already exists for this ref, or another job is saving it. Include something that changes in the key, such as `hashFiles(...)`, and use `restore-keys` to pick up the latest. |
| `Key Validation Error: ... cannot contain commas.` | Remove commas from `key` and `restore-keys`. |
| `cache-hit` is `false` although files were restored | A restore key matched, not `key`. That's expected. |
| A cache saved by one runner doesn't restore on another | The version includes the paths and the compression. Use the same `path` lines, and make sure `zstd` is installed on both or neither. |
| Restored files appear in an unexpected directory | Paths are stored relative to the workspace. A runner with a different workspace depth restores into other directories. Add the runner type to the key. |
| `The artifact name is not valid: <name>. Contains the following character: ...` | Remove `/`, `\`, `:` and the other characters listed in [Upload an artifact](#upload-an-artifact). |
| `No files were found with the provided path: ... No artifacts will be uploaded.` | The paths don't match any files, or only hidden files. Check the paths relative to the workspace, or set `include-hidden-files: true`. |
| `Failed to CreateArtifact: an artifact with the name '<name>' already exists on the workflow run. ...` | Set `overwrite: true`, or include matrix values in the name. |
| `... artifact storage quota ... is used up; delete artifacts or wait for them to expire` | Delete old artifacts with `DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id}`, or use shorter `retention-days`. |
| `Unable to download artifact(s): Artifact not found for name: <name>` | No job in this run has uploaded that name yet, or it expired. Add the uploading job to `needs`, and check the name's spelling and case. |
| `Inputs 'name' and 'artifact-ids' cannot be used together. Please specify only one.` | Remove one of the two inputs. |
| `Digest validation failed for artifact(s): ...` | The downloaded file doesn't match the digest recorded at upload. Download again; set `digest-mismatch: warn` to continue anyway. |
| `Listing artifacts of run <n> in <repo> failed: HTTP 403` | The token in `github-token` lacks access. Give the job `permissions: actions: read`, or use a token that can read the other repository. |
| `410 Artifact has expired` | The artifact passed its retention period. Its content is gone. |
