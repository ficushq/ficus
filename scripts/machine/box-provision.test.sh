#!/usr/bin/env bash
# box-provision.test.sh — unit tests for box-provision.sh's pure helpers.
# Run: bash scripts/machine/box-provision.test.sh
#
# box-provision.sh dispatches at the bottom, so it cannot simply be sourced.
# Each test extracts the one function under test and evaluates it against a
# temporary archive directory.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
TARGET="${SCRIPT_DIR}/box-provision.sh"

PASS=0 FAIL=0
expect_eq() { # DESCRIPTION ACTUAL EXPECTED
  if [[ $2 == "$3" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected %q, got %q\n' "$1" "$3" "$2" >&2
  fi
}

# Pull prune_box_archives out of the script, with SUDO stubbed to nothing.
extract_prune() {
  awk '/^prune_box_archives\(\) \{/,/^}/' "${TARGET}"
}

setup_fixture() { # DIR
  local d=$1
  mkdir -p "$d"
  # Three retries of one box, plus a second box with a single archive.
  : >"$d/box_aaaaaaaaaaaa-1000.tar.gz"
  : >"$d/box_aaaaaaaaaaaa-2000.tar.gz"
  : >"$d/box_aaaaaaaaaaaa-3000.tar.gz"
  : >"$d/box_bbbbbbbbbbbb-1500.tar.gz"
  # Not ours: must survive untouched.
  : >"$d/unrelated.txt"
}

run_prune() { # DIR [RETENTION_DAYS]
  local d=$1 keep=${2:-14}
  # shellcheck disable=SC2034
  SUDO=() FICUS_ARCHIVE_DIR="$d" FICUS_ARCHIVE_RETENTION_DAYS="$keep" \
    bash -c "
      # No -u: bash 3.2 (macOS) treats \"\${SUDO[@]}\" on an EMPTY array as an
      # unbound variable, which the real script never hits because machine hosts
      # run bash 5. The function under test is what matters here, not the shell.
      set -eo pipefail
      SUDO=()
      FICUS_ARCHIVE_DIR='$d'
      FICUS_ARCHIVE_RETENTION_DAYS='$keep'
      $(extract_prune)
      prune_box_archives
    "
}

# --- supersede: one tarball per box -----------------------------------------
# Every retry of a box that cannot be removed writes ANOTHER full-size tarball.
# Three boxes doing that produced 240 tarballs and 42GB on a live machine host
# and filled its disk, which then made removal itself fail with ENOSPC.
TMP=$(mktemp -d)
setup_fixture "$TMP"
run_prune "$TMP"
expect_eq 'keeps exactly one tarball for the retried box' \
  "$(ls -1 "$TMP" | grep -c '^box_aaaaaaaaaaaa-')" '1'
expect_eq 'and it is the NEWEST one' \
  "$(ls -1 "$TMP" | grep '^box_aaaaaaaaaaaa-' || true)" 'box_aaaaaaaaaaaa-3000.tar.gz'
expect_eq 'a box with a single archive is left alone' \
  "$(ls -1 "$TMP" | grep -c '^box_bbbbbbbbbbbb-')" '1'
expect_eq 'unrelated files are never touched' \
  "$([[ -f "$TMP/unrelated.txt" ]] && echo present || echo gone)" 'present'
rm -rf "$TMP"

# --- age cap ----------------------------------------------------------------
TMP=$(mktemp -d)
setup_fixture "$TMP"
# `touch -d '30 days ago'` is GNU-only; BSD touch (macOS) needs an explicit
# stamp. python3 is present on both and this file must run on both.
old_stamp=$(python3 -c 'import time; print(time.strftime("%Y%m%d%H%M", time.localtime(time.time() - 30*86400)))')
touch -t "${old_stamp}" "$TMP/box_bbbbbbbbbbbb-1500.tar.gz"
run_prune "$TMP" 14
expect_eq 'an archive older than the retention window is removed' \
  "$(ls -1 "$TMP" | grep -c '^box_bbbbbbbbbbbb-' || true)" '0'
expect_eq 'a fresh archive survives the age cap' \
  "$(ls -1 "$TMP" | grep -c '^box_aaaaaaaaaaaa-')" '1'
rm -rf "$TMP"

# --- idempotence + empty dir ------------------------------------------------
TMP=$(mktemp -d)
setup_fixture "$TMP"
run_prune "$TMP"
before=$(ls -1 "$TMP" | wc -l | tr -d ' ')
run_prune "$TMP"
expect_eq 'a second prune changes nothing' "$(ls -1 "$TMP" | wc -l | tr -d ' ')" "$before"
rm -rf "$TMP"

TMP=$(mktemp -d)
prune_rc=0
run_prune "$TMP" || prune_rc=$?
expect_eq 'an empty archive dir is not an error' "${prune_rc}" '0'
rm -rf "$TMP"

# Housekeeping in front of a removal must never block the removal.
missing_rc=0
run_prune "/nonexistent/archive/dir" || missing_rc=$?
expect_eq 'a missing archive dir is not an error' "${missing_rc}" '0'

# --- provisioning against a fake systemd -------------------------------------
# Runs the real provision path with FICUS_HOST_ROOT pointing at a temp tree.
# Only the account and service managers are stubbed on PATH: systemctl records
# its argv and emulates enable/disable links (one wants link per WantedBy=, one
# link per Alias=), useradd/getent/id read and write a fake passwd, install drops
# its -o/-g so the run needs no real box user. The old names come from the
# script's own bridge constants. Needs GNU coreutils (mv -T, find -printf), so a
# macOS run skips it; the Linux CI and the ubuntu:24.04 container run it.
if ! mv --version 2>/dev/null | grep -q GNU; then
  echo 'SKIP: provisioning harness (needs GNU coreutils)'
else
  bridge_const() { sed -n "s/^$1=['\"]\{0,1\}\([^'\" ]*\)['\"]\{0,1\} *# ficus-p5-bridge\$/\1/p" "${TARGET}"; }
  L_SYS=$(bridge_const LEGACY_SYSTEM_UNIT_PREFIX)
  L_USER=$(bridge_const LEGACY_USER_UNIT_PREFIX)
  L_DOT=$(bridge_const LEGACY_HOME_DOT_DIR)
  L_ROOT=$(bridge_const LEGACY_ROOT)
  expect_eq 'the bridge constants are readable' \
    "$([[ -n ${L_SYS} && -n ${L_USER} && -n ${L_DOT} && -n ${L_ROOT} ]] && echo yes || echo no)" 'yes'

  BOX=box_aaaaaaaaaaaa

  shim() { # NAME BODY
    printf '#!/usr/bin/env bash\n%s\n' "$2" >"${R}/.shims/$1"
    chmod +x "${R}/.shims/$1"
  }

  make_host() {
    R=$(mktemp -d)
    mkdir -p "${R}/.shims" "${R}/etc/systemd/system" "${R}/usr/lib/systemd" "${R}/home" \
      "${R}/opt/ficus/bin" "${R}/var/lib/systemd/linger" "${R}/fakedb"
    : >"${R}/calls.log"
    printf '#!/bin/sh\n' >"${R}/usr/lib/systemd/systemd-socket-proxyd"
    chmod +x "${R}/usr/lib/systemd/systemd-socket-proxyd"
    printf 'root:x:0:0:root:/root:/bin/bash\n' >"${R}/fakedb/passwd"
    printf 'root:x:0:\nficus-browser:x:998:\n' >"${R}/fakedb/group"
    shim sudo 'if [ "$1" = -u ]; then shift 2; fi; exec "$@"'
    shim runuser 'shift 3; exec "$@"'
    shim getent 'grep -m1 "^$2:" "$STUB_R/fakedb/$1"'
    shim id '
if [ "$1" = -nG ]; then
  printf "%s" "$2"
  while IFS=: read -r group _ _ members; do
    case ",$members," in *",$2,"*) printf " %s" "$group" ;; esac
  done <"$STUB_R/fakedb/group"
  printf "\n"; exit 0
fi
if [ "$1" = -u ] && [ -n "${2:-}" ]; then l=$(grep -m1 "^$2:" "$STUB_R/fakedb/passwd") || exit 1; echo "$l" | cut -d: -f3; exit 0; fi
exec /usr/bin/id "$@"'
    shim useradd 'echo "useradd $*" >>"$STUB_R/calls.log"; u="${!#}"; echo "$u:x:1001:1001::$STUB_R/home/$u:/bin/bash" >>"$STUB_R/fakedb/passwd"; mkdir -p "$STUB_R/home/$u"'
    shim usermod '
echo "usermod $*" >>"$STUB_R/calls.log"
[ "$1" = -aG ] || exit 2
while IFS=: read -r group pass gid members; do
  if [ "$group" = "$2" ]; then
    case ",$members," in *",$3,"*) ;; *) members="${members:+$members,}$3" ;; esac
  fi
  printf "%s:%s:%s:%s\n" "$group" "$pass" "$gid" "$members"
