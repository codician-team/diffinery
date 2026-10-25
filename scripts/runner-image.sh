#!/usr/bin/env bash
# Picks the runner image for a deploy. The tag is a hash of everything the image is built
# from (the Dockerfile and its build context: the built agent and image/), plus the ISO
# week so base packages are refreshed weekly. If the Cloudflare registry already has that
# tag, the deploy reuses it; otherwise it is built and pushed now. Any change to the runner
# changes the tag, so a changed runner is always rebuilt.
#
# Run from the repository root after `pnpm -r build`, with CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID set. Prints the image and, in Actions, sets RUNNER_IMAGE for later
# steps (scripts/render-config.mjs points every container at it).
set -euo pipefail
ctx=containers/runner
name=diffinery-runner
[ -f "$ctx/dist/agent.mjs" ] || { echo "::error::$ctx/dist/agent.mjs is missing; run pnpm -r build first"; exit 1; }

tag=$(
  {
    date -u +%G-W%V
    cd "$ctx" && find Dockerfile .dockerignore dist/agent.mjs image -type f | LC_ALL=C sort | xargs sha256sum
  } | sha256sum | cut -c1-24
)
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
image="registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/$name:$tag"
wrangler() { (cd apps/diffinery && pnpm exec wrangler "$@"); }

if ! listed=$(wrangler containers images list --json --filter "(^|/)$name\$" 2>&1); then
  echo "::warning::could not list the registry's images, so the runner image is built again: $(tail -n 3 <<<"$listed")"
  listed=""
fi
if grep -q "\"$tag\"" <<<"$listed"; then
  echo "reusing $name:$tag: the runner hasn't changed since it was built"
else
  echo "building $name:$tag"
  # The runner reports this as its image (not part of the tag's hash, which lists its inputs).
  echo "$name:$tag" > "$ctx/dist/image-tag"
  wrangler containers build "$PWD/$ctx" -t "$name:$tag" -p
fi
[ -z "${GITHUB_ENV:-}" ] || echo "RUNNER_IMAGE=$image" >> "$GITHUB_ENV"
echo "$image"
