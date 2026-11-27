import { expect, test } from 'bun:test'
import {
  DEFAULT_EXECUTION_REQUEUE_LIMIT,
  ExecutionRequeueLimitError,
  executionRequeueLimit,
  requeueLimitNotice,
  requeueLimitReached,
} from './requeue-limit'

test('the requeue limit defaults to 5 and accepts a non-negative integer override', () => {
  expect(DEFAULT_EXECUTION_REQUEUE_LIMIT).toBe(5)
  expect(executionRequeueLimit(undefined)).toBe(5)
  expect(executionRequeueLimit('')).toBe(5)
  expect(executionRequeueLimit(' 3 ')).toBe(3)
  expect(executionRequeueLimit('0')).toBe(0)
  for (const invalid of ['-1', '2.5', 'five', '1e3', 'Infinity']) expect(executionRequeueLimit(invalid)).toBe(5)
})

test('the cap trips at the limit, and a limit of 0 turns it off', () => {
  expect(requeueLimitReached(4, 5)).toBe(false)
  expect(requeueLimitReached(5, 5)).toBe(true)
  expect(requeueLimitReached(6, 5)).toBe(true)
  expect(requeueLimitReached(1, 1)).toBe(true)
  expect(requeueLimitReached(100, 0)).toBe(false)
})

test('the notice and the recorded failure name the count and the cause on one line', () => {
  expect(requeueLimitNotice(5, 'lease_lapsed')).toContain('interrupted 5 times')
  expect(requeueLimitNotice(5, 'lease_lapsed')).toContain('admission lease lapsed')
  expect(requeueLimitNotice(5, 'core_restart')).toContain('unknown cause')
  expect(requeueLimitNotice(5, 'core_restart')).toContain('will not resume automatically')
  const error = new ExecutionRequeueLimitError(5, 'core_restart')
  expect(error.message).toBe(
    'The execution was interrupted 5 times without finishing, most recently because an interruption of unknown cause, so it was not resumed again.'
  )
  expect(error.message).not.toContain('\n')
  expect(error.message.length).toBeLessThanOrEqual(240)
})
