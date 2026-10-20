/**
 * Process lifecycle for managed shared BigBrain on Ficus Cloud. Both are owned periodic runners
 * (start/stop drained with the process; no detached timers) and are no-ops off Cloud.
 *
 * - API process: keeps its own capability snapshot fresh (catalog/eligibility predicates).
 * - Worker process: the full bounded synchronization (summaries, read-material import, fences).
 */
import { createPeriodicRunner, type PeriodicRunner } from '../../../../lib/infra/PeriodicRunner'
import { isPlatformManaged } from '../../../secrets/managed'
import {
  MANAGED_BIGBRAIN_CAPABILITY_TTL_MS,
  noteManagedBigbrainCapabilityFailure,
  recordManagedBigbrainCapabilities,
} from './availability'
import { managedBigbrainPlatform } from './platform-client'

/** Refresh comfortably inside the snapshot TTL so one failed probe does not flip eligibility. */
export const MANAGED_BIGBRAIN_REFRESH_INTERVAL_MS = Math.floor(MANAGED_BIGBRAIN_CAPABILITY_TTL_MS / 4)

export function createManagedBigbrainCapabilityRunner(
  platform: Pick<typeof managedBigbrainPlatform, 'capabilities'> = managedBigbrainPlatform
): PeriodicRunner {
  return createPeriodicRunner({
    name: 'managed-bigbrain-capabilities',
    intervalMs: MANAGED_BIGBRAIN_REFRESH_INTERVAL_MS,
    task: async () => {
      if (!isPlatformManaged()) return
      try {
        recordManagedBigbrainCapabilities(await platform.capabilities())
      } catch (error) {
        noteManagedBigbrainCapabilityFailure(error)
      }
    },
  })
}

export function createManagedBigbrainSyncRunner(): PeriodicRunner {
  return createPeriodicRunner({
    name: 'managed-bigbrain-sync',
    intervalMs: MANAGED_BIGBRAIN_REFRESH_INTERVAL_MS,
    task: async () => {
      if (!isPlatformManaged()) return
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
    },
  })
}
