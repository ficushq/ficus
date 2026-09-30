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

# =============================================================================
# The host_layout migration (P5-T7): a whole layout-1 host under $R, moved by
# the real framework (host_migrate creates the set, then runs apply), with
# systemctl, docker, bun, visudo and getent as PATH stubs that append their
# argv to $R/calls.log. Old names only through HL_LEGACY_*.
hl_skip=''
[[ $(uname -s) == Linux ]] || hl_skip='not Linux (GNU find/stat/mv -T)'
[[ -n ${hl_skip} ]] || yq_is_mikefarah || hl_skip='mikefarah yq is not on PATH'
# The section sets the caller globals lib.sh reads (SRC_DEST, RUN_USER, ...).
# shellcheck disable=SC2034
# --- the unit and backup templates carry the layout as tokens --------------------
# A layout-1 host rendering from the Ficus-named templates gets the unit it
# always had; layout 2 (and a fresh host) the Ficus names plus the legacy
# Alias= while the bridge lasts. No @TOKEN@ survives on either layout.
tmpl_render() { # LAYOUT FUNCTION ARGS... — in a subshell, the caller's globals of an entrypoint
  (
    host_layout_resolve "$1"
    shift
    SRC_DEST="$R/dest" RUN_USER=root BUN_BIN=/usr/local/bin/bun DB_MODE=external CORE_LAYOUT=artifact
    "$@"
  )
}
for hl_l in 1 2 fresh; do
  if [[ ${hl_l} == 1 ]]; then
    want_etc=${HL_LEGACY_ETC} want_prefix=${HL_LEGACY_UNIT_PREFIX} want_alias='' want_db=${HL_LEGACY_DB_NAME}
  else
    want_etc=/etc/ficus want_prefix=ficus want_alias="Alias=${HL_LEGACY_UNIT_PREFIX}-" want_db=ficus
  fi
  for hl_u in api worker; do
    hl_unit=$(tmpl_render "${hl_l}" render_core_unit "$SCRIPT_DIR/systemd/ficus-${hl_u}.service.tmpl")
    expect_eq "templates (layout ${hl_l}, ${hl_u}): managed.env from the layout's etc dir" \
      "$(grep -Fxc "EnvironmentFile=-${want_etc}/managed.env" <<<"${hl_unit}")" '1'
    expect_eq "templates (layout ${hl_l}, ${hl_u}): the Alias= line" \
      "$(grep '^Alias=' <<<"${hl_unit}" || true)" "${want_alias:+${want_alias}${hl_u}.service}"
    expect_eq "templates (layout ${hl_l}, ${hl_u}): its comments name the layout's unit" \
      "$(grep -c "journalctl -u ${want_prefix}-${hl_u} " <<<"${hl_unit}")" "$([[ ${hl_u} == api ]] && echo 2 || echo 1)"
    expect_eq "templates (layout ${hl_l}, ${hl_u}): no @TOKEN@ left, and on layout 2 no legacy etc path" \
      "$(grep -c '@[A-Z_]*@' <<<"${hl_unit}" || true):$(if [[ ${hl_l} == 1 ]]; then echo 0; else grep -c "${HL_LEGACY_ETC}/" <<<"${hl_unit}" || true; fi)" '0:0'
    rm -f "$SCRATCH/unit.out"
    expect_eq "templates (layout ${hl_l}, ${hl_u}): install_rendered --check-placeholders accepts it" \
      "$( (tmpl_render "${hl_l}" install_rendered --check-placeholders 0644 "$(id -u)" "$(id -g)" "$SCRATCH/unit.out" \
        render_core_unit "$SCRIPT_DIR/systemd/ficus-${hl_u}.service.tmpl") >/dev/null 2>&1 && echo ok)" 'ok'
  done
  for hl_k in service timer; do
    hl_unit=$(tmpl_render "${hl_l}" render_backup_unit_content "$SCRIPT_DIR/systemd/ficus-backup.${hl_k}.tmpl" /usr/local/bin/x.sh '*-*-* 03:15:00' external)
    expect_eq "templates (layout ${hl_l}, backup .${hl_k}): the layout's unit name, its Alias=, no @TOKEN@" \
      "$(grep -c "${want_prefix}-backup" <<<"${hl_unit}"):$(grep '^Alias=' <<<"${hl_unit}" || true):$(grep -c '@[A-Z_]*@' <<<"${hl_unit}" || true)" \
      "2:${want_alias:+${want_alias}backup.${hl_k}}:0"
  done
  hl_unit=$(tmpl_render "${hl_l}" render_backup_script_content "$SCRIPT_DIR/ficus-backup.sh.tmpl" /d /h container c e r b p /b.env)
  expect_eq "templates (layout ${hl_l}, backup script): the container dump names the layout's database, no @TOKEN@" \
    "$(grep -c "pg_dump -U postgres -Fc ${want_db} " <<<"${hl_unit}"):$(grep -c '@[A-Z_]*@' <<<"${hl_unit}" || true)" '1:0'
done
expect_eq 'templates: the backup service [Install] holds only the Alias= (so `enable` creates just the alias)' \
  "$(tmpl_render 2 render_backup_unit_content "$SCRIPT_DIR/systemd/ficus-backup.service.tmpl" /x '*-*-* 03:15:00' external | sed -n '/^\[Install\]/,$p' | tr '\n' '|')" \
  "[Install]|Alias=${HL_LEGACY_UNIT_PREFIX}-backup.service|"
expect_eq 'templates: a layout-1 backup service has no [Install] section at all (the unit it always had)' \
  "$(tmpl_render 1 render_backup_unit_content "$SCRIPT_DIR/systemd/ficus-backup.service.tmpl" /x '*-*-* 03:15:00' external | grep -c '^\[Install\]' || true):$(tmpl_render 1 render_backup_unit_content "$SCRIPT_DIR/systemd/ficus-backup.service.tmpl" /x '*-*-* 03:15:00' external | tail -n 1)" \
  '0:StandardError=journal'

# --- _hl_unmove refuses when both sides are real (never a silent no-op) ---------
um=$(mktemp -d)
mkdir -p "$um/from" "$um/to"
: >"$um/from/a" && : >"$um/to/b"
expect_match '_hl_unmove: FROM and TO both real → refused, loudly, both left' \
  "$( (_hl_unmove "$um/from" "$um/to") 2>&1; echo "rc=$?"):$(ls "$um/from" "$um/to" | tr '\n' ' ')" \
  'both .*from and .*to exist .*leaving both for an operator.*rc=1:.*a .*b'
rm -rf "$um"
(
  HL_BRIDGE_ALIASES=0
  expect_eq 'templates: with the bridge off (finalize), layout 2 carries no Alias=' \
    "$(tmpl_render 2 render_core_unit "$SCRIPT_DIR/systemd/ficus-api.service.tmpl" | grep -c '^Alias=' || true)" '0'
  printf '%s %s\n' "${PASS}" "${FAIL}" >"$SCRATCH/sub.counts"
)
read -r PASS FAIL <"$SCRATCH/sub.counts"

# --- home_dir_default: where Core's data is, the same rule as apps/core's resolveHomeDir ---
hd=$(mktemp -d)
hd_new="$hd/$HL_NEW_HOME_NAME" hd_old="$hd/$HL_LEGACY_HOME_NAME"
expect_eq 'home_dir_default: no data anywhere (a fresh host) → the Ficus dir' "$(home_dir_default "$hd")" "$hd_new"
mkdir -p "$hd_old/sessions"
expect_eq 'home_dir_default: data only in the legacy dir → the legacy dir' "$(home_dir_default "$hd")" "$hd_old"
mkdir -p "$hd_new"
expect_eq 'home_dir_default: legacy data plus a stray, empty Ficus dir → still the legacy dir' "$(home_dir_default "$hd")" "$hd_old"
rm -rf "$hd_old" "$hd_new"
mkdir -p "$hd_new/sessions" "$hd_old/cli"
expect_eq 'home_dir_default: Ficus data plus a CLI-only legacy dir → still the Ficus dir' "$(home_dir_default "$hd")" "$hd_new"
rm -rf "$hd_old"
ln -s "$hd_new" "$hd_old"
expect_eq 'home_dir_default: the legacy dir a link to the Ficus one (migrated) → the Ficus dir' "$(home_dir_default "$hd")" "$hd_new"
rm -f "$hd_old"
mkdir -p "$hd_old/sessions"
expect_match 'home_dir_default: both hold data → the Ficus dir, with a warning' "$(home_dir_default "$hd" 2>&1)" "both .* hold Core data.*$hd_new"
rm -rf "$hd"

# --- the DSN's CA path, and the compat link a fresh layout-2 host gets for it ---
hl_legacy_dsn="postgresql://t:p@db.example:25060/x?sslmode=verify-full&sslrootcert=$(printf '%s/database-ca.crt' "${HL_LEGACY_ETC}" | sed 's:/:%2F:g')&connect_timeout=5"
expect_eq 'dsn_sslrootcert: the path a DSN names, percent-decoded' "$(dsn_sslrootcert "${hl_legacy_dsn}")" "${HL_LEGACY_ETC}/database-ca.crt"
expect_eq 'dsn_sslrootcert: a plain path' "$(dsn_sslrootcert 'postgres://a@h/x?sslrootcert=/etc/ficus/database-ca.crt')" '/etc/ficus/database-ca.crt'
expect_eq 'dsn_sslrootcert: none named → nothing' "$(dsn_sslrootcert 'postgres://a@h/x?sslmode=require')" ''
reset_fixture
host_layout_resolve fresh
host_layout_link_legacy_ca_dir "${hl_legacy_dsn}" 2>/dev/null
expect_eq 'fresh (layout 2) host, DSN names the legacy CA path: the legacy etc dir becomes the compat link to /etc/ficus' \
  "$(readlink "$R${HL_LEGACY_ETC}")" "$R/etc/ficus"
