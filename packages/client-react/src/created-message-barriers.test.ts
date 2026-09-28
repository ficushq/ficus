import { describe, expect, test } from 'bun:test'
import type { StreamGroupSnapshot } from '@ficus/client-core'
import { barrierHidesGroup, exactResponseIdentity, type CreatedMessageBarrier } from './created-message-barriers'

function group(executionId: string | undefined, streamGroupId: string, startedAt: number) {
  return {
    executionId,
    streamGroupId,
    agentId: 'agent-1',
    blocks: [],
    startedAt,
    done: false,
    doneMessageIds: null,
    flushed: false,
    errored: false,
  } satisfies StreamGroupSnapshot
}

function barrier(
  identity: CreatedMessageBarrier['identity'],
  preexistingGroupIds: string[] = []
): CreatedMessageBarrier {
  return { identity, arrivedAt: 10, generation: 1, preexistingGroupIds: new Set(preexistingGroupIds) }
}

describe('created message response barriers', () => {
  test('accepts only a complete non-empty response identity pair', () => {
    expect(exactResponseIdentity({ executionId: 'e1', streamGroupId: 'g1' })).toEqual({
      executionId: 'e1',
      streamGroupId: 'g1',
    })
    expect(exactResponseIdentity({ executionId: 'e1' })).toBeNull()
    expect(exactResponseIdentity({ streamGroupId: 'g1' })).toBeNull()
    expect(exactResponseIdentity({ executionId: '', streamGroupId: 'g1' })).toBeNull()
  })

  test('an exact pair hides only its target, and only when the target began after arrival', () => {
    const target = group('e1', 'g1', 11)
    const sameExecution = group('e1', 'g2', 12)
    const newerExecution = group('e2', 'g3', 13)
    const groups = [target, sameExecution, newerExecution]
    const responseBarrier = barrier({ executionId: 'e1', streamGroupId: 'g1' })

    expect(groups.map((candidate) => barrierHidesGroup(responseBarrier, candidate, groups))).toEqual([
      true,
      false,
      false,
    ])
  })

  test('an exact pair never retracts a target that was already streaming when it arrived', () => {
    // The group being streamed persists its own assistant rows with this exact identity; each
    // message.created for one of them must not hide the live response.
    const liveTarget = group('e1', 'g1', 5)
    const newerExecution = group('e2', 'g3', 13)
    const groups = [liveTarget, newerExecution]
    const responseBarrier = barrier({ executionId: 'e1', streamGroupId: 'g1' }, ['g1'])

    expect(groups.map((candidate) => barrierHidesGroup(responseBarrier, candidate, groups))).toEqual([false, false])
  })

  test('preexistence is causal, not clock-based: a same-instant target that arrived first is not hidden', () => {
    const groups = [group('e1', 'g1', 10)]
    const responseBarrier = barrier({ executionId: 'e1', streamGroupId: 'g1' }, ['g1'])
    expect(barrierHidesGroup(responseBarrier, groups[0], groups)).toBe(false)
    expect(barrierHidesGroup(barrier({ executionId: 'e1', streamGroupId: 'g1' }), groups[0], groups)).toBe(true)
  })

  test('a named target not yet present hides no unrelated groups', () => {
    const groups = [group('e2', 'g2', 12)]
    expect(barrierHidesGroup(barrier({ executionId: 'e1', streamGroupId: 'g1' }), groups[0], groups)).toBe(false)
  })

  test('a partial conflict fails closed to the post-arrival barrier', () => {
    const old = group('e2', 'g1', 5)
    const newer = group('e2', 'g2', 12)
    const groups = [old, newer]
    const responseBarrier = barrier({ executionId: 'e1', streamGroupId: 'g1' }, ['g1'])

    expect(barrierHidesGroup(responseBarrier, old, groups)).toBe(false)
    expect(barrierHidesGroup(responseBarrier, newer, groups)).toBe(true)
  })

  test('legacy identity retains the post-arrival barrier', () => {
    const groups = [group(undefined, 'old', 5), group(undefined, 'new', 12)]
    expect(groups.map((candidate) => barrierHidesGroup(barrier(null, ['old']), candidate, groups))).toEqual([
      false,
      true,
    ])
  })
})
