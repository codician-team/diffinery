# Roadmap

Diffinery is young. This page lists what it can't do yet and the directions we'd like to
take, so you can judge whether it fits you today and where help is most welcome. Nothing
here has a date. If something matters to you, open an issue or a pull request.

## Works today

Git hosting over HTTPS, pull requests with reviews, auto-merge and a merge queue, issues,
releases, a container registry, GitHub Actions–compatible CI on per-job Cloudflare
Containers with automatic runner sizing, self-hosted runners, hosted runners for
repositories that stay on GitHub, a GitHub importer, the GitHub-compatible REST and GraphQL
APIs, an MCP server, agent accounts with guardrails, sandboxes, agent tasks and agent
review, the CLI, editor plugins and one-command deployment to your own Cloudflare account or
to [celld](https://diffinery.com/docs/self-hosting/celld). See
[Features](https://diffinery.com/features).

## Known gaps

These are the main differences from GitHub that people ask about:

- **Hosted macOS, Windows and Arm runners.** Hosted runners are Linux x64; other platforms
  use [self-hosted runners](https://diffinery.com/docs/actions/runners#self-hosted-runners).
- **Git over SSH.** Git works over HTTPS only.
- **Forks**, and pull requests between repositories.
- **Richer reviews:** pending reviews, suggested changes and resolving threads; code-owner
  reviews and signed-commit requirements in branch protection.
- **Workflow events** that are accepted but don't start runs yet, such as `issues` and
  `issue_comment`. See [Compatibility](https://diffinery.com/docs/actions/compatibility).
- **Importing from Gitea, Forgejo and GitLab.** The importer reads from GitHub; other forges
  move with [plain Git](https://diffinery.com/docs/migrate-from-github#move-with-plain-git).
- **Wikis, discussions and Pages-style static sites.**

## Good places to start contributing

- Compatibility gaps listed in
  [Compatibility with GitHub Actions](https://diffinery.com/docs/actions/compatibility):
  each one comes with the GitHub behaviour to match.
- Documentation: corrections, missing examples and guides for moving from other CI systems.
- Issues labelled `good first issue` and `help wanted`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to build, test and send changes, and
[CHANGELOG.md](CHANGELOG.md) for what has shipped.