done <"$STUB_R/fakedb/group" >"$STUB_R/fakedb/group.new"
mv "$STUB_R/fakedb/group.new" "$STUB_R/fakedb/group"'
    shim chown 'echo "chown $*" >>"$STUB_R/calls.log"'
    shim install 'a=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec /usr/bin/install "${a[@]}"'
    shim git 'for a in "$@"; do d=$a; done; case " $* " in *" init "*) mkdir -p "$d/objects" ;; esac; exit 0'
    shim loginctl '
echo "loginctl $*" >>"$STUB_R/calls.log"
case "$1" in
  enable-linger)
    touch "$STUB_R/var/lib/systemd/linger/$2"
    # A running manager retains its old supplementary groups until stopped.
    [ -f "$STUB_R/fakedb/manager-groups" ] || id -nG "$2" >"$STUB_R/fakedb/manager-groups" ;;
  disable-linger) rm -f "$STUB_R/var/lib/systemd/linger/$2" ;;
esac
exit 0'
    shim systemctl '
echo "systemctl $*" >>"$STUB_R/calls.log"
dir="$STUB_R/etc/systemd/system"; verb=""; units=""
for a in "$@"; do
  case "$a" in
    --machine=*) u=${a#--machine=}; u=${u%@.host}; dir="$(grep -m1 "^$u:" "$STUB_R/fakedb/passwd" | cut -d: -f6)/.config/systemd/user" ;;
    -*) ;;
    *) if [ -z "$verb" ]; then verb=$a; else units="$units $a"; fi ;;
  esac
