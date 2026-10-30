import { describe, expect, mock, test } from 'bun:test'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../test/domHarness'
import {
  createBlankWorkflow,
  createWorkflowRun,
  WORK_STREAM_STATUS_ROLE,
  type PendingAction,
  type WorkStreamActionData,
  type WorkStreamDeliveryActionData,
} from '@ficus/shared'
import { webStatus } from '../lib/statusPresentation'
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
      const input = dom.window.document.querySelector('textarea[placeholder="Your response..."]') as HTMLTextAreaElement
      await dom.act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Choose B')
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

  test('sends a multi-line work stream input response on Cmd/Ctrl+Enter, never on plain Enter', async () => {
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
              <ActionItem action={manualAction('manual-logs', 'Paste the deploy log')} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      await dom.act(async () =>
        dom.window.document
          .querySelector('div.cursor-pointer')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      )
      const textarea = dom.window.document.querySelector(
        'textarea[placeholder="Your response..."]'
      ) as HTMLTextAreaElement
      const log = 'step 1 ok\nstep 2 failed:\n  exit code 1'
      await dom.act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, log)
        textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      const press = (init: KeyboardEventInit) =>
        dom.act(async () => {
          textarea.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
          )
        })
      await press({})
      await press({ shiftKey: true })
      expect(calls.some((candidate) => candidate.url.includes('/resolve'))).toBe(false)
      await press({ ctrlKey: true })
      const call = calls.find((candidate) => candidate.url.includes('/waits/manual-logs/resolve'))
      expect(call).toBeDefined()
      expect(JSON.parse(call!.body!)).toEqual({ resolution: 'cleared', note: log })
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
    // The gate's one action sits on the header; the body keeps the gate message and offers no generic unblock.
    expect(dom.window.document.body.textContent).toContain('Approve the design')
    expect(dom.window.document.querySelector('textarea[placeholder="Your response..."]')).toBeNull()

    // Review and decide opens the gate's review surface directly, not the work stream detail.
    const definition = createBlankWorkflow()
    const gate = {
      id: 'design',
      name: 'Design approval',
      kind: 'human-approval' as const,
      approver: 'reviewers' as const,
      instructions: 'Approve the design',
      output: 'Decision',
      outcomes: { approved: { next: 'finish' } },
    }
    definition.steps = [gate]
    definition.entry = 'design'
    const state = createWorkflowRun(definition)
    cache.setQueryData(queryKeys.squads.workStreamDetail('ws-1'), {
      id: 'ws-1',
      squadId: 'squad-1',
      title: 'Ship it',
      status: 'active',
      agentIds: [],
    })
    cache.setQueryData(queryKeys.workflows.run('ws-1'), {
      workStreamId: 'ws-1',
      source: {},
      state,
      version: 0,
      attemptAgents: {},
      openWaits: [{ id: 'flow-wait', flowAttemptId: 1, resolutionHandler: 'workflow', openedAt: state.startedAt }],
    })
    cache.setQueryData(queryKeys.auth.permissions('squad-1'), {
      permissions: ['workstreams:review'],
      identity: { type: 'user', userId: 'reviewer' },
    })
    const open = dom.window.document.querySelector(
      'button[aria-label="Review and decide on Ship it"]'
    ) as HTMLButtonElement
    expect(open.textContent).toBe('Review')
    expect(open.className).toContain('ficus-button-primary')
    await dom.act(async () => open.click())
    const dialog = dom.window.document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Review Design approval')
    expect(dialog.querySelector('textarea[aria-label="Decision and evidence"]')).not.toBeNull()
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
      // One click from the collapsed header; the body repeats no button that duplicates the title.
      expect(document.body.textContent).not.toContain('Answer in Assistant')
      const open = document.querySelector('a[aria-label="Answer Compare options in Assistant"]')!
      expect(open.textContent).toBe('Answer')
      expect(open.closest('[tabindex="-1"]')?.children[0]?.contains(open)).toBe(true)
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

  const renderItems = async (dom: Awaited<ReturnType<typeof acquireDomHarness>>, node: ReactNode) => {
    const rendered = dom.createRoot()
    await dom.act(async () =>
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
        </MemoryRouter>
      )
    )
  }
  const withPullRequests = (pullRequests: WorkStreamDeliveryActionData['pullRequests']): PendingAction => ({
    ...deliveryAction,
    data: { ...(deliveryAction.data as WorkStreamDeliveryActionData), pullRequests },
  })

  test('opens a lone PR in one click from the collapsed card, with nothing redundant to expand', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      await renderItems(dom, <ActionCenterContent actions={[deliveryAction, action]} isLoading={false} />)
      expect(document.body.textContent).toContain('Work stream reviews')
      const card = [...document.querySelectorAll('[tabindex="-1"]')].find((candidate) =>
        candidate.textContent?.includes('Use accurate Waiting label')
      )!
      expect(card.textContent).toContain('Ficus · Review pull request')
      // The title keeps its two-line clamp beside the inline button (a display utility would undo line-clamp).
      const title = card.querySelector('h3, button') as HTMLButtonElement
      expect(title.textContent).toBe('Use accurate Waiting label')
      expect(title.classList.contains('line-clamp-2')).toBe(true)
      expect(title.classList.contains('block')).toBe(false)
      const link = card.querySelector('a[href="https://github.com/ficushq/ficus-mobile/pull/42"]')!
      expect(link.textContent).toBe('Review #42')
      expect(link.getAttribute('aria-label')).toBe('Review #42, pull request ficushq/ficus-mobile#42')
      expect(link.getAttribute('title')).toBe('Review ficushq/ficus-mobile#42')
      expect(link.getAttribute('target')).toBe('_blank')
      // No chevron, no toggling header, no body: the title opens the work stream, so View is gone too.
      expect(card.querySelector('button[aria-expanded]')).toBeNull()
      expect(card.querySelector('.cursor-pointer')).toBeNull()
      expect(card.children).toHaveLength(1)
      expect([...card.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
        'Use accurate Waiting label',
      ])
      await dom.act(async () => link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
      expect(card.children).toHaveLength(1)
      expect(document.body.textContent).not.toContain('needs an approving human review')
      expect(document.body.textContent).not.toContain('do not have permission to respond')
    } finally {
      await dom.cleanup()
    }
  })

  test('labels a merge gate Open, since the link opens the PR rather than merging it', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const merge = {
        ...deliveryAction,
        data: { ...(deliveryAction.data as WorkStreamDeliveryActionData), deliveryKind: 'merge' },
      } as PendingAction
      await renderItems(dom, <ActionItem action={merge} />)
      const link = document.querySelector('a[href^="https://github.com"]')!
      expect(link.textContent).toBe('Open #42')
      expect(link.getAttribute('aria-label')).toBe('Open #42, pull request ficushq/ficus-mobile#42')
      expect(link.getAttribute('title')).toBe('Open ficushq/ficus-mobile#42')
      expect(document.body.textContent).not.toContain('Merge #42')
      expect(document.body.textContent).toContain('Ficus · Merge pull request')
    } finally {
      await dom.cleanup()
    }
  })

  test('a merge gate with several PRs lists Open links with full references', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const merge = withPullRequests([
        { repository: 'ficushq/ficus', number: 7, url: 'https://github.com/ficushq/ficus/pull/7' },
        { repository: 'ficushq/ficus-mobile', number: 42, url: 'https://github.com/ficushq/ficus-mobile/pull/42' },
      ])
      ;(merge.data as WorkStreamDeliveryActionData).deliveryKind = 'merge'
      await renderItems(dom, <ActionItem action={merge} defaultExpanded />)
      expect([...document.querySelectorAll('a[href^="https://github.com"]')].map((link) => link.textContent)).toEqual([
        'Open ficushq/ficus#7',
        'Open ficushq/ficus-mobile#42',
      ])
    } finally {
      await dom.cleanup()
    }
  })

  test('keeps several PRs in an expandable list without a redundant View button', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      await renderItems(
        dom,
        <ActionItem
          action={withPullRequests([
            { repository: 'ficushq/ficus', number: 7, url: 'https://github.com/ficushq/ficus/pull/7' },
            { repository: 'ficushq/ficus-mobile', number: 42, url: 'https://github.com/ficushq/ficus-mobile/pull/42' },
          ])}
        />
      )
      expect(document.querySelectorAll('a[href^="https://github.com"]')).toHaveLength(0)
      const expand = document.querySelector('button[aria-label="Expand"]') as HTMLButtonElement
      await dom.act(async () => expand.click())
      expect([...document.querySelectorAll('a[href^="https://github.com"]')].map((link) => link.textContent)).toEqual([
        'Review ficushq/ficus#7',
        'Review ficushq/ficus-mobile#42',
      ])
      expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'View')).toBe(false)
      expect(document.body.textContent).not.toContain('needs an approving human review')
    } finally {
      await dom.cleanup()
    }
  })

  test('a gate without a linked PR is a plain card whose title opens the work stream', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      await renderItems(dom, <ActionItem action={withPullRequests([{ repository: 'ficushq/ficus', number: 7 }])} />)
      expect(document.querySelector('a')).toBeNull()
      expect(document.querySelector('button[aria-expanded]')).toBeNull()
      expect([...document.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
        'Use accurate Waiting label',
      ])
    } finally {
      await dom.cleanup()
    }
  })

  test('keeps the PR link reachable when embedded in the work stream modal', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      await renderItems(dom, <ActionItem action={deliveryAction} embedded />)
      expect(document.querySelector('h3')?.textContent).toBe('Use accurate Waiting label')
      expect(document.querySelector('a[href="https://github.com/ficushq/ficus-mobile/pull/42"]')?.textContent).toBe(
        'Review #42'
      )
      expect(document.querySelector('[tabindex="-1"]')?.children).toHaveLength(1)
    } finally {
      await dom.cleanup()
    }
  })
})

