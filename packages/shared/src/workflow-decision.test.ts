import { describe, expect, test } from 'bun:test'
import {
  workflowDefinitionSchema,
  workflowStepSchema,
  applyWorkflowCustomizations,
  type WorkflowDecisionStep,
  type WorkflowDefinition,
} from './workflows'
import { advanceWorkflowRun, createWorkflowRun, workflowIncomingAttempts } from './workflow-runtime'
import { describeWorkflowDecision, routeWorkflowDecision, type WorkflowDecisionReply } from './workflow-decision'
import type { DecisionAnswer } from './decisions'

const decision = {
  id: 'triage',
  name: 'Triage',
  kind: 'decision',
  instructions: 'Decide whether the change is ready to ship.',
  questions: {
    ready: { type: 'yesno', instructions: 'The result is complete and verified.' },
    kind: { type: 'choice', instructions: 'What kind of change is it?', options: { bug: 'A fix', feature: 'New' } },
  },
  routes: [
    { when: { type: 'yesno', question: 'ready', op: 'at-least', probability: 0.8 }, outcome: 'ship' },
    { when: { type: 'choice', question: 'kind', equals: 'bug', minConfidence: 0.6 }, outcome: 'rework' },
  ],
  otherwise: 'review',
  unavailable: 'review',
  outcomes: { ship: { next: 'finish' }, rework: { returnTo: 'build' }, review: { next: 'approve' } },
}

function definition(step: Record<string, unknown> = decision): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    schemaVersion: 1,
    name: 'Decided',
    participants: { builder: { agentTypeId: 'general', session: 'reuse-within-stream' } },
    entry: 'build',
    routing: { mode: 'guided', returnTo: 'declared-only', delegation: 'disabled' },
    limits: { maxDelegations: 0, onLimit: 'request-owner-input' },
    steps: [
      {
        id: 'build',
        participant: 'builder',
        instructions: 'Build it.',
        output: 'The change.',
        outcomes: { done: { next: 'triage' } },
      },
      step,
      {
        id: 'approve',
        kind: 'human-approval',
        instructions: 'Approve.',
        output: 'Approval.',
        outcomes: { approved: { next: 'finish' } },
      },
    ],
    completion: { mode: 'deliverable' },
  })
}

function issues(step: Record<string, unknown>): string[] {
  const result = workflowDefinitionSchema.safeParse({
    ...definition(),
    steps: [definition().steps[0], step, definition().steps[2]],
  })
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
}

