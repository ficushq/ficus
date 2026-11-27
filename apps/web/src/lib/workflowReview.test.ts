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
import {
  approvalEffectSummary,
  attemptAuthor,
  humanGateContext,
  openHumanGates,
  outcomeEffect,
  producingAgents,
  revisedLabel,
  waitingLabel,
} from './workflowReview'

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

test('human return review captions name the effective resume destination instead of the ordinary next edge', async () => {
  const { outcomeEffect } = await import('./workflowReview')
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes = {
    check: { returnTo: 'gate', afterRework: 'return-to-requester' },
    done: { next: 'finish' },
  }
  definition.steps.push({
    id: 'gate',
    kind: 'human-approval',
    instructions: 'Review staging.',
    output: 'Decision.',
    outcomes: { yes: { next: 'finish' } },
  })
  const { brief } = await import('../../../../packages/shared/src/test-fixtures/workflow-review')
  const state = advanceWorkflowRun(createWorkflowRun(definition), {
    action: 'return',
    expectedVersion: 0,
    attemptId: 1,
    targetStepId: 'gate',
    resumeAt: 'execute',
    feedback: 'Review staging before resuming.',
    decisionBrief: brief,
  })
  const attempt = state.attempts.at(-1)!
  const gate = humanGateContext(
    stream,
    { state, openWaits: [], version: state.version } as unknown as WorkflowRunDetail,
    attempt,
    { can: () => true }
  )!
  expect(outcomeEffect(state, gate.outcomes[0]![1], gate.attempt, 'yes')).toBe(
    'Moves on to execute with the General agent'
  )
})

/** execute (an engineer) → review (another engineer) → gate → finish, with the gate open on attempt 3. */
function gateRun(approvalEffect = 'Approval permits the release.', authored = true) {
  const definition = createBlankWorkflow()
  definition.participants.builder = { agentTypeId: 'engineer', session: 'reuse-within-stream' }
  definition.participants.checker = { agentTypeId: 'reviewer', session: 'reuse-within-stream' }
  definition.steps[0]!.participant = 'builder'
  definition.steps[0]!.outcomes = { completed: { next: 'gate' } }
  definition.steps.push(
    {
      id: 'gate',
      kind: 'human-approval',
      name: 'Release approval',
      instructions: 'Review before release.',
      output: 'Decision.',
      approver: 'reviewers',
      outcomes: {
        approved: { next: 'finish' },
        'needs-review': { parallel: ['check', 'sign-off'], join: 'finish' },
        'changes-requested': { returnTo: 'execute' },
      },
    },
    {
      id: 'check',
      participant: 'checker',
      kind: 'agent',
      instructions: 'Check it.',
      output: 'Findings.',
      outcomes: { done: { next: 'finish' } },
    },
    {
      id: 'sign-off',
      name: 'Product sign-off',
      kind: 'human-approval',
      approver: 'reviewers',
      instructions: 'Sign off.',
      output: 'Decision.',
      outcomes: { yes: { next: 'finish' } },
    }
  )
  const state = advanceWorkflowRun(createWorkflowRun(workflowDefinitionSchema.parse(definition)), {
    action: 'complete',
    expectedVersion: 0,
    attemptId: 1,
    outcome: 'completed',
    evidence: 'Built.',
    decisionBrief: {
      decision: 'Approve releasing the payment retry change to customers.',
      recommendation: 'Approve it, because every retry test passes on the release branch.',
      approvalEffect,
      risks: 'Each retried request does one extra lookup, which adds a little latency.',
    },
  })
  if (!authored) state.attempts.at(-1)!.reviewBrief = { kind: 'none' }
  return { state, attemptAgents: { '1': 'builder-agent' } } as unknown as WorkflowRunDetail
}

test('outcome effects say who gets the work next, in words', () => {
  const run = gateRun(undefined, false)
  const gate = run.state.attempts.at(-1)!
  const outcomes = (gate.step as { outcomes: Record<string, Parameters<typeof outcomeEffect>[1]> }).outcomes
  const typeName = (id: string) => ({ engineer: 'Engineer', reviewer: 'Reviewer' })[id] ?? id
  expect(outcomeEffect(run.state, outcomes['changes-requested']!, gate, 'changes-requested', { typeName })).toBe(
    'Returns to the Engineer with your notes'
  )
  expect(outcomeEffect(run.state, outcomes.approved!, gate, 'approved', { typeName })).toBe('Completes the work stream')
  expect(outcomeEffect(run.state, outcomes['needs-review']!, gate, 'needs-review', { typeName })).toBe(
    'Moves on to check with the Reviewer and Product sign-off for review'
  )
  // Said in place of where the work goes, when the brief states it; never for a send-back.
  expect(outcomeEffect(run.state, outcomes.approved!, gate, 'approved', { approvalEffect: 'Lets it ship.' })).toBe(
    'Lets it ship.'
  )
  expect(
    outcomeEffect(run.state, outcomes['changes-requested']!, gate, 'changes-requested', {
      approvalEffect: 'Lets it ship.',
    })
  ).toBe('Returns to the Engineer with your notes')
})

