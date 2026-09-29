import net from 'node:net'
import type { LocalDeployment } from '@ficus/shared'
import { createLogger } from '../../lib/infra/logger'
import {
  getLocalDeployment,
  listRestartableManagedLocalDeploymentsForSandbox,
  listSandboxIdsWithLiveManagedLocalDeployments,
  markLocalDeploymentsStoppedForSandbox,
  updateLocalDeploymentRecord,
} from './local-deployment-service'
import { ensureSquadSandbox } from '../sandbox/ensure'
import { isBoxMigrating } from '../machines/queries'
import { LocalDeploymentProcessSupervisor } from './local-deployment-process-supervisor'
import { resolveLocalDeploymentTarget } from './local-deployment-target'

const log = createLogger('local-deployment-health')

interface LocalDeploymentHealthDependencies {
  canConnect: (host: string, port: number, timeoutMs?: number) => Promise<boolean>
  ensureSquadSandbox: typeof ensureSquadSandbox
  supervisor: Pick<LocalDeploymentProcessSupervisor, 'hasSession' | 'startManagedLocalDeployment'>
  resolveLocalDeploymentTarget: typeof resolveLocalDeploymentTarget
  /** Reads the box's migration fence (`machine_boxes.migrating`) — the SAME
   *  fence box-migrate.ts's fenceBoxForMigration sets. Consulted by
   *  {@link restartManagedLocalDeployment}'s default `skipIfMigrating` guard;
   *  overridable in tests. */
  isBoxMigrating: typeof isBoxMigrating
}

let dependencyOverrides: Partial<LocalDeploymentHealthDependencies> = {}

function getDependencies(): LocalDeploymentHealthDependencies {
  return {
    canConnect: dependencyOverrides.canConnect ?? canConnect,
    ensureSquadSandbox: dependencyOverrides.ensureSquadSandbox ?? ensureSquadSandbox,
    supervisor: dependencyOverrides.supervisor ?? new LocalDeploymentProcessSupervisor(),
    resolveLocalDeploymentTarget: dependencyOverrides.resolveLocalDeploymentTarget ?? resolveLocalDeploymentTarget,
    isBoxMigrating: dependencyOverrides.isBoxMigrating ?? isBoxMigrating,
  }
}

export function configureLocalDeploymentHealthDependencies(
  overrides: Partial<LocalDeploymentHealthDependencies> = {}
): void {
  dependencyOverrides = overrides
}

