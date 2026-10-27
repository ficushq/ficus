#!/usr/bin/env bash
# switch-run-user.test.sh — switch-run-user.sh run for real, as a subprocess,
# against a fake host in a scratch directory (the shape of
# host-migrate-e2e.test.sh). The plan is
# docs/plans/2026-10-26-hosted-non-root-audit.md, 2.2.
#
# Real: the script, lib.sh, useradd/usermod/groupadd (a throwaway test
# account), the HOME rename and chown, the file artifacts, the sudoers files,
# the unit renders, the backup-script re-render, the journal and backup set,
# runuser/setpriv and every success-check probe of ownership and readability.
# Stand-ins (PATH shims in the scratch directory): systemctl (keeps unit state
# and starts each core "service" as a sleeping process under its unit's
# User=), curl (the /health probe), journalctl, sudo -l (lists the sudoers
# files under the fake host), visudo and bun (rebase-home.js over a fake
# database of stored paths).
#
# What is proven:
#   * a switch moves /root/.ficus to /home/<user>/.ficus with one rename, gives
#     it to the user, rebases the stored paths, records core.run_user,
#     re-renders the units, the backup script, the sudoers rule and the
#     artifact groups, restarts as the user and prints FICUS_RUN_USER=<user>;
#   * the preconditions refuse with nothing changed: a non-empty target HOME,
#     a symlink into the old HOME, stored paths already under the new HOME, a
#     running backup;
#   * re-running on a switched host only runs the checks;
#   * a failed health check after the restart rolls everything back (HOME,
#     stored paths, every file byte for byte, the sudoers rule removed) and
#     prints FICUS_RUN_USER=root, exit non-zero;
#   * a run killed mid-switch leaves its journal; every other toolkit entry
#     refuses while it exists, and the next run settles it;
#   * --revert goes back to root.
#
# Needs real root, GNU coreutils, util-linux (runuser, setpriv, flock), the
# shadow tools, jq and mikefarah yq. It creates (and deletes) the account
# ficus-srut and /root/.ficus, so it refuses to run where either exists and
# self-skips — loudly, without the ENABLED marker — without root. CI runs it as
# root; locally, run it in a throwaway container.
#
# Run: sudo bash scripts/setup/switch-run-user.test.sh   (SRU_VERBOSE=1 prints every run)
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)

