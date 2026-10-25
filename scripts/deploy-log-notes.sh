#!/usr/bin/env bash
# Reads a Deploy job's log on stdin and prints what the sync repeats on GitHub: the warnings the
# deploy raised, as workflow commands, and its lines about Turnstile and Cloudflare Access. A
# step's log starts with its script, so a line only counts where the runner wrote it (after the
# timestamp), never where the script's text says `echo "::warning::..."`.
set -uo pipefail
log=$(cat)
ts='^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z )?'
sed -nE "s/${ts}(##\[warning\]|::warning[^:]*::)//p" <<<"$log" | head -n 40 | while IFS= read -r w; do
  echo "::warning::Diffinery Deploy: $w"
done
# Site keys are public; the secret key is never printed.
grep -E "${ts}(Turnstile widget|TURNSTILE_SECRET|site key:|/security/report|/auth/access)" <<<"$log" \
  | grep -vE "${ts}(##\[|::)|\\\$|echo " | head -n 10 | sed 's/^/  deploy: /'
exit 0
