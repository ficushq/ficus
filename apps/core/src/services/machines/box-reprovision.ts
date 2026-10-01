import { createHash } from 'node:crypto'
import type { Machine, MachineBox } from './queries'
import { boxUnixUser, boxUnitMode } from './box-paths'
import type { BoxEnv, InstallBoxOpts } from './box-manager'

export type RuntimeState = {
  server: boolean
  socket: boolean
  proxy: boolean
  docker: boolean
  manager: boolean
  linger: boolean
  serverEnabled: boolean
  socketEnabled: boolean
  dockerEnabled: boolean
}
export type ReprovisionJournal = {
  version: 1
  identity: string
  runtime: RuntimeState
  done: boolean
}
export interface ReprovisionDeps {
  assertMaintenance(): Promise<void>
  listBoxes(): Promise<MachineBox[]>
  getMachine(id: string): Promise<Machine | null>
  requiresMigration(machine: Machine): Promise<boolean>
  readEnv(machine: Machine, box: MachineBox): Promise<string>
  captureRuntime(machine: Machine, box: MachineBox): Promise<RuntimeState>
  restoreRuntime(machine: Machine, box: MachineBox, state: RuntimeState): Promise<void>
  ensureArtifacts(machine: Machine): Promise<void>
  install(opts: InstallBoxOpts): Promise<void>
  verifyInstalled(machine: Machine, box: MachineBox): Promise<void>
  checkRunning(machine: Machine, box: MachineBox): Promise<void>
  invalidateStamp(box: MachineBox): Promise<void>
  journal: {
    read(id: string): Promise<ReprovisionJournal | null>
    write(id: string, value: ReprovisionJournal): Promise<void>
  }
  print(line: string): void
}

/** Only fixed reason tokens cross the operator/log boundary. */
export class ReprovisionError extends Error {}
function refuse(reason: string): never {
  throw new ReprovisionError(reason)
}
export function reprovisionRole(id: string): InstallBoxOpts['role'] {
  // Consultants use the VM agent role, but retain their user-mode units.
  if (/^(agent|consultants)_[A-Za-z0-9._:-]+$/.test(id)) return 'agent'
  if (/^squad_[A-Za-z0-9._:-]+$/.test(id)) return 'squad'
  if (/^system_manager_[A-Za-z0-9._:-]+$/.test(id)) return 'system-manager'
  return refuse('unknown-box-role')
}
export function boxIdentity(box: MachineBox): string {
  return JSON.stringify([
    box.sandboxId,
    box.machineId,
    box.unixUser,
    box.port,
    box.status,
    box.migrating,
    box.reconcilableSpecHash,
    createHash('sha256')
      .update(box.authToken ?? '')
      .digest('hex'),
  ])
}
function inventory(rows: MachineBox[]): string {
  return JSON.stringify(rows.map(boxIdentity).sort())
}
export function validateBox(box: MachineBox): void {
  reprovisionRole(box.sandboxId)
  if (box.unixUser !== boxUnixUser(box.sandboxId) || !Number.isInteger(box.port) || box.port < 1024 || box.port > 65535)
    refuse('invalid-box-identity')
  if (!['ready', 'stopped'].includes(box.status) || box.migrating) refuse('box-not-settled')
  if (!box.authToken || /[\r\n\0]/.test(box.authToken)) refuse('missing-or-invalid-auth-token')
}
/** Core writes unquoted one-line KEY=value files. Never evaluate shell syntax. */
export function parseReprovisionEnv(content: string, box: MachineBox): BoxEnv {
  const env: BoxEnv = Object.create(null)
  if (content.includes('\0') || content.includes('\r')) refuse('invalid-server-env')
  for (const line of content.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match || Object.hasOwn(env, match[1]!)) refuse('ambiguous-server-env')
    env[match[1]!] = match[2]!
  }
  if (
    env.EXECUTOR_AUTH_TOKEN !== box.authToken ||
    env.EXECUTOR_PORT !== String(box.port) ||
    env.EXECUTOR_BIND !== '127.0.0.1'
  )
    refuse('server-env-identity-mismatch')
  // The install seam replaces every derived value. An agent must not inherit a
  // historical Docker endpoint because its derived env intentionally omits it.
  const expectedRole = reprovisionRole(box.sandboxId) === 'agent' ? 'agent' : 'squad'
  if (env.FICUS_SANDBOX_ROLE && env.FICUS_SANDBOX_ROLE !== expectedRole) refuse('server-env-role-mismatch')
  env.FICUS_SANDBOX_ROLE = expectedRole
  delete env.DOCKER_HOST
  return env
}
export function validateRuntime(state: RuntimeState): void {
  const keys = [
    'server',
    'socket',
    'proxy',
    'docker',
    'manager',
    'linger',
    'serverEnabled',
    'socketEnabled',
    'dockerEnabled',
  ] as const
  if (keys.some((k) => typeof state[k] !== 'boolean') || Object.keys(state).length !== keys.length)
    refuse('invalid-runtime-state')
  if (state.proxy && !state.socket) refuse('ambiguous-runtime-state')
  if (state.docker && !state.manager) refuse('ambiguous-runtime-state')
}

