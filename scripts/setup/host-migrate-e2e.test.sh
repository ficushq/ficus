#!/usr/bin/env bash
# host-migrate-e2e.test.sh — lib.sh's journaled host-migration framework as
# the real entrypoints run it: upgrade-host.sh, apply-artifacts.sh and
# setup-host.sh run as subprocesses against a fake host in a scratch
# directory, moved onto real signed artifacts served over file:// URLs.
#
# Two test-only migrations drive it. They are appended to a SCRATCH COPY of
# the toolkit (the real lib.sh is never touched, and no production file has a
# test seam for them):
#   e2emark  marks <dest>/.env and backup.env and creates managed.env, for a
#            release that carries NEEDS_E2EMARK — a plain migration the
#            framework settles by the active release;
#   e2emove  moves a data dir (what a byte restore cannot put back) and
#            journals its own commit point in the set — a migration with the
#            _settle and _reverse hooks.
#
# What is proven here, end to end:
#   * an upgrade onto a release that needs a migration migrates right before
#     the flip, keeps one backup set and leaves no journal;
#   * a failed health check rolls back AND restores every file byte for byte,
#     the restore before the rollback restart;
#   * the files always end up matching the ACTIVE release: SIGTERM / SIGHUP /
#     SIGINT before the flip restore them, after it keep and commit the
#     migration (exit 143 / 129 / 130); a dropped control connection (SIGPIPE)
#     settles the same way;
#   * SIGKILL before the flip leaves the journal, and the next run with the
#     same inputs reconciles (restores) and then completes; SIGKILL after the
#     flip is reconciled FORWARD by the next toolkit run (apply-artifacts.sh);
#   * a git->artifact conversion that rolls back restores the files and
#     re-renders the units for the current layout; one killed mid-migration
#     stays journaled for a toolkit without the unit templates (rc 3), and
#     --restore-host-backup of its set needs --config;
#   * setup-host.sh's re-run reconciles first and restores before its
#     rollback restart;
#   * the _settle / _reverse hooks: a failure before the migration's commit
#     point is reversed; after it (a signal, a rollback) it is finished
#     forward; --restore-host-backup refuses a set that must be reversed first.
#
# Nothing touches the real host: every path the toolkit writes is pointed at
# the scratch directory through its seams (FICUS_HOST_ROOT,
# FICUS_SYSTEMD_UNIT_DIR, FICUS_MANAGED_ENV_PATH, BACKUP_ENV_TARGET,
# BACKUP_SCRIPT_PATH, HOST_MIGRATE_BACKUP_ROOT, FICUS_SYSTEM_BIN_DIR), and
# systemctl, journalctl, swapon, sleep, pg_dump and pg_restore are PATH shims.
# curl is a shim that answers the core's /health probe (healthy only for the
# releases the test names) and passes everything else to the real curl.
#
# The entrypoints need real root, GNU coreutils, OpenSSL 3, bun, jq, python3
# and mikefarah yq, so the suite self-skips — loudly, without the ENABLED
# marker — anywhere else. CI runs it as root; locally, run it in a throwaway
# Ubuntu 24.04 container. The setup-host.sh case (E6) also needs a systemd
# host (/run/systemd/system) and prints `SKIP E6: …` without one.
#
# Run: sudo bash scripts/setup/host-migrate-e2e.test.sh
#   E2E_VERBOSE=1  print every entrypoint's output
#   E2E_MUTATE=N   run against a mutated toolkit copy (the mutation proofs;
#                  see mutate_toolkit below) — expected to fail
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
# A probe's output, captured whole before it is matched: `tool | grep -q …`
# under pipefail fails whenever grep exits early and the tool dies of SIGPIPE.
probe() { "$@" 2>&1 || true; }

skip_reason=''
[[ ${EUID} -eq 0 ]] || skip_reason='not running as root'
if [[ -z ${skip_reason} ]]; then
  for cmd in bun jq python3 curl tar openssl sha256sum setsid runuser mkfifo git; do
    command -v "${cmd}" >/dev/null 2>&1 || skip_reason=${skip_reason:-"${cmd} is not on PATH"}
  done
fi
if [[ -z ${skip_reason} ]]; then
  command -v yq >/dev/null 2>&1 && [[ $(probe yq --version) == *mikefarah* ]] || skip_reason='mikefarah yq v4 is not on PATH'
fi
if [[ -z ${skip_reason} ]]; then
  [[ $(probe mv --version) == *'GNU coreutils'* && $(probe sha256sum --version) == *'GNU coreutils'* ]] ||
    skip_reason='GNU coreutils are not on PATH'
  [[ $(probe openssl pkeyutl -help) == *-rawin* ]] || skip_reason=${skip_reason:-'OpenSSL 3 (pkeyutl -rawin) is not on PATH'}
fi
if [[ -n ${skip_reason} ]]; then
  printf 'SKIP: the host-migration e2e suite needs real root and the Ubuntu toolchain (%s)\n' "${skip_reason}" >&2
  summary
  exit 0
fi
# Machine-readable positive marker: CI's step greps for it, so a run that
# self-skipped again can never look green.
echo 'FICUS host-migration e2e section: ENABLED'

SCRATCH=$(mktemp -d -t host-migrate-e2e-test.XXXXXX)
BG_PIDS=()
cleanup() {
  local pid
  for pid in ${BG_PIDS[@]+"${BG_PIDS[@]}"}; do
    kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
  done
  rm -rf "${SCRATCH}"
}
trap cleanup EXIT

REAL_CURL=$(command -v curl)
REAL_SLEEP=$(command -v sleep)
BUN_VERSION=$(bun --version | tr -d '[:space:]')

# ------------------------------------------------------------ toolkit copies
# TK is the whole toolkit; TK_NOTMPL has no systemd/ templates — the shape
# apply-artifacts.sh has on a tenant. Both get the test plugin appended to
# their lib.sh; E2E_MIGRATIONS (from host_env) registers its migrations, and
# without it the real registry stands.
TK="${SCRATCH}/toolkit"
TK_NOTMPL="${SCRATCH}/toolkit-notmpl"
mkdir -p "${TK}" "${TK_NOTMPL}"
cp -a "${SCRIPT_DIR}/." "${TK}/"
cp -a "${SCRIPT_DIR}/." "${TK_NOTMPL}/"
rm -rf "${TK_NOTMPL}/systemd"

