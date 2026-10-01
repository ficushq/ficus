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
 local HL_BRIDGE_ALIASES=1 # Fixture is the bridge release; normal rendering stays finalized.
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
# A different bridge must not bypass owned-sudoers validation.
fixture
printf '# unexpected local grant\n' >>"$HL_SUDOERS"
if (host_migrate_needed "$SRC_DEST/releases/final") >"$SCRATCH/early-sudoers.log" 2>&1; then
 echo 'FAIL: an existing compatibility link bypassed sudoers validation' >&2; exit 1
fi
PASS=$((PASS+1))
check "$([[ -e $HOST_MIGRATE_BACKUP_ROOT/PENDING ]] && echo pending || echo absent)" absent 'unknown sudoers plus links refuses before journal'
fixture
host_migration_host_layout_fin_needed "$SRC_DEST/releases/final"
printf '# drift after inventory\n' >>"$HL_SUDOERS"
if (_hfin_plan "$SCRATCH/rejected-plan" "$SRC_DEST/releases/final") >"$SCRATCH/plan-sudoers.log" 2>&1; then
 echo 'FAIL: planning accepted sudoers drift after inventory' >&2; exit 1
fi
PASS=$((PASS+1))
check "$([[ -e $SCRATCH/rejected-plan/PLANNED ]] && echo planned || echo absent)" absent 'sudoers drift cannot publish mutation plan'
# A readable environment without HOME_DIR defaults; failed reads never do.
fixture
printf 'OTHER_KEY=value\n' >"$SRC_DEST/.env"
check "$(_hfin_links | tail -1)" "$FICUS_HOST_ROOT/root/$HL_LEGACY_HOME_NAME"$'\t'"$FICUS_HOST_ROOT/root/$HL_NEW_HOME_NAME" 'absent HOME_DIR defaults from readable env'
rm "$SRC_DEST/.env"
if (host_migrate_needed "$SRC_DEST/releases/final") >"$SCRATCH/missing-env.log" 2>&1; then
 echo 'FAIL: missing environment was treated as default HOME_DIR' >&2; exit 1
fi
PASS=$((PASS+1))
check "$([[ -e $HOST_MIGRATE_BACKUP_ROOT/PENDING ]] && echo pending || echo absent)" absent 'missing env refuses before journal publication'
fixture
printf 'PRIVATE_VALUE=fin-secret-do-not-log\n' >>"$SRC_DEST/.env"
if (cat() { [[ $* != "-- $SRC_DEST/.env" ]] || return 1; command cat "$@"; }; host_migrate_needed "$SRC_DEST/releases/final") >"$SCRATCH/unreadable-env.log" 2>&1; then
 echo 'FAIL: failed environment read was treated as default HOME_DIR' >&2; exit 1
