#!/usr/bin/env bash
# Fails when a commit in the range is authored or committed as an AI tool, or its message
# carries AI attribution (a Co-authored-by line for an AI tool, Claude-Session, "Generated
# with ..."). See AGENTS.md, Rules, Commits.
#
# Usage: scripts/check-commit-authorship.sh <base> <head>
set -euo pipefail

base=$1
head=$2
ai_email='(@anthropic\.com|@openai\.com|cursoragent@|@cursor\.(com|sh)|copilot|@devin\.ai)'
ai_line='^(co-authored-by:.*(claude|anthropic|openai|codex|chatgpt|cursor|copilot|gemini|devin)|claude-session:|.*generated with \[?(claude|codex|cursor)|https://claude\.ai/code/session_)'

bad=0
for c in $(git rev-list "$base..$head"); do
  who=$(git log -1 --format='%ae%n%ce' "$c")
  if grep -qiE "$ai_email" <<<"$who" || git log -1 --format=%B "$c" | sed 's/^[[:space:]]*//' | grep -qiE "$ai_line"; then
    echo "::error::$(git log -1 --format='%h %s' "$c"): AI authorship or attribution"
    bad=1
  fi
done
if [ "$bad" = 1 ]; then
  echo "Author and commit as the person you work for, and drop AI Co-authored-by, Claude-Session"
  echo "and \"Generated with\" lines, then force-push the branch. See AGENTS.md."
  exit 1
fi
echo "Commit authorship OK."
