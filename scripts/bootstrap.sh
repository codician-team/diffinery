#!/usr/bin/env bash
# Idempotent production setup for Diffinery on a Cloudflare account.
#
# Creates (only when missing): the D1 database, R2 bucket, event and mail queues, the
# subscription that sends Email Sending's bounces and complaints to the diffinery-mail-events
# queue, the Email Sending setup for the domain (scripts/email-sending.sh), the Turnstile
# widget for the security report form (scripts/turnstile.sh) and the
# Cloudflare Access application for /auth/access, the email-based account
# recovery path. Everyday sign-in uses passkeys; git, the API, MCP and runners
# use Diffinery tokens.
# Then renders apps/diffinery/wrangler.deploy.jsonc and applies D1 migrations.
#
# Requires: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, node, jq, curl.
# Optional: DIFFINERY_DOMAIN (default diffinery.com; the Worker's route, PUBLIC_URL
# and sender follow it), DIFFINERY_ZONE (the Cloudflare zone holding that host,
# default its last two labels), MAIL_DOMAIN (default DIFFINERY_DOMAIN),
# ACCESS_TEAM_DOMAIN (e.g. example.cloudflareaccess.com) when the token cannot read it,
# BOOTSTRAP_ADMINS (comma-separated emails that become site administrators on first sign-in;
# when unset, the deployed Worker keeps the list it has: see scripts/bootstrap-admins.sh).
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
DOMAIN="${DIFFINERY_DOMAIN:-diffinery.com}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/apps/diffinery"
WRANGLER=(pnpm --dir "$APP" exec wrangler)
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"

cf() { # cf METHOD PATH [JSON]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" --data "$body"
  else
    curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
  fi
}
log() { echo "::group::$*"; }
endlog() { echo "::endgroup::"; }
warn() { echo "::warning::$*" >&2; }

# ------------------------------------------------------------------ D1
log "D1 database"
D1_ID="$(cf GET "/d1/database?name=diffinery&per_page=100" | jq -r '.result[]? | select(.name=="diffinery") | .uuid' | head -n1)"
if [[ -z "$D1_ID" ]]; then
  D1_ID="$(cf POST /d1/database '{"name":"diffinery"}' | jq -r '.result.uuid // empty')"
  [[ -n "$D1_ID" ]] || { echo "could not create D1 database (does the token have D1: Edit?)" >&2; exit 1; }
  echo "created D1 database $D1_ID"
else
  echo "D1 database exists: $D1_ID"
fi
echo "read replication: $(cf GET "/d1/database/$D1_ID" | jq -r '.result.read_replication.mode // "unknown"') (turn it on with the 'D1 read replication' workflow)"
endlog

# ------------------------------------------------------------------ R2
log "R2 bucket"
if cf GET "/r2/buckets/diffinery-data" | jq -e '.success' >/dev/null; then
  echo "R2 bucket exists"
else
  cf POST /r2/buckets '{"name":"diffinery-data"}' | jq -e '.success' >/dev/null || { echo "could not create R2 bucket (R2 enabled? token has R2: Edit?)" >&2; exit 1; }
  echo "created R2 bucket diffinery-data"
fi
# Lifecycle rules (layout: apps/diffinery/src/lib/storage-keys.ts). Only transient prefixes
# age out; repos/ (git objects, LFS, release assets), registry/ and actions-cache/ (evicted
# by Diffinery) have no age rule. Multipart uploads left unfinished are aborted after a day.
LIFECYCLE='{"rules":[
  {"id":"abort-multipart-1d","enabled":true,"conditions":{"prefix":""},"abortMultipartUploadsTransition":{"condition":{"type":"Age","maxAge":86400}}},
  {"id":"artifacts-90d","enabled":true,"conditions":{"prefix":"artifacts/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":7776000}}},
  {"id":"logs-90d","enabled":true,"conditions":{"prefix":"logs/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":7776000}}},
  {"id":"actions-staging-1d","enabled":true,"conditions":{"prefix":"actions-staging/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":86400}}},
  {"id":"archives-30d","enabled":true,"conditions":{"prefix":"archives/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":2592000}}},
  {"id":"exports-8d","enabled":true,"conditions":{"prefix":"exports/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":691200}}},
  {"id":"events-400d","enabled":true,"conditions":{"prefix":"events/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":34560000}}}
]}'
# Applied on every deploy; a failure stops it, since a wrong rule can delete data.
RESULT="$(cf PUT "/r2/buckets/diffinery-data/lifecycle" "$LIFECYCLE")"
if ! jq -e '.success' >/dev/null <<<"$RESULT"; then
  echo "could not set the R2 lifecycle rules (token has R2: Edit?): $(jq -c '.errors // .' <<<"$RESULT" 2>/dev/null || echo "$RESULT")" >&2
  exit 1
