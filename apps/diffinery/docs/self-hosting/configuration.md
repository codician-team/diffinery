---
title: Configuration
description: Every setting of a self-hosted Diffinery: Worker variables and secrets, bindings, the dev environment, the deploy workflows' secrets, and rotating MASTER_KEY with MASTER_KEY_PREV.
---

A Diffinery instance is configured in four places: Worker variables in `apps/diffinery/wrangler.jsonc`, Worker secrets set with `wrangler secret put`, the Cloudflare bindings in the same `wrangler.jsonc`, and the secrets and variables of the repository whose workflows deploy it. This page lists every setting, its default and what it changes. To deploy for the first time, follow [Deploy your own Diffinery](/docs/self-hosting/deploy).

## Where configuration lives

| File or place | What it holds | Edit it? |
| --- | --- | --- |
| `apps/diffinery/wrangler.jsonc` | Worker name, route, variables, bindings, container settings, cron, and the `dev` environment. | Yes. This is the source of truth. |
| `apps/diffinery/wrangler.deploy.jsonc` | `wrangler.jsonc` without the `dev` environment, plus the real D1 database ID, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `TURNSTILE_SITE_KEY`, and the route, `PUBLIC_URL` and `MAIL_FROM` for your hostname. Written by `scripts/render-config.mjs` on every deploy and ignored by git. | No. It is regenerated on each deploy. |
| Worker secrets | `MASTER_KEY` and `OIDC_PRIVATE_KEY`, created by `scripts/ensure-secrets.sh`; `TURNSTILE_SECRET`, set by the deploy from its Turnstile widget; and optionally `GITHUB_OAUTH_CLIENT_SECRET`, which you set yourself. | Only to restore them, or to add the optional one. Never change `MASTER_KEY`. |
| Repository secrets and variables | Cloudflare credentials and options for the Deploy workflow, and a token for the live test. | Yes, in your forge's repository settings. |
| `apps/diffinery/wrangler.celld.jsonc` | `wrangler.jsonc` as [celld](/docs/self-hosting/celld) takes it, with the Cloudflare-only keys left out and the secrets in `vars`. Written by `scripts/celld-config.mjs` and ignored by git. | No. Render it again after changing `wrangler.jsonc`. |
| `apps/diffinery/.dev.vars` | Local secrets for `wrangler dev`, such as `MASTER_KEY`. Ignored by git. | Yes, for local development only. |

## Worker variables

Set under `vars` in `wrangler.jsonc`. All values are strings.

