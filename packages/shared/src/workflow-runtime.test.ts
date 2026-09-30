import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { workflowPresetSchema } from './workflows'
import { advanceWorkflowRun, createWorkflowRun, type WorkflowRun } from './workflow-runtime'

async function run(preset = 'engineering'): Promise<WorkflowRun> {
  const file = resolve(import.meta.dir, `../../../config/workflows/${preset}.yaml`)
  const { definition } = workflowPresetSchema.parse(Bun.YAML.parse(await Bun.file(file).text()))
  return createWorkflowRun(definition)
}

/** Explicit direct-return fixtures exercise obligations independently of shipped preset defaults. */
async function directReturnRun(preset = 'engineering'): Promise<WorkflowRun> {
  const { definition } = await run(preset)
  for (const step of definition.steps)
    for (const transition of Object.values(step.outcomes))
      if ('returnTo' in transition) transition.afterRework = 'return-to-requester'
  return createWorkflowRun(definition)
}

function active(state: WorkflowRun): string | undefined {
  return state.attempts.find((attempt) => attempt.id === state.activeAttemptId)?.stepId
}

function complete(state: WorkflowRun, outcome = 'completed', resume = false): WorkflowRun {
  return advanceWorkflowRun(state, {
    expectedVersion: state.version,
    attemptId: state.activeAttemptId,
    action: 'complete',
    outcome,
    evidence: `Evidence for ${active(state)}: ${outcome}`,
    resume,
  })
}

function returnTo(state: WorkflowRun, targetStepId: string): WorkflowRun {
  return advanceWorkflowRun(state, {
    expectedVersion: state.version,
    attemptId: state.activeAttemptId,
    action: 'return',
    targetStepId,
    resumeAt: active(state),
    feedback: 'Please address these findings and return the result.',
  })
}

