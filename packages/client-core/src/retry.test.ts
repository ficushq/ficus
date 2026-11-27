import { describe, expect, test } from 'bun:test'
import { HttpResponseError } from './errors'
import {
  BUSY_RETRY_DEFAULT_MS,
  BUSY_RETRY_LIMIT,
  BUSY_RETRY_MAX_MS,
  BUSY_RETRY_MIN_MS,
  isSandboxProvisioningFailure,
  parseRetryAfter,
  QUERY_RETRY_LIMIT,
  queryRetryDelay,
  SANDBOX_PROVISION_RETRY_LIMIT,
  SANDBOX_PROVISION_RETRY_MAX_MS,
  shouldRetryQuery,
} from './retry'

const busy = (retryAfterMs?: number) => new HttpResponseError(503, 'Ficus is busy', retryAfterMs)
const retries = (error: unknown) => {
  let count = 0
  while (shouldRetryQuery(count, error)) count++
  return count
}

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-27T12:00:00.000Z')

  test('reads delta-seconds and HTTP dates as milliseconds from now', () => {
    expect(parseRetryAfter('5', now)).toBe(5_000)
    expect(parseRetryAfter(' 0 ', now)).toBe(0)
    expect(parseRetryAfter('Fri, 27 Nov 2026 12:00:30 GMT', now)).toBe(30_000)
    expect(parseRetryAfter('Fri, 27 Nov 2026 11:59:00 GMT', now)).toBe(0)
  })

  test('ignores a missing or unreadable value', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined()
    expect(parseRetryAfter('', now)).toBeUndefined()
    expect(parseRetryAfter('-5', now)).toBeUndefined()
    expect(parseRetryAfter('soon', now)).toBeUndefined()
  })
})

describe('query retry policy', () => {
  test('ordinary failures keep three retries with the usual backoff', () => {
    for (const error of [new Error('offline'), new HttpResponseError(500, 'boom'), { status: 502 }])
      expect(retries(error)).toBe(QUERY_RETRY_LIMIT)
    expect([0, 1, 2, 5].map((count) => queryRetryDelay(count, new Error('offline')))).toEqual([
      1_000, 2_000, 4_000, 30_000,
    ])
  })

  test('a 503 waits for Retry-After, doubles it, and retries at most twice', () => {
    expect(retries(busy(5_000))).toBe(BUSY_RETRY_LIMIT)
    expect(queryRetryDelay(0, busy(5_000), () => 0)).toBe(5_000)
    expect(queryRetryDelay(1, busy(5_000), () => 0)).toBe(10_000)
    // Jitter only ever adds to what the server asked for.
    expect(queryRetryDelay(0, busy(5_000), () => 1)).toBe(5_500)
    // Either error shape the apps throw: a status and the parsed Retry-After.
    expect(queryRetryDelay(0, { status: 503, retryAfterMs: 8_000 }, () => 0)).toBe(8_000)
  })

  test('a 503 never retries immediately', () => {
    expect(queryRetryDelay(0, busy(0), () => 0)).toBe(BUSY_RETRY_MIN_MS)
    expect(queryRetryDelay(0, busy(), () => 0)).toBe(BUSY_RETRY_DEFAULT_MS)
  })

  test('the backoff is bounded: a longer wait than the bound stops retrying', () => {
    expect(retries(busy(40_000))).toBe(1)
    expect(queryRetryDelay(0, busy(40_000), () => 0)).toBe(40_000)
    expect(retries(busy(BUSY_RETRY_MAX_MS + 1_000))).toBe(0)
    expect(queryRetryDelay(5, busy(5_000), () => 0)).toBe(BUSY_RETRY_MAX_MS)
  })
})

describe('a sandbox that cannot be provisioned yet', () => {
  // Core's answer to a workspace read while the sandbox's provisioning circuit is open: 503, a
  // SANDBOX_PROVISION_* code and the cooldown as Retry-After, which can pass the 60-second bound.
  const provisioning = (retryAfterMs?: number, code = 'SANDBOX_PROVISION_UNAVAILABLE') => ({
    status: 503,
    retryAfterMs,
    payload: { error: 'Sandbox scheduling is temporarily unavailable.', code, retryAfterMs },
  })

  test('a cooldown over a minute is waited out instead of failing at once', () => {
    expect(retries(busy(75_000))).toBe(0)
    // 75, 150 and 300 seconds: each within the five-minute bound.
    expect(retries(provisioning(75_000))).toBe(3)
    expect(queryRetryDelay(0, provisioning(75_000), () => 0)).toBe(75_000)
    expect(queryRetryDelay(1, provisioning(75_000), () => 0)).toBe(150_000)
  })

  test('shorter cooldowns retry more often, still bounded', () => {
    expect(retries(provisioning(5_000))).toBe(SANDBOX_PROVISION_RETRY_LIMIT)
    expect(retries(provisioning(SANDBOX_PROVISION_RETRY_MAX_MS + 1_000))).toBe(0)
    expect(queryRetryDelay(10, provisioning(5_000), () => 0)).toBe(SANDBOX_PROVISION_RETRY_MAX_MS)
  })

  test('a provisioning that failed keeps the ordinary 503 rule', () => {
    // Core sends SANDBOX_PROVISION_FAILED with a 10-second Retry-After when a box cannot be provisioned.
    const failed = provisioning(10_000, 'SANDBOX_PROVISION_FAILED')
    expect(isSandboxProvisioningFailure(failed)).toBe(false)
    expect(retries(failed)).toBe(retries(busy(10_000)))
    expect(retries(failed)).toBe(BUSY_RETRY_LIMIT)
    for (const count of [0, 1]) expect(queryRetryDelay(count, failed, () => 0)).toBe(10_000 * 2 ** count)
    // Over a minute, it gives up at once, as any other busy read does.
    expect(retries(provisioning(75_000, 'SANDBOX_PROVISION_FAILED'))).toBe(0)
  })

  test('every "not ready yet" code gets the longer wait', () => {
    for (const code of [
      'SANDBOX_PROVISION_BUSY',
      'SANDBOX_PROVISION_COORDINATION_UNAVAILABLE',
      'SANDBOX_PROVISION_UNAVAILABLE',
    ])
      expect(retries(provisioning(75_000, code))).toBe(3)
  })

  test('the code is read from the error itself or from the response body', () => {
    expect(isSandboxProvisioningFailure(provisioning(75_000))).toBe(true)
    expect(isSandboxProvisioningFailure({ status: 503, code: 'SANDBOX_PROVISION_BUSY' })).toBe(true)
    // Any other 503 (a read deadline), or the code on another status, is not provisioning.
    expect(isSandboxProvisioningFailure(provisioning(5_000, 'read_deadline_exceeded'))).toBe(false)
    expect(isSandboxProvisioningFailure(busy(75_000))).toBe(false)
    expect(isSandboxProvisioningFailure({ ...provisioning(5_000), status: 500 })).toBe(false)
    expect(isSandboxProvisioningFailure(new Error('offline'))).toBe(false)
    expect(isSandboxProvisioningFailure(null)).toBe(false)
  })
})
