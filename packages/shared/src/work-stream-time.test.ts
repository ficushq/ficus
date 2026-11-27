import { describe, expect, test } from 'bun:test'
import type { WorkStream, WorkStreamWait } from './types'
import {
  RUNTIME_STALE_AFTER_MS,
  computeWorkStreamElapsedMs,
  formatWaitedDuration,
  formatWorkStreamDuration,
  mayRespondToWorkStreamWaits,
  PERSON_WAIT_NOUN,
  viewerCanActOnWait,
  workStreamPersonWait,
  workStreamTimeTickMs,
  workStreamWaitsOnViewer,
  type WorkStreamViewer,
} from './work-stream-time'

const baseWs = {
  id: 'ws-1',
  squadId: 's',
  title: 't',
  description: '',
  status: 'active',
  derivedState: 'in_progress',
  assigneeAgentId: null,
  ownerAgentId: null,
  agentIds: ['a'],
  dependsOn: [],
  handoffMessage: null,
  files: [],
  response: null,
  metadata: {},
  completionMode: 'pr-merge',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
} as unknown as WorkStream

describe('computeWorkStreamElapsedMs', () => {
  test('returns 0 when there is no runtime field', () => {
    expect(computeWorkStreamElapsedMs(baseWs, Date.now())).toBe(0)
  })

  test('returns settled totalMs when activeCount is zero', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 12_345, activeCount: 0, computedAt: '2026-01-01T00:00:00Z' },
    }
    expect(computeWorkStreamElapsedMs(ws, Date.parse('2026-01-01T00:01:00Z'))).toBe(12_345)
  })

  test('adds activeCount * (now - computedAt) when there are active executions', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 1000, activeCount: 2, computedAt: '2026-01-01T00:00:00Z' },
    }
    const now = Date.parse('2026-01-01T00:00:05Z')
    expect(computeWorkStreamElapsedMs(ws, now)).toBe(1000 + 2 * 5_000)
  })

  test('keeps the settled total when computedAt cannot be read', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 7_000, activeCount: 1, workingCount: 1, computedAt: 'not a date' },
    }
    expect(computeWorkStreamElapsedMs(ws, Date.parse('2026-01-01T00:00:05Z'))).toBe(7_000)
  })

  test('clamps negative deltas (clock skew) to zero', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 7_000, activeCount: 1, computedAt: '2026-01-01T00:01:00Z' },
    }
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(computeWorkStreamElapsedMs(ws, now)).toBe(7_000)
  })
})

describe('time worked extrapolation', () => {
  test('ticks only for working executions, not for ones waiting on a sandbox or left stale', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 1000, activeCount: 2, workingCount: 0, computedAt: '2026-01-01T00:00:00Z' },
    }
    expect(computeWorkStreamElapsedMs(ws, Date.parse('2026-01-01T01:00:00Z'))).toBe(1000)
    expect(workStreamTimeTickMs(ws)).toBeNull()
  })

  test('never extrapolates past the server stale bound before the next refetch', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 1000, activeCount: 1, workingCount: 1, computedAt: '2026-01-01T00:00:00Z' },
    }
    expect(RUNTIME_STALE_AFTER_MS).toBe(90 * 60_000)
    expect(computeWorkStreamElapsedMs(ws, Date.parse('2026-01-01T05:00:00Z'))).toBe(1000 + 90 * 60_000)
  })

  test('extrapolates from workingCount when the server sends it', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 1000, activeCount: 2, workingCount: 1, computedAt: '2026-01-01T00:00:00Z' },
    }
    expect(computeWorkStreamElapsedMs(ws, Date.parse('2026-01-01T00:00:05Z'))).toBe(6000)
    expect(workStreamTimeTickMs(ws)).toBe(1000)
  })
})

