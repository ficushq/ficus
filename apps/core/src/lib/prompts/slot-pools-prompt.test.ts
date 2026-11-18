import { describe, expect, test } from 'bun:test'
import {
  renderSlotPoolsPrompt,
  SLOT_COORDINATION_GUIDANCE,
  SLOT_POOLS_PROMPT_TOKEN,
  slotPoolsPromptFallback,
} from './slot-pools-prompt'

const coordination = ['', '### Slot Coordination', '', SLOT_COORDINATION_GUIDANCE]

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
        'Registered capacity pools in this squad. Claim a pool before the work its guidance names and release it when done. Run `ficus slot list` for live holders and queue.',
        '',
        '- `production-change`: capacity 1, claim timeout 1h',
        '- `shared-box-intensive`: capacity 2, claim timeout 45m',
        '  Claim before DB-backed tests or native builds.',
        '  Release after test:db:down.',
        ...coordination,
      ].join('\n')
    )
  })

  test('says when a pool is host-shared and how many claims the machine host allows', () => {
    const section = renderSlotPoolsPrompt([
      { key: 'heavy-work', capacity: 3, claimTimeoutMs: 45 * 60_000, usage: 'Claim before builds.', hostCapacity: 3 },
      { key: 'solo', capacity: 1, claimTimeoutMs: 45 * 60_000, usage: null, hostCapacity: 1 },
      {
        key: 'uncapped',
        capacity: 3,
        claimTimeoutMs: 45 * 60_000,
        usage: null,
        hostCapacity: 3,
        capacityFollowsHost: true,
      },
    ])
    expect(section.split('\n').slice(4, -coordination.length)).toEqual([
      '- `heavy-work`: capacity 3, claim timeout 45m, host-shared (this machine host allows 3 such claims at once across all squads on it, so you can be queued while this pool has room)',
      '  Claim before builds.',
      '- `solo`: capacity 1, claim timeout 45m, host-shared (this machine host allows 1 such claim at once across all squads on it, so you can be queued while this pool has room)',
      // A pool with no cap of its own has only the host's number to state.
      '- `uncapped`: claim timeout 45m, host-shared with no cap of its own (this machine host allows 3 such claims at once across all squads on it)',
    ])
  })

  test('lists configuration only, never live usage, and skips blank guidance', () => {
    const section = renderSlotPoolsPrompt([{ key: 'tests', capacity: 3, claimTimeoutMs: 90_000, usage: '  ' }])
    // The pool entry is the last pool line: no holder, queue, or guidance lines follow it.
    expect(section.split('\n').slice(0, -coordination.length).at(-1)).toBe('- `tests`: capacity 3, claim timeout 90s')
  })
})

describe('slot coordination guidance', () => {
  test('appears only in the generated section, so squads without pools never read it', () => {
    expect(renderSlotPoolsPrompt([])).not.toContain('Slot Coordination')
    const section = renderSlotPoolsPrompt([{ key: 'tests', capacity: 1, claimTimeoutMs: 60_000, usage: null }])
    expect(section.split(SLOT_COORDINATION_GUIDANCE)).toHaveLength(2)
    expect(SLOT_COORDINATION_GUIDANCE).toContain('returns `queued` with a waiter id')
    expect(SLOT_COORDINATION_GUIDANCE).toContain('`ficus slot release <claim-id>`')
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
