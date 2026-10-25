---
title: Docker in workflows
description: Run jobs in containers, start service containers, use Docker container actions, and build and push images from Diffinery workflows.
---

Diffinery workflows support Docker the same way GitHub Actions does: a job can run inside a container image, start service containers such as databases next to it, use actions packaged as Docker images, and run `docker build`, `docker run` and `docker compose` in steps. This page covers each feature, the differences from GitHub, and complete examples.

## Where Docker is available

| Runner | Docker |
|---|---|
| Hosted (`runs-on: ubuntu-latest` and other hosted labels) | Always available. The Docker daemon starts the first time the job uses it. |
| Self-hosted (`runs-on: [self-hosted, ...]`) | Available when the machine has Docker installed and running, with the `docker` CLI on the runner's `PATH`. |

On hosted runners:

- The `docker` command starts the daemon on first use and prints `Starting the Docker daemon`. Jobs that never use Docker don't start it. A job that will use Docker (a job `container:`, `services:`, a `docker://` action, or a step whose `uses:` or `run:` names `docker`) gets the daemon started in the background as the job begins, so it is usually ready by the time checkout and setup are done. A docker command that has waited over 2 minutes for another one to start the daemon fails the step with `The Docker daemon did not start:` instead of hanging.
- Docker Hub images are pulled through the registry mirror `https://mirror.gcr.io`, which avoids Docker Hub's anonymous pull limits for official images. Images the mirror doesn't have come from Docker Hub directly.
- Containers use the DNS servers `1.1.1.1` and `8.8.8.8`.
- Bridge networks, service names, port publishing and image builds all work, as on GitHub's hosted runners.

See [Runners](/docs/actions/runners) for the hosted image and for setting up Docker on a self-hosted runner.

## Job containers

`jobs.<id>.container` runs the job's steps inside a container instead of directly on the runner.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: node:22-bookworm
      env:
        NODE_ENV: test
      options: --cpus 1
    steps:
      - uses: actions/checkout@v4
      - run: node --version && npm ci && npm test
```

`container` is either an image name (`container: node:22`) or a mapping:

| Key | Description |
|---|---|
| `image` | Image to run. Expressions are allowed. If it evaluates to an empty string, the job runs without a container. |
| `credentials.username`, `credentials.password` | Registry login for a private image. Both are required when either is set ("Registry credentials for IMAGE need both a username and a password."). The password is masked in logs. |
| `env` | Environment variables for the container. |
| `ports` | Ports to publish, as for `docker run -p`. |
| `volumes` | Volumes to mount, as for `docker run -v`. |
| `options` | Extra `docker run` options, as one string. `--network` is not allowed. |

How it works:

1. In the "Initialize containers" section of the job log, Diffinery creates a bridge network for the job, starts any service containers, pulls the image and starts the job container on that network.
2. The container's entrypoint is replaced with `tail -f /dev/null` to keep it running, so **the image needs a `tail` command** (almost every Linux image has one). If it exits right away, the job fails with "The job container (IMAGE) exited right after starting. The image needs a 'tail' command to stay up."
3. The runner's work directory is mounted into the container at the same path, so `GITHUB_WORKSPACE`, `$GITHUB_OUTPUT`, `$GITHUB_ENV` and the other file commands work unchanged. `HOME` is `/github/home` inside the container.
4. Each `run:` step is executed with `docker exec` in the container, with the step's environment. The default shell is `bash` if the image has it, otherwise `sh`. `PATH` comes from the image unless the workflow sets `PATH`.
5. JavaScript actions run inside the container with the runner's own Node.js binary, mounted at `/__e/node`. That binary needs glibc, so JavaScript actions don't work in musl-based images such as Alpine (the same limitation GitHub has).
6. The built-in actions (`actions/checkout`, `actions/cache`, `actions/upload-artifact`, `actions/download-artifact`, `actions/setup-node`, `actions/setup-python`, `actions/setup-go`) run on the runner itself and work on the shared workspace. When the runner uses the real action instead (for a version or input the built-in doesn't cover, see [Compatibility with GitHub Actions](/docs/actions/compatibility#built-in-actions)), it runs like any other JavaScript action, inside the container.
7. The Docker socket is mounted into the job container when the runner has one at `/var/run/docker.sock`, so a step in the container can use Docker if the image includes the `docker` CLI.
8. When the job ends, every container the job started and its network are removed.

The `job.container` context has `id` and `network`.

## Service containers

`jobs.<id>.services` starts containers next to the job, for databases, caches and other dependencies your tests need. Each key is the service's name.

```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_PASSWORD: postgres
    ports: ["5432:5432"]
    options: --health-cmd "pg_isready -U postgres" --health-interval 2s --health-retries 30
