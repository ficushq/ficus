#!/usr/bin/env bash
# enable-pooler.sh — turn the per-host transaction pooler on (or off) for the
# Ficus instance ON THIS HOST, without re-running the whole setup.
#
#   enable-pooler.sh --config ficus-setup.yaml [--size N] [--reserve N]
#   enable-pooler.sh --config ficus-setup.yaml --disable
#
# Enable: records database.pool.{enabled,size,reserve} in the config, installs
# PgBouncer (lib.sh's install_pooler: apt, ini + userlist, the
# <prefix>-pgbouncer unit, listening on 127.0.0.1:6432), rewrites .env to the
# pooled layout (DATABASE_URL → loopback, DATABASE_DIRECT_URL = the cluster,
# DATABASE_POOL_MODE=transaction), re-renders the api/worker units so they
# order After= the pooler, and restarts them with the same health wait the
# setup and upgrade use. Disable reverses every step and stops the unit.
#
# The direct DSN is read from the existing .env — nothing secret arrives on
# the command line or stdin, and the hosted platform's enable_pooling job
# ships this script plus lib.sh and the systemd templates, exactly like the
# upgrade job ships upgrade-host.sh. Idempotent: re-running either way is safe.
# Prints `FICUS_POOLER=enabled|disabled` as its last line.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

usage() {
  cat <<'EOF'
Usage: enable-pooler.sh --config ficus-setup.yaml [--size N] [--reserve N] [--disable]
Options:
  --config FILE   the config this host was set up with (database.mode must be external)
  --size N        PgBouncer server pool size (default 4, or the config's database.pool.size)
  --reserve N     reserve pool size (default 2, or the config's database.pool.reserve)
  --disable       turn pooling off: direct DATABASE_URL again, pooler unit stopped
EOF
}

CONFIG='' SIZE='' RESERVE='' DISABLE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG=${2:?--config needs a value}; shift 2 ;;
    --size) SIZE=${2:?--size needs a value}; shift 2 ;;
    --reserve) RESERVE=${2:?--reserve needs a value}; shift 2 ;;
    --disable) DISABLE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
[[ -n ${CONFIG} ]] || die '--config is required'
[[ -f ${CONFIG} ]] || die "config not found: ${CONFIG}"

ensure_yq
cfg_load "${CONFIG}"
DB_MODE=$(cfg_get '.database.mode' 'container')
[[ ${DB_MODE} == external ]] || die "database.mode is '${DB_MODE}' — the pooler fronts an external database only"
SIZE=${SIZE:-$(cfg_get '.database.pool.size' 4)}
RESERVE=${RESERVE:-$(cfg_get '.database.pool.reserve' 2)}
[[ ${SIZE} =~ ^[1-9][0-9]*$ ]] || die "--size must be a positive integer (got '${SIZE}')"
[[ ${RESERVE} =~ ^[0-9]+$ ]] || die "--reserve must be a non-negative integer (got '${RESERVE}')"
CORE_PORT=$(cfg_get '.core.port' '3000')
[[ ${CORE_PORT} =~ ^[0-9]+$ ]] || die "config: core.port must be a number"
# shellcheck disable=SC2034 # read by lib.sh's render_core_unit / install_pooler
RUN_USER=$(cfg_get '.core.run_user' "$(id -un)")
# shellcheck disable=SC2034 # read by lib.sh's render_core_unit
BUN_BIN=/usr/local/bin/bun
SRC_DEST=$(cfg_source_dest)
require_host_layout_ready
require_host_env_ready
ENV_FILE="${SRC_DEST}/.env"
[[ -f ${ENV_FILE} ]] || die "no rendered .env at ${ENV_FILE}"
[[ -f ${FICUS_DB_CA_PATH} ]] || die "database CA not installed at ${FICUS_DB_CA_PATH}"

if [[ ${DISABLE} -eq 0 ]]; then
  log_step "enable pooler 1/4: record database.pool in ${CONFIG}"
  as_root yq -i ".database.pool.enabled = true | .database.pool.size = ${SIZE} | .database.pool.reserve = ${RESERVE}" "${CONFIG}"
  # shellcheck disable=SC2034 # read by lib.sh's core_unit_db_after when the units re-render
  POOL_ENABLED=true
  log_step "enable pooler 2/4: install ${HL_UNIT_POOLER} (pool ${SIZE} + reserve ${RESERVE})"
  install_pooler "$(envfile_direct_dsn "${ENV_FILE}")" "${SIZE}" "${RESERVE}" "${SCRIPT_DIR}/systemd"
  log_step "enable pooler 3/4: rewrite ${ENV_FILE} to the pooled layout"
  pooler_env_enable "${ENV_FILE}" "${FICUS_PGBOUNCER_PORT}"
  outcome=enabled
else
  log_step "disable pooler 1/4: record database.pool.enabled=false in ${CONFIG}"
  as_root yq -i '.database.pool.enabled = false' "${CONFIG}"
  # shellcheck disable=SC2034 # read by lib.sh's core_unit_db_after when the units re-render
  POOL_ENABLED=false
  log_step "disable pooler 2/4: ${ENV_FILE} back to the direct DSN"
  pooler_env_disable "${ENV_FILE}"
  log_step "disable pooler 3/4: stop ${HL_UNIT_POOLER}"
  as_root systemctl disable --now "${HL_UNIT_POOLER}" >/dev/null 2>&1 || true
  outcome=disabled
fi

log_step "pooler 4/4: re-render ${HL_UNIT_API}/${HL_UNIT_WORKER} and restart"
install_core_units "${SCRIPT_DIR}/systemd"
as_root systemctl daemon-reload
restart_core_services "${CORE_PORT}"
log_info "pooler ${outcome}"
printf 'FICUS_POOLER=%s\n' "${outcome}"
