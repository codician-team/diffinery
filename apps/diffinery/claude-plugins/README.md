# Claude Code plugins, as served for diffinery setup

The plugins in plugins/ at the repository root, packed by `scripts/pack-plugins.py`
(reproducible: the same sources give the same bytes). Diffinery serves them at
`/-/claude/<name>.zip` (and `/-/claude/<name>-<version>.zip`): `diffinery setup` downloads them
(apps/cli/src/commands/claude-plugins.ts, also from Agent setup's script), checks the
x-diffinery-plugin-sha256 header and names them in Claude Code's settings, so installing them
needs no access to the plugin repository. See docs/connect/ci-status-in-claude.md.

To update one: change it in plugins/, bump its version (in its manifests and in both
marketplace files), run `python3 scripts/pack-plugins.py <name>` at the repository root,
replace the zip here (one file per plugin, `<name>-<version>.zip`), and check that `sha256sum`
matches a fresh pack of the merged commit.
scripts/build-docs.mjs embeds them and refuses a name it doesn't know, two versions of one
plugin, or a zip without `.claude-plugin/plugin.json` at its root.
