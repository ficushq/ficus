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
    shim getent 'grep -m1 "^$2:" "$STUB_R/fakedb/$1" || exit 2'
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
dir="$STUB_R/etc/systemd/system"; verb=""; units=""; manager_args=()
for a in "$@"; do
  case "$a" in
    --machine=*) u=${a#--machine=}; u=${u%@.host}; manager_args=("$a" --user); dir="$(grep -m1 "^$u:" "$STUB_R/fakedb/passwd" | cut -d: -f6)/.config/systemd/user" ;;
    -*) ;;
    *) if [ -z "$verb" ]; then verb=$a; else units="$units $a"; fi ;;
  esac
done
installs() { sed -n "s/^$1=//p" "$dir/$2" 2>/dev/null; }
case "$verb" in
  show)
    [ ! -f "$STUB_R/fakedb/fail-readback" ] || exit 90
    [ ! -f "$STUB_R/fakedb/empty-readback" ] || exit 0
    u="${!#}"
    case " $* " in
      *" UnitFileState "*)
        if [ -L "$dir/sockets.target.wants/$u" ]; then echo enabled; else echo disabled; fi ;;
      *" ActiveState "*)
        if [ -f "$STUB_R/fakedb/active-$u" ]; then echo active; else echo inactive; fi ;;
    esac ;;
  is-active)
    case "$units" in *" user@1001.service"*) [ -f "$STUB_R/fakedb/manager-groups" ]; exit $? ;; esac ;;
  stop)
    case "$units" in *" user@1001.service"*)
      [ ! -f "$STUB_R/fakedb/fail-manager-stop" ] || exit 89
      rm -f "$STUB_R/fakedb/manager-groups" ;;
    esac ;;
  start)
    [ ! -f "$STUB_R/fakedb/fail-start" ] || exit 86
    for u in $units; do
      [ -e "$dir/$u" ] || exit 1
      touch "$STUB_R/fakedb/active-$u"
    done ;;
  reenable) "$0" "${manager_args[@]}" disable $units || exit $?; "$0" "${manager_args[@]}" enable $units ;;
  enable) [ ! -f "$STUB_R/fakedb/fail-enable" ] || exit 87
    for u in $units; do [ -e "$dir/$u" ] || exit 1
      for t in $(installs WantedBy "$u"); do mkdir -p "$dir/$t.wants"; ln -sfn "$dir/$u" "$dir/$t.wants/$u"; done
      for al in $(installs Alias "$u"); do if [ -e "$dir/$al" ] && [ ! -L "$dir/$al" ]; then exit 1; fi; ln -sfn "$dir/$u" "$dir/$al"; done
    done ;;
  disable) [ ! -f "$STUB_R/fakedb/fail-disable" ] || exit 88
    for u in $units; do
      for l in "$dir"/*.wants/"$u"; do [ -L "$l" ] && rm -f "$l"; done
      for l in "$dir"/* "$dir"/*.wants/*; do
        [ -L "$l" ] || continue
        target=$(readlink "$l")
        if [ "$target" = "$dir/$u" ] || [ "$target" = "$u" ]; then rm "$l"; fi
      done
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

  make_bridge_box() { # Already migrated by U4, with compatibility links only.
    make_legacy_box "$1"
    local home="$R/home/$BOX" dir old new ext
    mv "$home/$L_DOT" "$home/.ficus"
    ln -s .ficus "$home/$L_DOT"
    if [ "$1" = system ]; then
      dir="$R/etc/systemd/system"; old="$L_SYS-$BOX"; new="ficus-box-$BOX"
      rm -rf "$dir/$old.slice.d"
    else
      dir="$home/.config/systemd/user"; old="$L_USER"; new=ficus-sandbox-server
    fi
    for ext in service socket '-proxy.service'; do
      case $ext in -*) mv "$dir/$old$ext" "$dir/$new$ext" ;; *) mv "$dir/$old.$ext" "$dir/$new.$ext" ;; esac
    done
    rm "$dir/sockets.target.wants/$old.socket"
    ln -s "$dir/$new.socket" "$dir/sockets.target.wants/$new.socket"
    for ext in service socket; do ln -s "$dir/$new.$ext" "$dir/$old.$ext"; done
  }

  is_link_to() { [[ -L $1 && $(readlink "$1") == "$2" ]] && echo yes || echo no; }

  # C-FIN must refuse any old machine/box layout before touching accounts or units.
  for mode in system user; do
    make_host
    make_legacy_box "$mode"
    before=$(host_snapshot)
    provision --sandbox-id agent_x --unit-mode "$mode"
    expect_eq "old $mode layout refuses before finalize" "$PROV_RC" '3'
    expect_eq "old $mode layout refusal preserves all files" "$(host_snapshot)" "$before"
    expect_eq "old $mode layout refusal names required bridge" "$(grep -c ficus-host-layout-bridge "$R/stderr.log" || true)" '1'
    rm -rf "$R"
  done

  # -- a fresh system-mode box ------------------------------------------------
  make_host
  provision --sandbox-id agent_x --unit-mode system
  S="${R}/etc/systemd/system"
  H="${R}/home/${BOX}"
  expect_eq 'fresh system box: provision succeeds' "${PROV_RC}" '0'
  expect_eq 'fresh system box: the uid is the only stdout line' "$(cat "${R}/stdout.log")" 'FICUS_BOX_UID=1001'
  expect_eq 'fresh system box: the socket is enabled under the Ficus name' \
    "$(is_link_to "${S}/sockets.target.wants/ficus-box-${BOX}.socket" "${S}/ficus-box-${BOX}.socket")" 'yes'
  expect_eq 'fresh system box: the server unit has no legacy Alias' \
    "$(grep -c '^Alias=' "${S}/ficus-box-${BOX}.service" || true)" '0'
  expect_eq 'fresh system box: the socket unit has no legacy Alias' \
    "$(grep -c '^Alias=' "${S}/ficus-box-${BOX}.socket" || true)" '0'
  expect_eq 'fresh system box: no enabled legacy alias remains' \
    "$(is_link_to "${S}/${L_SYS}-${BOX}.socket" "${S}/ficus-box-${BOX}.socket")" 'no'
  expect_eq 'fresh system box: the unit runs from /opt/ficus with the .ficus env files' \
    "$(grep -c -e '^ExecStart=/opt/ficus/bin/bun /opt/ficus/server/server.js --service-cgroup$' \
      -e "^EnvironmentFile=-${H}/.ficus/server.env$" -e '^Environment=FICUS_BROWSER_SOCK=/run/ficus-browser/sock$' \
      "${S}/ficus-box-${BOX}.service")" '3'
  expect_eq 'fresh system box: slice limits under the Ficus slice' \
    "$([[ -f ${S}/ficus-box-${BOX}.slice.d/50-ficus-box.conf ]] && echo yes || echo no)" 'yes'
  expect_eq 'fresh system box: host.env lands in ~/.ficus' "$([[ -f ${H}/.ficus/host.env ]] && echo yes || echo no)" 'yes'
  expect_eq 'fresh system box: no home bridge is created' "$(is_link_to "${H}/${L_DOT}" .ficus)" 'no'
  before=$(host_snapshot)
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'fresh system box: a second run succeeds' "${PROV_RC}" '0'
  expect_eq 'fresh system box: a second run changes nothing' "$(host_snapshot)" "${before}"
  rm -rf "${R}"

  # A full reprovision of a parked box must repair persistent enablement, and
  # must not print a success/UID marker if enable/start or readback fails.
  for mode in system user; do
    sandbox_id=agent_park
    [ "$mode" = system ] || sandbox_id=squad_park
    for failure in enable disable start readback empty-readback; do
      make_host
      case "$failure" in
        empty-readback) touch "${R}/fakedb/empty-readback" ;;
        *) touch "${R}/fakedb/fail-${failure}" ;;
      esac
      provision --sandbox-id "$sandbox_id" --unit-mode "$mode"
      expect_eq "$mode provision: $failure failure is not success" "$([[ $PROV_RC != 0 ]] && echo failed || echo success)" failed
      expect_eq "$mode provision: $failure failure emits no UID marker" "$(grep -c '^FICUS_BOX_UID=' "${R}/stdout.log" || true)" 0
      rm -rf "${R}"
    done
    make_host
    provision --sandbox-id "$sandbox_id" --unit-mode "$mode"
    if [ "$mode" = system ]; then
      units="${R}/etc/systemd/system"; socket="ficus-box-${BOX}.socket"
    else
      units="${R}/home/${BOX}/.config/systemd/user"; socket=ficus-sandbox-server.socket
    fi
    rm -f "$units/sockets.target.wants/$socket" "${R}/fakedb/active-$socket"
    printf 'preserve-auth\n' >"${R}/home/${BOX}/.ficus/server.env"
    provision --sandbox-id "$sandbox_id" --unit-mode "$mode"
    expect_eq "$mode reprovision: succeeds" "$PROV_RC" 0
    expect_eq "$mode reprovision: parked socket enabled again" "$(is_link_to "$units/sockets.target.wants/$socket" "$units/$socket")" yes
    expect_eq "$mode reprovision: preserves server.env" "$(cat "${R}/home/${BOX}/.ficus/server.env")" preserve-auth
    rm -rf "${R}"
  done

  # -- a system-mode box the previous release provisioned ---------------------
  make_host
  make_bridge_box system
  provision --sandbox-id agent_x --unit-mode system
  S="${R}/etc/systemd/system"
  H="${R}/home/${BOX}"
  expect_eq 'legacy system box: provision succeeds' "${PROV_RC}" '0'
  for u in "${L_SYS}-${BOX}.service" "${L_SYS}-${BOX}.socket" "${L_SYS}-${BOX}-proxy.service"; do
    expect_eq "legacy system box: no ${u} unit file is left" \
      "$([[ -f ${S}/${u} && ! -L ${S}/${u} ]] && echo file || echo none)" 'none'
  done
  expect_eq 'bridged system box: no legacy unit is stopped' \
    "$(grep -c "^systemctl stop ${L_SYS}-${BOX}.socket ${L_SYS}-${BOX}-proxy.service ${L_SYS}-${BOX}.service$" "${R}/calls.log" || true)" '0'
  expect_eq 'legacy system box: the legacy enable link is gone' \
    "$([[ -e ${S}/sockets.target.wants/${L_SYS}-${BOX}.socket ]] && echo present || echo gone)" 'gone'
  expect_eq 'legacy system box: the legacy slice drop-in is gone' \
    "$([[ -e ${S}/${L_SYS}-${BOX}.slice.d ]] && echo present || echo gone)" 'gone'
  expect_eq 'legacy system box: the Ficus socket is enabled' \
    "$(is_link_to "${S}/sockets.target.wants/ficus-box-${BOX}.socket" "${S}/ficus-box-${BOX}.socket")" 'yes'
  expect_eq 'legacy system box: server.env moved with the dot dir' "$(cat "${H}/.ficus/server.env")" 'EXECUTOR_AUTH_TOKEN=secret'
  expect_eq 'legacy system box: the devbox moved with it' "$([[ -f ${H}/.ficus/devbox/devbox.json ]] && echo yes || echo no)" 'yes'
  expect_eq 'bridged system box: exact home bridge is removed' "$(is_link_to "${H}/${L_DOT}" .ficus)" 'no'
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
    "$(grep -c "^systemctl --machine=${BOX}@.host --user reenable ficus-sandbox-server.socket$" "${R}/calls.log")" '1'
  expect_eq 'fresh user box: the socket was explicitly started by the box user manager' \
    "$(grep -c "^systemctl --machine=${BOX}@.host --user start ficus-sandbox-server.socket$" "${R}/calls.log")" '1'
  expect_eq 'fresh user box: no legacy alias remains' \
    "$(is_link_to "${U}/${L_USER}.socket" "${U}/ficus-sandbox-server.socket")" 'no'
  expect_eq 'fresh user box: its first manager inherits browser membership' \
    "$(grep -c -w ficus-browser "${R}/fakedb/manager-groups" || true)" '1'
  expect_eq 'fresh user box: no existing manager needs stopping' \
    "$(grep -c '^systemctl stop user@1001.service$' "${R}/calls.log" || true)" '0'
  rm -rf "${R}"

  make_host
  make_bridge_box user
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
  make_bridge_box user
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

  # Both real dot directories require explicit bridge recovery, never finalize.
  make_host
  make_legacy_box system
  H="$R/home/$BOX"
  mkdir -p "$H/$L_DOT/runtime" "$H/.ficus/runtime"
  printf 'old\n' >"$H/$L_DOT/runtime/record"
  printf 'new\n' >"$H/.ficus/runtime/record"
  before=$(host_snapshot)
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'both real dot dirs: normal finalize refuses' "$PROV_RC" '3'
  expect_eq 'both real dot dirs: refusal preserves data' "$(host_snapshot)" "$before"
  # The old one-shot merge program is retained and can still recover this case.
  program=$(python3 -c 'import sys; s=open(sys.argv[1]).read(); print(s.split("HOME_DOT_DIR_PROGRAM="+chr(39),1)[1].split(chr(39)+"\n\nmigrate_home_dot_dir",1)[0],end="")' "$TARGET")
  bash -c "$program" recovery "$H" "$L_DOT" .ficus
  expect_eq 'explicit recovery: keeps newer collision' "$(cat "$H/.ficus/runtime/record")" new
  expect_eq 'explicit recovery: preserves older collision' "$(cat "$H"/.ficus/.before-rename-*/runtime/record)" old
  rm -rf "$R"

  # Exact global/home links are removed; custom and dangling foreign targets survive.
  make_host
  make_bridge_box system
  ln -s ficus "$R$L_ROOT"
  mkdir -p "$R/opt/ficus/server"
  printf 'durable data\n' >"$R/opt/ficus/server/keep"
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'finalize: exact machine link removed' "$([[ -L $R$L_ROOT ]] && echo present || echo absent)" absent
  expect_eq 'finalize: target data unchanged' "$(cat "$R/opt/ficus/server/keep")" 'durable data'
  expect_eq 'finalize: old service alias removed' "$([[ -L $R/etc/systemd/system/$L_SYS-$BOX.service ]] && echo present || echo absent)" absent
  expect_eq 'finalize: old socket alias removed' "$([[ -L $R/etc/systemd/system/$L_SYS-$BOX.socket ]] && echo present || echo absent)" absent
  ln -s /srv/foreign-missing "$R$L_ROOT"
  ln -s foreign-missing "$R/home/$BOX/$L_DOT"
  ln -s /srv/foreign-unit "$R/etc/systemd/system/$L_SYS-$BOX.service"
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'foreign links: provisioning succeeds' "$PROV_RC" 0
  expect_eq 'foreign links: machine target preserved' "$(readlink "$R$L_ROOT")" /srv/foreign-missing
  expect_eq 'foreign links: box-home target preserved' "$(readlink "$R/home/$BOX/$L_DOT")" foreign-missing
  expect_eq 'foreign links: unit target preserved' "$(readlink "$R/etc/systemd/system/$L_SYS-$BOX.service")" /srv/foreign-unit
  expect_eq 'foreign links: warning emitted' "$(grep -c 'leaving foreign' "$R/stderr.log")" 2
  rm -rf "$R"

  # -- a machine whose root has not been migrated yet ---------------------------
  make_host
  mkdir -p "${R}${L_ROOT}/bin"
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'unmigrated machine root: provisioning refuses' "${PROV_RC}" '3'
  expect_eq 'unmigrated machine root: the refusal names the bridge release' \
    "$(grep -c 'ficus-host-layout-bridge' "${R}/stderr.log")" '1'
  expect_eq 'unmigrated machine root: nothing was installed' \
    "$(find "${R}/etc/systemd/system" -name 'ficus-box-*' | wc -l | tr -d ' ')" '0'
  rm -rf "${R}"
fi

printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
[[ ${FAIL} -eq 0 ]]
