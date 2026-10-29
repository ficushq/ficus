import { brief as workflowReviewBriefFixture } from '@ficus/shared/test-fixtures/workflow-review'
import { afterEach, describe, expect, it } from 'bun:test'
import { queryKeys, type ResolveWorkStreamWaitResult } from '@ficus/client-core'
import {
  createBlankWorkflow,
  createWorkflowRun,
  advanceWorkflowRun,
  workflowStepSchema,
  routeWorkflowDecision,
  type PendingAction,
  type WorkStream,
} from '@ficus/shared'
import type { WorkflowRunDetail } from '@ficus/client-core'
import { stream, wait, workflowRun } from './fixtures'
import { ReviewForm } from './ReviewForm'
import { UnblockForm } from './UnblockForm'
import { WorkflowDecision } from './WorkflowDecision'
import {
  button,
  byLabel,
  cleanup,
  click,
  fakeApi,
  hasButton,
  hasKey,
  render,
  testQueryClient,
  typeInto,
} from './testing'

afterEach(cleanup)

const resolved = () => Promise.resolve({} as ResolveWorkStreamWaitResult)

const streamKeys = [
  queryKeys.actions.pending(),
  queryKeys.squads.workStreamDetail('ws-1'),
  queryKeys.squads.workStreams('squad-1'),
  queryKeys.squads.allWorkStreams(),
  queryKeys.squads.activeWorkStreamsPrefix(),
  [...queryKeys.squads.all, 'doneWorkStreams'],
]

describe('ReviewForm', () => {
  it('harvests (approves) after confirming what approval does', async () => {
    const api = fakeApi({ resolveWorkStreamWait: resolved })
    const queryClient = testQueryClient()
    queryClient.setQueryData<PendingAction[]>(queryKeys.actions.pending(), [
      { id: 'workstream-review:ws-1:wait-1' } as PendingAction,
    ])
    const { container, invalidated } = await render(
      <ReviewForm workStreamId="ws-1" squadId="squad-1" wait={wait()} completionMode="pr-merge" canRespond />,
      api,
      queryClient
    )
    expect(button(container, 'Harvest').textContent).toContain('Approve and deliver')
    await click(button(container, 'Harvest'))
    expect(api.resolveWorkStreamWait).not.toHaveBeenCalled()
    expect(container.textContent).toContain('It does not merge the pull request')
    await click(button(container, 'Yes, harvest'))

    expect(api.resolveWorkStreamWait).toHaveBeenCalledWith('ws-1', 'wait-1', { resolution: 'approved' })
    expect(queryClient.getQueryData<PendingAction[]>(queryKeys.actions.pending())).toEqual([])
    for (const key of streamKeys) expect(hasKey(invalidated(), key)).toBe(true)
  })

  it('labels a checkpoint review as a checkpoint', async () => {
    const api = fakeApi()
    const { container } = await render(
      <ReviewForm
        workStreamId="ws-1"
        squadId="squad-1"
        wait={wait({ completesOnApproval: false })}
        completionMode="pr-merge"
        canRespond
      />,
      api
    )
    expect(button(container, 'Harvest').textContent).toContain('Approve this checkpoint')
    expect(button(container, 'Prune').textContent).toContain('Send this checkpoint back with a note')
    await click(button(container, 'Harvest'))
    expect(container.textContent).toContain('It does not complete the work stream.')
  })

  it('prunes (sends back) only once a note is written', async () => {
    const api = fakeApi({ resolveWorkStreamWait: resolved })
    const { container, invalidated } = await render(
      <ReviewForm workStreamId="ws-1" squadId="squad-1" wait={wait()} completionMode="pr-merge" canRespond />,
      api
    )
    await click(button(container, 'Prune'))
    const submit = button(container, 'Prune')
    expect(submit.disabled).toBe(true)
    await typeInto(byLabel(container, 'What needs to change'), '   ')
    expect(button(container, 'Prune').disabled).toBe(true)
    await typeInto(byLabel(container, 'What needs to change'), 'More sun, please')
    expect(button(container, 'Prune').disabled).toBe(false)
    await click(button(container, 'Prune'))
    expect(api.resolveWorkStreamWait).toHaveBeenCalledWith('ws-1', 'wait-1', {
      resolution: 'sent_back',
      note: 'More sun, please',
    })
    expect(hasKey(invalidated(), queryKeys.squads.workStreamDetail('ws-1'))).toBe(true)
  })

  it('announces a failed decision', async () => {
    const api = fakeApi({ resolveWorkStreamWait: () => Promise.reject(new Error('Wait already closed')) })
    const { container } = await render(
      <ReviewForm workStreamId="ws-1" squadId="squad-1" wait={wait()} completionMode="deliverable" canRespond />,
      api
    )
    await click(button(container, 'Harvest'))
    await click(button(container, 'Yes, harvest'))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Wait already closed')
  })

  it('checks squad permissions when no action capability is given', async () => {
    const api = fakeApi({
      getMyPermissions: () =>
        Promise.resolve({ permissions: ['squads:read'], identity: { type: 'user', userId: 'u' } }),
    })
    const { container } = await render(
      <ReviewForm workStreamId="ws-1" squadId="squad-1" wait={wait()} completionMode="pr-merge" />,
      api
    )
    expect(api.getMyPermissions).toHaveBeenCalledWith('squad-1')
    expect(hasButton(container, 'Harvest')).toBe(false)
    expect(container.textContent).toContain("don't have permission")
  })

  it('hands a workflow-owned wait to the workflow instead of resolving it', async () => {
    const api = fakeApi({
      workflowRun: () => Promise.resolve(workflowRun('delivery')),
      getWorkStream: () => Promise.resolve(stream()),
      finishWorkflow: () => Promise.resolve(stream()),
    })
    const { container } = await render(
      <ReviewForm
        workStreamId="ws-1"
        squadId="squad-1"
        wait={wait({ resolutionHandler: 'workflow' })}
        completionMode="review-approval"
        canRespond
      />,
      api
    )
    await click(button(container, 'Harvest'))
    expect(api.finishWorkflow).toHaveBeenCalledWith('ws-1', 7)
    expect(api.resolveWorkStreamWait).not.toHaveBeenCalled()
  })
})

