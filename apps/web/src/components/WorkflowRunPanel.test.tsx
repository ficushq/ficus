import { expect, spyOn, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createWorkflowRun, advanceWorkflowRun, workflowPresetSchema, type WorkStream } from '@ficus/shared'
import type { WorkflowRunDetail } from '@ficus/client-core'
import { acquireDomHarness } from '../test/domHarness'
import { client } from '../api/clientInstance'
import { modelTierQueryKeys, queryKeys } from '../queryKeys'
import { WorkflowRunPanel } from './WorkflowRunPanel'
import { WorkflowReviewCallout } from './WorkflowReviewCallout'
import { workStreamPullRequests } from '../lib/workStreamGithub'
import { WorkflowEditor } from './squads/WorkflowEditor'

const preset = workflowPresetSchema.parse(
  Bun.YAML.parse(await Bun.file(new URL('../../../../config/workflows/solo.yaml', import.meta.url)).text())
)
const stream = { id: 'style-stream', squadId: 'style-squad', status: 'active', agentIds: [] } as unknown as WorkStream
function run(human = false): WorkflowRunDetail {
  const definition = structuredClone(preset.definition)
  if (human)
    definition.steps[0] = {
      id: 'execute',
      kind: 'human-approval',
      approver: 'reviewers',
      instructions: 'Approve this draft',
      output: 'Decision',

      outcomes: { approved: { next: 'finish' } },
    }
  return { workStreamId: stream.id, source: {}, state: createWorkflowRun(definition), version: 0, attemptAgents: {} }
}
async function fixture(value: WorkflowRunDetail | null, permissions: string[] = []) {
  const dom = await acquireDomHarness({ url: 'http://localhost/workflows' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(modelTierQueryKeys.list(), [{ slug: 'deep', label: 'Deep' }])
  queryClient.setQueryData(queryKeys.squads.list(), [])
  queryClient.setQueryData(queryKeys.workflows.reviewers(stream.squadId), [])
  queryClient.setQueryData(queryKeys.workflows.run(stream.id), value)
  queryClient.setQueryData(queryKeys.workflows.list(), [
    { ...preset, revision: 'revision-1', disabled: false, hasTemplate: true },
  ])
  queryClient.setQueryData(queryKeys.agentTypes.list(), [])
  queryClient.setQueryData(queryKeys.auth.permissions(stream.squadId), {
    permissions,
    identity: { type: 'user', userId: 'reviewer' },
  })
  const root = dom.createRoot()
  return {
    dom,
    queryClient,
    root,
    render: async (node = <WorkflowRunPanel stream={stream} />) =>
      dom.act(async () =>
        root.root.render(
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
          </MemoryRouter>
        )
      ),
    cleanup: async () => {
      await dom.cleanup()
      queryClient.clear()
    },
  }
}
async function expandWorkflow(f: Awaited<ReturnType<typeof fixture>>) {
  await f.dom.act(async () => f.dom.window.document.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
}
/** Open the first gate's review surface from its compact callout card (deciding happens there). */
async function openReview(f: Awaited<ReturnType<typeof fixture>>) {
  const doc = f.dom.window.document
  if (doc.querySelector('[role="dialog"]')) return doc.querySelector<HTMLElement>('[role="dialog"]')!
  const button = [...doc.querySelectorAll<HTMLButtonElement>('section[aria-label^="Review "] button')].find((node) =>
    ['Review and decide', 'Read proposal'].includes(node.textContent ?? '')
  )!
  await f.dom.act(async () => button.click())
  return doc.querySelector<HTMLElement>('[role="dialog"]')!
}

test('legacy streams render no flow controls; queued flows label the current step without claiming it is working', async () => {
  const f = await fixture(null)
  try {
    await f.render()
    expect(f.dom.window.document.body.textContent).toBe('')
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), run())
    await f.render(<WorkflowRunPanel stream={{ ...stream, status: 'queued' }} />)
    await expandWorkflow(f)
    expect(f.dom.window.document.body.textContent).toContain('Queued')
    expect(f.dom.window.document.body.textContent).not.toContain('Complete delivery')
  } finally {
    await f.cleanup()
  }
})
test('human outcomes require evidence and send the displayed version and attempt; failures retain the draft', async () => {
  const f = await fixture(run(true), ['workstreams:review'])
  const advance = spyOn(client.workflows, 'advance').mockRejectedValue(new Error('The flow changed; reload'))
  try {
    await f.render(<WorkflowReviewCallout stream={stream} />)
    await openReview(f)
    const button = [...f.dom.window.document.querySelectorAll('button')].find((node) =>
      node.textContent?.startsWith('Approved')
    )!
    expect(button.textContent).toContain('Finishes the flow')
    expect(button.disabled).toBe(true)
    const input = f.dom.window.document.querySelector('textarea')!
    await f.dom.act(async () => {
      Object.getOwnPropertyDescriptor(f.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'Approved after checking scope'
      )
      input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
    })
    expect(button.disabled).toBe(false)
    await f.dom.act(async () => {
      button.click()
      await Promise.resolve()
    })
    await f.dom.act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(advance).toHaveBeenCalledTimes(1)
    expect(advance.mock.calls[0]!.slice(0, 2)).toEqual([
      stream.id,
      {
        action: 'complete',
        expectedVersion: 0,
        attemptId: 1,
        outcome: 'approved',
        evidence: 'Approved after checking scope',
        resume: false,
      },
    ])
    expect(input.value).toBe('Approved after checking scope')
    expect(f.dom.window.document.body.textContent).toContain('The flow changed; reload')
    // The draft outlives the surface: closing and reopening the review keeps the notes.
    await f.dom.act(async () =>
      f.dom.window.document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!.click()
    )
    expect(f.dom.window.document.querySelector('[role="dialog"][data-state="open"]')).toBeNull()
    await f.dom.act(async () => new Promise<void>((resolve) => setTimeout(resolve, 200)))
    await openReview(f)
    expect(f.dom.window.document.querySelector('textarea')!.value).toBe('Approved after checking scope')
  } finally {
    advance.mockRestore()
    await f.cleanup()
  }
})
test('read-only viewers can inspect human work without approval or revision controls', async () => {
  const f = await fixture(run(true))
  try {
    await f.render()
    await expandWorkflow(f)
    expect(f.dom.window.document.querySelector('textarea')).toBeNull()
    expect(f.dom.window.document.body.textContent).toContain('Human approval')
    expect(f.dom.window.document.body.textContent).not.toContain('Revise flow')
    await f.render(<WorkflowReviewCallout stream={stream} />)
    expect(f.dom.window.document.querySelector('textarea')).toBeNull()
    expect(f.dom.window.document.body.textContent).toContain('Approve this draft')
    expect(f.dom.window.document.body.textContent).toContain('You need review permission in this squad to decide.')
    // The review surface shows the document and the pending decision, never the controls.
    const dialog = await openReview(f)
    expect(dialog.querySelector('[data-review-document]')!.textContent).toContain('Approve this draft')
    expect(dialog.querySelector('textarea')).toBeNull()
    expect(dialog.textContent).toContain('Awaiting a decision')
    expect([...dialog.querySelectorAll('button')].some((node) => node.textContent?.startsWith('Approved'))).toBe(false)
  } finally {
    await f.cleanup()
  }
})
test('preset customization shows the effective participant tier instead of silently reverting to the catalog', async () => {
  const f = await fixture(null)
  try {
    await f.render(
      <WorkflowEditor
        value={{
          kind: 'preset',
          id: preset.id,
          revision: 'revision-1',
          customizations: [
            {
              op: 'put-participant',
              id: 'worker',
              participant: { ...preset.definition.participants.worker!, tier: 'deep' },
            },
          ],
        }}
        onChange={() => {}}
      />
    )
    const selects = [...f.dom.window.document.querySelectorAll('select')]
    expect(selects.some((select) => select.value === 'deep')).toBe(true)
  } finally {
    await f.cleanup()
  }
})

test('new work leaves the source unset so Core applies the configured squad default', async () => {
  const { CreateFlowWorkStream } = await import('./squads/CreateFlowWorkStream')
  const f = await fixture(null, ['workstreams:create'])
  const create = spyOn(client.workflows, 'createStream').mockResolvedValue(stream)
  try {
    await f.render(<CreateFlowWorkStream squadId={stream.squadId} />)
    await f.dom.act(async () => f.dom.window.document.querySelector('button')!.click())
    const input = f.dom.window.document.querySelector('input[required]')!
    const description = f.dom.window.document.querySelector('textarea[required]')!
    await f.dom.act(async () => {
      for (const [element, value, prototype] of [
        [input, 'Prepare report', f.dom.window.HTMLInputElement.prototype],
        [description, 'A verified report', f.dom.window.HTMLTextAreaElement.prototype],
      ] as const) {
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
        element.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
      }
    })
    expect(f.dom.window.document.querySelector('select')!.value).toBe('')
    await f.dom.act(async () => {
      f.dom.window.document
        .querySelector('form')!
        .dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(create).toHaveBeenCalledWith({
      squadId: stream.squadId,
      title: 'Prepare report',
      description: 'A verified report',
    })
  } finally {
    create.mockRestore()
    await f.cleanup()
  }
})

test('review permission exposes human decisions without requiring squad editing or wait-response access', async () => {
  const f = await fixture(run(true), ['squads:update', 'workstreams:respond'])
  try {
    await f.render(<WorkflowReviewCallout stream={stream} />)
    await openReview(f)
    expect(f.dom.window.document.querySelector('[aria-label="Decision and evidence"]') === null).toBe(true)
    await f.dom.act(async () => {
      f.queryClient.setQueryData(queryKeys.auth.permissions(stream.squadId), {
        permissions: ['workstreams:review'],
        identity: { type: 'user', userId: 'reviewer' },
      })
    })
    await f.render(<WorkflowReviewCallout stream={stream} />)
    expect(f.dom.window.document.querySelector('[aria-label="Decision and evidence"]') !== null).toBe(true)
  } finally {
    await f.cleanup()
  }
})

test('assigned reviewer filters restrict a nonempty list and allow reviewers when empty', async () => {
  const value = run(true)
  const step = value.state.definition.steps[0]!
  if (step.kind === 'human-approval') step.approver = 'assigned-reviewers'
  const active = value.state.attempts[0]?.step
  if (active?.kind === 'human-approval') active.approver = 'assigned-reviewers'
  const f = await fixture(value, ['workstreams:review'])
  try {
    await f.render()
    await expandWorkflow(f)
    expect(f.dom.window.document.body.textContent).toContain('anyone with review permission can decide.')
    await f.render(<WorkflowReviewCallout stream={stream} />)
    await openReview(f)
    expect(f.dom.window.document.querySelector('[aria-label="Decision and evidence"]') !== null).toBe(true)
    await f.render(<WorkflowReviewCallout stream={{ ...stream, assignedReviewerIds: ['someone-else'] }} />)
    expect(f.dom.window.document.querySelector('[aria-label="Decision and evidence"]') === null).toBe(true)
    expect(f.dom.window.document.body.textContent).toContain(
      'Only the reviewers assigned to this work stream can decide.'
    )
    await f.render(<WorkflowReviewCallout stream={{ ...stream, assignedReviewerIds: ['reviewer'] }} />)
    expect(f.dom.window.document.querySelector('[aria-label="Decision and evidence"]') !== null).toBe(true)
  } finally {
    await f.cleanup()
  }
})

test('step details and attempt history link to bound agents without guessing upcoming participants', async () => {
  const value = run()
  value.attemptAgents = { '1': 'builder-agent' }
  const f = await fixture(value)
  let opened = 0
  try {
    await f.render(<WorkflowRunPanel stream={stream} onOpenAgent={() => opened++} />)
    await expandWorkflow(f)
    const links = [
      ...f.dom.window.document.querySelectorAll<HTMLAnchorElement>('a[aria-label="Open execute attempt 1 agent chat"]'),
    ]
    expect(links.length).toBeGreaterThanOrEqual(2)
    expect(links.every((link) => link.getAttribute('href') === '/squads/style-squad/agents?agent=builder-agent')).toBe(
      true
    )
    await f.dom.act(async () => links[0]!.click())
    expect(opened).toBe(1)
    const noAgent = run()
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), noAgent)
    await f.render()
    expect(f.dom.window.document.querySelector('a[aria-label*="agent chat"]')).toBeNull()
  } finally {
    await f.cleanup()
  }
})

test('an action-center wait opens the matching parallel human attempt', async () => {
  const value = run(true)
  const second = {
    ...value.state.attempts[0]!,
    id: 2,
    stepId: 'second',
    step: { ...value.state.definition.steps[0]!, id: 'second', instructions: 'Decide the second branch' },
  }
  value.state.attempts.push(second)
  value.openWaits = [
    { id: 'focused', flowAttemptId: 2, resolutionHandler: 'workflow' } as import('@ficus/shared').WorkStreamWait,
  ]
  const f = await fixture(value, ['workstreams:review'])
  try {
    await f.render(<WorkflowRunPanel stream={stream} focusWaitId="focused" />)
    await expandWorkflow(f)
    expect(f.dom.window.document.querySelector('select')?.value).toBe('2')
    await f.render(<WorkflowReviewCallout stream={stream} focusWaitId="focused" />)
    const gates = [...f.dom.window.document.querySelectorAll('section')]
    expect(gates.map((gate) => gate.getAttribute('aria-label'))).toEqual(['Review second', 'Review execute'])
    expect(gates[0]!.textContent).toContain('Decide the second branch')
  } finally {
    await f.cleanup()
  }
})

// Human approval is an optional future branch, not the current agent attempt.
function reviewRun(humanGateCount: number): WorkflowRunDetail {
  const value = run()
  const definition = value.state.definition
  definition.participants.reviewer = { agentTypeId: 'reviewer', session: 'reuse-within-stream' }
  definition.steps[0]!.outcomes.completed = { next: 'agent-review' }
  definition.steps.push({
    id: 'agent-review',
    kind: 'agent',
    participant: 'reviewer',
    instructions: 'Review the result',
    output: 'Review findings',
    outcomes: {
      approved: { next: 'finish' },
      ...(humanGateCount ? { escalate: { next: 'human-1' } } : {}),
    },
  })
  for (let i = 1; i <= humanGateCount; i++) {
    definition.steps.push({
      id: `human-${i}`,
      kind: 'human-approval',
      approver: 'assigned-reviewers',
      instructions: 'Review the escalated result',
      output: 'Decision',
      outcomes: { approved: { next: i === humanGateCount ? 'finish' : `human-${i + 1}` } },
    })
  }
  return value
}

for (const agentReview of [false, true]) {
  for (const assignedReviewerIds of [[], ['stale-reviewer']]) {
    test(`omits the whole reviewer block and lookup without human gates (agent review: ${agentReview}, assigned: ${assignedReviewerIds.length})`, async () => {
      const f = await fixture(agentReview ? reviewRun(0) : run(), ['workstreams:update'])
      const lookup = spyOn(client.workflows, 'reviewers').mockResolvedValue([])
      const assign = spyOn(client.workflows, 'assignReviewers').mockResolvedValue(stream)
      f.queryClient.removeQueries({ queryKey: queryKeys.workflows.reviewers(stream.squadId) })
      try {
        await f.render(<WorkflowRunPanel stream={{ ...stream, assignedReviewerIds }} />)
        expect(f.dom.window.document.querySelector('[aria-label="Assigned reviewers"]') === null).toBe(true)
        expect(f.dom.window.document.querySelector('[aria-label="Assign reviewer"]') === null).toBe(true)
        expect(f.dom.window.document.body.textContent).not.toContain('No reviewers assigned')
        expect(lookup).not.toHaveBeenCalled()
        expect(assign).not.toHaveBeenCalled()
        expect(
          f.queryClient.getQueryCache().find({ queryKey: queryKeys.workflows.reviewers(stream.squadId) })
        ).toBeUndefined()
      } finally {
        lookup.mockRestore()
        assign.mockRestore()
        await f.cleanup()
      }
    })
  }
}

for (const humanGateCount of [1, 2]) {
  test(`retains reviewer assignment for ${humanGateCount} inactive conditional human gates`, async () => {
    const value = reviewRun(humanGateCount)
    expect(value.state.attempts.every((attempt) => attempt.step.kind === 'agent')).toBe(true)
    const f = await fixture(value, ['workstreams:update'])
    try {
      await f.render()
      await expandWorkflow(f)
      expect(f.dom.window.document.querySelector('[aria-label="Assigned reviewers"]')).not.toBeNull()
      expect(f.dom.window.document.querySelector('[aria-label="Assign reviewer"]')).not.toBeNull()
      expect(f.dom.window.document.body.textContent).toContain('No reviewers assigned')
    } finally {
      await f.cleanup()
    }
  })
}

test('reviewer visibility follows effective definition revisions without changing stored assignments', async () => {
  const value = run(true)
  const assignedReviewerIds = ['reviewer']
  const f = await fixture(value, ['workstreams:update'])
  const assign = spyOn(client.workflows, 'assignReviewers').mockResolvedValue(stream)
  const reviewers = () => f.dom.window.document.querySelector('[aria-label="Assigned reviewers"]')
  try {
    await f.render(<WorkflowRunPanel stream={{ ...stream, assignedReviewerIds }} />)
    await expandWorkflow(f)
    expect(reviewers()).not.toBeNull()
    // Retain the old human attempt snapshot; only the effective definition changes.
    for (const [definition, visible] of [
      [run().state.definition, false],
      [reviewRun(2).state.definition, true],
    ] as const) {
      await f.dom.act(async () => {
        f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), {
          ...value,
          state: { ...value.state, definition },
        })
        // Flush React Query's scheduled cache notification.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      })
      expect(reviewers() !== null).toBe(visible)
      expect(
        f.queryClient
          .getQueryCache()
          .find({ queryKey: queryKeys.workflows.reviewers(stream.squadId) })
          ?.getObserversCount()
      ).toBe(visible ? 1 : 0)
    }
    expect(assignedReviewerIds).toEqual(['reviewer'])
    expect(assign).not.toHaveBeenCalled()
  } finally {
    assign.mockRestore()
    await f.cleanup()
  }
})

async function type(f: Awaited<ReturnType<typeof fixture>>, input: HTMLTextAreaElement, value: string) {
  await f.dom.act(async () => {
    Object.getOwnPropertyDescriptor(f.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
  })
}
async function click(f: Awaited<ReturnType<typeof fixture>>, label: string) {
  const button = [...f.dom.window.document.querySelectorAll('button')].find((node) => node.textContent === label)!
  await f.dom.act(async () => {
    button.click()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
  return button
}

// A delivered solo flow waiting on human delivery approval.
function deliveryRun(): WorkflowRunDetail {
  const value = run()
  value.state.definition.completion.mode = 'review-approval'
  value.state.status = 'completion-ready'
  Object.assign(value.state.attempts[0]!, {
    status: 'completed',
    outcome: 'completed',
    evidence: 'Built the export; the full suite passes.',
  })
  value.attemptAgents = { '1': 'builder-agent' }
  return value
}
const deliveredStream = {
  ...stream,
  metadata: {
    codeHost: { integration: 'github', repository: 'ficushq/ficus', changeRequest: { number: 12 } },
  },
} as unknown as WorkStream

test('delivery approval sits in the review callout with the pull request, the delivered evidence, and both decisions', async () => {
  const f = await fixture(deliveryRun(), ['workstreams:respond'])
  const finish = spyOn(client.workflows, 'finish').mockResolvedValue(undefined as never)
  const advance = spyOn(client.workflows, 'advance').mockResolvedValue(undefined as never)
  try {
    await f.render(<WorkflowRunPanel stream={deliveredStream} />)
    expect(f.dom.window.document.body.textContent).not.toContain('Complete delivery')

    await f.render(<WorkflowReviewCallout stream={deliveredStream} />)
    const text = f.dom.window.document.body.textContent
    expect(text).toContain('Approve delivery')
    expect(text).toContain('Built the export; the full suite passes.')
    const pr = f.dom.window.document.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/ficushq/ficus/pull/12"]'
    )
    expect(pr?.textContent).toContain('Pull request #12')
    expect(f.dom.window.document.querySelector('a[aria-label="Open execute attempt 1 agent chat"]')).not.toBeNull()

    await click(f, 'Send back')
    const feedback = f.dom.window.document.querySelector<HTMLTextAreaElement>('[aria-label="Send-back feedback"]')!
    const submit = [...f.dom.window.document.querySelectorAll('button')].find(
      (node) => node.textContent === 'Send back'
    )!
    expect(submit.disabled).toBe(true)
    await type(f, feedback, 'Handle an empty export')
    await click(f, 'Send back')
    expect(advance.mock.calls[0]!.slice(0, 2)).toEqual([
      stream.id,
      { action: 'rework', expectedVersion: 0, attemptId: 1, feedback: 'Handle an empty export' },
    ])

    await click(f, 'Approve and complete')
    expect(finish).toHaveBeenCalledWith(stream.id, 0)
  } finally {
    finish.mockRestore()
    advance.mockRestore()
    await f.cleanup()
  }
})

test('delivery approval explains missing permission and is absent for other completion modes', async () => {
  const f = await fixture(deliveryRun())
  try {
    await f.render(<WorkflowReviewCallout stream={deliveredStream} />)
    expect(f.dom.window.document.body.textContent).toContain('You need permission to respond')
    expect(f.dom.window.document.querySelector('button')).toBeNull()
    const other = deliveryRun()
    other.state.definition.completion.mode = 'deliverable'
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), other)
    await f.render(<WorkflowReviewCallout stream={deliveredStream} />)
    expect(f.dom.window.document.body.textContent).toBe('')
  } finally {
    await f.cleanup()
  }
})

test('a human gate shows the handoff it reviews and labels each outcome with where it sends the work', async () => {
  const value = run()
  const definition = value.state.definition
  definition.steps[0]!.outcomes.completed = { next: 'sign-off' }
  const gate = {
    id: 'sign-off',
    name: 'Product sign-off',
    kind: 'human-approval' as const,
    approver: 'reviewers' as const,
    instructions: 'Check the copy before release',
    output: 'Decision',
    outcomes: { 'request-changes': { returnTo: 'execute' }, approve: { next: 'finish' } },
  }
  definition.steps.push(gate)
  Object.assign(value.state.attempts[0]!, { status: 'completed', outcome: 'completed', evidence: 'Draft copy ready' })
  value.state.attempts.push({ id: 2, stepId: 'sign-off', status: 'running', step: gate, sourceAttemptIds: [1] })
  const f = await fixture(value, ['workstreams:review'])
  try {
    await f.render(<WorkflowReviewCallout stream={stream} />)
    const section = f.dom.window.document.querySelector('section[aria-label="Review Product sign-off"]')!
    // The compact card names the gate, previews the brief and the proposal, and opens the review.
    expect(section.textContent).toContain('execute · Attempt 1 · Completed')
    expect(section.textContent).toContain('Check the copy before release')
    expect(section.textContent).toContain('Proposal · Draft copy ready')
    expect([...section.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Review and decide'])
    const dialog = await openReview(f)
    expect(dialog.querySelector('[data-review-document]')!.textContent).toContain('Draft copy ready')
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('[data-review-rail] button')].filter((button) =>
      button.querySelector('span')
    )
    // The forward outcome is the primary action, listed first, even when a rework outcome is declared first.
    expect(buttons.map((button) => button.textContent)).toEqual([
      'ApproveFinishes the flow',
      'Request changesSends back to execute',
    ])
    expect(buttons[0]!.className).toContain('ficus-button-primary')
    expect(buttons[1]!.className).not.toContain('ficus-button-primary')
    expect(buttons[1]!.className).toContain('ficus-button-danger')
  } finally {
    await f.cleanup()
  }
})

test('kept human gates show only the effective outcomes and retain their initial brief', async () => {
  const value = run(true)
  value.state = advanceWorkflowRun(value.state, {
    action: 'revise',
    expectedVersion: 0,
    attemptId: 1,
    active: 'keep',
    reason: 'New human verdict',
    operations: [
      {
        op: 'put-step',
        step: {
          ...value.state.definition.steps[0]!,
          instructions: 'Future brief',
          outcomes: { accepted: { next: 'finish' } },
        },
      },
    ],
  })
  value.version = value.state.version
  const f = await fixture(value, ['workstreams:review'])
  try {
    await f.render(<WorkflowReviewCallout stream={stream} />)
    await openReview(f)
    const text = f.dom.window.document.body.textContent!
    expect(text).toContain('Accepted')
    expect(text).not.toContain('Approved')
    expect(text).toContain('Approve this draft')
    expect(text).not.toContain('Future brief')
  } finally {
    await f.cleanup()
  }
})

test('workflow disclosure has keyboard focus and hides the whole secondary section', async () => {
  const value = run(true)
  value.state.definition.name = 'A very long workflow name '.repeat(8)
  const f = await fixture(value, ['workstreams:revise-flow'])
  try {
    await f.render()
    const doc = f.dom.window.document
    const toggle = doc.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(toggle.textContent).toBe(`Workflow · ${value.state.definition.name}`)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    toggle.focus()
    expect(doc.activeElement).toBe(toggle)
    expect(doc.querySelector('[aria-label="Workflow visual preview"]')).toBeNull()
    expect(doc.body.textContent).not.toContain('Revise flow')
    await f.dom.act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(doc.querySelector('[aria-label="Workflow visual preview"]')).not.toBeNull()
    expect(doc.querySelector('[aria-label="Assigned reviewers"]')).not.toBeNull()
    expect(doc.body.textContent).toContain('Revise flow')
    await f.dom.act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(doc.body.textContent).not.toContain('Revise flow')
  } finally {
    await f.cleanup()
  }
})

test('preview survives refreshes but resets on stream switches and reopening', async () => {
  const f = await fixture(run())
  const other = { ...stream, id: 'other-stream' }
  f.queryClient.setQueryData(queryKeys.workflows.run(other.id), run())
  const toggle = () => f.dom.window.document.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  try {
    await f.render()
    expect(toggle()).not.toBeNull()
    await f.dom.act(async () => toggle().click())
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), { ...run(), version: 1 })
    await f.render(<WorkflowRunPanel stream={{ ...stream }} />)
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    await f.render(<WorkflowRunPanel stream={other} />)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    await f.dom.act(async () => toggle().click())
    await f.render()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    await f.dom.act(async () => toggle().click())
    await f.render(<></>)
    await f.render()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  } finally {
    await f.cleanup()
  }
})