describe('ActionItem inline primary actions', () => {
  const halted: PendingAction = {
    id: 'agent-error:inline',
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

  test('continues a halted agent from the collapsed card without expanding it', async () => {
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
      const button = document.querySelector('button[aria-label="Continue Engineer"]') as HTMLButtonElement
      expect(button.textContent).toBe('Continue')
      await dom.act(async () => button.click())
      expect(continueExact).toHaveBeenCalledWith(['agent-error:inline'])
      expect(document.querySelector('button[aria-label="Expand"]')?.getAttribute('aria-expanded')).toBe('false')
      expect(document.body.textContent).not.toContain('Provider unavailable')
    } finally {
      await dom.cleanup()
    }
  })

  test('the expanded halted card explains the halt without repeating the title link', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionItem action={halted} defaultExpanded />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      expect(document.body.textContent).toContain('Provider unavailable')
      expect(document.querySelector('a')?.getAttribute('href')).toBe('/squads/squad-1?agent=agent-1')
      const labels = [...document.querySelectorAll('button')].map((button) => button.textContent)
      expect(labels).toEqual(['Continue', ''])
      expect(document.body.textContent).not.toContain('View agent')
    } finally {
      await dom.cleanup()
    }
  })

  test('shows no inline action on a card the viewer cannot respond to', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionItem action={{ ...halted, canRespond: false }} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Continue')).toBe(false)
    } finally {
      await dom.cleanup()
    }
  })

  test('cards that need input stay expandable and drop the View button that duplicates the title', async () => {
    for (const subject of [action, manualAction('manual-wait', 'Grant the token')]) {
      const dom = await acquireDomHarness({ url: 'http://localhost/' })
      const rendered = dom.createRoot()
      try {
        await dom.act(async () =>
          rendered.root.render(
            <MemoryRouter>
              <QueryClientProvider client={new QueryClient()}>
                <ActionItem action={subject} />
              </QueryClientProvider>
            </MemoryRouter>
          )
        )
        // Collapsed: only the title and the chevron; nothing inline to act on.
        expect([...document.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))).toEqual([
          null,
          'Expand',
        ])
        await dom.act(async () => (document.querySelector('button[aria-label="Expand"]') as HTMLButtonElement).click())
        const labels = [...document.querySelectorAll('button')].map((button) => button.textContent)
        expect(labels).not.toContain('View')
        if (subject === action) expect(labels).toContain('Send checkpoint back')
        else expect(document.querySelector('textarea[placeholder="Your response..."]')).not.toBeNull()
      } finally {
        await dom.cleanup()
      }
    }
  })
})