# The mutation proofs: E2E_MUTATE=N edits both toolkit copies (never the real
# lib.sh) so that the cases which must catch the fault go red.
#   1  delete `trap '' PIPE`                                  → E3c
#   2  host_migrate_on_exit returns 0 at once                  → E3 before the flip
#   3  _hm_direction ignores a migration's _settle             → E7 (b) (c)
#   4  host_migrate_backup_restore no longer re-renders the
#      units of a UNITS_EXCLUDED set                            → E5
#   5  host_migrate_restore_pending returns 0 at once          → E2
mutate_toolkit() { # LIB_SH
  [[ -n ${E2E_MUTATE:-} ]] || return 0
  local before
  before=$(cksum <"$1")
  python3 - "$1" "${E2E_MUTATE}" <<'PYEOF'
import sys
path, which = sys.argv[1], sys.argv[2]
src = open(path).read()
edits = {
    "1": ("  trap '' PIPE\n", ""),
    "2": ("host_migrate_on_exit() { # RC\n", "host_migrate_on_exit() { # RC\n  return 0\n"),
    "3": ('    declare -F "host_migration_${m}_settle" >/dev/null || continue\n', "    continue\n"),
    "4": ('    if ! (\n      install_core_units "${SCRIPT_DIR}/systemd"\n', "    if ! (\n      true\n"),
    "5": ("host_migrate_restore_pending() {\n  host_migrate_settle_pending\n}\n", "host_migrate_restore_pending() {\n  return 0\n}\n"),
}
if which not in edits:
    sys.exit("E2E_MUTATE=%s: no such mutation (1-5)" % which)
old, new = edits[which]
if src.count(old) != 1:
    sys.exit("E2E_MUTATE=%s: the text to mutate is not in lib.sh exactly once" % which)
open(path, "w").write(src.replace(old, new))
PYEOF
  [[ $(cksum <"$1") != "${before}" ]] || {
    printf 'E2E_MUTATE=%s changed nothing in %s\n' "${E2E_MUTATE}" "$1" >&2
    exit 2
  }
  printf 'E2E_MUTATE=%s applied to %s\n' "${E2E_MUTATE}" "$1" >&2
}

for tk in "${TK}" "${TK_NOTMPL}"; do
  mutate_toolkit "${tk}/lib.sh"
  cat >>"${tk}/lib.sh" <<'PLUGIN'
# ---- host-migrate-e2e test plugin (appended to a scratch copy by host-migrate-e2e.test.sh; never shipped)
host_migration_e2emark_needed() { [[ -f $1/NEEDS_E2EMARK ]] && ! grep -qx 'E2EMARK=1' "${SRC_DEST}/.env"; }
host_migration_e2emark_apply() {
  grep -qx 'E2EMARK=1' "${SRC_DEST}/.env" || printf 'E2EMARK=1\n' >>"${SRC_DEST}/.env"
  grep -qx 'E2EMARK=1' "${BACKUP_ENV_TARGET}" || printf 'E2EMARK=1\n' >>"${BACKUP_ENV_TARGET}"
  [[ -e ${FICUS_MANAGED_ENV_PATH} ]] || printf 'FICUS_E2E_MANAGED=1\n' >"${FICUS_MANAGED_ENV_PATH}"
}
host_migration_e2emark_absent() { printf '%s\n' "${FICUS_MANAGED_ENV_PATH}"; }
host_migration_e2emove_needed() { [[ -f $1/NEEDS_E2EMOVE && -d ${E2E_DATA:?} ]]; }
host_migration_e2emove_apply() {
  local s=${HOST_MIGRATE_BACKUP_SET:?}
  [[ -e $s/E2EMOVE_DONE ]] && return 0
  mv "${E2E_DATA}" "${E2E_DATA}.moved" && printf 'E2EMOVE=1\n' >>"${SRC_DEST}/.env" || return 1
  [[ ! -e ${E2E_CTL:?}/fail-e2emove ]] || return 1
  : >"$s/E2EMOVE_DONE"
}
host_migration_e2emove_settle() { if [[ -e $1/E2EMOVE_DONE ]]; then echo forward; else echo restore; fi; }
host_migration_e2emove_reverse() { if [[ -d ${E2E_DATA}.moved && ! -e ${E2E_DATA} ]]; then mv "${E2E_DATA}.moved" "${E2E_DATA}"; fi; }
if [[ -n ${E2E_MIGRATIONS:-} ]]; then read -r -a HOST_MIGRATIONS <<<"${E2E_MIGRATIONS}"; fi
PLUGIN
done

# The unit names and the artifact root, from lib.sh itself (a layout-2 host:
# no migration of the layout is involved here).
eval "$(bash -c 'source "$1/lib.sh"; host_layout_resolve 2; declare -p HL_UNIT_API HL_UNIT_WORKER HL_UNIT_BACKUP HL_NEW_ARTIFACT_ROOT_PREFIX' _ "${TK}")"

# --------------------------------------------------------------- PATH shims
SHIM="${SCRATCH}/shim"
CTL="${SCRATCH}/ctl" # control files the shims read
mkdir -p "${SHIM}" "${CTL}"
CALLS="${CTL}/calls"
: >"${CALLS}"
mkfifo "${CTL}/fifo"

# systemctl: record; optionally block (on a FIFO) or fail one verb. A block
# file holding N > 1 lets N-1 calls of its verb through first. Each call is
# also traced with what the host looked like at that moment: whether .env
# carries the e2emark migration, and which release `current` names.
cat >"${SHIM}/systemctl" <<SHIMEOF
#!/usr/bin/env bash
printf 'systemctl %s\n' "\$*" >>"${CALLS}"
verb=\${1:-}
d=\$(cat "${CTL}/dest" 2>/dev/null)
st=plain
grep -qx 'E2EMARK=1' "\${d}/.env" 2>/dev/null && st=marked
printf '%s env=%s cur=%s\n' "\${verb}" "\${st}" "\$(basename "\$(readlink "\${d}/current" 2>/dev/null)" 2>/dev/null)" >>"${CTL}/trace"
if [[ -f ${CTL}/block-\${verb} ]]; then
  n=\$(cat "${CTL}/block-\${verb}" 2>/dev/null)
  if [[ \${n} =~ ^[0-9]+\$ && \${n} -gt 1 ]]; then
    printf '%s' "\$((n - 1))" >"${CTL}/block-\${verb}"
  else
    rm -f "${CTL}/block-\${verb}"
    printf '%s' "\$\$" >"${CTL}/blocked.pid"
    read -r _ <"${CTL}/fifo" || true
    exit 1
  fi
fi
[[ -f ${CTL}/fail-\${verb} ]] && exit 1
case "\${verb}" in
  show) printf '0\n' ;;
