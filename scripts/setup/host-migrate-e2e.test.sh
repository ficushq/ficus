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
#   * a git->artifact conversion is refused before checkout/unit changes;
#   * setup-host.sh's re-run reconciles first and restores before its
#     rollback restart;
#   * the _settle / _reverse hooks: a failure before the migration's commit
#     point is reversed; after it (a signal, a rollback) it is finished
#     forward; --restore-host-backup refuses a set that must be reversed first;
#   * normal setup/upgrade of a legacy host is refused without changes;
#     the retained original migration API still produces bridge aliases and
#     the explicit --reverse-host-layout entrypoint can reverse its real set;
#   * normal restore rejects a legacy HOME backup before pg_restore/copy;
#     canonical HOME backups retain the existing restore path (EHL15);
#   * the real registry finalizes bridge hosts, restores unhealthy activations,
#     and reverses committed finalization with release parents retained.
#
# Every path the toolkit writes is pointed at the scratch directory through
# its seams (FICUS_HOST_ROOT, FICUS_SYSTEMD_UNIT_DIR, FICUS_MANAGED_ENV_PATH,
# BACKUP_ENV_TARGET, BACKUP_SCRIPT_PATH, HOST_MIGRATE_BACKUP_ROOT,
# FICUS_SYSTEM_BIN_DIR), and systemctl, journalctl, swapon, sleep, pg_dump and
# pg_restore are PATH shims — with one exception: E6 runs setup-host.sh's real
# preflight, which writes its apt lock-timeout conf under
# /etc/apt/apt.conf.d/, and would apt-get install a missing package or run the
# bun installer on a bun mismatch. So run the suite on CI's runner or in a
# throwaway container, never on a machine you care about.
# curl is a shim that answers the core's /health probe (healthy only for the
# releases the test names) and passes everything else to the real curl.
#
# The entrypoints need real root, GNU coreutils, OpenSSL 3, bun, jq, python3
# and mikefarah yq, so the suite self-skips — loudly, without the ENABLED
# marker — anywhere else. CI runs it as root; locally, run it in a throwaway
# Ubuntu 24.04 container. The setup-host.sh case (E6) also needs a systemd
# host (/run/systemd/system) and prints `SKIP E6: …` without one — except on
# CI (GITHUB_ACTIONS=true), where a skip counts as a failure.
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

# Mutation probes retained for the framework signal/rollback cases below.
# Bridge-era conversion and normal layout-1 activation probes belong to the
# retained bridge toolkit; this suite now asserts their refusal.
# 1 PIPE immunity; 2 exit reconciliation; 3 settle direction; 5 rollback restore.
mutate_toolkit() { # TOOLKIT_DIR
  [[ -n ${E2E_MUTATE:-} ]] || return 0
  local file
  file=$(python3 - "$1" "${E2E_MUTATE}" <<'PYEOF'
import sys
tk, which = sys.argv[1], sys.argv[2]
edits = {
    "1": ("lib.sh", "  trap '' PIPE\n", ""),
    "2": ("lib.sh", "host_migrate_on_exit() { # RC\n", "host_migrate_on_exit() { # RC\n  return 0\n"),
    "3": ("lib.sh", '    declare -F "host_migration_${m}_settle" >/dev/null || continue\n', "    continue\n"),
    "5": ("lib.sh", "host_migrate_restore_pending() {\n  host_migrate_settle_pending\n}\n", "host_migrate_restore_pending() {\n  return 0\n}\n"),
}
if which not in edits:
    sys.exit("E2E_MUTATE=%s: no such mutation (supported: 1, 2, 3, 5)" % which)
name, old, new = edits[which]
path = tk + "/" + name
src = open(path).read()
if src.count(old) != 1:
    sys.exit("E2E_MUTATE=%s: the text to mutate is not in %s exactly once" % (which, name))
open(path, "w").write(src.replace(old, new))
print(path)
PYEOF
  ) || exit 2
  printf 'E2E_MUTATE=%s applied to %s\n' "${E2E_MUTATE}" "${file}" >&2
}

for tk in "${TK}" "${TK_NOTMPL}"; do
  mutate_toolkit "${tk}"
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
    exit "\$(cat "${CTL}/block-rc" 2>/dev/null || echo 1)"
  fi