describe('ActionItem status icon', () => {
  const workflowWait = (flowAttemptId: number | null, extra: Partial<WorkStreamActionData> = {}): PendingAction => {
    const base = manualAction(flowAttemptId == null ? 'flow-stream-wait' : 'flow-gate-wait', 'Approve the design')
    const data = base.data as WorkStreamActionData
    return {
      ...base,
      data: { ...data, ...extra, wait: { ...data.wait, resolutionHandler: 'workflow', flowAttemptId } },
    } as PendingAction
  }
  const agentError = {
    id: 'agent-error:agent-1',
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
      reason: 'Provider rate limit',
    },
  } as PendingAction

  async function renderStatus(subject: PendingAction) {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionItem action={subject} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      const icon = document.querySelector('span[role="img"]')!
      return {
        icon: icon.textContent,
        label: icon.getAttribute('aria-label'),
        title: icon.getAttribute('title'),
        className: icon.className,
        text: document.body.textContent ?? '',
      }
    } finally {
      await dom.cleanup()
    }
  }

  test('a workflow human-review gate shows the review icon, color and label, not the blocked icon', async () => {
    const status = await renderStatus(workflowWait(1))
    expect(status.icon).toBe('◎')
    expect(status.label).toBe('In Review')
    expect(status.title).toBe('In Review')
    expect(status.className).toContain(webStatus('review').textClass)
    expect(status.text).toContain('Ficus · review needed')
  })

  test('the final delivery approval presents as Approve Delivery', async () => {
    const status = await renderStatus(workflowWait(null, { deliveryApproval: true }))
    expect(status.icon).toBe('◎')
    expect(status.label).toBe('Approve Delivery')
    expect(status.className).toContain(webStatus('review').textClass)
    expect(status.text).toContain('Ficus · approve delivery')
  })

  test('a manual wait a person must clear keeps the blocked icon in the work list blocked color', async () => {
    for (const blocked of [manualAction('manual-wait', 'Grant the token'), workflowWait(null)]) {
      const status = await renderStatus(blocked)
      expect(status.icon).toBe('⊘')
      expect(status.label).toBe('Blocked')
      expect(status.className).toContain(webStatus(WORK_STREAM_STATUS_ROLE.blocked).textClass)
    }
  })

  test('an error keeps the danger treatment and questions keep the waiting-on-you treatment', async () => {
    const error = await renderStatus(agentError)
    expect(error.icon).toBe('!')
    expect(error.label).toBe('Agent halted')
    expect(error.className).toContain(webStatus('danger').textClass)

    const question = await renderStatus(failedDeliveryAction())
    expect(question.icon).toBe('?')
    expect(question.label).toBe('Needs your answer')
    expect(question.className).toContain(webStatus('humanWait').textClass)
  })

  test('review gates are grouped with work stream reviews, not with work stream input', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const gate = { ...workflowWait(1), id: 'workstream-blocked:ws-1:gate' } as PendingAction
    const gateData = gate.data as WorkStreamActionData
    gate.data = { ...gateData, workStreamTitle: 'Design gate stream' }
    const manual = manualAction('manual-wait', 'Grant the token')
    manual.data = { ...(manual.data as WorkStreamActionData), workStreamTitle: 'Manual wait stream' }
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionCenterContent actions={[manual, gate]} isLoading={false} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      const text = document.body.textContent ?? ''
      const reviews = text.indexOf('Work stream reviews')
      const input = text.indexOf('Work stream input')
      expect(reviews).toBeGreaterThanOrEqual(0)
      expect(input).toBeGreaterThan(reviews)
      expect(text.indexOf('Design gate stream')).toBeGreaterThan(reviews)
      expect(text.indexOf('Design gate stream')).toBeLessThan(input)
      expect(text.indexOf('Manual wait stream')).toBeGreaterThan(input)
    } finally {
      await dom.cleanup()
    }
  })
})

