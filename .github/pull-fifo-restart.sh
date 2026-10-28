#!/usr/bin/env bash
# Provision only: never retry startup, migrations, or persistent-volume assertions.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Compose validates interpolation even for pull; no ports or volumes are created.
export FIFO_RESTART_PORT=5432 FIFO_RESTART_VOLUME=ficus-fifo-restart-pull-only
compose=(docker compose -p "ficus-fifo-restart-pull-$$" -f "$root/apps/core/src/db/fixtures/message-enqueue-restart.compose.yml")
"${compose[@]}" config --images

for attempt in 1 2 3; do
  echo "FIFO restart image provisioning: attempt $attempt/3 (120s timeout, 5s kill grace)" >&2
  # Stream ALL output, including the final registry error, rather than embedding
  # pull progress in a test exception. Bound hangs as well as ordinary failures.
  if timeout --kill-after=5s 120s "${compose[@]}" pull postgres; then
    exit 0
  else
    status=$?
  fi
  echo "FIFO restart image pull attempt $attempt/3 failed (exit $status; timeout exits 124 or 137)" >&2
  if (( attempt < 3 )); then
    sleep "$((attempt * 5))"
  fi
done

echo "Image provisioning failed after 3 attempts (exit $status); restart assertions were not run." >&2
exit "$status"
