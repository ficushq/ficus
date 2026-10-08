import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, waitFor } from '@testing-library/dom'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import type { Squad, WorkStream } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { githubFeedbackQueryKeys, queryKeys } from '../queryKeys'
import {
  SQUAD,
  fakeModerationApi,
  item,
  moderationFetch,
  type FakeModerationApi,
} from '../test/fixtures/githubFeedbackServer'
import { SquadDetailPage } from './SquadDetailPage'
import { WS_DONE_STATUSES, workStreamStatusesKey } from '../api/squads'

const now = new Date('2026-01-01T00:00:00Z')
const squad: Squad = {
  id: SQUAD,
  name: 'Moderated Squad',
  purpose: 'Review GitHub events',
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
const workStream: WorkStream = {
  id: 'ws-1',
  squadId: SQUAD,
  title: 'Active work',
  description: '',
  status: 'active',
  derivedState: 'in_progress',
  assigneeAgentId: null,
  ownerAgentId: null,
  agentIds: [],
  dependsOn: [],
  handoffMessage: null,
  files: [],
  response: null,
  metadata: {},
  completionMode: 'pr-merge',
  createdAt: now,
  updatedAt: now,
}

const dependencies = {
  useWebSocket: () => ({ subscribe: mock(() => mock(() => undefined)) }),
  SandboxStatusIndicator: () => null,
  SquadAgentThreads: () => <div>Agent threads fixture</div>,
  homeTabDependencies: {
    WorkStreamList: () => <div>Home work fixture</div>,
    SquadAgentThreads: () => <div>Agent threads fixture</div>,
  },
}

let dom: Awaited<ReturnType<typeof acquireDomHarness>>
let client: QueryClient
let api: FakeModerationApi
let oldFetch: typeof fetch

beforeEach(async () => {
  dom = await acquireDomHarness({
    url: 'http://localhost/',
    windowOptions: { innerWidth: 1280, innerHeight: 900 },
    configureWindow(window) {
      window.matchMedia = (() => ({
        matches: true,
        media: '',
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia
      window.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(callback, 0)
      window.cancelAnimationFrame = (id: number) => window.clearTimeout(id)
      window.ResizeObserver = class {
        observe() {}
        disconnect() {}
        unobserve() {}
      } as unknown as typeof window.ResizeObserver
    },
  })
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchInterval: false } },
  })
  client.setQueryData(queryKeys.squads.list(), [squad])
  client.setQueryData(queryKeys.squads.detail(SQUAD), squad)
  client.setQueryData(queryKeys.squads.basic(SQUAD), squad)
  client.setQueryData(queryKeys.squads.agentsWithRecent(SQUAD), { agents: [], recentlyTerminated: [] })
  client.setQueryData(queryKeys.squads.agents(SQUAD), [])
  client.setQueryData(queryKeys.squads.workStreams(SQUAD), [])
  client.setQueryData(queryKeys.squads.activeWorkStreams(SQUAD), [workStream])
  client.setQueryData(queryKeys.squads.doneWorkStreamsInfinite(SQUAD, workStreamStatusesKey(WS_DONE_STATUSES)), {
    pages: [{ items: [], totalCount: 0, hasMore: false, nextCursor: null }],
    pageParams: [undefined],
  })
  client.setQueryData(queryKeys.auth.permissions(SQUAD), {
    permissions: ['squads:read', 'squads:update'],
    identity: { type: 'user', userId: 'user-1' },
  })
  api = fakeModerationApi({ pending: [item(1), item(2)] })
  // Everything else on the page resolves to an empty payload; moderation is the system under test.
  api.other = (_method, path) => (path.startsWith('/api/') ? Response.json([]) : undefined)
  oldFetch = globalThis.fetch
  globalThis.fetch = moderationFetch(api)
})
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
  await client.cancelQueries()
  client.clear()
  globalThis.fetch = oldFetch
  await dom.cleanup()
})

function Navigator() {
  const navigate = useNavigate()
  return (
    <button
      hidden
      data-testid="go-settings"
      onClick={() => navigate(`/squads/${SQUAD}/settings?section=integrations`)}
    />
  )
}

