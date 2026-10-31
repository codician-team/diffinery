---
title: Deploy your own Diffinery
description: Deploy Diffinery to your own Cloudflare account and domain with scripts/setup.sh or the Deploy workflow, sign in as the first admin, and develop locally.
---

Diffinery runs entirely on Cloudflare, so you can run your own instance on your own Cloudflare account and domain. This page walks through a first deployment, the first administrator sign-in, email and DNS setup, updates, local development and the errors the scripts print. Examples use `git.example.com` as your instance's hostname; replace it with yours.

There are two ways to deploy, and both run the same scripts:

| Way | When to use it |
| --- | --- |
| `scripts/setup.sh` from a clone on your machine | The quickest start. One command checks your tools, API token and zone, then deploys or updates. See [Deploy from your own machine](#deploy-from-your-own-machine). |
| The Deploy workflow (`.github/workflows/deploy.yml`) | Deploys on every push to `main` once your copy of the repository lives on a forge with GitHub-compatible Actions. See steps 3 and 4. |

The short version, after [creating an API token](#step-2-create-a-cloudflare-api-token):

```sh
git clone https://github.com/codician-team/diffinery.git && cd diffinery
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... DIFFINERY_DOMAIN=git.example.com \
  BOOTSTRAP_ADMINS=you@example.com scripts/setup.sh
```

For what each Cloudflare product does in Diffinery, see [Architecture](/docs/self-hosting/architecture). For every setting, see [Configuration](/docs/self-hosting/configuration).

## What you need

| Requirement | Why |
| --- | --- |
| A Cloudflare account on the Workers Paid plan | Diffinery uses Containers (hosted runners, sandboxes and the Git transfers of GitHub imports), Durable Objects with SQLite, Workflows, Queues, D1, R2, Cron Triggers and Email Sending. Containers need the paid plan, and the Worker asks for 300,000 ms of CPU time per request. |
| R2 enabled on the account | Large git objects, LFS objects, logs, caches, artifacts, container images, release assets, cached source archives and profile pictures are stored in R2. |
| A domain added to the account as a zone | Diffinery serves `https://<hostname>/*` through a Workers route on that zone. |
| A Cloudflare Zero Trust organization | Cloudflare Access guards `/auth/access`, the email-based sign-in that the first administrator uses and that lets people recover a lost passkey. Its one-time PIN login works without extra setup. |
| A clone of the Diffinery repository | `scripts/setup.sh` deploys from it (see [Deploy from your own machine](#deploy-from-your-own-machine)). To deploy from a workflow instead, keep your copy on a forge with GitHub-compatible Actions: the Deploy workflow (`.github/workflows/deploy.yml`) runs on `ubuntu-latest` runners, on GitHub or on a Diffinery instance. |

Tools the workflow installs or expects on its runner, and that `scripts/setup.sh` checks for on your machine: Node.js 22, pnpm 10 (the repository pins `pnpm@10.28.0`), `jq`, `curl`, `openssl` and Docker (wrangler builds the runner container image from `containers/runner/Dockerfile` during `wrangler deploy`).

Nobody who uses your instance needs a Cloudflare account. Only the deployment uses one.

## How a deployment works

One run of the Deploy workflow, or of `scripts/setup.sh`, does everything, and every step is safe to repeat:

1. Install dependencies, build the runner agent, the web UI's client bundles and the documentation (the pages under `apps/diffinery/docs`, the CLI reference and the CLI file served at `/-/cli/diffinery.mjs`), typecheck and run the unit tests.
2. `scripts/bootstrap.sh` creates whatever is missing in your account (D1 database, R2 bucket, queues, the Turnstile widget for the security report form, the Cloudflare Access application for `/auth/access`), sets the R2 bucket's lifecycle rules, checks Email Sending, writes `apps/diffinery/wrangler.deploy.jsonc` with the real IDs, your hostname's route, `PUBLIC_URL`, email sender and `BOOTSTRAP_ADMINS`, and applies D1 migrations.
3. `wrangler deploy -c wrangler.deploy.jsonc` uploads the Worker, the Durable Object classes, the two Workflows (workflow runs and GitHub imports) and the cron trigger, and builds and pushes the runner image for Containers.
4. `scripts/wait-container-rollout.sh` waits until the container rollouts of the new runner image reach their last step. Even then, an instance the rollout hasn't updated yet can start a container on the old image. Diffinery turns away a runner that reports any image other than `RUNNER_IMAGE` and starts the job again, up to four times. The live test waits until jobs report the deployed image (`runner_image` on `GET /api/v3/meta`) and then checks that every job ran on it. Running containers keep the old image until they finish. It gives up with a warning, not a failure, after `ROLLOUT_WAIT_MINUTES` (10 by default).
5. `scripts/ensure-secrets.sh` creates the Worker's two secrets, `MASTER_KEY` and `OIDC_PRIVATE_KEY`, the first time only, and sets `TURNSTILE_SECRET` when it's missing.
6. On the very first deploy, bootstrap runs again to finish the Access setup, and the Worker is redeployed.
7. Smoke tests check `/healthz`, the sign-in pages, static assets and D1 sessions.

## Step 1: Choose your hostname and first administrators

You don't edit any code to deploy your own instance. `apps/diffinery/wrangler.jsonc` names `diffinery.com`, the project's public instance, in its route, `PUBLIC_URL` and `MAIL_FROM`; on every deploy, `scripts/bootstrap.sh` passes your hostname to `scripts/render-config.mjs`, which writes your values into the deployed config instead (see [scripts/render-config.mjs](#scriptsrender-configmjs)). Decide these settings, which both ways of deploying read from the environment:

| Setting | Example | Meaning |
| --- | --- | --- |
| `DIFFINERY_DOMAIN` | `git.example.com` | Your instance's hostname, without `https://` or a path. Diffinery is always served over HTTPS at the root of that hostname. The deployed Worker gets the route `<DIFFINERY_DOMAIN>/*`, `PUBLIC_URL` `https://<DIFFINERY_DOMAIN>` and `MAIL_FROM` `notifications@<DIFFINERY_DOMAIN>`. |
| `BOOTSTRAP_ADMINS` | `you@example.com,ops@example.com` | Comma-separated emails of the people who become site administrators when they first sign in (see [Step 7](#step-7-sign-in-as-the-first-administrator)). |
| `DIFFINERY_ZONE` | `example.co.uk` | Only when the Cloudflare zone that holds your hostname is not its last two labels. For `git.example.com` the default zone is `example.com`, which is right; for `git.example.co.uk` the default would be `co.uk`. |
| `MAIL_DOMAIN` | `example.com` | Only to send email from another domain than your hostname, here `notifications@example.com`. |
| `ACCESS_TEAM_DOMAIN` | `example.cloudflareaccess.com` | Only when the API token can't read your Zero Trust organization. |

**`BOOTSTRAP_ADMINS` on later deploys.** The repository's `wrangler.jsonc` leaves `BOOTSTRAP_ADMINS` empty. A deploy takes the list from the `BOOTSTRAP_ADMINS` environment variable; when that is empty, from `wrangler.jsonc` if your copy sets it there; and otherwise it keeps the list the deployed Worker already has. So you set the list once, for example on your first `scripts/setup.sh` run, and later deploys, including the Deploy workflow, keep it. On a brand-new instance with no list, the deploy warns that nobody will become a site administrator. Admin status is stored with each account when it is created, so the list only matters for accounts that don't exist yet. See [BOOTSTRAP_ADMINS](/docs/self-hosting/configuration#bootstrap_admins).

**`.github/workflows/deploy.yml`** needs no changes either. It reads your hostname from repository variables you add in step 3:

- `DIFFINERY_DOMAIN`: your hostname, for example `git.example.com`. `scripts/bootstrap.sh` uses it for the Worker's route, `PUBLIC_URL`, the email sender, the Access application and the Email Sending check, and the workflow uses it as the `production` environment's URL and for its checks after the deploy. Without it, everything assumes `diffinery.com`, and the deployed Worker gets the `diffinery.com/*` route and `PUBLIC_URL` `https://diffinery.com` whatever `wrangler.jsonc` says.
- `DIFFINERY_ZONE`, if the Cloudflare zone that holds your hostname is not its last two labels. For `git.example.com` the default zone is `example.com`, which is right; for `git.example.co.uk` the default would be `co.uk`, so set `DIFFINERY_ZONE` to `example.co.uk`.
- `MAIL_DOMAIN`, if email should come from another domain than your hostname, for example `example.com` to send from `notifications@example.com`.

The Deploy job runs on every push to `main` once the CI workflow passes on that commit, on GitHub or on a Diffinery instance, and whenever you start it by hand (`workflow_dispatch`). A mirror of a repository that already deploys would deploy too, on GitHub or on Diffinery, so keep Actions or the Cloudflare secrets off on such a mirror. The upstream project's older copy on diffinery.com, `codician/diffinery`, is skipped by name.

The workflow doesn't pass `BOOTSTRAP_ADMINS`. Set the list with a first deploy from your machine (`scripts/setup.sh`), or put it under `vars` in your copy's `wrangler.jsonc`; after that, workflow deploys keep it.

**Other workflows.** `ci.yml` (typecheck, unit tests and the Worker bundle) and `e2e.yml` (the end-to-end tests) work as they are. `live-test.yml` checks the upstream project's public instance, `diffinery.com`, and runs on its own after a deploy only there; delete it, or change its `DIFFINERY` host, for your own instance. `d1-replication.yml` is optional; see [Architecture](/docs/self-hosting/architecture#d1-and-read-replication). Any other workflow in `.github/workflows` is the upstream project's own maintenance, and you can delete it from your copy.

> **Note:** The scripts use fixed resource names: a D1 database `diffinery`, an R2 bucket `diffinery-data`, queues `diffinery-events`, `diffinery-events-dlq`, `diffinery-mail`, `diffinery-mail-dlq` and `diffinery-mail-events`, and a Worker `diffinery`. One Cloudflare account holds one instance unless you rename them in `scripts/bootstrap.sh` and `wrangler.jsonc`.

## Step 2: Create a Cloudflare API token

In the Cloudflare dashboard, create an API token (**My Profile → API Tokens → Create Token → Create Custom Token**) with these permissions:

| Kind | Permission | Level | Used for |
| --- | --- | --- | --- |
| Account | Workers Scripts | Edit | Deploying the Worker, Durable Objects and secrets |
| Account | D1 | Edit | Creating the database and applying migrations |
| Account | R2 (Workers R2 Storage) | Edit | Creating the bucket and setting its lifecycle rules |
| Account | Queues | Edit | Creating the queues and consumers, and subscribing `diffinery-mail-events` to Email Sending's bounce and complaint events |
| Account | Workflows | Edit | The `diffinery-run` and `diffinery-import` Workflows |
| Account | Containers | Edit | Building and deploying the runner image for runners, sandboxes and imports |
| Account | Access: Apps and Policies | Edit | The Access application for `/auth/access` |
| Account | Turnstile | Edit | The Turnstile widget that lets people without an account send [security reports](/docs/security/disclosure) (the API reference calls it "Turnstile Sites Write"). Without it the deploy warns and goes on, and only people who are signed in can send reports. |
| Zone (the zone that holds your hostname, `DIFFINERY_ZONE`) | Workers Routes | Edit | The `git.example.com/*` route |
| Zone (your zone) | Zone Read | Read | `scripts/setup.sh` checks that the zone is in the account, and bootstrap finds the zone ID of your sending domain for the bounce and complaint subscription. Optional for the Deploy workflow. |
| Zone (your zone), optional | DNS Read, Email Sending Read | Read | Letting `scripts/email-sending.sh` check your Email Sending setup through the API. Without them it falls back to public DNS lookups. |

If the token can't read your Zero Trust organization, bootstrap can't discover your Access team domain on its own; set the `ACCESS_TEAM_DOMAIN` variable (next step).

Copy your **Account ID** from the dashboard (**Workers & Pages** overview, or any zone's overview page).

## Step 3: Add repository secrets and variables

In your copy's repository settings, add:

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | The API token from step 2. |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | Your Cloudflare account ID. |
| `DIFFINERY_DOMAIN` | Variable | Your hostname, for example `git.example.com`. Without it, the deploy targets `diffinery.com`. |
| `DIFFINERY_ZONE` | Variable, optional | The Cloudflare zone that holds the hostname, when it isn't the hostname's last two labels. |
| `MAIL_DOMAIN` | Variable, optional | The domain email is sent from, when it isn't `DIFFINERY_DOMAIN`. |
| `ACCESS_TEAM_DOMAIN` | Variable, optional | Your Zero Trust team domain, for example `example.cloudflareaccess.com`. Needed only when the token can't read it. |
| `DIFFINERY_GITHUB_APP_ID`, `DIFFINERY_GITHUB_APP_SLUG`, `DIFFINERY_GITHUB_APP_CLIENT_ID`, `DIFFINERY_GITHUB_APP_URL` | Variables, optional | The GitHub App of [GitHub runners](/docs/self-hosting/configuration#github-runners). The workflow passes them to render-config as `GITHUB_APP_ID` and the rest. |
| `DIFFINERY_RUNS_ON` | Variable, optional | The `runs-on` label of every job in the repository's workflows. Without it, jobs run on `ubuntu-latest` (in `codician-team/diffinery` itself, on `diffinery`, so pull requests from forks, which get no variables, run there too). Set it to `diffinery` to run them on a Diffinery instance's [GitHub runners](/docs/actions/github-runners) once that instance's GitHub App is installed on the repository. Set it back to `ubuntu-latest` to deploy while those runners can't start, for example while the instance itself is down. |

The Deploy job runs in an environment named `production`, so you can also store the secrets as environment secrets there and add required reviewers to that environment.

## Step 4: Run the Deploy workflow

Push to `main`, or start **Deploy** by hand (`workflow_dispatch`). The job takes up to 45 minutes; most of it is the first build of the runner image. Here is what each script does, so you can read its output.

### scripts/bootstrap.sh

Bootstrap needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and reads these optional variables:

| Variable | Default | Used for |
| --- | --- | --- |
| `DIFFINERY_DOMAIN` | `diffinery.com` | Your hostname: the Worker's route, `PUBLIC_URL` (`https://<DIFFINERY_DOMAIN>`), the Access application and the email sender. |
| `DIFFINERY_ZONE` | The hostname's last two labels | The Cloudflare zone the route is added to. Passed to render-config as `--zone`. |
| `MAIL_DOMAIN` | `DIFFINERY_DOMAIN` | The domain email is sent from (`notifications@<MAIL_DOMAIN>`) and that the Email Sending check looks at. |
| `ACCESS_TEAM_DOMAIN` | Discovered | Your Zero Trust team domain, when the token can't read it. |
| `BOOTSTRAP_ADMINS` | Kept from the deployed Worker | Comma-separated emails of the first site administrators. Passed to render-config as `--admins`. |

Each section prints a collapsible log group:

1. **D1 database.** Looks for a database named `diffinery` and creates it if missing.
2. **R2 bucket.** Creates `diffinery-data` if missing, then sets its lifecycle rules, which delete short-lived data (such as expired artifacts, old job logs and unfinished uploads) by age and never touch git objects, LFS objects or release assets. The rules are set on every deploy and replace any lifecycle rules you added in the dashboard. If they can't be set, or a rule would still delete git objects, bootstrap stops the deploy. See [R2](/docs/self-hosting/architecture#r2) for the rules.
3. **Queues.** Creates `diffinery-events`, `diffinery-events-dlq`, `diffinery-mail`, `diffinery-mail-dlq` and `diffinery-mail-events` if missing.
4. **Email Sending event subscription.** Subscribes `diffinery-mail-events` to Email Sending's `message.bounced` and `message.complained` events for `MAIL_DOMAIN` (default `DIFFINERY_DOMAIN`), through the Queues event subscriptions API, so bounces and complaints reach the [suppression list](/docs/admin/site-administration#where-bounces-and-complaints-come-from). It creates the subscription only when there is none for that domain and queue, and adds either event to one that lacks it. A failure here is only a warning that names the permission the token needs (Account → Queues → Edit, and Zone Read to find the zone); the deploy continues.
5. **Email Sending.** Runs `scripts/email-sending.sh` for `MAIL_DOMAIN` (default `DIFFINERY_DOMAIN`). A failure here is only a warning: the deploy continues and email is skipped until sending works.
6. **Turnstile.** Runs `scripts/turnstile.sh`, which looks for a Turnstile widget named `diffinery <DIFFINERY_DOMAIN>` in your account and creates it when there is none (managed mode, for your hostname only). Its site key becomes the Worker's `TURNSTILE_SITE_KEY` variable, so people without an account can send [security reports](/docs/security/disclosure); its secret key becomes the `TURNSTILE_SECRET` secret (see [scripts/ensure-secrets.sh](#scriptsensure-secretssh)). The token needs **Account → Turnstile → Edit** ("Turnstile Sites Write" in the API reference). Without it this is only a warning that names the permission: the deploy continues, and only people who are signed in can send reports. The keys don't open sign-up: that still takes `SIGNUP=open` (see [SIGNUP](/docs/self-hosting/configuration#signup)). If `wrangler.jsonc` sets `TURNSTILE_SITE_KEY` itself, the step leaves Turnstile to you.

   Worker secrets can't be read back, so the step tells which widget `TURNSTILE_SECRET` goes with by the `TURNSTILE_SITE_KEY` deployed with it. When they differ, for example because someone deleted the widget and the deploy created a new one, it replaces `TURNSTILE_SECRET` with the new widget's secret before the deploy. If it can't, it leaves `TURNSTILE_SITE_KEY` unset for this deploy, so anonymous reports stay refused instead of failing the check, and the next deploy tries again.
7. **Cloudflare Access.** Finds your team domain (from `ACCESS_TEAM_DOMAIN`, else from your Zero Trust organization through the API). Then it creates, or updates, a self-hosted Access application named **Diffinery account recovery** that covers only `<domain>/auth/access`, with a 15-minute Access session, an HTTP-only cookie and a policy that lets anyone who proves their email through. Diffinery, not Access, decides what that person may do. It also deletes an application named **Diffinery machine endpoints** left by older versions. If it still has no team domain, it requests `https://<domain>/auth/access` and reads the team domain from the Access redirect.
8. **Bootstrap administrators.** Runs `scripts/bootstrap-admins.sh`, which picks the `BOOTSTRAP_ADMINS` list: the environment variable when it isn't empty, else the value in `wrangler.jsonc` when that isn't empty, else the list the deployed `diffinery` Worker has, read from its settings through the API. It prints how many addresses it found and where, never the addresses. With no list anywhere (a new instance), it warns that nobody will become a site administrator and goes on. If the Worker's settings can't be read, it stops the deploy rather than replace the Worker's list with an empty one.
9. **Render config and migrate D1.** Runs `scripts/render-config.mjs` with the Turnstile site key in `TURNSTILE_SITE_KEY` (when the step above found one), `--public-url https://<DIFFINERY_DOMAIN>`, `--zone <DIFFINERY_ZONE>` (only when set), `--mail-from notifications@<MAIL_DOMAIN or DIFFINERY_DOMAIN>` and `--admins <list>`, and then `wrangler d1 migrations apply diffinery --remote -c wrangler.deploy.jsonc`.

At the end it prints `team=<team domain> aud=set` and, inside a workflow, writes `d1_id`, `access_team` and `access_aud_set` to the step outputs.

### scripts/render-config.mjs

```sh
node scripts/render-config.mjs --d1 <database id> [--team <x.cloudflareaccess.com>] [--aud <tag>] \
  [--public-url https://git.example.com] [--zone example.com] [--mail-from notifications@example.com] \
  [--admins you@example.com,ops@example.com]
```

It reads `apps/diffinery/wrangler.jsonc`, drops the `env` section (the `dev` environment) and `$schema`, and changes it as follows:

| Flag | Required | Effect on the deployed config |
| --- | --- | --- |
| `--d1 <database id>` | Yes | Sets the D1 `database_id`. Without it the script stops with `--d1 <database id> is required`. |
| `--team <team domain>` | No | Sets `ACCESS_TEAM_DOMAIN`. |
| `--aud <tag>` | No | Sets `ACCESS_AUD`. |
| `--public-url <origin>` | No | Sets `PUBLIC_URL` to the URL's origin, replaces `routes` with one route `<hostname>/*` in the zone from `--zone`, and sets `MAIL_FROM` to `notifications@<hostname>`. The URL must use `https://` and have no path, otherwise the script stops with `--public-url must be an https origin, like https://git.example.com`. |
| `--zone <zone>` | No | The zone for the route. Defaults to the hostname's last two labels (`git.example.com` gives `example.com`). Only used together with `--public-url`. |
| `--mail-from <address>` | No | Sets `MAIL_FROM`, overriding the `notifications@<hostname>` that `--public-url` sets. |
| `--admins <emails>` | No | Sets `BOOTSTRAP_ADMINS` to the comma-separated emails, trimmed. An empty value sets it empty; without the flag, the value in `wrangler.jsonc` stays. An entry that isn't an email address stops the script with `--admins takes comma-separated email addresses; not an email address: ...`. |

It also reads these environment variables:

- `RUNNER_IMAGE` (set by `scripts/runner-image.sh`) points every container at a prebuilt runner image and sets the `RUNNER_IMAGE` variable.
- `TURNSTILE_SITE_KEY` (set by bootstrap from `scripts/turnstile.sh`) sets the `TURNSTILE_SITE_KEY` variable, unless `wrangler.jsonc` already sets one.
- `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_URL` set the variables of the same names, for [GitHub runners](/docs/self-hosting/configuration#github-runners). One that is empty leaves the value in `wrangler.jsonc`. A value of the wrong shape stops the script with, for example, `GITHUB_APP_ID must be the App ID, a number`; the message never shows the value.

Without `--public-url`, the route, `PUBLIC_URL` and `MAIL_FROM` stay as they are in `wrangler.jsonc`. Bootstrap always passes `--public-url` and `--mail-from`, so a normal deploy takes them from `DIFFINERY_DOMAIN` and `MAIL_DOMAIN`.

For `DIFFINERY_DOMAIN=git.example.com` and `BOOTSTRAP_ADMINS=you@example.com`, the deployed config contains:

```json
{
  "routes": [{ "pattern": "git.example.com/*", "zone_name": "example.com" }],
  "vars": {
    "PUBLIC_URL": "https://git.example.com",
    "MAIL_FROM": "notifications@git.example.com",
    "BOOTSTRAP_ADMINS": "you@example.com"
  }
}
```

The script writes `apps/diffinery/wrangler.deploy.jsonc`, which every later `wrangler` command uses. That file is generated on each deploy and ignored by git; don't edit it.

### wrangler deploy

`pnpm exec wrangler deploy -c wrangler.deploy.jsonc` (run in `apps/diffinery`) deploys the Worker with all its bindings, and builds the runner image from `containers/runner/Dockerfile` (Ubuntu 24.04 with Node.js 22, git, git-lfs and the runner agent) for all three container classes: `RunnerContainer` (hosted jobs), `SandboxContainer` (agent sandboxes) and `ImportContainer` (the Git transfers of GitHub imports). It also applies Durable Object migrations the account doesn't have yet: tag `v1` creates `RepoDO`, `RunnerContainer` and `SandboxContainer`, tag `v2` creates `ImportContainer`, tag `v3` creates `ProjectDO`, tag `v4` creates `SchedulerDO`, tag `v5` creates the smaller runner classes, tag `v6` creates `ComposeDO`, tag `v7` creates `GitHubRunnersDO`, and tag `v8` creates `RateLimiterDO`.

### scripts/ensure-secrets.sh

Creates the Worker's own secrets once and never rotates them:

- `MASTER_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`). It is the root key for encrypting Actions secrets, signing unsubscribe links, and signing the tokens and links that workflow jobs use for caches and artifacts.
- `OIDC_PRIVATE_KEY`: a new ECDSA P-256 private key as a JWK, with a key ID like `diffinery-2026-10-13`. It signs workflow OIDC tokens.

It also sets `TURNSTILE_SECRET` when the deployed config has a `TURNSTILE_SITE_KEY` and the Worker has no `TURNSTILE_SECRET` yet (the first deploy with Turnstile): `scripts/turnstile.sh secret <site key>` reads that widget's secret key from the Cloudflare API. Without **Account → Turnstile → Edit** it warns and the deploy goes on.

Values are generated on the runner, or read from the Cloudflare API, and piped straight into `wrangler secret put`; they are never printed. The script lists existing secrets first and stops with `unexpected output from wrangler secret list` if it can't read them, rather than risk overwriting `MASTER_KEY`, which would make every stored Actions secret unreadable. It never sets or removes `MASTER_KEY_PREV`: you set that yourself while [rotating MASTER_KEY](/docs/self-hosting/configuration#rotating-master_key).

### Finishing Access on the first deploy

On a brand-new account, bootstrap may not find the team domain before the Worker exists. When its `access_team` output is empty, the workflow runs `scripts/bootstrap.sh` once more (which can now read the team domain from the live `/auth/access` redirect) and redeploys with `wrangler deploy -c wrangler.deploy.jsonc --containers-rollout none`.

### Checks after the deploy

The workflow then checks the live site:

- `/healthz` must answer `200` within 5 minutes (30 tries, 10 seconds apart). A new hostname can take a few minutes to get its certificate.
- `/login` must be the passkey sign-in page (it looks for "Sign in with a passkey") and its Kumo JavaScript and CSS bundles must load.
- `/auth/access` should redirect (`302`) to `https://<team>.cloudflareaccess.com/...`. If not, the job only warns.
- The favicon, web manifest, `robots.txt` and `sitemap.xml` must load, and the home page must carry its canonical, Open Graph and structured data tags.
- Responses must carry an `x-d1-bookmark` header, which shows that D1 queries run in sessions.

## Step 5: Set up email sending

Diffinery sends invitations, sign-in links, security alerts and notifications through Cloudflare Email Sending from `MAIL_FROM`, which the deploy sets to `notifications@<MAIL_DOMAIN>` (by default `notifications@<DIFFINERY_DOMAIN>`, for example `notifications@git.example.com`). Onboard the sending domain once in the Cloudflare dashboard: **Compute → Email Service → Email Sending → Onboard Domain**. Cloudflare adds the DNS records it needs: a bounce MX record and an SPF record on `cf-bounce.<domain>`, a DKIM record and a DMARC record.

`scripts/email-sending.sh` runs on every deploy (inside bootstrap) and changes nothing. It:

1. Finds the zone that holds the domain (the domain itself or a parent).
2. With Email Sending access on the token, checks that the domain is onboarded and compares every DNS record Email Sending asks for with what is published. Each record is printed as `ok` or `missing`. An existing DMARC policy of your own counts as `ok`.
3. Without that access, it checks the public DNS instead: the `cf-bounce.<domain>` MX record (pointing at `mx.cloudflare.net`), the `cf-bounce.<domain>` SPF record and `_dmarc.<domain>`.

It always exits successfully, so a missing record never blocks a deploy; it prints a warning instead. Set `MAIL_DOMAIN` if your sending domain differs from `DIFFINERY_DOMAIN`: it changes both the sender address and the domain this check looks at.

Once deployed, a site administrator can check delivery in **Settings → Email** (`/settings/admin/email`) or with:

```sh
curl -sS https://git.example.com/api/v3/diffinery/admin/email -H "Authorization: Bearer dfy_..."
```

`sending: true` means the Worker has the Email Sending binding; `last_24h` counts sent, failed and skipped emails. Click **Send me a test email** under **Settings → Notifications** to send yourself one.

## Step 6: DNS

Diffinery is served through a Workers route (`git.example.com/*` in the zone `DIFFINERY_ZONE`, by default the hostname's last two labels), not a Custom Domain. A route only runs for hostnames whose DNS record is proxied (orange cloud). If the hostname already has a record, turn on its proxy. If it has none, create a proxied record for it; Cloudflare's documentation suggests an `AAAA` record pointing at `100::` for a hostname that only a Worker serves.

If the smoke test fails with `/healthz did not return 200`, this record is the first thing to check.

## Step 7: Sign in as the first administrator

Diffinery has no passwords and no open sign-up. The first administrator signs in through the email check at `/auth/access`:

1. Open `https://git.example.com/auth/access`.
2. Cloudflare Access asks for your email and sends you a one-time code. Enter it.
3. Access sends you back to Diffinery with a signed assertion. Diffinery checks it against `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, then finds or creates the account for that email. Because your email is in `BOOTSTRAP_ADMINS`, the new account is active and a site administrator. Your username is taken from the part of the email before `@`.
4. You land on **Settings → Passkeys and sessions** with the message "You're signed in. Add a passkey now so you can sign in directly next time." Add a passkey.

From then on, sign in at `/login` with your passkey, and invite everyone else from **Settings → People and invitations** or with `diffinery invite`. Someone whose email is not in `BOOTSTRAP_ADMINS` and who has no invite gets an account that waits for an invite ("Waiting for an invite"). They can send an access request, which a site administrator approves under **Pending access requests** in **Settings → People and invitations**.

`BOOTSTRAP_ADMINS` only applies when an account is created, or when an account that is still waiting for an invite signs in through `/auth/access`. Changing it later does not promote or demote existing accounts.

## Step 8: Cloudflare Access for /auth/access

Access guards only `/auth/access`. Everything else (the web UI, git, the REST API, MCP, runners, the registry) reaches the Worker directly, so Access never gets in the way of tokens or passkeys.

- **Login methods.** Access's one-time PIN by email works with no setup. You can add more identity providers under **Zero Trust → Settings → Authentication** (for example GitHub); Diffinery uses the email address Access reports.
- **Who gets in.** The application's policy allows everyone who proves an email address. Diffinery then decides: a known account gets a session, a `BOOTSTRAP_ADMINS` email becomes an admin, anyone else waits for an invite, and disabled accounts are refused.
- **Settings Diffinery needs.** `ACCESS_TEAM_DOMAIN` (like `example.cloudflareaccess.com`) and `ACCESS_AUD` (the application's audience tag). Bootstrap sets both in the deployed config. If either is empty, `/auth/access` answers "Account recovery by email is not set up on this instance. Ask an administrator for a sign-in link." and the sign-in page doesn't offer email recovery.
- **Finding the team domain.** In the Zero Trust dashboard, **Settings → Custom pages** shows it. Set it as the `ACCESS_TEAM_DOMAIN` repository variable if bootstrap can't find it.

## Deploy from your own machine

`scripts/setup.sh` deploys from a clone of the repository, for the first time and for every update. It needs the tools listed in [What you need](#what-you-need) and the API token from [step 2](#step-2-create-a-cloudflare-api-token). Run it in a terminal and it asks for what isn't in the environment (the token without echoing it), or set everything up front:

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
export DIFFINERY_DOMAIN=git.example.com
export BOOTSTRAP_ADMINS=you@example.com                    # empty keeps the deployed Worker's list
# export DIFFINERY_ZONE=example.com                        # if the zone isn't the hostname's last two labels
# export MAIL_DOMAIN=example.com                           # to send email from another domain
# export ACCESS_TEAM_DOMAIN=example.cloudflareaccess.com   # if the token can't read it

scripts/setup.sh --dry-run   # checks everything and changes nothing
scripts/setup.sh             # deploys
```

`pnpm setup:cloudflare` runs the same script.

| Option | Effect |
| --- | --- |
| `--dry-run` | Checks the tools, the token and the zone (read-only calls, skipped without a token), installs and builds, renders `apps/diffinery/wrangler.deploy.jsonc` with a placeholder D1 database ID and a placeholder runner image, and runs `wrangler deploy --dry-run` on it, which bundles the Worker and validates the config. It prints the route, `PUBLIC_URL`, `MAIL_FROM` and how many `BOOTSTRAP_ADMINS` addresses the deploy would set. It creates, changes and deploys nothing. |
| `--yes`, `-y` | Never asks: every setting comes from the environment, and a missing required one stops the script. Without a terminal it never asks either. |
| `--help`, `-h` | Prints the usage. |

Before it changes anything, the script:

1. Checks for Node.js 22 or later, pnpm, `jq`, `curl`, `openssl` and a running Docker daemon.
2. Checks that `DIFFINERY_DOMAIN` is a bare hostname, that `DIFFINERY_ZONE` holds it and that `BOOTSTRAP_ADMINS` lists email addresses.
3. Verifies the API token (`GET /user/tokens/verify`, or the account's `/accounts/<id>/tokens/verify` for an account-owned token) and checks that the zone is in the account.

Then it runs the Deploy workflow's steps, in order: `pnpm install --frozen-lockfile`, `pnpm -r --if-present build`, `scripts/runner-image.sh`, `scripts/bootstrap.sh`, `wrangler deploy -c wrangler.deploy.jsonc`, `scripts/wait-container-rollout.sh` and `scripts/ensure-secrets.sh`. When bootstrap found no Access team domain, it runs bootstrap again and redeploys with `--containers-rollout none`, as in [Finishing Access on the first deploy](#finishing-access-on-the-first-deploy). Last, it checks that `https://<DIFFINERY_DOMAIN>/healthz` answers `200` (for up to 5 minutes), that `/login` is the passkey sign-in page and that `/auth/access` redirects to Cloudflare Access, and tells you where to sign in. Every step creates only what is missing, so run it again to update; secrets are never printed.

## Updating

To update, bring your copy up to date with upstream and run `scripts/setup.sh` again, or run Deploy (or push to `main` if your workflow deploys on push).

`main` is always deployable, and diffinery.com runs it. To stay on a named version instead, check out its tag before you deploy, for example `git fetch --tags && git checkout v0.2.0`. Each version's changes, including new settings and migrations, are in [CHANGELOG.md](https://github.com/codician-team/diffinery/blob/main/CHANGELOG.md) and on the [releases page](https://github.com/codician-team/diffinery/releases). Versions only move forward: D1 migrations can't be undone, so don't deploy an older version over a newer one.

Each run:

- Creates nothing that already exists and keeps your D1 data, R2 data, secrets, Access application and, unless you set `BOOTSTRAP_ADMINS`, the deployed `BOOTSTRAP_ADMINS` list.
- Applies new D1 migrations before the new Worker goes live. For example, `0010_imports.sql` adds the tables for GitHub imports, linked GitHub accounts and organization variables.
- Rebuilds the documentation from the Markdown files in your copy, so `/docs` matches the code you deploy.
- Rolls out a new runner image. The first sandbox started on a machine after a deploy pulls the new image first, so it can take a few minutes to start; Diffinery waits up to 3 minutes for it. Running hosted jobs and imports keep their containers until they finish, and the next ones start on the new image. A sandbox up for more than an hour is replaced.

Keep `MASTER_KEY` safe and don't simply replace it: it decrypts every stored Actions secret (repository, organization and environment secrets), unsubscribe links in emails already sent are signed with it, and so are the cache and artifact tokens of jobs that are running. To change it, keep the old key as `MASTER_KEY_PREV` as described in [Rotating MASTER_KEY](/docs/self-hosting/configuration#rotating-master_key). If you delete `OIDC_PRIVATE_KEY`, the next deploy generates a new key with a new key ID; systems that trust your OIDC tokens fetch the new public key from `/.well-known/jwks`.

## Local development

You can run Diffinery on your machine with `wrangler dev`, which simulates D1, R2, Queues, Durable Objects and Workflows locally.

```sh
pnpm install
pnpm -r build
pnpm --filter @diffinery/app db:migrate:local
pnpm dev
```

`pnpm dev` runs `wrangler dev -e dev` in `apps/diffinery` and serves `http://localhost:8787`. The `dev` environment differs from production:

| | Production | `dev` environment |
| --- | --- | --- |
| `PUBLIC_URL` | `https://git.example.com` | `http://localhost:8787` |
| Sign-in | Passkeys, tokens, `/auth/access` | Any request without credentials acts as `dev@diffinery.local` (`DEV_AUTH`), who is a site administrator. Tokens still work. |
| D1, R2, queues, Workflows | `diffinery`, `diffinery-data`, `diffinery-events`, `diffinery-mail`, `diffinery-run`, `diffinery-import` | `diffinery-dev`, `diffinery-data-dev`, `diffinery-events-dev`, `diffinery-mail-dev`, `diffinery-run-dev`, `diffinery-import-dev`, all local |
| Containers | Hosted runners, sandboxes and import transfers | None. `runs-on: ubuntu-latest` jobs and sandboxes can't start; use a self-hosted runner. A GitHub import waits for you to run its Git transfer by hand (`IMPORT_GIT_AGENT=external`; see [The dev environment](/docs/self-hosting/configuration#the-dev-environment)). |
| Cron | Every 5 minutes | None |
| Email | Sent | Captured by Miniflare, not delivered. `GET /api/v3/diffinery/emails` shows each full message. |
| `MASTER_KEY` | Set by `ensure-secrets.sh` | Not set: storing Actions secrets fails, and jobs can't use caches or artifacts, until you add one. |

To store secrets locally, put a key in `apps/diffinery/.dev.vars` (ignored by git):

```sh
echo "MASTER_KEY=$(openssl rand -base64 32)" > apps/diffinery/.dev.vars
```

To run workflow jobs locally, use `runs-on: [self-hosted, linux]` in the workflow and start a runner with the CLI against your local instance. It needs a token (create one without credentials, as the dev user) and the runner agent built by `pnpm -r build`:

```sh
export DIFFINERY_URL=http://localhost:8787
export DIFFINERY_TOKEN=$(curl -sS -X POST http://localhost:8787/api/v3/diffinery/tokens \
  -H "content-type: application/json" --data '{"name":"local","scopes":["admin"]}' | jq -r .token)
diffinery runner -R dev/website --labels linux --agent containers/runner/dist/agent.mjs
```

### Tests

```sh
pnpm -r build && pnpm -r typecheck && pnpm -r test
pnpm --filter @diffinery/app exec playwright install --with-deps chromium
pnpm --filter @diffinery/app e2e
```

The end-to-end tests start a real `wrangler dev` with fresh local state, push and clone with the real `git`, run workflow jobs with the real runner agent as a self-hosted runner, and drive passkey sign-in in Chromium with a virtual authenticator. They need `git` installed. Set `E2E_RUNNER_IMAGE` to a built runner image to run jobs inside Docker instead, and `E2E_KEEP=1` to keep the temporary directory for debugging.

## Troubleshooting

| Message | Where | What to do |
| --- | --- | --- |
| `set CLOUDFLARE_API_TOKEN` or `set CLOUDFLARE_ACCOUNT_ID` | bootstrap, email check, setup | Add the secrets (step 3), or export them for a deploy from your machine. |
| `missing: ...`, `Node.js 22 or later is needed` or `docker is installed but its daemon isn't running` | setup | Install the tools listed in [What you need](#what-you-need), or start Docker, and run it again. |
| `Cloudflare doesn't accept the API token: ...` | setup | The token is wrong, expired or not active. Create one as in step 2; the text after the colon is Cloudflare's error. |
| `the zone example.com isn't in account ..., or the token can't see it.` | setup | Add the domain to the account, give the token Zone Read on it, or set `DIFFINERY_ZONE` when the zone that holds your hostname is another one. |
| `BOOTSTRAP_ADMINS is empty: ..., so nobody becomes a site administrator on first sign-in.` | bootstrap (warning) | Deploy again with `BOOTSTRAP_ADMINS=you@example.com`. Until then, nobody can sign in as an administrator. |
| `Could not read the diffinery Worker's settings to keep its BOOTSTRAP_ADMINS, so the deploy stops ...` | bootstrap | Add Workers Scripts Edit to the token, or set `BOOTSTRAP_ADMINS` for this deploy. Nothing was changed. |
| `--admins takes comma-separated email addresses; not an email address: ...` | render-config | `BOOTSTRAP_ADMINS` holds something that isn't an email address, such as a username. Only email addresses make administrators. |
| `could not create D1 database (does the token have D1: Edit?)` | bootstrap | Add D1 Edit to the token. |
| `could not create R2 bucket (R2 enabled? token has R2: Edit?)` | bootstrap | Enable R2 on the account (dashboard, R2) and add R2 Edit to the token. |
| `could not set the R2 lifecycle rules (token has R2: Edit?): ...` | bootstrap | Add R2 Edit to the token. The text after the colon is Cloudflare's error. The deploy stops here, because the bucket's rules weren't confirmed. |
| `an R2 lifecycle rule still deletes objects under repos/ (git objects, LFS); refusing to continue` | bootstrap | The rules were set, but reading them back still shows a rule that would delete git or LFS objects. Check the lifecycle rules of the `diffinery-data` bucket in the Cloudflare dashboard, remove the rule that covers `repos/` or the whole bucket, and rerun the deploy. |
| `could not create queue diffinery-events (token has Queues: Edit?)` | bootstrap | Add Queues Edit to the token. |
| `Could not read Access applications (token needs Access: Apps and Policies Edit). Passkeys work; email recovery stays off.` | bootstrap | Add Access: Apps and Policies Edit. Until then nobody can use `/auth/access`, so the first administrator can't sign in. |
| `Could not create the Access application; email recovery stays off.` | bootstrap | Check that the account has a Zero Trust organization and that the token has Access: Apps and Policies Edit. |
| `Access team domain unknown; set the ACCESS_TEAM_DOMAIN repository variable (Zero Trust → Settings → Custom pages shows it).` | bootstrap | Set the variable and deploy again. |
| `Email Sending check failed; email may not be delivered.` | bootstrap | Read the email check's output above it. |
| `Could not subscribe diffinery-mail-events to Email Sending's bounce and complaint events for git.example.com. The token needs Account → Queues → Edit ...` (or `Could not read the queue's event subscriptions ...`) | bootstrap (warning) | Add Queues Edit to the token, check that the domain is onboarded to Email Sending, and deploy again; the text at the end is Cloudflare's error. Or subscribe the queue by hand once, see [Site administration](/docs/admin/site-administration#where-bounces-and-complaints-come-from). Until then, bounces and complaints don't reach the suppression list. |
| `Could not find the Cloudflare zone for git.example.com (the token needs Zone → Zone → Read on it), so diffinery-mail-events isn't subscribed ...` | bootstrap (warning) | Add Zone Read for the zone of your sending domain, or subscribe the queue by hand. |
| `Could not read the account's Turnstile widgets ... The token needs Account → Turnstile → Edit ...` (or `Could not create the Turnstile widget "diffinery git.example.com" ...`) | bootstrap (warning) | Add Turnstile Edit to the token and deploy again; the text at the end is Cloudflare's error. Until then, only people who are signed in can send security reports. |
| `TURNSTILE_SECRET goes with another Turnstile widget and couldn't be replaced, ...` | bootstrap (warning) | The widget was created again and its secret key couldn't be read or stored (the warning before it says why). This deploy leaves `TURNSTILE_SITE_KEY` unset; fix the cause and deploy again. |
| `TURNSTILE_SECRET is not set, so only people who are signed in can send security reports.` | ensure-secrets (warning) | Its secret key couldn't be read or stored; the warning before it says why. Add Turnstile Edit to the token and deploy again. |
| `Could not find the Cloudflare zone for git.example.com (the token needs Zone Read on it).` | email check | Add Zone Read for the zone, or ignore it if you don't send email yet. |
| `git.example.com is not onboarded to Email Sending, so no email will be delivered.` | email check | Onboard the domain (step 5). |
| `Some Email Sending DNS records for git.example.com are missing, so mail may not be delivered.` | email check | Finish onboarding in the dashboard; the lines marked `missing` name the records. |
| `unexpected output from wrangler secret list` | ensure-secrets | Wrangler couldn't list the Worker's secrets (usually a token permission or a failed deploy). Fix that and rerun; nothing was overwritten. |
| `--public-url must be an https origin, like https://git.example.com` | render-config | `DIFFINERY_DOMAIN` (or the `--public-url` you passed) isn't a bare hostname. Set it to a hostname such as `git.example.com`, without a scheme or a path. |
| `--d1 <database id> is required` | render-config | You ran the script by hand without `--d1`. Pass the D1 database ID that bootstrap prints. |
| `https://.../healthz did not return 200 ... Check that the ... DNS record is proxied (orange cloud).` | smoke test | Check the DNS record (step 6) and the route in `wrangler.deploy.jsonc`: its pattern must be your hostname and its `zone_name` the zone that holds it (set `DIFFINERY_ZONE` if not). A new certificate can take a few minutes; rerun the workflow. |
| `/login is not the Diffinery sign-in page` | smoke test | Another service answers on the hostname. Check `DIFFINERY_DOMAIN`, `DIFFINERY_ZONE` and the route in `wrangler.deploy.jsonc`. |
| `/auth/access is not behind Cloudflare Access yet, so email recovery and first admin sign-in will not work` | smoke test (warning) | Check the Access step's output; the application must cover `<hostname>/auth/access`. |
| `/security/report has no Turnstile, so only people who are signed in can send security reports` | smoke test (warning) | The Turnstile step warned earlier in the deploy (see its message), or the operator's own `TURNSTILE_SITE_KEY` is set without `TURNSTILE_SECRET`. |
| `D1 queries don't run in a session (no x-d1-bookmark header)` | smoke test | The request to `/sitemap.xml` failed or the deployed Worker isn't the one you just built. Check that `wrangler deploy` succeeded and look at the Worker's logs. |
| "Account recovery by email is not set up on this instance. Ask an administrator for a sign-in link." | `/auth/access` | `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty in the deployed config. Fix the Access step and redeploy. |
| "Cloudflare Access sign-in was rejected: audience mismatch" (or `issuer mismatch`) | `/auth/access` | The deployed `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` doesn't match the Access application. Rerun Deploy so bootstrap writes the current values. |
| "Waiting for an invite" after the email check | Web UI | Your email isn't in `BOOTSTRAP_ADMINS` and nobody invited you. Deploy again with your email in `BOOTSTRAP_ADMINS` (for example `BOOTSTRAP_ADMINS=you@example.com scripts/setup.sh`), and sign in through `/auth/access` again. |
| `docs: N problem(s):` followed by a list | Build | A Markdown page under `apps/diffinery/docs` has missing or overlong frontmatter, uses an H1, or isn't listed in `docs/nav.json` (or the other way round). Fix the listed pages; each line names the file. |
| `could not store the secret: ... (is MASTER_KEY configured?)` | Repository settings | `MASTER_KEY` is missing. Run `scripts/ensure-secrets.sh`, or add it to `.dev.vars` locally. |
| `The cache service is not available to this job; skipping.` or `The artifact service is not available to this job.` | Workflow job logs | `MASTER_KEY` is missing, so jobs get no cache and artifact token. Run `scripts/ensure-secrets.sh`, or add it to `.dev.vars` locally. |
| `OIDC is not configured on this Diffinery instance` | Workflow jobs with `id-token: write` | `OIDC_PRIVATE_KEY` is missing. Run `scripts/ensure-secrets.sh`. |
| `no import container is configured (IMPORTER binding)` | A GitHub import's error | The deployed config has no `IMPORTER` Durable Object binding or `ImportContainer` container. Restore them from `wrangler.jsonc` and deploy again. |
| `the Git transfer did not finish within 6 hours` | A GitHub import's error | Copying the repository's Git data took longer than the 6-hour limit. Lower `IMPORT_MAX_REPO_KB` so that repositories this large are refused before they start, and move them another way (for example a mirror push in several steps). See [Configuration](/docs/self-hosting/configuration#github-imports). |
