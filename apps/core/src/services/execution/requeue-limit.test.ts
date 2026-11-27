import { expect, spyOn, test } from 'bun:test'
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

test('a huge whole number means practically never, not the default', () => {
  expect(executionRequeueLimit('99999999999999999999999')).toBe(Number.MAX_SAFE_INTEGER)
  expect(requeueLimitReached(1_000_000, executionRequeueLimit('99999999999999999999999'))).toBe(false)
})

test('an invalid value is warned about once, not on every recovered execution', () => {
  const warn = spyOn(console, 'warn')
  const before = warn.mock.calls.length
  try {
    for (let n = 0; n < 5; n++) executionRequeueLimit('not-a-number')
    const warnings = warn.mock.calls
      .slice(before)
      .filter((call) => call.some((part) => String(part).includes("'not-a-number'")))
    expect(warnings).toHaveLength(1)
  } finally {
    warn.mockRestore()
  }
})

test('the cap trips at the limit, and a limit of 0 turns it off', () => {
  expect(requeueLimitReached(4, 5)).toBe(false)
  expect(requeueLimitReached(5, 5)).toBe(true)
  expect(requeueLimitReached(6, 5)).toBe(true)
  expect(requeueLimitReached(1, 1)).toBe(true)
  expect(requeueLimitReached(100, 0)).toBe(false)
})

test('the notice names the count and the cause', () => {
  expect(requeueLimitNotice(5, 'lease_lapsed')).toContain('cut off 5 times')
  expect(requeueLimitNotice(5, 'lease_lapsed')).toContain('stopped renewing its lease')
  expect(requeueLimitNotice(5, 'core_restart')).toContain('Core stopped unexpectedly')
  expect(requeueLimitNotice(5, 'core_restart')).toContain('will not resume automatically')
})

test('the recorded failure names the cut-off calls on one line, or says there were none', () => {
  const lead = 'The run was cut off 5 times without finishing, most recently because Core stopped unexpectedly.'
  expect(new ExecutionRequeueLimitError(5, 'core_restart', []).message).toBe(
    `${lead} It was cut off between tool calls.`
  )
  expect(new ExecutionRequeueLimitError(5, 'core_restart').message).toBe(
    `${lead} The calls it cut off could not be read.`
  )
  const calls = [
    { toolName: 'bash', repeated: true },
    { toolName: 'read' },
    { toolName: 'grep' },
    { toolName: 'write' },
    { toolName: 'edit' },
  ]
  const error = new ExecutionRequeueLimitError(5, 'core_restart', calls)
  expect(error.message).toBe(`${lead} It cut off bash (cut off before too), read, grep and 2 more.`)
  expect(error.message).not.toContain('\n')
  expect(error.message.length).toBeLessThanOrEqual(240)
})
