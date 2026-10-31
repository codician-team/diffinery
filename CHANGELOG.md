# Changelog

Notable changes to Diffinery. Diffinery is deployed continuously from `main`; versions mark
points worth naming. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
How a release is made is in [docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

## [0.2.0] - 2026-10-31

Development moved to [GitHub](https://github.com/codician-team/diffinery). GitHub
repositories can run their jobs on Diffinery's hosted runners, and Diffinery runs on celld
and with an SMTP server as well as on Cloudflare's own services.

### Actions (CI/CD)

- **GitHub runners.** Keep your code on GitHub, install your instance's GitHub App from
  **Settings → GitHub runners** and set a job's `runs-on` to `diffinery`: GitHub's own
  runner runs the job in a fresh hosted runner container, one job per container, paid from
  the linked account's hosted minutes.
- Jobs keep running when GitHub is down: Diffinery keeps a copy of every public action
  jobs download and uses it when GitHub can't be reached.
- Hosted runners have KVM, so the Android emulator runs in a job.
- Runs, jobs and workflows have numeric ids, so `gh run` and `gh workflow` work, and `gh`
  works inside workflows with the job token.
- **Settings → Environments** sets deployment branches and environment secrets in the
  web UI.

### Git hosting and collaboration

- release-please works: GraphQL commit history, associated pull requests and releases.
- `gh issue` commands work over GraphQL.
- Merged pull requests keep their commits and files, and compare takes revisions such as
  `main~1`.
- **Delete closed pull requests** in **Settings → General → Danger zone** starts a
  repository over with fresh history while keeping its issues and settings.

### AI agents and integrations

- The Claude Code and Codex plugins, `diffinery setup`, the MCP configuration and the
  VS Code and JetBrains extensions work with any Diffinery instance, not only
  diffinery.com. Plugins install from GitHub:
  `claude plugin marketplace add codician-team/diffinery`.
- MCP tool results link to what they made or read.
- Instances serve the MCP Registry's domain proof at `/.well-known/mcp-registry-auth`.

### Self-hosting

- Runs on [celld](https://diffinery.com/docs/self-hosting/celld), the open-source Workers
  runtime, as well as on Cloudflare.
- Email through any SMTP server (`SMTP_URL`, `SMTP_PASSWORD`) instead of Cloudflare Email
  Sending.
- Rate limits without Cloudflare's rate limiting bindings: `RATE_LIMITS=durable` counts in a
  Durable Object.
- A public contact form at `/contact`, with Turnstile, email confirmation and review by
  site administrators.
- The Deploy workflow deploys every push to `main` once CI passes, on GitHub Actions too,
  takes the GitHub App's IDs from repository variables, and runs on the label in
  `DIFFINERY_RUNS_ON`.

### Changed

- Development happens at https://github.com/codician-team/diffinery. The copy at
  diffinery.com/codician/diffinery is no longer updated and its Actions are off.

## [0.1.0] - 2026-10-25

The first open-source release, under the Apache License 2.0.

### Git hosting and collaboration

- Git over HTTPS with tokens or browser sign-in, shallow clones, Git LFS and
  `refs/pull/<n>/head` and `/merge`; each repository is a Durable Object with its own SQLite
  database, and large pushes are unpacked from R2 in pieces.
- Pull requests with an `intent` field, drafts, reviews with line comments, required
  approvals and checks, merge, squash and rebase, auto-merge, merge on green and a merge
  queue with `merge_group` runs.
- Issues, labels, milestones, reactions and mentions; releases with assets and generated
  notes; checks and commit statuses.
- Branch protection, push protection that blocks leaked credentials on every push, an
  append-only audit log, moderation, quotas and kill switches.
- A container registry for OCI images.

### Actions (CI/CD)

- Runs GitHub Actions workflows from `.github/workflows/` (and `.diffinery/workflows/`):
  triggers, expressions, matrices, `needs`, outputs, reusable workflows, environments,
  secrets, variables, OIDC, service containers, Docker, concurrency groups and schedules.
- JavaScript, composite and Docker actions from GitHub, with `checkout`, `setup-node`,
  `setup-python`, `setup-go`, `cache` and the artifact actions built into the runner.
- Hosted runners in Cloudflare Containers: a fresh Ubuntu 24.04 container per job, 4 vCPU and
  12 GiB by default, smaller sizes chosen per job from its own measured runs, jobs starting in
  about 3 to 5 seconds. Self-hosted runners with `diffinery runner`.

### AI agents

- Agent accounts owned by a person or an organization, with server-enforced guardrails: no
  pushes or merges to protected branches unless a rule allows it, a person's approval on
  agent pull requests, and no secrets for runs of agent-written code.
- A built-in MCP server at `/mcp` with browser sign-in, sandboxes, agent tasks that run
  Claude Code, Codex or your own command and open a pull request, agent code review,
  projects with shared memory and a Today page of what needs you.
- Plugins for Claude Code and Codex, the `diffinery` CLI, `gh` support, and extensions for
  VS Code, Cursor, Windsurf and JetBrains IDEs.

### Moving and running

- A GitHub importer for a repository or a whole organization, with history, issues, pull
  requests, reviews and releases.
- GitHub-compatible REST (`/api/v3`) and GraphQL (`/api/graphql`) APIs and webhooks.
- `scripts/setup.sh`, which deploys an instance to your own Cloudflare account and domain.
- Documentation at https://diffinery.com/docs, also as Markdown, `llms.txt` and
  `llms-full.txt`.

[Unreleased]: https://github.com/codician-team/diffinery/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/codician-team/diffinery/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/codician-team/diffinery/releases/tag/v0.1.0