describe('workflow transition kernel', () => {
  test('solo reaches completion evaluation in one step without spawning extra roles', async () => {
    const initial = await run('solo')
    const finished = complete(initial)
    expect(finished.status).toBe('completion-ready')
    expect(finished.attempts).toHaveLength(1)
    expect(finished.completedStepIds).toEqual(['execute'])
    expect(finished.returns).toEqual([])
    expect(initial.status).toBe('running')
    expect(initial.attempts[0]!.status).toBe('running')
  })

  test('the engineering finish edge preserves the PR merge policy for server evaluation', async () => {
    let state = await run()
    state = complete(complete(state))
    expect(active(state)).toBe('review')
    state = complete(state, 'approved')
    expect(state.status).toBe('completion-ready')
    expect(state.definition.completion.mode).toBe('pr-merge')
    expect(state.completedStepIds).toEqual(['design', 'implement', 'review'])
  })

  test('reviewer rework must return and receive a verdict before completion', async () => {
    let state = complete(complete(await directReturnRun()))
    state = complete(state, 'changes-requested')
    expect(active(state)).toBe('implement')
    expect(state.returns[0]!.status).toBe('open')
    state = complete(state)
    expect(active(state)).toBe('review')
    expect(state.returns[0]!.status).toBe('open')
    state = complete(state, 'approved')
    expect(state.returns[0]!.status).toBe('resolved')
    expect(state.status).toBe('completion-ready')
  })

  test('a second changes request supersedes the first obligation without requiring duplicate approvals', async () => {
    let state = complete(complete(await directReturnRun()))
    state = complete(complete(state, 'changes-requested'))
    state = complete(complete(state, 'changes-requested'))
    expect(state.returns.map((obligation) => obligation.status)).toEqual(['superseded', 'open'])
    state = complete(state, 'approved')
    expect(state.status).toBe('completion-ready')
    expect(state.returns[0]!.supersededByReturnId).toBe(state.returns[1]!.id)
    expect(state.returns[1]!.status).toBe('resolved')
  })

  test('follow-graph redesign replays implementation and review without a hidden return destination', async () => {
    const initial = await run()
    let state = complete(complete(createWorkflowRun(initial.definition)))
    state = complete(state, 'redesign-needed')
    expect(active(state)).toBe('design')
    state = complete(state)
    expect(active(state)).toBe('implement')
    state = complete(state)
    expect(active(state)).toBe('review')
    expect(state.returns).toEqual([])
    expect(complete(state, 'approved').status).toBe('completion-ready')
  })

  test('an architect can explicitly return a result directly without replaying implementation', async () => {
    let state = complete(complete(await directReturnRun()))
    state = complete(state, 'redesign-needed')
    state = complete(state, 'completed', true)
    expect(active(state)).toBe('review')
    expect(state.attempts.filter((attempt) => attempt.stepId === 'implement')).toHaveLength(1)
    expect(complete(state, 'approved').status).toBe('completion-ready')
  })

  test('nested returns resolve inside-out and preserve the outer reviewer obligation', async () => {
    let state = complete(complete(await directReturnRun()))
    state = complete(state, 'changes-requested')
    state = complete(state, 'redesign-needed')
    expect(state.returns[1]!.parentId).toBe(state.returns[0]!.id)
    state = complete(state)
    expect(active(state)).toBe('implement')
    state = complete(state)
    expect(state.returns.map((obligation) => obligation.status)).toEqual(['open', 'resolved'])
    expect(active(state)).toBe('review')
    state = complete(state, 'approved')
    expect(state.returns.map((obligation) => obligation.status)).toEqual(['resolved', 'resolved'])
    expect(state.status).toBe('completion-ready')
  })

  test('targeted rework does not automatically invalidate an earlier specialist review', async () => {
    const initial = await directReturnRun()
    const definition = initial.definition
    definition.steps[1]!.outcomes.completed = { next: 'security' }
    definition.steps.push({
      ...definition.steps[2]!,
      id: 'security',
      outcomes: { approved: { next: 'review' } },
    })
    let state = createWorkflowRun(definition)
    state = complete(complete(state))
    state = complete(state, 'approved')
    expect(active(state)).toBe('review')
    state = complete(state, 'changes-requested')
    expect(state.completedStepIds).toContain('security')
    // Builder chooses to return directly to the requesting reviewer.
    state = complete(state, 'completed', true)
    state = complete(state, 'approved')
    expect(state.status).toBe('completion-ready')
    expect(state.attempts.filter((attempt) => attempt.stepId === 'security')).toHaveLength(1)
  })

  test('flexible backward handoffs use graph predecessors, not step array order', async () => {
    const initial = await run()
    initial.definition.steps.reverse()
    let state = complete(complete(createWorkflowRun(initial.definition)))
    state = returnTo(state, 'design')
    expect(active(state)).toBe('design')
    expect(state.returns[0]!.resumeAt).toBe('review')
    expect(() => returnTo(state, 'implement')).toThrow('not allowed')
  })

  test('guided routing rejects undeclared returns but preserves explicit review loops', async () => {
    const initial = await directReturnRun()
    initial.definition.routing = { mode: 'guided', returnTo: 'declared-only', delegation: 'disabled' }
    let state = createWorkflowRun(initial.definition)
    state = complete(state)
    expect(() => returnTo(state, 'review')).toThrow('not allowed')
    state = complete(state)
    expect(active(returnTo(state, 'implement'))).toBe('implement')
  })

  test('omitted attempt limits allow repeated rework beyond the former default', async () => {
    let state = complete(complete(await run()))
    expect(state.definition.limits.maxStepAttempts).toBeUndefined()
    for (let index = 0; index < 6; index++) {
      state = complete(state, 'changes-requested')
      expect(active(state)).toBe('implement')
      expect(state.status).toBe('running')
      state = complete(state)
      expect(active(state)).toBe('review')
    }
    expect(state.attempts.filter((attempt) => attempt.stepId === 'implement')).toHaveLength(7)
    state = complete(state, 'approved')
    expect(state.status).toBe('completion-ready')
  })

  test('attempt limits pause with the outstanding request intact instead of silently finishing', async () => {
    const initial = await directReturnRun()
    initial.definition.limits.maxStepAttempts = 1
    let state = complete(complete(createWorkflowRun(initial.definition)))
    state = complete(state, 'changes-requested')
    expect(state.status).toBe('paused')
    expect(state.pauseReason).toEqual({ type: 'attempt-limit', stepId: 'implement' })
    expect(state.returns[0]!.status).toBe('open')
    expect(state.activeAttemptId).toBeNull()
    expect(state.attempts).toHaveLength(3)
  })

  test('a finish outcome cannot skip a required step that has never passed', async () => {
    const initial = await run()
    initial.definition.steps[0]!.outcomes.shortcut = { next: 'finish' }
    const state = complete(createWorkflowRun(initial.definition), 'shortcut')
    expect(state.status).toBe('completion-ready')
    expect(state.attempts.map((attempt) => attempt.stepId)).toEqual(['design'])
    expect(state.pauseReason).toBeUndefined()
  })

  test('a rework agent taking a finish edge still returns to the reviewer with an outstanding request', async () => {
    const initial = await directReturnRun()
    initial.definition.steps[1]!.outcomes.finished = { next: 'finish' }
    let state = complete(complete(createWorkflowRun(initial.definition)))
    state = complete(state, 'changes-requested')
    state = complete(state, 'finished')
    expect(state.status).toBe('running')
    expect(active(state)).toBe('review')
    expect(state.returns[0]!.status).toBe('open')
    expect(complete(state, 'approved').status).toBe('completion-ready')
  })

  test('rejects stale versions and attempts without mutating the state', async () => {
    const initial = await run()
    const state = complete(initial)
    const before = structuredClone(state)
    expect(() =>
      advanceWorkflowRun(state, {
        action: 'complete',
        expectedVersion: 0,
        attemptId: 1,
        outcome: 'completed',
        evidence: 'done',
      })
    ).toThrow('Stale workflow version')
    expect(() =>
      advanceWorkflowRun(state, {
        action: 'complete',
        expectedVersion: 1,
        attemptId: 1,
        outcome: 'completed',
        evidence: 'done',
      })
    ).toThrow('Stale step attempt')
    expect(state).toEqual(before)
  })

  test('rejects unknown outcomes, empty evidence, and arbitrary completion fields', async () => {
    const state = await run('solo')
    expect(() => complete(state, 'constructor')).toThrow('Unknown outcome')
    const command = { action: 'complete', expectedVersion: 0, attemptId: 1, outcome: 'completed', evidence: '' }
    expect(() => advanceWorkflowRun(state, command)).toThrow()
    expect(() => advanceWorkflowRun(state, { ...command, evidence: 'done', status: 'done' })).toThrow()
    expect(() => complete(state, 'completed', true)).toThrow('No return destination')
  })

  test('a JSON round trip can resume an outstanding return without losing its history', async () => {
    const state = complete(complete(complete(await directReturnRun()), 'completed'), 'redesign-needed')
    const reloaded: WorkflowRun = JSON.parse(JSON.stringify(state))
    expect(complete(reloaded, 'completed', true)).toEqual(complete(state, 'completed', true))
  })
})