describe('WorkflowDecision · delivery approval', () => {
  const setup = (extra: Parameters<typeof fakeApi>[0] = {}) =>
    fakeApi({
      workflowRun: () => Promise.resolve(workflowRun('delivery', { version: 12 })),
      getWorkStream: () => Promise.resolve(stream()),
      ...extra,
    })

  it('finishes delivery with the run version', async () => {
    const api = setup({ finishWorkflow: () => Promise.resolve(stream()) })
    const { container, invalidated } = await render(<WorkflowDecision workStreamId="ws-1" />, api)
    expect(button(container, 'Harvest').textContent).toContain('Approve and deliver')
    await click(button(container, 'Harvest'))
    expect(api.finishWorkflow).toHaveBeenCalledWith('ws-1', 12)
    for (const key of [
      queryKeys.workflows.all,
      queryKeys.squads.all,
      queryKeys.squads.workStreamDetail('ws-1'),
      queryKeys.actions.pending(),
    ]) {
      expect(hasKey(invalidated(), key)).toBe(true)
    }
  })

  it('sends the work back for rework with feedback (required)', async () => {
    const api = setup({
      advanceWorkflow: () => Promise.resolve({ version: 13, stateStatus: 'running' as const, activeAttemptId: 3 }),
    })
    const { container } = await render(<WorkflowDecision workStreamId="ws-1" />, api)
    await click(button(container, 'Prune'))
    expect(button(container, 'Prune').disabled).toBe(true)
    await typeInto(byLabel(container, 'What needs to change'), 'Needs more basil')
    await click(button(container, 'Prune'))
    expect(api.advanceWorkflow).toHaveBeenCalledWith(
      'ws-1',
      { action: 'rework', expectedVersion: 12, attemptId: 1, feedback: 'Needs more basil' },
      'request-1'
    )
    expect(api.finishWorkflow).not.toHaveBeenCalled()
  })

  it('requires respond/update permission and a user identity', async () => {
    const api = setup({
      getMyPermissions: () =>
        Promise.resolve({ permissions: ['squads:read'], identity: { type: 'user', userId: 'u' } }),
    })
    const { container } = await render(<WorkflowDecision workStreamId="ws-1" />, api)
    expect(hasButton(container, 'Harvest')).toBe(false)
    expect(container.textContent).toContain('You need permission to respond')
  })
})