esac
exit 0
SHIMEOF
printf '#!/usr/bin/env bash\nexit 0\n' >"${SHIM}/journalctl"
printf '#!/usr/bin/env bash\nexit 0\n' >"${SHIM}/sleep"
printf '#!/usr/bin/env bash\nexit 0\n' >"${SHIM}/pg_dump"
printf '#!/usr/bin/env bash\nexit 0\n' >"${SHIM}/pg_restore"
# swapon: report an unrelated active swap device, so ensure_swapfile leaves
# the (container) host alone.
printf '#!/usr/bin/env bash\n[[ " $* " == *" --show"* ]] && printf "/dev/test-swap\\n"\nexit 0\n' >"${SHIM}/swapon"
# curl: the core's /health probe is answered here — healthy only when
# <dest>/current resolves to a release matching one of the globs in
# ctl/healthy; anything else is the real curl (file:// artifact downloads).
cat >"${SHIM}/curl" <<SHIMEOF
#!/usr/bin/env bash
for a in "\$@"; do
  if [[ \${a} == */health ]]; then
    cur=\$(basename "\$(readlink -f "\$(cat "${CTL}/dest")/current" 2>/dev/null)" 2>/dev/null)
    while IFS= read -r glob; do
      # shellcheck disable=SC2053 # a glob on purpose
      if [[ -n \${cur} && -n \${glob} && \${cur} == \${glob} ]]; then
        printf '200'
        exit 0
      fi
    done <"${CTL}/healthy"
    exit 7
  fi
  # setup-host.sh's seed and report phases: an instance that already has an
  # admin (a re-run on an existing host), so neither seeds anything.
  if [[ \${a} == */api/auth/status ]]; then
    printf '{"mode":"password","hasAdminUser":true,"emailConfigured":false}'
    exit 0
  fi
