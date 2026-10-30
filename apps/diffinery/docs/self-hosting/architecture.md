---
title: Architecture
description: How Diffinery maps onto Cloudflare products, how a git push and a workflow run flow through them, and where each kind of data is stored.
---

Diffinery is one Cloudflare Worker plus the Cloudflare products it binds to. There are no servers or databases to run yourself. This page explains which product does what, how a git push and a workflow run move through the system, how the code is organized, and where each kind of data lives. Read it before you deploy or operate your own instance, or when you need to reason about consistency and failure modes. The same code also runs on celld, the open-source Workers runtime; [Run on celld](/docs/self-hosting/celld) maps each product to its celld equivalent.

## Overview

| Piece of Diffinery | Cloudflare product | Binding |
| --- | --- | --- |
| Web UI and public docs, REST API, git smart HTTP, Git LFS, MCP server, container registry, runner API, Actions cache and artifact services, release asset uploads and downloads, source archives, profile pictures | Workers, with the Hono router | The Worker itself (`src/index.ts`) |
| One repository: refs, git objects, issues, pull requests, reviews, reactions, checks and commit statuses, releases, deployments and environments, workflow runs, secrets, webhooks, merge queue | Durable Object with SQLite storage (`RepoDO`), one per repository | `REPO` |
| Accounts (with profile picture version and appearance setting), organizations, tokens, repository list, topics and access, invitations, notifications, audit log, schedules, package index, email settings and log, organization variables, GitHub imports and linked GitHub accounts | D1, read through the Sessions API | `DB` |
| Large git objects, LFS objects, archived job logs, caches, artifacts, container image layers and manifests, the event archive, release assets, cached source archives, profile pictures, account exports | R2 | `BUCKET` |
| Webhooks (and retries of failed deliveries), notifications, audit fan-out | Queues (`diffinery-events`, dead-letter queue `diffinery-events-dlq`) | `EVENTS` |
| Email jobs | Queues (`diffinery-mail`, dead-letter queue `diffinery-mail-dlq`) | `MAIL` |
| Bounces and complaints | Queue `diffinery-mail-events`, fed by Email Sending's event subscriptions | (consumer only) |
| Workflow run orchestration (durable across restarts) | Workflows (`diffinery-run`, class `RunWorkflow`) | `RUN_WORKFLOW` |
| Hosted job runners | Containers (`RunnerContainer`, one container per job) | `RUNNER` |
| Agent sandboxes | Containers (`SandboxContainer`, one container per sandbox) | `SANDBOX` |
| GitHub import orchestration (durable, with paged and retried steps) | Workflows (`diffinery-import`, class `ImportWorkflow`) | `IMPORT_WORKFLOW` |
| Account exports and the clean-up after an account is deleted (durable, with retried steps) | Workflows (`diffinery-account`, class `AccountWorkflow`) | `ACCOUNT_WORKFLOW` |
| The Git transfer of a GitHub import | Containers (`ImportContainer`, one container per transfer) | `IMPORTER` |
| Scheduled workflows | Durable Object alarm, every 5 minutes (`SchedulerDO`, one instance) | `SCHEDULER` |
| Joining large artifact and cache uploads | Durable Objects, one per step (`ComposeDO`) | `COMPOSE` |
| Token expiry reminders, email log pruning, registry cleanup, expiry of draft imports and of account exports, a check that the scheduler's alarm is set, IndexNow submissions | Cron Triggers, every 5 minutes | `scheduled` handler |
| Live run logs and pull request updates in the browser | Durable Object WebSockets with hibernation | Through `REPO` |
| Outgoing email | Email Sending | `EMAIL` |
| Email-based account recovery and first admin sign-in | Cloudflare Access, on `/auth/access` only | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` |

```text
 browser, git, CLI, MCP client, docker, runner agent
                     |
                     v
        +---------------------------+         +--------------------+
        |  Worker (Hono)            |-------->|  D1 (Sessions API) |
        |  auth, routing, D1 reads  |         +--------------------+
        +---------------------------+
          |        |          |    \
          v        v          v     \----------------> R2
   +------------+  +--------+  +------------------+
   | RepoDO     |  | Queues |  | Containers        |
   | (one per   |  | events |  | RunnerContainer   |
   |  repo,     |  | mail   |  | SandboxContainer  |
   |  SQLite)   |  +--------+  | ImportContainer   |
   +------------+      |       +------------------+
     |   ^             v              ^
     |   |       webhooks, email,     |
     v   |       audit log            |
   Workflows (RunWorkflow,            |
              ImportWorkflow) --------+
