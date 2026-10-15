import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray, like, or } from 'drizzle-orm'
import {
  agents,
  agentTypes,
  db,
  decisionLog,
  executions,
  inferenceUsage,
  inferenceUsageDaily,
  settings,
} from '../../db'
import { backfillInferenceUsage } from './backfill'
import { spendSummary } from './query'
import { pruneInferenceUsage } from './retention'
import { PRUNED_BEFORE_KEY } from './watermark'
import { ensureInferenceUsageDedupeIndex } from './test-indexes'

const typeId = `ledger-backfill-${crypto.randomUUID().slice(0, 8)}`
const cutoff = new Date('2026-09-01T00:00:00Z')
const at = (iso: string) => new Date(iso)
let legacyAgent: string
let deltaAgent: string
let liveAgent: string
const workStreamId = crypto.randomUUID()
const decisionPurpose = `backfill-${crypto.randomUUID().slice(0, 8)}`

const snapshot = (
  input: number,
  output: number,
  cost: number,
  delta?: { input: number; output: number; cost: number }
) => ({
  stats: {
    userMessages: 1,
    assistantMessages: 1,
    totalMessages: 2,
    tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
    cost,
  },
  context: null,
  ...(delta
    ? {
        delta: {
          tokens: {
            input: delta.input,
            output: delta.output,
            cacheRead: 0,
            cacheWrite: 0,
            total: delta.input + delta.output,
          },
          cost: delta.cost,
        },
      }
    : {}),
})

beforeAll(async () => {
  await ensureInferenceUsageDedupeIndex()
  await db
    .insert(agentTypes)
    .values({ id: typeId, name: 'Backfill', model: 'anthropic:claude-sonnet-4-5', systemPrompt: 'x' })
  const [legacy, delta, live] = await db
    .insert(agents)
    .values([
      // Session total 1000 tokens beyond its executions' 900: a manual compaction, say.
      { agentTypeId: typeId, sessionUsage: snapshot(1500, 400, 0.3), updatedAt: at('2026-08-20T00:00:00Z') },
      { agentTypeId: typeId, sessionUsage: snapshot(60, 0, 0.06), updatedAt: at('2026-08-20T00:00:00Z') },
      { agentTypeId: typeId, sessionUsage: snapshot(9999, 0, 9), updatedAt: at('2026-08-20T00:00:00Z') },
    ])
    .returning({ id: agents.id })
  legacyAgent = legacy!.id
  deltaAgent = delta!.id
  liveAgent = live!.id
  // Legacy rows: cumulative snapshots only (100 → 450 → 900 tokens).
  await db.insert(executions).values([
    {
      agentId: legacyAgent,
      status: 'completed',
      startedAt: at('2026-08-01T00:00:00Z'),
      endedAt: at('2026-08-01T01:00:00Z'),
      usage: snapshot(100, 0, 0.01),
      flowContext: { workStreamId, attemptId: 2, stepId: 'implement' },
    },
    {
      agentId: legacyAgent,
      status: 'completed',
      startedAt: at('2026-08-02T00:00:00Z'),
      endedAt: at('2026-08-02T01:00:00Z'),
      usage: snapshot(400, 50, 0.045),
    },
    {
      agentId: legacyAgent,
      status: 'completed',
      startedAt: at('2026-08-03T00:00:00Z'),
      endedAt: at('2026-08-03T01:00:00Z'),
      usage: snapshot(800, 100, 0.09),
    },
    // Rows with their own delta.
    {
      agentId: deltaAgent,
      status: 'completed',
      startedAt: at('2026-08-05T00:00:00Z'),
      endedAt: at('2026-08-05T01:00:00Z'),
      usage: snapshot(60, 0, 0.06, { input: 60, output: 0, cost: 0.06 }),
    },
    // Ended after the ledger went live: recorded live, not imported.
    {
      agentId: deltaAgent,
      status: 'completed',
      startedAt: at('2026-09-02T00:00:00Z'),
      endedAt: at('2026-09-02T01:00:00Z'),
      usage: snapshot(70, 0, 0.07, { input: 10, output: 0, cost: 0.01 }),
    },
  ])
  // An agent with live ledger rows gets no session-gap row.
  await db
    .insert(inferenceUsage)
    .values({ feature: 'agent-turn', agentId: liveAgent, inputTokens: 1, occurredAt: cutoff })
  await db.insert(decisionLog).values([
    {
      purpose: decisionPurpose,
      outcome: 'answered',
      providerId: 'gone-provider',
      model: 'jev-latest',
      latencyMs: 5,
      inputTokens: 1000,
      costNanodollars: 42_000,
      inputSha256: 'x',
      source: { kind: 'github', agentId: legacyAgent },
      createdAt: at('2026-08-10T00:00:00Z'),
    },
    {
      purpose: decisionPurpose,
      outcome: 'unavailable',
      latencyMs: 5,
      inputSha256: 'y',
      createdAt: at('2026-08-10T00:00:00Z'),
    },
    {
      purpose: decisionPurpose,
      outcome: 'answered',
      providerId: 'gone-provider',
      model: 'jev-latest',
      latencyMs: 5,
      inputTokens: 5,
      costNanodollars: 1,
      inputSha256: 'z',
      createdAt: at('2026-09-05T00:00:00Z'), // after the cutoff: recorded live
    },
  ])
})

