#!/usr/bin/env bash
# Cloudflare Turnstile for the security report form (and open sign-up, when SIGNUP=open).
# Run by scripts/bootstrap.sh on every deploy, and by scripts/ensure-secrets.sh.
#
#   scripts/turnstile.sh
#     Finds the account's Turnstile widget named "diffinery <DIFFINERY_DOMAIN>", creating it
#     (managed mode, for that hostname) when there is none, and prints its site key: the only
#     thing this prints on stdout. Bootstrap passes it to scripts/render-config.mjs, which deploys
#     it as the TURNSTILE_SITE_KEY var. Prints nothing when the token can't manage Turnstile,
#     or when wrangler.jsonc sets TURNSTILE_SITE_KEY itself (then Turnstile is the operator's).
#   scripts/turnstile.sh secret <site key> [wrangler args...]
#     Stores that widget's secret key as the Worker secret TURNSTILE_SECRET. ensure-secrets.sh
#     does this after the deploy when TURNSTILE_SECRET is missing.
#
# The secret key goes from Cloudflare's API straight to `wrangler secret put`; it is never printed.
#
# Which secret goes with which site key: Worker secrets can't be read back, so the marker is the
# TURNSTILE_SITE_KEY var deployed with it. When the Worker has TURNSTILE_SECRET but its deployed
# site key isn't this widget's (the widget was deleted and created again, or the operator's own
# keys came before), the secret belongs to another widget, and this replaces it before the new
# site key is deployed. If it can't, it prints no site key, so the new key never goes live with the
# old secret; anonymous reports stay refused, and the next deploy tries again.
#
# Cloudflare API (https://developers.cloudflare.com/api/resources/turnstile/subresources/widgets/):
#   List:    GET  /accounts/{account_id}/challenges/widgets?per_page=1000  (items have no secret)
#   Create:  POST /accounts/{account_id}/challenges/widgets  {name, domains, mode}
#            https://developers.cloudflare.com/api/resources/turnstile/subresources/widgets/methods/create/
#   Get:     GET  /accounts/{account_id}/challenges/widgets/{sitekey}  (with .result.secret)
#   Deployed bindings, to compare site keys: GET /accounts/{account_id}/workers/scripts/diffinery/settings
#            https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/
# The token needs Account → Turnstile → Edit ("Turnstile Sites Write" in the API reference;
# https://developers.cloudflare.com/turnstile/get-started/widget-management/api/). Without it this
# warns, naming it, and the deploy goes on: people who aren't signed in can't send security reports
# until someone gives the token that permission or sets the keys by hand (docs/self-hosting/configuration.md).
#
# Requires: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, node, jq, curl. Optional: DIFFINERY_DOMAIN.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
DOMAIN="${DIFFINERY_DOMAIN:-diffinery.com}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/apps/diffinery"
WRANGLER=(pnpm --dir "$APP" exec wrangler)
WORKER=diffinery
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
WIDGET_NAME="diffinery $DOMAIN"
PERMISSION="Account → Turnstile → Edit (\"Turnstile Sites Write\" in the API reference)"

cf() { # cf METHOD PATH [JSON]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" --data "$body"
  else
    curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
  fi
}
say() { echo "$*" >&2; } # stdout carries only the site key
warn() { echo "::warning::$*" >&2; }
# Only the error codes and messages: a widget's response may hold its secret.
api_errors() { jq -r '[.errors[]? | "\(.code): \(.message)"] | join("; ")' <<<"$1" 2>/dev/null || echo "not JSON"; }

# put_secret SITEKEY [wrangler args...]: the widget's secret key, from the API to the Worker secret.
put_secret() {
  local sitekey="$1" res secret
  shift
  res="$(cf GET "/challenges/widgets/$sitekey" || true)"
  secret="$(jq -r '.result.secret // empty' <<<"$res" 2>/dev/null || true)"
  if [[ -z "$secret" ]]; then
    warn "Could not read the secret key of Turnstile widget $sitekey. The token needs $PERMISSION. Cloudflare said: $(api_errors "$res")"
    return 1
  fi
  printf '%s' "$secret" | "${WRANGLER[@]}" secret put TURNSTILE_SECRET "$@" >/dev/null
}

if [[ "${1:-}" == "secret" ]]; then
  [[ -n "${2:-}" ]] || { echo "usage: scripts/turnstile.sh secret <site key> [wrangler args...]" >&2; exit 2; }
  put_secret "${@:2}"
  exit
fi

# Keys set by hand in wrangler.jsonc are the operator's: leave them, and their secret, alone.
OWN="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { pathToFileURL } from "node:url";
  const { parseJsonc } = await import(pathToFileURL(process.argv[1]).href);
  process.stdout.write(parseJsonc(readFileSync(process.argv[2], "utf8")).vars?.TURNSTILE_SITE_KEY ?? "");
