#!/usr/bin/env bash
# Compatibility wrapper. Prefer: ficus admin workspace-gc [--apply]
set -euo pipefail

args=()
for arg in "$@"; do
  case "$arg" in
    -f|--force) args+=(--apply) ;;
    *) args+=("$arg") ;;
  esac
done

exec ficus admin workspace-gc "${args[@]}"