describe('WorkflowDecision · human-approval gate', () => {
  const gateWait = wait({ id: 'gate-wait', type: 'manual', resolutionHandler: 'workflow', flowAttemptId: 2 })

  it('completes the gate with the chosen outcome and required notes', async () => {
    const api = fakeApi({
      workflowRun: () => Promise.resolve(workflowRun('gate', { openWaits: [gateWait] })),
      getWorkStream: () => Promise.resolve(stream({ openWaits: [gateWait] })),
      advanceWorkflow: () => Promise.resolve({ version: 8, stateStatus: 'running' as const, activeAttemptId: null }),
    })
    const { container } = await render(<WorkflowDecision workStreamId="ws-1" focusWaitId="gate-wait" />, api)
    expect(container.textContent).toContain('Taste the tomatoes')
    expect(container.textContent).toContain('Planted and watered')
    expect(button(container, 'Approved').textContent).toContain('Finishes the flow')
    expect(button(container, 'Needs salt').textContent).toContain('Sends back to Build')
    expect(button(container, 'Approved').disabled).toBe(true)
    await typeInto(byLabel(container, 'Decision notes'), 'Tasted: perfect')
    await click(button(container, 'Approved'))
    expect(api.advanceWorkflow).toHaveBeenCalledWith(
      'ws-1',
      {
        action: 'complete',
        expectedVersion: 7,
        attemptId: 2,
        outcome: 'approved',
        evidence: 'Tasted: perfect',
        resume: false,
      },
      'request-1'
    )
  })

  it('waits for other open waits on the step first', async () => {
    const other = wait({ id: 'q', type: 'question', flowAttemptId: 2 })
    const api = fakeApi({
      workflowRun: () => Promise.resolve(workflowRun('gate', { openWaits: [gateWait, other] })),
      getWorkStream: () => Promise.resolve(stream()),
    })
    const { container } = await render(<WorkflowDecision workStreamId="ws-1" />, api)
    await typeInto(byLabel(container, 'Decision notes'), 'ok')
    expect(button(container, 'Approved').disabled).toBe(true)
    expect(container.textContent).toContain('Waiting for an answer:')
  })

  it('limits assigned-reviewer gates to the assigned reviewers', async () => {
    const run = workflowRun('gate')
    const steps = run.state.definition.steps as Array<{ approver?: string }>
    steps[1]!.approver = 'assigned-reviewers'
    const api = fakeApi({
      workflowRun: () => Promise.resolve(run),
      getWorkStream: () => Promise.resolve(stream({ assignedReviewerIds: ['someone-else'] } as Partial<WorkStream>)),
    })
    const { container } = await render(<WorkflowDecision workStreamId="ws-1" />, api)
    expect(hasButton(container, 'Approved')).toBe(false)
    expect(container.textContent).toContain('Only the reviewers assigned')
  })

  it('shows nothing for a paused stream, but explains when asked to', async () => {
    const api = fakeApi({
      workflowRun: () => Promise.resolve(workflowRun('gate')),
      getWorkStream: () =>
        Promise.resolve(stream({ pause: { id: 'p', pausedAt: '', reason: null, parkAt: null, agentIds: [] } })),
    })
    const quiet = await render(<WorkflowDecision workStreamId="ws-1" />, api)
    expect(quiet.container.textContent).toBe('')
    const explained = await render(<WorkflowDecision workStreamId="ws-1" explainWhenIdle />, api)
    expect(explained.container.textContent).toContain('This work is paused')
    expect(explained.container.querySelector('a')?.getAttribute('href')).toBe('/squads/squad-1/work?ws=ws-1')
  })
})

describe('UnblockForm', () => {
  const manual = wait({ type: 'manual', message: 'Which fertiliser?' })

  it('clears the weeds with a note (required)', async () => {
    const api = fakeApi({ resolveWorkStreamWait: resolved })
    const { container, invalidated } = await render(
      <UnblockForm workStreamId="ws-1" squadId="squad-1" wait={manual} canRespond />,
      api
    )
    expect(container.textContent).toContain('Which fertiliser?')
    expect(button(container, 'Clear the weeds').disabled).toBe(true)
    await typeInto(byLabel(container, 'Your note to the robot'), 'Use compost')
    await click(button(container, 'Clear the weeds'))
    expect(api.resolveWorkStreamWait).toHaveBeenCalledWith('ws-1', 'wait-1', {
      resolution: 'cleared',
      note: 'Use compost',
    })
    for (const key of streamKeys) expect(hasKey(invalidated(), key)).toBe(true)
  })

  it('offers select prompt options as one-tap answers', async () => {
    const api = fakeApi({ resolveWorkStreamWait: resolved })
    const { container } = await render(
      <UnblockForm
        workStreamId="ws-1"
        squadId="squad-1"
        wait={manual}
        prompt={{ type: 'select', message: 'Pick', options: ['Compost', 'Manure'] }}
        canRespond
      />,
      api
    )
    await click(button(container, 'Manure'))
    expect(api.resolveWorkStreamWait).toHaveBeenCalledWith('ws-1', 'wait-1', { resolution: 'cleared', note: 'Manure' })
  })

  it('skips the generic unblock for workflow-owned waits', async () => {
    const api = fakeApi({
      workflowRun: () =>
        Promise.resolve({ ...workflowRun('gate'), state: { ...workflowRun('gate').state, status: 'paused' } }),
      getWorkStream: () => Promise.resolve(stream()),
    })
    const { container } = await render(
      <UnblockForm
        workStreamId="ws-1"
        squadId="squad-1"
        wait={wait({ type: 'manual', resolutionHandler: 'workflow', message: 'Flow paused: limit' })}
        canRespond
      />,
      api
    )
    expect(hasButton(container, 'Clear the weeds')).toBe(false)
    expect(container.textContent).toContain('needs a flow revision')
    expect(api.resolveWorkStreamWait).not.toHaveBeenCalled()
  })
})

