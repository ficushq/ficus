#!/usr/bin/env bash
set -euo pipefail

[[ $(uname -s) == Linux ]] || { echo 'bun node cross-user poison test: SKIP (Linux only)'; exit 0; }
[[ ${EUID} -eq 0 ]] || { echo 'run this regression as root' >&2; exit 1; }
command -v runuser >/dev/null
source_bun=$(command -v bun)
[[ -x ${source_bun} ]] || { echo 'bun is required' >&2; exit 1; }

scratch=$(mktemp -d /tmp/ficus-bun-node-cross-user.XXXXXX)
chmod 0755 "${scratch}"
root_home=${scratch}/root-home
runner_home=${scratch}/runner-home
stable_bin=${scratch}/system-bin
package=${scratch}/package
declare -A prior_dir=() prior_kind=() prior_target=() tracked=()

snapshot_shims() {
  local candidate
  while IFS= read -r candidate; do
    prior_dir["${candidate}"]=1
    tracked["${candidate}"]=1
    if [[ -L ${candidate}/node ]]; then
      prior_kind["${candidate}"]=link
      prior_target["${candidate}"]=$(readlink "${candidate}/node")
    elif [[ -e ${candidate}/node ]]; then
      echo "refusing to replace non-symlink Bun shim: ${candidate}/node" >&2
      return 1
    else
      prior_kind["${candidate}"]=absent
    fi
  done < <(find /tmp -maxdepth 1 -type d -name 'bun-node-*' -print 2>/dev/null)
}

track_current_shims() {
  local candidate
  while IFS= read -r candidate; do tracked["${candidate}"]=1; done \
    < <(find /tmp -maxdepth 1 -type d -name 'bun-node-*' -print 2>/dev/null)
}

cleanup() {
  local candidate
  for candidate in "${!tracked[@]}"; do
    if [[ -n ${prior_dir[${candidate}]:-} ]]; then
      case ${prior_kind[${candidate}]} in
        link) ln -sfn "${prior_target[${candidate}]}" "${candidate}/node" ;;
        absent) rm -f "${candidate}/node" ;;
      esac
    else
      rm -rf "${candidate}"
    fi
  done
  rm -rf "${scratch}"
}
trap cleanup EXIT

install -d -m 0700 "${root_home}"
install -m 0755 "${source_bun}" "${root_home}/bun"
install -d -m 0777 "${runner_home}"
install -d -m 0755 "${package}" "${stable_bin}" "${scratch}/tools"
ln -s /usr/bin/env "${scratch}/tools/env"
cat >"${package}/package.json" <<'JSON'
{"scripts":{"probe":"./probe.js"}}
JSON
cat >"${package}/probe.js" <<'JS'
#!/usr/bin/env node
console.log("cross-user-node-ok")
JS
chmod 0755 "${package}/probe.js"

snapshot_shims
# Bun's shim name is build-deterministic and process-global. Make every prior
# candidate usable by root before discovery, then restore all of them on EXIT.
# This makes the proof repeatable even when this Bun build's directory already
# exists because of unrelated host activity.
for candidate in "${!prior_dir[@]}"; do
  ln -sfn "${root_home}/bun" "${candidate}/node"
done
for attempt in 1 2; do
  (
    cd "${package}"
    PATH="${root_home}:${scratch}/tools" "${root_home}/bun" run probe >/dev/null
  )
  track_current_shims
done

poisoned=0
for candidate in "${!tracked[@]}"; do
  [[ -d ${candidate} ]] || continue
  ln -sfn "${root_home}/bun" "${candidate}/node"
  poisoned=1
done
[[ ${poisoned} == 1 ]] || { echo 'Bun did not expose its deterministic node shim' >&2; exit 1; }
runuser -u nobody -- test ! -x "${root_home}/bun" || {
  echo 'poison target unexpectedly executable by nobody' >&2
  exit 1
}

install -m 0755 "${source_bun}" "${stable_bin}/bun"
ln -s "${stable_bin}/bun" "${stable_bin}/node"
output=$(runuser -u nobody -- env -i \
  HOME="${runner_home}" PATH="${stable_bin}:/usr/bin:/bin" \
  "${stable_bin}/bun" run --cwd "${package}" probe)
grep -Fxq 'cross-user-node-ok' <<<"${output}"

cleanup
trap - EXIT
for candidate in "${!prior_dir[@]}"; do
  case ${prior_kind[${candidate}]} in
    link)
      [[ $(readlink "${candidate}/node") == "${prior_target[${candidate}]}" ]] || {
        echo "pre-existing shim target was not restored: ${candidate}" >&2; exit 1;
      }
      ;;
    absent)
      [[ ! -e ${candidate}/node ]] || {
        echo "pre-existing absent shim was not restored: ${candidate}" >&2; exit 1;
      }
      ;;
  esac
done
echo 'bun node cross-user poison test: PASS'