describe('decision step schema', () => {
  test('a decision step parses with defaults for input and routes', () => {
    const parsed = definition().steps[1] as WorkflowDecisionStep
    expect(parsed.kind).toBe('decision')
    expect(parsed.input).toEqual(['title', 'description', 'incoming-results'])
    const minimal = workflowStepSchema.parse({
      id: 'gate',
      kind: 'decision',
      instructions: 'Gate.',
      questions: { ok: { type: 'yesno', instructions: 'It is fine.' } },
      outcomes: { pass: { next: 'finish' } },
    })
    expect(minimal).toMatchObject({ routes: [], input: ['title', 'description', 'incoming-results'] })
  })

  test('a decision step has no participant or output', () => {
    expect(workflowStepSchema.safeParse({ ...decision, participant: 'builder' }).success).toBe(false)
    expect(workflowStepSchema.safeParse({ ...decision, output: 'Nothing.' }).success).toBe(false)
  })

  test('every route, otherwise and unavailable outcome must be declared', () => {
    expect(
      issues({
        ...decision,
        routes: [{ when: decision.routes[0]!.when, outcome: 'launch' }],
        otherwise: 'later',
        unavailable: 'skip',
      })
    ).toEqual([
      "steps.1.routes.0.outcome: Route 1 uses unknown outcome 'launch'; add it to the step's outcomes",
      "steps.1.otherwise: Otherwise uses unknown outcome 'later'; add it to the step's outcomes",
      "steps.1.unavailable: Unavailable uses unknown outcome 'skip'; add it to the step's outcomes",
    ])
  })

  test('route conditions must fit their questions', () => {
    expect(
      issues({
        ...decision,
        routes: [
          { when: { type: 'yesno', question: 'done', op: 'at-least', probability: 0.5 }, outcome: 'ship' },
          { when: { type: 'choice', question: 'kind', equals: 'chore' }, outcome: 'ship' },
          { when: { type: 'score', question: 'ready', op: 'at-least', level: 'High' }, outcome: 'ship' },
        ],
      })
    ).toEqual([
      "steps.1.routes.0.when: Route 1: Unknown question 'done'",
      "steps.1.routes.1.when: Route 2: Question 'kind' has no option 'chore'",
      "steps.1.routes.2.when: Route 3: Question 'ready' is a yesno question, not score",
    ])
  })

  test('a route may omit its question only when the step asks one', () => {
    const unnamed = { when: { type: 'yesno', op: 'at-least', probability: 0.8 }, outcome: 'ship' }
    expect(issues({ ...decision, routes: [unnamed] })).toEqual([
      'steps.1.routes.0.when: Route 1: Name the question this condition reads: there are 2 (ready, kind)',
    ])
    expect(issues({ ...decision, questions: { ready: decision.questions.ready }, routes: [unnamed] })).toEqual([])
  })

  test('rejects bad thresholds, duplicate inputs and empty questions', () => {
    const bad = (step: Record<string, unknown>) => workflowStepSchema.safeParse(step).success
    expect(
      bad({
        ...decision,
        routes: [{ when: { type: 'yesno', question: 'ready', op: 'at-least', probability: 1.5 }, outcome: 'ship' }],
      })
    ).toBe(false)
    expect(bad({ ...decision, input: ['title', 'title'] })).toBe(false)
    expect(bad({ ...decision, input: [] })).toBe(false)
    expect(bad({ ...decision, input: ['transcript'] })).toBe(false)
    expect(bad({ ...decision, questions: {} })).toBe(false)
  })

  test('a decision step cannot do revisions for another step', () => {
    const flow = definition()
    const build = flow.steps[0]!
    build.outcomes = { done: { next: 'triage' }, recheck: { returnTo: 'triage' } }
    const result = workflowDefinitionSchema.safeParse(flow)
    expect(result.success).toBe(false)
    expect(result.error!.issues.map((issue) => issue.message)).toContain("Decision step 'triage' cannot do revisions")
  })

  test('customizations can update a decision step in place', () => {
    const updated = applyWorkflowCustomizations(definition(), [
      { op: 'update-step', id: 'triage', changes: { otherwise: 'ship', unavailable: undefined } },
    ])
    expect(updated.steps[1]).toMatchObject({ kind: 'decision', otherwise: 'ship' })
    expect((updated.steps[1] as WorkflowDecisionStep).unavailable).toBeUndefined()
  })
})

const answered = (answers: Record<string, DecisionAnswer>): WorkflowDecisionReply => ({
  ok: true,
  result: { answers, providerId: 'jev', model: 'jev-latest', latencyMs: 42 },
})
const step = definition().steps[1] as WorkflowDecisionStep
const kindBug = { type: 'choice' as const, choice: 'bug', probabilities: { bug: 0.7, feature: 0.3 } }

