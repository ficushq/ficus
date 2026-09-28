#!/usr/bin/env bash
# install.test.sh — runs the REAL scripts/install.sh against a local fixture
# release (file:// URLs, no network) and checks what it installs.
#
# The fixture mirrors what .github/workflows/cli-binaries.yml publishes: a
# manifest.json whose assets are ficus-<platform>.tar.gz (ficus-windows-x64.zip)
# archives holding only the `ficus` binary (`ficus.exe` on Windows) plus the
# bundled skills/. The fixture binary is a shell script that logs how it was
# invoked, so the installer's auth step can be observed without a backend.
#
# Run:  bash scripts/install.test.sh
#       bash scripts/install.test.sh --fixture-only DIR   (build the fixture
#       release into DIR and exit; the old-CLI smoke serves it over http)
set -uo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
INSTALLER="${HERE}/install.sh"
FIXTURE_VERSION='9.9.9-fixture'
FIXTURE_COMMIT='f1c05f1c05f1c05f1c05f1c05f1c05f1c05f1c05'
# The pre-rename binary name. Only ever asserted ABSENT or UNTOUCHED: the
# installer must never create, refresh or delete a file by this name.
OLD_BIN='tau'

# ------------------------------------------------------------------ fixture
build_fixture() { # DIR
  local dir=$1 stage plat
  stage=$(mktemp -d)
  mkdir -p "${dir}" "${stage}/unix/skills/ficus-memory" "${stage}/win"
  cat >"${stage}/unix/ficus" <<EOF
#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  echo "${FIXTURE_VERSION} (${FIXTURE_COMMIT}, 2026-09-26T00:00:00Z)"
  exit 0
fi
[ -n "\${FIXTURE_LOG:-}" ] && printf 'ficus %s password=%s\n' "\$*" "\${FICUS_PASSWORD:-}" >>"\${FIXTURE_LOG}"
exit 0
EOF
  chmod 755 "${stage}/unix/ficus"
  printf -- '---\nname: ficus-memory\n---\n' >"${stage}/unix/skills/ficus-memory/SKILL.md"
  for plat in macos-arm64 macos-x64 linux-arm64 linux-x64; do
    tar -czf "${dir}/ficus-${plat}.tar.gz" -C "${stage}/unix" ficus skills
  done
  if command -v zip >/dev/null 2>&1; then
    cp "${stage}/unix/ficus" "${stage}/win/ficus.exe"
    cp -R "${stage}/unix/skills" "${stage}/win/skills"
    (cd "${stage}/win" && zip -qr "${dir}/ficus-windows-x64.zip" ficus.exe skills)
  fi
  cat >"${dir}/manifest.json" <<EOF
{
  "version": "${FIXTURE_VERSION}",
  "commit": "${FIXTURE_COMMIT}",
  "buildDate": "2026-09-26T00:00:00Z",
  "baseUrl": "https://ficus.sh/cli",
  "assets": {
    "macos-arm64": "ficus-macos-arm64.tar.gz",
    "macos-x64": "ficus-macos-x64.tar.gz",
    "linux-arm64": "ficus-linux-arm64.tar.gz",
    "linux-x64": "ficus-linux-x64.tar.gz",
    "windows-x64": "ficus-windows-x64.zip"
  }
}
EOF
  cp "${INSTALLER}" "${dir}/install.sh"
  rm -rf "${stage}"
}

if [[ ${1:-} == --fixture-only ]]; then
  [[ -n ${2:-} ]] || {
    echo "usage: $0 --fixture-only DIR" >&2
    exit 2
  }
  build_fixture "$2"
  exit 0
fi

