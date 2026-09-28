import { describe, expect, test } from 'bun:test'
import { WORK_STREAM_STATUS_ROLE, type WorkStreamPresentationState } from '@ficus/shared'
import {
  WS_STATUS_BADGE_COLORS,
  WS_STATUS_LABELS,
  externalDeliveryLabel,
  getWsDisplayState,
  workStreamStatusLabel,
} from './workStreamStatusPresentation'
import { BADGE_COLORS } from '../components/Badge'

describe('work-stream role token resolution', () => {
  test('every stored and derived state retains its shared semantic role', () => {
    expect(Object.keys(WS_STATUS_BADGE_COLORS).sort()).toEqual(Object.keys(WORK_STREAM_STATUS_ROLE).sort())
    for (const state of Object.keys(WORK_STREAM_STATUS_ROLE) as WorkStreamPresentationState[]) {
      const role = WORK_STREAM_STATUS_ROLE[state]
      expect(WS_STATUS_BADGE_COLORS[state]).toBe(role)
      expect(WS_STATUS_LABELS[state].length).toBeGreaterThan(0)
      expect(BADGE_COLORS[role]).toContain(
        `bg-status-${role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}-badge-surface`
      )
    }
  })
  test('derived review still takes precedence over stored active', () => {
    expect(getWsDisplayState({ status: 'active', derivedState: 'in_review' })).toBe('in_review')
    expect(WS_STATUS_BADGE_COLORS.in_review).toBe('review')
    expect(WS_STATUS_BADGE_COLORS.active).toBe('progress')
  })
})

describe('delivery-external label derivation', () => {
  const external = (explanation?: Parameters<typeof externalDeliveryLabel>[0]) => ({
    status: 'active' as const,
    openWaits: [],
    delivery: { kind: 'external' as const, ...(explanation ? { explanation } : {}) },
  })

  test('bound open pull requests with no other known blocker are awaiting merge', () => {
    expect(externalDeliveryLabel({ pullRequests: [{ number: 212, state: 'open' }] })).toBe('Awaiting merge of #212')
    expect(
      workStreamStatusLabel(
        external({
          pullRequests: [
            { number: 212, state: 'open' },
            { number: 214, state: 'open' },
          ],
        })
      )
    ).toBe('Awaiting merge of #212, #214')
    expect(
      externalDeliveryLabel({
        pullRequests: [
          { number: 1, state: 'open' },
          { number: 2, state: 'open' },
          { number: 3, state: 'open' },
          { number: 4, state: 'open' },
          { number: 5, state: 'open' },
        ],
      })
    ).toBe('Awaiting merge of #1, #2, #3 +2 more')
  })

  test('known gate blockers take precedence over the awaiting-merge label', () => {
    expect(
      externalDeliveryLabel({
        pullRequests: [{ number: 212, state: 'open' }],
        gates: { checksState: 'pending' },
      })
    ).toBe('Awaiting CI')
    expect(
      externalDeliveryLabel({
        pullRequests: [{ number: 212, state: 'open' }],
        gates: { reviewDecision: 'required' },
      })
    ).toBe('Awaiting review')
    expect(
      externalDeliveryLabel({
        pullRequests: [{ number: 212, state: 'open' }],
        gates: { pendingHumanReview: true },
      })
    ).toBe('Awaiting review')
    expect(
      externalDeliveryLabel({
        pullRequests: [{ number: 212, state: 'open' }],
        gates: { mergeState: 'blocked', reviewDecision: 'approved', checksState: 'success' },
      })
    ).toBe('Blocked by branch protection')
  })

  test('observed merges finalize instead of awaiting another merge', () => {
    expect(externalDeliveryLabel({ pullRequests: [{ number: 212, state: 'merged' }] })).toBe(
      'PR merged — finalizing delivery'
    )
    expect(
      externalDeliveryLabel({
        pullRequests: [
          { number: 212, state: 'merged' },
          { number: 214, state: 'open' },
        ],
      })
    ).toBe('Awaiting merge of #214')
    // All merged wins over any leftover gate facts, and the label counts the PRs.
    expect(
      externalDeliveryLabel({
        pullRequests: [
          { number: 212, state: 'merged' },
          { number: 214, state: 'merged' },
        ],
        gates: { checksState: 'pending', mergeState: 'blocked' },
      })
    ).toBe('PRs merged — finalizing delivery')
  })

  test('unknown or contradictory evidence keeps the generic label', () => {
    expect(externalDeliveryLabel(undefined)).toBeNull()
    expect(externalDeliveryLabel({})).toBeNull()
    expect(externalDeliveryLabel({ gates: { mergeState: 'clean' } })).toBeNull()
    expect(externalDeliveryLabel({ pullRequests: [{ number: 5, state: 'closed' }] })).toBeNull()
    expect(externalDeliveryLabel({ pullRequests: [{ number: 5, state: 'open' }], gates: { draft: true } })).toBeNull()
    expect(workStreamStatusLabel(external())).toBe('Awaiting Code Host')
  })

  test('only delivery-external reinterprets its label; other kinds keep theirs', () => {
    expect(workStreamStatusLabel({ status: 'active', openWaits: [], delivery: { kind: 'merge' } })).toBe(
      'Merge Pull Request'
    )
    expect(workStreamStatusLabel({ status: 'active', openWaits: [], delivery: { kind: 'setup' } })).toBe(
      'Delivery Setup Required'
    )
    expect(workStreamStatusLabel({ status: 'active', openWaits: [{ type: 'review' }] })).toBe('In Review')
  })
})
