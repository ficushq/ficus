#!/usr/bin/env bash
# Real Git-object cache regression, Linux (flock + GNU timeout required).
# Variables set here are read by the eval'ed box-provision.sh functions.
# shellcheck disable=SC2034
set -euo pipefail
TARGET="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/box-provision.sh"
eval "$(awk '/^NIX_CACHE_ROOT=/ {copy=1} /^ensure_dirs\(\)/ {exit} copy' "${TARGET}")"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
NIX_CACHE_ROOT="${TMP}/shared"
source_home="${TMP}/prewarm"
source_cache="${source_home}/.cache/nix/tarball-cache"
target_cache="${TMP}/box/.cache/nix/tarball-cache"
other="${TMP}/other"
shared="${NIX_CACHE_ROOT}/tarball-cache"
for cache in "${source_cache}" "${target_cache}" "${other}"; do git init --bare --quiet "${cache}"; done
public="$(printf 'public default toolchain' | git --git-dir="${source_cache}" hash-object -w --stdin)"
printf 'public default toolchain' | git --git-dir="${target_cache}" hash-object -w --stdin >/dev/null
private="$(printf 'private custom dependency' | git --git-dir="${target_cache}" hash-object -w --stdin)"
other_oid="$(printf 'existing alternate' | git --git-dir="${other}" hash-object -w --stdin)"
printf '%s\n' "${other}/objects" >"${target_cache}/objects/info/alternates"
printf 'private fetcher metadata' >"${TMP}/box/.cache/nix/fetcher-cache.sqlite"

# The fixture's cache paths are isolated; only privilege dropping is stubbed.
SUDO=()
user_home() { printf '%s' "${source_home}"; }
run_as_box() { "$@"; }
SANDBOX_ID=devbox-prewarm-agent-test-machine
UNIX_USER="box_$(printf '%s' "${SANDBOX_ID}" | sha256sum | cut -c1-12)"
# CI's ordinary user can exercise the publisher in its own temporary tree.
# Real root-only admission is covered separately by the CLI guard test.
init_shared_nix_cache() {
  local name
  for name in tarball-cache tarball-cache-v2; do git init --bare --quiet "${NIX_CACHE_ROOT}/${name}"; done
}
id() { if [ "${1:-}" = -u ]; then printf '0\n'; else command id "$@"; fi; }
publish_nix_cache
attach_nix_cache "${target_cache}" "${shared}"
[ ! -f "${target_cache}/objects/${public:0:2}/${public:2}" ]
[ "$(git --git-dir="${target_cache}" cat-file -p "${public}")" = 'public default toolchain' ]
[ "$(git --git-dir="${target_cache}" cat-file -p "${private}")" = 'private custom dependency' ]
[ "$(git --git-dir="${target_cache}" cat-file -p "${other_oid}")" = 'existing alternate' ]
! git --git-dir="${shared}" cat-file -e "${private}" 2>/dev/null
[ "$(cat "${TMP}/box/.cache/nix/fetcher-cache.sqlite")" = 'private fetcher metadata' ]
echo 'PASS existing cache deduplication preserves private objects, metadata and alternates'

fresh="${TMP}/new-box/cache"
attach_nix_cache "${fresh}" "${shared}"
# Writing an already-shared object must not allocate a local loose copy.
printf 'public default toolchain' | git --git-dir="${fresh}" hash-object -w --stdin >/dev/null
[ ! -f "${fresh}/objects/${public:0:2}/${public:2}" ]
[ "$(git --git-dir="${fresh}" cat-file -p "${public}")" = 'public default toolchain' ]
echo 'PASS fresh boxes reuse shared objects without copying'

before="$(find "${shared}/objects/pack" -type f | sort)"
publish_nix_cache
[ "$(find "${shared}/objects/pack" -type f | sort)" = "${before}" ]
attach_nix_cache "${target_cache}" "${shared}"
[ "$(grep -Fxc "${shared}/objects" "${target_cache}/objects/info/alternates")" = 1 ]
echo 'PASS publication and attachment are idempotent'

second="$(printf 'new public object' | git --git-dir="${source_cache}" hash-object -w --stdin)"
publish_nix_cache
attach_nix_cache "${fresh}" "${shared}"
[ "$(git --git-dir="${fresh}" cat-file -p "${public}")" = 'public default toolchain' ]
[ "$(git --git-dir="${fresh}" cat-file -p "${second}")" = 'new public object' ]
echo 'PASS later publication preserves old objects and reaches existing boxes'

