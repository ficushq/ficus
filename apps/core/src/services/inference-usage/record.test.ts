import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, inferenceUsage } from '../../db'
import type { AccountStoreV1 } from '../agent/account-store'
import type { PricedModel } from './pricing'
import {
  buildInferenceUsageRow,
  flushInferenceUsage,
  insertInferenceUsageRows,
  recordInferenceUsage,
  setInferenceUsageDepsForTest,
  setInferenceUsageSinkForTest,
} from './record'
import type { InferenceUsageEvent } from './types'
import { ensureInferenceUsageDedupeIndex } from './test-indexes'

const sonnet = {
  id: 'claude-sonnet-4-5',
  provider: 'anthropic',
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
} as unknown as PricedModel
const store: AccountStoreV1 = {
  version: 1,
  accounts: {
    anthropic: [
      {
        id: 'acc_cc',
        enabled: true,
        kind: 'claude-code',
        credential: { type: 'api_key', key: 'claude-code' },
      },
    ],
  },
}
const deps = { lookupModel: (p: string, m: string) => (p === 'anthropic' && m === sonnet.id ? sonnet : undefined), store }
const agentId = '11111111-1111-4111-8111-111111111111'

afterEach(() => {
  setInferenceUsageSinkForTest(undefined)
  setInferenceUsageDepsForTest(undefined)
})

describe('buildInferenceUsageRow', () => {
  test('classifies billing from the account and keeps the list price for subscriptions', () => {
    const row = buildInferenceUsageRow(
      {
        feature: 'agent-turn',
        provider: 'anthropic',
        model: sonnet.id,
        accountId: 'acc_cc',
        tokens: { input: 1_000_000, output: 10 },
        attribution: { agentId, squadId: 'not-a-uuid', attemptId: 3, stepId: 'implement' },
      },
      deps
    )
    expect(row.billing).toBe('subscription')
    expect(row.costNanodollars).toBe(0)
    expect(row.listCostNanodollars).toBe(3_000_150_000)
    expect(row.agentId).toBe(agentId)
    expect(row.squadId).toBeNull()
    expect(row.attemptId).toBe(3)
    expect(row.stepId).toBe('implement')
    expect(row.inputTokens).toBe(1_000_000)
  })

  test('an environment key with a known price bills api', () => {
    const row = buildInferenceUsageRow(
      { feature: 'agent-turn', provider: 'anthropic', model: sonnet.id, tokens: { input: 1_000_000 } },
      deps
    )
    expect(row.billing).toBe('api')
    expect(row.costNanodollars).toBe(3_000_000_000)
  })
})

describe('recordInferenceUsage', () => {
  test('hands events to the test sink and skips empty ones', async () => {
    const seen: InferenceUsageEvent[] = []
    setInferenceUsageSinkForTest((event) => void seen.push(event))
    recordInferenceUsage({ feature: 'agent-turn', tokens: { input: 0 } })
    recordInferenceUsage({ feature: 'transcription', units: { audioSeconds: 4 } })
    await flushInferenceUsage()
    expect(seen.map((event) => event.feature)).toEqual(['transcription'])
    expect(seen[0]!.occurredAt).toBeInstanceOf(Date)
  })

  test('never throws when the write fails', async () => {
    setInferenceUsageSinkForTest(() => {
      throw new Error('boom')
    })
    expect(() => recordInferenceUsage({ feature: 'agent-turn', tokens: { input: 5 } })).not.toThrow()
    await flushInferenceUsage()
  })

  test('writes a priced row to the ledger', async () => {
    setInferenceUsageDepsForTest(deps)
    const dedupeKey = `test:${crypto.randomUUID()}`
    recordInferenceUsage({
      feature: 'agent-turn',
      provider: 'anthropic',
      model: sonnet.id,
      tokens: { input: 1000 },
      attribution: { agentId },
      dedupeKey,
    })
    await flushInferenceUsage()
    const [row] = await db.select().from(inferenceUsage).where(eq(inferenceUsage.dedupeKey, dedupeKey))
    expect(row).toMatchObject({ feature: 'agent-turn', billing: 'api', costNanodollars: 3_000_000, agentId })
  })

  test('a dedupe key is written at most once', async () => {
    await ensureInferenceUsageDedupeIndex()
    const dedupeKey = `test:${crypto.randomUUID()}`
    const row = buildInferenceUsageRow({ feature: 'agent-turn', tokens: { input: 1 }, dedupeKey }, deps)
    expect(await insertInferenceUsageRows([row])).toBe(1)
    expect(await insertInferenceUsageRows([row])).toBe(0)
    const rows = await db.select().from(inferenceUsage).where(eq(inferenceUsage.dedupeKey, dedupeKey))
    expect(rows).toHaveLength(1)
  })
})
