#!/usr/bin/env bash
# bigbrain-host.test.sh — managed BigBrain setup-toolkit hooks (lib.sh), with fake
# runtime/state paths. Never touches real /etc, /var/lib, systemd, Caddy or accounts.
# Run: bash scripts/setup/bigbrain-host.test.sh   (needs mikefarah yq v4, jq, flock)
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); }
bad() {
  FAIL=$((FAIL + 1))
  log_error "FAIL: $*"
}
expect_eq() { if [[ $2 == "$3" ]]; then ok; else bad "$1 — expected '$3', got '$2'"; fi; }
expect_match() { if [[ $2 =~ $3 ]]; then ok; else bad "$1 — '$2' does not match /$3/"; fi; }
expect_fail() { # DESCRIPTION OUTPUT-REGEX CMD...
  local description=$1 regex=$2 out status=0
  shift 2
  out=$("$@" 2>&1) || status=$?
  if [[ ${status} -ne 0 && ${out} =~ ${regex} ]]; then ok; else bad "${description} — status ${status}, output '${out}'"; fi
}

yq_is_mikefarah || {
  log_error 'mikefarah yq v4 is required'
  exit 1
}
T=$(mktemp -d)
trap 'rm -rf "${T}"' EXIT
# Unprivileged test: run "root" commands directly against the temporary tree.
as_root() { "$@"; }
BIGBRAIN_ETC="${T}/etc"
BIGBRAIN_STATE="${T}/state"
TENANT=11111111-1111-4111-8111-111111111111
BINDING=33333333-3333-4333-8333-333333333333

config() { # YAML
  CFG_FILE="${T}/config.yaml"
  printf '%s\n' "$1" >"${CFG_FILE}"
}

# --- config section ------------------------------------------------------------
config 'core: {port: 3000}'
expect_eq 'absent section is disabled with no identity' "$(bigbrain_config_json)" '{"enabled":false}'
config 'bigbrain: {enabled: false}'
expect_eq 'explicit disabled' "$(bigbrain_config_json)" '{"enabled":false}'
config "bigbrain: {enabled: true, tenant_id: ${TENANT}, physical_host_binding: ${BINDING}, host_epoch: 4, zone: bb.example.com}"
expect_eq 'enabled maps the agreed snake_case keys to the installer schema' "$(bigbrain_config_json)" \
  "{\"enabled\":true,\"tenantId\":\"${TENANT}\",\"physicalHostBinding\":\"${BINDING}\",\"hostEpoch\":4,\"zone\":\"bb.example.com\"}"
config "bigbrain: {enabled: true, tenant_id: ${TENANT}, physical_host_binding: ${BINDING}, host_epoch: 4, zone: bb.example.com, tenant_label: noah}"
expect_eq 'the optional tenant label maps to tenantLabel' "$(bigbrain_config_json)" \
  "{\"enabled\":true,\"tenantId\":\"${TENANT}\",\"physicalHostBinding\":\"${BINDING}\",\"hostEpoch\":4,\"zone\":\"bb.example.com\",\"tenantLabel\":\"noah\"}"
config "bigbrain: {enabled: true, tenant_id: ${TENANT}, physical_host_binding: ${BINDING}, host_epoch: 4, zone: bb.example.com, artifact: /tmp/x}"
expect_fail 'unknown keys (paths, limits, artifacts) are refused' 'bigbrain must contain only' bigbrain_config_json
config "bigbrain: {tenant_id: ${TENANT}}"
expect_fail 'identity without enabled: true is refused' 'bigbrain must contain only' bigbrain_config_json

# --- Caddy include survives every normal Core re-render -------------------------
plain=$(render_caddyfile 'ficus.example.com' 3000 /c.crt /c.key)
expect_eq 'disabled hosts keep the exact previous Caddyfile' "$(grep -c 'import' <<<"${plain}" || true)" 0
with=$(BIGBRAIN_INGRESS=true render_caddyfile 'ficus.example.com' 3000 /c.crt /c.key)
expect_match 'enabled hosts import the controller-owned vault sites' "${with}" "import ${T}/bigbrain-caddy/\\*\\.caddy"
# Caddy reloads as the caddy user: the include must never sit inside the root-only (0700) etc dir,
# where its glob silently matches nothing and every vault host gets Caddy's empty 200.
expect_eq 'production vault sites live beside, not inside, the root-only etc directory' \
  "$(BIGBRAIN_ETC=/etc/ficus/bigbrain bigbrain_caddy_sites)" /etc/ficus/bigbrain-caddy
