import { expect, test } from 'bun:test'
import { createBlankWorkflow, workflowRevisionOperations } from './workflow-editing'
import { workflowDefinitionSchema, workflowStepSchema, resolveWorkflow } from './workflows'
import {
  activeWorkflowAttempts,
  createWorkflowRun,
  advanceWorkflowRun,
  reopenWorkflowRun,
  type WorkflowRun,
} from './workflow-runtime'

function definition() {
  const flow = createBlankWorkflow()
  flow.steps[0]!.outcomes.completed = { parallel: ['security', 'qa'], join: 'deliver' }
  for (const id of ['security', 'qa', 'deliver'])
    flow.steps.push(
      workflowStepSchema.parse({
        id,
        participant: 'worker',
        instructions: id,
        output: 'Evidence',
        outcomes: { completed: { next: id === 'deliver' ? 'finish' : 'deliver' } },
      })
    )
  flow.routing = { mode: 'flexible', returnTo: 'earlier-steps', delegation: 'allowed' }
  flow.limits.maxDelegations = 3
  return flow
}
function complete(run: WorkflowRun, stepId: string, resume = false) {
  return advanceWorkflowRun(run, {
    action: 'complete',
    expectedVersion: run.version,
    attemptId: activeWorkflowAttempts(run).find((entry) => entry.stepId === stepId)!.id,
    outcome: 'completed',
    evidence: 'Verified',
    resume,
  })
}
const active = (run: WorkflowRun) => activeWorkflowAttempts(run).map((entry) => entry.stepId)
test('parallel branches may settle in either order; a join starts exactly once after all arrivals', () => {
  for (const order of [
    ['security', 'qa'],
    ['qa', 'security'],
  ]) {
    let run = complete(createWorkflowRun(definition()), 'execute')
    expect(active(run)).toEqual(['security', 'qa'])
    expect(activeWorkflowAttempts(run).map((a) => a.sourceAttemptIds)).toEqual([[1], [1]])
    run = complete(run, order[0]!)
    expect(active(run)).toEqual([order[1]!])
    expect(run.joins![0]!.status).toBe('open')
    run = complete(run, order[1]!)
    expect(active(run)).toEqual(['deliver'])
    expect(run.joins![0]!.status).toBe('joined')
    expect(activeWorkflowAttempts(run)[0]!.sourceAttemptIds?.toSorted()).toEqual([2, 3])
    run = complete(run, 'deliver')
    expect(run.status).toBe('completion-ready')
  }
})
test('concurrency queues branch starts without allocating attempts until capacity is available', () => {
  const flow = definition()
  flow.limits.maxParallelAttempts = 1
  let run = complete(createWorkflowRun(flow), 'execute')
  expect(active(run)).toEqual(['security'])
  expect(run.pendingStarts!.map((entry) => entry.stepId)).toEqual(['qa'])
  expect(run.attempts).toHaveLength(2)
  expect(run.pendingStarts![0]!.sourceAttemptIds).toEqual([1])
  run = complete(run, 'security')
  expect(active(run)).toEqual(['qa'])
  expect(activeWorkflowAttempts(run)[0]!.sourceAttemptIds).toEqual([1])
  run = complete(run, 'qa')
  expect(active(run)).toEqual(['deliver'])
})
test('branch-local rework cannot be resolved by its sibling; prior reviews stay recorded', () => {
  let run = complete(createWorkflowRun(definition()), 'execute')
  const security = activeWorkflowAttempts(run).find((entry) => entry.stepId === 'security')!
  run = advanceWorkflowRun(run, {
    action: 'return',
    expectedVersion: run.version,
    attemptId: security.id,
    targetStepId: 'execute',
    resumeAt: 'security',
    feedback: 'Redesign',
  })
  expect(activeWorkflowAttempts(run).find((a) => a.stepId === 'execute')!.sourceAttemptIds).toEqual([security.id])
  const reworkId = activeWorkflowAttempts(run).find((a) => a.stepId === 'execute')!.id
  run = complete(run, 'qa')
  expect(run.returns[0]!.status).toBe('open')
  expect(run.completedStepIds).toContain('qa')
  run = complete(run, 'execute', true)
  expect(active(run)).toEqual(['security'])
  expect(activeWorkflowAttempts(run)[0]!.sourceAttemptIds).toEqual([reworkId])
  run = complete(run, 'security')
  expect(run.returns[0]!.status).toBe('resolved')
  expect(active(run)).toEqual(['deliver'])
  expect(run.completedStepIds).toContain('qa')
})
test('nested joins collect independently before releasing their parent branch', () => {
  const flow = definition()
  flow.steps.find((step) => step.id === 'security')!.outcomes.completed = {
    parallel: ['static', 'dynamic'],
    join: 'security-done',
  }
  for (const id of ['static', 'dynamic', 'security-done'])
    flow.steps.push(
      workflowStepSchema.parse({
        id,
        participant: 'worker',
        instructions: id,
        output: 'Evidence',
        outcomes: { completed: { next: id === 'security-done' ? 'deliver' : 'security-done' } },
      })
    )
  let run = complete(createWorkflowRun(flow), 'execute')
  run = complete(run, 'security')
  run = complete(run, 'qa')
  run = complete(run, 'dynamic')
  expect(active(run)).toEqual(['static'])
  run = complete(run, 'static')
  expect(active(run)).toEqual(['security-done'])
  run = complete(run, 'security-done')
  expect(active(run)).toEqual(['deliver'])
})
test('branch edits retain other active attempts and joins; restarting targets only the selected attempt', () => {
  let run = complete(createWorkflowRun(definition()), 'execute')
  const qa = activeWorkflowAttempts(run).find((entry) => entry.stepId === 'qa')!
  run = advanceWorkflowRun(run, {
    action: 'revise',
    expectedVersion: run.version,
    attemptId: qa.id,
    active: 'restart',
    reason: 'New context',
    operations: [{ op: 'set-name', name: 'Revised' }],
  })
  expect(active(run)).toEqual(['security', 'qa'])
  expect(run.attempts.find((entry) => entry.id === qa.id)!.status).toBe('canceled')
  expect(run.attempts.at(-1)!.freshSession).toBe(true)
  expect(run.attempts.at(-1)!.branch).toEqual(qa.branch)
  expect(run.attempts.at(-1)!.sourceAttemptIds).toEqual(qa.sourceAttemptIds)
  expect(run.joins![0]!.arrived).toEqual([])
  const reopened = reopenWorkflowRun(run)
  expect(active(reopened)).toEqual(['execute'])
  expect(reopened.joins![0]!.status).toBe('canceled')
})
test('connections determine convergence, including independent tracks and a direct arrival at the shared step', () => {
  const separate = definition()
  separate.steps.find((entry) => entry.id === 'qa')!.outcomes.completed = { next: 'finish' }
  let run = complete(createWorkflowRun(separate), 'execute')
  expect(run.joins![0]!.join).toBe('finish')
  run = complete(run, 'qa')
  expect(active(run)).toEqual(['security'])
  run = complete(run, 'security')
  run = complete(run, 'deliver')
  expect(run.status).toBe('completion-ready')
  const converging = definition()
  converging.steps.find((entry) => entry.id === 'qa')!.outcomes.completed = { next: 'security' }
  run = complete(createWorkflowRun(converging), 'execute')
  expect(run.joins![0]!.join).toBe('security')
  expect(active(run)).toEqual(['qa'])
  run = complete(run, 'qa')
  expect(active(run)).toEqual(['security'])
  run = complete(run, 'security')
  expect(run.attempts.filter((attempt) => attempt.stepId === 'security')).toHaveLength(1)
})