export async function canConnect(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    let settled = false

    function finish(result: boolean): void {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * Probe a deployment and write back the resulting health status.
 *
 * Accepts either an id (read it here) or an already-loaded row. The health
 * poller lists every live deployment once per tick and then hands the rows
 * straight back in, which removes one `SELECT` per deployment per tick; the
 * row is milliseconds old and every decision below is re-committed through
 * `updateLocalDeploymentRecord`, so nothing depends on a fresher read.
 */
export async function refreshLocalDeploymentHealth(target: string | LocalDeployment): Promise<LocalDeployment> {
  const localDeployment = typeof target === 'string' ? await requireLocalDeployment(target) : target
  if (localDeployment.status === 'stopped') return localDeployment

  const { canConnect, ensureSquadSandbox, supervisor, resolveLocalDeploymentTarget } = getDependencies()
  await ensureSquadSandbox(localDeployment.squadId, { restartManagedLocalDeployments: false })
  let healthy = false
  try {
    const target = await resolveLocalDeploymentTarget(localDeployment.sandboxId, localDeployment.port)
    healthy = await canConnect(target.host, target.port)
  } catch {
    healthy = false
  }
  if (healthy) {
    return updateLocalDeploymentRecord(localDeployment.id, { status: 'running', keepSandboxAlive: true })
  }

  if (localDeployment.mode === 'managed') {
    const hasSession = localDeployment.processId
      ? await supervisor.hasSession(localDeployment.sandboxId, localDeployment.processId)
      : false
    if (!hasSession) {
      return updateLocalDeploymentRecord(localDeployment.id, { status: 'crashed', keepSandboxAlive: false })
    }
  }

  return updateLocalDeploymentRecord(localDeployment.id, { status: 'unhealthy' })
}

async function waitForLocalDeploymentHealthy(
  localDeploymentId: string,
  timeoutMs = 10_000,
  intervalMs = 500
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    try {
      const localDeployment = await refreshLocalDeploymentHealth(localDeploymentId)
      if (localDeployment.status === 'running') return
      if (localDeployment.status === 'crashed') return
    } catch {
      // Keep polling briefly; the regular reconciler will handle persistent failures.
    }
  }
}

export interface RestartLocalDeploymentOptions {
  /**
   * Whether to skip the restart while the deployment's box is mid-migration
   * (`machine_boxes.migrating`). Default `true` — the safe default for EVERY
   * restart TRIGGER (the health poller's crashed/unhealthy self-heal, and
   * ensureSquadSandbox's ensure-triggered restart): without it, a squad
   * migration's quiesce (which marks a managed-always deployment `crashed` so
   * it stays restartable — see {@link stopLocalDeploymentsForSandbox}) is
   * silently undone by a poller tick resurrecting the process on the OLD box
   * mid-archive, racing the tar with live writes.
   *
   * `false` is the ONE deliberate exception: box-migrate.ts's own post-move
   * restart (the row is already repointed to the target; the fence is just a
   * vestige of its own not-yet-finished call — see the module's fence-clear
   * ordering). This still reads the SAME `migrating` column via
   * {@link isBoxMigrating} — it is not a second flag, just a call site that
   * knows it is the migration and chooses not to be gated by its own fence.
   */
  skipIfMigrating?: boolean
}

/**
 * Restarts in flight in this process, by deployment id. Each start kills the
 * deployment's tmux session and creates it again under the same name, so two
 * overlapping starts collide: the second `tmux new-session` fails with
 * "duplicate session". A worker restart made that routine — every execution
 * resuming on a squad box ran ensureSquadSandbox's restart at once — so a
 * concurrent caller joins the restart already under way instead.
 */
const restartsInFlight = new Map<string, Promise<LocalDeployment>>()

export function restartManagedLocalDeployment(
  localDeploymentId: string,
  opts: RestartLocalDeploymentOptions = {}
): Promise<LocalDeployment> {
  const inFlight = restartsInFlight.get(localDeploymentId)
  if (inFlight) return inFlight
  const restart = restartManagedLocalDeploymentOnce(localDeploymentId, opts).finally(() => {
    restartsInFlight.delete(localDeploymentId)
  })
  restartsInFlight.set(localDeploymentId, restart)
  return restart
}

async function restartManagedLocalDeploymentOnce(
  localDeploymentId: string,
  opts: RestartLocalDeploymentOptions
): Promise<LocalDeployment> {
  const localDeployment = await requireLocalDeployment(localDeploymentId)
  if (localDeployment.mode !== 'managed') {
    return localDeployment
  }
  if (localDeployment.restartPolicy !== 'always') {
    return localDeployment
  }
  if (!localDeployment.command?.trim()) {
    throw new Error('Managed localDeployment cannot restart without a command')
  }

  const { ensureSquadSandbox, supervisor, isBoxMigrating: checkMigrating } = getDependencies()
  if (opts.skipIfMigrating !== false && (await checkMigrating(localDeployment.sandboxId))) {
    log.info(
      `Skipping restart of managed localDeployment ${localDeploymentId}: box ${localDeployment.sandboxId} is mid-migration`
    )
    return localDeployment
  }
  await ensureSquadSandbox(localDeployment.squadId, { restartManagedLocalDeployments: false })
  const { processId } = await supervisor.startManagedLocalDeployment({
    localDeploymentId: localDeployment.id,
    sandboxId: localDeployment.sandboxId,
    command: localDeployment.command,
    cwd: localDeployment.cwd,
    port: localDeployment.port,
  })

  const restarted = await updateLocalDeploymentRecord(localDeployment.id, {
    status: 'restarting',
    keepSandboxAlive: true,
    processId,
    restartCount: localDeployment.restartCount + 1,
  })

  waitForLocalDeploymentHealthy(localDeployment.id).catch(() => {})

  return restarted
}

export async function ensureSandboxesForLiveManagedLocalDeployments(): Promise<void> {
  const sandboxIds = await listSandboxIdsWithLiveManagedLocalDeployments()
  for (const sandboxId of sandboxIds) {
    await ensureSquadSandbox(sandboxId.replace(/^squad_/, ''))
  }
}

/**
 * Bring a box's managed deployments back up after the box (re)appears. A
 * deployment whose tmux session is still alive is left alone: Core restarting
 * does not stop the box, so killing a healthy app here only cost it a restart
 * (and raced any other start). A live-but-unhealthy app is the health poller's
 * to restart. One deployment failing does not stop the rest; the first error
 * is rethrown once every deployment has been tried.
 */
export async function restartManagedLocalDeploymentsForSandbox(
  sandboxId: string,
  opts: RestartLocalDeploymentOptions = {}
): Promise<void> {
  const { supervisor } = getDependencies()
  const localDeployments = await listRestartableManagedLocalDeploymentsForSandbox(sandboxId)
  let firstError: unknown
  for (const localDeployment of localDeployments) {
    try {
      if (localDeployment.processId && (await supervisor.hasSession(sandboxId, localDeployment.processId))) continue
      await restartManagedLocalDeployment(localDeployment.id, opts)
    } catch (err) {
      log.warn(`Failed to restart managed localDeployment ${localDeployment.id} on ${sandboxId}:`, err)
      firstError ??= err
    }
  }
  if (firstError !== undefined) throw firstError
}

/**
 * Quiesce a sandbox's local deployments for a box migration: ACTUALLY terminate
 * the running managed processes (kill their tmux sessions on the box) BEFORE
 * marking the DB rows stopped/crashed. A box migration archives ~/workspace off
 * the (still-running) old box, so an app writing to the workspace mid-tar would
 * produce an inconsistent archive — the kill must land before the pull.
 *
 * managed-always rows are marked `crashed` (not `stopped`) by
 * markLocalDeploymentsStoppedForSandbox, so they remain in the restartable set
 * for {@link restartManagedLocalDeploymentsForSandbox} to bring back up on the
 * TARGET box once the move is proven.
 *
 * The session kill is `tmux kill-session ... || true` (a no-op on an absent
 * session), so this only rejects if the box exec transport itself fails — in
 * which case the migration must abort pre-archive rather than tar a live tree.
 */
export async function stopLocalDeploymentsForSandbox(sandboxId: string): Promise<void> {
  const supervisor = new LocalDeploymentProcessSupervisor()
  const live = await listRestartableManagedLocalDeploymentsForSandbox(sandboxId)
  for (const localDeployment of live) {
    if (localDeployment.processId) {
      await supervisor.stopLocalDeployment(sandboxId, localDeployment.processId)
    }
  }
  await markLocalDeploymentsStoppedForSandbox(sandboxId)
}

async function requireLocalDeployment(localDeploymentId: string): Promise<LocalDeployment> {
  const localDeployment = await getLocalDeployment(localDeploymentId)
  if (!localDeployment) {
    throw new Error('Sandbox localDeployment not found')
  }
  return localDeployment
}
