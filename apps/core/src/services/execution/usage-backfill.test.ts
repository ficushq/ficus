import { describe, test, expect } from 'bun:test'
import type { SessionUsage } from '@ficus/shared'
import { planAgentUsageBackfill, UsageBackfillOrderError, type UsageBackfillRow } from './usage-backfill'
import { parseUsageBackfillArgs, runUsageBackfillCli } from '../../scripts/backfill-execution-usage'

function snapshot(total: number, cost: number, delta?: { total: number; cost: number }): SessionUsage {
  return {
    stats: {
      userMessages: 1,
      assistantMessages: 1,
      totalMessages: 2,
      tokens: { input: total / 10, output: total / 10, cacheRead: total * 0.8, cacheWrite: 0, total },
      cost,
    },
    context: null,
    ...(delta
      ? {
          delta: {
            tokens: {
              input: delta.total / 10,
              output: delta.total / 10,
              cacheRead: delta.total * 0.8,
              cacheWrite: 0,
              total: delta.total,
            },
            cost: delta.cost,
          },
        }
      : {}),
  }
}

const rows = (...usages: Array<SessionUsage | null>): UsageBackfillRow[] =>
  usages.map((usage, index) => ({
    id: `e${index}`,
    usage,
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)), // strictly increasing
  }))

describe('planAgentUsageBackfill', () => {
  test('turns a cumulative series into per-execution steps that sum to the final total', () => {
    const updates = planAgentUsageBackfill(rows(snapshot(100, 1), snapshot(450, 4.5), snapshot(900, 9)))
    expect(updates.map((u) => u.usage.delta!.tokens.total)).toEqual([100, 350, 450])
    expect(updates.reduce((sum, u) => sum + u.usage.delta!.tokens.total, 0)).toBe(900)
    expect(updates.map((u) => Number(u.usage.delta!.cost.toFixed(2)))).toEqual([1, 3.5, 4.5])
  })

  test('preserves the cumulative stats it was given', () => {
    const updates = planAgentUsageBackfill(rows(snapshot(100, 1), snapshot(450, 4.5)))
    expect(updates[1]!.usage.stats.tokens.total).toBe(450)
    expect(updates[1]!.usage.context).toBeNull()
  })

  test('starts a new series when a snapshot drops below its predecessor (session reset)', () => {
    const updates = planAgentUsageBackfill(rows(snapshot(900, 9), snapshot(200, 2), snapshot(500, 5)))
    // The reset row keeps its whole snapshot rather than producing a negative step.
    expect(updates.map((u) => u.usage.delta!.tokens.total)).toEqual([900, 200, 300])
  })

  test('skips executions with no usage without breaking the series', () => {
    const updates = planAgentUsageBackfill(rows(snapshot(100, 1), null, snapshot(450, 4.5)))
    expect(updates).toHaveLength(2)
    expect(updates.map((u) => u.usage.delta!.tokens.total)).toEqual([100, 350])
  })

  test('is idempotent: rows that already carry a delta are left alone but still anchor the series', () => {
    const updates = planAgentUsageBackfill(
      rows(snapshot(100, 1, { total: 100, cost: 1 }), snapshot(450, 4.5), snapshot(900, 9))
    )
    expect(updates.map((u) => u.id)).toEqual(['e1', 'e2'])
    expect(updates.map((u) => u.usage.delta!.tokens.total)).toEqual([350, 450])
  })

  test('a fully backfilled agent plans no writes', () => {
    const updates = planAgentUsageBackfill(
      rows(snapshot(100, 1, { total: 100, cost: 1 }), snapshot(450, 4.5, { total: 350, cost: 3.5 }))
    )
    expect(updates).toEqual([])
  })

  test('no rows is not an error', () => {
    expect(planAgentUsageBackfill([])).toEqual([])
  })
})