test('editor revisions preserve names and order and reject incomplete order lists', () => {
  const base = definition()
  const edited = structuredClone(base)
  edited.name = 'Changed'
  ;[edited.steps[1], edited.steps[2]] = [edited.steps[2]!, edited.steps[1]!]
  const preset = { id: 'example', revision: '1', disabled: false, definition: base }
  expect(
    resolveWorkflow({ kind: 'preset', id: 'example', customizations: workflowRevisionOperations(base, edited) }, preset)
      .definition
  ).toEqual(workflowDefinitionSchema.parse(edited))
  expect(() =>
    resolveWorkflow(
      { kind: 'preset', id: 'example', customizations: [{ op: 'set-step-order', ids: ['execute'] }] },
      preset
    )
  ).toThrow('every step')
})

test('omitting the concurrency limit starts more than eight parallel branches and joins once', () => {
  const flow = definition()
  const branches = Array.from({ length: 10 }, (_, index) => `review-${index}`)
  flow.steps = [
    flow.steps[0]!,
    ...branches.map((id) =>
      workflowStepSchema.parse({
        id,
        participant: 'worker',
        instructions: id,
        output: 'Evidence',
        outcomes: { completed: { next: 'deliver' } },
      })
    ),
    flow.steps.find((step) => step.id === 'deliver')!,
  ]
  flow.steps[0]!.outcomes.completed = { parallel: branches, join: 'deliver' }
  expect(flow.limits.maxParallelAttempts).toBeUndefined()
  let run = complete(createWorkflowRun(flow), 'execute')
  expect(active(run)).toEqual(branches)
  expect(run.pendingStarts ?? []).toHaveLength(0)
  for (const branch of branches) run = complete(run, branch)
  expect(active(run)).toEqual(['deliver'])
  expect(run.attempts.filter((attempt) => attempt.stepId === 'deliver')).toHaveLength(1)

  const limited = structuredClone(flow)
  limited.limits.maxParallelAttempts = 1
  const queued = complete(createWorkflowRun(limited), 'execute')
  expect(active(queued)).toHaveLength(1)
  const uncapped = advanceWorkflowRun(queued, {
    action: 'revise',
    expectedVersion: queued.version,
    attemptId: activeWorkflowAttempts(queued)[0]!.id,
    active: 'keep',
    reason: 'Use global capacity',
    operations: [{ op: 'set-limits', limits: flow.limits }],
  })
  expect(active(uncapped)).toEqual(branches)
  expect(uncapped.pendingStarts ?? []).toHaveLength(0)
})

