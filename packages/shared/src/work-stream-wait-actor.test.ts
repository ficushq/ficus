import { describe, expect, test } from 'bun:test'
import { requestInputWorkStreamSchema, setWorkStreamWaitActorSchema } from './schemas'
import { WORK_STREAM_WAIT_ACTORS, workStreamWaitActor } from './types'

/** Manager is now a runtime-owned recovery target, never a caller-selected actor. */
const SERVER_ACTOR = 'manager'

describe('workStreamWaitActor', () => {
  test('keeps known actors', () => {
    for (const actor of WORK_STREAM_WAIT_ACTORS) expect(workStreamWaitActor({ actor })).toBe(actor)
  })

  test('treats missing, null and unknown actors as human (older and newer payloads)', () => {
    expect(workStreamWaitActor({})).toBe('human')
    expect(workStreamWaitActor({ actor: null })).toBe('human')
    expect(workStreamWaitActor({ actor: 'robot' })).toBe('human')
    expect(workStreamWaitActor({ actor: 'external' })).toBe('human')
  })
})

describe('request-input actor validation', () => {
  test('accepts each actor and leaves it unset when omitted', () => {
    const input = {
      schemaVersion: 1 as const,
      kind: 'provide' as const,
      purpose: 'task-input' as const,
      input: { type: 'config-value' as const, name: 'Release channel' },
      use: 'Select a target',
    }
    for (const actor of ['human', 'owner'] as const) {
      expect(requestInputWorkStreamSchema.parse({ ...input, actor })).toEqual({ ...input, actor })
    }
    expect(requestInputWorkStreamSchema.parse(input)).toEqual(input)
  })

  test('rejects an unknown actor', () => {
    expect(requestInputWorkStreamSchema.safeParse({ message: 'm', actor: 'robot' }).success).toBe(false)
    expect(requestInputWorkStreamSchema.safeParse({ message: 'm', actor: SERVER_ACTOR }).success).toBe(false)
    expect(requestInputWorkStreamSchema.safeParse({ message: 'm', actor: 'external' }).success).toBe(false)
    expect(setWorkStreamWaitActorSchema.safeParse({ actor: SERVER_ACTOR }).success).toBe(false)
    expect(setWorkStreamWaitActorSchema.safeParse({}).success).toBe(false)
  })

  test('the relabel body takes an actor and an optional non-empty note', () => {
    expect(setWorkStreamWaitActorSchema.parse({ actor: 'owner', note: 'why' })).toEqual({
      actor: 'owner',
      note: 'why',
    })
    expect(setWorkStreamWaitActorSchema.safeParse({ actor: 'owner', note: '' }).success).toBe(false)
  })
})
