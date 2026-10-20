/**
 * Process lifecycle for managed shared BigBrain on Ficus Cloud. Both are owned periodic runners
 * (start/stop drained with the process; no detached timers) and are no-ops off Cloud.
 *
 * - API process: keeps its own eligibility snapshot fresh (catalog/enable predicates).
 * - Worker process: the same refresh, then the reconciler (pending host operations, one row at a
 *   time), a periodic status sweep, and read-credential synchronization. The periodic runner
 *   never overlaps ticks, so the reconciler is single-flight within the worker.
 */
import { createPeriodicRunner, type PeriodicRunner } from '../../../../lib/infra/PeriodicRunner'
import { isPlatformManaged } from '../../../secrets/managed'
import { MANAGED_BIGBRAIN_CAPABILITY_TTL_MS } from './availability'
import { createManagedHostClient } from './host-client'
import { managedBigbrainPlatform } from './platform-client'
import { refreshManagedBigbrainSupport, type ManagedRefreshDeps } from './refresh'

/** Refresh comfortably inside the snapshot TTL so one failed probe does not flip eligibility. */
export const MANAGED_BIGBRAIN_REFRESH_INTERVAL_MS = Math.floor(MANAGED_BIGBRAIN_CAPABILITY_TTL_MS / 4)
export const MANAGED_BIGBRAIN_RECONCILE_INTERVAL_MS = 5_000
export const MANAGED_BIGBRAIN_SWEEP_INTERVAL_MS = 10 * 60_000
const SYNC_INTERVAL_MS = 30_000
const ROWS_PER_TICK = 3

export function createManagedBigbrainCapabilityRunner(deps: ManagedRefreshDeps = {}): PeriodicRunner {
  return createPeriodicRunner({
    name: 'managed-bigbrain-capabilities',
    intervalMs: MANAGED_BIGBRAIN_REFRESH_INTERVAL_MS,
    task: async () => {
      if (!isPlatformManaged()) return
      await refreshManagedBigbrainSupport(deps)
    },
  })
}

export function createManagedBigbrainSyncRunner(): PeriodicRunner {
  const hostClient = createManagedHostClient()
  let lastRefresh = 0
  let lastSweep = 0
  let lastSync = 0
  return createPeriodicRunner({
    name: 'managed-bigbrain-reconcile',
    intervalMs: MANAGED_BIGBRAIN_RECONCILE_INTERVAL_MS,
    task: async () => {
      if (!isPlatformManaged()) return
      const now = Date.now()
      if (now - lastRefresh >= MANAGED_BIGBRAIN_REFRESH_INTERVAL_MS) {
        lastRefresh = now
        await refreshManagedBigbrainSupport({ hostClient })
      }
      const { reconcileNext, sweepManagedVaults } = await import('./reconciler')
      const deps = { hostClient, platform: managedBigbrainPlatform }
      for (let i = 0; i < ROWS_PER_TICK; i++) {
        const outcome = await reconcileNext(deps)
        if (outcome === 'idle' || outcome === 'unavailable') break
      }
      if (now - lastSweep >= MANAGED_BIGBRAIN_SWEEP_INTERVAL_MS) {
        lastSweep = now
        await sweepManagedVaults(deps)
      }
      if (now - lastSync >= SYNC_INTERVAL_MS) {
        lastSync = now
        const [{ synchronizeManagedBigbrain }, runtime, { getSecretStore }] = await Promise.all([
          import('./synchronizer'),
          import('../../runtime'),
          import('../../../secrets'),
        ])
        await synchronizeManagedBigbrain({
          connections: runtime.integrationConnectionService,
          listConnections: () => runtime.integrationConnectionRepository.list('bigbrain'),
          getConnection: (id) => runtime.integrationConnectionRepository.get(id),
          credential: (ref) => getSecretStore().get(ref),
        })
      }
    },
  })
}