fi
PASS=$((PASS+1))
grep -q 'fin-secret-do-not-log' "$SCRATCH/unreadable-env.log" && exit 1
PASS=$((PASS+1))
check "$([[ -e $HOST_MIGRATE_BACKUP_ROOT/PENDING ]] && echo pending || echo absent)" absent 'unreadable env refuses before journal publication'
# Partially finalized hosts must still schedule cleanup of owned remnants.
without_links_or_aliases() {
 local from to unit
 while IFS=$'\t' read -r from to; do rm "$from"; done < <(_hfin_links)
 for unit in "$HL_UNIT_API.service" "$HL_UNIT_WORKER.service" "$HL_UNIT_BACKUP.service" "$HL_UNIT_BACKUP.timer"; do
  sed -i '/^Alias=/d' "$FICUS_SYSTEMD_UNIT_DIR/$unit"
  systemctl reenable "$unit"
 done
}
fixture
without_links_or_aliases
HL_BRIDGE_ALIASES=0 host_layout_sudoers_content svc >"$HL_SUDOERS"
check "$(host_migration_host_layout_fin_needed "$SRC_DEST/releases/final" && echo needed || echo current)" needed 'legacy marker alone still needs finalize'
host_migrate "$SRC_DEST/releases/final"
check "$([[ -e $SRC_DEST/releases/bridge/$HL_LEGACY_RELEASE_MARKER ]] && echo old || echo absent)" absent 'marker-only finalize removes old marker'
host_migrate_reconcile
check "$(cat "$SRC_DEST/releases/bridge/$HL_LEGACY_RELEASE_MARKER")" marker 'marker-only inverse restores original'
fixture
without_links_or_aliases
rm "$SRC_DEST/releases/bridge/$HL_LEGACY_RELEASE_MARKER"
check "$(host_migration_host_layout_fin_needed "$SRC_DEST/releases/final" && echo needed || echo current)" needed 'owned legacy sudoers alone still needs finalize'
cp "$HL_SUDOERS" "$SCRATCH/sudoers-only.before"
host_migrate "$SRC_DEST/releases/final"
check "$(grep -c "$HL_LEGACY_UNIT_PREFIX" "$HL_SUDOERS" || :)" 0 'sudoers-only finalize removes legacy grant'
check "$(host_migration_host_layout_fin_needed "$SRC_DEST/releases/final" && echo needed || echo current)" current 'canonical-only result no longer needs finalize'
host_migrate_reconcile
cmp "$HL_SUDOERS" "$SCRATCH/sudoers-only.before"; PASS=$((PASS+1))
printf '# altered owned rule\n' >>"$HL_SUDOERS"
if (host_migrate_needed "$SRC_DEST/releases/final") >"$SCRATCH/foreign-sudoers.log" 2>&1; then
 echo 'FAIL: unrecognized legacy sudoers was silently treated as finalized' >&2; exit 1
fi
PASS=$((PASS+1))
check "$([[ -e $HOST_MIGRATE_BACKUP_ROOT/PENDING ]] && echo pending || echo absent)" absent 'unrecognized legacy sudoers refuses before mutation'
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
# A leftover bridge build stamp is journaled and reversed with the markers.
fixture
stamp="$SRC_DEST/$HL_NEW_BUILD_STAMP"
{
 printf 'FICUS_BUILD_COMMIT=%040d\n' 1
 for field in LOCK_HASH HASH_CORE_INDEX HASH_CORE_WORKER HASH_CORE_MIGRATE HASH_CLI_FICUS; do printf 'FICUS_BUILD_%s=%064d\n' "$field" 2; done
 printf 'FICUS_BUILD_AT=2026-10-01T00:00:00Z\n'
} >"$stamp"
cp -p "$stamp" "$SRC_DEST/$HL_LEGACY_BUILD_STAMP"
cp -p "$SRC_DEST/$HL_LEGACY_BUILD_STAMP" "$SCRATCH/old-build-stamp"
build_stamp_clear "$SRC_DEST"
check "$(cmp -s "$SRC_DEST/$HL_LEGACY_BUILD_STAMP" "$SCRATCH/old-build-stamp" && echo retained)" retained 'build invalidation retains old stamp before journal'
# Exercise the actual writer with a new commit and real output hashes.
git -C "$SRC_DEST" init -q
git -C "$SRC_DEST" -c user.name=Fixture -c user.email=fixture@example.invalid commit -q --allow-empty -m fixture
mkdir -p "$SRC_DEST/apps/core/dist" "$SRC_DEST/apps/cli/dist"
for file in bun.lock apps/core/dist/index.js apps/core/dist/worker.js apps/core/dist/migrate.js apps/cli/dist/ficus.js; do printf fixture >"$SRC_DEST/$file"; done
build_stamp_write "$SRC_DEST" false
check "$(cmp -s "$stamp" "$SCRATCH/old-build-stamp" && echo same || echo newer)" newer 'normal writer refreshes canonical stamp independently'
stamp_sha=$(sha256sum "$stamp")
host_migrate "$SRC_DEST/releases/final"
check "$([[ -e $SRC_DEST/$HL_LEGACY_BUILD_STAMP ]] && echo legacy || echo absent)" absent 'finalize removes known generated legacy build stamp'
check "$(sha256sum "$stamp")" "$stamp_sha" 'canonical build stamp unchanged'
host_migrate_reconcile
check "$(cmp -s "$SCRATCH/old-build-stamp" "$SRC_DEST/$HL_LEGACY_BUILD_STAMP" && echo restored)" restored 'inverse restores exact old stamp'
for foreign in 'foreign bytes' 'FICUS_BUILD_COMMIT=bad'; do
 fixture
 printf '%s\n' "$foreign" >"$SRC_DEST/$HL_LEGACY_BUILD_STAMP"
 cp "$SRC_DEST/$HL_LEGACY_BUILD_STAMP" "$SRC_DEST/$HL_NEW_BUILD_STAMP"
 if (require_host_layout_ready) >/dev/null 2>&1; then echo 'FAIL foreign stamp accepted by early readiness'; exit 1; fi
 check "$([[ -e $HOST_MIGRATE_BACKUP_ROOT/PENDING ]] && echo pending || echo absent)" absent 'foreign stamp readiness refuses before journal'
 if (host_migrate "$SRC_DEST/releases/final") >/dev/null 2>&1; then echo 'FAIL foreign stamp accepted'; exit 1; fi
 check "$(cat "$SRC_DEST/$HL_LEGACY_BUILD_STAMP")" "$foreign" 'unrecognized stamp preserved'
 check "$(readlink "$FICUS_HOST_ROOT$HL_LEGACY_DEST")" "$SRC_DEST" 'foreign stamp refuses before link mutation'
