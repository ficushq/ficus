import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  advanceWorkflowRun,
  createWorkflowRun,
  workflowPresetSchema,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@ficus/shared'
import { outputRecipients } from './routing-audience'
import { CodeHostingRegistry } from '../code-hosting/registry'
import { githubCodeHostingAdapter } from '../github/code-hosting'

const root = resolve(import.meta.dir, '../../../../../..')
const registry = new CodeHostingRegistry([githubCodeHostingAdapter])
const metadata = { codeHost: { integration: 'github', repository: 'owner/repo', changeRequest: { number: 7 } } }
const ENGINEER = 'engineer-agent'
const REVIEWER = 'reviewer-agent'

async function reviewedCoding(): Promise<WorkflowDefinition> {
  const yaml = await Bun.file(`${root}/config/workflows/reviewed-coding.yaml`).text()
  return workflowPresetSchema.parse(Bun.YAML.parse(yaml)).definition
}

function complete(state: WorkflowRun, outcome: string): WorkflowRun {
  const attempt = state.attempts.find((candidate) => candidate.status === 'running')!
  return advanceWorkflowRun(state, {
    action: 'complete',
    expectedVersion: state.version,
    attemptId: attempt.id,
    outcome,
    evidence: 'Done',
  })
}

/** A reviewed-coding stream whose reviewer approved: completion-ready with no active attempt. */
function approved(definition: WorkflowDefinition) {
  const state = complete(complete(createWorkflowRun(definition), 'completed'), 'approved')
  expect(state.status).toBe('completion-ready')
  const run = { state, version: state.version, attemptAgents: { '1': ENGINEER, '2': REVIEWER } }
  const stream = { assigneeAgentId: null }
  return (output: string) => {
    const subscription = registry.subscriptions(definition, metadata).find((sub) => sub.source.output === output)!
    expect(subscription).toBeDefined()
    return outputRecipients(run as never, stream as never, subscription, 'manager-agent').map(
      (target) => target.agentId
    )
  }
}

const CHANGE_EVENTS = [
  'pull_request.ci_completed',
  'pull_request.updated',
  'pull_request.review_requested',
  'pull_request.reviewed',
  'pull_request.comment',
  'pull_request.review_comment',
]
const DELIVERY_EVENTS = ['pull_request.merged', 'pull_request.closed']

test('reviewed-coding defaults: change events reach the engineer, merged and closed reach the approving reviewer', async () => {
  const recipients = approved(await reviewedCoding())
  for (const output of CHANGE_EVENTS) expect(recipients(output)).toEqual([ENGINEER])
  for (const output of DELIVERY_EVENTS) expect(recipients(output)).toEqual([REVIEWER])
})

test('explicit delivery-owner sends every code-host event to the delivery owner', async () => {
  const definition = await reviewedCoding()
  definition.completion.changeEventsTo = 'delivery-owner'
  const recipients = approved(definition)
  for (const output of [...CHANGE_EVENTS, ...DELIVERY_EVENTS]) expect(recipients(output)).toEqual([REVIEWER])
})

test('an explicit {step: implement} customization still routes merges to the delivery owner', async () => {
  // The shape set by hand on in-flight streams before the default changed.
  const definition = await reviewedCoding()
  delete definition.completion.changeEventsTo
  definition.completion.changeEventsTo = { step: 'implement' }
  const recipients = approved(definition)
  expect(recipients('pull_request.merged')).toEqual([REVIEWER])
  expect(recipients('pull_request.closed')).toEqual([REVIEWER])
  expect(recipients('pull_request.ci_completed')).toEqual([ENGINEER])
})

async function reviewing() {
  const definition = await reviewedCoding()
  const state = complete(createWorkflowRun(definition), 'completed')
  const run = { state, version: state.version, attemptAgents: { '1': ENGINEER, '2': REVIEWER } }
  const subscription = registry
    .subscriptions(definition, metadata)
    .find((sub) => sub.source.output === 'pull_request.ci_completed')!
  const recipients = (sub = subscription) => outputRecipients(run as never, { assigneeAgentId: REVIEWER } as never, sub)
  return { definition, run, subscription, recipients }
}

test('inferred CI informs running review after the configured implementation completes without changing state', async () => {
  const { run, recipients } = await reviewing()
  const before = structuredClone(run)
  expect(recipients()).toEqual([{ agentId: REVIEWER, attemptId: 2 }])
  expect(run).toEqual(before)
})

