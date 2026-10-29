import { expect, test } from 'bun:test'
import { createBlankWorkflow } from './workflow-editing'
import { workflowStepSchema } from './workflows'
import { advanceWorkflowRun, createWorkflowRun, reopenWorkflowRun, type WorkflowRun } from './workflow-runtime'
import { brief } from './test-fixtures/workflow-review'
import { workflowEarlierHumanDecisions, workflowReviewBriefForAttempt } from './workflow-review-history'

function flow() {
  const def = createBlankWorkflow()
  def.steps[0]!.outcomes = { ready: { next: 'gate' }, ordinary: { next: 'finish' } }
  def.steps.push(
    workflowStepSchema.parse({
      id: 'gate',
      kind: 'human-approval',
      instructions: 'Review the design.',
      output: 'Decision.',
      outcomes: { yes: { next: 'second' }, again: { returnTo: 'execute', afterRework: 'return-to-requester' } },
    })
  )
  def.steps.push(
    workflowStepSchema.parse({
      id: 'second',
      kind: 'human-approval',
      instructions: 'Review the rollout.',
      output: 'Decision.',
      outcomes: { yes: { next: 'finish' } },
    })
  )
  return createWorkflowRun(def)
}
function complete(
  run: WorkflowRun,
  outcome: string,
  decisionBrief?: typeof brief & { changesSinceLastReview?: string }
) {
  return advanceWorkflowRun(run, {
    action: 'complete',
    expectedVersion: run.version,
    attemptId: run.activeAttemptId,
    outcome,
    evidence: 'Detailed audit record.',
    ...(decisionBrief ? { decisionBrief } : {}),
  })
}
test('agent-to-human requires a brief atomically; agent-only does not', () => {
  const run = flow()
  const before = structuredClone(run)
  expect(() => complete(run, 'ready')).toThrow('A decisionBrief is required')
  expect(run).toEqual(before)
  expect(complete(run, 'ordinary').status).toBe('completion-ready')
  const accepted = complete(run, 'ready', brief)
  expect(accepted.attempts[0]!.decisionBrief?.value).toEqual(brief)
  expect(accepted.attempts[1]!.reviewBrief).toEqual({ kind: 'authored', sourceAttemptIds: [1] })
})
test('earlier decisions include empty-note approval and human return, across reopen', () => {
  let run = complete(flow(), 'ready', brief)
  run = advanceWorkflowRun(run, {
    action: 'complete',
    expectedVersion: run.version,
    attemptId: 2,
    outcome: 'yes',
    evidence: '',
  })
  expect(workflowEarlierHumanDecisions(run, 'gate').map((a) => a.id)).toEqual([2])
  run = reopenWorkflowRun(run)
  expect(() => complete(run, 'ready', brief)).toThrow('changesSinceLastReview')
  expect(() =>
    complete(run, 'ready', {
      ...brief,
      changesSinceLastReview:
        'The previous design was approved. The retry keeps the same scope after a stopped execution.',
    })
  ).not.toThrow()
})
test('non-agent routing carries a read-only source within current producing lineage', () => {
  let run = complete(flow(), 'ready', brief)
  run = complete(run, 'yes')
  expect(workflowReviewBriefForAttempt(run, run.attempts[2]!)).toMatchObject({
    kind: 'carried-forward',
    sources: [{ id: 1 }],
  })
  expect(run.attempts[2]!.reviewBrief).toEqual({ kind: 'carried-forward', sourceAttemptId: 1 })
  const reopened = reopenWorkflowRun(run)
  const synthetic = { ...run.attempts[2]!, reviewBrief: undefined }
  expect(workflowReviewBriefForAttempt(reopened, synthetic)).toEqual({ kind: 'none', sources: [] })
})
test('legacy agent arrival remains legacy; non-agent missing brief is explicit', () => {
  const run = flow()
  run.attempts[0]!.status = 'completed'
  const gate = { id: 2, stepId: 'gate', status: 'running' as const, sourceAttemptIds: [1] }
  run.attempts.push(gate)
  expect(workflowReviewBriefForAttempt(run, gate).kind).toBe('legacy')
  run.attempts.push({ id: 3, stepId: 'second', status: 'running', sourceAttemptIds: [2] })
  run.attempts[1]!.status = 'completed'
  expect(workflowReviewBriefForAttempt(run, run.attempts[2]!).kind).toBe('none')
})
test('effective return resumes require repeat brief rather than using stale next', () => {
  let run = complete(flow(), 'ready', brief)
  run = complete(run, 'again')
  expect(() => complete(run, 'ordinary')).toThrow('decisionBrief')
  expect(() => complete(run, 'ordinary', brief)).toThrow('changesSinceLastReview')
  expect(workflowEarlierHumanDecisions(run, 'gate').map((a) => a.id)).toEqual([2])
})

