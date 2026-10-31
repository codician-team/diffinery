#!/usr/bin/env bash
# Deploy Diffinery to your own Cloudflare account and domain from your own machine: the first
# deploy and every update after it. It runs the same steps as .github/workflows/deploy.yml.
#
#   scripts/setup.sh              # asks for whatever isn't in the environment, then deploys
#   scripts/setup.sh --dry-run    # checks everything and builds the Worker, but changes nothing
#   pnpm setup:cloudflare         # the same as scripts/setup.sh
#
# Settings, from the environment or asked for (in a terminal):
#   CLOUDFLARE_API_TOKEN   API token with the permissions in docs/self-hosting/deploy.md (asked without echo)
#   CLOUDFLARE_ACCOUNT_ID  the Cloudflare account to deploy to
#   DIFFINERY_DOMAIN       your instance's hostname, e.g. git.example.com
#   BOOTSTRAP_ADMINS       comma-separated emails that become site administrators on first sign-in;
#                          empty keeps the list the deployed Worker has (scripts/bootstrap-admins.sh)
# Optional, from the environment only:
#   DIFFINERY_ZONE         the Cloudflare zone holding DIFFINERY_DOMAIN (default: its last two labels)
#   MAIL_DOMAIN            send email from notifications@<MAIL_DOMAIN> (default DIFFINERY_DOMAIN)
#   ACCESS_TEAM_DOMAIN     your Zero Trust team domain, e.g. example.cloudflareaccess.com, when the token can't read it
#   GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID, GITHUB_APP_URL
#                          the GitHub App of GitHub runners (docs/self-hosting/configuration.md#github-runners)
#   ROLLOUT_WAIT_MINUTES   how long to wait for the container rollout (default 10)
#
# Every step is idempotent: it creates only what is missing and keeps your data and secrets, so run
# it again to update. Secrets are never printed. Needs Node.js 22+, pnpm, jq, curl, openssl and Docker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/apps/diffinery"
CF_API="https://api.cloudflare.com/client/v4"
PLACEHOLDER_D1="00000000-0000-0000-0000-000000000000"
DRY_RUN=0
ASK=1

usage() {
  cat <<'EOF'
Usage: scripts/setup.sh [--dry-run] [--yes] [--help]

Deploys Diffinery to your Cloudflare account and domain, or updates a deployment: checks the
tools and your API token, then builds, creates any missing Cloudflare resources (scripts/bootstrap.sh),
deploys the Worker and runner image, sets the Worker's secrets and checks the live site.

  --dry-run   Check the tools, the token and the zone (read-only, when a token is given), build,
              render apps/diffinery/wrangler.deploy.jsonc with a placeholder D1 id and run
              `wrangler deploy --dry-run` on it. Creates, changes and deploys nothing.
  --yes, -y   Don't ask: take every setting from the environment and fail if one is missing.
  --help, -h  Show this help.

Settings (environment variables; asked for in a terminal when missing):
  CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, DIFFINERY_DOMAIN (e.g. git.example.com),
  BOOTSTRAP_ADMINS (comma-separated emails of the first site administrators; empty keeps the
  deployed Worker's list). Optional: DIFFINERY_ZONE, MAIL_DOMAIN, ACCESS_TEAM_DOMAIN.

Docs: apps/diffinery/docs/self-hosting/deploy.md (served at /docs/self-hosting/deploy).
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes | -y) ASK=0 ;;
    --help | -h) usage; exit 0 ;;
    *) echo "unknown option: $arg (see scripts/setup.sh --help)" >&2; exit 2 ;;
  esac
