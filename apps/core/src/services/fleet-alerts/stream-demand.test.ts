import { expect, test } from 'bun:test'
import { createBlankWorkflow, createWorkflowRun } from '@ficus/shared'
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
    ...stream.state.definition.steps[0]!,
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
    stream.metadata = { codeHost: { integration: 'github', repository: 'ficushq/tau', changeRequest: { number: 1 } } }
    expect(hasRunnableStreamDemand(stream)).toBe(false)
  }
  stream.state.definition.completion = { mode: 'review-approval' }
  expect(hasRunnableStreamDemand(stream)).toBe(false)
})
