import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../test/domHarness'
import { MemoryRouter } from 'react-router-dom'
import type { Agent, Squad, WorkStream } from '@ficus/shared'
import { queryKeys } from '../queryKeys'

let permissions = new Set<string>()
let permissionsLoading = false

const { WorkStreamDetailModal } = await import('./WorkStreamDetailModal')

const now = new Date('2026-01-01T00:00:00Z')
const squad: Squad = {
  id: 'squad-1',
  name: 'Ficus',
  purpose: 'Build Ficus',
  status: 'active',
  squadPresetId: null,
  defaultAgents: [],
  managerAgentId: null,
  context: null,
  isAnonymous: false,
  globalCollaborationEnabled: false,
  order: 0,
  metadata: {},
  sandboxStatus: 'none',
  createdAt: now,
  updatedAt: now,
}

function reviewWorkStream(): WorkStream {
  return {
    id: 'ws-1',
    squadId: squad.id,
    title: 'Review gated actions',
    description: 'Check controls.',
    status: 'active',
    derivedState: 'in_review',
    openWaits: [
      {
        id: 'wait-1',
        workStreamId: 'ws-1',
        type: 'review',
        referenceId: null,
        message: 'Review this',
        createdBy: 'agent',
        createdByAgentId: null,
        createdByUserId: null,
        completesOnApproval: false,
        openedAt: now.toISOString(),
        closedAt: null,
        resolution: null,
        resolutionNote: null,
      },
    ],
    assigneeAgentId: null,
    agentIds: [],
    dependsOn: [],
    handoffMessage: null,
    files: [],
    response: null,
    metadata: {},
    completionMode: 'review-approval',
    createdAt: now,
    updatedAt: now,
  }
}

async function renderModal<T = string>(
  options: { workStream?: WorkStream; focusWaitId?: string; actionCanRespond?: boolean } = {},
  inspect: (dom: Awaited<ReturnType<typeof acquireDomHarness>>) => T | Promise<T> = (dom) =>
    dom.window.document.body.innerHTML as T
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  if (!permissionsLoading) {
    queryClient.setQueryData(queryKeys.auth.permissions(squad.id), { permissions: [...permissions] })
  }
  const dom = await acquireDomHarness({
    url: 'http://localhost/work-streams/ws-1',
    beforeUnmount: async () => queryClient.cancelQueries(),
    afterUnmount: () => queryClient.clear(),
  })
  const rendered = dom.createRoot()
  try {
    await dom.act(async () =>
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <WorkStreamDetailModal
              workStream={options.workStream ?? reviewWorkStream()}
              focusWaitId={options.focusWaitId}
              actionCanRespond={options.actionCanRespond}
              squadMap={new Map([[squad.id, squad]])}
              agentMap={new Map<string, Agent>()}
              onClose={() => undefined}
            />
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    return await inspect(dom)
  } finally {
    await dom.cleanup()
  }
}

describe('WorkStreamDetailModal RBAC gating', () => {
  beforeEach(() => {
    permissions = new Set<string>()
    permissionsLoading = false
  })

  test('uses button properties for deny/respond/update authority', async () => {
    const approveDisabled = () =>
      renderModal({}, (dom) => {
        const button = [...dom.window.document.querySelectorAll('button')].find(
          (item) => item.textContent === 'Approve checkpoint'
        )
        expect(button).toBeDefined()
        return (button as HTMLButtonElement).disabled
      })
    expect(await approveDisabled()).toBe(true)
    permissions = new Set(['workstreams:respond'])
    expect(await approveDisabled()).toBe(false)
    permissions = new Set(['workstreams:update'])
    expect(await approveDisabled()).toBe(false)
  })
})

describe('WorkStreamDetailModal exact action authority', () => {
  test('server capability overrides stale local permissions in both directions', async () => {
    permissions = new Set(['workstreams:update'])
    expect(
      await renderModal({ actionCanRespond: false }, (dom) => {
        const button = [...dom.window.document.querySelectorAll('button')].find(
          (item) => item.textContent === 'Approve checkpoint'
        ) as HTMLButtonElement
        return button.disabled
      })
    ).toBe(true)

    permissionsLoading = true
    expect(
      await renderModal({ actionCanRespond: true }, (dom) => {
        const button = [...dom.window.document.querySelectorAll('button')].find(
          (item) => item.textContent === 'Approve checkpoint'
        ) as HTMLButtonElement
        return button.disabled
      })
    ).toBe(false)
  })

  test('submits the exact focused second manual wait and fails closed for stale focus', async () => {
    const stream = reviewWorkStream()
    const baseWait = stream.openWaits![0]!
    stream.openWaits = [
      { ...baseWait, id: 'manual-1', type: 'manual', message: 'Use option A' },
      { ...baseWait, id: 'manual-2', type: 'manual', message: 'Use option B' },
    ]
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; body?: string }> = []
    try {
      await renderModal({ workStream: stream, focusWaitId: 'manual-2', actionCanRespond: true }, async (dom) => {
        globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
          calls.push({ url: String(input), body: init?.body as string | undefined })
          return new dom.window.Response(String(input).endsWith('/workstreams/ws-1') ? JSON.stringify(stream) : '{}', {
            status: 200,
          }) as unknown as Response
        }) as unknown as typeof fetch
        expect(dom.window.document.body.textContent).toContain('Use option B')
        expect(dom.window.document.body.textContent).toContain('Use option A')
        const respond = [...dom.window.document.querySelectorAll('button')].find(
          (item) => item.textContent === 'Respond'
        )
        await dom.act(async () => respond?.click())
        const input = dom.window.document.querySelector('input[placeholder="Your response..."]') as HTMLInputElement
        await dom.act(async () => {
          Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Choose B')
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })
        const submit = [...dom.window.document.querySelectorAll('button')].find((item) => item.textContent === 'Submit')
        await dom.act(async () => submit?.click())
      })
      const call = calls.find((candidate) => candidate.url.includes('/workstreams/ws-1/waits/manual-2/resolve'))
      expect(call).toBeDefined()
      expect(JSON.parse(call!.body!)).toEqual({ resolution: 'cleared', note: 'Choose B' })
      expect(calls.some((candidate) => candidate.url.includes('manual-1'))).toBe(false)

      await renderModal({ workStream: stream, focusWaitId: 'missing', actionCanRespond: true }, (dom) => {
        expect(dom.window.document.body.textContent).toContain('focused action is no longer pending')
        expect(
          [...dom.window.document.querySelectorAll('button')].some((item) =>
            ['Respond', 'Approve checkpoint'].includes(item.textContent ?? '')
          )
        ).toBe(false)
        expect(dom.window.document.querySelector('input[placeholder="Your response..."]')).toBeNull()
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
