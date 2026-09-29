#!/usr/bin/env bash
# host-layout.test.sh — the host layout section of lib.sh: the layout
# constants, detection, resolution (and the path globals it re-derives), the
# release's declared layout, the completion markers, and the toolkit sites that
# must follow the resolved names.
# Run: sudo bash scripts/setup/host-layout.test.sh   (CI runs it as root; it
# also runs unprivileged). Needs jq and git; the cfg_source_dest cases need
# mikefarah yq v4 and are skipped with a warning without it.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
R=$(mktemp -d)
export FICUS_HOST_ROOT=$R
export FICUS_SYSTEMD_UNIT_DIR=$R/etc/systemd/system
# The framework's backup root lives OUTSIDE $R (the snapshots compare $R only) and NEVER at the real
# /var/backups/ficus-host-migrate: this suite runs as root in CI. The seam is HOST_MIGRATE_BACKUP_ROOT.
HOST_MIGRATE_BACKUP_ROOT=$(mktemp -d)
export HOST_MIGRATE_BACKUP_ROOT
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
[[ $(host_migrate_backup_root) != /var/backups/* ]] || {
  echo 'refusing: the backup root is the real one' >&2
  exit 1
}
PASS=0 FAIL=0
SCRATCH=$(mktemp -d)
trap 'rm -rf "${R}" "${HOST_MIGRATE_BACKUP_ROOT}" "${SCRATCH}"' EXIT
reset_fixture() {
  rm -rf "$R" "$HOST_MIGRATE_BACKUP_ROOT"
  mkdir -p "$R/etc/systemd/system" "$HOST_MIGRATE_BACKUP_ROOT"
}
expect_eq() { if [[ $2 == "$3" ]]; then PASS=$((PASS + 1)); else
  FAIL=$((FAIL + 1))
  log_error "FAIL: $1 — expected '$3', got '$2'"
fi; }
expect_match() { if [[ $2 =~ $3 ]]; then PASS=$((PASS + 1)); else
  FAIL=$((FAIL + 1))
  log_error "FAIL: $1 — '$2' !~ /$3/"
fi; }
UNITS="$R/etc/systemd/system"

# --- detection ---------------------------------------------------------------
reset_fixture
expect_eq 'fresh host' "$(host_layout_detect)" 'fresh'
: >"${UNITS}/${HL_LEGACY_UNIT_PREFIX}-api.service"
expect_eq 'legacy unit → layout 1' "$(host_layout_detect)" '1'
ln -s "${UNITS}/${HL_LEGACY_UNIT_PREFIX}-api.service" "${UNITS}/ficus-api.service"
expect_eq 'a ficus unit that is only a link is not layout 2' "$(host_layout_detect)" '1'
rm -f "${UNITS}/ficus-api.service"
: >"${UNITS}/ficus-api.service"
expect_eq 'ficus unit file → layout 2' "$(host_layout_detect)" '2'
rm -f "${UNITS}/${HL_LEGACY_UNIT_PREFIX}-api.service"
ln -s "${UNITS}/ficus-api.service" "${UNITS}/${HL_LEGACY_UNIT_PREFIX}-api.service"
expect_eq 'layout 2 with the legacy name as its alias link' "$(host_layout_detect)" '2'
reset_fixture
ln -s "${UNITS}/nowhere.service" "${UNITS}/${HL_LEGACY_UNIT_PREFIX}-api.service"
expect_eq 'a dangling legacy link still means layout 1' "$(host_layout_detect)" '1'
reset_fixture
expect_eq 'lib.sh resolved the layout at source time (a fresh host: layout 2 names)' \
  "$(bash -c 'source "$1/lib.sh"; printf %s:%s "${HL_LAYOUT}" "${HL_UNIT_API}"' _ "${SCRIPT_DIR}")" '2:ficus-api'
: >"${UNITS}/${HL_LEGACY_UNIT_PREFIX}-api.service"
expect_eq 'lib.sh resolved the layout at source time (a legacy host: layout 1 names)' \
  "$(bash -c 'source "$1/lib.sh"; printf %s:%s "${HL_LAYOUT}" "${HL_UNIT_API}"' _ "${SCRIPT_DIR}")" "1:${HL_LEGACY_UNIT_PREFIX}-api"

# --- resolution ----------------------------------------------------------------
host_layout_resolve 1
expect_eq 'layout 1 layout' "$HL_LAYOUT" '1'
expect_eq 'layout 1 dest' "$HL_DEST" "$R$HL_LEGACY_DEST"
expect_eq 'layout 1 etc' "$HL_ETC" "$R$HL_LEGACY_ETC"
expect_eq 'layout 1 config' "$HL_CFG" "$R$HL_LEGACY_SETUP_DIR/$HL_LEGACY_SETUP_YAML"
expect_eq 'layout 1 api unit' "$HL_UNIT_API" "${HL_LEGACY_UNIT_PREFIX}-api"
expect_eq 'layout 1 worker unit' "$HL_UNIT_WORKER" "${HL_LEGACY_UNIT_PREFIX}-worker"
expect_eq 'layout 1 backup unit' "$HL_UNIT_BACKUP" "${HL_LEGACY_UNIT_PREFIX}-backup"
expect_eq 'layout 1 backup script' "$HL_BACKUP_SCRIPT" "$R$HL_LEGACY_BACKUP_SCRIPT"
expect_eq 'layout 1 home, db and suffix' "$HL_HOME_NAME:$HL_DB_CONTAINER:$HL_DB_VOLUME:$HL_DB_NAME:$HL_GUARDRAIL_SUFFIX" \
  "$HL_LEGACY_HOME_NAME:$HL_LEGACY_DB_CONTAINER:$HL_LEGACY_DB_VOLUME:$HL_LEGACY_DB_NAME:$HL_LEGACY_GUARDRAIL_SUFFIX"
expect_eq 'layout 1 sudoers' "$HL_SUDOERS" "$R$HL_LEGACY_SUDOERS"
expect_eq 'layout 1 managed.env follows' "$FICUS_MANAGED_ENV_PATH" "$R$HL_LEGACY_ETC/managed.env"
expect_eq 'layout 1 artifacts, CA, backup.env and script follow' \
  "$FICUS_ARTIFACTS_DIR:$FICUS_DB_CA_DIR:$FICUS_DB_CA_PATH:$BACKUP_ENV_TARGET:$BACKUP_SCRIPT_PATH" \
  "$R$HL_LEGACY_ETC/artifacts:$R$HL_LEGACY_ETC:$R$HL_LEGACY_ETC/database-ca.crt:$R$HL_LEGACY_ETC/backup.env:$R$HL_LEGACY_BACKUP_SCRIPT"
host_layout_resolve fresh
expect_eq 'fresh → layout 2' "$HL_LAYOUT" '2'
expect_eq 'fresh → ficus dest' "$HL_DEST" "$R/opt/ficus-core"
expect_eq 'fresh → ficus etc' "$HL_ETC" "$R/etc/ficus"
expect_eq 'fresh → ficus setup dir and config' "$HL_SETUP_DIR:$HL_CFG" "$R/root/ficus-setup:$R/root/ficus-setup/ficus-setup.yaml"
expect_eq 'fresh → backup script' "$HL_BACKUP_SCRIPT" "$R/usr/local/bin/ficus-backup.sh"
expect_eq 'fresh → managed.env re-derived' "$FICUS_MANAGED_ENV_PATH" "$R/etc/ficus/managed.env"
expect_eq 'fresh → artifacts, CA, backup.env and script re-derived' \
  "$FICUS_ARTIFACTS_DIR:$FICUS_DB_CA_PATH:$BACKUP_ENV_TARGET:$BACKUP_SCRIPT_PATH" \
  "$R/etc/ficus/artifacts:$R/etc/ficus/database-ca.crt:$R/etc/ficus/backup.env:$R/usr/local/bin/ficus-backup.sh"
expect_eq 'fresh → units' "$HL_UNIT_API:$HL_UNIT_WORKER:$HL_UNIT_BACKUP" 'ficus-api:ficus-worker:ficus-backup'
expect_eq 'fresh → home, db and suffix' "$HL_HOME_NAME:$HL_DB_CONTAINER:$HL_DB_VOLUME:$HL_DB_NAME:$HL_GUARDRAIL_SUFFIX" \
  '.ficus:ficus-postgres:ficus-pgdata:ficus:z-ficus-memory-guardrail.conf'
expect_eq 'fresh → sudoers' "$HL_SUDOERS" "$R/etc/sudoers.d/ficus-update"
host_layout_resolve 2
expect_eq 'layout 2 = the fresh names' "$HL_LAYOUT:$HL_DEST:$HL_UNIT_API" "2:$R/opt/ficus-core:ficus-api"
expect_match 'an unknown layout dies' "$( (host_layout_resolve 3) 2>&1 || true)" 'unknown host layout'
# a seam set before sourcing keeps precedence over the re-derivation
expect_eq 'seam precedence' "$(FICUS_MANAGED_ENV_PATH=/seam/m.env bash -c 'source "$1/lib.sh"; host_layout_resolve 2; printf %s "$FICUS_MANAGED_ENV_PATH"' _ "$SCRIPT_DIR")" '/seam/m.env'
expect_eq 'seam precedence (every seam, across a resolve to the other layout)' \
  "$(FICUS_DB_CA_DIR=/s/ca FICUS_ARTIFACTS_DIR=/s/art BACKUP_SCRIPT_PATH=/s/b.sh BACKUP_ENV_TARGET=/s/b.env bash -c 'source "$1/lib.sh"; host_layout_resolve 1; printf %s:%s:%s:%s:%s "$FICUS_DB_CA_DIR" "$FICUS_DB_CA_PATH" "$FICUS_ARTIFACTS_DIR" "$BACKUP_SCRIPT_PATH" "$BACKUP_ENV_TARGET"' _ "$SCRIPT_DIR")" \
  '/s/ca:/s/ca/database-ca.crt:/s/art:/s/b.sh:/s/b.env'
expect_eq 'no seam: a re-source re-derives (nothing captured from the first resolve)' \
  "$(bash -c 'source "$1/lib.sh"; host_layout_resolve 1; source "$1/lib.sh"; host_layout_resolve 2; printf %s "$FICUS_MANAGED_ENV_PATH"' _ "$SCRIPT_DIR")" "$R/etc/ficus/managed.env"
expect_eq 'no absolute path escapes FICUS_HOST_ROOT' \
  "$(for v in HL_DEST HL_ETC HL_SETUP_DIR HL_CFG HL_BACKUP_SCRIPT HL_SUDOERS FICUS_DB_CA_DIR FICUS_DB_CA_PATH FICUS_ARTIFACTS_DIR FICUS_MANAGED_ENV_PATH BACKUP_SCRIPT_PATH BACKUP_ENV_TARGET; do
    [[ ${!v} == "$R"/* ]] || printf '%s ' "$v"
  done)" ''

# --- cfg_source_dest: the layout's dest, without FICUS_HOST_ROOT ---------------
if yq_is_mikefarah; then
  printf 'source:\n  mode: artifact\n' >"${SCRATCH}/nodest.yaml"
  cfg_load "${SCRATCH}/nodest.yaml"
  host_layout_resolve 1
  expect_eq 'cfg_source_dest: layout 1 default' "$(cfg_source_dest)" "$HL_LEGACY_DEST"
  host_layout_resolve fresh
  expect_eq 'cfg_source_dest: fresh default' "$(cfg_source_dest)" '/opt/ficus-core'
  printf 'source:\n  dest: /srv/core\n' >"${SCRATCH}/dest.yaml"
  cfg_load "${SCRATCH}/dest.yaml"
  expect_eq 'cfg_source_dest: an explicit dest wins' "$(cfg_source_dest)" '/srv/core'
  CFG_FILE=''
else
  log_warn 'mikefarah yq not on PATH — skipping the cfg_source_dest cases'
fi

# --- the release's declared layout ---------------------------------------------
T=$(mktemp -d "${SCRATCH}/t.XXXXXX")
printf '{"hostLayout":2}\n' >"$T/artifact.json"
expect_eq 'artifact hostLayout' "$(core_release_host_layout "$T")" '2'
printf '{"name":"ficus","ficusHostLayout":2}\n' >"$T/package.json"
printf '{"envPrefix":"FICUS"}\n' >"$T/artifact.json"
expect_eq 'an artifact decides by its artifact.json alone (no hostLayout → 1)' "$(core_release_host_layout "$T")" '1'
T2=$(mktemp -d "${SCRATCH}/t.XXXXXX")
printf '{"name":"ficus","ficusHostLayout":2}\n' >"$T2/package.json"
expect_eq 'git tree ficusHostLayout' "$(core_release_host_layout "$T2")" '2'
T3=$(mktemp -d "${SCRATCH}/t.XXXXXX")
printf '{"name":"ficus"}\n' >"$T3/package.json"
expect_eq 'no field → 1' "$(core_release_host_layout "$T3")" '1'
expect_eq 'no manifest at all → 1' "$(core_release_host_layout "${SCRATCH}/missing")" '1'
printf '{"hostLayout":"two"}\n' >"$T/artifact.json"
expect_eq 'a malformed hostLayout → 1' "$(core_release_host_layout "$T")" '1'
: >"$T3/$HL_LEGACY_RELEASE_MARKER"
expect_eq 'legacy marker accepted' "$(release_is_complete "$T3" && echo y)" 'y'
T4=$(mktemp -d "${SCRATCH}/t.XXXXXX")
: >"$T4/.ficus-release-complete"
expect_eq 'ficus marker accepted' "$(release_is_complete "$T4" && echo y)" 'y'
expect_eq 'no marker → incomplete' "$(release_is_complete "$T2" && echo y || echo n)" 'n'

# git_rev_host_layout: read from a revision before the checkout moves.
G="${SCRATCH}/git"
mkdir -p "$G"
git -C "$G" init -q
printf '{"name":"ficus"}\n' >"$G/package.json"
git -C "$G" add package.json
git -C "$G" -c user.email=t@example.com -c user.name=t commit -qm one
G_ONE=$(git -C "$G" rev-parse HEAD)
printf '{"name":"ficus","ficusHostLayout":2}\n' >"$G/package.json"
git -C "$G" -c user.email=t@example.com -c user.name=t commit -qam two
G_TWO=$(git -C "$G" rev-parse HEAD)
git -C "$G" checkout -q "${G_ONE}"
expect_eq 'git_rev_host_layout: a revision without the field → 1' "$(git_rev_host_layout "$G" "${G_ONE}")" '1'
expect_eq 'git_rev_host_layout: a later revision declaring 2, read before the checkout moves' \
  "$(git_rev_host_layout "$G" "${G_TWO}")" '2'
expect_eq 'git_rev_host_layout: an unknown revision → 1' "$(git_rev_host_layout "$G" deadbeef)" '1'

# --- install_rendered never writes through a symlink (a systemd Alias= link) ----
reset_fixture
: >"${UNITS}/ficus-api.service"
ln -s "${UNITS}/ficus-api.service" "${UNITS}/alias.service"
as_root() {
  if [[ ${1:-} == install ]]; then
    shift
    local args=()
    while (($#)); do
      case "$1" in
        -o | -g) shift 2 ;;
        *)
          args+=("$1")
          shift
          ;;
      esac
    done
    install "${args[@]}"
    return
  fi
  "$@"
}
expect_eq 'install_rendered refuses a symlink dest' \
  "$( (install_rendered 0644 "$(id -u)" "$(id -g)" "${UNITS}/alias.service" printf 'x') >/dev/null 2>&1 && echo wrote || echo refused)" 'refused'
expect_eq '...and the link target is untouched' "$(cat "${UNITS}/ficus-api.service")" ''
expect_eq 'install_rendered still writes a regular dest' \
  "$( (install_rendered 0644 "$(id -u)" "$(id -g)" "${UNITS}/plain.service" printf 'x') >/dev/null 2>&1 && cat "${UNITS}/plain.service")" 'x'

# --- the api memory guardrail follows the layout's unit and suffix ------------
# A lexically later local drop-in forces a managed drop-in named after it,
# which carries the layout's suffix.
reset_fixture
host_layout_resolve fresh
printf '[Service]\n' >"${UNITS}/${HL_UNIT_API}.service"
mkdir -p "${UNITS}/${HL_UNIT_API}.service.d"
printf '[Service]\nMemoryMax=infinity\n' >"${UNITS}/${HL_UNIT_API}.service.d/zz-local.conf"
(ensure_api_memory_guardrail) >/dev/null 2>&1
expect_eq 'guardrail (fresh): a z-ficus managed drop-in on the ficus api unit' \
  "$(cd "${UNITS}/${HL_UNIT_API}.service.d" && find . -name '*memory-guardrail.conf' | sort | tr '\n' ' ')" \
  './zz-local.z-ficus-memory-guardrail.conf '
# A layout-1 host that already carries the managed drop-in under the legacy
# suffix: recognised as the canonical one — kept when effective, repaired in
# place when not; never a second one.
reset_fixture
: >"${UNITS}/${HL_LEGACY_UNIT_PREFIX}-api.service"
host_layout_resolve "$(host_layout_detect)"
expect_eq '(fixture) a layout-1 host' "$HL_LAYOUT:$HL_UNIT_API" "1:${HL_LEGACY_UNIT_PREFIX}-api"
printf '[Service]\n' >"${UNITS}/${HL_UNIT_API}.service"
mkdir -p "${UNITS}/${HL_UNIT_API}.service.d"
printf '[Service]\nMemoryMax=infinity\n' >"${UNITS}/${HL_UNIT_API}.service.d/zz-local.conf"
GR_LEGACY="${UNITS}/${HL_UNIT_API}.service.d/zz-local.${HL_LEGACY_GUARDRAIL_SUFFIX}"
api_memory_guardrail_content >"${GR_LEGACY}"
gr_changed=$( (
  ensure_api_memory_guardrail >/dev/null 2>&1
  printf '%s' "${FICUS_API_MEMORY_GUARDRAIL_CHANGED}"
))
expect_eq 'guardrail (layout 1): an effective legacy-suffix drop-in is kept, no second one' \
  "${gr_changed}:$(find "${UNITS}/${HL_UNIT_API}.service.d" -name '*memory-guardrail.conf' | wc -l | tr -d ' ')" '0:1'
api_memory_guardrail_content | sed 's/^MemoryMax=35%$/MemoryMax=99%/' >"${GR_LEGACY}"
printf '[Service]\nMemoryMax=infinity\n' >"${UNITS}/${HL_UNIT_API}.service.d/aa-early.conf"
(ensure_api_memory_guardrail) >/dev/null 2>&1
expect_eq 'guardrail (layout 1): a mutated legacy-suffix drop-in is repaired in place, no second one' \
  "$(grep -c '^MemoryMax=35%$' "${GR_LEGACY}"):$(find "${UNITS}/${HL_UNIT_API}.service.d" -name '*memory-guardrail.conf' | wc -l | tr -d ' ')" '1:1'
# Ruling 73 (accepted deviation): on layout 1 a NEW managed drop-in carries
# the layout's (legacy) suffix, never the Ficus one — the host-layout
# migration's unit-step inverse renames it back, and a Ficus-suffixed file on
# a layout-1 host would collide with that.
rm -f "${UNITS}/${HL_UNIT_API}.service.d"/*memory-guardrail.conf "${UNITS}/${HL_UNIT_API}.service.d/aa-early.conf"
(ensure_api_memory_guardrail) >/dev/null 2>&1
expect_eq 'guardrail (layout 1): a new managed drop-in gets the legacy suffix' \
  "$(cd "${UNITS}/${HL_UNIT_API}.service.d" && find . -name '*memory-guardrail.conf' | sort | tr '\n' ' ')" \
  "./zz-local.${HL_LEGACY_GUARDRAIL_SUFFIX} "
host_layout_resolve fresh

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