expect_eq 'the include is the only change' "$(diff <(printf '%s\n' "${plain}") <(printf '%s\n' "${with}") | grep -c '^>' || true)" 2
config "ingress: {caddy: false}
bigbrain: {enabled: true, tenant_id: ${TENANT}, physical_host_binding: ${BINDING}, host_epoch: 0, zone: bb.example.com}"
BIGBRAIN_INGRESS=false
upgrade_caddy_prepare /nonexistent.env >/dev/null 2>&1
expect_eq 'upgrade re-render derives the include from the same config' "${BIGBRAIN_INGRESS}" true
BIGBRAIN_INGRESS=false

# --- installer hook --------------------------------------------------------------
release="${T}/release"
mkdir -p "${release}/bigbrain" "${BIGBRAIN_STATE}/control" "${BIGBRAIN_ETC}"
chmod 0711 "${BIGBRAIN_STATE}"
chmod 0700 "${BIGBRAIN_STATE}/control"
enabled_json=$(config "bigbrain: {enabled: true, tenant_id: ${TENANT}, physical_host_binding: ${BINDING}, host_epoch: 0, zone: bb.example.com}" && bigbrain_config_json)

expect_eq 'disabled without an installed host is a no-op' "$(bigbrain_install "${release}" '{"enabled":false}' && echo noop)" noop
expect_fail 'enabled release without the runtime refuses before any change' 'carries its runtime' \
  bigbrain_install "${release}" "${enabled_json}"
[[ ! -e ${BIGBRAIN_STATE}/control/host.lock ]] && ok || bad 'no lock/state created without a runtime'

# A stand-in "bun" that runs the stand-in bundle (a shell script) with the hook's exact argv.
BIGBRAIN_BUN="${T}/fake-bun"
cat >"${BIGBRAIN_BUN}" <<'EOF'
#!/usr/bin/env bash
[[ $1 == --no-install && $2 == --no-env-file && ${BUN_RUNTIME_TRANSPILER_CACHE_PATH:-} == 0 && -z ${FICUS_LEAK_PROBE:-} ]] || exit 7
shift 2
exec bash "$@"
EOF
chmod 0755 "${BIGBRAIN_BUN}"
cat >"${release}/bigbrain/ficus-bigbrain-host.js" <<EOF
set -euo pipefail
[[ \$1 == install && ( \$# -eq 1 || ( \$# -eq 3 && \$2 == --core-account ) ) ]] || exit 9
printf '%s\n' "\$*" >"${T}/argv"
# The lock is held (fd 9) by our parent while we run; a second locker must fail.
flock -n -x "${BIGBRAIN_STATE}/control/host.lock" true && exit 8
cat >"${T}/stdin.json"
stat -c '%a' "${BIGBRAIN_STATE}/control/host.lock" >"${T}/lock-mode"
# The hook clears the environment, so canned refusals come from a file, not a variable.
if [[ -s "${T}/fake-result" ]]; then cat "${T}/fake-result"; exit 0; fi
printf '{"ok":true,"created":true,"artifactDigest":"sha256:%s","hostEpoch":0,"hostState":"active"}\n' "$(printf 'a%.0s' {1..64})"
EOF
out=$(FICUS_LEAK_PROBE=secret bigbrain_install "${release}" "${enabled_json}" 2>&1)
expect_match 'installer runs under the held lifecycle lock and reports a safe summary' "${out}" 'runtime installed: .*"created":true'
expect_eq 'installer receives exactly the validated config on stdin' "$(cat "${T}/stdin.json")" "${enabled_json}"
expect_eq 'lock file is created private without truncation' "$(cat "${T}/lock-mode")" 600
expect_eq 'a root Core: the installer gets no argument' "$(cat "${T}/argv")" 'install'

# A non-root Core (core.run_user): the installer is told the account (it shares the host record
# and read handoffs with its group and adds it to the gateway client group), then the one sudoers
# rule for the root helper is installed, visudo-checked, 0440 root.
out=$(
  RUN_USER=svc BIGBRAIN_SUDOERS="${T}/sudoers-bigbrain"
  as_root() {
    case $1 in
      visudo) printf 'visudo %s\n' "$*" >>"${T}/sudo-calls" ;;
      install) printf '%s\n' "$*" >>"${T}/sudo-calls"; cp "${@: -2:1}" "${@: -1}" ;;
      *) "$@" ;;
    esac
  }
  bigbrain_install "${release}" "${enabled_json}" 2>&1
)
expect_eq 'a non-root Core: the installer is told the Core account' "$(cat "${T}/argv")" 'install --core-account svc'
expect_eq 'a non-root Core: the sudoers rule allows exactly the helper, with no arguments' \
  "$(cat "${T}/sudoers-bigbrain")" 'svc ALL=(root) NOPASSWD: /usr/local/libexec/ficus-bigbrainctl ""'
