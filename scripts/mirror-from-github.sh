#!/usr/bin/env bash
# Mirror github.com/codician-team/diffinery to Diffinery's codician/diffinery.
#
# Development happens on GitHub. Its main and tags are copied to Diffinery as they are, so
# both have the same commits and Diffinery's main always ends up where GitHub's is: anything
# pushed to Diffinery's main by other means is overwritten. Diffinery's other branches, and
# its issues, pull requests and releases, are left alone.
#
# Pushes with DIFFINERY_TOKEN when set, otherwise with whatever credentials git already has
# for diffinery.com. It must be a person's token with the admin scope: only an admin's push
# goes past main's branch protection, agents can't push to main, and a workflow's own token
# can't push changes to workflow files.
#
# Usage: scripts/mirror-from-github.sh [--dry-run]
#
# MIRROR_WORKDIR=<empty dir> keeps the fetched repository for inspection.
set -euo pipefail

SRC=${MIRROR_SRC:-https://github.com/codician-team/diffinery.git}
DST=${MIRROR_DST:-https://diffinery.com/codician/diffinery.git}
dry_run=${1:-}

auth=()
if [ -n "${DIFFINERY_TOKEN:-}" ]; then
  # The helper reads the token from the environment, so it never lands on a command line.
  auth=(-c 'credential.https://diffinery.com.helper=!f() { [ "$1" = get ] && printf "username=x-token\npassword=%s\n" "$DIFFINERY_TOKEN"; }; f')
fi

# main and the tags, one "<sha>\t<ref>" line each (peeled tag lines dropped), sorted for comm.
refs() { git ${auth[@]+"${auth[@]}"} ls-remote "$1" refs/heads/main 'refs/tags/*' | grep -v '\^{}$' | LC_ALL=C sort; }
want=$(refs "$SRC")
have=$(refs "$DST")
# Diffinery may have tags GitHub doesn't; only GitHub's refs have to match.
stale=$(LC_ALL=C comm -23 <(printf '%s\n' "$want") <(printf '%s\n' "$have"))
if [ -z "$stale" ]; then
  echo "Diffinery is up to date with GitHub."
  exit 0
fi
echo "To copy from GitHub:"
printf '%s\n' "$stale"
if [ "$dry_run" = "--dry-run" ]; then
  exit 0
fi

work=${MIRROR_WORKDIR:-}
if [ -z "$work" ]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
fi
git init --quiet --bare "$work/repo.git"
cd "$work/repo.git"
git fetch --quiet "$SRC" '+refs/heads/main:refs/heads/main' '+refs/tags/*:refs/tags/*'
# GitHub wins: main and the tags move to where GitHub has them, fast-forward or not.
git ${auth[@]+"${auth[@]}"} push --force "$DST" 'refs/heads/main:refs/heads/main' 'refs/tags/*:refs/tags/*'