describe('ActionItem expanded body spacing', () => {
  test('separates the expanded body from the header in Feed and embedded cards', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionItem action={action} defaultExpanded />
              <ActionItem action={action} embedded />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      const bodies = [...dom.window.document.querySelectorAll('[tabindex="-1"]')].map((card) => card.children[1])
      expect(bodies).toHaveLength(2)
      for (const body of bodies) expect(body?.classList.contains('pt-2')).toBe(true)
      // The body padding owns the gap, so a leading Markdown paragraph adds no extra margin on top.
      for (const markdown of dom.window.document.querySelectorAll('.prose'))
        expect(markdown.classList.contains('[&>:first-child]:mt-0')).toBe(true)
    } finally {
      await dom.cleanup()
    }
  })
})

describe('structured recovery decisions', () => {
  for (const decision of ['continue', 'stop'] as const) {
    test(`renders only the generated summary and sends exact versioned ${decision}`, async () => {
      const dom = await acquireDomHarness({ url: 'http://localhost/' })
      const rendered = dom.createRoot()
      const originalFetch = globalThis.fetch
      const calls: Array<{ url: string; body: unknown }> = []
      globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
        return new dom.window.Response('{}', { status: 200 }) as unknown as Response
      }) as unknown as typeof fetch
      const recovery = manualAction('recovery-wait', 'LEGACY_FREE_PROSE_MUST_NOT_RENDER')
      const data = recovery.data as WorkStreamActionData
      data.wait.structured = {
        request: {
          schemaVersion: 1,
          kind: 'continue',
          recoveryId: '00000000-0000-4000-8000-000000000001',
          expectedRecoveryVersion: 7,
        },
        summary: {
          attempted: 'Read project files',
          attemptCount: 6,
          lastError: 'Connection closed',
          text: 'I tried to read project files 6 times. The last error was: Connection closed',
        },
        version: 7,
      }
      try {
        await dom.act(async () =>
          rendered.root.render(
            <MemoryRouter>
              <QueryClientProvider client={new QueryClient()}>
                <ActionCenterContent actions={[recovery]} isLoading={false} />
              </QueryClientProvider>
            </MemoryRouter>
          )
        )
        expect(dom.window.document.body.textContent).toContain(data.wait.structured.summary.text)
        expect(dom.window.document.body.textContent).not.toContain('LEGACY_FREE_PROSE_MUST_NOT_RENDER')
        expect(dom.window.document.querySelector('textarea')).toBeNull()
        const buttons = [...dom.window.document.querySelectorAll('button')]
        expect(buttons.some((button) => button.textContent === 'Continue')).toBe(true)
        expect(buttons.some((button) => button.textContent === 'Stop')).toBe(true)
        await dom.act(async () => buttons.find((button) => button.textContent?.toLowerCase() === decision)!.click())
        expect(calls.find((call) => call.url.endsWith('/waits/recovery-wait/input'))?.body).toEqual({
          action: decision,
          expectedVersion: 7,
        })
        expect(calls.some((call) => call.url.endsWith('/resolve'))).toBe(false)
      } finally {
        globalThis.fetch = originalFetch
        await dom.cleanup()
      }
    })
  }
})

