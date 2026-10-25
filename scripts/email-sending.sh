#!/usr/bin/env bash
# Checks Cloudflare Email Sending for the domain Diffinery sends mail from
# (notifications@diffinery.com): that the domain is onboarded and that every DNS
# record Email Sending asks for (the cf-bounce MX and SPF, DKIM and DMARC) is
# published. It changes nothing. Onboard the domain once in the dashboard:
# Compute > Email Service > Email Sending > Onboard Domain.
#
# Requires: CLOUDFLARE_API_TOKEN (zone permissions Email Sending Read or Edit and
# DNS Read on the domain), jq, curl. Optional: DIFFINERY_DOMAIN, MAIL_DOMAIN.
# Always exits 0, warning about anything missing, so a deploy still goes out.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
DOMAIN="${MAIL_DOMAIN:-${DIFFINERY_DOMAIN:-diffinery.com}}"
CF="https://api.cloudflare.com/client/v4"

cf() { curl -sS "$CF$1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"; }
warn() { echo "::warning::$*" >&2; }
errors() { jq -r '[.errors[]? | "\(.code): \(.message)"] | join("; ")' <<<"$1"; }

echo "::group::Email Sending for $DOMAIN"
trap 'echo "::endgroup::"' EXIT

# The zone that holds the domain (the domain itself or a parent).
ZONE_ID="" ; name="$DOMAIN"
while [[ "$name" == *.* ]]; do
  ZONE_ID="$(cf "/zones?name=$name" | jq -r '.result[0].id // empty')"
  [[ -n "$ZONE_ID" ]] && break
  name="${name#*.}"
done
[[ -n "$ZONE_ID" ]] || { warn "Could not find the Cloudflare zone for $DOMAIN (the token needs Zone Read on it)."; exit 0; }
echo "zone $name ($ZONE_ID)"

# Without Email Sending access on the token, look at the public DNS records onboarding creates instead.
public_check() {
  doh() { curl -sS "https://cloudflare-dns.com/dns-query?name=$1&type=$2" -H 'accept: application/dns-json' | jq -r '.Answer[]?.data' 2>/dev/null; }
  local ok=1
  if doh "cf-bounce.$DOMAIN" MX | grep -q 'mx.cloudflare.net'; then echo "ok       MX cf-bounce.$DOMAIN"; else echo "missing  MX cf-bounce.$DOMAIN"; ok=0; fi
  if doh "cf-bounce.$DOMAIN" TXT | grep -q 'v=spf1'; then echo "ok       TXT cf-bounce.$DOMAIN (SPF)"; else echo "missing  TXT cf-bounce.$DOMAIN (SPF)"; ok=0; fi
  if doh "_dmarc.$DOMAIN" TXT | grep -qi 'v=DMARC1'; then echo "ok       TXT _dmarc.$DOMAIN"; else echo "missing  TXT _dmarc.$DOMAIN"; ok=0; fi
  [[ "$ok" == 1 ]] && echo "$DOMAIN looks onboarded to Email Sending (public DNS)" || warn "$DOMAIN does not look onboarded to Email Sending, so mail may not be delivered. Onboard it under Compute > Email Service > Email Sending in the Cloudflare dashboard."
}

LIST="$(cf "/zones/$ZONE_ID/email/sending/subdomains")"
if ! jq -e '.success' >/dev/null <<<"$LIST"; then
  echo "can't read Email Sending settings with this token ($(errors "$LIST")), checking public DNS instead"
  public_check
  exit 0
fi
TAG="$(jq -r --arg d "$DOMAIN" '.result[]? | select(.name == $d) | .tag' <<<"$LIST" | head -n1)"
if [[ -z "$TAG" ]]; then
  warn "$DOMAIN is not onboarded to Email Sending, so no email will be delivered. Onboard it under Compute > Email Service > Email Sending in the Cloudflare dashboard."
  exit 0
fi
cf "/zones/$ZONE_ID/email/sending/subdomains/$TAG" | jq -c '.result | {name, enabled, dkim_selector, return_path_domain}'

WANT="$(cf "/zones/$ZONE_ID/email/sending/subdomains/$TAG/dns")"
jq -e '.success' >/dev/null <<<"$WANT" || { warn "Could not read the DNS records Email Sending needs ($(errors "$WANT"))."; exit 0; }
norm() { tr -d '"' | tr -s ' ' | sed 's/ *$//'; }
missing=0
while IFS= read -r rec; do
  type="$(jq -r .type <<<"$rec")"; rname="$(jq -r .name <<<"$rec")"
  want="$(jq -r .content <<<"$rec" | norm)"
  have="$(cf "/zones/$ZONE_ID/dns_records?type=$type&name=$rname&per_page=100")"
  if ! jq -e '.success' >/dev/null <<<"$have"; then echo "can't read DNS for $rname ($(errors "$have"))"; continue; fi
  if jq -r '.result[].content' <<<"$have" | norm | grep -qxF -- "$want"; then
    echo "ok       $type $rname"
  elif [[ "$type" == TXT && "$rname" == _dmarc.* ]] && jq -r '.result[].content' <<<"$have" | grep -qi 'v=DMARC1'; then
    echo "ok       TXT $rname (the domain's own DMARC policy)"
  else
    echo "missing  $type $rname"; missing=1
  fi
done < <(jq -c '.result[]?' <<<"$WANT")
[[ "$missing" == 0 ]] && echo "Email Sending is set up for $DOMAIN" || warn "Some Email Sending DNS records for $DOMAIN are missing, so mail may not be delivered. Finish onboarding in the dashboard."