for (const name of ['Focused mobile picker visual follow-up', preset.definition.name, '', '   ', undefined]) {
  test(`disclosure visibly identifies the workflow with honest name handling: ${name}`, async () => {
    const value = run()
    value.state.definition.name = name as string
    value.attemptAgents = { '1': 'builder-agent' }
    const f = await fixture(value)
    let opened = 0
    try {
      await f.render(<WorkflowRunPanel stream={stream} onOpenAgent={() => opened++} />)
      const doc = f.dom.window.document
      const toggle = doc.querySelector<HTMLButtonElement>('button[aria-expanded]')!
      expect(toggle.textContent).toBe(name?.trim() ? `Workflow · ${name}` : 'Workflow')
      expect(toggle.getAttribute('aria-label')).toBe(name?.trim() ? `Workflow preview: ${name}` : 'Workflow preview')
      expect(toggle.querySelector('svg')).not.toBeNull()
      await f.dom.act(async () => toggle.click())
      const graph = doc.querySelector('[aria-label="Workflow visual preview"]')!
      expect(graph).not.toBeNull()
      const step = graph.querySelector<HTMLButtonElement>('button[aria-label="execute: Active"]')!
      expect(step).not.toBeNull()
      await f.dom.act(async () => step.click())
      const chat = graph.querySelector<HTMLAnchorElement>('a[aria-label="Open execute attempt 1 agent chat"]')!
      expect(chat).not.toBeNull()
      await f.dom.act(async () => chat.click())
      expect(opened).toBe(1)
    } finally {
      await f.cleanup()
    }
  })
}