# Nix uses its own object writer and can recreate loose objects even with
# an alternate. Simulate that write, then verify cleanup runs again even
# though the shared store has not changed.
mkdir -p "${target_cache}/objects/${public:0:2}"
cp "${source_cache}/objects/${public:0:2}/${public:2}" "${target_cache}/objects/${public:0:2}/${public:2}"
timeout() { return 124; }
attach_nix_cache "${target_cache}" "${shared}"
[ -f "${target_cache}/objects/${public:0:2}/${public:2}" ]
[ "$(git --git-dir="${target_cache}" cat-file -p "${public}")" = 'public default toolchain' ]
unset -f timeout
attach_nix_cache "${target_cache}" "${shared}"
[ ! -f "${target_cache}/objects/${public:0:2}/${public:2}" ]
echo 'PASS recreated loose objects are cleaned and bounded cleanup safely retries'

SANDBOX_ID=agent-ordinary
if publish_nix_cache 2>/dev/null; then echo 'FAIL ordinary box published' >&2; exit 1; fi
echo 'PASS ordinary agent publication refused'

# Service start drops the box's private download objects (loose and packed),
# keeps fetcher metadata, and re-attaches the shared objects.
box_home="${TMP}/reset-box"
box_cache="${box_home}/.cache/nix/tarball-cache"
git init --bare --quiet "${box_cache}"
loose="$(printf 'private nixpkgs tip' | git --git-dir="${box_cache}" hash-object -w --stdin)"
packed="$(printf 'private packed source' | git --git-dir="${box_cache}" hash-object -w --stdin)"
printf '%s\n' "${packed}" | git --git-dir="${box_cache}" pack-objects --quiet "${box_cache}/objects/pack/pack" >/dev/null
rm -f "${box_cache}/objects/${packed:0:2}/${packed:2}"
printf 'public default toolchain' | git --git-dir="${box_cache}" hash-object -w --stdin >/dev/null
printf 'fetcher metadata' >"${box_home}/.cache/nix/fetcher-cache-v2.sqlite"
user_home() { printf '%s' "${box_home}"; }
UNIX_USER="$(id -un)"
KEEP_PRIVATE_NIX_OBJECTS=true
prepare_nix_cache
[ "$(git --git-dir="${box_cache}" cat-file -p "${loose}")" = 'private nixpkgs tip' ]
[ "$(git --git-dir="${box_cache}" cat-file -p "${packed}")" = 'private packed source' ]
[ ! -f "${box_cache}/objects/${public:0:2}/${public:2}" ]
echo 'PASS in-session maintenance keeps private objects and only prunes shared duplicates'

KEEP_PRIVATE_NIX_OBJECTS=false
prepare_nix_cache
# set -e ignores a negated command, so absence is asserted explicitly.
for oid in "${loose}" "${packed}"; do
  if git --git-dir="${box_cache}" cat-file -e "${oid}" 2>/dev/null; then echo "FAIL ${oid} survived reset" >&2; exit 1; fi
done
[ -z "$(find "${box_cache}/objects" -mindepth 2 -maxdepth 2 -type f \( -path '*/objects/[0-9a-f][0-9a-f]/*' -o -name '*.pack' \))" ]
[ "$(git --git-dir="${box_cache}" cat-file -p "${public}")" = 'public default toolchain' ]
[ "$(cat "${box_home}/.cache/nix/fetcher-cache-v2.sqlite")" = 'fetcher metadata' ]
[ -z "$(find "${box_home}/.cache/nix" -maxdepth 1 -name '.tarball-cache*.reset.*')" ]
echo 'PASS service start drops private loose and packed objects and keeps shared access'

# A cache holding only alternates is left in place (no churn on every start).
before="$(stat -c %i "${box_cache}")"
reset_private_nix_objects "${box_cache}"
[ "$(stat -c %i "${box_cache}")" = "${before}" ]
echo 'PASS a cache without private objects is not reset'

# The swap is atomic; a removal that times out is finished on the next start.
printf 'interrupted' | git --git-dir="${box_cache}" hash-object -w --stdin >/dev/null
timeout() { return 124; }
reset_private_nix_objects "${box_cache}"
[ ! -e "${box_cache}" ]
[ -n "$(find "${box_home}/.cache/nix" -maxdepth 1 -name '.tarball-cache.reset.*')" ]
unset -f timeout
reset_private_nix_objects "${box_cache}"
[ -z "$(find "${box_home}/.cache/nix" -maxdepth 1 -name '.tarball-cache.reset.*')" ]
echo 'PASS an interrupted reset leaves no partial repository and finishes on the next start'

# A symlinked cache is never followed into another directory.
victim="${TMP}/victim"
git init --bare --quiet "${victim}"
kept="$(printf 'not this box' | git --git-dir="${victim}" hash-object -w --stdin)"
mkdir -p "${TMP}/link-box"
ln -s "${victim}" "${TMP}/link-box/tarball-cache"
reset_private_nix_objects "${TMP}/link-box/tarball-cache"
[ -L "${TMP}/link-box/tarball-cache" ]
[ "$(git --git-dir="${victim}" cat-file -p "${kept}")" = 'not this box' ]
echo 'PASS a symlinked cache is left alone'
echo '11 cache integration checks passed'
