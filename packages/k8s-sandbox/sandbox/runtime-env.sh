#!/usr/bin/env bash
# Shared runtime environment for sandbox user commands.
# Source this after Nix/devbox activation.

# Always use a container-local temp dir. Host TMPDIR values such as
# /var/folders/... break browser installers and Python temp files in pods.
export TMPDIR=/tmp
mkdir -p /tmp 2>/dev/null || true

# Keep Playwright browser downloads inside the workspace PVC/cacheable area.
# Do not force a browser binary path; let Playwright manage revisions.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/workspace/.cache/ms-playwright}"
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null || true

# Playwright's Linux dependency validator runs from the Nix/devbox Node driver and
# can falsely report Ubuntu host libraries as missing because Nix's loader does
# not use the system loader cache. The image installs those Chromium libraries,
# so skip the validator and let Chromium's own launch determine runtime success.
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS="${PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS:-1}"

_tau_join_by_colon() {
  LC_ALL=C sort -u | paste -sd: -
}

_tau_nix_cxx_lib_dirs() {
  # Nix Python native wheels (for example greenlet) need Nix-provided C/C++
  # runtimes. Discover by files instead of hard-coding /nix/store hashes or CPU arch.
  find /nix/store -type f \( \
    -name 'libstdc++.so.6*' -o \
    -name 'libgcc_s.so.1*' \
  \) -printf '%h\n' 2>/dev/null | _tau_join_by_colon
}

_tau_nix_glibc_dirs() {
  # Discover glibc/ELF loader directories for diagnostics and future tooling, but
  # do not add them to LD_LIBRARY_PATH. Prepending multiple glibc versions can
  # break Nix-provided command-line tools that require a newer glibc than the
  # first directory found.
  find /nix/store -type f \( \
    -name 'ld-linux-x86-64.so.2' -o \
    -name 'ld-linux-aarch64.so.1' -o \
    -name 'libc.so.6' \
  \) -printf '%h\n' 2>/dev/null | _tau_join_by_colon
}

if [ -z "${FICUS_NIX_GLIBC_LIBRARY_PATH:-}" ]; then
  FICUS_NIX_GLIBC_LIBRARY_PATH="$(_tau_nix_glibc_dirs || true)"
  export FICUS_NIX_GLIBC_LIBRARY_PATH
fi

if [ -z "${FICUS_NIX_LD_LIBRARY_PATH:-}" ]; then
  FICUS_NIX_LD_LIBRARY_PATH="$(_tau_nix_cxx_lib_dirs || true)"
  export FICUS_NIX_LD_LIBRARY_PATH
fi

if [ -n "${FICUS_NIX_LD_LIBRARY_PATH:-}" ]; then
  case ":${LD_LIBRARY_PATH:-}:" in
    *":$FICUS_NIX_LD_LIBRARY_PATH:"*) ;;
    *) export LD_LIBRARY_PATH="$FICUS_NIX_LD_LIBRARY_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
  esac
fi
