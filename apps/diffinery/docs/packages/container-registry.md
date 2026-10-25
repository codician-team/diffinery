---
title: Container registry
description: Push and pull container images on your Diffinery instance, link them to repositories, control who can use them, and publish them from workflows instead of ghcr.io.
---

Diffinery hosts container images at the instance's own address (`diffinery.com` in these examples), next to the code that builds them. The registry speaks the standard OCI distribution API, so `docker`, `podman`, `buildx`, `crane`, `skopeo`, `oras` and the `docker/*` actions work without changes. Permissions work like ghcr.io: images belong to a user or organization, are private by default, and can be linked to a repository whose collaborators then share access.

## Image names

```text
diffinery.com/<owner>/<name>[:<tag>|@sha256:<digest>]
```

| Part | Rules |
| --- | --- |
| `<owner>` | A user or organization on Diffinery. Agents can't own packages. |
| `<name>` | One or more path components separated by `/`, for example `website` or `website/worker`. Each component uses lowercase letters and digits, separated by `.`, `_`, `__` or one or more `-`. |
| Whole name | `<owner>/<name>` is at most 255 characters. |
| `<tag>` | Up to 128 characters: letters, digits, `_`, `.` and `-`, not starting with `.` or `-`. |
| `<digest>` | `sha256:` followed by 64 lowercase hex characters. Other digest algorithms aren't supported. |

Image names are lowercase. The owner part is matched without regard to case, so `diffinery.com/acme/website` refers to the organization `Acme` too.

In Diffinery's documentation and UI, an image name such as `acme/website` is a **package**, and each manifest pushed to it is a **version**. Tags point at versions.

## Sign in

The registry doesn't take passwords. Sign in with any username and a token as the password.

### With a personal access token

Create a token under **Settings → Access tokens** (see [Personal access tokens](/docs/accounts/tokens)). Its scope decides what it can do in the registry:

| Token scope | Registry access |
| --- | --- |
| `read` | Pull |
| `write` | Pull and push |
| `admin` | Pull, push and delete versions and packages, change package settings |

A token restricted to some repositories only reaches packages linked to one of those repositories, plus public packages, which anyone can pull.

```sh
echo "$DIFFINERY_TOKEN" | docker login diffinery.com -u diffy --password-stdin
```

```text
Login Succeeded
```

The same works with other clients:

```sh
echo "$DIFFINERY_TOKEN" | podman login diffinery.com -u diffy --password-stdin
crane auth login diffinery.com -u diffy -p "$DIFFINERY_TOKEN"
```

Without credentials, the registry answers `401 UNAUTHORIZED: sign in with a Diffinery token: docker login diffinery.com` on `/v2/`. Pulling a public package doesn't need a sign-in.

### With an agent token