done
[[ -t 0 ]] || ASK=0

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ prerequisites
step "Checking tools"
missing=()
for tool in node pnpm jq curl openssl; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
((${#missing[@]} == 0)) || die "missing: ${missing[*]}. Install Node.js 22+, pnpm 10, jq, curl, openssl and Docker (see the deploy docs)."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
((node_major >= 22)) || die "Node.js 22 or later is needed (this is $(node --version))"
info "node $(node --version), pnpm $(pnpm --version), $(jq --version), curl, openssl"
if ! command -v docker >/dev/null 2>&1; then
  ((DRY_RUN)) || die "docker is missing: the runner container image is built with Docker. Install it and start the daemon."
  warn "docker is missing; a real deploy needs it to build the runner image"
elif ! docker info >/dev/null 2>&1; then
  ((DRY_RUN)) || die "docker is installed but its daemon isn't running (docker info failed). Start it and run this again."
  warn "the Docker daemon isn't running; a real deploy needs it to build the runner image"
else
  info "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '(running)')"
fi

# ------------------------------------------------------------------ settings
# ask VAR "Prompt" [secret]: keeps a value from the environment, else asks (in a terminal).
ask() {
  local var="$1" prompt="$2" secret="${3:-}" value
  value="${!var:-}"
  if [[ -z "$value" && $ASK == 1 ]]; then
    if [[ -n "$secret" ]]; then
      read -rsp "$prompt: " value; echo
    else
      read -rp "$prompt: " value
    fi
  fi
  printf -v "$var" '%s' "$value"
  export "${var?}"
}

step "Settings"
ask CLOUDFLARE_API_TOKEN "Cloudflare API token (input hidden)" secret
ask CLOUDFLARE_ACCOUNT_ID "Cloudflare account ID"
ask DIFFINERY_DOMAIN "Hostname for your instance (e.g. git.example.com)"
if [[ -z "${BOOTSTRAP_ADMINS:-}" && $ASK == 1 ]]; then
  read -rp "Emails of the first site administrators, comma-separated (empty keeps the deployed list): " BOOTSTRAP_ADMINS
fi
export BOOTSTRAP_ADMINS="${BOOTSTRAP_ADMINS:-}"

DIFFINERY_DOMAIN="$(tr '[:upper:]' '[:lower:]' <<<"$DIFFINERY_DOMAIN")"
[[ -n "$DIFFINERY_DOMAIN" ]] || die "set DIFFINERY_DOMAIN to your instance's hostname, for example git.example.com"
[[ "$DIFFINERY_DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "DIFFINERY_DOMAIN must be a bare hostname such as git.example.com, without https:// or a path (got \"$DIFFINERY_DOMAIN\")"
ZONE="${DIFFINERY_ZONE:-$(awk -F. '{print $(NF-1)"."$NF}' <<<"$DIFFINERY_DOMAIN")}"
[[ "$DIFFINERY_DOMAIN" == "$ZONE" || "$DIFFINERY_DOMAIN" == *".$ZONE" ]] || die "DIFFINERY_ZONE ($ZONE) doesn't hold $DIFFINERY_DOMAIN"
MAIL_FROM="notifications@${MAIL_DOMAIN:-$DIFFINERY_DOMAIN}"
if [[ -n "$BOOTSTRAP_ADMINS" ]]; then
  IFS=, read -ra entries <<<"$BOOTSTRAP_ADMINS"
  for e in "${entries[@]}"; do
    e="$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<<"$e")"
    [[ -z "$e" || "$e" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || die "BOOTSTRAP_ADMINS takes comma-separated email addresses; \"$e\" isn't one"
  done
fi
export DIFFINERY_DOMAIN
[[ -z "${DIFFINERY_ZONE:-}" ]] || export DIFFINERY_ZONE
info "hostname:  https://$DIFFINERY_DOMAIN (route $DIFFINERY_DOMAIN/* in zone $ZONE)"
info "email:     $MAIL_FROM"
info "admins:    $(if [[ -n "$BOOTSTRAP_ADMINS" ]]; then tr ',' '\n' <<<"$BOOTSTRAP_ADMINS" | grep -c '[^[:space:]]' | sed 's/$/ address(es) from BOOTSTRAP_ADMINS/'; else echo "keep the deployed Worker's list (none on a new instance)"; fi)"
if ((DRY_RUN)); then info "mode:      dry run (changes nothing)"; else info "mode:      deploy"; fi

# ------------------------------------------------------------------ token and zone
cf_get() { curl -sS --retry 3 --retry-delay 2 "$CF_API$1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"; }
errors_of() { jq -r '[.errors[]? | "\(.code): \(.message)"] | join("; ")' <<<"$1" 2>/dev/null || echo "no answer"; }

if [[ -z "$CLOUDFLARE_API_TOKEN" || -z "$CLOUDFLARE_ACCOUNT_ID" ]]; then
  ((DRY_RUN)) || die "set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (Step 2 of the deploy docs says which permissions the token needs)"
  step "Cloudflare token"
  warn "no CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID: the dry run skips the token and zone checks"
else
  [[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || die "CLOUDFLARE_ACCOUNT_ID should be 32 hex characters (the dashboard's Account ID), not \"$CLOUDFLARE_ACCOUNT_ID\""
  step "Cloudflare token"
  # User tokens verify at /user/tokens/verify, account-owned tokens at /accounts/{id}/tokens/verify.
  verify="$(cf_get /user/tokens/verify || true)"
  if ! jq -e '.success == true and .result.status == "active"' >/dev/null 2>&1 <<<"$verify"; then
    verify="$(cf_get "/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify" || true)"
  fi
  jq -e '.success == true and .result.status == "active"' >/dev/null 2>&1 <<<"$verify" || die "Cloudflare doesn't accept the API token: $(errors_of "$verify")"
  info "the token is valid and active"
  zones="$(cf_get "/zones?name=$ZONE&account.id=$CLOUDFLARE_ACCOUNT_ID" || true)"
  jq -e '.success == true' >/dev/null 2>&1 <<<"$zones" || die "couldn't look up the zone $ZONE: $(errors_of "$zones")"
  zone_status="$(jq -r '.result[0].status // empty' <<<"$zones")"
  [[ -n "$zone_status" ]] || die "the zone $ZONE isn't in account $CLOUDFLARE_ACCOUNT_ID, or the token can't see it. Add the domain to the account, give the token Zone → Zone → Read on it, or set DIFFINERY_ZONE if the zone that holds $DIFFINERY_DOMAIN is another one."
  [[ "$zone_status" == active ]] || warn "the zone $ZONE is $zone_status, not active: the route serves nothing until its nameservers point at Cloudflare"
  info "zone $ZONE is in the account ($zone_status)"
fi

cd "$ROOT"

# ------------------------------------------------------------------ build
step "Installing and building"
pnpm install --frozen-lockfile
pnpm -r --if-present build

if ((DRY_RUN)); then
  # ---------------------------------------------------------------- dry run
  step "Bootstrap administrators"
  # Reads the deployed Worker's list when there are credentials (a read, never a write).
  ADMINS="$("$ROOT/scripts/bootstrap-admins.sh")"

  step "Rendering the deploy config (placeholder D1 id) and bundling the Worker"
  # A placeholder runner image: the dry run builds no container image (that needs Docker and the registry).
  RUNNER_IMAGE="registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID:-00000000000000000000000000000000}/diffinery-runner:dry-run" \
    node "$ROOT/scripts/render-config.mjs" --d1 "$PLACEHOLDER_D1" ${ACCESS_TEAM_DOMAIN:+--team "$ACCESS_TEAM_DOMAIN"} \
    --public-url "https://$DIFFINERY_DOMAIN" ${DIFFINERY_ZONE:+--zone "$DIFFINERY_ZONE"} --mail-from "$MAIL_FROM" --admins "$ADMINS"
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/diffinery-dry-run.XXXXXX")"
  (cd "$APP" && pnpm exec wrangler deploy --dry-run -c wrangler.deploy.jsonc --outdir "$OUT")

  CFG="$(tail -n +2 "$APP/wrangler.deploy.jsonc")"
  step "Dry run summary"
  info "route:            $(jq -r '.routes | map("\(.pattern) (zone \(.zone_name))") | join(", ")' <<<"$CFG")"
  info "PUBLIC_URL:       $(jq -r .vars.PUBLIC_URL <<<"$CFG")"
  info "MAIL_FROM:        $(jq -r .vars.MAIL_FROM <<<"$CFG")"
  info "BOOTSTRAP_ADMINS: $(jq -r '.vars.BOOTSTRAP_ADMINS | split(",") | map(select(length > 0)) | length' <<<"$CFG") address(es)"
  info "bundle:           $OUT"
  if [[ "$DIFFINERY_DOMAIN" != diffinery.com ]] && grep -q 'diffinery\.com' <<<"$CFG"; then
    warn "the rendered config still mentions diffinery.com: $(grep -o '"[^"]*diffinery\.com[^"]*"' <<<"$CFG" | sort -u | tr '\n' ' ')"
  fi
  echo
  echo "Dry run passed: apps/diffinery/wrangler.deploy.jsonc is valid and the Worker bundles. Nothing was"
  echo "created or deployed. Run scripts/setup.sh without --dry-run to deploy to https://$DIFFINERY_DOMAIN."
  exit 0
fi

# ------------------------------------------------------------------ deploy
wrangler() { (cd "$APP" && pnpm exec wrangler "$@"); }
OUTPUTS="$(mktemp "${TMPDIR:-/tmp}/diffinery-setup.XXXXXX")"
trap 'rm -f "$OUTPUTS"' EXIT

step "Runner image (built only when the runner changed)"
image_log="$(mktemp "${TMPDIR:-/tmp}/diffinery-image.XXXXXX")"
env -u GITHUB_ENV "$ROOT/scripts/runner-image.sh" | tee "$image_log"
RUNNER_IMAGE="$(tail -n 1 "$image_log")"
rm -f "$image_log"
[[ "$RUNNER_IMAGE" == registry.cloudflare.com/* ]] || die "scripts/runner-image.sh didn't print the runner image"
export RUNNER_IMAGE

step "Creating or updating Cloudflare resources (scripts/bootstrap.sh)"
GITHUB_OUTPUT="$OUTPUTS" "$ROOT/scripts/bootstrap.sh"
ACCESS_TEAM="$(sed -n 's/^access_team=//p' "$OUTPUTS" | tail -n 1)"

step "Deploying the Worker and runner image"
wrangler deploy -c wrangler.deploy.jsonc

step "Waiting for new containers to get the new image"
"$ROOT/scripts/wait-container-rollout.sh"

step "Worker secrets (generated on the first deploy; never printed)"
"$ROOT/scripts/ensure-secrets.sh"

if [[ -z "$ACCESS_TEAM" ]]; then
  step "Finishing the Access setup (first deploy)"
  : >"$OUTPUTS"
  GITHUB_OUTPUT="$OUTPUTS" "$ROOT/scripts/bootstrap.sh"
  wrangler deploy -c wrangler.deploy.jsonc --containers-rollout none
  ACCESS_TEAM="$(sed -n 's/^access_team=//p' "$OUTPUTS" | tail -n 1)"
fi

# ------------------------------------------------------------------ checks
step "Checking https://$DIFFINERY_DOMAIN"
code=""
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://$DIFFINERY_DOMAIN/healthz" || true)"
  [[ "$code" == 200 ]] && break
  sleep 10
done
[[ "$code" == 200 ]] || die "https://$DIFFINERY_DOMAIN/healthz did not return 200 (last: ${code:-no answer}). Check that the $DIFFINERY_DOMAIN DNS record is proxied (orange cloud); a new certificate can take a few minutes, so run this again."
info "/healthz -> 200"
curl -sS "https://$DIFFINERY_DOMAIN/login" | grep -q "Sign in with a passkey" || die "/login is not the Diffinery sign-in page: check DIFFINERY_DOMAIN, DIFFINERY_ZONE and the route in apps/diffinery/wrangler.deploy.jsonc"
info "/login serves the passkey sign-in page"
loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "https://$DIFFINERY_DOMAIN/auth/access" || true)"
if [[ "$loc" == 302\ https://*.cloudflareaccess.com/* ]]; then
  info "/auth/access is behind Cloudflare Access"
else
  warn "/auth/access is not behind Cloudflare Access yet ($loc), so email recovery and the first admin sign-in won't work. Set ACCESS_TEAM_DOMAIN and run this again."
fi

echo
echo "Diffinery is live at https://$DIFFINERY_DOMAIN."
echo "Sign in as the first administrator at https://$DIFFINERY_DOMAIN/auth/access with an email in BOOTSTRAP_ADMINS,"
echo "then add a passkey. Run scripts/setup.sh again at any time to update."
[[ -n "$ACCESS_TEAM" ]] || warn "the Access team domain is still unknown; set ACCESS_TEAM_DOMAIN (Zero Trust → Settings → Custom pages shows it) and run this again"
