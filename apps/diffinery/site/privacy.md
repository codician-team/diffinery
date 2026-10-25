---
title: Privacy policy
seo_title: "Privacy policy · Diffinery"
description: What personal data diffinery.com and the Diffinery CLI, editor extensions and agent plugins handle, who processes it, and how long it is kept.
updated: 2026-10-25
---

This policy covers **diffinery.com**, the website and Diffinery instance that Codician runs, and the Diffinery **CLI, editor extensions and AI-agent plugins** that Codician publishes. It explains what personal data they handle, why, who processes it, how long it is kept, and what you can ask of us.

**The short version:** we collect what diffinery.com needs to work, we don't sell data, we don't show ads, and there are no analytics or tracking cookies. If you run Diffinery yourself, your instance's data stays on your own Cloudflare account, and Codician never receives it.

Codician ("we") is responsible for the data described here. Contact: **hi@codician.com**.

## If you run your own Diffinery

Diffinery is open-source software (Apache-2.0). When you deploy it to your own Cloudflare account, you, not Codician, decide what your instance collects and keep all of its data: accounts, repositories, logs and everything else stay on your Cloudflare account. The software doesn't send usage data or telemetry to Codician. Each instance does tell search engines about its own public pages through IndexNow; you can turn that off ([Search engines](/docs/admin/site-administration#search-engines)). This policy doesn't cover instances run by other people; ask whoever runs yours.

## The CLI, editor extensions and AI-agent plugins

The `diffinery` CLI, the VS Code and JetBrains extensions, and the Claude Code and Codex plugins talk only to the Diffinery instance you set them up for (diffinery.com unless you choose another). They sign you in to that instance and send it the requests you make, such as listing pull requests or reading a job log. They send nothing to Codician or anyone else. Your token is kept on your computer: in the CLI's config file, your editor's secret storage, or the place your agent app keeps sign-ins.

