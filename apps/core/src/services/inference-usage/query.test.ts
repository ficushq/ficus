import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, inferenceUsage, inferenceUsageDaily } from '../../db'
import type { AccountStoreV1 } from '../agent/account-store'
import { detailCutoff, spendBreakdown, spendSummary } from './query'

// Fixed clock: 2026-09-20 12:00 UTC, 180-day retention, so detail rows start 2026-03-24.
const now = new Date('2026-09-20T12:00:00Z')
const retentionDays = 180
const squadA = crypto.randomUUID()
const squadB = crypto.randomUUID()
let marker: string

const store = (): AccountStoreV1 => ({
  version: 1,
  accounts: {
    'openai-codex': [
      {
        id: `acc_${marker}`,
        label: 'Work ChatGPT',
        enabled: true,
        credential: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } as never,
        createdAt: Date.parse('2026-01-01T00:00:00Z'),
        subscription: { plan: 'pro', planSource: 'detected', detectedPlan: 'pro' },
      },
    ],
    anthropic: [
      {
        id: `cc_${marker}`,
        label: 'Claude Code',
        enabled: true,
        kind: 'claude-code',
        credential: { type: 'api_key', key: 'x' } as never,
        createdAt: Date.parse('2026-01-01T00:00:00Z'),
        subscription: { detectedPlan: 'max' },
      },
    ],
  },
})

// As if pruning had run up to the 180-day cutoff.
const options = () => ({ now, retentionDays, store: store(), prunedBefore: '2026-03-24' })
const september = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') }

beforeEach(async () => {
  marker = crypto.randomUUID().slice(0, 8)
  await db.insert(inferenceUsage).values([
    {
      occurredAt: new Date('2026-09-20T08:00:00Z'),
      feature: 'agent-turn',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      billing: 'api',
      inputTokens: 1000,
      costNanodollars: 3_000_000_000,
      listCostNanodollars: 3_000_000_000,
      squadId: squadA,
      source: { marker },
    },
    {
      occurredAt: new Date('2026-09-19T08:00:00Z'),
      feature: 'agent-turn',
      provider: 'anthropic',
      model: 'claude-opus-4-5',
      billing: 'api',
      outputTokens: 500,
      costNanodollars: 1_000_000_000,
      listCostNanodollars: 1_000_000_000,
      squadId: squadA,
      source: { marker },
    },
    {
      occurredAt: new Date('2026-09-19T09:00:00Z'),
      feature: 'agent-turn',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      accountId: `acc_${marker}`,
      billing: 'subscription',
      inputTokens: 2000,
      costNanodollars: 0,
      listCostNanodollars: 5_000_000_000,
      squadId: squadB,
      source: { marker },
    },
  ])
  // A rolled-up day before the retention window, and a stale rollup row inside it that must be ignored.
  await db.insert(inferenceUsageDaily).values([
    {
      day: '2026-02-10',
      feature: 'agent-turn',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      billing: 'api',
      squadId: squadA,
      calls: 7,
      inputTokens: 70,
      costNanodollars: 2_000_000_000,
      listCostNanodollars: 2_000_000_000,
    },
    {
      day: '2026-09-19',
      feature: 'agent-turn',
      billing: 'api',
      squadId: squadA,
      calls: 99,
      costNanodollars: 99_000_000_000,
    },
  ])
})

afterEach(async () => {
  await db.delete(inferenceUsage).where(inArray(inferenceUsage.squadId, [squadA, squadB]))
  await db.delete(inferenceUsageDaily).where(inArray(inferenceUsageDaily.squadId, [squadA, squadB]))
})

