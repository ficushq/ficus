import { expect, test } from 'bun:test'
import { createBlankWorkflow, createWorkflowRun, advanceWorkflowRun } from '@ficus/shared'
import { producerReviewContexts } from './review-context'

test('review context keeps prior empty-note decisions, multi-hop return reasons and exact interruptions', () => {
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes.completed = { next: 'gate' }
  definition.steps.push({
    id: 'gate',
    kind: 'human-approval',
    approver: 'reviewers',
    instructions: 'Review design.',
    output: 'Decision.',
    approver: 'reviewers',
    outcomes: { redo: { returnTo: 'execute', afterRework: 'return-to-requester' }, yes: { next: 'finish' } },
  })
  let run = createWorkflowRun(definition)
  const brief = {
    decision: 'Approve the staging design.',
    recommendation: 'Approve because the fallback is tested.',
    approvalEffect: 'Approval permits staging implementation only, not deployment.',
    risks: 'Temporary maintenance work increases.',
  }
  run = advanceWorkflowRun(run, {
    action: 'complete',
    expectedVersion: 0,
    attemptId: 1,
    outcome: 'completed',
    evidence: 'Audit record.',
    decisionBrief: brief,
  })
  run = advanceWorkflowRun(run, {
    action: 'complete',
    expectedVersion: 1,
    attemptId: 2,
    outcome: 'redo',
    evidence: 'The fallback must support the older reader.',
  })
  const contexts = producerReviewContexts(run, run.attempts[2]!, [
    { executionId: 'failure-a', attemptId: 3, status: 'failed', endedAt: '2026-10-29T00:01:00Z' },
    { executionId: 'failure-b', attemptId: 3, status: 'stopped', endedAt: '2026-10-29T00:02:00Z' },
    { executionId: 'unrelated', attemptId: 99, status: 'failed', endedAt: '2026-10-29T00:02:00Z' },
  ])
  expect(contexts[0]).toMatchObject({
    gateStepId: 'gate',
    previousDecisions: [{ attemptId: 2, outcome: 'redo', notes: 'The fallback must support the older reader.' }],
  })
  expect(contexts[0]!.returns.map((r) => r.feedback)).toEqual(['The fallback must support the older reader.'])
  expect(contexts[0]!.interruptedExecutions.map((e) => e.executionId)).toEqual(['failure-a', 'failure-b'])
})

test('decision intervals use receipt time, not creation order, for a still-running parallel producer', () => {
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes.completed = { next: 'gate' }
  definition.steps.push({
    id: 'gate',
    kind: 'human-approval',
    approver: 'reviewers',
    instructions: 'Review staging.',
    output: 'Decision.',
    outcomes: { yes: { next: 'finish' } },
  })
  const run = createWorkflowRun(definition)
  run.attempts.push({ id: 2, stepId: 'gate', status: 'completed', outcome: 'yes', settledVersion: 3 })
  const context = producerReviewContexts(
    run,
    run.attempts[0]!,
    [
      { executionId: 'before', attemptId: 1, status: 'failed', endedAt: '2026-10-29T00:00:00Z' },
      { executionId: 'after', attemptId: 1, status: 'stopped', endedAt: '2026-10-29T00:02:00Z' },
    ],
    {},
    { 2: '2026-10-29T00:01:00Z' }
  )
  expect(context[0]!.interruptedExecutions.map((e) => e.executionId)).toEqual(['after'])
})

test('a causal return settled after the last decision is retained even when its requester was created first', () => {
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes.completed = { next: 'gate' }
  definition.steps.push({
    id: 'gate',
    kind: 'human-approval',
    approver: 'reviewers',
    instructions: 'Review staging.',
    output: 'Decision.',
    outcomes: { yes: { next: 'finish' } },
  })
  const run = createWorkflowRun(definition)
  run.attempts.push(
    { id: 3, stepId: 'execute', status: 'returned', settledVersion: 7 },
    { id: 4, stepId: 'gate', status: 'completed', outcome: 'yes', settledVersion: 6 },
    { ...run.attempts[0]!, id: 5, sourceAttemptIds: [3] }
  )
  run.returns.push({
    id: 1,
    requestedByAttemptId: 3,
    parentId: null,
    targetStepId: 'execute',
    resumeAt: 'gate',
    feedback: 'Retain the older reader after the parallel review.',
    status: 'open',
  })
  const contexts = producerReviewContexts(run, run.attempts.at(-1)!)
  expect(contexts[0]!.returns.map((r) => r.id)).toEqual([1])
})

test('return-only human destinations receive prior decisions and interruption context', () => {
  const definition = createBlankWorkflow()
  definition.routing = { mode: 'flexible', returnTo: 'earlier-steps', delegation: 'disabled' }
  definition.entry = 'gate'
  definition.steps.push({
    id: 'gate',
    kind: 'human-approval',
    approver: 'reviewers',
    instructions: 'Review staging.',
    output: 'Decision.',
    outcomes: { yes: { next: 'execute' } },
  })
  const run = advanceWorkflowRun(createWorkflowRun(definition), {
    action: 'complete',
    expectedVersion: 0,
    attemptId: 1,
    outcome: 'yes',
    evidence: '',
  })
  const contexts = producerReviewContexts(run, run.attempts.at(-1)!, [
    { executionId: 'synthetic-stop', attemptId: 2, status: 'stopped', endedAt: '2026-10-29T00:02:00Z' },
  ])
  expect(contexts[0]).toMatchObject({
    gateStepId: 'gate',
    outcomes: [],
    viaReturn: true,
    previousDecisions: [{ attemptId: 1 }],
  })
  expect(contexts[0]!.interruptedExecutions).toHaveLength(1)
})