```

Each service takes the same keys as a job container (`image`, `credentials`, `env`, `ports`, `volumes`, `options`). A service whose `image` evaluates to an empty string is skipped, as on GitHub, which lets you turn a service on or off with an expression.

### Reaching a service

How a step reaches a service depends on where the step runs:

| The job... | Reach the service at | Notes |
|---|---|---|
| Has a `container:` | `<service name>:<container port>`, for example `postgres:5432` | Every container of the job joins one network, and each service is registered under its key as a network alias. No `ports` needed. |
| Has no `container:` (steps run on the runner) | `localhost:<published port>` | Publish the port with `ports`. `"5432:5432"` publishes on the same port; `"5432"` picks a free host port, which you read from `job.services.<name>.ports['5432']`. |

```yaml
- run: redis-cli -p ${{ job.services.redis.ports['6379'] }} ping
```

The `job.services.<name>` context has `id`, `network` and `ports` (a map from container port to host port). The job log lists the mappings, for example `Service redis is running (6379 -> localhost:32768)`.

### Health checks

If a service image (or its `options`, through `--health-cmd`) defines a Docker health check, Diffinery waits for the service to become healthy before running the first step, checking with increasing intervals for up to 15 minutes. Services without a health check are considered ready as soon as they start. The job fails when one of these happens (for the first two, the log shows the last 50 lines of the service's output):

| Message | Meaning |
|---|---|
| `Service container NAME failed its health check.` | Docker marked the container unhealthy. |
| `Service container NAME exited before it became healthy.` | The container stopped, for example because of a bad environment variable. |
| `Service container NAME did not become healthy in time (status: starting).` | It was still starting after 15 minutes. |

Add a health check to every service your tests connect to straight away; without one, the first step can start before the database accepts connections.

### The --network option

Every container of a job shares one network, so `--network` (or `--net`) in `options` is rejected:

```text
services.cache: the --network option is not supported; every container of the job shares one network.
```

## Docker container actions

Two kinds of steps run an action in its own container:

- `uses: docker://IMAGE` runs a public or mirrored image directly.
- An action whose `action.yml` has `runs.using: docker`, with `runs.image` set to a `Dockerfile` in the action (built for the job) or to `docker://IMAGE`. An action directory with a `Dockerfile` and no `action.yml` is treated the same way.

```yaml
steps:
  - uses: actions/checkout@v4
  # An image straight from a registry; `args` and `entrypoint` drive the container.
  - uses: docker://alpine:3.20
    with:
      entrypoint: /bin/sh
      args: -c "ls -la /github/workspace"
  # A Docker action in this repository (./.github/actions/lint/action.yml + Dockerfile).
  - uses: ./.github/actions/lint
    with:
      strict: true
```

```yaml
# .github/actions/lint/action.yml
name: Lint
inputs:
  strict:
    default: "false"
runs:
  using: docker
  image: Dockerfile
  args:
    - --strict=${{ inputs.strict }}
```

Behaviour, matching GitHub's:

- For `docker://` steps, `with.args` is split like a shell command line into the container's arguments and `with.entrypoint` replaces its entrypoint. Any other `with` keys become `INPUT_<NAME>` environment variables.
- For `runs.using: docker` actions, inputs become `INPUT_<NAME>` variables, and `runs.args`, `runs.env`, `runs.entrypoint`, `runs.pre-entrypoint`, `runs.post-entrypoint`, `runs.pre-if` and `runs.post-if` are honoured.
- A `Dockerfile` action is built with `docker build` before it runs. A build failure fails the step with "Building the action's Dockerfile failed (exit code N)."
- The action container runs on the job's network with the workspace mounted at `/github/workspace` (the working directory and `GITHUB_WORKSPACE`), `HOME` at `/github/home`, and the runner's temp directory mounted so `$GITHUB_OUTPUT` and the other file commands work. The Docker socket is mounted when the runner has one.
- A non-zero exit fails the step with "Docker run failed with exit code N".

Remote Docker actions (`uses: owner/repo@ref`) are downloaded from github.com, like other remote actions.

## docker build, run and compose in steps

On hosted runners the full Docker CLI is installed with the Buildx and Compose plugins, so ordinary commands work in `run:` steps:

```yaml
jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t website:test .
      - run: docker run --rm website:test npm test
      - run: docker compose -f compose.test.yml up -d --wait
      - run: ./scripts/integration-tests.sh
      - if: always()
        run: docker compose -f compose.test.yml logs && docker compose -f compose.test.yml down -v
```

`docker/setup-buildx-action`, `docker/login-action`, `docker/metadata-action` and `docker/build-push-action` also work. On hosted runners, `docker buildx create` with the `docker-container` driver (what `docker/setup-buildx-action` runs) starts BuildKit on the host network and registers it as a remote builder, because the regular driver can't run inside a Cloudflare Container. You don't need to change your workflow for this.

BuildKit's `type=gha` cache works with `docker/build-push-action`. The action runs with the job's cache service credentials and hands them to BuildKit, and the layers are stored in the repository's Actions cache, with the same scope, size limit and eviction as `actions/cache`. See [Caching and artifacts](/docs/actions/caching-and-artifacts).

```yaml
- uses: docker/setup-buildx-action@v3
- uses: docker/build-push-action@v6
  with:
    context: .
    push: false
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

> **Note:** The cache service credentials (`ACTIONS_RUNTIME_TOKEN` and `ACTIONS_RESULTS_URL`) are given only to JavaScript actions, Docker container actions and the built-in actions, never to `run:` steps. `docker buildx build --cache-to type=gha` in a `run:` step has no credentials, so use `docker/build-push-action` for the gha cache.

## Push images to the Diffinery registry

Diffinery hosts a container registry at the instance's own address (`diffinery.com` here), in place of ghcr.io. A workflow signs in with its own `GITHUB_TOKEN`; the job's `packages` permission decides what the token can do:

| `permissions` in the workflow or job | `GITHUB_TOKEN` can |
|---|---|
| No `permissions` block | What the repository default allows: pull for repositories with the `read` default (the default for new repositories), push and pull for those with `write` |
| `write-all`, or `packages: write` | Push and pull |
| `packages: read`, or `read-all` | Pull |
| A mapping without `packages` | Nothing |

A job's own `permissions:` replaces the workflow's. To push from a repository with the `read` default, add `packages: write` to the job or the workflow. See [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions).

With write, the token pushes only to packages linked to the workflow's own repository, and creates new packages under the repository's owner (linked to the repository). Other packages of the same owner, including ones that aren't linked to any repository, are pull-only for it.

Image names are `diffinery.com/<owner>/<name>` and must be lowercase. `github.repository` keeps the owner's and repository's capitals, so lowercase it in a shell step with `${GITHUB_REPOSITORY,,}`.

On hosted runners, image layers of any size push, because the Docker daemon and BuildKit builders reach the registry through a relay that splits large uploads. Self-hosted runners don't have the relay, so from them (as from a laptop or a server) a layer larger than 100 MB fails to push.

The registry, its permissions and its API are documented in [Container registry](/docs/packages/container-registry).

## Examples

### Postgres service for tests

Steps run on the runner and reach Postgres on `localhost`:

```yaml
name: Test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: website_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 2s
          --health-timeout 5s
          --health-retries 30
    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/website_test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run db:migrate
      - run: npm test