done

# Retention must not make a later committed inverse impossible. Missing
# destinations and foreign/corrupt metadata refuse before stops or pruning.
fixture
host_migrate "$SRC_DEST/releases/final"
setdir=$HOST_MIGRATE_BACKUP_SET
ln -sfn "$SRC_DEST/releases/final" "$SRC_DEST/current"
host_migrate_commit
mv "$SRC_DEST/releases/bridge" "$SCRATCH/pruned-fixture-release"
if (host_layout_fin_reverse_committed "$setdir") >"$SCRATCH/pruned-inverse.log" 2>&1; then echo 'FAIL inverse accepted missing release parent'; exit 1; fi
grep -q 'nothing was stopped or changed' "$SCRATCH/pruned-inverse.log"
check "$(cat "$FIN_STATE/$HL_UNIT_API.service")" active 'missing release refuses before stopping API'
check "$([[ -e $HOST_MIGRATE_BACKUP_ROOT/PENDING ]] && echo pending || echo absent)" absent 'missing release refuses before inverse journal'
mv "$SCRATCH/pruned-fixture-release" "$SRC_DEST/releases/bridge"
cp "$setdir/fin/EXTRA/MANIFEST" "$SCRATCH/valid-extra-manifest"
for mutation in foreign malformed unterminated; do
 if [[ $mutation == foreign ]]; then
  sed "s|$SRC_DEST/releases/bridge/|$SCRATCH/|" "$SCRATCH/valid-extra-manifest" >"$setdir/fin/EXTRA/MANIFEST"
 elif [[ $mutation == unterminated ]]; then
  cp "$SCRATCH/valid-extra-manifest" "$setdir/fin/EXTRA/MANIFEST"
  printf 'invalid trailing record' >>"$setdir/fin/EXTRA/MANIFEST"
 else
  printf 'invalid record\n' >"$setdir/fin/EXTRA/MANIFEST"
 fi
 if (artifact_retention "$SRC_DEST") >/dev/null 2>&1; then echo "FAIL retention accepted $mutation metadata"; exit 1; fi
 check "$([[ -d $SRC_DEST/releases/bridge ]] && echo preserved)" preserved "retention $mutation refuses before pruning"