afterAll(async () => {
  const ids = [legacyAgent, deltaAgent, liveAgent]
  await db.delete(inferenceUsageDaily).where(inArray(inferenceUsageDaily.agentId, ids))
  await db
    .delete(inferenceUsage)
    .where(or(inArray(inferenceUsage.agentId, ids), like(inferenceUsage.feature, `decision:${decisionPurpose}`)))
  await db.delete(decisionLog).where(eq(decisionLog.purpose, decisionPurpose))
  await db.delete(executions).where(inArray(executions.agentId, ids))
  await db.delete(agents).where(inArray(agents.id, ids))
  await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
})

const ledgerRows = () =>
  db
    .select()
    .from(inferenceUsage)
    .where(
      or(
        inArray(inferenceUsage.agentId, [legacyAgent, deltaAgent, liveAgent]),
        like(inferenceUsage.feature, `decision:${decisionPurpose}`)
      )
    )

describe('backfillInferenceUsage', () => {
  test('a dry run counts and writes nothing', async () => {
    const summary = await backfillInferenceUsage({ apply: false, cutoff })
    expect(summary.inserted).toBe(0)
    expect((await ledgerRows()).filter((row) => row.dedupeKey)).toHaveLength(0)
  })

  test('imports execution deltas, session gaps and decision costs once, however often it runs', async () => {
    await backfillInferenceUsage({ apply: true, cutoff })
    const first = await ledgerRows()
    await backfillInferenceUsage({ apply: true, cutoff })
    const second = await ledgerRows()
    expect(second).toHaveLength(first.length)

    const backfilled = second.filter((row) => row.dedupeKey)
    const legacy = backfilled
      .filter((row) => row.agentId === legacyAgent && row.dedupeKey?.startsWith('exec:'))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    // Steps of the cumulative series: 100, 350 (+50 out), 400 (+50 out). The session's cost is pi's list-price
    // estimate, whatever account ran it: kept as the list cost, never billed.
    expect(
      legacy.map((row) => [row.inputTokens, row.outputTokens, row.costNanodollars, row.listCostNanodollars])
    ).toEqual([
      [100, 0, 0, 10_000_000],
      [300, 50, 0, 35_000_000],
      [400, 50, 0, 45_000_000],
    ])
    expect(legacy[0]).toMatchObject({
      feature: 'agent-turn',
      provider: null,
      model: null,
      billing: 'unknown',
      costEstimated: true,
      workStreamId,
      attemptId: 2,
      stepId: 'implement',
      source: { backfilled: true, from: 'executions' },
    })

    const gap = backfilled.find((row) => row.dedupeKey === `agent-gap:${legacyAgent}`)
    expect(gap).toMatchObject({
      inputTokens: 700,
      outputTokens: 300,
      billing: 'unknown',
      costNanodollars: 0,
      listCostNanodollars: 210_000_000,
      source: { from: 'agents.session_usage' },
    })

    const delta = backfilled.filter((row) => row.agentId === deltaAgent)
    // Only the pre-cutoff execution; its session total is fully explained by it.
    expect(delta.map((row) => row.dedupeKey?.split(':')[0])).toEqual(['exec'])
    expect(delta[0]).toMatchObject({ inputTokens: 60, costNanodollars: 0, listCostNanodollars: 60_000_000 })

    expect(backfilled.filter((row) => row.agentId === liveAgent)).toHaveLength(0)

    const decisions = backfilled.filter((row) => row.feature === `decision:${decisionPurpose}`)
    expect(decisions).toHaveLength(1)
    // A decision call's billing is known from its provider, so it still bills.
    expect(decisions[0]).toMatchObject({
      accountId: 'gone-provider',
      provider: null,
      model: 'jev-latest',
      billing: 'api',
      inputTokens: 1000,
      costNanodollars: 42_000,
      listCostNanodollars: 42_000,
      agentId: legacyAgent,
      source: { backfilled: true, from: 'decision_log' },
    })
  })

  test('re-running after its days were pruned writes nothing and leaves totals unchanged', async () => {
    const prior = await db.select().from(settings).where(eq(settings.key, PRUNED_BEFORE_KEY))
    await db.delete(settings).where(eq(settings.key, PRUNED_BEFORE_KEY))
    try {
      await backfillInferenceUsage({ apply: true, cutoff })
      // Prune August 1–20 (a 30-day window as of September 20).
      await pruneInferenceUsage({ now: at('2026-09-20T00:00:00Z'), retentionDays: 30 })
      const august = { from: at('2026-08-01T00:00:00Z'), to: at('2026-09-01T00:00:00Z') }
      const before = await spendSummary(august, { agentId: legacyAgent })
      expect(before.totals.calls).toBe(5) // three executions, the session gap, the decision
      // Only the decision bills; the agent turns count at list price only.
      expect(before.totals.billedUsd).toBeCloseTo(0.000042, 9)
      expect(before.totals.listUsd).toBeCloseTo(0.3 + 0.000042, 9)

      const again = await backfillInferenceUsage({ apply: true, cutoff })
      expect(again.inserted).toBe(0)
      expect(again.skippedPruned).toBeGreaterThan(0)
      await pruneInferenceUsage({ now: at('2026-09-20T00:00:00Z'), retentionDays: 30 })
      const after = await spendSummary(august, { agentId: legacyAgent })
      expect(after.totals).toEqual(before.totals)
      expect(after.series).toEqual(before.series)
    } finally {
      await db.delete(settings).where(eq(settings.key, PRUNED_BEFORE_KEY))
      if (prior.length) await db.insert(settings).values(prior)
    }
  })
})
