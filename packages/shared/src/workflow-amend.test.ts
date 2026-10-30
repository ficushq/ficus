import { describe, expect, test } from 'bun:test'
import { createBlankWorkflow } from './workflow-editing'
import { workflowStepSchema, type WorkflowDefinition } from './workflows'
import {
  advanceWorkflowRun,
  createWorkflowRun,
  workflowAmendEligibility,
  workflowGateRevisions,
  type WorkflowRun,
} from './workflow-runtime'
import { workflowEarlierHumanDecisions } from './workflow-review-history'
import {
  WORKFLOW_MAX_RESULT_REVISIONS,
  WORKFLOW_REVIEW_REVISED_MESSAGE,
  workflowAttemptResults,
  workflowDecisionRevisionNote,
} from './workflow-result-revisions'
import { brief } from './test-fixtures/workflow-review'

const revised = {
  ...brief,
  recommendation: 'Approve because the fallback preserves existing reads and the reviewer asked for a rollback note.',
}

/** execute (agent) -> gate (human approval) -> second (agent); the gate can send work back. */
function definition(): WorkflowDefinition {
  const def = createBlankWorkflow()
  def.steps[0]!.outcomes = { ready: { next: 'gate' }, skip: { next: 'second' } }
  def.steps.push(
    workflowStepSchema.parse({
      id: 'gate',
      kind: 'human-approval',
      instructions: 'Review the staging design.',
      output: 'Decision.',
      outcomes: { yes: { next: 'second' }, no: { returnTo: 'execute' } },
    }),
    workflowStepSchema.parse({ ...def.steps[0], id: 'second', outcomes: { completed: { next: 'finish' } } })
  )
  return def
}

function complete(run: WorkflowRun, outcome: string, extra: Record<string, unknown> = {}) {
  return advanceWorkflowRun(run, {
    action: 'complete',
    expectedVersion: run.version,
    attemptId: run.activeAttemptId!,
    outcome,
    evidence: outcome === 'yes' ? '' : 'Staging design evidence, commit abc1234.',
    ...extra,
  })
}

function amend(run: WorkflowRun, attemptId = 1, extra: Record<string, unknown> = {}) {
  return advanceWorkflowRun(run, {
    action: 'amend',
    expectedVersion: run.version,
    attemptId,
    evidence: 'Revised staging design evidence, commit def5678.',
    decisionBrief: revised,
    ...extra,
  })
}

/** A run waiting at the gate with attempt 1's authored brief. */
const atGate = () => complete(createWorkflowRun(definition()), 'ready', { decisionBrief: brief })