describe('spend queries', () => {
  test('the retention cutoff is a whole UTC day', () => {
    expect(detailCutoff(now, 180).toISOString()).toBe('2026-03-24T00:00:00.000Z')
  })

  test('inside the retention window only per-call rows count, never rollups', async () => {
    const summary = await spendSummary(september, { squadId: squadA }, options())
    expect(summary.totals).toMatchObject({ calls: 2, billedUsd: 4, listUsd: 4, inputTokens: 1000, outputTokens: 500 })
    expect(summary.series).toEqual([
      { day: '2026-09-19', billedUsd: 1, listUsd: 1, calls: 1, tokens: 500 },
      { day: '2026-09-20', billedUsd: 3, listUsd: 3, calls: 1, tokens: 1000 },
    ])
    // A squad filter is a slice of the calls: subscription fees cannot be split by it.
    expect(summary.subscriptions).toEqual([])
    expect(summary.meta).toMatchObject({ retentionDays: 180, feesIncluded: false })
  })

  test('before the retention window, daily rollups answer', async () => {
    const summary = await spendSummary(
      { from: new Date('2026-02-01T00:00:00Z'), to: new Date('2026-09-21T00:00:00Z') },
      { squadId: squadA },
      options()
    )
    expect(summary.totals).toMatchObject({ calls: 9, billedUsd: 6 })
    expect(summary.series[0]).toEqual({ day: '2026-02-10', billedUsd: 2, listUsd: 2, calls: 7, tokens: 70 })
  })

  test('subscription calls bill nothing, fees are line items, and the preview prices every call', async () => {
    const summary = await spendSummary(september, { accountId: `openai-codex/acc_${marker}` }, options())
    expect(summary.totals).toMatchObject({
      calls: 1,
      billedUsd: 0,
      listUsd: 5,
      subscriptionFeesUsd: 133.33,
      totalUsd: 133.33,
    })
    expect(summary.subscriptions).toEqual([
      expect.objectContaining({
        provider: 'openai-codex',
        accountId: `acc_${marker}`,
        plan: 'pro',
        planLabel: 'ChatGPT Pro',
        monthlyPriceUsd: 200,
        priceSource: 'default',
        needsChoice: false,
        // September up to and including today (20 of 30 days); the rest has not happened yet.
        feeUsd: Math.round(((200 * 20) / 30) * 100) / 100,
        calls: 1,
        listUsd: 5,
      }),
    ])
  })

  test('an unknown plan is listed for a choice and counts no fee', async () => {
    const summary = await spendSummary(september, { provider: 'anthropic' }, options())
    const claudeCode = summary.subscriptions.find((line) => line.accountId === `cc_${marker}`)
    expect(claudeCode).toMatchObject({ plan: null, detectedPlan: 'max', needsChoice: true, feeUsd: 0 })
  })

  test('breaks spend down by one or two dimensions with labels', async () => {
    const byModel = await spendBreakdown(september, { squadId: squadA }, 'model', undefined, 50, options())
    expect(byModel.rows.map((row) => [row.key, row.billedUsd])).toEqual([
      ['claude-sonnet-4-5', 3],
      ['claude-opus-4-5', 1],
    ])
    const twoWay = await spendBreakdown(
      september,
      { feature: 'agent-turn', squadId: undefined },
      'billing',
      'provider',
      50,
      options()
    )
    const mine = twoWay.rows.filter((row) => row.key === 'subscription' && row.key2 === 'openai-codex')
    expect(mine[0]).toMatchObject({ label: 'Subscription', label2: 'OpenAI Codex' })

    const limited = await spendBreakdown(september, { squadId: squadA }, 'model', undefined, 1, options())
    expect(limited.rows).toHaveLength(1)
    expect(limited.truncated).toBe(true)

    const bySquad = await spendBreakdown(september, { model: 'gpt-5.5' }, 'squad', undefined, 50, options())
    expect(bySquad.rows.find((row) => row.key === squadB)?.label).toBe(`Deleted (${squadB.slice(0, 8)})`)
  })

  test('the account filter matches provider and id', async () => {
    const other = await spendSummary(september, { accountId: `anthropic/acc_${marker}` }, options())
    expect(other.totals.calls).toBe(0)
    await db.delete(inferenceUsage).where(eq(inferenceUsage.squadId, squadB))
  })
})