fi
[[ -f ${CTL}/fail-\${verb} ]] && exit 1
# E2E_UNIT_EMULATION (the host_layout hosts): enable/disable/is-enabled act on
# FICUS_SYSTEMD_UNIT_DIR the way systemd does — a wants link per WantedBy=, a
# link per Alias= — so the Alias= bridge and the reverse can be checked on disk.
if [[ -n \${E2E_UNIT_EMULATION:-} && -n \${FICUS_SYSTEMD_UNIT_DIR:-} ]]; then
  U=\${FICUS_SYSTEMD_UNIT_DIR}
  norm() { case \$1 in *.service | *.timer | *.socket | *.target) printf '%s' "\$1" ;; *) printf '%s.service' "\$1" ;; esac; }
  case "\${verb}" in
    reenable)
      "\$0" disable "\${@:2}" && "\$0" enable "\${@:2}"
      exit \$?
      ;;
    enable | disable)
      shift
      for a in "\$@"; do
        [[ \${a} == --* ]] && continue
        u=\$(norm "\${a}") f="\${U}/\$(norm "\${a}")"
        if [[ \${verb} == enable ]]; then
          [[ -f \${f} ]] || { echo "Unit file \${u} does not exist." >&2; exit 1; }
          while IFS= read -r t; do mkdir -p "\${U}/\${t}.wants" && ln -sfn "\${f}" "\${U}/\${t}.wants/\${u}"; done < <(sed -n 's/^WantedBy=//p' "\${f}")
          while IFS= read -r al; do ln -sfn "\${f}" "\${U}/\${al}"; done < <(sed -n 's/^Alias=//p' "\${f}")
        else
          for l in "\${U}"/*.wants/"\${u}" "\${U}"/*; do
            if [[ -L \${l} ]] && [[ \${l} == "\${U}"/*.wants/"\${u}" || \$(readlink "\${l}") == "\${f}" ]]; then rm -f "\${l}"; fi
          done
        fi
      done
      exit 0
      ;;
    is-enabled)
      u=\$(norm "\${2:-}")
      for l in "\${U}"/*.wants/"\${u}"; do if [[ -L \${l} ]]; then echo enabled; exit 0; fi; done
      echo disabled
      exit 1
      ;;
  esac
fi
case "\${verb}" in
  show)
    if [[ -n \${E2E_FIN_RUNTIME:-} && "\$*" == *ActiveState* ]]; then
      u=\$(norm "\${@: -1}")
      if [[ -f "${CTL}/runtime-\${u}" ]]; then cat "${CTL}/runtime-\${u}"
      elif [[ \${u} == *backup.service ]]; then echo inactive
      else echo active; fi
    else printf '0\n'; fi ;;
  start | stop)
    if [[ -n \${E2E_FIN_RUNTIME:-} ]]; then
      shift
      for u in "\$@"; do
        [[ \${u} != --* ]] || continue
        state=active; [[ \${verb} != stop ]] || state=inactive
        printf '%s\n' "\${state}" >"${CTL}/runtime-\$(norm "\${u}")"
      done
    fi ;;
esac
exit 0
SHIMEOF
printf '#!/usr/bin/env bash\nexit 0\n' >"${SHIM}/journalctl"
printf '#!/usr/bin/env bash\nexit 0\n' >"${SHIM}/sleep"
printf '#!/usr/bin/env bash\nexit 0\n' >"${SHIM}/pg_dump"
printf '#!/usr/bin/env bash\nprintf pg_restore\\n >> "${E2E_REBASE_PROOF:?}.restore"\n' >"${SHIM}/pg_restore"
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
# getent: root's home under the fake host root when E2E_ROOT_HOME says so (the
# host_layout hosts, whose HOME_DIR is the run user's default); else the real one.
REAL_GETENT=$(command -v getent)
cat >"${SHIM}/getent" <<SHIMEOF
#!/usr/bin/env bash
if [[ \${1:-} == passwd && \${2:-} == root && -n \${E2E_ROOT_HOME:-} ]]; then
  printf 'root:x:0:0:root:%s:/bin/bash\n' "\${E2E_ROOT_HOME}"
  exit 0
fi
exec ${REAL_GETENT} "\$@"
SHIMEOF
# docker and visudo: record argv (a host_layout move on an external-database,
# root-run host calls neither).
printf '#!/usr/bin/env bash\nprintf "docker %%s\\n" "$*" >>"%s"\nexit 0\n' "${CTL}/tools" >"${SHIM}/docker"
printf '#!/usr/bin/env bash\nprintf "visudo %%s\\n" "$*" >>"%s"\nexit 0\n' "${CTL}/tools" >"${SHIM}/visudo"
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
host_layout = sys.argv[4] if len(sys.argv) > 4 else "2"
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
# Each MARKER (NEEDS_E2EMARK, NEEDS_E2EMOVE) is a file in the release tree;
# PUB_HOST_LAYOUT sets the manifest's hostLayout.
publish() { # NAME SHA [MARKER...]
  local work="${SCRATCH}/pub-$1" sha=$2 tree m
  shift 2
  tree="${work}/staging/${HL_NEW_ARTIFACT_ROOT_PREFIX}${sha}"
  mkdir -p "${work}/dist"
  make_tree "${tree}"
  for m in "$@"; do : >"${tree}/${m}"; done
  # PUB_REBASE: the release's rebase-home program, a stub that records its argv.
  if [[ -n ${PUB_REBASE:-} ]]; then
    printf '%s\n' "require('node:fs').appendFileSync(process.env.E2E_REBASE_PROOF, process.argv.slice(2).join(' ') + '\\n')" \
      >"${tree}/apps/core/dist/rebase-home.js"
  fi
  # PUB_ORDER: the migration records itself in the same proof, and the rebase
  # stub records whether the install root's `current` existed when it ran.
  if [[ -n ${PUB_ORDER:-} ]]; then
    printf '%s\n' "require('node:fs').appendFileSync(process.env.E2E_REBASE_PROOF, 'migrate\\n')" \
      >"${tree}/apps/core/dist/migrate.js"
    printf '%s\n' "const fs = require('node:fs'); fs.appendFileSync(process.env.E2E_REBASE_PROOF, process.argv.slice(2).join(' ') + ' current=' + fs.existsSync('../../../../current') + '\\n')" \
      >"${tree}/apps/core/dist/rebase-home.js"
  fi
  python3 "${SCRATCH}/manifest.py" "${tree}" "${sha}" "${BUN_VERSION}" ${PUB_HOST_LAYOUT:+"${PUB_HOST_LAYOUT}"} >"${work}/dist/artifact.json"
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
  printf '{"schema":1,"commit":"%s","envPrefix":"FICUS","hostLayout":2}\n' "${SHA_OLD}" >"${OLD_REL}/artifact.json"
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
  HOST_KIND=e2e
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
  if [[ ${HOST_KIND:-e2e} == layout1 ]]; then
    # A host_layout host: its paths are the layout's defaults under the root.
    printf '%s\n' \
      "PATH=${SHIM}:${PATH}" \
      "FICUS_HOST_ROOT=${R}" \
      "FICUS_SYSTEMD_UNIT_DIR=${U}" \
      "HOST_MIGRATE_BACKUP_ROOT=${H}/bk" \
      "HOST_MIGRATE_LEGACY_BACKUP_ROOT=${H}/bk-legacy" \
      "FICUS_SYSTEM_BIN_DIR=${H}/sysbin" \
      "E2E_MIGRATIONS=" \
      "E2E_CTL=${CTL}" \
      "E2E_UNIT_EMULATION=1" \
      "E2E_ROOT_HOME=${R}/root" \
      "E2E_REBASE_PROOF=${H}/rebase-proof" \
      ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}
    return 0
  fi
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
upgrade "${ART_MARK}"
expect_eq 'E5 C-FIN refuses git-to-artifact conversion' "${RC}" 1
expect_match 'E5 conversion guidance names bridge toolkit' "${OUT}" 'ficus-host-layout-bridge'
expect_eq 'E5 refusal leaves checkout/config/runtime/journals untouched' "$(same_as "${H}/pristine"):$(git -C "$DEST" rev-parse HEAD):$(sets):$(pending):$(wc -l <"$CALLS")" "same:${CONV_SHA}:0:none:0"
expect_eq 'E5 no release tree or current is created' "$([[ ! -e $DEST/releases && ! -L $DEST/current ]] && echo untouched)" untouched

# ============ E6. setup-host.sh re-run on a host a SIGKILL left journaled (§9)
# setup-host.sh really preflights (Linux + systemd + Ubuntu 24.04, packages,
# bun) before it reaches its source phase; that needs a systemd host (CI's
# runner) or a container prepared with /run/systemd/system.
e6_skip=''
[[ -d /run/systemd/system ]] || e6_skip='no /run/systemd/system (not a systemd host)'
if [[ -z ${e6_skip} ]] && ! { grep -q '^ID=ubuntu' /etc/os-release && grep -q '^VERSION_ID="24.04"' /etc/os-release; } 2>/dev/null; then
  e6_skip='not Ubuntu 24.04'
fi
# On CI (GitHub's Ubuntu 24.04 systemd runner) E6 must run: a skip there is a failure.
if [[ -n ${e6_skip} && ${GITHUB_ACTIONS:-} == true ]]; then
  FAIL=$((FAIL + 1))
  printf 'FAIL: E6 must run on CI, but it would skip: %s\n' "${e6_skip}" >&2
  e6_skip=''
  [[ -d /run/systemd/system ]] || e6_skip='no /run/systemd/system (counted as a failure above)'
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

# ================================================================== host_layout
# Legacy refusal and explicit original inverse, with no normal-readiness bypass,
# on a fleet-shaped layout-1 host, built under FICUS_HOST_ROOT=${H}/root from
# lib.sh's HL_LEGACY_* constants (never retyped). Its units, backup script,
# backup.env and managed.env sit at their resolved defaults under the root (no
# path seams); only the backup-set root is outside it (${H}/bk). The systemctl
# shim emulates enable/disable (wants and Alias= links), getent answers root's
# home under the root, and the candidate carries an apps/core/dist/rebase-home.js
# stub that records its argv in ${H}/rebase-proof.
eval "$(bash -c 'source "$1/lib.sh"; declare -p HL_LEGACY_DEST HL_LEGACY_ETC HL_LEGACY_SETUP_DIR HL_LEGACY_SETUP_YAML \
  HL_LEGACY_UNIT_PREFIX HL_LEGACY_BACKUP_SCRIPT HL_LEGACY_HOME_NAME HL_LEGACY_RELEASE_MARKER HL_NEW_DEST HL_NEW_ETC \
  HL_NEW_SETUP_DIR HL_NEW_SETUP_YAML HL_NEW_UNIT_PREFIX HL_NEW_BACKUP_SCRIPT HL_NEW_HOME_NAME' _ "${TK}")"
L_API="${HL_LEGACY_UNIT_PREFIX}-api" L_WORKER="${HL_LEGACY_UNIT_PREFIX}-worker" L_BACKUP="${HL_LEGACY_UNIT_PREFIX}-backup"
N_API="${HL_NEW_UNIT_PREFIX}-api" N_WORKER="${HL_NEW_UNIT_PREFIX}-worker"
SHA_L2='2222222222222222222222222222222222222222'
SHA_PLAIN='3333333333333333333333333333333333333333'
ART_L2="${SCRATCH}/l2.artifact.env"
ART_PLAIN="${SCRATCH}/plain.artifact.env"
PUB_HOST_LAYOUT=2 PUB_REBASE=1 publish l2 "${SHA_L2}" >"${ART_L2}"
PUB_HOST_LAYOUT=1 PUB_REBASE=1 publish plain "${SHA_PLAIN}" >"${ART_PLAIN}"
SHA_RST='4444444444444444444444444444444444444444'
ART_RST="${SCRATCH}/rst.artifact.env"
PUB_HOST_LAYOUT=2 PUB_ORDER=1 publish rst "${SHA_RST}" >"${ART_RST}"

# Render a toolkit-owned file for this host as lib.sh renders it on LAYOUT.
l1_render() { # LAYOUT FUNCTION ARGS...
  local layout=$1
  shift
  FICUS_HOST_ROOT="${R}" FICUS_SYSTEMD_UNIT_DIR="${U}" bash -c '
    source "$1/lib.sh"; host_layout_resolve "$2"; SRC_DEST=$3; shift 3
    RUN_USER=root BUN_BIN=/usr/local/bin/bun DB_MODE=external CORE_LAYOUT=artifact
    "$@"' _ "${TK}" "${layout}" "${DEST}" "$@"
}
new_l1_host() { # NAME
  H="${SCRATCH}/host-$1"
  R="${H}/root"
  U="${R}/etc/systemd/system"
  DEST="${R}${HL_LEGACY_DEST}"
  NEW_DEST="${R}${HL_NEW_DEST}"
  OLD_REL="${DEST}/releases/${SHA_OLD}-000000000000"
  local rel
  mkdir -p "${U}/multi-user.target.wants" "${U}/timers.target.wants" "${R}${HL_LEGACY_ETC}/artifacts" \
    "${R}${HL_LEGACY_SETUP_DIR}" "${R}/root/${HL_LEGACY_HOME_NAME}/inbox-attachments" "${R}/root/${HL_LEGACY_HOME_NAME}/sessions" "${R}/usr/local/bin" \
    "${H}/sysbin" "${H}/stage"
  for rel in "${SHA_OLD}-000000000000" prev-0000 older-3 older-2 older-1; do
    mkdir -p "${DEST}/releases/${rel}"
    make_tree "${DEST}/releases/${rel}"
    printf '{"schema":1,"commit":"%s","envPrefix":"FICUS","hostLayout":1}\n' "${rel}" >"${DEST}/releases/${rel}/artifact.json"
    printf '{"sha":"%s"}\n' "${rel}" >"${DEST}/releases/${rel}/${HL_LEGACY_RELEASE_MARKER}"
  done
  touch -d '2026-01-01 00:00:03' "${DEST}/releases/older-1"
  touch -d '2026-01-01 00:00:02' "${DEST}/releases/older-2"
  touch -d '2026-01-01 00:00:01' "${DEST}/releases/older-3"
  ln -s "${OLD_REL}" "${DEST}/current"
  ln -s "${DEST}/releases/prev-0000" "${DEST}/previous"
  # The fleet's .env: no HOME_DIR, an external DSN whose sslrootcert names the
  # CA under the legacy etc dir (URL-encoded).
  printf 'DATABASE_URL=postgresql://tenant_x:pw@db.example:25060/x?sslmode=verify-full&sslrootcert=%s\nFICUS_ENCRYPTION_KEY=enc-key-1\nFICUS_PASSWORD=pw-1\nFICUS_SANDBOX_RUNTIME=host\nAPP_URL=https://acme.ficus.sh\n' \
    "$(printf '%s/database-ca.crt' "${HL_LEGACY_ETC}" | sed 's:/:%2F:g')" >"${DEST}/.env"
  chmod 0600 "${DEST}/.env"
  printf 'att\n' >"${R}/root/${HL_LEGACY_HOME_NAME}/inbox-attachments/a.txt"
  printf 'SES=1\n' >"${R}${HL_LEGACY_ETC}/managed.env"
  printf "FICUS_BACKUP_S3_ACCESS_KEY='ak'\nFICUS_BACKUP_S3_SECRET_KEY='sk'\nFICUS_BACKUP_PASSPHRASE='pp'\n" >"${R}${HL_LEGACY_ETC}/backup.env"
  printf 'ca\n' >"${R}${HL_LEGACY_ETC}/database-ca.crt"
  chmod 0600 "${R}${HL_LEGACY_ETC}/managed.env" "${R}${HL_LEGACY_ETC}/backup.env"
  CONFIG="${R}${HL_LEGACY_SETUP_DIR}/${HL_LEGACY_SETUP_YAML}"
  NEW_CONFIG="${R}${HL_NEW_SETUP_DIR}/${HL_NEW_SETUP_YAML}"
  cat >"${CONFIG}" <<YAMLEOF
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
  # The units, backup script and backup units exactly as this toolkit renders
  # them on layout 1 (so a run that changes nothing leaves them byte-identical).
  l1_render 1 install_core_units "${TK}/systemd"
  l1_render 1 install_rendered 0755 root root "${R}${HL_LEGACY_BACKUP_SCRIPT}" render_backup_script_content \
    "${TK}/ficus-backup.sh.tmpl" "${DEST}" "${R}/root/${HL_LEGACY_HOME_NAME}" external '' https://s3.example.com us-east-1 bucket tenants/acme \
    "${R}${HL_LEGACY_ETC}/backup.env"
  l1_render 1 install_rendered 0644 root root "${U}/${L_BACKUP}.service" render_backup_unit_content \
    "${TK}/systemd/ficus-backup.service.tmpl" "${R}${HL_LEGACY_BACKUP_SCRIPT}" '*-*-* 03:15:00' external
  l1_render 1 install_rendered 0644 root root "${U}/${L_BACKUP}.timer" render_backup_unit_content \
    "${TK}/systemd/ficus-backup.timer.tmpl" "${R}${HL_LEGACY_BACKUP_SCRIPT}" '*-*-* 03:15:00' external
  ln -s "${U}/${L_API}.service" "${U}/multi-user.target.wants/${L_API}.service"
  ln -s "${U}/${L_WORKER}.service" "${U}/multi-user.target.wants/${L_WORKER}.service"
  ln -s "${U}/${L_BACKUP}.timer" "${U}/timers.target.wants/${L_BACKUP}.timer"
  printf '%s' "${DEST}" >"${CTL}/dest"
  basename "${OLD_REL}" >"${CTL}/healthy"
  : >"${CALLS}"
  : >"${CTL}/trace"
  rm -f "${CTL}"/block-* "${CTL}"/fail-* "${CTL}/blocked.pid"
  HOST_KIND=layout1
  MIGS=''
  EXTRA_ENV=()
  snap_root >"${H}/pristine.snap"
}
# Every path under the host root with its type, link target and mode, then
# every regular file's sha256 — the staged releases, the release links and the
# artifact staging dir left out (a run always moves those).
snap_root() {
  (
    cd "${R}" &&
      find . -printf '%p %y %l %m\n' | grep -vE '/(releases|current|previous|\.incoming)( |/)' | LC_ALL=C sort &&
      find . -type f -exec sha256sum {} + | grep -vE ' \./.*/(releases|\.incoming)/' | LC_ALL=C sort -k2
  )
}
# The layout lib.sh detects on this host, as a fresh toolkit process sees it.
l_detect() { FICUS_HOST_ROOT="${R}" FICUS_SYSTEMD_UNIT_DIR="${U}" bash -c 'source "$1/lib.sh"; host_layout_detect' _ "${TK}"; }
# The machine-readable trailer lines, in order.
trailer() { grep -E '^FICUS_[A-Z_]+=' <<<"${OUT}" | tr '\n' '|'; }
hl_set() { grep -l "$(printf '^#requires-reverse\thost_layout$')" "${H}"/bk/*/MANIFEST 2>/dev/null | head -n 1 | xargs -r dirname; }

# Normal finalized entrypoints refuse layout1; the retained migration API is
# still independently exercised, and its explicit inverse remains reachable.
for command in upgrade-host.sh setup-host.sh; do
 new_l1_host "refuse-$command"
 before=$(snap_root)
 run_script "$ART_L2" "$command" --config "$CONFIG"
 expect_eq "C-FIN $command refuses legacy host" "$RC" 1
 expect_match "C-FIN $command names bridge release" "$OUT" 'ficus-host-layout-bridge'
 expect_eq "C-FIN $command no runtime/data/journal effects" "$(snap_root):$(sets):$(pending):$(wc -l <"$CALLS")" "$before:0:none:0"
done
new_l1_host explicit-reverse
# Seed an authentic committed original migration without going through a
# normal C-FIN upgrade. No readiness bypass is added to production or toolkit.
cat >"$TK/seed-bridge-fixture.sh" <<'SEED'
#!/bin/bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib.sh"
cfg_load "$1"
SRC_DEST=$(cfg_source_dest) RUN_USER=root BUN_BIN=/usr/local/bin/bun DB_MODE=external CORE_LAYOUT=artifact
HOST_MIGRATIONS=(host_layout)
release="$SRC_DEST/releases/fixture-layout2"
mkdir -p "$release/apps/core/dist"
printf '{"hostLayout":2}\n' >"$release/artifact.json"
printf '// isolated rebase fixture\n' >"$release/apps/core/dist/rebase-home.js"
host_migrate "$release"
host_migrate_commit
SEED
run_script '' seed-bridge-fixture.sh "$CONFIG"
expect_eq 'retained original migration API commits with bridge aliases' "$RC:$(l_detect)" '0:2'
[[ $RC == 0 ]] || printf '%s\n' "$OUT" >&2
reverse_set=$(hl_set)
expect_eq 'original migration explicitly rendered bridge alias despite normal default0' "$(readlink "$U/$L_API.service")" "$U/$N_API.service"
# Core still serves the original layout1 artifact, exactly the manual inverse prerequisite.
run_script '' upgrade-host.sh --config "$NEW_CONFIG" --reverse-host-layout "$reverse_set"
expect_eq 'explicit original reverse bypasses normal finalized readiness gate' "$RC:$(l_detect):$(pending)" '0:1:none'
[[ $RC == 0 ]] || printf '%s\n' "$OUT" >&2
expect_eq 'explicit inverse preserves original current and data' "$(readlink "$DEST/current"):$(cat "$R/root/$HL_LEGACY_HOME_NAME/inbox-attachments/a.txt")" "$OLD_REL:att"
run_script '' upgrade-host.sh --config "$CONFIG" --reverse-host-layout "$reverse_set"
expect_eq 'explicit inverse cannot repeat committed reversal' "$RC" 1

# Actual registered finalizer wiring through upgrade and explicit inverse.
for health in healthy unhealthy; do
 new_l1_host "finalize-$health"
 run_script '' seed-bridge-fixture.sh "$CONFIG"
 expect_eq "finalize $health bridge fixture commits" "$RC" 0
 # Fleet prerequisites: both old releases now declare layout2 and use canonical CA.
 for manifest in "$NEW_DEST"/releases/*/artifact.json; do
   jq '.hostLayout=2' "$manifest" >"$manifest.new"; mv "$manifest.new" "$manifest"
 done
 sed -i "s|${HL_LEGACY_ETC##*/}%2F|ficus%2F|g" "$NEW_DEST/.env"
 DEST=$NEW_DEST CONFIG=$NEW_CONFIG
 # Rewriting fixture manifests above changes directory mtimes. Establish the
 # retention order now so inverse mtime restoration has a stable oracle.
 touch -d '2026-01-01 00:00:03' "$DEST/releases/older-1"
 touch -d '2026-01-01 00:00:02' "$DEST/releases/older-2"
 touch -d '2026-01-01 00:00:01' "$DEST/releases/older-3"
 printf '%s' "$DEST" >"$CTL/dest"
 EXTRA_ENV=(E2E_FIN_RUNTIME=1)
 rm -f "$CTL"/runtime-*
 before=$(snap_root)
 cp "$U/$N_API.service" "$H/bridge-api"
 [[ $health != healthy ]] || healthy_add "${SHA_L2}-*"
 upgrade "$ART_L2"
 fin_set=$(grep -l "$(printf '^#requires-reverse\thost_layout_fin$')" "$H"/bk/*/MANIFEST | head -n1 | xargs dirname)
 if [[ $health == unhealthy ]]; then
   expect_eq 'registered finalize unhealthy activation fails with rollback' "$RC" 1
   expect_match 'registered finalize unhealthy rollback is reported' "$OUT" 'FICUS_RELEASE_ROLLED_BACK=1'
   expect_eq 'registered finalize rollback restores original units/aliases/links' "$(cmp -s "$U/$N_API.service" "$H/bridge-api" && echo bytes):$(readlink "$U/$L_API.service"):$(readlink "$R$HL_LEGACY_DEST"):$(pending)" "bytes:$U/$N_API.service:$NEW_DEST:none"
 else
   expect_eq 'registered finalize healthy activation succeeds' "$RC" 0
   [[ $RC == 0 ]] || printf '%s\n' "$OUT" >&2
   expect_eq 'registered finalize removes physical legacy links and Alias bytes' "$([[ ! -L $R$HL_LEGACY_DEST && ! -L $U/$L_API.service ]] && echo removed):$(grep -c '^Alias=' "$U/$N_API.service" || true):$(pending)" 'removed:0:none'
   expect_eq 'retention preserves old release parents needed by finalize inverse' "$([[ -d $DEST/releases/older-1 && -d $DEST/releases/older-2 && -d $DEST/releases/older-3 ]] && echo retained)" retained
   upgrade "$ART_L2"
   expect_eq 'registered finalize repeat remains successful' "$RC" 0
   run_script '' upgrade-host.sh --config "$CONFIG" --reverse-host-layout "$fin_set"
   expect_eq 'explicit committed finalize inverse succeeds' "$RC" 0
   [[ $RC == 0 ]] || printf '%s\n' "$OUT" >&2
   expect_eq 'committed finalize inverse restores original aliases and bytes' "$(cmp -s "$U/$N_API.service" "$H/bridge-api" && echo bytes):$(readlink "$U/$L_API.service"):$(readlink "$R$HL_LEGACY_DEST"):$(pending)" "bytes:$U/$N_API.service:$NEW_DEST:none"
   cat >"$TK/retention-fixture.sh" <<'RETAIN'
#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
artifact_retention "$1"
RETAIN
   run_script '' retention-fixture.sh "$DEST"
   expect_eq 'retention releases finalize pins only after completed inverse' "$RC:$([[ -d $DEST/releases/older-3 ]] && echo pinned || echo pruned)" '0:pruned'
 fi
 EXTRA_ENV=()
done

# Fresh finalized setup and backup restoration still exercise real entrypoints.
if [[ -z ${e6_skip} ]]; then
  # ============ EHL12. setup-host.sh on a FRESH host: set up on layout 2 throughout —
  # install root, etc dir, units, backup units and script, HOME — and the compat
  # link for an external DSN that still names the CA under the legacy etc dir.
  H="${SCRATCH}/host-ehl12"
  R="${H}/root"
  U="${R}/etc/systemd/system"
  DEST="${R}${HL_LEGACY_DEST}"
  NEW_DEST="${R}${HL_NEW_DEST}"
  mkdir -p "${U}" "${R}/root" "${R}/usr/local/bin" "${H}/sysbin" "${H}/keys"
  printf 'ca\n' >"${H}/keys/database-ca.crt"
  CONFIG="${H}/ficus-setup.yaml"
  cat >"${CONFIG}" <<YAMLEOF
source:
  mode: artifact
  repo: https://example.invalid/core.git
  dest: ${NEW_DEST}
core:
  origin: https://acme.ficus.sh
  port: 3999
  run_user: root
database:
  mode: external
  ca_path: ${H}/keys/database-ca.crt
runtime:
  sandbox: host
backup:
  enabled: true
  s3_endpoint: https://s3.example.com
  s3_region: us-east-1
  s3_bucket: acme-backups
  s3_prefix: tenants/acme
YAMLEOF
  printf '%s' "${NEW_DEST}" >"${CTL}/dest"
  printf '%s-*\n' "${SHA_L2}" >"${CTL}/healthy"
  : >"${CALLS}"
  rm -f "${CTL}"/block-* "${CTL}"/fail-* "${CTL}/blocked.pid"
  HOST_KIND=layout1
  EXTRA_ENV=(
    "FICUS_SETUP_DATABASE_DSN=postgresql://tenant_x:pw@localhost/x?sslmode=verify-full&sslrootcert=$(printf '%s/database-ca.crt' "${HL_NEW_ETC}" | sed 's:/:%2F:g')"
    FICUS_BACKUP_S3_ACCESS_KEY=ak FICUS_BACKUP_S3_SECRET_KEY=sk FICUS_BACKUP_PASSPHRASE=pp
  )
  run_script "${ART_L2}" setup-host.sh --config "${CONFIG}"
  EXTRA_ENV=()
  expect_eq 'EHL12 setup-host.sh on a fresh host: exits 0, the host is on layout 2' "${RC}:$(l_detect)" '0:2'
  [[ ${RC} -eq 0 ]] || printf '%s\n' "${OUT}" >&2
  expect_match 'EHL12: current names the release under /opt/ficus-core' "$(readlink "${NEW_DEST}/current")" "^${NEW_DEST}/releases/${SHA_L2}-"
  expect_eq 'EHL12: canonical units enabled without old aliases' \
    "$([[ -f ${U}/${N_API}.service && -f ${U}/${N_WORKER}.service ]] && echo units):$(readlink "${U}/${L_API}.service"):$(grep -c "^systemctl enable ${N_API} ${N_WORKER}\$" "${CALLS}")" \
    "units::1"
  expect_eq 'EHL12: the units read /etc/ficus/managed.env' "$(grep -c "^EnvironmentFile=-${HL_NEW_ETC}/managed.env\$" "${U}/${N_API}.service")" '1'
  expect_eq 'EHL12: canonical CA installed without a legacy etc link' \
    "$(cat "${R}${HL_NEW_ETC}/database-ca.crt" 2>/dev/null):$([[ -e ${R}${HL_LEGACY_ETC} || -L ${R}${HL_LEGACY_ETC} ]] && echo legacy || echo absent)" 'ca:absent'
  expect_eq 'EHL12: the backup script, env and units under the Ficus names; HOME_DIR is .ficus' \
    "$(grep -E '^(DEST|HOME_DIR|BACKUP_ENV_FILE)=' "${R}${HL_NEW_BACKUP_SCRIPT}" 2>/dev/null | tr '\n' ' ')|$([[ -f ${R}${HL_NEW_ETC}/backup.env && -f ${U}/ficus-backup.service && -f ${U}/ficus-backup.timer ]] && echo units)" \
    "DEST='${NEW_DEST}' HOME_DIR='${R}/root/${HL_NEW_HOME_NAME}' BACKUP_ENV_FILE='${R}${HL_NEW_ETC}/backup.env' |units"
  expect_eq 'EHL12: static backup service is not enabled, canonical timer is enabled' \
    "$(grep -cx 'systemctl enable ficus-backup.service' "$CALLS" || true):$(grep -cx 'systemctl enable --now ficus-backup.timer' "$CALLS"):$([[ -L $U/$L_BACKUP.timer ]] && echo alias || echo absent)" '0:1:absent'
  expect_eq 'EHL12: nothing at the legacy install root or setup dir, no legacy unit file' \
    "$([[ -e ${DEST} || -e ${R}${HL_LEGACY_SETUP_DIR} || -f ${U}/${L_API}.service && ! -L ${U}/${L_API}.service ]] && echo legacy || echo none)" 'none'
  expect_match 'EHL12: the release trailer' "${OUT}" "FICUS_RELEASE_AFTER=${SHA_L2}-"

  # ============ EHL15. setup-host.sh on a FRESH host (layout 2) restoring a
  # backup: the rows of one taken on a layout-1 host name its legacy HOME, so
  # they are rebased to the Ficus HOME its tree now lives in — after the
  # candidate's migration, before the flip — and the legacy HOME becomes the
  # compat link a moved host has. One taken on layout 2 is left as it is.
  # restore_host NAME ENV_LINES WORKSPACE_DIR_NAME — a fresh host, the archive
  # (db.dump, .env, a workspace dir with sessions/), the run. Sets RC and OUT.
  restore_host() {
    H="${SCRATCH}/host-$1"
    R="${H}/root"
    U="${R}/etc/systemd/system"
    DEST="${R}${HL_LEGACY_DEST}"
    NEW_DEST="${R}${HL_NEW_DEST}"
    mkdir -p "${U}" "${R}/root" "${R}/usr/local/bin" "${H}/sysbin" "${H}/keys" "${H}/arc/$3/sessions/s1"
    printf 'ca\n' >"${H}/keys/database-ca.crt"
    printf 'dump\n' >"${H}/arc/db.dump"
    printf '%s\n' "$2" >"${H}/arc/.env"
    printf 'transcript\n' >"${H}/arc/$3/sessions/s1/log"
    tar -C "${H}/arc" -czf "${H}/backup.tar.gz" db.dump .env "$3"
    openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:restore-pp -in "${H}/backup.tar.gz" -out "${H}/backup.tar.gz.enc"
    CONFIG="${H}/ficus-setup.yaml"
    cat >"${CONFIG}" <<YAMLEOF
source:
  mode: artifact
  repo: https://example.invalid/core.git
  dest: ${NEW_DEST}
core:
  origin: https://acme.ficus.sh
  port: 3999
  run_user: root
database:
  mode: external
  ca_path: ${H}/keys/database-ca.crt
runtime:
  sandbox: host
backup:
  enabled: false
YAMLEOF
    printf '%s' "${NEW_DEST}" >"${CTL}/dest"
    printf '%s-*\n' "${SHA_RST}" >"${CTL}/healthy"
    : >"${CALLS}"
    rm -f "${CTL}"/block-* "${CTL}"/fail-* "${CTL}/blocked.pid"
    HOST_KIND=layout1
    EXTRA_ENV=(
      "FICUS_SETUP_DATABASE_DSN=postgresql://tenant_x:pw@localhost/x"
      "FICUS_SETUP_RESTORE_URL=file://${H}/backup.tar.gz.enc"
      FICUS_SETUP_RESTORE_PASSPHRASE=restore-pp
    )
    run_script "${ART_RST}" setup-host.sh --config "${CONFIG}"
    EXTRA_ENV=()
    [[ ${RC} -eq 0 ]] || printf '%s\n' "${OUT}" >&2
  }
  R_HOME_L1="${SCRATCH}/host-ehl15r/root/root/${HL_LEGACY_HOME_NAME}"
  R_HOME_L2="${SCRATCH}/host-ehl15r/root/root/${HL_NEW_HOME_NAME}"
  restore_host ehl15r 'FICUS_ENCRYPTION_KEY=archived-key' "${HL_LEGACY_HOME_NAME}"
  expect_eq 'EHL15 legacy HOME backup is refused' "$RC" 1
  expect_match 'EHL15 refusal names bridge toolkit before data restoration' "$OUT" 'legacy HOME backup needs the ficus-host-layout-bridge'
  expect_eq 'EHL15 legacy restore never calls pg_restore or copies HOME data' "$([[ -e ${H}/rebase-proof.restore || -e ${R_HOME_L2}/sessions || -L ${R_HOME_L1} ]] && echo changed || echo untouched)" untouched

  R_HOME_L2="${SCRATCH}/host-ehl15s/root/root/${HL_NEW_HOME_NAME}"
  restore_host ehl15s "$(printf 'FICUS_ENCRYPTION_KEY=archived-key\nHOME_DIR=%s' "${R_HOME_L2}")" "${HL_NEW_HOME_NAME}"
  expect_eq 'EHL15 a layout-2 backup on a fresh host: exits 0, the tree is in the Ficus HOME' \
    "${RC}:$(cat "${R_HOME_L2}/sessions/s1/log" 2>/dev/null)" '0:transcript'
  expect_eq 'EHL15: ...no stored path is rebased (only the migration ran), nothing at the legacy HOME' \
    "$(cat "${H}/rebase-proof" 2>/dev/null):$([[ -e ${R_HOME_L2%/*}/${HL_LEGACY_HOME_NAME} || -L ${R_HOME_L2%/*}/${HL_LEGACY_HOME_NAME} ]] && echo legacy || echo none)" 'migrate:none'
  expect_match 'EHL15: ...and says so' "${OUT}" 'restore: the backup was taken with this host'"'"'s HOME'
fi

summary