```

The same job in a container reaches the service by name instead:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    container: node:22-bookworm
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        options: --health-cmd "pg_isready -U postgres" --health-interval 2s --health-retries 30
    env:
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/postgres
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test
```

### Redis with a random host port

```yaml
jobs:
  cache-tests:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7-alpine
        ports: ["6379"]
        options: --health-cmd "redis-cli ping" --health-interval 1s --health-retries 30
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test
        env:
          REDIS_URL: redis://localhost:${{ job.services.redis.ports['6379'] }}
```

### Build and push an image on every push to main

With plain Docker commands:

```yaml
name: Image
on:
  push:
    branches: [main]

jobs:
  image:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - name: Sign in to the Diffinery registry
        run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login diffinery.com -u "${{ github.actor }}" --password-stdin
      - name: Build and push
        run: |
          image="diffinery.com/${GITHUB_REPOSITORY,,}"
          docker build -t "$image:${{ github.sha }}" -t "$image:latest" .
          docker push "$image:${{ github.sha }}"
          docker push "$image:latest"
```

With the `docker/*` actions most ghcr.io workflows use:

```yaml
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
          tags: ${{ env.IMAGE }}:${{ github.sha }}
```

A later job (or another workflow of the same owner) can use the image as its job container:

```yaml
  smoke:
    needs: image
    runs-on: ubuntu-latest
    permissions:
      packages: read
    container:
      image: diffinery.com/acme/website:${{ github.sha }}
      credentials:
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}
    steps:
      - run: /app/healthcheck
```

A deploy job can then hand the image to your platform, using credentials stored as [environment](/docs/actions/environments) secrets so that only allowed branches reach them. The job records a deployment of the commit to `production`:

```yaml
  deploy:
    needs: smoke
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://www.example.com
    steps:
      - name: Tell the platform to roll out the new image
        env:
          DEPLOY_HOOK_URL: ${{ secrets.DEPLOY_HOOK_URL }}
        run: curl -fsS -X POST "$DEPLOY_HOOK_URL" -d "image=diffinery.com/acme/website:${{ github.sha }}"
```

## Troubleshooting

| Message | Fix |
|---|---|
| `... need Docker, and this runner has no docker CLI.` | The self-hosted runner has no `docker` on its `PATH`. Install Docker, or run the job on a hosted runner. |
| `... need Docker, and the Docker daemon on this runner is not reachable: ...` | Start the Docker daemon on the self-hosted machine, and make sure the runner's user may use it. |
| `The Docker daemon did not start:` | A hosted runner couldn't start Docker. Re-run the job; if it keeps failing, report the log lines that follow. |
| `Could not pull IMAGE (docker pull exited with N).` | The image name or tag is wrong, or it's private and needs `credentials`. |
| `The job container (IMAGE) exited right after starting.` | The image has no `tail` command, or its startup fails. Use an image with a shell and coreutils. |
| `Service container NAME failed its health check.` | Check the service log printed above the error, usually a missing environment variable such as `POSTGRES_PASSWORD`. |
| `the --network option is not supported` | Remove `--network` from `options`. Services are already on the job's network. |
| A JavaScript action fails inside an Alpine job container | The runner's Node.js needs glibc. Use a Debian or Ubuntu based image, or run the action outside the container. |
| A registry error ending in `the workflow's GITHUB_TOKEN has no packages permission; add permissions: packages: write` | The job's `permissions` mapping leaves out `packages`. Add `packages: write` to push, or `packages: read` to pull. |
| A push fails with a registry error ending in `the workflow's GITHUB_TOKEN has packages: read; add permissions: packages: write to push` | The job has only read access to packages, often because it has no `permissions:` and the repository default is `read`. Add `packages: write`. |