```

## The Worker

`apps/diffinery/src/index.ts` exports the Worker's `fetch`, `queue` and `scheduled` handlers, and the classes Cloudflare instantiates: `RepoDO`, `SchedulerDO`, `ComposeDO`, `RunnerContainer`, `SandboxContainer`, `RunWorkflow`, `ImportWorkflow` and `ImportContainer`.

Every request goes through one middleware before it reaches a route:

1. **Cross-site check.** A request that changes state (anything but `GET`, `HEAD` and `OPTIONS`) and carries no `Authorization` credential is refused with `403 cross-site request refused` if the browser marks it as coming from another site (`Sec-Fetch-Site`, or a foreign `Origin`). Token clients are exempt. The web UI's forms also use a double-submit CSRF token.
2. **D1 session.** All D1 queries of the request run in one D1 session (see [D1 and read replication](#d1-and-read-replication)).
3. **Identity.** `GET` and `HEAD` requests for profile pictures (`/api/avatars/...`) skip this step and run as anonymous, because they are public and appear many times on every page. Requests to the Actions cache and artifact services (`/twirp/...` and `/_runtime/...`) skip it too: they carry their own signed token or URL (see [Actions cache and artifact services](#actions-cache-and-artifact-services)). For everything else, a `dfy_` token in the `Authorization` header (Bearer, `token` or Basic) becomes an account principal with the token's scopes. The push token of a GitHub import is a `dfy_` token too, but it is accepted only on Git smart HTTP, Git LFS and that import's own agent endpoints (`403 this token can only be used by its GitHub import` elsewhere). Job tokens (`djt_`), sandbox tokens (`dst_`) and self-hosted runner tokens (`drn_`, accepted only for claiming jobs) become a principal for one repository. Otherwise the session cookie from a passkey sign-in is checked. Otherwise the request is anonymous.
4. After the route runs, the response gets security headers and the `x-d1-bookmark` header.

Routes are mounted in this order, so earlier ones win: profile pictures (`/api/avatars/...`), OIDC discovery (`/.well-known/*`), git smart HTTP and LFS (`/<owner>/<repo>.git/...`), the runner API (`/runner/jobs/...`), the email REST API, the container registry (`/v2/`), the packages REST API, the Actions cache and artifact services together with the REST API's artifact and cache routes, the REST API (`/api/v3`), release asset uploads (`/api/uploads/...`), release asset downloads (`/<owner>/<repo>/releases/download/...`) and source archives (`/<owner>/<repo>/archive/...`), the MCP server (`/mcp`), the live-update WebSocket and artifact downloads, a catch-all for `/api/*`, and finally the server-rendered web UI, which also serves the public docs at `/docs`. The `/api/*` catch-all answers any API path that no route matched with GitHub's JSON 404, `{"message": "Not Found", "documentation_url": "https://docs.github.com/rest"}`, so API clients never get the web UI's HTML error page.

Some work happens in the Worker itself: profile pictures are checked, cropped and resized to small WebP files with WebAssembly image codecs, and code in the web UI and the docs is syntax highlighted with Shiki on the server.

The Worker holds no state of its own. It authenticates, checks the caller's role on the repository against D1, and then calls the repository's Durable Object over RPC.

Before it calls the object, the Worker also decides whether the request is a read or a write. `GET` and `HEAD` are reads, and so are the two `POST` requests that only fetch data: git's `git-upload-pack` (clone and fetch) and a Git LFS batch request for `download`. MCP tools marked read-only count as reads too. Every other request is a write:

- An anonymous caller (no token, no session) gets `401 authentication required` for any write, even on a public repository.
- A personal or agent token whose scope is only `read` gets `403 this token needs the write scope`.
- Browser sessions act with full scope, and job and sandbox tokens are limited by their own role instead.
- A job token is also checked against the job's effective `permissions:`, which the Durable Object records when the job starts. A request outside them gets `403 Resource not accessible by integration`, and some endpoints refuse job tokens altogether. See [Workflow permissions](/docs/actions/workflow-permissions).

Account-level changes that don't belong to a repository check the token's scope too: creating a repository needs `write`, while creating an organization, sending invitations, managing organization secrets, creating and revoking tokens, and creating and deleting agents need `admin`. A token restricted to some repositories is refused for creating repositories and organizations, invitations, organization secrets, agents, and creating and revoking tokens (`403 this token is limited to repositories and can't change account settings`).

## RepoDO: one Durable Object per repository

Each repository has one Durable Object, addressed by the repository's ID. It is the single writer for everything inside the repository, which gives strongly consistent ref updates, merges and run state without locks: two pushes to the same branch are applied one after the other, and a compare-and-swap on the ref rejects the stale one.

The object keeps its data in its own SQLite database (tables in [Data model](#data-model)). Inside it:

- **Git object store.** Objects are stored deflated. Small objects live in SQLite; objects larger than 512 KiB after compression go to R2 (SQLite rows are capped at 2 MB). Recently read objects stay in a 24 MiB in-memory cache.
- **Git protocol.** Protocol v2 `upload-pack` for clone and fetch (including shallow clones), and `receive-pack` for push, with push protection, branch protection and agent rules checked before refs move.
- **Collaboration.** Issues, pull requests, comments, reviews, reactions, issue events, labels, check runs and commit statuses, webhooks configuration and mergeability.
- **Releases and deployments.** Releases and their asset metadata (the files are in R2), deployments and their statuses, and environments with their branch policies, secrets (encrypted with a key derived from `MASTER_KEY`) and variables. The object also remembers who last moved each branch and tag, so tags pushed by agents never match an environment's tag rules and runs on code an agent pushed act as an agent.
- **Git data and archives.** The git data API (blobs, trees, commits, tags and refs) and zip and tar.gz source archives, which are built in the object and cached in R2.
- **Actions.** Parsing workflows from the pushed commit, creating runs and jobs, the runner API's server side, logs while a job runs, secrets (encrypted with a key derived from `MASTER_KEY`) and variables, and sandboxes.
- **Workflow tokens.** The repository's workflow settings (default token permissions, whether workflows may create and approve pull requests), each job's granted role and permissions, and the check that keeps a job token from creating, changing or deleting workflow files.
- **Caches and artifacts.** Their records, the per-repository cache budget and artifact quota, eviction of caches and expiry of artifacts. The contents are in R2.
- **Merge queue.** One queue per protected branch. The object's single alarm wakes it when a merge group's check timeout runs out.
- **Live updates.** WebSocket connections, see [Live updates](#live-updates).

Deleting a repository wipes the object's storage and deletes all of the repository's R2 objects: large git objects, LFS files, release assets, caches, artifacts, archived job logs, unfinished uploads and cached source archives. A repository with more objects than one call can delete is finished by the object's alarm.

## D1 and read replication

D1 holds the global directory: data that is not inside one repository, or that the Worker must read before it knows which repository to call (who you are, what you can see). Its schema is in `apps/diffinery/migrations/`.

Diffinery reads D1 through the Sessions API, so reads can be served by a replica near the visitor while a client still sees its own writes:

- Each request runs in one session. Where it starts depends on the caller: a bookmark from the `x-d1-bookmark` request header if valid; for browsers, the bookmark in the `__Host-dfy_d1` cookie; otherwise the primary for token clients (`first-primary`) and the nearest copy for anonymous browsers (`first-unconstrained`).
- Each response carries the session's latest bookmark in `x-d1-bookmark`. Browsers get it as a cookie (for one day) once they have written something or are signed in.
- Durable Objects, queue consumers and the cron handler use the D1 binding directly, which always goes to the primary.

Read replication is a setting of the D1 database, off until you turn it on. The repository's **D1 read replication** workflow (`.github/workflows/d1-replication.yml`, started by hand) first checks on a throwaway database that every read made with a bookmark sees its write, and then, if you ask it to, sets `read_replication.mode` to `auto` on the `diffinery` database. It needs the Deploy workflow's two secrets, D1 and Workers Scripts Edit on the API token, and a `workers.dev` subdomain on the account; change its hard-coded `https://diffinery.com` checks to your origin first. Without read replication, every read goes to the primary and bookmarks are still issued. The [REST API](/docs/reference/rest-api) page explains how API clients use the bookmark header.

## R2

One bucket (`diffinery-data`) stores everything too large for SQLite or D1:

- git objects over 512 KiB compressed,
- Git LFS objects (verified against their SHA-256 on upload),
- job logs, archived from the Durable Object when the job completes,
- Actions caches and artifacts, and their uploads while they are in progress,
- container image blobs and manifests, with uploads written as multipart uploads,
- an append-only archive of every event that goes through the events queue,
- release assets (up to 100 MB each),
- source archives (zipball and tarball downloads), cached after they are first built,
- profile pictures of people and organizations, stored as small WebP files in a few sizes.

Durable and short-lived data have their own top-level prefixes, because R2 lifecycle rules select objects by prefix:

| Prefix | What | Removed by |
| --- | --- | --- |
| `repos/` | Git objects, LFS objects and release assets | Nothing by age. Kept until the repository or the object is deleted. |
| `registry/` | Container image blobs and manifests | Nothing by age. The cron trigger removes blobs no image uses. |
| `avatars/` | Profile pictures | Nothing by age. Replaced when someone uploads a new picture, and deleted with the account. |
| `actions-cache/` | Actions caches | Nothing by age. Diffinery evicts caches itself (least recently used, and unused for 7 days). |
| `artifacts/` | Workflow artifacts | Diffinery at the end of each artifact's retention, and a lifecycle rule after 90 days. |
| `logs/` | Archived job logs | A lifecycle rule after 90 days. |
| `actions-staging/` | Cache and artifact uploads in progress (blocks and chunks) | Diffinery when the upload finishes, and a lifecycle rule after 1 day. |
| `archives/` | Cached source archives | A lifecycle rule after 30 days. They are built again on the next download. |
| `exports/` | Account exports and their parts while they are built | Diffinery 7 days after an export is ready (or when the person asks for a new one, or deletes the account), and a lifecycle rule after 8 days. |
| `events/` | The event archive | A lifecycle rule after 400 days. |

A lifecycle rule also aborts multipart uploads left unfinished for a day, under every prefix. `scripts/bootstrap.sh` sets these rules on every deploy and replaces the bucket's lifecycle configuration when it does, so rules added by hand in the Cloudflare dashboard don't survive the next deploy. If it can't set them, the deploy stops with `could not set the R2 lifecycle rules (token has R2: Edit?)`. It then reads the rules back and stops with `an R2 lifecycle rule still deletes objects under repos/ (git objects, LFS); refusing to continue` if any rule would delete objects under `repos/` or in the whole bucket.

Instances that stored artifacts, caches and job logs before these prefixes existed kept them under `repos/<repository ID>/`. Diffinery still reads them from there, and the lifecycle rules never touch them.

## Queues

**`diffinery-events`** carries every repository event: `push`, `pull_request`, `issues`, `issue_comment`, `pull_request_review`, `workflow_run`, `workflow_dispatch`, `release`, `status`, `deployment`, `deployment_status`, `repository_dispatch` and `audit`. The Durable Object sends events as things happen, so the request that caused them doesn't wait. The consumer takes batches of up to 50 and, for each batch, appends the events to the R2 archive. For each event it writes audit log entries (pushes, force pushes, ref deletions, merges and explicit audit events), delivers webhooks, and creates notifications and email jobs. Webhooks and notifications run as two separate stages: a stage that fails is put back on the queue alone (a `stage_retry` message) after 30 seconds, 2 minutes, 10 minutes, 30 minutes and 1 hour, then given up and logged, so retrying notifications never sends webhooks again and the other way round. Once a webhook may have been called, errors no longer fail the webhooks stage; that delivery's own retries take over. Any other failure retries the whole event with backoff up to 8 times, then moves it to `diffinery-events-dlq`.

The same queue carries webhook retries. When a delivery fails with a network error or timeout, `408`, `429` or a `5xx` status, the consumer puts a retry message for that one webhook back on the queue with a delay: 1 minute, then 5 minutes, 30 minutes, 1 hour and 3 hours, so a delivery is tried at most 6 times, the last one about 4 hours and 36 minutes after the first. A retry sends the same body with the same `X-GitHub-Delivery` ID, to the webhook's current URL and signed with its current secret; it is dropped if the webhook was deleted in the meantime. Other statuses, including `3xx` and other `4xx` answers, are not retried. Webhook and stage retry messages are not added to the R2 event archive.

**`diffinery-mail`** carries email jobs. It is separate so that sign-in links and invitation links never land in the event archive. The consumer applies the recipient's notification settings, renders the HTML and text versions, and sends through Email Sending. Temporary failures are retried with backoff; after 6 attempts the email is logged as failed. Before sending, it checks the suppression list: nothing goes to an address that bounced for good or reported spam. When Email Sending refuses a recipient for good (`E_RECIPIENT_SUPPRESSED`: it is on Cloudflare's own suppression list), the address goes on Diffinery's list as a hard bounce, so later emails are skipped without a call.

**`diffinery-mail-events`** receives Email Sending's delivery events; the deploy subscribes it to the sending domain's bounced and complained events. The consumer adds the recipient of a permanent bounce or a spam complaint to the suppression list and ignores the rest.

## Workflows

Each workflow run is one instance of the `diffinery-run` Workflow, with the run's ID as the instance ID. `RunWorkflow` makes a run durable: its steps, sleeps and waits survive restarts and deploys.

1. **Plan.** Ask the repository's Durable Object for the job graph: each job with the jobs it `needs` (calls to reusable workflows expanded). If the run's concurrency group is busy, sleep a minute and plan again, for up to 6 hours.
2. **Start jobs as their needs finish.** A job starts as soon as every job it needs has finished, without waiting for unrelated jobs (each start retried up to 3 times). Matrix jobs are expanded here, and up to `max-parallel` start at once.
3. **Wait.** For each started job, wait for an event named `job-<id>` that the Durable Object sends when the job completes, with a timeout of 6 hours. On timeout the job is marked `timed_out` and its container stopped.
4. **Finish.** Once every job has finished, compute the run's conclusion, which also triggers `workflow_run` followers.

Runs that were planned by an older version, which grouped jobs in levels, finish level by level.

Each attempt of a GitHub import is one instance of the `diffinery-import` Workflow, with `<import id>-<attempt>` as the instance ID. `ImportWorkflow` runs every step with `step.do`, each retried up to 5 times with exponential backoff from 15 seconds and limited to 15 minutes per call, and turns GitHub rate limits into Workflow sleeps. Steps that page through GitHub are called again and again with a cursor until they report that they are done, so no single step runs long. See [Request flow: a GitHub import](#request-flow-a-github-import).

Each account export is one instance of the `diffinery-account` Workflow, `export-<export ID>`, and so is the clean-up after an account is deleted, `delete-<account ID>`. `AccountWorkflow` runs every step with `step.do`, retried up to 5 times with exponential backoff from 10 seconds. An export writes the account, then each repository as a Git bundle (written by the repository's Durable Object), then the issues and pull requests the person wrote, a few repositories per step, as separate R2 objects, and finally joins them into one tar archive. The clean-up wipes each deleted repository's Durable Object and R2 objects, deletes the account's profile pictures and exports, and then asks every repository's Durable Object, 25 per step, to show the deleted account's issues, pull requests, comments, reviews and reactions as written by `ghost`. See [Deleting an account](/docs/accounts/account-data#deleting-your-account).

## Containers

All three container classes use the same image, built from `containers/runner/Dockerfile` (Ubuntu 24.04 with Node.js 22, git, git-lfs, Python and build tools, plus the runner agent).

- **`RunnerContainer`** runs one hosted job (`runs-on: ubuntu-latest` and other `ubuntu-*` or `linux` labels). The Durable Object starts a container named after the job with three environment variables: `DIFFINERY_API_URL`, `DIFFINERY_JOB_ID` and `DIFFINERY_JOB_TOKEN`. The agent fetches its job spec from `/runner/jobs/<id>`, runs the steps, streams logs, uses the cache and artifact services and the OIDC endpoint, reports completion and exits. If the container stops before the job reports completion, the job fails with "The runner stopped unexpectedly". Instance type `standard-4` (4 vCPU, 12 GiB), at most 100 at once; `RunnerContainerMedium` (`standard-3`), `RunnerContainerSmall` (`standard-1`) and `RunnerContainerTiny` (`basic`) are the same runner on smaller instance types, at most 100 each, for jobs that ask for a size or whose earlier runs fit one ([Runner sizes](/docs/actions/runners#runner-sizes)); a job's container name ends in `.medium`, `.small` or `.tiny` on those. A deployment without their bindings (`RUNNER_MEDIUM`, `RUNNER_SMALL`, `RUNNER_TINY`) runs every job on `RunnerContainer`. Each runs with internet access on (only HTTP and HTTPS, through the Worker, under [`EGRESS=web`](/docs/self-hosting/configuration#egress)). Docker is started inside the container the first time a job uses it.
- **`SandboxContainer`** runs one agent sandbox: the repository checked out at a ref, with an HTTP API on port 8080 for `exec`, file reads and file writes. The Worker forwards REST and MCP sandbox calls to it with a per-sandbox secret. Instance type `standard-1`, at most 50 at once, stopped after 30 minutes without requests. Internet access is on, limited to HTTP and HTTPS under `EGRESS=web` like `RunnerContainer`, and a limited sandbox stays limited when it starts again after its idle stop.
- **`ImportContainer`** runs the Git transfer of one GitHub import: the runner agent in import mode, started with `DIFFINERY_API_URL`, `DIFFINERY_IMPORT_ID` and `DIFFINERY_IMPORT_TOKEN`. One container per try, named `<import id>-<attempt>-<try>`. If it stops before the agent reports a result (a crash, running out of memory, a platform restart), the transfer counts as failed and the import's Workflow can try it again. Instance type `standard-4` (a mirror clone of a large repository needs disk and memory), at most 20 at once, internet access on, stopped after 7 hours without activity.

Self-hosted runners (`runs-on: [self-hosted, ...]`) run the same agent outside Cloudflare. They register with a repository admin's one-hour registration token, poll `POST /api/v3/repos/{owner}/{repo}/actions/runners/claim` with their own runner token (kept in the repository's Durable Object, hashed), and then talk to the same runner API. See [Runners](/docs/actions/runners).

## Actions cache and artifact services

`actions/cache`, `actions/upload-artifact`, `actions/download-artifact` and other tools built on GitHub's Actions toolkit talk to the same services they use on GitHub, which the Worker implements in `src/http/actions-runtime.ts`:

- The cache and artifact services at `ACTIONS_RESULTS_URL`, and the older cache API at `ACTIONS_CACHE_URL`.
- Signed upload and download URLs under `/_runtime/blob/...`, which accept the parts of the Azure Blob Storage protocol the toolkit uses (blocks, block lists and ranged reads) and store the data in R2.

The job spec gives the agent an `ACTIONS_RUNTIME_TOKEN` and these URLs, and the agent passes them to JavaScript and Docker actions and to its built-in cache and artifact steps, not to `run:` steps. The token is an HMAC-signed JWT for one job, with a key derived from `MASTER_KEY`. It is accepted only while its job is in progress and until 30 minutes after the job's timeout, and it can only read caches of the job's own branch, its base branch and the default branch. Without `MASTER_KEY`, jobs get no token: the built-in cache step is skipped with a warning and the built-in artifact steps fail.

The Durable Object decides what each request may read or write and keeps the records (`rt_caches` and `rt_artifacts`). It applies the 10 GB cache budget per repository and the artifact quota (`ARTIFACT_QUOTA_BYTES`), evicts caches and expires artifacts. Older runner agents use their own cache and artifact endpoints under `/runner/jobs/<id>/...`. Their artifacts are recorded in `rt_artifacts` (marked `legacy`, a `.tar.gz` at the older key) so the REST API, the quota and the 90-day expiry cover them. Their caches stay in the `caches` table, with their own 10 GB budget and the same 7-day idle eviction. Limits are listed in [Caches and artifacts](/docs/reference/limits#caches-and-artifacts).

## Workflow schedules

`SchedulerDO` starts scheduled workflow runs. Its one instance ticks on its own Durable Object alarm every 5 minutes (on the hour, :05, :10 and so on; `SCHEDULE_TICK_MINUTES` changes the interval, 1 to 60). Each tick sets the next alarm first, reads every workflow schedule from D1 (kept in sync from the default branch on each push) for repositories that aren't archived, and starts a run for each cron expression that matched any minute since the last tick that finished, at most 16 repositories at a time. A tick that comes late, or fails, is caught up by the next one, up to an hour back. Alarms survive deploys; a cron trigger can take minutes to apply after a deploy, which is why schedules don't depend on it. The alarm is set when a repository first registers a schedule, and the cron trigger checks it on every run. Site administrators can read the scheduler's state at `GET /api/v3/diffinery/admin/scheduler`: `tick_minutes`, `last_tick_at` (when the last tick finished), `covered_until` (the last minute it covered) and `next_tick_at`.

## Cron trigger

The `scheduled` handler runs every 5 minutes (`*/5 * * * *`) and:

1. Cleans up the container registry: abandoned uploads and blobs no image uses.
2. Sets the workflow scheduler's alarm if it isn't set.
3. Sends token expiry reminders and, once a day, prunes the email log.
4. Cancels draft organization imports (started in the web form, repositories never chosen) that are more than 7 days old, with the error `draft expired`, and erases their GitHub token.
5. Tells search engines through IndexNow about public pages a deploy added, changed or removed, and, hourly, about public repositories pushed since (see [Search engines](/docs/admin/site-administration#search-engines)). It keeps its state in D1 (`indexnow_urls`, `indexnow_submissions`, `indexnow_state`).

## Live updates

Pages that show changing state (run logs, job status, pull requests) open a WebSocket to `/<owner>/<repo>/live?topics=...`. The Worker checks that the caller can read the repository, then hands the connection to the repository's Durable Object. The object accepts it with the WebSocket Hibernation API, tagged with up to 10 topics: `repo`, `issues`, `runs`, `run:<id>`, `job:<id>` and `pr:<number>`. Whenever something changes, the object broadcasts a JSON message `{topic, data}` to the sockets tagged with that topic. With hibernation, idle connections don't keep the object in memory. Clients send `ping` and get `pong` to keep the connection open, and reconnect with backoff. Messages on the `repo` topic only say that something changed (`{kind: "event", type}`, never the event's payload, and never audit entries), and the page fetches what changed with the viewer's own access. Access is checked when a socket connects, so each socket lasts 10 minutes: after that the object closes it with code 4001 and the page reconnects at once, passing the check again. Someone who lost access, or a signed-out reader of a repository made private, stops getting updates within 10 minutes.

## Email Sending and Access

- **Email Sending** (`send_email` binding `EMAIL`) delivers every email from `MAIL_FROM`. When the binding is missing, emails are logged as skipped instead of sent.
- **Cloudflare Access** protects only `/auth/access`. Everyday sign-in is passkeys with sessions in D1; git, the API, MCP and runners use Diffinery tokens. `/auth/access` verifies the Access JWT (RS256, against the team's public keys, `aud` and `iss`) and turns the verified email into a Diffinery session.

## Rate limits

Every request passes the rate limiting bindings before it is handled (`src/lib/rate-limit.ts`). Sign-in, invitation and security report requests count per IP address in `RL_AUTH`, other anonymous requests per IP address in `RL_ANON`, and requests with a session or token per account in `RL_ACCOUNT`. Requests that create repositories, organizations, forks, issues, pull requests, releases, comments or reviews also count in `RL_CREATE`, as do MCP tool calls that change something. Job, sandbox, runner and import credentials, health checks and avatars aren't counted. Cloudflare keeps each count in the location that serves the request, so the limits stop bursts rather than meter use exactly. Past a limit the request answers `429` with `retry-after: 60`. See [Bindings](/docs/self-hosting/configuration#bindings).

## Request flow: a git push

1. `git push` sends `POST /<owner>/<repo>.git/git-receive-pack` with a token in Basic authentication.
2. The Worker resolves the token, loads the repository from D1, computes the caller's role (account role, capped by the token's scope and repository restriction, and by agent rules) and requires write access. A request without credentials gets `401 authentication required`, which makes Git ask for them, and a `read`-scoped token gets `403 this token needs the write scope`. It reads the body (decompressing gzip) and calls the repository's Durable Object.
3. The Durable Object refuses pushes over 100 MB, parses the ref commands and the packfile, and resolves deltas against objects it already has. Nothing is stored yet.
4. **Push protection** scans every new text blob for credentials, whatever its size. A finding blocks the whole push unless a human repository admin passed `-o allow-secrets=<reason>`. Both a block and a bypass are recorded as audit events.
5. The objects are written (SQLite or R2 by size).
6. Each ref update is checked: valid ref name, write role, a job token can't create, change or delete workflow files, `refs/pull/` and merge queue branches are read-only, objects exist, tags can only be moved by maintainers, agents can't push to the default or protected branches, and branch protection rules (pull request required, force push, deletion, linear history; admins bypass unless the rule is enforced for them). When several rules match the branch, the rule whose pattern is exactly the branch name applies; otherwise the oldest matching rule does. With `atomic`, one failure rejects all.
7. Each accepted ref moves with a compare-and-swap, and the object records who moved it and whether that was a person or an agent.
8. After each ref moves, the object emits a `push` event to the events queue and to WebSocket subscribers, updates open pull requests whose head branch moved (new head SHA, stale approvals dismissed when the rule asks for it, a `synchronize` event, new test merge commits and `pull_request` workflows), starts `push` workflows whose filters match, re-syncs schedules when the default branch moved, and re-checks merge queues on that branch.
9. The report goes back to git, including messages like "Create a pull request for 'feature':" with a link.
10. In the background, the Worker records the push time in D1. The events queue consumer archives the event, writes the audit log entry, delivers webhooks and sends notifications.

## Request flow: a workflow run

1. A trigger (push, pull request, dispatch, `repository_dispatch`, a release, schedule, `workflow_run`, merge group) reaches the Durable Object, which loads `.github/workflows/*.yml` and `.diffinery/workflows/*.yml` from the commit, parses them with `@diffinery/workflow-yaml`, and matches triggers and filters.
2. For each matching workflow it inserts a run, evaluates `run-name` and `concurrency` (cancelling older runs with `cancel-in-progress`), creates a `diffinery-run` Workflow instance and emits a `workflow_run` event.
3. The Workflow plans the job graph and starts the jobs that need nothing. For each job the Durable Object expands reusable workflows and the matrix, inserts job rows and a queued check run on the commit, works out the job's effective permissions (from `permissions:`, the repository's default, and the caller of a reusable workflow) and records them, creates a job token and a runtime token, and starts a `RunnerContainer`. A job with `environment:` is first checked against the environment's branch policy, gets the environment's secrets and variables, and creates a deployment that tracks the job. Self-hosted jobs wait for a runner to claim them instead.
4. The runner agent in the container fetches the job spec (steps, contexts, secrets and variables decrypted for this job), checks out the code and runs the steps. Log lines go to the Durable Object, which stores them and broadcasts them on `job:<id>` to open browser tabs. Caches and artifacts go to R2 through the [cache and artifact services](#actions-cache-and-artifact-services); OIDC tokens are signed with `OIDC_PRIVATE_KEY`.
5. On completion the agent reports outputs and conclusion. The Durable Object updates the job and its check run, archives the log to R2, cancels matrix siblings on failure with `fail-fast`, starts the next queued matrix job, and sends the `job-<id>` event to the Workflow instance.
6. The Workflow starts every job whose needs have now all finished. When every job is done, it finishes the run: the Durable Object records the conclusion, emits a `workflow_run` completed event (which drives webhooks and failure emails) and starts any `workflow_run` followers.

## Request flow: a GitHub import

1. `POST /api/v3/diffinery/imports` (also the web form, `diffinery migrate github` and the MCP tool `start_github_import`) reaches the Worker. It validates the request, checks that the caller may import into the target account and is under the limits of imports at a time, and reads the source repository (or the GitHub organization's repository list) from the GitHub REST API. It encrypts the GitHub token with a key derived from `MASTER_KEY`, records the import in D1 (one `imports` row per repository, plus one for an organization import), writes the `import.create` audit entry and creates the `ImportWorkflow` instance.
2. **Repository.** The Workflow checks again that the person or agent who started the import may still import into the target, creates the repository (or reuses the one an earlier attempt of the same import created), copies its description, homepage and topics, and takes the repository's import lock in its Durable Object. While the lock is held, the Durable Object refuses every `git push` that isn't this import's (`repository is locked by an import in progress`). A retry also refuses to continue when the repository holds refs, issues, pull requests, comments, reviews, labels, milestones or protection rules that the import didn't write.
3. **Git transfer.** The Worker mints a push token for the transfer (the starter's account and token scope, this repository only, valid for one day) and starts an `ImportContainer`. The agent fetches its spec from `/api/v3/diffinery/imports/<id>/agent/spec`, runs `git clone --mirror` from GitHub and fetches the LFS objects. The GitHub token reaches git only through per-host configuration in the environment, never in a command line or a log, and git never follows redirects. The agent then pushes the history to Diffinery in chunks of at most 32 MiB, then every branch and tag, the head commit of each pull request to a temporary `refs/diffinery-import/pull/<n>` ref, and the LFS objects. Every push carries `-o diffinery-import`, which the Durable Object honors only for that import's current push token: push protection still scans every new blob, refs can only be created or moved if this import wrote them, and no push event, workflow, webhook or notification follows. Each such push writes one `import.push` audit entry. When old history contains credentials and the import was set to bypass, the push also carries `-o allow-secrets=Imported from GitHub <owner>/<name>`, which works only for a person with the admin role and an `admin` token or browser session (see [Push protection](/docs/security/push-protection#imported-history)).
4. The agent reports its progress and then its result, which revokes the push token and wakes the Workflow with a `git-done` event. The Workflow also checks every 10 minutes, for up to 6 hours. A transfer that failed for any reason other than push protection is tried once more with a new container and a new push token.
5. **Paged steps.** Labels and milestones, issues and pull requests (with their original numbers), issue comments, reviews, review comments, branch protection, Actions variables with secret names and deployment environments, and releases are read from the GitHub REST API, a few pages per Workflow step. Issues, pull requests, comments, reviews, labels and milestones are written by GitHub number or id and marked with the import, so a retried step doesn't duplicate them. People are mapped through linked GitHub accounts; everyone else becomes a `github:<login>` mannequin. Nothing these steps write fires workflows, webhooks or notifications.
6. **Finish.** The Durable Object creates `refs/pull/<n>/head` for every imported pull request whose head commit arrived and removes the temporary refs. The Worker sets the default branch and archived state from GitHub, records the counts and push protection findings in the import's summary, releases the lock, revokes every push token, deletes the GitHub token, writes `import.finish` and sends the starter an in-app notification.
7. If a step still fails after its retries, the import is marked `failed` with the error: its tokens are revoked, the lock is released, its containers are stopped, an `import.fail` audit entry is written and the starter gets an in-app notification. The repository is kept with what was imported.

An organization import runs a Workflow of its own: it copies the organization's Actions variables (only those the target organization doesn't have yet) and secret names when a person imports an organization into an organization, then starts its repository imports, each its own Workflow instance, up to its concurrency. A repository import that ends starts the next queued one and wakes the organization import when none is left. The organization import also checks every hour, for up to a week, restarting any that are stuck in the queue.

## Packages in the repository

| Path | Package | What it contains |
| --- | --- | --- |
| `apps/diffinery` | `@diffinery/app` | The Worker: HTTP routes, `RepoDO`, `RunWorkflow`, container classes, web UI, email, registry, MCP server, D1 migrations, `wrangler.jsonc`, unit and end-to-end tests. |
| `apps/cli` | `diffinery` | The command-line client. |
| `containers/runner` | `@diffinery/runner` | The runner agent and sandbox server (bundled to `dist/agent.mjs`) and the container image. |
| `packages/git-core` | `@diffinery/git-core` | Git in pure TypeScript: SHA-1, zlib, object encoding, packfiles and deltas, pkt-lines, an object store interface, tree diffs, merge bases and three-way merges. |
| `packages/workflow-yaml` | `@diffinery/workflow-yaml` | The GitHub Actions workflow parser and validator, the `${{ }}` expression language (lexer, parser, evaluator), matrix expansion, branch, tag and path filters, the job graph and cron matching. |
| `packages/shared` | `@diffinery/shared` | Types shared by the Worker and the runner: the runner API contract (job spec, steps, log lines, completion) and repository events. |

## Data model

### D1 tables

| Table | Holds |
| --- | --- |
| `accounts` | Users, organizations and agents: login, kind, email, status (`active`, `pending`, `disabled`), site admin flag, an agent's owner and policy, profile picture version and appearance setting (`light`, `dark`, or empty to follow the system). |
| `org_members` | Organization membership with role `owner`, `admin` or `member`. |
| `repos` | Every repository: owner, name, description, homepage, visibility (`public` or `private`), topics, default branch, archived flag and timestamps. |
| `repo_redirects`, `login_redirects`, `package_redirects` | Old owner and repository names left by transfers and renames, earlier logins of renamed people and organizations, and old names of container images that moved with their repository, so old URLs keep leading to them. A redirect ends when a repository (or account) takes the old name. |
| `repo_access` | Direct repository access for a person or agent, with role `read`, `triage`, `write`, `maintain` or `admin`. |
| `tokens` | Personal and agent tokens: SHA-256 hash, prefix, scopes, repository restriction, expiry, last use, revocation, expiry reminder, and the import a GitHub import's push token belongs to. |
| `invites` | Invitations to the site, an organization or a repository, by token hash, with expiry and acceptance. |
| `access_requests` | Requests from people waiting for an invite. |
| `early_access`, `early_access_attempts` | [Early access](/docs/accounts/early-access) requests from `/early-access`: the address, name, company, use and hosting given, the state (`unconfirmed`, `confirmed`, `invited`, `declined`), hashes of the confirmation and removal links' codes, and who decided; and one row per form submission with hashes of the IP address and the address typed, kept a day for the daily limits. |
| `contact_messages`, `contact_attempts` | Messages from the [contact form](/docs/admin/contact-form) at `/contact`: the name, address, topic and message, the sender's account when signed in, the state (`unconfirmed`, `new`, `handled`, `spam`), a hash of the confirmation link's code, and the site administrators' note and who last changed it; and one row per submission from someone not signed in with hashes of the IP address and the address typed, kept a day for the daily limits. |
| `security_reports` | Private vulnerability reports from `/security/report`: summary, details, affected area, reply-to address, the reporter when signed in, a hash of the sender's IP address (for the daily limits), and the state (`new`, `triaged`, `resolved`) and note a site administrator set. |
| `passkeys` | WebAuthn credentials: public key, counter, transports, device type, backup state, name. |
| `sessions` | Browser sessions by hash of the cookie value, with the sign-in method and passkey, user agent and expiry. |
| `webauthn_challenges` | In-flight passkey ceremonies. |
| `signin_links` | Admin-issued single-use sign-in links. |
| `notifications` | In-app notifications. |
| `audit_log` | The append-only audit log: actor, on-behalf-of, action, target, detail. |
| `schedules` | Cron expressions of default-branch workflows, read by the cron trigger. |
| `org_secrets` | Organization Actions secrets, encrypted. |
| `org_variables` | Organization Actions variables. A copy is kept in each of the organization's repositories. |
| `imports` | GitHub imports: kind (one repository or an organization), status, attempt, source, target, options, per-step progress, the Git transfer's progress and result, summary, warnings, error, the encrypted GitHub token while the import runs and the current push token's id. |
| `account_links` | Verified links between Diffinery accounts and GitHub accounts, by API base and GitHub's numeric user id. |
| `packages`, `package_manifests`, `package_tags`, `package_blobs`, `package_manifest_blobs`, `registry_blobs`, `registry_uploads` | The container registry index: packages, their manifests, tags and blobs, and uploads in progress. The bytes are in R2. |
| `notification_prefs`, `repo_watches`, `thread_subscriptions` | Notification settings, repository watching and per-thread subscriptions. |
| `known_devices` | Browsers and passkeys a person has signed in with, so only new ones trigger a security email. |
| `email_log` | Every email Diffinery tried to send, with status. |

### RepoDO tables

| Table | Holds |
| --- | --- |
| `meta` | The repository's identity (ID, owner, name, default branch, owner kind), its workflow settings and, while a GitHub import fills it, that import's lock. |
| `refs` | Branches, tags, `refs/pull/*` and merge queue refs. |
| `objects` | Git objects: type, size, deflated data, or a flag that the data is in R2. |
| `counters` | Number sequences: issue and pull request numbers, run numbers and merge queue order. |
| `issues` | Issues and pull requests (they share one number sequence), with title, body, state, author, assignees, labels and lock state. |
| `pulls` | Pull request fields: head and base branches, the head repository, head SHA, draft, merge state, merge commit, requested reviewers, intent, and the auto-merge setting while it is on (method, commit text, who turned it on and with which role). |
| `comments` | Issue and pull request comments, and review line comments with path, line, side, commit and resolution. |
| `reviews` | Pull request reviews with state and commit. |
| `labels` | The repository's labels. |
| `milestones`, `issue_milestones` | Milestones, and the milestone of each issue and pull request. |
| `import_refs`, `import_findings` | The refs a GitHub import wrote (so a retry only moves its own), and the push protection findings it bypassed. Imported issues, pull requests, comments, reviews, labels, milestones and protection rules carry the import's id in an `imported` column. |
| `org_variables` | A copy of the owning organization's Actions variables, for `vars.*`. |
| `protections` | Branch protection rules by branch pattern, in the order they were created (the oldest matching pattern applies when no rule names the branch exactly). |
| `secrets`, `variables` | Repository Actions secrets (encrypted) and variables. |
| `webhooks` | Webhook URL, secret, events, and the last delivery status and time. |
| `checks` | Check runs by commit, from workflows and from external tools, with who reported each one (person or agent). |
| `statuses` | Commit statuses by commit and context. |
| `releases`, `release_assets` | Releases and their asset metadata (name, label, content type, size, download count). |
| `deployments`, `deployment_statuses` | Deployments and their status history. |
| `environments`, `environment_secrets`, `environment_variables` | Deployment environments with their branch policy, encrypted secrets and variables. |
| `reactions` | Reactions on issues, pull requests and comments. |
| `issue_events` | The event history of issues and pull requests (for example labeled, assigned, locked). |
| `ref_actors` | Who last created or moved each branch and tag, and whether that was a person or an agent. |
| `runs`, `jobs` | Workflow runs and their jobs: event, refs, SHAs, status, conclusion, whether the run's code came from an agent, matrix, outputs, steps, timeout, `continue-on-error`, concurrency group, labels. |
| `logs` | Log lines of running jobs (moved to R2 when the job completes). |
| `rt_caches`, `rt_artifacts` | Caches and artifacts from the cache and artifact services: key, version and branch of each cache, name, size, retention and expiry of each artifact, and uploads in progress. Artifacts from older runner agents are here too, marked `legacy`. The contents are in R2. |
| `caches` | Caches saved by older runner agents; the archives are in R2. (The older `artifacts` table is emptied into `rt_artifacts` when the repository's schema is migrated.) |
| `job_grants` | The role and effective permissions of each job's token. |
| `merge_queue` | Queued pull requests and their merge groups. |
| `sandboxes` | Agent sandboxes, who created them and their status. |
