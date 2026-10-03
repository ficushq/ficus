#!/usr/bin/env sh
# scripts/setup.sh — nothing → a running Ficus on this machine.
#   curl -fsSL https://ficus.sh/cli/setup.sh | bash
#   curl -fsSL https://ficus.sh/cli/setup.sh | bash -s -- --runtime host --yes
# Installs the ficus CLI (if missing), then hands off to `ficus server install`,
# which clones the source into ~/.ficus/ficus and runs the checkout's own setup.
set -eu

INSTALLER_URL="${FICUS_INSTALL_URL:-https://ficus.sh/cli/install.sh}"
# Match install.sh: FICUS_INSTALL_DIR, otherwise the canonical CLI home.
CLI_HOME="$HOME/.ficus"
FICUS_BIN="${FICUS_INSTALL_DIR:-$CLI_HOME/bin}/ficus"

err() { printf '\n✗ error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || err "required command not found: $1"; }

need curl
need git

if [ -x "$FICUS_BIN" ] && [ "${FICUS_SETUP_SKIP_CLI_INSTALL:-0}" = "1" ]; then
  printf '==> Using existing ficus CLI at %s\n' "$FICUS_BIN" >&2
else
  printf '==> Installing the ficus CLI\n' >&2
  FICUS_INSTALL_AUTH=0 sh -c "curl -fsSL \"$INSTALLER_URL\" | sh" || err "CLI install failed"
  [ -x "$FICUS_BIN" ] || err "CLI installer did not produce $FICUS_BIN"
fi

printf '==> ficus server install %s\n' "$*" >&2
# Under `curl | bash` stdin is the script itself; give the installer the terminal
# back when one is actually attachable (not just present as a device node —
# opening it fails with ENXIO when the process has no controlling terminal at
# all, e.g. under CI or a test harness).
if (exec 0< /dev/tty) 2>/dev/null; then
  exec "$FICUS_BIN" server install "$@" < /dev/tty
else
  exec "$FICUS_BIN" server install "$@"
fi
