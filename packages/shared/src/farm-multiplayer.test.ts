import { describe, expect, test } from 'bun:test'
import {
  FARM_CHAT_REACTIONS,
  validateFarmChatReaction,
  FARM_CHAT_MESSAGE_MAX,
  farmPersonInitials,
  farmPersonName,
  validateFarmChatBody,
  validateFarmChatRoom,
} from './farm-chat'
import { parsePresenceFocus } from './farm-presence'

const ID = '11111111-1111-4111-8111-111111111111'

describe('farm people', () => {
  test('are named by display name, else email', () => {
    expect(farmPersonName({ displayName: 'Noah Saso', email: 'n@example.com' })).toBe('Noah Saso')
    expect(farmPersonName({ displayName: '  ', email: 'n@example.com' })).toBe('n@example.com')
    expect(farmPersonName({ displayName: null, email: 'n@example.com' })).toBe('n@example.com')
  })

  test('get initials from their name or the start of their email', () => {
    expect(farmPersonInitials('Noah Saso')).toBe('NS')
    expect(farmPersonInitials('cher')).toBe('CH')
    expect(farmPersonInitials('ada.lovelace@example.com')).toBe('AL')
    expect(farmPersonInitials('x@example.com')).toBe('X')
    expect(farmPersonInitials('')).toBe('?')
  })
})

describe('farm chat input', () => {
  test('messages are trimmed, non-empty and bounded', () => {
    expect(validateFarmChatBody('  hi  ')).toEqual({ ok: true, body: 'hi' })
    expect(validateFarmChatBody('   ').ok).toBe(false)
    expect(validateFarmChatBody(3).ok).toBe(false)
    expect(validateFarmChatBody('x'.repeat(FARM_CHAT_MESSAGE_MAX + 1)).ok).toBe(false)
  })

  test('rooms need a name and may have a description', () => {
    expect(validateFarmChatRoom({ name: ' design ', description: ' pixels ' })).toEqual({
      ok: true,
      name: 'design',
      description: 'pixels',
    })
    expect(validateFarmChatRoom({ name: 'design' })).toEqual({ ok: true, name: 'design', description: null })
    for (const bad of [null, [], { name: '' }, { name: 'x'.repeat(41) }, { name: 'ok', description: 3 }])
      expect(validateFarmChatRoom(bad).ok).toBe(false)
  })
})

describe('farm chat reactions', () => {
  test('are one emoji each', () => {
    for (const emoji of [...FARM_CHAT_REACTIONS, '🦄', '👍🏽', '🧑‍🌾'])
      expect(validateFarmChatReaction(emoji)).toEqual({ ok: true, emoji })
    for (const bad of ['', 'a', 'ok', '👍👍', '👍 ', 3, null]) expect(validateFarmChatReaction(bad).ok).toBe(false)
  })
})

describe('presence focus', () => {
  test('accepts the known kinds with well-formed ids, and null for around the farm', () => {
    expect(parsePresenceFocus(null)).toEqual({ ok: true, focus: null })
    expect(parsePresenceFocus({ kind: 'agent', agentId: ID })).toEqual({
      ok: true,
      focus: { kind: 'agent', agentId: ID },
    })
    expect(parsePresenceFocus({ kind: 'workstream', workstreamId: ID }).ok).toBe(true)
    expect(parsePresenceFocus({ kind: 'squad', squadId: ID }).ok).toBe(true)
  })

  test('rejects anything else', () => {
    for (const bad of [undefined, 'agent', { kind: 'agent' }, { kind: 'agent', agentId: 'nope' }, { kind: 'house' }])
      expect(parsePresenceFocus(bad).ok).toBe(false)
  })
})
