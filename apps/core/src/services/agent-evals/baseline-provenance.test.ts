import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { allCalls } from './define'
import type { RecordedRun } from './run'

// These are original, unmodified delivery-cohort bytes, not corrected-harness live evidence.
const sources = {
  '2026-11-19-17-06-49.json': 'df2e0ef4819e790b48320c61c27e1cedfb7701e6f77b01f7e406b7fe8e476a1c',
  '2026-11-19-17-08-20.json': '405bd7e11080c468efc9baa520577edc86d54b1dbc1052d07c789834cab238e8',
  '2026-11-19-17-11-34.json': 'be397bae49ce9d5ddfd81819a6a27c178e28e5b5183e1bb5208390b4f392d9d8',
}
const cohorts = Object.fromEntries(
  Object.keys(sources).map((file) => [
    file,
    JSON.parse(readFileSync(join(import.meta.dir, 'recordings', file), 'utf8')).runs as RecordedRun[],
  ])
)

test('baseline diagnosis retains the exact original cohort bytes and verdicts', () => {
  for (const [file, hash] of Object.entries(sources)) {
    expect(
      createHash('sha256')
        .update(readFileSync(join(import.meta.dir, 'recordings', file)))
        .digest('hex')
    ).toBe(hash)
  }
  const identity = cohorts['2026-11-19-17-11-34.json']!.filter((run) => run.scenario === 'requester-identity')
  expect(identity).toHaveLength(12)
  expect(identity.every((run) => !run.verdict.pass)).toBe(true)
  expect(
    identity.every((run) =>
      allCalls(run.trace).some(
        (call) =>
          String(call.args.command).includes('agent messages') &&
          call.result.includes('51846fad-3980-4ec3-943c-1ebe9c822b2e')
      )
    )
  ).toBe(true)
  expect(
    identity.filter((run) =>
      allCalls(run.trace).some(
        (call) => String(call.args.command).includes('--help') && call.result.includes('Created work stream')
      )
    )
  ).toHaveLength(8)
})

test('all six fast CI failures encounter the contradictory slot commit and unsupported assembler discovery', () => {
  const ci = cohorts['2026-11-19-17-06-49.json']!.filter(
    (run) => run.scenario === 'ci-failure-rework' && run.tier === 'fast'
  )
  expect(ci).toHaveLength(6)
  for (const run of ci) {
    expect(run.verdict).toEqual({ pass: false, reason: 'Never requested rework through the flow.' })
    const calls = allCalls(run.trace)
    expect(calls.some((call) => call.result.includes('Retry slot grants after a host budget change'))).toBe(true)
    expect(
      calls.some((call) => String(call.args.command).includes('find .') && !call.result.includes('squad-agent-prompt'))
    ).toBe(true)
  }
})