describe('amend', () => {
  test('records a new revision while the fed gate is open and changes nothing else', () => {
    const before = atGate()
    const after = amend(before)
    expect(after.version).toBe(before.version + 1)
    const attempt = after.attempts[0]!
    expect(attempt.resultRevision).toBe(2)
    expect(attempt.resultRevisedVersion).toBe(after.version)
    expect(attempt.evidence).toBe('Revised staging design evidence, commit def5678.')
    expect(attempt.decisionBrief).toEqual({
      value: revised,
      submittedVersion: after.version,
      contexts: [{ gateStepId: 'gate', returnIds: [], revisionVersions: [], interruptedExecutions: [] }],
    })
    expect(attempt.earlierResults).toEqual([
      {
        revision: 1,
        version: 1,
        evidence: 'Staging design evidence, commit abc1234.',
        decisionBrief: before.attempts[0]!.decisionBrief,
        attachmentIds: [],
      },
    ])
    // The gate, routing state and history are untouched.
    const { version: _a, attempts: beforeAttempts, ...beforeRest } = before
    const { version: _b, attempts: afterAttempts, ...afterRest } = after
    expect(afterRest).toEqual(beforeRest)
    expect(afterAttempts[1]).toEqual(beforeAttempts[1]!)
    expect(afterAttempts).toHaveLength(beforeAttempts.length)
    expect(attempt.status).toBe('completed')
    expect(attempt.settledVersion).toBe(before.attempts[0]!.settledVersion)
  })

  test('a second amend is revision 3 and every earlier revision stays readable', () => {
    const run = amend(amend(atGate()), 1, { evidence: 'Third revision evidence, commit 0a1b2c3.' })
    const results = workflowAttemptResults(run.attempts[0]!, [])
    expect(results.map((result) => result.revision)).toEqual([1, 2, 3])
    expect(results.map((result) => result.evidence)).toEqual([
      'Staging design evidence, commit abc1234.',
      'Revised staging design evidence, commit def5678.',
      'Third revision evidence, commit 0a1b2c3.',
    ])
    expect(results[0]!.decisionBrief!.value).toEqual(brief)
    expect(results[1]!.version).toBe(2)
    expect(workflowGateRevisions(run, run.attempts[1]!)).toEqual([{ attemptId: 1, revision: 3, revisedVersion: 3 }])
  })

  test('an attempt that predates amend reads as revision 1', () => {
    const run = atGate()
    expect(workflowAttemptResults(run.attempts[0]!, [])).toEqual([
      {
        revision: 1,
        version: 1,
        evidence: 'Staging design evidence, commit abc1234.',
        decisionBrief: run.attempts[0]!.decisionBrief,
        attachmentIds: [],
      },
    ])
    expect(workflowGateRevisions(run, run.attempts[1]!)).toEqual([{ attemptId: 1, revision: 1 }])
  })

  test('refuses once the gate is decided', () => {
    const decided = complete(atGate(), 'yes')
    expect(() => amend(decided)).toThrow(
      "Human approval 'gate' is no longer open, so attempt 1 can no longer be amended."
    )
  })

  test('refuses a stale version', () => {
    const run = atGate()
    expect(() => amend(run, 1, { expectedVersion: run.version - 1 })).toThrow('Stale workflow version')
  })

  test('refuses an attempt that is not completed or does not feed a gate', () => {
    const run = atGate()
    expect(() => amend(run, 2)).toThrow("Only an agent's completed attempt can be amended")
    const running = createWorkflowRun(definition())
    expect(() => amend(running, 1)).toThrow('Only a completed attempt can be amended; attempt 1 is running.')
    const skipped = complete(createWorkflowRun(definition()), 'skip')
    expect(() => amend(skipped, 1)).toThrow(
      "Attempt 1's result was already used by 'second' (attempt 2); only a result waiting at an open human approval gate can be amended."
    )
    expect(() => amend(run, 9)).toThrow('Attempt 9 does not exist.')
  })

  test('refuses a returned attempt and a paused run', () => {
    const def = definition()
    def.steps[0]!.outcomes = {
      ...def.steps[0]!.outcomes,
      check: { returnTo: 'gate', afterRework: 'return-to-requester' },
    }
    let run = createWorkflowRun(def)
    run = complete(run, 'check', { decisionBrief: brief })
    expect(run.attempts[0]!.status).toBe('returned')
    expect(() => amend(run, 1)).toThrow('Only a completed attempt can be amended; attempt 1 is returned.')
    const paused = { ...atGate(), status: 'paused' as const }
    expect(() => amend(paused)).toThrow('Workflow is paused')
  })

  test('refuses a gate reached through a decision step, a queued gate and an open join', () => {
    const def = definition()
    def.steps[0]!.outcomes = { ready: { next: 'route' } }
    def.steps.push(
      workflowStepSchema.parse({
        id: 'route',
        kind: 'decision',
        instructions: 'Decide whether a person must review.',
        questions: { ok: { type: 'yesno', instructions: 'It needs a person.' } },
        outcomes: { person: { next: 'gate' } },
      })
    )
    let run = createWorkflowRun(def)
    run = complete(run, 'ready')
    expect(() => amend(run, 1)).toThrow("Attempt 1's result was already used by 'route' (attempt 2)")

    const queued = atGate()
    queued.attempts[1]!.status = 'canceled'
    queued.pendingStarts = [
      { stepId: 'gate', sourceAttemptIds: [1], reviewBrief: { kind: 'authored', sourceAttemptIds: [1] } },
    ]
    expect(() => amend(queued)).toThrow('Attempt 1 does not feed an open human approval gate.')

    const joined = atGate()
    joined.attempts[1]!.status = 'canceled'
    joined.joins = [
      { id: 9, join: 'gate', branches: ['a', 'b'], arrived: ['a'], sourceAttemptIds: [1], status: 'open' },
    ]
    expect(() => amend(joined)).toThrow('Attempt 1 does not feed an open human approval gate.')
  })

  test('refuses a legacy or carried gate binding', () => {
    for (const binding of [{ kind: 'legacy' as const }, { kind: 'carried-forward' as const, sourceAttemptId: 1 }]) {
      const run = atGate()
      run.attempts[1]!.reviewBrief = binding
      expect(() => amend(run)).toThrow(
        "Human approval 'gate' did not open with this attempt's decision brief, so it cannot be amended; recommend Changes requested instead."
      )
    }
  })

  test('refuses past the revision limit', () => {
    const run = atGate()
    run.attempts[0]!.resultRevision = WORKFLOW_MAX_RESULT_REVISIONS
    expect(() => amend(run)).toThrow(
      `Attempt 1 has reached ${WORKFLOW_MAX_RESULT_REVISIONS} revisions; recommend Changes requested instead.`
    )
  })

  test('validates the brief exactly like completion', () => {
    const run = atGate()
    expect(() => amend(run, 1, { decisionBrief: undefined })).toThrow()
    expect(() => amend(run, 1, { evidence: '' })).toThrow()
    expect(() => amend(run, 1, { decisionBrief: { ...revised, decision: 'pls apprv' } })).toThrow('readable prose')
  })

  test('requires changesSinceLastReview after an earlier decision, and amending is not a review round', () => {
    let run = atGate()
    run = advanceWorkflowRun(run, {
      action: 'complete',
      expectedVersion: run.version,
      attemptId: 2,
      outcome: 'no',
      evidence: 'Add a rollback note.',
    })
    const changes = 'The reviewer asked for a rollback note. This version adds it.'
    run = complete(run, 'ready', { decisionBrief: { ...brief, changesSinceLastReview: changes } })
    const gate = run.attempts.at(-1)!
    expect(gate.reviewBrief).toEqual({ kind: 'authored', sourceAttemptIds: [3] })
    const history = workflowEarlierHumanDecisions(run, 'gate').map((a) => a.id)
    expect(() => amend(run, 3)).toThrow('decisionBrief.changesSinceLastReview is required')
    run = amend(run, 3, { decisionBrief: { ...revised, changesSinceLastReview: changes } })
    expect(run.attempts[2]!.decisionBrief!.contexts[0]!.previousDecisionAttemptId).toBe(2)
    expect(workflowEarlierHumanDecisions(run, 'gate').map((a) => a.id)).toEqual(history)
    expect(run.attempts.at(-1)).toEqual(gate)
  })

  test('each source of a human join amends independently and the gate stays open', () => {
    const def = definition()
    def.steps[0]!.outcomes = { ready: { parallel: ['left', 'right'], join: 'gate' } }
    for (const id of ['left', 'right'])
      def.steps.push(workflowStepSchema.parse({ ...def.steps[0], id, outcomes: { ready: { next: 'gate' } } }))
    let run = complete(createWorkflowRun(def), 'ready')
    for (const id of [2, 3])
      run = advanceWorkflowRun(run, {
        action: 'complete',
        expectedVersion: run.version,
        attemptId: id,
        outcome: 'ready',
        evidence: `Branch ${id} evidence.`,
        decisionBrief: brief,
      })
    const gate = run.attempts.at(-1)!
    expect(gate.reviewBrief).toEqual({ kind: 'authored', sourceAttemptIds: [2, 3] })
    run = amend(run, 3)
    run = amend(run, 2)
    run = amend(run, 3)
    expect(run.attempts.at(-1)).toEqual(gate)
    expect(workflowGateRevisions(run, gate).map(({ attemptId, revision }) => ({ attemptId, revision }))).toEqual([
      { attemptId: 2, revision: 2 },
      { attemptId: 3, revision: 3 },
    ])
  })
})

