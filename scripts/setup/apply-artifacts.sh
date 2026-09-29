#!/usr/bin/env bash
# apply-artifacts.sh — apply a platform-managed artifact staging directory to
# THIS host. The SYNC-path counterpart to setup-host.sh's phase_artifacts.
#
# The control plane copies this script, lib.sh, and a complete artifact staging
# directory to a running managed instance, then runs as root:
#
#     bash apply-artifacts.sh [--config <tau-setup.yaml>] <staging-dir>
#
# With --config (the file the host was set up with; the sync executor passes
# the one the upgrade job already uses), it first reconciles a host migration
# an interrupted upgrade left journaled, and refuses — installing NOTHING — a
# host whose settings predate the Ficus naming (lib.sh's
# require_host_env_ready). The staged managed.env is installed byte for byte.
#
# The staging dir is the FULL current artifact set (not a delta) and this
# script RECONCILES the host against it: managed.env is installed whole,
# every manifest-listed file is installed, and anything under
# /etc/tau/artifacts/ the manifest no longer lists is PRUNED (lib.sh's
# prune_artifacts — that is how an artifact DELETED from the platform registry
# leaves the fleet). It also ensures the core units actually load managed.env
# (ensure_managed_env_dropins — hosts provisioned before the unit templates
# carried the EnvironmentFile line need a drop-in, or every sync is a silent
# no-op for the running processes). Same lib.sh functions a fresh provision
# uses, so a synced host and a freshly-provisioned host end up identical.
#
# It deliberately does NOT restart any service or daemon-reload: the executor
# owns those decisions, driven by the three marker lines this script prints as
# its LAST output (`systemctl restart` only when the managed environment
# actually changed, or when the API guardrail was repaired — file-kind artifacts are read per-use, e.g. APNs certs,
# so installing one never needs a restart; `systemctl daemon-reload` only
# when a drop-in was written). Credential contents are never echoed here.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

CONFIG='' STAGE_DIR=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      CONFIG=${2:?--config needs a value}
      shift 2
      ;;
    -*) die "usage: apply-artifacts.sh [--config <tau-setup.yaml>] <staging-dir>" ;;
    *)
      [[ -z ${STAGE_DIR} ]] || die "usage: apply-artifacts.sh [--config <tau-setup.yaml>] <staging-dir>"
      STAGE_DIR=$1
      shift
      ;;
  esac
done
[[ -n ${STAGE_DIR} ]] || die "usage: apply-artifacts.sh [--config <tau-setup.yaml>] <staging-dir>"
[[ -d ${STAGE_DIR} ]] || die "apply-artifacts.sh: staging directory not found: ${STAGE_DIR}"

if [[ -n ${CONFIG} ]]; then
  [[ -f ${CONFIG} ]] || die "config file '${CONFIG}' not found"
  ensure_yq
  cfg_load "${CONFIG}"
  SRC_DEST=$(cfg_source_dest) || die "could not read source.dest from ${CONFIG}"
  # Caller globals the reconcile's restore needs to re-render units — which
  # it never does here: this script ships without the unit templates, so a
  # set that needs them stays journaled (reconcile returns 3).
  # shellcheck disable=SC2034 # read by lib.sh's render_core_unit
  RUN_USER=$(cfg_get '.core.run_user' "$(id -un)")
  # shellcheck disable=SC2034
  DB_MODE=$(cfg_get '.database.mode' 'container')
  # shellcheck disable=SC2034
  BUN_BIN=/usr/local/bin/bun
  # One toolkit run at a time may migrate, restore or reconcile this host.
  host_migrate_lock
  reconcile_rc=0
  host_migrate_reconcile || reconcile_rc=$?
  [[ ${reconcile_rc} -eq 0 ]] ||
    die "not applying artifacts: a journaled host migration could not be reconciled (${reconcile_rc}) — run the tenant upgrade"
  [[ ! -e $(host_migrate_backup_root)/PENDING ]] ||
    die "not applying artifacts: a host migration is still journaled in $(host_migrate_backup_root)/PENDING — run the tenant upgrade"
  require_host_env_ready
fi

# Detect BEFORE installing (the install overwrites the file being compared).
ENV_CHANGED=$(managed_env_would_change "${STAGE_DIR}")

install_managed_env "${STAGE_DIR}"
install_artifacts "${STAGE_DIR}"
prune_artifacts "${STAGE_DIR}"
ensure_managed_env_dropins
ensure_api_memory_guardrail
log_info "artifacts applied from ${STAGE_DIR}"

# Machine-readable markers for the sync executor (stdout; logs go to stderr).
# On exit 0 these three lines are ALWAYS present — the executor keys its
# daemon-reload/restart decisions off them.
echo "FICUS_MANAGED_ENV_CHANGED=${ENV_CHANGED}"
echo "FICUS_MANAGED_ENV_DROPIN_CHANGED=${MANAGED_ENV_DROPIN_CHANGED}"
echo "FICUS_API_MEMORY_GUARDRAIL_CHANGED=${FICUS_API_MEMORY_GUARDRAIL_CHANGED}"
