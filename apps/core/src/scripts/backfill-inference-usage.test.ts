import { describe, expect, test } from 'bun:test'
import { runInferenceUsageBackfillCli } from './backfill-inference-usage'

const summary = {
  cutoff: '2026-10-15T00:00:00.000Z',
  agentsScanned: 3,
  executionRows: 5,
  sessionGapRows: 1,
  decisionRows: 2,
  inserted: 8,
  skippedPruned: 0,
}

describe('usage:ledger-backfill', () => {
  test('a dry run by default; --apply writes, scoped like usage:backfill', async () => {
    const calls: unknown[] = []
    const lines: string[] = []
    const run = async (options: unknown) => {
      calls.push(options)
      return summary
    }
    const squad = '11111111-1111-4111-8111-111111111111'
    expect(await runInferenceUsageBackfillCli([], run, (line) => lines.push(line))).toBe(0)
    expect(await runInferenceUsageBackfillCli(['--squad', squad, '--apply'], run, (line) => lines.push(line))).toBe(0)
    expect(calls).toEqual([{ apply: false }, { apply: true, squadId: squad }])
    expect(lines[0]).toContain('Would write up to 8 ledger row(s)')
    expect(lines[1]).toBe('Re-run with --apply to write.')
    expect(lines[2]).toContain('Wrote 8 new ledger row(s) of 8 found')
  })

  test('rejects unknown arguments with the usage text', async () => {
    const lines: string[] = []
    expect(
      await runInferenceUsageBackfillCli(
        ['--nope'],
        async () => summary,
        (line) => lines.push(line)
      )
    ).toBe(1)
    expect(lines[0]).toContain('Usage: bun usage:ledger-backfill')
  })
})
