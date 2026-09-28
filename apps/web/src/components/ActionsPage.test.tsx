import { expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { PendingAction } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { ActionsPage } from './ActionsPage'

const ownedQuestion: PendingAction = {
  id: 'agent-question:question-1',
  type: 'agent-question',
  priority: 1,
  createdAt: '2026-08-28T00:00:00.000Z',
  canRespond: true,
  data: {
    questionId: 'question-1',
    agentId: 'agent-1',
    agentName: 'Owned agent',
    agentTypeId: 'engineer',
    squadId: null,
    squadName: null,
    ownerUserId: 'user-1',
    questionData: { questions: [{ id: 'q', type: 'text', question: 'Owned question?' }] },
  },
}

async function waitFor(check: () => boolean, act: (callback: () => Promise<void>) => Promise<void>) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 10)))
  }
  throw new Error('Timed out waiting for ActionsPage state')
}

test('ActionsPage shows a 403 retry and then renders an owned action without a permission preflight', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/actions' })
  const rendered = dom.createRoot()
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  let actionRequests = 0
  let resolveFirst: ((response: Response) => void) | undefined
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (!url.includes('/api/actions/pending')) throw new Error(`Unexpected request: ${url}`)
    actionRequests += 1
    if (actionRequests === 1) return new Promise<Response>((resolve) => (resolveFirst = resolve))
    return new dom.window.Response(JSON.stringify([ownedQuestion]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Response
  }) as unknown as typeof fetch

  try {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await dom.act(async () => {
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <ActionsPage />
          </QueryClientProvider>
        </MemoryRouter>
      )
    })
    // #1413 replaced the `Loading...` paragraph with a skeleton surface. The
    // assertion this test needs is "the first, unresolved request is still
    // pending", which the skeleton's own announced label carries.
    expect(dom.window.document.body.textContent).toContain('Loading actions')
    await dom.act(async () => {
      resolveFirst?.(
        new dom.window.Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }) as unknown as Response
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    await waitFor(
      () =>
        dom.window.document.body.textContent?.includes('You do not have permission to view these actions.') ?? false,
      dom.act
    )
    expect(dom.window.document.body.textContent).not.toContain('All caught up!')

    const retry = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Retry')
    await dom.act(async () => retry?.click())
    await waitFor(() => dom.window.document.body.textContent?.includes('Owned agent') ?? false, dom.act)

    expect(actionRequests).toBe(2)
    expect(urls.some((url) => url.includes('/permissions'))).toBe(false)
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
})

function manualWaitAction(waitId: string, message: string): PendingAction {
  return {
    id: `workstream-blocked:ws-1:${waitId}`,
    type: 'workstream-blocked',
    priority: 3,
    createdAt: '2026-08-28T00:00:00.000Z',
    canRespond: true,
    squadId: 'squad-1',
    squadName: 'Ficus',
    data: {
      workStreamId: 'ws-1',
      workStreamTitle: 'Concurrent input',
      squadId: 'squad-1',
      squadName: 'Ficus',
      waitId: `legacy-${waitId}`,
      wait: {
        id: waitId,
        workStreamId: 'ws-1',
        type: 'manual',
        referenceId: null,
        message,
        createdBy: 'agent',
        createdByAgentId: null,
        createdByUserId: null,
        completesOnApproval: false,
        openedAt: '2026-08-28T00:00:00.000Z',
        closedAt: null,
        resolution: null,
        resolutionNote: null,
      },
      focus: { kind: 'workstream-wait', workStreamId: 'ws-1', waitId },
      assigneeAgentId: null,
      assigneeName: null,
      completionMode: 'review-approval',
      prompt: { type: 'text', message },
    },
  }
}

async function renderExactActionsPage(path: string) {
  const dom = await acquireDomHarness({ url: `http://localhost${path}` })
  const rendered = dom.createRoot()
  const originalFetch = globalThis.fetch
  const actions = [manualWaitAction('manual-full-1', 'Use option A'), manualWaitAction('manual-full-2', 'Use option B')]
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    if (!String(input).includes('/api/actions/pending')) throw new Error(`Unexpected request: ${input}`)
    return new dom.window.Response(JSON.stringify(actions), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Response
  }) as unknown as typeof fetch
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await dom.act(async () =>
    rendered.root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/actions/:actionId"
            element={
              <QueryClientProvider client={queryClient}>
                <ActionsPage />
              </QueryClientProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    )
  )
  await waitFor(() => dom.window.document.body.textContent?.includes('Concurrent input') ?? false, dom.act)
  return { dom, originalFetch }
}

test('ActionsPage focuses only an encoded exact full action ID', async () => {
  const { dom, originalFetch } = await renderExactActionsPage('/actions/workstream-blocked%3Aws-1%3Amanual-full-2')
  try {
    await waitFor(() => dom.window.document.querySelector('[aria-current="true"]') !== null, dom.act)
    const focused = dom.window.document.querySelector('[aria-current="true"]')
    expect(focused?.textContent).toContain('Use option B')
    expect(focused?.textContent).not.toContain('Use option A')
    expect(dom.window.document.querySelectorAll('[aria-current="true"]')).toHaveLength(1)
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
})

test('ActionsPage stale full action ID never falls back to a sibling wait', async () => {
  const { dom, originalFetch } = await renderExactActionsPage('/actions/workstream-blocked%3Aws-1%3Amissing')
  try {
    expect(dom.window.document.querySelector('[aria-current="true"]')).toBeNull()
    expect(dom.window.document.body.textContent).not.toContain('Use option A')
    expect(dom.window.document.body.textContent).not.toContain('Use option B')
    expect(dom.window.document.querySelectorAll('button[aria-label="Expand"]')).toHaveLength(2)
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
})