test('entry human gate has explicit none; pending gate retains authored binding', () => {
  const definition = flow().definition
  definition.entry = 'gate'
  expect(createWorkflowRun(definition).attempts[0]!.reviewBrief).toEqual({ kind: 'none' })
  definition.entry = 'execute'
  definition.limits.maxStepAttempts = 1
  let run = complete(flow(), 'ready', brief)
  run = complete(run, 'again')
  run.definition.limits.maxStepAttempts = 1
  const changed = {
    ...brief,
    changesSinceLastReview: 'The reviewer requested rework. This version addresses those findings.',
  }
  run = complete(run, 'ready', changed)
  expect(run.status).toBe('paused')
  run = advanceWorkflowRun(run, {
    action: 'revise',
    expectedVersion: run.version,
    attemptId: null,
    active: 'keep',
    reason: 'Allow another review round.',
    operations: [{ op: 'set-limits', limits: { ...run.definition.limits, maxStepAttempts: 5 } }],
  })
  expect(run.attempts.at(-1)!.reviewBrief).toEqual({ kind: 'authored', sourceAttemptIds: [3] })
})
test('both early and last agent arrivals at a human join require briefs', () => {
  const definition = flow().definition
  definition.steps[0]!.outcomes = { ready: { parallel: ['left', 'right'], join: 'gate' } }
  for (const id of ['left', 'right'])
    definition.steps.push(
      workflowStepSchema.parse({ ...definition.steps[0], id, outcomes: { ready: { next: 'gate' } } })
    )
  let run = complete(createWorkflowRun(definition), 'ready')
  const finishBranch = (state: WorkflowRun, id: number, value?: typeof brief) =>
    advanceWorkflowRun(state, {
      action: 'complete',
      expectedVersion: state.version,
      attemptId: id,
      outcome: 'ready',
      evidence: 'Branch review evidence.',
      decisionBrief: value,
    })
  expect(() => finishBranch(run, 2)).toThrow('decisionBrief')
  run = finishBranch(run, 2, brief)
  expect(() => finishBranch(run, 3)).toThrow('decisionBrief')
  run = finishBranch(run, 3, brief)
  expect(run.attempts.at(-1)!.reviewBrief).toEqual({ kind: 'authored', sourceAttemptIds: [2, 3] })
})

test('carry-forward uses newest eligible joined lineage, never a previous producer or another run', () => {
  const run = flow()
  const base = run.attempts[0]!
  run.attempts = [
    { ...base, id: 1, status: 'completed', decisionBrief: { value: brief, submittedVersion: 1, contexts: [] } },
    { ...base, id: 2, status: 'completed', sourceAttemptIds: [1] },
    { id: 3, stepId: 'gate', status: 'completed', sourceAttemptIds: [2] },
    { id: 4, stepId: 'second', status: 'running', sourceAttemptIds: [3] },
  ]
  expect(workflowReviewBriefForAttempt(run, run.attempts[3]!)).toEqual({ kind: 'none', sources: [] })
  const otherRun = flow()
  otherRun.attempts[0]!.decisionBrief = { value: brief, submittedVersion: 100, contexts: [] }
  expect(workflowReviewBriefForAttempt(run, run.attempts[3]!)).toEqual({ kind: 'none', sources: [] })
  run.attempts[1]!.decisionBrief = { value: brief, submittedVersion: 2, contexts: [] }
  expect(workflowReviewBriefForAttempt(run, run.attempts[3]!).sources.map((a) => a.id)).toEqual([2])
  run.attempts.push({
    ...base,
    id: 5,
    status: 'completed',
    decisionBrief: { value: brief, submittedVersion: 3, contexts: [] },
  })
  run.attempts[3]!.sourceAttemptIds = [3, 5]
  run.attempts[3]!.reviewBrief = { kind: 'carried-forward', sourceAttemptId: 5 }
  expect(workflowReviewBriefForAttempt(run, run.attempts[3]!).sources.map((a) => a.id)).toEqual([5])
})
test('recorded carried brief history survives reopen without lending it to the new pass', () => {
  let run = complete(flow(), 'ready', brief)
  run = complete(run, 'yes')
  const historicalGate = run.attempts[2]!
  const reopened = reopenWorkflowRun(run)
  expect(workflowReviewBriefForAttempt(reopened, historicalGate).sources.map((a) => a.id)).toEqual([1])
})
