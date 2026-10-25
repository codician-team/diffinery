#!/bin/sh
# SessionStart hook for the diffinery plugin (Claude Code and Codex).
#
# When the session's working directory is a git repository with a remote on diffinery.com,
# prints JSON that adds a short note to the agent's context: where the repository is hosted,
# whether the diffinery CLI is installed and signed in, and that it is preferred over gh there.
# Elsewhere it prints nothing. It never touches the network and always exits 0.

main() {
  dir=${CLAUDE_PROJECT_DIR:-$PWD}
  command -v git >/dev/null 2>&1 || return 0

  # origin first, then any other remote. Only diffinery.com itself counts (not lookalike
  # hosts), and owner/repo are limited to characters that are safe to put in JSON.
  slug=$(
    {
      git -C "$dir" remote get-url origin
      git -C "$dir" config --get-regexp '^remote\..*\.url$' | sed 's/^[^ ]* //'
    } 2>/dev/null |
      sed -n -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)?([^@/]+@)?diffinery\.com(:[0-9]+)?[:/]+([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)/*$#\4/\5#p' |
      head -n 1
  )
  [ -n "$slug" ] || return 0
  slug=${slug%.git}

  cli=no
  if command -v diffinery >/dev/null 2>&1; then
    cli=yes
  elif [ -x "${DIFFINERY_INSTALL:-$HOME/.diffinery}/bin/diffinery" ]; then
    cli="yes, at ${DIFFINERY_INSTALL:-$HOME/.diffinery}/bin/diffinery (not on PATH)"
  fi

  signed=no
  case ${XDG_CONFIG_HOME:-} in
    /*) cfg=$XDG_CONFIG_HOME/diffinery/config.json ;;
    *) cfg=$HOME/.config/diffinery/config.json ;;
  esac
  if [ -n "${DIFFINERY_TOKEN:-}" ]; then
    signed="yes (DIFFINERY_TOKEN)"
  elif [ -f "$cfg" ] && grep -q '"token"' "$cfg" 2>/dev/null; then
    signed=yes
  fi

  msg="This repository is hosted on Diffinery ($slug). Use the diffinery CLI (installed: $cli, signed in: $signed) or the diffinery MCP tools for pull requests, CI and issues (they support Diffinery's --intent, auto-merge and run logs); gh works once \`diffinery auth setup-gh\` has signed it in to diffinery.com. The diffinery skill has the workflow."
  case $cli in
    no) msg="$msg Install the CLI with \`curl -fsSL https://diffinery.com/install | bash\`." ;;
  esac
  if [ "$signed" = no ]; then
    msg="$msg To sign in, ask the user to run \`diffinery login\` (or \`diffinery login --device\`), or set DIFFINERY_TOKEN."
  fi

  # The text has no quotes or backslashes today; escape them anyway so the JSON stays valid.
  esc=$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$esc"
}

main 2>/dev/null || true
exit 0
