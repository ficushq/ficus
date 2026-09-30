import { expect, test } from 'bun:test'
import { createBlankWorkflow, createWorkflowRun, advanceWorkflowRun, workflowCommandSchema } from '@ficus/shared'
import { flowMessage } from './handoff-prompt'
import { deliveryInstructionsForRun } from './completion-prompt'

const stream = {
  id: 'stream-1',
  title: 'Fix config loading',
  description: 'Preserve compatibility. Initially no defect selected.',
  metadata: {
    git: { worktree: '/workspace/fix', branch: 'fix', baseBranch: 'main' },
    codeHost: { repository: 'example/repo' },
  },
}

test('handoffs retain requirements, show actual workspace, and provide a schema-valid completion command', () => {
  const state = createWorkflowRun(createBlankWorkflow())
  const prompt = flowMessage(stream, { state, version: 7 }, state.attempts[0]!)
  expect(prompt).toContain(stream.description)
  expect(prompt).toContain('Original work brief (initial context; use incoming results for progress)')
  expect(prompt).toContain('Worktree: /workspace/fix\nBranch: fix\nBase: main\nRepository: example/repo')
  expect(prompt).toContain('--content')
  expect(prompt).not.toContain('--file')
  expect(prompt).toContain("ficus workstream advance stream-1 --stdin <<'FICUS_COMMAND'")
  const command = JSON.parse(prompt.match(/<<'FICUS_COMMAND'\n([\s\S]*?)\nFICUS_COMMAND/)![1]!)
  expect(workflowCommandSchema.parse(command)).toMatchObject({
    action: 'complete',
    expectedVersion: 7,
    attemptId: 1,
    evidence: expect.any(String),
  })
  expect(prompt).not.toContain('Incoming results:')
  expect(prompt).not.toContain('Open return requests:')
  expect(prompt).not.toContain('Parallel agents')
  expect(prompt).not.toContain('Delivery policy:')
  expect(prompt).not.toContain('no attempt limit')
})

test('handoffs include only recorded incoming attempts, retain all join inputs, and scope return feedback', () => {
  const state = createWorkflowRun(createBlankWorkflow())
  for (let index = 0; index < 10; index++)
    state.attempts.push({
      id: index + 2,
      stepId: 'research',
      status: 'completed',
      branch: { forkId: 1, branchId: `branch-${index}` },
      evidence: `Evidence ${index}`,
    })
  state.attempts.push({
    id: 12,
    stepId: 'research',
    status: 'completed',
    branch: { forkId: 1, branchId: 'branch-0' },
    evidence: 'Revised evidence',
  })
  state.returns.push({
    id: 1,
    requestedByAttemptId: 12,
    targetStepId: 'execute',
    resumeAt: 'review',
    feedback: 'Fix the missing default-path check.',
    status: 'open',
    parentId: null,
  })
  state.attempts[0]!.sourceAttemptIds = [12, ...Array.from({ length: 9 }, (_, index) => index + 3)]
  state.returns.push({
    ...state.returns[0]!,
    id: 2,
    branch: { forkId: 1, branchId: 'other' },
    feedback: 'Unrelated request',
  })
  const prompt = flowMessage(stream, { state, version: 12 }, state.attempts[0]!)
  expect(prompt).not.toContain('Evidence 0')
  expect(prompt).toContain('research (attempt 12): Revised evidence')
  expect(prompt).not.toContain('History:')
  expect(prompt).not.toContain('After submitting,')
  for (let index = 1; index < 10; index++)
    expect(prompt).toContain(`research (attempt ${index + 2}): Evidence ${index}`)
  expect(prompt).toContain('execute → review: Fix the missing default-path check.')
  expect(prompt).not.toContain('Unrelated request')
  expect(prompt.indexOf('Incoming results:')).toBeLessThan(prompt.indexOf('Original work brief'))
})

test('parallel guidance only appears for an active branch or concurrent attempts', () => {
  const state = createWorkflowRun(createBlankWorkflow())
  state.attempts[0]!.branch = { forkId: 1, branchId: 'left' }
  expect(flowMessage(stream, { state, version: 0 }, state.attempts[0]!)).toContain(
    'Parallel work is active in this shared workspace.'
  )
})

test('delivery instructions are available only for current active completion work, preserving merge authority', () => {
  const state = createWorkflowRun(createBlankWorkflow())
  state.definition.completion.mode = 'pr-auto-merge'
  expect(deliveryInstructionsForRun({ ...stream, status: 'active' }, state, 0)).toBeUndefined()
  state.status = 'completion-ready'
  const instructions = deliveryInstructionsForRun({ ...stream, status: 'active' }, state, 4)!
  expect(instructions).toContain('metadata.policies.allowAutoMerge')
  expect(instructions).toContain('Do not enable that policy yourself')
  expect(instructions).toContain('ficus workstream finish stream-1 --version 4')
  expect(instructions).toContain('existing codeHost binding')
  expect(instructions).not.toContain('"action":"rework"')
  expect(instructions).not.toContain('--file')
  expect(instructions).not.toContain('github.repo/github.pr')
  expect(deliveryInstructionsForRun({ ...stream, status: 'done' }, state, 4)).toBeUndefined()
  expect(deliveryInstructionsForRun({ ...stream, status: 'active', pause: {} }, state, 4)).toBeUndefined()
})

test('a kept attempt handoff uses the live outcome but not revised instructions', () => {
  const initial = createWorkflowRun(createBlankWorkflow())
  const state = advanceWorkflowRun(initial, {
    action: 'revise',
    expectedVersion: 0,
    attemptId: 1,
    active: 'keep',
    reason: 'Accurate verdict',
    operations: [
      {
        op: 'put-step',
        step: {
          ...initial.definition.steps[0]!,
          instructions: 'Future instructions',
          outcomes: { waived: { next: 'finish' } },
        },
      },
    ],
  })
  const message = flowMessage(
    { id: 'stream', title: 'Kept work', description: '', metadata: {} },
    { state, version: state.version },
    state.attempts[0]!
  )
  expect(message).toContain(initial.attempts[0]!.step!.instructions)
  expect(message).not.toContain('Future instructions')
  expect(message).toContain('"outcome": "waived"')
})
