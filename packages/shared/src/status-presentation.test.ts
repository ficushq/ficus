import { describe, expect, test } from 'bun:test'
import type {
  AgentStatus,
  ExecutionStatus,
  SandboxRuntimeState,
  WorkStreamDerivedState,
  WorkStreamStatus,
  WorkStreamWait,
} from './types'
import {
  AGENT_STATUS_ROLE,
  MANUAL_WAIT_ACTOR_STATE,
  EXECUTION_STATUS_ROLE,
  SANDBOX_STATUS_ROLE,
  SUBAGENT_STATUS_ROLE,
  WORK_STREAM_STATUS_ROLE,
  selectSandboxPresentationState,
  selectWorkStreamPresentationState,
  workStreamNeedsHumanAttention,
  type AgentPresentationState,
  type SandboxPresentationState,
  type StatusRole,
  type SubagentPresentationState,
  type WorkStreamPresentationState,
} from './status-presentation'

function expectExactMap<State extends string>(
  map: Record<State, StatusRole>,
  cases: ReadonlyArray<readonly [State, StatusRole]>
) {
  for (const [state, role] of cases) expect(map[state]).toBe(role)
  expect(Object.keys(map).sort()).toEqual(cases.map(([state]) => state).sort())
}

describe('status role mappings', () => {
  test('maps every agent presentation state', () => {
    const cases: Array<[AgentPresentationState, StatusRole]> = [
      ['active', 'progress'],
      ['idle', 'neutral'],
      ['waiting-input', 'humanWait'],
      ['compacting', 'attention'],
      ['resetting', 'attention'],
      ['dormant', 'neutral'],
      ['terminated', 'neutral'],
      ['offline', 'neutral'],
    ]
    const currentStates: AgentStatus[] = [
      'idle',
      'active',
      'waiting-input',
      'compacting',
      'resetting',
      'dormant',
      'terminated',
    ]
    expect(currentStates.every((state) => state in AGENT_STATUS_ROLE)).toBe(true)
    expectExactMap(AGENT_STATUS_ROLE, cases)
  })

  test('maps every work-stream presentation state', () => {
    const cases: Array<[WorkStreamPresentationState, StatusRole]> = [
      ['queued', 'queue'],
      ['active', 'progress'],
      ['in_progress', 'progress'],
      ['in_review', 'review'],
      ['waiting_on_answer', 'humanWait'],
      ['waiting_on_dependency', 'externalWait'],
      ['blocked', 'danger'],
      ['idle', 'danger'],
      ['execution_failed', 'danger'],
      ['delivery_approval', 'review'],
      ['delivery_review', 'review'],
      ['delivery_merge', 'review'],
      ['delivery_external', 'externalWait'],
      ['waiting_on_owner', 'externalWait'],
      ['delivery_setup', 'danger'],
      ['delivery_failure', 'danger'],
      ['paused', 'neutral'],
      ['done', 'success'],
      ['canceled', 'neutral'],
    ]
    const storedStates: WorkStreamStatus[] = ['queued', 'active', 'done', 'canceled']
    const derivedStates: WorkStreamDerivedState[] = [
      'in_progress',
      'in_review',
      'waiting_on_answer',
      'waiting_on_dependency',
      'blocked',
      'idle',
      'execution_failed',
      'paused',
      'queued',
      'done',
      'canceled',
    ]
    expect([...storedStates, ...derivedStates].every((state) => state in WORK_STREAM_STATUS_ROLE)).toBe(true)
    expectExactMap(WORK_STREAM_STATUS_ROLE, cases)
  })

  test('maps every execution state', () => {
    const cases: Array<[ExecutionStatus, StatusRole]> = [
      ['queued', 'queue'],
      ['waiting-maintenance', 'externalWait'],
      ['waiting-sandbox', 'externalWait'],
      ['running', 'progress'],
      ['stopping', 'attention'],
      ['stopped', 'neutral'],
      ['completed', 'success'],
      ['failed', 'danger'],
    ]
    expectExactMap(EXECUTION_STATUS_ROLE, cases)
  })

  test('maps every subagent presentation state', () => {
    const cases: Array<[SubagentPresentationState, StatusRole]> = [
      ['queued', 'queue'],
      ['running', 'progress'],
      ['idle', 'neutral'],
      ['stopped', 'neutral'],
      ['done', 'success'],
      ['failed', 'danger'],
    ]
    expectExactMap(SUBAGENT_STATUS_ROLE, cases)
  })

  test('maps every sandbox presentation state', () => {
    const cases: Array<[SandboxPresentationState, StatusRole]> = [
      ['not_found', 'neutral'],
      ['pending', 'attention'],
      ['starting', 'attention'],
      ['running', 'success'],
      ['succeeded', 'neutral'],
      ['failed', 'danger'],
      ['terminating', 'attention'],
      ['unknown', 'neutral'],
      ['installing_packages', 'progress'],
      ['running_setup', 'progress'],
      ['degraded', 'attention'],
    ]
    const runtimeStates: SandboxRuntimeState[] = [
      'not_found',
      'pending',
      'starting',
      'running',
      'succeeded',
      'failed',
      'terminating',
      'unknown',
    ]
    expect(runtimeStates.every((state) => state in SANDBOX_STATUS_ROLE)).toBe(true)
    expectExactMap(SANDBOX_STATUS_ROLE, cases)
  })
})

