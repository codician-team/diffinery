#!/usr/bin/env bash
# Generate the Worker's own secrets once (never rotated automatically):
#   MASTER_KEY        root key for encrypting Actions secrets (rotated by hand, with
#                     MASTER_KEY_PREV, which this script never touches; see
#                     apps/diffinery/docs/self-hosting/configuration.md, "Rotating MASTER_KEY")
#   OIDC_PRIVATE_KEY  ES256 key that signs workflow OIDC id tokens
# and, when missing, sets TURNSTILE_SECRET from the Turnstile widget whose site key was deployed
# (scripts/turnstile.sh, through bootstrap and render-config).
# Values are created on the runner (or read from Cloudflare's API) and sent straight to Cloudflare;
# they are never printed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/apps/diffinery"
WRANGLER=(pnpm --dir "$APP" exec wrangler)

# Fail closed: if listing fails we must not mistake "unknown" for "missing" and
# overwrite MASTER_KEY, which would make every stored Actions secret unreadable.
LIST="$("${WRANGLER[@]}" secret list -c wrangler.deploy.jsonc --format json)"
EXISTING="$(jq -er '.[].name' <<<"$LIST" || true)"
jq -e 'type == "array"' >/dev/null <<<"$LIST" || { echo "unexpected output from wrangler secret list" >&2; exit 1; }

if ! grep -qx MASTER_KEY <<<"$EXISTING"; then
  openssl rand -base64 32 | tr -d '\n' | "${WRANGLER[@]}" secret put MASTER_KEY -c wrangler.deploy.jsonc >/dev/null
  echo "set MASTER_KEY"
fi
if ! grep -qx OIDC_PRIVATE_KEY <<<"$EXISTING"; then
  node --input-type=module -e '
    const { subtle } = globalThis.crypto;
    const k = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await subtle.exportKey("jwk", k.privateKey);
    jwk.kid = "diffinery-" + new Date().toISOString().slice(0, 10);
    process.stdout.write(JSON.stringify(jwk));
  ' | "${WRANGLER[@]}" secret put OIDC_PRIVATE_KEY -c wrangler.deploy.jsonc >/dev/null
  echo "set OIDC_PRIVATE_KEY"
fi
# Without the Turnstile permission this warns (scripts/turnstile.sh names it) and the deploy goes on:
# people who aren't signed in can't send security reports until it's set.
SITE_KEY="$(tail -n +2 "$APP/wrangler.deploy.jsonc" | jq -r '.vars.TURNSTILE_SITE_KEY // empty')"
if [[ -n "$SITE_KEY" ]] && ! grep -qx TURNSTILE_SECRET <<<"$EXISTING"; then
  if "$ROOT/scripts/turnstile.sh" secret "$SITE_KEY" -c wrangler.deploy.jsonc; then
    echo "set TURNSTILE_SECRET"
  else
    echo "::warning::TURNSTILE_SECRET is not set, so only people who are signed in can send security reports. The next deploy tries again." >&2
  fi
fi
