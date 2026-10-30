import { expect, test } from 'bun:test'
import { createBlankWorkflow } from './workflow-editing'
import { workflowStepSchema } from './workflows'
import { advanceWorkflowRun, createWorkflowRun, reopenWorkflowRun, type WorkflowRun } from './workflow-runtime'
import { routeWorkflowDecision } from './workflow-decision'
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

for (const order of [
  [2, 3],
  [3, 2],
]) {
  test(`a mixed human join separates authored and carried sources in arrival order ${order.join(', ')}`, () => {
    const definition = flow().definition
    definition.steps[0]!.outcomes = { ready: { parallel: ['left', 'right'], join: 'gate' } }
    definition.steps.push(
      workflowStepSchema.parse({ ...definition.steps[0], id: 'left', outcomes: { ready: { next: 'gate' } } }),
      workflowStepSchema.parse({
        id: 'right',
        kind: 'human-approval',
        instructions: 'Review the staging prerequisite.',
        output: 'Decision.',
        outcomes: { yes: { next: 'gate' } },
      })
    )
    let run = complete(createWorkflowRun(definition), 'ready', brief)
    for (const id of order)
      run = advanceWorkflowRun(run, {
        action: 'complete',
        expectedVersion: run.version,
        attemptId: id,
        outcome: id === 2 ? 'ready' : 'yes',
        evidence: 'Branch handoff.',
        decisionBrief: brief,
      })
    expect(run.attempts.at(-1)!.reviewBrief).toEqual({
      kind: 'authored',
      sourceAttemptIds: [2],
      carriedSourceAttemptIds: [1],
    })
    expect(workflowReviewBriefForAttempt(run, run.attempts.at(-1)!)).toMatchObject({
      kind: 'authored',
      sources: [{ id: 2 }],
      carriedSources: [{ id: 1 }],
    })
  })
}

test('a returned human remains a bridge to its eligible producer brief', () => {
  const definition = flow().definition
  definition.steps[1]!.outcomes.recheck = { returnTo: 'second', afterRework: 'return-to-requester' }
  let run = complete(createWorkflowRun(definition), 'ready', brief)
  run = advanceWorkflowRun(run, {
    action: 'return',
    expectedVersion: run.version,
    attemptId: 2,
    targetStepId: 'second',
    resumeAt: 'gate',
    feedback: 'Confirm the staging prerequisite first.',
  })
  expect(workflowReviewBriefForAttempt(run, run.attempts.at(-1)!)).toMatchObject({
    kind: 'carried-forward',
    sources: [{ id: 1 }],
  })
})

test('effective kept outcome, not the stale step definition, determines the brief requirement', () => {
  let run = flow()
  const original = run.attempts[0]!.step!
  run = advanceWorkflowRun(run, {
    action: 'revise',
    expectedVersion: 0,
    attemptId: 1,
    active: 'keep',
    reason: 'Route ordinary work through review.',
    operations: [
      { op: 'put-step', step: { ...original, outcomes: { ...original.outcomes, ordinary: { next: 'gate' } } } },
    ],
  })
  expect(run.attempts[0]!.step!.outcomes.ordinary).toEqual({ next: 'finish' })
  expect(() => complete(run, 'ordinary')).toThrow('decisionBrief')
  expect(complete(run, 'ordinary', brief).attempts.at(-1)!.stepId).toBe('gate')
})
test('canceled and nonhuman occurrences do not count; return without an outcome counts', () => {
  const run = flow()
  run.attempts.push(
    { id: 2, stepId: 'gate', status: 'canceled', outcome: 'yes' },
    { id: 3, stepId: 'gate', status: 'returned', feedback: 'Please retain the existing reader.' },
    { id: 4, stepId: 'gate', status: 'completed', outcome: 'yes', step: { ...run.definition.steps[0]!, id: 'gate' } }
  )
  expect(workflowEarlierHumanDecisions(run, 'gate').map((a) => a.id)).toEqual([3])
})

test('a queued pre-deploy gate without binding stays legacy when admitted', () => {
  let run = complete(flow(), 'ready', brief)
  run = complete(run, 'again')
  run.definition.limits.maxStepAttempts = 1
  run = complete(run, 'ready', {
    ...brief,
    changesSinceLastReview: 'The reviewer requested rework. The fallback is now retained.',
  })
  expect(run.pendingStarts).toHaveLength(1)
  // Persisted shape from before briefs: the queued target and settled sources have no brief metadata.
  delete run.pendingStarts![0]!.reviewBrief
  for (const source of run.attempts) {
    delete source.decisionBrief
    delete source.reviewBrief
  }
  run = advanceWorkflowRun(run, {
    action: 'revise',
    expectedVersion: run.version,
    attemptId: null,
    active: 'keep',
    reason: 'Admit the already queued review.',
    operations: [{ op: 'set-limits', limits: { ...run.definition.limits, maxStepAttempts: 5 } }],
  })
  expect(workflowReviewBriefForAttempt(run, run.attempts.at(-1)!)).toEqual({ kind: 'legacy', sources: [] })
})

