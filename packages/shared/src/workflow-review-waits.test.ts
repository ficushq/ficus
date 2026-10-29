import { expect, test } from 'bun:test'
import { selectWorkStreamPresentationState, workStreamNeedsHumanAttention, type WorkStreamWaitDisplayFacts } from './status-presentation'
import { workflowReviewBlockingWaits, workStreamQueuedReviewLabel } from './workflow-review-waits'
const gate = {
  id: 'gate',
  type: 'manual' as const,
  resolutionHandler: 'workflow' as const,
  flowAttemptId: 2,
  workflowHumanGate: true,
}
const owner = { id: 'owner', type: 'manual' as const, actor: 'owner' as const, flowAttemptId: null }
const state = (openWaits: (WorkStreamWaitDisplayFacts & { id: string })[]) => ({
  status: 'active' as const,
  openWaits,
})
test('blocked reviews present the blocker and queued note; clearance restores review', () => {
  expect(selectWorkStreamPresentationState(state([gate]))).toBe('in_review')
  expect(workflowReviewBlockingWaits(gate, [gate, owner])).toEqual([owner])
  expect(selectWorkStreamPresentationState(state([gate, owner]))).toBe('waiting_on_owner')
  expect(workStreamQueuedReviewLabel(state([gate, owner]))).toBe('Review queued')
  expect(workStreamNeedsHumanAttention(state([gate, owner]))).toBe(false)
  expect(workStreamNeedsHumanAttention(state([gate, owner, { id: 'question', type: 'question' }]))).toBe(true)
  expect(workStreamQueuedReviewLabel(state([gate]))).toBeNull()
})
test('scope and exact gate identity match runtime; a sibling never blocks', () => {
  expect(workflowReviewBlockingWaits(gate, [gate, { ...owner, flowAttemptId: 3 }])).toEqual([])
  expect(workflowReviewBlockingWaits(gate, [gate, { ...owner, flowAttemptId: 2 }])).toHaveLength(1)
  expect(workflowReviewBlockingWaits(gate, [gate, { ...gate, id: 'other', workflowHumanGate: false }])).toHaveLength(1)
  expect(
    selectWorkStreamPresentationState(
      state([gate, { ...gate, id: 'sibling', flowAttemptId: 3 }, { ...owner, flowAttemptId: 2 }])
    )
  ).toBe('in_review')
})
