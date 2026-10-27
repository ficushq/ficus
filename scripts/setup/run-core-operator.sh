#!/usr/bin/env bash
# run-core-operator.sh — run one of Core's operator entrypoints on THIS HOST as
# the account the Core services run as, with their environment.
#
#   FICUS_BC_SANDBOX_ID=<id> FICUS_BC_ACTION=status bash run-core-operator.sh box-control
#   FICUS_MB_MACHINE=all-stale                     bash run-core-operator.sh machine-bootstrap
#   FICUS_BR_BOX=all                               bash run-core-operator.sh box-reprovision
#   FICUS_STC_ACTION=reissue-platform-orchestrator bash run-core-operator.sh system-token-control
#   [--dest /opt/ficus-core]   (the install root; default /opt/ficus-core)
#
# Run it as root (the platform does, over ssh). As root it reads the files the
# services get from systemd — <dest>/.env (root 0600) and /etc/ficus/managed.env
# when present, later files winning as with EnvironmentFile= — and sets
# FICUS_ROOT=<dest>/current as the units' Environment= does. A variable the
# caller set (the entrypoint's FICUS_* request) is never overridden. Then it
# runs <dest>/current/apps/core/dist/<entrypoint>.js from that release's
# apps/core, as the User= of ficus-api (runuser; directly when that is root),
# with Bun's own .env loading off. The entrypoint refuses any other account
# (apps/core/src/lib/infra/operator-identity.ts), so nothing it writes under
# Core's HOME is ever root-owned.
#
# The env files are parsed, never shell-sourced: a value may hold shell
# metacharacters (the hosted DATABASE_URL carries `&sslrootcert=`), and `. .env`
# would run them. Each `KEY=VALUE` line is taken literally, with one pair of
# matching surrounding quotes removed; blank lines, comments and malformed keys
# are skipped. Nothing secret appears in argv. stdin, stdout, stderr and the
# exit status are the entrypoint's.
set -euo pipefail

usage() {
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
}

dest=/opt/ficus-core
while [[ $# -gt 0 ]]; do
  case $1 in
    --dest) dest=${2:?--dest needs a value}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) printf 'run-core-operator.sh: unknown option %s\n' "$1" >&2; usage; exit 2 ;;
    *) break ;;
  esac
done
[[ $# -eq 1 ]] || { usage; exit 2; }
entry=$1
case ${entry} in
  box-control | machine-bootstrap | box-reprovision | system-token-control) ;;
  *) printf 'run-core-operator.sh: unknown entrypoint %s\n' "${entry}" >&2; usage; exit 2 ;;
esac
fail() { printf 'run-core-operator.sh: %s\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || fail 'run it as root: it reads the root-only .env, then drops to the Core account'
release=$(readlink -f -- "${dest}/current") || fail "${dest}/current does not resolve to a release"
script="${release}/apps/core/dist/${entry}.js"
[[ -f ${script} ]] || fail "${script} is not in the active release"
bun=${BUN_BIN:-/usr/local/bin/bun}
[[ -x ${bun} ]] || fail "${bun} is not executable"

account=$(systemctl show -p User --value "${FICUS_UNIT_API:-ficus-api}" 2>/dev/null || true)
account=${account:-root}
id -u "${account}" >/dev/null 2>&1 || fail "ficus-api runs as '${account}', which does not exist"

# The env files, in systemd's order (a later file wins), then everything the
# caller did not set is exported.
declare -A loaded=()
declare -a order=()
load_env_file() { # FILE
  local line key value
  while IFS= read -r line || [[ -n ${line} ]]; do
    line=${line%$'\r'}
    [[ ${line} =~ ^[[:space:]]*(#|$) ]] && continue
    [[ ${line} == *=* ]] || continue
    key=${line%%=*}
    key=${key#export }
    key=${key//[[:space:]]/}
    [[ ${key} =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value=${line#*=}
    if [[ ${#value} -ge 2 && ( ${value} == \"*\" || ${value} == \'*\' ) && ${value:0:1} == "${value: -1}" ]]; then
      value=${value:1:${#value}-2}
    fi
    [[ -v loaded[${key}] ]] || order+=("${key}")
    loaded[${key}]=${value}
  done <"$1"
}
[[ -f ${dest}/.env ]] || fail "${dest}/.env not found"
load_env_file "${dest}/.env"
managed=${FICUS_MANAGED_ENV_PATH:-/etc/ficus/managed.env}
if [[ -f ${managed} ]]; then load_env_file "${managed}"; fi
for key in ${order[@]+"${order[@]}"}; do
  [[ -v ${key} ]] || export "${key}=${loaded[${key}]}"
done
unset loaded order
export FICUS_ROOT=${FICUS_ROOT:-${dest}/current}

cd "${release}/apps/core"
if [[ ${account} == root ]]; then
  exec "${bun}" --no-env-file "dist/${entry}.js"
fi
exec runuser -u "${account}" -- "${bun}" --no-env-file "dist/${entry}.js"
