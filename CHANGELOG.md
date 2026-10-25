# Changelog

Notable changes to Diffinery. Diffinery is deployed continuously from `main`; versions mark
points worth naming. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

[0.1.0]: https://diffinery.com/codician/diffinery/releases/tag/v0.1.0