test('explicit subscriptions and non-CI change events retain their configured inactive target', async () => {
  const { subscription, recipients } = await reviewing()
  expect(recipients({ ...subscription, id: 'custom-ci' })).toEqual([])
  for (const output of CHANGE_EVENTS.filter((output) => output !== 'pull_request.ci_completed'))
    expect(recipients({ ...subscription, source: { ...subscription.source, output } })).toEqual([])
})

test('participant targets and inferred tracked PR CI use the same observational fallback', async () => {
  const { subscription, recipients } = await reviewing()
  expect(
    recipients({ ...subscription, deliver: { ...subscription.deliver, to: { participant: 'engineer' } } })
  ).toEqual([{ agentId: REVIEWER, attemptId: 2 }])
  expect(recipients({ ...subscription, id: 'tracked-fixture-ci' })).toEqual([{ agentId: REVIEWER, attemptId: 2 }])
})

test('an undispatched configured running target is not replaced by an observer', async () => {
  const { run, subscription, recipients } = await reviewing()
  run.state = createWorkflowRun(run.state.definition)
  run.version = run.state.version
  run.attemptAgents = {} as typeof run.attemptAgents
  expect(recipients()).toEqual([])
  expect(recipients({ ...subscription, deliver: { ...subscription.deliver, to: { step: 'review' } } })).toEqual([])
})

test('running configured targets take priority before review and after authorized return', async () => {
  const { run, recipients } = await reviewing()
  run.state = complete(run.state, 'changes-requested')
  run.version = run.state.version
  Object.assign(run.attemptAgents, { '3': ENGINEER })
  expect(recipients()).toEqual([{ agentId: ENGINEER, attemptId: 3 }])
  run.state = createWorkflowRun(run.state.definition)
  run.version = run.state.version
  expect(recipients()).toEqual([{ agentId: ENGINEER, attemptId: 1 }])
})

test('an explicit subscription for a future configured step is retained', async () => {
  const { subscription, recipients } = await reviewing()
  expect(
    recipients({ ...subscription, id: 'explicit', deliver: { ...subscription.deliver, to: { step: 'future' } } })
  ).toEqual([])
})

test('CI does not use completed implementation to bypass a human approval step', async () => {
  const { run, recipients } = await reviewing()
  const index = run.state.definition.steps.findIndex((step) => step.id === 'review')
  run.state.definition.steps[index] = {
    id: 'review',
    kind: 'human-approval',
    approver: 'assigned-reviewers',
    instructions: 'A person must approve',
    output: 'Decision',
    outcomes: { approved: { next: 'finish' } },
  }
  run.state = complete(createWorkflowRun(run.state.definition), 'completed')
  run.version = run.state.version
  expect(recipients()).toEqual([])
})

test('parallel active agents observe CI without activating or completing their join', async () => {
  const { definition, run, recipients } = await reviewing()
  definition.participants.security = { agentTypeId: 'reviewer', session: 'reuse-within-stream' }
  definition.steps[0]!.outcomes = { completed: { parallel: ['review', 'security'], join: 'join' } }
  definition.steps[1]!.outcomes = { approved: { next: 'join' } }
  definition.steps.push(
    {
      id: 'security',
      kind: 'agent',
      participant: 'security',
      instructions: 'Security review',
      output: 'Verdict',
      outcomes: { approved: { next: 'join' } },
    },
    {
      id: 'join',
      kind: 'agent',
      participant: 'reviewer',
      instructions: 'Join',
      output: 'Result',
      outcomes: { approved: { next: 'finish' } },
    }
  )
  run.state = complete(createWorkflowRun(definition), 'completed')
  run.version = run.state.version
  Object.assign(run.attemptAgents, { '3': 'security-agent' })
  const before = structuredClone(run.state)
  expect(recipients()).toEqual([
    { agentId: REVIEWER, attemptId: 2 },
    { agentId: 'security-agent', attemptId: 3 },
  ])
  expect(run.state).toEqual(before)
})

test('inferred CI informs implementation when the configured review target has never run', async () => {
  const { run, subscription, recipients } = await reviewing()
  run.state = createWorkflowRun(run.state.definition)
  run.version = run.state.version
  expect(recipients({ ...subscription, deliver: { ...subscription.deliver, to: { step: 'review' } } })).toEqual([
    { agentId: ENGINEER, attemptId: 1 },
  ])
})