host_layout_link_legacy_ca_dir "${hl_legacy_dsn}" 2>/dev/null
expect_eq '...idempotent (the link is left as it is)' "$(readlink "$R${HL_LEGACY_ETC}")" "$R/etc/ficus"
reset_fixture
host_layout_link_legacy_ca_dir "${hl_legacy_dsn//${HL_LEGACY_ETC##*/}%2F/ficus%2F}" 2>/dev/null
expect_eq 'a DSN that names /etc/ficus: no link' "$([[ -e $R${HL_LEGACY_ETC} || -L $R${HL_LEGACY_ETC} ]] && echo link || echo none)" 'none'
host_layout_link_legacy_ca_dir 'postgres://a@h/x?sslmode=require' 2>/dev/null
expect_eq 'a DSN that names no CA: no link' "$([[ -e $R${HL_LEGACY_ETC} || -L $R${HL_LEGACY_ETC} ]] && echo link || echo none)" 'none'
host_layout_resolve 1
host_layout_link_legacy_ca_dir "${hl_legacy_dsn}" 2>/dev/null
expect_eq 'a layout-1 host: no link (its etc dir is the legacy one)' "$([[ -L $R${HL_LEGACY_ETC} ]] && echo link || echo none)" 'none'
host_layout_resolve fresh
mkdir -p "$R${HL_LEGACY_ETC}"
expect_match 'a real legacy etc dir without the CA: left alone, with a warning' \
  "$(host_layout_link_legacy_ca_dir "${hl_legacy_dsn}" 2>&1; [[ -L $R${HL_LEGACY_ETC} ]] && echo LINKED)" 'verify-full connection will fail'
reset_fixture
host_layout_resolve "$(host_layout_detect)"

if [[ -n ${hl_skip} ]]; then
  printf 'SKIP: the host_layout migration cases did not run — %s\n' "${hl_skip}" >&2
  if [[ $(uname -s) == Linux ]]; then
    FAIL=$((FAIL + 1))
    log_error 'FAIL: the host_layout migration cases must run on Linux (install mikefarah yq)'
  fi
