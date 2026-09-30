import { describe, expect, test } from 'bun:test'
import { requestInputWorkStreamSchema, setWorkStreamWaitActorSchema } from './schemas'
import { WORK_STREAM_WAIT_ACTORS, workStreamWaitActor } from './types'

/** The actor's pre-rename name; nothing shipped with it, so it is an unknown value (human). */
const PRE_RENAME_ACTOR = 'manager'

describe('workStreamWaitActor', () => {
  test('keeps known actors', () => {
    for (const actor of WORK_STREAM_WAIT_ACTORS) expect(workStreamWaitActor({ actor })).toBe(actor)
  })

  test('treats missing, null and unknown actors as human (older and newer payloads)', () => {
    expect(workStreamWaitActor({})).toBe('human')
    expect(workStreamWaitActor({ actor: null })).toBe('human')
    expect(workStreamWaitActor({ actor: 'robot' })).toBe('human')
    // The pre-rename value has no legacy mapping.
    expect(workStreamWaitActor({ actor: PRE_RENAME_ACTOR })).toBe('human')
    expect(workStreamWaitActor({ actor: 'external' })).toBe('human')
  })
})

describe('request-input actor validation', () => {
  test('accepts each actor and leaves it unset when omitted', () => {
    for (const actor of WORK_STREAM_WAIT_ACTORS) {
      expect(requestInputWorkStreamSchema.parse({ message: 'm', actor })).toEqual({ message: 'm', actor })
    }
    expect(requestInputWorkStreamSchema.parse({ message: 'm' })).toEqual({ message: 'm' })
  })

  test('rejects an unknown actor', () => {
    expect(requestInputWorkStreamSchema.safeParse({ message: 'm', actor: 'robot' }).success).toBe(false)
    expect(requestInputWorkStreamSchema.safeParse({ message: 'm', actor: PRE_RENAME_ACTOR }).success).toBe(false)
    expect(requestInputWorkStreamSchema.safeParse({ message: 'm', actor: 'external' }).success).toBe(false)
    expect(setWorkStreamWaitActorSchema.safeParse({ actor: PRE_RENAME_ACTOR }).success).toBe(false)
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
