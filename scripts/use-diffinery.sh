#!/usr/bin/env bash
# Points a checkout cloned from the GitHub mirror (github.com/codician-team/diffinery) at
# the project's home on Diffinery (https://diffinery.com/codician/diffinery), where
# branches are pushed and pull requests are opened. The mirror follows Diffinery, so
# changes go to Diffinery first.
#
#   DIFFINERY_TOKEN=dfy_... scripts/use-diffinery.sh
#
# DIFFINERY_TOKEN is a Diffinery token with the `write` scope (Settings -> Tokens).
# DIFFINERY_REPO_URL points the checkout at another copy, such as your fork or your own
# instance (default https://diffinery.com/codician/diffinery.git).
#
# What it changes:
# - Adds a git credential helper for the Diffinery host to your global git config. The
#   helper reads DIFFINERY_TOKEN from the environment when git asks, so the token is never
#   written to disk or put on a command line.
# - Renames the GitHub remote to "github", fetch-only (pushes there would be overwritten
#   by the mirror), and makes "origin" the Diffinery repository.
# - When the checkout is clean, moves the current branch forward to Diffinery's copy of
#   it, or to Diffinery's main if the branch is new and starts from the mirror's main.
set -euo pipefail
[ -n "${DIFFINERY_TOKEN:-}" ] || { echo "DIFFINERY_TOKEN is not set" >&2; exit 1; }
url=${DIFFINERY_REPO_URL:-https://diffinery.com/codician/diffinery.git}

host=${url#*://}; host=${host%%/*}
git config --global "credential.https://$host.helper" \
  '!f() { [ "$1" = get ] && printf "username=x-token\npassword=%s\n" "$DIFFINERY_TOKEN"; }; f'

if [ "$(git remote get-url origin 2>/dev/null || true)" != "$url" ]; then
  if git remote get-url origin >/dev/null 2>&1 && ! git remote get-url github >/dev/null 2>&1; then git remote rename origin github; fi
  if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin "$url"; else git remote add origin "$url"; fi
fi
git remote get-url github >/dev/null 2>&1 && git remote set-url --push github nothing-goes-back-to-github
git fetch -q origin
git remote set-head origin -a >/dev/null 2>&1 || true

branch=$(git symbolic-ref -q --short HEAD || true)
if [ -n "$branch" ] && [ -z "$(git status --porcelain)" ]; then
  for base in "origin/$branch" origin/main; do
    if git rev-parse -q --verify "$base" >/dev/null && git merge-base --is-ancestor HEAD "$base"; then
      git merge -q --ff-only "$base"
      echo "$branch is now at $base ($(git rev-parse --short HEAD))"
      break
    fi
  done
  if git rev-parse -q --verify "origin/$branch" >/dev/null; then git branch -q --set-upstream-to="origin/$branch"; fi
fi
echo "origin is $url. Push there; open pull requests on https://$host, or through https://$host/api/v3 with the same token."
