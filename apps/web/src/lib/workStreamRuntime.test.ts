import { describe, expect, test } from 'bun:test'
import { workStreamTimeDisplay } from './workStreamRuntime'
import type { WorkStream, WorkStreamViewer, WorkStreamWait } from '@ficus/shared'

// The time-worked and person-wait rules themselves are tested in @ficus/shared
// (packages/shared/src/work-stream-time.test.ts); these cover how a web row words them.

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

describe('workStreamTimeDisplay', () => {
  const now = Date.parse('2026-01-08T02:00:00Z')
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

  test('replaces time worked in the row, which moves to the tooltip', () => {
    const display = workStreamTimeDisplay(waiting([wait({})]), now, responder)
    expect(display).toMatchObject({
      kind: 'waiting',
      text: 'Waiting on you 7d',
      waitingMs: 7 * 86_400_000 + 2 * 3_600_000,
    })
    expect(display?.title).toStartWith('Waiting on you since ')
    expect(display?.title).toEndWith('. Time worked: 2h')
  })

  test('names the wait to a viewer who cannot act on it', () => {
    const review = waiting([wait({})])
    expect(workStreamTimeDisplay(review, now, viewer(['workstreams:read']))?.text).toBe('Waiting on review 7d')
    // Permissions still loading never claims the viewer.
    expect(workStreamTimeDisplay(review, now)?.text).toBe('Waiting on review 7d')
    const question = waiting([wait({ type: 'question', referenceId: 'q' })], { derivedState: 'waiting_on_answer' })
    expect(workStreamTimeDisplay(question, now, viewer(['workstreams:respond']))?.text).toBe('Waiting on an answer 7d')
    const blocker = waiting([wait({ type: 'manual', actor: 'human' })], { derivedState: 'blocked' })
    expect(workStreamTimeDisplay(blocker, now, viewer([]))?.text).toBe('Waiting on a person 7d')
  })

  test('shows time worked when nobody is waited on', () => {
    const dependency = waiting([wait({ type: 'dependency', referenceId: 'x' })], {
      derivedState: 'waiting_on_dependency',
    })
    expect(workStreamTimeDisplay(dependency, now, responder)).toEqual({
      kind: 'worked',
      text: '2h',
      title: 'Time worked: total time agents spent executing on this work stream',
      workedMs: 2 * 3_600_000,
    })
  })

  test('shows nothing before a second of work when nobody is waited on', () => {
    expect(workStreamTimeDisplay(baseWs, now)).toBeNull()
  })
})
