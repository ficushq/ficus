import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { createLogger } from '../../lib/infra/logger'
import { listLiveLocalDeployments } from './local-deployment-service'
import {
  LocalDeploymentHealthUnavailableError,
  refreshLocalDeploymentHealth,
  restartManagedLocalDeployment,
  stopLocalDeploymentReadinessChecks,
} from './local-deployment-health'
import { drainLocalDeploymentHealthObservations } from './local-deployment-observation'

const log = createLogger('local-deployment-health-poller')
/**
 * Every read-only observation has a 5s total deadline; ensure/start are owned
 * separately and cannot hold this tick open. With N apps, observation time per
 * tick is at most 5N seconds. Accounting for an in-flight tick plus the next
 * scheduled tick gives a conservative 30 + 10N second correction bound while
 * Core/DB are responsive. Cleanup and recovery each retain at most two jobs.
 */
const LOCAL_APP_HEALTH_POLL_INTERVAL_MS = Number(process.env.LOCAL_APP_HEALTH_POLL_INTERVAL_MS) || 30_000
const LOCAL_APP_RESTART_COOLDOWN_MS = Number(process.env.LOCAL_APP_RESTART_COOLDOWN_MS) || 30_000

const RESTARTABLE_STATUSES = new Set(['crashed', 'unhealthy'] as const)

let runner: PeriodicRunner | null = null
const recoveries = new Map<string, Promise<void>>()
const MAX_PENDING_RECOVERIES = 2
const lastRestartAttempts = new Map<string, number>()

export interface LocalDeploymentHealthReconcileDeps {
  listLiveLocalDeployments: typeof listLiveLocalDeployments
  refreshLocalDeploymentHealth: typeof refreshLocalDeploymentHealth
  restartManagedLocalDeployment: typeof restartManagedLocalDeployment
}

const defaultDeps: LocalDeploymentHealthReconcileDeps = {
  listLiveLocalDeployments,
  refreshLocalDeploymentHealth,
  restartManagedLocalDeployment,
}

export async function reconcileLocalDeploymentHealth(
  deps: LocalDeploymentHealthReconcileDeps = defaultDeps
): Promise<void> {
  const localDeployments = await deps.listLiveLocalDeployments()
  const liveIds = new Set(localDeployments.map((deployment) => deployment.id))
  for (const id of lastRestartAttempts.keys())
    if (!liveIds.has(id) && !recoveries.has(id)) lastRestartAttempts.delete(id)
  for (const localDeployment of localDeployments) {
    try {
      // Hand the row we just listed to the refresh instead of its id: the
      // re-read it would otherwise do returns the same row we already have.
      const refreshed = await deps.refreshLocalDeploymentHealth(localDeployment)
      if (RESTARTABLE_STATUSES.has(refreshed.status as 'crashed' | 'unhealthy')) scheduleRecovery(refreshed, deps)
    } catch (err) {
      if (err instanceof LocalDeploymentHealthUnavailableError) scheduleRecovery(localDeployment, deps)
      log.warn(`Failed to reconcile localDeployment ${localDeployment.id}:`, err)
    }
  }
}

function scheduleRecovery(
  deployment: Awaited<ReturnType<typeof listLiveLocalDeployments>>[number],
  deps: LocalDeploymentHealthReconcileDeps
): void {
  if (
    deployment.mode !== 'managed' ||
    deployment.restartPolicy !== 'always' ||
    deployment.status === 'stopped' ||
    deployment.archivedAt ||
    recoveries.has(deployment.id) ||
    recoveries.size >= MAX_PENDING_RECOVERIES ||
    !shouldAttemptRestart(deployment.id)
  )
    return
  if (!RESTARTABLE_STATUSES.has(deployment.status as 'crashed' | 'unhealthy') && deployment.status !== 'running') return
  lastRestartAttempts.set(deployment.id, Date.now())
  // Own, do not race or abandon, mutating ensure/start. At most two such jobs
  // may be pending; health observation and future ticks never wait on them.
  const recovery = Promise.resolve()
    .then(() => deps.restartManagedLocalDeployment(deployment.id, { onlyIfNeeded: true }))
    .then(
      () => {},
      (error) => log.warn(`Managed localDeployment ${deployment.id} recovery failed:`, error)
    )
    .finally(() => recoveries.delete(deployment.id))
  recoveries.set(deployment.id, recovery)
}

/** Shutdown/tests must drain owned mutation jobs before disposing fixtures. */
export async function drainLocalDeploymentRecoveries(): Promise<void> {
  await Promise.all([...recoveries.values()])
}

function shouldAttemptRestart(localDeploymentId: string): boolean {
  const lastAttempt = lastRestartAttempts.get(localDeploymentId) ?? 0
  return Date.now() - lastAttempt >= LOCAL_APP_RESTART_COOLDOWN_MS
}

export function startLocalDeploymentHealthPoller(): void {
  if (runner) return
  runner = createPeriodicRunner({
    name: 'local-deployment-health-reconcile',
    intervalMs: LOCAL_APP_HEALTH_POLL_INTERVAL_MS,
    runImmediately: true,
    task: () => reconcileLocalDeploymentHealth(),
  })
  runner.start()
}

export async function stopLocalDeploymentHealthPoller(): Promise<void> {
  if (runner) await runner.stop()
  runner = null
  await drainLocalDeploymentRecoveries()
  await stopLocalDeploymentReadinessChecks()
  await drainLocalDeploymentHealthObservations()
  lastRestartAttempts.clear()
}
