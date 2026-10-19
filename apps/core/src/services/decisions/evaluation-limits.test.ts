import { expect, test } from 'bun:test'
import { createEvaluationLimiter } from './evaluation-limits'

test('evaluation slots bound concurrency, release idempotently, and count failed calls against the rate', () => {
  let now = 0
  const acquire = createEvaluationLimiter(() => now)
  const slots = Array.from({ length: 4 }, () => acquire('agent:one'))
  expect(slots.every(Boolean)).toBe(true)
  expect(acquire('agent:one')).toBeNull()
  slots[0]!()
  slots[0]!()
  const next = acquire('agent:one')
  expect(next).not.toBeNull()
  expect(acquire('agent:one')).toBeNull()
  for (const release of slots) release!()
  next!()
  for (let i = 5; i < 60; i++) acquire('agent:one')!()
  expect(acquire('agent:one')).toBeNull()
  expect(acquire('agent:two')).not.toBeNull()
  now = 60_000
  expect(acquire('agent:one')).not.toBeNull()
})

test('a minute rollover cannot free requests that are still in flight', () => {
  let now = 0
  const acquire = createEvaluationLimiter(() => now)
  const slots = Array.from({ length: 4 }, () => acquire('actor'))
  now = 60_001
  expect(acquire('actor')).toBeNull()
  slots[0]!()
  expect(acquire('actor')).not.toBeNull()
})
