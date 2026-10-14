import { expect, test } from 'bun:test'
import type { WorkflowDefinition } from '@ficus/shared'
import { decisionStepWarnings, withWarnings } from './decision-step-warnings'

const steps = (kinds: Array<'agent' | 'decision' | 'human-approval'>) =>
  ({ steps: kinds.map((kind, index) => ({ id: `step-${index + 1}`, kind })) }) as unknown as WorkflowDefinition

test('decision steps with no decision model to ask are named in a warning', () => {
  const none = () => []
  expect(decisionStepWarnings(steps(['agent', 'decision']), none)).toEqual([
    "No decision model is set up for Workflow decisions (Settings → Decision Providers), so decision step 'step-2' will not be asked: it takes its unavailable outcome, or waits for a reviewer when that is omitted.",
  ])
  expect(decisionStepWarnings(steps(['decision', 'human-approval', 'decision']), none)[0]).toContain(
    "decision steps 'step-1', 'step-3' will not be asked: each takes its"
  )
})

test('no warning without decision steps, or with a decision model set up', () => {
  expect(decisionStepWarnings(steps(['agent', 'human-approval']), () => [])).toEqual([])
  expect(decisionStepWarnings(steps(['decision']), () => [{ id: 'jev' }])).toEqual([])
  expect(withWarnings([])).toEqual({})
  expect(withWarnings(['x'])).toEqual({ warnings: ['x'] })
})
