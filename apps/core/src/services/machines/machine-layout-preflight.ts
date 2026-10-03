import type { Machine } from './queries'
import type { SshRunner } from './ssh'
import { LEGACY_BOX_UNIT_PREFIX, LEGACY_USER_UNIT_PREFIX, LEGACY_BOX_DOT_DIR } from './box-paths'

// Bridge (phase 5, U4): automatic worker boot must not migrate an existing host
// while the candidate Core release can still automatically roll back.
export const LEGACY_MACHINE_ROOT = '/opt/tau' // ficus-p5-bridge
export const LEGACY_BROWSER_NAME = 'tau-browser' // ficus-p5-bridge

const READY = 'FICUS_MACHINE_LAYOUT=ready'
const OPERATOR_REQUIRED = 'FICUS_MACHINE_LAYOUT=operator-required'

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Read-only counterpart of bootstrap.sh's migration-needed/pending checks.
 * Run every check under sudo, including journal enumeration, so inaccessible
 * paths cannot be mistaken for an already migrated host. root is a fixture seam.
 */
export const MACHINE_LAYOUT_PREFLIGHT_PROGRAM = String.raw`set -eu
old_root="$4$1" old_browser=$2 new_browser=$3 root=$4 system_prefix=$5 user_prefix=$6 old_dot=$7
new_root="$root/opt/ficus"
needs_operator() { printf '%s\n' 'FICUS_MACHINE_LAYOUT=operator-required'; exit 0; }
account_exists() {
  if getent "$1" "$2" >/dev/null; then return 0; else
    rc=$?
    [ "$rc" = 2 ] && return 1
    exit "$rc"
  fi
}
if [ -d "$old_root" ] && [ ! -L "$old_root" ]; then needs_operator; fi
for journal in "$root/var/backups/ficus-host-migrate"/machine-*; do
  [ -f "$journal/STEPS" ] || continue
  if [ ! -e "$journal/DONE" ] && [ ! -e "$journal/REVERSED" ]; then needs_operator; fi
done
unit="$root/etc/systemd/system/$old_browser.service"
if [ -f "$unit" ] && [ ! -L "$unit" ]; then needs_operator; fi
if [ -f "$root/etc/apparmor.d/$old_browser-chromium" ]; then needs_operator; fi
if [ -f "$new_root/browser/service/$old_browser.js" ]; then needs_operator; fi
if account_exists passwd "$old_browser" && ! account_exists passwd "$new_browser"; then needs_operator; fi
if account_exists group "$old_browser" && ! account_exists group "$new_browser"; then needs_operator; fi
# Finalize cannot remove binary/socket bridges still needed by an old box.
for unit in "$root/etc/systemd/system/$system_prefix"-box_*; do
  if [ -f "$unit" ] && [ ! -L "$unit" ]; then needs_operator; fi
done
for home in "$root"/home/box_*; do
  [ -d "$home" ] || continue
  [ ! -L "$home" ] || needs_operator
  if [ -e "$home/$old_dot" ] && [ ! -L "$home/$old_dot" ]; then needs_operator; fi
  for unit in "$home/.config/systemd/user/$user_prefix.service" "$home/.config/systemd/user/$user_prefix.socket" "$home/.config/systemd/user/$user_prefix-proxy.service"; do
    if [ -f "$unit" ] && [ ! -L "$unit" ]; then needs_operator; fi
  done
done
printf '%s\n' 'FICUS_MACHINE_LAYOUT=ready'`

export function machineLayoutPreflightCommand(root = ''): string {
  return `sudo -n bash -c ${quote(MACHINE_LAYOUT_PREFLIGHT_PROGRAM)} machine-layout-preflight ${quote(LEGACY_MACHINE_ROOT)} ${quote(LEGACY_BROWSER_NAME)} ficus-browser ${quote(root)} ${quote(LEGACY_BOX_UNIT_PREFIX)} ${quote(LEGACY_USER_UNIT_PREFIX)} ${quote(LEGACY_BOX_DOT_DIR)}`
}

/** Throw on an indeterminate probe. The automatic caller must defer without
 * claiming or updating the machine; only an explicit bootstrap may migrate it.
 */
export async function requiresMachineLayoutMigration(machine: Machine, runner?: SshRunner): Promise<boolean> {
  const ssh = runner ?? (await import('./ssh')).defaultSshRunner
  const result = await ssh.run(machine, machineLayoutPreflightCommand(), { timeoutMs: 30_000 })
  if (result.exitCode !== 0) throw new Error(`machine layout preflight failed (exit ${result.exitCode})`)
  const output = result.stdout.trim()
  if (output === OPERATOR_REQUIRED) return true
  if (output === READY) return false
  throw new Error('machine layout preflight returned an unknown result')
}
