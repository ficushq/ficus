import { expect, test } from 'bun:test'
import {
  advanceWorkflowRun,
  createBlankWorkflow,
  createWorkflowRun,
  routeWorkflowDecision,
  workflowDefinitionSchema,
  type WorkflowDecisionStep,
  type WorkStream,
} from '@ficus/shared'
import type { WorkflowRunDetail } from '@ficus/client-core'
import { humanGateContext, openHumanGates } from './workflowReview'

const stream = { id: 'decided', status: 'active', assignedReviewerIds: ['someone-else'] } as unknown as WorkStream

/** execute (agent) → triage (decision) → finish, with the decision step active. */
function decisionRun(awaitingPerson: boolean): WorkflowRunDetail {
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes = { completed: { next: 'triage' } }
  definition.steps.push({
    id: 'triage',
    kind: 'decision',
    instructions: 'Decide whether it ships.',
    input: ['incoming-results'],
    questions: { ready: { type: 'yesno', instructions: 'Ready.' } },
    routes: [{ when: { type: 'yesno', question: 'ready', op: 'at-least', probability: 0.8 }, outcome: 'ship' }],
    outcomes: { ship: { next: 'finish' }, rework: { returnTo: 'execute' } },
  })
  let state = createWorkflowRun(workflowDefinitionSchema.parse(definition))
  state = advanceWorkflowRun(state, {
    action: 'complete',
    expectedVersion: 0,
    attemptId: 1,
    outcome: 'completed',
    evidence: 'Built.',
  })
  if (awaitingPerson)
    state.attempts[1]!.decision = routeWorkflowDecision(state.attempts[1]!.step as WorkflowDecisionStep, {
      ok: false,
      reason: 'unconfigured',
      errors: [],
    })
  return { state, version: state.version, openWaits: [] } as unknown as WorkflowRunDetail
}

test('a decision step is a person’s gate only once it waits for a person', () => {
  expect(openHumanGates(stream, decisionRun(false))).toEqual([])
  const run = decisionRun(true)
  const [gate] = openHumanGates(stream, run)
  expect(gate?.stepId).toBe('triage')
  const context = humanGateContext(stream, run, gate!, { can: () => true, identity: { type: 'user', userId: 'me' } })!
  // Assigned reviewers restrict approvals only; any reviewer chooses for a decision step.
  expect(context.canDecide).toBe(true)
  expect(context.decisionNote).toContain('no decision provider is configured')
  expect(context.sources.map((attempt) => attempt.stepId)).toEqual(['execute'])
  expect(context.outcomes.map(([name]) => name)).toEqual(['ship', 'rework'])
})
