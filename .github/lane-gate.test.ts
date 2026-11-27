import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { validateLaneResults } from './lane-gate'

const LANES = 'test-gates,test-typecheck,test-core,test-web,rendered-checks'
const all = (result: string) => new Array(5).fill(result).join(',')

test('passes only when every lane succeeded', () => {
  expect(validateLaneResults(LANES, all('success'))).toEqual({ ok: true })
})

test('a failed lane blocks and is named', () => {
  const outcome = validateLaneResults(LANES, 'success,success,failure,success,success')
  expect(outcome.ok).toBe(false)
  expect(outcome.ok === false && outcome.reason).toBe('test-core=failure')
})

test('a lane that never ran blocks too', () => {
  // The reason the aggregator exists: absence of evidence must not read as a
  // pass. `skipped` and `cancelled` are exactly how a lane disappears when an
  // earlier job fails or a run is superseded.
  for (const result of ['skipped', 'cancelled', '']) {
    const outcome = validateLaneResults(LANES, `success,success,${result || 'x'},success,success`)
    expect(outcome.ok, `result=${result}`).toBe(false)
  }
})

test('a drifted needs list fails rather than misattributing results', () => {
  const outcome = validateLaneResults(LANES, 'success,success,success,success')
  expect(outcome.ok).toBe(false)
  expect(outcome.ok === false && outcome.reason).toContain('expected 5 lane results')
})

test('the workflow keeps `test` as an aggregator over exactly these lanes', () => {
  const workflow = readFileSync(new URL('./workflows/ci.yml', import.meta.url), 'utf8')
  // Pinned so a lane added later cannot silently escape the required check.
  expect(workflow.includes(`LANE_NAMES: ${LANES}`), 'LANE_NAMES must list every lane').toBe(true)
  expect(
    workflow.includes('needs: [test-gates, test-typecheck, test-core, test-web, rendered-checks]'),
    'the aggregator must depend on every lane'
  ).toBe(true)
  expect(workflow.includes('bun .github/lane-gate.ts verify-result'), 'the aggregator must run this gate').toBe(true)
})