describe('dynamic flow execution', () => {
  test('tracked delegation resumes its requester and leaves the required review intact', async () => {
    let state = await run('builder-reviewer')
    state.definition.routing.delegation = 'allowed'
    state.definition.limits.maxDelegations = 3
    state = advanceWorkflowRun(state, {
      expectedVersion: 0,
      attemptId: 1,
      action: 'delegate',
      participant: { agentTypeId: 'general', session: 'reuse-within-stream' },
      task: 'Assess accessibility',
    })
    expect(active(state)).toBe('delegation-1')
    state = complete(state)
    expect(active(state)).toBe('build')
    expect(state.returns[0]!.status).toBe('open')
    state = complete(state)
    expect(active(state)).toBe('review')
    expect(state.returns[0]!.status).toBe('resolved')
    expect(complete(state, 'approved').status).toBe('completion-ready')
  })
  test('guided flows reject unplanned specialists without changing the input', async () => {
    const state = await run('solo')
    expect(() =>
      advanceWorkflowRun(state, {
        expectedVersion: 0,
        attemptId: 1,
        action: 'delegate',
        participant: { agentTypeId: 'general', session: 'fresh-per-attempt' },
        task: 'Help',
      })
    ).toThrow('disabled')
    expect(state.attempts).toHaveLength(1)
  })
  test('keeping an active attempt pins its instructions and participant while future steps can change', async () => {
    const state = await run('builder-reviewer')
    const step = { ...state.definition.steps[0]!, instructions: 'New instructions' }
    const revised = advanceWorkflowRun(state, {
      expectedVersion: 0,
      attemptId: 1,
      action: 'revise',
      active: 'keep',
      reason: 'Adjust future work',
      operations: [{ op: 'put-step', step }],
    })
    expect(revised.definition.steps[0]!.instructions).toBe('New instructions')
    expect(revised.attempts[0]!.step!.instructions).toBe(state.definition.steps[0]!.instructions)
    expect(revised.attempts[0]!.participant).toEqual(state.definition.participants.builder)
    expect(revised.revisions).toHaveLength(2)
    expect(active(complete(revised))).toBe('review')
  })
  test('restarting creates a fresh attempt and rejects the old attempt token', async () => {
    const state = await run('solo')
    const revised = advanceWorkflowRun(state, {
      expectedVersion: 0,
      attemptId: 1,
      action: 'revise',
      active: 'restart',
      reason: 'Use a new approach',
      operations: [{ op: 'put-step', step: { ...state.definition.steps[0]!, instructions: 'Reconsider' } }],
    })
    expect(revised.attempts.map((a) => a.status)).toEqual(['canceled', 'running'])
    expect(revised.attempts[1]!.freshSession).toBe(true)
    expect(() =>
      advanceWorkflowRun(revised, {
        expectedVersion: 1,
        attemptId: 1,
        action: 'complete',
        outcome: 'completed',
        evidence: 'Old result',
      })
    ).toThrow('Stale step attempt')
  })
  test('an authorized limit revision resumes a paused return without dropping its obligation', async () => {
    const initial = await directReturnRun('builder-reviewer')
    initial.definition.limits.maxStepAttempts = 1
    const paused = complete(complete(initial), 'changes-requested')
    expect(paused.status).toBe('paused')
    const resumed = advanceWorkflowRun(paused, {
      expectedVersion: paused.version,
      attemptId: null,
      action: 'revise',
      active: 'keep',
      reason: 'Allow one rework pass',
      operations: [{ op: 'set-limits', limits: { ...paused.definition.limits, maxStepAttempts: 2 } }],
    })
    expect(active(resumed)).toBe('build')
    expect(resumed.returns[0]!.status).toBe('open')
    expect(complete(complete(resumed), 'approved').status).toBe('completion-ready')
  })
})