for (const decision of ['continue', 'stop'] as const) {
  test(`standalone recovery uses typed ${decision}, not generic agent Continue`, async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
      return new dom.window.Response('{}', { status: 200 }) as unknown as Response
    }) as unknown as typeof fetch
    const recovery: PendingAction = {
      id: 'agent-recovery:record',
      type: 'agent-error',
      priority: 1,
      createdAt: new Date().toISOString(),
      canRespond: true,
      data: {
        agentId: 'worker',
        agentTypeId: 'engineer',
        agentName: null,
        squadId: null,
        squadName: null,
        ownerUserId: 'owner',
        reason: 'LEGACY_NOT_RENDERED',
        recovery: {
          id: 'record',
          structured: {
            version: 7,
            request: {
              schemaVersion: 1,
              kind: 'continue',
              recoveryId: '00000000-0000-4000-8000-000000000001',
              expectedRecoveryVersion: 7,
            },
            summary: {
              attempted: 'Read files',
              attemptCount: 6,
              lastError: 'Connection closed',
              text: 'I tried to read files 6 times. The last error was: Connection closed',
            },
          },
        },
      },
    }
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionCenterContent actions={[recovery]} isLoading={false} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      expect(dom.window.document.body.textContent).not.toContain('LEGACY_NOT_RENDERED')
      expect(dom.window.document.querySelector('textarea')).toBeNull()
      const buttons = [...dom.window.document.querySelectorAll('button')]
      expect(buttons.filter((button) => button.textContent === 'Continue')).toHaveLength(1)
      await dom.act(async () => buttons.find((button) => button.textContent?.toLowerCase() === decision)!.click())
      expect(calls.find((call) => call.url.endsWith('/agents/worker/recoveries/record/input'))?.body).toEqual({
        action: decision,
        expectedVersion: 7,
      })
      expect(calls.some((call) => call.url.endsWith('/continue'))).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })
}

