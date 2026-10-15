import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, inferenceUsage, inferenceUsageDaily } from '../../db'
import { spendSummary } from './query'
import { pruneInferenceUsage, rollupInferenceUsageDays, runInferenceUsageRollup } from './retention'

// Every row belongs to this test's squad, so the assertions never see other tests' rows.
const squadId = crypto.randomUUID()
const at = (iso: string) => new Date(iso)
const row = (iso: string, extra: Partial<typeof inferenceUsage.$inferInsert> = {}) => ({
  occurredAt: at(iso),
  feature: 'agent-turn',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  billing: 'api' as const,
  inputTokens: 100,
  costNanodollars: 1_000_000,
  listCostNanodollars: 1_000_000,
  squadId,
  ...extra,
})

const dailyRows = () =>
  db
    .select()
    .from(inferenceUsageDaily)
    .where(eq(inferenceUsageDaily.squadId, squadId))
    .orderBy(inferenceUsageDaily.day, inferenceUsageDaily.model)
const detailCount = async () =>
  (await db.select().from(inferenceUsage).where(eq(inferenceUsage.squadId, squadId))).length

afterEach(async () => {
  await db.delete(inferenceUsage).where(eq(inferenceUsage.squadId, squadId))
  await db.delete(inferenceUsageDaily).where(eq(inferenceUsageDaily.squadId, squadId))
})

describe('inference usage rollups and retention', () => {
  test('a rollup sums a whole UTC day per group, and rebuilding it is idempotent', async () => {
    await db
      .insert(inferenceUsage)
      .values([
        row('2026-05-01T00:00:00Z'),
        row('2026-05-01T23:59:59Z', { listCostNanodollars: null, costEstimated: true }),
        row('2026-05-01T12:00:00Z', { model: 'claude-opus-4-5', outputTokens: 7 }),
        row('2026-05-02T00:00:00Z'),
      ])
    await rollupInferenceUsageDays(['2026-05-01'])
    await rollupInferenceUsageDays(['2026-05-01', '2026-05-01'])
    const rows = await dailyRows()
    expect(rows.map((r) => [r.day, r.model, r.calls, r.inputTokens, r.costNanodollars, r.listCostNanodollars])).toEqual(
      [
        ['2026-05-01', 'claude-opus-4-5', 1, 100, 1_000_000, 1_000_000],
        ['2026-05-01', 'claude-sonnet-4-5', 2, 200, 2_000_000, 1_000_000],
      ]
    )
    expect(rows[1]).toMatchObject({ listUnknownCalls: 1, estimatedCalls: 1, outputTokens: 0 })
  })

  test('pruning rolls days up first, deletes only rows before the cutoff, and totals survive', async () => {
    const now = at('2026-09-20T12:00:00Z')
    await db.insert(inferenceUsage).values([
      row('2026-09-18T10:00:00Z'), // before a 1-day cutoff (2026-09-19)
      row('2026-09-18T11:00:00Z'),
      row('2026-09-19T00:00:00Z'), // first kept day
      row('2026-09-20T09:00:00Z'),
    ])
    const range = { from: at('2026-09-01T00:00:00Z'), to: at('2026-10-01T00:00:00Z') }
    const before = await spendSummary(range, { squadId }, { now, retentionDays: 1 })
    expect(before.totals.calls).toBe(2) // with a 1-day cutoff and no rollup yet, old rows are not read

    expect(await pruneInferenceUsage({ now, retentionDays: 1 })).toBeGreaterThanOrEqual(2)
    expect(await detailCount()).toBe(2)
    const rolled = await dailyRows()
    expect(rolled.map((r) => [r.day, r.calls])).toEqual([['2026-09-18', 2]])

    const after = await spendSummary(range, { squadId }, { now, retentionDays: 1 })
    expect(after.totals).toMatchObject({ calls: 4, billedUsd: 0.004 })
  })

  test('the hourly rollup builds yesterday and today, and the first run builds every day', async () => {
    const now = at('2026-09-20T12:00:00Z')
    await db.insert(inferenceUsage).values([row('2026-09-10T10:00:00Z'), row('2026-09-19T10:00:00Z')])
    await runInferenceUsageRollup(now)
    const days = (await dailyRows()).map((r) => r.day)
    expect(days).toContain('2026-09-19')
    // Only the very first run (no rollups at all) sweeps every older day; other tests may have
    // rolled up before, so assert the older day only when it was swept.
    if (days.includes('2026-09-10')) expect(days).toEqual(['2026-09-10', '2026-09-19'])
  })

  test('a row written late for a recent day is rolled up on the next hourly run', async () => {
    const now = at('2026-09-20T12:00:00Z')
    await db.insert(inferenceUsage).values(row('2026-09-16T10:00:00Z'))
    await rollupInferenceUsageDays(['2026-09-16'])
    await db.insert(inferenceUsage).values(row('2026-09-16T11:00:00Z'))
    await runInferenceUsageRollup(now)
    expect((await dailyRows()).find((r) => r.day === '2026-09-16')?.calls).toBe(2)
  })
})