test('nested direct corrections return to each requester instead of replaying the normal downstream path', async () => {
  const initial = await directReturnRun()
  initial.definition.steps[1]!.outcomes.completed = { next: 'security' }
  initial.definition.steps.push({
    ...initial.definition.steps[2]!,
    id: 'security',
    outcomes: { approved: { next: 'review' } },
  })
  let state = complete(complete(createWorkflowRun(initial.definition)))
  state = complete(state, 'approved')
  state = complete(state, 'changes-requested')
  state = complete(state, 'redesign-needed')
  state = complete(state)
  expect(active(state)).toBe('implement')
  state = complete(state)
  expect(active(state)).toBe('review')
  expect(state.attempts.filter((attempt) => attempt.stepId === 'security')).toHaveLength(1)
  expect(complete(state, 'approved').status).toBe('completion-ready')
})

describe('completion-ready rework', () => {
  test('CI feedback reactivates review, then follows implementation and review again', async () => {
    const ready = complete(complete(await run('builder-reviewer')), 'approved')
    let state = advanceWorkflowRun(ready, {
      action: 'rework',
      expectedVersion: ready.version,
      attemptId: 2,
      feedback: 'CI found a literal type error',
    })
    expect(active(state)).toBe('review')
    expect(state.attempts[1]!.status).toBe('completed')
    expect(state.attempts[2]).toMatchObject({ feedback: 'CI found a literal type error', sourceAttemptIds: [1, 2] })
    state = complete(state, 'changes-requested')
    expect(active(state)).toBe('build')
    state = complete(state)
    expect(active(state)).toBe('review')
    state = complete(state, 'approved')
    expect(state.status).toBe('completion-ready')
    expect(state.attempts).toHaveLength(5)
    expect(() =>
      advanceWorkflowRun(state, {
        action: 'rework',
        expectedVersion: ready.version,
        attemptId: 2,
        feedback: 'Duplicate',
      })
    ).toThrow('Stale workflow version')
    expect(() =>
      advanceWorkflowRun(state, {
        action: 'rework',
        expectedVersion: state.version,
        attemptId: 2,
        feedback: 'Old attempt',
      })
    ).toThrow('latest completed delivery agent')
  })

  test('rework repeats the downstream human gate and cannot bypass it', async () => {
    const initial = await run('builder-reviewer')
    initial.definition.steps.push({
      id: 'approval',
      kind: 'human-approval',
      instructions: 'Approve',
      output: 'Decision',
      outcomes: { approved: { next: 'finish' } },
      approver: 'assigned-reviewers',
    })
    initial.definition.steps[1]!.outcomes.approved = { next: 'approval' }
    let state = complete(complete(initial), 'approved')
    expect(active(state)).toBe('approval')
    expect(() =>
      advanceWorkflowRun(state, {
        action: 'rework',
        expectedVersion: state.version,
        attemptId: 2,
        feedback: 'Not ready',
      })
    ).toThrow('completion-ready')
    state = complete(state, 'approved')
    state = advanceWorkflowRun(state, {
      action: 'rework',
      expectedVersion: state.version,
      attemptId: 2,
      feedback: 'CI failure',
    })
    state = complete(state, 'approved')
    expect(active(state)).toBe('approval')
    expect(state.status).toBe('running')
  })

  test('rework preserves attempt limits and its feedback across an authorized limit revision', async () => {
    const initial = await run('solo')
    initial.definition.limits.maxStepAttempts = 1
    let state = complete(initial)
    state = advanceWorkflowRun(state, {
      action: 'rework',
      expectedVersion: state.version,
      attemptId: 1,
      feedback: 'CI correction',
    })
    expect(state.status).toBe('paused')
    expect(state.pendingStarts?.[0]?.feedback).toBe('CI correction')
    expect(state.attempts).toHaveLength(1)
    state = advanceWorkflowRun(state, {
      action: 'revise',
      expectedVersion: state.version,
      attemptId: null,
      active: 'keep',
      reason: 'Allow CI rework',
      operations: [{ op: 'set-limits', limits: { ...state.definition.limits, maxStepAttempts: 2 } }],
    })
    expect(state.status).toBe('running')
    expect(state.attempts[1]?.feedback).toBe('CI correction')
    expect(complete(state).status).toBe('completion-ready')
  })

  test('terminal parallel branches replay their fork without losing sibling joins', async () => {
    const initial = await run('solo')
    initial.definition.steps[0]!.outcomes.completed = { parallel: ['a', 'b'], join: 'finish' }
    for (const id of ['a', 'b'])
      initial.definition.steps.push({
        ...initial.definition.steps[0]!,
        id,
        outcomes: { completed: { next: 'finish' } },
      })
    // Start against the changed definition so the fork's attempt snapshot is current.
    let state = complete(createWorkflowRun(initial.definition))
    state = complete(state)
    state = complete(state)
    expect(state.status).toBe('completion-ready')
    state = advanceWorkflowRun(state, {
      action: 'rework',
      expectedVersion: state.version,
      attemptId: 3,
      feedback: 'Repeat parallel checks',
    })
    expect(active(state)).toBe(initial.definition.entry)
    state = complete(state)
    expect(state.attempts.filter((a) => a.status === 'running')).toHaveLength(2)
    state = complete(complete(state))
    expect(state.status).toBe('completion-ready')
    expect(state.joins?.map((join) => join.status)).toEqual(['joined', 'joined'])
  })
})