| Variable | Production value in the repository | Required | What it does |
| --- | --- | --- | --- |
| `PUBLIC_URL` | `https://diffinery.com` | Yes | The canonical origin of the instance. See [PUBLIC_URL](#public_url). On deploy, `scripts/bootstrap.sh` replaces it with `https://$DIFFINERY_DOMAIN` (default `https://diffinery.com`), whatever `wrangler.jsonc` says. |
| `MAIL_FROM` | `notifications@diffinery.com` | No | Sender address of every email. The display name is "Diffinery", or `<actor> (Diffinery)` for emails about someone's action. On deploy, `scripts/bootstrap.sh` replaces it with `notifications@$MAIL_DOMAIN` (default `notifications@$DIFFINERY_DOMAIN`). When empty, Diffinery sends from `notifications@<hostname of PUBLIC_URL>`. The domain must be onboarded to Email Sending, or, with `SMTP_URL`, be one your SMTP server lets you send from. |
| `SMTP_URL` | Not set | No | The SMTP server email goes through when the Worker has no `EMAIL` binding, such as an instance outside Cloudflare: `smtps://<user>@<host>:465` or `smtp://<user>@<host>:587`. The password goes in the `SMTP_PASSWORD` secret. See [SMTP](#smtp). |
| `BOOTSTRAP_ADMINS` | Empty (set on deploy) | For the first sign-in | Emails (case-insensitive) that become site administrators. On deploy, `scripts/bootstrap.sh` sets it from the `BOOTSTRAP_ADMINS` environment variable, else keeps the deployed Worker's list. See [BOOTSTRAP_ADMINS](#bootstrap_admins). |
| `ACCESS_TEAM_DOMAIN` | Empty (filled in on deploy) | For email sign-in | Your Cloudflare Zero Trust team domain, like `example.cloudflareaccess.com`. Used to fetch the Access signing keys and to check the token issuer. |
| `ACCESS_AUD` | Empty (filled in on deploy) | For email sign-in | The audience tag of the Access application that guards `/auth/access`. |
| `ARTIFACT_QUOTA_BYTES` | Not set | No | Workflow artifact storage per repository, in bytes: artifacts that haven't expired plus uploads in progress. Default `10737418240` (10 GB). Anything that isn't a positive whole number counts as not set. Add it under `vars` in `wrangler.jsonc`; the deploy keeps it. When a repository reaches it, uploads fail with `413 the repository's artifact storage quota (N bytes) is used up; delete artifacts or wait for them to expire`. See [Caches and artifacts](/docs/reference/limits#caches-and-artifacts). |
| `DEV_AUTH` | Not set in production; `dev@diffinery.local` in the `dev` environment | Never in production | Local development only. See [DEV_AUTH](#dev_auth). |
| `SIGNUP` | Not set | No | `open` lets anyone create an account at `/signup`. See [SIGNUP](#signup). Any other value, or none, keeps the instance invite-only. |
| `TURNSTILE_SITE_KEY` | Set by the deploy | With `SIGNUP=open`; for anonymous security reports, [early access requests](/docs/accounts/early-access) and [contact messages](/docs/admin/contact-form) | The site key of the Cloudflare Turnstile widget on the sign-up page, the [security report form](#security-contact), the early access form and the contact form. The deploy creates the widget and sets this; see [Turnstile](#turnstile). Setting it doesn't open sign-up. |
| `IMPORT_MAX_REPO_KB` | Not set | No | The largest GitHub repository a one-repository import accepts, in KB as GitHub reports a repository's `size`. Default `10485760` (10 GB). An empty value, `0`, a negative number or text that isn't a number counts as not set. A larger source is refused before the import starts with `422 the repository is about N GB, over the M GB import limit; ask an administrator to raise IMPORT_MAX_REPO_KB or split the repository`. See [GitHub imports](#github-imports). |
| `QUOTA_HOSTED_MINUTES`, `QUOTA_HOSTED_JOBS`, `QUOTA_SANDBOXES`, `QUOTA_REPOSITORIES`, `QUOTA_STORAGE_BYTES` | Not set | No | The default per-account quotas: hosted minutes per month (default `3000`), hosted Actions jobs at once (`20`), agent sandboxes open at once (`5`), repositories (`500`) and storage in bytes (`10737418240`, 10 GB). `-1` is unlimited; text that isn't a whole number counts as not set. Site administrators change them for one account with `PATCH /api/v3/admin/accounts/{login}/quotas`, and accounts run by a site administrator have none. See [Limits](/docs/reference/limits#account-quotas). |
| `HOSTED_JOBS_LIMIT` | Not set | No | Hosted Actions jobs the whole instance runs at once (default `80`); one account runs at most half of them, accounts run by a site administrator included. Keep it under the runner container classes' `max_instances`. Past it, hosted jobs wait as queued until one finishes. See [Limits](/docs/reference/limits#actions). |
| `IMPORT_GHE_HOST` | Not set | No | The host name of a GitHub Enterprise Server (like `ghe.example.com`) that imports may download release assets from. Without it, imports download release assets only from github.com and its asset hosts, and assets of an Enterprise import are skipped with a warning. |
| `GITHUB_OAUTH_CLIENT_ID` | Not set | No | The client ID of a GitHub OAuth app, for linking GitHub accounts with a GitHub sign-in instead of a gist. Needs `GITHUB_OAUTH_CLIENT_SECRET` too. See [GitHub imports](#github-imports). |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID` | Not set | No | The GitHub App that lets GitHub repositories run jobs on this instance's hosted runners: its App ID, its slug (the last part of `https://github.com/apps/<slug>`) and its Client ID. Needs `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_WEBHOOK_SECRET` too. See [GitHub runners](#github-runners). |
| `GITHUB_APP_URL` | Not set | No | The origin of a GitHub Enterprise Server for that app, like `https://ghe.example.com`. Default `https://github.com`. |
| `IMPORT_GIT_AGENT` | Not set in production; `external` in the `dev` environment | Never in production | With `external`, an import's Git transfer doesn't start a container: it waits for an import agent started by hand (see [The dev environment](#the-dev-environment)). |
| `SCHEDULE_TICK_MINUTES` | Not set | No | Minutes between the workflow scheduler's checks, a whole number from 1 to 60. Default `5`, GitHub's shortest schedule interval. Anything else counts as not set. The end-to-end tests use `1`. |
| `WAIT_TIMER_MINUTE_MS` | Not set | Never in production | Local development and the end-to-end tests only: how long one minute of a deployment environment's wait timer lasts, in milliseconds, from 1 to `60000` (the default). Anything else counts as not set. It counts only when `PUBLIC_URL` is on this machine (`localhost`, `127.x` or `[::1]`) and `ACCESS_AUD` is empty, as for `DEV_AUTH`; a deployed Worker ignores it. The end-to-end tests use `10000` so a wait timer passes in seconds. |
| `AGENT_POLL_MS` | Not set | Never in production | The end-to-end tests only: how often a running agent task is checked, in milliseconds, from `200` to `3000` (the default). Like `WAIT_TIMER_MINUTE_MS`, it counts only on a Worker on this machine; a deployed Worker ignores it. |
| `TERMINAL_POLL_MS` | Not set | Never in production | The end-to-end tests only: how often open web terminals are checked for their limits and their agent's access, in milliseconds, from `2000` to `60000` (the default). It counts only on a Worker on this machine; a deployed Worker ignores it. |
| `EGRESS` | Not set | No | `web` limits hosted Actions jobs and agent sandboxes (including tasks, reviews and terminals) to HTTP and HTTPS (ports 80 and 443) and DNS. Any other value, or none, leaves them open to the whole internet. Accounts run by a site administrator stay open. See [EGRESS](#egress). |
| `RUNNER_IMAGE` | Set by the deploy | No | The runner image's name and tag (for example `diffinery-runner:96dbbe31790f`), as jobs report it in `runner.image`. `scripts/render-config.mjs` sets it when the deploy uses a prebuilt runner image, and `GET /api/v3/meta` returns it as `runner_image` (`null` when not set). Don't set it by hand. |
| `SECURITY_CONTACT` | Not set | No | More places people can report a vulnerability in your instance, listed in `/.well-known/security.txt` after the instance's own report form (`/security/report`): an email address or an `https://` URL, several separated by commas. See [Security contact](#security-contact). |
| `MCP_REGISTRY_AUTH` | Not set | No | The proof record served at `/.well-known/mcp-registry-auth`, such as `v=MCPv1; k=ed25519; p=<public key>`, so you can publish your instance's MCP server to the official MCP registry under your domain. Not set, that path is a 404. See [List your instance in the MCP registry](/docs/agents/mcp#list-your-instance-in-the-mcp-registry). |
| `INDEXNOW` | Not set | No | `off` stops telling search engines about new, changed and removed public pages through IndexNow. Not set, or anything else, it is on whenever `PUBLIC_URL` is a public `https` origin and `MASTER_KEY` is set. Turn it off for an instance search engines can't reach. See [Search engines](/docs/admin/site-administration#search-engines). |
| `TERMINALS` | Not set | No | `off` switches [terminals](/docs/agents/terminal) off: nobody can open one, and open ones end at their next check, within a minute. Anything else, or not set, leaves them on. |
| `RATE_LIMITS` | Not set | Where the `ratelimits` bindings don't exist, such as celld, the open-source Workers runtime | `durable` counts requests in the `RATE_LIMITER` Durable Object for each rate limit whose binding (`RL_AUTH`, `RL_ANON`, `RL_ACCOUNT`, `RL_CREATE`, `RL_MODEL`) is missing, with the same limits. A limit that has its binding keeps using it. Anything else, or not set, lets requests through where a binding is missing. Leave it unset on Cloudflare and in local development. See [Rate limits](/docs/self-hosting/architecture#rate-limits). |

When either `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty, email sign-in at `/auth/access` is off: the page answers "Account recovery by email is not set up on this instance. Ask an administrator for a sign-in link.", and the sign-in page doesn't offer **Recover your account by email**. Passkeys, invitations and admin sign-in links keep working, but the first administrator can't sign in, because email sign-in is how an account in `BOOTSTRAP_ADMINS` is created.

### PUBLIC_URL

`PUBLIC_URL` must be the exact origin people and tools use, with `https://` and no path. You don't set it by hand for a deploy: `scripts/render-config.mjs` sets it from `--public-url`, which bootstrap fills in as `https://<DIFFINERY_DOMAIN>`, and refuses a URL that isn't `https://` or has a path (`--public-url must be an https origin, like https://git.example.com`). The same flag points the Worker's route at that hostname, so the route and `PUBLIC_URL` always agree. Diffinery uses it for:

- **Passkeys.** The WebAuthn relying party ID is the hostname of `PUBLIC_URL`, and the expected origin is its origin. Passkeys only work on that hostname.
- **Every generated link:** emails, invitation and sign-in links, `html_url` and `clone_url` in API responses, webhook payloads, check run details links, the sitemap and canonical tags.
- **Workflows:** `github.server_url` is `PUBLIC_URL`, `github.api_url` is `PUBLIC_URL/api/v3`, and the runner agent and sandboxes call back to it.
- **OIDC:** the issuer (`iss`) of workflow ID tokens, and their default audience.
- **The container registry host name**, the hostname of `PUBLIC_URL` (images are `<hostname>/<owner>/<name>`).
- **The cross-site check:** a cookie-authenticated write with an `Origin` other than this origin is refused.

> **Important:** Changing `PUBLIC_URL` on a running instance (by deploying with another `DIFFINERY_DOMAIN`) breaks every existing passkey (they are bound to the old hostname), changes the OIDC issuer that cloud providers trust, and changes every image name. Choose the hostname before your first sign-in.

### BOOTSTRAP_ADMINS

A comma-separated list of email addresses; spaces around entries are ignored and matching is case-insensitive. Logins in the list are ignored, because anyone could pick a free login, while an email address has to be proven (by email sign-in or by opening the link in an invitation email).

You don't keep the list in the repository. Each deploy sets it (`scripts/bootstrap-admins.sh`, run by bootstrap), from the first of these that isn't empty:

| Source | Example |
| --- | --- |
| The `BOOTSTRAP_ADMINS` environment variable | `BOOTSTRAP_ADMINS=you@example.com scripts/setup.sh` |
| `BOOTSTRAP_ADMINS` under `vars` in `wrangler.jsonc` | A copy that keeps its list in the file. The repository leaves it empty. |
| The list the deployed `diffinery` Worker has | Read from the Worker's settings (`GET /accounts/<id>/workers/scripts/diffinery/settings`), so a deploy that doesn't set it, such as the Deploy workflow, keeps it. |

With none of them (a brand-new instance), the deploy warns that nobody will become a site administrator. If the Worker's settings can't be read, the deploy stops instead of replacing its list with an empty one. The deploy logs say how many addresses it set, never the addresses.

An account becomes a site administrator from this list only when it is created (through email sign-in at `/auth/access`, by joining from an invitation or through open sign-up, or through `DEV_AUTH` locally), or when an account that is still waiting for an invite signs in through `/auth/access`. Accounts that already exist are not promoted or demoted when you change the list later, and there is no page for granting or removing site administration. See [Site administration](/docs/admin/site-administration).

### SIGNUP

With `SIGNUP=open`, the sign-in page links to **Create an account** (`/signup`). Someone enters their email address, gets a 6-digit code by email, enters it, picks a username and creates a passkey; their account is active at once (see [Open sign-up](/docs/accounts/passkeys-and-sign-in#open-sign-up)). Unset, or any other value, the instance is invite-only as before: `/signup` answers `404` and the sign-in page says so.

Open sign-up needs Cloudflare Turnstile, so scripts can't use it to send email. The deploy sets Turnstile up (see [Turnstile](#turnstile)), so to open sign-up add `"SIGNUP": "open"` under `vars` in `wrangler.jsonc`; the deploy keeps it. The Turnstile keys alone never open sign-up: only `SIGNUP=open` does.

Each code request is checked with Turnstile's `siteverify` API, with the visitor's IP address. Without both keys, `/signup` answers `503` with "Sign-up needs Turnstile configured", except when `PUBLIC_URL` is on the local machine (`localhost`, `127.x.x.x` or `[::1]`): local development and the end-to-end tests skip the check. Only the sign-up page's and the security report form's content security policy allows scripts and frames from `https://challenges.cloudflare.com`.

The limits on codes (5 a day per address, 20 a day per IP address, 10 minutes and 5 tries each) are in [Limits](/docs/reference/limits#sign-in-and-sessions). Sign-up emails always send: they need the `EMAIL` binding and the `MAIL` queue like every other email.

### EGRESS

**Experimental:** `web` hasn't been tried on a live instance yet. The setting covers the whole instance, so try it on a test instance first, or check it with an account no site administrator runs, as in [Check it](#check-it) below. diffinery.com doesn't set it.

With `EGRESS=web`, hosted job and sandbox containers start without direct internet access. Cloudflare then lets only ports 80 and 443, and DNS to Cloudflare's resolvers, leave the container, and Diffinery forwards HTTP and HTTPS requests to any host through the Worker. Unset, or any other value, hosted compute reaches the whole internet as before. The setting is read when a container starts: jobs and sandboxes already running keep the access they started with.

Under `web`:

- **Works:** `git clone https://...`, `curl`, `apt-get`, `npm`, `pnpm` and `pip` installs, `docker pull`, and calls to the Diffinery and GitHub APIs.
- **Refused:** every other port. That includes SSH (`git@...` remotes, `ssh`, `scp`), SMTP (25, 465 and 587), IRC, databases and HTTP on other ports.
- **HTTPS is intercepted.** Requests leave through the instance's own Worker, which sees them decrypted, as the operator already can for the container itself. Cloudflare re-signs them with a CA it puts in the container at `/etc/cloudflare/certs/cloudflare-containers-ca.crt`. The runner agent adds that CA to the system store and sets `NODE_EXTRA_CA_CERTS` and `REQUESTS_CA_BUNDLE`, so tools that use the system store, Node.js and Python's `requests` trust it. Tools with their own fixed CA list or certificate pinning, client certificates (mutual TLS), and HTTPS from inside Docker containers a job starts (`docker run`, `services:`, `RUN` steps of a build) fail their certificate checks.

The account that owns the repository decides, as for [quotas](/docs/reference/limits#account-quotas). Accounts run by a site administrator (their own account, and organizations with a site administrator as an owner) stay open even with `EGRESS=web`, so the instance's own Deploy and live test workflows keep their access. Self-hosted runners and GitHub imports are not affected. Under `wrangler dev` sandboxes run in a local process, not containers, so the setting changes nothing there.

To turn it on, add `"EGRESS": "web"` under `vars` in `wrangler.jsonc`; the deploy keeps it. To turn it off, remove it (or set any other value) and deploy again; containers started after that are open.

#### How a blocked connection looks

Diffinery doesn't add a line to the job or terminal output when it limits a connection. The tool that made it reports an ordinary network error:

- **A port other than 80 or 443** fails to connect, as behind a firewall: for example `ssh: connect to host github.com port 22: Connection refused` (or `Connection timed out`), or a mail or database client that can't reach its server.
- **HTTPS from a tool that doesn't trust the Cloudflare CA** fails its certificate check: for example `SSL certificate problem: unable to get local issuer certificate` (curl), `x509: certificate signed by unknown authority` (Go), `PKIX path building failed` (Java), or `self-signed certificate in certificate chain` (Node.js with its own CA list). Inside a Docker container a job starts, add the CA from `/etc/cloudflare/certs/cloudflare-containers-ca.crt` to the image, or run that step on the host.

If the CA never appears in the container, the runner agent writes `web-only egress, but /etc/cloudflare/certs/cloudflare-containers-ca.crt did not appear: HTTPS will fail` to the container's own log (not the job log), and every HTTPS request from the job fails its certificate check.

#### Check it

With `EGRESS=web` deployed, run a workflow in a repository owned by an account that no site administrator runs (a site administrator's own repositories stay open):

```yaml
on: workflow_dispatch
jobs:
  egress:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsSI https://example.com            # works
      - run: git ls-remote https://github.com/git/git HEAD   # works
      - run: npm view left-pad version                 # works
      - shell: bash
        run: "! timeout 10 bash -c '</dev/tcp/github.com/22'"  # SSH port: must not connect
```

All four steps pass. The last one fails if port 22 is reachable, which means the account is open (a site administrator runs it) or the setting isn't deployed.

### Security contact

`/.well-known/security.txt` ([RFC 9116](https://www.rfc-editor.org/rfc/rfc9116)) tells security researchers where to report a problem. Diffinery always serves it, with:

| Field | Value |
| --- | --- |
| `Contact` | First `<PUBLIC_URL>/security/report`, the instance's private report form, then one line per entry of `SECURITY_CONTACT`. An email address becomes a `mailto:` URI; `https://`, `mailto:` and `tel:` URIs are kept as they are; anything else is left out. |
| `Expires` | Midnight UTC 360 days after the request, so the file never goes stale. |
| `Policy` | `<PUBLIC_URL>/docs/security/disclosure`, the [disclosure policy](/docs/security/disclosure). |
| `Preferred-Languages` | `en` |
| `Canonical` | `<PUBLIC_URL>/.well-known/security.txt` |

The report form needs no setup: reports go to the instance's site administrators, who each get an email with the report's summary and read it under **Settings → Security reports** (see [Site administration](/docs/admin/site-administration#security-reports)). People who are signed in can always send one. People who aren't pass Cloudflare Turnstile first, with the same `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` as [open sign-up](#signup), which the deploy sets up (see [Turnstile](#turnstile); you don't need `SIGNUP=open` for this). Without both keys, for example when the deploy's API token lacks **Account → Turnstile → Edit**, the form asks visitors to sign in, except on the local machine, where the check is skipped as for sign-up.

`SECURITY_CONTACT` is optional. Use an address someone reads. The repository leaves it unset on purpose, so an instance never advertises an address its operator didn't choose. To add one, add `"SECURITY_CONTACT": "security@example.com"` under `vars` in `wrangler.jsonc`; the deploy keeps it.

### Turnstile

The security report, early access and contact forms, and open sign-up when it's on, check with [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) that a visitor without an account is a person. Every deploy sets it up (`scripts/turnstile.sh`, run by `scripts/bootstrap.sh`):

1. It looks for a Turnstile widget named `diffinery <DIFFINERY_DOMAIN>` in the account, and creates one when there is none: managed mode, for your hostname only.
2. The widget's site key becomes the `TURNSTILE_SITE_KEY` variable of the deployed Worker.
3. Its secret key becomes the `TURNSTILE_SECRET` secret: `scripts/ensure-secrets.sh` sets it when it's missing, and bootstrap replaces it before the deploy when it goes with another widget (the deployed `TURNSTILE_SITE_KEY` is not this widget's, for example because the widget was deleted and created again). The key goes from the Cloudflare API straight to `wrangler secret put` and is never printed.

The deploy's API token needs **Account → Turnstile → Edit** for this (the [API reference](https://developers.cloudflare.com/api/resources/turnstile/subresources/widgets/methods/create/) calls it "Turnstile Sites Write"). Without it the deploy warns, naming the permission, and goes on; people who aren't signed in then can't send security reports, early access requests or contact messages until you add it and deploy again.

To use a widget of your own instead, add `"TURNSTILE_SITE_KEY": "<site key>"` under `vars` in `wrangler.jsonc` and store its secret key with `printf '%s' "$TURNSTILE_SECRET" | pnpm exec wrangler secret put TURNSTILE_SECRET -c wrangler.deploy.jsonc`. The deploy then creates no widget and never replaces your secret; it only fills in a missing `TURNSTILE_SECRET` when your widget is in the same Cloudflare account. If you rotate the secret key of the deploy's widget in the dashboard, run `pnpm exec wrangler secret delete TURNSTILE_SECRET -c wrangler.deploy.jsonc` and deploy again, so the deploy stores the new one.

### SMTP

Without an `EMAIL` binding, Diffinery can send email through any SMTP server that speaks TLS: your mail provider's submission server, Amazon SES, Postmark, Mailgun or your own. This is how an instance outside Cloudflare, which has no Email Sending, sends sign-up codes, invitations and notifications. When the `EMAIL` binding is there, it is used and `SMTP_URL` is ignored.

1. Add `SMTP_URL` under `vars` in `wrangler.jsonc`; the deploy keeps it.
   - `smtps://<user>@<host>:465` uses TLS from the start. The port defaults to 465.
   - `smtp://<user>@<host>:587` starts plain and upgrades with STARTTLS. The port defaults to 587. If the server doesn't offer STARTTLS, Diffinery sends nothing (`E_SMTP_REJECTED: SMTP: the server doesn't offer STARTTLS, and Diffinery doesn't send without TLS`), so the password never crosses the network in the clear.
   - Write an `@` in the user as `%40`: `smtps://notifications%40example.com@smtp.example.com`.
   - Leave the user out (`smtps://relay.internal:465`) for a relay that needs no sign-in.
   - Cloudflare Workers can't open connections to port 25, so use 465 or 587.
2. Store the password as a secret. Never put it in `SMTP_URL`: Diffinery refuses such a URL.

   ```sh
   cd apps/diffinery
   printf '%s' "$SMTP_PASSWORD" | pnpm exec wrangler secret put SMTP_PASSWORD -c wrangler.deploy.jsonc
   ```

3. Make sure `MAIL_FROM` is an address the SMTP user may send from. It is both the `From` header and the envelope sender.
4. Check it: **Settings → Email** shows **Sending** as "over SMTP: smtps://...", and **Send me a test email** sends one.

Diffinery signs in with AUTH PLAIN, or AUTH LOGIN when the server offers only that. Each email is one connection, and each reply has 30 seconds to arrive. What happens to the email depends on the server's answer:

| Answer | Result |
| --- | --- |
| `2xx` | `sent`. **Recent emails** shows the `Message-ID` Diffinery gave the email. |
| `4xx`, a timeout or a dropped connection | `E_SMTP_TRANSIENT`. The queue tries again later, up to 6 times. |
| `5xx` to `RCPT TO` that says the address doesn't exist (enhanced status `5.1.1`, `5.1.2`, `5.1.3`, `5.1.6`, `5.1.10` or `5.2.1`, or `550`, `551` or `553` without one) | `failed` with `E_SMTP_RECIPIENT_REJECTED`, and the address goes on the [suppression list](/docs/admin/site-administration#bounces-complaints-and-the-suppression-list) as a `hard-bounce` with source `send`. |
| Any other `5xx`, such as `535` for a wrong password or `5.7.1` for a sender the server won't relay for | `failed` with `E_SMTP_REJECTED`. Nothing else changes. |

Most submission servers accept every recipient and report a bounce later, by email to `MAIL_FROM`. Diffinery doesn't read that mailbox. To suppress those addresses too, have your provider post bounces and complaints to the signed intake, `POST /-/email/events` (see `MAIL_EVENTS_SECRET`).

Diffinery never logs the password or the content of an email. Errors quote the server's reply, never the commands sent.

### DEV_AUTH

When `DEV_AUTH` is set, `ACCESS_AUD` is empty and both `PUBLIC_URL` and the request's own address are on the local machine (`localhost`, `127.x.x.x` or `[::1]`), every request without credentials (no token, no session) acts as the account with the email in `DEV_AUTH`, with full access. That account is created on first use and is a site administrator if the email is also in `BOOTSTRAP_ADMINS`. While `DEV_AUTH` is set, the email log also keeps each whole message, and `GET /api/v3/diffinery/emails` returns it, so tests can read emails without delivering them.

> **Important:** Never set `DEV_AUTH` on a deployed instance. As a safeguard it does nothing there: a request that reaches the Worker under any other host name, such as `workers.dev` or your domain, or a `PUBLIC_URL` that isn't on the local machine, turns it off, and so does Cloudflare Access.

## Worker secrets

Set with `wrangler secret put` (the deploy does this for you with `scripts/ensure-secrets.sh`), never in `wrangler.jsonc`.

| Secret | Format | Created by | What it does | If it is missing |
| --- | --- | --- | --- | --- |
| `MASTER_KEY` | 32 random bytes, base64 | `ensure-secrets.sh`, once | Root key for envelope encryption of Actions secrets: each repository, organization and deployment environment gets its own AES-GCM key derived from it with HKDF. The GitHub token of a running import and each webhook's signing secret are encrypted the same way. Model provider keys are encrypted the same way. It also signs the unsubscribe links in emails, the links in invitation and email verification emails, the codes and OAuth state for linking GitHub accounts, keys the stored hashes of sign-up codes, and a key derived from it (HKDF) signs each job's `ACTIONS_RUNTIME_TOKEN` and the upload and download URLs of the Actions cache and artifact services. | Repository, organization and environment secrets can't be stored or read (`could not store the secret: ... (is MASTER_KEY configured?)`). Notification emails that carry unsubscribe links can't be built, so they end up in the email log as failed; security and account emails still send. Jobs get no `ACTIONS_RUNTIME_TOKEN`: `actions/cache` and the built-in cache step skip caching (`The cache service is not available to this job; skipping.`), and uploading or downloading artifacts fails (`The artifact service is not available to this job.`). Imports that come with a GitHub token can't be started. Webhooks can't be created or delivered. Open sign-up can't send codes. |
| `MASTER_KEY_PREV` | The `MASTER_KEY` you replaced | You, only while [rotating `MASTER_KEY`](#rotating-master_key) | Everything sealed or signed with the old key keeps working: secrets encrypted with it still decrypt, and links and tokens signed with it still verify. Nothing new uses it. | The normal state. Right after a rotation without it, secrets stored under the old key can't be read and links signed with it stop working, as if the old key had been lost. |
| `OIDC_PRIVATE_KEY` | An ECDSA P-256 private key as a JWK (JSON), with a `kid` | `ensure-secrets.sh`, once | Signs the ID tokens that workflow jobs request with `permissions: id-token: write` (ES256). Its public half is served at `/.well-known/jwks`. | Jobs that request an ID token fail with `OIDC is not configured on this Diffinery instance`, `/.well-known/jwks` returns no keys, and `GET /api/v3/meta` returns `"oidc": false`. |
| `GITHUB_OAUTH_CLIENT_SECRET` | The client secret of a GitHub OAuth app | You, optionally | With `GITHUB_OAUTH_CLIENT_ID`, turns on the **Link with GitHub** option on **Settings → Linked accounts**. | People link GitHub accounts with the gist code only. |
| `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` | The GitHub App's client secret, its private key (the PEM file GitHub gives, as it is) and its webhook secret | You, optionally | With `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and `GITHUB_APP_CLIENT_ID`, turns on [GitHub runners](#github-runners). | **Settings → GitHub runners** says the instance has no GitHub App, and `POST /-/github/webhook` answers 404. |
| `MAIL_EVENTS_SECRET` | A random string, at least 32 characters | You, optionally | Turns on `POST /-/email/events`, the signed intake for bounces and complaints from anything other than Cloudflare's own event subscriptions. See [Bounces, complaints and the suppression list](/docs/admin/site-administration#bounces-complaints-and-the-suppression-list). | The endpoint answers 404. Bounces and complaints still arrive through the `diffinery-mail-events` queue. |
| `SMTP_PASSWORD` | The password of the user in `SMTP_URL` | You, optionally | Signs in to the SMTP server in `SMTP_URL`. See [SMTP](#smtp). | With a user in `SMTP_URL`, nothing is sent: every email fails with `E_SMTP_CONFIG: SMTP_URL names a user but the SMTP_PASSWORD secret is not set`. |
| `TURNSTILE_SECRET` | The secret key of a Cloudflare Turnstile widget | The deploy, from its widget (see [Turnstile](#turnstile)) | With `TURNSTILE_SITE_KEY`, checks that whoever asks for a sign-up code (with `SIGNUP=open`), or sends a security report, an early access request or a contact message without signing in, passed the Turnstile widget. See [SIGNUP](#signup) and [Security contact](#security-contact). | With `SIGNUP=open`, sign-up answers `503` "Sign-up needs Turnstile configured", the security report and contact forms take reports and messages only from people who are signed in, and the early access form is closed (local development skips the check). The next deploy sets it when the token has **Account → Turnstile → Edit**. |

None of these secrets is rotated automatically, and `ensure-secrets.sh` never replaces one that exists. Keep a copy of `MASTER_KEY` somewhere safe: replacing it without keeping the old one as `MASTER_KEY_PREV` makes every stored secret undecryptable and invalidates unsubscribe links already sent, along with the runtime tokens of running jobs and cache and artifact links already handed out. To rotate it, follow [Rotating MASTER_KEY](#rotating-master_key). To rotate the OIDC key, delete `OIDC_PRIVATE_KEY` and deploy: a new key with a new `kid` (`diffinery-<date>`) is generated, and relying parties pick it up from `/.well-known/jwks`.

To set a secret by hand (for example to restore a backup):

```sh
cd apps/diffinery
printf '%s' "$MASTER_KEY" | pnpm exec wrangler secret put MASTER_KEY -c wrangler.deploy.jsonc
```

### Rotating MASTER_KEY

Rotate `MASTER_KEY` when it may have leaked, or on your own schedule. Diffinery accepts two keys while a rotation is under way: `MASTER_KEY`, which encrypts and signs everything new, and `MASTER_KEY_PREV`, the key it replaced, which is only used to decrypt and verify what was made before.

1. Make a new key and keep it with your copy of the current one:

   ```sh
   NEW_KEY="$(openssl rand -base64 32)"
   ```

2. Set the current key as `MASTER_KEY_PREV` and the new one as `MASTER_KEY` in one step, so no version of the Worker runs with the new key alone. `OLD_KEY` is the current value from your safe copy (Cloudflare doesn't show a secret's value):

   ```sh
   cd apps/diffinery
   jq -n --arg old "$OLD_KEY" --arg new "$NEW_KEY" '{MASTER_KEY_PREV: $old, MASTER_KEY: $new}' | pnpm exec wrangler secret bulk -c wrangler.deploy.jsonc
   ```

   To use `wrangler secret put` instead, put `MASTER_KEY_PREV` first and `MASTER_KEY` second: each command deploys a new version of the Worker, and a version with the new `MASTER_KEY` but no `MASTER_KEY_PREV` can't read the secrets stored so far.

3. Save the new key where you kept the old one. Nothing else needs to change: no deploy, migration or restart.

From then on:

- New and replaced secrets (repository, organization and environment secrets, model provider keys, webhook secrets, import tokens) are encrypted with the new key. Each stored value names the key it was encrypted with (`v2.<key id>.…`, where the key id is the first 8 hex characters of the key's SHA-256: `printf %s "$NEW_KEY" | base64 -d | sha256sum | cut -c1-8`). Values stored before key ids existed (`v1.…`) are tried with both keys.
- Stored values move to the new key by themselves as they are used: repository, organization and environment secrets the next time a workflow job uses them, model provider keys the next time an agent task does, webhook secrets the next time the webhook delivers, and the GitHub token of an import when the import is retried. A value nothing uses stays encrypted with the old key until someone saves it again.
- Unsubscribe links, invitation and verification emails, sign-up codes, GitHub linking codes and OAuth state, runtime tokens, cache and artifact URLs, and image proxy URLs in pages already rendered signed with the old key keep working; new ones are signed with the new key.

Remove `MASTER_KEY_PREV` (`pnpm exec wrangler secret delete MASTER_KEY_PREV -c wrangler.deploy.jsonc`) only when nothing you still need depends on the old key:

- Every repository, organization and environment secret and every model provider key you still need has been used or saved again since the rotation. Secrets your workflows use every day move over by themselves; one that only a rare workflow uses (a release, a yearly job) may not have, and its value can't be read back, so whoever manages it re-enters it. One left behind can't be decrypted once `MASTER_KEY_PREV` is gone, and runs that use it fail.
- Links already sent have expired, or you accept that they stop working: runtime tokens and cache and artifact URLs last about as long as their job, sign-up codes 10 minutes, image proxy URLs until pages and browsers cache them no more (at most 7 days), verification links 24 hours, invitation emails until the invitation expires, and unsubscribe links up to a year. Someone with an old unsubscribe link can still change their email settings after signing in.

If the old key leaked, treat the secrets as exposed: replace their values at the source (new API tokens, new passwords) and save the new values, which are sealed with the new key. Then remove `MASTER_KEY_PREV` right away: until then, anyone holding the old key can still forge what it signs.

## Bindings

Defined in `wrangler.jsonc`. The deploy creates the underlying resources if they don't exist.

| Binding | Kind | Resource (production) | What Diffinery uses it for |
| --- | --- | --- | --- |
| `DB` | D1 database | `diffinery` (migrations in `migrations/`) | Accounts (including each account's appearance setting and profile picture version), organizations, tokens, repository list, topics and access, invitations, sessions and passkeys, notifications, audit log, schedules, organization secrets and variables, the registry index, email settings and log, GitHub imports and linked GitHub accounts, and GitHub runners' installations and runners. |
| `BUCKET` | R2 bucket | `diffinery-data` | Large git objects, LFS objects, archived job logs, caches, artifacts, container image layers and manifests, the event archive, release assets, cached source archives (zipball and tarball downloads) and profile pictures. |
| `EVENTS` | Queue producer, with a consumer on the same Worker | `diffinery-events`, dead-letter queue `diffinery-events-dlq` | Repository events for webhooks, notifications and the audit log. Consumer: batches of up to 50, waiting up to 2 seconds, 8 retries. |
| `MAIL` | Queue producer, with a consumer on the same Worker | `diffinery-mail`, dead-letter queue `diffinery-mail-dlq` | Email jobs. Consumer: batches of up to 20, waiting up to 2 seconds, 8 retries. Optional: without it emails are dropped with a warning in the logs. |
| `EMAIL` | `send_email` (Email Sending) | Your onboarded domain | Sending email. Optional: without it email goes to the SMTP server in `SMTP_URL`, and without that too every email is logged as `skipped`. |
| (none) | Queue consumer | `diffinery-mail-events` | Bounces and complaints from Email Sending's event subscriptions; the deploy subscribes this queue to your sending domain's events (see [Site administration](/docs/admin/site-administration#where-bounces-and-complaints-come-from)). Consumer: batches of up to 50, waiting up to 5 seconds, 8 retries. |
| `RL_AUTH`, `RL_ANON`, `RL_ACCOUNT`, `RL_CREATE`, `RL_MODEL` | Rate limiting (`ratelimits`) | Namespaces `1001` to `1005`; 20, 300, 2,000, 60 and 600 requests per 60 seconds | [Request rate limits](/docs/reference/rest-api#rate-limits): sign-in and security reports per IP address, anonymous requests per IP address, signed-in requests per account, new content per account, and agents' model requests per paying person (`MODEL_RATE_LIMIT` in `src/lib/rate-limit.ts`). Optional: a missing binding (the `dev` environment declares none) or one that fails lets requests through. If you change a limit, change `RATE_LIMITS` (or `MODEL_RATE_LIMIT`) in `src/lib/rate-limit.ts` to match, since the 429 messages quote it. Namespace IDs are shared across your Cloudflare account, so pick others if another Worker already uses these. Where these bindings don't exist, set `RATE_LIMITS` to `durable` to count in `RATE_LIMITER` instead. |
| `REPO` | Durable Object namespace | Class `RepoDO` (SQLite) | One object per repository. |
| `SCHEDULER` | Durable Object namespace | Class `SchedulerDO` (SQLite) | One object that starts scheduled workflow runs on its own alarm. |
| `COMPOSE` | Durable Object namespace | Class `ComposeDO` (SQLite) | Joins the blocks of large artifact and cache uploads, one short-lived object per step, so the copying doesn't slow the repository's object. Without it, `RepoDO` does the joining. |
| `RATE_LIMITER` | Durable Object namespace | Class `RateLimiterDO` (SQLite) | Request rate limits when `RATE_LIMITS` is `durable` and the `ratelimits` bindings are missing, such as on celld. 32 objects, each counting a share of the keys in memory. Unused otherwise. |
| `RUNNER` | Durable Object namespace with a container | Class `RunnerContainer` (SQLite) | One container per hosted workflow job, and per runner of a [GitHub job](/docs/actions/github-runners). |
| `GITHUB_RUNNERS` | Durable Object namespace | Class `GitHubRunnersDO` (SQLite) | One object per account that pays for [GitHub runners](#github-runners): it starts runners for its GitHub jobs on its own alarm. |
| `SANDBOX` | Durable Object namespace with a container | Class `SandboxContainer` (SQLite) | One container per agent sandbox. |
| `RUN_WORKFLOW` | Workflow | `diffinery-run`, class `RunWorkflow` | One durable instance per workflow run. |
| `IMPORTER` | Durable Object namespace with a container | Class `ImportContainer` (SQLite) | One container per Git transfer of a GitHub import. |
| `IMPORT_WORKFLOW` | Workflow | `diffinery-import`, class `ImportWorkflow` | One durable instance per attempt of a GitHub import. |

The Durable Object classes are declared in eight migrations (`new_sqlite_classes`): tag `v1` for `RepoDO`, `RunnerContainer` and `SandboxContainer`, tag `v2` for `ImportContainer`, tag `v3` for `ProjectDO`, tag `v4` for `SchedulerDO`, tag `v5` for `RunnerContainerMedium`, `RunnerContainerSmall` and `RunnerContainerTiny`, tag `v6` for `ComposeDO`, tag `v7` for `GitHubRunnersDO`, and tag `v8` for `RateLimiterDO`. `wrangler deploy` applies a migration tag the account doesn't have yet.

## Other Worker settings

| Setting | Value | Notes |
| --- | --- | --- |
| `name` | `diffinery` | The Worker's name in your account. |
| `main` | `src/index.ts` | |
| `compatibility_date` | `2026-10-01` | |
| `compatibility_flags` | `nodejs_compat` | |
| `workers_dev` | `false` | The instance is only served on your route. |
| `routes` | `[{ "pattern": "diffinery.com/*", "zone_name": "diffinery.com" }]` | A zone route, not a Custom Domain. The hostname's DNS record must be proxied. On deploy, `scripts/render-config.mjs` replaces it with one route, `<DIFFINERY_DOMAIN>/*` in the zone `DIFFINERY_ZONE` (by default the hostname's last two labels), so you don't edit it by hand. |
| `observability` | Enabled, `head_sampling_rate: 1` | Every request is logged to Workers Logs. |
| `version_metadata` | Binding `CF_VERSION_METADATA` | The deployed version's id and time. [IndexNow](/docs/admin/site-administration#search-engines) checks the site's pages once for each new version and ignores older versions still running during a rollout. Optional: without it, it checks whenever the pages' content differs from what it last submitted. |
| `upload_source_maps` | `true` | Readable stack traces in the logs. |
| `limits.cpu_ms` | `300000` | Up to 5 minutes of CPU time per request (large pushes, diffs and merges). |
| `containers` | `RunnerContainer`: `standard-4`, `max_instances: 100`; `RunnerContainerMedium`, `RunnerContainerSmall`, `RunnerContainerTiny`: `standard-3`, `standard-1`, `basic`, `max_instances: 100` each (smaller hosted runners; remove them and their `RUNNER_*` bindings to run every job on `standard-4`); `SandboxContainer`: `standard-1`, `max_instances: 50`; `ImportContainer`: `standard-4`, `max_instances: 20`; `rollout_active_grace_period`: 23400 for runners and 25200 for imports (longer than a job or transfer can run, so a deploy never replaces a running one), 3600 for sandboxes; `rollout_step_percentage: 100`, so containers started after a deploy get the new image | All three build `containers/runner/Dockerfile` with `containers/runner` as context. Raise `max_instances` for more concurrent jobs, sandboxes or import transfers. |
| `triggers.crons` | `["*/5 * * * *"]` | Token expiry reminders, email log pruning, registry cleanup, cancelling draft imports older than 7 days, and setting the workflow scheduler's alarm if it isn't set. Scheduled workflows run from that alarm, not from the cron trigger. |

## The dev environment

`wrangler.jsonc` has an `env.dev` section that `pnpm dev` (`wrangler dev -e dev`) and the end-to-end tests use. It is removed from the deployed config.

| Setting | `dev` value |
| --- | --- |
| `routes`, `workers_dev` | No routes; `workers_dev: true` |
| `PUBLIC_URL` | `http://localhost:8787` |
| `BOOTSTRAP_ADMINS`, `DEV_AUTH` | `dev@diffinery.local` |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Empty |
| `DB` | `diffinery-dev` |
| `BUCKET` | `diffinery-data-dev` |
| Queues | `diffinery-events-dev` and `diffinery-mail-dev`, batches waiting up to 1 second, no dead-letter queues |
| `EMAIL` | Captured locally by Miniflare, not delivered |
| `RUN_WORKFLOW` | `diffinery-run-dev` |
| `IMPORT_WORKFLOW` | `diffinery-import-dev` |
| `IMPORT_GIT_AGENT` | `external` |
| `containers` | None: hosted runners, sandboxes and import containers are unavailable locally; use a self-hosted runner, and run an import's Git transfer by hand |
| `triggers.crons` | None |

To run an import locally, start it as usual, wait until its `git.phase` is `waiting`, claim the transfer, and run the runner agent's import mode against your instance (build it first with `pnpm -r build`):

```sh
TOKEN=$(curl -sS -X POST http://localhost:8787/api/v3/diffinery/imports/<id>/claim | jq -r .token)
DIFFINERY_API_URL=http://localhost:8787 DIFFINERY_IMPORT_ID=<id> DIFFINERY_IMPORT_TOKEN=$TOKEN \
  DIFFINERY_WORK_ROOT=/tmp/diffinery-import node containers/runner/dist/agent.mjs
```

Only the account that started the import can claim it. In local development (`DEV_AUTH` in effect, as described in [DEV_AUTH](#dev_auth)), imports also accept plain `http://` and loopback GitHub API URLs, for test doubles.

`MASTER_KEY` is not set in `dev`. Add it to `apps/diffinery/.dev.vars` (`MASTER_KEY=<base64 of 32 random bytes>`) or pass `--var MASTER_KEY:<value>` to `wrangler dev` to store Actions secrets locally. The end-to-end tests pass a random one with `--var`, together with `PUBLIC_URL`.

## GitHub imports

[Imports from GitHub](/docs/migrate-from-github) need no setup beyond a normal deploy: the `IMPORTER` container, the `IMPORT_WORKFLOW` Workflow and the D1 tables of migration `0010_imports.sql` are created by the deploy. What you can tune:

| Setting | Where | Effect |
| --- | --- | --- |
| `IMPORT_MAX_REPO_KB` | `vars` in `wrangler.jsonc` | The size ceiling for one-repository imports (default 10 GB). The Git transfer makes a full mirror clone (`git clone --mirror`) inside the import container (`standard-4`), so a higher ceiling needs room for that clone. |
| `max_instances` of `ImportContainer` | `containers` in `wrangler.jsonc` | How many Git transfers run at once across the instance (default 20). |
| `IMPORT_GHE_HOST` | `vars` in `wrangler.jsonc` | Lets imports download release assets from your GitHub Enterprise Server host. |
| `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` | `vars` (or a secret) and a Worker secret | Adds **Link with GitHub** to **Settings → Linked accounts**. |

To offer linking through GitHub sign-in, create an OAuth app on github.com (**Settings → Developer settings → OAuth Apps**) with the authorization callback URL `https://git.example.com/settings/linked/github/callback` (your `PUBLIC_URL` plus `/settings/linked/github/callback`). Then add the client ID under `vars` in `wrangler.jsonc` and store the secret:

```sh
cd apps/diffinery
printf '%s' "$CLIENT_SECRET" | pnpm exec wrangler secret put GITHUB_OAUTH_CLIENT_SECRET -c wrangler.deploy.jsonc
```

The OAuth flow asks GitHub for the `read:user` scope only, uses github.com (not an Enterprise host), and binds its state to the signed-in account. Without the two settings, people link accounts with the gist code, which needs no configuration.

Imports reach GitHub only on HTTPS hosts with public names; a GitHub API URL on a private address, `localhost`, `.local` or `.internal` is refused with `422 github_api_url must be a public host`.

## GitHub runners

[GitHub runners](/docs/actions/github-runners) let repositories that stay on GitHub run jobs on this instance's hosted runners. They need a GitHub App of your own; the runner containers, the `GITHUB_RUNNERS` Durable Object and the D1 tables of migration `0044_github_runners.sql` come with a normal deploy.

Create the app on GitHub under **Settings → Developer settings → GitHub Apps → New GitHub App** (of your user, or of an organization for a shared instance), with these settings. `https://git.example.com` stands for your `PUBLIC_URL`.

| Setting | Value |
| --- | --- |
| **GitHub App name** | Any, such as `Diffinery runners for git.example.com` |
| **Homepage URL** | `https://git.example.com` |
| **Callback URL** | `https://git.example.com/settings/github-runners/setup` |
| **Request user authorization (OAuth) during installation** | Off |
| **Setup URL** | `https://git.example.com/settings/github-runners/setup`, with **Redirect on update** on |
| **Webhook** | Active, URL `https://git.example.com/-/github/webhook`, and a random secret of at least 32 characters |
| **Repository permissions** | **Administration**: Read and write (to register and remove a repository's self-hosted runners). **Actions**: Read-only. **Metadata**: Read-only. Nothing else |
| **Subscribe to events** | **Workflow job** |
| **Where can this GitHub App be installed?** | **Any account** to let anyone with an account on your instance use it; **Only on this account** for your own repositories only |

Then, on the app's page: note the **App ID** and the **Client ID**, click **Generate a new client secret**, and under **Private keys** click **Generate a private key**, which downloads a `.pem` file. Add the IDs and the slug under `vars` in `wrangler.jsonc`:

```jsonc
"GITHUB_APP_ID": "123456",
"GITHUB_APP_SLUG": "diffinery-runners-for-git-example-com",
"GITHUB_APP_CLIENT_ID": "Iv23li...",
```

and store the secrets:

```sh
cd apps/diffinery
printf '%s' "$CLIENT_SECRET" | pnpm exec wrangler secret put GITHUB_APP_CLIENT_SECRET -c wrangler.deploy.jsonc
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY -c wrangler.deploy.jsonc < diffinery-runners.private-key.pem
printf '%s' "$WEBHOOK_SECRET" | pnpm exec wrangler secret put GITHUB_APP_WEBHOOK_SECRET -c wrangler.deploy.jsonc
```

After the next deploy, **Settings → GitHub runners** offers **Install on GitHub**. GitHub's **Recent Deliveries** on the app's **Advanced** tab shows each webhook delivery and Diffinery's answer, such as `{"queued":true,"size":"large"}` or `{"ignored":"not for a Diffinery runner"}`.

What to know:

- Jobs run GitHub's own runner, which the runner image includes (`ACTIONS_RUNNER_VERSION` in `containers/runner/Dockerfile`). GitHub updates a runner that has fallen too far behind as it starts, which adds a few seconds to each job, so keep that version close to [the latest release](https://github.com/actions/runner/releases).
- GitHub jobs count against the linked account's quotas and the instance's `HOSTED_JOBS_LIMIT` like any hosted job, and [kill switches](/docs/admin/site-administration#kill-switches) stop them.
- The webhook isn't rate limited per address, because GitHub sends every delivery from a few addresses; it refuses any delivery without a good signature.
- Containers don't run under `wrangler dev`, so locally a GitHub job's runner fails to start ("Could not start a runner: ...").

## Deploy script settings

Environment variables the scripts in `scripts/` read. `scripts/setup.sh` reads all of them too, asks for `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DIFFINERY_DOMAIN` and `BOOTSTRAP_ADMINS` in a terminal when they aren't set, and requires `DIFFINERY_DOMAIN` (see [Deploy from your own machine](/docs/self-hosting/deploy#deploy-from-your-own-machine)):

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | `bootstrap.sh`, `email-sending.sh`, `ensure-secrets.sh` (through wrangler), `wrangler deploy` | Required | The API token. |
| `CLOUDFLARE_ACCOUNT_ID` | `bootstrap.sh`, wrangler | Required | The account to deploy to. |
| `DIFFINERY_DOMAIN` | `bootstrap.sh`, `email-sending.sh` | `diffinery.com` | Your instance's hostname, without a scheme or path: the Worker's route becomes `<domain>/*`, `PUBLIC_URL` becomes `https://<domain>`, email is sent from `notifications@<domain>` (unless `MAIL_DOMAIN` is set), the Access application covers `<domain>/auth/access`, and email checks look at this domain. |
| `DIFFINERY_ZONE` | `bootstrap.sh` | The hostname's last two labels | The Cloudflare zone that holds the hostname, for the Worker's route. Set it when the last two labels aren't the zone, for example `example.co.uk` for `git.example.co.uk`. The API token needs Workers Routes Edit on this zone. |
| `ACCESS_TEAM_DOMAIN` | `bootstrap.sh` | Discovered | Your Zero Trust team domain, when the token can't read it. |
| `MAIL_DOMAIN` | `bootstrap.sh`, `email-sending.sh` | `DIFFINERY_DOMAIN` | The domain email is sent from: `MAIL_FROM` becomes `notifications@<MAIL_DOMAIN>`, and the Email Sending check looks at this domain. |
| `BOOTSTRAP_ADMINS` | `bootstrap.sh` (through `bootstrap-admins.sh`), `setup.sh` | The deployed Worker's list | Comma-separated emails that become site administrators on first sign-in. See [BOOTSTRAP_ADMINS](#bootstrap_admins). |
| `ROLLOUT_WAIT_MINUTES` | `wait-container-rollout.sh` | `10` | How long a deploy waits for the container rollout to reach its last step. |
| `GITHUB_OUTPUT` | `bootstrap.sh` | Set by Actions | Where bootstrap writes `d1_id`, `access_team` and `access_aud_set`. |

`scripts/render-config.mjs` takes flags instead:

| Flag | Effect |
| --- | --- |
| `--d1 <database id>` | Required. The D1 `database_id`. |
| `--team <team domain>` | Sets `ACCESS_TEAM_DOMAIN`. |
| `--aud <audience tag>` | Sets `ACCESS_AUD`. |
| `--public-url <origin>` | Sets `PUBLIC_URL` to the origin, `routes` to `[{ "pattern": "<hostname>/*", "zone_name": "<zone>" }]` and `MAIL_FROM` to `notifications@<hostname>`. Must be an `https://` URL without a path. |
| `--zone <zone>` | The route's zone, with `--public-url`. Default: the hostname's last two labels. |
| `--mail-from <address>` | Sets `MAIL_FROM`, overriding the one `--public-url` sets. |
| `--admins <emails>` | Sets `BOOTSTRAP_ADMINS` (comma-separated email addresses). Without it, the value in `wrangler.jsonc` stays. |

Bootstrap calls it with `--public-url https://$DIFFINERY_DOMAIN`, `--zone $DIFFINERY_ZONE` when that is set, `--mail-from notifications@${MAIL_DOMAIN:-$DIFFINERY_DOMAIN}` and `--admins` with the list `scripts/bootstrap-admins.sh` picked. See [Deploy your own Diffinery](/docs/self-hosting/deploy#scriptsrender-configmjs).

## Repository secrets and variables for the workflows

The workflows in `.github/workflows/` read these from the repository (or its `production` environment):

| Name | Kind | Used by | Value |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | Deploy | Cloudflare API token with the permissions listed in [Deploy your own Diffinery](/docs/self-hosting/deploy). |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | Deploy | Your Cloudflare account ID. |
| `DIFFINERY_DOMAIN` | Variable | Deploy | Optional. Your instance's hostname, default `diffinery.com`. Deploy passes it to bootstrap (see [Deploy script settings](#deploy-script-settings)), uses it as the `production` environment's URL and runs its checks against `https://<DIFFINERY_DOMAIN>`. |
| `DIFFINERY_ZONE` | Variable | Deploy | Optional. The Cloudflare zone for the route, when it isn't the hostname's last two labels. |
| `MAIL_DOMAIN` | Variable | Deploy | Optional. The domain email is sent from, when it isn't `DIFFINERY_DOMAIN`. |
| `ACCESS_TEAM_DOMAIN` | Variable | Deploy | Optional. Your Zero Trust team domain, for example `example.cloudflareaccess.com`, when the API token can't read it. |
| `DIFFINERY_LIVE_TOKEN` | Secret | Live test | A Diffinery token with the `admin` scope and access to all repositories, created under **Settings → Access tokens** on the instance. The live test creates and deletes throwaway repositories with it, and uploads a test profile picture to the token's account (putting the previous one back afterwards). When the secret is not set, those steps are skipped with a warning; the check that `/docs`, `/llms.txt` and the CLI download are served without signing in still runs. |

Deploy reads `DIFFINERY_DOMAIN`, `DIFFINERY_ZONE` and `MAIL_DOMAIN` from the repository's variables and passes them to bootstrap, so you point it at your own hostname without editing the workflow (see [Deploy your own Diffinery](/docs/self-hosting/deploy#step-1-choose-your-hostname-and-first-administrators)). Deploy runs on pushes to `main` on any Diffinery instance, and when started by hand on GitHub.

The Deploy job runs in an environment named `production` (created by its first run, with no branch policy). The Live test checks the upstream project's public instance, `https://diffinery.com`, and runs on its own after a deploy only there; delete it, or change its `DIFFINERY` host, for your own instance.

**When agents land changes on `main`.** A merge that Diffinery lands for an agent through auto-merge is the agent's push, so the Deploy and Live test runs after it are [runs of agent code](/docs/actions/workflow-permissions#runs-whose-code-came-from-an-agent). Those get no repository or organization secrets, and Deploy stops with `CLOUDFLARE_ACCOUNT_ID is required`. Either keep the secrets in the `production` environment, limited to protected branches, with `main` protected (add `environment: production` to the Live test job as well), or have an admin turn on **Give runs of agent code the repository's and organization's secrets** under **Settings → Actions**. The environment is the tighter choice: the setting gives the secrets to every agent run, branches included. See [Which runs receive secrets](/docs/actions/secrets-and-variables#which-runs-receive-secrets).

`scripts/diffinery-wait-runs.sh` waits for the Actions runs on a commit. It reads `DIFFINERY` (the instance origin) and `TOKEN` (a Diffinery token) from the environment:

```sh
DIFFINERY=https://diffinery.com TOKEN=dfy_... scripts/diffinery-wait-runs.sh acme/website <sha> 60
```

## Settings that are not configuration

Some values are fixed in code and can't be changed without editing it, for example the job timeout ceiling, matrix size, the 10 GB cache budget per repository and session lifetime. They are listed in [Limits](/docs/reference/limits).
