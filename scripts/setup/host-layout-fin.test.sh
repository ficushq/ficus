#!/usr/bin/env bash
# Isolated filesystem/systemd-model proof; real systemd rehearsal is a ship gate.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ $(uname -s) == Linux ]] || { echo 'host-layout-fin: skipped (requires Linux filesystem tools)'; exit 0; }
SCRATCH=$(mktemp -d)
trap 'rm -rf -- "$SCRATCH"' EXIT
export FICUS_HOST_ROOT="$SCRATCH/host" FICUS_SYSTEMD_UNIT_DIR="$SCRATCH/host/etc/systemd/system"
export HOST_MIGRATE_BACKUP_ROOT="$SCRATCH/backups" FIN_STATE="$SCRATCH/state"
source "$SCRIPT_DIR/lib.sh"
HOST_MIGRATIONS=(host_layout_fin)
_hm_is_root() { return 0; }
mkdir -p "$SCRATCH/bin"
cat >"$SCRATCH/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
set -eu
normalize() { case $1 in *.service|*.timer) printf '%s' "$1";; *) printf '%s.service' "$1";; esac; }
cmd=$1; shift
case $cmd in
show) unit=${@: -1}; cat "$FIN_STATE/$(normalize "$unit")";;
is-enabled)
 unit=$(normalize "$1")
 for link in "$FICUS_SYSTEMD_UNIT_DIR"/*.wants/"$unit" "$FICUS_SYSTEMD_UNIT_DIR"/*; do
  [[ -L $link ]] || continue
  [[ $(readlink "$link") != "$FICUS_SYSTEMD_UNIT_DIR/$unit" ]] || { echo enabled; exit 0; }
 done
 echo disabled; exit 1;;
start|stop)
 for unit in "$@"; do
  [[ $cmd != start || ${FIN_FAIL_START:-} != "$(normalize "$unit")" ]] || exit 1
  if [[ $cmd == start ]]; then echo active; else echo inactive; fi >"$FIN_STATE/$(normalize "$unit")"
 done;;
reenable) "$0" disable "$@"; "$0" enable "$@";;
disable)
 for unit in "$@"; do
  unit=$(normalize "$unit")
  for link in "$FICUS_SYSTEMD_UNIT_DIR"/* "$FICUS_SYSTEMD_UNIT_DIR"/*.wants/*; do
   [[ -L $link ]] || continue
   target=$(readlink "$link")
   [[ $target != "$FICUS_SYSTEMD_UNIT_DIR/$unit" && $target != "$unit" ]] || rm "$link"
  done
 done;;
enable)
 for unit in "$@"; do
  unit=$(normalize "$unit")
  while read -r key val; do
   case $key in
    Alias) ln -sfn "$FICUS_SYSTEMD_UNIT_DIR/$unit" "$FICUS_SYSTEMD_UNIT_DIR/$val";;
    WantedBy) mkdir -p "$FICUS_SYSTEMD_UNIT_DIR/$val.wants"; ln -sfn "$FICUS_SYSTEMD_UNIT_DIR/$unit" "$FICUS_SYSTEMD_UNIT_DIR/$val.wants/$unit";;
   esac
  done < <(awk '/^\[/{install=($0=="[Install]")} install&&/^(Alias|WantedBy)=/{sub(/=/," ");print}' "$FICUS_SYSTEMD_UNIT_DIR/$unit")
 done;;
daemon-reload|reset-failed) :;;
*) exit 1;;
esac
STUB
printf '#!/bin/bash\nexit 1\n' >"$SCRATCH/bin/docker"
printf '#!/bin/bash\nexit 0\n' >"$SCRATCH/bin/visudo"
chmod +x "$SCRATCH/bin/"*
export PATH="$SCRATCH/bin:$PATH"
PASS=0
check() { [[ $1 == "$2" ]] || { echo "FAIL: $3 ($1 != $2)" >&2; exit 1; }; PASS=$((PASS+1)); }
fixture() {
 rm -rf "$FICUS_HOST_ROOT" "$HOST_MIGRATE_BACKUP_ROOT" "$FIN_STATE"
 mkdir -p "$FICUS_SYSTEMD_UNIT_DIR" "$FIN_STATE" "$HOST_MIGRATE_BACKUP_ROOT"
 host_layout_resolve 2
 SRC_DEST=$HL_DEST RUN_USER=root DB_MODE=external BUN_BIN=/usr/local/bin/bun CORE_LAYOUT=artifact
 CFG_FILE=$HL_CFG
 mkdir -p "$SRC_DEST/releases/bridge" "$SRC_DEST/releases/final" "$HL_ETC" "$HL_SETUP_DIR" "$FICUS_HOST_ROOT/root/.ficus" "${HL_BACKUP_SCRIPT%/*}" "${HL_SUDOERS%/*}"
 printf '{"hostLayout":2}\n' >"$SRC_DEST/releases/bridge/artifact.json"
 printf '{"hostLayout":2}\n' >"$SRC_DEST/releases/final/artifact.json"
 printf 'HOME_DIR=%s/root/.ficus\n' "$FICUS_HOST_ROOT" >"$SRC_DEST/.env"
 ln -s "$SRC_DEST/releases/bridge" "$SRC_DEST/current"
 printf 'config\n' >"$HL_CFG"
 printf 'marker\n' >"$SRC_DEST/releases/bridge/$HL_NEW_RELEASE_MARKER"
 cp "$SRC_DEST/releases/bridge/$HL_NEW_RELEASE_MARKER" "$SRC_DEST/releases/bridge/$HL_LEGACY_RELEASE_MARKER"
 printf 'backup\n' >"$HL_BACKUP_SCRIPT"
 host_layout_sudoers_content svc >"$HL_SUDOERS"; chmod 0440 "$HL_SUDOERS"
 install_core_units "$SCRIPT_DIR/systemd"
 for ext in service timer; do
  render_backup_unit_content "$SCRIPT_DIR/systemd/ficus-backup.$ext.tmpl" "$HL_BACKUP_SCRIPT" '*-*-* 03:15:00' external >"$FICUS_SYSTEMD_UNIT_DIR/$HL_UNIT_BACKUP.$ext"
 done
 for unit in "$HL_UNIT_API.service" "$HL_UNIT_WORKER.service" "$HL_UNIT_BACKUP.timer"; do echo active >"$FIN_STATE/$unit"; done
 echo inactive >"$FIN_STATE/$HL_UNIT_BACKUP.service"
 systemctl enable "$HL_UNIT_API.service" "$HL_UNIT_WORKER.service" "$HL_UNIT_BACKUP.service" "$HL_UNIT_BACKUP.timer"
 local from to
 while IFS=$'\t' read -r from to; do mkdir -p "${from%/*}"; ln -s "$to" "$from"; done < <(_hfin_links)
 HOST_MIGRATE_PENDING=0 HOST_MIGRATE_BACKUP_SET='' HOST_MIGRATE_NAMES='' HOST_MIGRATE_RELEASE=''
 unset _HM_REVERSE_SET _HM_REVERSE_DONE _HM_REVERSE_RUNNING _HM_IN_REVERSE _HM_REVERSED
}
assert_bridge() {
 local from to
 while IFS=$'\t' read -r from to; do check "$(readlink "$from")" "$to" 'inverse restores exact links'; done < <(_hfin_links)
 check "$(grep '^Alias=' "$FICUS_SYSTEMD_UNIT_DIR/$HL_UNIT_API.service")" "Alias=$HL_LEGACY_UNIT_PREFIX-api.service" 'inverse restores Alias bytes'
 check "$(cat "$FIN_STATE/$HL_UNIT_API.service")" active 'API active after inverse'
 check "$(cat "$FIN_STATE/$HL_UNIT_WORKER.service")" active 'worker active after inverse'
 check "$(test -e "$HOST_MIGRATE_BACKUP_ROOT/PENDING" && echo pending || echo clear)" clear 'journal cleared only after inverse'
}
fixture
marker_mtime=$(stat -c %y "$SRC_DEST/releases/bridge")
check "$(host_migration_host_layout_fin_needed "$SRC_DEST/releases/final" && echo yes)" yes 'finalize needed'
cp "$HL_SUDOERS" "$SCRATCH/sudoers.before"
cp "$FICUS_SYSTEMD_UNIT_DIR/$HL_UNIT_API.service" "$SCRATCH/api.before"
host_migrate "$SRC_DEST/releases/final"
setdir=$HOST_MIGRATE_BACKUP_SET
check "$(test -e "$FICUS_HOST_ROOT$HL_LEGACY_DEST" && echo exists || echo gone)" gone 'exact install link removed'
check "$(grep -c '^Alias=' "$FICUS_SYSTEMD_UNIT_DIR/$HL_UNIT_API.service" || :)" 0 'aliases absent'
check "$(grep -c "$HL_LEGACY_UNIT_PREFIX" "$HL_SUDOERS" || :)" 0 'sudoers canonical'
check "$(test -e "$SRC_DEST/releases/bridge/$HL_LEGACY_RELEASE_MARKER" && echo exists || echo gone)" gone 'old marker removed'
check "$(head -1 "$setdir/MANIFEST")" $'#requires-reverse\thost_layout_fin' 'inverse required by framework'
host_migrate_reconcile
assert_bridge
cmp "$HL_SUDOERS" "$SCRATCH/sudoers.before"; PASS=$((PASS+1))
cmp "$FICUS_SYSTEMD_UNIT_DIR/$HL_UNIT_API.service" "$SCRATCH/api.before"; PASS=$((PASS+1))
check "$(stat -c %y "$SRC_DEST/releases/bridge")" "$marker_mtime" 'release retention mtime restored'
check "$(readlink "$FICUS_SYSTEMD_UNIT_DIR/$HL_LEGACY_UNIT_PREFIX-backup.service")" "$FICUS_SYSTEMD_UNIT_DIR/$HL_UNIT_BACKUP.service" 'backup alias restored'


for point in links units markers done; do
 fixture
 (HL_FIN_KILL_AT=$point host_migrate "$SRC_DEST/releases/final") >/dev/null 2>&1 && { echo 'expected killed forward'; exit 1; }
 host_migrate_reconcile
 assert_bridge
 done
for point in reverse-links reverse-extra reverse-files; do
 fixture
 host_migrate "$SRC_DEST/releases/final"
 setdir=$HOST_MIGRATE_BACKUP_SET
 (HL_FIN_KILL_AT=$point host_migrate_reconcile) >/dev/null 2>&1 && { echo 'expected killed reverse'; exit 1; }
 # Model a reboot that restarted both services while reverse was interrupted.
 echo active >"$FIN_STATE/$HL_UNIT_API.service"; echo active >"$FIN_STATE/$HL_UNIT_WORKER.service"
 host_migrate_reconcile
 assert_bridge
 done
fixture
host_migrate "$SRC_DEST/releases/final"
setdir=$HOST_MIGRATE_BACKUP_SET
ln -sfn "$SRC_DEST/releases/final" "$SRC_DEST/current"
host_migrate_reconcile
check "$(test -e "$HOST_MIGRATE_BACKUP_ROOT/PENDING" && echo pending || echo clear)" clear 'active candidate finishes forward'
check "$(host_migration_host_layout_fin_needed "$SRC_DEST/releases/final" && echo needed || echo current)" current 'finalize is idempotent'

cp "$HL_SUDOERS" "$SCRATCH/sudoers.final"
printf '# external change\n' >>"$HL_SUDOERS"
(host_layout_fin_reverse_committed "$setdir") >"$SCRATCH/drift.log" 2>&1 && exit 1
grep -q 'files changed' "$SCRATCH/drift.log"; PASS=$((PASS+1))
cp "$SCRATCH/sudoers.final" "$HL_SUDOERS"
(HL_FIN_KILL_AT=reverse-files host_layout_fin_reverse_committed "$setdir") >/dev/null 2>&1 && exit 1
bash "$SCRIPT_DIR/upgrade-host.sh" --reverse-host-layout "$setdir" >"$SCRATCH/manual.out" 2>"$SCRATCH/manual.log"
grep -q '^FICUS_HOST_LAYOUT=2$' "$SCRATCH/manual.out"; PASS=$((PASS+1))
assert_bridge
fixture
rm "$FICUS_HOST_ROOT$HL_LEGACY_ETC"
ln -s /srv/foreign "$FICUS_HOST_ROOT$HL_LEGACY_ETC"
host_migrate "$SRC_DEST/releases/final" 2>"$SCRATCH/foreign.log"
check "$(readlink "$FICUS_HOST_ROOT$HL_LEGACY_ETC")" /srv/foreign 'foreign link preserved'
grep -q 'not the migration' "$SCRATCH/foreign.log"; PASS=$((PASS+1))
host_migrate_reconcile
check "$(readlink "$FICUS_HOST_ROOT$HL_LEGACY_ETC")" /srv/foreign 'foreign link preserved by inverse'
fixture
rm "$FICUS_SYSTEMD_UNIT_DIR/$HL_UNIT_API.service"
(require_host_layout_ready) 2>"$SCRATCH/guard.log" && exit 1
grep -q ficus-host-layout-bridge "$SCRATCH/guard.log"; PASS=$((PASS+1))
fixture
mkdir "$SCRATCH/old-release"
(require_host_layout_ready "$SCRATCH/old-release") 2>"$SCRATCH/guard.log" && exit 1
PASS=$((PASS+1))
fixture
(FIN_FAIL_START="$HL_UNIT_WORKER.service" host_migrate "$SRC_DEST/releases/final") >/dev/null 2>&1 && exit 1
check "$(test -e "$HOST_MIGRATE_BACKUP_ROOT/PENDING" && echo pending || echo clear)" pending 'runtime failure retains journal'
host_migrate_reconcile
assert_bridge
# An in-flight backup must finish before any finalize host mutation.
fixture
echo active >"$FIN_STATE/$HL_UNIT_BACKUP.service"
(host_migrate "$SRC_DEST/releases/final") >/dev/null 2>&1 && exit 1
setdir=$(_hm_pending_set)
check "$([[ -e $setdir/fin/PLANNED ]] && echo planned || echo absent)" absent 'busy backup cannot publish a mutation plan'
check "$(cat "$FIN_STATE/$HL_UNIT_BACKUP.timer")" active 'busy backup refusal leaves timer active'
check "$(cat "$FIN_STATE/$HL_UNIT_API.service")" active 'busy backup refusal leaves API active'
host_migrate_reconcile
check "$(cat "$FIN_STATE/$HL_UNIT_BACKUP.service")" active 'unplanned inverse leaves ongoing backup alone'
# Planning refusals must precede stops or unjournaled unit creation.
fixture
rm "$FICUS_SYSTEMD_UNIT_DIR/$HL_UNIT_WORKER.service"
(host_migrate "$SRC_DEST/releases/final") >/dev/null 2>&1 && exit 1
check "$(cat "$FIN_STATE/$HL_UNIT_API.service")" active 'missing worker refuses before stopping API'
host_migrate_reconcile
check "$([[ -e $FICUS_SYSTEMD_UNIT_DIR/$HL_UNIT_WORKER.service ]] && echo exists || echo absent)" absent 'missing worker remains absent after reconciliation'
fixture
(ARTIFACT_CONVERTED_THIS_RUN=1 host_migrate "$SRC_DEST/releases/final") >/dev/null 2>&1 && exit 1
check "$(cat "$FIN_STATE/$HL_UNIT_API.service")" active 'excluded units refuse before host mutation'
check "$(readlink "$FICUS_HOST_ROOT$HL_LEGACY_ETC")" "$HL_ETC" 'excluded units retain links'
fixture
printf 'HOME_DIR=\n' >"$SRC_DEST/.env"
check "$(_hfin_links | tail -1)" "$FICUS_HOST_ROOT/root/$HL_LEGACY_HOME_NAME"$'\t'"$FICUS_HOST_ROOT/root/$HL_NEW_HOME_NAME" 'default account home is fixture-rooted'
printf 'HOME_DIR=~/.ficus\n' >"$SRC_DEST/.env"
check "$(_hfin_links | tail -1)" "$FICUS_HOST_ROOT/root/$HL_LEGACY_HOME_NAME"$'\t'"$FICUS_HOST_ROOT/root/$HL_NEW_HOME_NAME" 'tilde account home is fixture-rooted'
(managed_user_home() { return 1; }; host_migrate_needed "$SRC_DEST/releases/final") >"$SCRATCH/home.log" 2>&1 && exit 1
grep -q 'could not inventory HOME_DIR' "$SCRATCH/home.log"; PASS=$((PASS+1))
check "$([[ -e $HOST_MIGRATE_BACKUP_ROOT/PENDING ]] && echo pending || echo absent)" absent 'failed HOME inventory cannot silently skip migration'
fixture
rm "$HL_SUDOERS"
host_migrate "$SRC_DEST/releases/final"
check "$([[ -e $HL_SUDOERS ]] && echo exists || echo absent)" absent 'no sudoers stays absent forward'
host_migrate_reconcile
assert_bridge
check "$([[ -e $HL_SUDOERS ]] && echo exists || echo absent)" absent 'no sudoers stays absent inverse'
# Drift after planning must not delete or overwrite an operator replacement.
fixture
(HL_FIN_FAIL_AT=planned host_migrate "$SRC_DEST/releases/final") >/dev/null 2>&1 && exit 1
setdir=$(_hm_pending_set)
rm "$FICUS_HOST_ROOT$HL_LEGACY_ETC"; ln -s /srv/foreign "$FICUS_HOST_ROOT$HL_LEGACY_ETC"
(HOST_MIGRATE_BACKUP_SET=$setdir host_migration_host_layout_fin_apply "$SRC_DEST/releases/final") >/dev/null 2>&1 && exit 1
check "$(readlink "$FICUS_HOST_ROOT$HL_LEGACY_ETC")" /srv/foreign 'forward preserves foreign replacement after planning'
(host_migrate_reconcile) >/dev/null 2>&1 && exit 1
check "$(readlink "$FICUS_HOST_ROOT$HL_LEGACY_ETC")" /srv/foreign 'inverse preserves foreign replacement'
check "$([[ -e $HOST_MIGRATE_BACKUP_ROOT/PENDING ]] && echo pending || echo absent)" pending 'foreign replacement keeps recovery pending'
rm "$FICUS_HOST_ROOT$HL_LEGACY_ETC"
host_migrate_reconcile
assert_bridge
fixture
(_hfin_live_shas() { return 1; }; host_migrate "$SRC_DEST/releases/final") >/dev/null 2>&1 && exit 1
setdir=$(_hm_pending_set)
check "$([[ -e $setdir/fin/DONE ]] && echo done || echo absent)" absent 'failed digest inventory cannot publish DONE'
host_migrate_reconcile
assert_bridge
# Protect the last committed inverse, even with five newer unrelated backups.
fixture
host_migrate "$SRC_DEST/releases/final"
setdir=$HOST_MIGRATE_BACKUP_SET
ln -sfn "$SRC_DEST/releases/final" "$SRC_DEST/current"
host_migrate_reconcile
for n in 1 2 3 4 5 6 7; do mkdir "$HOST_MIGRATE_BACKUP_ROOT/9999010${n}T000000Z-ABCDEF"; done
host_migrate_backup_prune
check "$([[ -d $setdir ]] && echo retained || echo missing)" retained 'latest committed finalize survives pruning'
# A failed restart after byte restoration still needs its PENDING journal.
fixture
host_migrate "$SRC_DEST/releases/final"
setdir=$HOST_MIGRATE_BACKUP_SET
(FIN_FAIL_START="$HL_UNIT_WORKER.service" host_migrate_reconcile) >/dev/null 2>&1 && exit 1
check "$([[ -e $setdir/RESTORED ]] && echo restored || echo absent)" restored 'byte restore precedes attempted runtime restart'
check "$([[ -e $setdir/fin/REVERSED ]] && echo reversed || echo absent)" absent 'runtime failure cannot commit inverse'
check "$([[ -e $HOST_MIGRATE_BACKUP_ROOT/PENDING ]] && echo pending || echo absent)" pending 'partial inverse restart keeps journal'
for n in 1 2 3 4 5 6 7; do mkdir "$HOST_MIGRATE_BACKUP_ROOT/9999010${n}T000000Z-ABCDEF"; done
host_migrate_backup_prune
check "$([[ -d $setdir ]] && echo retained || echo missing)" retained 'pending partial inverse survives pruning despite RESTORED'
host_migrate_reconcile
assert_bridge

# Real systemd offline proof complements the runtime model: aliases exist only
# under [Install], and reenable removes the alias of a now-static service.
offline="$SCRATCH/offline"
mkdir -p "$offline/etc/systemd/system"
printf '[Service]\nType=oneshot\nExecStart=/bin/true\n[Install]\nAlias=old-fixture.service\n' >"$offline/etc/systemd/system/ficus-fixture.service"
/usr/bin/systemctl --root "$offline" enable ficus-fixture.service >/dev/null 2>&1
check "$(readlink "$offline/etc/systemd/system/old-fixture.service")" /etc/systemd/system/ficus-fixture.service 'real systemd installs alias'
printf '[Service]\nType=oneshot\nExecStart=/bin/true\n' >"$offline/etc/systemd/system/ficus-fixture.service"
/usr/bin/systemctl --root "$offline" reenable ficus-fixture.service >/dev/null 2>&1
check "$([[ -L $offline/etc/systemd/system/old-fixture.service ]] && echo alias || echo absent)" absent 'real systemd drops alias from static service'
printf 'host-layout-fin: %s passed, 0 failed\n' "$PASS"
