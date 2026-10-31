# Diffinery plugins for Claude Code and Codex

A plugin marketplace, kept in the Diffinery repository itself, that makes Claude Code and
OpenAI's Codex CLI work smoothly with repositories hosted on [Diffinery](https://diffinery.com),
the open-source git forge built for AI agents: on diffinery.com or on any instance you deploy
yourself (see [Any Diffinery instance](#any-diffinery-instance)).
It has two plugins: `diffinery` (Claude Code and Codex) and `diffinery-ci` (Claude Code),
described below.

The plugin adds:

| Piece | Claude Code | Codex |
| --- | --- | --- |
| `diffinery` MCP server (`<Diffinery URL>/mcp`, OAuth sign-in) | yes | yes (diffinery.com; see below for others) |
| `diffinery` skill: the CLI, git auth, the branch → PR → CI → merge loop, Diffinery's agent rules | yes | yes |
| `pr-status`: this branch's PR, its checks, and the log tail of failing jobs | `/diffinery:pr-status` command | `pr-status` skill |
| SessionStart hook: in a Diffinery clone, tells the agent the repo is on Diffinery and whether the `diffinery` CLI is installed and signed in | yes | yes, once you trust it (`/hooks`) |

`diffinery-ci` is a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview)
that shows the branch's pull request and its CI checks live, and tells Claude when CI settles:

| Piece | Where it works |
| --- | --- |
| Band above the prompt: PR number, title, checks (`✗ 1 failed · ● 3 running · ✓ 6`), review and merge state | Terminal, desktop app (Code tab), VS Code |
| `/diffinery-ci`: a pane with every check, its time and a link to its log, plus **Fix CI** and **Refresh**; `/diffinery-ci on` / `off` | Pane where Claude Code draws; a text answer everywhere else |
| Status line entry (`PR #7 ✓ 10/10`) and a toast when CI passes or fails | Where Claude Code draws |
| After the session pushes a branch or opens its PR, a note to Claude once that commit's checks settle (failures where the band shows the rest, passes too where nothing draws, so a cloud thread hears either way; `/diffinery-ci notes auto|failures|all|off` changes it, nothing to set up) | Everywhere hooks run, cloud sessions and project threads included |

It reads the GraphQL API of the Diffinery instance in `DIFFINERY_URL`, the plugin's Diffinery
URL setting or the CLI's saved URL (in that order, else diffinery.com), with the token from
`DIFFINERY_TOKEN`, `diffinery login`, or gh signed in to the host (`diffinery auth setup-gh`),
and sends a token only to the instance it belongs to. It needs
Claude Code 2.1.287 or later (the desktop app: 2.1.286). Cloud sessions run its hooks but
draw no mod interface, so there it's the note to Claude and the `/diffinery-ci` text.

Nothing here is needed just to use git: clone, fetch and push work with any git client
(`diffinery auth setup-git` or a token as the HTTPS password). The plugin is for pull
requests, CI and issues.

## Install

The marketplace is the public GitHub repository codician-team/diffinery, so adding it needs
no sign-in. The plugin works through the `diffinery` CLI, so install it and sign in once per
machine:

```sh
curl -fsSL https://diffinery.com/install | bash      # Windows: irm https://diffinery.com/install.ps1 | iex
diffinery login
diffinery auth setup-git
```

### Claude Code

```sh
claude plugin marketplace add codician-team/diffinery
claude plugin install diffinery@diffinery
```

Or inside a session: `/plugin marketplace add codician-team/diffinery`,
then `/plugin install diffinery@diffinery`, then `/reload-plugins` (or restart).

Add `claude plugin install diffinery-ci@diffinery` for the live CI band.

### claude.ai, cloud sessions and projects

claude.ai can't read this repository, so upload the plugins as files: download
https://diffinery.com/-/claude/diffinery.zip and https://diffinery.com/-/claude/diffinery-ci.zip,
then in claude.ai open **Customize → Plugins → Add → Upload plugin** for each. They reach your
cloud sessions at their next start. For a project's threads, also add them under
**Project settings → Plugins**. Build the same zips from a checkout with
`python3 scripts/pack-plugins.py` at the repository root (they land in `dist/`).

### Codex

```sh
codex plugin marketplace add codician-team/diffinery
codex plugin add diffinery@diffinery
```

Check with `codex plugin list` and `codex mcp list`. Codex runs plugin hooks only after
you review and trust them: open `/hooks` in the Codex TUI and trust the `diffinery`
SessionStart hook (optional; the skill works without it).

## Any Diffinery instance

Diffinery is open source, and every plugin here works with any instance, not only
diffinery.com. Both Claude Code plugins have a **Diffinery URL** setting (`userConfig.url`,
default `https://diffinery.com`). It sets the MCP server's address (`.mcp.json` uses
`${user_config.url}/mcp`), the instance the SessionStart hook recognises in a clone (it gets
the value as `CLAUDE_PLUGIN_OPTION_URL`), and the instance `diffinery-ci` reads.

- `diffinery setup --url https://git.example.com` sets it for you, in `pluginConfigs` in
  `~/.claude/settings.json`, for the copies it installs (`diffinery@inline`) and for
  marketplace installs alike. Install the CLI from the instance itself:
  `curl -fsSL https://git.example.com/install | bash`.
