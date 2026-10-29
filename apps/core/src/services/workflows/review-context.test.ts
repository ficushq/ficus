import { expect, test } from 'bun:test'
import { createBlankWorkflow, createWorkflowRun, advanceWorkflowRun } from '@ficus/shared'
import { producerReviewContexts } from './review-context'

test('review context keeps prior empty-note decisions, multi-hop return reasons and exact interruptions', () => {
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes.completed = { next: 'gate' }
  definition.steps.push({
    id: 'gate',
    kind: 'human-approval',
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