describe('ordering contract', () => {
  const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s))
  const row = (id: string, startedAt: Date, usage: SessionUsage | null): UsageBackfillRow => ({ id, usage, startedAt })

  test('rows out of execution order throw instead of planning plausible wrong deltas', () => {
    // A row whose startedAt goes backwards: the query's ORDER BY would never
    // produce this, and without the guard the lower snapshot would silently be
    // planned as a session-reset series instead of being rejected.
    const outOfOrder = [row('e0', t(1), snapshot(450, 4.5)), row('e1', t(0), snapshot(100, 1))]
    expect(() => planAgentUsageBackfill(outOfOrder)).toThrow(UsageBackfillOrderError)
  })

  test('equal startedAt with descending ids throws (tiebreaker order)', () => {
    expect(() =>
      planAgentUsageBackfill([row('b', t(0), snapshot(100, 1)), row('a', t(0), snapshot(450, 4.5))])
    ).toThrow(UsageBackfillOrderError)
  })

  test('equal startedAt with increasing id is valid (query tiebreaker order)', () => {
    const updates = planAgentUsageBackfill([row('a', t(0), snapshot(100, 1)), row('b', t(0), snapshot(450, 4.5))])
    expect(updates.map((u) => u.usage.delta!.tokens.total)).toEqual([100, 350])
  })

  test('duplicate ids throw', () => {
    expect(() =>
      planAgentUsageBackfill([row('e0', t(0), snapshot(100, 1)), row('e0', t(1), snapshot(450, 4.5))])
    ).toThrow(UsageBackfillOrderError)
  })

  test('the error names the offending row', () => {
    let message = ''
    try {
      planAgentUsageBackfill([row('e0', t(5), snapshot(450, 4.5)), row('e1', t(1), snapshot(100, 1))])
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('e1')
  })
})

describe('backfill CLI', () => {
  test('defaults to a dry run and accepts scoping flags', () => {
    const squad = '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b'
    expect(parseUsageBackfillArgs([])).toEqual({ agentIds: [], apply: false })
    expect(parseUsageBackfillArgs(['--squad', squad, '--apply'])).toEqual({
      squadId: squad,
      agentIds: [],
      apply: true,
    })
    expect(parseUsageBackfillArgs(['--agent', squad, '--agent', squad]).agentIds).toHaveLength(2)
  })

  test('rejects malformed input rather than scanning everything by accident', () => {
    expect(() => parseUsageBackfillArgs(['--squad', 'not-a-uuid'])).toThrow(/Usage:/)
    expect(() => parseUsageBackfillArgs(['--squad'])).toThrow(/Usage:/)
    expect(() => parseUsageBackfillArgs(['--nope', 'x'])).toThrow(/Usage:/)
    expect(() =>
      parseUsageBackfillArgs([
        '--squad',
        '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b',
        '--agent',
        '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b',
      ])
    ).toThrow(/mutually exclusive/)
  })

  test('a dry run says it wrote nothing and points at --apply', async () => {
    const lines: string[] = []
    let received: { apply: boolean } | null = null
    const code = await runUsageBackfillCli(
      [],
      async (options) => {
        received = options
        return { agentsScanned: 3, executionsScanned: 40, executionsUpdated: 12 }
      },
      (line) => lines.push(line)
    )
    expect(code).toBe(0)
    expect(received!.apply).toBe(false)
    expect(lines[0]).toContain('Would backfill 12 execution(s)')
    expect(lines[1]).toContain('--apply')
  })

  test('--apply reports the write and does not suggest a re-run', async () => {
    const lines: string[] = []
    const code = await runUsageBackfillCli(
      ['--apply'],
      async () => ({ agentsScanned: 1, executionsScanned: 5, executionsUpdated: 5 }),
      (line) => lines.push(line)
    )
    expect(code).toBe(0)
    expect(lines[0]).toContain('Backfilled 5 execution(s)')
    expect(lines).toHaveLength(1)
  })
})
