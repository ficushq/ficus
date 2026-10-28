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
#     stored paths, every file byte for byte, the sudoers rule removed, or put
#     back when it was there before) and prints FICUS_RUN_USER=root, exit
#     non-zero; a failed --revert rolls back to the service user, its sudoers
#     rule included, and passes the success checks for it;
#   * a run killed mid-switch leaves its journal; every other toolkit entry
#     refuses while it exists, and the next run settles it;
#   * --revert refuses hosted artifact configs without changes, but still
#     goes back to root for self-hosted git configs (including the default);
#   * P6 refuses on a structured target hit (REBASE_HOME_TARGET) and passes
#     over free-text mentions of the new HOME (REBASE_HOME_TARGET_TEXT);
#   * S4 runs --structured-only, before the services restart, and only after
#     the real rebase; it ignores free-text mentions of the old HOME
#     (REBASE_HOME_TEXT), in the switch and in the rollback's post-check alike,
#     and fails (rolling back, the services never started as the user) on a
#     structured row left under the old HOME;
#   * with the pooler on, a rollback always starts it again before the core
#     units, whatever step the journal reached, and S7 passes; a host left
#     the way a failed settle left one (journal at step 6, HOME and the stored
#     paths already back, every service up) settles and then switches;
#   * the run survives its session: killed (HUP, then KILL to its process
#     group) mid-rollback, the worker finishes the rollback, records its
#     result, and releases the lock; a second run started meanwhile waits for
#     it instead of settling the journal itself;
#   * TERM or INT to the attached invocation mid-switch still aborts it: the
#     worker gets TERM and rolls back, the attached invocation exits with the
#     worker's code (143) once that is done, and .out records it;
#   * run-core-operator.sh runs an entrypoint as the account Core runs as, with
#     the env files parsed (never sourced), the caller's variables winning.
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
for cmd in jq yq runuser setpriv flock setsid tail useradd usermod groupadd userdel sha256sum; do
  [[ -n ${skip_reason} ]] || command -v "${cmd}" >/dev/null 2>&1 || skip_reason="${cmd} is not on PATH"
done
if [[ -z ${skip_reason} ]]; then
  [[ $(yq --version 2>&1) == *mikefarah* ]] || skip_reason='mikefarah yq v4 is not on PATH'
  ! id -u "${SVC}" >/dev/null 2>&1 || skip_reason="the account ${SVC} already exists"
  ! id -u ficus-pgbouncer >/dev/null 2>&1 || skip_reason='the account ficus-pgbouncer already exists'
  command -v python3 >/dev/null 2>&1 || command -v bun >/dev/null 2>&1 || skip_reason='neither python3 nor bun is on PATH (the fake pooler)'
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
  userdel ficus-pgbouncer >/dev/null 2>&1 || true
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
      # SRU_START_DELAY holds the child as root before it drops to User=, the
      # window a slow runner opens: $! names the process from the fork on, but
      # it belongs to the unit's user only once setpriv has run. Like systemd,
      # which reports a MainPID only after the credential change, the shim
      # returns once /proc/<pid> belongs to that user (bounded: 10 s).
      local -a cmd=(/bin/sleep 600)
      [[ ${user} == root ]] || cmd=(setpriv --reuid "${user}" --regid "$(id -g "${user}")" --init-groups "${cmd[@]}")
      setsid bash -c '/bin/sleep "${SRU_START_DELAY:-0}"; exec "$@"' _ "${cmd[@]}" </dev/null >/dev/null 2>&1 9>&- &
      local pid=$! waited=0
      until [[ $(stat -c %U "/proc/${pid}" 2>/dev/null) == "${user}" ]]; do
        if ((waited >= 200)) || ! kill -0 "${pid}" 2>/dev/null; then
          echo "systemctl shim: ${u} (pid ${pid}) never ran as ${user}" >&2
          kill -KILL "${pid}" 2>/dev/null || true
          return 1
        fi
        /bin/sleep 0.05
        waited=$((waited + 1))
      done
      echo "${pid}" >"${st}/pids/${u}"
      ;;
    ficus-pgbouncer)
      setsid "${SRU_SHIMS}/pooler-listen" </dev/null >/dev/null 2>&1 9>&- &
      local pid=$! waited=0
      until bash -c 'exec 3<>/dev/tcp/127.0.0.1/6432' 2>/dev/null; do
        if ((waited >= 200)) || ! kill -0 "${pid}" 2>/dev/null; then
          echo "systemctl shim: ${u} never listened on 6432" >&2
          kill -KILL "${pid}" 2>/dev/null || true
          return 1
        fi
        /bin/sleep 0.05
        waited=$((waited + 1))
      done
      echo "${pid}" >"${st}/pids/${u}"
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
  restart | start) for u in "$@"; do start "${u}" || exit 1; done ;;
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
# rebase-home.js over $SRU_STATE/db (one stored path per line; a line that
# starts with ~ is a free-text mention, messages.metadata: rewritten, reported
# as REBASE_HOME_TEXT / REBASE_HOME_TARGET_TEXT, never counted toward the
# target refusal, and left out by --structured-only — like the real program).
# Every call is logged to systemctl.log ("rebase <args>"), so a test can see
# it in order with the unit starts and stops. Hooks, files in $SRU_STATE:
#   rebase-fails           every call fails;
#   fail-from              (holds a path) a rebase from it fails;
#   hold-from              (holds a path) a rebase from it writes in-rebase
#                          and waits for release-rebase (60 s at most);
#   leave-after-from       (holds a path) a rebase from it leaves a structured
#                          row behind under that path;
#   mention-after-rebase   every rebase is followed by a new free-text mention
#                          of its --from (a live instance quoting the old HOME);
#   text-always            free-text lines are printed even with --structured-only.
cat >"${SHIMS}/bun" <<'EOF'
#!/usr/bin/env bash
[[ $1 == dist/rebase-home.js ]] || exit 99
shift
st=${SRU_STATE}
echo "rebase $*" >>"${st}/systemctl.log"
[[ -n ${DATABASE_URL:-} ]] || exit 2
from='' to='' dry=0 structured=0 force=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --from) from=$2; shift 2 ;;
    --to) to=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    --structured-only) structured=1; shift ;;
    --force) force=1; shift ;;
    *) shift ;;
  esac