test('completion-ready rework honors the configured code-host engineer and repeats downstream review', async () => {
  const initial = await run('builder-reviewer')
  initial.definition.completion.changeEventsTo = { step: 'build' }
  const ready = complete(complete(initial), 'approved')
  expect(() =>
    advanceWorkflowRun(ready, {
      action: 'rework',
      expectedVersion: ready.version,
      attemptId: 2,
      feedback: 'Wrong recipient',
    })
  ).toThrow('delivery agent')
  let state = advanceWorkflowRun(ready, {
    action: 'rework',
    expectedVersion: ready.version,
    attemptId: 1,
    feedback: 'Current CI failure',
  })
  expect(active(state)).toBe('build')
  state = complete(state)
  expect(active(state)).toBe('review')
  expect(complete(state, 'approved').status).toBe('completion-ready')
})

describe('live outcome revisions', () => {
  test('keep adds, changes, and removes outcomes without replacing the initial snapshot', async () => {
    const initial = await run('builder-reviewer')
    const snapshot = structuredClone(initial.attempts[0]!)
    const revise = (state: WorkflowRun, outcomes: NonNullable<(typeof initial.definition.steps)[0]>['outcomes']) =>
      advanceWorkflowRun(state, {
        action: 'revise',
        expectedVersion: state.version,
        attemptId: 1,
        active: 'keep',
        reason: 'Truthful routing',
        operations: [
          {
            op: 'put-step',
            step: { ...state.definition.steps[0]!, instructions: 'Future brief', output: 'Future output', outcomes },
          },
        ],
      })
    const added = revise(initial, { ...snapshot.step!.outcomes, waived: { next: 'review' } })
    expect(added.attempts).toHaveLength(1)
    expect(added.attempts[0]!.step).toEqual(snapshot.step)
    expect(added.attempts[0]!.participant).toEqual(snapshot.participant)
    expect(added.attempts[0]!.revision).toBe(snapshot.revision)
    expect(added.attempts[0]!.sourceAttemptIds).toEqual(snapshot.sourceAttemptIds)
    expect(added.attempts[0]!.freshSession).toBeUndefined()
    expect(added.attempts[0]!.effectiveOutcomes).toEqual({ version: 1, outcomes: added.definition.steps[0]!.outcomes })
    expect(added.revisions!.at(-1)!.affectedAttemptIds).toEqual([1])
    expect(active(complete(added, 'waived'))).toBe('review')
    const changed = revise(added, { completed: { next: 'review' }, waived: { next: 'finish' } })
    expect(complete(changed, 'waived').status).toBe('completion-ready')
    const removed = revise(changed, { completed: { next: 'review' } })
    expect(() => complete(removed, 'waived')).toThrow("Unknown outcome 'waived'")
    expect(removed.attempts[0]!.step).toEqual(snapshot.step)
    const repeated = revise(removed, removed.definition.steps[0]!.outcomes)
    expect(repeated.attempts[0]!.effectiveOutcomes!.version).toBe(3)
    expect(repeated.revisions!.at(-1)!.affectedAttemptIds).toEqual([])
    expect(() =>
      advanceWorkflowRun(removed, {
        action: 'complete',
        expectedVersion: 0,
        attemptId: 1,
        outcome: 'completed',
        evidence: 'Old command',
      })
    ).toThrow('Stale workflow version')
    expect(initial.attempts[0]).toEqual(snapshot)
  })

  test('keep can replace a destination while removing it, without rewriting completed history', async () => {
    const initial = await run('builder-reviewer')
    const revised = advanceWorkflowRun(initial, {
      action: 'revise',
      expectedVersion: 0,
      attemptId: 1,
      active: 'keep',
      reason: 'Replace future review',
      operations: [
        { op: 'put-step', step: { ...initial.definition.steps[0]!, outcomes: { completed: { next: 'finish' } } } },
        { op: 'remove-step', id: 'review' },
      ],
    })
    const finished = complete(revised)
    const history = structuredClone(finished.attempts)
    const later = advanceWorkflowRun(finished, {
      action: 'revise',
      expectedVersion: finished.version,
      attemptId: null,
      active: 'keep',
      reason: 'Future routing',
      operations: [
        { op: 'put-step', step: { ...revised.definition.steps[0]!, outcomes: { later: { next: 'finish' } } } },
      ],
    })
    expect(later.attempts).toEqual(history)
    expect(later.revisions!.at(-1)!.affectedAttemptIds).toEqual([])
  })
})

