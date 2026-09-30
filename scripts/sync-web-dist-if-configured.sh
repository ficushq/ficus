#!/usr/bin/env bash
set -euo pipefail

# Optional local deployment hook for bare-metal/Caddy setups.
# Set WEB_DIST_SYNC_DIR=/var/www/ficus in .env to sync apps/web/dist after build:web.
# Leave unset to make build:web only build the Vite app.

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${WEB_DIST_SYNC_DIR:-}" ]]; then
  exit 0
fi

if [[ ! -d apps/web/dist ]]; then
  echo "WEB_DIST_SYNC_DIR is set but apps/web/dist does not exist. Run web build first." >&2
  exit 1
fi

OWNER="${WEB_DIST_SYNC_OWNER:-}"

sudo mkdir -p "${WEB_DIST_SYNC_DIR}"
sudo rsync -a --delete apps/web/dist/ "${WEB_DIST_SYNC_DIR}/"

if [[ -n "${OWNER}" ]]; then
  sudo chown -R "${OWNER}" "${WEB_DIST_SYNC_DIR}"
fi

echo "Synced web dist to ${WEB_DIST_SYNC_DIR}"
