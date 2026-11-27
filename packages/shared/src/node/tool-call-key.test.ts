import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  TOOL_CALL_KEY_ENV,
  canonicalJson,
  cliCommandIdempotencyKey,
  currentToolCallKey,
  stableUuidFromParts,
  toolCallIdempotencyKey,
} from './tool-call-key'

const agent = '11111111-1111-4111-8111-111111111111'
const execution = '22222222-2222-4222-8222-222222222222'

describe('toolCallIdempotencyKey', () => {
  test('is stable for the same call and fenced by agent, execution and call', () => {
    const key = toolCallIdempotencyKey(agent, execution, 'toolu_1')
    expect(toolCallIdempotencyKey(agent, execution, 'toolu_1')).toBe(key)
    expect(toolCallIdempotencyKey(agent, execution, 'toolu_2')).not.toBe(key)
    expect(toolCallIdempotencyKey(agent, '33333333-3333-4333-8333-333333333333', 'toolu_1')).not.toBe(key)
    expect(toolCallIdempotencyKey('44444444-4444-4444-8444-444444444444', execution, 'toolu_1')).not.toBe(key)
  })

  test('keeps the value the Assistant tools already stored as client IDs', () => {
    // The former assistantToolClientId produced exactly this value; in-flight Assistant
    // sends keyed on it must keep matching after the move to the shared helper.
    expect(toolCallIdempotencyKey(agent, execution, 'toolu_1')).toBe(stableUuidFromParts([agent, execution, 'toolu_1']))
    expect(z.uuid().safeParse(toolCallIdempotencyKey(agent, execution, 'toolu_1')).success).toBe(true)
  })
})

describe('canonicalJson', () => {
  test('ignores object key order and undefined fields at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } })).toBe(
      canonicalJson({ a: { d: [2, { x: 2, y: 1 }] }, b: 1 })
    )
  })
})

describe('cliCommandIdempotencyKey', () => {
  const toolCallKey = toolCallIdempotencyKey(agent, execution, 'toolu_1')
  const env = { [TOOL_CALL_KEY_ENV]: toolCallKey }

  test('is undefined outside an agent tool call or with a malformed key', () => {
    expect(cliCommandIdempotencyKey('inbox send', { content: 'hi' }, {})).toBeUndefined()
    expect(cliCommandIdempotencyKey('inbox send', { content: 'hi' }, { [TOOL_CALL_KEY_ENV]: 'nope' })).toBeUndefined()
    expect(currentToolCallKey({ [TOOL_CALL_KEY_ENV]: ` ${toolCallKey.toUpperCase()} ` })).toBe(toolCallKey)
  })

  test('the same command and payload in the same tool call give the same UUID key', () => {
    const first = cliCommandIdempotencyKey('inbox send', { recipientId: 'a', content: 'hi' }, env)
    expect(first).toBeDefined()
    expect(z.uuid().safeParse(first).success).toBe(true)
    expect(cliCommandIdempotencyKey('inbox send', { content: 'hi', recipientId: 'a' }, env)).toBe(first!)
  })

  test('a different payload, command or tool call gives a different key', () => {
    const first = cliCommandIdempotencyKey('inbox send', { recipientId: 'a', content: 'hi' }, env)
    expect(cliCommandIdempotencyKey('inbox send', { recipientId: 'b', content: 'hi' }, env)).not.toBe(first!)
    expect(cliCommandIdempotencyKey('inbox send', { recipientId: 'a', content: 'hello' }, env)).not.toBe(first!)
    expect(cliCommandIdempotencyKey('workstream advance', { recipientId: 'a', content: 'hi' }, env)).not.toBe(first!)
    expect(
      cliCommandIdempotencyKey(
        'inbox send',
        { recipientId: 'a', content: 'hi' },
        { [TOOL_CALL_KEY_ENV]: toolCallIdempotencyKey(agent, execution, 'toolu_2') }
      )
    ).not.toBe(first!)
  })
})
