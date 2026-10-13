import { describe, expect, test } from 'bun:test'
import { createWorkStreamSchema, updateWorkStreamSchema } from './schemas'
import {
  InvalidDependencyConditionError,
  isDependencyEdgeSatisfied,
  isStackedDependencyEdge,
  normalizeDependencyInputs,
  parseDependencySpec,
} from './work-stream-dependencies'

describe('dependency conditions', () => {
  test('a bare ID and <id>:done mean done; <id>:ready means ready', () => {
    expect(parseDependencySpec('42')).toEqual({ id: '42', condition: 'done' })
    expect(parseDependencySpec('42:done')).toEqual({ id: '42', condition: 'done' })
    expect(parseDependencySpec(' 9b3823c9:ready ')).toEqual({ id: '9b3823c9', condition: 'ready' })
  })

  test('an unknown condition is rejected with the accepted forms', () => {
    expect(() => parseDependencySpec('42:merged')).toThrow(InvalidDependencyConditionError)
    expect(() => parseDependencySpec('42:merged')).toThrow('Unknown dependency condition "merged". Use <id>, <id>:done')
    expect(() => parseDependencySpec(':ready')).toThrow(InvalidDependencyConditionError)
    expect(() => normalizeDependencyInputs([{ id: 'a', condition: 'soon' as never }])).toThrow(
      InvalidDependencyConditionError
    )
  })

  test('inputs normalize to the authoritative ID list plus per-ID conditions', () => {
    expect(normalizeDependencyInputs(['a', { id: 'b', condition: 'ready' }, { id: 'c' }, 'a'])).toEqual({
      ids: ['a', 'b', 'c'],
      conditions: { a: 'done', b: 'ready', c: 'done' },
    })
    expect(() => normalizeDependencyInputs(['a', { id: 'a', condition: 'ready' }])).toThrow(
      'Dependency a is listed more than once with different conditions'
    )
  })

  test('API schemas accept plain IDs and conditioned edges, and reject unknown conditions', () => {
    const base = { squadId: 'squad', title: 'title' }
    expect(
      createWorkStreamSchema.parse({ ...base, dependsOn: ['a', { id: 'b', condition: 'ready' }] }).dependsOn
    ).toEqual(['a', { id: 'b', condition: 'ready' }])
    expect(createWorkStreamSchema.parse(base).dependsOn).toEqual([])
    const rejected = updateWorkStreamSchema.safeParse({ dependsOn: [{ id: 'b', condition: 'merged' }] })
    expect(rejected.success).toBe(false)
    expect(JSON.stringify(rejected.error?.issues)).toContain('Unknown dependency condition. Use one of: done, ready')
  })

  test('an edge is satisfied by a done dependency, or by a ready edge that unlocked', () => {
    const unlocked = { dep: { condition: 'ready' as const, readyUnlockedAt: '2026-10-13T00:00:00.000Z' } }
    expect(isDependencyEdgeSatisfied({}, 'dep', 'done')).toBe(true)
    expect(isDependencyEdgeSatisfied({}, 'dep', 'active')).toBe(false)
    expect(isDependencyEdgeSatisfied(null, 'dep', undefined)).toBe(false)
    expect(isDependencyEdgeSatisfied({ dep: { condition: 'ready' } }, 'dep', 'active')).toBe(false)
    expect(isDependencyEdgeSatisfied(unlocked, 'dep', 'active')).toBe(true)
    // Sticky through rework. Through a cancel only once the dependent started on the edge.
    expect(isDependencyEdgeSatisfied(unlocked, 'dep', 'queued')).toBe(true)
    expect(isDependencyEdgeSatisfied(unlocked, 'dep', 'canceled')).toBe(false)
    const started = { dep: { ...unlocked.dep, stack: { mode: 'none' as const, decidedAt: 'now', reason: 'x' } } }
    expect(isDependencyEdgeSatisfied(started, 'dep', 'canceled')).toBe(true)
  })

  test('only a stack decision that builds on the branch counts as stacked', () => {
    const decidedAt = '2026-10-13T00:00:00.000Z'
    expect(isStackedDependencyEdge(undefined)).toBe(false)
    expect(isStackedDependencyEdge({ condition: 'ready' })).toBe(false)
    expect(isStackedDependencyEdge({ condition: 'ready', stack: { mode: 'none', decidedAt, reason: 'x' } })).toBe(false)
    expect(isStackedDependencyEdge({ condition: 'ready', stack: { mode: 'pending', decidedAt, claimId: 'c' } })).toBe(
      false
    )
    for (const mode of ['stacked', 'included', 'manual'] as const)
      expect(isStackedDependencyEdge({ condition: 'ready', stack: { mode, decidedAt, branch: 'work/a' } })).toBe(true)
  })
})