test('human-waiting decision steps show voluntary briefs or an explicit no-brief notice without requiring authorship', () => {
  const definition = flow().definition
  definition.steps[0]!.outcomes.ready = { next: 'choice' }
  definition.steps[0]!.outcomes.design = { next: 'gate' }
  definition.steps.push(
    workflowStepSchema.parse({
      id: 'choice',
      kind: 'decision',
      instructions: 'Choose the staging option.',
      questions: { ready: { type: 'yesno', instructions: 'Is the proposal ready?' } },
      outcomes: { yes: { next: 'finish' } },
    })
  )
  for (const value of [undefined, brief]) {
    const run = complete(createWorkflowRun(definition), 'ready', value)
    const gate = run.attempts.at(-1)!
    gate.decision = {
      status: 'unconfigured',
      matched: 'unavailable',
      awaitingPerson: true,
      decidedAt: '2026-10-29T00:00:00Z',
    }
    expect(gate.stepId).toBe('choice')
    expect(workflowReviewBriefForAttempt(run, gate)).toMatchObject(
      value ? { kind: 'carried-forward', sources: [{ id: 1 }] } : { kind: 'none', sources: [] }
    )
  }
})

test('an already-running producer gets actionable complete and return brief diagnostics', () => {
  const run = flow()
  for (const command of [
    { action: 'complete' as const, outcome: 'ready', evidence: 'Audit record.' },
    { action: 'return' as const, targetStepId: 'gate', resumeAt: 'execute', feedback: 'Review this scope.' },
  ]) {
    if (command.action === 'return') {
      const step = run.attempts[0]!.step!
      step.outcomes.recheck = { returnTo: 'gate', afterRework: 'return-to-requester' }
    }
    let message = ''
    try {
      advanceWorkflowRun(run, { ...command, expectedVersion: run.version, attemptId: 1 })
    } catch (error) {
      message = (error as Error).message
    }
    for (const phrase of [
      'decisionBrief',
      'same advance command JSON',
      'decision, recommendation, approvalEffect and risks',
      'changesSinceLastReview',
      'evidence',
      'feedback',
    ])
      expect(message).toContain(phrase)
  }
})

test('new queued decision steps are not mistaken for pre-deploy queued human approvals', () => {
  const definition = createBlankWorkflow()
  definition.limits.maxParallelAttempts = 1
  definition.steps[0]!.outcomes.completed = { parallel: ['hold', 'choice'], join: 'finish' }
  definition.steps.push(
    workflowStepSchema.parse({ ...definition.steps[0], id: 'hold', outcomes: { completed: { next: 'finish' } } }),
    workflowStepSchema.parse({
      id: 'choice',
      kind: 'decision',
      instructions: 'Choose the staging option.',
      questions: { ready: { type: 'yesno', instructions: 'Is the proposal ready?' } },
      outcomes: { yes: { next: 'finish' } },
    })
  )
  for (const value of [undefined, brief]) {
    let run = complete(createWorkflowRun(definition), 'completed', value)
    expect(run.pendingStarts).toHaveLength(1)
    run = complete(run, 'completed')
    const choice = run.attempts.at(-1)!
    expect(choice.stepId).toBe('choice')
    expect(choice.reviewBrief).toBeUndefined()
    expect(workflowReviewBriefForAttempt(run, choice).kind).toBe(value ? 'carried-forward' : 'none')
  }
})

test('a human return to an already-reviewed gate carries its old brief instead of reauthoring it', () => {
  const definition = flow().definition
  definition.steps[2]!.outcomes.recheck = { returnTo: 'gate', afterRework: 'return-to-requester' }
  let run = complete(createWorkflowRun(definition), 'ready', brief)
  run = complete(run, 'yes')
  run = advanceWorkflowRun(run, {
    action: 'return',
    expectedVersion: run.version,
    attemptId: 3,
    targetStepId: 'gate',
    resumeAt: 'second',
    feedback: 'Recheck the staging prerequisite before rollout review.',
  })
  expect(run.attempts[1]!.reviewBrief).toEqual({ kind: 'authored', sourceAttemptIds: [1] })
  expect(workflowReviewBriefForAttempt(run, run.attempts.at(-1)!)).toMatchObject({
    kind: 'carried-forward',
    sources: [{ id: 1 }],
  })
})