test('approval effects shorten to the first sentence, led by what approval does', () => {
  const short = (text: string) => {
    const { state } = gateRun(text)
    return approvalEffectSummary(state, state.attempts.at(-1)!)
  }
  expect(
    short(
      'Approval lets the release reviewer merge the `payment-retries` change. Going beyond 10% needs a separate go-ahead.'
    )
  ).toEqual({
    short: 'Lets the release reviewer merge the payment-retries change.',
    full: 'Approval lets the release reviewer merge the payment-retries change. Going beyond 10% needs a separate go-ahead.',
  })
  expect(short('Approving this permits staging only.')?.short).toBe('Permits staging only.')
  // A statement that does not open with approval's verb is kept as written.
  expect(short('Approval of the design starts implementation.')?.short).toBe(
    'Approval of the design starts implementation.'
  )
  expect(short('Merges the change. ' + 'And more words. '.repeat(3))?.short).toBe('Merges the change.')
  expect(short(`Merges ${'word '.repeat(60)}`)?.short).toMatch(/^Merges (word ){20,}word…$/)
  // No brief authored for this gate, no short form.
  const none = gateRun(undefined, false).state
  expect(approvalEffectSummary(none, none.attempts.at(-1)!)).toBeUndefined()
})

test('an attempt is prepared by its agent type, with the agent’s purpose when it has one', () => {
  const run = gateRun()
  const execute = run.state.attempts[0]!
  const typeName = (id: string) => (id === 'engineer' ? 'Engineer' : id)
  const agent = (purpose?: string) =>
    new Map([['builder-agent', { agentTypeId: 'engineer', metadata: purpose === undefined ? {} : { purpose } }]])
  expect(attemptAuthor(run, execute, { agents: agent('Payments'), typeName })).toBe('Engineer (Payments)')
  expect(attemptAuthor(run, execute, { agents: agent('  '), typeName })).toBe('Engineer')
  // The agent list may be unavailable: the participant the attempt ran as still names it.
  expect(attemptAuthor(run, execute)).toBe('Engineer')
  // No agent prepared a person's gate decision.
  expect(attemptAuthor(run, run.state.attempts.at(-1)!)).toBeUndefined()
})

test('waiting labels say how long in the largest whole unit', () => {
  const now = Date.parse('2026-11-26T13:20:00.000Z')
  expect(waitingLabel('2026-11-26T13:19:30.000Z', now)).toBe('Waiting less than a minute')
  expect(waitingLabel('2026-11-26T13:19:00.000Z', now)).toBe('Waiting 1 minute')
  expect(waitingLabel('2026-11-26T12:00:00.000Z', now)).toBe('Waiting 1 hour')
  expect(waitingLabel('2026-11-26T08:00:00.000Z', now)).toBe('Waiting 5 hours')
  expect(waitingLabel('2026-11-19T13:20:00.000Z', now)).toBe('Waiting 7 days')
  // A clock behind the server never reads as negative.
  expect(waitingLabel('2026-11-26T13:25:00.000Z', now)).toBe('Waiting less than a minute')
})

test('revised labels count minutes and hours since the revision', () => {
  const now = Date.parse('2026-10-30T12:00:00.000Z')
  expect(revisedLabel('2026-10-30T11:59:40.000Z', now)).toBe('Revised just now')
  expect(revisedLabel('2026-10-30T11:58:00.000Z', now)).toBe('Revised 2 min ago')
  expect(revisedLabel('2026-10-30T09:00:00.000Z', now)).toBe('Revised 3 h ago')
})

test('producing agents are the agents bound to the agent sources of a gate', () => {
  const run = decisionRun(true)
  const sources = run.state.attempts.filter((attempt) => attempt.stepId === 'execute')
  expect(producingAgents({ ...run, attemptAgents: { '1': 'agent-a' } }, sources)).toEqual([
    { agentId: 'agent-a', sources },
  ])
  expect(producingAgents({ ...run, attemptAgents: {} }, sources)).toEqual([])
  // A decision step has no agent of its own.
  expect(producingAgents({ ...run, attemptAgents: { '2': 'agent-b' } }, run.state.attempts.slice(1))).toEqual([])
})
