#!/usr/bin/env bash
# REAL systemd/rootless Docker proof. NEVER run on a shared or live host.
# The normal PR CI job owns a disposable GitHub-hosted Ubuntu 24.04 VM.
set -euo pipefail

# Fail before any mutation, not a skip/success on unsupported environments.
if [ "${FICUS_TEST_DISPOSABLE_SYSTEMD:-}" != 1 ] || [ "${GITHUB_ACTIONS:-}" != true ] ||
  [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ]; then
  echo 'Requires an explicitly opted-in disposable GitHub-hosted systemd VM' >&2
  exit 2
fi
[ "$(id -u)" = 0 ]
[ "$(cat /proc/1/comm)" = systemd ]
[ -z "${FICUS_HOST_ROOT:-}" ]
[ ! -e /opt/ficus ] && [ ! -L /opt/ficus ]
[ ! -e /etc/sysctl.d/90-ficus-box-ports.conf ]
if getent passwd | grep -q '^box_'; then
  echo 'Existing box accounts: refusing host' >&2
  exit 2
fi
# shellcheck source=/dev/null
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ]
[ -e /sys/fs/cgroup/cgroup.controllers ]
for tool in dockerd-rootless-setuptool.sh docker rootlesskit newuidmap slirp4netns python3; do command -v "$tool"; done
[ -x /usr/lib/systemd/systemd-socket-proxyd ]

TARGET="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/box-provision.sh"
TRACE="${TARGET%/*}/box-provision-ci-trace.sh"
CAPTURE="${TARGET%/*}/box-provision-ci-capture.sh"
BOX="box_$(printf '%s' "${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}-${RANDOM}" | sha256sum | cut -c1-12)"
if id -u "$BOX" >/dev/null 2>&1; then exit 2; fi
reserved="$(cat /proc/sys/net/ipv4/ip_local_reserved_ports)"
uid='' owned=false caller=''

# CI fixture only: no credentials/config dumps or host-wide journal. Collect
# evidence before destroying the account, including when provisioning failed.
diagnose_runtime_failure() {
  local uid="$1"
  echo "Rootless runtime failure diagnostics for $BOX (uid=$uid)"
  timeout --kill-after=2s 5s systemctl --machine="$BOX@.host" --user \
    show docker.service -p ActiveState -p SubState -p Result -p ExecMainStatus -p ControlGroup || true
  timeout --kill-after=2s 5s journalctl --no-pager --boot --lines=80 --output=short-monotonic \
    "_UID=$uid" _SYSTEMD_USER_UNIT=docker.service || true
}

