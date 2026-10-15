/** Worker-side upkeep of the ledger: hourly rollups and retention pruning, and the one-time backfill. */
import { createLogger } from '../../lib/infra/logger'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { pruneInferenceUsage, runInferenceUsageRollup } from './retention'

const log = createLogger('inference-usage')
export const INFERENCE_USAGE_MAINTENANCE_INTERVAL_MS = 60 * 60_000

let runner: PeriodicRunner | null = null

export function startInferenceUsageMaintenance(): void {
  if (runner) return
  runner = createPeriodicRunner({
    name: 'inference-usage-maintenance',
    intervalMs: INFERENCE_USAGE_MAINTENANCE_INTERVAL_MS,
    // Also on start: a worker restarted more often than hourly would otherwise never roll up or prune.
    runImmediately: true,
    task: async () => {
      await runInferenceUsageRollup()
      // Pruning is a no-op until a day falls out of the retention window.
      await pruneInferenceUsage()
    },
  })
  runner.start()
  // The one-time import of usage recorded before the ledger existed; resumable and idempotent.
  void import('./backfill')
    .then(({ runInferenceUsageBackfillOnce }) => runInferenceUsageBackfillOnce())
    .catch((error) => log.warn('Inference usage backfill did not finish', error))
}

export async function stopInferenceUsageMaintenance(): Promise<void> {
  if (!runner) return
  await runner.stop()
  runner = null
}
