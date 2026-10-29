import { withBoxHostLock } from './box-host-lock'
import { boxHomeForUser, boxUnitControl } from './box-paths'
import { defaultSshRunner, type SshRunner } from './ssh'
import type { Machine, MachineBox } from './queries'

/** The bootstrap bytes are also the release's immutable host-runtime contract. */
export function bunVersionFromBootstrap(script: string): string {
  const pins = [...script.matchAll(/^BUN_VERSION="(\d+\.\d+\.\d+)"$/gm)]
  if (pins.length !== 1) throw new Error('Effective bootstrap must contain exactly one Bun pin')
  return pins[0]![1]!
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * Read-only host probe. Never HTTP-probe an old executor here: a 60-second
 * reconciliation poll would otherwise keep resetting its idle-exit window.
 * A running or uninspectable legacy process is NOT permission to restart it.
 */
function idleBunProof(box: Pick<MachineBox, 'sandboxId' | 'unixUser'>, desired: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(desired)) throw new Error('Invalid desired Bun pin')
  const ctl = boxUnitControl(box)
  const home = boxHomeForUser(box.unixUser)
  const registry = `${home}/.ficus/runtime/bash-invocations`
  return `
ficus_bun_idle_proof() {
uid=$(id -u ${quote(box.unixUser)}) || return 1
[ "$(${ctl.isActiveCommand()} 2>/dev/null || true)" = inactive ] || return 1
[ "$(${ctl.isActiveCommandOf(ctl.proxy)} 2>/dev/null || true)" = inactive ] || return 1
[ "$(${ctl.socketIsActiveCommand()} 2>/dev/null || true)" = "$1" ] || return 1
[ -d ${quote(home)} ] && [ -r ${quote(home)} ] && [ -x ${quote(home)} ] || return 1
registry=${quote(registry)}
[ ! -L "$registry" ] || return 1
if [ -e "$registry" ]; then
  [ -d "$registry" ] && [ -r "$registry" ] && [ -x "$registry" ] || return 1
  for directory in "$registry" "$registry/active" "$registry/quarantine"; do
    [ ! -L "$directory" ] || return 1
    if [ -e "$directory" ]; then
      [ -d "$directory" ] && [ -r "$directory" ] && [ -x "$directory" ] || return 1
      if [ "$directory" = "$registry" ]; then
        record=$(find "$directory" -maxdepth 1 -name '*.json' -print -quit) || return 1
      else
        # Quarantined legacy entries need not have a .json extension.
        record=$(find "$directory" -mindepth 1 -maxdepth 1 -print -quit) || return 1
      fi
      [ -z "$record" ] || return 1
    fi
  done
fi
[ "$(/opt/ficus/bin/bun --version 2>/dev/null)" = ${quote(desired)} ] || return 1
# Recheck the manager after filesystem reads; activating/unknown is never idle.
[ "$(${ctl.isActiveCommand()} 2>/dev/null || true)" = inactive ] || return 1
[ "$(${ctl.isActiveCommandOf(ctl.proxy)} 2>/dev/null || true)" = inactive ] || return 1
for unit in ${ctl.unit} ${ctl.proxy}; do
  job=$(${ctl.systemctl} show -p Job --value "$unit" 2>/dev/null) || return 1
  case "$job" in ''|0) ;; *) return 1 ;; esac
done
return 0
}
`.trim()
}

export function buildBunAdoptionProbe(box: Pick<MachineBox, 'sandboxId' | 'unixUser'>, desired: string): string {
  const program = `set -eu
${idleBunProof(box, desired)}
if ficus_bun_idle_proof active; then echo FICUS_BUN_ADOPTION=idle; else echo FICUS_BUN_ADOPTION=blocked; fi`
  return `sudo bash -c ${quote(program)}`
}

export async function probeBoxBunAdoption(
  machine: Machine,
  box: Pick<MachineBox, 'sandboxId' | 'unixUser'>,
  desired: string,
  runner: Pick<SshRunner, 'run'> = defaultSshRunner
): Promise<boolean> {
  try {
    const result = await runner.run(machine, buildBunAdoptionProbe(box, desired), { timeoutMs: 10_000 })
    return result.exitCode === 0 && result.stdout.trim() === 'FICUS_BUN_ADOPTION=idle'
  } catch {
    return false
  }
}

/**
 * Claim normal socket-activated idle adoption under the existing host flock.
 * Stop ONLY the activation socket, then recheck service/proxy/jobs/registry: an
 * overtaking connection is busy, not permission to kill its command. Keep the
 * listener closed until provision + env publication + server start completes.
 * The caller also holds the durable setup lease and box-scoped command drain.
 */
export async function withIdleBunRuntimeClaim<T>(
  machine: Machine,
  box: Pick<MachineBox, 'sandboxId' | 'unixUser'>,
  desired: string,
  action: () => Promise<T>,
  runner: Pick<SshRunner, 'run'> = defaultSshRunner
): Promise<{ adopted: true; value: T } | { adopted: false }> {
  const ctl = boxUnitControl(box)
  const restore = async () => {
    const result = await runner.run(machine, withBoxHostLock(box.unixUser, `${ctl.systemctl} start ${ctl.socket}`), {
      timeoutMs: 30_000,
    })
    if (result.exitCode !== 0) throw new Error('Could not restore box runtime activation listener')
  }
  const program = `${idleBunProof(box, desired)}
ficus_bun_idle_proof active || exit 74
if ! ${ctl.systemctl} stop ${ctl.socket}; then
  ${ctl.systemctl} start ${ctl.socket} || exit 1
  exit 74
fi
if ! ficus_bun_idle_proof inactive; then
  ${ctl.systemctl} start ${ctl.socket} || exit 1
  exit 74
fi
echo FICUS_BUN_ADOPTION=claimed`
  let claimed: Awaited<ReturnType<SshRunner['run']>>
  try {
    claimed = await runner.run(machine, withBoxHostLock(box.unixUser, program), { timeoutMs: 30_000 })
  } catch (error) {
    // An SSH loss can follow socket closure. Restoration waits for the same
    // host lock; it never stops an executor or replays an uncertain Bash call.
    await restore().catch((restoreError) => {
      throw new Error('Runtime claim and activation restoration are unproven', { cause: restoreError })
    })
    throw error
  }
  if (claimed.exitCode === 74) return { adopted: false }
  if (claimed.exitCode !== 0 || claimed.stdout.trim() !== 'FICUS_BUN_ADOPTION=claimed') {
    await restore()
    throw new Error('Box runtime idle claim was not confirmed')
  }
  try {
    return { adopted: true, value: await action() }
  } finally {
    await restore()
  }
}
