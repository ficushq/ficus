import { DbEventPollingDispatchStore } from '../db-event-polling-dispatch-store'
import type { EventPollingDispatchStore } from '../event-polling-runner'

/**
 * Logical delivery keys for the Linear agent app (5.7). The webhook path and the polling fallback
 * claim the same key for one session, prompt or notification, so whichever arrives first processes
 * it and the other skips it, whatever the delivery or connection revision.
 */
export const linearDeliveryKey = {
  sessionCreated: (sessionId: string) => `linear:session:${sessionId}:created`,
  prompt: (activityId: string) => `linear:activity:${activityId}`,
  notification: (notificationId: string) => `linear:notification:${notificationId}`,
}

/** Long enough for routing (probe, rules, decision conditions) to finish before another path may retry. */
const RECEIPT_LEASE_MS = 10 * 60_000

let store: EventPollingDispatchStore = new DbEventPollingDispatchStore()

/** Tests only. */
export function setLinearDeliveryReceiptStoreForTest(next: EventPollingDispatchStore | null) {
  store = next ?? new DbEventPollingDispatchStore()
}

/**
 * Runs `process` once per logical delivery. A delivery already completed is skipped and reported as
 * `false`. One being processed elsewhere right now is skipped too, unless `retryWhenBusy` is set:
 * the poller sets it so its cursor does not move past a delivery whose other processing may still
 * fail. A failure releases the receipt so the next webhook retry or poll processes it again.
 */
export async function withLinearDeliveryReceipt(
  key: string,
  process: () => Promise<void>,
  options: { retryWhenBusy?: boolean } = {}
): Promise<boolean> {
  const claim = await store.claim('linear', key, RECEIPT_LEASE_MS)
  if (claim.status === 'busy' && options.retryWhenBusy)
    throw new Error('Linear delivery is being processed elsewhere; retrying on the next poll')
  if (claim.status !== 'claimed') return false
  try {
    await process()
  } catch (error) {
    await store.release('linear', key, claim.leaseToken).catch(() => undefined)
    throw error
  }
  await store.complete('linear', key, claim.leaseToken)
  return true
}
