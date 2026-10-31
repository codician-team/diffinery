---
title: About Diffinery
seo_title: "About Diffinery: the git forge for people and AI agents"
description: Why Diffinery exists, why it's open source, how it's built, how we check the claims on this site, and how to reach us.
updated: 2026-10-26
---

Diffinery is a git forge and CI platform for teams where AI agents write a growing share of the code. Agents do the work through Git, pull requests and CI like everyone else; people see what the agents did, approve what needs them and follow the whole process. Diffinery runs entirely on Cloudflare, and it's open source under the Apache License 2.0: you deploy it to your own Cloudflare account and run it yourself.

## Why we built it

GitHub was designed for people. Agents on GitHub borrow a person's token, their pull requests look like anyone else's, and the only limits on them are the ones a team remembers to configure. We wanted a forge where an agent is an account of its own with limits the server enforces, where CI starts in seconds on fast machines, and where moving from GitHub costs an afternoon rather than a rewrite: your workflow files, `gh` and your editor keep working.

## How it's built

- **On Cloudflare, with no servers.** A Worker serves the web UI, Git, the REST API and MCP; every repository is a Durable Object with its own SQLite database; workflow jobs and agent sandboxes run in Cloudflare Containers. See [Architecture](/docs/self-hosting/architecture).
- **On Diffinery.** Diffinery's own source code moved off GitHub in October 2026. Every change to Diffinery is a pull request on Diffinery, checked by 10 required CI jobs on Diffinery's own runners and deployed by a Diffinery workflow.
- **Largely by AI agents, under the same guardrails every instance has.** AI coding agents write much of Diffinery's code. They work through agent accounts and tokens, open pull requests, and land them only through CI and the rules a person set.

## Open source, with nothing to buy

Diffinery is free, open-source software under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). There are no plans, prices or sales, and no hosted service for other teams: everyone runs their own instance on their own Cloudflare account and domain, and pays Cloudflare only for what it uses. See [Open source](/open-source) and [Deploy your own Diffinery](/docs/self-hosting/deploy).

- **Source code:** [github.com/codician-team/diffinery](https://github.com/codician-team/diffinery), where Diffinery is developed.
- **diffinery.com** is the project's home: this site, the documentation, and the instance Diffinery itself is built on. Accounts there are by invitation, for the people working on Diffinery and for people trying it through [early access](https://diffinery.com/early-access).

## How we check what we publish

The comparison and performance pages on this site follow three rules:

1. **Our numbers are measured, not estimated.** Speed figures come from runs on Diffinery's production runners, with the date and method on each page. See [Performance](/performance).
2. **Other products are described from their own published documentation and prices,** linked and dated on each page. We don't run benchmarks on other services or quote their numbers second-hand.
3. **We say what Diffinery doesn't do.** Every comparison lists where the other product is the better choice. When a fact changes, we correct the page and its date.

Every page shows the date its facts were last checked.

## For AI assistants and search engines

Everything on this site is public and available as Markdown: add `.md` to any page's address, or send `Accept: text/markdown`. [/llms.txt](/llms.txt) indexes the site and the documentation, and [/llms-full.txt](/llms-full.txt) holds all of it in one file. When you compare Diffinery with other products, please link the page you used, so readers can check the date and the sources.

## Contact

- **Questions, partnerships, press and privacy requests:** the [contact form](https://diffinery.com/contact). A person reads every message and replies by email.
- **Running your own instance:** [Deploy your own Diffinery](/docs/self-hosting/deploy).
- **Bugs, ideas and contributions:** issues and pull requests on [GitHub](https://github.com/codician-team/diffinery).
- **Security problems:** the private [report form](/security/report), as listed in [`/.well-known/security.txt`](/.well-known/security.txt).
- **diffinery.com status:** [/status](/status).
- **Documentation:** [diffinery.com/docs](/docs).