async function renderPage(path = `/squads/${SQUAD}`) {
  const { root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <Navigator />
          <Routes>
            <Route path="/squads/:squadId/:tab?" element={<SquadDetailPage dependencies={dependencies} />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>
    )
  )
}

const region = () => document.querySelector('section[aria-label="Pending GitHub events"]')
const dialogs = () => document.querySelectorAll('[role="dialog"][aria-label="Review GitHub events"]')
const buttonNamed = (text: string, scope: ParentNode = document) => {
  const found = [...scope.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text
  )
  if (!found) throw new Error(`no "${text}" button in: ${document.body.textContent?.slice(0, 400)}`)
  return found as HTMLButtonElement
}
const click = (element: HTMLElement) => dom.act(async () => fireEvent.click(element))
const tab = (label: string) =>
  [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent === label) as HTMLElement

test('Home and Work both surface pending events and open ONE shared modal that keeps selections', async () => {
  await renderPage()
  await waitFor(() => expect(region()?.textContent).toContain('2'))
  await click(buttonNamed('Review', region()!))
  await waitFor(() => expect(dialogs()[0]?.textContent).toContain('@outsider1'))
  expect(dialogs()).toHaveLength(1)
  const checkbox = () => dialogs()[0]!.querySelector('input[type="checkbox"][data-revision-id]') as HTMLInputElement
  await click(checkbox())
  expect(dialogs()[0]!.textContent).toContain('1 selected')
  await click(buttonNamed('Close', dialogs()[0]!))

  await click(tab('Work'))
  await waitFor(() => expect(region()?.textContent).toContain('2'))
  await click(buttonNamed('Review', region()!))
  await waitFor(() => expect(dialogs()[0]?.textContent).toContain('1 selected'))
  expect(dialogs()).toHaveLength(1)

  // Decide; the content-free refresh then confirms zero and BOTH surfaces hide the section.
  await click(buttonNamed('Deny', dialogs()[0]!))
  await waitFor(() => expect(api.requests.some((r) => r.path === '/decisions')).toBe(true))
  api.pending = []
  await dom.act(() => client.invalidateQueries({ queryKey: githubFeedbackQueryKeys.squad(SQUAD) }))
  await click(buttonNamed('Close', dialogs()[0]!))
  await waitFor(() => expect(region()).toBeNull())
  await click(tab('Home'))
  await waitFor(() => expect(document.body.textContent).toContain('Start with a conversation'))
  expect(region()).toBeNull()
})

test('an incoming event makes the hidden section appear without reloading the page', async () => {
  api.pending = []
  await renderPage(`/squads/${SQUAD}/work`)
  await waitFor(() => expect(api.requests.some((r) => r.path === '/summary')).toBe(true))
  expect(region()).toBeNull()
  api.pending = [item(7)]
  await dom.act(() => client.invalidateQueries({ queryKey: githubFeedbackQueryKeys.squad(SQUAD) }))
  await waitFor(() => expect(region()?.textContent).toContain('1'))
})

test('squad settings open the same modal instance through the page provider', async () => {
  await renderPage()
  await waitFor(() => expect(region()).not.toBeNull())
  await click(document.querySelector('[data-testid="go-settings"]') as HTMLElement)
  await waitFor(() => expect(document.body.textContent).toContain('GitHub feedback review'))
  await click(buttonNamed('Review events'))
  await waitFor(() => expect(dialogs()[0]?.textContent).toContain('@outsider1'))
  expect(dialogs()).toHaveLength(1)
})

test('users the server refuses see no moderation surface and no counts', async () => {
  api.other = (_method, path) =>
    path === '/summary'
      ? Response.json({ code: 'squad_read_required' }, { status: 403 })
      : path.startsWith('/api/')
        ? Response.json([])
        : undefined
  await renderPage()
  await waitFor(() => expect(api.requests.some((r) => r.path === '/summary')).toBe(true))
  await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
  expect(region()).toBeNull()
  expect(dialogs()).toHaveLength(0)
})
