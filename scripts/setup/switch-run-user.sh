#!/usr/bin/env bash
# switch-run-user.sh — move the Ficus instance ON THIS HOST from running as
# root to running as an unprivileged service user (or back), in place.
#
#   switch-run-user.sh --config /root/ficus-setup/ficus-setup.yaml [--user ficus]
#   switch-run-user.sh --config /root/ficus-setup/ficus-setup.yaml --revert
#
# The plan is docs/plans/2026-10-26-hosted-non-root-audit.md, 2.2. A switch:
#   * creates the service user (ensure_run_user: system account, home
#     /home/<user> 0750, groups systemd-journal [, docker] [, ficus-bigbrain-client]);
#   * moves HOME_DIR to /home/<user>/.ficus with ONE rename(2) (never a copy),
#     rebases the stored paths in the database, points .env's HOME_DIR at it
#     and gives the tree to the user (chown -R --no-dereference; a revert gives
#     it back to root, since the operator entrypoints run only as HOME's owner);
#   * records core.run_user in the host config, so every later upgrade, pooler
#     toggle or artifact sync renders the same User=;
#   * gives the user group read on the file artifacts, its sudoers rules, the
#     pooler, managed BigBrain's read paths, the backup script's new HOME and
#     the units' User=, checks the stored paths (S4) while the services are
#     still stopped, then restarts with the shared health wait and checks
#     S1-S10 before it prints its trailer.
# Root keeps owning the code, config, units, sudoers, interpreters and .env
# (root 0600). --revert runs the same steps back to root.
#
# Every step is journaled before it runs ($(host_migrate_backup_root)/RUN_USER_SWITCH,
# with a byte-for-byte backup set of every file it rewrites). Any failure after
# the services stop rolls back: the HOME is moved back, the stored paths are
# rebased back, the files are restored from the set, and the services restart
# as they were. A run that dies without either (KILL, reboot) is settled from
# the journal by the next run of this script, and every other toolkit script
# refuses until it is (require_host_layout_ready).
#
# Nothing secret arrives on the command line or stdin: the direct DSN comes
# from <dest>/.env. Idempotent: on a host that is already where it was asked
# to go it only runs the success checks. The last line on stdout is
# `FICUS_RUN_USER=<user>` (`root` after a revert or a rolled-back failure).
#
# The run survives the session that started it. The work is done by a
# "worker": this script re-executed under setsid, in a session of its own,
# with stdin /dev/null and its output in files, under
# $(host_migrate_backup_root)/run-user-switch-runs/ (root 0700):
#   <run>.log  stderr: the progress, as it goes;
#   <run>.out  stdout: the FICUS_RUN_USER= trailer, then, written once the
#              worker has exited (whatever ended it but SIGKILL),
#              `FICUS_RUN_USER_SWITCH_EXIT=<exit code>`.
# The invocation the caller started stays attached to it: it prints where the
# files are, streams <run>.log to its stderr, waits, prints the trailer on
# stdout and exits with the worker's code. A caller that stays connected sees
# exactly what it saw before (stderr progress, the trailer last on stdout, the
# same exit codes). When the session ends (ssh dropped or killed: SIGHUP,
# SIGPIPE, the process group killed), only the attached invocation dies; the
# worker has no terminal and no pipe back to the caller, so it finishes the
# switch or its rollback and releases the host lock. INT or TERM sent to the
# attached invocation (Ctrl-C) is passed on to the worker as TERM: it rolls
# back as before, and the attached invocation exits with the worker's code
# once that is done. Once a rollback has started the worker ignores HUP, INT
# and TERM until it ends. The worker leaves the session, not the login's
# cgroup: a host whose systemd-logind kills a session's processes when it
# ends (KillUserProcesses=yes; Ubuntu and Debian default to no), or an
# operator who stops the session scope, still kills it — the next run then
# settles its journal. A caller that lost its session observes the result later:
# the run is over when <run>.out ends with FICUS_RUN_USER_SWITCH_EXIT (and
# $(host_migrate_backup_root)/.lock is free); a RUN_USER_SWITCH journal left
# behind means it was not settled, and the next run of this script settles it.
# Every run holds host_migrate_lock from start to end, so a second run (a
# retry) waits for the first to finish before it looks at the journal.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

usage() {
  cat <<'EOF'
Usage: switch-run-user.sh --config ficus-setup.yaml [--user NAME] [--revert]
Options:
  --config FILE   the config this host was set up with (core.run_user is recorded in it)
  --user NAME     the service user to switch to (default: ficus)
  --revert        switch back to root
EOF
}

ORIG_ARGS=("$@")
CONFIG='' TARGET_USER=ficus REVERT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG=${2:?--config needs a value}; shift 2 ;;
    --user) TARGET_USER=${2:?--user needs a value}; shift 2 ;;
    --revert) REVERT=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
[[ -n ${CONFIG} ]] || die '--config is required'
[[ -f ${CONFIG} ]] || die "config not found: ${CONFIG}"
[[ ${TARGET_USER} =~ ^[a-z_][a-z0-9_-]{0,31}$ && ${TARGET_USER} != root ]] ||
  die "--user must be a non-root login name (got '${TARGET_USER}')"

# ------------------------------------------------------------------ P1 (part)
[[ ${EUID} -eq 0 ]] || die 'switch-run-user.sh must run as root (it moves HOME_DIR and re-owns it)'

