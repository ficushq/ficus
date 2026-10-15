import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, inferenceUsage, inferenceUsageDaily, settings } from '../../db'
import { spendSummary } from './query'
import { pruneInferenceUsage, rollupInferenceUsageDays, runInferenceUsageRollup } from './retention'
import { PRUNED_BEFORE_KEY, prunedBefore } from './watermark'

// Every row belongs to this test's squad, so the assertions never see other tests' rows. The watermark is
// instance-wide, so each test starts without one and puts back what it found.
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
const now = at('2026-09-20T12:00:00Z')
const september = { from: at('2026-09-01T00:00:00Z'), to: at('2026-10-01T00:00:00Z') }

const dailyRows = () =>
  db
    .select()
    .from(inferenceUsageDaily)
    .where(eq(inferenceUsageDaily.squadId, squadId))
    .orderBy(inferenceUsageDaily.day, inferenceUsageDaily.model)
const dayCalls = async (day: string) =>
  (await dailyRows()).filter((r) => r.day === day).reduce((sum, r) => sum + r.calls, 0)
const detailCount = async () =>
  (await db.select().from(inferenceUsage).where(eq(inferenceUsage.squadId, squadId))).length

let priorWatermark: (typeof settings.$inferSelect)[] = []
beforeEach(async () => {
  priorWatermark = await db.select().from(settings).where(eq(settings.key, PRUNED_BEFORE_KEY))
  await db.delete(settings).where(eq(settings.key, PRUNED_BEFORE_KEY))
})
afterEach(async () => {
  await db.delete(inferenceUsage).where(eq(inferenceUsage.squadId, squadId))
  await db.delete(inferenceUsageDaily).where(eq(inferenceUsageDaily.squadId, squadId))
  await db.delete(settings).where(eq(settings.key, PRUNED_BEFORE_KEY))
  if (priorWatermark.length) await db.insert(settings).values(priorWatermark)
})

describe('inference usage rollups and retention', () => {
  test('a rollup sums a whole UTC day per group, and rebuilding it is idempotent, even concurrently', async () => {
    await db
      .insert(inferenceUsage)
      .values([
        row('2026-05-01T00:00:00Z'),
        row('2026-05-01T23:59:59Z', { listCostNanodollars: null, costEstimated: true }),
        row('2026-05-01T12:00:00Z', { model: 'claude-opus-4-5', outputTokens: 7 }),
        row('2026-05-02T00:00:00Z'),
      ])
    await rollupInferenceUsageDays(['2026-05-01'])
    await Promise.all([rollupInferenceUsageDays(['2026-05-01']), rollupInferenceUsageDays(['2026-05-01'])])
    const rows = await dailyRows()
    expect(rows.map((r) => [r.day, r.model, r.calls, r.inputTokens, r.costNanodollars, r.listCostNanodollars])).toEqual(
      [
        ['2026-05-01', 'claude-opus-4-5', 1, 100, 1_000_000, 1_000_000],
        ['2026-05-01', 'claude-sonnet-4-5', 2, 200, 2_000_000, 1_000_000],
      ]
    )
    expect(rows[1]).toMatchObject({ listUnknownCalls: 1, estimatedCalls: 1, outputTokens: 0 })
  })

  test('pruning rolls days up and deletes them, moving the read boundary, and totals survive', async () => {
    await db.insert(inferenceUsage).values([
      row('2026-09-18T10:00:00Z'), // before a 1-day cutoff (2026-09-19)
      row('2026-09-18T11:00:00Z'),
      row('2026-09-19T00:00:00Z'), // first kept day
      row('2026-09-20T09:00:00Z'),
    ])
    const before = await spendSummary(september, { squadId }, { now })
    expect(before.totals.calls).toBe(4)

    expect(await pruneInferenceUsage({ now, retentionDays: 1 })).toBe(1)
    expect(await prunedBefore()).toBe('2026-09-19')
    expect(await detailCount()).toBe(2)
    expect(await dayCalls('2026-09-18')).toBe(2)

    const after = await spendSummary(september, { squadId }, { now })
    expect(after.totals).toEqual(before.totals)
    expect(after.series).toEqual(before.series)
    expect(after.meta.detailFrom).toBe('2026-09-19T00:00:00.000Z')
  })

  test('raising retention after pruning changes nothing: pruned days still come from their rollups', async () => {
    await db.insert(inferenceUsage).values([row('2026-09-10T10:00:00Z'), row('2026-09-20T09:00:00Z')])
    await pruneInferenceUsage({ now, retentionDays: 1 })
    const pruned = await spendSummary(september, { squadId }, { now, retentionDays: 1 })
    expect(await pruneInferenceUsage({ now, retentionDays: 365 })).toBe(0)
    const raised = await spendSummary(september, { squadId }, { now, retentionDays: 365 })
    expect(raised.totals).toEqual(pruned.totals)
    expect(raised.series).toEqual(pruned.series)
    expect(raised.totals.calls).toBe(2)
  })

  test('rows that arrive for an already pruned day are added to its rollup once', async () => {
    await db.insert(inferenceUsage).values([row('2026-09-18T10:00:00Z'), row('2026-09-20T09:00:00Z')])
    await pruneInferenceUsage({ now, retentionDays: 1 })
    await db.insert(inferenceUsage).values(row('2026-09-18T23:00:00Z'))
    // Hidden until flushed (its day is read from the rollup), never counted twice.
    expect((await spendSummary(september, { squadId }, { now })).totals.calls).toBe(2)
    await runInferenceUsageRollup(now)
    await runInferenceUsageRollup(now)
    await pruneInferenceUsage({ now, retentionDays: 1 })
    expect(await dayCalls('2026-09-18')).toBe(2)
    expect(await detailCount()).toBe(1)
    expect((await spendSummary(september, { squadId }, { now })).totals.calls).toBe(3)
  })

  test('the hourly rollup builds yesterday and today, and the first run builds every day', async () => {
    await db.insert(inferenceUsage).values([row('2026-09-10T10:00:00Z'), row('2026-09-19T10:00:00Z')])
    await runInferenceUsageRollup(now)
    const days = (await dailyRows()).map((r) => r.day)
    expect(days).toContain('2026-09-19')
    // Only the very first run (no rollups at all) sweeps every older day; other tests may have
    // rolled up before, so assert the older day only when it was swept.
    if (days.includes('2026-09-10')) expect(days).toEqual(['2026-09-10', '2026-09-19'])
  })

  test('a row written late for a recent unpruned day is rolled up on the next hourly run', async () => {
    await db.insert(inferenceUsage).values(row('2026-09-16T10:00:00Z'))
    await rollupInferenceUsageDays(['2026-09-16'])
    await db.insert(inferenceUsage).values(row('2026-09-16T11:00:00Z'))
    await runInferenceUsageRollup(now)
    expect(await dayCalls('2026-09-16')).toBe(2)
    expect(await detailCount()).toBe(2)
  })
})