/** Maintenance-only: no placement, removal, high-level ensure or canonical hash stamping. */
export async function runBoxReprovision(target: string, deps: ReprovisionDeps): Promise<number> {
  let phase = 'preflight'
  let current = 'inventory'
  try {
    await deps.assertMaintenance()
    const rows = await deps.listBoxes()
    const baseline = inventory(rows)
    const selected = target === 'all' ? rows : rows.filter((b) => b.sandboxId === target)
    if (target !== 'all' && selected.length !== 1) refuse('box-not-found')
    const machines = new Map<string, Machine>()
    const prepared: Array<{ box: MachineBox; machine: Machine; env: BoxEnv; journal: ReprovisionJournal }> = []
    // Finish ALL read-only validation before the first journal/artifact/box write.
    for (const box of selected) {
      current = box.sandboxId
      validateBox(box)
      let machine = machines.get(box.machineId)
      if (!machine) {
        const found = await deps.getMachine(box.machineId)
        if (!found || found.status !== 'ready') refuse('machine-not-ready')
        if (await deps.requiresMigration(found)) refuse('machine-layout-not-ready')
        machine = found
        machines.set(machine.id, machine)
      }
      const env = parseReprovisionEnv(await deps.readEnv(machine, box), box)
      const saved = await deps.journal.read(box.sandboxId)
      if (saved && (saved.version !== 1 || typeof saved.done !== 'boolean')) refuse('invalid-journal')
      if (saved && !saved.done && saved.identity !== boxIdentity(box)) refuse('pending-journal-identity-mismatch')
      const runtime = saved && !saved.done ? saved.runtime : await deps.captureRuntime(machine, box)
      validateRuntime(runtime)
      if (
        boxUnitMode(box.sandboxId) === 'user' &&
        (runtime.server || runtime.socket || runtime.proxy) &&
        !runtime.manager
      )
        refuse('user-runtime-without-manager')
      if (box.status === 'stopped' && (runtime.server || runtime.socket || runtime.proxy))
        refuse('stopped-box-runtime-conflict')
      prepared.push({ box, machine, env, journal: { version: 1, identity: boxIdentity(box), runtime, done: false } })
    }
    await deps.assertMaintenance()
    if (inventory(await deps.listBoxes()) !== baseline) refuse('inventory-changed')
    const delivered = new Set<string>()
    for (const item of prepared) {
      const { box, machine, env, journal } = item
      current = box.sandboxId
      phase = 'pre-mutation'
      await deps.assertMaintenance()
      if (inventory(await deps.listBoxes()) !== baseline) refuse('inventory-changed')
      // Keep original runtime intent across process death. No env/token is persisted.
      await deps.journal.write(box.sandboxId, journal)
      let failed = false
      try {
        phase = 'install'
        if (!delivered.has(machine.id)) {
          await deps.ensureArtifacts(machine)
          delivered.add(machine.id)
        }
        await deps.install({
          machine,
          sandboxId: box.sandboxId,
          unixUser: box.unixUser,
          port: box.port,
          role: reprovisionRole(box.sandboxId),
          env,
          authToken: box.authToken!,
        })
        phase = 'verify-installed'
        await deps.verifyInstalled(machine, box)
      } catch {
        failed = true
      }
      phase = 'restore-runtime'
      await deps.restoreRuntime(machine, box, journal.runtime)
      if (failed) refuse('install-failed-runtime-restored')
      // Only boxes which were actually running are probed; health would wake idle boxes.
      if (journal.runtime.server) {
        phase = 'verify-running'
        await deps.checkRunning(machine, box)
      }
      phase = 'invalidate-stamp'
      await deps.invalidateStamp(box)
      phase = 'commit-journal'
      await deps.journal.write(box.sandboxId, { ...journal, done: true })
      deps.print(`BOX_REPROVISION ${box.sandboxId} ok state=${box.status}`)
    }
    if (!prepared.length) deps.print('BOX_REPROVISION inventory ok empty')
    return 0
  } catch (error) {
    // SSH stderr and env-validation inputs can contain secrets. Never interpolate them.
    const reason = error instanceof ReprovisionError ? error.message : `${phase}-failed`
    deps.print(`BOX_REPROVISION ${current} failed ${reason}`)
    return 1
  }
}