for (const variant of ['decide', 'provide', 'file'] as const) {
  const kind = variant === 'decide' ? 'decide' : 'provide'
  test(`typed ${variant} renders the declared task input and submits its version`, async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
      return new dom.window.Response('{}', { status: 200 }) as unknown as Response
    }) as unknown as typeof fetch
    const task = manualAction('task-input', 'LEGACY_NOT_RENDERED')
    const data = task.data as WorkStreamActionData
    data.wait.structured = {
      version: 2,
      summary: {
        attempted: 'Choose a release target',
        attemptCount: 0,
        lastError: null,
        text: 'Choose a release target.',
      },
      request:
        kind === 'decide'
          ? {
              schemaVersion: 1,
              kind,
              purpose: 'task-decision',
              subject: 'Release target',
              options: [
                { id: 'beta', label: 'Beta' },
                { id: 'stable', label: 'Stable' },
              ],
            }
          : {
              schemaVersion: 1,
              kind,
              purpose: 'task-input',
              input:
                variant === 'file'
                  ? { type: 'file', path: 'assets/logo.svg' }
                  : { type: 'config-value', key: 'git.baseBranch', declaredIn: 'ficus:work-stream' },
              use: 'choose the target',
            },
    }
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionCenterContent actions={[task]} isLoading={false} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      expect(dom.window.document.body.textContent).not.toContain('LEGACY_NOT_RENDERED')
      if (kind === 'provide') {
        expect(dom.window.document.querySelector('label')?.textContent).toContain(
          variant === 'file' ? 'assets/logo.svg' : 'git.baseBranch'
        )
        if (variant === 'provide')
          expect(dom.window.document.body.textContent).toContain('Declared in ficus:work-stream')
        const input = dom.window.document.querySelector('textarea')!
        await dom.act(async () => {
          Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'beta')
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })
      } else expect(dom.window.document.querySelector('textarea')).toBeNull()
      const label = kind === 'decide' ? 'Beta' : 'Provide'
      await dom.act(async () =>
        [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === label)!.click()
      )
      expect(calls.find((call) => call.url.endsWith('/waits/task-input/input'))?.body).toEqual(
        kind === 'decide'
          ? { action: 'choose', optionId: 'beta', expectedVersion: 2 }
          : { action: 'provide', value: 'beta', expectedVersion: 2 }
      )
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })
}