# ------------------------------------------------------------------ harness
PASS=0 FAIL=0
expect_eq() { # DESCRIPTION ACTUAL EXPECTED
  if [[ $2 == "$3" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected %q, got %q\n' "$1" "$3" "$2" >&2
  fi
}
expect_contains() { # DESCRIPTION HAYSTACK NEEDLE
  if [[ $2 == *"$3"* ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — %q not found in:\n%s\n' "$1" "$3" "$2" >&2
  fi
}
expect_not_contains() { # DESCRIPTION HAYSTACK NEEDLE
  if [[ $2 != *"$3"* ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — %q unexpectedly found in:\n%s\n' "$1" "$3" "$2" >&2
  fi
}

T=$(mktemp -d)
trap 'rm -rf "${T}"' EXIT
REL="${T}/release"
build_fixture "${REL}"
BASE="file://${REL}"
REAL_CURL=$(command -v curl)
SYS_PATH='/usr/bin:/bin:/usr/sbin:/sbin'

# A curl wrapper that records every URL the installer asks for and refuses
# https:// (so a case that would otherwise reach the real ficus.sh fails
# fast and visibly instead of touching the network).
STUB="${T}/stub"
mkdir -p "${STUB}"
cat >"${STUB}/curl" <<EOF
#!/bin/sh
for a in "\$@"; do case "\$a" in http*|file*) printf '%s\n' "\$a" >>"\${CURL_LOG:-/dev/null}" ;; esac; done
for a in "\$@"; do case "\$a" in https://*) exit 22 ;; esac; done
exec "${REAL_CURL}" "\$@"
EOF
chmod 755 "${STUB}/curl"

OUT='' RC=0
# run_install CASE_DIR [VAR=VALUE ...] — a clean environment (env -i), so no
# FICUS_/TAU_ variable from the caller's shell can leak into a case. HOME is
# CASE_DIR/home; FIXTURE_LOG and CURL_LOG live in CASE_DIR.
run_install() {
  local case_dir=$1
  shift
  mkdir -p "${case_dir}/home"
  RC=0
  OUT=$(env -i "HOME=${case_dir}/home" "PATH=${STUB}:${SYS_PATH}" \
    "FIXTURE_LOG=${case_dir}/ficus.log" "CURL_LOG=${case_dir}/curl.log" \
    "$@" sh "${INSTALLER}" </dev/null 2>&1) || RC=$?
}
log_of() { cat "$1/ficus.log" 2>/dev/null || true; }

# 1. A fresh install with FICUS_* inputs installs `ficus` and nothing else.
C="${T}/c1"
run_install "${C}" "FICUS_INSTALL_DIR=${C}/bin" "FICUS_SHARE_DIR=${C}/share" \
  "FICUS_DOWNLOAD_BASE_URL=${BASE}" FICUS_INSTALL_AUTH=0
expect_eq 'fresh install: exit 0' "${RC}" 0
expect_eq 'fresh install: ficus is executable' "$([[ -x ${C}/bin/ficus ]] && echo yes || echo no)" yes
expect_eq 'fresh install: no file under the old name' "$([[ -e ${C}/bin/${OLD_BIN} ]] && echo present || echo absent)" absent
expect_eq 'fresh install: the install dir holds exactly ficus' "$(ls "${C}/bin")" ficus
expect_eq 'fresh install: ficus --version is the fixture' "$("${C}/bin/ficus" --version)" \
  "${FIXTURE_VERSION} (${FIXTURE_COMMIT}, 2026-09-26T00:00:00Z)"
expect_eq 'fresh install: bundled skills land in the share dir' \
  "$([[ -f ${C}/share/skills/ficus-memory/SKILL.md ]] && echo yes || echo no)" yes
expect_contains 'fresh install: downloads the ficus-* asset' "$(cat "${C}/curl.log")" "${BASE}/ficus-"
expect_contains 'fresh install: closing hint names the ficus memory skill' "${OUT}" \
  'ficus skill install ficus-memory --agent pi'
expect_contains 'fresh install: closing hint runs ficus' "${OUT}" 'Run: ficus --help'
expect_not_contains 'fresh install: no "Tau" copy in the output' "${OUT}" 'Tau'

# 2. K1: the pre-rename setup.sh hands the installer only TAU_INSTALL_AUTH=0.
#    (The pre-rename `tau install --no-auth` sets nothing at all: commander
#    folds --no-auth into `auth: false`, which that code never read.)
C="${T}/c2"
run_install "${C}" "FICUS_INSTALL_DIR=${C}/bin" "FICUS_SHARE_DIR=${C}/share" \
  "FICUS_DOWNLOAD_BASE_URL=${BASE}" TAU_INSTALL_AUTH=0 # legacy-env (K1)
expect_eq 'K1 TAU_INSTALL_AUTH=0 alone: exit 0' "${RC}" 0
expect_eq 'K1 TAU_INSTALL_AUTH=0 alone: ficus installed' "$([[ -x ${C}/bin/ficus ]] && echo yes || echo no)" yes
expect_contains 'K1 TAU_INSTALL_AUTH=0 alone: auth step skipped' "${OUT}" 'Skipping Ficus auth setup'
expect_eq 'K1 TAU_INSTALL_AUTH=0 alone: ficus never ran auth' "$(log_of "${C}")" ''

# 3. K1: the pre-rename `tau install --auth` sets only TAU_INSTALL_AUTH=1.
C="${T}/c3"
run_install "${C}" "FICUS_INSTALL_DIR=${C}/bin" "FICUS_SHARE_DIR=${C}/share" \
  "FICUS_DOWNLOAD_BASE_URL=${BASE}" TAU_INSTALL_AUTH=1 \
  FICUS_AUTH_LABEL=lab FICUS_API_URL=http://core.test FICUS_PASSWORD=pw # legacy-env (K1)
expect_eq 'K1 TAU_INSTALL_AUTH=1 alone: exit 0' "${RC}" 0
expect_eq 'K1 TAU_INSTALL_AUTH=1 alone: takes the auth branch (login, then verify)' "$(log_of "${C}")" \
  "$(printf 'ficus auth login lab --api-url http://core.test password=pw\nficus squad list password=pw')"

# 4. FICUS_INSTALL_AUTH wins over the K1 fallback.
C="${T}/c4"
run_install "${C}" "FICUS_INSTALL_DIR=${C}/bin" "FICUS_SHARE_DIR=${C}/share" \
  "FICUS_DOWNLOAD_BASE_URL=${BASE}" FICUS_INSTALL_AUTH=0 TAU_INSTALL_AUTH=1 # legacy-env (K1)
expect_eq 'FICUS_INSTALL_AUTH=0 beats TAU_INSTALL_AUTH=1: exit 0' "${RC}" 0
expect_eq 'FICUS_INSTALL_AUTH=0 beats TAU_INSTALL_AUTH=1: no auth' "$(log_of "${C}")" ''

# 5. D5: the other TAU_INSTALL_* spellings are not read any more. The binary
#    lands in the default directory under HOME, never in TAU_INSTALL_DIR.
C="${T}/c5"
run_install "${C}" "TAU_INSTALL_DIR=${C}/x" "TAU_SHARE_DIR=${C}/xs" \
  "FICUS_DOWNLOAD_BASE_URL=${BASE}" FICUS_INSTALL_AUTH=0 # legacy-env (D5: ignored)
expect_eq 'TAU_INSTALL_DIR alone: exit 0' "${RC}" 0
expect_eq 'TAU_INSTALL_DIR alone: installed into the default dir' \
  "$([[ -x ${C}/home/.tau/bin/ficus ]] && echo yes || echo no)" yes
expect_eq 'TAU_INSTALL_DIR alone: nothing written there' "$([[ -e ${C}/x ]] && echo present || echo absent)" absent
expect_eq 'TAU_SHARE_DIR alone: skills in the default share dir' \
  "$([[ -f ${C}/home/.tau/share/skills/ficus-memory/SKILL.md ]] && echo yes || echo no)" yes
expect_eq 'TAU_SHARE_DIR alone: nothing written there' "$([[ -e ${C}/xs ]] && echo present || echo absent)" absent

# 6. D5: TAU_DOWNLOAD_BASE_URL alone is ignored — the installer goes to the
#    default https://ficus.sh/cli (refused by the curl stub, so it fails).
C="${T}/c6"
run_install "${C}" "FICUS_INSTALL_DIR=${C}/bin" "TAU_DOWNLOAD_BASE_URL=${BASE}" FICUS_INSTALL_AUTH=0 # legacy-env (D5)
expect_eq 'TAU_DOWNLOAD_BASE_URL alone: the download is attempted from ficus.sh' \
  "$(head -n 1 "${C}/curl.log")" "https://ficus.sh/cli/$(sed -n 's/.*Asset: *//p' <<<"${OUT}" | head -n 1)"
expect_not_contains 'TAU_DOWNLOAD_BASE_URL alone: never used' "$(cat "${C}/curl.log")" "${BASE}"
expect_eq 'TAU_DOWNLOAD_BASE_URL alone: nothing installed' "$([[ -e ${C}/bin/ficus ]] && echo present || echo absent)" absent

# 7. D5: TAU_AUTH_LABEL / TAU_API_URL / TAU_PASSWORD are not read either.
C="${T}/c7"
run_install "${C}" "FICUS_INSTALL_DIR=${C}/bin" "FICUS_SHARE_DIR=${C}/share" \
  "FICUS_DOWNLOAD_BASE_URL=${BASE}" FICUS_INSTALL_AUTH=1 \
  TAU_AUTH_LABEL=lab TAU_API_URL=http://core.test TAU_PASSWORD=pw # legacy-env (D5: ignored)
expect_eq 'TAU_AUTH_LABEL etc. alone: non-interactive auth fails' "$([[ ${RC} -ne 0 ]] && echo failed || echo ok)" failed
expect_contains 'TAU_AUTH_LABEL etc. alone: asks for the FICUS_ name' "${OUT}" 'FICUS_AUTH_LABEL is required'
expect_eq 'TAU_AUTH_LABEL etc. alone: ficus never ran auth' "$(log_of "${C}")" ''

# 8. A pre-existing file under the old name is left byte-identical (and so is
#    its mode); the new binary is installed beside it.
C="${T}/c8"
mkdir -p "${C}/bin"
printf '#!/bin/sh\necho old binary\n' >"${C}/bin/${OLD_BIN}"
chmod 751 "${C}/bin/${OLD_BIN}"
cp -p "${C}/bin/${OLD_BIN}" "${C}/old.copy"
old_mode=$(ls -l "${C}/bin/${OLD_BIN}" | awk '{print $1}')
run_install "${C}" "FICUS_INSTALL_DIR=${C}/bin" "FICUS_SHARE_DIR=${C}/share" \
  "FICUS_DOWNLOAD_BASE_URL=${BASE}" FICUS_INSTALL_AUTH=0
expect_eq 'old binary present: exit 0' "${RC}" 0
expect_eq 'old binary present: left byte-identical' "$(cmp -s "${C}/old.copy" "${C}/bin/${OLD_BIN}" && echo same || echo changed)" same
expect_eq 'old binary present: mode unchanged' "$(ls -l "${C}/bin/${OLD_BIN}" | awk '{print $1}')" "${old_mode}"
expect_eq 'old binary present: ficus installed beside it' "$([[ -x ${C}/bin/ficus ]] && echo yes || echo no)" yes

# 9. A re-install refreshes ficus in place.
printf '#!/bin/sh\necho stale\n' >"${C}/bin/ficus"
run_install "${C}" "FICUS_INSTALL_DIR=${C}/bin" "FICUS_SHARE_DIR=${C}/share" \
  "FICUS_DOWNLOAD_BASE_URL=${BASE}" FICUS_INSTALL_AUTH=0
expect_eq 're-install: ficus refreshed' "$("${C}/bin/ficus" --version)" \
  "${FIXTURE_VERSION} (${FIXTURE_COMMIT}, 2026-09-26T00:00:00Z)"
expect_eq 're-install: old binary still byte-identical' "$(cmp -s "${C}/old.copy" "${C}/bin/${OLD_BIN}" && echo same || echo changed)" same

# 10. Windows (uname stubbed): ficus-windows-x64.zip holding ficus.exe.
if command -v zip >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1; then
  C="${T}/c10"
  mkdir -p "${C}/stub"
  printf '#!/bin/sh\ncase "$1" in -s) echo MINGW64_NT-10.0 ;; -m) echo x86_64 ;; *) echo MINGW64_NT-10.0 ;; esac\n' >"${C}/stub/uname"
  chmod 755 "${C}/stub/uname"
  mkdir -p "${C}/home"
  RC=0
  OUT=$(env -i "HOME=${C}/home" "PATH=${C}/stub:${STUB}:${SYS_PATH}" "CURL_LOG=${C}/curl.log" \
    "FICUS_INSTALL_DIR=${C}/bin" "FICUS_SHARE_DIR=${C}/share" "FICUS_DOWNLOAD_BASE_URL=${BASE}" FICUS_INSTALL_AUTH=0 \
    sh "${INSTALLER}" </dev/null 2>&1) || RC=$?
  expect_eq 'windows: exit 0' "${RC}" 0
  expect_contains 'windows: downloads the zip' "$(cat "${C}/curl.log")" "${BASE}/ficus-windows-x64.zip"
  expect_eq 'windows: installs exactly ficus.exe' "$(ls "${C}/bin")" ficus.exe
else
  echo 'SKIP: windows case (zip/unzip not installed)' >&2
fi

printf '%d passed, %d failed\n' "${PASS}" "${FAIL}"
[[ ${FAIL} -eq 0 ]]