' "$ROOT/scripts/jsonc.mjs" "$APP/wrangler.jsonc")"
if [[ -n "$OWN" ]]; then
  say "wrangler.jsonc sets TURNSTILE_SITE_KEY, so the deploy leaves Turnstile and TURNSTILE_SECRET to you"
  exit 0
fi

# The widget, found by name; created only when missing.
LIST="$(cf GET "/challenges/widgets?per_page=1000" || true)"
if ! jq -e '.success' >/dev/null 2>&1 <<<"$LIST"; then
  warn "Could not read the account's Turnstile widgets, so the deploy can't set up Turnstile and only people who are signed in can send security reports. The token needs $PERMISSION. Cloudflare said: $(api_errors "$LIST")"
  exit 0
fi
SITEKEY="$(jq -r --arg n "$WIDGET_NAME" '[.result[]? | select(.name == $n)][0].sitekey // empty' <<<"$LIST")"
if [[ -n "$SITEKEY" ]]; then
  say "Turnstile widget \"$WIDGET_NAME\" exists: $SITEKEY"
  jq -e --arg n "$WIDGET_NAME" --arg d "$DOMAIN" 'any([.result[]? | select(.name == $n)][0].domains[]?; . == $d)' >/dev/null <<<"$LIST" \
    || warn "Turnstile widget \"$WIDGET_NAME\" doesn't list $DOMAIN among its hostnames, so its challenge fails there. Add $DOMAIN to it in the dashboard (Turnstile → the widget → Hostname management)."
else
  BODY="$(jq -nc --arg n "$WIDGET_NAME" --arg d "$DOMAIN" '{name: $n, domains: [$d], mode: "managed"}')"
  RES="$(cf POST /challenges/widgets "$BODY" || true)"
  SITEKEY="$(jq -r 'select(.success) | .result.sitekey // empty' <<<"$RES" 2>/dev/null || true)"
  if [[ -z "$SITEKEY" ]]; then
    warn "Could not create the Turnstile widget \"$WIDGET_NAME\", so only people who are signed in can send security reports. The token needs $PERMISSION. Cloudflare said: $(api_errors "$RES")"
    exit 0
  fi
  say "created Turnstile widget \"$WIDGET_NAME\" (managed, for $DOMAIN): $SITEKEY"
fi

# Does the Worker's TURNSTILE_SECRET belong to this widget? Its deployed TURNSTILE_SITE_KEY says.
SETTINGS="$(cf GET "/workers/scripts/$WORKER/settings" || true)"
if jq -e '.success' >/dev/null 2>&1 <<<"$SETTINGS"; then
  DEPLOYED="$(jq -r '[.result.bindings[]? | select(.type == "plain_text" and .name == "TURNSTILE_SITE_KEY") | .text][0] // empty' <<<"$SETTINGS")"
  if ! jq -e '[.result.bindings[]? | select(.type == "secret_text" and .name == "TURNSTILE_SECRET")] | length > 0' >/dev/null <<<"$SETTINGS"; then
    say "TURNSTILE_SECRET isn't set yet; scripts/ensure-secrets.sh sets it after the deploy"
  elif [[ "$DEPLOYED" != "$SITEKEY" ]]; then
    if put_secret "$SITEKEY" --name "$WORKER"; then
      say "replaced TURNSTILE_SECRET: it went with site key ${DEPLOYED:-(none)}, not $SITEKEY"
    else
      warn "TURNSTILE_SECRET goes with another Turnstile widget and couldn't be replaced, so this deploy leaves TURNSTILE_SITE_KEY unset and only people who are signed in can send security reports. The next deploy tries again."
      exit 0
    fi
  else
    say "TURNSTILE_SECRET goes with site key $SITEKEY"
  fi
elif jq -e 'any(.errors[]?; .code == 10007)' >/dev/null 2>&1 <<<"$SETTINGS"; then
  # 10007: no such Worker yet (the first deploy; wrangler's WORKER_NOT_FOUND_ERR_CODE). ensure-secrets.sh sets TURNSTILE_SECRET after it.
  say "the Worker isn't deployed yet; scripts/ensure-secrets.sh sets TURNSTILE_SECRET after the deploy"
else
  warn "Could not read the $WORKER Worker's settings to check which Turnstile widget TURNSTILE_SECRET goes with, so this deploy leaves TURNSTILE_SITE_KEY unset. The token needs Account → Workers Scripts → Edit. Cloudflare said: $(api_errors "$SETTINGS")"
  exit 0
fi
echo "$SITEKEY"
