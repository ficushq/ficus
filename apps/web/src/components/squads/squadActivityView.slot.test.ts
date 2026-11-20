import { describe, expect, test } from 'bun:test'
import type { ActivityWorkStreamCard } from '@ficus/shared'
import { activityWorkStateLine } from './squadActivityView'

const card = (overrides: Partial<ActivityWorkStreamCard> = {}): ActivityWorkStreamCard => ({
  id: 'ws',
  number: 1406,
  squadId: 's',
  title: 'Spend',
  status: 'active',
  step: 'implement',
  waits: [],
  needsYou: false,
  pullRequest: null,
  ci: null,
  deliveryLabel: null,
  workingAgentIds: [],
  lastEventAt: '2026-11-20T21:00:00.000Z',
  derivedState: 'idle',
  ...overrides,
})

describe('Active work row for a stream queued for a slot', () => {
  const slotWait = { poolKey: 'heavy-work', attemptId: 1, position: 2, queuedCount: 5, queuedAt: '', hostBusy: true }

  test('says what it waits for while queued, and is Idle again after the grant', () => {
    expect(activityWorkStateLine(card({ slotWait }))).toEqual({
      state: 'Waiting for heavy-work slot (position 2 of 5, host busy)',
      step: 'Implement',
    })
    expect(activityWorkStateLine(card())).toEqual({ state: 'Idle', step: 'Implement' })
  })

  test('an open wait keeps its own label', () => {
    expect(activityWorkStateLine(card({ slotWait, waits: [{ type: 'dependency', needsYou: false }] })).state).toBe(
      'Waiting: dependency'
    )
  })
})
