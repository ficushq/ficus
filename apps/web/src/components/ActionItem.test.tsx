import { describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../test/domHarness'
import type { PendingAction } from '@ficus/shared'
import { ActionItem } from './ActionItem'
import { ActionCenterContent } from './ActionCenterContent'
import { queryKeys } from '../queryKeys'

const action = {
  id: 'workstream-review:ws-1:wait-full-1',
  type: 'workstream-review',
  priority: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  canRespond: true,
  squadId: 'squad-1',
  squadName: 'Ficus',
  data: {
    workStreamId: 'ws-1',
    workStreamTitle: 'Ship it',
    squadId: 'squad-1',
    squadName: 'Ficus',
    waitId: 'legacy-wait-id',
    assigneeAgentId: null,
    assigneeName: null,
    completionMode: 'pr-merge',
    prompt: { type: 'text', message: 'Review this' },
    wait: {
      id: 'wait-full-1',
      workStreamId: 'ws-1',
      type: 'review',
      referenceId: null,
      message: 'Review this',
      createdBy: 'agent',
      createdByAgentId: null,
      createdByUserId: null,
      completesOnApproval: false,
      openedAt: '2026-01-01T00:00:00.000Z',
      closedAt: null,
      resolution: null,
      resolutionNote: null,
    },
    focus: { kind: 'workstream-wait', workStreamId: 'ws-1', waitId: 'wait-full-1' },
  },
} as PendingAction

describe('ActionItem work-stream approval', () => {
  test('opens a lone review without a redundant category heading and allows collapse', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionCenterContent actions={[action]} isLoading={false} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      expect(document.body.textContent).toContain('Review this')
      expect(document.body.textContent).not.toContain('Work stream reviews')
      const collapse = document.querySelector('button[aria-label="Collapse"]') as HTMLButtonElement
      expect(collapse.getAttribute('aria-expanded')).toBe('true')
      await dom.act(async () => collapse.click())
      expect(document.body.textContent).not.toContain('Review this')
      expect(document.querySelector('button[aria-label="Expand"]')).not.toBeNull()
    } finally {
      await dom.cleanup()
    }
  })

  test('renders returned actions read-only when canRespond is false', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionItem action={{ ...action, canRespond: false }} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      const header = dom.window.document.querySelector('div.cursor-pointer')
      await dom.act(async () => header?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
      expect(dom.window.document.body.textContent).toContain('do not have permission to respond')
      expect(
        [...dom.window.document.querySelectorAll('button')].some(
          (button) => button.textContent === 'Approve checkpoint'
        )
      ).toBe(false)
    } finally {
      await dom.cleanup()
    }
  })

  test('requires explicit confirmation and submits exactly once', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const originalFetch = globalThis.fetch
    const fetchCalls: Array<{ url: string; body?: string }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), body: init?.body as string | undefined })
      return new dom.window.Response('{}', { status: 200 }) as unknown as Response
    }) as unknown as typeof fetch
    try {
      const queryClient = new QueryClient()
      const invalidated: unknown[][] = []
      queryClient.invalidateQueries = mock(async ({ queryKey }: { queryKey?: readonly unknown[] }) => {
        if (queryKey) invalidated.push([...queryKey])
      }) as typeof queryClient.invalidateQueries
      const siblingAction = { ...action, id: 'workstream-review:ws-1:sibling' }
      queryClient.setQueryData(queryKeys.actions.pending(), [action, siblingAction])
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>
              <ActionItem action={action} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      const header = dom.window.document.querySelector('div.cursor-pointer')
      expect(header).not.toBeNull()
      await dom.act(async () => header?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
      const approve = [...dom.window.document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Approve checkpoint'
      )
      expect(approve).toBeDefined()
      await dom.act(async () => approve?.click())
      expect(
        fetchCalls.filter((call) => call.url.includes('/workstreams/ws-1/waits/wait-full-1/resolve'))
      ).toHaveLength(0)

      const dialog = dom.window.document.querySelector('[role="dialog"][aria-label="Approve checkpoint?"]')
      expect(dialog?.textContent).toContain('work stream continues')
      const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === 'Approve checkpoint'
      )
      await dom.act(async () => {
        confirm?.click()
        confirm?.click()
      })
      const resolveCalls = fetchCalls.filter((call) => call.url.includes('/workstreams/ws-1/waits/wait-full-1/resolve'))
      expect(resolveCalls).toHaveLength(1)
      expect(JSON.parse(resolveCalls[0]!.body!)).toEqual({ resolution: 'approved' })
      expect(queryClient.getQueryData<PendingAction[]>(queryKeys.actions.pending())).toEqual([siblingAction])
      expect(invalidated).toContainEqual([...queryKeys.actions.pending()])
      expect(invalidated).toContainEqual([...queryKeys.squads.workStreamDetail('ws-1')])
      expect(invalidated).toContainEqual([...queryKeys.squads.workStreams('squad-1')])
      expect(invalidated).toContainEqual([...queryKeys.squads.allWorkStreams()])
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })

  test('keeps a failed mutation visible and renders the server error', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(
      async () =>
        new dom.window.Response(JSON.stringify({ error: 'Review denied' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
    ) as unknown as typeof fetch
    try {
      const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      const siblingAction = { ...action, id: 'workstream-review:ws-1:sibling' }
      queryClient.setQueryData(queryKeys.actions.pending(), [action, siblingAction])
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>
              <ActionItem action={action} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      const header = dom.window.document.querySelector('div.cursor-pointer')
      await dom.act(async () => header?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
      const approve = [...dom.window.document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Approve checkpoint'
      )
      await dom.act(async () => approve?.click())
      const dialog = dom.window.document.querySelector('[role="dialog"][aria-label="Approve checkpoint?"]')
      const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === 'Approve checkpoint'
      )
      await dom.act(async () => {
        confirm?.click()
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      expect(dom.window.document.body.textContent).toContain('Review denied')
      expect(dom.window.document.body.textContent).toContain('Ship it')
      expect(queryClient.getQueryData(queryKeys.actions.pending())).toEqual([action, siblingAction])
      expect(dom.window.document.querySelector('[role="alert"]')).not.toBeNull()
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })
})

describe('ActionItem failed answer delivery', () => {
  test('retries the saved answer instead of offering a duplicate answer', async () => {
    const failedDeliveryAction = {
      id: 'agent-question:question-1',
      type: 'agent-question',
      priority: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      canRespond: true,
      data: {
        questionId: 'question-1',
        agentId: 'agent-1',
        agentName: 'Engineer',
        agentTypeId: 'engineer',
        squadId: 'squad-1',
        squadName: 'Ficus',
        ownerUserId: null,
        questionData: { questions: [{ id: 'q', type: 'text', question: 'Proceed?' }] },
        answerDelivery: {
          status: 'failed',
          generation: 1,
          attemptCount: 3,
          nextAttemptAt: null,
          lastError: 'Delivery unavailable',
          deliveredAt: null,
          canRetry: true,
        },
      },
    } satisfies PendingAction
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const originalFetch = globalThis.fetch
    const fetchCalls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input))
      return new dom.window.Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response
    }) as unknown as typeof fetch
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionItem action={failedDeliveryAction} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      await dom.act(async () =>
        dom.window.document
          .querySelector('div.cursor-pointer')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      )
      expect(dom.window.document.body.textContent).toContain('answer was saved')
      expect(dom.window.document.body.textContent).not.toContain('Confirm answer')
      const retry = [...dom.window.document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retry delivery'
      )
      expect(retry).toBeDefined()
      await dom.act(async () => retry?.click())
      expect(fetchCalls.some((url) => url.includes('/agent-questions/question-1/retry-delivery'))).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })
})

