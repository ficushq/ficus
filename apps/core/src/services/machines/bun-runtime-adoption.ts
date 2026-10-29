import { createHash, randomUUID } from 'node:crypto'
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

type RuntimeBox = Pick<MachineBox, 'sandboxId' | 'unixUser'> & Partial<Pick<MachineBox, 'reconcilableSpecHash'>>

function rowIdentity(machine: Machine, box: RuntimeBox, spec = box.reconcilableSpecHash): string {
  return createHash('sha256')
    .update(JSON.stringify([machine.id, box.sandboxId, spec ?? null]))
    .digest('hex')
}

/** Only run under the existing host flock; the journal is root-owned, not box-writable. */
function claimJournal(box: RuntimeBox): string {
  return `claim_path="$box_lock_dir/ficus-box-${box.unixUser}.bun-adoption"
load_claim() {
  [ -f "$claim_path" ] && [ ! -L "$claim_path" ] && [ -O "$claim_path" ] || return 1
  [ "$(stat -c %s -- "$claim_path")" = 167 ] || return 1
  mapfile -t claim_record < "$claim_path" || return 1
  [ "\${#claim_record[@]}" = 3 ] || return 1
  [[ "\${claim_record[0]}" =~ ^[a-f0-9]{64}$ ]] && [[ "\${claim_record[1]}" =~ ^[a-f0-9]{64}$ ]] &&
    [[ "\${claim_record[2]}" =~ ^[a-f0-9-]{36}$ ]]
}`
}

/**
 * The caller owns the NEW durable setup lease. A journal alone is not proof of
 * abandonment: never call this from a non-owning preflight. Restore ONLY the
 * listener, not the server or uncertain Bash. Two host-lock operations compare
 * the observed owner token so a delayed recovery cannot steal a newer claim.
 */
export async function recoverBoxBunRuntimeClaim(
  machine: Machine,
  box: RuntimeBox,
  runner: Pick<SshRunner, 'run'> = defaultSshRunner,
  assertOwned?: () => void
): Promise<boolean> {
  assertOwned?.()
  const identity = rowIdentity(machine, box)
  const ctl = boxUnitControl(box)
  const journal = claimJournal(box)
  const inspect = await runner
    .run(
      machine,
      withBoxHostLock(
        box.unixUser,
        `${journal}
if [ ! -e "$claim_path" ] && [ ! -L "$claim_path" ]; then echo FICUS_BUN_RECOVERY=none; exit 0; fi
load_claim || exit 74
[ "\${claim_record[0]}" = ${quote(identity)} ] || [ "\${claim_record[1]}" = ${quote(identity)} ] || exit 74
printf 'FICUS_BUN_RECOVERY=%s\\n' "\${claim_record[2]}"`
      ),
      { timeoutMs: 30_000 }
    )
    .catch(() => undefined)
  assertOwned?.()
  if (!inspect || inspect.exitCode !== 0) return false
  if (inspect.stdout.trim() === 'FICUS_BUN_RECOVERY=none') return true
  const token = inspect.stdout.trim().match(/^FICUS_BUN_RECOVERY=([a-f0-9-]{36})$/)?.[1]
  if (!token) return false
  const restored = await runner
    .run(
      machine,
      withBoxHostLock(
        box.unixUser,
        `${journal}
load_claim && [ "\${claim_record[2]}" = ${quote(token)} ] || exit 74
[ "\${claim_record[0]}" = ${quote(identity)} ] || [ "\${claim_record[1]}" = ${quote(identity)} ] || exit 74
${ctl.systemctl} start ${ctl.socket}
rm -- "$claim_path"`
      ),
      { timeoutMs: 30_000 }
    )
    .catch(() => undefined)
  assertOwned?.()
  return restored?.exitCode === 0
}

export class RuntimeClaimCleanupError extends Error {
  constructor(
    readonly operationError: unknown,
    readonly restorationError: unknown
  ) {
    super('Runtime adoption failed and activation restoration is unproven', { cause: operationError })
    this.name = 'RuntimeClaimCleanupError'
  }
}

/**
 * Claim normal socket-activated idle adoption under the existing host flock.
 * Stop ONLY the activation socket, then recheck service/proxy/jobs/registry: an
 * overtaking connection is busy, not permission to kill its command. Keep the
 * listener closed until provision + env publication + server start completes.
 * The caller also holds the durable setup lease and non-cancelling box command fence.
 */

export async function withIdleBunRuntimeClaim<T>(
  machine: Machine,
  box: RuntimeBox,
  desired: string,
  action: () => Promise<T>,
  runner: Pick<SshRunner, 'run'> = defaultSshRunner,
  desiredSpec?: string
): Promise<{ adopted: true; value: T } | { adopted: false }> {
  if (!(await recoverBoxBunRuntimeClaim(machine, box, runner))) return { adopted: false }
  const ctl = boxUnitControl(box)
  const owner = randomUUID()
  const journal = claimJournal(box)
  const restoreProgram = `${journal}
load_claim && [ "\${claim_record[2]}" = ${quote(owner)} ] || exit 74
${ctl.systemctl} start ${ctl.socket}
rm -- "$claim_path"`
  const restore = async () => {
    const result = await runner.run(machine, withBoxHostLock(box.unixUser, restoreProgram), { timeoutMs: 30_000 })
    if (result.exitCode !== 0) throw new Error('Could not restore owned box runtime activation listener')
  }
  const program = `${journal}
${idleBunProof(box, desired)}
ficus_bun_idle_proof active || exit 74
[ ! -e "$claim_path" ] && [ ! -L "$claim_path" ] || exit 74
claim_stage=$(mktemp "$claim_path.XXXXXX")
chmod 0600 "$claim_stage"
printf '%s\\n' ${quote(rowIdentity(machine, box))} ${quote(rowIdentity(machine, box, desiredSpec))} ${quote(owner)} > "$claim_stage"
mv -T -- "$claim_stage" "$claim_path"
if ! ${ctl.systemctl} stop ${ctl.socket}; then
  ${ctl.systemctl} start ${ctl.socket} || exit 1
  rm -- "$claim_path"
  exit 74
fi
if ! ficus_bun_idle_proof inactive; then
  ${ctl.systemctl} start ${ctl.socket} || exit 1
  rm -- "$claim_path"
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
  if (claimed.exitCode === 74 || claimed.exitCode === 73) return { adopted: false }
  if (claimed.exitCode !== 0 || claimed.stdout.trim() !== 'FICUS_BUN_ADOPTION=claimed') {
    await restore()
    throw new Error('Box runtime idle claim was not confirmed')
  }
  let value: T
  try {
    value = await action()
  } catch (operationError) {
    try {
      await restore()
    } catch (restorationError) {
      // Preserve a verified mismatch and its durable attempt bound even when
      // listener recovery also needs the next owning ensure.
      throw new RuntimeClaimCleanupError(operationError, restorationError)
    }
    throw operationError
  }
  await restore()
  return { adopted: true, value }
}