done
cp "$SCRATCH/valid-extra-manifest" "$setdir/fin/EXTRA/MANIFEST"
host_layout_fin_reverse_committed "$setdir"
assert_bridge

# Multiple finalize cycles retain the union of inverse inputs.
fixture
for name in old-a old-b old-c; do
 mkdir -p "$SRC_DEST/releases/$name"
 printf marker >"$SRC_DEST/releases/$name/$HL_NEW_RELEASE_MARKER"
 cp "$SRC_DEST/releases/$name/$HL_NEW_RELEASE_MARKER" "$SRC_DEST/releases/$name/$HL_LEGACY_RELEASE_MARKER"
 touch -d '2026-01-01' "$SRC_DEST/releases/$name"
done
host_migrate "$SRC_DEST/releases/final"
first=$HOST_MIGRATE_BACKUP_SET
ln -sfn "$SRC_DEST/releases/final" "$SRC_DEST/current"
host_migrate_commit
HL_BRIDGE_ALIASES=1 install_core_units "$SCRIPT_DIR/systemd"
mkdir -p "$SRC_DEST/releases/final2"
printf '{"hostLayout":2}\n' >"$SRC_DEST/releases/final2/artifact.json"
host_migrate "$SRC_DEST/releases/final2"
second=$HOST_MIGRATE_BACKUP_SET
ln -sfn "$SRC_DEST/releases/final2" "$SRC_DEST/current"
host_migrate_commit
for name in fresh-a fresh-b; do mkdir -p "$SRC_DEST/releases/$name"; touch -d '2030-01-01' "$SRC_DEST/releases/$name"; done
artifact_retention "$SRC_DEST"
check "$([[ -d $SRC_DEST/releases/old-a && -d $SRC_DEST/releases/old-b && -d $SRC_DEST/releases/old-c ]] && echo retained)" retained 'all unreversed finalize release parents retained'
check "$(host_layout_fin_latest_committed_set)" "$second" 'two finalize sets remain valid; newest inverse selected'
for n in 1 2 3 4 5 6 7; do mkdir "$HOST_MIGRATE_BACKUP_ROOT/9999010${n}T000000Z-ABCDEF"; done
host_migrate_backup_prune
check "$([[ -d $first && -d $second ]] && echo retained)" retained 'backup pruning keeps every unreversed finalize set'

# C-FIN readiness uses the real local Core operator journal schema.
fixture
check "${HL_BRIDGE_ALIASES}" 0 'normal default never recreates aliases'
check "${HOST_MIGRATIONS[*]}" host_layout_fin 'isolated finalizer fixture registry'
check "$(bash -c 'source "$1/lib.sh"; echo "${HOST_MIGRATIONS[*]}"' _ "$SCRIPT_DIR")" 'host_layout host_layout_fin' 'normal toolkit registers both retained migration and finalize'
readonly_before=$(sha256sum "$FICUS_SYSTEMD_UNIT_DIR/$HL_UNIT_API.service" "$SRC_DEST/.env")
journal_root="$FICUS_HOST_ROOT/var/backups/ficus-box-reprovision"
mkdir -p "$journal_root"; chmod 0700 "$journal_root"
journal="$journal_root/$(printf fixture | sha256sum | cut -d' ' -f1).json"
settled='{"version":1,"identity":"private-fixture-identity","done":true,"runtime":{"server":false,"socket":false,"proxy":false,"docker":false,"manager":false,"linger":false,"serverEnabled":false,"socketEnabled":false,"dockerEnabled":false}}'
printf '%s\n' "$settled" >"$journal"; chmod 0600 "$journal"
require_host_layout_ready "$SRC_DEST/releases/final"
PASS=$((PASS+1))
for bad in pending malformed concatenated version runtime temporary symlink mode; do
 printf '%s\n' "$settled" >"$journal"; chmod 0600 "$journal"
 case $bad in
  pending) sed -i 's/"done":true/"done":false/' "$journal";;
  malformed) printf '{' >"$journal";;
  concatenated) printf '%s\n%s\n' "${settled/true/false}" "$settled" >"$journal";;
  version) sed -i 's/"version":1/"version":2/' "$journal";;
  runtime) sed -i 's/"server":false/"server":"false"/' "$journal";;
  temporary) mv "$journal" "$journal.partial.tmp";;
  symlink) mv "$journal" "$SCRATCH/journal-target"; ln -s "$SCRATCH/journal-target" "$journal";;
  mode) chmod 0644 "$journal";;
 esac
 if (require_host_layout_ready "$SRC_DEST/releases/final") >"$SCRATCH/refusal.log" 2>&1; then echo "FAIL journal $bad"; exit 1; fi
 grep -q 'private-fixture-identity' "$SCRATCH/refusal.log" && exit 1
 check "$(sha256sum "$FICUS_SYSTEMD_UNIT_DIR/$HL_UNIT_API.service" "$SRC_DEST/.env")" "$readonly_before" "journal $bad refuses without changing units/env"
 rm -f "$journal" "$journal.partial.tmp" "$SCRATCH/journal-target"
