---
title: Reporting a vulnerability
description: How to report a security problem in Diffinery, what is in scope, safe harbour for good-faith research, the response times we aim for, and why there is no bounty.
---

If you think you have found a security problem in Diffinery, please tell us privately first, so we can fix it before anyone else uses it. This page says how, what we look at, how you are protected when you research in good faith, and what to expect from us.

## How to report

1. Use the private report form at [`/security/report`](/security/report), the first `Contact:` in this instance's [`/.well-known/security.txt`](/.well-known/security.txt). Only the instance's site administrators can read what you send. You can send it signed in, or without an account after a quick check that you're a person ([Cloudflare Turnstile](https://www.cloudflare.com/application-services/products/turnstile/)); then give an email address we can reply to. Diffinery's deploy sets Turnstile up for the form. If an instance still has none, the form asks you to sign in, and `security.txt` may list another contact (an email address or another form) after the first.
2. Write a report that lets us reproduce the problem. The form has a one-line summary, the details (up to 20,000 characters of plain text) and, optionally, the affected URL or area:
   - what is affected (a URL, an API endpoint, a git or MCP operation, a CLI command);
   - the steps, requests or a short script that show it, and what happened compared to what you expected;
   - what an attacker could do with it, as far as you know;
   - whether you have told anyone else, and when you would like to publish.
3. Write in English if you can. The form takes plain text only: describe screenshots or logs, and offer to send them once we reply.

The site administrators get an email with your summary only, and read the rest in Diffinery. Your reference number is shown when you send the report; quote it if you write again. You can send up to 5 reports a day without signing in from one network, and 10 a day from one account.

Please don't report in a public issue, a pull request, a discussion or social media. If the report includes a secret you came across (a token, a key, someone's data), say so and don't keep a copy.

## In scope

- The Diffinery application: the web UI, the REST API (`/api/v3`), git over HTTPS, the MCP server, the container registry, webhooks, Actions (workflow runs, runners, OIDC tokens, secrets), agent tasks and sandboxes, and the `diffinery` CLI.
- The source code of Diffinery itself, including the scripts that deploy it.
- Problems such as: reading or changing data you shouldn't, getting around sign-in, branch protection, push protection, token scopes, agent guardrails or kill switches, escaping a job or sandbox container, reaching secrets, cross-site scripting or request forgery, and server-side request forgery.

## Out of scope

- Cloudflare's own platform and services, and other third-party services. Report those to their owners.
- Another operator's instance of Diffinery, unless the problem is in Diffinery's code: then report it here, and only test it on an instance you run yourself or have permission to test.
- Denial of service by sheer volume, spam, and load testing.
- Social engineering, phishing, and physical attacks on people or offices.
- Reports from automated scanners with no shown impact, missing headers that change nothing in practice, and self-XSS.
- Anything that needs a compromised device, browser or account to begin with.

## Safe harbour

If you research and report in good faith and follow this page, we will consider your research authorised, we won't take legal action against you or ask anyone else to, and if someone else does we will say that you acted with our permission. Good faith means you:

- test only against accounts and repositories that you own or have permission to use, and stop as soon as you have shown the problem;
- don't access, change, keep or share other people's data beyond the minimum needed to show the problem, and don't degrade the service for others;
- don't use what you found for anything other than reporting it;
- give us a reasonable time to fix it before you publish anything, and agree the date with us.

If you aren't sure whether something is allowed, ask first through the [report form](/security/report).

This safe harbour covers Diffinery's own claims only. It can't speak for Cloudflare, other services, or the operator of an instance you don't own.

## What to expect

These are the times we aim for, not promises: a small team runs Diffinery, and a hard problem can take longer.

| Step | Target |
| --- | --- |
| We confirm we received your report | 3 working days |
| We tell you whether we can reproduce it, and how serious we think it is | 10 working days |
| We fix a critical or high-severity problem | 30 days |
| We fix other problems | 90 days |

We keep you informed while we work on it, tell you when the fix is released, and, if you want, credit you by name in the release notes. We ask you to wait for the fix, or for 90 days from your report if we haven't agreed another date, before publishing.

## No bounty

There is no bug bounty: we don't pay for reports. We are grateful for every one, and are glad to credit you.

## See also

- [Security overview](/docs/security/overview), for how Diffinery protects accounts, code and secrets.
- [Configuration](/docs/self-hosting/configuration#security-contact), for operators: what `security.txt` serves, and adding contacts to it. The deploy sets up Turnstile for the form, so people without an account can report; its Cloudflare API token needs **Account → Turnstile → Edit** for that (see [Turnstile](/docs/self-hosting/configuration#turnstile)).
- [Site administration](/docs/admin/site-administration#security-reports), for operators: reading and triaging reports.
