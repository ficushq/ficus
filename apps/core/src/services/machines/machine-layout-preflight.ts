import type { Machine } from './queries'
import type { SshRunner } from './ssh'

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
root=$1
needs_operator() { printf '%s\n' 'FICUS_MACHINE_LAYOUT=operator-required'; exit 0; }
for journal in "$root/var/backups/ficus-host-migrate"/machine-*; do
  [ -f "$journal/STEPS" ] || continue
  if [ ! -e "$journal/DONE" ] && [ ! -e "$journal/REVERSED" ]; then needs_operator; fi
done
if [ -e "$root/opt/ficus" ] || [ -L "$root/opt/ficus" ]; then
  [ -d "$root/opt/ficus" ] && [ ! -L "$root/opt/ficus" ] || needs_operator
fi
for home in "$root"/home/box_*; do
  [ -e "$home" ] || [ -L "$home" ] || continue
  [ -d "$home" ] && [ ! -L "$home" ] || needs_operator
  [ -d "$home/.ficus" ] && [ ! -L "$home/.ficus" ] || needs_operator
  name=$(basename "$home")
  system="$root/etc/systemd/system/ficus-box-$name.service"
  user="$home/.config/systemd/user/ficus-sandbox-server.service"
  if [ -f "$system" ] && [ ! -L "$system" ]; then continue; fi
  if [ -f "$user" ] && [ ! -L "$user" ]; then continue; fi
  needs_operator
done
printf '%s\n' 'FICUS_MACHINE_LAYOUT=ready'`

export function machineLayoutPreflightCommand(root = ''): string {
  return `sudo -n bash -c ${quote(MACHINE_LAYOUT_PREFLIGHT_PROGRAM)} machine-layout-preflight ${quote(root)}`
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
