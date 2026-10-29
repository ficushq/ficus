import { expect, test } from 'bun:test'
import { createBlankWorkflow } from './workflow-editing'
import { workflowStepSchema } from './workflows'
import { createWorkflowRun, advanceWorkflowRun } from './workflow-runtime'
import { workflowReviewBriefForAttempt } from './workflow-review-history'
import { brief } from './test-fixtures/workflow-review'

test('agent explicit return into human approval cannot bypass the decision brief contract', () => {
  const definition = createBlankWorkflow()
  definition.entry = 'gate'
  definition.steps[0]!.outcomes = {
    recheck: { returnTo: 'gate', afterRework: 'return-to-requester' },
    done: { next: 'finish' },
  }
  definition.steps.push(
    workflowStepSchema.parse({
      id: 'gate',
      kind: 'human-approval',
      instructions: 'Review staging.',
      output: 'Decision.',
      outcomes: { yes: { next: 'execute' } },
    })
  )
  let run = createWorkflowRun(definition)
  run = advanceWorkflowRun(run, { action: 'complete', expectedVersion: 0, attemptId: 1, outcome: 'yes', evidence: '' })
  expect(() =>
    advanceWorkflowRun(run, {
      action: 'complete',
      expectedVersion: 1,
      attemptId: 2,
      outcome: 'recheck',
      evidence: 'Review the revised staging scope.',
    })
  ).toThrow('decisionBrief')
  expect(() =>
    advanceWorkflowRun(run, {
      action: 'return',
      expectedVersion: 1,
      attemptId: 2,
      targetStepId: 'gate',
      resumeAt: 'execute',
      feedback: 'Review the revised staging scope.',
    })
  ).toThrow('decisionBrief')
})

test('restarting a non-agent gate does not borrow a brief across the fresh-session boundary', () => {
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes = { ready: { next: 'gate' } }
  definition.steps.push(
    workflowStepSchema.parse({
      id: 'gate',
      kind: 'human-approval',
      instructions: 'Review staging.',
      output: 'Decision.',
      outcomes: { yes: { next: 'finish' } },
    })
  )
  let run = createWorkflowRun(definition)
  run = advanceWorkflowRun(run, {
    action: 'complete',
    expectedVersion: 0,
    attemptId: 1,
    outcome: 'ready',
    evidence: 'Audit evidence.',
    decisionBrief: brief,
  })
  run = advanceWorkflowRun(run, {
    action: 'revise',
    expectedVersion: 1,
    attemptId: 2,
    active: 'restart',
    reason: 'Restart the gate for a new review session.',
    operations: [
      { op: 'put-step', step: { ...definition.steps[1]!, instructions: 'Review a different staging scope.' } },
    ],
  })
  expect(run.attempts.at(-1)!.freshSession).toBe(true)
  expect(workflowReviewBriefForAttempt(run, run.attempts.at(-1)!)).toEqual({ kind: 'none', sources: [] })
})

function returnRun(prior: boolean, flexible = false) {
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes = flexible
    ? { done: { next: 'finish' } }
    : { recheck: { returnTo: 'gate', afterRework: 'return-to-requester' }, done: { next: 'finish' } }
  definition.steps.push(
    workflowStepSchema.parse({
      id: 'gate',
      kind: 'human-approval',
      instructions: 'Review staging.',
      output: 'Decision.',
      outcomes: { yes: { next: 'execute' } },
    })
  )
  if (flexible) definition.routing = { mode: 'flexible', returnTo: 'earlier-steps', delegation: 'disabled' }
  if (prior) definition.entry = 'gate'
  const run = createWorkflowRun(definition)
  return prior
    ? advanceWorkflowRun(run, { action: 'complete', expectedVersion: 0, attemptId: 1, outcome: 'yes', evidence: '' })
    : run
}

test('declared first-review and flexible repeat returns validate and bind the new producer submission', () => {
  for (const prior of [false, true]) {
    const run = returnRun(prior, prior)
    const command = {
      action: 'return',
      expectedVersion: run.version,
      attemptId: run.activeAttemptId,
      targetStepId: 'gate',
      resumeAt: 'execute',
      feedback: 'Review the revised staging scope.',
    }
    const before = structuredClone(run)
    expect(() => advanceWorkflowRun(run, command)).toThrow('decisionBrief')
    if (prior)
      expect(() => advanceWorkflowRun(run, { ...command, decisionBrief: brief })).toThrow('changesSinceLastReview')
    expect(() =>
      advanceWorkflowRun(run, { ...command, decisionBrief: { ...brief, risks: 'pls approve this' } })
    ).toThrow('readable prose')
    expect(run).toEqual(before)
    const decisionBrief = prior
      ? {
          ...brief,
          changesSinceLastReview:
            'The previous review approved staging. This revision retains the older reader after a safe stop.',
        }
      : brief
    const accepted = advanceWorkflowRun(run, { ...command, decisionBrief })
    const producer = accepted.attempts.find((a) => a.id === command.attemptId)!
    expect(producer.feedback).toBe(command.feedback)
    expect(producer.decisionBrief?.value).toEqual(decisionBrief)
    expect(producer.decisionBrief?.contexts[0]?.previousDecisionAttemptId).toBe(prior ? 1 : undefined)
    expect(workflowReviewBriefForAttempt(accepted, accepted.attempts.at(-1)!).sources.map((a) => a.id)).toEqual([
      producer.id,
    ])
    expect(accepted.attempts.at(-1)!.reviewBrief?.kind).toBe('authored')
    expect(() => advanceWorkflowRun(run, { ...command, resumeAt: 'gate', decisionBrief })).toThrow(
      'Return path is not allowed'
    )
  }
})