Downloading the CLI, an extension or a plugin from diffinery.com is an ordinary web request, handled as described under [Visiting the website](/privacy#visiting-the-website). Marketplaces you install from (the Visual Studio Marketplace, Open VSX, the JetBrains Marketplace or a plugin directory) handle your data under their own policies.

## Visiting the website

Anyone can read diffinery.com's public pages, documentation and public repositories without an account. For those visits we don't collect personal data beyond what any web server handles:

- **Cloudflare**, which hosts diffinery.com, processes your IP address, browser user agent and the pages you request to serve the site and protect it from attacks. Our request logs are kept for up to 7 days.
- **No analytics or advertising.** There are no analytics scripts, tracking pixels or third-party marketing tools on diffinery.com.

### Cookies

diffinery.com sets only cookies it needs to work. None are used for advertising or to follow you across sites, so there's no cookie banner.

| Cookie | What it does | How long |
| --- | --- | --- |
| `__Host-dfy_session` | Keeps you signed in | 30 days, or until you sign out |
| `__Host-dfy_webauthn` | Holds the passkey challenge while you sign in | 5 minutes |
| `dfy_csrf` | Protects forms against cross-site request forgery | 30 days |
| `__Host-dfy_d1` | Lets the database show you your own changes straight away | 1 day |
| `dfy_flash` | Shows a one-time message after an action | 1 minute |
| `dfy_theme` | Remembers light or dark appearance if you choose one | 400 days |
| `today_collapsed` | Remembers which sections of the Today page you folded | 1 year |

## Forms anyone can use

- **Early access requests** (`/early-access`): the email address you give and, if you fill them in, your name, company, what you'd use Diffinery for and where you host code today. Unconfirmed requests are deleted after 7 days; confirmed ones are kept until a site administrator deletes the request, and you can delete yours yourself at any time. To enforce daily limits, we keep a hashed form of your IP address and of the email address you typed for one day. Details: [Early access](/docs/accounts/early-access).
- **Security reports** (`/security/report`): what you write, and the email address you give for a reply if you aren't signed in. Only diffinery.com's site administrators can read reports.
- People who aren't signed in pass a **Cloudflare Turnstile** check on these forms, which Cloudflare runs using signals from your browser.

## Accounts on diffinery.com

diffinery.com is invite-only: accounts are for the people working on Diffinery. If you have one, we handle:

- **Account data:** your email address, username, display name and the profile details you add; the **public keys** of your passkeys (private keys never leave your device); access tokens and agent accounts you create, stored in a form that only lets us check them; who invited you and when.
- **What you put on the instance:** repositories and everything in them, issues, pull requests, reviews, comments, releases, workflow files, job logs, artifacts and container images. Git commits carry the author name and email address configured in git; in a public repository they are public.
- **Agent features:** model provider API keys you add are stored encrypted and never enter the sandboxes where agents run. When you start an agent task, review or sandbox, the prompts, code and command output the agent needs go to **the model provider you chose** (such as Anthropic or OpenAI), under your own account with that provider and its own terms and privacy policy. Diffinery keeps each task's transcript, visible to people with write access to the repository, and a record of the tokens each run used, so it can show usage and enforce budgets.
- **Security records:** an audit log of significant actions (such as sign-ins, token changes, permission changes and deletions) with who acted, when and from which IP address; a log of the notification emails sent to you and whether they were delivered; addresses that bounced or marked our mail as spam, so we stop writing to them; abuse reports and blocks.

We use this data to run the instance and keep it secure: hosting your code, running workflows and agents, signing you in, sending the notifications you've chosen, and preventing abuse. Where laws such as the GDPR apply, the legal bases are providing the service you signed up for and our legitimate interest in keeping it secure. **We don't use your private content to train machine-learning models.**

## Who processes the data

- **Cloudflare, Inc.** hosts diffinery.com and stores its data: Workers, Durable Objects, D1, R2, Queues, Containers (CI runners and agent sandboxes), Email Sending (notifications) and Turnstile. Data isn't pinned to one country: Cloudflare places it and runs jobs in its data centers around the world, and transfers rely on the Standard Contractual Clauses in Cloudflare's data processing terms.
- **The model provider you choose** for agent features, as described above.
- **Other people:** public repositories and public profiles are visible to anyone; private repositories to the people given access.
- **Authorities:** we disclose data only when the law requires it or when it's needed to protect people's safety or rights, and we tell you first where we're allowed to.

We don't sell or rent personal data, and we don't share it for advertising.

## How long data is kept

| Data | Kept |
| --- | --- |
| Request logs (with IP addresses) | Up to 7 days |
| Sign-in sessions | 30 days, or until you sign out |
| Notification email log | 90 days |
| Job logs | 90 days |
| Workflow artifacts | 1 to 90 days, as the workflow sets (90 by default) |
| Account data exports | 7 days |
| Audit log | 2 years |
| Database backups | 30 days of point-in-time recovery |
| Username of a deleted account | Not reusable for 90 days |
| Your account, content and provider keys | Until you delete them or your account |

## Your choices and rights

- **See and export your data:** under **Settings → Account**, download an archive with your profile, settings, repositories (as git bundles) and the issues, comments and reviews you wrote. See [Exporting and deleting your account](/docs/accounts/account-data).
- **Correct it:** edit your profile and email address in your settings.
- **Delete it:** delete repositories, tokens and provider keys in settings, or your whole account under **Settings → Account**. Commits, issues and comments you made in other people's repositories stay part of those repositories, shown as written by a deleted user, and the audit log keeps what your account did.
- **Anything else:** write to **hi@codician.com** to ask for a copy of your data, to object to or restrict a use of it, or with any question. We answer within one month. Depending on where you live, you can also complain to your data protection authority.

## Security

Data is encrypted in transit; provider keys and secrets are encrypted at rest; runners and sandboxes are isolated per job; sign-in uses passkeys; and access is logged. See [Security](/security). Please report vulnerabilities through [the private report form](/security/report), never a public issue.

## Children

diffinery.com is not meant for children, and its accounts are for the people working on Diffinery.

## Changes

We'll update this page when what we do changes and change the date at the top. If a change matters to people with accounts, we'll tell them by email before it takes effect.

## Contact

Codician, **hi@codician.com**. Security reports: [diffinery.com/security/report](/security/report).