# ------------------------------------------------- detached from the session
#
# Starts the worker (see the header) and stays attached to it; never returns.
switch_attached_run() { # ARGS...
  local runs run log out worker tailer rc=0 f
  runs="$(host_migrate_backup_root)/run-user-switch-runs"
  mkdir -p -- "${runs}" && chmod 0700 "$(host_migrate_backup_root)" "${runs}" ||
    die "could not create ${runs} (root 0700) — nothing was changed"
  run="${runs}/$(date -u '+%Y%m%dT%H%M%SZ')-$$"
  log="${run}.log" out="${run}.out"
  (umask 077 && : >"${log}" && : >"${out}") || die "could not create ${log} — nothing was changed"
  # Keep the 20 newest runs.
  while IFS= read -r f; do rm -f -- "${f}" "${f%.log}.out"; done < <(ls -1t -- "${runs}"/*.log 2>/dev/null | tail -n +21)
  log_info "this run goes on if the session ends — progress: ${log}, result: ${out} (FICUS_RUN_USER_SWITCH_EXIT=<code> once it is over)"
  # The worker's own wrapper writes the exit line: the attached side may be
  # gone by then. It passes INT and TERM on to the run as TERM (the run is an
  # asynchronous child, started with INT ignored, so TERM is what it traps)
  # and waits until the run has exited, rollback included; a HUP sent to the
  # wrapper is caught and dropped (a caught signal is back to its default in
  # the run, which keeps its own HUP trap).
  FICUS_RUN_USER_SWITCH_WORKER=1 FICUS_RUN_USER_SWITCH_LOG=${log} FICUS_RUN_USER_SWITCH_OUT=${out} \
    setsid -w bash -c '
      run=""
      trap "[[ -n \${run} ]] && kill -TERM \${run} 2>/dev/null" INT TERM
      trap ":" HUP
      bash "$@" </dev/null >"${FICUS_RUN_USER_SWITCH_OUT}" 2>>"${FICUS_RUN_USER_SWITCH_LOG}" &
      run=$!
      while :; do
        wait "${run}" && rc=0 || rc=$?
        kill -0 "${run}" 2>/dev/null || break # a trapped signal interrupted wait: the run goes on
      done
      printf "FICUS_RUN_USER_SWITCH_EXIT=%s\n" "${rc}" >>"${FICUS_RUN_USER_SWITCH_OUT}"
      exit "${rc}"' ficus-switch-run-user "${SCRIPT_DIR}/$(basename -- "${BASH_SOURCE[0]}")" "$@" \
    </dev/null >/dev/null 2>&1 &
  worker=$!
  # A background job of a non-interactive shell is never a process-group
  # leader, so setsid does not fork: ${worker} is the worker's wrapper itself.
  trap 'kill -TERM "${worker}" 2>/dev/null || true' INT TERM
  tail -n +1 -s 0.2 -F --pid="${worker}" -- "${log}" >&2 2>/dev/null &
  tailer=$!
  while :; do
    wait "${worker}" && rc=0 || rc=$?
    # A trapped INT/TERM interrupts wait (> 128) while the worker goes on.
    kill -0 "${worker}" 2>/dev/null || break
  done
  wait "${tailer}" 2>/dev/null || true
  grep -v '^FICUS_RUN_USER_SWITCH_EXIT=' -- "${out}" || true
  exit "${rc}"
}
if [[ ${FICUS_RUN_USER_SWITCH_WORKER:-} != 1 ]]; then
  if have setsid; then switch_attached_run "${ORIG_ARGS[@]}"; fi
  log_warn 'setsid is not installed: this run does not survive the end of its session'
fi

# One run at a time, from here to the end: a second run (a retry) waits for
# the first to finish, and only then reads the config and the journal, which
# the first may still be rewriting (a rollback restores the config).
log_info "taking the host lock $(host_migrate_backup_root)/.lock (a run already holding it is waited for)"
host_migrate_lock

ensure_yq
cfg_load "${CONFIG}"
CFG_FILE=$(readlink -f -- "${CONFIG}")
# shellcheck disable=SC2034 # read by lib.sh's render_core_unit / core_unit_db_after
DB_MODE=$(cfg_get '.database.mode' 'container')
# shellcheck disable=SC2034 # read by lib.sh's render_core_unit
BUN_BIN=/usr/local/bin/bun
POOL_ENABLED=$(cfg_bool '.database.pool.enabled' false)
POOL_SIZE=$(cfg_get '.database.pool.size' 4)
POOL_RESERVE=$(cfg_get '.database.pool.reserve' 2)
CORE_PORT=$(cfg_get '.core.port' '3000')
[[ ${CORE_PORT} =~ ^[0-9]+$ ]] || die "config: core.port must be a number"
CONFIGURED_USER=$(cfg_get '.core.run_user' '')
SRC_DEST=$(cfg_source_dest)
ENV_FILE="${SRC_DEST}/.env"
TEMPLATES="${SCRIPT_DIR}/systemd"
for t in ficus-api.service.tmpl ficus-worker.service.tmpl ficus-pgbouncer.service.tmpl ficus-backup.sh.tmpl; do
  [[ -f ${TEMPLATES}/${t} || -f ${SCRIPT_DIR}/${t} ]] || die "missing toolkit template ${t} next to this script"
done
BACKUP_TEMPLATE="${SCRIPT_DIR}/ficus-backup.sh.tmpl"

if [[ ${REVERT} -eq 1 ]]; then GOAL=root; else GOAL=${TARGET_USER}; fi

# --------------------------------------------------------------- the journal
#
# $(host_migrate_backup_root)/RUN_USER_SWITCH, root 0600:
#   line 1  <set dir>\t<goal user>\t<from user>\t<old HOME>\t<new HOME>\t<release>
#   then    one line per step, written (and flushed) before the step runs.
# The set dir (under run-user-switch/, root 0700) holds a copy of every file
# the run rewrites (MANIFEST: <idx>\t<sha256>\t<path>) and ABSENT, the files
# it may create (the sudoers rules), which a rollback removes again.
SWITCH_DONE=0
switch_set_root() { printf '%s/run-user-switch' "$(host_migrate_backup_root)"; }

switch_journal_step() { # N
  printf '%s\n' "$1" >>"$(run_user_switch_journal)" || die "could not journal step $1"
  _hm_sync "$(run_user_switch_journal)" || die "could not flush the journal before step $1"
}

switch_last_step() {
  local last
  last=$(sed -n '2,$p' "$(run_user_switch_journal)" | tail -n 1)
  printf '%s' "${last:-0}"
}

switch_step_ran() { # N — was step N (or a later one) journaled?
  local s
  while IFS= read -r s; do
    [[ ${s} =~ ^[0-9]+$ ]] && ((s >= $1)) && return 0
  done < <(sed -n '2,$p' "$(run_user_switch_journal)")
  return 1
}

# The files this run may rewrite (or remove), and those it may create. The
# sudoers rules are in the set whenever they exist: a revert removes them, and
# a revert that then fails must put them back byte for byte (cp -p keeps 0440
# root); a forward switch over a rule already there restores that rule.
switch_files() {
  host_config_files
  local f
  for f in "${FICUS_PGBOUNCER_INI}" "${FICUS_PGBOUNCER_USERLIST}" "${FICUS_SYSTEMD_UNIT_DIR}/${HL_UNIT_POOLER}.service" \
    "${UPDATE_SUDOERS_FILE}" "${BIGBRAIN_SUDOERS}"; do
    [[ -f ${f} ]] && readlink -f -- "${f}"
  done
  true
}
switch_absent_files() {
  local f
  for f in "${UPDATE_SUDOERS_FILE}" "${BIGBRAIN_SUDOERS}"; do
    [[ -e ${f} || -L ${f} ]] || printf '%s\n' "${f}"
  done
}

switch_backup_create() { # -> prints the set dir
  local root setdir f idx=0 sha manifest='' absent=''
  root=$(switch_set_root)
  mkdir -p -- "${root}" && chmod 0700 "${root}" || die "could not create ${root} (root 0700)"
  setdir=$(umask 077 && mktemp -d "${root}/$(date -u '+%Y%m%dT%H%M%SZ')-XXXXXX") || die "could not create a backup set under ${root}"
  while IFS= read -r f; do
    [[ -n ${f} ]] || continue
    idx=$((idx + 1))
    cp -p -- "${f}" "${setdir}/${idx}" && cmp -s -- "${f}" "${setdir}/${idx}" ||
      { rm -rf -- "${setdir}"; die "could not copy ${f} into the backup set — nothing was changed"; }
    sha=$(_hm_sha256 "${setdir}/${idx}") || { rm -rf -- "${setdir}"; die "could not hash the copy of ${f}"; }
    manifest+="${idx}"$'\t'"${sha}"$'\t'"${f}"$'\n'
  done < <(switch_files)
  absent=$(switch_absent_files)
  printf '%s' "${manifest}" >"${setdir}/MANIFEST" && printf '%s\n' "${absent}" >"${setdir}/ABSENT" ||
    { rm -rf -- "${setdir}"; die "could not write the backup set's MANIFEST — nothing was changed"; }
  _hm_sync "${setdir}/MANIFEST" || { rm -rf -- "${setdir}"; die "could not flush the backup set"; }
  log_info "run-user switch backup set ${setdir}: ${idx} file(s), plaintext secrets included (root 0700)"
  printf '%s' "${setdir}"
}

# Put every file of the set back byte for byte (verified), and remove the
# files it recorded as absent. Returns 1 (having logged why) on any failure;
# never exits, so a rollback always reaches its restart.
switch_backup_restore() { # SETDIR
  local setdir=$1 idx sha path got rc=0 tmp
  while IFS=$'\t' read -r idx sha path; do
    [[ -n ${idx} ]] || continue
    # The temporary name has a dot: sudo never reads it from /etc/sudoers.d.
    tmp="${path}.ficus-restore.$$"
    if cp -p -- "${setdir}/${idx}" "${tmp}" && mv -f -- "${tmp}" "${path}"; then
      got=$(_hm_sha256 "${path}") || got=''
      [[ ${got} == "${sha}" ]] || { log_error "restored ${path} does not match its backup"; rc=1; }
    else
      rm -f -- "${tmp}"
      log_error "could not restore ${path} from ${setdir}/${idx}"
      rc=1
    fi
  done <"${setdir}/MANIFEST"
  while IFS= read -r path; do
    [[ -n ${path} ]] || continue
    rm -f -- "${path}" || { log_error "could not remove ${path}"; rc=1; }
  done <"${setdir}/ABSENT"
  return "${rc}"
}

# ------------------------------------------------------------------- helpers

# Move SRC to DST with one rename(2), never a copy: mv falls back to copying
# on EXDEV (a bind-mounted /home on the same device passes P4's st_dev test
# and still fails rename), which this switch must never do. perl is in
# perl-base, which Ubuntu and Debian always install.
rename_only() { # SRC DST
  perl -e 'rename($ARGV[0], $ARGV[1]) or die "rename $ARGV[0] -> $ARGV[1]: $!\n"' -- "$1" "$2"
}

# Run rebase-home.js from RELEASE with the direct DSN (the pooler may be
# stopped), printing its stdout. The env file it reads is a 0600 copy of .env
# in the set dir with DATABASE_URL replaced: the DSN never reaches argv.
switch_rebase() { # SETDIR RELEASE FROM TO [ARG...]
  local setdir=$1 release=$2 envcopy
  shift 2
  envcopy="${setdir}/rebase.env"
  (
    umask 077
    grep -v '^DATABASE_URL=' "${ENV_FILE}" >"${envcopy}" || true
    printf 'DATABASE_URL=%s\n' "$(envfile_direct_dsn "${ENV_FILE}")" >>"${envcopy}"
  ) || return 1
  (
    bun_path_prepend
    env FICUS_ROOT="${release}" bash -c "${_HL_REBASE_PROGRAM}" ficus-rebase-home "${envcopy}" "${release}" "$@"
  )
}

# The units' User= as systemd sees it.
unit_user() { as_root systemctl show -p User --value "$1" 2>/dev/null || true; }

# The HOME Core uses today: .env's HOME_DIR, else the layout default under the
# configured user's home.
current_home() {
  local home=''
  home=$(envfile_get "${ENV_FILE}" HOME_DIR 2>/dev/null || true)
  if [[ -z ${home} ]]; then
    home=$(home_dir_default "$(run_user_predicted_home "${CONFIGURED_USER:-root}")")
  fi
  printf '%s' "${home}"
}

# The HOME Core will use as USER: the layout's name under that user's home.
goal_home() { # USER
  local home
  if [[ $1 == root ]]; then home=$(run_user_predicted_home root); else home="/home/$1"; fi
  [[ -n ${home} ]] || die "could not resolve $1's home directory"
  printf '%s/%s' "${home}" "${HL_HOME_NAME}"
}

bigbrain_installed() { as_root test -e "${BIGBRAIN_ETC}/host.json"; }

# The commands `sudo -n -l` should list for USER on this host (1.6).
expected_sudo_commands() { # USER
  printf '/usr/bin/systemctl restart %s\n/usr/bin/systemctl restart %s\n' "${HL_UNIT_API}" "${HL_UNIT_WORKER}"
  if bigbrain_installed; then printf '%s ""\n' "${BIGBRAIN_HELPER}"; fi
}

# The commands `sudo -l` output lists, one per line: every `(runas) [TAGS:] cmd, cmd`
# entry line is split on ", ".
listed_sudo_commands() { # SUDO_L_OUTPUT
  local line cmds
  while IFS= read -r line; do
    [[ ${line} =~ ^[[:space:]]+\(([^\)]*)\)[[:space:]]+(.*)$ ]] || continue
    cmds=${BASH_REMATCH[2]}
    while [[ ${cmds} =~ ^[A-Z_]+:[[:space:]]* ]]; do cmds=${cmds#"${BASH_REMATCH[0]}"}; done
    printf '%s\n' "${cmds//, /$'\n'}"
  done <<<"$1"
}

# ------------------------------------------------------- the success checks

# S4: no STRUCTURED column (rebase-home's `REBASE_HOME` lines: kind text or
# jsonb-string, the value is a path Core opens) still holds a path under OLD.
# Free-text columns (message content, a work stream's file list) do not count:
# a live instance keeps writing mentions of the old HOME there (an agent
# quoting it), and they name no file. --structured-only leaves them out
# altogether: counting them scans every row of messages.metadata three times,
# which is what made this check take minutes on a busy instance; were one
# reported anyway, it is a `REBASE_HOME_TEXT` line, which the grep ignores.
switch_check_stored_paths() { # OLD NEW RELEASE
  local old=$1 new=$2 release=$3 out started=${SECONDS}
  if ! out=$(switch_rebase "${SWITCH_SET}" "${release}" "${old}" "${new}" --dry-run --structured-only 2>/dev/null); then
    log_error 'S4: rebase-home.js --dry-run failed'
    return 1
  fi
  if grep -Eq '^REBASE_HOME [^=]+=[1-9]' <<<"${out}" || ! grep -q '^REBASE_HOME ' <<<"${out}"; then
    log_error "S4: stored paths still name ${old}: [$(grep -E '^REBASE_HOME [^=]+=[1-9]' <<<"${out}" | tr '\n' ' ' || true)]"
    return 1
  fi
  log_info "S4: no stored path names ${old} ($((SECONDS - started)) s)"
}

# S1-S10 for GOAL. Prints each failure; returns 1 when any failed. S4 is
# skipped when the caller already ran it ("no-s4": the switch checks the
# database before it restarts the services).
switch_checks() { # GOAL OLD NEW RELEASE [no-s4]
  local goal=$1 old=$2 new=$3 release=$4 s4=${5:-} unit pid owner rc=0 out expected listed f pooler
  for unit in "${HL_UNIT_API}" "${HL_UNIT_WORKER}"; do
    [[ $(unit_user "${unit}") == "${goal}" ]] || { log_error "S1: ${unit} User= is '$(unit_user "${unit}")', not ${goal}"; rc=1; }
    pid=$(as_root systemctl show -p MainPID --value "${unit}" 2>/dev/null || true)
    owner=$(stat -c %U -- "/proc/${pid:-0}" 2>/dev/null || true) # the process's effective user
    [[ ${pid} =~ ^[1-9][0-9]*$ && ${owner} == "${goal}" ]] || { log_error "S1: ${unit} main process ${pid:-?} runs as '${owner}', not ${goal}"; rc=1; }
  done
  [[ ! -e ${old} && ! -L ${old} ]] || { log_error "S3: the old HOME ${old} still exists"; rc=1; }
  [[ -d ${new} ]] || { log_error "S3: the new HOME ${new} does not exist"; rc=1; }
  if [[ ${goal} != root ]]; then
    out=$(find "${new}" -xdev ! -user "${goal}" -print 2>&1 | head -n 5) || true
    [[ -z ${out} ]] || { log_error "S3: not everything under ${new} belongs to ${goal}: ${out}"; rc=1; }
  fi
  if [[ ${s4} != no-s4 ]]; then switch_check_stored_paths "${old}" "${new}" "${release}" || rc=1; fi
  if [[ ${goal} != root ]]; then
    # -q: no "-- No entries --" or permission hint, so only a real line counts.
    out=$(as_root runuser -u "${goal}" -- journalctl -q -u "${HL_UNIT_API}" -n 1 --no-pager 2>/dev/null || true)
    [[ -n ${out//[[:space:]]/} && ${out} != *'No journal files'* ]] || { log_error "S5: ${goal} cannot read the ${HL_UNIT_API} journal"; rc=1; }
    out=$(as_root runuser -u "${goal}" -- sudo -n -l 2>/dev/null || true)
    expected=$(expected_sudo_commands "${goal}" | sort)
    listed=$(listed_sudo_commands "${out}" | sort)
    [[ ${listed} == "${expected}" ]] || { log_error "S6: sudo -l for ${goal} lists [${listed//$'\n'/; }], expected [${expected//$'\n'/; }]"; rc=1; }
  fi
  if [[ ${POOL_ENABLED} == true ]]; then
    pooler=$(RUN_USER=${goal} pooler_user)
    [[ $(unit_user "${HL_UNIT_POOLER}") == "${pooler}" ]] || { log_error "S7: ${HL_UNIT_POOLER} does not run as ${pooler}"; rc=1; }
    bash -c "exec 3<>/dev/tcp/127.0.0.1/${FICUS_PGBOUNCER_PORT}" 2>/dev/null || { log_error "S7: nothing accepts on 127.0.0.1:${FICUS_PGBOUNCER_PORT}"; rc=1; }
  fi
  if [[ -f ${BACKUP_SCRIPT_PATH} ]]; then
    (backup_script_read_values "${BACKUP_SCRIPT_PATH}" && [[ ${LIVE_HOME_DIR} == "${new}" ]]) 2>/dev/null ||
      { log_error "S8: the backup script does not back up ${new}"; rc=1; }
  fi
  if [[ ${goal} != root ]]; then
    for f in "${FICUS_ARTIFACTS_DIR}"/* ${BIGBRAIN_ETC:+"${BIGBRAIN_ETC}/host.json"}; do
      [[ -f ${f} ]] || continue
      as_root runuser -u "${goal}" -- test -r "${f}" || { log_error "S9: ${goal} cannot read ${f}"; rc=1; }
    done
  fi
  [[ $(stat -c '%U %a' -- "${ENV_FILE}") == 'root 600' ]] || { log_error "S10: ${ENV_FILE} is not root 600"; rc=1; }
  out=$(find -L "${SRC_DEST}/current/" ! -perm -o+r -print 2>/dev/null | head -n 5) || true
  [[ -z ${out} ]] || { log_error "S10: not world-readable in the release: ${out}"; rc=1; }
  return "${rc}"
}

# ------------------------------------------------------------ the rollback

# Undo a journaled run, as far as its journal says it went: stop, rebase
# back, move HOME back (and give it back), restore every file, put the artifact groups back,
# re-render the pooler for the user the run started from, restart. Each step
# is attempted whatever the previous one did; a failure is logged and makes
# the rollback report failure, but never stops it.
#
# What it stops it always starts again, whatever step the journal reached:
# the core units (restart_core_services), the pooler (re-rendered when step
# 11 ran, else started as it is) BEFORE the core units, and the backup timer.
# It is idempotent: settling a journal whose rollback already ran (HOME and
# the stored paths back, the services up, only the checks failed) does every
# step again and finds nothing left to change.
#
# HUP, INT and TERM are ignored from here to the end of the run: a rollback
# that started always finishes.
switch_rollback() {
  trap '' HUP INT TERM
  local journal setdir goal from old new release header rc=0
  journal=$(run_user_switch_journal)
  IFS=$'\t' read -r setdir goal from old new release <"${journal}" || die "unreadable run-user switch journal ${journal}"
  SWITCH_SET=${setdir}
  RESULT_USER=${from}
  if ! switch_step_ran 3; then
    # Nothing but the service account (kept: it owns nothing that runs) changed yet.
    rm -f -- "${journal}" && rm -rf -- "${setdir}"
    log_info "the switch to ${goal} stopped before the services did: nothing to roll back"
    return 0
  fi
  log_step "rolling back the switch to ${goal}: back to ${from} (journal: step $(switch_last_step))"
  as_root systemctl stop "${HL_UNIT_API}" "${HL_UNIT_WORKER}" || { log_error 'could not stop the core units'; rc=1; }
  if [[ ${POOL_ENABLED} == true ]]; then as_root systemctl stop "${HL_UNIT_POOLER}" || true; fi
  if switch_step_ran 5; then
    # --force: every structured path under NEW is this run's (P6 found none
    # before it), and one still under OLD (S4 failed on it) belongs there, so
    # merging them back is the rollback; rebase-home would refuse otherwise.
    switch_rebase "${setdir}" "${release}" "${new}" "${old}" --force >&2 ||
      { log_error "could not rebase the stored paths back to ${old}"; rc=1; }
  fi
  if switch_step_ran 4 && [[ -d ${new} && ! -e ${old} ]]; then
    rename_only "${new}" "${old}" || { log_error "could not move ${new} back to ${old}"; rc=1; }
  fi
  if switch_step_ran 7 && [[ -d ${old} ]]; then
    as_root chown -R --no-dereference "${from}:$(run_user_group "${from}")" "${old}" ||
      { log_error "could not give ${old} back to ${from}"; rc=1; }
  fi
  switch_backup_restore "${setdir}" || rc=1
  # The config is the backup's again: re-read who the services run as.
  cfg_load "${CONFIG}"
  RUN_USER=${from}
  if switch_step_ran 9; then
    (switch_artifact_groups "${from}") || { log_error 'could not put the artifact groups back'; rc=1; }
  fi
  as_root systemctl daemon-reload || rc=1
  if [[ ${POOL_ENABLED} == true ]]; then
    # Stopped above whatever the journal says, so always brought back, before
    # the core units (pool_mode transaction: Core's DATABASE_URL goes through it).
    if switch_step_ran 11; then
      (install_pooler "$(envfile_direct_dsn "${ENV_FILE}")" "${POOL_SIZE}" "${POOL_RESERVE}" "${TEMPLATES}") ||
        { log_error "could not re-render ${HL_UNIT_POOLER} for ${from}"; rc=1; }
    else
      { as_root systemctl start "${HL_UNIT_POOLER}" &&
        retry_until 30 1 "pgbouncer listening on 127.0.0.1:${FICUS_PGBOUNCER_PORT}" \
          bash -c "exec 3<>/dev/tcp/127.0.0.1/${FICUS_PGBOUNCER_PORT}"; } ||
        { log_error "could not start ${HL_UNIT_POOLER} again"; rc=1; }
    fi
  fi
  (restart_core_services "${CORE_PORT}") || { log_error 'the core services did not come back up after the rollback'; rc=1; }
  if [[ -f ${FICUS_SYSTEMD_UNIT_DIR}/${HL_UNIT_BACKUP}.timer ]]; then as_root systemctl start "${HL_UNIT_BACKUP}.timer" || rc=1; fi
  # The host must pass the same checks for the user it went back to (S1-S10;
  # for a service user that includes its sudoers rules and journal access).
  if ((rc == 0)); then
    switch_checks "${from}" "${new}" "${old}" "${release}" ||
      { log_error "the host does not pass the success checks for ${from} after the rollback"; rc=1; }
  fi
  if ((rc != 0)); then
    log_error "the rollback did not complete — the journal ${journal} and the backup set ${setdir} are kept; fix the cause and re-run this script to settle it"
    return 1
  fi
  rm -f -- "${journal}" && rm -rf -- "${setdir}"
  log_info "rolled back: the services run as ${from} again"
}

# File artifacts (R7): group read for USER's group where the owner reads, or
# back to root's group.
switch_artifact_groups() { # USER
  local f group
  group=$(run_user_group "$1")
  [[ -d ${FICUS_ARTIFACTS_DIR} ]] || return 0
  for f in "${FICUS_ARTIFACTS_DIR}"/*; do
    [[ -f ${f} && ! -L ${f} ]] || continue
    as_root chgrp "${group}" "${f}"
    if [[ ${group} != root ]] && [[ $(stat -c '%a' -- "${f}") =~ ^[4-7] ]]; then as_root chmod g+r "${f}"; fi
  done
}

# --------------------------------------------------------- the switch itself

switch_run() { # GOAL FROM OLD NEW RELEASE
  local goal=$1 from=$2 old=$3 new=$4 release=$5 journal tmp
  journal=$(run_user_switch_journal)
  log_step "switch 1/17: back up every file this run rewrites"
  SWITCH_SET=$(switch_backup_create)
  tmp="${journal}.tmp.$$"
  (umask 077 && printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${SWITCH_SET}" "${goal}" "${from}" "${old}" "${new}" "${release}" >"${tmp}") &&
    _hm_sync "${tmp}" && mv -f -- "${tmp}" "${journal}" && _hm_sync "${journal}" ||
    { rm -f -- "${tmp}"; rm -rf -- "${SWITCH_SET}"; die 'could not write the run-user switch journal — nothing was changed'; }
  trap 'switch_on_exit $?' EXIT

  switch_journal_step 2
  log_step "switch 2/17: the service account"
  if [[ ${goal} != root ]]; then
    ensure_run_user "${goal}" "$(envfile_get "${ENV_FILE}" FICUS_SANDBOX_RUNTIME 2>/dev/null || true)" \
      "$(bigbrain_installed && echo true || echo false)"
  fi

  switch_journal_step 3
  log_step "switch 3/17: stop ${HL_UNIT_BACKUP}.timer, ${HL_UNIT_API}, ${HL_UNIT_WORKER}"
  as_root systemctl stop "${HL_UNIT_BACKUP}.timer" 2>/dev/null || true
  as_root systemctl stop "${HL_UNIT_API}" "${HL_UNIT_WORKER}"
  if [[ ${POOL_ENABLED} == true ]]; then as_root systemctl stop "${HL_UNIT_POOLER}"; fi

  switch_journal_step 4
  log_step "switch 4/17: move ${old} to ${new} (one rename)"
  if [[ -d ${new} && ! -L ${new} ]]; then rmdir -- "${new}" || die "${new} is not empty"; fi
  [[ -d $(dirname -- "${new}") ]] || die "$(dirname -- "${new}") does not exist"
  rename_only "${old}" "${new}" || die "could not move ${old} to ${new}"

  switch_journal_step 5
  log_step "switch 5/17: rebase the stored HOME paths"
  switch_rebase "${SWITCH_SET}" "${release}" "${old}" "${new}" >&2 || die "rebasing the stored paths from ${old} to ${new} failed"

  switch_journal_step 6
  log_step "switch 6/17: HOME_DIR=${new} in ${ENV_FILE}"
  envfile_set "${ENV_FILE}" HOME_DIR "${new}"

  switch_journal_step 7
  # The whole tree belongs to the account Core runs as: the operator
  # entrypoints run only as HOME's owner, so a revert gives it back to root too.
  log_step "switch 7/17: give ${new} to ${goal}"
  as_root chown -R --no-dereference "${goal}:$(run_user_group "${goal}")" "${new}"
  local d
  for d in "${new}/machines" "${new}/machines/keys" "${new}/machines/ctl"; do
    [[ -d ${d} ]] || as_root install -d -m 0700 -o "${goal}" -g "$(run_user_group "${goal}")" "${d}"
  done

  switch_journal_step 8
  log_step "switch 8/17: record core.run_user in ${CONFIG}"
  if [[ ${goal} == root ]]; then
    as_root yq -i '.core.run_user = ""' "${CONFIG}"
  else
    export GOAL_USER=${goal}
    as_root yq -i '.core.run_user = strenv(GOAL_USER)' "${CONFIG}"
  fi
  RUN_USER=${goal}

  switch_journal_step 9
  log_step "switch 9/17: file artifacts readable by ${goal}"
  switch_artifact_groups "${goal}"

  switch_journal_step 10
  log_step "switch 10/17: sudoers rules"
  if [[ ${goal} != root ]]; then
    install_sudoers_rule "${UPDATE_SUDOERS_FILE}" "$(host_layout_sudoers_content "${goal}")"
    if bigbrain_installed; then install_bigbrain_sudoers "${goal}"; fi
  else
    as_root rm -f -- "${UPDATE_SUDOERS_FILE}" "${BIGBRAIN_SUDOERS}"
  fi

  switch_journal_step 11
  if [[ ${POOL_ENABLED} == true ]]; then
    log_step "switch 11/17: ${HL_UNIT_POOLER} as $(pooler_user)"
    install_pooler "$(envfile_direct_dsn "${ENV_FILE}")" "${POOL_SIZE}" "${POOL_RESERVE}" "${TEMPLATES}"
  fi

  switch_journal_step 12
  if bigbrain_installed; then
    log_step 'switch 12/17: managed BigBrain grants'
    # The bigbrain_install that sets this host up: its sudoers rule was installed in step 10.
    bigbrain_install "${release}" "$(bigbrain_config_json)"
  fi

  switch_journal_step 13
  if [[ -f ${BACKUP_SCRIPT_PATH} ]]; then
    log_step "switch 13/17: the backup script backs up ${new}"
    backup_script_read_values "${BACKUP_SCRIPT_PATH}"
    install_rendered --check-placeholders 0755 root root "${BACKUP_SCRIPT_PATH}" \
      render_backup_script_content "${BACKUP_TEMPLATE}" "${LIVE_DEST}" "${new}" "${LIVE_DB_MODE}" "${LIVE_DB_CONTAINER}" \
      "${LIVE_S3_ENDPOINT}" "${LIVE_S3_REGION}" "${LIVE_S3_BUCKET}" "${LIVE_S3_PREFIX}" "${LIVE_BACKUP_ENV_FILE}"
  fi

  switch_journal_step 14
  log_step "switch 14/17: ${HL_UNIT_API}/${HL_UNIT_WORKER} with User=${goal}"
  install_core_units "${TEMPLATES}"
  ensure_managed_env_dropins
  ensure_api_memory_guardrail
  as_root systemctl daemon-reload

  switch_journal_step 15
  # S4 checks the database only: run it while nothing writes to it and
  # nothing competes with it (the services restart right after).
  log_step 'switch 15/17: no stored path names the old HOME (S4), restart and wait for health'
  switch_check_stored_paths "${old}" "${new}" "${release}" || die 'a success check failed (S4)'
  restart_core_services "${CORE_PORT}"
  if [[ -f ${FICUS_SYSTEMD_UNIT_DIR}/${HL_UNIT_BACKUP}.timer ]]; then as_root systemctl start "${HL_UNIT_BACKUP}.timer"; fi

  switch_journal_step 16
  log_step 'switch 16/17: success checks'
  switch_checks "${goal}" "${old}" "${new}" "${release}" no-s4 || die 'a success check failed'

  switch_journal_step 17
  log_step 'switch 17/17: done'
  rm -f -- "${journal}"
  rm -rf -- "${SWITCH_SET}"
  SWITCH_DONE=1
  RESULT_USER=${goal}
}

# Any exit with the journal still in place is a failure after it was written:
# roll back (the services were possibly stopped), then print the trailer for
# where the host ended up.
switch_on_exit() { # RC
  local rc=$1
  trap - EXIT
  trap '' HUP INT TERM
  if [[ ${SWITCH_DONE} -eq 0 && -e $(run_user_switch_journal) ]]; then
    log_error 'the switch failed — rolling back'
    # To the run's own stdout: a signal trap runs inside whatever redirection
    # the interrupted command had (switch_rebase ... >&2, $(...)).
    if switch_rollback; then printf 'FICUS_RUN_USER=%s\n' "${RESULT_USER}" >&"${SWITCH_STDOUT}"; fi
    exit "$((rc == 0 ? 1 : rc))"
  fi
  exit "${rc}"
}
# The run's stdout, for the trailer switch_on_exit prints.
exec {SWITCH_STDOUT}>&1
switch_signal_traps() {
  trap 'switch_on_exit 143' TERM
  trap 'switch_on_exit 129' HUP
  trap 'switch_on_exit 130' INT
}
switch_signal_traps

# ------------------------------------------------------------ main

UPDATE_SUDOERS_FILE=${HL_SUDOERS}
RESULT_USER=''
SWITCH_SET=''

# Settle a run that died without committing or rolling back. Step 17 means it
# had passed every check: finish it. Anything earlier: roll it back.
if [[ -e $(run_user_switch_journal) ]]; then
  if [[ $(switch_last_step) == 17 ]]; then
    IFS=$'\t' read -r SWITCH_SET _ _ _ _ _ <"$(run_user_switch_journal)"
    rm -f -- "$(run_user_switch_journal)" && rm -rf -- "${SWITCH_SET}"
    log_info 'settled an interrupted run-user switch that had passed its checks'
  else
    log_warn "an interrupted run-user switch is journaled in $(run_user_switch_journal) — rolling it back first"
    switch_rollback || die 'could not settle the interrupted run-user switch'
    switch_signal_traps # switch_rollback ignored them while it ran
  fi
  cfg_load "${CONFIG}"
  CONFIGURED_USER=$(cfg_get '.core.run_user' '')
fi

# P1: the layout and .env are this toolkit's, no host migration is journaled.
require_host_layout_ready
require_host_env_ready
[[ ! -e $(host_migrate_backup_root)/PENDING ]] ||
  die "a host migration is journaled in $(host_migrate_backup_root)/PENDING — run the tenant upgrade (it reconciles) first; nothing was changed"
[[ -f ${ENV_FILE} ]] || die "no rendered .env at ${ENV_FILE}"
# P2: the artifact layout, with a complete current release.
[[ -L ${SRC_DEST}/current ]] || die "${SRC_DEST}/current is not a release symlink — the switch supports the artifact layout only; nothing was changed"
RELEASE=$(readlink -f -- "${SRC_DEST}/current")
[[ -f ${RELEASE}/${HL_NEW_RELEASE_MARKER} && -f ${RELEASE}/apps/core/dist/rebase-home.js ]] ||
  die "${RELEASE} is not a complete release — nothing was changed"

FROM=${CONFIGURED_USER:-root}
API_USER=$(unit_user "${HL_UNIT_API}")
WORKER_USER=$(unit_user "${HL_UNIT_WORKER}")
OLD=$(current_home)
NEW=$(goal_home "${GOAL}")
SWITCH_SET=$(mktemp -d)
trap 'rm -rf -- "${SWITCH_SET}"' EXIT

# P3: either already there (only the checks run), or exactly where it starts.
if [[ ${FROM} == "${GOAL}" && ${API_USER} == "${GOAL}" && ${WORKER_USER} == "${GOAL}" ]]; then
  [[ ${OLD} == "${NEW}" ]] || die "core.run_user is already ${GOAL} but HOME_DIR is ${OLD}, not ${NEW} — inspect this host; nothing was changed"
  log_info "already running as ${GOAL}: running the success checks only"
  switch_checks "${GOAL}" "$(goal_home "$([[ ${GOAL} == root ]] && echo "${TARGET_USER}" || echo root)")" "${NEW}" "${RELEASE}" ||
    die 'a success check failed on a host that is already switched — inspect it; nothing was changed'
  printf 'FICUS_RUN_USER=%s\n' "${GOAL}"
  exit 0
fi
START=$([[ ${GOAL} == root ]] && echo "${TARGET_USER}" || echo root)
if [[ ${GOAL} == root ]]; then
  # A revert starts from any switched user: the configured one.
  [[ ${FROM} != root ]] || die 'core.run_user is root but the units are not — inspect this host; nothing was changed'
  START=${FROM}
fi
[[ ${FROM} == "${START}" && ${API_USER} == "${START}" && ${WORKER_USER} == "${START}" ]] ||
  die "refusing: core.run_user is '${CONFIGURED_USER}' and the units run as ${API_USER:-?}/${WORKER_USER:-?} — expected ${START} everywhere before switching to ${GOAL}; nothing was changed"

# P4: the old HOME exists, the new one is absent or empty, one filesystem.
[[ -d ${OLD} && ! -L ${OLD} ]] || die "the current HOME ${OLD} does not exist — nothing was changed"
if [[ -e ${NEW} || -L ${NEW} ]]; then
  [[ -d ${NEW} && ! -L ${NEW} && -z $(find "${NEW}" -mindepth 1 -maxdepth 1 -print -quit) ]] ||
    die "the new HOME ${NEW} already exists and is not an empty directory — nothing was changed"
fi
NEW_PARENT=$(dirname -- "${NEW}")
PARENT_PROBE=${NEW_PARENT}
[[ -d ${PARENT_PROBE} ]] || PARENT_PROBE=$(dirname -- "${PARENT_PROBE}")
# Same device AND same mount: a bind mount shares the device but rename(2)
# across it fails (EXDEV).
if [[ $(stat -c %d -- "$(dirname -- "${OLD}")") != "$(stat -c %d -- "${PARENT_PROBE}")" ||
  $(stat -c %m -- "$(dirname -- "${OLD}")") != "$(stat -c %m -- "${PARENT_PROBE}")" ]]; then
  die "refusing: ${OLD} and ${NEW_PARENT} are on different filesystems or mounts — this switch moves HOME with a single rename and never copies it; nothing was changed"
fi
# P5: no absolute symlink inside the old HOME that points into it.
LINKS=$(find "${OLD}" -type l -lname "${OLD}/*" -print 2>/dev/null | head -n 20)
[[ -z ${LINKS} ]] || die "refusing: symlinks inside ${OLD} point into it by absolute path and would dangle after the move:
${LINKS}
nothing was changed"
# P6: nothing is stored under the new HOME yet.
REBASE_OUT=$(switch_rebase "${SWITCH_SET}" "${RELEASE}" "${OLD}" "${NEW}" --dry-run) ||
  die "rebase-home.js --dry-run from ${OLD} to ${NEW} failed — nothing was changed"
! grep -Eq '^REBASE_HOME_TARGET [^=]+=[1-9]' <<<"${REBASE_OUT}" ||
  die "refusing: the database already stores paths under ${NEW}:
$(grep -E '^REBASE_HOME_TARGET [^=]+=[1-9]' <<<"${REBASE_OUT}")
(free-text mentions of that path, such as message text, are reported as REBASE_HOME_TARGET_TEXT and do not count)
nothing was changed"
# P7: no backup is running.
! as_root systemctl is-active --quiet "${HL_UNIT_BACKUP}.service" ||
  die "${HL_UNIT_BACKUP}.service is running — wait for it to finish; nothing was changed"
rm -rf -- "${SWITCH_SET}"
trap - EXIT

log_info "switching from ${START} to ${GOAL}: ${OLD} -> ${NEW}"
RUN_USER=${START}
switch_run "${GOAL}" "${START}" "${OLD}" "${NEW}" "${RELEASE}"
trap - EXIT
log_info "the services run as ${RESULT_USER}"
printf 'FICUS_RUN_USER=%s\n' "${RESULT_USER}"
