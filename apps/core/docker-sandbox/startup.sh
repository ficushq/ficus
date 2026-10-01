#!/bin/sh
set -eu

# PID 1 owns the Docker daemon (when required), the authenticated executor, and
# a permission-scoping raw byte forwarder to the daemon socket. The forwarder
# does not filter Docker APIs or create an escape boundary: Ficus retains full
# daemon authority (host-root-equivalent in socket mode). Secrets stay in a
# root-only file, never Docker env.
unset DOCKER_HOST
export DOCKER_HOST=

DOCKERD_PID=
PROXY_PID=
EXECUTOR_PID=
PROXY_DIR=/run/ficus-docker
PROXY_SOCKET=/run/ficus-docker/docker.sock
TOKEN_FILE=/run/ficus/executor-token
PROXY_PID_FILE=/run/ficus/proxy.pid
EXECUTOR_PID_FILE=/run/ficus/executor.pid
CHILD_EXIT_FIFO=/run/ficus/child-exit

. /usr/local/lib/ficus-shutdown.sh

supervise_child() {
  label=$1
  pid_file=$2
  shift 2
  child=
  trap 'stop_and_join "$child"; exit 143' TERM INT
  "$@" &
  child=$!
  # Optional OOM protection for this child (root-only write; best-effort so a
  # kernel without the knob never breaks startup).
  if [ -n "${FICUS_CHILD_OOM_ADJ:-}" ]; then
    echo "$FICUS_CHILD_OOM_ADJ" >"/proc/$child/oom_score_adj" 2>/dev/null || true
  fi
  printf '%s\n' "$child" >"$pid_file"
  set +e
  wait "$child"
  status=$?
  set -e
  printf '%s\n' "$label" >"$CHILD_EXIT_FIFO"
  exit "$status"
}

cleanup() {
  trap - EXIT INT TERM
  stop_and_join "$EXECUTOR_PID"
  stop_and_join "$PROXY_PID"
  stop_and_join "$DOCKERD_PID"
  rm -f "$PROXY_SOCKET" "$PROXY_PID_FILE" "$EXECUTOR_PID_FILE" "$CHILD_EXIT_FIFO"
}
trap cleanup EXIT INT TERM

if [ ! -S /var/run/docker.sock ]; then
  dockerd >/var/log/dockerd.log 2>&1 &
  DOCKERD_PID=$!
  for _ in $(seq 1 60); do
    [ -S /var/run/docker.sock ] && docker info >/dev/null 2>&1 && break
    sleep 1
  done
  if ! docker info >/dev/null 2>&1; then
    echo '[ficus-sandbox] Docker failed to start' >&2
    exit 1
  fi
fi

# Apply only a complete, safe host identity pair. Collisions fail closed rather
# than selecting another account or falling back to root.
IDENTITY_SOURCE=image
if printf '%s' "${FICUS_HOST_UID:-}:${FICUS_HOST_GID:-}" | grep -Eq '^[1-9][0-9]*:[1-9][0-9]*$' &&
   [ "$FICUS_HOST_UID" -le 2147483647 ] && [ "$FICUS_HOST_GID" -le 2147483647 ] &&
   [ "$FICUS_HOST_UID" -ne 65534 ] && [ "$FICUS_HOST_GID" -ne 65534 ]; then
  if awk -F: -v id="$FICUS_HOST_UID" '$3 == id && $1 != "ficus" { found=1 } END { exit !found }' /etc/passwd ||
     awk -F: -v id="$FICUS_HOST_GID" '$3 == id && $1 != "ficus" { found=1 } END { exit !found }' /etc/group; then
    echo '[ficus-sandbox] requested command identity collides with the image' >&2
    exit 1
  fi
  groupmod -g "$FICUS_HOST_GID" ficus
  usermod -u "$FICUS_HOST_UID" -g "$FICUS_HOST_GID" ficus
  chown "$FICUS_HOST_UID:$FICUS_HOST_GID" /home/ficus /workspace
  IDENTITY_SOURCE=host
fi

RESOLVED_UID="$(id -u ficus)"
RESOLVED_GID="$(id -g ficus)"
CONTRACT_DIGEST="$(printf '%s' "$(jq -cS . /opt/ficus/command-identity.json)" | sha256sum | awk '{print $1}')"
test "$(awk -F: '$1 == "ficus" { print $6 }' /etc/passwd)" = /home/ficus
test "$(awk -F: '$1 == "ficus" { print $3 }' /etc/passwd)" = "$RESOLVED_UID"
test "$(awk -F: '$1 == "ficus" { print $3 }' /etc/group)" = "$RESOLVED_GID"
test "${#CONTRACT_DIGEST}" = 64
jq -e '.version == 1 and .user == "ficus" and .home == "/home/ficus" and .uid == 1000 and .gid == 1000' /opt/ficus/command-identity.json >/dev/null
su-exec ficus sh -eu -c 'test -w /home/ficus; test -w "$1"; probe="$1/.ficus-runtime-write-$$"; : >"$probe"; rm -f "$probe"' sh "$(pwd)"

# The proxy directory remains root-owned and non-writable by the command user.
install -d -o root -g root -m 0711 "$PROXY_DIR"
rm -f "$PROXY_SOCKET" "$CHILD_EXIT_FIFO"
mkfifo -m 0600 "$CHILD_EXIT_FIFO"
supervise_child proxy "$PROXY_PID_FILE" socat "UNIX-LISTEN:$PROXY_SOCKET,fork,user=ficus,group=ficus,mode=0600" UNIX-CONNECT:/var/run/docker.sock &
PROXY_PID=$!
for _ in $(seq 1 50); do [ -S "$PROXY_SOCKET" ] && break; sleep 0.1; done
su-exec ficus env DOCKER_HOST="unix://$PROXY_SOCKET" docker info >/dev/null