done
exec ${REAL_CURL} "\$@"
SHIMEOF
chmod +x "${SHIM}"/*
# A non-interactive shell starts background jobs with SIGINT/SIGQUIT ignored,
# and bash cannot trap a signal that was ignored when it started. The
# background runs go through this, which puts both back to the default (what
# a terminal session gives the toolkit) before exec'ing the command — and
# SIGPIPE too, which python itself ignores and exec would otherwise pass on
# (masking exactly the dropped-connection case below).
cat >"${SCRATCH}/sigdefault" <<'SIGEOF'
#!/usr/bin/env python3
import os, signal, sys
signal.signal(signal.SIGINT, signal.SIG_DFL)
signal.signal(signal.SIGQUIT, signal.SIG_DFL)
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
os.execvp(sys.argv[1], sys.argv[1:])
SIGEOF
chmod +x "${SCRATCH}/sigdefault"

# ------------------------------------------------------------ artifact fixture
openssl genpkey -algorithm ed25519 -out "${SCRATCH}/key.pem" 2>/dev/null
openssl pkey -in "${SCRATCH}/key.pem" -pubout -out "${SCRATCH}/pub.pem" 2>/dev/null
PUBKEY_B64=$(base64 -w0 <"${SCRATCH}/pub.pem")

# The manifest, exactly as scripts/artifact/lib/manifest.ts builds it, for a
# Ficus release (envPrefix FICUS) with an optional hostLayout.
cat >"${SCRATCH}/manifest.py" <<'PYEOF'
import hashlib, json, os, sys

root, commit, bun_version = sys.argv[1:4]
host_layout = sys.argv[4] if len(sys.argv) > 4 else ""
files = {}
for dirpath, _dirnames, filenames in os.walk(root):
    for name in filenames:
        path = os.path.join(dirpath, name)
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        if rel == "artifact.json":
            continue
        with open(path, "rb") as handle:
            files[rel] = "sha256:" + hashlib.sha256(handle.read()).hexdigest()
files = dict(sorted(files.items()))
digest = "sha256:" + hashlib.sha256(json.dumps(files, separators=(",", ":")).encode()).hexdigest()
manifest = {"schema": 1, "commit": commit, "commitDate": "2026-09-29T00:00:00Z", "bun": bun_version,
            "platform": "linux-x64", "builder": "test:fixture", "envPrefix": "FICUS"}
if host_layout:
    manifest["hostLayout"] = int(host_layout)
manifest["files"] = files
manifest["digest"] = digest
sys.stdout.write(json.dumps(manifest, indent=2) + "\n")
PYEOF

# A release tree: the root package.json, and a migrate.js the candidate
# migration runs (a no-op here).
make_tree() { # DIR
  mkdir -p "$1/apps/core/dist"
  printf '{"name":"ficus","private":true,"workspaces":[]}\n' >"$1/package.json"
  printf '// the candidate migration (test fixture: nothing to migrate)\n' >"$1/apps/core/dist/migrate.js"
}

# Publish a signed artifact: prints the four FICUS_ARTIFACT_* assignments.
# Each MARKER (NEEDS_E2EMARK, NEEDS_E2EMOVE) is a file in the release tree.
publish() { # NAME SHA [MARKER...]
  local work="${SCRATCH}/pub-$1" sha=$2 tree m
  shift 2
  tree="${work}/staging/${HL_NEW_ARTIFACT_ROOT_PREFIX}${sha}"
  mkdir -p "${work}/dist"
  make_tree "${tree}"
  for m in "$@"; do : >"${tree}/${m}"; done
  python3 "${SCRATCH}/manifest.py" "${tree}" "${sha}" "${BUN_VERSION}" >"${work}/dist/artifact.json"
  cp "${work}/dist/artifact.json" "${tree}/artifact.json"
  openssl pkeyutl -sign -inkey "${SCRATCH}/key.pem" -rawin -in "${work}/dist/artifact.json" -out "${work}/dist/artifact.sig.raw"
  base64 -w0 <"${work}/dist/artifact.sig.raw" >"${work}/dist/artifact.sig"
  tar -C "${work}/staging" -czf "${work}/dist/release.tar.gz" "${HL_NEW_ARTIFACT_ROOT_PREFIX}${sha}"
  printf 'FICUS_ARTIFACT_TARBALL_URL=file://%s\n' "${work}/dist/release.tar.gz"
  printf 'FICUS_ARTIFACT_MANIFEST_URL=file://%s\n' "${work}/dist/artifact.json"
  printf 'FICUS_ARTIFACT_SIG_URL=file://%s\n' "${work}/dist/artifact.sig"
  printf 'FICUS_ARTIFACT_PUBKEY_B64=%s\n' "${PUBKEY_B64}"
}
SHA_OLD='1111111111111111111111111111111111111111'
SHA_MARK='5555555555555555555555555555555555555555'
SHA_MOVE='7777777777777777777777777777777777777777'
ART_MARK="${SCRATCH}/mark.artifact.env"
ART_MOVE="${SCRATCH}/move.artifact.env"
publish mark "${SHA_MARK}" NEEDS_E2EMARK >"${ART_MARK}"
publish move "${SHA_MOVE}" NEEDS_E2EMOVE >"${ART_MOVE}"

# ---------------------------------------------------------------- fake host
# A layout-2 host on an older Ficus release, with every host config file the
# framework backs up (managed.env excepted: e2emark creates it), a data dir
# for e2emove, and its config under ${H}/setup.
unit() { printf '%s/units/%s' "${H}" "$1"; } # unit FILE-NAME-UNDER-THE-UNIT-DIR
SNAP_FILES=(dest/.env etc/managed.env etc/backup.env setup/ficus-setup.yaml bin/nightly-backup.sh
  "units/${HL_UNIT_API}.service" "units/${HL_UNIT_WORKER}.service" "units/${HL_UNIT_API}.service.d/extra.conf"
  "units/${HL_UNIT_BACKUP}.service" "units/${HL_UNIT_BACKUP}.timer")
MIGS=e2emark
EXTRA_ENV=()
new_host() { # NAME
  H="${SCRATCH}/host-$1"
  DEST="${H}/dest"
  OLD_REL="${DEST}/releases/${SHA_OLD}-000000000000"
  mkdir -p "${OLD_REL}" "${H}/etc" "${H}/units/${HL_UNIT_API}.service.d" "${H}/bin" "${H}/sysbin" "${H}/stage" "${H}/setup" "${H}/root" "${H}/data"
  make_tree "${OLD_REL}"
  printf '{"schema":1,"commit":"%s","envPrefix":"FICUS"}\n' "${SHA_OLD}" >"${OLD_REL}/artifact.json"
  printf '{"sha":"x"}\n' >"${OLD_REL}/.ficus-release-complete"
  ln -sfn "${OLD_REL}" "${DEST}/current"
  : >"${H}/data/x"
  printf '%s' "${DEST}" >"${CTL}/dest"
  basename "${OLD_REL}" >"${CTL}/healthy"
  printf 'DATABASE_URL=postgres://user:pw@localhost/db\nFICUS_ENCRYPTION_KEY=enc-key-1\nFICUS_PASSWORD=pw-1\nFICUS_SANDBOX_RUNTIME=host\nAPP_URL=https://acme.ficus.sh\n' >"${DEST}/.env"
  printf "FICUS_BACKUP_S3_ACCESS_KEY='ak'\nFICUS_BACKUP_S3_SECRET_KEY='sk'\nFICUS_BACKUP_PASSPHRASE='pp'\n" >"${H}/etc/backup.env"
  printf '#!/usr/bin/env bash\n# the nightly backup (test fixture)\nDEST=%s\n' "${DEST}" >"${H}/bin/nightly-backup.sh"
  printf '[Service]\nWorkingDirectory=%s/current/apps/core\nEnvironment=FICUS_ROOT=%s/current\n' "${DEST}" "${DEST}" >"$(unit "${HL_UNIT_API}.service")"
  printf '[Service]\nWorkingDirectory=%s/current/apps/core\nEnvironment=FICUS_ROOT=%s/current\n' "${DEST}" "${DEST}" >"$(unit "${HL_UNIT_WORKER}.service")"
  printf '[Service]\nLimitNOFILE=4096\n' >"$(unit "${HL_UNIT_API}.service.d/extra.conf")"
  printf '[Service]\nType=oneshot\nExecStart=%s\n' "${H}/bin/nightly-backup.sh" >"$(unit "${HL_UNIT_BACKUP}.service")"
  printf '[Timer]\nOnCalendar=*-*-* 03:15:00\n' >"$(unit "${HL_UNIT_BACKUP}.timer")"
  chmod 0600 "${DEST}/.env" "${H}/etc/backup.env"
  chmod 0755 "${H}/bin/nightly-backup.sh"
  cat >"${H}/setup/ficus-setup.yaml" <<YAMLEOF
source:
  mode: artifact
  repo: https://example.invalid/core.git
  dest: ${DEST}
core:
  origin: https://acme.ficus.sh
  port: 3999
  run_user: root
database:
  mode: external
  dsn: postgres://user:pw@localhost/db
runtime:
  sandbox: host
backup:
  enabled: false
YAMLEOF
  CONFIG="${H}/setup/ficus-setup.yaml"
  : >"${CALLS}"
  : >"${CTL}/trace"
  rm -f "${CTL}"/block-* "${CTL}"/fail-* "${CTL}/blocked.pid"
  MIGS=e2emark
  EXTRA_ENV=()
  snapshot "${H}/pristine"
}
# Copies of every host config file into DIR (a file that does not exist is
# recorded as such, and must still not exist to compare the same).
snapshot() { # DIR
  local f
  mkdir -p "$1"
  for f in "${SNAP_FILES[@]}"; do
    mkdir -p "$1/$(dirname "${f}")"
    if [[ -e ${H}/${f} ]]; then cp -p "${H}/${f}" "$1/${f}"; else : >"$1/${f}.ABSENT"; fi
  done
}
# "same" when every snapshotted file is byte-identical to the live one (and
# every file absent then is absent now); otherwise the ones that differ.
# --no-units leaves the core units out.
same_as() { # DIR [--no-units]
  local f diff=''
  for f in "${SNAP_FILES[@]}"; do
    if [[ ${2:-} == --no-units ]] && [[ ${f} == "units/${HL_UNIT_API}.service" || ${f} == "units/${HL_UNIT_WORKER}.service" ]]; then
      continue
    fi
    if [[ -e $1/${f}.ABSENT ]]; then
      [[ ! -e ${H}/${f} ]] || diff+=" ${f}(created)"
    else
      cmp -s "$1/${f}" "${H}/${f}" || diff+=" ${f}"
    fi
  done
  printf '%s' "${diff:-same}"
}
# "same" when every MANIFEST entry of SETDIR matches its live file (the
# #requires-reverse line is not an entry).
same_as_manifest() { # SETDIR
  local idx _sha path diff=''
  while IFS=$'\t' read -r idx _sha path; do
    [[ ${idx} == '#'* ]] && continue
    cmp -s "$1/${idx}" "${path}" || diff+=" ${path}"
  done <"$1/MANIFEST"
  printf '%s' "${diff:-same}"
}
sets() { find "${H}/bk" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' '; }
first_set() { find "${H}/bk" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | head -n 1; }
pending() { [[ -e ${H}/bk/PENDING ]] && echo pending || echo none; }
marked() { grep -qx 'E2EMARK=1' "$1" 2>/dev/null && echo marked || echo plain; }
moved() { # where the data dir is, and whether .env carries the move
  printf '%s:%s' "$([[ -d ${H}/data && ! -e ${H}/data.moved ]] && echo data || echo data.moved)" "$(grep -c '^E2EMOVE=1$' "${DEST}/.env" || true)"
}
healthy_add() { printf '%s\n' "$1" >>"${CTL}/healthy"; }
# The Ruling-29 invariant, restated for e2emark: without a journal, .env
# carries E2EMARK=1 exactly when the ACTIVE release is one that needs it (a
# marked .env under an unmarked release, or the reverse, with nothing pending
# to reconcile them, is a stranded host).
assert_converged() { # LABEL
  local cur
  [[ $(pending) == none ]] || {
    PASS=$((PASS + 1))
    return 0
  }
  cur=$(readlink -f -- "${DEST}/current" 2>/dev/null || printf '%s' "${DEST}")
  expect_eq "$1: .env carries the migration exactly when the active release needs it (no journal)" \
    "$(marked "${DEST}/.env")" "$([[ -f ${cur}/NEEDS_E2EMARK ]] && echo marked || echo plain)"
}

# Run an entrypoint as the fake host sees it. ARTIFACT_ENV names the file of
# FICUS_ARTIFACT_* assignments (or '' for none). Sets RC and OUT.
host_env() {
  printf '%s\n' \
    "PATH=${SHIM}:${PATH}" \
    "FICUS_HOST_ROOT=${H}/root" \
    "FICUS_SYSTEMD_UNIT_DIR=${H}/units" \
    "FICUS_MANAGED_ENV_PATH=${H}/etc/managed.env" \
    "BACKUP_ENV_TARGET=${H}/etc/backup.env" \
    "BACKUP_SCRIPT_PATH=${H}/bin/nightly-backup.sh" \
    "HOST_MIGRATE_BACKUP_ROOT=${H}/bk" \
    "HOST_MIGRATE_LEGACY_BACKUP_ROOT=${H}/bk-legacy" \
    "FICUS_SYSTEM_BIN_DIR=${H}/sysbin" \
    "E2E_MIGRATIONS=${MIGS}" \
    "E2E_DATA=${H}/data" \
    "E2E_CTL=${CTL}" \
    ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}
}
run_script() { # [--tk TOOLKIT_DIR] ARTIFACT_ENV SCRIPT ARGS...
  local tk=${TK}
  if [[ $1 == --tk ]]; then
    tk=$2
    shift 2
  fi
  local artifact_env=$1 script=$2
  shift 2
  local -a envs=()
  mapfile -t envs < <(host_env)
  [[ -z ${artifact_env} ]] || mapfile -t -O "${#envs[@]}" envs <"${artifact_env}"
  RC=0
  OUT=$(env "${envs[@]}" bash "${tk}/${script}" "$@" 2>&1) || RC=$?
  verbose_out "${script} $*"
}
verbose_out() { # LABEL
  [[ -z ${E2E_VERBOSE:-} ]] || printf '\n===== %s (rc %s)\n%s\n' "$1" "${RC}" "${OUT}" >&2
}
# Start an entrypoint in the background in its own process group; output goes
# to ${H}/bg.out.
start_bg() { # ARTIFACT_ENV SCRIPT ARGS...
  local artifact_env=$1 script=$2
  shift 2
  local -a envs=()
  mapfile -t envs < <(host_env)
  [[ -z ${artifact_env} ]] || mapfile -t -O "${#envs[@]}" envs <"${artifact_env}"
  setsid "${SCRATCH}/sigdefault" env "${envs[@]}" bash "${TK}/${script}" "$@" >"${H}/bg.out" 2>&1 &
  BG_PID=$!
  BG_PIDS+=("${BG_PID}")
}
wait_blocked() { # wait (bounded) until a shim reports it is blocked
  local _try
  for _try in $(seq 1 600); do
    [[ -s ${CTL}/blocked.pid ]] && return 0
    "${REAL_SLEEP}" 0.1
  done
  printf 'test: the run never reached the blocking shim; output:\n%s\n' "$(cat "${H}/bg.out" 2>/dev/null)" >&2
  return 1
}
release_block() { # unblock the FIFO reader (bounded)
  timeout 10 bash -c "printf 'go\n' >'${CTL}/fifo'" || true
}
wait_bg() { # sets RC and OUT; bounded
  local _try
  for _try in $(seq 1 600); do
    kill -0 "${BG_PID}" 2>/dev/null || break
    "${REAL_SLEEP}" 0.1
  done
  RC=0
  # Braces + 2>/dev/null: no "Killed" job notice from bash for a KILLed group.
  { wait "${BG_PID}" || RC=$?; } 2>/dev/null
  OUT=$(cat "${H}/bg.out")
  verbose_out 'background run'
}
kill_bg() { kill -KILL -- "-${BG_PID}" 2>/dev/null || kill -KILL "${BG_PID}"; }

upgrade() { run_script "$1" upgrade-host.sh --config "${CONFIG}"; }
# The systemctl calls, one line: `verb args|verb args|…`.
calls_line() { sed 's/^systemctl //' "${CALLS}" | tr '\n' '|'; }

# ========================================= E1. a migration on upgrade (§1)
new_host happy
healthy_add "${SHA_MARK}-*"
upgrade "${ART_MARK}"
expect_eq 'E1 upgrade onto a release that needs e2emark: exits 0' "${RC}" '0'
[[ ${RC} -eq 0 ]] || printf '%s\n' "${OUT}" >&2
expect_eq 'E1: .env and backup.env are migrated, managed.env is created' \
  "$(marked "${DEST}/.env"):$(marked "${H}/etc/backup.env"):$(cat "${H}/etc/managed.env" 2>/dev/null)" 'marked:marked:FICUS_E2E_MANAGED=1'
expect_eq 'E1: one backup set, no journal' "$(sets):$(pending)" '1:none'
expect_eq "E1: the set's copy of .env is the host's .env before the upgrade" \
  "$(cmp -s "$(first_set)/1" "${H}/pristine/dest/.env" && echo same)" 'same'
expect_match 'E1: the trailer reports no rollback' "${OUT}" 'FICUS_RELEASE_ROLLED_BACK=0'
expect_match 'E1: current is the new release' "$(readlink "${DEST}/current")" "${SHA_MARK}-"
# The migration's own daemon-reload — the first one that sees the migrated
# .env — comes while the OLD release is current, and before the activation's
# restart.
expect_match "E1: the migration's daemon-reload (before the flip) precedes the restart" \
  "$(tr '\n' '|' <"${CTL}/trace")" "^([^|]*\\|)*daemon-reload env=marked cur=${SHA_OLD}-[0-9]+\\|([^|]*\\|)*restart env=marked cur=${SHA_MARK}-"
expect_eq 'E1: no restart before the migration ran' "$(grep -m1 '^restart ' "${CTL}/trace" | cut -d' ' -f2)" 'env=marked'
upgrade "${ART_MARK}"
expect_eq 'E1: re-running the upgrade exits 0, still one set, no journal' "${RC}:$(sets):$(pending)" '0:1:none'
assert_converged 'E1'

# ======================================== E2. failed health check: roll back (§2)
new_host rollback # only the old release is healthy
upgrade "${ART_MARK}"
expect_eq 'E2 unhealthy new release: the upgrade fails' "$([[ ${RC} -ne 0 ]] && echo failed)" 'failed'
expect_match 'E2: FICUS_RELEASE_ROLLED_BACK=1' "${OUT}" 'FICUS_RELEASE_ROLLED_BACK=1'
expect_eq 'E2: every host config file is byte-identical to before (managed.env removed again)' "$(same_as "${H}/pristine")" 'same'
expect_eq 'E2: no journal is left' "$(pending)" 'none'
expect_eq 'E2: current is back on the old release' "$(readlink "${DEST}/current")" "${OLD_REL}"
expect_match 'E2: the failing restart, then the restore (its daemon-reload), then the rollback restart' \
  "$(tr '\n' '|' <"${CALLS}")" 'systemctl restart[^|]*\|.*systemctl daemon-reload\|.*systemctl restart'
expect_eq 'E2: the rollback restart is the last service action (no restore after it)' \
  "$(grep -E '^systemctl (restart|daemon-reload)' "${CALLS}" | tail -n 1 | cut -d' ' -f2)" 'restart'
assert_converged 'E2'

# ============================== E3. signals: files follow the ACTIVE release (§3)
for sig in TERM HUP INT; do
  case ${sig} in
    TERM) want_rc=143 ;;
    HUP) want_rc=129 ;;
    INT) want_rc=130 ;;
  esac
  # --- after the flip: blocked in the activation's restart.
  new_host "after-flip-${sig}"
  : >"${CTL}/block-restart"
  start_bg "${ART_MARK}" upgrade-host.sh --config "${CONFIG}"
  wait_blocked || true
  expect_match "E3 SIG${sig} after the flip: stopped with the new release active" "$(readlink "${DEST}/current")" "${SHA_MARK}-"
  kill "-${sig}" "${BG_PID}"
  release_block
  wait_bg
  expect_eq "E3 SIG${sig} after the flip: exits ${want_rc}" "${RC}" "${want_rc}"
  expect_eq "E3 SIG${sig} after the flip: the files stay migrated (what the active release needs)" \
    "$(marked "${DEST}/.env"):$(marked "${H}/etc/backup.env")" 'marked:marked'
  expect_eq "E3 SIG${sig} after the flip: the migration is committed (no journal)" "$(pending)" 'none'
  assert_converged "E3 SIG${sig} after the flip"

  # --- before the flip: blocked on the migration's own daemon-reload.
  new_host "before-flip-${sig}"
  : >"${CTL}/block-daemon-reload"
  start_bg "${ART_MARK}" upgrade-host.sh --config "${CONFIG}"
  wait_blocked || true
  set_dir=$(first_set)
  expect_eq "E3 SIG${sig} before the flip: the run was stopped after migrating (journaled, .env migrated)" \
    "$(pending):$(marked "${DEST}/.env")" 'pending:marked'
  kill "-${sig}" "${BG_PID}"
  release_block
  wait_bg
  expect_eq "E3 SIG${sig} before the flip: exits ${want_rc}" "${RC}" "${want_rc}"
  expect_eq "E3 SIG${sig} before the flip: every file is byte-identical to the MANIFEST" "$(same_as_manifest "${set_dir}")" 'same'
  expect_eq "E3 SIG${sig} before the flip: ...which is the host as it was" "$(same_as "${H}/pristine")" 'same'
  expect_eq "E3 SIG${sig} before the flip: no journal, current unmoved" "$(pending):$(readlink "${DEST}/current")" "none:${OLD_REL}"
  assert_converged "E3 SIG${sig} before the flip"
done

# =============== E3b. SIGKILL after the flip: the reconcile finishes FORWARD (§3b)
new_host kill-after-flip
: >"${CTL}/block-restart"
start_bg "${ART_MARK}" upgrade-host.sh --config "${CONFIG}"
wait_blocked || true
kill_bg
wait_bg
expect_eq 'E3b SIGKILL after the flip: the journal is left, the files migrated' "$(pending):$(marked "${DEST}/.env")" 'pending:marked'
expect_match 'E3b: current is the new release' "$(readlink "${DEST}/current")" "${SHA_MARK}-"
# The next toolkit run — here the control plane's artifact sync, from a
# toolkit copy without the unit templates — reconciles.
run_script --tk "${TK_NOTMPL}" '' apply-artifacts.sh --config "${CONFIG}" "${H}/stage"
expect_eq 'E3b: apply-artifacts.sh --config then applies (exit 0)' "${RC}" '0'
[[ ${RC} -eq 0 ]] || printf '%s\n' "${OUT}" >&2
expect_match 'E3b: its reconcile finished the migration forward' "${OUT}" 'reconcile: finished the host migration'
expect_eq 'E3b: files migrated, journal committed' "$(marked "${DEST}/.env"):$(pending)" 'marked:none'
assert_converged 'E3b'

# ============== E3c. the control connection drops (SIGPIPE on the next write) (§3c)
# The upgrade's stdout/stderr go to a reader that is killed mid-run — what a
# dropped SSH session does. The next log write must not kill the script
# before its traps can settle the migration.
run_with_reader_killed() { # NAME BLOCK_VERB
  local -a envs=()
  new_host "$1"
  : >"${CTL}/block-$2"
  mapfile -t envs < <(host_env)
  mapfile -t -O "${#envs[@]}" envs <"${ART_MARK}"
  mkfifo "${H}/out.fifo"
  (
    rc=0
    setsid "${SCRATCH}/sigdefault" env "${envs[@]}" bash "${TK}/upgrade-host.sh" --config "${CONFIG}" >"${H}/out.fifo" 2>&1 || rc=$?
    printf '%s' "${rc}" >"${H}/rc"
  ) &
  BG_PID=$!
  BG_PIDS+=("${BG_PID}")
  cat "${H}/out.fifo" >"${H}/seen.log" &
  local reader=$!
  wait_blocked || true
  kill -KILL "${reader}" 2>/dev/null || true
  { wait "${reader}" || true; } 2>/dev/null
  release_block
  local _try
  for _try in $(seq 1 600); do
    [[ -s ${H}/rc ]] && break
    "${REAL_SLEEP}" 0.1
  done
  RC=$(cat "${H}/rc" 2>/dev/null || echo none)
}
run_with_reader_killed pipe-before-flip daemon-reload
expect_eq 'E3c reader gone before the flip: the script did not die of SIGPIPE' "$([[ ${RC} != 141 && ${RC} != none ]] && echo ok || echo "rc ${RC}")" 'ok'
expect_eq 'E3c reader gone before the flip: the host is restored byte for byte' "$(same_as "${H}/pristine")" 'same'
expect_eq 'E3c reader gone before the flip: no journal, current unmoved' "$(pending):$(readlink "${DEST}/current")" "none:${OLD_REL}"
assert_converged 'E3c reader gone before the flip'
run_with_reader_killed pipe-after-flip restart
expect_eq 'E3c reader gone after the flip: the script did not die of SIGPIPE' "$([[ ${RC} != 141 && ${RC} != none ]] && echo ok || echo "rc ${RC}")" 'ok'
expect_eq 'E3c reader gone after the flip: no journal is left' "$(pending)" 'none'
assert_converged 'E3c reader gone after the flip'

# ============ E4. SIGKILL between the migration and the flip, then re-run (§4)
new_host crash
: >"${CTL}/block-daemon-reload" # the migration's own daemon-reload
start_bg "${ART_MARK}" upgrade-host.sh --config "${CONFIG}"
wait_blocked || true
kill_bg
wait_bg
expect_eq 'E4 SIGKILL mid-migration: the journal is left behind' "$(pending)" 'pending'
expect_eq 'E4: current never moved' "$(readlink "${DEST}/current")" "${OLD_REL}"
expect_eq 'E4: the host really was migrated (nothing restored it)' "$(marked "${DEST}/.env")" 'marked'
crash_set=$(first_set)
healthy_add "${SHA_MARK}-*" # both releases healthy for the re-run
upgrade "${ART_MARK}"
expect_eq 'E4: the re-run with the same inputs exits 0' "${RC}" '0'
[[ ${RC} -eq 0 ]] || printf '%s\n' "${OUT}" >&2
expect_match 'E4: its reconcile restored the set (the journaled release was not active)' "${OUT}" 'reconcile: restored'
expect_match 'E4: ...and then it migrated again' "${OUT}" 'reconcile: restored.*running host migration\(s\) e2emark'
expect_eq 'E4: then migrated and completed' "$(marked "${DEST}/.env"):$(pending)" 'marked:none'
expect_eq 'E4: two sets (the restored one and the committed one)' "$(sets)" '2'
expect_eq 'E4: the first set still matches the host as it was' \
  "$(cmp -s "${crash_set}/1" "${H}/pristine/dest/.env" && echo same)" 'same'
assert_converged 'E4'

# ============== E5. conversion (git -> artifact) that rolls back (§5)
# A git checkout at <dest>; the upgrade converts it (the checkout becomes
# releases/git-<sha>, the units are re-rendered onto <dest>/current) and the
# migration's set then leaves the units out (UNITS_EXCLUDED). The new release
# is unhealthy; while its restart is blocked the units are changed (what a
# release's own unit render could do), and the rollback's restore must render
# them again for the current layout rather than keep that.
convert_host() { # NAME
  new_host "$1"
  rm -f "${DEST}/current"
  rm -rf "${DEST}/releases"
  make_tree "${DEST}"
  (
    cd "${DEST}"
    git init -q
    git -c user.email=t@example.com -c user.name=t add package.json apps
    git -c user.email=t@example.com -c user.name=t commit -q -m checkout
  )
  CONV_SHA=$(git -C "${DEST}" rev-parse HEAD)
  printf 'git-%s\n' "${CONV_SHA}" >"${CTL}/healthy" # only the converted checkout is healthy
  snapshot "${H}/pristine"
}
# The unit NAME.service as lib.sh renders it for this host's current layout.
expected_unit() { # api|worker
  bash -c 'source "$1/lib.sh"
    SRC_DEST=$2 RUN_USER=root DB_MODE=external BUN_BIN=/usr/local/bin/bun CORE_LAYOUT=artifact
    render_core_unit "$1/systemd/ficus-$3.service.tmpl"' _ "${TK}" "${DEST}" "$1"
}
convert_host convert
: >"${CTL}/block-restart"
start_bg "${ART_MARK}" upgrade-host.sh --config "${CONFIG}"
wait_blocked || true
printf '# changed while the new release was starting\n' | tee -a "$(unit "${HL_UNIT_API}.service")" >>"$(unit "${HL_UNIT_WORKER}.service")"
release_block
wait_bg
expect_eq 'E5 converted host, unhealthy new release: the upgrade fails' "$([[ ${RC} -ne 0 ]] && echo failed)" 'failed'
expect_match 'E5: rolled back' "${OUT}" 'FICUS_RELEASE_ROLLED_BACK=1'
expect_eq 'E5: current is the converted checkout' "$(readlink "${DEST}/current")" "${DEST}/releases/git-${CONV_SHA}"
expect_eq 'E5: the set excluded the units' "$([[ -e $(first_set)/UNITS_EXCLUDED ]] && echo excluded)" 'excluded'
expect_eq 'E5: every other host config file is restored byte for byte' "$(same_as "${H}/pristine" --no-units)" 'same'
expect_eq 'E5: the units are re-rendered for the current layout' \
  "$(cmp -s <(expected_unit api) "$(unit "${HL_UNIT_API}.service")" && echo api):$(cmp -s <(expected_unit worker) "$(unit "${HL_UNIT_WORKER}.service")" && echo worker)" 'api:worker'
expect_eq 'E5: ...running from <dest>/current' \
  "$(grep -hc "^Environment=FICUS_ROOT=${DEST}/current$" "$(unit "${HL_UNIT_API}.service")" "$(unit "${HL_UNIT_WORKER}.service")" | tr '\n' ' ')" '1 1 '
expect_eq 'E5: no journal is left' "$(pending)" 'none'
assert_converged 'E5'

# ===== E5b. a conversion killed in the migration, reconciled without templates
# SIGKILL on the migration's daemon-reload (the conversion's own comes first).
convert_host convert-killed
printf '2' >"${CTL}/block-daemon-reload"
start_bg "${ART_MARK}" upgrade-host.sh --config "${CONFIG}"
wait_blocked || true
kill_bg
wait_bg
e5b_set=$(first_set)
expect_eq 'E5b conversion killed mid-migration: journaled, the set excluded the units, .env migrated' \
  "$(pending):$([[ -e ${e5b_set}/UNITS_EXCLUDED ]] && echo excluded):$(marked "${DEST}/.env")" 'pending:excluded:marked'
snapshot "${H}/killed"
run_script --tk "${TK_NOTMPL}" '' apply-artifacts.sh --config "${CONFIG}" "${H}/stage"
expect_eq 'E5b: apply-artifacts.sh --config (no unit templates) refuses (exit 1)' "${RC}" '1'
expect_match 'E5b: ...because its reconcile could not re-render the units (rc 3)' "${OUT}" 'could not be reconciled \(3\)'
expect_eq 'E5b: ...keeping the journal and changing nothing' "$(pending):$(same_as "${H}/killed")" 'pending:same'
run_script '' upgrade-host.sh --restore-host-backup "${e5b_set}"
expect_eq 'E5b: --restore-host-backup of that set without --config: refused (exit 1)' "${RC}" '1'
expect_match 'E5b: ...naming --config' "${OUT}" 'pass --config'
expect_eq 'E5b: ...changing nothing' "$(pending):$(same_as "${H}/killed")" 'pending:same'
healthy_add "${SHA_MARK}-*"
upgrade "${ART_MARK}"
expect_eq 'E5b: the next upgrade (the full toolkit) exits 0' "${RC}" '0'
[[ ${RC} -eq 0 ]] || printf '%s\n' "${OUT}" >&2
expect_match 'E5b: its reconcile restored the set' "${OUT}" 'reconcile: restored'
expect_eq 'E5b: the units run from <dest>/current' \
  "$(grep -hc "^Environment=FICUS_ROOT=${DEST}/current$" "$(unit "${HL_UNIT_API}.service")" "$(unit "${HL_UNIT_WORKER}.service")" | tr '\n' ' ')" '1 1 '
expect_eq 'E5b: the upgrade completed: migrated, no journal, the new release current' \
  "$(marked "${DEST}/.env"):$(pending):$([[ $(readlink "${DEST}/current") == *"/${SHA_MARK}-"* ]] && echo new)" 'marked:none:new'
assert_converged 'E5b'

# ============ E6. setup-host.sh re-run on a host a SIGKILL left journaled (§9)
# setup-host.sh really preflights (Linux + systemd + Ubuntu 24.04, packages,
# bun) before it reaches its source phase; that needs a systemd host (CI's
# runner) or a container prepared with /run/systemd/system.
e6_skip=''
[[ -d /run/systemd/system ]] || e6_skip='no /run/systemd/system (not a systemd host)'
if [[ -z ${e6_skip} ]] && ! { grep -q '^ID=ubuntu' /etc/os-release && grep -q '^VERSION_ID="24.04"' /etc/os-release; } 2>/dev/null; then
  e6_skip='not Ubuntu 24.04'
fi
if [[ -z ${e6_skip} ]]; then
  new_host setup-rerun
  : >"${CTL}/block-daemon-reload"
  start_bg "${ART_MARK}" upgrade-host.sh --config "${CONFIG}"
  wait_blocked || true
  kill_bg
  wait_bg
  expect_eq 'E6 (fixture): the killed upgrade left the host migrated and journaled' "$(pending):$(marked "${DEST}/.env")" 'pending:marked'
  : >"${CALLS}"
  run_script "${ART_MARK}" setup-host.sh --config "${CONFIG}"
  expect_eq 'E6 setup-host.sh re-run, only the old release healthy: fails' "$([[ ${RC} -ne 0 ]] && echo failed)" 'failed'
  expect_match 'E6: its reconcile restored the journaled set first, then it migrated' "${OUT}" \
    'reconcile: restored.*running host migration\(s\) e2emark'
  expect_match 'E6: the activation failed and rolled back' "${OUT}" 'FICUS_RELEASE_ROLLED_BACK=1'
  expect_match 'E6: the rollback hook restored (its daemon-reload) before the rollback restart' \
    "$(tr '\n' '|' <"${CALLS}")" 'systemctl restart[^|]*\|.*systemctl daemon-reload\|.*systemctl restart'
  expect_eq 'E6: the rollback restart is the last service action (no restore after it)' \
    "$(grep -E '^systemctl (restart|daemon-reload)' "${CALLS}" | tail -n 1 | cut -d' ' -f2)" 'restart'
  expect_eq 'E6: no journal, current unmoved' "$(pending):$(readlink "${DEST}/current")" "none:${OLD_REL}"
  expect_eq 'E6: every host config file is byte-identical to before' "$(same_as "${H}/pristine")" 'same'
  assert_converged 'E6'
else
  printf 'SKIP E6: %s — E1-E5b stay the gate\n' "${e6_skip}" >&2
fi

# ============= E7. the _settle / _reverse hooks end to end (E2E_MIGRATIONS=e2emove)
# (a) the migration fails before its commit point: reversed, then restored.
new_host move-fail
MIGS=e2emove
: >"${CTL}/fail-e2emove"
upgrade "${ART_MOVE}"
expect_eq 'E7a e2emove fails before its commit point: the upgrade fails' "$([[ ${RC} -ne 0 ]] && echo failed)" 'failed'
expect_eq 'E7a: the MANIFEST says the set must be reversed first' "$(head -n 1 "$(first_set)/MANIFEST")" $'#requires-reverse\te2emove'
expect_eq 'E7a: the move is reversed and .env restored byte for byte' \
  "$(moved):$(cmp -s "${H}/pristine/dest/.env" "${DEST}/.env" && echo same)" 'data:0:same'
expect_eq 'E7a: no journal, current unmoved' "$(pending):$(readlink "${DEST}/current")" "none:${OLD_REL}"

# (b) TERM after the commit point (E2EMOVE_DONE), before the flip: the
# migration settles FORWARD — whatever release is active.
new_host move-term
MIGS=e2emove
: >"${CTL}/block-daemon-reload"
start_bg "${ART_MOVE}" upgrade-host.sh --config "${CONFIG}"
wait_blocked || true
expect_eq 'E7b (fixture): stopped past the commit point, journaled' \
  "$([[ -e $(first_set)/E2EMOVE_DONE ]] && echo committed):$(pending)" 'committed:pending'
kill -TERM "${BG_PID}"
release_block
wait_bg
expect_eq 'E7b SIGTERM after the commit point: exits 143' "${RC}" '143'
expect_eq 'E7b: the move is kept, .env keeps E2EMOVE=1' "$(moved)" 'data.moved:1'
expect_eq 'E7b: committed (no journal), current unmoved' "$(pending):$(readlink "${DEST}/current")" "none:${OLD_REL}"

# (c) an unhealthy release after the commit point: rolled back, the move kept.
new_host move-unhealthy
MIGS=e2emove
upgrade "${ART_MOVE}"
expect_eq 'E7c unhealthy release after the commit point: fails and rolls back' \
  "$([[ ${RC} -ne 0 ]] && echo failed):$(readlink "${DEST}/current")" "failed:${OLD_REL}"
expect_match 'E7c: FICUS_RELEASE_ROLLED_BACK=1' "${OUT}" 'FICUS_RELEASE_ROLLED_BACK=1'
expect_eq 'E7c: the move is kept and committed' "$(moved):$(pending)" 'data.moved:1:none'

# (d) --restore-host-backup of that (marked) set: refused, nothing changed —
# also when the caller exports _HM_REVERSED=1.
e7_set=$(first_set)
snapshot "${H}/before-restore"
run_script '' upgrade-host.sh --config "${CONFIG}" --restore-host-backup "${e7_set}"
expect_eq 'E7d --restore-host-backup of a set that must be reversed first: refused (exit 1)' "${RC}" '1'
expect_match 'E7d: ...saying why' "${OUT}" 'which must be reversed first'
expect_eq 'E7d: ...changing nothing' "$(same_as "${H}/before-restore"):$(moved):$(pending)" 'same:data.moved:1:none'
EXTRA_ENV=(_HM_REVERSED=1 _HM_IN_REVERSE=1)
run_script '' upgrade-host.sh --config "${CONFIG}" --restore-host-backup "${e7_set}"
EXTRA_ENV=()
expect_eq 'E7d: ...an exported _HM_REVERSED=1 does not get it past the refusal' "${RC}" '1'
expect_eq 'E7d: ...still changing nothing' "$(same_as "${H}/before-restore"):$(moved):$(pending)" 'same:data.moved:1:none'

summary
