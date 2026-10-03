#!/usr/bin/env bash
# Canonical host identity, admission and rollback after retiring one-shot migrations.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
R=$(mktemp -d)
trap 'rm -rf "$R"' EXIT
export FICUS_HOST_ROOT=$R FICUS_SYSTEMD_UNIT_DIR=$R/etc/systemd/system
export HOST_MIGRATE_BACKUP_ROOT=$R/backups
source "$SCRIPT_DIR/lib.sh"
PASS=0 FAIL=0
check() { if "$@"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n' "$*" >&2; fi; }
check test "$HL_DEST" = "$R/opt/ficus-core"
check test "$HL_UNIT_API:$HL_UNIT_WORKER" = 'ficus-api:ficus-worker'
check test "${#HOST_MIGRATIONS[@]}" = 0
check test "$(host_migrate_needed "$R/release")" = ''
check test "$(host_layout_detect)" = fresh
mkdir -p "$FICUS_SYSTEMD_UNIT_DIR" "$R/release"
printf '[Service]\n' >"$FICUS_SYSTEMD_UNIT_DIR/ficus-api.service"
check test "$(host_layout_detect)" = 2
if declare -F host_migration_host_layout_apply >/dev/null; then FAIL=$((FAIL+1)); else PASS=$((PASS+1)); fi
check test "$(host_layout_sudoers_content svc)" = 'svc ALL=(root) NOPASSWD: /usr/bin/systemctl restart ficus-api, /usr/bin/systemctl restart ficus-worker'
printf '{"hostLayout":2}\n' >"$R/release/artifact.json"
check require_host_layout_ready "$R/release"
printf '{"hostLayout":1}\n' >"$R/release/artifact.json"
if (require_host_layout_ready "$R/release") >/dev/null 2>&1; then FAIL=$((FAIL+1)); else PASS=$((PASS+1)); fi
printf '{"hostLayout":2}\n' >"$R/release/artifact.json"
SRC_DEST=$R/release
printf 'DATABASE_URL=postgres://localhost/db\n' >"$SRC_DEST/.env"
check require_host_layout_ready "$R/release"
rm "$SRC_DEST/artifact.json"
if (require_host_layout_ready) >/dev/null 2>&1; then FAIL=$((FAIL+1)); else PASS=$((PASS+1)); fi
unset SRC_DEST
# Stop-world rollback must precede restoring a pending generic journal.
TRACE=$R/trace
as_root() { printf '%s\n' "$*" >>"$TRACE"; }
host_migrate_restore_pending() { printf '%s\n' restore >>"$TRACE"; }
check host_layout_rollback_hook
check test "$(cat "$TRACE")" = $'systemctl stop ficus-api ficus-worker\nrestore'
# Ordinary migration protocol still refuses unknown pending journals rather than discarding them.
mkdir -p "$HOST_MIGRATE_BACKUP_ROOT/set"
printf '%s\tunknown\t%s\n' "$HOST_MIGRATE_BACKUP_ROOT/set" "$R/release" >"$HOST_MIGRATE_BACKUP_ROOT/PENDING"
if (host_migrate_reconcile) >/dev/null 2>&1; then FAIL=$((FAIL+1)); else PASS=$((PASS+1)); fi
check test -f "$HOST_MIGRATE_BACKUP_ROOT/PENDING"
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
