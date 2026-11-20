import { afterEach, describe, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { db, integrationEventPollingDispatches } from '../../../db'
import { listPeriodicRunnerNames } from '../../../lib/infra/PeriodicRunner'
import {
  LINEAR_RELAY_RECEIPT_RETENTION_MS,
  SLACK_RECEIPT_RETENTION_MS,
  sweepCompletedLinearRelayReceipts,
  sweepCompletedSlackDispatchReceipts,
  SlackDispatchReceiptSweepWorker,
} from './slack-receipt-sweep'

const eventKeys: string[] = []

afterEach(async () => {
  if (eventKeys.length) {
    await db
      .delete(integrationEventPollingDispatches)
      .where(inArray(integrationEventPollingDispatches.eventKey, eventKeys.splice(0)))
  }
})

describe('sweepCompletedSlackDispatchReceipts', () => {
  test('deletes only slack receipts completed before the retention horizon', async () => {
    const now = new Date('2026-09-01T00:00:00.000Z')
    const beforeCutoff = new Date(now.getTime() - SLACK_RECEIPT_RETENTION_MS - 1)
    const afterCutoff = new Date(now.getTime() - SLACK_RECEIPT_RETENTION_MS + 1)

    const staleSlack = `webhook:sweep-test:${crypto.randomUUID()}`
    const freshSlack = `webhook:sweep-test:${crypto.randomUUID()}`
    const uncompletedSlack = `webhook:sweep-test:${crypto.randomUUID()}`
    // GitHub's completed receipts stay keyed by activityId/eventFact for
    // authorizeActivitySquad's indefinite reattachment path (see
    // materializeGitHubDispatch) — the sweep must never touch them.
    const staleGithub = `poll:sweep-test:${crypto.randomUUID()}`
    eventKeys.push(staleSlack, freshSlack, uncompletedSlack, staleGithub)

    await db.insert(integrationEventPollingDispatches).values([
      { providerKey: 'slack', eventKey: staleSlack, completedAt: beforeCutoff },
      { providerKey: 'slack', eventKey: freshSlack, completedAt: afterCutoff },
      { providerKey: 'slack', eventKey: uncompletedSlack, completedAt: null },
      { providerKey: 'github', eventKey: staleGithub, completedAt: beforeCutoff },
    ])

    const deleted = await sweepCompletedSlackDispatchReceipts(now)
    expect(deleted).toBe(1)

    const remaining = await db
      .select({ eventKey: integrationEventPollingDispatches.eventKey })
      .from(integrationEventPollingDispatches)
      .where(
        inArray(integrationEventPollingDispatches.eventKey, [staleSlack, freshSlack, uncompletedSlack, staleGithub])
      )

    expect(remaining.map((row) => row.eventKey).sort()).toEqual([freshSlack, staleGithub, uncompletedSlack].sort())
  })
})

describe('sweepCompletedLinearRelayReceipts', () => {
  test('deletes only completed Linear relay receipts older than the retention horizon', async () => {
    const now = new Date('2026-11-20T00:00:00.000Z')
    const beforeCutoff = new Date(now.getTime() - LINEAR_RELAY_RECEIPT_RETENTION_MS - 1)
    const afterCutoff = new Date(now.getTime() - LINEAR_RELAY_RECEIPT_RETENTION_MS + 1)
    const stale = `linear:${crypto.randomUUID()}`
    const fresh = `linear:${crypto.randomUUID()}`
    const uncompleted = `linear:${crypto.randomUUID()}`
    // Other Linear receipt families are not relay receipts and keep their own lifetime.
    const otherLinear = `poll:sweep-test:${crypto.randomUUID()}`
    const staleSlack = `linear:${crypto.randomUUID()}`
    eventKeys.push(stale, fresh, uncompleted, otherLinear, staleSlack)
    await db.insert(integrationEventPollingDispatches).values([
      { providerKey: 'linear', eventKey: stale, completedAt: beforeCutoff },
      { providerKey: 'linear', eventKey: fresh, completedAt: afterCutoff },
      { providerKey: 'linear', eventKey: uncompleted, completedAt: null },
      { providerKey: 'linear', eventKey: otherLinear, completedAt: beforeCutoff },
      { providerKey: 'slack', eventKey: staleSlack, completedAt: afterCutoff },
    ])
    expect(await sweepCompletedLinearRelayReceipts(now)).toBe(1)
    const remaining = await db
      .select({ eventKey: integrationEventPollingDispatches.eventKey })
      .from(integrationEventPollingDispatches)
      .where(inArray(integrationEventPollingDispatches.eventKey, [stale, fresh, uncompleted, otherLinear, staleSlack]))
    expect(remaining.map((row) => row.eventKey).sort()).toEqual([fresh, uncompleted, otherLinear, staleSlack].sort())
  })
})

describe('SlackDispatchReceiptSweepWorker', () => {
  test('registers and deregisters the periodic runner', async () => {
    const worker = new SlackDispatchReceiptSweepWorker(() => new Date())
    worker.start()
    try {
      expect(listPeriodicRunnerNames()).toContain('slack-dispatch-receipt-sweep')
    } finally {
      await worker.stop()
    }
    expect(listPeriodicRunnerNames()).not.toContain('slack-dispatch-receipt-sweep')
  })
})