it('kept gates offer live outcomes instead of the original verdicts', async () => {
  const value = workflowRun('gate')
  const attempt = value.state.attempts.find((a) => a.id === value.state.activeAttemptId)!
  attempt.effectiveOutcomes = { version: 8, outcomes: { accepted: { next: 'finish' } } }
  value.version = 8
  const api = fakeApi({ workflowRun: () => Promise.resolve(value), getWorkStream: () => Promise.resolve(stream()) })
  const { container } = await render(<WorkflowDecision workStreamId="ws-1" />, api)
  expect(hasButton(container, 'Accepted')).toBe(true)
  expect(hasButton(container, 'Approved')).toBe(false)
  expect(container.textContent).toContain('Taste the tomatoes')
})

it('a second workflow-owned wait blocks the gate', async () => {
  const gate = wait({
    id: 'gate-wait',
    type: 'manual',
    resolutionHandler: 'workflow',
    flowAttemptId: 2,
    workflowHumanGate: true,
  })
  const other = wait({
    id: 'other',
    type: 'manual',
    resolutionHandler: 'workflow',
    flowAttemptId: 2,
    workflowHumanGate: false,
  })
  const api = fakeApi({
    workflowRun: () => Promise.resolve(workflowRun('gate', { openWaits: [gate, other] })),
    getWorkStream: () => Promise.resolve(stream()),
  })
  const { container } = await render(<WorkflowDecision workStreamId="ws-1" />, api)
  await typeInto(byLabel(container, 'Decision notes'), 'Ready for staging.')
  expect(button(container, 'Approved').disabled).toBe(true)
})

it('Farm leads with the authored brief, keeps attachment peer tabs and collapses only the handoff', async () => {
  const run = workflowRun('gate')
  run.state.attempts[0]!.decisionBrief = {
    value: {
      decision: 'Approve the staging design.',
      recommendation: 'Approve because fallback reads are tested.',
      approvalEffect: 'Approval permits staging work only, not production deployment.',
      risks: 'Maintenance work increases temporarily.',
      changesSinceLastReview: 'The prior review requested a smaller scope. The rollout is now excluded.',
    },
    submittedVersion: 6,
    contexts: [],
  }
  run.state.attempts[1]!.reviewBrief = { kind: 'authored', sourceAttemptIds: [1] }
  run.attachments = {
    '1': [
      {
        id: 'design',
        attemptId: 1,
        filename: 'design.md',
        path: 'docs/design.md',
        contentType: 'text/markdown',
        byteSize: 20,
        createdAt: '',
      },
    ],
  }
  const api = fakeApi({
    workflowRun: () => Promise.resolve(run),
    getWorkStream: () => Promise.resolve(stream()),
    downloadWorkflowAttachment: () => Promise.resolve(new TextEncoder().encode('The synthetic staging design.')),
  })
  const { container } = await render(<WorkflowDecision workStreamId="ws-1" />, api)
  const tabs = [...container.querySelectorAll('[role="tab"]')]
  expect(tabs.map((tab) => tab.textContent)).toEqual(['Decision brief', 'design.md'])
  expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
  expect(container.querySelector('[aria-label="Decision brief"]')!.textContent).toContain(
    'What changed since your last review'
  )
  const disclosure = container.querySelector('details')!
  expect(disclosure.open).toBe(false)
  expect(disclosure.querySelector('summary')!.textContent).toBe('Internal handoff')
  expect(disclosure.textContent).toContain('Planted and watered')
  expect(api.downloadWorkflowAttachment).not.toHaveBeenCalled()
  await click(tabs[1] as HTMLButtonElement)
  expect(api.downloadWorkflowAttachment).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[role="tabpanel"]')!.textContent).toContain('The synthetic staging design.')
  await click(tabs[0] as HTMLButtonElement)
  expect(container.querySelector('[aria-label="Decision brief"]')).not.toBeNull()
})

