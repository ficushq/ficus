import { describe, expect, test } from 'bun:test'
import { dependencyConditionText, waitingFor } from './WorkStreamDependencies'

describe('dependencyConditionText', () => {
  test('says which condition an edge waits on and whether it is satisfied', () => {
    expect(dependencyConditionText(undefined)).toBeNull()
    expect(dependencyConditionText({ workStreamId: 'a', condition: 'done', satisfied: false })).toBe(
      'Waits until it is done'
    )
    expect(dependencyConditionText({ workStreamId: 'a', condition: 'done', satisfied: true })).toBe('Satisfied')
    expect(dependencyConditionText({ workStreamId: 'a', condition: 'ready', satisfied: false })).toBe(
      'Waits until its pull request is ready'
    )
    // A ready edge satisfied because the dependency finished first never unlocked early.
    expect(dependencyConditionText({ workStreamId: 'a', condition: 'ready', satisfied: true })).toBe('Satisfied')
  })

  test('a stacked edge names the branch and the delivery hold', () => {
    const unlocked = {
      workStreamId: 'a',
      condition: 'ready' as const,
      satisfied: true,
      unlockedAt: '2026-10-13T00:00:00.000Z',
    }
    expect(
      dependencyConditionText({ ...unlocked, stack: { mode: 'stacked', branch: 'work/parser' }, holdsDelivery: true })
    ).toBe('Unlocked when its pull request was ready · built on work/parser · delivery held until it merges')
    expect(
      dependencyConditionText({ ...unlocked, stack: { mode: 'manual', branch: 'work/parser' }, holdsDelivery: true })
    ).toBe('Unlocked when its pull request was ready · merge work/parser in by hand · delivery held until it merges')
    // Merged: the stack is history and nothing is held any more.
    expect(dependencyConditionText({ ...unlocked, stack: { mode: 'stacked', branch: 'work/parser' } })).toBe(
      'Unlocked when its pull request was ready · built on work/parser'
    )
  })
})

describe('waitingFor', () => {
  const openedAt = '2026-11-01T00:00:00.000Z'
  const after = (ms: number) => new Date(openedAt).getTime() + ms

  test('counts seconds for the first minute, then one coarse unit', () => {
    expect(waitingFor(openedAt, after(0))).toBe('waiting 0s')
    expect(waitingFor(openedAt, after(59_999))).toBe('waiting 59s')
    expect(waitingFor(openedAt, after(60_000))).toBe('waiting 1m')
    expect(waitingFor(openedAt, after(59 * 60_000 + 59_999))).toBe('waiting 59m')
    expect(waitingFor(openedAt, after(3_600_000))).toBe('waiting 1h')
    expect(waitingFor(openedAt, after(23 * 3_600_000 + 59 * 60_000))).toBe('waiting 23h')
    expect(waitingFor(openedAt, after(24 * 3_600_000))).toBe('waiting 1d')
    expect(waitingFor(openedAt, after((7 * 24 + 23) * 3_600_000))).toBe('waiting 7d')
  })

  test('a wait opened in the future reads as just opened', () => {
    expect(waitingFor(openedAt, after(-90_000))).toBe('waiting 0s')
  })
})
