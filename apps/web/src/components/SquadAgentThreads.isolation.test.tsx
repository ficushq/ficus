import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, Suspense } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { Agent, Squad } from '@ficus/shared'
import { queryKeys } from '../queryKeys'
import { PermissionsProvider } from '../hooks/usePermissions'
import { SquadConsultantChatPage } from './SquadConsultantChatPage'
import { SquadManagerChatPage } from './SquadManagerChatPage'
import type { SquadAgentThreadsProps } from './squads/SquadAgentThreads'
import { acquireDomHarness, DOM_GLOBAL_NAMES, installDomHarness, withDomOwnership } from '../test/domHarness'

const now = new Date('2026-01-01T00:00:00Z')
const squad = { id: 'squad-1', name: 'Ficus' } as Squad
const manager = {
  id: 'manager-1',
  squadId: squad.id,
  agentTypeId: 'manager',
  status: 'idle',
  metadata: { name: 'Pearl' },
  createdAt: now,
  updatedAt: now,
} as Agent

const ConsultantThreadsFixture = (_props: SquadAgentThreadsProps) => <div data-threads="consultant-fixture" />
const ManagerThreadsFixture = (_props: SquadAgentThreadsProps) => <div data-threads="manager-fixture" />

function pageElement(
  kind: 'consultant' | 'manager',
  Threads?: typeof ConsultantThreadsFixture,
  clients?: QueryClient[]
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients?.push(client)
  client.setQueryData(queryKeys.squads.detail(squad.id), squad)
  client.setQueryData(queryKeys.squads.agentsWithRecent(squad.id), {
    agents: kind === 'manager' ? [manager] : [],
    recentlyTerminated: [],
  })
  client.setQueryData(queryKeys.auth.permissions(squad.id), { permissions: ['agents:run'] })
  const path = `/squads/${squad.id}/${kind}`
  const element =
    kind === 'consultant' ? (
      <SquadConsultantChatPage threadsComponent={Threads} />
    ) : (
      <SquadManagerChatPage threadsComponent={Threads} />
    )
  return (
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path={`/squads/:squadId/${kind}`} element={element} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

function renderPage(kind: 'consultant' | 'manager', Threads?: typeof ConsultantThreadsFixture) {
  return renderToStaticMarkup(pageElement(kind, Threads))
}

function createRenderBarrier() {
  const arrivals: string[] = []
  let released = false
  let releaseSuspense!: () => void
  const suspended = new Promise<void>((resolve) => {
    releaseSuspense = resolve
  })
  const fixture = (name: string) => (_props: SquadAgentThreadsProps) => {
    if (!arrivals.includes(name)) arrivals.push(name)
    if (!released) throw suspended
    return <div data-threads={`${name}-fixture`} />
  }
  return {
    arrivals,
    fixture,
    release() {
      released = true
      releaseSuspense()
    },
  }
}

function assertIsolated(first: 'consultant' | 'manager', second: 'consultant' | 'manager') {
  const fixture = (kind: 'consultant' | 'manager') =>
    kind === 'consultant' ? ConsultantThreadsFixture : ManagerThreadsFixture
  const firstHtml = renderPage(first, fixture(first))
  const secondHtml = renderPage(second, fixture(second))
  expect(firstHtml).toContain(`data-threads="${first}-fixture"`)
  expect(firstHtml).not.toContain(`data-threads="${second}-fixture"`)
  expect(secondHtml).toContain(`data-threads="${second}-fixture"`)
  expect(secondHtml).not.toContain(`data-threads="${first}-fixture"`)
}

describe('SquadAgentThreads per-instance isolation', () => {
  test('keeps overrides isolated in forward and reverse order', () => {
    assertIsolated('consultant', 'manager')
    assertIsolated('manager', 'consultant')
  })

  test('restores preexisting DOM globals and descriptors exactly', async () => {
    await withDomOwnership(async () => {
      const before = new Map(
        DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
      )
      const dom = installDomHarness({ url: 'http://localhost/' })
      await dom.cleanup()
      for (const name of DOM_GLOBAL_NAMES) {
        expect(Object.getOwnPropertyDescriptor(globalThis, name)).toEqual(before.get(name))
      }
    })
  })

  test('keeps two overlapping suspended renders isolated', async () => {
    const clients: QueryClient[] = []
    const dom = await acquireDomHarness({
      url: 'http://localhost/',
      beforeUnmount: async () => {
        await Promise.all(clients.map((client) => client.cancelQueries()))
      },
      afterUnmount: () => {
        for (const client of clients) client.clear()
      },
    })
    const consultant = dom.createRoot()
    const manager = dom.createRoot()
    const consultantContainer = consultant.container
    const managerContainer = manager.container
    const consultantRoot = consultant.root
    const managerRoot = manager.root
    const barrier = createRenderBarrier()

    try {
      await act(async () => {
        consultantRoot.render(
          <Suspense fallback={<div>Consultant pending</div>}>
            {pageElement('consultant', barrier.fixture('consultant'), clients)}
          </Suspense>
        )
        managerRoot.render(
          <Suspense fallback={<div>Manager pending</div>}>
            {pageElement('manager', barrier.fixture('manager'), clients)}
          </Suspense>
        )
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      // Both live roots reached their distinct dependency while the other was
      // still suspended. A shared/process-global selection cannot satisfy this.
      expect(barrier.arrivals).toEqual(['consultant', 'manager'])
      expect(consultantContainer.textContent).toContain('Consultant pending')
      expect(managerContainer.textContent).toContain('Manager pending')

      await act(async () => {
        barrier.release()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(consultantContainer.innerHTML).toContain('data-threads="consultant-fixture"')
      expect(consultantContainer.innerHTML).not.toContain('manager-fixture')
      expect(managerContainer.innerHTML).toContain('data-threads="manager-fixture"')
      expect(managerContainer.innerHTML).not.toContain('consultant-fixture')
    } finally {
      await dom.cleanup()
    }
  })

  test('renders the real threads component by default', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(queryKeys.squads.detail(squad.id), squad)
    client.setQueryData(queryKeys.squads.agentsWithRecent(squad.id), {
      agents: [{ ...manager, id: 'consultant-1', agentTypeId: 'consultant' }],
      recentlyTerminated: [],
    })
    client.setQueryData(queryKeys.auth.permissions(squad.id), { permissions: ['agents:run'] })
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/squads/${squad.id}/consultant`]}>
        <QueryClientProvider client={client}>
          <PermissionsProvider
            usePermissions={() => ({
              can: (permission) => permission === 'agents:run',
              isLoading: false,
              isError: false,
              permissions: ['agents:run'],
            })}
          >
            <Routes>
              <Route
                path="/squads/:squadId/consultant"
                element={
                  <SquadConsultantChatPage
                    threadsDependencies={{ Chat: () => <div data-test-slot="real-default-chat" /> }}
                  />
                }
              />
            </Routes>
          </PermissionsProvider>
        </QueryClientProvider>
      </MemoryRouter>
    )
    expect(html).toContain('data-testid="agent-picker-trigger"')
    expect(html).toContain('New consultant')
    expect(html).toContain('data-test-slot="real-default-chat"')
    expect(html).not.toContain('data-threads="consultant-fixture"')
  })
})