test('initial workflow loading stays quiet and a failed load reports the workflow error', async () => {
  const f = await fixture(null)
  try {
    const query = f.queryClient.getQueryCache().find({ queryKey: queryKeys.workflows.run(stream.id) })!
    query.setState({ data: undefined, status: 'pending', fetchStatus: 'fetching' })
    await f.render()
    expect(f.dom.window.document.body.textContent).toBe('')
    query.setState({ status: 'error', error: new Error('Offline'), fetchStatus: 'idle' })
    await f.render()
    expect(f.dom.window.document.body.textContent).toBe('Could not load the workflow.')
    expect(f.dom.window.document.querySelector('button[aria-expanded]')).toBeNull()
  } finally {
    await f.cleanup()
  }
})

test('collapsed workflow is a compact summary; expansion groups secondary details without duplicating totals', async () => {
  const value = run()
  value.attemptAgents = { '1': 'builder-agent' }
  const usage = { tokens: 1234, cost: 0.25, executions: 1, measuredExecutions: 1 }
  value.usage = { total: usage, unattributed: usage, steps: { execute: usage }, attempts: { '1': usage } }
  const f = await fixture(value, ['workstreams:revise-flow', 'workflows:create'])
  try {
    await f.render()
    const doc = f.dom.window.document
    for (const text of ['Open chat', 'Handoff history', 'Revise flow', 'Unattributed usage', 'Save as', 'worker']) {
      expect(doc.body.textContent).not.toContain(text)
    }
    const toggle = doc.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    await f.dom.act(async () => toggle.click())
    expect(doc.querySelector('[aria-label="Workflow visual preview"]')).not.toBeNull()
    expect(doc.body.textContent).toContain('Steps')
    const details = [...doc.querySelectorAll('details')]
    for (const label of ['Step usage', 'Handoff history', 'Manage workflow']) {
      expect(details.find((node) => node.querySelector('summary')?.textContent === label)?.open).toBe(false)
    }
    expect(doc.body.textContent).toContain('Revise flow')
    expect(doc.body.textContent).toContain('Unattributed usage')
    // The enclosing detail owns overall totals; this panel owns step/attempt attribution only.
    expect(doc.querySelector('[aria-label="Workflow total usage"]')).toBeNull()
    await f.dom.act(async () => toggle.click())
    expect(doc.body.textContent).not.toContain('Open chat')
  } finally {
    await f.cleanup()
  }
})