function manualAction(waitId: string, message: string): PendingAction {
  return {
    ...action,
    id: `workstream-blocked:ws-1:${waitId}`,
    type: 'workstream-blocked',
    priority: 3,
    data: {
      ...action.data,
      waitId: `legacy-${waitId}`,
      prompt: { type: 'text', message },
      wait: { ...action.data.wait, id: waitId, type: 'manual', message, completesOnApproval: false },
      focus: { kind: 'workstream-wait', workStreamId: 'ws-1', waitId },
    },
  } as PendingAction
}

function failedDeliveryAction(canRespond = true): PendingAction {
  return {
    id: 'agent-question:question-failed',
    type: 'agent-question',
    priority: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    canRespond,
    data: {
      questionId: 'question-failed',
      agentId: 'agent-1',
      agentName: 'Engineer',
      agentTypeId: 'engineer',
      squadId: 'squad-1',
      squadName: 'Ficus',
      ownerUserId: null,
      questionData: { questions: [{ id: 'q', type: 'text', question: 'Proceed?' }] },
      answerDelivery: {
        status: 'failed',
        generation: 1,
        attemptCount: 3,
        nextAttemptAt: null,
        lastError: 'Delivery unavailable',
        deliveredAt: null,
        canRetry: true,
      },
    },
  }
}

