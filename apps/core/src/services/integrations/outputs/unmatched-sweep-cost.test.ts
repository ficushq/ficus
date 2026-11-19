import { afterEach, expect, test } from 'bun:test'
import { like, sql } from 'drizzle-orm'
import { db } from '../../../db'
import { integrationOutputEvents } from '../../../db/schema'
import { ensureQueryIndex } from '../../../test-utils/message-query-indexes'

const prefix = `sweep-cost-${crypto.randomUUID()}`
afterEach(async () => {
  await db.delete(integrationOutputEvents).where(like(integrationOutputEvents.sourceKey, `${prefix}%`))
})

// reconcileUnmatchedOutputs runs several times a minute and asks only for events with no
// match yet. On a live instance it read every event, facts included, on each pass: 3.1 billion
// rows over two weeks for a table of 39,000.
test('the unmatched-output sweep reads the unmatched events, not the whole table', async () => {
  await ensureQueryIndex('idx_integration_output_events_unmatched')
  await db.execute(sql`INSERT INTO integration_output_events(integration, source_key, event_key, authority, fact, matched_at)
    SELECT CASE WHEN n % 50 = 0 THEN 'linear' ELSE 'github' END,
      ${prefix} || ':' || n, 'event', '{"kind":"system"}'::jsonb,
      jsonb_build_object('output', 'x', 'body', repeat(md5(n::text), 40)),
      CASE WHEN n % 1000 = 0 THEN NULL ELSE now() END
    FROM generate_series(1, 20000) n`)
  await db.execute(sql`ANALYZE integration_output_events`)

  const sweeps = [
    // The two shapes the sweep issues (runtime.ts), without the GitHub-only anti-joins.
    sql`SELECT id, integration FROM integration_output_events
      WHERE integration <> 'github' AND matched_at IS NULL ORDER BY id ASC LIMIT 25`,
    sql`SELECT id, integration FROM integration_output_events
      WHERE integration = 'github' AND matched_at IS NULL
        AND id > '00000000-0000-0000-0000-000000000000' ORDER BY id ASC LIMIT 25`,
  ]
  for (const sweep of sweeps) {
    const [explained] = await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sweep}`)
    const plan = (explained['QUERY PLAN'] as any)[0].Plan
    expect(JSON.stringify(plan)).toContain('idx_integration_output_events_unmatched')
    expect(JSON.stringify(plan)).not.toContain('Seq Scan')
    expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(100)
  }

  // Without the index the same sweep reads the table.
  const rollback = new Error('restore the unmatched index')
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`DROP INDEX idx_integration_output_events_unmatched`)
      const [explained] = await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sweeps[0]!}`)
      const plan = (explained['QUERY PLAN'] as any)[0].Plan
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeGreaterThan(100)
      throw rollback
    })
  ).rejects.toBe(rollback)
})