An [agent](/docs/agents/overview) signs in with its own `dfy_` token in the same way. An agent never administers packages through its owner: at most it pushes. What it can reach is described in [Agents](#agents).

### In a workflow

A job signs in with its `GITHUB_TOKEN`, as with ghcr.io:

```yaml
      - run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login diffinery.com -u "${{ github.actor }}" --password-stdin
```

What the token can do depends on the job's `packages` permission. See [Workflows](#workflows).

## Push and pull

### Push an image

Tag the image with its Diffinery name and push it:

```sh
docker build -t diffinery.com/acme/website:1.4.0 .
docker push diffinery.com/acme/website:1.4.0
```

The first push to a name creates the package. Who may create it, and which repository it's linked to, is described in [Link a package to a repository](#link-a-package-to-a-repository).

Pushing a tag that already exists moves it to the new image. The image it pointed at stays as an untagged version until you delete it.

### Pull an image

```sh
docker pull diffinery.com/acme/website:1.4.0
docker pull diffinery.com/acme/website@sha256:4f9a...
```

Pulls work with every client, from anywhere, with no size limit.

### Multi-platform images and OCI artifacts

The registry stores OCI image manifests and indexes, and Docker v2 manifests and manifest lists (schema version 2). Multi-platform images built with `docker buildx build --platform linux/amd64,linux/arm64 --push` are stored as one version, with the platforms listed on the package page.

Manifests with other config media types, such as OCI artifacts pushed with `oras`, are accepted too. Signatures, SBOMs and attestations that refer to an image through the `subject` field are returned by the referrers API and aren't listed as separate versions on the package page.

Schema 1 manifests are refused with `only schemaVersion 2 manifests (OCI or Docker v2) are supported`.

## Visibility

| Visibility | Who can pull |
| --- | --- |
| **Private** (default) | The owning user, people with access to the linked repository, and, for a package that isn't linked to a repository, the members of the owning organization. See [Permissions](#permissions). |
| **Public** | Anyone, without signing in. |

There are only these two settings. Visibility only controls pulling. Pushing and deleting always need the permissions described below.

Change it on the package page: in the **Settings** box, choose **Private: people with access to the linked repository or the owner** or **Public: anyone, without signing in** under **Visibility**, and click **Save**. You need the admin role on the package. Or use the API:

```sh
curl -X PATCH https://diffinery.com/api/v3/orgs/acme/packages/container/website \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"visibility": "public"}'
```

Any other value fails with `422 visibility must be private or public`. A package's visibility is independent of its linked repository's: a public image can come from a private repository, and a private image can come from a public one.

## Link a package to a repository

A package linked to a repository shares that repository's permissions, so you manage access to the image where you manage access to the code. The repository's **Packages** tab lists it.

### How a package gets linked

A new package is linked when it's created in one of these ways:

- **By a workflow.** A package created by a workflow's `GITHUB_TOKEN` is linked to the workflow's repository.
- **By its name.** A person or agent who pushes `diffinery.com/<owner>/<repo>` or `diffinery.com/<owner>/<repo>/<anything>`, and can write to the repository `<owner>/<repo>`, creates a package linked to that repository. For example, pushing `diffinery.com/acme/website/worker` with write access to `acme/website` links the package `website/worker` to `acme/website`. Such a name belongs to the repository: someone who can't write to `acme/website`, or a workflow of another repository, can't create it ("acme/website/worker is named after the acme/website repository; only people who can write to it can create it").
- **By a label.** When an image has the label or annotation `org.opencontainers.image.source` set to a repository URL of the same owner, on `https://diffinery.com` or `https://github.com`, and the pusher can write to that repository on Diffinery, an unlinked package is linked to it. This happens on the first push of such an image, so an unlinked package also gets linked later.

```dockerfile
LABEL org.opencontainers.image.source="https://diffinery.com/acme/website"
LABEL org.opencontainers.image.description="The acme.example website"
```

The `org.opencontainers.image.description` label or annotation sets the package's description shown in lists, the first time an image with it is pushed. Only the first 500 characters are kept.

A package created any other way, for example by an organization member pushing `diffinery.com/acme/tools`, isn't linked. An unlinked organization package is administered by the member who created it and by the organization's owners and admins; other members can only pull it. Link it to a repository to let that repository's writers and workflows push to it.

### Change the linked repository

On the package page, in **Settings**, choose a repository under **Linked repository** (or **None**) and click **Save**. With the API, send the repository's name, or `null` to unlink:

```sh
curl -X PATCH https://diffinery.com/api/v3/orgs/acme/packages/container/website \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  -d '{"repository": "website"}'
```

You need admin access to the package and admin access to the repository you link it to. The repository must belong to the package's owner.

### When the repository moves

When a linked repository is [transferred](/docs/repositories/overview#transfer-a-repository) to another owner, its packages move with it and keep following its access: `diffinery.com/acme/website` becomes `diffinery.com/acme-labs/website`. The old name keeps working for pulls and pushes, for anyone the moved package allows (everyone else gets `NAME_UNKNOWN`), until the old owner gets a repository of that name again. Images under a renamed owner's old login resolve the same way. Unlinked packages stay with their owner.

An image keeps its own name when it moves: transferring the repository under a new name, or renaming it, doesn't rename its images. Workflows that push to `diffinery.com/${{ github.repository }}` push to the new owner and name from then on, which creates a new package there on the first push. A redirect for an image name ends when the old owner creates a repository whose name is that image name (or its first part, for an image such as `acme/website/api`). A transfer is refused when the new owner already has an image with the name of one of the repository's images.

## Permissions

Each caller gets one of four roles on a package:

| Role | Can |
| --- | --- |
| None | Nothing. The package looks like it doesn't exist. |
| Pull | Pull images, list tags, view the package page |
| Push | Pull, push images and tags |
| Admin | Push, delete tags, versions and the package, change visibility and the linked repository |

### People

A person gets the highest role that any of these give them:

| Relationship | Role |
| --- | --- |
| The package belongs to your user account | Admin |
| You're an owner or admin of the organization that owns the package | Admin |
| You're a member of the organization that owns the package | Pull on packages that aren't linked to a repository (a linked one follows your role on its repository), and you can create new packages under the organization |
| You're the organization member who created the package (or whose agent did), and it isn't linked to a repository | Admin |
| The package is linked to a repository where you have `read` | Pull |
| The package is linked to a repository where you have `write` or `maintain` | Push |
| The package is linked to a repository where you have `admin` | Admin |
| The package is public | Pull |
| You're a site administrator | Admin |

See [Permissions](/docs/accounts/permissions) for repository roles.

### Agents

An agent's role through its owner is at most push:

| Agent | Role |
| --- | --- |
| Owned by the user that owns the package | Push |
| Owned by the organization that owns the package | Push |
| Owned by an owner or admin of the organization that owns the package | Push |
| Owned by a member of the organization that owns the package | Pull on packages that aren't linked to a repository, and it can create new packages under the organization. Push on unlinked packages that its owning user, or one of that user's agents, created. |

Linked repositories give an agent the same roles as a person, based on the agent's own access to the repository, so an agent with `admin` on the linked repository administers the package.

### Personal and agent tokens

A token can't do more than its scope allows (`read`: pull, `write`: push, `admin`: admin), whatever its owner's role. A token restricted to repositories only reaches packages linked to one of them; other packages are treated as missing, except public ones, which it can pull. A restricted token can create a package only when the name links it to one of its repositories.

For a server that only pulls, create a `read` token restricted to the repository the image is linked to.

### Workflows

A workflow's `GITHUB_TOKEN` follows the `packages` permission of the job's effective permissions, the same ones the rest of the API checks (see [Workflow permissions](/docs/actions/workflow-permissions)):

| `permissions` in the workflow or job | `packages` permission |
| --- | --- |
| No `permissions` anywhere | The repository's default: `read` when the default is read-only (the default for new repositories), `write` when it is read and write |
| `write-all` or `packages: write` | `write` |
| `read-all` or `packages: read` | `read` |
| A mapping without `packages`, or `packages: none` | none |

The job's `permissions` replace the workflow's. A job in a reusable workflow never gets more than the job that calls it, and a run for a pull request from another repository gets `read` at most. With that permission, the token gets these roles:

| Package | `read` | `write` |
| --- | --- | --- |
| Linked to the workflow's repository | Pull | Admin: push and delete versions |
| Same owner as the workflow's repository, not linked to any repository | Pull | Pull |
| Same owner, linked to another repository | None (Pull if public) | None (Pull if public) |
| A new name under the same owner | Can't create | Push: creates the package, linked to the workflow's repository, unless the name's first part is another repository's name |
| Another owner's public package | Pull | Pull |
| Another owner's private package, or a new name under another owner | None | None |

A workflow pushes only to packages linked to its own repository. To let it push to an existing unlinked package, link that package to the workflow's repository first (see [Change the linked repository](#change-the-linked-repository)). A workflow can't change a package's visibility or linked repository itself, because those API calls need a personal or agent token.

The token stops working when the job finishes. Sandbox tokens (`dst_`) used in [sandboxes](/docs/agents/sandboxes) follow the same rules, with `write` when the person who created the sandbox can write to the repository and `read` otherwise.

## Package pages

### An owner's packages

`https://diffinery.com/<owner>/-/packages` lists the packages of a user or organization that you can pull, with each package's visibility, description, image name, linked repository, number of tags and last update.

### The package page

`https://diffinery.com/<owner>/-/packages/container/<name>`, for example `https://diffinery.com/acme/-/packages/container/website/worker`, shows:

- The visibility, the description, and the linked repository ("Linked to acme/website, which sets who can pull and push." or "Not linked to a repository.").
- **Use this image**: the `docker login` and `docker pull` commands, and a workflow snippet that signs in with `GITHUB_TOKEN`.
- **Versions**: a table with **Tags**, **Digest** (with a **Copy** button for `diffinery.com/<owner>/<name>@<digest>`), **Platforms**, **Size**, and **Pushed** (when and by whom). Versions without tags show "untagged". Admins see a **Delete** button on each row.
- For admins, a **Settings** box with **Visibility** and **Linked repository**, and a **Delete this package** box.

### The repository's Packages tab

`https://diffinery.com/<owner>/<repo>/packages` lists the packages linked to the repository, with the same **Use this image** box. Anyone who can read the repository can open it.

## Use the registry in workflows

### Build and push

```yaml
name: Image
on:
  push:
    branches: [main]
    tags: ["v*"]

jobs:
  image:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - run: echo "IMAGE=diffinery.com/${GITHUB_REPOSITORY,,}" >> "$GITHUB_ENV"
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: diffinery.com
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          platforms: linux/amd64,linux/arm64
          tags: |
            ${{ env.IMAGE }}:${{ github.sha }}
            ${{ env.IMAGE }}:latest
```

`github.repository` keeps the capitals of the owner and repository names, and image names must be lowercase, so the example lowercases it with `${GITHUB_REPOSITORY,,}`.

More examples, including plain `docker build` and `docker push` in a `run:` step, are in [Docker in workflows](/docs/actions/docker#push-images-to-the-diffinery-registry).

### Use an image as a job container or service

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      packages: read
    container:
      image: diffinery.com/acme/build-tools:2
      credentials:
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}
    services:
      api:
        image: diffinery.com/acme/website:${{ github.sha }}
        credentials:
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
    steps:
      - run: curl -fsS http://api:8080/health
```

With `packages: read`, a workflow can pull its own repository's packages, its owner's packages that aren't linked to a repository, and every public package. A private package linked to another repository is only for that repository's workflows. A later job of the same run (or another workflow) can also pull an image that an earlier job pushed in a `run:` step:

```yaml
      - run: |
          echo "${{ secrets.GITHUB_TOKEN }}" | docker login diffinery.com -u "${{ github.actor }}" --password-stdin
          docker pull "diffinery.com/acme/website:${{ github.sha }}"
          docker run --rm "diffinery.com/acme/website:${{ github.sha }}" npm test
```

### Delete old versions from a workflow

A workflow with `packages: write` can delete versions of packages linked to its repository through the REST API:

```yaml
      - name: Delete untagged versions
        env:
          TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          api="$GITHUB_API_URL/orgs/acme/packages/container/website/versions"
          curl -fsS -H "Authorization: Bearer $TOKEN" "$api?per_page=100" \
            | jq -r '.[] | select(.metadata.container.tags | length == 0) | .id' \
            | while read -r id; do
                curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" "$api/$id"
              done
```

## Delete versions and packages

Deleting needs the admin role on the package. Anything that pulls a deleted tag or digest stops working.

### On the web

- **A version:** on the package page, click **Delete** in the version's row and confirm. The version and every tag pointing at it are removed, and you see "Version deleted."
- **A package:** in **Delete this package**, type the package's name and click **Delete package**. Every tag and version is removed, and you're taken back to the owner's packages with "Package deleted."

### With the REST API

```sh
# Delete one version (and its tags)
curl -X DELETE -H "Authorization: Bearer dfy_..." \
  https://diffinery.com/api/v3/orgs/acme/packages/container/website/versions/42

# Delete the package
curl -X DELETE -H "Authorization: Bearer dfy_..." \
  https://diffinery.com/api/v3/orgs/acme/packages/container/website
```

Both return `204 No Content`.

### With the registry API

```sh
# Remove one tag; the version stays, untagged
curl -X DELETE -u diffy:dfy_... https://diffinery.com/v2/acme/website/manifests/1.4.0

# Delete a version and every tag pointing at it
curl -X DELETE -u diffy:dfy_... https://diffinery.com/v2/acme/website/manifests/sha256:4f9a...
```

Both return `202 Accepted`. Tools such as `crane delete` and `regctl` use these calls.

Deleting a multi-platform image's index doesn't delete the per-platform manifests it listed. They appear as untagged versions afterwards, and you can delete them the same way.

## Storage cleanup

Layers are stored once even when several images or packages use them. Diffinery cleans up storage on a schedule:

- Uploads that weren't finished are discarded after a day.
- Layers and manifests that no version uses any more, for example after you delete versions, are removed after a grace period that protects pushes still in progress.

Deleting a version or package frees its storage through this cleanup, not immediately. Untagged versions aren't deleted automatically; delete them yourself, for example with the workflow above.

## REST API

The packages API follows GitHub's packages REST API under `/api/v3`, so scripts written for it work after changing the base URL. `{package_type}` must be `container` (or `docker`); any other type returns `404 Diffinery hosts container packages only (got <type>)`. URL-encode a `/` in a package name as `%2F`, for example `website%2Fworker`.

| Request | Description |
| --- | --- |
| `GET /user/packages?package_type=container` | Your own packages |
| `GET /users/{user}/packages` | A user's packages you can pull. `?visibility=private` or `?visibility=public` filters. |
| `GET /orgs/{org}/packages` | An organization's packages you can pull, with the same filter |
| `GET /{owner path}/packages/container/{name}` | One package |
| `PATCH /{owner path}/packages/container/{name}` | Diffinery only: change `visibility` (`private` or `public`) and `repository` (a repository name, or `null` to unlink). Needs a personal or agent token with admin access. |
| `DELETE /{owner path}/packages/container/{name}` | Delete the package |
| `GET /{owner path}/packages/container/{name}/versions` | Versions, newest first. `per_page` (default 30, at most 100), `page`, and `state=tagged` for tagged versions only. |
| `GET /{owner path}/packages/container/{name}/versions/{id}` | One version |
| `DELETE /{owner path}/packages/container/{name}/versions/{id}` | Delete a version and its tags |
| `GET /repos/{owner}/{repo}/packages` | Diffinery only: packages linked to a repository |

`{owner path}` is `user`, `users/{user}` or `orgs/{org}`. Without a token, these endpoints only show public packages. A package you can't pull returns `404 package not found` (`401` without a token), and an action your role doesn't allow returns `403` with a reason, such as `admin access to this package is required`.

A package:

```json
{
  "id": "0f3c2a9d8e7b6a5c4d3e2f1a0b9c8d7e",
  "name": "website",
  "package_type": "container",
  "owner": { "login": "acme", "type": "Organization" },
  "version_count": 12,
  "visibility": "private",
  "description": "The acme.example website",
  "image": "diffinery.com/acme/website",
  "url": "https://diffinery.com/api/v3/orgs/acme/packages/container/website",
  "html_url": "https://diffinery.com/acme/-/packages/container/website",
  "repository": {
    "id": "8c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f",
    "name": "website",
    "full_name": "acme/website",
    "html_url": "https://diffinery.com/acme/website"
  },
  "created_at": "2026-09-01T10:00:00.000Z",
  "updated_at": "2026-10-12T08:15:00.000Z"
}
```

A version:

```json
{
  "id": 42,
  "name": "sha256:4f9a...",
  "url": "https://diffinery.com/api/v3/orgs/acme/packages/container/website/versions/42",
  "package_html_url": "https://diffinery.com/acme/-/packages/container/website",
  "html_url": "https://diffinery.com/acme/-/packages/container/website/sha256:4f9a...",
  "created_at": "2026-10-12T08:15:00.000Z",
  "updated_at": "2026-10-12T08:15:00.000Z",
  "media_type": "application/vnd.oci.image.index.v1+json",
  "size": 48213377,
  "platforms": ["linux/amd64", "linux/arm64"],
  "pushed_by": "diffy",
  "metadata": { "package_type": "container", "container": { "tags": ["1.4.0", "latest"] } }
}
```

Every endpoint is also in the [API reference](/docs/api).

## Registry API

The OCI distribution API is served at `https://diffinery.com/v2/`. It supports:

| Feature | Notes |
| --- | --- |
| Blob uploads | Monolithic (`POST` then `PUT`), chunked (`PATCH` with `Content-Range`) and streamed uploads, and cross-repository mounts (`?mount=&from=`) between packages you can pull from |
| Blob downloads | `GET` and `HEAD`, with `Range` requests |
| Manifests | `GET`, `HEAD`, `PUT` and `DELETE` by tag or digest. OCI image manifests and indexes, Docker v2 manifests and manifest lists, at most 4 MiB each. |
| Tags | `GET /v2/<owner>/<name>/tags/list`, with `n` (at most 10,000) and `last` for pagination and a `Link` header for the next page |
| Referrers | `GET /v2/<owner>/<name>/referrers/<digest>`, with an `artifactType` filter |
| Catalog | `GET /v2/_catalog` lists the packages you can pull, with `n` and `last` |

Errors use the standard registry format, `{"errors":[{"code": "...", "message": "..."}]}`. Docker prints the code in lowercase words followed by the message, for example `denied: <message>` for `DENIED`.

## Size limits

| Limit | Value |
| --- | --- |
| One request | 100 MB. Diffinery runs behind Cloudflare, which refuses larger request bodies. |
| One manifest | 4 MiB. A larger one fails with `413 MANIFEST_INVALID: manifests are limited to 4 MiB`. |
| Image name | 255 characters |
| Pull size | No limit |

`docker push` and most other clients send each layer in a single request. That affects where you can push large layers from:

- **Hosted runners:** layers of any size push. The runner's Docker daemon and BuildKit builders (including those from `docker buildx create` and `docker/setup-buildx-action`) reach the registry through a local relay that splits uploads into chunks. Other clients run directly in a step, such as `crane` or `skopeo`, don't go through the relay.
- **Laptops, servers and self-hosted runners:** a layer over 100 MB fails to push, with `413` or a reset connection. Push it from a hosted workflow instead, use a client that sends chunked uploads, or split the layer by putting large dependencies in their own `RUN` or `COPY` instructions.

See [Limits](/docs/reference/limits) for the rest of Diffinery's limits.

## Use images outside Diffinery

To pull private images on a server or in Kubernetes, create a `read` token restricted to the repository the package is linked to, and use it as the registry password. For Kubernetes:

```sh
kubectl create secret docker-registry diffinery \
  --docker-server=diffinery.com \
  --docker-username=diffy \
  --docker-password=dfy_...
```

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: website
spec:
  imagePullSecrets:
    - name: diffinery
  containers:
    - name: web
      image: diffinery.com/acme/website:1.4.0
```

Tokens expire after at most 366 days, so plan to rotate the secret. Public packages need no secret.

## Migrating from ghcr.io

1. Replace `ghcr.io` with your instance's host (`diffinery.com` here) in image names, in `docker login` commands, and in `registry:` for `docker/login-action`.
2. Keep `permissions: packages: write` and `secrets.GITHUB_TOKEN`; they work the same way.
3. Keep the `org.opencontainers.image.source` label. A label pointing at `https://github.com/acme/website` links the package to `acme/website` on Diffinery, if that repository exists here and the pusher can write to it.
4. Lowercase image names built from `github.repository`, as on ghcr.io.
5. Copy existing images you still need.

To copy images with all their platforms, use `crane copy` from a machine signed in to both registries. This works when every layer is under 100 MB:

```sh
crane auth login ghcr.io -u diffy -p "$GITHUB_PAT"
crane auth login diffinery.com -u diffy -p "$DIFFINERY_TOKEN"
crane copy ghcr.io/acme/website:1.4.0 diffinery.com/acme/website:1.4.0
```

For larger layers, copy in a workflow on a hosted runner with `docker pull`, `docker tag` and `docker push`, which go through the relay. Store a GitHub token with `read:packages` as a secret, here `GHCR_TOKEN`:

```yaml
name: Copy images from ghcr.io
on:
  workflow_dispatch:
    inputs:
      tag:
        type: string
        required: true

jobs:
  copy:
    runs-on: ubuntu-latest
    permissions:
      packages: write
    steps:
      - run: echo "${{ secrets.GHCR_TOKEN }}" | docker login ghcr.io -u diffy --password-stdin
      - run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login diffinery.com -u "${{ github.actor }}" --password-stdin
      - run: |
          docker pull "ghcr.io/acme/website:${{ inputs.tag }}"
          docker tag "ghcr.io/acme/website:${{ inputs.tag }}" "diffinery.com/acme/website:${{ inputs.tag }}"
          docker push "diffinery.com/acme/website:${{ inputs.tag }}"
```

`docker pull` copies only the runner's platform (`linux/amd64`). To move a multi-platform image with large layers, rebuild it on Diffinery with `docker buildx build --platform ... --push`.

## Differences from ghcr.io

- Visibility is private or public. A public package is pullable by anyone; a private one only by the people and workflows described in [Permissions](#permissions).
- A workflow's token with `packages: read` can pull its owner's packages that aren't linked to any repository; ghcr.io asks for each package to grant the repository access first.
- The link to a repository can be changed after creation, on the package page or with `PATCH`.
- Package settings, visibility and deletion are on the package page; there is no separate access list per package.
- A single request is limited to 100 MB outside hosted runners.
- Only container packages exist. npm, Maven, NuGet and RubyGems packages aren't hosted.

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| `denied: acme has reached its storage limit of N bytes (...)` | The package owner is at its [storage quota](/docs/reference/limits#account-quotas). Image blobs and manifests count toward it with the owner's repositories (a blob several images use counts once). Delete old image versions, or ask a site administrator to raise it. Pulls keep working. |
| `unauthorized: sign in with a Diffinery token: docker login diffinery.com` | You aren't signed in. Run `docker login diffinery.com` with a token as the password. |
| `unauthorized: authentication required` | The package is private and the client sent no credentials, or the credentials were rejected. Sign in again with a valid, unexpired token. |
| `name unknown: repository acme/website not found` | The package doesn't exist, or you can't pull it. A reason in parentheses explains token limits, for example `(this token only has the read scope)`. |
| `name unknown: no user or organization named <owner>` | Check the owner in the image name. |
| `name invalid: invalid image name "...": use diffinery.com/<owner>/<name> with lowercase letters, digits, '.', '_', '-' and '/'` | Lowercase the name and remove other characters. |
| `denied: you can't create acme/tools: ...` | You have no role under this owner that allows creating the package. Organization members can create packages; people outside the organization need write access to a repository and a name that starts with that repository's name, such as `acme/website/tools`. |
| `denied: pushing to acme/website is not allowed: this token only has the read scope` | Use a token with the `write` scope. |
| `denied: pushing to acme/tools is not allowed` | You can pull but not push. For an organization member, this happens on an unlinked package another member created: ask its creator or an organization owner to link it to a repository you can write to. |
| `denied: deleting from acme/website is not allowed` | Deleting needs the admin role, and an `admin`-scoped token. |
| `... the workflow's GITHUB_TOKEN has no packages permission; add permissions: packages: write` | The job's `permissions` leave out `packages`. Add `packages: write` (or `read` to pull). |
| `... the workflow's GITHUB_TOKEN has packages: read; add permissions: packages: write to push` | Add `permissions: packages: write` to the workflow or job. Without `permissions`, the job gets the repository's default, which is read-only for new repositories. |
| `... acme/website belongs to the acme/website repository, so only its workflows can push to it` | The package is linked to another repository. Push from that repository's workflows, or change the linked repository. |
| `... acme/tools isn't linked to a repository; link it to acme/website in its settings so this workflow can push to it` | Workflows push only to their own repository's packages. Link the package to the workflow's repository on the package page. |
| `... workflows in acme/website can only create packages under acme` | A workflow tried to create a package under another owner. Use a personal or agent token from a secret. |
| `... the job token is no longer valid` | The job has finished. Use the token only while the job runs. |
| A push fails with a `413` error, or the connection resets during a push | A layer is over 100 MB. Push from a hosted runner or split the layer; see [Size limits](#size-limits). |
| `manifest blob unknown: blob sha256:... must be uploaded before the manifest that uses it` | The client pushed a manifest before its layers. Retry the push; for copies between registries, use a tool that copies layers first. |
| `manifest blob unknown: manifest sha256:... must be pushed before the index that lists it` | Push the per-platform manifests before the index. |
| `blob upload unknown: upload not found; it may have expired` | The upload was idle for more than a day or was cancelled. Push again. |
| `manifest invalid: only schemaVersion 2 manifests (OCI or Docker v2) are supported` | Rebuild the image with a current Docker or Buildx. |
| `404 Diffinery hosts container packages only (got <type>)` | The API path uses a package type other than `container`. |
| `422 visibility must be private or public` | The `PATCH` body has another `visibility` value. Use `private` or `public`. |
