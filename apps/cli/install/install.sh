#!/usr/bin/env bash
# Installs the Diffinery CLI on Linux and macOS:
#
#   curl -fsSL https://diffinery.com/install | bash
#
# The CLI goes in ~/.diffinery (set DIFFINERY_INSTALL to change that), and ~/.diffinery/bin is
# added to PATH in your shells' startup files, with a link in ~/.local/bin or ~/bin when one of
# those is on PATH already so it works at once (DIFFINERY_NO_MODIFY_PATH=1 skips both). It runs on
# Node.js 22 or later: the one on your PATH when it's new enough, otherwise a private copy of the
# Node.js LTS from nodejs.org, checked against its published SHA-256, in ~/.diffinery/node.
# Run it again, or `diffinery upgrade`, to update. Served by Diffinery from apps/cli/install/.

# Piped into sh instead of bash, a shell like dash stops at `set -o pipefail` with no hint why.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "This installer needs bash: curl -fsSL __DIFFINERY_URL__/install | bash" >&2
  exit 1
fi
set -euo pipefail

server=${DIFFINERY_URL:-__DIFFINERY_URL__}
case $server in __*) server=https://diffinery.com ;; esac
server=${server%/}
root=${DIFFINERY_INSTALL:-$HOME/.diffinery}
bin=$root/bin
node_line=24

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
tilde() { case $1 in "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }

command -v curl >/dev/null || die "curl is required"
case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN*) die "on Windows, run this in PowerShell instead: irm $server/install.ps1 | iex" ;;
  *) die "$(uname -s) isn't supported by this script; install Node.js 22 or later and download $server/-/cli/diffinery.mjs" ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) arch='' ;;
esac
# A shell under Rosetta on Apple silicon still gets the arm64 Node.js.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then arch=arm64; fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