umask 077
openssl rand -hex 32 >"$TOKEN_FILE"
test "$(wc -c <"$TOKEN_FILE" | tr -d ' ')" = 65
chmod 0400 "$TOKEN_FILE"

export EXECUTOR_DOCKER_RUNTIME=1
export EXECUTOR_AUTH_TOKEN_FILE="$TOKEN_FILE"
export EXECUTOR_BIND=0.0.0.0
export EXECUTOR_COMMAND_USER=ficus
export EXECUTOR_COMMAND_HOME=/home/ficus
export EXECUTOR_COMMAND_UID="$RESOLVED_UID"
export EXECUTOR_COMMAND_GID="$RESOLVED_GID"
export EXECUTOR_COMMAND_SOURCE="$IDENTITY_SOURCE"
export EXECUTOR_COMMAND_CONTRACT_DIGEST="$CONTRACT_DIGEST"
# The sandbox-server must stay responsive to core's /healthz probes even when
# workloads peg every CPU (an in-box benchmark/build saturating the box starved
# the probe window and got healthy boxes condemned + recreated, destroying the
# running work — observed live 2026-08-20 on the squad box). Two guards:
#   - `nice -n -10`: we are root (workloads run as `ficus` at priority 0 via
#     su-exec), so the scheduler always preempts saturated workloads to run the
#     probe handler.
#   - `oom_score_adj=-500` (applied by supervise_child via FICUS_CHILD_OOM_ADJ,
#     passed as a prefix assignment so the FUNCTION sees it): under memory
#     pressure the OOM killer takes a workload, not the probe server.
# Browser service env — exported BEFORE the box server launches so the main
# server (and thus browser-proxy) inherits FICUS_BROWSER_DEV_ALLOW_USER. The
# dev-allow user is the OS user THIS script runs as, which is exactly the user
# the un-su-exec'd box server reports via os.userInfo() (see R-B17 note below).
export FICUS_BROWSER_SOCK="${FICUS_BROWSER_SOCK:-/run/tau-browser/sock}"
export FICUS_BROWSER_MEMORY_HIGH_MB="${FICUS_BROWSER_MEMORY_HIGH_MB:-2048}"
export FICUS_BROWSER_DEV_ALLOW_USER="${FICUS_BROWSER_DEV_ALLOW_USER:-$(id -un)}"

FICUS_CHILD_OOM_ADJ=-500 supervise_child executor "$EXECUTOR_PID_FILE" nice -n -10 bun run /opt/sandbox/src/server.ts &
EXECUTOR_PID=$!

# --- tau-browser service (dev parity with tau-browser.service on VM machines) --
# One container = one box = one context, so the shared-per-machine browser
# service (scripts/machine/browser/tau-browser.js, baked at /opt/tau/browser) runs
# here as a plain background process. It is NOT supervised and NOT a gate:
# musl-Chromium is documented-fragile (see the Dockerfile), so a failure to start
# must never take down the box server — hence the `|| ...` fail-open + a logged
# warning. The service authenticates against sha256(token) files under the tokens
# dir keyed by box user (R-B8); seed the container's OWN token digest so the same
# auth path the VM machines use also works in-container.
#
# R-B17 dev auth: the box server (main executor above) is NOT su-exec'd, so it
# runs as this script's user (root) and browser-proxy sends
# `x-ficus-box-user: <that user>` — which never matches the prod `box_<hex>` gate.
# FICUS_BROWSER_DEV_ALLOW_USER (a docker-dev-only env prod NEVER sets) tells the
# service to also accept exactly that user; the digest is therefore seeded at
# <that user>.token, and the var is exported so BOTH the main server (env above,
# already launched inheriting it) and the browser service (below) see it.
start_browser_service() {
  service=/opt/tau/browser/service/tau-browser.js
  [ -f "$service" ] || { echo '[ficus-sandbox] tau-browser service not present; skipping (dev parity)' >&2; return 0; }
  tokens_dir="${FICUS_BROWSER_TOKENS_DIR:-/opt/tau/browser-tokens}"
  ( umask 077; mkdir -p "$tokens_dir"; mkdir -p "$(dirname "$FICUS_BROWSER_SOCK")" )
  # sha256 of the container's own box token (trimmed of the trailing newline via
  # command substitution) — the SAME digest form box-manager pushes on VM hosts.
  digest="$(printf %s "$(cat "$TOKEN_FILE")" | sha256sum | cut -d' ' -f1)"
  # Seed under the user browser-proxy actually sends (FICUS_BROWSER_DEV_ALLOW_USER),
  # NOT the command user — the two differ (root vs ficus) and the header wins.
  ( umask 077; printf '%s' "$digest" >"$tokens_dir/${FICUS_BROWSER_DEV_ALLOW_USER}.token" )
  FICUS_BROWSER_TOKENS_DIR="$tokens_dir" bun "$service" >/var/log/tau-browser.log 2>&1 &
  echo "[ficus-sandbox] tau-browser service started (pid $!, sock $FICUS_BROWSER_SOCK, dev-user $FICUS_BROWSER_DEV_ALLOW_USER)" >&2
}
start_browser_service || echo '[ficus-sandbox] tau-browser service failed to start (non-fatal, dev parity)' >&2

# Either child reports its exact exit through the root-only FIFO. The EXIT trap
# then performs bounded termination and join of both supervised wrappers.
IFS= read -r FAILED_CHILD <"$CHILD_EXIT_FIFO"
echo "[ficus-sandbox] $FAILED_CHILD exited unexpectedly" >&2
exit 1
