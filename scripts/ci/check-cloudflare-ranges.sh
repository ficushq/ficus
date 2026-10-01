#!/usr/bin/env bash
# Compare the Cloudflare edge ranges pinned in scripts/setup/lib.sh
# (CLOUDFLARE_PROXY_RANGES, which the ingress Caddyfiles trust for
# CF-Connecting-IP) with the list Cloudflare publishes. Exits 0 when they
# match; otherwise writes a Markdown summary to $DRIFT_REPORT (if set), sets
# drift=true in $GITHUB_OUTPUT (if set), and exits 1. Used by the
# cloudflare-ranges (PR check) and cloudflare-ranges-watch (schedule) workflows.
set -euo pipefail
cd "$(dirname "$0")/../.."

CLOUDFLARE_PROXY_RANGES=()
eval "$(sed -n '/^CLOUDFLARE_PROXY_RANGES=(/,/^)/p' scripts/setup/lib.sh)"
pinned=$(printf '%s\n' "${CLOUDFLARE_PROXY_RANGES[@]}" | sed '/^$/d' | sort)
[[ -n ${pinned} ]] || { echo "::error::CLOUDFLARE_PROXY_RANGES not found in scripts/setup/lib.sh"; exit 1; }
published=$({ curl -fsS --retry 3 https://www.cloudflare.com/ips-v4; echo
  curl -fsS --retry 3 https://www.cloudflare.com/ips-v6; echo; } | sed '/^$/d' | sort)
[[ -n ${published} ]] || { echo "::error::Cloudflare published no ranges"; exit 1; }
added=$(comm -13 <(echo "${pinned}") <(echo "${published}"))
removed=$(comm -23 <(echo "${pinned}") <(echo "${published}"))
if [[ -z ${added} && -z ${removed} ]]; then
  echo "The pinned list matches Cloudflare's (${#CLOUDFLARE_PROXY_RANGES[@]} ranges)."
  exit 0
fi
report=${DRIFT_REPORT:-/dev/stdout}
{
  # shellcheck disable=SC2016 # Markdown code spans, not shell expansions.
  echo 'Cloudflare'"'"'s published edge ranges no longer match `CLOUDFLARE_PROXY_RANGES` in `scripts/setup/lib.sh`.'
  echo
  echo "Added by Cloudflare (not trusted yet, so visitors behind them are recorded as the edge):"
  echo '```'; echo "${added:-none}"; echo '```'
  echo "Removed by Cloudflare (still trusted; drop them):"
  echo '```'; echo "${removed:-none}"; echo '```'
  echo
  echo "Update the list; a host picks it up when its Caddyfile is next rendered (an upgrade, or a setup re-run)."
} >"${report}"
[[ ${report} == /dev/stdout ]] || cat "${report}"
[[ -z ${GITHUB_OUTPUT:-} ]] || echo "drift=true" >>"${GITHUB_OUTPUT}"
echo "::error::The pinned Cloudflare ranges are out of date"
exit 1