function wait(type: WorkStreamWait['type']): Pick<WorkStreamWait, 'type'> {
  return { type }
}

function stream(
  overrides: {
    status?: WorkStreamStatus
    derivedState?: WorkStreamDerivedState
    openWaits?: Array<Pick<WorkStreamWait, 'type' | 'resolutionHandler' | 'flowAttemptId'>>
  } = {}
) {
  return { status: 'active' as const, ...overrides }
}

describe('selectWorkStreamPresentationState', () => {
  test('terminal stored status wins over stale waits and derived state', () => {
    expect(
      selectWorkStreamPresentationState(
        stream({ status: 'done', derivedState: 'in_review', openWaits: [wait('question')] })
      )
    ).toBe('done')
    expect(selectWorkStreamPresentationState(stream({ status: 'canceled', openWaits: [wait('review')] }))).toBe(
      'canceled'
    )
  })

  test('explicit waits use review, question, dependency, manual precedence', () => {
    expect(
      selectWorkStreamPresentationState(
        stream({ status: 'queued', openWaits: [wait('manual'), wait('dependency'), wait('question'), wait('review')] })
      )
    ).toBe('in_review')
    expect(selectWorkStreamPresentationState(stream({ openWaits: [wait('manual'), wait('dependency')] }))).toBe(
      'waiting_on_dependency'
    )
  })

  test('a workflow human-approval gate presents as review, not blocked', () => {
    const gate = { type: 'manual' as const, resolutionHandler: 'workflow' as const, flowAttemptId: 2 }
    expect(selectWorkStreamPresentationState(stream({ openWaits: [gate] }))).toBe('in_review')
    expect(selectWorkStreamPresentationState(stream({ openWaits: [wait('dependency'), gate] }))).toBe('in_review')
    expect(workStreamNeedsHumanAttention(stream({ openWaits: [gate] }))).toBe(true)
    // Whole-stream workflow waits (attempt limits) and ordinary manual waits still block.
    const limit = { type: 'manual' as const, resolutionHandler: 'workflow' as const, flowAttemptId: null }
    expect(selectWorkStreamPresentationState(stream({ openWaits: [limit] }))).toBe('blocked')
    expect(selectWorkStreamPresentationState(stream({ openWaits: [{ type: 'manual', flowAttemptId: 2 }] }))).toBe(
      'blocked'
    )
  })

  test('an explicit empty wait list overrides stale wait-derived state', () => {
    expect(
      selectWorkStreamPresentationState(stream({ status: 'queued', derivedState: 'blocked', openWaits: [] }))
    ).toBe('queued')
    expect(
      selectWorkStreamPresentationState(stream({ status: 'active', derivedState: 'in_review', openWaits: [] }))
    ).toBe('idle')
    expect(
      selectWorkStreamPresentationState(stream({ status: 'active', derivedState: 'in_progress', openWaits: [] }))
    ).toBe('in_progress')
    expect(
      selectWorkStreamPresentationState(stream({ status: 'active', derivedState: 'execution_failed', openWaits: [] }))
    ).toBe('execution_failed')
  })

  test('omitted waits use compatibility state and raw active remains explicit', () => {
    expect(selectWorkStreamPresentationState(stream({ derivedState: 'waiting_on_answer' }))).toBe('waiting_on_answer')
    expect(selectWorkStreamPresentationState(stream())).toBe('active')
  })
})