test('agent-to-agent and human-to-human explicit returns keep their existing authoring semantics', () => {
  for (const agentSource of [true, false]) {
    const definition = returnRun(false).definition
    if (agentSource)
      definition.steps[1] = { ...definition.steps[0]!, id: 'gate', outcomes: { yes: { next: 'finish' } } }
    else
      definition.steps[0] = {
        ...definition.steps[1]!,
        id: 'execute',
        outcomes: { recheck: { returnTo: 'gate', afterRework: 'return-to-requester' }, done: { next: 'finish' } },
      }
    const run = createWorkflowRun(definition)
    expect(() =>
      advanceWorkflowRun(run, {
        action: 'return',
        expectedVersion: 0,
        attemptId: 1,
        targetStepId: 'gate',
        resumeAt: 'execute',
        feedback: 'Review the earlier prerequisite.',
      })
    ).not.toThrow()
  }
})

test('a restarted human destination and its next gate cannot inherit the original session brief', () => {
  const definition = returnRun(false).definition
  definition.steps[0]!.outcomes = { ready: { next: 'gate' } }
  definition.steps[1]!.outcomes.yes = { next: 'after' }
  definition.steps.push({
    ...definition.steps[1]!,
    id: 'after',
    instructions: 'Review the next staging scope.',
    outcomes: { yes: { next: 'finish' } },
  })
  let run = advanceWorkflowRun(createWorkflowRun(definition), {
    action: 'complete',
    expectedVersion: 0,
    attemptId: 1,
    outcome: 'ready',
    evidence: 'Audit record.',
    decisionBrief: brief,
  })
  const originalGate = run.attempts[1]!
  run = advanceWorkflowRun(run, {
    action: 'revise',
    expectedVersion: 1,
    attemptId: 2,
    active: 'restart',
    reason: 'Restart for a different staging scope.',
    operations: [
      { op: 'put-step', step: { ...definition.steps[1]!, instructions: 'Review only the replacement staging scope.' } },
    ],
  })
  const restarted = run.attempts.at(-1)!
  expect(restarted.reviewBrief).toEqual({ kind: 'none' })
  // Read-time protection also applies to already stored or missing bindings, without rewriting them.
  const legacy = structuredClone(run)
  legacy.attempts.at(-1)!.reviewBrief = { kind: 'carried-forward', sourceAttemptId: 1 }
  expect(workflowReviewBriefForAttempt(legacy, legacy.attempts.at(-1)!)).toEqual({ kind: 'none', sources: [] })
  delete legacy.attempts.at(-1)!.reviewBrief
  expect(workflowReviewBriefForAttempt(legacy, legacy.attempts.at(-1)!)).toEqual({ kind: 'none', sources: [] })
  expect(workflowReviewBriefForAttempt(run, originalGate).sources.map((a) => a.id)).toEqual([1])
  run = advanceWorkflowRun(run, {
    action: 'complete',
    expectedVersion: run.version,
    attemptId: restarted.id,
    outcome: 'yes',
    evidence: '',
  })
  expect(workflowReviewBriefForAttempt(run, run.attempts.at(-1)!)).toEqual({ kind: 'none', sources: [] })
})

test('a restarted agent can author its own fresh submission for a human gate', () => {
  const definition = returnRun(false).definition
  definition.steps[0]!.outcomes = { ready: { next: 'gate' } }
  definition.steps[1]!.outcomes = { yes: { next: 'finish' } }
  let run = createWorkflowRun(definition)
  run = advanceWorkflowRun(run, {
    action: 'revise',
    expectedVersion: 0,
    attemptId: 1,
    active: 'restart',
    reason: 'Start a fresh producing session.',
    operations: [{ op: 'put-step', step: definition.steps[0]! }],
  })
  run = advanceWorkflowRun(run, {
    action: 'complete',
    expectedVersion: run.version,
    attemptId: 2,
    outcome: 'ready',
    evidence: 'Fresh audit record.',
    decisionBrief: brief,
  })
  expect(workflowReviewBriefForAttempt(run, run.attempts.at(-1)!)).toMatchObject({ kind: 'authored' })
  expect(workflowReviewBriefForAttempt(run, run.attempts.at(-1)!).sources.map((a) => a.id)).toEqual([2])
})