# Every process/container belongs to this exact freshly created account. Never
# use host-wide Docker cleanup, process-name kills, or another fixture's data.
cleanup() {
  local rc=$?
  trap - EXIT
  if [ "$owned" = true ]; then
    # A failed provision may already have created the user/manager.
    uid="$(id -u "$BOX" 2>/dev/null)" || uid=''
    if [ -n "$uid" ]; then
      if [ "$rc" -ne 0 ]; then diagnose_runtime_failure "$uid"; fi
      timeout --kill-after=5s 10s systemctl --machine="$BOX@.host" --user stop \
        ficus-sandbox-server.socket ficus-sandbox-server-proxy.service ficus-sandbox-server.service docker.service || rc=1
      timeout --kill-after=5s 10s loginctl disable-linger "$BOX" || rc=1
      timeout --kill-after=5s 10s systemctl stop "user@$uid.service" || rc=1
      rm -f -- "/etc/systemd/system/user-$uid.slice.d/50-ficus-box.conf" \
        "/etc/systemd/system/user-$uid.slice.d/60-ficus-box-ports.conf"
      rmdir -- "/etc/systemd/system/user-$uid.slice.d" || rc=1
      for slice in system.slice user.slice user-0.slice ficus.slice ficus-box.slice; do
        rm -f -- "/etc/systemd/system/$slice.d/50-ficus-memory-floor.conf"
        rmdir -- "/etc/systemd/system/$slice.d" 2>/dev/null || true
      done
      rm -f -- "/etc/systemd/user/ficus-docker.slice.d/50-ficus-oomd.conf"
      rmdir -- /etc/systemd/user/ficus-docker.slice.d 2>/dev/null || true
    fi
    if [ -n "$uid" ]; then timeout --kill-after=5s 10s userdel --remove "$BOX" || rc=1; fi
    rm -rf -- /opt/ficus
    rm -f /etc/sysctl.d/90-ficus-box-ports.conf
    printf '%s\n' "$reserved" >/proc/sys/net/ipv4/ip_local_reserved_ports
    timeout --kill-after=5s 10s systemctl daemon-reload || rc=1
  fi
  if [ -n "$caller" ]; then rm -rf -- "$caller"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
owned=true
# Deliberately inaccessible caller config: HOME-only isolation reproduced the
# Docker setuptool failure on the first PR run. Keep this poison in every phase.
caller="$(mktemp -d /tmp/ficus-cgroup-caller.XXXXXX)"
export XDG_CONFIG_HOME="$caller/config" XDG_DATA_HOME="$caller/data" XDG_CACHE_HOME="$caller/cache"
export DOCKER_CONFIG="$caller/docker" DOCKER_HOST="unix://$caller/docker.sock" DOCKER_CONTEXT=caller-context

provision() {
  # Small bounded fixture: 1 CPU and 512 MiB for the entire box, no load test.
  # Own a bounded full stdout+stderr record and publish it with the original
  # exit code before teardown can obscure it. The unprivileged workflow also
  # publishes failed output to its step summary; no summary path reaches root.
  bash "$CAPTURE" 150s bash "$TRACE" "$TARGET" --sandbox-id squad_cgroup_ci --unix-user "$BOX" \
    --unit-mode user --with-docker --port 50123 --nproc 2 --memtotal-kb 1048576
  uid="$(id -u "$BOX")"
}
userctl() { timeout --kill-after=5s 30s systemctl --machine="$BOX@.host" --user "$@"; }
as_box() {
  timeout --kill-after=5s 40s runuser -u "$BOX" -- \
    env -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    "HOME=/home/$BOX" "XDG_CONFIG_HOME=/home/$BOX/.config" \
    "XDG_DATA_HOME=/home/$BOX/.local/share" "XDG_CACHE_HOME=/home/$BOX/.cache" \
    "DOCKER_CONFIG=/home/$BOX/.docker" "DOCKER_HOST=unix:///run/user/$uid/docker.sock" \
    "XDG_RUNTIME_DIR=/run/user/$uid" \
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus" "$@"
}
docker_box() { as_box docker --host="unix:///run/user/$uid/docker.sock" "$@"; }

# Name the failing check: a bare [ ] under set -e fails without saying which.
check() { # DESCRIPTION ACTUAL EXPECTED
  if [ "$2" != "$3" ]; then
    printf 'CHECK FAILED: %s: expected %q, got %q\n' "$1" "$3" "$2" >&2
    return 1
  fi
}
assert_pid() {
  local pid="$1" role="$2" cg
  cg="$(sed -n 's/^0:://p' "/proc/$pid/cgroup")"
  case "$cg" in "$parent"/*) ;; *)
    echo "$role escaped box boundary: $cg" >&2
    return 1
    ;;
  esac
  printf '%s pid=%s cgroup=%s\n' "$role" "$pid" "$cg"
}
assert_caps() {
  local quota period extra high page_size
  parent="/user.slice/user-$uid.slice"
  [ "$(systemctl show -p ControlGroup --value "user@$uid.service")" = "$parent/user@$uid.service" ]
  [ "$(cat "/sys/fs/cgroup$parent/memory.max")" = 536870912 ]
  # A 1 GiB host keeps a 512 MiB reserve, so the cap is the other 512 MiB and
  # the soft cap 256 MiB below it (docs/wiki/machines/memory-model.md). The
  # previous 45% value must NOT pass.
  high="$(cat "/sys/fs/cgroup$parent/memory.high")"
  page_size="$(getconf PAGESIZE)"
  [ "$high" -eq "$((268435456 / page_size * page_size))" ]
  # The floor and swap share the provisioner computed for this host reach the
  # kernel (page-rounded); the slice is never left unprotected.
  local expected low swap
  expected="$(bash "$TARGET" --print-slice-limits --memtotal-kb 1048576 --nproc 2 --unix-user "$BOX" --sandbox-id squad_cgroup_ci --with-docker)"
  low="$(sed -n 's/^MemoryLow=//p' <<<"$expected")"
  swap="$(sed -n 's/^MemorySwapMax=//p' <<<"$expected")"
  check 'box floor is set' "$([ "$low" -gt 0 ] && echo yes)" yes
  check 'box memory.low' "$(cat "/sys/fs/cgroup$parent/memory.low")" "$((low / page_size * page_size))"
  check 'box memory.swap.max' "$(cat "/sys/fs/cgroup$parent/memory.swap.max")" "$((swap / page_size * page_size))"
  check 'user.slice floor' "$([ "$(systemctl show -p MemoryLow --value user.slice)" -gt 0 ] && echo yes)" yes
  check 'system.slice floor' "$([ "$(systemctl show -p MemoryLow --value system.slice)" -gt 0 ] && echo yes)" yes
  # systemd 255 accepts the oomd policy on the server unit and Docker's slice.
  # It prints the limit with two decimals (50.00%).
  check 'server unit delegation and oomd policy' \
    "$(userctl show -p Delegate -p DelegateSubgroup -p ManagedOOMMemoryPressure -p ManagedOOMMemoryPressureLimit \
      ficus-sandbox-server.service | sed 's/^\(ManagedOOMMemoryPressureLimit=50\)\(\.00\)\?%$/\1%/' | LC_ALL=C sort | paste -sd' ' -)" \
    'Delegate=yes DelegateSubgroup=supervisor ManagedOOMMemoryPressure=kill ManagedOOMMemoryPressureLimit=50%'
  check 'Docker slice oomd policy' "$(userctl show -p ManagedOOMMemoryPressure --value ficus-docker.slice)" kill
  read -r quota period extra <"/sys/fs/cgroup$parent/cpu.max"
  [ -z "$extra" ] && [ "$quota" -gt 0 ] && [ "$quota" -eq "$period" ]
  [ "$(docker_box info --format '{{.CgroupDriver}} {{.CgroupVersion}}')" = 'systemd 2' ]
  # The box UID cannot raise its ancestor's root-owned CPU or memory limits.
  # Expansion belongs to the unprivileged child shell, not the root test shell.
  # shellcheck disable=SC2016
  if as_box sh -c 'printf max >"$1/memory.max"' sh "/sys/fs/cgroup$parent" 2>/dev/null; then return 1; fi
  # shellcheck disable=SC2016
  if as_box sh -c 'printf "max 100000" >"$1/cpu.max"' sh "/sys/fs/cgroup$parent" 2>/dev/null; then return 1; fi
  [ "$(cat "/sys/fs/cgroup$parent/memory.max")" = 536870912 ]
}
assert_workload() { # PHASE [CONTAINER_PARENT]
  local phase="$1" container_parent="${2:-}" cid scope pids pid role
  local -a parent_args=()
  if [ -n "$container_parent" ]; then parent_args=("--cgroup-parent=$container_parent"); fi
  assert_caps
  # No network, no restart policy, tiny sleeping payload, hard lifetime even if
  # the assertion fails and Docker stops answering. Only one container at a time.
  cid="$(docker_box create --name "$phase" --network=none --restart=no --stop-timeout=3 \
    "${parent_args[@]}" busybox:1.37.0 sleep 120)"
  docker_box start "$cid" >/dev/null
  scope="$(userctl show -p ControlGroup --value "docker-$cid.scope")"
  case "$scope" in "$parent/user@$uid.service/"*) ;; *)
    echo "payload scope escaped: $scope" >&2
    return 1
    ;;
  esac
  if [ -z "$container_parent" ]; then
    [ "$scope" = "$parent/user@$uid.service/ficus.slice/ficus-docker.slice/docker-$cid.scope" ]
  fi
  pids="$(cat "/sys/fs/cgroup$scope/cgroup.procs")"
  [ -n "$pids" ]
  for pid in $pids; do assert_pid "$pid" payload; done
  for role in dockerd containerd; do
    pids="$(pgrep -u "$uid" -x "$role")"
    [ -n "$pids" ]
    for pid in $pids; do assert_pid "$pid" "$role"; done
  done
  pids="$(pgrep -u "$uid" -f containerd-shim-runc-v2)"
  [ -n "$pids" ]
  for pid in $pids; do assert_pid "$pid" shim; done
  assert_pid "$(userctl show -p MainPID --value docker.service)" rootlesskit
  [ "$(cat "/sys/fs/cgroup$parent/memory.current")" -gt 0 ]
  [ "$(awk '$1 == "usage_usec" {print $2}' "/sys/fs/cgroup$parent/cpu.stat")" -gt 0 ]
  docker_box rm --force "$cid" >/dev/null
  echo "PASS real cgroup ancestry and caps: $phase"
}

# The sandbox server's own steps (packages/sandbox-server/src/services/
# workload-cgroup.ts), run by python under a unit with the same delegation
# settings, in both managers: start in supervisor/, enable memory+pids below
# the unit, mark supervisor user.oomd_omit, and move a child into
# workload/inv-<id>. Proves ownership, xattr and controller semantics on real
# systemd 255 + kernel; oomd itself is not exercised here.
WORKLOAD_PROBE='
import os, subprocess, sys, time
own = open("/proc/self/cgroup").read().strip().split("::", 1)[1]
assert own.endswith("/supervisor"), own
sup = "/sys/fs/cgroup" + own
unit = os.path.dirname(sup)
with open(unit + "/cgroup.subtree_control", "w") as f: f.write("+memory +pids")
os.setxattr(sup, "user.oomd_omit", b"1")
os.makedirs(unit + "/workload/inv-ci", exist_ok=True)
with open(unit + "/workload/cgroup.subtree_control", "w") as f: f.write("+memory +pids")
child = subprocess.Popen(["sleep", "60"])
with open(unit + "/workload/inv-ci/cgroup.procs", "w") as f: f.write(str(child.pid))
with open(sys.argv[1], "w") as f: f.write(unit)
time.sleep(60)
'
assert_delegated_workloads() { # MANAGER(system|user)
  local manager="$1" marker_dir marker unit_cg
  # The box user writes its unit's cgroup path here; never into the poisoned caller dir.
  marker_dir="$(mktemp -d /tmp/ficus-delegate.XXXXXX)"
  chown "$BOX" "$marker_dir"
  marker="$marker_dir/unit"
  local -a run=(timeout --kill-after=5s 30s systemd-run --unit "ficus-ci-delegate-$manager" --collect
    -p Delegate=yes -p DelegateSubgroup=supervisor -p ManagedOOMMemoryPressure=kill -p ManagedOOMMemoryPressureLimit=50%)
  if [ "$manager" = system ]; then
    run+=(--uid "$BOX" --gid "$BOX")
  else
    run+=("--machine=$BOX@.host" --user)
  fi
  "${run[@]}" /usr/bin/python3 -c "$WORKLOAD_PROBE" "$marker"
  for _ in $(seq 1 100); do [ -s "$marker" ] && break; sleep 0.1; done
  unit_cg="$(cat "$marker")"
  python3 - "$unit_cg" <<'PY'
import os, sys
unit = sys.argv[1]
assert os.getxattr(unit + "/supervisor", "user.oomd_omit") == b"1"
pids = open(unit + "/workload/inv-ci/cgroup.procs").read().split()
assert len(pids) == 1, pids
assert os.path.exists(unit + "/workload/inv-ci/memory.current"), "memory controller missing in the leaf"
assert open(unit + "/supervisor/cgroup.procs").read().split(), "server left its supervisor subgroup"
PY
  if [ "$manager" = system ]; then
    timeout --kill-after=5s 20s systemctl stop "ficus-ci-delegate-$manager.service"
  else
    userctl stop "ficus-ci-delegate-$manager.service"
  fi
  rm -rf -- "$marker_dir"
  echo "PASS delegated workload cgroups: $manager manager"
}

provision
assert_delegated_workloads system
assert_delegated_workloads user
# One small public fixture image; no workload/build/test DB images or host daemon.
docker_box pull busybox:1.37.0 >/dev/null
assert_workload first-provision
# systemd launches the daemon independently of the provisioning shell. Poison
# this fixture's own manager too; the Docker unit must override these paths.
userctl set-environment "HOME=$caller" "XDG_RUNTIME_DIR=$caller/run" \
  "XDG_CONFIG_HOME=$caller/config" "XDG_DATA_HOME=$caller/data" "XDG_CACHE_HOME=$caller/cache" \
  "DOCKER_CONFIG=$caller/docker" "DOCKER_HOST=unix://$caller/docker.sock" DOCKER_CONTEXT=caller-context \
  "DBUS_SESSION_BUS_ADDRESS=unix:path=$caller/bus"
before="$(userctl show -p MainPID --value docker.service)"
provision
[ "$(userctl show -p MainPID --value docker.service)" = "$before" ]
assert_workload unchanged-reprovision
userctl restart docker.service
assert_workload daemon-restart
# A caller-selected parent may choose another USER slice, never escape the
# root-owned box ancestor. This catches reliance on docker.service alone.
assert_workload custom-parent escape.slice
# Emulate the persisted-home recreation/startup path with no user manager alive.
userctl stop docker.service
timeout --kill-after=5s 20s loginctl disable-linger "$BOX"
timeout --kill-after=5s 20s systemctl stop "user@$uid.service"
provision
assert_workload manager-recreation
printf '2 delegated workload phases passed\n'
printf '5 real rootless containment phases passed\n'
