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
# its argv and emulates enable/disable links, useradd/getent/id read and write
# a fake passwd, and install drops -o/-g so the run needs no real box user.
# Needs GNU coreutils (mv -T, find -printf), so a
# macOS run skips it; the Linux CI and the ubuntu:24.04 container run it.
if ! mv --version 2>/dev/null | grep -q GNU; then
  echo 'SKIP: provisioning harness (needs GNU coreutils)'
else
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
    # The kernel's reserved-ports list as /proc/sys shows it (empty by default).
    mkdir -p "${R}/proc/sys/net/ipv4"
    : >"${R}/proc/sys/net/ipv4/ip_local_reserved_ports"
    printf '#!/bin/sh\n' >"${R}/usr/lib/systemd/systemd-socket-proxyd"
    chmod +x "${R}/usr/lib/systemd/systemd-socket-proxyd"
    printf 'root:x:0:0:root:/root:/bin/bash\n' >"${R}/fakedb/passwd"
    printf 'root:x:0:\nficus-browser:x:998:\n' >"${R}/fakedb/group"
    # run_as_box pins PATH for the box user; keep the shims first on it so the
    # docker tooling below is stubbed too (never the host's real setuptool).
    local keep_shims='a=(); for x in "$@"; do case "$x" in PATH=*) x="PATH=$STUB_R/.shims:${x#PATH=}" ;; esac; a+=("$x"); done; exec "${a[@]}"'
    shim sudo "if [ \"\$1\" = -u ]; then shift 2; fi; ${keep_shims}"
    shim runuser "shift 3; ${keep_shims}"
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
    # Socket-failure diagnostics read these fixtures: who holds the port, and
    # what systemd logged for the socket.
    shim ss 'echo "ss $*" >>"$STUB_R/calls.log"; cat "$STUB_R/fakedb/port-holder" 2>/dev/null; exit 0'
    shim journalctl 'echo "journalctl $*" >>"$STUB_R/calls.log"; cat "$STUB_R/fakedb/journal" 2>/dev/null; exit 0'
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
  daemon-reload)
    if [ -z "${manager_args[*]}" ] && [ -d "$STUB_R/sys/fs/cgroup/user.slice/user-1001.slice" ]; then
      [ ! -f "$STUB_R/fakedb/fail-limits" ] || exit 91
      cg="$STUB_R/sys/fs/cgroup/user.slice/user-1001.slice"
      while IFS= read -r a; do
        case "$a" in
          MemoryHigh=*) echo "${a#*=}" >"$cg/memory.high" ;;
          MemoryMax=*) echo "${a#*=}" >"$cg/memory.max" ;;
          CPUQuota=*) n=${a#*=}; echo "$(( ${n%%%} * 1000 )) 100000" >"$cg/cpu.max" ;;
        esac
      done <"$STUB_R/etc/systemd/system/user-1001.slice.d/50-ficus-box.conf"
      for name in memory.max memory.high cpu.max; do
        if [ -f "$STUB_R/fakedb/$name" ]; then cat "$STUB_R/fakedb/$name" >"$cg/$name"; fi
      done
    fi
    if [ -n "${manager_args[*]}" ] && [ -f "$STUB_R/fakedb/fail-docker-reload" ]; then exit 92; fi ;;
  show)
    case " $* " in
      *" ControlGroup "*)
        unit="${!#}"
        case "$unit" in
          user-1001.slice) echo /user.slice/user-1001.slice ;;
          user@1001.service) cat "$STUB_R/fakedb/manager-cgroup" ;;
          ficus-docker.slice) cat "$STUB_R/fakedb/docker-slice-cgroup" ;;
          docker.service) cat "$STUB_R/fakedb/docker-cgroup" ;;
        esac
        exit 0 ;;
    esac
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
    case "$units" in *" docker.service"*) [ ! -f "$STUB_R/fakedb/fail-docker-stop" ] || exit 94 ;; esac
    case "$units" in *" docker.service"*) rm -f "$STUB_R/fakedb/active-docker.service" ;; esac
    case "$units" in *" user@1001.service"*)
      [ ! -f "$STUB_R/fakedb/fail-manager-stop" ] || exit 89
      rm -f "$STUB_R/fakedb/manager-groups" ;;
    esac ;;
  start|restart)
    case "$units" in *" docker.service"*) [ ! -f "$STUB_R/fakedb/fail-docker-start" ] || exit 93 ;; esac
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

  # Rootless docker tooling, for --with-docker runs. The setuptool (re)writes the
  # user docker.service from fakedb/docker-exec, as a reinstall over a changed
  # template would; pgrep reports a stale `--iptables=false` dockerd only while
  # fakedb/stale-dockerd exists.
  docker_shims() {
    printf '/usr/bin/dockerd-rootless.sh --iptables=false\n' >"${R}/fakedb/docker-exec"
    shim dockerd-rootless-setuptool.sh '
echo "setuptool $*" >>"$STUB_R/calls.log"
# Match Docker 28.0.4 setuptool init/install_systemd config resolution.
d="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; mkdir -p "$d"
printf "%s\n" "$HOME" "${XDG_CONFIG_HOME:-}" "${XDG_DATA_HOME:-}" "${XDG_CACHE_HOME:-}" "${DOCKER_CONFIG:-}" "${DOCKER_HOST:-}" "${DOCKER_CONTEXT-unset}" "${DOCKER_TLS-unset}" "${DOCKER_TLS_VERIFY-unset}" "${DOCKER_CERT_PATH-unset}" >"$STUB_R/fakedb/box-env"
printf "[Service]\nExecStart=%s\n[Install]\nWantedBy=default.target\n" "$(cat "$STUB_R/fakedb/docker-exec")" >"$d/docker.service"'
    shim pgrep 'echo "pgrep $*" >>"$STUB_R/calls.log"; [ -f "$STUB_R/fakedb/stale-dockerd" ]'
    local cg=/user.slice/user-1001.slice manager=/user.slice/user-1001.slice/user@1001.service
    mkdir -p "${R}/sys/fs/cgroup${cg}"
    echo 'cpu memory pids' >"${R}/sys/fs/cgroup/cgroup.controllers"
    echo max >"${R}/sys/fs/cgroup${cg}/memory.max"
    echo max >"${R}/sys/fs/cgroup${cg}/memory.high"
    echo 'max 100000' >"${R}/sys/fs/cgroup${cg}/cpu.max"
    echo "$manager" >"${R}/fakedb/manager-cgroup"
    echo "$manager/ficus.slice/ficus-docker.slice" >"${R}/fakedb/docker-slice-cgroup"
    echo "$manager/ficus.slice/ficus-docker.slice/docker.service" >"${R}/fakedb/docker-cgroup"
    echo 'systemd 2' >"${R}/fakedb/docker-info"
    shim docker 'echo "docker $*" >>"$STUB_R/calls.log"; cat "$STUB_R/fakedb/docker-info"'
    : >"${R}/subuid"
    : >"${R}/subgid"
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
  expect_eq 'fresh system box: the server unit has no legacy Alias' \
    "$(grep -c '^Alias=' "${S}/ficus-box-${BOX}.service" || true)" '0'
  expect_eq 'fresh system box: the socket unit has no legacy Alias' \
    "$(grep -c '^Alias=' "${S}/ficus-box-${BOX}.socket" || true)" '0'
  expect_eq 'fresh system box: the unit runs from /opt/ficus with the .ficus env files' \
    "$(grep -c -e '^ExecStart=/opt/ficus/bin/bun /opt/ficus/server/server.js --service-cgroup$' \
      -e "^EnvironmentFile=-${H}/.ficus/server.env$" -e '^Environment=FICUS_BROWSER_SOCK=/run/ficus-browser/sock$' \
      "${S}/ficus-box-${BOX}.service")" '3'
  expect_eq 'fresh system box: slice limits under the Ficus slice' \
    "$([[ -f ${S}/ficus-box-${BOX}.slice.d/50-ficus-box.conf ]] && echo yes || echo no)" 'yes'
  expect_eq 'fresh system box: host.env lands in ~/.ficus' "$([[ -f ${H}/.ficus/host.env ]] && echo yes || echo no)" 'yes'
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
  expect_eq 'fresh user box: its first manager inherits browser membership' \
    "$(grep -c -w ficus-browser "${R}/fakedb/manager-groups" || true)" '1'
  expect_eq 'fresh user box: no existing manager needs stopping' \
    "$(grep -c '^systemctl stop user@1001.service$' "${R}/calls.log" || true)" '0'
  rm -rf "${R}"

  # A canonical user-manager box created before the browser group existed
  # must refresh only that manager when the group later becomes available.
  make_host
  printf 'root:x:0:\n' >"${R}/fakedb/group"
  provision --sandbox-id squad_x --unit-mode user
  expect_eq 'pre-browser user box: provision succeeds' "$PROV_RC" 0
  H="${R}/home/${BOX}"
  mkdir -p "${H}/workspace"
  printf 'keep workspace\n' >"${H}/workspace/keep"
  printf 'preserve-auth\n' >"${H}/.ficus/server.env"
  printf 'ficus-browser:x:998:\n' >>"${R}/fakedb/group"
  : >"${R}/calls.log"
  touch "${R}/fakedb/fail-manager-stop"
  provision --sandbox-id squad_x --unit-mode user
  expect_eq 'manager stop failure: provision fails before group mutation' "$PROV_RC" 89
  expect_eq 'manager stop failure: no usermod occurred' \
    "$(grep -c '^usermod ' "${R}/calls.log" || true)" 0
  expect_eq 'manager stop failure: original manager groups remain' "$(cat "${R}/fakedb/manager-groups")" "$BOX"
  rm "${R}/fakedb/fail-manager-stop"
  : >"${R}/calls.log"
  provision --sandbox-id squad_x --unit-mode user
  expect_eq 'manager refresh: retry succeeds' "$PROV_RC" 0
  expect_eq 'manager refresh: only this manager stopped once' \
    "$(grep -c '^systemctl stop user@1001.service$' "${R}/calls.log" || true)" 1
  expect_eq 'manager refresh: group membership inherited' \
    "$(grep -c -w ficus-browser "${R}/fakedb/manager-groups" || true)" 1
  expect_eq 'manager refresh: workspace content preserved' "$(cat "${H}/workspace/keep")" 'keep workspace'
  expect_eq 'manager refresh: server env preserved' "$(cat "${H}/.ficus/server.env")" 'preserve-auth'
  : >"${R}/calls.log"
  provision --sandbox-id squad_x --unit-mode user
  expect_eq 'manager refresh: repeat succeeds' "$PROV_RC" 0
  expect_eq 'manager refresh: repeat does not stop the manager' \
    "$(grep -c '^systemctl stop user@1001.service$' "${R}/calls.log" || true)" 0
  expect_eq 'manager refresh: repeat does not add the group' \
    "$(grep -c '^usermod -aG ficus-browser ' "${R}/calls.log" || true)" 0
  rm -rf "${R}"

  # -- rootless docker ----------------------------------------------------------
  # A re-provision of a healthy box (spec/env drift) must not bounce dockerd:
  # that kills every running container, test databases included. It restarts
  # only when the launch config changed or the daemon still runs stale flags.
  docker_provision() {
    : >"${R}/calls.log"
    provision --sandbox-id squad_x --unit-mode user --with-docker \
      --subuid-file "${R}/subuid" --subgid-file "${R}/subgid" --memtotal-kb 8131584 --nproc 8
  }
  docker_verbs() { # VERB → how many times provisioning ran it on docker.service
    grep -c "^systemctl --machine=${BOX}@.host --user $1 docker.service$" "${R}/calls.log" || true
  }
  # sudo/runuser may preserve the caller's XDG/Docker config. Docker's real
  # setuptool uses XDG_CONFIG_HOME for its unit, independently of HOME:
  # https://github.com/moby/moby/blob/v28.0.4/contrib/dockerd-rootless-setuptool.sh
  make_host
  docker_shims
  mkdir -p "${R}/caller/config" "${R}/caller/docker"
  printf preserve >"${R}/caller/config/sentinel"
  printf preserve >"${R}/caller/docker/sentinel"
  XDG_CONFIG_HOME="${R}/caller/config" XDG_DATA_HOME="${R}/caller/data" \
    XDG_CACHE_HOME="${R}/caller/cache" DOCKER_CONFIG="${R}/caller/docker" \
    DOCKER_HOST=unix:///caller/docker.sock DOCKER_CONTEXT=caller-context \
    DOCKER_TLS=1 DOCKER_TLS_VERIFY=1 DOCKER_CERT_PATH="${R}/caller/certs" docker_provision
  expect_eq 'docker caller config: provision succeeds with poisoned caller config' "$PROV_RC" 0
  H="${R}/home/${BOX}"
  expect_eq 'docker caller config: unit belongs to box, not caller' \
    "$([[ -f ${H}/.config/systemd/user/docker.service ]] && echo yes || echo no)" yes
  expect_eq 'docker caller config: caller files untouched' \
    "$(find "${R}/caller" -type f | wc -l | tr -d ' ')" 2
  expect_eq 'docker caller config: all child config and endpoint paths are box-owned' \
    "$(cat "${R}/fakedb/box-env")" \
    "$(printf '%s\n' "$H" "$H/.config" "$H/.local/share" "$H/.cache" "$H/.docker" 'unix:///run/user/1001/docker.sock' unset unset unset unset)"
  rm -rf "${R}"

  make_host
  docker_shims
  docker_provision
  DU="${R}/home/${BOX}/.config/systemd/user"
  expect_eq 'docker first create: provision succeeds' "$PROV_RC" 0
  expect_eq 'docker first create: the setuptool ran' "$(grep -c '^setuptool install --skip-iptables$' "${R}/calls.log")" 1
  expect_eq 'docker first create: the drop-in strips --iptables=false' \
    "$(cat "${DU}/docker.service.d/override.conf")" "$(printf '[Service]\nExecStart=\nExecStart=/usr/bin/dockerd-rootless.sh --exec-opt native.cgroupdriver=systemd --cgroup-parent=ficus-docker.slice\nSlice=ficus-docker.slice\nDelegate=yes')"
  expect_eq 'docker first create: docker.service is enabled' \
    "$(is_link_to "${DU}/default.target.wants/docker.service" "${DU}/docker.service")" yes
  expect_eq 'docker first create: the auto-started daemon is restarted onto the drop-in' "$(docker_verbs restart)" 1
  expect_eq 'docker first create: docker is running' "$([[ -f ${R}/fakedb/active-docker.service ]] && echo yes || echo no)" yes
  expect_eq 'docker first create: subuid range allocated' "$(grep -c "^${BOX}:" "${R}/subuid")" 1

  docker_provision
  expect_eq 'docker unchanged reprovision: succeeds' "$PROV_RC" 0
  expect_eq 'docker unchanged reprovision: does not restart docker' "$(docker_verbs restart)" 0
  expect_eq 'docker unchanged reprovision: only ensures it is started' "$(docker_verbs start)" 1
  expect_eq 'docker unchanged reprovision: checked for a stale daemon' "$(grep -c '^pgrep ' "${R}/calls.log")" 1

  rm "${R}/fakedb/active-docker.service"
  docker_provision
  expect_eq 'docker stopped + unchanged: no restart' "$(docker_verbs restart)" 0
  expect_eq 'docker stopped + unchanged: started again' "$([[ -f ${R}/fakedb/active-docker.service ]] && echo yes || echo no)" yes

  touch "${R}/fakedb/stale-dockerd"
  docker_provision
  expect_eq 'docker still on --iptables=false: restarted' "$(docker_verbs restart)" 1
  rm "${R}/fakedb/stale-dockerd"

  printf '/usr/bin/dockerd-rootless.sh --iptables=false --experimental\n' >"${R}/fakedb/docker-exec"
  docker_provision
  expect_eq 'docker unit changed: provision succeeds' "$PROV_RC" 0
  expect_eq 'docker unit changed: restarted' "$(docker_verbs restart)" 1
  expect_eq 'docker unit changed: drop-in follows the new unit' \
    "$(sed -n 3p "${DU}/docker.service.d/override.conf")" 'ExecStart=/usr/bin/dockerd-rootless.sh --experimental --exec-opt native.cgroupdriver=systemd --cgroup-parent=ficus-docker.slice'

  docker_provision
  expect_eq 'docker after a change: the next unchanged run does not restart' "$(docker_verbs restart)" 0

  rm "${DU}/docker.service.d/override.conf"
  docker_provision
  expect_eq 'docker drop-in lost: rewritten and restarted' "$(docker_verbs restart)" 1
  # Existing boxes with the old launcher converge once, without touching peers.
  printf '[Service]\nExecStart=\nExecStart=/usr/bin/dockerd-rootless.sh --experimental\n' >"${DU}/docker.service.d/override.conf"
  docker_provision
  expect_eq 'docker legacy drop-in: converges and restarts once' "$(docker_verbs restart)" 1
  expect_eq 'docker containment: persistent cap reload precedes linger/autostart' \
    "$(grep -E '^systemctl daemon-reload$|^loginctl enable-linger|^setuptool' "${R}/calls.log" | head -n1)" \
    'systemctl daemon-reload'
  expect_eq 'docker containment: kernel CPU cap matches the owning box' \
    "$(cat "${R}/sys/fs/cgroup/user.slice/user-1001.slice/cpu.max")" '400000 100000'
  expect_eq 'docker containment: no global or peer service mutation' \
    "$(grep -c -E '^systemctl (stop|restart|set-property).*user@(1000|1002)|^systemctl (stop|restart) docker.service' "${R}/calls.log" || true)" 0
  rm -rf "${R}"

  # Negative cases exercise the real provision path against fake readbacks.
  # These do NOT prove kernel enforcement: no systemd, Docker or cgroup writes
  # outside this temporary host tree are allowed by the harness.
  for defect in manager-escape peer-prefix daemon-escape slice-escape no-v2 missing-cpu fail-limits unbounded-memory unbounded-cpu excess-memory excess-cpu wrong-driver wrong-version empty-manager docker-start-failure docker-reload-failure cleanup-failure missing-unit; do
    make_host
    docker_shims
    case "$defect" in
      manager-escape) echo /user.slice/user@1001.service >"${R}/fakedb/manager-cgroup" ;;
      peer-prefix) echo /user.slice/user-1001.slice-other/user@1001.service >"${R}/fakedb/manager-cgroup" ;;
      daemon-escape) echo /system.slice/docker.service >"${R}/fakedb/docker-cgroup" ;;
      slice-escape) echo /user.slice/user-1002.slice/user@1002.service/ficus.slice/ficus-docker.slice >"${R}/fakedb/docker-slice-cgroup" ;;
      no-v2) rm "${R}/sys/fs/cgroup/cgroup.controllers" ;;
      missing-cpu) echo memory >"${R}/sys/fs/cgroup/cgroup.controllers" ;;
      fail-limits) touch "${R}/fakedb/fail-limits" ;;
      unbounded-memory) echo max >"${R}/fakedb/memory.max" ;;
      unbounded-cpu) echo 'max 100000' >"${R}/fakedb/cpu.max" ;;
      excess-memory) echo 9999999999999 >"${R}/fakedb/memory.max" ;;
      excess-cpu) echo '500000 100000' >"${R}/fakedb/cpu.max" ;;
      wrong-version) echo 'systemd 1' >"${R}/fakedb/docker-info" ;;
      empty-manager) : >"${R}/fakedb/manager-cgroup" ;;
      cleanup-failure) echo 'none 2' >"${R}/fakedb/docker-info"; touch "${R}/fakedb/fail-docker-stop" ;;
      wrong-driver) echo 'none 2' >"${R}/fakedb/docker-info" ;;
      docker-start-failure) touch "${R}/fakedb/fail-docker-start" ;;
      docker-reload-failure) touch "${R}/fakedb/fail-docker-reload" ;;
      missing-unit) shim dockerd-rootless-setuptool.sh 'exit 1' ;;
    esac
    touch "${R}/fakedb/active-docker.service"
    docker_provision
    expect_eq "docker $defect: provisioning fails closed" "$([[ $PROV_RC != 0 ]] && echo yes || echo no)" yes
    expect_eq "docker $defect: no success UID marker" "$(cat "${R}/stdout.log")" ''
    # All containment failures stop only the owning user daemon, including an
    # already running daemon when installing the root-owned boundary failed.
    expect_eq "docker $defect: owning daemon stop attempted" "$(docker_verbs stop)" 1
    if [ "$defect" = cleanup-failure ]; then
      expect_eq 'docker cleanup failure: warns that containment remains unverified' \
        "$(grep -c 'WARNING.*Docker may still be running' "${R}/stderr.log" || true)" 1
    else
      expect_eq "docker $defect: existing daemon is no longer running" \
        "$([[ -f ${R}/fakedb/active-docker.service ]] && echo yes || echo no)" no
    fi
    expect_eq "docker $defect: actionable containment error" \
      "$(grep -c 'Docker containment failed' "${R}/stderr.log" || true)" 1
    rm -rf "${R}"
  done

  # -- reserved box ports ---------------------------------------------------------
  # The kernel's ephemeral range contains the box range, so an outgoing loopback
  # connection could take a box port and stop that box's socket from binding.
  # Every provision reserves the range, live and across reboots, and keeps any
  # reservation that already existed.
  PROC_PORTS=proc/sys/net/ipv4/ip_local_reserved_ports
  SYSCTL_DROPIN=etc/sysctl.d/90-ficus-box-ports.conf
  make_host
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'reservation: provision succeeds' "$PROV_RC" 0
  expect_eq 'reservation: the live list now holds the callback port and the box range' \
    "$(cat "${R}/${PROC_PORTS}")" '50080,50100-59999'
  expect_eq 'reservation: persisted for boot' \
    "$(grep -v '^#' "${R}/${SYSCTL_DROPIN}")" 'net.ipv4.ip_local_reserved_ports = 50080,50100-59999'
  rm -rf "${R}"

  make_host
  printf '8080,9000-9010\n' >"${R}/${PROC_PORTS}"
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'reservation merge: existing reservations are kept, live' \
    "$(cat "${R}/${PROC_PORTS}")" '8080,9000-9010,50080,50100-59999'
  expect_eq 'reservation merge: and for boot' \
    "$(grep -v '^#' "${R}/${SYSCTL_DROPIN}")" 'net.ipv4.ip_local_reserved_ports = 8080,9000-9010,50080,50100-59999'
  rm -rf "${R}"

  # The kernel prints its list merged into maximal ranges.
  make_host
  printf '50000-50090,50100-61000\n' >"${R}/${PROC_PORTS}"
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'reservation already covered: live list untouched' "$(cat "${R}/${PROC_PORTS}")" '50000-50090,50100-61000'
  expect_eq 'reservation already covered: boot drop-in records the live list' \
    "$(grep -v '^#' "${R}/${SYSCTL_DROPIN}")" 'net.ipv4.ip_local_reserved_ports = 50000-50090,50100-61000'
  rm -rf "${R}"

  make_host
  printf '50080,50100-55000\n' >"${R}/${PROC_PORTS}"
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'reservation partly covered: completed' "$(cat "${R}/${PROC_PORTS}")" '50080,50100-55000,50080,50100-59999'
  rm -rf "${R}"

  # A host that cannot set it still provisions, loudly.
  make_host
  rm "${R}/${PROC_PORTS}"
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'reservation unavailable: provision still succeeds' "$PROV_RC" 0
  expect_eq 'reservation unavailable: warns' \
    "$(grep -c 'WARNING could not reserve the Ficus port range' "${R}/stderr.log")" 1
  rm -rf "${R}"

  # -- box port guard -------------------------------------------------------------
  # Box processes may not bind the Ficus range. In user mode the box's own
  # systemd --user manager (inside the guarded slice) binds the box socket, so
  # exactly that port stays allowed.
  guard_deny_lines=$'SocketBindDeny=ipv4:tcp:50080\nSocketBindDeny=ipv6:tcp:50080\nSocketBindDeny=ipv4:tcp:50100-59999\nSocketBindDeny=ipv6:tcp:50100-59999'
  make_host
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'system port guard: denies the whole range in the box slice, allows nothing' \
    "$(cat "${R}/etc/systemd/system/ficus-box-${BOX}.slice.d/60-ficus-box-ports.conf")" \
    "$(printf '[Slice]\n%s' "${guard_deny_lines}")"
  expect_eq 'system port guard: the socket unit stays outside the box slice (PID1 binds it there)' \
    "$(grep -c '^Slice=' "${R}/etc/systemd/system/ficus-box-${BOX}.socket" || true)" 0
  expect_eq 'system port guard: says when systemd cannot enforce it' \
    "$(grep -c 'port guard (SocketBindDeny) is not enforced' "${R}/stderr.log")" 1
  rm -rf "${R}"

  make_host
  provision --sandbox-id squad_x --unit-mode user
  expect_eq 'user port guard: allows only its own port, then denies the range' \
    "$(cat "${R}/etc/systemd/system/user-1001.slice.d/60-ficus-box-ports.conf")" \
    "$(printf '[Slice]\nSocketBindAllow=ipv4:tcp:20001\n%s' "${guard_deny_lines}")"
  expect_eq 'user port guard: the guard dry run renders the installed file' \
    "$(PATH="${R}/.shims:${PATH}" STUB_R="${R}" FICUS_HOST_ROOT="${R}" bash "${TARGET}" --unix-user "${BOX}" --port 20001 --unit-mode user --print-port-guard)" \
    "$(cat "${R}/etc/systemd/system/user-1001.slice.d/60-ficus-box-ports.conf")"
  # Switching modes moves the guard with the slice.
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'mode switch: the user-slice guard is gone' \
    "$([[ -e ${R}/etc/systemd/system/user-1001.slice.d/60-ficus-box-ports.conf ]] && echo present || echo gone)" gone
  expect_eq 'mode switch: the system-slice guard is in place' \
    "$([[ -f ${R}/etc/systemd/system/ficus-box-${BOX}.slice.d/60-ficus-box-ports.conf ]] && echo present || echo gone)" present
  rm -rf "${R}"

  # -- busy port --------------------------------------------------------------------
  # systemctl only says "Job failed". Provisioning prints systemd's own reason
  # and the port's holder, and exits 75 (transient, Core retries) only when the
  # port is really held.
  for mode in system user; do
    sandbox_id=agent_busy
    [ "$mode" = system ] || sandbox_id=squad_busy
    make_host
    touch "${R}/fakedb/fail-start"
    printf 'ESTAB 0 0 127.0.0.1:20001 127.0.0.1:50080 users:(("sshd",pid=4242,fd=9))\n' >"${R}/fakedb/port-holder"
    printf 'ficus.socket: Failed to create listening socket (127.0.0.1:20001): Address already in use\n' >"${R}/fakedb/journal"
    provision --sandbox-id "$sandbox_id" --unit-mode "$mode"
    expect_eq "$mode busy port: exits with the port-busy status" "$PROV_RC" 75
    expect_eq "$mode busy port: no UID marker" "$(grep -c '^FICUS_BOX_UID=' "${R}/stdout.log" || true)" 0
    expect_eq "$mode busy port: prints the marker line" \
      "$(grep -c '^box-provision.sh: FICUS_BOX_PORT_BUSY port=20001$' "${R}/stderr.log")" 1
    expect_eq "$mode busy port: prints the holder" "$(grep -c 'users:(("sshd",pid=4242' "${R}/stderr.log")" 1
    expect_eq "$mode busy port: prints systemd's reason" "$(grep -c 'Address already in use' "${R}/stderr.log")" 1
    expect_eq "$mode busy port: asked ss for the exact port" \
      "$(grep -c '^ss -Htanp sport = :20001$' "${R}/calls.log")" 1
    if [ "$mode" = system ]; then
      expect_eq 'system busy port: journal of the system socket unit' \
        "$(grep -c "^journalctl --no-pager -n 20 -u ficus-box-${BOX}.socket$" "${R}/calls.log")" 1
    else
      expect_eq 'user busy port: journal of the user socket unit under the box uid' \
        "$(grep -c '^journalctl --no-pager -n 20 _UID=1001 USER_UNIT=ficus-sandbox-server.socket$' "${R}/calls.log")" 1
    fi
    rm -rf "${R}"
  done

  # systemd's reason alone is enough (the holder may already be gone).
  make_host
  touch "${R}/fakedb/fail-start"
  printf 'Failed to create listening socket (127.0.0.1:20001): Address already in use\n' >"${R}/fakedb/journal"
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'busy port from the journal alone: still the port-busy status' "$PROV_RC" 75
  rm -rf "${R}"

  # Any other socket failure stays a plain (terminal) failure.
  make_host
  touch "${R}/fakedb/fail-start"
  printf 'ficus.socket: Failed with result resources\n' >"${R}/fakedb/journal"
  provision --sandbox-id agent_x --unit-mode system
  expect_eq 'other socket failure: generic failure status' "$PROV_RC" 1
  expect_eq 'other socket failure: still prints systemd reason' "$(grep -c 'Failed with result resources' "${R}/stderr.log")" 1
  expect_eq 'other socket failure: no port-busy marker' "$(grep -c FICUS_BOX_PORT_BUSY "${R}/stderr.log" || true)" 0
  rm -rf "${R}"

fi

printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
[[ ${FAIL} -eq 0 ]]
