import { afterAll, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { db, webhookEvents } from '../../db'
import { listLinearIssueSourcePage } from './source-loaders'

const ids: string[] = []
afterAll(async () => {
  if (ids.length) await db.delete(webhookEvents).where(inArray(webhookEvents.id, ids))
})

test('the webhook receipt scan advances past rows that yield no fact, one row per page', async () => {
  const from = new Date(Date.now() - 60_000)
  // Verified Linear agent app deliveries that are not issue facts; created_at keeps microseconds.
  const rows = await db
    .insert(webhookEvents)
    .values(
      [1, 2, 3].map(() => ({
        provider: 'linear-app',
        eventType: 'AgentSessionEvent',
        payload: { type: 'AgentSessionEvent', action: 'created' },
        headers: {},
        signature: null,
        verified: true,
      }))
    )
    .returning({ id: webhookEvents.id })
  ids.push(...rows.map((row) => row.id))
  const to = new Date(Date.now() + 60_000)
  let cursor = null as Parameters<typeof listLinearIssueSourcePage>[2]
  let pages = 0
  do {
    const page = await listLinearIssueSourcePage(from, to, cursor, 1)
    expect(page.groupIds).toEqual([])
    cursor = page.next
    pages++
  } while (cursor && pages < 50)
  // Every row is read once: the scan ends instead of re-reading the last row forever.
  expect(cursor).toBeNull()
  expect(pages).toBeLessThan(50)
})
