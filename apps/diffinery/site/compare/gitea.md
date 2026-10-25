---
title: Diffinery vs Gitea and Forgejo
seo_title: "Diffinery vs Gitea and Forgejo: Actions, self-hosting, runners"
description: Gitea, Forgejo and Diffinery are all open-source forges you run yourself. Gitea and Forgejo run on your servers; Diffinery on your Cloudflare account.
updated: 2026-10-25
---

Gitea and Forgejo are open-source, self-hosted git forges. Forgejo was created from Gitea in October 2022 ([source](https://forgejo.org/compare-to-gitea/)) and is developed under Codeberg e.V., a non-profit, which also runs the public forge Codeberg.org on Forgejo ([source](https://docs.codeberg.org/getting-started/what-is-codeberg/)). Both have built-in CI whose workflow files look like GitHub Actions (Gitea Actions and Forgejo Actions), with jobs run by runners you install. Diffinery is also open source (Apache-2.0) and also something you run yourself, but on your own Cloudflare account rather than on your own servers: it runs GitHub Actions workflows on runners that your instance starts in Cloudflare Containers (see [Deploy your own Diffinery](/docs/self-hosting/deploy) and the [source code](https://diffinery.com/codician/diffinery)). Gitea, Forgejo and Codeberg facts here are from their own websites and documentation, checked on October 25, 2026, and linked below.

## In short

- **The biggest difference is where it runs.** All three are open-source forges you run yourself. Gitea and Forgejo are software you install and operate on your own servers, along with the runners for their CI (unless you buy Gitea Cloud, which runs both for you). Diffinery runs only on Cloudflare: you deploy it to your own Cloudflare account, with no servers or runner machines to manage, but your code lives on Cloudflare's infrastructure rather than on hardware you control, and there's no version for your own machines.
- **Choose Gitea or Forgejo** if your code has to stay on servers you control, you don't want to depend on one cloud provider, you want a forge someone runs for you (Gitea Cloud, or Codeberg for free software), or you want a forge with wikis and a package registry. Choose Forgejo if non-profit governance and a copyleft license matter to you.
- **Choose Diffinery** if you want hosted runners with 4 vCPUs by default and documented GitHub Actions compatibility, no servers or runner machines to look after, and AI agents held to guardrails by the forge itself, and Cloudflare is an acceptable place for your code.

## Side by side

| | Diffinery | Gitea | Forgejo |
| --- | --- | --- | --- |
| What it is | An open-source git forge with pull requests, issues, releases, a container registry and GitHub Actions–compatible CI, deployed to your own Cloudflare account | "A self-hosted DevOps platform", open source with commercial support from CommitGo ([source](https://about.gitea.com/)) | "A self-hosted lightweight software forge" ([source](https://forgejo.org/)) |
| License | Apache-2.0 ([source](https://diffinery.com/codician/diffinery)) | MIT ([source](https://about.gitea.com/pricing/)) | GPL v3 or later from v9.0; MIT up to v8.0 ([source](https://forgejo.org/faq/)) |
| Who develops it | The Diffinery project, in the open at [diffinery.com/codician/diffinery](https://diffinery.com/codician/diffinery), mirrored [on GitHub](https://github.com/codician-team/diffinery) | Gitea, led by CommitGo ([source](https://about.gitea.com/)) | A community under Codeberg e.V., a non-profit ([source](https://forgejo.org/)) |
| Where it runs | Your own Cloudflare account and domain only ([guide](/docs/self-hosting/deploy)); not on your own servers, and there's no hosted service | Your own servers: builds for Linux, Windows, macOS and FreeBSD, with SQLite, MySQL or PostgreSQL ([source](https://docs.gitea.com/installation/install-from-binary)); or fully managed as Gitea Cloud ([source](https://about.gitea.com/products/cloud/)) | Your own servers; or Codeberg.org for free software projects ([source](https://docs.codeberg.org/getting-started/faq/)) |
| CI | Diffinery Actions: GitHub Actions YAML from `.github/workflows/` | Gitea Actions, since Gitea 1.19: "similar and mostly compatible to GitHub Actions" ([source](https://docs.gitea.com/usage/actions/overview)), with workflows in `.gitea/workflows/` and off by default in each repository ([source](https://docs.gitea.com/usage/actions/quickstart)) | Forgejo Actions: "designed to be familiar to users of GitHub Actions" but "not designed to be compatible"; reads `.github/workflows/` when there's no `.forgejo/workflows/` ([source](https://forgejo.org/docs/latest/user/actions/overview/)) |
| Known differences from GitHub Actions | Listed in [Compatibility](/docs/actions/compatibility) | `jobs.<id>.environment` is ignored, problem matchers and error annotations are ignored, and some `permissions` scopes aren't supported ([source](https://docs.gitea.com/usage/actions/comparison)) | A different default image (Debian with Node.js), some `github` context keys missing, `permissions` and `continue-on-error` on jobs ignored, and OIDC turned on with its own key ([source](https://forgejo.org/docs/latest/user/actions/github-actions/)) |
| Hosted runners | Yes: your instance starts a fresh Ubuntu 24.04 container per job in Cloudflare Containers, 4 vCPU and 12 GiB by default, with no runner machines to install | Gitea Runner, which you install; on Gitea Cloud, runners start on demand ([runner](https://docs.gitea.com/usage/actions/overview), [Cloud](https://about.gitea.com/products/cloud/)) | Forgejo Runner, which you install ([source](https://forgejo.org/docs/latest/user/actions/overview/)). Codeberg offers hosted Forgejo Actions "in a limited fashion in open alpha", and a Woodpecker CI instance by request ([source](https://docs.codeberg.org/ci/)) |
| Self-hosted runners | `diffinery runner`, on any machine | Yes | Yes |
| Wikis and packages | No wikis; a container registry | Wikis, a package and container registry, Git LFS, push and pull mirrors and a merge queue, among others ([source](https://docs.gitea.com/installation/comparison)) | Wikis, a package and container registry, and repository mirrors, among others ([source](https://forgejo.org/docs/latest/user/)) |
| Price | Free and open source. You pay Cloudflare for your instance's usage, on the Workers Paid plan: "a minimum cost of $5 USD per month per account", plus usage above the included amounts ([source](https://developers.cloudflare.com/workers/platform/pricing/), checked October 25, 2026) | Free to self-host; Gitea Enterprise is a per-user subscription with a 30-day trial ([source](https://about.gitea.com/pricing/)); Gitea Cloud has a 30-day trial and no published price ([source](https://about.gitea.com/products/cloud/)) | Free software. Codeberg hosts free software projects and doesn't offer private hosting for commercial projects ([source](https://docs.codeberg.org/getting-started/faq/)) |
| MCP server | Built in at `/mcp` on your instance, with browser sign-in | An official MCP server, gitea-mcp, that you run next to your instance ([source](https://gitea.com/gitea/gitea-mcp)) | Not covered here |
| AI agents | Agent accounts with server-enforced guardrails, sandboxes, agent tasks and agent review | Not covered here | Not covered here |

## Where each one is the better fit

**Gitea or Forgejo is the better fit when** your code must stay on hardware you control, including inside a private network; when you don't want to depend on one cloud provider; when you'd rather have someone run the forge for you, with Gitea Cloud; when you need wikis or a package registry; or when you're happy to run a server and runners. Forgejo also suits teams that want a forge governed by a non-profit and licensed under the GPL. Codeberg suits free software projects that want a public forge run by a non-profit.

**Diffinery is the better fit when** you want an open-source forge without operating servers or CI machines, are happy to run it on your own Cloudflare account, want hosted runners that run GitHub Actions workflows with every difference documented, want features such as push protection and agent guardrails on by default, and work with AI coding agents that should open pull requests rather than push to main.

## Moving from Gitea or Forgejo

Deploy your own instance first ([guide](/docs/self-hosting/deploy)). Diffinery's importer reads from GitHub. From Gitea or Forgejo, push your branches and tags with plain Git; see [Move with plain Git](/docs/migrate-from-github#move-with-plain-git). Issues and pull requests don't come across this way. Diffinery reads workflows from `.github/workflows/` and `.diffinery/workflows/`, so move files from `.gitea/workflows/` or `.forgejo/workflows/` into one of them, and check them with `diffinery workflow validate`.

## Frequently asked questions

### Is Diffinery a Gitea or Forgejo alternative?

Yes, if Cloudflare is an acceptable place for your code. Like Gitea and Forgejo, Diffinery is open source and you run it yourself. It covers Git hosting, pull requests, issues, releases, a container registry and CI, and your instance starts the runners for you in Cloudflare Containers. It isn't a replacement if you need to run the forge on your own servers or need wikis.

### Can I self-host Diffinery like Gitea or Forgejo?

Yes, on your own Cloudflare account, but not on your own servers. Diffinery is open source (Apache-2.0) and runs on Cloudflare (Workers, Durable Objects, R2, D1, Workflows and Containers); see [Deploy your own Diffinery](/docs/self-hosting/deploy) and [Architecture](/docs/self-hosting/architecture). Jobs can run on your own machines through [self-hosted runners](/docs/actions/runners#self-hosted-runners).

### Do Gitea Actions and Forgejo Actions workflows run on Diffinery?

Most of their workflow syntax is GitHub Actions syntax, which Diffinery runs. Move the files into `.github/workflows/` or `.diffinery/workflows/`, and check anything specific to Gitea or Forgejo, such as Forgejo's `enable-openid-connect` key for OIDC (on Diffinery, use `permissions: id-token: write`, as on GitHub) or `runs-on` labels for runners you registered there. Every difference from GitHub is listed in [Compatibility with GitHub Actions](/docs/actions/compatibility).

### Are Gitea Actions compatible with GitHub Actions?

Gitea describes Gitea Actions as "similar and mostly compatible to GitHub Actions" and lists the differences in its documentation ([source](https://docs.gitea.com/usage/actions/comparison)). Forgejo says Forgejo Actions is "designed to be familiar to users of GitHub Actions" but "not designed to be compatible" ([source](https://forgejo.org/docs/latest/user/actions/overview/)).

### Can I host a company's private code on Codeberg?

Codeberg's FAQ says it "does not offer private hosting services" for commercial projects and points to self-hosting Forgejo instead ([source](https://docs.codeberg.org/getting-started/faq/)).

### Is Gitea or Forgejo cheaper than Diffinery?

All three are free, open-source software. With Gitea and Forgejo you pay for the servers and runners and the time to run them; Gitea Enterprise and Gitea Cloud are paid. With Diffinery you pay Cloudflare for what your instance uses: the Workers Paid plan, "a minimum cost of $5 USD per month per account", plus usage above the included amounts ([source](https://developers.cloudflare.com/workers/platform/pricing/), checked October 25, 2026), and runner containers billed by the 10 ms while a job runs ([source](https://developers.cloudflare.com/containers/pricing/), checked October 25, 2026). Which costs less depends on your usage.