PASS=0 FAIL=0
expect_eq() { # DESCRIPTION ACTUAL EXPECTED
  if [[ $2 == "$3" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected %q, got %q\n' "$1" "$3" "$2" >&2
  fi
}
expect_match() { # DESCRIPTION ACTUAL REGEX
  if [[ $2 =~ $3 ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — %q does not match /%s/\n' "$1" "$2" "$3" >&2
  fi
}
summary() {
  printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
  [[ ${FAIL} -eq 0 ]]
}

SVC=ficus-srut
skip_reason=''
[[ ${EUID} -eq 0 ]] || skip_reason='not running as root'
for cmd in jq yq runuser setpriv flock useradd usermod groupadd userdel sha256sum; do
  [[ -n ${skip_reason} ]] || command -v "${cmd}" >/dev/null 2>&1 || skip_reason="${cmd} is not on PATH"
done
if [[ -z ${skip_reason} ]]; then
  [[ $(yq --version 2>&1) == *mikefarah* ]] || skip_reason='mikefarah yq v4 is not on PATH'
  ! id -u "${SVC}" >/dev/null 2>&1 || skip_reason="the account ${SVC} already exists"
  [[ ! -e /root/.ficus ]] || skip_reason='/root/.ficus already exists'
fi
if [[ -n ${skip_reason} ]]; then
  printf 'SKIP: the run-user switch suite needs real root and a throwaway host (%s)\n' "${skip_reason}" >&2
  summary
  exit 0
fi
echo 'FICUS run-user switch section: ENABLED'

# Under /home, so the old HOME (/root/.ficus) and the new one are on one
# filesystem in a container or on a CI runner alike.
S=$(mktemp -d /home/.sru-test.XXXXXX)
chmod 0755 "${S}"
PIDS_DIR="${S}/state/pids"
cleanup() {
  local f
  for f in "${PIDS_DIR}"/*; do [[ -f ${f} ]] && kill -KILL "$(cat "${f}")" 2>/dev/null || true; done
  userdel -r "${SVC}" >/dev/null 2>&1 || true
  rm -rf /root/.ficus "/home/${SVC}" "${S}"
}
trap cleanup EXIT

H="${S}/host"            # FICUS_HOST_ROOT
DEST="${H}/opt/ficus-core"
UNITS="${H}/etc/systemd/system"
SHIMS="${S}/bin"
STATE="${S}/state"
mkdir -p "${DEST}/releases/r1/apps/core/dist" "${UNITS}" "${H}/etc/ficus/artifacts" "${H}/etc/sudoers.d" \
  "${H}/root/ficus-setup" "${SHIMS}" "${PIDS_DIR}" "${H}/var/backups"
chmod -R 0755 "${H}" "${SHIMS}"
chmod 0777 "${STATE}" "${PIDS_DIR}"

# ------------------------------------------------------------------ shims
cat >"${SHIMS}/systemctl" <<'EOF'
#!/usr/bin/env bash
# Unit state under $SRU_STATE: <unit>.active, pids/<unit>.
set -u
st=${SRU_STATE}
unit_user() { sed -n 's/^User=//p' "${FICUS_SYSTEMD_UNIT_DIR}/$1.service" 2>/dev/null | tail -n 1; }
start() {
  local u=$1 user
  stop "${u}"
  case ${u} in
    ficus-api | ficus-worker)
      user=$(unit_user "${u}")
      [[ -n ${user} ]] || return 1
      if [[ ${user} == root ]]; then
        setsid /bin/sleep 600 </dev/null >/dev/null 2>&1 9>&- &
      else
        setsid setpriv --reuid "${user}" --regid "$(id -g "${user}")" --init-groups /bin/sleep 600 </dev/null >/dev/null 2>&1 9>&- &
      fi
      echo $! >"${st}/pids/${u}"
      ;;
  esac
  : >"${st}/${u}.active"
}
stop() {
  local u=$1
  [[ -f ${st}/pids/${u} ]] && { kill -KILL "$(cat "${st}/pids/${u}")" 2>/dev/null || true; rm -f "${st}/pids/${u}"; }
  rm -f "${st}/${u}.active"
}
echo "systemctl $*" >>"${st}/systemctl.log"
cmd=$1; shift
case ${cmd} in
  show)
    prop=$2 unit=${4:-$3}
    case ${prop} in
      User) unit_user "${unit}" ;;
      MainPID) cat "${st}/pids/${unit}" 2>/dev/null || echo 0 ;;
      NRestarts) echo 0 ;;
    esac
    ;;
  is-active) [[ $1 == --quiet ]] && shift; [[ -e ${st}/$1.active || -e ${st}/$1.service.active ]] ;;
  restart | start) for u in "$@"; do start "${u}"; done ;;
  stop) for u in "$@"; do stop "${u}"; done ;;
  *) exit 0 ;;
esac
EOF
# /health: 401 while the api "runs", unless the test made it unhealthy for its user.
cat >"${SHIMS}/curl" <<'EOF'
#!/usr/bin/env bash
st=${SRU_STATE}
[[ -e ${st}/ficus-api.active ]] || exit 7
user=$(stat -c %U "/proc/$(cat "${st}/pids/ficus-api")" 2>/dev/null)
[[ -e ${st}/unhealthy-as-${user} ]] && { printf '502'; exit 0; }
printf '401'
EOF
cat >"${SHIMS}/journalctl" <<'EOF'
#!/usr/bin/env bash
echo 'Oct 27 00:00:00 host ficus-api[1]: listening'
EOF
cat >"${SHIMS}/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"${SHIMS}/visudo" <<'EOF'
#!/usr/bin/env bash
[[ $1 == -cf && -s $2 ]]
EOF
# `sudo -n -l` for USER: the sudoers files under the fake host (root-only, so
# the runuser shim answers it before it drops privileges, like setuid sudo).
cat >"${SHIMS}/sudo-list" <<'EOF'
#!/usr/bin/env bash
me=$1
echo "User ${me} may run the following commands on host:"
cat "${SRU_SUDOERS_DIR}"/* 2>/dev/null | while IFS= read -r line; do
  [[ ${line} == "${me} ALL="* ]] || continue
  printf '    %s\n' "${line#"${me} ALL="}"
done
EOF
# rebase-home.js over $SRU_STATE/db (one stored path per line).
cat >"${SHIMS}/bun" <<'EOF'
#!/usr/bin/env bash
[[ $1 == dist/rebase-home.js ]] || exit 99
shift
[[ -n ${DATABASE_URL:-} ]] || exit 2
from='' to='' dry=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --from) from=$2; shift 2 ;;
    --to) to=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) shift ;;
  esac
done
db=${SRU_STATE}/db
[[ -e ${SRU_STATE}/rebase-fails ]] && exit 1
moving=$(grep -c "^${from}/" "${db}" || true)
target=$(grep -c "^${to}/" "${db}" || true)
if [[ ${dry} -eq 1 ]]; then
  echo "REBASE_HOME sessions.path=${moving}"
  echo "REBASE_HOME_TARGET sessions.path=${target}"
  exit 0
fi
if ((moving > 0 && target > 0)); then echo "REBASE_HOME_TARGET sessions.path=${target}"; exit 3; fi
sed -i "s|^${from}/|${to}/|" "${db}"
echo "REBASE_HOME sessions.path=${moving}"
EOF
# runuser keeps the shims first on PATH for the probes it runs as the user.
cat >"${SHIMS}/runuser" <<EOF
#!/usr/bin/env bash
[[ \$1 == -u && \$3 == -- ]] || exec /usr/sbin/runuser "\$@"
[[ \$4 == sudo && \$5 == -n && \$6 == -l ]] && exec bash ${SHIMS}/sudo-list "\$2"
exec /usr/sbin/runuser -u "\$2" -- env "PATH=${SHIMS}:/usr/sbin:/usr/bin:/sbin:/bin" SRU_SUDOERS_DIR="${H}/etc/sudoers.d" "\${@:4}"
EOF
chmod 0755 "${SHIMS}"/*

export PATH="${SHIMS}:${PATH}"
export SRU_STATE="${STATE}" SRU_SUDOERS_DIR="${H}/etc/sudoers.d"
export FICUS_HOST_ROOT="${H}" FICUS_SYSTEMD_UNIT_DIR="${UNITS}"
export HOST_MIGRATE_BACKUP_ROOT="${H}/var/backups/ficus-host-migrate"
export BACKUP_SCRIPT_PATH="${H}/usr/local/sbin/ficus-backup.sh" BACKUP_ENV_TARGET="${H}/etc/ficus/backup.env"
export BIGBRAIN_ETC="${H}/etc/ficus/bigbrain" BIGBRAIN_SUDOERS="${H}/etc/sudoers.d/ficus-bigbrain"

# ---------------------------------------------------------------- the host
CFG="${H}/root/ficus-setup/ficus-setup.yaml"
OLD=/root/.ficus
NEW="/home/${SVC}/.ficus"
REL="${DEST}/releases/r1"
fresh_host() {
  local f
  for f in "${PIDS_DIR}"/*; do [[ -f ${f} ]] && kill -KILL "$(cat "${f}")" 2>/dev/null || true; done
  userdel -r "${SVC}" >/dev/null 2>&1 || true
  rm -rf "${OLD}" "/home/${SVC}" "${STATE:?}"/* "${HOST_MIGRATE_BACKUP_ROOT}" "${H}/etc/sudoers.d"/* "${UNITS:?}"/*
  mkdir -p "${PIDS_DIR}" "$(dirname "${BACKUP_SCRIPT_PATH}")"
  printf '{"hostLayout":2,"envPrefix":"FICUS"}\n' >"${REL}/artifact.json"
  : >"${REL}/.ficus-release-complete"
  : >"${REL}/apps/core/dist/rebase-home.js"
  chmod -R a+rX "${DEST}/releases"
  ln -sfn "${REL}" "${DEST}/current"
  cat >"${CFG}" <<YAML
core:
  origin: https://acme.example
  port: 3000
  run_user: ''
source:
  mode: artifact
  dest: ${DEST}
database:
  mode: external
YAML
  (umask 077 && cat >"${DEST}/.env" <<ENV
DATABASE_URL=postgresql://u:p@db.invalid:25060/ficus?sslmode=verify-full&sslrootcert=/etc/ficus/database-ca.crt
FICUS_SANDBOX_RUNTIME=vm
HOME_DIR=${OLD}
ENV
  )
  chmod 0600 "${DEST}/.env"
  mkdir -p "${OLD}/sessions/s1" "${OLD}/workspaces/w"
  printf 'x' >"${OLD}/sessions/s1/log"
  printf 'y' >"${OLD}/workspaces/w/file"
  chown 4242:4242 "${OLD}/workspaces/w/file" # a container's image uid
  ln -s ../sessions "${OLD}/workspaces/rel-link"
  printf '%s\n' "${OLD}/sessions/s1/log" "${OLD}/workspaces/w/file" /elsewhere/x >"${STATE}/db"
  chmod 0666 "${STATE}/db"
  install -m 0600 /dev/null "${H}/etc/ficus/artifacts/apns.p8"
  printf 'KEY' >"${H}/etc/ficus/artifacts/apns.p8"
  (
    # shellcheck source=lib.sh
    source "${SCRIPT_DIR}/lib.sh"
    RUN_USER=root SRC_DEST=${DEST} BUN_BIN=/usr/local/bin/bun DB_MODE=external POOL_ENABLED=false
    install_core_units "${SCRIPT_DIR}/systemd" >/dev/null 2>&1
    install_rendered 0755 root root "${BACKUP_SCRIPT_PATH}" render_backup_script_content "${SCRIPT_DIR}/ficus-backup.sh.tmpl" \
      "${DEST}" "${OLD}" external '' https://s3.example r1 bucket tenant/ "${BACKUP_ENV_TARGET}" >/dev/null 2>&1
  )
  printf '[Timer]\nOnCalendar=*-*-* 03:15:00\n' >"${UNITS}/ficus-backup.timer"
  systemctl start ficus-api ficus-worker
  : >"${STATE}/systemctl.log"
}
run_switch() { # ARGS... — prints the output, then rc=N
  local rc=0 out
  out=$(bash "${SCRIPT_DIR}/switch-run-user.sh" --config "${CFG}" --user "${SVC}" "$@" 2>&1) || rc=$?
  [[ -z ${SRU_VERBOSE:-} ]] || printf '%s\n' "${out}" >&2
  printf '%s\nrc=%s' "${out}" "${rc}"
}
last_line() { printf '%s' "$1" | grep -v '^rc=' | tail -n 1; }
backup_home() { sed -n "s/^HOME_DIR='\(.*\)'$/\1/p" "${BACKUP_SCRIPT_PATH}"; }
proc_user() { stat -c %U "/proc/$(cat "${PIDS_DIR}/$1")"; }

# ------------------------------------------------- 1. a switch, end to end
fresh_host
env_before=$(sha256sum <"${DEST}/.env")
out=$(run_switch)
expect_match 'switch: exits 0' "${out}" $'\nrc=0$'
expect_eq 'switch: the trailer names the service user' "$(last_line "${out}")" "FICUS_RUN_USER=${SVC}"
expect_eq 'switch: the old HOME is gone, moved (not copied) to the new one' \
  "$([[ -e ${OLD} ]] && echo old || echo gone):$(cat "${NEW}/sessions/s1/log")" 'gone:x'
expect_eq 'switch: the whole tree belongs to the user, container-written files included' \
  "$(find "${NEW}" -xdev ! -user "${SVC}" | wc -l)" 0
expect_eq 'switch: a relative symlink is re-owned, not followed' "$(stat -c %U "${NEW}/workspaces/rel-link")" "${SVC}"
expect_eq 'switch: machines/{keys,ctl} exist, 0700, the user'"'"'s' \
  "$(stat -c '%U %a' "${NEW}/machines" "${NEW}/machines/keys" "${NEW}/machines/ctl" | sort -u)" "${SVC} 700"
expect_eq 'switch: the user'"'"'s home is 0750' "$(stat -c '%U %a' "/home/${SVC}")" "${SVC} 750"
expect_match 'switch: the user is a nologin system account in systemd-journal' \
  "$(getent passwd "${SVC}" | cut -d: -f7) $(id -nG "${SVC}")" '^/usr/sbin/nologin .*systemd-journal'
expect_eq 'switch: the stored paths are rebased' "$(cat "${STATE}/db")" "${NEW}/sessions/s1/log
${NEW}/workspaces/w/file
/elsewhere/x"
expect_eq 'switch: .env HOME_DIR is the new HOME, .env stays root 0600' \
  "$(grep '^HOME_DIR=' "${DEST}/.env") $(stat -c '%U %a' "${DEST}/.env")" "HOME_DIR=${NEW} root 600"
expect_eq 'switch: core.run_user is recorded in the host config' "$(yq '.core.run_user' "${CFG}")" "${SVC}"
expect_eq 'switch: both units render User=<user>' \
  "$(grep -h '^User=' "${UNITS}/ficus-api.service" "${UNITS}/ficus-worker.service" | sort -u)" "User=${SVC}"
expect_eq 'switch: both services run as the user' "$(proc_user ficus-api) $(proc_user ficus-worker)" "${SVC} ${SVC}"
expect_eq 'switch: the backup script backs up the new HOME' "$(backup_home)" "${NEW}"
expect_eq 'switch: the backup script stays root 0755' "$(stat -c '%U %a' "${BACKUP_SCRIPT_PATH}")" 'root 755'
expect_eq 'switch: the self-updater sudoers rule names the user and the two units only' \
  "$(cat "${H}/etc/sudoers.d/ficus-update")" "${SVC} ALL=(root) NOPASSWD: /usr/bin/systemctl restart ficus-api, /usr/bin/systemctl restart ficus-worker"
expect_eq 'switch: no BigBrain rule on a host without BigBrain' "$([[ -e ${BIGBRAIN_SUDOERS} ]] && echo yes || echo no)" no
expect_eq 'switch: a 0600 artifact becomes root:<user group> 0640' \
  "$(stat -c '%U:%G %a' "${H}/etc/ficus/artifacts/apns.p8")" "root:${SVC} 640"
expect_eq 'switch: the journal and the backup set are gone' \
  "$(ls -A "${HOST_MIGRATE_BACKUP_ROOT}" | grep -v '^\.lock$' | grep -v '^run-user-switch$' | wc -l):$(ls -A "${HOST_MIGRATE_BACKUP_ROOT}/run-user-switch" | wc -l)" '0:0'
expect_match 'switch: the backup timer was stopped before the services and started after' \
  "$(tr '\n' ' ' <"${STATE}/systemctl.log")" 'stop ficus-backup.timer .*stop ficus-api ficus-worker .*restart ficus-api ficus-worker .*start ficus-backup.timer'
expect_eq 'switch: .env was rewritten (HOME_DIR only)' "$([[ $(sha256sum <"${DEST}/.env") != "${env_before}" ]] && echo changed)" changed

out=$(run_switch)
expect_match 'switch again: only the checks run, then the trailer' "${out}" 'already running as ficus-srut: running the success checks only'
expect_eq 'switch again: exits 0 with the same trailer' "$(last_line "${out}")$(grep -o 'rc=[0-9]*$' <<<"${out}")" "FICUS_RUN_USER=${SVC}rc=0"

# ------------------------------------------------------------- 2. --revert
out=$(run_switch --revert)
expect_eq 'revert: exits 0 with FICUS_RUN_USER=root' "$(last_line "${out}")$(grep -o 'rc=[0-9]*$' <<<"${out}")" 'FICUS_RUN_USER=rootrc=0'
expect_eq 'revert: HOME is back at /root/.ficus' "$([[ -e ${NEW} ]] && echo new || echo gone):$(cat "${OLD}/sessions/s1/log")" 'gone:x'
expect_eq 'revert: stored paths, .env, config, units and backup script are root'"'"'s again' \
  "$(head -n 1 "${STATE}/db") $(grep '^HOME_DIR=' "${DEST}/.env") [$(yq '.core.run_user' "${CFG}")] $(grep -h '^User=' "${UNITS}/ficus-api.service") $(backup_home)" \
  "${OLD}/sessions/s1/log HOME_DIR=${OLD} [] User=root ${OLD}"
expect_eq 'revert: both services run as root' "$(proc_user ficus-api) $(proc_user ficus-worker)" 'root root'
expect_eq 'revert: the sudoers rule is gone, the artifact group is root again' \
  "$([[ -e ${H}/etc/sudoers.d/ficus-update ]] && echo rule || echo none) $(stat -c %G "${H}/etc/ficus/artifacts/apns.p8")" 'none root'
expect_eq 'revert: the account is kept (a retry is cheap)' "$(id -un "${SVC}")" "${SVC}"

# ------------------------------------------ 3. preconditions change nothing
precondition() { # DESCRIPTION REGEX — on a fresh host prepared by the caller
  local out
  out=$(run_switch)
  expect_match "P: ${1} — refused" "${out}" "$2"
  expect_match "P: ${1} — exit non-zero" "${out}" $'\nrc=[1-9][0-9]*$'
  expect_eq "P: ${1} — nothing moved, nothing recorded, no journal" \
    "$([[ -d ${OLD} ]] && echo old):$(yq '.core.run_user' "${CFG}"):$(grep -h '^User=' "${UNITS}/ficus-api.service"):$([[ -e ${HOST_MIGRATE_BACKUP_ROOT}/RUN_USER_SWITCH ]] && echo journal)" \
    'old::User=root:'
}
fresh_host
mkdir -p "${NEW}" && : >"${NEW}/stray"
precondition 'a non-empty target HOME' 'already exists and is not an empty directory'
fresh_host
ln -s "${OLD}/sessions" "${OLD}/workspaces/abs-link"
precondition 'an absolute symlink into the old HOME' 'would dangle after the move'
fresh_host
printf '%s\n' "${NEW}/sessions/other" >>"${STATE}/db"
precondition 'stored paths already under the new HOME' 'already stores paths under'
fresh_host
: >"${STATE}/ficus-backup.service.active"
precondition 'a running backup' 'ficus-backup.service is running'

# ------------------------------------------- 4. a failed restart rolls back
fresh_host
cp -p "${UNITS}/ficus-api.service" "${S}/api-before"
cp -p "${BACKUP_SCRIPT_PATH}" "${S}/backup-before"
cp -p "${CFG}" "${S}/cfg-before"
cp -p "${DEST}/.env" "${S}/env-before"
: >"${STATE}/unhealthy-as-${SVC}"
out=$(run_switch)
expect_match 'rollback: the run fails' "${out}" $'\nrc=[1-9][0-9]*$'
expect_eq 'rollback: the trailer says the services run as root' "$(last_line "${out}")" 'FICUS_RUN_USER=root'
expect_eq 'rollback: HOME is back, the stored paths too' \
  "$([[ -e ${NEW} ]] && echo new || echo gone):$(cat "${OLD}/sessions/s1/log"):$(head -n 1 "${STATE}/db")" "gone:x:${OLD}/sessions/s1/log"
expect_eq 'rollback: unit, backup script, config and .env byte for byte' \
  "$(cmp -s "${S}/api-before" "${UNITS}/ficus-api.service" && cmp -s "${S}/backup-before" "${BACKUP_SCRIPT_PATH}" && cmp -s "${S}/cfg-before" "${CFG}" && cmp -s "${S}/env-before" "${DEST}/.env" && echo same)" same
expect_eq 'rollback: .env is root 0600 again' "$(stat -c '%U %a' "${DEST}/.env")" 'root 600'
expect_eq 'rollback: the sudoers rule this run added is removed' "$([[ -e ${H}/etc/sudoers.d/ficus-update ]] && echo rule || echo none)" none
expect_eq 'rollback: the artifact group is root again' "$(stat -c %G "${H}/etc/ficus/artifacts/apns.p8")" root
expect_eq 'rollback: the services run as root' "$(proc_user ficus-api) $(proc_user ficus-worker)" 'root root'
expect_eq 'rollback: no journal is left' "$([[ -e ${HOST_MIGRATE_BACKUP_ROOT}/RUN_USER_SWITCH ]] && echo journal || echo none)" none
rm -f "${STATE}/unhealthy-as-${SVC}"

# --------------------------- 5. an interrupted run is settled by the next one
fresh_host
# Stop it dead right after the HOME move: rebase-home.js "hangs" and the run is killed.
cat >"${SHIMS}/bun.hang" <<'EOF'
#!/usr/bin/env bash
[[ " $* " == *' --dry-run '* ]] || { kill -KILL "${SRU_KILL_PID}"; sleep 1; }
EOF
cp "${SHIMS}/bun" "${S}/bun.real"
cat >"${SHIMS}/bun" <<EOF
#!/usr/bin/env bash
[[ -e ${STATE}/hang ]] && bash ${SHIMS}/bun.hang "\$@"
exec bash ${S}/bun.real "\$@"
EOF
chmod 0755 "${SHIMS}/bun" "${SHIMS}/bun.hang"
: >"${STATE}/hang"
rc=0
(
  export SRU_KILL_PID=${BASHPID}
  exec bash "${SCRIPT_DIR}/switch-run-user.sh" --config "${CFG}" --user "${SVC}"
) >/dev/null 2>&1 || rc=$?
rm -f "${STATE}/hang"
expect_eq 'killed: the run died' "${rc}" 137
expect_eq 'killed: the journal is left, after the move' \
  "$([[ -e ${HOST_MIGRATE_BACKUP_ROOT}/RUN_USER_SWITCH ]] && echo journal):$([[ -d ${NEW} ]] && echo moved)" 'journal:moved'
other=$(bash "${SCRIPT_DIR}/enable-pooler.sh" --config "${CFG}" 2>&1 || true)
expect_match 'killed: every other toolkit entry refuses while the switch is journaled' "${other}" 'a run-user switch is journaled'
out=$(run_switch)
expect_match 'killed: the next run rolls the interrupted switch back first' "${out}" 'rolling it back first'
expect_eq 'killed: ...then switches, and succeeds' "$(last_line "${out}")$(grep -o 'rc=[0-9]*$' <<<"${out}")" "FICUS_RUN_USER=${SVC}rc=0"
expect_eq 'killed: ...with every stored path rebased exactly once' "$(head -n 2 "${STATE}/db")" "${NEW}/sessions/s1/log
${NEW}/workspaces/w/file"

summary