done
installs() { sed -n "s/^$1=//p" "$dir/$2" 2>/dev/null; }
case "$verb" in
  is-active)
    case "$units" in *" user@1001.service"*) [ -f "$STUB_R/fakedb/manager-groups" ]; exit $? ;; esac ;;
  stop)
    case "$units" in *" user@1001.service"*)
      [ ! -f "$STUB_R/fakedb/fail-manager-stop" ] || exit 89
      rm -f "$STUB_R/fakedb/manager-groups" ;;
    esac ;;
  enable) for u in $units; do [ -e "$dir/$u" ] || exit 1
      for t in $(installs WantedBy "$u"); do mkdir -p "$dir/$t.wants"; ln -sfn "$dir/$u" "$dir/$t.wants/$u"; done
      for al in $(installs Alias "$u"); do if [ -e "$dir/$al" ] && [ ! -L "$dir/$al" ]; then exit 1; fi; ln -sfn "$dir/$u" "$dir/$al"; done
    done ;;
  disable) for u in $units; do
      for l in "$dir"/*.wants/"$u"; do [ -L "$l" ] && rm -f "$l"; done
      for al in $(installs Alias "$u"); do [ -L "$dir/$al" ] && rm -f "$dir/$al"; done
    done ;;
esac
exit 0'
  }

  provision() { # ARGS... → stdout of the run; rc in PROV_RC
    PROV_RC=0
    PATH="${R}/.shims:${PATH}" STUB_R="${R}" FICUS_HOST_ROOT="${R}" \
      bash "${TARGET}" --unix-user "${BOX}" --port 20001 "$@" >"${R}/stdout.log" 2>"${R}/stderr.log" || PROV_RC=$?
  }

  host_snapshot() {
    (cd "${R}" && find . \( -path ./calls.log -o -path ./stderr.log -o -path ./stdout.log -o -path ./.shims \) -prune -o -printf '%p %y %l %m\n' | sort
      find . \( -path ./calls.log -o -path ./stderr.log -o -path ./stdout.log -o -path ./.shims \) -prune -o -type f -exec sha256sum {} + | sort -k2)
  }

  # Install a box the way the previous release did: its user, unit files under the
  # legacy names (enabled socket), its slice drop-in, and its HOME dot dir.
  make_legacy_box() { # system|user
    local home="${R}/home/${BOX}" dir
    echo "${BOX}:x:1001:1001::${home}:/bin/bash" >>"${R}/fakedb/passwd"
    mkdir -p "${home}/${L_DOT}/devbox"
    printf 'EXECUTOR_AUTH_TOKEN=secret\n' >"${home}/${L_DOT}/server.env"
    printf '{}\n' >"${home}/${L_DOT}/devbox/devbox.json"
    if [ "$1" = system ]; then
      dir="${R}/etc/systemd/system"
      for u in "${L_SYS}-${BOX}.service" "${L_SYS}-${BOX}-proxy.service"; do printf '[Service]\nExecStart=/bin/true\n' >"${dir}/${u}"; done
      printf '[Socket]\nListenStream=127.0.0.1:20001\n\n[Install]\nWantedBy=sockets.target\n' >"${dir}/${L_SYS}-${BOX}.socket"
      mkdir -p "${dir}/sockets.target.wants" "${dir}/${L_SYS}-${BOX}.slice.d"
      ln -s "${dir}/${L_SYS}-${BOX}.socket" "${dir}/sockets.target.wants/${L_SYS}-${BOX}.socket"
      printf '[Slice]\n' >"${dir}/${L_SYS}-${BOX}.slice.d/50-${L_SYS}.conf"
    else
      dir="${home}/.config/systemd/user"
      mkdir -p "${dir}/sockets.target.wants"
      for u in "${L_USER}.service" "${L_USER}-proxy.service"; do printf '[Service]\nExecStart=/bin/true\n' >"${dir}/${u}"; done
      printf '[Socket]\nListenStream=127.0.0.1:20001\n\n[Install]\nWantedBy=sockets.target\n' >"${dir}/${L_USER}.socket"
      ln -s "${dir}/${L_USER}.socket" "${dir}/sockets.target.wants/${L_USER}.socket"
      touch "${R}/var/lib/systemd/linger/${BOX}"
      printf 'old-browser:x:997:%s\n' "${BOX}" >>"${R}/fakedb/group"
      printf '%s old-browser\n' "${BOX}" >"${R}/fakedb/manager-groups"
    fi
  }

  is_link_to() { [[ -L $1 && $(readlink "$1") == "$2" ]] && echo yes || echo no; }

  # -- a fresh system-mode box ------------------------------------------------
  make_host
  provision --sandbox-id agent_x --unit-mode system
  S="${R}/etc/systemd/system"
  H="${R}/home/${BOX}"
  expect_eq 'fresh system box: provision succeeds' "${PROV_RC}" '0'
  expect_eq 'fresh system box: the uid is the only stdout line' "$(cat "${R}/stdout.log")" 'FICUS_BOX_UID=1001'
  expect_eq 'fresh system box: the socket is enabled under the Ficus name' \
    "$(is_link_to "${S}/sockets.target.wants/ficus-box-${BOX}.socket" "${S}/ficus-box-${BOX}.socket")" 'yes'
  expect_eq 'fresh system box: the server unit carries its legacy name as an Alias' \
    "$(grep -c "^Alias=${L_SYS}-${BOX}.service$" "${S}/ficus-box-${BOX}.service")" '1'
  expect_eq 'fresh system box: the socket unit carries its legacy name as an Alias' \
    "$(grep -c "^Alias=${L_SYS}-${BOX}.socket$" "${S}/ficus-box-${BOX}.socket")" '1'
  expect_eq 'fresh system box: the enabled alias is a link, not a unit file' \
    "$(is_link_to "${S}/${L_SYS}-${BOX}.socket" "${S}/ficus-box-${BOX}.socket")" 'yes'
  expect_eq 'fresh system box: the unit runs from /opt/ficus with the .ficus env files' \
    "$(grep -c -e '^ExecStart=/opt/ficus/bin/bun /opt/ficus/server/server.js --service-cgroup$' \
      -e "^EnvironmentFile=-${H}/.ficus/server.env$" -e '^Environment=FICUS_BROWSER_SOCK=/run/ficus-browser/sock$' \
      "${S}/ficus-box-${BOX}.service")" '3'
  expect_eq 'fresh system box: slice limits under the Ficus slice' \
    "$([[ -f ${S}/ficus-box-${BOX}.slice.d/50-ficus-box.conf ]] && echo yes || echo no)" 'yes'
  expect_eq 'fresh system box: host.env lands in ~/.ficus' "$([[ -f ${H}/.ficus/host.env ]] && echo yes || echo no)" 'yes'
  expect_eq 'fresh system box: the legacy dot dir name links to .ficus' "$(is_link_to "${H}/${L_DOT}" .ficus)" 'yes'
  before=$(host_snapshot)
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'fresh system box: a second run succeeds' "${PROV_RC}" '0'
  expect_eq 'fresh system box: a second run changes nothing' "$(host_snapshot)" "${before}"
  rm -rf "${R}"

  # -- a system-mode box the previous release provisioned ---------------------
  make_host
  make_legacy_box system
  provision --sandbox-id agent_x --unit-mode system
  S="${R}/etc/systemd/system"
  H="${R}/home/${BOX}"
  expect_eq 'legacy system box: provision succeeds' "${PROV_RC}" '0'
  for u in "${L_SYS}-${BOX}.service" "${L_SYS}-${BOX}.socket" "${L_SYS}-${BOX}-proxy.service"; do
    expect_eq "legacy system box: no ${u} unit file is left" \
      "$([[ -f ${S}/${u} && ! -L ${S}/${u} ]] && echo file || echo none)" 'none'
  done
  expect_eq 'legacy system box: the legacy units were stopped, socket first' \
    "$(grep -c "^systemctl stop ${L_SYS}-${BOX}.socket ${L_SYS}-${BOX}-proxy.service ${L_SYS}-${BOX}.service$" "${R}/calls.log")" '1'
  expect_eq 'legacy system box: the legacy enable link is gone' \
    "$([[ -e ${S}/sockets.target.wants/${L_SYS}-${BOX}.socket ]] && echo present || echo gone)" 'gone'
  expect_eq 'legacy system box: the legacy slice drop-in is gone' \
    "$([[ -e ${S}/${L_SYS}-${BOX}.slice.d ]] && echo present || echo gone)" 'gone'
  expect_eq 'legacy system box: the Ficus socket is enabled' \
    "$(is_link_to "${S}/sockets.target.wants/ficus-box-${BOX}.socket" "${S}/ficus-box-${BOX}.socket")" 'yes'
  expect_eq 'legacy system box: server.env moved with the dot dir' "$(cat "${H}/.ficus/server.env")" 'EXECUTOR_AUTH_TOKEN=secret'
  expect_eq 'legacy system box: the devbox moved with it' "$([[ -f ${H}/.ficus/devbox/devbox.json ]] && echo yes || echo no)" 'yes'
  expect_eq 'legacy system box: the legacy dot dir name is a relative link to .ficus' "$(is_link_to "${H}/${L_DOT}" .ficus)" 'yes'
  before=$(host_snapshot)
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'legacy system box: a second run changes nothing' "$(host_snapshot)" "${before}"
  rm -rf "${R}"

  # -- user mode ----------------------------------------------------------------
  make_host
  provision --sandbox-id squad_x --unit-mode user
  H="${R}/home/${BOX}"
  U="${H}/.config/systemd/user"
  expect_eq 'fresh user box: provision succeeds' "${PROV_RC}" '0'
  expect_eq 'fresh user box: ficus-sandbox-server.socket is enabled in the user manager' \
    "$(is_link_to "${U}/sockets.target.wants/ficus-sandbox-server.socket" "${U}/ficus-sandbox-server.socket")" 'yes'
  expect_eq 'fresh user box: the enable went to the box user manager' \
    "$(grep -c "^systemctl --machine=${BOX}@.host --user enable --now ficus-sandbox-server.socket$" "${R}/calls.log")" '1'
  expect_eq 'fresh user box: its legacy name is the alias link' \
    "$(is_link_to "${U}/${L_USER}.socket" "${U}/ficus-sandbox-server.socket")" 'yes'
  expect_eq 'fresh user box: its first manager inherits browser membership' \
    "$(grep -c -w ficus-browser "${R}/fakedb/manager-groups" || true)" '1'
  expect_eq 'fresh user box: no existing manager needs stopping' \
    "$(grep -c '^systemctl stop user@1001.service$' "${R}/calls.log" || true)" '0'
  rm -rf "${R}"

  make_host
  make_legacy_box user
  provision --sandbox-id squad_x --unit-mode user
  H="${R}/home/${BOX}"
  U="${H}/.config/systemd/user"
  expect_eq 'legacy user box: provision succeeds' "${PROV_RC}" '0'
  for u in "${L_USER}.service" "${L_USER}.socket" "${L_USER}-proxy.service"; do
    expect_eq "legacy user box: no ${u} unit file is left" "$([[ -f ${U}/${u} && ! -L ${U}/${u} ]] && echo file || echo none)" 'none'
  done
  expect_eq 'legacy user box: the Ficus socket is enabled' \
    "$(is_link_to "${U}/sockets.target.wants/ficus-sandbox-server.socket" "${U}/ficus-sandbox-server.socket")" 'yes'
  expect_eq 'legacy user box: linger is kept for the user manager' \
    "$([[ -e ${R}/var/lib/systemd/linger/${BOX} ]] && echo yes || echo no)" 'yes'
  expect_eq 'legacy user box: server.env moved with the dot dir' "$(cat "${H}/.ficus/server.env")" 'EXECUTOR_AUTH_TOKEN=secret'
  expect_eq 'legacy user box: refreshed manager inherits browser membership' \
    "$(grep -c -w ficus-browser "${R}/fakedb/manager-groups" || true)" '1'
  expect_eq 'legacy user box: only this box manager was stopped once' \
    "$(grep -c '^systemctl stop user@1001.service$' "${R}/calls.log" || true)" '1'
  expect_eq 'legacy user box: stop precedes group addition and subsequent enable' \
    "$(awk '/^systemctl stop user@1001.service$/ { stop=NR } /^usermod -aG ficus-browser / { add=NR } /^loginctl enable-linger / { enable=NR } END { print (stop > 0 && add > stop && enable > add) ? "yes" : "no" }' "${R}/calls.log")" 'yes'
  before=$(host_snapshot)
  : >"${R}/calls.log"
  provision --sandbox-id squad_x --unit-mode user
  expect_eq 'legacy user box: repeat succeeds without filesystem changes' "${PROV_RC}:$(host_snapshot)" "0:${before}"
  expect_eq 'legacy user box: repeat does not stop its manager' \
    "$(grep -c '^systemctl stop user@1001.service$' "${R}/calls.log" || true)" '0'
  expect_eq 'legacy user box: repeat does not add the group again' \
    "$(grep -c '^usermod -aG ficus-browser ' "${R}/calls.log" || true)" '0'
  rm -rf "${R}"

  # A failed stop must not add membership and make the retry skip its refresh.
  make_host
  make_legacy_box user
  H="${R}/home/${BOX}"
  mkdir -p "${H}/workspace"
  printf 'keep workspace\n' >"${H}/workspace/keep"
  touch "${R}/fakedb/fail-manager-stop"
  provision --sandbox-id squad_x --unit-mode user
  expect_eq 'manager stop failure: provision fails before changing group membership' "${PROV_RC}" '89'
  expect_eq 'manager stop failure: no usermod occurred' \
    "$(grep -c '^usermod ' "${R}/calls.log" || true)" '0'
  expect_eq 'manager stop failure: old manager still has original groups' "$(cat "${R}/fakedb/manager-groups")" "${BOX} old-browser"
  rm "${R}/fakedb/fail-manager-stop"
  provision --sandbox-id squad_x --unit-mode user
  expect_eq 'manager stop failure: retry succeeds' "${PROV_RC}" '0'
  expect_eq 'manager stop failure: retry refreshes group membership' \
    "$(grep -c -w ficus-browser "${R}/fakedb/manager-groups" || true)" '1'
  expect_eq 'manager refresh: workspace content survives' "$(cat "${H}/workspace/keep")" 'keep workspace'
  expect_eq 'manager refresh: server env survives' "$(cat "${H}/.ficus/server.env")" 'EXECUTOR_AUTH_TOKEN=secret'
  rm -rf "${R}"

  # -- a HOME whose new box server already wrote .ficus beside the legacy dir ---
  make_host
  make_legacy_box system
  H="${R}/home/${BOX}"
  mkdir -p "${H}/${L_DOT}/runtime" "${H}/.ficus/runtime"
  printf 'old\n' >"${H}/${L_DOT}/runtime/record"
  printf 'new\n' >"${H}/.ficus/runtime/record"
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'both dot dirs: provision succeeds' "${PROV_RC}" '0'
  expect_eq 'both dot dirs: entries only the legacy dir had move over' "$(cat "${H}/.ficus/server.env")" 'EXECUTOR_AUTH_TOKEN=secret'
  expect_eq 'both dot dirs: the newer entry is kept' "$(cat "${H}/.ficus/runtime/record")" 'new'
  expect_eq 'both dot dirs: the clashing legacy entry is kept aside, not deleted' \
    "$(cat "${H}"/.ficus/.before-rename-*/runtime/record 2>/dev/null)" 'old'
  expect_eq 'both dot dirs: the legacy name links to .ficus' "$(is_link_to "${H}/${L_DOT}" .ficus)" 'yes'
  rm -rf "${R}"

  # -- a machine whose root has not been migrated yet ---------------------------
  make_host
  mkdir -p "${R}${L_ROOT}/bin"
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'unmigrated machine root: provisioning refuses' "${PROV_RC}" '3'
  expect_eq 'unmigrated machine root: the refusal says to re-bootstrap' \
    "$(grep -c 're-bootstrap' "${R}/stderr.log")" '1'
  expect_eq 'unmigrated machine root: nothing was installed' \
    "$(find "${R}/etc/systemd/system" -name 'ficus-box-*' | wc -l | tr -d ' ')" '0'
  rm -rf "${R}"
fi

printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
[[ ${FAIL} -eq 0 ]]