done
printf '%s\n' "$settled" >"$journal"; chmod 0600 "$journal"
chmod 0755 "$journal_root"
if (require_host_layout_ready) >/dev/null 2>&1; then echo 'FAIL unsafe journal directory'; exit 1; fi
PASS=$((PASS+1))
rm -rf "$journal_root"

# Actual entrypoint: unfinished operator work refuses before reconciliation,
# Caddy, runtime preparation, download or unit changes. Guards remain in place.
cat >"$HL_CFG" <<YAML
source:
  mode: artifact
  dest: $SRC_DEST
core:
  origin: https://fixture.invalid
  run_user: root
database:
  mode: external
runtime:
  sandbox: host
backup:
  enabled: false
YAML
mkdir -p "$journal_root" "$FICUS_SYSTEMD_UNIT_DIR/ficus-api.service.d"
chmod 0700 "$journal_root"
printf '%s\n' "${settled/true/false}" >"$journal"; chmod 0600 "$journal"
printf 'guard-sentinel\n' >"$FICUS_SYSTEMD_UNIT_DIR/ficus-api.service.d/90-ficus-box-reprovision.conf"
if FICUS_ARTIFACT_TARBALL_URL=file:///unreachable FICUS_ARTIFACT_MANIFEST_URL=file:///unreachable FICUS_ARTIFACT_SIG_URL=file:///unreachable FICUS_ARTIFACT_PUBKEY_B64=fixture bash "$SCRIPT_DIR/upgrade-host.sh" --config "$HL_CFG" >"$SCRATCH/entrypoint.log" 2>&1; then echo 'FAIL entrypoint accepted pending journal'; exit 1; fi
grep -q 'unfinished or invalid box reprovision journal' "$SCRATCH/entrypoint.log"
check "$(cat "$FICUS_SYSTEMD_UNIT_DIR/ficus-api.service.d/90-ficus-box-reprovision.conf")" guard-sentinel 'refusal leaves maintenance guard unchanged'
check "$([[ -e $HOST_MIGRATE_BACKUP_ROOT/PENDING ]] && echo pending || echo absent)" absent 'refusal creates no migration journal'
rm -rf "$journal_root"
# Conversion refusal is also before an attempted artifact download.
mkdir -p "$SRC_DEST/.git"
if FICUS_ARTIFACT_TARBALL_URL=file:///unreachable FICUS_ARTIFACT_MANIFEST_URL=file:///unreachable FICUS_ARTIFACT_SIG_URL=file:///unreachable FICUS_ARTIFACT_PUBKEY_B64=fixture bash "$SCRIPT_DIR/upgrade-host.sh" --config "$HL_CFG" >"$SCRATCH/conversion.log" 2>&1; then echo 'FAIL conversion accepted'; exit 1; fi
grep -q 'cannot safely combine git-to-artifact conversion' "$SCRATCH/conversion.log"
check "$(readlink "$SRC_DEST/current")" "$SRC_DEST/releases/bridge" 'conversion refusal preserves active release'
check "$([[ -d $SRC_DEST/.git ]] && echo intact)" intact 'conversion refusal preserves checkout'
rm -rf "$SRC_DEST/.git"