- Claude Code asks for it when you enable a marketplace install; change it later in `/config`.
- The zips an instance serves at `/-/claude/<name>.zip` default the setting to that instance
  (`apps/diffinery/src/docs/claude-plugins.ts`), so uploads to claude.ai need nothing else.
- The hook also knows `DIFFINERY_URL` and the URL `diffinery login` saved; `DIFFINERY_URL`
  takes precedence for the hook and for `diffinery-ci`, as it does for the CLI.

Codex substitutes no plugin settings, so the Codex manifest reads its own
`codex.mcp.json`, which names `https://diffinery.com/mcp`. A server of your own named
`diffinery` replaces it, and `diffinery setup --url` adds one when Codex is installed:
`codex mcp add diffinery --url https://git.example.com/mcp`. The skills and the hook work
with any instance in Codex too.

## Sign in

The MCP server signs you in with OAuth in the browser:

- Claude Code: run `/mcp`, pick `plugin:diffinery:diffinery`, choose Authenticate.
- Codex: `codex mcp login diffinery`.

The skill also uses the `diffinery` CLI, which has its own sign-in:

```sh
curl -fsSL https://diffinery.com/install | bash      # Windows: irm https://diffinery.com/install.ps1 | iex
diffinery login                                     # or: diffinery login --device
diffinery auth setup-git                            # optional: git credential helper
```

## Headless use (CI, cloud sessions): `DIFFINERY_TOKEN`

The `diffinery` CLI and `diffinery auth setup-git` pick up `DIFFINERY_TOKEN` on their own.

The plugin's MCP server uses OAuth only. Neither client can take a token from the
environment when it is set and fall back to OAuth when it is not, from one config:

- Claude Code turns OAuth off as soon as the server config has an `Authorization`
  header, even an empty one, and plugin header helpers do not see variables like
  `DIFFINERY_TOKEN`.
- Codex's `bearer_token_env_var` makes the server fail to start when the variable is unset.

So on headless machines, add a token-based server of your own. It takes precedence over
the plugin's:

```sh
# Claude Code: same URL, so the plugin's OAuth entry is hidden while this one exists
claude mcp add --scope user --transport http diffinery https://diffinery.com/mcp \
  --header 'Authorization: Bearer ${DIFFINERY_TOKEN}'

# Codex: same name, so it replaces the plugin's server
codex mcp add diffinery --url https://diffinery.com/mcp --bearer-token-env-var DIFFINERY_TOKEN
# ...or just for one run, without touching config.toml:
codex -c 'mcp_servers.diffinery.url="https://diffinery.com/mcp"' \
      -c 'mcp_servers.diffinery.bearer_token_env_var="DIFFINERY_TOKEN"' exec "..."
```

Keep the single quotes in the Claude Code command: Claude Code expands
`${DIFFINERY_TOKEN}` when it connects, so the token is never written to its config.

## claude.ai and the Claude apps

Settings → Connectors → Add custom connector, with the URL `https://diffinery.com/mcp`
(or your own instance's `https://git.example.com/mcp`). You sign in with your Diffinery
account when you connect it.

## gh

Prefer the `diffinery` CLI: it knows Diffinery's extras (`--intent`, auto-merge,
`run logs`). `gh` works too once you run `diffinery auth setup-gh`, which signs gh in to
the Diffinery host (diffinery.com or yours) as a GitHub Enterprise host. That is also what lets Claude Code show the
branch's pull request with its CI status. See https://diffinery.com/docs/agents/github-cli.

## Layout

Paths from the repository root:

```
.claude-plugin/marketplace.json     Claude Code marketplace
.agents/plugins/marketplace.json    Codex marketplace
plugins/diffinery/
  .claude-plugin/plugin.json        Claude Code manifest
  .codex-plugin/plugin.json         Codex manifest
  .claude-plugin/icon.png           the listing icon (also in diffinery-ci)
  .mcp.json                         the diffinery MCP server (Claude Code: ${user_config.url}/mcp)
  codex.mcp.json                    the diffinery MCP server (Codex: diffinery.com)
  skills/diffinery/SKILL.md         the skill (both clients)
  commands/pr-status.md             /pr-status (Claude Code)
  codex-skills/pr-status/SKILL.md   pr-status skill (Codex has no plugin commands)
  hooks/hooks.json                  SessionStart hook (both clients)
  hooks/session-start.sh            the hook: POSIX sh, no network, silent outside Diffinery repos
plugins/diffinery-ci/                Claude Code only (a mod)
  .claude-plugin/plugin.json        manifest
  hooks/hooks.json                  names the hooks module
  hooks/register.tsx                the mod: band, pane, status line, CI watch
  hooks/lib.ts                      parsing and wording, no engine calls
  types/index.d.ts                  the mod's state contract
  tests/ci.test.tsx                 `claude plugin test plugins/diffinery-ci`
scripts/pack-plugins.py             builds dist/<plugin>-<version>.zip for upload
apps/diffinery/claude-plugins/      the packed zips diffinery.com serves (see its README)
```

Check changes with `claude plugin validate .` and `claude plugin validate plugins/diffinery`
from the repository root, and for the mod `claude plugin validate plugins/diffinery-ci` and
`claude plugin test plugins/diffinery-ci`. Bump `version` in both plugin manifests and both marketplace entries
together.

More: https://diffinery.com/docs/connect

## License

Apache-2.0, like the rest of the repository. See [LICENSE](../LICENSE).
