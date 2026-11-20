import { describe, expect, it } from 'bun:test'
import { WatchStateTracker, summarizeWatchConfig, watchConfigHash } from './watch-status-log'

describe('summarizeWatchConfig', () => {
  const include = Array.from({ length: 160 }, (_, i) => `docs/area-${i}/**/*.md`)
  const config = { include, exclude: ['**/drafts/**', '**/tmp/**'], squadId: 'squad-1' }

  it('reports counts and a short hash instead of the pattern lists', () => {
    const summary = summarizeWatchConfig(config)
    expect(summary).toMatch(/^include=160 exclude=2 hash=[0-9a-f]{12}$/)
    expect(summary).not.toContain('docs/area-')
    expect(summary).not.toContain('drafts')
  })

  it('gives the same hash for the same config and a different one when any decisive field changes', () => {
    const hash = watchConfigHash(config)
    expect(watchConfigHash({ ...config, include: [...include] })).toBe(hash)
    expect(watchConfigHash({ ...config, include: include.slice(1) })).not.toBe(hash)
    expect(watchConfigHash({ ...config, exclude: [] })).not.toBe(hash)
    expect(watchConfigHash({ ...config, squadId: 'squad-2' })).not.toBe(hash)
  })

  it('ignores fields outside include, exclude and squadId, so a callback URL never shapes the line', () => {
    expect(summarizeWatchConfig({ ...config, coreCallbackUrl: 'https://core.example/cb?token=abc' } as any)).toBe(
      summarizeWatchConfig(config)
    )
  })

  it('handles a missing or malformed config', () => {
    expect(summarizeWatchConfig(null)).toBe('none')
    expect(summarizeWatchConfig(undefined)).toBe('none')
    expect(summarizeWatchConfig({ include: 'not-a-list' } as any)).toMatch(/^include=0 exclude=0 hash=/)
  })
})

describe('WatchStateTracker', () => {
  it('reports a change on first sight and on every later change, but not on a repeat', () => {
    const tracker = new WatchStateTracker()
    expect(tracker.changed('a', 'one')).toBe(true)
    expect(tracker.changed('a', 'one')).toBe(false)
    expect(tracker.changed('a', 'one')).toBe(false)
    expect(tracker.changed('a', 'two')).toBe(true)
    expect(tracker.changed('a', 'one')).toBe(true)
  })

  it('keeps keys independent', () => {
    const tracker = new WatchStateTracker()
    expect(tracker.changed('a', 'same')).toBe(true)
    expect(tracker.changed('b', 'same')).toBe(true)
    expect(tracker.changed('a', 'same')).toBe(false)
  })

  it('set records a state silently, and forget makes the next sighting a change again', () => {
    const tracker = new WatchStateTracker()
    tracker.set('a', 'expected')
    expect(tracker.changed('a', 'expected')).toBe(false)
    tracker.forget('a')
    expect(tracker.changed('a', 'expected')).toBe(true)
  })
})