for (const mode of ['deliverable', 'pr-merge', 'pr-auto-merge', 'direct-merge'] as const) {
  test(`delivery action stays in the leading attention callout with truthful copy: ${mode}`, async () => {
    const value = deliveryRun()
    value.state.definition.completion.mode = mode
    const f = await fixture(value, ['workstreams:respond'])
    const finish = spyOn(client.workflows, 'finish').mockRejectedValue(new Error('Required delivery is not merged'))
    try {
      await f.render(<WorkflowReviewCallout stream={stream} />)
      const label = mode === 'deliverable' ? 'Mark complete' : 'Check delivery'
      const button = [...f.dom.window.document.querySelectorAll('button')].find((node) => node.textContent === label)!
      expect(button).toBeDefined()
      expect(button.className).toContain('ficus-button-primary')
      expect(f.dom.window.document.body.textContent).not.toContain(mode)
      await click(f, label)
      expect(finish).toHaveBeenCalledWith(stream.id, value.version)
      expect(f.dom.window.document.querySelector('[role="alert"]')?.textContent).toContain(
        'Required delivery is not merged'
      )
      for (const next of [
        { ...stream, status: 'done' },
        { ...stream, status: 'canceled' },
        { ...stream, pause: { reason: 'Hold' } },
      ]) {
        await f.render(<WorkflowReviewCallout stream={next as WorkStream} />)
        expect(f.dom.window.document.body.textContent).toBe('')
      }
    } finally {
      finish.mockRestore()
      await f.cleanup()
    }
  })
}