fi
CURRENT="$(cf GET "/r2/buckets/diffinery-data/lifecycle")"
if jq -e '[.result.rules[]? | select(.deleteObjectsTransition != null and ((.conditions.prefix // "") | startswith("repos/") or . == ""))] | length > 0' >/dev/null <<<"$CURRENT"; then
  echo "an R2 lifecycle rule still deletes objects under repos/ (git objects, LFS); refusing to continue" >&2
  exit 1
fi
echo "R2 lifecycle rules set"
endlog

# ------------------------------------------------------------------ Queues
log "Queues"
EXISTING_QUEUES="$(cf GET "/queues?per_page=100" | jq -r '.result[]?.queue_name')"
for q in diffinery-events diffinery-events-dlq diffinery-mail diffinery-mail-dlq diffinery-mail-events; do
  if grep -qx "$q" <<<"$EXISTING_QUEUES"; then
    echo "queue $q exists"
  else
    cf POST /queues "{\"queue_name\":\"$q\"}" | jq -e '.success' >/dev/null || { echo "could not create queue $q (token has Queues: Edit?)" >&2; exit 1; }
    echo "created queue $q"
  fi
done
endlog

# ------------------------------------------------------------------ Email Sending events
# Bounces and complaints reach the Worker through a Queues event subscription: source email.sending
# (one per sending domain), events message.bounced and message.complained, destination the
# diffinery-mail-events queue. Created only when missing; one that lacks an event gets it added.
#   Create:  POST  /accounts/{account_id}/event_subscriptions/subscriptions
#            https://developers.cloudflare.com/api/resources/queues/subresources/subscriptions/methods/create/
#   List:    GET   /accounts/{account_id}/event_subscriptions/subscriptions?queue_id=...
#   Update:  PATCH /accounts/{account_id}/event_subscriptions/subscriptions/{id}
#   Source and event names: https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/
#   and https://developers.cloudflare.com/email-service/platform/event-subscriptions/. The email.sending
#   source takes zone_id and domain, as `wrangler queues subscription create --source email.sending
#   --zone-id ... --domain ...` sends them (https://developers.cloudflare.com/workers/wrangler/commands/queues/).
# The token needs Account → Queues → Edit (the API reference's "Queues Write") for this, and
# Zone → Zone → Read on the sending domain to find its zone. Without them this warns and the deploy
# goes on: bounces and complaints then don't reach the suppression list until someone subscribes the
# queue in the dashboard (docs/admin/site-administration.md).
log "Email Sending event subscription"
SEND_DOMAIN="${MAIL_DOMAIN:-$DOMAIN}"
SUB_EVENTS='["message.bounced","message.complained"]'
SUB_PERMISSION="Account → Queues → Edit (\"Queues Write\" in the API reference)"
api_errors() { jq -r '[.errors[]? | "\(.code): \(.message)"] | join("; ")' <<<"$1" 2>/dev/null || echo "$1"; }
subscribe_mail_events() {
  local qid zone="" name="$SEND_DOMAIN" list existing id body res
  qid="$(cf GET "/queues?per_page=100" | jq -r '.result[]? | select(.queue_name=="diffinery-mail-events") | .queue_id' | head -n1 || true)"
  if [[ -z "$qid" ]]; then warn "Could not find the diffinery-mail-events queue, so it isn't subscribed to Email Sending's bounce and complaint events."; return; fi
  # The zone that holds the sending domain (the domain itself or a parent), as scripts/email-sending.sh finds it.
  while [[ "$name" == *.* ]]; do
    zone="$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=$name" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq -r '.result[0].id // empty' || true)"
    [[ -n "$zone" ]] && break
    name="${name#*.}"
  done
  if [[ -z "$zone" ]]; then warn "Could not find the Cloudflare zone for $SEND_DOMAIN (the token needs Zone → Zone → Read on it), so diffinery-mail-events isn't subscribed to Email Sending's bounce and complaint events. Subscribe it in the dashboard: see Site administration → Email in the docs."; return; fi
  list="$(cf GET "/event_subscriptions/subscriptions?queue_id=$qid&per_page=100" || true)"
  if ! jq -e '.success' >/dev/null 2>&1 <<<"$list"; then
    warn "Could not read the queue's event subscriptions, so diffinery-mail-events may not get bounces and complaints. The token needs $SUB_PERMISSION. Cloudflare said: $(api_errors "$list")"
    return
  fi
  existing="$(jq -c --arg d "$SEND_DOMAIN" --arg q "$qid" '[.result[]? | select(.source.type == "email.sending" and .source.domain == $d and (.destination.queue_id // $q) == $q)][0] // empty' <<<"$list")"
  if [[ -n "$existing" ]]; then
    id="$(jq -r '.id' <<<"$existing")"
    if jq -e --argjson want "$SUB_EVENTS" '.enabled != false and ((.events // []) as $have | all($want[]; . as $e | $have | index($e)))' >/dev/null <<<"$existing"; then
      echo "event subscription $id sends $SEND_DOMAIN's bounces and complaints to diffinery-mail-events"
      return
    fi
    body="$(jq -c --argjson want "$SUB_EVENTS" '{events: ((.events // []) + $want | unique), enabled: true}' <<<"$existing")"
    res="$(cf PATCH "/event_subscriptions/subscriptions/$id" "$body" || true)"
    if jq -e '.success' >/dev/null 2>&1 <<<"$res"; then echo "event subscription $id now includes bounced and complained events"; else warn "Could not update event subscription $id. The token needs $SUB_PERMISSION. Cloudflare said: $(api_errors "$res")"; fi
    return
  fi
  body="$(jq -nc --arg d "$SEND_DOMAIN" --arg z "$zone" --arg q "$qid" --argjson events "$SUB_EVENTS" '{
    name: ("diffinery-mail-events " + $d), enabled: true,
    source: {type: "email.sending", zone_id: $z, domain: $d},
    destination: {type: "queues.queue", queue_id: $q},
    events: $events
  }')"
  res="$(cf POST /event_subscriptions/subscriptions "$body" || true)"
  if jq -e '.success' >/dev/null 2>&1 <<<"$res"; then
    echo "created event subscription $(jq -r '.result.id' <<<"$res"): $SEND_DOMAIN's bounces and complaints go to diffinery-mail-events"
  else
    warn "Could not subscribe diffinery-mail-events to Email Sending's bounce and complaint events for $SEND_DOMAIN. The token needs $SUB_PERMISSION (and $SEND_DOMAIN onboarded to Email Sending). Cloudflare said: $(api_errors "$res")"
  fi
}
subscribe_mail_events
endlog

