#!/usr/bin/env bash
# Sets up an agent environment (a Claude Code cloud environment, Codex, a CI runner, a dev box) to work
# on __DIFFINERY_REPO__, as its Settings → Agent setup page on Diffinery shows:
#
#   curl -fsSL __DIFFINERY_URL__/__DIFFINERY_REPO__/agent-setup.sh | bash
#
# 1. Installs the diffinery CLI and puts it on PATH (/usr/local/bin/diffinery when that's writable),
#    skipping the download when the installed CLI is already the server's current build.
# 2. Runs `diffinery setup --repo __DIFFINERY_REPO__`: git and gh use the token in DIFFINERY_TOKEN (gh
#    through GH_ENTERPRISE_TOKEN and GH_HOST), read from the environment each time and never written to
#    disk; the repository is cloned unless it's there (DIFFINERY_NO_CLONE=1 skips that, and
#    DIFFINERY_CLONE_DIR says where); then a self-test, one line per check, and a report to the page.
#
# Safe to run every time a session starts, fully non-interactive, and it never prints the token.
# This script holds no secret: Diffinery serves the same one to anyone, with the repository's name in it.
# It exits 1 when the CLI can't be installed or a check fails, so a broken setup isn't kept. Without
# DIFFINERY_TOKEN it sets up what it can, says what to add, and exits 0.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "This script needs bash: curl -fsSL __DIFFINERY_URL__/__DIFFINERY_REPO__/agent-setup.sh | bash" >&2
  exit 1
fi
set -uo pipefail

server=__DIFFINERY_URL__
repo=__DIFFINERY_REPO__
cli_sha256=__DIFFINERY_CLI_SHA256__
root=${DIFFINERY_INSTALL:-$HOME/.diffinery}
# Where the diffinery command is linked from, when it's writable (running as root).
link_dir=${DIFFINERY_LINK_DIR:-/usr/local/bin}
host=${server#*://}
page="$server/$repo/settings/agent-setup"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  green=$'\033[32m' red=$'\033[31m' bold=$'\033[1m' reset=$'\033[0m'
else
  green='' red='' bold='' reset=''
fi
say() { printf '%s\n' "$*"; }
fail() {
  say "${red}✗${reset} $*"
  exit 1
}

say "${bold}Diffinery agent setup for $repo${reset}"
command -v curl >/dev/null || fail "curl is required"
command -v git >/dev/null || fail "git is required: install it in the setup script first (apt-get install -y git)"
original_path=$PATH

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# 1. The CLI.
installed=$root/lib/diffinery.mjs
if [ -f "$installed" ] && [ "$(sha256 "$installed")" = "$cli_sha256" ] && "$root/bin/diffinery" --version >/dev/null 2>&1; then
  say "${green}✓${reset} diffinery CLI: already the current build"
else
  # With /usr/local/bin to link from (root in a container or VM), the CLI leaves startup files alone.
  no_rc=${DIFFINERY_NO_MODIFY_PATH:-}
  if [ -d "$link_dir" ] && [ -w "$link_dir" ]; then no_rc=1; fi
  installer=$(curl -fsSL "$server/install") || fail "couldn't download $server/install: allow $host in the environment's network settings (Custom with $host, or Full)"
  # The installer's own next steps (sign in through a browser, PATH) are for people: shown only if it fails.
  if ! out=$(printf '%s\n' "$installer" | DIFFINERY_URL=$server DIFFINERY_INSTALL=$root DIFFINERY_NO_MODIFY_PATH=$no_rc bash 2>&1); then
    printf '%s\n' "$out"
    fail "the diffinery CLI didn't install (see above)"
  fi
  say "${green}✓${reset} diffinery CLI: installed $("$root/bin/diffinery" --version 2>/dev/null)"
fi
if [ -d "$link_dir" ] && [ -w "$link_dir" ]; then
  ln -sfn "$root/bin/diffinery" "$link_dir/diffinery" || fail "couldn't link $link_dir/diffinery"
fi

# 2. git, gh, the clone and the self-test. The original PATH is what the PATH check looks at.
export PATH="$root/bin:$PATH"
if [ -z "${DIFFINERY_TOKEN:-}" ]; then
  # Without the token git still gets its credential helper, which reads DIFFINERY_TOKEN once it's set.
  DIFFINERY_URL=$server diffinery auth setup-git >/dev/null 2>&1 || true
  say "${red}✗${reset} DIFFINERY_TOKEN is not set: generate a token on $page and add the Environment variables shown there."
  say "  git and the CLI are set up and will use the token once it's in the environment; run this again then to check."
  exit 0
fi
if [ -n "${DIFFINERY_REPO:-}" ] && [ "$DIFFINERY_REPO" != "$repo" ]; then
  say "note: DIFFINERY_REPO is $DIFFINERY_REPO, but this script sets up $repo"
fi
DIFFINERY_SETUP_PATH=$original_path diffinery setup --repo "$repo" --url "$server"