describe('workflow review gate cards', () => {
  const gateAction = (extra: Partial<WorkStreamActionData> = {}): PendingAction => {
    const base = manualAction('gate-wait', 'Long gate instructions that the decision brief now carries')
    const data = base.data as WorkStreamActionData
    return {
      ...base,
      data: { ...data, ...extra, wait: { ...data.wait, resolutionHandler: 'workflow', flowAttemptId: 1 } },
    } as PendingAction
  }

  function seedReviewSurface(cache: QueryClient) {
    const definition = createBlankWorkflow()
    definition.steps = [
      {
        id: 'design',
        name: 'Design approval',
        kind: 'human-approval' as const,
        approver: 'reviewers' as const,
        instructions: 'Approve the design',
        output: 'Decision',
        outcomes: { approved: { next: 'finish' } },
      },
    ]
    definition.entry = 'design'
    const state = createWorkflowRun(definition)
    cache.setQueryData(queryKeys.squads.workStreamDetail('ws-1'), {
      id: 'ws-1',
      squadId: 'squad-1',
      title: 'Ship it',
      status: 'active',
      agentIds: [],
    })
    cache.setQueryData(queryKeys.workflows.run('ws-1'), {
      workStreamId: 'ws-1',
      source: {},
      state,
      version: 0,
      attemptAgents: {},
      openWaits: [{ id: 'gate-wait', flowAttemptId: 1, resolutionHandler: 'workflow', openedAt: state.startedAt }],
    })
    cache.setQueryData(queryKeys.auth.permissions('squad-1'), {
      permissions: ['workstreams:review'],
      identity: { type: 'user', userId: 'reviewer' },
    })
  }

  test('a lone review gate has no chevron or instruction body, and Review still opens the review screen', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const cache = new QueryClient()
    seedReviewSurface(cache)
    try {
      // A lone action would otherwise open expanded (no category heading).
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={cache}>
              <ActionCenterContent actions={[gateAction()]} isLoading={false} />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      const document = dom.window.document
      expect(document.querySelector('button[aria-expanded]')).toBeNull()
      expect(document.body.textContent).not.toContain('Long gate instructions')
      expect(document.body.textContent).toContain('Ficus · review needed')
      expect(document.querySelector('.cursor-pointer')).toBeNull()

      const review = document.querySelector('button[aria-label="Review and decide on Ship it"]') as HTMLButtonElement
      expect(review.textContent).toBe('Review')
      await dom.act(async () => review.click())
      expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Review Design approval')
    } finally {
      await dom.cleanup()
      cache.clear()
    }
  })

  test('a focused or delivery-approval review gate stays collapsed to its header', async () => {
    for (const subject of [gateAction(), gateAction({ deliveryApproval: true })]) {
      const dom = await acquireDomHarness({ url: 'http://localhost/' })
      const rendered = dom.createRoot()
      try {
        await dom.act(async () =>
          rendered.root.render(
            <MemoryRouter>
              <QueryClientProvider client={new QueryClient()}>
                <ActionItem action={subject} focused defaultExpanded />
              </QueryClientProvider>
            </MemoryRouter>
          )
        )
        expect(dom.window.document.querySelector('button[aria-expanded]')).toBeNull()
        expect(dom.window.document.body.textContent).not.toContain('Long gate instructions')
        expect(dom.window.document.querySelector('button[aria-label="Review and decide on Ship it"]')).not.toBeNull()
      } finally {
        await dom.cleanup()
      }
    }
  })

  test('the embedded preview still shows the gate message', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    try {
      await dom.act(async () =>
        rendered.root.render(
          <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
              <ActionItem action={gateAction()} embedded />
            </QueryClientProvider>
          </MemoryRouter>
        )
      )
      expect(dom.window.document.body.textContent).toContain('Long gate instructions')
    } finally {
      await dom.cleanup()
    }
  })

  test('work stream input and legacy review cards keep their dropdown', async () => {
    const flowInput = manualAction('flow-input', 'Choose a base branch')
    ;(flowInput.data as WorkStreamActionData).wait.resolutionHandler = 'workflow'
    for (const subject of [action, manualAction('manual-wait', 'Grant the token'), flowInput]) {
      const dom = await acquireDomHarness({ url: 'http://localhost/' })
      const rendered = dom.createRoot()
      try {
        await dom.act(async () =>
          rendered.root.render(
            <MemoryRouter>
              <QueryClientProvider client={new QueryClient()}>
                <ActionItem action={subject} />
              </QueryClientProvider>
            </MemoryRouter>
          )
        )
        const expand = dom.window.document.querySelector('button[aria-label="Expand"]') as HTMLButtonElement
        expect(expand.getAttribute('aria-expanded')).toBe('false')
        await dom.act(async () => expand.click())
        expect(dom.window.document.querySelector('button[aria-label="Collapse"]')).not.toBeNull()
      } finally {
        await dom.cleanup()
      }
    }
  })
})

