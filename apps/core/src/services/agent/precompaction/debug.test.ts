import { describe, it, expect } from 'bun:test'
import { formatPrecompactionLogLine, formatPrecompactionSystemMessage, type PrecompactionLifecycleEvent } from './debug'

const baseEvent = {
  contextTokens: 160_000,
  contextWindow: 200_000,
  reserveTokens: 16_384,
  earlyMarginTokens: 24_576,
}

describe('pre-compaction debug formatting', () => {
  it('formats canonical system messages for started and succeeded events', () => {
    expect(formatPrecompactionSystemMessage({ kind: 'started', ...baseEvent })).toBe('Precompaction started')
    expect(formatPrecompactionSystemMessage({ kind: 'succeeded', ...baseEvent, elapsedMs: 1234 })).toBe(
      'Precompaction finished'
    )
  })

  it('closes failed, cancelled and superseded starts without exposing provider error text', () => {
    expect(formatPrecompactionSystemMessage({ kind: 'failed', ...baseEvent, elapsedMs: 1, error: 'timeout' })).toBe(
      'Precompaction timed out'
    )
    expect(
      formatPrecompactionSystemMessage({
        kind: 'failed',
        ...baseEvent,
        elapsedMs: 1,
        error: 'private provider details',
      })
    ).toBe('Precompaction failed')
    expect(formatPrecompactionSystemMessage({ kind: 'aborted', ...baseEvent, elapsedMs: 1 })).toBe(
      'Precompaction cancelled'
    )
    expect(formatPrecompactionSystemMessage({ kind: 'superseded', ...baseEvent, elapsedMs: 1 })).toBe(
      'Precompaction stopped — compacting now'
    )
  })

  it('returns undefined for every non-visible lifecycle event', () => {
    const events: PrecompactionLifecycleEvent[] = [
      { kind: 'consumed', firstKeptEntryId: 'keep' },
      { kind: 'rejected', reason: 'prefix' },
    ]

    for (const event of events) {
      expect(formatPrecompactionSystemMessage(event)).toBeUndefined()
    }
  })

  it('formats console log lines with threshold, elapsed, and result metadata', () => {
    const event: PrecompactionLifecycleEvent = {
      kind: 'succeeded',
      ...baseEvent,
      elapsedMs: 1234,
      result: { tokensBefore: 159_999, firstKeptEntryId: 'entry-keep' },
    }

    const line = formatPrecompactionLogLine(event)

    expect(line).toContain('Precompaction succeeded')
    expect(line).toContain('contextTokens=160000')
    expect(line).toContain('contextWindow=200000')
    expect(line).toContain('reserveTokens=16384')
    expect(line).toContain('earlyMarginTokens=24576')
    expect(line).toContain('earlyThreshold=159040')
    expect(line).toContain('elapsedMs=1234')
    expect(line).toContain('tokensBefore=159999')
    expect(line).toContain('firstKeptEntryId=entry-keep')
  })

  it('includes failure errors without requiring result metadata', () => {
    const line = formatPrecompactionLogLine({ kind: 'failed', ...baseEvent, elapsedMs: 12, error: 'boom' })

    expect(line).toContain('Precompaction failed')
    expect(line).toContain('elapsedMs=12')
    expect(line).toContain('error=boom')
    expect(line).not.toContain('tokensBefore=')
  })

  it('formats log lines for consumed and rejected', () => {
    expect(formatPrecompactionLogLine({ kind: 'consumed', firstKeptEntryId: 'keep' })).toBe(
      'Precompaction consumed firstKeptEntryId=keep'
    )
    expect(formatPrecompactionLogLine({ kind: 'rejected', reason: 'model' })).toBe(
      'Precompaction rejected reason=model'
    )
  })
})
