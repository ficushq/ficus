import { describe, expect, test } from 'bun:test'
import {
  mayDecideWorkflowGate,
  workflowGateApprover,
  workflowGateApproverForAttempt,
  workflowGateOfWait,
} from './workflow-gate-deciders'
import type { WorkflowRun } from './workflow-runtime'

const assigned = ['assigned-1', 'assigned-2']
const user = (userId: string) => ({ type: 'user', userId })
const limited = { kind: 'human-approval', approver: 'assigned-reviewers' }
const anyReviewer = { kind: 'human-approval', approver: 'reviewers' }
const decision = { kind: 'decision' }

describe('mayDecideWorkflowGate', () => {
  test('a squad owner with review permission decides unless the gate is limited to others', () => {
    expect(mayDecideWorkflowGate(user('owner'), true, assigned, anyReviewer)).toBe(true)
    expect(mayDecideWorkflowGate(user('owner'), true, assigned, decision)).toBe(true)
    expect(mayDecideWorkflowGate(user('owner'), true, [], limited)).toBe(true)
    expect(mayDecideWorkflowGate(user('owner'), true, assigned, limited)).toBe(false)
  })

  test('an assigned reviewer decides every gate', () => {
    for (const gate of [limited, anyReviewer, decision])
      expect(mayDecideWorkflowGate(user('assigned-2'), true, assigned, gate)).toBe(true)
  })

  test('an unassigned reviewer decides an any-reviewer gate, never one limited to the assigned reviewers', () => {
    expect(mayDecideWorkflowGate(user('other'), true, assigned, anyReviewer)).toBe(true)
    expect(mayDecideWorkflowGate(user('other'), true, assigned, decision)).toBe(true)
    expect(mayDecideWorkflowGate(user('other'), true, assigned, limited)).toBe(false)
    // With nobody assigned, an assigned-reviewers gate takes any reviewer.
    expect(mayDecideWorkflowGate(user('other'), true, undefined, limited)).toBe(true)
  })

  test('a viewer without review permission, an agent or an unknown viewer decides nothing', () => {
    for (const gate of [limited, anyReviewer, decision]) {
      expect(mayDecideWorkflowGate(user('assigned-1'), false, assigned, gate)).toBe(false)
      expect(mayDecideWorkflowGate({ type: 'agent' }, true, [], gate)).toBe(false)
      expect(mayDecideWorkflowGate(undefined, true, [], gate)).toBe(false)
      expect(mayDecideWorkflowGate({ type: 'user' }, true, [], gate)).toBe(false)
    }
  })
})

describe('the approver a gate wait carries', () => {
  const step = (id: string, kind: string, approver?: string) => ({
    id,
    kind,
    ...(approver ? { approver } : {}),
    instructions: 'Decide.',
    output: 'A decision.',
    outcomes: { approved: { next: 'finish' } },
  })
  const run = {
    definition: {
      steps: [
        step('design-approval', 'human-approval', 'reviewers'),
        step('approve', 'human-approval', 'assigned-reviewers'),
        step('route', 'decision'),
      ],
    },
    attempts: [
      { id: 1, stepId: 'design-approval', status: 'running' },
      { id: 2, stepId: 'approve', status: 'running' },
      { id: 3, stepId: 'route', status: 'running' },
      // An attempt keeps the step it started with, even after the definition changes.
      { id: 4, stepId: 'approve', status: 'running', step: step('approve', 'human-approval', 'reviewers') },
    ],
  } as unknown as WorkflowRun

  test("is the gate step's approver, and reviewers for a decision step", () => {
    expect(workflowGateApproverForAttempt(run, 1)).toBe('reviewers')
    expect(workflowGateApproverForAttempt(run, 2)).toBe('assigned-reviewers')
    expect(workflowGateApproverForAttempt(run, 3)).toBe('reviewers')
    expect(workflowGateApproverForAttempt(run, 4)).toBe('reviewers')
    expect(workflowGateApproverForAttempt(run, 9)).toBeUndefined()
    expect(workflowGateApprover({ kind: 'agent' })).toBeUndefined()
  })

  test('reads back as the same rule, and as limited when an older server sends none', () => {
    const decides = (approver?: 'assigned-reviewers' | 'reviewers') =>
      mayDecideWorkflowGate(user('other'), true, assigned, workflowGateOfWait({ workflowGateApprover: approver }))
    expect(decides('reviewers')).toBe(true)
    expect(decides('assigned-reviewers')).toBe(false)
    expect(decides(undefined)).toBe(false)
  })
})