for (const kind of ['carried-forward', 'none'] as const) {
  it(`Farm labels ${kind} and retains the gate's own message`, async () => {
    const run = workflowRun('gate')
    run.state.attempts[0]!.decisionBrief = {
      value: {
        decision: 'Approve the staging design.',
        recommendation: 'Approve because fallback reads are tested.',
        approvalEffect: 'Approval permits staging only, not deployment.',
        risks: 'Maintenance work increases.',
      },
      submittedVersion: 1,
      contexts: [],
    }
    run.state.attempts[1]!.reviewBrief = kind === 'none' ? { kind } : { kind, sourceAttemptId: 1 }
    const api = fakeApi({ workflowRun: () => Promise.resolve(run), getWorkStream: () => Promise.resolve(stream()) })
    const { container } = await render(<WorkflowDecision workStreamId="ws-1" />, api)
    const panel = container.querySelector('[role="tabpanel"]')!
    expect(panel.textContent).toContain(
      kind === 'none' ? 'No decision brief for this gate' : 'Carried forward from an earlier step'
    )
    expect(panel.textContent).toContain('Taste the tomatoes')
  })
}

it('Farm queued reviews list every owner and manager blocker without advertising Your review', async () => {
  const gate = wait({ id: 'gate', type: 'manual', resolutionHandler: 'workflow', flowAttemptId: 2 })
  const waits = [
    gate,
    wait({ id: 'owner', type: 'manual', actor: 'owner', message: 'Wait for the approved sequencing window.' }),
    wait({ id: 'manager', type: 'manual', actor: 'manager', message: 'Confirm the staging dependency first.' }),
  ]
  const api = fakeApi({
    workflowRun: () => Promise.resolve(workflowRun('gate', { openWaits: waits })),
    getWorkStream: () => Promise.resolve(stream()),
  })
  const { container } = await render(<WorkflowDecision workStreamId="ws-1" />, api)
  expect(container.textContent).toContain('Review queued')
  expect(container.textContent).not.toContain('Your review')
  expect(container.querySelector('[aria-label="Review blockers"]')!.textContent).toContain('Waiting on owner:')
  expect(container.querySelector('[aria-label="Review blockers"]')!.textContent).toContain('Waiting on manager:')
  for (const wait of waits.slice(1)) expect(container.textContent).toContain(wait.message!)
  await typeInto(byLabel(container, 'Decision notes'), 'Checked the design.')
  expect(button(container, 'Approved').disabled).toBe(true)
})

function decisionPassThrough() {
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes.completed = { next: 'choice' }
  definition.steps.push(
    workflowStepSchema.parse({
      id: 'choice',
      kind: 'decision',
      instructions: 'Choose staging.',
      questions: { ready: { type: 'yesno', instructions: 'Is staging ready?' } },
      outcomes: { yes: { next: 'gate' } },
    }),
    workflowStepSchema.parse({
      id: 'gate',
      kind: 'human-approval',
      instructions: 'Review staging.',
      output: 'Decision.',
      outcomes: { yes: { next: 'finish' } },
    })
  )
  return definition
}
for (const legacy of [false, true]) {
  it(`Farm preserves independent transitive files without a brief (${legacy ? 'legacy' : 'explicit notice'})`, async () => {
    const definition = decisionPassThrough()
    let state = advanceWorkflowRun(createWorkflowRun(definition), {
      action: 'complete',
      expectedVersion: 0,
      attemptId: 1,
      outcome: 'completed',
      evidence: 'Review the attached staging design.',
    })
    state = advanceWorkflowRun(state, {
      action: 'complete',
      expectedVersion: state.version,
      attemptId: 2,
      outcome: 'yes',
      evidence: 'Choose human review.',
    })
    const attempt = state.attempts.at(-1)!
    if (legacy) attempt.reviewBrief = { kind: 'legacy' }
    const run: WorkflowRunDetail = {
      ...workflowRun('gate'),
      state,
      version: state.version,
      openWaits: [],
      attachments: {
        '1': [
          {
            id: 'transitive-design',
            attemptId: 1,
            filename: 'staging-design.md',
            path: 'docs/staging-design.md',
            contentType: 'text/markdown',
            byteSize: 24,
            createdAt: '',
          },
        ],
      },
    }
    const api = fakeApi({
      workflowRun: () => Promise.resolve(run),
      getWorkStream: () => Promise.resolve(stream()),
      downloadWorkflowAttachment: () => Promise.resolve(new TextEncoder().encode('The upstream staging design.')),
    })
    const { container } = await render(<WorkflowDecision workStreamId="ws-1" />, api)
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.map((tab) => tab.textContent)).toEqual([legacy ? 'Handoff' : 'Decision brief', 'staging-design.md'])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(container.textContent).toContain('Review the attached staging design.')
    if (!legacy)
      expect(container.querySelector('[aria-label="Decision brief"]')!.textContent).toContain(
        'No decision brief for this gate'
      )
    expect(api.downloadWorkflowAttachment).not.toHaveBeenCalled()
    await click(tabs[1]!)
    expect(api.downloadWorkflowAttachment.mock.calls[0]!.slice(0, 2)).toEqual(['ws-1', 'transitive-design'])
    expect(container.querySelector('[role="tabpanel"]')!.textContent).toContain('The upstream staging design.')
    await click(tabs[0]!)
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(api.downloadWorkflowAttachment).toHaveBeenCalledTimes(1)
  })
}

