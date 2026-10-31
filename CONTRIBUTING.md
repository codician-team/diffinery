# Contributing to Diffinery

Thanks for your interest in Diffinery. Bug reports, fixes, documentation, compatibility
reports and new features are all welcome, from people and from AI agents working for
them.

## Where development happens

Diffinery is developed at
[github.com/codician-team/diffinery](https://github.com/codician-team/diffinery). Open
issues and pull requests there. Its CI runs on Diffinery's own runners for GitHub, and
merges to `main` deploy diffinery.com.

[diffinery.com/codician/diffinery](https://diffinery.com/codician/diffinery) is a mirror
that follows GitHub's `main` every 15 minutes, with the same commits, and runs the same CI
on Diffinery. Changes pushed to its `main` are overwritten, so land them on GitHub.

Security problems are the exception: report them privately, never in an issue or pull
request. See [SECURITY.md](SECURITY.md).

## Before you start

- For anything bigger than a small fix, open an issue first and describe what you want to
  change, so we can agree on the approach before you spend time on it.
- Check [Compatibility with GitHub Actions](https://diffinery.com/docs/actions/compatibility)
  before reporting a workflow difference: known gaps are listed there.
- Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up a development environment

You need Node.js 22 and pnpm 10 (the repository pins `pnpm@10.28.0`; `corepack enable`
picks it up). Docker is only needed to build the runner image. No Cloudflare account is
needed: everything runs locally under `wrangler dev`.

```sh
pnpm install
pnpm -r build                                  # runner agent, web islands and docs
pnpm --filter @diffinery/app db:migrate:local  # local D1
pnpm dev                                       # http://localhost:8787, signed in as dev@diffinery.local
```

## Tests

```sh
pnpm -r typecheck
pnpm -r test                        # unit tests (Vitest)
pnpm --filter @diffinery/app e2e    # end-to-end: wrangler dev, real git, the runner agent and Chromium
```

The end-to-end suite pushes real repositories with `git`, runs their workflows through the
real runner agent, drives the MCP server and the REST API with `@octokit/rest`, and signs
in with passkeys in Chromium with a virtual authenticator. It takes a while and uses a lot
of memory for the large-push tests; run the file you changed first, for example
`cd apps/diffinery && node --test --test-timeout=600000 test/e2e/registry.test.mjs`.

Pull requests must pass CI (typecheck, the Worker bundle and the unit tests) and the
end-to-end shards before they merge. Tests must not depend on the speed of the machine
they run on.

## Conventions

- **TypeScript everywhere**, in strict mode, sharing code through the workspace packages in
  `packages/`. Keep dependencies few: the git core (`packages/git-core`) needs only `pako` and `diff`.
- **Comments say why**, in plain sentences, next to the code they explain. Match the
  density and style of the code around your change.
- **Docs ship with the feature.** Every user- or admin-visible change updates the pages in
  `apps/diffinery/docs` (served at [diffinery.com/docs](https://diffinery.com/docs), also as
  Markdown and in `llms.txt`). Write for people and for AI agents: short sentences, exact
  names of buttons, settings, endpoints and flags, and tables for reference material.
- **GitHub compatibility.** Where GitHub has an API, a workflow feature or an event,
  Diffinery follows it, so existing tools (git, `gh`, Octokit, actions) work unchanged.
  When Diffinery has to differ, say so in the docs.
- **Open-source runtime.** Diffinery also runs on [celld](https://celld.dev), the open-source
  Workers runtime. A Cloudflare feature celld lacks must be optional, a new `wrangler.jsonc`
  key must be mapped in `scripts/celld-config.mjs`, and the unit test `celld.test.ts` checks
  both. See [Run on celld](https://diffinery.com/docs/self-hosting/celld).
- **Database migrations.** D1 migrations live in `apps/diffinery/migrations`. Use the next
  free number and never edit a migration that has shipped.
- **Security first.** Agents never get a bypass: guardrails are enforced on the server for
  git, REST, MCP and the web UI alike. Never log secrets or tokens. Changes to sign-in,
  tokens, permissions, secrets or the runner sandbox get extra review.
- **UI and product conventions** (passkeys first, Kumo components, no native `<select>` or
  checkboxes) are in [docs/PREFERENCES.md](docs/PREFERENCES.md).

## Pull requests

- Keep each pull request to one change, with a title that says what it does
  ("Merge queue: rebuild groups behind a failed one") and a description of why and how it
  was tested. The [pull request template](.github/pull_request_template.md) has the
  checklist.
- Changes to files under `.github/workflows` always need a maintainer to merge them, on
  purpose: agents can't land workflow changes.
- Pull requests are squash-merged.

## AI agents

Agents are welcome contributors. An agent working on this repository should follow the
same conventions, run the tests before asking for review, and say in the pull request
which person it works for. The [docs for AI agents](https://diffinery.com/docs/agents/docs-for-agents)
explain how to read the documentation as Markdown and over MCP.

## License

Diffinery is licensed under the [Apache License 2.0](LICENSE). By contributing, you agree
that your contributions are licensed under the same license, as section 5 of the license
describes.
