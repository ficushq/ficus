#!/usr/bin/env bash
# Disposable-CI phase capture only; never installed on machines. The integration
# fixture passes its unchanged150s budget. Synthetic tests use shorter budgets.
set -euo pipefail
if [ "$#" -lt 2 ]; then
  echo 'usage: box-provision-ci-capture.sh DURATION COMMAND [ARGS...]' >&2
  exit 2
fi
duration="$1"
shift
collector="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/box-provision-ci-output.py"
# Fresh mode0700 directory, never an externally supplied/root-written log path.
record_dir="$(mktemp -d "${TMPDIR:-/tmp}/ficus-provision-output.XXXXXX")"
trap 'rm -rf -- "$record_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Capture both streams together, preserving their pipe ordering. Save BOTH
# statuses immediately; neither the collector nor printing may hide a failure.
if timeout --kill-after=5s "$duration" "$@" 2>&1 | python3 "$collector" "$record_dir/output"; then
  statuses=("${PIPESTATUS[@]}")
else
  statuses=("${PIPESTATUS[@]}")
fi
printf 'FICUS_CI_PROVISION_RECORD_BEGIN\n'
if [ -f "$record_dir/output" ]; then
  cat "$record_dir/output"
else
  printf 'FICUS_CI_PROVISION_CAPTURE_MISSING\n'
fi
printf '\nFICUS_CI_PROVISION_EXIT status=%s capture_status=%s\n' "${statuses[0]}" "${statuses[1]}"
printf 'FICUS_CI_PROVISION_RECORD_END\n'
if [ "${statuses[0]}" -ne 0 ]; then exit "${statuses[0]}"; fi
exit "${statuses[1]}"
