import { expect, test } from 'bun:test'
import {
  createBlankWorkflow,
  createWorkflowRun,
  advanceWorkflowRun,
  workflowCommandSchema,
  workflowStepSchema,
} from '@ficus/shared'
import { brief } from '@ficus/shared/test-fixtures/workflow-review'
import { flowMessage } from './handoff-prompt'
import { deliveryInstructionsForRun } from './completion-prompt'
import { stackedDependencyNotice, type StackedDependency } from '../work-streams/dependency-edges'

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
  // Deliverables travel as attachments reviewers can read; evidence stays a summary.
  expect(prompt).toContain(
    'Attach the documents your result refers to (design docs, reports, plans, screenshots) by adding --attach <path> to the advance command, once per file'
  )
  expect(prompt).toContain(
    'Keep evidence a concise summary that names each attached file; do not paste their contents.'
  )
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

test('a stacked stream is told what it was built on and that delivery is held, in the handoff and at delivery', () => {
  const dependency: StackedDependency = {
    id: 'dep-1',
    label: '#12 · Shared parser',
    status: 'active',
    mode: 'stacked',
    branch: 'work/parser',
    headSha: 'a'.repeat(40),
  }
  const git = { remote: 'origin', baseBranch: 'main' }
  const notice = stackedDependencyNotice([dependency], git)!
  expect(notice).toContain(
    `"#12 · Shared parser": this stream's branch was built on its branch work/parser at ${'a'.repeat(40)}`
  )
  expect(notice).toContain('cannot finish, and its pull request must not merge, until that dependency has merged')
  expect(notice).toContain('Opening the pull request as a draft is fine. Do not enable auto-merge until then')
  expect(notice).toContain('merge main into this branch first')

  const state = createWorkflowRun(createBlankWorkflow())
  expect(flowMessage(stream, { state, version: 1 }, state.attempts[0]!, notice)).toContain(notice)
  expect(flowMessage(stream, { state, version: 1 }, state.attempts[0]!)).not.toContain('Stacked dependencies')
  const ready = { ...state, status: 'completion-ready' as const }
  const delivery = deliveryInstructionsForRun({ ...stream, status: 'active' }, ready, 1, notice)!
  expect(delivery).toContain(notice)
  expect(delivery).toContain('ficus workstream finish stream-1 --version 1')
  expect(deliveryInstructionsForRun({ ...stream, status: 'active' }, ready, 1)).not.toContain('Stacked dependencies')

  // A manual merge names the command; a merged dependency releases the hold; a canceled one is called out.
  const manual = stackedDependencyNotice(
    [{ ...dependency, mode: 'manual', reason: 'the branch already has commits' }],
    git
  )!
  expect(manual).toContain("was NOT merged into this stream's branch automatically (the branch already has commits)")
  expect(manual).toContain('git fetch origin work/parser && git merge FETCH_HEAD')
  const merged = stackedDependencyNotice([{ ...dependency, status: 'done' }], git)!
  expect(merged).toContain('It has merged: merge main into this branch before delivery.')
  expect(merged).not.toContain('Delivery hold')
  expect(stackedDependencyNotice([{ ...dependency, status: 'canceled' }], git)).toContain(
    'was canceled and will never merge'
  )
  expect(stackedDependencyNotice([], git)).toBeUndefined()
})

function gatedRun() {
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes = { completed: { next: 'approval' } }
  definition.steps.push(
    workflowStepSchema.parse({
      id: 'approval',
      kind: 'human-approval',
      instructions: 'Approve the design.',
      output: 'Decision.',
      outcomes: { approved: { next: 'build' }, 'changes-requested': { returnTo: 'execute' } },
    }),
    workflowStepSchema.parse({ ...definition.steps[0], id: 'build', outcomes: { completed: { next: 'finish' } } })
  )
  let state = createWorkflowRun(definition)
  state = advanceWorkflowRun(state, {
    action: 'complete',
    expectedVersion: 0,
    attemptId: 1,
    outcome: 'completed',
    evidence: 'Design evidence.',
    decisionBrief: brief,
  })
  return advanceWorkflowRun(state, {
    action: 'amend',
    expectedVersion: 1,
    attemptId: 1,
    evidence: 'Revised design evidence, commit def5678.',
    decisionBrief: { ...brief, risks: 'A clearer risk statement for the reviewer.' },
  })
}

