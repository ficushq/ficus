import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { createLogger } from '../../lib/infra/logger'
import { listLiveLocalDeployments } from './local-deployment-service'
import { refreshLocalDeploymentHealth, restartManagedLocalDeployment } from './local-deployment-health'

const log = createLogger('local-deployment-health-poller')
/**
 * Default reconciliation cadence: 30s, plus each tick's bounded HTTP probes
 * (2s each) and sandbox ensure/session I/O. Runs immediately on worker startup.
 * Managed apps require their own live session AND an HTTP readiness response;
 * an accepting SSH-forward listener alone must never keep a dead app running.
 * Startup also has a short 500ms readiness loop. Recovery attempts remain
 * limited to one per deployment per 30s cooldown, with single-flight launches.
 */
const LOCAL_APP_HEALTH_POLL_INTERVAL_MS = Number(process.env.LOCAL_APP_HEALTH_POLL_INTERVAL_MS) || 30_000
const LOCAL_APP_RESTART_COOLDOWN_MS = Number(process.env.LOCAL_APP_RESTART_COOLDOWN_MS) || 30_000

const RESTARTABLE_STATUSES = new Set(['crashed', 'unhealthy'] as const)

let runner: PeriodicRunner | null = null
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
  for (const localDeployment of localDeployments) {
    try {
      // Hand the row we just listed to the refresh instead of its id: the
      // re-read it would otherwise do returns the same row we already have.
      const refreshed = await deps.refreshLocalDeploymentHealth(localDeployment)
      if (
        refreshed.mode === 'managed' &&
        refreshed.restartPolicy === 'always' &&
        RESTARTABLE_STATUSES.has(refreshed.status as 'crashed' | 'unhealthy') &&
        shouldAttemptRestart(refreshed.id)
      ) {
        lastRestartAttempts.set(refreshed.id, Date.now())
        await deps.restartManagedLocalDeployment(refreshed.id)
      }
    } catch (err) {
      log.warn(`Failed to reconcile localDeployment ${localDeployment.id}:`, err)
    }
  }
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
  if (!runner) return
  await runner.stop()
  runner = null
  lastRestartAttempts.clear()
}