describe('ActionItem failed delivery acknowledgement', () => {
  test('offers dismiss without retry permission and acknowledges only the current generation', async () => {
    const item = failedDeliveryAction(false)
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body && JSON.parse(String(init.body)) })
      return new dom.window.Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) as Response
    }) as typeof fetch
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.actions.pending(), [item])
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>
              <ActionItem action={item} defaultExpanded />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      expect(document.body.textContent).toContain('confirmation')
      expect(document.body.textContent).not.toContain('delivery to the agent failed')
      expect(document.body.textContent).not.toContain('Retry delivery')
      const dismiss = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Dismiss notice')
      expect(dismiss).toBeDefined()
      await dom.act(async () => dismiss?.click())
      expect(calls).toContainEqual({
        url: expect.stringContaining('/agent-questions/question-failed/dismiss-delivery-failure'),
        body: { generation: 1 },
      })
      expect(calls.some((call) => call.url.includes('retry-delivery'))).toBe(false)
      expect(queryClient.getQueryData(queryKeys.actions.pending())).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })
})

describe('ActionItem exact mutation behavior', () => {
  test('sends back the exact review wait with its note', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; body?: string }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body as string | undefined })
      return new dom.window.Response('{}', { status: 200 }) as unknown as Response
    }) as unknown as typeof fetch
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionItem action={action} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      await dom.act(async () =>
        dom.window.document
          .querySelector('div.cursor-pointer')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      )
      const open = [...dom.window.document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Send checkpoint back'
      )
      await dom.act(async () => open?.click())
      const textarea = dom.window.document.querySelector('textarea') as HTMLTextAreaElement
      await dom.act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
          textarea,
          'Fix this'
        )
        textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      const send = [...dom.window.document.querySelectorAll('button')]
        .filter((button) => button.textContent === 'Send checkpoint back')
        .at(-1)
      await dom.act(async () => send?.click())
      const call = calls.find((candidate) => candidate.url.includes('/workstreams/ws-1/waits/wait-full-1/resolve'))
      expect(call).toBeDefined()
      expect(JSON.parse(call!.body!)).toEqual({ resolution: 'sent_back', note: 'Fix this' })
      expect(calls.some((candidate) => candidate.url.includes('legacy-wait-id'))).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })

  test('clears only the second concurrent manual wait', async () => {
    const actions = [manualAction('manual-full-1', 'Use option A'), manualAction('manual-full-2', 'Use option B')]
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; body?: string }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body as string | undefined })
      return new dom.window.Response('{}', { status: 200 }) as unknown as Response
    }) as unknown as typeof fetch
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <>
                {actions.map((item) => (
                  <ActionItem key={item.id} action={item} />
                ))}
              </>
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      const headers = dom.window.document.querySelectorAll('div.cursor-pointer')
      await dom.act(async () => headers[1]?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
      expect(dom.window.document.body.textContent).toContain('needs input')
      expect(dom.window.document.body.textContent).toContain('Use option B')
      const input = dom.window.document.querySelector('input[placeholder="Your response..."]') as HTMLInputElement
      await dom.act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Choose B')
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      const send = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Send')
      await dom.act(async () => send?.click())
      const call = calls.find((candidate) => candidate.url.includes('/waits/manual-full-2/resolve'))
      expect(call).toBeDefined()
      expect(JSON.parse(call!.body!)).toEqual({ resolution: 'cleared', note: 'Choose B' })
      expect(calls.some((candidate) => candidate.url.includes('manual-full-1'))).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })

  test('shows completing review copy and consequence', async () => {
    const completing = {
      ...action,
      data: { ...action.data, wait: { ...action.data.wait, completesOnApproval: true } },
    } as PendingAction
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionItem action={completing} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      await dom.act(async () =>
        dom.window.document
          .querySelector('div.cursor-pointer')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      )
      const approve = [...dom.window.document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Approve and complete'
      )
      expect(approve).toBeDefined()
      await dom.act(async () => approve?.click())
      const dialog = dom.window.document.querySelector(
        '[role="dialog"][aria-label="Approve and complete work stream?"]'
      )
      expect(dialog?.textContent).toContain('completes this work stream')
      expect(dialog?.textContent).not.toContain('work stream continues')
    } finally {
      await dom.cleanup()
    }
  })

  test('continues one exact visible halted action ID', async () => {
    const halted: PendingAction = {
      id: 'agent-error:visible-action',
      type: 'agent-error',
      priority: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      canRespond: true,
      data: {
        agentId: 'agent-1',
        agentName: 'Engineer',
        agentTypeId: 'engineer',
        squadId: 'squad-1',
        squadName: 'Ficus',
        ownerUserId: null,
        reason: 'Provider unavailable',
      },
    }
    const continueExact = mock(async () => ({ resumed: 1, resumedActionIds: [halted.id], staleActionIds: [] }))
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionItem action={halted} continueHaltedActions={continueExact} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      await dom.act(async () =>
        dom.window.document
          .querySelector('div.cursor-pointer')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      )
      const button = [...dom.window.document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === 'Continue'
      )
      await dom.act(async () => button?.click())
      expect(continueExact).toHaveBeenCalledWith(['agent-error:visible-action'])
    } finally {
      await dom.cleanup()
    }
  })

  test('retains a failed retry and hides retry when read-only', async () => {
    const retryAction = failedDeliveryAction()
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(
      async () =>
        new dom.window.Response(JSON.stringify({ error: 'Retry denied' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
    ) as unknown as typeof fetch
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    queryClient.setQueryData(queryKeys.actions.pending(), [retryAction])
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>
              <ActionItem action={retryAction} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      await dom.act(async () =>
        dom.window.document
          .querySelector('div.cursor-pointer')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      )
      const retry = [...dom.window.document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === 'Retry delivery'
      )
      await dom.act(async () => {
        retry?.click()
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('Retry denied')
      expect(queryClient.getQueryData(queryKeys.actions.pending())).toEqual([retryAction])
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>
              <ActionItem action={failedDeliveryAction(false)} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      await dom.act(async () =>
        dom.window.document
          .querySelector('div.cursor-pointer')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      )
      expect(
        [...dom.window.document.querySelectorAll('button')].some(
          (candidate) => candidate.textContent === 'Retry delivery'
        )
      ).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })

  test('sanitizes non-Error action failures and retains the cache', async () => {
    const halted: PendingAction = {
      id: 'agent-error:unsafe',
      type: 'agent-error',
      priority: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      canRespond: true,
      data: {
        agentId: 'agent-1',
        agentName: null,
        agentTypeId: 'engineer',
        squadId: null,
        squadName: null,
        ownerUserId: null,
        reason: 'Halted',
      },
    }
    const rejectUnsafe = mock(async () => Promise.reject({ secret: 'unsafe' }))
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    queryClient.setQueryData(queryKeys.actions.pending(), [halted])
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>
              <ActionItem action={halted} continueHaltedActions={rejectUnsafe} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      await dom.act(async () =>
        dom.window.document
          .querySelector('div.cursor-pointer')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      )
      const button = [...dom.window.document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === 'Continue'
      )
      await dom.act(async () => {
        button?.click()
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toBe('Action failed. Try again.')
      expect(dom.window.document.body.textContent).not.toContain('unsafe')
      expect(queryClient.getQueryData(queryKeys.actions.pending())).toEqual([halted])
    } finally {
      await dom.cleanup()
    }
  })
})

test('ActionItem keeps a review mutation pending until authoritative invalidations finish', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const rendered = dom.createRoot()
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async () => new dom.window.Response('{}', { status: 200 })) as unknown as typeof fetch
  const queryClient = new QueryClient()
  const finishInvalidations: Array<() => void> = []
  queryClient.invalidateQueries = mock(
    () => new Promise<void>((resolve) => finishInvalidations.push(resolve))
  ) as typeof queryClient.invalidateQueries
  try {
    await dom.act(async () =>
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <ActionItem action={action} />
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    await dom.act(async () =>
      dom.window.document
        .querySelector('div.cursor-pointer')
        ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    )
    const approve = [...dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Approve checkpoint'
    )
    await dom.act(async () => approve?.click())
    const dialog = dom.window.document.querySelector('[role="dialog"]')
    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Approve checkpoint'
    )
    await dom.act(async () => {
      confirm?.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(finishInvalidations.length).toBeGreaterThan(0)
    expect(
      [...dom.window.document.querySelectorAll('button')].some(
        (button) => button.textContent === 'Approving…' && button.disabled
      )
    ).toBe(true)
    await dom.act(async () => {
      finishInvalidations.splice(0).forEach((finish) => finish())
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(
      [...dom.window.document.querySelectorAll('button')].some((button) => button.textContent === 'Approve checkpoint')
    ).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
    finishInvalidations.forEach((finish) => finish())
    await dom.cleanup()
  }
})

test('a flow-owned wait opens its decision controls instead of exposing generic unblock', async () => {
  const flowAction = manualAction('flow-wait', 'Approve the design')
  ;(flowAction.data as import('@ficus/shared').WorkStreamActionData).wait.resolutionHandler = 'workflow'
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const rendered = dom.createRoot()
  const cache = new QueryClient()
  try {
    await dom.act(async () =>
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={cache}>
            <ActionItem action={flowAction} defaultExpanded embedded />
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    expect(dom.window.document.body.textContent).toContain('Review and decide')
    expect(dom.window.document.querySelector('input[placeholder="Your response..."]')).toBeNull()
  } finally {
    await dom.cleanup()
    cache.clear()
  }
})

describe('assistant task questions', () => {
  const conversationId = '507a9ac0-164e-4f49-9441-e57522bdc52b'
  const assistantAction = {
    id: 'assistant-needs-input:10000000-0000-4000-8000-000000000001',
    type: 'assistant-needs-input',
    priority: 1,
    createdAt: '2026-09-15T10:00:00.000Z',
    canRespond: true,
    data: {
      conversationId,
      conversationTitle: 'Hosting comparison',
      taskId: '10000000-0000-4000-8000-000000000001',
      taskLabel: 'Compare options',
      ownerUserId: 'owner',
      agentId: 'agent-1',
      squadId: null,
      squadName: null,
      question: 'Which region should the deployment use?',
      updateMessageId: 'm1',
      updateCreatedAt: '2026-09-15T10:00:00.000Z',
    },
  } as unknown as PendingAction

  test('renders with the other questions and answers inside the Assistant conversation', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/squads?tab=work' })
    const rendered = dom.createRoot()
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter initialEntries={['/squads?tab=work']}>
            <QueryClientProvider client={new QueryClient()}>
              <ActionCenterContent actions={[assistantAction]} isLoading={false} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      expect(document.body.textContent).toContain('Compare options')
      expect(document.body.textContent).toContain('needs your answer')
      expect(document.body.textContent).toContain('Which region should the deployment use?')
      // No inline answer form: the answer belongs in the conversation so it stays on the task.
      expect(document.querySelector('textarea, input[type="text"]')).toBeNull()
      const open = [...document.querySelectorAll('a')].find((link) => link.textContent === 'Answer in Assistant')!
      expect(open).toBeTruthy()
      const href = new URL(open.getAttribute('href')!, 'http://localhost')
      expect(href.pathname).toBe('/squads')
      expect(href.searchParams.get('tab')).toBe('work')
      expect(href.searchParams.get('chat')).toBe('open')
      expect(href.searchParams.get('assistantConversation')).toBe(conversationId)
      expect(href.searchParams.get('assistantTask')).toBe('10000000-0000-4000-8000-000000000001')
    } finally {
      await dom.cleanup()
    }
  })
})

describe('ActionItem code-host delivery gate', () => {
  const deliveryAction = {
    id: 'workstream-delivery:ws-2:review',
    type: 'workstream-delivery',
    priority: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    canRespond: false,
    squadId: 'squad-1',
    squadName: 'Ficus',
    data: {
      workStreamId: 'ws-2',
      workStreamNumber: 362,
      workStreamTitle: 'Use accurate Waiting label',
      squadId: 'squad-1',
      squadName: 'Ficus',
      deliveryKind: 'review',
      pullRequests: [
        { repository: 'ficushq/ficus-mobile', number: 42, url: 'https://github.com/ficushq/ficus-mobile/pull/42' },
      ],
      focus: { kind: 'workstream', workStreamId: 'ws-2' },
    },
  } as PendingAction

  test('lists a PR awaiting human review with a link to the pull request, not a permission notice', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionCenterContent actions={[deliveryAction, action]} isLoading={false} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      expect(document.body.textContent).toContain('Work stream reviews')
      expect(document.body.textContent).toContain('Use accurate Waiting label')
      expect(document.body.textContent).toContain('Ficus · Review pull request')
      const expand = [...document.querySelectorAll('button[aria-label="Expand"]')] as HTMLButtonElement[]
      await dom.act(async () => expand[0]!.click())
      expect(document.body.textContent).toContain('needs an approving human review')
      expect(document.body.textContent).not.toContain('do not have permission to respond')
      const link = document.querySelector('a[href="https://github.com/ficushq/ficus-mobile/pull/42"]')
      expect(link?.textContent).toBe('Review ficushq/ficus-mobile#42')
    } finally {
      await dom.cleanup()
    }
  })
})
