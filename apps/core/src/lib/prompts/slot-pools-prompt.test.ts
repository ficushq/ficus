import { describe, expect, test } from 'bun:test'
import { renderSlotPoolsPrompt, SLOT_POOLS_PROMPT_TOKEN, slotPoolsPromptFallback } from './slot-pools-prompt'

describe('renderSlotPoolsPrompt', () => {
  test('omits the section entirely when the squad has no active pools', () => {
    expect(renderSlotPoolsPrompt([])).toBe('')
  })

  test('lists every pool with capacity and readable timeout, adding guidance when set', () => {
    const section = renderSlotPoolsPrompt([
      { key: 'production-change', capacity: 1, claimTimeoutMs: 60 * 60_000, usage: null },
      {
        key: 'shared-box-intensive',
        capacity: 2,
        claimTimeoutMs: 45 * 60_000,
        usage: 'Claim before DB-backed tests or native builds.\nRelease after test:db:down.',
      },
    ])

    expect(section).toBe(
      [
        '## Slot Pools',
        '',
        'Registered capacity pools in this squad. Claim a pool before the work its guidance names (see Slot Coordination) and release it when done. Run `ficus slot list` for live holders and queue.',
        '',
        '- `production-change`: capacity 1, claim timeout 1h',
        '- `shared-box-intensive`: capacity 2, claim timeout 45m',
        '  Claim before DB-backed tests or native builds.',
        '  Release after test:db:down.',
      ].join('\n')
    )
  })

  test('lists configuration only, never live usage, and skips blank guidance', () => {
    const section = renderSlotPoolsPrompt([{ key: 'tests', capacity: 3, claimTimeoutMs: 90_000, usage: '  ' }])
    // The pool entry is the last line: no holder, queue, or guidance lines follow.
    expect(section.split('\n').at(-1)).toBe('- `tests`: capacity 3, claim timeout 90s')
  })
})

describe('slotPoolsPromptFallback', () => {
  const section = renderSlotPoolsPrompt([{ key: 'tests', capacity: 1, claimTimeoutMs: 60_000, usage: null }])

  test('is empty when the composed prompt already places the token', () => {
    expect(slotPoolsPromptFallback(`ctx\n${SLOT_POOLS_PROMPT_TOKEN}`, section)).toBe('')
  })

  test('supplies the section when a custom prompt lacks the token', () => {
    expect(slotPoolsPromptFallback('custom prompt', section)).toBe(section)
  })

  test('is empty when there is no section to place', () => {
    expect(slotPoolsPromptFallback('custom prompt', '')).toBe('')
  })
})