# ------------------------------------------------------------------ Email Sending
# notifications@<MAIL_DOMAIN or DIFFINERY_DOMAIN>; warns (and email is skipped) until the domain is onboarded.
DIFFINERY_DOMAIN="$DOMAIN" "$ROOT/scripts/email-sending.sh" || warn "Email Sending check failed; email may not be delivered."

# ------------------------------------------------------------------ Turnstile
# The widget "diffinery <DIFFINERY_DOMAIN>", created when missing, so people who aren't signed in can
# send security reports (security.txt points researchers at the form). Its site key is deployed as the
# TURNSTILE_SITE_KEY var (render-config below); ensure-secrets.sh sets TURNSTILE_SECRET when it's missing,
# and turnstile.sh replaces it here, before the deploy, when it goes with another widget. Needs
# Account → Turnstile → Edit; without it turnstile.sh warns, naming it, and the deploy goes on with
# anonymous reports refused. Sign-up stays as SIGNUP says: keys alone don't open it.
log "Turnstile"
TURNSTILE_SITE_KEY="$(DIFFINERY_DOMAIN="$DOMAIN" "$ROOT/scripts/turnstile.sh")" || { warn "scripts/turnstile.sh failed; anonymous security reports stay refused."; TURNSTILE_SITE_KEY=""; }
echo "site key: ${TURNSTILE_SITE_KEY:-none}"
endlog

# ------------------------------------------------------------------ Access
log "Cloudflare Access"
TEAM="${ACCESS_TEAM_DOMAIN:-}"
if [[ -z "$TEAM" ]]; then
  TEAM="$(cf GET /access/organizations | jq -r '.result.auth_domain // empty' || true)"
