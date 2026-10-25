#!/usr/bin/env bash
# Installs the Diffinery extension into the editors built on VS Code on this computer (Linux and macOS):
#
#   curl -fsSL https://diffinery.com/install-editor | bash              # every editor found
#   curl -fsSL https://diffinery.com/install-editor | bash -s -- cursor  # only the ones named
#
# Names: code, code-insiders, cursor, windsurf, codium. Each editor's command-line tool is used from
# PATH, or from its usual place in /Applications on macOS. The .vsix comes from the server that served
# this script and is checked against the SHA-256 it publishes. The extension updates itself afterwards.
# Served by Diffinery from apps/vscode/install/.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "This installer needs bash: curl -fsSL __DIFFINERY_URL__/install-editor | bash" >&2
  exit 1
fi
set -euo pipefail

server=${DIFFINERY_URL:-__DIFFINERY_URL__}
case $server in __*) server=https://diffinery.com ;; esac
server=${server%/}

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  bold=$'\033[1m' dim=$'\033[2m' green=$'\033[32m' red=$'\033[31m' reset=$'\033[0m'
else
  bold='' dim='' green='' red='' reset=''
fi
say() { printf '%s\n' "$*" >&2; }
die() {
  say "${red}error${reset}: $*"
  exit 1
}
command -v curl >/dev/null || die "curl is required"

# name|label|macOS app bundle
known="code|VS Code|Visual Studio Code
code-insiders|VS Code Insiders|Visual Studio Code - Insiders
cursor|Cursor|Cursor
windsurf|Windsurf|Windsurf
codium|VSCodium|VSCodium"

find_cli() {
  local name=$1 app=$2
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return
  fi
  for base in "/Applications" "$HOME/Applications"; do
    local p="$base/$app.app/Contents/Resources/app/bin/$name"
    if [ -x "$p" ]; then
      printf '%s\n' "$p"
      return
    fi
  done
  return 1
}

wanted=" $* "
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
meta=$(curl -fsSL "$server/-/vscode/version.json") || die "couldn't reach $server"
version=$(printf '%s' "$meta" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
sha=$(printf '%s' "$meta" | sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p')
[ -n "$version" ] && [ -n "$sha" ] || die "unexpected answer from $server/-/vscode/version.json"
vsix=$tmp/diffinery-$version.vsix
curl -fsSL "$server/-/vscode/diffinery-$version.vsix" -o "$vsix" || die "downloading the extension failed"
if command -v sha256sum >/dev/null; then got=$(sha256sum "$vsix" | cut -d' ' -f1); else got=$(shasum -a 256 "$vsix" | cut -d' ' -f1); fi
[ "$got" = "$sha" ] || die "the download didn't match the published SHA-256; nothing was installed"

installed=0
while IFS='|' read -r name label app; do
  if [ "$wanted" != "  " ] && [[ $wanted != *" $name "* ]]; then continue; fi
  cli=$(find_cli "$name" "$app") || {
    [ "$wanted" != "  " ] && say "${red}✗${reset} $label: its command-line tool ($name) wasn't found"
    continue
  }
  if "$cli" --install-extension "$vsix" --force >/dev/null 2>"$tmp/err"; then
    say "${green}✓${reset} $label: Diffinery extension $version installed"
    installed=$((installed + 1))
  else
    say "${red}✗${reset} $label: $(tail -n 3 "$tmp/err")"
  fi
done <<<"$known"

if [ "$installed" = 0 ]; then
  say "No editor took the extension. Install it from the editor instead: Extensions → … → Install from VSIX…"
  say "with ${bold}$server/-/vscode/diffinery.vsix${reset}, or see $server/docs/repositories/clone-in-your-editor"
  exit 1
fi
say ""
say "Next: in the editor, run ${bold}Git: Clone${reset} and pick ${bold}Clone from Diffinery${reset}. ${dim}($server/docs/repositories/clone-in-your-editor)${reset}"