test('outcome revisions cannot orphan open return destinations', async () => {
  const state = complete(complete(await directReturnRun('builder-reviewer')), 'changes-requested')
  const before = structuredClone(state)
  expect(() =>
    advanceWorkflowRun(state, {
      action: 'revise',
      expectedVersion: state.version,
      attemptId: state.activeAttemptId,
      active: 'keep',
      reason: 'Remove requester',
      operations: [
        { op: 'put-step', step: { ...state.definition.steps[0]!, outcomes: { completed: { next: 'finish' } } } },
        { op: 'remove-step', id: 'review' },
      ],
    })
  ).toThrow('open return')
  expect(state).toEqual(before)
})

test('a new keep outcome can declare a return without changing the original brief', async () => {
  const initial = complete(complete(await run()))
  const step = initial.definition.steps.find((s) => s.id === 'review')!
  const revised = advanceWorkflowRun(initial, {
    action: 'revise',
    expectedVersion: initial.version,
    attemptId: initial.activeAttemptId,
    active: 'keep',
    reason: 'Direct design correction',
    operations: [
      {
        op: 'put-step',
        step: {
          ...step,
          outcomes: { ...step.outcomes, correction: { returnTo: 'design', afterRework: 'return-to-requester' } },
        },
      },
    ],
  })
  const returned = returnTo(revised, 'design')
  expect(active(returned)).toBe('design')
  expect(returned.returns[0]!.resumeAt).toBe('review')
  expect(returned.attempts[2]!.step).toEqual(initial.attempts[2]!.step)
})