else
  fail() {
    FAIL=$((FAIL + 1))
    log_error "FAIL: $*"
  }
  snapshot() { (
    cd "$R" && find . -path ./calls.log -prune -o -printf '%p %y %l %m\n' | sort
    find . -type f ! -name calls.log -exec sha256sum {} + | sort -k2
  ); }
  hl_pending_set() { cut -f1 "$(host_migrate_backup_root)/PENDING"; } # PENDING is <set>\t<names>\t<release>
  hl_last_set() { ls -1dt "$(host_migrate_backup_root)"/*/ | head -1 | sed 's:/$::'; }
  pending_state() { if [[ -e $(host_migrate_backup_root)/PENDING ]]; then echo y; else echo n; fi; }
  HOST_MIGRATIONS=(host_layout)
  _hm_is_root() { return 0; }
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

  STUB="${SCRATCH}/hl-stub"
  DOCKER_STATE="${SCRATCH}/hl-docker"
  mkdir -p "${STUB}"
  export STUB_DOCKER_STATE="${DOCKER_STATE}"
  cat >"${STUB}/systemctl" <<'STUBEOF'
#!/usr/bin/env bash
# systemctl, as far as the migration uses it: enable/disable make the links
# systemd makes (one per WantedBy= target's .wants, one per Alias=).
printf 'systemctl %s\n' "$*" >>"${FICUS_HOST_ROOT}/calls.log"
U=${FICUS_SYSTEMD_UNIT_DIR}
norm() { case $1 in *.service | *.timer | *.target) printf '%s' "$1" ;; *) printf '%s.service' "$1" ;; esac; }
cmd=$1
shift
# STUB_KILL_ON_STOP: the first `stop` SIGKILLs the shell that called it.
if [[ ${cmd} == stop && -n ${STUB_KILL_ON_STOP:-} ]]; then kill -KILL "${PPID}"; exit 1; fi
case ${cmd} in
  enable | disable)
    for a in "$@"; do
      [[ ${a} == --now ]] && continue
      u=$(norm "${a}") f="${U}/$(norm "${a}")"
      if [[ ${cmd} == enable ]]; then
        [[ -f ${f} ]] || { echo "Unit file ${u} does not exist." >&2; exit 1; }
        while IFS= read -r t; do mkdir -p "${U}/${t}.wants" && ln -sfn "${f}" "${U}/${t}.wants/${u}"; done < <(sed -n 's/^WantedBy=//p' "${f}")
        while IFS= read -r al; do ln -sfn "${f}" "${U}/${al}"; done < <(sed -n 's/^Alias=//p' "${f}")
      else
        [[ -e ${f} || -L ${f} ]] || { echo "Unit file ${u} does not exist." >&2; exit 1; }
        for l in "${U}"/*.wants/"${u}" "${U}"/*; do
          if [[ -L ${l} ]] && [[ ${l} == "${U}"/*.wants/"${u}" || $(readlink "${l}") == "${f}" ]]; then rm -f "${l}"; fi
        done
      fi
    done
    ;;
  is-active)
    q=0
    if [[ ${1:-} == --quiet ]]; then q=1; shift; fi
    u=$(norm "$1")
    if [[ ${STUB_BACKUP_ACTIVE:-} == always && ${u} == *-backup.service ]]; then
      ((q)) || echo activating
      exit 3
    fi
    ((q)) || echo inactive
    exit 3
    ;;
  is-enabled)
    u=$(norm "$1")
    if [[ -n ${STUB_TIMER_STATE:-} && ${u} == *-backup.timer ]]; then
      echo "${STUB_TIMER_STATE}"
      exit 0
    fi
    for l in "${U}"/*.wants/"${u}"; do if [[ -L ${l} ]]; then echo enabled; exit 0; fi; done
    echo disabled
    exit 1
    ;;
  *) exit 0 ;;
esac
STUBEOF
  cat >"${STUB}/docker" <<'STUBEOF'
#!/usr/bin/env bash
# docker, as far as the migration uses it: containers and volumes as files.
printf 'docker %s\n' "$*" >>"${FICUS_HOST_ROOT}/calls.log"
S=${STUB_DOCKER_STATE}
mkdir -p "${S}/c" "${S}/v"
case $1 in
  info) exit 0 ;;
  inspect)
    if [[ $2 == -f ]]; then
      [[ -e ${S}/c/$4 ]] || exit 1
      case $3 in *Image*) echo 'paradedb/paradedb:latest' ;; *Running*) cat "${S}/c/$4" ;; esac
      exit 0
    fi
    [[ -e ${S}/c/$2 ]]
    ;;
  volume)
    case $2 in
      create) mkdir -p "${S}/v/$3" && echo "$3" ;;
      inspect)
        if [[ $3 == -f ]]; then [[ -d ${S}/v/$5 ]] && echo "${S}/v/$5"; else [[ -d ${S}/v/$3 ]]; fi
        ;;
      rm) rm -rf "${S}/v/$3" ;;
    esac
    ;;
  stop) [[ -e ${S}/c/$2 ]] && echo false >"${S}/c/$2" ;;
  start) [[ -e ${S}/c/$2 ]] && echo true >"${S}/c/$2" ;;
  rm)
    if [[ $2 == -f ]]; then rm -f "${S}/c/$3"; else [[ -e ${S}/c/$2 ]] && rm -f "${S}/c/$2"; fi
    ;;
  run)
    name=''
    prev=''
    for a in "$@"; do
      [[ ${prev} == --name ]] && name=${a}
      prev=${a}
    done
    if [[ -n ${name} ]]; then
      echo true >"${S}/c/${name}"
      printf 'docker-run-env POSTGRES_PASSWORD=%s\n' "${POSTGRES_PASSWORD:-}" >>"${FICUS_HOST_ROOT}/calls.log"
    fi
    ;;
  exec)
    if [[ -n ${STUB_DB_FICUS_EXISTS:-} && " $* " == *"datname='ficus'"* ]]; then echo 1; fi
    exit 0
    ;;
esac
STUBEOF
  cat >"${STUB}/bun" <<'STUBEOF'
#!/usr/bin/env bash
printf 'bun %s (cwd=%s FICUS_ROOT=%s HOME_DIR=%s)\n' "$*" "${PWD}" "${FICUS_ROOT:-}" "${HOME_DIR:-}" >>"${FICUS_HOST_ROOT}/calls.log"
# rebase-home: STUB_BUN_DRY_OUT is what a --dry-run prints; STUB_BUN_RC its exit
# status otherwise (3: it refused, the target already present).
if [[ " $* " == *' --dry-run '* ]]; then printf '%s\n' "${STUB_BUN_DRY_OUT:-}"; exit 0; fi
[[ -z ${STUB_BUN_RC:-} ]] || exit "${STUB_BUN_RC}"
[[ -z ${STUB_BUN_FAILS:-} ]]
STUBEOF
  cat >"${STUB}/visudo" <<'STUBEOF'
#!/usr/bin/env bash
printf 'visudo %s\n' "$*" >>"${FICUS_HOST_ROOT}/calls.log"
STUBEOF
  cat >"${STUB}/getent" <<'STUBEOF'
#!/usr/bin/env bash
[[ $1 == passwd ]] || exit 2
if [[ $2 == root ]]; then echo "root:x:0:0:root:${FICUS_HOST_ROOT}/root:/bin/bash"; else echo "$2:x:1000:1000::${FICUS_HOST_ROOT}/home/$2:/bin/bash"; fi
STUBEOF
  chmod 0755 "${STUB}"/*
  export PATH="${STUB}:${PATH}"

  REL="$R$HL_LEGACY_DEST/releases/aaaa-bbbb"
  LEG_API="${HL_LEGACY_UNIT_PREFIX}-api"
  LEG_WORKER="${HL_LEGACY_UNIT_PREFIX}-worker"
  LEG_BACKUP="${HL_LEGACY_UNIT_PREFIX}-backup"

  # A layout-1 host, as the fleet has it: absolute current/previous links, no
  # source.dest in effect beyond the fixture's own, an external database whose
  # DSN names the legacy CA path, the backup timer enabled and its service static.
  make_legacy_host() { # [--db-mode container] [--home-dir DIR] [--sudoers] [--git] [--no-yaml-dest]
    local db_mode=external home_dir='' sudoers=0 git=0 yaml_dest=1 d u
    while (($#)); do
      case $1 in
        --db-mode)
          db_mode=$2
          shift 2
          ;;
        --home-dir)
          home_dir=$2
          shift 2
          ;;
        --sudoers)
          sudoers=1
          shift
          ;;
        --git)
          git=1
          shift
          ;;
        --no-yaml-dest)
          yaml_dest=0
          shift
          ;;
        *) return 1 ;;
      esac
    done
    d="$R$HL_LEGACY_DEST"
    mkdir -p "$d" "$R$HL_LEGACY_ETC/artifacts" "$R$HL_LEGACY_SETUP_DIR/keys" "$R/root" "$R/usr/local/bin" "$UNITS" "$DOCKER_STATE/c" "$DOCKER_STATE/v"
    if ((git)); then
      printf '{"name":"ficus","ficusHostLayout":2}\n' >"$d/package.json"
      mkdir -p "$d/apps/core/dist" "$d/node_modules"
      : >"$d/apps/core/dist/rebase-home.js"
      printf 'stamp\n' >"$d/$HL_LEGACY_BUILD_STAMP"
    else
      mkdir -p "$d/releases/c0-legacy/node_modules" "$d/releases/b0-older" "$REL/apps/core/dist"
      printf '{"name":"ficus"}\n' >"$d/releases/c0-legacy/package.json"
      printf '{"sha":"c0"}\n' >"$d/releases/c0-legacy/$HL_LEGACY_RELEASE_MARKER"
      printf '{"sha":"b0"}\n' >"$d/releases/b0-older/$HL_LEGACY_RELEASE_MARKER"
      printf '{"hostLayout":2}\n' >"$REL/artifact.json"
      printf '{"sha":"aaaa"}\n' >"$REL/.ficus-release-complete"
      printf '// rebase-home (fixture)\n' >"$REL/apps/core/dist/rebase-home.js"
      ln -s "$d/releases/c0-legacy" "$d/current"
      ln -s "$d/releases/b0-older" "$d/previous"
      ln -s "$d/releases/c0-legacy/node_modules" "$d/node_modules"
      ln -s releases/c0-legacy "$d/relative-link"
    fi
    if [[ $db_mode == container ]]; then
      printf 'DATABASE_URL=postgres://postgres:dbpw@127.0.0.1:5432/%s\n' "$HL_LEGACY_DB_NAME" >"$d/.env"
      echo true >"$DOCKER_STATE/c/$HL_LEGACY_DB_CONTAINER"
      mkdir -p "$DOCKER_STATE/v/$HL_LEGACY_DB_VOLUME"
      printf 'pgdata\n' >"$DOCKER_STATE/v/$HL_LEGACY_DB_VOLUME/PG_VERSION"
    else
      printf 'DATABASE_URL=postgresql://tenant_x:pw@db.example:25060/x?sslmode=verify-full&sslrootcert=%s\n' \
        "$(printf '%s/database-ca.crt' "$HL_LEGACY_ETC" | sed 's:/:%2F:g')" >"$d/.env"
    fi
    printf 'FICUS_ENCRYPTION_KEY=enc\nAPP_URL=https://acme.ficus.sh\n' >>"$d/.env"
    if [[ -n $home_dir ]]; then
      printf 'HOME_DIR=%s\n' "$home_dir" >>"$d/.env"
      mkdir -p "$home_dir/inbox-attachments"
      : >"$home_dir/inbox-attachments/a.txt"
    else
      # Core's data marker (sessions/) is what makes the legacy dir its home.
      mkdir -p "$R/root/$HL_LEGACY_HOME_NAME/inbox-attachments" "$R/root/$HL_LEGACY_HOME_NAME/sessions"
      printf 'att\n' >"$R/root/$HL_LEGACY_HOME_NAME/inbox-attachments/a.txt"
    fi
    chmod 0600 "$d/.env"
    printf 'SES=1\n' >"$R$HL_LEGACY_ETC/managed.env"
    printf "FICUS_BACKUP_S3_ACCESS_KEY='ak'\n" >"$R$HL_LEGACY_ETC/backup.env"
    printf 'ca\n' >"$R$HL_LEGACY_ETC/database-ca.crt"
    chmod 0600 "$R$HL_LEGACY_ETC/managed.env" "$R$HL_LEGACY_ETC/backup.env"
    cat >"$R$HL_LEGACY_SETUP_DIR/$HL_LEGACY_SETUP_YAML" <<YAMLEOF
# setup config (fixture)
source:
  mode: artifact
  dest: $d
core:
  run_user: root
  port: 3000
database:
  mode: $db_mode
  ca_path: $R$HL_LEGACY_SETUP_DIR/keys/database-ca.crt
artifacts:
  dir: $R$HL_LEGACY_SETUP_DIR/artifacts
backup:
  env_hint: $R$HL_LEGACY_ETC/backup.env
  unrelated: $R$HL_LEGACY_ETC-other/x
YAMLEOF
    ((yaml_dest)) || sed -i '/^  dest: /d' "$R$HL_LEGACY_SETUP_DIR/$HL_LEGACY_SETUP_YAML"
    printf 'ca\n' >"$R$HL_LEGACY_SETUP_DIR/keys/database-ca.crt"
    for u in "$LEG_API" "$LEG_WORKER"; do
      printf '[Unit]\nDescription=%s\n[Service]\nEnvironmentFile=%s/.env\nExecStart=/usr/local/bin/bun run dist/index.js\n[Install]\nWantedBy=multi-user.target\n' \
        "$u" "$d" >"$UNITS/$u.service"
      mkdir -p "$UNITS/$u.service.d"
      printf '[Service]\nEnvironmentFile=-%s/managed.env\n' "$HL_LEGACY_ETC" >"$UNITS/$u.service.d/managed-env.conf"
    done
    api_memory_guardrail_content >"$UNITS/$LEG_API.service.d/zz-local.$HL_LEGACY_GUARDRAIL_SUFFIX"
    printf '[Service]\nType=oneshot\nExecStart=%s\n' "$R$HL_LEGACY_BACKUP_SCRIPT" >"$UNITS/$LEG_BACKUP.service"
    printf '[Timer]\nOnCalendar=*-*-* 03:15:00\nPersistent=true\nUnit=%s.service\n\n[Install]\nWantedBy=timers.target\n' "$LEG_BACKUP" >"$UNITS/$LEG_BACKUP.timer"
    local container=''
    [[ $db_mode != container ]] || container=$HL_LEGACY_DB_CONTAINER
    render_backup_script_content "$SCRIPT_DIR/ficus-backup.sh.tmpl" "$d" "${home_dir:-$R/root/$HL_LEGACY_HOME_NAME}" "$db_mode" "$container" \
      https://s3.example us-east-1 bucket tenant/acme "$R$HL_LEGACY_ETC/backup.env" >"$R$HL_LEGACY_BACKUP_SCRIPT"
    chmod 0755 "$R$HL_LEGACY_BACKUP_SCRIPT"
    if ((sudoers)); then
      mkdir -p "$R/etc/sudoers.d"
      printf 'svc ALL=(root) NOPASSWD: /usr/bin/systemctl restart %s, /usr/bin/systemctl restart %s\n' "$LEG_API" "$LEG_WORKER" >"$R$HL_LEGACY_SUDOERS"
      chmod 0440 "$R$HL_LEGACY_SUDOERS"
    fi
    systemctl enable "$LEG_API" "$LEG_WORKER" "$LEG_BACKUP.timer"
    : >"$R/calls.log"
    # The caller globals an entrypoint holds.
    SRC_DEST=$d CFG_FILE="$R$HL_LEGACY_SETUP_DIR/$HL_LEGACY_SETUP_YAML" CONFIG=$CFG_FILE
    RUN_USER=root DB_MODE=$db_mode BUN_BIN=/usr/local/bin/bun CORE_LAYOUT=''
    ((git)) || CORE_LAYOUT=artifact
    # shellcheck disable=SC2034 # caller globals lib.sh's host_layout_relocate_globals re-prefixes
    ARTIFACT_RELEASE_DIR='' BACKUP_HOME_DIR="${home_dir:-$R/root/$HL_LEGACY_HOME_NAME}"
    host_layout_resolve "$(host_layout_detect)"
  }
  hl_reset() {
    reset_fixture
    rm -rf "$DOCKER_STATE"
    HOST_MIGRATE_PENDING=0 HOST_MIGRATE_BACKUP_SET='' HOST_MIGRATE_RELEASE='' HOST_MIGRATE_NAMES=''
    ARTIFACT_RELOCATED_FROM='' ARTIFACT_RELOCATED_TO='' ARTIFACT_CONVERTED_THIS_RUN=0
    unset _HM_REVERSE_SET _HM_REVERSE_DONE _HM_REVERSE_RUNNING _HM_IN_REVERSE _HM_REVERSED
  }

  # --- the happy path, through the framework -----------------------------------
  hl_reset
  make_legacy_host
  expect_eq '(fixture) a layout-1 host' "$(host_layout_detect):$HL_UNIT_API" "1:$LEG_API"
  expect_eq 'needed on a layout-1 host with a layout-2 target' "$(host_migration_host_layout_needed "$REL" && echo y)" 'y'
  expect_eq 'deferred when a conversion ran this run' "$(ARTIFACT_CONVERTED_THIS_RUN=1 host_migration_host_layout_needed "$REL" 2>/dev/null && echo y || echo n)" 'n'
  expect_eq 'not needed for a target that declares no layout' "$(host_migration_host_layout_needed "$R$HL_LEGACY_DEST/releases/c0-legacy" && echo y || echo n)" 'n'
  host_migrate "$REL" 2>"$SCRATCH/hl-happy.log"
  S=$(hl_pending_set)
  expect_eq 'set is marked requires-reverse' "$(head -n1 "$S/MANIFEST")" $'#requires-reverse\thost_layout'
  expect_eq 'set holds the backup timer' "$(grep -c "${LEG_BACKUP}.timer\$" "$S/MANIFEST")" '1'
  expect_eq 'dest moved' "$(stat -c %F "$R/opt/ficus-core")" 'directory'
  expect_eq 'compat dest link' "$(readlink "$R$HL_LEGACY_DEST")" "$R/opt/ficus-core"
  expect_eq 'current re-pointed' "$(readlink "$R/opt/ficus-core/current")" "$R/opt/ficus-core/releases/c0-legacy"
  expect_eq 'previous and node_modules re-pointed; a relative link untouched' \
    "$(readlink "$R/opt/ficus-core/previous"):$(readlink "$R/opt/ficus-core/node_modules"):$(readlink "$R/opt/ficus-core/relative-link")" \
    "$R/opt/ficus-core/releases/b0-older:$R/opt/ficus-core/releases/c0-legacy/node_modules:releases/c0-legacy"
  expect_eq 'LINKS audit trail' "$(wc -l <"$S/hl/LINKS" | tr -d ' ')" '3'
  expect_eq 'etc moved' "$(readlink "$R$HL_LEGACY_ETC")" "$R/etc/ficus"
  expect_eq 'setup dir moved, config renamed' \
    "$(readlink "$R$HL_LEGACY_SETUP_DIR"):$(readlink "$R/root/ficus-setup/$HL_LEGACY_SETUP_YAML"):$(stat -c %F "$R/root/ficus-setup/ficus-setup.yaml")" \
    "$R/root/ficus-setup:ficus-setup.yaml:regular file"
  expect_eq 'yaml dest' "$(yq -r .source.dest "$R/root/ficus-setup/ficus-setup.yaml")" "$R/opt/ficus-core"
  expect_eq 'yaml paths re-prefixed (a lookalike prefix untouched)' \
    "$(yq -r '[.database.ca_path, .artifacts.dir, .backup.env_hint, .backup.unrelated] | join(" ")' "$R/root/ficus-setup/ficus-setup.yaml")" \
    "$R/root/ficus-setup/keys/database-ca.crt $R/root/ficus-setup/artifacts $R/etc/ficus/backup.env $R$HL_LEGACY_ETC-other/x"
  expect_eq 'yaml comment kept' "$(head -n1 "$R/root/ficus-setup/ficus-setup.yaml")" '# setup config (fixture)'
  expect_eq 'HOME moved' "$(stat -c %F "$R/root/.ficus"):$(readlink "$R/root/$HL_LEGACY_HOME_NAME")" "directory:$R/root/.ficus"
  expect_eq 'HOME_DIR explicit' "$(grep '^HOME_DIR=' "$R/opt/ficus-core/.env")" "HOME_DIR=$R/root/.ficus"
  expect_eq '.env keeps its mode and its DSN (the CA path is P5-T11)' \
    "$(stat -c %a "$R/opt/ficus-core/.env"):$(grep -c 'sslrootcert=%2Fetc%2F' "$R/opt/ficus-core/.env")" '600:1'
  expect_eq 'legacy unit is the alias link' "$(test -L "$UNITS/$LEG_API.service" && readlink "$UNITS/$LEG_API.service")" "$UNITS/ficus-api.service"
  expect_match 'alias rendered' "$(cat "$UNITS/ficus-api.service")" "Alias=${LEG_API}.service"
  expect_match 'worker alias rendered' "$(cat "$UNITS/ficus-worker.service")" "Alias=${LEG_WORKER}.service"
  expect_eq 'the ficus units are enabled' "$(readlink "$UNITS/multi-user.target.wants/ficus-api.service"):$(test -e "$UNITS/multi-user.target.wants/$LEG_API.service" && echo stale || echo gone)" \
    "$UNITS/ficus-api.service:gone"
  expect_match 'the ficus api unit reads the moved .env' "$(cat "$UNITS/ficus-api.service")" "EnvironmentFile=$R/opt/ficus-core/.env"
  expect_eq 'drop-in dirs moved, guardrail suffix renamed, managed-env rewritten' \
    "$(cd "$UNITS/ficus-api.service.d" && ls | tr '\n' ' '):$(cat "$UNITS/ficus-worker.service.d/managed-env.conf" | tail -n1):$(test -e "$UNITS/$LEG_API.service.d" && echo stale || echo gone)" \
    "managed-env.conf zz-local.$HL_NEW_GUARDRAIL_SUFFIX :EnvironmentFile=-/etc/ficus/managed.env:gone"
  expect_match 'stop before mv' "$(grep -m1 'systemctl stop' "$R/calls.log")" "${LEG_BACKUP}.timer"
  expect_eq 'api and worker stopped (stop-the-world) before anything else ran' \
    "$(awk -v s="systemctl stop ${LEG_API} ${LEG_WORKER}" '$0 == s { print (seen ? "late" : "first"); exit } $1 != "systemctl" { seen = 1 }' "$R/calls.log")" 'first'
  expect_match 'rebase ran' "$(cat "$R/calls.log")" "rebase-home.js --from $R/root/${HL_LEGACY_HOME_NAME} --to $R/root/.ficus"
  expect_match 'rebase ran as migrate.js does (release apps/core, FICUS_ROOT, .env exported)' "$(grep rebase-home "$R/calls.log")" \
    "cwd=$R$HL_LEGACY_DEST/releases/aaaa-bbbb/apps/core FICUS_ROOT=$R$HL_LEGACY_DEST/releases/aaaa-bbbb HOME_DIR=\\)"
  expect_eq 'backup script rendered with the moved values; the legacy name is its link' \
    "$(grep -E "^(DEST|HOME_DIR|BACKUP_ENV_FILE)=" "$R/usr/local/bin/ficus-backup.sh" | tr '\n' ' '):$(readlink "$R$HL_LEGACY_BACKUP_SCRIPT")" \
    "DEST='$R/opt/ficus-core' HOME_DIR='$R/root/.ficus' BACKUP_ENV_FILE='$R/etc/ficus/backup.env' :ficus-backup.sh"
  expect_eq 'backup units: aliases, timer enabled' \
    "$(grep -h '^Alias=\|^Unit=\|^OnCalendar=\|^ExecStart=' "$UNITS/ficus-backup.service" "$UNITS/ficus-backup.timer" | tr '\n' ' ')" \
    "ExecStart=$R/usr/local/bin/ficus-backup.sh Alias=${LEG_BACKUP}.service OnCalendar=*-*-* 03:15:00 Unit=ficus-backup.service Alias=${LEG_BACKUP}.timer "
  expect_eq 'backup alias links and the timer wants link' \
    "$(readlink "$UNITS/$LEG_BACKUP.service"):$(readlink "$UNITS/$LEG_BACKUP.timer"):$(readlink "$UNITS/timers.target.wants/ficus-backup.timer"):$(test -e "$UNITS/timers.target.wants/$LEG_BACKUP.timer" && echo stale || echo gone)" \
    "$UNITS/ficus-backup.service:$UNITS/ficus-backup.timer:$UNITS/ficus-backup.timer:gone"
  expect_eq 'release markers: the ficus one next to every legacy one (same record)' \
    "$(cat "$R/opt/ficus-core/releases/c0-legacy/.ficus-release-complete" "$R/opt/ficus-core/releases/b0-older/.ficus-release-complete" | tr '\n' ' ')" \
    '{"sha":"c0"} {"sha":"b0"} '
  expect_eq 'globals relocated' "$SRC_DEST:$FICUS_MANAGED_ENV_PATH:$HL_UNIT_API" "$R/opt/ficus-core:$R/etc/ficus/managed.env:ficus-api"
  expect_eq 'config globals follow the renamed config' "$CFG_FILE:$CONFIG:$BACKUP_HOME_DIR" \
    "$R/root/ficus-setup/ficus-setup.yaml:$R/root/ficus-setup/ficus-setup.yaml:$R/root/.ficus"
  expect_eq 'ARTIFACT_RELOCATED_*' "$ARTIFACT_RELOCATED_FROM>$ARTIFACT_RELOCATED_TO" "$R$HL_LEGACY_DEST>$R/opt/ficus-core"
  expect_eq 'DONE written' "$(test -f "$S/hl/DONE" && echo y)" 'y'
  expect_eq 'every step journaled, in order' "$(tr '\n' ' ' <"$S/hl/STEPS")" 'S1 S2 S3 S4 S5 S6 S7 S7b S8 S9 S10 S10b S11 S12 S13 '
  expect_eq 'every step logged' "$(grep -o 'host_layout S[0-9b]*:' "$SCRATCH/hl-happy.log" | tr '\n' ' ')" \
    'host_layout S1: host_layout S2: host_layout S3: host_layout S4: host_layout S5: host_layout S6: host_layout S7: host_layout S7b: host_layout S8: host_layout S9: host_layout S10: host_layout S10b: host_layout S11: host_layout S12: host_layout S13: '
  expect_eq 'layout 2 now' "$(host_layout_detect)" '2'
  expect_eq 'not needed twice' "$(host_migration_host_layout_needed "$REL" && echo y || echo n)" 'n'
  expect_eq 'the framework re-renders the same units after it (host_migrate_for)' \
    "$(cp "$UNITS/ficus-api.service" "$SCRATCH/api.before" && install_core_units "$SCRIPT_DIR/systemd" && cmp -s "$SCRATCH/api.before" "$UNITS/ficus-api.service" && echo same)" 'same'
  host_migrate_commit
  expect_eq 'committed' "$(pending_state)" 'n'

  # --- every step fails once → reconcile reverses to byte-identical ----------------
  for n in 1 2 3 4 5 6 7 7b 8 9 10 10b 11 12 13; do
    hl_reset
    case $n in 9) make_legacy_host --db-mode container ;; 2 | 10b) make_legacy_host --sudoers ;; *) make_legacy_host ;; esac
    before=$(snapshot)
    (HL_FAIL_AT=$n host_migrate "$REL") 2>/dev/null && fail "S$n injected failure did not fail"
    : >"$R/calls.log"
    (host_migrate_reconcile) 2>"$SCRATCH/hl-rec.log" || fail "reconcile died (line 1)"
    expect_eq "S$n failure reverses to byte-identical" "$(snapshot)" "$before"
    expect_match "S$n reverse restarts the legacy units" "$(cat "$R/calls.log")" "systemctl start ${LEG_API} ${LEG_WORKER}"
    expect_eq "S$n no PENDING" "$(pending_state)" 'n'
    expect_eq "S$n reversed (journal marked)" "$(test -f "$(hl_last_set)/hl/REVERSED" && echo y)" 'y'
    case $n in
      7b) expect_match 'S7b⁻¹ rebased the stored paths back' "$(cat "$R/calls.log")" "rebase-home.js --from $R/root/.ficus --to $R/root/${HL_LEGACY_HOME_NAME}" ;;
      9) expect_match 'S9⁻¹ re-created the legacy container on its volume' "$(cat "$R/calls.log")" \
        "docker run -d --name ${HL_LEGACY_DB_CONTAINER} .* -v ${HL_LEGACY_DB_VOLUME}:/var/lib/postgresql paradedb/paradedb:latest" ;;
      10) expect_match 'S10⁻¹ logged its inverse' "$(cat "$SCRATCH/hl-rec.log")" 'host_layout S10⁻¹:' ;;
    esac
  done
  # the same through the traps (settle_pending)
  for n in 3 7b 10 12; do
    hl_reset
    make_legacy_host
    before=$(snapshot)
    (
      host_migrate_install_traps
      HL_FAIL_AT=$n host_migrate "$REL"
    ) 2>/dev/null || true
    expect_eq "S$n trap settle → byte-identical" "$(snapshot)" "$before"
    expect_eq "S$n trap settle → no PENDING" "$(pending_state)" 'n'
  done
  # a SIGKILL inside every step (intent-first journal), then the next run's reconcile
  for n in 1 2 3 4 5 6 7 7b 8 9 10 10b 11 12 13; do
    hl_reset
    case $n in 9) make_legacy_host --db-mode container ;; 2 | 10b) make_legacy_host --sudoers ;; *) make_legacy_host ;; esac
    before=$(snapshot)
    (HL_KILL_IN=$n host_migrate "$REL") 2>/dev/null || true
    expect_eq "SIGKILL inside S$n leaves the journal" "$(pending_state):$(tail -n1 "$(hl_pending_set)/hl/STEPS")" "y:S$n"
    (host_migrate_reconcile) 2>/dev/null || fail "reconcile died (line 2)"
    expect_eq "SIGKILL inside S$n → reconcile reverses to byte-identical" "$(snapshot)" "$before"
    expect_eq "SIGKILL inside S$n → no PENDING" "$(pending_state)" 'n'
  done
  # a SIGKILL inside the reverse itself: the next reconcile reverses again (idempotent)
  for k in 12 10 7 5 3 restored; do
    hl_reset
    make_legacy_host --sudoers
    before=$(snapshot)
    (HL_FAIL_AT=13 host_migrate "$REL") 2>/dev/null || true
    (HL_KILL_IN_REVERSE=$k host_migrate_reconcile) 2>/dev/null || true
    expect_eq "reverse killed at $k: the journal is kept" "$(pending_state)" 'y'
    (host_migrate_reconcile) 2>/dev/null || fail "reconcile died (line 3)"
    expect_eq "reverse killed at $k: the next reconcile finishes it, byte-identical" "$(snapshot):$(pending_state)" "$before:n"
  done
  # apply never runs forward over a partial journal (the framework reverses that)
  hl_reset
  make_legacy_host
  (HL_FAIL_AT=5 host_migrate "$REL") 2>/dev/null || true
  partial=$(snapshot)
  (
    HOST_MIGRATE_BACKUP_SET=$(hl_pending_set)
    host_migration_host_layout_apply "$REL"
  ) 2>"$SCRATCH/hl-partial.log" && fail 'apply ran over a partial journal'
  expect_match 'apply over a partial journal: refused' "$(cat "$SCRATCH/hl-partial.log")" 'reverse'
  expect_eq 'apply over a partial journal: nothing changed' "$(snapshot)" "$partial"
  (host_migrate_reconcile) 2>/dev/null || fail 'reconcile died (partial journal)'

  # git mode (the release is the checkout, always "active"): _settle decides
  hl_reset
  make_legacy_host --git
  before=$(snapshot)
  (HL_FAIL_AT=12 host_migrate "$SRC_DEST") 2>/dev/null && fail 'git mode: the injected failure did not fail'
  (host_migrate_reconcile) 2>/dev/null || fail "reconcile died (line 4)"
  expect_eq 'git mode: a failure before DONE is reversed although the release is active' "$(snapshot):$(pending_state)" "$before:n"
  host_migrate "$SRC_DEST" 2>/dev/null
  expect_eq 'git mode: migrated; the build stamp renamed' \
    "$(host_layout_detect):$SRC_DEST:$(test -f "$R/opt/ficus-core/.ficus-build-stamp" && echo stamp)" "2:$R/opt/ficus-core:stamp"
  host_migrate_commit

  # --- after DONE, before the flip: settle goes FORWARD and brings the units back --
  hl_reset
  make_legacy_host
  (HL_FAIL_AFTER_DONE=1 host_migrate "$REL") 2>/dev/null || true
  : >"$R/calls.log"
  (host_migrate_reconcile) 2>/dev/null || fail "reconcile died (line 5)"
  expect_eq 'adopt: (fixture) the reconciling shell still holds the legacy paths' "$SRC_DEST" "$R$HL_LEGACY_DEST"
  host_layout_adopt
  expect_eq 'forward after DONE' "$(host_layout_detect)" '2'
  expect_eq 'no PENDING left' "$(pending_state)" 'n'
  expect_match 'units started after the forward settle' "$(cat "$R/calls.log")" 'systemctl start ficus-api ficus-worker'
  expect_eq 'adopt relocated SRC_DEST' "$SRC_DEST" "$R/opt/ficus-core"
  expect_eq 'adopt relocated the config and resolved layout 2' "$CFG_FILE:$HL_UNIT_API:$ARTIFACT_RELOCATED_FROM" \
    "$R/root/ficus-setup/ficus-setup.yaml:ficus-api:"
  # the same through this run's trap (TERM between DONE and the flip)
  hl_reset
  make_legacy_host
  (
    host_migrate_install_traps
    HL_FAIL_AFTER_DONE=1 host_migrate "$REL"
  ) 2>/dev/null || true
  expect_eq 'trap after DONE: settled forward, committed' "$(host_layout_detect):$(pending_state)" '2:n'

  # --- rollback hook after the commit point: BOTH units stopped first, layout kept --
  hl_reset
  make_legacy_host
  host_migrate "$REL" 2>/dev/null
  : >"$R/calls.log"
  host_layout_rollback_hook 2>/dev/null
  expect_match 'stop-the-world on rollback' "$(head -n1 "$R/calls.log")" 'systemctl stop ficus-api ficus-worker'
  expect_eq 'layout kept on rollback' "$(host_layout_detect)" '2'
  expect_eq 'rollback committed' "$(pending_state)" 'n'

  # a requires-reverse set is never byte-restored by hand
  expect_eq 'direct restore refused' "$( (host_migrate_backup_restore "$(hl_last_set)") >/dev/null 2>&1 && echo restored || echo refused)" 'refused'
  expect_eq 'a direct call of the reverse (not through _hm_reverse) cannot restore the set' \
    "$( (host_migration_host_layout_reverse "$(hl_last_set)") >/dev/null 2>&1 && echo ran || echo refused)" 'refused'

  # --- manual reverse of a committed migration (F2 rollback 2) ------------------------
  snap_outside_releases() { snapshot | grep -vE '(^|  )\./[^ ]*/releases/'; }
  hl_reset
  make_legacy_host
  pristine=$(snap_outside_releases)
  pristine_full=$(snapshot)
  host_migrate "$REL" 2>/dev/null
  host_migrate_commit
  ln -sfn "$R/opt/ficus-core/releases/aaaa-bbbb" "$R/opt/ficus-core/current" # the U1 release serves
  expect_eq 'manual reverse refuses while a layout-2 release serves' \
    "$( (host_layout_reverse_committed "$(hl_last_set)") >/dev/null 2>&1 && echo ran || echo refused)" 'refused'
  ln -sfn "$R/opt/ficus-core/releases/c0-legacy" "$R/opt/ficus-core/current" # rolled back to the pre-U1 release
  : >"$R/calls.log"
  (host_layout_reverse_committed "$(hl_last_set)") 2>/dev/null || fail 'the manual reverse died'
  host_layout_adopt 2>/dev/null # the reverse's own adopt ran in the subshell
  expect_eq 'manual reverse → layout 1' "$(host_layout_detect)" '1'
  expect_eq 'manual reverse → byte-identical outside releases/ (current names the legacy path again)' \
    "$(snap_outside_releases)" "$pristine"
  expect_eq 'manual reverse → byte-identical to layout 1 everywhere (the release markers S12 added are gone too)' \
    "$(snapshot)" "$pristine_full"
  expect_eq 'manual reverse: the backup timer, then both ficus units, stopped before anything moves' \
    "$(grep '^systemctl ' "$R/calls.log" | grep -vE '^systemctl is-(active|enabled) ' | head -n 2 | tr '\n' '|')" 'systemctl stop ficus-backup.timer|systemctl stop ficus-api ficus-worker|'
  expect_eq 'manual reverse: the globals follow the host back' "$SRC_DEST:$CFG_FILE:$HL_UNIT_API" \
    "$R$HL_LEGACY_DEST:$R$HL_LEGACY_SETUP_DIR/$HL_LEGACY_SETUP_YAML:$LEG_API"
  expect_eq 'manual reverse: refused a second time (not on layout 2)' \
    "$( (host_layout_reverse_committed "$(hl_last_set)") >/dev/null 2>&1 && echo ran || echo refused)" 'refused'

  # --- the fleet's config names no source.dest: the move writes the new default explicitly --
  hl_reset
  make_legacy_host --no-yaml-dest
  host_migrate "$REL" 2>/dev/null
  expect_eq 'no source.dest before → the Ficus dest written explicitly (without FICUS_HOST_ROOT)' \
    "$(yq -r .source.dest "$R/root/ficus-setup/ficus-setup.yaml")" '/opt/ficus-core'
  host_migrate_commit

  # --- Ruling 81 I1: only the latest committed, not-yet-reversed set may be reversed ------
  # migrate (A) → reverse A → rotate a secret → migrate again (B) → reversing A is refused:
  # its files predate the rotation.
  hl_reset
  make_legacy_host
  host_migrate "$REL" 2>/dev/null
  host_migrate_commit
  SET_A=$(hl_last_set)
  (host_layout_reverse_committed "$SET_A") 2>/dev/null || fail 'the reverse of A died'
  host_layout_adopt 2>/dev/null
  envfile_set "$R$HL_LEGACY_DEST/.env" FICUS_ENCRYPTION_KEY rotated
  host_migrate "$REL" 2>/dev/null
  host_migrate_commit
  SET_B=$(hl_last_set)
  expect_eq 'I1: (fixture) two sets; B is the latest committed one' \
    "$([[ $SET_A != "$SET_B" ]] && echo two):$(host_layout_latest_committed_set)" "two:$SET_B"
  before=$(snapshot)
  (host_layout_reverse_committed "$SET_A") >/dev/null 2>"$SCRATCH/hl-i1.log" && fail 'I1: a reversed, older set was reversed again'
  expect_match 'I1: refused, naming it reversed' "$(cat "$SCRATCH/hl-i1.log")" 'already reversed'
  expect_eq 'I1: nothing changed; the rotated secret stays' \
    "$(snapshot):$(grep '^FICUS_ENCRYPTION_KEY=' "$R/opt/ficus-core/.env")" "$before:FICUS_ENCRYPTION_KEY=rotated"
  # An older set that was never marked reversed: refused because B is newer.
  rm -f "$SET_A/hl/REVERSED"
  (host_layout_reverse_committed "$SET_A") >/dev/null 2>"$SCRATCH/hl-i1.log" && fail 'I1: an older set was reversed over a newer one'
  expect_match 'I1: an older set is refused while a newer committed one exists' "$(cat "$SCRATCH/hl-i1.log")" 'not the latest committed'
  expect_eq 'I1: ...changing nothing' "$(snapshot)" "$before"
  # A reversed set with no newer one (B pruned): still refused.
  printf 'x\n' >"$SET_A/hl/REVERSED"
  rm -rf "$SET_B"
  (host_layout_reverse_committed "$SET_A") >/dev/null 2>"$SCRATCH/hl-i1.log" && fail 'I1: a reversed set was reversed again'
  expect_match 'I1: a reversed set is refused even when it is the newest' "$(cat "$SCRATCH/hl-i1.log")" 'already reversed'
  expect_eq 'I1: ...changing nothing' "$(snapshot)" "$before"

  # --- prune keeps the committed set the manual reverse needs ------------------------------
  hl_reset
  make_legacy_host
  host_migrate "$REL" 2>/dev/null
  host_migrate_commit
  SET_A=$(hl_last_set)
  for i in 1 2 3 4 5 6; do
    mkdir -p "$(host_migrate_backup_root)/29990101T00000${i}Z-abcdef"
    printf '1\t%064d\t/x\n' 0 >"$(host_migrate_backup_root)/29990101T00000${i}Z-abcdef/MANIFEST"
  done
  host_migrate_backup_prune 2>/dev/null
  expect_eq 'prune keeps the latest committed host_layout set (and the newest five)' \
    "$(test -d "$SET_A" && echo kept):$(ls -1d "$(host_migrate_backup_root)"/*/ | wc -l | tr -d ' ')" 'kept:6'

  # --- Ruling 81 I2: a container that already holds a database with the new name ---------
  hl_reset
  make_legacy_host --db-mode container
  before=$(snapshot)
  (STUB_DB_FICUS_EXISTS=1 host_migrate "$REL") 2>"$SCRATCH/hl-i2.log" && fail 'I2: migrated onto an existing database of the new name'
  expect_match 'I2: refused before anything changed' "$(cat "$SCRATCH/hl-i2.log")" "already holds a database named ficus"
  expect_eq 'I2: no container touched, no rename' \
    "$(grep -c 'docker stop\|docker rm\|ALTER DATABASE' "$R/calls.log" || true):$(wc -c <"$(hl_pending_set)/hl/STEPS" | tr -d ' ')" '0:0'
  (host_migrate_reconcile) 2>/dev/null || fail 'reconcile died (I2)'
  expect_eq 'I2: settles untouched' "$(snapshot):$(pending_state)" "$before:n"

  # --- the backup timer: every enabled-like state counts ----------------------------------
  hl_reset
  make_legacy_host
  rm -f "$UNITS/timers.target.wants/$LEG_BACKUP.timer"
  STUB_TIMER_STATE=enabled-runtime host_migrate "$REL" 2>/dev/null
  expect_eq 'a runtime-enabled legacy timer comes out enabled as the ficus timer' \
    "$(cat "$(hl_pending_set)/hl/TIMER_WAS_ENABLED"):$(readlink "$UNITS/timers.target.wants/ficus-backup.timer")" "1:$UNITS/ficus-backup.timer"
  host_migrate_commit

  # --- HOME_DIR=~/… is read as Core reads it: under the run user's home -------------------
  hl_reset
  make_legacy_host
  # shellcheck disable=SC2088 # a literal ~/ is the point
  envfile_set "$R$HL_LEGACY_DEST/.env" HOME_DIR "~/${HL_LEGACY_HOME_NAME}"
  host_migrate "$REL" 2>/dev/null
  expect_eq 'a ~/ HOME_DIR moves and is written back absolute' \
    "$(stat -c %F "$R/root/.ficus"):$(grep '^HOME_DIR=' "$R/opt/ficus-core/.env")" "directory:HOME_DIR=$R/root/.ficus"
  host_migrate_commit

  # --- final review I1: a real legacy HOME is THE home to move, with or without sessions/ --
  hl_reset
  make_legacy_host
  rm -rf "$R/root/$HL_LEGACY_HOME_NAME/sessions"
  mkdir -p "$R/root/$HL_LEGACY_HOME_NAME/memory" && printf 'm\n' >"$R/root/$HL_LEGACY_HOME_NAME/memory/notes.md"
  host_migrate "$REL" 2>/dev/null
  expect_eq 'I1: a legacy HOME without sessions/ (memory/ only) is moved, not orphaned' \
    "$(stat -c %F "$R/root/.ficus"):$(readlink "$R/root/$HL_LEGACY_HOME_NAME"):$(cat "$R/root/.ficus/memory/notes.md")" \
    "directory:$R/root/.ficus:m"
  expect_eq 'I1: ...HOME_DIR written as the moved home, and the stored paths rebased' \
    "$(grep '^HOME_DIR=' "$R/opt/ficus-core/.env"):$(grep -c "rebase-home.js --from $R/root/$HL_LEGACY_HOME_NAME --to $R/root/.ficus" "$R/calls.log")" \
    "HOME_DIR=$R/root/.ficus:1"
  host_migrate_commit

  # --- a custom HOME_DIR is neither moved nor rebased ---------------------------------
  hl_reset
  make_legacy_host --home-dir "$R/srv/data"
  host_migrate "$REL" 2>/dev/null
  expect_eq 'custom HOME untouched' "$(stat -c %F "$R/srv/data")" 'directory'
  expect_eq 'no rebase for custom HOME' "$(grep -c rebase-home "$R/calls.log" || true)" '0'
  expect_eq 'custom HOME_DIR kept in .env and the backup script' \
    "$(grep '^HOME_DIR=' "$R/opt/ficus-core/.env"):$(grep '^HOME_DIR=' "$R/usr/local/bin/ficus-backup.sh")" "HOME_DIR=$R/srv/data:HOME_DIR='$R/srv/data'"
  host_migrate_commit

  # --- a custom install root stays where it is -----------------------------------------
  hl_reset
  make_legacy_host
  mv "$R$HL_LEGACY_DEST" "$R/srv-core"
  for l in current previous node_modules; do ln -sfn "$(readlink "$R/srv-core/$l" | sed "s:^$R$HL_LEGACY_DEST:$R/srv-core:")" "$R/srv-core/$l"; done
  SRC_DEST="$R/srv-core"
  host_migrate "$R/srv-core/releases/aaaa-bbbb" 2>/dev/null
  expect_eq 'custom dest: not moved, no compat link, units point at it' \
    "$(test -e "$R/opt/ficus-core" && echo moved || echo kept):$SRC_DEST:$(grep -c "EnvironmentFile=$R/srv-core/.env" "$UNITS/ficus-api.service")" "kept:$R/srv-core:1"
  host_migrate_commit

  # --- container mode: copy, new container, rename, DSN path rewritten; old volume kept --
  hl_reset
  make_legacy_host --db-mode container
  host_migrate "$REL" 2>/dev/null
  expect_match 'volume copied' "$(cat "$R/calls.log")" "docker run --rm -v ${HL_LEGACY_DB_VOLUME}:/from:ro -v ficus-pgdata:/to"
  expect_match 'new container on the copy' "$(cat "$R/calls.log")" "docker run -d --name ficus-postgres .* -v ficus-pgdata:/var/lib/postgresql"
  expect_eq 'the password never in argv' "$(grep -c 'dbpw' <(grep '^docker ' "$R/calls.log") || true):$(grep -c 'docker-run-env POSTGRES_PASSWORD=dbpw' "$R/calls.log")" '0:1'
  expect_match 'db renamed' "$(cat "$R/calls.log")" "ALTER DATABASE \"${HL_LEGACY_DB_NAME}\" RENAME TO \"ficus\""
  expect_match 'dsn path' "$(grep '^DATABASE_URL=' "$R/opt/ficus-core/.env")" '/ficus(\?|$)'
  expect_eq 'old volume kept' "$(grep -c "docker volume rm ${HL_LEGACY_DB_VOLUME}" "$R/calls.log" || true)" '0'
  expect_eq 'the backup script dumps from the new container' "$(grep '^DB_CONTAINER=' "$R/usr/local/bin/ficus-backup.sh")" "DB_CONTAINER='ficus-postgres'"
  expect_match 'the units order after docker' "$(cat "$UNITS/ficus-api.service" "$UNITS/ficus-backup.service")" 'After=network-online.target docker.service'
  host_migrate_commit

  # --- sudoers (non-root run user): both spellings while the bridge lasts; visudo-checked --
  hl_reset
  make_legacy_host --sudoers
  host_migrate "$REL" 2>/dev/null
  expect_match 'sudoers names ficus + legacy' "$(cat "$R/etc/sudoers.d/ficus-update")" "^svc .*restart ficus-api.*restart ${LEG_API}"
  expect_match 'sudoers validated' "$(cat "$R/calls.log")" 'visudo -cf'
  expect_eq 'sudoers 0440, the legacy file gone (its bytes in the journal)' \
    "$(stat -c %a "$R/etc/sudoers.d/ficus-update"):$(test -e "$R$HL_LEGACY_SUDOERS" && echo stale || echo gone):$(test -f "$(hl_pending_set)/hl/EXTRA/${HL_LEGACY_SUDOERS##*/}" && echo kept)" '440:gone:kept'
  host_migrate_commit

  # --- a backup still running at S1 blocks the move -------------------------------------
  hl_reset
  make_legacy_host
  before=$(snapshot)
  (STUB_BACKUP_ACTIVE=always HL_BACKUP_WAIT_SECS=1 host_migrate "$REL") 2>/dev/null && fail 'apply proceeded while the backup ran'
  expect_eq 'running backup: the core units were never stopped' "$(grep -c "systemctl stop ${LEG_API}" "$R/calls.log" || true)" '0'
  (host_migrate_reconcile) 2>/dev/null || fail "reconcile died (line 6)"
  expect_eq 'running backup → untouched' "$(snapshot)" "$before"

  # --- preconditions: die with nothing changed ----------------------------------------------
  hl_reset
  make_legacy_host
  mkdir -p "$R/etc/ficus"
  before=$(snapshot)
  (host_migrate "$REL") 2>"$SCRATCH/hl-pre.log" && fail 'a taken Ficus path did not stop the migration'
  expect_match 'precondition: a taken path is named' "$(cat "$SCRATCH/hl-pre.log")" "$R/etc/ficus already exists"
  expect_eq 'precondition: the journal is empty' "$(wc -c <"$(hl_pending_set)/hl/STEPS" | tr -d ' ')" '0'
  (host_migrate_reconcile) 2>/dev/null || fail "reconcile died (line 7)"
  expect_eq 'precondition failure settles as a restore, untouched' "$(snapshot):$(pending_state)" "$before:n"
  hl_reset
  make_legacy_host
  rm -f "$REL/apps/core/dist/rebase-home.js"
  (host_migrate "$REL") 2>"$SCRATCH/hl-pre.log" && fail 'a release without rebase-home.js did not stop the migration'
  expect_match 'precondition: rebase-home.js' "$(cat "$SCRATCH/hl-pre.log")" 'rebase-home.js'
  (host_migrate_reconcile) 2>/dev/null || fail "reconcile died (line 8)"

  # --- cross-boundary downgrade on a layout-2 host: stop BOTH, run host_layout zero times --
  hl_reset
  make_legacy_host
  host_migrate "$REL" 2>/dev/null
  host_migrate_commit
  : >"$R/calls.log"
  ln -sfn "$R/opt/ficus-core/releases/aaaa-bbbb" "$R/opt/ficus-core/current"
  OLD="$R/opt/ficus-core/releases/old-0000"
  mkdir -p "$OLD"
  printf '{"name":"ficus"}\n' >"$OLD/package.json"
  (SCRIPT_DIR="$SCRIPT_DIR" host_layout_preflip "$OLD") >/dev/null 2>&1
  expect_match 'downgrade is stop-the-world' "$(cat "$R/calls.log")" 'systemctl stop ficus-api ficus-worker'
  expect_eq 'no new set for a downgrade' "$(ls -1d "$(host_migrate_backup_root)"/*/ | wc -l | tr -d ' ')" '1'
  : >"$R/calls.log"
  (SCRIPT_DIR="$SCRIPT_DIR" host_layout_preflip "$REL") >/dev/null 2>&1
  expect_eq 'same layout on both sides: no extra stop' "$(grep -c 'systemctl stop' "$R/calls.log" || true)" '0'

  # --- repair after an old toolkit wrote a regular legacy unit file over the alias link --
  hl_reset
  make_legacy_host
  host_migrate "$REL" 2>/dev/null
  host_migrate_commit
  rm -f "$UNITS/$LEG_API.service"
  printf '[Unit]\n' >"$UNITS/$LEG_API.service"
  : >"$R/calls.log"
  host_layout_adopt 2>/dev/null
  expect_eq 'stray legacy unit file replaced by the alias link' "$(test -L "$UNITS/$LEG_API.service" && echo y || echo n)" 'y'
  expect_match 'ficus unit re-enabled' "$(cat "$R/calls.log")" 'systemctl enable ficus-api'
  expect_eq 'repair committed its set' "$(pending_state):$(grep -c "$LEG_API.service\$" "$(hl_last_set)/MANIFEST")" 'n:1'
  : >"$R/calls.log"
  host_layout_adopt 2>/dev/null
  expect_eq 'repair: a no-op on a clean host' "$(cat "$R/calls.log")" ''

  # --- T6a M6: an edited journal line cannot turn host_layout's settle into the active release's --
  # PENDING names another (registered) migration, while the set's #requires-reverse line
  # names host_layout: its _settle (DONE → forward) still decides, and it resumes.
  host_migration_hlother_needed() { return 1; }
  host_migration_hlother_apply() { :; }
  HOST_MIGRATIONS=(host_layout hlother)
  hl_reset
  make_legacy_host
  (HL_FAIL_AFTER_DONE=1 host_migrate "$REL") 2>/dev/null || true
  S=$(hl_pending_set)
  sed -i "s/\thost_layout\t/\thlother\t/" "$(host_migrate_backup_root)/PENDING"
  expect_eq 'M6 (fixture): the journal line names hlother, the set host_layout; past DONE; its release not serving' \
    "$(cut -f2 "$(host_migrate_backup_root)/PENDING"):$(head -n1 "$S/MANIFEST" | cut -f2):$(test -f "$S/hl/DONE" && echo 'done'):$(readlink "$R/opt/ficus-core/current")" \
    "hlother:host_layout:done:$R/opt/ficus-core/releases/c0-legacy"
  : >"$R/calls.log"
  (host_migrate_reconcile) 2>/dev/null || fail 'M6: the reconcile died'
  expect_eq 'M6: settled FORWARD by the set'"'"'s host_layout (not reversed by the active release), committed' \
    "$(host_layout_detect):$(pending_state):$(test -e "$S/hl/REVERSED" && echo reversed || echo kept)" '2:n:kept'
  expect_match 'M6: ...and host_layout resumed (the units it stopped are started)' "$(cat "$R/calls.log")" 'systemctl start ficus-api ficus-worker'
  HOST_MIGRATIONS=(host_layout)
  unset -f host_migration_hlother_needed host_migration_hlother_apply

  # --- T6a M7: a set without the core units (UNITS_EXCLUDED) is not reversed where the templates are missing --
  hl_reset
  make_legacy_host
  (HL_FAIL_AT=12 host_migrate "$REL") 2>/dev/null && fail 'M7: the injected failure did not fail'
  S=$(hl_pending_set)
  : >"$S/UNITS_EXCLUDED"
  m7_rc=0
  (SCRIPT_DIR="$SCRATCH/no-templates" host_migrate_reconcile) 2>/dev/null || m7_rc=$?
  expect_eq 'M7: rc 3, nothing reversed (still moved), the journal kept' \
    "${m7_rc}:$(test -d "$R/opt/ficus-core" && echo moved):$(pending_state)" '3:moved:y'
  (host_migrate_reconcile) 2>/dev/null || fail 'M7: the reconcile with the templates died'
  expect_eq 'M7: the complete toolkit then reverses it' "$(host_layout_detect):$(pending_state)" '1:n'

  # --- T6a M5: the reverse record authorises one restore, not a later one -----------------
  hl_reset
  make_legacy_host
  (HL_FAIL_AT=12 host_migrate "$REL") 2>/dev/null || true
  S=$(hl_pending_set)
  host_migrate_reconcile 2>/dev/null
  expect_eq 'a restored set is marked RESTORED (no longer in effect: it never blocks a later reverse)' "$(test -e "$S/RESTORED" && echo restored)" 'restored'
  expect_eq 'M5: after the reconcile restored the set, no reverse record is left' \
    "${_HM_REVERSE_SET:-unset}:${_HM_REVERSE_DONE:-unset}" 'unset:unset'
  expect_eq 'M5: ...so a later _HM_REVERSED=1 restore of the same set in this process is refused' \
    "$( (_HM_REVERSED=1 host_migrate_backup_restore "$S") >/dev/null 2>&1 && echo restored || echo refused)" 'refused'

  # --- the manual reverse is journaled: killed half way, it is finished --------------------
  for hl_k in 10 5 restored; do
    hl_reset
    make_legacy_host
    pristine_full=$(snapshot)
    host_migrate "$REL" 2>/dev/null
    host_migrate_commit
    S=$(hl_last_set)
    (HL_KILL_IN_REVERSE=${hl_k} host_layout_reverse_committed "$S") 2>/dev/null && fail "manual reverse: the SIGKILL at ${hl_k} did not kill it"
    expect_eq "manual reverse killed at ${hl_k}: PENDING journals the set, marked REVERSING, not REVERSED" \
      "$(hl_pending_set):$(test -e "$S/hl/REVERSING" && echo reversing):$(test -e "$S/hl/REVERSED" && echo reversed || echo open)" \
      "$S:reversing:open"
    if [[ ${hl_k} == 5 ]]; then
      # resumed by running the manual reverse again (the one PENDING it accepts)
      (host_layout_reverse_committed "$S") 2>/dev/null || fail 'manual reverse: the resume died'
    else
      # finished by the next toolkit run's reconcile
      (host_migrate_reconcile) 2>/dev/null || fail "manual reverse: the reconcile after the kill at ${hl_k} died"
    fi
    expect_eq "manual reverse killed at ${hl_k}, then finished: layout 1, byte-identical, no journal" \
      "$(host_layout_detect):$([[ $(snapshot) == "${pristine_full}" ]] && echo same || echo differs):$(pending_state)" '1:same:n'
  done
  hl_reset
  make_legacy_host
  host_migrate "$REL" 2>/dev/null
  host_migrate_commit
  : >"$(host_migrate_backup_root)/PENDING"
  expect_match 'manual reverse: any other journal → refused' \
    "$( (host_layout_reverse_committed "$(hl_last_set)") 2>&1 && echo ran)" 'PENDING journals a run — reconcile it first'
  rm -f "$(host_migrate_backup_root)/PENDING"

  # --- a container database: the manual reverse needs the operator's acceptance -----------
  hl_reset
  make_legacy_host --db-mode container
  host_migrate "$REL" 2>/dev/null
  host_migrate_commit
  before=$(snapshot)
  expect_match 'manual reverse (container mode) without the acceptance: refused, naming --accept-database-revert' \
    "$( (host_layout_reverse_committed "$(hl_last_set)") 2>&1 && echo ran)" 'every database write since is lost.*--accept-database-revert'
  expect_eq '...changing nothing' "$([[ $(snapshot) == "${before}" ]] && echo same):$(host_layout_detect)" 'same:2'
  (HL_REVERSE_ACCEPT_DB_REVERT=1 host_layout_reverse_committed "$(hl_last_set)") 2>/dev/null || fail 'the accepted container-mode reverse died'
  expect_eq 'manual reverse (container mode) with the acceptance: layout 1 again' "$(host_layout_detect):$(pending_state)" '1:n'

  # --- Ruling 82 I1: the manual reverse never silently reverts a file changed since the commit --
  hl_reset
  make_legacy_host
  host_migrate "$REL" 2>/dev/null
  host_migrate_commit
  S=$(hl_last_set)
  expect_eq 'I1: the commit journals the live state of every file the set holds' \
    "$(wc -l <"$S/hl/LIVE_SHAS" | tr -d ' '):$(grep -Ec "^[0-9a-f]{64}	$R$HL_LEGACY_ETC/managed.env\$" "$S/hl/LIVE_SHAS")" \
    "$(grep -vc '^#' "$S/MANIFEST"):1"
  ln -sfn "$R/opt/ficus-core/releases/c0-legacy" "$R/opt/ficus-core/current"
  printf 'SES=synced-after-the-move\n' >"$R/etc/ficus/managed.env" # the artifact sync, after the commit
  before=$(snapshot)
  : >"$R/calls.log"
  i1_out=$( (host_layout_reverse_committed "$S") 2>&1 && echo ran) || true
  expect_match 'I1: a drifted managed.env → refused, naming it and --accept-file-revert' "$i1_out" \
    "changed since the migration committed.*$R$HL_LEGACY_ETC/managed.env.*--accept-file-revert"
  expect_eq 'I1: ...changing nothing (no journal, units untouched, still layout 2)' \
    "$([[ $(snapshot) == "$before" ]] && echo same):$(pending_state):$(grep -c 'systemctl stop' "$R/calls.log" || true):$(host_layout_detect)" 'same:n:0:2'
  (HL_REVERSE_ACCEPT_FILE_REVERT=1 host_layout_reverse_committed "$S") 2>"$SCRATCH/hl-i1.log" || fail 'I1: the accepted reverse died'
  expect_eq 'I1: with --accept-file-revert: reversed, the file back at its pre-move bytes' \
    "$(host_layout_detect):$(pending_state):$(cat "$R$HL_LEGACY_ETC/managed.env")" '1:n:SES=1'
  expect_match 'I1: ...and the reverted file is named in the log' "$(cat "$SCRATCH/hl-i1.log")" "reverting files changed since the migration \\(accepted\\): $R$HL_LEGACY_ETC/managed.env"
  # a newer set of ANOTHER migration still in effect blocks the reverse outright
  host_migration_hlnext_needed() { [[ -f $1/NEEDS_HLNEXT ]] && ! grep -qx 'HLNEXT=1' "${SRC_DEST}/.env"; }
  host_migration_hlnext_apply() { printf 'HLNEXT=1\n' >>"${SRC_DEST}/.env"; }
  HOST_MIGRATIONS=(host_layout hlnext)
  hl_reset
  make_legacy_host
  host_migrate "$REL" 2>/dev/null
  host_migrate_commit
  S=$(hl_last_set)
  : >"$REL/NEEDS_HLNEXT"
  sleep 1 # a later set (the set dir name carries the second)
  host_migrate "$REL" 2>/dev/null
  host_migrate_commit
  ln -sfn "$R/opt/ficus-core/releases/c0-legacy" "$R/opt/ficus-core/current"
  before=$(snapshot)
  i1_out=$( (HL_REVERSE_ACCEPT_FILE_REVERT=1 host_layout_reverse_committed "$S") 2>&1 && echo ran) || true
  expect_match 'I1: a newer committed set of another migration → refused, naming it (even with --accept-file-revert)' "$i1_out" \
    'a newer host migration is still in effect over .*\(hlnext\)'
  expect_eq 'I1: ...changing nothing' "$([[ $(snapshot) == "$before" ]] && echo same):$(pending_state):$(host_layout_detect)" 'same:n:2'
  # once that newer set was restored (no longer in effect), it no longer blocks
  : >"$(hl_last_set)/RESTORED"
  (HL_REVERSE_ACCEPT_FILE_REVERT=1 host_layout_reverse_committed "$S") 2>/dev/null || fail 'I1: the reverse past a restored newer set died'
  expect_eq 'I1: a restored newer set does not block' "$(host_layout_detect)" '1'
  HOST_MIGRATIONS=(host_layout)
  unset -f host_migration_hlnext_needed host_migration_hlnext_apply

  # --- Ruling 82 I2: the reverse is journaled BEFORE the services stop -----------------------
  hl_reset
  make_legacy_host
  host_migrate "$REL" 2>/dev/null
  host_migrate_commit
  S=$(hl_last_set)
  ln -sfn "$R/opt/ficus-core/releases/c0-legacy" "$R/opt/ficus-core/current"
  : >"$R/calls.log"
  (STUB_KILL_ON_STOP=1 host_layout_reverse_committed "$S") 2>/dev/null && fail 'I2: the SIGKILL at the first stop did not kill it'
  expect_eq 'I2: killed at its first stop: already journaled (PENDING, REVERSING)' \
    "$(hl_pending_set):$(test -e "$S/hl/REVERSING" && echo reversing)" "$S:reversing"
  (host_migrate_reconcile) 2>/dev/null || fail 'I2: the reconcile after the kill died'
  expect_eq 'I2: ...the next run finishes it: layout 1, no journal, the legacy units started' \
    "$(host_layout_detect):$(pending_state):$(grep -c "systemctl start ${LEG_API} ${LEG_WORKER}" "$R/calls.log")" '1:n:1'

  # --- T9 review M1: rebase-home refused (the target already in the data) — its inverse never runs --
  hl_reset
  make_legacy_host
  before=$(snapshot)
  (STUB_BUN_RC=3 host_migrate "$REL") 2>"$SCRATCH/hl-m1.log" && fail 'M1: a refused rebase did not fail the migration'
  expect_match 'M1: S7b says why and how to force it' "$(cat "$SCRATCH/hl-m1.log")" 'already holds paths under .*FICUS_REBASE_HOME_FORCE=1'
  expect_eq 'M1: the refusal is journaled' "$(test -e "$(hl_pending_set)/hl/REBASE_REFUSED" && echo refused)" 'refused'
  : >"$R/calls.log"
  (host_migrate_reconcile) 2>/dev/null || fail 'M1: the reconcile died'
  expect_eq 'M1: reversed byte-identical, and S7b⁻¹ did not rebase anything back' \
    "$([[ $(snapshot) == "$before" ]] && echo same):$(grep -c 'rebase-home.js' "$R/calls.log" || true):$(pending_state)" 'same:0:n'
  hl_reset
  make_legacy_host
  (FICUS_REBASE_HOME_FORCE=1 host_migrate "$REL") 2>/dev/null || fail 'M1: the forced migration died'
  expect_match 'M1: FICUS_REBASE_HOME_FORCE=1 passes --force' "$(grep rebase-home "$R/calls.log")" "rebase-home.js --from .* --to .* --force"
  host_migrate_commit
  # the manual reverse checks the way back first (a dry run) and refuses when it would merge
  ln -sfn "$R/opt/ficus-core/releases/c0-legacy" "$R/opt/ficus-core/current"
  before=$(snapshot)
  m1_out=$( (STUB_BUN_DRY_OUT=$'REBASE_HOME messages.metadata=2\nREBASE_HOME_TARGET messages.metadata=1' \
    host_layout_reverse_committed "$(hl_last_set)") 2>&1 && echo ran) || true
  expect_match 'M1: the manual reverse refuses when rebasing back would merge (dry run)' "$m1_out" 'paths under both .*FICUS_REBASE_HOME_FORCE=1.*nothing was changed'
  expect_eq 'M1: ...changing nothing' "$([[ $(snapshot) == "$before" ]] && echo same):$(pending_state):$(host_layout_detect)" 'same:n:2'

  # --- Ruling 82: S12 and its inverse keep the release dirs' mtimes (artifact_retention ranks by them) --
  hl_reset
  make_legacy_host
  touch -m -d '2026-01-01 00:00:05' "$R$HL_LEGACY_DEST/releases/b0-older"
  touch -m -d '2026-01-01 00:00:09' "$R$HL_LEGACY_DEST/releases/c0-legacy"
  mt_before=$(stat -c %Y "$R$HL_LEGACY_DEST/releases/b0-older" "$R$HL_LEGACY_DEST/releases/c0-legacy" | tr '\n' ' ')
  (HL_FAIL_AT=13 host_migrate "$REL") 2>/dev/null || true
  expect_eq 'S12 keeps the release dir mtimes' \
    "$(stat -c %Y "$R/opt/ficus-core/releases/b0-older" "$R/opt/ficus-core/releases/c0-legacy" | tr '\n' ' ')" "$mt_before"
  (host_migrate_reconcile) 2>/dev/null || fail 'S12 mtime: the reconcile died'
  expect_eq 'S12⁻¹ keeps them too' \
    "$(stat -c %Y "$R$HL_LEGACY_DEST/releases/b0-older" "$R$HL_LEGACY_DEST/releases/c0-legacy" | tr '\n' ' ')" "$mt_before"
fi

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
