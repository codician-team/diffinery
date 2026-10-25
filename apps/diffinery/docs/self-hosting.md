---
title: Self-hosting
description: Diffinery is open source (Apache-2.0) and runs on your own Cloudflare account. What an instance needs, what it costs, the steps to deploy one, and where to go next.
updated: 2026-10-25
---

Diffinery is open-source software under the Apache License 2.0, and the way to use it is to run your own instance on your own Cloudflare account and domain. There's no hosted service to sign up for: diffinery.com is the project's own instance. This page is the overview; [Deploy your own Diffinery](/docs/self-hosting/deploy) is the step-by-step guide.

## Get the source

The repository is [diffinery.com/codician/diffinery](https://diffinery.com/codician/diffinery), mirrored to [github.com/codician-team/diffinery](https://github.com/codician-team/diffinery). Clone either one; both carry the same `main` branch, with the `LICENSE` and `NOTICE` files at the top.

```sh
git clone https://github.com/codician-team/diffinery.git
cd diffinery
```

## What an instance needs

| Requirement | Why |
| --- | --- |
| A Cloudflare account on the Workers Paid plan, with R2 turned on | Diffinery uses Workers, Durable Objects with SQLite, D1, R2, Queues, Workflows, Cron Triggers, Email Sending and Containers. Containers need the paid plan. |
| A domain added to that account | The instance's hostname, such as `git.example.com`, is served through a Workers route on that zone. |
| A Cloudflare Zero Trust organization | Cloudflare Access guards `/auth/access`, the email sign-in the first administrator uses and that lets people recover a lost passkey. |
| A clone of the repository and somewhere to run the deploy | Your own machine with Node.js 22, pnpm 10, `jq`, `curl`, `openssl` and Docker, for `scripts/setup.sh`; or the repository's Deploy workflow, on a forge with GitHub-compatible Actions. |

People who use your instance don't need a Cloudflare account; only the deployment does. See [What you need](/docs/self-hosting/deploy#what-you-need) for the full list.

## The steps

The quickest way is `scripts/setup.sh` from a clone on your machine: one command checks your tools, API token and zone, then deploys, and running it again updates the instance.

1. [Create a Cloudflare API token](/docs/self-hosting/deploy#step-2-create-a-cloudflare-api-token) with the permissions the deploy needs.
2. [Choose your hostname and first administrators](/docs/self-hosting/deploy#step-1-choose-your-hostname-and-first-administrators): `DIFFINERY_DOMAIN` and `BOOTSTRAP_ADMINS`. You don't edit any code.
3. Run the deploy:

   ```sh
   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... DIFFINERY_DOMAIN=git.example.com \
     BOOTSTRAP_ADMINS=you@example.com scripts/setup.sh
   ```

   Add `--dry-run` first to check everything without changing anything. See [Deploy from your own machine](/docs/self-hosting/deploy#deploy-from-your-own-machine). To deploy from a workflow on every push instead, see [Run the Deploy workflow](/docs/self-hosting/deploy#step-4-run-the-deploy-workflow).
4. [Set up email sending](/docs/self-hosting/deploy#step-5-set-up-email-sending) and [DNS](/docs/self-hosting/deploy#step-6-dns).
5. [Sign in as the first administrator](/docs/self-hosting/deploy#step-7-sign-in-as-the-first-administrator) at `/auth/access`, add a passkey, and invite your team from **Settings → People and invitations**.

The deploy creates whatever is missing in your account, applies the database migrations, uploads the Worker and builds the runner image, and every step is safe to repeat. To update later, bring your copy up to date with upstream and deploy again; see [Updating](/docs/self-hosting/deploy#updating).

## What it costs

Diffinery is free. Your instance's costs are your Cloudflare bill: the Workers Paid plan has "a minimum cost of $5 USD per month per account", plus usage above its allowances ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), checked October 25, 2026), and runner and sandbox containers are billed by the 10 ms while they run ([Containers pricing](https://developers.cloudflare.com/containers/pricing/), checked October 25, 2026). Diffinery starts a container only when a job starts and stops it when the job ends, and per-account [quotas](/docs/reference/limits#account-quotas), which you set, cap what each account can use.

## After the first deploy

- **Who can join.** An instance is invite-only by default. Set `SIGNUP=open` to let anyone create an account; see [SIGNUP](/docs/self-hosting/configuration#signup) and [Invitations](/docs/accounts/invitations).
- **Limits.** Change the per-account quotas and the instance's hosted job limit with the `QUOTA_*` and `HOSTED_JOBS_LIMIT` variables; see [Configuration](/docs/self-hosting/configuration#worker-variables).
- **Running it.** [Site administration](/docs/admin/site-administration) covers accounts, early access requests, email and audits, and the [status page](/docs/self-hosting/status-page) shows whether each part of your instance works.
- **How it fits together.** [Architecture](/docs/self-hosting/architecture) maps each part of Diffinery to the Cloudflare product that runs it.

## Get help and contribute

Report bugs and send pull requests on [the GitHub mirror](https://github.com/codician-team/diffinery) or [the Diffinery repository](https://diffinery.com/codician/diffinery). Report security problems privately with the [report form](https://diffinery.com/security/report); see [Vulnerability disclosure](/docs/security/disclosure).
