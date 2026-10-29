import { describe, expect, test } from 'bun:test'
import {
  WORK_STREAM_STATUS_ROLE,
  type PendingAction,
  type WorkStreamActionData,
  type WorkStreamPresentationState,
  type WorkStreamWait,
} from '@ficus/shared'
import {
  WS_STATUS_BADGE_COLORS,
  WS_STATUS_ICONS,
  WS_STATUS_LABELS,
  externalDeliveryLabel,
  getWsDisplayState,
  isWorkStreamParked,
  workStreamStatusLabel,
  workStreamActionPresentationState,
  workStreamWaitBadge,
} from './workStreamStatusPresentation'
import { BADGE_COLORS } from '../components/Badge'

/** The actor's pre-rename name; nothing shipped with it, so it is an unknown value (human). */

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

  test('only authoritative reasons refine external labels', () => {
    expect(externalDeliveryLabel({ codeHostReason: 'ci-pending' })).toBe('Awaiting CI')
    expect(externalDeliveryLabel({ codeHostReason: 'awaiting-merge' })).toBe('Awaiting merge')
    expect(externalDeliveryLabel({ codeHostReason: 'draft' })).toBe('PR is draft')
    expect(externalDeliveryLabel({ codeHostReason: 'merged' })).toBe('PR merged — finalizing delivery')
  })
  test('old, partial or future evidence cannot invent readiness', () => {
    for (const explanation of [
      undefined,
      {},
      { gates: { mergeState: 'clean' } },
      { pullRequests: [{ number: 42, state: 'open' as const }] },
      { gates: { checksState: 'pending' as const } },
      { codeHostReason: 'future' as never },
    ]) {
      expect(externalDeliveryLabel(explanation)).toBeNull()
      expect(workStreamStatusLabel(external(explanation))).toBe('Awaiting Code Host')
    }
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

describe('workStreamWaitBadge', () => {
  test('labels manual waits by actor and keeps other wait types by type', () => {
    expect(workStreamWaitBadge({ type: 'manual' })).toEqual({ label: 'Needs you', color: 'attention' })
    expect(workStreamWaitBadge({ type: 'manual', actor: 'human' })).toEqual({ label: 'Needs you', color: 'attention' })
    expect(workStreamWaitBadge({ type: 'manual', actor: 'owner' })).toEqual({
      label: 'Waiting on Owner',
      color: 'externalWait',
    })
    // Unknown actors retain the legacy human fallback; manager is now runtime-owned.
    expect(workStreamWaitBadge({ type: 'manual', actor: 'robot' })).toEqual({ label: 'Needs you', color: 'attention' })
    expect(workStreamWaitBadge({ type: 'manual', actor: 'manager' })).toEqual({
      label: 'Waiting on Manager',
      color: 'externalWait',
    })
    expect(workStreamWaitBadge({ type: 'dependency' })).toEqual({ label: 'Dependency', color: 'externalWait' })
    // Resolved waits keep their type label and name a non-human actor.
    expect(workStreamWaitBadge({ type: 'manual' }, { history: true }).label).toBe('Manual')
    expect(workStreamWaitBadge({ type: 'manual', actor: 'owner' }, { history: true }).label).toBe('Manual · Owner')
    // A workflow approval gate is a review, whatever actor it carries.
    expect(
      workStreamWaitBadge({ type: 'manual', resolutionHandler: 'workflow', flowAttemptId: 1, actor: 'owner' })
    ).toEqual({ label: 'Review', color: 'review' })
  })

  test('owner waits are parked like other retained waits when queued', () => {
    expect(isWorkStreamParked({ status: 'queued', openWaits: [{ type: 'manual', actor: 'owner' }] })).toBe(true)
  })
})

describe('work-stream pending action presentation', () => {
  const wait = (facts: Partial<WorkStreamWait>): WorkStreamWait => ({
    id: 'wait-1',
    workStreamId: 'ws-1',
    type: 'manual',
    referenceId: null,
    message: null,
    createdBy: 'agent',
    createdByAgentId: null,
    createdByUserId: null,
    completesOnApproval: false,
    openedAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    resolution: null,
    resolutionNote: null,
    ...facts,
  })
  const action = (type: PendingAction['type'], data: Partial<WorkStreamActionData>): PendingAction =>
    ({ id: 'a', type, priority: 1, createdAt: '', canRespond: true, data }) as PendingAction

  test('presents each wait exactly as the stream row presents it', () => {
    const cases: Array<[PendingAction['type'], WorkStreamWait]> = [
      ['workstream-review', wait({ type: 'review', completesOnApproval: true })],
      ['workstream-blocked', wait({ resolutionHandler: 'workflow', flowAttemptId: 3 })],
      ['workstream-blocked', wait({})],
      ['workstream-blocked', wait({ resolutionHandler: 'workflow', flowAttemptId: null })],
    ]
    for (const [type, open] of cases) {
      expect(workStreamActionPresentationState(action(type, { wait: open }))).toBe(
        getWsDisplayState({ status: 'active', openWaits: [open] })
      )
    }
  })

  test('a workflow gate is a review, the delivery approval is Approve Delivery, other waits stay blocked', () => {
    const gate = wait({ resolutionHandler: 'workflow', flowAttemptId: 3 })
    expect(workStreamActionPresentationState(action('workstream-blocked', { wait: gate }))).toBe('in_review')
    const delivery = wait({ id: 'delivery', resolutionHandler: 'workflow', flowAttemptId: null })
    expect(
      workStreamActionPresentationState(action('workstream-blocked', { wait: delivery, deliveryApproval: true }))
    ).toBe('delivery_approval')
    // The stream row selects the same state from its delivery facts.
    expect(
      getWsDisplayState({
        status: 'active',
        openWaits: [delivery],
        delivery: { kind: 'approval', approvalWaitId: 'delivery' },
      })
    ).toBe('delivery_approval')
    expect(workStreamActionPresentationState(action('workstream-blocked', { wait: wait({}) }))).toBe('blocked')
  })

  test('code-host delivery gates map to their delivery state; other actions have none', () => {
    expect(
      workStreamActionPresentationState({
        ...action('workstream-delivery', {}),
        data: { deliveryKind: 'merge' },
      } as PendingAction)
    ).toBe('delivery_merge')
    expect(
      workStreamActionPresentationState({
        ...action('workstream-delivery', {}),
        data: { deliveryKind: 'review' },
      } as PendingAction)
    ).toBe('delivery_review')
    expect(workStreamActionPresentationState(action('agent-error', {}))).toBeNull()
  })

  test('review states use the review glyph and only blocked/setup use the no-entry glyph', () => {
    for (const state of ['in_review', 'delivery_approval', 'delivery_review', 'delivery_merge'] as const) {
      expect(WS_STATUS_ICONS[state]).toBe('◎')
      expect(WORK_STREAM_STATUS_ROLE[state]).toBe('review')
    }
    const noEntry = (Object.keys(WS_STATUS_ICONS) as WorkStreamPresentationState[]).filter(
      (state) => WS_STATUS_ICONS[state] === '⊘'
    )
    expect(noEntry.sort()).toEqual(['blocked', 'delivery_setup'])
  })
})