test('omitted or stale join metadata resolves to the visible convergence and starts it only once', () => {
  for (const metadata of [{}, { join: 'finish' }]) {
    const input = definition()
    const parsed = workflowDefinitionSchema.parse({
      ...input,
      steps: input.steps.map((step, index) =>
        index
          ? step
          : {
              ...step,
              outcomes: { completed: { parallel: ['security', 'qa'], ...metadata } },
            }
      ),
    })
    expect(parsed.steps[0]!.outcomes.completed).toEqual({ parallel: ['security', 'qa'], join: 'deliver' })
    let run = complete(createWorkflowRun(parsed), 'execute')
    run = complete(run, 'qa')
    expect(active(run)).toEqual(['security'])
    run = complete(run, 'security')
    expect(active(run)).toEqual(['deliver'])
    expect(run.attempts.filter((attempt) => attempt.stepId === 'deliver')).toHaveLength(1)
  }
})

test('alternative incoming paths do not wait for outcomes that were not chosen', () => {
  const input = definition()
  input.steps[0]!.outcomes = { completed: { next: 'security' }, other: { next: 'qa' } }
  let run = complete(createWorkflowRun(input), 'execute')
  run = complete(run, 'security')
  expect(active(run)).toEqual(['deliver'])
  run = complete(run, 'deliver')
  expect(run.status).toBe('completion-ready')
  expect(run.joins ?? []).toHaveLength(0)
})

test('follow-graph rework starts a new parallel wave and waits for both new results', () => {
  const flow = definition()
  flow.steps.find((step) => step.id === 'deliver')!.outcomes.revise = { returnTo: 'execute' }
  let run = complete(createWorkflowRun(flow), 'execute')
  run = complete(complete(run, 'security'), 'qa')
  run = advanceWorkflowRun(run, {
    action: 'complete',
    expectedVersion: run.version,
    attemptId: run.activeAttemptId,
    outcome: 'revise',
    evidence: 'Both checks need new input.',
  })
  expect(active(run)).toEqual(['execute'])
  expect(run.returns).toEqual([])
  run = complete(run, 'execute')
  expect(active(run)).toEqual(['security', 'qa'])
  run = complete(run, 'qa')
  expect(active(run)).toEqual(['security'])
  expect(run.attempts.filter((step) => step.stepId === 'deliver')).toHaveLength(1)
  run = complete(run, 'security')
  expect(active(run)).toEqual(['deliver'])
  expect(run.joins!.map((join) => join.status)).toEqual(['joined', 'joined'])
  expect(complete(run, 'deliver').status).toBe('completion-ready')
})

test('direct rework inside a branch bypasses the correction step fork and preserves its sibling', () => {
  const flow = definition()
  flow.steps.find((step) => step.id === 'security')!.outcomes.revise = {
    returnTo: 'execute',
    afterRework: 'return-to-requester',
  }
  let run = complete(createWorkflowRun(flow), 'execute')
  run = advanceWorkflowRun(run, {
    action: 'complete',
    expectedVersion: run.version,
    attemptId: activeWorkflowAttempts(run).find((step) => step.stepId === 'security')!.id,
    outcome: 'revise',
    evidence: 'Clarify the security assumptions.',
  })
  run = complete(run, 'qa')
  run = complete(run, 'execute') // No resume flag is needed; the handoff owns this choice.
  expect(active(run)).toEqual(['security'])
  expect(run.joins).toHaveLength(1)
  expect(run.attempts.filter((step) => step.stepId === 'qa')).toHaveLength(1)
  expect(run.returns[0]!.status).toBe('open')
  run = complete(run, 'security')
  expect(active(run)).toEqual(['deliver'])
  expect(run.returns[0]!.status).toBe('resolved')
  expect(complete(run, 'deliver').status).toBe('completion-ready')
})