it('Farm restarted decision fallback shows only the new gate message and explicit missing-brief notice', async () => {
  const definition = decisionPassThrough()
  let state = advanceWorkflowRun(createWorkflowRun(definition), {
    action: 'complete',
    expectedVersion: 0,
    attemptId: 1,
    outcome: 'completed',
    evidence: 'Original internal handoff.',
    decisionBrief: workflowReviewBriefFixture,
  })
  state = advanceWorkflowRun(state, {
    action: 'revise',
    expectedVersion: state.version,
    attemptId: 2,
    active: 'restart',
    reason: 'Replace the staging choice session.',
    operations: [
      {
        op: 'put-step',
        step: { ...state.attempts[1]!.step!, instructions: 'Choose only the replacement staging scope.' },
      },
    ],
  })
  const attempt = state.attempts.at(-1)!
  const decisionStep = attempt.step
  if (decisionStep?.kind !== 'decision') throw new Error('Expected a decision fixture')
  attempt.decision = routeWorkflowDecision(decisionStep, { ok: false, reason: 'unavailable', errors: [] })
  const run = { ...workflowRun('gate'), state, version: state.version, openWaits: [] }
  const api = fakeApi({ workflowRun: () => Promise.resolve(run), getWorkStream: () => Promise.resolve(stream()) })
  const { container } = await render(<WorkflowDecision workStreamId="ws-1" />, api)
  expect(container.querySelector('[aria-label="Decision brief"]')!.textContent).toContain(
    'No decision brief for this gate'
  )
  const panel = container.querySelector('[role="tabpanel"]')!
  expect(panel.textContent).toContain('Choose only the replacement staging scope.')
  expect(panel.textContent).not.toContain(workflowReviewBriefFixture.decision)
  expect(panel.textContent).not.toContain('Carried forward from an earlier step')
})

for (const [name, instructions, summary] of [
  [
    'formatted instructions',
    '# Review **the architecture**. Keep authorization in the brief.',
    'Review the architecture.',
  ],
  ['a named fallback', '', 'Taste test'],
  [
    'long instructions',
    'Review ' + 'the staging scope '.repeat(20) + '.',
    'Review ' + 'the staging scope '.repeat(20) + '.',
  ],
] as const) {
  it(`Farm shows the web gate-summary subtitle for ${name}`, async () => {
    const run = workflowRun('gate')
    const gate = run.state.attempts[1]!
    gate.reviewBrief = { kind: 'none' }
    const step = run.state.definition.steps.find((s) => s.id === gate.stepId)!
    step.instructions = instructions
    const api = fakeApi({ workflowRun: () => Promise.resolve(run), getWorkStream: () => Promise.resolve(stream()) })
    const { container } = await render(<WorkflowDecision workStreamId="ws-1" />, api)
    const subtitle = container.querySelector('.g-decision-title + .g-action-note')!
    const sentence = summary.length <= 160 ? summary : summary.slice(0, 160).replace(/\s+\S*$/, '') + '…'
    expect(subtitle.textContent).toBe(`Human approval · ${sentence}`)
    expect(button(container, 'Approved').disabled).toBe(true)
    expect(api.advanceWorkflow).not.toHaveBeenCalled()
  })
}