fi
APPS="$(cf GET "/access/apps?per_page=100" || echo '{}')"
AUD=""
if ! jq -e '.success' >/dev/null <<<"$APPS"; then
  warn "Could not read Access applications (token needs Access: Apps and Policies Edit). Passkeys work; email recovery stays off."
else
  # People sign in with passkeys. Access guards only /auth/access, the email-based
  # recovery path, so everything else (web, git, API, MCP, runners) reaches the Worker directly.
  WEB_BODY="$(jq -nc --arg d "$DOMAIN" '{
    name: "Diffinery account recovery", type: "self_hosted", domain: ($d + "/auth/access"),
    destinations: [{type: "public", uri: ($d + "/auth/access")}],
    session_duration: "15m", app_launcher_visible: false, http_only_cookie_attribute: true, same_site_cookie_attribute: "lax"
  }')"
  POLICY='[{"name": "Anyone who proves their email (Diffinery decides access)", "decision": "allow", "include": [{"everyone": {}}], "precedence": 1}]'
  WEB_ID="$(jq -r '.result[] | select(.name=="Diffinery account recovery" or .name=="Diffinery") | .id' <<<"$APPS" | head -n1)"
  if [[ -z "$WEB_ID" ]]; then
    WEB_APP="$(cf POST /access/apps "$(jq -c --argjson p "$POLICY" '. + {policies: $p}' <<<"$WEB_BODY")" | jq -c '.result // empty')"
    [[ -n "$WEB_APP" ]] && echo "created Access app for $DOMAIN/auth/access" || warn "Could not create the Access application; email recovery stays off."
  else
    WEB_APP="$(cf PUT "/access/apps/$WEB_ID" "$WEB_BODY" | jq -c '.result // empty')"
    [[ -n "$WEB_APP" ]] && echo "Access app covers $DOMAIN/auth/access" || warn "Could not update the Access application."
  fi
  AUD="$(jq -r '.aud // empty' <<<"${WEB_APP:-null}")"

  # Earlier versions put Access in front of the whole site and needed a bypass app; remove it.
  BYPASS_ID="$(jq -r '.result[] | select(.name=="Diffinery machine endpoints") | .id' <<<"$APPS" | head -n1)"
  if [[ -n "$BYPASS_ID" ]]; then
    cf DELETE "/access/apps/$BYPASS_ID" | jq -e '.success' >/dev/null && echo "removed the old Access bypass app" || warn "Could not remove the old Access bypass application."
  fi
fi
if [[ -z "$TEAM" ]]; then
  # Fall back to the sign-in redirect, which names the team domain.
  TEAM="$(curl -sS -o /dev/null -w '%{redirect_url}' "https://$DOMAIN/auth/access" | sed -nE 's#^https://([^/]+\.cloudflareaccess\.com)/.*#\1#p' || true)"
fi
[[ -n "$TEAM" ]] || warn "Access team domain unknown; set the ACCESS_TEAM_DOMAIN repository variable (Zero Trust → Settings → Custom pages shows it)."
echo "team=${TEAM:-?} aud=${AUD:+set}"
endlog

# ------------------------------------------------------------------ Site administrators
# BOOTSTRAP_ADMINS from the environment, else wrangler.jsonc, else what the deployed Worker has; it
# stops the deploy if the Worker's list can't be read, rather than deploy an empty one in its place.
log "Bootstrap administrators"
ADMINS="$("$ROOT/scripts/bootstrap-admins.sh")"
endlog

# ------------------------------------------------------------------ config + migrations
log "Render config and migrate D1"
TURNSTILE_SITE_KEY="$TURNSTILE_SITE_KEY" node "$ROOT/scripts/render-config.mjs" --d1 "$D1_ID" ${TEAM:+--team "$TEAM"} ${AUD:+--aud "$AUD"} --public-url "https://$DOMAIN" ${DIFFINERY_ZONE:+--zone "$DIFFINERY_ZONE"} --mail-from "notifications@${MAIL_DOMAIN:-$DOMAIN}" --admins "$ADMINS"
"${WRANGLER[@]}" d1 migrations apply diffinery --remote -c wrangler.deploy.jsonc
endlog

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  { echo "d1_id=$D1_ID"; echo "access_team=$TEAM"; echo "access_aud_set=${AUD:+true}"; } >>"$GITHUB_OUTPUT"
fi