# The setup hook runs before checkout -f on an existing canonical git host.
# Transport is a local bare repository; the target-reader and checkout logic
# are the actual toolkit functions, not a simulated guard.
origin="$SCRATCH/origin"; checkout="$SCRATCH/checkout"
git init -q "$origin"
git -C "$origin" config user.email fixture@example.invalid
git -C "$origin" config user.name fixture
printf '{"name":"ficus","ficusHostLayout":2}\n' >"$origin/package.json"
git -C "$origin" add package.json; git -C "$origin" commit -qm current
git -C "$origin" branch canonical
git -C "$origin" checkout -qb old-layout
printf '{"name":"ficus","ficusHostLayout":1}\n' >"$origin/package.json"
git -C "$origin" commit -qam earlier-layout
git clone -q --branch canonical "$origin" "$checkout"
printf 'preserved-data\n' >"$checkout/data"
head_before=$(git -C "$checkout" rev-parse HEAD)
if (
 eval "$(sed -n '/^setup_git_target_check() {/,/^}/p' "$SCRIPT_DIR/setup-host.sh")"
 git_env_setup() { GIT_CLEAN_URL=$origin GIT_AUTH_URL=$origin; }
 SRC_DEST=$checkout SRC_REPO=$origin SRC_MODE=git-https SRC_REF=old-layout
 GIT_PRE_CHECKOUT_HOOK=setup_git_target_check
 git_source_sync
) >"$SCRATCH/git-refusal.log" 2>&1; then echo 'FAIL setup precheckout accepted layout1'; exit 1; fi
grep -q ficus-host-layout-bridge "$SCRATCH/git-refusal.log"
check "$(git -C "$checkout" rev-parse HEAD)" "$head_before" 'setup target refusal keeps HEAD unchanged'
check "$(cat "$checkout/data")" preserved-data 'setup target refusal preserves untracked data'
check "$(grep -c 'GIT_PRE_CHECKOUT_HOOK=setup_git_target_check' "$SCRIPT_DIR/setup-host.sh")" 1 'setup wires actual precheckout hook'
# A valid target whose Caddy preparation fails must also keep checkout HEAD.
git -C "$origin" checkout -q canonical
printf '{"name":"ficus","ficusHostLayout":2,"fixture":2}\n' >"$origin/package.json"
git -C "$origin" commit -qam next-canonical
if (
 eval "$(sed -n '/^git_target_check() {/,/^}/p' "$SCRIPT_DIR/upgrade-host.sh")"
 git_env_setup() { GIT_CLEAN_URL=$origin GIT_AUTH_URL=$origin; }
 prepare_upgrade_host() { printf 'caddy-prepare-failed\n' >&2; exit 1; }
 SRC_DEST=$checkout SRC_REPO=$origin SRC_MODE=git-https SRC_REF=canonical
 GIT_PRE_CHECKOUT_HOOK=git_target_check
 git_source_sync
) >"$SCRATCH/caddy-refusal.log" 2>&1; then echo 'FAIL checkout ignored Caddy failure'; exit 1; fi
grep -q caddy-prepare-failed "$SCRATCH/caddy-refusal.log"
check "$(git -C "$checkout" rev-parse HEAD)" "$head_before" 'Caddy failure precedes checkout mutation'
printf 'host-layout-fin: %s passed, 0 failed\n' "$PASS"
