#!/usr/bin/env bash
# Waits for every Diffinery Actions run that pushing a commit started (push and
# pull_request runs, and the workflow_run followers they start) and prints each run and
# job. Prints the logs of failed jobs and exits non-zero if any run did not succeed.
# Runs that someone started by hand or on a schedule while that commit was the branch
# head (workflow_dispatch, schedule, repository_dispatch) share its sha but not the push,
# so they are listed as skipped and not waited for.
#
# Usage: DIFFINERY=https://diffinery.com TOKEN=... diffinery-wait-runs.sh owner/repo sha [minutes]
set -euo pipefail
repo=$1 sha=$2 minutes=${3:-60}
# --retry-all-errors also retries a reset connection, which plain --retry gives up on.
api() { curl -fsS --retry 4 --retry-all-errors --retry-delay 3 "$DIFFINERY/api/v3/repos/$repo$1" -H "Authorization: Bearer $TOKEN"; }
unrelated='["workflow_dispatch", "schedule", "repository_dispatch"]'

deadline=$(( $(date +%s) + minutes * 60 ))
settled=0
while :; do
  # One failed poll (the network, a deploy in progress) is not a result: poll again.
  if ! all=$(api "/actions/runs?head_sha=$sha&per_page=100"); then
    echo "::warning::could not list the runs at $(date -u +%T); polling again"
    [ "$(date +%s)" -lt "$deadline" ] || { echo "::error::Diffinery was unreachable at the $minutes minute limit"; exit 1; }
    sleep 15
    continue
  fi
  runs=$(jq --argjson u "$unrelated" '.workflow_runs |= map(select(.event as $e | $u | index($e) | not))' <<<"$all")
  total=$(jq '.workflow_runs | length' <<<"$runs")
  pending=$(jq '[.workflow_runs[] | select(.status != "completed")] | length' <<<"$runs")
  if [ "$total" -gt 0 ] && [ "$pending" = 0 ]; then
    # Finished runs can start followers (workflow_run), so make sure nothing new appears.
    settled=$((settled + 1))
    [ "$settled" -ge 3 ] && break
  else
    settled=0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::Diffinery runs for $sha were not finished after $minutes minutes"
    jq -r '.workflow_runs[] | "  \(.name) [\(.event)]: \(.status)"' <<<"$runs"
    exit 1
  fi
  sleep 15
done

jq -r --argjson u "$unrelated" '.workflow_runs[] | select(.event as $e | $u | index($e)) | "skipped \(.name) [\(.event)]: \(.status)  \(.html_url)"' <<<"$all"
failed=0
for id in $(jq -r '.workflow_runs[].id' <<<"$runs"); do
  run=$(api "/actions/runs/$id")
  jq -r '"\(.name) [\(.event)]: \(.conclusion)\(try " in \((.updated_at | fromdateiso8601) - (.created_at | fromdateiso8601))s" catch "")  \(.html_url)"' <<<"$run"
  jobs=$(api "/actions/runs/$id/jobs")
  # Each job's time and runner image, and its steps that took over 20 seconds, to see where a sync
  # spends it (and whether a job a rollout stopped had started on the previous image).
  jq -r 'def secs: try ((.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601)) catch null;
    .jobs[] | "  \(.name): \(.conclusion)\(if .failure then " - " + (.failure.message // "") else "" end)\(if secs then " (\(secs)s)" else "" end)\(if .runner.image then " on \(.runner.image)" else "" end)",
      (.steps[]? | select((secs // 0) > 20) | "    \(secs)s  \(.name)")' <<<"$jobs"
  # A deploy that went on past a problem says so in warnings (the token missing a permission the
  # bootstrap needs, say): repeat them here, where they can be read without access to Diffinery.
  if [ "$(jq -r .name <<<"$run")" = Deploy ]; then
    for job in $(jq -r '.jobs[] | select(.conclusion != "skipped") | .id' <<<"$jobs"); do
      api "/actions/jobs/$job/logs" 2>/dev/null | "$(dirname "$0")/deploy-log-notes.sh" || true
    done
  fi
  # A skipped run (every job's `if` was false) is fine; a skipped Deploy after a failed CI
  # still fails the sync through CI.
  if ! grep -qxE 'success|skipped' <<<"$(jq -r .conclusion <<<"$run")"; then
    failed=1
    for job in $(jq -r '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | .id' <<<"$jobs"); do
      echo "::group::Last log lines of job $job"
      api "/actions/jobs/$job/logs" | tail -n 120
      echo "::endgroup::"
    done
  fi
done
if [ "$failed" != 0 ]; then
  img=$(curl -fsS --retry 2 "$DIFFINERY/api/v3/meta" | jq -r '.runner_image // "unknown"') || img=unknown
  echo "the last deploy's runner image is $img"
fi
[ "$failed" = 0 ] && echo "every Diffinery run on $sha succeeded"
exit "$failed"