done
hook() { [[ -f ${st}/$1 && $(cat "${st}/$1") == "${from}" ]]; }
db=${st}/db
[[ -e ${st}/rebase-fails ]] && exit 1
text=1
[[ ${structured} -eq 1 && ! -e ${st}/text-always ]] && text=0
moving=$(grep -c "^${from}/" "${db}" || true)
target=$(grep -c "^${to}/" "${db}" || true)
moving_text=$(grep -c "^~${from}/" "${db}" || true)
target_text=$(grep -c "^~${to}/" "${db}" || true)
if [[ ${dry} -eq 1 ]]; then
  echo "REBASE_HOME sessions.path=${moving}"
  [[ ${text} -eq 0 ]] || echo "REBASE_HOME_TEXT messages.metadata=${moving_text}"
  echo "REBASE_HOME_TARGET sessions.path=${target}"
  [[ ${text} -eq 0 ]] || echo "REBASE_HOME_TARGET_TEXT messages.metadata=${target_text}"
  exit 0
fi
hook fail-from && exit 1
if hook hold-from; then
  : >"${st}/in-rebase"
  for _ in $(seq 600); do [[ -e ${st}/release-rebase ]] && break; /bin/sleep 0.1; done
fi
if ((moving > 0 && target > 0 && force == 0)); then
  echo "REBASE_HOME_TARGET sessions.path=${target}"
  echo "REBASE_HOME_TARGET_TEXT messages.metadata=${target_text}"
  exit 3
fi
sed -i -e "s|^${from}/|${to}/|" -e "s|^~${from}/|~${to}/|" "${db}"
if hook leave-after-from; then echo "${from}/left-behind" >>"${db}"; fi
if [[ -e ${st}/mention-after-rebase ]]; then echo "~${from}/mentioned-later" >>"${db}"; fi
echo "REBASE_HOME sessions.path=${moving}"
echo "REBASE_HOME_TEXT messages.metadata=${moving_text}"
EOF
# The pooler: something that accepts on 127.0.0.1:6432 (S7 connects to it).
if command -v python3 >/dev/null 2>&1; then
  cat >"${SHIMS}/pooler-listen" <<'EOF'
#!/usr/bin/env bash
exec python3 -c 'import socket, time
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 6432))
s.listen(16)
time.sleep(3600)'
EOF
else
  cat >"${SHIMS}/pooler-listen" <<EOF