describe('workStreamNeedsHumanAttention', () => {
  test('uses authoritative waits when present', () => {
    expect(workStreamNeedsHumanAttention(stream({ openWaits: [wait('manual')] }))).toBe(true)
    expect(workStreamNeedsHumanAttention(stream({ openWaits: [wait('question')] }))).toBe(true)
    expect(workStreamNeedsHumanAttention(stream({ openWaits: [wait('review')] }))).toBe(true)
    expect(workStreamNeedsHumanAttention(stream({ derivedState: 'blocked', openWaits: [wait('dependency')] }))).toBe(
      false
    )
    expect(workStreamNeedsHumanAttention(stream({ derivedState: 'in_review', openWaits: [] }))).toBe(false)
  })

  test('supports payloads that omit open waits', () => {
    expect(workStreamNeedsHumanAttention(stream({ derivedState: 'in_review' }))).toBe(true)
    expect(workStreamNeedsHumanAttention(stream({ derivedState: 'waiting_on_answer' }))).toBe(true)
    expect(workStreamNeedsHumanAttention(stream({ derivedState: 'blocked' }))).toBe(true)
    expect(workStreamNeedsHumanAttention(stream({ derivedState: 'waiting_on_dependency' }))).toBe(false)
  })
})

describe('selectSandboxPresentationState', () => {
  test('projects runtime, readiness, and toolchain facts without choosing colors', () => {
    expect(selectSandboxPresentationState({ status: 'starting' })).toBe('starting')
    expect(selectSandboxPresentationState({ status: 'running', devboxReady: false })).toBe('installing_packages')
    expect(selectSandboxPresentationState({ status: 'running', toolchain: { status: 'running_setup' } })).toBe(
      'running_setup'
    )
    expect(selectSandboxPresentationState({ status: 'running', readiness: 'ready_degraded' })).toBe('degraded')
    expect(selectSandboxPresentationState({ status: 'running', toolchain: { status: 'failed' } })).toBe('failed')
    expect(selectSandboxPresentationState({ status: 'running', devboxReady: true })).toBe('running')
  })
})

describe('manual wait actors', () => {
  const manual = (actor?: string, extra: Partial<WorkStreamWait> = {}) => ({
    type: 'manual' as const,
    ...(actor ? { actor } : {}),
    ...extra,
  })

  test('each actor selects its own state; only human needs attention', () => {
    expect(MANUAL_WAIT_ACTOR_STATE).toEqual({
      human: 'blocked',
      owner: 'waiting_on_owner',
    })
    for (const [actor, state, attention] of [
      [undefined, 'blocked', true],
      ['human', 'blocked', true],
      ['owner', 'waiting_on_owner', false],
      // Unknown values, including the pre-rename 'manager', are human.
      ['manager', 'blocked', true],
      ['robot', 'blocked', true],
    ] as const) {
      const facts = { status: 'active' as const, openWaits: [manual(actor)] }
      expect({ actor, state: selectWorkStreamPresentationState(facts) }).toEqual({ actor, state })
      expect({ actor, attention: workStreamNeedsHumanAttention(facts) }).toEqual({ actor, attention })
    }
  })

  test('wait-type precedence is unchanged: a dependency still outranks an owner or human manual wait', () => {
    for (const actor of ['human', 'owner']) {
      expect(
        selectWorkStreamPresentationState({ status: 'active', openWaits: [manual(actor), { type: 'dependency' }] })
      ).toBe('waiting_on_dependency')
    }
  })

  test('a workflow human-approval gate is review whatever its actor', () => {
    const gate = manual('owner', { resolutionHandler: 'workflow', flowAttemptId: 3 })
    expect(selectWorkStreamPresentationState({ status: 'active', openWaits: [gate] })).toBe('in_review')
    expect(workStreamNeedsHumanAttention({ status: 'active', openWaits: [gate] })).toBe(true)
  })

  test('the delivery approval wait is still excluded before the remaining manual waits pick an actor', () => {
    const facts = {
      status: 'active' as const,
      delivery: { kind: 'approval' as const, approvalWaitId: 'approval' },
      openWaits: [
        { ...manual(undefined, { resolutionHandler: 'workflow' }), id: 'approval' },
        { ...manual('owner'), id: 'hold' },
      ],
    }
    expect(selectWorkStreamPresentationState(facts)).toBe('waiting_on_owner')
    expect(workStreamNeedsHumanAttention(facts)).toBe(false)
    // Only the approval wait: approval presentation, still human attention.
    const approvalOnly = { ...facts, openWaits: [facts.openWaits[0]!] }
    expect(selectWorkStreamPresentationState(approvalOnly)).toBe('delivery_approval')
    expect(workStreamNeedsHumanAttention(approvalOnly)).toBe(true)
  })

  test('legacy payloads without waits keep the historical blocked attention fallback', () => {
    expect(workStreamNeedsHumanAttention({ status: 'active', derivedState: 'blocked' })).toBe(true)
  })
})
