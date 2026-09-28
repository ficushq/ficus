import { describe, expect, test } from 'bun:test'
import type { InboxMessageSenderType } from '@ficus/shared'
import { isInboxMessageWakeEligible } from './InboxMessage'

describe('inbox dormant wake policy', () => {
  test('only genuine correspondence wakes by default', () => {
    const cases: Array<[InboxMessageSenderType, boolean]> = [
      ['user', true],
      ['agent', true],
      ['voice_assistant', true],
      ['remote', true],
      ['system', false],
    ]
    for (const [senderType, expected] of cases) {
      expect(isInboxMessageWakeEligible({ senderType, metadata: {} })).toBe(expected)
    }
  })

  test('an explicit system work-delivery opt-in wins', () => {
    expect(isInboxMessageWakeEligible({ senderType: 'system', metadata: { wakeEligible: true } })).toBe(true)
  })
})