#!/usr/bin/env bash
exec $(command -v bun) -e 'Bun.listen({ hostname: "127.0.0.1", port: 6432, socket: { data() {} } }); setInterval(() => {}, 1e9)'
EOF
fi
printf '#!/usr/bin/env bash\nexit 0\n' >"${SHIMS}/pgbouncer"
# runuser keeps the shims first on PATH for the probes it runs as the user.
cat >"${SHIMS}/runuser" <<EOF
#!/usr/bin/env bash
[[ \$1 == -u && \$3 == -- ]] || exec /usr/sbin/runuser "\$@"
[[ \$4 == sudo && \$5 == -n && \$6 == -l ]] && exec bash ${SHIMS}/sudo-list "\$2"
exec /usr/sbin/runuser -u "\$2" -- env "PATH=${SHIMS}:/usr/sbin:/usr/bin:/sbin:/bin" SRU_SUDOERS_DIR="${H}/etc/sudoers.d" "\${@:4}"
EOF
chmod 0755 "${SHIMS}"/*

export PATH="${SHIMS}:${PATH}"
# Every fake service start stays root for this long before it drops to its
# User= (see the systemctl shim), so the suite always runs the slow-runner race.
export SRU_START_DELAY=${SRU_START_DELAY:-0.3}
export SRU_STATE="${STATE}" SRU_SUDOERS_DIR="${H}/etc/sudoers.d" SRU_SHIMS="${SHIMS}"
# A second run waits for the first on the host lock: not for 15 minutes.
export HOST_MIGRATE_LOCK_WAIT=120
export FICUS_HOST_ROOT="${H}" FICUS_SYSTEMD_UNIT_DIR="${UNITS}"
export HOST_MIGRATE_BACKUP_ROOT="${H}/var/backups/ficus-host-migrate"
export BACKUP_SCRIPT_PATH="${H}/usr/local/sbin/ficus-backup.sh" BACKUP_ENV_TARGET="${H}/etc/ficus/backup.env"
export BIGBRAIN_ETC="${H}/etc/ficus/bigbrain" BIGBRAIN_SUDOERS="${H}/etc/sudoers.d/ficus-bigbrain"

# ---------------------------------------------------------------- the host
CFG="${H}/root/ficus-setup/ficus-setup.yaml"
OLD=/root/.ficus
NEW="/home/${SVC}/.ficus"
REL="${DEST}/releases/r1"
fresh_host() { # [pool] — "pool": database.pool.enabled, the pooler installed and running
  local f pool=false
  [[ ${1:-} != pool ]] || pool=true
  for f in "${PIDS_DIR}"/*; do [[ -f ${f} ]] && kill -KILL "$(cat "${f}")" 2>/dev/null || true; done
  userdel -r "${SVC}" >/dev/null 2>&1 || true
  rm -rf "${OLD}" "/home/${SVC}" "${STATE:?}"/* "${HOST_MIGRATE_BACKUP_ROOT}" "${H}/etc/sudoers.d"/* "${UNITS:?}"/* \
    "${H}/etc/ficus/pgbouncer"
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
  pool:
    enabled: ${pool}
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
    RUN_USER=root SRC_DEST=${DEST} BUN_BIN=/usr/local/bin/bun DB_MODE=external POOL_ENABLED=${pool}
    if [[ ${pool} == true ]]; then
      install_pooler "$(envfile_direct_dsn "${DEST}/.env")" 4 2 "${SCRIPT_DIR}/systemd" >/dev/null 2>&1 ||
        echo 'fresh_host: install_pooler failed' >&2
    fi
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
# The newest / oldest / number of the run files matching a glob (none: empty, 0).
run_files() { ls -1t -- "${HOST_MIGRATE_BACKUP_ROOT}/run-user-switch-runs/"*."$1" 2>/dev/null || true; }
newest_run() { run_files "$1" | head -n 1; }
oldest_run() { run_files "$1" | tail -n 1; }

# ------------------------------------------------- 1. a switch, end to end
fresh_host
# A legacy hosted root host can still be repaired by the forward switch.
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
  "$(ls -A "${HOST_MIGRATE_BACKUP_ROOT}" | grep -v '^\.lock$' | grep -v '^run-user-switch$' | grep -v '^run-user-switch-runs$' | wc -l):$(ls -A "${HOST_MIGRATE_BACKUP_ROOT}/run-user-switch" | wc -l)" '0:0'
expect_match 'switch: the backup timer was stopped before the services and started after' \
  "$(tr '\n' ' ' <"${STATE}/systemctl.log")" 'stop ficus-backup.timer .*stop ficus-api ficus-worker .*restart ficus-api ficus-worker .*start ficus-backup.timer'
events=$(tr '\n' ' ' <"${STATE}/systemctl.log")
expect_match 'switch: S4 is a --structured-only dry run, after the rebase and before the restart' "${events}" \
  "rebase --from ${OLD} --to ${NEW} (rebase|systemctl) .*rebase --from ${OLD} --to ${NEW} --dry-run --structured-only .*systemctl restart ficus-api ficus-worker"
expect_eq 'switch: nothing reads the database after the restart (S4 is not run twice)' \
  "$(sed -n '/restart ficus-api ficus-worker/,$p' "${STATE}/systemctl.log" | grep -c '^rebase ' || true)" 0
expect_eq 'switch: the run recorded its trailer and exit code for a caller that lost its session' \
  "$(cat "$(newest_run out)" 2>/dev/null)" "FICUS_RUN_USER=${SVC}"$'\n''FICUS_RUN_USER_SWITCH_EXIT=0'
expect_match 'switch: the attached run names its log and result files' "${out}" 'this run goes on if the session ends .*run-user-switch-runs/'
expect_eq 'switch: .env was rewritten (HOME_DIR only)' "$([[ $(sha256sum <"${DEST}/.env") != "${env_before}" ]] && echo changed)" changed

out=$(run_switch)
expect_match 'switch again: only the checks run, then the trailer' "${out}" 'already running as ficus-srut: running the success checks only'
expect_eq 'switch again: exits 0 with the same trailer' "$(last_line "${out}")$(grep -o 'rc=[0-9]*$' <<<"${out}")" "FICUS_RUN_USER=${SVC}rc=0"

# ------------------------------------------------------------- 2. --revert
# Hosted reverts must refuse without changing config, HOME, units or DB.
hosted_before=$(sha256sum "${CFG}" "${DEST}/.env" "${STATE}/db" "${UNITS}/ficus-api.service" "${UNITS}/ficus-worker.service")
: >"${STATE}/systemctl.log"
out=$(run_switch --revert)
expect_match 'hosted revert: exits nonzero with consistent service-user guidance' "${out}" \
  'core.run_user.*hosted Core runs as an unprivileged service user'
expect_match 'hosted revert: fails' "${out}" $'\nrc=1$'
expect_eq 'hosted revert: files and stored paths are unchanged' \
  "$(sha256sum "${CFG}" "${DEST}/.env" "${STATE}/db" "${UNITS}/ficus-api.service" "${UNITS}/ficus-worker.service")" "${hosted_before}"
expect_eq 'hosted revert: HOME stays with the service user and no service operation runs' \
  "$([[ -d ${NEW} && ! -e ${OLD} ]] && echo home):$(cat "${STATE}/systemctl.log")" 'home:'
# The same artifact-layout host with self-hosted source semantics keeps revert.
yq -i '.source.mode = "git-https"' "${CFG}"
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
expect_eq 'revert: HOME belongs to root again (the operator entrypoints run as its owner)' \
  "$(find "${OLD}" -xdev ! -user root | wc -l)" 0

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
out=$(run_switch)
expect_match 'P: stored paths already under the new HOME — the rows are listed, free-text mentions said not to count' "${out}" \
  "already stores paths under ${NEW}:"$'\n''REBASE_HOME_TARGET sessions.path=1'$'\n''\(free-text mentions of that path, such as message text, are reported as REBASE_HOME_TARGET_TEXT and do not count\)'$'\n''nothing was changed'

# P6 passes over free-text mentions of the new HOME (REBASE_HOME_TARGET_TEXT).
fresh_host
printf '%s\n' "~${NEW}/discussed-in-a-message" "~${OLD}/sessions/s1/log" >>"${STATE}/db"
out=$(run_switch)
expect_eq 'P6: a free-text mention of the new HOME does not refuse, the switch succeeds' \
  "$(last_line "${out}")$(grep -o 'rc=[0-9]*$' <<<"${out}")" "FICUS_RUN_USER=${SVC}rc=0"
expect_eq 'P6: every path and mention under the old HOME moved, the mention of the new one kept' "$(cat "${STATE}/db")" "${NEW}/sessions/s1/log
${NEW}/workspaces/w/file
/elsewhere/x
~${NEW}/discussed-in-a-message
~${NEW}/sessions/s1/log"
# ...and a failed restart after it still rolls back cleanly (the inverse
# rebase does not refuse on the mentions either).
fresh_host
printf '%s\n' "~${NEW}/discussed-in-a-message" >>"${STATE}/db"
: >"${STATE}/unhealthy-as-${SVC}"
out=$(run_switch)
rm -f "${STATE}/unhealthy-as-${SVC}"
expect_match 'P6: with a free-text mention, a failed restart rolls back and passes the checks' "${out}" \
  "rolled back: the services run as root again"$'\n''FICUS_RUN_USER=root'$'\n''rc=[1-9]'
expect_eq 'P6: ...every stored path is under the old HOME again' "$(head -n 2 "${STATE}/db")" "${OLD}/sessions/s1/log
${OLD}/workspaces/w/file"
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
expect_eq 'rollback: HOME belongs to root again' \
  "$(find "${OLD}" -xdev ! -user root | wc -l)" 0
expect_eq 'rollback: no journal is left' "$([[ -e ${HOST_MIGRATE_BACKUP_ROOT}/RUN_USER_SWITCH ]] && echo journal || echo none)" none
rm -f "${STATE}/unhealthy-as-${SVC}"

# ---- 4b. a forward rollback restores sudoers rules that were already there
fresh_host
printf 'operator-rule-update\n' >"${H}/etc/sudoers.d/ficus-update"
printf 'operator-rule-bigbrain\n' >"${BIGBRAIN_SUDOERS}"
chmod 0440 "${H}/etc/sudoers.d/ficus-update" "${BIGBRAIN_SUDOERS}"
cp -p "${H}/etc/sudoers.d/ficus-update" "${S}/update-before"
cp -p "${BIGBRAIN_SUDOERS}" "${S}/bigbrain-before"
: >"${STATE}/unhealthy-as-${SVC}"
out=$(run_switch)
rm -f "${STATE}/unhealthy-as-${SVC}"
expect_eq 'rollback (pre-existing rules): the trailer says root' "$(last_line "${out}")" 'FICUS_RUN_USER=root'
expect_eq 'rollback (pre-existing rules): both sudoers files are back byte for byte, 0440 root' \
  "$(cmp -s "${S}/update-before" "${H}/etc/sudoers.d/ficus-update" && cmp -s "${S}/bigbrain-before" "${BIGBRAIN_SUDOERS}" && echo same) $(stat -c '%U %a' "${H}/etc/sudoers.d/ficus-update" "${BIGBRAIN_SUDOERS}" | sort -u)" \
  'same root 440'

# ---- 4c. a failed --revert rolls back to the service user, sudoers rule included
fresh_host
out=$(run_switch)
expect_eq 'revert rollback: the switch itself succeeds' "$(last_line "${out}")" "FICUS_RUN_USER=${SVC}"
cp -p "${H}/etc/sudoers.d/ficus-update" "${S}/update-switched"
: >"${STATE}/unhealthy-as-root"
yq -i '.source.mode = "git-ssh"' "${CFG}"
out=$(run_switch --revert)
rm -f "${STATE}/unhealthy-as-root"
expect_match 'revert rollback: the revert fails' "${out}" $'\nrc=[1-9][0-9]*$'
expect_eq 'revert rollback: the trailer says the services run as the service user again' "$(last_line "${out}")" "FICUS_RUN_USER=${SVC}"
expect_match 'revert rollback: the rolled-back host passed the success checks for the service user' "${out}" "rolled back: the services run as ${SVC} again"
expect_eq 'revert rollback: the self-updater sudoers rule is back byte for byte, 0440 root' \
  "$(cmp -s "${S}/update-switched" "${H}/etc/sudoers.d/ficus-update" && echo same) $(stat -c '%U %a' "${H}/etc/sudoers.d/ficus-update")" \
  'same root 440'
expect_eq 'revert rollback: HOME, config, units and processes are the service user'"'"'s again' \
  "$([[ -d ${NEW} && ! -e ${OLD} ]] && echo home) $(yq '.core.run_user' "${CFG}") $(grep -h '^User=' "${UNITS}/ficus-api.service") $(proc_user ficus-api) $(find "${NEW}" -xdev ! -user "${SVC}" | wc -l)" \
  "home ${SVC} User=${SVC} ${SVC} 0"
expect_eq 'revert rollback: no journal is left' "$([[ -e ${HOST_MIGRATE_BACKUP_ROOT}/RUN_USER_SWITCH ]] && echo journal || echo none)" none

# --------------------------- 5. an interrupted run is settled by the next one
fresh_host
# Stop it dead right after the HOME move: rebase-home.js "hangs" and the run is killed.
# The worker's whole process group dies at once, its wrapper included (a
# reboot): nothing records an exit code, the attached run exits 137.
cat >"${SHIMS}/bun.hang" <<'EOF'
#!/usr/bin/env bash
[[ " $* " == *' --dry-run '* ]] || kill -KILL -- "-$(cut -d' ' -f5 /proc/$$/stat)"
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
bash "${SCRIPT_DIR}/switch-run-user.sh" --config "${CFG}" --user "${SVC}" >/dev/null 2>&1 || rc=$?
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

# ------------------------------- 7. S4 counts the structured columns only
# A live instance mentions the old HOME in free text after the rebase; with
# text-always the fake prints REBASE_HOME_TEXT even under --structured-only,
# so the check's own scoping (the grep) is under test too.
fresh_host
: >"${STATE}/mention-after-rebase"
: >"${STATE}/text-always"
out=$(run_switch)
expect_eq 'S4: a free-text mention of the old HOME after the rebase does not fail the switch' \
  "$(last_line "${out}")$(grep -o 'rc=[0-9]*$' <<<"${out}")" "FICUS_RUN_USER=${SVC}rc=0"
expect_eq 'S4: ...the mention is still there (and still names the old HOME)' "$(grep -c "^~${OLD}/mentioned-later$" "${STATE}/db")" 1
# The rollback's post-check, the same: a mention of the HOME it left, after
# the rebase back, does not make the rollback report failure.
yq -i 'del(.source.mode)' "${CFG}"
out=$(run_switch --revert)
expect_eq 'S4: the revert ignores the mentions too' "$(last_line "${out}")$(grep -o 'rc=[0-9]*$' <<<"${out}")" 'FICUS_RUN_USER=rootrc=0'
fresh_host
: >"${STATE}/mention-after-rebase"
: >"${STATE}/text-always"
: >"${STATE}/unhealthy-as-${SVC}"
out=$(run_switch)
rm -f "${STATE}/unhealthy-as-${SVC}"
expect_match 'S4: a rollback whose post-check sees a free-text mention of the new HOME completes' "${out}" \
  "rolled back: the services run as root again"$'\n''FICUS_RUN_USER=root'$'\n''rc=[1-9]'
expect_eq 'S4: ...with the mention written after the rebase back in the data' "$(grep -c "^~${NEW}/mentioned-later$" "${STATE}/db")" 1
expect_eq 'S4: ...and no journal left' "$([[ -e ${HOST_MIGRATE_BACKUP_ROOT}/RUN_USER_SWITCH ]] && echo journal || echo none)" none
# A structured row left under the old HOME fails S4 before the restart: the
# services never run as the user, and the rollback (whose rebase back merges
# the row with the rest: it is the old HOME's) completes.
fresh_host
printf '%s' "${OLD}" >"${STATE}/leave-after-from"
out=$(run_switch)
expect_match 'S4: a structured row left under the old HOME fails the switch' "${out}" "S4: stored paths still name ${OLD}: \[REBASE_HOME sessions.path=1 \]"
expect_eq 'S4: ...which rolls back to root' "$(last_line "${out}")" 'FICUS_RUN_USER=root'
expect_match 'S4: ...exit non-zero' "${out}" $'\nrc=[1-9][0-9]*$'
expect_eq 'S4: ...the services were restarted once, by the rollback, never as the user' \
  "$(grep -c '^systemctl restart ficus-api ficus-worker$' "${STATE}/systemctl.log")" 1
expect_eq 'S4: ...every stored path is under the old HOME again' "$(grep -c "^${NEW}/" "${STATE}/db"):$(grep -c "^${OLD}/" "${STATE}/db")" '0:3'
expect_eq 'S4: ...no journal left' "$([[ -e ${HOST_MIGRATE_BACKUP_ROOT}/RUN_USER_SWITCH ]] && echo journal || echo none)" none
rm -f "${STATE}/leave-after-from"

# ------------------- 8. a rollback always brings the pooler back (S7 passes)
fresh_host pool
expect_eq 'pooler: the fake host runs it as ficus-pgbouncer' "$(grep -h '^User=' "${UNITS}/ficus-pgbouncer.service") $([[ -e ${STATE}/ficus-pgbouncer.active ]] && echo active)" 'User=ficus-pgbouncer active'
# The switch dies at step 5 (the rebase): the journal never reached step 11.
printf '%s' "${OLD}" >"${STATE}/fail-from"
: >"${STATE}/systemctl.log"
out=$(run_switch)
rm -f "${STATE}/fail-from"
expect_match 'pooler: a switch that fails at step 5 rolls back and passes the checks, S7 included' "${out}" \
  "rolled back: the services run as root again"$'\n''FICUS_RUN_USER=root'$'\n''rc=[1-9]'
expect_eq 'pooler: ...the pooler runs again' "$([[ -e ${STATE}/ficus-pgbouncer.active ]] && echo active)" active
expect_match 'pooler: ...started before the core units' "$(tr '\n' ' ' <"${STATE}/systemctl.log")" \
  'systemctl stop ficus-pgbouncer .*systemctl start ficus-pgbouncer .*systemctl restart ficus-api ficus-worker'
# A pooled switch then succeeds, and its revert too.
out=$(run_switch)
expect_eq 'pooler: a pooled switch succeeds' "$(last_line "${out}")$(grep -o 'rc=[0-9]*$' <<<"${out}")" "FICUS_RUN_USER=${SVC}rc=0"
expect_eq 'pooler: ...the pooler runs as the user' "$(grep -h '^User=' "${UNITS}/ficus-pgbouncer.service")" "User=${SVC}"

# The host the way a failed settle left it (noah, 2026-10-27): a switch died
# at step 6, its rollback put HOME, the stored paths and every file back and
# the services up (the pooler by hand), but reported failure and kept its
# journal. The next run settles it from there, then switches.
fresh_host pool
: >"${STATE}/hang"
rc=0
bash "${SCRIPT_DIR}/switch-run-user.sh" --config "${CFG}" --user "${SVC}" >/dev/null 2>&1 || rc=$?
rm -f "${STATE}/hang"
flock "${HOST_MIGRATE_BACKUP_ROOT}/.lock" true # the killed run's last child is gone
expect_eq 'settle: the run died after journaling step 5' "${rc}:$(tail -n 1 "${HOST_MIGRATE_BACKUP_ROOT}/RUN_USER_SWITCH")" '137:5'
echo 6 >>"${HOST_MIGRATE_BACKUP_ROOT}/RUN_USER_SWITCH"
mv "${NEW}" "${OLD}"
sed -i "s|^${NEW}/|${OLD}/|" "${STATE}/db"
systemctl start ficus-pgbouncer ficus-api ficus-worker
setdir=$(cut -f1 "${HOST_MIGRATE_BACKUP_ROOT}/RUN_USER_SWITCH")
: >"${STATE}/systemctl.log"
out=$(run_switch)
expect_match 'settle: the journal at step 6 is rolled back first' "${out}" 'an interrupted run-user switch is journaled .* rolling it back first'
expect_match 'settle: ...cleanly (the checks pass, S7 included), the journal and its set removed' "${out}" 'rolled back: the services run as root again'
expect_eq 'settle: ...then the switch runs and succeeds' "$(last_line "${out}")$(grep -o 'rc=[0-9]*$' <<<"${out}")" "FICUS_RUN_USER=${SVC}rc=0"
expect_eq 'settle: ...the old backup set is gone' "$([[ -e ${setdir} ]] && echo kept || echo gone)" gone
expect_eq 'settle: ...every stored path rebased exactly once' "$(head -n 2 "${STATE}/db")" "${NEW}/sessions/s1/log
${NEW}/workspaces/w/file"
expect_eq 'settle: ...the pooler runs as the user' \
  "$(grep -h '^User=' "${UNITS}/ficus-pgbouncer.service") $([[ -e ${STATE}/ficus-pgbouncer.active ]] && echo active)" "User=${SVC} active"

# ----------- 9. TERM or INT to the attached invocation still aborts the switch
# Sent while the run is held in its rebase (step 5): the worker gets TERM,
# rolls back once the rebase returns, and the attached invocation exits with
# its code after that, not before. env --default-signal: a background job of
# this (non-interactive) shell would start with INT ignored, as Ctrl-C's
# target never does.
for sig in TERM INT; do
  fresh_host
  printf '%s' "${OLD}" >"${STATE}/hold-from"
  env --default-signal=INT bash "${SCRIPT_DIR}/switch-run-user.sh" --config "${CFG}" --user "${SVC}" >"${S}/abort.out" 2>&1 &
  attached=$!
  for _ in $(seq 600); do [[ -e ${STATE}/in-rebase ]] && break; /bin/sleep 0.1; done
  expect_eq "abort ${sig}: the run is in its rebase" "$([[ -e ${STATE}/in-rebase ]] && echo held)" held
  kill "-${sig}" "${attached}"
  /bin/sleep 0.5
  expect_eq "abort ${sig}: the attached invocation waits for the worker" "$(kill -0 "${attached}" 2>/dev/null && echo waiting)" waiting
  : >"${STATE}/release-rebase"
  rc=0
  wait "${attached}" || rc=$?
  rm -f "${STATE}/hold-from" "${STATE}/in-rebase" "${STATE}/release-rebase"
  out=$(cat "${S}/abort.out")
  expect_eq "abort ${sig}: the worker rolled back to root, the attached invocation exits with its code" \
    "$(last_line "${out}") rc=${rc}" 'FICUS_RUN_USER=root rc=143'
  expect_match "abort ${sig}: ...after the rollback completed" "${out}" 'rolled back: the services run as root again'
  expect_eq "abort ${sig}: ...which .out records, exit line last" "$(cat "$(newest_run out)" 2>/dev/null)" \
    'FICUS_RUN_USER=root'$'\n''FICUS_RUN_USER_SWITCH_EXIT=143'
  expect_eq "abort ${sig}: ...HOME, stored paths and services are root's, no journal, the lock free" \
    "$([[ -d ${OLD} && ! -e ${NEW} ]] && echo home):$(head -n 1 "${STATE}/db"):$(proc_user ficus-api):$([[ -e ${HOST_MIGRATE_BACKUP_ROOT}/RUN_USER_SWITCH ]] && echo journal):$(flock -n "${HOST_MIGRATE_BACKUP_ROOT}/.lock" true && echo free)" \
    "home:${OLD}/sessions/s1/log:root::free"
done

# -------------- 10. the run survives its session; a second run waits for it
# The session: a process group of its own whose output goes through a pipe,
# like sshd's. Mid-rollback (held in the rebase back), it gets HUP then KILL
# (the pipe closes with it), and a second run starts meanwhile.
fresh_host
: >"${STATE}/unhealthy-as-${SVC}"
printf '%s' "${NEW}" >"${STATE}/hold-from"
setsid bash -c 'bash "$1" --config "$2" --user "$3" 2>&1 | cat >"$4"' _ \
  "${SCRIPT_DIR}/switch-run-user.sh" "${CFG}" "${SVC}" "${S}/session.out" &
session=$!
for _ in $(seq 600); do [[ -e ${STATE}/in-rebase ]] && break; /bin/sleep 0.1; done
expect_eq 'session: the first run is rolling back' "$([[ -e ${STATE}/in-rebase ]] && echo rolling)" rolling
rm -f "${STATE}/unhealthy-as-${SVC}"
run_switch >"${S}/second.out" &
second=$!
for _ in $(seq 300); do
  second_log=$(newest_run log)
  [[ $(run_files log | wc -l) -eq 2 ]] && grep -q 'taking the host lock' "${second_log}" && break
  /bin/sleep 0.1
done
first_log=$(oldest_run log)
kill -HUP -- "-${session}" 2>/dev/null || true
/bin/sleep 0.3
kill -KILL -- "-${session}" 2>/dev/null || true
wait "${session}" 2>/dev/null || true
expect_eq 'session: the session is gone, its output cut short (no trailer)' \
  "$(kill -0 "${session}" 2>/dev/null && echo alive || echo gone):$(grep -c '^FICUS_RUN_USER=' "${S}/session.out" || true)" 'gone:0'
expect_eq 'session: the second run waits on the lock (it has not looked at the journal)' \
  "$(if [[ -n ${second_log} && ${first_log} != "${second_log}" ]]; then grep -c 'rolling it back first\|switching from' "${second_log}" || true; else echo 'no second run log'; fi)" 0
: >"${STATE}/release-rebase"
wait "${second}" || true
rm -f "${STATE}/hold-from" "${STATE}/in-rebase" "${STATE}/release-rebase"
out=$(cat "${S}/second.out")
expect_match 'session: the first run finished its rollback after the session ended' "$(cat "${first_log}" 2>/dev/null)" \
  'rolled back: the services run as root again'
expect_eq 'session: ...and recorded its result: root, exit non-zero' "$(cat "${first_log%.log}.out" 2>/dev/null)" \
  'FICUS_RUN_USER=root'$'\n''FICUS_RUN_USER_SWITCH_EXIT=1'
expect_eq 'session: the second run found it settled (no journal to roll back), then switched' \
  "$(grep -c 'rolling it back first' <<<"${out}" || true):$(last_line "${out}")$(grep -o 'rc=[0-9]*$' <<<"${out}")" "0:FICUS_RUN_USER=${SVC}rc=0"
expect_eq 'session: the lock is free' "$(flock -n "${HOST_MIGRATE_BACKUP_ROOT}/.lock" true && echo free)" free

# ------------------- 6. the operator wrapper runs entrypoints as the Core account
cat >"${SHIMS}/fake-bun" <<'EOF'
#!/usr/bin/env bash
echo "user=$(id -un)"
echo "cwd=${PWD}"
echo "args=$*"
for k in DATABASE_URL FICUS_BC_ACTION FICUS_ROOT SHARED QUOTED CALLER_WINS; do echo "${k}=${!k-<unset>}"; done
EOF
chmod 0755 "${SHIMS}/fake-bun"
: >"${REL}/apps/core/dist/box-control.js"
chmod 0644 "${REL}/apps/core/dist/box-control.js"
printf 'SHARED=from-env\nQUOTED="a b"\nCALLER_WINS=from-env\n# a comment\nnot a pair\n' >>"${DEST}/.env"
MANAGED="${H}/etc/ficus/managed.env"
printf 'SHARED=from-managed\n' >"${MANAGED}"
chmod 0600 "${MANAGED}"
operator() { # prints the output, then rc=N
  local rc=0 out
  out=$(FICUS_BC_ACTION=status CALLER_WINS=caller BUN_BIN="${SHIMS}/fake-bun" FICUS_MANAGED_ENV_PATH="${MANAGED}" \
    bash "${SCRIPT_DIR}/run-core-operator.sh" --dest "${DEST}" "$@" 2>&1) || rc=$?
  printf '%s\nrc=%s' "${out}" "${rc}"
}
out=$(operator box-control)
expect_match 'operator: on a switched host the entrypoint runs as the service user' "${out}" "(^|"$'\n'")user=${SVC}"$'\n'
expect_match 'operator: from the release'"'"'s apps/core, Bun'"'"'s .env loading off' "${out}" \
  "cwd=${REL}/apps/core"$'\n'"args=--no-env-file dist/box-control.js"
expect_match 'operator: .env is parsed, never sourced (a DSN with & survives)' "${out}" \
  'DATABASE_URL=postgresql://u:p@db.invalid:25060/ficus\?sslmode=verify-full&sslrootcert=/etc/ficus/database-ca.crt'
expect_match 'operator: the caller'"'"'s request and its own variables win' "${out}" 'FICUS_BC_ACTION=status.*CALLER_WINS=caller'
expect_match 'operator: managed.env is loaded after .env (it wins), quotes are removed' "${out}" 'SHARED=from-managed'$'\n''QUOTED=a b'
expect_match 'operator: FICUS_ROOT is the active release, as the units set it' "${out}" "FICUS_ROOT=${DEST}/current"
expect_match 'operator: exits with the entrypoint' "${out}" $'\nrc=0$'
out=$(operator nonsense)
expect_match 'operator: an unknown entrypoint is a usage error' "${out}" $'\nrc=2$'
# A copy in the 0755 scratch dir: the checkout (CI: under /home/runner) may not be
# traversable by the throwaway account, and the wrapper's own refusal is under test.
install -m 0755 "${SCRIPT_DIR}/run-core-operator.sh" "${S}/run-core-operator.sh"
out=$(runuser -u "${SVC}" -- bash "${S}/run-core-operator.sh" --dest "${DEST}" box-control 2>&1 || true)
expect_match 'operator: refuses to run unless root' "${out}" 'run it as root'
yq -i '.source.mode = "git-https"' "${CFG}"
run_switch --revert >/dev/null
out=$(operator box-control)
expect_match 'operator: on a root host the entrypoint runs as root' "${out}" "(^|"$'\n'")user=root"$'\n'

summary
