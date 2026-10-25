#!/usr/bin/env bash
# Mirror Diffinery's codician/diffinery main to github.com/codician-team/diffinery.
#
# Every author and committer becomes codician-team and the attribution trailers
# (Co-authored-by, Claude-Session, Signed-off-by) are dropped, so GitHub lists no
# personal contributors; old personal addresses in wrangler.jsonc are replaced.
# The rewrite is deterministic: the same Diffinery history always gives the same
# GitHub commits, so a sync is a fast-forward unless Diffinery's own history was
# rewritten (then GitHub follows it). Only main is mirrored.
#
# Reads Diffinery with DIFFINERY_TOKEN when set (not needed once the repo is public);
# MIRROR_SRC can also be a local clone that has main. Pushes with GITHUB_MIRROR_TOKEN
# when set, otherwise with whatever credentials git already has for github.com.
# Needs git-filter-repo 2.47.0 (pip install git-filter-repo==2.47.0); another
# version could write different commits.
#
# Usage: scripts/mirror-to-github.sh [--dry-run]
#
# MIRROR_WORKDIR=<empty dir> keeps the rewritten repository for inspection.
set -euo pipefail

SRC=${MIRROR_SRC:-https://diffinery.com/codician/diffinery.git}
DST=${MIRROR_DST:-https://github.com/codician-team/diffinery.git}
NAME=${MIRROR_NAME:-codician-team}
EMAIL=${MIRROR_EMAIL:-codician-team@users.noreply.diffinery.com}
dry_run=${1:-}

work=${MIRROR_WORKDIR:-}
if [ -z "$work" ]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
fi

auth=()
if [ -n "${DIFFINERY_TOKEN:-}" ]; then
  # The helper reads the token from the environment, so it never lands on a command line.
  auth=(-c 'credential.https://diffinery.com.helper=!f() { [ "$1" = get ] && printf "username=x-token\npassword=%s\n" "$DIFFINERY_TOKEN"; }; f')
fi
if [ -n "${GITHUB_MIRROR_TOKEN:-}" ]; then
  auth+=(-c 'credential.https://github.com.helper=!f() { [ "$1" = get ] && printf "username=x-access-token\npassword=%s\n" "$GITHUB_MIRROR_TOKEN"; }; f')
fi
git "${auth[@]}" clone --quiet --bare --single-branch --branch main "$SRC" "$work/repo.git"
cd "$work/repo.git"
src_head=$(git rev-parse main)

# Old wrangler.jsonc versions listed the bootstrap admins' personal addresses.
cat > "$work/replacements.txt" <<'RULES'
regex:("BOOTSTRAP_ADMINS": ")[^"]*@[^"]*"==>\1admin@example.com"
RULES

export MIRROR_NAME="$NAME" MIRROR_EMAIL="$EMAIL"
git filter-repo --force --quiet --refs main --replace-refs delete-no-add \
  --name-callback 'return os.environ["MIRROR_NAME"].encode()' \
  --email-callback 'return os.environ["MIRROR_EMAIL"].encode()' \
  --replace-text "$work/replacements.txt" \
  --message-callback '
import re
drop = re.compile(r"^(co-authored-by|claude-session|signed-off-by):|^\U0001f916 generated with \[claude code\]|^https://claude\.ai/code/session_", re.I)
text = message.decode("utf-8", "surrogateescape")
lines = [l for l in text.split("\n") if not drop.match(l.strip())]
return ("\n".join(lines).rstrip() + "\n").encode("utf-8", "surrogateescape")'

dst_head=$(git rev-parse main)
echo "Diffinery main $src_head -> GitHub main $dst_head"
if [ "$dry_run" = "--dry-run" ]; then
  git log --format='%h %an <%ae> %s' -3 main
  exit 0
fi
remote=$(git "${auth[@]}" ls-remote "$DST" refs/heads/main | cut -f1)
if [ "$remote" = "$dst_head" ]; then
  echo "GitHub is up to date."
  exit 0
fi
git "${auth[@]}" push --force "$DST" main:main
