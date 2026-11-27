import { expect, test } from 'bun:test'
import {
  workflowApprovalStatement,
  workflowAttemptAuthor,
  workflowAttemptSummary,
  workflowDecisionNotesHint,
  workflowOutcomeActionLabel,
  workflowOutcomeEffect,
  workflowWaitingLabel,
} from './workflow-review-labels'
import { advanceWorkflowRun, createWorkflowRun } from './workflow-runtime'
import { createBlankWorkflow } from './workflow-editing'
import { workflowDefinitionSchema, type WorkflowStep } from './workflows'

/** execute (an engineer) → Release approval → finish, or a check (a reviewer) and a sign-off; the gate is open. */
function gateRun({
  approvalEffect = 'Approval permits the release.',
  authored = true,
  oneForward = false,
}: { approvalEffect?: string; authored?: boolean; oneForward?: boolean } = {}) {
  const definition = createBlankWorkflow()
  definition.participants.builder = { agentTypeId: 'engineer', session: 'reuse-within-stream' }
  definition.participants.checker = { agentTypeId: 'reviewer', session: 'reuse-within-stream' }
  Object.assign(definition.steps[0]!, { participant: 'builder' })
  definition.steps[0]!.outcomes = { completed: { next: 'gate' } }
  definition.steps.push({
    id: 'gate',
    kind: 'human-approval',
    name: 'Release approval',
    instructions: 'Review before release.',
    output: 'Decision.',
    approver: 'reviewers',
    outcomes: {
      approved: { next: 'finish' },
      ...(oneForward ? {} : { 'needs-review': { parallel: ['check', 'sign-off'], join: 'finish' as const } }),
      'changes-requested': { returnTo: 'execute' },
    },
  })
  if (!oneForward)
    definition.steps.push(
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
  return { state, attemptAgents: { '1': 'builder-agent' } }
}

test('outcome effects say who gets the work next, in words', () => {
  const run = gateRun({ authored: false })
  const gate = run.state.attempts.at(-1)!
  const outcomes = (gate.step as { outcomes: Record<string, Parameters<typeof workflowOutcomeEffect>[1]> }).outcomes
  const typeName = (id: string) => ({ engineer: 'Engineer', reviewer: 'Reviewer' })[id] ?? id
  expect(
    workflowOutcomeEffect(run.state, outcomes['changes-requested']!, gate, 'changes-requested', { typeName })
  ).toBe('Returns to the Engineer with your notes')
  expect(workflowOutcomeEffect(run.state, outcomes.approved!, gate, 'approved', { typeName })).toBe(
    'Completes the work stream'
  )
  expect(workflowOutcomeEffect(run.state, outcomes['needs-review']!, gate, 'needs-review', { typeName })).toBe(
    'Next: check (Reviewer) and Product sign-off'
  )
})

test('what approval allows is the brief’s whole statement, never a part that reads as the whole', () => {
  const statement = (approvalEffect: string) => {
    const { state } = gateRun({ approvalEffect, oneForward: true })
    return workflowApprovalStatement(state, state.attempts.at(-1)!)
  }
  // Two sentences: the second is part of the promise, so it stays.
  const twoSentences = 'Approval merges the pull request. It also deploys the change to production immediately.'
  expect(statement(twoSentences)).toBe(twoSentences)
  // A list keeps every step, as markdown.
  const list = [
    'Approval starts the rollout in three stages:',
    '',
    '1. Merge the change to main.',
    '2. Turn the flag on for 10% of traffic.',
    '3. Raise it to all traffic after a day without errors.',
  ].join('\n')
  expect(statement(list)).toBe(list)
  // A leading code block is kept, so the sentence after it still has the command it refers to.
  const code = [
    '```sh',
    'bun run migrate --target staging',
    '```',
    '',
    'Approval runs the command above on staging only.',
  ].join('\n')
  expect(statement(code)).toBe(code)
  // Two forward outcomes: which one the statement describes is unknown, so neither carries it.
  const { state: twoForward } = gateRun({ approvalEffect: twoSentences })
  expect(workflowApprovalStatement(twoForward, twoForward.attempts.at(-1)!)).toBeUndefined()
  // No brief authored for this gate, no statement.
  const { state: none } = gateRun({ authored: false, oneForward: true })
  expect(workflowApprovalStatement(none, none.attempts.at(-1)!)).toBeUndefined()
})

test('an attempt is prepared by its agent type, with the agent’s purpose when it has one', () => {
  const run = gateRun()
  const execute = run.state.attempts[0]!
  const typeName = (id: string) => (id === 'engineer' ? 'Engineer' : id)
  const agent = (purpose?: string) =>
    new Map([['builder-agent', { agentTypeId: 'engineer', metadata: purpose === undefined ? {} : { purpose } }]])
  expect(workflowAttemptAuthor(run, execute, { agents: agent('Payments'), typeName })).toBe('Engineer (Payments)')
  expect(workflowAttemptAuthor(run, execute, { agents: agent('  '), typeName })).toBe('Engineer')
  // The agent list may be unavailable: the participant the attempt ran as still names it.
  expect(workflowAttemptAuthor(run, execute)).toBe('Engineer')
  // Without the squad's type names, the general type is not shortened to "General".
  const general = { ...run, attemptAgents: { '1': 'general-agent' } }
  const generalAgent = new Map([['general-agent', { agentTypeId: 'general', metadata: { purpose: 'Docs' } }]])
  expect(workflowAttemptAuthor(general, execute, { agents: generalAgent })).toBe('General Purpose agent (Docs)')
  // No agent prepared a person's gate decision.
  expect(workflowAttemptAuthor(run, run.state.attempts.at(-1)!)).toBeUndefined()
})

test('waiting labels say how long in the largest whole unit', () => {
  const now = Date.parse('2026-11-26T13:20:00.000Z')
  expect(workflowWaitingLabel('2026-11-26T13:19:30.000Z', now)).toBe('Waiting less than a minute')
  expect(workflowWaitingLabel('2026-11-26T13:19:00.000Z', now)).toBe('Waiting 1 minute')
  expect(workflowWaitingLabel('2026-11-26T12:00:00.000Z', now)).toBe('Waiting 1 hour')
  expect(workflowWaitingLabel('2026-11-26T08:00:00.000Z', now)).toBe('Waiting 5 hours')
  expect(workflowWaitingLabel('2026-11-19T13:20:00.000Z', now)).toBe('Waiting 7 days')
  // A clock behind the server never reads as negative.
  expect(workflowWaitingLabel('2026-11-26T13:25:00.000Z', now)).toBe('Waiting less than a minute')
})

test('an attempt summary names its step, attempt and outcome', () => {
  const run = gateRun()
  expect(workflowAttemptSummary(run.state, run.state.attempts[0]!)).toBe('execute · Attempt 1 · Completed')
  expect(workflowAttemptSummary(run.state, run.state.attempts.at(-1)!)).toBe('Release approval · Attempt 2')
})

test('decision buttons say what they do now; a send-back alone needs notes', () => {
  expect(workflowOutcomeActionLabel('approved')).toBe('Approve')
  expect(workflowOutcomeActionLabel('changes_requested')).toBe('Request changes')
  expect(workflowOutcomeActionLabel('ship-it')).toBe('Ship it')
  const run = gateRun()
  const gate = run.state.attempts.at(-1)!
  const step = gate.step as WorkflowStep
  expect(workflowDecisionNotesHint(step, Object.entries(step.outcomes))).toBe(
    'Optional for Approve, Needs review; required for Request changes. Your notes are recorded with the decision and passed to the next step.'
  )
})