node_ok() { "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; }

# 1. Node.js for the CLI to run on.
private=$root/node/bin/node
if [ -x "$private" ] && node_ok "$private"; then
  node=$private
elif command -v node >/dev/null && node_ok node; then
  node=''
else
  [ -n "$arch" ] || die "the CLI needs Node.js 22 or later, and nodejs.org has no build for $(uname -m); install Node.js and run this again"
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then die "the CLI needs Node.js 22 or later; on Alpine and other musl systems install it with your package manager (apk add nodejs) and run this again"; fi
  say "Installing Node.js $node_line LTS for the CLI, from nodejs.org…"
  dist=https://nodejs.org/dist/latest-v$node_line.x
  sums=$(curl -fsSL "$dist/SHASUMS256.txt") || die "couldn't reach nodejs.org"
  line=$(printf '%s\n' "$sums" | grep -E "  node-v[0-9.]+-$os-$arch\.tar\.gz$" | head -n 1 || true)
  [ -n "$line" ] || die "nodejs.org has no Node.js build for $os-$arch"
  want=${line%% *}
  file=${line##* }
  curl -fsSL "$dist/$file" -o "$tmp/node.tar.gz" || die "couldn't download $file"
  if command -v sha256sum >/dev/null; then got=$(sha256sum "$tmp/node.tar.gz"); else got=$(shasum -a 256 "$tmp/node.tar.gz"); fi
  [ "${got%% *}" = "$want" ] || die "$file doesn't match its published SHA-256, so it wasn't installed"
  mkdir -p "$tmp/node" "$root"
  tar -xzf "$tmp/node.tar.gz" -C "$tmp/node" --strip-components 1
  rm -rf "$root/node"
  mv "$tmp/node" "$root/node"
  node=$private
fi

# 2. The CLI itself: one JavaScript file.
curl -fsSL "$server/-/cli/diffinery.mjs" -o "$tmp/diffinery.mjs" || die "couldn't download the CLI from $server"
head -n 1 "$tmp/diffinery.mjs" | grep -q '^#!/usr/bin/env node' || die "$server/-/cli/diffinery.mjs isn't the CLI"
mkdir -p "$root/lib" "$bin"
chmod 755 "$tmp/diffinery.mjs"
mv -f "$tmp/diffinery.mjs" "$root/lib/diffinery.mjs"

# 3. The diffinery command: the private Node.js when there is one, else the node on PATH.
q=$(printf '%q' "$root")
cat >"$tmp/diffinery" <<EOF
#!/bin/sh
# The Diffinery CLI, installed from $server/install. Update it with: diffinery upgrade
root=$q
node=\$root/node/bin/node
[ -x "\$node" ] || node=node
exec "\$node" "\$root/lib/diffinery.mjs" "\$@"
EOF
chmod 755 "$tmp/diffinery"
mv -f "$tmp/diffinery" "$bin/diffinery"
version=$("$bin/diffinery" --version) || die "the CLI was installed in $(tilde "$root") but doesn't start; run $bin/diffinery --version to see why"

# 4. PATH: in startup files for new terminals, plus a link in a directory already on PATH (such as
# ~/.local/bin) so the command works right away, in this terminal and in agents' shells too.
added='' kept='' ready='' linked=''
# As written in startup files: $HOME/.diffinery/bin rather than the expanded path, when it's in $HOME.
case $bin in "$HOME"/*) rc_bin='$HOME'${bin#"$HOME"} ;; *) rc_bin=$bin ;; esac
on_path() { case ":$PATH:" in *":$1:"*) return 0 ;; esac; return 1; }
# Adds the line for this kind of file, once: sh syntax for bash, zsh and sh, fish's own for fish.
add_to() {
  local rc=$1 line
  case $rc in
    *.fish) line="fish_add_path \"$rc_bin\"" ;;
    *) line="case \":\$PATH:\" in *\":$rc_bin:\"*) ;; *) export PATH=\"$rc_bin:\$PATH\" ;; esac" ;;
  esac
  if grep -qsF -e "$bin" -e "$rc_bin" "$rc"; then kept=${kept:+$kept, }$(tilde "$rc"); return; fi
  mkdir -p "$(dirname "$rc")"
  printf '\n# Diffinery CLI\n%s\n' "$line" >>"$rc"
  added=${added:+$added, }$(tilde "$rc")
}
if on_path "$bin"; then
  ready=1
elif [ -z "${DIFFINERY_NO_MODIFY_PATH:-}" ]; then
  # The startup files of the login shell, created if missing, and of any other shell already set
  # up here. Bash reads only the first of ~/.bash_profile, ~/.bash_login and ~/.profile in a login
  # shell (every macOS terminal), so the line goes in the one it reads, never a new one that hides it.
  shell=$(basename "${SHELL:-sh}")
  zrc=${ZDOTDIR:-$HOME}/.zshrc
  bash_login=''
  for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [ -f "$f" ]; then bash_login=$f; break; fi
  done
  rcs=()
  case $shell in
    zsh) rcs+=("$zrc") ;;
    bash) rcs+=("$HOME/.bashrc" "${bash_login:-$([ "$os" = darwin ] && echo "$HOME/.bash_profile" || echo "$HOME/.profile")}") ;;
    fish) rcs+=("$HOME/.config/fish/conf.d/diffinery.fish") ;;
    *) rcs+=("$HOME/.profile") ;;
  esac
  [ "$shell" = zsh ] || [ ! -f "$zrc" ] || rcs+=("$zrc")
  [ "$shell" = bash ] || [ ! -f "$HOME/.bashrc" ] || rcs+=("$HOME/.bashrc")
  [ "$shell" = fish ] || [ ! -d "$HOME/.config/fish" ] || rcs+=("$HOME/.config/fish/conf.d/diffinery.fish")
  for rc in "${rcs[@]}"; do add_to "$rc"; done
  # A link from a personal bin directory that's already on PATH, unless something else lives there.
  for dir in "$HOME/.local/bin" "$HOME/bin"; do
    if on_path "$dir" && [ -d "$dir" ] && [ -w "$dir" ]; then
      if [ "$(readlink "$dir/diffinery" 2>/dev/null || true)" = "$bin/diffinery" ] || { [ ! -e "$dir/diffinery" ] && [ ! -L "$dir/diffinery" ]; }; then
        ln -sfn "$bin/diffinery" "$dir/diffinery"
        linked=$dir/diffinery ready=1
      fi
      break
    fi
  done
  # In a workflow job, later steps get it on PATH too.
  if [ -n "${GITHUB_PATH:-}" ] && [ -w "${GITHUB_PATH}" ]; then echo "$bin" >>"$GITHUB_PATH"; fi
fi

say "${green}✓${reset} ${version} installed to $(tilde "$bin/diffinery")${node:+ ${dim}(with its own Node.js)${reset}}"
if [ -n "$added" ]; then
  say "Added $(tilde "$bin") to PATH in $added."
elif [ -n "$kept" ]; then
  say "New terminals already get $(tilde "$bin") on PATH from $kept."
fi
[ -z "$linked" ] || say "Linked it from $(tilde "$linked"), so diffinery works in this terminal now."
if [ -z "$ready" ]; then
  if [ -n "${DIFFINERY_NO_MODIFY_PATH:-}" ]; then
    say "Add $(tilde "$bin") to your PATH to run diffinery."
  else
    say "Open a new terminal, or run this to use diffinery in this one:"
    say "  ${bold}export PATH=\"$rc_bin:\$PATH\"${reset}"
  fi
fi
other=$(command -v diffinery 2>/dev/null || true)
if [ -n "$other" ] && [ "$other" != "$bin/diffinery" ] && [ "$(readlink "$other" 2>/dev/null || true)" != "$bin/diffinery" ]; then say "${dim}Another diffinery at $(tilde "$other") comes first on your PATH; remove it to use this one.${reset}"; fi
setup="diffinery setup"
[ "$server" = https://diffinery.com ] || setup="diffinery setup --url $server"
say ""
say "Next, sign in through your browser and set up git (and gh, if you have it):"
say "  ${bold}$setup${reset}"