test('terminal unassigned human workflows have no empty management section', async () => {
  const f = await fixture(run(true))
  try {
    await f.render(<WorkflowRunPanel stream={{ ...stream, status: 'done' }} />)
    await expandWorkflow(f)
    expect(f.dom.window.document.body.textContent).not.toContain('Manage workflow')
    expect(f.dom.window.document.body.textContent).toContain('Handoff history')
  } finally {
    await f.cleanup()
  }
})

test('PR completion modes ask for the pull request review; checking delivery stays a quiet fallback', async () => {
  const value = deliveryRun()
  value.state.definition.completion.mode = 'pr-merge'
  const f = await fixture(value, ['workstreams:respond'])
  const finish = spyOn(client.workflows, 'finish').mockResolvedValue(undefined as never)
  try {
    await f.render(<WorkflowReviewCallout stream={deliveredStream} />)
    const card = f.dom.window.document.querySelector('section[aria-label="Review pull request"]')!
    expect(card.querySelector('h3')!.textContent).toBe('Review pull request')
    expect(card.textContent).toContain('ficushq/ficus#12')
    expect(card.textContent).toContain('When the PR merges, the squad completes this work stream automatically.')
    const open = [...card.querySelectorAll('a')].find((link) => link.textContent === 'Open pull request')!
    expect(open.getAttribute('href')).toBe('https://github.com/ficushq/ficus/pull/12')
    expect(open.className).toContain('ficus-button-primary')
    // Not known merged: no Check delivery here (it is in the More actions menu).
    expect([...card.querySelectorAll('button')].map((button) => button.textContent)).toEqual([])

    const [pullRequest] = workStreamPullRequests(deliveredStream.metadata)
    const merged = {
      ...deliveredStream,
      metadata: {
        ...deliveredStream.metadata,
        delivery: { pullRequests: { [pullRequest!.key]: { state: 'merged', at: '2026-10-08T10:00:00.000Z' } } },
      },
    } as unknown as WorkStream
    await f.render(<WorkflowReviewCallout stream={merged} />)
    const mergedCard = f.dom.window.document.querySelector('section[aria-label="Review pull request"]')!
    expect(mergedCard.textContent).toContain('Merged')
    const check = [...mergedCard.querySelectorAll('button')].find((button) => button.textContent === 'Check delivery')!
    expect(check.className).toContain('ficus-button-secondary')
    await click(f, 'Check delivery')
    expect(finish).toHaveBeenCalledWith(stream.id, value.version)
  } finally {
    finish.mockRestore()
    await f.cleanup()
  }
})
