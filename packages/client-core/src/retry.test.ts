import { describe, expect, test } from 'bun:test'
import { HttpResponseError } from './errors'
import {
  BUSY_RETRY_DEFAULT_MS,
  BUSY_RETRY_LIMIT,
  BUSY_RETRY_MAX_MS,
  BUSY_RETRY_MIN_MS,
  parseRetryAfter,
  QUERY_RETRY_LIMIT,
  queryRetryDelay,
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
