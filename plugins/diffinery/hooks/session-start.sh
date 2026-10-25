#!/bin/sh
# SessionStart hook for the diffinery plugin (Claude Code and Codex).
#
# When the session's working directory is a git repository with a remote on a Diffinery instance,
# prints JSON that adds a short note to the agent's context: where the repository is hosted,
# whether the diffinery CLI is installed and signed in there, and that it is preferred over gh.
# Elsewhere it prints nothing. It never touches the network and always exits 0.
#
# The instances it knows, in this order: DIFFINERY_URL, the plugin's Diffinery URL setting
# (CLAUDE_PLUGIN_OPTION_URL, Claude Code only), the URL `diffinery login` saved, and diffinery.com.

# The origin of a URL as scheme://host[:port], lower-cased; nothing unless it is plain http(s) with a
# host of letters, digits, dots and dashes, so it is safe to put in a pattern and in JSON.
origin_of() {
  printf '%s\n' "$1" | tr 'A-Z' 'a-z' |
    sed -n -E 's#^[[:space:]]*(https?://)?([a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:[0-9]{1,5})?(/.*)?[[:space:]]*$#\1\2\4#p' |
    sed '/:\/\//!s#^#https://#' | head -n 1
}

main() {
  dir=${CLAUDE_PROJECT_DIR:-$PWD}
  command -v git >/dev/null 2>&1 || return 0

  case ${XDG_CONFIG_HOME:-} in
    /*) cfg=$XDG_CONFIG_HOME/diffinery/config.json ;;
    *) cfg=$HOME/.config/diffinery/config.json ;;
  esac
  saved=
  [ -f "$cfg" ] && saved=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" 2>/dev/null | head -n 1)

  # origin first, then any other remote.
  remotes=$(
    {
      git -C "$dir" remote get-url origin
      git -C "$dir" config --get-regexp '^remote\..*\.url$' | sed 's/^[^ ]* //'
    } 2>/dev/null
  )
  [ -n "$remotes" ] || return 0

  # Only the instance's host itself counts (not lookalike hosts), and owner/repo are limited to
  # characters that are safe to put in JSON.
  slug= base=
  for u in "${DIFFINERY_URL:-}" "${CLAUDE_PLUGIN_OPTION_URL:-}" "$saved" https://diffinery.com; do
    base=$(origin_of "$u")
    [ -n "$base" ] || continue
    host=${base#*://}
    host=${host%%:*}
    pat=$(printf '%s' "$host" | sed 's/[.]/[.]/g')
    slug=$(printf '%s\n' "$remotes" |
      sed -n -E "s#^([A-Za-z][A-Za-z0-9+.-]*://)?([^@/]+@)?$pat(:[0-9]+)?[:/]+([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)/*\$#\\4/\\5#p" |
      head -n 1)
    [ -n "$slug" ] && break
  done
  [ -n "$slug" ] || return 0
  slug=${slug%.git}

  cli=no
  if command -v diffinery >/dev/null 2>&1; then
    cli=yes
  elif [ -x "${DIFFINERY_INSTALL:-$HOME/.diffinery}/bin/diffinery" ]; then
    cli="yes, at ${DIFFINERY_INSTALL:-$HOME/.diffinery}/bin/diffinery (not on PATH)"
  fi

  # The CLI's token belongs to the instance the CLI points at: DIFFINERY_URL, else the saved URL.
  cli_url=$(origin_of "${DIFFINERY_URL:-${saved:-https://diffinery.com}}")
  signed=no
  if [ "${cli_url#*://}" != "${base#*://}" ]; then
    other=yes
  else
    other=no
    if [ -n "${DIFFINERY_TOKEN:-}" ]; then
      signed="yes (DIFFINERY_TOKEN)"
    elif [ -f "$cfg" ] && grep -q '"token"' "$cfg" 2>/dev/null; then
      signed=yes
    fi
  fi

  msg="This repository is hosted on the Diffinery instance at $base ($slug). Use the diffinery CLI (installed: $cli, signed in there: $signed) or the diffinery MCP tools for pull requests, CI and issues (they support Diffinery's --intent, auto-merge and run logs); gh works once \`diffinery auth setup-gh\` has signed it in to $host. The diffinery skill has the workflow."
  case $cli in
    no) msg="$msg Install the CLI with \`curl -fsSL $base/install | bash\`." ;;
  esac
  if [ "$other" = yes ]; then
    msg="$msg The CLI points at ${cli_url:-another instance}: to use it here, ask the user to run \`diffinery setup --url $base\` (or \`diffinery login --url $base\`), or set DIFFINERY_URL=$base and DIFFINERY_TOKEN."
  elif [ "$signed" = no ]; then
    msg="$msg To sign in, ask the user to run \`diffinery login\` (or \`diffinery login --device\`), or set DIFFINERY_TOKEN."
  fi

  # The text has no quotes or backslashes today; escape them anyway so the JSON stays valid.
  esc=$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$esc"
}

main 2>/dev/null || true
exit 0
