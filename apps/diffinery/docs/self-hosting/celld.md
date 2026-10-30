---
title: Run on celld
description: Run Diffinery outside Cloudflare on celld, the open-source Workers and Durable Objects runtime. What runs, what is left out, the gaps to know, and the commands to deploy a fleet.
updated: 2026-10-31
---

Diffinery is built for Cloudflare, and the same code also targets [celld](https://celld.dev), the open-source (Apache-2.0) implementation of Workers and Durable Objects that the Deno team built and that is now part of Cloudflare. celld runs a Worker on your own machines, with an S3, Google Cloud Storage or Azure Blob bucket as its only outside dependency. If you ever need to leave Cloudflare, or run Diffinery where Cloudflare isn't an option, you keep the same repository, the same `wrangler.jsonc` and the same data model.

> **Status.** celld is beta and its Containers support is experimental. On October 31, 2026, Diffinery ran on a one-node celld 0.6.3 fleet: it applied the D1 migrations and served the web UI, docs, REST, GraphQL and MCP. git push (with a 6 MB object), clone, shallow clone and fetch worked, as did issues, pull requests and squash merge, archives, profile pictures and the event queues, and pushes started workflow runs. Hosted runners and sandboxes, which need celld's containers, were not tested, and the end-to-end test suite doesn't run on celld yet. The unit tests check on every run that Diffinery stays inside what celld supports (see [How compatibility is kept](#how-compatibility-is-kept)).

## What runs on celld

| Diffinery uses | On Cloudflare | On celld |
| --- | --- | --- |
| The Worker: web UI, REST and GraphQL APIs, git over HTTPS, MCP server | Workers | Workers, with `nodejs_compat` |
| One Durable Object per repository, with SQLite, alarms and hibernating WebSockets (`REPO`, `PROJECT`, `SCHEDULER`, `COMPOSE`) | Durable Objects | Cells, distributed across the fleet |
| Accounts, organizations, tokens (`DB`) | D1 | D1, one cell per database, no read replicas |
| Git objects, LFS, logs, caches, artifacts, release assets (`BUCKET`) | R2 | R2, stored under `r2/diffinery-data/` in the fleet bucket |
| Webhooks, notifications and email jobs (`EVENTS`, `MAIL`) | Queues | Queues, with retries and dead-letter queues |
| Workflow runs, imports, account exports (`RUN_WORKFLOW`, `IMPORT_WORKFLOW`, `ACCOUNT_WORKFLOW`) | Workflows | Workflows |
| Housekeeping every 5 minutes | Cron Triggers | Cron Triggers, one run per occurrence across the fleet |
| Hosted runners, sandboxes and the import container | Containers | Containers (experimental), on Docker or Podman on each node |

## What is left out

`celld deploy` stops on a `wrangler.jsonc` key it doesn't know. `scripts/celld-config.mjs` writes `apps/diffinery/wrangler.celld.jsonc` from `wrangler.jsonc` without these keys, and Diffinery runs without each of them:

| `wrangler.jsonc` key | Binding | What happens on celld |
| --- | --- | --- |
| `routes`, `workers_dev` | | celld has no managed ingress. Put a reverse proxy that terminates TLS in front of the fleet. |
| `send_email` | `EMAIL` | Emails are logged as skipped, not sent. **Settings → Email** (`/settings/admin/email`) shows "not configured (no EMAIL binding)". Invitation links are still shown to the person who invites, with a copy button. |
| `ratelimits` | `RL_AUTH`, `RL_ANON`, `RL_ACCOUNT`, `RL_CREATE`, `RL_MODEL` | Requests are not rate limited. Limit them in your proxy. |
| `version_metadata` | `CF_VERSION_METADATA` | IndexNow hashes the site's pages at every check instead of once per deployed version. |
| `observability`, `upload_source_maps`, `limits` | | Logs go to each node's output, and stack traces point into the bundle. |

The script also drops the container keys celld doesn't take (`image_build_context`, `rollout_active_grace_period`, `rollout_step_percentage`); celld builds the runner image in the Dockerfile's directory, `containers/runner`, which is the same context.

## Gaps to know

- **The first administrator.** The first sign-in is at `/auth/access` through Cloudflare Access, or through open sign-up's emailed code. On celld there is no email, so either put the fleet behind a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) with an Access application on `/auth/access` and set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, or wait for a non-Cloudflare email transport. After that, the administrator invites people and sends them the link shown under "Invite created for …"; passkey sign-in needs neither Access nor email.
- **Client IP addresses.** Diffinery reads the client's address from the `CF-Connecting-IP` header. Cloudflare sets it; on celld your proxy must set it, and must replace any value the client sent, or a client can pick its own address.
- **Request location.** Requests carry no Cloudflare location, so the CLI sign-in page can't compare countries, and `Server-Timing` has no location.
- **`EGRESS=web`.** Limiting hosted jobs to HTTP and HTTPS needs Cloudflare Containers' outbound interception, which celld doesn't have. `scripts/celld-config.mjs` refuses `EGRESS=web`. Note that celld's own network fence blocks containers from the node, private ranges and link-local addresses.
- **Containers.** Each node that runs jobs needs Docker or Podman, and the `celld-fence` container that celld starts. celld doesn't enforce disk sizes, and moving a cell to another node stops its container.
- **Platforms.** celld runs on Linux x86-64, Linux ARM64 and Apple Silicon, not Windows.

## Deploy a fleet

You need the celld binary ([install](https://celld.dev)) on every node, a bucket, and Node.js 22 and pnpm 10 on the machine you deploy from. `celld deploy` bundles the Worker with esbuild, which `pnpm install` puts in `apps/diffinery/node_modules/.bin`.

1. Build what the Worker imports (web islands and docs):

   ```sh
   pnpm install
   pnpm -r build
   ```

2. Create the Worker's secrets once and keep them. `celld deploy` has no secret store, so `scripts/celld-config.mjs` copies `MASTER_KEY`, `MASTER_KEY_PREV`, `OIDC_PRIVATE_KEY`, `MAIL_EVENTS_SECRET`, `TURNSTILE_SECRET`, `GITHUB_OAUTH_CLIENT_SECRET`, `SANDBOX_POOL_SECRET`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_WEBHOOK_SECRET` from the environment into the Worker's variables. Never change `MASTER_KEY` once it is in use.

   ```sh
   export MASTER_KEY="$(openssl rand -base64 32)"
   export OIDC_PRIVATE_KEY="$(node --input-type=module -e '
     const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
     const jwk = await crypto.subtle.exportKey("jwk", k.privateKey);
     jwk.kid = "diffinery-" + new Date().toISOString().slice(0, 10);
     process.stdout.write(JSON.stringify(jwk));')"
   ```

3. Write the celld configuration for your hostname:

   ```sh
   node scripts/celld-config.mjs --public-url https://git.example.com --var BOOTSTRAP_ADMINS=you@example.com
   ```

   It writes `apps/diffinery/wrangler.celld.jsonc`, readable by you only and ignored by git, and lists what it left out. `--var NAME=VALUE` sets any [Worker variable](/docs/self-hosting/configuration#worker-variables); repeat it. Set `RUNNER_IMAGE` to an image already in a registry to skip building the runner image.

4. Deploy, start the nodes, then apply the D1 migrations, which need a live node:

   ```sh
   cd apps/diffinery
   PATH="$PWD/node_modules/.bin:$PATH" celld deploy wrangler.celld.jsonc --bucket s3://your-bucket
   celld --bucket s3://your-bucket --listen 0.0.0.0:8080 --internal-listen 10.0.0.5:8081 --advertise 10.0.0.5:8081
   celld d1 migrations apply diffinery wrangler.celld.jsonc --bucket s3://your-bucket
   ```

   Run the second command on every node, with that node's private address. Put your proxy in front of the `--listen` ports. The deployment, including the variables, lives in the bucket, so give its credentials to fleet administrators only.

To update, pull the repository, run steps 1, 3 and 4 again with the same secrets, and apply new migrations.

## Try it locally

`celld dev` serves a Worker from local storage, but the `celld d1` commands need a real bucket, so `celld dev` can't apply Diffinery's D1 migrations. To try Diffinery, run a one-node fleet on [Azurite](https://github.com/Azure/Azurite), Microsoft's Azure Blob Storage emulator, which celld supports for development. Render the `dev` environment, which has no containers and signs everyone in as `dev@diffinery.local`, with `PUBLIC_URL` set to the address you'll open:

```sh
docker run -d --name azurite -p 10000:10000 mcr.microsoft.com/azure-storage/azurite   azurite-blob --blobHost 0.0.0.0 --disableProductStyleUrl
az storage container create --name fleet --connection-string "UseDevelopmentStorage=true"
export AZURE_STORAGE_USE_EMULATOR=true AZURITE_BLOB_STORAGE_URL=http://127.0.0.1:10000
pnpm -r build
MASTER_KEY="$(openssl rand -base64 32)" node scripts/celld-config.mjs --env dev --var PUBLIC_URL=http://localhost:8080
cd apps/diffinery
PATH="$PWD/node_modules/.bin:$PATH" celld deploy wrangler.celld.jsonc --bucket az://fleet
celld --bucket az://fleet --listen 127.0.0.1:8080 --internal-listen 127.0.0.1:8081 --advertise 127.0.0.1:8081 &
celld d1 migrations apply diffinery-dev wrangler.celld.jsonc --bucket az://fleet
```

Then open `http://localhost:8080`. The dev sign-in works only while `PUBLIC_URL` and the request are on your own machine. celld doesn't qualify Azurite for a production fleet.

## How compatibility is kept

`apps/diffinery/test/unit/celld.test.ts` runs with the unit tests on every pull request. It fails when:

- `wrangler.jsonc` gets a key that `scripts/celld-config.mjs` doesn't map, so a new Cloudflare-only setting must say what happens on celld;
- a binding the script leaves out isn't optional in the Worker's `Env` (`CELLD_ABSENT_BINDINGS` in `src/env.ts`, checked by the typecheck);
- the Worker's code imports a built-in module celld doesn't provide (only `cloudflare:workers`, `cloudflare:workflows` and celld's `node:` modules), or a path with a query such as `x.wasm?module`;
- a Durable Object's RPC method returns a stream or a `Response` (celld: "RPC streams cannot cross isolate boundaries yet"); stream through the object's `fetch()` instead, as `RepoDO` does for `git-upload-pack`;
- the Worker exports a handler celld doesn't call, such as `email` or `tail`.

If a change needs a Cloudflare feature celld lacks, make the binding optional and document what happens without it on this page.