describe('decisions record the reviewed revision', () => {
  test('a decision on the latest revision succeeds and records it', () => {
    let run = amend(atGate())
    run = complete(run, 'yes', { reviewedRevisions: [{ attemptId: 1, revision: 2 }] })
    const gate = run.attempts[1]!
    expect(gate.status).toBe('completed')
    expect(gate.reviewedRevisions).toEqual([{ attemptId: 1, revision: 2 }])
    expect(workflowDecisionRevisionNote(run, gate)).toBe('Approved revision 2 of execute attempt 1')
  })

  test('a forward outcome other than the approval is named as chosen, not as an approval', () => {
    const def = definition()
    def.steps[1]!.outcomes = { yes: { next: 'second' }, ship: { next: 'finish' }, no: { returnTo: 'execute' } }
    let run = complete(createWorkflowRun(def), 'ready', { decisionBrief: brief })
    run = advanceWorkflowRun(run, {
      action: 'complete',
      expectedVersion: run.version,
      attemptId: 2,
      outcome: 'ship',
      evidence: '',
    })
    expect(workflowDecisionRevisionNote(run, run.attempts[1]!)).toBe("Chose 'ship' on revision 1 of execute attempt 1")
  })

  test('a decision without reviewedRevisions still records the revision it was made on', () => {
    const run = complete(atGate(), 'yes')
    expect(run.attempts[1]!.reviewedRevisions).toEqual([{ attemptId: 1, revision: 1 }])
  })

  test('a decision on a stale revision is refused', () => {
    const run = amend(atGate())
    expect(() => complete(run, 'yes', { reviewedRevisions: [{ attemptId: 1, revision: 1 }] })).toThrow(
      WORKFLOW_REVIEW_REVISED_MESSAGE
    )
  })

  test('Changes requested records the revision too', () => {
    let run = amend(atGate())
    run = advanceWorkflowRun(run, {
      action: 'complete',
      expectedVersion: run.version,
      attemptId: 2,
      outcome: 'no',
      evidence: 'Use the other cache.',
      reviewedRevisions: [{ attemptId: 1, revision: 2 }],
    })
    const gate = run.attempts[1]!
    expect(gate.reviewedRevisions).toEqual([{ attemptId: 1, revision: 2 }])
    expect(workflowDecisionRevisionNote(run, gate)).toBe('Changes requested on revision 2 of execute attempt 1')
  })

  test('reviewedRevisions on an agent attempt is refused', () => {
    const run = createWorkflowRun(definition())
    expect(() =>
      complete(run, 'ready', { decisionBrief: brief, reviewedRevisions: [{ attemptId: 1, revision: 1 }] })
    ).toThrow('reviewedRevisions is only for human review decisions')
  })

  test('amend eligibility is shared and explains refusals', () => {
    expect(workflowAmendEligibility(atGate(), 1)).toMatchObject({ ok: true })
    expect(workflowAmendEligibility(complete(atGate(), 'yes'), 1)).toMatchObject({ ok: false })
  })
})
