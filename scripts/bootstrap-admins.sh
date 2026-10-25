#!/usr/bin/env bash
# Prints the BOOTSTRAP_ADMINS list this deploy gives the Worker (the only thing it prints on stdout).
# Run by scripts/bootstrap.sh, which passes it to scripts/render-config.mjs as --admins.
#
# The emails in the list become site administrators when their account is created, or when an
# account still waiting for an invite signs in through /auth/access (src/lib/directory.ts). Admin
# status is then kept in D1, so the list only matters for accounts that don't exist yet.
#
# Where the list comes from, first match wins:
#   1. BOOTSTRAP_ADMINS in the environment, when it isn't empty (scripts/setup.sh asks for it).
#   2. BOOTSTRAP_ADMINS under vars in apps/diffinery/wrangler.jsonc, when it isn't empty (a copy
#      that keeps its list in the file). The repository leaves it empty.
#   3. The list the deployed Worker has now, read from its plain-text vars:
#        GET /accounts/{account_id}/workers/scripts/diffinery/settings
#        https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/
#      so a deploy that doesn't set it (the Deploy workflow, a re-run of setup.sh) keeps the admins it had.
#   4. None: a brand-new instance without a list. It warns loudly: nobody becomes a site
#      administrator until a deploy sets the list.
# If the Worker's settings can't be read (other than "no such Worker"), it stops instead of
# deploying an empty list in place of the one the Worker has. The emails are never printed to
# the log, only how many there are and where they came from.
#
# Requires: node; and CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, curl and jq for step 3.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER=diffinery
say() { echo "$*" >&2; } # stdout carries only the list
warn() { echo "::warning::$*" >&2; }
count() { tr ',' '\n' <<<"$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -c . || true; }
emit() { # emit LIST SOURCE
  say "BOOTSTRAP_ADMINS: $(count "$1") address(es), from $2"
  printf '%s\n' "$1"
  exit 0
}
none() {
  warn "BOOTSTRAP_ADMINS is empty: $1, so nobody becomes a site administrator on first sign-in. Set BOOTSTRAP_ADMINS (comma-separated emails) and deploy again, for example: BOOTSTRAP_ADMINS=you@example.com scripts/setup.sh"
  printf '\n'
  exit 0
}
trimmed() { sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<<"$1"; }

# 1. The environment.
FROM_ENV="$(trimmed "${BOOTSTRAP_ADMINS:-}")"
[[ -z "$FROM_ENV" ]] || emit "$FROM_ENV" "the BOOTSTRAP_ADMINS environment variable"

# 2. wrangler.jsonc.
FROM_FILE="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { pathToFileURL } from "node:url";
  const { parseJsonc } = await import(pathToFileURL(process.argv[1]).href);
  const cfg = parseJsonc(readFileSync(process.argv[2], "utf8"));
  process.stdout.write(String(cfg.vars?.BOOTSTRAP_ADMINS ?? ""));
' "$ROOT/scripts/jsonc.mjs" "$ROOT/apps/diffinery/wrangler.jsonc")"
FROM_FILE="$(trimmed "$FROM_FILE")"
[[ -z "$FROM_FILE" ]] || emit "$FROM_FILE" "apps/diffinery/wrangler.jsonc"

# 3. The deployed Worker.
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  none "it isn't in the environment or wrangler.jsonc, and without CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID the deployed Worker's list can't be read"
fi
SETTINGS="$(curl -sS --retry 4 --retry-all-errors --retry-delay 3 "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER/settings" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" || true)"
if jq -e '.success == true' >/dev/null 2>&1 <<<"$SETTINGS"; then
  LIVE="$(jq -r '[.result.bindings[]? | select(.type == "plain_text" and .name == "BOOTSTRAP_ADMINS") | .text][0] // empty' <<<"$SETTINGS")"
  LIVE="$(trimmed "$LIVE")"
  [[ -z "$LIVE" ]] || emit "$LIVE" "the deployed $WORKER Worker (kept as it is)"
  none "it isn't in the environment, wrangler.jsonc or the deployed $WORKER Worker"
fi
if jq -e 'any(.errors[]?; .code == 10007)' >/dev/null 2>&1 <<<"$SETTINGS"; then
  # 10007: no such Worker yet (the first deploy; wrangler's WORKER_NOT_FOUND_ERR_CODE).
  none "it isn't in the environment or wrangler.jsonc, and the $WORKER Worker isn't deployed yet"
fi
ERRORS="$(jq -r '[.errors[]? | "\(.code): \(.message)"] | join("; ")' <<<"$SETTINGS" 2>/dev/null || true)"
echo "::error::Could not read the $WORKER Worker's settings to keep its BOOTSTRAP_ADMINS, so the deploy stops rather than replace the list with an empty one. The token needs Account → Workers Scripts → Edit. Or set BOOTSTRAP_ADMINS for this deploy. Cloudflare said: ${ERRORS:-no answer}" >&2
exit 1
