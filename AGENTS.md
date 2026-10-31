# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor and others) working on this
repository. People should read [CONTRIBUTING.md](CONTRIBUTING.md); everything here agrees
with it.

## What this repository is

Diffinery: an open-source git forge with GitHub Actions–compatible CI that runs entirely on
Cloudflare. One Cloudflare Worker serves the web UI, git over HTTPS, a GitHub-compatible
REST and GraphQL API and an MCP server; each repository is a Durable Object with its own
SQLite database; CI jobs run in Cloudflare Containers. Development happens at
https://github.com/codician-team/diffinery: push branches and open pull requests there.
https://diffinery.com/codician/diffinery is an older copy that is no longer updated, with
Actions off.

## Layout

```
apps/diffinery          the Worker: src/ (web UI, git, REST/GraphQL, MCP, Actions), migrations/ (D1),
                        docs/ (served at diffinery.com/docs), site/ (marketing pages), test/ (unit and e2e)
apps/cli                the `diffinery` command-line client
apps/vscode             the VS Code, Cursor and Windsurf extension
apps/jetbrains          the JetBrains IDE plugin
plugins                 the Claude Code and Codex plugins
containers/runner       the runner agent, sandbox server and container image
packages/git-core       git objects, packfiles, deltas, diff and merge, in pure TypeScript
packages/workflow-yaml  the GitHub Actions workflow parser, expressions, matrices and cron
packages/shared         types shared by the Worker and the runner
scripts                 setup and deploy scripts for Cloudflare
```

## Commands

Node.js 22 and pnpm 10 (`corepack enable`). No Cloudflare account is needed to develop.

```sh
pnpm install
pnpm -r build                                  # runner agent, web islands and docs
pnpm -r typecheck
pnpm -r test                                   # unit tests (Vitest)
pnpm --filter @diffinery/app db:migrate:local  # local D1
pnpm dev                                       # http://localhost:8787, signed in as dev@diffinery.local
cd apps/diffinery && node --test --test-timeout=600000 test/e2e/<file>.test.mjs   # one e2e file
```

Run repository tools with `pnpm exec`, never bare `npx`. Run the typecheck and the unit
tests before you ask for review, and the end-to-end file closest to your change. Tests must
not depend on the speed of the machine they run on.

## Rules

- **Docs ship with the feature.** Any user- or admin-visible change updates the Markdown in
  `apps/diffinery/docs` (and `apps/diffinery/site` for product pages). Write for people and
  agents: short sentences, exact names of buttons, settings, endpoints and flags.
- **Follow GitHub where GitHub has an API, event or workflow feature**, so git, `gh`,
  Octokit and actions keep working. Document any difference in
  `apps/diffinery/docs/actions/compatibility.md` or the relevant page.
- **Keep it running on celld**, the open-source Workers runtime
  (`apps/diffinery/docs/self-hosting/celld.md`). Make a binding celld lacks optional (and list it in
  `CELLD_ABSENT_BINDINGS`), map any new `wrangler.jsonc` key in `scripts/celld-config.mjs`, and import only
  `cloudflare:workers`, `cloudflare:workflows`, `cloudflare:sockets` and the `node:` modules celld has. Never return a stream or a
  `Response` from a Durable Object RPC method: stream through its `fetch()`. `test/unit/celld.test.ts` checks it.
- **D1 migrations** live in `apps/diffinery/migrations`. Use the next free number and never
  edit a migration that has shipped.
- **Security:** guardrails for agents are enforced on the server for git, REST, MCP and the
  web UI alike. Never add a bypass, never log secrets or tokens, and never weaken push
  protection, branch protection or the runner sandbox to make something pass.
- **UI:** passkeys first, no passwords; Kumo components through `KSelect`, `KCheckbox` and
  `KRadio`, never a native `<select>`, checkbox or radio. See
  [docs/PREFERENCES.md](docs/PREFERENCES.md).
- **Code style:** strict TypeScript, few dependencies, comments that say why, matching the
  density and style of the code around your change.
- **Pull requests:** one change each, a title that says what it does, an `intent` that says
  what it is for, and the person you work for in the description. Changes under
  `.github/workflows` need a maintainer to merge them. Never skip or disable a test to get
  green.

## Reading the docs as an agent

Every docs page is Markdown at `https://diffinery.com/docs/<page>.md`, the whole set is in
https://diffinery.com/llms.txt and https://diffinery.com/llms-full.txt, and the MCP server
at `https://diffinery.com/mcp` has `search_docs` and `read_docs`. See
[Docs for AI agents](https://diffinery.com/docs/agents/docs-for-agents).
