import { expect, test } from 'bun:test'
import { eventStreamPreparationSteps } from './event-preparation'

test('preparing an event-created stream starts with a readable title and summary, then the workspace', () => {
  const steps = eventStreamPreparationSteps('#1005')
  expect(steps).toContain('The workflow is paused before any workers start.')
  const retitle = steps.indexOf('ficus workstream update #1005 --title')
  const summary = steps.indexOf('ficus workstream update #1005 -d')
  const resume = steps.indexOf('ficus workstream resume #1005')
  expect(retitle).toBeGreaterThan(-1)
  expect(summary).toBeGreaterThan(retitle)
  expect(resume).toBeGreaterThan(summary)
  // The original event text stays as evidence under the summary.
  expect(steps).toContain('keeping the original event text unchanged below it')
  expect(steps).toContain('Do not manually bypass repository setup guards.')
})