expect_match 'a non-root Core: the rule is visudo-validated before it is installed 0440 root' \
  "$(cat "${T}/sudo-calls")" "^visudo visudo -cf .*"$'\n'"install -m 0440 -o root -g root .* ${T}/sudoers-bigbrain$"
rm -f "${T}/sudo-calls"

with_result() {
  printf '%s\n' "$1" >"${T}/fake-result"
  bigbrain_install "${release}" "${enabled_json}"
}
expect_fail 'a refusal stops setup with only its safe code' 'install refused \(identity_mismatch\)' \
  with_result '{"ok":false,"code":"identity_mismatch"}'
out=$(with_result '{"ok":false,"code":"SECRET VALUE"}' 2>&1) || true
expect_match 'unsafe runtime codes collapse to a fixed code' "${out}" 'install refused \(operation_failed\)'
[[ ${out} != *SECRET* ]] && ok || bad 'runtime output is never reflected into setup logs'
out=$(with_result 'not json SECRET' 2>&1) || true
[[ ${out} != *SECRET* && ${out} == *operation_failed* ]] && ok || bad 'malformed runtime output is never reflected'

: >"${T}/fake-result"
: >"${BIGBRAIN_ETC}/host.json"
expect_fail 'disabling an installed host refuses instead of orphaning vaults' 'would orphan its vaults' \
  bigbrain_install "${release}" '{"enabled":false}'

# --- restore staging (before any database/file change) -------------------------------
# Unprivileged: root ownership is not testable here (CI's Linux containment lane covers it).
as_root() {
  local -a args=()
  case $1 in
    chown) return 0 ;;
    install)
      while (($#)); do
        case $1 in -o | -g) shift 2 ;; *) args+=("$1") && shift ;; esac
      done
      "${args[@]}"
      ;;
    *) "$@" ;;
  esac
}
VA=22222222-2222-4222-8222-222222222222
envelope() { # DIR [TENANT]
  rm -rf "$1"
  mkdir -p "$1/managed-bigbrain/vaults" "$1/home"
  printf '{"schema":1,"tenantId":"%s"}\n' "${2:-${TENANT}}" >"$1/managed-bigbrain/manifest.json"
  printf 'tar\n' >"$1/managed-bigbrain/vaults/${VA}.tar"
}
E="${T}/envelope"
envelope "${E}"
bigbrain_restore_stage "${E}" "${enabled_json}"
expect_eq 'restore: managed data is moved out of the envelope (never mistaken for HOME_DIR)' \
  "$(find "${E}" -mindepth 1 -maxdepth 1 -type d | sed "s#${E}/##")" home
expect_eq 'restore: staged at the fixed root-private location' \
  "$(cat "${BIGBRAIN_STATE}/restore/managed-bigbrain/vaults/${VA}.tar")" tar
expect_eq 'restore: staging is private' "$(stat -c '%a' "${BIGBRAIN_STATE}/restore")" 700

envelope "${E}" 66666666-6666-4666-8666-666666666666
expect_fail 'restore: a foreign tenant archive with managed vaults is refused before any change' 'different tenant' \
  bigbrain_restore_stage "${E}" "${enabled_json}"
[[ -d ${E}/managed-bigbrain ]] && ok || bad 'restore: refused data is left in place, nothing staged'
envelope "${E}"
expect_fail 'restore: a host without the feature refuses an archive with vaults' 'not enabled' \
  bigbrain_restore_stage "${E}" '{"enabled":false}'
envelope "${E}"
ln -s /etc/passwd "${E}/managed-bigbrain/vaults/${VA}.tar.link"
expect_fail 'restore: links in the managed data are refused' 'unexpected entry' bigbrain_restore_stage "${E}" "${enabled_json}"
envelope "${E}"
rm "${E}/managed-bigbrain/vaults/${VA}.tar" && ln -s /etc/passwd "${E}/managed-bigbrain/vaults/${VA}.tar"
expect_fail 'restore: a vault archive that is a symlink is refused' 'unexpected entry' bigbrain_restore_stage "${E}" "${enabled_json}"
envelope "${E}"
mkdir "${E}/managed-bigbrain/vaults/nested"
expect_fail 'restore: unexpected directories are refused' 'unexpected entry' bigbrain_restore_stage "${E}" "${enabled_json}"
rm -rf "${E}" && mkdir -p "${E}/home"
expect_eq 'restore: envelopes without managed data are unchanged' "$(bigbrain_restore_stage "${E}" '{"enabled":false}' && echo noop)" noop

printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
[[ ${FAIL} -eq 0 ]]
