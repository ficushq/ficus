#!/usr/bin/env bash
# Diagnostic wrapper for the disposable rootless CI fixture, not installed on
# machines. Trace source locations only: xtrace would disclose expanded command
# arguments or environment values. Keep the target's streams and exit status.
set -euo pipefail
if [ "$#" -lt 1 ]; then
  echo 'usage: box-provision-ci-trace.sh SCRIPT [ARGS...]' >&2
  exit 2
fi
trace_target="$1"
shift
set -o functrace
# DEBUG is inherited by shell functions/subshells, not exported into runuser's
# fresh bash processes. No BASH_ENV, caller paths or trap changes reach services.
# shellcheck disable=SC2016
trap 'printf "FICUS_CI_PROVISION_TRACE pid=%s line=%s function=%s\n" "$BASHPID" "$LINENO" "${FUNCNAME[0]:-dispatch}" >&2' DEBUG
# shellcheck source=/dev/null
source "$trace_target" "$@"