test('restarted decision fallback has a fresh destination boundary without rewriting historical sources', () => {
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes.completed = { next: 'choice' }
  definition.steps.push(
    workflowStepSchema.parse({
      id: 'choice',
      kind: 'decision',
      instructions: 'Choose the original staging scope.',
      questions: { ready: { type: 'yesno', instructions: 'Is staging ready?' } },
      outcomes: { yes: { next: 'finish' } },
    })
  )
  const original = complete(createWorkflowRun(definition), 'completed', brief)
  const source = structuredClone(original.attempts[0])
  const restarted = advanceWorkflowRun(original, {
    action: 'revise',
    expectedVersion: original.version,
    attemptId: 2,
    active: 'restart',
    reason: 'Start a fresh decision for replacement scope.',
    operations: [
      {
        op: 'put-step',
        step: { ...original.attempts[1]!.step!, instructions: 'Choose only the replacement staging scope.' },
      },
    ],
  })
  const current = restarted.attempts.at(-1)!
  expect(current.freshSession).toBe(true)
  for (const reason of ['unconfigured', 'unavailable'] as const) {
    const step = current.step!
    if (step.kind !== 'decision') throw new Error('Expected a decision fixture')
    current.decision = routeWorkflowDecision(step, { ok: false, reason, errors: [] })
    expect(current.decision.awaitingPerson).toBe(true)
    for (const binding of [
      undefined,
      { kind: 'carried-forward' as const, sourceAttemptId: 1 },
      { kind: 'authored' as const, sourceAttemptIds: [1] },
    ]) {
      current.reviewBrief = binding
      const before = structuredClone(restarted)
      expect(workflowReviewBriefForAttempt(restarted, current)).toEqual({ kind: 'none', sources: [] })
      expect(restarted).toEqual(before)
    }
  }
  expect(restarted.attempts[0]).toEqual(source)
  expect(workflowReviewBriefForAttempt(restarted, restarted.attempts[1]!)).toMatchObject({
    kind: 'carried-forward',
    sources: [{ id: 1 }],
  })
  current.reviewBrief = { kind: 'legacy' }
  expect(workflowReviewBriefForAttempt(restarted, current)).toEqual({ kind: 'legacy', sources: [] })
})

/** Persisted mixed join shape: the agent branch settled before brief metadata existed. */
function transitionalJoin() {
  const definition = flow().definition
  definition.steps[0]!.outcomes = { ready: { parallel: ['left', 'right'], join: 'gate' } }
  definition.steps.push(
    workflowStepSchema.parse({ ...definition.steps[0], id: 'left', outcomes: { ready: { next: 'gate' } } }),
    workflowStepSchema.parse({
      id: 'right',
      kind: 'human-approval',
      instructions: 'Review the prerequisite.',
      output: 'Decision.',
      outcomes: { yes: { next: 'gate' } },
    })
  )
  let run = complete(createWorkflowRun(definition), 'ready', brief)
  run = advanceWorkflowRun(run, {
    action: 'complete',
    expectedVersion: run.version,
    attemptId: 2,
    outcome: 'ready',
    evidence: 'Legacy branch evidence.',
    decisionBrief: brief,
  })
  for (const attempt of run.attempts) {
    delete attempt.decisionBrief
    delete attempt.reviewBrief
    delete attempt.settledVersion
  }
  return run
}
function closeTransitionalJoin(run: WorkflowRun) {
  return advanceWorkflowRun(run, {
    action: 'complete',
    expectedVersion: run.version,
    attemptId: 3,
    outcome: 'yes',
    evidence: 'The human prerequisite is approved.',
  })
}

test('a pre-deploy agent followed by a post-deploy human join preserves legacy presentation without backfill', () => {
  const original = transitionalJoin()
  const before = structuredClone(original)
  const run = closeTransitionalJoin(original)
  const gate = run.attempts.at(-1)!
  expect(gate.stepId).toBe('gate')
  expect(gate.reviewBrief).toEqual({ kind: 'legacy' })
  expect(workflowReviewBriefForAttempt(run, gate)).toEqual({ kind: 'legacy', sources: [] })
  expect(original).toEqual(before)
  expect(run.attempts.slice(0, 2)).toEqual(before.attempts.slice(0, 2))
})

test('a modern authored join source takes precedence over transitional legacy layout', () => {
  const run = transitionalJoin()
  run.attempts[1]!.decisionBrief = {
    value: brief,
    submittedVersion: run.version,
    contexts: [{ gateStepId: 'gate', returnIds: [], revisionVersions: [], interruptedExecutions: [] }],
  }
  const next = closeTransitionalJoin(run)
  expect(next.attempts.at(-1)!.reviewBrief).toEqual({ kind: 'authored', sourceAttemptIds: [2] })
})

for (const boundary of ['modern', 'epoch', 'returned', 'fresh-human', 'different-source'] as const) {
  test(`transitional legacy inference does not cross the ${boundary} boundary`, () => {
    const run = transitionalJoin()
    if (boundary === 'modern') for (const attempt of run.attempts.slice(0, 2)) attempt.settledVersion = 1
    if (boundary === 'epoch') run.attemptEpoch = 2
    if (boundary === 'returned') for (const attempt of run.attempts.slice(0, 2)) attempt.status = 'returned'
    // For the last two cases, only the human branch is a causal source of the join.
    if (boundary === 'fresh-human' || boundary === 'different-source') {
      run.joins![0]!.sourceAttemptIds = [99]
      if (boundary === 'fresh-human') {
        run.attempts[2]!.sourceAttemptIds = [2]
        run.attempts[2]!.freshSession = true
      } else run.attempts[2]!.sourceAttemptIds = []
      // The other arrival has no producer in this run; never search another run for it.
    }
    const next = closeTransitionalJoin(run)
    expect(next.attempts.at(-1)!.reviewBrief).toEqual({ kind: 'none' })
  })
}
