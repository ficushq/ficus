import { expect, test } from 'bun:test'
import { advanceWorkflowRun, createBlankWorkflow, createWorkflowRun, workflowCommandSchema } from '@ficus/shared'
import { flowCapabilityInstructions } from './capability-instructions'

test('Solo assignments explicitly disable delegation and require management for live revisions', () => {
  const run = createWorkflowRun(createBlankWorkflow())
  const message = flowCapabilityInstructions(run, run.attempts[0]!)
  expect(message).toContain('Delegation: disabled')
  expect(message).toContain('flow-management permission is required')
  expect(message).not.toContain('"action": "delegate"')
  expect(message).toContain('completed: delivery policy')
})

test('adaptive assignments explain their remaining budget and include a valid versioned delegation command', () => {
  const definition = createBlankWorkflow()
  definition.routing = { mode: 'adaptive', returnTo: 'earlier-steps', delegation: 'allowed' }
  definition.limits.maxDelegations = 3
  const run = createWorkflowRun(definition)
  run.delegationCount = 1
  const message = flowCapabilityInstructions(run, run.attempts[0]!, 7)
  expect(message).toContain('2 of 3 specialist assignments remain')
  expect(message).toContain('active=keep')
  expect(message).toContain('do not increase limits')
  expect(message).not.toContain('COMMAND.json')
  expect(message).toContain('--content')
  expect(message).toContain("ficus workstream advance STREAM_ID --stdin <<'FICUS_COMMAND'")
  const example = JSON.parse(message.match(/<<'FICUS_COMMAND'\n([\s\S]*?)\nFICUS_COMMAND/)![1]!)
  expect(workflowCommandSchema.parse(example)).toMatchObject({ action: 'delegate', expectedVersion: 7, attemptId: 1 })
  run.delegationCount = 3
  const exhausted = flowCapabilityInstructions(run, run.attempts[0]!)
  expect(exhausted).toContain('Delegation: budget exhausted')
  expect(exhausted).not.toContain('"action": "delegate"')
})

test('handoff guidance uses the current attempt snapshot when future routing has been revised', () => {
  const run = createWorkflowRun(createBlankWorkflow())
  run.definition.steps[0]!.outcomes = { revised: { next: 'future' } }
  const message = flowCapabilityInstructions(run, run.attempts[0]!)
  expect(message).toContain('completed: delivery policy')
  expect(message).not.toContain('revised: future')
})

test('additional returns follow graph predecessors rather than definition array order', () => {
  const definition = createBlankWorkflow()
  const current = definition.steps[0]!
  definition.routing = { mode: 'flexible', returnTo: 'earlier-steps', delegation: 'disabled' }
  definition.steps.push({ ...structuredClone(current), id: 'prepare', outcomes: { completed: { next: current.id } } })
  definition.entry = 'prepare'
  const initial = createWorkflowRun(definition)
  const run = advanceWorkflowRun(initial, {
    expectedVersion: initial.version,
    attemptId: initial.activeAttemptId,
    action: 'complete',
    outcome: 'completed',
    evidence: 'Preparation verified',
  })
  const attempt = run.attempts.find((attempt) => attempt.id === run.activeAttemptId)!
  expect(flowCapabilityInstructions(run, attempt)).toContain('Additional return targets: prepare.')
})