describe('formatting', () => {
  test('time worked keeps two units', () => {
    expect(formatWorkStreamDuration(45_000)).toBe('45s')
    expect(formatWorkStreamDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3h 5m')
    expect(formatWorkStreamDuration((7 * 24 + 2) * 3_600_000)).toBe('7d 2h')
    expect(formatWorkStreamDuration(-500)).toBe('0s')
  })

  test('waiting time keeps one coarse unit', () => {
    expect(formatWaitedDuration(30_000)).toBe('<1m')
    expect(formatWaitedDuration(12 * 60_000)).toBe('12m')
    expect(formatWaitedDuration(5 * 3_600_000 + 59 * 60_000)).toBe('5h')
    expect(formatWaitedDuration((7 * 24 + 2) * 3_600_000)).toBe('7d')
    expect(formatWaitedDuration(-5)).toBe('<1m')
  })

  test('names what a person is waited on for', () => {
    expect(PERSON_WAIT_NOUN).toEqual({
      answer: 'an answer',
      review: 'review',
      approval: 'approval',
      blocker: 'a person',
    })
  })
})

describe('mayRespondToWorkStreamWaits', () => {
  const holding =
    (...held: string[]) =>
    (permission: string) =>
      held.includes(permission)

  test('takes workstreams:respond or workstreams:update', () => {
    expect(mayRespondToWorkStreamWaits(holding('workstreams:respond'))).toBe(true)
    expect(mayRespondToWorkStreamWaits(holding('workstreams:update'))).toBe(true)
    expect(mayRespondToWorkStreamWaits(holding('workstreams:read', 'workstreams:review', 'agents:run'))).toBe(false)
    expect(mayRespondToWorkStreamWaits(holding())).toBe(false)
  })
})

describe('waiting on a person', () => {
  const wait = (overrides: Partial<WorkStreamWait>): WorkStreamWait =>
    ({
      id: 'w',
      workStreamId: 'ws-1',
      type: 'review',
      referenceId: null,
      message: null,
      createdBy: 'agent',
      createdByAgentId: null,
      createdByUserId: null,
      completesOnApproval: true,
      openedAt: '2026-01-01T00:00:00Z',
      closedAt: null,
      resolution: null,
      resolutionNote: null,
      ...overrides,
    }) as WorkStreamWait
  const waiting = (openWaits: WorkStreamWait[], overrides: Partial<WorkStream> = {}): WorkStream => ({
    ...baseWs,
    derivedState: 'in_review',
    openWaits,
    runtime: { totalMs: 2 * 3_600_000, activeCount: 0, workingCount: 0, computedAt: '2026-01-01T00:00:00Z' },
    ...overrides,
  })

  const viewer = (permissions: string[], userId = 'user-1'): WorkStreamViewer => ({
    can: (permission) => permissions.includes(permission),
    identity: { type: 'user', userId },
  })
  const responder = viewer(['workstreams:respond', 'agents:run'])

  test('dates from the oldest open wait that asks a person to act', () => {
    const ws = waiting([
      wait({ id: 'newer', type: 'manual', actor: 'human', openedAt: '2026-01-05T00:00:00Z' }),
      wait({ id: 'older', type: 'question', referenceId: 'q', openedAt: '2026-01-01T00:00:00Z' }),
      wait({ id: 'agent', type: 'dependency', referenceId: 'x', openedAt: '2025-12-01T00:00:00Z' }),
    ])
    expect(workStreamPersonWait(ws, responder)).toEqual({
      since: new Date('2026-01-01T00:00:00Z'),
      you: true,
      kind: 'answer',
      label: 'Waiting on you',
    })
  })

  test('ticks every minute while a person is waited on', () => {
    expect(workStreamTimeTickMs(waiting([wait({})]))).toBe(60_000)
  })

  test('says "you" only for a wait the viewer can act on, and names the wait otherwise', () => {
    const review = waiting([wait({})])
    expect(workStreamPersonWait(review, viewer(['workstreams:read']))?.label).toBe('Waiting on review')
    // Permissions still loading never claims the viewer.
    expect(workStreamPersonWait(review)).toMatchObject({ you: false, kind: 'review', label: 'Waiting on review' })
    // Answering a question takes agents:run, not workstreams:respond.
    const question = waiting([wait({ type: 'question', referenceId: 'q' })], { derivedState: 'waiting_on_answer' })
    expect(workStreamPersonWait(question, viewer(['workstreams:respond']))?.label).toBe('Waiting on an answer')
    expect(workStreamPersonWait(question, viewer(['agents:run']))?.label).toBe('Waiting on you')
    const blocker = waiting([wait({ type: 'manual', actor: 'human' })], { derivedState: 'blocked' })
    expect(workStreamPersonWait(blocker, viewer([]))?.label).toBe('Waiting on a person')
    expect(workStreamPersonWait(blocker, viewer(['workstreams:update']))?.label).toBe('Waiting on you')
  })

  test('prefers the wait the viewer can act on over an older one they cannot', () => {
    const ws = waiting([
      wait({ id: 'question', type: 'question', referenceId: 'q', openedAt: '2026-01-01T00:00:00Z' }),
      wait({ id: 'blocker', type: 'manual', actor: 'human', openedAt: '2026-01-07T02:00:00Z' }),
    ])
    expect(workStreamPersonWait(ws, viewer(['workstreams:respond']))).toEqual({
      since: new Date('2026-01-07T02:00:00Z'),
      you: true,
      kind: 'blocker',
      label: 'Waiting on you',
    })
  })

  test('viewerCanActOnWait answers for one wait, and never for an unknown viewer', () => {
    const question = wait({ id: 'question', type: 'question', referenceId: 'q' })
    const dependency = wait({ id: 'dependency', type: 'dependency', referenceId: 'x' })
    const ws = waiting([question, dependency], { derivedState: 'waiting_on_answer' })
    expect(viewerCanActOnWait(question, ws, viewer(['agents:run']))).toBe(true)
    expect(viewerCanActOnWait(question, ws, viewer(['workstreams:respond']))).toBe(false)
    expect(viewerCanActOnWait(question, ws)).toBe(false)
    expect(viewerCanActOnWait(dependency, ws, viewer(['agents:run', 'workstreams:respond']))).toBe(false)
  })

  test('a workflow gate on a stream with assigned reviewers is "you" only to them', () => {
    const gate = wait({ type: 'manual', workflowHumanGate: true, flowAttemptId: 2, resolutionHandler: 'workflow' })
    const ws = waiting([gate], { assignedReviewerIds: ['reviewer-1'] })
    expect(workStreamPersonWait(ws, viewer(['workstreams:review'], 'reviewer-1'))?.label).toBe('Waiting on you')
    expect(workStreamPersonWait(ws, viewer(['workstreams:review'], 'someone-else'))?.label).toBe('Waiting on review')
    expect(workStreamPersonWait(ws, viewer(['workstreams:respond'], 'reviewer-1'))?.label).toBe('Waiting on review')
  })

  test('a workflow gate follows the shared mayDecideWorkflowGate rule for the approver on the wait', () => {
    const gate = (approver?: 'reviewers' | 'assigned-reviewers') =>
      wait({
        type: 'manual',
        workflowHumanGate: true,
        flowAttemptId: 2,
        resolutionHandler: 'workflow',
        ...(approver ? { workflowGateApprover: approver } : {}),
      })
    const reviewer = viewer(['workstreams:review'], 'someone-else')
    // A gate any reviewer decides is theirs even when the stream names assigned reviewers.
    const anyReviewer = waiting([gate('reviewers')], { assignedReviewerIds: ['reviewer-1'] })
    expect(workStreamPersonWait(anyReviewer, reviewer)?.label).toBe('Waiting on you')
    // An older server leaves the approver off; that reads as limited to the assigned reviewers.
    const unknownApprover = waiting([gate()], { assignedReviewerIds: ['reviewer-1'] })
    expect(workStreamPersonWait(unknownApprover, reviewer)?.label).toBe('Waiting on review')
    // Agents never decide a gate, whatever permissions they hold.
    const agent: WorkStreamViewer = { can: () => true, identity: { type: 'agent' } }
    expect(workStreamPersonWait(waiting([gate('reviewers')]), agent)?.label).toBe('Waiting on review')
  })

  test('the delivery approval is a wait on a person too', () => {
    const ws = waiting([wait({ id: 'approval', type: 'manual', actor: 'human' })], {
      derivedState: 'blocked',
      delivery: { kind: 'approval', approvalWaitId: 'approval' },
    })
    expect(workStreamPersonWait(ws, responder)).toMatchObject({ kind: 'approval', label: 'Waiting on you' })
    expect(workStreamPersonWait(ws, viewer([]))?.label).toBe('Waiting on approval')
  })

  test('workStreamWaitsOnViewer counts a stream only for a viewer who can act on one of its person waits', () => {
    const gate = wait({
      type: 'manual',
      workflowHumanGate: true,
      flowAttemptId: 2,
      resolutionHandler: 'workflow',
      workflowGateApprover: 'assigned-reviewers',
    })
    const review = waiting([gate], { assignedReviewerIds: ['reviewer-1'] })
    expect(workStreamWaitsOnViewer(review, viewer(['workstreams:review'], 'reviewer-1'))).toBe(true)
    expect(workStreamWaitsOnViewer(review, viewer(['workstreams:review'], 'someone-else'))).toBe(false)
    expect(workStreamWaitsOnViewer(review)).toBe(false)
    // A question and a gate: the viewer who can answer is waited on, a reviewer outside the gate is not.
    const both = waiting([gate, wait({ id: 'q', type: 'question', referenceId: 'q' })], {
      assignedReviewerIds: ['reviewer-1'],
    })
    expect(workStreamWaitsOnViewer(both, viewer(['agents:run'], 'someone-else'))).toBe(true)
    expect(workStreamWaitsOnViewer(both, viewer(['workstreams:review'], 'someone-else'))).toBe(false)
    // The delivery approval follows its wait too.
    const approval = waiting([wait({ id: 'approval', type: 'manual', actor: 'human' })], {
      derivedState: 'blocked',
      delivery: { kind: 'approval', approvalWaitId: 'approval' },
    })
    expect(workStreamWaitsOnViewer(approval, responder)).toBe(true)
    expect(workStreamWaitsOnViewer(approval, viewer([]))).toBe(false)
  })

  test('workStreamWaitsOnViewer: a code-host review or merge with no open wait waits on every viewer', () => {
    const merge = waiting([], { derivedState: 'in_review', delivery: { kind: 'merge' } })
    expect(workStreamWaitsOnViewer(merge, viewer([]))).toBe(true)
    expect(workStreamWaitsOnViewer(merge)).toBe(false)
    const dependency = waiting([wait({ type: 'dependency', referenceId: 'x' })], {
      derivedState: 'waiting_on_dependency',
    })
    expect(workStreamWaitsOnViewer(dependency, responder)).toBe(false)
  })

  test('workStreamWaitsOnViewer: a code-host review or merge waits on every viewer whatever other waits are open', () => {
    // A question this viewer cannot answer (no agents:run) next to the pull request at the code host.
    const question = wait({ id: 'q', type: 'question', referenceId: 'q' })
    const cannotAnswer = viewer(['workstreams:read'])
    for (const kind of ['review', 'merge'] as const) {
      const mixed = waiting([question], { derivedState: 'waiting_on_answer', delivery: { kind } })
      expect(viewerCanActOnWait(question, mixed, cannotAnswer)).toBe(false)
      expect(workStreamWaitsOnViewer(mixed, cannotAnswer)).toBe(true)
      // The same pull request alone counts for that viewer too.
      const alone = waiting([], { derivedState: 'in_review', delivery: { kind } })
      expect(workStreamWaitsOnViewer(alone, cannotAnswer)).toBe(true)
      // An unknown viewer is still never "you".
      expect(workStreamWaitsOnViewer(mixed)).toBe(false)
    }
    // Without the code host, the unanswerable question alone does not wait on them.
    const questionOnly = waiting([question], { derivedState: 'waiting_on_answer' })
    expect(workStreamWaitsOnViewer(questionOnly, cannotAnswer)).toBe(false)
  })

  test('a dependency, an owner hold, a paused or a finished stream is not waiting on a person', () => {
    const dependency = waiting([wait({ type: 'dependency', referenceId: 'x' })], {
      derivedState: 'waiting_on_dependency',
    })
    const ownerHold = waiting([wait({ type: 'manual', actor: 'owner' })], { derivedState: 'blocked' })
    const paused = waiting([wait({})], { pause: { pausedAt: '2026-01-02T00:00:00Z' } as WorkStream['pause'] })
    const done = waiting([wait({})], { status: 'done', derivedState: 'done' })
    for (const ws of [dependency, ownerHold, paused, done]) {
      expect(workStreamPersonWait(ws, responder)).toBeNull()
      expect(workStreamWaitsOnViewer(ws, responder)).toBe(false)
      expect(workStreamTimeTickMs(ws)).toBeNull()
    }
  })
})
