#!/usr/bin/env bash
# Waits after `wrangler deploy` until the container rollouts it started reach their last step.
# `wrangler deploy` returns as soon as a rollout starts. Even in the last step, an instance the
# rollout hasn't updated yet starts jobs on the old image, so the Live test waits until jobs
# report the deployed image. Running containers keep the old image until they exit
# (rollout_active_grace_period), so the rollouts don't need to complete.
#
# Run from the repository root with CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and
# RUNNER_IMAGE (scripts/runner-image.sh) set. Gives up with a warning after
# ROLLOUT_WAIT_MINUTES (default 10) rather than failing the deploy.
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}" "${RUNNER_IMAGE:?RUNNER_IMAGE is required (scripts/runner-image.sh)}"
api() { curl -fsS --retry 4 --retry-all-errors --retry-delay 3 "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/containers$1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"; }
deadline=$(( $(date +%s) + ${ROLLOUT_WAIT_MINUTES:-10} * 60 ))
last=""
while :; do
  if ! apps=$(api /applications); then
    echo "::warning::could not list the container applications, so the deploy doesn't wait for the rollout"
    exit 0
  fi
  pending=""
  states=""
  for row in $(jq -r '.result[] | select(.active_rollout_id != null) | "\(.id)/\(.active_rollout_id)/\(.name)"' <<<"$apps"); do
    IFS=/ read -r app rollout name <<<"$row"
    r=$(api "/applications/$app/rollouts/$rollout" | jq -c .result) || continue
    # Only the rollouts of this deploy's image (matched by its tag, a hash of the runner).
    [[ "$(jq -r '.target_configuration.image // ""' <<<"$r")" == *":${RUNNER_IMAGE##*:}" ]] || continue
    # Steps started out of all steps, from the steps themselves (progress.current_step is 1-based in practice).
    state=$(jq -r '(.steps // []) as $s | "\(.status), step \([$s[] | select(.status != "pending")] | length) of \($s | length) \($s | last | .status // ""), \(.progress.updated_instances // "?")/\(.progress.total_instances // "?") instances updated"' <<<"$r")
    states+="$name: $state; "
    # Done once the rollout ended, or its last step is under way.
    jq -e '(.status | IN("completed", "reverted", "replaced")) or ((.steps // []) | length > 0 and (last | .status | IN("progressing", "completed")))' <<<"$r" >/dev/null || pending+="$name "
  done
  [ "$states" = "$last" ] || { echo "${states:-no container rollout for $RUNNER_IMAGE}"; last=$states; }
  if [ -z "$pending" ]; then
    # This job's container started on the old image before the deploy; it is still running,
    # which shows a rollout leaves running jobs alone (rollout_active_grace_period).
    [ -z "$states" ] || echo "the rollout reached its last step and this job, on an old-image container, is still running"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::warning::the container rollout of ${pending% } has not reached its last step after ${ROLLOUT_WAIT_MINUTES:-10} minutes; new jobs may still start on the old image"
    exit 0
  fi
  sleep 10
done
