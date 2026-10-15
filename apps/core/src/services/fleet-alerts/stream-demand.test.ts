import { expect, test } from 'bun:test'
import { createBlankWorkflow, createWorkflowRun, type WorkflowStep } from '@ficus/shared'
import { hasRunnableStreamDemand } from './demand'

function candidate() {
  return {
    createdAt: new Date().toISOString(),
    metadata: {},
    participants: ['engineer'],
    busy: false,
    waits: [] as Array<{ flowAttemptId: number | null }>,
    state: createWorkflowRun(createBlankWorkflow()),
    attemptAgents: { '1': 'engineer' } as Record<string, string>,
  }
}

test('explicit workflow pauses and human approval attempts are not stalled agent work', () => {
  const stream = candidate()
  expect(hasRunnableStreamDemand(stream)).toBe(true)
  stream.state.status = 'paused'
  expect(hasRunnableStreamDemand(stream)).toBe(false)
  stream.state.status = 'running'
  stream.state.attempts[0]!.step = {
    ...(stream.state.definition.steps[0] as Extract<WorkflowStep, { kind: 'agent' }>),
    kind: 'human-approval',
    approver: 'assigned-reviewers',
  }
  expect(hasRunnableStreamDemand(stream)).toBe(false)
})

test('whole-stream waits block demand; attempt waits and human gates do not hide runnable siblings', () => {
  const stream = candidate()
  stream.waits = [{ flowAttemptId: 1 }]
  expect(hasRunnableStreamDemand(stream)).toBe(false)
  stream.state.attempts.push({ ...stream.state.attempts[0]!, id: 2 })
  stream.attemptAgents['2'] = 'sibling'
  stream.participants.push('sibling')
  expect(hasRunnableStreamDemand(stream)).toBe(true)
  stream.participants = ['engineer'] // sibling already has a live execution
  expect(hasRunnableStreamDemand(stream)).toBe(false)
  stream.participants.push('sibling')
  stream.waits.push({ flowAttemptId: null })
  expect(hasRunnableStreamDemand(stream)).toBe(false)
})

test('linked PR delivery is external, but missing PR setup remains actionable', () => {
  const stream = candidate()
  stream.state.status = 'completion-ready'
  for (const mode of ['pr-merge', 'pr-auto-merge'] as const) {
    stream.state.definition.completion = { mode, followChanges: true }
    stream.metadata = {}
    expect(hasRunnableStreamDemand(stream)).toBe(true)
    stream.metadata = { codeHost: { integration: 'github', repository: 'ficushq/ficus', changeRequest: { number: 1 } } }
    expect(hasRunnableStreamDemand(stream)).toBe(false)
  }
  stream.state.definition.completion = { mode: 'review-approval' }
  expect(hasRunnableStreamDemand(stream)).toBe(false)
})

test('an attempt agent supervising background work is not stalled; other attempts still are', () => {
  const stream = { ...candidate(), supervisingAgents: ['engineer'] }
  expect(hasRunnableStreamDemand(stream)).toBe(false)
  // Another agent's live monitor does not cover this attempt's agent.
  stream.supervisingAgents = ['someone-else']
  expect(hasRunnableStreamDemand(stream)).toBe(true)
  // A sibling attempt whose agent is idle without supervised work remains demand.
  stream.supervisingAgents = ['engineer']
  stream.state.attempts.push({ ...stream.state.attempts[0]!, id: 2 })
  stream.attemptAgents['2'] = 'sibling'
  stream.participants.push('sibling')
  expect(hasRunnableStreamDemand(stream)).toBe(true)
  // An undispatched attempt has no agent to supervise anything.
  delete stream.attemptAgents['2']
  stream.participants = ['engineer']
  expect(hasRunnableStreamDemand(stream)).toBe(true)
})

test('stream-level demand without a flow attempt owner honors any stream agent supervising work', () => {
  const stream = { ...candidate(), supervisingAgents: ['engineer'] }
  stream.state.status = 'completion-ready'
  stream.state.definition.completion = { mode: 'pr-auto-merge', followChanges: true }
  expect(hasRunnableStreamDemand(stream)).toBe(false)
  stream.supervisingAgents = []
  expect(hasRunnableStreamDemand(stream)).toBe(true)
  const legacy = { ...candidate(), state: null, supervisingAgents: ['engineer'] }
  expect(hasRunnableStreamDemand(legacy)).toBe(false)
  legacy.supervisingAgents = []
  expect(hasRunnableStreamDemand(legacy)).toBe(true)
})