describe('ActionItem attempt-limit pause', () => {
  const limitAction = (canRespond: boolean): PendingAction => {
    const base = manualAction('limit-wait', 'Flow paused at the attempt limit.')
    const data = base.data as WorkStreamActionData
    return {
      ...base,
      canRespond,
      data: {
        ...data,
        wait: { ...data.wait, resolutionHandler: 'workflow', flowAttemptId: null, workflowAttemptLimit: true },
        attemptLimit: { stepId: 'build', stepName: 'Build', attemptsUsed: 2, limit: 2, flowVersion: 7 },
      },
    } as PendingAction
  }

  async function renderLimit(subject: PendingAction) {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const rendered = dom.createRoot()
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body && JSON.parse(String(init.body)) })
      return new dom.window.Response(JSON.stringify({ version: 8, stateStatus: 'running', activeAttemptId: 3 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as Response
    }) as typeof fetch
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.actions.pending(), [subject])
    await dom.act(async () =>
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <ActionItem action={subject} defaultExpanded />
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    const button = (label: string) =>
      [...document.querySelectorAll('button')].find((entry) => entry.textContent === label) as HTMLButtonElement
    return {
      dom,
      calls,
      queryClient,
      button,
      cleanup: async () => {
        globalThis.fetch = originalFetch
        await dom.cleanup()
      },
    }
  }

  test('explains the pause in plain words and raises the limit in one click', async () => {
    const view = await renderLimit(limitAction(true))
    try {
      const text = document.body.textContent ?? ''
      expect(text).toContain('attempt limit reached')
      expect(text).toContain('The step "Build" has used all 2 of its allowed attempts')
      expect(text).not.toContain('Flow paused at the attempt limit.')
      // The header offers no review surface; the body holds the action.
      expect(document.querySelector('button[aria-label^="Review and decide"]')).toBeNull()
      const input = document.querySelector('input[type="number"]') as HTMLInputElement
      expect(input.value).toBe('5')
      await view.dom.act(async () => view.button('Raise limit').click())
      expect(view.calls).toHaveLength(1)
      expect(view.calls[0]!.url).toContain('/workflows/runs/ws-1/advance')
      expect(view.calls[0]!.body).toMatchObject({
        command: { action: 'raise-limit', expectedVersion: 7, maxStepAttempts: 5 },
      })
    } finally {
      await view.cleanup()
    }
  })

  test('Remove limit sends null', async () => {
    const view = await renderLimit(limitAction(true))
    try {
      await view.dom.act(async () => view.button('Remove limit').click())
      expect(view.calls[0]!.body).toMatchObject({
        command: { action: 'raise-limit', expectedVersion: 7, maxStepAttempts: null },
      })
    } finally {
      await view.cleanup()
    }
  })

  test('people who cannot raise the limit get no controls', async () => {
    const view = await renderLimit(limitAction(false))
    try {
      expect(view.button('Raise limit')).toBeUndefined()
      expect(view.button('Remove limit')).toBeUndefined()
      expect(document.body.textContent).toContain('do not have permission to respond')
      expect(view.calls).toHaveLength(0)
    } finally {
      await view.cleanup()
    }
  })
})