test('unrelated keep revisions do not refresh legacy stale outcome snapshots', async () => {
  const state = await run('builder-reviewer')
  // A persisted run from before live outcome bindings: definition changed but the attempt stayed pinned.
  state.definition.steps[0]!.outcomes.waived = { next: 'review' }
  const revised = advanceWorkflowRun(state, {
    action: 'revise',
    expectedVersion: 0,
    attemptId: 1,
    active: 'keep',
    reason: 'Rename only',
    operations: [{ op: 'set-name', name: 'New name' }],
  })
  expect(revised.attempts).toEqual(state.attempts)
  expect(revised.revisions!.at(-1)!.affectedAttemptIds).toEqual([])
  expect(() => complete(revised, 'waived')).toThrow('Unknown outcome')
})

test('outcome bindings survive JSON and ignore transition key ordering on repeated revisions', async () => {
  const state = complete(complete(await directReturnRun()))
  const step = state.definition.steps.find((s) => s.id === 'review')!
  const outcomes = { ...step.outcomes, correction: { returnTo: 'design', afterRework: 'return-to-requester' } }
  const revised = advanceWorkflowRun(state, {
    action: 'revise',
    expectedVersion: state.version,
    attemptId: state.activeAttemptId,
    active: 'keep',
    reason: 'Add correction',
    operations: [{ op: 'put-step', step: { ...step, outcomes } }],
  })
  const persisted = JSON.parse(JSON.stringify(revised)) as WorkflowRun
  for (const map of [
    persisted.definition.steps.find((s) => s.id === 'review')!.outcomes,
    persisted.attempts[2]!.effectiveOutcomes!.outcomes,
  ])
    map.correction = { afterRework: 'return-to-requester', returnTo: 'design' }
  const repeated = advanceWorkflowRun(persisted, {
    action: 'revise',
    expectedVersion: persisted.version,
    attemptId: persisted.activeAttemptId,
    active: 'keep',
    reason: 'Same routing',
    operations: [{ op: 'put-step', step: { ...step, outcomes } }],
  })
  expect(repeated.attempts).toEqual(persisted.attempts)
  expect(repeated.revisions!.at(-1)!.affectedAttemptIds).toEqual([])
  expect(active(complete(repeated, 'correction'))).toBe('design')
})