describe('routeWorkflowDecision', () => {
  test('the first matching route wins', () => {
    const record = routeWorkflowDecision(step, answered({ ready: { type: 'yesno', probability: 0.9 }, kind: kindBug }))
    expect(record).toMatchObject({ status: 'answered', matched: 0, outcome: 'ship', providerId: 'jev', latencyMs: 42 })
    const second = routeWorkflowDecision(step, answered({ ready: { type: 'yesno', probability: 0.4 }, kind: kindBug }))
    expect(second).toMatchObject({ matched: 1, outcome: 'rework' })
  })

  test('a route without a question name reads the only question', () => {
    const single = {
      ...step,
      questions: { ready: step.questions.ready! },
      routes: [{ when: { type: 'yesno' as const, op: 'at-least' as const, probability: 0.8 }, outcome: 'ship' }],
    }
    expect(routeWorkflowDecision(single, answered({ ready: { type: 'yesno', probability: 0.9 } }))).toMatchObject({
      matched: 0,
      outcome: 'ship',
    })
    expect(routeWorkflowDecision(single, answered({ ready: { type: 'yesno', probability: 0.5 } }))).toMatchObject({
      matched: 'otherwise',
    })
  })

  test('no match follows otherwise, or waits for a person without one', () => {
    const answers = answered({
      ready: { type: 'yesno', probability: 0.4 },
      kind: { type: 'choice', choice: 'feature', probabilities: { feature: 0.9 } },
    })
    expect(routeWorkflowDecision(step, answers)).toMatchObject({ matched: 'otherwise', outcome: 'review' })
    const waiting = routeWorkflowDecision({ ...step, otherwise: undefined }, answers)
    expect(waiting).toMatchObject({ matched: 'otherwise', awaitingPerson: true })
    expect(waiting.outcome).toBeUndefined()
  })

  test('a refusal, a missing answer or no reply follows unavailable', () => {
    const refusal = routeWorkflowDecision(step, answered({ ready: { type: 'refusal' }, kind: kindBug }))
    expect(refusal).toMatchObject({ status: 'refused', matched: 'unavailable', outcome: 'review' })
    const missing = routeWorkflowDecision(step, answered({ ready: { type: 'yesno', probability: 0.9 } }))
    expect(missing).toMatchObject({ status: 'refused', outcome: 'review' })
    const unconfigured = routeWorkflowDecision(step, { ok: false, reason: 'unconfigured', errors: [] })
    expect(unconfigured).toMatchObject({ status: 'unconfigured', matched: 'unavailable', outcome: 'review' })
    expect(unconfigured.errors).toBeUndefined()
    const down = {
      ok: false as const,
      reason: 'unavailable' as const,
      errors: [{ providerId: 'jev', error: 'timeout' }],
    }
    expect(routeWorkflowDecision({ ...step, unavailable: undefined }, down)).toMatchObject({
      status: 'unavailable',
      awaitingPerson: true,
      errors: down.errors,
    })
  })

  test('the recorded result says why, by whom and what was answered', () => {
    const record = routeWorkflowDecision(step, answered({ ready: { type: 'yesno', probability: 0.9 }, kind: kindBug }))
    expect(describeWorkflowDecision(step, record)).toBe(
      [
        "Decision: 'ship' (route 1: ready ≥ 80%).",
        'Decided by jev · jev-latest in 42 ms.',
        'Answers: ready: yes 90%; kind: bug (70%).',
      ].join('\n')
    )
    const waiting = routeWorkflowDecision(
      { ...step, unavailable: undefined },
      { ok: false, reason: 'unconfigured', errors: [] }
    )
    expect(describeWorkflowDecision(step, waiting)).toBe(
      'No automatic decision (no decision provider is configured for workflow decisions); waiting for a person to choose the outcome.'
    )
  })
})

describe('decision steps in the run kernel', () => {
  function decided() {
    let run = createWorkflowRun(definition())
    run = advanceWorkflowRun(run, {
      action: 'complete',
      expectedVersion: 0,
      attemptId: 1,
      outcome: 'done',
      evidence: 'Built and tested.',
    })
    return run
  }

  test('a decision attempt starts without a participant', () => {
    const run = decided()
    expect(run.attempts[1]).toMatchObject({ stepId: 'triage', status: 'running' })
    expect(run.attempts[1]!.participant).toBeUndefined()
  })

  test('a person may choose a forward outcome without notes; a send-back needs them', () => {
    const run = decided()
    const forward = advanceWorkflowRun(run, {
      action: 'complete',
      expectedVersion: 1,
      attemptId: 2,
      outcome: 'review',
      evidence: '',
    })
    expect(forward.attempts[2]).toMatchObject({ stepId: 'approve', status: 'running' })
    expect(() =>
      advanceWorkflowRun(run, { action: 'complete', expectedVersion: 1, attemptId: 2, outcome: 'rework', evidence: '' })
    ).toThrow("Decision notes are required for 'rework'")
  })

  test('the step after a decision still receives the result decided on', () => {
    let run = decided()
    run = advanceWorkflowRun(run, {
      action: 'complete',
      expectedVersion: 1,
      attemptId: 2,
      outcome: 'review',
      evidence: "Decision: 'review' (no route matched).",
    })
    const approval = run.attempts[2]!
    expect(workflowIncomingAttempts(run, approval).map((attempt) => attempt.id)).toEqual([1, 2])
  })

  test('a flexible return cannot target a decision step', () => {
    const flow = definition()
    flow.routing = { mode: 'flexible', returnTo: 'earlier-steps', delegation: 'disabled' }
    let run = createWorkflowRun(flow)
    run = advanceWorkflowRun(run, {
      action: 'complete',
      expectedVersion: 0,
      attemptId: 1,
      outcome: 'done',
      evidence: 'x',
    })
    run = advanceWorkflowRun(run, {
      action: 'complete',
      expectedVersion: 1,
      attemptId: 2,
      outcome: 'review',
      evidence: 'x',
    })
    expect(() =>
      advanceWorkflowRun(run, {
        action: 'return',
        expectedVersion: 2,
        attemptId: 3,
        targetStepId: 'triage',
        resumeAt: 'approve',
        feedback: 'Decide again.',
      })
    ).toThrow('A decision step cannot do revisions')
  })
})