test('handoff sources follow only the immediate route through sequential steps and rework', () => {
  const flow = definition()
  flow.steps[0]!.outcomes.completed = { next: 'security' }
  flow.steps.find((step) => step.id === 'security')!.outcomes.completed = { next: 'qa' }
  flow.steps.find((step) => step.id === 'qa')!.outcomes.corrections = {
    returnTo: 'security',
    afterRework: 'follow-graph',
  }
  let run = createWorkflowRun(flow)
  expect(run.attempts[0]!.sourceAttemptIds).toEqual([])
  run = complete(run, 'execute')
  run = complete(run, 'security')
  expect(activeWorkflowAttempts(run)[0]!.sourceAttemptIds).toEqual([2])
  run = advanceWorkflowRun(run, {
    action: 'complete',
    expectedVersion: run.version,
    attemptId: 3,
    outcome: 'corrections',
    evidence: 'Fix the edge case',
  })
  expect(activeWorkflowAttempts(run)[0]!.sourceAttemptIds).toEqual([3])
  run = complete(run, 'security')
  expect(activeWorkflowAttempts(run)[0]!.sourceAttemptIds).toEqual([4])
  run = complete(run, 'qa')
  expect(activeWorkflowAttempts(run)[0]!.sourceAttemptIds).toEqual([5])
  run = complete(run, 'deliver')
  run = reopenWorkflowRun(run)
  expect(activeWorkflowAttempts(run)[0]!.sourceAttemptIds).toEqual([])
})

test('keep refreshes the same running step in every branch and preserves open joins and returns', () => {
  const flow = definition()
  for (const id of ['security', 'qa'])
    flow.steps.find((s) => s.id === id)!.outcomes.rework = { returnTo: 'shared', afterRework: 'return-to-requester' }
  flow.steps.push(
    workflowStepSchema.parse({
      id: 'shared',
      participant: 'worker',
      instructions: 'Original brief',
      output: 'Original output',
      outcomes: { completed: { next: 'deliver' } },
    })
  )
  let run = complete(createWorkflowRun(flow), 'execute')
  for (const a of activeWorkflowAttempts(run))
    run = advanceWorkflowRun(run, {
      action: 'complete',
      expectedVersion: run.version,
      attemptId: a.id,
      outcome: 'rework',
      evidence: 'Needs shared correction',
    })
  const before = structuredClone(run)
  const shared = run.definition.steps.find((s) => s.id === 'shared')!
  run = advanceWorkflowRun(run, {
    action: 'revise',
    expectedVersion: run.version,
    attemptId: run.activeAttemptId,
    active: 'keep',
    reason: 'Add accurate verdict',
    operations: [
      { op: 'put-step', step: { ...shared, instructions: 'Future only', outcomes: { waived: { next: 'deliver' } } } },
    ],
  })
  const kept = activeWorkflowAttempts(run)
  expect(kept.map((a) => a.effectiveOutcomes?.outcomes)).toEqual([
    { waived: { next: 'deliver' } },
    { waived: { next: 'deliver' } },
  ])
  expect(run.revisions!.at(-1)!.affectedAttemptIds).toEqual(kept.map((a) => a.id))
  expect(kept.map((a) => a.step)).toEqual(activeWorkflowAttempts(before).map((a) => a.step))
  expect(run.attempts.filter((a) => a.status !== 'running')).toEqual(
    before.attempts.filter((a) => a.status !== 'running')
  )
  expect(run.joins).toEqual(before.joins)
  expect(run.returns).toEqual(before.returns)
  for (const a of kept)
    run = advanceWorkflowRun(run, {
      action: 'complete',
      expectedVersion: run.version,
      attemptId: a.id,
      outcome: 'waived',
      evidence: 'Owner waived this check',
    })
  expect(active(run)).toEqual(['security', 'qa'])
  expect(run.returns.every((r) => r.status === 'open')).toBe(true)
  expect(run.joins![0]!.status).toBe('open')
})

test('new effective outcomes cannot orphan an already open join', () => {
  const run = complete(createWorkflowRun(definition()), 'execute')
  expect(() =>
    advanceWorkflowRun(run, {
      action: 'revise',
      expectedVersion: run.version,
      attemptId: run.activeAttemptId,
      active: 'keep',
      reason: 'Remove join',
      operations: [
        ...run.definition.steps
          .filter((s) => s.id !== 'deliver')
          .map((step) => ({
            op: 'put-step',
            step: {
              ...step,
              outcomes:
                step.id === 'execute'
                  ? { completed: { parallel: ['security', 'qa'], join: 'finish' } }
                  : { completed: { next: 'finish' } },
            },
          })),
        { op: 'remove-step', id: 'deliver' },
      ],
    })
  ).toThrow('open parallel join')
  expect(run.joins![0]!.status).toBe('open')
})
