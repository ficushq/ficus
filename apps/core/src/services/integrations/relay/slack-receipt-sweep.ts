import { and, eq, isNotNull, like, lt } from 'drizzle-orm'
import { db, integrationEventPollingDispatches } from '../../../db'
import { createPeriodicRunner, type PeriodicRunner } from '../../../lib/infra/PeriodicRunner'
import { createLogger } from '../../../lib/infra/logger'

const log = createLogger('slack-receipt-sweep')

/**
 * How long a completed Slack dispatch receipt (`integration_event_polling_dispatches`,
 * `providerKey = 'slack'`) is kept after completion before the sweep deletes it.
 *
 * A completed receipt only needs to stay around long enough to answer a
 * redelivery of the same key with "already done": Slack's Events API retries
 * within roughly 30 minutes of the original delivery, and the hosted relay's
 * own redelivery window is bounded by its short pull cadence and lease.
 * 7 days is a wide, cheap safety margin over either without letting a
 * transient dedup row live in the table forever — every actionable channel
 * event the bot sees inserts one (see webhooks.ts / slack-runtime.ts).
 *
 * Scoped to `slack`: GitHub's polling dispatch receipts stay keyed by
 * `activityId`/`eventFact` indefinitely — `authorizeActivitySquad` uses a
 * still-completed row to reattach a *newly* subscribed squad to a past event
 * (see `materializeGitHubDispatch` in services/squad-activity/materialize.ts
 * and its callers in runtime.ts / relay/runtime.ts). Deleting old GitHub rows
 * would silently break that backfill path, so this sweep never touches them.
 */
export const SLACK_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Deletes completed Slack dispatch receipts older than the retention horizon. Returns the count deleted. */
export async function sweepCompletedSlackDispatchReceipts(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SLACK_RECEIPT_RETENTION_MS)
  const deleted = await db
    .delete(integrationEventPollingDispatches)
    .where(
      and(
        eq(integrationEventPollingDispatches.providerKey, 'slack'),
        isNotNull(integrationEventPollingDispatches.completedAt),
        lt(integrationEventPollingDispatches.completedAt, cutoff)
      )
    )
    .returning({ eventKey: integrationEventPollingDispatches.eventKey })
  if (deleted.length) log.debug(`Swept ${deleted.length} completed Slack dispatch receipt(s)`)
  return deleted.length
}

/**
 * How long a completed hosted Linear relay receipt (`providerKey = 'linear'`, key
 * `linear:<Linear-Delivery>`, see linear-runtime.ts) is kept. Platform retains a relayed delivery
 * for 72 hours (`RELAY_EVENT_TTL_MS`), so a redelivery can never arrive after this horizon. Only
 * relay receipts are swept; other Linear receipt keys are left alone.
 */
export const LINEAR_RELAY_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Deletes completed hosted Linear relay receipts older than the retention horizon. Returns the count deleted. */
export async function sweepCompletedLinearRelayReceipts(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - LINEAR_RELAY_RECEIPT_RETENTION_MS)
  const deleted = await db
    .delete(integrationEventPollingDispatches)
    .where(
      and(
        eq(integrationEventPollingDispatches.providerKey, 'linear'),
        like(integrationEventPollingDispatches.eventKey, 'linear:%'),
        isNotNull(integrationEventPollingDispatches.completedAt),
        lt(integrationEventPollingDispatches.completedAt, cutoff)
      )
    )
    .returning({ eventKey: integrationEventPollingDispatches.eventKey })
  if (deleted.length) log.debug(`Swept ${deleted.length} completed Linear relay receipt(s)`)
  return deleted.length
}

/**
 * Periodic sweep of relay dispatch receipts (Slack and hosted Linear), registered alongside Core's
 * other maintenance runners (see index.ts).
 */
export class SlackDispatchReceiptSweepWorker {
  #runner: PeriodicRunner | null = null
  constructor(private readonly now: () => Date = () => new Date()) {}

  start(): void {
    if (this.#runner) return
    this.#runner = createPeriodicRunner({
      name: 'slack-dispatch-receipt-sweep',
      // Hourly is plenty of headroom under a 7-day retention horizon.
      intervalMs: 60 * 60 * 1000,
      runImmediately: true,
      task: async () => {
        await sweepCompletedSlackDispatchReceipts(this.now())
        await sweepCompletedLinearRelayReceipts(this.now())
      },
    })
    this.#runner.start()
  }

  async stop(): Promise<void> {
    const runner = this.#runner
    this.#runner = null
    await runner?.stop()
  }
}

export const slackDispatchReceiptSweepWorker = new SlackDispatchReceiptSweepWorker()
