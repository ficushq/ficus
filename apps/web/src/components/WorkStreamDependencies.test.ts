import { describe, expect, test } from 'bun:test'
import { dependencyConditionText } from './WorkStreamDependencies'

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