test('the next step is told which revision a person approved, with or without notes', () => {
  for (const [notes, line] of [
    ['Keep the fallback.', 'approval (attempt 2): Approved revision 2 of execute attempt 1. Notes: Keep the fallback.'],
    ['', 'approval (attempt 2): Approved revision 2 of execute attempt 1. No decision notes.'],
  ] as const) {
    const before = gatedRun()
    const state = advanceWorkflowRun(before, {
      action: 'complete',
      expectedVersion: before.version,
      attemptId: 2,
      outcome: 'approved',
      evidence: notes,
      reviewedRevisions: [{ attemptId: 1, revision: 2 }],
    })
    expect(flowMessage(stream, { state, version: state.version }, state.attempts[2]!)).toContain(line)
  }
})

test('a returned step is told which revision changes were requested on', () => {
  const before = gatedRun()
  const state = advanceWorkflowRun(before, {
    action: 'complete',
    expectedVersion: before.version,
    attemptId: 2,
    outcome: 'changes-requested',
    evidence: 'Use the other cache.',
  })
  expect(flowMessage(stream, { state, version: state.version }, state.attempts[2]!)).toContain(
    'approval (attempt 2): Changes requested on revision 2 of execute attempt 1. Notes: Use the other cache.'
  )
  // When the reworked attempt carries the notes as its rework request, they are shown once, under the
  // request, and the decision line still names the revision.
  state.attempts[2]!.feedback = 'Use the other cache.'
  const prompt = flowMessage(stream, { state, version: state.version }, state.attempts[2]!)
  expect(prompt).toContain(
    'approval (attempt 2): Changes requested on revision 2 of execute attempt 1. The notes are the rework request above.'
  )
  expect(prompt).toContain('Rework request:\nUse the other cache.')
  expect(prompt.split('Use the other cache.')).toHaveLength(2)
})

test('an agent that already has the unchanged brief gets the step without it, and rework feedback appears once', () => {
  const state = createWorkflowRun(createBlankWorkflow())
  const withHandoff = { ...stream, handoffMessage: 'Owner handoff text' }
  const full = flowMessage(withHandoff, { state, version: 3 }, state.attempts[0]!)
  const repeat = flowMessage(withHandoff, { state, version: 3 }, state.attempts[0]!, undefined, undefined, 1)
  for (const restated of [stream.description, 'Owner handoff text', 'Attach the documents your result refers to'])
    expect(full).toContain(restated)
  for (const restated of [stream.description, 'Owner handoff text', 'Attach the documents your result refers to'])
    expect(repeat).not.toContain(restated)
  expect(repeat).toContain("You already have this work stream's brief from your attempt 1 assignment in this session")
  expect(repeat).toContain('ficus workstream get stream-1')
  expect(repeat).toContain("ficus workstream advance stream-1 --stdin <<'FICUS_COMMAND'")
  expect(repeat.length).toBeLessThan(full.length)

  // A send-back records the same text as the gate's feedback and the reworked attempt's request.
  state.attempts.push(
    { id: 2, stepId: 'review', status: 'returned', feedback: 'Support multi-hop routes.', sourceAttemptIds: [1] },
    {
      id: 3,
      stepId: state.attempts[0]!.stepId,
      status: 'running',
      feedback: 'Support multi-hop routes.',
      sourceAttemptIds: [2],
    }
  )
  const rework = flowMessage(stream, { state, version: 4 }, state.attempts[2]!)
  expect(rework.split('Support multi-hop routes.')).toHaveLength(2)
  expect(rework).toContain('Rework request:\nSupport multi-hop routes.')
})
