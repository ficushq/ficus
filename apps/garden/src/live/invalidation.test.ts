import { describe, expect, it } from 'bun:test'
import { queryKeys } from '@ficus/client-core'
import { dedupeKeys, isLiveEvent, keysForEvent } from './invalidation'

const event = (topic: string, name: string, data?: unknown) => ({ type: 'event' as const, topic, event: name, data })

describe('live invalidation', () => {
  it('recognises socket events', () => {
    expect(isLiveEvent(event('actions', 'actions.invalidated'))).toBe(true)
    expect(isLiveEvent({ type: 'subscribed', topic: 'actions' })).toBe(false)
  })

  it('refreshes the mailbox and questions on action events', () => {
    expect(keysForEvent(event('actions', 'actions.invalidated'))).toEqual([
      queryKeys.actions.all,
      queryKeys.agentQuestions.all,
    ])
  })

  it('refreshes squads, workflows and the mailbox on work stream events, including instance topics', () => {
    expect(keysForEvent(event('workstreams:ws1', 'workStream.review'))).toContainEqual(queryKeys.squads.all)
  })

  it('refreshes one agent and the mailbox when an agent starts waiting on you', () => {
    const keys = keysForEvent(event('agents', 'agent.waiting-input', { agentId: 'a1' }))
    expect(keys).toContainEqual(queryKeys.agents.detail('a1'))
    expect(keys).toContainEqual(queryKeys.actions.all)
  })

  it('drops keys a broader key in the batch already covers', () => {
    expect(dedupeKeys([queryKeys.squads.agents('s1'), queryKeys.squads.all, queryKeys.squads.all])).toEqual([
      queryKeys.squads.all,
    ])
  })
})
