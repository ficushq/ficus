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
