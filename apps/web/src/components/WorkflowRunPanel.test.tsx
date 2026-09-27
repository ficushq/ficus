import { expect, spyOn, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createWorkflowRun, workflowPresetSchema, type WorkStream } from '@ficus/shared'
import type { WorkflowRunDetail } from '@ficus/client-core'
import { acquireDomHarness } from '../test/domHarness'
import { client } from '../api/clientInstance'
import { modelTierQueryKeys, queryKeys } from '../queryKeys'
import { WorkflowRunPanel } from './WorkflowRunPanel'
import { WorkflowReviewCallout } from './WorkflowReviewCallout'
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
test('legacy streams render no flow controls; queued flows label the current step without claiming it is working', async () => {
  const f = await fixture(null)
  try {
    await f.render()
    expect(f.dom.window.document.body.textContent).toBe('')
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), run())
    await f.render(<WorkflowRunPanel stream={{ ...stream, status: 'queued' }} />)
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
  } finally {
    advance.mockRestore()
    await f.cleanup()
  }
})
test('read-only viewers can inspect human work without approval or revision controls', async () => {
  const f = await fixture(run(true))
  try {
    await f.render()
    expect(f.dom.window.document.querySelector('textarea')).toBeNull()
    expect(f.dom.window.document.body.textContent).toContain('Human approval')
    expect(f.dom.window.document.body.textContent).not.toContain('Revise flow')
    await f.render(<WorkflowReviewCallout stream={stream} />)
    expect(f.dom.window.document.querySelector('textarea')).toBeNull()
    expect(f.dom.window.document.body.textContent).toContain('Approve this draft')
    expect(f.dom.window.document.body.textContent).toContain('You need review permission in this squad to decide.')
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
    expect(f.dom.window.document.body.textContent).toContain('anyone with review permission can decide.')
    await f.render(<WorkflowReviewCallout stream={stream} />)
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
    codeHost: { integration: 'github', repository: 'ficushq/tau', changeRequest: { number: 12 } },
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
      'a[href="https://github.com/ficushq/tau/pull/12"]'
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
    expect(section.textContent).toContain('Draft copy ready')
    const buttons = [...section.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Request changesSends back to execute',
      'ApproveFinishes the flow',
    ])
    // The forward outcome is the primary action even when a rework outcome is declared first.
    expect(buttons[1]!.className).toContain('ficus-button-primary')
    expect(buttons[0]!.className).not.toContain('ficus-button-primary')
  } finally {
    await f.cleanup()
  }
})
