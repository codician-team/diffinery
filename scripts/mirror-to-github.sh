#!/usr/bin/env bash
# Mirror Diffinery's codician/diffinery main to github.com/codician-team/diffinery.
#
# Every author and committer becomes codician-team and the attribution trailers
# (Co-authored-by, Claude-Session, Signed-off-by) are dropped, so GitHub lists no
# personal contributors.
# The rewrite is deterministic: the same Diffinery history always gives the same
# GitHub commits, so a sync is a fast-forward unless Diffinery's own history was
# rewritten (then GitHub follows it). Only main, the tags on it and their releases
# are mirrored.
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
EMAIL=${MIRROR_EMAIL:-hi@codician.com}
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

export MIRROR_NAME="$NAME" MIRROR_EMAIL="$EMAIL"
git filter-repo --force --quiet --refs main --replace-refs delete-no-add \
  --name-callback 'return os.environ["MIRROR_NAME"].encode()' \
  --email-callback 'return os.environ["MIRROR_EMAIL"].encode()' \
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
  echo "GitHub main is up to date."
else
  git "${auth[@]}" push --force "$DST" main:main
fi

# Tags on main follow their commits, as lightweight tags (so no tagger identity).
declare -A rewritten
while read -r old new; do rewritten[$old]=$new; done < <(tail -n +2 filter-repo/commit-map)
remote_tags=$(git "${auth[@]}" ls-remote --tags "$DST")
mirrored=()
for tag in $(git tag); do
  target=${rewritten[$(git rev-parse "$tag^{commit}")]:-}
  [ -n "$target" ] && [ "$target" != 0000000000000000000000000000000000000000 ] || continue
  if grep -qx "$target"$'\t'"refs/tags/$tag" <<<"$remote_tags" || git "${auth[@]}" push --force "$DST" "$target:refs/tags/$tag"; then
    mirrored+=("$tag")
  else
    echo "warning: could not push tag $tag" >&2
  fi
done

# Releases on the mirrored tags get the same name, notes and flags on GitHub (assets aren't copied).
# Needs GITHUB_MIRROR_TOKEN for GitHub's API.
if [ -n "${GITHUB_MIRROR_TOKEN:-}" ] && [ ${#mirrored[@]} -gt 0 ]; then
  MIRROR_TAGS="${mirrored[*]}" python3 - <<'PY'
import json, os, urllib.error, urllib.request

src = os.environ.get("MIRROR_SRC_API", "https://diffinery.com/api/v3/repos/codician/diffinery")
dst = os.environ.get("MIRROR_DST_API", "https://api.github.com/repos/codician-team/diffinery")
tags = set(os.environ["MIRROR_TAGS"].split())

def call(method, url, body=None, token=None):
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode())
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "diffinery-mirror")
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, None

token = os.environ["GITHUB_MIRROR_TOKEN"]
status, releases = call("GET", f"{src}/releases?per_page=100", token=os.environ.get("DIFFINERY_TOKEN"))
if status != 200:
    raise SystemExit(f"could not list Diffinery releases ({status})")
for r in releases:
    if r["draft"] or r["tag_name"] not in tags:
        continue
    want = {"name": r["name"], "body": r["body"] or "", "prerelease": r["prerelease"]}
    status, have = call("GET", f"{dst}/releases/tags/{r['tag_name']}", token=token)
    if status == 404:
        status, _ = call("POST", f"{dst}/releases", {"tag_name": r["tag_name"], **want}, token)
        print(f"release {r['tag_name']}: created ({status})")
    elif status == 200 and any(have.get(k) != v for k, v in want.items()):
        status, _ = call("PATCH", f"{dst}/releases/{have['id']}", want, token)
        print(f"release {r['tag_name']}: updated ({status})")
    elif status != 200:
        print(f"warning: could not read GitHub release {r['tag_name']} ({status})")
PY
fi
